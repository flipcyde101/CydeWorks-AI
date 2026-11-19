import {h, icon, swap, stableKey} from '../core/dom.js';
import {button, chip, notice, kv, panel, disclosure, planned, simulated, approximation, confirmDialog, announce} from '../ui/primitives.js';
import {STATUS_LABEL, STATUS_TONE, STEPS, journeyStep, describeSituation, dispatchEvidence, attemptTiming, timingLine} from '../logic/situation.js';
import {progressUiState} from '../vendor/harness-web/progress-ui.js';
import {terminalTarget, terminalTargetHolds} from '../logic/approval.js';
import {describeCost, formatDuration, formatClock, formatDateTime, formatCount, formatAge, shortHash} from '../core/format.js';
import {demoAcceptance} from '../demo/acceptance.js';
import {openProposalEditor, openCopyDialog, openExportDialog, openRemovalDialog} from './dialogs.js';
import {summarizeUsage, describeStepReceipt} from '../vendor/harness-web/usage.js';
import {acceptedAttemptComparison} from '../logic/parity.js';

const QUESTIONS = [['happening', 'What is happening'], ['decision', 'What needs your decision'], ['next', 'What happens next'],
  ['data', 'Where your data goes'], ['cost', 'What this costs']];
const TYPE_LABEL = {local: 'Local', subscription: 'Subscription', metered: 'Metered API'};

export function renderTask(container, ctx) {
  const {state} = ctx, task = state.task;
  if (container.dataset.swapKey !== 'task:' + task.id) {
    container.replaceChildren(...['head', 'steps', 'overview', 'pending', 'primary', 'usage', 'foot'].map(id => h('div', {id: 'task-' + id, class: 'stack'})));
    container.dataset.swapKey = 'task:' + task.id;
    delete container.dataset.progressAnnouncement;
  }
  const region = id => container.querySelector('#task-' + id);
  const locked = state.connection !== 'connected' || state.needsReconcile || state.busy;
  const attempt = task.attempts.at(-1);
  const owns = ctx.ownsControl();
  const progressConnection = state.needsReconcile && state.connection === 'connected' ? 'checking' : state.connection;
  const {view: progressView, announcement} = progressUiState(task, state.now, progressConnection);
  if (container.dataset.progressAnnouncement !== announcement) {
    container.dataset.progressAnnouncement = announcement;
    if (announcement) announce(announcement);
  }

  swap(region('head'), stableKey([task.title, task.status, locked, task.copy]), () => [
    h('a', {class: 'btn btn-quiet back', href: '#/work'}, icon('back'), 'All tasks'),
    h('div', {class: 'row-between'},
      h('div', {class: 'row grow'}, h('h1', null, task.title), chip(STATUS_LABEL[task.status], STATUS_TONE[task.status])),
      button('Copy as new draft', {kind: 'quiet', fid: 'copy-task', disabled: locked, onClick: event => openCopyDialog(ctx, event.currentTarget)}))]);

  const step = journeyStep(task);
  swap(region('steps'), stableKey(step), () => h('ol', {class: 'steps', 'aria-label': 'Task journey'}, STEPS.map((name, index) => {
    const status = index < step.index || (step.done && index === step.index) ? 'done' : index === step.index ? 'current' : 'todo';
    return h('li', {class: status + (step.done && index === step.index ? ' last' : ''), 'aria-current': status === 'current' ? 'step' : undefined},
      h('span', {class: 'dot', 'aria-hidden': 'true'}, status === 'done' ? '✓' : String(index + 1)), h('span', {class: 'name'}, name),
      h('span', {class: 'sr-only'}, status === 'done' ? ' (done)' : status === 'current' ? (step.problem ? ' (needs attention)' : ' (current)') : ''));
  })));

  // A short overview: one line per question. Warnings keep their detail in view; other supporting
  // detail is collected in one disclosure.
  const situation = describeSituation(task, {connection: state.needsReconcile && state.connection === 'connected' ? 'checking' : state.connection,
    route: ctx.selectedRoute(), ownsControl: owns});
  swap(region('overview'), stableKey(situation), () => {
    const inline = key => situation[key].tone === 'warn' && situation[key].detail;
    const details = QUESTIONS.filter(([key]) => situation[key].detail && !inline(key)).map(([key, label]) => [label, situation[key].detail]);
    return h('section', {class: 'panel overview', 'aria-label': 'Task situation'},
      h('dl', {class: 'situation'}, QUESTIONS.map(([key, label]) => h('div', {class: 'tone-' + situation[key].tone}, h('dt', null, label),
        h('dd', null, h('span', null, situation[key].text), inline(key) ? h('span', {class: 'detail'}, situation[key].detail) : null)))),
      details.length ? disclosure('More about this status', 'overview-more', kv(details)) : null);
  });

  const pending = state.pendingRun?.taskId === task.id && state.pendingRun.uncertain ? state.pendingRun : null;
  swap(region('pending'), stableKey([pending, locked]), () => pending ? pendingPanel(ctx, pending, locked) : []);

  const primary = region('primary');
  if (task.status === 'running') renderRunning(primary, ctx, {locked, owns, model: progressView, progressConnection});
  else {
    const decided = ['accepted', 'rejected'].includes(task.status);
    const showApproval = !task.recovery?.blocked && task.status !== 'review' && (!decided || state.anotherAttempt === task.id);
    const acceptance = attempt?.artifact ? demoAcceptance(task) : null;
    swap(primary, stableKey([task.version, task.status, state.routes, state.routeKey, state.approve, state.approvalNotice, locked, acceptance,
      showApproval, !!pending, state.now - (state.now % 30000)]), () => [
      ['failed', 'cancelled', 'interrupted'].includes(task.status) ? problemPanel(task, attempt) : null,
      attempt?.artifact ? reviewPanel(ctx, attempt, acceptance, locked, decided && !showApproval) : null,
      showApproval ? approvePanel(ctx, locked, {pending: !!pending, secondary: decided}) : null,
      task.status !== 'draft' ? disclosure('Scope and source snapshot', 'scope-after', scopeFacts(task)) : null,
    ]);
  }

  swap(region('usage'), stableKey([task.attempts, task.events.length]), () => usagePanel(ctx));
  swap(region('foot'), stableKey([task.events.length, task.approvals?.length, locked]), () => [
    panel('History and data',
      disclosure('Approval history (' + (task.approvals?.length ?? 0) + ')', 'approvals',
        task.approvals?.length ? h('ol', {class: 'stack'}, task.approvals.map(item => h('li', null, kv([
          ['Approved', formatDateTime(item.at) + ' for attempt ' + item.attemptNumber], ['Route', item.routeLabel + ' (' + (TYPE_LABEL[item.routeType] ?? item.routeType) + ')'],
          ['Data destination', item.destination], ['Source snapshot', shortHash(item.sourceHash)],
          ['Model identity', item.identity ? shortHash(item.identity) + ' (' + item.identityKind + ')' : 'None. No model ran.'],
          ['Permissions', item.permissions.length ? item.permissions.join('; ') : 'Not recorded by the workspace'], ['Validity', item.use]]))))
          : h('p', {class: 'muted'}, 'No approval has been given for this task.'),
        h('p', {class: 'faint'}, task.approvalsRecordedBy === 'host'
          ? 'From each attempt record: when it started, the model and the identity you approved. The workspace does not record the destination text or permissions shown at approval.'
          : 'Recorded when each approval was given. Simulated: the host does not store an approval history yet.')),
      disclosure('Task history (' + task.events.length + ' events)', 'events',
        h('ol', {class: 'stack faint'}, task.events.map(event => h('li', null, formatDateTime(event.at) + ' · ' + event.event.replaceAll('.', ' / ').replaceAll('_', ' '))))),
      h('div', {class: 'row'},
        button('Preview metadata export', {fid: 'export', disabled: locked, onClick: event => openExportDialog(ctx, event.currentTarget)}),
        button('Review task removal', {kind: 'danger', fid: 'remove', disabled: locked, onClick: event => openRemovalDialog(ctx, event.currentTarget)}))),
  ]);
}

