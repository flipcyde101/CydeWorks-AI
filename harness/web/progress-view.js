// Pure presentation mapper for validated progress data returned by describeProgress.
// Dependency-free: no DOM, HTML, file, network, timer, or process access.
// Reads only own data properties of plain objects inside local try/catch so
// accessor getters, throwing Proxies, unknown fields, and arbitrary objects
// are never invoked or leaked into UI output.

const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_TEXT_LENGTH = 400;

const PHASE_LABELS = {
  waiting: 'Waiting',
  active: 'Running',
  stalled: 'Possibly stalled',
  failed: 'Failed',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
  stopping: 'Stopping',
  complete: 'Complete',
  unavailable: 'Unavailable',
};

const UNAVAILABLE_EXPLANATION = 'Progress data is unavailable or malformed.';

const SAFE_FAILURE_STATUSES = new Set([
  'Attempt failed',
  'Incomplete termination',
]);

const ALLOWED_MEASURED_UNITS = new Map([
  ['steps', 'step'],
  ['sub-steps', 'sub-step'],
  ['files', 'file'],
  ['checks', 'check'],
  ['tests', 'test'],
  ['tasks', 'task'],
  ['items', 'item'],
  ['stages', 'stage'],
  ['phases', 'phase'],
  ['cases', 'case'],
  ['suites', 'suite'],
  ['batches', 'batch'],
  ['chunks', 'chunk'],
  ['pages', 'page'],
  ['jobs', 'job'],
  ['calls', 'call'],
  ['tools', 'tool'],
  ['actions', 'action'],
  ['operations', 'operation'],
  ['passes', 'pass'],
  ['iterations', 'iteration'],
  ['epochs', 'epoch'],
  ['milestones', 'milestone'],
  ['commands', 'command'],
  ['shards', 'shard'],
  ['partitions', 'partition'],
  ['records', 'record'],
  ['rows', 'row'],
  ['modules', 'module'],
  ['packages', 'package'],
  ['targets', 'target'],
  ['units', 'unit'],
]);

const CONTROLLED_FAILURE_SUMMARY =
  'Attempt failed (code: E_ATTEMPT_FAILED). Detailed diagnostics are omitted; review recovery status before retrying.';

function validateUnitPair(rawUnit, rawUnitSingular) {
  if (typeof rawUnit !== 'string' || !rawUnit.trim()) {
    return { plural: 'units', singular: 'unit', known: false };
  }
  const normalizedPlural = rawUnit.trim().toLowerCase();
  const expectedSingular = ALLOWED_MEASURED_UNITS.get(normalizedPlural);
  if (!expectedSingular) {
    return { plural: 'units', singular: 'unit', known: false };
  }
  if (rawUnitSingular !== undefined) {
    if (typeof rawUnitSingular !== 'string' || rawUnitSingular.trim().toLowerCase() !== expectedSingular) {
      return { plural: 'units', singular: 'unit', known: false };
    }
  }
  return { plural: normalizedPlural, singular: expectedSingular, known: true };
}

function formatUnitCount(count, unitPair) {
  return count === 1 ? unitPair.singular : unitPair.plural;
}

function isSafeFailureExplanation(text) {
  if (text === null) return false;
  if (text === 'The attempt failed before completion.') return true;
  const match = text.match(/^Completion was reported before all measured (?:current-step )?([a-z-]+) finished\.$/);
  if (!match) return false;
  return ALLOWED_MEASURED_UNITS.has(match[1]);
}

function isSafeFailureRemaining(text) {
  if (text === null) return false;
  if (text === 'Review the problem and recovery status before retrying.') return true;
  const match = text.match(/^\d+ of \d+ (?:current-step )?([a-z-]+) remaining\.$/);
  if (!match) return false;
  return ALLOWED_MEASURED_UNITS.has(match[1]);
}

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

function sanitizeText(value, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string') return null;
  let text = value.replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  // Suppress stack trace frames and credential or filesystem leaks if present.
  const stackIdx = text.search(/\s+at\s+(?:async\s+)?[^\s(]+\s*\((?:file:\/\/\/|node:|\/|[A-Za-z]:[\\/])[^)]+:\d+:\d+\)/);
  if (stackIdx > 0) {
    text = text.slice(0, stackIdx).trim();
  } else if (stackIdx === 0 || /^(?:TypeError|ReferenceError|SyntaxError|RangeError|Error):\s*.*\bat\s+/.test(text)) {
    return 'Internal error details omitted.';
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

function validNonNegSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validPosSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function validNonNegFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function validTimestampMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DATE_MS ? value : null;
}

function computeSafePercent(completed, total) {
  if (completed === null || total === null || total <= 0) return null;
  if (completed === total) return 100;
  const basisPoints = Number((BigInt(completed) * 10000n) / BigInt(total));
  const pct = basisPoints / 100;
  return pct >= 100 ? 99.99 : pct;
}

function formatPercent(percent, completed = null, total = null) {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  const incomplete = completed !== null && total !== null && completed < total;
  if (incomplete && percent >= 99.995) return '99.99%';
  if (Number.isInteger(percent)) return `${percent}%`;
  const formatted = Number(percent.toFixed(2));
  if (incomplete && formatted >= 100) return '99.99%';
  return `${formatted}%`;
}

function formatRate(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) return null;
  if (rate === 0) return '0';
  if (rate >= 10) return rate.toFixed(1);
  if (rate >= 0.01) return String(Number(rate.toFixed(2)));
  return rate.toExponential(2);
}

