import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_DATE_MS,describeProgress} from './web/progress.js';
import {presentProgress} from './web/progress-view.js';

const start='2026-11-14T12:00:00.000Z';
const then=Date.parse(start);

function rowByKey(view,key) {
  return view.rows.find(entry=>entry.key===key);
}

function fixedClock(ms) {
  return new Date(ms).toISOString().slice(11,19)+' UTC';
}

test('unknown totals and missing runner counters never invent percentages, rates, ETAs or completion times',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};

  // No live runner counters yet: waiting for model output with 0 chars
  const noCounters=describeProgress({
    status:'running',
    live:{chars:0,lastActivity:start,heartbeat:start,stopping:false},
  },attempt,then+5000);
  const waitingView=presentProgress(noCounters,{formatLocalTime:fixedClock});
  assert.equal(waitingView.available,true);
  assert.equal(waitingView.phase,'waiting');
  assert.equal(waitingView.stateLabel,'Waiting');
  assert.equal(waitingView.waiting,true);
  assert.equal(waitingView.stalled,false);
  assert.equal(waitingView.failed,false);
  assert.equal(waitingView.complete,false);
  assert.equal(waitingView.counts.totalKnown,false);
  assert.equal(waitingView.counts.percent,null);
  assert.match(rowByKey(waitingView,'status').value,/waiting/i);
  assert.match(rowByKey(waitingView,'completed').value,/unmeasured|unavailable/i);
  assert.match(rowByKey(waitingView,'remaining').value,/unknown/i);
  assert.match(rowByKey(waitingView,'rate').value,/unavailable/i);
  assert.equal(rowByKey(waitingView,'elapsed').value,'5.0 s');
  assert.match(rowByKey(waitingView,'currentStepEta').value,/unavailable/i);
  assert.match(rowByKey(waitingView,'overallEta').value,/unavailable/i);
  assert.match(rowByKey(waitingView,'completion').value,/unavailable/i);
  assert.doesNotMatch(waitingView.text,/\d+%|projected around/i);

  // Streaming characters without step counters
  const charStream=describeProgress({
    status:'running',
    live:{
      chars:2400,
      totalChars:5000,
      maxTokens:4096,
      lastActivity:new Date(then+8000).toISOString(),
      heartbeat:new Date(then+9000).toISOString(),
    },
  },attempt,then+10000);
  const streamView=presentProgress(charStream,{formatLocalTime:fixedClock});
  assert.equal(streamView.phase,'active');
  assert.equal(streamView.stateLabel,'Running');
  assert.equal(streamView.counts.totalKnown,false);
  assert.equal(streamView.counts.percent,null);
  assert.match(rowByKey(streamView,'output').value,/2400 characters.*total unknown/i);
  assert.match(rowByKey(streamView,'rate').value,/240\.0 characters\/s/i);
  assert.match(rowByKey(streamView,'remaining').value,/unknown/i);
  assert.match(rowByKey(streamView,'overallEta').value,/unknown/i);
  assert.match(rowByKey(streamView,'completion').value,/unavailable/i);
  assert.doesNotMatch(streamView.text,/\d+%|projected around/i);

  // Open-total measured steps (completed known, total null)
  const openSteps=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+4000).toISOString(),
      heartbeat:new Date(then+4500).toISOString(),
      steps:{
        measured:true,
        source:'worker',
        completed:2,
        total:null,
        samples:[
          {at:start,done:0},
          {at:new Date(then+4000).toISOString(),done:2},
        ],
      },
    },
  },attempt,then+5000);
  const openView=presentProgress(openSteps,{formatLocalTime:fixedClock});
  assert.equal(openView.counts.completedSteps,2);
  assert.equal(openView.counts.totalKnown,false);
  assert.equal(openView.counts.percent,null);
  assert.match(rowByKey(openView,'completed').value,/2 steps completed \(total unknown\)/i);
  assert.match(rowByKey(openView,'remaining').value,/unknown/i);
  assert.match(rowByKey(openView,'rate').value,/0\.5 steps\/s/i);
  assert.match(rowByKey(openView,'overallEta').value,/unknown/i);
  assert.match(rowByKey(openView,'completion').value,/unavailable/i);
  assert.doesNotMatch(openView.text,/\d+%|projected around/i);

  // Rejected character-unit steps preserve rejection reason while keeping char stream rate
  const rejectedSteps=describeProgress({
    status:'running',
    live:{
      chars:2400,
      lastActivity:new Date(then+8000).toISOString(),
      heartbeat:new Date(then+9000).toISOString(),
      steps:{
        unit:'chars',
        completed:2400,
        total:5000,
        samples:[
          {at:start,done:0},
          {at:new Date(then+8000).toISOString(),done:2400},
        ],
      },
    },
  },attempt,then+10000);
  const rejectedView=presentProgress(rejectedSteps,{formatLocalTime:fixedClock});
  assert.equal(rejectedView.counts.totalKnown,false);
  assert.match(rowByKey(rejectedView,'completed').value,/character/i);
  assert.match(rowByKey(rejectedView,'rate').value,/240\.0 characters\/s.*rejected/i);
  assert.match(rowByKey(rejectedView,'overallEta').value,/character/i);
});

