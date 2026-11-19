// Synthetic tests for durable-request-claims.mjs. Every store is a temporary
// SQLite file under the OS temp directory. Child processes only open that
// temporary store; no worker, browser, network or credential is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, writeSync, statSync, truncateSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openClaimRegistry, ClaimRegistryError, TRUST_LIMITS, requestKeyOf, scopeHashOf, _testing} from './durable-request-claims.mjs';

const SELF = fileURLToPath(import.meta.url);
const SCOPE = Object.freeze({baseRevision: 'synthetic-rev-1', fileDigests: ['a'.repeat(64), 'b'.repeat(64)],
  modelId: 'synthetic-model', engine: 'synthetic-engine', protectionCases: 'c'.repeat(64), deadlineMs: 5000});
const OTHER_SCOPE = Object.freeze({...SCOPE, fileDigests: ['a'.repeat(64), 'd'.repeat(64)]});
const BIRTH = Object.freeze({pid: 4242, creationTime: 'synthetic-creation-0001', bootId: 'synthetic-boot-0001'});
const HOST_DONE = Object.freeze({authority: 'host', cleanup: 'verified', inference: 'settled', resultHash: 'e'.repeat(64)});
const CONTINUE = Object.freeze({authority: 'host', decision: 'continue-pre-dispatch', observedGeneration: 1});

// Child mode: open the temporary store and run a bounded synthetic sequence.
// A crash point kills the process abruptly (no close, no rollback by us).
if (process.argv[2] === 'durable-claims-child') {
  const spec = JSON.parse(process.argv[3]);
  const emit = line => writeSync(1, JSON.stringify(line) + '\n');
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  try {
    const registry = openClaimRegistry(spec.db, {busyTimeoutMs: 10000, testFaultHook: point => {
      if (point === spec.crashAt) { emit({crashedAt: point}); process.kill(process.pid, 'SIGKILL'); }
    }});
    if (spec.startAt) while (Date.now() < spec.startAt) Atomics.wait(sleeper, 0, 0, 2);
    const base = {requestId: spec.requestId, scope: spec.scope};
    if (spec.mode === 'continue') {
      const resumed = registry.hostContinuePreDispatch({...base, hostDecision: spec.hostDecision});
      emit({step: 'continue', generation: resumed.claim.generation, dispatchAuthorized: resumed.dispatchAuthorized});
      registry.close();
      process.exit(0);
    }
    const reserved = registry.reserve(base);
    emit({step: 'reserve', outcome: reserved.outcome, dispatchAuthorized: reserved.dispatchAuthorized,
      ownerToken: reserved.ownerToken ?? null, claim: reserved.claim});
    if (spec.mode === 'sequence') {
      const {ownerToken} = reserved;
      const intent = registry.recordDispatchIntent({...base, ownerToken});
      emit({step: 'dispatched', nonce: intent.nonce});
      registry.recordWorkerIdentity({...base, ownerToken, nonce: intent.nonce, birthIdentity: spec.birth});
      emit({step: 'worker'});
      registry.recordHostCompletion({...base, ownerToken, hostEvidence: spec.hostEvidence});
      emit({step: 'complete'});
    }
    registry.close();
  } catch (error) {
    emit({error: error instanceof ClaimRegistryError ? error.code : 'UNEXPECTED', message: String(error.message)});
  }
  process.exit(0);
}

function childEnv() {
  // Empty allowlisted environment; Windows needs only SystemRoot for crypto.
  return process.platform === 'win32' && process.env.SystemRoot ? {SystemRoot: process.env.SystemRoot} : {};
}

const parseLines = text => text.split('\n').filter(Boolean).map(line => JSON.parse(line));

function runChildSync(spec) {
  const result = spawnSync(process.execPath, [SELF, 'durable-claims-child', JSON.stringify(spec)],
    {encoding: 'utf8', windowsHide: true, timeout: 20000, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe']});
  if (result.error) throw result.error;
  return parseLines(result.stdout);
}

function runChild(spec) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SELF, 'durable-claims-child', JSON.stringify(spec)],
      {windowsHide: true, env: childEnv(), stdio: ['ignore', 'pipe', 'ignore']});
    let out = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
    const timer = setTimeout(() => child.kill(), 20000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', () => { clearTimeout(timer); resolve(parseLines(out)); });
  });
}

function withStore(body, {initialize = true} = {}) {
  return async t => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-durable-claims-'));
    const path = join(dir, 'claims.sqlite');
    if (initialize) openClaimRegistry(path, {initialize: true}).close();
    try { await body({dir, path, t}); }
    finally { rmSync(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}); }
  };
}

const raw = (path, body) => {
  const db = new DatabaseSync(path);
  try { return body(db); } finally { db.close(); }
};

// Recomputes every row digest and the aggregate, the way a writer with file
// access could. Used only to show what unkeyed checksums can and cannot catch.
function reseal(db, {rowsOnly = false} = {}) {
  const rows = db.prepare('SELECT * FROM claims').all().map(row => ({...row}));
  for (const row of rows) {
    const next = _testing.rowDigest(row);
    db.prepare('UPDATE claims SET row_digest = ? WHERE request_key = ? AND row_digest = ?').run(next, row.request_key, row.row_digest);
    row.row_digest = next;
  }
  if (rowsOnly) return;
  db.prepare("UPDATE meta SET value = ? WHERE key = 'row_count'").run(String(rows.length));
  db.prepare("UPDATE meta SET value = ? WHERE key = 'aggregate'").run(_testing.aggregateDigest(rows));
}

const code = expected => error => error instanceof ClaimRegistryError && error.code === expected;
const freshToken = () => randomBytes(32).toString('base64url');

function completeInProcess(registry, requestId, scope = SCOPE, birth = BIRTH) {
  const base = {requestId, scope};
  const {ownerToken} = registry.reserve(base);
  const intent = registry.recordDispatchIntent({...base, ownerToken});
  registry.recordWorkerIdentity({...base, ownerToken, nonce: intent.nonce, birthIdentity: birth});
  registry.recordHostCompletion({...base, ownerToken, hostEvidence: HOST_DONE});
  return {ownerToken, nonce: intent.nonce};
}

