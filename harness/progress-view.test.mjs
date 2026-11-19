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
  assert.doesNotMatch(rowByKey(waitingView,'rate').value,/supplied/i);
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
  assert.equal(rowByKey(streamView,'completed').value,'Unavailable (2400 UTF-16 code units received; work counts unmeasured)');
  assert.equal(rowByKey(streamView,'output').value,'2400 UTF-16 code units (total unknown)');
  assert.equal(rowByKey(streamView,'rate').value,'240.0 UTF-16 code units/s');
  assert.doesNotMatch(streamView.text,/\bcharacters(?:\/s)?\b|measured rate unavailable|supplied/i);
  assert.match(rowByKey(streamView,'remaining').value,/unknown/i);
  assert.match(rowByKey(streamView,'overallEta').value,/unknown/i);
  assert.match(rowByKey(streamView,'completion').value,/unavailable/i);
  assert.doesNotMatch(streamView.text,/\d+%|projected around/i);

  // Open-total measured work (completed known, total null)
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
  const openHasUnit='unit' in openSteps;
  const openExpectedUnit=openHasUnit ? 'steps' : 'units';
  assert.equal(openView.counts.completedSteps,2);
  assert.equal(openView.counts.totalKnown,false);
  assert.equal(openView.counts.unit,openHasUnit ? 'steps' : null);
  assert.equal(openView.counts.unitSingular,openHasUnit ? 'step' : null);
  assert.equal(openView.counts.percent,null);
  assert.equal(rowByKey(openView,'completed').value,`2 ${openExpectedUnit} completed (total unknown)`);
  assert.match(rowByKey(openView,'remaining').value,/unknown/i);
  assert.equal(rowByKey(openView,'rate').value,`0.5 ${openExpectedUnit}/s`);
  assert.match(rowByKey(openView,'overallEta').value,/unknown/i);
  assert.match(rowByKey(openView,'completion').value,/unavailable/i);
  assert.doesNotMatch(openView.text,/\d+%|projected around/i);

  // Rejected character-unit steps preserve rejection reason while keeping UTF-16 code-unit rate
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
  assert.equal(rejectedView.counts.unit,null);
  assert.equal(rejectedView.counts.unitSingular,null);
  assert.match(rowByKey(rejectedView,'completed').value,/character/i);
  assert.match(rowByKey(rejectedView,'rate').value,/240\.0 UTF-16 code units\/s.*rejected/i);
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
  const stateHasUnit='unit' in state;
  const stateExpectedUnit=stateHasUnit ? 'steps' : 'units';
  const stateExpectedSubUnit=stateHasUnit ? 'sub-steps' : 'units';
  assert.equal(view.available,true);
  assert.equal(view.phase,'active');
  assert.equal(view.stateLabel,'Running');
  assert.equal(view.counts.doneTotal,'2/5');
  assert.equal(view.counts.unit,stateHasUnit ? 'steps' : null);
  assert.equal(view.counts.unitSingular,stateHasUnit ? 'step' : null);
  assert.equal(view.counts.percent,40);

  const hasOrdinalStatus=/^Running step \d+ of \d+$/i.test(state.status);
  const expectedStatus=hasOrdinalStatus
    ? 'Running step 3 of 5'
    : 'Running protected checks (2 of 5 steps complete)';
  assert.equal(rowByKey(view,'status').value,expectedStatus);
  assert.doesNotMatch(rowByKey(view,'status').value,/\bRunning\s+Run\b/i);
  assert.equal(rowByKey(view,'currentStep').value,`Step 3: Run protected checks (2/8, 25%; 4 ${stateExpectedSubUnit}/s)`);
  assert.equal(rowByKey(view,'completed').value,`2 of 5 ${stateExpectedUnit} (2/5, 40%)`);
  assert.equal(rowByKey(view,'remaining').value,`3 of 5 ${stateExpectedUnit} remaining`);
  assert.equal(rowByKey(view,'rate').value,`0.5 ${stateExpectedUnit}/s (current step: 4 ${stateExpectedSubUnit}/s)`);
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
  assert.equal(view.announcement,`${expectedStatus} (2/5). ${view.explanation}`);
  assert.doesNotMatch(view.announcement,/\bRunning\s+Run\b/i);

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
  const nearlyUnit='unit' in nearlyDone ? 'steps' : 'units';
  assert.equal(rowByKey(nearlyView,'currentStep').value,'Unavailable (current step not reported)');
  assert.equal(rowByKey(nearlyView,'rate').value,`9999.9 ${nearlyUnit}/s`);
  assert.equal(rowByKey(nearlyView,'completed').value,`99999 of 100000 ${nearlyUnit} (99999/100000, 99.99%)`);
  assert.doesNotMatch(rowByKey(nearlyView,'completed').value,/100%/);

  // Inconsistent supplied percentages are overridden by counter-derived percent and incomplete work never formats as 100%
  const inconsistentPercentView=presentProgress({
    phase:'active',
    status:'Running step 1 of 5',
    totalKnown:true,
    completedSteps:1,
    totalSteps:5,
    remainingSteps:4,
    percent:99.999,
    currentStep:{
      index:1,
      label:'Scan workspace',
      completed:1,
      total:5,
      remaining:4,
      percent:99.999,
    },
  },{formatLocalTime:fixedClock});
  assert.equal(inconsistentPercentView.counts.percent,20);
  assert.equal(rowByKey(inconsistentPercentView,'completed').value,'1 of 5 units (1/5, 20%)');
  assert.equal(rowByKey(inconsistentPercentView,'currentStep').value,'Step 1: Scan workspace (1/5, 20%)');
  assert.doesNotMatch(inconsistentPercentView.text,/100%|99\.999/);

  const extremeIncompletePercentView=presentProgress({
    phase:'active',
    status:'Running',
    totalKnown:true,
    completedSteps:999999,
    totalSteps:1000000,
    remainingSteps:1,
    percent:100,
    currentStep:{
      index:1,
      label:'Verify batch',
      completed:999999,
      total:1000000,
      remaining:1,
      percent:99.9999,
    },
  });
  assert.equal(extremeIncompletePercentView.counts.percent,99.99);
  assert.equal(rowByKey(extremeIncompletePercentView,'completed').value,'999999 of 1000000 units (999999/1000000, 99.99%)');
  assert.equal(rowByKey(extremeIncompletePercentView,'currentStep').value,'Step 1: Verify batch (999999/1000000, 99.99%)');
  assert.doesNotMatch(extremeIncompletePercentView.text,/100%/);

  // Measured non-step units (e.g. files / checks) use validated contract units when emitted by describeProgress, or generic units fallback for older helpers
  const fileUnitState=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+4500).toISOString(),
      heartbeat:new Date(then+4800).toISOString(),
      steps:{
        unit:'files',
        measured:true,
        completed:2,
        total:5,
        samples:[
          {at:start,done:0},
          {at:new Date(then+4000).toISOString(),done:2},
        ],
        currentStep:{
          index:1,
          label:'Inspect sources',
          unit:'checks',
          measured:true,
          completed:3,
          total:4,
          samples:[
            {at:new Date(then+4000).toISOString(),done:0},
            {at:new Date(then+4500).toISOString(),done:3},
          ],
        },
      },
    },
  },attempt,then+5000);
  const fileUnitView=presentProgress(fileUnitState,{formatLocalTime:fixedClock});
  const fileHasUnit='unit' in fileUnitState;
  const expectedFileUnit=fileHasUnit ? 'files' : 'units';
  const expectedCheckUnit=fileHasUnit ? 'checks' : 'units';
  assert.equal(fileUnitView.counts.unit,fileHasUnit ? 'files' : null);
  assert.equal(fileUnitView.counts.unitSingular,fileHasUnit ? 'file' : null);
  assert.equal(rowByKey(fileUnitView,'currentStep').value,`Step 1: Inspect sources (3/4, 75%; 6 ${expectedCheckUnit}/s)`);
  assert.equal(rowByKey(fileUnitView,'completed').value,`2 of 5 ${expectedFileUnit} (2/5, 40%)`);
  assert.equal(rowByKey(fileUnitView,'remaining').value,`3 of 5 ${expectedFileUnit} remaining`);
  assert.equal(rowByKey(fileUnitView,'rate').value,`0.5 ${expectedFileUnit}/s (current step: 6 ${expectedCheckUnit}/s)`);
  assert.doesNotMatch(rowByKey(fileUnitView,'completed').value,/steps/i);
  assert.doesNotMatch(rowByKey(fileUnitView,'remaining').value,/steps/i);
  assert.doesNotMatch(rowByKey(fileUnitView,'rate').value,/steps\/s|sub-steps\/s/i);

  // Empty currentStep object with positive overall stepRate falls back to not-reported without crashing
  const emptyStepState=describeProgress({
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
  },attempt,then+5000);
  const emptyStepView=presentProgress(emptyStepState,{formatLocalTime:fixedClock});
  const emptyStepUnit='unit' in emptyStepState ? 'steps' : 'units';
  assert.equal(rowByKey(emptyStepView,'currentStep').value,'Unavailable (current step not reported)');
  assert.equal(rowByKey(emptyStepView,'rate').value,`0.5 ${emptyStepUnit}/s`);
  assert.equal(rowByKey(emptyStepView,'overallEta').value,'6.0 s');
});

