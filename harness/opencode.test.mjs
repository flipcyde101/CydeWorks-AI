import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {collectOpenCode,classifyDiagnostic,classifyOutput,opencode} from './opencode.mjs';
import {recordObservedUsage,recordOutcomeUncertainty} from './recovery.mjs';

test('a stopped OpenCode run preserves the observed step receipt without marking the provider settled',async()=>{
  const child=new EventEmitter();
  child.stdin=new PassThrough();
  child.stdout=new PassThrough();
  child.stderr=new PassThrough();
  child.kill=()=>{
    child.stdout.end();
    child.stderr.end();
    queueMicrotask(()=>child.emit('close',null,'SIGTERM'));
  };
  const controller=new AbortController();
  const result=collectOpenCode(child,{kind:'change',request:'Synthetic request'}, {
    signal:controller.signal,progress(){},terminal(message){
      if (message==='OpenCode returned proposal text.') controller.abort();
    },
  });
  child.stdout.write(JSON.stringify({type:'step_finish',part:{reason:'stop',tokens:{input:7,output:3,cache:{read:2}}}})+'\n');
  child.stdout.write(JSON.stringify({type:'text',part:{text:'Synthetic output'}})+'\n');
  const error=await result.then(()=>null,error=>error);
  assert.equal(error?.processExited,true);
  assert.equal(error.partialUsage.input,7);
  assert.equal(error.partialUsage.output,3);
  const attempt={provider:'opencode',execution:{phase:'dispatching'}};
  error.partialUsage.extra='must not persist';
  assert.equal(recordObservedUsage(attempt,error),true);
  recordOutcomeUncertainty(attempt,'2026-11-14T12:00:00.000Z');
  assert.equal(attempt.usage.input,7);
  assert.equal(attempt.usage.output,3);
  assert.equal(attempt.usage.cached,2);
  assert.equal(attempt.usage.extra,undefined);
  assert.equal(attempt.recovery.state,'unresolved');
  assert.equal(recordObservedUsage({provider:'ollama'},error),false);
});

test('OpenCode run retains multiple observed step receipts without replay double counting',async()=>{
  const child=new EventEmitter();
  child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
  const running=collectOpenCode(child,{kind:'brief',request:'Synthetic'},
    {signal:new AbortController().signal,progress(){},terminal(){}});
  const event=(id,input)=>({type:'step_finish',sessionID:'synthetic-session',part:{id,sessionID:'synthetic-session',
    messageID:'synthetic-message',reason:'stop',tokens:{input,output:2,cache:{read:1},reasoning:0}}});
  child.stdout.write(JSON.stringify(event('first',4))+'\n');
  child.stdout.write(JSON.stringify(event('first',4))+'\n');
  child.stdout.write(JSON.stringify(event('second',7))+'\n');
  child.stdout.write(JSON.stringify({type:'text',part:{text:'A proposal [1]'}})+'\n');
  child.stdout.end();child.stderr.end();
  child.emit('close',0,null);
  const result=await running;
  assert.equal(result.settled,true);
  assert.equal(result.usage.input,11);
  assert.equal(result.usage.output,4);
  assert.equal(result.usage.steps.items.length,2);
  assert.equal(result.usage.steps.duplicates,1);
  assert.doesNotMatch(JSON.stringify(result.usage),/synthetic-session|synthetic-message/);
  const attempt={provider:'opencode'};
  assert.equal(recordObservedUsage(attempt,{partialUsage:result.usage}),true);
  assert.deepEqual(attempt.usage,result.usage);
});

test('stale step replays and conflicting reasons cannot turn an incomplete run into a proposal',async()=>{
  const run=async events=>{
    const child=new EventEmitter();
    child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    const running=collectOpenCode(child,{kind:'brief',request:'Synthetic'},
      {signal:new AbortController().signal,progress(){},terminal(){}});
    for(const event of events)child.stdout.write(JSON.stringify(event)+'\n');
    child.stdout.write(JSON.stringify({type:'text',part:{text:'Incomplete [1]'}})+'\n');
    child.stdout.end();child.stderr.end();child.emit('close',0,null);
    return running;
  };
  const event=(id,reason)=>({type:'step_finish',sessionID:'session',part:{id,sessionID:'session',
    messageID:'message',reason,tokens:{input:4,output:2,cache:{read:1},reasoning:0}}});
  const stale=await run([event('first','stop'),event('second','length'),event('first','stop')]);
  assert.equal(stale.artifact,null);
  assert.equal(stale.settled,true);
  assert.equal(stale.usage.steps.duplicates,1);
  const conflict=await run([event('first','stop'),event('first','length')]);
  assert.equal(conflict.artifact,null);
  assert.equal(conflict.settled,false);
  assert.equal(conflict.usage.steps.conflict,true);
  const missingIdentity=await run([event(undefined,'length'),event(undefined,'stop')]);
  assert.equal(missingIdentity.artifact,null);
  assert.equal(missingIdentity.settled,false);
  const unknown=classifyOutput({code:0,finishReason:'error',output:'Incomplete',kind:'brief'});
  assert.equal(unknown.artifact,null);
  assert.equal(unknown.settled,false);
});

