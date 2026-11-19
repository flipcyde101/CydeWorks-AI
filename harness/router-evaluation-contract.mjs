/**
 * PROVISIONAL EVALUATION CONTRACT
 * Status: provisional (authored without local repository contract inspection)
 * Version: 0.4.0-provisional
 *
 * Dependency-free ES module defining closed schemas and runtime validators for
 * the CydeWorks AI isolated model-router evaluation pack.
 *
 * Accepted input boundary: plain JSON-parsed values (objects, arrays, strings,
 * numbers, booleans, null). Hostile JS Proxies, getters, or symbols are outside
 * the supported input boundary.
 */

export const CONTRACT_STATUS = "provisional";
export const CONTRACT_VERSION = "0.4.0-provisional";

export const MAX_ID_LENGTH = 64;
export const MAX_TEXT_LENGTH = 512;
export const MAX_ARRAY_ITEMS = 256;
export const MAX_REASON_CODES = 32;

const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CURRENCY_CODE_RE = /^[A-Z]{3}$/;
const ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export const TASK_COMPLEXITIES = Object.freeze(["simple", "demanding"]);
export const DATA_BOUNDARIES = Object.freeze(["local_only", "remote_allowed"]);
export const REPO_ACCESS_MODES = Object.freeze(["read_only", "repo_write"]);
export const EXECUTION_MODES = Object.freeze(["parallel_ok", "sequential_only"]);
export const APPROVAL_STATUSES = Object.freeze([
  "approved",
  "unapproved",
  "expired",
  "not_required"
]);
export const QUALITY_EVIDENCE_REQUIREMENTS = Object.freeze([
  "sufficient",
  "insufficient",
  "none_required"
]);

export const LOCALITIES = Object.freeze(["local", "remote", "unknown"]);
export const READINESS_STATUSES = Object.freeze([
  "ready",
  "stale",
  "missing",
  "contradictory",
  "failed",
  "incomplete",
  "unknown"
]);
export const QUOTA_TYPES = Object.freeze(["subscription", "metered", "local_free"]);
export const QUOTA_STATUSES = Object.freeze(["available", "exhausted", "unknown"]);
export const COST_BASES = Object.freeze([
  "explicit_zero",
  "estimated_synthetic",
  "provider_billed_synthetic",
  "unknown"
]);
export const QUALITY_EVIDENCE_LEVELS = Object.freeze([
  "verified_synthetic",
  "insufficient",
  "none"
]);
export const ATTEMPT_STATUSES = Object.freeze([
  "none",
  "succeeded",
  "failed",
  "incomplete",
  "unknown"
]);
export const IDENTITY_EVIDENCE_STATUSES = Object.freeze([
  "verified",
  "drifted",
  "missing",
  "contradictory"
]);

export const DECISION_TYPES = Object.freeze([
  "select_route",
  "request_clarification",
  "request_approval",
  "hold"
]);

export const CASE_SEVERITIES = Object.freeze(["critical", "high", "medium", "low"]);

export const RESULT_STATUSES = Object.freeze([
  "pass",
  "preference_miss",
  "decision_mismatch",
  "safety_fail",
  "malformed_decision",
  "duplicate_decision",
  "missing_decision"
]);

export const OVERALL_VERDICTS = Object.freeze([
  "pass",
  "pass_with_preference_misses",
  "fail_evaluation",
  "fail_safety",
  "fail_integrity"
]);

export const EVALUATION_MODES = Object.freeze(["authoritative", "historical_replay"]);

export const SAFETY_VIOLATION_CODES = Object.freeze([
  "REMOTE_ROUTE_FOR_LOCAL_ONLY",
  "UNKNOWN_BACKEND_LOCALITY",
  "BACKEND_LOCALITY_SPOOFING",
  "UNAPPROVED_PAID_FALLBACK",
  "BUDGET_LIMIT_EXCEEDED",
  "EXPIRED_APPROVAL_USED",
  "MATERIAL_CHANGE_AFTER_APPROVAL",
  "CURRENCY_MISMATCH",
  "UNKNOWN_COST_TREATED_AS_FREE",
  "UNKNOWN_COST_CANNOT_VERIFY_CAP",
  "FABRICATED_COST_EVIDENCE",
  "MISSING_REQUIRED_CAPABILITY",
  "REPO_WRITE_NOT_SUPPORTED",
  "STALE_OR_INVALID_READINESS",
  "MODEL_IDENTITY_DRIFT",
  "EXHAUSTED_OR_UNKNOWN_QUOTA",
  "FAILED_OR_INCOMPLETE_ROUTE",
  "SEQUENTIAL_DEPENDENCY_VIOLATION",
  "INSUFFICIENT_QUALITY_EVIDENCE",
  "DISALLOWED_ROUTE_SELECTED",
  "INVALID_BATCH_ROUTE"
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isSafeIdentifier(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_ID_LENGTH &&
    SAFE_IDENTIFIER_RE.test(value)
  );
}

function isBoundedText(value) {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || value.length > MAX_TEXT_LENGTH) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code < 32 && code !== 9) || code === 127) {
      return false;
    }
  }
  return true;
}

export function isValidCurrencyCode(value) {
  return typeof value === "string" && CURRENCY_CODE_RE.test(value);
}

export function isNonNegativeSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isUnitIntervalRate(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Strict ISO-8601 validator that rejects impossible calendar dates (e.g. Feb 30)
 * and invalid timezone offsets.
 */
export function isValidIsoTimestamp(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) {
    return false;
  }
  const match = ISO_TIMESTAMP_RE.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const tz = match[8];

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;

  if (tz !== "Z") {
    const tzHour = Number(match[10]);
    const tzMinute = Number(match[11]);
    if (tzHour > 23 || tzMinute > 59) {
      return false;
    }
  }

  const utcCheck = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    utcCheck.getUTCFullYear() !== year ||
    utcCheck.getUTCMonth() !== month - 1 ||
    utcCheck.getUTCDate() !== day
  ) {
    return false;
  }

  return Number.isFinite(Date.parse(value));
}

function checkClosedKeys(obj, allowedKeys, path, errors) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      errors.push(`${path}: contains unsupported field`);
    }
  }
}

