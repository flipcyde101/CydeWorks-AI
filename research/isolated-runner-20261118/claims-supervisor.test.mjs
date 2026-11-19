// Deterministic synthetic tests for the disconnected claims supervisor
// prototype. Every store is a disposable synthetic file in a fresh temporary
// directory that is removed afterwards. No network, browser, model, worker,
// credential or production state is used.
//
// Run these only inside a verified offline OS sandbox with read-only source
// and toolchain, scratch-only writes, an allowlisted empty environment and
// explicit time and resource limits. Real-child cases spawn process.execPath.
//
// When CLAIMS_SUPERVISOR_TEST_FIXTURE is set, this file is not a test suite:
// it acts as a fault-injecting child fixture that the test spawn wrapper
// launches in place of the fixed child entry. node:test is imported only in
// suite mode so the fixture writes nothing but its one reply.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {PassThrough, Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';

const TEST_FILE = fileURLToPath(import.meta.url);
const FIXTURE_ENV = 'CLAIMS_SUPERVISOR_TEST_FIXTURE';
const MARKER_ENV = 'CLAIMS_SUPERVISOR_TEST_MARKER';

if (typeof process.env[FIXTURE_ENV] === 'string') {
  await runFixtureChild(process.env[FIXTURE_ENV], process.env[MARKER_ENV]);
} else {
  await defineTests();
}

// Fixture modes: 'hang:<label>' blocks forever at the registry fault point,
// 'exit:<label>' exits 0 at that point without writing a reply.
async function runFixtureChild(spec, marker) {
  const {childMain} = await import('./claims-supervisor-child.mjs');
  const split = spec.indexOf(':');
  const action = spec.slice(0, split);
  const label = spec.slice(split + 1);
  const faultHook = point => {
    if (point !== label) return;
    if (marker) writeFileSync(marker, point);
    if (action === 'hang') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
    else if (action === 'exit') process.exit(0);
  };
  await childMain({faultHook});
}

