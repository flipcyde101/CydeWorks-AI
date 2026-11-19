import test from 'node:test';
import assert from 'node:assert/strict';
import {inspect} from 'node:util';
import {EXPORT_CONTRACT,RECEIPT_CONTRACT,RECEIPT_SCHEMA_VERSION,validateReceipt,validateReceiptExport} from './receipt-contract.mjs';
import {exportReceipt} from './receipt-export.mjs';
import {clone,deepFreeze,draft,scenarios} from './test-support/receipt-synthetic.mjs';

const cost=()=>({amountMicros:100,currency:'USD',evidence:'estimated',complete:true});
const attempt=(overrides={})=>({attemptId:'a1',provider:'p',model:'m',status:'succeeded',outcomeKnown:true,
  startedAtMs:0,endedAtMs:1000,cost:cost(),...overrides});
const receipt=(overrides={})=>({schemaVersion:1,runId:'r1',taskKey:'t1',inputRevision:'rev1',accepted:true,
  attemptsComplete:true,attempts:[attempt()],...overrides});
const rejected=(value,code)=>{
  const result=validateReceipt(value);
  assert.equal(result.ok,false,inspect(value,{depth:3}));
  assert.ok(result.issues.length>0&&result.issues.every(item=>typeof item.path==='string'&&typeof item.code==='string'&&typeof item.message==='string'));
  if(code)assert.ok(result.issues.some(item=>item.code===code),code+' expected, saw '+result.issues.map(item=>item.code));
  return result.issues;
};

test('the contract is versioned, frozen and accepts the documented shape',()=>{
  assert.equal(RECEIPT_SCHEMA_VERSION,1);
  assert.ok(Object.isFrozen(RECEIPT_CONTRACT)&&Object.isFrozen(RECEIPT_CONTRACT.keys.attempts.items.keys));
  assert.ok(Object.isFrozen(EXPORT_CONTRACT.available.keys.evidence));
  const value=deepFreeze(receipt({attempts:[attempt(),attempt({attemptId:'a2',status:'running',outcomeKnown:false,
    startedAtMs:null,endedAtMs:null,cost:null})]}));
  const result=validateReceipt(value);
  assert.equal(result.ok,true);
  assert.equal(result.run,value);
  assert.equal(validateReceipt(receipt({attempts:[]})).ok,true);
  assert.equal(validateReceipt(receipt({attempts:[attempt({cost:{...cost(),amountMicros:0}})]})).ok,true);
  assert.equal(validateReceipt(Object.assign(Object.create(null),receipt())).ok,true);
});

test('every malformed value is rejected with structured issues and without throwing',()=>{
  for(const value of [null,undefined,42,'run',[],true,()=>{},Symbol('run'),1n])rejected(value);
  rejected(receipt({schemaVersion:2}),'unsupported-value');
  rejected(receipt({schemaVersion:'1'}),'unsupported-value');
  // An omitted version and an explicit undefined are both refused, each with
  // its own code. Neither is accepted as version 1.
  const {schemaVersion,...omitted}=receipt();
  assert.deepEqual(rejected(omitted).map(item=>[item.path,item.code]),[['$.schemaVersion','missing-property']]);
  assert.deepEqual(rejected(receipt({schemaVersion:undefined})).map(item=>[item.path,item.code]),[['$.schemaVersion','invalid-property']]);
  for(const overrides of [{runId:''},{taskKey:'   '},{inputRevision:5},{runId:'x'.repeat(201)},{runId:'line\nbreak'},
    {accepted:'yes'},{attemptsComplete:1},{attempts:'nope'},{attempts:[null]},{attempts:{length:0}}])rejected(receipt(overrides));
  for(const overrides of [{status:'exploded'},{status:'review'},{outcomeKnown:'true'},{startedAtMs:-1},{endedAtMs:1.5},
    {startedAtMs:Number.MAX_SAFE_INTEGER+1},{startedAtMs:NaN},{startedAtMs:1n},{startedAtMs:'0'},{provider:''},
    {model:'x'.repeat(121)},{cost:undefined},{cost:5},{cost:[]},{cost:{...cost(),amountMicros:-1}},
    {cost:{...cost(),amountMicros:Number.MAX_SAFE_INTEGER+1}},{cost:{...cost(),currency:'usd'}},
    {cost:{...cost(),currency:'USDD'}},{cost:{...cost(),evidence:'guessed'}},{cost:{...cost(),complete:'yes'}},
    {cost:{amountMicros:1,currency:'USD',evidence:'estimated'}}])rejected(receipt({attempts:[attempt(overrides)]}));
  rejected(receipt({attempts:[attempt({startedAtMs:5000,endedAtMs:4000})]}),'end-before-start');
  rejected(receipt({attempts:[attempt(),attempt()]}),'duplicate-attempt-id');
});

