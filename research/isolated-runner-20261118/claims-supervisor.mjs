// Disconnected, synthetic prototype of a bounded request-claims supervisor.
//
// Status: research prototype only. NOT connected to the runner, controller,
// browser service, any worker adapter or any production state. NOT Windows
// qualification. NOT safe for production. It does not create, verify or
// attest an OS sandbox. A normal Node child process, --max-old-space-size and
// any caller-supplied flag are not an OS sandbox and not a whole-process
// resource guarantee. A trusted host must already run this inside an OS
// enforced sandbox that it verified by its own means.
//
// Registry access is REFUSED. The existing durable-request-claims registry
// cannot be bounded from a child without changing its API: it recovers hot
// journals and runs integrity_check before its in-transaction page limits,
// and pathname or sidecar substitution can defeat any identity check made
// around it. Until an enforceable OS and registry boundary exists, the fixed
// child answers every allowed operation with REGISTRY_BOUNDARY_UNAVAILABLE
// before SQLite or the store is touched. No option, flag or string can turn
// registry access on.
//
// What remains is the bounded child protocol: fixed entry point,
// process.execPath, no shell, windowsHide, minimal allowlisted environment,
// request only on stdin, exactly one correlated reply line, and fixed,
// privacy-safe outcomes:
//   rejected  the request provably changed nothing (bad input, busy, closed,
//             spawn failure, or the child refused before registry access).
//   unknown   timeout, kill, unclean or unclear exit, reordered events, lost,
//             late, malformed, oversized, duplicate, mismatched or unexpected
//             reply. The supervisor never retries and never authorizes
//             redispatch.
// A definitive outcome needs ALL of: the spawn event, complete stdout (end),
// an explicitly observed clean exit (code 0, no signal) and every one of
// those observed at or before a monotonic deadline that is checked
// independently of timer scheduling. After a kill the supervisor waits a
// bounded time for exit. If exit is not observed the outcome says
// 'exit-unconfirmed' and the concurrency slot stays held until it is.
import {spawn as nodeSpawn} from 'node:child_process';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {dirname, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {types} from 'node:util';

export const CHILD_ENTRY = fileURLToPath(new URL('./claims-supervisor-child.mjs', import.meta.url));

export const CONTAINMENT = 'not-established-by-supervisor';
export const BOUNDARY_CODE = 'REGISTRY_BOUNDARY_UNAVAILABLE';

export const REGISTRY_BOUNDARY = Object.freeze({
  established: false,
  code: BOUNDARY_CODE,
  reason: 'No enforceable OS and registry boundary bounds SQLite recovery, integrity work, growth and path substitution, so registry access is refused before SQLite opens the store.',
});

export const PROTOTYPE_STATUS = Object.freeze({
  connected: false,
  windowsQualified: false,
  productionSafe: false,
  registryAccess: 'refused',
  containment: CONTAINMENT,
  summary: 'Disconnected synthetic prototype of the bounded child protocol. Registry access is refused. Bounds are best effort inside an externally verified OS sandbox; this module establishes no sandbox and no process identity.',
});

export const TRUST_ASSUMPTIONS = Object.freeze([
  'The calling host is trusted and has already placed this process inside a verified offline OS sandbox with read-only source and toolchain, scratch-only writes and enforced memory, CPU and lifetime limits. The supervisor cannot check this and accepts no flag claiming it.',
  'process.execPath and the child entry file are trusted and read-only. The supervisor does not hash or verify them.',
  'Child exit is observed through the Node ChildProcess exit event only. It says nothing about grandchildren (the child starts none) or about OS-level process identity.',
  'A spawn error emitted before any spawn event is treated as "not started" per the Node ChildProcess contract, and its slot is released.',
  'The monotonic clock is process.hrtime. A host that suspends the process can still delay both the clock read and the kill.',
]);

// Why registry access is refused. Each item needs a registry or OS change.
export const MISSING_BOUNDARIES = Object.freeze([
  'Check order: durable-request-claims.mjs runs PRAGMA integrity_check before its journal_mode and page_count checks, at open and in every transaction, so validation work is not bounded by maxPages.',
  'Hot journal: SQLite rolls back a leftover journal at the registry first lock, before any registry check. A size check on the journal is a snapshot and does not bound or authorize that recovery.',
  'Connection pragmas: the registry exposes no way to set mmap_size=0, temp_store=MEMORY, cache_size, enableDefensive, limits or an ATTACH-denying authorizer on its connection.',
  'Interrupt: node:sqlite DatabaseSync has no interrupt or progress handler, so only killing the process bounds elapsed time.',
  'Pathname races: SQLite opens the store and reopens its -journal by pathname. Identity checks before and after the operation can be defeated by swap-and-restore or by sidecar substitution, and concurrent growth after any preflight is not bounded.',
  'Initialization: the registry accepts initialize: true on an existing file; exclusive creation needs a registry change.',
  'Orphans: if the host process dies, a running child is not killed. Bounding that needs an OS facility such as a Windows Job Object with kill-on-close, which Node does not create.',
  'Environment on Windows: libuv adds SYSTEMROOT, SYSTEMDRIVE and TEMP to a child environment when absent, so the effective child environment is larger than the allowlist the supervisor passes.',
  '--max-old-space-size bounds only the V8 old generation. It does not bound native memory, stack or OS resources.',
]);

// Original acceptance criteria that cannot be demonstrated while registry
// access is refused. They are not simulated with fake registry operations.
export const ACCEPTANCE_GAPS = Object.freeze([
  'A successful registry operation through the bounded child is not demonstrated; every real child operation is refused.',
  'Timeout before commit and timeout after commit of a real registry write through the child are not demonstrated. Child kill, timeout and exit observation are demonstrated only on a child that refuses before registry access.',
  'Lost reply after a real registry commit, and crash-to-unresolved through the child, are not demonstrated. Registry-level crash recovery evidence exists only in durable-request-claims.test.mjs, outside this prototype.',
  'Request and scope binding and one dispatch intent are unchanged because the registry is untouched; they are not exercised through the child.',
]);

// Recommended inside-transaction order for a future registry change. Not
// implemented by the current registry.
export const INSIDE_TRANSACTION_ORDER = Object.freeze([
  'BEGIN IMMEDIATE for writes, BEGIN for reads',
  'read page_size == 4096, journal_mode == delete, page_count <= maxPages, freelist_count <= page_count, max_page_count == maxPages',
  'PRAGMA integrity_check(1)',
  'schema, meta and whole-store row validation',
  'operation body',
  'whole-store validation of the written state',
  'COMMIT',
]);

export const ALLOWED_OPERATIONS = Object.freeze([
  'reserve', 'recordDispatchIntent', 'recordWorkerIdentity', 'recordHostCompletion',
  'hostContinuePreDispatch', 'inspect', 'assessWorkerIdentity',
]);
const WRITE_OPERATIONS = new Set(['reserve', 'recordDispatchIntent', 'recordWorkerIdentity', 'recordHostCompletion', 'hostContinuePreDispatch']);

// The only codes a child may return as a definitive refusal.
const CHILD_REJECTION_CODES = new Set([BOUNDARY_CODE]);
// Registry codes. A well-formed registry reply is unexpected while access is
// refused and is reported as unknown, never trusted.
const REGISTRY_CODES = new Set([
  'INVALID_INPUT', 'INVALID_OPTIONS', 'NOT_FOUND', 'SCOPE_MISMATCH', 'OWNER_MISMATCH', 'INVALID_TRANSITION',
  'NONCE_MISMATCH', 'INSUFFICIENT_IDENTITY', 'IDENTITY_CONFLICT', 'HOST_AUTHORITY_REQUIRED', 'STALE_DECISION',
  'RECOVERY_REQUIRES_EXTERNAL_PROOF', 'STORE_UNINITIALIZED', 'STORE_UNAVAILABLE', 'STORE_CORRUPT', 'STORE_BUSY',
  'STORE_FULL', 'STORE_CONFLICT', 'STORE_UNSUPPORTED', 'REGISTRY_CLOSED', 'INTERNAL_ERROR',
]);

export const CHILD_MAX_REQUEST_BYTES = 262144;
export const MAX_PAGES_CAP = 262143;
const MAX_ARG_NODES = 4096;
const MAX_ARG_DEPTH = 24;
const MAX_ARG_STRING = 4096;
const CORRELATION = /^[A-Za-z0-9_-]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWNER_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const STATES = ['claimed', 'dispatch-intent', 'worker-recorded', 'completed'];
const VERDICTS = ['matches-recorded', 'mismatch', 'no-recorded-identity', 'insufficient-identity', 'invalid-identity'];

export class SupervisorError extends Error {
  constructor(code) {
    super(code === 'INVALID_OPTIONS' ? 'Claims supervisor options are invalid.' : 'Claims supervisor failed.');
    this.name = 'SupervisorError';
    this.code = code === 'INVALID_OPTIONS' ? code : 'INTERNAL_ERROR';
  }
  toJSON() { return {name: this.name, code: this.code, message: this.message}; }
}

const OPTION_KEYS = Object.freeze([
  'storePath', 'maxConcurrent', 'deadlineMs', 'exitWaitMs', 'maxRequestBytes', 'maxReplyBytes',
  'maxPages', 'maxRows', 'busyTimeoutMs', 'maxOldSpaceMb',
]);

const intIn = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

// Options are read through data descriptors only. Unknown keys, including any
// attempt to declare a sandbox, trust level, registry boundary, child entry
// or spawn function, are rejected.
function readOptions(options) {
  const bad = () => { throw new SupervisorError('INVALID_OPTIONS'); };
  if (options === null || typeof options !== 'object' || types.isProxy(options) || Array.isArray(options)) bad();
  const proto = Object.getPrototypeOf(options);
  if (proto !== Object.prototype && proto !== null) bad();
  const record = Object.create(null);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !OPTION_KEYS.includes(key)) bad();
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) bad();
    record[key] = descriptor.value;
  }
  const {
    storePath, maxConcurrent = 2, deadlineMs = 5000, exitWaitMs = 2000, maxRequestBytes = 65536,
    maxReplyBytes = 16384, maxPages = 2048, maxRows = 1024, busyTimeoutMs = 1000, maxOldSpaceMb = 64,
  } = record;
  if (typeof storePath !== 'string' || !storePath || storePath.length > 1024 || storePath.includes('\0') || !isAbsolute(storePath)) bad();
  if (!intIn(maxConcurrent, 1, 8)) bad();
  if (!intIn(deadlineMs, 100, 120000)) bad();
  if (!intIn(exitWaitMs, 50, 30000)) bad();
  if (!intIn(maxRequestBytes, 1024, 131072)) bad();
  if (!intIn(maxReplyBytes, 256, 65536)) bad();
  if (!intIn(maxPages, 16, MAX_PAGES_CAP)) bad();
  if (!intIn(maxRows, 1, 100000)) bad();
  if (!intIn(busyTimeoutMs, 0, 60000) || busyTimeoutMs * 2 > deadlineMs) bad();
  if (!intIn(maxOldSpaceMb, 16, 1024)) bad();
  return Object.freeze({storePath, maxConcurrent, deadlineMs, exitWaitMs, maxRequestBytes, maxReplyBytes,
    maxPages, maxRows, busyTimeoutMs, maxOldSpaceMb});
}