async function defineTests() {
  const {default: test, after} = await import('node:test');
  const {default: assert} = await import('node:assert/strict');
  const supervisorModule = await import('./claims-supervisor.mjs');
  const childModule = await import('./claims-supervisor-child.mjs');
  const {openClaimRegistry} = await import('./durable-request-claims.mjs');
  const {DatabaseSync} = await import('node:sqlite');
  const {_testing, createClaimsSupervisor, CHILD_ENTRY, PROTOTYPE_STATUS, CONTAINMENT, MISSING_BOUNDARIES, childEnvironment} = supervisorModule;
  const {preflightStore, sameStoreIdentity, EXIT_BAD_REQUEST} = childModule;

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claims-supervisor-')));
  after(() => rmSync(root, {recursive: true, force: true}));

  let caseCounter = 0;
  const freshDir = () => {
    const dir = join(root, `case-${++caseCounter}`);
    mkdirSync(dir);
    return dir;
  };
  const newStore = () => {
    const path = join(freshDir(), 'claims.sqlite');
    openClaimRegistry(path, {initialize: true}).close();
    return path;
  };
  const fileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

  const REQUEST_ID = 'synthetic-request-9c41e2';
  const SCOPE = Object.freeze({tenant: 'synthetic-tenant-7f3a', lane: 'synthetic-lane'});
  const scope = () => ({...SCOPE});
  const BIRTH = {pid: 4242, creationTime: 'synthetic-creation-1', bootId: 'synthetic-boot-1'};
  const HOST_EVIDENCE = {authority: 'host', cleanup: 'verified', inference: 'settled', resultHash: 'a'.repeat(64)};
  const SECRETS = [REQUEST_ID, SCOPE.tenant, SCOPE.lane];

  const realOptions = (storePath, extra = {}) => ({storePath, deadlineMs: 20000, exitWaitMs: 10000, busyTimeoutMs: 500, ...extra});

  // Records every spawn the supervisor requests. With a fixture, launches
  // this test file in place of the fixed child entry with the same flags,
  // options and environment plus the fixture marker variables.
  const recordingSpawn = (calls, fixture) => (command, args, options) => {
    calls.push({command, args: [...args], options: {...options, env: {...options.env}}});
    if (!fixture) return spawn(command, args, options);
    const fixtureArgs = [...args.slice(0, -1), TEST_FILE];
    return spawn(command, fixtureArgs, {...options, env: {...options.env, [FIXTURE_ENV]: fixture.mode, [MARKER_ENV]: fixture.marker}});
  };

  const assertPrivate = (value, extra = []) => {
    const text = JSON.stringify(value);
    for (const secret of [...SECRETS, ...extra]) assert.ok(!text.includes(secret), 'outcome or argv leaked request data');
  };

  const assertNoAuthority = outcome => {
    assert.equal(outcome.redispatchAllowed, false);
    assert.equal(outcome.automaticAction, 'none');
    assert.equal(outcome.containment, CONTAINMENT);
    assert.ok(Object.isFrozen(outcome));
  };

  const assertSpawnShape = call => {
    assert.equal(call.command, process.execPath);
    assert.equal(call.args.at(-1), CHILD_ENTRY);
    assert.deepEqual(call.args.slice(0, -1).map(arg => arg.replace(/=\d+$/, '=N')),
      ['--max-old-space-size=N', '--disallow-code-generation-from-strings', '--no-addons']);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.detached, false);
    assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'ignore']);
    assert.equal(call.options.cwd, dirname(CHILD_ENTRY));
    const allowed = process.platform === 'win32' ? ['SystemRoot'] : [];
    for (const key of Object.keys(call.options.env)) assert.ok(allowed.includes(key), 'unexpected child environment key');
  };

  // ---------- Fake child for deterministic protocol cases ----------

  class FakeChild extends EventEmitter {
    constructor(script, {emitSpawn = true} = {}) {
      super();
      this.killSignals = [];
      this.onKill = null;
      this.request = null;
      this.rawInput = '';
      const input = [];
      this.stdout = new PassThrough();
      this.stdin = new Writable({
        write(chunk, encoding, callback) { input.push(Buffer.from(chunk)); callback(); },
        final: callback => {
          callback();
          this.rawInput = Buffer.concat(input).toString('utf8');
          this.request = JSON.parse(this.rawInput);
          setImmediate(() => script(this, this.request));
        },
      });
      this.spawned = false;
      if (emitSpawn) setImmediate(() => this.emitSpawnNow());
    }
    emitSpawnNow() {
      this.spawned = true;
      this.emit('spawn');
    }
    kill(signal) {
      this.killSignals.push(signal);
      if (this.onKill) setImmediate(() => this.onKill(signal));
      return true;
    }
    send(data) { this.stdout.write(data); }
    reply(fields, overrides = {}) {
      this.send(`${JSON.stringify({v: 1, correlation: this.request.correlation, operation: this.request.operation, ...fields, ...overrides})}\n`);
    }
    exitNow(code, signal = null) {
      this.emit('exit', code, signal);
      this.emit('close', code, signal);
    }
    finish(code = 0, signal = null) {
      this.stdout.once('end', () => this.exitNow(code, signal));
      this.stdout.end();
    }
  }

  const fakeStorePath = () => join(root, 'fake-never-opened', 'claims.sqlite');
  const fakeSupervisor = (script, extra = {}) => {
    const children = [];
    const calls = [];
    const supervisor = _testing.createSupervisor(
      {storePath: fakeStorePath(), deadlineMs: 300, exitWaitMs: 150, busyTimeoutMs: 50, ...extra},
      {spawnImpl: (command, args, options) => {
        calls.push({command, args: [...args], options: {...options, env: {...options.env}}});
        const child = new FakeChild(script);
        children.push(child);
        return child;
      }});
    return {supervisor, children, calls};
  };

  const INSPECT_ARGS = () => ({requestId: REQUEST_ID, scope: scope()});
  const CLAIM = Object.freeze({requestKey: 'a'.repeat(64), scopeHash: 'b'.repeat(64), state: 'claimed', generation: 1,
    nonce: null, workerIdentityRecorded: false, resultHash: null});

  // ---------- Status and options ----------

  test('prototype status never claims containment, Windows qualification or production safety', () => {
    assert.equal(PROTOTYPE_STATUS.connected, false);
    assert.equal(PROTOTYPE_STATUS.windowsQualified, false);
    assert.equal(PROTOTYPE_STATUS.productionSafe, false);
    assert.equal(PROTOTYPE_STATUS.containment, 'not-established-by-supervisor');
    assert.ok(MISSING_BOUNDARIES.some(text => text.startsWith('Check order:')));
  });

  test('options reject sandbox or trust flags, unsafe bounds and non-data descriptors', () => {
    const storePath = join(root, 'x.sqlite');
    const invalid = [
      undefined, null, [], {},
      {storePath: 'relative.sqlite'},
      {storePath, sandboxed: true},
      {storePath, trustedSandbox: 'verified'},
      {storePath, processIdentity: 'host'},
      {storePath, childEntry: TEST_FILE},
      {storePath, spawn: () => null},
      {storePath, maxPages: 262144},
      {storePath, maxPages: 15},
      {storePath, maxConcurrent: 0},
      {storePath, maxConcurrent: 9},
      {storePath, deadlineMs: 1000, busyTimeoutMs: 501},
      {storePath, maxReplyBytes: 1e9},
      {storePath, exitWaitMs: 0},
      Object.defineProperty({storePath}, 'deadlineMs', {get: () => 1000, enumerable: true}),
      new Proxy({storePath}, {}),
    ];
    for (const options of invalid) {
      assert.throws(() => createClaimsSupervisor(options), error => error.code === 'INVALID_OPTIONS' && !String(error.message).includes(root));
    }
    assert.doesNotThrow(() => createClaimsSupervisor({storePath}));
  });

  test('requests are validated before any spawn and oversized requests never start a child', async () => {
    const {supervisor, calls} = fakeSupervisor(() => assert.fail('must not spawn'), {maxRequestBytes: 1024});
    const getter = Object.defineProperty({scope: scope()}, 'requestId', {get: () => REQUEST_ID, enumerable: true});
    const cases = [
      ['close', INSPECT_ARGS(), 'OPERATION_NOT_ALLOWED'],
      ['__proto__', INSPECT_ARGS(), 'OPERATION_NOT_ALLOWED'],
      ['constructor', INSPECT_ARGS(), 'OPERATION_NOT_ALLOWED'],
      [42, INSPECT_ARGS(), 'OPERATION_NOT_ALLOWED'],
      ['inspect', getter, 'INVALID_REQUEST'],
      ['inspect', new Proxy(INSPECT_ARGS(), {}), 'INVALID_REQUEST'],
      ['inspect', {requestId: REQUEST_ID, scope: {fn: () => 1}}, 'INVALID_REQUEST'],
      ['inspect', {requestId: REQUEST_ID, scope: {big: 1n}}, 'INVALID_REQUEST'],
      ['inspect', {requestId: REQUEST_ID, scope: {zero: -0}}, 'INVALID_REQUEST'],
      ['inspect', {requestId: REQUEST_ID, scope: {missing: undefined}}, 'INVALID_REQUEST'],
      ['inspect', {requestId: REQUEST_ID, scope: {sparse: [1, , 3]}}, 'INVALID_REQUEST'],
      ['inspect', null, 'INVALID_REQUEST'],
      ['inspect', [], 'INVALID_REQUEST'],
      ['inspect', {requestId: REQUEST_ID, scope: {pad: 'p'.repeat(2000)}}, 'REQUEST_OVERSIZED'],
    ];
    for (const [operation, args, code] of cases) {
      const outcome = await supervisor.run(operation, args);
      assert.equal(outcome.outcome, 'rejected');
      assert.equal(outcome.code, code);
      assert.equal(outcome.childState, 'not-started');
      assertNoAuthority(outcome);
      assertPrivate(outcome);
    }
    assert.equal(calls.length, 0);
    supervisor.close();
    assert.equal((await supervisor.run('inspect', INSPECT_ARGS())).code, 'SUPERVISOR_CLOSED');
  });

  // ---------- Protocol cases with fake children ----------

  test('a correlated, well-formed reply with a clean exit is ok; request data is on stdin only', async () => {
    const {supervisor, children, calls} = fakeSupervisor(child => { child.reply({status: 'ok', result: {found: false}}); child.finish(0); });
    const outcome = await supervisor.run('inspect', INSPECT_ARGS());
    assert.equal(outcome.outcome, 'ok', outcome.code);
    assert.deepEqual(outcome.result, {found: false});
    assert.ok(Object.isFrozen(outcome.result));
    assertNoAuthority(outcome);
    assertSpawnShape(calls[0]);
    assertPrivate(calls[0], [fakeStorePath()]);
    assert.ok(children[0].rawInput.includes(REQUEST_ID));
    assert.equal(supervisor.stats().active, 0);
  });

  test('malformed, mismatched, duplicate, lost and over-authorized replies are unknown and never ok', async () => {
    const created = (dispatchAuthorized) => ({status: 'ok', result: {outcome: 'created', dispatchAuthorized,
      ownerToken: 'A'.repeat(43), claim: {...CLAIM}}});
    const cases = [
      ['inspect', child => { child.send('not json\n'); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.send(JSON.stringify({v: 1, correlation: child.request.correlation, operation: 'inspect', status: 'ok', result: {found: false}})); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.send(Buffer.from([0xff, 0xfe, 0x0a])); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.reply({status: 'ok', result: {found: false}, extra: 1}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.reply({status: 'ok', result: {found: true}}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.reply({status: 'error', phase: 'operation', code: 'MADE_UP'}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.reply({status: 'rejected', code: 'STORE_CORRUPT'}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.reply({status: 'ok', result: {found: false}}, {v: 2}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => {
        child.send(`{"v":1,"correlation":"${child.request.correlation}","operation":"inspect","status":"ok","result":{"found":false},"__proto__":{}}\n`);
        child.finish(0);
      }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.reply({status: 'ok', result: {found: false}}, {correlation: 'x'.repeat(32)}); child.finish(0); }, 'REPLY_MISMATCH'],
      ['inspect', child => { child.reply({status: 'ok', result: {found: false}}, {operation: 'reserve'}); child.finish(0); }, 'REPLY_MISMATCH'],
      ['inspect', child => { child.reply({status: 'ok', result: {found: false}}); child.reply({status: 'ok', result: {found: false}}); child.finish(0); }, 'REPLY_DUPLICATE'],
      ['inspect', child => { child.finish(0); }, 'REPLY_MISSING'],
      ['inspect', child => { child.reply({status: 'ok', result: {found: false}}); child.finish(1); }, 'CHILD_EXIT_UNCLEAN'],
      ['inspect', child => { child.reply({status: 'ok', result: {found: false}}); child.finish(null, 'SIGTERM'); }, 'CHILD_EXIT_UNCLEAN'],
      ['reserve', child => { child.reply(created(true)); child.finish(0); }, 'REPLY_MALFORMED'],
      ['recordDispatchIntent', child => { child.reply({status: 'ok', result: {found: false}}); child.finish(0); }, 'REPLY_MALFORMED'],
    ];
    for (const [operation, script, code] of cases) {
      const {supervisor} = fakeSupervisor(script);
      const outcome = await supervisor.run(operation, {requestId: REQUEST_ID, scope: scope(), ownerToken: 'B'.repeat(43)});
      assert.equal(outcome.outcome, 'unknown', `${code}: got ${outcome.outcome} ${outcome.code}`);
      assert.equal(outcome.code, code);
      assert.equal(Object.hasOwn(outcome, 'result'), false);
      assertNoAuthority(outcome);
      assertPrivate(outcome);
      assert.equal(supervisor.stats().active, 0);
    }
    // Sanity: the same reserve shape without the false authority claim is ok.
    const {supervisor} = fakeSupervisor(child => { child.reply(created(false)); child.finish(0); });
    assert.equal((await supervisor.run('reserve', INSPECT_ARGS())).outcome, 'ok');
  });

  test('registry refusals are rejected; store failures during writes are unknown', async () => {
    const run = async (operation, fields) => {
      const {supervisor} = fakeSupervisor(child => { child.reply(fields); child.finish(0); });
      return supervisor.run(operation, {requestId: REQUEST_ID, scope: scope(), ownerToken: 'B'.repeat(43)});
    };
    let outcome = await run('recordDispatchIntent', {status: 'error', phase: 'operation', code: 'INVALID_TRANSITION'});
    assert.equal(outcome.outcome, 'rejected');
    assert.equal(outcome.commitState, 'none');
    outcome = await run('recordDispatchIntent', {status: 'error', phase: 'operation', code: 'STORE_UNAVAILABLE'});
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(outcome.commitState, 'unknown');
    outcome = await run('recordDispatchIntent', {status: 'error', phase: 'open', code: 'STORE_CORRUPT'});
    assert.equal(outcome.outcome, 'rejected');
    outcome = await run('inspect', {status: 'error', phase: 'operation', code: 'STORE_BUSY'});
    assert.equal(outcome.outcome, 'rejected');
    outcome = await run('recordDispatchIntent', {status: 'unknown', code: 'STORE_PATH_CHANGED'});
    assert.equal(outcome.outcome, 'unknown');
    outcome = await run('inspect', {status: 'rejected', code: 'PREFLIGHT_OVERSIZE'});
    assert.equal(outcome.outcome, 'rejected');
    assert.equal(outcome.code, 'PREFLIGHT_OVERSIZE');
  });

  test('an oversized reply kills the child and is unknown after exit is observed', async () => {
    const {supervisor, children} = fakeSupervisor(child => {
      child.onKill = () => child.exitNow(null, 'SIGKILL');
      child.send('x'.repeat(300));
    }, {maxReplyBytes: 256});
    const outcome = await supervisor.run('recordDispatchIntent', {requestId: REQUEST_ID, scope: scope(), ownerToken: 'B'.repeat(43)});
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(outcome.code, 'REPLY_OVERSIZED');
    assert.equal(outcome.childState, 'exit-observed');
    assert.equal(outcome.commitState, 'unknown');
    assert.deepEqual(children[0].killSignals, ['SIGKILL']);
    assert.equal(supervisor.stats().active, 0);
  });

  test('a late reply after the deadline is ignored; the outcome stays unknown', async () => {
    const {supervisor, children} = fakeSupervisor(child => {
      child.onKill = () => { child.reply({status: 'ok', result: {found: false}}); child.finish(null, 'SIGKILL'); };
    });
    const outcome = await supervisor.run('inspect', INSPECT_ARGS());
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(outcome.code, 'CHILD_TIMEOUT');
    assert.equal(outcome.childState, 'exit-observed');
    assert.equal(Object.hasOwn(outcome, 'result'), false);
    assert.deepEqual(children[0].killSignals, ['SIGKILL']);
    assert.equal(children.length, 1, 'no retry');
  });

  test('an unconfirmed exit stays unresolved and keeps its concurrency slot until exit is observed', async () => {
    const {supervisor, children} = fakeSupervisor(() => {}, {maxConcurrent: 1});
    const outcome = await supervisor.run('recordDispatchIntent', {requestId: REQUEST_ID, scope: scope(), ownerToken: 'B'.repeat(43)});
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(outcome.code, 'CHILD_TIMEOUT');
    assert.equal(outcome.childState, 'exit-unconfirmed');
    assert.equal(outcome.commitState, 'unknown');
    assert.deepEqual(children[0].killSignals, ['SIGKILL']);
    assert.equal(supervisor.stats().active, 1);
    const blocked = await supervisor.run('inspect', INSPECT_ARGS());
    assert.equal(blocked.code, 'SUPERVISOR_BUSY');
    assert.equal(children.length, 1);
    children[0].exitNow(null, 'SIGKILL');
    assert.equal(supervisor.stats().active, 0);
  });

  test('spawn failures are not-started and release the slot', async () => {
    const throwing = _testing.createSupervisor({storePath: fakeStorePath()}, {spawnImpl: () => { throw new Error(`boom ${REQUEST_ID}`); }});
    let outcome = await throwing.run('inspect', INSPECT_ARGS());
    assert.equal(outcome.code, 'CHILD_SPAWN_FAILED');
    assert.equal(outcome.childState, 'not-started');
    assertPrivate(outcome);
    assert.equal(throwing.stats().active, 0);
    const erroring = _testing.createSupervisor({storePath: fakeStorePath()}, {spawnImpl: () => {
      const child = new FakeChild(() => {}, {emitSpawn: false});
      setImmediate(() => child.emit('error', new Error('ENOENT')));
      return child;
    }});
    outcome = await erroring.run('inspect', INSPECT_ARGS());
    assert.equal(outcome.code, 'CHILD_SPAWN_FAILED');
    assert.equal(erroring.stats().active, 0);
  });

  test('concurrency cap refuses extra work without queueing or spawning', async () => {
    const {supervisor, children} = fakeSupervisor(() => {}, {maxConcurrent: 2, deadlineMs: 10000, busyTimeoutMs: 50});
    const first = supervisor.run('inspect', INSPECT_ARGS());
    const second = supervisor.run('inspect', INSPECT_ARGS());
    const third = await supervisor.run('inspect', INSPECT_ARGS());
    assert.equal(third.code, 'SUPERVISOR_BUSY');
    assert.equal(supervisor.stats().active, 2);
    // A real ChildProcess always emits 'spawn' before 'exit' or 'close'. Wait
    // for both the captured request and the spawn event before replying, so
    // the fake keeps that order.
    for (let tick = 0; tick < 1000 && children.some(child => child.request === null || !child.spawned); tick++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(children.every(child => child.request !== null && child.spawned), 'fake children did not reach spawned state');
    for (const child of children) { child.reply({status: 'ok', result: {found: false}}); child.finish(0); }
    const firstOutcome = await first;
    const secondOutcome = await second;
    assert.equal(firstOutcome.outcome, 'ok', firstOutcome.code);
    assert.equal(secondOutcome.outcome, 'ok', secondOutcome.code);
    assert.equal(children.length, 2);
    assert.equal(supervisor.stats().active, 0);
  });

  // Regression for the event order found in the concurrency fixture: exit
  // and close before 'spawn'. The supervisor must never trust that reply. It
  // releases the slot when exit is seen and stays unknown until the deadline.
  test('invalid event order: exit and close before spawn never yield ok and release the slot', async () => {
    const children = [];
    const supervisor = _testing.createSupervisor(
      {storePath: fakeStorePath(), deadlineMs: 300, exitWaitMs: 150, busyTimeoutMs: 50, maxConcurrent: 1},
      {spawnImpl: () => {
        const child = new FakeChild(() => {}, {emitSpawn: false});
        children.push(child);
        return child;
      }});
    const pending = supervisor.run('inspect', INSPECT_ARGS());
    const child = children[0];
    for (let tick = 0; tick < 1000 && child.request === null; tick++) await new Promise(resolve => setImmediate(resolve));
    assert.notEqual(child.request, null);
    assert.equal(child.spawned, false);
    child.reply({status: 'ok', result: {found: false}});
    await new Promise(resolve => { child.stdout.once('end', resolve); child.stdout.end(); });
    child.exitNow(0);
    assert.equal(supervisor.stats().active, 0, 'observed exit releases the slot');
    child.emitSpawnNow();
    const outcome = await pending;
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(outcome.code, 'CHILD_TIMEOUT');
    assert.equal(outcome.childState, 'exit-observed');
    assert.equal(Object.hasOwn(outcome, 'result'), false);
    assertNoAuthority(outcome);
    assert.equal(children.length, 1, 'no retry');
  });

  // ---------- Preflight (in-process, disposable stores) ----------

  test('preflight accepts a fresh registry store as a snapshot only', () => {
    const store = newStore();
    const result = preflightStore(store, 2048);
    assert.equal(result.ok, true);
    assert.equal(result.guarantee, 'snapshot-only');
    assert.ok(result.pages >= 1 && result.pages <= 16);
  });

  test('preflight refuses oversize, trailing pages, odd sizes, wrong page size and WAL', () => {
    const oversize = newStore();
    appendFileSync(oversize, Buffer.alloc(4096 * 64));
    assert.equal(preflightStore(oversize, 16).code, 'PREFLIGHT_OVERSIZE');
    const odd = newStore();
    appendFileSync(odd, Buffer.alloc(10));
    assert.equal(preflightStore(odd, 2048).code, 'PREFLIGHT_UNSUPPORTED');
    const bigPage = join(freshDir(), 'page.sqlite');
    let db = new DatabaseSync(bigPage);
    db.exec('PRAGMA page_size=8192; PRAGMA journal_mode=DELETE; CREATE TABLE t (x INTEGER)');
    db.close();
    assert.equal(preflightStore(bigPage, 2048).code, 'PREFLIGHT_UNSUPPORTED');
    const wal = join(freshDir(), 'wal.sqlite');
    db = new DatabaseSync(wal);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t (x INTEGER)');
    db.close();
    assert.equal(preflightStore(wal, 2048).code, 'PREFLIGHT_UNSUPPORTED');
    const notSqlite = join(freshDir(), 'plain.sqlite');
    writeFileSync(notSqlite, Buffer.alloc(4096, 7));
    assert.equal(preflightStore(notSqlite, 2048).code, 'PREFLIGHT_UNSUPPORTED');
    assert.equal(preflightStore(newStore(), 262144).code, 'PREFLIGHT_UNSUPPORTED');
  });

  test('preflight refuses sidecars: any -wal or -shm, oversized or non-file -journal', () => {
    const withWal = newStore();
    writeFileSync(`${withWal}-wal`, '');
    assert.equal(preflightStore(withWal, 2048).code, 'PREFLIGHT_UNSUPPORTED');
    const withShm = newStore();
    writeFileSync(`${withShm}-shm`, '');
    assert.equal(preflightStore(withShm, 2048).code, 'PREFLIGHT_UNSUPPORTED');
    const bigJournal = newStore();
    writeFileSync(`${bigJournal}-journal`, Buffer.alloc(65536 + 16 * 4104 + 1));
    assert.equal(preflightStore(bigJournal, 16).code, 'PREFLIGHT_OVERSIZE');
    const dirJournal = newStore();
    mkdirSync(`${dirJournal}-journal`);
    assert.equal(preflightStore(dirJournal, 2048).code, 'PREFLIGHT_PATH');
    const smallJournal = newStore();
    writeFileSync(`${smallJournal}-journal`, Buffer.alloc(512));
    assert.equal(preflightStore(smallJournal, 2048).ok, true);
  });

  test('preflight path limits: relative, missing, directory, links and substitution after the snapshot', t => {
    assert.equal(preflightStore('relative/claims.sqlite', 2048).code, 'PREFLIGHT_PATH');
    assert.equal(preflightStore(join(freshDir(), 'missing.sqlite'), 2048).code, 'PREFLIGHT_UNAVAILABLE');
    const dir = join(freshDir(), 'dir.sqlite');
    mkdirSync(dir);
    assert.equal(preflightStore(dir, 2048).code, 'PREFLIGHT_PATH');
    if (process.platform === 'win32') {
      const base = dirname(newStore());
      assert.equal(preflightStore(`${join(base, 'claims.sqlite')}:stream`, 2048).code, 'PREFLIGHT_PATH');
      assert.equal(preflightStore(`${join(base, 'claims.sqlite')}.`, 2048).code, 'PREFLIGHT_PATH');
      assert.equal(preflightStore('\\\\?\\C:\\claims.sqlite', 2048).code, 'PREFLIGHT_PATH');
    }

    // Substitution after a passing snapshot: preflight cannot prevent it.
    // The identity re-check detects a plain replacement only.
    const store = newStore();
    const snapshot = preflightStore(store, 2048);
    assert.equal(snapshot.ok, true);
    const replacement = join(dirname(store), 'replacement.sqlite');
    copyFileSync(newStore(), replacement);
    renameSync(replacement, store);
    assert.equal(sameStoreIdentity(store, snapshot.identity), false);

    const target = newStore();
    const fileLink = join(freshDir(), 'link.sqlite');
    try { symlinkSync(target, fileLink, 'file'); }
    catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') { t.diagnostic('file symlink creation not permitted; skipped'); } else throw error; }
    if (existsSync(fileLink)) assert.equal(preflightStore(fileLink, 2048).code, 'PREFLIGHT_PATH');

    // A directory junction (Windows) or symlink (POSIX) in an ancestor.
    const linkedDir = join(freshDir(), 'linked');
    try { symlinkSync(dirname(target), linkedDir, 'junction'); }
    catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') { t.diagnostic('directory link creation not permitted; skipped'); return; } throw error; }
    assert.equal(preflightStore(join(linkedDir, 'claims.sqlite'), 2048).code, 'PREFLIGHT_PATH');
  });

  // ---------- Real child cases (spawn process.execPath) ----------

  test('real child: full lifecycle, replay and scope binding through bounded children', async () => {
    const store = newStore();
    const calls = [];
    const supervisor = _testing.createSupervisor(realOptions(store), {spawnImpl: recordingSpawn(calls)});
    const base = {requestId: REQUEST_ID, scope: scope()};
    const reserved = await supervisor.run('reserve', base);
    assert.equal(reserved.outcome, 'ok', reserved.code);
    assert.equal(reserved.result.outcome, 'created');
    assert.equal(reserved.result.dispatchAuthorized, false);
    const ownerToken = reserved.result.ownerToken;
    const intent = await supervisor.run('recordDispatchIntent', {...base, ownerToken});
    assert.equal(intent.outcome, 'ok', intent.code);
    assert.equal(intent.result.dispatchAuthorized, true);
    const worker = await supervisor.run('recordWorkerIdentity', {...base, ownerToken, nonce: intent.result.nonce, birthIdentity: BIRTH});
    assert.equal(worker.outcome, 'ok', worker.code);
    const done = await supervisor.run('recordHostCompletion', {...base, ownerToken, hostEvidence: HOST_EVIDENCE});
    assert.equal(done.outcome, 'ok', done.code);
    assert.equal(done.result.claim.state, 'completed');
    const replay = await supervisor.run('reserve', base);
    assert.equal(replay.result.outcome, 'existing');
    assert.equal(replay.result.claim.state, 'completed');
    const wrongScope = await supervisor.run('reserve', {requestId: REQUEST_ID, scope: {...SCOPE, lane: 'other-lane'}});
    assert.equal(wrongScope.outcome, 'rejected');
    assert.equal(wrongScope.code, 'SCOPE_MISMATCH');
    assertPrivate(wrongScope, [store]);
    assert.equal(calls.length, 6);
    for (const call of calls) { assertSpawnShape(call); assertPrivate(call.args, [ownerToken]); }
    assert.equal(supervisor.stats().active, 0);
  });

  test('real child: timeout before commit kills the child, outcome unknown, claim stays pre-dispatch', async () => {
    const store = newStore();
    const supervisor = _testing.createSupervisor(realOptions(store), {spawnImpl: recordingSpawn([])});
    const base = {requestId: REQUEST_ID, scope: scope()};
    const {result: {ownerToken}} = await supervisor.run('reserve', base);
    const marker = join(dirname(store), 'marker-before');
    const calls = [];
    const faulted = _testing.createSupervisor(realOptions(store, {deadlineMs: 4000}),
      {spawnImpl: recordingSpawn(calls, {mode: 'hang:dispatch:before-commit', marker})});
    const outcome = await faulted.run('recordDispatchIntent', {...base, ownerToken});
    assert.ok(existsSync(marker), 'fixture did not reach the fault point before the deadline');
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(outcome.code, 'CHILD_TIMEOUT');
    assert.equal(outcome.childState, 'exit-observed');
    assert.equal(outcome.commitState, 'unknown');
    assertNoAuthority(outcome);
    assert.equal(calls.length, 1, 'no automatic retry');
    assert.equal(faulted.stats().active, 0);
    // The killed transaction never committed; a bounded run recovers any hot
    // journal and still sees the pre-dispatch claim.
    const inspected = await supervisor.run('inspect', base);
    assert.equal(inspected.outcome, 'ok', inspected.code);
    assert.equal(inspected.result.claim.state, 'claimed');
    assert.equal(inspected.result.recovery.hold, 'pre-dispatch');
  });

  test('real child: timeout after commit is unknown and the committed intent can never be redispatched', async () => {
    const store = newStore();
    const supervisor = _testing.createSupervisor(realOptions(store), {spawnImpl: recordingSpawn([])});
    const base = {requestId: REQUEST_ID, scope: scope()};
    const {result: {ownerToken}} = await supervisor.run('reserve', base);
    const marker = join(dirname(store), 'marker-after');
    const faulted = _testing.createSupervisor(realOptions(store, {deadlineMs: 4000}),
      {spawnImpl: recordingSpawn([], {mode: 'hang:dispatch:after-commit', marker})});
    const outcome = await faulted.run('recordDispatchIntent', {...base, ownerToken});
    assert.ok(existsSync(marker), 'fixture did not reach the fault point before the deadline');
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(outcome.code, 'CHILD_TIMEOUT');
    assert.equal(Object.hasOwn(outcome, 'result'), false, 'nonce must not reach the caller');
    const inspected = await supervisor.run('inspect', base);
    assert.equal(inspected.result.claim.state, 'dispatch-intent');
    assert.equal(inspected.result.recovery.resolution, 'unresolved');
    assert.equal(inspected.result.recovery.redispatchAllowed, false);
    const retry = await supervisor.run('recordDispatchIntent', {...base, ownerToken});
    assert.equal(retry.outcome, 'rejected');
    assert.equal(retry.code, 'INVALID_TRANSITION');
    const hostContinue = await supervisor.run('hostContinuePreDispatch', {...base,
      hostDecision: {authority: 'host', decision: 'continue-pre-dispatch', observedGeneration: 1}});
    assert.equal(hostContinue.code, 'RECOVERY_REQUIRES_EXTERNAL_PROOF');
  });

  test('real child: lost reply after commit (clean exit, no reply) is unknown', async () => {
    const store = newStore();
    const supervisor = _testing.createSupervisor(realOptions(store), {spawnImpl: recordingSpawn([])});
    const base = {requestId: REQUEST_ID, scope: scope()};
    const {result: {ownerToken}} = await supervisor.run('reserve', base);
    const marker = join(dirname(store), 'marker-lost');
    const faulted = _testing.createSupervisor(realOptions(store),
      {spawnImpl: recordingSpawn([], {mode: 'exit:dispatch:after-commit', marker})});
    const outcome = await faulted.run('recordDispatchIntent', {...base, ownerToken});
    assert.ok(existsSync(marker));
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(outcome.code, 'REPLY_MISSING');
    assert.equal(outcome.childState, 'exited');
    const inspected = await supervisor.run('inspect', base);
    assert.equal(inspected.result.claim.state, 'dispatch-intent');
    assert.equal(inspected.result.recovery.redispatchAllowed, false);
  });

  test('real child: oversized store is refused by preflight before the registry opens it', async () => {
    const store = newStore();
    appendFileSync(store, Buffer.alloc(4096 * 64));
    const before = fileHash(store);
    const supervisor = _testing.createSupervisor(realOptions(store, {maxPages: 16}), {spawnImpl: recordingSpawn([])});
    const outcome = await supervisor.run('inspect', {requestId: REQUEST_ID, scope: scope()});
    assert.equal(outcome.outcome, 'rejected');
    assert.equal(outcome.code, 'PREFLIGHT_OVERSIZE');
    assert.equal(fileHash(store), before);
    assert.equal(existsSync(`${store}-journal`), false);
    assertPrivate(outcome, [store]);
  });

  test('real child: stray WAL sidecar is refused and the store is unchanged', async () => {
    const store = newStore();
    writeFileSync(`${store}-wal`, '');
    const before = fileHash(store);
    const supervisor = _testing.createSupervisor(realOptions(store), {spawnImpl: recordingSpawn([])});
    const outcome = await supervisor.run('reserve', {requestId: REQUEST_ID, scope: scope()});
    assert.equal(outcome.code, 'PREFLIGHT_UNSUPPORTED');
    assert.equal(outcome.commitState, 'none');
    assert.equal(fileHash(store), before);
  });

  test('real child: malformed or oversized stdin exits non-zero with no output', async () => {
    const runRaw = input => new Promise(resolve => {
      const child = spawn(process.execPath, [CHILD_ENTRY], {cwd: dirname(CHILD_ENTRY), env: childEnvironment(),
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']});
      const out = [];
      child.stdout.on('data', chunk => out.push(chunk));
      child.stdin.on('error', () => {});
      child.on('close', code => resolve({code, stdout: Buffer.concat(out).toString('utf8')}));
      child.stdin.end(input);
    });
    const envelope = {v: 1, correlation: 'c'.repeat(32), operation: 'inspect', args: {requestId: REQUEST_ID, scope: scope()},
      store: {path: join(root, 'none.sqlite'), maxPages: 2048, maxRows: 1024, busyTimeoutMs: 100, heapLimitBytes: 64 * 1048576}};
    const inputs = [
      'not json\n',
      `${JSON.stringify(envelope)}`,
      `${JSON.stringify(envelope)}\n${JSON.stringify(envelope)}\n`,
      `${JSON.stringify({...envelope, extra: true})}\n`,
      `${JSON.stringify({...envelope, operation: '__proto__'})}\n`,
      `${JSON.stringify({...envelope, operation: 'close'})}\n`,
      `${JSON.stringify({...envelope, store: {...envelope.store, maxPages: 262144}})}\n`,
      Buffer.alloc(300000, 0x61),
    ];
    for (const input of inputs) {
      const result = await runRaw(input);
      assert.equal(result.code, EXIT_BAD_REQUEST);
      assert.equal(result.stdout, '');
    }
  });
}