function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'Unavailable';
  if (ms < 999.5) return `${Math.round(ms)} ms`;
  if (ms < 59_500) {
    const secs = ms / 1000;
    return `${secs < 9.95 ? secs.toFixed(1) : Math.round(secs)} s`;
  }
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  if (minutes < 60) return `${minutes} min ${seconds} s`;
  const hours = Math.floor(minutes / 60);
  if (!Number.isFinite(hours)) return 'Unavailable';
  return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
}

function safeLocalClock(ms, customFormatter = null) {
  const validMs = validTimestampMs(ms);
  if (validMs === null) return null;
  if (typeof customFormatter === 'function') {
    try {
      const formatted = customFormatter(validMs);
      const sanitized = sanitizeText(formatted, 64);
      if (sanitized !== null) return sanitized;
    } catch {
      // Ignore custom formatter failure and fall back to standard local clock.
    }
  }
  const date = new Date(validMs);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return null;
  }
}

function ensureUnavailablePrefix(reason, fallback) {
  const clean = sanitizeText(reason);
  if (!clean) return fallback;
  if (/^(?:unavailable|unknown|incomplete)/i.test(clean)) return clean;
  return `Unavailable: ${clean}`;
}

function formatWorkRateReason(reason, unitPair) {
  if (!reason) return null;
  if (/^No measured(?: [a-z-]+)? counters were supplied\.?$/i.test(reason)) {
    return 'No measured work counters.';
  }
  if (/^Insufficient measured (?:step|[a-z-]+) samples to calculate rate\.?$/i.test(reason)) {
    return unitPair.known
      ? `Insufficient measured ${unitPair.singular} samples to calculate rate.`
      : 'Insufficient measured work samples to calculate rate.';
  }
  if (/^(?:Step|[A-Z][a-z-]+) samples do not span a positive elapsed interval\.?$/i.test(reason)) {
    if (!unitPair.known) return 'Work samples do not span a positive elapsed interval.';
    const cap = unitPair.singular.charAt(0).toUpperCase() + unitPair.singular.slice(1);
    return `${cap} samples do not span a positive elapsed interval.`;
  }
  return reason.replace(/\s+were supplied\b/gi, '');
}

function row(key, label, value, available, reason = null) {
  return {
    key,
    label,
    value,
    available: Boolean(available),
    reason: available ? null : (reason ?? value),
  };
}

function buildResult({
  available,
  phase,
  status,
  explanation,
  clockAnomaly,
  clockAnomalyReason,
  counts,
  rows,
  announcement,
}) {
  const stateLabel = PHASE_LABELS[phase] ?? PHASE_LABELS.unavailable;
  const pairs = rows.map((entry) => [entry.label, entry.value]);
  const text = [
    `${stateLabel}: ${status}`,
    explanation,
    ...rows.map((entry) => `${entry.label}: ${entry.value}`),
  ].join('\n');

  return {
    available,
    phase,
    stateLabel,
    waiting: phase === 'waiting',
    stalled: phase === 'stalled',
    failed: phase === 'failed',
    complete: phase === 'complete',
    clockAnomaly,
    clockAnomalyReason,
    status,
    explanation,
    announcement,
    counts,
    rows,
    pairs,
    text,
  };
}

function unavailableResult() {
  const reason = UNAVAILABLE_EXPLANATION;
  const rows = [
    row('status', 'Status', 'Progress unavailable', false, reason),
    row('currentStep', 'Current step', 'Unavailable', false, reason),
    row('completed', 'Completed', 'Unavailable', false, reason),
    row('remaining', 'Remaining', 'Unknown', false, reason),
    row('rate', 'Rate', 'Unavailable', false, reason),
    row('elapsed', 'Elapsed', 'Unavailable', false, reason),
    row('lastActivity', 'Latest activity', 'Unavailable', false, reason),
    row('heartbeat', 'Heartbeat', 'Unavailable', false, reason),
    row('currentStepEta', 'Current step ETA', 'Unavailable', false, reason),
    row('overallEta', 'Overall ETA', 'Unavailable', false, reason),
    row('completion', 'Projected local completion', 'Unavailable', false, reason),
  ];
  return buildResult({
    available: false,
    phase: 'unavailable',
    status: 'Progress unavailable',
    explanation: reason,
    clockAnomaly: false,
    clockAnomalyReason: null,
    counts: {
      totalKnown: false,
      unit: null,
      unitSingular: null,
      completedSteps: null,
      totalSteps: null,
      remainingSteps: null,
      doneTotal: null,
      percent: null,
    },
    rows,
    announcement: 'Progress data is unavailable.',
  });
}

