import {createHash, randomBytes} from 'node:crypto';
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
 *   1. The trusted host creates the store once with
 *      openReplayStore({path, create: true}), reads its ledger identity with
 *      getReplayLedgerId(store), and records that identity in its own trusted
 *      configuration. Every later open must pass it as expectedLedgerId.
 *   2. The host issues a fresh, high-entropy invocation nonce, builds the
 *      controller with createVerifiedPatchController, and calls
 *      beginDurableAcceptance(store, controller) BEFORE it dispatches the
 *      verifier. That call durably reserves the nonce in state "pending"
 *      inside one BEGIN IMMEDIATE transaction. If it throws, no verifier may
 *      be dispatched for that controller.
 *   3. After the verifier returns, the host calls
 *      ticket.authenticateAndCommit(evidence, bindings). The evidence is
 *      authenticated by the reviewed authenticator against the controller's
 *      own key, nonce and claim. Only then is the record moved from "pending"
 *      to "committed". Failed evidence moves it to "rejected".
 *      ticket.reject() burns the nonce without evidence.
 *   4. No transition ever returns a nonce to an available state. A record in
 *      any state blocks every later reservation of that nonce. A "pending"
 *      record left by a crash, kill, lost connection, busy store or failed
 *      commit is reported as unresolved (REPLAY_UNRESOLVED) forever. It is
 *      never redispatched or accepted automatically. Recovery is a host
 *      decision: issue a new nonce, and investigate the stuck record
 *      out of band.
 *   5. Any failure after reservation starts leaves the in-memory controller
 *      pending, so that controller instance can never be used again in this
 *      process.
 *
 * Authority
 *   The claim id, scope hash and nonce come only from a genuine host
 *   controller. Genuineness is checked through the authenticator's exported
 *   beginHostAcceptance, which consults its private controller registry
 *   before reading any controller field. Inspection uses the same check and
 *   then calls the returned ticket's abort(), so it does not spend an unused
 *   controller. Callers cannot pass a claim, scope, nonce, trusted flag or
 *   other authority. Extra arguments, unknown options, accessor properties
 *   and proxies are rejected with fixed errors.
 *
 * Ledger identity
 *   Each store gets a random 128-bit ledger id at creation. It is stored in
 *   the meta table and bound into the chain genesis. The host pins it, and
 *   every open and every decision transaction requires the stored id to
 *   equal the pinned one (STORE_IDENTITY_MISMATCH otherwise). This stops a
 *   different, otherwise valid ledger for the same scope from standing in for
 *   the original. It does NOT stop rollback to an older consistent copy of
 *   the same ledger, which carries the same id; and because the id is
 *   readable from the file, a writer with file access can copy it into a
 *   forged ledger. The id is an identifier, not a secret or a key.
 *
 * What is stored
 *   Per record: an insertion sequence number, a sha256 digest of the nonce
 *   (domain separated), claim id, scope hash, state, and a sha256 row
 *   checksum over all of those fields. The meta table holds the ledger id,
 *   record count and the head of a sha256 chain over every record's
 *   immutable fields (sequence, nonce digest, claim id, scope hash) in
 *   sequence order. No HMAC keys, raw nonces, evidence, file digests, paths
 *   or diagnostics are stored. Use high-entropy nonces; an unsalted digest of
 *   a guessable nonce can be brute forced.
 *
 * Integrity check (unkeyed; consistency only, not tamper protection)
 *   Every admission, state transition and inspection validates the WHOLE
 *   store inside the same SQLite transaction that then reads or writes
 *   (BEGIN IMMEDIATE for writes, a read transaction for inspection; open also
 *   validates). Writes also check their change counts and re-validate the
 *   whole ledger, including the expected new record state, before COMMIT.
 *   Any failure rolls back and fails closed. Checked each time: journal
 *   mode, application id, user version, page bounds, SQLite quick_check,
 *   the exact schema (any added trigger, view, index or table is refused),
 *   format, scope, pinned ledger id, count, every row's field shapes and row
 *   checksum, sequence numbers exactly 1..count with no gaps or duplicates,
 *   unique nonce digests, and the recomputed chain head.
 *   This detects, for edits that do not also recompute the checksums:
 *   a changed nonce digest or other field in any row (including rows other
 *   than the one being admitted), a changed state, a deleted row anywhere,
 *   an inserted or reordered row, a changed count, head or ledger id, and
 *   schema or header changes made after open. It also detects damage that
 *   SQLite's quick_check reports.
 *   It CANNOT detect: anyone who recomputes the checksums (the algorithm is
 *   public and unkeyed, so a writer with file access can rewrite rows, count
 *   and head consistently, including deleting the newest rows); a state change
 *   that is consistently re-checksummed (the chain covers only immutable
 *   fields); rollback to an older consistent copy of the same ledger;
 *   power-loss or disk-cache loss of an acknowledged commit; or deletion of
 *   the whole store (which fails closed as unavailable because opens use
 *   create:false). Protection against all of these is the trusted host's job
 *   (file ownership, ACLs, storage durability, backup discipline).
 *
 * What the trusted host must provide and protect
 *   - An absolute path on a local, non-network volume, in a directory that
 *     only the host account can write (no evidence caller, runner, guest or
 *     browser process may read or write the store, its directory, or the
 *     "-journal" sidecar). A missing store fails closed and is never
 *     silently recreated.
 *   - The pinned ledger id, kept in trusted host configuration that evidence
 *     callers cannot change.
 *   - Backup and restore discipline: restoring an older copy of the store
 *     re-opens nonces settled after that copy. Hosts must never restore or
 *     replace the store while nonces issued after the copy could be replayed.
 *   - A corrupt store must be investigated, not repaired or recreated
 *     automatically; recreating it forgets every settled nonce.
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
 * Bounds
 *   At most MAX_RECORDS records and MAX_STORE_BYTES bytes. Full validation is
 *   linear in the store size and runs on every operation; that cost is the
 *   price of checking every row in the deciding transaction.
 *
 * Errors are ReplayGuardError with a fixed code and fixed message. They never
 * include nonces, keys, paths, claim ids, ledger ids, evidence, or SQLite
 * text, and no other error type escapes the exported functions.
 */

