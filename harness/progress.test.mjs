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

test('unknown total work is preserved and model output characters never imply a known total',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};
  const task={
    status:'running',
    live:{
      chars:2400,
      totalChars:5000,
      maxTokens:4096,
      lastActivity:new Date(then+8000).toISOString(),
      heartbeat:new Date(then+9000).toISOString(),
    },
  };
  const state=describeProgress(task,attempt,then+10000);
  assert.equal(state.phase,'active');
  assert.equal(state.waiting,false);
  assert.equal(state.stalled,false);
  assert.equal(state.failed,false);
  assert.equal(state.complete,false);
  assert.equal(state.status,'Receiving output');
  assert.equal(state.totalKnown,false);
  assert.equal(state.completedSteps,null);
  assert.equal(state.totalSteps,null);
  assert.equal(state.remainingSteps,null);
  assert.equal(state.doneTotal,null);
  assert.equal(state.percent,null);
  assert.equal(state.stepRate,null);
  assert.equal(state.overallEtaMs,null);
  assert.equal(state.currentStepEtaMs,null);
  assert.equal(state.projectedCompletionMs,null);
  assert.equal(state.rate,240);
  assert.match(state.eta,/unavailable/i);
  assert.match(state.completion,/unavailable/i);

  const charUnitSteps={
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
  };
  const rejected=describeProgress(charUnitSteps,attempt,then+10000);
  assert.equal(rejected.totalKnown,false);
  assert.equal(rejected.stepSamplesValid,false);
  assert.equal(rejected.percent,null);
  assert.equal(rejected.overallEtaMs,null);
  assert.match(rejected.stepRejectionReason,/character/i);

  const openTotalSteps={
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
  };
  const openState=describeProgress(openTotalSteps,attempt,then+5000);
  assert.equal(openState.totalKnown,false);
  assert.equal(openState.completedSteps,2);
  assert.equal(openState.totalSteps,null);
  assert.equal(openState.remainingSteps,null);
  assert.equal(openState.doneTotal,null);
  assert.equal(openState.percent,null);
  assert.equal(openState.stepRate,0.5);
  assert.equal(openState.overallEtaMs,null);
  assert.equal(openState.projectedCompletionMs,null);
  assert.match(openState.eta,/unknown/i);
});

test('trustworthy measured step counters derive counts, rate, elapsed, separate ETAs and projected completion',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};
  const task={
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
  };
  const state=describeProgress(task,attempt,then+5000);
  assert.equal(state.phase,'active');
  assert.equal(state.waiting,false);
  assert.equal(state.stalled,false);
  assert.equal(state.failed,false);
  assert.equal(state.complete,false);
  assert.equal(state.clockAnomaly,false);
  assert.equal(state.totalKnown,true);
  assert.equal(state.stepSamplesValid,true);
  assert.equal(state.completedSteps,2);
  assert.equal(state.totalSteps,5);
  assert.equal(state.remainingSteps,3);
  assert.equal(state.doneTotal,'2/5');
  assert.equal(state.percent,40);
  assert.equal(state.elapsedMs,5000);
  assert.equal(state.stepRate,0.5);
  assert.equal(state.overallEtaMs,6000);
  assert.equal(state.currentStepEtaMs,1500);
  assert.notEqual(state.currentStepEtaMs,state.overallEtaMs);
  assert.equal(state.currentStep.label,'Run protected checks');
  assert.equal(state.currentStep.doneTotal,'2/8');
  assert.equal(state.currentStep.percent,25);
  assert.equal(state.currentStep.rate,4);
  assert.equal(state.projectedCompletionMs,then+11000);
  assert.equal(state.projectedCompletionAt,new Date(then+11000).toISOString());
  assert.match(state.completion,/projected/i);
  assert.equal(state.heartbeat,then+4800);
  assert.equal(state.heartbeatAgeMs,200);
  assert.equal(state.lastActivity,then+4500);
  assert.equal(state.idleMs,500);

  // When current-step sub-progress is unmeasured, overall ETA remains valid while current-step ETA is unavailable.
  const withoutSubSteps={
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
  };
  const noSub=describeProgress(withoutSubSteps,attempt,then+5000);
  assert.equal(noSub.overallEtaMs,6000);
  assert.equal(noSub.currentStepEtaMs,null);
  assert.equal(noSub.currentStep.label,'Validate patch');
  assert.match(noSub.currentStepEta,/unavailable/i);
  assert.match(noSub.unavailableReasons.currentStepEta,/not measured/i);
});