test('stale data, zero rates, waiting-for-completion, and unavailable inputs behave conservatively',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};

  // Zero measured rate shows 0 unit rate without inventing an ETA
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
  const zeroUnit='unit' in zeroRate ? 'steps' : 'units';
  assert.equal(zeroView.phase,'waiting');
  assert.equal(zeroView.waiting,true);
  assert.equal(rowByKey(zeroView,'rate').value,`0 ${zeroUnit}/s`);
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
  const settleUnit='unit' in waitingSettlement ? 'steps' : 'units';
  assert.equal(settleView.phase,'waiting');
  assert.equal(settleView.complete,false);
  assert.equal(rowByKey(settleView,'remaining').value,`0 of 5 ${settleUnit} remaining (waiting for completion)`);
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
  const failedUnit='unit' in failed ? 'steps' : 'units';
  assert.equal(failedView.phase,'failed');
  assert.equal(failedView.stateLabel,'Failed');
  assert.equal(failedView.failed,true);
  assert.equal(failedView.complete,false);
  assert.equal(failedView.explanation,'Attempt failed (code: E_ATTEMPT_FAILED). Detailed diagnostics are omitted; review recovery status before retrying.');
  assert.doesNotMatch(failedView.text,/Protected check exited with status 1/);
  assert.doesNotMatch(failedView.announcement,/Protected check exited with status 1/);
  assert.equal(rowByKey(failedView,'status').value,'Attempt failed');
  assert.equal(rowByKey(failedView,'completed').value,`3 of 5 ${failedUnit} (3/5, 60%)`);
  assert.equal(rowByKey(failedView,'remaining').value,`2 of 5 ${failedUnit} remaining`);
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
    const terminal5=describeProgress({
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
    },then+7000);
    const terminal5View=presentProgress(terminal5,{formatLocalTime:fixedClock});
    const terminal5Unit='unit' in terminal5 ? 'steps' : 'units';
    assert.equal(terminal5View.phase,expectedPhase);
    assert.equal(terminal5View.stateLabel,expectedLabel);
    assert.equal(terminal5View.waiting,false);
    assert.equal(rowByKey(terminal5View,'remaining').value,`0 of 5 ${terminal5Unit} remaining`);
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
  const completeUnit='unit' in complete ? 'steps' : 'units';
  assert.equal(completeView.phase,'complete');
  assert.equal(completeView.stateLabel,'Complete');
  assert.equal(completeView.complete,true);
  assert.equal(rowByKey(completeView,'status').value,'Complete');
  assert.equal(rowByKey(completeView,'currentStep').value,`None (all measured ${completeUnit} complete)`);
  assert.equal(rowByKey(completeView,'completed').value,`4 of 4 ${completeUnit} (4/4, 100%)`);
  assert.equal(rowByKey(completeView,'remaining').value,`0 of 4 ${completeUnit} remaining`);
  assert.equal(rowByKey(completeView,'elapsed').value,'8.0 s');
  assert.equal(rowByKey(completeView,'currentStepEta').available,false);
  assert.match(rowByKey(completeView,'currentStepEta').value,/^Unavailable[: ]+.*current-step sub-progress is not measured\.?$/i);
  assert.doesNotMatch(rowByKey(completeView,'currentStepEta').value,/complete\.|no remaining work|0 ms/i);
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

