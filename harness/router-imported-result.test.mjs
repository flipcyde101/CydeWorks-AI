import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateRouterDecisions } from "./router-evaluator.mjs";
import { validateEvaluationResult } from "./router-evaluation-contract.mjs";

const fixtureUrl = new URL("./test-support/router-evaluation-v04/routing-cases.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8"));
const selectedCase = fixture.cases.find(({ caseId }) => caseId === "CASE-018");
const dataset = { ...fixture, cases: [selectedCase] };

function evaluateMalformedDecision() {
  return evaluateRouterDecisions({
    dataset,
    evaluatedAt: fixture.defaultEvaluatedAt,
    decisionsPayload: {
      routerId: "review-synthetic",
      decisions: [
        {
          caseId: selectedCase.caseId,
          decisionType: "select_route",
          selectedRouteId: selectedCase.expected.acceptableRouteIds[0],
          reasonCodes: 42
        }
      ]
    }
  });
}

test("direct evaluation reports a malformed decision and fails integrity", () => {
  const result = evaluateMalformedDecision();
  assert.equal(result.ok, true);
  assert.equal(result.overallVerdict, "fail_integrity");
  assert.equal(result.submissionIntegrity.valid, false);
  assert.equal(result.submissionIntegrity.malformedCount, 1);
  assert.equal(result.caseResults[0].status, "malformed_decision");
  assert.equal(validateEvaluationResult(result).valid, true);
});

test("imported pass cannot hide a case marked as a malformed decision", () => {
  const imported = JSON.parse(JSON.stringify(evaluateMalformedDecision()));
  imported.overallVerdict = "pass";
  imported.submissionIntegrity.valid = true;
  imported.submissionIntegrity.malformedCount = 0;
  imported.submissionIntegrity.malformedEntries = [];

  assert.equal(imported.caseResults[0].status, "malformed_decision");
  assert.equal(validateEvaluationResult(imported).valid, false);
});

