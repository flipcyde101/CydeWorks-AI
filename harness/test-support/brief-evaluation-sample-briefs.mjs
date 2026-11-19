// Representative synthetic briefs for offline structural scoring fixtures.

export const BRIEF_EVALUATION_GOOD_B01 = [
  'Decision open: no room is reserved [3].',
  'Cedar holds 24 and cannot fit 28 confirmed attendees [1][2].',
  'Maple fits capacity but costs $260, above the $250 budget [1][2].',
  'Nia will ask Maple for a discount by Tuesday [3].',
  'A price exception or alternate room is still needed.',
].join(' ');

export const BRIEF_EVALUATION_BAD_B01_BOOKED = [
  'A room has been booked for the workshop [3].',
  'Both rooms meet budget and capacity constraints [1][2].',
].join(' ');

export const BRIEF_EVALUATION_GOOD_B18 = [
  'A one-week pilot will cover new invoices under $500; larger invoices keep existing review [1].',
  'Taylor will prepare the pilot checklist [2].',
  'Start date and improvement threshold remain open [2][3].',
].join(' ');

export const BRIEF_EVALUATION_BAD_B18_EXACTLY_500 = [
  'The pilot includes invoices of exactly $500 [1].',
  'The pilot already started Monday [2].',
].join(' ');

export const BRIEF_EVALUATION_GOOD_B13 = [
  'Guest A offers June 11 audio-only; Guest B offers June 14 with a video option [1].',
  'Either date can fit the June 20 target if editing starts promptly after recording [2][3].',
  'Producer preference is open; no guest is selected yet [2][3].',
].join(' ');

export const BRIEF_EVALUATION_BAD_B13_INFERENCE = [
  'Guest A agreed to video and is booked [1].',
  'Guest B is confirmed for June 14 [1].',
].join(' ');

export const BRIEF_EVALUATION_GOOD_B20 = [
  'No notes were supplied in the input.',
  'Please provide source notes or decision context before drafting a decision brief.',
].join(' ');

export const BRIEF_EVALUATION_BAD_B20_FABRICATED = [
  'The project owner approved handoff for June 12 with a 500-unit target.',
  'Taylor owns final delivery and the pilot has started.',
].join(' ');

/** @returns {Record<string, { briefText: string }>} */
export function buildTrackedSyntheticBriefMap() {
  return {
    B01: {
      briefText: BRIEF_EVALUATION_GOOD_B01,
    },
    B02: {
      briefText:
        'Team approved two biweekly sends, superseding the weekly proposal [2]. Devon drafts by May 8 [2]. Unsubscribe threshold is open [3].',
    },
    B03: {
      briefText:
        'Downtown-only sample: 9 of 44 returns lacked order numbers [1]. Ari owns the downtown form change; rollout date open [2]. Chain-wide rollout needs separate review [3].',
    },
    B04: {
      briefText:
        'Option A totals $155 with delivery before 8 a.m., meeting the 8:30 setup start [1][2]. Option B is cheaper but delivery window starts at 9 a.m. [1][2]. Rowan will check pickup for B [3]. Decision open.',
    },
    B05: {
      briefText:
        '15 of 24 respondents requested evening sessions [1]. Weekend demand unknown and no schedule change approved [2]. Lee will draft an evening trial for review [3].',
    },
    B06: {
      briefText:
        'Vendor North June 6 is on conditional hold pending deposit by Friday [2], conflicting with the earlier confirmed note [1]. Vendor South is available June 8 [3].',
    },
    B07: {
      briefText:
        'Owner approved 300 prints with art approval moved to Friday; Mina submits final art [2]. Delivery remains contingent on vendor lead time after approved art [3].',
    },
    B08: {
      briefText:
        'Mislabeled bins were observed; shipment errors are not yet evidenced [1]. Avery checks shelves today [2]. Order review is unassigned [2]. Broader checks remain pending [3].',
    },
    B09: {
      briefText:
        'Conversion rose from 5.0% to 5.5% (0.5 percentage points) [1]. Causality is unknown because source mix was not logged [2]. Source-level tracking is a proposed next step [3].',
    },
    B10: {
      briefText:
        'Venue hosting is conditional on facilities approval [1]. Tuesday is tentative only; no attendee date sent [2]. Kris follows up with facilities by Monday [3].',
    },
    B11: {
      briefText:
        'Only the 30-minute basics module is approved [1]. Ivy will draft the basics outline by June 12; reviewer open [2]. Advanced modules remain in backlog [1].',
    },
    B12: {
      briefText:
        'Courier dashboard shows 12 delivered while recipient reports 10 arrived with no tracking IDs listed [1][2]. Omar will match tracking IDs before escalation [3].',
    },
    B13: {
      briefText: BRIEF_EVALUATION_GOOD_B13,
    },
    B14: {
      briefText:
        'Office hours were discussed but votes, dates, and owners were not recorded before the meeting ended [2][3]. Request a decision, schedule, and owner.',
    },
    B15: {
      briefText:
        'About 4.5 weeks of stock at 20/week with a 30-unit nominal cushion over lead-time demand [1]. Promotion risk is unknown [2]. Morgan requested forecast before purchase order [3].',
    },
    B16: {
      briefText:
        'Headline-only home page update approved; Jules owns delivery by Thursday [1]. Pricing page remains draft pending legal review [2]. Office move is unrelated [3].',
    },
    B17: {
      briefText:
        '10 a.m. slot is conditional on indoor lighting [1]. Lighting kit is under repair per inventory updated May 4 [2]. Sam verifies by May 6; backup studio unknown [3].',
    },
    B18: {
      briefText: BRIEF_EVALUATION_GOOD_B18,
    },
    B19: {
      briefText:
        'Morning class has 3 seats left with four on the waitlist [1]. Afternoon has 11 open seats [2]. Volunteer moves are a proposal only [2]. Dana will draft messaging [3].',
    },
    B20: {
      briefText: BRIEF_EVALUATION_GOOD_B20,
    },
  };
}

/** @returns {Record<string, { briefText: string }>} */
export function buildHoldoutSyntheticBriefMap() {
  return {
    H01: {
      briefText:
        'RSVP count is 31 against vendor minimum 35 plates with 48-hour notice [1]. Two organizers may add guests if registered by noon Friday [2]. No deposit paid; Pat calls vendor after final RSVPs [3].',
    },
    H02: {
      briefText:
        'Trial ends June 15 with usage under the 500 seat cap [1]. Finance awaits a quote; none is in these notes [2]. Quinn schedules review after quote arrives [3].',
    },
    H03: {
      briefText:
        'Lot A has 2 visitor permits; Lot B full until July [1]. Tuesday 9 a.m. half-day guest visit pending permit assignment [2][3].',
    },
    H04: {
      briefText:
        'Riya requested a Saturday swap with Marco, who has not replied [1]. Certified coverage is required Saturdays [2]. Coordinator escalates if no reply by Thursday [3].',
    },
    H05: {
      briefText:
        'Reported spend is $11,450 of $12,000 through May 31, but a $900 June conference invoice is not yet included [1][2]. Finance wants a revised forecast before reopening discretionary travel [3].',
    },
  };
}