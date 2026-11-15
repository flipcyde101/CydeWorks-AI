import test from 'node:test';
import assert from 'node:assert/strict';
import {previewRemoval,verifyRemoval} from './removal.mjs';

const key='a'.repeat(64),now=1000000;
const task=()=>({id:'11111111-1111-4111-8111-111111111111',version:3,status:'accepted',
  title:'PRIVATE_NAME',source:'PRIVATE_SOURCE',attempts:[{provider:'fixture',status:'accepted',execution:{phase:'settled'}}]});

test('task removal requires the exact current preview, typed confirmation and an unexpired session',()=>{
  const item=task();
  const preview=previewRemoval(item,{secret:key,now,active:false});
  assert.equal(preview.allowed,true);
  assert.equal(preview.title,'PRIVATE_NAME');
  assert.doesNotMatch(JSON.stringify(preview),/PRIVATE_SOURCE/);
  const approval={version:item.version,expiresAt:preview.expiresAt,token:preview.token,confirmation:'REMOVE'};
  assert.equal(verifyRemoval(item,approval,{secret:key,now:now+1,active:false}),true);
  assert.throws(()=>verifyRemoval(item,{...approval,confirmation:'yes'},{secret:key,now,active:false}),/confirm/i);
  assert.throws(()=>verifyRemoval({...item,version:4},approval,{secret:key,now,active:false}),/changed/i);
  assert.throws(()=>verifyRemoval(item,{...approval,token:'b'.repeat(64)},{secret:key,now,active:false}),/preview/i);
  assert.throws(()=>verifyRemoval(item,approval,{secret:key,now:preview.expiresAt+1,active:false}),/expired/i);
  assert.throws(()=>verifyRemoval(item,approval,{secret:'c'.repeat(64),now,active:false}),/preview/i);
});

test('active, interrupted or unresolved external attempts cannot be removed',()=>{
  assert.equal(previewRemoval(task(),{secret:key,now,active:true}).allowed,false);
  const missing=task();missing.status='interrupted';missing.attempts=[];
  assert.equal(previewRemoval(missing,{secret:key,now,active:false}).allowed,false);
  for(const attempt of [
    {provider:'opencode',status:'failed',execution:{phase:'dispatching'}},
    {provider:'ollama',status:'interrupted'},
    {provider:'opencode',status:'running',execution:{phase:'claimed'}},
    {provider:'opencode',status:'failed',recovery:{state:'unresolved'}},
  ]) {
    const item=task();item.attempts.push(attempt);
    assert.equal(previewRemoval(item,{secret:key,now,active:false}).allowed,false);
  }
  const safe=task();safe.attempts.push({provider:'opencode',status:'interrupted',execution:{phase:'claimed'},recovery:{state:'retry-safe'}});
  assert.equal(previewRemoval(safe,{secret:key,now,active:false}).allowed,true);
});
