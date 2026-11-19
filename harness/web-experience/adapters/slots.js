// Integration slots: pure mappers from host or contributor output to the small view models the
// candidate renders. They copy and relabel. They never recompute readiness, acceptance or
// accounting, and they never turn diagnostic output into permission.
//
//   GET /api/tasks/:id/readiness   (harness/connection-host.mjs)   -> readinessView, connectionCard
//   GET /api/tasks/:id/receipt     (harness/receipt-export.mjs)    -> receiptView (display only)
//   Antigravity assessAcceptance   (advisory)                      -> acceptancePanel
//   Run Inspector summarizeRun, compareRuns                        -> receiptSummary, comparisonView
//   Qwen describeCostDifference    (pending delivery)              -> costDifferenceInput
//
// test/compat.test.mjs and test/host-fixtures.test.mjs feed real host and contributor output through these.

const text = (value, fallback = 'Unknown') => typeof value === 'string' && value.trim() ? value : fallback;
const list = value => Array.isArray(value) ? value : [];
const TYPE = {local: 'local', subscription: 'subscription', metered: 'metered'};
const WORDS = {'local-machine': 'This computer', 'remote-provider': 'Remote provider', 'local-loopback': 'Loopback only',
  'remote-endpoint': 'Leaves this computer', disabled: 'Disabled', enabled: 'Enabled', 'not-applicable': 'Not applicable', unknown: 'Unknown'};
const word = value => WORDS[value] ?? text(value);

// A readiness reason as the host returns it: {code, severity, title, explanation, suggestedAction}.
// Older string reasons are kept as the explanation.
export function readinessReason(reason) {
  if (typeof reason === 'string') return {code: null, severity: 'unknown', title: reason, explanation: '', suggestedAction: ''};
  if (!reason || typeof reason !== 'object') return {code: null, severity: 'unknown', title: 'Reason unavailable', explanation: '', suggestedAction: ''};
  return {code: typeof reason.code === 'string' ? reason.code : null, severity: text(reason.severity, 'unknown'),
    title: text(reason.title, text(reason.message, text(reason.text, 'Reason unavailable'))),
    explanation: text(reason.explanation, ''), suggestedAction: text(reason.suggestedAction, '')};
}

// One connection. Accepts a host row {route, previewEligibility, qualification} or a bare
// qualification result. executionAuthorized is always false here: a card is diagnostic evidence,
// whatever the input claims, and only the host's run preflight can start work.
export function connectionCard(input) {
  if (!input || typeof input !== 'object') return null;
  const row = input.qualification && typeof input.qualification === 'object' ? input : {qualification: input};
  const result = row.qualification, destination = result.destinationSummary ?? {}, freshness = result.evidenceFreshness ?? {};
  const preview = row.previewEligibility && typeof row.previewEligibility === 'object'
    ? {eligible: row.previewEligibility.eligible === true, reason: text(row.previewEligibility.reason, 'No reason was given.')} : null;
  return {
    id: text(row.route?.id ?? result.connectionId, 'unknown-connection'), label: text(result.connectionLabel),
    type: TYPE[result.billingSummary?.billingType] ?? 'unknown',
    adapter: text(destination.adapterKind ?? row.route?.engine), backend: text(destination.backendKind ?? row.route?.backend),
    model: {label: text(result.modelLabel)},
    destination: {execution: word(destination.executionLocation), data: word(destination.dataDestination),
      endpoint: destination.endpoint ?? 'Withheld', cloudRouting: word(destination.cloudRouting), note: text(destination.transportNote, '')},
    billing: {type: text(result.billingSummary?.billingType), detail: text(result.billingSummary?.detail, '')},
    quota: {status: text(result.quotaSummary?.status, 'unknown'), label: text(result.quotaSummary?.label), detail: text(result.quotaSummary?.detail, '')},
    facts: {...(result.distinctFacts ?? {})},
    state: ['ready', 'blocked', 'unknown'].includes(result.state) ? result.state : 'unknown',
    reasons: list(result.reasons).map(readinessReason),
    permissions: list(result.permissionSummary).map(item => ({label: text(item.label), granted: text(item.granted, 'unknown'), note: text(item.explanation, '')})),
    freshness: {status: text(freshness.status, 'unknown'), label: freshness.isFresh ? 'Fresh' : text(freshness.status, 'Unknown'),
      explanation: text(freshness.explanation, '')},
    scope: text(result.readinessScope, 'not-ready'), productionEligible: result.productionEligible === true,
    gaps: list(result.productionEligibilityGaps).map(item => text(item, '')), limitations: list(result.limitations).map(item => text(item, '')),
    preview, executionAuthorized: false,
  };
}

// The whole readiness response. Truncation and the host's limitation travel with the cards.
export function readinessView(response) {
  if (!response || typeof response !== 'object') return null;
  const inventory = response.inventory ?? {};
  return {scope: text(response.scope, 'unknown'), taskId: response.taskId ?? null, taskVersion: response.taskVersion ?? null,
    observedAt: response.observedAt ?? null, executionAuthorized: false,
    cards: list(response.connections).map(connectionCard).filter(Boolean),
    inventory: {total: Number.isSafeInteger(inventory.totalRoutes) ? inventory.totalRoutes : null,
      evaluated: Number.isSafeInteger(inventory.evaluatedRoutes) ? inventory.evaluatedRoutes : null,
      limit: Number.isSafeInteger(inventory.limit) ? inventory.limit : null, truncated: inventory.truncated === true},
    diagnostics: list(response.diagnostics?.messages).map(message => text(message?.text, '')).filter(Boolean),
    limitation: text(response.limitation, '')};
}

