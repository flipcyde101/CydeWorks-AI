import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_DATE_MS,describeProgress,progressAnnouncement} from './web/progress.js';

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
  assert.match(openState.overallEta,/unknown/i);
  assert.match(openState.eta,/unavailable/i);
  assert.equal(openState.eta,openState.currentStepEta);
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
  assert.equal(state.eta,state.currentStepEta);
  assert.notEqual(state.eta,state.overallEta);
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

  // When current-step sub-progress is unmeasured, overall ETA remains valid while current-step ETA (progress.eta) is unavailable.
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
  assert.match(noSub.overallEta,/6\.0 s/i);
  assert.equal(noSub.currentStepEtaMs,null);
  assert.equal(noSub.currentStep.label,'Validate patch');
  assert.match(noSub.currentStepEta,/unavailable/i);
  assert.equal(noSub.eta,noSub.currentStepEta);
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
  assert.match(state.overallEta,/0 steps\/s/i);
  assert.match(state.eta,/unavailable/i);
  assert.equal(state.eta,state.currentStepEta);
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

test('authoritative status prevents done equal to total from declaring completion, missing ended is not invented, and 99999/100000 never rounds to 100',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};

  const runningAllSteps=describeProgress({
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
      },
    },
  },attempt,then+6000);
  assert.equal(runningAllSteps.complete,false);
  assert.equal(runningAllSteps.phase,'waiting');
  assert.equal(runningAllSteps.status,'Waiting for completion');
  assert.equal(runningAllSteps.doneTotal,'5/5');
  assert.equal(runningAllSteps.percent,100);
  assert.equal(runningAllSteps.overallEtaMs,null);
  assert.equal(runningAllSteps.currentStepEtaMs,null);
  assert.equal(runningAllSteps.projectedCompletionMs,null);
  assert.match(runningAllSteps.overallEta,/completion/i);

  const failedAllSteps=describeProgress({
    status:'failed',
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
      },
    },
  },attempt,then+6000);
  assert.equal(failedAllSteps.complete,false);
  assert.equal(failedAllSteps.failed,true);
  assert.equal(failedAllSteps.phase,'failed');
  assert.equal(failedAllSteps.overallEtaMs,null);
  assert.equal(failedAllSteps.projectedCompletionMs,null);

  const completeWithoutEnded=describeProgress({
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
  assert.equal(completeWithoutEnded.complete,true);
  assert.equal(completeWithoutEnded.phase,'complete');
  assert.equal(completeWithoutEnded.projectedCompletionMs,null);
  assert.equal(completeWithoutEnded.projectedCompletionAt,null);
  assert.equal(completeWithoutEnded.elapsedMs,null);
  assert.match(completeWithoutEnded.completion,/not recorded/i);
  assert.match(completeWithoutEnded.unavailableReasons.completion,/not recorded/i);

  const nearlyComplete=describeProgress({
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
  assert.equal(nearlyComplete.doneTotal,'99999/100000');
  assert.equal(nearlyComplete.percent,99.99);
  assert.ok(nearlyComplete.percent<100);
  assert.equal(nearlyComplete.complete,false);
});

test('clock anomalies suppress all ETAs and projections, validate current-step samples against step start, and guard Date overflow',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};

  const futureActivityWithValidSteps=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+120000).toISOString(),
      heartbeat:new Date(then+4000).toISOString(),
      steps:{
        measured:true,
        completed:2,
        total:5,
        samples:[
          {at:start,done:0},
          {at:new Date(then+4000).toISOString(),done:2},
        ],
        currentStep:{
          label:'Run step 3',
          startedAt:new Date(then+4000).toISOString(),
          measured:true,
          completed:1,
          total:2,
          samples:[
            {at:new Date(then+4000).toISOString(),done:0},
            {at:new Date(then+4500).toISOString(),done:1},
          ],
        },
      },
    },
  },attempt,then+5000);
  assert.equal(futureActivityWithValidSteps.clockAnomaly,true);
  assert.equal(futureActivityWithValidSteps.overallEtaMs,null);
  assert.equal(futureActivityWithValidSteps.currentStepEtaMs,null);
  assert.equal(futureActivityWithValidSteps.eta,futureActivityWithValidSteps.currentStepEta);
  assert.equal(futureActivityWithValidSteps.projectedCompletionMs,null);
  assert.match(futureActivityWithValidSteps.overallEta,/clock anomaly/i);
  assert.match(futureActivityWithValidSteps.currentStepEta,/clock anomaly/i);
  assert.match(futureActivityWithValidSteps.completion,/clock anomaly/i);

  const subSampleBeforeStepStart=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+5000).toISOString(),
      heartbeat:new Date(then+5000).toISOString(),
      steps:{
        measured:true,
        completed:2,
        total:5,
        samples:[
          {at:start,done:0},
          {at:new Date(then+4000).toISOString(),done:2},
        ],
        currentStep:{
          label:'Run step 3',
          startedAt:new Date(then+4000).toISOString(),
          measured:true,
          completed:1,
          total:2,
          samples:[
            {at:new Date(then+3000).toISOString(),done:0},
            {at:new Date(then+4500).toISOString(),done:1},
          ],
        },
      },
    },
  },attempt,then+5000);
  assert.equal(subSampleBeforeStepStart.clockAnomaly,true);
  assert.match(subSampleBeforeStepStart.clockAnomalyReason,/current step start/i);
  assert.equal(subSampleBeforeStepStart.currentStepEtaMs,null);
  assert.equal(subSampleBeforeStepStart.overallEtaMs,null);
  assert.equal(subSampleBeforeStepStart.projectedCompletionMs,null);

  const nearMaxNow=MAX_DATE_MS-1000;
  const nearMaxStart=MAX_DATE_MS-5000;
  const overflowProjection=describeProgress({
    status:'running',
    live:{
      lastActivity:nearMaxNow-500,
      heartbeat:nearMaxNow-200,
      steps:{
        measured:true,
        completed:2,
        total:5,
        samples:[
          {at:nearMaxStart,done:0},
          {at:nearMaxNow-1000,done:2},
        ],
      },
    },
  },{started:nearMaxStart,execution:{phase:'dispatching',dispatchedAt:nearMaxStart}},nearMaxNow);
  assert.equal(overflowProjection.clockAnomaly,false);
  // Sample window spans (MAX_DATE_MS - 2000) - (MAX_DATE_MS - 5000) = 3000 ms for 2 steps; 3 remaining steps => 4500 ms.
  assert.equal(overflowProjection.overallEtaMs,4500);
  assert.equal(overflowProjection.projectedCompletionMs,null);
  assert.equal(overflowProjection.projectedCompletionAt,null);
  assert.match(overflowProjection.completion,/calendar range/i);
  assert.match(overflowProjection.unavailableReasons.completion,/calendar range/i);

  const outOfRangeNow=describeProgress({
    status:'running',
    live:{
      lastActivity:MAX_DATE_MS,
      heartbeat:MAX_DATE_MS,
    },
  },{started:MAX_DATE_MS-1000},MAX_DATE_MS+1);
  assert.equal(outOfRangeNow.clockAnomaly,true);
  assert.equal(outOfRangeNow.projectedCompletionMs,null);
  assert.equal(outOfRangeNow.projectedCompletionAt,null);
  assert.equal(outOfRangeNow.heartbeatAt,null);
  assert.equal(outOfRangeNow.lastActivityAt,null);
});

