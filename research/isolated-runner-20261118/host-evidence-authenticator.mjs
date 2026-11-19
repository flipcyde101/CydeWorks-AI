import {createHmac, createHash, timingSafeEqual} from 'node:crypto';
import {types as utilTypes} from 'node:util';

/**
 * Host-side authenticator for the disconnected fixed-synthetic verifier.
 *
 * The controller is created by the host before untrusted evidence is read.
 * It holds the invocation nonce the host issued, the HMAC key the host
 * holds in memory, and the claim the host already resolved from its own
 * store. Received evidence is not authority for any of those.
 *
 * Authentication uses the Python verifier's canonical HMAC-SHA256 format:
 * json.dumps(signable, separators=(",", ":"), ensure_ascii=False), where
 * signable is every evidence field except provenance, then provenance
 * reduced to claimBound and invocationNonce. A plain object with
 * trusted=true is not proof.
 *
 * The key is kept in a module WeakMap. This file does not write it to
 * logs, child arguments, the environment, or the filesystem.
 * Nonce acceptance is single-use for one controller instance. There is
 * no durable cross-process replay store.
 */

export const VERIFIER_SCOPE = 'fixed-synthetic-only';
export const VERIFIER_TARGET = 'limits.py+measurement.py';
export const VERIFIER_VERSION = 'protected-fixture-verifier-ast-v2';
export const APPROVED_FILES = Object.freeze(['limits.py', 'measurement.py']);

const MIN_HMAC_KEY_BYTES = 16;
const MAX_HMAC_KEY_BYTES = 256;
const MAX_STEPS_PER_CASE = 256;
const MAX_EVIDENCE_NODES = 4000;
const MAX_EVIDENCE_DEPTH = 32;
const MAX_EVIDENCE_STRING = 4096;
const MAX_EVIDENCE_JSON_BYTES = 65536;

const HEX_REV_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const CLAIM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NONCE_RE = /^[A-Za-z0-9._-]{16,128}$/;
const SCOPE_KEYS = Object.freeze(['files', 'baseRevision', 'baseFileDigests', 'casesDigest', 'totalCases']);
const CASE_ROW_KEYS = Object.freeze(['actual', 'case', 'expected', 'function', 'passed', 'steps']);

export const FIXED_CASES = Object.freeze([
  Object.freeze(['clamp', -8, 0]),
  Object.freeze(['clamp', 0, 0]),
  Object.freeze(['clamp', 56, 56]),
  Object.freeze(['clamp', 100, 100]),
  Object.freeze(['clamp', 164, 100]),
  Object.freeze(['normalize', '-12', 0]),
  Object.freeze(['normalize', ' 42 ', 42]),
  Object.freeze(['normalize', '150', 100]),
  Object.freeze(['normalize', 75, 75]),
  Object.freeze(['normalize', 'bad', 0]),
  Object.freeze(['normalize', null, 0]),
  Object.freeze(['normalize', '', 0]),
]);

const controllers = new WeakMap();

