import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {
  copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
  APPROVED_FILES,
  canonicalAttestationHmac,
  canonicalJson,
  createVerifiedPatchController,
  FIXED_CASES,
  FIXED_CASES_DIGEST,
} from './host-evidence-authenticator.mjs';
import {
  beginDurableAcceptance,
  closeReplayStore,
  getReplayLedgerId,
  inspectReplayRecord,
  openReplayStore,
  REPLAY_ERROR_MESSAGES,
  REPLAY_STORE_FORMAT,
  REPLAY_STORE_SCOPE,
  ReplayGuardError,
} from './durable-verifier-replay.mjs';

// Synthetic values only. The key, nonce and attestation below are the same
// synthetic fixture used by verified-patch.test.mjs; none is a real secret.
const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD_URL = pathToFileURL(join(HERE, 'durable-verifier-replay.mjs')).href;
const AUTH_URL = pathToFileURL(join(HERE, 'host-evidence-authenticator.mjs')).href;
const SYNTHETIC_KEY = Buffer.from('controller-test-hmac-key-32bytes');
const FIXTURE_NONCE = 'nonce-20261118-0001';
const PYTHON_ATTESTATION_B64 = 'eyJzY29wZSI6ImZpeGVkLXN5bnRoZXRpYy1vbmx5IiwidGFyZ2V0IjoibGltaXRzLnB5K21lYXN1cmVtZW50LnB5IiwidmVyaWZpZXIiOiJwcm90ZWN0ZWQtZml4dHVyZS12ZXJpZmllci1hc3QtdjIiLCJlbnRyeVBvaW50RGlzY29ubmVjdGVkIjp0cnVlLCJ0cnVzdGVkIjp0cnVlLCJwYXNzZWQiOnRydWUsImNsYWltSWQiOiJjbGFpbS0yMDI2MTExOC0wMDEiLCJzY29wZUhhc2giOiIyMjdlMjdkYmY2NjA1ZTE4MDdmNmE3YzU3OWJhNzEyZGNhNGU2MTk1ODAzNDRmYmIxNzhlZWY4N2I4YjA0OTEwIiwiY2xhaW1TY29wZSI6eyJmaWxlcyI6WyJsaW1pdHMucHkiLCJtZWFzdXJlbWVudC5weSJdLCJiYXNlUmV2aXNpb24iOiJhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhIiwiYmFzZUZpbGVEaWdlc3RzIjp7ImxpbWl0cy5weSI6ImFiYTZlNDE3NGZhOGQwNWIwMzU5ZmQyYzczNmM2ODZjNmExZmJiNTc4NGY3YTYyODA4NDk1YWNkZWVhN2FkZTIiLCJtZWFzdXJlbWVudC5weSI6ImI0YjVhNzg1NjA4MzNmMjM4YjU5Mzg1N2UyMGI4ZWE4YjlkZmQyYzllNmIwYzMxZTBlNTdlODVkMDYyZDJkMjMifSwiY2FzZXNEaWdlc3QiOiJiZjEyOThlYzViNTIwOWExOTIwNDJkYTdjYzg1ODE0YWFjYzI0NTkwYzExYjM4MjYzNzAwYjQ1ZmRiOWM2MjRmIiwidG90YWxDYXNlcyI6MTJ9LCJiYXNlUmV2aXNpb24iOiJhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhIiwiYmFzZUZpbGVEaWdlc3RzIjp7ImxpbWl0cy5weSI6ImFiYTZlNDE3NGZhOGQwNWIwMzU5ZmQyYzczNmM2ODZjNmExZmJiNTc4NGY3YTYyODA4NDk1YWNkZWVhN2FkZTIiLCJtZWFzdXJlbWVudC5weSI6ImI0YjVhNzg1NjA4MzNmMjM4YjU5Mzg1N2UyMGI4ZWE4YjlkZmQyYzllNmIwYzMxZTBlNTdlODVkMDYyZDJkMjMifSwiYmFzZVRyZWVTaGEyNTYiOiIxNWJkZDRiMGMxM2Q4MjFjYThmZWU2M2JmODg3M2JhNjQyYTM0OWE3MmRlZGZiMWE4NzJiODM4ZjMzMGUxOTk0IiwiY2FzZXNEaWdlc3QiOiJiZjEyOThlYzViNTIwOWExOTIwNDJkYTdjYzg1ODE0YWFjYzI0NTkwYzExYjM4MjYzNzAwYjQ1ZmRiOWM2MjRmIiwidG90YWxDYXNlcyI6MTIsInBhc3NlZENhc2VzIjoxMiwiZmFpbHVyZXMiOltdLCJyZXN1bHRzIjpbeyJ2YWx1ZSI6MH0seyJ2YWx1ZSI6MH0seyJ2YWx1ZSI6NTZ9LHsidmFsdWUiOjEwMH0seyJ2YWx1ZSI6MTAwfSx7InZhbHVlIjowfSx7InZhbHVlIjo0Mn0seyJ2YWx1ZSI6MTAwfSx7InZhbHVlIjo3NX0seyJ2YWx1ZSI6MH0seyJ2YWx1ZSI6MH0seyJ2YWx1ZSI6MH1dLCJjYXNlUmVzdWx0cyI6W3siY2FzZSI6MSwiZnVuY3Rpb24iOiJjbGFtcCIsInBhc3NlZCI6dHJ1ZSwiZXhwZWN0ZWQiOjAsInN0ZXBzIjo3LCJhY3R1YWwiOjB9LHsiY2FzZSI6MiwiZnVuY3Rpb24iOiJjbGFtcCIsInBhc3NlZCI6dHJ1ZSwiZXhwZWN0ZWQiOjAsInN0ZXBzIjoxMSwiYWN0dWFsIjowfSx7ImNhc2UiOjMsImZ1bmN0aW9uIjoiY2xhbXAiLCJwYXNzZWQiOnRydWUsImV4cGVjdGVkIjo1Niwic3RlcHMiOjExLCJhY3R1YWwiOjU2fSx7ImNhc2UiOjQsImZ1bmN0aW9uIjoiY2xhbXAiLCJwYXNzZWQiOnRydWUsImV4cGVjdGVkIjoxMDAsInN0ZXBzIjoxMSwiYWN0dWFsIjoxMDB9LHsiY2FzZSI6NSwiZnVuY3Rpb24iOiJjbGFtcCIsInBhc3NlZCI6dHJ1ZSwiZXhwZWN0ZWQiOjEwMCwic3RlcHMiOjExLCJhY3R1YWwiOjEwMH0seyJjYXNlIjo2LCJmdW5jdGlvbiI6Im5vcm1hbGl6ZSIsInBhc3NlZCI6dHJ1ZSwiZXhwZWN0ZWQiOjAsInN0ZXBzIjoxMywiYWN0dWFsIjowfSx7ImNhc2UiOjcsImZ1bmN0aW9uIjoibm9ybWFsaXplIiwicGFzc2VkIjp0cnVlLCJleHBlY3RlZCI6NDIsInN0ZXBzIjoxNywiYWN0dWFsIjo0Mn0seyJjYXNlIjo4LCJmdW5jdGlvbiI6Im5vcm1hbGl6ZSIsInBhc3NlZCI6dHJ1ZSwiZXhwZWN0ZWQiOjEwMCwic3RlcHMiOjE3LCJhY3R1YWwiOjEwMH0seyJjYXNlIjo5LCJmdW5jdGlvbiI6Im5vcm1hbGl6ZSIsInBhc3NlZCI6dHJ1ZSwiZXhwZWN0ZWQiOjc1LCJzdGVwcyI6MTcsImFjdHVhbCI6NzV9LHsiY2FzZSI6MTAsImZ1bmN0aW9uIjoibm9ybWFsaXplIiwicGFzc2VkIjp0cnVlLCJleHBlY3RlZCI6MCwic3RlcHMiOjgsImFjdHVhbCI6MH0seyJjYXNlIjoxMSwiZnVuY3Rpb24iOiJub3JtYWxpemUiLCJwYXNzZWQiOnRydWUsImV4cGVjdGVkIjowLCJzdGVwcyI6OCwiYWN0dWFsIjowfSx7ImNhc2UiOjEyLCJmdW5jdGlvbiI6Im5vcm1hbGl6ZSIsInBhc3NlZCI6dHJ1ZSwiZXhwZWN0ZWQiOjAsInN0ZXBzIjo4LCJhY3R1YWwiOjB9XSwiZmlsZURpZ2VzdHMiOnsibGltaXRzLnB5IjoiMzhjMTIzMWMyZTY1MWIzYTY5YmNmNzMxM2NlZTI2NzM2MTlkY2I5NWMyNDZlNzM5OTcxZGY2ZjRhYjA1MGQ4NCIsIm1lYXN1cmVtZW50LnB5IjoiOTI5NjgwNTdlNDA1NGQ2ZjRkNDVlOWVjZmU4MmI0YzYyMWQ0OGIwZDE0ZDA4YjZhNWJlODEwMTQ3OGVhOTg4YSJ9LCJ0cmVlU2hhMjU2IjoiNGE5OWY2MzMxZjQwMzkwZGM4MjE5ZmYxMWI3MTRkZDYwYWE1MDJjOTBiM2U0Y2RlNjEwNjhlZWNmMWEyNDdlOSIsInVuY2hhbmdlZEZpbGVzIjpbXSwid29ya0JvdW5kcyI6eyJtYXhGaWxlQnl0ZXMiOjgxOTIsIm1heEFzdE5vZGVzIjoxOTIsIm1heEFzdERlcHRoIjoyNCwibWF4U3RlcHNQZXJDYXNlIjoyNTYsIm1heEludEFicyI6MTAwMDAwMDAwMDAwMDAwMDAwMCwibWF4U3RyTGVuIjo2NH0sIndvcmtPYnNlcnZlZCI6eyJhc3ROb2RlcyI6eyJsaW1pdHMucHkiOjIwLCJtZWFzdXJlbWVudC5weSI6MTl9LCJhc3REZXB0aCI6eyJsaW1pdHMucHkiOjUsIm1lYXN1cmVtZW50LnB5Ijo3fSwibWF4Q2FzZVN0ZXBzIjoxN30sInByb3ZlbmFuY2UiOnsiY2xhaW1Cb3VuZCI6dHJ1ZSwiaW52b2NhdGlvbk5vbmNlIjoibm9uY2UtMjAyNjExMTgtMDAwMSIsImhtYWNTaGEyNTYiOiJmOGQ0MWRkNGNjYzc2MDc4NjUxNDJkN2ZiOWE0YWJkNTIyN2I4NmVhYWFmYTcxNzkzODRmYTM0YjdkZDAyZmViIn19';