test('zero measured step rate reports 0 rate without dividing by zero or inventing an ETA',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};
  const task={
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
  };
  const state=describeProgress(task,attempt,then+10000);
  assert.equal(state.phase,'waiting');
  assert.equal(state.waiting,true);
  assert.equal(state.totalKnown,true);
  assert.equal(state.completedSteps,1);
  assert.equal(state.remainingSteps,4);
  assert.equal(state.doneTotal,'1/5');
  assert.equal(state.percent,20);
  assert.equal(state.stepRate,0);
  assert.equal(state.overallEtaMs,null);
  assert.equal(state.projectedCompletionMs,null);
  assert.match(state.eta,/0 steps\/s/i);
  assert.match(state.completion,/0 steps\/s/i);
});

test('insufficient samples allow valid counters without inventing rates or countdowns',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};
  const oneSampleTask={
    status:'running',
    live:{
      lastActivity:new Date(then+3000).toISOString(),
      heartbeat:new Date(then+3000).toISOString(),
      steps:{
        measured:true,
        completed:2,
        total:5,
        samples:[{at:new Date(then+3000).toISOString(),done:2}],
      },
    },
  };
  const oneSample=describeProgress(oneSampleTask,attempt,then+4000);
  assert.equal(oneSample.totalKnown,true);
  assert.equal(oneSample.doneTotal,'2/5');
  assert.equal(oneSample.percent,40);
  assert.equal(oneSample.stepRate,null);
  assert.equal(oneSample.overallEtaMs,null);
  assert.equal(oneSample.projectedCompletionMs,null);
  assert.match(oneSample.eta,/unavailable/i);
  assert.match(oneSample.unavailableReasons.rate,/insufficient/i);

  const zeroSpanTask={
    status:'running',
    live:{
      lastActivity:new Date(then+3000).toISOString(),
      heartbeat:new Date(then+3000).toISOString(),
      steps:{
        measured:true,
        completed:2,
        total:5,
        samples:[
          {at:new Date(then+3000).toISOString(),done:2},
          {at:new Date(then+3000).toISOString(),done:2},
        ],
      },
    },
  };
  const zeroSpan=describeProgress(zeroSpanTask,attempt,then+4000);
  assert.equal(zeroSpan.stepRate,null);
  assert.equal(zeroSpan.overallEtaMs,null);
  assert.equal(zeroSpan.projectedCompletionMs,null);
  assert.match(zeroSpan.unavailableReasons.rate,/positive elapsed/i);
});

test('invalid, regressing, impossible and untrusted step inputs are rejected without inventing percentages or countdowns',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};
  const badCases=[
    {label:'zero total',steps:{completed:0,total:0}},
    {label:'negative total',steps:{completed:1,total:-4}},
    {label:'fractional total',steps:{completed:1,total:3.5}},
    {label:'done exceeds total',steps:{completed:6,total:5,samples:[{at:start,done:1},{at:new Date(then+2000).toISOString(),done:6}]}},
    {label:'regressing sample',steps:{completed:2,total:5,samples:[{at:start,done:2},{at:new Date(then+2000).toISOString(),done:1}]}},
    {label:'completed below latest sample',steps:{completed:1,total:5,samples:[{at:start,done:0},{at:new Date(then+2000).toISOString(),done:2}]}},
    {label:'zero-time jump',steps:{completed:2,total:5,samples:[{at:start,done:1},{at:start,done:2}]}},
    {label:'unmeasured flag',steps:{measured:false,completed:2,total:5,samples:[{at:start,done:0},{at:new Date(then+2000).toISOString(),done:2}]}},
    {label:'estimated flag',steps:{estimated:true,completed:2,total:5}},
    {label:'untrusted source',steps:{source:'heuristic',completed:2,total:5}},
    {label:'non-object steps',steps:['not','an','object']},
  ];

  for (const item of badCases) {
    const state=describeProgress({
      status:'running',
      live:{
        lastActivity:new Date(then+2000).toISOString(),
        heartbeat:new Date(then+2000).toISOString(),
        steps:item.steps,
      },
    },attempt,then+3000);
    assert.equal(state.totalKnown,false,item.label);
    assert.equal(state.stepSamplesValid,false,item.label);
    assert.equal(state.completedSteps,null,item.label);
    assert.equal(state.totalSteps,null,item.label);
    assert.equal(state.remainingSteps,null,item.label);
    assert.equal(state.doneTotal,null,item.label);
    assert.equal(state.percent,null,item.label);
    assert.equal(state.stepRate,null,item.label);
    assert.equal(state.overallEtaMs,null,item.label);
    assert.equal(state.projectedCompletionMs,null,item.label);
    assert.ok(typeof state.stepRejectionReason==='string'&&state.stepRejectionReason.length>0,item.label);
    assert.match(state.eta,/unavailable/i,item.label);
  }
});

