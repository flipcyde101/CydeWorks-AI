import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createMockOllama} from './test-support/mock-ollama.mjs';

test('the preview lists a configured llama.cpp route and holds changed metadata before dispatch', {timeout:10000},async t=>{
  const ollama=createMockOllama({cloud:'enabled'});
  const llama=createServer((request,response)=>{
    response.setHeader('content-type','application/json');
    if(request.url==='/health')return response.end(JSON.stringify({status:'ok'}));
    if(request.url==='/v1/models')return response.end(JSON.stringify({data:[{id:'synthetic-model',
      owned_by:'llamacpp',meta:{size:1,n_ctx:4096,ftype:'Q4_K - Medium'}}]}));
    response.writeHead(404);response.end();
  });
  for(const server of [ollama,llama]){server.listen(0,'127.0.0.1');await once(server,'listening');}
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('.',import.meta.url),windowsHide:true,
    env:{...process.env,BFE_PORT:'0',BFE_TEST_MEMORY:'1',BFE_TEST_KEY:'c'.repeat(64),
      BFE_OPENCODE_EXECUTABLE:process.execPath,BFE_OLLAMA_PORT:String(ollama.address().port),
      BFE_LLAMACPP_PORT:String(llama.address().port)},stdio:['ignore','pipe','pipe','ipc']});
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
    for(const server of [ollama,llama]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  });
  const [chunk]=await Promise.race([once(child.stdout,'data'),once(child,'exit').then(([code])=>{throw Error('Test service exited '+code);})]);
  const origin=/http:\/\/127\.0\.0\.1:\d+/.exec(chunk.toString())[0];
  const post=(path,body,cookie)=>fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',
    ...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  const session=await post('/api/session',{key:'c'.repeat(64)});
  const cookie=session.headers.get('set-cookie').split(';')[0];
  const routes=await (await fetch(origin+'/api/models',{headers:{Cookie:cookie}})).json();
  const route=routes.models.find(item=>item.engine==='opencode'&&item.backend==='llamacpp');
  assert.equal(route?.id,'synthetic-model');
  assert.equal(route.quantization,'Q4_K - Medium');
  assert.match(route.fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(routes.diagnostics.ollama.cloud,'enabled');
  const task=await (await post('/api/tasks',{title:'Synthetic',kind:'change',filename:'example.js',
    request:'Revise the file',source:'Original',expected:'Revised'},cookie)).json();
  const path='/api/tasks/'+task.id;
  const start=await post(path+'/run',{version:task.version,sourceHash:task.sourceHash,approve:true,
    engine:'opencode',backend:'llamacpp',model:'synthetic-model',modelFingerprint:'c'.repeat(64)},cookie);
  assert.equal(start.status,202);
  let result;
  for(let i=0;i<100;i++) {
    result=await (await fetch(origin+path,{headers:{Cookie:cookie}})).json();
    if(result.status!=='running')break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(result.status,'failed');
  assert.equal(result.attempts[0].execution.phase,'claimed');
  assert.match(result.attempts[0].problem,/identity changed/i);
});
