/**
 * Disconnected unit and integration test suite for opencode-stop-wsl.mjs.
 *
 * Security test limit note:
 * Execute only inside an OS-enforced sandbox with no external network,
 * empty allowlisted environment, read-only target and toolchain mounts,
 * scratch-only writes, and strict resource and time limits. Do not run on
 * an unsandboxed Windows host.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {claimRun, reconcileClaim, runOwned} from './runner-lifecycle.mjs';
import {
  ACTUAL_OPENCODE_DISPATCH_ENABLED,
  QUALIFICATION_SCOPE,
  SCHEMA,
  canonicalJson,
  createOpenCodeStopWslAdapter,
  digestIdentity,
  validateOwnedIdentity,
} from './opencode-stop-wsl.mjs';

const NONCE_1 = '11111111-2222-4333-8444-555555555555';
const NONCE_2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const BOOT_ID = '01234567-89ab-cdef-0123-456789abcdef';

function makeIdentity(nonce = NONCE_1, overrides = {}) {
  const base = {
    schema: SCHEMA,
    nonce,
    profile: 'inert-fixture',
    bootId: BOOT_ID,
    uid: 65534,
    depth: 1,
    supervisor: {pid: 300, start: '88000', pidNs: 'pid:[4026531836]'},
    bwrap: {pid: 301, start: '88001', pidNs: 'pid:[4026531836]'},
    init: {pid: 302, start: '88002', pidNs: 'pid:[4026532500]'},
    birthIdentity: `${BOOT_ID}:302:88002:pid:[4026532500]`,
    ...overrides,
  };
  return {...base, digest: digestIdentity(base)};
}

function createFakeSpawn({
  onServeFrame,
  onOneshot,
} = {}) {
  const log = {
    serveFrames: [],
    oneshotCalls: [],
  };

  const spawnGuest = mode => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.stdout.end();
      queueMicrotask(() => child.emit('close', 1));
    };

    let inBuf = '';
    child.stdin.on('data', chunk => {
      inBuf += chunk.toString('utf8');
      while (inBuf.includes('\n')) {
        const idx = inBuf.indexOf('\n');
        const line = inBuf.slice(0, idx);
        inBuf = inBuf.slice(idx + 1);
        if (!line.trim()) continue;
        const parsed = JSON.parse(line);
        if (mode === 'serve') {
          log.serveFrames.push(parsed);
          onServeFrame?.(parsed, child, log);
        } else {
          log.oneshotCalls.push({mode, payload: parsed});
          onOneshot?.(mode, parsed, child, log);
        }
      }
    });
    return child;
  };

  return {spawnGuest, log};
}

test('real OpenCode profile is disabled and tagged inert-fixture-only', async () => {
  assert.equal(ACTUAL_OPENCODE_DISPATCH_ENABLED, false);
  assert.equal(QUALIFICATION_SCOPE, 'inert-fixture-only');
  const adapter = createOpenCodeStopWslAdapter({
    profile: 'actual-opencode',
    spawnGuest: () => assert.fail('must not spawn when actual-opencode is disabled'),
  });
  await assert.rejects(
    adapter.start({nonce: NONCE_1, record: () => {}}),
    /actual OpenCode dispatch disabled/,
  );
});

test('durable identity is persisted before dispatch releases the held namespace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-stop-test-'));
  const claimPath = join(dir, 'claim.jsonl');
  const claim = claimRun(claimPath, {fixture: 'opencode-stop'});
  const events = [];

  const {spawnGuest, log} = createFakeSpawn({
    onServeFrame(frame, child) {
      if (frame.op === 'start') {
        events.push('guest-held');
        const id = makeIdentity(frame.nonce);
        const {digest, ...identity} = id;
        child.stdout.write(JSON.stringify({event: 'held', nonce: frame.nonce, identity, digest}) + '\n');
      } else if (frame.op === 'dispatch') {
        events.push('guest-dispatched');
        child.stdout.write(JSON.stringify({event: 'dispatched', nonce: frame.nonce}) + '\n');
      } else if (frame.op === 'stop') {
        events.push('guest-stopped');
        child.stdout.write(
          JSON.stringify({event: 'stopped', nonce: frame.nonce, cleanup: 'verified', evidence: {signalled: ['init']}}) + '\n',
        );
        child.stdout.end();
        queueMicrotask(() => child.emit('close', 0));
      }
    },
    onOneshot(mode, _payload, child) {
      events.push(`oneshot-${mode}`);
      const reply = mode === 'stop'
        ? {event: 'stopped', cleanup: 'verified', evidence: {signalled: []}}
        : {event: 'confirmed', absent: true};
      child.stdout.write(JSON.stringify(reply) + '\n');
      child.stdout.end();
      queueMicrotask(() => child.emit('close', 0));
    },
  });

  const adapter = createOpenCodeStopWslAdapter({spawnGuest});
  try {
    const out = await runOwned({
      claim,
      adapter,
      confirmInferenceSettled: async () => true,
      execute: async worker => {
        events.push('execute-ran');
        const rows = reconcileClaim(claimPath).rows;
        assert.equal(rows.at(-1).state, 'owned');
        assert.equal(rows.at(-1).identity.birthIdentity, worker.birthIdentity);
        assert.equal(worker.qualificationScope, 'inert-fixture-only');
        return 'ok';
      },
    });
    assert.equal(out, 'ok');
    assert.deepEqual(events, [
      'guest-held',
      'guest-dispatched',
      'execute-ran',
      'guest-stopped',
      'oneshot-stop',
      'oneshot-confirm',
    ]);
    assert.equal(log.serveFrames[0].op, 'start');
    assert.equal(log.serveFrames[1].op, 'dispatch');
    assert.equal(log.oneshotCalls.length, 2);
    assert.equal(log.oneshotCalls[0].mode, 'stop');
    assert.equal(log.oneshotCalls[0].payload.expectedNonce, log.serveFrames[0].nonce);
    assert.equal(log.oneshotCalls[1].mode, 'confirm');
    assert.equal(log.oneshotCalls[1].payload.expectedNonce, log.serveFrames[0].nonce);
    assert.equal(reconcileClaim(claimPath).state, 'complete');
  } finally {
    claim.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('failure or abort during record never sends dispatch and stops held namespace', async () => {
  const {spawnGuest, log} = createFakeSpawn({
    onServeFrame(frame, child) {
      if (frame.op === 'start') {
        const id = makeIdentity(frame.nonce);
        const {digest, ...identity} = id;
        child.stdout.write(JSON.stringify({event: 'held', nonce: frame.nonce, identity, digest}) + '\n');
      } else if (frame.op === 'dispatch') {
        assert.fail('dispatch must never be sent when durable record fails');
      } else if (frame.op === 'stop') {
        child.stdout.write(JSON.stringify({event: 'stopped', nonce: frame.nonce, cleanup: 'verified'}) + '\n');
        child.stdout.end();
        queueMicrotask(() => child.emit('close', 0));
      }
    },
    onOneshot(mode, _payload, child) {
      const reply = mode === 'stop'
        ? {event: 'stopped', cleanup: 'verified'}
        : {event: 'confirmed', absent: true};
      child.stdout.write(JSON.stringify(reply) + '\n');
      child.stdout.end();
      queueMicrotask(() => child.emit('close', 0));
    },
  });

  const adapter = createOpenCodeStopWslAdapter({spawnGuest});
  await assert.rejects(
    adapter.start({
      nonce: NONCE_1,
      record: () => {
        throw Error('Disk full while persisting ownership record');
      },
    }),
    /Disk full/,
  );
  assert.equal(log.serveFrames.some(f => f.op === 'dispatch'), false);
  assert.deepEqual(log.oneshotCalls.map(c => c.mode), ['stop', 'confirm']);
  assert.equal(log.oneshotCalls[0].payload.expectedNonce, NONCE_1);
  assert.equal(log.oneshotCalls[1].payload.expectedNonce, NONCE_1);
});

test('stale nonce, forged birthIdentity, and strict identity violations return unknown without Guest call', async () => {
  const {spawnGuest, log} = createFakeSpawn();
  const adapter = createOpenCodeStopWslAdapter({spawnGuest});
  const {digest, ...valid} = makeIdentity(NONCE_1);
  const owned = {...valid, identityDigest: digest};

  // Stale nonce
  const stale = await adapter.stopAndVerify(owned, NONCE_2);
  assert.equal(stale.cleanup, 'unknown');

  // Forged birthIdentity (PID reuse simulation)
  const forged = structuredClone(owned);
  forged.init.start = '99999';
  assert.equal(validateOwnedIdentity(forged, NONCE_1), false);
  const forgedRes = await adapter.stopAndVerify(forged, NONCE_1);
  assert.equal(forgedRes.cleanup, 'unknown');

  // Non-private PID namespace
  const sharedNs = structuredClone(owned);
  sharedNs.init.pidNs = sharedNs.bwrap.pidNs;
  sharedNs.birthIdentity = `${BOOT_ID}:302:88002:${sharedNs.init.pidNs}`;
  assert.equal(validateOwnedIdentity(sharedNs, NONCE_1), false);
  const sharedRes = await adapter.stopAndVerify(sharedNs, NONCE_1);
  assert.equal(sharedRes.cleanup, 'unknown');

  // Strict Windows validation checks: malformed pidNs, colliding pid, non-numeric start, negative uid, bad profile/bootId
  const badPidNs = structuredClone(owned);
  badPidNs.init.pidNs = 'pid:[not-a-number';
  badPidNs.birthIdentity = `${BOOT_ID}:302:88002:${badPidNs.init.pidNs}`;
  assert.equal(validateOwnedIdentity(badPidNs, NONCE_1), false);

  const collidingPid = structuredClone(owned);
  collidingPid.init.pid = collidingPid.bwrap.pid;
  collidingPid.birthIdentity = `${BOOT_ID}:${collidingPid.init.pid}:88002:${collidingPid.init.pidNs}`;
  assert.equal(validateOwnedIdentity(collidingPid, NONCE_1), false);

  const nonNumericStart = structuredClone(owned);
  nonNumericStart.init.start = '88002abc';
  nonNumericStart.birthIdentity = `${BOOT_ID}:302:88002abc:${nonNumericStart.init.pidNs}`;
  assert.equal(validateOwnedIdentity(nonNumericStart, NONCE_1), false);

  const negativeUid = structuredClone(owned);
  negativeUid.uid = -1;
  assert.equal(validateOwnedIdentity(negativeUid, NONCE_1), false);

  const badProfile = structuredClone(owned);
  badProfile.profile = 'untrusted-profile';
  assert.equal(validateOwnedIdentity(badProfile, NONCE_1), false);

  const badBoot = structuredClone(owned);
  badBoot.bootId = 'bad boot id!';
  badBoot.birthIdentity = `${badBoot.bootId}:302:88002:${badBoot.init.pidNs}`;
  assert.equal(validateOwnedIdentity(badBoot, NONCE_1), false);

  // Tampered identityDigest
  const tampered = {...owned, identityDigest: '0'.repeat(64)};
  const tamperedRes = await adapter.stopAndVerify(tampered, NONCE_1);
  assert.equal(tamperedRes.cleanup, 'unknown');
  const tamperedConfirm = await adapter.confirmAbsent(tampered, NONCE_1);
  assert.equal(tamperedConfirm.absent, false);
  assert.equal(tamperedConfirm.reason, 'identity-digest-mismatch');

  assert.equal(log.oneshotCalls.length, 0);
});

test('repeated Stop is idempotent and ambiguous cleanup leaves claim unresolved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-stop-test-'));
  try {
    let stopResult = {event: 'stopped', cleanup: 'verified', evidence: {signalled: []}};
    const {spawnGuest} = createFakeSpawn({
      onServeFrame(frame, child) {
        if (frame.op === 'start') {
          const {digest, ...identity} = makeIdentity(frame.nonce);
          child.stdout.write(JSON.stringify({event: 'held', nonce: frame.nonce, identity, digest}) + '\n');
        } else if (frame.op === 'dispatch') {
          child.stdout.write(JSON.stringify({event: 'dispatched', nonce: frame.nonce}) + '\n');
        } else if (frame.op === 'stop') {
          child.stdout.write(JSON.stringify({...stopResult, nonce: frame.nonce}) + '\n');
          child.stdout.end();
          queueMicrotask(() => child.emit('close', 0));
        }
      },
      onOneshot(mode, _payload, child) {
        const reply = mode === 'stop'
          ? stopResult
          : {event: 'confirmed', absent: stopResult.cleanup === 'verified'};
        child.stdout.write(JSON.stringify(reply) + '\n');
        child.stdout.end();
        queueMicrotask(() => child.emit('close', 0));
      },
    });

    const adapter = createOpenCodeStopWslAdapter({spawnGuest});
    let savedIdentity;
    await adapter.start({
      nonce: NONCE_1,
      record: id => {
        savedIdentity = id;
      },
    });

    const firstStop = await adapter.stopAndVerify(savedIdentity, NONCE_1);
    assert.equal(firstStop.cleanup, 'verified');
    assert.equal(firstStop.evidence.confirmedAbsent, true);
    const secondStop = await adapter.stopAndVerify(savedIdentity, NONCE_1);
    assert.equal(secondStop.cleanup, 'verified');

    // Now test ambiguous cleanup inside runOwned
    stopResult = {event: 'stopped', cleanup: 'unknown', evidence: {remaining: [302]}};
    const claimPath = join(dir, 'ambiguous.jsonl');
    const claim = claimRun(claimPath, {fixture: 'ambiguous'});
    try {
      await assert.rejects(
        runOwned({
          claim,
          adapter,
          confirmInferenceSettled: async () => true,
          execute: async () => 'done',
        }),
        /unresolved/,
      );
      const reconciled = reconcileClaim(claimPath);
      assert.equal(reconciled.state, 'unresolved');
      assert.equal(reconciled.rows.at(-1).cleanup, 'unknown');
    } finally {
      claim.close();
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('concurrent stopAndVerify calls coalesce single-flight and independent confirm failure returns unknown', async () => {
  let confirmAbsentResult = true;
  let releaseSessionStop = null;
  const {spawnGuest, log} = createFakeSpawn({
    onServeFrame(frame, child) {
      if (frame.op === 'start') {
        const {digest, ...identity} = makeIdentity(frame.nonce);
        child.stdout.write(JSON.stringify({event: 'held', nonce: frame.nonce, identity, digest}) + '\n');
      } else if (frame.op === 'dispatch') {
        child.stdout.write(JSON.stringify({event: 'dispatched', nonce: frame.nonce}) + '\n');
      } else if (frame.op === 'stop') {
        releaseSessionStop = () => {
          child.stdout.write(
            JSON.stringify({event: 'stopped', nonce: frame.nonce, cleanup: 'verified', evidence: {signalled: ['init']}}) + '\n',
          );
          child.stdout.end();
          queueMicrotask(() => child.emit('close', 0));
        };
      }
    },
    onOneshot(mode, payload, child) {
      assert.equal(payload.expectedNonce, NONCE_1);
      const reply = mode === 'stop'
        ? {event: 'stopped', cleanup: 'verified', evidence: {signalled: []}}
        : confirmAbsentResult
          ? {event: 'confirmed', absent: true}
          : {event: 'confirmed', absent: false, remaining: [302]};
      child.stdout.write(JSON.stringify(reply) + '\n');
      child.stdout.end();
      queueMicrotask(() => child.emit('close', 0));
    },
  });

  const adapter = createOpenCodeStopWslAdapter({spawnGuest});
  let savedIdentity;
  await adapter.start({
    nonce: NONCE_1,
    record: id => {
      savedIdentity = id;
    },
  });

  const differentBirth = {
    ...savedIdentity,
    identityDigest: undefined,
    init: {...savedIdentity.init, start: '999999'},
  };
  differentBirth.birthIdentity = `${differentBirth.bootId}:${differentBirth.init.pid}:${differentBirth.init.start}:${differentBirth.init.pidNs}`;
  assert.equal((await adapter.stopAndVerify(differentBirth)).reason, 'session-identity-mismatch');
  assert.equal(log.serveFrames.filter(f => f.op === 'stop').length, 0);
  assert.equal(log.oneshotCalls.length, 0);

  // Launch two concurrent Stop calls while the in-session Stop is still pending.
  const p1 = adapter.stopAndVerify(savedIdentity, NONCE_1);
  const p2 = adapter.stopAndVerify(savedIdentity, NONCE_1);
  // A stale concurrent call must return unknown immediately without joining the valid flight.
  const staleRes = await adapter.stopAndVerify(savedIdentity, NONCE_2);
  assert.equal(staleRes.cleanup, 'unknown');

  assert.equal(typeof releaseSessionStop, 'function');
  releaseSessionStop();

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.cleanup, 'verified');
  assert.equal(r2.cleanup, 'verified');
  assert.equal(r1.evidence.confirmedAbsent, true);
  assert.equal(log.serveFrames.filter(f => f.op === 'stop').length, 1);
  assert.deepEqual(log.oneshotCalls.map(c => c.mode), ['stop', 'confirm']);

  // If out-of-band stop reports verified but independent confirm reports a survivor, result must be unknown.
  confirmAbsentResult = false;
  const failConfirm = await adapter.stopAndVerify(savedIdentity, NONCE_1);
  assert.equal(failConfirm.cleanup, 'unknown');
  assert.deepEqual(log.oneshotCalls.map(c => c.mode), ['stop', 'confirm', 'stop', 'confirm']);
});

test('canonicalJson and digestIdentity match Python canonical sha256', () => {
  const {digest, ...identity} = makeIdentity(NONCE_1);
  const parsed = JSON.parse(canonicalJson(identity));
  assert.equal(digestIdentity(parsed), digest);
});
