// Pure view-model logic for the task screen. No DOM and no clock unless passed in.
// The situation panel answers five questions from recorded state only. When a fact is not
// recorded, the answer says so. It never guesses.

import {describeCost, formatDuration} from '../core/format.js';

export const STATUS_LABEL = {draft: 'Needs approval', running: 'Running', review: 'Needs review', accepted: 'Accepted', rejected: 'Rejected',
  failed: 'Needs attention', cancelled: 'Stopped', interrupted: 'Needs recovery'};
export const STATUS_TONE = {draft: 'decision', running: 'active', review: 'decision', accepted: 'ok', rejected: 'neutral',
  failed: 'warn', cancelled: 'neutral', interrupted: 'warn'};

export const STEPS = ['Describe', 'Scope and route', 'Approve', 'Observe', 'Review', 'Decide'];

// Index of the journey step the task is on, plus whether that step is waiting on the person.
export function journeyStep(task) {
  if (!task) return {index: 0, waitingOnYou: true};
  switch (task.status) {
    case 'draft': return {index: 1, waitingOnYou: true};
    case 'running': return {index: 3, waitingOnYou: false};
    case 'review': return {index: 4, waitingOnYou: true};
    case 'accepted': case 'rejected': return {index: 5, waitingOnYou: false, done: true};
    default: return {index: 3, waitingOnYou: true, problem: true};
  }
}

// connection: 'connected' | 'reconnecting' | 'checking' | 'locked' | 'missing'
// route: the currently selected route view (drafts) or null
export function describeSituation(task, {connection = 'connected', route = null, ownsControl = false} = {}) {
  const attempt = task.attempts.at(-1);
  const stale = connection !== 'connected';
  const live = task.live;
  const answer = (text, tone = 'neutral', detail = null) => ({text, tone, detail});
  let happening, decision, next;

  if (stale) {
    happening = answer(connection === 'locked' ? 'The workspace session ended. What you see was saved earlier.'
      : connection === 'missing' ? 'This task is no longer in the workspace.'
      : 'Connection interrupted. What you see may be out of date.', 'warn',
      task.status === 'running' ? 'The run outcome is unknown until the connection returns. No command is replayed.' : null);
    decision = answer(connection === 'locked' ? 'Unlock the workspace to continue.' : 'Nothing can be decided until the saved state is confirmed.', 'warn');
    next = answer(connection === 'locked' ? 'After unlocking, observation resumes read-only.' : 'State is re-read automatically. Actions stay disabled until it matches.');
  } else if (task.status === 'draft') {
    happening = answer('Nothing is running. This is a saved draft.');
    decision = answer(route?.readiness?.eligible ? 'Review the scope and route, then approve this attempt.' : 'Choose a ready route. The current one cannot run.', 'decision');
    next = answer('After approval, exactly one attempt runs on the route you reviewed.');
  } else if (task.status === 'running') {
    happening = live?.stopping ? answer('Stop was requested. Waiting for the local process to exit.', 'warn', 'The outcome is pending, not confirmed.')
      : answer('Attempt ' + task.attempts.length + ' is running on ' + (attempt.routeLabel ?? attempt.model) + '.', 'active',
        attempt.execution?.phase === 'claimed' ? 'The request has not been dispatched yet.' : 'Simulated run in this demonstration.');
    decision = answer(ownsControl ? 'You hold terminal control. Release it when you are done.' : 'Nothing right now. You are observing read-only.');
    next = answer(live?.stopping ? 'An observed local exit stops local activity. If the request was already sent, model server termination stays unconfirmed and a retry is held.'
      : 'When output ends it is validated, then waits for your review.');
  } else if (task.status === 'review') {
    const failed = attempt.checks?.filter(check => !check.pass).length ?? 0;
    happening = answer('Attempt ' + task.attempts.length + ' produced a proposal. Nothing has been applied anywhere.');
    decision = answer(failed ? failed + ' structural check' + (failed === 1 ? '' : 's') + ' failed. Edit the proposal or reject it.'
      : 'Read the proposal, then accept, edit or reject it.', 'decision');
    next = answer('Accepting records your decision and lets you download the result. It does not change a repository.');
  } else if (task.status === 'accepted') {
    happening = answer('You accepted attempt ' + task.attempts.length + (attempt.operatorEdits?.length ? ' after editing it.' : ' as produced.'), 'ok');
    decision = answer('Nothing. Download the result if you want to apply it yourself.');
    next = answer('Nothing happens automatically. Copy as new draft to run this scope again.');
  } else if (task.status === 'rejected') {
    happening = answer('You rejected attempt ' + task.attempts.length + '.');
    decision = answer('Nothing is required. You can approve another attempt.');
    next = answer('Another attempt needs a fresh approval and gets its own receipt.');
  } else {
    const held = !!task.recovery?.blocked, sent = dispatchEvidence(attempt);
    const stopped = task.status === 'cancelled' ? (sent.state === 'not-dispatched' ? 'It was stopped before anything was sent.'
      : sent.state === 'in-page' ? 'It was stopped. Nothing was running outside this workspace.'
      : 'Local activity stopped. Whether the model server stopped working on the request is not confirmed.') : null;
    happening = answer(task.status === 'interrupted' ? 'The run was interrupted. ' + (held ? 'Its outcome is unknown.' : sent.state === 'not-dispatched' ? 'It stopped before anything was sent.' : 'Nothing remains active.')
      : task.status === 'cancelled' ? 'The run was stopped. ' + stopped
      : sent.state === 'not-dispatched' ? 'The attempt failed before anything was sent.' : 'The attempt failed.', 'warn', attempt?.problem ?? null);
    decision = answer(held ? 'A retry is held. The earlier request may still be active.' : 'Review the problem, then approve another attempt if you want one.', held ? 'warn' : 'decision');
    next = answer(held ? 'Nothing runs until the earlier outcome is reconciled. This protects against duplicate work and charges.'
      : 'Another attempt needs a fresh approval.');
  }

  const evidence = dispatchEvidence(attempt);
  const data = task.status === 'draft'
    ? answer(route ? route.destination : 'Nowhere yet. Nothing is sent until you approve a route.', route?.type && route.type !== 'local' ? 'warn' : 'neutral',
      route ? 'Nothing has been sent. Changing the route clears your approval.' : null)
    : answer(evidence.text, evidence.state === 'unknown' ? 'warn' : 'neutral', evidence.detail);

  const costs = task.attempts.map(item => describeCost(item.cost));
  const known = costs.filter(item => item.kind !== 'unavailable').length;
  const cost = !task.attempts.length ? answer('Nothing yet. No attempt has run.', 'neutral', 'Cost is shown per attempt with its evidence.')
    : known === 0 ? answer('Unavailable. No charge was recorded for ' + (task.attempts.length === 1 ? 'this attempt' : 'these ' + task.attempts.length + ' attempts') + '.',
      'neutral', 'Unknown is not zero. Local runs still use electricity and hardware.')
    : answer(known + ' of ' + task.attempts.length + ' attempt' + (task.attempts.length === 1 ? ' has' : 's have') + ' a recorded figure. See Usage for each one.',
      'neutral', costs.some(item => item.kind === 'estimated') ? 'At least one figure is an estimate, not a provider invoice.' : null);

  return {happening, decision, next, data, cost};
}