// ---- Scope, route and approval ---------------------------------------------------------------

function scopeFacts(task) {
  return [kv([['Request', task.request], ['Workflow', task.kind === 'change' ? 'Proposed change to one file' : 'Written answer from supplied text'],
    task.kind === 'change' ? ['File', task.filename] : null, task.kind === 'change' ? ['Must contain', task.expected] : null,
    ['Snapshot SHA-256', h('span', {class: 'mono'}, task.sourceHash)]]),
  h('pre', {tabindex: '0', 'aria-label': 'Source snapshot'}, task.source)];
}

function routeOption(route, state, actions, locked, suggested) {
  return h('label', {class: 'route'},
    h('input', {type: 'radio', name: 'route', value: route.key, checked: route.key === state.routeKey, disabled: !route.readiness.eligible || locked,
      dataset: {fid: 'route-' + route.key}, onchange: () => actions.selectRoute(route.key)}),
    h('span', null,
      h('span', {class: 'name'}, route.label + (route.quantization ? ' · ' + route.quantization : ''), chip(TYPE_LABEL[route.type] ?? route.type),
        route.planned ? planned() : route.readiness.eligible ? chip('Preview check passed', 'ok', '✓') : chip('Held', 'warn', '!'),
        route.engine === 'fixture' ? null : simulated(), suggested ? chip('Suggested', 'decision') : null),
      h('span', {class: 'why'}, 'Adapter: ' + route.adapterLabel + ' · Model backend: ' + route.backendLabel),
      route.readiness.eligible ? null : h('span', {class: 'why'}, route.readiness.reason)));
}