function fixtureEvidence() {
  return JSON.parse(Buffer.from(PYTHON_ATTESTATION_B64, 'base64').toString('utf8'));
}

const FIXTURE = fixtureEvidence();
const FIXTURE_CLAIM = Object.freeze({
  claimId: FIXTURE.claimId,
  scopeHash: FIXTURE.scopeHash,
  scope: FIXTURE.claimScope,
});
const FIXTURE_BINDINGS = Object.freeze({
  actualBaseRevision: FIXTURE.claimScope.baseRevision,
  actualBaseDigests: FIXTURE.claimScope.baseFileDigests,
});

function syntheticClaim(claimId = 'claim-synthetic-002') {
  const scope = {
    files: [...APPROVED_FILES],
    baseRevision: 'b'.repeat(40),
    baseFileDigests: {'limits.py': '1'.repeat(64), 'measurement.py': '2'.repeat(64)},
    casesDigest: FIXED_CASES_DIGEST,
    totalCases: FIXED_CASES.length,
  };
  return {claimId, scopeHash: createHash('sha256').update(canonicalJson(scope), 'utf8').digest('hex'), scope};
}

function hostController({nonce = FIXTURE_NONCE, claim = FIXTURE_CLAIM, key = SYNTHETIC_KEY} = {}) {
  return createVerifiedPatchController({attestationKey: key, expectedInvocationNonce: nonce, claimRecord: claim});
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dvr-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}));
  return {dir, dbPath: join(dir, 'replay.sqlite')};
}

// Models the host's trusted pin store: the ledger id read right after
// creation, keyed by path. Unknown paths get a well-formed id that matches
// no real ledger, so identity can never be satisfied by accident.
const PINS = new Map();
const UNPINNED = '0'.repeat(32);

function openPinned(options) {
  if (options?.create) {
    const store = openReplayStore(options);
    PINS.set(options.path, getReplayLedgerId(store));
    return store;
  }
  return openReplayStore({expectedLedgerId: PINS.get(options?.path) ?? UNPINNED, ...options});
}

function createStore(t, dbPath, extra = {}) {
  const store = openPinned({path: dbPath, create: true, ...extra});
  t.after(() => closeReplayStore(store));
  return store;
}

function openStore(t, dbPath, extra = {}) {
  const store = openPinned({path: dbPath, ...extra});
  t.after(() => closeReplayStore(store));
  return store;
}

function rejectsWith(fn, code) {
  let caught;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ReplayGuardError, `expected ReplayGuardError ${code}`);
  assert.equal(caught.code, code);
  return caught;
}

function rawDb(dbPath) {
  return new DatabaseSync(dbPath);
}

