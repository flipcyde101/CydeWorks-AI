// Candidate controller: one state object, one read loop, explicit actions.
// The read loop only reads. Commands, approvals and submissions are never replayed automatically.

import {createDemoAdapter} from './demo/adapter.js';
import {createHttpAdapter} from './adapters/http.js';
import {classifyError, classifyLockOutcome, createSharedLockWatch, createTabAdmission, respondToSharedGeneration, viewStorageKeys} from './adapters/contract.js';
import {swap, stableKey} from './core/dom.js';
import {mode, readAdapterMode} from './core/mode.js';
import {shortHash} from './core/format.js';
import {announce, revalidateDialogs, closeAllDialogs} from './ui/primitives.js';
import {readSourceFile, rememberedTask, rememberTask} from './logic/parity.js';
import {captureApproval, approvalProblems, submissionBody, terminalTargetHolds, evidenceProblem} from './logic/approval.js';
import {renderSidebar, renderBanner, openDemoControls, renderUnlock} from './views/shell.js';
import {renderWork} from './views/work.js';
import {renderConnections} from './views/connections.js';
import {renderUsage} from './views/usage.js';
import {renderData} from './views/data.js';
import {renderAgents} from './views/agents.js';
import {renderDeveloper} from './views/developer.js';

const $ = id => document.getElementById(id);
const PROFILE_KEY = 'cydeworks-candidate-profile';
const pendingRunKey = taskId => 'cydeworks-candidate-pending-run:' + taskId;
const storage = (() => { try { return globalThis.sessionStorage; } catch { return null; } })();
function experienceStores() {
  let session = null, shared = null;
  try { session = globalThis.sessionStorage; } catch { session = null; }
  try { shared = globalThis.localStorage; } catch { shared = null; }
  return {session, shared};
}
function experienceAdmission() { return createTabAdmission(experienceStores()); }
const sharedWatch = createSharedLockWatch({
  sharedGeneration() { return experienceAdmission().sharedGeneration(); },
  generation() { return experienceAdmission().generation(); },
});
function storedLockNotice(outcome) {
  if (outcome === 'confirmed') return 'Workspace session terminated in every view. Approved work keeps running, and terminal control was released. Unlock with the access file.';
  if (outcome === 'already') return 'The workspace session had already ended. This view is locked.';
  if (outcome === 'unconfirmed') return 'The lock response was lost, so this view locked itself. Whether other views were locked is not confirmed. Unlock with the access file; nothing was sent again.';
  return null;
}
const profile = (() => { try { return storage?.getItem(PROFILE_KEY) === 'first-use' ? 'first-use' : 'returning'; } catch { return 'returning'; } })();
function documentHasOpener() {
  try { return !!globalThis.opener; } catch { return true; }
}
async function takeDesktopTicket() {
  if (mode.synthetic) return;
  const admission = experienceAdmission();
  if (admission.localLock() || admission.mayOpenWorkspace() || admission.mustConceal()) return;
  let ticket = null;
  try {
    const response = await fetch('/api/desktop-view', {
      method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json'},
      body: '{}', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    });
    if (!response.ok) return;
    ticket = await response.json();
  } catch { return; }
  const again = experienceAdmission();
  if (again.localLock() || again.mayOpenWorkspace() || again.mustConceal()) return;
  again.admit(ticket?.viewId, ticket?.viewGeneration);
}
mode.adapter = readAdapterMode();
if (!mode.synthetic) experienceAdmission().bindDocument({opener: documentHasOpener()});
sharedWatch.observe();
// The HTTP adapter talks to the workspace service that served this page. The demo adapter runs the
// synthetic in-page workspace. Views behave the same on both; only labels differ.
const {adapter, demo} = mode.adapter === 'http' ? {adapter: createHttpAdapter(), demo: null} : await createDemoAdapter({profile});

const state = {
  session: {unlocked: false, firstUse: mode.synthetic && profile === 'first-use'}, unlockError: null, lockNotice: null,
  path: [], tasks: [], task: null, routes: null, routeKey: null,
  // approve mirrors the checkbox. approval is the captured binding; both are cleared together.
  approve: false, approval: null, approvalNotice: null, announcedNotice: null,
  pendingRun: null, anotherAttempt: null,
  connection: 'connected', failures: 0, retryAt: 0, needsReconcile: false,
  lease: null, detached: false, filter: 'all', query: '', busy: false, notice: null,
  compose: {kind: 'brief', title: '', request: '', source: '', filename: '', expected: '', editing: null, error: null, rev: 0},
  cache: {}, now: Date.now(), tick: 0, pendingFocus: null,
};

