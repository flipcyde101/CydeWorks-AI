import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNTHETIC_BASELINE_DIGESTS,
  SYNTHETIC_BASELINE_FILES,
  SYNTHETIC_BASELINE_HASH,
  SYNTHETIC_BOUNDS,
  SYNTHETIC_FIXTURE_ID,
  SYNTHETIC_LIMITS,
  SYNTHETIC_MULTI_FILE_PATCH,
  SYNTHETIC_PATCH_SHA256,
  SYNTHETIC_REPLACEMENT_DIGESTS,
  SYNTHETIC_REPLACEMENT_FILES,
  SYNTHETIC_ROUTE,
  SYNTHETIC_SNAPSHOT_REF,
  SyntheticRunnerError,
  createSyntheticRunnerFixture,
} from './synthetic-runner-fixture.mjs';

function makeStartArgs(overrides = {}) {
  return {
    claimId: 'claim-1',
    attemptId: 'attempt-1',
    grantId: 'grant-1',
    snapshotRef: SYNTHETIC_SNAPSHOT_REF,
    route: 'fixture',
    deadlineAt: 1000,
    ...overrides,
  };
}

test('pinned synthetic multi-file fixtures and route metadata are frozen and explicitly synthetic', () => {
  assert.equal(SYNTHETIC_FIXTURE_ID, 'synthetic-runner-fixture-v1');
  assert.equal(Object.isFrozen(SYNTHETIC_BASELINE_FILES), true);
  assert.equal(Object.isFrozen(SYNTHETIC_REPLACEMENT_FILES), true);
  assert.equal(Object.isFrozen(SYNTHETIC_ROUTE), true);
  assert.equal(Object.isFrozen(SYNTHETIC_LIMITS), true);
  assert.deepEqual(Object.keys(SYNTHETIC_BASELINE_FILES), ['limits.py', 'measurement.py']);
  assert.deepEqual(Object.keys(SYNTHETIC_REPLACEMENT_FILES), ['limits.py', 'measurement.py']);
  assert.match(SYNTHETIC_BASELINE_HASH, /^[a-f0-9]{64}$/);
  assert.match(SYNTHETIC_PATCH_SHA256, /^[a-f0-9]{64}$/);
  assert.ok(SYNTHETIC_MULTI_FILE_PATCH.includes('diff --git a/limits.py b/limits.py'));
  assert.ok(SYNTHETIC_MULTI_FILE_PATCH.includes('diff --git a/measurement.py b/measurement.py'));
  assert.ok(SYNTHETIC_LIMITS.length >= 4);

  const runner = createSyntheticRunnerFixture();
  const route = runner.route();
  assert.equal(route.engine, 'fixture');
  assert.equal(route.backend, 'fixture');
  assert.equal(route.model, 'fixture');
  assert.equal(route.endpoint, null);
  assert.equal(route.digest, null);
  assert.equal(route.synthetic, true);
  assert.equal(route.modelRan, false);
  assert.equal(route.readiness.eligible, true);
});

