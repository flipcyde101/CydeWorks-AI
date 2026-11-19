// Disconnected, host-owned durable claim registry for synthetic runner requests.
//
// Scope: Gate G2 (RB-G01-B) groundwork for RPL-01, RPL-02, RST-03 and
// DUR-01, DUR-02, DUR-04, DUR-05. This module is NOT wired into the runner,
// the controller, the browser service or any worker adapter. It never launches,
// stops or inspects a process. It records synthetic identifiers and hashes and
// refuses to authorize a second dispatch for the same request.
//
// State machine (monotonic, one step at a time):
//   claimed -> dispatch-intent -> worker-recorded -> completed
// A crash at any point leaves the last committed state. Every state other than
// "completed" is reported as unresolved with redispatchAllowed: false. The only
// recovery this helper offers is an explicit host decision, bound to the
// observed owner generation, to continue a claim that never recorded a
// dispatch intent. It issues a new fenced owner generation and never
// dispatches anything itself.
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {types} from 'node:util';
import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';

export const SCHEMA_VERSION = 'cydeworks-durable-request-claims/2';

export const TRUST_LIMITS = Object.freeze([
  'Host authority: the registry trusts the calling host process. Host completion evidence and host continue decisions are recorded as attestations; the registry does not verify cleanup, inference settlement or that no dispatch occurred.',
  'Checksums are unkeyed SHA-256. They detect accidental corruption and partial edits, including a request key changed without resealing. A writer with file access can rewrite rows and recompute every digest consistently, and that rewrite is accepted. No tamper protection is claimed.',
  'Rollback is not detected. Restoring an older copy of the store file, or deleting it and initializing a new one, silently forgets claims. initialize: true must only be used for a newly provisioned store.',
  'SQLite integrity_check runs before every transaction body. It verifies b-tree structure and that index entries agree with table rows. It cannot detect a structurally valid, semantically consistent rewrite.',
  'Process identity: worker birth identity is the exact triple {pid, creationTime, bootId}, stored as a hash. A matching hash is not proof that the OS process is alive, dead or the same process. Partial identities are rejected and worker death is never inferred.',
  'Dispatch uncertainty: after a dispatch intent is committed, a crash leaves it unknown whether dispatch happened. The claim stays unresolved; actual worker-tree discovery and termination are outside this helper.',
  'Journal mode: only the SQLite rollback journal (journal_mode=delete) is accepted. It is checked at open and inside every transaction after the store is read; a WAL or other mode fails closed with STORE_UNSUPPORTED and the registry never converts an existing store. Durability still relies on synchronous=FULL and on the OS and disk honoring flushes. Windows durability (write caching, removable drives, power loss) is not verified or claimed.',
  'Capacity: the default bound is 1024 claims within 2048 pages. The store page_count and the connection effective max_page_count are checked at open and inside every transaction; a store larger than maxPages, or a limit SQLite kept above it, fails closed with STORE_FULL. Every transaction validates the whole store, so cost grows linearly with rows. A larger maxRows needs a matching maxPages.',
  'Not claimed: Windows Stop, actual worker-tree recovery, live runner qualification, browser staging, event cursor replay (RPL-03), result artifact exclusivity (DUR-03) and atomicity across other stores (usage ledger, approval audit, result files).',
  'Hashes of low-entropy synthetic values can be guessed. Callers must not place secrets or raw environment data in request ids or scopes.',
]);

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OWNER_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const IDENTITY_TEXT = /^[\x21-\x7e]{1,128}$/;
const STATES = Object.freeze(['claimed', 'dispatch-intent', 'worker-recorded', 'completed']);
const MAX_SCOPE_NODES = 2048;
const MAX_SCOPE_DEPTH = 16;
const MAX_SCOPE_CHARS = 65536;
const MAX_STRING_CHARS = 4096;
const MAX_GENERATION = 1000000;

const TABLES = Object.freeze({
  claims: 'CREATE TABLE claims (request_key TEXT PRIMARY KEY NOT NULL, scope_hash TEXT NOT NULL, state TEXT NOT NULL, generation INTEGER NOT NULL, owner_hash TEXT NOT NULL, nonce TEXT, worker_hash TEXT, result_hash TEXT, row_digest TEXT NOT NULL) STRICT',
  meta: 'CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT',
});
const AUTO_INDEXES = Object.freeze(['sqlite_autoindex_claims_1', 'sqlite_autoindex_meta_1']);

