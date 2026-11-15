import test from 'node:test';
import assert from 'node:assert/strict';
import {createObserver} from './web/observer.js';

function rig(read,onData) {
  let seq=0;
  const pending=new Map(), records=[], states=[];
  let disconnects=0;
  const observer=createObserver({read,
    onData:onData??(record=>records.push(record)), onState:state=>states.push(state),
    onDisconnect:()=>disconnects++,
    schedule:(fn,delay)=>{const id=++seq;pending.set(id,{fn,delay});return id;},
    cancel:id=>pending.delete(id),
  });
  return {observer,records,states,pending,get disconnects(){return disconnects;},
    async next(){const [id,job]=pending.entries().next().value;pending.delete(id);await job.fn();},
    delay(){return pending.values().next().value?.delay;},
  };
}

test('disconnect retries only reads, restores the same attempt and keeps watching completion',async()=>{
  const calls=[];
  let count=0;
  const r=rig(async id=>{
    calls.push(id);
    if (++count<3) throw new TypeError('Network unavailable');
    return {id,status:count===3?'running':'review',attempts:[{id:'same-attempt'}]};
  });
  r.observer.start('one');
  await r.next();
  assert.equal(r.delay(),1000);
  await r.next();
  assert.equal(r.delay(),2000);
  await r.next();
  assert.equal(r.delay(),850);
  await r.next();
  assert.equal(r.delay(),4000);
  assert.deepEqual(calls,['one','one','one','one']);
  assert.equal(r.disconnects,2);
  assert.deepEqual(r.records.map(x=>x.attempts[0].id),['same-attempt','same-attempt']);
  assert.equal(r.states.at(-1).phase,'connected');
});

test('retry backoff is bounded and resets after recovery',async()=>{
  let broken=true;
  const r=rig(async()=>{if(broken) throw Error('Offline');return {status:'running'};});
  r.observer.start('one');
  const delays=[];
  for(let i=0;i<6;i++){await r.next();delays.push(r.delay());}
  assert.deepEqual(delays,[1000,2000,4000,8000,8000,8000]);
  broken=false;
  await r.next();
  broken=true;
  await r.next();
  assert.equal(r.states.at(-1).failures,1);
  assert.equal(r.delay(),1000);
});

test('switching tasks or leaving the workspace suppresses stale in-flight responses',async()=>{
  let finish;
  const r=rig(id=>id==='old'?new Promise(resolve=>{finish=resolve;}):Promise.resolve({id,status:'review'}));
  r.observer.start('old');
  const old=r.next();
  r.observer.start('new');
  finish({id:'old',status:'running'});
  await old;
  assert.equal(r.records.length,0);
  assert.equal(r.pending.size,1);
  await r.next();
  assert.equal(r.records[0].id,'new');
  r.observer.start('old');
  const leaving=r.next();
  r.observer.stop();
  finish({id:'old',status:'running'});
  await leaving;
  assert.equal(r.pending.size,0);
  assert.equal(r.records.length,1);
});

test('expired authentication and missing tasks stop retrying until explicit resume',async()=>{
  for(const [status,phase] of [[401,'locked'],[404,'missing']]){
    let authorized=false;
    const r=rig(async()=>{if(!authorized)throw Object.assign(Error('Unavailable'),{status});return {status:'review'};});
    r.observer.start('one');
    await r.next();
    assert.equal(r.states.at(-1).phase,phase);
    assert.equal(r.pending.size,0);
    authorized=true;
    r.observer.start('one');
    await r.next();
    assert.equal(r.states.at(-1).phase,'connected');
  }
});

test('a read skipped during a user action cannot clear the reconnect state',async()=>{
  let skip=true;
  const r=rig(async()=>({id:'one',status:'running'}),()=>!skip);
  r.observer.start('one');
  await r.next();
  assert.equal(r.states.length,0);
  assert.equal(r.pending.size,1);
  skip=false;
  await r.next();
  assert.equal(r.states.at(-1).phase,'connected');
});

test('a stale heartbeat continuation is invalidated before it applies data',async()=>{
  let finish, saved=[];
  const r=rig(async id=>({id,status:'running'}),async(record,isCurrent)=>{
    await new Promise(resolve=>{finish=resolve;});
    if(isCurrent())saved.push(record.id);
  });
  r.observer.start('old');
  const pending=r.next();
  await Promise.resolve();
  r.observer.start('new');
  finish();
  await pending;
  assert.deepEqual(saved,[]);
  assert.equal(r.states.length,0);
  assert.equal(r.pending.size,1);
});
