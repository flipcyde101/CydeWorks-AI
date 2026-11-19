// Feeds emitted receipts to the Run Inspector's own validator and accounting
// module, unchanged and pinned locally. Missing files fail instead of skipping.
import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptTaskToReceipt} from './receipt-adapter.mjs';
import {exportReceipt} from './receipt-export.mjs';
import {validateReceipt} from './receipt-contract.mjs';
import {acceptedTask,clone,draft,scenarios} from './test-support/receipt-synthetic.mjs';

const inspector=await import('./test-support/inspector-v1/accounting.mjs');
const fixtures=await import('./test-support/inspector-v1/fixtures.mjs');
const options={};

const run=(task,settings)=>{
  const result=adaptTaskToReceipt(task,settings);
  assert.equal(result.available,true);
  return result.run;
};
const charge=(attemptId,overrides={})=>({attemptId,amountMicros:1500,currency:'USD',evidence:'estimated',complete:true,...overrides});
const elsewhere=task=>Object.assign(clone(task),{id:'00000000-0000-4000-8000-000000000099'});

test('every emitted payload passes the inspector validator, and its fixtures pass this contract',options,()=>{
  for(const [name,task] of Object.entries(scenarios())) {
    for(const timebase of ['run-relative','epoch']) {
      const payload=run(task,{timebase,charges:[charge(task.attempts[0].id)]});
      const verdict=inspector.validateRun(payload);
      assert.equal(verdict.ok,true,name+' '+JSON.stringify(verdict.issues));
      assert.equal(inspector.summarizeRun(payload).ok,true,name);
    }
  }
  for(const sample of fixtures.FIXTURE_RUNS)assert.equal(validateReceipt(sample).ok,true,sample.runId);
});

test('the inspector reports time for settled runs and refuses totals it cannot support',options,()=>{
  const all=scenarios();
  const single=inspector.summarizeRun(run(all.accepted));
  assert.deepEqual([single.wallTime.available,single.wallTime.value],[true,4000]);
  assert.equal(single.totalCost.available,false);
  assert.ok(single.totalCost.reasons.some(reason=>/unknown, not zero/.test(reason)));
  const pair=inspector.summarizeRun(run(all.failedThenAccepted));
  assert.equal(pair.wallTime.value,8000,'the failed attempt and the gap both count');
  assert.equal(pair.attemptCount,2);
  for(const name of ['running','interruptedUnresolved','cancelledUnresolved','failedUnresolved']) {
    const summary=inspector.summarizeRun(run(all[name]));
    assert.equal(summary.wallTime.available,false,name);
    assert.equal(summary.totalCost.available,false,name);
    assert.equal(summary.uncertainOutcomeCount,1,name);
  }
  const safe=inspector.summarizeRun(run(all.interruptedBeforeDispatch));
  assert.equal(safe.uncertainOutcomeCount,0);
  assert.equal(safe.wallTime.available,false,'a withheld end instant keeps wall time unavailable');
  const dropped=clone(all.failedThenAccepted);
  dropped.attempts.shift();
  const partial=inspector.summarizeRun(run(dropped));
  assert.ok(partial.wallTime.reasons.some(reason=>/attemptsComplete/.test(reason)));
  assert.equal(partial.totalCost.available,false);
});

test('supplied charges are totalled only when currency and evidence allow it',options,()=>{
  const task=scenarios().failedThenAccepted;
  const [first,second]=task.attempts.map(attempt=>attempt.id);
  const total=charges=>inspector.summarizeRun(run(task,{charges})).totalCost;
  const estimated=total([charge(first,{amountMicros:800}),charge(second)]);
  assert.deepEqual([estimated.available,estimated.value,estimated.currency,estimated.evidence],[true,2300,'USD','estimated']);
  const zero=total([charge(first,{amountMicros:0,evidence:'provider-billed'}),charge(second,{amountMicros:0,evidence:'provider-billed'})]);
  assert.deepEqual([zero.available,zero.value,zero.currency,zero.evidence],[true,0,'USD','provider-billed']);
  assert.equal(total([charge(second,{amountMicros:0})]).available,false,'one known zero does not make the other attempt free');
  assert.ok(total([charge(first,{currency:'EUR'}),charge(second)]).reasons.some(reason=>/currencies/i.test(reason)));
  assert.ok(total([charge(first,{evidence:'provider-billed'}),charge(second)]).reasons.some(reason=>/estimates/i.test(reason)));
  assert.ok(total([charge(first,{complete:false}),charge(second)]).reasons.some(reason=>/incomplete cost/.test(reason)));
  assert.ok(total([charge(first,{amountMicros:Number.MAX_SAFE_INTEGER}),charge(second,{amountMicros:1})])
    .reasons.some(reason=>/safe integer range/.test(reason)));
  assert.equal(total([charge(first,{amountMicros:Number.MAX_SAFE_INTEGER+1}),charge(second)]).available,false);
});

test('only separate task records with the same approved input are comparable',options,()=>{
  const all=scenarios();
  const quick=run(all.accepted),slow=run(elsewhere(all.failedThenAccepted));
  const compared=inspector.compareRuns(slow,quick);
  assert.equal(compared.comparable,true,JSON.stringify(compared.reasons));
  assert.deepEqual([compared.time.available,compared.time.deltaMs],[true,4000]);
  assert.equal(compared.cost.available,false);
  // A later export of the same record contains the earlier one. It is the
  // same run and must not be compared as if it were a second execution.
  const earlier=clone(all.acceptedThenCancelled);
  earlier.attempts.pop();earlier.events.length=5;earlier.version=5;earlier.status='accepted';
  const same=inspector.compareRuns(run(earlier),run(all.acceptedThenCancelled));
  assert.equal(same.comparable,false);
  assert.ok(same.reasons.some(reason=>/Runs must be different/.test(reason)));
  const snapshot=inspector.compareRuns(quick,run(elsewhere(acceptedTask({source:'A later snapshot'}))));
  assert.ok(snapshot.reasons.some(reason=>/inputRevision/.test(reason)));
  assert.equal(snapshot.reasons.some(reason=>/taskKey/.test(reason)),false);
  const instruction=inspector.compareRuns(quick,run(elsewhere(acceptedTask({request:'Another instruction'}))));
  assert.ok(instruction.reasons.some(reason=>/taskKey/.test(reason)));
  const unreviewed=inspector.compareRuns(quick,run(elsewhere(all.reviewPending)));
  assert.ok(unreviewed.reasons.some(reason=>/accepted/.test(reason)));
  const priced=task=>run(task,{charges:task.attempts.map(attempt=>charge(attempt.id))});
  const costs=inspector.compareRuns(priced(elsewhere(all.failedThenAccepted)),priced(all.accepted));
  assert.deepEqual([costs.cost.available,costs.cost.deltaMicros,costs.cost.estimated],[true,1500,true]);
});

test('a draft never reaches the inspector as an empty run with a zero total',options,()=>{
  const refused=exportReceipt(draft());
  assert.equal(refused.available,false);
  assert.equal('run' in refused,false);
  // What the inspector would say about an empty complete run, which is why
  // the bridge does not emit one.
  const empty=inspector.summarizeRun({schemaVersion:1,runId:'r',taskKey:'t',inputRevision:'i',accepted:false,
    attemptsComplete:true,attempts:[]});
  assert.deepEqual([empty.totalCost.available,empty.totalCost.value],[true,0]);
});
