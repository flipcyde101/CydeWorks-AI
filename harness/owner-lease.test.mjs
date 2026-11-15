import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerLease} from './owner-lease.mjs';

test('a late queued heartbeat cannot revive an expired desktop owner lease',()=>{
  let now=0;
  const lease=createOwnerLease(15,()=>now);
  now=14;
  assert.equal(lease.renew(),true);
  now=28;
  assert.equal(lease.expired(),false);
  now=29;
  assert.equal(lease.expired(),true);
  assert.equal(lease.renew(),false);
});
