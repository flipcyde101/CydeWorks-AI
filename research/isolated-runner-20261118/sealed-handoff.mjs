// Controller-side contract for the sealed project/artifact handoff (research, disconnected).
//
// The Linux reader in sealed_handoff.py owns the trusted directory handles and emits a
// CWSEAL1 byte stream. This module independently re-verifies that stream against an
// expected seal digest and exposes it to downstream consumers only as bytes. It never
// returns or accepts a filesystem path, so nothing downstream can re-resolve one.
//
// The seal digest is byte integrity only. It is not owner approval, host attestation, root
// identity or replay protection. The expected digest is caller supplied here; a trusted host
// must supply it independently before any authorization or provenance claim is made. The
// bundle is not a whole-tree point-in-time filesystem snapshot.
//
// Not imported by harness/, the browser, production approval/auth code or the live runner.
import {createHash} from 'node:crypto';

export const SEAL_MAGIC = Buffer.from('CWSEAL1\0', 'latin1');
const KIND_DIR = 1;
const KIND_FILE = 2;
const DIGEST_LEN = 32;
export const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 4096,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxDepth: 32,
  maxPathBytes: 1024,
});

const sealed = new WeakMap();
// ignoreBOM keeps a leading U+FEFF instead of silently stripping it, so decoding preserves
// the exact path bytes; validatePath then rejects U+FEFF, matching sealed_handoff.py.
const utf8 = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const FILE_HEAD = 5 + 8 + DIGEST_LEN;

export function maxFrameBytes(limits) {
  return SEAL_MAGIC.length + 4 + limits.maxEntries * (FILE_HEAD + limits.maxPathBytes) + limits.maxTotalBytes + DIGEST_LEN;
}

export class SealError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new SealError(code, message);
}

function validatePath(path, limits) {
  const parts = path.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..' || /[\\:\u0000-\u001f\u007f\ufeff]/.test(part) ||
        Buffer.byteLength(part) > 255) {
      fail('SEALED_PATH_INVALID', 'Sealed entry path is not a safe relative path.');
    }
  }
  if (Buffer.byteLength(path) > limits.maxPathBytes) fail('SEALED_PATH_INVALID', 'Sealed entry path is too long.');
  if (parts.length > limits.maxDepth) fail('SEALED_LIMIT_EXCEEDED', 'Sealed entry path is too deep.');
}

const sha256 = data => createHash('sha256').update(data).digest();

// Intrinsics captured at module load. Caller-visible properties such as `buffer`, `length`,
// `byteOffset` and `byteLength` can be shadowed on a genuine Uint8Array, so they are never
// read. These getters use the typed array's internal slots instead. (Code that rewrites
// built-in prototypes before this module loads is outside this module's trust boundary.)
const TypedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsic = (proto, key) => Object.getOwnPropertyDescriptor(proto, key).get;
const taTag = intrinsic(TypedArrayProto, Symbol.toStringTag);
const taBuffer = intrinsic(TypedArrayProto, 'buffer');
const taByteOffset = intrinsic(TypedArrayProto, 'byteOffset');
const taByteLength = intrinsic(TypedArrayProto, 'byteLength');
const taSet = TypedArrayProto.set;
const abByteLength = intrinsic(ArrayBuffer.prototype, 'byteLength');
const sabByteLength = typeof SharedArrayBuffer === 'function'
  ? intrinsic(SharedArrayBuffer.prototype, 'byteLength') : null;
const IntrinsicArrayBuffer = ArrayBuffer;
const IntrinsicUint8Array = Uint8Array;
const bufferFromArrayBuffer = Buffer.from;
const ReflectApply = Reflect.apply;

function isArrayBuffer(value) {
  try { ReflectApply(abByteLength, value, []); return true; } catch { return false; }
}

function isSharedArrayBuffer(value) {
  if (!sabByteLength) return false;
  try { ReflectApply(sabByteLength, value, []); return true; } catch { return false; }
}

/**
 * Genuine bounded copy of caller bytes into storage only this module owns.
 * Accepts only a real Uint8Array (including Buffer) over a non-shared ArrayBuffer; checks
 * the size cap on the intrinsic byte length before any copy; never returns or retains a
 * view of the caller's backing store.
 */