function rawExec(dbPath, sql, ...params) {
  const db = rawDb(dbPath);
  try {
    if (params.length === 0) db.exec(sql);
    else db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

// Mirrors the published, unkeyed checksum formulas so tests can model a
// writer that recomputes row checksums. Recomputing is possible by design.
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const testRowDigest = (seq, digest, claimId, scopeHash, state) =>
  sha(`${REPLAY_STORE_FORMAT}\0row\0${seq}\0${digest}\0${claimId}\0${scopeHash}\0${state}`);
const testGenesis = ledgerId => sha(`${REPLAY_STORE_FORMAT}\0genesis\0${REPLAY_STORE_SCOPE}\0${ledgerId}`);
const testLink = (head, seq, digest, claimId, scopeHash) =>
  sha(`${REPLAY_STORE_FORMAT}\0link\0${head}\0${seq}\0${digest}\0${claimId}\0${scopeHash}`);

const NONCE_A = 'nonce-integrity-a-0001';
const NONCE_B = 'nonce-integrity-b-0002';
const NONCE_C = 'nonce-integrity-c-0003';
const NONCE_D = 'nonce-integrity-d-0004';

// Builds a store with two settled synthetic records (A and B, rejected) and
// one pending record (C). D is never reserved.
function seedStore(path) {
  const store = openPinned({path, create: true});
  try {
    const claim = syntheticClaim();
    beginDurableAcceptance(store, hostController({nonce: NONCE_A, claim})).reject();
    beginDurableAcceptance(store, hostController({nonce: NONCE_B, claim})).reject();
    beginDurableAcceptance(store, hostController({nonce: NONCE_C, claim}));
  } finally {
    closeReplayStore(store);
  }
}

function readRows(path) {
  const db = rawDb(path);
  try {
    return db.prepare('SELECT seq, nonce_digest, claim_id, scope_hash, state, row_digest FROM replay_records ORDER BY seq')
      .all();
  } finally {
    db.close();
  }
}

// After tampering, neither open nor an already-open handle may admit any nonce.
function assertStoreRefusesEverything(path, openHandle) {
  const claim = syntheticClaim();
  for (const nonce of [NONCE_A, NONCE_B, NONCE_C, NONCE_D]) {
    rejectsWith(() => beginDurableAcceptance(openHandle, hostController({nonce, claim})), 'STORE_CORRUPT');
    rejectsWith(() => inspectReplayRecord(openHandle, hostController({nonce, claim})), 'STORE_CORRUPT');
  }
  rejectsWith(() => openPinned({path}), 'STORE_CORRUPT');
}

// Never accepts: either open, begin, or commit must fail with one of the codes.
function assertNeverAccepts(dbPath, codes) {
  let store;
  try {
    store = openPinned({path: dbPath});
  } catch (error) {
    assert.ok(error instanceof ReplayGuardError && codes.includes(error.code), 'open must fail closed');
    return;
  }
  try {
    const ticket = beginDurableAcceptance(store, hostController());
    ticket.authenticateAndCommit(fixtureEvidence(), FIXTURE_BINDINGS);
    assert.fail('corrupt store accepted an invocation');
  } catch (error) {
    assert.ok(error instanceof ReplayGuardError && codes.includes(error.code), 'use must fail closed');
  } finally {
    closeReplayStore(store);
  }
}

const CHILD_SOURCE = [
  "import {randomBytes} from 'node:crypto';",
  "import {existsSync} from 'node:fs';",
  "const raw = process.argv.find(a => a.startsWith('DVR_ARGS='));",
  'const arg = JSON.parse(raw.slice(9));',
  'const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
  "const out = obj => process.stdout.write(JSON.stringify(obj) + '\\n');",
  "if (arg.mode === 'hold-lock') {",
  "  const {DatabaseSync} = await import('node:sqlite');",
  '  const db = new DatabaseSync(arg.dbPath);',
  "  db.exec('BEGIN IMMEDIATE');",
  "  db.prepare(\"INSERT INTO replay_records (nonce_digest, seq, claim_id, scope_hash, state, row_digest) \" +",
  "    \"VALUES (?, 999, ?, ?, 'pending', ?)\").run('d'.repeat(64), 'claim-holder', 'e'.repeat(64), 'f'.repeat(64));",
  '  out({ready: true});',
  '  setTimeout(() => process.exit(3), 30000);',
  '} else {',
  '  const guard = await import(arg.guardUrl);',
  '  const auth = await import(arg.authUrl);',
  '  let store;',
  '  try {',
  '    store = guard.openReplayStore({path: arg.dbPath, busyTimeoutMs: arg.busyTimeoutMs, expectedLedgerId: arg.ledgerId});',
  '  } catch (e) {',
  "    out({ready: true}); out({code: typeof e?.code === 'string' ? e.code : 'UNEXPECTED'}); process.exit(0);",
  '  }',
  '  const controller = auth.createVerifiedPatchController({',
  '    attestationKey: randomBytes(32), expectedInvocationNonce: arg.nonce, claimRecord: arg.claimRecord,',
  '  });',
  '  out({ready: true});',
  '  if (arg.goPath) {',
  '    const end = Date.now() + 10000;',
  "    while (!existsSync(arg.goPath)) { if (Date.now() > end) { out({code: 'BARRIER_TIMEOUT'}); process.exit(4); } pause(2); }",
  '  }',
  '  try {',
  '    guard.beginDurableAcceptance(store, controller);',
  "    out({result: 'reserved'});",
  '  } catch (e) {',
  "    out({code: typeof e?.code === 'string' ? e.code : 'UNEXPECTED'});",
  '  }',
  '  // Exit without settling or closing: a crash while the record is pending.',
  '  process.exit(0);',
  '}',
].join('\n');

function childEnv() {
  // Allowlisted environment: nothing but what Windows needs to start Node.
  if (process.platform === 'win32' && typeof process.env.SystemRoot === 'string') {
    return {SystemRoot: process.env.SystemRoot};
  }
  return {};
}

function startChild(dir, arg) {
  const script = join(dir, 'child.mjs');
  if (!existsSync(script)) writeFileSync(script, CHILD_SOURCE, 'utf8');
  const child = spawn(process.execPath, ['--no-warnings', script, `DVR_ARGS=${JSON.stringify(arg)}`], {
    cwd: dir, env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  let buffer = '';
  let markReady;
  const ready = new Promise(resolve => {
    markReady = resolve;
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        message = {code: 'BAD_OUTPUT'};
      }
      lines.push(message);
      if (message.ready) markReady();
    }
  });
  let stderrBytes = 0;
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
  });
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 25000);
  const exited = new Promise(resolve => {
    child.on('exit', (code, signal) => {
      clearTimeout(killTimer);
      markReady();
      resolve({code, signal, lines, stderrBytes});
    });
  });
  return {child, ready, exited, lines};
}