// The decision sits directly under what will be sent and where it goes.
function approvePanel(ctx, locked, {pending, secondary}) {
  const {state, actions} = ctx, task = state.task, inventory = state.routes;
  if (!inventory) return panel('Review and approve', h('p', {class: 'loading', role: 'status'}, 'Reading available routes.'));
  const selected = ctx.selectedRoute(), suggestion = inventory.suggestion;
  const number = task.attempts.length + 1;
  const ready = !!selected?.readiness.eligible;
  const available = inventory.routes.filter(route => route.readiness.eligible);
  const unavailable = inventory.routes.filter(route => !route.readiness.eligible);
  const lines = task.source.split('\n').filter(line => line.trim()).length;
  const blockedBy = pending ? 'Resolve the earlier submission first.' : !ready ? 'Choose a route that passes the preview check.'
    : !state.approve ? 'Tick the approval to enable this.' : 'One attempt runs. The server checks everything again before it starts.';
  return h('section', {class: 'panel approve', id: 'approve-panel', 'aria-labelledby': 'approve-heading'},
    h('div', {class: 'panel-head'}, h('h2', {id: 'approve-heading', tabindex: '-1'}, number === 1 ? 'Review and approve' : 'Approve attempt ' + number),
      h('div', {class: 'row'},
        task.status === 'draft' ? button('Edit scope', {kind: 'quiet', fid: 'edit-scope', disabled: locked, onClick: actions.editScope}) : null,
        secondary ? button('Cancel', {kind: 'quiet', fid: 'cancel-another', onClick: actions.hideAnotherAttempt}) : null)),
    state.approvalNotice ? notice('warn', h('p', {dataset: {fid: 'approval-notice'}}, state.approvalNotice)) : null,
    h('div', {class: 'stack'}, h('h3', null, 'What will be sent'),
      kv([['Request', task.request], ['Workflow', task.kind === 'change' ? 'Proposed change to one file' : 'Written answer from supplied text'],
        task.kind === 'change' ? ['File', task.filename + ', must contain “' + task.expected + '”'] : null,
        ['Source', lines + (lines === 1 ? ' line' : ' lines') + ' · snapshot ' + shortHash(task.sourceHash)]]),
      disclosure('Source text and full hash', 'source-full', h('pre', {tabindex: '0', 'aria-label': 'Source snapshot'}, task.source),
        h('p', {class: 'faint mono'}, task.sourceHash))),
    h('div', {class: 'stack'}, h('div', {class: 'row-between'}, h('h3', null, 'Route'),
      button('Refresh routes', {kind: 'quiet', fid: 'refresh-routes', disabled: locked, onClick: actions.refreshRoutes})),
      available.length ? h('fieldset', {class: 'routes'}, h('legend', {class: 'sr-only'}, 'Routes that pass the preview check'),
        available.map(route => routeOption(route, state, actions, locked, route.key === suggestion?.routeKey)))
        : notice('warn', h('p', null, 'No route passes the preview check right now. Refresh routes, or see Connections for what each route needs.')),
      unavailable.length ? disclosure('Unavailable routes (' + unavailable.length + ')', 'routes-unavailable',
        h('fieldset', {class: 'routes'}, h('legend', {class: 'sr-only'}, 'Unavailable routes'), unavailable.map(route => routeOption(route, state, actions, true, false)))) : null,
      suggestion ? disclosure('Why the suggested route', 'why-route',
        h('ul', {class: 'stack'}, suggestion.reasons.map(reason => h('li', null, reason))),
        suggestion.designSample === false
          ? h('p', {class: 'faint'}, 'This is the workspace order: your previous route, then the smallest model that passes the preview check. It is not a quality judgment.')
          : h('p', {class: 'planned-line'}, planned('Design sample'), 'Today the workspace preselects your previous route, then the smallest model that passes the preview check.')) : null),
    selected ? h('div', {class: 'stack destination'},
      kv([['Where it goes', selected.destination], ['Cost', (TYPE_LABEL[selected.type] ?? selected.type) + '. ' + selected.billing.detail]]),
      disclosure('Route details', 'route-details', kv([
        ['Endpoint', selected.endpoint ?? 'None'],
        ['Model identity', (selected.identity.value ? shortHash(selected.identity.value) + '. ' : '') + selected.identity.note],
        ['Permissions requested', selected.permissions.length ? selected.permissions.join('; ') : 'Not reported by the workspace'],
        ['Isolation', 'Not verified. A loopback address does not prove OS-level isolation.'],
        ['Evidence', 'Observed ' + formatAge(Math.max(0, state.now - Date.parse(inventory.observedAt)))],
        ['Preview check', selected.readiness.reason + ' Passing it is not permission to run.']]))) : null,
    h('div', {class: 'decision'},
      h('label', {class: 'check'},
        h('input', {type: 'checkbox', checked: state.approve, disabled: !ready || locked || pending, dataset: {fid: 'approve'},
          onchange: event => actions.setApprove(event.target.checked)}),
        h('span', null, 'I approve sending this source snapshot and request to ' + (selected?.label ?? 'the selected route') + ' for attempt ' + number + '.')),
      h('div', {class: 'row'},
        button('Approve and run attempt ' + number, {kind: 'primary', fid: 'run', disabled: !ready || !state.approve || locked || pending, onClick: actions.run}),
        h('span', {class: 'faint', id: 'run-hint'}, blockedBy)),
      h('p', {class: 'faint'}, 'A change to this task or to any material route fact (model identity or build, destination, cloud setting, permissions, readiness) clears the approval. A held route never falls back to a paid one.')));
}