function copyCallerBytes(raw, cap) {
  // %TypedArray%.prototype[@@toStringTag] returns undefined for non-typed-arrays (including
  // Proxies and look-alikes) and reads the internal [[TypedArrayName]] slot otherwise.
  if (ReflectApply(taTag, raw, []) !== 'Uint8Array') fail('SEALED_BUNDLE_INVALID', 'Sealed bundle must be a Uint8Array.');
  const backing = ReflectApply(taBuffer, raw, []);
  if (isSharedArrayBuffer(backing) || !isArrayBuffer(backing)) {
    fail('SEALED_BUNDLE_INVALID', 'Sealed bundle must not use shared or foreign backing storage.');
  }
  const length = ReflectApply(taByteLength, raw, []); // 0 when detached
  const offset = ReflectApply(taByteOffset, raw, []);
  if (length > cap) fail('SEALED_LIMIT_EXCEEDED', 'Sealed bundle exceeds the frame limit.');
  if (length < SEAL_MAGIC.length + 4 + DIGEST_LEN) fail('SEALED_BUNDLE_INVALID', 'Sealed bundle is truncated.');
  return ownedCopy(new IntrinsicUint8Array(backing, offset, length));
}

/** Copy into a fresh, unpooled ArrayBuffer that no other view references. */
function ownedCopy(source) {
  const length = ReflectApply(taByteLength, source, []);
  const owned = new IntrinsicArrayBuffer(length);
  ReflectApply(taSet, new IntrinsicUint8Array(owned), [source]);
  if (ReflectApply(abByteLength, owned, []) !== length) fail('SEALED_BUNDLE_INVALID', 'Sealed byte copy failed.');
  return ReflectApply(bufferFromArrayBuffer, Buffer, [owned, 0, length]);
}

/**
 * Decode and fully verify a CWSEAL1 stream. Returns an opaque frozen handle that only this
 * module can unwrap. `expectedSealDigest` is caller supplied; matching it proves byte
 * integrity, not approval or provenance.
 */
