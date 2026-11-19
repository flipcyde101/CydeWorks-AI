export const STALL_THRESHOLD_MS = 60_000;
export const WAITING_OUTPUT_THRESHOLD_MS = 15_000;
export const MAX_DATE_MS = 8_640_000_000_000_000;

const UNTRUSTED_SOURCE_RE = /(?:estimat|infer|heuristic|guess|char|token|byte|simulat|synthetic|mock|predict|unknown|unverif)/i;
const UNTRUSTED_UNITS = new Set(['char', 'chars', 'character', 'characters', 'token', 'tokens', 'byte', 'bytes']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ArrayBuffer.isView(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isValidNow(now) {
  return typeof now === 'number' && Number.isFinite(now) && now >= 0 && now <= MAX_DATE_MS;
}

function parseTimestamp(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 && value <= MAX_DATE_MS ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < 4 || /^\d+$/.test(trimmed)) return null;
  const time = Date.parse(trimmed);
  return Number.isFinite(time) && time >= 0 && time <= MAX_DATE_MS ? time : null;
}

function inspectTime(value, validNow, label) {
  if (value === undefined || value === null) {
    return { time: null, anomaly: null };
  }
  const parsed = parseTimestamp(value);
  if (parsed === null) {
    return { time: null, anomaly: `${label} timestamp is invalid or out of range.` };
  }
  if (validNow === null) {
    return { time: null, anomaly: `Cannot validate ${label} timestamp without a valid current clock.` };
  }
  if (parsed > validNow) {
    return { time: null, anomaly: `${label} timestamp is in the future.` };
  }
  return { time: parsed, anomaly: null };
}

function safeDateIso(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > MAX_DATE_MS) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeLocalClock(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > MAX_DATE_MS) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function computePercent(completed, total) {
  if (completed === null || total === null) return null;
  if (completed === total) return 100;
  const basisPoints = Number((BigInt(completed) * 10000n) / BigInt(total));
  const pct = basisPoints / 100;
  return pct >= 100 ? 99.99 : pct;
}

function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'Unavailable';
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60_000) return (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) + ' s';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  if (minutes < 60) return minutes + ' min ' + seconds + ' s';
  const hours = Math.floor(minutes / 60);
  if (!Number.isFinite(hours)) return 'Unavailable';
  return hours + ' h ' + String(minutes % 60).padStart(2, '0') + ' min';
}

function computeRemainingEtaMs(remaining, spanInfo) {
  if (remaining === null || !spanInfo || !(spanInfo.deltaSteps > 0) || !(spanInfo.spanMs > 0)) return null;
  const etaMs = Math.round((remaining * spanInfo.spanMs) / spanInfo.deltaSteps);
  if (!Number.isFinite(etaMs) || etaMs < 0) return null;
  return etaMs;
}

