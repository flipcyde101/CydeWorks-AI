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
  assert.equal(broker.settlement().state,'unknown');
  assert.equal(broker.settlement().records[0].evidence,'ambiguous-response');
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
  const snap=broker.settlement();
  assert.equal(snap.state,'unknown');
  assert.equal(snap.dispatched,1);
  assert.equal(snap.inFlight,0);
  assert.equal(snap.completed,0);
  assert.equal(snap.unknown,1);
  assert.equal(snap.closed,true);
  assert.equal(snap.modelCancellationVerified,false);
});

test('settlement distinguishes zero dispatch even after rejected local requests and broker close',async t=>{
  let upstreamCalls=0;
  const target=await backend(t,(_req,res)=>{upstreamCalls++;res.writeHead(200);res.end();});
  const broker=await createInferenceBroker(target,{model:'synthetic-model'});
  t.after(()=>broker.close());

  const initial=broker.settlement();
  assert.equal(initial.state,'zero-dispatch');
  assert.equal(initial.evidence,'zero-dispatch');
  assert.equal(initial.dispatched,0);
  assert.equal(initial.inFlight,0);
  assert.equal(initial.completed,0);
  assert.equal(initial.unknown,0);
  assert.equal(initial.rejectedBeforeDispatch,0);
  assert.equal(initial.closed,false);
  assert.equal(initial.modelCancellationVerified,false);
  assert.deepEqual(initial.records,[]);

  assert.equal((await fetch(broker.endpoint+'/v1/models')).status,404);
  assert.equal((await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',body:'{}'})).status,403);
  assert.equal((await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',body:'not-json',
    headers:{'x-cydeworks-local':broker.token}})).status,400);
  assert.equal((await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'other'}),
    headers:{'x-cydeworks-local':broker.token}})).status,403);
  assert.equal((await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',body:'x'.repeat(2000001),
    headers:{'x-cydeworks-local':broker.token}})).status,413);

  await new Promise(resolve=>{
    const req=request(broker.endpoint+'/v1/chat/completions',{method:'POST',
      headers:{'x-cydeworks-local':broker.token}},()=>{});
    req.on('error',()=>resolve());
    req.write('{"model":');
    setTimeout(()=>{req.destroy();resolve();},20);
  });

  await broker.close();
  const afterClose=broker.settlement();
  assert.equal(upstreamCalls,0);
  assert.equal(afterClose.state,'zero-dispatch');
  assert.equal(afterClose.dispatched,0);
  assert.equal(afterClose.closed,true);
  assert.equal(afterClose.modelCancellationVerified,false);
  assert.ok(afterClose.rejectedBeforeDispatch>=5);
});

test('settlement confirms complete normal JSON and SSE responses with positive completion evidence',async t=>{
  const target=await backend(t,(req,res)=>{
    let body='';
    req.on('data',chunk=>{body+=chunk;});
    req.on('end',()=>{
      const parsed=JSON.parse(body);
      if(parsed.stream) {
        res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8'});
        const utf8=Buffer.from('data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{"content":"hello 🚀"},"finish_reason":null}]}\r\n\r\n','utf8');
        res.write(utf8.subarray(0,utf8.length-10));
        res.write(utf8.subarray(utf8.length-10));
        res.write('data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n');
        res.write('data: {"id":"1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\r\n\r\n');
        res.end('data: [DONE]\r\n\r\n');
        return;
      }
      res.writeHead(200,{'content-type':'application/json; charset=utf-8'});
      res.end(JSON.stringify({
        id:'chatcmpl-1',
        object:'chat.completion',
        model:'synthetic-model',
        choices:[{index:0,message:{role:'assistant',content:'done'},finish_reason:'stop'}],
      }));
    });
  });
  const broker=await createInferenceBroker(target,{model:'synthetic-model'});
  t.after(()=>broker.close());

  const jsonResp=await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',
    body:JSON.stringify({model:'synthetic-model',stream:false}),
    headers:{'x-cydeworks-local':broker.token}});
  assert.equal(jsonResp.status,200);
  assert.equal((await jsonResp.json()).choices[0].finish_reason,'stop');

  let snap=broker.settlement();
  assert.equal(snap.state,'settled');
  assert.equal(snap.dispatched,1);
  assert.equal(snap.completed,1);
  assert.equal(snap.unknown,0);
  assert.equal(snap.modelCancellationVerified,false);
  assert.equal(snap.records[0].evidence,'json-finish-reason');
  assert.deepEqual(snap.records[0].finishReasons,['stop']);

  const sseResp=await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',
    body:JSON.stringify({model:'synthetic-model',stream:true}),
    headers:{'x-cydeworks-local':broker.token}});
  assert.equal(sseResp.status,200);
  assert.match(await sseResp.text(),/\[DONE\]/);

  snap=broker.settlement();
  assert.equal(snap.state,'settled');
  assert.equal(snap.dispatched,2);
  assert.equal(snap.completed,2);
  assert.equal(snap.unknown,0);
  assert.equal(snap.records[1].format,'sse');
  assert.equal(snap.records[1].evidence,'sse-finish-reason-and-done');
  assert.equal(snap.records[1].sawDone,true);
  assert.equal(snap.records[1].responseComplete,true);
  assert.deepEqual(snap.records[1].finishReasons,['stop']);
});