test('concurrent identical reservations across processes create exactly one claim', withStore(async ({path}) => {
  const startAt = Date.now() + 1500;
  const results = await Promise.all(Array.from({length: 6}, () =>
    runChild({db: path, mode: 'reserve', requestId: 'synthetic-req-concurrent', scope: SCOPE, startAt})));
  const reserves = results.map(lines => lines.find(line => line.step === 'reserve'));
  assert.ok(reserves.every(Boolean), 'every child must report a reservation');
  assert.equal(reserves.filter(item => item.outcome === 'created').length, 1);
  assert.equal(reserves.filter(item => item.outcome === 'existing').length, 5);
  assert.ok(reserves.every(item => item.dispatchAuthorized === false));
  assert.equal(new Set(reserves.map(item => item.claim.requestKey)).size, 1);
  assert.equal(new Set(reserves.map(item => item.claim.scopeHash)).size, 1);
  assert.ok(reserves.filter(item => item.outcome === 'existing').every(item => item.ownerToken === null));
  const winner = reserves.find(item => item.outcome === 'created');
  const registry = openClaimRegistry(path);
  try {
    const base = {requestId: 'synthetic-req-concurrent', scope: SCOPE};
    assert.equal(registry.recordDispatchIntent({...base, ownerToken: winner.ownerToken}).dispatchAuthorized, true);
    assert.throws(() => registry.recordDispatchIntent({...base, ownerToken: winner.ownerToken}), code('INVALID_TRANSITION'));
  } finally { registry.close(); }
}));

test('concurrent reservations with mismatched scopes bind only the winning scope', withStore(async ({path}) => {
  const startAt = Date.now() + 1500;
  const scopes = [SCOPE, SCOPE, SCOPE, OTHER_SCOPE, OTHER_SCOPE, OTHER_SCOPE];
  const results = await Promise.all(scopes.map(scope =>
    runChild({db: path, mode: 'reserve', requestId: 'synthetic-req-race', scope, startAt})));
  const outcomes = results.map(lines => lines[0]);
  const created = outcomes.findIndex(item => item.outcome === 'created');
  assert.ok(created >= 0);
  assert.equal(outcomes.filter(item => item.outcome === 'created').length, 1);
  const winningScope = scopes[created];
  outcomes.forEach((item, index) => {
    if (index === created) return;
    if (scopes[index] === winningScope) assert.equal(item.outcome, 'existing');
    else assert.equal(item.error, 'SCOPE_MISMATCH');
  });
  const registry = openClaimRegistry(path);
  try {
    const found = registry.inspect({requestId: 'synthetic-req-race', scope: winningScope});
    assert.equal(found.claim.scopeHash, scopeHashOf(winningScope));
  } finally { registry.close(); }
}));

test('same request and scope replays without a second dispatch; changed scope fails closed', withStore(({path}) => {
  const registry = openClaimRegistry(path);
  try {
    const base = {requestId: 'synthetic-req-scope', scope: SCOPE};
    const first = registry.reserve(base);
    assert.equal(first.outcome, 'created');
    const reordered = Object.fromEntries(Object.entries(SCOPE).reverse());
    const replay = registry.reserve({...base, scope: reordered});
    assert.equal(replay.outcome, 'existing');
    assert.equal(replay.dispatchAuthorized, false);
    assert.equal(replay.ownerToken, undefined);
    for (const changed of [OTHER_SCOPE, {...SCOPE, protectionCases: 'f'.repeat(64)}, {...SCOPE, deadlineMs: 5001}]) {
      assert.throws(() => registry.reserve({...base, scope: changed}), code('SCOPE_MISMATCH'));
      assert.throws(() => registry.inspect({...base, scope: changed}), code('SCOPE_MISMATCH'));
    }
    const kept = registry.inspect(base);
    assert.equal(kept.claim.scopeHash, scopeHashOf(SCOPE));
    assert.equal(kept.claim.state, 'claimed');
    assert.equal(kept.claim.generation, 1);
  } finally { registry.close(); }
}));

test('completed replay returns existing result and cannot dispatch again', withStore(({path}) => {
  const registry = openClaimRegistry(path);
  try {
    const base = {requestId: 'synthetic-req-replay', scope: SCOPE};
    const {ownerToken, nonce} = completeInProcess(registry, base.requestId);
    let dispatches = 1;
    for (let round = 0; round < 3; round++) {
      const replay = registry.reserve(base);
      assert.equal(replay.outcome, 'existing');
      assert.equal(replay.dispatchAuthorized, false);
      assert.equal(replay.claim.state, 'completed');
      assert.equal(replay.claim.resultHash, HOST_DONE.resultHash);
      assert.equal(replay.claim.nonce, nonce);
      assert.equal(replay.recovery.resolution, 'complete');
      assert.equal(replay.recovery.redispatchAllowed, false);
      try { registry.recordDispatchIntent({...base, ownerToken}); dispatches++; }
      catch (error) { assert.ok(code('INVALID_TRANSITION')(error)); }
    }
    assert.equal(dispatches, 1);
    // Monotonic: no step can move a completed claim backwards or sideways.
    assert.throws(() => registry.recordWorkerIdentity({...base, ownerToken, nonce, birthIdentity: BIRTH}), code('INVALID_TRANSITION'));
    assert.throws(() => registry.recordHostCompletion({...base, ownerToken, hostEvidence: HOST_DONE}), code('INVALID_TRANSITION'));
    assert.throws(() => registry.hostContinuePreDispatch({...base, hostDecision: CONTINUE}), code('RECOVERY_REQUIRES_EXTERNAL_PROOF'));
  } finally { registry.close(); }
}));

const CRASH_POINTS = [
  ['reserve:before-commit', null],
  ['reserve:after-commit', 'claimed'],
  ['dispatch:before-commit', 'claimed'],
  ['dispatch:after-commit', 'dispatch-intent'],
  ['worker:before-commit', 'dispatch-intent'],
  ['worker:after-commit', 'worker-recorded'],
  ['complete:before-commit', 'worker-recorded'],
  ['complete:after-commit', 'completed'],
];

