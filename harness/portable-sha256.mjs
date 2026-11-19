// Pure dependency-free FIPS 180-4 SHA-256 implementation and trusted Uint8Array
// validation for bounded in-memory artifact byte verification.
// No Node built-in modules, network, filesystem, or I/O.

import { LIMITS } from './portable-manifest-contract.mjs';

const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getTypedArrayBuffer = Object.getOwnPropertyDescriptor(TypedArrayPrototype, 'buffer').get;
const getTypedArrayByteLength = Object.getOwnPropertyDescriptor(TypedArrayPrototype, 'byteLength').get;
const getTypedArrayByteOffset = Object.getOwnPropertyDescriptor(TypedArrayPrototype, 'byteOffset').get;
const getTypedArrayLength = Object.getOwnPropertyDescriptor(TypedArrayPrototype, 'length').get;
const getTypedArrayToStringTag = Object.getOwnPropertyDescriptor(TypedArrayPrototype, Symbol.toStringTag).get;
const atTypedArray = TypedArrayPrototype.at;

const getArrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const getArrayBufferDetached = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached')?.get ?? null;

const sharedTextEncoder = new TextEncoder();

const K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

// Validates that value is a genuine, non-detached, in-bounds Uint8Array backed
// by an ArrayBuffer, within LIMITS.maxArtifactBytes, and carrying no spoofed or
// extra own properties. Uses captured %TypedArray%.prototype.at(0) and
// intrinsic getters so constructor, Symbol.species, iterator, and caller-defined
// property getters are never invoked.
export function isBoundedUint8Array(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (Object.getPrototypeOf(value) !== Uint8Array.prototype) {
    return false;
  }
  if (getTypedArrayToStringTag.call(value) !== 'Uint8Array') {
    return false;
  }
  if (
    Object.hasOwn(value, 'byteLength') ||
    Object.hasOwn(value, 'byteOffset') ||
    Object.hasOwn(value, 'length') ||
    Object.hasOwn(value, 'buffer') ||
    Object.hasOwn(value, 'constructor')
  ) {
    return false;
  }

  let buffer;
  let byteLength;
  let byteOffset;
  let length;
  let bufferByteLength;
  try {
    buffer = getTypedArrayBuffer.call(value);
    if (!buffer || typeof buffer !== 'object' || Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) {
      return false;
    }
    if (Reflect.ownKeys(buffer).length !== 0) {
      return false;
    }
    if (getArrayBufferDetached && getArrayBufferDetached.call(buffer) === true) {
      return false;
    }
    // ValidateTypedArray via captured %TypedArray%.prototype.at(0) throws
    // TypeError when the viewed ArrayBuffer is detached (even if 0-length) or
    // when a resizable ArrayBuffer has been shrunk out of bounds, without
    // resolving constructor, Symbol.species, or iterators.
    atTypedArray.call(value, 0);
    byteLength = getTypedArrayByteLength.call(value);
    byteOffset = getTypedArrayByteOffset.call(value);
    length = getTypedArrayLength.call(value);
    bufferByteLength = getArrayBufferByteLength.call(buffer);
  } catch {
    return false;
  }

  if (
    !Number.isSafeInteger(byteLength) ||
    !Number.isSafeInteger(byteOffset) ||
    !Number.isSafeInteger(length) ||
    !Number.isSafeInteger(bufferByteLength) ||
    byteLength < 0 ||
    byteOffset < 0 ||
    byteLength > LIMITS.maxArtifactBytes ||
    byteLength !== length ||
    byteOffset + byteLength > bufferByteLength
  ) {
    return false;
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== byteLength) {
    return false;
  }
  return true;
}

export function getUint8ArrayByteLength(bytes) {
  if (!isBoundedUint8Array(bytes)) {
    throw new TypeError('Expected a bounded non-detached Uint8Array.');
  }
  return getTypedArrayByteLength.call(bytes);
}

// Encodes a string into UTF-8 bytes using standard TextEncoder semantics
// (replacing any lone high or low UTF-16 surrogate with U+FFFD = EF BF BD).
export function utf8Bytes(text) {
  if (typeof text !== 'string') {
    throw new TypeError('Expected a string to encode.');
  }
  return sharedTextEncoder.encode(text);
}

export function sha256Hex(bytes) {
  if (!isBoundedUint8Array(bytes)) {
    throw new TypeError('Expected a bounded non-detached Uint8Array.');
  }
  const byteLength = getTypedArrayByteLength.call(bytes);
  const bitLenHi = Math.floor((byteLength * 8) / 0x100000000);
  const bitLenLo = (byteLength * 8) >>> 0;
  const totalLen = (((byteLength + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(totalLen);
  for (let i = 0; i < byteLength; i++) {
    padded[i] = bytes[i];
  }
  padded[byteLength] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(totalLen - 8, bitLenHi, false);
  view.setUint32(totalLen - 4, bitLenLo, false);

  let h0 = H0[0];
  let h1 = H0[1];
  let h2 = H0[2];
  let h3 = H0[3];
  let h4 = H0[4];
  let h5 = H0[5];
  let h6 = H0[6];
  let h7 = H0[7];

  const w = new Uint32Array(64);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}
