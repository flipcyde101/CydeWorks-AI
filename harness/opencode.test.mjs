import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {collectOpenCode,classifyDiagnostic,classifyOutput} from './opencode.mjs';
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