for (const [crashAt, expected] of CRASH_POINTS) {
  test(`process killed at ${crashAt} restarts as ${expected ?? 'absent'} without redispatch`, withStore(({path}) => {
    const requestId = 'synthetic-req-crash';
    const lines = runChildSync({db: path, mode: 'sequence', requestId, scope: SCOPE, crashAt, birth: BIRTH, hostEvidence: HOST_DONE});
    assert.deepEqual(lines.at(-1), {crashedAt: crashAt});
    // The simulated dispatch line only appears after the intent is durable and
    // returned; a crash at dispatch:after-commit leaves dispatch unknown.
    const dispatchedLines = lines.filter(line => line.step === 'dispatched').length;
    assert.ok(dispatchedLines <= 1);
    const registry = openClaimRegistry(path);
    try {
      const base = {requestId, scope: SCOPE};
      const found = registry.inspect(base);
      if (expected === null) {
        assert.equal(found.found, false);
        assert.equal(registry.reserve(base).outcome, 'created');
        return;
      }
      assert.equal(found.claim.state, expected);
      assert.equal(found.recovery.redispatchAllowed, false);
      assert.equal(found.recovery.automaticAction, 'none');
      const replay = registry.reserve(base);
      assert.equal(replay.outcome, 'existing');
      assert.equal(replay.dispatchAuthorized, false);
      if (expected === 'completed') {
        assert.equal(found.recovery.resolution, 'complete');
        assert.equal(found.claim.resultHash, HOST_DONE.resultHash);
        return;
      }
      assert.equal(found.recovery.resolution, 'unresolved');
      if (expected === 'claimed') {
        assert.equal(found.recovery.hold, 'pre-dispatch');
        assert.throws(() => registry.recordDispatchIntent({...base, ownerToken: freshToken()}), code('OWNER_MISMATCH'));
        assert.throws(() => registry.hostContinuePreDispatch({...base, hostDecision: {authority: 'host'}}), code('HOST_AUTHORITY_REQUIRED'));
        assert.throws(() => registry.hostContinuePreDispatch(base), code('HOST_AUTHORITY_REQUIRED'));
        const resumed = registry.hostContinuePreDispatch({...base, hostDecision: CONTINUE});
        assert.equal(resumed.dispatchAuthorized, false);
        assert.equal(resumed.claim.generation, 2);
        assert.throws(() => registry.hostContinuePreDispatch({...base, hostDecision: CONTINUE}), code('STALE_DECISION'));
        assert.equal(registry.inspect(base).claim.generation, 2);
        assert.equal(registry.inspect(base).claim.state, 'claimed');
      } else {
        assert.throws(() => registry.recordDispatchIntent({...base, ownerToken: freshToken()}), code('INVALID_TRANSITION'));
        assert.throws(() => registry.hostContinuePreDispatch({...base, hostDecision: CONTINUE}), code('RECOVERY_REQUIRES_EXTERNAL_PROOF'));
        assert.equal(registry.inspect(base).claim.state, expected);
      }
    } finally { registry.close(); }
  }));
}

test('host continue fences the previous owner generation across a reopen', withStore(({path}) => {
  const base = {requestId: 'synthetic-req-fence', scope: SCOPE};
  let registry = openClaimRegistry(path);
  const {ownerToken: staleToken} = registry.reserve(base);
  registry.close();
  registry = openClaimRegistry(path);
  try {
    const {ownerToken} = registry.hostContinuePreDispatch({...base, hostDecision: CONTINUE});
    assert.throws(() => registry.recordDispatchIntent({...base, ownerToken: staleToken}), code('OWNER_MISMATCH'));
    assert.equal(registry.recordDispatchIntent({...base, ownerToken}).dispatchAuthorized, true);
    assert.throws(() => registry.recordDispatchIntent({...base, ownerToken}), code('INVALID_TRANSITION'));
  } finally { registry.close(); }
}));

test('worker identity requires the dispatch nonce and a non-PID birth component', withStore(({path}) => {
  const registry = openClaimRegistry(path);
  try {
    const base = {requestId: 'synthetic-req-identity', scope: SCOPE};
    const {ownerToken} = registry.reserve(base);
    const {nonce} = registry.recordDispatchIntent({...base, ownerToken});
    assert.throws(() => registry.recordWorkerIdentity({...base, ownerToken, nonce, birthIdentity: {pid: 4242}}), code('INSUFFICIENT_IDENTITY'));
    assert.throws(() => registry.recordWorkerIdentity({...base, ownerToken, nonce, birthIdentity: {pid: 4242, creationTime: BIRTH.creationTime}}), code('INSUFFICIENT_IDENTITY'));
    assert.throws(() => registry.recordWorkerIdentity({...base, ownerToken, nonce, birthIdentity: {pid: 4242, bootId: BIRTH.bootId}}), code('INSUFFICIENT_IDENTITY'));
    assert.throws(() => registry.recordWorkerIdentity({...base, ownerToken, nonce, birthIdentity: {...BIRTH, bootId: ''}}), code('INVALID_INPUT'));
    assert.throws(() => registry.recordWorkerIdentity({...base, ownerToken, nonce, birthIdentity: {...BIRTH, pid: '4242'}}), code('INVALID_INPUT'));
    assert.throws(() => registry.recordWorkerIdentity({...base, ownerToken, nonce, birthIdentity: {...BIRTH, env: 'X=1'}}), code('INVALID_INPUT'));
    const otherNonce = nonce.replace(/^./, nonce[0] === 'a' ? 'b' : 'a');
    assert.throws(() => registry.recordWorkerIdentity({...base, ownerToken, nonce: otherNonce, birthIdentity: BIRTH}), code('NONCE_MISMATCH'));
    assert.throws(() => registry.recordWorkerIdentity({...base, ownerToken: freshToken(), nonce, birthIdentity: BIRTH}), code('OWNER_MISMATCH'));
    assert.equal(registry.inspect(base).claim.state, 'dispatch-intent');
    registry.recordWorkerIdentity({...base, ownerToken, nonce, birthIdentity: BIRTH});
    assert.throws(() => registry.recordWorkerIdentity({...base, ownerToken, nonce, birthIdentity: BIRTH}), code('INVALID_TRANSITION'));

    const assess = observedBirthIdentity => registry.assessWorkerIdentity({...base, observedBirthIdentity});
    const stale = assess({...BIRTH, creationTime: 'synthetic-creation-0002'});
    assert.equal(stale.verdict, 'mismatch');
    const rebooted = assess({...BIRTH, bootId: 'synthetic-boot-0002'});
    assert.equal(rebooted.verdict, 'mismatch');
    const wrong = assess({...BIRTH, pid: 9999});
    assert.equal(wrong.verdict, 'mismatch');
    const pidOnly = assess({pid: BIRTH.pid});
    assert.equal(pidOnly.verdict, 'insufficient-identity');
    // The shape that used to compare differently: same pid and creation time
    // without bootId is now insufficient, never a mismatch or a match.
    const noBoot = assess({pid: BIRTH.pid, creationTime: BIRTH.creationTime});
    assert.equal(noBoot.verdict, 'insufficient-identity');
    const extra = assess({...BIRTH, parentPid: 1});
    assert.equal(extra.verdict, 'invalid-identity');
    const same = assess(BIRTH);
    assert.equal(same.verdict, 'matches-recorded');
    const reordered = assess({bootId: BIRTH.bootId, creationTime: BIRTH.creationTime, pid: BIRTH.pid});
    assert.equal(reordered.verdict, 'matches-recorded');
    for (const result of [stale, rebooted, wrong, pidOnly, noBoot, extra, same, reordered]) {
      assert.equal(result.osProcessProof, 'not-established');
      assert.equal(result.workerDeathInferred, false);
      assert.equal(result.redispatchAllowed, false);
    }
    const recovery = registry.inspect(base).recovery;
    assert.equal(recovery.resolution, 'unresolved');
    assert.equal(recovery.hold, 'worker-liveness-unknown');

    // A second request cannot claim the same recorded worker identity.
    const second = {requestId: 'synthetic-req-identity-2', scope: SCOPE};
    const owner2 = registry.reserve(second).ownerToken;
    const intent2 = registry.recordDispatchIntent({...second, ownerToken: owner2});
    assert.throws(() => registry.recordWorkerIdentity({...second, ownerToken: owner2, nonce: intent2.nonce, birthIdentity: BIRTH}), code('IDENTITY_CONFLICT'));
  } finally { registry.close(); }
}));

