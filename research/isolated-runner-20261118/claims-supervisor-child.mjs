// Fixed child entry for the disconnected claims supervisor prototype.
//
// Reads one bounded request from stdin, validates it, and answers with
// exactly one JSON reply line: a refusal with REGISTRY_BOUNDARY_UNAVAILABLE.
// It does not import the registry or node:sqlite and never touches the store
// path, so SQLite never opens the store. It writes nothing to stderr and
// never logs request data. Not an OS sandbox, not Windows qualified, not
// production safe.
//
// preflightStore below is a SKETCH of a bounded pre-open file and header
// check. It is not called by this child and authorizes nothing. It is a
// snapshot only and does not close pathname, symlink, hot-journal or
// concurrent-growth races; see MISSING_BOUNDARIES in claims-supervisor.mjs.
import {constants as fsConstants, closeSync, fstatSync, lstatSync, openSync, readSync} from 'node:fs';
import {basename, dirname, isAbsolute, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const HARD_MAX_REQUEST_BYTES = 262144;
export const BOUNDARY_CODE = 'REGISTRY_BOUNDARY_UNAVAILABLE';
export const PAGE_SIZE = 4096;
export const MAX_PAGES_CAP = 262143;
// A rollback journal record is the page plus a 4-byte page number and a
// 4-byte checksum. The allowance covers journal headers and sector padding.
export const JOURNAL_RECORD_BYTES = PAGE_SIZE + 8;
export const JOURNAL_HEADER_ALLOWANCE = 65536;
export const EXIT_BAD_REQUEST = 3;
export const EXIT_INTERNAL = 70;

const OPERATION_NAMES = new Set([
  'reserve', 'recordDispatchIntent', 'recordWorkerIdentity', 'recordHostCompletion',
  'hostContinuePreDispatch', 'inspect', 'assessWorkerIdentity',
]);
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const CORRELATION = /^[A-Za-z0-9_-]{32}$/;
const MAX_ANCESTORS = 128;

// ---------- Preflight sketch (not used for authorization) ----------

const refuse = code => Object.freeze({ok: false, code});

function pathShapeOk(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024 || path.includes('\0') || !isAbsolute(path)) return false;
  if (process.platform === 'win32') {
    if (/^[\\/]{2}/.test(path)) return false; // UNC, \\?\ and \\.\ device paths
    if (!/^[A-Za-z]:[\\/]/.test(path)) return false; // drive-absolute only
    if (path.indexOf(':', 2) !== -1) return false; // alternate data streams
    if (/~[0-9]/.test(path)) return false; // possible 8.3 short-name alias
    const base = basename(path);
    if (/[. ]$/.test(base)) return false; // trailing dot or space aliasing
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(base)) return false;
  }
  return true;
}

function ancestorsAreDirectories(path) {
  let current = dirname(path);
  for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
    const stats = lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
  return false;
}

function lstatOrNull(path) {
  try { return lstatSync(path, {bigint: true}); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function checkSiblings(path, maxPages) {
  if (lstatOrNull(`${path}-wal`) !== null || lstatOrNull(`${path}-shm`) !== null) return 'PREFLIGHT_UNSUPPORTED';
  const journal = lstatOrNull(`${path}-journal`);
  if (journal === null) return null;
  if (journal.isSymbolicLink() || !journal.isFile()) return 'PREFLIGHT_PATH';
  if (journal.size > BigInt(JOURNAL_HEADER_ALLOWANCE + maxPages * JOURNAL_RECORD_BYTES)) return 'PREFLIGHT_OVERSIZE';
  return null;
}

function readHeader(path, expected) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags);
  try {
    const stats = fstatSync(fd, {bigint: true});
    if (!stats.isFile() || stats.dev !== expected.dev || stats.ino !== expected.ino) return {code: 'PREFLIGHT_PATH'};
    const header = Buffer.alloc(100);
    const read = readSync(fd, header, 0, 100, 0);
    if (read !== 100) return {code: 'PREFLIGHT_UNSUPPORTED'};
    return {header, size: stats.size};
  } finally {
    closeSync(fd);
  }
}

