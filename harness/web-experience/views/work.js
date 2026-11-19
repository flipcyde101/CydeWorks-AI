import {h, icon, swap, stableKey} from '../core/dom.js';
import {button, chip, notice, emptyState} from '../ui/primitives.js';
import {STATUS_LABEL, STATUS_TONE} from '../logic/situation.js';
import {formatAge} from '../core/format.js';
import {renderTask} from './task.js';

const FILTERS = [
  ['all', 'All', () => true],
  ['needs', 'Needs you', task => !!task.attention],
  ['running', 'Running', task => task.status === 'running'],
  ['drafts', 'Drafts', task => task.status === 'draft'],
  ['done', 'Decided', task => ['accepted', 'rejected'].includes(task.status)],
];

export function renderWork(main, ctx) {
  const {state, actions} = ctx;
  const [page] = state.path;
  if (main.dataset.swapKey !== 'work-skeleton') {
    main.replaceChildren(h('div', {class: 'split', id: 'split'},
      h('div', {class: 'list-pane'},
        h('div', {id: 'list-head'}),
        h('div', {class: 'search'}, icon('search'),
          h('input', {type: 'search', id: 'task-search', placeholder: 'Search tasks', 'aria-label': 'Search tasks by name', value: state.query,
            oninput: event => actions.setQuery(event.target.value)})),
        h('div', {id: 'list-filters'}), h('div', {id: 'list-body'})),
      h('div', {class: 'detail-pane', id: 'detail'})));
    main.dataset.swapKey = 'work-skeleton';
  }
  const hasDetail = page !== 'work';
  main.querySelector('#split').classList.toggle('has-detail', hasDetail);

  swap(main.querySelector('#list-head'), stableKey([hasDetail]), () => h(hasDetail ? 'h2' : 'h1', null, 'Tasks'));
  const counts = Object.fromEntries(FILTERS.map(([key, , test]) => [key, state.tasks.filter(test).length]));
  swap(main.querySelector('#list-filters'), stableKey([state.filter, counts]), () => h('div', {class: 'filters', role: 'group', 'aria-label': 'Filter tasks'},
    FILTERS.map(([key, label]) => button(label + ' ' + counts[key], {pressed: state.filter === key, fid: 'filter-' + key, onClick: () => actions.setFilter(key)}))));

  const test = FILTERS.find(([key]) => key === state.filter)[2];
  const query = state.query.trim().toLowerCase();
  const visible = state.tasks.filter(task => test(task) && (!query || task.title.toLowerCase().includes(query)));
  const ageBucket = Math.floor(state.now / 30000);
  swap(main.querySelector('#list-body'), stableKey([visible, state.task?.id, state.tasks.length, ageBucket]), () => {
    if (!state.tasks.length) return emptyState('No tasks yet', 'Describe a piece of work to create your first task. Nothing runs until you approve it.',
      h('a', {class: 'btn btn-primary', href: '#/new', dataset: {fid: 'empty-new'}}, 'Describe work'));
    if (!visible.length) return emptyState('No tasks match', query ? 'Nothing matches “' + state.query.trim() + '” in this filter.' : 'No task is in this state right now.',
      button('Show all tasks', {fid: 'clear-filter', onClick: () => { actions.setFilter('all'); const input = document.getElementById('task-search'); input.value = ''; actions.setQuery(''); }}));
    return h('ul', {class: 'task-list', 'aria-label': 'Tasks, ' + visible.length + ' shown'}, visible.map(task => h('li', null,
      h('a', {class: 'task-row', href: '#/task/' + task.id, 'aria-current': task.id === state.task?.id ? 'true' : undefined, dataset: {fid: 'task-' + task.id}},
        h('span', {class: 'title'}, task.title),
        h('span', {class: 'meta'}, chip(STATUS_LABEL[task.status] ?? task.status, STATUS_TONE[task.status]),
          // The host list reports neither attempt count nor update time; nothing is shown for them.
          task.attempts == null ? null : h('span', null, task.attempts + (task.attempts === 1 ? ' attempt' : ' attempts')),
          task.updated ? h('span', null, formatAge(Math.max(0, state.now - Date.parse(task.updated)))) : null),
        task.attention ? h('span', {class: 'meta attention'}, chip('Needs you: ' + task.attention.reasons.join(', '), 'decision')) : null))));
  });

  const detail = main.querySelector('#detail');
  if (page === 'new') renderCompose(detail, ctx);
  else if (page === 'task') {
    if (state.task && state.task.id === state.path[1]) renderTask(detail, ctx);
    else swap(detail, 'opening', () => h('p', {class: 'loading', role: 'status'}, 'Opening the task.'));
  } else swap(detail, 'placeholder', () => emptyState('Select a task, or describe new work',
    'Each task shows what is happening, what needs your decision, what happens next, where your text goes and what it cost.',
    h('a', {class: 'btn btn-primary', href: '#/new'}, 'Describe work')));
}

