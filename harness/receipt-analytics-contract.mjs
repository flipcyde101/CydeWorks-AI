// Contract and runtime validators for the CydeWorks AI receipt analytics candidate.
// Pure data validation: no I/O, clock, randomness, or mutation.
// Structural validation verifies internal consistency only and never proves authenticity.

import {
  ATTEMPT_STATUSES,
  COST_EVIDENCE,
  LIMITS,
  RECEIPT_EXPORT_FORMAT,
  RECEIPT_EXPORT_VERSION,
  RECEIPT_SCHEMA_VERSION,
  TIMEBASES,
  UNAVAILABLE_REASONS,
} from './receipt-contract.mjs';

export const ANALYTICS_FORMAT = 'cydeworks.receipt-analytics-summary';
export const ANALYTICS_SCHEMA_VERSION = 1;

// Maximum millisecond magnitude supported by JavaScript Date.prototype.toISOString()
export const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;

export const ANALYTICS_STATUSES = Object.freeze([
  'complete',
  'partial',
  'unresolved-conflicts',
  'empty',
  'invalid-input',
]);

export const ANALYTICS_LIMITS = Object.freeze({
  envelopes: 1000,
  issues: 200,
  runs: 1000,
  attemptsPerRun: LIMITS.attempts,
  string: 200,
});

export const RECONCILIATION_CONFLICT_CODES = Object.freeze([
  'unknown-record-version',
  'equal-version-conflict',
  'identity-mismatch',
  'timebase-mismatch',
  'attempt-history-regression',
  'conflicting-attempt-evidence',
]);

export const CONTRADICTORY_EVIDENCE_CODES = Object.freeze([
  'contradictory-acceptance-evidence',
  'contradictory-attempt-list-evidence',
  'contradictory-cost-evidence',
  'contradictory-timestamp-evidence',
  'contradictory-status-evidence',
  'contradictory-outcome-evidence',
  'contradictory-model-evidence',
  'contradictory-usage-evidence',
]);

export const COMPLETENESS_STATES = Object.freeze([
  'no-data',
  'unknown',
  'partial',
  'complete',
  'overflow',
]);

export const INCOMPLETENESS_REASON_CODES = Object.freeze([
  'missing-attempt-observations',
  'incomplete-charge-record',
  'incomplete-attempt-list',
  'unattributed-charges',
  'unavailable-envelopes-present',
  'unresolved-runs-present',
  'malformed-envelopes-present',
  'contradictory-evidence-present',
]);

export const TOKEN_CATEGORIES = Object.freeze([
  'input',
  'output',
  'cached',
  'cacheWrite',
  'reasoning',
]);

export const TASK_STATUSES = Object.freeze([
  'draft',
  'running',
  'review',
  'accepted',
  'rejected',
  'failed',
  'cancelled',
  'interrupted',
  'unrecognized',
]);

export const RECORDED_ATTEMPT_STATUSES = Object.freeze([
  'running',
  'review',
  'accepted',
  'rejected',
  'failed',
  'cancelled',
  'interrupted',
]);

export const OUTCOME_BASES = Object.freeze([
  'running',
  'recovery-unresolved',
  'recovery-unrecognized',
  'in-process-fixture',
  'provider-settled',
  'never-dispatched',
  'recovery-retry-safe',
  'no-completion-evidence',
]);

export const KNOWN_OUTCOME_BASES = Object.freeze([
  'in-process-fixture',
  'provider-settled',
  'never-dispatched',
  'recovery-retry-safe',
]);

export const RECOVERY_STATES = Object.freeze(['none', 'retry-safe', 'unresolved', 'unrecognized']);

export const RECOVERY_EVIDENCE_VALUES = Object.freeze([
  'none',
  'dispatch-not-started',
  'in-process-fixture-stopped',
  'no-terminal-evidence',
  'unrecognized',
]);

export const EXECUTION_PHASES = Object.freeze([
  'claimed',
  'dispatching',
  'settled',
  'unrecognized',
  'unrecorded',
]);

export const BACKENDS = Object.freeze(['fixture', 'ollama', 'llamacpp', 'other', 'unrecorded']);

export const STARTED_AT_STATES = Object.freeze([
  'recorded',
  'missing',
  'invalid',
  'withheld-inconsistent',
]);

export const ENDED_AT_STATES = Object.freeze([
  'recorded',
  'missing',
  'invalid',
  'withheld-inconsistent',
  'not-ended',
  'withheld-interruption-record',
]);

export const COST_EVIDENCE_STATES = Object.freeze([
  'not-recorded',
  'caller-supplied',
  'charge-record-invalid',
  'charge-records-conflict',
]);

export const ATTEMPT_LIST_BASES = Object.freeze([
  'event-log-accounts-for-every-attempt',
  'event-log-missing-or-gapped',
  'start-events-do-not-match-attempts',
  'charge-for-unrecorded-attempt',
]);

export const EXPECTED_RUN_STATUS_BY_RECORDED = Object.freeze({
  running: 'running',
  review: 'succeeded',
  accepted: 'succeeded',
  rejected: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
});

export const ANALYTICS_LIMIT_NOTES = Object.freeze([
  'Analytics summarize CydeWorks receipt exports (formatVersion 2, run schemaVersion 1) without authenticating billing or execution.',
  'Missing or unrecorded costs and token counts remain unknown (null) and are never coerced to zero.',
  'Recorded attempt-list gaps, unattributed charges, unavailable exports, and unresolved run conflicts suppress complete totals while preserving known subtotals.',
  'Money is grouped strictly by currency and evidence category (provider-billed vs estimated). No currency conversion is performed.',
  'Provider-billed costs in receipt exports are caller-supplied claims, not authenticated provider invoices.',
  'Token categories may overlap across providers or engines and are never added together or subtracted.',
  'Run-relative timestamps cannot establish calendar dates or cross-run ordering. Overlapping attempt durations are merged rather than summed as wall-clock time.',
  'Withheld model identities remain withheld and are never inferred. No router cost or time savings are claimed.',
  'Structural summary validation verifies internal consistency only and does not prove that an export or run is authentic.',
]);

const CONTROL = /[\u0000-\u001f\u007f]/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function getOwnDataProperty(holder, key) {
  if (holder === null || typeof holder !== 'object') {
    return { present: false, valid: false, value: undefined };
  }
  const desc = Object.getOwnPropertyDescriptor(holder, key);
  if (!desc) {
    return { present: false, valid: true, value: undefined };
  }
  if (!('value' in desc) || desc.get !== undefined || desc.set !== undefined) {
    return { present: true, valid: false, value: undefined };
  }
  return { present: true, valid: true, value: desc.value };
}

export function hasOnlyPlainOwnProperties(obj, allowedKeys = null) {
  if (!isPlainObject(obj)) {
    return false;
  }
  const keys = Reflect.ownKeys(obj);
  for (const key of keys) {
    if (typeof key !== 'string') {
      return false;
    }
    if (allowedKeys && !allowedKeys.has(key)) {
      return false;
    }
    const prop = getOwnDataProperty(obj, key);
    if (!prop.present || !prop.valid || prop.value === undefined) {
      return false;
    }
  }
  return allowedKeys ? keys.length === allowedKeys.size : true;
}

/**
 * Checks that `value` is a plain Array instance without extra non-index properties
 * and within `maxLen`. Individual elements may be inspected per slot so a bad
 * element in a batch does not discard valid sibling envelopes.
 */
export function isPlainArrayContainer(value, maxLen = ANALYTICS_LIMITS.envelopes) {
  if (!Array.isArray(value)) {
    return false;
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    return false;
  }
  if (value.length > maxLen) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key)) {
      return false;
    }
    const idx = Number(key);
    if (!Number.isSafeInteger(idx) || idx < 0 || idx >= value.length) {
      return false;
    }
  }
  return true;
}

export function isDensePlainArray(value, maxLen = ANALYTICS_LIMITS.envelopes) {
  if (!isPlainArrayContainer(value, maxLen)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    const prop = getOwnDataProperty(value, i);
    if (!prop.present || !prop.valid || prop.value === undefined) {
      return false;
    }
  }
  return true;
}

export function isSafeNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isDateSafeEpochMs(value) {
  return isSafeNonNegativeInteger(value) && value <= MAX_DATE_EPOCH_MS;
}

export function isBoundedCleanString(value, max = ANALYTICS_LIMITS.string) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value.trim().length > 0 &&
    !CONTROL.test(value)
  );
}

export function safeAddIntegers(a, b) {
  if (!isSafeNonNegativeInteger(a) || !isSafeNonNegativeInteger(b)) {
    return { ok: false, overflow: false, value: null };
  }
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) {
    return { ok: false, overflow: true, value: null };
  }
  return { ok: true, overflow: false, value: sum };
}

/**
 * Cross-field consistency check at the analytics boundary for an envelope
 * that already passed validateReceiptExport.
 */