test('stall detection considers valid work samples without treating heartbeat as work, and stale samples expire ETAs',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};

  // Recent valid work sample prevents false stall even if lastActivity is older than 60s.
  const activeWorkRecentSample=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+1000).toISOString(),
      heartbeat:new Date(then+63000).toISOString(),
      steps:{
        measured:true,
        completed:2,
        total:5,
        samples:[
          {at:start,done:0},
          {at:new Date(then+55000).toISOString(),done:2},
        ],
      },
    },
  },attempt,then+65000);
  assert.equal(activeWorkRecentSample.stalled,false);
  assert.equal(activeWorkRecentSample.phase,'active');
  assert.equal(activeWorkRecentSample.overallEtaMs,82500);

  // Fresh heartbeat alone does not prevent a stall when measured work samples are >= 60s old and output is absent.
  const heartbeatMasksNoWork=describeProgress({
    status:'running',
    live:{
      lastActivity:null,
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
  assert.equal(heartbeatMasksNoWork.stalled,true);
  assert.equal(heartbeatMasksNoWork.phase,'stalled');
  assert.equal(heartbeatMasksNoWork.overallEtaMs,null);
  assert.equal(heartbeatMasksNoWork.projectedCompletionMs,null);

  // Active streaming output avoids output stall, but stale step samples must still invalidate ETA and completion projection.
  const activeOutputStaleSamples=describeProgress({
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
  assert.equal(activeOutputStaleSamples.stalled,false);
  assert.equal(activeOutputStaleSamples.overallEtaMs,null);
  assert.equal(activeOutputStaleSamples.currentStepEtaMs,null);
  assert.equal(activeOutputStaleSamples.projectedCompletionMs,null);
  assert.match(activeOutputStaleSamples.overallEta,/stale/i);
  assert.match(activeOutputStaleSamples.currentStepEta,/stale/i);
  assert.match(activeOutputStaleSamples.completion,/stale/i);
});

test('current-step work activity prevents false stalls, updates latest activity and preserves current-step ETA while keeping heartbeat distinct',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};

  const activeCurrentStepWork=describeProgress({
    status:'running',
    live:{
      chars:20,
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
        currentStep:{
          label:'Verify checks',
          startedAt:new Date(then+4000).toISOString(),
          measured:true,
          completed:3,
          total:4,
          samples:[
            {at:new Date(then+4000).toISOString(),done:0},
            {at:new Date(then+64000).toISOString(),done:3},
          ],
        },
      },
    },
  },attempt,then+65000);
  assert.equal(activeCurrentStepWork.stalled,false);
  assert.equal(activeCurrentStepWork.phase,'active');
  assert.equal(activeCurrentStepWork.status,'Running step 3 of 5');
  assert.equal(activeCurrentStepWork.lastActivity,then+64000);
  assert.equal(activeCurrentStepWork.lastActivityAt,new Date(then+64000).toISOString());
  assert.equal(activeCurrentStepWork.idleMs,1000);
  assert.equal(activeCurrentStepWork.currentStepEtaMs,20000);
  assert.equal(activeCurrentStepWork.eta,activeCurrentStepWork.currentStepEta);
  assert.equal(activeCurrentStepWork.overallEtaMs,null);
  assert.match(activeCurrentStepWork.overallEta,/stale/i);

  // Without recent current-step work, a fresh heartbeat alone still does not mask a stall or advance lastActivity.
  const heartbeatOnly=describeProgress({
    status:'running',
    live:{
      chars:20,
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
        currentStep:{
          label:'Verify checks',
          startedAt:new Date(then+4000).toISOString(),
          measured:true,
          completed:0,
          total:4,
          samples:[
            {at:new Date(then+4000).toISOString(),done:0},
          ],
        },
      },
    },
  },attempt,then+65000);
  assert.equal(heartbeatOnly.stalled,true);
  assert.equal(heartbeatOnly.phase,'stalled');
  assert.equal(heartbeatOnly.lastActivity,then+4000);
  assert.equal(heartbeatOnly.idleMs,61000);
  assert.equal(heartbeatOnly.heartbeatAgeMs,1000);
  assert.equal(heartbeatOnly.currentStepEtaMs,null);
  assert.equal(heartbeatOnly.overallEtaMs,null);
});