// Request arguments arrive only as a JSON string. Live objects are refused
// by type before any property is read, so no getter, proxy trap or
// enumeration runs. The string length is checked first (UTF-8 bytes are at
// least the UTF-16 length), then the exact byte length, and only then is
// the bounded text parsed and the parsed data validated.
function parseArgsJson(text, maxBytes) {
  if (typeof text !== 'string') return {ok: false, code: 'INVALID_REQUEST'};
  if (text.length > maxBytes) return {ok: false, code: 'REQUEST_OVERSIZED'};
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return {ok: false, code: 'REQUEST_OVERSIZED'};
  let value;
  try { value = JSON.parse(text); }
  catch { return {ok: false, code: 'INVALID_REQUEST'}; }
  let nodes = 0;
  const valid = (item, depth) => {
    if (++nodes > MAX_ARG_NODES || depth > MAX_ARG_DEPTH) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'string') return item.length <= MAX_ARG_STRING;
    if (typeof item === 'number') return Number.isFinite(item) && !Object.is(item, -0);
    if (Array.isArray(item)) {
      if (item.length > MAX_ARG_NODES) return false;
      for (const entry of item) if (!valid(entry, depth + 1)) return false;
      return true;
    }
    if (typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) return false;
    for (const key of Object.keys(item)) {
      if (key.length > MAX_ARG_STRING || key === '__proto__') return false;
      if (!valid(item[key], depth + 1)) return false;
    }
    return true;
  };
  let ok;
  try {
    ok = value !== null && typeof value === 'object' && !Array.isArray(value) && valid(value, 0);
  } catch {
    ok = false;
  }
  return ok ? {ok: true, value} : {ok: false, code: 'INVALID_REQUEST'};
}