function snapshotInput(progress, options) {
  let plain = false;
  let customFormatter = null;
  let raw = null;

  try {
    if (isPlainObject(options)) {
      const fn = ownData(options, 'formatLocalTime');
      if (typeof fn === 'function') customFormatter = fn;
    }

    plain = isPlainObject(progress);
    if (!plain) {
      return { plain: false, raw: null, customFormatter };
    }

    const rawStep = ownData(progress, 'currentStep');
    let currentStep = null;
    if (isPlainObject(rawStep)) {
      currentStep = {
        index: ownData(rawStep, 'index'),
        label: ownData(rawStep, 'label'),
        unit: ownData(rawStep, 'unit'),
        unitSingular: ownData(rawStep, 'unitSingular'),
        completed: ownData(rawStep, 'completed'),
        total: ownData(rawStep, 'total'),
        remaining: ownData(rawStep, 'remaining'),
        doneTotal: ownData(rawStep, 'doneTotal'),
        percent: ownData(rawStep, 'percent'),
        rate: ownData(rawStep, 'rate'),
        etaMs: ownData(rawStep, 'etaMs'),
        eta: ownData(rawStep, 'eta'),
      };
    }

    const rawReasons = ownData(progress, 'unavailableReasons');
    let unavailableReasons = null;
    if (isPlainObject(rawReasons)) {
      unavailableReasons = {
        rate: ownData(rawReasons, 'rate'),
        currentStepEta: ownData(rawReasons, 'currentStepEta'),
        overallEta: ownData(rawReasons, 'overallEta'),
        completion: ownData(rawReasons, 'completion'),
      };
    }

    raw = {
      status: ownData(progress, 'status'),
      explanation: ownData(progress, 'explanation'),
      phase: ownData(progress, 'phase'),
      waiting: ownData(progress, 'waiting'),
      stalled: ownData(progress, 'stalled'),
      failed: ownData(progress, 'failed'),
      complete: ownData(progress, 'complete'),
      clockAnomaly: ownData(progress, 'clockAnomaly'),
      clockAnomalyReason: ownData(progress, 'clockAnomalyReason'),
      elapsedMs: ownData(progress, 'elapsedMs'),
      chars: ownData(progress, 'chars'),
      rate: ownData(progress, 'rate'),
      heartbeat: ownData(progress, 'heartbeat'),
      heartbeatAgeMs: ownData(progress, 'heartbeatAgeMs'),
      lastActivity: ownData(progress, 'lastActivity'),
      idleMs: ownData(progress, 'idleMs'),
      remaining: ownData(progress, 'remaining'),
      totalKnown: ownData(progress, 'totalKnown'),
      unit: ownData(progress, 'unit'),
      unitSingular: ownData(progress, 'unitSingular'),
      completedSteps: ownData(progress, 'completedSteps'),
      totalSteps: ownData(progress, 'totalSteps'),
      remainingSteps: ownData(progress, 'remainingSteps'),
      doneTotal: ownData(progress, 'doneTotal'),
      percent: ownData(progress, 'percent'),
      stepRate: ownData(progress, 'stepRate'),
      stepSamplesValid: ownData(progress, 'stepSamplesValid'),
      stepRejectionReason: ownData(progress, 'stepRejectionReason'),
      currentStep,
      currentStepEtaMs: ownData(progress, 'currentStepEtaMs'),
      currentStepEta: ownData(progress, 'currentStepEta'),
      eta: ownData(progress, 'eta'),
      overallEtaMs: ownData(progress, 'overallEtaMs'),
      overallEta: ownData(progress, 'overallEta'),
      projectedCompletionMs: ownData(progress, 'projectedCompletionMs'),
      completion: ownData(progress, 'completion'),
      unavailableReasons,
    };
  } catch {
    return { plain: false, raw: null, customFormatter: null };
  }

  return { plain, raw, customFormatter };
}

function normalizePhase(raw) {
  if (raw.failed === true || raw.phase === 'failed') return 'failed';
  if (raw.phase === 'interrupted') return 'interrupted';
  if (raw.phase === 'cancelled') return 'cancelled';
  if (raw.phase === 'stopping') return 'stopping';
  if (raw.stalled === true || raw.phase === 'stalled') return 'stalled';
  if (raw.complete === true || raw.phase === 'complete') return 'complete';
  if (raw.waiting === true || raw.phase === 'waiting') return 'waiting';
  if (raw.phase === 'active') return 'active';
  return 'unavailable';
}