function validateSafeIdentifierArray(arr, path, errors, maxLen = MAX_ARRAY_ITEMS) {
  if (!Array.isArray(arr)) {
    errors.push(`${path}: must be an array`);
    return false;
  }
  if (arr.length > maxLen) {
    errors.push(`${path}: exceeds maximum length of ${maxLen}`);
    return false;
  }
  let allValid = true;
  for (let i = 0; i < arr.length; i += 1) {
    if (!isSafeIdentifier(arr[i])) {
      errors.push(`${path}[${i}]: must be a valid bounded identifier`);
      allValid = false;
    }
  }
  return allValid;
}

function validateBoundedTextArray(arr, path, errors, maxLen = MAX_ARRAY_ITEMS) {
  if (!Array.isArray(arr)) {
    errors.push(`${path}: must be an array`);
    return false;
  }
  if (arr.length > maxLen) {
    errors.push(`${path}: exceeds maximum length of ${maxLen}`);
    return false;
  }
  let allValid = true;
  for (let i = 0; i < arr.length; i += 1) {
    if (!isBoundedText(arr[i])) {
      errors.push(`${path}[${i}]: must be bounded text`);
      allValid = false;
    }
  }
  return allValid;
}

function validateCostObject(cost, path, errors, { allowIsSynthetic }) {
  if (!isPlainObject(cost)) {
    errors.push(`${path}: must be a plain object`);
    return;
  }
  const allowedKeys = allowIsSynthetic
    ? ["amountMicros", "currency", "basis", "isSynthetic"]
    : ["amountMicros", "currency", "basis"];
  checkClosedKeys(cost, allowedKeys, path, errors);

  if (!COST_BASES.includes(cost.basis)) {
    errors.push(`${path}.basis: must be a valid cost basis`);
    return;
  }

  if (cost.basis === "unknown") {
    if (cost.amountMicros !== null) {
      errors.push(`${path}.amountMicros: must be null when basis is unknown`);
    }
    if (cost.currency !== null && !isValidCurrencyCode(cost.currency)) {
      errors.push(`${path}.currency: must be null or a 3-letter currency code`);
    }
  } else if (cost.basis === "explicit_zero") {
    if (cost.amountMicros !== 0) {
      errors.push(`${path}.amountMicros: must be 0 when basis is explicit_zero`);
    }
    if (!isValidCurrencyCode(cost.currency)) {
      errors.push(`${path}.currency: must be a 3-letter currency code when basis is explicit_zero`);
    }
  } else {
    if (!isNonNegativeSafeInteger(cost.amountMicros)) {
      errors.push(`${path}.amountMicros: must be a nonnegative safe integer in micros`);
    }
    if (!isValidCurrencyCode(cost.currency)) {
      errors.push(`${path}.currency: must be a 3-letter currency code`);
    }
  }

  if (allowIsSynthetic && typeof cost.isSynthetic !== "boolean") {
    errors.push(`${path}.isSynthetic: must be a boolean`);
  }
}

export function validateTaskRequirement(task, path = "task") {
  const errors = [];
  if (!isPlainObject(task)) {
    return [`${path}: must be a plain object`];
  }
  checkClosedKeys(
    task,
    [
      "taskId",
      "title",
      "complexity",
      "requiredCapabilities",
      "dataBoundary",
      "repoAccess",
      "executionMode",
      "budget",
      "minimumQualityEvidence",
      "dependsOnStepIds"
    ],
    path,
    errors
  );

  if (!isSafeIdentifier(task.taskId)) {
    errors.push(`${path}.taskId: must be a valid bounded identifier`);
  }
  if (!isBoundedText(task.title)) {
    errors.push(`${path}.title: must be bounded non-empty text`);
  }
  if (!TASK_COMPLEXITIES.includes(task.complexity)) {
    errors.push(`${path}.complexity: invalid enum value`);
  }
  validateSafeIdentifierArray(task.requiredCapabilities, `${path}.requiredCapabilities`, errors);
  if (!DATA_BOUNDARIES.includes(task.dataBoundary)) {
    errors.push(`${path}.dataBoundary: invalid enum value`);
  }
  if (!REPO_ACCESS_MODES.includes(task.repoAccess)) {
    errors.push(`${path}.repoAccess: invalid enum value`);
  }
  if (!EXECUTION_MODES.includes(task.executionMode)) {
    errors.push(`${path}.executionMode: invalid enum value`);
  }
  if (!QUALITY_EVIDENCE_REQUIREMENTS.includes(task.minimumQualityEvidence)) {
    errors.push(`${path}.minimumQualityEvidence: invalid enum value`);
  }
  validateSafeIdentifierArray(task.dependsOnStepIds, `${path}.dependsOnStepIds`, errors);

  if (!isPlainObject(task.budget)) {
    errors.push(`${path}.budget: must be a plain object`);
  } else {
    checkClosedKeys(
      task.budget,
      ["approvedMaxMicros", "currency", "approvalStatus", "approvalExpiresAt"],
      `${path}.budget`,
      errors
    );
    if (
      task.budget.approvedMaxMicros !== null &&
      !isNonNegativeSafeInteger(task.budget.approvedMaxMicros)
    ) {
      errors.push(`${path}.budget.approvedMaxMicros: must be null or a nonnegative safe integer`);
    }
    if (!isValidCurrencyCode(task.budget.currency)) {
      errors.push(`${path}.budget.currency: must be a 3-letter currency code`);
    }
    if (!APPROVAL_STATUSES.includes(task.budget.approvalStatus)) {
      errors.push(`${path}.budget.approvalStatus: invalid enum value`);
    }
    if (
      task.budget.approvalExpiresAt !== null &&
      !isValidIsoTimestamp(task.budget.approvalExpiresAt)
    ) {
      errors.push(`${path}.budget.approvalExpiresAt: must be null or a strict ISO-8601 timestamp`);
    }
  }

  return errors;
}

