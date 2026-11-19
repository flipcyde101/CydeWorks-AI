import test from 'node:test';
import assert from 'node:assert/strict';
import {attentionFor} from './attention.mjs';
import {describeProgress} from './web/progress.js';

test('current-step samples can support a stall without an overall step rate', () => {
  const started = '2026-11-14T12:00:00.000Z';
  const startMs = Date.parse(started);
  const attempt = {
    id: 'attempt-current-step',
    status: 'running',
    started,
    execution: {phase: 'dispatching', dispatchedAt: started},
  };
  const task = {
    id: 'task-current-step',
    title: 'Synthetic task',
    status: 'running',
    attempts: [attempt],
    live: {
      chars: 0,
      lastActivity: new Date(startMs + 4_000).toISOString(),
      heartbeat: new Date(startMs + 64_000).toISOString(),
      steps: {
        measured: true,
        source: 'worker',
        completed: 1,
        total: 5,
        currentStep: {
          index: 2,
          label: 'Run checks',
          measured: true,
          completed: 2,
          total: 8,
          samples: [
            {at: started, done: 0},
            {at: new Date(startMs + 4_000).toISOString(), done: 2},
          ],
        },
      },
    },
  };
  const progress = describeProgress(task, attempt, startMs + 65_000);
  assert.equal(progress.stepRate, null);
  assert.ok(progress.currentStep.rate > 0);
  assert.equal(progress.phase, 'stalled');
  assert.deepEqual(attentionFor(task, {attemptId: attempt.id, progress}).reasons,
    ['Active run may be stalled']);
});