export function validateEnvelopeConsistency(envelope) {
  if (!envelope || envelope.available !== true) {
    return { ok: true, issues: [] };
  }
  const issues = [];
  const push = (path, code, detailCode, message) => {
    if (issues.length < ANALYTICS_LIMITS.issues) {
      issues.push({ path, code, detailCode, message });
    }
  };

  const { run, evidence } = envelope;

  if (run.accepted !== (evidence.acceptance.state === 'accepted')) {
    push(
      '$.evidence.acceptance.state',
      'contradictory-acceptance-evidence',
      evidence.acceptance.state,
      'run.accepted disagrees with evidence.acceptance.state.'
    );
  }

  if (run.attemptsComplete !== evidence.attemptList.complete) {
    push(
      '$.evidence.attemptList.complete',
      'contradictory-attempt-list-evidence',
      'attempt-list-complete-mismatch',
      'run.attemptsComplete disagrees with evidence.attemptList.complete.'
    );
  }

  const hasCompleteBasisOnly =
    evidence.attemptList.basis.length === 1 &&
    evidence.attemptList.basis[0] === 'event-log-accounts-for-every-attempt';
  if (
    (run.attemptsComplete || evidence.attemptList.complete) &&
    (!hasCompleteBasisOnly || evidence.chargeInput.unattributed > 0)
  ) {
    push(
      '$.evidence.attemptList.basis',
      'contradictory-attempt-list-evidence',
      'incomplete-basis-on-complete-run',
      'Complete attempt list cannot carry incomplete basis codes or unattributed charges.'
    );
  }

  for (let i = 0; i < run.attempts.length; i += 1) {
    const att = run.attempts[i];
    const ev = evidence.attempts[i];
    const p = `$.run.attempts[${i}]`;
    const ep = `$.evidence.attempts[${i}]`;

    if (att.cost !== null && ev.cost !== 'caller-supplied') {
      push(
        `${p}.cost`,
        'contradictory-cost-evidence',
        ev.cost,
        'Attempt carries a non-null cost while companion evidence is not caller-supplied.'
      );
    } else if (att.cost === null && ev.cost === 'caller-supplied') {
      push(
        `${ep}.cost`,
        'contradictory-cost-evidence',
        'caller-supplied-without-cost',
        'Companion evidence claims caller-supplied cost while attempt.cost is null.'
      );
    }

    if ((att.startedAtMs !== null) !== (ev.startedAt === 'recorded')) {
      push(
        `${p}.startedAtMs`,
        'contradictory-timestamp-evidence',
        ev.startedAt,
        'Attempt startedAtMs disagrees with companion evidence startedAt state.'
      );
    }
    if ((att.endedAtMs !== null) !== (ev.endedAt === 'recorded')) {
      push(
        `${p}.endedAtMs`,
        'contradictory-timestamp-evidence',
        ev.endedAt,
        'Attempt endedAtMs disagrees with companion evidence endedAt state.'
      );
    }
    if (ev.recordedStatus === 'running' && (att.endedAtMs !== null || ev.endedAt !== 'not-ended')) {
      push(
        `${p}.endedAtMs`,
        'contradictory-timestamp-evidence',
        'running-with-end',
        'Running attempt cannot have a recorded end timestamp.'
      );
    }
    if (
      ev.recordedStatus === 'interrupted' &&
      (att.endedAtMs !== null || !['missing', 'withheld-interruption-record'].includes(ev.endedAt))
    ) {
      push(
        `${p}.endedAtMs`,
        'contradictory-timestamp-evidence',
        'interrupted-with-end',
        'Interrupted attempt cannot carry a verified end timestamp.'
      );
    }

    if (att.status !== EXPECTED_RUN_STATUS_BY_RECORDED[ev.recordedStatus]) {
      push(
        `${p}.status`,
        'contradictory-status-evidence',
        ev.recordedStatus,
        'Attempt status disagrees with companion evidence recordedStatus.'
      );
    }
    if (att.outcomeKnown !== KNOWN_OUTCOME_BASES.includes(ev.outcomeBasis)) {
      push(
        `${p}.outcomeKnown`,
        'contradictory-outcome-evidence',
        ev.outcomeBasis,
        'Attempt outcomeKnown disagrees with companion evidence outcomeBasis.'
      );
    }

    if (ev.modelWithheld && att.model !== 'withheld') {
      push(
        `${p}.model`,
        'contradictory-model-evidence',
        'model-withheld-mismatch',
        'Attempt model is disclosed while companion evidence states modelWithheld is true.'
      );
    }

    const usage = ev.usage;
    const expectedSemantics =
      usage.evidence === 'OpenCode reported'
        ? 'opencode-engine-defined'
        : usage.evidence === 'provider reported'
        ? 'provider-defined'
        : 'unavailable';
    if (usage.semantics !== expectedSemantics) {
      push(
        `${ep}.usage.semantics`,
        'contradictory-usage-evidence',
        usage.semantics,
        'Usage semantics do not match usage evidence source.'
      );
    }
    if (usage.evidence === 'unavailable') {
      for (const cat of TOKEN_CATEGORIES) {
        if (usage[cat] !== null) {
          push(
            `${ep}.usage.${cat}`,
            'contradictory-usage-evidence',
            'unavailable-with-tokens',
            'Unavailable usage evidence cannot carry non-null token counts.'
          );
        }
      }
    }
    if (usage.steps) {
      if (usage.evidence !== 'OpenCode reported') {
        push(
          `${ep}.usage.steps`,
          'contradictory-usage-evidence',
          'steps-without-opencode',
          'Step usage records are only valid with OpenCode reported evidence.'
        );
      }
      const unsafeSteps =
        usage.steps.identityAmbiguous ||
        usage.steps.conflict ||
        usage.steps.truncated ||
        (usage.steps.unidentified && usage.steps.items.length > 1);
      for (const cat of TOKEN_CATEGORIES) {
        if (unsafeSteps && usage[cat] !== null) {
          push(
            `${ep}.usage.${cat}`,
            'contradictory-usage-evidence',
            'unsafe-steps-with-tokens',
            'Unsafe OpenCode step flags require null token totals.'
          );
        }
      }
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, issues: [] };
}

export function validateAnalyticsOptions(options) {
  if (options === undefined) {
    return {
      ok: true,
      options: { maxEnvelopes: ANALYTICS_LIMITS.envelopes },
      issues: [],
    };
  }
  if (!isPlainObject(options)) {
    return {
      ok: false,
      options: { maxEnvelopes: ANALYTICS_LIMITS.envelopes },
      issues: [
        {
          path: '$.options',
          code: 'invalid-options',
          message: 'Options must be a plain object when provided.',
        },
      ],
    };
  }

  const issues = [];
  const allowedKeys = new Set(['maxEnvelopes']);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      issues.push({
        path: '$.options',
        code: 'unknown-option',
        message: 'An unsupported option property is present.',
      });
    } else {
      const prop = getOwnDataProperty(options, key);
      if (!prop.valid) {
        issues.push({
          path: `$.options.${key}`,
          code: 'invalid-property',
          message: 'Option properties must be plain data values.',
        });
      }
    }
  }

  let maxEnvelopes = ANALYTICS_LIMITS.envelopes;
  const maxProp = getOwnDataProperty(options, 'maxEnvelopes');
  if (maxProp.present && maxProp.valid && maxProp.value !== undefined) {
    if (
      !Number.isSafeInteger(maxProp.value) ||
      maxProp.value < 1 ||
      maxProp.value > ANALYTICS_LIMITS.envelopes
    ) {
      issues.push({
        path: '$.options.maxEnvelopes',
        code: 'invalid-max-envelopes',
        message: `maxEnvelopes must be a safe integer between 1 and ${ANALYTICS_LIMITS.envelopes}.`,
      });
    } else {
      maxEnvelopes = maxProp.value;
    }
  }

  return {
    ok: issues.length === 0,
    options: { maxEnvelopes },
    issues: issues.slice(0, ANALYTICS_LIMITS.issues),
  };
}

function validateCountMap(obj, expectedKeys, path, addIssue) {
  const keySet = new Set(expectedKeys);
  if (!hasOnlyPlainOwnProperties(obj, keySet)) {
    addIssue(path, 'invalid-count-map', 'Count map must contain exact documented keys.');
    return null;
  }
  let sum = 0;
  for (const k of expectedKeys) {
    if (!isSafeNonNegativeInteger(obj[k])) {
      addIssue(`${path}.${k}`, 'invalid-integer', 'Count must be a nonnegative safe integer.');
      return null;
    }
    const next = safeAddIntegers(sum, obj[k]);
    if (!next.ok) {
      addIssue(path, 'count-map-overflow', 'Count map sum overflowed safe integer.');
      return null;
    }
    sum = next.value;
  }
  return sum;
}

function validateTokenCategoryEntry(
  entry,
  totalAttemptCount,
  historyComplete,
  path,
  addIssue
) {
  const allowed = new Set([
    'knownAttemptCount',
    'unknownAttemptCount',
    'overflow',
    'knownSum',
    'completeTotal',
    'observationCompleteness',
    'completeness',
  ]);
  if (!hasOnlyPlainOwnProperties(entry, allowed)) {
    addIssue(path, 'invalid-object', 'Token category entry has invalid or extra properties.');
    return false;
  }
  if (
    !isSafeNonNegativeInteger(entry.knownAttemptCount) ||
    !isSafeNonNegativeInteger(entry.unknownAttemptCount) ||
    entry.knownAttemptCount + entry.unknownAttemptCount !== totalAttemptCount
  ) {
    addIssue(
      `${path}.knownAttemptCount`,
      'token-attempt-count-mismatch',
      'knownAttemptCount + unknownAttemptCount must equal totalAttemptCount.'
    );
    return false;
  }
  if (typeof entry.overflow !== 'boolean') {
    addIssue(`${path}.overflow`, 'invalid-boolean', 'overflow must be a boolean.');
    return false;
  }
  if (
    !COMPLETENESS_STATES.includes(entry.observationCompleteness) ||
    !COMPLETENESS_STATES.includes(entry.completeness)
  ) {
    addIssue(`${path}.completeness`, 'invalid-enum', 'Invalid token completeness state.');
    return false;
  }

  let expectedObs = 'no-data';
  if (totalAttemptCount === 0) {
    expectedObs = 'no-data';
  } else if (entry.overflow) {
    expectedObs = 'overflow';
  } else if (entry.knownAttemptCount === 0) {
    expectedObs = 'unknown';
  } else if (entry.unknownAttemptCount > 0) {
    expectedObs = 'partial';
  } else {
    expectedObs = 'complete';
  }
  if (entry.observationCompleteness !== expectedObs) {
    addIssue(
      `${path}.observationCompleteness`,
      'observation-completeness-mismatch',
      'observationCompleteness disagrees with known/unknown attempt counts.'
    );
  }

  const expectedComp =
    expectedObs === 'complete' && !historyComplete ? 'partial' : expectedObs;
  if (entry.completeness !== expectedComp) {
    addIssue(
      `${path}.completeness`,
      'completeness-mismatch',
      'completeness disagrees with observationCompleteness and historyComplete.'
    );
  }

  if (entry.overflow || entry.knownAttemptCount === 0) {
    if (entry.knownSum !== null) {
      addIssue(`${path}.knownSum`, 'invalid-known-sum', 'knownSum must be null when unknown or overflow.');
    }
  } else if (!isSafeNonNegativeInteger(entry.knownSum)) {
    addIssue(`${path}.knownSum`, 'invalid-known-sum', 'knownSum must be a nonnegative safe integer.');
  }

  if (entry.completeness === 'complete') {
    if (entry.completeTotal !== entry.knownSum || entry.completeTotal === null) {
      addIssue(
        `${path}.completeTotal`,
        'invalid-complete-total',
        'completeTotal must equal knownSum when completeness is complete.'
      );
    }
  } else if (entry.completeTotal !== null) {
    addIssue(
      `${path}.completeTotal`,
      'partial-marked-complete',
      'completeTotal must be null when completeness is not complete.'
    );
  }

  return true;
}

/**
 * Validates a summary report (including imported or externally edited reports)
 * for full structural and cross-field consistency without throwing on malformed input.
 * Note: Structural validation never proves authenticity or authorizes execution.
 */
