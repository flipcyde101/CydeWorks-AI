import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

async function scenario(t,{cloud='disabled',remote=false,digest='a'.repeat(64)}={}) {
  const loader=new URL('./test-support/mock-ollama.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--import',loader,'server.mjs'],{cwd:new URL('.',import.meta.url),windowsHide:true,
    env:{...process.env,BFE_PORT:'0',BFE_TEST_MEMORY:'1',BFE_TEST_KEY:'c'.repeat(64),
      BFE_MOCK_CLOUD:cloud,BFE_MOCK_REMOTE:remote?'1':'0',BFE_OLLAMA_PORT:'11534'},stdio:['ignore','pipe','pipe','ipc']});
  let calls=0;
  child.on('message',message=>{if(message?.type==='synthetic-chat-call')calls++;});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}});
  const [chunk]=await Promise.race([once(child.stdout,'data'),once(child,'exit').then(([code])=>{throw Error('Synthetic server exited '+code);})]);
  const match=/http:\/\/127\.0\.0\.1:\d+/.exec(chunk.toString());
  assert.ok(match);
  const origin=match[0];
  const post=(path,body,cookie)=>fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',
    ...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  const session=await post('/api/session',{key:'c'.repeat(64)});
  const cookie=session.headers.get('set-cookie').split(';')[0];
  const created=await (await post('/api/tasks',{title:'Synthetic',kind:'change',filename:'example.txt',
    request:'Replace the file',source:'Original',expected:'Revised example'},cookie)).json();
  const path='/api/tasks/'+created.id;
  const start=await post(path+'/run',{version:created.version,sourceHash:created.sourceHash,approve:true,
    engine:'ollama',model:'qwen3:1.7b',modelDigest:digest},cookie);
  assert.equal(start.status,202);
  let result;
  for(let i=0;i<100;i++) {
    result=await (await fetch(origin+path,{headers:{Cookie:cookie}})).json();
    if(result.status!=='running')break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  return {result,get calls(){return calls;}};
}

test('changed model identity is held before any synthetic inference call', {timeout:10000},async t=>{
  const run=await scenario(t,{digest:'b'.repeat(64)});
  assert.equal(run.result.status,'failed');
  assert.match(run.result.attempts[0].problem,/identity changed/i);
  assert.equal(run.result.attempts[0].execution.phase,'claimed');
  assert.equal(run.calls,0);
});

test('enabled cloud or reported remote model is held before inference', {timeout:10000},async t=>{
  const cloud=await scenario(t,{cloud:'enabled'});
  assert.equal(cloud.result.status,'failed');
  assert.match(cloud.result.attempts[0].problem,/cloud features/i);
  assert.equal(cloud.calls,0);
  const remote=await scenario(t,{remote:true});
  assert.equal(remote.result.status,'failed');
  assert.match(remote.result.attempts[0].problem,/remote destination/i);
  assert.equal(remote.calls,0);
});

test('matching preflight and disabled cloud allow a synthetic adapter response', {timeout:10000},async t=>{
  const run=await scenario(t);
  assert.equal(run.result.status,'review');
  assert.equal(run.result.attempts[0].artifact.content,'Revised example');
  assert.equal(run.result.attempts[0].approvedModelDigest,'a'.repeat(64));
  assert.equal(run.result.attempts[0].usage.providerCharge,null);
  assert.equal(run.calls,1);
});