function renderCompose(container, {state, actions}) {
  const form = state.compose, editing = !!form.editing;
  const locked = state.connection !== 'connected';
  swap(container, stableKey(['compose', form.rev, form.editing?.id ?? null, form.kind, form.error, state.busy, locked]), () => {
    const input = (name, attrs) => h(attrs.rows ? 'textarea' : 'input', {type: attrs.rows ? undefined : 'text', id: 'compose-' + name, name, value: form[name],
      dataset: {fid: 'compose-' + name}, oninput: event => actions.compose({[name]: event.target.value}), ...attrs});
    const kind = (value, title, text) => h('label', {class: 'route'},
      h('input', {type: 'radio', name: 'kind', value, checked: form.kind === value, dataset: {fid: 'kind-' + value}, onchange: () => actions.compose({kind: value})}),
      h('span', null, h('span', {class: 'name'}, title), h('span', {class: 'why'}, text)));
    return [
      h('a', {class: 'btn btn-quiet back', href: editing ? '#/task/' + form.editing.id : '#/work'}, icon('back'), editing ? 'Back to task' : 'All tasks'),
      h('div', {class: 'page-head'}, h('h1', null, editing ? 'Edit draft scope' : 'Describe the work'),
        h('p', null, 'Start with what you want done. You choose a route and see where your text would go on the next step. Nothing runs until you approve it.')),
      h('form', {class: 'panel', novalidate: true, onsubmit: event => { event.preventDefault(); actions.submitScope(); }},
        h('label', {for: 'compose-request'}, 'What do you want done?',
          input('request', {rows: 3, maxlength: 800, required: true, placeholder: 'For example: summarize this handoff and flag what still needs a decision.', 'aria-describedby': 'request-hint'}),
          h('span', {class: 'field-hint', id: 'request-hint'}, 'Up to 800 characters.')),
        h('fieldset', {class: 'stack', 'aria-describedby': 'kind-hint'}, h('legend', {class: 'label'}, 'What kind of result?'),
          kind('brief', 'A written answer from text I supply', 'Returns a brief that cites the lines it used.'),
          kind('change', 'A proposed change to one file', 'Returns a replacement for one file you paste. It is never written to disk for you.'),
          h('span', {class: 'field-hint', id: 'kind-hint'}, 'These are the two workflows the workspace supports today.')),
        h('label', {for: 'compose-source'}, form.kind === 'change' ? 'Current file content' : 'Source text',
          input('source', {rows: 8, maxlength: 5000, required: true, 'aria-describedby': 'source-hint'}),
          h('span', {class: 'field-hint', id: 'source-hint'}, 'Only this text and your request are sent to the route you approve. Up to 5,000 characters.')),
        h('label', {for: 'compose-file'}, 'Or load the text from a file',
          h('input', {type: 'file', id: 'compose-file', dataset: {fid: 'compose-file'}, 'aria-describedby': 'file-hint',
            onchange: event => { const file = event.target.files?.[0] ?? null; event.target.value = ''; actions.loadSourceFile(file); }}),
          h('span', {class: 'field-hint', id: 'file-hint'}, 'A text file of up to 5,000 characters. It replaces the text above and is read in this tab only; nothing is sent until you continue.' +
            (form.kind === 'change' ? ' Its name fills the file name.' : ''))),
        form.kind === 'change' ? h('div', {class: 'compare'},
          h('label', {for: 'compose-filename'}, 'File name', input('filename', {maxlength: 100, required: true, placeholder: 'retry.js'})),
          h('label', {for: 'compose-expected'}, 'Text the result must contain', input('expected', {maxlength: 400, required: true, 'aria-describedby': 'expected-hint'}),
            h('span', {class: 'field-hint', id: 'expected-hint'}, 'A structural check. It does not prove the change is correct.'))) : null,
        h('details', {dataset: {fid: 'compose-more'}}, h('summary', {dataset: {fid: 'compose-more-s'}}, 'Name this task (optional)'),
          h('label', {for: 'compose-title'}, 'Task name', input('title', {maxlength: 120, 'aria-describedby': 'title-hint'}),
            h('span', {class: 'field-hint', id: 'title-hint'}, 'If you leave this blank, the task is named Untitled brief or Untitled change. Your request is never copied into the name, because names appear in standard metadata exports.'))),
        form.error ? notice('danger', h('p', null, form.error)) : null,
        locked ? notice('warn', h('p', null, 'The workspace is not reachable. Your text stays here. Saving is disabled until the connection returns.')) : null,
        h('div', {class: 'row'},
          button(state.busy ? 'Saving…' : editing ? 'Save scope' : 'Continue to scope and route', {kind: 'primary', type: 'submit', disabled: state.busy || locked, fid: 'compose-submit'}),
          button('Discard', {kind: 'quiet', fid: 'compose-discard', onClick: () => { actions.discardCompose(); actions.navigate(editing ? '#/task/' + form.editing.id : '#/work'); }})),
        h('p', {class: 'faint'}, 'What you type stays in this tab until you continue. It is not written to browser storage and is lost if you reload.')),
    ];
  });
}