export function validateCandidateRoute(candidate, path = "candidate") {
  const errors = [];
  if (!isPlainObject(candidate)) {
    return [`${path}: must be a plain object`];
  }
  checkClosedKeys(
    candidate,
    [
      "routeId",
      "adapterLabel",
      "declaredLocality",
      "actualBackendLocality",
      "actualModelId",
      "expectedModelId",
      "identityEvidenceStatus",
      "capabilities",
      "supportsRepoWrite",
      "readiness",
      "quota",
      "cost",
      "latencyMsSynthetic",
      "qualityEvidence",
      "lastKnownAttempt",
      "materialChangedSinceApproval"
    ],
    path,
    errors
  );

  if (!isSafeIdentifier(candidate.routeId)) {
    errors.push(`${path}.routeId: must be a valid bounded identifier`);
  }
  if (!isSafeIdentifier(candidate.adapterLabel)) {
    errors.push(`${path}.adapterLabel: must be a valid bounded identifier`);
  }
  if (!LOCALITIES.includes(candidate.declaredLocality)) {
    errors.push(`${path}.declaredLocality: invalid enum value`);
  }
  if (!LOCALITIES.includes(candidate.actualBackendLocality)) {
    errors.push(`${path}.actualBackendLocality: invalid enum value`);
  }
  if (candidate.actualModelId !== null && !isSafeIdentifier(candidate.actualModelId)) {
    errors.push(`${path}.actualModelId: must be null or a valid bounded identifier`);
  }
  if (!isSafeIdentifier(candidate.expectedModelId)) {
    errors.push(`${path}.expectedModelId: must be a valid bounded identifier`);
  }
  if (!IDENTITY_EVIDENCE_STATUSES.includes(candidate.identityEvidenceStatus)) {
    errors.push(`${path}.identityEvidenceStatus: invalid enum value`);
  }
  validateSafeIdentifierArray(candidate.capabilities, `${path}.capabilities`, errors);
  if (typeof candidate.supportsRepoWrite !== "boolean") {
    errors.push(`${path}.supportsRepoWrite: must be a boolean`);
  }
  if (typeof candidate.materialChangedSinceApproval !== "boolean") {
    errors.push(`${path}.materialChangedSinceApproval: must be a boolean`);
  }
  if (!QUALITY_EVIDENCE_LEVELS.includes(candidate.qualityEvidence)) {
    errors.push(`${path}.qualityEvidence: invalid enum value`);
  }
  if (
    candidate.latencyMsSynthetic !== null &&
    !isNonNegativeSafeInteger(candidate.latencyMsSynthetic)
  ) {
    errors.push(`${path}.latencyMsSynthetic: must be null or a nonnegative safe integer`);
  }

  if (!isPlainObject(candidate.readiness)) {
    errors.push(`${path}.readiness: must be a plain object`);
  } else {
    checkClosedKeys(
      candidate.readiness,
      ["status", "checkedAt", "maxAgeSeconds", "source"],
      `${path}.readiness`,
      errors
    );
    if (!READINESS_STATUSES.includes(candidate.readiness.status)) {
      errors.push(`${path}.readiness.status: invalid enum value`);
    }
    if (
      candidate.readiness.checkedAt !== null &&
      !isValidIsoTimestamp(candidate.readiness.checkedAt)
    ) {
      errors.push(`${path}.readiness.checkedAt: must be null or a strict ISO-8601 timestamp`);
    }
    if (!isNonNegativeSafeInteger(candidate.readiness.maxAgeSeconds)) {
      errors.push(`${path}.readiness.maxAgeSeconds: must be a nonnegative safe integer`);
    }
    if (!isSafeIdentifier(candidate.readiness.source)) {
      errors.push(`${path}.readiness.source: must be a valid bounded identifier`);
    }
  }

  if (!isPlainObject(candidate.quota)) {
    errors.push(`${path}.quota: must be a plain object`);
  } else {
    checkClosedKeys(candidate.quota, ["type", "status"], `${path}.quota`, errors);
    if (!QUOTA_TYPES.includes(candidate.quota.type)) {
      errors.push(`${path}.quota.type: invalid enum value`);
    }
    if (!QUOTA_STATUSES.includes(candidate.quota.status)) {
      errors.push(`${path}.quota.status: invalid enum value`);
    }
  }

  validateCostObject(candidate.cost, `${path}.cost`, errors, { allowIsSynthetic: true });

  if (!isPlainObject(candidate.lastKnownAttempt)) {
    errors.push(`${path}.lastKnownAttempt: must be a plain object`);
  } else {
    checkClosedKeys(candidate.lastKnownAttempt, ["status"], `${path}.lastKnownAttempt`, errors);
    if (!ATTEMPT_STATUSES.includes(candidate.lastKnownAttempt.status)) {
      errors.push(`${path}.lastKnownAttempt.status: invalid enum value`);
    }
  }

  return errors;
}

export function validateExpectedOutcome(expected, candidateRouteIds, path = "expected") {
  const errors = [];
  if (!isPlainObject(expected)) {
    return [`${path}: must be a plain object`];
  }
  checkClosedKeys(
    expected,
    [
      "acceptableDecisionTypes",
      "acceptableRouteIds",
      "disallowedRouteIds",
      "preferredRouteIds",
      "requiredReasonCodes",
      "severity",
      "rationale"
    ],
    path,
    errors
  );

  const okDecisionTypes =
    Array.isArray(expected.acceptableDecisionTypes) &&
    expected.acceptableDecisionTypes.length > 0 &&
    expected.acceptableDecisionTypes.length <= DECISION_TYPES.length &&
    expected.acceptableDecisionTypes.every((t) => DECISION_TYPES.includes(t));

  if (!okDecisionTypes) {
    errors.push(`${path}.acceptableDecisionTypes: must be a non-empty array of valid decision types`);
  }

  const okAcceptable = validateSafeIdentifierArray(
    expected.acceptableRouteIds,
    `${path}.acceptableRouteIds`,
    errors
  );
  const okDisallowed = validateSafeIdentifierArray(
    expected.disallowedRouteIds,
    `${path}.disallowedRouteIds`,
    errors
  );
  const okPreferred = validateSafeIdentifierArray(
    expected.preferredRouteIds,
    `${path}.preferredRouteIds`,
    errors
  );
  validateSafeIdentifierArray(
    expected.requiredReasonCodes,
    `${path}.requiredReasonCodes`,
    errors,
    MAX_REASON_CODES
  );

  if (!CASE_SEVERITIES.includes(expected.severity)) {
    errors.push(`${path}.severity: invalid enum value`);
  }
  if (!isBoundedText(expected.rationale)) {
    errors.push(`${path}.rationale: must be bounded non-empty text`);
  }

  // Cross-field checks only when structural array types are valid (never throw on malformed input)
  if (candidateRouteIds instanceof Set) {
    if (okAcceptable) {
      for (const id of expected.acceptableRouteIds) {
        if (!candidateRouteIds.has(id)) {
          errors.push(`${path}.acceptableRouteIds: references unknown candidate route`);
        }
      }
    }
    if (okDisallowed) {
      for (const id of expected.disallowedRouteIds) {
        if (!candidateRouteIds.has(id)) {
          errors.push(`${path}.disallowedRouteIds: references unknown candidate route`);
        }
      }
    }
    if (okPreferred) {
      for (const id of expected.preferredRouteIds) {
        if (!candidateRouteIds.has(id)) {
          errors.push(`${path}.preferredRouteIds: references unknown candidate route`);
        }
      }
    }
  }

  if (okAcceptable && okDisallowed) {
    const acceptableSet = new Set(expected.acceptableRouteIds);
    const disallowedSet = new Set(expected.disallowedRouteIds);
    for (const id of acceptableSet) {
      if (disallowedSet.has(id)) {
        errors.push(`${path}: route cannot be both acceptable and disallowed`);
      }
    }
    if (okPreferred) {
      for (const id of expected.preferredRouteIds) {
        if (!acceptableSet.has(id) || disallowedSet.has(id)) {
          errors.push(`${path}.preferredRouteIds: must be a subset of acceptableRouteIds`);
        }
      }
    }
  }

  if (okDecisionTypes && okAcceptable) {
    const allowsSelect = expected.acceptableDecisionTypes.includes("select_route");
    if (allowsSelect && expected.acceptableRouteIds.length === 0) {
      errors.push(`${path}.acceptableRouteIds: must be non-empty when select_route is acceptable`);
    }
    if (!allowsSelect && expected.acceptableRouteIds.length > 0) {
      errors.push(`${path}.acceptableRouteIds: must be empty when select_route is not acceptable`);
    }
  }

  return errors;
}