const MESSAGES = Object.freeze({
  INVALID_OPTIONS: 'Claim registry options are invalid.',
  INVALID_INPUT: 'Claim request input is invalid.',
  NOT_FOUND: 'No durable claim exists for this request.',
  SCOPE_MISMATCH: 'This request is already bound to a different scope.',
  OWNER_MISMATCH: 'Owner token does not match the current claim generation.',
  INVALID_TRANSITION: 'Claim state does not permit this transition.',
  NONCE_MISMATCH: 'Dispatch nonce does not match the recorded dispatch intent.',
  INSUFFICIENT_IDENTITY: 'Worker birth identity must be the full {pid, creationTime, bootId} triple.',
  IDENTITY_CONFLICT: 'Worker birth identity is already recorded for another claim.',
  HOST_AUTHORITY_REQUIRED: 'An explicit host decision is required for this action.',
  STALE_DECISION: 'Host decision was based on a stale claim generation.',
  RECOVERY_REQUIRES_EXTERNAL_PROOF: 'Claim is unresolved; recovery needs host proof outside this helper.',
  STORE_UNAVAILABLE: 'Claim store is unavailable.',
  STORE_UNINITIALIZED: 'Claim store is not initialized.',
  STORE_CORRUPT: 'Claim store failed integrity validation.',
  STORE_BUSY: 'Claim store is busy.',
  STORE_FULL: 'Claim store has reached its bound.',
  STORE_CONFLICT: 'Claim store changed unexpectedly during the transaction.',
  STORE_UNSUPPORTED: 'Claim store uses an unsupported journal mode.',
  REGISTRY_CLOSED: 'Claim registry is closed.',
  INTERNAL_ERROR: 'Claim registry failed internally.',
});

// Errors carry only a fixed code and message. No path, request id, scope,
// token, identity or underlying driver text is attached, and there is no cause.
export class ClaimRegistryError extends Error {
  constructor(code) {
    const known = Object.hasOwn(MESSAGES, code) ? code : 'INTERNAL_ERROR';
    super(MESSAGES[known]);
    this.name = 'ClaimRegistryError';
    this.code = known;
  }
  toJSON() { return {name: this.name, code: this.code, message: this.message}; }
}

const fail = code => { throw new ClaimRegistryError(code); };

function mapStoreError(error) {
  if (error instanceof ClaimRegistryError) return error;
  if (error && error.code === 'ERR_SQLITE_ERROR') {
    const primary = Number(error.errcode) & 0xff;
    if (primary === 5 || primary === 6) return new ClaimRegistryError('STORE_BUSY');
    if (primary === 11 || primary === 26) return new ClaimRegistryError('STORE_CORRUPT');
    if (primary === 13) return new ClaimRegistryError('STORE_FULL');
    if (primary === 19) return new ClaimRegistryError('STORE_CONFLICT');
    if (!Number.isInteger(Number(error.errcode))) {
      const text = String(error.message);
      if (/locked|busy/i.test(text)) return new ClaimRegistryError('STORE_BUSY');
      if (/not a database|malformed|corrupt/i.test(text)) return new ClaimRegistryError('STORE_CORRUPT');
    }
    return new ClaimRegistryError('STORE_UNAVAILABLE');
  }
  return new ClaimRegistryError('INTERNAL_ERROR');
}

// Any unexpected failure while reading caller input becomes a fixed
// INVALID_INPUT error, so no caller-controlled message or stack escapes.
function sanitizeInput(body) {
  try { return body(); }
  catch (error) { throw error instanceof ClaimRegistryError ? error : new ClaimRegistryError('INVALID_INPUT'); }
}

const digest = (domain, text) => createHash('sha256')
  .update(`${SCHEMA_VERSION}\0${domain}\0${text}`, 'utf8').digest('hex');

const isHex = value => typeof value === 'string' && HEX64.test(value);