function formatStatusValue(phase, rawStatus) {
  const label = PHASE_LABELS[phase] ?? PHASE_LABELS.unavailable;
  if (!rawStatus) return label;
  if (phase === 'active') {
    if (/^Running\s+Running\b(?!-)/i.test(rawStatus)) {
      return rawStatus.replace(/^Running\s+Running\b/i, 'Running');
    }
    if (/^Running\s+Run(?=\s+[a-z0-9]|\s*\(|$)/i.test(rawStatus)) {
      return rawStatus.replace(/^Running\s+Run\b/i, 'Running');
    }
    return rawStatus;
  }
  if (phase === 'waiting' && !/^waiting\b/i.test(rawStatus)) return `Waiting: ${rawStatus}`;
  if (phase === 'stalled' && !/stalled/i.test(rawStatus)) return `Possibly stalled: ${rawStatus}`;
  if (phase === 'failed' && !/(?:failed|incomplete)/i.test(rawStatus)) return `Failed: ${rawStatus}`;
  if (phase === 'interrupted' && !/interrupted/i.test(rawStatus)) return `Interrupted: ${rawStatus}`;
  if (phase === 'cancelled' && !/cancel/i.test(rawStatus)) return `Cancelled: ${rawStatus}`;
  if (phase === 'stopping' && !/stop/i.test(rawStatus)) return `Stopping: ${rawStatus}`;
  if (phase === 'complete' && !/(?:complete|accepted|rejected)/i.test(rawStatus)) return `Complete: ${rawStatus}`;
  return rawStatus;
}

export function presentProgress(progress, options = undefined) {
  const { plain, raw, customFormatter } = snapshotInput(progress, options);
  if (!plain || raw === null) {
    return unavailableResult();
  }

  let phase = normalizePhase(raw);
  if (phase === 'unavailable') {
    return unavailableResult();
  }

  let clockAnomalyReason = sanitizeText(raw.clockAnomalyReason);
  const hasClockAnomaly = raw.clockAnomaly === true || clockAnomalyReason !== null;
  if (hasClockAnomaly && clockAnomalyReason === null) {
    clockAnomalyReason = 'Clock timestamps are inconsistent or out of range.';
  }

  let stepRejectionReason = sanitizeText(raw.stepRejectionReason);
  const stepSamplesValid = raw.stepSamplesValid === true ? true : raw.stepSamplesValid === false ? false : null;

  let totalKnown = false;
  let completedSteps = null;
  let totalSteps = null;
  let remainingSteps = null;
  let doneTotal = null;
  let percent = null;

  if (stepSamplesValid === false) {
    if (stepRejectionReason === null) {
      stepRejectionReason = 'Measured work counters were rejected.';
    }
  } else {
    const candidateTotal = raw.totalKnown === false ? null : validPosSafeInt(raw.totalSteps);
    const candidateCompleted = validNonNegSafeInt(raw.completedSteps);
    const candidateRemaining = validNonNegSafeInt(raw.remainingSteps);

    if (candidateTotal !== null && candidateCompleted !== null) {
      if (candidateCompleted > candidateTotal) {
        stepRejectionReason = stepRejectionReason ?? 'Completed count exceeds total count.';
      } else if (candidateRemaining !== null && candidateRemaining !== (candidateTotal - candidateCompleted)) {
        stepRejectionReason = stepRejectionReason ?? 'Remaining count does not match completed and total counts.';
      } else {
        totalKnown = true;
        totalSteps = candidateTotal;
        completedSteps = candidateCompleted;
        remainingSteps = candidateTotal - candidateCompleted;
        doneTotal = `${completedSteps}/${totalSteps}`;
        percent = computeSafePercent(completedSteps, totalSteps);
      }
    } else if (candidateTotal !== null) {
      totalKnown = true;
      totalSteps = candidateTotal;
    } else if (candidateCompleted !== null && raw.totalSteps == null) {
      completedSteps = candidateCompleted;
    }
  }

  const hasMeasuredOverallCounters = totalKnown
    || completedSteps !== null
    || validNonNegFinite(raw.stepRate) !== null;
  const overallUnit = stepSamplesValid === false || stepRejectionReason !== null || !hasMeasuredOverallCounters
    ? { plural: 'units', singular: 'unit', known: false }
    : validateUnitPair(raw.unit, raw.unitSingular);

  let currentStep = null;
  if (raw.currentStep !== null) {
    const cs = raw.currentStep;
    const csIndex = validNonNegSafeInt(cs.index);
    const csLabel = sanitizeText(cs.label);
    let csTotal = validPosSafeInt(cs.total);
    let csCompleted = validNonNegSafeInt(cs.completed);
    const csRemainingInput = validNonNegSafeInt(cs.remaining);
    let csRemaining = null;
    let csDoneTotal = null;
    let csPercent = null;
    let csValidCounters = true;

    if (csTotal !== null && csCompleted !== null) {
      if (csCompleted > csTotal || (csRemainingInput !== null && csRemainingInput !== (csTotal - csCompleted))) {
        csTotal = null;
        csCompleted = null;
        csValidCounters = false;
      } else {
        csRemaining = csTotal - csCompleted;
        csDoneTotal = `${csCompleted}/${csTotal}`;
        csPercent = computeSafePercent(csCompleted, csTotal);
      }
    } else if (cs.total !== undefined && cs.total !== null && csTotal === null) {
      csValidCounters = false;
    } else if (cs.completed !== undefined && cs.completed !== null && csCompleted === null) {
      csValidCounters = false;
    }

    const csRate = !hasClockAnomaly && stepSamplesValid !== false && csValidCounters
      ? validNonNegFinite(cs.rate)
      : null;
    const hasMeasuredSubCounters = csTotal !== null || csCompleted !== null || validNonNegFinite(cs.rate) !== null;
    const csUnit = csValidCounters && stepSamplesValid !== false && hasMeasuredSubCounters
      ? validateUnitPair(cs.unit, cs.unitSingular)
      : { plural: 'units', singular: 'unit', known: false };

    currentStep = {
      index: csIndex,
      label: csLabel,
      unit: csUnit.known ? csUnit.plural : null,
      unitSingular: csUnit.known ? csUnit.singular : null,
      unitPair: csUnit,
      completed: csCompleted,
      total: csTotal,
      remaining: csRemaining,
      doneTotal: csDoneTotal,
      percent: csPercent,
      rate: csRate,
      etaMs: csValidCounters ? validNonNegFinite(cs.etaMs) : null,
      eta: sanitizeText(cs.eta),
      validCounters: csValidCounters,
    };
  }

  // Never allow complete phase when measured counters still have remaining work.
  let statusText = sanitizeText(raw.status);
  let explanationText = sanitizeText(raw.explanation);
  let prematureComplete = false;
  if (phase === 'complete') {
    if (totalKnown && completedSteps !== null && totalSteps !== null && completedSteps < totalSteps) {
      prematureComplete = true;
      phase = 'failed';
      statusText = 'Incomplete termination';
      explanationText = `Completion was reported before all measured ${overallUnit.plural} finished.`;
    } else if (currentStep && currentStep.total !== null && currentStep.completed !== null && currentStep.completed < currentStep.total) {
      prematureComplete = true;
      phase = 'failed';
      statusText = 'Incomplete termination';
      explanationText = `Completion was reported before all measured current-step ${currentStep.unitPair.plural} finished.`;
    }
  }

  const status = formatStatusValue(
    phase,
    phase === 'failed'
      ? (SAFE_FAILURE_STATUSES.has(statusText) ? statusText : 'Attempt failed')
      : statusText,
  );
  const explanation = phase === 'failed'
    ? (isSafeFailureExplanation(explanationText) ? explanationText : CONTROLLED_FAILURE_SUMMARY)
    : (explanationText ?? `${PHASE_LABELS[phase]} state reported.`);

  const isTerminal = phase === 'complete' || phase === 'failed' || phase === 'interrupted' || phase === 'cancelled';
  const isBlocked = hasClockAnomaly
    || phase === 'stalled'
    || phase === 'failed'
    || phase === 'interrupted'
    || phase === 'cancelled'
    || phase === 'stopping';

  const blockedReason = hasClockAnomaly
    ? `Unavailable due to clock anomaly: ${clockAnomalyReason}`
    : prematureComplete
      ? 'Unavailable because completion was reported with remaining work.'
      : phase === 'stalled'
        ? 'Unavailable because the run appears stalled with no recent activity.'
        : phase === 'failed'
          ? 'Unavailable because the attempt failed.'
          : phase === 'interrupted'
            ? 'Unavailable because the run was interrupted.'
            : phase === 'cancelled'
              ? 'Unavailable because the request was cancelled.'
              : phase === 'stopping'
                ? 'Unavailable because stop was requested.'
                : null;

  const chars = validNonNegSafeInt(raw.chars);
  const charRate = hasClockAnomaly || isTerminal ? null : validNonNegFinite(raw.rate);
  const stepRate = hasClockAnomaly || stepSamplesValid === false ? null : validNonNegFinite(raw.stepRate);
  const elapsedMs = hasClockAnomaly ? null : validNonNegFinite(raw.elapsedMs);
  const heartbeat = validTimestampMs(raw.heartbeat);
  const heartbeatAgeMs = heartbeat !== null ? validNonNegFinite(raw.heartbeatAgeMs) : null;
  const lastActivity = validTimestampMs(raw.lastActivity);
  const idleMs = lastActivity !== null ? validNonNegFinite(raw.idleMs) : null;

  const reasonRate = sanitizeText(raw.unavailableReasons?.rate);
  const reasonCurrentEta = sanitizeText(raw.unavailableReasons?.currentStepEta);
  const reasonOverallEta = sanitizeText(raw.unavailableReasons?.overallEta);
  const reasonCompletion = sanitizeText(raw.unavailableReasons?.completion);
  const rawCurrentEtaText = sanitizeText(raw.currentStepEta ?? raw.eta ?? currentStep?.eta);
  const rawOverallEtaText = sanitizeText(raw.overallEta);
  const rawRemainingNote = sanitizeText(raw.remaining);
  const remainingNote = phase === 'failed'
    ? (isSafeFailureRemaining(rawRemainingNote)
      ? rawRemainingNote
      : 'Review recovery status before retrying.')
    : rawRemainingNote;

  const missingOverallDone = phase === 'complete' && totalKnown && completedSteps === null;
  const missingSubDone = phase === 'complete' && currentStep !== null && currentStep.total !== null && currentStep.completed === null;

  const overallExplicitlyUnavailable = reasonOverallEta !== null
    || (rawOverallEtaText !== null && /^unavailable/i.test(rawOverallEtaText));
  let overallEtaMs = null;
  if (!isBlocked && !overallExplicitlyUnavailable) {
    if (phase === 'complete') {
      if (!missingOverallDone && raw.overallEtaMs === 0) {
        overallEtaMs = 0;
      }
    } else if (totalKnown && completedSteps !== null && remainingSteps !== null && stepRate !== null && stepRate > 0) {
      overallEtaMs = validNonNegFinite(raw.overallEtaMs);
    }
  }

  const hasMeasuredCurrentSub = currentStep !== null
    && currentStep.total !== null
    && currentStep.completed !== null
    && currentStep.remaining !== null;
  const currentExplicitlyUnavailable = reasonCurrentEta !== null
    || (rawCurrentEtaText !== null && /^unavailable/i.test(rawCurrentEtaText));
  let currentStepEtaMs = null;
  if (!isBlocked && !currentExplicitlyUnavailable) {
    if (phase === 'complete') {
      if (!missingOverallDone && hasMeasuredCurrentSub && currentStep.remaining === 0 && (raw.currentStepEtaMs === 0 || currentStep.etaMs === 0)) {
        currentStepEtaMs = 0;
      }
    } else if (hasMeasuredCurrentSub) {
      const authoritativeSubEtaMs = raw.currentStepEtaMs ?? currentStep.etaMs;
      if (currentStep.remaining === 0) {
        if (authoritativeSubEtaMs === 0) {
          currentStepEtaMs = 0;
        }
      } else if (currentStep.rate !== null && currentStep.rate > 0) {
        currentStepEtaMs = validNonNegFinite(authoritativeSubEtaMs);
      }
    }
  }

  let projectedCompletionMs = null;
  if (!hasClockAnomaly) {
    if (phase === 'complete') {
      projectedCompletionMs = validTimestampMs(raw.projectedCompletionMs);
    } else if (!isBlocked && totalKnown && overallEtaMs !== null) {
      projectedCompletionMs = validTimestampMs(raw.projectedCompletionMs);
    }
  }

  const rows = [];
  rows.push(row('status', 'Status', status, true));

  if (hasClockAnomaly) {
    rows.push(row('clockAnomaly', 'Clock check', clockAnomalyReason, false, clockAnomalyReason));
  }

  const hasCurrentStepInfo = currentStep !== null && (
    currentStep.index !== null
    || currentStep.label !== null
    || currentStep.doneTotal !== null
    || currentStep.completed !== null
    || currentStep.total !== null
    || currentStep.rate !== null
  );

  // Current step row
  if (hasCurrentStepInfo) {
    const parts = [];
    if (currentStep.index !== null && currentStep.label) {
      parts.push(`Step ${currentStep.index}: ${currentStep.label}`);
    } else if (currentStep.label) {
      parts.push(currentStep.label);
    } else if (currentStep.index !== null) {
      parts.push(`Step ${currentStep.index}`);
    } else {
      parts.push('Current step');
    }

    const details = [];
    if (currentStep.doneTotal !== null) {
      const pctText = formatPercent(currentStep.percent, currentStep.completed, currentStep.total);
      details.push(pctText !== null ? `${currentStep.doneTotal}, ${pctText}` : currentStep.doneTotal);
    } else if (currentStep.completed !== null) {
      details.push(`${currentStep.completed} ${formatUnitCount(currentStep.completed, currentStep.unitPair)} completed, total unknown`);
    } else if (currentStep.total !== null) {
      details.push(`completed count not recorded; ${currentStep.total} total ${formatUnitCount(currentStep.total, currentStep.unitPair)}`);
    } else {
      details.push('sub-progress not measured');
    }

    if (currentStep.rate !== null) {
      details.push(`${formatRate(currentStep.rate)} ${currentStep.unitPair.plural}/s`);
    }

    rows.push(row('currentStep', 'Current step', `${parts[0]} (${details.join('; ')})`, true));
  } else if (phase === 'complete') {
    const text = totalKnown && completedSteps !== null && completedSteps === totalSteps
      ? `None (all measured ${overallUnit.plural} complete)`
      : 'None (attempt complete)';
    rows.push(row('currentStep', 'Current step', text, true));
  } else {
    const reason = 'Current step not reported.';
    rows.push(row('currentStep', 'Current step', 'Unavailable (current step not reported)', false, reason));
  }

  // Completed counts row
  if (stepRejectionReason) {
    rows.push(row('completed', 'Completed', ensureUnavailablePrefix(stepRejectionReason, 'Unavailable'), false, stepRejectionReason));
  } else if (totalKnown && completedSteps !== null && totalSteps !== null) {
    const unitLabel = formatUnitCount(totalSteps, overallUnit);
    const pctText = formatPercent(percent, completedSteps, totalSteps);
    const text = pctText !== null
      ? `${completedSteps} of ${totalSteps} ${unitLabel} (${doneTotal}, ${pctText})`
      : `${completedSteps} of ${totalSteps} ${unitLabel} (${doneTotal})`;
    rows.push(row('completed', 'Completed', text, true));
  } else if (completedSteps !== null && totalSteps === null) {
    rows.push(row('completed', 'Completed', `${completedSteps} ${formatUnitCount(completedSteps, overallUnit)} completed (total unknown)`, true));
  } else if (totalKnown && completedSteps === null && totalSteps !== null) {
    const unitLabel = formatUnitCount(totalSteps, overallUnit);
    const reason = `Completed count not recorded for ${totalSteps} total ${unitLabel}.`;
    rows.push(row('completed', 'Completed', `Unavailable (completed count not recorded; ${totalSteps} total ${unitLabel})`, false, reason));
  } else if (chars !== null) {
    const reason = 'Measured work counts are unavailable.';
    rows.push(row('completed', 'Completed', `Unavailable (${chars} UTF-16 code units received; work counts unmeasured)`, false, reason));
  } else if (phase === 'complete') {
    const reason = 'Measured work counts were not recorded.';
    rows.push(row('completed', 'Completed', 'Complete (work counts not recorded)', false, reason));
  } else {
    const reason = 'No measured work counters.';
    rows.push(row('completed', 'Completed', 'Unavailable (no measured work counters)', false, reason));
  }

  // Remaining counts row
  if (stepRejectionReason) {
    rows.push(row('remaining', 'Remaining', `Unknown (${stepRejectionReason})`, false, stepRejectionReason));
  } else if (totalKnown && remainingSteps !== null && totalSteps !== null) {
    const unitLabel = formatUnitCount(totalSteps, overallUnit);
    const text = remainingSteps === 0 && phase === 'waiting'
      ? `0 of ${totalSteps} ${unitLabel} remaining (waiting for completion)`
      : `${remainingSteps} of ${totalSteps} ${unitLabel} remaining`;
    rows.push(row('remaining', 'Remaining', text, true));
  } else if (totalKnown && completedSteps === null && totalSteps !== null) {
    const unitLabel = formatUnitCount(totalSteps, overallUnit);
    const reason = `Completed count for ${totalSteps} total ${unitLabel} was not recorded.`;
    rows.push(row('remaining', 'Remaining', `Unknown (completed count for ${totalSteps} total ${unitLabel} was not recorded)`, false, reason));
  } else if (completedSteps !== null && totalSteps === null) {
    const reason = overallUnit.known
      ? `Total ${overallUnit.plural} not reported.`
      : 'Total work units not reported.';
    const value = overallUnit.known
      ? `Unknown (total ${overallUnit.plural} not reported)`
      : 'Unknown (total work units not reported)';
    rows.push(row('remaining', 'Remaining', value, false, reason));
  } else if (phase === 'complete') {
    rows.push(row('remaining', 'Remaining', remainingNote ?? 'No remaining work.', true));
  } else if (phase === 'failed' || phase === 'interrupted' || phase === 'cancelled' || phase === 'stopping') {
    rows.push(row('remaining', 'Remaining', remainingNote ?? 'Unknown (run did not complete).', false, remainingNote));
  } else {
    const detail = remainingNote && !/unknown/i.test(remainingNote) ? ` ${remainingNote}` : '';
    const reason = 'Total work is unknown.';
    rows.push(row('remaining', 'Remaining', `Unknown (total work not measured).${detail}`.trim(), false, reason));
  }

  if (chars !== null) {
    rows.push(row('output', 'Output', `${chars} UTF-16 code units (total unknown)`, true));
  }

  // Rate and units row
  if (hasClockAnomaly) {
    const reason = `Unavailable due to clock anomaly: ${clockAnomalyReason}`;
    rows.push(row('rate', 'Rate', reason, false, reason));
  } else if (stepRate !== null) {
    const parts = [`${formatRate(stepRate)} ${overallUnit.plural}/s`];
    if (currentStep !== null && currentStep.rate !== null) {
      parts.push(`current step: ${formatRate(currentStep.rate)} ${currentStep.unitPair.plural}/s`);
    }
    if (charRate !== null) {
      parts.push(`${formatRate(charRate)} UTF-16 code units/s`);
    }
    const value = parts.length > 1 ? `${parts[0]} (${parts.slice(1).join('; ')})` : parts[0];
    rows.push(row('rate', 'Rate', value, true));
  } else if (charRate !== null) {
    const workCountersPresent = hasMeasuredOverallCounters || stepSamplesValid === true;
    const workRateLabel = overallUnit.known ? `${overallUnit.singular} rate` : 'work rate';
    const workRateNote = workCountersPresent ? formatWorkRateReason(reasonRate, overallUnit) : null;
    const stepDetail = stepRejectionReason
      ? ` (work counters rejected: ${stepRejectionReason})`
      : workRateNote
        ? ` (${workRateLabel} unavailable: ${workRateNote})`
        : '';
    rows.push(row('rate', 'Rate', `${formatRate(charRate)} UTF-16 code units/s${stepDetail}`, true));
  } else if (stepRejectionReason) {
    const reason = ensureUnavailablePrefix(stepRejectionReason, 'Unavailable');
    rows.push(row('rate', 'Rate', reason, false, stepRejectionReason));
  } else {
    const cleanReason = formatWorkRateReason(reasonRate, overallUnit);
    const reason = cleanReason ?? (isTerminal ? 'Run is no longer active.' : 'Insufficient measured samples.');
    rows.push(row('rate', 'Rate', ensureUnavailablePrefix(reason, 'Unavailable'), false, reason));
  }

  // Elapsed row
  if (elapsedMs !== null) {
    rows.push(row('elapsed', 'Elapsed', formatDuration(elapsedMs), true));
  } else {
    const reason = hasClockAnomaly
      ? `Unavailable due to clock anomaly: ${clockAnomalyReason}`
      : 'Unavailable (start or completion time not recorded)';
    rows.push(row('elapsed', 'Elapsed', reason, false, reason));
  }

  // Latest activity row
  if (lastActivity !== null) {
    const clock = safeLocalClock(lastActivity, customFormatter);
    if (clock !== null) {
      const value = idleMs !== null ? `${clock} (${formatDuration(idleMs)} ago)` : clock;
      rows.push(row('lastActivity', 'Latest activity', value, true));
    } else {
      rows.push(row('lastActivity', 'Latest activity', 'Unavailable', false, 'Timestamp could not be formatted.'));
    }
  } else {
    const reason = hasClockAnomaly && /activity/i.test(clockAnomalyReason)
      ? `Unavailable: ${clockAnomalyReason}`
      : 'Unavailable';
    rows.push(row('lastActivity', 'Latest activity', reason, false, reason));
  }

  // Heartbeat row
  if (heartbeat !== null) {
    const clock = safeLocalClock(heartbeat, customFormatter);
    if (clock !== null) {
      const value = heartbeatAgeMs !== null ? `${clock} (${formatDuration(heartbeatAgeMs)} ago)` : clock;
      rows.push(row('heartbeat', 'Heartbeat', value, true));
    } else {
      rows.push(row('heartbeat', 'Heartbeat', 'Unavailable', false, 'Timestamp could not be formatted.'));
    }
  } else {
    const reason = hasClockAnomaly && /heartbeat/i.test(clockAnomalyReason)
      ? `Unavailable: ${clockAnomalyReason}`
      : 'Unavailable';
    rows.push(row('heartbeat', 'Heartbeat', reason, false, reason));
  }

  // Current step ETA row (separate from Overall ETA)
  if (isBlocked) {
    const reason = ensureUnavailablePrefix(blockedReason, 'Unavailable');
    rows.push(row('currentStepEta', 'Current step ETA', reason, false, blockedReason));
  } else if (currentStepEtaMs === 0) {
    const text = rawCurrentEtaText && !/unavailable/i.test(rawCurrentEtaText)
      ? rawCurrentEtaText
      : phase === 'complete'
        ? 'Complete. No remaining work.'
        : 'Current step complete.';
    rows.push(row('currentStepEta', 'Current step ETA', text, true));
  } else if (currentStepEtaMs !== null) {
    rows.push(row('currentStepEta', 'Current step ETA', formatDuration(currentStepEtaMs), true));
  } else {
    const fallbackReason = missingOverallDone
      ? (overallUnit.known
        ? `Unavailable because completed ${overallUnit.singular} count is not recorded.`
        : 'Unavailable because completed count is not recorded.')
      : missingSubDone
        ? 'Unavailable because completed current-step count is not recorded.'
        : 'Unavailable because current-step sub-progress is not measured.';
    const safeRawCurrentEta = rawCurrentEtaText && !/^complete\b/i.test(rawCurrentEtaText)
      ? rawCurrentEtaText
      : null;
    const reason = reasonCurrentEta ?? safeRawCurrentEta ?? fallbackReason;
    rows.push(row('currentStepEta', 'Current step ETA', ensureUnavailablePrefix(reason, fallbackReason), false, reason));
  }

  // Overall ETA row (separate from Current step ETA)
  if (isBlocked) {
    const reason = ensureUnavailablePrefix(blockedReason, 'Unavailable');
    rows.push(row('overallEta', 'Overall ETA', reason, false, blockedReason));
  } else if (overallEtaMs === 0) {
    const text = rawOverallEtaText && !/unavailable/i.test(rawOverallEtaText)
      ? rawOverallEtaText
      : 'Complete. No remaining time.';
    rows.push(row('overallEta', 'Overall ETA', text, true));
  } else if (overallEtaMs !== null) {
    rows.push(row('overallEta', 'Overall ETA', formatDuration(overallEtaMs), true));
  } else {
    const fallbackReason = stepRejectionReason
      ? ensureUnavailablePrefix(stepRejectionReason, 'Unavailable')
      : missingOverallDone
        ? (overallUnit.known
          ? `Unavailable because completed ${overallUnit.singular} count is not recorded.`
          : 'Unavailable because completed count is not recorded.')
        : 'Unavailable because total work and remaining output are unknown.';
    const reason = reasonOverallEta ?? rawOverallEtaText ?? fallbackReason;
    rows.push(row('overallEta', 'Overall ETA', ensureUnavailablePrefix(reason, fallbackReason), false, reason));
  }

  // Projected local completion row (only when supported by measured evidence)
  const rawCompletionText = sanitizeText(raw.completion);
  if (hasClockAnomaly) {
    const reason = `Unavailable due to clock anomaly: ${clockAnomalyReason}`;
    rows.push(row('completion', 'Projected local completion', reason, false, reason));
  } else if (phase === 'complete') {
    if (projectedCompletionMs !== null) {
      const clock = safeLocalClock(projectedCompletionMs, customFormatter);
      if (clock !== null) {
        rows.push(row('completion', 'Projected local completion', `Completed at ${clock}.`, true));
      } else {
        const reason = 'Recorded completion timestamp is out of range.';
        rows.push(row('completion', 'Projected local completion', `Completed. ${reason}`, false, reason));
      }
    } else {
      const reason = reasonCompletion ?? 'Completion timestamp was not recorded.';
      const text = rawCompletionText && /^completed/i.test(rawCompletionText)
        ? rawCompletionText
        : `Completed. ${reason}`;
      rows.push(row('completion', 'Projected local completion', text, false, reason));
    }
  } else if (isBlocked) {
    const reason = ensureUnavailablePrefix(blockedReason, 'Unavailable');
    rows.push(row('completion', 'Projected local completion', reason, false, blockedReason));
  } else if (totalKnown && overallEtaMs !== null && projectedCompletionMs !== null) {
    const clock = safeLocalClock(projectedCompletionMs, customFormatter);
    if (clock !== null) {
      rows.push(row('completion', 'Projected local completion', `Projected around ${clock} (in ${formatDuration(overallEtaMs)}).`, true));
    } else {
      const reason = 'Projected completion exceeds valid calendar range.';
      rows.push(row('completion', 'Projected local completion', `Unavailable because ${reason.toLowerCase()}`, false, reason));
    }
  } else {
    const fallbackReason = 'Unavailable until a reliable remaining time can be measured.';
    const reason = reasonCompletion ?? rawCompletionText ?? fallbackReason;
    rows.push(row('completion', 'Projected local completion', ensureUnavailablePrefix(reason, fallbackReason), false, reason));
  }

  const counterBadge = doneTotal ? ` (${doneTotal})` : '';
  const announcement = hasClockAnomaly
    ? `Timing anomaly detected. ${status}. ${clockAnomalyReason}`
    : `${status}${counterBadge}. ${explanation}`;

  return buildResult({
    available: true,
    phase,
    status,
    explanation,
    clockAnomaly: hasClockAnomaly,
    clockAnomalyReason,
    counts: {
      totalKnown,
      unit: overallUnit.known ? overallUnit.plural : null,
      unitSingular: overallUnit.known ? overallUnit.singular : null,
      completedSteps,
      totalSteps,
      remainingSteps,
      doneTotal,
      percent,
    },
    rows,
    announcement,
  });
}
