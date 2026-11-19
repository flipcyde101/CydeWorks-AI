/**
 * accounting.mjs — CydeWorks Run Inspector accounting module.
 *
 * Pure ES module: no I/O, no network, no clock, no randomness, no deps.
 * Used by BOTH accounting.test.mjs and the browser UI (app.mjs).
 *
 * DATA CONTRACT (schemaVersion 1), validated with ordinary JavaScript:
 *
 * Run {
 *   schemaVersion: 1                  // only version 1 is supported
 *   runId: string                     // nonempty (trimmed length > 0)
 *   taskKey: string                   // nonempty
 *   inputRevision: string             // nonempty
 *   accepted: boolean                 // caller assertion, not verified
 *   attemptsComplete: boolean         // caller claims ALL attempts included
 *   attempts: Attempt[]               // may be empty; IDs unique within run
 * }
 *
 * Attempt {
 *   attemptId: string                 // nonempty, unique within its run
 *   provider: string                  // nonempty display string
 *   model: string                     // nonempty display string
 *   status: "running" | "succeeded" | "failed" | "cancelled" | "interrupted"
 *   outcomeKnown: boolean             // caller assertion
 *   startedAtMs: integer | null       // nonnegative safe integer, or null
 *   endedAtMs: integer | null         // nonnegative safe integer, or null
 *   cost: null | Cost                 // null means UNKNOWN, never zero
 * }
 *
 * Cost {
 *   amountMicros: integer             // nonnegative safe integer; 1e6 = 1 unit
 *   currency: string                  // exactly three uppercase ASCII letters
 *   evidence: "provider-billed" | "estimated"
 *   complete: boolean                 // caller assertion
 * }
 *
 * TRUST MODEL: identity, acceptance, completeness and billing evidence are
 * caller-supplied assertions, not independently authenticated facts.
 *
 * INPUT SCOPE: inputs must be ordinary JSON data. Functions, symbols,
 * bigint, non-finite numbers, class instances, getters/setters and cycles
 * are rejected with structured errors. Inputs are never mutated.
 */

export const SCHEMA_VERSION = 1;
export const MICROS_PER_UNIT = 1_000_000;

const STATUSES = new Set(["running", "succeeded", "failed", "cancelled", "interrupted"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const EVIDENCE_TYPES = new Set(["provider-billed", "estimated"]);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export const SAMPLE_CAVEAT =
  "Comparisons use caller-supplied samples only. They are not proof of router " +
  "savings, equivalent quality, independently verified inputs, or future performance.";

export const WINDOW_EXPLANATION =
  "Wall time is latest attempt end minus earliest attempt start. It measures the " +
  "supplied execution window, including gaps between retries, and does not include " +
  "time before the first attempt. Overlapping attempts are not counted twice.";

function issue(path, code, message) {
  return { path, code, message };
}

function invalid(issues) {
  return { ok: false, issues };
}

/**
 * Walks a value using only own enumerable string keys and
 * getOwnPropertyDescriptor (so getters are seen as accessors, never
 * invoked). Returns an array of issues; empty means plain JSON data.
 * A Proxy whose traps lie cannot be fully detected in JS; documented in
 * README.md.
 */
function jsonIssues(value, path, issues, seen) {
  if (value === null) return issues;
  const t = typeof value;
  if (t === "string" || t === "boolean") return issues;
  if (t === "number") {
    if (!Number.isFinite(value)) {
      issues.push(issue(path, "non-finite-number", "Numbers must be finite."));
    }
    return issues;
  }
  if (t !== "object") {
    issues.push(issue(path, "not-json", `Values of type "${t}" are not JSON data.`));
    return issues;
  }
  if (seen.has(value)) {
    issues.push(issue(path, "cycle", "Cyclic structures are not JSON data."));
    return issues;
  }
  seen.add(value);
  const isArray = Array.isArray(value);
  if (!isArray) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      issues.push(issue(path, "not-plain-object", "Only plain objects and arrays are allowed."));
      return issues;
    }
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    issues.push(issue(path, "symbol-keys", "Symbol-keyed properties are not JSON data."));
  }
  for (const key of Object.keys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !("value" in desc)) {
      issues.push(issue(`${path}.${key}`, "accessor", "Getter/setter properties are not JSON data."));
      continue;
    }
    jsonIssues(desc.value, isArray ? `${path}[${key}]` : `${path}.${key}`, issues, seen);
  }
  return issues;
}

function checkNonEmptyString(obj, key, path, issues) {
  const v = obj[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    issues.push(issue(`${path}.${key}`, "invalid-string", `${key} must be a nonempty string.`));
  }
}

function checkBoolean(obj, key, path, issues) {
  if (typeof obj[key] !== "boolean") {
    issues.push(issue(`${path}.${key}`, "invalid-boolean", `${key} must be a boolean.`));
  }
}

