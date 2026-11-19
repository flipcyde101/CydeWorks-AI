// Deterministic synthetic tests for the disconnected claims supervisor
// prototype. Every store is a disposable synthetic file in a fresh temporary
// directory that is removed afterwards. No network, browser, model, worker,
// credential or production state is used.
//
// Run these only inside a verified offline OS sandbox with read-only source
// and toolchain, scratch-only writes, an allowlisted empty environment and
// explicit time and resource limits. Real-child cases spawn process.execPath.
//
// Registry access through the child is refused by design (see
// REGISTRY_BOUNDARY and ACCEPTANCE_GAPS in claims-supervisor.mjs). Fake
// children exercise the protocol only. Nothing here is evidence of real
// registry recovery through the child.
//
// When CLAIMS_SUPERVISOR_TEST_FIXTURE is set, this file is not a test suite:
// it acts as a protocol fixture child that the test spawn wrapper launches in
// place of the fixed child entry. node:test is imported only in suite mode so
// the fixture writes nothing but what its mode says.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
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

// Fixture modes, all after reading and validating one request:
//   hang        block forever without a reply
//   exit        exit 0 without a reply
//   reply-hang  write the refusal reply, then block forever without exiting
//   reply-exit1 write the refusal reply, then exit 1
async function runFixtureChild(mode, marker) {
  const child = await import('./claims-supervisor-child.mjs');
  child.installQuietHandlers();
  const request = await child.readRequestFromStdin();
  if (request === null) return child.quietExit(child.EXIT_BAD_REQUEST);
  if (marker) writeFileSync(marker, mode);
  const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
  const line = child.replyLine(child.buildReply(request));
  if (mode === 'hang') block();
  else if (mode === 'exit') child.quietExit(0);
  else if (mode === 'reply-hang') process.stdout.write(line, () => block());
  else if (mode === 'reply-exit1') process.stdout.write(line, () => child.quietExit(1));
  else child.quietExit(child.EXIT_INTERNAL);
}

