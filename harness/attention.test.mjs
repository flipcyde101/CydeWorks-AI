import test from 'node:test';
import assert from 'node:assert/strict';
import {attentionFor} from './attention.mjs';
import {describeProgress} from './web/progress.js';

const start = '2026-11-14T12:00:00.000Z';
const then = Date.parse(start);

function makeRunningTask({
  id = 'task-1',
  title = 'Synthetic task',
  status = 'running',
  attemptId = 'attempt-2',
  attemptStatus = 'running',
  executionPhase = 'dispatching',
  dispatchedAt = start,
  started = start,
  ended = undefined,
  recovery = undefined,
  live = undefined,
  extraAttempts = [],
} = {}) {
  const currentAttempt = {
    id: attemptId,
    provider: 'opencode',
    started,
    ...(attemptStatus !== undefined ? {status: attemptStatus} : {}),
    ...(ended !== undefined ? {ended} : {}),
    ...(recovery !== undefined ? {recovery} : {}),
    ...(executionPhase !== undefined
      ? {execution: {phase: executionPhase, ...(dispatchedAt !== undefined ? {dispatchedAt} : {})}}
      : {}),
  };
  return {
    id,
    title,
    status,
    ...(live !== undefined ? {live} : {}),
    attempts: [...extraAttempts, currentAttempt],
  };
}

test('existing one-argument behavior and reason ordering are preserved', () => {
  const failedTask = {id: 'one', title: 'Synthetic task', status: 'failed', attempts: [{provider: 'opencode'}]};
  const item = attentionFor(failedTask);
  assert.equal(item.id, 'one');
  assert.equal(item.title, 'Synthetic task');
  assert.equal(item.status, 'failed');
  assert.deepEqual(item.reasons, ['Run failed', 'Earlier outcome needs recovery']);

  assert.equal(attentionFor({id: 'two', status: 'accepted', attempts: []}), null);
  assert.equal(attentionFor({id: 'two-rej', title: 'Rejected', status: 'rejected', attempts: []}), null);

  const review = attentionFor({
    id: 'three',
    title: 'Synthetic review',
    status: 'review',
    attempts: [{checks: [{pass: false}]}],
  });
  assert.deepEqual(review.reasons, ['Proposal needs review', 'A check failed']);

  const passingReview = attentionFor({
    id: 'three-ok',
    title: 'Clean review',
    status: 'review',
    attempts: [{checks: [{pass: true}]}],
  });
  assert.deepEqual(passingReview.reasons, ['Proposal needs review']);

  const draft = attentionFor({id: 'four', title: 'Draft scope', status: 'draft', attempts: []});
  assert.deepEqual(draft.reasons, ['Approval needed']);

  const interrupted = attentionFor({
    id: 'five',
    title: 'Interrupted task',
    status: 'interrupted',
    attempts: [{provider: 'opencode', execution: {phase: 'dispatching'}}],
  });
  assert.deepEqual(interrupted.reasons, ['Run interrupted', 'Earlier outcome needs recovery']);

  const cancelledSafe = attentionFor({
    id: 'six',
    title: 'Safe cancel',
    status: 'cancelled',
    attempts: [{provider: 'fixture', execution: {phase: 'settled'}}],
  });
  assert.equal(cancelledSafe, null);

  // One-argument calls ignore embedded live/progress/stalled fields on task.
  const oneArgRunning = makeRunningTask({
    live: {chars: 40, lastActivity: start, heartbeat: start},
  });
  oneArgRunning.stalled = true;
  oneArgRunning.progress = {phase: 'stalled', stalled: true, lastActivity: then, idleMs: 65_000};
  assert.equal(attentionFor(oneArgRunning), null);

  // Array.prototype.map(attentionFor) passes numeric index as 2nd argument and remains unaffected.
  const mapped = [failedTask, oneArgRunning, draft].map(attentionFor).filter(Boolean);
  assert.deepEqual(mapped.map(entry => entry.id), ['one', 'four']);
});