function checkTimestamp(obj, key, path, issues) {
  const v = obj[key];
  if (v === null) return;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    issues.push(issue(
      `${path}.${key}`, "invalid-timestamp",
      `${key} must be null or a nonnegative safe integer.`,
    ));
  }
}

function checkCost(cost, path, issues) {
  if (cost === null) return; // null cost = unknown, valid shape
  if (typeof cost !== "object" || Array.isArray(cost)) {
    issues.push(issue(path, "invalid-cost", "cost must be null or a cost object."));
    return;
  }
  const amt = cost.amountMicros;
  if (typeof amt !== "number" || !Number.isSafeInteger(amt) || amt < 0) {
    issues.push(issue(
      `${path}.amountMicros`, "invalid-amount",
      "amountMicros must be a nonnegative safe integer.",
    ));
  }
  if (typeof cost.currency !== "string" || !CURRENCY_PATTERN.test(cost.currency)) {
    issues.push(issue(
      `${path}.currency`, "invalid-currency",
      "currency must be exactly three uppercase ASCII letters.",
    ));
  }
  if (!EVIDENCE_TYPES.has(cost.evidence)) {
    issues.push(issue(
      `${path}.evidence`, "invalid-evidence",
      'evidence must be "provider-billed" or "estimated".',
    ));
  }
  checkBoolean(cost, "complete", path, issues);
}

/**
 * validateRun(run) -> { ok: true, run } | { ok: false, issues: [...] }
 * Never throws for malformed data. Does not mutate the input.
 */
export function validateRun(run) {
  const guard = jsonIssues(run, "$", [], new Set());
  if (guard.length > 0) return invalid(guard);

  if (typeof run !== "object" || run === null || Array.isArray(run)) {
    return invalid([issue("$", "invalid-run", "A run must be a plain object.")]);
  }
  const issues = [];
  if (run.schemaVersion !== SCHEMA_VERSION) {
    issues.push(issue("$.schemaVersion", "unsupported-schema",
      `Unsupported schemaVersion ${JSON.stringify(run.schemaVersion)}; only ${SCHEMA_VERSION} is supported.`));
  }
  checkNonEmptyString(run, "runId", "$", issues);
  checkNonEmptyString(run, "taskKey", "$", issues);
  checkNonEmptyString(run, "inputRevision", "$", issues);
  checkBoolean(run, "accepted", "$", issues);
  checkBoolean(run, "attemptsComplete", "$", issues);

  if (!Array.isArray(run.attempts)) {
    issues.push(issue("$.attempts", "invalid-attempts", "attempts must be an array."));
    return invalid(issues);
  }

  const seenIds = new Set();
  run.attempts.forEach((a, i) => {
    const p = `$.attempts[${i}]`;
    if (typeof a !== "object" || a === null || Array.isArray(a)) {
      issues.push(issue(p, "invalid-attempt", "Each attempt must be a plain object."));
      return;
    }
    checkNonEmptyString(a, "attemptId", p, issues);
    checkNonEmptyString(a, "provider", p, issues);
    checkNonEmptyString(a, "model", p, issues);
    if (!STATUSES.has(a.status)) {
      issues.push(issue(`${p}.status`, "invalid-status",
        'status must be "running", "succeeded", "failed", "cancelled" or "interrupted".'));
    }
    checkBoolean(a, "outcomeKnown", p, issues);
    checkTimestamp(a, "startedAtMs", p, issues);
    checkTimestamp(a, "endedAtMs", p, issues);
    if (typeof a.startedAtMs === "number" && typeof a.endedAtMs === "number"
        && Number.isSafeInteger(a.startedAtMs) && Number.isSafeInteger(a.endedAtMs)
        && a.startedAtMs >= 0 && a.endedAtMs >= 0
        && a.endedAtMs < a.startedAtMs) {
      issues.push(issue(`${p}.endedAtMs`, "end-before-start",
        "endedAtMs must be greater than or equal to startedAtMs."));
    }
    if (a.cost !== undefined) checkCost(a.cost, `${p}.cost`, issues);
    else issues.push(issue(`${p}.cost`, "missing-cost-field",
      "cost must be present (null means unknown)."));

    if (typeof a.attemptId === "string" && a.attemptId.trim().length > 0) {
      if (seenIds.has(a.attemptId)) {
        issues.push(issue(`${p}.attemptId`, "duplicate-attempt-id",
          `Duplicate attemptId ${JSON.stringify(a.attemptId)}; IDs must be unique within a run.`));
      }
      seenIds.add(a.attemptId);
    }
  });

  return issues.length > 0 ? invalid(issues) : { ok: true, run };
}