const ownsControl = () => {
  const control = state.task?.live?.control;
  return !!state.lease && state.task?.status === 'running' && control?.owner === 'Operator' && !control.closed &&
    state.lease.attemptId === control.attemptId && state.lease.generation === control.generation;
};
const selectedRoute = () => state.routes?.routes.find(route => route.key === state.routeKey) ?? null;
const navigate = hash => { if (location.hash !== hash) location.hash = hash; else onRoute(); };
function setNotice(tone, text) { state.notice = text ? {tone, text} : null; if (text) announce(text, tone === 'danger'); }
function clearApproval(message = null) { state.approve = false; state.approval = null; state.approvalNotice = message; }

// ---- Reading --------------------------------------------------------------------------------

// Route invalidation never depends on an inventory revision: the host has none. With a captured
// approval, its bound facts are compared to the current route. Without one, any change to the
// selected route other than observation time clears a checked box.
function applyRoutes(inventory, {initial = false} = {}) {
  const before = selectedRoute();
  state.routes = inventory;
  if (initial || !before) {
    state.routeKey = inventory.suggestion?.routeKey ?? null;
    state.approve = false; state.approval = null; state.approvalNotice = null;
    return;
  }
  const after = selectedRoute();
  const material = route => route ? stableKey({...route, observedAt: null, revision: null}) : null;
  const problems = state.approval ? approvalProblems(state.approval, state.task, after) : [];
  const changed = state.approval ? problems.length > 0 : material(before) !== material(after);
  if ((state.approve || state.approval) && changed) {
    state.approve = false; state.approval = null;
    state.approvalNotice = 'Your approval was cleared because ' + (problems.length ? problems.join('; ') : 'the route details changed') +
      '. Review the route and approve again.';
    announce(state.approvalNotice);
  }
}

// A list read that finishes after a Lock or session end is discarded (state.sessionEpoch, see lockUi).
async function refreshList() {
  const epoch = state.sessionEpoch;
  const list = await adapter.listTasks();
  if (state.sessionEpoch === epoch) state.tasks = list.tasks;
}

async function openTask(id) {
  const epoch = state.sessionEpoch;
  releaseView();
  const [task, inventory] = await Promise.all([adapter.getTask(id), adapter.listRoutes(id)]);
  if (state.sessionEpoch !== epoch) throw staleError();
  state.task = task; state.lease = null; state.detached = false; state.needsReconcile = false; state.anotherAttempt = null;
  rememberTask(storage, id);
  // Session storage first; if it is unavailable, keep the in-memory identity for this task.
  state.pendingRun = restorePendingRun(id) ?? (state.pendingRun?.taskId === id ? {...state.pendingRun, uncertain: true} : null);
  applyRoutes(inventory, {initial: true});
  await refreshList();
}

function connected() {
  const was = state.connection;
  state.connection = 'connected'; state.failures = 0;
  if (was !== 'connected' && was !== 'locked') announce('Connection restored.');
  if (state.needsReconcile) {
    state.needsReconcile = false;
    setNotice('info', 'Saved state restored. Review the current status before taking another action.');
  }
}

function readFailed(error) {
  const kind = classifyError(error).kind;
  state.lease = null;
  if (kind === 'locked') return lockUi();
  if (kind === 'missing') { state.connection = 'missing'; return; }
  state.failures++;
  state.needsReconcile = true;
  const retryMs = Math.min(8000, 1000 * 2 ** Math.min(state.failures - 1, 3));
  state.retryAt = Date.now() + retryMs;
  state.retryMs = retryMs;
  if (state.connection !== 'reconnecting') announce('Connection interrupted. The saved view may be out of date.', true);
  state.connection = 'reconnecting';
}

// The single concealment path. Used by Lock, by any 401 the controller or a view observes, and by
// an expired session. Synchronous: nothing here waits for the network.
// - A new session generation starts (state.sessionEpoch). Async work started before it may still
//   settle, but its continuation no longer changes state, opens dialogs, saves files or announces
//   content, including after a later unlock.
// - Open dialogs close without acting. Application-held task content is dropped: the open task, the
//   task list, routes, cached page data, the unsent compose text and notices.
// - Local authority is discarded: the terminal lease and any captured approval.
// - Kept: pending run submission identifiers (task ID, request ID, version, hashes, route names) for
//   reconciliation, and the ID of the task that was open, so it can reopen read-only after unlock.
// JavaScript cannot erase browser memory, the clipboard or files already saved; the Lock dialog says so.
function lockUi() { concealSession({explicit: false}); }
// explicit: this view pressed Lock, so no task reopens after unlock.
function concealSession({explicit}) {
  if (!mode.synthetic) {
    const admission = experienceAdmission();
    if (explicit) admission.promiseLock();
    else admission.markSharedLocked();
    sharedWatch.observe();
  }
  state.sessionEpoch = (state.sessionEpoch ?? 0) + 1;
  state.lockedTaskId = explicit ? null : state.task?.id ?? state.lockedTaskId ?? null;
  state.session.unlocked = false; state.connection = 'locked';
  state.lease = null; state.approve = false; state.approval = null; state.approvalNotice = null;
  state.task = null; state.tasks = []; state.routes = null; state.routeKey = null; state.cache = {};
  state.notice = null; state.anotherAttempt = null; state.detached = false; state.needsReconcile = false;
  state.compose = {kind: state.compose?.kind ?? 'brief', title: '', request: '', source: '', filename: '', expected: '', editing: null, error: null, rev: (state.compose?.rev ?? 0) + 1};
  state.busy = false; state.busyToken = null;
  closeAllDialogs();
  announce('The workspace is locked. Unlock to continue.', true);
}

