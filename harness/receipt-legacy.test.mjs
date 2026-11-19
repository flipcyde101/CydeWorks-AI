import test from 'node:test';
import assert from 'node:assert/strict';
import {exportReceipt} from './receipt-export.mjs';
import {UNAVAILABLE_REASONS,validateReceiptExport} from './receipt-contract.mjs';
import {summarizeReceiptExports} from './receipt-analytics.mjs';
import {compareRuns,summarizeRun} from './test-support/inspector-v1/accounting.mjs';
import {acceptedTask,clone,deepFreeze,draft,sha} from './test-support/receipt-synthetic.mjs';
import {coverageSummary,receiptCoverage,usageRow} from './web-experience/logic/usage-rows.js';

// This fixture mirrors work/continuity-before/server.mjs. That server wrote
// a six-field source approval hash before recording a backend or model digest.
function legacyTask(overrides={}) {
  const task=acceptedTask(overrides);
  const attempt=task.attempts[0];
  attempt.provider='opencode';
  attempt.model='synthetic-legacy-model';
  for(const field of ['backend','approvedModelDigest','approvedModelFingerprint','execution'])delete attempt[field];
  attempt.scopeHash=sha(JSON.stringify([task.sourceHash,task.request,task.expected,task.kind,attempt.model,attempt.provider]));
  task.events=task.events.filter(event=>event.event!=='attempt.dispatching');
  task.events.forEach((event,index)=>event.seq=index+1);
  task.version=task.events.length;
  return task;
}

test('original six-field approvals export both brief and change history without inventing route evidence',()=>{
  for(const kind of ['brief','change']) {
    const task=legacyTask({kind});
    const receipt=exportReceipt(task);
    assert.equal(receipt.available,true,JSON.stringify(receipt.reasons));
    assert.equal(validateReceiptExport(receipt).ok,true);
    assert.equal(receipt.run.accepted,true);
    assert.equal(receipt.run.attemptsComplete,true);
    assert.equal(receipt.run.attempts[0].provider,'opencode');
    assert.equal(receipt.run.attempts[0].outcomeKnown,false);
    assert.equal(receipt.run.attempts[0].cost,null);
    assert.equal(receipt.run.attempts[0].startedAtMs,0);
    assert.equal(receipt.run.attempts[0].endedAtMs,4000);
    assert.equal(receipt.evidence.attempts[0].backend,'unrecorded');
    assert.equal(receipt.evidence.attempts[0].executionPhase,'unrecorded');
    assert.equal(receipt.evidence.attempts[0].outcomeBasis,'no-completion-evidence');
    assert.equal(receipt.evidence.inputIdentity.attemptsVerified,1);
  }
});

test('published pre-backend digest binding exports its recorded input and keeps backend unrecorded',()=>{
  const task=legacyTask();
  const attempt=task.attempts[0];
  attempt.approvedModelDigest='a'.repeat(64);
  attempt.scopeHash=sha(JSON.stringify([task.sourceHash,task.request,task.expected,task.kind,
    attempt.model,attempt.provider,attempt.approvedModelDigest]));
  const receipt=exportReceipt(task);
  assert.equal(receipt.available,true,JSON.stringify(receipt.reasons));
  assert.equal(receipt.evidence.attempts[0].backend,'unrecorded');
  assert.equal(receipt.run.attempts[0].outcomeKnown,false);
  attempt.approvedModelDigest='b'.repeat(64);
  assert.equal(exportReceipt(task).available,false);
});

test('newer binding fields cannot fall back to a legacy approval hash',()=>{
  for(const [field,value] of [['backend','ollama'],['backend',undefined],
    ['approvedModelDigest',null],['approvedModelDigest',undefined],
    ['approvedModelFingerprint',null],['approvedModelFingerprint',undefined],
    ['approvedRouteRevision','a'.repeat(64)],['approvedRouteRevision',undefined]]) {
    const task=legacyTask();
    task.attempts[0][field]=value;
    const receipt=exportReceipt(task);
    assert.equal(receipt.available,false,field);
    assert.deepEqual(receipt.reasons.map(reason=>reason.code),['approved-input-mismatch'],field);
  }
});