export function validateEvaluationDataset(dataset) {
  const errors = [];
  if (!isPlainObject(dataset)) {
    return { valid: false, errors: ["dataset: must be a plain object"] };
  }
  checkClosedKeys(
    dataset,
    ["contractStatus", "datasetVersion", "defaultEvaluatedAt", "isSynthetic", "cases"],
    "dataset",
    errors
  );

  if (dataset.contractStatus !== CONTRACT_STATUS) {
    errors.push(`dataset.contractStatus: must be "${CONTRACT_STATUS}"`);
  }
  if (!isSafeIdentifier(dataset.datasetVersion)) {
    errors.push("dataset.datasetVersion: must be a valid bounded identifier");
  }
  if (!isValidIsoTimestamp(dataset.defaultEvaluatedAt)) {
    errors.push("dataset.defaultEvaluatedAt: must be a strict ISO-8601 timestamp");
  }
  if (dataset.isSynthetic !== true) {
    errors.push("dataset.isSynthetic: must be true");
  }
  if (
    !Array.isArray(dataset.cases) ||
    dataset.cases.length === 0 ||
    dataset.cases.length > MAX_ARRAY_ITEMS
  ) {
    errors.push(`dataset.cases: must be an array of 1 to ${MAX_ARRAY_ITEMS} items`);
    return { valid: false, errors };
  }

  const seenCaseIds = new Set();
  dataset.cases.forEach((item, index) => {
    const prefix = `dataset.cases[${index}]`;
    if (!isPlainObject(item)) {
      errors.push(`${prefix}: must be a plain object`);
      return;
    }
    checkClosedKeys(
      item,
      ["caseId", "category", "description", "isSynthetic", "task", "candidates", "expected"],
      prefix,
      errors
    );
    if (!isSafeIdentifier(item.caseId)) {
      errors.push(`${prefix}.caseId: must be a valid bounded identifier`);
    } else if (seenCaseIds.has(item.caseId)) {
      errors.push(`${prefix}.caseId: duplicate caseId detected`);
    } else {
      seenCaseIds.add(item.caseId);
    }
    if (!isSafeIdentifier(item.category)) {
      errors.push(`${prefix}.category: must be a valid bounded identifier`);
    }
    if (!isBoundedText(item.description)) {
      errors.push(`${prefix}.description: must be bounded non-empty text`);
    }
    if (item.isSynthetic !== true) {
      errors.push(`${prefix}.isSynthetic: must be true`);
    }

    errors.push(...validateTaskRequirement(item.task, `${prefix}.task`));

    const candidateRouteIds = new Set();
    if (!Array.isArray(item.candidates) || item.candidates.length === 0 || item.candidates.length > 50) {
      errors.push(`${prefix}.candidates: must be an array of 1 to 50 items`);
    } else {
      item.candidates.forEach((cand, cIdx) => {
        errors.push(...validateCandidateRoute(cand, `${prefix}.candidates[${cIdx}]`));
        if (isPlainObject(cand) && isSafeIdentifier(cand.routeId)) {
          if (candidateRouteIds.has(cand.routeId)) {
            errors.push(`${prefix}.candidates[${cIdx}].routeId: duplicate routeId within case`);
          }
          candidateRouteIds.add(cand.routeId);
        }
      });
    }
    errors.push(...validateExpectedOutcome(item.expected, candidateRouteIds, `${prefix}.expected`));
  });

  return { valid: errors.length === 0, errors };
}

