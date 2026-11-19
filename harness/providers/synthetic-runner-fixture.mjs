// Disconnected, inert synthetic runner fixture for CydeWorks staging prep.
//
// Pure in-memory simulation: spawns zero processes, reads/writes zero files,
// makes zero network calls, invokes zero models, reads zero credentials or
// environment variables, and never executes candidate code.
//
// All outcomes, checks, usage fields, and receipt-like payloads are explicitly
// labeled synthetic with no model run and no real charge.

import {createHash} from 'node:crypto';
import {types} from 'node:util';

export const SYNTHETIC_FIXTURE_ID = 'synthetic-runner-fixture-v1';
export const SYNTHETIC_SNAPSHOT_REF = 'synthetic-limits-measurement-v1';

const FILE_NAMES = Object.freeze(['limits.py', 'measurement.py']);

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

export const SYNTHETIC_BASELINE_FILES = deepFreeze({
  'limits.py': 'def clamp(value):\n    return value\n',
  'measurement.py': 'from limits import clamp\n\n\ndef normalize(raw):\n    return clamp(int(raw))\n',
});

export const SYNTHETIC_REPLACEMENT_FILES = deepFreeze({
  'limits.py': [
    'def clamp(value):',
    '    if value < 0:',
    '        return 0',
    '    if value > 100:',
    '        return 100',
    '    return value',
    '',
  ].join('\n'),
  'measurement.py': [
    'from limits import clamp',
    '',
    '',
    'def normalize(raw):',
    '    try:',
    '        value = int(raw)',
    '    except (TypeError, ValueError):',
    '        return 0',
    '    return clamp(value)',
    '',
  ].join('\n'),
});

export const SYNTHETIC_BASELINE_DIGESTS = deepFreeze({
  'limits.py': sha256(SYNTHETIC_BASELINE_FILES['limits.py']),
  'measurement.py': sha256(SYNTHETIC_BASELINE_FILES['measurement.py']),
});

export const SYNTHETIC_BASELINE_HASH = sha256(
  JSON.stringify([SYNTHETIC_SNAPSHOT_REF, SYNTHETIC_BASELINE_DIGESTS]),
);

export const SYNTHETIC_REPLACEMENT_DIGESTS = deepFreeze({
  'limits.py': sha256(SYNTHETIC_REPLACEMENT_FILES['limits.py']),
  'measurement.py': sha256(SYNTHETIC_REPLACEMENT_FILES['measurement.py']),
});

function patchLines(text, prefix) {
  if (!text) return [];
  const lines = text.split('\n');
  const hasFinalNewline = text.endsWith('\n');
  if (hasFinalNewline) lines.pop();
  const linesOut = lines.map(line => prefix + line);
  if (!hasFinalNewline) linesOut.push('\\ No newline at end of file');
  return linesOut;
}

function unifiedFilePatch(filename, before, after) {
  if (before === after) return '';
  const lineCount = text => text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
  const range = text => lineCount(text) ? '1,' + lineCount(text) : '0,0';
  return [
    'diff --git a/' + filename + ' b/' + filename,
    '--- a/' + filename,
    '+++ b/' + filename,
    '@@ -' + range(before) + ' +' + range(after) + ' @@',
    ...patchLines(before, '-'),
    ...patchLines(after, '+'),
  ].join('\n') + '\n';
}

export const SYNTHETIC_MULTI_FILE_PATCH = FILE_NAMES
  .map(name => unifiedFilePatch(name, SYNTHETIC_BASELINE_FILES[name], SYNTHETIC_REPLACEMENT_FILES[name]))
  .join('');

export const SYNTHETIC_PATCH_SHA256 = sha256(SYNTHETIC_MULTI_FILE_PATCH);

export const SYNTHETIC_ROUTE = deepFreeze({
  id: 'fixture',
  engine: 'fixture',
  backend: 'fixture',
  model: 'fixture',
  label: 'Synthetic runner fixture',
  endpoint: null,
  digest: null,
  synthetic: true,
  modelRan: false,
  readiness: {
    eligible: true,
    reason: 'Synthetic fixture only. No model runs and no code is executed.',
  },
});

export const SYNTHETIC_LIMITS = Object.freeze([
  'Synthetic fixture output only. No model ran and no tokens were generated.',
  'No candidate code was executed, no process was spawned, and no files or network endpoints were accessed.',
  'Synthetic check summaries are pinned in-memory placeholders and do not constitute protected verification.',
  'No real provider charge occurred; charge evidence remains unavailable.',
  'Windows Stop, controller recovery, protected verifier, patch-binding, and Sol High safety gates remain separate and mandatory.',
]);

