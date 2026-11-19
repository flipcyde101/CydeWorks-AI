/**
 * Disconnected CydeWorks claims-supervisor binary frame codec (v2).
 *
 * Research only. Not imported by harness/, pilot.mjs, or live runner paths.
 * Encodes opaque bytes only. It does not parse JSON, launch processes, touch
 * the filesystem or network, hold credentials, authorize registry transitions,
 * or validate body semantics.
 *
 * Wire layout (little-endian multi-byte fields):
 *
 *   Offset  Size  Field
 *   0       4     magic ASCII CYDF (0x43, 0x59, 0x44, 0x46)
 *   4       1     version (must be 1)
 *   5       1     kind (KIND_* allowlist)
 *   6       1     operation (OP_* allowlist)
 *   7       1     status (STATUS_* allowlist)
 *   8       32    correlation (opaque fixed-width bytes)
 *   40      4     bodyLength (uint32 LE)
 *   44      N     body (N = bodyLength opaque bytes)
 *
 * HEADER_SIZE = 44 bytes.
 * MAX_FRAME_BYTES = 8192 bytes (header + body).
 * MAX_BODY_BYTES = MAX_FRAME_BYTES - HEADER_SIZE = 8148 bytes.
 *
 * A decoded body is an owned byte copy. It is not schema-validated and does
 * not imply authorization of any registry or supervisor operation.
 */

import {timingSafeEqual} from 'node:crypto';
import {types} from 'node:util';

export const SCHEMA = 'cydeworks.claims-frame/2';
export const HEADER_SIZE = 44;
export const MAX_FRAME_BYTES = 8192;
export const MAX_BODY_BYTES = MAX_FRAME_BYTES - HEADER_SIZE;
export const CORRELATION_BYTES = 32;

const MAGIC = new Uint8Array([0x43, 0x59, 0x44, 0x46]); // CYDF

export const KIND = Object.freeze({
  REQUEST: 1,
  RESPONSE: 2,
  NOTIFY: 3,
});

export const OPERATION = Object.freeze({
  RESERVE: 1,
  DISPATCH: 2,
  CONTINUE: 3,
  COMPLETE: 4,
  ABORT: 5,
});

export const STATUS = Object.freeze({
  UNSPECIFIED: 0,
  ACCEPTED: 1,
  REJECTED: 2,
  PARTIAL: 3,
});

const KIND_ALLOW = new Set(Object.values(KIND));
const OP_ALLOW = new Set(Object.values(OPERATION));
const STATUS_ALLOW = new Set(Object.values(STATUS));

export const LIMITATIONS = Object.freeze([
  'This module is a bounded binary frame codec only. It is not a process deadline, OS sandbox, durable replay log, safe registry boundary, or Windows qualification.',
  'Body bytes are opaque. The codec does not validate schemas, deduplicate semantics, or authorize supervisor or registry operations.',
  'Streaming decode accepts at most one complete frame per decoder instance; trailing bytes and multiple frames fail closed.',
]);

const MESSAGES = Object.freeze({
  INVALID_INPUT: 'Claims frame input is invalid.',
  INVALID_FIELDS: 'Claims frame fields are invalid.',
  OVERSIZED_INPUT: 'Claims frame input exceeds the bounded size.',
  INVALID_MAGIC: 'Claims frame header magic is invalid.',
  INVALID_VERSION: 'Claims frame header version is invalid.',
  INVALID_HEADER: 'Claims frame header field is invalid.',
  OVERSIZED_BODY: 'Claims frame declared body exceeds the bounded size.',
  OVERSIZED_FRAME: 'Claims frame exceeds the bounded size.',
  TRUNCATED: 'Claims frame input is truncated.',
  TRAILING_BYTES: 'Claims frame has trailing bytes.',
  MULTIPLE_FRAMES: 'Claims frame stream contains multiple frames.',
  CORRELATION_MISMATCH: 'Claims frame correlation does not match.',
  DECODER_OVERFLOW: 'Claims frame decoder buffer exceeds the bounded size.',
});

export class ClaimsFrameError extends Error {
  constructor(code) {
    const message = MESSAGES[code] ?? MESSAGES.INVALID_INPUT;
    super(message);
    this.name = 'ClaimsFrameError';
    this.code = code;
  }
}