test('inconsistent chronology rejects ended before dispatched and samples after ended without displaying impossible completion',()=>{
  const endedBeforeDispatch=describeProgress({
    status:'review',
    live:{
      chars:120,
      lastActivity:new Date(then+3000).toISOString(),
      heartbeat:new Date(then+3000).toISOString(),
      steps:{
        measured:true,
        completed:2,
        total:2,
        samples:[
          {at:new Date(then+2000).toISOString(),done:0},
          {at:new Date(then+3000).toISOString(),done:2},
        ],
      },
    },
  },{
    status:'completed',
    started:start,
    ended:new Date(then+1000).toISOString(),
    execution:{phase:'settled',dispatchedAt:new Date(then+2000).toISOString()},
  },then+5000);
  assert.equal(endedBeforeDispatch.clockAnomaly,true);
  assert.equal(endedBeforeDispatch.elapsedMs,null);
  assert.equal(endedBeforeDispatch.rate,null);
  assert.equal(endedBeforeDispatch.stepRate,null);
  assert.equal(endedBeforeDispatch.stepSamplesValid,false);
  assert.equal(endedBeforeDispatch.overallEtaMs,null);
  assert.equal(endedBeforeDispatch.currentStepEtaMs,null);
  assert.equal(endedBeforeDispatch.projectedCompletionMs,null);
  assert.equal(endedBeforeDispatch.projectedCompletionAt,null);
  assert.match(endedBeforeDispatch.completion,/clock anomaly/i);

  const samplesAfterEnded=describeProgress({
    status:'review',
    live:{
      lastActivity:new Date(then+2000).toISOString(),
      heartbeat:new Date(then+2000).toISOString(),
      steps:{
        measured:true,
        completed:2,
        total:2,
        samples:[
          {at:new Date(then+1000).toISOString(),done:0},
          {at:new Date(then+3000).toISOString(),done:2},
        ],
      },
    },
  },{
    status:'completed',
    started:start,
    ended:new Date(then+2000).toISOString(),
    execution:{phase:'settled',dispatchedAt:new Date(then+1000).toISOString()},
  },then+5000);
  assert.equal(samplesAfterEnded.clockAnomaly,true);
  assert.match(samplesAfterEnded.clockAnomalyReason,/after completion/i);
  assert.equal(samplesAfterEnded.stepSamplesValid,false);
  assert.equal(samplesAfterEnded.stepRate,null);
  assert.equal(samplesAfterEnded.elapsedMs,null);
  assert.equal(samplesAfterEnded.projectedCompletionMs,null);
  assert.equal(samplesAfterEnded.projectedCompletionAt,null);
  assert.match(samplesAfterEnded.completion,/clock anomaly/i);
});