test('explicit ticks advance deterministic sequence-numbered progress and terminal events', () => {
  const runner = createSyntheticRunnerFixture({initialTimeMs: 1000, stepMs: 25});
  const started = runner.start(makeStartArgs({deadlineAt: 2000}));

  assert.equal(started.attemptId, 'attempt-1');
  assert.equal(started.claimId, 'claim-1');
  assert.equal(started.grantId, 'grant-1');
  assert.equal(started.cursor, 1);
  assert.equal(started.generation, 1);
  assert.equal(started.state, 'running');
  assert.equal(started.status, 'running');
  assert.equal(started.synthetic, true);
  assert.equal(started.modelRan, false);
  assert.equal(started.codeExecuted, false);
  assert.equal(started.chargeEvidence, 'unavailable');
  assert.equal(JSON.stringify(started).includes('syn-session-'), false);

  const initialEvents = runner.events({workerId: started.workerId, attemptId: 'attempt-1', afterSequence: 0});
  assert.equal(initialEvents.events.length, 1);
  assert.equal(initialEvents.events[0].sequence, 1);
  assert.equal(initialEvents.events[0].type, 'started');
  assert.equal(initialEvents.events[0].timestampMs, 1000);
  assert.equal(initialEvents.terminal, false);

  const seenEvents = [...initialEvents.events];
  for (let i = 1; i <= 4; i++) {
    const ticked = runner.tick(1);
    assert.equal(ticked.virtualNowMs, 1000 + i * 25);
    const page = runner.events({
      workerId: started.workerId,
      attemptId: 'attempt-1',
      afterSequence: seenEvents.at(-1).sequence,
    });
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0].sequence, i + 1);
    assert.equal(page.events[0].timestampMs, 1000 + i * 25);
    assert.equal(page.events[0].attemptId, 'attempt-1');
    assert.equal(page.events[0].workerId, started.workerId);
    seenEvents.push(page.events[0]);
  }

  assert.deepEqual(seenEvents.map(event => event.sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual(
    seenEvents.map(event => event.type),
    ['started', 'progress', 'progress', 'progress', 'terminal'],
  );
  assert.deepEqual(
    seenEvents.map(event => event.progress.percent),
    [0, 25, 50, 75, 100],
  );
  assert.equal(seenEvents[4].status, 'succeeded');

  const inspected = runner.inspect({workerId: started.workerId, attemptId: 'attempt-1'});
  assert.equal(inspected.state, 'exited');
  assert.equal(inspected.status, 'succeeded');
  assert.equal(inspected.confirmed, true);
  assert.equal(inspected.elapsedMs, 100);
  assert.equal(inspected.cursor, 5);
  assert.equal(inspected.generation, 2);

  // Bounded paged replay from afterSequence: 0
  const page1 = runner.events({workerId: started.workerId, afterSequence: 0, limit: 2});
  assert.deepEqual(page1.events.map(e => e.sequence), [1, 2]);
  assert.equal(page1.cursor, 2);
  assert.equal(page1.hasMore, true);
  const page2 = runner.events({workerId: started.workerId, afterSequence: page1.cursor, limit: 2});
  assert.deepEqual(page2.events.map(e => e.sequence), [3, 4]);
  assert.equal(page2.hasMore, true);
  const page3 = runner.events({workerId: started.workerId, afterSequence: page2.cursor, limit: 2});
  assert.deepEqual(page3.events.map(e => e.sequence), [5]);
  assert.equal(page3.hasMore, false);
  assert.equal(page3.terminal, true);
});

test('injected test clock produces deterministic progression and rejects invalid or backwards clocks', () => {
  let nowMs = 1_763_500_000_000;
  const runner = createSyntheticRunnerFixture({clock: () => nowMs, stepMs: 25});
  const started = runner.start(makeStartArgs({
    deadlineAt: new Date(nowMs + 500).toISOString(),
    route: runner.route(),
    snapshotRef: {
      ref: SYNTHETIC_SNAPSHOT_REF,
      baselineHash: SYNTHETIC_BASELINE_HASH,
      files: SYNTHETIC_BASELINE_FILES,
    },
  }));

  nowMs += 60;
  const midInspect = runner.inspect({workerId: started.workerId});
  assert.equal(midInspect.status, 'running');
  assert.equal(midInspect.progress.completedSteps, 2);
  assert.equal(midInspect.elapsedMs, 60);

  nowMs += 200;
  const doneEvents = runner.events({workerId: started.workerId, afterSequence: 0});
  assert.equal(doneEvents.events.length, 5);
  assert.deepEqual(
    doneEvents.events.map(event => event.timestampMs - started.startedAtMs),
    [0, 25, 50, 75, 100],
  );
  assert.equal(doneEvents.terminal, true);

  // Backwards clock fails closed
  nowMs -= 10;
  assert.throws(
    () => runner.inspect({workerId: started.workerId}),
    error => error instanceof SyntheticRunnerError && error.code === 'INVALID_CLOCK',
  );

  // NaN / negative / throwing clocks fail closed
  for (const badClock of [() => NaN, () => -1, () => 1.5, () => { throw Error('clock failed'); }]) {
    const broken = createSyntheticRunnerFixture({clock: badClock});
    assert.throws(
      () => broken.start(makeStartArgs()),
      error => error instanceof SyntheticRunnerError && error.code === 'INVALID_CLOCK',
    );
  }
});