test('active measured stall produces a single possible-stall reason for the active attempt', () => {
  const liveSteps = {
    lastActivity: null,
    heartbeat: new Date(then + 64_000).toISOString(),
    steps: {
      measured: true,
      source: 'worker',
      completed: 2,
      total: 5,
      samples: [
        {at: start, done: 0},
        {at: new Date(then + 4_000).toISOString(), done: 2},
      ],
    },
  };
  const taskSteps = makeRunningTask({attemptId: 'att-steps', live: liveSteps});
  const stepProgress = describeProgress(taskSteps, taskSteps.attempts[0], then + 65_000);
  assert.equal(stepProgress.phase, 'stalled');
  assert.equal(stepProgress.stalled, true);

  const stepAttention = attentionFor(taskSteps, {attemptId: 'att-steps', progress: stepProgress});
  assert.deepEqual(stepAttention, {
    id: 'task-1',
    title: 'Synthetic task',
    status: 'running',
    reasons: ['Active run may be stalled'],
  });

  // Streaming output that stopped for >= 60s also reports a possible stall.
  const liveOutput = {
    chars: 120,
    lastActivity: new Date(then + 4_000).toISOString(),
    heartbeat: new Date(then + 64_000).toISOString(),
  };
  const taskOutput = makeRunningTask({id: 'task-out', attemptId: 'att-out', live: liveOutput});
  const outputProgress = describeProgress(taskOutput, taskOutput.attempts[0], then + 65_000);
  assert.equal(outputProgress.phase, 'stalled');

  const outAttention = attentionFor(taskOutput, {attemptId: 'att-out', progress: outputProgress});
  assert.deepEqual(outAttention, {
    id: 'task-out',
    title: 'Synthetic task',
    status: 'running',
    reasons: ['Active run may be stalled'],
  });
});

test('active progress with a fresh heartbeat, elapsed time alone, and heartbeat-only snapshots do not trigger a stall', () => {
  const attempt = {id: 'att-active', provider: 'opencode', started: start, execution: {phase: 'dispatching', dispatchedAt: start}};

  // Active measured progress after 120s total elapsed time with a fresh heartbeat.
  const activeTask = {
    id: 'task-active',
    title: 'Active run',
    status: 'running',
    attempts: [attempt],
    live: {
      lastActivity: new Date(then + 119_000).toISOString(),
      heartbeat: new Date(then + 119_500).toISOString(),
      steps: {
        measured: true,
        source: 'worker',
        completed: 3,
        total: 5,
        samples: [
          {at: start, done: 0},
          {at: new Date(then + 60_000).toISOString(), done: 1},
          {at: new Date(then + 119_000).toISOString(), done: 3},
        ],
      },
    },
  };
  const activeProgress = describeProgress(activeTask, attempt, then + 120_000);
  assert.equal(activeProgress.phase, 'active');
  assert.equal(activeProgress.elapsedMs, 120_000);
  assert.equal(attentionFor(activeTask, {attemptId: 'att-active', progress: activeProgress}), null);

  // Zero chars and no measured steps after 65s is elapsed time only, not a measured stall.
  const zeroWorkTask = makeRunningTask({
    id: 'task-zero',
    attemptId: 'att-zero',
    live: {chars: 0, lastActivity: start, heartbeat: new Date(then + 64_000).toISOString()},
  });
  const zeroWorkProgress = describeProgress(zeroWorkTask, zeroWorkTask.attempts[0], then + 65_000);
  assert.equal(attentionFor(zeroWorkTask, {attemptId: 'att-zero', progress: zeroWorkProgress}), null);

  // Heartbeat-only stall (missing lastActivity timestamp) must not trigger a stall.
  const heartbeatOnlyTask = makeRunningTask({
    id: 'task-hb',
    attemptId: 'att-hb',
    live: {lastActivity: null, heartbeat: start},
  });
  const heartbeatOnlyProgress = describeProgress(heartbeatOnlyTask, heartbeatOnlyTask.attempts[0], then + 65_000);
  assert.equal(heartbeatOnlyProgress.phase, 'stalled');
  assert.equal(heartbeatOnlyProgress.lastActivity, null);
  assert.equal(attentionFor(heartbeatOnlyTask, {attemptId: 'att-hb', progress: heartbeatOnlyProgress}), null);

  // Elapsed time + fresh heartbeat with missing lastActivity even when manually marked stalled.
  assert.equal(attentionFor(heartbeatOnlyTask, {
    attemptId: 'att-hb',
    progress: {
      phase: 'stalled',
      stalled: true,
      clockAnomaly: false,
      elapsedMs: 120_000,
      heartbeat: then + 119_000,
      heartbeatAgeMs: 1_000,
      lastActivity: null,
      idleMs: null,
      stepSamplesValid: true,
    },
  }), null);

  // Missing attempt.started timestamp or inverted dispatch timestamp never infers a stall.
  const missingStartTask = makeRunningTask({id: 'task-nostart', attemptId: 'att-ns', started: undefined});
  assert.equal(attentionFor(missingStartTask, {
    attemptId: 'att-ns',
    progress: {
      phase: 'stalled',
      stalled: true,
      clockAnomaly: false,
      lastActivity: then + 4_000,
      idleMs: 61_000,
      stepSamplesValid: true,
    },
  }), null);

  const invertedDispatchTask = makeRunningTask({
    id: 'task-inv',
    attemptId: 'att-inv',
    started: new Date(then + 5_000).toISOString(),
    dispatchedAt: start,
  });
  assert.equal(attentionFor(invertedDispatchTask, {
    attemptId: 'att-inv',
    progress: {
      phase: 'stalled',
      stalled: true,
      clockAnomaly: false,
      lastActivity: then + 6_000,
      idleMs: 61_000,
      elapsedMs: 62_000,
      stepSamplesValid: true,
    },
  }), null);
});