test('closed shapes: undocumented properties, accessors, class instances and sparse lists are refused',()=>{
  rejected(receipt({note:'extra'}),'unknown-property');
  rejected(receipt({attempts:[attempt({tokens:{input:5}})]}),'unknown-property');
  rejected(receipt({attempts:[attempt({cost:{...cost(),note:'extra'}})]}),'unknown-property');
  const leaked=rejected(receipt({['SECRET_PROPERTY_NAME']:'SECRET_VALUE'}),'unknown-property');
  assert.doesNotMatch(JSON.stringify(leaked),/SECRET/);
  const symbolic=receipt();
  symbolic[Symbol('hidden')]=1;
  rejected(symbolic,'unknown-property');
  const accessor=receipt();
  let ran=false;
  Object.defineProperty(accessor,'runId',{enumerable:true,get(){ran=true;return 'r1';}});
  rejected(accessor,'invalid-property');
  assert.equal(ran,false);
  class Fancy {}
  rejected(Object.assign(new Fancy(),receipt()),'invalid-object');
  const sparse=receipt({attempts:[attempt()]});
  sparse.attempts.length=3;
  rejected(sparse,'invalid-array');
  const decorated=receipt();
  decorated.attempts.note='extra';
  rejected(decorated,'invalid-array');
  rejected(receipt({attempts:Array.from({length:1001},(_,index)=>attempt({attemptId:'a'+index}))}),'too-many-items');
});

test('deeply nested and very wide input is refused without exhausting the stack or the issue list',()=>{
  let pit=[];
  const top=pit;
  for(let depth=0;depth<20000;depth++) {const next=[];pit.push(next);pit=next;}
  rejected(receipt({attempts:[attempt({cost:top})]}),'invalid-object');
  rejected(receipt({runId:top}),'invalid-string');
  const noisy=rejected(receipt({attempts:Array.from({length:900},()=>({}))}));
  assert.equal(noisy.length,50);
});

test('the export envelope is closed and must keep evidence aligned with the run',()=>{
  const built=exportReceipt(scenarios().failedThenAccepted);
  assert.equal(validateReceiptExport(deepFreeze(clone(built))).ok,true);
  const refused=exportReceipt(draft());
  assert.equal(validateReceiptExport(refused).ok,true);
  const invalid=(change,code)=>{
    const copy=clone(built);
    change(copy);
    const result=validateReceiptExport(copy);
    assert.equal(result.ok,false);
    if(code)assert.ok(result.issues.some(item=>item.code===code),code+' expected, saw '+result.issues.map(item=>item.code));
  };
  invalid(copy=>{copy.evidence.attempts[0].problem='text';},'unknown-property');
  invalid(copy=>{copy.evidence.attempts[0].usage.providerCharge=0;},'unknown-property');
  invalid(copy=>{copy.run.attempts[0].tokens=5;},'unknown-property');
  invalid(copy=>{copy.exportedAt='2026-11-16';},'unknown-property');
  invalid(copy=>{copy.evidence.attempts.reverse();},'evidence-misaligned');
  invalid(copy=>{copy.evidence.attempts.pop();},'evidence-misaligned');
  invalid(copy=>{copy.run.attempts[1].attemptId=copy.run.attempts[0].attemptId;},'duplicate-attempt-id');
  invalid(copy=>{copy.evidence.attempts[0].outcomeBasis='trust-me';},'invalid-enum');
  invalid(copy=>{copy.format='other';},'unsupported-value');
  invalid(copy=>{copy.formatVersion=99;},'unsupported-value');
  invalid(copy=>{copy.limits.push('x'.repeat(401));},'invalid-string');
  invalid(copy=>{copy.available='yes';},'invalid-boolean');
  invalid(copy=>{copy.available=false;});
  const unknownReason=clone(refused);
  unknownReason.reasons[0].code='because';
  assert.equal(validateReceiptExport(unknownReason).ok,false);
  for(const value of [null,undefined,[],'export',5])assert.equal(validateReceiptExport(value).ok,false);
});