test('commit is durable across restart and blocks every later acceptance of the nonce', t => {
  const {dbPath} = scratch(t);
  const store = createStore(t, dbPath);
  const controller = hostController();
  assert.equal(inspectReplayRecord(store, controller), 'absent');
  const ticket = beginDurableAcceptance(store, controller);
  assert.equal(ticket.state, 'reserved');
  assert.equal(inspectReplayRecord(store, controller), 'pending');
  const result = ticket.authenticateAndCommit(fixtureEvidence(), FIXTURE_BINDINGS);
  assert.equal(result.claimId, FIXTURE_CLAIM.claimId);
  assert.equal(ticket.state, 'committed');
  rejectsWith(() => ticket.authenticateAndCommit(fixtureEvidence(), FIXTURE_BINDINGS), 'TICKET_SETTLED');
  rejectsWith(() => ticket.reject(), 'TICKET_SETTLED');
  rejectsWith(() => beginDurableAcceptance(store, controller), 'REPLAY_REJECTED');
  rejectsWith(() => beginDurableAcceptance(store, hostController()), 'REPLAY_REJECTED');
  closeReplayStore(store);

  const reopened = openStore(t, dbPath);
  const fresh = hostController();
  assert.equal(inspectReplayRecord(reopened, fresh), 'committed');
  rejectsWith(() => beginDurableAcceptance(reopened, fresh), 'REPLAY_REJECTED');
  closeReplayStore(reopened);

  const bytes = readFileSync(dbPath);
  assert.equal(bytes.includes(Buffer.from(FIXTURE_NONCE)), false, 'raw nonce must not be stored');
  assert.equal(bytes.includes(SYNTHETIC_KEY), false, 'key must not be stored');
  assert.equal(bytes.includes(Buffer.from(FIXTURE.provenance.hmacSha256)), false, 'evidence MAC must not be stored');
  assert.equal(bytes.includes(Buffer.from(FIXTURE.fileDigests['limits.py'])), false, 'evidence must not be stored');
  assert.equal(existsSync(`${dbPath}-journal`), false);
});

test('independent connections in one process see one reservation only', t => {
  const {dbPath} = scratch(t);
  const storeA = createStore(t, dbPath);
  const storeB = openStore(t, dbPath);
  const ticket = beginDurableAcceptance(storeA, hostController());
  rejectsWith(() => beginDurableAcceptance(storeB, hostController()), 'REPLAY_UNRESOLVED');
  ticket.authenticateAndCommit(fixtureEvidence(), FIXTURE_BINDINGS);
  rejectsWith(() => beginDurableAcceptance(storeB, hostController()), 'REPLAY_REJECTED');
});

test('concurrent processes racing the same nonce reserve it exactly once, and a crash leaves it unresolved', async t => {
  const {dir, dbPath} = scratch(t);
  closeReplayStore(createStore(t, dbPath));
  const goPath = join(dir, 'go');
  const children = [];
  for (let index = 0; index < 6; index += 1) {
    children.push(startChild(dir, {
      mode: 'reserve', guardUrl: GUARD_URL, authUrl: AUTH_URL, dbPath, goPath,
      nonce: FIXTURE_NONCE, claimRecord: FIXTURE_CLAIM, busyTimeoutMs: 5000, ledgerId: PINS.get(dbPath),
    }));
  }
  await Promise.all(children.map(child => child.ready));
  writeFileSync(goPath, '', 'utf8');
  const outcomes = await Promise.all(children.map(child => child.exited));
  const results = outcomes.map(outcome => {
    assert.equal(outcome.code, 0);
    const last = outcome.lines.at(-1);
    return last.result ?? last.code;
  });
  assert.equal(results.filter(value => value === 'reserved').length, 1, `results: ${results.join(',')}`);
  for (const value of results) assert.ok(['reserved', 'REPLAY_UNRESOLVED', 'STORE_BUSY'].includes(value), value);

  const store = openStore(t, dbPath);
  const controller = hostController();
  assert.equal(inspectReplayRecord(store, controller), 'pending');
  rejectsWith(() => beginDurableAcceptance(store, controller), 'REPLAY_UNRESOLVED');
  const db = rawDb(dbPath);
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM replay_records').get().n, 1);
  } finally {
    db.close();
  }
});

test('a committed record survives a restart in a separate process', async t => {
  const {dir, dbPath} = scratch(t);
  const store = createStore(t, dbPath);
  beginDurableAcceptance(store, hostController()).authenticateAndCommit(fixtureEvidence(), FIXTURE_BINDINGS);
  closeReplayStore(store);
  const restarted = startChild(dir, {
    mode: 'reserve', guardUrl: GUARD_URL, authUrl: AUTH_URL, dbPath,
    nonce: FIXTURE_NONCE, claimRecord: FIXTURE_CLAIM, busyTimeoutMs: 2000, ledgerId: PINS.get(dbPath),
  });
  const outcome = await restarted.exited;
  assert.equal(outcome.code, 0);
  assert.equal(outcome.lines.at(-1).code, 'REPLAY_REJECTED');
});

test('a killed writer mid-transaction rolls back, and settlement blocked at BEGIN IMMEDIATE is unresolved', async t => {
  const {dir, dbPath} = scratch(t);
  const store = createStore(t, dbPath, {busyTimeoutMs: 150});
  const ticket = beginDurableAcceptance(store, hostController());
  const holder = startChild(dir, {mode: 'hold-lock', dbPath});
  t.after(() => holder.child.kill('SIGKILL'));
  await holder.ready;
  assert.ok(holder.lines.some(line => line.ready), 'lock holder did not start');

  const unresolved = rejectsWith(() => ticket.authenticateAndCommit(fixtureEvidence(), FIXTURE_BINDINGS),
    'ACCEPTANCE_UNRESOLVED');
  assert.equal(unresolved.durable, 'unresolved');
  assert.equal(ticket.state, 'unresolved');
  rejectsWith(() => ticket.authenticateAndCommit(fixtureEvidence(), FIXTURE_BINDINGS), 'TICKET_SETTLED');
  const probeClaim = syntheticClaim('claim-busy-probe');
  rejectsWith(() => beginDurableAcceptance(store, hostController({nonce: 'nonce-busy-probe-0001', claim: probeClaim})),
    'STORE_BUSY');

  holder.child.kill('SIGKILL');
  await holder.exited;
  closeReplayStore(store);

  const reopened = openStore(t, dbPath);
  const fixture = hostController();
  assert.equal(inspectReplayRecord(reopened, fixture), 'pending');
  rejectsWith(() => beginDurableAcceptance(reopened, fixture), 'REPLAY_UNRESOLVED');
  const probe = hostController({nonce: 'nonce-busy-probe-0001', claim: probeClaim});
  assert.equal(inspectReplayRecord(reopened, probe), 'absent');
  beginDurableAcceptance(reopened, probe).reject();
  const db = rawDb(dbPath);
  try {
    const rows = db.prepare('SELECT nonce_digest FROM replay_records').all();
    assert.equal(rows.length, 2);
    assert.equal(rows.some(row => row.nonce_digest === 'd'.repeat(64)), false, 'killed transaction must roll back');
  } finally {
    db.close();
  }
});

test('losing the store between reservation and commit leaves the nonce unresolved', t => {
  const {dbPath} = scratch(t);
  const store = createStore(t, dbPath);
  const controller = hostController();
  const ticket = beginDurableAcceptance(store, controller);
  closeReplayStore(store);
  rejectsWith(() => ticket.authenticateAndCommit(fixtureEvidence(), FIXTURE_BINDINGS), 'ACCEPTANCE_UNRESOLVED');
  rejectsWith(() => beginDurableAcceptance(openStore(t, dbPath), controller), 'REPLAY_REJECTED');
  const reopened = openStore(t, dbPath);
  assert.equal(inspectReplayRecord(reopened, hostController()), 'pending');
  rejectsWith(() => beginDurableAcceptance(reopened, hostController()), 'REPLAY_UNRESOLVED');
});

