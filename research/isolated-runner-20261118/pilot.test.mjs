import assert from 'node:assert/strict';
import test from 'node:test';
import {validateProposal, verifyBoundary} from './pilot.mjs';

const original = {'limits.py': 'old limits\n', 'measurement.py': 'old measurement\n'};
const changed = {'limits.py': 'new limits\n', 'measurement.py': 'new measurement\n'};

test('a bounded proposal preserves the exact approved filenames and content', () => {
  assert.deepEqual(validateProposal(JSON.stringify(changed), original), changed);
  const fenced = '```json\n' + JSON.stringify(changed) + '\n```';
  assert.deepEqual(validateProposal(fenced, original), changed);
});

test('a missing, extra, identical or invalid replacement is held', () => {
  for (const payload of [null, [], {'limits.py': 'only'}, {...changed, '../outside.py': 'extra'},
    {...changed, 'limits.py': original['limits.py']}, {...changed, 'limits.py': 'bad\0source'},
    {...changed, 'limits.py': 'x'.repeat(8193)}]) {
    assert.throws(() => validateProposal(JSON.stringify(payload), original));
  }
});

test('a missing or failed boundary check cannot qualify a run', () => {
  assert.throws(() => verifyBoundary({approvedBaseReadOnly: true}));
  assert.throws(() => verifyBoundary({parentLoopbackDenied: false}));
});