function pendingPanel(ctx, pending, locked) {
  const {actions} = ctx;
  return h('section', {class: 'panel', 'aria-labelledby': 'pending-heading'},
    h('h2', {id: 'pending-heading'}, 'Run submission outcome unknown'),
    notice('danger', h('p', null, 'The response to your approval for attempt ' + pending.attemptNumber + ' was lost. The workspace may or may not have recorded it.')),
    pending.retryRejected ? notice('warn', h('p', {'data-fid': 'resend-refused'}, 'Your last resend was refused' +
      (pending.retryRejected.status ? ' (HTTP ' + pending.retryRejected.status + ')' : '') +
      '. That refusal applies only to the resend. Whether the original submission was recorded is still unknown, so this request is kept.')) : null,
    h('p', null, 'Check the result first. Sending again uses the same request, so a recorded submission is returned instead of starting a second attempt. A new approval is unavailable until this is resolved.'),
    h('div', {class: 'row'},
      button('Check submission result', {kind: 'primary', fid: 'check-submission', disabled: locked, onClick: actions.checkRunSubmission}),
      button('Send the same submission again', {fid: 'resend-submission', disabled: locked, onClick: actions.resendRunSubmission})),
    h('p', {class: 'faint mono'}, 'Request ' + shortHash(pending.requestId) + ' · task version ' + pending.body.version + ' · kept in this tab, no task text'));
}

function problemPanel(task, attempt) {
  const held = task.recovery?.blocked, sent = dispatchEvidence(attempt);
  return panel(task.status === 'interrupted' ? 'Recovery' : task.status === 'cancelled' ? 'Stopped' : 'Problem',
    notice(held ? 'danger' : 'warn', h('p', null, attempt?.problem ?? 'The attempt did not finish.')),
    kv([['Data sent', sent.text], held ? ['Recorded evidence', attempt?.recovery?.evidence ?? 'none'] : null]),
    held ? h('div', {class: 'stack'},
      h('p', null, 'Starting another attempt, copying and removal are held until the earlier outcome is known. This prevents duplicate work and duplicate charges.'),
      h('p', {class: 'planned-line'}, planned(), 'A guided reconcile step for unknown outcomes. Today it clears only when the backend records that the request settled.'))
      : null);
}

// ---- Running: progress and terminal ----------------------------------------------------------