// Safe only for values already known not to be proxies.
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Reads a caller record through property descriptors only. Proxies, class
// instances, symbol keys, non-enumerable keys, accessors and unknown keys are
// rejected without running any caller code.
function readRecord(value, allowed, code = 'INVALID_INPUT') {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || !isPlainObject(value)) fail(code);
  const record = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) fail(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    record[key] = descriptor.value;
  }
  return record;
}

const readArgs = (args, allowed) => sanitizeInput(() => readRecord(args === undefined ? {} : args, allowed));

// Deterministic JSON for scopes with sorted keys and bounded size. Only
// null, booleans, finite numbers (not -0), strings, plain dense arrays and
// plain objects are accepted. Every property is read from its data
// descriptor, so getters never run. Arrays must own exactly their indices and
// length. Anything else fails closed instead of being silently omitted.
function canonicalScopeJson(value) {
  let nodes = 0;
  const walk = (item, depth) => {
    if (++nodes > MAX_SCOPE_NODES || depth > MAX_SCOPE_DEPTH) fail('INVALID_INPUT');
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'string') {
      if (item.length > MAX_STRING_CHARS) fail('INVALID_INPUT');
      return JSON.stringify(item);
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0)) fail('INVALID_INPUT');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object' || types.isProxy(item)) fail('INVALID_INPUT');
    const proto = Object.getPrototypeOf(item);
    const keys = Reflect.ownKeys(item);
    const dataValue = key => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT');
      return descriptor.value;
    };
    if (Array.isArray(item)) {
      if (proto !== Array.prototype) fail('INVALID_INPUT');
      const length = Object.getOwnPropertyDescriptor(item, 'length').value;
      if (!Number.isSafeInteger(length) || length > MAX_SCOPE_NODES) fail('INVALID_INPUT');
      if (keys.length !== length + 1 || keys[length] !== 'length') fail('INVALID_INPUT');
      const parts = [];
      for (let index = 0; index < length; index++) {
        if (keys[index] !== String(index)) fail('INVALID_INPUT');
        parts.push(walk(dataValue(keys[index]), depth + 1));
      }
      return `[${parts.join(',')}]`;
    }
    if (proto !== Object.prototype && proto !== null) fail('INVALID_INPUT');
    const names = [];
    for (const key of keys) {
      if (typeof key !== 'string' || key.length > MAX_STRING_CHARS) fail('INVALID_INPUT');
      names.push(key);
    }
    names.sort();
    const parts = names.map(key => `${JSON.stringify(key)}:${walk(dataValue(key), depth + 1)}`);
    return `{${parts.join(',')}}`;
  };
  const text = walk(value, 0);
  if (text.length > MAX_SCOPE_CHARS) fail('INVALID_INPUT');
  return text;
}

export function requestKeyOf(requestId) {
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) fail('INVALID_INPUT');
  return digest('request', requestId);
}

export function scopeHashOf(scope) {
  return sanitizeInput(() => {
    if (scope === null || typeof scope !== 'object' || types.isProxy(scope) || !isPlainObject(scope)) fail('INVALID_INPUT');
    return digest('scope', canonicalScopeJson(scope));
  });
}

function ownerHashOf(token) {
  if (typeof token !== 'string' || !OWNER_TOKEN.test(token)) fail('INVALID_INPUT');
  return digest('owner', token);
}

// Birth identity is exactly {pid, creationTime, bootId}. The same triple is
// required for recording and for assessment, so input shape can never change
// the comparison. pid alone, or any partial form, is INSUFFICIENT_IDENTITY.
function birthHashOf(identity) {
  return sanitizeInput(() => {
    const {pid, creationTime, bootId} = readRecord(identity, ['pid', 'creationTime', 'bootId']);
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff) fail('INVALID_INPUT');
    if (creationTime === undefined || bootId === undefined) fail('INSUFFICIENT_IDENTITY');
    if (typeof creationTime !== 'string' || !IDENTITY_TEXT.test(creationTime)) fail('INVALID_INPUT');
    if (typeof bootId !== 'string' || !IDENTITY_TEXT.test(bootId)) fail('INVALID_INPUT');
    return digest('birth', JSON.stringify([pid, creationTime, bootId]));
  });
}

const ROW_FIELDS = Object.freeze(['request_key', 'scope_hash', 'state', 'generation', 'owner_hash', 'nonce', 'worker_hash', 'result_hash']);