test('host completion requires exact host evidence', withStore(({path}) => {
  const registry = openClaimRegistry(path);
  try {
    const base = {requestId: 'synthetic-req-host', scope: SCOPE};
    const {ownerToken} = registry.reserve(base);
    const {nonce} = registry.recordDispatchIntent({...base, ownerToken});
    registry.recordWorkerIdentity({...base, ownerToken, nonce, birthIdentity: BIRTH});
    for (const hostEvidence of [undefined, {...HOST_DONE, cleanup: 'unknown'}, {...HOST_DONE, inference: 'unknown'},
      {...HOST_DONE, authority: 'worker'}, {...HOST_DONE, resultHash: 'nothex'}, {...HOST_DONE, extra: true}]) {
      assert.throws(() => registry.recordHostCompletion({...base, ownerToken, hostEvidence}), code('HOST_AUTHORITY_REQUIRED'));
    }
    assert.equal(registry.inspect(base).claim.state, 'worker-recorded');
  } finally { registry.close(); }
}));

test('a corrupted unrelated row fails closed for every request', withStore(({path}) => {
  const registry = openClaimRegistry(path);
  try {
    registry.reserve({requestId: 'synthetic-req-a', scope: SCOPE});
    registry.reserve({requestId: 'synthetic-req-b', scope: SCOPE});
    raw(path, db => db.prepare('UPDATE claims SET scope_hash = ? WHERE request_key = ?')
      .run('0'.repeat(64), requestKeyOf('synthetic-req-b')));
    assert.throws(() => registry.inspect({requestId: 'synthetic-req-a', scope: SCOPE}), code('STORE_CORRUPT'));
    assert.throws(() => registry.reserve({requestId: 'synthetic-req-c', scope: SCOPE}), code('STORE_CORRUPT'));
  } finally { registry.close(); }
  assert.throws(() => openClaimRegistry(path), code('STORE_CORRUPT'));
}));

test('request-key corruption cannot make an existing claim look absent', withStore(({path}) => {
  const seed = openClaimRegistry(path);
  seed.reserve({requestId: 'synthetic-req-a', scope: SCOPE});
  seed.reserve({requestId: 'synthetic-req-b', scope: SCOPE});
  seed.close();
  const moveKey = db => db.prepare('UPDATE claims SET request_key = ? WHERE request_key = ?')
    .run(requestKeyOf('synthetic-req-moved'), requestKeyOf('synthetic-req-a'));
  // Key changed without resealing: the row digest no longer matches.
  raw(path, moveKey);
  assert.throws(() => openClaimRegistry(path), code('STORE_CORRUPT'));
  // Key changed and the row digest resealed, but not the store aggregate.
  raw(path, db => reseal(db, {rowsOnly: true}));
  assert.throws(() => openClaimRegistry(path), code('STORE_CORRUPT'));
}));

test('duplicated dispatch nonce across rows fails closed even when resealed', withStore(({path}) => {
  const seed = openClaimRegistry(path);
  const a = {requestId: 'synthetic-req-a', scope: SCOPE};
  const b = {requestId: 'synthetic-req-b', scope: SCOPE};
  const nonceA = seed.recordDispatchIntent({...a, ownerToken: seed.reserve(a).ownerToken}).nonce;
  seed.recordDispatchIntent({...b, ownerToken: seed.reserve(b).ownerToken});
  seed.close();
  raw(path, db => {
    db.prepare('UPDATE claims SET nonce = ? WHERE request_key = ?').run(nonceA, requestKeyOf('synthetic-req-b'));
    reseal(db);
  });
  assert.throws(() => openClaimRegistry(path), code('STORE_CORRUPT'));
}));

test('known limit: a consistent rewrite with recomputed unkeyed checksums is not detected', withStore(({path}) => {
  const seed = openClaimRegistry(path);
  seed.reserve({requestId: 'synthetic-req-a', scope: SCOPE});
  seed.close();
  raw(path, db => {
    db.prepare('UPDATE claims SET request_key = ? WHERE request_key = ?')
      .run(requestKeyOf('synthetic-req-moved'), requestKeyOf('synthetic-req-a'));
    reseal(db);
  });
  const registry = openClaimRegistry(path);
  try {
    // This is the documented gap: the registry cannot tell a forged consistent
    // store from a genuine one, so the original request reads as absent.
    assert.equal(registry.inspect({requestId: 'synthetic-req-a', scope: SCOPE}).found, false);
  } finally { registry.close(); }
  assert.ok(TRUST_LIMITS.some(text => /unkeyed/i.test(text) && /no tamper protection/i.test(text)));
  assert.ok(TRUST_LIMITS.some(text => /rollback is not detected/i.test(text)));
}));