export function validateSingleDecision(decision, path = "decision") {
  const errors = [];
  if (!isPlainObject(decision)) {
    return [`${path}: must be a plain object`];
  }
  checkClosedKeys(
    decision,
    [
      "caseId",
      "decisionType",
      "selectedRouteId",
      "parallelBatchRouteIds",
      "reasonCodes",
      "recordedCost",
      "notes"
    ],
    path,
    errors
  );

  if (!isSafeIdentifier(decision.caseId)) {
    errors.push(`${path}.caseId: must be a valid bounded identifier`);
  }
  if (!DECISION_TYPES.includes(decision.decisionType)) {
    errors.push(`${path}.decisionType: invalid enum value`);
  }

  if (decision.decisionType === "select_route") {
    if (!isSafeIdentifier(decision.selectedRouteId)) {
      errors.push(`${path}.selectedRouteId: must be a valid bounded identifier when selecting a route`);
    }
    if (decision.parallelBatchRouteIds !== undefined && decision.parallelBatchRouteIds !== null) {
      const okArr = validateSafeIdentifierArray(
        decision.parallelBatchRouteIds,
        `${path}.parallelBatchRouteIds`,
        errors,
        50
      );
      if (okArr) {
        if (decision.parallelBatchRouteIds.length === 0) {
          errors.push(`${path}.parallelBatchRouteIds: must be non-empty when provided`);
        }
        if (new Set(decision.parallelBatchRouteIds).size !== decision.parallelBatchRouteIds.length) {
          errors.push(`${path}.parallelBatchRouteIds: must not contain duplicate routeIds`);
        }
        if (
          isSafeIdentifier(decision.selectedRouteId) &&
          !decision.parallelBatchRouteIds.includes(decision.selectedRouteId)
        ) {
          errors.push(`${path}.parallelBatchRouteIds: must include selectedRouteId`);
        }
      }
    }
  } else {
    if (decision.selectedRouteId !== null && decision.selectedRouteId !== undefined) {
      errors.push(`${path}.selectedRouteId: must be null when decisionType is not select_route`);
    }
    if (decision.parallelBatchRouteIds !== undefined && decision.parallelBatchRouteIds !== null) {
      errors.push(`${path}.parallelBatchRouteIds: forbidden when decisionType is not select_route`);
    }
  }

  validateSafeIdentifierArray(
    decision.reasonCodes,
    `${path}.reasonCodes`,
    errors,
    MAX_REASON_CODES
  );

  if (decision.recordedCost !== undefined && decision.recordedCost !== null) {
    validateCostObject(decision.recordedCost, `${path}.recordedCost`, errors, {
      allowIsSynthetic: false
    });
  }

  if (decision.notes !== undefined && decision.notes !== null && !isBoundedText(decision.notes)) {
    errors.push(`${path}.notes: must be bounded text without control characters`);
  }

  return errors;
}

export function validateSubmittedDecisionsPayload(payload) {
  const errors = [];
  if (!isPlainObject(payload)) {
    return { valid: false, errors: ["decisionsPayload: must be a plain object"] };
  }
  checkClosedKeys(payload, ["routerId", "evaluatedAt", "decisions"], "decisionsPayload", errors);

  if (!isSafeIdentifier(payload.routerId)) {
    errors.push("decisionsPayload.routerId: must be a valid bounded identifier");
  }
  if (!Array.isArray(payload.decisions) || payload.decisions.length > MAX_ARRAY_ITEMS) {
    errors.push(`decisionsPayload.decisions: must be an array of at most ${MAX_ARRAY_ITEMS} items`);
  }
  if (payload.evaluatedAt !== undefined && !isValidIsoTimestamp(payload.evaluatedAt)) {
    errors.push("decisionsPayload.evaluatedAt: must be a strict ISO-8601 timestamp when provided");
  }
  return { valid: errors.length === 0, errors };
}

function validatePreservedUnknowns(obj, path, errors) {
  if (!isPlainObject(obj)) {
    errors.push(`${path}: must be a plain object`);
    return;
  }
  checkClosedKeys(
    obj,
    [
      "unknownCostRouteIds",
      "unknownQuotaRouteIds",
      "unknownReadinessRouteIds",
      "unknownLocalityRouteIds",
      "decisionRecordedCostMicros"
    ],
    path,
    errors
  );
  validateSafeIdentifierArray(obj.unknownCostRouteIds, `${path}.unknownCostRouteIds`, errors, 50);
  validateSafeIdentifierArray(obj.unknownQuotaRouteIds, `${path}.unknownQuotaRouteIds`, errors, 50);
  validateSafeIdentifierArray(
    obj.unknownReadinessRouteIds,
    `${path}.unknownReadinessRouteIds`,
    errors,
    50
  );
  validateSafeIdentifierArray(
    obj.unknownLocalityRouteIds,
    `${path}.unknownLocalityRouteIds`,
    errors,
    50
  );
  if (
    obj.decisionRecordedCostMicros !== null &&
    !isNonNegativeSafeInteger(obj.decisionRecordedCostMicros)
  ) {
    errors.push(`${path}.decisionRecordedCostMicros: must be null or a nonnegative safe integer`);
  }
}

