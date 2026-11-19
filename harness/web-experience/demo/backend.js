// Synthetic in-memory workspace for the interactive candidate.
//
// This is a DEMO ADAPTER, not a backend. It mirrors the response shapes and refusal rules of
// harness/server.mjs closely enough to click through every state, including failures. It runs no
// model, opens no socket, reads no file and never touches the real workspace database.
// Rules mirrored here (retry holds, attention reasons, copy holds, terminal leases, keyed run
// submissions, signed removal previews) are checked against the harness modules in
// test/compat.test.mjs so the two cannot drift silently. Receipts and readiness are real host
// output generated into host-fixtures.js.

import {ROUTES, SEED_TASKS, DIAGNOSTICS} from './fixtures.js';
import {HOST_RECEIPTS, HOST_COMPARISONS, HOST_READINESS} from './host-fixtures.js';
// Pinned, byte-identical copies of reviewed host modules (test/vendor.test.mjs checks the hashes).
import {describeCostDifference} from '../vendor/cost-presentation.mjs';
import {planHandoffImportReview} from '../vendor/portable-import-review-planner.mjs';
import {unifiedPatch as hostPatch} from '../vendor/patch.mjs';

const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const clone = value => structuredClone(value);
const LEASE_MS = 15000;
const REMOVAL_MS = 300000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const RUN_FIELDS = new Set(['requestId', 'version', 'sourceHash', 'approve', 'model', 'engine', 'backend', 'modelDigest', 'modelFingerprint', 'routeRevision']);
const INVENTORY_TTL_MS = 30000;

// Mirrors harness/route-inventory.mjs facts(): the host's material route facts for one route.
// Permissions are not in the host formula, so a permission change alone does not move the revision;
// the client compares facts as well and still catches it.
export async function routeRevisionOf(route, sha256) {
  const llama = route.backend === 'llamacpp', fixture = route.engine === 'fixture';
  return sha256(JSON.stringify(['local-preview-route-facts-v1', route.id, route.engine, route.backend, route.endpoint ?? null,
    !fixture && !llama ? route.identity?.value ?? null : null, llama ? route.identity?.value ?? null : null, route.bytes ?? null, route.quantization ?? null,
    route.remote ?? null, route.cloudDisabled ?? null, route.readiness?.eligible === true, route.readiness?.reason ?? null]));
}
const SCRIPTS = {
  fixture: {dispatchAt: 700, outputFrom: 1500, outputUntil: 3500, doneAt: 4200, lines: [[700, 'Generating a synthetic sample. No model is running.']]},
  opencode: {dispatchAt: 1500, outputFrom: 9000, outputUntil: 34000, doneAt: 36000, lines: [
    [1500, 'Starting OpenCode with tools denied.'], [3000, 'OpenCode session started.'], [5000, 'Model loaded. Processing context.'],
    [9000, 'Receiving output.'], [20000, 'Still generating. Output is arriving.'], [34000, 'Output complete. Validating the proposal.']]},
};

// ---- Rules mirrored from the harness (see file header) --------------------------------------

export function retryHold(task) {
  const attempt = task.attempts?.at(-1);
  if (!['interrupted', 'failed', 'cancelled'].includes(task.status)) return null;
  if (!attempt) return task.status === 'interrupted'
    ? 'The earlier run has no recoverable attempt record. A retry is held until its outcome is reconciled.' : null;
  if (attempt.recovery?.state === 'unresolved') return attempt.recovery.message;
  if (attempt.provider !== 'fixture' && ['failed', 'cancelled'].includes(task.status) &&
      !['claimed', 'settled'].includes(attempt.execution?.phase) && attempt.recovery?.state !== 'retry-safe')
    return 'This earlier attempt has no recorded completion evidence. A retry is held until its outcome is reconciled.';
  if (task.status === 'interrupted' && attempt.recovery?.state !== 'retry-safe')
    return 'The previous run outcome is unknown. A retry is held until the earlier request is reconciled.';
  return null;
}

export function attentionFor(task) {
  const reasons = [];
  if (task.status === 'draft') reasons.push('Approval needed');
  if (task.status === 'review') {
    reasons.push('Proposal needs review');
    if (task.attempts?.at(-1)?.checks?.some(check => !check.pass)) reasons.push('A check failed');
  }
  if (task.status === 'failed') reasons.push('Run failed');
  if (task.status === 'interrupted') reasons.push('Run interrupted');
  if (retryHold(task)) reasons.push('Earlier outcome needs recovery');
  return reasons.length ? {id: task.id, title: task.title, status: task.status, reasons} : null;
}

const SETTLED = new Set(['review', 'accepted', 'rejected', 'failed', 'cancelled', 'interrupted']);
export function draftCopyHold(task, {active = false} = {}) {
  if (active || ['running', 'cancelling'].includes(task?.status)) return 'Wait for this task to finish and confirm its outcome before copying it.';
  if (!task || !['draft', ...SETTLED].includes(task.status) || !Array.isArray(task.attempts))
    return 'The saved task state is incomplete. Review its records before copying it.';
  if (task.status === 'draft' && task.attempts.length) return 'The draft has unexpected attempt records. Review them before copying it.';
  if (task.status !== 'draft' && !task.attempts.length) return 'The earlier attempt record is missing. Reconcile the task before copying it.';
  for (const attempt of task.attempts) {
    if (!attempt || !SETTLED.has(attempt.status) || attempt.recovery?.state === 'unresolved')
      return 'An earlier attempt is active or unresolved. Reconcile it before copying this task.';
    if (attempt.provider !== 'fixture' && !['claimed', 'settled'].includes(attempt.execution?.phase) && attempt.recovery?.state !== 'retry-safe')
      return 'An earlier external request has no recorded completion evidence. Reconcile it before copying this task.';
  }
  return null;
}