// Ledger hashing is independent of scope limits. Fields are fixed-order and
// already shape-validated by validRow or produced by this module.
function rowDigest(row) {
  return digest('row', JSON.stringify(ROW_FIELDS.map(field => row[field])));
}

function aggregateDigest(rows) {
  const list = [...rows].map(row => `${row.request_key}:${row.row_digest}`).sort();
  return digest('aggregate', `${list.length}\n${list.join('\n')}`);
}

const safeEqualHex = (left, right) => isHex(left) && isHex(right) &&
  timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

function validRow(row) {
  if (!isHex(row.request_key) || !isHex(row.scope_hash) || !isHex(row.owner_hash) || !isHex(row.row_digest)) return false;
  if (!STATES.includes(row.state)) return false;
  if (!Number.isSafeInteger(row.generation) || row.generation < 1 || row.generation > MAX_GENERATION) return false;
  const afterClaim = row.state !== 'claimed';
  const afterIntent = row.state === 'worker-recorded' || row.state === 'completed';
  if (afterClaim ? !(typeof row.nonce === 'string' && UUID.test(row.nonce)) : row.nonce !== null) return false;
  if (afterIntent ? !isHex(row.worker_hash) : row.worker_hash !== null) return false;
  if (row.state === 'completed' ? !isHex(row.result_hash) : row.result_hash !== null) return false;
  return rowDigest(row) === row.row_digest;
}

function readSchema(db) {
  return db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();
}

function validateSchema(entries) {
  const normalize = text => String(text).replace(/\s+/g, ' ').trim();
  const tables = new Set();
  const indexes = new Set();
  for (const entry of entries) {
    if (entry.type === 'table' && Object.hasOwn(TABLES, entry.name) && !tables.has(entry.name) &&
        normalize(entry.sql) === normalize(TABLES[entry.name])) tables.add(entry.name);
    else if (entry.type === 'index' && AUTO_INDEXES.includes(entry.name) && !indexes.has(entry.name) &&
        entry.sql === null) indexes.add(entry.name);
    else fail('STORE_CORRUPT');
  }
  if (tables.size !== 2 || indexes.size !== AUTO_INDEXES.length) fail('STORE_CORRUPT');
}

// Full integrity_check (not quick_check) so index entries are verified
// against table rows. Output is limited to the first error row.
function checkIntegrity(db) {
  const result = db.prepare('PRAGMA integrity_check(1)').all();
  if (result.length !== 1 || Object.values(result[0])[0] !== 'ok') fail('STORE_CORRUPT');
}

const pragmaValue = (db, name) => {
  const rows = db.prepare(`PRAGMA ${name}`).all();
  return rows.length === 1 ? Object.values(rows[0])[0] : undefined;
};

// Journal mode and page bound are read from the live connection, not assumed
// from the pragmas set at open. Must run after the transaction has read the
// database, so a mode change made by another connection is visible.
function checkStorage(db, maxPages) {
  if (String(pragmaValue(db, 'journal_mode')).toLowerCase() !== 'delete') fail('STORE_UNSUPPORTED');
  const limit = Number(pragmaValue(db, 'max_page_count'));
  const pages = Number(pragmaValue(db, 'page_count'));
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(pages)) fail('STORE_CORRUPT');
  if (limit !== maxPages || pages > maxPages) fail('STORE_FULL');
}

