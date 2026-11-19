// CydeWorks AI Receipt Analytics Engine (isolated candidate).
// Pure, deterministic, dependency-free ES module.
// Validates every envelope with validateReceiptExport from harness/receipt-contract.mjs
// and isolates contradictory field claims at the analytics boundary while preserving valid batch data.

import {
  ATTEMPT_STATUSES,
  COST_EVIDENCE,
  RECEIPT_EXPORT_FORMAT,
  RECEIPT_EXPORT_VERSION,
  RECEIPT_SCHEMA_VERSION,
  TIMEBASES,
  UNAVAILABLE_REASONS,
  validateReceiptExport,
} from './receipt-contract.mjs';

import {
  ANALYTICS_FORMAT,
  ANALYTICS_LIMIT_NOTES,
  ANALYTICS_LIMITS,
  ANALYTICS_SCHEMA_VERSION,
  ATTEMPT_LIST_BASES,
  BACKENDS,
  COST_EVIDENCE_STATES,
  ENDED_AT_STATES,
  EXECUTION_PHASES,
  EXPECTED_RUN_STATUS_BY_RECORDED,
  KNOWN_OUTCOME_BASES,
  OUTCOME_BASES,
  RECORDED_ATTEMPT_STATUSES,
  RECOVERY_EVIDENCE_VALUES,
  RECOVERY_STATES,
  STARTED_AT_STATES,
  TASK_STATUSES,
  TOKEN_CATEGORIES,
  getOwnDataProperty,
  isDateSafeEpochMs,
  isPlainArrayContainer,
  safeAddIntegers,
  validateAnalyticsOptions,
  validateAnalyticsSummary,
  validateEnvelopeConsistency,
} from './receipt-analytics-contract.mjs';

function makeZeroMap(keys) {
  return Object.fromEntries(keys.map((k) => [k, 0]));
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  }
  const sortedKeys = Object.keys(value).sort();
  return (
    '{' +
    sortedKeys
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
      .join(',') +
    '}'
  );
}

function deepCopyJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function createIntegerAccumulator() {
  return {
    knownCount: 0,
    unknownCount: 0,
    overflow: false,
    sum: 0,
  };
}

function addValueToAccumulator(acc, value) {
  if (value === null || value === undefined) {
    acc.unknownCount += 1;
    return;
  }
  acc.knownCount += 1;
  if (acc.overflow) {
    return;
  }
  const res = safeAddIntegers(acc.sum, value);
  if (res.overflow || !res.ok) {
    acc.overflow = true;
    acc.sum = null;
  } else {
    acc.sum = res.value;
  }
}

function finalizeTokenAccumulator(acc, totalAttemptCount, historyComplete = true) {
  let observationCompleteness = 'no-data';
  if (totalAttemptCount === 0) {
    observationCompleteness = 'no-data';
  } else if (acc.overflow) {
    observationCompleteness = 'overflow';
  } else if (acc.knownCount === 0) {
    observationCompleteness = 'unknown';
  } else if (acc.unknownCount > 0) {
    observationCompleteness = 'partial';
  } else {
    observationCompleteness = 'complete';
  }

  const completeness =
    observationCompleteness === 'complete' && !historyComplete
      ? 'partial'
      : observationCompleteness;

  const knownSum = acc.overflow || acc.knownCount === 0 ? null : acc.sum;
  const completeTotal = completeness === 'complete' ? acc.sum : null;

  return {
    knownAttemptCount: acc.knownCount,
    unknownAttemptCount: acc.unknownCount,
    overflow: acc.overflow,
    knownSum,
    completeTotal,
    observationCompleteness,
    completeness,
  };
}

/**
 * Isolates contradictory fields on an available envelope so that contradictory
 * cost/timestamp/usage/acceptance claims cannot pollute known totals, while
 * preserving the envelope's valid observations and valid batch data.
 */
function sanitizeEnvelopeContradictions(envelope, envelopeIndex, pushIssue) {
  const consistency = validateEnvelopeConsistency(envelope);
  if (consistency.ok) {
    return { sanitized: envelope, hadContradiction: false };
  }

  for (const iss of consistency.issues) {
    pushIssue(
      `$.envelopes[${envelopeIndex}]${iss.path.slice(1)}`,
      iss.code,
      iss.message,
      iss.detailCode
    );
  }

  const copy = deepCopyJson(envelope);
  const { run, evidence } = copy;

  if (run.accepted !== (evidence.acceptance.state === 'accepted')) {
    run.accepted = false;
    if (evidence.acceptance.state === 'accepted') {
      evidence.acceptance.state = 'unconfirmed';
    }
  }

  const hasCompleteBasisOnly =
    evidence.attemptList.basis.length === 1 &&
    evidence.attemptList.basis[0] === 'event-log-accounts-for-every-attempt';
  if (
    run.attemptsComplete !== evidence.attemptList.complete ||
    evidence.chargeInput.unattributed > 0 ||
    !hasCompleteBasisOnly
  ) {
    run.attemptsComplete = false;
    evidence.attemptList.complete = false;
  }

  for (let i = 0; i < run.attempts.length; i += 1) {
    const att = run.attempts[i];
    const ev = evidence.attempts[i];

    // Isolate contradictory cost: never count as known cost
    if (att.cost !== null && ev.cost !== 'caller-supplied') {
      att.cost = null;
    } else if (att.cost === null && ev.cost === 'caller-supplied') {
      ev.cost = 'charge-record-invalid';
    }

    // Isolate contradictory timestamps
    if ((att.startedAtMs !== null) !== (ev.startedAt === 'recorded')) {
      att.startedAtMs = null;
      if (ev.startedAt === 'recorded') {
        ev.startedAt = 'invalid';
      }
    }
    if (
      (att.endedAtMs !== null) !== (ev.endedAt === 'recorded') ||
      ev.recordedStatus === 'running' ||
      ev.recordedStatus === 'interrupted'
    ) {
      if (att.endedAtMs !== null || ev.endedAt === 'recorded') {
        att.endedAtMs = null;
        if (ev.endedAt === 'recorded') {
          ev.endedAt = ev.recordedStatus === 'running' ? 'not-ended' : 'invalid';
        }
      }
    }

    // Isolate contradictory status / outcome / model
    if (att.status !== EXPECTED_RUN_STATUS_BY_RECORDED[ev.recordedStatus]) {
      att.status = EXPECTED_RUN_STATUS_BY_RECORDED[ev.recordedStatus];
    }
    if (att.outcomeKnown !== KNOWN_OUTCOME_BASES.includes(ev.outcomeBasis)) {
      att.outcomeKnown = false;
    }
    if (ev.modelWithheld && att.model !== 'withheld') {
      att.model = 'withheld';
    }

    // Isolate contradictory usage
    const usage = ev.usage;
    const expectedSemantics =
      usage.evidence === 'OpenCode reported'
        ? 'opencode-engine-defined'
        : usage.evidence === 'provider reported'
        ? 'provider-defined'
        : 'unavailable';
    const unsafeSteps =
      usage.steps &&
      (usage.steps.identityAmbiguous ||
        usage.steps.conflict ||
        usage.steps.truncated ||
        (usage.steps.unidentified && usage.steps.items.length > 1));
    if (
      usage.semantics !== expectedSemantics ||
      usage.evidence === 'unavailable' ||
      (usage.steps && usage.evidence !== 'OpenCode reported') ||
      unsafeSteps
    ) {
      for (const cat of TOKEN_CATEGORIES) {
        usage[cat] = null;
      }
      if (usage.semantics !== expectedSemantics) {
        usage.semantics = expectedSemantics;
      }
    }
  }

  return { sanitized: copy, hadContradiction: true };
}

function computeMergedIntervals(intervals) {
  if (intervals.length === 0) {
    return {
      hasOverlappingAttempts: false,
      mergedActiveWallClockMs: null,
      spanWallClockMs: null,
      earliestStartMs: null,
      latestEndMs: null,
      overflow: false,
    };
  }

  const sorted = [...intervals].sort((a, b) =>
    a.startMs !== b.startMs ? a.startMs - b.startMs : a.endMs - b.endMs
  );

  let hasOverlappingAttempts = false;
  const merged = [{ startMs: sorted[0].startMs, endMs: sorted[0].endMs }];
  let earliestStartMs = sorted[0].startMs;
  let latestEndMs = sorted[0].endMs;

  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    if (current.startMs < earliestStartMs) earliestStartMs = current.startMs;
    if (current.endMs > latestEndMs) latestEndMs = current.endMs;

    const last = merged[merged.length - 1];
    if (current.startMs < last.endMs) {
      hasOverlappingAttempts = true;
      if (current.endMs > last.endMs) {
        last.endMs = current.endMs;
      }
    } else if (current.startMs === last.endMs) {
      last.endMs = current.endMs;
    } else {
      merged.push({ startMs: current.startMs, endMs: current.endMs });
    }
  }

  let activeMs = 0;
  let overflow = false;
  for (const seg of merged) {
    const segDuration = seg.endMs - seg.startMs;
    const added = safeAddIntegers(activeMs, segDuration);
    if (!added.ok || added.overflow) {
      overflow = true;
      activeMs = null;
      break;
    }
    activeMs = added.value;
  }

  const spanDuration = latestEndMs - earliestStartMs;
  const spanSafe = Number.isSafeInteger(spanDuration) && spanDuration >= 0 ? spanDuration : null;

  return {
    hasOverlappingAttempts,
    mergedActiveWallClockMs: overflow ? null : activeMs,
    spanWallClockMs: spanSafe,
    earliestStartMs,
    latestEndMs,
    overflow,
  };
}

