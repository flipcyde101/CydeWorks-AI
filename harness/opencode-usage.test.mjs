import test from 'node:test';
import assert from 'node:assert/strict';
import {createStepReceipt,sanitizeOpenCodeUsage} from './opencode-usage.mjs';

const step=(id,input,output,extra={})=>({type:'step_finish',sessionID:'session-1',
  part:{id,sessionID:'session-1',messageID:'message-1',tokens:{input,output,cache:{read:2,write:4},reasoning:1},...extra}});

test('unique OpenCode step receipts are retained and exact replays do not inflate totals',()=>{
  const receipt=createStepReceipt();
  receipt.observe(step('part-1',12,3));
  receipt.observe(step('part-1',12,3));
  receipt.observe(step('part-2',20,5));
  const result=receipt.snapshot();
  assert.equal(result.input,32);
  assert.equal(result.output,8);
  assert.equal(result.cached,4);
  assert.equal(result.cacheWrite,8);
  assert.equal(result.reasoning,2);
  assert.equal(result.steps.items.length,2);
  assert.equal(result.steps.duplicates,1);
  assert.equal(result.steps.conflict,false);
  assert.doesNotMatch(JSON.stringify(result),/session-1|message-1|part-1/);
});

test('changed replays, missing identities and mismatched sessions never create trustworthy totals',()=>{
  const conflict=createStepReceipt();
  conflict.observe(step('part-1',12,3));
  conflict.observe(step('part-1',20,3));
  assert.equal(conflict.snapshot().input,null);
  assert.equal(conflict.snapshot().steps.conflict,true);
  const missing=createStepReceipt();
  missing.observe(step(undefined,4,2));
  missing.observe(step(undefined,5,2));
  assert.equal(missing.snapshot().input,null);
  assert.equal(missing.snapshot().steps.identityAmbiguous,true);
  const mismatch=createStepReceipt();
  mismatch.observe(step('part-1',4,2,{sessionID:'different'}));
  assert.equal(mismatch.snapshot().input,null);
  mismatch.observe(step('part-2',5,2));
  assert.equal(mismatch.snapshot().input,null);
  assert.equal(mismatch.snapshot().steps.identityAmbiguous,true);
  const mixed=createStepReceipt();
  mixed.observe(step('part-1',4,2));
  const other=step('part-2',5,2,{sessionID:'session-2'});
  other.sessionID='session-2';
  mixed.observe(other);
  assert.equal(mixed.snapshot().input,null);
  assert.equal(mixed.snapshot().steps.identityAmbiguous,true);
  const reassigned=createStepReceipt();
  reassigned.observe(step('same-part',2,1));
  reassigned.observe(step('same-part',2,1,{messageID:'message-2'}));
  assert.equal(reassigned.snapshot().input,null);
  assert.equal(reassigned.snapshot().steps.conflict,true);
  const changedReason=createStepReceipt();
  changedReason.observe(step('part-1',2,1,{reason:'stop'}));
  changedReason.observe(step('part-1',2,1,{reason:'length'}));
  assert.equal(changedReason.snapshot().steps.conflict,true);
});

test('a single legacy step remains useful but missing fields, overflow and limits stay unknown',()=>{
  const legacy=createStepReceipt();
  legacy.observe({type:'step_finish',part:{tokens:{input:7,output:3}}});
  assert.equal(legacy.snapshot().input,7);
  assert.equal(legacy.snapshot().cached,null);
  assert.equal(legacy.snapshot().steps.unidentified,true);
  const missing=createStepReceipt();
  missing.observe(step('part-1',4,2));
  missing.observe(step('part-2',null,3));
  assert.equal(missing.snapshot().input,null);
  assert.equal(missing.snapshot().output,5);
  const overflow=createStepReceipt();
  overflow.observe(step('part-1',Number.MAX_SAFE_INTEGER,2));
  overflow.observe(step('part-2',1,3));
  assert.equal(overflow.snapshot().input,null);
  const limited=createStepReceipt();
  for(let i=0;i<65;i++) limited.observe(step('part-'+i,1,1));
  assert.equal(limited.snapshot().steps.items.length,64);
  assert.equal(limited.snapshot().steps.truncated,true);
  assert.equal(limited.snapshot().input,null);
});

test('partial receipt sanitizer drops arbitrary fields and recomputes totals',()=>{
  const receipt=createStepReceipt();
  receipt.observe(step('part-1',7,3));
  const source=receipt.snapshot();
  source.input=999;
  source.steps.items[0].privateContent='PRIVATE_SENTINEL';
  source.privateContent='PRIVATE_SENTINEL';
  const safe=sanitizeOpenCodeUsage(source);
  assert.equal(safe.input,7);
  assert.doesNotMatch(JSON.stringify(safe),/PRIVATE_SENTINEL/);
  assert.equal(sanitizeOpenCodeUsage({evidence:'synthetic',input:3}),null);
});