export const REPLAY_STORE_FORMAT = 'durable-verifier-replay-v3';
export const REPLAY_STORE_SCOPE = `${VERIFIER_SCOPE}|${VERIFIER_VERSION}`;

const APPLICATION_ID = 0x44565250; // "DVRP"
const USER_VERSION = 3;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 16384;
const DEFAULT_BUSY_TIMEOUT_MS = 2000;
const MAX_BUSY_TIMEOUT_MS = 10000;

const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const LEDGER_ID_RE = /^[0-9a-f]{32}$/;
const CLAIM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NONCE_RE = /^[A-Za-z0-9._-]{16,128}$/;
const COUNT_RE = /^(?:0|[1-9][0-9]{0,5})$/;
const STATES = new Set(['pending', 'committed', 'rejected']);
const OPEN_OPTION_KEYS = new Set(['path', 'create', 'busyTimeoutMs', 'expectedLedgerId']);
const META_KEYS = Object.freeze(['count', 'format', 'head', 'ledger_id', 'scope']);

const SQL_META = "CREATE TABLE replay_meta (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL) STRICT, WITHOUT ROWID";
const SQL_RECORDS = "CREATE TABLE replay_records (" +
  "nonce_digest TEXT PRIMARY KEY NOT NULL CHECK (length(nonce_digest) = 64), " +
  "seq INTEGER NOT NULL UNIQUE CHECK (seq >= 1), " +
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
  STORE_IDENTITY_MISMATCH: 'Replay store ledger identity mismatch.',
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

function rowDigest(seq, digest, claimId, scopeHash, state) {
  return sha256Hex(`${REPLAY_STORE_FORMAT}\0row\0${seq}\0${digest}\0${claimId}\0${scopeHash}\0${state}`);
}

function genesisHead(ledgerId) {
  return sha256Hex(`${REPLAY_STORE_FORMAT}\0genesis\0${REPLAY_STORE_SCOPE}\0${ledgerId}`);
}

function chainLink(head, seq, digest, claimId, scopeHash) {
  return sha256Hex(`${REPLAY_STORE_FORMAT}\0link\0${head}\0${seq}\0${digest}\0${claimId}\0${scopeHash}`);
}