function isRecordedStatusTransitionValid(olderRecorded, newerRecorded) {
  if (olderRecorded === newerRecorded) {
    return true;
  }
  if (olderRecorded === 'running') {
    return true;
  }
  if (olderRecorded === 'review' && (newerRecorded === 'accepted' || newerRecorded === 'rejected')) {
    return true;
  }
  return false;
}

function isAttemptPrefixConsistent(olderEnv, newerEnv) {
  const olderAttempts = olderEnv.run.attempts;
  const newerAttempts = newerEnv.run.attempts;
  if (newerAttempts.length < olderAttempts.length) {
    return false;
  }
  for (let i = 0; i < olderAttempts.length; i += 1) {
    const oAtt = olderAttempts[i];
    const nAtt = newerAttempts[i];
    const oEv = olderEnv.evidence.attempts[i];
    const nEv = newerEnv.evidence.attempts[i];

    if (
      oAtt.attemptId !== nAtt.attemptId ||
      oAtt.provider !== nAtt.provider ||
      oAtt.model !== nAtt.model ||
      oEv.backend !== nEv.backend ||
      oEv.modelWithheld !== nEv.modelWithheld
    ) {
      return false;
    }

    if (!isRecordedStatusTransitionValid(oEv.recordedStatus, nEv.recordedStatus)) {
      return false;
    }

    if (oAtt.startedAtMs !== null && nAtt.startedAtMs !== oAtt.startedAtMs) {
      return false;
    }
    if (oAtt.endedAtMs !== null && nAtt.endedAtMs !== oAtt.endedAtMs) {
      return false;
    }
    if (
      oEv.operatorEditCount !== null &&
      nEv.operatorEditCount !== null &&
      nEv.operatorEditCount < oEv.operatorEditCount
    ) {
      return false;
    }
  }
  return true;
}

function isUsageObservationMeaningful(usage) {
  if (!usage) return false;
  if (usage.evidence !== 'unavailable') return true;
  return TOKEN_CATEGORIES.some((cat) => usage[cat] !== null);
}

function areUsageObservationsCompatible(uA, uB) {
  if (!isUsageObservationMeaningful(uA) || !isUsageObservationMeaningful(uB)) {
    return true;
  }
  if (uA.evidence !== uB.evidence || uA.semantics !== uB.semantics) {
    return false;
  }
  for (const field of [
    ...TOKEN_CATEGORIES,
    'generationMs',
    'loadMs',
    'promptMs',
  ]) {
    if (uA[field] !== null && uB[field] !== null && uA[field] !== uB[field]) {
      return false;
    }
  }
  if (uA.steps && uB.steps && canonicalJson(uA.steps) !== canonicalJson(uB.steps)) {
    return false;
  }
  return true;
}

function mergeCompatibleUsage(olderUsage, newerUsage) {
  if (!isUsageObservationMeaningful(newerUsage) && isUsageObservationMeaningful(olderUsage)) {
    return { merged: deepCopyJson(olderUsage), preservedFromOlder: true };
  }
  if (!isUsageObservationMeaningful(olderUsage)) {
    return { merged: deepCopyJson(newerUsage), preservedFromOlder: false };
  }
  const merged = deepCopyJson(newerUsage);
  let preservedFromOlder = false;
  for (const field of [
    ...TOKEN_CATEGORIES,
    'generationMs',
    'loadMs',
    'promptMs',
  ]) {
    if (merged[field] === null && olderUsage[field] !== null) {
      merged[field] = olderUsage[field];
      preservedFromOlder = true;
    }
  }
  if (!merged.steps && olderUsage.steps) {
    merged.steps = deepCopyJson(olderUsage.steps);
    preservedFromOlder = true;
  }
  return { merged, preservedFromOlder };
}