export function childEnvironment() {
  const env = {};
  if (process.platform === 'win32' && typeof process.env.SystemRoot === 'string') env.SystemRoot = process.env.SystemRoot;
  return env;
}

function childArgv(limits) {
  return [
    `--max-old-space-size=${limits.maxOldSpaceMb}`,
    '--disallow-code-generation-from-strings',
    '--no-addons',
    CHILD_ENTRY,
  ];
}

function spawnOptions() {
  return {
    cwd: dirname(CHILD_ENTRY),
    env: childEnvironment(),
    shell: false,
    windowsHide: true,
    detached: false,
    stdio: ['pipe', 'pipe', 'ignore'],
  };
}

function outcomeBase(operation) {
  return {operation, redispatchAllowed: false, automaticAction: 'none', containment: CONTAINMENT};
}
function rejectedOutcome(operation, code, childState) {
  return Object.freeze({outcome: 'rejected', ...outcomeBase(operation), code, commitState: 'none', childState});
}
function unknownOutcome(operation, code, childState) {
  return Object.freeze({outcome: 'unknown', ...outcomeBase(operation), code,
    commitState: operation !== null && WRITE_OPERATIONS.has(operation) ? 'unknown' : 'none', childState});
}

// Strict type checks come before any regex or comparison, so no value is
// coerced and no caller-controlled toString or valueOf can run.
const isString = value => typeof value === 'string';
const isHexString = value => isString(value) && value.length === 64 && HEX64.test(value);
const isJsonObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