function evaluateStepSeries(raw, {
  validNow,
  started,
  minSampleTime = null,
  minSampleLabel = null,
  maxSampleTime = null,
  maxSampleLabel = null,
}) {
  if (raw === undefined || raw === null) {
    return {
      present: false,
      valid: true,
      totalKnown: false,
      completed: null,
      total: null,
      remaining: null,
      doneTotal: null,
      percent: null,
      rate: null,
      spanInfo: null,
      samplesCount: 0,
      firstSampleAt: null,
      lastSampleAt: null,
      lastProgressAt: null,
      samplesStale: false,
      clockAnomaly: null,
      rejectionReason: null,
      rateUnavailableReason: 'No measured step counters were supplied.',
    };
  }

  const invalid = (rejectionReason, clockAnomaly = null) => ({
    present: true,
    valid: false,
    totalKnown: false,
    completed: null,
    total: null,
    remaining: null,
    doneTotal: null,
    percent: null,
    rate: null,
    spanInfo: null,
    samplesCount: 0,
    firstSampleAt: null,
    lastSampleAt: null,
    lastProgressAt: null,
    samplesStale: false,
    clockAnomaly,
    rejectionReason,
    rateUnavailableReason: rejectionReason,
  });

  if (!isPlainObject(raw)) {
    return invalid('Measured step counters must be a plain object.');
  }
  if (raw.measured !== undefined && raw.measured !== true) {
    return invalid('Step counters are not marked as measured.');
  }
  if (raw.trustworthy !== undefined && raw.trustworthy !== true) {
    return invalid('Step counters are not marked as trustworthy.');
  }
  if (raw.estimated === true || raw.inferred === true || raw.simulated === true) {
    return invalid('Estimated, inferred, or simulated counters cannot be used as measured progress.');
  }
  if (raw.unit !== undefined && raw.unit !== null) {
    if (typeof raw.unit !== 'string' || !raw.unit.trim()) {
      return invalid('Step unit must be a non-empty string when provided.');
    }
    if (UNTRUSTED_UNITS.has(raw.unit.trim().toLowerCase())) {
      return invalid('Output character, token, or byte counts do not imply measured step totals.');
    }
  }
  if (raw.source !== undefined && raw.source !== null) {
    if (typeof raw.source !== 'string' || !raw.source.trim()) {
      return invalid('Step counter source must be a non-empty string when provided.');
    }
    if (UNTRUSTED_SOURCE_RE.test(raw.source.trim())) {
      return invalid('Step counters come from an untrusted or unmeasured source.');
    }
  }

  const hasTotal = raw.total !== undefined && raw.total !== null;
  if (hasTotal && (typeof raw.total !== 'number' || !Number.isSafeInteger(raw.total) || raw.total <= 0)) {
    return invalid('Total steps must be a positive safe integer.');
  }
  const total = hasTotal ? raw.total : null;

  const hasCompletedField = raw.completed !== undefined && raw.completed !== null;
  const hasDoneField = raw.done !== undefined && raw.done !== null;
  if (hasCompletedField && hasDoneField && raw.completed !== raw.done) {
    return invalid('Conflicting completed and done step counts.');
  }
  const rawDone = hasCompletedField ? raw.completed : raw.done;
  const hasDone = rawDone !== undefined && rawDone !== null;
  if (hasDone) {
    if (typeof rawDone !== 'number' || !Number.isSafeInteger(rawDone) || rawDone < 0) {
      return invalid('Completed steps must be a non-negative safe integer.');
    }
    if (total !== null && rawDone > total) {
      return invalid('Completed steps cannot exceed total steps.');
    }
  }

  const validSamples = [];
  let lastProgressAt = null;
  if (raw.samples !== undefined && raw.samples !== null) {
    if (!Array.isArray(raw.samples)) {
      return invalid('Step samples must be an array.');
    }
    for (let i = 0; i < raw.samples.length; i += 1) {
      const sample = raw.samples[i];
      if (!isPlainObject(sample)) {
        return invalid('Each step sample must be a plain object.');
      }
      const rawAt = sample.at !== undefined ? sample.at : sample.timestamp;
      if (rawAt === undefined || rawAt === null) {
        return invalid('Step sample is missing a timestamp.');
      }
      const checkedAt = inspectTime(rawAt, validNow, 'Step sample');
      if (checkedAt.anomaly !== null || checkedAt.time === null) {
        const reason = checkedAt.anomaly ?? 'Step sample timestamp is invalid.';
        return invalid(reason, reason);
      }
      const sampleAt = checkedAt.time;
      if (started !== null && sampleAt < started) {
        const reason = 'Step sample timestamp precedes attempt start time.';
        return invalid(reason, reason);
      }
      if (minSampleTime !== null && sampleAt < minSampleTime) {
        const reason = minSampleLabel ?? 'Step sample timestamp precedes step start time.';
        return invalid(reason, reason);
      }
      if (maxSampleTime !== null && sampleAt > maxSampleTime) {
        const reason = maxSampleLabel ?? 'Step sample timestamp occurs after completion time.';
        return invalid(reason, reason);
      }

      const sComp = sample.completed !== undefined && sample.completed !== null;
      const sDone = sample.done !== undefined && sample.done !== null;
      if (sComp && sDone && sample.completed !== sample.done) {
        return invalid('Step sample has conflicting completed and done counts.');
      }
      const sampleDone = sComp ? sample.completed : sample.done;
      if (typeof sampleDone !== 'number' || !Number.isSafeInteger(sampleDone) || sampleDone < 0) {
        return invalid('Step sample count must be a non-negative safe integer.');
      }
      if (total !== null && sampleDone > total) {
        return invalid('Step sample count cannot exceed total steps.');
      }

      if (validSamples.length > 0) {
        const prev = validSamples[validSamples.length - 1];
        if (sampleAt < prev.at) {
          const reason = 'Step sample timestamps moved backward.';
          return invalid(reason, reason);
        }
        if (sampleDone < prev.done) {
          return invalid('Step sample count regressed.');
        }
        if (sampleAt === prev.at && sampleDone !== prev.done) {
          const reason = 'Step count changed in zero elapsed time.';
          return invalid(reason, reason);
        }
        if (sampleDone > prev.done) {
          lastProgressAt = sampleAt;
        }
      } else if (sampleDone > 0) {
        lastProgressAt = sampleAt;
      }

      validSamples.push({ at: sampleAt, done: sampleDone });
    }
  }

  let completed = hasDone ? rawDone : null;
  if (validSamples.length > 0) {
    const latest = validSamples[validSamples.length - 1];
    if (completed !== null && completed < latest.done) {
      return invalid('Current completed step count regressed below latest sample.');
    }
    if (completed === null) {
      completed = latest.done;
    }
  }

  const totalKnown = total !== null;
  const remaining = totalKnown && completed !== null ? total - completed : null;
  const doneTotal = totalKnown && completed !== null ? `${completed}/${total}` : null;
  const percent = computePercent(completed, total);

  let rate = null;
  let spanInfo = null;
  let rateUnavailableReason = null;
  if (validSamples.length < 2) {
    rateUnavailableReason = 'Insufficient measured step samples to calculate rate.';
  } else {
    const first = validSamples[0];
    const last = validSamples[validSamples.length - 1];
    const spanMs = last.at - first.at;
    const deltaSteps = last.done - first.done;
    if (spanMs <= 0) {
      rateUnavailableReason = 'Step samples do not span a positive elapsed interval.';
    } else if (deltaSteps === 0) {
      rate = 0;
    } else {
      rate = (deltaSteps * 1000) / spanMs;
      spanInfo = { deltaSteps, spanMs };
    }
  }

  const firstSampleAt = validSamples.length > 0 ? validSamples[0].at : null;
  const lastSampleAt = validSamples.length > 0 ? validSamples[validSamples.length - 1].at : null;
  const samplesStale = validSamples.length > 0 && validNow !== null && (
    (validNow - lastSampleAt) >= STALL_THRESHOLD_MS
    || (lastProgressAt !== null && (validNow - lastProgressAt) >= STALL_THRESHOLD_MS)
  );

  return {
    present: true,
    valid: true,
    totalKnown,
    completed,
    total,
    remaining,
    doneTotal,
    percent,
    rate,
    spanInfo,
    samplesCount: validSamples.length,
    firstSampleAt,
    lastSampleAt,
    lastProgressAt,
    samplesStale,
    clockAnomaly: null,
    rejectionReason: null,
    rateUnavailableReason,
  };
}