function unavailable(reasons) {
  return { available: false, value: null, reasons };
}

/**
 * summarizeRun(run): see README.md for the returned shape. Time and cost
 * availability are independent; missing values are never treated as zero.
 */
export function summarizeRun(run) {
  const v = validateRun(run);
  if (!v.ok) return { ok: false, issues: v.issues, caveats: [SAMPLE_CAVEAT] };

  const attempts = run.attempts;
  const views = attempts.map((a) => ({
    attemptId: a.attemptId,
    provider: a.provider,
    model: a.model,
    status: a.status,
    terminal: TERMINAL_STATUSES.has(a.status),
    outcomeKnown: a.outcomeKnown,
    startedAtMs: a.startedAtMs,
    endedAtMs: a.endedAtMs,
    durationMs:
      typeof a.startedAtMs === "number" && typeof a.endedAtMs === "number"
        ? a.endedAtMs - a.startedAtMs
        : null,
    cost: a.cost === null ? null : { ...a.cost },
  }));

  const allTerminalKnown = attempts.every(
    (a) => TERMINAL_STATUSES.has(a.status) && a.outcomeKnown === true,
  );

  /* ---- wall time ---- */
  const timeReasons = [];
  if (!run.attemptsComplete) {
    timeReasons.push("attemptsComplete is false: the caller does not claim all attempts are included.");
  }
  if (attempts.length === 0) {
    timeReasons.push("The run has no attempts.");
  }
  if (!allTerminalKnown) {
    timeReasons.push("Some attempts are non-terminal or have outcomeKnown false.");
  }
  const timestampsOk = attempts.every(
    (a) =>
      typeof a.startedAtMs === "number" && typeof a.endedAtMs === "number" &&
      a.endedAtMs >= a.startedAtMs,
  );
  if (attempts.length > 0 && !timestampsOk) {
    timeReasons.push("Some attempts have missing timestamps or end before start.");
  }
  let wallTime;
  if (timeReasons.length > 0) {
    wallTime = unavailable(timeReasons);
  } else {
    let earliest = Infinity;
    let latest = -Infinity;
    for (const a of attempts) {
      if (a.startedAtMs < earliest) earliest = a.startedAtMs;
      if (a.endedAtMs > latest) latest = a.endedAtMs;
    }
    // latest end - earliest start: overlaps counted once, gaps included.
    wallTime = { available: true, value: latest - earliest, reasons: [] };
  }

  /* ---- total cost ---- */
  const costReasons = [];
  if (!run.attemptsComplete) {
    costReasons.push("attemptsComplete is false: the caller does not claim all attempts are included.");
  }
  if (!allTerminalKnown) {
    costReasons.push("Some attempts are non-terminal or have outcomeKnown false.");
  }
  const costs = [];
  for (const a of attempts) {
    if (a.cost === null) {
      costReasons.push(`Attempt ${JSON.stringify(a.attemptId)} has no cost recorded (unknown, not zero).`);
    } else if (a.cost.complete !== true) {
      costReasons.push(`Attempt ${JSON.stringify(a.attemptId)} has an incomplete cost.`);
    } else {
      costs.push(a.cost);
    }
  }
  const currencies = new Set(costs.map((c) => c.currency));
  const evidences = new Set(costs.map((c) => c.evidence));
  if (currencies.size > 1) {
    costReasons.push("Attempts use different currencies; currencies are never converted.");
  }
  if (evidences.size > 1) {
    costReasons.push("Attempts mix provider-billed amounts with estimates; these are never combined.");
  }
  let totalCost;
  if (costReasons.length > 0) {
    totalCost = unavailable(costReasons);
  } else {
    let sum = 0;
    let overflow = false;
    for (const c of costs) {
      sum += c.amountMicros;
      if (!Number.isSafeInteger(sum)) { overflow = true; break; }
    }
    if (overflow) {
      totalCost = unavailable(["Cost addition exceeds the safe integer range; no imprecise total is reported."]);
    } else {
      const currency = costs.length > 0 ? costs[0].currency : null;
      const evidence = costs.length > 0 ? costs[0].evidence : null;
      totalCost = {
        available: true,
        value: sum, // exact integer micros; empty run sums to 0
        currency,
        evidence,
        estimated: evidence === "estimated",
        reasons: [],
      };
      if (attempts.length === 0) {
        totalCost.note = "No attempts were supplied; the complete total of an empty list is 0.";
      }
    }
  }

  const caveats = [SAMPLE_CAVEAT, WINDOW_EXPLANATION];
  if (totalCost.available && totalCost.estimated) {
    caveats.push('Cost figures are estimates (evidence: "estimated"), not provider-billed charges.');
  }

  return {
    ok: true,
    runId: run.runId,
    taskKey: run.taskKey,
    inputRevision: run.inputRevision,
    accepted: run.accepted,
    attemptsComplete: run.attemptsComplete,
    attemptCount: attempts.length,
    retryCount: Math.max(0, attempts.length - 1),
    uncertainOutcomeCount: views.filter((x) => !x.terminal || !x.outcomeKnown).length,
    attempts: views,
    wallTime,
    totalCost,
    caveats,
  };
}

