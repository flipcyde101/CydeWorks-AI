// Full HTTP workflow through the real Ollama adapter and a synthetic loopback provider.
// Never contacts an installed model service or the owner's workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {validateReceiptExport} from './receipt-contract.mjs';
import {compareRuns,summarizeRun,validateRun} from './test-support/inspector-v1/accounting.mjs';

test('receipt HTTP workflow covers running, accepted copy, failed preflight and cancelled provider work',{timeout:20000},async t=>{
  const pending=[];
  const digest='a'.repeat(64),model='qwen3:1.7b';
  const provider=createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/api/tags')return res.end(JSON.stringify({models:[{name:model,size:1,digest}]}));
    if(req.url==='/api/status')return res.end(JSON.stringify({cloud:{disabled:true}}));
    if(req.url==='/api/chat') {req.resume();pending.push(res);return;}
    res.writeHead(404);res.end('{}');
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  const key='b'.repeat(64);
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('.',import.meta.url),windowsHide:true,
    env:{...process.env,BFE_PORT:'0',BFE_TEST_MEMORY:'1',BFE_TEST_KEY:key,BFE_OLLAMA_PORT:String(provider.address().port)},
    stdio:['ignore','pipe','pipe']});
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill();await stopped;}
    provider.closeAllConnections();await new Promise(r=>provider.close(r));
  });
  const [banner]=await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Test workspace exited');})]);
  const origin=/http:\/\/127\.0\.0\.1:\d+/.exec(banner.toString())[0];
  let cookie;
  const request=(path,body,headers={})=>fetch(origin+path,{method:body===undefined?'GET':'POST',
    headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const session=await request('/api/session',{key});assert.equal(session.status,200);
  cookie=session.headers.get('set-cookie').split(';')[0];
  const read=async path=>{const res=await request(path);assert.equal(res.status,200);return res.json();};
  const create=async()=>{
    const res=await request('/api/tasks',{title:'Receipt integration synthetic',kind:'change',filename:'example.txt',
      request:'Replace with Revised example',source:'SOURCE_PRIVATE_CANARY',expected:'Revised example'});
    assert.equal(res.status,201);return res.json();
  };
  const path=task=>'/api/tasks/'+task.id;
  const run=async(task,modelDigest=digest)=>{
    const res=await request(path(task)+'/run',{version:task.version,sourceHash:task.sourceHash,approve:true,
      engine:'ollama',model,modelDigest});assert.equal(res.status,202);
  };
  const wait=async(predicate)=>{
    for(let i=0;i<200;i++){const value=await predicate();if(value)return value;await new Promise(r=>setTimeout(r,20));}
    throw Error('Synthetic workflow did not reach the required state');
  };
  const settled=task=>wait(async()=>{const value=await read(path(task));return value.status!=='running'&&value;});
  const receipt=async task=>{
    const value=await read(path(task)+'/receipt');assert.equal(validateReceiptExport(value).ok,true);return value;
  };
  const finish=()=>{
    const res=pending.shift();assert.ok(res);
    res.end(JSON.stringify({done:true,done_reason:'stop',prompt_eval_count:12,eval_count:6,
      message:{content:JSON.stringify({summary:'Synthetic proposal',content:'Revised example'})}}));
  };
  const accept=async task=>{
    const res=await request(path(task)+'/review',{version:task.version,decision:'accepted',artifactHash:task.attempts.at(-1).artifact.sha256});
    assert.equal(res.status,200);return res.json();
  };

  const first=await create();
  assert.equal((await receipt(first)).available,false);
  assert.equal((await request(path(first)+'/receipt',undefined,{'Sec-Fetch-Site':'cross-site'})).status,403);
  await run(first);await wait(()=>pending.length===1);
  const running=await receipt(first);
  assert.equal(running.run.attempts[0].status,'running');
  assert.equal(running.run.attempts[0].outcomeKnown,false);
  assert.equal(summarizeRun(running.run).wallTime.available,false);
  finish();let reviewed=await settled(first);assert.equal(reviewed.status,'review');
  assert.equal((await receipt(first)).run.accepted,false);
  const revised=await request(path(first)+'/revise',{version:reviewed.version,artifactHash:reviewed.attempts[0].artifact.sha256,
    content:'Revised example with operator edit'});
  assert.equal(revised.status,200);reviewed=await revised.json();
  const accepted=await accept(reviewed);
  const before=JSON.stringify(await read(path(first)));
  const firstReceipt=await receipt(first);
  assert.equal(firstReceipt.formatVersion,2);assert.equal(firstReceipt.run.accepted,true);
  assert.equal(firstReceipt.evidence.acceptance.operatorEdited,true);
  assert.equal(firstReceipt.evidence.attempts[0].usage.input,12);
  assert.equal(firstReceipt.evidence.attempts[0].usage.output,6);
  assert.equal(firstReceipt.run.attempts[0].cost,null);
  assert.equal(firstReceipt.run.attempts[0].model,'withheld');
  assert.equal(validateRun(firstReceipt.run).ok,true);
  assert.equal(summarizeRun(firstReceipt.run).wallTime.available,true);
  assert.equal(summarizeRun(firstReceipt.run).totalCost.available,false);
  assert.doesNotMatch(JSON.stringify(firstReceipt),/SOURCE_PRIVATE_CANARY|qwen3:1.7b|operator edit/);
  assert.deepEqual(await receipt(first),firstReceipt);
  assert.equal(JSON.stringify(await read(path(first))),before);

  const copy=await request(path(first)+'/copy-draft',{version:accepted.version,requestId:randomUUID(),confirm:true});
  assert.equal(copy.status,201);const second=(await copy.json()).task;
  assert.equal((await receipt(second)).available,false);
  await run(second);await wait(()=>pending.length===1);finish();await accept(await settled(second));
  const secondReceipt=await receipt(second);
  const comparison=compareRuns(firstReceipt.run,secondReceipt.run);
  assert.equal(comparison.comparable,true);assert.equal(comparison.time.available,true);
  assert.equal(comparison.cost.available,false);
  assert.notEqual(firstReceipt.run.runId,secondReceipt.run.runId);
  assert.equal(firstReceipt.run.inputRevision,secondReceipt.run.inputRevision);

  const failed=await create();await run(failed,'c'.repeat(64));
  assert.equal((await settled(failed)).status,'failed');assert.equal(pending.length,0);
  const rejected=await receipt(failed);
  assert.equal(rejected.run.attempts[0].status,'failed');assert.equal(rejected.run.accepted,false);
  assert.equal(rejected.run.attempts[0].outcomeKnown,true,'preflight failure was never dispatched');

  const cancelled=await create();await run(cancelled);await wait(()=>pending.length===1);
  const current=await read(path(cancelled));
  assert.equal((await request(path(cancelled)+'/cancel',{version:current.version})).status,202);
  assert.equal((await settled(cancelled)).status,'cancelled');
  const unknown=await receipt(cancelled);
  assert.equal(unknown.run.attempts[0].outcomeKnown,false);
  assert.equal(summarizeRun(unknown.run).wallTime.available,false);
  assert.equal(compareRuns(firstReceipt.run,unknown.run).comparable,false);
  t.diagnostic('Real workspace HTTP and Ollama adapter exercised with controlled loopback responses; no real model called.');
});
