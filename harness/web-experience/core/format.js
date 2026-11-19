// Pure presentation formatters. No DOM, no clock unless injected.
// Money is formatted with integer math only. Unknown is never rendered as zero.

const safeCount = value => Number.isSafeInteger(value) && value >= 0;

// 1,000,000 micros = 1 currency unit. Returns null for anything that is not a safe nonnegative integer.
export function formatMicros(amountMicros) {
  if (!safeCount(amountMicros)) return null;
  const units = Math.floor(amountMicros / 1_000_000);
  const fraction = String(amountMicros % 1_000_000).padStart(6, '0').replace(/0+$/, '');
  return units.toLocaleString('en-US') + '.' + fraction.padEnd(2, '0');
}

export function formatSignedMicros(deltaMicros) {
  if (!Number.isSafeInteger(deltaMicros)) return null;
  const body = formatMicros(Math.abs(deltaMicros));
  return deltaMicros === 0 ? body : (deltaMicros > 0 ? '+' : '-') + body;
}

const EVIDENCE = {
  'provider-billed': {kind: 'billed', label: 'Provider reported'},
  estimated: {kind: 'estimated', label: 'Estimated'},
};

// cost: null | {amountMicros, currency, evidence, complete}
// Returns a view model. `primary` is what a summary row shows; `exact` keeps micros for details.
export function describeCost(cost) {
  if (cost === null || cost === undefined) {
    return {kind: 'unavailable', label: 'Unavailable', primary: 'Unavailable', exact: null,
      note: 'No charge was recorded for this attempt. Unknown is not zero.'};
  }
  const evidence = EVIDENCE[cost.evidence];
  const amount = formatMicros(cost.amountMicros);
  if (!evidence || amount === null || typeof cost.currency !== 'string' || !/^[A-Z]{3}$/.test(cost.currency)) {
    return {kind: 'unavailable', label: 'Unavailable', primary: 'Unavailable', exact: null,
      note: 'The recorded charge could not be read. It is not shown as a number.'};
  }
  const exact = cost.amountMicros.toLocaleString('en-US') + ' micros of 1 ' + cost.currency;
  if (cost.complete !== true) {
    return {kind: evidence.kind, label: evidence.label + ', incomplete', primary: 'At least ' + amount + ' ' + cost.currency,
      exact, note: 'This figure is partial. The final amount may be higher.'};
  }
  return {kind: evidence.kind, label: evidence.label, primary: amount + ' ' + cost.currency, exact,
    note: evidence.kind === 'estimated'
      ? 'An estimate from recorded usage. It is not a provider invoice.'
      : 'Reported by the provider for this attempt. Not independently verified.'};
}

export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'Unavailable';
  if (ms < 60_000) return (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) + ' s';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  if (minutes < 60) return minutes + ' min ' + seconds + ' s';
  return Math.floor(minutes / 60) + ' h ' + String(minutes % 60).padStart(2, '0') + ' min';
}

export function formatCount(value) {
  return safeCount(value) ? value.toLocaleString('en-US') : 'Unavailable';
}

export function formatClock(iso) {
  const time = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(time)) return 'Unavailable';
  return new Date(time).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
}

export function formatDateTime(iso) {
  const time = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(time)) return 'Unavailable';
  return new Date(time).toLocaleString([], {year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
}

export function formatAge(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'unknown age';
  if (ms < 5000) return 'just now';
  if (ms < 60_000) return Math.round(ms / 1000) + ' s ago';
  if (ms < 3_600_000) return Math.round(ms / 60_000) + ' min ago';
  return Math.round(ms / 3_600_000) + ' h ago';
}

export function shortHash(value) {
  return typeof value === 'string' && value.length > 16 ? value.slice(0, 12) + '…' : value ?? 'Unavailable';
}

// Characters per second, only when both the count and the window are measurable.
export function formatRate(chars, windowMs) {
  if (!safeCount(chars) || chars === 0 || typeof windowMs !== 'number' || !(windowMs > 0)) return null;
  return (chars * 1000 / windowMs).toFixed(1) + ' characters/s';
}