// Validates the whole store on every transaction, not just the queried row.
// A corrupted unrelated row, a duplicated nonce or worker identity, a row
// count or aggregate mismatch, an index that disagrees with its table, or an
// unexpected schema object fails closed for every request. This is what stops
// a request key that was altered without resealing from looking like an
// absent request.
function validateStore(db, {maxRows, maxPages}, {integrity}) {
  if (integrity) checkIntegrity(db);
  checkStorage(db, maxPages);
  validateSchema(readSchema(db));
  const meta = Object.create(null);
  for (const entry of db.prepare('SELECT key, value FROM meta LIMIT 8').all()) {
    if (typeof entry.key !== 'string' || typeof entry.value !== 'string' || entry.key in meta) fail('STORE_CORRUPT');
    meta[entry.key] = entry.value;
  }
  if (Object.keys(meta).sort().join(',') !== 'aggregate,row_count,schema') fail('STORE_CORRUPT');
  if (meta.schema !== SCHEMA_VERSION || !/^(0|[1-9][0-9]{0,6})$/.test(meta.row_count) || !isHex(meta.aggregate)) fail('STORE_CORRUPT');
  const list = db.prepare(`SELECT ${ROW_FIELDS.join(', ')}, row_digest FROM claims LIMIT ?`).all(maxRows + 1);
  if (list.length > maxRows) fail('STORE_CORRUPT');
  const rows = new Map();
  const nonces = new Set();
  const workers = new Set();
  for (const entry of list) {
    const row = {};
    for (const field of [...ROW_FIELDS, 'row_digest']) row[field] = entry[field];
    if (!validRow(row) || rows.has(row.request_key)) fail('STORE_CORRUPT');
    if (row.nonce !== null) { if (nonces.has(row.nonce)) fail('STORE_CORRUPT'); nonces.add(row.nonce); }
    if (row.worker_hash !== null) { if (workers.has(row.worker_hash)) fail('STORE_CORRUPT'); workers.add(row.worker_hash); }
    rows.set(row.request_key, row);
  }
  if (rows.size !== Number(meta.row_count) || aggregateDigest(rows.values()) !== meta.aggregate) fail('STORE_CORRUPT');
  return {rows};
}

function view(row) {
  return Object.freeze({
    requestKey: row.request_key,
    scopeHash: row.scope_hash,
    state: row.state,
    generation: row.generation,
    nonce: row.nonce,
    workerIdentityRecorded: row.worker_hash !== null,
    resultHash: row.result_hash,
  });
}

const RECOVERY = Object.freeze({
  claimed: {hold: 'pre-dispatch', reason: 'The claim holder may be live or crashed. Only an explicit host continue decision for the observed generation can issue a new owner generation; nothing was recorded as dispatched.'},
  'dispatch-intent': {hold: 'dispatch-uncertain', reason: 'A dispatch intent was committed. Whether dispatch happened cannot be established here.'},
  'worker-recorded': {hold: 'worker-liveness-unknown', reason: 'A worker birth identity hash is recorded. Liveness and tree termination need host OS proof outside this helper.'},
});

function recoveryOf(row) {
  if (row.state === 'completed') {
    return Object.freeze({resolution: 'complete', redispatchAllowed: false, automaticAction: 'none',
      reason: 'Host-attested completion is recorded. Replay returns this claim.'});
  }
  return Object.freeze({resolution: 'unresolved', redispatchAllowed: false, automaticAction: 'none', ...RECOVERY[row.state]});
}

// Reads a host attestation with exactly the expected constant fields plus
// the listed variable fields, all through data descriptors.
function readHostObject(value, constants, variables) {
  return sanitizeInput(() => {
    const record = readRecord(value, [...Object.keys(constants), ...variables], 'HOST_AUTHORITY_REQUIRED');
    for (const [key, expected] of Object.entries(constants)) if (record[key] !== expected) fail('HOST_AUTHORITY_REQUIRED');
    for (const key of variables) if (!Object.hasOwn(record, key)) fail('HOST_AUTHORITY_REQUIRED');
    return record;
  });
}

function validateOptions(path, options) {
  const record = sanitizeInput(() => readRecord(options, ['initialize', 'maxRows', 'busyTimeoutMs', 'maxPages', 'testFaultHook'], 'INVALID_OPTIONS'));
  const {initialize = false, maxRows = 1024, busyTimeoutMs = 2000, maxPages = 2048, testFaultHook} = record;
  if (typeof path !== 'string' || !path || path.includes('\0') || path === ':memory:' || path.startsWith('file:')) fail('INVALID_OPTIONS');
  if (typeof initialize !== 'boolean') fail('INVALID_OPTIONS');
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 100000) fail('INVALID_OPTIONS');
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60000) fail('INVALID_OPTIONS');
  if (!Number.isSafeInteger(maxPages) || maxPages < 16 || maxPages > 1000000) fail('INVALID_OPTIONS');
  if (testFaultHook !== undefined && typeof testFaultHook !== 'function') fail('INVALID_OPTIONS');
  return {initialize, maxRows, busyTimeoutMs, maxPages, testFaultHook};
}