function exactKeys(value, required, optional = []) {
  if (!isJsonObject(value)) return false;
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) return false;
  for (const key of required) if (!Object.hasOwn(value, key)) return false;
  return true;
}

const CLAIM_KEYS = ['requestKey', 'scopeHash', 'state', 'generation', 'nonce', 'workerIdentityRecorded', 'resultHash'];
function validClaim(claim) {
  return exactKeys(claim, CLAIM_KEYS) && isHexString(claim.requestKey) && isHexString(claim.scopeHash) &&
    isString(claim.state) && STATES.includes(claim.state) &&
    Number.isSafeInteger(claim.generation) && claim.generation >= 1 &&
    (claim.nonce === null || (isString(claim.nonce) && UUID.test(claim.nonce))) &&
    typeof claim.workerIdentityRecorded === 'boolean' &&
    (claim.resultHash === null || isHexString(claim.resultHash));
}
function validRecovery(recovery) {
  return exactKeys(recovery, ['resolution', 'redispatchAllowed', 'automaticAction', 'reason'], ['hold']) &&
    (recovery.resolution === 'complete' || recovery.resolution === 'unresolved') &&
    recovery.redispatchAllowed === false && recovery.automaticAction === 'none' &&
    isString(recovery.reason) && recovery.reason.length <= 512 &&
    (recovery.hold === undefined || (isString(recovery.hold) && recovery.hold.length <= 64));
}
const validToken = token => isString(token) && OWNER_TOKEN.test(token);