// Whether an attempt's approved text actually left the workspace, from recorded dispatch phase only.
// The host persists the dispatching phase before it crosses the provider boundary, so an attempt
// that ended while still claimed provably sent nothing. An attempt record alone proves nothing.
//   in-page         synthetic fixture, no model and no destination
//   pending         claimed and still running: route being checked, nothing sent yet
//   not-dispatched  ended before dispatch: nothing was sent
//   in-flight       dispatch began and the run is still active
//   delivered       the route returned a settled result
//   unknown         dispatch began but no completion evidence exists, or the phase is not recorded
export function dispatchEvidence(attempt) {
  if (!attempt) return {state: 'none', text: 'Nowhere. No attempt has run.', detail: null};
  const name = attempt.routeLabel ?? attempt.model ?? 'the route';
  const phase = attempt.execution?.phase, running = attempt.status === 'running';
  const isolation = 'A loopback address does not prove the request stayed on this computer.';
  if (attempt.provider === 'fixture') return {state: 'in-page', text: 'Nowhere. The synthetic fixture runs inside this workspace without a model.', detail: null};
  if (attempt.recovery?.evidence === 'dispatch-not-started' || (phase === 'claimed' && !running && attempt.recovery?.state !== 'unresolved'))
    return {state: 'not-dispatched', text: 'Not sent. The attempt ended before dispatch to ' + name + '.', detail: 'The workspace records dispatch before contacting a route, and no dispatch was recorded.'};
  if (phase === 'claimed' && running) return {state: 'pending', text: 'Not sent yet. The route is being checked.', detail: null};
  if (phase === 'settled') return {state: 'delivered', text: 'The approved request and source went to ' + name + '.', detail: 'The route returned a result. ' + isolation};
  if (phase === 'dispatching' && running) return {state: 'in-flight', text: 'Being sent to ' + name + '. The route may be processing it.', detail: isolation};
  if (phase === 'dispatching') return {state: 'unknown', text: 'Unknown whether ' + name + ' received the request.', detail: 'Dispatch began, but no completion evidence was recorded.'};
  return {state: 'unknown', text: 'Not established. The record does not show whether dispatch began.', detail: null};
}