test('claimed/preflight, missing execution, and settled attempt states never report a stall', () => {
  const stalledSnapshot = {
    phase: 'stalled',
    stalled: true,
    clockAnomaly: false,
    lastActivity: then + 4_000,
    idleMs: 61_000,
    elapsedMs: 65_000,
    stepSamplesValid: true,
    chars: 50,
  };

  const claimedTask = makeRunningTask({attemptId: 'att-claimed', executionPhase: 'claimed'});
  assert.equal(attentionFor(claimedTask, {attemptId: 'att-claimed', progress: stalledSnapshot}), null);

  const missingExecTask = makeRunningTask({attemptId: 'att-no-exec', executionPhase: undefined});
  assert.equal(attentionFor(missingExecTask, {attemptId: 'att-no-exec', progress: stalledSnapshot}), null);

  const settledExecTask = makeRunningTask({attemptId: 'att-settled', executionPhase: 'settled'});
  assert.equal(attentionFor(settledExecTask, {attemptId: 'att-settled', progress: stalledSnapshot}), null);
});

test('missing and mismatched attempt IDs never trigger a stall', () => {
  const stalledSnapshot = {
    phase: 'stalled',
    stalled: true,
    clockAnomaly: false,
    lastActivity: then + 4_000,
    idleMs: 61_000,
    elapsedMs: 65_000,
    stepSamplesValid: true,
  };
  const task = makeRunningTask({
    attemptId: 'att-current',
    extraAttempts: [{id: 'att-previous', provider: 'opencode', status: 'failed', execution: {phase: 'settled'}}],
  });

  // Missing attemptId or control characters in attemptId
  assert.equal(attentionFor(task, {progress: stalledSnapshot}), null);
  assert.equal(attentionFor(task, {attemptId: '', progress: stalledSnapshot}), null);
  assert.equal(attentionFor(task, {attemptId: '   ', progress: stalledSnapshot}), null);
  assert.equal(attentionFor(task, {attemptId: 'att-current\n', progress: stalledSnapshot}), null);
  assert.equal(attentionFor(task, {attemptId: 123, progress: stalledSnapshot}), null);

  // Previous attempt or unrelated attemptId
  assert.equal(attentionFor(task, {attemptId: 'att-previous', progress: stalledSnapshot}), null);
  assert.equal(attentionFor(task, {attemptId: 'att-other', progress: stalledSnapshot}), null);

  // Conflicting attemptId between options and progress
  assert.equal(attentionFor(task, {
    attemptId: 'att-current',
    progress: {...stalledSnapshot, attemptId: 'att-previous'},
  }), null);

  // Attempt record missing its own id
  const noAttemptIdTask = makeRunningTask({attemptId: undefined});
  assert.equal(attentionFor(noAttemptIdTask, {attemptId: 'att-current', progress: stalledSnapshot}), null);

  // Matching current attemptId succeeds
  const matched = attentionFor(task, {attemptId: 'att-current', progress: stalledSnapshot});
  assert.deepEqual(matched.reasons, ['Active run may be stalled']);
});