const fail = code => {
  throw new ClaimsFrameError(code);
};

const uint8Prototype = Uint8Array.prototype;
const bufferPrototype = typeof Buffer !== 'undefined' ? Buffer.prototype : null;
const typedArrayPrototype = Object.getPrototypeOf(uint8Prototype);
const getBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const getByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const getByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function viewMetrics(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || types.isDataView(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== uint8Prototype && (bufferPrototype === null || proto !== bufferPrototype)) return null;
  let backing;
  let offset;
  let length;
  try {
    backing = getBuffer.call(value);
    offset = getByteOffset.call(value);
    length = getByteLength.call(value);
  } catch {
    return null;
  }
  if (backing === null || typeof backing !== 'object' || types.isSharedArrayBuffer(backing)) return null;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0) return null;
  return {backing, offset, length};
}

function copyBytesView(value, maxLength) {
  const metrics = viewMetrics(value);
  if (!metrics) fail('INVALID_INPUT');
  const {backing, offset, length} = metrics;
  if (length > maxLength) fail('OVERSIZED_INPUT');
  try {
    const owned = new Uint8Array(length);
    owned.set(new Uint8Array(backing, offset, length));
    return owned;
  } catch {
    fail('INVALID_INPUT');
  }
}

function readField(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_FIELDS');
  return descriptor.value;
}

function assertEnum(value, allow, code = 'INVALID_FIELDS') {
  if (!Number.isInteger(value) || !allow.has(value)) fail(code);
}

function assertCorrelationBytes(correlation) {
  const bytes = copyBytesView(correlation, CORRELATION_BYTES);
  if (bytes.length !== CORRELATION_BYTES) fail('INVALID_FIELDS');
  return bytes;
}

function compareCorrelation(a, b) {
  if (a.length !== CORRELATION_BYTES || b.length !== CORRELATION_BYTES) return false;
  return timingSafeEqual(a, b);
}

function parseHeader(view) {
  if (view.length < HEADER_SIZE) return null;
  for (let i = 0; i < 4; i += 1) {
    if (view[i] !== MAGIC[i]) fail('INVALID_MAGIC');
  }
  const version = view[4];
  if (version !== 1) fail('INVALID_VERSION');
  const kind = view[5];
  const operation = view[6];
  const status = view[7];
  assertEnum(kind, KIND_ALLOW, 'INVALID_HEADER');
  assertEnum(operation, OP_ALLOW, 'INVALID_HEADER');
  assertEnum(status, STATUS_ALLOW, 'INVALID_HEADER');
  const correlation = view.slice(8, 8 + CORRELATION_BYTES);
  const bodyLength = view[8 + CORRELATION_BYTES]
    | (view[9 + CORRELATION_BYTES] << 8)
    | (view[10 + CORRELATION_BYTES] << 16)
    | (view[11 + CORRELATION_BYTES] << 24);
  if (!Number.isInteger(bodyLength) || bodyLength < 0 || bodyLength > MAX_BODY_BYTES) fail('OVERSIZED_BODY');
  const frameSize = HEADER_SIZE + bodyLength;
  if (frameSize > MAX_FRAME_BYTES) fail('OVERSIZED_FRAME');
  return {kind, operation, status, correlation, bodyLength, frameSize};
}

function freezeDecoded(frame) {
  return Object.freeze({
    kind: frame.kind,
    operation: frame.operation,
    status: frame.status,
    correlation: frame.correlation,
    body: frame.body,
  });
}

/**
 * Encode one frame into a fresh Uint8Array (owned, detached from caller memory).
 */
