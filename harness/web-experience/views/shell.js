import {h, icon, swap, stableKey} from '../core/dom.js';
import {button, notice, openDialog, confirmDialog, chip, planned} from '../ui/primitives.js';
import {mode} from '../core/mode.js';

// Lock explains its scope first: it affects every view, and approved work keeps running.
function confirmLock(actions, opener) {
  confirmDialog({title: 'Lock the workspace?', opener, confirmLabel: 'Lock every view',
    lines: ['Every open view of this workspace locks, not only this one. Each needs the access file to unlock.',
      'Approved work keeps running while locked. Lock is not Stop: use Stop on a running task to end it.',
      'Terminal control is released. After unlocking, views reopen read-only and you take control again yourself.',
      'Locking does not erase what was already shown, copied or downloaded.'],
    onConfirm: () => actions.lock()});
}

const NAV = [
  ['work', 'Work', 'work'], ['connections', 'Connections', 'connections'], ['usage', 'Usage', 'usage'],
  ['data', 'Data and access', 'data'], ['agents', 'Agents', 'agents'], ['developer', 'Developer', 'developer'],
];

export function renderSidebar(container, {state, actions}) {
  const page = ['new', 'task'].includes(state.path[0]) ? 'work' : state.path[0];
  const needs = state.tasks.filter(task => task.attention).length;
  swap(container, stableKey([page, needs]), () => [
    h('div', {class: 'brand'}, icon('flag'), h('span', null, 'CydeWorks AI', h('small', null, 'Local workspace'))),
    h('a', {class: 'btn btn-primary btn-wide', href: '#/new', dataset: {fid: 'new-task'}}, icon('plus'), 'New task'),
    h('nav', {class: 'nav', 'aria-label': 'Sections'}, NAV.map(([key, label, glyph]) =>
      h('a', {href: '#/' + key, 'aria-current': key === page ? 'page' : undefined, dataset: {fid: 'nav-' + key}}, icon(glyph), h('span', null, label),
        key === 'agents' ? h('span', {class: 'chip chip-planned count-slot'}, 'Planned') : null,
        key === 'work' && needs ? h('span', {class: 'count', 'aria-label': needs + ' task' + (needs === 1 ? ' needs' : 's need') + ' you'}, String(needs)) : null))),
    h('div', {class: 'sidebar-foot'}, button('Lock workspace', {kind: 'quiet', wide: true, iconName: 'lock', onClick: event => confirmLock(actions, event.currentTarget), fid: 'lock'})),
  ]);
}

export function renderBanner(container, {state, actions}) {
  const {connection, notice: note, failures, retryMs} = state;
  swap(container, stableKey([connection, note, connection === 'reconnecting' ? failures : 0]), () => {
    const rows = [];
    if (connection === 'reconnecting') rows.push(notice('warn',
      h('p', null, h('strong', null, 'Connection interrupted. '), 'What you see may be out of date. Read attempt ' + failures + ' failed. Retrying in ' + Math.round((retryMs ?? 1000) / 1000) +
        ' s. No command is replayed. A recovery time cannot be estimated until the workspace responds.'),
      h('div', {class: 'row'}, button('Retry now', {onClick: actions.reconnect, fid: 'retry-now'}))));
    if (connection === 'checking') rows.push(notice('warn', h('p', null, 'Checking the saved state before enabling more actions. Nothing is sent again.')));
    if (connection === 'missing') rows.push(notice('warn', h('p', null, 'This task is no longer in the workspace. Open another task.')));
    if (note) rows.push(notice(note.tone, h('div', {class: 'row-between'}, h('p', {class: 'grow'}, note.text),
      button('Dismiss', {kind: 'quiet', fid: 'dismiss-notice', onClick: () => { actions.setNotice(null, null); }}))));
    return rows;
  });
}

// The access file input is read only when Unlock is pressed. Its contents go to the workspace once
// and are not kept; the input is cleared afterwards.
function accessFileForm(state, actions) {
  const input = h('input', {type: 'file', id: 'access-file', dataset: {fid: 'access-file'}, disabled: state.busy});
  const submit = () => { const file = input.files?.[0] ?? null; input.value = ''; actions.unlock(file); };
  return [h('label', {for: 'access-file'}, 'Workspace access file (access.key in the workspace state folder)'), input,
    h('div', {class: 'row'}, button(state.busy ? 'Unlocking…' : 'Unlock workspace', {kind: 'primary', onClick: submit, disabled: state.busy, fid: 'unlock'}))];
}