function reconcileRunGroup(runId, entries, crossRunAttemptIdCollision) {
  const allEnvelopeIndexes = entries.map((e) => e.envelopeIndex).sort((a, b) => a - b);

  const distinctSnapshots = [];
  const seenBySignature = new Map();
  let exactDuplicatesCollapsed = 0;

  for (const entry of entries) {
    const sig =
      canonicalJson(entry.envelope.run) + '|' + canonicalJson(entry.envelope.evidence);
    if (seenBySignature.has(sig)) {
      exactDuplicatesCollapsed += 1;
      seenBySignature.get(sig).envelopeIndexes.push(entry.envelopeIndex);
    } else {
      const snap = {
        envelope: entry.envelope,
        firstEnvelopeIndex: entry.envelopeIndex,
        envelopeIndexes: [entry.envelopeIndex],
        recordVersion: entry.envelope.evidence.task.recordVersion,
      };
      seenBySignature.set(sig, snap);
      distinctSnapshots.push(snap);
    }
  }

  const conflictSet = new Set();

  if (crossRunAttemptIdCollision) {
    conflictSet.add('identity-mismatch');
  }

  const hasNullVersion = distinctSnapshots.some((s) => s.recordVersion === null);
  if (hasNullVersion) {
    conflictSet.add('unknown-record-version');
  }

  if (distinctSnapshots.length > 1) {
    const base = distinctSnapshots[0].envelope;
    for (let i = 1; i < distinctSnapshots.length; i += 1) {
      const curr = distinctSnapshots[i].envelope;
      if (
        curr.run.taskKey !== base.run.taskKey ||
        curr.run.inputRevision !== base.run.inputRevision ||
        curr.evidence.task.kind !== base.evidence.task.kind
      ) {
        conflictSet.add('identity-mismatch');
      }
      if (curr.evidence.timebase !== base.evidence.timebase) {
        conflictSet.add('timebase-mismatch');
      }
    }

    const versionGroups = new Map();
    for (const snap of distinctSnapshots) {
      if (snap.recordVersion !== null) {
        if (!versionGroups.has(snap.recordVersion)) {
          versionGroups.set(snap.recordVersion, []);
        }
        versionGroups.get(snap.recordVersion).push(snap);
      }
    }

    for (const [, group] of versionGroups.entries()) {
      if (group.length > 1) {
        conflictSet.add('equal-version-conflict');
      }
    }

    if (!hasNullVersion && !conflictSet.has('equal-version-conflict')) {
      const orderedByVersion = [...distinctSnapshots].sort(
        (a, b) => a.recordVersion - b.recordVersion
      );
      for (let i = 1; i < orderedByVersion.length; i += 1) {
        const older = orderedByVersion[i - 1].envelope;
        const newer = orderedByVersion[i].envelope;
        if (!isAttemptPrefixConsistent(older, newer)) {
          conflictSet.add('attempt-history-regression');
        }
      }
    }
  }

  const observedRecordVersions = Array.from(
    new Set(
      distinctSnapshots
        .map((s) => s.recordVersion)
        .filter((v) => v !== null)
    )
  ).sort((a, b) => a - b);

  let mergedEnvelope = null;
  let preservedCostAttemptCount = 0;
  let preservedUsageAttemptCount = 0;
  const preservedSourceVersions = new Set();

  if (conflictSet.size === 0) {
    const orderedByVersion = [...distinctSnapshots].sort(
      (a, b) => a.recordVersion - b.recordVersion
    );
    const latestSnap = orderedByVersion[orderedByVersion.length - 1];
    mergedEnvelope = deepCopyJson(latestSnap.envelope);

    if (orderedByVersion.length > 1) {
      const olderSnaps = orderedByVersion.slice(0, -1);

      for (const olderSnap of olderSnaps) {
        if (olderSnap.envelope.evidence.chargeInput.unattributed > 0) {
          if (mergedEnvelope.evidence.chargeInput.records === 0) {
            mergedEnvelope.evidence.chargeInput = deepCopyJson(
              olderSnap.envelope.evidence.chargeInput
            );
            mergedEnvelope.run.attemptsComplete = false;
            mergedEnvelope.evidence.attemptList.complete = false;
            const basisSet = new Set(
              mergedEnvelope.evidence.attemptList.basis.filter(
                (b) => b !== 'event-log-accounts-for-every-attempt'
              )
            );
            basisSet.add('charge-for-unrecorded-attempt');
            mergedEnvelope.evidence.attemptList.basis = Array.from(basisSet);
            preservedSourceVersions.add(olderSnap.recordVersion);
          } else if (
            canonicalJson(olderSnap.envelope.evidence.chargeInput) !==
            canonicalJson(mergedEnvelope.evidence.chargeInput)
          ) {
            conflictSet.add('conflicting-attempt-evidence');
          }
        }
      }

      for (let attIdx = 0; attIdx < mergedEnvelope.run.attempts.length; attIdx += 1) {
        let currentCost = mergedEnvelope.run.attempts[attIdx].cost;
        let currentCostState = mergedEnvelope.evidence.attempts[attIdx].cost;
        let currentUsage = mergedEnvelope.evidence.attempts[attIdx].usage;
        let costPreservedForAttempt = false;
        let usagePreservedForAttempt = false;

        for (const olderSnap of olderSnaps) {
          if (attIdx >= olderSnap.envelope.run.attempts.length) {
            continue;
          }
          const olderAtt = olderSnap.envelope.run.attempts[attIdx];
          const olderEv = olderSnap.envelope.evidence.attempts[attIdx];

          if (olderEv.cost !== 'not-recorded') {
            if (currentCostState === 'not-recorded') {
              if (olderEv.cost === 'caller-supplied' && olderAtt.cost !== null) {
                currentCost = deepCopyJson(olderAtt.cost);
                currentCostState = 'caller-supplied';
                costPreservedForAttempt = true;
                preservedSourceVersions.add(olderSnap.recordVersion);
              } else {
                currentCost = null;
                currentCostState = olderEv.cost;
                costPreservedForAttempt = true;
                preservedSourceVersions.add(olderSnap.recordVersion);
              }
            } else if (
              currentCostState !== olderEv.cost ||
              canonicalJson(currentCost) !== canonicalJson(olderAtt.cost)
            ) {
              conflictSet.add('conflicting-attempt-evidence');
            }
          }

          if (!areUsageObservationsCompatible(olderEv.usage, currentUsage)) {
            conflictSet.add('conflicting-attempt-evidence');
          } else {
            const mergedUsageRes = mergeCompatibleUsage(olderEv.usage, currentUsage);
            currentUsage = mergedUsageRes.merged;
            if (mergedUsageRes.preservedFromOlder) {
              usagePreservedForAttempt = true;
              preservedSourceVersions.add(olderSnap.recordVersion);
            }
          }
        }

        mergedEnvelope.run.attempts[attIdx].cost = currentCost;
        mergedEnvelope.evidence.attempts[attIdx].cost = currentCostState;
        mergedEnvelope.evidence.attempts[attIdx].usage = currentUsage;

        if (costPreservedForAttempt) {
          preservedCostAttemptCount += 1;
        }
        if (usagePreservedForAttempt) {
          preservedUsageAttemptCount += 1;
        }
      }

      const mergedCallerSuppliedCount = mergedEnvelope.run.attempts.filter(
        (a) => a.cost !== null
      ).length;
      if (mergedEnvelope.evidence.chargeInput.records < mergedCallerSuppliedCount) {
        mergedEnvelope.evidence.chargeInput.records = mergedCallerSuppliedCount;
      }
    }
  }

  if (conflictSet.size > 0) {
    return {
      resolved: false,
      runId,
      exactDuplicatesCollapsed,
      supersededExportsCount: 0,
      unresolvedRecord: {
        runId,
        conflictCodes: Array.from(conflictSet).sort(),
        envelopeIndexes: allEnvelopeIndexes,
        snapshotCount: distinctSnapshots.length,
        observedRecordVersions,
        hasNullVersion,
      },
    };
  }

  const orderedByVersion = [...distinctSnapshots].sort(
    (a, b) => a.recordVersion - b.recordVersion
  );
  const winner = orderedByVersion[orderedByVersion.length - 1];
  const supersededSnapshots = orderedByVersion.slice(0, -1);
  const supersededRecordVersions = supersededSnapshots.map((s) => s.recordVersion);

  return {
    resolved: true,
    runId,
    exactDuplicatesCollapsed,
    supersededExportsCount: supersededSnapshots.length,
    winnerEnvelope: mergedEnvelope,
    resolvedRecord: {
      runId,
      taskKey: mergedEnvelope.run.taskKey,
      inputRevision: mergedEnvelope.run.inputRevision,
      recordVersion: winner.recordVersion,
      timebase: mergedEnvelope.evidence.timebase,
      selectedEnvelopeIndex: winner.firstEnvelopeIndex,
      allEnvelopeIndexes,
      duplicateExportCount: exactDuplicatesCollapsed,
      supersededExportCount: supersededSnapshots.length,
      supersededRecordVersions,
      preservedFromOlderVersions: {
        costAttemptCount: preservedCostAttemptCount,
        usageAttemptCount: preservedUsageAttemptCount,
        sourceRecordVersions: Array.from(preservedSourceVersions).sort((a, b) => a - b),
      },
    },
  };
}

function buildEmptySummary({ ok, status, issues }) {
  const emptyCategoryTokens = Object.fromEntries(
    TOKEN_CATEGORIES.map((cat) => [
      cat,
      {
        knownAttemptCount: 0,
        unknownAttemptCount: 0,
        overflow: false,
        knownSum: null,
        completeTotal: null,
        observationCompleteness: 'no-data',
        completeness: 'no-data',
      },
    ])
  );

  return {
    format: ANALYTICS_FORMAT,
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    sourceContract: {
      exportFormat: RECEIPT_EXPORT_FORMAT,
      exportFormatVersion: RECEIPT_EXPORT_VERSION,
      runSchemaVersion: RECEIPT_SCHEMA_VERSION,
    },
    ok,
    clean: ok && status === 'empty',
    failClosed: !ok,
    status,
    envelopeCounts: {
      total: 0,
      available: 0,
      unavailable: 0,
      malformed: 0,
    },
    unavailableReasonCounts: makeZeroMap(Object.keys(UNAVAILABLE_REASONS)),
    unavailableEnvelopes: [],
    malformedEnvelopes: [],
    reconciliation: {
      distinctRunIdsSeen: 0,
      resolvedRunCount: 0,
      unresolvedRunCount: 0,
      exactDuplicatesCollapsed: 0,
      supersededExportsCount: 0,
      preservedEvidenceRunCount: 0,
      resolvedRuns: [],
      unresolvedRuns: [],
    },
    runs: {
      resolvedRunCount: 0,
      unresolvedRunCount: 0,
      taskKindCounts: { brief: 0, change: 0 },
      taskStatusCounts: makeZeroMap(TASK_STATUSES),
      acceptance: {
        acceptedRunCount: 0,
        unconfirmedAcceptanceRunCount: 0,
        notAcceptedRunCount: 0,
        operatorEditedRunCount: 0,
        operatorEditedFalseRunCount: 0,
        operatorEditedUnknownRunCount: 0,
        runsWithEarlierAcceptedAttemptsCount: 0,
        earlierAcceptedAttemptsTotal: 0,
        earlierAcceptedAttemptsOverflow: false,
      },
      attemptListCompleteness: {
        completeRunCount: 0,
        incompleteRunCount: 0,
        basisCounts: makeZeroMap(ATTEMPT_LIST_BASES),
      },
      retries: {
        linkageBasis: 'recorded-order-only',
        runsWithRetriesCount: 0,
        initialAttemptCount: 0,
        retryAttemptCount: 0,
        retryAttemptStatusCounts: makeZeroMap(ATTEMPT_STATUSES),
        priorAttemptBeforeFinalCount: 0,
      },
    },
    attempts: {
      totalAttemptCount: 0,
      statusCounts: makeZeroMap(ATTEMPT_STATUSES),
      recordedStatusCounts: makeZeroMap(RECORDED_ATTEMPT_STATUSES),
      outcomes: {
        knownOutcomeCount: 0,
        unknownOutcomeCount: 0,
        outcomeBasisCounts: makeZeroMap(OUTCOME_BASES),
        recoveryStateCounts: makeZeroMap(RECOVERY_STATES),
        recoveryEvidenceCounts: makeZeroMap(RECOVERY_EVIDENCE_VALUES),
        executionPhaseCounts: makeZeroMap(EXECUTION_PHASES),
      },
      providersAndModels: {
        providerCounts: {},
        backendCounts: makeZeroMap(BACKENDS),
        modelWithheldCount: 0,
        modelDisclosedCount: 0,
        inferredModelsCount: 0,
        inferencePolicy: 'never-infer-withheld-identities',
      },
      operatorEditsAndChecks: {
        attemptsWithKnownOperatorEditsCount: 0,
        attemptsWithUnknownOperatorEditsCount: 0,
        totalOperatorEdits: 0,
        operatorEditsOverflow: false,
        attemptsWithChecksCount: 0,
        attemptsWithoutChecksCount: 0,
        totalChecksPassed: 0,
        totalChecksFailed: 0,
        checksOverflow: false,
      },
    },
    tokens: {
      categoryOverlapPolicy: 'categories-not-summed-or-subtracted',
      totalAttemptCount: 0,
      historyComplete: true,
      incompletenessReasons: [],
      observationCompleteness: 'no-data',
      overallCompleteness: 'no-data',
      byCategory: emptyCategoryTokens,
      byProvenance: [],
    },
    costs: {
      accountingPolicy: 'exact-integer-micros-no-currency-conversion-no-evidence-mixing',
      billingAuthenticationStatus: 'unverified-caller-supplied-claims-only',
      routerSavingsClaim: 'not-supported',
      totalAttemptCount: 0,
      knownCostAttemptCount: 0,
      unknownCostAttemptCount: 0,
      incompleteCostAttemptCount: 0,
      historyComplete: true,
      incompletenessReasons: [],
      observationCompleteness: 'no-data',
      completeness: 'no-data',
      costEvidenceStateCounts: makeZeroMap(COST_EVIDENCE_STATES),
      chargeInputSummary: {
        recordsTotal: 0,
        duplicatesTotal: 0,
        unattributedTotal: 0,
        overflow: false,
      },
      currencies: [],
      hasMixedCurrencies: false,
      hasUnknownCosts: false,
      hasOverflow: false,
      groups: [],
      byCurrencyAndEvidence: {},
    },
    timing: {
      timebaseCounts: makeZeroMap(TIMEBASES),
      calendarTime: {
        available: false,
        completeness: 'unavailable',
        unavailableReason: 'no-resolved-runs',
        earliestStartedAtMs: null,
        latestEndedAtMs: null,
        earliestStartedAtIso: null,
        latestEndedAtIso: null,
      },
      crossRunOrdering: {
        available: false,
        unavailableReason: 'no-resolved-runs',
        orderedRunIds: null,
      },
      crossRunWallClock: {
        available: false,
        unavailableReason: 'no-resolved-runs',
        mergedActiveWallClockMs: null,
        spanWallClockMs: null,
        hasOverlappingAttempts: false,
      },
      attemptTimestamps: {
        startedAtStateCounts: makeZeroMap(STARTED_AT_STATES),
        endedAtStateCounts: makeZeroMap(ENDED_AT_STATES),
        attemptsWithCompleteIntervalCount: 0,
        attemptsWithIncompleteIntervalCount: 0,
      },
      recordedElapsedMs: {
        isWallClockTime: false,
        knownAttemptCount: 0,
        unknownAttemptCount: 0,
        overflow: false,
        cumulativeKnownElapsedMs: null,
      },
      perRunWallClock: [],
    },
    issues,
    limits: [...ANALYTICS_LIMIT_NOTES],
  };
}