export const SYNTHETIC_BOUNDS = Object.freeze({
  defaultStepMs: 25,
  minStepMs: 1,
  maxStepMs: 60000,
  defaultMaxActiveRuns: 8,
  maxActiveRunsLimit: 64,
  defaultMaxRetainedRuns: 32,
  maxRetainedRunsLimit: 256,
  defaultMaxEventsPerRun: 16,
  maxEventsPerRunLimit: 128,
  defaultMaxEventBytes: 2048,
  minEventBytes: 64,
  maxEventBytesLimit: 16384,
  defaultMaxEventsPerRead: 32,
  maxEventsPerReadLimit: 128,
  maxTickSteps: 1000,
  maxDeadlineWindowMs: 3600000,
  maxClockMs: 8640000000000000,
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX64_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

const MESSAGES = Object.freeze({
  INVALID_OPTIONS: 'Synthetic runner options are invalid.',
  INVALID_INPUT: 'Synthetic runner input is invalid.',
  INVALID_CLOCK: 'Synthetic runner clock produced an invalid or backwards timestamp.',
  SNAPSHOT_MISMATCH: 'Synthetic runner accepts only the pinned synthetic multi-file fixture.',
  ROUTE_MISMATCH: 'Synthetic runner accepts only the synthetic fixture route.',
  DUPLICATE_START: 'An active or retained synthetic run already exists for this attempt, claim, or grant.',
  STALE_START: 'Synthetic start deadline is already expired or out of bounds.',
  CAPACITY_EXCEEDED: 'Synthetic runner has reached its active or retained run bound.',
  WORKER_NOT_FOUND: 'No synthetic worker was found for the supplied identifier.',
  ATTEMPT_MISMATCH: 'Synthetic worker does not match the supplied attempt identifier.',
  STALE_CONTROL: 'Synthetic control generation is stale for this worker.',
  STOP_NOT_CONFIRMED: 'Synthetic stop requires explicit confirmation when provided.',
  RUN_NOT_TERMINAL: 'Synthetic run has not reached a terminal state.',
  EVENT_LIMIT_EXCEEDED: 'Synthetic event exceeded the configured byte bound.',
});

export class SyntheticRunnerError extends Error {
  constructor(code) {
    const known = Object.hasOwn(MESSAGES, code) ? code : 'INVALID_INPUT';
    super(MESSAGES[known]);
    this.name = 'SyntheticRunnerError';
    this.code = known;
  }

  toJSON() {
    return {name: this.name, code: this.code, message: this.message};
  }
}

const fail = code => {
  throw new SyntheticRunnerError(code);
};

function readPlainRecord(value, allowedKeys, code = 'INVALID_INPUT') {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
    fail(code);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail(code);
  }
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.includes(key)) {
      fail(code);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(code);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function readSafeId(value, code = 'INVALID_INPUT') {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    CONTROL_PATTERN.test(value) ||
    value.includes('..') ||
    !ID_PATTERN.test(value)
  ) {
    fail(code);
  }
  return value;
}

function readBoundedInt(value, min, max, code = 'INVALID_OPTIONS') {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(code);
  }
  return value;
}

function parseTimestampMs(value, code = 'INVALID_INPUT') {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || value > SYNTHETIC_BOUNDS.maxClockMs) {
      fail(code);
    }
    return value;
  }
  if (typeof value === 'string') {
    if (value.length !== 24 || CONTROL_PATTERN.test(value)) {
      fail(code);
    }
    const ms = Date.parse(value);
    if (
      !Number.isSafeInteger(ms) ||
      ms < 0 ||
      ms > SYNTHETIC_BOUNDS.maxClockMs ||
      new Date(ms).toISOString() !== value
    ) {
      fail(code);
    }
    return ms;
  }
  fail(code);
}