test('OpenCode diagnostics disclose only a fixed safe category',()=>{
  const secret='PRIVATE_SENTINEL';
  const hint=classifyDiagnostic('ECONNREFUSED '+secret);
  assert.match(hint,/refused connection/);
  assert.doesNotMatch(hint,/PRIVATE_SENTINEL/);
  assert.equal(classifyDiagnostic(secret),null);
  const result=classifyOutput({code:1,output:'',kind:'change',diagnostic:hint});
  assert.match(result.problem,/refused connection/);
  assert.doesNotMatch(result.problem,/PRIVATE_SENTINEL/);
});

test('OpenCode recheck and spawn failures do not disclose a local path',async t=>{
  t.mock.method(opencode,'availability',async()=> 'unknown');
  await assert.rejects(()=>opencode.models(),error=>/could not be checked/i.test(error.message)&&!/PRIVATE_SYNTHETIC_PATH|Users[\\/]/i.test(error.message));
  const child=new EventEmitter();
  child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
  const running=collectOpenCode(child,{kind:'change',request:'Synthetic'},
    {signal:new AbortController().signal,progress(){},terminal(){}});
  queueMicrotask(()=>{
    child.stdout.end();child.stderr.end();
    child.emit('error',Object.assign(Error('spawn PRIVATE_SYNTHETIC_PATH failed'),{code:'ENOENT'}));
  });
  await assert.rejects(running,error=>/could not start/i.test(error.message)&&!/PRIVATE_SYNTHETIC_PATH/.test(error.message));
});

test('a numbered code proposal retains the original and removes only consistent sequential prefixes',()=>{
  const numbered="1: export function normalizeName(value) {\n2:   return typeof value === 'string' ? value.trim() : value;\n3: }";
  const result=classifyOutput({code:0,finishReason:'stop',kind:'change',filename:'example.js',output:numbered});
  assert.equal(result.artifact.rawContent,numbered);
  assert.equal(result.artifact.content,"export function normalizeName(value) {\n  return typeof value === 'string' ? value.trim() : value;\n}");
  assert.match(result.artifact.summary,/line numbers were removed/i);
  const fenced=' \n```js\n1: const x = 1;\n2: export {x};\n```\n';
  assert.equal(classifyOutput({code:0,finishReason:'stop',kind:'change',filename:'example.js',output:fenced}).artifact.rawContent,fenced);
  const ordinaryFence='```js\nconst x = 1;\n```\n';
  const plain=classifyOutput({code:0,finishReason:'stop',kind:'change',filename:'example.js',output:ordinaryFence});
  assert.equal(plain.artifact.content,'const x = 1;');
  assert.equal(plain.artifact.rawContent,ordinaryFence);
  for(const other of [
    {filename:'notes.txt',output:numbered,kind:'change'},
    {filename:'example.js',output:'1: first\n3: third',kind:'change'},
    {filename:'example.js',output:numbered,kind:'brief'},
  ]) {
    const unchanged=classifyOutput({code:0,finishReason:'stop',...other});
    assert.equal(unchanged.artifact.content,other.output);
    assert.equal(unchanged.artifact.rawContent,undefined);
  }
});

test('OpenCode checks only the approved model backend and preserves its error',async t=>{
  const calls=[];
  const {createOpenCode}=await import('./opencode.mjs');
  const adapter=createOpenCode({provider:{models:async()=>{calls.push('ollama');throw Error('inventory check timed out');}},
    llamaProvider:{models:async()=>{calls.push('llamacpp');return [{id:'synthetic'}];}}});
  t.mock.method(adapter,'availability',async()=> 'present');
  await assert.rejects(()=>adapter.models({backend:'ollama'}),/inventory check timed out/);
  assert.deepEqual(calls,['ollama']);
  calls.length=0;
  assert.equal((await adapter.models({backend:'llamacpp'}))[0].id,'synthetic');
  assert.deepEqual(calls,['llamacpp']);
});