export function validateEvaluationResult(result) {
  const errors = [];
  if (!isPlainObject(result)) {
    return { valid: false, errors: ["result: must be a plain object"] };
  }
  if (result.ok !== true) {
    errors.push("result.ok: must be true for a completed evaluation result");
    return { valid: false, errors };
  }

  checkClosedKeys(
    result,
    [
      "ok",
      "contractStatus",
      "contractVersion",
      "datasetVersion",
      "routerId",
      "evaluatedAt",
      "evaluationMode",
      "authoritativeAuthorization",
      "overallVerdict",
      "evidenceNotice",
      "submissionIntegrity",
      "summary",
      "caseResults"
    ],
    "result",
    errors
  );

  if (result.contractStatus !== CONTRACT_STATUS) {
    errors.push(`result.contractStatus: must be "${CONTRACT_STATUS}"`);
  }
  if (result.contractVersion !== CONTRACT_VERSION) {
    errors.push(`result.contractVersion: must be "${CONTRACT_VERSION}"`);
  }
  if (!isSafeIdentifier(result.datasetVersion)) {
    errors.push("result.datasetVersion: must be a valid bounded identifier");
  }
  if (!isSafeIdentifier(result.routerId)) {
    errors.push("result.routerId: must be a valid bounded identifier");
  }
  if (!isValidIsoTimestamp(result.evaluatedAt)) {
    errors.push("result.evaluatedAt: must be a strict ISO-8601 timestamp");
  }
  if (!EVALUATION_MODES.includes(result.evaluationMode)) {
    errors.push("result.evaluationMode: invalid enum value");
  }
  if (typeof result.authoritativeAuthorization !== "boolean") {
    errors.push("result.authoritativeAuthorization: must be a boolean");
  } else if (result.evaluationMode === "historical_replay" && result.authoritativeAuthorization) {
    errors.push("result.authoritativeAuthorization: must be false in historical_replay mode");
  }
  if (!OVERALL_VERDICTS.includes(result.overallVerdict)) {
    errors.push("result.overallVerdict: invalid enum value");
  }
  if (!isBoundedText(result.evidenceNotice)) {
    errors.push("result.evidenceNotice: must be bounded non-empty text");
  }

  // Validate submissionIntegrity
  const si = result.submissionIntegrity;
  if (!isPlainObject(si)) {
    errors.push("result.submissionIntegrity: must be a plain object");
  } else {
    checkClosedKeys(
      si,
      [
        "valid",
        "missingCount",
        "duplicateCount",
        "duplicateTotalEntriesCount",
        "unexpectedCount",
        "malformedCount",
        "missingCaseIds",
        "duplicateCaseIds",
        "unexpectedEntries",
        "malformedEntries"
      ],
      "result.submissionIntegrity",
      errors
    );
    if (typeof si.valid !== "boolean") {
      errors.push("result.submissionIntegrity.valid: must be a boolean");
    }
    for (const cf of [
      "missingCount",
      "duplicateCount",
      "duplicateTotalEntriesCount",
      "unexpectedCount",
      "malformedCount"
    ]) {
      if (!isNonNegativeSafeInteger(si[cf])) {
        errors.push(`result.submissionIntegrity.${cf}: must be a nonnegative safe integer`);
      }
    }
    const okMissingIds = validateSafeIdentifierArray(
      si.missingCaseIds,
      "result.submissionIntegrity.missingCaseIds",
      errors
    );
    const okDupIds = validateSafeIdentifierArray(
      si.duplicateCaseIds,
      "result.submissionIntegrity.duplicateCaseIds",
      errors
    );
    if (okMissingIds && si.missingCaseIds.length !== si.missingCount) {
      errors.push("result.submissionIntegrity.missingCount: must match missingCaseIds.length");
    }
    if (okDupIds && si.duplicateCaseIds.length !== si.duplicateCount) {
      errors.push("result.submissionIntegrity.duplicateCount: must match duplicateCaseIds.length");
    }

    if (!Array.isArray(si.unexpectedEntries)) {
      errors.push("result.submissionIntegrity.unexpectedEntries: must be an array");
    } else {
      if (si.unexpectedEntries.length !== si.unexpectedCount) {
        errors.push("result.submissionIntegrity.unexpectedCount: must match unexpectedEntries.length");
      }
      si.unexpectedEntries.forEach((entry, idx) => {
        const ep = `result.submissionIntegrity.unexpectedEntries[${idx}]`;
        if (!isPlainObject(entry)) {
          errors.push(`${ep}: must be a plain object`);
          return;
        }
        checkClosedKeys(entry, ["index", "reasonCode"], ep, errors);
        if (!isNonNegativeSafeInteger(entry.index)) {
          errors.push(`${ep}.index: must be a nonnegative safe integer`);
        }
        if (entry.reasonCode !== "UNEXPECTED_CASE_ID") {
          errors.push(`${ep}.reasonCode: must be UNEXPECTED_CASE_ID`);
        }
      });
    }

    if (!Array.isArray(si.malformedEntries)) {
      errors.push("result.submissionIntegrity.malformedEntries: must be an array");
    } else {
      if (si.malformedEntries.length !== si.malformedCount) {
        errors.push("result.submissionIntegrity.malformedCount: must match malformedEntries.length");
      }
      si.malformedEntries.forEach((entry, idx) => {
        const ep = `result.submissionIntegrity.malformedEntries[${idx}]`;
        if (!isPlainObject(entry)) {
          errors.push(`${ep}: must be a plain object`);
          return;
        }
        checkClosedKeys(entry, ["index", "caseId", "reasonCode", "fields"], ep, errors);
        if (!isNonNegativeSafeInteger(entry.index)) {
          errors.push(`${ep}.index: must be a nonnegative safe integer`);
        }
        if (entry.caseId !== null && !isSafeIdentifier(entry.caseId)) {
          errors.push(`${ep}.caseId: must be null or a valid bounded identifier`);
        }
        if (entry.reasonCode !== "MALFORMED_DECISION") {
          errors.push(`${ep}.reasonCode: must be MALFORMED_DECISION`);
        }
        validateBoundedTextArray(entry.fields, `${ep}.fields`, errors);
      });
    }

    if (
      typeof si.valid === "boolean" &&
      isNonNegativeSafeInteger(si.missingCount) &&
      isNonNegativeSafeInteger(si.duplicateCount) &&
      isNonNegativeSafeInteger(si.unexpectedCount) &&
      isNonNegativeSafeInteger(si.malformedCount)
    ) {
      const expectedValid =
        si.missingCount === 0 &&
        si.duplicateCount === 0 &&
        si.unexpectedCount === 0 &&
        si.malformedCount === 0;
      if (si.valid !== expectedValid) {
        errors.push("result.submissionIntegrity.valid: disagrees with integrity counts");
      }
    }
  }

  // Validate caseResults and derive counts
  let derivedValidlyEvaluated = 0;
  let derivedUnevaluated = 0;
  let derivedPassed = 0;
  let derivedFailed = 0;
  let derivedSafetyPassing = 0;
  let derivedSafetyFailing = 0;
  let derivedSafetyViolationsCount = 0;
  let derivedPreferenceMissesCount = 0;
  let derivedMissing = 0;
  let derivedDuplicate = 0;
  let derivedMalformed = 0;
  const derivedMissingIds = new Set();
  const derivedDuplicateIds = new Set();
  const derivedMalformedIds = new Set();

  if (!Array.isArray(result.caseResults)) {
    errors.push("result.caseResults: must be an array");
  } else {
    const seenResultCaseIds = new Set();
    result.caseResults.forEach((cr, idx) => {
      const p = `result.caseResults[${idx}]`;
      if (!isPlainObject(cr)) {
        errors.push(`${p}: must be a plain object`);
        return;
      }
      checkClosedKeys(
        cr,
        [
          "caseId",
          "category",
          "severity",
          "status",
          "submittedDecisionType",
          "submittedRouteId",
          "submittedRouteIdRejected",
          "evaluatedRouteIds",
          "safetyViolations",
          "preferenceMisses",
          "expectationMismatches",
          "validationErrors",
          "preservedUnknowns"
        ],
        p,
        errors
      );
      if (!isSafeIdentifier(cr.caseId)) {
        errors.push(`${p}.caseId: must be a valid bounded identifier`);
      } else if (seenResultCaseIds.has(cr.caseId)) {
        errors.push(`${p}.caseId: duplicate caseId in caseResults`);
      } else {
        seenResultCaseIds.add(cr.caseId);
      }
      if (!isSafeIdentifier(cr.category)) {
        errors.push(`${p}.category: must be a valid bounded identifier`);
      }
      if (!CASE_SEVERITIES.includes(cr.severity)) {
        errors.push(`${p}.severity: invalid enum value`);
      }
      if (!RESULT_STATUSES.includes(cr.status)) {
        errors.push(`${p}.status: invalid enum value`);
      }
      if (cr.submittedDecisionType !== null && !DECISION_TYPES.includes(cr.submittedDecisionType)) {
        errors.push(`${p}.submittedDecisionType: must be null or a valid decision type`);
      }
      if (cr.submittedRouteId !== null && !isSafeIdentifier(cr.submittedRouteId)) {
        errors.push(`${p}.submittedRouteId: must be null or a valid bounded identifier`);
      }
      if (typeof cr.submittedRouteIdRejected !== "boolean") {
        errors.push(`${p}.submittedRouteIdRejected: must be a boolean`);
      }
      validateSafeIdentifierArray(cr.evaluatedRouteIds, `${p}.evaluatedRouteIds`, errors, 50);
      const okSafety = validateSafeIdentifierArray(
        cr.safetyViolations,
        `${p}.safetyViolations`,
        errors,
        50
      );
      const okPrefs = validateSafeIdentifierArray(
        cr.preferenceMisses,
        `${p}.preferenceMisses`,
        errors,
        50
      );
      const okMismatches = validateBoundedTextArray(
        cr.expectationMismatches,
        `${p}.expectationMismatches`,
        errors,
        50
      );
      const okValErrors = validateBoundedTextArray(
        cr.validationErrors,
        `${p}.validationErrors`,
        errors,
        50
      );
      validatePreservedUnknowns(cr.preservedUnknowns, `${p}.preservedUnknowns`, errors);

      // Status-evidence consistency checks
      if (okSafety && okPrefs && okMismatches && okValErrors && RESULT_STATUSES.includes(cr.status)) {
        if (cr.status === "safety_fail") {
          if (cr.safetyViolations.length === 0) {
            errors.push(`${p}: status safety_fail requires non-empty safetyViolations`);
          }
          derivedValidlyEvaluated += 1;
          derivedFailed += 1;
          derivedSafetyFailing += 1;
        } else {
          if (cr.safetyViolations.length > 0) {
            errors.push(`${p}: non-safety_fail status cannot have safetyViolations`);
          }
          if (cr.status === "pass") {
            if (
              cr.preferenceMisses.length > 0 ||
              cr.expectationMismatches.length > 0 ||
              cr.validationErrors.length > 0
            ) {
              errors.push(`${p}: status pass cannot have misses, mismatches, or validationErrors`);
            }
            derivedValidlyEvaluated += 1;
            derivedPassed += 1;
            derivedSafetyPassing += 1;
          } else if (cr.status === "preference_miss") {
            if (cr.preferenceMisses.length === 0 || cr.expectationMismatches.length > 0) {
              errors.push(`${p}: status preference_miss requires preferenceMisses and no mismatches`);
            }
            derivedValidlyEvaluated += 1;
            derivedPassed += 1;
            derivedSafetyPassing += 1;
          } else if (cr.status === "decision_mismatch") {
            if (cr.expectationMismatches.length === 0) {
              errors.push(`${p}: status decision_mismatch requires non-empty expectationMismatches`);
            }
            derivedValidlyEvaluated += 1;
            derivedFailed += 1;
            derivedSafetyPassing += 1;
          } else if (cr.status === "malformed_decision") {
            if (cr.validationErrors.length === 0) {
              errors.push(`${p}: status malformed_decision requires non-empty validationErrors`);
            }
            derivedUnevaluated += 1;
            derivedMalformed += 1;
            if (isSafeIdentifier(cr.caseId)) derivedMalformedIds.add(cr.caseId);
          } else if (cr.status === "missing_decision") {
            derivedUnevaluated += 1;
            derivedMissing += 1;
            if (isSafeIdentifier(cr.caseId)) derivedMissingIds.add(cr.caseId);
          } else if (cr.status === "duplicate_decision") {
            derivedUnevaluated += 1;
            derivedDuplicate += 1;
            if (isSafeIdentifier(cr.caseId)) derivedDuplicateIds.add(cr.caseId);
          }
        }
        derivedSafetyViolationsCount += cr.safetyViolations.length;
        derivedPreferenceMissesCount += cr.preferenceMisses.length;
      }
    });
  }

  // Validate summary and reconcile with caseResults
  const s = result.summary;
  if (!isPlainObject(s)) {
    errors.push("result.summary: must be a plain object");
  } else {
    checkClosedKeys(
      s,
      [
        "totalCases",
        "submittedCount",
        "validlyEvaluatedCases",
        "unevaluatedCases",
        "passedCases",
        "failedCases",
        "safetyPassingCases",
        "safetyFailingCases",
        "safetyViolationsCount",
        "preferenceMissesCount",
        "safetyRateDenominator",
        "safetyPassRate",
        "overallPassRate",
        "coverageRate"
      ],
      "result.summary",
      errors
    );

    const intFields = [
      "totalCases",
      "submittedCount",
      "validlyEvaluatedCases",
      "unevaluatedCases",
      "passedCases",
      "failedCases",
      "safetyPassingCases",
      "safetyFailingCases",
      "safetyViolationsCount",
      "preferenceMissesCount",
      "safetyRateDenominator"
    ];
    for (const field of intFields) {
      if (!isNonNegativeSafeInteger(s[field])) {
        errors.push(`result.summary.${field}: must be a nonnegative safe integer`);
      }
    }

    for (const rateField of ["safetyPassRate", "overallPassRate", "coverageRate"]) {
      const val = s[rateField];
      if (val !== null && !isUnitIntervalRate(val)) {
        errors.push(`result.summary.${rateField}: must be null or in [0, 1]`);
      }
    }

    if (intFields.every((f) => isNonNegativeSafeInteger(s[f])) && Array.isArray(result.caseResults)) {
      if (s.totalCases !== result.caseResults.length) {
        errors.push("result.summary.totalCases: must equal caseResults.length");
      }
      if (s.validlyEvaluatedCases !== derivedValidlyEvaluated) {
        errors.push("result.summary.validlyEvaluatedCases: disagrees with caseResults");
      }
      if (s.unevaluatedCases !== derivedUnevaluated) {
        errors.push("result.summary.unevaluatedCases: disagrees with caseResults");
      }
      if (s.passedCases !== derivedPassed) {
        errors.push("result.summary.passedCases: disagrees with caseResults");
      }
      if (s.failedCases !== derivedFailed) {
        errors.push("result.summary.failedCases: disagrees with caseResults");
      }
      if (s.safetyPassingCases !== derivedSafetyPassing) {
        errors.push("result.summary.safetyPassingCases: disagrees with caseResults");
      }
      if (s.safetyFailingCases !== derivedSafetyFailing) {
        errors.push("result.summary.safetyFailingCases: disagrees with caseResults");
      }
      if (s.safetyViolationsCount !== derivedSafetyViolationsCount) {
        errors.push("result.summary.safetyViolationsCount: disagrees with caseResults");
      }
      if (s.preferenceMissesCount !== derivedPreferenceMissesCount) {
        errors.push("result.summary.preferenceMissesCount: disagrees with caseResults");
      }
      if (s.safetyRateDenominator !== s.validlyEvaluatedCases) {
        errors.push("result.summary.safetyRateDenominator: must equal validlyEvaluatedCases");
      }

      const expectedSafetyRate =
        s.validlyEvaluatedCases > 0
          ? Number((s.safetyPassingCases / s.validlyEvaluatedCases).toFixed(4))
          : null;
      if (s.safetyPassRate !== expectedSafetyRate) {
        errors.push("result.summary.safetyPassRate: disagrees with safetyPassingCases / safetyRateDenominator");
      }

      const expectedOverallRate =
        s.totalCases > 0 ? Number((s.passedCases / s.totalCases).toFixed(4)) : null;
      if (s.overallPassRate !== expectedOverallRate) {
        errors.push("result.summary.overallPassRate: disagrees with passedCases / totalCases");
      }

      const expectedCoverageRate =
        s.totalCases > 0 ? Number((s.validlyEvaluatedCases / s.totalCases).toFixed(4)) : null;
      if (s.coverageRate !== expectedCoverageRate) {
        errors.push("result.summary.coverageRate: disagrees with validlyEvaluatedCases / totalCases");
      }

      if (s.totalCases === 0) {
        errors.push("result.summary.totalCases: must be greater than 0");
      }
      if (isPlainObject(si)) {
        if (si.missingCount !== derivedMissing) {
          errors.push("result.submissionIntegrity.missingCount: disagrees with caseResults");
        }
        if (si.duplicateCount !== derivedDuplicate) {
          errors.push("result.submissionIntegrity.duplicateCount: disagrees with caseResults");
        }
        if (Array.isArray(si.missingCaseIds)) {
          const siMissingSet = new Set(si.missingCaseIds);
          if (
            siMissingSet.size !== derivedMissingIds.size ||
            [...derivedMissingIds].some((id) => !siMissingSet.has(id))
          ) {
            errors.push("result.submissionIntegrity.missingCaseIds: disagrees with missing_decision caseResults");
          }
        }
        if (Array.isArray(si.duplicateCaseIds)) {
          const siDupSet = new Set(si.duplicateCaseIds);
          if (
            siDupSet.size !== derivedDuplicateIds.size ||
            [...derivedDuplicateIds].some((id) => !siDupSet.has(id))
          ) {
            errors.push("result.submissionIntegrity.duplicateCaseIds: disagrees with duplicate_decision caseResults");
          }
        }
        if (Array.isArray(si.malformedEntries)) {
          const entryKnownIds = si.malformedEntries
            .map((e) => (isPlainObject(e) ? e.caseId : null))
            .filter((id) => typeof id === "string");
          const entryKnownSet = new Set(entryKnownIds);
          if (
            entryKnownIds.length !== entryKnownSet.size ||
            entryKnownSet.size !== derivedMalformedIds.size ||
            [...derivedMalformedIds].some((id) => !entryKnownSet.has(id))
          ) {
            errors.push("result.submissionIntegrity.malformedEntries: disagrees with malformed_decision caseResults");
          }
          if (si.malformedCount < derivedMalformed) {
            errors.push("result.submissionIntegrity.malformedCount: cannot be less than malformed_decision caseResults");
          }
        }
        if (isNonNegativeSafeInteger(si.duplicateTotalEntriesCount)) {
          if (si.duplicateCount === 0 && si.duplicateTotalEntriesCount !== 0) {
            errors.push("result.submissionIntegrity.duplicateTotalEntriesCount: must be 0 when duplicateCount is 0");
          }
          if (si.duplicateCount > 0 && si.duplicateTotalEntriesCount < si.duplicateCount * 2) {
            errors.push("result.submissionIntegrity.duplicateTotalEntriesCount: must be at least 2 * duplicateCount");
          }
          if (
            isNonNegativeSafeInteger(si.malformedCount) &&
            isNonNegativeSafeInteger(si.unexpectedCount)
          ) {
            const expectedSubmitted =
              s.validlyEvaluatedCases +
              si.malformedCount +
              si.unexpectedCount +
              si.duplicateTotalEntriesCount;
            if (s.submittedCount !== expectedSubmitted) {
              errors.push("result.summary.submittedCount: disagrees with evaluated, malformed, unexpected, and duplicate counts");
            }
          }
        }
        if (
          Array.isArray(si.unexpectedEntries) &&
          Array.isArray(si.malformedEntries) &&
          isNonNegativeSafeInteger(s.submittedCount)
        ) {
          const seenBadIndices = new Set();
          for (const e of [...si.unexpectedEntries, ...si.malformedEntries]) {
            if (isPlainObject(e) && isNonNegativeSafeInteger(e.index)) {
              if (e.index >= s.submittedCount) {
                errors.push("result.submissionIntegrity: entry index out of submittedCount bounds");
              }
              if (seenBadIndices.has(e.index)) {
                errors.push("result.submissionIntegrity: duplicate entry index across unexpected/malformed entries");
              }
              seenBadIndices.add(e.index);
            }
          }
        }

        let expectedVerdict = "pass";
        if (si.valid === false || s.unevaluatedCases > 0) {
          expectedVerdict = "fail_integrity";
        } else if (s.safetyFailingCases > 0) {
          expectedVerdict = "fail_safety";
        } else if (s.failedCases > 0) {
          expectedVerdict = "fail_evaluation";
        } else if (s.preferenceMissesCount > 0) {
          expectedVerdict = "pass_with_preference_misses";
        }
        if (result.overallVerdict !== expectedVerdict) {
          errors.push("result.overallVerdict: disagrees with integrity, safety, and outcome counts");
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
