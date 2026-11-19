import {h, swap, stableKey} from '../core/dom.js';
import {button, chip, notice, panel, planned, simulated, emptyState, kv, slot, confirmDialog, disclosure} from '../ui/primitives.js';
import {ADAPTER_METHODS} from '../adapters/contract.js';
import {describeCost} from '../core/format.js';

const DIAG = {ok: ['Ready', 'ok', '✓'], warn: ['Attention', 'warn', '!'], unknown: ['Unknown', 'neutral', '?'], blocked: ['Not verified', 'danger', '✕']};
const TOKENS = ['surface-0', 'surface-1', 'surface-2', 'surface-3', 'surface-4', 'line-strong', 'text', 'text-2', 'text-3', 'accent', 'flag', 'ok', 'warn', 'danger'];

export function renderDeveloper(main, {state, actions}) {
  const data = state.cache.developer;
  swap(main, stableKey(['developer', data]), () => h('div', {class: 'page'},
    h('div', {class: 'page-head'}, h('h1', null, 'Developer'),
      h('p', null, 'Environment checks, the adapter contract and every reusable component in one place.')),
    panel([h('h2', null, 'Environment diagnostics'), chip('Synthetic sample', 'warn')],
      !data ? h('p', {class: 'loading', role: 'status'}, 'Reading diagnostics.') : h('ul', {class: 'stack'}, data.checks.map(check => {
        const [label, tone, symbol] = DIAG[check.state];
        return h('li', {class: 'row-between'}, h('div', {class: 'grow'}, h('strong', null, check.label), h('span', {class: 'muted'}, ' ' + check.value), h('p', {class: 'faint'}, check.help)), chip(label, tone, symbol));
      })),
      h('pre', {tabindex: '0', 'aria-label': 'Commands'}, 'cd work/claude-cydeworks-experience/candidate\nnode --test              # unit and compatibility tests\nnode server.mjs          # this preview on http://127.0.0.1:15391\nnode browser-check.mjs   # journeys, accessibility and layout in headless Edge')),
    panel('Workspace adapter contract',
      h('p', {class: 'muted'}, 'Views call only these methods. This preview uses a synthetic adapter. The HTTP adapter over the routes below is not written yet. No route here is invented: each one exists in the harness today, is composed from existing routes, or is marked as having no endpoint.'),
      h('div', {class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Adapter methods'}, h('table', null,
        h('thead', null, h('tr', null, ['Method', 'Kind', 'Backend route', 'Note'].map(name => h('th', {scope: 'col'}, name)))),
        h('tbody', null, Object.entries(ADAPTER_METHODS).map(([name, [kind, route, note]]) => h('tr', null, h('th', {scope: 'row', class: 'mono'}, name),
          h('td', null, kind === 'none' ? chip('No endpoint', 'neutral') : kind === 'composed' ? chip('Composed') : chip('Existing', 'ok')),
          h('td', null, route ? h('span', {class: 'mono'}, route) : 'None'), h('td', null, note))))))),
    panel('Integration slots',
      h('p', {class: 'muted'}, 'Where output owned by other contributors appears. Mappers live in adapters/slots.js and only relabel; they never decide readiness, acceptance or cost.'),
      h('div', {class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Integration slots'}, h('table', null,
        h('thead', null, h('tr', null, ['Owner', 'Output', 'Shown on', 'Mapper', 'Status in this demo'].map(name => h('th', {scope: 'col'}, name)))),
        h('tbody', null, [
          ['Codex (harness)', 'GET /api/tasks/:id/readiness', 'Connections', 'readinessView, connectionCard', 'Real host output for a synthetic task, generated at build time'],
          ['Codex (harness)', 'GET /api/tasks/:id/receipt v2 envelope', 'Usage receipt dialog', 'receiptView (display only)', 'Real host exports of synthetic tasks, downloaded unchanged'],
          ['Antigravity', 'Acceptance Evidence assessAcceptance', 'Task review: advisory checklist', 'acceptancePanel', 'Demo approximation in demo/acceptance.js'],
          ['Qwen', 'Run Inspector summarizeRun, compareRuns', 'Usage totals and comparison', 'receiptSummary, comparisonView', 'Computed by the pinned harness copy at build time'],
          ['Qwen', 'Cost presentation describeCostDifference', 'Usage comparison cost line', 'costDifferenceInput', 'Pending delivery. Fallback text from the same input'],
        ].map(row => h('tr', null, row.map((cell, index) => index === 0 ? h('th', {scope: 'row'}, cell) : h('td', null, cell)))))))),
    panel('Component catalog',
      h('h3', null, 'Buttons'),
      h('div', {class: 'row'}, button('Default', {fid: 'cat-default'}), button('Primary', {kind: 'primary', fid: 'cat-primary'}), button('Quiet', {kind: 'quiet', fid: 'cat-quiet'}),
        button('Destructive', {kind: 'danger', fid: 'cat-danger'}), button('Confirm destructive', {kind: 'dangerFill', fid: 'cat-danger-fill'}),
        button('Selected', {pressed: true, fid: 'cat-pressed'}), button('Disabled', {disabled: true, fid: 'cat-disabled'})),
      h('h3', null, 'Status chips (always a word, color only reinforces)'),
      h('div', {class: 'row'}, chip('Neutral'), chip('Ready', 'ok', '✓'), chip('Held', 'warn', '!'), chip('Failed', 'danger', '✕'), chip('Needs you', 'decision'),
        chip('Running', 'active'), planned(), simulated()),
      h('h3', null, 'Notices'),
      notice('info', h('p', null, 'Information. Something was saved or restored.')),
      notice('warn', h('p', null, 'Warning. State may be stale or an action is held.')),
      notice('danger', h('p', null, 'Problem. An outcome is unknown or an action failed. Announced immediately to assistive technology.')),
      notice('planned', h('p', null, 'Planned. Described honestly, not available.')),
      h('h3', null, 'Cost figures'),
      kv([null, {amountMicros: 23000, currency: 'USD', evidence: 'estimated', complete: true}, {amountMicros: 0, currency: 'USD', evidence: 'provider-billed', complete: true},
        {amountMicros: 5000, currency: 'EUR', evidence: 'estimated', complete: false}].map(cost => { const view = describeCost(cost); return [view.label, view.primary + (view.exact ? ' (' + view.exact + ')' : '') + '. ' + view.note]; })),
      h('h3', null, 'Confirmation dialog'),
      h('div', {class: 'row'}, button('Open a sample confirmation', {fid: 'cat-dialog', onClick: event => confirmDialog({title: 'Sample confirmation', opener: event.currentTarget,
        confirmLabel: 'Confirm', destructive: true, onConfirm: () => actions.setNotice('info', 'Sample confirmed. Nothing happened.'),
        lines: ['Cancel is focused first. Escape and the backdrop cancel. Focus returns to the button that opened this.']})})),
      h('h3', null, 'Empty state'),
      emptyState('Nothing here yet', 'An empty state says why it is empty and offers the one useful next step.', button('Next step', {fid: 'cat-empty'})),
      h('h3', null, 'Integration slot and disclosure'),
      slot('Owner name', 'status', disclosure('A disclosure keeps its open state across live updates', 'cat-disclosure', h('p', {class: 'muted'}, 'Detail goes here.'))),
      h('h3', null, 'Color tokens (proposed values)'),
      h('ul', {class: 'swatches'}, TOKENS.map(name => { const swatch = h('i'); swatch.style.background = 'var(--' + name + ')'; return h('li', {class: 'swatch'}, swatch, h('span', {class: 'mono'}, '--' + name)); }))),
    panel('State conventions',
      kv([['Loading', 'A short status line in place. No spinner alone, no layout jump.'], ['Empty', 'Why it is empty, plus one next step.'],
        ['Error, known', 'What was refused and why, in the place the action was taken. Nothing is retried.'],
        ['Error, unknown outcome', 'Says the outcome is unknown, re-reads saved state, and keeps actions disabled until it matches.'],
        ['Stale or offline', 'A banner with attempt count and retry delay. No recovery estimate. Actions disabled.'],
        ['Locked or expired', 'Returns to unlock. Observation resumes read-only afterwards.'], ['Denied', 'Explains what would be needed. Never offers a paid fallback.'],
        ['Planned', 'Dashed chip and plain sentence. Never an interactive control that looks live.'], ['Simulated', 'Amber chip on anything driven by the demo adapter.']]))));
}
