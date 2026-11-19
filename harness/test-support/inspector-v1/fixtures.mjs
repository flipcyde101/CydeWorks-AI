/**
 * fixtures.mjs — synthetic demonstration runs for CydeWorks Run Inspector.
 * All data is invented. No real providers, accounts, tasks or prices.
 * Timestamps are milliseconds relative to an arbitrary synthetic epoch.
 */

const T = 1_000_000; // arbitrary synthetic start offset (ms)

function cost(amountMicros, currency = "USD", evidence = "estimated", complete = true) {
  return { amountMicros, currency, evidence, complete };
}

function attempt(attemptId, provider, model, status, startedAtMs, endedAtMs, c, outcomeKnown = true) {
  return { attemptId, provider, model, status, outcomeKnown, startedAtMs, endedAtMs, cost: c };
}

function run(runId, overrides, attempts) {
  return {
    schemaVersion: 1,
    runId,
    taskKey: "synthetic-task-1",
    inputRevision: "revision-1",
    accepted: true,
    attemptsComplete: true,
    ...overrides,
    attempts,
  };
}

export const FIXTURE_RUNS = [
  // 1. One successful attempt. Wall time 12000 ms, cost 20000 micros estimated.
  run("run-single-success", {}, [
    attempt("a1", "synthetic-provider-a", "model-alpha", "succeeded", T, T + 12000, cost(20000)),
  ]),

  // 2. Failed attempt followed by success. Cost includes the failed attempt.
  // Wall time 4000..21000 => 17000 ms (contiguous retry).
  run("run-fail-then-success", {}, [
    attempt("a1", "synthetic-provider-a", "model-alpha", "failed", T + 4000, T + 9000, cost(8000)),
    attempt("a2", "synthetic-provider-b", "model-beta", "succeeded", T + 9000, T + 21000, cost(15000)),
  ]),

  // 3. Retry with a gap. Gap 9000..14000 counts in wall time.
  // Wall time 4000..26000 => 22000 ms; summed durations would be only 17000.
  run("run-retry-with-gap", {}, [
    attempt("a1", "synthetic-provider-a", "model-alpha", "failed", T + 4000, T + 9000, cost(8000)),
    attempt("a2", "synthetic-provider-b", "model-beta", "succeeded", T + 14000, T + 26000, cost(15000)),
  ]),

  // 4. Overlapping attempts. Union window 0..15000 => 15000 ms, not 20000.
  run("run-overlap", {}, [
    attempt("a1", "synthetic-provider-a", "model-alpha", "cancelled", T, T + 10000, cost(5000)),
    attempt("a2", "synthetic-provider-b", "model-beta", "succeeded", T + 5000, T + 15000, cost(12000)),
  ]),

  // 5. Running attempt: totals unavailable, per-attempt evidence still shown.
  run("run-running", {}, [
    attempt("a1", "synthetic-provider-a", "model-alpha", "failed", T, T + 3000, cost(4000)),
    attempt("a2", "synthetic-provider-b", "model-beta", "running", T + 3000, null, null, false),
  ]),

  // 6. Interrupted attempt with unknown outcome.
  run("run-interrupted-unknown", {}, [
    attempt("a1", "synthetic-provider-a", "model-alpha", "interrupted", T, T + 7000, null, false),
  ]),

  // 7. Missing cost on one attempt: time available, cost unavailable.
  run("run-missing-cost", {}, [
    attempt("a1", "synthetic-provider-a", "model-alpha", "failed", T, T + 2000, null),
    attempt("a2", "synthetic-provider-b", "model-beta", "succeeded", T + 2000, T + 11000, cost(18000)),
  ]),

  // 8. Zero cost is valid and complete.
  run("run-zero-cost", {}, [
    attempt("a1", "synthetic-provider-c", "model-gamma", "succeeded", T, T + 8000, cost(0, "USD", "provider-billed")),
  ]),

  // 9. Mixed currencies: cost total refused, time still available.
  run("run-mixed-currency", {}, [
    attempt("a1", "synthetic-provider-a", "model-alpha", "failed", T, T + 2000, cost(5000, "USD")),
    attempt("a2", "synthetic-provider-b", "model-beta", "succeeded", T + 2000, T + 12000, cost(9000, "EUR")),
  ]),

  // 10. Mixed estimated and billed costs: cost total refused.
  run("run-mixed-evidence", {}, [
    attempt("a1", "synthetic-provider-a", "model-alpha", "failed", T, T + 2000, cost(5000, "USD", "provider-billed")),
    attempt("a2", "synthetic-provider-b", "model-beta", "succeeded", T + 2000, T + 12000, cost(9000, "USD", "estimated")),
  ]),

  // 11. Incomplete attempt list (caller assertion false): both totals refused.
  run("run-incomplete-list", { attemptsComplete: false }, [
    attempt("a1", "synthetic-provider-b", "model-beta", "succeeded", T, T + 9000, cost(14000)),
  ]),

  // 12. Unaccepted run: visible, but ineligible for comparison.
  run("run-unaccepted", { accepted: false }, [
    attempt("a1", "synthetic-provider-a", "model-alpha", "succeeded", T, T + 10000, cost(16000)),
  ]),

  // 13. Different task: ineligible to compare against synthetic-task-1.
  run("run-other-task", { taskKey: "synthetic-task-2" }, [
    attempt("a1", "synthetic-provider-a", "model-alpha", "succeeded", T, T + 6000, cost(9000)),
  ]),

  // 14. Provider-billed multi-attempt run showing billed retry accounting.
  run("run-billed-retries", {}, [
    attempt("a1", "synthetic-provider-a", "model-alpha", "failed", T, T + 3000, cost(2500, "USD", "provider-billed")),
    attempt("a2", "synthetic-provider-a", "model-alpha", "cancelled", T + 3000, T + 5000, cost(1000, "USD", "provider-billed")),
    attempt("a3", "synthetic-provider-b", "model-beta", "succeeded", T + 5000, T + 14000, cost(11000, "USD", "provider-billed")),
  ]),
];

/** Deep copy via JSON so UI state never aliases the exported fixtures. */
export function freshFixtureRuns() {
  return JSON.parse(JSON.stringify(FIXTURE_RUNS));
}