test('schema objects, meta rows and bounds are validated', withStore(({path}) => {
  raw(path, db => db.exec("CREATE TRIGGER synthetic_t AFTER INSERT ON claims BEGIN SELECT 1; END"));
  assert.throws(() => openClaimRegistry(path), code('STORE_CORRUPT'));
  raw(path, db => db.exec('DROP TRIGGER synthetic_t'));
  openClaimRegistry(path).close();
  raw(path, db => db.prepare("INSERT INTO meta (key, value) VALUES ('extra', 'x')").run());
  assert.throws(() => openClaimRegistry(path), code('STORE_CORRUPT'));
  raw(path, db => db.prepare("DELETE FROM meta WHERE key = 'extra'").run());
  const small = openClaimRegistry(path, {maxRows: 2});
  try {
    small.reserve({requestId: 'synthetic-req-1', scope: SCOPE});
    small.reserve({requestId: 'synthetic-req-2', scope: SCOPE});
    assert.throws(() => small.reserve({requestId: 'synthetic-req-3', scope: SCOPE}), code('STORE_FULL'));
    assert.equal(small.reserve({requestId: 'synthetic-req-1', scope: SCOPE}).outcome, 'existing');
  } finally { small.close(); }
  assert.throws(() => openClaimRegistry(path, {maxRows: 1}), code('STORE_CORRUPT'));
}));

test('storage failures fail closed', withStore(({dir, path}) => {
  assert.throws(() => openClaimRegistry(join(dir, 'missing-dir', 'claims.sqlite')), code('STORE_UNAVAILABLE'));
  assert.throws(() => openClaimRegistry(join(dir, 'missing-dir', 'claims.sqlite'), {initialize: true}), code('STORE_UNAVAILABLE'));
  assert.throws(() => openClaimRegistry(join(dir, 'absent.sqlite')), code('STORE_UNAVAILABLE'));
  assert.throws(() => openClaimRegistry(dir), error => error instanceof ClaimRegistryError);

  const empty = join(dir, 'empty.sqlite');
  writeFileSync(empty, '');
  assert.throws(() => openClaimRegistry(empty), code('STORE_UNINITIALIZED'));

  const garbage = join(dir, 'garbage.sqlite');
  writeFileSync(garbage, randomBytes(8192));
  assert.throws(() => openClaimRegistry(garbage), error => error instanceof ClaimRegistryError &&
    ['STORE_CORRUPT', 'STORE_UNAVAILABLE'].includes(error.code));

  const seed = openClaimRegistry(path);
  for (let index = 0; index < 40; index++) seed.reserve({requestId: `synthetic-req-${index}`, scope: SCOPE});
  seed.close();
  const truncated = join(dir, 'truncated.sqlite');
  writeFileSync(truncated, readFileSync(path));
  truncateSync(truncated, Math.floor(statSync(truncated).size / 2));
  assert.throws(() => openClaimRegistry(truncated), error => error instanceof ClaimRegistryError);

  const registry = openClaimRegistry(path, {busyTimeoutMs: 50});
  const holder = new DatabaseSync(path);
  try {
    holder.exec('BEGIN EXCLUSIVE');
    assert.throws(() => registry.inspect({requestId: 'synthetic-req-1', scope: SCOPE}), code('STORE_BUSY'));
    assert.throws(() => registry.reserve({requestId: 'synthetic-req-new', scope: SCOPE}), code('STORE_BUSY'));
    assert.throws(() => openClaimRegistry(path, {busyTimeoutMs: 50}), code('STORE_BUSY'));
    holder.exec('ROLLBACK');
    assert.equal(registry.inspect({requestId: 'synthetic-req-new', scope: SCOPE}).found, false);
  } finally { holder.close(); registry.close(); }
  assert.throws(() => registry.inspect({requestId: 'synthetic-req-1', scope: SCOPE}), code('REGISTRY_CLOSED'));

  for (const options of [{maxRows: 0}, {busyTimeoutMs: -1}, {initialize: 'yes'}, {unknown: 1}, {testFaultHook: 1}]) {
    assert.throws(() => openClaimRegistry(path, options), code('INVALID_OPTIONS'));
  }
  assert.throws(() => openClaimRegistry(':memory:'), code('INVALID_OPTIONS'));
}));

test('inputs are validated before touching the store', withStore(({path}) => {
  const registry = openClaimRegistry(path);
  try {
    const deep = {};
    let cursor = deep;
    for (let depth = 0; depth < 40; depth++) { cursor.next = {}; cursor = cursor.next; }
    const getter = {};
    Object.defineProperty(getter, 'value', {enumerable: true, get: () => 1});
    for (const requestId of ['', ' synthetic', 'a b', 'x'.repeat(200), 7, undefined]) {
      assert.throws(() => registry.reserve({requestId, scope: SCOPE}), code('INVALID_INPUT'));
    }
    for (const scope of [[], null, 'scope', {fn() {}}, {n: Number.NaN}, {big: 1n}, deep, getter, new Map(), {sparse: [1, , 3]}]) {
      assert.throws(() => registry.reserve({requestId: 'synthetic-req-input', scope}), code('INVALID_INPUT'));
    }
    assert.throws(() => registry.recordDispatchIntent({requestId: 'synthetic-req-input', scope: SCOPE, ownerToken: 'short'}), code('INVALID_INPUT'));
    assert.equal(registry.inspect({requestId: 'synthetic-req-input', scope: SCOPE}).found, false);
  } finally { registry.close(); }
}));