function renderRunning(container, ctx, {locked, owns, model, progressConnection}) {
  const {state, actions} = ctx, task = state.task, attempt = task.attempts.at(-1);
  if (container.dataset.swapKey !== 'running') {
    container.replaceChildren(h('div', {id: 'run-progress', class: 'stack'}), h('div', {id: 'run-terminal', class: 'stack'}));
    container.dataset.swapKey = 'running';
  }
  const stale = progressConnection !== 'connected';
  swap(container.querySelector('#run-progress'), stableKey([model, stale, locked, attempt.provider, task.live?.stopping === true]), () => {
    if (!model) return panel('Progress', notice('warn', h('p', null, 'Progress is hidden while the connection is unverified. The last saved state may be out of date.')));
    const stopping = task.live?.stopping === true || model.phase === 'stopping';
    const attention = !model.available || model.stalled || model.failed || stopping ||
      ['interrupted', 'cancelled', 'unavailable'].includes(model.phase);
    return panel([h('div', {class: 'row'}, h('h2', null, 'Progress'), simulated()),
      h('div', {class: 'row'}, h('span', {class: 'pulse' + (attention ? ' pulse-off' : ''), 'aria-hidden': 'true'}), chip(model.status, attention ? 'warn' : 'active'))],
    h('p', null, model.explanation),
    kv(model.pairs),
    attempt.provider !== 'opencode' ? h('div', {class: 'row'},
      button('Stop this request', {kind: 'danger', fid: 'cancel-request', disabled: locked || stopping, onClick: event => confirmDialog({
        title: 'Stop this request?', opener: event.currentTarget, confirmLabel: 'Stop request', destructive: true, onConfirm: actions.cancelRequest,
        lines: ['Attempt ' + task.attempts.length + ' on ' + attempt.routeLabel + ' will be asked to stop.',
          'If the request was already sent, the workspace cannot confirm the route stopped working on it. The outcome is then recorded as unknown and a retry is held.']})}),
      stopping ? h('span', {class: 'faint'}, 'Stop requested. Waiting for confirmation.') : null) : null);
  });

  const live = task.live, control = live?.control;
  const lines = live?.terminal ?? [];
  swap(container.querySelector('#run-terminal'), stableKey([attempt.provider, lines.length, control, owns, state.detached, live?.stopping, stale, locked]), () => {
    if (attempt.provider !== 'opencode') return [];
    const otherOwner = control?.owner === 'Operator' && !owns;
    const ownerChip = stale ? chip('Read-only · connection unverified', 'warn') : owns ? chip('You have control', 'active') : otherOwner ? chip('Another view has control', 'warn') : chip('Read-only', 'neutral', '○');
    const changed = what => () => actions.setNotice('warn', 'Terminal ' + what + ' changed while the confirmation was open. Nothing was sent. Review the current owner before deciding again.');
    // Each confirmation is bound to the attempt, generation and lease observed when it opened.
    const takeover = event => {
      const target = terminalTarget(task, null);
      confirmDialog({title: 'Take over terminal control?', opener: event.currentTarget, confirmLabel: 'Take over',
        holds: () => terminalTargetHolds(target, ctx.state.task, null), onInvalid: changed('ownership'),
        onConfirm: () => actions.terminal('take', true, target),
        lines: ['Another view controls attempt ' + task.attempts.length + ' (ownership generation ' + target.generation + '). Taking over ends that control immediately.',
          'The run itself is not affected. If ownership changes before you confirm, this closes without sending anything.']});
    };
    const stop = event => {
      const target = terminalTarget(task, state.lease);
      confirmDialog({title: 'Stop the managed process?', opener: event.currentTarget, confirmLabel: 'Stop process', destructive: true,
        holds: () => ctx.ownsControl() && terminalTargetHolds(target, ctx.state.task, ctx.state.lease), onInvalid: changed('control'),
        onConfirm: () => actions.terminal('stop', true, target),
        lines: ['Attempt ' + task.attempts.length + ' (' + attempt.routeLabel + ', generation ' + target.generation + ') will be asked to stop. Work in progress is discarded.',
          'Stop asks the local OpenCode process to exit. If the request already reached the model server, the workspace cannot confirm that server stopped, so the outcome is recorded as unknown and a retry is held.',
          'To leave the run going, use Detach instead.']});
    };
    return panel([h('div', {class: 'row'}, h('h2', null, 'Terminal'), simulated()), ownerChip],
      h('p', {class: 'faint'}, 'Observing attempt ' + task.attempts.length + ' · ' + shortHash(control?.attemptId) + ' · ownership generation ' + (control?.generation ?? 'unknown')),
      state.detached
        ? notice('info', h('p', null, 'View detached. The run is still active. Reattach to observe it again. Reattaching opens read-only.'))
        : h('pre', {class: 'terminal-log', tabindex: '0', role: 'log', 'aria-label': 'Terminal output, read-only', dataset: {keepScroll: 'terminal'}},
          lines.map(line => formatClock(line.at) + '  ' + line.message).join('\n') || 'Waiting for output.'),
      live?.stopping ? notice('warn', h('p', null, 'Stop requested. Waiting for the local process to exit. Nothing else can be sent.')) : null,
      h('div', {class: 'row'},
        state.detached ? button('Reattach', {fid: 'term-reattach', onClick: actions.reattach}) : [
          !owns && !live?.stopping ? button(otherOwner ? 'Take over' : 'Take control', {fid: 'term-take', disabled: locked, onClick: otherOwner ? takeover : () => actions.terminal('take')}) : null,
          owns ? button('Check status', {fid: 'term-status', disabled: locked, onClick: () => actions.terminal('status')}) : null,
          owns ? button('Release', {fid: 'term-release', disabled: locked, onClick: () => actions.terminal('release')}) : null,
          owns ? button('Stop', {kind: 'danger', fid: 'term-stop', disabled: locked, onClick: stop}) : null,
          button('Detach', {kind: 'quiet', fid: 'term-detach', disabled: state.busy, onClick: () => actions.terminal('detach')})]),
      disclosure('About terminal control', 'term-about',
        h('p', {class: 'faint'}, owns ? 'Control expires after 15 seconds without a heartbeat from this view.'
          : 'Taking control lets this view check status and stop the run. It is not a shell and cannot type into the process. Detach leaves the run going.'),
        h('p', {class: 'planned-line'}, planned(), 'An interactive shell. It requires OS-level confinement first and is not available.')));
  });
}