function inspectCurrentStep(rawCurrent, { validNow, started, dispatched = null, ended = null }) {
  if (rawCurrent === undefined || rawCurrent === null) {
    return {
      kind: 'none',
      index: null,
      label: null,
      subEval: null,
      clockAnomaly: null,
      metadataError: null,
    };
  }
  if (typeof rawCurrent === 'string') {
    return {
      kind: 'label',
      index: null,
      label: rawCurrent.trim() || null,
      subEval: null,
      clockAnomaly: null,
      metadataError: null,
    };
  }
  if (!isPlainObject(rawCurrent)) {
    return {
      kind: 'invalid',
      index: null,
      label: null,
      subEval: null,
      clockAnomaly: null,
      metadataError: 'Current-step metadata must be a string or plain object.',
    };
  }

  const label = typeof rawCurrent.label === 'string' && rawCurrent.label.trim()
    ? rawCurrent.label.trim()
    : typeof rawCurrent.name === 'string' && rawCurrent.name.trim()
      ? rawCurrent.name.trim()
      : null;
  const index = Number.isSafeInteger(rawCurrent.index) && rawCurrent.index >= 0 ? rawCurrent.index : null;

  let clockAnomaly = null;
  let stepStarted = null;
  if (rawCurrent.startedAt !== undefined && rawCurrent.startedAt !== null) {
    const stepStart = inspectTime(rawCurrent.startedAt, validNow, 'Current step start');
    if (stepStart.anomaly !== null) {
      clockAnomaly = stepStart.anomaly;
    } else {
      stepStarted = stepStart.time;
      if (started !== null && stepStarted !== null && stepStarted < started) {
        clockAnomaly = 'Current step start timestamp precedes attempt start time.';
      } else if (dispatched !== null && stepStarted !== null && stepStarted < dispatched) {
        clockAnomaly = 'Current step start timestamp precedes dispatch time.';
      } else if (ended !== null && stepStarted !== null && stepStarted > ended) {
        clockAnomaly = 'Current step start timestamp occurs after completion time.';
      }
    }
  }

  const hasSubCounters = rawCurrent.completed !== undefined
    || rawCurrent.done !== undefined
    || rawCurrent.total !== undefined
    || rawCurrent.samples !== undefined;

  if (!hasSubCounters) {
    return {
      kind: 'label',
      index,
      label,
      subEval: null,
      clockAnomaly,
      metadataError: null,
    };
  }

  const minSampleTime = stepStarted !== null ? stepStarted : dispatched;
  const minSampleLabel = stepStarted !== null
    ? 'Current-step sample timestamp precedes current step start time.'
    : 'Current-step sample timestamp precedes dispatch time.';

  const subEval = evaluateStepSeries(rawCurrent, {
    validNow,
    started,
    minSampleTime,
    minSampleLabel,
    maxSampleTime: ended,
    maxSampleLabel: 'Current-step sample timestamp occurs after completion time.',
  });
  if (subEval.clockAnomaly && !clockAnomaly) {
    clockAnomaly = subEval.clockAnomaly;
  }

  return {
    kind: 'measured',
    index,
    label,
    subEval,
    clockAnomaly,
    metadataError: null,
  };
}

function finalizeCurrentStep(parsedStep, { overallComplete, blockedReason, defaultUnavailableEta }) {
  if (parsedStep.kind === 'none') {
    if (blockedReason !== null) {
      return {
        info: null,
        etaMs: null,
        eta: blockedReason,
        unavailableReason: blockedReason,
      };
    }
    if (overallComplete) {
      return {
        info: null,
        etaMs: 0,
        eta: 'Complete. No remaining work.',
        unavailableReason: null,
      };
    }
    return {
      info: null,
      etaMs: null,
      eta: defaultUnavailableEta,
      unavailableReason: 'Current-step sub-progress is not measured.',
    };
  }

  if (parsedStep.kind === 'invalid') {
    const eta = blockedReason ?? ('Unavailable: ' + parsedStep.metadataError);
    return {
      info: null,
      etaMs: null,
      eta,
      unavailableReason: parsedStep.metadataError,
    };
  }

  if (parsedStep.kind === 'label') {
    const etaMs = blockedReason !== null ? null : overallComplete ? 0 : null;
    const eta = blockedReason !== null
      ? blockedReason
      : overallComplete
        ? 'Complete. No remaining work.'
        : defaultUnavailableEta;
    return {
      info: {
        index: parsedStep.index,
        label: parsedStep.label,
        completed: null,
        total: null,
        remaining: null,
        doneTotal: null,
        percent: null,
        rate: null,
        etaMs,
        eta,
      },
      etaMs,
      eta,
      unavailableReason: blockedReason !== null
        ? blockedReason
        : overallComplete
          ? null
          : 'Current-step sub-progress is not measured.',
    };
  }

  const subEval = parsedStep.subEval;
  if (!subEval.valid) {
    const eta = blockedReason ?? ('Unavailable: ' + subEval.rejectionReason);
    return {
      info: {
        index: parsedStep.index,
        label: parsedStep.label,
        completed: null,
        total: null,
        remaining: null,
        doneTotal: null,
        percent: null,
        rate: null,
        etaMs: null,
        eta,
      },
      etaMs: null,
      eta,
      unavailableReason: subEval.rejectionReason,
    };
  }

  let etaMs = null;
  let eta;
  let unavailableReason = null;

  if (blockedReason !== null) {
    unavailableReason = blockedReason;
    eta = blockedReason;
  } else if (overallComplete || (subEval.totalKnown && subEval.remaining === 0)) {
    etaMs = 0;
    eta = overallComplete ? 'Complete. No remaining work.' : 'Current step complete.';
  } else if (!subEval.totalKnown || subEval.remaining === null) {
    unavailableReason = 'Current-step total or completed counter is missing.';
    eta = 'Unavailable because current-step total or completed work is unknown.';
  } else if (subEval.rate === null) {
    unavailableReason = subEval.rateUnavailableReason;
    eta = 'Unavailable: ' + subEval.rateUnavailableReason;
  } else if (subEval.rate === 0) {
    unavailableReason = 'Measured current-step rate is 0 steps/s.';
    eta = 'Unavailable because the measured current-step rate is 0 steps/s.';
  } else if (subEval.samplesStale) {
    unavailableReason = 'Latest current-step samples are stale.';
    eta = 'Unavailable because the latest current-step samples are stale.';
  } else {
    etaMs = computeRemainingEtaMs(subEval.remaining, subEval.spanInfo);
    if (etaMs === null) {
      unavailableReason = 'Current-step ETA could not be calculated safely.';
      eta = 'Unavailable because current-step ETA could not be calculated safely.';
    } else {
      eta = formatDuration(etaMs);
    }
  }

  return {
    info: {
      index: parsedStep.index,
      label: parsedStep.label,
      completed: subEval.completed,
      total: subEval.total,
      remaining: subEval.remaining,
      doneTotal: subEval.doneTotal,
      percent: subEval.percent,
      rate: subEval.rate,
      etaMs,
      eta,
    },
    etaMs,
    eta,
    unavailableReason,
  };
}