test('persisted bytes and errors stay privacy-safe', withStore(({dir, path}) => {
  const marker = 'SYNTHETICMARKER7f3a';
  const requestId = `synthetic-${marker}`;
  const scope = {...SCOPE, instruction: `do not persist ${marker}`};
  const birth = {pid: 31337, creationTime: `creation-${marker}`, bootId: `boot-${marker}`};
  const registry = openClaimRegistry(path);
  const errors = [];
  let ownerToken;
  try {
    ownerToken = registry.reserve({requestId, scope}).ownerToken;
    const {nonce} = registry.recordDispatchIntent({requestId, scope, ownerToken});
    registry.recordWorkerIdentity({requestId, scope, ownerToken, nonce, birthIdentity: birth});
    try { registry.reserve({requestId, scope: {...scope, instruction: `changed ${marker}`}}); } catch (error) { errors.push(error); }
    try { registry.recordWorkerIdentity({requestId, scope, ownerToken, nonce, birthIdentity: birth}); } catch (error) { errors.push(error); }
  } finally { registry.close(); }
  const bytes = readFileSync(path);
  for (const secret of [marker, ownerToken, birth.creationTime, birth.bootId]) {
    assert.equal(bytes.includes(Buffer.from(secret, 'utf8')), false);
  }
  const markerDir = join(dir, `${marker}-missing`);
  try { openClaimRegistry(join(markerDir, 'claims.sqlite')); } catch (error) { errors.push(error); }
  assert.equal(errors.length, 3);
  for (const error of errors) {
    assert.ok(error instanceof ClaimRegistryError);
    assert.equal(error.cause, undefined);
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(error))).sort(), ['code', 'message', 'name']);
    for (const text of [error.message, String(error.stack), JSON.stringify(error)]) {
      assert.equal(text.includes(marker), false);
      assert.equal(text.includes(ownerToken), false);
      assert.equal(text.includes(dir), false);
    }
  }
}));

test('competing continuation decisions for one generation: at most one rotates ownership', withStore(async ({path}) => {
  const base = {requestId: 'synthetic-req-continue-race', scope: SCOPE};
  const seed = openClaimRegistry(path);
  const {ownerToken: originalToken} = seed.reserve(base);
  seed.close();
  const startAt = Date.now() + 1500;
  const results = await Promise.all(Array.from({length: 6}, () =>
    runChild({db: path, mode: 'continue', ...base, hostDecision: CONTINUE, startAt})));
  const outcomes = results.map(lines => lines[0]);
  assert.ok(outcomes.every(Boolean), 'every child must report an outcome');
  const winners = outcomes.filter(item => item.step === 'continue');
  assert.equal(winners.length, 1);
  assert.equal(winners[0].generation, 2);
  assert.equal(winners[0].dispatchAuthorized, false);
  assert.deepEqual(outcomes.filter(item => item.step !== 'continue').map(item => item.error),
    Array(5).fill('STALE_DECISION'));
  const registry = openClaimRegistry(path);
  try {
    const found = registry.inspect(base);
    assert.equal(found.claim.state, 'claimed');
    assert.equal(found.claim.generation, 2);
    assert.throws(() => registry.recordDispatchIntent({...base, ownerToken: originalToken}), code('OWNER_MISMATCH'));
    assert.throws(() => registry.hostContinuePreDispatch({...base, hostDecision: CONTINUE}), code('STALE_DECISION'));
    for (const observedGeneration of [0, 3, 1.5, '2', -1]) {
      const hostDecision = {...CONTINUE, observedGeneration};
      assert.throws(() => registry.hostContinuePreDispatch({...base, hostDecision}),
        error => error instanceof ClaimRegistryError && ['HOST_AUTHORITY_REQUIRED', 'STALE_DECISION'].includes(error.code));
    }
    const missing = {authority: 'host', decision: 'continue-pre-dispatch'};
    assert.throws(() => registry.hostContinuePreDispatch({...base, hostDecision: missing}), code('HOST_AUTHORITY_REQUIRED'));
    assert.equal(registry.inspect(base).claim.generation, 2);
    const next = registry.hostContinuePreDispatch({...base, hostDecision: {...CONTINUE, observedGeneration: 2}});
    assert.equal(next.claim.generation, 3);
    assert.equal(registry.recordDispatchIntent({...base, ownerToken: next.ownerToken}).dispatchAuthorized, true);
  } finally { registry.close(); }
}));

