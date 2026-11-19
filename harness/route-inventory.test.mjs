import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRouteInventory,ROUTE_INVENTORY_TTL_MS} from './route-inventory.mjs';

const stamp=1794844800000;
const row=()=>({id:'qwen3:1.7b',engine:'opencode',backend:'ollama',endpoint:'http://127.0.0.1:11434',
  digest:'a'.repeat(64),bytes:1000,quantization:'Q4_K_M',remote:false,cloudDisabled:true,
  readiness:{eligible:true,reason:'The memory threshold is met.'}});

test('route revisions ignore order, labels and time but not route membership',()=>{
  const a=row(),b={...row(),engine:'ollama'},original=structuredClone([a,b]);
  Object.freeze(a.readiness);Object.freeze(a);Object.freeze(b);Object.freeze(original);
  const first=buildRouteInventory([a,b],{observedAtMs:stamp});
  const second=buildRouteInventory([{...b,label:'New display label'},a],{observedAtMs:stamp+5});
  assert.equal(first.revision,second.revision);
  assert.equal(first.models[0].revision,second.models[1].revision);
  assert.notEqual(first.models[0].revision,first.models[1].revision);
  assert.notEqual(first.revision,buildRouteInventory([a],{observedAtMs:stamp}).revision);
  assert.notEqual(first.revision,buildRouteInventory([a,b,a],{observedAtMs:stamp}).revision);
  assert.deepEqual([a,b],original);
  assert.equal(a.revision,undefined);
});

test('every current material route fact changes its revision',()=>{
  const base=row(),before=buildRouteInventory([base],{observedAtMs:stamp});
  for(const patch of [{id:'other'},{engine:'ollama'},{backend:'llamacpp'},
    {endpoint:'http://127.0.0.1:11435'},{digest:'b'.repeat(64)},{fingerprint:'c'.repeat(64)},
    {bytes:1001},{quantization:'Q3_K_M'},{remote:true},{remote:null},{cloudDisabled:false},
    {readiness:{eligible:false,reason:'Held'}},{readiness:{eligible:true,reason:'Different conditions'}}]) {
    const next=buildRouteInventory([{...base,...patch}],{observedAtMs:stamp});
    assert.notEqual(next.revision,before.revision,JSON.stringify(patch));
    assert.notEqual(next.models[0].revision,before.models[0].revision);
  }
});

test('equivalent implicit backend stays stable and expiry does not grant execution',()=>{
  const explicit=row(),implicit={...explicit};delete implicit.backend;
  const first=buildRouteInventory([explicit],{observedAtMs:stamp});
  const later=buildRouteInventory([implicit],{observedAtMs:stamp+ROUTE_INVENTORY_TTL_MS});
  assert.equal(first.revision,later.revision);
  assert.equal(Date.parse(first.expiresAt)-Date.parse(first.observedAt),30000);
  assert.equal(Date.parse(later.observedAt),Date.parse(first.expiresAt));
  assert.equal(first.executionAuthorized,false);
  assert.equal(first.revisionKind,'route-facts-sha256-v1');
  assert.match(first.revision,/^[a-f0-9]{64}$/);
});

test('empty inventory is explicit and malformed internal inventory fails',()=>{
  const empty=buildRouteInventory([],{observedAtMs:stamp});
  assert.equal(empty.models.length,0);assert.equal(empty.executionAuthorized,false);
  assert.notEqual(empty.revision,buildRouteInventory([row()],{observedAtMs:stamp}).revision);
  for(const value of [null,{},[null],[[]]])assert.throws(()=>buildRouteInventory(value),/Invalid host route inventory/);
  for(const observedAtMs of [-1,NaN,Infinity,1.5,'123',8640000000000000])
    assert.throws(()=>buildRouteInventory([],{observedAtMs}),/Invalid host route inventory/);
});