export function summarizeReceiptExports(envelopes, options) {
  const optValidation = validateAnalyticsOptions(options);
  if (!optValidation.ok) {
    return buildEmptySummary({
      ok: false,
      status: 'invalid-input',
      issues: optValidation.issues,
    });
  }

  const maxEnvelopes = optValidation.options.maxEnvelopes;
  if (!Array.isArray(envelopes)) {
    return buildEmptySummary({
      ok: false,
      status: 'invalid-input',
      issues: [
        {
          path: '$.envelopes',
          code: 'invalid-array',
          message: 'envelopes must be an array of receipt export envelopes.',
        },
      ],
    });
  }

  if (envelopes.length > maxEnvelopes) {
    return buildEmptySummary({
      ok: false,
      status: 'invalid-input',
      issues: [
        {
          path: '$.envelopes',
          code: 'too-many-envelopes',
          message: `envelopes exceeds maximum allowed length of ${maxEnvelopes}.`,
        },
      ],
    });
  }

  if (!isPlainArrayContainer(envelopes, maxEnvelopes)) {
    return buildEmptySummary({
      ok: false,
      status: 'invalid-input',
      issues: [
        {
          path: '$.envelopes',
          code: 'invalid-array',
          message: 'envelopes must be a plain array without extra properties.',
        },
      ],
    });
  }

  if (envelopes.length === 0) {
    return buildEmptySummary({
      ok: true,
      status: 'empty',
      issues: [],
    });
  }

  const envelopeCounts = {
    total: envelopes.length,
    available: 0,
    unavailable: 0,
    malformed: 0,
  };
  const unavailableReasonCounts = makeZeroMap(Object.keys(UNAVAILABLE_REASONS));
  const unavailableEnvelopes = [];
  const malformedEnvelopes = [];
  const issues = [];
  let hasContradictoryEvidence = false;

  const pushIssue = (path, code, message, detailCode = null) => {
    if (issues.length < ANALYTICS_LIMITS.issues) {
      issues.push(detailCode ? { path, code, detailCode, message } : { path, code, message });
    }
  };

  const byRunId = new Map();

  for (let index = 0; index < envelopes.length; index += 1) {
    const prop = getOwnDataProperty(envelopes, index);
    if (!prop.present || !prop.valid || prop.value === undefined) {
      envelopeCounts.malformed += 1;
      malformedEnvelopes.push({
        envelopeIndex: index,
        issueCount: 1,
        issueCodes: ['invalid-envelope-slot'],
        firstIssuePath: `$.envelopes[${index}]`,
      });
      pushIssue(
        `$.envelopes[${index}]`,
        'malformed-envelope',
        'Envelope slot is missing, undefined, or uses an accessor.',
        'invalid-envelope-slot'
      );
      continue;
    }

    const envelope = prop.value;
    const validation = validateReceiptExport(envelope);

    if (!validation.ok) {
      envelopeCounts.malformed += 1;
      const issueCodes = Array.from(new Set(validation.issues.map((i) => i.code))).sort();
      const firstIssuePath = validation.issues[0]?.path ?? '$';
      malformedEnvelopes.push({
        envelopeIndex: index,
        issueCount: validation.issues.length,
        issueCodes,
        firstIssuePath,
      });
      pushIssue(
        `$.envelopes[${index}]`,
        'malformed-envelope',
        'Envelope failed validateReceiptExport validation.',
        issueCodes[0] ?? 'validation-failed'
      );
      continue;
    }

    if (envelope.available === false) {
      envelopeCounts.unavailable += 1;
      const reasonCodes = envelope.reasons.map((r) => r.code);
      for (const code of reasonCodes) {
        if (Object.hasOwn(unavailableReasonCounts, code)) {
          unavailableReasonCounts[code] += 1;
        }
      }
      unavailableEnvelopes.push({
        envelopeIndex: index,
        reasonCodes,
      });
      continue;
    }

    // The exporter reports a run with no attempts as unavailable. Keep an inconsistent
    // available receipt out of reconciliation so it cannot discard valid sibling receipts.
    if (envelope.run.attempts.length === 0) {
      const code = 'available-receipt-without-attempts';
      envelopeCounts.malformed += 1;
      malformedEnvelopes.push({
        envelopeIndex: index,
        issueCount: 1,
        issueCodes: [code],
        firstIssuePath: '$.run.attempts',
      });
      pushIssue(
        `$.envelopes[${index}].run.attempts`,
        'malformed-envelope',
        'An available receipt must contain at least one recorded attempt.',
        code
      );
      continue;
    }

    // Isolate contradictory fields on the envelope while preserving valid batch data
    const { sanitized, hadContradiction } = sanitizeEnvelopeContradictions(
      envelope,
      index,
      pushIssue
    );
    if (hadContradiction) {
      hasContradictoryEvidence = true;
    }

    envelopeCounts.available += 1;
    const runId = sanitized.run.runId;
    if (!byRunId.has(runId)) {
      byRunId.set(runId, []);
    }
    byRunId.get(runId).push({ envelopeIndex: index, envelope: sanitized });
  }

  // Detect cross-run attemptId collisions
  const attemptIdOwners = new Map();
  const collidingRunIds = new Set();
  for (const [runId, entries] of byRunId.entries()) {
    for (const { envelope } of entries) {
      for (const att of envelope.run.attempts) {
        const priorRunId = attemptIdOwners.get(att.attemptId);
        if (priorRunId !== undefined && priorRunId !== runId) {
          collidingRunIds.add(priorRunId);
          collidingRunIds.add(runId);
        } else {
          attemptIdOwners.set(att.attemptId, runId);
        }
      }
    }
  }

  const sortedRunIds = Array.from(byRunId.keys()).sort();
  const resolvedRuns = [];
  const unresolvedRuns = [];
  const resolvedEnvelopes = [];
  let exactDuplicatesCollapsed = 0;
  let supersededExportsCount = 0;
  let preservedEvidenceRunCount = 0;

  for (const runId of sortedRunIds) {
    const entries = byRunId.get(runId);
    const rec = reconcileRunGroup(runId, entries, collidingRunIds.has(runId));
    exactDuplicatesCollapsed += rec.exactDuplicatesCollapsed;
    supersededExportsCount += rec.supersededExportsCount;

    if (rec.resolved) {
      if (
        rec.resolvedRecord.preservedFromOlderVersions.costAttemptCount > 0 ||
        rec.resolvedRecord.preservedFromOlderVersions.usageAttemptCount > 0
      ) {
        preservedEvidenceRunCount += 1;
      }
      resolvedRuns.push(rec.resolvedRecord);
      resolvedEnvelopes.push(rec.winnerEnvelope);
    } else {
      unresolvedRuns.push(rec.unresolvedRecord);
      pushIssue(
        `$.reconciliation.unresolvedRuns[${unresolvedRuns.length - 1}]`,
        'unresolved-run-reconciliation',
        'Run exports could not be reconciled unambiguously.',
        rec.unresolvedRecord.conflictCodes[0]
      );
    }
  }

  // Aggregate across resolved runs
  const taskKindCounts = { brief: 0, change: 0 };
  const taskStatusCounts = makeZeroMap(TASK_STATUSES);
  const acceptance = {
    acceptedRunCount: 0,
    unconfirmedAcceptanceRunCount: 0,
    notAcceptedRunCount: 0,
    operatorEditedRunCount: 0,
    operatorEditedFalseRunCount: 0,
    operatorEditedUnknownRunCount: 0,
    runsWithEarlierAcceptedAttemptsCount: 0,
    earlierAcceptedAttemptsTotal: 0,
    earlierAcceptedAttemptsOverflow: false,
  };
  const attemptListCompleteness = {
    completeRunCount: 0,
    incompleteRunCount: 0,
    basisCounts: makeZeroMap(ATTEMPT_LIST_BASES),
  };
  const retries = {
    linkageBasis: 'recorded-order-only',
    runsWithRetriesCount: 0,
    initialAttemptCount: 0,
    retryAttemptCount: 0,
    retryAttemptStatusCounts: makeZeroMap(ATTEMPT_STATUSES),
    priorAttemptBeforeFinalCount: 0,
  };

  let totalAttemptCount = 0;
  const statusCounts = makeZeroMap(ATTEMPT_STATUSES);
  const recordedStatusCounts = makeZeroMap(RECORDED_ATTEMPT_STATUSES);
  const outcomeBasisCounts = makeZeroMap(OUTCOME_BASES);
  const recoveryStateCounts = makeZeroMap(RECOVERY_STATES);
  const recoveryEvidenceCounts = makeZeroMap(RECOVERY_EVIDENCE_VALUES);
  const executionPhaseCounts = makeZeroMap(EXECUTION_PHASES);
  const backendCounts = makeZeroMap(BACKENDS);
  const providerCountsRaw = new Map();
  let knownOutcomeCount = 0;
  let unknownOutcomeCount = 0;
  let modelWithheldCount = 0;
  let modelDisclosedCount = 0;

  let attemptsWithKnownOperatorEditsCount = 0;
  let attemptsWithUnknownOperatorEditsCount = 0;
  let totalOperatorEdits = 0;
  let operatorEditsOverflow = false;
  let attemptsWithChecksCount = 0;
  let attemptsWithoutChecksCount = 0;
  let totalChecksPassed = 0;
  let totalChecksFailed = 0;
  let checksOverflow = false;

  const categoryAccs = Object.fromEntries(
    TOKEN_CATEGORIES.map((cat) => [cat, createIntegerAccumulator()])
  );
  const provenanceMap = new Map();

  let knownCostAttemptCount = 0;
  let unknownCostAttemptCount = 0;
  let incompleteCostAttemptCount = 0;
  const costEvidenceStateCounts = makeZeroMap(COST_EVIDENCE_STATES);
  const chargeInputSummary = {
    recordsTotal: 0,
    duplicatesTotal: 0,
    unattributedTotal: 0,
    overflow: false,
  };
  const costGroupsMap = new Map();

  const timebaseCounts = makeZeroMap(TIMEBASES);
  const startedAtStateCounts = makeZeroMap(STARTED_AT_STATES);
  const endedAtStateCounts = makeZeroMap(ENDED_AT_STATES);
  let attemptsWithCompleteIntervalCount = 0;
  let attemptsWithIncompleteIntervalCount = 0;
  let elapsedKnownCount = 0;
  let elapsedUnknownCount = 0;
  let elapsedOverflow = false;
  let elapsedSumMs = 0;

  const perRunWallClock = [];
  const allEpochIntervals = [];
  const allEpochRecordedTimestampValues = [];
  const epochRunStartOrder = [];
  let allEpochRunsHaveCompleteIntervals = true;
  let allEpochRunsHaveEstablishedStart = true;

  for (const env of resolvedEnvelopes) {
    const { run, evidence } = env;
    const tb = evidence.timebase;
    timebaseCounts[tb] += 1;

    taskKindCounts[evidence.task.kind] += 1;
    taskStatusCounts[evidence.task.status] += 1;

    if (run.accepted && evidence.acceptance.state === 'accepted') {
      acceptance.acceptedRunCount += 1;
    } else if (evidence.acceptance.state === 'unconfirmed') {
      acceptance.unconfirmedAcceptanceRunCount += 1;
    } else {
      acceptance.notAcceptedRunCount += 1;
    }

    if (evidence.acceptance.operatorEdited === true) {
      acceptance.operatorEditedRunCount += 1;
    } else if (evidence.acceptance.operatorEdited === false) {
      acceptance.operatorEditedFalseRunCount += 1;
    } else {
      acceptance.operatorEditedUnknownRunCount += 1;
    }

    if (evidence.acceptance.earlierAcceptedAttempts > 0) {
      acceptance.runsWithEarlierAcceptedAttemptsCount += 1;
    }
    if (!acceptance.earlierAcceptedAttemptsOverflow) {
      const addEarlier = safeAddIntegers(
        acceptance.earlierAcceptedAttemptsTotal,
        evidence.acceptance.earlierAcceptedAttempts
      );
      if (!addEarlier.ok || addEarlier.overflow) {
        acceptance.earlierAcceptedAttemptsOverflow = true;
        acceptance.earlierAcceptedAttemptsTotal = null;
      } else {
        acceptance.earlierAcceptedAttemptsTotal = addEarlier.value;
      }
    }

    const runHistoryComplete =
      run.attemptsComplete &&
      evidence.attemptList.complete &&
      evidence.chargeInput.unattributed === 0;
    if (runHistoryComplete) {
      attemptListCompleteness.completeRunCount += 1;
    } else {
      attemptListCompleteness.incompleteRunCount += 1;
    }
    for (const b of evidence.attemptList.basis) {
      if (Object.hasOwn(attemptListCompleteness.basisCounts, b)) {
        attemptListCompleteness.basisCounts[b] += 1;
      }
    }

    if (!chargeInputSummary.overflow) {
      const rAdd = safeAddIntegers(chargeInputSummary.recordsTotal, evidence.chargeInput.records);
      const dAdd = safeAddIntegers(
        chargeInputSummary.duplicatesTotal,
        evidence.chargeInput.duplicates
      );
      const uAdd = safeAddIntegers(
        chargeInputSummary.unattributedTotal,
        evidence.chargeInput.unattributed
      );
      if (!rAdd.ok || !dAdd.ok || !uAdd.ok) {
        chargeInputSummary.overflow = true;
        chargeInputSummary.recordsTotal = null;
        chargeInputSummary.duplicatesTotal = null;
        chargeInputSummary.unattributedTotal = null;
      } else {
        chargeInputSummary.recordsTotal = rAdd.value;
        chargeInputSummary.duplicatesTotal = dAdd.value;
        chargeInputSummary.unattributedTotal = uAdd.value;
      }
    }

    const attCount = run.attempts.length;
    if (attCount > 0) {
      retries.initialAttemptCount += 1;
    }
    if (attCount > 1) {
      retries.runsWithRetriesCount += 1;
      retries.retryAttemptCount += attCount - 1;
      retries.priorAttemptBeforeFinalCount += attCount - 1;
    }

    const runIntervals = [];
    let runAllIntervalsComplete = runHistoryComplete;
    let runCumulativeDurationMs = 0;
    let runCumulativeDurationOverflow = false;

    const firstAttemptStartMs =
      attCount > 0 &&
      run.attempts[0].startedAtMs !== null &&
      evidence.attempts[0].startedAt === 'recorded'
        ? run.attempts[0].startedAtMs
        : null;
    let runEarliestStartEstablished = runHistoryComplete && firstAttemptStartMs !== null;

    for (let i = 0; i < attCount; i += 1) {
      const att = run.attempts[i];
      const attEv = evidence.attempts[i];
      const isRetry = i >= 1;

      totalAttemptCount += 1;
      statusCounts[att.status] += 1;
      recordedStatusCounts[attEv.recordedStatus] += 1;

      if (isRetry) {
        retries.retryAttemptStatusCounts[att.status] += 1;
      }

      if (att.outcomeKnown) {
        knownOutcomeCount += 1;
      } else {
        unknownOutcomeCount += 1;
      }
      outcomeBasisCounts[attEv.outcomeBasis] += 1;
      recoveryStateCounts[attEv.recovery] += 1;
      recoveryEvidenceCounts[attEv.recoveryEvidence] += 1;
      executionPhaseCounts[attEv.executionPhase] += 1;

      providerCountsRaw.set(att.provider, (providerCountsRaw.get(att.provider) ?? 0) + 1);
      backendCounts[attEv.backend] += 1;

      if (attEv.modelWithheld || att.model === 'withheld') {
        modelWithheldCount += 1;
      } else {
        modelDisclosedCount += 1;
      }

      if (attEv.operatorEditCount === null) {
        attemptsWithUnknownOperatorEditsCount += 1;
      } else {
        attemptsWithKnownOperatorEditsCount += 1;
        if (!operatorEditsOverflow) {
          const edAdd = safeAddIntegers(totalOperatorEdits, attEv.operatorEditCount);
          if (!edAdd.ok || edAdd.overflow) {
            operatorEditsOverflow = true;
            totalOperatorEdits = null;
          } else {
            totalOperatorEdits = edAdd.value;
          }
        }
      }

      if (attEv.checks === null) {
        attemptsWithoutChecksCount += 1;
      } else {
        attemptsWithChecksCount += 1;
        if (!checksOverflow) {
          const pAdd = safeAddIntegers(totalChecksPassed, attEv.checks.passed);
          const fAdd = safeAddIntegers(totalChecksFailed, attEv.checks.failed);
          if (!pAdd.ok || !fAdd.ok) {
            checksOverflow = true;
            totalChecksPassed = null;
            totalChecksFailed = null;
          } else {
            totalChecksPassed = pAdd.value;
            totalChecksFailed = fAdd.value;
          }
        }
      }

      // Token usage
      const usage = attEv.usage;
      const provKey = `${usage.evidence}|${usage.semantics}`;
      if (!provenanceMap.has(provKey)) {
        provenanceMap.set(provKey, {
          evidence: usage.evidence,
          semantics: usage.semantics,
          attemptCount: 0,
          stepFlags: {
            attemptsWithSteps: 0,
            duplicatesTotal: 0,
            unidentifiedCount: 0,
            identityAmbiguousCount: 0,
            conflictCount: 0,
            truncatedCount: 0,
          },
          accs: Object.fromEntries(
            TOKEN_CATEGORIES.map((cat) => [cat, createIntegerAccumulator()])
          ),
        });
      }
      const provEntry = provenanceMap.get(provKey);
      provEntry.attemptCount += 1;
      if (usage.steps) {
        provEntry.stepFlags.attemptsWithSteps += 1;
        provEntry.stepFlags.duplicatesTotal += usage.steps.duplicates;
        if (usage.steps.unidentified) provEntry.stepFlags.unidentifiedCount += 1;
        if (usage.steps.identityAmbiguous) provEntry.stepFlags.identityAmbiguousCount += 1;
        if (usage.steps.conflict) provEntry.stepFlags.conflictCount += 1;
        if (usage.steps.truncated) provEntry.stepFlags.truncatedCount += 1;
      }

      for (const cat of TOKEN_CATEGORIES) {
        addValueToAccumulator(categoryAccs[cat], usage[cat]);
        addValueToAccumulator(provEntry.accs[cat], usage[cat]);
      }

      // Cost accounting
      costEvidenceStateCounts[attEv.cost] += 1;
      if (att.cost === null || attEv.cost !== 'caller-supplied') {
        unknownCostAttemptCount += 1;
      } else {
        knownCostAttemptCount += 1;
        if (!att.cost.complete) {
          incompleteCostAttemptCount += 1;
        }
        const costKey = `${att.cost.currency}:${att.cost.evidence}`;
        if (!costGroupsMap.has(costKey)) {
          costGroupsMap.set(costKey, {
            currency: att.cost.currency,
            evidence: att.cost.evidence,
            provenance: 'caller-supplied',
            authenticatedBilling: false,
            attemptCount: 0,
            completeAttemptCount: 0,
            incompleteAttemptCount: 0,
            initialAttemptCount: 0,
            retryAttemptCount: 0,
            acceptedAttemptCount: 0,
            nonAcceptedAttemptCount: 0,
            hasIncompleteHistory: false,
            overflow: false,
            sumMicros: 0,
            acceptedSumMicros: 0,
            nonAcceptedSumMicros: 0,
          });
        }
        const cg = costGroupsMap.get(costKey);
        cg.attemptCount += 1;
        if (!runHistoryComplete) {
          cg.hasIncompleteHistory = true;
        }
        if (att.cost.complete) {
          cg.completeAttemptCount += 1;
        } else {
          cg.incompleteAttemptCount += 1;
        }
        if (isRetry) {
          cg.retryAttemptCount += 1;
        } else {
          cg.initialAttemptCount += 1;
        }
        const isAcceptedAttempt = attEv.recordedStatus === 'accepted';
        if (isAcceptedAttempt) {
          cg.acceptedAttemptCount += 1;
        } else {
          cg.nonAcceptedAttemptCount += 1;
        }

        if (!cg.overflow) {
          const totalAdd = safeAddIntegers(cg.sumMicros, att.cost.amountMicros);
          const subAdd = isAcceptedAttempt
            ? safeAddIntegers(cg.acceptedSumMicros, att.cost.amountMicros)
            : safeAddIntegers(cg.nonAcceptedSumMicros, att.cost.amountMicros);
          if (!totalAdd.ok || totalAdd.overflow || !subAdd.ok || subAdd.overflow) {
            cg.overflow = true;
            cg.sumMicros = null;
            cg.acceptedSumMicros = null;
            cg.nonAcceptedSumMicros = null;
          } else {
            cg.sumMicros = totalAdd.value;
            if (isAcceptedAttempt) {
              cg.acceptedSumMicros = subAdd.value;
            } else {
              cg.nonAcceptedSumMicros = subAdd.value;
            }
          }
        }
      }

      // Timing per attempt
      startedAtStateCounts[attEv.startedAt] += 1;
      endedAtStateCounts[attEv.endedAt] += 1;

      if (
        att.startedAtMs === null ||
        attEv.startedAt !== 'recorded' ||
        (firstAttemptStartMs !== null && att.startedAtMs < firstAttemptStartMs)
      ) {
        runEarliestStartEstablished = false;
      }

      if (tb === 'epoch') {
        if (att.startedAtMs !== null && attEv.startedAt === 'recorded') {
          allEpochRecordedTimestampValues.push(att.startedAtMs);
        }
        if (att.endedAtMs !== null && attEv.endedAt === 'recorded') {
          allEpochRecordedTimestampValues.push(att.endedAtMs);
        }
      }

      if (
        att.startedAtMs !== null &&
        att.endedAtMs !== null &&
        attEv.startedAt === 'recorded' &&
        attEv.endedAt === 'recorded'
      ) {
        attemptsWithCompleteIntervalCount += 1;
        const interval = { startMs: att.startedAtMs, endMs: att.endedAtMs };
        runIntervals.push(interval);
        if (tb === 'epoch') {
          allEpochIntervals.push(interval);
        }
        if (!runCumulativeDurationOverflow) {
          const durAdd = safeAddIntegers(
            runCumulativeDurationMs,
            att.endedAtMs - att.startedAtMs
          );
          if (!durAdd.ok || durAdd.overflow) {
            runCumulativeDurationOverflow = true;
            runCumulativeDurationMs = null;
          } else {
            runCumulativeDurationMs = durAdd.value;
          }
        }
      } else {
        attemptsWithIncompleteIntervalCount += 1;
        runAllIntervalsComplete = false;
        if (tb === 'epoch') {
          allEpochRunsHaveCompleteIntervals = false;
        }
      }

      if (attEv.recordedElapsedMs === null) {
        elapsedUnknownCount += 1;
      } else {
        elapsedKnownCount += 1;
        if (!elapsedOverflow) {
          const nextElapsed = elapsedSumMs + attEv.recordedElapsedMs;
          if (!Number.isFinite(nextElapsed) || nextElapsed > Number.MAX_SAFE_INTEGER) {
            elapsedOverflow = true;
            elapsedSumMs = null;
          } else {
            elapsedSumMs = nextElapsed;
          }
        }
      }
    }

    if (tb === 'epoch') {
      if (!runEarliestStartEstablished) {
        allEpochRunsHaveEstablishedStart = false;
      } else {
        epochRunStartOrder.push({ runId: run.runId, startMs: firstAttemptStartMs });
      }
      if (!runAllIntervalsComplete) {
        allEpochRunsHaveCompleteIntervals = false;
      }
    }

    const mergedRun = computeMergedIntervals(runIntervals);
    if (runAllIntervalsComplete && runIntervals.length === attCount && !mergedRun.overflow) {
      perRunWallClock.push({
        runId: run.runId,
        timebase: tb,
        attemptsComplete: runHistoryComplete,
        intervalCompleteness: 'complete',
        hasOverlappingAttempts: mergedRun.hasOverlappingAttempts,
        mergedActiveWallClockMs: mergedRun.mergedActiveWallClockMs,
        spanWallClockMs: mergedRun.spanWallClockMs,
        cumulativeAttemptDurationMs: runCumulativeDurationOverflow
          ? null
          : runCumulativeDurationMs,
        wallClockStatus: 'available',
        unavailableReason: null,
      });
    } else {
      perRunWallClock.push({
        runId: run.runId,
        timebase: tb,
        attemptsComplete: runHistoryComplete,
        intervalCompleteness: runIntervals.length > 0 ? 'partial' : 'unavailable',
        hasOverlappingAttempts: mergedRun.hasOverlappingAttempts,
        mergedActiveWallClockMs: null,
        spanWallClockMs: null,
        cumulativeAttemptDurationMs: null,
        wallClockStatus: 'unavailable',
        unavailableReason: !runHistoryComplete
          ? 'incomplete-attempt-list'
          : 'incomplete-attempt-timestamps',
      });
    }
  }

  // Dataset-wide history completeness
  const historyComplete =
    attemptListCompleteness.incompleteRunCount === 0 &&
    envelopeCounts.unavailable === 0 &&
    envelopeCounts.malformed === 0 &&
    unresolvedRuns.length === 0 &&
    !hasContradictoryEvidence;

  const baseHistoryIncompletenessReasons = [];
  if (attemptListCompleteness.incompleteRunCount > 0) {
    baseHistoryIncompletenessReasons.push('incomplete-attempt-list');
  }
  if (!chargeInputSummary.overflow && chargeInputSummary.unattributedTotal > 0) {
    baseHistoryIncompletenessReasons.push('unattributed-charges');
  }
  if (envelopeCounts.unavailable > 0) {
    baseHistoryIncompletenessReasons.push('unavailable-envelopes-present');
  }
  if (unresolvedRuns.length > 0) {
    baseHistoryIncompletenessReasons.push('unresolved-runs-present');
  }
  if (envelopeCounts.malformed > 0) {
    baseHistoryIncompletenessReasons.push('malformed-envelopes-present');
  }
  if (hasContradictoryEvidence) {
    baseHistoryIncompletenessReasons.push('contradictory-evidence-present');
  }

  // Finalize token summaries
  const byCategory = Object.fromEntries(
    TOKEN_CATEGORIES.map((cat) => [
      cat,
      finalizeTokenAccumulator(categoryAccs[cat], totalAttemptCount, historyComplete),
    ])
  );

  let tokensObservationCompleteness = 'no-data';
  if (totalAttemptCount > 0) {
    const obsStates = TOKEN_CATEGORIES.map((c) => byCategory[c].observationCompleteness);
    if (obsStates.includes('overflow')) {
      tokensObservationCompleteness = 'overflow';
    } else if (obsStates.every((s) => s === 'complete')) {
      tokensObservationCompleteness = 'complete';
    } else if (obsStates.every((s) => s === 'unknown')) {
      tokensObservationCompleteness = 'unknown';
    } else {
      tokensObservationCompleteness = 'partial';
    }
  }
  const tokensOverallCompleteness =
    tokensObservationCompleteness === 'complete' && !historyComplete
      ? 'partial'
      : tokensObservationCompleteness;

  const tokenIncompletenessReasons = new Set(baseHistoryIncompletenessReasons);
  if (TOKEN_CATEGORIES.some((c) => byCategory[c].unknownAttemptCount > 0)) {
    tokenIncompletenessReasons.add('missing-attempt-observations');
  }

  const byProvenance = Array.from(provenanceMap.keys())
    .sort()
    .map((key) => {
      const item = provenanceMap.get(key);
      return {
        evidence: item.evidence,
        semantics: item.semantics,
        attemptCount: item.attemptCount,
        stepFlags: item.stepFlags,
        byCategory: Object.fromEntries(
          TOKEN_CATEGORIES.map((cat) => [
            cat,
            finalizeTokenAccumulator(item.accs[cat], item.attemptCount, historyComplete),
          ])
        ),
      };
    });

  // Finalize cost summaries
  const currencies = Array.from(
    new Set(Array.from(costGroupsMap.values()).map((g) => g.currency))
  ).sort();
  const hasMixedCurrencies = currencies.length > 1;
  let hasCostOverflow = false;

  const costGroups = Array.from(costGroupsMap.keys())
    .sort()
    .map((key) => {
      const g = costGroupsMap.get(key);
      if (g.overflow) {
        hasCostOverflow = true;
      }
      const groupCompleteness = g.overflow
        ? 'overflow'
        : g.incompleteAttemptCount > 0 || g.hasIncompleteHistory
        ? 'partial'
        : 'complete';
      const overallCompleteness = g.overflow
        ? 'overflow'
        : g.incompleteAttemptCount > 0 || unknownCostAttemptCount > 0 || !historyComplete
        ? 'partial'
        : 'complete';
      const completeTotalMicros =
        overallCompleteness === 'complete' ? g.sumMicros : null;

      return {
        currency: g.currency,
        evidence: g.evidence,
        provenance: g.provenance,
        authenticatedBilling: false,
        attemptCount: g.attemptCount,
        completeAttemptCount: g.completeAttemptCount,
        incompleteAttemptCount: g.incompleteAttemptCount,
        initialAttemptCount: g.initialAttemptCount,
        retryAttemptCount: g.retryAttemptCount,
        acceptedAttemptCount: g.acceptedAttemptCount,
        nonAcceptedAttemptCount: g.nonAcceptedAttemptCount,
        hasIncompleteHistory: g.hasIncompleteHistory,
        overflow: g.overflow,
        knownSumMicros: g.overflow ? null : g.sumMicros,
        acceptedAttemptsKnownSumMicros: g.overflow ? null : g.acceptedSumMicros,
        nonAcceptedAndRetryKnownSumMicros: g.overflow ? null : g.nonAcceptedSumMicros,
        completeTotalMicros,
        groupCompleteness,
        overallCompleteness,
      };
    });

  const byCurrencyAndEvidence = Object.fromEntries(
    costGroups.map((g) => [`${g.currency}:${g.evidence}`, g])
  );

  let costsObservationCompleteness = 'no-data';
  if (totalAttemptCount > 0) {
    if (hasCostOverflow) {
      costsObservationCompleteness = 'overflow';
    } else if (knownCostAttemptCount === 0) {
      costsObservationCompleteness = 'unknown';
    } else if (unknownCostAttemptCount > 0 || incompleteCostAttemptCount > 0) {
      costsObservationCompleteness = 'partial';
    } else {
      costsObservationCompleteness = 'complete';
    }
  }
  const costsCompleteness =
    costsObservationCompleteness === 'complete' && !historyComplete
      ? 'partial'
      : costsObservationCompleteness;

  const costIncompletenessReasons = new Set(baseHistoryIncompletenessReasons);
  if (unknownCostAttemptCount > 0) {
    costIncompletenessReasons.add('missing-attempt-observations');
  }
  if (incompleteCostAttemptCount > 0) {
    costIncompletenessReasons.add('incomplete-charge-record');
  }

  // Finalize timing & calendar summaries
  const resolvedRunCount = resolvedRuns.length;
  const hasRelativeRuns = timebaseCounts['run-relative'] > 0;
  const hasOutOfRangeEpochDate = allEpochRecordedTimestampValues.some(
    (ms) => !isDateSafeEpochMs(ms)
  );

  let calendarTime;
  if (resolvedRunCount === 0) {
    calendarTime = {
      available: false,
      completeness: 'unavailable',
      unavailableReason: 'no-resolved-runs',
      earliestStartedAtMs: null,
      latestEndedAtMs: null,
      earliestStartedAtIso: null,
      latestEndedAtIso: null,
    };
  } else if (hasRelativeRuns) {
    calendarTime = {
      available: false,
      completeness: 'unavailable',
      unavailableReason: 'run-relative-timebase-cannot-establish-calendar-dates',
      earliestStartedAtMs: null,
      latestEndedAtMs: null,
      earliestStartedAtIso: null,
      latestEndedAtIso: null,
    };
  } else if (hasOutOfRangeEpochDate) {
    calendarTime = {
      available: false,
      completeness: 'unavailable',
      unavailableReason: 'epoch-timestamp-out-of-date-range',
      earliestStartedAtMs: null,
      latestEndedAtMs: null,
      earliestStartedAtIso: null,
      latestEndedAtIso: null,
    };
  } else if (allEpochIntervals.length === 0) {
    calendarTime = {
      available: false,
      completeness: 'unavailable',
      unavailableReason: 'no-recorded-epoch-intervals',
      earliestStartedAtMs: null,
      latestEndedAtMs: null,
      earliestStartedAtIso: null,
      latestEndedAtIso: null,
    };
  } else {
    const mergedEpoch = computeMergedIntervals(allEpochIntervals);
    calendarTime = {
      available: true,
      completeness:
        allEpochRunsHaveCompleteIntervals && historyComplete ? 'complete' : 'partial',
      unavailableReason: null,
      earliestStartedAtMs: mergedEpoch.earliestStartMs,
      latestEndedAtMs: mergedEpoch.latestEndMs,
      earliestStartedAtIso: new Date(mergedEpoch.earliestStartMs).toISOString(),
      latestEndedAtIso: new Date(mergedEpoch.latestEndMs).toISOString(),
    };
  }

  let crossRunOrdering;
  if (resolvedRunCount === 0) {
    crossRunOrdering = {
      available: false,
      unavailableReason: 'no-resolved-runs',
      orderedRunIds: null,
    };
  } else if (hasRelativeRuns) {
    crossRunOrdering = {
      available: false,
      unavailableReason: 'run-relative-timebase-cannot-establish-cross-run-order',
      orderedRunIds: null,
    };
  } else if (!allEpochRunsHaveEstablishedStart) {
    crossRunOrdering = {
      available: false,
      unavailableReason: 'run-earliest-start-unestablished',
      orderedRunIds: null,
    };
  } else {
    const sortedOrder = [...epochRunStartOrder]
      .sort((a, b) =>
        a.startMs !== b.startMs ? a.startMs - b.startMs : a.runId.localeCompare(b.runId)
      )
      .map((item) => item.runId);
    crossRunOrdering = {
      available: true,
      unavailableReason: null,
      orderedRunIds: sortedOrder,
    };
  }

  let crossRunWallClock;
  if (resolvedRunCount === 0) {
    crossRunWallClock = {
      available: false,
      unavailableReason: 'no-resolved-runs',
      mergedActiveWallClockMs: null,
      spanWallClockMs: null,
      hasOverlappingAttempts: false,
    };
  } else if (hasRelativeRuns) {
    crossRunWallClock = {
      available: false,
      unavailableReason: 'run-relative-timebase-cannot-merge-cross-run-wall-clock',
      mergedActiveWallClockMs: null,
      spanWallClockMs: null,
      hasOverlappingAttempts: false,
    };
  } else if (!allEpochRunsHaveCompleteIntervals || allEpochIntervals.length === 0) {
    crossRunWallClock = {
      available: false,
      unavailableReason: 'incomplete-epoch-attempt-intervals',
      mergedActiveWallClockMs: null,
      spanWallClockMs: null,
      hasOverlappingAttempts: false,
    };
  } else {
    const mergedEpoch = computeMergedIntervals(allEpochIntervals);
    if (mergedEpoch.overflow) {
      crossRunWallClock = {
        available: false,
        unavailableReason: 'wall-clock-duration-overflow',
        mergedActiveWallClockMs: null,
        spanWallClockMs: null,
        hasOverlappingAttempts: mergedEpoch.hasOverlappingAttempts,
      };
    } else {
      crossRunWallClock = {
        available: true,
        unavailableReason: null,
        mergedActiveWallClockMs: mergedEpoch.mergedActiveWallClockMs,
        spanWallClockMs: mergedEpoch.spanWallClockMs,
        hasOverlappingAttempts: mergedEpoch.hasOverlappingAttempts,
      };
    }
  }

  const providerCounts = Object.fromEntries(
    Array.from(providerCountsRaw.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  );

  const hasMalformedOrConflicts =
    envelopeCounts.malformed > 0 ||
    unresolvedRuns.length > 0 ||
    hasContradictoryEvidence;
  const hasPartialEvidence =
    !historyComplete ||
    unknownOutcomeCount > 0 ||
    costsCompleteness !== 'complete' ||
    tokensOverallCompleteness !== 'complete' ||
    attemptsWithIncompleteIntervalCount > 0;

  let status = 'complete';
  if (hasMalformedOrConflicts) {
    status = 'unresolved-conflicts';
  } else if (hasPartialEvidence) {
    status = 'partial';
  }

  const summary = {
    format: ANALYTICS_FORMAT,
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    sourceContract: {
      exportFormat: RECEIPT_EXPORT_FORMAT,
      exportFormatVersion: RECEIPT_EXPORT_VERSION,
      runSchemaVersion: RECEIPT_SCHEMA_VERSION,
    },
    ok: true,
    clean: !hasMalformedOrConflicts && envelopeCounts.unavailable === 0,
    failClosed: hasMalformedOrConflicts,
    status,
    envelopeCounts,
    unavailableReasonCounts,
    unavailableEnvelopes,
    malformedEnvelopes,
    reconciliation: {
      distinctRunIdsSeen: sortedRunIds.length,
      resolvedRunCount: resolvedRuns.length,
      unresolvedRunCount: unresolvedRuns.length,
      exactDuplicatesCollapsed,
      supersededExportsCount,
      preservedEvidenceRunCount,
      resolvedRuns,
      unresolvedRuns,
    },
    runs: {
      resolvedRunCount: resolvedRuns.length,
      unresolvedRunCount: unresolvedRuns.length,
      taskKindCounts,
      taskStatusCounts,
      acceptance,
      attemptListCompleteness,
      retries,
    },
    attempts: {
      totalAttemptCount,
      statusCounts,
      recordedStatusCounts,
      outcomes: {
        knownOutcomeCount,
        unknownOutcomeCount,
        outcomeBasisCounts,
        recoveryStateCounts,
        recoveryEvidenceCounts,
        executionPhaseCounts,
      },
      providersAndModels: {
        providerCounts,
        backendCounts,
        modelWithheldCount,
        modelDisclosedCount,
        inferredModelsCount: 0,
        inferencePolicy: 'never-infer-withheld-identities',
      },
      operatorEditsAndChecks: {
        attemptsWithKnownOperatorEditsCount,
        attemptsWithUnknownOperatorEditsCount,
        totalOperatorEdits,
        operatorEditsOverflow,
        attemptsWithChecksCount,
        attemptsWithoutChecksCount,
        totalChecksPassed,
        totalChecksFailed,
        checksOverflow,
      },
    },
    tokens: {
      categoryOverlapPolicy: 'categories-not-summed-or-subtracted',
      totalAttemptCount,
      historyComplete,
      incompletenessReasons: Array.from(tokenIncompletenessReasons).sort(),
      observationCompleteness: tokensObservationCompleteness,
      overallCompleteness: tokensOverallCompleteness,
      byCategory,
      byProvenance,
    },
    costs: {
      accountingPolicy: 'exact-integer-micros-no-currency-conversion-no-evidence-mixing',
      billingAuthenticationStatus: 'unverified-caller-supplied-claims-only',
      routerSavingsClaim: 'not-supported',
      totalAttemptCount,
      knownCostAttemptCount,
      unknownCostAttemptCount,
      incompleteCostAttemptCount,
      historyComplete,
      incompletenessReasons: Array.from(costIncompletenessReasons).sort(),
      observationCompleteness: costsObservationCompleteness,
      completeness: costsCompleteness,
      costEvidenceStateCounts,
      chargeInputSummary,
      currencies,
      hasMixedCurrencies,
      hasUnknownCosts: unknownCostAttemptCount > 0,
      hasOverflow: hasCostOverflow,
      groups: costGroups,
      byCurrencyAndEvidence,
    },
    timing: {
      timebaseCounts,
      calendarTime,
      crossRunOrdering,
      crossRunWallClock,
      attemptTimestamps: {
        startedAtStateCounts,
        endedAtStateCounts,
        attemptsWithCompleteIntervalCount,
        attemptsWithIncompleteIntervalCount,
      },
      recordedElapsedMs: {
        isWallClockTime: false,
        knownAttemptCount: elapsedKnownCount,
        unknownAttemptCount: elapsedUnknownCount,
        overflow: elapsedOverflow,
        cumulativeKnownElapsedMs:
          elapsedOverflow || elapsedKnownCount === 0 ? null : elapsedSumMs,
      },
      perRunWallClock,
    },
    issues,
    limits: [...ANALYTICS_LIMIT_NOTES],
  };

  const selfCheck = validateAnalyticsSummary(summary);
  if (!selfCheck.ok) {
    return buildEmptySummary({
      ok: false,
      status: 'invalid-input',
      issues: selfCheck.issues,
    });
  }

  return summary;
}
