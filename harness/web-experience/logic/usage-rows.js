// What the Usage table may say about one task. Pure, no DOM.
//
// "No attempts" needs evidence: a known attempt count of zero, or a receipt whose reasons say no
// attempt was recorded. A missing or unreadable receipt means the usage is unknown, never none.

const NO_ATTEMPTS = 'no-attempts-recorded';

// task: a list row (attempts may be null over HTTP). entry: its receipt, if read. missing: the
// adapter's record of why it was not read ({reason, status}) or {reason: 'omitted'} past the limit.
export function usageRow(task, entry, missing = null) {
  const reasons = Array.isArray(entry?.envelope?.reasons) ? entry.envelope.reasons.map(reason => reason?.code) : [];
  const fromReceipt = Array.isArray(entry?.envelope?.run?.attempts) ? entry.envelope.run.attempts.length : null;
  const attempts = Number.isSafeInteger(task?.attempts) ? task.attempts : fromReceipt ?? (reasons.includes(NO_ATTEMPTS) ? 0 : null);
  if (entry?.envelope?.available === true) return {kind: 'receipt', attempts};
  if (attempts === 0) return {kind: 'none', attempts, text: 'No attempts', chip: 'None'};
  if (entry) return {kind: 'receipt-unavailable', attempts, text: 'Unavailable', chip: 'No receipt',
    note: 'The workspace could not build a receipt for this task.'};
  if (missing?.reason === 'omitted') return {kind: 'unknown', attempts, text: 'Unknown', chip: 'Not read',
    note: 'Not read: past the receipt read limit. Its usage is unknown, not zero.'};
  if (missing) return {kind: 'unknown', attempts, text: 'Unknown', chip: 'Could not read',
    note: missing.reason === 'removed' ? 'The task was removed while its receipt was being read.'
      : 'Its receipt could not be read' + (missing.status ? ' (HTTP ' + missing.status + ')' : '') + '. Its usage is unknown, not zero.'};
  if (attempts !== null && attempts > 0) return {kind: 'unrecorded', attempts, text: 'Unavailable', chip: 'Not recorded'};
  return {kind: 'unknown', attempts, text: 'Unknown', chip: 'Unknown', note: 'No receipt was read for this task. Its usage is unknown, not zero.'};
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
