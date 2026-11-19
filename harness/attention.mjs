import {retryHold} from './recovery.mjs';

const STALL_THRESHOLD_MS = 60_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/;

const POSSIBLE_STALL_REASON = 'Active run may be stalled';

const UNTRUSTED_SOURCE_RE = /(?:estimat|infer|heuristic|guess|char|token|byte|utf-?16|utf-?8|code[-_. ]?(?:unit|point)|string[-_. ]?len(?:gth)?|text[-_. ]?len(?:gth)?|(?:model|llm|assistant|stream|raw|text|response|completion)[-_. ]?output|output[-_. ]?(?:len(?:gth)?|size|count)|approx|extrapolat|interpolat|simulat|synthetic|synthesiz|mock|fake|dummy|stub|placeholder|predict|unknown|unverif|unmeasur)/i;
const MAX_SOURCE_LENGTH = 64;
const SAFE_SOURCE_RE = /^[a-z0-9]+(?:[-_.:\s][a-z0-9]+)*$/i;
const ALLOWED_MEASURED_SOURCES = new Set([
  'worker',
  'runner',
  'harness',
  'scheduler',
  'executor',
  'dispatcher',
  'pipeline',
  'workflow',
  'orchestrator',
  'scanner',
  'file-scanner',
  'test-runner',
  'build-runner',
  'task-runner',
  'job-runner',
  'step-runner',
  'command-runner',
  'compiler',
  'builder',
  'linter',
  'formatter',
  'indexer',
  'parser',
  'analyzer',
  'checker',
  'type-checker',
  'typechecker',
  'verifier',
  'validator',
  'migrator',
  'importer',
  'exporter',
  'batch-processor',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ArrayBuffer.isView(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ownData(obj, key) {
  const descriptor = Object.getOwnPropertyDescriptor(obj, key);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

function parseTimestampMs(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 && value <= MAX_DATE_MS ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < 4 || /^\d+$/.test(trimmed)) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_DATE_MS ? parsed : null;
}

function normalizeSourceId(source) {
  return source
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([a-zA-Z])(\d)/g, '$1-$2')
    .replace(/(\d)([a-zA-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[-_.:\s]+/g, '-');
}

function isAllowedMeasuredSource(source) {
  if (typeof source !== 'string') return false;
  const trimmed = source.trim();
  if (!trimmed || trimmed.length > MAX_SOURCE_LENGTH || CONTROL_CHARS_RE.test(trimmed) || /[<>]/.test(trimmed) || !SAFE_SOURCE_RE.test(trimmed)) {
    return false;
  }
  const normalized = normalizeSourceId(trimmed);
  if (UNTRUSTED_SOURCE_RE.test(normalized)) return false;
  return ALLOWED_MEASURED_SOURCES.has(normalized);
}

function pushUniqueReason(reasons, reason) {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function isCanonicalAttemptId(value) {
  return typeof value === 'string'
    && value.length > 0
    && !CONTROL_CHARS_RE.test(value)
    && value.trim() === value;
}

function hasGenuineActiveStall(task, options) {
  try {
    if (!isPlainObject(options)) return false;
    if (ownData(task, 'status') !== 'running') return false;

    const rawRecovery = ownData(task, 'recovery');
    if (isPlainObject(rawRecovery) && (
      ownData(rawRecovery, 'blocked') === true
      || ownData(rawRecovery, 'state') === 'unresolved'
    )) {
      return false;
    }

    const rawLive = ownData(task, 'live');
    if (isPlainObject(rawLive)) {
      const liveError = ownData(rawLive, 'error');
      const liveEndedAt = ownData(rawLive, 'endedAt');
      if (
        ownData(rawLive, 'stopping') === true
        || ownData(rawLive, 'failed') === true
        || ownData(rawLive, 'complete') === true
        || (liveEndedAt !== undefined && liveEndedAt !== null)
        || (typeof liveError === 'string' && liveError.trim().length > 0)
        || (liveError !== null && typeof liveError === 'object')
      ) {
        return false;
      }
    }

    const rawAttempts = ownData(task, 'attempts');
    if (!Array.isArray(rawAttempts) || rawAttempts.length === 0) return false;
    const attempt = rawAttempts[rawAttempts.length - 1];
    if (!isPlainObject(attempt)) return false;

    const attemptId = ownData(attempt, 'id');
    if (!isCanonicalAttemptId(attemptId)) {
      return false;
    }

    const attemptStatus = ownData(attempt, 'status');
    if (attemptStatus !== undefined && attemptStatus !== 'running') return false;

    const attemptEnded = ownData(attempt, 'ended');
    if (attemptEnded !== undefined && attemptEnded !== null) return false;

    const rawAttemptRecovery = ownData(attempt, 'recovery');
    if (isPlainObject(rawAttemptRecovery) && ownData(rawAttemptRecovery, 'state') === 'unresolved') {
      return false;
    }

    const rawExecution = ownData(attempt, 'execution');
    if (
      !isPlainObject(rawExecution)
      || ownData(rawExecution, 'phase') !== 'dispatching'
      || ownData(rawExecution, 'settled') === true
    ) {
      return false;
    }

    const rawProgress = ownData(options, 'progress');
    if (!isPlainObject(rawProgress)) return false;

    const optAttemptId = ownData(options, 'attemptId');
    const progAttemptId = ownData(rawProgress, 'attemptId');
    if (optAttemptId !== undefined && !isCanonicalAttemptId(optAttemptId)) {
      return false;
    }
    if (progAttemptId !== undefined && !isCanonicalAttemptId(progAttemptId)) {
      return false;
    }
    if (optAttemptId !== undefined && progAttemptId !== undefined && optAttemptId !== progAttemptId) {
      return false;
    }
    const boundAttemptId = optAttemptId ?? progAttemptId;
    if (boundAttemptId === undefined || boundAttemptId !== attemptId) {
      return false;
    }

    if (ownData(rawProgress, 'phase') !== 'stalled' || ownData(rawProgress, 'stalled') !== true) {
      return false;
    }
    if (
      ownData(rawProgress, 'failed') === true
      || ownData(rawProgress, 'complete') === true
      || ownData(rawProgress, 'waiting') === true
      || ownData(rawProgress, 'stopping') === true
      || ownData(rawProgress, 'available') === false
    ) {
      return false;
    }

    if (ownData(rawProgress, 'clockAnomaly') === true) {
      return false;
    }
    const clockAnomalyReason = ownData(rawProgress, 'clockAnomalyReason');
    if (clockAnomalyReason !== undefined && clockAnomalyReason !== null) {
      return false;
    }

    if (
      ownData(rawProgress, 'measured') === false
      || ownData(rawProgress, 'trustworthy') === false
      || ownData(rawProgress, 'estimated') === true
      || ownData(rawProgress, 'inferred') === true
      || ownData(rawProgress, 'simulated') === true
      || ownData(rawProgress, 'stepSamplesValid') === false
    ) {
      return false;
    }

    const rawSource = ownData(rawProgress, 'source');
    if (rawSource !== undefined && rawSource !== null && !isAllowedMeasuredSource(rawSource)) {
      return false;
    }

    const heartbeat = ownData(rawProgress, 'heartbeat');
    if (heartbeat !== undefined && heartbeat !== null) {
      if (typeof heartbeat !== 'number' || !Number.isFinite(heartbeat) || heartbeat < 0 || heartbeat > MAX_DATE_MS) {
        return false;
      }
    }
    const heartbeatAgeMs = ownData(rawProgress, 'heartbeatAgeMs');
    if (heartbeatAgeMs !== undefined && heartbeatAgeMs !== null) {
      if (typeof heartbeatAgeMs !== 'number' || !Number.isFinite(heartbeatAgeMs) || heartbeatAgeMs < 0 || heartbeatAgeMs > MAX_DATE_MS) {
        return false;
      }
    }

    const lastActivity = ownData(rawProgress, 'lastActivity');
    if (typeof lastActivity !== 'number' || !Number.isFinite(lastActivity) || lastActivity < 0 || lastActivity > MAX_DATE_MS) {
      return false;
    }

    const lastActivityAt = ownData(rawProgress, 'lastActivityAt');
    if (lastActivityAt !== undefined && lastActivityAt !== null) {
      const parsedAt = parseTimestampMs(lastActivityAt);
      if (parsedAt === null || Math.abs(parsedAt - lastActivity) >= 1) {
        return false;
      }
    }

    const idleMs = ownData(rawProgress, 'idleMs');
    if (typeof idleMs !== 'number' || !Number.isFinite(idleMs) || idleMs < STALL_THRESHOLD_MS || idleMs > MAX_DATE_MS) {
      return false;
    }

    const attemptStartedMs = parseTimestampMs(ownData(attempt, 'started'));
    if (attemptStartedMs === null || lastActivity < attemptStartedMs) {
      return false;
    }

    const elapsedMs = ownData(rawProgress, 'elapsedMs');
    if (elapsedMs === null) {
      return false;
    }
    if (elapsedMs !== undefined) {
      if (
        typeof elapsedMs !== 'number'
        || !Number.isFinite(elapsedMs)
        || elapsedMs < 0
        || idleMs > elapsedMs
        || (lastActivity - attemptStartedMs) + idleMs > elapsedMs
      ) {
        return false;
      }
    }

    const dispatchedAtMs = parseTimestampMs(ownData(rawExecution, 'dispatchedAt'));
    if (dispatchedAtMs === null || dispatchedAtMs < attemptStartedMs || lastActivity < dispatchedAtMs) {
      return false;
    }

    const stepSamplesValid = ownData(rawProgress, 'stepSamplesValid');
    const completedSteps = ownData(rawProgress, 'completedSteps');
    const stepRate = ownData(rawProgress, 'stepRate');
    const currentStep = ownData(rawProgress, 'currentStep');
    const hasMeasuredOverallSteps = stepSamplesValid === true
      && typeof completedSteps === 'number' && Number.isSafeInteger(completedSteps) && completedSteps > 0
      && typeof stepRate === 'number' && Number.isFinite(stepRate) && stepRate > 0;
    const hasMeasuredCurrentStep = stepSamplesValid === true
      && isPlainObject(currentStep)
      && typeof ownData(currentStep, 'completed') === 'number'
      && Number.isSafeInteger(ownData(currentStep, 'completed'))
      && ownData(currentStep, 'completed') > 0
      && typeof ownData(currentStep, 'rate') === 'number'
      && Number.isFinite(ownData(currentStep, 'rate'))
      && ownData(currentStep, 'rate') > 0;
    const chars = ownData(rawProgress, 'chars');
    const hasObservedOutput = typeof chars === 'number' && Number.isSafeInteger(chars) && chars > 0;
    if (!hasMeasuredOverallSteps && !hasMeasuredCurrentStep && !hasObservedOutput) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Derive a single task-level attention entry from persisted task state and an
 * optional host-computed progress snapshot.
 *
 * Caller boundary and trust model:
 * - One-argument calls `attentionFor(task)` (including `tasks.map(attentionFor)`,
 *   where the second argument is a numeric index) preserve exact pre-existing
 *   behavior, returning `{ id: task.id, title: task.title, status: task.status, reasons }`
 *   without trimming/modifying existing task fields or inferring a stall from
 *   `task.live`, `task.progress`, or elapsed time.
 * - The optional `options` object `{ attemptId, progress }` is an in-process
 *   trusted host boundary. Arbitrary caller strings or booleans (such as
 *   `trusted: true`, `provenance: 'host'`, or `source: 'worker'`) do not prove
 *   trusted host provenance.
 * - `attemptId` requires exact canonical equality (non-empty, no control
 *   characters, no leading/trailing whitespace) against the current attempt's `id`,
 *   and `attempt.execution.dispatchedAt` must be a valid timestamp with
 *   `lastActivity >= dispatchedAt >= started`.
 * - Because `describeProgress(...)` sets `stepSamplesValid: true` even for empty
 *   `steps: {}` (and does not expose `samplesCount` or `lastProgressAt` on its
 *   return object), positive step-only stall proof requires `stepSamplesValid === true`
 *   with `completed > 0` and `rate > 0` (either overall `completedSteps`/`stepRate`
 *   or `currentStep.completed`/`currentStep.rate`) or observed output (`chars > 0`).
 *   Single-sample step runs without output fail closed under the current progress contract.
 * - Future server and telemetry wiring (for example in `server.mjs`) must
 *   compute `progress` server-side from authoritative host-observed run state
 *   via `describeProgress(...)`, bind `attemptId` to the server-owned current
 *   attempt, and never pass raw client, browser, or provider payloads here.
 * - `reasons` only uses static generic reason labels so raw progress diagnostics,
 *   recovery hold messages, secrets, and provider error text are never passed through.
 */
function safeRetryHold(task) {
  try {
    const attempts = task.attempts;
    if (attempts !== undefined && attempts !== null && typeof attempts?.at !== 'function') {
      return retryHold({status: task.status, attempts: undefined});
    }
    return retryHold(task);
  } catch {
    return null;
  }
}

export function attentionFor(task, options = undefined) {
  if (task === null || typeof task !== 'object') return null;

  try {
    const reasons = [];
    if (task.status === 'draft') pushUniqueReason(reasons, 'Approval needed');
    if (task.status === 'review') {
      pushUniqueReason(reasons, 'Proposal needs review');
      try {
        if (task.attempts?.at?.(-1)?.checks?.some?.(check => check && !check.pass)) {
          pushUniqueReason(reasons, 'A check failed');
        }
      } catch {
        // Malformed review check metadata must not discard the top-level review reason.
      }
    }
    if (task.status === 'failed') pushUniqueReason(reasons, 'Run failed');
    if (task.status === 'interrupted') pushUniqueReason(reasons, 'Run interrupted');
    if (safeRetryHold(task)) pushUniqueReason(reasons, 'Earlier outcome needs recovery');
    if (hasGenuineActiveStall(task, options)) {
      pushUniqueReason(reasons, POSSIBLE_STALL_REASON);
    }

    return reasons.length ? {id: task.id, title: task.title, status: task.status, reasons} : null;
  } catch {
    return null;
  }
}
