// What the Usage table can report from its task list and receipts. Pure, no DOM.
import {describeCost, formatCount, formatDuration} from '../core/format.js';
import {receiptSummary} from '../adapters/slots.js';

const NO_ATTEMPTS = 'no-attempts-recorded';
const UNAVAILABLE_COPY = {
  'task-record-invalid': 'The saved task record could not be read.',
  'task-id-missing': 'The saved task has no usable identifier.',
  'input-identity-missing': 'The saved instructions or source are incomplete.',
  'input-unicode-invalid': 'The saved instructions or source contain invalid text.',
  'source-hash-mismatch': 'The saved source does not match its recorded fingerprint.',
  'attempt-records-missing': 'The saved attempt history is missing.',
  'attempt-limit-exceeded': 'The task has too many recorded attempts for one receipt.',
  'attempt-record-invalid': 'An attempt record is incomplete, invalid or duplicated.',
  'attempt-status-unrecognized': 'An attempt has an unrecognized status.',
  'approved-input-unrecorded': 'An attempt has no usable record of the approved input.',
  'approved-input-mismatch': 'The saved instructions, source or execution settings do not match the recorded approval.',
  'charge-input-invalid': 'The supplied charge list could not be read.',
  'contract-violation': 'The saved task could not be represented in the receipt format.',
};

function unavailableCostNote(attempts, commonReason) {
  const charges = attempts.map(attempt => attempt.cost);
  const chargeReason = charges.includes(null) ? 'A charge is missing for at least one attempt.'
    : charges.some(charge => !charge.complete) ? 'At least one recorded charge is incomplete.' : null;
  if (chargeReason || commonReason) return [chargeReason, commonReason].filter(Boolean).join(' ');
  if (charges.some(charge => charge.currency !== charges[0].currency)) return 'The charges use different currencies.';
  if (charges.some(charge => charge.evidence !== charges[0].evidence)) return 'The charges mix estimates and provider-reported amounts.';
  return 'The total could not be calculated precisely.';
}

function receiptFields(envelope, summary) {
  const {run, evidence} = envelope;
  const commonReason = run.attemptsComplete !== true ? 'The full attempt history could not be confirmed.'
    : run.attempts.some(attempt => attempt.status === 'running') ? 'An attempt is still running.'
    : run.attempts.some(attempt => attempt.outcomeKnown !== true) ? 'The record does not confirm how every attempt ended.' : null;
  const time = summary.wallTime.available ? formatDuration(summary.wallTime.value) : 'Unavailable';
  const timeNote = summary.wallTime.available ? null : commonReason ?? 'The receipt lacks usable start or end times.';
  const elapsed = run.attempts.length === 1 ? evidence?.attempts?.[0]?.recordedElapsedMs : null;
  const attemptTime = !summary.wallTime.available && Number.isFinite(elapsed) && elapsed >= 0 ? formatDuration(elapsed) : null;
  const total = summary.totalCost;
  const cost = describeCost(total.available
    ? {amountMicros: total.value, currency: total.currency, evidence: total.evidence, complete: true} : null);
  const costNote = cost.kind === 'unavailable' ? unavailableCostNote(run.attempts, commonReason) : null;
  return {time, timeNote, attemptTime, cost, costNote};
}

export function usageRow(task, entry, missing = null) {
  const envelope = entry?.envelope;
  const listed = Number.isSafeInteger(task?.attempts) && task.attempts >= 0 ? task.attempts : null;
  const reasons = Array.isArray(envelope?.reasons) ? [...new Set(envelope.reasons.map(reason => reason?.code))] : [];
  const summary = receiptSummary(entry?.summary);
  if (envelope?.available === true && summary && Array.isArray(envelope.run?.attempts) && envelope.run.attempts.length) {
    return {kind: 'receipt', attempts: envelope.run.attempts.length, fields: receiptFields(envelope, summary)};
  }
  if ((envelope?.available === false && reasons.length === 1 && reasons[0] === NO_ATTEMPTS && (listed === null || listed === 0))
    || (!entry && !missing && listed === 0)) {
    return {kind: 'none', attempts: 0, text: 'No attempts', chip: 'None'};
  }
  const attempts = listed === 0 ? null : listed;
  if (entry) {
    const notes = reasons.filter(code => Object.hasOwn(UNAVAILABLE_COPY, code)).map(code => UNAVAILABLE_COPY[code]);
    return {kind: 'receipt-unavailable', attempts, text: 'Unavailable', chip: 'Receipt unavailable',
      note: notes.join(' ') || 'The saved receipt could not be verified.'};
  }
  if (missing?.reason === 'omitted') return {kind: 'not-read', attempts, text: 'Unknown', chip: 'Not read',
    note: 'This task is past the receipt read limit.'};
  if (missing) return {kind: 'unknown', attempts, text: 'Unknown', chip: 'Could not read',
    note: missing.reason === 'removed' ? 'The task was removed while its receipt was being read.'
      : 'Its receipt could not be read' + (missing.status ? ' (HTTP ' + missing.status + ')' : '') + '.'};
  return {kind: 'not-read', attempts, text: 'Unknown', chip: 'Not read', note: 'No receipt was read for this task.'};
}

// Count the rows shown by this table. Workspace analytics runs a separate receipt check.
export function usageCoverage(rows) {
  const counts = {receipt: 0, none: 0, 'receipt-unavailable': 0, unknown: 0, 'not-read': 0};
  for (const row of rows) counts[row.kind]++;
  const partial = counts.receipt + counts.none < rows.length;
  const parts = [
    [counts.receipt, counts.receipt === 1 ? 'usable receipt' : 'usable receipts'],
    [counts.none, 'with no attempts'],
    [counts['receipt-unavailable'], 'with an unavailable receipt'],
    [counts.unknown, 'with a receipt read failure'],
    [counts['not-read'], counts['not-read'] === 1 ? 'whose receipt was not read' : 'whose receipts were not read'],
  ].filter(([count]) => count > 0).map(([count, label]) => formatCount(count) + ' ' + label);
  return {partial, text: rows.length ? formatCount(rows.length) + (rows.length === 1 ? ' task listed. ' : ' tasks listed. ')
    + parts.join(', ') + '.' : null};
}