function validateSnapshotRef(snapshotRef) {
  if (typeof snapshotRef === 'string') {
    if (CONTROL_PATTERN.test(snapshotRef) || snapshotRef.includes('/') || snapshotRef.includes('\\') || snapshotRef.includes('..')) {
      fail('SNAPSHOT_MISMATCH');
    }
    if (snapshotRef !== SYNTHETIC_SNAPSHOT_REF && snapshotRef !== SYNTHETIC_BASELINE_HASH) {
      fail('SNAPSHOT_MISMATCH');
    }
    return SYNTHETIC_SNAPSHOT_REF;
  }
  const obj = readPlainRecord(snapshotRef, ['ref', 'baselineHash', 'sourceHash', 'files'], 'SNAPSHOT_MISMATCH');
  let sawField = false;
  if (obj.ref !== undefined) {
    sawField = true;
    if (obj.ref !== SYNTHETIC_SNAPSHOT_REF) fail('SNAPSHOT_MISMATCH');
  }
  if (obj.baselineHash !== undefined) {
    sawField = true;
    if (obj.baselineHash !== SYNTHETIC_BASELINE_HASH) fail('SNAPSHOT_MISMATCH');
  }
  if (obj.sourceHash !== undefined) {
    sawField = true;
    if (obj.sourceHash !== SYNTHETIC_BASELINE_HASH) fail('SNAPSHOT_MISMATCH');
  }
  if (obj.files !== undefined) {
    sawField = true;
    const files = readPlainRecord(obj.files, FILE_NAMES, 'SNAPSHOT_MISMATCH');
    for (const name of FILE_NAMES) {
      if (files[name] !== SYNTHETIC_BASELINE_FILES[name]) {
        fail('SNAPSHOT_MISMATCH');
      }
    }
  }
  if (!sawField) fail('SNAPSHOT_MISMATCH');
  return SYNTHETIC_SNAPSHOT_REF;
}

function validateRoute(route) {
  if (typeof route === 'string') {
    if (route !== 'fixture' && route !== 'synthetic-fixture') {
      fail('ROUTE_MISMATCH');
    }
    return {engine: 'fixture', backend: 'fixture', model: 'fixture', synthetic: true};
  }
  const obj = readPlainRecord(
    route,
    ['id', 'engine', 'backend', 'model', 'revision', 'synthetic', 'label', 'endpoint', 'digest', 'modelRan', 'readiness'],
    'ROUTE_MISMATCH',
  );
  if (obj.engine !== 'fixture') fail('ROUTE_MISMATCH');
  if (obj.backend !== undefined && obj.backend !== 'fixture') fail('ROUTE_MISMATCH');
  if (obj.model !== undefined && obj.model !== 'fixture') fail('ROUTE_MISMATCH');
  if (obj.id !== undefined && obj.id !== 'fixture') fail('ROUTE_MISMATCH');
  if (obj.synthetic !== undefined && obj.synthetic !== true) fail('ROUTE_MISMATCH');
  if (obj.modelRan !== undefined && obj.modelRan !== false) fail('ROUTE_MISMATCH');
  if (obj.endpoint !== undefined && obj.endpoint !== null) fail('ROUTE_MISMATCH');
  if (obj.digest !== undefined && obj.digest !== null) fail('ROUTE_MISMATCH');
  if (obj.label !== undefined && (typeof obj.label !== 'string' || obj.label !== SYNTHETIC_ROUTE.label)) {
    fail('ROUTE_MISMATCH');
  }
  if (obj.readiness !== undefined) {
    const readiness = readPlainRecord(obj.readiness, ['eligible', 'reason'], 'ROUTE_MISMATCH');
    if (readiness.eligible !== true || typeof readiness.reason !== 'string' || !readiness.reason) {
      fail('ROUTE_MISMATCH');
    }
  }
  if (obj.revision !== undefined && (typeof obj.revision !== 'string' || !HEX64_PATTERN.test(obj.revision))) {
    fail('ROUTE_MISMATCH');
  }
  return {engine: 'fixture', backend: 'fixture', model: 'fixture', synthetic: true};
}

function cloneFrozen(value) {
  return deepFreeze(structuredClone(value));
}

const STEP_SPECS = Object.freeze([
  Object.freeze({
    step: 1,
    phase: 'staging-fixture',
    type: 'progress',
    message: 'Synthetic fixture snapshot staged in memory (no files touched).',
  }),
  Object.freeze({
    step: 2,
    phase: 'generating-candidate',
    type: 'progress',
    message: 'Synthetic candidate prepared from pinned fixture (no model ran).',
  }),
  Object.freeze({
    step: 3,
    phase: 'running-checks',
    type: 'progress',
    message: 'Synthetic check suite evaluated against pinned expectations (no code executed).',
  }),
  Object.freeze({
    step: 4,
    phase: 'completed',
    type: 'terminal',
    status: 'succeeded',
    reason: 'synthetic-completed',
    message: 'Synthetic run completed (synthetic only; no model ran, no code executed).',
  }),
]);

const TOTAL_STEPS = STEP_SPECS.length;