test('progressAnnouncement agrees with conservative incomplete termination for complete and review snapshots',()=>{
  const attempt={started:start,execution:{phase:'settled',dispatchedAt:start}};

  const partialCompleteTask={
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
  };
  const partialCompleteState=describeProgress(partialCompleteTask,attempt,then+5000);
  assert.equal(partialCompleteState.status,'Incomplete termination');
  assert.equal(partialCompleteState.failed,true);
  const announcedWithState=progressAnnouncement(partialCompleteTask,partialCompleteState,'connected');
  assert.match(announcedWithState,/incomplete termination/i);
  assert.match(announcedWithState,/3 of 5 steps remaining/i);
  assert.doesNotMatch(announcedWithState,/attempt complete|ready for review/i);

  const announcedWithoutState=progressAnnouncement(partialCompleteTask,null,'connected');
  assert.match(announcedWithoutState,/incomplete termination/i);
  assert.match(announcedWithoutState,/3 of 5 steps remaining/i);
  assert.doesNotMatch(announcedWithoutState,/attempt complete|ready for review/i);

  const partialReviewTask={
    status:'review',
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
      },
    },
  };
  const partialReviewState=describeProgress(partialReviewTask,attempt,then+5000);
  assert.equal(partialReviewState.status,'Incomplete termination');
  assert.equal(partialReviewState.failed,true);
  const reviewWithState=progressAnnouncement(partialReviewTask,partialReviewState,'connected');
  assert.match(reviewWithState,/incomplete termination/i);
  assert.match(reviewWithState,/3 of 5 steps remaining/i);
  assert.doesNotMatch(reviewWithState,/ready for review/i);

  const reviewWithoutState=progressAnnouncement(partialReviewTask,null,'connected');
  assert.match(reviewWithoutState,/incomplete termination/i);
  assert.match(reviewWithoutState,/3 of 5 steps remaining/i);
  assert.doesNotMatch(reviewWithoutState,/ready for review/i);
});

