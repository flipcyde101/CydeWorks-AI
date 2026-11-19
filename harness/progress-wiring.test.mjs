import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {loadBrowserAssets} from './browser-assets.mjs';
import {renderTask} from './web-experience/views/task.js';

const root = fileURLToPath(new URL('.', import.meta.url));

test('both browser modes serve the same pinned progress modules', async () => {
  const legacy = await loadBrowserAssets(root, 'legacy');
  const experience = await loadBrowserAssets(root, 'experience');
  for (const name of ['progress.js', 'progress-view.js']) {
    const original = await readFile(new URL('./web/' + name, import.meta.url));
    assert.deepEqual(legacy.assets.get('/' + name)?.data, original);
    assert.deepEqual(experience.assets.get('/vendor/harness-web/' + name)?.data, original);
  }
});

class TestNode {
  constructor(tag, text = '') {
    this.tagName = tag;
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.parentNode = null;
    this.ownText = text;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.ownText = '';
    this.append(...nodes);
  }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.ownText = String(value); }
  addEventListener() {}
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelector(selector) {
    if (selector.startsWith('#')) return this.descendants().find(node => node.id === selector.slice(1)) ?? null;
    const fid = /^\[data-fid="([^"]+)"\]$/.exec(selector)?.[1];
    return fid ? this.descendants().find(node => node.dataset.fid === fid) ?? null : null;
  }
  querySelectorAll(selector) {
    if (selector === 'details[data-fid]') return this.descendants().filter(node => node.tagName === 'details' && node.dataset.fid);
    if (selector === '[data-keep-scroll]') return this.descendants().filter(node => node.dataset.keepScroll);
    return [];
  }
  focus() { globalThis.document.activeElement = this; }
}

test('experience progress shows measured values, preserves focus, and hides stale values', t => {
  const old = {document: globalThis.document, Node: globalThis.Node, CSS: globalThis.CSS};
  t.after(() => { globalThis.document = old.document; globalThis.Node = old.Node; globalThis.CSS = old.CSS; });
  globalThis.Node = TestNode;
  globalThis.CSS = {escape: value => value};
  globalThis.document = {
    activeElement: null,
    createElement: tag => new TestNode(tag),
    createElementNS: (_namespace, tag) => new TestNode(tag),
    createTextNode: text => new TestNode('#text', text),
  };

  const start = '2026-11-14T12:00:00.000Z';
  const then = Date.parse(start);
  const attempt = {id: 'synthetic-attempt', provider: 'fixture', model: 'fixture', routeLabel: 'Fixture',
    status: 'running', started: start, execution: {phase: 'dispatching', dispatchedAt: start}};
  const task = {id: 'synthetic-task', title: 'Synthetic task', kind: 'brief', status: 'running',
    attempts: [attempt], events: [], approvals: [], live: {chars: 0, lastActivity: start, heartbeat: start}};
  const state = {task, connection: 'connected', needsReconcile: false, busy: false, now: then + 5000};
  const ctx = {state, actions: {}, ownsControl: () => false, selectedRoute: () => null};
  const container = new TestNode('main');
  renderTask(container, ctx);

  let panel = container.querySelector('#run-progress');
  assert.match(panel.textContent, /Current step/);
  assert.match(panel.textContent, /Remaining.*Unknown/i);
  assert.match(panel.textContent, /Overall ETA.*Unavailable/i);
  assert.match(panel.textContent, /Projected local completion.*Unavailable/i);
  assert.match(panel.textContent, /Latest activity/);
  assert.match(panel.textContent, /Heartbeat/);
  assert.doesNotMatch(panel.textContent, /\d+%/);
  const liveRegion = container.querySelector('#task-progress-announcement');
  assert.equal(liveRegion.getAttribute('role'), 'status');
  assert.equal(liveRegion.getAttribute('aria-live'), 'polite');

  attempt.execution = {};
  renderTask(container, ctx);
  panel = container.querySelector('#run-progress');
  assert.doesNotMatch(panel.textContent, /Request dispatched|3 of 5/);
  attempt.execution = {phase: 'dispatching', dispatchedAt: start};
  renderTask(container, ctx);
  panel = container.querySelector('#run-progress');

  const stop = panel.querySelector('[data-fid="cancel-request"]');
  assert.ok(stop);
  stop.focus();
  task.live.steps = {measured: true, source: 'worker', completed: 2, total: 5,
    samples: [{at: start, done: 0}, {at: new Date(then + 4000).toISOString(), done: 2}]};
  renderTask(container, ctx);
  panel = container.querySelector('#run-progress');
  assert.match(panel.textContent, /2 of 5 steps \(2\/5, 40%\)/);
  assert.match(panel.textContent, /3 of 5 steps remaining/);
  assert.match(panel.textContent, /Overall ETA6\.0 s/);
  assert.equal(globalThis.document.activeElement.dataset.fid, 'cancel-request');
  assert.notEqual(globalThis.document.activeElement, stop);

  state.needsReconcile = true;
  renderTask(container, ctx);
  panel = container.querySelector('#run-progress');
  assert.match(panel.textContent, /connection is unverified/i);
  assert.doesNotMatch(panel.textContent, /40%/);
  assert.match(liveRegion.textContent, /stale/i);

  state.needsReconcile = false;
  task.live.stopping = true;
  renderTask(container, ctx);
  panel = container.querySelector('#run-progress');
  assert.match(panel.textContent, /stop requested/i);
  assert.equal(panel.querySelector('[data-fid="cancel-request"]').disabled, true);
  assert.match(panel.textContent, /Overall ETA.*Unavailable/i);

  task.status = 'review';
  attempt.status = 'completed';
  task.live.stopping = false;
  renderTask(container, ctx);
  assert.match(liveRegion.textContent, /incomplete termination/i);
});