test('measured counts and separate current-step vs overall estimates render accurately and produce drop-in pairs',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};
  const state=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+4500).toISOString(),
      heartbeat:new Date(then+4800).toISOString(),
      steps:{
        measured:true,
        source:'worker',
        completed:2,
        total:5,
        samples:[
          {at:start,done:0},
          {at:new Date(then+2000).toISOString(),done:1},
          {at:new Date(then+4000).toISOString(),done:2},
        ],
        currentStep:{
          index:3,
          label:'Run protected checks',
          measured:true,
          completed:2,
          total:8,
          samples:[
            {at:new Date(then+4000).toISOString(),done:0},
            {at:new Date(then+4500).toISOString(),done:2},
          ],
        },
      },
    },
  },attempt,then+5000);

  const view=presentProgress(state,{formatLocalTime:fixedClock});
  assert.equal(view.available,true);
  assert.equal(view.phase,'active');
  assert.equal(view.stateLabel,'Running');
  assert.equal(view.counts.doneTotal,'2/5');
  assert.equal(view.counts.percent,40);

  assert.equal(rowByKey(view,'status').value,'Running step 3 of 5');
  assert.equal(rowByKey(view,'currentStep').value,'Step 3: Run protected checks (2/8, 25%; 4 sub-steps/s)');
  assert.equal(rowByKey(view,'completed').value,'2 of 5 steps (2/5, 40%)');
  assert.equal(rowByKey(view,'remaining').value,'3 of 5 steps remaining');
  assert.equal(rowByKey(view,'rate').value,'0.5 steps/s (current step: 4 sub-steps/s)');
  assert.equal(rowByKey(view,'elapsed').value,'5.0 s');
  assert.equal(rowByKey(view,'lastActivity').value,'12:00:04 UTC (500 ms ago)');
  assert.equal(rowByKey(view,'heartbeat').value,'12:00:04 UTC (200 ms ago)');
  assert.equal(rowByKey(view,'currentStepEta').value,'1.5 s');
  assert.equal(rowByKey(view,'overallEta').value,'6.0 s');
  assert.equal(rowByKey(view,'completion').value,'Projected around 12:00:11 UTC (in 6.0 s).');

  // pairs are [label, value] tuples compatible with definition(dl, pairs)
  assert.ok(Array.isArray(view.pairs));
  assert.equal(view.pairs.length,view.rows.length);
  for (const [label,value] of view.pairs) {
    assert.equal(typeof label,'string');
    assert.equal(typeof value,'string');
    assert.ok(label.length>0&&value.length>0);
  }
  assert.match(view.announcement,/running step 3 of 5 \(2\/5\)/i);

  // When current-step sub-progress is unmeasured, Current step ETA is unavailable while Overall ETA stays 6.0 s.
  const withoutSub=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+4000).toISOString(),
      heartbeat:new Date(then+4800).toISOString(),
      steps:{
        measured:true,
        completed:2,
        total:5,
        samples:[
          {at:start,done:0},
          {at:new Date(then+4000).toISOString(),done:2},
        ],
        currentStep:'Validate patch',
      },
    },
  },attempt,then+5000);
  const noSubView=presentProgress(withoutSub,{formatLocalTime:fixedClock});
  assert.equal(rowByKey(noSubView,'currentStep').value,'Validate patch (sub-progress not measured)');
  assert.match(rowByKey(noSubView,'currentStepEta').value,/unavailable.*not measured/i);
  assert.equal(rowByKey(noSubView,'overallEta').value,'6.0 s');
  assert.equal(rowByKey(noSubView,'completion').value,'Projected around 12:00:11 UTC (in 6.0 s).');

  // 99999/100000 never rounds to 100%
  const nearlyDone=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+10000).toISOString(),
      heartbeat:new Date(then+10000).toISOString(),
      steps:{
        measured:true,
        completed:99999,
        total:100000,
        samples:[
          {at:start,done:0},
          {at:new Date(then+10000).toISOString(),done:99999},
        ],
      },
    },
  },attempt,then+11000);
  const nearlyView=presentProgress(nearlyDone,{formatLocalTime:fixedClock});
  assert.equal(rowByKey(nearlyView,'currentStep').value,'Unavailable (current step not reported)');
  assert.equal(rowByKey(nearlyView,'rate').value,'9999.9 steps/s');
  assert.equal(rowByKey(nearlyView,'completed').value,'99999 of 100000 steps (99999/100000, 99.99%)');
  assert.doesNotMatch(rowByKey(nearlyView,'completed').value,/100%/);

  // Empty currentStep object with positive overall stepRate falls back to not-reported without crashing
  const emptyStepView=presentProgress(describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+4000).toISOString(),
      heartbeat:new Date(then+4000).toISOString(),
      steps:{
        measured:true,
        completed:2,
        total:5,
        samples:[
          {at:start,done:0},
          {at:new Date(then+4000).toISOString(),done:2},
        ],
        currentStep:{},
      },
    },
  },attempt,then+5000),{formatLocalTime:fixedClock});
  assert.equal(rowByKey(emptyStepView,'currentStep').value,'Unavailable (current step not reported)');
  assert.equal(rowByKey(emptyStepView,'rate').value,'0.5 steps/s');
  assert.equal(rowByKey(emptyStepView,'overallEta').value,'6.0 s');
});

