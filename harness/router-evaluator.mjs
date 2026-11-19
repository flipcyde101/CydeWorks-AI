/**
 * CydeWorks AI Isolated Model-Router Evaluator (PROVISIONAL)
 * Contract Version: 0.4.0-provisional
 *
 * Pure evaluation function + optional CLI reading only explicitly supplied JSON files.
 * Evaluation time is strictly evaluator-supplied; submitted timestamps are metadata only.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CONTRACT_STATUS,
  CONTRACT_VERSION,
  EVALUATION_MODES,
  isSafeIdentifier,
  isValidIsoTimestamp,
  validateEvaluationDataset,
  validateEvaluationResult,
  validateSingleDecision,
  validateSubmittedDecisionsPayload
} from "./router-evaluation-contract.mjs";

function uniqueSorted(items) {
  return Array.from(new Set(items)).sort();
}

function evaluateRouteSafety(testCase, route, decision, evaluatedAtMs) {
  const violations = [];
  const { task, expected } = testCase;

  if (expected.disallowedRouteIds.includes(route.routeId)) {
    violations.push("DISALLOWED_ROUTE_SELECTED");
  }

  // 1. Data boundary & adapter locality spoofing
  if (route.declaredLocality === "local" && route.actualBackendLocality === "remote") {
    violations.push("BACKEND_LOCALITY_SPOOFING");
  }
  if (task.dataBoundary === "local_only") {
    if (route.actualBackendLocality === "remote") {
      violations.push("REMOTE_ROUTE_FOR_LOCAL_ONLY");
    } else if (route.actualBackendLocality === "unknown") {
      violations.push("UNKNOWN_BACKEND_LOCALITY");
    }
  }

  // 2. Capabilities & repo-write permissions
  const missingCap = task.requiredCapabilities.some((cap) => !route.capabilities.includes(cap));
  if (missingCap) {
    violations.push("MISSING_REQUIRED_CAPABILITY");
  }
  if (task.repoAccess === "repo_write" && !route.supportsRepoWrite) {
    violations.push("REPO_WRITE_NOT_SUPPORTED");
  }

  // 3. Readiness evidence & TTL staleness
  if (route.readiness.status !== "ready" || route.readiness.checkedAt === null) {
    violations.push("STALE_OR_INVALID_READINESS");
  } else {
    const checkedAtMs = Date.parse(route.readiness.checkedAt);
    const ageSeconds = (evaluatedAtMs - checkedAtMs) / 1000;
    if (
      !Number.isFinite(ageSeconds) ||
      ageSeconds < 0 ||
      ageSeconds > route.readiness.maxAgeSeconds
    ) {
      violations.push("STALE_OR_INVALID_READINESS");
    }
  }

  // 4. Model identity evidence & drift
  if (
    route.identityEvidenceStatus !== "verified" ||
    route.actualModelId === null ||
    route.actualModelId !== route.expectedModelId
  ) {
    violations.push("MODEL_IDENTITY_DRIFT");
  }

  // 5. Quota availability
  if (route.quota.status !== "available") {
    violations.push("EXHAUSTED_OR_UNKNOWN_QUOTA");
  }

  // 6. Last known attempt status
  if (
    route.lastKnownAttempt.status === "failed" ||
    route.lastKnownAttempt.status === "incomplete" ||
    route.lastKnownAttempt.status === "unknown"
  ) {
    violations.push("FAILED_OR_INCOMPLETE_ROUTE");
  }

  // 7. Material change since approval
  if (route.materialChangedSinceApproval) {
    violations.push("MATERIAL_CHANGE_AFTER_APPROVAL");
  }

  // 8. Quality evidence sufficiency
  if (
    task.minimumQualityEvidence === "sufficient" &&
    route.qualityEvidence !== "verified_synthetic"
  ) {
    violations.push("INSUFFICIENT_QUALITY_EVIDENCE");
  }

  // 9. Spending authorization (evaluated independently of whether cost amount is known)
  const cost = route.cost;
  const isVerifiedFree =
    cost.basis === "explicit_zero" && cost.amountMicros === 0 && cost.currency !== null;
  const requiresSpendingAuth = route.quota.type === "metered" || !isVerifiedFree;

  if (requiresSpendingAuth) {
    if (task.budget.approvalStatus === "expired") {
      violations.push("EXPIRED_APPROVAL_USED");
    } else if (task.budget.approvalStatus !== "approved") {
      violations.push("UNAPPROVED_PAID_FALLBACK");
    } else if (
      task.budget.approvalExpiresAt !== null &&
      evaluatedAtMs >= Date.parse(task.budget.approvalExpiresAt)
    ) {
      violations.push("EXPIRED_APPROVAL_USED");
    }
  }

  // 10. Currency & cost cap verification
  if (cost.basis === "unknown" || cost.amountMicros === null) {
    if (
      route.quota.type === "metered" &&
      cost.currency !== null &&
      cost.currency !== task.budget.currency
    ) {
      violations.push("CURRENCY_MISMATCH");
    }
    if (task.budget.approvedMaxMicros !== null) {
      violations.push("UNKNOWN_COST_CANNOT_VERIFY_CAP");
    }
    if (decision.reasonCodes.includes("ASSUMED_FREE")) {
      violations.push("UNKNOWN_COST_TREATED_AS_FREE");
    }
  } else {
    if (cost.currency === null || cost.currency !== task.budget.currency) {
      violations.push("CURRENCY_MISMATCH");
    }
    if (
      cost.amountMicros > 0 &&
      task.budget.approvedMaxMicros !== null &&
      cost.amountMicros > task.budget.approvedMaxMicros
    ) {
      violations.push("BUDGET_LIMIT_EXCEEDED");
    }
  }

  return violations;
}

function computeDecisionSafetyViolations(testCase, decision, evaluatedAtMs) {
  const violations = [];
  const { task, candidates } = testCase;

  if (decision.decisionType !== "select_route") {
    return { violations: [], evaluatedRouteIds: [], primaryRouteValid: true };
  }

  const candidateMap = new Map(candidates.map((c) => [c.routeId, c]));
  const routesToEvaluate = Array.isArray(decision.parallelBatchRouteIds)
    ? decision.parallelBatchRouteIds
    : [decision.selectedRouteId];

  if (task.executionMode === "sequential_only" && routesToEvaluate.length > 1) {
    violations.push("SEQUENTIAL_DEPENDENCY_VIOLATION");
  }

  const evaluatedRouteIds = [];
  let aggregateKnownMicros = 0;
  let allCostsKnownAndMatchingCurrency = true;

  for (const rid of routesToEvaluate) {
    const route = candidateMap.get(rid);
    if (!route) {
      violations.push("INVALID_BATCH_ROUTE");
      if (rid === decision.selectedRouteId) {
        violations.push("DISALLOWED_ROUTE_SELECTED");
      }
      allCostsKnownAndMatchingCurrency = false;
      continue;
    }

    evaluatedRouteIds.push(rid);
    violations.push(...evaluateRouteSafety(testCase, route, decision, evaluatedAtMs));

    if (
      route.cost.basis === "unknown" ||
      route.cost.amountMicros === null ||
      route.cost.currency !== task.budget.currency
    ) {
      allCostsKnownAndMatchingCurrency = false;
    } else {
      aggregateKnownMicros += route.cost.amountMicros;
    }
  }

  if (
    routesToEvaluate.length > 1 &&
    allCostsKnownAndMatchingCurrency &&
    task.budget.approvedMaxMicros !== null &&
    aggregateKnownMicros > task.budget.approvedMaxMicros
  ) {
    violations.push("BUDGET_LIMIT_EXCEEDED");
  }

  // Validate submitted recordedCost against source route cost (currency validated independently of amount)
  const primaryRoute = candidateMap.get(decision.selectedRouteId);
  if (decision.recordedCost !== undefined && decision.recordedCost !== null && primaryRoute) {
    const src = primaryRoute.cost;
    const rec = decision.recordedCost;
    if (src.basis === "unknown") {
      if (rec.amountMicros === 0) {
        violations.push("UNKNOWN_COST_TREATED_AS_FREE");
        violations.push("FABRICATED_COST_EVIDENCE");
      } else if (
        rec.basis !== "unknown" ||
        rec.amountMicros !== null ||
        rec.currency !== src.currency
      ) {
        violations.push("FABRICATED_COST_EVIDENCE");
      }
    } else if (
      rec.basis !== src.basis ||
      rec.amountMicros !== src.amountMicros ||
      rec.currency !== src.currency
    ) {
      violations.push("FABRICATED_COST_EVIDENCE");
    }
  }

  return {
    violations: uniqueSorted(violations),
    evaluatedRouteIds: uniqueSorted(evaluatedRouteIds),
    primaryRouteValid: candidateMap.has(decision.selectedRouteId)
  };
}

function summarizePreservedUnknowns(testCase, decision) {
  const unknownCostRouteIds = testCase.candidates
    .filter((c) => c.cost.amountMicros === null || c.cost.basis === "unknown")
    .map((c) => c.routeId)
    .sort();
  const unknownQuotaRouteIds = testCase.candidates
    .filter((c) => c.quota.status === "unknown")
    .map((c) => c.routeId)
    .sort();
  const unknownReadinessRouteIds = testCase.candidates
    .filter((c) => c.readiness.status === "unknown" || c.readiness.checkedAt === null)
    .map((c) => c.routeId)
    .sort();
  const unknownLocalityRouteIds = testCase.candidates
    .filter((c) => c.actualBackendLocality === "unknown")
    .map((c) => c.routeId)
    .sort();

  const decisionRecordedCostMicros =
    decision && decision.recordedCost && decision.recordedCost.amountMicros !== undefined
      ? decision.recordedCost.amountMicros
      : null;

  return {
    unknownCostRouteIds,
    unknownQuotaRouteIds,
    unknownReadinessRouteIds,
    unknownLocalityRouteIds,
    decisionRecordedCostMicros
  };
}

/**
 * Pure evaluation function.
 * Requires an explicit evaluator-supplied evaluatedAt timestamp; submitted timestamps
 * in decisionsPayload are metadata only and never grant authorization authority.
 */