// ---- Review ----------------------------------------------------------------------------------

// A patch carries the original source as well as the proposal, so that is said before it is saved.
// The dialog is bound to the accepted tuple it was opened for and closes unsent if that changes.
function confirmPatch(ctx, attempt, opener) {
  const {state, actions} = ctx, task = state.task;
  const bound = {id: task.id, version: task.version, attemptId: attempt.id, hash: attempt.artifact.sha256};
  confirmDialog({title: 'Download the patch?', opener, confirmLabel: 'Download patch',
    lines: ['The patch contains the original source of ' + task.filename + ' as well as the accepted proposal.',
      'Review it before sharing it outside this computer. Downloading applies nothing to any file or repository.'],
    holds: () => {
      const now = state.task, last = now?.attempts.at(-1);
      return now?.id === bound.id && now.version === bound.version && now.status === 'accepted' && last?.id === bound.attemptId && last?.artifact?.sha256 === bound.hash;
    },
    onInvalid: () => actions.setNotice('warn', 'The accepted proposal changed before the patch was downloaded. Nothing was downloaded.'),
    onConfirm: () => actions.downloadAccepted('patch')});
}

function reviewPanel(ctx, attempt, acceptance, locked, offerAnother) {
  const {state, actions} = ctx, task = state.task, reviewing = task.status === 'review';
  const failed = attempt.checks.filter(check => !check.pass).length;
  const decision = task.events.findLast(event => /^review\./.test(event.event));
  const edits = attempt.operatorEdits?.length ?? 0;
  const claims = attempt.claims ?? [];
  const human = task.status === 'accepted' ? ['pass', '✓', 'Accepted by you ' + formatDateTime(decision?.at) + (edits ? ', after ' + edits + ' edit' + (edits === 1 ? '' : 's') + ' of yours.' : ', as produced.')]
    : task.status === 'rejected' ? ['fail', '✕', 'Rejected by you ' + formatDateTime(decision?.at) + '.']
    : reviewing ? ['unverified', '○', 'Waiting for you. Read the result against the source before deciding.'] : ['unverified', '○', 'Not reviewed. The attempt did not reach a decision.'];
  return panel([h('h2', null, reviewing ? 'Review the proposal' : 'Result'), chip('Nothing applied', 'neutral')],
    h('p', null, attempt.artifact.summary),
    h('div', {class: task.kind === 'change' ? 'compare' : 'stack'},
      task.kind === 'change' ? h('div', {class: 'stack'}, h('h3', null, 'Approved source'), h('pre', {tabindex: '0', 'aria-label': 'Approved source'}, task.source)) : null,
      h('div', {class: 'stack'}, h('h3', null, edits ? 'Proposed result (edited by you)' : 'Proposed result'),
        h('pre', {tabindex: '0', 'aria-label': 'Proposed result', id: 'artifact'}, attempt.artifact.content))),
    attempt.artifact.patch ? disclosure('Proposed changes as a patch', 'patch', h('pre', {tabindex: '0'}, attempt.artifact.patch)) : null,
    attempt.originalArtifact ? disclosure('Original proposal before your edits', 'original', h('pre', {tabindex: '0'}, attempt.originalArtifact.content)) : null,
    task.kind === 'brief' ? disclosure('Source context', 'source-context', h('pre', {tabindex: '0'}, task.source.split(/\n+/).filter(line => line.trim()).map((line, index) => '[' + (index + 1) + '] ' + line).join('\n'))) : null,
    h('div', {class: 'evidence' + (claims.length ? '' : ' evidence-two')},
      h('section', {'aria-label': 'Structural validation'}, h('h3', null, 'Structural validation'),
        h('ul', {class: 'stack'}, attempt.checks.map(check => h('li', {class: check.pass ? 'pass' : 'fail'},
          h('span', {class: 'sym', 'aria-hidden': 'true'}, check.pass ? '✓' : '✕'), h('span', null, h('strong', null, check.pass ? 'Pass: ' : 'Fail: '), check.name)))),
        h('p', {class: 'faint'}, 'Checked by the workspace. These inspect form, not correctness.')),
      claims.length ? h('section', {'aria-label': 'Model claims'}, h('h3', null, 'Model claims'),
        h('ul', {class: 'stack'}, claims.map(claim => h('li', {class: 'unverified'},
          h('span', {class: 'sym', 'aria-hidden': 'true'}, '?'), h('span', null, h('strong', null, 'Unverified: '), claim.text, h('span', {class: 'faint'}, ' ' + claim.why))))),
        h('p', {class: 'faint'}, 'Statements from the model are not evidence.')) : null,
      h('section', {'aria-label': 'Human acceptance'}, h('h3', null, 'Human acceptance'),
        h('ul', {class: 'stack'}, h('li', {class: human[0]}, h('span', {class: 'sym', 'aria-hidden': 'true'}, human[1]), h('span', null, human[2]))),
        h('p', {class: 'faint'}, 'Only you can accept. Passing checks never accept a proposal.'))),
    acceptance ? disclosure('Advisory checklist: ' + acceptance.summary.satisfied + ' of ' + acceptance.summary.required + ' required checks satisfied', 'acceptance',
      h('p', {class: 'row'}, approximation(), h('span', {class: 'grow'}, acceptance.explanation)),
      Object.entries({structural: 'Structural (workspace inspection)', executed: 'Executed (test runner)', human: 'Human review (you)'}).map(([key, label]) =>
        h('div', {class: 'stack'}, h('h3', null, label), acceptance.groups[key].length ? h('ul', {class: 'stack'}, acceptance.groups[key].map(check => h('li', {class: 'row'},
          chip(check.label, check.category === 'satisfied' ? 'ok' : check.category === 'failing' ? 'danger' : 'warn', check.symbol),
          h('span', {class: 'grow'}, check.title, h('span', {class: 'faint'}, ' ' + check.explanation)))))
          : h('p', {class: 'faint'}, 'None required. No trusted test runner is configured, so a model saying tests pass counts for nothing here.'))),
      h('p', {class: 'faint'}, acceptance.reminder + ' This checklist is advisory and grants nothing.')) : null,
    reviewing ? h('div', {class: 'stack decision'},
      failed ? notice('warn', h('p', null, failed + ' structural check' + (failed === 1 ? '' : 's') + ' failed, so Accept is unavailable. Edit the proposal or reject it.')) : null,
      h('div', {class: 'row'},
        button('Accept proposal', {kind: 'primary', fid: 'accept', disabled: locked || failed > 0, onClick: () => actions.review('accepted')}),
        button('Edit proposal', {fid: 'edit-proposal', disabled: locked, onClick: event => openProposalEditor(ctx, event.currentTarget)}),
        button('Reject', {kind: 'danger', fid: 'reject', disabled: locked, onClick: () => actions.review('rejected')})),
      h('p', {class: 'faint'}, 'Accept records your decision and unlocks a download. It does not write to a file, a branch or a repository.'))
      : h('div', {class: 'stack'},
        task.status === 'accepted' ? h('div', {class: 'row'},
          button('Download accepted result', {kind: 'primary', fid: 'download', disabled: locked, onClick: () => actions.downloadAccepted('content')}),
          task.kind === 'change' ? button('Download patch', {fid: 'download-patch', disabled: locked, onClick: event => confirmPatch(ctx, attempt, event.currentTarget)}) : null,
          offerAnother ? button('Start another attempt', {kind: 'quiet', fid: 'another-attempt', disabled: locked || !!task.recovery?.blocked, onClick: actions.showAnotherAttempt}) : null)
          : offerAnother ? h('div', {class: 'row'}, button('Start another attempt', {fid: 'another-attempt', disabled: locked || !!task.recovery?.blocked, onClick: actions.showAnotherAttempt})) : null,
        task.status === 'accepted' ? h('p', {class: 'faint'}, 'Accepted in this workspace only. Applying it to your files is a separate step that you perform.') : null));
}

