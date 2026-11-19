// CydeWorks AI cost-comparison presentation module.
// Pure, dependency-free. No HTML, files, networking or provider calls.
// One currency unit equals 1000000 micros. Amounts are formatted with
// BigInt integer division and string operations only, never float division.
// Malformed-input handling: fields are read only through own data property
// descriptors (accessor getters are never invoked), all input inspection is
// wrapped locally, and every failure returns the same static INVALID_INPUT
// result without throwing or copying caller values into the output.
// Unavailable results (malformed or available:false) contain no digits in
// any string field; the numeric conversion sentence appears only when
// available is true.

const MICROS_PER_UNIT = 1000000n;
const REASON_CODE = "INVALID_INPUT";
const CURRENCY_PATTERN = /^[A-Z]{3}$/; // syntax only, not ISO membership

const UNAVAILABLE_HEADLINE = "Cost comparison unavailable.";
const MALFORMED_DETAIL =
  "The cost comparison input was missing or malformed. No amount is shown.";
const NOT_AVAILABLE_DETAIL =
  "No cost comparison is available for these samples. No amount is shown.";
// Digit-free caveat used in every unavailable result.
const UNAVAILABLE_CAVEAT =
  "Observed differences do not establish router savings, equivalent quality or future performance.";
// Numeric conversion sentence, appended only for available:true results.
const CONVERSION_SENTENCE = " One currency unit equals 1000000 micros.";
const BASE_CAVEAT = UNAVAILABLE_CAVEAT + CONVERSION_SENTENCE;

// Read an own data property without invoking accessors. Returns undefined
// for missing fields and for accessor properties (get/set), so a throwing
// getter can never execute. Descriptor lookup itself may throw on exotic
// objects (for example a revoked Proxy); callers wrap inspection in try.
function ownData(input, key) {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) return undefined; // accessor: reject silently
  return descriptor.value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Exact formatting of a non-negative safe-integer magnitude of micros.
// Trailing zeros are trimmed; at least one decimal digit is kept ("1.0").
function formatUnits(magnitudeMicros) {
  const micros = BigInt(magnitudeMicros);
  const whole = micros / MICROS_PER_UNIT;
  const remainder = micros % MICROS_PER_UNIT;
  let fraction = String(remainder).padStart(6, "0");
  while (fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  if (fraction.length === 0) fraction = "0";
  return `${whole}.${fraction}`;
}

function unavailable(detail, reasonCode) {
  const result = {
    available: false,
    headline: UNAVAILABLE_HEADLINE,
    detail,
    caveat: UNAVAILABLE_CAVEAT,
  };
  if (reasonCode !== undefined) result.reasonCode = reasonCode;
  return result;
}

function malformedResult() {
  return unavailable(MALFORMED_DETAIL, REASON_CODE);
}

export function describeCostDifference(input) {
  // Snapshot everything we need from the caller object up front, inside one
  // local try/catch. Any exception during inspection (revoked Proxy, traps
  // that throw on getPrototypeOf/getOwnPropertyDescriptor, etc.) produces
  // the same static malformed result. Nothing below this block touches the
  // caller object again, and no caller value is ever copied into a result.
  let plain;
  let available;
  let deltaMicros;
  let currency;
  let evidence;
  try {
    plain = isPlainObject(input);
    if (plain) {
      available = ownData(input, "available");
      if (available === true) {
        deltaMicros = ownData(input, "deltaMicros");
        currency = ownData(input, "currency");
        evidence = ownData(input, "evidence");
      }
    }
  } catch {
    return malformedResult();
  }

  if (!plain) return malformedResult();
  if (available === false) return unavailable(NOT_AVAILABLE_DETAIL);
  if (available !== true) return malformedResult();

  if (!Number.isSafeInteger(deltaMicros)) return malformedResult();
  if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
    return malformedResult();
  }
  if (evidence !== "estimated" && evidence !== "provider-billed") {
    return malformedResult();
  }

  const estimated = evidence === "estimated";
  const amount = formatUnits(Math.abs(deltaMicros));
  const signedAmount = deltaMicros < 0 ? `-${amount}` : amount;
  const prefix = estimated ? "Estimated: " : "";
  const suffix = estimated ? " (estimate)" : "";

  let headline;
  if (deltaMicros > 0) {
    headline =
      `${prefix}The candidate was cheaper by ${amount} ${currency}${suffix} in these observed samples.`;
  } else if (deltaMicros < 0) {
    headline =
      `${prefix}The candidate was more expensive by ${amount} ${currency}${suffix} in these observed samples.`;
  } else {
    headline =
      `${prefix}The candidate and baseline had equal observed costs${suffix} in these observed samples.`;
  }

  const evidenceNote = estimated
    ? "This amount is an estimate, not a billed charge."
    : 'The "provider-billed" label is caller-supplied; this module did not authenticate a bill.';

  const detail =
    `${deltaMicros} micros = ${signedAmount} ${currency}. ` +
    "deltaMicros is baseline cost minus candidate cost: positive means the candidate " +
    "was cheaper, negative means more expensive, zero means equal observed costs. " +
    evidenceNote;

  const caveat = BASE_CAVEAT + (estimated ? " Amounts shown are estimates." : "");

  return { available: true, headline, detail, caveat };
}
