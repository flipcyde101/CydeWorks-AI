// Synthetic offline tests for claims-frame-v2.mjs. No network, credentials,
// or live supervisor integration.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ClaimsFrameError,
  CORRELATION_BYTES,
  HEADER_SIZE,
  KIND,
  LIMITATIONS,
  MAX_BODY_BYTES,
  MAX_FRAME_BYTES,
  OPERATION,
  SCHEMA,
  STATUS,
  createFrameDecoder,
  decodeFrame,
  encodeFrame,
} from './claims-frame-v2.mjs';

const CORRELATION = Uint8Array.from({length: CORRELATION_BYTES}, (_, i) => i + 1);
const OTHER_CORRELATION = Uint8Array.from({length: CORRELATION_BYTES}, (_, i) => 255 - i);

function baseFields(overrides = {}) {
  return {
    kind: KIND.REQUEST,
    operation: OPERATION.RESERVE,
    status: STATUS.UNSPECIFIED,
    correlation: CORRELATION,
    body: new Uint8Array([0x61, 0x62]),
    ...overrides,
  };
}

function assertPrivacySafe(error) {
  assert.ok(error instanceof ClaimsFrameError);
  assert.match(error.message, /^Claims frame /);
  assert.equal(error.cause, undefined);
  assert.equal(String(error), `${error.name}: ${error.message}`);
}

test('documents schema and bounded sizes', () => {
  assert.equal(SCHEMA, 'cydeworks.claims-frame/2');
  assert.equal(HEADER_SIZE, 44);
  assert.equal(MAX_FRAME_BYTES, 8192);
  assert.equal(MAX_BODY_BYTES, MAX_FRAME_BYTES - HEADER_SIZE);
  assert.ok(LIMITATIONS.length >= 3);
});

test('round-trip encode and decode', () => {
  const wire = encodeFrame(baseFields());
  assert.equal(wire.length, HEADER_SIZE + 2);
  const decoded = decodeFrame(wire);
  assert.equal(decoded.kind, KIND.REQUEST);
  assert.equal(decoded.operation, OPERATION.RESERVE);
  assert.equal(decoded.status, STATUS.UNSPECIFIED);
  assert.deepEqual(decoded.correlation, CORRELATION);
  assert.deepEqual(decoded.body, Uint8Array.from([0x61, 0x62]));
});

test('exact maximum body and one byte over', () => {
  const maxBody = new Uint8Array(MAX_BODY_BYTES);
  maxBody[MAX_BODY_BYTES - 1] = 0x7e;
  const wire = encodeFrame(baseFields({body: maxBody}));
  assert.equal(wire.length, MAX_FRAME_BYTES);
  const decoded = decodeFrame(wire);
  assert.equal(decoded.body.length, MAX_BODY_BYTES);
  assert.throws(
    () => encodeFrame(baseFields({body: new Uint8Array(MAX_BODY_BYTES + 1)})),
    err => err instanceof ClaimsFrameError && err.code === 'OVERSIZED_INPUT',
  );
  const overWire = new Uint8Array(wire.length + 1);
  overWire.set(wire, 0);
  overWire[wire.length] = 0x00;
  assert.throws(
    () => decodeFrame(overWire),
    err => err instanceof ClaimsFrameError && err.code === 'OVERSIZED_INPUT',
  );
});

test('decoder splits header and body at every boundary', () => {
  const wire = encodeFrame(baseFields({body: new Uint8Array([9, 8, 7])}));
  for (let split = 0; split <= wire.length; split += 1) {
    const decoder = createFrameDecoder();
    const first = wire.subarray(0, split);
    const rest = wire.subarray(split);
    const fromFirst = decoder.push(first);
    if (fromFirst) {
      assert.equal(split, wire.length, `complete early at split ${split}`);
      assert.deepEqual(fromFirst.body, Uint8Array.from([9, 8, 7]));
    } else if (rest.length) {
      const fromRest = decoder.push(rest);
      assert.ok(fromRest, `expected completion after split ${split}`);
      assert.deepEqual(fromRest.body, Uint8Array.from([9, 8, 7]));
    } else {
      assert.throws(() => decoder.end(), err => err.code === 'TRUNCATED');
    }
  }
});

test('decoder rejects truncation at end', () => {
  const wire = encodeFrame(baseFields());
  const decoder = createFrameDecoder();
  assert.equal(decoder.push(wire.subarray(0, wire.length - 1)), null);
  assert.throws(() => decoder.end(), err => err.code === 'TRUNCATED');
  assert.throws(
    () => decodeFrame(wire.subarray(0, wire.length - 1)),
    err => err.code === 'TRUNCATED',
  );
});