test('distinct attempts maintain separate worker identities, event logs, and control binding', () => {
  const runner = createSyntheticRunnerFixture({initialTimeMs: 1000, stepMs: 25});
  const a1 = runner.start(makeStartArgs({
    claimId: 'claim-a1',
    attemptId: 'attempt-a1',
    grantId: 'grant-a1',
    deadlineAt: 2000,
  }));
  const a2 = runner.start(makeStartArgs({
    claimId: 'claim-a2',
    attemptId: 'attempt-a2',
    grantId: 'grant-a2',
    deadlineAt: 2000,
  }));

  assert.notEqual(a1.workerId, a2.workerId);
  runner.tick(1);

  // Cross-attempt bindings are rejected
  for (const call of [
    () => runner.events({workerId: a1.workerId, attemptId: 'attempt-a2'}),
    () => runner.inspect({workerId: a1.workerId, attemptId: 'attempt-a2'}),
    () => runner.stop({workerId: a1.workerId, attemptId: 'attempt-a2', confirm: true}),
    () => runner.collect({workerId: a1.workerId, attemptId: 'attempt-a2'}),
  ]) {
    assert.throws(call, error => error instanceof SyntheticRunnerError && error.code === 'ATTEMPT_MISMATCH');
  }

  // Stopping attempt 1 leaves attempt 2 running and completable
  const stopped1 = runner.stop({workerId: a1.workerId, attemptId: 'attempt-a1', confirm: true});
  assert.equal(stopped1.status, 'cancelled');
  assert.equal(runner.inspect({workerId: a2.workerId, attemptId: 'attempt-a2'}).status, 'running');

  runner.tick(3);
  const inspected2 = runner.inspect({workerId: a2.workerId, attemptId: 'attempt-a2'});
  assert.equal(inspected2.status, 'succeeded');
  assert.equal(runner.inspect({workerId: a1.workerId, attemptId: 'attempt-a1'}).status, 'cancelled');
});

test('duplicate and stale starts are rejected without causing a second run', () => {
  const runner = createSyntheticRunnerFixture({initialTimeMs: 1000, stepMs: 25});

  // Stale / expired / excessive deadlines rejected
  for (const badDeadline of [999, 1000, 1000 + SYNTHETIC_BOUNDS.maxDeadlineWindowMs + 1]) {
    assert.throws(
      () => runner.start(makeStartArgs({deadlineAt: badDeadline})),
      error => error instanceof SyntheticRunnerError && error.code === 'STALE_START',
    );
  }
  assert.equal(runner.stats().totalStarted, 0);

  const first = runner.start(makeStartArgs({
    claimId: 'claim-dup',
    attemptId: 'attempt-dup',
    grantId: 'grant-dup',
    requestId: 'req-dup',
    deadlineAt: 2000,
  }));

  // Duplicate attemptId, claimId, grantId, or requestId must not start a second run
  for (const conflict of [
    {attemptId: 'attempt-dup', claimId: 'claim-new', grantId: 'grant-new'},
    {attemptId: 'attempt-new', claimId: 'claim-dup', grantId: 'grant-new'},
    {attemptId: 'attempt-new', claimId: 'claim-new', grantId: 'grant-dup'},
    {attemptId: 'attempt-new', claimId: 'claim-new', grantId: 'grant-new', requestId: 'req-dup'},
  ]) {
    assert.throws(
      () => runner.start(makeStartArgs({...conflict, deadlineAt: 2000})),
      error => error instanceof SyntheticRunnerError && error.code === 'DUPLICATE_START',
    );
  }
  assert.equal(runner.stats().totalStarted, 1);

  // Remains rejected even after run finishes
  runner.tick(4);
  assert.equal(runner.inspect({workerId: first.workerId}).status, 'succeeded');
  assert.throws(
    () => runner.start(makeStartArgs({
      claimId: 'claim-dup',
      attemptId: 'attempt-dup',
      grantId: 'grant-dup',
      deadlineAt: 2000,
    })),
    error => error instanceof SyntheticRunnerError && error.code === 'DUPLICATE_START',
  );
  assert.equal(runner.stats().totalStarted, 1);
});