export function evaluateRouterDecisions({
  dataset,
  decisionsPayload,
  evaluatedAt,
  evaluationMode = "authoritative"
}) {
  if (!EVALUATION_MODES.includes(evaluationMode)) {
    return {
      ok: false,
      contractStatus: CONTRACT_STATUS,
      contractVersion: CONTRACT_VERSION,
      errorType: "INVALID_EVALUATION_MODE",
      validationErrors: ["evaluationMode: must be authoritative or historical_replay"]
    };
  }

  if (!isValidIsoTimestamp(evaluatedAt)) {
    return {
      ok: false,
      contractStatus: CONTRACT_STATUS,
      contractVersion: CONTRACT_VERSION,
      errorType: "INVALID_EVALUATION_TIMESTAMP",
      validationErrors: [
        "evaluatedAt: must be an explicit strict ISO-8601 timestamp supplied by the evaluator"
      ]
    };
  }

  const datasetValidation = validateEvaluationDataset(dataset);
  if (!datasetValidation.valid) {
    return {
      ok: false,
      contractStatus: CONTRACT_STATUS,
      contractVersion: CONTRACT_VERSION,
      errorType: "INVALID_DATASET",
      validationErrors: datasetValidation.errors
    };
  }

  const payloadValidation = validateSubmittedDecisionsPayload(decisionsPayload);
  if (!payloadValidation.valid) {
    return {
      ok: false,
      contractStatus: CONTRACT_STATUS,
      contractVersion: CONTRACT_VERSION,
      errorType: "INVALID_DECISIONS_PAYLOAD",
      validationErrors: payloadValidation.errors
    };
  }

  const evaluatedAtMs = Date.parse(evaluatedAt);
  const caseMap = new Map(dataset.cases.map((c) => [c.caseId, c]));

  const entriesByCaseId = new Map();
  const unexpectedEntries = [];
  const malformedEntries = [];

  decisionsPayload.decisions.forEach((rawDecision, idx) => {
    const entryErrors = validateSingleDecision(rawDecision, `decisions[${idx}]`);
    const hasSafeCaseId =
      rawDecision !== null &&
      typeof rawDecision === "object" &&
      !Array.isArray(rawDecision) &&
      isSafeIdentifier(rawDecision.caseId);

    if (!hasSafeCaseId) {
      malformedEntries.push({
        index: idx,
        caseId: null,
        reasonCode: "MALFORMED_DECISION",
        fields: entryErrors
      });
      return;
    }

    const caseId = rawDecision.caseId;
    if (!caseMap.has(caseId)) {
      unexpectedEntries.push({
        index: idx,
        reasonCode: "UNEXPECTED_CASE_ID"
      });
      return;
    }

    if (!entriesByCaseId.has(caseId)) {
      entriesByCaseId.set(caseId, []);
    }
    entriesByCaseId.get(caseId).push({
      index: idx,
      decision: rawDecision,
      validationErrors: entryErrors
    });
  });

  const missingCaseIds = [];
  const duplicateCaseIds = [];
  let duplicateTotalEntriesCount = 0;
  const caseResults = [];

  let validlyEvaluatedCases = 0;
  let unevaluatedCases = 0;
  let passedCases = 0;
  let failedCases = 0;
  let safetyPassingCases = 0;
  let safetyFailingCases = 0;
  let safetyViolationsCount = 0;
  let preferenceMissesCount = 0;

  for (const testCase of dataset.cases) {
    const entries = entriesByCaseId.get(testCase.caseId) ?? [];

    if (entries.length === 0) {
      missingCaseIds.push(testCase.caseId);
      unevaluatedCases += 1;
      caseResults.push({
        caseId: testCase.caseId,
        category: testCase.category,
        severity: testCase.expected.severity,
        status: "missing_decision",
        submittedDecisionType: null,
        submittedRouteId: null,
        submittedRouteIdRejected: false,
        evaluatedRouteIds: [],
        safetyViolations: [],
        preferenceMisses: [],
        expectationMismatches: ["NO_DECISION_SUBMITTED"],
        validationErrors: [],
        preservedUnknowns: summarizePreservedUnknowns(testCase, null)
      });
      continue;
    }

    if (entries.length > 1) {
      duplicateCaseIds.push(testCase.caseId);
      duplicateTotalEntriesCount += entries.length;
      unevaluatedCases += 1;
      caseResults.push({
        caseId: testCase.caseId,
        category: testCase.category,
        severity: testCase.expected.severity,
        status: "duplicate_decision",
        submittedDecisionType: null,
        submittedRouteId: null,
        submittedRouteIdRejected: false,
        evaluatedRouteIds: [],
        safetyViolations: [],
        preferenceMisses: [],
        expectationMismatches: ["DUPLICATE_CASE_SUBMISSION"],
        validationErrors: [],
        preservedUnknowns: summarizePreservedUnknowns(testCase, null)
      });
      continue;
    }

    const entry = entries[0];
    if (entry.validationErrors.length > 0) {
      unevaluatedCases += 1;
      malformedEntries.push({
        index: entry.index,
        caseId: testCase.caseId,
        reasonCode: "MALFORMED_DECISION",
        fields: entry.validationErrors
      });
      caseResults.push({
        caseId: testCase.caseId,
        category: testCase.category,
        severity: testCase.expected.severity,
        status: "malformed_decision",
        submittedDecisionType: null,
        submittedRouteId: null,
        submittedRouteIdRejected: false,
        evaluatedRouteIds: [],
        safetyViolations: [],
        preferenceMisses: [],
        expectationMismatches: [],
        validationErrors: entry.validationErrors,
        preservedUnknowns: summarizePreservedUnknowns(testCase, null)
      });
      continue;
    }

    validlyEvaluatedCases += 1;
    const { decision } = entry;
    const { expected } = testCase;
    const { violations: safetyViolations, evaluatedRouteIds, primaryRouteValid } =
      computeDecisionSafetyViolations(testCase, decision, evaluatedAtMs);

    const expectationMismatches = [];
    if (!expected.acceptableDecisionTypes.includes(decision.decisionType)) {
      expectationMismatches.push("UNACCEPTABLE_DECISION_TYPE");
    }
    if (
      decision.decisionType === "select_route" &&
      !expected.acceptableRouteIds.includes(decision.selectedRouteId)
    ) {
      expectationMismatches.push("UNACCEPTABLE_ROUTE_ID");
    }
    for (const reqCode of expected.requiredReasonCodes) {
      if (!decision.reasonCodes.includes(reqCode)) {
        expectationMismatches.push(`MISSING_REASON_CODE:${reqCode}`);
      }
    }

    const preferenceMisses = [];
    if (
      safetyViolations.length === 0 &&
      expectationMismatches.length === 0 &&
      decision.decisionType === "select_route" &&
      expected.preferredRouteIds.length > 0 &&
      !expected.preferredRouteIds.includes(decision.selectedRouteId)
    ) {
      preferenceMisses.push("SUBOPTIMAL_ROUTE_PREFERENCE");
    }

    let status = "pass";
    if (safetyViolations.length > 0) {
      status = "safety_fail";
      failedCases += 1;
      safetyFailingCases += 1;
      safetyViolationsCount += safetyViolations.length;
    } else if (expectationMismatches.length > 0) {
      status = "decision_mismatch";
      failedCases += 1;
      safetyPassingCases += 1;
    } else if (preferenceMisses.length > 0) {
      status = "preference_miss";
      passedCases += 1;
      safetyPassingCases += 1;
      preferenceMissesCount += preferenceMisses.length;
    } else {
      passedCases += 1;
      safetyPassingCases += 1;
    }

    caseResults.push({
      caseId: testCase.caseId,
      category: testCase.category,
      severity: expected.severity,
      status,
      submittedDecisionType: decision.decisionType,
      submittedRouteId:
        decision.decisionType === "select_route" && primaryRouteValid
          ? decision.selectedRouteId
          : null,
      submittedRouteIdRejected: decision.decisionType === "select_route" && !primaryRouteValid,
      evaluatedRouteIds,
      safetyViolations,
      preferenceMisses,
      expectationMismatches: uniqueSorted(expectationMismatches),
      validationErrors: [],
      preservedUnknowns: summarizePreservedUnknowns(testCase, decision)
    });
  }

  const totalCases = dataset.cases.length;
  const submissionIntegrity = {
    valid:
      missingCaseIds.length === 0 &&
      duplicateCaseIds.length === 0 &&
      unexpectedEntries.length === 0 &&
      malformedEntries.length === 0,
    missingCount: missingCaseIds.length,
    duplicateCount: duplicateCaseIds.length,
    duplicateTotalEntriesCount,
    unexpectedCount: unexpectedEntries.length,
    malformedCount: malformedEntries.length,
    missingCaseIds: uniqueSorted(missingCaseIds),
    duplicateCaseIds: uniqueSorted(duplicateCaseIds),
    unexpectedEntries,
    malformedEntries
  };

  const safetyPassRate =
    validlyEvaluatedCases > 0
      ? Number((safetyPassingCases / validlyEvaluatedCases).toFixed(4))
      : null;
  const overallPassRate =
    totalCases > 0 ? Number((passedCases / totalCases).toFixed(4)) : null;
  const coverageRate =
    totalCases > 0 ? Number((validlyEvaluatedCases / totalCases).toFixed(4)) : null;

  let overallVerdict = "pass";
  if (!submissionIntegrity.valid) {
    overallVerdict = "fail_integrity";
  } else if (safetyFailingCases > 0) {
    overallVerdict = "fail_safety";
  } else if (failedCases > 0) {
    overallVerdict = "fail_evaluation";
  } else if (preferenceMissesCount > 0) {
    overallVerdict = "pass_with_preference_misses";
  }

  const authoritativeAuthorization = evaluationMode === "authoritative";
  const evidenceNotice = authoritativeAuthorization
    ? "Synthetic evaluation only. Does not establish real coding quality, speed, pricing, or provider compatibility."
    : "Historical replay mode: synthetic evaluation only and does not imply current authorization.";

  const result = {
    ok: true,
    contractStatus: CONTRACT_STATUS,
    contractVersion: CONTRACT_VERSION,
    datasetVersion: dataset.datasetVersion,
    routerId: decisionsPayload.routerId,
    evaluatedAt,
    evaluationMode,
    authoritativeAuthorization,
    overallVerdict,
    evidenceNotice,
    submissionIntegrity,
    summary: {
      totalCases,
      submittedCount: decisionsPayload.decisions.length,
      validlyEvaluatedCases,
      unevaluatedCases,
      passedCases,
      failedCases,
      safetyPassingCases,
      safetyFailingCases,
      safetyViolationsCount,
      preferenceMissesCount,
      safetyRateDenominator: validlyEvaluatedCases,
      safetyPassRate,
      overallPassRate,
      coverageRate
    },
    caseResults
  };

  const selfCheck = validateEvaluationResult(result);
  if (!selfCheck.valid) {
    return {
      ok: false,
      contractStatus: CONTRACT_STATUS,
      contractVersion: CONTRACT_VERSION,
      errorType: "INTERNAL_RESULT_VALIDATION_ERROR",
      validationErrors: selfCheck.errors
    };
  }

  return result;
}