function sqliteCode(error) {
  try {
    return typeof error?.errcode === 'number' ? error.errcode & 0xff : -1;
  } catch {
    return -1;
  }
}

function mapError(error) {
  if (error instanceof ReplayGuardError) return error;
  const code = sqliteCode(error);
  if (code === 5 || code === 6) return fail('STORE_BUSY');
  if (code === 11 || code === 26 || code === 19) return fail('STORE_CORRUPT');
  if (code === 13) return fail('STORE_FULL');
  return fail('STORE_UNAVAILABLE');
}

// Copies own data properties of a plain, non-proxy object without running
// any accessor. Returns null for anything else.
function dataProperties(value, allowed) {
  if (!isPlainObj(value)) return null;
  const out = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    out[key] = descriptor.value;
  }
  return out;
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

// Runs fn inside one transaction. A failed COMMIT is uncertain, never success.
function transaction(db, begin, fn) {
  try {
    db.exec(begin);
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

const immediate = (db, fn) => transaction(db, 'BEGIN IMMEDIATE', fn);
const snapshot = (db, fn) => transaction(db, 'BEGIN DEFERRED', fn);

function pragmaValue(db, name) {
  const row = db.prepare(`PRAGMA ${name}`).get();
  if (!isPlainObj(row)) throw fail('STORE_CORRUPT');
  const values = Object.values(row);
  if (values.length !== 1) throw fail('STORE_CORRUPT');
  return values[0];
}

function initializeStore(db, ledgerId) {
  immediate(db, () => {
    const existing = db.prepare('SELECT count(*) AS n FROM sqlite_schema').get();
    if (!isPlainObj(existing) || existing.n !== 0) throw fail('STORE_CORRUPT');
    db.exec(SQL_META);
    db.exec(SQL_RECORDS);
    const insert = db.prepare('INSERT INTO replay_meta (k, v) VALUES (?, ?)');
    insert.run('count', '0');
    insert.run('format', REPLAY_STORE_FORMAT);
    insert.run('head', genesisHead(ledgerId));
    insert.run('ledger_id', ledgerId);
    insert.run('scope', REPLAY_STORE_SCOPE);
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${USER_VERSION}`);
  });
}

function verifyStructure(db) {
  if (pragmaValue(db, 'journal_mode') !== 'delete') throw fail('STORE_CORRUPT');
  if (pragmaValue(db, 'application_id') !== APPLICATION_ID || pragmaValue(db, 'user_version') !== USER_VERSION) {
    throw fail('STORE_CORRUPT');
  }
  const pages = pragmaValue(db, 'page_count');
  const pageSize = pragmaValue(db, 'page_size');
  if (typeof pages !== 'number' || typeof pageSize !== 'number' || pages * pageSize > MAX_STORE_BYTES) {
    throw fail('STORE_FULL');
  }
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
      // Implicit primary key or UNIQUE index; created by SQLite, not by a caller.
    } else {
      // Any trigger, view, explicit index or extra table is refused.
      throw fail('STORE_CORRUPT');
    }
  }
  if (seen.size !== EXPECTED_TABLES.size) throw fail('STORE_CORRUPT');
}

function readMeta(db, pinnedLedgerId) {
  const rows = db.prepare('SELECT k, v FROM replay_meta ORDER BY k').all();
  if (rows.length !== META_KEYS.length) throw fail('STORE_CORRUPT');
  const meta = {};
  rows.forEach((row, index) => {
    if (!isPlainObj(row) || row.k !== META_KEYS[index] || typeof row.v !== 'string') throw fail('STORE_CORRUPT');
    meta[row.k] = row.v;
  });
  if (meta.format !== REPLAY_STORE_FORMAT || !COUNT_RE.test(meta.count) || !HEX_SHA256_RE.test(meta.head) ||
      !LEDGER_ID_RE.test(meta.ledger_id)) {
    throw fail('STORE_CORRUPT');
  }
  if (meta.scope !== REPLAY_STORE_SCOPE) throw fail('STORE_SCOPE_MISMATCH');
  if (meta.ledger_id !== pinnedLedgerId) throw fail('STORE_IDENTITY_MISMATCH');
  const count = Number(meta.count);
  if (count > MAX_RECORDS) throw fail('STORE_CORRUPT');
  return {count, head: meta.head, ledgerId: meta.ledger_id};
}

// Validates the store identity, structure, every record, the count and the
// chain head. Must run inside the same transaction as any decision based on
// its result.
function loadLedger(db, pinnedLedgerId) {
  verifyStructure(db);
  const meta = readMeta(db, pinnedLedgerId);
  const rows = db.prepare(
    'SELECT seq, nonce_digest, claim_id, scope_hash, state, row_digest FROM replay_records ORDER BY seq LIMIT ?',
  ).all(MAX_RECORDS + 1);
  if (rows.length !== meta.count) throw fail('STORE_CORRUPT');
  const records = new Map();
  let head = genesisHead(meta.ledgerId);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const seq = index + 1;
    if (!isPlainObj(row) || row.seq !== seq || typeof row.nonce_digest !== 'string' ||
        !HEX_SHA256_RE.test(row.nonce_digest) || records.has(row.nonce_digest) ||
        typeof row.claim_id !== 'string' || !CLAIM_ID_RE.test(row.claim_id) ||
        typeof row.scope_hash !== 'string' || !HEX_SHA256_RE.test(row.scope_hash) ||
        !STATES.has(row.state) || typeof row.row_digest !== 'string' ||
        row.row_digest !== rowDigest(seq, row.nonce_digest, row.claim_id, row.scope_hash, row.state)) {
      throw fail('STORE_CORRUPT');
    }
    head = chainLink(head, seq, row.nonce_digest, row.claim_id, row.scope_hash);
    records.set(row.nonce_digest, {seq, claimId: row.claim_id, scopeHash: row.scope_hash, state: row.state});
  }
  if (head !== meta.head) throw fail('STORE_CORRUPT');
  return {count: meta.count, head, records};
}

function requireOneChange(change) {
  if (!isPlainObj(change) || Number(change.changes) !== 1) throw fail('STORE_CORRUPT');
}

function setMeta(db, key, value) {
  requireOneChange(db.prepare('UPDATE replay_meta SET v = ? WHERE k = ?').run(value, key));
}

// After a write, the whole ledger must validate and show exactly the
// expected record before COMMIT; otherwise the transaction rolls back.
function confirmWrite(db, pinnedLedgerId, binding, seq, state, count) {
  const after = loadLedger(db, pinnedLedgerId);
  const record = after.records.get(binding.digest);
  if (after.count !== count || !record || record.seq !== seq || record.state !== state ||
      record.claimId !== binding.claimId || record.scopeHash !== binding.scopeHash) {
    throw fail('STORE_CORRUPT');
  }
}

/**
 * Opens the host-owned replay store.
 * Create once: {path, create: true, busyTimeoutMs?}. Then pin
 * getReplayLedgerId(store) in trusted host configuration.
 * Every later open: {path, expectedLedgerId, busyTimeoutMs?}.
 */
export function openReplayStore(options) {
  if (arguments.length !== 1) throw fail('STORE_CONFIG');
  const opts = dataProperties(options, OPEN_OPTION_KEYS);
  if (!opts) throw fail('STORE_CONFIG');
  const {path, create = false, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS, expectedLedgerId} = opts;
  validatePath(path);
  if (typeof create !== 'boolean' || !Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 ||
      busyTimeoutMs > MAX_BUSY_TIMEOUT_MS) {
    throw fail('STORE_CONFIG');
  }
  if (create ? expectedLedgerId !== undefined
    : typeof expectedLedgerId !== 'string' || !LEDGER_ID_RE.test(expectedLedgerId)) {
    throw fail('STORE_CONFIG');
  }
  const ledgerId = create ? randomBytes(16).toString('hex') : expectedLedgerId;
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
    if (create) initializeStore(db, ledgerId);
    snapshot(db, () => loadLedger(db, ledgerId));
  } catch (error) {
    try {
      db.close();
    } catch {
      // Closing a failed handle is best effort; the open already failed closed.
    }
    throw mapError(error);
  }
  const handle = Object.freeze({});
  stores.set(handle, {db, open: true, ledgerId});
  return handle;
}

/** Returns the ledger id the host must pin after creating the store. */
export function getReplayLedgerId(store) {
  if (arguments.length !== 1) throw fail('STORE_CONFIG');
  return requireStoreState(store).ledgerId;
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

function requireStoreState(store) {
  let state;
  try {
    state = stores.get(store);
  } catch {
    state = undefined;
  }
  if (!state || !state.open) throw fail('STORE_UNAVAILABLE');
  return state;
}

// Genuineness check through the authenticator's private registry. A genuine
// unused controller is reserved in memory and returned; a genuine controller
// already in use or consumed yields null. Anything else is refused.
function hostReservation(controller) {
  try {
    return beginHostAcceptance(controller);
  } catch (error) {
    let message;
    try {
      message = error?.message;
    } catch {
      message = undefined;
    }
    if (message === 'Replayed invocation nonce.') return null;
    throw fail('CONTROLLER_REQUIRED');
  }
}

// Reads binding fields of a controller already proven genuine (frozen, data
// properties set by the authenticator). Never trusts caller-shaped objects.
function controllerBinding(controller) {
  let nonce;
  let claimId;
  let scopeHash;
  try {
    nonce = controller.expectedInvocationNonce;
    claimId = controller.claim.claimId;
    scopeHash = controller.claim.scopeHash;
  } catch {
    throw fail('CONTROLLER_REQUIRED');
  }
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

function transition(storeState, binding, target) {
  const {db, ledgerId} = storeState;
  immediate(db, () => {
    const ledger = loadLedger(db, ledgerId);
    const record = ledger.records.get(binding.digest);
    if (!record) throw fail('STORE_CORRUPT');
    if (record.claimId !== binding.claimId || record.scopeHash !== binding.scopeHash) throw fail('CLAIM_MISMATCH');
    if (record.state !== 'pending') throw fail('STORE_CORRUPT');
    const before = rowDigest(record.seq, binding.digest, binding.claimId, binding.scopeHash, 'pending');
    const after = rowDigest(record.seq, binding.digest, binding.claimId, binding.scopeHash, target);
    requireOneChange(db.prepare(
      "UPDATE replay_records SET state = ?, row_digest = ? " +
      "WHERE nonce_digest = ? AND seq = ? AND state = 'pending' AND row_digest = ?",
    ).run(target, after, binding.digest, record.seq, before));
    confirmWrite(db, ledgerId, binding, record.seq, target, ledger.count);
  });
}

/**
 * Returns 'absent', 'pending', 'committed' or 'rejected' for a genuine host
 * controller's nonce. Validates the whole store, writes nothing, and does not
 * spend an unused controller.
 */
export function inspectReplayRecord(store, controller) {
  if (arguments.length !== 2) throw fail('STORE_CONFIG');
  const {db, ledgerId} = requireStoreState(store);
  const reservation = hostReservation(controller);
  if (reservation) reservation.abort();
  const binding = controllerBinding(controller);
  const record = snapshot(db, () => loadLedger(db, ledgerId).records.get(binding.digest));
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
  const storeState = requireStoreState(store);
  const {db, ledgerId} = storeState;
  const hostTicket = hostReservation(controller);
  if (!hostTicket) throw fail('REPLAY_REJECTED');
  // From here on the in-memory controller stays pending unless commit succeeds.
  const binding = controllerBinding(controller);
  immediate(db, () => {
    const ledger = loadLedger(db, ledgerId);
    const record = ledger.records.get(binding.digest);
    if (record) refuseExisting(record, binding);
    if (ledger.count >= MAX_RECORDS) throw fail('STORE_FULL');
    const seq = ledger.count + 1;
    requireOneChange(db.prepare(
      "INSERT INTO replay_records (nonce_digest, seq, claim_id, scope_hash, state, row_digest) " +
      "VALUES (?, ?, ?, ?, 'pending', ?)",
    ).run(binding.digest, seq, binding.claimId, binding.scopeHash,
      rowDigest(seq, binding.digest, binding.claimId, binding.scopeHash, 'pending')));
    setMeta(db, 'count', String(seq));
    setMeta(db, 'head', chainLink(ledger.head, seq, binding.digest, binding.claimId, binding.scopeHash));
    confirmWrite(db, ledgerId, binding, seq, 'pending', seq);
  });

  let state = 'reserved';
  const settleDurable = target => {
    try {
      transition(requireStoreState(store), binding, target);
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
