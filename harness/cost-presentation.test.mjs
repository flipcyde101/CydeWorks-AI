import test from "node:test";
import assert from "node:assert/strict";
import { describeCostDifference } from "./cost-presentation.mjs";

const REASON_CODE = "INVALID_INPUT";

function base(overrides = {}) {
  return {
    available: true,
    deltaMicros: 3000,
    currency: "USD",
    evidence: "estimated",
    ...overrides,
  };
}

function assertMalformed(result) {
  assert.equal(result.available, false);
  assert.equal(result.reasonCode, REASON_CODE);
  assert.equal(typeof result.headline, "string");
  assert.equal(typeof result.detail, "string");
  assert.equal(typeof result.caveat, "string");
  // Unavailable text must contain no numeric amount and no markup.
  assert.ok(!/\d/.test(result.headline + result.detail));
  assert.ok(!result.detail.includes("<"));
}

test("required example: 3000 USD micros, estimated", () => {
  const r = describeCostDifference(base());
  assert.equal(r.available, true);
  assert.deepEqual(Object.keys(r).sort(), ["available", "caveat", "detail", "headline"]);
  assert.ok(r.headline.includes("candidate was cheaper by 0.003 USD"));
  assert.ok(r.headline.includes("in these observed samples"));
  assert.ok(r.detail.includes("3000 micros = 0.003 USD"));
  for (const text of [r.headline, r.detail, r.caveat]) {
    assert.ok(!text.includes("0.003 micros"));
    assert.ok(!text.includes("<"));
    assert.ok(!text.includes("&"));
  }
  // Estimated values are visibly labeled estimates.
  assert.ok(r.headline.includes("Estimated:"));
  assert.ok(r.headline.includes("(estimate)"));
  assert.ok(r.detail.toLowerCase().includes("estimate"));
});

test("exact formatting: sign, zero, one micro, trailing zeros, safe-integer boundaries", () => {
  const table = [
    [0, "0.0"],
    [1, "0.000001"],
    [-1, "-0.000001"],
    [3000, "0.003"],
    [-3000, "-0.003"],
    [1000000, "1.0"],
    [1500000, "1.5"],
    [1230000, "1.23"],
    [1000001, "1.000001"],
    [Number.MAX_SAFE_INTEGER, "9007199254.740991"],
    [-Number.MAX_SAFE_INTEGER, "-9007199254.740991"],
  ];
  for (const evidence of ["estimated", "provider-billed"]) {
    for (const [delta, expected] of table) {
      const r = describeCostDifference(base({ deltaMicros: delta, evidence }));
      assert.equal(r.available, true, `${evidence} ${delta}`);
      assert.ok(
        r.detail.includes(`${delta} micros = ${expected} USD`),
        `${evidence} ${delta}: ${r.detail}`,
      );
      if (delta > 0) {
        assert.ok(r.headline.includes(`cheaper by ${expected} USD`));
      } else if (delta < 0) {
        assert.ok(r.headline.includes(`more expensive by ${expected.slice(1)} USD`));
      } else {
        assert.ok(r.headline.includes("equal observed costs"));
      }
      if (evidence === "estimated") {
        assert.ok(r.headline.toLowerCase().includes("estimate"));
      }
    }
  }
});

test("negative zero behaves as zero", () => {
  const r = describeCostDifference(base({ deltaMicros: -0 }));
  assert.equal(r.available, true);
  assert.ok(r.detail.includes("0 micros = 0.0 USD"));
  assert.ok(r.headline.includes("equal observed costs"));
});

test("non-USD currency and syntax-only validation", () => {
  const eur = describeCostDifference(base({ currency: "EUR" }));
  assert.ok(eur.detail.includes("0.003 EUR"));
  assert.ok(eur.headline.includes("EUR"));
  // Syntax is validated, not ISO membership: ZZZ passes.
  assert.equal(describeCostDifference(base({ currency: "JPY" })).available, true);
  assert.equal(describeCostDifference(base({ currency: "ZZZ" })).available, true);
});