test('evidence bound to another claim or nonce is rejected and burns the reservation', t => {
  const {dbPath} = scratch(t);
  const store = createStore(t, dbPath);

  const otherClaim = syntheticClaim();
  const wrongClaim = hostController({claim: otherClaim});
  const ticket = beginDurableAcceptance(store, wrongClaim);
  const error = rejectsWith(() => ticket.authenticateAndCommit(fixtureEvidence(), FIXTURE_BINDINGS),
    'EVIDENCE_REJECTED');
  assert.equal(error.durable, 'rejected');
  assert.equal(inspectReplayRecord(store, hostController({claim: otherClaim})), 'rejected');
  rejectsWith(() => beginDurableAcceptance(store, hostController({claim: otherClaim})), 'REPLAY_REJECTED');
  // Same nonce, different host claim: the existing record is bound to its own claim.
  rejectsWith(() => beginDurableAcceptance(store, hostController()), 'CLAIM_MISMATCH');
  rejectsWith(() => inspectReplayRecord(store, hostController()), 'CLAIM_MISMATCH');

  const otherNonce = 'nonce-20261118-0099';
  const nonceTicket = beginDurableAcceptance(store, hostController({nonce: otherNonce}));
  rejectsWith(() => nonceTicket.authenticateAndCommit(fixtureEvidence(), FIXTURE_BINDINGS), 'EVIDENCE_REJECTED');
  assert.equal(inspectReplayRecord(store, hostController({nonce: otherNonce})), 'rejected');

  const tampered = fixtureEvidence();
  tampered.claimId = otherClaim.claimId;
  tampered.provenance.hmacSha256 = canonicalAttestationHmac(tampered, randomBytes(32));
  const keyNonce = 'nonce-20261118-0100';
  const keyTicket = beginDurableAcceptance(store, hostController({nonce: keyNonce}));
  rejectsWith(() => keyTicket.authenticateAndCommit(tampered, FIXTURE_BINDINGS), 'EVIDENCE_REJECTED');
});

test('explicit reject burns the nonce durably', t => {
  const {dbPath} = scratch(t);
  const store = createStore(t, dbPath);
  const ticket = beginDurableAcceptance(store, hostController());
  assert.equal(ticket.reject(), 'rejected');
  rejectsWith(() => ticket.reject(), 'TICKET_SETTLED');
  rejectsWith(() => beginDurableAcceptance(store, hostController()), 'REPLAY_REJECTED');
});

test('callers cannot supply authority, claims, trusted flags, or forged controllers', t => {
  const {dbPath} = scratch(t);
  rejectsWith(() => openPinned({path: dbPath, create: true, trusted: true}), 'STORE_CONFIG');
  rejectsWith(() => openPinned({path: dbPath, create: true, claimId: 'x'}), 'STORE_CONFIG');
  assert.equal(existsSync(dbPath), false);
  const store = createStore(t, dbPath);
  rejectsWith(() => beginDurableAcceptance(store, hostController(), {claim: syntheticClaim()}), 'STORE_CONFIG');
  const forged = Object.freeze({expectedInvocationNonce: 'nonce-forged-00000001', claim: FIXTURE_CLAIM});
  rejectsWith(() => beginDurableAcceptance(store, forged), 'CONTROLLER_REQUIRED');
  rejectsWith(() => inspectReplayRecord(store, forged), 'CONTROLLER_REQUIRED');
  rejectsWith(() => beginDurableAcceptance(store, null), 'CONTROLLER_REQUIRED');
  rejectsWith(() => beginDurableAcceptance({}, hostController()), 'STORE_UNAVAILABLE');
  const ticket = beginDurableAcceptance(store, hostController());
  rejectsWith(() => ticket.authenticateAndCommit(fixtureEvidence()), 'STORE_CONFIG');
  assert.equal(ticket.state, 'reserved');
  ticket.authenticateAndCommit(fixtureEvidence(), FIXTURE_BINDINGS);
});

test('invalid configuration and missing storage fail closed without creating a store', t => {
  const {dir, dbPath} = scratch(t);
  rejectsWith(() => openPinned({path: dbPath}), 'STORE_UNAVAILABLE');
  assert.equal(existsSync(dbPath), false, 'a missing store must not be recreated silently');
  rejectsWith(() => openPinned({path: 'relative.sqlite', create: true}), 'STORE_CONFIG');
  rejectsWith(() => openPinned({path: ':memory:'}), 'STORE_CONFIG');
  rejectsWith(() => openPinned({path: `file:${dbPath}`}), 'STORE_CONFIG');
  rejectsWith(() => openPinned({path: `${dbPath}?mode=memory`}), 'STORE_CONFIG');
  rejectsWith(() => openPinned({path: dbPath, busyTimeoutMs: -1}), 'STORE_CONFIG');
  rejectsWith(() => openPinned({path: dbPath, create: 'yes'}), 'STORE_CONFIG');
  rejectsWith(() => openReplayStore(), 'STORE_CONFIG');
  rejectsWith(() => openPinned({path: dir}), 'STORE_UNAVAILABLE');
  closeReplayStore(createStore(t, dbPath));
  rejectsWith(() => openPinned({path: dbPath, create: true}), 'STORE_EXISTS');
});