export function decodeSealedBundle(raw, {expectedSealDigest, limits: overrides} = {}) {
  const limits = {...DEFAULT_LIMITS, ...overrides};
  if (typeof expectedSealDigest !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSealDigest)) {
    fail('SEALED_EXPECTED_DIGEST_REQUIRED', 'An independently supplied expected seal digest is required.');
  }
  const buf = copyCallerBytes(raw, maxFrameBytes(limits));
  if (!buf.subarray(0, SEAL_MAGIC.length).equals(SEAL_MAGIC)) fail('SEALED_BUNDLE_INVALID', 'Unknown sealed bundle format.');
  let pos = SEAL_MAGIC.length;
  const need = n => { if (pos + n > buf.length) fail('SEALED_BUNDLE_INVALID', 'Sealed bundle manifest is truncated.'); };
  need(4);
  const count = buf.readUInt32BE(pos);
  pos += 4;
  if (count > limits.maxEntries) fail('SEALED_LIMIT_EXCEEDED', 'Too many sealed entries.');
  const heads = [];
  for (let i = 0; i < count; i++) {
    need(5);
    const kind = buf.readUInt8(pos);
    const plen = buf.readUInt32BE(pos + 1);
    pos += 5;
    if (plen > limits.maxPathBytes) fail('SEALED_BUNDLE_INVALID', 'Sealed entry path is malformed.');
    need(plen);
    const pathBytes = buf.subarray(pos, pos + plen);
    let path;
    try { path = utf8.decode(pathBytes); } catch { fail('SEALED_PATH_INVALID', 'Sealed entry path is not UTF-8.'); }
    pos += plen;
    if (kind === KIND_FILE) {
      need(8 + DIGEST_LEN);
      const size = buf.readBigUInt64BE(pos);
      if (size > BigInt(limits.maxFileBytes)) fail('SEALED_LIMIT_EXCEEDED', 'Sealed file is too large.');
      const digest = Buffer.from(buf.subarray(pos + 8, pos + 8 + DIGEST_LEN));
      pos += 8 + DIGEST_LEN;
      heads.push({kind, path, pathBytes, size: Number(size), digest});
    } else if (kind === KIND_DIR) {
      heads.push({kind, path, pathBytes, size: 0, digest: null});
    } else {
      fail('SEALED_BUNDLE_INVALID', 'Unsupported sealed entry kind.');
    }
  }
  const manifestEnd = pos;
  const sealDigest = sha256(buf.subarray(0, manifestEnd));
  const total = heads.reduce((sum, h) => sum + h.size, 0);
  if (total > limits.maxTotalBytes) fail('SEALED_LIMIT_EXCEEDED', 'Sealed bundle is too large.');
  if (buf.length !== manifestEnd + total + DIGEST_LEN || !buf.subarray(buf.length - DIGEST_LEN).equals(sealDigest)) {
    fail('SEALED_DIGEST_MISMATCH', 'Sealed bundle framing or digest is wrong.');
  }
  if (sealDigest.toString('hex') !== expectedSealDigest) {
    fail('SEALED_DIGEST_MISMATCH', 'Sealed bundle is not the expected seal.');
  }
  const kinds = new Map();
  const folded = new Set();
  const files = new Map();
  let previous = null;
  for (const h of heads) {
    validatePath(h.path, limits);
    if (previous && Buffer.compare(previous, h.pathBytes) >= 0) {
      fail('SEALED_BUNDLE_INVALID', 'Sealed entries are not in strict canonical order.');
    }
    previous = h.pathBytes;
    const slash = h.path.lastIndexOf('/');
    if (slash >= 0 && kinds.get(h.path.slice(0, slash)) !== KIND_DIR) {
      fail('SEALED_BUNDLE_INVALID', 'Sealed entry parent is not a sealed directory.');
    }
    const key = h.path.toLowerCase();
    if (folded.has(key)) fail('SEALED_CASE_COLLISION', 'Sealed entries collide without case.');
    folded.add(key);
    kinds.set(h.path, h.kind);
    if (h.kind === KIND_FILE) {
      const data = buf.subarray(pos, pos + h.size);
      pos += h.size;
      if (!sha256(data).equals(h.digest)) fail('SEALED_BUNDLE_INVALID', 'Sealed file content does not match its digest.');
      files.set(h.path, data);
    }
  }
  const handle = Object.freeze({
    sealDigest: sealDigest.toString('hex'),
    entries: Object.freeze(heads.map(h => Object.freeze({
      kind: h.kind === KIND_DIR ? 'dir' : 'file',
      path: h.path,
      size: h.size,
      sha256: h.digest ? h.digest.toString('hex') : null,
    }))),
  });
  sealed.set(handle, {bytes: buf, files});
  return handle;
}

/** Downstream consumers call this first. Strings, paths and look-alike objects are refused. */
export function requireSealedBundle(value) {
  if (typeof value !== 'object' || value === null || !sealed.has(value)) {
    fail('SEALED_HANDOFF_REQUIRED', 'Consumers accept only a verified sealed bundle, never a pathname.');
  }
  return value;
}

/** A copy of one sealed file's bytes. */
export function readSealedFile(bundle, path) {
  const data = sealed.get(requireSealedBundle(bundle)).files.get(path);
  if (!data) fail('SEALED_ENTRY_MISSING', 'The sealed bundle has no such file.');
  return ownedCopy(data);
}

/**
 * The exact verified stream to send to a sandboxed consumer over stdin. The consumer decodes
 * it again and materializes it through handles it creates (sealed_handoff.materialize_bundle).
 */
export function sealedConsumerInput(bundle) {
  return ownedCopy(sealed.get(requireSealedBundle(bundle)).bytes);
}

/**
 * Which handle owner may seal on this host. Fails closed unless the platform has a qualified
 * handle-relative, no-follow reader. Windows hosts are unqualified: Node has no openat or
 * O_NOFOLLOW there, and WSL drvfs (9p) handle semantics have not passed Windows qualification.
 */
export function planSealedReader({platform = process.platform, windowsQualification = null} = {}) {
  if (platform === 'linux') return Object.freeze({reader: 'posix-openat', module: 'sealed_handoff.py'});
  if (platform === 'win32') {
    void windowsQualification; // intentionally ignored until a reviewed qualification record format exists
    fail('SEALED_HANDOFF_UNQUALIFIED', 'Windows sealed handoff is not qualified; failing closed.');
  }
  fail('SEALED_HANDOFF_UNSUPPORTED', 'This platform has no qualified sealed reader; failing closed.');
}