export function describeProgress(task, attempt, now = Date.now()) {
  const taskObj = task && typeof task === 'object' ? task : {};
  const attemptObj = attempt && typeof attempt === 'object' ? attempt : null;
  const live = taskObj.live && typeof taskObj.live === 'object' ? taskObj.live : null;

  const validNow = isValidNow(now) ? now : null;
  const anomalies = [];
  if (validNow === null) {
    anomalies.push('Current clock timestamp is invalid or out of range.');
  }

  const startedCheck = inspectTime(attemptObj?.started, validNow, 'Attempt start');
  if (startedCheck.anomaly) anomalies.push(startedCheck.anomaly);
  const started = startedCheck.time;

  const dispatchedCheck = inspectTime(attemptObj?.execution?.dispatchedAt, validNow, 'Dispatch');
  if (dispatchedCheck.anomaly) anomalies.push(dispatchedCheck.anomaly);
  let dispatched = dispatchedCheck.time;
  if (started !== null && dispatched !== null && dispatched < started) {
    anomalies.push('Dispatch timestamp precedes attempt start time.');
    dispatched = null;
  }

  const endedCheck = inspectTime(attemptObj?.ended ?? live?.endedAt, validNow, 'Completion');
  if (endedCheck.anomaly) anomalies.push(endedCheck.anomaly);
  let ended = endedCheck.time;
  if (started !== null && ended !== null && ended < started) {
    anomalies.push('Completion timestamp precedes attempt start time.');
    ended = null;
  }
  const recordedEnded = ended;
  const endedBeforeDispatched = dispatched !== null && ended !== null && ended < dispatched;
  if (endedBeforeDispatched) {
    anomalies.push('Completion timestamp precedes dispatch time.');
    ended = null;
  }

  const lastCheck = inspectTime(live?.lastActivity, validNow, 'Last activity');
  if (lastCheck.anomaly) anomalies.push(lastCheck.anomaly);
  let last = lastCheck.time;
  let lastAfterEnded = false;
  if (started !== null && last !== null && last < started) {
    anomalies.push('Last activity timestamp precedes attempt start time.');
    last = null;
  } else if (dispatched !== null && last !== null && last < dispatched) {
    anomalies.push('Last activity timestamp precedes dispatch time.');
    last = null;
  } else if (recordedEnded !== null && last !== null && last > recordedEnded) {
    anomalies.push('Last activity timestamp occurs after completion time.');
    lastAfterEnded = true;
    last = null;
  }

  const heartbeatCheck = inspectTime(live?.heartbeat, validNow, 'Heartbeat');
  if (heartbeatCheck.anomaly) anomalies.push(heartbeatCheck.anomaly);
  const heartbeat = heartbeatCheck.time;

  const chars = Number.isSafeInteger(live?.chars) && live.chars >= 0 ? live.chars : null;
  const outputIdle = validNow !== null && last !== null ? validNow - last : null;
  const heartbeatAgeMs = validNow !== null && heartbeat !== null ? validNow - heartbeat : null;

  const rawStepInput = live?.steps !== undefined && live?.steps !== null
    ? live.steps
    : live?.progress !== undefined && live?.progress !== null
      ? live.progress
      : attemptObj?.progress !== undefined && attemptObj?.progress !== null
        ? attemptObj.progress
        : null;

  const stepEval = evaluateStepSeries(rawStepInput, {
    validNow,
    started,
    minSampleTime: dispatched,
    minSampleLabel: 'Step sample timestamp precedes dispatch time.',
    maxSampleTime: recordedEnded,
    maxSampleLabel: 'Step sample timestamp occurs after completion time.',
  });
  if (stepEval.clockAnomaly) anomalies.push(stepEval.clockAnomaly);

  const parsedCurrentStep = inspectCurrentStep(
    isPlainObject(rawStepInput) ? rawStepInput.currentStep : null,
    { validNow, started, dispatched, ended: recordedEnded },
  );
  if (parsedCurrentStep.clockAnomaly) anomalies.push(parsedCurrentStep.clockAnomaly);

  const subEval = stepEval.valid && parsedCurrentStep.kind === 'measured' && parsedCurrentStep.subEval?.valid
    ? parsedCurrentStep.subEval
    : null;

  const taskStatus = taskObj.status;
  const attemptStatus = attemptObj?.status;
  const hasLiveError = typeof live?.error === 'string'
    ? live.error.trim().length > 0
    : Boolean(live?.error && typeof live.error === 'object');

  const isFailed = taskStatus === 'failed' || attemptStatus === 'failed' || live?.failed === true || hasLiveError;
  const isInterrupted = !isFailed && taskStatus === 'interrupted';
  const isCancelled = !isFailed && !isInterrupted && taskStatus === 'cancelled';
  const isDraft = !isFailed && !isInterrupted && !isCancelled && taskStatus === 'draft';
  const isRunningAuthoritative = taskStatus === 'running';
  const declaredComplete = !isFailed && !isInterrupted && !isCancelled && !isDraft && !isRunningAuthoritative && (
    taskStatus === 'complete'
    || taskStatus === 'completed'
    || taskStatus === 'review'
    || taskStatus === 'accepted'
    || taskStatus === 'rejected'
    || attemptStatus === 'completed'
    || attemptStatus === 'settled'
    || live?.complete === true
  );
  const stepsComplete = stepEval.valid && stepEval.totalKnown && stepEval.completed !== null && stepEval.completed === stepEval.total;
  const prematureComplete = declaredComplete && stepEval.valid && stepEval.totalKnown && stepEval.completed !== null && stepEval.completed < stepEval.total;
  const isComplete = !prematureComplete && declaredComplete;
  const waitingForSettlementAfterSteps = isRunningAuthoritative && stepsComplete && !isFailed && !live?.stopping;

  const overallWorkProgressAt = stepEval.present && stepEval.valid ? stepEval.lastProgressAt : null;
  const subWorkProgressAt = subEval !== null ? subEval.lastProgressAt : null;
  const latestWorkProgressAt = overallWorkProgressAt !== null && subWorkProgressAt !== null
    ? Math.max(overallWorkProgressAt, subWorkProgressAt)
    : (overallWorkProgressAt ?? subWorkProgressAt);

  const overallWorkRefAt = stepEval.present && stepEval.valid && stepEval.samplesCount > 0
    ? (stepEval.lastProgressAt ?? stepEval.firstSampleAt)
    : null;
  const subWorkRefAt = subEval !== null && subEval.samplesCount > 0
    ? (subEval.lastProgressAt ?? subEval.firstSampleAt)
    : null;
  const latestWorkRefAt = overallWorkRefAt !== null && subWorkRefAt !== null
    ? Math.max(overallWorkRefAt, subWorkRefAt)
    : (overallWorkRefAt ?? subWorkRefAt);

  const outputActive = chars !== null && chars > 0 && outputIdle !== null && outputIdle < STALL_THRESHOLD_MS;
  const workProgressActive = latestWorkProgressAt !== null
    && validNow !== null && (validNow - latestWorkProgressAt) < STALL_THRESHOLD_MS;

  let isStalled = false;
  if (live && !isFailed && !isInterrupted && !isCancelled && !isDraft && !isComplete && !live.stopping && attemptObj?.execution?.phase !== 'claimed') {
    if (!outputActive && !workProgressActive) {
      if (outputIdle !== null && outputIdle >= STALL_THRESHOLD_MS) {
        isStalled = true;
      } else if (latestWorkRefAt !== null && validNow !== null) {
        if ((validNow - latestWorkRefAt) >= STALL_THRESHOLD_MS) {
          isStalled = true;
        }
      } else if (outputIdle === null && validNow !== null) {
        const refSince = dispatched ?? started;
        if ((heartbeatAgeMs !== null && heartbeatAgeMs >= STALL_THRESHOLD_MS)
          || (refSince !== null && (validNow - refSince) >= STALL_THRESHOLD_MS)) {
          isStalled = true;
        }
      }
    }
  }

  let phase = 'waiting';
  let status = 'Waiting for run state';
  let explanation = 'Waiting for a current status from the local workspace.';
  let remaining = live?.stopping
    ? 'Confirm local termination and review recovery status.'
    : attemptObj?.provider === 'fixture'
      ? 'Complete the synthetic result, validate it and review the proposal.'
      : 'Finish generation, validate output and review the proposal.';

  if (prematureComplete) {
    phase = 'failed';
    status = 'Incomplete termination';
    explanation = 'Completion was reported before all measured steps finished.';
    remaining = `${stepEval.remaining} of ${stepEval.total} steps remaining.`;
  } else if (isFailed) {
    phase = 'failed';
    status = 'Attempt failed';
    explanation = typeof attemptObj?.problem === 'string' && attemptObj.problem.trim()
      ? attemptObj.problem.trim()
      : typeof live?.error === 'string' && live.error.trim()
        ? live.error.trim()
        : 'The attempt failed before completion.';
    remaining = 'Review the problem and recovery status before retrying.';
  } else if (isInterrupted) {
    phase = 'interrupted';
    status = 'Run interrupted';
    explanation = taskObj.recovery?.blocked
      ? 'The run was interrupted and its outcome is unknown.'
      : 'The run was interrupted before completion.';
    remaining = 'Review recovery status before starting another attempt.';
  } else if (isCancelled) {
    phase = 'cancelled';
    status = 'Request cancelled';
    explanation = 'The request was cancelled before completion.';
    remaining = 'Review cancellation and recovery status.';
  } else if (isComplete) {
    phase = 'complete';
    status = taskStatus === 'review'
      ? 'Complete, ready for review'
      : taskStatus === 'accepted'
        ? 'Accepted'
        : taskStatus === 'rejected'
          ? 'Proposal rejected'
          : 'Complete';
    explanation = stepEval.valid && stepEval.totalKnown && stepEval.completed !== null
      ? `All ${stepEval.total} measured steps completed.`
      : 'The attempt has completed.';
    remaining = stepEval.valid && stepEval.totalKnown && stepEval.total !== null
      ? `0 of ${stepEval.total} steps remaining.`
      : 'No remaining work.';
  } else if (isDraft) {
    phase = 'waiting';
    status = 'Waiting for approval';
    explanation = 'Waiting for scope and route approval before starting.';
    remaining = 'Approve scope and route to start execution.';
  } else if (live?.stopping) {
    phase = 'stopping';
    status = 'Stop requested';
    explanation = 'Waiting for the local request to end. Provider termination is not yet confirmed.';
    remaining = 'Confirm local termination and review recovery status.';
  } else if (live && attemptObj?.execution?.phase === 'claimed') {
    phase = 'waiting';
    status = 'Checking selected route';
    explanation = 'The request has not yet been dispatched.';
  } else if (isStalled) {
    phase = 'stalled';
    status = 'Possibly stalled';
    explanation = stepEval.valid && (stepEval.totalKnown || stepEval.completed !== null || subEval !== null)
      ? 'No new step progress or activity for at least 60 seconds. The worker may still be working.'
      : 'No new model output for at least 60 seconds. The model may still be working.';
  } else if (waitingForSettlementAfterSteps) {
    phase = 'waiting';
    status = 'Waiting for completion';
    explanation = `All ${stepEval.total} measured steps completed, waiting for authoritative run completion.`;
    remaining = `0 of ${stepEval.total} steps remaining; waiting for completion.`;
  } else if (live && stepEval.present && stepEval.valid && (stepEval.completed !== null || stepEval.totalKnown || (subEval !== null && (subEval.completed !== null || subEval.totalKnown)))) {
    const recentStepProgress = latestWorkProgressAt !== null && validNow !== null && (validNow - latestWorkProgressAt) < WAITING_OUTPUT_THRESHOLD_MS;
    const recentSubProgress = subWorkProgressAt !== null && validNow !== null && (validNow - subWorkProgressAt) < WAITING_OUTPUT_THRESHOLD_MS;
    if (!recentSubProgress && (stepEval.completed === 0 || stepEval.completed === null || (outputIdle !== null && outputIdle >= WAITING_OUTPUT_THRESHOLD_MS && !recentStepProgress) || stepEval.rate === 0)) {
      phase = 'waiting';
      status = stepEval.totalKnown && stepEval.completed !== null
        ? `Waiting on step ${Math.min(stepEval.completed + 1, stepEval.total)} of ${stepEval.total}`
        : 'Waiting for step progress';
      explanation = stepEval.rate === 0
        ? 'No new steps have completed in the latest measured window. The worker may still be running.'
        : 'Waiting for the current step to complete.';
    } else {
      phase = 'active';
      status = stepEval.totalKnown && stepEval.completed !== null
        ? `Running step ${Math.min(stepEval.completed + 1, stepEval.total)} of ${stepEval.total}`
        : stepEval.completed !== null
          ? `Completed ${stepEval.completed} steps`
          : parsedCurrentStep.label
            ? `Running ${parsedCurrentStep.label}`
            : 'Running current step';
      explanation = stepEval.totalKnown && stepEval.completed !== null
        ? `Measured progress: ${stepEval.completed} of ${stepEval.total} steps complete.`
        : stepEval.completed !== null
          ? `Measured progress: ${stepEval.completed} steps complete; total steps unknown.`
          : 'Current-step sub-progress is advancing.';
    }
    if (stepEval.totalKnown && stepEval.remaining !== null) {
      remaining = `${stepEval.remaining} of ${stepEval.total} steps remaining.`;
    }
  } else if (live && (chars === 0 || (outputIdle !== null && outputIdle >= WAITING_OUTPUT_THRESHOLD_MS))) {
    phase = 'waiting';
    status = 'Waiting for model output';
    explanation = 'The model may be loading, processing context or generating.';
  } else if (live && chars > 0) {
    phase = 'active';
    status = 'Receiving output';
    explanation = 'Output is arriving. The total output length is not known.';
  }

  if (stepEval.present && !stepEval.valid && phase !== 'stopping' && phase !== 'failed' && phase !== 'interrupted' && phase !== 'cancelled' && !(live && chars > 0)) {
    explanation = stepEval.rejectionReason;
  }

  const hasClockAnomaly = anomalies.length > 0;
  const clockAnomalyReason = hasClockAnomaly ? anomalies[0] : null;

  const etaBlockedReason = validNow === null
    ? 'Unavailable because the current clock timestamp is invalid or out of range.'
    : hasClockAnomaly
      ? 'Unavailable due to clock anomaly: ' + clockAnomalyReason
      : prematureComplete
        ? 'Unavailable because completion was reported with remaining steps.'
        : phase === 'failed'
          ? 'Unavailable because the attempt failed.'
          : phase === 'interrupted'
            ? 'Unavailable because the run was interrupted.'
            : phase === 'cancelled'
              ? 'Unavailable because the request was cancelled.'
              : phase === 'stopping'
                ? 'Unavailable because stop was requested.'
                : phase === 'stalled'
                  ? 'Unavailable because the run appears stalled with no recent activity.'
                  : waitingForSettlementAfterSteps
                    ? 'Unavailable until the workspace confirms run completion.'
                    : isDraft
                      ? 'Unavailable because the attempt has not started.'
                      : null;

  const defaultUnavailableCurrentStepEta = stepEval.present && stepEval.valid && stepEval.totalKnown
    ? 'Unavailable because current-step sub-progress is not measured.'
    : 'Unavailable because total work and remaining output are unknown.';

  const currentStepEval = finalizeCurrentStep(parsedCurrentStep, {
    overallComplete: isComplete,
    blockedReason: etaBlockedReason,
    defaultUnavailableEta: defaultUnavailableCurrentStepEta,
  });

  let overallEtaMs = null;
  let overallEta = 'Unavailable because total work and remaining output are unknown.';
  let overallEtaUnavailableReason = null;

  if (etaBlockedReason !== null) {
    overallEtaUnavailableReason = etaBlockedReason;
    overallEta = etaBlockedReason;
  } else if (isComplete) {
    overallEtaMs = 0;
    overallEta = 'Complete. No remaining time.';
  } else if (stepEval.present && !stepEval.valid) {
    overallEtaUnavailableReason = stepEval.rejectionReason;
    overallEta = 'Unavailable: ' + stepEval.rejectionReason;
  } else if (!stepEval.totalKnown) {
    overallEtaUnavailableReason = 'Total work and remaining output are unknown.';
    overallEta = 'Unavailable because total work and remaining output are unknown.';
  } else if (stepEval.completed === null || stepEval.remaining === null) {
    overallEtaUnavailableReason = 'Completed step count is not recorded.';
    overallEta = 'Unavailable because completed step count is not recorded.';
  } else if (stepEval.rate === null) {
    overallEtaUnavailableReason = stepEval.rateUnavailableReason;
    overallEta = 'Unavailable: ' + stepEval.rateUnavailableReason;
  } else if (stepEval.rate === 0) {
    overallEtaUnavailableReason = 'Measured step rate is 0 steps/s.';
    overallEta = 'Unavailable because the measured step rate is 0 steps/s.';
  } else if (stepEval.samplesStale) {
    overallEtaUnavailableReason = 'Latest measured step samples are stale.';
    overallEta = 'Unavailable because the latest measured step samples are stale.';
  } else {
    overallEtaMs = computeRemainingEtaMs(stepEval.remaining, stepEval.spanInfo);
    if (overallEtaMs === null) {
      overallEtaUnavailableReason = 'Overall ETA could not be calculated safely.';
      overallEta = 'Unavailable because overall ETA could not be calculated safely.';
    } else {
      overallEta = formatDuration(overallEtaMs);
    }
  }

  let projectedCompletionMs = null;
  let projectedCompletionAt = null;
  let completion = 'Unavailable until a reliable remaining time can be measured.';
  let completionUnavailableReason = null;

  if (hasClockAnomaly) {
    completionUnavailableReason = etaBlockedReason;
    completion = etaBlockedReason;
  } else if (isComplete) {
    if (ended !== null) {
      const iso = safeDateIso(ended);
      const clock = safeLocalClock(ended);
      if (iso !== null && clock !== null) {
        projectedCompletionMs = ended;
        projectedCompletionAt = iso;
        completion = 'Completed at ' + clock + '.';
      } else {
        completionUnavailableReason = 'Recorded completion timestamp is out of range.';
        completion = 'Completed. Completion timestamp is out of range.';
      }
    } else {
      completionUnavailableReason = 'Completion timestamp was not recorded.';
      completion = 'Completed. Completion time was not recorded.';
    }
  } else if (overallEtaMs !== null && validNow !== null) {
    const candidateMs = Math.round(validNow + overallEtaMs);
    const iso = safeDateIso(candidateMs);
    const clock = safeLocalClock(candidateMs);
    if (iso !== null && clock !== null && Number.isSafeInteger(candidateMs)) {
      projectedCompletionMs = candidateMs;
      projectedCompletionAt = iso;
      completion = 'Projected around ' + clock + ' (in ' + formatDuration(overallEtaMs) + ').';
    } else {
      completionUnavailableReason = 'Projected completion exceeds valid calendar range.';
      completion = 'Unavailable because projected completion exceeds valid calendar range.';
    }
  } else if (etaBlockedReason !== null) {
    completionUnavailableReason = etaBlockedReason;
    completion = etaBlockedReason;
  } else if (stepEval.present && !stepEval.valid) {
    completionUnavailableReason = stepEval.rejectionReason;
    completion = 'Unavailable: ' + stepEval.rejectionReason;
  } else if (stepEval.totalKnown && stepEval.rate === 0) {
    completionUnavailableReason = 'Measured step rate is 0 steps/s.';
    completion = 'Unavailable because the measured step rate is 0 steps/s.';
  } else if (stepEval.totalKnown && stepEval.samplesStale) {
    completionUnavailableReason = 'Latest measured step samples are stale.';
    completion = 'Unavailable because the latest measured step samples are stale.';
  } else if (stepEval.totalKnown && stepEval.rate === null) {
    completionUnavailableReason = stepEval.rateUnavailableReason;
    completion = 'Unavailable: ' + stepEval.rateUnavailableReason;
  } else {
    completionUnavailableReason = 'Reliable remaining time cannot be measured.';
    completion = 'Unavailable until a reliable remaining time can be measured.';
  }

  const endedContradicted = endedBeforeDispatched
    || lastAfterEnded
    || (recordedEnded !== null && (Boolean(stepEval.clockAnomaly) || Boolean(parsedCurrentStep.clockAnomaly)));
  const trustedEnded = endedContradicted ? null : ended;

  const isTerminalState = isComplete || isFailed || isInterrupted || isCancelled;
  const elapsedMs = validNow === null || started === null
    ? null
    : trustedEnded !== null
      ? trustedEnded - started
      : isTerminalState
        ? null
        : validNow - started;

  const rate = !hasClockAnomaly && !isTerminalState && validNow !== null && chars !== null && chars > 0 && dispatched !== null && validNow > dispatched
    ? (chars * 1000) / (validNow - dispatched)
    : null;

  const latestActivity = last !== null && latestWorkProgressAt !== null
    ? Math.max(last, latestWorkProgressAt)
    : (last ?? latestWorkProgressAt);
  const latestIdle = validNow !== null && latestActivity !== null ? validNow - latestActivity : null;

  return {
    status,
    explanation,
    phase,
    waiting: phase === 'waiting',
    stalled: phase === 'stalled',
    failed: phase === 'failed',
    complete: phase === 'complete',
    clockAnomaly: hasClockAnomaly,
    clockAnomalyReason,
    elapsedMs,
    chars,
    rate,
    heartbeat,
    heartbeatAt: safeDateIso(heartbeat),
    heartbeatAgeMs,
    lastActivity: latestActivity,
    lastActivityAt: safeDateIso(latestActivity),
    idleMs: latestIdle,
    remaining,
    totalKnown: stepEval.valid && stepEval.totalKnown,
    completedSteps: stepEval.valid ? stepEval.completed : null,
    totalSteps: stepEval.valid ? stepEval.total : null,
    remainingSteps: stepEval.valid ? stepEval.remaining : null,
    doneTotal: stepEval.valid ? stepEval.doneTotal : null,
    percent: stepEval.valid ? stepEval.percent : null,
    stepRate: stepEval.valid ? stepEval.rate : null,
    stepSamplesValid: stepEval.present ? stepEval.valid : null,
    stepRejectionReason: stepEval.rejectionReason,
    currentStep: currentStepEval.info,
    currentStepEtaMs: currentStepEval.etaMs,
    currentStepEta: currentStepEval.eta,
    eta: currentStepEval.eta,
    overallEtaMs,
    overallEta,
    projectedCompletionMs,
    projectedCompletionAt,
    completion,
    unavailableReasons: {
      rate: stepEval.rate === null ? stepEval.rateUnavailableReason : null,
      currentStepEta: currentStepEval.unavailableReason,
      overallEta: overallEtaUnavailableReason,
      completion: completionUnavailableReason,
    },
  };
}

