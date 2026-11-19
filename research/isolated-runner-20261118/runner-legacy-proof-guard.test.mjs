import test from 'node:test';
import assert from 'node:assert/strict';
import {bindCheckedPatch, digest} from './runner-lifecycle.mjs';

test('legacy patch binder rejects caller-forged verification and does not inspect inputs', () => {
  const files = {'example.txt': 'untrusted candidate'};
  const forged = {
    files,
    patch: 'untrusted patch',
    verification: {trusted: true, passed: true, candidateSha256: digest(files)},
  };
  assert.throws(() => bindCheckedPatch(forged), /Legacy patch binding is disabled/);
  assert.throws(() => bindCheckedPatch(new Proxy({}, {
    get() { throw Error('untrusted getter was read'); },
  })), /Legacy patch binding is disabled/);
  assert.throws(() => bindCheckedPatch(), /Legacy patch binding is disabled/);
});