class DurableRequestClaims {
  #db;
  #maxRows;
  #maxPages;
  #fault;
  #closed = false;

  constructor(path, options) {
    const {initialize, maxRows, busyTimeoutMs, maxPages, testFaultHook} = validateOptions(path, options);
    this.#maxRows = maxRows;
    this.#maxPages = maxPages;
    this.#fault = testFaultHook;
    // Opening never creates a store unless initialization was requested, so a
    // missing file cannot silently become an empty registry.
    if (!initialize && !existsSync(path)) fail('STORE_UNAVAILABLE');
    let db;
    try { db = new DatabaseSync(path, {timeout: busyTimeoutMs}); }
    catch (error) {
      const mapped = mapStoreError(error);
      throw mapped.code === 'INTERNAL_ERROR' ? new ClaimRegistryError('STORE_UNAVAILABLE') : mapped;
    }
    try {
      db.exec(`PRAGMA trusted_schema=OFF; PRAGMA cell_size_check=ON; PRAGMA synchronous=FULL; PRAGMA max_page_count=${maxPages}`);
      db.exec('BEGIN IMMEDIATE');
      try {
        checkIntegrity(db);
        checkStorage(db, maxPages);
        if (readSchema(db).length === 0) {
          if (!initialize) fail('STORE_UNINITIALIZED');
          db.exec(TABLES.claims);
          db.exec(TABLES.meta);
          const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
          insert.run('schema', SCHEMA_VERSION);
          insert.run('row_count', '0');
          insert.run('aggregate', aggregateDigest([]));
        }
        validateStore(db, {maxRows, maxPages}, {integrity: false});
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    } catch (error) {
      try { db.close(); } catch {}
      throw mapStoreError(error);
    }
    this.#db = db;
  }

  // Ordering: integrity, journal mode, page bound and whole-store validation, then the body, then a
  // second whole-store validation of the written state, then COMMIT. A write
  // result is returned only after COMMIT succeeds.
  #transaction(write, label, body) {
    if (this.#closed) fail('REGISTRY_CLOSED');
    const db = this.#db;
    let open = false;
    try {
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      open = true;
      const bounds = {maxRows: this.#maxRows, maxPages: this.#maxPages};
      const result = body(validateStore(db, bounds, {integrity: true}));
      if (write) {
        validateStore(db, bounds, {integrity: false});
        this.#fault?.(`${label}:before-commit`);
      }
      db.exec('COMMIT');
      open = false;
      if (write) this.#fault?.(`${label}:after-commit`);
      return result;
    } catch (error) {
      if (open) { try { db.exec('ROLLBACK'); } catch {} }
      throw mapStoreError(error);
    }
  }

  #writeMeta(rows) {
    const update = this.#db.prepare('UPDATE meta SET value = ? WHERE key = ?');
    if (Number(update.run(String(rows.size), 'row_count').changes) !== 1) fail('STORE_CONFLICT');
    if (Number(update.run(aggregateDigest(rows.values()), 'aggregate').changes) !== 1) fail('STORE_CONFLICT');
  }

  #insert(rows, row) {
    row.row_digest = rowDigest(row);
    this.#db.prepare(`INSERT INTO claims (${ROW_FIELDS.join(', ')}, row_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...ROW_FIELDS.map(field => row[field]), row.row_digest);
    rows.set(row.request_key, row);
    this.#writeMeta(rows);
  }