// ---- Usage -----------------------------------------------------------------------------------

// Coverage, engine and provider counters kept apart, and the within-task comparison, as the current
// frontend shows them (harness/web/usage.js summarizeUsage, run through its pinned copy).
const COUNTER_LABELS = {
  provider: [['Provider input', 'input'], ['Provider output', 'output'], ['Provider cache read', 'cached'], ['Provider reasoning', 'reasoning']],
  opencode: [['OpenCode input, engine-defined', 'input'], ['OpenCode output, engine-defined', 'output'], ['OpenCode cache read', 'cached'],
    ['OpenCode cache write', 'cacheWrite'], ['OpenCode reasoning', 'reasoning']]};
function coverageBlock(task) {
  const coverage = summarizeUsage(task.attempts);
  const comparison = acceptedAttemptComparison(task.attempts);
  const groups = [['provider', 'Direct provider reporting'], ['opencode', 'OpenCode engine reporting']].filter(([key]) => coverage.groups[key].attempts);
  return h('div', {class: 'stack', dataset: {fid: 'usage-coverage'}},
    h('p', null, coverage.attempts + (coverage.attempts === 1 ? ' attempt: ' : ' attempts: ') + coverage.finished + ' with a recorded outcome, ' + coverage.unresolved + ' unresolved, ' +
      coverage.active + ' active. ' + coverage.observed + ' have usage events and ' + coverage.reported + ' have numeric fields.'),
    coverage.totalElapsedMs !== null ? h('p', {class: 'muted'}, 'Recorded local attempt time: ' + formatDuration(coverage.totalElapsedMs) + ' across ' + coverage.timed + ' of ' + coverage.ended +
      ' ended attempts, including failures and retries. Unresolved work may continue beyond the recorded time.') : null,
    coverage.missing ? h('p', {class: 'muted'}, coverage.missing + ' ended attempt' + (coverage.missing === 1 ? ' has' : 's have') + ' no usable numeric usage. Missing values are not counted as zero.') : null,
    groups.map(([key, title]) => [h('h3', null, title), kv(COUNTER_LABELS[key].map(([label, field]) => {
      const item = coverage.groups[key].counters[field];
      const amount = item.overflow ? 'Unavailable: the reported counts exceed the safe range' : item.value === null ? 'Unavailable' : item.value.toLocaleString('en-US') + ' reported';
      return [label, amount + ' across ' + item.reported + ' of ' + item.attempts + ' attempts' + (item.partial ? ' (' + item.partial + ' with partial OpenCode coverage)' : '')];
    }))]),
    groups.length ? h('p', {class: 'faint'}, 'OpenCode figures are engine-reported, not a provider invoice, and are never added to direct provider figures. Cache and reasoning categories may overlap other counts.') : null,
    comparison ? h('p', {dataset: {fid: 'within-task-comparison'}}, 'Observed comparison on this task: ' + comparison.chosen + ' took ' + formatDuration(Math.abs(comparison.deltaMs)) +
      (comparison.deltaMs > 0 ? ' longer than ' : comparison.deltaMs < 0 ? ' less than ' : ' compared with ') + comparison.baseline +
      '. One run each. Both proposals were accepted, but equal quality was not measured.') : null);
}
function stepReceiptBlock(attempt) {
  const receipt = describeStepReceipt(attempt.usage);
  if (!receipt) return null;
  return disclosure('Observed OpenCode steps (' + receipt.items.length + ' recorded)', 'steps-' + attempt.id,
    h('ul', {class: 'stack'}, receipt.notes.map(text => h('li', {class: 'faint'}, text))),
    h('div', {class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Observed OpenCode steps'}, h('table', null,
      h('thead', null, h('tr', null, ['Step', 'Input', 'Output', 'Cache read', 'Cache write', 'Reasoning'].map(name => h('th', {scope: 'col'}, name)))),
      h('tbody', null, receipt.items.map((item, index) => h('tr', null, h('th', {scope: 'row'}, String(index + 1)),
        ['input', 'output', 'cached', 'cacheWrite', 'reasoning'].map(field => h('td', null, item[field] === null ? 'Unavailable' : item[field].toLocaleString('en-US')))))))));
}