test('noncanonical scope shapes are rejected instead of silently replaying', withStore(({path}) => {
  const registry = openClaimRegistry(path);
  const marker = 'GETTERMARKER91c2';
  const calls = {count: 0};
  const hostile = () => { calls.count++; throw new Error(`leak ${marker}`); };
  const traps = {count: 0};
  const handler = Object.fromEntries(['get', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'defineProperty',
    'set', 'deleteProperty', 'isExtensible', 'preventExtensions', 'setPrototypeOf']
    .map(name => [name, () => { traps.count++; throw new Error(`trap ${marker}`); }]));
  try {
    const base = {requestId: 'synthetic-req-shape', scope: {...SCOPE, list: ['a', 'b'], nested: {inner: ['x']}}};
    assert.equal(registry.reserve(base).outcome, 'created');
    const withList = list => ({...base.scope, list});
    const withInner = inner => ({...base.scope, nested: {inner}});

    const extraTop = ['a', 'b']; extraTop.extra = 'changed';
    const extraNested = ['x']; extraNested.changed = true;
    const accessorElement = ['a', 'b']; Object.defineProperty(accessorElement, 1, {enumerable: true, get: hostile});
    const nestedAccessor = ['x']; Object.defineProperty(nestedAccessor, 0, {enumerable: true, get: hostile});
    const hiddenElement = ['a', 'b']; Object.defineProperty(hiddenElement, 1, {value: 'b', enumerable: false});
    const symbolArray = ['a', 'b']; symbolArray[Symbol('s')] = 1;
    class SubArray extends Array {}
    const subclassed = SubArray.from(['a', 'b']);
    const hiddenProp = {...base.scope}; Object.defineProperty(hiddenProp, 'hidden', {value: 1, enumerable: false});
    const symbolProp = {...base.scope, [Symbol('s')]: 1};
    const getterProp = {...base.scope}; Object.defineProperty(getterProp, 'late', {enumerable: true, get: hostile});
    const {proxy: revoked, revoke} = Proxy.revocable({}, {});
    revoke();
    const shapes = [
      withList(extraTop), withInner(extraNested), withList(accessorElement), withInner(nestedAccessor),
      withList(hiddenElement), withList(symbolArray), withList(subclassed), withList(['a', , 'b']),
      withList(new Proxy(['a', 'b'], handler)), withInner(new Proxy(['x'], handler)), new Proxy(base.scope, handler),
      withList(revoked), hiddenProp, symbolProp, getterProp, {...base.scope, n: -0}, {...base.scope, when: new Date(0)},
      {...base.scope, list: Object.create(Array.prototype)}, {...base.scope, re: /x/}, {...base.scope, buf: Buffer.from('ab')},
    ];
    for (const scope of shapes) {
      let caught;
      try { registry.reserve({requestId: base.requestId, scope}); } catch (error) { caught = error; }
      assert.ok(caught instanceof ClaimRegistryError, 'shape must be rejected');
      assert.equal(caught.code, 'INVALID_INPUT');
      for (const text of [caught.message, String(caught.stack), JSON.stringify(caught)]) assert.equal(text.includes(marker), false);
    }
    // Getters and traps on argument records and host objects are never run.
    const getterArgs = {requestId: base.requestId};
    Object.defineProperty(getterArgs, 'scope', {enumerable: true, get: hostile});
    assert.throws(() => registry.reserve(getterArgs), code('INVALID_INPUT'));
    assert.throws(() => registry.reserve(new Proxy(base, handler)), code('INVALID_INPUT'));
    const getterDecision = {authority: 'host', decision: 'continue-pre-dispatch'};
    Object.defineProperty(getterDecision, 'observedGeneration', {enumerable: true, get: hostile});
    assert.throws(() => registry.hostContinuePreDispatch({...base, hostDecision: getterDecision}), code('HOST_AUTHORITY_REQUIRED'));
    const getterBirth = {pid: 1, bootId: 'b'};
    Object.defineProperty(getterBirth, 'creationTime', {enumerable: true, get: hostile});
    assert.equal(registry.assessWorkerIdentity({...base, observedBirthIdentity: getterBirth}).verdict, 'invalid-identity');
    assert.equal(calls.count, 0);
    assert.equal(traps.count, 0);
    const kept = registry.inspect(base);
    assert.equal(kept.claim.scopeHash, scopeHashOf(base.scope));
    assert.equal(kept.claim.generation, 1);
    // Plain equivalent data with a different key order still replays.
    const reordered = {nested: {inner: ['x']}, list: ['a', 'b'], ...SCOPE};
    assert.equal(registry.reserve({requestId: base.requestId, scope: reordered}).outcome, 'existing');
    assert.throws(() => registry.reserve({requestId: base.requestId, scope: withList(['a', 'b', 'c'])}), code('SCOPE_MISMATCH'));
  } finally { registry.close(); }
}));

test('integrity_check rejects an index entry that disagrees with its table row', withStore(({path, t}) => {
  const base = {requestId: 'synthetic-req-index', scope: SCOPE};
  const seed = openClaimRegistry(path);
  seed.reserve(base);
  seed.close();
  // File-format assumption: TEXT columns are stored as raw UTF-8 and adjacent
  // in the record body. The table record holds request_key followed directly
  // by scope_hash; the autoindex record holds request_key followed by the
  // rowid. Only copies not followed by scope_hash are edited, one hex digit
  // each, so lengths and record headers stay unchanged.
  const key = Buffer.from(requestKeyOf(base.requestId), 'utf8');
  const scopeHash = Buffer.from(scopeHashOf(SCOPE), 'utf8');
  const bytes = readFileSync(path);
  let tableCopies = 0;
  let edited = 0;
  for (let at = bytes.indexOf(key); at !== -1; at = bytes.indexOf(key, at + 1)) {
    const after = bytes.subarray(at + key.length, at + key.length + scopeHash.length);
    if (after.equals(scopeHash)) { tableCopies++; continue; }
    bytes[at] = bytes[at] === 0x30 ? 0x31 : 0x30;
    edited++;
  }
  if (tableCopies !== 1 || edited < 1) {
    t.skip(`portability limitation: fixture layout not found (table copies ${tableCopies}, index copies ${edited}); index coverage not demonstrated`);
    return;
  }
  writeFileSync(path, bytes);
  const pragma = (db, name) => Object.values(db.prepare(`PRAGMA ${name}`).all()[0])[0];
  const {quick, integrity, rowSealed, aggregateSealed} = raw(path, db => {
    const rows = db.prepare('SELECT * FROM claims').all().map(row => ({...row}));
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map(entry => [entry.key, entry.value]));
    return {
      quick: pragma(db, 'quick_check(1)'),
      integrity: pragma(db, 'integrity_check(1)'),
      rowSealed: rows.length === 1 && rows[0].request_key === key.toString('utf8') && _testing.rowDigest(rows[0]) === rows[0].row_digest,
      aggregateSealed: meta.row_count === '1' && _testing.aggregateDigest(rows) === meta.aggregate,
    };
  });
  // The table rows, row digests and aggregate are all still consistent, so
  // only an index-versus-table check can see this corruption.
  assert.equal(rowSealed, true);
  assert.equal(aggregateSealed, true);
  assert.notEqual(integrity, 'ok');
  if (quick === 'ok') {
    t.diagnostic('quick_check reported ok and integrity_check reported an error: the distinction is demonstrated');
  } else {
    t.diagnostic('portability limitation: quick_check also flagged this edit here, so the quick_check versus integrity_check distinction is not demonstrated on this platform');
  }
  assert.throws(() => openClaimRegistry(path), code('STORE_CORRUPT'));
}));

