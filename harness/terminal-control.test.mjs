import test from 'node:test';
import assert from 'node:assert/strict';
import {createTerminalControl} from './terminal-control.mjs';
import {terminalRequest,ownsTerminal} from './web/terminal-request.js';

function rig() {
  let mono=0,wall=1000,sequence=0;
  const control=createTerminalControl('attempt-1',{timeout:15,monotonic:()=>mono,wall:()=>wall,token:()=>`token-${++sequence}`});
  const take=(confirm=false,snapshot=control.snapshot())=>control.command({...snapshot,command:'take',confirm}).response;
  const command=(held,name,confirm=false)=>control.command({...held,command:name,confirm});
  return {control,take,command,set mono(value){mono=value;},set wall(value){wall=value;}};
}
const conflict=fn=>assert.throws(fn,error=>error.status===409);

test('observers see ownership and generation but never a bearer token',()=>{
  const r=rig();assert.equal(r.control.snapshot().owner,'None');
  const held=r.take();
  assert.equal(r.control.snapshot().owner,'Operator');
  assert.equal(JSON.stringify(r.control.snapshot()).includes(held.lease),false);
  conflict(()=>r.command({...held,lease:'not-the-token'},'stop',true));
  assert.equal(r.control.snapshot().closed,false);
});

test('takeover is bound to exactly the owner generation that was confirmed',()=>{
  const r=rig(),initial=r.control.snapshot(),first=r.take();
  conflict(()=>r.take(true,initial));
  conflict(()=>r.take(false));
  const second=r.take(true);
  conflict(()=>r.command(first,'heartbeat'));
  conflict(()=>r.command(first,'status'));
  conflict(()=>r.command(first,'release'));
  conflict(()=>r.command(first,'stop',true));
  assert.equal(r.command(second,'status').message,'OpenCode is running.');
});

test('commands from another attempt and malformed generations cannot claim control',()=>{
  const r=rig();
  for(const data of [{},{attemptId:'old',generation:0},{attemptId:'attempt-1',generation:'0'},
    {attemptId:'attempt-1',generation:-1}])
    conflict(()=>r.control.command({...data,command:'take',confirm:true}));
  assert.equal(r.control.snapshot().owner,'None');
});

test('expiry boundary is exact and a queued heartbeat cannot revive a lease',()=>{
  const r=rig(),held=r.take();r.mono=14;r.wall=1014;
  r.command(held,'heartbeat');r.mono=28;r.wall=1028;
  assert.equal(r.control.snapshot().owner,'Operator');
  r.mono=29;
  conflict(()=>r.command(held,'heartbeat'));
  assert.equal(r.control.snapshot().owner,'None');
  assert.notEqual(r.take().lease,held.lease);
});

test('suspend-sized wall jumps expire control even when monotonic time barely moves',()=>{
  const r=rig(),held=r.take();r.mono=1;r.wall=2000;
  conflict(()=>r.command(held,'stop',true));
  assert.equal(r.control.snapshot().closed,false);
});

test('backwards and invalid clocks revoke control rather than extending it',()=>{
  for(const change of [r=>{r.wall=999;},r=>{r.mono=-1;},r=>{r.mono=NaN;}]) {
    const r=rig(),held=r.take();change(r);
    conflict(()=>r.command(held,'heartbeat'));
    assert.equal(r.control.snapshot().owner,'None');
  }
});

test('detach and release revoke control without requesting Stop',()=>{
  for(const name of ['release','detach']) {
    const r=rig(),held=r.take(),result=r.command(held,name);
    assert.equal(result.stop,undefined);
    assert.equal(r.control.snapshot().closed,false);
    conflict(()=>r.command(held,'status'));
    assert.equal(r.control.snapshot().owner,'None');
    r.take();
  }
});

test('Stop needs confirmation and invalidates all future control on this attempt',()=>{
  const r=rig(),held=r.take();
  assert.throws(()=>r.command(held,'stop'),error=>error.status===400);
  assert.equal(r.command(held,'stop',true).stop,true);
  conflict(()=>r.take());conflict(()=>r.command(held,'heartbeat'));
  assert.equal(r.control.snapshot().closed,true);
});

test('completion and service recreation cannot retain previous control',()=>{
  const r=rig(),held=r.take();r.control.close();conflict(()=>r.command(held,'status'));
  const fresh=createTerminalControl('attempt-2');
  conflict(()=>fresh.command({...held,command:'take',confirm:true}));
  assert.equal(fresh.snapshot().owner,'None');
});

test('browser requests preserve lease binding rather than retargeting stale commands',()=>{
  const task={status:'running',live:{control:{attemptId:'new',generation:2,owner:'Operator',closed:false}}};
  const held={attemptId:'old',generation:1,lease:'old-token'};
  assert.deepEqual(terminalRequest(task,held,'stop',true),{command:'stop',confirm:true,...held});
  assert.deepEqual(terminalRequest(task,held,'take',true),{command:'take',confirm:true,attemptId:'new',generation:2});
  assert.equal(ownsTerminal(task,held),false);
  assert.equal(ownsTerminal(task,{...held,attemptId:'new',generation:2}),true);
  task.live.control.generation=3;
  assert.equal(ownsTerminal(task,{...held,attemptId:'new',generation:2}),false);
  assert.equal(ownsTerminal({status:'review'},held),false);
});
