// What the Usage table may say about one task. Pure, no DOM.
//
// "No attempts" needs evidence: a known attempt count of zero, or a receipt whose reasons say no
// attempt was recorded. A missing or unreadable receipt means the usage is unknown, never none.
// A version 2 receipt is projected legacy when every attempt leaves both backend and execution
// phase unrecorded. Measured windows and recorded charges stay separate from unknown values.
// Unknown is never reported as zero.

import {describeCost, formatDuration} from '../core/format.js';

const NO_ATTEMPTS = 'no-attempts-recorded';
const COVERAGE_LABEL = {
  current: 'Current v2',
  'projected-legacy': 'Projected legacy',
  unavailable: 'Unavailable',
  none: 'None',
  unknown: 'Unknown',
  unrecorded: 'Not recorded',
};

function plainMessages(entry) {
  const reasons = entry?.envelope?.reasons;
  if (!Array.isArray(reasons)) return [];
  const messages = [];
  for (const reason of reasons) {
    const message = typeof reason?.message === 'string' ? reason.message.trim() : '';
    if (message) messages.push(message);
  }
  return messages;
}

function withUnknownClause(messages) {
  const text = messages.join(' ');
  return /not zero/i.test(text) ? text : text + ' Its usage figures are unknown, not zero.';
}

// current: a version 2 receipt with recorded route or execution evidence.
// projected-legacy: a version 2 receipt whose attempts record neither.
// unavailable: no usable version 2 receipt.
export function receiptKind(entry) {
  const envelope = entry?.envelope;
  if (!envelope || envelope.available !== true || envelope.formatVersion !== 2) return 'unavailable';
  const attempts = envelope.evidence?.attempts;
  const projected = Array.isArray(attempts) && attempts.length > 0 && attempts.every(attempt =>
    attempt?.backend === 'unrecorded' && attempt?.executionPhase === 'unrecorded');
  return projected ? 'projected-legacy' : 'current';
}

function attemptRows(entry, summary) {
  if (summary && summary.ok !== false && Array.isArray(summary.attempts)) return summary.attempts;
  const recorded = entry?.envelope?.run?.attempts;
  return Array.isArray(recorded) ? recorded : [];
}

function recordedWindowMs(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return null;
  let start = Infinity;
  let end = -Infinity;
  for (const attempt of attempts) {
    const began = attempt?.startedAtMs;
    const finished = attempt?.endedAtMs;
    if (typeof began !== 'number' || typeof finished !== 'number' || finished < began) return null;
    if (began < start) start = began;
    if (finished > end) end = finished;
  }
  return end - start;
}

function readableDuration(ms) {
  const text = formatDuration(ms);
  return text === 'Unavailable' ? null : text;
}

function fieldFacts(entry, summary) {
  const windowText = readableDuration(recordedWindowMs(attemptRows(entry, summary)));
  const totalText = summary?.wallTime?.available === true ? readableDuration(summary.wallTime.value) : null;
  const charge = summary?.totalCost?.available === true ? summary.totalCost : null;
  return {windowText, totalText, charge};
}

function chargeView(charge) {
  const unknown = {state: 'unknown', text: 'Unknown, not zero.', label: 'Unknown', kind: 'unavailable'};
  if (!charge) return unknown;
  const described = describeCost({
    amountMicros: charge.value, currency: charge.currency, evidence: charge.evidence, complete: true,
  });
  if (!described || described.kind === 'unavailable' || described.primary === 'Unavailable') return unknown;
  return {state: described.kind === 'estimated' ? 'estimated' : 'reported', text: described.primary,
    label: described.label, kind: described.kind};
}

function timeView(facts) {
  if (facts.totalText) return {state: 'measured', text: 'Measured ' + facts.totalText + '.'};
  if (facts.windowText) return {state: 'recorded', text: 'Measured window ' + facts.windowText + '. Complete total unknown.'};
  return {state: 'unknown', text: 'Unknown, not zero.'};
}

function projectedNote(facts) {
  const parts = ['Route and completion evidence were not recorded.'];
  if (!facts.windowText) parts.push('No execution window was recorded. That unknown is not zero.');
  else if (!facts.totalText) parts.push('The measured window is not an established total.');
  if (!facts.charge) parts.push('A complete charge total is unavailable. The total is unknown, not zero.');
  return parts.join(' ');
}

function currentNote(facts) {
  const parts = [];
  if (!facts.totalText && !facts.windowText) parts.push('No execution window was recorded. That unknown is not zero.');
  else if (!facts.totalText) parts.push('The measured window is not an established total.');
  if (!facts.charge) parts.push('A complete charge total is unavailable. The total is unknown, not zero.');
  return parts.length ? parts.join(' ') : undefined;
}