test('confirmed stop before completion, stale control generations, and terminal replays behave safely', () => {
  const runner = createSyntheticRunnerFixture({initialTimeMs: 500, stepMs: 25});
  const started = runner.start(makeStartArgs({deadlineAt: 1500}));

  runner.tick(2);
  assert.equal(runner.inspect({workerId: started.workerId, generation: 1}).progress.completedSteps, 2);

  // Explicit confirm: false is rejected without stopping the run
  assert.throws(
    () => runner.stop({workerId: started.workerId, attemptId: 'attempt-1', confirm: false}),
    error => error instanceof SyntheticRunnerError && error.code === 'STOP_NOT_CONFIRMED',
  );
  assert.equal(runner.inspect({workerId: started.workerId}).status, 'running');

  // Stale generation is rejected
  assert.throws(
    () => runner.stop({workerId: started.workerId, generation: 0, confirm: true}),
    error => error instanceof SyntheticRunnerError && error.code === 'STALE_CONTROL',
  );

  // Confirmed stop succeeds
  const stopped = runner.stop({workerId: started.workerId, attemptId: 'attempt-1', generation: 1, confirm: true});
  assert.equal(stopped.state, 'exited');
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.confirmed, true);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.alreadyTerminal, false);
  assert.equal(stopped.generation, 2);
  assert.equal(stopped.cursor, 4);
  assert.equal(stopped.synthetic, true);
  assert.equal(stopped.modelRan, false);

  // Stale generation after stop is rejected
  assert.throws(
    () => runner.stop({workerId: started.workerId, generation: 1, confirm: true}),
    error => error instanceof SyntheticRunnerError && error.code === 'STALE_CONTROL',
  );
  assert.throws(
    () => runner.inspect({workerId: started.workerId, generation: 1}),
    error => error instanceof SyntheticRunnerError && error.code === 'STALE_CONTROL',
  );

  // Terminal replay of stop is idempotent and adds no duplicate terminal event
  const replayStop = runner.stop({workerId: started.workerId, attemptId: 'attempt-1', generation: 2, confirm: true});
  assert.equal(replayStop.alreadyTerminal, true);
  assert.equal(replayStop.stopped, true);
  assert.equal(replayStop.status, 'cancelled');
  assert.equal(replayStop.cursor, 4);

  const eventDump = runner.events({workerId: started.workerId, afterSequence: 0});
  assert.equal(eventDump.events.length, 4);
  assert.equal(eventDump.events.filter(event => event.type === 'terminal').length, 1);

  // Further ticks do not revive or mutate a stopped run
  runner.tick(5);
  assert.equal(runner.inspect({workerId: started.workerId}).status, 'cancelled');

  // Stop replay on a naturally succeeded run preserves succeeded without overwriting it
  const second = runner.start(makeStartArgs({
    claimId: 'claim-2',
    attemptId: 'attempt-2',
    grantId: 'grant-2',
    deadlineAt: 2000,
  }));
  runner.tick(4);
  const stopAfterSuccess = runner.stop({workerId: second.workerId, confirm: true});
  assert.equal(stopAfterSuccess.alreadyTerminal, true);
  assert.equal(stopAfterSuccess.stopped, false);
  assert.equal(stopAfterSuccess.status, 'succeeded');
});