function emptySyntheticUsage() {
  return {
    evidence: 'synthetic',
    semantics: 'unavailable',
    input: null,
    output: null,
    cached: null,
    cacheWrite: null,
    reasoning: null,
    generationMs: null,
    loadMs: null,
    promptMs: null,
    providerCharge: null,
    chargeEvidence: 'unavailable',
    modelRan: false,
  };
}

function buildReceiptPayload(run, endedAtMs) {
  const elapsedMs = endedAtMs - run.startedAtMs;
  const usage = emptySyntheticUsage();
  return {
    synthetic: true,
    modelRan: false,
    codeExecuted: false,
    provider: 'fixture',
    backend: 'fixture',
    model: 'fixture',
    status: run.status,
    outcomeKnown: true,
    startedAtMs: run.startedAtMs,
    endedAtMs,
    elapsedMs,
    usage: {
      evidence: usage.evidence,
      semantics: usage.semantics,
      input: usage.input,
      output: usage.output,
      cached: usage.cached,
      cacheWrite: usage.cacheWrite,
      reasoning: usage.reasoning,
      generationMs: usage.generationMs,
      loadMs: usage.loadMs,
      promptMs: usage.promptMs,
      providerCharge: usage.providerCharge,
    },
    cost: null,
    chargeEvidence: 'unavailable',
    limits: [...SYNTHETIC_LIMITS],
  };
}