test('declared completion with missing overall done or partial current-step counters never renders zero remaining work',()=>{
  const attempt={started:start,status:'completed',execution:{phase:'settled',dispatchedAt:start}};

  const missingOverallDoneTask={
    status:'complete',
    live:{
      complete:true,
      lastActivity:new Date(then+4000).toISOString(),
      heartbeat:new Date(then+4000).toISOString(),
      steps:{
        measured:true,
        total:5,
        currentStep:'Finalize',
      },
    },
  };
  const missingDoneState=describeProgress(missingOverallDoneTask,attempt,then+5000);
  assert.equal(missingDoneState.complete,true);
  assert.equal(missingDoneState.failed,false);
  assert.equal(missingDoneState.phase,'complete');
  assert.equal(missingDoneState.totalKnown,true);
  assert.equal(missingDoneState.totalSteps,5);
  assert.equal(missingDoneState.completedSteps,null);
  assert.equal(missingDoneState.remainingSteps,null);
  assert.equal(missingDoneState.doneTotal,null);
  assert.equal(missingDoneState.percent,null);
  assert.doesNotMatch(missingDoneState.remaining,/0 of 5|no remaining work/i);
  assert.match(missingDoneState.remaining,/not recorded/i);
  assert.equal(missingDoneState.overallEtaMs,null);
  assert.equal(missingDoneState.currentStepEtaMs,null);
  assert.equal(missingDoneState.currentStep.etaMs,null);
  assert.equal(missingDoneState.eta,missingDoneState.currentStepEta);
  assert.doesNotMatch(missingDoneState.overallEta,/no remaining|0\s*s/i);
  assert.match(missingDoneState.overallEta,/not recorded/i);
  assert.doesNotMatch(missingDoneState.currentStepEta,/no remaining work/i);
  assert.match(missingDoneState.unavailableReasons.overallEta,/not recorded/i);
  assert.match(missingDoneState.unavailableReasons.currentStepEta,/not recorded/i);

  const missingDoneNoSubState=describeProgress({
    status:'review',
    live:{
      steps:{
        measured:true,
        total:5,
      },
    },
  },attempt,then+5000);
  assert.equal(missingDoneNoSubState.complete,true);
  assert.equal(missingDoneNoSubState.phase,'complete');
  assert.equal(missingDoneNoSubState.status,'Complete, ready for review');
  assert.equal(missingDoneNoSubState.totalSteps,5);
  assert.equal(missingDoneNoSubState.completedSteps,null);
  assert.equal(missingDoneNoSubState.remainingSteps,null);
  assert.equal(missingDoneNoSubState.percent,null);
  assert.doesNotMatch(missingDoneNoSubState.remaining,/0 of 5|no remaining work/i);
  assert.match(missingDoneNoSubState.remaining,/not recorded/i);
  assert.equal(missingDoneNoSubState.overallEtaMs,null);
  assert.equal(missingDoneNoSubState.currentStepEtaMs,null);
  assert.doesNotMatch(missingDoneNoSubState.currentStepEta,/no remaining work/i);
  assert.match(missingDoneNoSubState.unavailableReasons.overallEta,/not recorded/i);
  assert.match(missingDoneNoSubState.unavailableReasons.currentStepEta,/not recorded/i);

  const partialSubCompleteTask={
    status:'complete',
    live:{
      complete:true,
      lastActivity:new Date(then+4000).toISOString(),
      heartbeat:new Date(then+4000).toISOString(),
      steps:{
        measured:true,
        completed:5,
        total:5,
        samples:[
          {at:start,done:0},
          {at:new Date(then+4000).toISOString(),done:5},
        ],
        currentStep:{
          label:'Verify',
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
  };
  const partialSubState=describeProgress(partialSubCompleteTask,attempt,then+5000);
  assert.equal(partialSubState.complete,false);
  assert.equal(partialSubState.failed,true);
  assert.equal(partialSubState.phase,'failed');
  assert.equal(partialSubState.status,'Incomplete termination');
  assert.equal(partialSubState.doneTotal,'5/5');
  assert.equal(partialSubState.currentStep.completed,1);
  assert.equal(partialSubState.currentStep.total,4);
  assert.equal(partialSubState.currentStep.remaining,3);
  assert.equal(partialSubState.currentStep.doneTotal,'1/4');
  assert.equal(partialSubState.currentStep.etaMs,null);
  assert.equal(partialSubState.currentStepEtaMs,null);
  assert.equal(partialSubState.overallEtaMs,null);
  assert.equal(partialSubState.projectedCompletionMs,null);
  assert.equal(partialSubState.eta,partialSubState.currentStepEta);
  assert.doesNotMatch(partialSubState.currentStepEta,/no remaining work/i);
  assert.doesNotMatch(partialSubState.currentStep.eta,/no remaining work/i);
  assert.match(partialSubState.remaining,/3 of 4/);
  const partialSubAnnounced=progressAnnouncement(partialSubCompleteTask,partialSubState,'connected');
  assert.match(partialSubAnnounced,/incomplete termination/i);
  assert.match(partialSubAnnounced,/3 of 4/);
  assert.doesNotMatch(partialSubAnnounced,/attempt complete|ready for review/i);
  const partialSubAnnouncedNoState=progressAnnouncement(partialSubCompleteTask,null,'connected');
  assert.match(partialSubAnnouncedNoState,/incomplete termination/i);
  assert.match(partialSubAnnouncedNoState,/3 of 4/);
  assert.doesNotMatch(partialSubAnnouncedNoState,/attempt complete|ready for review/i);

  const partialSubReviewTask={...partialSubCompleteTask,status:'review'};
  const partialSubReviewAnnounced=progressAnnouncement(partialSubReviewTask,null,'connected');
  assert.match(partialSubReviewAnnounced,/incomplete termination/i);
  assert.match(partialSubReviewAnnounced,/3 of 4/);
  assert.doesNotMatch(partialSubReviewAnnounced,/ready for review/i);

  const missingSubDoneState=describeProgress({
    status:'complete',
    live:{
      complete:true,
      steps:{
        measured:true,
        completed:5,
        total:5,
        currentStep:{
          label:'Verify',
          measured:true,
          total:4,
        },
      },
    },
  },attempt,then+5000);
  assert.equal(missingSubDoneState.complete,true);
  assert.equal(missingSubDoneState.overallEtaMs,0);
  assert.equal(missingSubDoneState.currentStep.remaining,null);
  assert.equal(missingSubDoneState.currentStep.etaMs,null);
  assert.equal(missingSubDoneState.currentStepEtaMs,null);
  assert.doesNotMatch(missingSubDoneState.currentStepEta,/no remaining work/i);
  assert.match(missingSubDoneState.unavailableReasons.currentStepEta,/missing/i);
});

test('positive sub-millisecond estimates round up to 1 ms while reserving 0 ETA strictly for zero remaining work',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};

  const subMsOverall=describeProgress({
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
        currentStep:{
          label:'Final item',
          startedAt:start,
          measured:true,
          completed:99999,
          total:100000,
          samples:[
            {at:start,done:0},
            {at:new Date(then+10000).toISOString(),done:99999},
          ],
        },
      },
    },
  },attempt,then+10000);
  assert.equal(subMsOverall.overallEtaMs,1);
  assert.equal(subMsOverall.overallEta,'1 ms');
  assert.equal(subMsOverall.projectedCompletionMs,then+10001);
  assert.equal(subMsOverall.projectedCompletionAt,new Date(then+10001).toISOString());
  assert.match(subMsOverall.completion,/in 1 ms/i);
  assert.equal(subMsOverall.currentStepEtaMs,1);
  assert.equal(subMsOverall.currentStep.etaMs,1);
  assert.equal(subMsOverall.currentStepEta,'1 ms');
  assert.equal(subMsOverall.eta,'1 ms');

  // Actual zero remaining sub-steps while running still yields 0 currentStepEtaMs.
  const zeroSubRemaining=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+5000).toISOString(),
      heartbeat:new Date(then+5000).toISOString(),
      steps:{
        measured:true,
        completed:2,
        total:5,
        samples:[
          {at:start,done:0},
          {at:new Date(then+4000).toISOString(),done:2},
        ],
        currentStep:{
          label:'Completed sub-phase',
          startedAt:new Date(then+4000).toISOString(),
          measured:true,
          completed:4,
          total:4,
        },
      },
    },
  },attempt,then+5000);
  assert.equal(zeroSubRemaining.currentStepEtaMs,0);
  assert.equal(zeroSubRemaining.currentStep.eta,'Current step complete.');

  // Overflow protection still blocks projectedCompletionMs when validNow + 1 ms exceeds MAX_DATE_MS.
  const subMsOverflow=describeProgress({
    status:'running',
    live:{
      lastActivity:MAX_DATE_MS,
      heartbeat:MAX_DATE_MS,
      steps:{
        measured:true,
        completed:99999,
        total:100000,
        samples:[
          {at:MAX_DATE_MS-10000,done:0},
          {at:MAX_DATE_MS,done:99999},
        ],
      },
    },
  },{started:MAX_DATE_MS-10000,execution:{phase:'dispatching',dispatchedAt:MAX_DATE_MS-10000}},MAX_DATE_MS);
  assert.equal(subMsOverflow.overallEtaMs,1);
  assert.equal(subMsOverflow.projectedCompletionMs,null);
  assert.match(subMsOverflow.completion,/calendar range/i);
});