// Mirrors harness/terminal-control.mjs: a per-attempt control lease, never a shell.
export function createDemoLease(attemptId, {clock, token, timeout = LEASE_MS}) {
  let lease, generation = 0, closed = false;
  const deny = message => fail(409, message);
  const revoke = () => { if (lease) { lease = undefined; generation++; } };
  const sample = () => { if (lease && clock() >= lease.end) revoke(); };
  return {
    snapshot() { sample(); return {attemptId, generation, owner: lease ? 'Operator' : 'None', closed}; },
    holder() { sample(); return lease?.holder ?? null; },
    // Lock releases any lease without closing the control channel (harness active.control.revoke()).
    revoke() { revoke(); },
    close() { closed = true; revoke(); },
    command(data, holder = 'this-view') {
      sample();
      if (closed) deny('This terminal is stopping or finished.');
      if (data?.attemptId !== attemptId) deny('The terminal attempt changed. Refresh and review the current run.');
      if (!Number.isSafeInteger(data.generation) || data.generation !== generation) deny('Terminal ownership changed. Refresh before taking another action.');
      if (data.command === 'take') {
        if (lease && data.confirm !== true) deny('Another view controls this terminal. Confirm takeover after refreshing.');
        const transferred = !!lease;
        lease = {id: token(), end: clock() + timeout, holder};
        generation++;
        return {response: {lease: lease.id, attemptId, generation},
          message: transferred ? 'Operator transferred control to this view.' : 'Operator took control.'};
      }
      if (!lease || typeof data.lease !== 'string' || data.lease !== lease.id) deny('Terminal control expired or belongs to another view.');
      if (data.command === 'heartbeat') { lease.end = clock() + timeout; return {response: {accepted: true}}; }
      if (data.command === 'release' || data.command === 'detach') {
        revoke();
        return {response: {accepted: true}, message: data.command === 'release' ? 'Operator released control.' : 'Operator detached. OpenCode continues.'};
      }
      if (data.command === 'status') return {response: {accepted: true}, message: 'OpenCode is running.'};
      if (data.command === 'stop' && data.confirm === true) {
        closed = true; revoke();
        return {response: {accepted: true}, message: 'Operator requested Stop.', stop: true};
      }
      fail(400, 'Choose a supported terminal control.');
    },
  };
}

// Mirrors harness/run-submission.mjs prepareRunSubmission, including its fingerprint. The demo
// accepts keyed requests only; the host also accepts legacy unkeyed ones, which this candidate never
// sends. The caller's object is not modified. test/compat.test.mjs compares this with the host.
export async function prepareRunSubmission(taskId, data, sha256) {
  const invalid = () => fail(400, 'Use a valid, scope-bound run submission.');
  const revision = data && typeof data === 'object' && Object.hasOwn(data, 'routeRevision') ? data.routeRevision : undefined;
  if (data && typeof data === 'object' && Object.hasOwn(data, 'routeRevision') && (typeof revision !== 'string' || !DIGEST.test(revision))) invalid();
  if (!data || typeof data !== 'object' || !UUID.test(data.requestId ?? '') || !UUID.test(taskId ?? '') || Object.keys(data).some(key => !RUN_FIELDS.has(key)) ||
      data.approve !== true || !Number.isSafeInteger(data.version) || data.version < 0 || !DIGEST.test(data.sourceHash ?? '') ||
      typeof data.model !== 'string' || !data.model.trim() || data.model.length > 100) invalid();
  const engine = data.engine ?? (data.model === 'fixture' ? 'fixture' : 'ollama');
  const backend = data.backend ?? (engine === 'fixture' ? 'fixture' : 'ollama');
  if (!['fixture', 'ollama', 'opencode'].includes(engine) || (engine === 'fixture') !== (data.model === 'fixture') ||
      !['fixture', 'ollama', 'llamacpp'].includes(backend) || (backend === 'fixture') !== (engine === 'fixture') ||
      (backend === 'llamacpp' && engine !== 'opencode')) invalid();
  for (const field of ['modelDigest', 'modelFingerprint']) if (data[field] != null && !DIGEST.test(data[field])) invalid();
  if (engine !== 'fixture' && !(backend === 'llamacpp' ? data.modelFingerprint : data.modelDigest)) invalid();
  const binding = [taskId, data.version, data.sourceHash, data.model, engine, backend, data.modelDigest ?? null, data.modelFingerprint ?? null];
  if (revision !== undefined) binding.push(['routeRevision', revision]);
  const fingerprint = await sha256(JSON.stringify(binding));
  return {requestId: data.requestId, fingerprint, engine, backend, routeRevision: revision};
}

// ---- Synthetic results -----------------------------------------------------------------------

function unifiedPatch(filename, before, after) {
  const a = before.split('\n'), b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  return ['--- a/' + filename, '+++ b/' + filename, '@@ line ' + (start + 1) + ' @@',
    ...a.slice(start, endA).map(line => '-' + line), ...b.slice(start, endB).map(line => '+' + line)].join('\n');
}

function synthesize(task) {
  if (task.kind === 'change') {
    const content = task.source.includes(task.expected) ? task.source + '# reviewed\n' : task.source.replace(/\s*$/, '') + '\n' + task.expected + '\n';
    return {summary: 'Synthetic sample: the expected text was added. No model produced this.', content};
  }
  const lines = task.source.split(/\n+/).filter(line => line.trim());
  const content = lines.slice(0, 3).map((line, index) => '- ' + line.trim().slice(0, 140) + ' [' + (index + 1) + ']').join('\n') +
    '\nOpen decision: read the cited lines before relying on this summary.';
  return {summary: 'Synthetic sample brief with citations to the supplied lines. No model produced this.', content};
}

function structuralChecks(task, content) {
  return task.kind === 'change'
    ? [{name: 'Proposed content differs from the approved snapshot', pass: content !== task.source},
      {name: 'Contains the operator’s expected text', pass: content.includes(task.expected)}]
    : [{name: 'Every citation points to a supplied source and at least one is present', pass: (() => {
      const refs = [...content.matchAll(/\[(\d+)\]/g)];
      const count = task.source.split(/\n+/).filter(line => line.trim()).length;
      return refs.length > 0 && refs.every(ref => +ref[1] >= 1 && +ref[1] <= count);
    })()}];
}

// ---- Backend ---------------------------------------------------------------------------------

