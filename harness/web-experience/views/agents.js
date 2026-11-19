import {h, swap} from '../core/dom.js';
import {chip, notice, panel, planned, kv} from '../ui/primitives.js';
import {SWARM_SAMPLE} from '../demo/fixtures.js';

const STATUS = {succeeded: ['Done', 'ok', '✓'], running: ['Working', 'active', '▸'], blocked: ['Blocked', 'warn', '!'], pending: ['Waiting', 'neutral', '○']};
const ROLE = {planner: 'Planner', builder: 'Builder', reviewer: 'Reviewer', researcher: 'Researcher', human: 'You'};

export function renderAgents(main) {
  swap(main, 'agents', () => h('div', {class: 'page'},
    h('div', {class: 'page-head'}, h('div', {class: 'row'}, h('h1', null, 'Agents'), planned()),
      h('p', null, 'A design for splitting one approved piece of work across several agents, with a reviewer and you at the end.')),
    notice('planned', h('p', null, h('strong', null, 'Design preview. No agents are running. '),
      'The cards below are a fixed illustration. They are not connected to any worker, they do not update, and nothing was produced by them. A plan validator and coordinator exist in source and pass synthetic tests, but they are not connected to real routes.')),
    panel([h('h2', null, 'Example plan'), chip('Illustration only', 'warn')],
      h('ol', {class: 'stack', 'aria-label': 'Example plan steps'}, SWARM_SAMPLE.nodes.map((node, index) => {
        const [label, tone, symbol] = STATUS[node.status];
        return h('li', {class: 'panel'},
          h('div', {class: 'panel-head'}, h('h3', null, (index + 1) + '. ' + node.title), h('div', {class: 'row'}, chip(ROLE[node.role]), chip(label, tone, symbol))),
          kv([['Assigned to', node.owner], ['Depends on', node.dependsOn.length ? node.dependsOn.map(id => SWARM_SAMPLE.nodes.find(item => item.id === id).title).join('; ') : 'Nothing'],
            ['Owns files', node.writes.length ? node.writes.join(', ') : 'None. Read-only step.'], node.blockedBy ? ['Blocked because', node.blockedBy] : null]));
      }))),
    panel('What the design guarantees',
      kv([['Ownership', 'Each file is owned by one step at a time. Two steps that touch the same file must be ordered by a dependency.'],
        ['Approval', 'You approve the whole plan against one source snapshot. ' + SWARM_SAMPLE.approval.ttl + '. A changed plan or snapshot needs a new approval.'],
        ['Resource limit', 'At most ' + SWARM_SAMPLE.maxConcurrent + ' agents work at once in this example. The limit is part of what you approve.'],
        ['Blocked work', 'A failed or unknown step stops the steps that depend on it. Nothing is retried until you review it.'],
        ['Review', 'A reviewer agent reads the results first. Its opinion is a model claim, not acceptance. You still decide.'],
        ['Needs you', 'One alert per plan, listing every step that waits on you.']])),
    panel('What has to exist first',
      h('ul', {class: 'stack'}, ['A qualified model route. None has passed the coding check yet.', 'OS-level confinement before any agent may write files or run commands.',
        'The coordinator connected to real workers, with live tests of stop, interruption and recovery.', 'Per-agent receipts so cost and time are attributable.']
        .map(item => h('li', {class: 'row'}, chip('Not yet', 'neutral', '○'), h('span', {class: 'grow'}, item)))))));
}