async function defineTests() {
  const {default: test, after} = await import('node:test');
  const {default: assert} = await import('node:assert/strict');
  const supervisorModule = await import('./claims-supervisor.mjs');
  const childModule = await import('./claims-supervisor-child.mjs');
  const {openClaimRegistry} = await import('./durable-request-claims.mjs');
  const {DatabaseSync} = await import('node:sqlite');
  const {
    _testing, createClaimsSupervisor, CHILD_ENTRY, PROTOTYPE_STATUS, CONTAINMENT, MISSING_BOUNDARIES,
    ACCEPTANCE_GAPS, REGISTRY_BOUNDARY, BOUNDARY_CODE, ALLOWED_OPERATIONS, childEnvironment,
  } = supervisorModule;
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
  // Names, kinds and content hashes of everything in a directory.
  const snapshotDir = dir => readdirSync(dir).sort().map(name => {
    const path = join(dir, name);
    return statSync(path).isFile() ? `${name}:${fileHash(path)}` : `${name}:dir`;
  }).join('\n');
  const tick = () => new Promise(resolve => setImmediate(resolve));

  const REQUEST_ID = 'synthetic-request-9c41e2';
  const SCOPE = Object.freeze({tenant: 'synthetic-tenant-7f3a', lane: 'synthetic-lane'});
  const SECRETS = [REQUEST_ID, SCOPE.tenant, SCOPE.lane];
  const OWNER = 'B'.repeat(43);
  const ARGS_BY_OPERATION = Object.freeze({
    reserve: {requestId: REQUEST_ID, scope: SCOPE},
    recordDispatchIntent: {requestId: REQUEST_ID, scope: SCOPE, ownerToken: OWNER},
    recordWorkerIdentity: {requestId: REQUEST_ID, scope: SCOPE, ownerToken: OWNER, nonce: '00000000-0000-4000-8000-000000000000',
      birthIdentity: {pid: 4242, creationTime: 'synthetic-creation-1', bootId: 'synthetic-boot-1'}},
    recordHostCompletion: {requestId: REQUEST_ID, scope: SCOPE, ownerToken: OWNER,
      hostEvidence: {authority: 'host', cleanup: 'verified', inference: 'settled', resultHash: 'a'.repeat(64)}},
    hostContinuePreDispatch: {requestId: REQUEST_ID, scope: SCOPE,
      hostDecision: {authority: 'host', decision: 'continue-pre-dispatch', observedGeneration: 1}},
    inspect: {requestId: REQUEST_ID, scope: SCOPE},
    assessWorkerIdentity: {requestId: REQUEST_ID, scope: SCOPE,
      observedBirthIdentity: {pid: 4242, creationTime: 'synthetic-creation-1', bootId: 'synthetic-boot-1'}},
  });
  const argsJson = (operation = 'inspect') => JSON.stringify(ARGS_BY_OPERATION[operation]);
  const REFUSAL = Object.freeze({status: 'rejected', code: 'REGISTRY_BOUNDARY_UNAVAILABLE'});

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
    assert.equal(Object.hasOwn(outcome, 'result'), false);
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
      this.spawned = false;
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
    endOutput() {
      return new Promise(resolve => { this.stdout.once('end', resolve); this.stdout.end(); });
    }
    exitNow(code, signal = null) {
      this.emit('exit', code, signal);
      this.emit('close', code, signal);
    }
    // Native order: output ends, then exit, then close.
    finish(code = 0, signal = null) {
      this.endOutput().then(() => this.exitNow(code, signal));
    }
  }

  const fakeStorePath = () => join(root, 'fake-never-opened', 'claims.sqlite');
  const fakeSupervisor = (script, extra = {}, now) => {
    const children = [];
    const calls = [];
    const supervisor = _testing.createSupervisor(
      {storePath: fakeStorePath(), deadlineMs: 300, exitWaitMs: 150, busyTimeoutMs: 50, ...extra},
      {spawnImpl: (command, args, options) => {
        calls.push({command, args: [...args], options: {...options, env: {...options.env}}});
        const child = new FakeChild(script);
        children.push(child);
        return child;
      }, ...(now ? {now} : {})});
    return {supervisor, children, calls};
  };

  const CLAIM = Object.freeze({requestKey: 'a'.repeat(64), scopeHash: 'b'.repeat(64), state: 'claimed', generation: 1,
    nonce: null, workerIdentityRecorded: false, resultHash: null});
  const RECOVERY = Object.freeze({resolution: 'unresolved', redispatchAllowed: false, automaticAction: 'none',
    hold: 'pre-dispatch', reason: 'synthetic'});
  const HOSTILE = Object.freeze({toString: 1, valueOf: 1});

  // ---------- Status and options ----------

  test('status refuses registry access and declares acceptance gaps instead of simulating them', () => {
    assert.equal(PROTOTYPE_STATUS.connected, false);
    assert.equal(PROTOTYPE_STATUS.windowsQualified, false);
    assert.equal(PROTOTYPE_STATUS.productionSafe, false);
    assert.equal(PROTOTYPE_STATUS.registryAccess, 'refused');
    assert.equal(PROTOTYPE_STATUS.containment, 'not-established-by-supervisor');
    assert.equal(REGISTRY_BOUNDARY.established, false);
    assert.equal(REGISTRY_BOUNDARY.code, BOUNDARY_CODE);
    assert.ok(Object.isFrozen(REGISTRY_BOUNDARY));
    assert.ok(MISSING_BOUNDARIES.some(text => text.startsWith('Check order:')));
    assert.ok(MISSING_BOUNDARIES.some(text => text.startsWith('Hot journal:')));
    assert.ok(MISSING_BOUNDARIES.some(text => text.startsWith('Pathname races:')));
    assert.ok(ACCEPTANCE_GAPS.length >= 3);
    assert.ok(ACCEPTANCE_GAPS.some(text => text.includes('not demonstrated')));
  });

  test('options reject sandbox, trust or boundary flags, unsafe bounds and non-data descriptors', () => {
    const storePath = join(root, 'x.sqlite');
    const invalid = [
      undefined, null, [], {},
      {storePath: 'relative.sqlite'},
      {storePath, sandboxed: true},
      {storePath, trustedSandbox: 'verified'},
      {storePath, processIdentity: 'host'},
      {storePath, registryBoundary: 'established'},
      {storePath, allowRegistryAccess: true},
      {storePath, childEntry: TEST_FILE},
      {storePath, spawn: () => null},
      {storePath, maxPages: 262144},
      {storePath, maxPages: 15},
      {storePath, maxConcurrent: 0},
      {storePath, maxConcurrent: 9},
      {storePath, deadlineMs: 1000, busyTimeoutMs: 501},
      {storePath, maxRequestBytes: 131073},
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

  // ---------- Request input bound (pre-serialization) ----------

  test('live objects are refused by type before any property access or enumeration', async () => {
    const {supervisor, calls} = fakeSupervisor(() => assert.fail('must not spawn'));
    const touched = [];
    const traps = {};
    for (const name of ['get', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'defineProperty', 'set', 'apply']) {
      traps[name] = (...args) => { touched.push(name); return Reflect[name](...args); };
    }
    const getterArgs = Object.defineProperty({}, 'requestId', {get: () => { touched.push('getter'); return REQUEST_ID; }, enumerable: true});
    const inputs = [new Proxy({requestId: REQUEST_ID}, traps), getterArgs, ARGS_BY_OPERATION.inspect,
      new String(argsJson()), Buffer.from(argsJson()), 42, null, undefined];
    for (const input of inputs) {
      const outcome = await supervisor.run('inspect', input);
      assert.equal(outcome.outcome, 'rejected');
      assert.equal(outcome.code, 'INVALID_REQUEST');
      assert.equal(outcome.childState, 'not-started');
      assertNoAuthority(outcome);
      assertPrivate(outcome);
    }
    assert.deepEqual(touched, []);
    assert.equal(calls.length, 0);
  });

  test('request text is length- and byte-bounded before parsing, then parsed data is validated', async () => {
    const {supervisor, calls} = fakeSupervisor(() => assert.fail('must not spawn'), {maxRequestBytes: 16384});
    const nested = depth => `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;
    const cases = [
      ['x'.repeat(16385), 'REQUEST_OVERSIZED'],
      [`"${'\u00e9'.repeat(9000)}"`, 'REQUEST_OVERSIZED'], // 9002 UTF-16 units under the cap, 18002 UTF-8 bytes over it
      ['not json', 'INVALID_REQUEST'],
      ['[]', 'INVALID_REQUEST'],
      ['null', 'INVALID_REQUEST'],
      ['"text"', 'INVALID_REQUEST'],
      [nested(30), 'INVALID_REQUEST'],
      [JSON.stringify({requestId: 'r'.repeat(4097)}), 'INVALID_REQUEST'],
      [JSON.stringify({['k'.repeat(4097)]: 1}), 'INVALID_REQUEST'],
      [JSON.stringify({list: new Array(4097).fill(0)}), 'INVALID_REQUEST'],
      ['{"__proto__":{"polluted":true}}', 'INVALID_REQUEST'],
      ['{"n":1e400}', 'INVALID_REQUEST'],
      ['{"n":-0}', 'INVALID_REQUEST'],
    ];
    for (const [text, code] of cases) {
      const outcome = await supervisor.run('inspect', text);
      assert.equal(outcome.code, code, `expected ${code}`);
      assert.equal(outcome.childState, 'not-started');
      assertPrivate(outcome);
    }
    assert.equal(calls.length, 0);
    assert.equal(({}).polluted, undefined);
    const parsed = _testing.parseArgsJson(argsJson(), 16384);
    assert.equal(parsed.ok, true);
  });

  test('operation, closed and concurrency checks run before any input is measured or parsed', async () => {
    const {supervisor, children} = fakeSupervisor(() => {}, {maxConcurrent: 1, deadlineMs: 10000});
    const pending = supervisor.run('inspect', argsJson());
    const touched = [];
    const proxy = new Proxy({}, {get: () => { touched.push('get'); }, ownKeys: () => { touched.push('ownKeys'); return []; }});
    const busy = await supervisor.run('inspect', proxy);
    assert.equal(busy.code, 'SUPERVISOR_BUSY');
    const busyHuge = await supervisor.run('inspect', 'x'.repeat(1 << 20));
    assert.equal(busyHuge.code, 'SUPERVISOR_BUSY');
    assert.equal((await supervisor.run('close', proxy)).code, 'OPERATION_NOT_ALLOWED');
    assert.equal((await supervisor.run('__proto__', argsJson())).code, 'OPERATION_NOT_ALLOWED');
    assert.equal((await supervisor.run(42, argsJson())).code, 'OPERATION_NOT_ALLOWED');
    assert.deepEqual(touched, []);
    while (children[0].request === null || !children[0].spawned) await tick();
    children[0].reply(REFUSAL);
    children[0].finish(0);
    assert.equal((await pending).code, BOUNDARY_CODE);
    supervisor.close();
    assert.equal((await supervisor.run('inspect', argsJson())).code, 'SUPERVISOR_CLOSED');
    assert.equal(children.length, 1);
  });

  // ---------- Definitive outcome requirements ----------

  test('a refusal reply is definitive only with spawn, complete output and an observed clean exit, in either native order', async () => {
    for (const order of ['end-then-exit', 'exit-then-end']) {
      const {supervisor, children, calls} = fakeSupervisor(async child => {
        child.reply(REFUSAL);
        if (order === 'end-then-exit') { await child.endOutput(); child.exitNow(0); }
        else { child.emit('exit', 0, null); await child.endOutput(); child.emit('close', 0, null); }
      });
      const outcome = await supervisor.run('recordDispatchIntent', argsJson('recordDispatchIntent'));
      assert.equal(outcome.outcome, 'rejected', `${order}: ${outcome.code}`);
      assert.equal(outcome.code, BOUNDARY_CODE);
      assert.equal(outcome.childState, 'exited');
      assert.equal(outcome.commitState, 'none');
      assertNoAuthority(outcome);
      assertSpawnShape(calls[0]);
      assertPrivate(calls[0], [fakeStorePath()]);
      assert.ok(children[0].rawInput.includes(REQUEST_ID), 'request data travels on stdin');
      assert.equal(supervisor.stats().active, 0);
    }
  });

  test('close without exit is out of order: unknown, killed, slot held until exit is observed', async () => {
    const {supervisor, children} = fakeSupervisor(async child => {
      child.reply(REFUSAL);
      await child.endOutput();
      child.emit('close', 0, null);
    }, {maxConcurrent: 1});
    const outcome = await supervisor.run('inspect', argsJson());
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(outcome.code, 'CHILD_EVENT_ORDER');
    assert.equal(outcome.childState, 'exit-unconfirmed');
    assert.deepEqual(children[0].killSignals, ['SIGKILL']);
    assertNoAuthority(outcome);
    assert.equal(supervisor.stats().active, 1);
    assert.equal((await supervisor.run('inspect', argsJson())).code, 'SUPERVISOR_BUSY');
    children[0].emit('exit', null, 'SIGKILL');
    assert.equal(supervisor.stats().active, 0);
  });

  test('exit, close or output before spawn is out of order and never definitive', async () => {
    const scenarios = {
      'exit-before-spawn': async child => { child.reply(REFUSAL); await child.endOutput(); child.exitNow(0); },
      'output-before-spawn': async child => { child.onKill = () => child.exitNow(null, 'SIGKILL'); child.reply(REFUSAL); },
    };
    for (const [name, script] of Object.entries(scenarios)) {
      const children = [];
      const supervisor = _testing.createSupervisor(
        {storePath: fakeStorePath(), deadlineMs: 10000, exitWaitMs: 150, busyTimeoutMs: 50},
        {spawnImpl: () => { const child = new FakeChild(script, {emitSpawn: false}); children.push(child); return child; }});
      const started = Date.now();
      const outcome = await supervisor.run('inspect', argsJson());
      assert.equal(outcome.outcome, 'unknown', name);
      assert.equal(outcome.code, 'CHILD_EVENT_ORDER', name);
      assert.equal(outcome.childState, 'exit-observed', name);
      assert.ok(Date.now() - started < 5000, `${name} must fail fast, not wait for the deadline`);
      assert.equal(supervisor.stats().active, 0);
      children[0].emitSpawnNow(); // a late spawn changes nothing
      assert.equal(supervisor.stats().active, 0);
    }
  });

  test('clean exit with output that never ends is not definitive', async () => {
    const {supervisor} = fakeSupervisor(child => { child.reply(REFUSAL); child.emit('exit', 0, null); });
    const outcome = await supervisor.run('inspect', argsJson());
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(outcome.code, 'CHILD_TIMEOUT');
    assert.equal(outcome.childState, 'exit-observed');
  });

  test('monotonic deadline is checked per event, independent of a late timer callback', async () => {
    // The deadline timer is 10 s away and never runs in these cases; only
    // the injected monotonic clock says the deadline has passed.
    const cases = {
      'output after deadline': async (child, late) => { late(); child.reply(REFUSAL); child.finish(0); },
      'end after deadline': async (child, late) => { child.reply(REFUSAL); await tick(); late(); child.finish(0); },
      'exit after deadline': async (child, late) => { child.reply(REFUSAL); await child.endOutput(); late(); child.exitNow(0); },
      'output after deadline following a clean exit': async (child, late) => {
        child.emit('exit', 0, null); await tick(); late(); child.reply(REFUSAL); await child.endOutput(); child.emit('close', 0, null);
      },
    };
    for (const [name, script] of Object.entries(cases)) {
      let clock = 1000;
      const late = () => { clock += 10001; };
      const {supervisor, children} = fakeSupervisor(child => script(child, late), {deadlineMs: 10000}, () => clock);
      const started = Date.now();
      const outcome = await supervisor.run('inspect', argsJson());
      assert.equal(outcome.outcome, 'unknown', name);
      assert.equal(outcome.code, 'CHILD_TIMEOUT', name);
      assert.equal(outcome.childState, 'exit-observed', name);
      assert.ok(Date.now() - started < 5000, `${name}: decided by the clock, not the timer`);
      assert.equal(supervisor.stats().active, 0);
      assert.ok(children[0].killSignals.length <= 1);
    }
    // A clock that throws or goes non-finite is treated as late.
    for (const now of [() => { throw new Error(REQUEST_ID); }, () => Number.NaN]) {
      const {supervisor} = fakeSupervisor(child => { child.reply(REFUSAL); child.finish(0); }, {deadlineMs: 10000}, now);
      const outcome = await supervisor.run('inspect', argsJson());
      assert.equal(outcome.code, 'CHILD_TIMEOUT');
      assertPrivate(outcome);
    }
  });

  // ---------- Reply validation ----------

  test('well-formed registry ok or error replies are unexpected and never trusted while access is refused', async () => {
    const replies = [
      ['inspect', {status: 'ok', result: {found: false}}, 'none'],
      ['reserve', {status: 'ok', result: {outcome: 'created', dispatchAuthorized: false, ownerToken: 'A'.repeat(43), claim: {...CLAIM}}}, 'unknown'],
      ['recordDispatchIntent', {status: 'error', phase: 'operation', code: 'INVALID_TRANSITION'}, 'unknown'],
      ['inspect', {status: 'error', phase: 'open', code: 'STORE_CORRUPT'}, 'none'],
    ];
    for (const [operation, fields, commitState] of replies) {
      const {supervisor} = fakeSupervisor(child => { child.reply(fields); child.finish(0); });
      const outcome = await supervisor.run(operation, argsJson(operation));
      assert.equal(outcome.outcome, 'unknown');
      assert.equal(outcome.code, 'REPLY_UNEXPECTED');
      assert.equal(outcome.commitState, commitState);
      assertNoAuthority(outcome);
    }
  });

  test('malformed, hostile-typed, mismatched, duplicate and lost replies settle as fixed unknown outcomes', async () => {
    const claim = overrides => ({...CLAIM, ...overrides});
    const cases = [
      ['inspect', child => { child.send('not json\n'); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.send(JSON.stringify({v: 1, correlation: child.request.correlation, operation: 'inspect', ...REFUSAL})); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.send(Buffer.from([0xff, 0xfe, 0x0a])); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.reply({...REFUSAL, extra: 1}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.reply({status: 'rejected', code: 'STORE_CORRUPT'}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.reply({status: 'rejected', code: HOSTILE}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.reply({status: HOSTILE, code: BOUNDARY_CODE}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.reply(REFUSAL, {v: '1'}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.reply({status: 'ok', result: {found: true, claim: claim({requestKey: HOSTILE}), recovery: {...RECOVERY}}}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.reply({status: 'ok', result: {found: true, claim: claim({scopeHash: HOSTILE}), recovery: {...RECOVERY}}}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.reply({status: 'ok', result: {found: true, claim: claim({state: HOSTILE}), recovery: {...RECOVERY}}}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.reply({status: 'ok', result: {found: true, claim: claim({resultHash: HOSTILE}), recovery: {...RECOVERY}}}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.reply({status: 'ok', result: {found: true, claim: {...CLAIM}, recovery: {...RECOVERY, reason: HOSTILE}}}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.reply({status: 'ok', result: {found: true, claim: {...CLAIM}, recovery: {...RECOVERY, hold: HOSTILE}}}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['recordDispatchIntent', child => { child.reply({status: 'ok', result: {dispatchAuthorized: true, nonce: HOSTILE, claim: claim({state: 'dispatch-intent', nonce: HOSTILE})}}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['reserve', child => { child.reply({status: 'ok', result: {outcome: 'created', dispatchAuthorized: false, ownerToken: HOSTILE, claim: {...CLAIM}}}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['reserve', child => { child.reply({status: 'ok', result: {outcome: 'created', dispatchAuthorized: true, ownerToken: 'A'.repeat(43), claim: {...CLAIM}}}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['assessWorkerIdentity', child => { child.reply({status: 'ok', result: {verdict: HOSTILE, osProcessProof: 'not-established', workerDeathInferred: false, redispatchAllowed: false, claim: {...CLAIM}}}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['recordDispatchIntent', child => { child.reply({status: 'error', phase: HOSTILE, code: 'STORE_BUSY'}); child.finish(0); }, 'REPLY_MALFORMED'],
      ['inspect', child => {
        child.send(`{"v":1,"correlation":"${child.request.correlation}","operation":"inspect","status":"rejected","code":"${BOUNDARY_CODE}","__proto__":{}}\n`);
        child.finish(0);
      }, 'REPLY_MALFORMED'],
      ['inspect', child => { child.reply(REFUSAL, {correlation: 'x'.repeat(32)}); child.finish(0); }, 'REPLY_MISMATCH'],
      ['inspect', child => { child.reply(REFUSAL, {correlation: HOSTILE}); child.finish(0); }, 'REPLY_MISMATCH'],
      ['inspect', child => { child.reply(REFUSAL, {operation: 'reserve'}); child.finish(0); }, 'REPLY_MISMATCH'],
      ['inspect', child => { child.reply(REFUSAL, {operation: HOSTILE}); child.finish(0); }, 'REPLY_MISMATCH'],
      ['inspect', child => { child.reply(REFUSAL); child.reply(REFUSAL); child.finish(0); }, 'REPLY_DUPLICATE'],
      ['inspect', child => { child.finish(0); }, 'REPLY_MISSING'],
      ['inspect', child => { child.reply(REFUSAL); child.finish(1); }, 'CHILD_EXIT_UNCLEAN'],
      ['inspect', child => { child.reply(REFUSAL); child.finish(null, 'SIGTERM'); }, 'CHILD_EXIT_UNCLEAN'],
    ];
    for (const [operation, script, code] of cases) {
      const {supervisor} = fakeSupervisor(script);
      const outcome = await supervisor.run(operation, argsJson(operation));
      assert.equal(outcome.outcome, 'unknown', `${code}: got ${outcome.outcome} ${outcome.code}`);
      assert.equal(outcome.code, code);
      assertNoAuthority(outcome);
      assertPrivate(outcome, ['toString']);
      assert.equal(supervisor.stats().active, 0);
    }
  });

  test('reply validation has an exception barrier and never throws', () => {
    const throwing = {toString() { throw new Error(REQUEST_ID); }, valueOf() { throw new Error(REQUEST_ID); }};
    const line = Buffer.from(`${JSON.stringify({v: 1, correlation: 'c'.repeat(32), operation: 'inspect', ...REFUSAL})}\n`);
    const results = [
      _testing.parseReply(line, {correlation: throwing, operation: 'inspect'}),
      _testing.parseReply({get length() { throw new Error(REQUEST_ID); }}, {correlation: 'c'.repeat(32), operation: 'inspect'}),
      _testing.parseReply(line, undefined),
    ];
    for (const result of results) {
      assert.equal(result.ok, false);
      assert.equal(result.code, 'REPLY_MALFORMED');
      assertPrivate(result);
    }
    const trap = new Proxy({}, {get() { throw new Error(REQUEST_ID); }, ownKeys() { throw new Error(REQUEST_ID); },
      getPrototypeOf() { throw new Error(REQUEST_ID); }});
    for (const operation of ALLOWED_OPERATIONS) {
      assert.equal(_testing.validateResult(operation, trap), false);
      assert.equal(_testing.validateResult(operation, {claim: {requestKey: throwing}}), false);
    }
    assert.equal(_testing.validateResult(throwing, {found: false}), false);
  });

  // ---------- Kill, late output, slots ----------

  test('an oversized reply kills the child and is unknown after exit is observed', async () => {
    const {supervisor, children} = fakeSupervisor(child => {
      child.onKill = () => child.exitNow(null, 'SIGKILL');
      child.send('x'.repeat(300));
    }, {maxReplyBytes: 256});
    const outcome = await supervisor.run('recordDispatchIntent', argsJson('recordDispatchIntent'));
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(outcome.code, 'REPLY_OVERSIZED');
    assert.equal(outcome.childState, 'exit-observed');
    assert.equal(outcome.commitState, 'unknown');
    assert.deepEqual(children[0].killSignals, ['SIGKILL']);
    assert.equal(supervisor.stats().active, 0);
  });

  test('a reply arriving after the deadline timer is dropped; the outcome stays unknown', async () => {
    const {supervisor, children} = fakeSupervisor(child => {
      child.onKill = () => { child.reply(REFUSAL); child.finish(null, 'SIGKILL'); };
    });
    const outcome = await supervisor.run('inspect', argsJson());
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(outcome.code, 'CHILD_TIMEOUT');
    assert.equal(outcome.childState, 'exit-observed');
    assert.deepEqual(children[0].killSignals, ['SIGKILL']);
    assert.equal(children.length, 1, 'no retry');
  });

  test('an unconfirmed exit stays unresolved and keeps its concurrency slot until exit is observed', async () => {
    const {supervisor, children} = fakeSupervisor(() => {}, {maxConcurrent: 1});
    const outcome = await supervisor.run('recordDispatchIntent', argsJson('recordDispatchIntent'));
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(outcome.code, 'CHILD_TIMEOUT');
    assert.equal(outcome.childState, 'exit-unconfirmed');
    assert.equal(outcome.commitState, 'unknown');
    assert.deepEqual(children[0].killSignals, ['SIGKILL']);
    assert.equal(supervisor.stats().active, 1);
    assert.equal((await supervisor.run('inspect', argsJson())).code, 'SUPERVISOR_BUSY');
    assert.equal(children.length, 1);
    children[0].exitNow(null, 'SIGKILL');
    assert.equal(supervisor.stats().active, 0);
  });

  test('spawn failures are not-started and release the slot', async () => {
    const throwing = _testing.createSupervisor({storePath: fakeStorePath()}, {spawnImpl: () => { throw new Error(`boom ${REQUEST_ID}`); }});
    let outcome = await throwing.run('inspect', argsJson());
    assert.equal(outcome.code, 'CHILD_SPAWN_FAILED');
    assert.equal(outcome.childState, 'not-started');
    assertPrivate(outcome);
    assert.equal(throwing.stats().active, 0);
    const erroring = _testing.createSupervisor({storePath: fakeStorePath()}, {spawnImpl: () => {
      const child = new FakeChild(() => {}, {emitSpawn: false});
      setImmediate(() => child.emit('error', new Error('ENOENT')));
      return child;
    }});
    outcome = await erroring.run('inspect', argsJson());
    assert.equal(outcome.code, 'CHILD_SPAWN_FAILED');
    assert.equal(erroring.stats().active, 0);
  });

  test('concurrency cap: two runs complete definitively, the third is refused without spawning', async () => {
    const {supervisor, children} = fakeSupervisor(() => {}, {maxConcurrent: 2, deadlineMs: 10000, busyTimeoutMs: 50});
    const first = supervisor.run('inspect', argsJson());
    const second = supervisor.run('inspect', argsJson());
    const third = await supervisor.run('inspect', argsJson());
    assert.equal(third.code, 'SUPERVISOR_BUSY');
    assert.equal(supervisor.stats().active, 2);
    for (let count = 0; count < 1000 && children.some(child => child.request === null || !child.spawned); count++) await tick();
    assert.ok(children.every(child => child.request !== null && child.spawned), 'fake children did not reach spawned state');
    for (const child of children) { child.reply(REFUSAL); child.finish(0); }
    for (const outcome of [await first, await second]) {
      assert.equal(outcome.outcome, 'rejected', outcome.code);
      assert.equal(outcome.code, BOUNDARY_CODE);
      assert.equal(outcome.childState, 'exited');
    }
    assert.equal(children.length, 2);
    assert.equal(supervisor.stats().active, 0);
  });

  // ---------- Preflight sketch (in-process, disposable stores, authorizes nothing) ----------

  test('preflight sketch accepts a fresh registry store as a snapshot that authorizes nothing', () => {
    const store = newStore();
    const result = preflightStore(store, 2048);
    assert.equal(result.ok, true);
    assert.equal(result.guarantee, 'snapshot-only');
    assert.equal(result.authorizes, false);
    assert.ok(result.pages >= 1 && result.pages <= 16);
  });

  test('preflight sketch refuses oversize, trailing pages, odd sizes, wrong page size and WAL', () => {
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

  test('preflight sketch refuses sidecars: any -wal or -shm, oversized or non-file -journal', () => {
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
    assert.equal(preflightStore(smallJournal, 2048).ok, true, 'a size check alone accepts a journal; this is why it cannot authorize recovery');
  });

  test('preflight sketch path limits: relative, missing, directory, links and substitution after the snapshot', t => {
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

    const linkedDir = join(freshDir(), 'linked');
    try { symlinkSync(dirname(target), linkedDir, 'junction'); }
    catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') { t.diagnostic('directory link creation not permitted; skipped'); return; } throw error; }
    assert.equal(preflightStore(join(linkedDir, 'claims.sqlite'), 2048).code, 'PREFLIGHT_PATH');
  });

  // ---------- Real child cases (spawn process.execPath) ----------

  test('real child: every operation is refused before SQLite opens, for every store state; nothing changes', async () => {
    const states = {
      fresh: () => newStore(),
      oversized: () => { const path = newStore(); appendFileSync(path, Buffer.alloc(4096 * 64)); return path; },
      'wal sidecar': () => { const path = newStore(); writeFileSync(`${path}-wal`, ''); return path; },
      'leftover journal': () => { const path = newStore(); writeFileSync(`${path}-journal`, Buffer.alloc(512)); return path; },
      missing: () => join(freshDir(), 'absent.sqlite'),
    };
    for (const [name, make] of Object.entries(states)) {
      const store = make();
      const dir = dirname(store);
      const before = snapshotDir(dir);
      const calls = [];
      const supervisor = _testing.createSupervisor(realOptions(store, {maxPages: 16}), {spawnImpl: recordingSpawn(calls)});
      const operations = name === 'fresh' ? ALLOWED_OPERATIONS : ['inspect', 'reserve'];
      for (const operation of operations) {
        const outcome = await supervisor.run(operation, argsJson(operation));
        assert.equal(outcome.outcome, 'rejected', `${name}/${operation}: ${outcome.code}`);
        assert.equal(outcome.code, BOUNDARY_CODE);
        assert.equal(outcome.childState, 'exited');
        assert.equal(outcome.commitState, 'none');
        assertNoAuthority(outcome);
        assertPrivate(outcome, [store]);
      }
      assert.equal(snapshotDir(dir), before, `${name}: store directory changed`);
      assert.equal(calls.length, operations.length);
      for (const call of calls) { assertSpawnShape(call); assertPrivate(call.args, [OWNER]); }
      assert.equal(supervisor.stats().active, 0);
    }
  });

  test('real child: a hung child is killed at the deadline, exit is observed, no retry, store unchanged', async () => {
    const store = newStore();
    const before = snapshotDir(dirname(store));
    const marker = join(freshDir(), 'marker-hang');
    const calls = [];
    const supervisor = _testing.createSupervisor(realOptions(store, {deadlineMs: 4000}),
      {spawnImpl: recordingSpawn(calls, {mode: 'hang', marker})});
    const outcome = await supervisor.run('recordDispatchIntent', argsJson('recordDispatchIntent'));
    assert.ok(existsSync(marker), 'fixture did not read its request before the deadline');
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(outcome.code, 'CHILD_TIMEOUT');
    assert.equal(outcome.childState, 'exit-observed');
    assert.equal(outcome.commitState, 'unknown');
    assertNoAuthority(outcome);
    assert.equal(calls.length, 1, 'no automatic retry');
    assert.equal(supervisor.stats().active, 0);
    assert.equal(snapshotDir(dirname(store)), before);
  });

  test('real child: complete valid output without an exit is not definitive', async () => {
    const store = newStore();
    const marker = join(freshDir(), 'marker-reply-hang');
    const supervisor = _testing.createSupervisor(realOptions(store, {deadlineMs: 4000}),
      {spawnImpl: recordingSpawn([], {mode: 'reply-hang', marker})});
    const outcome = await supervisor.run('inspect', argsJson());
    assert.ok(existsSync(marker));
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(outcome.code, 'CHILD_TIMEOUT');
    assert.equal(outcome.childState, 'exit-observed');
    assert.equal(supervisor.stats().active, 0);
  });

  test('real child: valid output with an unclean exit, and a clean exit with no reply, are unknown', async () => {
    const store = newStore();
    const unclean = _testing.createSupervisor(realOptions(store),
      {spawnImpl: recordingSpawn([], {mode: 'reply-exit1', marker: join(freshDir(), 'marker-exit1')})});
    let outcome = await unclean.run('inspect', argsJson());
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(outcome.code, 'CHILD_EXIT_UNCLEAN');
    const lost = _testing.createSupervisor(realOptions(store),
      {spawnImpl: recordingSpawn([], {mode: 'exit', marker: join(freshDir(), 'marker-exit')})});
    outcome = await lost.run('recordDispatchIntent', argsJson('recordDispatchIntent'));
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(outcome.code, 'REPLY_MISSING');
    assert.equal(outcome.commitState, 'unknown');
  });

  test('real child: malformed or oversized stdin exits non-zero with no output; a valid request is refused', async () => {
    const runRaw = input => new Promise(resolve => {
      const child = spawn(process.execPath, [CHILD_ENTRY], {cwd: dirname(CHILD_ENTRY), env: childEnvironment(),
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']});
      const out = [];
      child.stdout.on('data', chunk => out.push(chunk));
      child.stdin.on('error', () => {});
      child.on('close', code => resolve({code, stdout: Buffer.concat(out).toString('utf8')}));
      child.stdin.end(input);
    });
    const envelope = {v: 1, correlation: 'c'.repeat(32), operation: 'inspect', args: {...ARGS_BY_OPERATION.inspect},
      store: {path: join(root, 'none.sqlite'), maxPages: 2048, maxRows: 1024, busyTimeoutMs: 100}};
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
    const valid = await runRaw(`${JSON.stringify(envelope)}\n`);
    assert.equal(valid.code, 0);
    assert.deepEqual(JSON.parse(valid.stdout), {v: 1, correlation: 'c'.repeat(32), operation: 'inspect', ...REFUSAL});
    assert.equal(existsSync(join(root, 'none.sqlite')), false);
  });
}
