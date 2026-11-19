import {createHash} from 'node:crypto';
import {closeSync, lstatSync, openSync} from 'node:fs';
import {isAbsolute, resolve as resolvePath} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {types as utilTypes} from 'node:util';
import {
  authenticateVerifierEvidence,
  beginHostAcceptance,
  VERIFIER_SCOPE,
  VERIFIER_VERSION,
} from './host-evidence-authenticator.mjs';

/**
 * Durable, host-owned replay guard for the fixed-fixture verifier.
 *
 * Purpose
 *   host-evidence-authenticator.mjs accepts an invocation nonce once per
 *   controller instance. This helper adds a small SQLite store (node:sqlite,
 *   built in) so the same invocation nonce cannot be accepted twice across
 *   connections, processes or restarts.
 *
 * Contract
 *   1. The trusted host issues a fresh, high-entropy invocation nonce, builds
 *      the controller with createVerifiedPatchController, and calls
 *      beginDurableAcceptance(store, controller) BEFORE it dispatches the
 *      verifier. That call durably reserves the nonce in state "pending"
 *      inside one BEGIN IMMEDIATE transaction. The nonce digest is the primary
 *      key, so at most one reservation can ever exist for a nonce.
 *   2. After the verifier returns, the host calls
 *      ticket.authenticateAndCommit(evidence, bindings). The evidence is
 *      authenticated by the reviewed authenticator against the controller's
 *      own key, nonce and claim. Only then is the record moved from "pending"
 *      to "committed". Failed evidence moves it to "rejected".
 *      ticket.reject() burns the nonce without evidence.
 *   3. No transition ever returns a nonce to an available state. A record in
 *      any state blocks every later reservation of that nonce. A "pending"
 *      record left by a crash, kill, lost connection, busy store or failed
 *      commit is reported as unresolved (REPLAY_UNRESOLVED) forever. It is
 *      never redispatched or accepted automatically. Recovery is a host
 *      decision: issue a new nonce, and investigate the stuck record
 *      out of band.
 *   4. Any failure after reservation leaves the in-memory controller pending,
 *      so that controller instance can never be used again in this process.
 *
 * Authority
 *   The claim id, scope hash and nonce come only from a genuine host
 *   controller (validated through beginHostAcceptance, which checks the
 *   authenticator's private registry). Callers cannot pass a claim, scope,
 *   nonce, trusted flag or other authority to these functions. Extra
 *   arguments and unknown options are rejected.
 *
 * What is stored
 *   Per record: sha256 digest of the nonce (domain separated), claim id,
 *   scope hash, state, and a sha256 row checksum. No HMAC keys, raw nonces,
 *   evidence, file digests, paths or diagnostics are stored. The checksum
 *   detects accidental corruption and naive edits only. It is not a MAC: a
 *   writer with file access can forge rows, so file protection is the host's
 *   job. Use high-entropy nonces; an unsalted digest of a guessable nonce can
 *   be brute forced.
 *
 * What the trusted host must provide and protect
 *   - An absolute path on a local, non-network volume, in a directory that
 *     only the host account can write (no evidence caller, runner, guest or
 *     browser process may read or write the store, its directory, or the
 *     "-journal" sidecar). The store is created once with create:true and
 *     opened with create:false afterwards; a missing store fails closed and
 *     is never silently recreated.
 *   - Backup and restore discipline: restoring an older copy of the store
 *     re-opens nonces settled after that copy. Hosts must never restore or
 *     replace the store while nonces issued after the copy could be replayed.
 *   - Process isolation: the store handle and controllers stay in host
 *     memory. Nothing here is safe to expose to untrusted code.
 *
 * Not covered (explicitly out of scope for this standalone helper)
 *   Actual host wiring, Windows power-loss durability of the filesystem and
 *   disk cache, browser staging, the live runner, network filesystems, and
 *   atomicity across this store and any other store (for example a patch
 *   apply step). A crash between commit here and a later host side effect
 *   must be reconciled by the host. Tests use throwaway databases only.
 *
 * Errors are ReplayGuardError with a fixed code and fixed message. They never
 * include nonces, keys, paths, claim ids, evidence, or SQLite text.
 */