test('stalls suppress ETAs and completion projections even when earlier samples had a positive rate',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};
  const task={
    status:'running',
    live:{
      lastActivity:new Date(then+4000).toISOString(),
      heartbeat:new Date(then+63000).toISOString(),
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
  };
  const state=describeProgress(task,attempt,then+65000);
  assert.equal(state.phase,'stalled');
  assert.equal(state.stalled,true);
  assert.equal(state.waiting,false);
  assert.match(state.status,/possibly stalled/i);
  assert.match(state.explanation,/may still be working/i);
  assert.equal(state.doneTotal,'2/5');
  assert.equal(state.percent,40);
  assert.equal(state.stepRate,0.5);
  assert.equal(state.overallEtaMs,null);
  assert.equal(state.currentStepEtaMs,null);
  assert.equal(state.projectedCompletionMs,null);
  assert.match(state.eta,/stalled/i);
  assert.match(state.completion,/stalled/i);
  assert.equal(state.heartbeat,then+63000);
  assert.equal(state.heartbeatAgeMs,2000);
  assert.equal(state.idleMs,61000);
});

test('failures, interruptions, cancellations and premature completion never invent ETAs or 100 percent',()=>{
  const attempt={
    status:'failed',
    started:start,
    ended:new Date(then+7000).toISOString(),
    problem:'Protected check exited with status 1.',
    execution:{phase:'dispatching',dispatchedAt:start},
  };
  const failedTask={
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
  };
  const failed=describeProgress(failedTask,attempt,then+12000);
  assert.equal(failed.phase,'failed');
  assert.equal(failed.failed,true);
  assert.equal(failed.complete,false);
  assert.equal(failed.status,'Attempt failed');
  assert.equal(failed.explanation,'Protected check exited with status 1.');
  assert.equal(failed.elapsedMs,7000);
  assert.equal(failed.doneTotal,'3/5');
  assert.equal(failed.percent,60);
  assert.equal(failed.overallEtaMs,null);
  assert.equal(failed.projectedCompletionMs,null);
  assert.match(failed.eta,/failed/i);
  assert.match(failed.completion,/failed/i);
  assert.equal(progressAnnouncement(failedTask,failed,'connected'),'Attempt failed. Review the problem and recovery status.');

  const premature=describeProgress({
    status:'complete',
    live:{
      complete:true,
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
      },
    },
  },{started:start,execution:{phase:'dispatching',dispatchedAt:start}},then+5000);
  assert.equal(premature.complete,false);
  assert.equal(premature.phase,'failed');
  assert.equal(premature.percent,40);
  assert.equal(premature.overallEtaMs,null);
  assert.match(premature.eta,/remaining steps/i);
});

test('clock anomalies are detected and prevent invalid elapsed time, rates and ETAs',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};

  const badNow=describeProgress({
    status:'running',
    live:{
      chars:50,
      lastActivity:start,
      heartbeat:start,
      steps:{measured:true,completed:1,total:3,samples:[{at:start,done:0},{at:new Date(then+2000).toISOString(),done:1}]},
    },
  },attempt,Number.NaN);
  assert.equal(badNow.clockAnomaly,true);
  assert.equal(badNow.elapsedMs,null);
  assert.equal(badNow.rate,null);
  assert.equal(badNow.stepRate,null);
  assert.equal(badNow.overallEtaMs,null);
  assert.equal(badNow.projectedCompletionMs,null);

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
  assert.equal(backwardSamples.clockAnomaly,true);
  assert.match(backwardSamples.clockAnomalyReason,/backward/i);
  assert.equal(backwardSamples.stepSamplesValid,false);
  assert.equal(backwardSamples.percent,null);
  assert.equal(backwardSamples.overallEtaMs,null);

  const beforeStartSample=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+2000).toISOString(),
      heartbeat:new Date(then+2000).toISOString(),
      steps:{
        measured:true,
        completed:1,
        total:4,
        samples:[
          {at:new Date(then-1000).toISOString(),done:0},
          {at:new Date(then+2000).toISOString(),done:1},
        ],
      },
    },
  },attempt,then+3000);
  assert.equal(beforeStartSample.clockAnomaly,true);
  assert.match(beforeStartSample.clockAnomalyReason,/precedes attempt start/i);
  assert.equal(beforeStartSample.stepSamplesValid,false);

  const invertedLifecycle=describeProgress({
    status:'running',
    live:{chars:10,lastActivity:new Date(then+1000).toISOString(),heartbeat:new Date(then+1000).toISOString()},
  },{
    started:new Date(then+5000).toISOString(),
    execution:{phase:'dispatching',dispatchedAt:new Date(then+2000).toISOString()},
  },then+6000);
  assert.equal(invertedLifecycle.clockAnomaly,true);
  assert.equal(invertedLifecycle.rate,null);
  assert.equal(invertedLifecycle.lastActivity,null);
  assert.equal(invertedLifecycle.elapsedMs,1000);
});

