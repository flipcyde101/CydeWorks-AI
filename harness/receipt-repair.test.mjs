import test from 'node:test';
import assert from 'node:assert/strict';
import {exportReceipt} from './receipt-export.mjs';
import {retryHold} from './recovery.mjs';
import {validateReceipt,LIMITS} from './receipt-contract.mjs';
import {acceptedTask,scenarios,draft,start,finish,sha} from './test-support/receipt-synthetic.mjs';

test('ill-formed Unicode snapshots cannot become comparable approved input',()=>{
  assert.equal(sha('\ud800'),sha('\ud801'),'legacy hash collision reproducer');
  for(const source of ['\ud800','\ud801','text\udfff','\ud800x']) {
    const result=exportReceipt(acceptedTask({source}));
    assert.equal(result.available,false);
    assert.ok(result.reasons.some(r=>r.code==='input-unicode-invalid'));
  }
  assert.equal(exportReceipt(acceptedTask({source:'valid \ud83d\ude80 and \ufffd'})).available,true);
  for(const field of ['request','expected','filename']) {
    assert.equal(exportReceipt(acceptedTask({[field]:'\ud800'})).available,false,field);
  }
});

test('validator bounds diagnostics and never echoes unknown property names',()=>{
  const run=exportReceipt(acceptedTask()).run;
  for(let i=0;i<5000;i++)run['synthetic-private-key-'+i]=true;
  const result=validateReceipt(run);
  assert.equal(result.ok,false);
  assert.equal(result.issues.length,LIMITS.issues);
  assert.equal(JSON.stringify(result).includes('synthetic-private-key'),false);
});

test('receipt does not disclose any caller-supplied model label',()=>{
  for(const model of ['synthetic-private-folder/project-model','synthetic-token-canary','qwen:4b']) {
    const task=draft();
    start(task,1000,{provider:'opencode',backend:'llamacpp',model});
    finish(task,2000,{status:'failed'});
    const result=exportReceipt(task);
    assert.equal(result.available,true);
    assert.equal(result.run.attempts[0].model,'withheld');
    assert.equal(result.evidence.attempts[0].modelWithheld,true);
    assert.equal(JSON.stringify(result).includes(model),false);
  }
});

test('interrupted legacy records without recovery evidence stay unknown',()=>{
  for(const phase of ['claimed','settled','dispatching']) {
    const task=scenarios().interruptedBeforeDispatch;
    delete task.attempts[0].recovery;
    task.attempts[0].execution.phase=phase;
    assert.ok(retryHold(task));
    const result=exportReceipt(task);
    assert.equal(result.available,true);
    assert.equal(result.run.attempts[0].outcomeKnown,false);
    assert.equal(result.run.attempts[0].endedAtMs,null);
  }
  assert.equal(exportReceipt(scenarios().interruptedBeforeDispatch).run.attempts[0].outcomeKnown,true);
});

test('unknown edit history stays unknown rather than asserting an edit',()=>{
  for(const edits of [{bad:true},[null],[{}],new Array(1)]) {
    const task=acceptedTask();
    task.attempts[0].operatorEdits=edits;
    const result=exportReceipt(task);
    assert.equal(result.available,true);
    assert.equal(result.evidence.acceptance.operatorEdited,null);
    assert.equal(result.evidence.attempts[0].operatorEditCount,null);
  }
});

test('acceptance requires complete start history and a proposal review event',()=>{
  for(const replacement of ['attempt.failed','attempt.approved_and_started']) {
    const task=acceptedTask();
    task.events.find(e=>e.event==='attempt.review').event=replacement;
    const result=exportReceipt(task);
    assert.equal(result.available,true);
    assert.equal(result.run.accepted,false);
    assert.equal(result.evidence.acceptance.state,'unconfirmed');
  }
  assert.equal(exportReceipt(acceptedTask()).run.accepted,true);
  const contradictory=acceptedTask();
  contradictory.events.splice(-1,0,{event:'attempt.failed'});
  contradictory.events.forEach((event,index)=>event.seq=index+1);
  contradictory.version=contradictory.events.length;
  assert.equal(exportReceipt(contradictory).run.accepted,false);
});