// The adapter handed to views and dialogs. A 401 from any of their reads enters lockUi, and a result
// that arrives after the session changed is refused as stale instead of reaching the view.
function observedAdapter(target) {
  return new Proxy(target, {get(object, name) {
    const value = object[name];
    if (typeof value !== 'function') return value;
    return (...args) => {
      const epoch = state.sessionEpoch;
      return Promise.resolve().then(() => value.apply(object, args)).then(result => {
        if (state.sessionEpoch !== epoch) throw staleError();
        return result;
      }, error => {
        if (state.sessionEpoch !== epoch) throw staleError();
        if (error?.status === 401 && state.session.unlocked) { lockUi(); render(); }
        throw error;
      });
    };
  }});
}

async function loop() {
  state.now = Date.now(); state.tick++;
  if (state.session.unlocked && experienceAdmission().mustConceal()) {
    state.lockNotice = storedLockNotice('unconfirmed');
    concealSession({explicit: false});
  }
  // Reads that finish after a Lock or session end change nothing (see lockUi).
  const epoch = state.sessionEpoch, current = () => state.sessionEpoch === epoch;
  if (state.session.unlocked && !state.busy && Date.now() >= state.retryAt) {
    try {
      const running = state.task?.status === 'running';
      if (state.task && (running || state.tick % 3 === 0 || state.connection !== 'connected')) {
        const latest = await adapter.getTask(state.task.id);
        const previous = state.task;
        if (current() && !state.busy && latest.id === previous?.id && latest.version >= previous.version) {
          state.task = latest;
          // An approval belongs to one task version. Any newer version, from this view or another,
          // clears it. The newer values are never carried into the old approval.
          if (latest.version !== previous.version && (state.approve || state.approval)) {
            state.approve = false; state.approval = null;
            state.approvalNotice = 'Your approval was cleared because the task changed after you approved it (version ' +
              previous.version + ' is now ' + latest.version + '). Review the current scope and approve again.';
          }
          if (previous.status !== latest.status) { announce(statusAnnouncement(latest)); await refreshList(); }
        }
        if (current() && state.lease && running) {
          if (!ownsControl()) { state.lease = null; setNotice('warn', 'Terminal control ended. Another view took over or the lease expired. You are observing read-only.'); }
          else await adapter.terminal(state.task.id, {command: 'heartbeat', ...state.lease}).catch(() => { if (current()) state.lease = null; });
        }
      }
      if (current() && (state.tick % 3 === 0 || state.connection !== 'connected')) {
        await refreshList();
        if (current() && state.task && !['running', 'review'].includes(state.task.status)) {
          const inventory = await adapter.listRoutes(state.task.id);
          if (current()) applyRoutes(inventory);
        }
      }
      if (current()) connected();
    } catch (error) { if (current()) readFailed(error); }
  }
  render();
  setTimeout(loop, 1000);
}

function statusAnnouncement(task) {
  return {review: 'Proposal ready for review.', failed: 'Attempt failed. Review the problem.', cancelled: 'The run was stopped.',
    interrupted: 'The run was interrupted. Review recovery status.', accepted: 'Proposal accepted.', rejected: 'Proposal rejected.',
    running: 'Attempt started.'}[task.status] ?? '';
}

// ---- Pending run submissions -----------------------------------------------------------------
// Kept per task while an outcome is uncertain, as RUN-SUBMISSIONS.md requires. Holds identifiers,
// version, hashes and route names only, never request or source text.

function rememberPendingRun(pending) { try { storage?.setItem(pendingRunKey(pending.taskId), JSON.stringify(pending)); } catch { /* memory copy remains */ } }
function forgetPendingRun(taskId) { try { storage?.removeItem(pendingRunKey(taskId)); } catch { /* nothing to remove */ } if (state.pendingRun?.taskId === taskId) state.pendingRun = null; }
function restorePendingRun(taskId) {
  try {
    const saved = JSON.parse(storage?.getItem(pendingRunKey(taskId)) ?? 'null');
    return saved && saved.taskId === taskId && typeof saved.requestId === 'string' && saved.body?.requestId === saved.requestId ? {...saved, uncertain: true} : null;
  } catch { return null; }
}