test('completion reports 100 percent, 0 remaining steps, 0 ETA and recorded completion time',()=>{
  const endedAt=new Date(then+8000).toISOString();
  const attempt={
    status:'completed',
    started:start,
    ended:endedAt,
    execution:{phase:'settled',dispatchedAt:start},
  };
  const task={
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
  };
  const state=describeProgress(task,attempt,then+10000);
  assert.equal(state.phase,'complete');
  assert.equal(state.complete,true);
  assert.equal(state.waiting,false);
  assert.equal(state.stalled,false);
  assert.equal(state.failed,false);
  assert.equal(state.status,'Complete');
  assert.equal(state.elapsedMs,8000);
  assert.equal(state.totalKnown,true);
  assert.equal(state.completedSteps,4);
  assert.equal(state.totalSteps,4);
  assert.equal(state.remainingSteps,0);
  assert.equal(state.doneTotal,'4/4');
  assert.equal(state.percent,100);
  assert.equal(state.stepRate,0.5);
  assert.equal(state.overallEtaMs,0);
  assert.equal(state.currentStepEtaMs,0);
  assert.equal(state.projectedCompletionMs,then+8000);
  assert.equal(state.projectedCompletionAt,endedAt);
  assert.match(state.completion,/completed/i);
  assert.equal(progressAnnouncement(task,state,'connected'),'Attempt complete.');
  assert.equal(progressAnnouncement({status:'draft'},null,'connected'),'Waiting for approval.');
});

test('invalid current-step sub-counters, heartbeat-only stalls, and interrupted or cancelled states behave conservatively',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};

  const badSub=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+4000).toISOString(),
      heartbeat:new Date(then+4500).toISOString(),
      steps:{
        measured:true,
        completed:2,
        total:5,
        samples:[
          {at:start,done:0},
          {at:new Date(then+4000).toISOString(),done:2},
        ],
        currentStep:{
          label:'Run tests',
          completed:5,
          total:3,
        },
      },
    },
  },attempt,then+5000);
  assert.equal(badSub.overallEtaMs,6000);
  assert.equal(badSub.currentStepEtaMs,null);
  assert.equal(badSub.currentStep.percent,null);
  assert.match(badSub.currentStepEta,/unavailable/i);

  const heartbeatStall=describeProgress({
    status:'running',
    live:{
      lastActivity:null,
      heartbeat:start,
    },
  },attempt,then+65000);
  assert.equal(heartbeatStall.phase,'stalled');
  assert.equal(heartbeatStall.stalled,true);
  assert.equal(heartbeatStall.heartbeatAgeMs,65000);
  assert.equal(heartbeatStall.overallEtaMs,null);

  const interrupted=describeProgress({
    status:'interrupted',
    recovery:{blocked:true},
    live:{heartbeat:new Date(then+3000).toISOString()},
  },attempt,then+5000);
  assert.equal(interrupted.phase,'interrupted');
  assert.equal(interrupted.overallEtaMs,null);
  assert.match(interrupted.eta,/interrupted/i);

  const cancelled=describeProgress({
    status:'cancelled',
    live:{heartbeat:new Date(then+3000).toISOString()},
  },attempt,then+5000);
  assert.equal(cancelled.phase,'cancelled');
  assert.equal(cancelled.overallEtaMs,null);
  assert.match(cancelled.eta,/cancelled/i);
});