export function progressAnnouncement(task, progress, connection) {
  if (connection !== 'connected') return 'Connection interrupted. The saved task state may be stale.';
  if (!task) return '';

  const hasProgress = progress && typeof progress === 'object';
  if (hasProgress) {
    if (progress.failed === true || progress.phase === 'failed') {
      if (progress.status === 'Incomplete termination') {
        return progress.remaining
          ? `Incomplete termination. ${progress.remaining}`
          : 'Incomplete termination. Completion was reported before all measured steps finished.';
      }
      return 'Attempt failed. Review the problem and recovery status.';
    }
    if (progress.phase === 'interrupted') {
      if (task.status === 'interrupted' && task.attempts?.at(-1)?.recovery?.state === 'retry-safe') {
        return 'Previous attempt interrupted. It is safe to retry after reviewing the scope.';
      }
      return 'Run outcome may be unknown. Review recovery status.';
    }
    if (progress.phase === 'cancelled') {
      return 'Cancellation recorded. Review recovery status.';
    }
    if (progress.complete === false && (
      task.status === 'complete'
      || task.status === 'completed'
      || task.status === 'review'
      || task.status === 'accepted'
      || task.status === 'rejected'
    )) {
      const detail = progress.remaining ?? progress.explanation ?? 'Completion could not be verified.';
      return progress.status ? `${progress.status}. ${detail}` : detail;
    }
  } else if (
    task.status === 'complete'
    || task.status === 'completed'
    || task.status === 'review'
    || task.status === 'accepted'
    || task.status === 'rejected'
  ) {
    const live = task.live && typeof task.live === 'object' ? task.live : null;
    const latestAttempt = Array.isArray(task.attempts) && task.attempts.length > 0 ? task.attempts.at(-1) : null;
    const hasLiveError = typeof live?.error === 'string'
      ? live.error.trim().length > 0
      : Boolean(live?.error && typeof live.error === 'object');
    if (live?.failed === true || latestAttempt?.status === 'failed' || hasLiveError) {
      return 'Attempt failed. Review the problem and recovery status.';
    }
    const rawStepInput = live?.steps !== undefined && live?.steps !== null
      ? live.steps
      : live?.progress !== undefined && live?.progress !== null
        ? live.progress
        : latestAttempt?.progress !== undefined && latestAttempt?.progress !== null
          ? latestAttempt.progress
          : null;
    const stepEval = evaluateStepSeries(rawStepInput, { validNow: MAX_DATE_MS, started: null });
    if (stepEval.valid && stepEval.totalKnown && stepEval.completed !== null && stepEval.completed < stepEval.total) {
      return `Incomplete termination. ${stepEval.remaining} of ${stepEval.total} steps remaining.`;
    }
  }

  if (task.status === 'running') return progress?.status ?? 'Waiting for run state';
  if (task.status === 'complete' || task.status === 'completed') return 'Attempt complete.';
  if (task.status === 'review') return 'Proposal ready for review.';
  if (task.status === 'interrupted' && task.attempts?.at(-1)?.recovery?.state === 'retry-safe') {
    return 'Previous attempt interrupted. It is safe to retry after reviewing the scope.';
  }
  if (task.status === 'interrupted' || task.recovery?.blocked) return 'Run outcome may be unknown. Review recovery status.';
  if (task.status === 'failed') return 'Attempt failed. Review the problem and recovery status.';
  if (task.status === 'cancelled') return 'Cancellation recorded. Review recovery status.';
  if (task.status === 'accepted') return 'Proposal accepted.';
  if (task.status === 'rejected') return 'Proposal rejected.';
  if (task.status === 'draft') return 'Waiting for approval.';
  return '';
}