test('validated unit contract formats allowlisted units accurately and falls back to generic units when absent or invalid',()=>{
  // Validated overall files/file and currentStep checks/check contract
  const activeFilesView=presentProgress({
    phase:'active',
    status:'Running step 2 of 5',
    totalKnown:true,
    unit:'files',
    unitSingular:'file',
    completedSteps:2,
    totalSteps:5,
    remainingSteps:3,
    stepRate:0.5,
    overallEtaMs:6000,
    projectedCompletionMs:then+12000,
    currentStep:{
      index:2,
      label:'Lint sources',
      unit:'checks',
      unitSingular:'check',
      completed:3,
      total:4,
      remaining:1,
      rate:2,
      etaMs:500,
    },
    currentStepEtaMs:500,
  },{formatLocalTime:fixedClock});
  assert.equal(activeFilesView.counts.unit,'files');
  assert.equal(activeFilesView.counts.unitSingular,'file');
  assert.equal(rowByKey(activeFilesView,'currentStep').value,'Step 2: Lint sources (3/4, 75%; 2 checks/s)');
  assert.equal(rowByKey(activeFilesView,'completed').value,'2 of 5 files (2/5, 40%)');
  assert.equal(rowByKey(activeFilesView,'remaining').value,'3 of 5 files remaining');
  assert.equal(rowByKey(activeFilesView,'rate').value,'0.5 files/s (current step: 2 checks/s)');

  // Singular vs plural open-total and 1-of-1 formatting
  const singleOpenView=presentProgress({
    phase:'active',
    status:'Running',
    totalKnown:false,
    unit:'files',
    unitSingular:'file',
    completedSteps:1,
    totalSteps:null,
    stepRate:0.25,
    currentStep:{
      index:1,
      label:'Scan module',
      unit:'checks',
      unitSingular:'check',
      completed:1,
      total:null,
      rate:1,
    },
  });
  assert.equal(singleOpenView.counts.unit,'files');
  assert.equal(singleOpenView.counts.unitSingular,'file');
  assert.equal(rowByKey(singleOpenView,'currentStep').value,'Step 1: Scan module (1 check completed, total unknown; 1 checks/s)');
  assert.equal(rowByKey(singleOpenView,'completed').value,'1 file completed (total unknown)');
  assert.equal(rowByKey(singleOpenView,'remaining').value,'Unknown (total files not reported)');
  assert.equal(rowByKey(singleOpenView,'rate').value,'0.25 files/s (current step: 1 checks/s)');

  const singleTotalCompleteView=presentProgress({
    phase:'complete',
    complete:true,
    status:'Complete',
    totalKnown:true,
    unit:'items',
    unitSingular:'item',
    completedSteps:1,
    totalSteps:1,
    remainingSteps:0,
    overallEtaMs:0,
    projectedCompletionMs:then+1000,
  },{formatLocalTime:fixedClock});
  assert.equal(singleTotalCompleteView.counts.unit,'items');
  assert.equal(singleTotalCompleteView.counts.unitSingular,'item');
  assert.equal(rowByKey(singleTotalCompleteView,'currentStep').value,'None (all measured items complete)');
  assert.equal(rowByKey(singleTotalCompleteView,'completed').value,'1 of 1 item (1/1, 100%)');
  assert.equal(rowByKey(singleTotalCompleteView,'remaining').value,'0 of 1 item remaining');

  // 5/5 settlement wait vs terminal failed 5/5 with validated units
  const waitingFilesView=presentProgress({
    phase:'waiting',
    waiting:true,
    status:'Waiting for completion',
    totalKnown:true,
    unit:'files',
    unitSingular:'file',
    completedSteps:5,
    totalSteps:5,
    remainingSteps:0,
    currentStepEtaMs:null,
    unavailableReasons:{currentStepEta:'Unavailable until the workspace confirms run completion.'},
  });
  assert.equal(rowByKey(waitingFilesView,'remaining').value,'0 of 5 files remaining (waiting for completion)');

  const failedFilesView=presentProgress({
    phase:'failed',
    failed:true,
    status:'Attempt failed',
    explanation:'The attempt failed before completion.',
    totalKnown:true,
    unit:'files',
    unitSingular:'file',
    completedSteps:5,
    totalSteps:5,
    remainingSteps:0,
  });
  assert.equal(rowByKey(failedFilesView,'remaining').value,'0 of 5 files remaining');

  // Missing completed count on complete preserves validated singular/plural unit wording
  const missingDoneFilesView=presentProgress({
    phase:'complete',
    complete:true,
    status:'Complete',
    totalKnown:true,
    unit:'files',
    unitSingular:'file',
    completedSteps:null,
    totalSteps:5,
    remainingSteps:null,
  });
  assert.equal(rowByKey(missingDoneFilesView,'completed').value,'Unavailable (completed count not recorded; 5 total files)');
  assert.equal(rowByKey(missingDoneFilesView,'remaining').value,'Unknown (completed count for 5 total files was not recorded)');
  assert.equal(rowByKey(missingDoneFilesView,'currentStepEta').value,'Unavailable because completed file count is not recorded.');
  assert.equal(rowByKey(missingDoneFilesView,'overallEta').value,'Unavailable because completed file count is not recorded.');

  // Premature complete with validated files / checks preserves safe unit message; invalid failure units are omitted
  const prematureFilesView=presentProgress({
    phase:'complete',
    complete:true,
    status:'Complete',
    totalKnown:true,
    unit:'files',
    unitSingular:'file',
    completedSteps:3,
    totalSteps:5,
    remainingSteps:2,
  });
  assert.equal(prematureFilesView.phase,'failed');
  assert.equal(prematureFilesView.explanation,'Completion was reported before all measured files finished.');
  assert.equal(rowByKey(prematureFilesView,'remaining').value,'2 of 5 files remaining');

  const safeReportedPrematureView=presentProgress({
    phase:'failed',
    failed:true,
    status:'Incomplete termination',
    explanation:'Completion was reported before all measured current-step checks finished.',
    remaining:'1 of 4 current-step checks remaining.',
    totalKnown:false,
  });
  assert.equal(safeReportedPrematureView.explanation,'Completion was reported before all measured current-step checks finished.');
  assert.equal(rowByKey(safeReportedPrematureView,'remaining').value,'1 of 4 current-step checks remaining.');

  const unsafeUnitFailureView=presentProgress({
    phase:'failed',
    failed:true,
    status:'Incomplete termination',
    explanation:'Completion was reported before all measured SENSITIVE_TOKENS finished.',
    remaining:'1 of 4 SENSITIVE_TOKENS remaining.',
    totalKnown:false,
  });
  assert.equal(unsafeUnitFailureView.explanation,'Attempt failed (code: E_ATTEMPT_FAILED). Detailed diagnostics are omitted; review recovery status before retrying.');
  assert.doesNotMatch(unsafeUnitFailureView.text,/SENSITIVE_TOKENS/);

  // Untrusted, disallowed, mismatched, or unmeasured unit fields fall back to generic units without leaking
  const invalidUnitInputs=[
    {unit:'chars',unitSingular:'char'},
    {unit:'tokens',unitSingular:'token'},
    {unit:'SENSITIVE_SECRET_UNIT',unitSingular:'SENSITIVE_SECRET_SINGULAR'},
    {unit:'files',unitSingular:'step'},
    {unit:'files',unitSingular:null},
    {unit:null,unitSingular:null},
    {unit:undefined,unitSingular:undefined},
  ];
  for (const invalidPair of invalidUnitInputs) {
    const fallbackView=presentProgress({
      phase:'active',
      status:'Running',
      totalKnown:true,
      unit:invalidPair.unit,
      unitSingular:invalidPair.unitSingular,
      completedSteps:2,
      totalSteps:5,
      remainingSteps:3,
      stepRate:0.5,
      chars:120,
      rate:24,
      currentStep:{
        index:1,
        label:'Process batch',
        unit:'tokens',
        unitSingular:'token',
        completed:1,
        total:4,
        rate:2,
      },
    });
    assert.equal(fallbackView.counts.unit,null);
    assert.equal(fallbackView.counts.unitSingular,null);
    assert.equal(rowByKey(fallbackView,'currentStep').value,'Step 1: Process batch (1/4, 25%; 2 units/s)');
    assert.equal(rowByKey(fallbackView,'completed').value,'2 of 5 units (2/5, 40%)');
    assert.equal(rowByKey(fallbackView,'remaining').value,'3 of 5 units remaining');
    assert.equal(rowByKey(fallbackView,'rate').value,'0.5 units/s (current step: 2 units/s; 24.0 UTF-16 code units/s)');
    assert.equal(rowByKey(fallbackView,'output').value,'120 UTF-16 code units (total unknown)');
    assert.doesNotMatch(fallbackView.text,/SENSITIVE_SECRET|tokens|characters/i);
  }

  // Unmeasured overall counters never claim a concrete unit even if unit/unitSingular are supplied
  const unmeasuredUnitView=presentProgress({
    phase:'waiting',
    waiting:true,
    status:'Waiting',
    totalKnown:false,
    unit:'files',
    unitSingular:'file',
    currentStep:{
      index:1,
      label:'Queued check',
      unit:'checks',
      unitSingular:'check',
    },
  });
  assert.equal(unmeasuredUnitView.counts.unit,null);
  assert.equal(unmeasuredUnitView.counts.unitSingular,null);
  assert.equal(rowByKey(unmeasuredUnitView,'currentStep').value,'Step 1: Queued check (sub-progress not measured)');

  // Streaming UTF-16 code units with measured work counters whose rate lacks timed samples uses unit-aware wording
  const charsWithMeasuredFilesView=presentProgress({
    phase:'active',
    status:'Running',
    totalKnown:true,
    unit:'files',
    unitSingular:'file',
    completedSteps:2,
    totalSteps:5,
    remainingSteps:3,
    stepSamplesValid:true,
    stepRate:null,
    chars:2400,
    rate:240,
    unavailableReasons:{
      rate:'Insufficient measured step samples to calculate rate.',
    },
  });
  assert.equal(
    rowByKey(charsWithMeasuredFilesView,'rate').value,
    '240.0 UTF-16 code units/s (file rate unavailable: Insufficient measured file samples to calculate rate.)',
  );
  assert.doesNotMatch(rowByKey(charsWithMeasuredFilesView,'rate').value,/\bstep\b/i);

  // Latest helper rate jargon ('No measured counters were supplied.') is translated cleanly
  const noSuppliedCountersView=presentProgress({
    phase:'waiting',
    waiting:true,
    status:'Waiting',
    unavailableReasons:{
      rate:'No measured counters were supplied.',
    },
  });
  assert.equal(rowByKey(noSuppliedCountersView,'rate').value,'Unavailable: No measured work counters.');
  assert.doesNotMatch(noSuppliedCountersView.text,/supplied/i);

  // Doubled 'Running Run' and 'Running Running' prefixes are eliminated without inventing an ordinal
  const doubledRunView=presentProgress({
    phase:'active',
    status:'Running Run protected checks (2 of 5 steps complete)',
    totalKnown:true,
    unit:'steps',
    unitSingular:'step',
    completedSteps:2,
    totalSteps:5,
    remainingSteps:3,
  });
  assert.equal(rowByKey(doubledRunView,'status').value,'Running protected checks (2 of 5 steps complete)');
  assert.doesNotMatch(doubledRunView.text,/\bRunning\s+Run\b|step \d+ of \d+/i);

  const doubledRunningView=presentProgress({
    phase:'active',
    status:'Running Running checks (1 of 3 checks complete)',
    totalKnown:true,
    unit:'checks',
    unitSingular:'check',
    completedSteps:1,
    totalSteps:3,
    remainingSteps:2,
  });
  assert.equal(rowByKey(doubledRunningView,'status').value,'Running checks (1 of 3 checks complete)');

  // Unmeasured current-step ETA on complete never renders zero even if older helper passed 0, whereas measured 3/3 sub-progress does
  const unmeasuredCompleteSubEta=presentProgress({
    phase:'complete',
    complete:true,
    status:'Complete',
    totalKnown:true,
    unit:'steps',
    unitSingular:'step',
    completedSteps:4,
    totalSteps:4,
    remainingSteps:0,
    overallEtaMs:0,
    currentStepEtaMs:0,
    currentStepEta:'Complete. No remaining work.',
  });
  assert.equal(rowByKey(unmeasuredCompleteSubEta,'currentStepEta').available,false);
  assert.equal(rowByKey(unmeasuredCompleteSubEta,'currentStepEta').value,'Unavailable because current-step sub-progress is not measured.');
  assert.doesNotMatch(rowByKey(unmeasuredCompleteSubEta,'currentStepEta').value,/complete\.|no remaining work|0 ms/i);

  const measuredCompleteSubEta=presentProgress({
    phase:'complete',
    complete:true,
    status:'Complete',
    totalKnown:true,
    unit:'steps',
    unitSingular:'step',
    completedSteps:4,
    totalSteps:4,
    remainingSteps:0,
    overallEtaMs:0,
    currentStepEtaMs:0,
    currentStep:{
      label:'Finalize checks',
      unit:'checks',
      unitSingular:'check',
      completed:3,
      total:3,
      remaining:0,
      etaMs:0,
    },
  });
  assert.equal(rowByKey(measuredCompleteSubEta,'currentStepEta').available,true);
  assert.equal(rowByKey(measuredCompleteSubEta,'currentStepEta').value,'Complete. No remaining work.');
});