test('rejects trailing bytes and multiple frames', () => {
  const frame = encodeFrame(baseFields());
  const trailing = new Uint8Array(frame.length + 3);
  trailing.set(frame, 0);
  trailing.set([0xde, 0xad, 0xbe], frame.length);
  assert.throws(
    () => decodeFrame(trailing),
    err => err instanceof ClaimsFrameError && err.code === 'TRAILING_BYTES',
  );
  const decoder = createFrameDecoder();
  assert.throws(
    () => decoder.push(trailing),
    err => err instanceof ClaimsFrameError && err.code === 'TRAILING_BYTES',
  );
  const two = new Uint8Array(frame.length * 2);
  two.set(frame, 0);
  two.set(frame, frame.length);
  assert.throws(
    () => decodeFrame(two),
    err => err.code === 'TRAILING_BYTES',
  );
  const decoder2 = createFrameDecoder();
  decoder2.push(frame);
  assert.throws(
    () => decoder2.push(frame),
    err => err.code === 'MULTIPLE_FRAMES',
  );
});

test('invalid header fields', () => {
  const wire = encodeFrame(baseFields());
  const tamper = index => {
    const copy = Uint8Array.from(wire);
    copy[index] ^= 0xff;
    return copy;
  };
  assert.throws(() => decodeFrame(tamper(0)), err => err.code === 'INVALID_MAGIC');
  assert.throws(() => decodeFrame(tamper(4)), err => err.code === 'INVALID_VERSION');
  assert.throws(() => decodeFrame(tamper(5)), err => err.code === 'INVALID_HEADER');
  assert.throws(() => decodeFrame(tamper(6)), err => err.code === 'INVALID_HEADER');
  assert.throws(() => decodeFrame(tamper(7)), err => err.code === 'INVALID_HEADER');
  const length = new Uint8Array(wire);
  length[40] = 0xff;
  length[41] = 0xff;
  length[42] = 0xff;
  length[43] = 0xff;
  assert.throws(() => decodeFrame(length), err => err.code === 'OVERSIZED_BODY');
});

test('correlation mismatch fails closed', () => {
  const wire = encodeFrame(baseFields());
  assert.throws(
    () => decodeFrame(wire, {expectedCorrelation: OTHER_CORRELATION}),
    err => err.code === 'CORRELATION_MISMATCH',
  );
  const decoder = createFrameDecoder({expectedCorrelation: OTHER_CORRELATION});
  assert.throws(() => decoder.push(wire), err => err.code === 'CORRELATION_MISMATCH');
});

test('input mutation after submission does not change decode', () => {
  const body = new Uint8Array([1, 2, 3]);
  const wire = encodeFrame(baseFields({body}));
  const decoded = decodeFrame(wire);
  body[0] = 0xff;
  wire[HEADER_SIZE] = 0xff;
  assert.deepEqual(decoded.body, Uint8Array.from([1, 2, 3]));
});

test('rejects hostile proxies getters and exotic views', () => {
  const getterFields = {
    kind: KIND.REQUEST,
    operation: OPERATION.DISPATCH,
    status: STATUS.ACCEPTED,
    correlation: CORRELATION,
    body: new Uint8Array([1]),
    get extra() {
      throw new Error('getter');
    },
  };
  assert.throws(() => encodeFrame(getterFields), err => err.code === 'INVALID_FIELDS');

  const proxyBody = new Proxy(new Uint8Array([1]), {
    get(target, prop) {
      if (prop === 'length') throw new Error('proxy length');
      return Reflect.get(target, prop);
    },
  });
  assert.throws(() => encodeFrame(baseFields({body: proxyBody})), err => err.code === 'INVALID_INPUT');

  const proxyView = new Proxy(new Uint8Array([1, 2, 3]), {});
  assert.throws(() => decodeFrame(proxyView), err => err.code === 'INVALID_INPUT');
});

test('rejects detached buffer and shared memory backing', () => {
  const tmp = new Uint8Array([1, 2, 3, 4]);
  if (tmp.buffer.transfer) {
    tmp.buffer.transfer();
    assert.throws(() => decodeFrame(tmp), err => err.code === 'INVALID_INPUT');
  }
  if (typeof SharedArrayBuffer !== 'undefined') {
    const sab = new SharedArrayBuffer(8);
    const shared = new Uint8Array(sab);
    assert.throws(() => decodeFrame(shared), err => err.code === 'INVALID_INPUT');
    assert.throws(() => encodeFrame(baseFields({body: shared})), err => err.code === 'INVALID_INPUT');
  }
  class EvilBytes extends Uint8Array {}
  assert.throws(
    () => encodeFrame(baseFields({body: new EvilBytes([1])})),
    err => err.code === 'INVALID_INPUT',
  );
});

test('privacy-safe errors omit caller content', () => {
  try {
    decodeFrame(new Uint8Array([0, 0, 0, 0]));
  } catch (error) {
    assertPrivacySafe(error);
    assert.equal(error.message.includes('0'), false);
  }
});

test('decoder overflow bound', () => {
  const wire = encodeFrame(baseFields({body: new Uint8Array(64)}));
  const decoder = createFrameDecoder();
  decoder.push(wire.subarray(0, HEADER_SIZE));
  assert.throws(
    () => decoder.push(new Uint8Array(MAX_FRAME_BYTES)),
    err => err.code === 'DECODER_OVERFLOW',
  );
});