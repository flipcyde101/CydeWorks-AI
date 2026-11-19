import {h, swap, stableKey} from '../core/dom.js';
import {button, chip, notice, kv, panel, planned, simulated, openDialog, disclosure} from '../ui/primitives.js';
import {formatDateTime} from '../core/format.js';
import {readinessView} from '../adapters/slots.js';
import {mode} from '../core/mode.js';

const TYPE = {local: 'Local', subscription: 'Subscription', metered: 'Metered API', unknown: 'Billing unknown'};
const FACTS = [['softwareDetected', 'Software detected'], ['connectionConfigured', 'Connection configured'], ['authenticationVerified', 'Sign-in verified'],
  ['modelReachable', 'Model reachable'], ['requiredCapabilitiesVerified', 'Capabilities verified'], ['readyForSelectedTask', 'Ready for this task']];
const factView = value => ['yes', 'ready', 'not-required'].includes(value) ? ['✓', value === 'not-required' ? 'Not required' : 'Yes', 'pass']
  : ['no', 'blocked', 'expired', 'invalid'].includes(value) ? ['✕', value === 'expired' ? 'Expired' : value === 'invalid' ? 'Invalid' : 'No', 'fail'] : ['?', 'Unknown', 'unverified'];
const QUALIFICATION = {ready: ['Qualified', 'ok', '✓'], blocked: ['Not qualified', 'warn', '!'], unknown: ['Qualification unknown', 'neutral', '?']};

function addConnection(opener) {
  openDialog({title: 'Add connection', opener, body: [
    notice('planned', h('p', null, h('strong', null, 'Planned. '), 'Adding a connection is not implemented. This preview exposes local routes only.')),
    h('p', null, 'When it exists, each connection will state its provider, the account or project it uses, the models it may run, where your text goes and how it is billed, before you can pick it for a task.'),
    h('ul', {class: 'stack'},
      h('li', null, h('strong', null, 'Local. '), 'A model service on this computer. No account. Not automatically free: electricity and hardware are not metered.'),
      h('li', null, h('strong', null, 'Subscription. '), 'A provider plan used through that provider’s own supported sign-in. Only where the provider permits this kind of use. Many consumer subscriptions do not.'),
      h('li', null, h('strong', null, 'Metered API. '), 'Billed per use. Chosen only by you, per attempt. An exhausted quota holds the task. It never moves work to a paid route.')),
    h('p', {class: 'faint'}, 'CydeWorks AI will never ask you to paste a password or key into a chat or a task. Credentials stay with the provider’s sign-in or the operating system’s credential store.')]});
}

function reasonItem(reason) {
  return h('li', {class: 'reason'}, h('strong', null, reason.title),
    reason.explanation ? h('span', {class: 'muted'}, ' ' + reason.explanation) : null,
    reason.suggestedAction ? h('span', {class: 'faint'}, ' Next: ' + reason.suggestedAction) : null);
}

function card(item) {
  const [label, tone, symbol] = QUALIFICATION[item.state] ?? QUALIFICATION.unknown;
  const shown = item.reasons.slice(0, 2), rest = item.reasons.slice(2);
  return h('article', {class: 'panel', 'aria-label': item.adapter + ' with ' + item.backend},
    h('div', {class: 'panel-head'}, h('h3', null, item.adapter + ' · ' + item.backend),
      h('div', {class: 'row'}, chip(TYPE[item.type] ?? TYPE.unknown),
        item.preview ? chip(item.preview.eligible ? 'Preview check passed' : 'Preview check held', item.preview.eligible ? 'ok' : 'warn', item.preview.eligible ? '✓' : '!') : null,
        chip(label, tone, symbol))),
    kv([['Preview check', item.preview ? item.preview.reason : 'Not reported'], ['Your text', item.destination.data + ' · ' + item.destination.endpoint],
      ['Cloud routing', item.destination.cloudRouting], ['Run authorization', 'None. Only the server preflight at approval can start a run.']]),
    item.reasons.length ? h('div', {class: 'stack'}, h('h4', {class: 'label'}, 'Why it is not qualified (' + item.reasons.length + ')'),
      h('ul', {class: 'stack'}, shown.map(reasonItem)),
      rest.length ? disclosure('Show ' + rest.length + ' more', 'reasons-' + item.id, h('ul', {class: 'stack'}, rest.map(reasonItem))) : null) : null,
    disclosure('Readiness facts, permissions and limits', 'facts-' + item.id,
      h('ul', {class: 'facts'}, FACTS.map(([key, name]) => {
        const [sym, word, cls] = factView(item.facts[key]);
        return h('li', {class: cls}, h('span', {class: 'sym', 'aria-hidden': 'true'}, sym), h('span', null, name + ': ', h('strong', null, word)));
      })),
      h('ul', {class: 'stack'}, item.permissions.map(permission =>
        h('li', {class: 'row'}, chip(permission.granted === 'yes' ? 'Granted' : permission.granted === 'no' ? 'Not granted' : 'Unknown', permission.granted === 'yes' ? 'ok' : 'neutral'),
          h('span', {class: 'grow'}, permission.label, h('span', {class: 'faint'}, ' ' + permission.note))))),
      h('p', {class: 'faint'}, (item.productionEligible ? 'Eligible for real use.' : 'Not eligible for real use. ' + item.gaps.slice(0, 2).join(' ')) + ' ' + item.destination.note)));
}

