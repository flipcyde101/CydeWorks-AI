import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {qualifySandboxStop} from './sandbox-stop-wsl.mjs';
test('fixture retains pinned isolation and bounded owned cleanup', () => {
  const source = readFileSync(new URL('./sandbox-stop-fixture.py', import.meta.url), 'utf8');
  for (const token of ['ast.literal_eval', 'sha256', '--unshare-all', '--disable-userns', '--die-with-parent', 'os.pidfd_open', 'process.wait(timeout=3)']) assert.ok(source.includes(token));
  assert.ok(!source.includes('exec('));
});
test('Windows qualification reports evidence or concrete blocker', async () => {
  const result = await qualifySandboxStop();
  if (result.cleanup === 'verified') assert.equal(result.journal.event, 'ready');
  else assert.ok(result.blocker);
  console.log(JSON.stringify(result));
});