export function encodeFrame(fields) {
  if (fields === undefined) fail('INVALID_FIELDS');
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields) || types.isProxy(fields)) {
    fail('INVALID_FIELDS');
  }
  const source = fields;
  if (!isPlainObject(source)) fail('INVALID_FIELDS');
  const keys = Reflect.ownKeys(source);
  for (const key of keys) {
    if (typeof key !== 'string') fail('INVALID_FIELDS');
    if (!['kind', 'operation', 'status', 'correlation', 'body'].includes(key)) fail('INVALID_FIELDS');
  }

  const kind = readField(source, 'kind');
  const operation = readField(source, 'operation');
  const status = readField(source, 'status');
  const correlation = assertCorrelationBytes(readField(source, 'correlation'));
  let body = new Uint8Array(0);
  if (Object.hasOwn(source, 'body')) {
    body = copyBytesView(readField(source, 'body'), MAX_BODY_BYTES);
  }

  assertEnum(kind, KIND_ALLOW);
  assertEnum(operation, OP_ALLOW);
  assertEnum(status, STATUS_ALLOW);

  const out = new Uint8Array(HEADER_SIZE + body.length);
  out.set(MAGIC, 0);
  out[4] = 1;
  out[5] = kind;
  out[6] = operation;
  out[7] = status;
  out.set(correlation, 8);
  out[40] = body.length & 0xff;
  out[41] = (body.length >> 8) & 0xff;
  out[42] = (body.length >> 16) & 0xff;
  out[43] = (body.length >> 24) & 0xff;
  if (body.length) out.set(body, HEADER_SIZE);
  return out;
}

/**
 * Decode exactly one frame. Rejects trailing bytes and optional correlation mismatch.
 */
export function decodeFrame(input, options = undefined) {
  const bytes = copyBytesView(input, MAX_FRAME_BYTES);
  const parsed = parseHeader(bytes);
  if (!parsed) fail('TRUNCATED');
  const {bodyLength, frameSize, kind, operation, status, correlation} = parsed;
  if (bytes.length < frameSize) fail('TRUNCATED');
  if (bytes.length > frameSize) fail('TRAILING_BYTES');
  const body = bytes.slice(HEADER_SIZE, frameSize);

  let expected = null;
  if (options !== undefined) {
    if (!isPlainObject(options) || types.isProxy(options)) fail('INVALID_INPUT');
    if (Reflect.ownKeys(options).length !== 1 || !Object.hasOwn(options, 'expectedCorrelation')) fail('INVALID_INPUT');
    expected = assertCorrelationBytes(readField(options, 'expectedCorrelation'));
    if (!compareCorrelation(correlation, expected)) fail('CORRELATION_MISMATCH');
  }

  return freezeDecoded({
    kind,
    operation,
    status,
    correlation: Uint8Array.from(correlation),
    body: Uint8Array.from(body),
  });
}

/**
 * Incremental decoder for a single bounded frame. Fails closed on multiple frames.
 */
export function createFrameDecoder(options = undefined) {
  let expected = null;
  if (options !== undefined) {
    if (!isPlainObject(options) || types.isProxy(options)) fail('INVALID_INPUT');
    const keys = Reflect.ownKeys(options);
    if (keys.length !== 1 || keys[0] !== 'expectedCorrelation') fail('INVALID_INPUT');
    expected = assertCorrelationBytes(readField(options, 'expectedCorrelation'));
  }

  let buffer = new Uint8Array(0);
  let completed = false;

  const append = chunk => {
    if (completed) fail('MULTIPLE_FRAMES');
    const piece = copyBytesView(chunk, MAX_FRAME_BYTES);
    const nextLen = buffer.length + piece.length;
    if (nextLen > MAX_FRAME_BYTES) fail('DECODER_OVERFLOW');
    const merged = new Uint8Array(nextLen);
    merged.set(buffer, 0);
    merged.set(piece, buffer.length);
    buffer = merged;
  };

  return {
  push(chunk) {
    if (chunk === undefined) fail('INVALID_INPUT');
    append(chunk);
    let parsed;
    try {
      parsed = parseHeader(buffer);
    } catch (error) {
      buffer = new Uint8Array(0);
      throw error;
    }
    if (!parsed) return null;
    const {frameSize, kind, operation, status, correlation} = parsed;
    if (buffer.length < frameSize) return null;
    if (buffer.length > frameSize) fail('TRAILING_BYTES');
    if (expected && !compareCorrelation(correlation, expected)) fail('CORRELATION_MISMATCH');
    const body = buffer.slice(HEADER_SIZE, frameSize);
    completed = true;
    buffer = new Uint8Array(0);
    return freezeDecoded({
      kind,
      operation,
      status,
      correlation: Uint8Array.from(correlation),
      body: Uint8Array.from(body),
    });
  },

  end() {
    if (completed) return;
    if (buffer.length === 0) fail('TRUNCATED');
    fail('TRUNCATED');
  },

  reset() {
    buffer = new Uint8Array(0);
    completed = false;
  },
  };
}