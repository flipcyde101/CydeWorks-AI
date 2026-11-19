import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
import {createInferenceBroker} from './inference-broker.mjs';

async function backend(t,handler) {
  const server=createServer(handler);
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return 'http://127.0.0.1:'+server.address().port;
}

test('the inference broker blocks redirects without forwarding their location',async t=>{
  let requests=0;
  const target=await backend(t,(_req,res)=>{requests++;res.writeHead(307,{location:'https://example.invalid/private'});res.end();});
  const broker=await createInferenceBroker(target,{model:'synthetic-model'});
  t.after(()=>broker.close());
  const response=await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'synthetic-model'}),redirect:'manual',
    headers:{'x-cydeworks-local':broker.token}});
  assert.equal(response.status,502);
  assert.equal(response.headers.get('location'),null);
  assert.equal(requests,1);
});

test('the inference broker forwards only the approved chat endpoint and streams its response',async t=>{
  let body='',calls=0,tokenForwarded=false;
  const target=await backend(t,(req,res)=>{
    calls++;
    tokenForwarded=Object.hasOwn(req.headers,'x-cydeworks-local');
    req.on('data',chunk=>{body+=chunk;});
    req.on('end',()=>{res.writeHead(200,{'content-type':'text/event-stream','set-cookie':'private=synthetic'});
      res.write('data: one\n\n');res.end('data: two\n\n');});
  });
  const broker=await createInferenceBroker(target,{model:'synthetic-model'});
  t.after(()=>broker.close());
  const response=await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'synthetic-model'}),
    headers:{'x-cydeworks-local':broker.token}});
  assert.equal(await response.text(),'data: one\n\ndata: two\n\n');
  assert.deepEqual(JSON.parse(body),{model:'synthetic-model'});
  assert.equal(response.headers.get('set-cookie'),null);
  assert.equal((await fetch(broker.endpoint+'/v1/models')).status,404);
  assert.equal((await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',body:'synthetic'})).status,403);
  const wrongToken=(broker.token.startsWith('0')?'1':'0')+broker.token.slice(1);
  assert.equal((await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'synthetic-model'}),
    headers:{'x-cydeworks-local':wrongToken}})).status,403);
  assert.equal((await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'other'}),
    headers:{'x-cydeworks-local':broker.token}})).status,403);
  const wrongHost=await new Promise((resolveStatus,reject)=>{
    const req=request(broker.endpoint+'/v1/chat/completions',{method:'POST',
      headers:{'x-cydeworks-local':broker.token,Host:'localhost'}},res=>{res.resume();resolveStatus(res.statusCode);});
    req.on('error',reject);
    req.end(JSON.stringify({model:'synthetic-model'}));
  });
  assert.equal(wrongHost,403);
  assert.equal(calls,1);
  assert.equal(tokenForwarded,false);
});

test('the inference broker rejects non-loopback destinations',async()=>{
  await assert.rejects(()=>createInferenceBroker('https://example.invalid',{model:'synthetic-model'}),/local model endpoint/i);
  await assert.rejects(()=>createInferenceBroker('http://127.0.0.1:8080/other',{model:'synthetic-model'}),/local model endpoint/i);
  const defaultPort=await createInferenceBroker('http://127.0.0.1:80',{model:'synthetic-model'});
  await defaultPort.close();
});

test('aborting a brokered request closes its upstream connection', {timeout:5000},async t=>{
  let observedClose;
  const closed=new Promise(resolve=>{observedClose=resolve;});
  const target=await backend(t,(req,res)=>{
    req.resume();
    req.on('end',()=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: partial\n\n');});
    res.once('close',observedClose);
  });
  const controller=new AbortController();
  const broker=await createInferenceBroker(target,{signal:controller.signal,model:'synthetic-model'});
  t.after(()=>broker.close());
  const response=await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'synthetic-model'}),
    headers:{'x-cydeworks-local':broker.token}});
  const reader=response.body.getReader();
  assert.equal((await reader.read()).done,false);
  controller.abort();
  await assert.rejects(()=>reader.read());
  await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('Upstream remained open.')),2000))]);
});