// ---- Actions --------------------------------------------------------------------------------

// Runs one action. fn receives the session generation it started in; after each await it passes the
// result through fresh(epoch, value), which throws if a Lock or session end happened meanwhile, so
// nothing from the earlier session is saved, shown or stored. busyToken makes sure a stale action
// cannot clear the busy state of a newer one (lockUi resets busy, so Lock never waits on it).
async function act(fn) {
  if (state.busy) return;
  const epoch = state.sessionEpoch, token = {};
  state.busy = true; state.busyToken = token; state.notice = null;
  render();
  try { await fn(epoch); }
  catch (error) {
    if (error?.stale || epoch !== state.sessionEpoch) return;
    const {kind, message} = classifyError(error);
    if (kind === 'locked') lockUi();
    else if (kind === 'conflict') { state.needsReconcile = !!state.task; setNotice('warn', message + (state.task ? ' Checking the current saved state.' : '')); }
    else if (kind === 'unknown') { state.needsReconcile = !!state.task; state.connection = state.task ? 'checking' : state.connection; setNotice('danger', message); }
    else setNotice('warn', message);
  } finally {
    if (state.busyToken === token) { state.busy = false; state.busyToken = null; state.retryAt = 0; }
    render();
  }
}

function staleError() { return Object.assign(new Error('The workspace was locked while this was in progress. Nothing from it was kept.'), {stale: true}); }
// Passes a value through only if the session generation is still the one the action started in.
function fresh(epoch, value) { if (epoch !== state.sessionEpoch) throw staleError(); return value; }

function releaseView() {
  if (state.task && state.lease) void adapter.terminal(state.task.id, {command: 'detach', ...state.lease}).catch(() => {});
  state.lease = null;
}

// Sends one keyed run body. Two cases differ:
// - First send. A rejection with a definite status means the host refused this request, so nothing
//   is pending. A rejection without a status (or 5xx) leaves the outcome unknown: keep the identity.
// - Resend of an already-uncertain submission. Any rejection, 401 included, refuses only the resend.
//   The first send may still have been recorded, so the exact body and request ID stay pending until
//   a correlated result (a run response, or a lookup that finds the record) resolves them.
// Nothing is ever replayed automatically. Identity is kept in session storage when available and in
// memory otherwise; it does not survive a browser restart.
// A malformed or uncorrelated success is rejected by the adapter without a status, so it is handled
// exactly like a lost response. A result that arrives after a Lock resolves the pending identity (it
// is correlated) but is not shown.
async function sendRun(pending) {
  const epoch = state.sessionEpoch;
  const retry = pending.uncertain === true;
  const record = {taskId: pending.taskId, requestId: pending.requestId, attemptNumber: pending.attemptNumber, body: pending.body};
  if (pending.retryRejected) record.retryRejected = pending.retryRejected;
  rememberPendingRun(record);
  state.pendingRun = {...record, uncertain: retry};
  let result;
  try { result = await adapter.run(pending.taskId, pending.body); }
  catch (error) {
    if (retry) {
      // A resend with no definite answer is not a refusal; only a status is recorded as one.
      const kept = typeof error?.status === 'number' ? {...record, retryRejected: {status: error.status}} : record;
      rememberPendingRun(kept);
      state.pendingRun = {...kept, uncertain: true};
      throw error;
    }
    if (classifyError(error).kind === 'unknown') {
      state.pendingRun = {...record, uncertain: true};
      throw error;
    }
    forgetPendingRun(pending.taskId);
    throw error;
  }
  forgetPendingRun(pending.taskId);
  if (state.sessionEpoch === epoch) state.task = result;
  return result;
}