test('corrupt, foreign, tampered or truncated storage never accepts', t => {
  const {dir} = scratch(t);
  const codes = ['STORE_CORRUPT', 'STORE_UNAVAILABLE', 'STORE_SCOPE_MISMATCH', 'STORE_FULL'];

  const garbage = join(dir, 'garbage.sqlite');
  writeFileSync(garbage, randomBytes(8192));
  assertNeverAccepts(garbage, codes);

  const empty = join(dir, 'empty.sqlite');
  writeFileSync(empty, '');
  rejectsWith(() => openPinned({path: empty}), 'STORE_CORRUPT');

  const foreign = join(dir, 'foreign.sqlite');
  const foreignDb = rawDb(foreign);
  foreignDb.exec('CREATE TABLE replay_records (x TEXT)');
  foreignDb.close();
  rejectsWith(() => openPinned({path: foreign}), 'STORE_CORRUPT');

  const extraTable = join(dir, 'extra.sqlite');
  closeReplayStore(openPinned({path: extraTable, create: true}));
  const extraDb = rawDb(extraTable);
  extraDb.exec('CREATE TABLE extra (x TEXT)');
  extraDb.close();
  rejectsWith(() => openPinned({path: extraTable}), 'STORE_CORRUPT');

  const otherScope = join(dir, 'scope.sqlite');
  closeReplayStore(openPinned({path: otherScope, create: true}));
  const scopeDb = rawDb(otherScope);
  scopeDb.exec("UPDATE replay_meta SET v = 'other-scope' WHERE k = 'scope'");
  scopeDb.close();
  rejectsWith(() => openPinned({path: otherScope}), 'STORE_SCOPE_MISMATCH');

  const tamperedRow = join(dir, 'tampered.sqlite');
  const tamperStore = openPinned({path: tamperedRow, create: true});
  try {
    beginDurableAcceptance(tamperStore, hostController()).reject();
    // Tamper while a handle is open: the next operation must notice.
    rawExec(tamperedRow, "UPDATE replay_records SET state = 'pending'");
    rejectsWith(() => beginDurableAcceptance(tamperStore, hostController()), 'STORE_CORRUPT');
    rejectsWith(() => inspectReplayRecord(tamperStore, hostController()), 'STORE_CORRUPT');
  } finally {
    closeReplayStore(tamperStore);
  }
  rejectsWith(() => openPinned({path: tamperedRow}), 'STORE_CORRUPT');

  const truncated = join(dir, 'truncated.sqlite');
  const truncStore = openPinned({path: truncated, create: true});
  beginDurableAcceptance(truncStore, hostController({nonce: 'nonce-trunc-0000001', claim: syntheticClaim()})).reject();
  closeReplayStore(truncStore);
  truncateSync(truncated, Math.floor(statSync(truncated).size / 2));
  assertNeverAccepts(truncated, codes);
});

test('errors are fixed strings without nonces, keys, paths, claims or SQLite text', t => {
  const {dir, dbPath} = scratch(t);
  const errors = [];
  const capture = fn => {
    try {
      fn();
    } catch (error) {
      errors.push(error);
    }
  };
  capture(() => openPinned({path: dbPath}));
  const garbage = join(dir, 'garbage.sqlite');
  writeFileSync(garbage, randomBytes(4096));
  capture(() => openPinned({path: garbage}));
  const store = createStore(t, dbPath);
  const ticket = beginDurableAcceptance(store, hostController());
  capture(() => beginDurableAcceptance(store, hostController()));
  capture(() => ticket.authenticateAndCommit({provenance: {invocationNonce: FIXTURE_NONCE}}, FIXTURE_BINDINGS));
  capture(() => beginDurableAcceptance(store, hostController({claim: syntheticClaim()})));
  capture(() => beginDurableAcceptance(store, {expectedInvocationNonce: FIXTURE_NONCE}));
  assert.equal(errors.length, 6);
  const allowed = new Set(Object.values(REPLAY_ERROR_MESSAGES));
  const forbidden = [FIXTURE_NONCE, SYNTHETIC_KEY.toString('utf8'), dbPath, dir, FIXTURE_CLAIM.claimId,
    FIXTURE_CLAIM.scopeHash, 'SQLITE', 'sqlite', 'malformed', 'database'];
  for (const error of errors) {
    assert.ok(error instanceof ReplayGuardError);
    assert.ok(allowed.has(error.message), error.code);
    assert.equal(error.cause, undefined);
    const text = `${error.message} ${JSON.stringify(error)} ${String(error)}`;
    for (const value of forbidden) assert.equal(text.includes(value), false, `${error.code} leaks a value`);
    for (const value of forbidden) assert.equal(String(error.stack).split('\n')[0].includes(value), false);
  }
});

// Opens a seeded store, applies a raw edit while the handle is open, then
// checks that no nonce can be admitted or inspected and that reopen fails.
function tamperAndAssert(t, edit) {
  const {dbPath} = scratch(t);
  seedStore(dbPath);
  const handle = openStore(t, dbPath);
  assert.equal(inspectReplayRecord(handle, hostController({nonce: NONCE_A, claim: syntheticClaim()})), 'rejected');
  edit(dbPath, readRows(dbPath));
  assertStoreRefusesEverything(dbPath, handle);
  return dbPath;
}

test('integrity: a structurally valid altered nonce_digest cannot reopen a settled nonce', t => {
  tamperAndAssert(t, path => {
    rawExec(path, 'UPDATE replay_records SET nonce_digest = ? WHERE seq = 1', 'a'.repeat(64));
  });
});

test('integrity: an altered nonce_digest with a recomputed row checksum is caught by the chain', t => {
  tamperAndAssert(t, (path, rows) => {
    const row = rows[0];
    const forged = 'a'.repeat(64);
    rawExec(path, 'UPDATE replay_records SET nonce_digest = ?, row_digest = ? WHERE seq = 1', forged,
      testRowDigest(1, forged, row.claim_id, row.scope_hash, row.state));
  });
});

test('integrity: corruption of a different row blocks admission of an unrelated new nonce', t => {
  tamperAndAssert(t, path => {
    rawExec(path, "UPDATE replay_records SET claim_id = 'claim-other-row' WHERE seq = 2");
  });
});

test('integrity: a changed state on another row blocks every admission', t => {
  tamperAndAssert(t, path => {
    rawExec(path, "UPDATE replay_records SET state = 'committed' WHERE seq = 3");
  });
});

test('integrity: a deleted middle row is detected', t => {
  tamperAndAssert(t, path => {
    rawExec(path, 'DELETE FROM replay_records WHERE seq = 2');
  });
});

test('integrity: a deleted newest row with an adjusted count is caught by the chain head', t => {
  tamperAndAssert(t, path => {
    rawExec(path, 'DELETE FROM replay_records WHERE seq = 3');
    rawExec(path, "UPDATE replay_meta SET v = '2' WHERE k = 'count'");
  });
});

test('integrity: an inserted row with a valid row checksum but no ledger update is detected', t => {
  tamperAndAssert(t, (path, rows) => {
    const row = rows[0];
    const extra = 'c'.repeat(64);
    rawExec(path,
      "INSERT INTO replay_records (nonce_digest, seq, claim_id, scope_hash, state, row_digest) VALUES (?, 4, ?, ?, 'pending', ?)",
      extra, row.claim_id, row.scope_hash, testRowDigest(4, extra, row.claim_id, row.scope_hash, 'pending'));
  });
});

test('integrity: reordered sequence numbers with recomputed row checksums are caught by the chain', t => {
  tamperAndAssert(t, (path, rows) => {
    const [first, second] = rows;
    rawExec(path, 'UPDATE replay_records SET seq = 100 WHERE seq = 1');
    rawExec(path, 'UPDATE replay_records SET seq = 1, row_digest = ? WHERE seq = 2',
      testRowDigest(1, second.nonce_digest, second.claim_id, second.scope_hash, second.state));
    rawExec(path, 'UPDATE replay_records SET seq = 2, row_digest = ? WHERE seq = 100',
      testRowDigest(2, first.nonce_digest, first.claim_id, first.scope_hash, first.state));
  });
});

