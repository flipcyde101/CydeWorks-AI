import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {once} from 'node:events';
import {directLocalFetch} from './direct-local-fetch.mjs';
import {createOllama} from './providers.mjs';

test('local transport rejects non-loopback, unexpected routes, and redirects',async t=>{
  let redirected=0;
  const destination=createServer((_req,res)=>{redirected++;res.end();});
  destination.listen(0,'127.0.0.1');await once(destination,'listening');
  const source=createServer((_req,res)=>{res.writeHead(307,{location:'http://127.0.0.1:'+destination.address().port+'/stolen'});res.end();});
  source.listen(0,'127.0.0.1');await once(source,'listening');
  t.after(async()=>{for(const server of [source,destination]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
  const url='http://127.0.0.1:'+source.address().port;
  assert.throws(()=>directLocalFetch('http://example.invalid/api/tags',{redirect:'error'}),/destination/);
  assert.throws(()=>directLocalFetch(url+'/other',{redirect:'error'}),/destination/);
  assert.throws(()=>directLocalFetch(url+'/api/tags?x=1',{redirect:'error'}),/destination/);
  assert.throws(()=>directLocalFetch(url+'/api/tags',{method:'POST',redirect:'error'}),/destination/);
  assert.throws(()=>directLocalFetch(url+'/api/tags',{redirect:'follow'}),/destination/);
  await assert.rejects(()=>directLocalFetch(url+'/api/chat',{method:'POST',redirect:'error',body:'synthetic'}),/redirect/);
  assert.equal(redirected,0);
});

test('a protocol upgrade is rejected instead of leaving the request pending', {timeout:5000},async t=>{
  const server=createNetServer(socket=>{
    socket.once('data',()=>socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: synthetic\r\n\r\n'));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));});
  const request=directLocalFetch('http://127.0.0.1:'+server.address().port+'/api/status',{redirect:'error'});
  let timer;
  const outcome=await Promise.race([
    request.then(()=>'resolved',()=> 'rejected'),
    new Promise(resolve=>{timer=setTimeout(()=>resolve('pending'),500);}),
  ]);
  clearTimeout(timer);
  assert.equal(outcome,'rejected');
});

test('cancelling a streamed local response closes the request', {timeout:5000},async t=>{
  let closed;
  const closedPromise=new Promise(resolve=>{closed=resolve;});
  const server=createServer((req,res)=>{
    req.resume();res.writeHead(200,{'content-type':'application/json'});res.write('{"message":');
    res.once('close',closed);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const controller=new AbortController();
  const response=await directLocalFetch('http://127.0.0.1:'+server.address().port+'/api/chat',{
    method:'POST',redirect:'error',body:'synthetic',signal:controller.signal});
  const reader=response.body.getReader();
  assert.equal((await reader.read()).done,false);
  controller.abort();
  await assert.rejects(()=>reader.read());
  await Promise.race([closedPromise,new Promise((_,reject)=>setTimeout(()=>reject(Error('Request remained open.')),2000))]);
});

test('a timeout during model streaming retains the timeout reason', {timeout:5000},async t=>{
  const server=createServer((req,res)=>{req.resume();res.writeHead(200);res.write('{"message":{"content":"partial"},"done":false}\n');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const controller=new AbortController();
  const adapter=createOllama({transport:(_address,options)=>directLocalFetch(
    'http://127.0.0.1:'+server.address().port+'/api/chat',options)});
  let observed;
  const observedChunk=new Promise(resolve=>{observed=resolve;});
  const running=adapter.run({model:'synthetic',kind:'change',request:'Synthetic',source:'Original'},
    {signal:controller.signal,progress(){observed();}});
  await observedChunk;
  controller.abort(new DOMException('Synthetic timeout','TimeoutError'));
  await assert.rejects(running,error=>error.name==='TimeoutError');
});