test('terminal task and attempt states never emit a stall reason', () => {
  const stalledSnapshot = {
    phase: 'stalled',
    stalled: true,
    clockAnomaly: false,
    lastActivity: then + 4_000,
    idleMs: 61_000,
    elapsedMs: 65_000,
    stepSamplesValid: true,
  };

  for (const [status, expectedReasons] of [
    ['accepted', null],
    ['rejected', null],
    ['complete', null],
    ['completed', null],
    ['cancelled', null],
    ['draft', ['Approval needed']],
    ['review', ['Proposal needs review']],
    ['failed', ['Run failed']],
  ]) {
    const task = makeRunningTask({
      id: `term-${status}`,
      status,
      attemptId: 'att-1',
      attemptStatus: status === 'draft' ? 'running' : 'settled',
      executionPhase: status === 'failed' ? 'settled' : 'dispatching',
    });
    if (status === 'cancelled' || status === 'failed') {
      task.attempts[0].provider = 'fixture';
      task.attempts[0].execution.phase = 'settled';
    }
    const result = attentionFor(task, {attemptId: 'att-1', progress: stalledSnapshot});
    if (expectedReasons === null) {
      assert.equal(result, null, status);
    } else {
      assert.deepEqual(result.reasons, expectedReasons, status);
    }
  }

  // Running task whose latest attempt already has a terminal status or ended timestamp.
  const endedAttemptTask = makeRunningTask({attemptId: 'att-ended', ended: new Date(then + 5_000).toISOString()});
  assert.equal(attentionFor(endedAttemptTask, {attemptId: 'att-ended', progress: stalledSnapshot}), null);

  const completedAttemptTask = makeRunningTask({attemptId: 'att-comp', attemptStatus: 'completed'});
  assert.equal(attentionFor(completedAttemptTask, {attemptId: 'att-comp', progress: stalledSnapshot}), null);
});

test('recovery plus stall keeps one task-level entry without duplicating or leaking stall into held recovery', () => {
  const stalledSnapshot = {
    phase: 'stalled',
    stalled: true,
    clockAnomaly: false,
    lastActivity: then + 4_000,
    idleMs: 61_000,
    elapsedMs: 65_000,
    stepSamplesValid: true,
  };

  const interruptedHeld = makeRunningTask({
    id: 'rec-int',
    status: 'interrupted',
    attemptId: 'att-rec',
    attemptStatus: 'interrupted',
    recovery: {state: 'unresolved', message: 'Earlier request may still be active.'},
  });
  const intEntry = attentionFor(interruptedHeld, {attemptId: 'att-rec', progress: stalledSnapshot});
  assert.deepEqual(intEntry, {
    id: 'rec-int',
    title: 'Synthetic task',
    status: 'interrupted',
    reasons: ['Run interrupted', 'Earlier outcome needs recovery'],
  });

  const failedHeld = makeRunningTask({
    id: 'rec-fail',
    status: 'failed',
    attemptId: 'att-fail',
    attemptStatus: 'failed',
    executionPhase: 'dispatching',
  });
  assert.deepEqual(attentionFor(failedHeld, {attemptId: 'att-fail', progress: stalledSnapshot}).reasons, [
    'Run failed',
    'Earlier outcome needs recovery',
  ]);

  const cancelledHeld = makeRunningTask({
    id: 'rec-cancel',
    status: 'cancelled',
    attemptId: 'att-cancel',
    attemptStatus: 'cancelled',
    executionPhase: 'dispatching',
  });
  assert.deepEqual(attentionFor(cancelledHeld, {attemptId: 'att-cancel', progress: stalledSnapshot}).reasons, [
    'Earlier outcome needs recovery',
  ]);

  // Running task marked recovery-blocked or with unresolved recovery state does not report stall.
  const blockedRunning = makeRunningTask({
    id: 'rec-blocked',
    attemptId: 'att-blocked',
    recovery: {state: 'unresolved', message: 'Held'},
  });
  assert.equal(attentionFor(blockedRunning, {attemptId: 'att-blocked', progress: stalledSnapshot}), null);

  const taskBlocked = makeRunningTask({id: 'rec-task-blocked', attemptId: 'att-tb'});
  taskBlocked.recovery = {blocked: true};
  assert.equal(attentionFor(taskBlocked, {attemptId: 'att-tb', progress: stalledSnapshot}), null);

  // Active second attempt after an earlier retry-safe attempt reports only the active stall.
  const retriedAndStalled = makeRunningTask({
    id: 'retried-active',
    attemptId: 'att-2',
    extraAttempts: [{
      id: 'att-1',
      provider: 'opencode',
      status: 'interrupted',
      execution: {phase: 'claimed'},
      recovery: {state: 'retry-safe', message: 'Safe to retry.'},
    }],
  });
  assert.deepEqual(attentionFor(retriedAndStalled, {attemptId: 'att-2', progress: stalledSnapshot}), {
    id: 'retried-active',
    title: 'Synthetic task',
    status: 'running',
    reasons: ['Active run may be stalled'],
  });
});