test("rejects every invalid numeric category", () => {
  const bad = [
    1.5, -0.5, 0.1,                              // fractions
    Number.MAX_SAFE_INTEGER + 1,                 // unsafe integers
    -(Number.MAX_SAFE_INTEGER + 1),
    1e21,
    "3000", "0", "",                             // numeric strings and empty string
    NaN, Infinity, -Infinity,                    // NaN and infinity
    true, false,                                 // booleans
    null, undefined,                             // wrong types
    [], {}, [3000],                              // objects and arrays
    new Number(3000),                            // boxed number
  ];
  for (const deltaMicros of bad) {
    assertMalformed(describeCostDifference(base({ deltaMicros })));
  }
});

test("rejects missing individual fields", () => {
  for (const field of ["deltaMicros", "currency", "evidence"]) {
    const input = base();
    delete input[field];
    assertMalformed(describeCostDifference(input));
  }
});

test("rejects invalid currency values", () => {
  const bad = [
    "usd", "Usd", "USDD", "US", "US1", "U D",
    "USD\n", "\nUSD", " US", "USD ", "",
    null, 840, ["USD"], true,
  ];
  for (const currency of bad) {
    assertMalformed(describeCostDifference(base({ currency })));
  }
});

test("rejects invalid evidence values", () => {
  const bad = [
    "billed", "ESTIMATED", "Estimated", "provider_billed",
    "provider billed", " estimated", "",
    null, 1, true, ["estimated"],
  ];
  for (const evidence of bad) {
    assertMalformed(describeCostDifference(base({ evidence })));
  }
});

test("missing and malformed top-level inputs return structured unavailable results", () => {
  const bad = [
    undefined, null, 42, "text", [], true, {},
    { available: true },
    { available: "true" },
    { available: 1 },
    { available: null },
    { deltaMicros: 3000, currency: "USD", evidence: "estimated" },
    new Date(),
    Object.create({ available: true, deltaMicros: 3000, currency: "USD", evidence: "estimated" }),
  ];
  for (const input of bad) {
    assertMalformed(describeCostDifference(input));
  }
  // A null-prototype object with valid own properties is accepted.
  const nullProto = Object.assign(Object.create(null), base());
  assert.equal(describeCostDifference(nullProto).available, true);
});

test("malformed results never echo arbitrary input", () => {
  const hostile = "<script>alert('CYDE')</script>";
  const r = describeCostDifference(base({ deltaMicros: hostile }));
  assertMalformed(r);
  const blob = r.headline + r.detail + r.caveat;
  assert.ok(!blob.includes("script"));
  assert.ok(!blob.includes("alert"));
  assert.ok(!blob.includes("CYDE"));
});

test("available:false returns unavailable text without a numeric amount", () => {
  const r = describeCostDifference({
    available: false,
    deltaMicros: "junk",
    currency: "xx",
    evidence: "???",
  });
  assert.equal(r.available, false);
  assert.ok(!("reasonCode" in r));
  assert.ok(!/\d/.test(r.headline + r.detail));
  assert.ok(r.headline.toLowerCase().includes("unavailable"));
});

