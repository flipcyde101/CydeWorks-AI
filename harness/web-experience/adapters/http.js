// HTTP implementation of the WorkspaceAdapter over the existing harness routes (harness/server.mjs).
//
// Rules this adapter keeps:
// - It calls only routes the host serves today. Methods marked 'none' or 'composed' in contract.js
//   degrade or compose; no endpoint is invented.
// - Request bodies are built by the caller (approval.js, dialogs) and sent unchanged. Nothing is
//   retried, refreshed or replayed here.
// - A rejection carries the HTTP status. A network failure, or a success whose body cannot be read,
//   carries no status, so the caller treats the outcome as unknown.
// - Host records are relabelled for display only. Facts the host does not record (permissions,
//   approval destination, model claims, attempt cost) are reported as not recorded, never invented.
// - Session secrets never pass through here except the access key, which is sent once to
//   POST /api/session and not kept. The session cookie is HttpOnly and handled by the browser.

import {assertAdapter, createTabAdmission} from './contract.js';
import {summarizeRun, compareRuns} from '../vendor/inspector-v1/accounting.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ADAPTER_LABEL = {opencode: 'OpenCode', ollama: 'Direct', fixture: 'None'};
const BACKEND_LABEL = {llamacpp: 'llama.cpp', ollama: 'Ollama', fixture: 'Workspace fixture'};
const NOT_RECORDED = 'Not recorded by the workspace';
export const RECEIPT_READ_LIMIT = 100;

const statusError = (status, message) => Object.assign(new Error(message), {status});
const unknownOutcome = (message, cause) => Object.assign(new Error(message), {cause});

export const routeKeyOf = ({engine, backend, id}) => [engine, backend, id].join(':');
const hostBackend = model => model.backend ?? (model.engine === 'fixture' ? 'fixture' : 'ollama');

// One host inventory row (GET /api/models models[]) as a route view. Every host fact is kept under
// its host name. Labels are derived from engine, backend, endpoint and readiness only.
export function routeFromHost(model) {
  const backend = hostBackend(model), engine = model.engine;
  const fixture = engine === 'fixture', llama = backend === 'llamacpp';
  const endpoint = model.endpoint ?? null;
  const identity = fixture ? {kind: 'none', value: null, note: 'No model runs on this route.'}
    : llama ? {kind: 'server-metadata', value: model.fingerprint ?? null, note: 'Server metadata fingerprint reported by the workspace. It does not verify model weights.'}
    : {kind: 'digest', value: model.digest ?? null, note: 'Digest reported at preflight. The model tag could change before execution.'};
  const adapterLabel = ADAPTER_LABEL[engine] ?? String(engine), backendLabel = BACKEND_LABEL[backend] ?? String(backend);
  const remote = model.remote === true;
  const destination = fixture ? 'Nothing leaves the workspace. The workspace fixture returns a sample without a model.'
    : remote ? 'The workspace reports this model as remote. The approved request and source could leave this computer.'
    : adapterLabel + ' sends the approved request and source to ' + backendLabel + (endpoint ? ' at ' + endpoint : '') + '. Network isolation is not verified.';
  const type = remote ? 'unknown' : 'local';
  return {...model, key: routeKeyOf({engine, backend, id: model.id}), backend, endpoint, label: String(model.id),
    type, adapterLabel, backendLabel, terminal: engine === 'opencode', identity, destination,
    billing: {type, detail: fixture ? 'No model runs. No usage is recorded.' : remote ? 'Billing is not reported by the workspace.' : 'No provider charge is recorded. Electricity and hardware are not metered.'},
    permissions: [], permissionsReported: false,
    readiness: {eligible: model.readiness?.eligible === true, reason: typeof model.readiness?.reason === 'string' ? model.readiness.reason : 'The workspace did not explain this check.'}};
}