test('repeated polling is idempotent, pure, and clears immediately once progress resumes', () => {
  const task = makeRunningTask({
    id: 'poll-1',
    attemptId: 'att-poll',
    live: {
      chars: 80,
      lastActivity: new Date(then + 4_000).toISOString(),
      heartbeat: new Date(then + 64_000).toISOString(),
    },
  });
  const stalledSnapshot1 = describeProgress(task, task.attempts[0], then + 65_000);
  const stalledSnapshot2 = describeProgress(task, task.attempts[0], then + 80_000);
  const snapshotBefore = JSON.stringify(task);

  const first = attentionFor(task, {attemptId: 'att-poll', progress: stalledSnapshot1});
  const second = attentionFor(task, {attemptId: 'att-poll', progress: stalledSnapshot1});
  const third = attentionFor(task, {attemptId: 'att-poll', progress: stalledSnapshot2});

  assert.deepEqual(first, {
    id: 'poll-1',
    title: 'Synthetic task',
    status: 'running',
    reasons: ['Active run may be stalled'],
  });
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.equal(JSON.stringify(task), snapshotBefore);

  // Progress resumes -> attention entry clears cleanly.
  task.live.chars = 160;
  task.live.lastActivity = new Date(then + 85_000).toISOString();
  task.live.heartbeat = new Date(then + 85_500).toISOString();
  const resumedSnapshot = describeProgress(task, task.attempts[0], then + 86_000);
  assert.equal(attentionFor(task, {attemptId: 'att-poll', progress: resumedSnapshot}), null);
});