test('stale data, zero rates, waiting-for-completion, and unavailable inputs behave conservatively',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};

  // Zero measured step rate shows 0 steps/s without inventing an ETA
  const zeroRate=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+10000).toISOString(),
      heartbeat:new Date(then+10000).toISOString(),
      steps:{
        measured:true,
        completed:1,
        total:5,
        samples:[
          {at:start,done:1},
          {at:new Date(then+10000).toISOString(),done:1},
        ],
      },
    },
  },attempt,then+10000);
  const zeroView=presentProgress(zeroRate,{formatLocalTime:fixedClock});
  assert.equal(zeroView.phase,'waiting');
  assert.equal(zeroView.waiting,true);
  assert.equal(rowByKey(zeroView,'rate').value,'0 steps/s');
  assert.equal(rowByKey(zeroView,'rate').available,true);
  assert.match(rowByKey(zeroView,'overallEta').value,/0 steps\/s/i);
  assert.match(rowByKey(zeroView,'completion').value,/0 steps\/s/i);

  // Stalled with fresh heartbeat still marks stalled and suppresses ETAs/completion
  const stalled=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+4000).toISOString(),
      heartbeat:new Date(then+64000).toISOString(),
      steps:{
        measured:true,
        completed:2,
        total:5,
        samples:[
          {at:start,done:0},
          {at:new Date(then+4000).toISOString(),done:2},
        ],
      },
    },
  },attempt,then+65000);
  const stalledView=presentProgress(stalled,{formatLocalTime:fixedClock});
  assert.equal(stalledView.phase,'stalled');
  assert.equal(stalledView.stateLabel,'Possibly stalled');
  assert.equal(stalledView.stalled,true);
  assert.equal(stalledView.waiting,false);
  assert.equal(rowByKey(stalledView,'lastActivity').value,'12:00:04 UTC (1 min 01 s ago)');
  assert.equal(rowByKey(stalledView,'heartbeat').value,'12:01:04 UTC (1.0 s ago)');
  assert.match(rowByKey(stalledView,'currentStepEta').value,/stalled/i);
  assert.match(rowByKey(stalledView,'overallEta').value,/stalled/i);
  assert.match(rowByKey(stalledView,'completion').value,/stalled/i);
  assert.doesNotMatch(rowByKey(stalledView,'completion').value,/projected around/i);

  // Active char output with stale step samples preserves stale reason on ETAs
  const staleSamples=describeProgress({
    status:'running',
    live:{
      chars:800,
      lastActivity:new Date(then+64000).toISOString(),
      heartbeat:new Date(then+64000).toISOString(),
      steps:{
        measured:true,
        completed:2,
        total:5,
        samples:[
          {at:start,done:0},
          {at:new Date(then+4000).toISOString(),done:2},
        ],
        currentStep:{
          label:'Compile',
          startedAt:new Date(then+3000).toISOString(),
          measured:true,
          completed:1,
          total:4,
          samples:[
            {at:new Date(then+3000).toISOString(),done:0},
            {at:new Date(then+4000).toISOString(),done:1},
          ],
        },
      },
    },
  },attempt,then+65000);
  const staleView=presentProgress(staleSamples,{formatLocalTime:fixedClock});
  assert.equal(staleView.phase,'active');
  assert.match(rowByKey(staleView,'currentStepEta').value,/stale/i);
  assert.match(rowByKey(staleView,'overallEta').value,/stale/i);
  assert.match(rowByKey(staleView,'completion').value,/stale/i);

  // 5/5 while still running waits for authoritative completion and preserves withheld current-step ETA
  const waitingSettlement=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+5000).toISOString(),
      heartbeat:new Date(then+5000).toISOString(),
      steps:{
        measured:true,
        completed:5,
        total:5,
        samples:[
          {at:start,done:0},
          {at:new Date(then+5000).toISOString(),done:5},
        ],
        currentStep:{
          index:5,
          label:'Finalize checks',
          measured:true,
          completed:4,
          total:4,
          samples:[
            {at:new Date(then+4000).toISOString(),done:0},
            {at:new Date(then+5000).toISOString(),done:4},
          ],
        },
      },
    },
  },attempt,then+6000);
  assert.equal(waitingSettlement.currentStepEtaMs,null);
  assert.equal(waitingSettlement.unavailableReasons.currentStepEta,'Unavailable until the workspace confirms run completion.');
  const settleView=presentProgress(waitingSettlement,{formatLocalTime:fixedClock});
  assert.equal(settleView.phase,'waiting');
  assert.equal(settleView.complete,false);
  assert.equal(rowByKey(settleView,'remaining').value,'0 of 5 steps remaining (waiting for completion)');
  assert.equal(rowByKey(settleView,'currentStepEta').value,'Unavailable until the workspace confirms run completion.');
  assert.equal(rowByKey(settleView,'currentStepEta').available,false);
  assert.doesNotMatch(rowByKey(settleView,'currentStepEta').value,/current step complete|0 ms/i);
  assert.match(rowByKey(settleView,'overallEta').value,/confirm.*completion/i);

  // Explicit unavailable reason or null ETA on completed sub-counters never fabricates a zero ETA
  const withheldSubEtaView=presentProgress({
    phase:'active',
    status:'Running step 3 of 5',
    totalKnown:true,
    completedSteps:2,
    totalSteps:5,
    remainingSteps:3,
    stepRate:0.5,
    overallEtaMs:6000,
    projectedCompletionMs:then+12000,
    currentStep:{
      index:3,
      label:'Verify step',
      completed:4,
      total:4,
      remaining:0,
      doneTotal:'4/4',
      percent:100,
      etaMs:null,
    },
    currentStepEtaMs:null,
    unavailableReasons:{
      currentStepEta:'Unavailable until downstream check confirms step end.',
    },
  },{formatLocalTime:fixedClock});
  assert.equal(rowByKey(withheldSubEtaView,'currentStepEta').value,'Unavailable until downstream check confirms step end.');
  assert.equal(rowByKey(withheldSubEtaView,'currentStepEta').available,false);
  assert.doesNotMatch(rowByKey(withheldSubEtaView,'currentStepEta').value,/current step complete|0 ms/i);

  // Null, undefined, primitive, array, empty object inputs never throw
  for (const bad of [null,undefined,'running',42,['a'],new Date(),{}]) {
    const view=presentProgress(bad);
    assert.equal(view.available,false);
    assert.equal(view.phase,'unavailable');
    assert.equal(view.stateLabel,'Unavailable');
    assert.match(rowByKey(view,'status').value,/unavailable/i);
    assert.match(rowByKey(view,'overallEta').value,/unavailable/i);
  }
});