test('settlement reports unknown for deliberately unfinished streams and socket closure without proving cancellation',async t=>{
  const scenarios=[
    {
      name:'clean EOF without finish_reason or [DONE]',
      handler(_req,res){
        res.writeHead(200,{'content-type':'text/event-stream'});
        res.write('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
        res.end();
      },
      expectedEvidence:'ambiguous-response',
    },
    {
      name:'finish_reason without [DONE]',
      handler(_req,res){
        res.writeHead(200,{'content-type':'text/event-stream'});
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        res.end();
      },
      expectedEvidence:'ambiguous-response',
    },
    {
      name:'[DONE] without finish_reason',
      handler(_req,res){
        res.writeHead(200,{'content-type':'text/event-stream'});
        res.write('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
        res.end('data: [DONE]\n\n');
      },
      expectedEvidence:'ambiguous-response',
    },
    {
      name:'socket destroyed mid-chunked stream',
      handler(_req,res){
        res.writeHead(200,{'content-type':'text/event-stream'});
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        setTimeout(()=>res.socket.destroy(),10);
      },
      expectedEvidence:'upstream-incomplete-stream',
    },
  ];

  for(const scenario of scenarios) {
    const target=await backend(t,scenario.handler);
    const broker=await createInferenceBroker(target,{model:'synthetic-model'});
    t.after(()=>broker.close());
    const response=await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',
      body:JSON.stringify({model:'synthetic-model'}),
      headers:{'x-cydeworks-local':broker.token}});
    await response.text().catch(()=>{});
    const snap=broker.settlement();
    assert.equal(snap.state,'unknown',scenario.name);
    assert.equal(snap.dispatched,1,scenario.name);
    assert.equal(snap.completed,0,scenario.name);
    assert.equal(snap.unknown,1,scenario.name);
    assert.equal(snap.modelCancellationVerified,false,scenario.name);
    assert.equal(snap.records[0].evidence,scenario.expectedEvidence,scenario.name);
  }

  // Hanging unfinished stream interrupted via client abort and broker close
  let upstreamClosed;
  const closedPromise=new Promise(resolve=>{upstreamClosed=resolve;});
  const hangingTarget=await backend(t,(req,res)=>{
    req.resume();
    req.on('end',()=>{
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write('data: {"choices":[{"delta":{"content":"hanging"},"finish_reason":null}]}\n\n');
    });
    res.once('close',upstreamClosed);
  });
  const broker=await createInferenceBroker(hangingTarget,{model:'synthetic-model'});
  t.after(()=>broker.close());
  const reqAbort=new AbortController();
  const response=await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',
    body:JSON.stringify({model:'synthetic-model'}),
    headers:{'x-cydeworks-local':broker.token},signal:reqAbort.signal});
  const reader=response.body.getReader();
  assert.equal((await reader.read()).done,false);
  const midSnap=broker.settlement();
  assert.equal(midSnap.state,'unknown');
  assert.equal(midSnap.inFlight,1);
  assert.equal(midSnap.evidence,'in-flight');

  reqAbort.abort();
  await assert.rejects(()=>reader.read());
  await closedPromise;
  const postAbort=broker.settlement();
  assert.equal(postAbort.state,'unknown');
  assert.equal(postAbort.inFlight,0);
  assert.equal(postAbort.unknown,1);
  assert.equal(postAbort.modelCancellationVerified,false);
  assert.equal(postAbort.records[0].evidence,'client-aborted');
});