export function validateAnalyticsSummary(summary) {
  const issues = [];
  const addIssue = (path, code, message) => {
    if (issues.length < ANALYTICS_LIMITS.issues) {
      issues.push({ path, code, message });
    }
  };

  const topKeys = new Set([
    'format',
    'schemaVersion',
    'sourceContract',
    'ok',
    'clean',
    'failClosed',
    'status',
    'envelopeCounts',
    'unavailableReasonCounts',
    'unavailableEnvelopes',
    'malformedEnvelopes',
    'reconciliation',
    'runs',
    'attempts',
    'tokens',
    'costs',
    'timing',
    'issues',
    'limits',
  ]);

  if (!hasOnlyPlainOwnProperties(summary, topKeys)) {
    return {
      ok: false,
      issues: [
        {
          path: '$',
          code: 'invalid-summary-object',
          message: 'Summary must be a plain object with exact documented top-level keys.',
        },
      ],
    };
  }

  if (summary.format !== ANALYTICS_FORMAT) {
    addIssue('$.format', 'unsupported-value', 'Summary format must match ANALYTICS_FORMAT.');
  }
  if (summary.schemaVersion !== ANALYTICS_SCHEMA_VERSION) {
    addIssue('$.schemaVersion', 'unsupported-value', 'Summary schemaVersion must be 1.');
  }

  const scKeys = new Set(['exportFormat', 'exportFormatVersion', 'runSchemaVersion']);
  if (
    !hasOnlyPlainOwnProperties(summary.sourceContract, scKeys) ||
    summary.sourceContract.exportFormat !== RECEIPT_EXPORT_FORMAT ||
    summary.sourceContract.exportFormatVersion !== RECEIPT_EXPORT_VERSION ||
    summary.sourceContract.runSchemaVersion !== RECEIPT_SCHEMA_VERSION
  ) {
    addIssue('$.sourceContract', 'invalid-source-contract', 'Source contract metadata is invalid.');
  }

  if (typeof summary.ok !== 'boolean') {
    addIssue('$.ok', 'invalid-boolean', 'ok must be a boolean.');
  }
  if (typeof summary.clean !== 'boolean') {
    addIssue('$.clean', 'invalid-boolean', 'clean must be a boolean.');
  }
  if (typeof summary.failClosed !== 'boolean') {
    addIssue('$.failClosed', 'invalid-boolean', 'failClosed must be a boolean.');
  }
  if (!ANALYTICS_STATUSES.includes(summary.status)) {
    addIssue('$.status', 'invalid-enum', 'status must be a documented analytics status.');
  }

  if (
    !isDensePlainArray(summary.limits, ANALYTICS_LIMIT_NOTES.length) ||
    summary.limits.length !== ANALYTICS_LIMIT_NOTES.length ||
    summary.limits.some((note, idx) => note !== ANALYTICS_LIMIT_NOTES[idx])
  ) {
    addIssue('$.limits', 'invalid-limits', 'limits must match ANALYTICS_LIMIT_NOTES.');
  }

  let hasContradictoryEvidenceIssue = false;
  if (!isDensePlainArray(summary.issues, ANALYTICS_LIMITS.issues)) {
    addIssue('$.issues', 'invalid-array', 'issues must be a dense bounded array.');
  } else {
    summary.issues.forEach((iss, idx) => {
      if (!isPlainObject(iss)) {
        addIssue(`$.issues[${idx}]`, 'invalid-object', 'Issue entry must be a plain object.');
        return;
      }
      const keys = Reflect.ownKeys(iss);
      const validKeys = keys.every(
        (k) =>
          (k === 'path' || k === 'code' || k === 'detailCode' || k === 'message') &&
          getOwnDataProperty(iss, k).valid
      );
      if (
        !validKeys ||
        !isBoundedCleanString(iss.path) ||
        !isBoundedCleanString(iss.code) ||
        !isBoundedCleanString(iss.message, 400) ||
        (iss.detailCode !== undefined && !isBoundedCleanString(iss.detailCode))
      ) {
        addIssue(`$.issues[${idx}]`, 'invalid-issue-entry', 'Issue entry fields are invalid.');
        return;
      }
      if (CONTRADICTORY_EVIDENCE_CODES.includes(iss.code)) {
        hasContradictoryEvidenceIssue = true;
      }
    });
  }

  // Envelope counts & lists
  const ec = summary.envelopeCounts;
  const ecSum = validateCountMap(
    ec,
    ['total', 'available', 'unavailable', 'malformed'],
    '$.envelopeCounts',
    addIssue
  );
  const ecValid =
    ecSum !== null &&
    ec.total <= ANALYTICS_LIMITS.envelopes &&
    ec.available + ec.unavailable + ec.malformed === ec.total;
  if (ecSum !== null && !ecValid) {
    addIssue('$.envelopeCounts', 'count-mismatch', 'Envelope counts are inconsistent or exceed limit.');
  }

  const unavailReasonsSum = validateCountMap(
    summary.unavailableReasonCounts,
    Object.keys(UNAVAILABLE_REASONS),
    '$.unavailableReasonCounts',
    addIssue
  );

  const seenEnvelopeIndexes = new Set();
  const derivedReasonCounts = Object.fromEntries(
    Object.keys(UNAVAILABLE_REASONS).map((k) => [k, 0])
  );

  if (!isDensePlainArray(summary.unavailableEnvelopes, ANALYTICS_LIMITS.envelopes)) {
    addIssue('$.unavailableEnvelopes', 'invalid-array', 'unavailableEnvelopes must be a dense array.');
  } else {
    if (ecValid && summary.unavailableEnvelopes.length !== ec.unavailable) {
      addIssue(
        '$.unavailableEnvelopes',
        'count-mismatch',
        'unavailableEnvelopes.length must equal envelopeCounts.unavailable.'
      );
    }
    summary.unavailableEnvelopes.forEach((item, idx) => {
      const p = `$.unavailableEnvelopes[${idx}]`;
      if (!hasOnlyPlainOwnProperties(item, new Set(['envelopeIndex', 'reasonCodes']))) {
        addIssue(p, 'invalid-object', 'Unavailable envelope entry is invalid.');
        return;
      }
      if (
        !isSafeNonNegativeInteger(item.envelopeIndex) ||
        (ecValid && item.envelopeIndex >= ec.total) ||
        seenEnvelopeIndexes.has(item.envelopeIndex)
      ) {
        addIssue(`${p}.envelopeIndex`, 'invalid-envelope-index', 'Invalid or duplicate envelopeIndex.');
      } else {
        seenEnvelopeIndexes.add(item.envelopeIndex);
      }
      if (
        !isDensePlainArray(item.reasonCodes, Object.keys(UNAVAILABLE_REASONS).length) ||
        item.reasonCodes.length === 0
      ) {
        addIssue(`${p}.reasonCodes`, 'invalid-array', 'reasonCodes must be a non-empty array.');
      } else {
        for (const rc of item.reasonCodes) {
          if (typeof rc !== 'string' || !Object.hasOwn(UNAVAILABLE_REASONS, rc)) {
            addIssue(`${p}.reasonCodes`, 'invalid-enum', 'Unknown unavailable reason code.');
          } else {
            derivedReasonCounts[rc] += 1;
          }
        }
      }
    });

    if (unavailReasonsSum !== null) {
      for (const k of Object.keys(UNAVAILABLE_REASONS)) {
        if (summary.unavailableReasonCounts[k] !== derivedReasonCounts[k]) {
          addIssue(
            `$.unavailableReasonCounts.${k}`,
            'reason-count-mismatch',
            'unavailableReasonCounts disagrees with unavailableEnvelopes.'
          );
        }
      }
    }
  }

  if (!isDensePlainArray(summary.malformedEnvelopes, ANALYTICS_LIMITS.envelopes)) {
    addIssue('$.malformedEnvelopes', 'invalid-array', 'malformedEnvelopes must be a dense array.');
  } else {
    if (ecValid && summary.malformedEnvelopes.length !== ec.malformed) {
      addIssue(
        '$.malformedEnvelopes',
        'count-mismatch',
        'malformedEnvelopes.length must equal envelopeCounts.malformed.'
      );
    }
    summary.malformedEnvelopes.forEach((item, idx) => {
      const p = `$.malformedEnvelopes[${idx}]`;
      if (
        !hasOnlyPlainOwnProperties(
          item,
          new Set(['envelopeIndex', 'issueCount', 'issueCodes', 'firstIssuePath'])
        )
      ) {
        addIssue(p, 'invalid-object', 'Malformed envelope entry has invalid keys.');
        return;
      }
      if (
        !isSafeNonNegativeInteger(item.envelopeIndex) ||
        (ecValid && item.envelopeIndex >= ec.total) ||
        seenEnvelopeIndexes.has(item.envelopeIndex)
      ) {
        addIssue(`${p}.envelopeIndex`, 'invalid-envelope-index', 'Invalid or duplicate envelopeIndex.');
      } else {
        seenEnvelopeIndexes.add(item.envelopeIndex);
      }
      if (!isSafeNonNegativeInteger(item.issueCount) || item.issueCount < 1) {
        addIssue(`${p}.issueCount`, 'invalid-integer', 'issueCount must be >= 1.');
      }
      if (
        !isDensePlainArray(item.issueCodes, LIMITS.issues) ||
        item.issueCodes.length === 0 ||
        !item.issueCodes.every((c) => isBoundedCleanString(c))
      ) {
        addIssue(`${p}.issueCodes`, 'invalid-array', 'issueCodes must be non-empty clean strings.');
      }
      if (!isBoundedCleanString(item.firstIssuePath)) {
        addIssue(`${p}.firstIssuePath`, 'invalid-string', 'firstIssuePath must be a clean string.');
      }
    });
  }

  // Reconciliation
  const rec = summary.reconciliation;
  const recKeys = new Set([
    'distinctRunIdsSeen',
    'resolvedRunCount',
    'unresolvedRunCount',
    'exactDuplicatesCollapsed',
    'supersededExportsCount',
    'preservedEvidenceRunCount',
    'resolvedRuns',
    'unresolvedRuns',
  ]);
  const validResolvedRunDescriptors = [];

  if (!hasOnlyPlainOwnProperties(rec, recKeys)) {
    addIssue('$.reconciliation', 'invalid-object', 'reconciliation has invalid keys.');
  } else {
    const recIntFields = [
      'distinctRunIdsSeen',
      'resolvedRunCount',
      'unresolvedRunCount',
      'exactDuplicatesCollapsed',
      'supersededExportsCount',
      'preservedEvidenceRunCount',
    ];
    const recIntsOk = recIntFields.every((k) => isSafeNonNegativeInteger(rec[k]));
    if (!recIntsOk) {
      addIssue('$.reconciliation', 'invalid-integer', 'Reconciliation counts must be safe integers.');
    } else if (rec.resolvedRunCount + rec.unresolvedRunCount !== rec.distinctRunIdsSeen) {
      addIssue(
        '$.reconciliation',
        'run-count-mismatch',
        'resolvedRunCount + unresolvedRunCount must equal distinctRunIdsSeen.'
      );
    }

    const okResolvedArr = isDensePlainArray(rec.resolvedRuns, ANALYTICS_LIMITS.runs);
    const okUnresolvedArr = isDensePlainArray(rec.unresolvedRuns, ANALYTICS_LIMITS.runs);
    if (!okResolvedArr || (recIntsOk && rec.resolvedRuns.length !== rec.resolvedRunCount)) {
      addIssue('$.reconciliation.resolvedRuns', 'count-mismatch', 'resolvedRuns invalid or length mismatch.');
    }
    if (!okUnresolvedArr || (recIntsOk && rec.unresolvedRuns.length !== rec.unresolvedRunCount)) {
      addIssue('$.reconciliation.unresolvedRuns', 'count-mismatch', 'unresolvedRuns invalid or length mismatch.');
    }

    const seenRunIds = new Set();
    let derivedDupCollapsed = 0;
    let derivedSuperseded = 0;
    let derivedPreservedCount = 0;
    let availableEnvAccounted = 0;

    if (okResolvedArr) {
      rec.resolvedRuns.forEach((rr, idx) => {
        const p = `$.reconciliation.resolvedRuns[${idx}]`;
        const rrKeys = new Set([
          'runId',
          'taskKey',
          'inputRevision',
          'recordVersion',
          'timebase',
          'selectedEnvelopeIndex',
          'allEnvelopeIndexes',
          'duplicateExportCount',
          'supersededExportCount',
          'supersededRecordVersions',
          'preservedFromOlderVersions',
        ]);
        if (!hasOnlyPlainOwnProperties(rr, rrKeys)) {
          addIssue(p, 'invalid-object', 'Resolved run record has invalid keys.');
          return;
        }
        if (!isBoundedCleanString(rr.runId) || seenRunIds.has(rr.runId)) {
          addIssue(`${p}.runId`, 'invalid-run-id', 'Invalid or duplicate runId.');
          return;
        }
        seenRunIds.add(rr.runId);

        if (
          !isBoundedCleanString(rr.taskKey) ||
          !isBoundedCleanString(rr.inputRevision) ||
          !isSafeNonNegativeInteger(rr.recordVersion) ||
          !TIMEBASES.includes(rr.timebase) ||
          !isSafeNonNegativeInteger(rr.selectedEnvelopeIndex) ||
          !isDensePlainArray(rr.allEnvelopeIndexes, ANALYTICS_LIMITS.envelopes) ||
          rr.allEnvelopeIndexes.length === 0 ||
          !isSafeNonNegativeInteger(rr.duplicateExportCount) ||
          !isSafeNonNegativeInteger(rr.supersededExportCount) ||
          !isDensePlainArray(rr.supersededRecordVersions, ANALYTICS_LIMITS.envelopes)
        ) {
          addIssue(p, 'invalid-resolved-run-fields', 'Resolved run fields are invalid.');
          return;
        }

        for (const eIdx of rr.allEnvelopeIndexes) {
          if (
            !isSafeNonNegativeInteger(eIdx) ||
            (ecValid && eIdx >= ec.total) ||
            seenEnvelopeIndexes.has(eIdx)
          ) {
            addIssue(`${p}.allEnvelopeIndexes`, 'invalid-envelope-index', 'Duplicate or out-of-range envelopeIndex.');
          } else {
            seenEnvelopeIndexes.add(eIdx);
            availableEnvAccounted += 1;
          }
        }
        if (!rr.allEnvelopeIndexes.includes(rr.selectedEnvelopeIndex)) {
          addIssue(`${p}.selectedEnvelopeIndex`, 'invalid-envelope-index', 'selectedEnvelopeIndex not in allEnvelopeIndexes.');
        }
        if (1 + rr.duplicateExportCount + rr.supersededExportCount !== rr.allEnvelopeIndexes.length) {
          addIssue(p, 'export-count-mismatch', 'Resolved run export counts do not match allEnvelopeIndexes.');
        } else {
          derivedDupCollapsed += rr.duplicateExportCount;
          derivedSuperseded += rr.supersededExportCount;
        }
        if (
          rr.supersededRecordVersions.length !== rr.supersededExportCount ||
          !rr.supersededRecordVersions.every(
            (v) => isSafeNonNegativeInteger(v) && v < rr.recordVersion
          )
        ) {
          addIssue(`${p}.supersededRecordVersions`, 'invalid-versions', 'Invalid supersededRecordVersions.');
        }

        const pfKeys = new Set(['costAttemptCount', 'usageAttemptCount', 'sourceRecordVersions']);
        if (
          !hasOnlyPlainOwnProperties(rr.preservedFromOlderVersions, pfKeys) ||
          !isSafeNonNegativeInteger(rr.preservedFromOlderVersions.costAttemptCount) ||
          !isSafeNonNegativeInteger(rr.preservedFromOlderVersions.usageAttemptCount) ||
          !isDensePlainArray(rr.preservedFromOlderVersions.sourceRecordVersions, ANALYTICS_LIMITS.envelopes) ||
          !rr.preservedFromOlderVersions.sourceRecordVersions.every(
            (v) => isSafeNonNegativeInteger(v) && v < rr.recordVersion
          )
        ) {
          addIssue(`${p}.preservedFromOlderVersions`, 'invalid-object', 'Invalid preservedFromOlderVersions.');
        } else if (
          rr.preservedFromOlderVersions.costAttemptCount > 0 ||
          rr.preservedFromOlderVersions.usageAttemptCount > 0
        ) {
          derivedPreservedCount += 1;
          if (rr.preservedFromOlderVersions.sourceRecordVersions.length === 0) {
            addIssue(
              `${p}.preservedFromOlderVersions.sourceRecordVersions`,
              'missing-source-versions',
              'Preserved evidence must list sourceRecordVersions.'
            );
          }
        }

        validResolvedRunDescriptors.push({
          runId: rr.runId,
          timebase: rr.timebase,
        });
      });
    }

    if (okUnresolvedArr) {
      rec.unresolvedRuns.forEach((ur, idx) => {
        const p = `$.reconciliation.unresolvedRuns[${idx}]`;
        const urKeys = new Set([
          'runId',
          'conflictCodes',
          'envelopeIndexes',
          'snapshotCount',
          'observedRecordVersions',
          'hasNullVersion',
        ]);
        if (!hasOnlyPlainOwnProperties(ur, urKeys)) {
          addIssue(p, 'invalid-object', 'Unresolved run record has invalid keys.');
          return;
        }
        if (!isBoundedCleanString(ur.runId) || seenRunIds.has(ur.runId)) {
          addIssue(`${p}.runId`, 'invalid-run-id', 'Invalid or duplicate runId.');
          return;
        }
        seenRunIds.add(ur.runId);

        if (
          !isDensePlainArray(ur.conflictCodes, RECONCILIATION_CONFLICT_CODES.length) ||
          ur.conflictCodes.length === 0 ||
          !ur.conflictCodes.every((c) => RECONCILIATION_CONFLICT_CODES.includes(c)) ||
          !isDensePlainArray(ur.envelopeIndexes, ANALYTICS_LIMITS.envelopes) ||
          ur.envelopeIndexes.length === 0 ||
          !isSafeNonNegativeInteger(ur.snapshotCount) ||
          ur.snapshotCount < 1 ||
          ur.envelopeIndexes.length < ur.snapshotCount ||
          !isDensePlainArray(ur.observedRecordVersions, ANALYTICS_LIMITS.envelopes) ||
          !ur.observedRecordVersions.every(isSafeNonNegativeInteger) ||
          typeof ur.hasNullVersion !== 'boolean'
        ) {
          addIssue(p, 'invalid-unresolved-run-fields', 'Unresolved run fields are invalid.');
          return;
        }

        for (const eIdx of ur.envelopeIndexes) {
          if (
            !isSafeNonNegativeInteger(eIdx) ||
            (ecValid && eIdx >= ec.total) ||
            seenEnvelopeIndexes.has(eIdx)
          ) {
            addIssue(`${p}.envelopeIndexes`, 'invalid-envelope-index', 'Duplicate or out-of-range envelopeIndex.');
          } else {
            seenEnvelopeIndexes.add(eIdx);
            availableEnvAccounted += 1;
          }
        }
        derivedDupCollapsed += ur.envelopeIndexes.length - ur.snapshotCount;
      });
    }

    if (recIntsOk && okResolvedArr && okUnresolvedArr) {
      if (rec.exactDuplicatesCollapsed !== derivedDupCollapsed) {
        addIssue(
          '$.reconciliation.exactDuplicatesCollapsed',
          'duplicate-count-mismatch',
          'exactDuplicatesCollapsed disagrees with run records.'
        );
      }
      if (rec.supersededExportsCount !== derivedSuperseded) {
        addIssue(
          '$.reconciliation.supersededExportsCount',
          'superseded-count-mismatch',
          'supersededExportsCount disagrees with resolvedRuns.'
        );
      }
      if (rec.preservedEvidenceRunCount !== derivedPreservedCount) {
        addIssue(
          '$.reconciliation.preservedEvidenceRunCount',
          'preserved-count-mismatch',
          'preservedEvidenceRunCount disagrees with resolvedRuns.'
        );
      }
      if (ecValid && availableEnvAccounted !== ec.available) {
        addIssue(
          '$.reconciliation',
          'available-envelope-mismatch',
          'Total envelopes in resolvedRuns and unresolvedRuns must equal envelopeCounts.available.'
        );
      }
    }
  }

  // Runs & Attempts sections
  const runs = summary.runs;
  const attempts = summary.attempts;
  const runsKeys = new Set([
    'resolvedRunCount',
    'unresolvedRunCount',
    'taskKindCounts',
    'taskStatusCounts',
    'acceptance',
    'attemptListCompleteness',
    'retries',
  ]);
  const attemptsKeys = new Set([
    'totalAttemptCount',
    'statusCounts',
    'recordedStatusCounts',
    'outcomes',
    'providersAndModels',
    'operatorEditsAndChecks',
  ]);

  if (!hasOnlyPlainOwnProperties(runs, runsKeys) || !hasOnlyPlainOwnProperties(attempts, attemptsKeys)) {
    addIssue('$.runs', 'invalid-object', 'runs or attempts has invalid keys.');
  } else {
    if (
      !isSafeNonNegativeInteger(runs.resolvedRunCount) ||
      !isSafeNonNegativeInteger(runs.unresolvedRunCount) ||
      runs.resolvedRunCount !== rec?.resolvedRunCount ||
      runs.unresolvedRunCount !== rec?.unresolvedRunCount
    ) {
      addIssue('$.runs.resolvedRunCount', 'count-mismatch', 'runs counts must match reconciliation.');
    }
    const kindSum = validateCountMap(runs.taskKindCounts, ['brief', 'change'], '$.runs.taskKindCounts', addIssue);
    if (kindSum !== null && kindSum !== runs.resolvedRunCount) {
      addIssue('$.runs.taskKindCounts', 'count-mismatch', 'taskKindCounts must sum to resolvedRunCount.');
    }
    const taskStSum = validateCountMap(runs.taskStatusCounts, TASK_STATUSES, '$.runs.taskStatusCounts', addIssue);
    if (taskStSum !== null && taskStSum !== runs.resolvedRunCount) {
      addIssue('$.runs.taskStatusCounts', 'count-mismatch', 'taskStatusCounts must sum to resolvedRunCount.');
    }

    const acc = runs.acceptance;
    const accKeys = new Set([
      'acceptedRunCount',
      'unconfirmedAcceptanceRunCount',
      'notAcceptedRunCount',
      'operatorEditedRunCount',
      'operatorEditedFalseRunCount',
      'operatorEditedUnknownRunCount',
      'runsWithEarlierAcceptedAttemptsCount',
      'earlierAcceptedAttemptsTotal',
      'earlierAcceptedAttemptsOverflow',
    ]);
    if (!hasOnlyPlainOwnProperties(acc, accKeys)) {
      addIssue('$.runs.acceptance', 'invalid-object', 'acceptance has invalid keys.');
    } else {
      if (
        !isSafeNonNegativeInteger(acc.acceptedRunCount) ||
        !isSafeNonNegativeInteger(acc.unconfirmedAcceptanceRunCount) ||
        !isSafeNonNegativeInteger(acc.notAcceptedRunCount) ||
        acc.acceptedRunCount + acc.unconfirmedAcceptanceRunCount + acc.notAcceptedRunCount !==
          runs.resolvedRunCount
      ) {
        addIssue('$.runs.acceptance', 'count-mismatch', 'Acceptance state counts must sum to resolvedRunCount.');
      }
      if (
        !isSafeNonNegativeInteger(acc.operatorEditedRunCount) ||
        !isSafeNonNegativeInteger(acc.operatorEditedFalseRunCount) ||
        !isSafeNonNegativeInteger(acc.operatorEditedUnknownRunCount) ||
        acc.operatorEditedRunCount +
          acc.operatorEditedFalseRunCount +
          acc.operatorEditedUnknownRunCount !==
          runs.resolvedRunCount
      ) {
        addIssue('$.runs.acceptance', 'count-mismatch', 'operatorEdited counts must sum to resolvedRunCount.');
      }
      if (
        !isSafeNonNegativeInteger(acc.runsWithEarlierAcceptedAttemptsCount) ||
        acc.runsWithEarlierAcceptedAttemptsCount > runs.resolvedRunCount ||
        typeof acc.earlierAcceptedAttemptsOverflow !== 'boolean' ||
        (acc.earlierAcceptedAttemptsOverflow && acc.earlierAcceptedAttemptsTotal !== null) ||
        (!acc.earlierAcceptedAttemptsOverflow && !isSafeNonNegativeInteger(acc.earlierAcceptedAttemptsTotal))
      ) {
        addIssue('$.runs.acceptance.earlierAcceptedAttemptsTotal', 'invalid-value', 'Invalid earlierAcceptedAttempts fields.');
      }
    }

    const alc = runs.attemptListCompleteness;
    if (
      !hasOnlyPlainOwnProperties(
        alc,
        new Set(['completeRunCount', 'incompleteRunCount', 'basisCounts'])
      ) ||
      !isSafeNonNegativeInteger(alc.completeRunCount) ||
      !isSafeNonNegativeInteger(alc.incompleteRunCount) ||
      alc.completeRunCount + alc.incompleteRunCount !== runs.resolvedRunCount
    ) {
      addIssue('$.runs.attemptListCompleteness', 'count-mismatch', 'Invalid attemptListCompleteness.');
    } else {
      validateCountMap(alc.basisCounts, ATTEMPT_LIST_BASES, '$.runs.attemptListCompleteness.basisCounts', addIssue);
    }

    if (!isSafeNonNegativeInteger(attempts.totalAttemptCount)) {
      addIssue('$.attempts.totalAttemptCount', 'invalid-integer', 'totalAttemptCount must be a safe integer.');
    }

    const ret = runs.retries;
    const retKeys = new Set([
      'linkageBasis',
      'runsWithRetriesCount',
      'initialAttemptCount',
      'retryAttemptCount',
      'retryAttemptStatusCounts',
      'priorAttemptBeforeFinalCount',
    ]);
    if (!hasOnlyPlainOwnProperties(ret, retKeys) || ret.linkageBasis !== 'recorded-order-only') {
      addIssue('$.runs.retries', 'invalid-object', 'Invalid retries section.');
    } else {
      const retryStSum = validateCountMap(
        ret.retryAttemptStatusCounts,
        ATTEMPT_STATUSES,
        '$.runs.retries.retryAttemptStatusCounts',
        addIssue
      );
      if (
        !isSafeNonNegativeInteger(ret.runsWithRetriesCount) ||
        ret.runsWithRetriesCount > runs.resolvedRunCount ||
        !isSafeNonNegativeInteger(ret.initialAttemptCount) ||
        ret.initialAttemptCount !== runs.resolvedRunCount ||
        !isSafeNonNegativeInteger(ret.retryAttemptCount) ||
        ret.initialAttemptCount + ret.retryAttemptCount !== attempts.totalAttemptCount ||
        ret.priorAttemptBeforeFinalCount !== ret.retryAttemptCount ||
        (retryStSum !== null && retryStSum !== ret.retryAttemptCount)
      ) {
        addIssue('$.runs.retries', 'count-mismatch', 'Retry counts disagree with resolvedRunCount or totalAttemptCount.');
      }
    }

    const stSum = validateCountMap(attempts.statusCounts, ATTEMPT_STATUSES, '$.attempts.statusCounts', addIssue);
    if (stSum !== null && stSum !== attempts.totalAttemptCount) {
      addIssue('$.attempts.statusCounts', 'count-mismatch', 'statusCounts must sum to totalAttemptCount.');
    }
    const recStSum = validateCountMap(
      attempts.recordedStatusCounts,
      RECORDED_ATTEMPT_STATUSES,
      '$.attempts.recordedStatusCounts',
      addIssue
    );
    if (recStSum !== null && recStSum !== attempts.totalAttemptCount) {
      addIssue('$.attempts.recordedStatusCounts', 'count-mismatch', 'recordedStatusCounts must sum to totalAttemptCount.');
    }

    const out = attempts.outcomes;
    const outKeys = new Set([
      'knownOutcomeCount',
      'unknownOutcomeCount',
      'outcomeBasisCounts',
      'recoveryStateCounts',
      'recoveryEvidenceCounts',
      'executionPhaseCounts',
    ]);
    if (!hasOnlyPlainOwnProperties(out, outKeys)) {
      addIssue('$.attempts.outcomes', 'invalid-object', 'Invalid outcomes section.');
    } else {
      const obSum = validateCountMap(out.outcomeBasisCounts, OUTCOME_BASES, '$.attempts.outcomes.outcomeBasisCounts', addIssue);
      const rsSum = validateCountMap(out.recoveryStateCounts, RECOVERY_STATES, '$.attempts.outcomes.recoveryStateCounts', addIssue);
      const reSum = validateCountMap(
        out.recoveryEvidenceCounts,
        RECOVERY_EVIDENCE_VALUES,
        '$.attempts.outcomes.recoveryEvidenceCounts',
        addIssue
      );
      const epSum = validateCountMap(out.executionPhaseCounts, EXECUTION_PHASES, '$.attempts.outcomes.executionPhaseCounts', addIssue);
      if (
        !isSafeNonNegativeInteger(out.knownOutcomeCount) ||
        !isSafeNonNegativeInteger(out.unknownOutcomeCount) ||
        out.knownOutcomeCount + out.unknownOutcomeCount !== attempts.totalAttemptCount ||
        obSum !== attempts.totalAttemptCount ||
        rsSum !== attempts.totalAttemptCount ||
        reSum !== attempts.totalAttemptCount ||
        epSum !== attempts.totalAttemptCount
      ) {
        addIssue('$.attempts.outcomes', 'count-mismatch', 'Outcome counts must sum to totalAttemptCount.');
      }
    }

    const pm = attempts.providersAndModels;
    const pmKeys = new Set([
      'providerCounts',
      'backendCounts',
      'modelWithheldCount',
      'modelDisclosedCount',
      'inferredModelsCount',
      'inferencePolicy',
    ]);
    if (
      !hasOnlyPlainOwnProperties(pm, pmKeys) ||
      pm.inferredModelsCount !== 0 ||
      pm.inferencePolicy !== 'never-infer-withheld-identities' ||
      !isSafeNonNegativeInteger(pm.modelWithheldCount) ||
      !isSafeNonNegativeInteger(pm.modelDisclosedCount) ||
      pm.modelWithheldCount + pm.modelDisclosedCount !== attempts.totalAttemptCount
    ) {
      addIssue('$.attempts.providersAndModels', 'invalid-object', 'Invalid providersAndModels section.');
    } else {
      const bkSum = validateCountMap(pm.backendCounts, BACKENDS, '$.attempts.providersAndModels.backendCounts', addIssue);
      if (bkSum !== attempts.totalAttemptCount) {
        addIssue('$.attempts.providersAndModels.backendCounts', 'count-mismatch', 'backendCounts must sum to totalAttemptCount.');
      }
      if (!hasOnlyPlainOwnProperties(pm.providerCounts)) {
        addIssue('$.attempts.providersAndModels.providerCounts', 'invalid-object', 'providerCounts must be a plain object.');
      } else {
        let pSum = 0;
        for (const [pk, pv] of Object.entries(pm.providerCounts)) {
          if (!isBoundedCleanString(pk, LIMITS.label) || !isSafeNonNegativeInteger(pv)) {
            addIssue('$.attempts.providersAndModels.providerCounts', 'invalid-entry', 'Invalid provider count entry.');
          } else {
            pSum += pv;
          }
        }
        if (pSum !== attempts.totalAttemptCount) {
          addIssue('$.attempts.providersAndModels.providerCounts', 'count-mismatch', 'providerCounts must sum to totalAttemptCount.');
        }
      }
    }

    const oec = attempts.operatorEditsAndChecks;
    const oecKeys = new Set([
      'attemptsWithKnownOperatorEditsCount',
      'attemptsWithUnknownOperatorEditsCount',
      'totalOperatorEdits',
      'operatorEditsOverflow',
      'attemptsWithChecksCount',
      'attemptsWithoutChecksCount',
      'totalChecksPassed',
      'totalChecksFailed',
      'checksOverflow',
    ]);
    if (
      !hasOnlyPlainOwnProperties(oec, oecKeys) ||
      !isSafeNonNegativeInteger(oec.attemptsWithKnownOperatorEditsCount) ||
      !isSafeNonNegativeInteger(oec.attemptsWithUnknownOperatorEditsCount) ||
      oec.attemptsWithKnownOperatorEditsCount + oec.attemptsWithUnknownOperatorEditsCount !==
        attempts.totalAttemptCount ||
      typeof oec.operatorEditsOverflow !== 'boolean' ||
      (oec.operatorEditsOverflow && oec.totalOperatorEdits !== null) ||
      (!oec.operatorEditsOverflow && !isSafeNonNegativeInteger(oec.totalOperatorEdits)) ||
      !isSafeNonNegativeInteger(oec.attemptsWithChecksCount) ||
      !isSafeNonNegativeInteger(oec.attemptsWithoutChecksCount) ||
      oec.attemptsWithChecksCount + oec.attemptsWithoutChecksCount !== attempts.totalAttemptCount ||
      typeof oec.checksOverflow !== 'boolean' ||
      (oec.checksOverflow && (oec.totalChecksPassed !== null || oec.totalChecksFailed !== null)) ||
      (!oec.checksOverflow &&
        (!isSafeNonNegativeInteger(oec.totalChecksPassed) ||
          !isSafeNonNegativeInteger(oec.totalChecksFailed)))
    ) {
      addIssue('$.attempts.operatorEditsAndChecks', 'invalid-object', 'Invalid operatorEditsAndChecks.');
    }
  }

  // History completeness across the dataset
  const expectedHistoryComplete =
    isSafeNonNegativeInteger(runs?.attemptListCompleteness?.incompleteRunCount) &&
    runs.attemptListCompleteness.incompleteRunCount === 0 &&
    ec?.unavailable === 0 &&
    ec?.malformed === 0 &&
    rec?.unresolvedRunCount === 0 &&
    !hasContradictoryEvidenceIssue;

  // Tokens validation
  const tok = summary.tokens;
  const tokKeys = new Set([
    'categoryOverlapPolicy',
    'totalAttemptCount',
    'historyComplete',
    'incompletenessReasons',
    'observationCompleteness',
    'overallCompleteness',
    'byCategory',
    'byProvenance',
  ]);
  if (
    !hasOnlyPlainOwnProperties(tok, tokKeys) ||
    tok.categoryOverlapPolicy !== 'categories-not-summed-or-subtracted' ||
    tok.totalAttemptCount !== attempts?.totalAttemptCount ||
    tok.historyComplete !== expectedHistoryComplete ||
    !COMPLETENESS_STATES.includes(tok.observationCompleteness) ||
    !COMPLETENESS_STATES.includes(tok.overallCompleteness) ||
    !isDensePlainArray(tok.incompletenessReasons, INCOMPLETENESS_REASON_CODES.length) ||
    !tok.incompletenessReasons.every((r) => INCOMPLETENESS_REASON_CODES.includes(r))
  ) {
    addIssue('$.tokens', 'invalid-tokens-section', 'Invalid tokens section header or completeness.');
  } else if (!hasOnlyPlainOwnProperties(tok.byCategory, new Set(TOKEN_CATEGORIES))) {
    addIssue('$.tokens.byCategory', 'invalid-object', 'byCategory must contain all 5 token categories.');
  } else {
    let allCatValid = true;
    for (const cat of TOKEN_CATEGORIES) {
      if (
        !validateTokenCategoryEntry(
          tok.byCategory[cat],
          tok.totalAttemptCount,
          tok.historyComplete,
          `$.tokens.byCategory.${cat}`,
          addIssue
        )
      ) {
        allCatValid = false;
      }
    }
    if (allCatValid) {
      let expectedObs = 'no-data';
      if (tok.totalAttemptCount > 0) {
        const obsStates = TOKEN_CATEGORIES.map((c) => tok.byCategory[c].observationCompleteness);
        if (obsStates.includes('overflow')) expectedObs = 'overflow';
        else if (obsStates.every((s) => s === 'complete')) expectedObs = 'complete';
        else if (obsStates.every((s) => s === 'unknown')) expectedObs = 'unknown';
        else expectedObs = 'partial';
      }
      const expectedOverall =
        expectedObs === 'complete' && !tok.historyComplete ? 'partial' : expectedObs;
      if (tok.observationCompleteness !== expectedObs) {
        addIssue('$.tokens.observationCompleteness', 'completeness-mismatch', 'Disagrees with category observationCompleteness.');
      }
      if (tok.overallCompleteness !== expectedOverall) {
        addIssue('$.tokens.overallCompleteness', 'completeness-mismatch', 'Disagrees with category completeness and historyComplete.');
      }
    }

    if (!isDensePlainArray(tok.byProvenance, 16)) {
      addIssue('$.tokens.byProvenance', 'invalid-array', 'byProvenance must be a dense array.');
    } else {
      let provAttemptSum = 0;
      tok.byProvenance.forEach((pItem, idx) => {
        const pp = `$.tokens.byProvenance[${idx}]`;
        if (
          !hasOnlyPlainOwnProperties(
            pItem,
            new Set(['evidence', 'semantics', 'attemptCount', 'stepFlags', 'byCategory'])
          ) ||
          !isSafeNonNegativeInteger(pItem.attemptCount) ||
          pItem.attemptCount < 1
        ) {
          addIssue(pp, 'invalid-object', 'Invalid token provenance entry.');
          return;
        }
        provAttemptSum += pItem.attemptCount;
        if (!hasOnlyPlainOwnProperties(pItem.byCategory, new Set(TOKEN_CATEGORIES))) {
          addIssue(`${pp}.byCategory`, 'invalid-object', 'Invalid provenance byCategory.');
        } else {
          for (const cat of TOKEN_CATEGORIES) {
            validateTokenCategoryEntry(
              pItem.byCategory[cat],
              pItem.attemptCount,
              tok.historyComplete,
              `${pp}.byCategory.${cat}`,
              addIssue
            );
          }
        }
      });
      if (provAttemptSum !== tok.totalAttemptCount) {
        addIssue('$.tokens.byProvenance', 'count-mismatch', 'byProvenance attemptCount must sum to totalAttemptCount.');
      }
    }
  }

  // Costs validation
  const costs = summary.costs;
  const costsKeys = new Set([
    'accountingPolicy',
    'billingAuthenticationStatus',
    'routerSavingsClaim',
    'totalAttemptCount',
    'knownCostAttemptCount',
    'unknownCostAttemptCount',
    'incompleteCostAttemptCount',
    'historyComplete',
    'incompletenessReasons',
    'observationCompleteness',
    'completeness',
    'costEvidenceStateCounts',
    'chargeInputSummary',
    'currencies',
    'hasMixedCurrencies',
    'hasUnknownCosts',
    'hasOverflow',
    'groups',
    'byCurrencyAndEvidence',
  ]);
  if (
    !hasOnlyPlainOwnProperties(costs, costsKeys) ||
    costs.accountingPolicy !== 'exact-integer-micros-no-currency-conversion-no-evidence-mixing' ||
    costs.billingAuthenticationStatus !== 'unverified-caller-supplied-claims-only' ||
    costs.routerSavingsClaim !== 'not-supported' ||
    costs.totalAttemptCount !== attempts?.totalAttemptCount ||
    !isSafeNonNegativeInteger(costs.knownCostAttemptCount) ||
    !isSafeNonNegativeInteger(costs.unknownCostAttemptCount) ||
    !isSafeNonNegativeInteger(costs.incompleteCostAttemptCount) ||
    costs.knownCostAttemptCount + costs.unknownCostAttemptCount !== costs.totalAttemptCount ||
    costs.incompleteCostAttemptCount > costs.knownCostAttemptCount ||
    costs.historyComplete !== expectedHistoryComplete ||
    costs.hasUnknownCosts !== (costs.unknownCostAttemptCount > 0) ||
    typeof costs.hasMixedCurrencies !== 'boolean' ||
    typeof costs.hasOverflow !== 'boolean' ||
    !COMPLETENESS_STATES.includes(costs.observationCompleteness) ||
    !COMPLETENESS_STATES.includes(costs.completeness) ||
    !isDensePlainArray(costs.incompletenessReasons, INCOMPLETENESS_REASON_CODES.length) ||
    !costs.incompletenessReasons.every((r) => INCOMPLETENESS_REASON_CODES.includes(r))
  ) {
    addIssue('$.costs', 'invalid-costs-section', 'Invalid costs section fields or disclaimers.');
  } else {
    const ceSum = validateCountMap(
      costs.costEvidenceStateCounts,
      COST_EVIDENCE_STATES,
      '$.costs.costEvidenceStateCounts',
      addIssue
    );
    if (
      ceSum !== costs.totalAttemptCount ||
      costs.costEvidenceStateCounts['caller-supplied'] !== costs.knownCostAttemptCount
    ) {
      addIssue(
        '$.costs.costEvidenceStateCounts',
        'count-mismatch',
        'costEvidenceStateCounts disagrees with totalAttemptCount or knownCostAttemptCount.'
      );
    }

    const cis = costs.chargeInputSummary;
    if (
      !hasOnlyPlainOwnProperties(
        cis,
        new Set(['recordsTotal', 'duplicatesTotal', 'unattributedTotal', 'overflow'])
      ) ||
      typeof cis.overflow !== 'boolean' ||
      (cis.overflow &&
        (cis.recordsTotal !== null || cis.duplicatesTotal !== null || cis.unattributedTotal !== null)) ||
      (!cis.overflow &&
        (!isSafeNonNegativeInteger(cis.recordsTotal) ||
          !isSafeNonNegativeInteger(cis.duplicatesTotal) ||
          !isSafeNonNegativeInteger(cis.unattributedTotal)))
    ) {
      addIssue('$.costs.chargeInputSummary', 'invalid-object', 'Invalid chargeInputSummary.');
    }

    const okCurrencies =
      isDensePlainArray(costs.currencies, ANALYTICS_LIMITS.envelopes) &&
      costs.currencies.every((c) => typeof c === 'string' && CURRENCY_RE.test(c));
    if (!okCurrencies || costs.hasMixedCurrencies !== (costs.currencies.length > 1)) {
      addIssue('$.costs.currencies', 'invalid-currencies', 'Invalid currencies list or hasMixedCurrencies.');
    }

    if (!isDensePlainArray(costs.groups, ANALYTICS_LIMITS.envelopes)) {
      addIssue('$.costs.groups', 'invalid-array', 'costs.groups must be a dense array.');
    } else {
      let groupAttemptSum = 0;
      let groupIncompleteSum = 0;
      let anyGroupOverflow = false;
      let allGroupObjectsValid = true;
      const seenGroupKeys = new Set();
      const seenCurrencies = new Set();

      costs.groups.forEach((g, idx) => {
        const gp = `$.costs.groups[${idx}]`;
        const gKeys = new Set([
          'currency',
          'evidence',
          'provenance',
          'authenticatedBilling',
          'attemptCount',
          'completeAttemptCount',
          'incompleteAttemptCount',
          'initialAttemptCount',
          'retryAttemptCount',
          'acceptedAttemptCount',
          'nonAcceptedAttemptCount',
          'hasIncompleteHistory',
          'overflow',
          'knownSumMicros',
          'acceptedAttemptsKnownSumMicros',
          'nonAcceptedAndRetryKnownSumMicros',
          'completeTotalMicros',
          'groupCompleteness',
          'overallCompleteness',
        ]);
        if (!hasOnlyPlainOwnProperties(g, gKeys)) {
          addIssue(gp, 'invalid-object', 'Cost group has invalid keys.');
          allGroupObjectsValid = false;
          return;
        }
        if (typeof g.currency !== 'string' || !CURRENCY_RE.test(g.currency)) {
          addIssue(`${gp}.currency`, 'invalid-currency', 'Invalid currency code.');
          allGroupObjectsValid = false;
          return;
        }
        seenCurrencies.add(g.currency);
        if (!COST_EVIDENCE.includes(g.evidence)) {
          addIssue(`${gp}.evidence`, 'invalid-enum', 'Invalid cost evidence.');
          allGroupObjectsValid = false;
          return;
        }
        const gKey = `${g.currency}:${g.evidence}`;
        if (seenGroupKeys.has(gKey)) {
          addIssue(gp, 'duplicate-cost-group', 'Duplicate currency:evidence group.');
        } else {
          seenGroupKeys.add(gKey);
        }
        if (g.provenance !== 'caller-supplied' || g.authenticatedBilling !== false) {
          addIssue(gp, 'invalid-billing-claim', 'Cost group must be caller-supplied and unauthenticated.');
        }
        if (
          !isSafeNonNegativeInteger(g.attemptCount) ||
          g.attemptCount < 1 ||
          !isSafeNonNegativeInteger(g.completeAttemptCount) ||
          !isSafeNonNegativeInteger(g.incompleteAttemptCount) ||
          g.completeAttemptCount + g.incompleteAttemptCount !== g.attemptCount ||
          !isSafeNonNegativeInteger(g.initialAttemptCount) ||
          !isSafeNonNegativeInteger(g.retryAttemptCount) ||
          g.initialAttemptCount + g.retryAttemptCount !== g.attemptCount ||
          !isSafeNonNegativeInteger(g.acceptedAttemptCount) ||
          !isSafeNonNegativeInteger(g.nonAcceptedAttemptCount) ||
          g.acceptedAttemptCount + g.nonAcceptedAttemptCount !== g.attemptCount ||
          typeof g.hasIncompleteHistory !== 'boolean' ||
          typeof g.overflow !== 'boolean'
        ) {
          addIssue(gp, 'count-mismatch', 'Cost group counts are inconsistent.');
          allGroupObjectsValid = false;
          return;
        }
        groupAttemptSum += g.attemptCount;
        groupIncompleteSum += g.incompleteAttemptCount;
        if (g.overflow) {
          anyGroupOverflow = true;
          if (
            g.knownSumMicros !== null ||
            g.acceptedAttemptsKnownSumMicros !== null ||
            g.nonAcceptedAndRetryKnownSumMicros !== null ||
            g.completeTotalMicros !== null ||
            g.groupCompleteness !== 'overflow' ||
            g.overallCompleteness !== 'overflow'
          ) {
            addIssue(gp, 'overflow-mismatch', 'Overflow group must have null sums and overflow completeness.');
          }
        } else {
          if (
            !isSafeNonNegativeInteger(g.knownSumMicros) ||
            !isSafeNonNegativeInteger(g.acceptedAttemptsKnownSumMicros) ||
            !isSafeNonNegativeInteger(g.nonAcceptedAndRetryKnownSumMicros)
          ) {
            addIssue(gp, 'invalid-micros', 'Non-overflow group sums must be nonnegative safe integers.');
          } else {
            const subSum = safeAddIntegers(
              g.acceptedAttemptsKnownSumMicros,
              g.nonAcceptedAndRetryKnownSumMicros
            );
            if (!subSum.ok || subSum.value !== g.knownSumMicros) {
              addIssue(
                gp,
                'subtotal-mismatch',
                'accepted + nonAccepted subtotals must equal knownSumMicros.'
              );
            }
          }
          const expGroupComp =
            g.incompleteAttemptCount > 0 || g.hasIncompleteHistory ? 'partial' : 'complete';
          const expOverallComp =
            g.incompleteAttemptCount > 0 ||
            costs.unknownCostAttemptCount > 0 ||
            !costs.historyComplete
              ? 'partial'
              : 'complete';
          if (g.groupCompleteness !== expGroupComp) {
            addIssue(`${gp}.groupCompleteness`, 'completeness-mismatch', 'groupCompleteness mismatch.');
          }
          if (g.overallCompleteness !== expOverallComp) {
            addIssue(`${gp}.overallCompleteness`, 'completeness-mismatch', 'overallCompleteness mismatch.');
          }
          const expCompleteTotal = expOverallComp === 'complete' ? g.knownSumMicros : null;
          if (g.completeTotalMicros !== expCompleteTotal) {
            addIssue(`${gp}.completeTotalMicros`, 'complete-total-mismatch', 'completeTotalMicros mismatch.');
          }
        }
      });

      if (groupAttemptSum !== costs.knownCostAttemptCount) {
        addIssue('$.costs.groups', 'count-mismatch', 'Group attemptCounts must sum to knownCostAttemptCount.');
      }
      if (groupIncompleteSum !== costs.incompleteCostAttemptCount) {
        addIssue('$.costs.groups', 'count-mismatch', 'Group incompleteAttemptCounts must sum to incompleteCostAttemptCount.');
      }
      if (anyGroupOverflow !== costs.hasOverflow) {
        addIssue('$.costs.hasOverflow', 'overflow-mismatch', 'hasOverflow disagrees with cost groups.');
      }
      if (
        okCurrencies &&
        (seenCurrencies.size !== costs.currencies.length ||
          costs.currencies.some((c) => !seenCurrencies.has(c)))
      ) {
        addIssue('$.costs.currencies', 'currency-mismatch', 'currencies list disagrees with cost groups.');
      }
      if (!hasOnlyPlainOwnProperties(costs.byCurrencyAndEvidence, seenGroupKeys)) {
        addIssue('$.costs.byCurrencyAndEvidence', 'invalid-map', 'byCurrencyAndEvidence keys disagree with groups.');
      } else if (allGroupObjectsValid) {
        for (const g of costs.groups) {
          const k = `${g.currency}:${g.evidence}`;
          if (JSON.stringify(costs.byCurrencyAndEvidence[k]) !== JSON.stringify(g)) {
            addIssue(`$.costs.byCurrencyAndEvidence.${k}`, 'map-mismatch', 'Map entry disagrees with group.');
          }
        }
      }

      let expCostObs = 'no-data';
      if (costs.totalAttemptCount > 0) {
        if (costs.hasOverflow) expCostObs = 'overflow';
        else if (costs.knownCostAttemptCount === 0) expCostObs = 'unknown';
        else if (costs.unknownCostAttemptCount > 0 || costs.incompleteCostAttemptCount > 0) {
          expCostObs = 'partial';
        } else {
          expCostObs = 'complete';
        }
      }
      const expCostComp =
        expCostObs === 'complete' && !costs.historyComplete ? 'partial' : expCostObs;
      if (costs.observationCompleteness !== expCostObs) {
        addIssue('$.costs.observationCompleteness', 'completeness-mismatch', 'Cost observationCompleteness mismatch.');
      }
      if (costs.completeness !== expCostComp) {
        addIssue('$.costs.completeness', 'completeness-mismatch', 'Cost completeness mismatch.');
      }
    }
  }

  // Timing validation (including strict timing reference checks against resolvedRuns)
  const tim = summary.timing;
  const timKeys = new Set([
    'timebaseCounts',
    'calendarTime',
    'crossRunOrdering',
    'crossRunWallClock',
    'attemptTimestamps',
    'recordedElapsedMs',
    'perRunWallClock',
  ]);
  if (!hasOnlyPlainOwnProperties(tim, timKeys)) {
    addIssue('$.timing', 'invalid-object', 'Invalid timing section keys.');
  } else {
    const tbSum = validateCountMap(tim.timebaseCounts, TIMEBASES, '$.timing.timebaseCounts', addIssue);
    if (tbSum !== null && tbSum !== runs?.resolvedRunCount) {
      addIssue('$.timing.timebaseCounts', 'count-mismatch', 'timebaseCounts must sum to resolvedRunCount.');
    }

    const hasRel = (tim.timebaseCounts?.['run-relative'] ?? 0) > 0;
    const noRuns = runs?.resolvedRunCount === 0;

    // Attempt timestamps
    const ats = tim.attemptTimestamps;
    let atsValid = false;
    if (
      !hasOnlyPlainOwnProperties(
        ats,
        new Set([
          'startedAtStateCounts',
          'endedAtStateCounts',
          'attemptsWithCompleteIntervalCount',
          'attemptsWithIncompleteIntervalCount',
        ])
      )
    ) {
      addIssue('$.timing.attemptTimestamps', 'invalid-object', 'Invalid attemptTimestamps.');
    } else {
      const saSum = validateCountMap(ats.startedAtStateCounts, STARTED_AT_STATES, '$.timing.attemptTimestamps.startedAtStateCounts', addIssue);
      const eaSum = validateCountMap(ats.endedAtStateCounts, ENDED_AT_STATES, '$.timing.attemptTimestamps.endedAtStateCounts', addIssue);
      if (
        saSum !== attempts?.totalAttemptCount ||
        eaSum !== attempts?.totalAttemptCount ||
        !isSafeNonNegativeInteger(ats.attemptsWithCompleteIntervalCount) ||
        !isSafeNonNegativeInteger(ats.attemptsWithIncompleteIntervalCount) ||
        ats.attemptsWithCompleteIntervalCount + ats.attemptsWithIncompleteIntervalCount !==
          attempts?.totalAttemptCount
      ) {
        addIssue('$.timing.attemptTimestamps', 'count-mismatch', 'attemptTimestamps counts must sum to totalAttemptCount.');
      } else {
        atsValid = true;
      }
    }

    // Per-run wall clock & timing reference validation against resolvedRuns
    let allPerRunAvailable = true;
    const derivedTbCounts = { 'run-relative': 0, epoch: 0 };
    let derivedCompleteRunCount = 0;
    let derivedIncompleteRunCount = 0;

    if (
      !isDensePlainArray(tim.perRunWallClock, ANALYTICS_LIMITS.runs) ||
      tim.perRunWallClock.length !== runs?.resolvedRunCount
    ) {
      addIssue('$.timing.perRunWallClock', 'count-mismatch', 'perRunWallClock length must equal resolvedRunCount.');
      allPerRunAvailable = false;
    } else {
      const seenPrRunIds = new Set();
      tim.perRunWallClock.forEach((pr, idx) => {
        const pp = `$.timing.perRunWallClock[${idx}]`;
        const prKeys = new Set([
          'runId',
          'timebase',
          'attemptsComplete',
          'intervalCompleteness',
          'hasOverlappingAttempts',
          'mergedActiveWallClockMs',
          'spanWallClockMs',
          'cumulativeAttemptDurationMs',
          'wallClockStatus',
          'unavailableReason',
        ]);
        if (!hasOnlyPlainOwnProperties(pr, prKeys)) {
          addIssue(pp, 'invalid-object', 'Invalid perRunWallClock entry.');
          allPerRunAvailable = false;
          return;
        }
        const expectedDesc = validResolvedRunDescriptors[idx];
        if (
          !isBoundedCleanString(pr.runId) ||
          seenPrRunIds.has(pr.runId) ||
          (expectedDesc && pr.runId !== expectedDesc.runId)
        ) {
          addIssue(`${pp}.runId`, 'invalid-timing-run-reference', 'perRunWallClock runId must match resolvedRuns in order.');
        } else {
          seenPrRunIds.add(pr.runId);
        }
        if (!TIMEBASES.includes(pr.timebase) || (expectedDesc && pr.timebase !== expectedDesc.timebase)) {
          addIssue(`${pp}.timebase`, 'invalid-timing-timebase', 'perRunWallClock timebase must match resolvedRuns.');
        } else {
          derivedTbCounts[pr.timebase] += 1;
        }
        if (typeof pr.attemptsComplete !== 'boolean' || typeof pr.hasOverlappingAttempts !== 'boolean') {
          addIssue(pp, 'invalid-boolean', 'attemptsComplete and hasOverlappingAttempts must be booleans.');
        } else if (pr.attemptsComplete) {
          derivedCompleteRunCount += 1;
        } else {
          derivedIncompleteRunCount += 1;
        }
        if (!['complete', 'partial', 'unavailable'].includes(pr.intervalCompleteness)) {
          addIssue(`${pp}.intervalCompleteness`, 'invalid-enum', 'Invalid intervalCompleteness.');
        }

        if (pr.wallClockStatus === 'available') {
          if (
            !pr.attemptsComplete ||
            pr.intervalCompleteness !== 'complete' ||
            pr.unavailableReason !== null ||
            !isSafeNonNegativeInteger(pr.mergedActiveWallClockMs) ||
            !isSafeNonNegativeInteger(pr.spanWallClockMs) ||
            pr.mergedActiveWallClockMs > pr.spanWallClockMs ||
            (pr.cumulativeAttemptDurationMs !== null &&
              (!isSafeNonNegativeInteger(pr.cumulativeAttemptDurationMs) ||
                pr.cumulativeAttemptDurationMs < pr.mergedActiveWallClockMs))
          ) {
            addIssue(pp, 'invalid-per-run-wall-clock', 'Inconsistent available perRunWallClock entry.');
          }
        } else {
          allPerRunAvailable = false;
          if (
            pr.wallClockStatus !== 'unavailable' ||
            !isBoundedCleanString(pr.unavailableReason) ||
            pr.mergedActiveWallClockMs !== null ||
            pr.spanWallClockMs !== null ||
            pr.cumulativeAttemptDurationMs !== null
          ) {
            addIssue(pp, 'invalid-per-run-wall-clock', 'Inconsistent unavailable perRunWallClock entry.');
          }
        }
      });

      if (
        tbSum !== null &&
        (derivedTbCounts['run-relative'] !== tim.timebaseCounts['run-relative'] ||
          derivedTbCounts.epoch !== tim.timebaseCounts.epoch)
      ) {
        addIssue('$.timing.timebaseCounts', 'timebase-reference-mismatch', 'timebaseCounts disagrees with perRunWallClock.');
      }
      if (
        isSafeNonNegativeInteger(runs?.attemptListCompleteness?.completeRunCount) &&
        (derivedCompleteRunCount !== runs.attemptListCompleteness.completeRunCount ||
          derivedIncompleteRunCount !== runs.attemptListCompleteness.incompleteRunCount)
      ) {
        addIssue('$.timing.perRunWallClock', 'attempt-list-reference-mismatch', 'perRunWallClock attemptsComplete disagrees with runs.attemptListCompleteness.');
      }
    }

    // Calendar time
    const cal = tim.calendarTime;
    const calKeys = new Set([
      'available',
      'completeness',
      'unavailableReason',
      'earliestStartedAtMs',
      'latestEndedAtMs',
      'earliestStartedAtIso',
      'latestEndedAtIso',
    ]);
    if (!hasOnlyPlainOwnProperties(cal, calKeys) || typeof cal.available !== 'boolean') {
      addIssue('$.timing.calendarTime', 'invalid-object', 'Invalid calendarTime object.');
    } else if (cal.available) {
      if (hasRel || noRuns || (atsValid && ats.attemptsWithCompleteIntervalCount === 0)) {
        addIssue('$.timing.calendarTime.available', 'invalid-calendar-claim', 'Calendar time cannot be available with relative runs, 0 runs, or 0 intervals.');
      }
      if (
        cal.completeness === 'complete' &&
        (!expectedHistoryComplete || (atsValid && ats.attemptsWithIncompleteIntervalCount > 0))
      ) {
        addIssue('$.timing.calendarTime.completeness', 'invalid-calendar-completeness', 'Calendar completeness cannot be complete when history or intervals are incomplete.');
      }
      if (
        !['complete', 'partial'].includes(cal.completeness) ||
        cal.unavailableReason !== null ||
        !isDateSafeEpochMs(cal.earliestStartedAtMs) ||
        !isDateSafeEpochMs(cal.latestEndedAtMs) ||
        cal.earliestStartedAtMs > cal.latestEndedAtMs ||
        cal.earliestStartedAtIso !== new Date(cal.earliestStartedAtMs).toISOString() ||
        cal.latestEndedAtIso !== new Date(cal.latestEndedAtMs).toISOString()
      ) {
        addIssue('$.timing.calendarTime', 'invalid-calendar-bounds', 'Calendar bounds or ISO timestamps are invalid.');
      }
    } else {
      if (
        cal.completeness !== 'unavailable' ||
        !isBoundedCleanString(cal.unavailableReason) ||
        cal.earliestStartedAtMs !== null ||
        cal.latestEndedAtMs !== null ||
        cal.earliestStartedAtIso !== null ||
        cal.latestEndedAtIso !== null
      ) {
        addIssue('$.timing.calendarTime', 'invalid-unavailable-calendar', 'Unavailable calendarTime must have null timestamps and a static reason.');
      }
    }

    // Cross-run ordering (must reference exact resolvedRuns runIds)
    const cro = tim.crossRunOrdering;
    if (
      !hasOnlyPlainOwnProperties(cro, new Set(['available', 'unavailableReason', 'orderedRunIds'])) ||
      typeof cro.available !== 'boolean'
    ) {
      addIssue('$.timing.crossRunOrdering', 'invalid-object', 'Invalid crossRunOrdering.');
    } else if (cro.available) {
      const resolvedIdSet = new Set(validResolvedRunDescriptors.map((d) => d.runId));
      const okOrderArr =
        isDensePlainArray(cro.orderedRunIds, ANALYTICS_LIMITS.runs) &&
        cro.orderedRunIds.length === runs?.resolvedRunCount &&
        new Set(cro.orderedRunIds).size === resolvedIdSet.size &&
        cro.orderedRunIds.every((id) => resolvedIdSet.has(id));
      const allStartsRecorded =
        atsValid && ats.startedAtStateCounts.recorded === attempts?.totalAttemptCount;
      const allRunListsComplete = runs?.attemptListCompleteness?.incompleteRunCount === 0;

      if (
        hasRel ||
        noRuns ||
        cro.unavailableReason !== null ||
        !okOrderArr ||
        !allStartsRecorded ||
        !allRunListsComplete
      ) {
        addIssue('$.timing.crossRunOrdering', 'invalid-ordering-claim', 'Invalid available crossRunOrdering or mismatched runId references.');
      }
    } else if (!isBoundedCleanString(cro.unavailableReason) || cro.orderedRunIds !== null) {
      addIssue('$.timing.crossRunOrdering', 'invalid-unavailable-ordering', 'Unavailable crossRunOrdering must have null orderedRunIds and a reason.');
    }

    // Cross-run wall clock
    const crw = tim.crossRunWallClock;
    if (
      !hasOnlyPlainOwnProperties(
        crw,
        new Set([
          'available',
          'unavailableReason',
          'mergedActiveWallClockMs',
          'spanWallClockMs',
          'hasOverlappingAttempts',
        ])
      ) ||
      typeof crw.available !== 'boolean' ||
      typeof crw.hasOverlappingAttempts !== 'boolean'
    ) {
      addIssue('$.timing.crossRunWallClock', 'invalid-object', 'Invalid crossRunWallClock.');
    } else if (crw.available) {
      const spanMatchesCalendar =
        !cal?.available ||
        !isDateSafeEpochMs(cal.earliestStartedAtMs) ||
        !isDateSafeEpochMs(cal.latestEndedAtMs) ||
        crw.spanWallClockMs === cal.latestEndedAtMs - cal.earliestStartedAtMs;
      if (
        hasRel ||
        noRuns ||
        !allPerRunAvailable ||
        (atsValid && ats.attemptsWithIncompleteIntervalCount > 0) ||
        crw.unavailableReason !== null ||
        !isSafeNonNegativeInteger(crw.mergedActiveWallClockMs) ||
        !isSafeNonNegativeInteger(crw.spanWallClockMs) ||
        crw.mergedActiveWallClockMs > crw.spanWallClockMs ||
        !spanMatchesCalendar
      ) {
        addIssue('$.timing.crossRunWallClock', 'invalid-wall-clock', 'Invalid available crossRunWallClock.');
      }
    } else if (
      !isBoundedCleanString(crw.unavailableReason) ||
      crw.mergedActiveWallClockMs !== null ||
      crw.spanWallClockMs !== null
    ) {
      addIssue('$.timing.crossRunWallClock', 'invalid-unavailable-wall-clock', 'Unavailable crossRunWallClock must have null durations and a reason.');
    }

    // Recorded elapsed ms
    const rem = tim.recordedElapsedMs;
    if (
      !hasOnlyPlainOwnProperties(
        rem,
        new Set([
          'isWallClockTime',
          'knownAttemptCount',
          'unknownAttemptCount',
          'overflow',
          'cumulativeKnownElapsedMs',
        ])
      ) ||
      rem.isWallClockTime !== false ||
      !isSafeNonNegativeInteger(rem.knownAttemptCount) ||
      !isSafeNonNegativeInteger(rem.unknownAttemptCount) ||
      rem.knownAttemptCount + rem.unknownAttemptCount !== attempts?.totalAttemptCount ||
      typeof rem.overflow !== 'boolean' ||
      ((rem.overflow || rem.knownAttemptCount === 0) && rem.cumulativeKnownElapsedMs !== null) ||
      (!rem.overflow &&
        rem.knownAttemptCount > 0 &&
        (typeof rem.cumulativeKnownElapsedMs !== 'number' ||
          !Number.isFinite(rem.cumulativeKnownElapsedMs) ||
          rem.cumulativeKnownElapsedMs < 0))
    ) {
      addIssue('$.timing.recordedElapsedMs', 'invalid-object', 'Invalid recordedElapsedMs.');
    }
  }

  // Reconcile top-level ok, failClosed, clean, and status
  if (issues.length === 0) {
    if (summary.status === 'invalid-input') {
      if (summary.ok !== false || summary.failClosed !== true || summary.clean !== false || summary.issues.length === 0) {
        addIssue('$.status', 'status-mismatch', 'invalid-input status requires ok=false, failClosed=true, and non-empty issues.');
      }
    } else {
      if (summary.ok !== true) {
        addIssue('$.ok', 'status-mismatch', 'ok must be true when status is not invalid-input.');
      }
      const hasConflicts =
        ec.malformed > 0 || rec.unresolvedRunCount > 0 || hasContradictoryEvidenceIssue;
      const expectedFailClosed = hasConflicts;
      const expectedClean = !hasConflicts && ec.unavailable === 0;
      if (summary.failClosed !== expectedFailClosed) {
        addIssue('$.failClosed', 'flag-mismatch', 'failClosed disagrees with malformed/unresolved/contradictory counts.');
      }
      if (summary.clean !== expectedClean) {
        addIssue('$.clean', 'flag-mismatch', 'clean disagrees with malformed/unresolved/unavailable counts.');
      }

      let expectedStatus = 'complete';
      if (ec.total === 0) {
        expectedStatus = 'empty';
      } else if (hasConflicts) {
        expectedStatus = 'unresolved-conflicts';
      } else if (
        !expectedHistoryComplete ||
        attempts.outcomes.unknownOutcomeCount > 0 ||
        costs.completeness !== 'complete' ||
        tok.overallCompleteness !== 'complete' ||
        tim.attemptTimestamps.attemptsWithIncompleteIntervalCount > 0
      ) {
        expectedStatus = 'partial';
      }
      if (summary.status !== expectedStatus) {
        addIssue('$.status', 'status-mismatch', `Expected status ${expectedStatus} but found ${summary.status}.`);
      }
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, summary };
}

export {
  ATTEMPT_STATUSES,
  COST_EVIDENCE,
  LIMITS,
  RECEIPT_EXPORT_FORMAT,
  RECEIPT_EXPORT_VERSION,
  RECEIPT_SCHEMA_VERSION,
  TIMEBASES,
  UNAVAILABLE_REASONS,
};