export function renderUnlock({state, actions}) {
  const resumed = state.connection === 'locked';
  return h('div', {class: 'unlock'},
    h('div', {class: 'page-head'}, h('h1', null, resumed ? 'Unlock to continue' : state.session.firstUse ? 'Welcome to CydeWorks AI' : 'Open your workspace'),
      h('p', null, resumed ? 'The workspace is locked. Nothing was lost and nothing was sent again. After unlocking, any run you were watching reopens read-only.'
        : state.session.firstUse ? 'Your AI. Your agents. Your work. Describe a task, review exactly what will run and where your text goes, then decide what to keep.'
        : 'Your tasks and their history are kept on this computer.')),
    h('section', {class: 'panel'},
      h('h2', null, 'Workspace access'),
      state.lockNotice ? notice(/lost/.test(state.lockNotice) ? 'warn' : 'info', h('p', {dataset: {fid: 'lock-notice'}}, state.lockNotice)) : null,
      h('p', {class: 'muted'}, mode.synthetic
        ? 'The real workspace unlocks with a local access file that stays on this computer. This demonstration has no access file and reads nothing from disk.'
        : 'Choose the access file for this workspace. It is sent once to the local workspace service and is not stored by this page.'),
      state.unlockError ? notice('danger', h('p', null, state.unlockError), h('p', {class: 'faint'}, 'The workspace stays locked. Choose the access file again.')) : null,
      resumed && state.lockedTaskId ? notice('warn', h('p', null, 'The outcome of anything that was running is unknown until the workspace is unlocked and its saved state is read.')) : null,
      resumed && state.pendingRun ? notice('warn', h('p', null, 'A run submission outcome was still unknown. Its request identity is kept, and it is checked after you unlock. Nothing is sent again automatically.')) : null,
      mode.synthetic ? h('div', {class: 'row'}, button(state.busy ? 'Opening…' : 'Open synthetic workspace', {kind: 'primary', onClick: () => actions.unlock(), disabled: state.busy, fid: 'unlock'}))
        : accessFileForm(state, actions),
      h('p', {class: 'faint'}, 'The session ends when the local service restarts or any view locks the workspace.')),
    state.session.firstUse && !resumed ? h('section', {class: 'panel'},
      h('h2', null, 'What to expect'),
      h('ol', {class: 'stack'},
        ['Describe the work in your own words. No setup is needed first.',
          'Review the scope and the suggested route, including where your text would go.',
          'Approve one attempt. You can watch it, and stop it, without it changing any file.',
          'Review the result and its evidence, then accept, edit or reject it.'].map((line, index) =>
          h('li', {class: 'row'}, chip(String(index + 1)), h('span', {class: 'grow'}, line))))) : null);
}

export function openDemoControls({demo, actions, state}) {
  const run = fn => async () => { try { await fn(); } catch (error) { actions.setNotice('warn', error.message); } refresh(); };
  const draft = state.task?.status === 'draft' ? state.task : null;
  let body;
  const toggle = (label, name) => button(label, {pressed: !!demo.faults[name], fid: 'demo-' + name, onClick: run(() => demo.setFault(name, !demo.faults[name]))});
  const once = (label, fid, fn, note) => button(label, {fid: 'demo-' + fid, onClick: run(async () => { await fn(); if (note) actions.setNotice('info', note); })});
  const groups = () => [
    h('p', {class: 'muted'}, 'These switches exist only in this demonstration. They let you reach failure and recovery states on purpose. None of them is a product feature.'),
    h('section', {class: 'stack'}, h('h3', null, 'Workspace'), h('div', {class: 'row'},
      once('Restart as first use', 'first-use', () => actions.resetProfile('first-use')),
      once('Restart as returning user', 'returning', () => actions.resetProfile('returning')),
      once('Expire the session', 'expire', () => demo.expireSession(), 'The session will be found expired on the next read.'),
      toggle('Next unlock is denied', 'unlockDenied'))),
    h('section', {class: 'stack'}, h('h3', null, 'Connection'), h('div', {class: 'row'}, toggle('Workspace offline', 'offline'))),
    h('section', {class: 'stack'}, h('h3', null, 'Approval'), h('div', {class: 'row'},
      once('Another view edits this draft', 'edit-scope', () => { if (!draft) throw Error('Open a draft task first.'); return demo.editScopeFromAnotherView(draft.id); },
        'Another view saved a scope change. It is noticed on the next read.'),
      toggle('Lose the next run response', 'loseNextRunResponse'))),
    h('section', {class: 'stack'}, h('h3', null, 'Routes'), h('div', {class: 'row'},
      once('Change the model identity', 'identity', () => demo.changeRouteFact('identity'), 'The model identity changed. It is noticed on the next route read.'),
      once('Change the endpoint', 'destination', () => demo.changeRouteFact('destination'), 'The route endpoint changed.'),
      once('Change the permissions', 'permissions', () => demo.changeRouteFact('permissions'), 'The route permissions changed.'),
      once('Only update the observation time', 'timestamp', () => demo.changeRouteFact('timestamp'), 'Only the observation time changed. Approvals should hold.'),
      once('Make route evidence stale', 'stale', () => demo.staleRoutes(), 'Route evidence is now older than its window.'))),
    h('section', {class: 'stack'}, h('h3', null, 'Running attempt'), h('div', {class: 'row'},
      once('Fast-forward 30 seconds', 'forward', () => demo.fastForward(30000)),
      once('Another view takes control', 'other-view', () => demo.otherViewTakesControl()),
      once('Simulate a service restart', 'restart', () => demo.interruptAsRestart()),
      toggle('Stall the output', 'stall'), toggle('Next run fails', 'nextRunFails'), toggle('Stop: local exit not observed', 'stopExitUnobserved'))),
    h('section', {class: 'stack'}, h('h3', null, 'Copy and removal'), h('div', {class: 'row'},
      toggle('Lose the next copy response', 'loseNextCopyResponse'),
      once('Expire open removal previews', 'clock', () => demo.advanceRemovalClock(360000), 'The removal clock moved forward 6 minutes. Open removal previews have expired.'))),
    h('p', {class: 'faint', role: 'status'}, 'Run active: ' + (demo.state().active ? 'yes' : 'no') + ' · ' + demo.state().taskCount + ' tasks'),
  ];
  function refresh() { if (body) swap(body, stableKey([demo.state(), Math.random()]), groups); }
  openDialog({title: 'Demo controls', opener: document.getElementById('demo-open'),
    body: () => { body = h('div', {class: 'demo-groups'}); refresh(); return body; }});
}

export {planned};