const actions = {
  navigate, setNotice,
  // file: the chosen access file (HTTP adapter only). Its text is read here, sent once to the
  // workspace and dropped. It is never stored, logged or kept in state.
  unlock: file => act(async epoch => {
    state.unlockError = null;
    const revision = mode.synthetic ? null : experienceAdmission().sharedGeneration();
    let key;
    if (!mode.synthetic) {
      if (!file) { state.unlockError = 'Choose the workspace access file first.'; return; }
      if (file.size > 1024) { state.unlockError = 'That file is too large to be a workspace access key. Nothing was sent.'; return; }
      try { key = (await file.text()).trim(); } catch { state.unlockError = 'The access file could not be read. Nothing was sent.'; return; }
    }
    if (epoch !== state.sessionEpoch || (!mode.synthetic && experienceAdmission().sharedGeneration() !== revision)) return;
    let opened;
    try {
      opened = await adapter.unlock(key);
      fresh(epoch, opened);
      if (!mode.synthetic && experienceAdmission().sharedGeneration() !== revision) return;
      if (!mode.synthetic) {
        if (!experienceAdmission().admit(opened?.viewId, opened?.viewGeneration)) {
          state.unlockError = 'Choose the workspace access file again.';
          return;
        }
        sharedWatch.observe();
      }
    }
    catch (error) {
      if (error?.stale) throw error;
      state.unlockError = error.status === 401 ? error.message
        : error.status === 409 ? 'The workspace was locked while unlocking. Choose the access file again.'
        : 'The workspace did not respond. Nothing was sent again.';
      return;
    } finally { key = undefined; }
    if (state.unlockError) return;
    const session = fresh(epoch, await adapter.session());
    if (!session?.unlocked) { experienceAdmission().dropAdmission(); state.unlockError = 'Choose the workspace access file again.'; return; }
    state.lockNotice = null; state.session = session;
    state.connection = 'connected'; state.failures = 0; state.lease = null;
    await refreshList();
    announce('Workspace unlocked.' + (state.lockedTaskId ? ' The task you had open reopens read-only.' : ''));
    state.lockedTaskId = null;
  }).then(() => { if (state.session.unlocked) onRoute(); }),
  // Lock every workspace view (SESSION-LOCK.md). This view conceals and discards local authority
  // first, synchronously, then asks the workspace. The response only changes the wording on the lock
  // screen: a slow, lost or failed response never restores the unlocked view, and nothing is resent.
  // It does not wait for another action to finish, so Lock is never blocked by a slow request.
  lock() {
    concealSession({explicit: true});
    const epoch = state.sessionEpoch;
    state.lockNotice = 'This view is locked. Waiting for the workspace to confirm that every view is locked.';
    navigate('#/work');
    render();
    return Promise.resolve().then(() => adapter.lock({}))
      .then(result => classifyLockOutcome(result), error => classifyLockOutcome(undefined, error))
      .then(outcome => {
        // A later unlock or Lock owns the screen now.
        if (state.sessionEpoch !== epoch || state.session.unlocked) return;
        if (!mode.synthetic) experienceAdmission().noteLockOutcome(outcome);
        state.lockNotice = storedLockNotice(outcome) ?? storedLockNotice('unconfirmed');
        render();
      });
  },
  // Accepted proposal download, bound to the exact accepted tuple on screen. A refusal is shown and
  // the task is re-read; nothing is retried, accepted or refreshed into another proposal. A response
  // that arrives after a Lock is never saved.
  downloadAccepted: format => act(async epoch => {
    const task = state.task, attempt = task?.attempts.at(-1);
    if (task?.status !== 'accepted' || attempt?.status !== 'accepted' || !attempt.artifact) { setNotice('warn', 'Only an accepted proposal can be downloaded.'); return; }
    const file = fresh(epoch, await adapter.downloadArtifact(task.id, {version: task.version, attemptId: attempt.id, artifactHash: attempt.artifact.sha256, format}));
    actions.download(file.filename, file.bytes);
    setNotice('info', 'Saved ' + file.filename + ': ' + file.byteLength.toLocaleString('en-US') + ' bytes, SHA-256 ' + shortHash(file.sha256) +
      ' matched the workspace. Downloading applies nothing and does not make the content safe to run.');
  }),
  reconnect: () => { state.retryAt = 0; },
  setFilter(filter) { state.filter = filter; render(); },
  setQuery(query) { state.query = query; render(); },
  compose(patch) { Object.assign(state.compose, patch); if ('kind' in patch || 'error' in patch) render(); },
  // Parity with harness/web: load the source from a small text file, read in this tab only. A read
  // that settles after a Lock or session end (fresh, the session generation guard) is dropped
  // whether it succeeded or failed: no source, file name, error, focus or announcement from the
  // earlier session reaches the new one.
  async loadSourceFile(file) {
    if (!file) return;
    const epoch = state.sessionEpoch;
    let loaded;
    try { loaded = fresh(epoch, await readSourceFile(file)); }
    catch (error) {
      if (error?.stale || epoch !== state.sessionEpoch) return;
      state.compose.error = error.message; announce(error.message, true); render();
      return;
    }
    const patch = {source: loaded.source, error: null, rev: state.compose.rev + 1};
    if (state.compose.kind === 'change' && loaded.filename) patch.filename = loaded.filename;
    Object.assign(state.compose, patch);
    state.pendingFocus = '#compose-source';
    announce('Loaded ' + loaded.source.length.toLocaleString('en-US') + ' characters from the file. Nothing has been sent.');
    render();
  },
  discardCompose() {
    state.compose = {kind: 'brief', title: '', request: '', source: '', filename: '', expected: '', editing: null, error: null, rev: state.compose.rev + 1};
    render();
  },
  editScope() {
    const task = state.task;
    state.compose = {kind: task.kind, title: task.title, request: task.request, source: task.source, filename: task.filename ?? '', expected: task.expected ?? '',
      editing: {id: task.id, version: task.version}, error: null, rev: state.compose.rev + 1};
    navigate('#/new');
  },
  submitScope: () => act(async epoch => {
    const {editing, error, rev, ...fields} = state.compose;
    try {
      const saved = fresh(epoch, editing ? await adapter.updateScope(editing.id, {...fields, version: editing.version}) : await adapter.createTask(fields));
      actions.discardCompose();
      navigate('#/task/' + saved.id);
      setNotice('info', 'Draft saved. Nothing runs until you approve a route.');
    } catch (failure) {
      if (failure.status === 400 && !failure.stale && epoch === state.sessionEpoch) { state.compose.error = failure.message; announce(failure.message, true); return; }
      throw failure;
    }
  }),
  selectRoute(key) { state.routeKey = key; clearApproval(); render(); },
  setApprove(value) {
    if (!value) { clearApproval(); render(); return; }
    const route = selectedRoute();
    if (!state.task || !route?.readiness.eligible || state.pendingRun?.uncertain) { clearApproval(); render(); return; }
    const stale = evidenceProblem(state.routes, Date.now());
    if (stale) { clearApproval('Approval is unavailable because ' + stale + '. Refresh routes first.'); render(); return; }
    state.approval = captureApproval(state.task, route, {requestId: crypto.randomUUID()});
    state.approve = true; state.approvalNotice = null;
    render();
  },
  refreshRoutes: () => act(async epoch => {
    const hadApproval = !!state.approval;
    applyRoutes(fresh(epoch, await adapter.refreshRoutes(state.task?.id)));
    if (hadApproval && state.approval) setNotice('info', 'Routes refreshed. No material route fact changed, so your approval still holds.');
    else if (!hadApproval) setNotice('info', 'Routes refreshed.');
  }),
  showAnotherAttempt() { state.anotherAttempt = state.task?.id ?? null; state.pendingFocus = '#approve-heading'; render(); },
  hideAnotherAttempt() { state.anotherAttempt = null; clearApproval(); state.pendingFocus = '[data-fid="another-attempt"]'; render(); },
  // Submits the captured approval, never current values. A diverged approval is cleared, not sent.
  run: () => act(async epoch => {
    const binding = state.approval;
    const problems = approvalProblems(binding, state.task, selectedRoute(), {inventory: state.routes, now: Date.now()});
    if (problems.length) {
      clearApproval('Nothing was sent. Your approval no longer matches what is on screen: ' + problems.join('; ') + '. Review and approve again.');
      return;
    }
    const pending = {taskId: binding.taskId, requestId: binding.requestId, attemptNumber: binding.attemptNumber, body: submissionBody(binding)};
    clearApproval();
    fresh(epoch, await sendRun(pending));
    state.detached = false; state.anotherAttempt = null; state.pendingFocus = '#main h1';
    announce('Attempt started. You are observing read-only.');
    await refreshList();
  }),
  // After an uncertain response: look up the same task and request ID. A 404 is not proof.
  checkRunSubmission: () => act(async epoch => {
    const pending = state.pendingRun;
    if (!pending) return;
    try {
      // A lookup result is correlated by the adapter (request and task ID); then the identity clears.
      const found = await adapter.lookupRunSubmission(pending.taskId, pending.requestId);
      forgetPendingRun(pending.taskId);
      state.task = fresh(epoch, await adapter.getTask(pending.taskId));
      setNotice('info', 'Your submission was recorded as attempt ' + pending.attemptNumber + '. It was not sent again.' +
        (found.attemptStatus === 'running' ? ' You are observing it read-only.' : ''));
      await refreshList();
    } catch (error) {
      if (error.status === 404 && epoch === state.sessionEpoch) { setNotice('warn', 'No recorded submission is visible yet. That does not prove it will never arrive. Keep this request and check again. Nothing new was sent.'); return; }
      throw error;
    }
  }),
  // Sends the identical body with the same request ID. The host replays a recorded submission
  // instead of starting another attempt, and refuses one whose inputs differ.
  resendRunSubmission: () => act(async epoch => {
    const pending = state.pendingRun;
    if (!pending) return;
    const result = fresh(epoch, await sendRun(pending));
    state.pendingFocus = '#main h1';
    setNotice('info', result.runSubmission?.replayed
      ? 'The workspace already had this submission as attempt ' + pending.attemptNumber + '. No new attempt was started.'
      : 'Submission recorded as attempt ' + pending.attemptNumber + '.');
    await refreshList();
  }),
  cancelRequest: () => act(async epoch => { fresh(epoch, await adapter.cancel(state.task.id, {version: state.task.version})); setNotice('info', 'Stop requested. Waiting for the request to end.'); }),
  // target: the attempt, generation and lease observed when the action was chosen. Take and Stop
  // send exactly those values. If what is observed now differs, nothing is sent.
  // A lease that arrives after a Lock is never stored: the host already revoked it.
  terminal: (command, confirm = false, target = null) => act(async epoch => {
    const task = state.task, control = task.live?.control;
    if (command === 'take') {
      const chosen = target ?? {attemptId: control.attemptId, generation: control.generation};
      if (target && !terminalTargetHolds(target, task, null)) { setNotice('warn', 'Terminal ownership changed before this was sent. Nothing was sent.'); return; }
      state.lease = fresh(epoch, await adapter.terminal(task.id, {command, confirm, attemptId: chosen.attemptId, generation: chosen.generation}));
      state.pendingFocus = '[data-fid="term-status"]';
      announce('You have terminal control.');
    } else if (command === 'detach') {
      const held = state.lease;
      state.lease = null; state.detached = true; state.pendingFocus = '[data-fid="term-reattach"]';
      announce('View detached. The run continues.');
      if (held) await adapter.terminal(task.id, {command: 'detach', ...held}).catch(() => {});
      fresh(epoch);
    } else if (command === 'stop') {
      if (!target || !terminalTargetHolds(target, task, state.lease)) { setNotice('warn', 'Terminal control changed before Stop was sent. Nothing was sent.'); return; }
      fresh(epoch, await adapter.terminal(task.id, {command, confirm, attemptId: target.attemptId, generation: target.generation, lease: target.lease}));
      state.lease = null; state.pendingFocus = '[data-fid="term-detach"]';
      announce('Stop requested. Waiting for the local process to exit.');
    } else {
      fresh(epoch, await adapter.terminal(task.id, {command, confirm, ...state.lease}));
      if (command === 'release') { state.lease = null; state.pendingFocus = '[data-fid="term-take"]'; }
      announce(command === 'release' ? 'Control released.' : 'Status requested.');
    }
    state.task = fresh(epoch, await adapter.getTask(task.id));
  }),
  reattach() { state.detached = false; state.pendingFocus = '[data-fid="term-detach"]'; announce('Reattached read-only.'); render(); },
  review: decision => act(async epoch => {
    const attempt = state.task.attempts.at(-1);
    state.task = fresh(epoch, await adapter.review(state.task.id, {version: state.task.version, decision, artifactHash: attempt.artifact.sha256}));
    state.pendingFocus = decision === 'accepted' ? '[data-fid="download"]' : '#main h1';
    setNotice('info', decision === 'accepted' ? 'Accepted. Nothing was applied to a file or repository. Download the result to use it.' : 'Rejected. The proposal stays in this task for reference.');
    await refreshList();
  }),
  revise(content) {
    const epoch = state.sessionEpoch;
    return adapter.revise(state.task.id, {version: state.task.version, artifactHash: state.task.attempts.at(-1).artifact.sha256, content})
      .then(saved => fresh(epoch, saved), error => { fresh(epoch); throw error; });
  },
  taskSaved(task, message) { if (!state.session.unlocked) return; if (task.id === state.task?.id && task.version >= state.task.version) state.task = task; setNotice('info', message); render(); },
  copyOpened: id => act(async () => { navigate('#/task/' + id); setNotice('info', 'Opened the copy. It has no route, approval or result. Review its scope before approving a run.'); }),
  removed(id) {
    if (state.task?.id === id) state.task = null;
    if (rememberedTask(storage) === id) rememberTask(storage, null);
    navigate('#/work');
    setNotice('info', 'Task record removed. Working files, backups and provider copies were not removed.');
    void refreshList().then(render).catch(() => {});
  },
  download(name, content, type = 'text/plain') {
    const url = URL.createObjectURL(new Blob([content], {type}));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  load: (key, fn) => act(async epoch => { state.cache[key] = fresh(epoch, await fn()); }),
  resetProfile(next) { try { storage?.setItem(PROFILE_KEY, next); } catch { /* storage may be disabled */ } location.hash = '#/work'; location.reload(); },
};

// Views and dialogs get the observed adapter: their 401s conceal through lockUi, and their stale
// results are refused. The controller handles its own reads in act and loop.
const ctx = {state, adapter: observedAdapter(adapter), demo, actions, ownsControl, selectedRoute};

// ---- Routing and rendering -------------------------------------------------------------------

const PAGES = {connections: renderConnections, usage: renderUsage, data: renderData, agents: renderAgents, developer: renderDeveloper};
// The host's readiness diagnostic is per task: the open task, else the most recent one.
const LOADERS = {connections: () => Promise.all([adapter.readiness(state.task?.id), adapter.listRoutes()]).then(([readiness, routes]) => ({readiness, routes})),
  usage: () => adapter.receipts(), data: () => adapter.audit(), developer: () => adapter.diagnostics()};

function onRoute() {
  const path = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  state.path = path.length ? path : ['work'];
  const [page, id] = state.path;
  if (!state.session.unlocked) { render(); return; }
  if (page === 'task' && id && state.task?.id !== id) {
    void act(async epoch => {
      try { await openTask(id); }
      catch (error) {
        if (error.status === 404 && epoch === state.sessionEpoch) { state.task = null; navigate('#/work'); setNotice('warn', 'That task is no longer in the workspace.'); }
        else throw error;
      }
    }).then(focusMain);
    return;
  }
  if (page !== 'task' && page !== 'new' && state.task && page !== 'work') { releaseView(); }
  if (page === 'work') { releaseView(); state.task = null; clearApproval(); rememberTask(storage, null); }
  if (LOADERS[page]) void actions.load(page, LOADERS[page]);
  render();
  focusMain();
}

function focusMain() {
  const heading = $('main').querySelector('h1');
  if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({preventScroll: false}); }
}

