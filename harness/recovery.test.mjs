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
  for (const file of ['server.mjs','opencode.mjs','providers.mjs','direct-local-fetch.mjs','patch.mjs','recovery.mjs','workspace-lock.mjs','export.mjs','attention.mjs','route.mjs','owner-lease.mjs','removal.mjs']) {
    await copyFile(join(workspace,file),join(scratch,file));
  }
  for (const file of ['app.js','index.html','style.css','observer.js','export-dialog.js','usage.js','progress.js','removal-dialog.js']) {
    await copyFile(join(workspace,'web',file),join(scratch,'web',file));
  }
  const key='c'.repeat(64);
  await writeFile(join(scratch,'.state','access.key'),key);
  const db=new DatabaseSync(join(scratch,'.state','workspace.sqlite'));
  db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, updated TEXT NOT NULL, data TEXT NOT NULL)');
  const insert=db.prepare('INSERT INTO tasks VALUES (?, ?, ?)');
  const unknown=makeTask(makeAttempt('opencode','dispatching'));
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
  const run=await post('/api/tasks/'+preflight.id+'/run',{
    version:ready.version,sourceHash:ready.sourceHash,approve:true,engine:'fixture',model:'fixture',
  },cookie);
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
});