test('settlement reports unknown on truncation, errors, redirects, and ambiguous replies',async t=>{
  // 1. Truncated >2MB response
  const hugeTarget=await backend(t,(_req,res)=>{
    res.writeHead(200,{'content-type':'application/json'});
    res.end('x'.repeat(2000100));
  });
  const hugeBroker=await createInferenceBroker(hugeTarget,{model:'synthetic-model'});
  t.after(()=>hugeBroker.close());
  await assert.rejects(()=>fetch(hugeBroker.endpoint+'/v1/chat/completions',{method:'POST',
    body:JSON.stringify({model:'synthetic-model'}),
    headers:{'x-cydeworks-local':hugeBroker.token}}).then(r=>r.text()));
  assert.equal(hugeBroker.settlement().state,'unknown');
  assert.equal(hugeBroker.settlement().records[0].evidence,'response-truncated');

  // 2. Upstream connection refused
  const unused=createServer().listen(0,'127.0.0.1');
  await once(unused,'listening');
  const deadPort=unused.address().port;
  await new Promise(resolve=>unused.close(resolve));
  const deadBroker=await createInferenceBroker('http://127.0.0.1:'+deadPort,{model:'synthetic-model'});
  t.after(()=>deadBroker.close());
  const errResp=await fetch(deadBroker.endpoint+'/v1/chat/completions',{method:'POST',
    body:JSON.stringify({model:'synthetic-model'}),
    headers:{'x-cydeworks-local':deadBroker.token}});
  assert.equal(errResp.status,502);
  assert.equal(deadBroker.settlement().state,'unknown');
  assert.equal(deadBroker.settlement().records[0].evidence,'upstream-error');

  // 3. Ambiguous / error payloads with HTTP 200 or 500
  const cases=[
    {status:500,ct:'application/json',body:JSON.stringify({choices:[{finish_reason:'stop'}]}),expected:'upstream-http-error'},
    {status:200,ct:'application/json',body:'',expected:'ambiguous-response'},
    {status:200,ct:'application/json',body:JSON.stringify({ok:true}),expected:'ambiguous-response'},
    {status:200,ct:'application/json',body:JSON.stringify({choices:[{finish_reason:null}]}),expected:'ambiguous-response'},
    {status:200,ct:'application/json',body:JSON.stringify({choices:[{finish_reason:'error'}]}),expected:'ambiguous-response'},
    {status:200,ct:'application/json',body:JSON.stringify({error:{message:'failed'}}),expected:'upstream-error'},
    {status:200,ct:'text/plain',body:'plain text',expected:'ambiguous-response'},
    {status:200,ct:'text/event-stream',body:'event: error\ndata: {"error":"boom"}\n\n',expected:'upstream-error'},
    {status:200,ct:'text/event-stream',body:'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\ndata: {"extra":1}\n\n',expected:'ambiguous-response'},
  ];
  let idx=0;
  const mixedTarget=await backend(t,(_req,res)=>{
    const item=cases[idx++];
    res.writeHead(item.status,{'content-type':item.ct});
    res.end(item.body);
  });
  const mixedBroker=await createInferenceBroker(mixedTarget,{model:'synthetic-model'});
  t.after(()=>mixedBroker.close());
  for(let i=0;i<cases.length;i++) {
    const r=await fetch(mixedBroker.endpoint+'/v1/chat/completions',{method:'POST',
      body:JSON.stringify({model:'synthetic-model'}),
      headers:{'x-cydeworks-local':mixedBroker.token}});
    await r.text();
  }
  const snap=mixedBroker.settlement();
  assert.equal(snap.state,'unknown');
  assert.equal(snap.dispatched,cases.length);
  assert.equal(snap.completed,0);
  assert.equal(snap.unknown,cases.length);
  cases.forEach((item,i)=>assert.equal(snap.records[i].evidence,item.expected));
});

test('settlement snapshot is read-only and bounded across many requests',async t=>{
  const target=await backend(t,(_req,res)=>{
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({choices:[{finish_reason:'stop'}]}));
  });
  const broker=await createInferenceBroker(target,{model:'synthetic-model'});
  t.after(()=>broker.close());

  for(let i=0;i<70;i++) {
    const r=await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',
      body:JSON.stringify({model:'synthetic-model'}),
      headers:{'x-cydeworks-local':broker.token}});
    assert.equal(r.status,200);
    await r.json();
  }
  const snap=broker.settlement();
  assert.equal(snap.state,'settled');
  assert.equal(snap.dispatched,70);
  assert.equal(snap.completed,70);
  assert.equal(snap.unknown,0);
  assert.equal(snap.recordsTruncated,true);
  assert.equal(snap.records.length,64);
  assert.throws(()=>{snap.state='unknown';},TypeError);
  assert.throws(()=>{snap.records.push({});},TypeError);
  assert.throws(()=>{snap.records[0].state='unknown';},TypeError);
  assert.throws(()=>{snap.records[0].finishReasons.push('tamper');},TypeError);
  assert.equal(broker.settlement().state,'settled');
});