export function renderConnections(main, {state}) {
  const data = state.cache.connections;
  const view = data?.readiness ? readinessView(data.readiness) : null;
  swap(main, stableKey(['connections', data]), () => h('div', {class: 'page'},
    h('div', {class: 'row-between page-head'},
      h('div', {class: 'grow'}, h('h1', null, 'Connections'),
        h('p', null, 'How a task reaches a model: the adapter that carries the request, the backend that runs it, and where your text goes. Nothing on this page can start a run.')),
      button('Add connection', {iconName: 'plus', fid: 'add-connection', onClick: event => addConnection(event.currentTarget)})),
    !data ? h('p', {class: 'loading', role: 'status'}, 'Reading connections.') : [
      panel([h('h2', null, 'Route preview checks'), simulated()],
        h('p', {class: 'muted'}, 'A bounded check of each installed route. It decides which routes you can select. The server repeats its own checks when you approve.'),
        h('ul', {class: 'stack'}, data.routes.routes.filter(route => !route.planned).map(route => h('li', {class: 'row-between'},
          h('span', {class: 'grow'}, h('strong', null, route.label), h('span', {class: 'faint'}, ' ' + route.adapterLabel + ' · ' + route.backendLabel + '. ' + route.readiness.reason)),
          chip(route.readiness.eligible ? 'Preview check passed' : 'Held', route.readiness.eligible ? 'ok' : 'warn', route.readiness.eligible ? '✓' : '!'))))),
      h('section', {class: 'stack', 'aria-labelledby': 'diag-heading'},
        h('div', {class: 'row-between'}, h('h2', {id: 'diag-heading'}, 'Task qualification diagnostic'), simulated()),
        !view ? h('p', {class: 'muted'}, 'The qualification diagnostic is computed for one task. Create a task to see it.') : [
          notice('info', h('p', null, h('strong', null, 'Diagnostic only. '), 'It does not authorize execution, whatever any card says. ' + view.limitation)),
          h('p', {class: 'faint'}, (mode.synthetic ? 'Sample produced by the host readiness function for a synthetic task' : 'Computed by the workspace for ' + (state.task ? 'the open task' : 'the most recent task')) +
            ', version ' + view.taskVersion + ', observed ' + formatDateTime(view.observedAt) +
            '. Evaluated ' + view.inventory.evaluated + ' of ' + view.inventory.total + ' routes' + (view.inventory.truncated ? '. Routes beyond the limit of ' + view.inventory.limit + ' were not evaluated.' : '.')),
          view.diagnostics.length ? notice('warn', h('ul', {class: 'stack'}, view.diagnostics.map(text => h('li', null, text)))) : null,
          h('div', {class: 'cards'}, view.cards.map(card))]),
      panel([h('h2', null, 'Other connection types'), planned()],
        h('ul', {class: 'stack'},
          h('li', null, h('strong', null, 'Subscription. '), 'Not implemented. Not every consumer subscription permits headless or third-party use, so each provider must be verified first.'),
          h('li', null, h('strong', null, 'Metered API. '), 'Not implemented. It would never be selected for you, and an exhausted quota would hold the task.'))),
      notice('info', h('p', null, 'Isolation: nothing here proves OS-level network isolation. A loopback address shows where a request is first sent, not where it ends up.'))]));
}