test('failures, premature completion, interruptions and cancellations distinguish state and block ETAs',()=>{
  const attempt={
    status:'failed',
    started:start,
    ended:new Date(then+7000).toISOString(),
    problem:'Protected check exited with status 1.',
    execution:{phase:'dispatching',dispatchedAt:start},
  };
  const failed=describeProgress({
    status:'failed',
    live:{
      lastActivity:new Date(then+7000).toISOString(),
      heartbeat:new Date(then+7000).toISOString(),
      steps:{
        measured:true,
        completed:3,
        total:5,
        samples:[
          {at:start,done:0},
          {at:new Date(then+6000).toISOString(),done:3},
        ],
      },
    },
  },attempt,then+12000);

  const failedView=presentProgress(failed,{formatLocalTime:fixedClock});
  assert.equal(failedView.phase,'failed');
  assert.equal(failedView.stateLabel,'Failed');
  assert.equal(failedView.failed,true);
  assert.equal(failedView.complete,false);
  assert.equal(failedView.explanation,'Attempt failed (code: E_ATTEMPT_FAILED). Detailed diagnostics are omitted; review recovery status before retrying.');
  assert.doesNotMatch(failedView.text,/Protected check exited with status 1/);
  assert.doesNotMatch(failedView.announcement,/Protected check exited with status 1/);
  assert.equal(rowByKey(failedView,'status').value,'Attempt failed');
  assert.equal(rowByKey(failedView,'completed').value,'3 of 5 steps (3/5, 60%)');
  assert.equal(rowByKey(failedView,'remaining').value,'2 of 5 steps remaining');
  assert.equal(rowByKey(failedView,'elapsed').value,'7.0 s');
  assert.match(rowByKey(failedView,'currentStepEta').value,/failed/i);
  assert.match(rowByKey(failedView,'overallEta').value,/failed/i);
  assert.match(rowByKey(failedView,'completion').value,/failed/i);

  // Generic describeProgress failure without problem/error keeps the static safe message
  const genericFailedView=presentProgress(describeProgress({
    status:'failed',
    live:{heartbeat:new Date(then+3000).toISOString()},
  },{status:'failed',started:start,execution:{phase:'dispatching',dispatchedAt:start}},then+5000));
  assert.equal(genericFailedView.phase,'failed');
  assert.equal(genericFailedView.explanation,'The attempt failed before completion.');

  // Contradictory complete input with remaining steps is forced to failed/incomplete
  const contradictoryComplete=presentProgress({
    phase:'complete',
    complete:true,
    status:'Complete',
    totalKnown:true,
    completedSteps:2,
    totalSteps:5,
    remainingSteps:3,
    percent:40,
    overallEtaMs:0,
    projectedCompletionMs:then+5000,
  },{formatLocalTime:fixedClock});
  assert.equal(contradictoryComplete.phase,'failed');
  assert.equal(contradictoryComplete.failed,true);
  assert.equal(contradictoryComplete.complete,false);
  assert.equal(rowByKey(contradictoryComplete,'status').value,'Incomplete termination');
  assert.match(rowByKey(contradictoryComplete,'overallEta').value,/unavailable/i);
  assert.match(rowByKey(contradictoryComplete,'completion').value,/unavailable/i);

  const interrupted=presentProgress(describeProgress({
    status:'interrupted',
    recovery:{blocked:true},
    live:{heartbeat:new Date(then+3000).toISOString()},
  },{started:start,execution:{phase:'dispatching',dispatchedAt:start}},then+5000));
  assert.equal(interrupted.phase,'interrupted');
  assert.equal(interrupted.stateLabel,'Interrupted');
  assert.match(rowByKey(interrupted,'overallEta').value,/interrupted/i);

  const cancelled=presentProgress(describeProgress({
    status:'cancelled',
    live:{heartbeat:new Date(then+3000).toISOString()},
  },{started:start,execution:{phase:'dispatching',dispatchedAt:start}},then+5000));
  assert.equal(cancelled.phase,'cancelled');
  assert.equal(cancelled.stateLabel,'Cancelled');
  assert.match(rowByKey(cancelled,'overallEta').value,/cancelled/i);

  // Authoritative 5/5 failed, cancelled, and interrupted runs never claim waiting for completion
  const fullSteps={
    measured:true,
    completed:5,
    total:5,
    samples:[
      {at:start,done:0},
      {at:new Date(then+5000).toISOString(),done:5},
    ],
  };
  for (const [taskStatus,expectedPhase,expectedLabel] of [
    ['failed','failed','Failed'],
    ['cancelled','cancelled','Cancelled'],
    ['interrupted','interrupted','Interrupted'],
  ]) {
    const terminal5View=presentProgress(describeProgress({
      status:taskStatus,
      live:{
        lastActivity:new Date(then+5000).toISOString(),
        heartbeat:new Date(then+5000).toISOString(),
        steps:fullSteps,
      },
    },{
      status:taskStatus==='failed' ? 'failed' : undefined,
      started:start,
      ended:new Date(then+6000).toISOString(),
      execution:{phase:'dispatching',dispatchedAt:start},
    },then+7000),{formatLocalTime:fixedClock});
    assert.equal(terminal5View.phase,expectedPhase);
    assert.equal(terminal5View.stateLabel,expectedLabel);
    assert.equal(terminal5View.waiting,false);
    assert.equal(rowByKey(terminal5View,'remaining').value,'0 of 5 steps remaining');
    assert.doesNotMatch(rowByKey(terminal5View,'remaining').value,/waiting for completion/i);
  }
});