export function createSyntheticRunnerFixture(options = {}) {
  const opts = options === undefined ? Object.create(null) : readPlainRecord(
    options,
    ['clock', 'initialTimeMs', 'stepMs', 'maxActiveRuns', 'maxRetainedRuns', 'maxEventsPerRun', 'maxEventBytes', 'maxEventsPerRead'],
    'INVALID_OPTIONS',
  );

  if (opts.clock !== undefined && typeof opts.clock !== 'function') {
    fail('INVALID_OPTIONS');
  }
  const initialTimeMs = opts.initialTimeMs === undefined
    ? 0
    : parseTimestampMs(opts.initialTimeMs, 'INVALID_OPTIONS');
  const stepMs = opts.stepMs === undefined
    ? SYNTHETIC_BOUNDS.defaultStepMs
    : readBoundedInt(opts.stepMs, SYNTHETIC_BOUNDS.minStepMs, SYNTHETIC_BOUNDS.maxStepMs);
  const maxActiveRuns = opts.maxActiveRuns === undefined
    ? SYNTHETIC_BOUNDS.defaultMaxActiveRuns
    : readBoundedInt(opts.maxActiveRuns, 1, SYNTHETIC_BOUNDS.maxActiveRunsLimit);
  const maxRetainedRuns = opts.maxRetainedRuns === undefined
    ? SYNTHETIC_BOUNDS.defaultMaxRetainedRuns
    : readBoundedInt(opts.maxRetainedRuns, 1, SYNTHETIC_BOUNDS.maxRetainedRunsLimit);
  const maxEventsPerRun = opts.maxEventsPerRun === undefined
    ? SYNTHETIC_BOUNDS.defaultMaxEventsPerRun
    : readBoundedInt(opts.maxEventsPerRun, 1, SYNTHETIC_BOUNDS.maxEventsPerRunLimit);
  const maxEventBytes = opts.maxEventBytes === undefined
    ? SYNTHETIC_BOUNDS.defaultMaxEventBytes
    : readBoundedInt(opts.maxEventBytes, SYNTHETIC_BOUNDS.minEventBytes, SYNTHETIC_BOUNDS.maxEventBytesLimit);
  const maxEventsPerRead = opts.maxEventsPerRead === undefined
    ? SYNTHETIC_BOUNDS.defaultMaxEventsPerRead
    : readBoundedInt(opts.maxEventsPerRead, 1, SYNTHETIC_BOUNDS.maxEventsPerReadLimit);

  const rawClock = opts.clock ?? (() => initialTimeMs);
  let tickOffsetMs = 0;
  let lastObservedClockMs;

  function readEffectiveNow() {
    let raw;
    try {
      raw = rawClock();
    } catch {
      fail('INVALID_CLOCK');
    }
    if (!Number.isSafeInteger(raw) || raw < 0 || raw > SYNTHETIC_BOUNDS.maxClockMs) {
      fail('INVALID_CLOCK');
    }
    if (lastObservedClockMs !== undefined && raw < lastObservedClockMs) {
      fail('INVALID_CLOCK');
    }
    lastObservedClockMs = raw;
    const effective = raw + tickOffsetMs;
    if (!Number.isSafeInteger(effective) || effective > SYNTHETIC_BOUNDS.maxClockMs) {
      fail('INVALID_CLOCK');
    }
    return effective;
  }

  const runs = new Map();
  const attemptIndex = new Map();
  const claimIndex = new Map();
  const grantIndex = new Map();
  const requestIndex = new Map();
  const internalSessions = new WeakMap();

  let runCounter = 0;
  let totalStarted = 0;
  let totalStopped = 0;
  let totalCompleted = 0;
  let totalFailed = 0;

  function appendEvent(run, eventPayload) {
    const sequence = run.lastSequence + 1;
    const event = {
      workerId: run.workerId,
      attemptId: run.attemptId,
      sequence,
      type: eventPayload.type,
      phase: eventPayload.phase,
      ...(eventPayload.status !== undefined ? {status: eventPayload.status} : {}),
      ...(eventPayload.reason !== undefined ? {reason: eventPayload.reason} : {}),
      timestamp: new Date(eventPayload.timestampMs).toISOString(),
      timestampMs: eventPayload.timestampMs,
      message: eventPayload.message,
      progress: {
        completedSteps: eventPayload.completedSteps,
        totalSteps: TOTAL_STEPS,
        percent: Math.round((eventPayload.completedSteps / TOTAL_STEPS) * 100),
      },
      synthetic: true,
      modelRan: false,
      codeExecuted: false,
    };
    const encodedBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    if (encodedBytes > maxEventBytes) {
      fail('EVENT_LIMIT_EXCEEDED');
    }
    run.lastSequence = sequence;
    if (run.events.length >= maxEventsPerRun) {
      run.events.shift();
      run.droppedEvents++;
      run.retainedFromSequence = run.events.length > 0 ? run.events[0].sequence : sequence;
    }
    if (run.events.length === 0) {
      run.retainedFromSequence = sequence;
    }
    run.events.push(event);
  }

  function syncRun(run, effectiveNow) {
    if (run.status !== 'running') return;
    for (let step = run.completedSteps + 1; step <= TOTAL_STEPS; step++) {
      const spec = STEP_SPECS[step - 1];
      const stepAtMs = run.startedAtMs + step * stepMs;
      if (stepAtMs <= effectiveNow && stepAtMs <= run.deadlineAtMs) {
        appendEvent(run, {
          type: spec.type,
          phase: spec.phase,
          status: spec.status,
          reason: spec.reason,
          timestampMs: stepAtMs,
          message: spec.message,
          completedSteps: step,
        });
        run.completedSteps = step;
        if (spec.type === 'terminal') {
          run.status = spec.status;
          run.state = 'exited';
          run.reason = spec.reason;
          run.endedAtMs = stepAtMs;
          run.generation++;
          totalCompleted++;
          return;
        }
      } else {
        break;
      }
    }
    if (run.status === 'running' && effectiveNow >= run.deadlineAtMs) {
      appendEvent(run, {
        type: 'terminal',
        phase: 'failed',
        status: 'failed',
        reason: 'deadline-exceeded',
        timestampMs: run.deadlineAtMs,
        message: 'Synthetic run exceeded its configured deadline (synthetic only).',
        completedSteps: run.completedSteps,
      });
      run.status = 'failed';
      run.state = 'exited';
      run.reason = 'deadline-exceeded';
      run.endedAtMs = run.deadlineAtMs;
      run.generation++;
      totalFailed++;
    }
  }

  function syncAll(effectiveNow) {
    for (const run of runs.values()) {
      syncRun(run, effectiveNow);
    }
  }

  function evictOldestTerminalRun() {
    for (const [workerId, candidate] of runs.entries()) {
      if (candidate.status !== 'running') {
        runs.delete(workerId);
        attemptIndex.delete(candidate.attemptId);
        claimIndex.delete(candidate.claimId);
        grantIndex.delete(candidate.grantId);
        if (candidate.requestId !== undefined) {
          requestIndex.delete(candidate.requestId);
        }
        return true;
      }
    }
    return false;
  }

  function lookupRun(input, allowedKeys) {
    const args = readPlainRecord(input, allowedKeys);
    const workerId = readSafeId(args.workerId);
    const run = runs.get(workerId);
    if (!run) fail('WORKER_NOT_FOUND');
    if (args.attemptId !== undefined) {
      const attemptId = readSafeId(args.attemptId);
      if (attemptId !== run.attemptId) fail('ATTEMPT_MISMATCH');
    }
    return {args, run};
  }

  function inspectPayload(run, nowMs) {
    const endMs = run.endedAtMs;
    const referenceMs = endMs === null ? nowMs : endMs;
    const elapsedMs = Math.max(0, referenceMs - run.startedAtMs);
    return cloneFrozen({
      workerId: run.workerId,
      attemptId: run.attemptId,
      claimId: run.claimId,
      grantId: run.grantId,
      snapshotRef: run.snapshotRef,
      state: run.state,
      status: run.status,
      confirmed: true,
      ...(run.reason !== null ? {reason: run.reason} : {}),
      generation: run.generation,
      cursor: run.lastSequence,
      startedAt: new Date(run.startedAtMs).toISOString(),
      startedAtMs: run.startedAtMs,
      endedAt: endMs === null ? null : new Date(endMs).toISOString(),
      endedAtMs: endMs,
      elapsedMs,
      deadlineAt: new Date(run.deadlineAtMs).toISOString(),
      deadlineAtMs: run.deadlineAtMs,
      progress: {
        completedSteps: run.completedSteps,
        totalSteps: TOTAL_STEPS,
        percent: Math.round((run.completedSteps / TOTAL_STEPS) * 100),
      },
      route: {...run.route},
      synthetic: true,
      modelRan: false,
      codeExecuted: false,
      chargeEvidence: 'unavailable',
    });
  }

  return Object.freeze({
    route() {
      return cloneFrozen(SYNTHETIC_ROUTE);
    },

    stats() {
      const effectiveNow = readEffectiveNow();
      syncAll(effectiveNow);
      let activeRuns = 0;
      for (const run of runs.values()) {
        if (run.status === 'running') activeRuns++;
      }
      return cloneFrozen({
        activeRuns,
        retainedRuns: runs.size,
        totalStarted,
        totalStopped,
        totalCompleted,
        totalFailed,
        virtualNowMs: effectiveNow,
        bounds: {
          stepMs,
          maxActiveRuns,
          maxRetainedRuns,
          maxEventsPerRun,
          maxEventBytes,
          maxEventsPerRead,
        },
        synthetic: true,
      });
    },

    tick(steps = 1) {
      const count = readBoundedInt(steps, 1, SYNTHETIC_BOUNDS.maxTickSteps, 'INVALID_INPUT');
      const beforeNow = readEffectiveNow();
      const nextOffset = tickOffsetMs + count * stepMs;
      if (!Number.isSafeInteger(beforeNow + count * stepMs) || beforeNow + count * stepMs > SYNTHETIC_BOUNDS.maxClockMs) {
        fail('INVALID_CLOCK');
      }
      tickOffsetMs = nextOffset;
      const effectiveNow = readEffectiveNow();
      syncAll(effectiveNow);
      let activeRuns = 0;
      for (const run of runs.values()) {
        if (run.status === 'running') activeRuns++;
      }
      return cloneFrozen({
        advancedSteps: count,
        virtualNowMs: effectiveNow,
        activeRuns,
        synthetic: true,
      });
    },

    start(input) {
      const args = readPlainRecord(
        input,
        ['claimId', 'attemptId', 'grantId', 'snapshotRef', 'route', 'deadlineAt', 'requestId', 'scopeHash'],
      );
      const claimId = readSafeId(args.claimId);
      const attemptId = readSafeId(args.attemptId);
      const grantId = readSafeId(args.grantId);
      const requestId = args.requestId === undefined ? undefined : readSafeId(args.requestId);
      if (args.scopeHash !== undefined && (typeof args.scopeHash !== 'string' || !HEX64_PATTERN.test(args.scopeHash))) {
        fail('INVALID_INPUT');
      }
      const snapshotRef = validateSnapshotRef(args.snapshotRef);
      const route = validateRoute(args.route);

      const effectiveNow = readEffectiveNow();
      syncAll(effectiveNow);

      const deadlineAtMs = parseTimestampMs(args.deadlineAt);
      if (deadlineAtMs <= effectiveNow || deadlineAtMs - effectiveNow > SYNTHETIC_BOUNDS.maxDeadlineWindowMs) {
        fail('STALE_START');
      }

      if (
        attemptIndex.has(attemptId) ||
        claimIndex.has(claimId) ||
        grantIndex.has(grantId) ||
        (requestId !== undefined && requestIndex.has(requestId))
      ) {
        fail('DUPLICATE_START');
      }

      let activeCount = 0;
      for (const existing of runs.values()) {
        if (existing.status === 'running') activeCount++;
      }
      if (activeCount >= maxActiveRuns) {
        fail('CAPACITY_EXCEEDED');
      }
      if (runs.size >= maxRetainedRuns && !evictOldestTerminalRun()) {
        fail('CAPACITY_EXCEEDED');
      }

      runCounter++;
      const workerId = 'syn-worker-' + sha256(JSON.stringify([runCounter, attemptId, claimId])).slice(0, 16);
      const internalSessionRef = 'syn-session-' + sha256(JSON.stringify([runCounter, grantId, effectiveNow])).slice(0, 24);

      const run = {
        workerId,
        attemptId,
        claimId,
        grantId,
        requestId,
        scopeHash: args.scopeHash ?? null,
        snapshotRef,
        route,
        state: 'running',
        status: 'running',
        reason: null,
        generation: 1,
        startedAtMs: effectiveNow,
        endedAtMs: null,
        deadlineAtMs,
        completedSteps: 0,
        lastSequence: 0,
        retainedFromSequence: 1,
        droppedEvents: 0,
        events: [],
      };

      appendEvent(run, {
        type: 'started',
        phase: 'starting',
        timestampMs: effectiveNow,
        message: 'Synthetic worker initialized in memory (no model ran, no process spawned).',
        completedSteps: 0,
      });

      internalSessions.set(run, internalSessionRef);
      runs.set(workerId, run);
      attemptIndex.set(attemptId, workerId);
      claimIndex.set(claimId, workerId);
      grantIndex.set(grantId, workerId);
      if (requestId !== undefined) {
        requestIndex.set(requestId, workerId);
      }
      totalStarted++;

      return cloneFrozen({
        workerId,
        attemptId,
        claimId,
        grantId,
        snapshotRef,
        cursor: run.lastSequence,
        generation: run.generation,
        state: run.state,
        status: run.status,
        startedAt: new Date(effectiveNow).toISOString(),
        startedAtMs: effectiveNow,
        deadlineAt: new Date(deadlineAtMs).toISOString(),
        deadlineAtMs,
        route: {...route},
        synthetic: true,
        modelRan: false,
        codeExecuted: false,
        chargeEvidence: 'unavailable',
      });
    },

    events(input) {
      const {args, run} = lookupRun(input, ['workerId', 'attemptId', 'afterSequence', 'limit']);
      const afterSequence = args.afterSequence === undefined
        ? 0
        : readBoundedInt(args.afterSequence, 0, Number.MAX_SAFE_INTEGER, 'INVALID_INPUT');
      const limit = args.limit === undefined
        ? maxEventsPerRead
        : readBoundedInt(args.limit, 1, maxEventsPerRead, 'INVALID_INPUT');

      const effectiveNow = readEffectiveNow();
      syncRun(run, effectiveNow);

      const matched = run.events.filter(event => event.sequence > afterSequence);
      const selected = matched.slice(0, limit);
      const cursor = selected.length > 0 ? selected.at(-1).sequence : run.lastSequence;

      return cloneFrozen({
        workerId: run.workerId,
        attemptId: run.attemptId,
        events: selected,
        cursor,
        latestSequence: run.lastSequence,
        retainedFromSequence: run.retainedFromSequence,
        droppedEvents: run.droppedEvents,
        historyTruncated: run.droppedEvents > 0,
        missedRequested: run.droppedEvents > 0 && afterSequence < run.retainedFromSequence - 1,
        hasMore: matched.length > selected.length,
        terminal: run.status !== 'running',
        status: run.status,
        synthetic: true,
        modelRan: false,
        codeExecuted: false,
      });
    },

    inspect(input) {
      const {args, run} = lookupRun(input, ['workerId', 'attemptId', 'generation']);
      const effectiveNow = readEffectiveNow();
      syncRun(run, effectiveNow);
      if (args.generation !== undefined) {
        if (!Number.isSafeInteger(args.generation) || args.generation !== run.generation) {
          fail('STALE_CONTROL');
        }
      }
      return inspectPayload(run, effectiveNow);
    },

    stop(input) {
      const {args, run} = lookupRun(input, ['workerId', 'attemptId', 'generation', 'confirm']);
      if (args.confirm !== undefined && args.confirm !== true) {
        fail('STOP_NOT_CONFIRMED');
      }
      const effectiveNow = readEffectiveNow();
      syncRun(run, effectiveNow);

      if (args.generation !== undefined) {
        if (!Number.isSafeInteger(args.generation) || args.generation !== run.generation) {
          fail('STALE_CONTROL');
        }
      }

      if (run.status !== 'running') {
        return cloneFrozen({
          workerId: run.workerId,
          attemptId: run.attemptId,
          state: 'exited',
          status: run.status,
          confirmed: true,
          stopped: run.status === 'cancelled',
          alreadyTerminal: true,
          generation: run.generation,
          cursor: run.lastSequence,
          endedAt: new Date(run.endedAtMs).toISOString(),
          endedAtMs: run.endedAtMs,
          synthetic: true,
          modelRan: false,
          codeExecuted: false,
          chargeEvidence: 'unavailable',
        });
      }

      appendEvent(run, {
        type: 'terminal',
        phase: 'stopped',
        status: 'cancelled',
        reason: 'operator-stopped',
        timestampMs: effectiveNow,
        message: 'Synthetic run stopped before completion (synthetic only).',
        completedSteps: run.completedSteps,
      });

      run.status = 'cancelled';
      run.state = 'exited';
      run.reason = 'operator-stopped';
      run.endedAtMs = effectiveNow;
      run.generation++;
      totalStopped++;

      return cloneFrozen({
        workerId: run.workerId,
        attemptId: run.attemptId,
        state: 'exited',
        status: 'cancelled',
        confirmed: true,
        stopped: true,
        alreadyTerminal: false,
        generation: run.generation,
        cursor: run.lastSequence,
        endedAt: new Date(run.endedAtMs).toISOString(),
        endedAtMs: run.endedAtMs,
        synthetic: true,
        modelRan: false,
        codeExecuted: false,
        chargeEvidence: 'unavailable',
      });
    },

    collect(input) {
      const {run} = lookupRun(input, ['workerId', 'attemptId']);
      const effectiveNow = readEffectiveNow();
      syncRun(run, effectiveNow);

      if (run.status === 'running') {
        fail('RUN_NOT_TERMINAL');
      }

      const succeeded = run.status === 'succeeded';
      const usage = emptySyntheticUsage();
      const elapsedMs = Math.max(0, run.endedAtMs - run.startedAtMs);

      return cloneFrozen({
        workerId: run.workerId,
        attemptId: run.attemptId,
        claimId: run.claimId,
        grantId: run.grantId,
        snapshotRef: run.snapshotRef,
        state: 'exited',
        status: run.status,
        settled: true,
        ...(run.reason !== null ? {reason: run.reason} : {}),
        synthetic: true,
        modelRan: false,
        codeExecuted: false,
        verificationStatus: 'synthetic-unverified',
        limits: [...SYNTHETIC_LIMITS],
        route: {...run.route},
        timing: {
          startedAt: new Date(run.startedAtMs).toISOString(),
          startedAtMs: run.startedAtMs,
          endedAt: new Date(run.endedAtMs).toISOString(),
          endedAtMs: run.endedAtMs,
          elapsedMs,
          timebase: 'clock',
        },
        proposal: succeeded
          ? {
              summary: 'Synthetic multi-file fixture replacement for limits.py and measurement.py. No model ran and no code was executed.',
              files: {
                'limits.py': SYNTHETIC_REPLACEMENT_FILES['limits.py'],
                'measurement.py': SYNTHETIC_REPLACEMENT_FILES['measurement.py'],
              },
              fileDigests: {
                'limits.py': SYNTHETIC_REPLACEMENT_DIGESTS['limits.py'],
                'measurement.py': SYNTHETIC_REPLACEMENT_DIGESTS['measurement.py'],
              },
              baselineDigests: {
                'limits.py': SYNTHETIC_BASELINE_DIGESTS['limits.py'],
                'measurement.py': SYNTHETIC_BASELINE_DIGESTS['measurement.py'],
              },
              patch: SYNTHETIC_MULTI_FILE_PATCH,
              patchSha256: SYNTHETIC_PATCH_SHA256,
            }
          : null,
        checks: succeeded
          ? [
              {
                name: 'Synthetic multi-file fixture matches pinned replacement',
                pass: true,
                synthetic: true,
                codeExecuted: false,
                evidence: 'pinned-in-memory-fixture',
              },
              {
                name: 'Synthetic check cases (non-executed fixture placeholder)',
                pass: true,
                synthetic: true,
                codeExecuted: false,
                cases: 12,
                passed: 12,
                failed: 0,
                evidence: 'pinned-in-memory-fixture',
              },
            ]
          : [],
        usage,
        receipt: buildReceiptPayload(run, run.endedAtMs),
      });
    },
  });
}