test('six-field verification still rejects changed approved source, instruction, kind, expectation or model',()=>{
  const original=legacyTask();
  for(const field of ['source','request','kind','expected','model','provider']) {
    const task=clone(original);
    if(field==='model'||field==='provider')task.attempts[0][field]='changed';
    else if(field==='kind')task.kind='brief';
    else task[field]='Changed synthetic value';
    if(field==='source')task.sourceHash=sha(task.source);
    assert.equal(exportReceipt(task).available,false,field);
  }
  const absent=legacyTask();
  delete absent.attempts[0].scopeHash;
  assert.deepEqual(exportReceipt(absent).reasons.map(reason=>reason.code),['approved-input-unrecorded']);
});

test('legacy selection does not invoke accessor fields or use inherited binding facts',()=>{
  let calls=0;
  for(const field of ['backend','approvedModelDigest','approvedModelFingerprint','approvedRouteRevision']) {
    const task=legacyTask();
    Object.defineProperty(task.attempts[0],field,{get(){calls++;throw Error('Do not invoke');}});
    assert.equal(exportReceipt(task).available,false,field);
  }
  assert.equal(calls,0);
  const inherited=legacyTask();
  Object.setPrototypeOf(inherited.attempts[0],{backend:'llamacpp',approvedRouteRevision:'a'.repeat(64)});
  const receipt=exportReceipt(inherited);
  assert.equal(receipt.available,true);
  assert.equal(receipt.evidence.attempts[0].backend,'unrecorded');
});

test('legacy receipt projection is deterministic, private and leaves source records untouched',()=>{
  const task=legacyTask({kind:'brief',request:'SYNTHETIC_PRIVATE_REQUEST',source:'SYNTHETIC_PRIVATE_SOURCE'});
  const snapshot=JSON.stringify(task);
  deepFreeze(task);
  const first=exportReceipt(task),second=exportReceipt(task);
  assert.equal(first.available,true,JSON.stringify(first.reasons));
  assert.deepEqual(second,first);
  assert.equal(JSON.stringify(task),snapshot);
  const text=JSON.stringify(first);
  assert.doesNotMatch(text,/SYNTHETIC_PRIVATE|synthetic-legacy-model|[a-f0-9]{64}/);
  assert.equal(text.includes(task.id),false);
  assert.equal(text.includes(task.attempts[0].id),false);
});

test('legacy receipts and a current receipt survive analytics with their independent evidence limits',()=>{
  const old=legacyTask();
  const current=acceptedTask({id:'00000000-0000-4000-8000-000000000002'});
  const receipts=[exportReceipt(old),exportReceipt(current)];
  assert.ok(receipts.every(receipt=>receipt.available));
  const summary=summarizeReceiptExports(receipts);
  assert.equal(summary.envelopeCounts.available,2);
  assert.equal(summary.envelopeCounts.malformed,0);
  assert.equal(summary.reconciliation.resolvedRuns.length,2);
  assert.equal(summary.costs.unknownCostAttemptCount,2);
});

test('unrecorded legacy provider outcomes cannot establish complete timing totals or route savings',()=>{
  const receipt=exportReceipt(legacyTask());
  assert.equal(receipt.available,true,JSON.stringify(receipt.reasons));
  const summary=summarizeRun(receipt.run);
  assert.equal(summary.wallTime.available,false);
  assert.equal(summary.totalCost.available,false);
  const candidate=exportReceipt(acceptedTask({id:'00000000-0000-4000-8000-000000000002'}));
  const comparison=compareRuns(receipt.run,candidate.run);
  assert.equal(comparison.time.available,false);
  assert.equal(comparison.cost.available,false);
});