test('clock anomalies suppress elapsed, rates, ETAs and completion times cleanly',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};

  const backwardSamples=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+4000).toISOString(),
      heartbeat:new Date(then+4000).toISOString(),
      steps:{
        measured:true,
        completed:2,
        total:4,
        samples:[
          {at:new Date(then+3000).toISOString(),done:1},
          {at:new Date(then+2000).toISOString(),done:2},
        ],
      },
    },
  },attempt,then+5000);
  const backwardView=presentProgress(backwardSamples,{formatLocalTime:fixedClock});
  assert.equal(backwardView.clockAnomaly,true);
  assert.match(backwardView.clockAnomalyReason,/backward/i);
  assert.match(rowByKey(backwardView,'clockAnomaly').value,/backward/i);
  assert.match(rowByKey(backwardView,'rate').value,/clock anomaly/i);
  assert.match(rowByKey(backwardView,'currentStepEta').value,/clock anomaly/i);
  assert.match(rowByKey(backwardView,'overallEta').value,/clock anomaly/i);
  assert.match(rowByKey(backwardView,'completion').value,/clock anomaly/i);

  const outOfRangeNow=describeProgress({
    status:'running',
    live:{
      lastActivity:MAX_DATE_MS,
      heartbeat:MAX_DATE_MS,
    },
  },{started:MAX_DATE_MS-1000},MAX_DATE_MS+1);
  const outOfRangeView=presentProgress(outOfRangeNow);
  assert.equal(outOfRangeView.clockAnomaly,true);
  assert.match(rowByKey(outOfRangeView,'elapsed').value,/clock anomaly/i);
  assert.doesNotMatch(outOfRangeView.text,/Invalid Date/i);

  // Even if caller supplies stale numeric ETA/completion alongside clockAnomaly:true, view suppresses them
  const tamperedAnomaly=presentProgress({
    phase:'active',
    status:'Running',
    clockAnomaly:true,
    clockAnomalyReason:'Future activity timestamp.',
    elapsedMs:5000,
    rate:20,
    stepRate:0.5,
    totalKnown:true,
    completedSteps:2,
    totalSteps:4,
    remainingSteps:2,
    overallEtaMs:4000,
    currentStepEtaMs:1000,
    projectedCompletionMs:then+9000,
  },{formatLocalTime:fixedClock});
  assert.match(rowByKey(tamperedAnomaly,'elapsed').value,/clock anomaly/i);
  assert.match(rowByKey(tamperedAnomaly,'rate').value,/clock anomaly/i);
  assert.match(rowByKey(tamperedAnomaly,'currentStepEta').value,/clock anomaly/i);
  assert.match(rowByKey(tamperedAnomaly,'overallEta').value,/clock anomaly/i);
  assert.match(rowByKey(tamperedAnomaly,'completion').value,/clock anomaly/i);
});