function isPlainObj(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function canonicalString(value) {
  if (typeof value !== 'string' || value.length > MAX_EVIDENCE_STRING) {
    throw new Error('Verifier evidence exceeds the fixed fixture bound.');
  }
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

export function canonicalJson(value, depth = 0, budget = {nodes: 0}) {
  if (depth > MAX_EVIDENCE_DEPTH || ++budget.nodes > MAX_EVIDENCE_NODES) {
    throw new Error('Verifier evidence exceeds the fixed fixture bound.');
  }
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'boolean') return value ? 'true' : 'false';
  if (kind === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error('Verifier evidence contains a non-integer number.');
    }
    const text = JSON.stringify(value);
    if (!/^-?(?:0|[1-9]\d*)$/.test(text)) throw new Error('Verifier evidence contains a non-integer number.');
    return text;
  }
  if (kind === 'string') return canonicalString(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item, depth + 1, budget)).join(',')}]`;
  }
  if (!isPlainObj(value)) throw new Error('Verifier evidence contains an unsupported value.');
  const parts = [];
  for (const key of Object.keys(value)) {
    parts.push(`${canonicalString(key)}:${canonicalJson(value[key], depth + 1, budget)}`);
  }
  return `{${parts.join(',')}}`;
}

function copyKey(attestationKey) {
  if (typeof attestationKey === 'string' || utilTypes.isProxy(attestationKey) ||
      !ArrayBuffer.isView(attestationKey) || utilTypes.isDataView(attestationKey)) {
    throw new Error('Host attestation key is invalid.');
  }
  const copy = Buffer.from(attestationKey.buffer, attestationKey.byteOffset, attestationKey.byteLength);
  if (copy.length < MIN_HMAC_KEY_BYTES || copy.length > MAX_HMAC_KEY_BYTES) {
    throw new Error('Host attestation key is invalid.');
  }
  return copy;
}

function signableCanonical(evidence) {
  const signable = {};
  for (const key of Object.keys(evidence)) {
    if (key !== 'provenance') signable[key] = evidence[key];
  }
  if (isPlainObj(evidence.provenance)) {
    signable.provenance = {
      claimBound: evidence.provenance.claimBound,
      invocationNonce: evidence.provenance.invocationNonce,
    };
  }
  return canonicalJson(signable);
}

export function canonicalAttestationHmac(evidence, attestationKey) {
  if (!isPlainObj(evidence)) throw new Error('Missing or malformed verifier evidence.');
  const key = copyKey(attestationKey);
  return createHmac('sha256', key).update(signableCanonical(evidence), 'utf8').digest('hex');
}

function treeSha256(digestMap) {
  return sha256Hex(canonicalJson(APPROVED_FILES.map(name => [name, digestMap[name]])));
}

function normalizeDigestMap(map) {
  if (!isPlainObj(map) || Object.keys(map).sort().join('\0') !== APPROVED_FILES.join('\0')) return null;
  const out = {};
  for (const name of APPROVED_FILES) {
    if (typeof map[name] !== 'string' || !HEX_SHA256_RE.test(map[name])) return null;
    out[name] = map[name];
  }
  return out;
}

export const FIXED_CASES_DIGEST = sha256Hex(canonicalJson(FIXED_CASES.map(row => [...row])));

function normalizeScope(scope) {
  if (!isPlainObj(scope) || Object.keys(scope).sort().join('\0') !== [...SCOPE_KEYS].sort().join('\0')) return null;
  if (!Array.isArray(scope.files) || scope.files.join('\0') !== APPROVED_FILES.join('\0')) return null;
  if (typeof scope.baseRevision !== 'string' || !HEX_REV_RE.test(scope.baseRevision)) return null;
  if (scope.casesDigest !== FIXED_CASES_DIGEST || scope.totalCases !== FIXED_CASES.length) return null;
  const baseFileDigests = normalizeDigestMap(scope.baseFileDigests);
  if (!baseFileDigests) return null;
  return {
    files: APPROVED_FILES,
    baseRevision: scope.baseRevision,
    baseFileDigests,
    casesDigest: FIXED_CASES_DIGEST,
    totalCases: FIXED_CASES.length,
  };
}

function freezeClaimRecord(claimRecord) {
  if (!isPlainObj(claimRecord) || Object.hasOwn(claimRecord, 'trusted') || typeof claimRecord.claimId !== 'string' ||
      !CLAIM_ID_RE.test(claimRecord.claimId) || typeof claimRecord.scopeHash !== 'string' ||
      !HEX_SHA256_RE.test(claimRecord.scopeHash)) {
    throw new Error('Host claim record is invalid.');
  }
  const scope = normalizeScope(claimRecord.scope);
  if (!scope || sha256Hex(canonicalJson(scope)) !== claimRecord.scopeHash) {
    throw new Error('Host claim record is invalid.');
  }
  return Object.freeze({
    claimId: claimRecord.claimId,
    scopeHash: claimRecord.scopeHash,
    scope: Object.freeze({
      ...scope,
      files: Object.freeze([...scope.files]),
      baseFileDigests: Object.freeze({...scope.baseFileDigests}),
    }),
  });
}

export function createVerifiedPatchController({attestationKey, expectedInvocationNonce, claimRecord, trusted} = {}) {
  if (trusted !== undefined) throw new Error('Caller-supplied trusted flags are not accepted.');
  if (typeof expectedInvocationNonce !== 'string' || !NONCE_RE.test(expectedInvocationNonce)) {
    throw new Error('Host invocation nonce is invalid.');
  }
  const key = copyKey(attestationKey);
  const claim = freezeClaimRecord(claimRecord);
  const controller = Object.freeze({
    expectedInvocationNonce,
    claim,
  });
  controllers.set(controller, {key, consumed: false, pending: false});
  return controller;
}

function requireController(controller) {
  const state = controllers.get(controller);
  if (!state || controller?.expectedInvocationNonce !== stateNonce(controller)) {
    throw new Error('Host controller is required.');
  }
  return state;
}

function stateNonce(controller) {
  return typeof controller?.expectedInvocationNonce === 'string' ? controller.expectedInvocationNonce : null;
}

export function beginHostAcceptance(controller) {
  const state = requireController(controller);
  if (state.consumed || state.pending) throw new Error('Replayed invocation nonce.');
  state.pending = true;
  let settled = false;
  return {
    commit() {
      if (settled) return;
      state.consumed = true;
      state.pending = false;
      settled = true;
    },
    abort() {
      if (settled) return;
      state.pending = false;
      settled = true;
    },
  };
}

function sameDigestMap(left, right) {
  return APPROVED_FILES.every(name => left[name] === right[name]);
}

function bindScope(evidence, claim, actualBaseRevision, actualBaseDigests) {
  const claimScope = normalizeScope(evidence.claimScope);
  const evidenceBase = normalizeDigestMap(evidence.baseFileDigests);
  if (!claimScope || !evidenceBase || evidence.claimId !== claim.claimId || evidence.scopeHash !== claim.scopeHash ||
      evidence.baseRevision !== claim.scope.baseRevision || evidence.casesDigest !== claim.scope.casesDigest ||
      evidence.totalCases !== claim.scope.totalCases || sha256Hex(canonicalJson(claimScope)) !== evidence.scopeHash ||
      claim.scope.baseRevision !== actualBaseRevision || !sameDigestMap(claim.scope.baseFileDigests, actualBaseDigests) ||
      !sameDigestMap(claimScope.baseFileDigests, claim.scope.baseFileDigests) ||
      !sameDigestMap(evidenceBase, claim.scope.baseFileDigests) ||
      claimScope.baseRevision !== claim.scope.baseRevision || claimScope.totalCases !== claim.scope.totalCases ||
      evidence.baseTreeSha256 !== treeSha256(evidenceBase)) {
    throw new Error('Attestation claim or scope binding mismatch.');
  }
  return claimScope;
}

function bindCaseRows(evidence) {
  if (!Array.isArray(evidence.results)) throw new Error('Attestation results must contain all case rows.');
  if (!Array.isArray(evidence.caseResults) || evidence.results.length !== FIXED_CASES.length ||
      evidence.caseResults.length !== FIXED_CASES.length || evidence.passed !== true ||
      evidence.passedCases !== FIXED_CASES.length || !Array.isArray(evidence.failures) || evidence.failures.length !== 0 ||
      !Array.isArray(evidence.unchangedFiles) || evidence.unchangedFiles.length !== 0) {
    throw new Error('Attestation case results are missing, failed, or mismatched.');
  }
  for (let index = 0; index < FIXED_CASES.length; index += 1) {
    const [fnName, , expected] = FIXED_CASES[index];
    const row = evidence.caseResults[index];
    const result = evidence.results[index];
    if (!isPlainObj(row) || !isPlainObj(result) || Object.keys(row).sort().join('\0') !== CASE_ROW_KEYS.join('\0') ||
        Object.keys(result).join('\0') !== 'value' || row.case !== index + 1 || row.function !== fnName ||
        row.expected !== expected || row.passed !== true || row.actual !== expected || result.value !== expected ||
        !Number.isSafeInteger(row.steps) || row.steps < 0 || row.steps > MAX_STEPS_PER_CASE) {
      throw new Error('Attestation case results are missing, failed, or mismatched.');
    }
  }
}

function authenticateMac(evidence, key, expectedNonce) {
  const provenance = evidence.provenance;
  if (!isPlainObj(provenance) || provenance.claimBound !== true || typeof provenance.invocationNonce !== 'string' ||
      typeof provenance.hmacSha256 !== 'string' || !HEX_SHA256_RE.test(provenance.hmacSha256)) {
    throw new Error('Attestation provenance HMAC verification failed.');
  }
  const expected = createHmac('sha256', key).update(signableCanonical(evidence), 'utf8').digest();
  const actual = Buffer.from(provenance.hmacSha256, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('Attestation provenance HMAC verification failed.');
  }
  if (provenance.invocationNonce !== expectedNonce) throw new Error('Attestation invocationNonce mismatch.');
}

export function authenticateVerifierEvidence(controller, evidence, {
  actualBaseRevision,
  actualBaseDigests,
  approvedCases,
} = {}) {
  const state = requireController(controller);
  if (state.consumed) throw new Error('Replayed invocation nonce.');
  if (!isPlainObj(evidence)) throw new Error('Missing or malformed verifier evidence.');
  let cloned;
  try {
    const serialized = canonicalJson(evidence);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_EVIDENCE_JSON_BYTES) {
      throw new Error('Verifier evidence exceeds the fixed fixture bound.');
    }
    cloned = JSON.parse(serialized);
  } catch (error) {
    if (error?.message === 'Verifier evidence exceeds the fixed fixture bound.' ||
        error?.message === 'Verifier evidence contains a non-integer number.') {
      throw error;
    }
    throw new Error('Missing or malformed verifier evidence.');
  }
  authenticateMac(cloned, state.key, controller.expectedInvocationNonce);
  if (cloned.scope !== VERIFIER_SCOPE || cloned.target !== VERIFIER_TARGET || cloned.verifier !== VERIFIER_VERSION ||
      cloned.entryPointDisconnected !== true || cloned.trusted !== true || typeof cloned.passed !== 'boolean') {
    throw new Error('Attestation scope metadata mismatch.');
  }
  if (approvedCases !== undefined && canonicalJson(approvedCases) !== canonicalJson(FIXED_CASES.map(row => [...row]))) {
    throw new Error('Approved cases do not match the fixed 12-case vector.');
  }
  const claim = controller.claim;
  const baseDigests = normalizeDigestMap(actualBaseDigests);
  if (!baseDigests || typeof actualBaseRevision !== 'string' || !HEX_REV_RE.test(actualBaseRevision)) {
    throw new Error('Attestation claim or scope binding mismatch.');
  }
  bindScope(cloned, claim, actualBaseRevision, baseDigests);
  bindCaseRows(cloned);
  const fileDigests = normalizeDigestMap(cloned.fileDigests);
  if (!fileDigests || cloned.treeSha256 !== treeSha256(fileDigests) ||
      APPROVED_FILES.some(name => fileDigests[name] === baseDigests[name])) {
    throw new Error('Attestation file digest binding mismatch.');
  }
  return Object.freeze({
    claimId: claim.claimId,
    scope: claim.scope,
    scopeHash: claim.scopeHash,
    invocationNonce: controller.expectedInvocationNonce,
    casesDigest: FIXED_CASES_DIGEST,
    totalCases: FIXED_CASES.length,
    passedCases: FIXED_CASES.length,
    fileDigests: Object.freeze({...fileDigests}),
    treeSha256: cloned.treeSha256,
  });
}