// Exact registry result shape per operation. Used only to tell a malformed
// reply from a well-formed but unexpected one; neither is ever trusted while
// registry access is refused.
const RESULT_SHAPES = Object.freeze({
  reserve: r => isJsonObject(r) && r.dispatchAuthorized === false && (
    r.outcome === 'created'
      ? exactKeys(r, ['outcome', 'dispatchAuthorized', 'ownerToken', 'claim']) && validToken(r.ownerToken) && validClaim(r.claim) && r.claim.state === 'claimed'
      : r.outcome === 'existing' && exactKeys(r, ['outcome', 'dispatchAuthorized', 'claim', 'recovery']) && validClaim(r.claim) && validRecovery(r.recovery)),
  recordDispatchIntent: r => exactKeys(r, ['dispatchAuthorized', 'nonce', 'claim']) && r.dispatchAuthorized === true &&
    isString(r.nonce) && UUID.test(r.nonce) && validClaim(r.claim) && r.claim.state === 'dispatch-intent' && r.claim.nonce === r.nonce,
  recordWorkerIdentity: r => exactKeys(r, ['claim']) && validClaim(r.claim) && r.claim.state === 'worker-recorded',
  recordHostCompletion: r => exactKeys(r, ['claim', 'recovery']) && validClaim(r.claim) && r.claim.state === 'completed' && validRecovery(r.recovery),
  hostContinuePreDispatch: r => exactKeys(r, ['dispatchAuthorized', 'ownerToken', 'claim']) && r.dispatchAuthorized === false &&
    validToken(r.ownerToken) && validClaim(r.claim) && r.claim.state === 'claimed',
  inspect: r => isJsonObject(r) && (r.found === false ? exactKeys(r, ['found'])
    : r.found === true && exactKeys(r, ['found', 'claim', 'recovery']) && validClaim(r.claim) && validRecovery(r.recovery)),
  assessWorkerIdentity: r => exactKeys(r, ['verdict', 'osProcessProof', 'workerDeathInferred', 'redispatchAllowed', 'claim']) &&
    isString(r.verdict) && VERDICTS.includes(r.verdict) && r.osProcessProof === 'not-established' &&
    r.workerDeathInferred === false && r.redispatchAllowed === false && validClaim(r.claim),
});

// Never throws.
function validateResult(operation, result) {
  try {
    return isString(operation) && Object.hasOwn(RESULT_SHAPES, operation) && RESULT_SHAPES[operation](result) === true;
  } catch {
    return false;
  }
}

