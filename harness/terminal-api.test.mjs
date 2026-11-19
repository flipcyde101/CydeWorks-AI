import test from 'node:test';
import assert from 'node:assert/strict';
import {terminalWorkspace} from './test-support/terminal-workspace.mjs';

test('terminal mutations reject an unbound request from an obsolete client', {timeout:15000},async t=>{
  const {request,path}=await terminalWorkspace(t);
  assert.equal((await request(path+'/terminal',{command:'take'})).status,409);
});

test('two views contend, transfer, detach, reattach and stop without stale commands taking effect', {timeout:15000},async t=>{
  const {request,path,task,start}=await terminalWorkspace(t);
  const terminal=data=>request(path+'/terminal',data);
  const read=async()=>await (await request(path)).json();
  const initial=task.live.control;
  assert.equal(initial.owner,'None');
  const take={command:'take',attemptId:initial.attemptId,generation:initial.generation};
  assert.equal((await request(path+'/terminal',take,{authenticated:false})).status,401);
  assert.equal((await request(path+'/terminal',take,{originHeader:'https://example.invalid'})).status,403);
  const claims=await Promise.all([terminal(take),terminal(take)]);
  assert.deepEqual(claims.map(r=>r.status).sort(),[200,409]);
  const held=await claims.find(r=>r.status===200).json();
  const observed=await read();
  assert.equal(JSON.stringify(observed).includes(held.lease),false);
  assert.equal((await terminal({...take,confirm:true})).status,409);
  const transfer={command:'take',attemptId:initial.attemptId,generation:observed.live.control.generation,confirm:true};
  const transferred=await terminal(transfer);assert.equal(transferred.status,200);
  const second=await transferred.json();
  assert.equal((await terminal(transfer)).status,409);
  for(const command of ['heartbeat','status','release','detach','stop'])
    assert.equal((await terminal({...held,command,confirm:true})).status,409);
  assert.equal((await terminal({...second,command:'detach'})).status,200);
  let current=await read();
  assert.equal(current.status,'running');
  assert.equal(current.attempts.length,1);
  assert.equal(current.live.owner,'None');
  // Reattachment is observation only: another GET never grants control.
  current=await read();assert.equal(current.live.control.owner,'None');
  assert.equal((await terminal({...second,command:'stop',confirm:true})).status,409);
  const last=await (await terminal({...current.live.control,command:'take'})).json();
  assert.equal((await terminal({...last,command:'stop'})).status,400);
  assert.equal((await terminal({...last,command:'stop',confirm:true})).status,200);
  for(let i=0;i<100;i++) {
    current=await read();if(current.status!=='running')break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(current.status,'failed'); // Synthetic adapter settles without a proposal.
  assert.equal(current.attempts.length,1);
  assert.equal(current.live,null);
  const next=await start(current);
  assert.notEqual(next.live.control.attemptId,initial.attemptId);
  assert.equal((await terminal({...take,confirm:true})).status,409);
  assert.equal((await terminal({...last,command:'stop',confirm:true})).status,409);
  assert.equal((await read()).status,'running');
});