// Execution, waiting and review time for one attempt, from recorded timestamps only.
// Returns null for any part that was not recorded.
export function attemptTiming(task, index) {
  const attempt = task.attempts[index];
  if (!attempt) return null;
  const time = value => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; };
  const started = time(attempt.started), ended = time(attempt.ended);
  const previousEnd = index === 0 ? time(task.events.find(event => event.event === 'task.created')?.at) : time(task.attempts[index - 1].ended);
  const decision = task.events.find(event => /^review\.(accepted|rejected)$/.test(event.event) && time(event.at) !== null && ended !== null && time(event.at) >= ended &&
    (index === task.attempts.length - 1 || time(event.at) <= time(task.attempts[index + 1].started)));
  const unknownEnd = attempt.status === 'interrupted' || attempt.status === 'running';
  return {
    waitingMs: started !== null && previousEnd !== null && started >= previousEnd ? started - previousEnd : null,
    executionMs: unknownEnd ? null : (typeof attempt.elapsedMs === 'number' ? attempt.elapsedMs : started !== null && ended !== null ? ended - started : null),
    reviewMs: decision && ended !== null ? time(decision.at) - ended : null,
    note: attempt.status === 'interrupted' ? 'Only the time the interruption was noticed is recorded, not when work stopped.' : null,
  };
}

export function timingLine(timing) {
  if (!timing) return 'Unavailable';
  return 'Waiting for you ' + formatDuration(timing.waitingMs) + ' · Execution ' + formatDuration(timing.executionMs) + ' · Review ' + formatDuration(timing.reviewMs);
}

// Progress steps for a running attempt. Steps come from recorded phase, never from a guess.
export function progressModel(task, nowMs) {
  const attempt = task.attempts.at(-1), live = task.live;
  if (!attempt || !live) return null;
  // The page clock can trail the recorded time by a moment. Clamp small skew, reject anything further ahead.
  const time = value => { const parsed = Date.parse(value); return Number.isFinite(parsed) && parsed <= nowMs + 5000 ? Math.min(parsed, nowMs) : null; };
  const started = time(attempt.started), dispatched = time(attempt.execution?.dispatchedAt), last = time(live.lastActivity);
  const chars = Number.isSafeInteger(live.chars) && live.chars >= 0 ? live.chars : null;
  const idle = last === null ? null : nowMs - last;
  const phase = live.stopping ? 'stopping' : attempt.execution?.phase === 'claimed' ? 'checking' : chars > 0 ? 'receiving' : 'waiting';
  const state = phase === 'stopping' ? 'Stop requested' : phase === 'checking' ? 'Checking the selected route'
    : idle !== null && idle >= 60000 ? 'Possibly stalled' : phase === 'receiving' && idle !== null && idle >= 15000 ? 'Waiting for more output'
    : phase === 'receiving' ? 'Receiving output' : 'Waiting for model output';
  const order = ['Scope approved', 'Route checked', 'Request dispatched', 'Output received', 'Proposal validated'];
  const done = phase === 'checking' ? 1 : phase === 'waiting' ? 3 : phase === 'receiving' ? 3 : 1;
  const current = phase === 'checking' ? 1 : 3;
  return {
    state, stalled: state === 'Possibly stalled', stopping: phase === 'stopping',
    steps: order.map((label, index) => ({label, status: phase === 'stopping' ? (index < done ? 'done' : 'skipped') : index < done ? 'done' : index === current ? 'current' : 'remaining'})),
    completed: Math.min(done, order.length), total: order.length,
    elapsedMs: started === null ? null : nowMs - started,
    chars, windowMs: chars > 0 && dispatched !== null ? nowMs - dispatched : null,
    lastActivity: last, idleMs: idle, heartbeat: time(live.heartbeat),
    eta: phase === 'stopping' ? 'Unavailable. Waiting for evidence that the process exited.'
      : 'Unavailable. The total output length is not known, so remaining time cannot be measured.',
    explanation: phase === 'stopping' ? 'Waiting for the run to end. Termination is not yet confirmed.'
      : phase === 'checking' ? 'The request has not been dispatched yet.'
      : state === 'Possibly stalled' ? 'No new output for at least 60 seconds. The model may still be working.'
      : phase === 'receiving' ? 'Output is arriving. Its total length is not known.' : 'The model may be loading, processing context or generating.',
  };
}