export const REPLAY_STORE_FORMAT = 'durable-verifier-replay-v1';
export const REPLAY_STORE_SCOPE = `${VERIFIER_SCOPE}|${VERIFIER_VERSION}`;

const APPLICATION_ID = 0x44565250; // "DVRP"
const USER_VERSION = 1;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 65536;
const DEFAULT_BUSY_TIMEOUT_MS = 2000;
const MAX_BUSY_TIMEOUT_MS = 10000;

const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const CLAIM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NONCE_RE = /^[A-Za-z0-9._-]{16,128}$/;
const STATES = new Set(['pending', 'committed', 'rejected']);
const OPEN_OPTION_KEYS = new Set(['path', 'create', 'busyTimeoutMs']);

const SQL_META = "CREATE TABLE replay_meta (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL) STRICT, WITHOUT ROWID";
const SQL_RECORDS = "CREATE TABLE replay_records (" +
  "nonce_digest TEXT PRIMARY KEY NOT NULL CHECK (length(nonce_digest) = 64), " +
  "claim_id TEXT NOT NULL CHECK (length(claim_id) BETWEEN 1 AND 128), " +
  "scope_hash TEXT NOT NULL CHECK (length(scope_hash) = 64), " +
  "state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'rejected')), " +
  "row_digest TEXT NOT NULL CHECK (length(row_digest) = 64)" +
  ") STRICT, WITHOUT ROWID";
const EXPECTED_TABLES = new Map([['replay_meta', SQL_META], ['replay_records', SQL_RECORDS]]);

const MESSAGES = Object.freeze({
  STORE_CONFIG: 'Replay store configuration is invalid.',
  STORE_EXISTS: 'Replay store already exists.',
  STORE_UNAVAILABLE: 'Replay store is unavailable.',
  STORE_BUSY: 'Replay store is busy.',
  STORE_CORRUPT: 'Replay store is corrupt or unrecognized.',
  STORE_SCOPE_MISMATCH: 'Replay store scope mismatch.',
  STORE_FULL: 'Replay store is full.',
  CONTROLLER_REQUIRED: 'Host controller is required.',
  REPLAY_REJECTED: 'Invocation nonce was already settled.',
  REPLAY_UNRESOLVED: 'Invocation nonce has an unresolved prior acceptance.',
  CLAIM_MISMATCH: 'Replay record claim or scope mismatch.',
  TICKET_SETTLED: 'Acceptance ticket is already settled.',
  EVIDENCE_REJECTED: 'Verifier evidence was rejected.',
  ACCEPTANCE_UNRESOLVED: 'Acceptance outcome is unresolved.',
});

export const REPLAY_ERROR_MESSAGES = MESSAGES;

export class ReplayGuardError extends Error {
  constructor(code, durable) {
    super(Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : MESSAGES.STORE_UNAVAILABLE);
    this.name = 'ReplayGuardError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'STORE_UNAVAILABLE';
    if (durable !== undefined) this.durable = durable;
  }
}

const stores = new WeakMap();

function fail(code, durable) {
  return new ReplayGuardError(code, durable);
}

function isPlainObj(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function nonceDigest(nonce) {
  return sha256Hex(`${REPLAY_STORE_FORMAT}\0nonce\0${nonce}`);
}

function rowDigest(digest, claimId, scopeHash, state) {
  return sha256Hex(`${REPLAY_STORE_FORMAT}\0row\0${digest}\0${claimId}\0${scopeHash}\0${state}`);
}

function sqliteCode(error) {
  return typeof error?.errcode === 'number' ? error.errcode & 0xff : -1;
}

function mapError(error) {
  if (error instanceof ReplayGuardError) return error;
  const code = sqliteCode(error);
  if (code === 5 || code === 6) return fail('STORE_BUSY');
  if (code === 11 || code === 26 || code === 19) return fail('STORE_CORRUPT');
  if (code === 13) return fail('STORE_FULL');
  return fail('STORE_UNAVAILABLE');
}

function validatePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024 || path.includes('\0') ||
      !isAbsolute(path) || resolvePath(path) !== path || /^file:/i.test(path) || path.includes('?') ||
      path.startsWith('\\\\') || path.startsWith('//')) {
    throw fail('STORE_CONFIG');
  }
}

