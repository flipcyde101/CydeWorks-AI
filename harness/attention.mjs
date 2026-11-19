import {retryHold} from './recovery.mjs';

const STALL_THRESHOLD_MS = 60_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_ID_LENGTH = 200;
const MAX_TITLE_LENGTH = 200;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/;
const CONTROL_CHARS_GLOBAL_RE = /[\u0000-\u001F\u007F-\u009F]+/g;

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

function sanitizeText(value, maxLength = MAX_TITLE_LENGTH) {
  if (typeof value !== 'string') return null;
  let text = value.replace(CONTROL_CHARS_GLOBAL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const stackIdx = text.search(/\s+at\s+(?:async\s+)?[^\s(]+\s*\((?:file:\/\/\/|node:|\/|[A-Za-z]:[\\/])[^)]+:\d+:\d+\)/);
  if (stackIdx > 0) {
    text = text.slice(0, stackIdx).trim();
  } else if (stackIdx === 0 || /^(?:TypeError|ReferenceError|SyntaxError|RangeError|Error):\s*.*\bat\s+/.test(text)) {
    return 'Task';
  }

  text = text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi, '[redacted credential]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [redacted]')
    .replace(/(["']?)(api[_-]?key|access[_-]?key|secret|password|passwd|token|authorization|cookie|session[_-]?key)\1\s*([:=])\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;'"`}\]]+)/gi, '$1$2$1$3[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|gho_[A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{16,})\b/g, '[redacted credential]')
    .replace(/\b(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1[redacted]@')
    .replace(/\bfile:\/\/\/[^\s,;)]+/gi, '[redacted path]')
    .replace(/(^|[\s(])[A-Za-z]:[\\/][^\s,;)]+/g, '$1[redacted path]')
    .replace(/(^|[\s(])\/(?:Users|home|var|etc|tmp|opt|srv|root)\/[^\s,;)]+/g, '$1[redacted path]')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return null;
  if (text.length > maxLength) {
    return text.slice(0, Math.max(1, maxLength - 3)).trimEnd() + '...';
  }
  return text;
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

function hasGenuineActiveStall(status, attempt, recoveryBlocked, liveStopping, options) {
  if (status !== 'running') return false;
  if (recoveryBlocked || liveStopping) return false;
  if (!attempt || typeof attempt.id !== 'string' || !attempt.id) return false;
  if (attempt.status !== undefined && attempt.status !== 'running') return false;
  if (attempt.ended !== undefined && attempt.ended !== null) return false;
  if (attempt.recovery?.state === 'unresolved') return false;
  if (attempt.execution?.phase !== 'dispatching' || attempt.execution?.settled === true) return false;

  try {
    if (!isPlainObject(options)) return false;

    const rawProgress = ownData(options, 'progress');
    if (!isPlainObject(rawProgress)) return false;

    const optAttemptId = ownData(options, 'attemptId');
    const progAttemptId = ownData(rawProgress, 'attemptId');
    if (
      optAttemptId !== undefined
      && (typeof optAttemptId !== 'string' || CONTROL_CHARS_RE.test(optAttemptId) || !optAttemptId.trim())
    ) {
      return false;
    }
    if (
      progAttemptId !== undefined
      && (typeof progAttemptId !== 'string' || CONTROL_CHARS_RE.test(progAttemptId) || !progAttemptId.trim())
    ) {
      return false;
    }
    const cleanOptId = typeof optAttemptId === 'string' ? optAttemptId.trim() : null;
    const cleanProgId = typeof progAttemptId === 'string' ? progAttemptId.trim() : null;
    if (cleanOptId !== null && cleanProgId !== null && cleanOptId !== cleanProgId) {
      return false;
    }
    const boundAttemptId = cleanOptId ?? cleanProgId;
    if (!boundAttemptId || boundAttemptId !== attempt.id) {
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

    const attemptStartedMs = parseTimestampMs(attempt.started);
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

    if (attempt.execution.dispatchedAt !== undefined && attempt.execution.dispatchedAt !== null) {
      const dispatchedAtMs = parseTimestampMs(attempt.execution.dispatchedAt);
      if (dispatchedAtMs === null || dispatchedAtMs < attemptStartedMs || lastActivity < dispatchedAtMs) {
        return false;
      }
    }

    const stepSamplesValid = ownData(rawProgress, 'stepSamplesValid');
    const chars = ownData(rawProgress, 'chars');
    const hasMeasuredSteps = stepSamplesValid === true;
    const hasObservedOutput = typeof chars === 'number' && Number.isSafeInteger(chars) && chars > 0;
    if (!hasMeasuredSteps && !hasObservedOutput) {
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
 *   where the second argument is a numeric index) preserve existing behavior and
 *   never infer a stall from `task.live`, `task.progress`, or elapsed time.
 * - The optional `options` object `{ attemptId, progress }` is an in-process
 *   trusted host boundary. Arbitrary caller strings or booleans (such as
 *   `trusted: true`, `provenance: 'host'`, or `source: 'worker'`) do not prove
 *   trusted host provenance.
 * - Future server and telemetry wiring (for example in `server.mjs`) must
 *   compute `progress` server-side from authoritative host-observed run state
 *   via `describeProgress(...)`, bind `attemptId` to the server-owned current
 *   attempt, and never pass raw client, browser, or provider payloads here.
 * - Output is minimized to `{ id, title, status, reasons }` using static
 *   generic reason labels so raw diagnostics, secrets, and provider error text
 *   are never surfaced.
 */
export function attentionFor(task, options = undefined) {
  let id;
  let title;
  let status;
  let safeLatestAttempt = null;
  let recoveryBlocked = false;
  let liveStopping = false;

  try {
    if (!isPlainObject(task)) return null;

    const rawId = ownData(task, 'id');
    if (typeof rawId !== 'string' || CONTROL_CHARS_RE.test(rawId)) return null;
    const trimmedId = rawId.trim();
    if (!trimmedId || trimmedId.length > MAX_ID_LENGTH) return null;
    id = trimmedId;

    const rawStatus = ownData(task, 'status');
    if (typeof rawStatus !== 'string' || !rawStatus.trim() || CONTROL_CHARS_RE.test(rawStatus)) return null;
    status = rawStatus.trim();

    const rawTitle = ownData(task, 'title');
    if (rawTitle === undefined) {
      title = undefined;
    } else if (rawTitle === null) {
      title = null;
    } else if (typeof rawTitle === 'string') {
      title = sanitizeText(rawTitle, MAX_TITLE_LENGTH) ?? '';
    } else {
      return null;
    }

    const rawRecovery = ownData(task, 'recovery');
    if (isPlainObject(rawRecovery) && (
      ownData(rawRecovery, 'blocked') === true
      || ownData(rawRecovery, 'state') === 'unresolved'
    )) {
      recoveryBlocked = true;
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
        || isPlainObject(liveError)
      ) {
        liveStopping = true;
      }
    }

    const rawAttempts = ownData(task, 'attempts');
    if (Array.isArray(rawAttempts) && rawAttempts.length > 0) {
      const candidate = rawAttempts[rawAttempts.length - 1];
      if (isPlainObject(candidate)) {
        const rawAttemptId = ownData(candidate, 'id');
        const rawAttemptStatus = ownData(candidate, 'status');
        const rawProvider = ownData(candidate, 'provider');
        const rawStarted = ownData(candidate, 'started');
        const rawEnded = ownData(candidate, 'ended');
        const rawChecks = ownData(candidate, 'checks');
        const rawAttemptRecovery = ownData(candidate, 'recovery');
        const rawExecution = ownData(candidate, 'execution');

        let checks;
        if (Array.isArray(rawChecks)) {
          checks = [];
          for (let i = 0; i < rawChecks.length; i += 1) {
            const check = rawChecks[i];
            if (isPlainObject(check)) {
              checks.push({pass: Boolean(ownData(check, 'pass'))});
            }
          }
        }

        let recovery;
        if (isPlainObject(rawAttemptRecovery)) {
          const state = ownData(rawAttemptRecovery, 'state');
          const rawMessage = ownData(rawAttemptRecovery, 'message');
          recovery = {
            state: typeof state === 'string' ? state : undefined,
            message: typeof rawMessage === 'string' && rawMessage.length > 0
              ? 'Earlier outcome needs recovery.'
              : undefined,
          };
        }

        let execution;
        if (isPlainObject(rawExecution)) {
          const phase = ownData(rawExecution, 'phase');
          const dispatchedAt = ownData(rawExecution, 'dispatchedAt');
          const settled = ownData(rawExecution, 'settled');
          execution = {
            phase: typeof phase === 'string' ? phase : undefined,
            settled: settled === true,
            dispatchedAt: dispatchedAt === undefined || dispatchedAt === null
              ? dispatchedAt
              : (typeof dispatchedAt === 'string' || typeof dispatchedAt === 'number' ? dispatchedAt : Number.NaN),
          };
        }

        safeLatestAttempt = {
          id: typeof rawAttemptId === 'string' && !CONTROL_CHARS_RE.test(rawAttemptId)
            ? rawAttemptId.trim()
            : undefined,
          status: rawAttemptStatus === undefined
            ? undefined
            : typeof rawAttemptStatus === 'string'
              ? rawAttemptStatus.trim()
              : null,
          provider: typeof rawProvider === 'string' ? rawProvider : undefined,
          started: typeof rawStarted === 'string' || typeof rawStarted === 'number' ? rawStarted : undefined,
          ended: rawEnded === undefined ? undefined : rawEnded,
          checks,
          recovery,
          execution,
        };
      }
    }
  } catch {
    return null;
  }

  const safeTask = {
    id,
    title,
    status,
    attempts: safeLatestAttempt ? [safeLatestAttempt] : [],
  };

  const reasons = [];
  if (status === 'draft') pushUniqueReason(reasons, 'Approval needed');
  if (status === 'review') {
    pushUniqueReason(reasons, 'Proposal needs review');
    if (safeLatestAttempt?.checks?.some(check => !check.pass)) {
      pushUniqueReason(reasons, 'A check failed');
    }
  }
  if (status === 'failed') pushUniqueReason(reasons, 'Run failed');
  if (status === 'interrupted') pushUniqueReason(reasons, 'Run interrupted');
  if (retryHold(safeTask)) pushUniqueReason(reasons, 'Earlier outcome needs recovery');
  if (hasGenuineActiveStall(status, safeLatestAttempt, recoveryBlocked, liveStopping, options)) {
    pushUniqueReason(reasons, POSSIBLE_STALL_REASON);
  }

  return reasons.length ? {id, title, status, reasons} : null;
}
