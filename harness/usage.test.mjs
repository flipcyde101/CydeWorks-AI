import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeUsage,describeStepReceipt} from './web/usage.js';

test('usage coverage includes failed attempts and keeps unavailable values unknown',()=>{
  const summary=summarizeUsage([
    {status:'failed',provider:'fixture',elapsedMs:100,usage:null},
    {status:'accepted',elapsedMs:200,usage:{evidence:'OpenCode reported'}},
    {status:'cancelled',provider:'fixture',usage:null},
    {status:'running',usage:null},
  ]);
  assert.equal(summary.attempts,4);
  assert.equal(summary.finished,3);
  assert.equal(summary.active,1);
  assert.equal(summary.unresolved,0);
  assert.equal(summary.timed,2);
  assert.equal(summary.totalElapsedMs,300);
  assert.equal(summary.observed,1);
  assert.equal(summary.reported,0);
  assert.equal(summary.missing,3);
  assert.equal(summary.pending,1);
  assert.deepEqual(summary.groups.opencode.counters.input,{value:null,reported:0,partial:0,attempts:1});
  const unavailable=summarizeUsage([{status:'failed',elapsedMs:null,usage:null}]);
  assert.equal(unavailable.totalElapsedMs,null);
  assert.equal(unavailable.missing,1);
});

test('unresolved provider outcomes are not labeled finished, and active receipts are pending',()=>{
  const result=summarizeUsage([
    {status:'interrupted',provider:'opencode',recovery:{state:'unresolved'},elapsedMs:30},
    {status:'cancelled',provider:'ollama',execution:{phase:'dispatching'},elapsedMs:60},
    {status:'failed',provider:'ollama',execution:{phase:'settled'},elapsedMs:90},
    {status:'running',provider:'ollama'},
  ]);
  assert.equal(result.unresolved,2);
  assert.equal(result.finished,1);
  assert.equal(result.active,1);
  assert.equal(result.missing,3);
  assert.equal(result.pending,1);
  assert.equal(result.totalElapsedMs,180);
});

test('token totals separate provider and OpenCode semantics, including failed attempts',()=>{
  const result=summarizeUsage([
    {status:'failed',usage:{evidence:'provider reported',input:7,output:3,cached:2,reasoning:null}},
    {status:'accepted',usage:{evidence:'OpenCode reported',input:13,output:8,cached:1,reasoning:4}},
    {status:'cancelled',usage:null},
    {status:'accepted',usage:{evidence:'synthetic',input:999,output:999}},
  ]);
  assert.deepEqual(result.groups.provider.counters.input,{value:7,reported:1,partial:0,attempts:1});
  assert.deepEqual(result.groups.provider.counters.output,{value:3,reported:1,partial:0,attempts:1});
  assert.deepEqual(result.groups.opencode.counters.input,{value:13,reported:1,partial:1,attempts:1});
  assert.deepEqual(result.groups.opencode.counters.cached,{value:1,reported:1,partial:1,attempts:1});
  assert.deepEqual(result.groups.opencode.counters.reasoning,{value:4,reported:1,partial:1,attempts:1});
});

test('bad values and unsafe token totals remain unavailable instead of being rounded',()=>{
  const result=summarizeUsage([
    {status:'failed',usage:{evidence:'provider reported',input:-1,output:1.2}},
    {status:'accepted',usage:{evidence:'provider reported',input:Number.MAX_SAFE_INTEGER,output:null}},
    {status:'accepted',usage:{evidence:'provider reported',input:1}},
  ]);
  assert.equal(result.groups.provider.counters.input.value,null);
  assert.equal(result.groups.provider.counters.input.overflow,true);
  assert.equal(result.groups.provider.counters.output.value,null);
  assert.equal(result.groups.provider.counters.output.reported,0);
});

test('step receipt presentation distinguishes missing identity, conflicts and truncation',()=>{
  const result=describeStepReceipt({evidence:'OpenCode reported',steps:{
    items:[{input:8,output:2,cached:null,reasoning:-1}],duplicates:2,unidentified:true,
    identityAmbiguous:true,conflict:true,truncated:true,
  }});
  assert.deepEqual(result.items,[{input:8,output:2,cached:null,cacheWrite:null,reasoning:null}]);
  assert.match(result.notes.join(' '),/repeated event\(s\) were ignored/i);
  assert.match(result.notes.join(' '),/totals are unavailable/i);
  assert.match(result.notes.join(' '),/64-step limit/i);
  assert.equal(describeStepReceipt({evidence:'provider reported',steps:{items:[{}]}}),null);
  assert.equal(describeStepReceipt({evidence:'OpenCode reported'}),null);
});