test('only the rollback journal is accepted and a WAL store is never converted', withStore(({path}) => {
  const seed = openClaimRegistry(path);
  seed.reserve({requestId: 'synthetic-req-journal', scope: SCOPE});
  seed.close();
  const mode = () => raw(path, db => String(Object.values(db.prepare('PRAGMA journal_mode').all()[0])[0]).toLowerCase());
  assert.equal(mode(), 'delete');
  raw(path, db => db.exec('PRAGMA journal_mode=WAL'));
  assert.equal(mode(), 'wal');
  assert.throws(() => openClaimRegistry(path), code('STORE_UNSUPPORTED'));
  assert.equal(mode(), 'wal', 'a failed open must not convert the store');
  raw(path, db => db.exec('PRAGMA journal_mode=DELETE'));
  assert.equal(mode(), 'delete');

  // A switch made by another connection while the registry is open is seen
  // inside the next transaction, before any decision is made.
  const registry = openClaimRegistry(path);
  const switcher = new DatabaseSync(path);
  try {
    switcher.exec('PRAGMA journal_mode=WAL');
    assert.throws(() => registry.reserve({requestId: 'synthetic-req-after-switch', scope: SCOPE}), code('STORE_UNSUPPORTED'));
    assert.throws(() => registry.inspect({requestId: 'synthetic-req-journal', scope: SCOPE}), code('STORE_UNSUPPORTED'));
    const count = switcher.prepare('SELECT count(*) AS n FROM claims').get().n;
    assert.equal(Number(count), 1);
  } finally { registry.close(); switcher.close(); }
  raw(path, db => db.exec('PRAGMA journal_mode=DELETE'));
  const reopened = openClaimRegistry(path);
  try { assert.equal(reopened.inspect({requestId: 'synthetic-req-after-switch', scope: SCOPE}).found, false); }
  finally { reopened.close(); }
}));

test('a store larger than maxPages, or one that grows past it, fails closed', withStore(({path}) => {
  const seed = openClaimRegistry(path);
  for (let index = 0; index < 300; index++) seed.reserve({requestId: `synthetic-pages-${index}`, scope: SCOPE});
  seed.close();
  const pageCount = () => raw(path, db => Number(Object.values(db.prepare('PRAGMA page_count').all()[0])[0]));
  const pages = pageCount();
  assert.ok(pages > 16, 'fixture must exceed the smallest page bound');
  assert.throws(() => openClaimRegistry(path, {maxPages: 16}), code('STORE_FULL'));
  assert.throws(() => openClaimRegistry(path, {maxPages: pages - 1}), code('STORE_FULL'));
  assert.equal(pageCount(), pages);

  // Opens at exactly its size; another connection then grows the file past
  // the bound and the next transaction refuses before reading claims.
  const registry = openClaimRegistry(path, {maxPages: pages + 2});
  try {
    assert.equal(registry.inspect({requestId: 'synthetic-pages-0', scope: SCOPE}).found, true);
    raw(path, db => { db.exec('CREATE TABLE pad (b BLOB)'); db.prepare('INSERT INTO pad (b) VALUES (?)').run(Buffer.alloc(65536)); });
    assert.ok(pageCount() > pages + 2);
    assert.throws(() => registry.inspect({requestId: 'synthetic-pages-0', scope: SCOPE}), code('STORE_FULL'));
    assert.throws(() => registry.reserve({requestId: 'synthetic-pages-new', scope: SCOPE}), code('STORE_FULL'));
  } finally { registry.close(); }
  raw(path, db => { db.exec('DROP TABLE pad'); db.exec('VACUUM'); });

  // Growth by the registry itself stops at the bound without a partial write.
  const atSize = pageCount();
  const bounded = openClaimRegistry(path, {maxPages: atSize});
  let created = 0;
  let full = false;
  try {
    for (let index = 0; index < 1000 && !full; index++) {
      try { bounded.reserve({requestId: `synthetic-pages-grow-${index}`, scope: SCOPE}); created++; }
      catch (error) { assert.ok(code('STORE_FULL')(error)); full = true; }
    }
  } finally { bounded.close(); }
  assert.equal(full, true);
  assert.ok(pageCount() <= atSize);
  const check = openClaimRegistry(path);
  try {
    assert.equal(check.inspect({requestId: `synthetic-pages-grow-${created}`, scope: SCOPE}).found, false);
    if (created > 0) assert.equal(check.inspect({requestId: `synthetic-pages-grow-${created - 1}`, scope: SCOPE}).found, true);
  } finally { check.close(); }
}));

test('default capacity of 1024 claims is reachable and the next reservation fails closed', withStore(({path}) => {
  const scopeHash = scopeHashOf(SCOPE);
  raw(path, db => {
    const rows = [];
    const insert = db.prepare('INSERT INTO claims (request_key, scope_hash, state, generation, owner_hash, nonce, worker_hash, result_hash, row_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 1023; index++) {
      const row = {request_key: requestKeyOf(`synthetic-cap-${index}`), scope_hash: scopeHash, state: 'claimed', generation: 1,
        owner_hash: _testing.ownerHashOf(freshToken()), nonce: null, worker_hash: null, result_hash: null};
      row.row_digest = _testing.rowDigest(row);
      insert.run(row.request_key, row.scope_hash, row.state, row.generation, row.owner_hash, row.nonce, row.worker_hash, row.result_hash, row.row_digest);
      rows.push(row);
    }
    db.prepare("UPDATE meta SET value = ? WHERE key = 'row_count'").run(String(rows.length));
    db.prepare("UPDATE meta SET value = ? WHERE key = 'aggregate'").run(_testing.aggregateDigest(rows));
    db.exec('COMMIT');
  });
  let registry = openClaimRegistry(path);
  try {
    const last = registry.reserve({requestId: 'synthetic-cap-last', scope: SCOPE});
    assert.equal(last.outcome, 'created');
    assert.equal(last.claim.state, 'claimed');
    const intent = registry.recordDispatchIntent({requestId: 'synthetic-cap-last', scope: SCOPE, ownerToken: last.ownerToken});
    assert.equal(intent.dispatchAuthorized, true);
    assert.throws(() => registry.reserve({requestId: 'synthetic-cap-over', scope: SCOPE}), code('STORE_FULL'));
    assert.equal(registry.reserve({requestId: 'synthetic-cap-0', scope: SCOPE}).outcome, 'existing');
  } finally { registry.close(); }
  registry = openClaimRegistry(path);
  try {
    assert.equal(registry.inspect({requestId: 'synthetic-cap-last', scope: SCOPE}).claim.state, 'dispatch-intent');
    assert.equal(registry.inspect({requestId: 'synthetic-cap-1022', scope: SCOPE}).found, true);
    assert.equal(registry.inspect({requestId: 'synthetic-cap-over', scope: SCOPE}).found, false);
  } finally { registry.close(); }
  assert.ok(statSync(path).size < 2048 * 4096, 'default page bound must hold the default row bound');
}));
