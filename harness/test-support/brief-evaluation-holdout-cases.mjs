// Fresh synthetic holdout cases (not drawn from the tracked B01..B20 suite).

export const SYNTHETIC_HOLDOUT_CASE_IDS = Object.freeze(['H01', 'H02', 'H03', 'H04', 'H05']);

export const SYNTHETIC_HOLDOUT_SUITE_LABEL = 'synthetic-holdout';

/** @type {Readonly<Record<string, {
 *   caseId: string,
 *   suiteLabel: string,
 *   title: string,
 *   taskText: string,
 *   sourceText: string,
 *   lookFor: readonly string[],
 *   flags: readonly string[],
 * }>>} */
export const SYNTHETIC_HOLDOUT_CASES = Object.freeze({
  H01: {
    caseId: 'H01',
    suiteLabel: SYNTHETIC_HOLDOUT_SUITE_LABEL,
    title: 'Catering headcount',
    taskText: 'Recommend whether to confirm the lunch order.',
    sourceText:
      '[1] RSVP count is 31. Vendor minimum is 35 plates with 48-hour notice.\n\n' +
      '[2] Two organizers can bring 3 guests each if registered by noon Friday.\n\n' +
      '[3] No deposit has been paid. Pat will call the vendor after final RSVPs.',
    lookFor: ['31', 'minimum 35', 'pat', 'deposit', 'friday'],
    flags: ['order is confirmed', 'minimum already met'],
  },
  H02: {
    caseId: 'H02',
    suiteLabel: SYNTHETIC_HOLDOUT_SUITE_LABEL,
    title: 'Trial renewal',
    taskText: 'Summarize trial status and next step.',
    sourceText:
      '[1] Trial ends June 15. Usage stayed under the 500 seat cap.\n\n' +
      '[2] Finance asked for a quote before approving renewal. No quote is in these notes.\n\n' +
      '[3] Quinn will schedule a review call once a quote arrives.',
    lookFor: ['june 15', 'under the 500', 'quote', 'quinn', 'finance'],
    flags: ['renewal approved', 'quote was received'],
  },
  H03: {
    caseId: 'H03',
    suiteLabel: SYNTHETIC_HOLDOUT_SUITE_LABEL,
    title: 'Parking permit',
    taskText: 'Brief facilities on permit options.',
    sourceText:
      '[1] Lot A has 2 visitor permits left. Lot B is full until July.\n\n' +
      '[2] Guest arrives Tuesday 9 a.m. for a half-day visit.\n\n' +
      '[3] Facilities has not assigned a permit number.',
    lookFor: ['lot a', '2 visitor', 'lot b', 'tuesday', 'not assigned'],
    flags: ['permit issued', 'lot b available'],
  },
  H04: {
    caseId: 'H04',
    suiteLabel: SYNTHETIC_HOLDOUT_SUITE_LABEL,
    title: 'Volunteer shift swap',
    taskText: 'Capture the swap status.',
    sourceText:
      '[1] Riya asked to swap the Saturday shift with Marco. Marco has not replied.\n\n' +
      '[2] Coverage requires at least one certified volunteer on Saturdays.\n\n' +
      '[3] The coordinator will escalate if no reply by Thursday.',
    lookFor: ['marco has not replied', 'certified', 'thursday', 'escalate'],
    flags: ['swap approved', 'marco agreed'],
  },
  H05: {
    caseId: 'H05',
    suiteLabel: SYNTHETIC_HOLDOUT_SUITE_LABEL,
    title: 'Budget variance',
    taskText: 'Explain the variance for the owner.',
    sourceText:
      '[1] Q2 travel budget was $12,000. Reported spend is $11,450 through May 31.\n\n' +
      '[2] One June conference invoice for $900 is not yet in the report.\n\n' +
      '[3] Finance wants a revised forecast before reopening discretionary travel.',
    lookFor: ['11,450', '900', 'forecast', 'discretionary', 'june conference'],
    flags: ['under budget without qualification', 'travel reopened'],
  },
});