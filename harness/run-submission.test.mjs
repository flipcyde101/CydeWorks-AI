import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {prepareRunSubmission,findRunSubmission,replayRunSubmission,submissionResult,publicAttempts} from './run-submission.mjs';
import {recordInterruption} from './recovery.mjs';
import {exportTask} from './export.mjs';

const id=randomUUID();
const body={requestId:randomUUID(),version:1,sourceHash:'a'.repeat(64),approve:true,model:'fixture'};
test('public attempt redaction preserves incomplete legacy shapes without mutating storage',()=>{
  for(const value of [undefined,null,'invalid'])assert.equal(publicAttempts(value),value);
  const stored=[null,1,[],{id:'example',submission:{requestId:'private'},status:'failed'}];
  assert.deepEqual(publicAttempts(stored),[null,1,[],{id:'example',status:'failed'}]);
  assert.equal(stored[3].submission.requestId,'private');
});
test('submission identity binds task, approved version, source and route without storing body',()=>{
  const before=JSON.stringify(body),result=prepareRunSubmission(id,body);
  assert.deepEqual(Object.keys(result),['requestId','fingerprint']);
  assert.match(result.fingerprint,/^[a-f0-9]{64}$/);
  assert.deepEqual(result,prepareRunSubmission(id,{...body,engine:'fixture',backend:'fixture'}));
  assert.notEqual(result.fingerprint,prepareRunSubmission(randomUUID(),body).fingerprint);
  assert.notEqual(result.fingerprint,prepareRunSubmission(id,{...body,version:2}).fingerprint);
  assert.notEqual(result.fingerprint,prepareRunSubmission(id,{...body,sourceHash:'b'.repeat(64)}).fingerprint);
  const local={...body,model:'qwen3:1.7b',engine:'ollama',modelDigest:'a'.repeat(64)};
  const a=prepareRunSubmission(id,local);
  for(const changes of [{engine:'opencode'},{model:'different'},{modelDigest:'b'.repeat(64)},
    {engine:'opencode',backend:'llamacpp',modelFingerprint:'c'.repeat(64)}])
    assert.notEqual(a.fingerprint,prepareRunSubmission(id,{...local,...changes}).fingerprint);
  assert.equal(JSON.stringify(body),before);
});

test('invalid keyed submissions fail closed; legacy bodies use existing API validation',()=>{
  assert.equal(prepareRunSubmission(id,{version:1}),null);
  for(const changes of [{requestId:null},{requestId:'PRIVATE_CANARY'},{approve:1},{approve:false},
    {version:1.2},{version:-1},{version:Number.MAX_SAFE_INTEGER+1},{sourceHash:'bad'},
    {extra:true},{engine:'bad'},{backend:'ollama'},{model:' '},{modelDigest:42},
    {modelFingerprint:'bad'},{model:'qwen3:1.7b',engine:'ollama'},
    {model:'qwen3:1.7b',engine:'ollama',backend:'llamacpp',modelFingerprint:'a'.repeat(64)}])
    assert.throws(()=>prepareRunSubmission(id,{...body,...changes}),error=>error.status===400&&!error.message.includes('PRIVATE_CANARY'));
});

test('replays recover their recorded attempt, reject conflicting IDs and survive interruption',()=>{
  const submission=prepareRunSubmission(id,body),attempt={id:randomUUID(),status:'running',provider:'opencode',
    execution:{phase:'dispatching'},submission};
  const task={id,version:2,status:'running',attempts:[attempt]};
  assert.equal(replayRunSubmission(task,submission),attempt);
  assert.equal(findRunSubmission(task,randomUUID()),null);
  assert.throws(()=>replayRunSubmission(task,prepareRunSubmission(id,{...body,version:2})),{status:409});
  recordInterruption(task,'2026-11-16T12:00:00Z');
  const result=submissionResult(task,replayRunSubmission(task,submission),true);
  assert.equal(result.attemptStatus,'interrupted');assert.equal(result.executionAuthorized,false);
  assert.equal(task.attempts.length,1);assert.equal(task.attempts[0].recovery.state,'unresolved');
  task.attempts.push({...attempt,id:randomUUID()});
  assert.throws(()=>findRunSubmission(task,submission.requestId),{status:409});
});

test('submission metadata is absent from both existing task export modes',()=>{
  const submission=prepareRunSubmission(id,body);
  const task={id,kind:'change',status:'failed',attempts:[{id:randomUUID(),provider:'fixture',status:'failed',submission}]};
  for(const mode of ['minimal','standard']) {
    const text=JSON.stringify(exportTask(task,mode));
    assert.equal(text.includes(submission.requestId),false);assert.equal(text.includes(submission.fingerprint),false);
  }
});

test('optional route revision binds replay identity without changing legacy fingerprints',()=>{
  const old=prepareRunSubmission(id,body);
  const expected=createHash('sha256').update(JSON.stringify([id,body.version,body.sourceHash,
    'fixture','fixture','fixture',null,null])).digest('hex');
  assert.equal(old.fingerprint,expected);
  const bound=prepareRunSubmission(id,{...body,routeRevision:'c'.repeat(64)});
  assert.notEqual(bound.fingerprint,old.fingerprint);
  assert.notEqual(bound.fingerprint,prepareRunSubmission(id,{...body,routeRevision:'d'.repeat(64)}).fingerprint);
  const task={attempts:[{submission:bound}]};
  assert.throws(()=>replayRunSubmission(task,old),{status:409});
  for(const value of [null,undefined,123,'bad','A'.repeat(64),{},[]]) {
    assert.throws(()=>prepareRunSubmission(id,{...body,routeRevision:value}),{status:400});
    assert.throws(()=>prepareRunSubmission(id,{routeRevision:value}),{status:400});
  }
});