test('allowlisted measured units are preserved without mislabeling non-step counters as steps and unsafe units are rejected',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};

  const filesTask={
    status:'running',
    live:{
      lastActivity:new Date(then+4000).toISOString(),
      heartbeat:new Date(then+4500).toISOString(),
      steps:{
        measured:true,
        unit:'Files',
        completed:2,
        total:5,
        samples:[
          {at:start,done:0},
          {at:new Date(then+4000).toISOString(),done:2},
        ],
        currentStep:{
          label:'Run checks',
          startedAt:new Date(then+3000).toISOString(),
          measured:true,
          unit:'checks',
          completed:1,
          total:4,
          samples:[
            {at:new Date(then+3000).toISOString(),done:0},
            {at:new Date(then+4000).toISOString(),done:1},
          ],
        },
      },
    },
  };
  const filesState=describeProgress(filesTask,attempt,then+5000);
  assert.equal(filesState.unit,'files');
  assert.equal(filesState.unitSingular,'file');
  assert.equal(filesState.status,'Running file 3 of 5');
  assert.match(filesState.explanation,/2 of 5 files complete/i);
  assert.doesNotMatch(filesState.explanation,/\bsteps?\b/i);
  assert.match(filesState.remaining,/3 of 5 files remaining/i);
  assert.doesNotMatch(filesState.remaining,/\bsteps?\b/i);
  assert.equal(filesState.currentStep.unit,'checks');
  assert.equal(filesState.currentStep.unitSingular,'check');
  assert.equal(filesState.overallEtaMs,6000);
  assert.equal(filesState.currentStepEtaMs,3000);

  const zeroFilesRate=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+10000).toISOString(),
      heartbeat:new Date(then+10000).toISOString(),
      steps:{
        measured:true,
        unit:'files',
        completed:1,
        total:5,
        samples:[
          {at:start,done:1},
          {at:new Date(then+10000).toISOString(),done:1},
        ],
      },
    },
  },attempt,then+10000);
  assert.equal(zeroFilesRate.unit,'files');
  assert.match(zeroFilesRate.overallEta,/0 files\/s/i);
  assert.doesNotMatch(zeroFilesRate.overallEta,/steps\/s/i);
  assert.match(zeroFilesRate.completion,/0 files\/s/i);

  const prematureFiles={
    status:'complete',
    live:{
      complete:true,
      steps:{
        measured:true,
        unit:'files',
        completed:2,
        total:5,
      },
    },
  };
  const prematureFilesState=describeProgress(prematureFiles,attempt,then+5000);
  assert.equal(prematureFilesState.status,'Incomplete termination');
  assert.match(prematureFilesState.explanation,/measured files finished/i);
  assert.match(prematureFilesState.remaining,/3 of 5 files remaining/i);
  assert.doesNotMatch(prematureFilesState.remaining,/\bsteps?\b/i);
  assert.match(prematureFilesState.overallEta,/remaining files/i);
  assert.match(progressAnnouncement(prematureFiles,prematureFilesState,'connected'),/3 of 5 files remaining/i);
  assert.match(progressAnnouncement(prematureFiles,null,'connected'),/3 of 5 files remaining/i);

  const prematureChecksSub={
    status:'complete',
    live:{
      complete:true,
      steps:{
        measured:true,
        unit:'files',
        completed:5,
        total:5,
        currentStep:{
          label:'Run checks',
          measured:true,
          unit:'checks',
          completed:1,
          total:4,
        },
      },
    },
  };
  const prematureChecksState=describeProgress(prematureChecksSub,attempt,then+5000);
  assert.equal(prematureChecksState.status,'Incomplete termination');
  assert.match(prematureChecksState.remaining,/3 of 4 current-step checks remaining/i);
  assert.match(progressAnnouncement(prematureChecksSub,null,'connected'),/3 of 4 current-step checks remaining/i);

  const invalidUnits=['tokens','utf-16','bytes','<script>files</script>','files/sec','excessively-long-unbounded-unit-name','widgets'];
  for (const badUnit of invalidUnits) {
    const rejected=describeProgress({
      status:'running',
      live:{
        steps:{
          measured:true,
          unit:badUnit,
          completed:1,
          total:5,
        },
      },
    },attempt,then+5000);
    assert.equal(rejected.totalKnown,false,badUnit);
    assert.equal(rejected.stepSamplesValid,false,badUnit);
    assert.equal(rejected.unit,null,badUnit);
    assert.equal(rejected.unitSingular,null,badUnit);
    assert.equal(rejected.overallEtaMs,null,badUnit);
    assert.ok(typeof rejected.stepRejectionReason==='string'&&rejected.stepRejectionReason.length>0,badUnit);
  }

  const badSubUnit=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+4000).toISOString(),
      heartbeat:new Date(then+4500).toISOString(),
      steps:{
        measured:true,
        unit:'files',
        completed:2,
        total:5,
        samples:[
          {at:start,done:0},
          {at:new Date(then+4000).toISOString(),done:2},
        ],
        currentStep:{
          label:'Verify',
          unit:'<img onerror=1>',
          completed:1,
          total:3,
        },
      },
    },
  },attempt,then+5000);
  assert.equal(badSubUnit.unit,'files');
  assert.equal(badSubUnit.overallEtaMs,6000);
  assert.equal(badSubUnit.currentStep.unit,null);
  assert.equal(badSubUnit.currentStep.unitSingular,null);
  assert.equal(badSubUnit.currentStepEtaMs,null);
  assert.doesNotMatch(badSubUnit.currentStepEta,/<img/i);
});