function safeRollback(db) {
  try {
    db.exec('ROLLBACK');
  } catch {
    // The outcome is already treated as failed or unresolved by the caller.
  }
}

// Runs fn inside BEGIN IMMEDIATE. A failed COMMIT is uncertain, never success.
function immediate(db, fn) {
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    throw mapError(error);
  }
  let result;
  try {
    result = fn();
  } catch (error) {
    safeRollback(db);
    throw mapError(error);
  }
  try {
    db.exec('COMMIT');
  } catch (error) {
    safeRollback(db);
    throw mapError(error);
  }
  return result;
}

function pragmaValue(db, name) {
  const row = db.prepare(`PRAGMA ${name}`).get();
  if (!isPlainObj(row)) throw fail('STORE_CORRUPT');
  const values = Object.values(row);
  if (values.length !== 1) throw fail('STORE_CORRUPT');
  return values[0];
}

function checkSize(db) {
  const pages = pragmaValue(db, 'page_count');
  const pageSize = pragmaValue(db, 'page_size');
  if (typeof pages !== 'number' || typeof pageSize !== 'number' || pages * pageSize > MAX_STORE_BYTES) {
    throw fail('STORE_FULL');
  }
}

function initializeStore(db) {
  immediate(db, () => {
    const existing = db.prepare('SELECT count(*) AS n FROM sqlite_schema').get();
    if (!isPlainObj(existing) || existing.n !== 0) throw fail('STORE_CORRUPT');
    db.exec(SQL_META);
    db.exec(SQL_RECORDS);
    const insert = db.prepare('INSERT INTO replay_meta (k, v) VALUES (?, ?)');
    insert.run('format', REPLAY_STORE_FORMAT);
    insert.run('scope', REPLAY_STORE_SCOPE);
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${USER_VERSION}`);
  });
}

function verifyStore(db) {
  if (pragmaValue(db, 'journal_mode') !== 'delete') throw fail('STORE_CORRUPT');
  if (pragmaValue(db, 'application_id') !== APPLICATION_ID || pragmaValue(db, 'user_version') !== USER_VERSION) {
    throw fail('STORE_CORRUPT');
  }
  checkSize(db);
  const check = db.prepare('PRAGMA quick_check').all();
  if (check.length !== 1 || !isPlainObj(check[0]) || Object.values(check[0])[0] !== 'ok') throw fail('STORE_CORRUPT');
  const schema = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema').all();
  const seen = new Set();
  for (const row of schema) {
    if (!isPlainObj(row)) throw fail('STORE_CORRUPT');
    if (row.type === 'table' && EXPECTED_TABLES.get(row.name) === row.sql && row.tbl_name === row.name) {
      seen.add(row.name);
    } else if (row.type === 'index' && row.sql === null && EXPECTED_TABLES.has(row.tbl_name) &&
               typeof row.name === 'string' && row.name.startsWith(`sqlite_autoindex_${row.tbl_name}_`)) {
      // Implicit primary key index; created by SQLite, not by a caller.
    } else {
      throw fail('STORE_CORRUPT');
    }
  }
  if (seen.size !== EXPECTED_TABLES.size) throw fail('STORE_CORRUPT');
  const meta = db.prepare('SELECT k, v FROM replay_meta ORDER BY k').all();
  if (meta.length !== 2 || meta[0].k !== 'format' || meta[1].k !== 'scope' ||
      meta[0].v !== REPLAY_STORE_FORMAT) {
    throw fail('STORE_CORRUPT');
  }
  if (meta[1].v !== REPLAY_STORE_SCOPE) throw fail('STORE_SCOPE_MISMATCH');
}

/**
 * Opens (or with create:true, creates) the host-owned replay store.
 * Options: {path, create = false, busyTimeoutMs = 2000}. Nothing else.
 */
export function openReplayStore(options) {
  if (arguments.length !== 1 || !isPlainObj(options)) throw fail('STORE_CONFIG');
  for (const key of Object.keys(options)) {
    if (!OPEN_OPTION_KEYS.has(key)) throw fail('STORE_CONFIG');
  }
  const {path, create = false, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS} = options;
  validatePath(path);
  if (typeof create !== 'boolean' || !Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 ||
      busyTimeoutMs > MAX_BUSY_TIMEOUT_MS) {
    throw fail('STORE_CONFIG');
  }
  if (create) {
    let fd;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (error) {
      throw fail(error?.code === 'EEXIST' ? 'STORE_EXISTS' : 'STORE_UNAVAILABLE');
    }
    try {
      closeSync(fd);
    } catch {
      throw fail('STORE_UNAVAILABLE');
    }
  } else {
    let info;
    try {
      info = lstatSync(path);
    } catch {
      throw fail('STORE_UNAVAILABLE');
    }
    if (info.isSymbolicLink() || !info.isFile()) throw fail('STORE_UNAVAILABLE');
    if (info.size > MAX_STORE_BYTES) throw fail('STORE_FULL');
  }
  let db;
  try {
    db = new DatabaseSync(path, {open: true, readOnly: false, allowExtension: false});
  } catch (error) {
    throw mapError(error);
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA trusted_schema = OFF');
    db.exec('PRAGMA cell_size_check = ON');
    if (create) initializeStore(db);
    verifyStore(db);
  } catch (error) {
    try {
      db.close();
    } catch {
      // Closing a failed handle is best effort; the open already failed closed.
    }
    throw mapError(error);
  }
  const handle = Object.freeze({});
  stores.set(handle, {db, open: true});
  return handle;
}

export function closeReplayStore(store) {
  const state = stores.get(store);
  if (!state || !state.open) return;
  state.open = false;
  try {
    state.db.close();
  } catch {
    // The handle is unusable either way.
  }
}

function requireStore(store) {
  const state = stores.get(store);
  if (!state || !state.open) throw fail('STORE_UNAVAILABLE');
  return state.db;
}

function readRecord(db, digest) {
  const rows = db.prepare(
    'SELECT nonce_digest, claim_id, scope_hash, state, row_digest FROM replay_records WHERE nonce_digest = ?',
  ).all(digest);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw fail('STORE_CORRUPT');
  const row = rows[0];
  if (!isPlainObj(row) || row.nonce_digest !== digest || typeof row.claim_id !== 'string' ||
      !CLAIM_ID_RE.test(row.claim_id) || typeof row.scope_hash !== 'string' || !HEX_SHA256_RE.test(row.scope_hash) ||
      !STATES.has(row.state) || typeof row.row_digest !== 'string' ||
      row.row_digest !== rowDigest(digest, row.claim_id, row.scope_hash, row.state)) {
    throw fail('STORE_CORRUPT');
  }
  return {claimId: row.claim_id, scopeHash: row.scope_hash, state: row.state};
}

// Reads only the host-held binding fields. Genuineness is checked separately.
function controllerBinding(controller) {
  const nonce = controller?.expectedInvocationNonce;
  const claimId = controller?.claim?.claimId;
  const scopeHash = controller?.claim?.scopeHash;
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce) || typeof claimId !== 'string' ||
      !CLAIM_ID_RE.test(claimId) || typeof scopeHash !== 'string' || !HEX_SHA256_RE.test(scopeHash)) {
    throw fail('CONTROLLER_REQUIRED');
  }
  return {digest: nonceDigest(nonce), nonce, claimId, scopeHash};
}

function refuseExisting(record, binding) {
  if (record.claimId !== binding.claimId || record.scopeHash !== binding.scopeHash) throw fail('CLAIM_MISMATCH');
  throw fail(record.state === 'pending' ? 'REPLAY_UNRESOLVED' : 'REPLAY_REJECTED');
}

function transition(db, binding, target) {
  immediate(db, () => {
    const record = readRecord(db, binding.digest);
    if (!record) throw fail('STORE_CORRUPT');
    if (record.claimId !== binding.claimId || record.scopeHash !== binding.scopeHash) throw fail('CLAIM_MISMATCH');
    if (record.state !== 'pending') throw fail('STORE_CORRUPT');
    const before = rowDigest(binding.digest, binding.claimId, binding.scopeHash, 'pending');
    const after = rowDigest(binding.digest, binding.claimId, binding.scopeHash, target);
    const change = db.prepare(
      "UPDATE replay_records SET state = ?, row_digest = ? WHERE nonce_digest = ? AND state = 'pending' AND row_digest = ?",
    ).run(target, after, binding.digest, before);
    if (Number(change.changes) !== 1) throw fail('STORE_CORRUPT');
  });
}

/**
 * Returns 'absent', 'pending', 'committed' or 'rejected' for the controller's
 * nonce. Read-only and grants no authority.
 */
export function inspectReplayRecord(store, controller) {
  if (arguments.length !== 2) throw fail('STORE_CONFIG');
  const db = requireStore(store);
  const binding = controllerBinding(controller);
  let record;
  try {
    record = readRecord(db, binding.digest);
  } catch (error) {
    throw mapError(error);
  }
  if (!record) return 'absent';
  if (record.claimId !== binding.claimId || record.scopeHash !== binding.scopeHash) throw fail('CLAIM_MISMATCH');
  return record.state;
}

/**
 * Durably reserves the controller's nonce. Call before dispatching the
 * verifier. Returns a single-use ticket.
 */
export function beginDurableAcceptance(store, controller) {
  if (arguments.length !== 2) throw fail('STORE_CONFIG');
  const db = requireStore(store);
  let hostTicket;
  try {
    hostTicket = beginHostAcceptance(controller);
  } catch (error) {
    throw fail(error?.message === 'Replayed invocation nonce.' ? 'REPLAY_REJECTED' : 'CONTROLLER_REQUIRED');
  }
  // From here on the in-memory controller stays pending unless commit succeeds.
  const binding = controllerBinding(controller);
  immediate(db, () => {
    checkSize(db);
    const record = readRecord(db, binding.digest);
    if (record) refuseExisting(record, binding);
    const count = db.prepare('SELECT count(*) AS n FROM replay_records').get();
    if (!isPlainObj(count) || typeof count.n !== 'number' || count.n >= MAX_RECORDS) throw fail('STORE_FULL');
    db.prepare(
      "INSERT INTO replay_records (nonce_digest, claim_id, scope_hash, state, row_digest) VALUES (?, ?, ?, 'pending', ?)",
    ).run(binding.digest, binding.claimId, binding.scopeHash,
      rowDigest(binding.digest, binding.claimId, binding.scopeHash, 'pending'));
  });

  let state = 'reserved';
  const settleDurable = target => {
    try {
      transition(requireStore(store), binding, target);
      return true;
    } catch {
      return false;
    }
  };

  return Object.freeze({
    get state() {
      return state;
    },
    authenticateAndCommit(evidence, bindings) {
      if (arguments.length !== 2) throw fail('STORE_CONFIG');
      if (state !== 'reserved') throw fail('TICKET_SETTLED');
      state = 'settling';
      let result;
      try {
        result = authenticateVerifierEvidence(controller, evidence, bindings);
        if (!isPlainObj(result) || result.invocationNonce !== binding.nonce || result.claimId !== binding.claimId ||
            result.scopeHash !== binding.scopeHash) {
          throw new Error('binding');
        }
      } catch {
        state = settleDurable('rejected') ? 'rejected' : 'unresolved';
        throw fail('EVIDENCE_REJECTED', state);
      }
      if (!settleDurable('committed')) {
        state = 'unresolved';
        throw fail('ACCEPTANCE_UNRESOLVED', state);
      }
      hostTicket.commit();
      state = 'committed';
      return result;
    },
    reject() {
      if (arguments.length !== 0) throw fail('STORE_CONFIG');
      if (state !== 'reserved') throw fail('TICKET_SETTLED');
      state = 'settling';
      state = settleDurable('rejected') ? 'rejected' : 'unresolved';
      if (state === 'unresolved') throw fail('ACCEPTANCE_UNRESOLVED', state);
      return state;
    },
  });
}