test('invalid inputs, throwing getters, untrusted labels, and clock anomalies fail closed', () => {
  for (const bad of [null, undefined, 'running', 42, ['a'], new Date(), {}, {id: '', status: 'draft'}, {id: 'x', status: ''}]) {
    assert.equal(attentionFor(bad), null);
  }

  // Throwing getter on task or options never escapes.
  const throwingTask = {id: 'bad-get', status: 'running', attempts: []};
  Object.defineProperty(throwingTask, 'title', {
    get() {
      throw new Error('boom');
    },
  });
  assert.equal(attentionFor(throwingTask), null);

  const throwingProxy = new Proxy({}, {
    getOwnPropertyDescriptor() {
      throw new Error('trap');
    },
  });
  assert.equal(attentionFor(throwingProxy), null);

  const validTask = makeRunningTask({id: 'guard-1', attemptId: 'att-guard'});
  assert.equal(attentionFor(validTask, throwingProxy), null);
  assert.equal(attentionFor(validTask, {attemptId: 'att-guard', progress: throwingProxy}), null);

  // Malformed attempts / checks do not throw on existing statuses.
  assert.deepEqual(attentionFor({id: 'bad-att', title: 'Bad attempts', status: 'failed', attempts: 'not-array'}).reasons, ['Run failed']);
  assert.deepEqual(attentionFor({id: 'bad-chk', title: 'Bad checks', status: 'review', attempts: [{checks: [null, {pass: true}]}]}).reasons, ['Proposal needs review']);

  // String/boolean caller labels cannot manufacture trusted host provenance or bypass validation.
  const baseStall = {
    phase: 'stalled',
    stalled: true,
    clockAnomaly: false,
    lastActivity: then + 4_000,
    idleMs: 61_000,
    elapsedMs: 65_000,
    stepSamplesValid: true,
    trusted: true,
    provenance: 'host',
    hostVerified: true,
  };

  for (const badProgress of [
    null,
    'stalled',
    [],
    {...baseStall, source: 'heuristic'},
    {...baseStall, source: 'client'},
    {...baseStall, estimated: true},
    {...baseStall, inferred: true},
    {...baseStall, simulated: true},
    {...baseStall, measured: false},
    {...baseStall, trustworthy: false},
    {...baseStall, stepSamplesValid: false, chars: 50},
    {...baseStall, clockAnomaly: true},
    {...baseStall, clockAnomalyReason: 'Clock timestamps are inconsistent or out of range.'},
    {...baseStall, lastActivity: Number.NaN},
    {...baseStall, lastActivity: then - 1_000}, // before attempt start
    {...baseStall, lastActivityAt: new Date(then + 9_000).toISOString()}, // mismatches lastActivity
    {...baseStall, idleMs: 59_999},
    {...baseStall, idleMs: 70_000, elapsedMs: 65_000}, // idle exceeds elapsed
    {...baseStall, stopping: true},
    {...baseStall, failed: true},
    {...baseStall, complete: true},
    {...baseStall, waiting: true},
    {phase: 'stalled', stalled: true, trusted: true, provenance: 'host', elapsedMs: 90_000}, // labels without measured idle
  ]) {
    assert.equal(attentionFor(validTask, {attemptId: 'att-guard', progress: badProgress, trusted: true}), null);
  }
});

test('error-data minimization omits raw diagnostics, secrets, paths, and provider error text', () => {
  const secret = 'sk-secretvalue1234567890abcd';
  const bearer = 'Bearer supersecrettokenvalue123';
  const winPath = 'C:\\Users\\alice\\private\\key.pem';
  const unixPath = '/Users/alice/.ssh/id_rsa';

  const sensitiveTask = {
    id: 'min-1',
    title: `Review ${bearer} at ${unixPath}`,
    status: 'failed',
    error: `Provider failure ${secret}`,
    live: {error: `Stack at fn (${winPath}:12:3)`},
    attempts: [{
      id: 'att-min',
      provider: 'opencode',
      status: 'failed',
      problem: `Provider crashed with ${secret} and ${bearer} at ${winPath}`,
      execution: {phase: 'dispatching', dispatchedAt: start},
      recovery: {
        state: 'unresolved',
        message: `Raw recovery diagnostic containing ${secret} and ${unixPath}`,
      },
    }],
  };

  const entry = attentionFor(sensitiveTask, {
    attemptId: 'att-min',
    progress: {
      phase: 'stalled',
      stalled: true,
      clockAnomaly: false,
      lastActivity: then + 4_000,
      idleMs: 61_000,
      elapsedMs: 65_000,
      stepSamplesValid: true,
      status: `Provider error ${secret}`,
      explanation: `Detailed trace ${winPath}`,
      stepRejectionReason: `Rejected ${bearer}`,
      unavailableReasons: {overallEta: `Omitted ${unixPath}`},
    },
  });

  assert.deepEqual(Object.keys(entry).sort(), ['id', 'reasons', 'status', 'title']);
  assert.deepEqual(entry.reasons, ['Run failed', 'Earlier outcome needs recovery']);

  const serialized = JSON.stringify(entry);
  for (const leaked of [secret, 'supersecrettokenvalue123', winPath, unixPath, 'Provider crashed', 'Provider failure', 'Detailed trace']) {
    assert.equal(serialized.includes(leaked), false, `must not expose ${leaked}`);
  }
});
