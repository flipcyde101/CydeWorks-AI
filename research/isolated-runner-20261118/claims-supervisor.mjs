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
// What it does: runs exactly one durable-request-claims operation in a
// short-lived child (fixed entry point, process.execPath, no shell,
// windowsHide, minimal allowlisted environment) and correlates exactly one
// reply to that one request. Request data travels only on stdin; argv carries
// fixed flags and the fixed entry path. Nothing is logged.
//
// Outcomes are fixed and privacy-safe:
//   ok        a well-formed, correlated reply and an observed clean exit.
//   rejected  the operation provably did not change claim state (bad request,
//             busy supervisor, preflight refusal, registry refusal).
//   unknown   timeout, kill, unclear exit, lost, late, malformed, oversized,
//             duplicate or mismatched reply. A write may or may not have
//             committed. The supervisor never retries and never authorizes
//             redispatch; the registry keeps any committed state unresolved.
// After a kill the supervisor waits a bounded time to observe process exit.
// If exit is not observed the outcome says so (childState
// 'exit-unconfirmed') and the concurrency slot stays held until exit is
// actually observed.
import {spawn as nodeSpawn} from 'node:child_process';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {dirname, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {types} from 'node:util';

export const CHILD_ENTRY = fileURLToPath(new URL('./claims-supervisor-child.mjs', import.meta.url));

export const CONTAINMENT = 'not-established-by-supervisor';

export const PROTOTYPE_STATUS = Object.freeze({
  connected: false,
  windowsQualified: false,
  productionSafe: false,
  containment: CONTAINMENT,
  summary: 'Disconnected synthetic prototype. Bounds are best effort inside an externally verified OS sandbox; this module establishes no sandbox and no process identity.',
});

export const TRUST_ASSUMPTIONS = Object.freeze([
  'The calling host is trusted and has already placed this process inside a verified offline OS sandbox with read-only source and toolchain, scratch-only writes and enforced memory, CPU and lifetime limits. The supervisor cannot check this and accepts no flag claiming it.',
  'process.execPath and the child entry file are trusted and read-only. The supervisor does not hash or verify them.',
  'The store directory is provisioned by the host and writable only by the host account. Preflight path checks are a snapshot, not a guarantee.',
  'Child exit is observed through the Node ChildProcess exit event only. It says nothing about grandchildren (the child starts none) or about OS-level process identity.',
  'The registry trust limits in durable-request-claims.mjs TRUST_LIMITS still apply unchanged.',
]);

// Boundaries the current registry API does not provide. The supervisor does
// not weaken any of them; it reports them and relies on the outer kill.
export const MISSING_BOUNDARIES = Object.freeze([
  'Check order: durable-request-claims.mjs runs PRAGMA integrity_check before its journal_mode and page_count checks, at open and in every transaction. Bounds-before-integrity inside the transaction needs a registry change. Here integrity work is bounded only by the pre-open size preflight (a snapshot) and the child deadline kill.',
  'Connection pragmas: the registry exposes no way to set mmap_size=0, temp_store=MEMORY, cache_size, enableDefensive, limits or an ATTACH-denying authorizer on its connection. The child sets only the process-global SQLite hard_heap_limit.',
  'Interrupt: node:sqlite DatabaseSync has no interrupt or progress handler, so only killing the child bounds elapsed time.',
  'Initialization: not offered through the supervisor. The registry accepts initialize: true on an existing file; exclusive creation needs a registry change.',
  'Hot journal: SQLite rolls back a leftover journal at the registry first lock. The preflight bounds the journal size only; rollback itself is not otherwise bounded.',
  'Pathname races: preflight, the identity re-check before open and the re-check after close compare a snapshot. SQLite reopens the store and its journal by pathname. A swap-and-restore during the operation, concurrent growth after preflight, and journal or sidecar substitution are not closed.',
  'Orphans: if the host process dies, a running child is not killed. Bounding that needs an OS facility such as a Windows Job Object with kill-on-close, which Node does not create.',
  'Environment on Windows: libuv adds SYSTEMROOT, SYSTEMDRIVE and TEMP to a child environment when absent, so the effective child environment is larger than the allowlist the supervisor passes.',
  '--max-old-space-size bounds only the V8 old generation. It does not bound native, SQLite page cache, stack or OS memory.',
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

// Registry codes that are raised before any write and always roll back.
const REJECTION_CODES = new Set([
  'INVALID_INPUT', 'INVALID_OPTIONS', 'NOT_FOUND', 'SCOPE_MISMATCH', 'OWNER_MISMATCH', 'INVALID_TRANSITION',
  'NONCE_MISMATCH', 'INSUFFICIENT_IDENTITY', 'IDENTITY_CONFLICT', 'HOST_AUTHORITY_REQUIRED', 'STALE_DECISION',
  'RECOVERY_REQUIRES_EXTERNAL_PROOF', 'STORE_UNINITIALIZED',
]);
// Store-level codes. During a write operation a commit failure is ambiguous.
const STORE_CODES = new Set([
  'STORE_UNAVAILABLE', 'STORE_CORRUPT', 'STORE_BUSY', 'STORE_FULL', 'STORE_CONFLICT', 'STORE_UNSUPPORTED',
  'REGISTRY_CLOSED', 'INTERNAL_ERROR',
]);
export const PREFLIGHT_CODES = Object.freeze(['PREFLIGHT_PATH', 'PREFLIGHT_UNAVAILABLE', 'PREFLIGHT_UNSUPPORTED', 'PREFLIGHT_OVERSIZE', 'CHILD_LIMIT_UNAVAILABLE']);
const CHILD_UNKNOWN_CODES = new Set(['STORE_PATH_CHANGED']);

export const MAX_PAGES_CAP = 262143;
const MAX_WIRE_NODES = 4096;
const MAX_WIRE_DEPTH = 24;
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

class WireError extends Error {}
const wireFail = () => { throw new WireError(); };

const OPTION_KEYS = Object.freeze([
  'storePath', 'maxConcurrent', 'deadlineMs', 'exitWaitMs', 'maxRequestBytes', 'maxReplyBytes',
  'maxPages', 'maxRows', 'busyTimeoutMs', 'maxOldSpaceMb', 'sqliteHeapLimitMb',
]);

const intIn = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

// Options are read through data descriptors only. Unknown keys, including any
// attempt to declare a sandbox, trust level, child entry or spawn function,
// are rejected.
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
    storePath, maxConcurrent = 2, deadlineMs = 5000, exitWaitMs = 2000, maxRequestBytes = 131072,
    maxReplyBytes = 16384, maxPages = 2048, maxRows = 1024, busyTimeoutMs = 1000, maxOldSpaceMb = 64,
    sqliteHeapLimitMb = 64,
  } = record;
  if (typeof storePath !== 'string' || !storePath || storePath.length > 1024 || storePath.includes('\0') || !isAbsolute(storePath)) bad();
  if (!intIn(maxConcurrent, 1, 8)) bad();
  if (!intIn(deadlineMs, 100, 120000)) bad();
  if (!intIn(exitWaitMs, 50, 30000)) bad();
  if (!intIn(maxRequestBytes, 1024, 262144)) bad();
  if (!intIn(maxReplyBytes, 256, 65536)) bad();
  if (!intIn(maxPages, 16, MAX_PAGES_CAP)) bad();
  if (!intIn(maxRows, 1, 100000)) bad();
  if (!intIn(busyTimeoutMs, 0, 60000) || busyTimeoutMs * 2 > deadlineMs) bad();
  if (!intIn(maxOldSpaceMb, 16, 1024)) bad();
  if (!intIn(sqliteHeapLimitMb, 8, 1024)) bad();
  return Object.freeze({storePath, maxConcurrent, deadlineMs, exitWaitMs, maxRequestBytes, maxReplyBytes,
    maxPages, maxRows, busyTimeoutMs, maxOldSpaceMb, sqliteHeapLimitMb});
}

// Copies caller arguments into fresh null-prototype data without running any
// caller code: no getters, proxies, functions, symbols, bigints, undefined,
// non-finite numbers, -0, sparse arrays or class instances.
function toWire(value) {
  let nodes = 0;
  const walk = (item, depth) => {
    if (++nodes > MAX_WIRE_NODES || depth > MAX_WIRE_DEPTH) wireFail();
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0)) wireFail();
      return item;
    }
    if (typeof item !== 'object' || types.isProxy(item)) wireFail();
    const keys = Reflect.ownKeys(item);
    const dataValue = key => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) wireFail();
      return descriptor.value;
    };
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype) wireFail();
      const length = Object.getOwnPropertyDescriptor(item, 'length').value;
      if (!Number.isSafeInteger(length) || length > MAX_WIRE_NODES) wireFail();
      if (keys.length !== length + 1 || keys[length] !== 'length') wireFail();
      const out = [];
      for (let index = 0; index < length; index++) {
        if (keys[index] !== String(index)) wireFail();
        out.push(walk(dataValue(keys[index]), depth + 1));
      }
      return out;
    }
    const proto = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== null) wireFail();
    const out = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') wireFail();
      out[key] = walk(dataValue(key), depth + 1);
    }
    return out;
  };
  return walk(value, 0);
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
function okOutcome(operation, result) {
  return Object.freeze({outcome: 'ok', ...outcomeBase(operation), code: null,
    commitState: WRITE_OPERATIONS.has(operation) ? 'committed' : 'none', childState: 'exited', result});
}
function rejectedOutcome(operation, code, childState) {
  return Object.freeze({outcome: 'rejected', ...outcomeBase(operation), code, commitState: 'none', childState});
}
function unknownOutcome(operation, code, childState) {
  return Object.freeze({outcome: 'unknown', ...outcomeBase(operation), code,
    commitState: operation !== null && WRITE_OPERATIONS.has(operation) ? 'unknown' : 'none', childState});
}

const isJsonObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

function exactKeys(value, required, optional = []) {
  if (!isJsonObject(value)) return false;
  const keys = Object.keys(value);
  for (const key of keys) if (!required.includes(key) && !optional.includes(key)) return false;
  for (const key of required) if (!Object.hasOwn(value, key)) return false;
  return true;
}

const CLAIM_KEYS = ['requestKey', 'scopeHash', 'state', 'generation', 'nonce', 'workerIdentityRecorded', 'resultHash'];
function validClaim(claim) {
  return exactKeys(claim, CLAIM_KEYS) && HEX64.test(claim.requestKey) && HEX64.test(claim.scopeHash) &&
    typeof claim.requestKey === 'string' && typeof claim.scopeHash === 'string' &&
    STATES.includes(claim.state) && Number.isSafeInteger(claim.generation) && claim.generation >= 1 &&
    (claim.nonce === null || (typeof claim.nonce === 'string' && UUID.test(claim.nonce))) &&
    typeof claim.workerIdentityRecorded === 'boolean' &&
    (claim.resultHash === null || (typeof claim.resultHash === 'string' && HEX64.test(claim.resultHash)));
}
function validRecovery(recovery) {
  return exactKeys(recovery, ['resolution', 'redispatchAllowed', 'automaticAction', 'reason'], ['hold']) &&
    (recovery.resolution === 'complete' || recovery.resolution === 'unresolved') &&
    recovery.redispatchAllowed === false && recovery.automaticAction === 'none' &&
    typeof recovery.reason === 'string' && recovery.reason.length <= 512 &&
    (recovery.hold === undefined || (typeof recovery.hold === 'string' && recovery.hold.length <= 64));
}
const validToken = token => typeof token === 'string' && OWNER_TOKEN.test(token);