test('completion renders 100%, zero remaining, recorded completion clock, and preserves missing timestamps or counts',()=>{
  const endedAt=new Date(then+8000).toISOString();
  const complete=describeProgress({
    status:'complete',
    live:{
      lastActivity:endedAt,
      heartbeat:endedAt,
      complete:true,
      steps:{
        measured:true,
        completed:4,
        total:4,
        samples:[
          {at:start,done:0},
          {at:new Date(then+4000).toISOString(),done:2},
          {at:endedAt,done:4},
        ],
      },
    },
  },{
    status:'completed',
    started:start,
    ended:endedAt,
    execution:{phase:'settled',dispatchedAt:start},
  },then+10000);

  const completeView=presentProgress(complete,{formatLocalTime:fixedClock});
  assert.equal(completeView.phase,'complete');
  assert.equal(completeView.stateLabel,'Complete');
  assert.equal(completeView.complete,true);
  assert.equal(rowByKey(completeView,'status').value,'Complete');
  assert.equal(rowByKey(completeView,'currentStep').value,'None (all steps complete)');
  assert.equal(rowByKey(completeView,'completed').value,'4 of 4 steps (4/4, 100%)');
  assert.equal(rowByKey(completeView,'remaining').value,'0 of 4 steps remaining');
  assert.equal(rowByKey(completeView,'elapsed').value,'8.0 s');
  assert.equal(rowByKey(completeView,'currentStepEta').value,'Complete. No remaining work.');
  assert.equal(rowByKey(completeView,'overallEta').value,'Complete. No remaining time.');
  assert.equal(rowByKey(completeView,'completion').value,'Completed at 12:00:08 UTC.');

  // Complete without recorded ended timestamp never invents a completion clock
  const missingEnded=describeProgress({
    status:'complete',
    live:{
      complete:true,
      steps:{
        measured:true,
        completed:4,
        total:4,
        samples:[
          {at:start,done:0},
          {at:new Date(then+4000).toISOString(),done:4},
        ],
      },
    },
  },{started:start,status:'completed',execution:{phase:'settled',dispatchedAt:start}},then+10000);
  const missingEndedView=presentProgress(missingEnded,{formatLocalTime:fixedClock});
  assert.match(rowByKey(missingEndedView,'elapsed').value,/unavailable/i);
  assert.equal(rowByKey(missingEndedView,'completion').value,'Completed. Completion time was not recorded.');
  assert.equal(rowByKey(missingEndedView,'completion').available,false);

  // Complete with missing overall done never renders 0 of 5 or 100%
  const missingOverallDone=describeProgress({
    status:'complete',
    live:{
      complete:true,
      steps:{measured:true,total:5,currentStep:'Finalize'},
    },
  },{started:start,status:'completed',execution:{phase:'settled',dispatchedAt:start}},then+5000);
  const missingDoneView=presentProgress(missingOverallDone);
  assert.match(rowByKey(missingDoneView,'completed').value,/not recorded/i);
  assert.match(rowByKey(missingDoneView,'remaining').value,/not recorded/i);
  assert.match(rowByKey(missingDoneView,'overallEta').value,/not recorded/i);
  assert.match(rowByKey(missingDoneView,'currentStepEta').value,/not recorded/i);
  assert.doesNotMatch(missingDoneView.text,/100%|0 of 5|no remaining work/i);
});