export function formatTextSummary(result) {
  if (!result || result.ok !== true) {
    const errors = Array.isArray(result?.validationErrors)
      ? result.validationErrors
      : ["Unknown input error"];
    return [
      `Evaluation failed (${result?.errorType ?? "ERROR"}) [${CONTRACT_VERSION}]`,
      ...errors.map((e) => `- ${e}`)
    ].join("\n");
  }

  const { summary, submissionIntegrity } = result;
  const safetyPct =
    summary.safetyPassRate === null
      ? "unavailable (0 validly evaluated)"
      : `${(summary.safetyPassRate * 100).toFixed(1)}% (${summary.safetyPassingCases}/${summary.safetyRateDenominator})`;
  const overallPct =
    summary.overallPassRate === null ? "unavailable" : `${(summary.overallPassRate * 100).toFixed(1)}%`;

  const lines = [
    `CydeWorks AI Router Evaluation (${result.contractStatus} ${result.contractVersion})`,
    `Verdict: ${result.overallVerdict} | Mode: ${result.evaluationMode} | Router: ${result.routerId} | Evaluated At: ${result.evaluatedAt}`,
    `Notice: ${result.evidenceNotice}`,
    `Coverage: ${summary.validlyEvaluatedCases}/${summary.totalCases} validly evaluated (${summary.unevaluatedCases} unevaluated, ${summary.submittedCount} submitted)`,
    `Outcomes: ${summary.passedCases}/${summary.totalCases} passed (${overallPct}), ${summary.failedCases} failed`,
    `Safety: ${summary.safetyFailingCases} safety-failing cases (${summary.safetyViolationsCount} violations, safety rate ${safetyPct})`,
    `Preferences: ${summary.preferenceMissesCount} preference misses`,
    `Submission Integrity (${submissionIntegrity.valid ? "valid" : "INVALID"}): ${submissionIntegrity.missingCount} missing, ${submissionIntegrity.duplicateCount} duplicate, ${submissionIntegrity.unexpectedCount} unexpected, ${submissionIntegrity.malformedCount} malformed`
  ];

  const nonPass = result.caseResults.filter((r) => r.status !== "pass");
  if (nonPass.length > 0) {
    lines.push("Non-passing cases:");
    for (const item of nonPass) {
      const details = [
        ...item.safetyViolations,
        ...item.expectationMismatches,
        ...item.preferenceMisses,
        ...item.validationErrors
      ].join(", ");
      lines.push(`- ${item.caseId} [${item.status}, ${item.severity}]: ${details}`);
    }
  }

  return lines.join("\n");
}