// Exact reply shape per operation, so a reply for another operation, or a
// reply that claims more authority than the operation can grant, is refused.
const RESULT_SHAPES = Object.freeze({
  reserve: r => isJsonObject(r) && r.dispatchAuthorized === false && (
    r.outcome === 'created'
      ? exactKeys(r, ['outcome', 'dispatchAuthorized', 'ownerToken', 'claim']) && validToken(r.ownerToken) && validClaim(r.claim) && r.claim.state === 'claimed'
      : r.outcome === 'existing' && exactKeys(r, ['outcome', 'dispatchAuthorized', 'claim', 'recovery']) && validClaim(r.claim) && validRecovery(r.recovery)),
  recordDispatchIntent: r => exactKeys(r, ['dispatchAuthorized', 'nonce', 'claim']) && r.dispatchAuthorized === true &&
    typeof r.nonce === 'string' && UUID.test(r.nonce) && validClaim(r.claim) && r.claim.state === 'dispatch-intent' && r.claim.nonce === r.nonce,
  recordWorkerIdentity: r => exactKeys(r, ['claim']) && validClaim(r.claim) && r.claim.state === 'worker-recorded',
  recordHostCompletion: r => exactKeys(r, ['claim', 'recovery']) && validClaim(r.claim) && r.claim.state === 'completed' && validRecovery(r.recovery),
  hostContinuePreDispatch: r => exactKeys(r, ['dispatchAuthorized', 'ownerToken', 'claim']) && r.dispatchAuthorized === false &&
    validToken(r.ownerToken) && validClaim(r.claim) && r.claim.state === 'claimed',
  inspect: r => isJsonObject(r) && (r.found === false ? exactKeys(r, ['found'])
    : r.found === true && exactKeys(r, ['found', 'claim', 'recovery']) && validClaim(r.claim) && validRecovery(r.recovery)),
  assessWorkerIdentity: r => exactKeys(r, ['verdict', 'osProcessProof', 'workerDeathInferred', 'redispatchAllowed', 'claim']) &&
    VERDICTS.includes(r.verdict) && r.osProcessProof === 'not-established' && r.workerDeathInferred === false &&
    r.redispatchAllowed === false && validClaim(r.claim),
});

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const sameText = (left, right) => {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

const bad = code => ({ok: false, code});
const good = outcome => ({ok: true, outcome});

// Parses the complete stdout of one child. Exactly one newline-terminated
// JSON line is accepted. The reply must echo this dispatch's correlation and
// operation and match the operation's exact shape.
function parseReply(buffer, {correlation, operation}) {
  if (buffer.length === 0) return bad('REPLY_MISSING');
  let text;
  try { text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(buffer); }
  catch { return bad('REPLY_MALFORMED'); }
  const newline = text.indexOf('\n');
  if (newline === -1) return bad('REPLY_MALFORMED');
  if (newline !== text.length - 1) return bad('REPLY_DUPLICATE');
  let message;
  try { message = JSON.parse(text.slice(0, newline)); }
  catch { return bad('REPLY_MALFORMED'); }
  if (!isJsonObject(message) || message.v !== 1) return bad('REPLY_MALFORMED');
  if (typeof message.correlation !== 'string' || !CORRELATION.test(message.correlation) ||
      !sameText(message.correlation, correlation) || message.operation !== operation) return bad('REPLY_MISMATCH');
  const envelope = ['v', 'correlation', 'operation', 'status'];
  switch (message.status) {
    case 'ok':
      if (!exactKeys(message, [...envelope, 'result']) || !RESULT_SHAPES[operation](message.result)) return bad('REPLY_MALFORMED');
      return good(okOutcome(operation, deepFreeze(message.result)));
    case 'error': {
      if (!exactKeys(message, [...envelope, 'phase', 'code'])) return bad('REPLY_MALFORMED');
      const {phase, code} = message;
      if ((phase !== 'open' && phase !== 'operation') || typeof code !== 'string') return bad('REPLY_MALFORMED');
      if (REJECTION_CODES.has(code)) return good(rejectedOutcome(operation, code, 'exited'));
      if (!STORE_CODES.has(code)) return bad('REPLY_MALFORMED');
      // Opening runs no claim writes. A store failure during a write
      // operation may have happened at or after COMMIT, so it is unknown.
      if (phase === 'open' || !WRITE_OPERATIONS.has(operation)) return good(rejectedOutcome(operation, code, 'exited'));
      return good(unknownOutcome(operation, code, 'exited'));
    }
    case 'rejected':
      if (!exactKeys(message, [...envelope, 'code']) || !PREFLIGHT_CODES.includes(message.code)) return bad('REPLY_MALFORMED');
      return good(rejectedOutcome(operation, message.code, 'exited'));
    case 'unknown':
      if (!exactKeys(message, [...envelope, 'code']) || !CHILD_UNKNOWN_CODES.has(message.code)) return bad('REPLY_MALFORMED');
      return good(unknownOutcome(operation, message.code, 'exited'));
    default:
      return bad('REPLY_MALFORMED');
  }
}

class ClaimsSupervisor {
  #limits;
  #spawn;
  #active = 0;
  #closed = false;

  constructor(limits, spawnImpl) {
    this.#limits = limits;
    this.#spawn = spawnImpl;
  }

  stats() {
    return Object.freeze({active: this.#active, maxConcurrent: this.#limits.maxConcurrent, closed: this.#closed});
  }

  // Stops accepting new work. Running children keep their deadlines.
  close() { this.#closed = true; }

  // Always resolves; never rejects and never retries.
  async run(operation, args) {
    if (typeof operation !== 'string' || !ALLOWED_OPERATIONS.includes(operation)) {
      return rejectedOutcome(null, 'OPERATION_NOT_ALLOWED', 'not-started');
    }
    if (this.#closed) return rejectedOutcome(operation, 'SUPERVISOR_CLOSED', 'not-started');
    let wireArgs;
    try { wireArgs = toWire(args); }
    catch { return rejectedOutcome(operation, 'INVALID_REQUEST', 'not-started'); }
    if (wireArgs === null || typeof wireArgs !== 'object' || Array.isArray(wireArgs)) {
      return rejectedOutcome(operation, 'INVALID_REQUEST', 'not-started');
    }
    const limits = this.#limits;
    const correlation = randomBytes(24).toString('base64url');
    const line = `${JSON.stringify({v: 1, correlation, operation, args: wireArgs, store: {
      path: limits.storePath, maxPages: limits.maxPages, maxRows: limits.maxRows,
      busyTimeoutMs: limits.busyTimeoutMs, heapLimitBytes: limits.sqliteHeapLimitMb * 1048576,
    }})}\n`;
    if (Buffer.byteLength(line, 'utf8') > limits.maxRequestBytes) return rejectedOutcome(operation, 'REQUEST_OVERSIZED', 'not-started');
    if (this.#active >= limits.maxConcurrent) return rejectedOutcome(operation, 'SUPERVISOR_BUSY', 'not-started');
    return this.#dispatch(operation, correlation, line);
  }

  #dispatch(operation, correlation, line) {
    const limits = this.#limits;
    return new Promise(resolve => {
      let child;
      let settled = false;
      let spawned = false;
      let exitObserved = false;
      let slotHeld = true;
      let phase = 'running';
      let terminateCode = null;
      let exitCode = null;
      let exitSignal = null;
      let deadlineTimer = null;
      let exitTimer = null;
      let replyBytes = 0;
      const chunks = [];

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

      try { child = this.#spawn(process.execPath, childArgv(limits), spawnOptions()); }
      catch { release(); finish(rejectedOutcome(operation, 'CHILD_SPAWN_FAILED', 'not-started')); return; }
      if (!child || typeof child.on !== 'function' || !child.stdin || !child.stdout || typeof child.kill !== 'function') {
        // Cannot manage or observe this child; hold the slot.
        finish(unknownOutcome(operation, 'CHILD_ERROR', 'exit-unconfirmed'));
        return;
      }

      child.once('spawn', () => { spawned = true; });
      child.on('error', () => {
        if (!spawned && phase === 'running') {
          phase = 'done';
          release();
          finish(rejectedOutcome(operation, 'CHILD_SPAWN_FAILED', 'not-started'));
          return;
        }
        terminate('CHILD_ERROR');
      });
      child.on('exit', (code, signal) => {
        exitObserved = true;
        exitCode = code;
        exitSignal = signal;
        release();
        if (phase === 'terminating') finish(unknownOutcome(operation, terminateCode, 'exit-observed'));
      });
      child.on('close', (code, signal) => {
        // A close without a prior 'spawn' event is out of order (a real
        // ChildProcess emits 'spawn' first, or 'error' on spawn failure). Its
        // output is never trusted: the exit handler has already released the
        // slot and the deadline turns this into an unknown outcome.
        if (phase !== 'running' || !spawned) return;
        phase = 'done';
        clearTimeout(deadlineTimer);
        if (!exitObserved) {
          exitObserved = true;
          exitCode = code;
          exitSignal = signal;
          release();
        }
        if (exitCode !== 0 || exitSignal !== null) {
          finish(unknownOutcome(operation, 'CHILD_EXIT_UNCLEAN', 'exit-observed'));
          return;
        }
        const parsed = parseReply(Buffer.concat(chunks), {correlation, operation});
        finish(parsed.ok ? parsed.outcome : unknownOutcome(operation, parsed.code, 'exited'));
      });
      child.stdout.on('data', chunk => {
        // Late output after a deadline, kill or decision is dropped unread.
        if (phase !== 'running') return;
        replyBytes += chunk.length;
        if (replyBytes > limits.maxReplyBytes) {
          chunks.length = 0;
          try { child.stdout.destroy(); } catch {}
          terminate('REPLY_OVERSIZED');
          return;
        }
        chunks.push(chunk);
      });
      child.stdout.on('error', () => {});
      child.stdin.on('error', () => {});

      deadlineTimer = setTimeout(() => terminate('CHILD_TIMEOUT'), limits.deadlineMs);
      try { child.stdin.end(line); }
      catch { terminate('CHILD_ERROR'); }
    });
  }
}

export function createClaimsSupervisor(options) {
  return new ClaimsSupervisor(readOptions(options), nodeSpawn);
}

// Test seam only. A spawn implementation is never accepted by the production
// factory, so production code cannot redirect the child entry point.
export const _testing = Object.freeze({
  createSupervisor(options, {spawnImpl}) {
    if (typeof spawnImpl !== 'function') throw new SupervisorError('INVALID_OPTIONS');
    return new ClaimsSupervisor(readOptions(options), spawnImpl);
  },
  toWire,
  parseReply,
  readOptions,
});