test("does not mutate input and returns fresh deterministic results", () => {
  const input = base();
  const snapshot = { ...input };
  const first = describeCostDifference(input);
  const second = describeCostDifference(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.notEqual(describeCostDifference(undefined), describeCostDifference(undefined));
});

test("caveats and evidence semantics", () => {
  for (const evidence of ["estimated", "provider-billed"]) {
    const r = describeCostDifference(base({ evidence }));
    for (const phrase of ["router savings", "equivalent quality", "future performance"]) {
      assert.ok(r.caveat.includes(phrase), `${evidence}: ${phrase}`);
    }
    assert.ok(r.caveat.includes("1000000 micros"));
  }
  const billed = describeCostDifference(base({ evidence: "provider-billed" }));
  assert.ok(billed.detail.includes("caller-supplied"));
  assert.ok(billed.detail.includes("authenticate"));
  assert.ok(!billed.headline.toLowerCase().includes("estimate"));
});

// ---------------------------------------------------------------------------
// Regression tests: hostile input inspection must never throw, never invoke
// accessors, and never copy caller values into the result.
// ---------------------------------------------------------------------------

test("regression: throwing own getters on each field are never invoked", () => {
  for (const field of ["available", "deltaMicros", "currency", "evidence"]) {
    let calls = 0;
    const input = base();
    Object.defineProperty(input, field, {
      configurable: true,
      enumerable: true,
      get() {
        calls += 1;
        throw new Error(`getter executed for ${field}`);
      },
    });
    const r = describeCostDifference(input);
    assertMalformed(r);
    assert.equal(calls, 0, `getter for ${field} must not be invoked`);
    // The thrown message text must not leak into the static result.
    // (Field names themselves can appear in the module's fixed wording,
    // so only the unique getter-message marker is checked here.)
    const blob = r.headline + r.detail + r.caveat;
    assert.ok(!blob.includes("getter executed"));
    assert.ok(!blob.includes(`for ${field}`));
  }
});

test("regression: non-throwing own getters are also rejected without invocation", () => {
  for (const field of ["available", "deltaMicros", "currency", "evidence"]) {
    let calls = 0;
    const input = base();
    Object.defineProperty(input, field, {
      configurable: true,
      enumerable: true,
      get() {
        calls += 1;
        return base()[field]; // would be a valid value if read
      },
    });
    const r = describeCostDifference(input);
    assertMalformed(r);
    assert.equal(calls, 0, `accessor for ${field} must not be invoked even when benign`);
  }
});

test("regression: setter-only own properties are rejected without side effects", () => {
  let calls = 0;
  const input = base();
  Object.defineProperty(input, "evidence", {
    configurable: true,
    enumerable: true,
    set() {
      calls += 1;
    },
  });
  const r = describeCostDifference(input);
  assertMalformed(r);
  assert.equal(calls, 0);
});

test("regression: revoked Proxy returns static malformed result without throwing", () => {
  const { proxy, revoke } = Proxy.revocable(base(), {});
  revoke();
  const r = describeCostDifference(proxy);
  assertMalformed(r);
});

test("regression: inspection traps that throw are contained", () => {
  const marker = "TRAP_MARKER_9Q";
  const cases = [
    {
      name: "getPrototypeOf trap throws",
      handler: {
        getPrototypeOf() {
          throw new Error(marker);
        },
      },
    },
    {
      name: "getOwnPropertyDescriptor trap throws",
      handler: {
        getPrototypeOf() {
          return Object.prototype;
        },
        getOwnPropertyDescriptor() {
          throw new Error(marker);
        },
      },
    },
    {
      name: "get trap throws (must never be reached via property reads)",
      handler: {
        getPrototypeOf() {
          return Object.prototype;
        },
        get() {
          throw new Error(marker);
        },
      },
    },
  ];
  for (const { name, handler } of cases) {
    const proxy = new Proxy(base(), handler);
    const r = describeCostDifference(proxy);
    if (name.startsWith("get trap")) {
      // Descriptor-based reads bypass the get trap entirely; the underlying
      // target is a valid record, so this must succeed, not throw.
      assert.equal(r.available, true, name);
    } else {
      assertMalformed(r);
      const blob = r.headline + r.detail + r.caveat;
      assert.ok(!blob.includes(marker), name);
      assert.ok(!blob.includes("TRAP"), name);
    }
  }
});

test("regression: getOwnPropertyDescriptor trap returning accessor descriptors does not invoke getters", () => {
  let calls = 0;
  const target = base();
  Object.defineProperty(target, "evidence", {
    configurable: true,
    enumerable: true,
    get() {
      calls += 1;
      throw new Error("proxied getter executed");
    },
  });
  const proxy = new Proxy(target, {});
  const r = describeCostDifference(proxy);
  assertMalformed(r);
  assert.equal(calls, 0);
});

test("regression: valid null-prototype input still succeeds after hardening", () => {
  const nullProto = Object.assign(Object.create(null), base());
  const r = describeCostDifference(nullProto);
  assert.equal(r.available, true);
  assert.ok(r.headline.includes("candidate was cheaper by 0.003 USD"));
  assert.ok(r.detail.includes("3000 micros = 0.003 USD"));
  // Null-prototype with an accessor field is still rejected silently.
  let calls = 0;
  const hostileNullProto = Object.assign(Object.create(null), base());
  Object.defineProperty(hostileNullProto, "currency", {
    configurable: true,
    enumerable: true,
    get() {
      calls += 1;
      throw new Error("null-proto getter executed");
    },
  });
  assertMalformed(describeCostDifference(hostileNullProto));
  assert.equal(calls, 0);
});

test("regression: available:false short-circuits before hostile sibling fields", () => {
  let calls = 0;
  const input = { available: false };
  for (const field of ["deltaMicros", "currency", "evidence"]) {
    Object.defineProperty(input, field, {
      configurable: true,
      enumerable: true,
      get() {
        calls += 1;
        throw new Error("sibling getter executed");
      },
    });
  }
  const r = describeCostDifference(input);
  assert.equal(r.available, false);
  assert.ok(!("reasonCode" in r));
  assert.equal(calls, 0);
  assert.ok(!/\d/.test(r.headline + r.detail));
});

test("regression: hostile inputs are not mutated and never echoed", () => {
  const marker = "REJECTED_TEXT_7X";
  let calls = 0;
  const input = base({ currency: marker });
  Object.defineProperty(input, "evidence", {
    configurable: true,
    enumerable: true,
    get() {
      calls += 1;
      throw new Error(marker);
    },
  });
  const descriptorsBefore = Object.getOwnPropertyDescriptors(input);
  const r = describeCostDifference(input);
  assertMalformed(r);
  assert.equal(calls, 0);
  const blob = r.headline + r.detail + r.caveat + (r.reasonCode ?? "");
  assert.ok(!blob.includes(marker));
  assert.ok(!blob.includes("REJECTED"));
  // Own property descriptors (including the accessor) are untouched.
  const descriptorsAfter = Object.getOwnPropertyDescriptors(input);
  assert.deepEqual(
    Object.keys(descriptorsAfter).sort(),
    Object.keys(descriptorsBefore).sort(),
  );
  for (const key of Object.keys(descriptorsBefore)) {
    const before = descriptorsBefore[key];
    const after = descriptorsAfter[key];
    assert.equal(after.configurable, before.configurable);
    assert.equal(after.enumerable, before.enumerable);
    if ("value" in before) {
      assert.ok("value" in after);
      assert.equal(after.value, before.value);
      assert.equal(after.writable, before.writable);
    } else {
      assert.equal(after.get, before.get);
      assert.equal(after.set, before.set);
    }
  }
  // Plain valid input remains unmutated by the hardened path as well.
  const plain = base();
  const snapshot = { ...plain };
  describeCostDifference(plain);
  assert.deepEqual(plain, snapshot);
});

// ---------------------------------------------------------------------------
// Regression tests: digit-free unavailable results (wording repair).
// Every string field, including caveat and reasonCode, must contain no
// digits in both unavailable branches. The disclaimer stays everywhere;
// the numeric conversion sentence appears only for available:true.
// ---------------------------------------------------------------------------

function assertNoDigitsAnywhere(result, label) {
  for (const key of Object.keys(result)) {
    const value = result[key];
    if (typeof value === "string") {
      assert.ok(!/\d/.test(value), `${label}: field "${key}" contains a digit: ${value}`);
    }
  }
}

test("regression: malformed results are digit-free in every string field including caveat", () => {
  const cases = [
    undefined,
    null,
    42,
    {},
    { available: true },
    base({ deltaMicros: 1.5 }),
    base({ deltaMicros: "3000" }),
    base({ deltaMicros: NaN }),
    base({ deltaMicros: Number.MAX_SAFE_INTEGER + 1 }),
    base({ currency: "usd" }),
    base({ evidence: "billed" }),
    base({ deltaMicros: "<script>9</script>" }),
  ];
  for (const input of cases) {
    const r = describeCostDifference(input);
    assert.equal(r.available, false);
    assert.equal(r.reasonCode, REASON_CODE);
    assertNoDigitsAnywhere(r, "malformed");
    // Disclaimer preserved; conversion sentence absent.
    for (const phrase of ["router savings", "equivalent quality", "future performance"]) {
      assert.ok(r.caveat.includes(phrase), `malformed caveat missing: ${phrase}`);
    }
    assert.ok(!r.caveat.includes("1000000"));
    assert.ok(!r.caveat.includes("micros"));
  }
  // Hostile inspection paths produce the same digit-free static result.
  const { proxy, revoke } = Proxy.revocable(base(), {});
  revoke();
  assertNoDigitsAnywhere(describeCostDifference(proxy), "revoked proxy");
  const trapProxy = new Proxy(base(), {
    getPrototypeOf() {
      throw new Error("TRAP_MARKER_9Q");
    },
  });
  assertNoDigitsAnywhere(describeCostDifference(trapProxy), "throwing trap");
  let calls = 0;
  const getterInput = base();
  Object.defineProperty(getterInput, "evidence", {
    configurable: true,
    enumerable: true,
    get() {
      calls += 1;
      throw new Error("getter executed");
    },
  });
  const gr = describeCostDifference(getterInput);
  assertNoDigitsAnywhere(gr, "throwing getter");
  assert.equal(calls, 0);
});

test("regression: available:false results are digit-free in every string field including caveat", () => {
  const cases = [
    { available: false },
    { available: false, deltaMicros: 3000, currency: "USD", evidence: "estimated" },
    { available: false, deltaMicros: "junk", currency: "xx", evidence: "???" },
    Object.assign(Object.create(null), { available: false }),
  ];
  for (const input of cases) {
    const r = describeCostDifference(input);
    assert.equal(r.available, false);
    assert.ok(!("reasonCode" in r), "ordinary available:false must not carry reasonCode");
    assertNoDigitsAnywhere(r, "available:false");
    for (const phrase of ["router savings", "equivalent quality", "future performance"]) {
      assert.ok(r.caveat.includes(phrase), `available:false caveat missing: ${phrase}`);
    }
    assert.ok(!r.caveat.includes("1000000"));
    assert.ok(!r.caveat.includes("micros"));
  }
  // available:false with hostile sibling accessors: still digit-free, no invocation.
  let calls = 0;
  const hostile = { available: false };
  for (const field of ["deltaMicros", "currency", "evidence"]) {
    Object.defineProperty(hostile, field, {
      configurable: true,
      enumerable: true,
      get() {
        calls += 1;
        throw new Error("sibling getter executed");
      },
    });
  }
  const r = describeCostDifference(hostile);
  assertNoDigitsAnywhere(r, "available:false hostile siblings");
  assert.equal(calls, 0);
});

test("regression: available:true keeps the conversion sentence and full disclaimer", () => {
  for (const evidence of ["estimated", "provider-billed"]) {
    for (const delta of [3000, -3000, 0, 1, Number.MAX_SAFE_INTEGER]) {
      const r = describeCostDifference(base({ deltaMicros: delta, evidence }));
      assert.equal(r.available, true);
      assert.ok(r.caveat.includes("One currency unit equals 1000000 micros."));
      for (const phrase of ["router savings", "equivalent quality", "future performance"]) {
        assert.ok(r.caveat.includes(phrase));
      }
    }
  }
  // Exact prior wording preserved for the required example.
  const r = describeCostDifference(base());
  assert.equal(
    r.caveat,
    "Observed differences do not establish router savings, equivalent quality or future performance. " +
      "One currency unit equals 1000000 micros. Amounts shown are estimates.",
  );
  const billed = describeCostDifference(base({ evidence: "provider-billed" }));
  assert.equal(
    billed.caveat,
    "Observed differences do not establish router savings, equivalent quality or future performance. " +
      "One currency unit equals 1000000 micros.",
  );
});
