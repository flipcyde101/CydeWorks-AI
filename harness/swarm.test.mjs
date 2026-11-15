import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {prepareSwarmPlan,SwarmCoordinator} from './swarm.mjs';

const scopeHash='a'.repeat(64),artifactA='b'.repeat(64),artifactB='c'.repeat(64);
const node=(id,role,dependsOn=[],writes=[])=>({id,role,request:'Complete '+id,
  route:{engine:'fixture',model:'synthetic'},dependsOn,writes});
const base=()=>({title:'Synthetic agent work',scopeHash,maxConcurrent:2,nodes:[
  node('first','builder',[],['src/one.txt']),node('second','builder',[],['src/two.txt']),
  node('review','reviewer',['first','second']),
]});
const make=options=>{const db=new DatabaseSync(':memory:');return {db,engine:new SwarmCoordinator(db,options)};};

test('a swarm requires approved scope and runs only dependency-ready claims',()=>{
  const {db,engine}=make();
  try {
    const created=engine.create(base());
    assert.equal(created.status,'draft');
    assert.throws(()=>engine.claimReady(created.id,scopeHash),/approval/);
    assert.throws(()=>engine.approve(created.id,'f'.repeat(64),scopeHash),/changed/);
    engine.approve(created.id,created.planHash,scopeHash);
    assert.throws(()=>engine.claimReady(created.id,'e'.repeat(64)),/changed/);
    const claims=engine.claimReady(created.id,scopeHash);
    assert.deepEqual(claims.map(item=>item.nodeId),['first','second']);
    assert.equal(engine.validateDispatch(created.id,'first',claims[0].claim,scopeHash).planHash,created.planHash);
    assert.throws(()=>engine.validateDispatch(created.id,'first',claims[0].claim,'f'.repeat(64)),/changed/);
    assert.deepEqual(engine.claimReady(created.id,scopeHash),[]);
    assert.throws(()=>engine.finish(created.id,'first','invalid',{status:'succeeded',artifactHash:artifactA}),/claim/);
    assert.deepEqual(engine.finish(created.id,'first',claims[0].claim,{status:'succeeded',artifactHash:artifactA}),{duplicate:false});
    assert.deepEqual(engine.finish(created.id,'first',claims[0].claim,{status:'succeeded',artifactHash:artifactA}),{duplicate:true});
    assert.throws(()=>engine.finish(created.id,'first',claims[0].claim,{status:'succeeded',artifactHash:artifactB}),/conflicts/);
    assert.deepEqual(engine.claimReady(created.id,scopeHash),[]);
    engine.finish(created.id,'second',claims[1].claim,{status:'succeeded',artifactHash:artifactB});
    const review=engine.claimReady(created.id,scopeHash);
    assert.deepEqual(review.map(item=>item.nodeId),['review']);
    engine.finish(created.id,'review',review[0].claim,{status:'succeeded',artifactHash:artifactA});
    const final=engine.view(created.id);
    assert.equal(final.status,'completed');
    assert.ok(final.nodes.every(item=>item.status==='succeeded'));
    assert.doesNotMatch(JSON.stringify(final),new RegExp(claims[0].claim));
  } finally {db.close();}
});

test('plan validation rejects cycles, missing dependencies and unsequenced overlapping writes',()=>{
  const cycle=base();cycle.nodes[0].dependsOn=['review'];
  assert.throws(()=>prepareSwarmPlan(cycle),/cycle/);
  const missing=base();missing.nodes[0].dependsOn=['missing'];
  assert.throws(()=>prepareSwarmPlan(missing),/missing/);
  const conflict=base();conflict.nodes[1].writes=['SRC/one.txt'];
  assert.throws(()=>prepareSwarmPlan(conflict),/overlapping/);
  conflict.nodes[1].dependsOn=['first'];
  assert.doesNotThrow(()=>prepareSwarmPlan(conflict));
});

test('ownership paths cannot escape a workspace or target Windows devices',()=>{
  for(const path of ['../secret','/absolute','C:/temp','a\\b','src/../x','NUL.txt','COM¹.txt','LPT³.log','src/*.js','src/a ']) {
    const plan=base();plan.nodes[0].writes=[path];
    assert.throws(()=>prepareSwarmPlan(plan),/relative path/);
  }
});

test('plan identifiers and engine names are strings, and ownership is bounded',()=>{
  const identifier=base();identifier.nodes[0].id=['first'];
  assert.throws(()=>prepareSwarmPlan(identifier),/identifier/);
  const engine=base();engine.nodes[0].route.engine=['fixture'];
  assert.throws(()=>prepareSwarmPlan(engine),/engine/);
  const excessive=base();
  excessive.nodes=Array.from({length:5},(_,index)=>node('node'+index,'builder',[],
    Array.from({length:64},(_,n)=>'dir'+index+'/file'+n)));
  assert.throws(()=>prepareSwarmPlan(excessive),/256/);
});