test('synthetic current, projected legacy, and unavailable receipts keep separate coverage',()=>{
  const currentTask=acceptedTask({id:'00000000-0000-4000-8000-000000000002'});
  const current=exportReceipt(currentTask,{charges:[{attemptId:currentTask.attempts[0].id,amountMicros:120000,
    currency:'USD',evidence:'estimated',complete:true}]});
  const projectedTask=legacyTask();
  const projected=exportReceipt(projectedTask);
  const failedTask=legacyTask({id:'00000000-0000-4000-8000-000000000003'});
  failedTask.request='Changed synthetic value';
  const unavailable=exportReceipt(failedTask);
  assert.equal(current.available,true,JSON.stringify(current.reasons));
  assert.equal(current.formatVersion,2);
  assert.equal(projected.available,true,JSON.stringify(projected.reasons));
  assert.equal(unavailable.available,false);
  assert.deepEqual(unavailable.reasons.map(reason=>reason.code),['approved-input-mismatch']);
  const currentExport=JSON.stringify(current),projectedExport=JSON.stringify(projected);
  const entries=[
    {taskId:currentTask.id,envelope:current,summary:summarizeRun(current.run)},
    {taskId:projectedTask.id,envelope:projected,summary:summarizeRun(projected.run)},
    {taskId:failedTask.id,envelope:unavailable,summary:null},
  ];
  const rows=entries.map(entry=>usageRow({id:entry.taskId,attempts:null,status:'accepted'},entry));
  assert.deepEqual(rows.map(row=>row.coverage),['current','projected-legacy','unavailable']);
  assert.deepEqual(rows.map(row=>row.coverageLabel),['Current v2','Projected legacy','Unavailable']);
  assert.equal(rows[0].time.state,'measured');
  assert.equal(rows[0].time.text,'Measured 4.0 s.');
  assert.equal(rows[0].cost.state,'estimated');
  assert.equal(rows[0].cost.text,'0.12 USD');
  assert.equal(rows[0].note,undefined);
  assert.equal(rows[1].time.state,'recorded');
  assert.equal(rows[1].time.text,'Measured window 4.0 s. Complete total unknown.');
  assert.equal(rows[1].cost.text,'Unknown, not zero.');
  assert.match(rows[1].note,/not an established total/);
  assert.match(rows[1].note,/unknown, not zero/i);
  assert.equal(rows[1].attempts,1);
  assert.equal(rows[2].kind,'receipt-unavailable');
  assert.equal(rows[2].attempts,null);
  assert.equal(rows[2].time,undefined);
  assert.equal(rows[2].text,'Unknown, not zero.');
  assert.equal(rows[2].note,UNAVAILABLE_REASONS['approved-input-mismatch']+' Its usage figures are unknown, not zero.');
  const counts=receiptCoverage(entries);
  assert.deepEqual(counts,{listed:3,current:1,projectedLegacy:1,unavailable:1,measuredWindows:2,unknownWindows:0,
    establishedTotals:1,recordedCharges:1,unknownCharges:1});
  const summary=coverageSummary(counts);
  assert.equal(summary,'Receipts in this list: 3. Current version 2: 1. Projected legacy: 1. Unavailable: 1. Measured execution windows: 2. Unknown execution windows: 0. Established execution totals: 1. Recorded charges: 1. Unknown charges: 1. Unavailable receipts are left out of the window and charge counts. An unknown charge or window is not zero.');
  assert.equal(JSON.stringify(current),currentExport);
  assert.equal(JSON.stringify(projected),projectedExport);
  assert.equal(JSON.stringify(rows).includes('synthetic-legacy-model'),false);
  assert.equal(JSON.stringify([summary,...rows.map(row=>row.note)]).includes('\u2014'),false);
});

test('a draft unavailable receipt states its plain reason and stays out of charge totals',()=>{
  const task=draft();
  const envelope=exportReceipt(task);
  const entry={taskId:task.id,envelope,summary:null};
  const row=usageRow({id:task.id,attempts:null,status:'draft'},entry);
  assert.equal(row.kind,'none');
  assert.equal(row.text,'No attempts');
  assert.equal(row.note,UNAVAILABLE_REASONS['no-attempts-recorded']+' Its usage figures are unknown, not zero.');
  assert.deepEqual(receiptCoverage([entry]),{listed:1,current:0,projectedLegacy:0,unavailable:1,
    measuredWindows:0,unknownWindows:0,establishedTotals:0,recordedCharges:0,unknownCharges:0});
});
