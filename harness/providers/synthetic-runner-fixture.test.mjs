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
  assert.ok(SYNTHETIC_LIMITS.length >= 6);
  assert.equal(SYNTHETIC_LIMITS.some(entry => /across process restarts/i.test(entry)), true);
  assert.equal(SYNTHETIC_LIMITS.some(entry => /bounded serialized JSON/i.test(entry)), true);
  assert.equal(SYNTHETIC_BOUNDS.maxInputBytes, 8192);

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

  // Missing, explicit false, and malformed confirm values are rejected without stopping the run
  for (const badConfirmArgs of [
    {workerId: started.workerId, attemptId: 'attempt-1'},
    {workerId: started.workerId, attemptId: 'attempt-1', generation: 1},
    {workerId: started.workerId, attemptId: 'attempt-1', confirm: false},
    {workerId: started.workerId, attemptId: 'attempt-1', confirm: 'true'},
    {workerId: started.workerId, attemptId: 'attempt-1', confirm: 1},
    {workerId: started.workerId, attemptId: 'attempt-1', confirm: null},
    {workerId: started.workerId, attemptId: 'attempt-1', confirm: {}},
  ]) {
    assert.throws(
      () => runner.stop(badConfirmArgs),
      error => error instanceof SyntheticRunnerError && error.code === 'STOP_NOT_CONFIRMED',
    );
  }

  // Stale or malformed generation is rejected even when confirm: true
  for (const badGeneration of [0, 2, '1', null]) {
    assert.throws(
      () => runner.stop({workerId: started.workerId, attemptId: 'attempt-1', generation: badGeneration, confirm: true}),
      error => error instanceof SyntheticRunnerError && error.code === 'STALE_CONTROL',
    );
  }

  // None of the rejected stop attempts stopped or mutated the running attempt
  const stillRunning = runner.inspect({workerId: started.workerId, attemptId: 'attempt-1'});
  assert.equal(stillRunning.status, 'running');
  assert.equal(stillRunning.state, 'running');
  assert.equal(stillRunning.generation, 1);
  assert.equal(stillRunning.progress.completedSteps, 2);
  assert.equal(runner.stats().totalStopped, 0);
  assert.equal(
    runner.events({workerId: started.workerId, afterSequence: 0}).events.filter(event => event.type === 'terminal').length,
    0,
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

  // Running attempt whose stop lacked confirmation or had stale generation still completes normally
  const second = runner.start(makeStartArgs({
    claimId: 'claim-2',
    attemptId: 'attempt-2',
    grantId: 'grant-2',
    deadlineAt: 2000,
  }));
  assert.throws(
    () => runner.stop({workerId: second.workerId, attemptId: 'attempt-2'}),
    error => error instanceof SyntheticRunnerError && error.code === 'STOP_NOT_CONFIRMED',
  );
  assert.throws(
    () => runner.stop({workerId: second.workerId, attemptId: 'attempt-2', generation: 0, confirm: true}),
    error => error instanceof SyntheticRunnerError && error.code === 'STALE_CONTROL',
  );
  assert.equal(runner.inspect({workerId: second.workerId}).status, 'running');
  runner.tick(4);
  assert.equal(runner.inspect({workerId: second.workerId}).status, 'succeeded');
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

test('bounds limit active runs, retained runs without identity eviction, event ring buffer, event bytes, and tick steps', () => {
  // Active and retained run bounds fail closed and preserve lifetime replay protection
  const boundedRunner = createSyntheticRunnerFixture({
    initialTimeMs: 0,
    stepMs: 25,
    maxActiveRuns: 2,
    maxRetainedRuns: 3,
  });

  const r1 = boundedRunner.start(makeStartArgs({
    claimId: 'c1',
    attemptId: 'a1',
    grantId: 'g1',
    requestId: 'req1',
    deadlineAt: 1000,
  }));
  const r2 = boundedRunner.start(makeStartArgs({
    claimId: 'c2',
    attemptId: 'a2',
    grantId: 'g2',
    requestId: 'req2',
    deadlineAt: 1000,
  }));
  assert.throws(
    () => boundedRunner.start(makeStartArgs({
      claimId: 'c3',
      attemptId: 'a3',
      grantId: 'g3',
      requestId: 'req3',
      deadlineAt: 1000,
    })),
    error => error instanceof SyntheticRunnerError && error.code === 'CAPACITY_EXCEEDED',
  );

  boundedRunner.stop({workerId: r1.workerId, confirm: true});
  const r3 = boundedRunner.start(makeStartArgs({
    claimId: 'c3',
    attemptId: 'a3',
    grantId: 'g3',
    requestId: 'req3',
    deadlineAt: 1000,
  }));
  boundedRunner.stop({workerId: r2.workerId, confirm: true});
  // Allow r3 to succeed so all 3 retained slots are terminal (cancelled, cancelled, succeeded)
  boundedRunner.tick(4);
  assert.equal(boundedRunner.inspect({workerId: r3.workerId}).status, 'succeeded');

  // Fresh start beyond maxRetainedRuns fails closed rather than evicting identity history
  assert.throws(
    () => boundedRunner.start(makeStartArgs({
      claimId: 'c4',
      attemptId: 'a4',
      grantId: 'g4',
      requestId: 'req4',
      deadlineAt: 1000,
    })),
    error => error instanceof SyntheticRunnerError && error.code === 'CAPACITY_EXCEEDED',
  );

  assert.equal(boundedRunner.stats().retainedRuns, 3);
  assert.equal(boundedRunner.stats().totalStarted, 3);
  assert.equal(boundedRunner.inspect({workerId: r1.workerId}).status, 'cancelled');
  assert.equal(boundedRunner.inspect({workerId: r2.workerId}).status, 'cancelled');
  assert.equal(boundedRunner.inspect({workerId: r3.workerId}).status, 'succeeded');

  // Replaying any old identifier (attemptId, claimId, grantId, requestId) after capacity pressure
  // must remain blocked as DUPLICATE_START rather than restarting or rotating out
  const oldTuples = [
    {claimId: 'c1', attemptId: 'a1', grantId: 'g1', requestId: 'req1'},
    {claimId: 'c2', attemptId: 'a2', grantId: 'g2', requestId: 'req2'},
    {claimId: 'c3', attemptId: 'a3', grantId: 'g3', requestId: 'req3'},
  ];
  for (const old of oldTuples) {
    const conflicts = [
      old,
      {claimId: old.claimId, attemptId: 'fresh-a', grantId: 'fresh-g', requestId: 'fresh-req'},
      {claimId: 'fresh-c', attemptId: old.attemptId, grantId: 'fresh-g', requestId: 'fresh-req'},
      {claimId: 'fresh-c', attemptId: 'fresh-a', grantId: old.grantId, requestId: 'fresh-req'},
      {claimId: 'fresh-c', attemptId: 'fresh-a', grantId: 'fresh-g', requestId: old.requestId},
    ];
    for (const conflict of conflicts) {
      assert.throws(
        () => boundedRunner.start(makeStartArgs({...conflict, deadlineAt: 1000})),
        error => error instanceof SyntheticRunnerError && error.code === 'DUPLICATE_START',
      );
    }
  }
  assert.equal(boundedRunner.stats().retainedRuns, 3);
  assert.equal(boundedRunner.stats().totalStarted, 3);

  // Replay protection also holds for deadline-failed runs at capacity and after deadline expiry
  const expiredRunner = createSyntheticRunnerFixture({
    initialTimeMs: 0,
    stepMs: 25,
    maxActiveRuns: 1,
    maxRetainedRuns: 1,
  });
  const failedRun = expiredRunner.start(makeStartArgs({
    claimId: 'c-exp',
    attemptId: 'a-exp',
    grantId: 'g-exp',
    requestId: 'req-exp',
    deadlineAt: 60,
  }));
  expiredRunner.tick(3);
  assert.equal(expiredRunner.inspect({workerId: failedRun.workerId}).status, 'failed');
  assert.throws(
    () => expiredRunner.start(makeStartArgs({
      claimId: 'c-fresh',
      attemptId: 'a-fresh',
      grantId: 'g-fresh',
      requestId: 'req-fresh',
      deadlineAt: 1000,
    })),
    error => error instanceof SyntheticRunnerError && error.code === 'CAPACITY_EXCEEDED',
  );
  for (const conflict of [
    {claimId: 'c-exp', attemptId: 'a-exp', grantId: 'g-exp', requestId: 'req-exp', deadlineAt: 60},
    {claimId: 'c-exp', attemptId: 'a-new', grantId: 'g-new', requestId: 'req-new', deadlineAt: 1000},
    {claimId: 'c-new', attemptId: 'a-exp', grantId: 'g-new', requestId: 'req-new', deadlineAt: 1000},
    {claimId: 'c-new', attemptId: 'a-new', grantId: 'g-exp', requestId: 'req-new', deadlineAt: 1000},
    {claimId: 'c-new', attemptId: 'a-new', grantId: 'g-new', requestId: 'req-exp', deadlineAt: 1000},
  ]) {
    assert.throws(
      () => expiredRunner.start(makeStartArgs(conflict)),
      error => error instanceof SyntheticRunnerError && error.code === 'DUPLICATE_START',
    );
  }
  assert.equal(expiredRunner.stats().retainedRuns, 1);
  assert.equal(expiredRunner.stats().totalStarted, 1);

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

test('maxEventBytes admission guarantees all terminal variants fit and tests exact boundary', () => {
  const probeSucceeded = createSyntheticRunnerFixture({initialTimeMs: 1000, stepMs: 25});
  const sRun = probeSucceeded.start(makeStartArgs({attemptId: 'attempt-bnd', deadlineAt: 2000}));
  probeSucceeded.tick(4);
  const succeededEvents = probeSucceeded.events({workerId: sRun.workerId, afterSequence: 0}).events;

  const probeCancelled = createSyntheticRunnerFixture({initialTimeMs: 1000, stepMs: 25});
  const cRun = probeCancelled.start(makeStartArgs({attemptId: 'attempt-bnd', deadlineAt: 2000}));
  probeCancelled.tick(2);
  probeCancelled.stop({workerId: cRun.workerId, attemptId: 'attempt-bnd', confirm: true});
  const cancelledEvents = probeCancelled.events({workerId: cRun.workerId, afterSequence: 0}).events;

  const probeFailed = createSyntheticRunnerFixture({initialTimeMs: 1000, stepMs: 25});
  const fRun = probeFailed.start(makeStartArgs({attemptId: 'attempt-bnd', deadlineAt: 1060}));
  probeFailed.tick(3);
  const failedEvents = probeFailed.events({workerId: fRun.workerId, afterSequence: 0}).events;

  const startedBytes = Buffer.byteLength(JSON.stringify(succeededEvents[0]), 'utf8');
  const maxTerminalBytes = Math.max(
    ...[...succeededEvents, ...cancelledEvents, ...failedEvents].map(ev =>
      Buffer.byteLength(JSON.stringify(ev), 'utf8'),
    ),
  );
  assert.ok(maxTerminalBytes > startedBytes);

  // A bound that only fits the started event must reject at start rather than stranding later operations
  const startedOnly = createSyntheticRunnerFixture({
    initialTimeMs: 1000,
    stepMs: 25,
    maxEventBytes: startedBytes,
  });
  assert.throws(
    () => startedOnly.start(makeStartArgs({attemptId: 'attempt-bnd', deadlineAt: 2000})),
    error => error instanceof SyntheticRunnerError && error.code === 'EVENT_LIMIT_EXCEEDED',
  );
  assert.equal(startedOnly.stats().retainedRuns, 0);
  assert.equal(startedOnly.stats().totalStarted, 0);

  // One byte below the largest terminal variant must reject at start
  const justBelow = createSyntheticRunnerFixture({
    initialTimeMs: 1000,
    stepMs: 25,
    maxEventBytes: maxTerminalBytes - 1,
  });
  assert.throws(
    () => justBelow.start(makeStartArgs({attemptId: 'attempt-bnd', deadlineAt: 2000})),
    error => error instanceof SyntheticRunnerError && error.code === 'EVENT_LIMIT_EXCEEDED',
  );
  assert.equal(justBelow.stats().retainedRuns, 0);

  // At the exact boundary, all three terminal outcomes (succeeded, cancelled, failed) complete cleanly
  const exactSucceeded = createSyntheticRunnerFixture({
    initialTimeMs: 1000,
    stepMs: 25,
    maxEventBytes: maxTerminalBytes,
  });
  const runS = exactSucceeded.start(makeStartArgs({attemptId: 'attempt-bnd', deadlineAt: 2000}));
  exactSucceeded.tick(4);
  assert.equal(exactSucceeded.inspect({workerId: runS.workerId}).status, 'succeeded');
  assert.equal(exactSucceeded.collect({workerId: runS.workerId}).status, 'succeeded');

  const exactCancelled = createSyntheticRunnerFixture({
    initialTimeMs: 1000,
    stepMs: 25,
    maxEventBytes: maxTerminalBytes,
  });
  const runC = exactCancelled.start(makeStartArgs({attemptId: 'attempt-bnd', deadlineAt: 2000}));
  exactCancelled.tick(2);
  assert.equal(exactCancelled.stop({workerId: runC.workerId, confirm: true}).status, 'cancelled');
  assert.equal(exactCancelled.inspect({workerId: runC.workerId}).status, 'cancelled');
  assert.equal(exactCancelled.collect({workerId: runC.workerId}).status, 'cancelled');

  const exactFailed = createSyntheticRunnerFixture({
    initialTimeMs: 1000,
    stepMs: 25,
    maxEventBytes: maxTerminalBytes,
  });
  const runF = exactFailed.start(makeStartArgs({attemptId: 'attempt-bnd', deadlineAt: 1060}));
  exactFailed.tick(3);
  assert.equal(exactFailed.inspect({workerId: runF.workerId}).status, 'failed');
  assert.equal(exactFailed.collect({workerId: runF.workerId}).status, 'failed');
});

test('stale generation stop does not synchronize events or state when clock advances with no prior poll', () => {
  let nowMs = 1000;
  let clockReads = 0;
  const runner = createSyntheticRunnerFixture({
    clock: () => {
      clockReads++;
      return nowMs;
    },
    stepMs: 25,
  });

  const started = runner.start(makeStartArgs({deadlineAt: 2000}));
  assert.equal(clockReads, 1);

  // Advance clock past completion with no prior poll
  nowMs = 1200;

  // Stale wrt stored generation (0 !== 1) fails before reading clock or running syncRun
  assert.throws(
    () => runner.stop({workerId: started.workerId, attemptId: 'attempt-1', generation: 0, confirm: true}),
    error => error instanceof SyntheticRunnerError && error.code === 'STALE_CONTROL',
  );
  assert.equal(clockReads, 1);

  // Stored generation 1 becomes stale after sync transitions run to succeeded (generation 2),
  // so recheck before cancellation rejects STALE_CONTROL without cancelling
  assert.throws(
    () => runner.stop({workerId: started.workerId, attemptId: 'attempt-1', generation: 1, confirm: true}),
    error => error instanceof SyntheticRunnerError && error.code === 'STALE_CONTROL',
  );
  assert.equal(runner.inspect({workerId: started.workerId}).status, 'succeeded');
  assert.equal(runner.stats().totalStopped, 0);
});

test('tick samples and validates clock before committing offset so failed tick does not alter future progress', () => {
  let nowMs = 1000;
  let clockCalls = 0;
  const runner = createSyntheticRunnerFixture({
    clock: () => {
      clockCalls++;
      if (clockCalls === 2) {
        throw new Error('transient clock read failure');
      }
      return nowMs;
    },
    stepMs: 25,
  });

  const started = runner.start(makeStartArgs({deadlineAt: 2000}));
  assert.throws(
    () => runner.tick(3),
    error => error instanceof SyntheticRunnerError && error.code === 'INVALID_CLOCK',
  );

  // Offset was not committed on the failed tick
  const afterFailure = runner.inspect({workerId: started.workerId});
  assert.equal(afterFailure.elapsedMs, 0);
  assert.equal(afterFailure.progress.completedSteps, 0);
  assert.equal(afterFailure.status, 'running');

  // Next tick advances cleanly by 1 step from 1000 to 1025, not 1075 or 1100
  const nextTick = runner.tick(1);
  assert.equal(nextTick.virtualNowMs, 1025);
  assert.equal(runner.inspect({workerId: started.workerId}).progress.completedSteps, 1);
});

test('revoked proxies fail closed with fixed privacy-safe errors across all entrypoints', () => {
  const revokedObj = Proxy.revocable({}, {});
  revokedObj.revoke();
  const revokedArr = Proxy.revocable([], {});
  revokedArr.revoke();
  const revokedFn = Proxy.revocable(() => 0, {});
  revokedFn.revoke();

  for (const badOpts of [revokedObj.proxy, revokedArr.proxy, revokedFn.proxy]) {
    assert.throws(
      () => createSyntheticRunnerFixture(badOpts),
      error => error instanceof SyntheticRunnerError && error.code === 'INVALID_OPTIONS',
    );
  }

  const brokenClockRunner = createSyntheticRunnerFixture({clock: revokedFn.proxy});
  assert.throws(
    () => brokenClockRunner.start(makeStartArgs()),
    error => error instanceof SyntheticRunnerError && error.code === 'INVALID_CLOCK',
  );

  const runner = createSyntheticRunnerFixture({initialTimeMs: 1000, stepMs: 25});
  const started = runner.start(makeStartArgs({deadlineAt: 2000}));

  for (const badInput of [revokedObj.proxy, revokedArr.proxy, revokedFn.proxy]) {
    for (const fn of [
      () => runner.start(badInput),
      () => runner.events(badInput),
      () => runner.inspect(badInput),
      () => runner.stop(badInput),
      () => runner.collect(badInput),
    ]) {
      assert.throws(
        fn,
        error => error instanceof SyntheticRunnerError && error.code === 'INVALID_INPUT',
      );
    }
  }

  assert.throws(
    () => runner.start(makeStartArgs({claimId: 'c-rp1', attemptId: 'a-rp1', grantId: 'g-rp1', snapshotRef: revokedArr.proxy})),
    error => error instanceof SyntheticRunnerError && error.code === 'SNAPSHOT_MISMATCH',
  );
  assert.throws(
    () => runner.start(makeStartArgs({claimId: 'c-rp2', attemptId: 'a-rp2', grantId: 'g-rp2', snapshotRef: {files: revokedArr.proxy}})),
    error => error instanceof SyntheticRunnerError && error.code === 'SNAPSHOT_MISMATCH',
  );
  assert.throws(
    () => runner.start(makeStartArgs({claimId: 'c-rp3', attemptId: 'a-rp3', grantId: 'g-rp3', route: revokedArr.proxy})),
    error => error instanceof SyntheticRunnerError && error.code === 'ROUTE_MISMATCH',
  );
  assert.throws(
    () => runner.start(makeStartArgs({claimId: 'c-rp4', attemptId: 'a-rp4', grantId: 'g-rp4', route: {engine: 'fixture', readiness: revokedArr.proxy}})),
    error => error instanceof SyntheticRunnerError && error.code === 'ROUTE_MISMATCH',
  );
  assert.throws(
    () => runner.stop({workerId: started.workerId, confirm: revokedObj.proxy}),
    error => error instanceof SyntheticRunnerError && error.code === 'STOP_NOT_CONFIRMED',
  );
  assert.throws(
    () => runner.stop({workerId: started.workerId, confirm: true, generation: revokedObj.proxy}),
    error => error instanceof SyntheticRunnerError && error.code === 'STALE_CONTROL',
  );
});

test('oversized strings and serialized JSON payloads respect pre-enumeration bounds', () => {
  const runner = createSyntheticRunnerFixture({initialTimeMs: 1000, stepMs: 25});

  // Oversized snapshotRef, files, route, and scopeHash are bounded by length before scanning
  assert.throws(
    () => runner.start(makeStartArgs({snapshotRef: 'x'.repeat(100_000)})),
    error => error instanceof SyntheticRunnerError && error.code === 'SNAPSHOT_MISMATCH',
  );
  assert.throws(
    () => runner.start(makeStartArgs({snapshotRef: {files: {'limits.py': 'y'.repeat(100_000), 'measurement.py': SYNTHETIC_BASELINE_FILES['measurement.py']}}})),
    error => error instanceof SyntheticRunnerError && error.code === 'SNAPSHOT_MISMATCH',
  );
  assert.throws(
    () => runner.start(makeStartArgs({route: 'z'.repeat(100_000)})),
    error => error instanceof SyntheticRunnerError && error.code === 'ROUTE_MISMATCH',
  );
  assert.throws(
    () => runner.start(makeStartArgs({scopeHash: 'a'.repeat(100_000)})),
    error => error instanceof SyntheticRunnerError && error.code === 'INVALID_INPUT',
  );

  // Oversized serialized JSON payloads fail before JSON.parse or property enumeration
  const hugeJson = '{"claimId":"c1","attemptId":"a1","grantId":"g1","snapshotRef":"synthetic-limits-measurement-v1","route":"fixture","deadlineAt":2000,' +
    '"pad":"' + 'p'.repeat(SYNTHETIC_BOUNDS.maxInputBytes) + '"}';
  const multiByteOverUtf8 = '{"claimId":"' + '\u2603'.repeat(3000) + '"}';
  assert.ok(multiByteOverUtf8.length <= SYNTHETIC_BOUNDS.maxInputBytes);
  assert.ok(Buffer.byteLength(multiByteOverUtf8, 'utf8') > SYNTHETIC_BOUNDS.maxInputBytes);

  for (const badSerialized of ['', '{not-json', '[]', 'null', '{"__proto__":{}}', hugeJson, multiByteOverUtf8]) {
    assert.throws(
      () => runner.start(badSerialized),
      error => error instanceof SyntheticRunnerError && error.code === 'INVALID_INPUT',
    );
  }
  assert.equal(runner.stats().totalStarted, 0);

  // Bounded serialized JSON inputs work end-to-end across start, inspect, events, stop, and collect
  const jsonStart = JSON.stringify(makeStartArgs({
    claimId: 'claim-json',
    attemptId: 'attempt-json',
    grantId: 'grant-json',
    deadlineAt: 2000,
  }));
  const started = runner.start(jsonStart);
  assert.equal(started.attemptId, 'attempt-json');
  assert.equal(
    runner.inspect(JSON.stringify({workerId: started.workerId, attemptId: 'attempt-json'})).status,
    'running',
  );
  assert.equal(
    runner.events(JSON.stringify({workerId: started.workerId, afterSequence: 0})).events.length,
    1,
  );
  assert.equal(
    runner.stop(JSON.stringify({workerId: started.workerId, attemptId: 'attempt-json', generation: 1, confirm: true})).status,
    'cancelled',
  );
  assert.equal(
    runner.collect(JSON.stringify({workerId: started.workerId, attemptId: 'attempt-json'})).status,
    'cancelled',
  );
});