function usagePanel({state}) {
  const task = state.task;
  if (!task.attempts.length) return panel('Usage and attempts', h('p', {class: 'muted'}, 'Usage appears here after an attempt runs. Each attempt gets its own record, including failed ones.'));
  return panel([h('h2', null, 'Usage and attempts'), h('a', {href: '#/usage', class: 'btn btn-quiet'}, 'Compare runs')],
    coverageBlock(task),
    task.attempts.map((attempt, index) => {
      const cost = describeCost(attempt.cost), usage = attempt.usage, timing = attemptTiming(task, index), sent = dispatchEvidence(attempt);
      const engine = usage?.evidence === 'OpenCode reported';
      return h('details', {dataset: {fid: 'attempt-' + attempt.id}, open: index === task.attempts.length - 1},
        h('summary', {dataset: {fid: 'attempt-s-' + attempt.id}}, 'Attempt ' + (index + 1) + ' · ' + (attempt.routeLabel ?? attempt.model) + ' · ' + (STATUS_LABEL[attempt.status] ?? attempt.status) + ' · Cost: ' + cost.primary),
        kv([
          ['Cost', h('span', null, cost.primary + ' ', chip(cost.label, cost.kind === 'unavailable' ? 'neutral' : cost.kind === 'estimated' ? 'warn' : 'ok'))],
          cost.exact ? ['Exact amount', cost.exact] : null, ['About this figure', cost.note],
          ['Time', timingLine(timing)], timing?.note ? ['Time note', timing.note] : null,
          ['Data sent', sent.text],
          ['Outcome', attempt.recovery?.state === 'unresolved' ? 'Unknown. ' + attempt.recovery.message : attempt.status === 'running' ? 'Still running' : 'Recorded'],
          ['Usage evidence', usage?.evidence === 'synthetic' ? 'Synthetic. No model ran.' : usage?.evidence ?? 'Unavailable'],
          [engine ? 'Input, engine-defined' : 'Input tokens', formatCount(usage?.input)], [engine ? 'Output, engine-defined' : 'Output tokens', formatCount(usage?.output)],
          ['Cached input', formatCount(usage?.cached)]]), stepReceiptBlock(attempt));
    }),
    h('p', {class: 'faint'}, 'Failed and stopped attempts count. Unknown is never zero, and local is not free.'));
}