  #replace(rows, previous, next) {
    next.row_digest = rowDigest(next);
    const changes = this.#db.prepare('UPDATE claims SET scope_hash = ?, state = ?, generation = ?, owner_hash = ?, nonce = ?, worker_hash = ?, result_hash = ?, row_digest = ? WHERE request_key = ? AND row_digest = ?')
      .run(next.scope_hash, next.state, next.generation, next.owner_hash, next.nonce, next.worker_hash, next.result_hash,
        next.row_digest, previous.request_key, previous.row_digest).changes;
    if (Number(changes) !== 1) fail('STORE_CONFLICT');
    rows.set(next.request_key, next);
    this.#writeMeta(rows);
  }

  #bound(rows, key, scopeHash) {
    const row = rows.get(key);
    if (!row) fail('NOT_FOUND');
    if (row.scope_hash !== scopeHash) fail('SCOPE_MISMATCH');
    return row;
  }

  #owned(rows, key, scopeHash, ownerHash, state) {
    const row = this.#bound(rows, key, scopeHash);
    if (row.state !== state) fail('INVALID_TRANSITION');
    if (!safeEqualHex(row.owner_hash, ownerHash)) fail('OWNER_MISMATCH');
    return row;
  }

  // Atomically reserves (requestId, scope). Never authorizes dispatch: the
  // creator must still commit a dispatch intent. A replay with the same scope
  // returns the existing claim; a different scope fails closed.
  reserve(args) {
    const {requestId, scope} = readArgs(args, ['requestId', 'scope']);
    const key = requestKeyOf(requestId);
    const scopeHash = scopeHashOf(scope);
    return this.#transaction(true, 'reserve', ({rows}) => {
      const existing = rows.get(key);
      if (existing) {
        if (existing.scope_hash !== scopeHash) fail('SCOPE_MISMATCH');
        return Object.freeze({outcome: 'existing', dispatchAuthorized: false, claim: view(existing), recovery: recoveryOf(existing)});
      }
      if (rows.size >= this.#maxRows) fail('STORE_FULL');
      const ownerToken = randomBytes(32).toString('base64url');
      const row = {request_key: key, scope_hash: scopeHash, state: 'claimed', generation: 1,
        owner_hash: digest('owner', ownerToken), nonce: null, worker_hash: null, result_hash: null};
      this.#insert(rows, row);
      return Object.freeze({outcome: 'created', dispatchAuthorized: false, ownerToken, claim: view(row)});
    });
  }

  // The single point where the registry stops blocking dispatch. The intent
  // is durable before this returns, so the caller may dispatch at most once
  // with the returned nonce. Host authority to dispatch is still required.
  recordDispatchIntent(args) {
    const {requestId, scope, ownerToken} = readArgs(args, ['requestId', 'scope', 'ownerToken']);
    const key = requestKeyOf(requestId);
    const scopeHash = scopeHashOf(scope);
    const ownerHash = ownerHashOf(ownerToken);
    return this.#transaction(true, 'dispatch', ({rows}) => {
      const row = this.#owned(rows, key, scopeHash, ownerHash, 'claimed');
      const nonce = randomUUID();
      const next = {...row, state: 'dispatch-intent', nonce};
      this.#replace(rows, row, next);
      return Object.freeze({dispatchAuthorized: true, nonce, claim: view(next)});
    });
  }

  recordWorkerIdentity(args) {
    const {requestId, scope, ownerToken, nonce, birthIdentity} = readArgs(args, ['requestId', 'scope', 'ownerToken', 'nonce', 'birthIdentity']);
    const key = requestKeyOf(requestId);
    const scopeHash = scopeHashOf(scope);
    const ownerHash = ownerHashOf(ownerToken);
    if (typeof nonce !== 'string' || !UUID.test(nonce)) fail('INVALID_INPUT');
    const workerHash = birthHashOf(birthIdentity);
    return this.#transaction(true, 'worker', ({rows}) => {
      const row = this.#owned(rows, key, scopeHash, ownerHash, 'dispatch-intent');
      if (row.nonce !== nonce) fail('NONCE_MISMATCH');
      for (const other of rows.values()) if (other.worker_hash === workerHash) fail('IDENTITY_CONFLICT');
      const next = {...row, state: 'worker-recorded', worker_hash: workerHash};
      this.#replace(rows, row, next);
      return Object.freeze({claim: view(next)});
    });
  }

  // hostEvidence must be exactly {authority: 'host', cleanup: 'verified',
  // inference: 'settled', resultHash}. It is recorded, not verified.
  recordHostCompletion(args) {
    const {requestId, scope, ownerToken, hostEvidence} = readArgs(args, ['requestId', 'scope', 'ownerToken', 'hostEvidence']);
    const key = requestKeyOf(requestId);
    const scopeHash = scopeHashOf(scope);
    const ownerHash = ownerHashOf(ownerToken);
    const evidence = readHostObject(hostEvidence, {authority: 'host', cleanup: 'verified', inference: 'settled'}, ['resultHash']);
    if (!isHex(evidence.resultHash)) fail('HOST_AUTHORITY_REQUIRED');
    return this.#transaction(true, 'complete', ({rows}) => {
      const row = this.#owned(rows, key, scopeHash, ownerHash, 'worker-recorded');
      const next = {...row, state: 'completed', result_hash: evidence.resultHash};
      this.#replace(rows, row, next);
      return Object.freeze({claim: view(next), recovery: recoveryOf(next)});
    });
  }

  // Explicit host continue for a claim that never committed a dispatch
  // intent. hostDecision must be exactly {authority: 'host', decision:
  // 'continue-pre-dispatch', observedGeneration}. The generation is compared
  // inside the write transaction, so two decisions based on the same observed
  // generation cannot both rotate ownership. Any previous token is fenced out.
  hostContinuePreDispatch(args) {
    const {requestId, scope, hostDecision} = readArgs(args, ['requestId', 'scope', 'hostDecision']);
    const key = requestKeyOf(requestId);
    const scopeHash = scopeHashOf(scope);
    const decision = readHostObject(hostDecision, {authority: 'host', decision: 'continue-pre-dispatch'}, ['observedGeneration']);
    const observed = decision.observedGeneration;
    if (!Number.isSafeInteger(observed) || observed < 1 || observed > MAX_GENERATION) fail('HOST_AUTHORITY_REQUIRED');
    return this.#transaction(true, 'continue', ({rows}) => {
      const row = this.#bound(rows, key, scopeHash);
      if (row.state !== 'claimed') fail('RECOVERY_REQUIRES_EXTERNAL_PROOF');
      if (row.generation !== observed) fail('STALE_DECISION');
      if (row.generation >= MAX_GENERATION) fail('STORE_FULL');
      const ownerToken = randomBytes(32).toString('base64url');
      const next = {...row, generation: row.generation + 1, owner_hash: digest('owner', ownerToken)};
      this.#replace(rows, row, next);
      return Object.freeze({dispatchAuthorized: false, ownerToken, claim: view(next)});
    });
  }

  inspect(args) {
    const {requestId, scope} = readArgs(args, ['requestId', 'scope']);
    const key = requestKeyOf(requestId);
    const scopeHash = scopeHashOf(scope);
    return this.#transaction(false, 'inspect', ({rows}) => {
      const row = rows.get(key);
      if (!row) return Object.freeze({found: false});
      if (row.scope_hash !== scopeHash) fail('SCOPE_MISMATCH');
      return Object.freeze({found: true, claim: view(row), recovery: recoveryOf(row)});
    });
  }

  // Compares an observed birth identity triple with the recorded hash. Never
  // reports a worker as dead, never treats a matching hash as OS proof, never
  // redispatches.
  assessWorkerIdentity(args) {
    const {requestId, scope, observedBirthIdentity} = readArgs(args, ['requestId', 'scope', 'observedBirthIdentity']);
    const key = requestKeyOf(requestId);
    const scopeHash = scopeHashOf(scope);
    let observed = null;
    let verdict = null;
    try { observed = birthHashOf(observedBirthIdentity); }
    catch (error) { verdict = error.code === 'INSUFFICIENT_IDENTITY' ? 'insufficient-identity' : 'invalid-identity'; }
    return this.#transaction(false, 'assess', ({rows}) => {
      const row = this.#bound(rows, key, scopeHash);
      if (!verdict) {
        if (row.worker_hash === null) verdict = 'no-recorded-identity';
        else verdict = safeEqualHex(row.worker_hash, observed) ? 'matches-recorded' : 'mismatch';
      }
      return Object.freeze({verdict, osProcessProof: 'not-established', workerDeathInferred: false,
        redispatchAllowed: false, claim: view(row)});
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#db.close(); } catch {}
  }
}

export function openClaimRegistry(path, options = {}) {
  return new DurableRequestClaims(path, options);
}

// Exposed only so tests can build consistent forgeries that demonstrate the
// unkeyed-checksum limit and seed capacity fixtures. Not an integrity API.
export const _testing = Object.freeze({rowDigest, aggregateDigest, birthHashOf, ownerHashOf});