// The host preselects the previous route, then the smallest eligible model. This reproduces that
// order so the same route is selected, and says so. It is not a recommendation.
export function preselect(routes, task) {
  const last = task?.attempts?.at(-1);
  const previous = last ? routes.find(route => route.readiness.eligible && route.id === last.model && route.engine === last.provider &&
    route.backend === (last.backend ?? (last.provider === 'fixture' ? 'fixture' : 'ollama'))) : null;
  if (previous) return {routeKey: previous.key, designSample: false, reasons: ['You used this route for the previous attempt on this task.',
    'Preselected the same way the workspace does. Review it before approving.']};
  const eligible = routes.filter(route => route.readiness.eligible);
  const sized = eligible.filter(route => route.engine !== 'fixture').sort((a, b) => (a.bytes ?? Infinity) - (b.bytes ?? Infinity));
  const pick = sized[0] ?? eligible[0];
  return pick ? {routeKey: pick.key, designSample: false, reasons: [pick.engine === 'fixture'
    ? 'It is the only route that passes the preview check. It runs no model.'
    : 'It is the smallest model by reported size that passes the preview check.', 'Preselected the same way the workspace does. Review it before approving.']} : null;
}

// What the host records about each approval: the attempt's start, model, route and approved identity.
// Destination text and permissions were not recorded at approval time, so they are not shown.
export function hostApprovals(task) {
  return (task.attempts ?? []).map((attempt, index) => {
    const backend = attempt.backend ?? (attempt.provider === 'fixture' ? 'fixture' : 'ollama');
    const identity = attempt.approvedModelFingerprint ?? attempt.approvedModelDigest ?? null;
    return {at: attempt.started ?? null, attemptId: attempt.id, attemptNumber: index + 1, routeLabel: attempt.model ?? 'Unknown model',
      routeType: 'local', destination: NOT_RECORDED, sourceHash: task.sourceHash ?? null, identity,
      identityKind: attempt.approvedModelFingerprint ? 'server-metadata' : attempt.approvedModelDigest ? 'digest' : 'none',
      permissions: [], scopeHash: attempt.scopeHash ?? null, routeRevision: attempt.approvedRouteRevision ?? null,
      route: [ADAPTER_LABEL[attempt.provider] ?? attempt.provider, BACKEND_LABEL[backend] ?? backend].join(' · '),
      use: 'Single use. Consumed by this attempt.', recordedBy: 'host'};
  });
}

// Display annotations for a host task view. Host fields are kept as returned.
export function annotateTask(task) {
  if (!task || typeof task !== 'object' || !Array.isArray(task.attempts)) return task;
  const attempts = task.attempts.map(attempt => {
    const backend = attempt.backend ?? (attempt.provider === 'fixture' ? 'fixture' : 'ollama');
    return {...attempt, routeKey: routeKeyOf({engine: attempt.provider, backend, id: attempt.model}), routeLabel: String(attempt.model ?? 'Unknown model'),
      cost: attempt.cost ?? null, claims: attempt.claims ?? []};
  });
  return {...task, attempts, approvals: hostApprovals(task), approvalsRecordedBy: 'host'};
}

// ---- Response validation ----------------------------------------------------------------------
// A success the page cannot correlate with what it asked for is not a known outcome. Each check uses
// only fields the host actually returns (harness/server.mjs view(), run-submission.mjs
// submissionResult). A failed check rejects without a status, so callers treat it like a lost response.

const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
// A task view for the requested task: harness/server.mjs view() always carries these.
export function taskViewProblem(id, value) {
  if (!isRecord(value)) return 'the response is not a task';
  if (value.id !== id) return 'the response describes a different task';
  if (!Number.isSafeInteger(value.version) || value.version < 0 || typeof value.status !== 'string' || !Array.isArray(value.attempts) || !Array.isArray(value.events))
    return 'the task response is incomplete';
  return null;
}
// harness/run-submission.mjs submissionResult(): {requestId, taskId, attemptId, attemptStatus, replayed, executionAuthorized}.
export function submissionProblem(id, requestId, value) {
  if (!isRecord(value)) return 'the submission record is missing';
  if (value.requestId !== requestId) return 'the submission record names a different request';
  if (value.taskId !== id) return 'the submission record names a different task';
  if (typeof value.attemptId !== 'string' || !UUID.test(value.attemptId) || typeof value.replayed !== 'boolean' || value.executionAuthorized !== false)
    return 'the submission record is incomplete';
  return null;
}
// POST /run with a keyed body returns the task view plus runSubmission (202 new, 200 replay). The
// recorded attempt must be in the returned task. An unkeyed body (never sent by this candidate) has
// no runSubmission, so only the task view is checked.
export function runResultProblem(id, body, value) {
  const task = taskViewProblem(id, value);
  if (task) return task;
  if (typeof body?.requestId !== 'string') return null;
  const submission = submissionProblem(id, body.requestId, value.runSubmission);
  if (submission) return submission;
  if (!value.attempts.some(attempt => attempt?.id === value.runSubmission.attemptId)) return 'the recorded attempt is not in the returned task';
  return null;
}