// Display fields read from a receipt export envelope. The envelope itself is previewed and
// downloaded unchanged; this function never rebuilds it.
export function receiptView(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  const limits = list(envelope.limits).map(item => text(item, ''));
  if (envelope.available === false)
    return {available: false, reasons: list(envelope.reasons).map(reason => ({code: text(reason?.code, 'unknown'), message: text(reason?.message, '')})), limits};
  if (envelope.available !== true || !envelope.run || !envelope.evidence) return null;
  const evidence = envelope.evidence;
  return {available: true, runId: text(envelope.run.runId), inputRevision: text(envelope.run.inputRevision),
    attempts: list(envelope.run.attempts).length, accepted: envelope.run.accepted === true, attemptsComplete: envelope.run.attemptsComplete === true,
    acceptance: text(evidence.acceptance?.state), operatorEdited: evidence.acceptance?.operatorEdited ?? null,
    attemptList: list(evidence.attemptList?.basis).map(item => text(item, '')), timebase: text(evidence.timebase),
    outcomes: list(evidence.attempts).map(item => ({outcomeBasis: text(item?.outcomeBasis), cost: text(item?.cost), usage: text(item?.usage?.evidence)})),
    limits};
}

const GROUPS = {structural: 'structural', executed: 'executed', 'human-review': 'human'};

// Antigravity acceptance assessment -> grouped panel. Advisory: the mapper keeps that flag and never
// converts a satisfied checklist into an accepted task.
export function acceptancePanel(assessment) {
  if (!assessment || typeof assessment !== 'object') return null;
  const groups = {structural: [], executed: [], human: []};
  for (const check of list(assessment.checks)) {
    const group = GROUPS[check.kind];
    if (!group) continue;
    groups[group].push({id: text(check.id), title: text(check.title), state: text(check.state, 'missing'), label: text(check.label),
      category: text(check.category, 'unavailable'), symbol: text(check.symbol, '?'), explanation: text(check.explanation, ''),
      origin: text(check.requiredOrigin, ''), nextSteps: list(check.nextSteps).map(step => text(step, ''))});
  }
  const summary = assessment.summary ?? {};
  return {advisory: true, grantsAuthorization: false, checklistSatisfied: assessment.checklistSatisfied === true,
    revision: assessment.proposal?.revision ?? null,
    summary: {required: summary.required ?? 0, satisfied: summary.satisfied ?? 0, failing: summary.failing ?? 0,
      unresolved: summary.unresolved ?? 0, unavailable: summary.unavailable ?? 0},
    groups, explanation: text(assessment.explanation, ''), reminder: text(assessment.humanReview?.reminder, ''),
    limitations: list(assessment.limitations).map(item => text(item, ''))};
}

// Run Inspector summary -> totals. retryCount is shown as additional attempts: records hold order only.
export function receiptSummary(summary) {
  if (!summary || summary.ok === false) return null;
  const availability = part => part?.available === true
    ? {available: true, value: part.value, reasons: []}
    : {available: false, value: null, reasons: list(part?.reasons).map(reason => text(reason?.message ?? reason, 'Reason unavailable'))};
  const cost = availability(summary.totalCost);
  if (cost.available) Object.assign(cost, {currency: summary.totalCost.currency, evidence: summary.totalCost.evidence});
  return {attemptCount: summary.attemptCount ?? 0, additionalAttempts: summary.retryCount ?? summary.additionalAttempts ?? 0,
    wallTime: availability(summary.wallTime), totalCost: cost};
}

// Run Inspector comparison -> observed differences. Deltas are baseline minus candidate. No saved field.
export function comparisonView(result) {
  if (!result || typeof result !== 'object') return null;
  const reasons = part => list(part?.reasons).map(reason => text(reason?.message ?? reason, 'Reason unavailable'));
  return {comparable: result.comparable === true, reasons: reasons(result),
    time: result.time?.available ? {available: true, deltaMs: result.time.deltaMs} : {available: false, reasons: reasons(result.time)},
    cost: result.cost?.available ? {available: true, deltaMicros: result.cost.deltaMicros, currency: result.cost.currency, evidence: result.cost.evidence}
      : {available: false, reasons: reasons(result.cost)}};
}

// The input Qwen's describeCostDifference accepts (work/qwen-cost-review-20261116). That module is
// under repair, so the candidate renders its own fallback from the same input.
export function costDifferenceInput(view) {
  if (!view?.comparable || !view.cost?.available) return {available: false};
  return {available: true, deltaMicros: view.cost.deltaMicros, currency: view.cost.currency, evidence: view.cost.evidence};
}

export const costSlot = Object.freeze({
  status: 'pending-delivery',
  accepts: '{available, deltaMicros, currency, evidence} returning {available, headline, detail, caveat}',
  fallback: 'core/format.js describeCost and formatSignedMicros',
});
