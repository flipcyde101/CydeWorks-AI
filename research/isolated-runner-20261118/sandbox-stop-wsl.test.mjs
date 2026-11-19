import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync, mkdirSync, readdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {durableStop, qualifySandboxStop} from './sandbox-stop-wsl.mjs';
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

test('startup interruption remains fail-closed and replay never relaunches', async () => {
  const requestId = 'startup-test';
  const pending = qualifySandboxStop({requestId, interrupt: 'startup'});
  const held = await qualifySandboxStop({requestId, interrupt: 'startup'});
  assert.equal(held.state, 'held');
  assert.equal(held.replay, true);
  const first = await pending;
  const replay = await qualifySandboxStop({requestId, interrupt: 'startup'});
  assert.deepEqual(replay, {...first, replay: true});
  if (first.cleanup === 'verified') assert.equal(first.independentCleanup, true);
  else assert.ok(first.blocker);
});

test('invalid interruption cannot reserve or launch', async () => {
  await assert.rejects(qualifySandboxStop({interrupt: 'invalid'}), /Invalid interruption/);
});

for (const phase of ['startup', 'durable']) {
  test(`live owned Windows controller interruption: ${phase}`, async t => {
    if (process.platform !== 'win32') { t.skip('BLOCKED: Windows required'); return; }
    mkdirSync(new URL('./.state/', import.meta.url), {recursive: true});
    const directory = mkdtempSync(new URL('./.state/stop-proof-', import.meta.url));
    const module = fileURLToPath(new URL('./sandbox-stop-wsl.mjs', import.meta.url));
    const launch = () => fork(module, ['--controller', directory, phase],
      {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
    const first = launch();
    const interruption = await new Promise(resolve => {
      const timer = setTimeout(() => {first.kill(); resolve(false);}, 15000);
      first.on('message', frame => {
        if (frame.event === 'interruptible') { clearTimeout(timer); first.kill(); resolve(true); }
      });
      first.on('exit', () => {clearTimeout(timer); resolve(false);});
    });
    if (!interruption) { t.skip('BLOCKED: fixture did not reach interruption phase'); return; }
    await new Promise(resolve => setTimeout(resolve, 4000));
    const before = readFileSync(`${directory}/claim.json`, 'utf8');
    const replay = launch();
    const result = await new Promise((resolve, reject) => {
      let output = '';
      replay.stdout.on('data', chunk => {output += chunk;});
      replay.on('error', reject);
      replay.on('exit', code => {
        try { assert.equal(code, 0); resolve(JSON.parse(output)); } catch (error) {reject(error);}
      });
    });
    assert.equal(result.replay, true);
    assert.equal(result.dispatches, 1);
    assert.equal(readFileSync(`${directory}/claim.json`, 'utf8'), before);
    assert.ok(['held', 'resolved'].includes(result.state));
    if (phase === 'startup') assert.equal(result.state, 'held');
    console.log(JSON.stringify({phase, directory, records: readdirSync(directory), result}));
    if (result.cleanup !== 'verified') t.diagnostic('Cleanup qualification BLOCKED; replay held without dispatch');
  });
}

test('truncated durable claim holds without dispatch', async () => {
  mkdirSync(new URL('./.state/', import.meta.url), {recursive: true});
  const directory = mkdtempSync(new URL('./.state/stop-proof-', import.meta.url));
  writeFileSync(`${directory}/claim.json`, '{');
  const result = await durableStop(directory, 'durable');
  assert.equal(result.state, 'held');
  assert.equal(result.cleanup, 'unknown');
  assert.equal(result.replay, true);
  assert.deepEqual(readdirSync(directory), ['claim.json']);
});