/**
 * compareRuns(baseline, candidate): deltas are baseline - candidate.
 * Positive means the candidate was faster/cheaper IN THESE SAMPLES.
 * Explicit nulls survive JSON.stringify. Never throws for malformed data.
 */
export function compareRuns(baseline, candidate) {
  const caveats = [SAMPLE_CAVEAT];
  const gateReasons = [];
  const b = summarizeRun(baseline);
  const c = summarizeRun(candidate);
  if (!b.ok) gateReasons.push("Baseline run is invalid: " + b.issues.map((i) => i.message).join(" "));
  if (!c.ok) gateReasons.push("Candidate run is invalid: " + c.issues.map((i) => i.message).join(" "));

  if (b.ok && c.ok) {
    if (b.runId === c.runId) {
      gateReasons.push("Runs must be different (runId values match).");
    }
    if (b.taskKey !== c.taskKey) {
      gateReasons.push("taskKey values differ; runs describe different tasks.");
    }
    if (b.inputRevision !== c.inputRevision) {
      gateReasons.push("inputRevision values differ; runs describe different input revisions.");
    }
    if (!b.accepted || !c.accepted) {
      gateReasons.push("Both runs must be accepted (caller-supplied assertion).");
    }
  }

  const timeUnavailable = (reasons) => ({ available: false, deltaMs: null, reasons });
  const costUnavailable = (reasons) => ({ available: false, deltaMicros: null, reasons });

  if (gateReasons.length > 0) {
    return {
      comparable: false,
      reasons: gateReasons,
      time: timeUnavailable(gateReasons),
      cost: costUnavailable(gateReasons),
      caveats,
    };
  }

  let time;
  if (!b.wallTime.available) {
    time = timeUnavailable(["Baseline wall time unavailable: " + b.wallTime.reasons.join(" ")]);
  } else if (!c.wallTime.available) {
    time = timeUnavailable(["Candidate wall time unavailable: " + c.wallTime.reasons.join(" ")]);
  } else {
    time = { available: true, deltaMs: b.wallTime.value - c.wallTime.value, reasons: [] };
  }

  let cost;
  if (!b.totalCost.available) {
    cost = costUnavailable(["Baseline total cost unavailable: " + b.totalCost.reasons.join(" ")]);
  } else if (!c.totalCost.available) {
    cost = costUnavailable(["Candidate total cost unavailable: " + c.totalCost.reasons.join(" ")]);
  } else if (b.attemptCount === 0 || c.attemptCount === 0) {
    cost = costUnavailable(["A run with no attempts has no currency or evidence to compare."]);
  } else if (b.totalCost.currency !== c.totalCost.currency) {
    cost = costUnavailable([
      `Currency mismatch (${b.totalCost.currency} vs ${c.totalCost.currency}); currencies are never converted.`,
    ]);
  } else if (b.totalCost.evidence !== c.totalCost.evidence) {
    cost = costUnavailable([
      `Evidence mismatch ("${b.totalCost.evidence}" vs "${c.totalCost.evidence}"); billed amounts are never mixed with estimates.`,
    ]);
  } else {
    const delta = b.totalCost.value - c.totalCost.value;
    cost = {
      available: true,
      deltaMicros: delta,
      currency: b.totalCost.currency,
      evidence: b.totalCost.evidence,
      estimated: b.totalCost.estimated,
      reasons: [],
    };
    if (cost.estimated) {
      caveats.push('Compared cost figures are estimates (evidence: "estimated"), not provider-billed charges.');
    }
  }

  return { comparable: true, reasons: [], time, cost, caveats };
}

/**
 * formatMicros(micros) -> exact decimal string of currency units.
 * String math only; no floating-point division, no rounding.
 */
export function formatMicros(micros) {
  if (!Number.isSafeInteger(micros) || micros < 0) {
    throw new TypeError("formatMicros expects a nonnegative safe integer.");
  }
  const digits = String(micros).padStart(7, "0");
  const whole = digits.slice(0, -6);
  const fraction = digits.slice(-6).replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

/** formatSignedMicros keeps the sign and exact magnitude. */
export function formatSignedMicros(micros) {
  if (!Number.isSafeInteger(micros)) {
    throw new TypeError("formatSignedMicros expects a safe integer.");
  }
  return (micros < 0 ? "-" : "") + formatMicros(Math.abs(micros));
}