test('collection enforces terminal state, handles deadline expiry, and labels all outputs synthetic', () => {
  const runner = createSyntheticRunnerFixture({initialTimeMs: 1000, stepMs: 25});
  const okRun = runner.start(makeStartArgs({deadlineAt: 1100}));

  // Cannot collect while running
  assert.throws(
    () => runner.collect({workerId: okRun.workerId, attemptId: 'attempt-1'}),
    error => error instanceof SyntheticRunnerError && error.code === 'RUN_NOT_TERMINAL',
  );

  runner.tick(4);
  const collected = runner.collect({workerId: okRun.workerId, attemptId: 'attempt-1'});
  assert.equal(collected.status, 'succeeded');
  assert.equal(collected.state, 'exited');
  assert.equal(collected.settled, true);
  assert.equal(collected.synthetic, true);
  assert.equal(collected.modelRan, false);
  assert.equal(collected.codeExecuted, false);
  assert.equal(collected.verificationStatus, 'synthetic-unverified');
  assert.deepEqual(collected.proposal.files, SYNTHETIC_REPLACEMENT_FILES);
  assert.deepEqual(collected.proposal.fileDigests, SYNTHETIC_REPLACEMENT_DIGESTS);
  assert.deepEqual(collected.proposal.baselineDigests, SYNTHETIC_BASELINE_DIGESTS);
  assert.equal(collected.proposal.patch, SYNTHETIC_MULTI_FILE_PATCH);
  assert.equal(collected.proposal.patchSha256, SYNTHETIC_PATCH_SHA256);
  assert.equal(collected.checks.every(check => check.synthetic === true && check.codeExecuted === false), true);
  assert.equal(collected.usage.evidence, 'synthetic');
  assert.equal(collected.usage.semantics, 'unavailable');
  assert.equal(collected.usage.input, null);
  assert.equal(collected.usage.output, null);
  assert.equal(collected.usage.providerCharge, null);
  assert.equal(collected.usage.chargeEvidence, 'unavailable');
  assert.equal(collected.usage.modelRan, false);
  assert.equal(collected.receipt.synthetic, true);
  assert.equal(collected.receipt.modelRan, false);
  assert.equal(collected.receipt.codeExecuted, false);
  assert.equal(collected.receipt.cost, null);
  assert.equal(collected.receipt.chargeEvidence, 'unavailable');
  assert.equal(collected.receipt.elapsedMs, 100);
  assert.deepEqual(collected.receipt.limits, SYNTHETIC_LIMITS);
  assert.equal(JSON.stringify(collected).includes('syn-session-'), false);

  // Repeated collection is idempotent and immutable
  const collectedAgain = runner.collect({workerId: okRun.workerId});
  assert.deepEqual(collectedAgain, collected);
  assert.equal(Object.isFrozen(collected), true);
  assert.equal(Object.isFrozen(collected.proposal.files), true);

  // Cancelled run collects null proposal and cancelled synthetic receipt
  const cancelRun = runner.start(makeStartArgs({
    claimId: 'claim-cancel',
    attemptId: 'attempt-cancel',
    grantId: 'grant-cancel',
    deadlineAt: 2000,
  }));
  runner.stop({workerId: cancelRun.workerId, confirm: true});
  const cancelCollect = runner.collect({workerId: cancelRun.workerId});
  assert.equal(cancelCollect.status, 'cancelled');
  assert.equal(cancelCollect.proposal, null);
  assert.deepEqual(cancelCollect.checks, []);
  assert.equal(cancelCollect.receipt.status, 'cancelled');
  assert.equal(cancelCollect.receipt.synthetic, true);
  assert.equal(cancelCollect.receipt.chargeEvidence, 'unavailable');

  // Deadline expiry transitions to failed without emitting a proposal
  const timedRun = runner.start(makeStartArgs({
    claimId: 'claim-tmo',
    attemptId: 'attempt-tmo',
    grantId: 'grant-tmo',
    deadlineAt: 1160,
  }));
  runner.tick(3);
  const timedInspect = runner.inspect({workerId: timedRun.workerId});
  assert.equal(timedInspect.status, 'failed');
  assert.equal(timedInspect.reason, 'deadline-exceeded');
  assert.equal(timedInspect.endedAtMs, 1160);
  const timedCollect = runner.collect({workerId: timedRun.workerId});
  assert.equal(timedCollect.status, 'failed');
  assert.equal(timedCollect.proposal, null);
  assert.equal(timedCollect.receipt.status, 'failed');
  assert.equal(timedCollect.receipt.elapsedMs, 60);
});

test('bounds limit active runs, retained runs, event ring buffer, event bytes, and tick steps', () => {
  // Active and retained run bounds
  const boundedRunner = createSyntheticRunnerFixture({
    initialTimeMs: 0,
    stepMs: 25,
    maxActiveRuns: 2,
    maxRetainedRuns: 3,
  });

  const r1 = boundedRunner.start(makeStartArgs({claimId: 'c1', attemptId: 'a1', grantId: 'g1', deadlineAt: 1000}));
  const r2 = boundedRunner.start(makeStartArgs({claimId: 'c2', attemptId: 'a2', grantId: 'g2', deadlineAt: 1000}));
  assert.throws(
    () => boundedRunner.start(makeStartArgs({claimId: 'c3', attemptId: 'a3', grantId: 'g3', deadlineAt: 1000})),
    error => error instanceof SyntheticRunnerError && error.code === 'CAPACITY_EXCEEDED',
  );

  boundedRunner.stop({workerId: r1.workerId, confirm: true});
  const r3 = boundedRunner.start(makeStartArgs({claimId: 'c3', attemptId: 'a3', grantId: 'g3', deadlineAt: 1000}));
  boundedRunner.stop({workerId: r2.workerId, confirm: true});
  const r4 = boundedRunner.start(makeStartArgs({claimId: 'c4', attemptId: 'a4', grantId: 'g4', deadlineAt: 1000}));

  assert.equal(boundedRunner.stats().retainedRuns, 3);
  // Oldest terminal run (r1) was evicted to keep memory bounded
  assert.throws(
    () => boundedRunner.inspect({workerId: r1.workerId}),
    error => error instanceof SyntheticRunnerError && error.code === 'WORKER_NOT_FOUND',
  );
  assert.equal(boundedRunner.inspect({workerId: r3.workerId}).status, 'running');
  assert.equal(boundedRunner.inspect({workerId: r4.workerId}).status, 'running');

  // Event ring buffer bound
  const ringRunner = createSyntheticRunnerFixture({maxEventsPerRun: 3, stepMs: 10});
  const ringRun = ringRunner.start(makeStartArgs({deadlineAt: 500}));
  ringRunner.tick(4);
  const ringEvents = ringRunner.events({workerId: ringRun.workerId, afterSequence: 0});
  assert.equal(ringEvents.events.length, 3);
  assert.deepEqual(ringEvents.events.map(event => event.sequence), [3, 4, 5]);
  assert.equal(ringEvents.retainedFromSequence, 3);
  assert.equal(ringEvents.droppedEvents, 2);
  assert.equal(ringEvents.historyTruncated, true);
  assert.equal(ringEvents.missedRequested, true);

  const exactTail = ringRunner.events({workerId: ringRun.workerId, afterSequence: 2});
  assert.equal(exactTail.missedRequested, false);
  assert.deepEqual(exactTail.events.map(event => event.sequence), [3, 4, 5]);

  // Event byte limit bound
  const tinyByteRunner = createSyntheticRunnerFixture({maxEventBytes: 64});
  assert.throws(
    () => tinyByteRunner.start(makeStartArgs({deadlineAt: 500})),
    error => error instanceof SyntheticRunnerError && error.code === 'EVENT_LIMIT_EXCEEDED',
  );
  assert.equal(tinyByteRunner.stats().retainedRuns, 0);

  // Tick step bounds
  for (const badSteps of [0, -1, 1.5, SYNTHETIC_BOUNDS.maxTickSteps + 1, '1']) {
    assert.throws(
      () => ringRunner.tick(badSteps),
      error => error instanceof SyntheticRunnerError && error.code === 'INVALID_INPUT',
    );
  }
});