test('integrity: altered count or chain head metadata is detected', t => {
  tamperAndAssert(t, path => {
    rawExec(path, "UPDATE replay_meta SET v = '4' WHERE k = 'count'");
  });
  tamperAndAssert(t, path => {
    rawExec(path, "UPDATE replay_meta SET v = ? WHERE k = 'head'", 'b'.repeat(64));
  });
  tamperAndAssert(t, path => {
    rawExec(path, "DELETE FROM replay_meta WHERE k = 'head'");
  });
});

test('integrity: a pending record survives validation and stays unresolved after an untampered reopen', t => {
  const {dbPath} = scratch(t);
  seedStore(dbPath);
  const store = openStore(t, dbPath);
  const claim = syntheticClaim();
  rejectsWith(() => beginDurableAcceptance(store, hostController({nonce: NONCE_C, claim})), 'REPLAY_UNRESOLVED');
  rejectsWith(() => beginDurableAcceptance(store, hostController({nonce: NONCE_A, claim})), 'REPLAY_REJECTED');
  beginDurableAcceptance(store, hostController({nonce: NONCE_D, claim})).reject();
  assert.equal(readRows(dbPath).length, 4);
});

// Documents the stated limit: the checksum is unkeyed, so a writer that
// recomputes every row, the count and the head can erase a record. This is
// why the host must protect the file; the helper does not claim otherwise.
test('documented limit: a fully recomputed consistent rewrite is not detectable', t => {
  const {dbPath} = scratch(t);
  seedStore(dbPath);
  const rows = readRows(dbPath).filter(row => row.seq !== 3);
  let head = testGenesis(PINS.get(dbPath));
  for (const row of rows) head = testLink(head, row.seq, row.nonce_digest, row.claim_id, row.scope_hash);
  rawExec(dbPath, 'DELETE FROM replay_records WHERE seq = 3');
  rawExec(dbPath, "UPDATE replay_meta SET v = '2' WHERE k = 'count'");
  rawExec(dbPath, "UPDATE replay_meta SET v = ? WHERE k = 'head'", head);
  const store = openStore(t, dbPath);
  assert.equal(inspectReplayRecord(store, hostController({nonce: NONCE_C, claim: syntheticClaim()})), 'absent');
});

// Post-open changes to the header or schema must be caught inside the
// deciding transaction, not only at open.
for (const [label, sql] of [
  ['application id', 'PRAGMA application_id = 1'],
  ['user version', 'PRAGMA user_version = 99'],
  ['added index', 'CREATE INDEX extra_idx ON replay_records (state)'],
  ['added view', 'CREATE VIEW extra_view AS SELECT nonce_digest FROM replay_records'],
  ['insert-suppressing trigger', 'CREATE TRIGGER suppress BEFORE INSERT ON replay_records BEGIN SELECT RAISE(IGNORE); END'],
  ['meta-rewriting trigger',
    "CREATE TRIGGER rewrite AFTER INSERT ON replay_records BEGIN UPDATE replay_meta SET v = v WHERE k = 'count'; END"],
]) {
  test(`structure: a post-open ${label} blocks every decision and writes no row`, t => {
    const dbPath = tamperAndAssert(t, path => rawExec(path, sql));
    assert.equal(readRows(dbPath).length, 3);
  });
}

test('structure: a post-open trigger that suppresses settlement leaves the ticket unresolved, never committed', t => {
  const {dbPath} = scratch(t);
  const store = createStore(t, dbPath);
  const ticket = beginDurableAcceptance(store, hostController());
  rawExec(dbPath, 'CREATE TRIGGER hold BEFORE UPDATE ON replay_records BEGIN SELECT RAISE(IGNORE); END');
  const error = rejectsWith(() => ticket.authenticateAndCommit(fixtureEvidence(), FIXTURE_BINDINGS),
    'ACCEPTANCE_UNRESOLVED');
  assert.equal(error.durable, 'unresolved');
  rawExec(dbPath, 'DROP TRIGGER hold');
  assert.equal(inspectReplayRecord(store, hostController()), 'pending');
  rejectsWith(() => beginDurableAcceptance(store, hostController()), 'REPLAY_UNRESOLVED');
});

test('identity: open requires a well-formed pinned ledger id, and create refuses one', t => {
  const {dbPath} = scratch(t);
  rejectsWith(() => openReplayStore({path: dbPath, create: true, expectedLedgerId: UNPINNED}), 'STORE_CONFIG');
  assert.equal(existsSync(dbPath), false);
  const store = createStore(t, dbPath);
  const pinned = getReplayLedgerId(store);
  assert.match(pinned, /^[0-9a-f]{32}$/);
  closeReplayStore(store);
  rejectsWith(() => openReplayStore({path: dbPath}), 'STORE_CONFIG');
  rejectsWith(() => openReplayStore({path: dbPath, expectedLedgerId: pinned.toUpperCase()}), 'STORE_CONFIG');
  rejectsWith(() => openReplayStore({path: dbPath, expectedLedgerId: 42}), 'STORE_CONFIG');
  rejectsWith(() => openReplayStore({path: dbPath, expectedLedgerId: UNPINNED}), 'STORE_IDENTITY_MISMATCH');
  closeReplayStore(openReplayStore({path: dbPath, expectedLedgerId: pinned}));
  rejectsWith(() => getReplayLedgerId(store), 'STORE_UNAVAILABLE');
});

test('identity: a different valid ledger for the same scope cannot stand in for the pinned one', t => {
  const {dir, dbPath} = scratch(t);
  const original = createStore(t, dbPath);
  const pinned = getReplayLedgerId(original);
  beginDurableAcceptance(original, hostController()).authenticateAndCommit(fixtureEvidence(), FIXTURE_BINDINGS);
  closeReplayStore(original);

  const otherPath = join(dir, 'other.sqlite');
  closeReplayStore(createStore(t, otherPath));
  assert.notEqual(PINS.get(otherPath), pinned);
  rejectsWith(() => openReplayStore({path: otherPath, expectedLedgerId: pinned}), 'STORE_IDENTITY_MISMATCH');

  // Substitute the other ledger at the original path: the spent nonce is
  // absent there, but the pinned identity refuses it.
  copyFileSync(otherPath, dbPath);
  rejectsWith(() => openReplayStore({path: dbPath, expectedLedgerId: pinned}), 'STORE_IDENTITY_MISMATCH');
});

test('identity: a post-open ledger id change is refused inside the deciding transaction', t => {
  const {dbPath} = scratch(t);
  const store = createStore(t, dbPath);
  const ticket = beginDurableAcceptance(store, hostController());
  rawExec(dbPath, "UPDATE replay_meta SET v = ? WHERE k = 'ledger_id'", 'a'.repeat(32));
  rejectsWith(() => beginDurableAcceptance(store, hostController({nonce: NONCE_D, claim: syntheticClaim()})),
    'STORE_IDENTITY_MISMATCH');
  rejectsWith(() => inspectReplayRecord(store, hostController()), 'STORE_IDENTITY_MISMATCH');
  rejectsWith(() => ticket.authenticateAndCommit(fixtureEvidence(), FIXTURE_BINDINGS), 'ACCEPTANCE_UNRESOLVED');
  const rows = readRows(dbPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'pending');
});