test('zero ETAs require validated zero remaining counts, explicit top-level null is preserved, and settlement label excludes claimed 5/5 waits',()=>{
  const attempt={started:start,execution:{phase:'dispatching',dispatchedAt:start}};

  // Missing counts on complete never turn overallEtaMs:0 into "Complete. No remaining time."
  for (const input of [
    {phase:'complete',overallEtaMs:0},
    {
      phase:'complete',
      complete:true,
      status:'Complete',
      overallEtaMs:0,
      overallEta:'Complete. No remaining time.',
    },
  ]) {
    const view=presentProgress(input,{formatLocalTime:fixedClock});
    assert.equal(view.phase,'complete');
    assert.equal(rowByKey(view,'overallEta').available,false);
    assert.equal(rowByKey(view,'overallEta').value,'Unavailable because total work and remaining output are unknown.');
    assert.doesNotMatch(rowByKey(view,'overallEta').value,/complete\.|no remaining time|0 ms/i);
  }

  // Real helper complete without measured counters also suppresses unmeasured zero overall ETA
  const unmeasuredComplete=describeProgress({
    status:'complete',
    live:{
      complete:true,
      chars:120,
      lastActivity:new Date(then+4000).toISOString(),
      heartbeat:new Date(then+4000).toISOString(),
    },
  },{
    status:'completed',
    started:start,
    ended:new Date(then+4000).toISOString(),
    execution:{phase:'settled',dispatchedAt:start},
  },then+5000);
  const unmeasuredCompleteView=presentProgress(unmeasuredComplete,{formatLocalTime:fixedClock});
  assert.equal(rowByKey(unmeasuredCompleteView,'overallEta').available,false);
  assert.match(rowByKey(unmeasuredCompleteView,'overallEta').value,/^Unavailable/i);
  assert.doesNotMatch(rowByKey(unmeasuredCompleteView,'overallEta').value,/complete\.|no remaining time|0 ms/i);

  // Positive remaining counts reject overallEtaMs:0 and nested or top-level currentStep etaMs:0
  const activeZeroOverall=presentProgress({
    phase:'active',
    status:'Running',
    totalKnown:true,
    unit:'steps',
    unitSingular:'step',
    completedSteps:1,
    totalSteps:5,
    remainingSteps:4,
    stepRate:0.5,
    overallEtaMs:0,
    overallEta:'Complete. No remaining time.',
    projectedCompletionMs:then+10000,
    currentStep:{
      index:2,
      label:'Verify step',
      unit:'checks',
      unitSingular:'check',
      completed:1,
      total:5,
      remaining:4,
      rate:2,
      etaMs:0,
      eta:'Current step complete.',
    },
  },{formatLocalTime:fixedClock});
  assert.equal(rowByKey(activeZeroOverall,'overallEta').available,false);
  assert.equal(rowByKey(activeZeroOverall,'overallEta').value,'Unavailable until a reliable remaining time can be measured.');
  assert.doesNotMatch(rowByKey(activeZeroOverall,'overallEta').value,/complete\.|no remaining time|0 ms/i);
  assert.equal(rowByKey(activeZeroOverall,'completion').available,false);
  assert.doesNotMatch(rowByKey(activeZeroOverall,'completion').value,/projected around/i);
  assert.equal(rowByKey(activeZeroOverall,'currentStepEta').available,false);
  assert.equal(rowByKey(activeZeroOverall,'currentStepEta').value,'Unavailable until a reliable current-step remaining time can be measured.');
  assert.doesNotMatch(rowByKey(activeZeroOverall,'currentStepEta').value,/current step complete|complete\.|0 ms/i);

  const activeZeroTopSub=presentProgress({
    phase:'active',
    status:'Running',
    totalKnown:true,
    completedSteps:1,
    totalSteps:5,
    remainingSteps:4,
    stepRate:0.5,
    overallEtaMs:8000,
    currentStepEtaMs:0,
    currentStep:{
      index:2,
      label:'Verify step',
      completed:1,
      total:5,
      remaining:4,
      rate:2,
      etaMs:2000,
    },
  });
  assert.equal(rowByKey(activeZeroTopSub,'overallEta').value,'8.0 s');
  assert.equal(rowByKey(activeZeroTopSub,'currentStepEta').available,false);
  assert.equal(rowByKey(activeZeroTopSub,'currentStepEta').value,'Unavailable until a reliable current-step remaining time can be measured.');

  // Explicit top-level currentStepEtaMs:null (even with no unavailableReasons) is not replaced by nested etaMs:0
  const explicitNullActiveSub=presentProgress({
    phase:'active',
    status:'Running',
    totalKnown:true,
    unit:'steps',
    unitSingular:'step',
    completedSteps:1,
    totalSteps:5,
    remainingSteps:4,
    stepRate:0.5,
    overallEtaMs:8000,
    currentStepEtaMs:null,
    currentStep:{
      index:2,
      label:'Run checks',
      unit:'checks',
      unitSingular:'check',
      completed:4,
      total:4,
      remaining:0,
      etaMs:0,
      eta:'Current step complete.',
    },
  });
  assert.equal(rowByKey(explicitNullActiveSub,'currentStepEta').available,false);
  assert.equal(rowByKey(explicitNullActiveSub,'currentStepEta').value,'Unavailable until current-step completion is confirmed.');
  assert.doesNotMatch(rowByKey(explicitNullActiveSub,'currentStepEta').value,/current step complete|complete\.|0 ms/i);

  const explicitNullCompleteSub=presentProgress({
    phase:'complete',
    complete:true,
    status:'Complete',
    totalKnown:true,
    unit:'steps',
    unitSingular:'step',
    completedSteps:4,
    totalSteps:4,
    remainingSteps:0,
    overallEtaMs:0,
    currentStepEtaMs:null,
    currentStep:{
      label:'Finalize checks',
      unit:'checks',
      unitSingular:'check',
      completed:3,
      total:3,
      remaining:0,
      etaMs:0,
      eta:'Complete. No remaining work.',
    },
  });
  assert.equal(rowByKey(explicitNullCompleteSub,'overallEta').available,true);
  assert.equal(rowByKey(explicitNullCompleteSub,'overallEta').value,'Complete. No remaining time.');
  assert.equal(rowByKey(explicitNullCompleteSub,'currentStepEta').available,false);
  assert.equal(rowByKey(explicitNullCompleteSub,'currentStepEta').value,'Unavailable until current-step completion is confirmed.');
  assert.doesNotMatch(rowByKey(explicitNullCompleteSub,'currentStepEta').value,/complete\.|current step complete|no remaining work|0 ms/i);

  // Genuine zero ETAs still render when validated remaining === 0 and not explicitly null
  const genuineActiveSubZero=presentProgress({
    phase:'active',
    status:'Running',
    totalKnown:true,
    completedSteps:1,
    totalSteps:5,
    remainingSteps:4,
    stepRate:0.5,
    overallEtaMs:8000,
    currentStep:{
      index:2,
      label:'Run checks',
      completed:4,
      total:4,
      remaining:0,
      etaMs:0,
    },
  });
  assert.equal(rowByKey(genuineActiveSubZero,'overallEta').value,'8.0 s');
  assert.equal(rowByKey(genuineActiveSubZero,'currentStepEta').available,true);
  assert.equal(rowByKey(genuineActiveSubZero,'currentStepEta').value,'Current step complete.');

  // Real helper active 1/5 with positive rate vs completed 4/4 currentStep
  const helperActivePositive=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+2500).toISOString(),
      heartbeat:new Date(then+2500).toISOString(),
      steps:{
        measured:true,
        completed:1,
        total:5,
        samples:[
          {at:start,done:0},
          {at:new Date(then+2000).toISOString(),done:1},
        ],
        currentStep:{
          index:2,
          label:'Run checks',
          measured:true,
          completed:1,
          total:5,
          samples:[
            {at:new Date(then+2000).toISOString(),done:0},
            {at:new Date(then+2500).toISOString(),done:1},
          ],
        },
      },
    },
  },attempt,then+3000);
  const helperActivePositiveView=presentProgress(helperActivePositive,{formatLocalTime:fixedClock});
  assert.equal(rowByKey(helperActivePositiveView,'overallEta').available,true);
  assert.equal(rowByKey(helperActivePositiveView,'overallEta').value,'8.0 s');
  assert.equal(rowByKey(helperActivePositiveView,'currentStepEta').available,true);
  assert.equal(rowByKey(helperActivePositiveView,'currentStepEta').value,'2.0 s');

  const helperActiveSubDone=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+2500).toISOString(),
      heartbeat:new Date(then+2500).toISOString(),
      steps:{
        measured:true,
        completed:1,
        total:5,
        samples:[
          {at:start,done:0},
          {at:new Date(then+2000).toISOString(),done:1},
        ],
        currentStep:{
          index:2,
          label:'Run checks',
          measured:true,
          completed:4,
          total:4,
          samples:[
            {at:new Date(then+2000).toISOString(),done:0},
            {at:new Date(then+2500).toISOString(),done:4},
          ],
        },
      },
    },
  },attempt,then+3000);
  const helperActiveSubDoneView=presentProgress(helperActiveSubDone,{formatLocalTime:fixedClock});
  assert.equal(rowByKey(helperActiveSubDoneView,'overallEta').available,true);
  assert.equal(rowByKey(helperActiveSubDoneView,'overallEta').value,'8.0 s');
  assert.equal(rowByKey(helperActiveSubDoneView,'currentStepEta').available,true);
  assert.equal(rowByKey(helperActiveSubDoneView,'currentStepEta').value,'Current step complete.');

  // Real helper claimed 5/5 ("Checking selected route") vs genuine settlement wait 5/5 ("Waiting for completion")
  const fullSteps={
    measured:true,
    completed:5,
    total:5,
    samples:[
      {at:start,done:0},
      {at:new Date(then+5000).toISOString(),done:5},
    ],
  };
  const claimed5=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+5000).toISOString(),
      heartbeat:new Date(then+5000).toISOString(),
      steps:fullSteps,
    },
  },{
    started:start,
    execution:{phase:'claimed'},
  },then+6000);
  const claimed5View=presentProgress(claimed5,{formatLocalTime:fixedClock});
  const claimed5Unit='unit' in claimed5 ? 'steps' : 'units';
  assert.equal(claimed5View.phase,'waiting');
  assert.equal(claimed5View.waiting,true);
  assert.equal(rowByKey(claimed5View,'status').value,'Waiting: Checking selected route');
  assert.equal(rowByKey(claimed5View,'remaining').value,`0 of 5 ${claimed5Unit} remaining`);
  assert.doesNotMatch(rowByKey(claimed5View,'remaining').value,/waiting for completion/i);
  assert.equal(rowByKey(claimed5View,'overallEta').available,false);

  const realSettlement5=describeProgress({
    status:'running',
    live:{
      lastActivity:new Date(then+5000).toISOString(),
      heartbeat:new Date(then+5000).toISOString(),
      steps:fullSteps,
    },
  },{
    started:start,
    execution:{phase:'dispatching',dispatchedAt:start},
  },then+6000);
  const realSettlement5View=presentProgress(realSettlement5,{formatLocalTime:fixedClock});
  const settle5Unit='unit' in realSettlement5 ? 'steps' : 'units';
  assert.equal(realSettlement5View.phase,'waiting');
  assert.equal(realSettlement5View.waiting,true);
  assert.equal(rowByKey(realSettlement5View,'status').value,'Waiting for completion');
  assert.equal(rowByKey(realSettlement5View,'remaining').value,`0 of 5 ${settle5Unit} remaining (waiting for completion)`);
});