export async function createDemoBackend({now: wallClock = () => Date.now(), sha256, uuid = () => globalThis.crypto.randomUUID(), profile = 'returning'} = {}) {
  if (typeof sha256 !== 'function') throw Error('A sha256 function is required.');
  // Removal expiry has its own clock so the demo can expire a preview without distorting run times.
  let removalSkew = 0;
  const now = wallClock, removalNow = () => wallClock() + removalSkew;
  const iso = (time = now()) => new Date(time).toISOString();
  const tasks = new Map(), copies = new Map(), removalAudit = [];
  const removalSecret = uuid();
  const faults = {offline: false, unlockDenied: false, stopExitUnobserved: false, nextRunFails: false, stall: false,
    loseNextCopyResponse: false, loseNextRunResponse: false, loseNextLockResponse: false};
  const counters = {removalPreviews: 0, runRequests: 0, runSubmissionLookups: 0, locks: 0, downloads: 0};
  const routes = clone(ROUTES);
  // routeRevision is a demo bookkeeping counter and is never returned. Returned revisions are content
  // hashes computed by routeRevisionOf, like the host's.
  let unlocked = false, active = null, routeRevision = 1, routeEvidenceAt = now(), routesStale = false;

  const routeByKey = key => routes.find(route => route.key === key);
  const routeView = route => ({...clone(route),
    readiness: routesStale && route.readiness.eligible && route.engine !== 'fixture'
      ? {eligible: false, reason: 'Readiness evidence is older than its 5 minute window. Refresh routes.'} : clone(route.readiness)});
  const removalSignature = (task, expiresAt) => sha256(JSON.stringify(['workspace-record-only-v1', removalSecret, task.id, task.version, expiresAt]));

  function gate() {
    if (faults.offline) throw Object.assign(new TypeError('The local workspace did not respond (simulated).'), {offline: true});
    if (!unlocked) fail(401, 'Unlock this workspace to continue.');
  }
  function save(task, event) {
    task.version++;
    task.updated = iso();
    task.events.push({seq: task.version, at: task.updated, event});
  }
  function get(id) { const task = tasks.get(id); if (!task) fail(404, 'Task not found.'); return task; }
  function view(task) {
    const run = active?.taskId === task.id ? active : null;
    const hold = retryHold(task), copyHold = draftCopyHold(task, {active: !!run});
    const control = run?.control.snapshot();
    return {...clone(publicTask(task)), copy: {allowed: !copyHold, reason: copyHold}, recovery: hold ? {blocked: true, message: hold} : null,
      attention: attentionFor(task),
      live: run ? {chars: run.chars, heartbeat: iso(), lastActivity: run.lastActivity, stopping: run.stopping, terminal: clone(run.terminal),
        owner: control.owner, control, simulated: true} : null};
  }
  async function scope(data) {
    if (!['change', 'brief'].includes(data.kind)) fail(400, 'Choose a supported workflow.');
    const text = (value, max, label) => {
      if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'Enter ' + label + ' (up to ' + max.toLocaleString('en-US') + ' characters).');
      return value;
    };
    const request = text(data.request, 800, 'a request');
    const source = text(data.source, 5000, 'the source text');
    // Request text is never copied into the title: titles appear in standard exports.
    const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, 120) : data.kind === 'change' ? 'Untitled change' : 'Untitled brief';
    const filename = data.kind === 'change' ? text(data.filename, 100, 'a file name') : null;
    if (filename && (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(filename) || filename.endsWith('.'))) fail(400, 'Enter a single file name without folders.');
    const expected = data.kind === 'change' ? text(data.expected, 400, 'the expected text') : null;
    return {kind: data.kind, title, request, source, filename, expected, sourceHash: await sha256(source)};
  }
  function terminalLine(run, message) {
    if (run.terminal.at(-1)?.message === message) return;
    run.terminal.push({at: iso(), message});
  }
  async function attachArtifact(task, attempt, proposal) {
    const sha = await sha256(proposal.content);
    attempt.artifact = {summary: proposal.summary, content: proposal.content, sha256: sha,
      patch: task.kind === 'change' ? unifiedPatch(task.filename, task.source, proposal.content) : null};
    attempt.checks = structuralChecks(task, proposal.content);
  }
  function finish(task, run, status, {problem, phase, recovery} = {}) {
    const attempt = task.attempts.at(-1);
    run.control.close();
    task.status = attempt.status = status;
    if (problem) attempt.problem = problem;
    if (phase) attempt.execution.phase = phase;
    if (recovery) attempt.recovery = recovery;
    terminalLine(run, 'Attempt ' + status + '.');
    attempt.terminal = clone(run.terminal);
    attempt.ended = iso();
    attempt.elapsedMs = Date.parse(attempt.ended) - Date.parse(attempt.started);
    save(task, 'attempt.' + status);
    active = null;
  }

  // Advance the simulated run. Called on a timer in the browser and directly in tests.
  async function tick() {
    if (!active) return;
    const run = active, task = tasks.get(run.taskId), attempt = task.attempts.at(-1), script = SCRIPTS[run.script];
    const elapsed = now() - run.startedMs + run.skewMs;
    run.control.snapshot();
    if (run.stopping) {
      if (now() - run.stopAt < 2500) return;
      // Mirrors harness execute(): an abort after dispatch always leaves the provider outcome
      // unresolved (recordOutcomeUncertainty). Only an attempt that never dispatched, or the
      // in-process fixture, is safe to retry.
      const unresolved = {state: 'unresolved', at: iso(), evidence: 'no-terminal-evidence',
        message: 'The provider did not confirm that the earlier request settled. A retry is held until its outcome is reconciled.'};
      if (attempt.provider === 'fixture') finish(task, run, 'cancelled', {problem: 'Stopped. The synthetic fixture runs inside this workspace, so nothing remains active.'});
      else if (attempt.execution.phase === 'claimed') {
        terminalLine(run, 'Stopped before dispatch. Nothing was sent.');
        finish(task, run, 'cancelled', {problem: 'Stopped before dispatch. Nothing was sent to the route.'});
      } else if (faults.stopExitUnobserved) finish(task, run, 'cancelled', {recovery: unresolved,
        problem: 'CydeWorks AI ended its request. The local process exit was not observed and model server termination was not verified.'});
      else {
        terminalLine(run, 'OpenCode process exited.');
        finish(task, run, 'cancelled', {recovery: unresolved,
          problem: 'OpenCode process exit was observed. Local model server termination was not verified.'});
      }
      return;
    }
    // Mirrors the host's pre-dispatch route binding: a changed route revision ends the attempt as a
    // failed preflight while still claimed, which proves nothing was dispatched.
    if (attempt.execution.phase === 'claimed' && attempt.approvedRouteRevision) {
      const current = await routeRevisionOf(routeView(routes.find(item => item.key === attempt.routeKey)), sha256);
      if (current !== attempt.approvedRouteRevision) {
        terminalLine(run, 'Route changed after approval. Nothing was dispatched.');
        finish(task, run, 'failed', {problem: 'The selected route changed after approval (route revision mismatch). Nothing was dispatched. Refresh routes and approve again.'});
        return;
      }
      if (!attempt.observedRouteRevision) attempt.observedRouteRevision = current;
    }
    if (attempt.execution.phase === 'claimed' && elapsed >= script.dispatchAt) {
      attempt.execution.phase = 'dispatching';
      attempt.execution.dispatchedAt = iso();
      save(task, 'attempt.dispatching');
    }
    for (const [at, message] of script.lines) if (elapsed >= at && !run.said.has(at)) { run.said.add(at); terminalLine(run, message); }
    if (faults.nextRunFails && elapsed >= script.dispatchAt + 600) {
      faults.nextRunFails = false;
      finish(task, run, 'failed', {problem: 'The synthetic route returned an invalid proposal (simulated failure).', phase: 'settled'});
      return;
    }
    if (!faults.stall && elapsed >= script.outputFrom) {
      const share = Math.min(1, (elapsed - script.outputFrom) / (script.outputUntil - script.outputFrom));
      const chars = Math.round(run.proposal.content.length * share);
      if (chars !== run.chars) { run.chars = chars; run.lastActivity = iso(); }
    }
    if (!faults.stall && elapsed >= script.doneAt) {
      await attachArtifact(task, attempt, run.proposal);
      attempt.usage = run.script === 'fixture' ? {evidence: 'synthetic'}
        : {evidence: 'OpenCode reported', input: 1840, output: Math.ceil(run.proposal.content.length / 4), cached: 0, cacheWrite: null, reasoning: null};
      attempt.claims = run.script === 'fixture' ? [] : [
        {text: 'The change is complete and safe to apply.', why: 'This is the model’s own statement. Nothing was executed to confirm it.'},
        {text: 'Existing tests still pass.', why: 'No test runner is connected. No test was run.'}];
      finish(task, run, attempt.checks.every(check => check.pass) || attempt.artifact ? 'review' : 'failed', {phase: 'settled'});
    }
  }

  const submissionResult = (task, attempt, replayed) => ({requestId: attempt.submission.requestId, taskId: task.id, attemptId: attempt.id,
    attemptStatus: attempt.status, replayed, executionAuthorized: false});
  const publicTask = task => ({...task, attempts: task.attempts.map(({submission, ...visible}) => visible)});

  const api = {
    // -- session --
    async session() {
      if (faults.offline) throw Object.assign(new TypeError('The local workspace did not respond (simulated).'), {offline: true});
      return {unlocked, firstUse: tasks.size === 0 && profile === 'first-use'};
    },
    async unlock() {
      if (faults.offline) throw Object.assign(new TypeError('The local workspace did not respond (simulated).'), {offline: true});
      if (faults.unlockDenied) { faults.unlockDenied = false; fail(401, 'That file is not this workspace’s access key.'); }
      unlocked = true;
      return {authorized: true};
    },
    // Mirrors POST /api/session/lock: every view is locked, terminal control is released without
    // closing the channel, and approved work keeps running.
    async lock(data = {}) {
      gate();
      if (!data || typeof data !== 'object' || Object.keys(data).length) fail(400, 'Use an empty object to lock the workspace.');
      counters.locks++;
      unlocked = false;
      active?.control.revoke();
      if (faults.loseNextLockResponse) {
        faults.loseNextLockResponse = false;
        throw Object.assign(new TypeError('The response was lost (simulated).'), {offline: true});
      }
      return {locked: true, scope: 'all-workspace-views', terminalControlReleased: true, stopsWork: false, requiresAccessFile: true};
    },

    // -- tasks --
    async listTasks() {
      gate();
      return {tasks: [...tasks.values()].sort((a, b) => b.updated.localeCompare(a.updated))
        .map(task => ({id: task.id, title: task.title, kind: task.kind, status: task.status, updated: task.updated,
          attempts: task.attempts.length, attention: attentionFor(task)}))};
    },
    async getTask(id) { gate(); return view(get(id)); },
    async createTask(data) {
      gate();
      if (tasks.size >= 100) fail(409, 'This workspace has reached its 100-task capacity.');
      const task = {id: uuid(), version: 0, status: 'draft', ...await scope(data), model: null, attempts: [], events: [], approvals: [], updated: iso()};
      tasks.set(task.id, task);
      save(task, 'task.created');
      return view(task);
    },
    async updateScope(id, data) {
      gate();
      const task = get(id);
      if (data.version !== task.version) fail(409, 'This task changed. Refresh and review its current state.');
      if (task.status !== 'draft') fail(409, 'Create a new task to change an already approved scope.');
      Object.assign(task, await scope(data));
      save(task, 'scope.updated');
      return view(task);
    },

    // -- routes --
    async listRoutes(taskId) {
      gate();
      const task = taskId ? tasks.get(taskId) : null;
      const list = await Promise.all(routes.map(async route => { const view = routeView(route); return {...view, revision: await routeRevisionOf(view, sha256)}; }));
      const last = task?.attempts.at(-1)?.routeKey;
      const pick = list.find(route => route.key === last && route.readiness.eligible) ??
        list.find(route => route.readiness.eligible && route.engine !== 'fixture') ?? list.find(route => route.readiness.eligible);
      // Like the host, every read is a fresh observation with a 30 second freshness window.
      const observed = now();
      return {observedAt: iso(observed), expiresAt: iso(observed + INVENTORY_TTL_MS), revisionKind: 'route-facts-sha256-v1',
        revision: await sha256(JSON.stringify(['local-preview-route-facts-v1', list.map(route => route.revision).sort()])), executionAuthorized: false, routes: list,
        diagnostics: {messages: [{code: 'cloud_enabled', text: 'Ollama reports cloud features enabled. Ollama routes are held.'}]},
        suggestion: pick ? {routeKey: pick.key, designSample: true,
          reasons: [last === pick.key ? 'You used this route for the previous attempt on this task.' : 'It is the first ready route that runs a model on this computer.',
            'The approved text stays on loopback. No remote endpoint is involved.', 'No provider charge applies. Metered routes are never chosen for you.'],
          evidence: [{label: 'Readiness', value: pick.readiness.reason}, {label: 'Model identity', value: pick.identity.note},
            {label: 'Evidence observed', value: iso(observed)}]} : null};
    },
    async refreshRoutes(taskId) { gate(); routesStale = false; routeEvidenceAt = now(); return api.listRoutes(taskId); },

    // -- execution --
    // Mirrors harness/run-submission.mjs and the /run handler: a keyed body, a fingerprint over the
    // approved inputs, exact replay without a new attempt, 409 for a reused ID with different inputs,
    // then the host's ordinary version, scope, availability and identity checks.
    async run(id, data) {
      gate();
      counters.runRequests++;
      const task = get(id);
      const {engine, backend, routeRevision: approvedRouteRevision, ...submission} = await prepareRunSubmission(id, data, sha256);
      const recorded = task.attempts.filter(attempt => attempt.submission?.requestId === submission.requestId);
      if (recorded.length > 1) fail(409, 'The run submission record is ambiguous. Review this task.');
      if (recorded.length) {
        if (recorded[0].submission.fingerprint !== submission.fingerprint)
          fail(409, 'This run submission ID belongs to different approved inputs. Review the task before submitting new work.');
        return {...view(task), runSubmission: submissionResult(task, recorded[0], true)};
      }
      if (data.version !== task.version) fail(409, 'This task changed. Refresh and review its current state.');
      if (active) fail(409, 'Another attempt is still active.');
      if (['running', 'cancelling', 'review'].includes(task.status)) fail(409, 'Resolve the current attempt before starting another.');
      const hold = retryHold(task);
      if (hold) fail(409, hold);
      if (task.attempts.length >= 20) fail(409, 'This task has reached its 20-attempt capacity.');
      if (data.sourceHash !== task.sourceHash) fail(409, 'Confirm the current source snapshot.');
      const route = routes.find(item => item.engine === engine && item.backend === backend && item.id === data.model);
      if (!route || route.planned) fail(400, 'Choose a supported route.');
      if (!routeView(route).readiness.eligible) fail(409, routeView(route).readiness.reason);
      const approvedIdentity = route.engine === 'fixture' ? null : route.backend === 'llamacpp' ? data.modelFingerprint : data.modelDigest;
      if ((approvedIdentity ?? null) !== route.identity.value) fail(409, 'The model identity changed or is unavailable. Refresh routes and approve the current model again.');
      const attempt = {id: uuid(), model: route.id, provider: route.engine, backend: route.backend, routeKey: route.key, routeLabel: route.label,
        started: iso(), status: 'running', usage: null, cost: null, claims: [], execution: {phase: 'claimed', claimedAt: iso()}, submission,
        ...(approvedRouteRevision ? {approvedRouteRevision} : {})};
      task.model = route.id;
      task.attempts.push(attempt);
      task.status = 'running';
      task.approvals.push({at: iso(), attemptId: attempt.id, attemptNumber: task.attempts.length, routeLabel: route.label, routeType: route.type,
        destination: route.destination, sourceHash: task.sourceHash, identity: route.identity.value, identityKind: route.identity.kind,
        permissions: clone(route.permissions), use: 'Single use. Consumed by this attempt.'});
      save(task, 'attempt.approved_and_started');
      active = {taskId: id, script: route.script, startedMs: now(), skewMs: 0, chars: 0, lastActivity: iso(), terminal: [], said: new Set(),
        stopping: false, proposal: synthesize(task), control: createDemoLease(attempt.id, {clock: now, token: uuid})};
      terminalLine(active, 'Scope approved. Checking the selected route.');
      if (faults.loseNextRunResponse) {
        faults.loseNextRunResponse = false;
        throw Object.assign(new TypeError('The response was lost (simulated).'), {offline: true});
      }
      return {...view(task), runSubmission: submissionResult(task, attempt, false)};
    },
    async lookupRunSubmission(id, requestId) {
      gate();
      counters.runSubmissionLookups++;
      const task = get(id);
      if (typeof requestId !== 'string' || !UUID.test(requestId)) fail(400, 'Use a valid, scope-bound run submission.');
      const matches = task.attempts.filter(attempt => attempt.submission?.requestId === requestId);
      if (matches.length > 1) fail(409, 'The run submission record is ambiguous. Review this task.');
      if (!matches.length) fail(404, 'No recorded run submission was found.');
      return submissionResult(task, matches[0], true);
    },
    async cancel(id, data) {
      gate();
      const task = get(id);
      if (data.version !== task.version) fail(409, 'This task changed. Refresh and review its current state.');
      if (active?.taskId !== id || task.status !== 'running') fail(409, 'No active request can be cancelled.');
      if (task.attempts.at(-1).provider === 'opencode') fail(409, 'Use Stop in the terminal.');
      active.stopping = true; active.stopAt = now(); active.control.close();
      return {status: 'cancelling'};
    },
    async terminal(id, data, holder) {
      gate();
      const task = get(id);
      if (active?.taskId !== id || task.attempts.at(-1)?.provider !== 'opencode') fail(409, 'No active terminal.');
      const result = active.control.command(data, holder);
      if (result.message) terminalLine(active, result.message);
      if (result.stop) { active.stopping = true; active.stopAt = now(); }
      return result.response;
    },

    // -- review --
    async revise(id, data) {
      gate();
      const task = get(id), attempt = task.attempts.at(-1);
      if (data.version !== task.version) fail(409, 'This task changed. Refresh and review its current state.');
      if (task.status !== 'review' || !attempt?.artifact || data.artifactHash !== attempt.artifact.sha256) fail(409, 'The proposal changed or is no longer reviewable.');
      if (typeof data.content !== 'string' || !data.content.trim() || data.content.length > 12000) fail(400, 'Invalid proposal.');
      if (data.content === attempt.artifact.content) fail(400, 'The proposal has no changes to save.');
      if ((attempt.operatorEdits?.length ?? 0) >= 20) fail(409, 'This attempt has reached its edit limit.');
      const previous = attempt.artifact;
      attempt.originalArtifact ??= previous;
      attempt.operatorEdits ??= [];
      await attachArtifact(task, attempt, {summary: 'Edited by the operator. Review the changes and checks.', content: data.content});
      attempt.operatorEdits.push({previousHash: previous.sha256, artifactHash: attempt.artifact.sha256, at: iso()});
      save(task, 'proposal.operator_edited');
      return view(task);
    },
    async review(id, data) {
      gate();
      const task = get(id), attempt = task.attempts.at(-1);
      if (data.version !== task.version) fail(409, 'This task changed. Refresh and review its current state.');
      if (task.status !== 'review' || data.artifactHash !== attempt?.artifact?.sha256) fail(409, 'The proposal changed or is no longer reviewable.');
      if (!['accepted', 'rejected'].includes(data.decision)) fail(400, 'Choose Accept or Reject.');
      if (data.decision === 'accepted' && attempt.checks.some(check => !check.pass)) fail(409, 'Resolve failed checks before accepting.');
      task.status = attempt.status = data.decision;
      save(task, 'review.' + data.decision);
      return view(task);
    },

    // -- copy, export, removal --
    async copyDraft(id, data) {
      gate();
      const task = get(id);
      if (data.confirm !== true || !Number.isSafeInteger(data.version) || typeof data.requestId !== 'string') fail(400, 'Confirm the saved scope with a valid copy request.');
      let record = copies.get(data.requestId), reused = !!record;
      if (record) {
        if (record.sourceId !== id || record.sourceVersion !== data.version) fail(409, 'This copy request belongs to a different scope.');
        if (!tasks.has(record.draftId)) fail(410, 'The recorded copy was removed. This request cannot recreate it.');
      } else {
        if (task.version !== data.version) fail(409, 'The task changed. Review the current scope before copying.');
        const hold = draftCopyHold(task, {active: active?.taskId === id});
        if (hold) fail(409, hold);
        const draft = {id: uuid(), version: 0, status: 'draft', ...await scope({kind: task.kind, title: task.title.slice(0, 113) + ' (copy)',
          request: task.request, source: task.source, filename: task.filename, expected: task.expected}), model: null, attempts: [], events: [], approvals: [], updated: iso()};
        tasks.set(draft.id, draft);
        save(draft, 'task.copied_as_draft');
        record = {sourceId: id, sourceVersion: data.version, draftId: draft.id};
        copies.set(data.requestId, record);
      }
      if (faults.loseNextCopyResponse) {
        faults.loseNextCopyResponse = false;
        throw Object.assign(new TypeError('The response was lost (simulated).'), {offline: true});
      }
      return {task: view(tasks.get(record.draftId)), reused};
    },
    async lookupCopy(requestId) {
      gate();
      const record = copies.get(requestId);
      if (!record) fail(404, 'No saved copy result is visible.');
      if (!tasks.has(record.draftId)) fail(410, 'The recorded copy was removed.');
      return {taskId: record.draftId};
    },
    async exportPreview(id, mode = 'minimal') {
      gate();
      const task = get(id);
      const attempts = task.attempts.map(attempt => ({provider: attempt.provider, status: attempt.status, elapsedMs: attempt.elapsedMs ?? null,
        usage: {evidence: attempt.usage?.evidence ?? 'unavailable', input: attempt.usage?.input ?? null, output: attempt.usage?.output ?? null}}));
      if (mode === 'minimal') return {schema: 2, mode, synthetic: true, task: {kind: task.kind, status: task.status, attempts}};
      if (mode !== 'standard') fail(400, 'Choose a supported export mode.');
      return {schema: 1, mode, synthetic: true, task: {id: task.id, title: task.title, kind: task.kind, status: task.status, filename: task.filename,
        sourceHash: task.sourceHash, model: task.model, version: task.version, events: clone(task.events),
        attempts: task.attempts.map((attempt, index) => ({...attempts[index], id: attempt.id, model: attempt.model, started: attempt.started, ended: attempt.ended ?? null}))}};
    },
    async removalPreview(id) {
      gate();
      counters.removalPreviews++;
      const task = get(id);
      const hold = active?.taskId === id ? 'The task is still active. Stop it and confirm its outcome first.'
        : task.attempts.some(attempt => attempt.recovery?.state === 'unresolved') ? 'An earlier attempt is active or unresolved. Reconcile it before removing this record.' : null;
      const preview = {scope: 'workspace-record-only-v1', title: task.title, allowed: !hold, reason: hold, version: task.version,
        removes: ['The task record, including its title, request, source snapshot, proposals, checks, usage and task history, from the active workspace database.'],
        retains: ['Possible OpenCode working files in the local state folder.',
          'Other tasks (including saved copies), the access file, backups and provider copies.',
          'A minimal pseudonymous removal audit entry and draft-copy request references with task IDs but no task content.'],
        limitations: ['Database pages, journals and backups may retain recoverable copies. This action is not secure erasure.',
          'Local removal does not delete data held by a model provider.']};
      if (!hold) {
        preview.expiresAt = removalNow() + REMOVAL_MS;
        preview.token = await removalSignature(task, preview.expiresAt);
      }
      return preview;
    },
    // Mirrors harness/removal.mjs verifyRemoval: the token signs the task, version and exact expiry,
    // so a request without the preview's own expiresAt cannot verify.
    async remove(id, data) {
      gate();
      const task = get(id);
      if (active?.taskId === id) fail(409, 'The task is still active. Stop it and confirm its outcome first.');
      if (data?.version !== task.version) fail(409, 'The task changed. Review a new removal preview.');
      if (data.confirmation !== 'REMOVE') fail(409, 'Type REMOVE to confirm this exact removal.');
      if (!Number.isSafeInteger(data.expiresAt) || data.expiresAt < removalNow() || data.expiresAt > removalNow() + REMOVAL_MS)
        fail(409, 'The removal preview expired. Review a new preview.');
      if (typeof data.token !== 'string' || !DIGEST.test(data.token)) fail(409, 'The removal preview is invalid.');
      if (data.token !== await removalSignature(task, data.expiresAt)) fail(409, 'The removal preview is invalid or belongs to an earlier session.');
      tasks.delete(id);
      removalAudit.unshift({reference: (await sha256('task-removal:' + id)).slice(0, 16), removedAt: iso(), scope: 'workspace-record-only-v1'});
      return {removed: true, scope: 'workspace-record-only-v1'};
    },

    // Mirrors harness/artifact-download.mjs: only the current accepted proposal, bound to the exact
    // version, attempt and artifact hash. The patch is regenerated by the host's own unifiedPatch.
    async downloadArtifact(id, {version, attemptId, artifactHash, format = 'content'} = {}) {
      gate();
      counters.downloads++;
      if (!Number.isSafeInteger(version) || version < 0 || typeof attemptId !== 'string' || !UUID.test(attemptId) ||
          typeof artifactHash !== 'string' || !DIGEST.test(artifactHash) || !['content', 'patch'].includes(format))
        fail(400, 'Use a valid task version, attempt and accepted artifact hash.');
      const task = get(id), attempt = task.attempts.at(-1), artifact = attempt?.artifact;
      if (task.status !== 'accepted' || attempt?.status !== 'accepted' || version !== task.version || attemptId !== attempt?.id || artifactHash !== artifact?.sha256)
        fail(409, 'The accepted proposal changed or is unavailable. Refresh and review the task.');
      if (!attempt.checks?.length || attempt.checks.some(check => check?.pass !== true) || await sha256(artifact.content) !== artifact.sha256)
        fail(409, 'The accepted proposal record cannot be verified. Review the task before downloading.');
      let content = artifact.content, filename = task.kind === 'change' ? 'proposed-' + task.filename : 'brief.md';
      if (format === 'patch') {
        if (task.kind !== 'change') fail(400, 'Patch download is available only for file changes.');
        if (await sha256(task.source) !== task.sourceHash) fail(409, 'The source snapshot cannot be verified for this patch.');
        content = hostPatch(task.filename, task.source, artifact.content);
        filename = 'proposal.patch';
      }
      const bytes = new TextEncoder().encode(content);
      return {filename, bytes, sha256: await sha256(content), byteLength: bytes.length, format};
    },
    // Mirrors harness/contributor-api.mjs presentSubmittedCost, using the same reviewed formatter.
    async presentCost(input) {
      gate();
      const presentation = describeCostDifference(input);
      return {ok: presentation.reasonCode !== 'INVALID_INPUT', formatVersion: 1, scope: 'caller-supplied-cost-presentation',
        executionAuthorized: false, billingAuthenticated: false, presentation};
    },
    // Mirrors harness/contributor-api.mjs reviewSubmittedHandoff with the same reviewed planner. The
    // browser hands bytes directly instead of base64; the 32 artifact and 32 KiB limits are the same.
    async reviewHandoff({manifest, artifacts = []} = {}) {
      gate();
      const invalid = {ok: false, error: 'INVALID_HANDOFF_REQUEST', executionAuthorized: false};
      if (!Array.isArray(artifacts) || artifacts.length > 32) return invalid;
      let total = 0;
      const supplied = [];
      for (const item of artifacts) {
        const record = {artifactId: item?.artifactId};
        if (item?.claimedDigest !== undefined) record.claimedDigest = item.claimedDigest;
        if (item?.byteLength !== undefined) record.byteLength = item.byteLength;
        if (item?.bytes !== undefined) {
          if (!(item.bytes instanceof Uint8Array)) return invalid;
          total += item.bytes.length;
          if (total > 32768) return invalid;
          record.bytes = new Uint8Array(item.bytes);
        }
        supplied.push(record);
      }
      try {
        const result = planHandoffImportReview(manifest, {artifacts: supplied, existingTaskIds: [...tasks.keys()], existingManifestIds: []});
        return {...result, formatVersion: 1, executionAuthorized: false, persisted: false,
          destinationConflictCheck: 'current-workspace-task-ids-only', manifestHistoryChecked: false};
      } catch { return invalid; }
    },

    // -- read models for the other views --
    // A real response from harness/connection-host.mjs for a synthetic task, generated at build time.
    // It is the same for every task here; at integration it is read per task.
    async readiness() { gate(); return clone(HOST_READINESS); },
    // A real v2 envelope from harness/receipt-export.mjs for seeded tasks, unchanged. New demo tasks
    // have no generated envelope: the browser cannot run the host exporter.
    async receipt(id) { gate(); const task = get(id); return task.receiptKey ? clone(HOST_RECEIPTS[task.receiptKey].envelope) : null; },
    async receipts() {
      gate();
      const linked = [...tasks.values()].filter(task => task.receiptKey && HOST_RECEIPTS[task.receiptKey])
        .map(task => ({taskId: task.id, title: task.title, key: task.receiptKey, ...clone(HOST_RECEIPTS[task.receiptKey])}));
      return {receipts: linked, comparisons: clone(HOST_COMPARISONS).filter(pair => linked.some(r => r.key === pair.baseline) && linked.some(r => r.key === pair.candidate))};
    },
    async audit() {
      gate();
      const approvals = [...tasks.values()].flatMap(task => task.approvals.map(approval => ({...clone(approval), taskId: task.id, taskTitle: task.title})))
        .sort((a, b) => b.at.localeCompare(a.at));
      const decisions = [...tasks.values()].flatMap(task => task.events.filter(event => /^(review\.|proposal\.operator_edited|task\.copied)/.test(event.event))
        .map(event => ({at: event.at, event: event.event, taskId: task.id, taskTitle: task.title}))).sort((a, b) => b.at.localeCompare(a.at));
      return {approvals, decisions, removals: clone(removalAudit)};
    },
    async diagnostics() { return {synthetic: true, checks: clone(DIAGNOSTICS)}; },

    // -- demo-only controls. None of these exist in the real product. --
    demo: {
      faults, tick,
      state: () => ({unlocked, active: !!active, routeRevision, routesStale, taskCount: tasks.size, faults: {...faults}, counters: {...counters}, removalSkewMs: removalSkew}),
      setFault(name, value) { if (name in faults) faults[name] = !!value; },
      expireSession() { unlocked = false; },
      advanceRemovalClock(ms) { removalSkew += ms; },
      // Route fact changes. The per-route revision follows the host formula, so a permission change
      // alone does not move it; the client's fact comparison catches that case.
      changeRouteFact(kind) {
        const route = routeByKey('opencode-llamacpp');
        if (kind === 'identity') route.identity.value = route.identity.value.slice(1) + (route.identity.value[0] === 'a' ? 'b' : 'a');
        else if (kind === 'destination') route.endpoint = route.endpoint === 'http://127.0.0.1:8091' ? 'http://127.0.0.1:8092' : 'http://127.0.0.1:8091';
        else if (kind === 'permissions') route.permissions = route.permissions.length > 2 ? route.permissions.slice(0, 2) : [...route.permissions, 'Spawn a local process'];
        else if (kind === 'quantization') route.quantization = route.quantization === 'Q4_K_M' ? 'Q3_K_M' : 'Q4_K_M';
        else if (kind === 'timestamp') { routeEvidenceAt = now(); return; }
        else throw Error('Unknown route fact.');
        routeRevision++; routeEvidenceAt = now();
      },
      changeRouteIdentity() { api.demo.changeRouteFact('identity'); },
      staleRoutes() { routesStale = true; routeRevision++; },
      // Another browser view edits this draft's scope through the ordinary scope route.
      async editScopeFromAnotherView(id) {
        const task = get(id);
        return api.updateScope(id, {version: task.version, kind: task.kind, title: task.title, request: task.request + ' (edited in another view)',
          source: task.source + '\nLine added in another view.', filename: task.filename, expected: task.expected});
      },
      fastForward(ms = 30000) { if (active) active.skewMs += ms; },
      otherViewTakesControl() {
        if (!active) fail(409, 'No run is active.');
        const snapshot = active.control.snapshot();
        const result = active.control.command({command: 'take', confirm: true, attemptId: snapshot.attemptId, generation: snapshot.generation}, 'other-view');
        terminalLine(active, result.message);
      },
      interruptAsRestart() {
        if (!active) fail(409, 'No run is active.');
        const run = active, task = tasks.get(run.taskId), attempt = task.attempts.at(-1);
        const safe = attempt.execution.phase === 'claimed' || attempt.provider === 'fixture';
        run.control.close();
        attempt.recovery = {state: safe ? 'retry-safe' : 'unresolved', at: iso(), evidence: safe ? 'dispatch-not-started' : 'no-terminal-evidence',
          message: safe ? 'The previous attempt stopped before an external request could remain active. You may review the scope and retry.'
            : 'The earlier provider request may still be active. A retry is held until its outcome is reconciled.'};
        attempt.status = task.status = 'interrupted';
        attempt.ended = iso(); attempt.problem = attempt.recovery.message; attempt.terminal = clone(run.terminal);
        save(task, 'attempt.interrupted');
        active = null;
      },
    },
  };

  if (profile === 'returning') {
    for (const seed of SEED_TASKS) {
      const created = now() - seed.ago * 60000;
      const task = {id: uuid(), version: 0, status: seed.status, kind: seed.kind, title: seed.title, request: seed.request, source: seed.source,
        filename: seed.filename ?? null, expected: seed.expected ?? null, sourceHash: await sha256(seed.source), model: null, attempts: [], events: [],
        approvals: [], updated: iso(created), ...(seed.receiptKey ? {receiptKey: seed.receiptKey} : {})};
      const stamp = (event, at) => { task.version++; task.events.push({seq: task.version, at: iso(at), event}); task.updated = iso(at); };
      stamp('task.created', created);
      let cursor = created + 20000;
      for (const item of seed.attempts) {
        const route = routeByKey(item.route), started = cursor;
        const attempt = {id: uuid(), model: route.id, provider: route.engine, backend: route.backend, routeKey: route.key, routeLabel: route.label,
          started: iso(started), status: item.status, usage: item.usage ?? null, cost: item.cost ?? null, claims: item.claims ?? [],
          execution: {phase: item.phase ?? 'settled', claimedAt: iso(started)}};
        task.model = route.id;
        task.attempts.push(attempt);
        task.approvals.push({at: iso(started), attemptId: attempt.id, attemptNumber: task.attempts.length, routeLabel: route.label, routeType: route.type,
          destination: route.destination, sourceHash: task.sourceHash, identity: route.identity.value, identityKind: route.identity.kind,
          permissions: clone(route.permissions), use: 'Single use. Consumed by this attempt.'});
        stamp('attempt.approved_and_started', started);
        if (item.elapsedMs !== null && item.elapsedMs !== undefined) { attempt.ended = iso(started + item.elapsedMs); attempt.elapsedMs = item.elapsedMs; }
        else if (item.status === 'interrupted') attempt.ended = iso(started + 600000);
        if (item.problem) attempt.problem = item.problem;
        if (item.recovery) { attempt.recovery = {...item.recovery, at: attempt.ended}; attempt.problem = item.recovery.message; }
        if (item.artifact) {
          await attachArtifact(task, attempt, item.artifact);
          if (item.edited) {
            attempt.originalArtifact = {...attempt.artifact, sha256: await sha256(item.artifact.content + ' '), content: item.artifact.content + ' '};
            attempt.operatorEdits = [{previousHash: attempt.originalArtifact.sha256, artifactHash: attempt.artifact.sha256, at: iso(started + item.elapsedMs + 20000)}];
          }
        }
        const ended = Date.parse(attempt.ended ?? iso(started));
        stamp('attempt.' + (item.decision ? 'review' : item.status), ended);
        if (item.edited) stamp('proposal.operator_edited', ended + 20000);
        if (item.decision) stamp('review.' + item.decision, ended + (item.reviewMs ?? 30000));
        cursor = ended + (item.gapMs ?? 15000);
      }
      tasks.set(task.id, task);
    }
  }
  return api;
}
