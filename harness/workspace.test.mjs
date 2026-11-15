import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {ollama,ollamaEndpoint} from './providers.mjs';
import {approvedPrompt,classifyOutput} from './opencode.mjs';
import {assessRoute} from './route.mjs';

const liveOpenCode=process.env.BFE_LIVE_TEST==='1';
const liveOllama=process.env.BFE_LIVE_OLLAMA==='1';
const live=liveOpenCode||liveOllama;
const liveModel=process.env.BFE_LIVE_MODEL??'qwen3:1.7b-dell-cpu';
test(liveOpenCode?'live OpenCode and Ollama approval, terminal controls, review and export'
  :liveOllama?'live direct Ollama approval, proposal, review and export':'synthetic file proposal, structural checks, review and metadata export',
  {timeout:live?170000:10000},async t=>{
  const probe=createServer().listen(0,'127.0.0.1');
  await once(probe,'listening');
  const {port}=probe.address();
  await new Promise(resolve=>probe.close(resolve));
  const origin='http://127.0.0.1:'+port;
  const key='a'.repeat(64);
  const child=spawn(process.execPath,['server.mjs'],{
    cwd:new URL('.',import.meta.url),windowsHide:true,
    env:{...process.env,BFE_PORT:String(port),BFE_TEST_MEMORY:'1',BFE_TEST_KEY:key},
    stdio:['ignore','pipe','pipe'],
  });
  t.after(async()=>{
    if (child.exitCode===null) {
      child.kill();
      await once(child,'exit');
    }
  });
  const started=await Promise.race([
    once(child.stdout,'data').then(([chunk])=>chunk.toString()),
    once(child,'exit').then(([code])=>{throw Error('Workspace exited with '+code);}),
  ]);
  assert.match(started,/CydeWorks AI/);
  const send=(path,body,headers={})=>fetch(origin+path,{
    method:body===undefined?'GET':'POST',
    headers:{Origin:origin,'Content-Type':'application/json',...headers},
    body:body===undefined?undefined:JSON.stringify(body),
  });
  assert.equal((await send('/api/tasks')).status,401);
  assert.equal((await send('/api/attention')).status,401);
  assert.equal((await send('/api/session',{key},{Origin:'https://elsewhere.invalid'})).status,403);
  assert.equal((await send('/api/session',{key:'b'.repeat(64)})).status,401);
  const session=await send('/api/session',{key});
  assert.equal(session.status,200);
  const cookie=session.headers.get('set-cookie').split(';')[0];
  const request=(path,body)=>send(path,body,{Cookie:cookie});
  const created=await request('/api/tasks',{title:'Synthetic change',kind:'change',filename:'example.txt',
    request:'Replace the entire file with the exact text Revised example',source:'SYNTHETIC_PRIVATE_SOURCE',expected:'Revised example'});
  assert.equal(created.status,201);
  const draft=await created.json();
  assert.equal((await (await request('/api/attention')).json()).tasks.filter(item=>item.id===draft.id).length,1);
  const path='/api/tasks/'+draft.id;
  const update=await request(path+'/scope',{...draft,source:'SYNTHETIC_PRIVATE_SOURCE_EDITED'});
  assert.equal(update.status,200);
  const task=await update.json();
  assert.notEqual(task.sourceHash,draft.sourceHash);
  const grant={version:task.version,sourceHash:task.sourceHash,approve:true,model:live?liveModel:'fixture',
    engine:liveOpenCode?'opencode':liveOllama?'ollama':'fixture'};
  if(live) {
    const inventory=await (await request('/api/models')).json();
    grant.modelDigest=inventory.models.find(model=>model.id===grant.model&&model.engine===grant.engine)?.digest;
  } else {
    assert.equal((await request(path+'/run',{...grant,model:'qwen3:1.7b',engine:'ollama'})).status,400);
  }
  assert.equal((await request(path+'/run',{...grant,sourceHash:'wrong'})).status,409);
  assert.equal((await request(path+'/run',{...grant,version:draft.version,sourceHash:draft.sourceHash})).status,409);
  const runs=await Promise.all([request(path+'/run',grant),request(path+'/run',grant)]);
  assert.deepEqual(runs.map(run=>run.status).sort(),[202,409]);
  if (liveOpenCode) {
    const terminal=(command,lease,confirm)=>request(path+'/terminal',{command,lease,confirm});
    let running;
    for (let i=0;i<60;i++) {
      running=await (await request(path)).json();
      if (running.live?.terminal.some(entry=>entry.message.startsWith('OpenCode started'))) break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(running.live?.terminal.some(entry=>entry.message.startsWith('OpenCode started')),'OpenCode must actually start before detach');
    const runningId=running.attempts.at(-1).id;
    assert.equal((await terminal('status')).status,409);
    const first=await terminal('take');
    assert.equal(first.status,200);
    const {lease}=await first.json();
    assert.equal((await terminal('take')).status,409);
    const transfer=await terminal('take',undefined,true);
    assert.equal(transfer.status,200);
    const {lease:transferred}=await transfer.json();
    assert.equal((await terminal('status',lease)).status,409);
    assert.equal((await terminal('status',transferred)).status,200);
    assert.equal((await terminal('detach',transferred)).status,200);
    assert.equal((await terminal('status',transferred)).status,409);
    const observed=await (await request(path)).json();
    assert.equal(observed.status,'running');
    assert.equal(observed.live.owner,'None');
    await new Promise(resolve=>setTimeout(resolve,1000));
    const reattached=await (await request(path)).json();
    assert.equal(reattached.status,'running',reattached.attempts.at(-1)?.problem ?? 'The live run ended before reattachment could be verified.');
    assert.equal(reattached.attempts.at(-1).id,runningId);
    assert.equal(reattached.live.owner,'None');
    assert.ok(reattached.live.terminal.some(entry=>entry.message==='Operator detached. OpenCode continues.'));
    t.diagnostic('Detached after OpenCode started, observed the same active attempt without control, and retained the terminal history.');
    const retake=await terminal('take');
    assert.equal(retake.status,200);
    assert.equal((await terminal('release',(await retake.json()).lease)).status,200);
  }
  let current;
  for (let i=0;i<(live?150:50);i++) {
    current=await (await request(path)).json();
    if (current.status!=='running') break;
    await new Promise(resolve=>setTimeout(resolve,live?900:20));
  }
  assert.equal(current.status,'review',current.attempts[0]?.problem);
  assert.equal((await (await request('/api/attention')).json()).tasks.find(item=>item.id===draft.id).reasons[0],'Proposal needs review');
  assert.equal(current.attempts.length,1);
  const attempt=current.attempts[0];
  assert.equal(attempt.artifact.content.trim(),'Revised example','The exact replacement request must not pass by merely echoing instructions.');
  if (!live) assert.equal(attempt.artifact.patch,[
    '--- a/example.txt','+++ b/example.txt','@@ -1,1 +1,1 @@',
    '-SYNTHETIC_PRIVATE_SOURCE_EDITED','\\ No newline at end of file',
    '+Revised example','\\ No newline at end of file','',
  ].join('\n'));
  assert.ok(attempt.checks.every(check=>check.pass));
  assert.equal(attempt.usage.evidence,liveOpenCode?'OpenCode reported':liveOllama?'provider reported':'synthetic');
  if (liveOpenCode) {
    assert.ok(attempt.engineSessionId);
    assert.ok(attempt.usage.output>0);
    assert.ok(attempt.terminal.some(entry=>entry.message.includes('process exited with code 0')));
    t.diagnostic('OpenCode completed in '+attempt.elapsedMs+' ms. Session, usage and patch were captured.');
  }
  if (liveOllama) {
    assert.ok(attempt.usage.output>0);
    assert.equal(attempt.execution.phase,'settled');
    t.diagnostic('Direct Ollama completed in '+attempt.elapsedMs+' ms. Usage and the exact patch were captured.');
  }
  const review={version:current.version,decision:'accepted',artifactHash:attempt.artifact.sha256};
  assert.equal((await request(path+'/review',{...review,artifactHash:'wrong'})).status,409);
  assert.equal((await request(path+'/review',review)).status,200);
  assert.equal((await (await request('/api/attention')).json()).tasks.some(item=>item.id===draft.id),false);
  const exported=await (await request(path+'/export')).text();
  assert.doesNotMatch(exported,/SYNTHETIC_PRIVATE_SOURCE|Revised example|Change the example/);
  assert.equal(JSON.parse(exported).task.status,'accepted');
  const minimal=await (await request(path+'/export?mode=minimal')).text();
  assert.doesNotMatch(minimal,/SYNTHETIC_PRIVATE_SOURCE|Revised example|Synthetic change|example\.txt|qwen3|[a-f0-9]{64}/);
  assert.equal(JSON.parse(minimal).mode,'minimal');
  assert.equal((await request(path+'/export?mode=unrecognized')).status,400);
  assert.equal((await fetch(origin+'/')).status,200);
  if (liveOpenCode) {
    const accepted=await (await request(path)).json();
    assert.equal((await request(path+'/run',{...grant,version:accepted.version})).status,202);
    const terminal=(command,lease,confirm)=>request(path+'/terminal',{command,lease,confirm});
    const lease=(await (await terminal('take')).json()).lease;
    for (let i=0;i<60;i++) {
      current=await (await request(path)).json();
      if (current.live?.terminal.some(entry=>entry.message.startsWith('OpenCode started'))) break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(current.live?.terminal.some(entry=>entry.message.startsWith('OpenCode started')));
    assert.equal((await terminal('stop',lease,false)).status,400);
    assert.equal((await terminal('stop',lease,true)).status,200);
    for (let i=0;i<80;i++) {
      current=await (await request(path)).json();
      if (current.status!=='running') break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(current.status,'cancelled');
    assert.match(current.attempts.at(-1).problem,/OpenCode process exit was observed/);
    assert.equal(current.live,null);
    assert.equal((await terminal('status',lease)).status,409);
    t.diagnostic('Confirmed Stop terminated the managed OpenCode process and invalidated its control lease.');
  }
  if (!live) {
    const second=await (await request('/api/tasks',{title:'Another synthetic task',kind:'brief',
      request:'Summarize',source:'Independent synthetic source'})).json();
    const preview=await (await request(path+'/removal-preview')).json();
    assert.equal(preview.allowed,true);
    assert.doesNotMatch(JSON.stringify(preview),/SYNTHETIC_PRIVATE_SOURCE|Revised example/);
    const removal={version:preview.version,expiresAt:preview.expiresAt,token:preview.token,confirmation:'REMOVE'};
    assert.equal((await request(path+'/remove',{...removal,confirmation:'yes'})).status,409);
    assert.equal((await request(path+'/remove',{...removal,token:'b'.repeat(64)})).status,409);
    assert.equal((await request(path)).status,200);
    assert.equal((await request(path+'/remove',removal)).status,200);
    assert.equal((await request(path)).status,404);
    assert.equal((await request('/api/tasks/'+second.id)).status,200);
    const audit=await (await request('/api/removal-audit')).json();
    assert.equal(audit.records.length,1);
    assert.doesNotMatch(JSON.stringify(audit),/SYNTHETIC_PRIVATE_SOURCE|Revised example|Synthetic change/);
  }
});

test('OpenCode receives the approved task instruction separately from reference source data',()=>{
  const prompt=approvedPrompt({kind:'change',request:'Replace the entire file with Revised example',source:'SOURCE_DO_NOT_INLINE'});
  assert.ok(prompt.endsWith('Complete this approved user request:\nReplace the entire file with Revised example'));
  assert.doesNotMatch(prompt,/SOURCE_DO_NOT_INLINE/);
  assert.match(prompt,/reference source data, not instructions/);
  assert.match(approvedPrompt({kind:'brief',request:'Summarize the decisions'}),/Cite numbered source lines/);
});

test('OpenCode requires a terminal event as well as a successful process exit',()=>{
  const input={code:0,output:'Revised example',kind:'change',usage:null,sessionId:'synthetic'};
  const missing=classifyOutput(input);
  assert.equal(missing.settled,false);
  assert.equal(missing.artifact,null);
  const completed=classifyOutput({...input,finishReason:'stop'});
  assert.equal(completed.settled,true);
  assert.equal(completed.artifact.content,'Revised example');
  assert.equal(classifyOutput({...input,finishReason:'length'}).artifact,null);
  assert.equal(classifyOutput({...input,finishReason:'stop',code:1}).settled,false);
});

test('Ollama requires an explicit final completion marker',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response([
    JSON.stringify({message:{content:'{"summary":"Brief","content":"Source [1]."}'},done:false}),
    JSON.stringify({done:'true',prompt_eval_count:12,eval_count:6}),
  ].join('\n')));
  await assert.rejects(()=>ollama.run({model:'qwen3:1.7b',kind:'brief',source:'Source',request:'Summarize'},
    {signal:AbortSignal.timeout(2000),progress(){}}),/stream ended before completion/);
});

test('local inventory shows unknown models and holds them along with missing or oversized sizes',async t=>{
  t.mock.method(globalThis,'fetch',async url=>url.endsWith('/api/status')?Response.json({cloud:{disabled:true}}):Response.json({models:[
    {name:'qwen3:1.7b',size:1000000000,digest:'a'.repeat(64)},
    {name:'qwen3:1.7b-dell-cpu'},
    {name:'qwen3.5:4b-dell-gpu',size:5000000000},
    {name:'unqualified:cloud',size:1,details:{quantization_level:{toString:null,valueOf:null}}},
  ]}));
  const models=await ollama.models();
  assert.equal(models.length,4);
  assert.equal(assessRoute({...models[0],engine:'ollama'},9000000000).eligible,true);
  assert.match(assessRoute({...models[1],engine:'ollama'},9000000000).reason,/size is unavailable/);
  assert.match(assessRoute({...models[2],engine:'ollama'},9000000000).reason,/larger than 4 GB/);
  assert.match(assessRoute({...models[3],engine:'ollama'},9000000000).reason,/not enabled/);
  assert.equal(models[3].quantization,null);
});

test('reported remote Ollama aliases are held and remote responses are never presented as local',async t=>{
  let listing=true;
  t.mock.method(globalThis,'fetch',async url=>listing&&url.endsWith('/api/status')?Response.json({cloud:{disabled:true}}):listing?Response.json({models:[
    {name:'qwen3:1.7b',size:1000000000,remote_host:'https://example.invalid'},
  ]}):new Response(JSON.stringify({done:true,error:'synthetic error',remote_host:'https://example.invalid',
    message:{content:'{"summary":"Synthetic","content":"Source [1]."}'}})));
  const [model]=await ollama.models();
  assert.equal(model.remote,true);
  assert.equal(assessRoute({...model,engine:'ollama'},9000000000).eligible,false);
  listing=false;
  await assert.rejects(()=>ollama.run({model:'qwen3:1.7b',kind:'brief',source:'Synthetic',request:'Summarize'},
    {signal:AbortSignal.timeout(2000),progress(){}}),/remote destination/);
});

test('missing or enabled cloud status keeps local model routes on hold',async t=>{
  let state=null;
  t.mock.method(globalThis,'fetch',async url=>url.endsWith('/api/status')
    ?state===null?new Response('',{status:404}):Response.json({cloud:{disabled:state}})
    :Response.json({models:[{name:'qwen3:1.7b',size:1000000000,digest:'a'.repeat(64)}]}));
  let [model]=await ollama.models();
  assert.equal(model.cloudDisabled,null);
  assert.equal(assessRoute({...model,engine:'ollama'},9000000000).eligible,false);
  state=false;
  [model]=await ollama.models();
  assert.equal(model.cloudDisabled,false);
  assert.equal(assessRoute({...model,engine:'ollama'},9000000000).eligible,false);
  state=true;
  [model]=await ollama.models();
  assert.equal(assessRoute({...model,engine:'ollama'},9000000000).eligible,true);
});

test('oversized inventory is rejected and an oversized cloud-status response holds the route',async t=>{
  let oversizedInventory=true;
  t.mock.method(globalThis,'fetch',async url=>url.endsWith('/api/status')
    ?Response.json({cloud:{disabled:true},padding:'x'.repeat(32000)})
    :oversizedInventory?new Response('x'.repeat(2000001))
      :Response.json({models:[{name:'qwen3:1.7b',size:1,digest:'a'.repeat(64)}]}));
  await assert.rejects(()=>ollama.models(),/size limit/);
  oversizedInventory=false;
  const [model]=await ollama.models();
  assert.equal(model.cloudDisabled,null);
  assert.equal(assessRoute({...model,engine:'ollama'},9000000000).eligible,false);
});

test('invalid UTF-8 in cloud status is held, even if it contains disabled true',async t=>{
  const invalid=Buffer.concat([Buffer.from('{"cloud":{"disabled":true},"extra":"'),Buffer.from([255]),Buffer.from('"}')]);
  t.mock.method(globalThis,'fetch',async url=>url.endsWith('/api/status')?new Response(invalid)
    :Response.json({models:[{name:'qwen3:1.7b',size:1,digest:'a'.repeat(64)}]}));
  const [model]=await ollama.models();
  assert.equal(model.cloudDisabled,null);
  assert.equal(assessRoute({...model,engine:'ollama'},9000000000).eligible,false);
});

test('failed inventory cancels its unused body and still consumes concurrent status',async t=>{
  let cancelled=false,consumed=false;
  t.mock.method(globalThis,'fetch',async url=>url.endsWith('/api/tags')
    ?new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:500})
    :new Response(new ReadableStream({pull(controller){consumed=true;controller.enqueue(new TextEncoder().encode('{"cloud":{"disabled":true}}'));controller.close();}})));
  await assert.rejects(()=>ollama.models(),/unsuccessful response/);
  assert.equal(cancelled,true);
  assert.equal(consumed,true);
});