test('hostile inputs, accessor getters, revoked proxies, arbitrary objects and credentials never leak or throw',()=>{
  let getterCalled=false;
  const getterObj={phase:'active'};
  Object.defineProperty(getterObj,'status',{
    enumerable:true,
    get() {
      getterCalled=true;
      return 'SECRET_GETTER_VALUE';
    },
  });
  const getterView=presentProgress(getterObj);
  assert.equal(getterCalled,false);
  assert.doesNotMatch(getterView.text,/SECRET_GETTER_VALUE/);

  const {proxy,revoke}=Proxy.revocable({phase:'active',status:'Running'},{});
  revoke();
  const revokedView=presentProgress(proxy);
  assert.equal(revokedView.available,false);
  assert.equal(revokedView.phase,'unavailable');

  // Arbitrary objects in string fields, unknown secret fields, and failure diagnostics are omitted
  const leaky=presentProgress({
    phase:'failed',
    failed:true,
    status:{nested:'do-not-leak'},
    explanation:'Failed with Bearer supersecretToken123 and api_key=mysecretkey at run (C:\\Users\\owner\\secret\\runner.mjs:42:9)',
    currentStep:{
      label:{bad:'object'},
      index:1,
    },
    apiKey:'sk-1234567890abcdef123456',
    token:'top-secret-token',
    prompt:'private user prompt',
    source:'private source code',
  });
  assert.doesNotMatch(leaky.text,/\[object Object\]/);
  assert.doesNotMatch(leaky.text,/do-not-leak|supersecretToken123|mysecretkey|sk-1234567890|top-secret-token|private user prompt|private source code|runner\.mjs|Failed with/);
  assert.doesNotMatch(leaky.announcement,/supersecretToken123|mysecretkey|Failed with/);
  assert.equal(leaky.explanation,'Attempt failed (code: E_ATTEMPT_FAILED). Detailed diagnostics are omitted; review recovery status before retrying.');

  // Real describeProgress failure diagnostics (JSON, non-JSON, unknown-secret) never print in presentation output
  const diagnosticCases=[
    {
      name:'quoted JSON secret in attempt.problem',
      task:{status:'failed',live:{heartbeat:new Date(then+3000).toISOString()}},
      attempt:{
        status:'failed',
        started:start,
        ended:new Date(then+4000).toISOString(),
        problem:'{"token": "SENSITIVE_VALUE", "x_internal": "JSON_PRIVATE_42"}',
        execution:{phase:'dispatching',dispatchedAt:start},
      },
      forbidden:/SENSITIVE_VALUE|JSON_PRIVATE_42|x_internal|"token"/,
    },
    {
      name:'non-JSON diagnostic in live.error',
      task:{
        status:'running',
        live:{
          error:'Process exited 137 against internal-db.corp.local during checkout step',
          heartbeat:new Date(then+3000).toISOString(),
        },
      },
      attempt:{started:start,execution:{phase:'dispatching',dispatchedAt:start}},
      forbidden:/137|internal-db\.corp\.local|checkout step/,
    },
    {
      name:'unknown-secret key/value diagnostic in attempt.problem',
      task:{status:'failed',live:{heartbeat:new Date(then+3000).toISOString()}},
      attempt:{
        status:'failed',
        started:start,
        ended:new Date(then+4000).toISOString(),
        problem:'UNLISTED_CREDENTIAL_KEY=OPAQUE_SECRET_999',
        execution:{phase:'dispatching',dispatchedAt:start},
      },
      forbidden:/UNLISTED_CREDENTIAL_KEY|OPAQUE_SECRET_999/,
    },
  ];
  for (const item of diagnosticCases) {
    const view=presentProgress(describeProgress(item.task,item.attempt,then+5000));
    assert.equal(view.phase,'failed',item.name);
    assert.equal(view.explanation,'Attempt failed (code: E_ATTEMPT_FAILED). Detailed diagnostics are omitted; review recovery status before retrying.',item.name);
    assert.match(view.announcement,/E_ATTEMPT_FAILED/,item.name);
    assert.doesNotMatch(view.explanation,item.forbidden,item.name);
    assert.doesNotMatch(view.announcement,item.forbidden,item.name);
    assert.doesNotMatch(view.text,item.forbidden,item.name);
    for (const entry of view.rows) {
      assert.doesNotMatch(entry.value,item.forbidden,item.name);
      if (entry.reason!==null) assert.doesNotMatch(entry.reason,item.forbidden,item.name);
    }
  }

  // Non-failure metadata containing quoted JSON keys still redacts secret values cleanly
  const quotedJsonLabel=presentProgress({
    phase:'active',
    status:'Running',
    currentStep:{
      index:1,
      label:'Inspect {"token": "SENSITIVE_VALUE", "api_key": "ANOTHER_SECRET"}',
    },
  });
  assert.doesNotMatch(quotedJsonLabel.text,/SENSITIVE_VALUE|ANOTHER_SECRET/);
  assert.match(rowByKey(quotedJsonLabel,'currentStep').value,/"token":\[redacted\]/);

  // Throwing custom formatLocalTime option falls back safely without leaking error message
  const fallbackClockView=presentProgress({
    phase:'complete',
    complete:true,
    status:'Complete',
    totalKnown:true,
    completedSteps:1,
    totalSteps:1,
    remainingSteps:0,
    percent:100,
    overallEtaMs:0,
    currentStepEtaMs:0,
    projectedCompletionMs:then+1000,
  },{
    formatLocalTime() {
      throw new Error('SECRET_FORMATTER_CRASH');
    },
  });
  assert.doesNotMatch(fallbackClockView.text,/SECRET_FORMATTER_CRASH/);
  assert.match(rowByKey(fallbackClockView,'completion').value,/^Completed at /);
});