function render() {
  state.now = Date.now();
  const main = $('main'), sidebar = $('sidebar');
  const [page] = state.path;
  revalidateDialogs();
  // Old route evidence must not keep an approval alive, including while the workspace is unreachable.
  const stale = state.approval ? evidenceProblem(state.routes, Date.now()) : null;
  if (stale) clearApproval('Your approval was cleared because ' + stale + '. Refresh routes and approve again.');
  if (state.approvalNotice && state.approvalNotice !== state.announcedNotice) { state.announcedNotice = state.approvalNotice; announce(state.approvalNotice); }
  if (!state.session.unlocked) {
    sidebar.hidden = true;
    swap($('banner'), 'none', () => []);
    swap(main, stableKey(['unlock', state.session.firstUse, state.unlockError, state.busy, state.connection === 'locked', state.lockedTaskId, state.lockNotice, !!state.pendingRun]), () => renderUnlock(ctx));
    document.title = 'Unlock · CydeWorks AI';
    return;
  }
  sidebar.hidden = false;
  renderSidebar(sidebar, ctx);
  renderBanner($('banner'), ctx);
  if (page === 'work' || page === 'new' || page === 'task') renderWork(main, ctx);
  else if (PAGES[page]) PAGES[page](main, ctx);
  else swap(main, 'notfound', () => { const p = document.createElement('p'); p.textContent = 'That page does not exist.'; return p; });
  if (state.pendingFocus && !state.busy) {
    const target = document.querySelector(state.pendingFocus);
    state.pendingFocus = null;
    if (target) { if (/^H[12]$/.test(target.tagName)) target.setAttribute('tabindex', '-1'); target.focus({preventScroll: true}); }
  }
  document.title = (page === 'task' && state.task ? state.task.title : ({work: 'Work', new: 'New task', connections: 'Connections', usage: 'Usage', data: 'Data and access',
    agents: 'Agents', developer: 'Developer'}[page] ?? 'CydeWorks AI')) + ' · CydeWorks AI';
}

