import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {mkdirSync,mkdtempSync,readdirSync,unlinkSync,rmdirSync,realpathSync,lstatSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {UsageLedger} from './usage-ledger.mjs';

const make=()=>{const db=new DatabaseSync(':memory:');return {db,ledger:new UsageLedger(db)};};
const receipt=(eventId,attemptId,phase,sequence,input,output=null)=>({eventId,attemptId,phase,sequence,
  evidence:'reported',input,output,cached:null,reasoning:null});

test('cumulative events are idempotent, final wins over partial, and changed replays conflict',()=>{
  const {db,ledger}=make();
  try {
    const partial=receipt('part','attempt1','partial',1,12);
    const final=receipt('final','attempt1','final',2,20);
    ledger.recordUsage(partial);
    ledger.recordUsage(final);
    assert.equal(ledger.recordUsage(final).duplicate,true);
    assert.equal(ledger.getUsage('attempt1').input,20);
    assert.throws(()=>ledger.recordUsage({...final,input:21}),/conflict/i);
    assert.throws(()=>ledger.recordUsage({...receipt('estimated-final','attempt1','final',3,3),evidence:'estimated'}),/final.*already/i);
    ledger.recordUsage(receipt('final2','attempt2','final',2,20));
    ledger.recordUsage(receipt('latepartial','attempt2','partial',1,12));
    assert.equal(ledger.getUsage('attempt2').input,20);
    assert.throws(()=>ledger.recordUsage(receipt('different','attempt2','final',2,21)),/final.*already/i);
  } finally {db.close();}
});

test('failed attempts and retries remain separate, unknown is not zero, and replay does not double count',()=>{
  const {db,ledger}=make();
  try {
    ledger.recordUsage(receipt('e1','failed','final',1,7));
    ledger.recordUsage(receipt('e2','retry','final',1,13));
    ledger.recordUsage(receipt('e3','unknown','final',1,null));
    const total=ledger.sumUsage(['failed','retry','unknown','retry']).input;
    assert.equal(total.value,20);
    assert.equal(total.known,2);
    assert.equal(total.missing,1);
    assert.equal(total.byEvidence.reported.value,20);
    assert.equal(ledger.sumUsage(['unknown']).input.value,null);
    ledger.recordUsage({...receipt('estimate','estimate','final',1,5),evidence:'estimated'});
    const mixed=ledger.sumUsage(['failed','estimate']).input;
    assert.equal(mixed.byEvidence.reported.value,7);
    assert.equal(mixed.byEvidence.estimated.value,5);
  } finally {db.close();}
});

test('late settlement after cancellation preserves the hold until provider charges arrive',()=>{
  const {db,ledger}=make();
  try {
    ledger.createBudget({id:'task',currency:'USD',capMicros:100});
    assert.throws(()=>ledger.reserve({id:'zero',attemptId:'a0',currency:'USD',maxMicros:0,budgets:['task']}),/positive/);
    ledger.createBudget({id:'period',currency:'USD',capMicros:1000});
    const request={id:'r1',attemptId:'a1',currency:'USD',maxMicros:70,budgets:['task','period']};
    ledger.reserve(request);
    assert.equal(ledger.reserve(request).duplicate,true);
    assert.throws(()=>ledger.settle({eventId:'early',reservationId:'r1',currency:'USD',chargeMicros:1}),/dispatch/i);
    assert.equal(ledger.claimDispatch('r1').claimed,true);
    assert.equal(ledger.claimDispatch('r1').claimed,false);
    assert.throws(()=>ledger.reserve({...request,maxMicros:60}),/conflict/i);
    ledger.markCancellation('r1');
    assert.equal(ledger.getBudget('task').reservedMicros,70);
    assert.throws(()=>ledger.reserve({id:'r2',attemptId:'a2',currency:'USD',maxMicros:31,budgets:['task','period']}),/budget/i);
    ledger.recordUsage(receipt('late','a1','final',1,9,2));
    ledger.settle({eventId:'charge1',reservationId:'r1',currency:'USD',chargeMicros:40});
    assert.equal(ledger.settle({eventId:'charge1',reservationId:'r1',currency:'USD',chargeMicros:40}).duplicate,true);
    assert.equal(ledger.getBudget('task').reservedMicros,0);
    assert.equal(ledger.getBudget('task').spentMicros,40);
    assert.equal(ledger.getUsage('a1').input,9);
    assert.throws(()=>ledger.settle({eventId:'charge1',reservationId:'r1',currency:'USD',chargeMicros:41}),/conflict/i);
    ledger.reserve({id:'r2',attemptId:'a2',currency:'USD',maxMicros:60,budgets:['task','period']});
  } finally {db.close();}
});

test('actual charges can exceed a reservation and block new work without rewriting truth',()=>{
  const {db,ledger}=make();
  try {
    ledger.createBudget({id:'task',currency:'USD',capMicros:100});
    ledger.reserve({id:'r1',attemptId:'a1',currency:'USD',maxMicros:60,budgets:['task']});
    ledger.reserve({id:'r2',attemptId:'a2',currency:'USD',maxMicros:40,budgets:['task']});
    assert.equal(ledger.claimDispatch('r1').claimed,true);
    ledger.settle({eventId:'charge',reservationId:'r1',currency:'USD',chargeMicros:110});
    const budget=ledger.getBudget('task');
    assert.equal(budget.spentMicros,110);
    assert.equal(budget.availableMicros,0);
    assert.equal(budget.exceeded,true);
    assert.deepEqual(ledger.claimDispatch('r2'),{claimed:false,state:'budget-hold'});
    assert.throws(()=>ledger.reserve({id:'r3',attemptId:'a3',currency:'USD',maxMicros:1,budgets:['task']}),/budget/i);
  } finally {db.close();}
});

test('only an undispatched reservation can use the explicit no-charge release',()=>{
  const {db,ledger}=make();
  try {
    ledger.createBudget({id:'task',currency:'USD',capMicros:100});
    ledger.reserve({id:'r1',attemptId:'a1',currency:'USD',maxMicros:70,budgets:['task']});
    ledger.markCancellation('r1');
    assert.equal(ledger.getBudget('task').reservedMicros,70);
    const release={eventId:'release1',reservationId:'r1',reason:'cancelled-before-dispatch'};
    assert.equal(ledger.releaseUndispatched(release).duplicate,false);
    assert.equal(ledger.releaseUndispatched(release).duplicate,true);
    assert.equal(ledger.getBudget('task').reservedMicros,0);
    assert.equal(ledger.claimDispatch('r1').claimed,false);
    ledger.reserve({id:'r2',attemptId:'a2',currency:'USD',maxMicros:70,budgets:['task']});
    ledger.claimDispatch('r2');
    ledger.markCancellation('r2');
    assert.throws(()=>ledger.releaseUndispatched({eventId:'release2',reservationId:'r2',reason:'cancelled-before-dispatch'}),/dispatch/i);
  } finally {db.close();}
});

test('two database connections cannot reserve the same budget twice', {timeout:15000},async()=>{
  const base=resolve(fileURLToPath(new URL('../work/',import.meta.url)));
  mkdirSync(base,{recursive:true});
  const dir=mkdtempSync(join(base,'ledger-test-'));
  const path=join(dir,'ledger.sqlite');
  const db=new DatabaseSync(path);
  const ledger=new UsageLedger(db);
  ledger.createBudget({id:'period',currency:'USD',capMicros:100});
  const barrier=new SharedArrayBuffer(4),view=new Int32Array(barrier);
  const workers=['a','b'].map(id=>{
    const worker=new Worker(new URL('./usage-ledger-race-worker.mjs',import.meta.url),{workerData:{path,id,barrier}});
    let readyResolve,doneResolve,doneReject,outcome;
    const ready=new Promise(resolve=>{readyResolve=resolve;});
    const done=new Promise((resolve,reject)=>{doneResolve=resolve;doneReject=reject;});
    worker.on('message',message=>{if(message==='ready')readyResolve();else outcome=message;});
    worker.on('error',doneReject);
    worker.on('exit',code=>{if(code!==0||!outcome)doneReject(Error('Test worker did not complete'));else doneResolve(outcome);});
    return {worker,ready,done};
  });
  try {
    await Promise.all(workers.map(worker=>worker.ready));
    Atomics.store(view,0,1);
    Atomics.notify(view,0,2);
    const results=await Promise.all(workers.map(worker=>worker.done));
    assert.deepEqual(results.sort(),['budget hold','reserved']);
    assert.equal(ledger.getBudget('period').reservedMicros,70);
  } finally {
    db.close();
    const realBase=realpathSync(base),realDir=realpathSync(dir);
    if(!realDir.startsWith(realBase+sep) || lstatSync(dir).isSymbolicLink()) throw Error('Unsafe test cleanup path');
    for(const name of readdirSync(dir)) {
      if(!['ledger.sqlite','ledger.sqlite-wal','ledger.sqlite-shm'].includes(name)) throw Error('Unexpected test file');
      const file=join(dir,name);
      if(lstatSync(file).isSymbolicLink()) throw Error('Unexpected test link');
      unlinkSync(file);
    }
    rmdirSync(dir);
  }
});