test('malformed and mismatched inputs fail closed without leaking diagnostics, secrets, or paths', () => {
  const runner = createSyntheticRunnerFixture();
  const canarySecret = 'SECRET_CANARY_TOKEN_999';
  const canaryPath = 'C:\\Users\\operator\\private\\repo\\limits.py';

  let getterInvoked = false;
  const getterObj = Object.defineProperty(makeStartArgs(), 'claimId', {
    enumerable: true,
    get() {
      getterInvoked = true;
      return 'claim-getter';
    },
  });
  const proxiedObj = new Proxy(makeStartArgs(), {});

  const badStarts = [
    null,
    [],
    new Date(),
    getterObj,
    proxiedObj,
    makeStartArgs({extraField: canarySecret}),
    makeStartArgs({claimId: canaryPath}),
    makeStartArgs({attemptId: '../escape'}),
    makeStartArgs({grantId: 'bad\ncontrol'}),
    makeStartArgs({snapshotRef: '/etc/passwd'}),
    makeStartArgs({snapshotRef: 'other-repo-v1'}),
    makeStartArgs({snapshotRef: {ref: SYNTHETIC_SNAPSHOT_REF, baselineHash: '0'.repeat(64)}}),
    makeStartArgs({snapshotRef: {files: {'limits.py': 'print(1)\n', 'measurement.py': SYNTHETIC_BASELINE_FILES['measurement.py']}}}),
    makeStartArgs({route: 'ollama'}),
    makeStartArgs({route: {engine: 'opencode', backend: 'llamacpp', model: 'qwen3-4b'}}),
    makeStartArgs({route: {engine: 'fixture', extra: canarySecret}}),
    makeStartArgs({deadlineAt: 'not-a-timestamp-' + canarySecret}),
    makeStartArgs({scopeHash: 'not-hex-' + canarySecret}),
  ];

  for (const bad of badStarts) {
    let caught;
    try {
      runner.start(bad);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof SyntheticRunnerError);
    assert.equal(caught.message.includes(canarySecret), false);
    assert.equal(caught.message.includes(canaryPath), false);
    assert.equal(caught.message.includes('/etc/passwd'), false);
    assert.deepEqual(Object.keys(caught.toJSON()), ['name', 'code', 'message']);
  }

  assert.equal(getterInvoked, false);
  assert.equal(runner.stats().totalStarted, 0);

  // Unknown or malformed worker queries fail closed without echoing input
  for (const badWorker of ['missing-worker', canarySecret, canaryPath]) {
    let caught;
    try {
      runner.inspect({workerId: badWorker});
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof SyntheticRunnerError);
    assert.equal(caught.message.includes(canarySecret), false);
    assert.equal(caught.message.includes(canaryPath), false);
  }
});