// Returns {ok: true, pages, sizeBytes, identity, guarantee: 'snapshot-only',
// authorizes: false} or {ok: false, code}. Never throws, never includes the
// path.
export function preflightStore(path, maxPages) {
  try {
    if (!Number.isSafeInteger(maxPages) || maxPages < 16 || maxPages > MAX_PAGES_CAP) return refuse('PREFLIGHT_UNSUPPORTED');
    if (!pathShapeOk(path)) return refuse('PREFLIGHT_PATH');
    const linkStats = lstatOrNull(path);
    if (linkStats === null) return refuse('PREFLIGHT_UNAVAILABLE');
    if (linkStats.isSymbolicLink() || !linkStats.isFile()) return refuse('PREFLIGHT_PATH');
    if (linkStats.ino === 0n) return refuse('PREFLIGHT_PATH');
    if (!ancestorsAreDirectories(path)) return refuse('PREFLIGHT_PATH');
    const limitBytes = BigInt(maxPages) * BigInt(PAGE_SIZE);
    if (linkStats.size > limitBytes) return refuse('PREFLIGHT_OVERSIZE');
    if (linkStats.size < BigInt(PAGE_SIZE) || linkStats.size % BigInt(PAGE_SIZE) !== 0n) return refuse('PREFLIGHT_UNSUPPORTED');
    const identity = Object.freeze({dev: linkStats.dev, ino: linkStats.ino});
    const opened = readHeader(path, identity);
    if (opened.code) return refuse(opened.code);
    const {header, size} = opened;
    if (size > limitBytes) return refuse('PREFLIGHT_OVERSIZE');
    if (size < BigInt(PAGE_SIZE) || size % BigInt(PAGE_SIZE) !== 0n) return refuse('PREFLIGHT_UNSUPPORTED');
    if (!header.subarray(0, 16).equals(SQLITE_MAGIC)) return refuse('PREFLIGHT_UNSUPPORTED');
    if (header.readUInt16BE(16) !== PAGE_SIZE) return refuse('PREFLIGHT_UNSUPPORTED');
    if (header[18] !== 1 || header[19] !== 1) return refuse('PREFLIGHT_UNSUPPORTED'); // 2 means WAL
    if (header[20] !== 0 || header[21] !== 64 || header[22] !== 32 || header[23] !== 32) return refuse('PREFLIGHT_UNSUPPORTED');
    const changeCounter = header.readUInt32BE(24);
    const headerPages = header.readUInt32BE(28);
    const freelistPages = header.readUInt32BE(36);
    const schemaFormat = header.readUInt32BE(44);
    const autoVacuumRoot = header.readUInt32BE(52);
    const textEncoding = header.readUInt32BE(56);
    const incrementalVacuum = header.readUInt32BE(64);
    const validFor = header.readUInt32BE(92);
    if (schemaFormat !== 4 || textEncoding !== 1 || autoVacuumRoot !== 0 || incrementalVacuum !== 0) return refuse('PREFLIGHT_UNSUPPORTED');
    const sizePages = Number(size / BigInt(PAGE_SIZE));
    const effectivePages = validFor === changeCounter && headerPages > 0 ? headerPages : sizePages;
    if (Math.max(effectivePages, sizePages) > maxPages) return refuse('PREFLIGHT_OVERSIZE');
    if (freelistPages > effectivePages) return refuse('PREFLIGHT_UNSUPPORTED');
    const sibling = checkSiblings(path, maxPages);
    if (sibling) return refuse(sibling);
    return Object.freeze({ok: true, code: null, pages: Math.max(effectivePages, sizePages), sizeBytes: Number(size),
      identity, guarantee: 'snapshot-only', authorizes: false});
  } catch {
    return refuse('PREFLIGHT_UNAVAILABLE');
  }
}

// Detects a simple replacement of the path since a snapshot. It does not
// detect a swap that was restored before this check.
export function sameStoreIdentity(path, identity) {
  try {
    const stats = lstatSync(path, {bigint: true});
    return stats.isFile() && !stats.isSymbolicLink() && stats.dev === identity.dev && stats.ino === identity.ino;
  } catch {
    return false;
  }
}

// ---------- Child protocol ----------

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value, keys) => isPlain(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const intIn = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

// Returns the validated request or null. Never echoes request content.
export function parseRequest(buffer) {
  try {
    const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(buffer);
    const newline = text.indexOf('\n');
    if (newline === -1 || newline !== text.length - 1) return null;
    const request = JSON.parse(text.slice(0, newline));
    if (!exactKeys(request, ['v', 'correlation', 'operation', 'args', 'store'])) return null;
    if (request.v !== 1 || typeof request.correlation !== 'string' || !CORRELATION.test(request.correlation)) return null;
    if (typeof request.operation !== 'string' || !OPERATION_NAMES.has(request.operation)) return null;
    if (!isPlain(request.args)) return null;
    const {store} = request;
    if (!exactKeys(store, ['path', 'maxPages', 'maxRows', 'busyTimeoutMs'])) return null;
    if (typeof store.path !== 'string' || !isAbsolute(store.path)) return null;
    if (!intIn(store.maxPages, 16, MAX_PAGES_CAP) || !intIn(store.maxRows, 1, 100000) || !intIn(store.busyTimeoutMs, 0, 60000)) return null;
    return request;
  } catch {
    return null;
  }
}

// The only reply this child gives. Registry access is refused before the
// registry module or SQLite is loaded and before the store path is touched.
export function buildReply(request) {
  return {v: 1, correlation: request.correlation, operation: request.operation, status: 'rejected', code: BOUNDARY_CODE};
}

export function readRequestFromStdin(limit = HARD_MAX_REQUEST_BYTES) {
  return new Promise(resolvePromise => {
    const chunks = [];
    let size = 0;
    let done = false;
    const stop = value => {
      if (done) return;
      done = true;
      resolvePromise(value);
    };
    process.stdin.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        try { process.stdin.destroy(); } catch {}
        stop(null);
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => stop(parseRequest(Buffer.concat(chunks))));
    process.stdin.on('error', () => stop(null));
  });
}

export const quietExit = code => process.exit(code);

export function installQuietHandlers() {
  process.on('uncaughtException', () => quietExit(EXIT_INTERNAL));
  process.on('unhandledRejection', () => quietExit(EXIT_INTERNAL));
}

export function replyLine(reply) {
  return `${JSON.stringify(reply)}\n`;
}

export async function childMain() {
  installQuietHandlers();
  const request = await readRequestFromStdin();
  if (request === null) return quietExit(EXIT_BAD_REQUEST);
  process.stdout.write(replyLine(buildReply(request)), error => quietExit(error ? EXIT_INTERNAL : 0));
}

function isEntryPoint() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  try { return typeof process.argv[1] === 'string' && pathToFileURL(resolve(process.argv[1])).href === import.meta.url; }
  catch { return false; }
}

if (isEntryPoint()) childMain();