test('settlement rejects oversized SSE lines and marks mixed settled plus unknown dispatches as unknown',async t=>{
  let turn=0;
  const target=await backend(t,(_req,res)=>{
    turn++;
    if(turn===1) {
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({choices:[{finish_reason:'length'}]}));
      return;
    }
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write('data: {"choices":[{"delta":{"content":"'+'a'.repeat(270000)+'"}}]}\n\n');
    res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
  const broker=await createInferenceBroker(target,{model:'synthetic-model'});
  t.after(()=>broker.close());

  const ok=await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',
    body:JSON.stringify({model:'synthetic-model'}),
    headers:{'x-cydeworks-local':broker.token}});
  assert.equal(ok.status,200);
  await ok.json();
  assert.equal(broker.settlement().state,'settled');

  const truncatedSse=await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',
    body:JSON.stringify({model:'synthetic-model'}),
    headers:{'x-cydeworks-local':broker.token}});
  assert.equal(truncatedSse.status,200);
  await truncatedSse.text();

  const snap=broker.settlement();
  assert.equal(snap.state,'unknown');
  assert.equal(snap.dispatched,2);
  assert.equal(snap.completed,1);
  assert.equal(snap.unknown,1);
  assert.equal(snap.records[0].state,'settled');
  assert.deepEqual(snap.records[0].finishReasons,['length']);
  assert.equal(snap.records[1].state,'unknown');
  assert.equal(snap.records[1].evidence,'observation-limit-exceeded');
});