const sameText = (left, right) => {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

const bad = code => ({ok: false, code});
const good = outcome => ({ok: true, outcome});

function parseReplyUnguarded(buffer, correlation, operation) {
  if (!Buffer.isBuffer(buffer)) return bad('REPLY_MALFORMED');
  if (buffer.length === 0) return bad('REPLY_MISSING');
  const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(buffer);
  const newline = text.indexOf('\n');
  if (newline === -1) return bad('REPLY_MALFORMED');
  if (newline !== text.length - 1) return bad('REPLY_DUPLICATE');
  const message = JSON.parse(text.slice(0, newline));
  if (!isJsonObject(message) || message.v !== 1) return bad('REPLY_MALFORMED');
  if (!isString(message.correlation) || !CORRELATION.test(message.correlation) ||
      !sameText(message.correlation, correlation) || !isString(message.operation) || message.operation !== operation) {
    return bad('REPLY_MISMATCH');
  }
  const envelope = ['v', 'correlation', 'operation', 'status'];
  if (!isString(message.status)) return bad('REPLY_MALFORMED');
  switch (message.status) {
    case 'rejected':
      if (!exactKeys(message, [...envelope, 'code']) || !isString(message.code) || !CHILD_REJECTION_CODES.has(message.code)) return bad('REPLY_MALFORMED');
      return good(rejectedOutcome(operation, message.code, 'exited'));
    case 'ok':
      if (!exactKeys(message, [...envelope, 'result']) || !validateResult(operation, message.result)) return bad('REPLY_MALFORMED');
      return good(unknownOutcome(operation, 'REPLY_UNEXPECTED', 'exited'));
    case 'error':
      if (!exactKeys(message, [...envelope, 'phase', 'code']) || (message.phase !== 'open' && message.phase !== 'operation') ||
          !isString(message.code) || !REGISTRY_CODES.has(message.code)) return bad('REPLY_MALFORMED');
      return good(unknownOutcome(operation, 'REPLY_UNEXPECTED', 'exited'));
    default:
      return bad('REPLY_MALFORMED');
  }
}

// Exception barrier around the whole reply path. Any throw, including a
// decode, parse or validation failure, becomes the fixed REPLY_MALFORMED.
function parseReply(buffer, expected) {
  try { return parseReplyUnguarded(buffer, expected.correlation, expected.operation); }
  catch { return bad('REPLY_MALFORMED'); }
}

const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6;

class ClaimsSupervisor {
  #limits;
  #spawn;
  #now;
  #active = 0;
  #closed = false;

  constructor(limits, spawnImpl, now) {
    this.#limits = limits;
    this.#spawn = spawnImpl;
    this.#now = now;
  }

  stats() {
    return Object.freeze({active: this.#active, maxConcurrent: this.#limits.maxConcurrent, closed: this.#closed});
  }

  // Stops accepting new work. Running children keep their deadlines.
  close() { this.#closed = true; }

  // argsJson is the operation arguments as a JSON text. Always resolves;
  // never rejects and never retries. Cheap checks (operation, closed,
  // concurrency) run before any input is measured or parsed.
  async run(operation, argsJson) {
    if (typeof operation !== 'string' || !ALLOWED_OPERATIONS.includes(operation)) {
      return rejectedOutcome(null, 'OPERATION_NOT_ALLOWED', 'not-started');
    }
    if (this.#closed) return rejectedOutcome(operation, 'SUPERVISOR_CLOSED', 'not-started');
    const limits = this.#limits;
    if (this.#active >= limits.maxConcurrent) return rejectedOutcome(operation, 'SUPERVISOR_BUSY', 'not-started');
    const parsed = parseArgsJson(argsJson, limits.maxRequestBytes);
    if (!parsed.ok) return rejectedOutcome(operation, parsed.code, 'not-started');
    const correlation = randomBytes(24).toString('base64url');
    const line = `${JSON.stringify({v: 1, correlation, operation, args: parsed.value, store: {
      path: limits.storePath, maxPages: limits.maxPages, maxRows: limits.maxRows, busyTimeoutMs: limits.busyTimeoutMs,
    }})}\n`;
    if (Buffer.byteLength(line, 'utf8') > CHILD_MAX_REQUEST_BYTES) return rejectedOutcome(operation, 'REQUEST_OVERSIZED', 'not-started');
    return this.#dispatch(operation, correlation, line);
  }

  #dispatch(operation, correlation, line) {
    const limits = this.#limits;
    const now = this.#now;
    return new Promise(resolve => {
      let child;
      let settled = false;
      let spawned = false;
      let exitObserved = false;
      let outputEnded = false;
      let slotHeld = true;
      let phase = 'running';
      let terminateCode = null;
      let deadlineTimer = null;
      let exitTimer = null;
      let replyBytes = 0;
      const chunks = [];
      let deadlineAt = Number.NaN;
      try { deadlineAt = now() + limits.deadlineMs; } catch {}

      // Independent of timer scheduling: an event observed after the
      // monotonic deadline is late even if the deadline timer has not run.
      const isLate = () => {
        try {
          const current = now();
          return !(Number.isFinite(current) && Number.isFinite(deadlineAt) && current <= deadlineAt);
        } catch {
          return true;
        }
      };

      this.#active += 1;
      const release = () => {
        if (slotHeld) { slotHeld = false; this.#active -= 1; }
      };
      const finish = outcome => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        clearTimeout(exitTimer);
        resolve(outcome);
      };
      const terminate = code => {
        if (phase !== 'running') return;
        phase = 'terminating';
        terminateCode = code;
        clearTimeout(deadlineTimer);
        if (exitObserved) { finish(unknownOutcome(operation, code, 'exit-observed')); return; }
        try { child.kill('SIGKILL'); } catch {}
        // Exit must be observed. Without it the outcome stays unresolved and
        // the slot stays held until a later exit event releases it.
        exitTimer = setTimeout(() => finish(unknownOutcome(operation, code, 'exit-unconfirmed')), limits.exitWaitMs);
      };
      // Exception barrier for every event handler.
      const guard = handler => (...args) => {
        try { handler(...args); }
        catch {
          try { terminate('CHILD_ERROR'); } catch {}
        }
      };
      // A definitive outcome needs spawn, complete output and a clean exit,
      // all observed in order and on time.
      const complete = () => {
        if (phase !== 'running' || !spawned || !exitObserved || !outputEnded) return;
        if (isLate()) { terminate('CHILD_TIMEOUT'); return; }
        phase = 'done';
        clearTimeout(deadlineTimer);
        let parsed;
        try { parsed = parseReply(Buffer.concat(chunks), {correlation, operation}); }
        catch { parsed = bad('REPLY_MALFORMED'); }
        finish(parsed.ok ? parsed.outcome : unknownOutcome(operation, parsed.code, 'exited'));
      };

      try { child = this.#spawn(process.execPath, childArgv(limits), spawnOptions()); }
      catch { release(); finish(rejectedOutcome(operation, 'CHILD_SPAWN_FAILED', 'not-started')); return; }
      if (!child || typeof child.on !== 'function' || !child.stdin || !child.stdout ||
          typeof child.stdout.on !== 'function' || typeof child.kill !== 'function') {
        // Cannot manage or observe this child; hold the slot.
        finish(unknownOutcome(operation, 'CHILD_ERROR', 'exit-unconfirmed'));
        return;
      }

      try {
        child.on('spawn', guard(() => {
          if (phase !== 'running') return;
          if (exitObserved || outputEnded || replyBytes > 0) { terminate('CHILD_EVENT_ORDER'); return; }
          spawned = true;
        }));
        child.on('error', guard(() => {
          if (!spawned && !exitObserved && phase === 'running') {
            phase = 'done';
            release();
            finish(rejectedOutcome(operation, 'CHILD_SPAWN_FAILED', 'not-started'));
            return;
          }
          terminate('CHILD_ERROR');
        }));
        child.on('exit', guard((code, signal) => {
          if (exitObserved) return;
          exitObserved = true;
          release();
          if (phase === 'terminating') { finish(unknownOutcome(operation, terminateCode, 'exit-observed')); return; }
          if (phase !== 'running') return;
          if (!spawned) { terminate('CHILD_EVENT_ORDER'); return; }
          if (isLate()) { terminate('CHILD_TIMEOUT'); return; }
          if (code !== 0 || signal !== null) { terminate('CHILD_EXIT_UNCLEAN'); return; }
          complete();
        }));
        child.on('close', guard(() => {
          if (phase !== 'running') return;
          // 'close' without a prior spawn and exit is out of order. The
          // reply is not trusted and the child is killed; the slot stays
          // held until exit is observed.
          if (!spawned || !exitObserved) { terminate('CHILD_EVENT_ORDER'); return; }
          complete();
        }));
        child.stdout.on('data', guard(chunk => {
          if (phase !== 'running') return; // late output is dropped unread
          if (!spawned || outputEnded) { terminate('CHILD_EVENT_ORDER'); return; }
          if (isLate()) { terminate('CHILD_TIMEOUT'); return; }
          if (!Buffer.isBuffer(chunk)) { terminate('REPLY_MALFORMED'); return; }
          replyBytes += chunk.length;
          if (replyBytes > limits.maxReplyBytes) {
            chunks.length = 0;
            try { child.stdout.destroy(); } catch {}
            terminate('REPLY_OVERSIZED');
            return;
          }
          chunks.push(chunk);
        }));
        child.stdout.on('end', guard(() => {
          if (phase !== 'running') return;
          if (!spawned) { terminate('CHILD_EVENT_ORDER'); return; }
          if (isLate()) { terminate('CHILD_TIMEOUT'); return; }
          outputEnded = true;
          complete();
        }));
        child.stdout.on('error', () => {});
        if (typeof child.stdin.on === 'function') child.stdin.on('error', () => {});
        deadlineTimer = setTimeout(guard(() => terminate('CHILD_TIMEOUT')), limits.deadlineMs);
        child.stdin.end(line);
      } catch {
        terminate('CHILD_ERROR');
      }
    });
  }
}

export function createClaimsSupervisor(options) {
  return new ClaimsSupervisor(readOptions(options), nodeSpawn, monotonicMs);
}

// Test seam only. A spawn implementation and a clock are never accepted by
// the production factory, so production code cannot redirect the child
// entry point or the deadline. Neither seam can enable registry access.
export const _testing = Object.freeze({
  createSupervisor(options, {spawnImpl, now = monotonicMs}) {
    if (typeof spawnImpl !== 'function' || typeof now !== 'function') throw new SupervisorError('INVALID_OPTIONS');
    return new ClaimsSupervisor(readOptions(options), spawnImpl, now);
  },
  parseArgsJson,
  parseReply,
  validateResult,
  readOptions,
});
