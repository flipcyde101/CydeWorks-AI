import test from 'node:test';
import assert from 'node:assert/strict';
import {exportReceipt} from './receipt-export.mjs';
import {validateReceiptExport} from './receipt-contract.mjs';
import {summarizeReceiptExports} from './receipt-analytics.mjs';
import {compareRuns,summarizeRun} from './test-support/inspector-v1/accounting.mjs';
import {acceptedTask,clone,deepFreeze,sha} from './test-support/receipt-synthetic.mjs';

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