test('settlement validates per-choice terminal evidence for JSON and SSE including missing, duplicate, and contradictory cases',async t=>{
  const target=await backend(t,(req,res)=>{
    let raw='';
    req.on('data',chunk=>{raw+=chunk;});
    req.on('end',()=>{
      const {scenario}=JSON.parse(raw);
      if(scenario==='json-n2-ok') {
        res.writeHead(200,{'content-type':'application/json'});
        res.end(JSON.stringify({id:'c1',object:'chat.completion',choices:[
          {index:1,message:{role:'assistant',content:'b'},finish_reason:'length'},
          {index:0,message:{role:'assistant',content:'a'},finish_reason:'stop'},
        ]}));
        return;
      }
      if(scenario==='json-n2-missing-choice') {
        res.writeHead(200,{'content-type':'application/json'});
        res.end(JSON.stringify({id:'c2',object:'chat.completion',choices:[
          {index:0,message:{role:'assistant',content:'a'},finish_reason:'stop'},
        ]}));
        return;
      }
      if(scenario==='json-n2-duplicate-index') {
        res.writeHead(200,{'content-type':'application/json'});
        res.end(JSON.stringify({id:'c3',object:'chat.completion',choices:[
          {index:0,finish_reason:'stop'},
          {index:0,finish_reason:'stop'},
        ]}));
        return;
      }
      if(scenario==='json-n1-extra-choice') {
        res.writeHead(200,{'content-type':'application/json'});
        res.end(JSON.stringify({id:'c4',object:'chat.completion',choices:[
          {index:0,finish_reason:'stop'},
          {index:1,finish_reason:'stop'},
        ]}));
        return;
      }
      if(scenario==='sse-n2-ok') {
        res.writeHead(200,{'content-type':'text/event-stream'});
        res.write('data: {"id":"s1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\n\n');
        res.write('data: {"id":"s1","object":"chat.completion.chunk","choices":[{"index":1,"delta":{"content":"b"},"finish_reason":null}]}\n\n');
        res.write('data: {"id":"s1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
        res.write('data: {"id":"s1","object":"chat.completion.chunk","choices":[{"index":1,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
        res.write('data: {"id":"s1","object":"chat.completion.chunk","choices":[],"usage":{"total_tokens":5}}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      if(scenario==='sse-n2-choice1-unfinished') {
        res.writeHead(200,{'content-type':'text/event-stream'});
        res.write('data: {"choices":[{"index":0,"finish_reason":"stop"}]}\n\n');
        res.write('data: {"choices":[{"index":1,"delta":{"content":"unfinished"},"finish_reason":null}]}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      if(scenario==='sse-n2-duplicate-finish') {
        res.writeHead(200,{'content-type':'text/event-stream'});
        res.write('data: {"choices":[{"index":0,"finish_reason":"stop"}]}\n\n');
        res.write('data: {"choices":[{"index":0,"finish_reason":"stop"}]}\n\n');
        res.write('data: {"choices":[{"index":1,"finish_reason":"stop"}]}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      if(scenario==='sse-n1-delta-after-finish') {
        res.writeHead(200,{'content-type':'text/event-stream'});
        res.write('data: {"choices":[{"index":0,"finish_reason":"stop"}]}\n\n');
        res.write('data: {"choices":[{"index":0,"delta":{"content":"extra"},"finish_reason":null}]}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      if(scenario==='sse-n2-mixed-completion-ids') {
        res.writeHead(200,{'content-type':'text/event-stream'});
        res.write('data: {"id":"a","object":"chat.completion.chunk","choices":[{"index":0,"finish_reason":"stop"}]}\n\n');
        res.write('data: {"id":"b","object":"chat.completion.chunk","choices":[{"index":1,"finish_reason":"stop"}]}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      if(scenario==='sse-n2-present-then-missing-id') {
        res.writeHead(200,{'content-type':'text/event-stream'});
        res.write('data: {"id":"a","object":"chat.completion.chunk","choices":[{"index":0,"finish_reason":"stop"}]}\n\n');
        res.write('data: {"object":"chat.completion.chunk","choices":[{"index":1,"finish_reason":"stop"}]}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      if(scenario==='sse-n2-missing-then-present-id') {
        res.writeHead(200,{'content-type':'text/event-stream'});
        res.write('data: {"object":"chat.completion.chunk","choices":[{"index":0,"finish_reason":"stop"}]}\n\n');
        res.write('data: {"id":"b","object":"chat.completion.chunk","choices":[{"index":1,"finish_reason":"stop"}]}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({choices:[{index:0,finish_reason:'stop'}]}));
    });
  });

  const postScenario=async(payload)=>{
    const broker=await createInferenceBroker(target,{model:'synthetic-model'});
    t.after(()=>broker.close());
    const r=await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',
      body:JSON.stringify({model:'synthetic-model',...payload}),
      headers:{'x-cydeworks-local':broker.token}});
    assert.equal(r.status,200);
    await r.text();
    return broker.settlement();
  };

  const jsonOk=await postScenario({n:2,scenario:'json-n2-ok'});
  assert.equal(jsonOk.state,'settled');
  assert.deepEqual(jsonOk.records[0].finishReasons,['stop','length']);

  for(const [payload,label] of [
    [{n:2,scenario:'json-n2-missing-choice'},'json-n2-missing-choice'],
    [{n:2,scenario:'json-n2-duplicate-index'},'json-n2-duplicate-index'],
    [{n:1,scenario:'json-n1-extra-choice'},'json-n1-extra-choice'],
    [{n:2,scenario:'sse-n2-choice1-unfinished'},'sse-n2-choice1-unfinished'],
    [{n:2,scenario:'sse-n2-duplicate-finish'},'sse-n2-duplicate-finish'],
    [{n:1,scenario:'sse-n1-delta-after-finish'},'sse-n1-delta-after-finish'],
    [{n:2,scenario:'sse-n2-mixed-completion-ids'},'sse-n2-mixed-completion-ids'],
    [{n:2,scenario:'sse-n2-present-then-missing-id'},'sse-n2-present-then-missing-id'],
    [{n:2,scenario:'sse-n2-missing-then-present-id'},'sse-n2-missing-then-present-id'],
    [{n:0,scenario:'json-n1-ok'},'invalid-n-zero'],
  ]) {
    const snap=await postScenario(payload);
    assert.equal(snap.state,'unknown',label);
    assert.equal(snap.records[0].evidence,'ambiguous-response',label);
  }

  const sseOk=await postScenario({n:2,scenario:'sse-n2-ok'});
  assert.equal(sseOk.state,'settled');
  assert.deepEqual(sseOk.records[0].finishReasons,['stop','tool_calls']);
});

test('SSE parser handles CR, LF, and split CRLF across chunks and rejects errors after [DONE]',async t=>{
  let mode='cr-ok';
  const target=await backend(t,(_req,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'});
    if(mode==='cr-ok') {
      res.write('data: {"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\r\r');
      res.write('data: {"choices":[{"index":0,"finish_reason":"stop"}]}\r');
      res.write('\n\r');
      res.write('\ndata: [DONE]\r');
      res.end('\n\r\n');
      return;
    }
    if(mode==='comment-cr-error-after-done') {
      res.write('data: {"choices":[{"index":0,"finish_reason":"stop"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end(': comment\revent: error\rdata: {"error":"late"}\r\r');
      return;
    }
    res.write('data: {"choices":[{"index":0,"finish_reason":"stop"}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end('data: {"error":"late-json"}\n\n');
  });

  const broker=await createInferenceBroker(target,{model:'synthetic-model'});
  t.after(()=>broker.close());

  const okResp=await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',
    body:JSON.stringify({model:'synthetic-model'}),
    headers:{'x-cydeworks-local':broker.token}});
  await okResp.text();
  assert.equal(broker.settlement().state,'settled');

  mode='comment-cr-error-after-done';
  const lateErr1=await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',
    body:JSON.stringify({model:'synthetic-model'}),
    headers:{'x-cydeworks-local':broker.token}});
  await lateErr1.text();
  let snap=broker.settlement();
  assert.equal(snap.state,'unknown');
  assert.equal(snap.records[1].evidence,'upstream-error');

  mode='data-error-after-done';
  const lateErr2=await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',
    body:JSON.stringify({model:'synthetic-model'}),
    headers:{'x-cydeworks-local':broker.token}});
  await lateErr2.text();
  snap=broker.settlement();
  assert.equal(snap.state,'unknown');
  assert.equal(snap.records[2].evidence,'upstream-error');
});

test('concurrent observation memory and active entry limits keep outcomes unknown without truncating forwarded replies',async t=>{
  const padding='p'.repeat(1600000);
  const largePayload=JSON.stringify({choices:[{index:0,message:{role:'assistant',content:padding},finish_reason:'stop'}]});
  const pending=[];
  const pendingLarge=[];
  const target=await backend(t,(req,res)=>{
    let body='';
    req.on('data',chunk=>{body+=chunk;});
    req.on('end',()=>{
      const {hold}=JSON.parse(body);
      res.writeHead(200,{'content-type':'application/json'});
      if(hold) {
        pending.push(()=>res.end(JSON.stringify({choices:[{index:0,finish_reason:'stop'}]})));
        return;
      }
      res.write(largePayload.slice(0,1500000));
      pendingLarge.push(()=>res.end(largePayload.slice(1500000)));
    });
  });

  const broker=await createInferenceBroker(target,{model:'synthetic-model'});
  t.after(()=>broker.close());

  const largeResponses=await Promise.all([0,1,2].map(async()=>{
    const r=await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',
      body:JSON.stringify({model:'synthetic-model',hold:false}),
      headers:{'x-cydeworks-local':broker.token}});
    assert.equal(r.status,200);
    const reader=r.body.getReader();
    const parts=[];
    let bytes=0;
    while(bytes<1500000) {
      const {done,value}=await reader.read();
      assert.equal(done,false,'response must remain open while each prefix is observed');
      parts.push(value);
      bytes+=value.byteLength;
    }
    return {reader,parts};
  }));
  assert.equal(pendingLarge.length,3);
  const midLarge=broker.settlement();
  assert.equal(midLarge.inFlight,3);
  assert.ok(midLarge.observationBytes>0&&midLarge.observationBytes<=4000000);
  for(const finish of pendingLarge)finish();
  const concurrent=await Promise.all(largeResponses.map(async({reader,parts})=>{
    while(true) {
      const {done,value}=await reader.read();
      if(done)break;
      parts.push(value);
    }
    const json=JSON.parse(Buffer.concat(parts).toString('utf8'));
    assert.equal(json.choices[0].message.content.length,padding.length);
    return json;
  }));
  assert.equal(concurrent.length,3);
  const memSnap=broker.settlement();
  assert.equal(memSnap.state,'unknown');
  assert.equal(memSnap.observationBytes,0);
  assert.ok(memSnap.unknown>=1);
  assert.ok(memSnap.records.some(r=>r.evidence==='observation-limit-exceeded'));

  const overflowBroker=await createInferenceBroker(target,{model:'synthetic-model'});
  t.after(()=>overflowBroker.close());
  const inflightFetches=Array.from({length:66},()=>fetch(overflowBroker.endpoint+'/v1/chat/completions',{
    method:'POST',
    body:JSON.stringify({model:'synthetic-model',hold:true}),
    headers:{'x-cydeworks-local':overflowBroker.token},
  }).then(async r=>{assert.equal(r.status,200);return r.json();}));
  while(pending.length<66)await new Promise(resolve=>setTimeout(resolve,5));
  const mid=overflowBroker.settlement();
  assert.equal(mid.state,'unknown');
  assert.equal(mid.evidence,'in-flight');
  assert.equal(mid.dispatched,66);
  assert.equal(mid.inFlight,66);
  assert.equal(mid.completed,0);
  assert.equal(mid.unknown,0);
  assert.equal(mid.dispatched,mid.inFlight+mid.completed+mid.unknown);
  for(const finish of pending)finish();
  const bodies=await Promise.all(inflightFetches);
  assert.equal(bodies.length,66);
  const end=overflowBroker.settlement();
  assert.equal(end.state,'unknown');
  assert.equal(end.dispatched,66);
  assert.equal(end.inFlight,0);
  assert.equal(end.unknown,2);
  assert.equal(end.completed,64);
  assert.equal(end.recordsTruncated,true);
  assert.equal(end.dispatched,end.inFlight+end.completed+end.unknown);
});

test('broker.close settles overflow in-flight dispatches into unknown without leaving inFlight counts',async t=>{
  const pendingClose=[];
  const target=await backend(t,(req,res)=>{
    req.resume();
    req.on('end',()=>{pendingClose.push(()=>{if(!res.destroyed&&!res.writableEnded){res.writeHead(200);res.end('{}');}});});
  });
  const broker=await createInferenceBroker(target,{model:'synthetic-model'});
  t.after(()=>broker.close());
  const requests=Array.from({length:66},()=>fetch(broker.endpoint+'/v1/chat/completions',{
    method:'POST',
    body:JSON.stringify({model:'synthetic-model'}),
    headers:{'x-cydeworks-local':broker.token},
  }).catch(err=>err));
  while(pendingClose.length<66)await new Promise(resolve=>setTimeout(resolve,5));
  const mid=broker.settlement();
  assert.equal(mid.state,'unknown');
  assert.equal(mid.evidence,'in-flight');
  assert.equal(mid.dispatched,66);
  assert.equal(mid.inFlight,66);
  assert.equal(mid.completed,0);
  assert.equal(mid.unknown,0);
  assert.equal(mid.recordsTruncated,true);

  await broker.close();
  await Promise.all(requests);

  const closedSnap=broker.settlement();
  assert.equal(closedSnap.state,'unknown');
  assert.equal(closedSnap.evidence,'broker-closed');
  assert.equal(closedSnap.closed,true);
  assert.equal(closedSnap.dispatched,66);
  assert.equal(closedSnap.inFlight,0);
  assert.equal(closedSnap.completed,0);
  assert.equal(closedSnap.unknown,66);
  assert.equal(closedSnap.modelCancellationVerified,false);
  assert.equal(closedSnap.dispatched,closedSnap.inFlight+closedSnap.completed+closedSnap.unknown);
});

test('paused SSE streams bound event names and hit aggregate observation cap without truncating forwarded output',async t=>{
  const largeEventName='e'.repeat(200000);
  const largeDelta='d'.repeat(220000);
  const pendingEvent=[];
  const pendingSse=[];
  const target=await backend(t,(req,res)=>{
    let body='';
    req.on('data',chunk=>{body+=chunk;});
    req.on('end',()=>{
      const {mode}=JSON.parse(body);
      res.writeHead(200,{'content-type':'text/event-stream'});
      if(mode==='pause-event') {
        res.write('event: '+largeEventName+'\n');
        pendingEvent.push(()=>{
          res.write('data: {"choices":[{"index":0,"finish_reason":"stop"}]}\n\n');
          res.end('data: [DONE]\n\n');
        });
        return;
      }
      res.write('data: {"choices":[{"index":0,"delta":{"content":"'+largeDelta+'"},"finish_reason":null}]}\n');
      pendingSse.push(()=>{
        res.write('\n');
        res.write('data: {"choices":[{"index":0,"finish_reason":"stop"}]}\n\n');
        res.end('data: [DONE]\n\n');
      });
    });
  });

  const eventBroker=await createInferenceBroker(target,{model:'synthetic-model'});
  t.after(()=>eventBroker.close());
  const eventDrainers=[];
  await Promise.all(Array.from({length:21},async()=>{
    const r=await fetch(eventBroker.endpoint+'/v1/chat/completions',{method:'POST',
      body:JSON.stringify({model:'synthetic-model',mode:'pause-event'}),
      headers:{'x-cydeworks-local':eventBroker.token}});
    assert.equal(r.status,200);
    const reader=r.body.getReader();
    const decoder=new TextDecoder();
    let head='';
    while(!head.includes('\n')) {
      const step=await reader.read();
      assert.equal(step.done,false);
      head+=decoder.decode(step.value,{stream:true});
    }
    eventDrainers.push(async()=>{
      let text=head;
      while(true) {
        const step=await reader.read();
        if(step.done){text+=decoder.decode();break;}
        text+=decoder.decode(step.value,{stream:true});
      }
      return text;
    });
  }));
  const midEvent=eventBroker.settlement();
  assert.equal(midEvent.inFlight,21);
  assert.equal(midEvent.observationBytes,0);
  for(const finish of pendingEvent)finish();
  const eventBodies=await Promise.all(eventDrainers.map(fn=>fn()));
  for(const text of eventBodies)assert.ok(text.includes(largeEventName)&&text.endsWith('data: [DONE]\n\n'));
  const endEvent=eventBroker.settlement();
  assert.equal(endEvent.state,'settled');
  assert.equal(endEvent.completed,21);
  assert.equal(endEvent.unknown,0);
  assert.equal(endEvent.observationBytes,0);

  const sseBroker=await createInferenceBroker(target,{model:'synthetic-model'});
  t.after(()=>sseBroker.close());
  const sseDrainers=[];
  await Promise.all(Array.from({length:20},async()=>{
    const r=await fetch(sseBroker.endpoint+'/v1/chat/completions',{method:'POST',
      body:JSON.stringify({model:'synthetic-model',mode:'pause-data'}),
      headers:{'x-cydeworks-local':sseBroker.token}});
    assert.equal(r.status,200);
    const reader=r.body.getReader();
    const decoder=new TextDecoder();
    let head='';
    while(!head.includes('\n')) {
      const step=await reader.read();
      assert.equal(step.done,false);
      head+=decoder.decode(step.value,{stream:true});
    }
    sseDrainers.push(async()=>{
      let text=head;
      while(true) {
        const step=await reader.read();
        if(step.done){text+=decoder.decode();break;}
        text+=decoder.decode(step.value,{stream:true});
      }
      return text;
    });
  }));
  const midSse=sseBroker.settlement();
  assert.equal(midSse.inFlight,20);
  assert.ok(midSse.observationBytes>3500000&&midSse.observationBytes<=4000000);
  for(const finish of pendingSse)finish();
  const sseBodies=await Promise.all(sseDrainers.map(fn=>fn()));
  for(const text of sseBodies)assert.ok(text.includes(largeDelta)&&text.endsWith('data: [DONE]\n\n'));
  const endSse=sseBroker.settlement();
  assert.equal(endSse.state,'unknown');
  assert.equal(endSse.observationBytes,0);
  assert.ok(endSse.unknown>=2);
  assert.ok(endSse.records.some(r=>r.evidence==='observation-limit-exceeded'));
  assert.equal(endSse.dispatched,endSse.inFlight+endSse.completed+endSse.unknown);
});

test('overlapping dispatches and late abort races preserve accurate settlement and zero model cancellation claim',async t=>{
  let releaseSlow;
  const slowReleased=new Promise(resolve=>{releaseSlow=resolve;});
  const target=await backend(t,(req,res)=>{
    let body='';
    req.on('data',chunk=>{body+=chunk;});
    req.on('end',()=>{
      const {kind}=JSON.parse(body);
      if(kind==='slow-sse') {
        res.writeHead(200,{'content-type':'text/event-stream'});
        res.write('data: {"choices":[{"index":0,"delta":{"content":"wait"},"finish_reason":null}]}\n\n');
        slowReleased.then(()=>{
          if(!res.destroyed&&!res.writableEnded) {
            res.write('data: {"choices":[{"index":0,"finish_reason":"stop"}]}\n\n');
            res.end('data: [DONE]\n\n');
          }
        });
        return;
      }
      if(kind==='fast-json') {
        res.writeHead(200,{'content-type':'application/json'});
        res.end(JSON.stringify({choices:[{index:0,finish_reason:'stop'}]}));
        return;
      }
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write('data: {"choices":[{"index":0,"finish_reason":"stop"}]}\n\n');
    });
  });

  const broker=await createInferenceBroker(target,{model:'synthetic-model'});
  t.after(()=>broker.close());

  const slowResp=await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',
    body:JSON.stringify({model:'synthetic-model',kind:'slow-sse'}),
    headers:{'x-cydeworks-local':broker.token}});
  const slowReader=slowResp.body.getReader();
  assert.equal((await slowReader.read()).done,false);

  const fastResp=await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',
    body:JSON.stringify({model:'synthetic-model',kind:'fast-json'}),
    headers:{'x-cydeworks-local':broker.token}});
  await fastResp.json();

  const overlapSnap=broker.settlement();
  assert.equal(overlapSnap.state,'unknown');
  assert.equal(overlapSnap.evidence,'in-flight');
  assert.equal(overlapSnap.dispatched,2);
  assert.equal(overlapSnap.inFlight,1);
  assert.equal(overlapSnap.completed,1);

  releaseSlow();
  while(!(await slowReader.read()).done);

  const settledBoth=broker.settlement();
  assert.equal(settledBoth.state,'settled');
  assert.equal(settledBoth.inFlight,0);
  assert.equal(settledBoth.completed,2);

  // Late abort after finish_reason arrived without [DONE], racing with broker.close()
  const lateAbort=new AbortController();
  const racingResp=await fetch(broker.endpoint+'/v1/chat/completions',{method:'POST',
    body:JSON.stringify({model:'synthetic-model',kind:'hang-after-finish'}),
    headers:{'x-cydeworks-local':broker.token},signal:lateAbort.signal});
  const racingReader=racingResp.body.getReader();
  assert.equal((await racingReader.read()).done,false);
  lateAbort.abort();
  await broker.close();
  await assert.rejects(()=>racingReader.read());

  const finalSnap=broker.settlement();
  assert.equal(finalSnap.state,'unknown');
  assert.equal(finalSnap.dispatched,3);
  assert.equal(finalSnap.inFlight,0);
  assert.equal(finalSnap.completed,2);
  assert.equal(finalSnap.unknown,1);
  assert.equal(finalSnap.closed,true);
  assert.equal(finalSnap.modelCancellationVerified,false);
});