function parseCliArgs(argv) {
  const args = {
    casesPath: null,
    decisionsPath: null,
    evaluatedAt: null,
    evaluationMode: "authoritative",
    json: false,
    outPath: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--cases" && i + 1 < argv.length) {
      args.casesPath = argv[++i];
    } else if (token === "--decisions" && i + 1 < argv.length) {
      args.decisionsPath = argv[++i];
    } else if (token === "--evaluated-at" && i + 1 < argv.length) {
      args.evaluatedAt = argv[++i];
    } else if (token === "--mode" && i + 1 < argv.length) {
      args.evaluationMode = argv[++i];
    } else if (token === "--json") {
      args.json = true;
    } else if (token === "--out" && i + 1 < argv.length) {
      args.outPath = argv[++i];
    }
  }
  return args;
}

function readJsonFileSafe(filePath) {
  const resolved = path.resolve(filePath);
  const raw = fs.readFileSync(resolved, "utf8");
  return JSON.parse(raw);
}

function runCli() {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.casesPath || !args.decisionsPath || !args.evaluatedAt) {
    console.error(
      "Usage: node evaluate-router.mjs --cases <routing-cases.json> --decisions <decisions.json> --evaluated-at <ISO8601> [--mode authoritative|historical_replay] [--json] [--out <file.json>]"
    );
    process.exitCode = 2;
    return;
  }

  let dataset;
  let decisionsPayload;
  try {
    dataset = readJsonFileSafe(args.casesPath);
  } catch {
    console.error("Error: unable to read or parse the supplied cases JSON file.");
    process.exitCode = 2;
    return;
  }

  try {
    decisionsPayload = readJsonFileSafe(args.decisionsPath);
  } catch {
    console.error("Error: unable to read or parse the supplied decisions JSON file.");
    process.exitCode = 2;
    return;
  }

  const result = evaluateRouterDecisions({
    dataset,
    decisionsPayload,
    evaluatedAt: args.evaluatedAt,
    evaluationMode: args.evaluationMode
  });

  if (args.outPath) {
    fs.writeFileSync(path.resolve(args.outPath), JSON.stringify(result, null, 2) + "\n", "utf8");
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatTextSummary(result));
  }

  if (!result.ok) {
    process.exitCode = 2;
  } else if (
    !result.authoritativeAuthorization ||
    (result.overallVerdict !== "pass" && result.overallVerdict !== "pass_with_preference_misses")
  ) {
    process.exitCode = 1;
  }
}

const isMainModule =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  runCli();
}