// Documents the stated limit: pinning does not stop rollback to an older
// consistent copy of the same ledger, which carries the same id.
test('documented limit: restoring an older copy of the same pinned ledger is not detectable', t => {
  const {dir, dbPath} = scratch(t);
  closeReplayStore(createStore(t, dbPath));
  const backup = join(dir, 'backup.sqlite');
  copyFileSync(dbPath, backup);
  const store = openStore(t, dbPath);
  beginDurableAcceptance(store, hostController()).authenticateAndCommit(fixtureEvidence(), FIXTURE_BINDINGS);
  closeReplayStore(store);
  copyFileSync(backup, dbPath);
  const restored = openStore(t, dbPath);
  assert.equal(inspectReplayRecord(restored, hostController()), 'absent');
});

test('input: forged, proxied or getter-bearing controllers get fixed errors and never run getters', t => {
  const {dbPath} = scratch(t);
  const store = createStore(t, dbPath);
  let getterCalls = 0;
  const trap = {};
  for (const key of ['expectedInvocationNonce', 'claim']) {
    Object.defineProperty(trap, key, {
      get() {
        getterCalls += 1;
        throw new Error(`leak ${FIXTURE_NONCE} ${dbPath}`);
      },
    });
  }
  const genuine = hostController();
  const proxied = new Proxy(genuine, {
    get() {
      getterCalls += 1;
      throw new Error(`leak ${FIXTURE_NONCE}`);
    },
  });
  const forged = Object.freeze({expectedInvocationNonce: FIXTURE_NONCE, claim: FIXTURE_CLAIM});
  for (const candidate of [trap, proxied, forged, null, undefined, 'controller', 7]) {
    rejectsWith(() => beginDurableAcceptance(store, candidate), 'CONTROLLER_REQUIRED');
    rejectsWith(() => inspectReplayRecord(store, candidate), 'CONTROLLER_REQUIRED');
  }
  assert.equal(getterCalls, 0);
  assert.equal(readRows(dbPath).length, 0);
  // The genuine controller was never spent by any of the refused calls.
  assert.equal(inspectReplayRecord(store, genuine), 'absent');
  beginDurableAcceptance(store, genuine).authenticateAndCommit(fixtureEvidence(), FIXTURE_BINDINGS);
});

test('input: getter-bearing, proxied or symbol-keyed open options get fixed errors and never run getters', t => {
  const {dbPath} = scratch(t);
  let getterCalls = 0;
  const getterPath = {create: true};
  Object.defineProperty(getterPath, 'path', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(`leak ${dbPath}`);
    },
  });
  const proxied = new Proxy({path: dbPath, create: true}, {
    get() {
      getterCalls += 1;
      throw new Error('leak');
    },
  });
  const symbolKeyed = {path: dbPath, create: true, [Symbol('x')]: 1};
  const inherited = Object.create({path: dbPath, create: true});
  for (const options of [getterPath, proxied, symbolKeyed, inherited, [dbPath], 'path']) {
    rejectsWith(() => openReplayStore(options), 'STORE_CONFIG');
  }
  assert.equal(getterCalls, 0);
  assert.equal(existsSync(dbPath), false);
});

test('input: evidence or bindings with throwing getters are rejected with fixed errors', t => {
  const {dbPath} = scratch(t);
  const store = createStore(t, dbPath);
  const badEvidence = fixtureEvidence();
  Object.defineProperty(badEvidence, 'claimId', {
    enumerable: true,
    get() {
      throw new Error(`leak ${FIXTURE_NONCE}`);
    },
  });
  const first = beginDurableAcceptance(store, hostController());
  const error = rejectsWith(() => first.authenticateAndCommit(badEvidence, FIXTURE_BINDINGS), 'EVIDENCE_REJECTED');
  assert.equal(error.message.includes(FIXTURE_NONCE), false);

  const badBindings = {};
  Object.defineProperty(badBindings, 'actualBaseRevision', {
    get() {
      throw new Error(`leak ${FIXTURE_NONCE}`);
    },
  });
  const second = beginDurableAcceptance(store, hostController({nonce: NONCE_D}));
  rejectsWith(() => second.authenticateAndCommit(fixtureEvidence(), badBindings), 'EVIDENCE_REJECTED');
});

// Holds a SQLite read transaction (SHARED lock) on a separate connection.
// BEGIN IMMEDIATE still succeeds against a SHARED lock, but COMMIT needs an
// EXCLUSIVE lock and returns SQLITE_BUSY after the busy timeout. The probe
// below shows BEGIN IMMEDIATE is not the failing step; that COMMIT is the
// failing step is inferred from SQLite's documented locking, not observed by
// instrumentation inside the module.
function holdReader(dbPath) {
  const reader = rawDb(dbPath);
  reader.exec('BEGIN DEFERRED');
  reader.prepare('SELECT count(*) AS n FROM replay_records').get();
  const probe = rawDb(dbPath);
  try {
    probe.exec('BEGIN IMMEDIATE');
    probe.exec('ROLLBACK');
  } finally {
    probe.close();
  }
  return () => {
    reader.exec('COMMIT');
    reader.close();
  };
}

test('commit failure: a settlement whose COMMIT is busy rolls back and stays unresolved', t => {
  const {dbPath} = scratch(t);
  const store = createStore(t, dbPath, {busyTimeoutMs: 100});
  const ticket = beginDurableAcceptance(store, hostController());
  const release = holdReader(dbPath);
  let error;
  try {
    error = rejectsWith(() => ticket.authenticateAndCommit(fixtureEvidence(), FIXTURE_BINDINGS),
      'ACCEPTANCE_UNRESOLVED');
  } finally {
    release();
  }
  assert.equal(error.durable, 'unresolved');
  assert.equal(ticket.state, 'unresolved');
  assert.equal(readRows(dbPath)[0].state, 'pending');
  assert.equal(inspectReplayRecord(store, hostController()), 'pending');
  rejectsWith(() => beginDurableAcceptance(store, hostController()), 'REPLAY_UNRESOLVED');
  assert.equal(existsSync(`${dbPath}-journal`), false);
});

test('commit failure: a reservation whose COMMIT is busy throws and leaves no record', t => {
  const {dbPath} = scratch(t);
  const store = createStore(t, dbPath, {busyTimeoutMs: 100});
  const controller = hostController();
  const release = holdReader(dbPath);
  try {
    rejectsWith(() => beginDurableAcceptance(store, controller), 'STORE_BUSY');
  } finally {
    release();
  }
  assert.equal(readRows(dbPath).length, 0);
  // The throwing call means the host never dispatched; the spent in-memory
  // controller cannot be reused, and a fresh host controller may reserve.
  rejectsWith(() => beginDurableAcceptance(store, controller), 'REPLAY_REJECTED');
  beginDurableAcceptance(store, hostController()).authenticateAndCommit(fixtureEvidence(), FIXTURE_BINDINGS);
});