if (demo) $('demo-open').addEventListener('click', () => openDemoControls(ctx));
else {
  // HTTP adapter: no demo controls, and the notice says what this page is connected to.
  $('demo-open').remove();
  document.querySelector('.demo-tag').textContent = 'Local workspace';
  document.querySelector('.demo-text').textContent = 'Review the route and scope before you approve work.';
}
window.addEventListener('hashchange', onRoute);
window.addEventListener('pagehide', releaseView);
function concealForeignGeneration() {
  if (!respondToSharedGeneration(sharedWatch, {
    conceal() {
      if (state.session.unlocked) {
        state.lockNotice = storedLockNotice('unconfirmed');
        concealSession({explicit: false});
        render();
      } else {
        state.sessionEpoch = (state.sessionEpoch ?? 0) + 1;
        if (!mode.synthetic) {
          experienceAdmission().markSharedLocked();
          sharedWatch.observe();
        }
      }
    },
  })) return;
}
window.addEventListener('storage', event => { if (event.key === viewStorageKeys.sharedGeneration) concealForeignGeneration(); });
window.addEventListener('pageshow', concealForeignGeneration);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') concealForeignGeneration(); });
await takeDesktopTicket();
sharedWatch.observe();
state.session = await adapter.session().catch(() => state.session);
{
  const stored = experienceAdmission().localLock();
  const notice = storedLockNotice(stored);
  if (notice) { state.lockNotice = notice; state.connection = 'locked'; state.session = {...state.session, unlocked: false}; }
  else if (experienceAdmission().mustConceal()) state.session = {...state.session, unlocked: false};
}
// Parity with harness/web remember(): opening the workspace root in this tab reopens the last task,
// read-only, once unlocked. Only its ID was kept. A removed task falls back to the list with a notice.
// The demo rebuilds its synthetic tasks on every load, so there is nothing to resume there.
{
  const resume = !mode.synthetic && /^#?\/?$/.test(location.hash) ? rememberedTask(storage) : null;
  if (resume) history.replaceState(null, '', '#/task/' + resume);
}
onRoute();
void loop();