test('restart marks in-flight work unknown and revokes unconsumed approval',()=>{
  const {db,engine}=make();
  try {
    const created=engine.create(base());
    engine.approve(created.id,created.planHash,scopeHash);
    const claims=engine.claimReady(created.id,scopeHash);
    const restarted=new SwarmCoordinator(db);
    assert.equal(restarted.recoverInterrupted(),1);
    const view=restarted.view(created.id);
    assert.equal(view.status,'needs-recovery');
    assert.equal(view.nodes.filter(item=>item.status==='unknown').length,2);
    assert.throws(()=>restarted.claimReady(created.id,scopeHash),/approval/);
    assert.throws(()=>restarted.approve(created.id,created.planHash,scopeHash),/current state/);
    assert.throws(()=>restarted.finish(created.id,'first',claims[0].claim,{status:'succeeded',artifactHash:artifactA}),/claim|conflicts/);
  } finally {db.close();}
});

test('restart invalidates running claims after a peer fails or approval expires',()=>{
  for(const reason of ['failed-peer','expired-approval']) {
    let clock=0;
    const {db,engine}=make({clock:()=>clock});
    try {
      const created=engine.create(base());
      engine.approve(created.id,created.planHash,scopeHash,10);
      const claims=engine.claimReady(created.id,scopeHash);
      if(reason==='failed-peer')engine.finish(created.id,'first',claims[0].claim,{status:'failed'});
      else {clock=11;assert.throws(()=>engine.claimReady(created.id,scopeHash),/expired/);}
      assert.equal(engine.view(created.id).status,'needs-attention');
      const restarted=new SwarmCoordinator(db);
      assert.equal(restarted.recoverInterrupted(),1);
      assert.equal(restarted.view(created.id).status,'needs-recovery');
      assert.equal(restarted.view(created.id).nodes.find(item=>item.id==='second').status,'unknown');
      assert.throws(()=>restarted.finish(created.id,'second',claims[1].claim,{status:'succeeded',artifactHash:artifactA}),/claim|conflicts/);
    } finally {db.close();}
  }
});

test('restart preserves needs-attention after the only worker has failed',()=>{
  const {db,engine}=make();
  try {
    const input=base();input.nodes=[node('first','builder',[],['src/one.txt'])];
    const created=engine.create(input);
    engine.approve(created.id,created.planHash,scopeHash);
    const [claim]=engine.claimReady(created.id,scopeHash);
    engine.finish(created.id,'first',claim.claim,{status:'failed'});
    assert.equal(engine.view(created.id).status,'needs-attention');
    const restarted=new SwarmCoordinator(db);
    assert.equal(restarted.recoverInterrupted(),1);
    assert.equal(restarted.view(created.id).status,'needs-attention');
    assert.throws(()=>restarted.approve(created.id,created.planHash,scopeHash),/current state/);
  } finally {db.close();}
});

test('approval expiry stops new claims and can be renewed after active work settles',()=>{
  let clock=0;
  const {db,engine}=make({clock:()=>clock});
  try {
    const input=base();input.maxConcurrent=1;
    const created=engine.create(input);
    engine.approve(created.id,created.planHash,scopeHash,10);
    const [first]=engine.claimReady(created.id,scopeHash);
    clock=11;
    assert.throws(()=>engine.validateDispatch(created.id,'first',first.claim,scopeHash),/expired/);
    assert.throws(()=>engine.claimReady(created.id,scopeHash),/expired/);
    assert.equal(engine.view(created.id).status,'needs-attention');
    engine.finish(created.id,'first',first.claim,{status:'succeeded',artifactHash:artifactA});
    assert.equal(engine.view(created.id).status,'needs-approval');
    engine.approve(created.id,created.planHash,scopeHash,10);
    assert.equal(engine.claimReady(created.id,scopeHash)[0].nodeId,'second');
  } finally {db.close();}
});

test('a stale coordinator cannot reuse its grant after recovery and reapproval',()=>{
  const {db,engine}=make();
  try {
    const created=engine.create(base());
    engine.approve(created.id,created.planHash,scopeHash);
    const restarted=new SwarmCoordinator(db);
    assert.equal(restarted.recoverInterrupted(),1);
    restarted.approve(created.id,created.planHash,scopeHash);
    assert.throws(()=>engine.claimReady(created.id,scopeHash),/approval/);
    assert.equal(restarted.claimReady(created.id,scopeHash).length,2);
  } finally {db.close();}
});

test('a changed persisted plan cannot reuse a prior approval',()=>{
  const {db,engine}=make();
  try {
    const created=engine.create(base());
    engine.approve(created.id,created.planHash,scopeHash);
    db.prepare('UPDATE swarm_plans SET definition=? WHERE id=?').run('{}',created.id);
    assert.throws(()=>engine.claimReady(created.id,scopeHash),/changed/);
  } finally {db.close();}
});
