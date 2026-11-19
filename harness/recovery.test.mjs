import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {copyFile,mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {dirname,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {recordInterruption,recordOutcomeUncertainty,retryHold} from './recovery.mjs';
import {prepareRunSubmission} from './run-submission.mjs';
import {routeRevision as revisionForRoute} from './route-inventory.mjs';
import {assessRoute} from './route.mjs';

const stamp='2026-11-14T00:00:00.000Z';
const workspace=dirname(fileURLToPath(import.meta.url));
const scratchRoot=join(workspace,'..','work');
const makeAttempt=(provider,phase)=>({id:randomUUID(),provider,model:provider==='fixture'?'fixture':'qwen3:1.7b-dell-cpu',
  started:stamp,status:'running',usage:null,...(phase?{execution:{phase,claimId:randomUUID(),claimedAt:stamp}}:{})});
const makeTask=attempt=>({id:randomUUID(),version:1,status:'running',kind:'change',title:'Synthetic recovery',
  request:'Replace the content',source:'Synthetic source',filename:'example.txt',expected:'Revised example',
  sourceHash:createHash('sha256').update('Synthetic source').digest('hex'),model:attempt.model,
  attempts:[attempt],events:[{seq:1,at:stamp,event:'attempt.approved_and_started'}]});

test('recovery distinguishes proven pre-dispatch state from unknown external work',()=>{
  for (const [provider,phase,safe] of [
    ['opencode','claimed',true],['opencode','dispatching',false],['ollama','dispatching',false],
    ['opencode',undefined,false],['fixture','dispatching',true],
  ]) {
    const task=makeTask(makeAttempt(provider,phase));
    const id=task.attempts[0].id;
    assert.equal(recordInterruption(task,stamp),true);
    assert.equal(task.status,'interrupted');
    assert.equal(task.attempts[0].id,id);
    assert.equal(!!retryHold(task),!safe);
  }
  const missing={status:'running',attempts:[]};
  recordInterruption(missing,stamp);
  assert.match(retryHold(missing),/no recoverable attempt record/);
});

test('unconfirmed cancellation or error holds the external attempt',()=>{
  const attempt=makeAttempt('opencode','dispatching');
  recordOutcomeUncertainty(attempt,stamp);
  assert.match(retryHold({status:'cancelled',attempts:[attempt]}),/did not confirm/);
  assert.equal(retryHold({status:'review',attempts:[attempt]}),null);
  const before=makeAttempt('opencode','claimed');
  recordOutcomeUncertainty(before,stamp);
  assert.equal(retryHold({status:'failed',attempts:[before]}),null);
  for(const status of ['failed','cancelled']) {
    const legacy=makeAttempt('opencode');
    assert.match(retryHold({status,attempts:[legacy]}),/no recorded completion evidence/);
    const partial=makeAttempt('ollama','dispatching');
    assert.match(retryHold({status,attempts:[partial]}),/no recorded completion evidence/);
  }
});

test('a restarted workspace holds uncertain retries and preserves safe attempts', {timeout:30000},async t=>{
  const scratch=await mkdtemp(join(scratchRoot,'harness-recovery-'));
  let child;
  t.after(async()=>{
    if (child && child.exitCode===null && child.signalCode===null) {
      const exited=once(child,'exit');
      child.kill();
      await exited;
    }
    const root=await realpath(scratchRoot);
    const target=await realpath(scratch);
    assert.ok(target.startsWith(root+sep) && target!==root,'only the created test folder may be removed');
    await rm(target,{recursive:true});
  });
  await mkdir(join(scratch,'web'));
  await mkdir(join(scratch,'.state'));
  await mkdir(join(scratch,'desktop'));
  await copyFile(join(workspace,'desktop','utility-test-child.cjs'),join(scratch,'desktop','utility-test-child.cjs'));
  for (const file of ['browser-assets.mjs','receipt-analytics.mjs','receipt-analytics-contract.mjs','contributor-api.mjs','cost-presentation.mjs','portable-import-review-planner.mjs','portable-handoff-validator.mjs','portable-manifest-contract.mjs','portable-sha256.mjs','artifact-download.mjs','route-inventory.mjs','run-submission.mjs','router-evaluation-api.mjs','router-evaluator.mjs','router-evaluation-contract.mjs','connection-host.mjs','connection-readiness.mjs','connection-contract.mjs','receipt-export.mjs','receipt-adapter.mjs','receipt-contract.mjs','server.mjs','opencode.mjs','opencode-usage.mjs','providers.mjs','llamacpp.mjs','inference-broker.mjs','direct-local-fetch.mjs','readiness.mjs','patch.mjs','recovery.mjs','workspace-lock.mjs','export.mjs','attention.mjs','route.mjs','owner-lease.mjs','removal.mjs','terminal-control.mjs','draft-copy.mjs']) {
    await copyFile(join(workspace,file),join(scratch,file));
  }
  for (const file of ['app.js','index.html','style.css','observer.js','export-dialog.js','usage.js','progress.js','progress-view.js','progress-ui.js','removal-dialog.js','route-diagnostics.js','proposal-editor.js','terminal-request.js','draft-copy-dialog.js']) {
    await copyFile(join(workspace,'web',file),join(scratch,'web',file));
  }
  const key='c'.repeat(64);
  await writeFile(join(scratch,'.state','access.key'),key);
  const db=new DatabaseSync(join(scratch,'.state','workspace.sqlite'));
  db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, updated TEXT NOT NULL, data TEXT NOT NULL)');
  const insert=db.prepare('INSERT INTO tasks VALUES (?, ?, ?)');
  const unknown=makeTask(makeAttempt('opencode','dispatching'));
  const unknownRequest={requestId:randomUUID(),version:0,sourceHash:unknown.sourceHash,approve:true,
    engine:'opencode',model:unknown.model,modelDigest:'a'.repeat(64)};
  unknown.attempts[0].submission=prepareRunSubmission(unknown.id,unknownRequest);
  const preflight=makeTask(makeAttempt('opencode','claimed'));
  const legacy=makeTask(makeAttempt('opencode'));
  const accepted=makeTask(makeAttempt('fixture','settled'));
  accepted.status=accepted.attempts[0].status='accepted';
  for(const task of [unknown,preflight,legacy,accepted]) insert.run(task.id,stamp,JSON.stringify(task));
  db.close();
  const probe=createServer().listen(0,'127.0.0.1');
  await once(probe,'listening');
  const {port}=probe.address();
  await new Promise(resolve=>probe.close(resolve));
  const origin='http://127.0.0.1:'+port;
  child=spawn(process.execPath,['server.mjs'],{cwd:scratch,windowsHide:true,
    env:{...process.env,BFE_PORT:String(port),BFE_TEST_MEMORY:'0',BFE_TEST_KEY:'',BFE_DESKTOP_BOOTSTRAP:'1'},stdio:['ignore','pipe','pipe','ipc']});
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(([code])=>{throw Error('Test server exited '+code);})]);
  const duplicate=spawn(process.execPath,['server.mjs'],{cwd:scratch,windowsHide:true,
    env:{...process.env,BFE_PORT:String(port+1),BFE_TEST_MEMORY:'0',BFE_TEST_KEY:''},stdio:['ignore','pipe','pipe']});
  let duplicateError='';
  duplicate.stderr.on('data',chunk=>{duplicateError+=chunk.toString();});
  const [duplicateExit]=await once(duplicate,'exit');
  assert.notEqual(duplicateExit,0);
  assert.match(duplicateError,/workspace is already open/i);
  const post=(path,body,cookie)=>fetch(origin+path,{method:'POST',
    headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  const session=await post('/api/session',{key});
  const cookie=session.headers.get('set-cookie').split(';')[0];
  const get=async task=>(await fetch(origin+'/api/tasks/'+task.id,{headers:{Cookie:cookie}})).json();
  const attention=await (await fetch(origin+'/api/attention',{headers:{Cookie:cookie}})).json();
  assert.equal(attention.tasks.filter(item=>item.id===unknown.id).length,1);
  assert.equal(attention.tasks.find(item=>item.id===unknown.id).reasons.length,2);
  assert.equal(attention.tasks.some(item=>item.id===accepted.id),false);
  for(const task of [unknown,legacy]) {
    const state=await get(task);
    assert.equal(state.status,'interrupted');
    assert.equal(state.recovery.blocked,true);
    assert.equal(state.attempts[0].id,task.attempts[0].id);
    const retry=await post('/api/tasks/'+task.id+'/run',{
      version:state.version,sourceHash:state.sourceHash,approve:true,engine:'fixture',model:'fixture',
    },cookie);
    assert.equal(retry.status,409);
  }
  const ready=await get(preflight);
  assert.equal(ready.status,'interrupted');
  assert.equal(ready.recovery,null);
  assert.equal(ready.attempts[0].recovery.evidence,'dispatch-not-started');
  // The restart test uses a deterministic fixture, never host model inventory.
  const fixtureRevision=revisionForRoute({id:'fixture',engine:'fixture',digest:null,endpoint:null,
    readiness:assessRoute({engine:'fixture'})});
  const runRequest={requestId:randomUUID(),
    version:ready.version,sourceHash:ready.sourceHash,approve:true,engine:'fixture',model:'fixture',
    routeRevision:fixtureRevision,
  };
  const run=await post('/api/tasks/'+preflight.id+'/run',runRequest,cookie);
  assert.equal(run.status,202);
  let result;
  for(let i=0;i<100;i++){
    result=await get(preflight);
    if(result.status!=='running')break;
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  assert.equal(result.status,'review');
  assert.equal(result.attempts.length,2);
  assert.equal(result.attempts[1].execution.phase,'settled');
  assert.equal((await get(accepted)).status,'accepted');
  const copyRequest={requestId:randomUUID(),version:accepted.version,confirm:true};
  const copiedResponse=await post('/api/tasks/'+accepted.id+'/copy-draft',copyRequest,cookie);
  assert.equal(copiedResponse.status,201);
  const copied=await copiedResponse.json();
  const exited=once(child,'exit');
  child.disconnect();
  await exited;
  child=spawn(process.execPath,['desktop/utility-test-child.cjs'],{cwd:scratch,windowsHide:true,
    env:{...process.env,BFE_PORT:String(port),BFE_TEST_MEMORY:'0',BFE_TEST_KEY:'',BFE_DESKTOP_BOOTSTRAP:'1'},stdio:['ignore','pipe','pipe','ipc']});
  const [utilityReady]=await Promise.race([once(child,'message'),once(child,'exit').then(([code])=>{throw Error('Utility workspace exited '+code);})]);
  assert.equal(utilityReady.type,'bfe-desktop-ready');
  const utilityDuplicate=spawn(process.execPath,['server.mjs'],{cwd:scratch,windowsHide:true,
    env:{...process.env,BFE_PORT:String(port+1),BFE_TEST_MEMORY:'0',BFE_TEST_KEY:''},stdio:['ignore','pipe','pipe']});
  utilityDuplicate.stderr.resume();
  assert.notEqual((await once(utilityDuplicate,'exit'))[0],0);
  assert.equal((await once(child,'exit'))[0],0);
  child=spawn(process.execPath,['server.mjs'],{cwd:scratch,windowsHide:true,
    env:{...process.env,BFE_PORT:String(port),BFE_TEST_MEMORY:'0',BFE_TEST_KEY:''},stdio:['ignore','pipe','pipe']});
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(([code])=>{throw Error('Restart exited '+code);})]);
  const renewed=await post('/api/session',{key});
  const renewedCookie=renewed.headers.get('set-cookie').split(';')[0];
  const restored=await (await fetch(origin+'/api/tasks/'+preflight.id,{headers:{Cookie:renewedCookie}})).json();
  assert.equal(restored.status,'review');
  assert.equal(restored.attempts.length,2);
  assert.equal(restored.attempts[1].approvedRouteRevision,fixtureRevision);
  assert.equal(restored.attempts[1].observedRouteRevision,fixtureRevision);
  const replayed=await post('/api/tasks/'+preflight.id+'/run',runRequest,renewedCookie);
  assert.equal(replayed.status,200);
  const replayState=await replayed.json();
  assert.equal(replayState.runSubmission.attemptId,restored.attempts[1].id);
  assert.equal(replayState.attempts.length,2);assert.equal(replayState.version,restored.version);
  const {routeRevision,...changedBinding}=runRequest;
  assert.equal((await post('/api/tasks/'+preflight.id+'/run',changedBinding,renewedCookie)).status,409);
  const lookup=await (await fetch(origin+'/api/tasks/'+preflight.id+'/run-submissions/'+runRequest.requestId,
    {headers:{Cookie:renewedCookie}})).json();
  assert.equal(lookup.attemptId,restored.attempts[1].id);
  const unknownReplay=await post('/api/tasks/'+unknown.id+'/run',unknownRequest,renewedCookie);
  assert.equal(unknownReplay.status,200);
  const unknownState=await unknownReplay.json();
  assert.equal(unknownState.runSubmission.attemptStatus,'interrupted');
  assert.equal(unknownState.recovery.blocked,true);assert.equal(unknownState.attempts.length,1);
  assert.equal((await post('/api/tasks/'+unknown.id+'/run',{
    ...unknownRequest,requestId:randomUUID(),version:unknownState.version},renewedCookie)).status,409);
  const repeatedCopy=await post('/api/tasks/'+accepted.id+'/copy-draft',copyRequest,renewedCookie);
  assert.equal(repeatedCopy.status,200);
  assert.equal((await repeatedCopy.json()).task.id,copied.task.id);
  const recoveredCopy=await (await fetch(origin+'/api/draft-copies/'+copyRequest.requestId,{headers:{Cookie:renewedCookie}})).json();
  assert.equal(recoveredCopy.taskId,copied.task.id);
});