// task: a list row (attempts may be null over HTTP). entry: its receipt, if read. missing: the
// adapter's record of why it was not read ({reason, status}) or {reason: 'omitted'} past the limit.
// summary: the Run Inspector summary for that receipt. When omitted, entry.summary is used.
export function usageRow(task, entry, missing = null, summary = undefined) {
  const inspector = summary === undefined ? entry?.summary ?? null : summary;
  const reasonCodes = Array.isArray(entry?.envelope?.reasons) ? entry.envelope.reasons.map(reason => reason?.code) : [];
  const fromReceipt = Array.isArray(entry?.envelope?.run?.attempts) ? entry.envelope.run.attempts.length : null;
  const attempts = Number.isSafeInteger(task?.attempts) ? task.attempts : fromReceipt ?? (reasonCodes.includes(NO_ATTEMPTS) ? 0 : null);
  if (entry?.envelope?.available === true) {
    const coverage = receiptKind(entry);
    const facts = fieldFacts(entry, inspector);
    return {kind: 'receipt', attempts, coverage, coverageLabel: COVERAGE_LABEL[coverage] ?? 'Unknown',
      time: timeView(facts), cost: chargeView(facts.charge),
      note: coverage === 'projected-legacy' ? projectedNote(facts) : currentNote(facts)};
  }
  if (attempts === 0) {
    const messages = plainMessages(entry);
    return {kind: 'none', attempts, text: 'No attempts', chip: 'None', coverage: 'none', coverageLabel: 'None',
      note: messages.length ? withUnknownClause(messages) : undefined};
  }
  if (entry) {
    const messages = plainMessages(entry);
    return {kind: 'receipt-unavailable', attempts, text: 'Unknown, not zero.', chip: 'Unavailable',
      coverage: 'unavailable', coverageLabel: 'Unavailable',
      note: messages.length ? withUnknownClause(messages)
        : 'The workspace could not build a receipt for this task. Its usage is unknown, not zero.'};
  }
  if (missing?.reason === 'omitted') return {kind: 'unknown', attempts, text: 'Unknown', chip: 'Not read',
    coverage: 'unknown', coverageLabel: 'Not read',
    note: 'Not read: past the receipt read limit. Its usage is unknown, not zero.'};
  if (missing) return {kind: 'unknown', attempts, text: 'Unknown', chip: 'Could not read',
    coverage: 'unknown', coverageLabel: 'Could not read',
    note: missing.reason === 'removed' ? 'The task was removed while its receipt was being read. Its usage is unknown, not zero.'
      : 'Its receipt could not be read' + (missing.status ? ' (HTTP ' + missing.status + ')' : '') + '. Its usage is unknown, not zero.'};
  if (attempts !== null && attempts > 0) return {kind: 'unrecorded', attempts, text: 'Unavailable', chip: 'Not recorded',
    coverage: 'unrecorded', coverageLabel: 'Not recorded'};
  return {kind: 'unknown', attempts, text: 'Unknown', chip: 'Unknown', coverage: 'unknown', coverageLabel: 'Unknown',
    note: 'No receipt was read for this task. Its usage is unknown, not zero.'};
}

// Counts receipts that were actually read. Unavailable receipts stay out of window and charge totals.
export function receiptCoverage(entries) {
  const counts = {listed: 0, current: 0, projectedLegacy: 0, unavailable: 0,
    measuredWindows: 0, unknownWindows: 0, establishedTotals: 0, availableChargeTotals: 0, unknownChargeTotals: 0};
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    counts.listed += 1;
    const kind = receiptKind(entry);
    if (kind === 'current') counts.current += 1;
    else if (kind === 'projected-legacy') counts.projectedLegacy += 1;
    else counts.unavailable += 1;
    if (kind === 'unavailable') continue;
    const facts = fieldFacts(entry, entry.summary ?? null);
    if (facts.windowText || facts.totalText) counts.measuredWindows += 1;
    else counts.unknownWindows += 1;
    if (facts.totalText) counts.establishedTotals += 1;
    if (chargeView(facts.charge).state !== 'unknown') counts.availableChargeTotals += 1;
    else counts.unknownChargeTotals += 1;
  }
  return counts;
}

// One visible sentence for the three receipt kinds, or null when nothing was read.
export function coverageSummary(counts) {
  if (!counts || !Number.isSafeInteger(counts.listed) || counts.listed < 1) return null;
  return [
    'Receipts in this list: ' + counts.listed + '.',
    'Current version 2: ' + counts.current + '.',
    'Projected legacy: ' + counts.projectedLegacy + '.',
    'Unavailable: ' + counts.unavailable + '.',
    'Measured execution windows: ' + counts.measuredWindows + '.',
    'Unknown execution windows: ' + counts.unknownWindows + '.',
    'Established execution totals: ' + counts.establishedTotals + '.',
    'Available receipt charge totals: ' + counts.availableChargeTotals + '.',
    'Unknown receipt charge totals: ' + counts.unknownChargeTotals + '.',
    'Unavailable receipts are left out of the window and charge counts.',
    'An unknown charge or window is not zero.',
  ].join(' ');
}

// One sentence for the coverage notice, or null when every listed task was read.
export function coverageNotice(data) {
  const unavailable = data?.unavailable?.length ?? 0, omitted = data?.omitted?.length ?? 0;
  if (!unavailable && !omitted) return null;
  const parts = [];
  if (unavailable) parts.push(unavailable + (unavailable === 1 ? ' receipt' : ' receipts') + ' could not be read');
  if (omitted) parts.push(omitted + (omitted === 1 ? ' task was' : ' tasks were') + ' not read, past the limit of ' + data.coverage?.limit);
  return 'Partial coverage: ' + parts.join(', and ') + '. Those tasks show unknown usage, not zero, and are left out of totals and comparisons.';
}
