import {h, swap, stableKey} from '../core/dom.js';
import {button, chip, notice, panel, planned, emptyState, kv} from '../ui/primitives.js';
import {formatDateTime, shortHash} from '../core/format.js';
import {openHandoffReview} from './dialogs.js';

const table = (label, heads, rows) => h('div', {class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': label}, h('table', null,
  h('thead', null, h('tr', null, heads.map(name => h('th', {scope: 'col'}, name)))), h('tbody', null, rows)));

export function renderData(main, ctx) {
  const {state} = ctx, audit = state.cache.data;
  swap(main, stableKey(['data', audit]), () => h('div', {class: 'page'},
    h('div', {class: 'page-head'}, h('h1', null, 'Data and access'),
      h('p', null, 'What you approved, where your text went, what is kept and what removal can and cannot erase.')),
    panel('Where your data lives',
      h('ol', {class: 'boundary'},
        h('li', null, h('h3', null, '1. This window'), h('p', null, 'Shows tasks. Keeps a task ID and pending copy identifiers in tab storage, never request or source text.'), chip('On this computer')),
        h('li', null, h('h3', null, '2. Local workspace service'), h('p', null, 'Stores tasks, results, history and usage in a local database under the state folder. Reached only on a loopback address.'), chip('On this computer')),
        h('li', null, h('h3', null, '3. The route you approve'), h('p', null, 'Receives the approved request and source for one attempt. A local model service today. A remote provider only if you approve a remote route.'), chip('Depends on the route', 'warn'))),
      notice('warn', h('p', null, h('strong', null, 'Isolation status: not verified. '),
        'Nothing on this screen proves OS-level isolation. The workspace checks addresses it connects to. It does not confine the model service, and a local service could forward a request.')),
      h('p', {class: 'planned-line'}, planned(), 'Process confinement and a verified isolation check.')),
    panel('Approvals',
      h('p', {class: 'muted'}, 'Each approval covers one attempt on one route for one source snapshot. It is used immediately and cannot be reused. A change to the route identity, destination or permissions before you approve clears the approval.'),
      !audit ? h('p', {class: 'loading', role: 'status'}, 'Reading history.')
        : audit.approvals.length ? table('Approval history', ['When', 'Task', 'Attempt', 'Route', 'Snapshot', 'Model identity', 'Validity'], audit.approvals.map(item => h('tr', null,
          h('td', null, formatDateTime(item.at)), h('th', {scope: 'row'}, h('a', {href: '#/task/' + item.taskId}, item.taskTitle)), h('td', null, String(item.attemptNumber)),
          h('td', null, item.routeLabel), h('td', {class: 'mono'}, shortHash(item.sourceHash)), h('td', {class: 'mono'}, item.identity ? shortHash(item.identity) : 'None'), h('td', null, item.use))))
          : emptyState('No approvals yet', 'An approval is recorded each time you approve an attempt.'),
      audit?.recordedBy === 'host' ? h('p', {class: 'faint'}, 'From attempt records. The workspace records the model and approved identity, not the destination text or permissions shown at approval.') : null,
      h('p', {class: 'planned-line'}, planned(), 'Timed expiry for an approval that has not been used, and a workspace-wide approval record from the backend.')),
    panel('Handoffs from another workspace',
      h('p', {class: 'muted'}, 'Review a portable handoff manifest before you recreate its task here. The review creates no task and transfers no approval, permission or session. You write the new scope yourself.'),
      h('div', {class: 'row'}, button('Review a handoff', {fid: 'handoff-open', onClick: event => openHandoffReview(ctx, event.currentTarget)}),
        h('a', {class: 'btn btn-quiet', href: '#/new'}, 'Start a new draft'))),
    panel('Decisions and edits',
      !audit ? null : audit.decisions.length ? table('Decision history', ['When', 'Task', 'Event'], audit.decisions.slice(0, 50).map(item => h('tr', null,
        h('td', null, formatDateTime(item.at)), h('th', {scope: 'row'}, h('a', {href: '#/task/' + item.taskId}, item.taskTitle)), h('td', null, item.event.replaceAll('.', ' / ').replaceAll('_', ' ')))))
        : h('p', {class: 'muted'}, 'No review decisions are recorded yet.'),
      h('p', {class: 'faint'}, 'History lists events and identifiers only. It does not repeat request, source or proposal text, and it never contains keys or tokens.')),
    panel('Retention, export and removal',
      kv([
        ['Kept until you remove it', 'Task records: request, source snapshot, proposals, checks, usage and history.'],
        ['Kept after removal', 'A pseudonymous removal audit entry, and copy request references with task IDs and versions but no content.'],
        ['Not reached by removal', 'OpenCode working files in the state folder, database pages and journals that may hold recoverable copies, your backups, and anything a provider stored.'],
        ['Export', 'A metadata preview you download yourself. Minimal omits names and identifiers. Neither mode includes request, source or proposal text.'],
        ['Where to act', 'Open a task, then use Preview metadata export or Review task removal. Removal needs a fresh preview and a typed confirmation.']]),
      !audit ? null : audit.removals.length ? table('Removal audit', ['Removed', 'Reference', 'Scope'], audit.removals.map(item => h('tr', null,
        h('td', null, formatDateTime(item.removedAt)), h('td', {class: 'mono'}, shortHash(item.reference)), h('td', null, item.scope))))
        : h('p', {class: 'muted'}, 'No task record has been removed in this session.'),
      h('p', {class: 'planned-line'}, planned(), 'Restore from backup, retention schedules and removal of OpenCode working files.'))));
}
