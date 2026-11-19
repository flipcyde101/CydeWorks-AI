import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {terminalWorkspace} from './test-support/terminal-workspace.mjs';

test('the workspace host serves the selected experience and its local assets', {timeout: 15000}, async t => {
  const {request} = await terminalWorkspace(t, {startImmediately: false, uiMode: 'experience'});
  const read = route => request(route, undefined, {authenticated: false});
  const page = await read('/');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /<meta name="cydeworks-adapter" content="http">/);
  for (const [route, type] of [['/app.js', 'text/javascript'], ['/styles/app.css', 'text/css'], ['/favicon.svg', 'image/svg+xml']]) {
    const response = await read(route);
    assert.equal(response.status, 200, route);
    assert.ok(response.headers.get('content-type').startsWith(type), route);
  }
  assert.equal((await read('/api/tasks')).status, 401);
});

test('workspace analytics accounts for saved receipts and retries without editing tasks', {timeout: 15000}, async t => {
  const {request, task, path} = await terminalWorkspace(t, {
    startImmediately: false,
    configure: folder => writeFile(join(folder, 'providers.mjs'), `
export const ollamaEndpoint = 'http://127.0.0.1:1';
export const ollama = {inspect: async () => ({models: []})};
export const fixture = {
  models: async () => [{id:'fixture'}],
  run: async task => ({settled:true, usage:null, artifact:task.attempts.length === 1 ? null : {summary:'Revised', content:'After'}})
};`),
  });
  const endpoint = '/api/receipts/analytics';
  assert.equal((await request(endpoint, undefined, {authenticated: false})).status, 401);
  const onlyDraft = await request(endpoint);
  assert.equal(onlyDraft.status, 200);
  assert.equal(onlyDraft.headers.get('cache-control'), 'no-store');
  const initial = await onlyDraft.json();
  assert.equal(initial.coverage.unrunDrafts, 1);
  assert.equal(initial.summary.attempts.totalAttemptCount, 0);
  assert.equal((await request(endpoint, {})).status, 405);

  async function finishAttempt(current, expected) {
    const start = await request(path + '/run', {version: current.version, sourceHash: current.sourceHash,
      approve: true, engine: 'fixture', model: 'fixture'});
    assert.equal(start.status, 202);
    for (let retry = 0; retry < 50; retry++) {
      const latest = await (await request(path)).json();
      if (latest.status !== 'running') {
        assert.equal(latest.status, expected);
        return latest;
      }
      await delay(20);
    }
    assert.fail('The fixture attempt did not settle');
  }
  const failed = await finishAttempt(task, 'failed');
  const proposal = await finishAttempt(failed, 'review');
  assert.equal((await request(path + '/review', {version: proposal.version, decision: 'accepted',
    artifactHash: proposal.attempts.at(-1).artifact.sha256})).status, 200);
  assert.equal((await request('/api/tasks', {kind: 'brief', title: 'Synthetic unused draft', source: 'Synthetic draft source',
    request: 'Draft a summary.'})).status, 201);

  const state = await (await request(path)).text();
  const report = await request(endpoint);
  assert.equal(report.status, 200);
  const raw = await report.text();
  const {coverage, summary} = JSON.parse(raw);
  assert.deepEqual(coverage, {workspaceTasks: 2, checkedTasks: 2, unrunDrafts: 1, omittedTasks: 0});
  assert.equal(summary.envelopeCounts.available, 1);
  assert.equal(summary.attempts.totalAttemptCount, 2);
  assert.equal(summary.attempts.statusCounts.failed, 1);
  assert.equal(summary.costs.knownCostAttemptCount, 0);
  assert.equal(summary.costs.unknownCostAttemptCount, 2);
  assert.deepEqual(summary.costs.groups, []);
  assert.equal(summary.timing.recordedElapsedMs.knownAttemptCount, 2);
  assert.equal(raw.includes(task.id), false);
  assert.doesNotMatch(raw, /example\.txt|Synthetic draft source|Synthetic terminal contention|\bAfter\b/);
  assert.equal(await (await request(path)).text(), state);
});
