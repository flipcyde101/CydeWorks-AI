import test from 'node:test';
import assert from 'node:assert/strict';
import {describeProgress,progressAnnouncement} from './web/progress.js';

const start='2026-11-14T12:00:00.000Z';
const then=Date.parse(start);

test('progress distinguishes waiting, activity and a possible stall without inventing an ETA',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};
  const task={status:'running',live:{chars:0,lastActivity:start,heartbeat:start,stopping:false}};
  let state=describeProgress(task,attempt,then+5000);
  assert.equal(state.status,'Waiting for model output');
  assert.equal(state.elapsedMs,5000);
  assert.equal(state.rate,null);
  assert.match(state.eta,/unavailable/i);
  task.live.chars=20;
  task.live.lastActivity='2026-11-14T12:00:04.000Z';
  state=describeProgress(task,attempt,then+5000);
  assert.equal(state.status,'Receiving output');
  assert.equal(state.rate,4);
  state=describeProgress(task,attempt,then+65000);
  assert.match(state.status,/possibly stalled/i);
  assert.match(state.explanation,/may still be working/i);
  assert.match(state.completion,/unavailable/i);
});

test('progress announcements flag stale views and indicate review readiness without timer updates',()=>{
  const running={status:'running',live:{chars:4,lastActivity:start,heartbeat:start}};
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};
  const first=describeProgress(running,attempt,then+1000);
  const second=describeProgress(running,attempt,then+2000);
  assert.equal(progressAnnouncement(running,first,'connected'),progressAnnouncement(running,second,'connected'));
  assert.match(progressAnnouncement(running,first,'reconnecting'),/stale/i);
  assert.match(progressAnnouncement({status:'review'},null,'connected'),/ready for review/i);
  assert.match(progressAnnouncement({status:'interrupted'},null,'connected'),/outcome.*unknown/i);
  assert.match(progressAnnouncement({status:'interrupted',attempts:[{recovery:{state:'retry-safe'}}]},null,'connected'),/safe to retry/i);
});

test('progress reports stop requests and missing or future timestamps conservatively',()=>{
  const attempt={started:'not-a-time',execution:{phase:'claimed'}};
  const stopping={status:'running',live:{chars:0,lastActivity:'2027-01-01',heartbeat:null,stopping:true}};
  const state=describeProgress(stopping,attempt,then);
  assert.equal(state.status,'Stop requested');
  assert.match(state.remaining,/termination.*recovery/i);
  assert.equal(state.elapsedMs,null);
  assert.equal(state.lastActivity,null);
  assert.equal(state.rate,null);
  const missing=describeProgress({status:'running',live:null},attempt,then);
  assert.equal(missing.status,'Waiting for run state');
  assert.equal(missing.heartbeat,null);
});
