// Runs the real server with an in-memory workspace and a test key. No model,
// provider or saved state is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {validateReceiptExport} from './receipt-contract.mjs';

test('the receipt endpoint is authenticated, same-origin, read-only and deterministic',{timeout:20000},async t=>{
  const key='a'.repeat(64);
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('.',import.meta.url),windowsHide:true,
    env:{...process.env,BFE_PORT:'0',BFE_TEST_MEMORY:'1',BFE_TEST_KEY:key},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null) {const exited=once(child,'exit');child.kill();await exited;}
  });
  const [started]=await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Test service exited.');})]);
  const origin=/http:\/\/127\.0\.0\.1:\d+/.exec(started.toString())[0];
  const send=(path,body,headers={})=>fetch(origin+path,{method:body===undefined?'GET':'POST',
    headers:{Origin:origin,'Content-Type':'application/json',...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const session=await send('/api/session',{key});
  assert.equal(session.status,200);
  const cookie=session.headers.get('set-cookie').split(';')[0];
  const request=(path,body)=>send(path,body,{Cookie:cookie});
  const created=await (await request('/api/tasks',{title:'Synthetic receipt change',kind:'change',filename:'example.txt',
    request:'Replace the entire file with the exact text Revised example',source:'SYNTHETIC_PRIVATE_SOURCE',
    expected:'Revised example'})).json();
  const path='/api/tasks/'+created.id;
  const state=async()=>(await request(path)).text();

  // Same gates as every other task route.
  assert.equal((await send(path+'/receipt')).status,401);
  assert.equal((await send(path+'/receipt',undefined,{Cookie:'bfe_session='+'b'.repeat(64)})).status,401);
  assert.equal((await send(path+'/receipt',undefined,{Cookie:cookie,Origin:'https://elsewhere.invalid'})).status,403);
  assert.equal((await send(path+'/receipt',{version:created.version})).status,401);
  assert.equal((await request('/api/tasks/00000000-0000-4000-8000-000000000000/receipt')).status,404);
  assert.equal((await request(path+'/receipt/extra')).status,404);

  // A draft has no run.
  const draft=await request(path+'/receipt');
  assert.equal(draft.status,200);
  assert.equal(draft.headers.get('cache-control'),'no-store');
  const refused=await draft.json();
  assert.equal(refused.available,false);
  assert.deepEqual(refused.reasons.map(reason=>reason.code),['no-attempts-recorded']);
  assert.equal(validateReceiptExport(refused).ok,true);

  assert.equal((await request(path+'/run',{version:created.version,sourceHash:created.sourceHash,approve:true,
    engine:'fixture',model:'fixture'})).status,202);
  let task;
  for(let i=0;i<100;i++) {
    task=JSON.parse(await state());
    if(task.status!=='running')break;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(task.status,'review',task.attempts[0]?.problem);

  // The adapter recomputes the scope hash the server stored for this attempt.
  const before=await state();
  const text=await (await request(path+'/receipt')).text();
  const pending=JSON.parse(text);
  assert.equal(pending.available,true,JSON.stringify(pending.reasons));
  assert.equal(validateReceiptExport(pending).ok,true);
  assert.equal(pending.run.accepted,false);
  assert.equal(pending.run.attemptsComplete,true);
  assert.deepEqual(pending.run.attempts.map(({provider,model,status,outcomeKnown,startedAtMs,cost})=>
    ({provider,model,status,outcomeKnown,startedAtMs,cost})),
    [{provider:'fixture',model:'withheld',status:'succeeded',outcomeKnown:true,startedAtMs:0,cost:null}]);
  assert.ok(pending.run.attempts[0].endedAtMs>=0);
  assert.deepEqual(pending.evidence.attempts[0].checks,{passed:2,failed:0});
  assert.doesNotMatch(text,/SYNTHETIC_PRIVATE_SOURCE|Revised example|Synthetic receipt change|example\.txt|[a-f0-9]{64}|\d{4}-\d{2}-\d{2}T/);
  for(const raw of [task.id,task.attempts[0].id])assert.equal(text.includes(raw),false);

  // Exporting changes nothing, twice over, and a POST is not a receipt action.
  assert.equal(await (await request(path+'/receipt')).text(),text);
  assert.equal((await request(path+'/receipt',{version:task.version})).status,404);
  assert.equal((await request(path+'/receipt',{version:task.version+1})).status,409);
  assert.equal(await state(),before);

  const epoch=await (await request(path+'/receipt?timebase=epoch')).json();
  assert.equal(epoch.evidence.timebase,'epoch');
  assert.equal(epoch.run.attempts[0].startedAtMs,Date.parse(task.attempts[0].started));
  const unsupported=await request(path+'/receipt?timebase=local');
  assert.equal(unsupported.status,400);
  assert.match((await unsupported.json()).error,/supported receipt timebase/);

  // An operator edit followed by acceptance.
  const attempt=task.attempts[0];
  const revised=await request(path+'/revise',{version:task.version,artifactHash:attempt.artifact.sha256,
    content:'Revised example with an operator note'});
  assert.equal(revised.status,200);
  const edited=await revised.json();
  assert.equal((await request(path+'/review',{version:edited.version,decision:'accepted',
    artifactHash:edited.attempts[0].artifact.sha256})).status,200);
  const acceptedText=await (await request(path+'/receipt')).text();
  const accepted=JSON.parse(acceptedText);
  assert.equal(accepted.run.accepted,true);
  assert.equal(accepted.run.runId,pending.run.runId,'the same record is the same run at every version');
  assert.deepEqual(accepted.evidence.acceptance,{state:'accepted',operatorEdited:true,earlierAcceptedAttempts:0});
  assert.equal(accepted.evidence.attempts[0].operatorEditCount,1);
  assert.doesNotMatch(acceptedText,/operator note|[a-f0-9]{64}/);
  assert.equal(validateReceiptExport(accepted).ok,true);

  // The existing export modes still answer as before.
  const standard=await (await request(path+'/export')).json();
  assert.deepEqual([standard.schema,standard.mode,standard.task.title,standard.task.source],[1,'standard','Synthetic receipt change',undefined]);
  const minimal=await (await request(path+'/export?mode=minimal')).json();
  assert.deepEqual([minimal.schema,minimal.mode,minimal.task.status],[2,'minimal','accepted']);
  assert.deepEqual(accepted.evidence.attempts.map(item=>item.usage),minimal.task.attempts.map(item=>item.usage));
  assert.equal((await request(path+'/export?mode=receipt')).status,400);
});