// Like Promise.allSettled, with one exception: the first 401 rejects at once, without waiting for
// unrelated reads, so a revoked session reaches concealment immediately. Every read stays observed,
// so a later rejection is never unhandled, and once the aggregate has settled late results are
// dropped and cannot reach any caller.
export function settleUnlessDenied(promises) {
  return new Promise((resolve, reject) => {
    const outcomes = new Array(promises.length);
    let left = promises.length, finished = false;
    if (!left) { resolve(outcomes); return; }
    promises.forEach((promise, index) => {
      Promise.resolve(promise).then(value => ({status: 'fulfilled', value}), reason => ({status: 'rejected', reason})).then(outcome => {
        if (finished) return;
        if (outcome.status === 'rejected' && outcome.reason?.status === 401) { finished = true; reject(outcome.reason); return; }
        outcomes[index] = outcome;
        if (--left === 0) { finished = true; resolve(outcomes); }
      });
    });
  });
}

function base64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createHttpAdapter({base = '', fetchImpl = globalThis.fetch?.bind(globalThis)} = {}) {
  if (typeof fetchImpl !== 'function') throw Error('A fetch implementation is required.');

  function browserAdmission() {
    let session = null, shared = null;
    try { session = globalThis.sessionStorage; } catch { session = null; }
    try { shared = globalThis.localStorage; } catch { shared = null; }
    return createTabAdmission({session, shared});
  }
  async function send(method, path, body, signal) {
    const admission = browserAdmission();
    const opening = path === '/api/session' || path === '/api/session/lock';
    if (admission.mustConceal() && !opening) throw statusError(401, 'Unlock this workspace with its local access.key file.');
    const headers = {Accept: 'application/json'};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const viewId = admission.header();
    if (viewId) headers['X-Workspace-View'] = viewId;
    try {
      return await fetchImpl(base + path, {method, signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers, body: body === undefined ? undefined : JSON.stringify(body)});
    } catch (error) {
      if (error?.status) throw error;
      throw unknownOutcome('The local workspace did not respond.', error);
    }
  }
  // keepRejection: return a 400 body that carries a structured result (cost formatter and handoff
  // review report their own invalid-input reasons) instead of throwing it away.
  async function call(method, path, body, {keepRejection = false, signal} = {}) {
    const response = await send(method, path, body, signal);
    let data = null, readable = true;
    try { data = await response.json(); } catch { readable = false; }
    if (keepRejection && response.status === 400 && readable && data && typeof data === 'object' && data.ok === false) return data;
    if (!response.ok) throw statusError(response.status, typeof data?.error === 'string' ? data.error : 'The workspace refused the request (HTTP ' + response.status + ').');
    // A success whose body is lost or unreadable is not a known outcome.
    if (!readable || data === null || typeof data !== 'object') throw unknownOutcome('The workspace response could not be read. The outcome is unknown.');
    return data;
  }
  const get = path => call('GET', path);
  const post = (path, body) => call('POST', path, body);
  // Resolves only with a value that passes check(value) === null.
  const checked = (promise, check) => promise.then(value => {
    const problem = check(value);
    if (problem) throw unknownOutcome('The workspace response could not be matched to this request (' + problem + '). The outcome is unknown.');
    return value;
  });
  const taskRead = (id, promise) => checked(promise, value => taskViewProblem(id, value)).then(annotateTask);
  const taskPath = id => {
    if (typeof id !== 'string' || !UUID.test(id)) throw statusError(404, 'Task not found.');
    return '/api/tasks/' + id;
  };

  async function listRows() {
    const [list, attention] = await Promise.all([get('/api/tasks'), get('/api/attention')]);
    const needs = new Map((attention.tasks ?? []).map(item => [item.id, item]));
    return (list.tasks ?? []).map(task => ({id: task.id, title: task.title, kind: task.kind, status: task.status,
      updated: null, attempts: null, attention: needs.get(task.id) ?? null}));
  }
  async function inventory(taskId) {
    // The task read only informs preselection, so its ordinary failures are ignored, but a 401 is not.
    const [hosted, task] = await Promise.all([get('/api/models'), taskId ? get(taskPath(taskId)).catch(error => { if (error?.status === 401) throw error; return null; }) : null]);
    const routes = (hosted.models ?? []).map(routeFromHost);
    return {observedAt: hosted.observedAt ?? null, expiresAt: hosted.expiresAt ?? null, revision: hosted.revision ?? null,
      revisionKind: hosted.revisionKind ?? null, executionAuthorized: false, routes, diagnostics: hosted.diagnostics ?? null,
      suggestion: preselect(routes, task)};
  }
  async function allTasks() {
    const rows = (await get('/api/tasks')).tasks ?? [];
    const settled = await settleUnlessDenied(rows.slice(0, 100).map(row => get(taskPath(row.id))));
    // A 401 has already rejected. A task removed between the list and its read is skipped; any other
    // failure is reported.
    const failure = settled.find(result => result.status === 'rejected' && result.reason?.status !== 404);
    if (failure) throw failure.reason;
    return settled.filter(result => result.status === 'fulfilled').map(result => result.value);
  }

  const api = {
    // A 200 task list is not this view's unlock. The view id comes from the access-file POST.
    async session() {
      const admission = browserAdmission();
      if (admission.mustConceal() || !admission.mayOpenWorkspace()) return {unlocked: false, firstUse: false};
      try {
        const response = await send('GET', '/api/tasks');
        let data = null, readable = true;
        try { data = await response.json(); } catch { readable = false; }
        if (response.status === 401) return {unlocked: false, firstUse: false};
        if (!response.ok || !readable || !data || typeof data !== 'object') throw statusError(response.status || 401, 'Unlock this workspace with its local access.key file.');
        const generation = response.headers.get('x-view-generation');
        if (!generation || generation !== admission.generation() || admission.mustConceal()) return {unlocked: false, firstUse: false};
        return {unlocked: true, firstUse: (data.tasks ?? []).length === 0};
      } catch (error) { if (error.status === 401) return {unlocked: false, firstUse: false}; throw error; }
    },
    // The key is read from the access file by the caller, sent once and not retained.
    async unlock(key) {
      if (typeof key !== 'string' || !DIGEST.test(key)) throw statusError(401, 'That file is not a workspace access key. Choose the access.key file in the workspace state folder.');
      return post('/api/session', {key});
    },
    lock: () => post('/api/session/lock', {}),

    listTasks: async () => ({tasks: await listRows()}),
    getTask: async id => taskRead(id, get(taskPath(id))),
    // The host requires a title. A neutral default is sent when none is given; request text is
    // never copied into the title because titles appear in standard exports.
    createTask: async data => annotateTask(await checked(post('/api/tasks', withTitle(data)), value => taskViewProblem(value?.id, value) ?? (UUID.test(value.id) ? null : 'the new task has no valid ID'))),
    updateScope: async (id, data) => taskRead(id, post(taskPath(id) + '/scope', withTitle(data))),

    listRoutes: taskId => inventory(taskId),
    refreshRoutes: taskId => inventory(taskId),

    // Resolves only with the requested task carrying the runSubmission for this request ID, whose
    // attempt is in that task. Anything else, including {} or another task, is an unknown outcome:
    // the caller keeps the original request ID and body for lookup or an exact resend.
    async run(id, body) {
      return annotateTask(await checked(post(taskPath(id) + '/run', body), value => runResultProblem(id, body, value)));
    },
    lookupRunSubmission: (id, requestId) => {
      if (typeof requestId !== 'string' || !UUID.test(requestId)) throw statusError(400, 'Use a valid, scope-bound run submission.');
      return checked(get(taskPath(id) + '/run-submissions/' + requestId), value => submissionProblem(id, requestId, value));
    },
    cancel: (id, data) => post(taskPath(id) + '/cancel', {version: data.version}),
    terminal: (id, data) => post(taskPath(id) + '/terminal', data),

    revise: async (id, data) => taskRead(id, post(taskPath(id) + '/revise', data)),
    review: async (id, data) => taskRead(id, post(taskPath(id) + '/review', data)),
    async copyDraft(id, data) {
      const result = await post(taskPath(id) + '/copy-draft', data);
      return {...result, task: annotateTask(result.task)};
    },
    lookupCopy: requestId => {
      if (typeof requestId !== 'string' || !UUID.test(requestId)) throw statusError(400, 'Use a valid copy request.');
      return get('/api/draft-copies/' + requestId);
    },
    exportPreview: (id, mode = 'minimal') => get(taskPath(id) + '/export?mode=' + encodeURIComponent(mode)),
    removalPreview: id => get(taskPath(id) + '/removal-preview'),
    remove: (id, data) => post(taskPath(id) + '/remove', {version: data.version, expiresAt: data.expiresAt, token: data.token, confirmation: data.confirmation}),

    // Accepted proposal download (ARTIFACT-DOWNLOAD.md). The binding is the exact accepted tuple the
    // person reviewed; a failed request is never refreshed into a different proposal.
    async downloadArtifact(id, {version, attemptId, artifactHash, format = 'content'}) {
      const query = new URLSearchParams({version: String(version), attemptId, artifactHash, format});
      const response = await send('GET', taskPath(id) + '/artifact?' + query);
      if (!response.ok) {
        let data = null;
        try { data = await response.json(); } catch { /* static error body */ }
        throw statusError(response.status, typeof data?.error === 'string' ? data.error : 'The download was refused (HTTP ' + response.status + ').');
      }
      let bytes;
      try { bytes = new Uint8Array(await response.arrayBuffer()); } catch (error) { throw unknownOutcome('The download did not complete. Nothing changed in the task.', error); }
      const reported = response.headers.get('x-artifact-sha256'), computed = await sha256Hex(bytes);
      if (reported !== computed) throw statusError(409, 'The downloaded bytes did not match the workspace hash. Nothing was saved.');
      const disposition = response.headers.get('content-disposition') ?? '';
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? (format === 'patch' ? 'proposal.patch' : 'download.txt');
      return {filename, bytes, sha256: computed, byteLength: bytes.length, format};
    },

    readiness: async taskId => {
      const id = taskId ?? (await get('/api/tasks')).tasks?.[0]?.id;
      return id ? get(taskPath(id) + '/readiness') : null;
    },
    receipt: id => get(taskPath(id) + '/receipt'),
    // No workspace-wide receipt list exists: one receipt read per task, summarized and compared on
    // this page by the pinned Run Inspector copy.
    // Coverage is explicit: a 401 from any read rejects the whole call so the page locks; any other
    // failed read is listed in `unavailable` with its status, and tasks past the read limit are listed
    // in `omitted`. Valid receipts are still returned. A task without a receipt here has unknown
    // usage, never zero. (The host caps a workspace at 100 tasks, so `omitted` is empty in practice.)
    async receipts() {
      const rows = (await get('/api/tasks')).tasks ?? [];
      const read = rows.slice(0, RECEIPT_READ_LIMIT);
      // The first 401 rejects at once; other failures become per-task outcomes below.
      const settled = await settleUnlessDenied([
        ...read.map(row => get(taskPath(row.id) + '/receipt')),
        call('GET', '/api/receipts/analytics', undefined, {signal: AbortSignal.timeout(5000)}),
      ]);
      const aggregate = settled.pop();
      const analytics = aggregate.status === 'fulfilled' && aggregate.value?.summary?.format === 'cydeworks.receipt-analytics-summary'
        ? aggregate.value : null;
      const receipts = [], unavailable = [];
      settled.forEach((result, index) => {
        const row = read[index];
        if (result.status === 'rejected' || !isRecord(result.value) || typeof result.value.available !== 'boolean') {
          const status = result.status === 'rejected' && typeof result.reason?.status === 'number' ? result.reason.status : null;
          unavailable.push({taskId: row.id, title: row.title, status, reason: status === 404 ? 'removed' : status === null ? 'no-response' : 'refused'});
          return;
        }
        const envelope = result.value;
        let summary = null;
        try { summary = envelope.available ? summarizeRun(envelope.run) : null; } catch { summary = null; }
        receipts.push({taskId: row.id, title: row.title, key: row.id, envelope, summary});
      });
      const omitted = rows.slice(RECEIPT_READ_LIMIT).map(row => ({taskId: row.id, title: row.title}));
      const coverage = {listed: rows.length, read: receipts.length, unavailable: unavailable.length, omitted: omitted.length, limit: RECEIPT_READ_LIMIT};
      const byKey = new Map(receipts.map(item => [item.key, item]));
      return {receipts, analytics, unavailable, omitted, partial: unavailable.length > 0 || omitted.length > 0, coverage, comparisons: [], compare(baselineKey, candidateKey) {
        const a = byKey.get(baselineKey), b = byKey.get(candidateKey);
        if (!a?.envelope.available || !b?.envelope.available) return null;
        try { return compareRuns(a.envelope.run, b.envelope.run); }
        catch { return {comparable: false, reasons: [{code: 'INSPECTOR_ERROR', message: 'The Run Inspector could not compare these receipts.'}]}; }
      }};
    },
    async audit() {
      const [tasks, removals] = await Promise.all([allTasks(), get('/api/removal-audit')]);
      const approvals = tasks.flatMap(task => hostApprovals(task).map(item => ({...item, taskId: task.id, taskTitle: task.title})))
        .sort((a, b) => String(b.at).localeCompare(String(a.at)));
      const decisions = tasks.flatMap(task => (task.events ?? []).filter(event => /^(review\.|proposal\.operator_edited|task\.copied)/.test(event.event))
        .map(event => ({at: event.at, event: event.event, taskId: task.id, taskTitle: task.title}))).sort((a, b) => String(b.at).localeCompare(String(a.at)));
      return {approvals, decisions, removals: removals.records ?? [], recordedBy: 'host'};
    },
    async diagnostics() {
      const hosted = await get('/api/models');
      const messages = hosted.diagnostics?.messages ?? [];
      return {synthetic: false, checks: messages.map(message => ({id: message.code, label: message.code.replaceAll('_', ' '), state: 'warn', value: message.text,
        help: 'Reported by GET /api/models. Other environment checks have no endpoint.'}))};
    },

    // Reviewed contributor interfaces (CONTRIBUTOR-INTEGRATION.md). Processing only: nothing is
    // stored, no task is created and no permission is granted.
    presentCost: input => call('POST', '/api/cost-presentation', input, {keepRejection: true}),
    reviewHandoff({manifest, artifacts = []}) {
      const body = {manifest};
      if (artifacts.length) body.artifacts = artifacts.map(item => {
        const record = {artifactId: item.artifactId};
        if (item.bytes) record.bytesBase64 = base64(item.bytes);
        if (item.claimedDigest !== undefined) record.claimedDigest = item.claimedDigest;
        if (item.byteLength !== undefined) record.byteLength = item.byteLength;
        return record;
      });
      return call('POST', '/api/handoffs/review', body, {keepRejection: true});
    },
  };
  return assertAdapter(api);
}

function withTitle(data) {
  const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, 120) : data.kind === 'change' ? 'Untitled change' : 'Untitled brief';
  const body = {kind: data.kind, title, request: data.request, source: data.source};
  if (data.kind === 'change') { body.filename = data.filename; body.expected = data.expected; }
  if (data.version !== undefined) body.version = data.version;
  return body;
}