test('an unsuccessful inference response cancels its unused body',async t=>{
  let cancelled=false;
  t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:503}));
  await assert.rejects(()=>ollama.run({model:'qwen3:1.7b',kind:'brief',source:'Synthetic',request:'Summarize'},
    {signal:AbortSignal.timeout(2000),progress(){}}),/rejected the run/);
  assert.equal(cancelled,true);
});

test('Ollama adapter bounds the destination and preserves reported and missing usage fields',async t=>{
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    assert.equal(options.redirect,'error');
    if (url.endsWith('/api/tags')) return Response.json({models:[
      {name:'qwen3:1.7b',size:1e9,digest:'a'.repeat(64)},
      {name:'unqualified:cloud',size:1e6},
    ]});
    if (url.endsWith('/api/status')) return Response.json({cloud:{disabled:true}});
    assert.equal(url,ollamaEndpoint+'/api/chat');
    const body=JSON.parse(options.body);
    assert.equal(body.model,'qwen3:1.7b');
    assert.equal(body.tools,undefined);
    return new Response([
      JSON.stringify({message:{content:'{"summary":"Brief","content":"Source [1]."}'},done:false}),
      JSON.stringify({done:true,prompt_eval_count:12,eval_count:6,eval_duration:500000000}),
    ].join('\n'));
  });
  const models=await ollama.models();
  assert.deepEqual(models.map(model=>model.id),['qwen3:1.7b','unqualified:cloud']);
  assert.equal(assessRoute({...models[1],engine:'ollama'},9000000000).eligible,false);
  const result=await ollama.run({model:'qwen3:1.7b',kind:'brief',source:'Source one.',request:'Summarize.'},
    {signal:AbortSignal.timeout(2000),progress(){}});
  assert.equal(result.artifact.content,'Source [1].');
  assert.equal(result.usage.input,12);
  assert.equal(result.usage.output,6);
  assert.equal(result.usage.cached,null);
  assert.equal(result.usage.generationMs,500);
  assert.equal(result.usage.providerCharge,null);
});
