import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {terminalWorkspace} from './test-support/terminal-workspace.mjs';

test('lost-response recovery and concurrent replay never create a second attempt',{timeout:20000},async t=>{
  const {request,path}=await terminalWorkspace(t);
  const read=async(targetPath=path)=>{const res=await request(targetPath);assert.equal(res.status,200);return res.json();};
  async function stop(targetPath=path) {
    const current=await read(targetPath);
    const take=await request(targetPath+'/terminal',{...current.live.control,command:'take'});
    assert.equal(take.status,200);
    const control=await take.json();
    assert.equal((await request(targetPath+'/terminal',{...control,command:'stop',confirm:true})).status,200);
    for(let i=0;i<150;i++) {
      const state=await read(targetPath);if(state.status!=='running')return state;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw Error('Synthetic adapter did not stop');
  }
  const current=await stop();
  const body={requestId:randomUUID(),version:current.version,sourceHash:current.sourceHash,approve:true,
    engine:'opencode',model:'qwen3:1.7b',modelDigest:'a'.repeat(64)};
  const lookup=path+'/run-submissions/'+body.requestId;
  assert.equal((await request(path+'/run',body,{authenticated:false})).status,401);
  assert.equal((await request(path+'/run',body,{originHeader:'https://untrusted.invalid'})).status,403);
  assert.equal((await request(lookup)).status,404);
  const responses=await Promise.all([request(path+'/run',body),request(path+'/run',body)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,202]);
  const states=await Promise.all(responses.map(r=>r.json()));
  assert.equal(states[0].runSubmission.attemptId,states[1].runSubmission.attemptId);
  assert.deepEqual(states.map(row=>row.runSubmission.replayed).sort(),[false,true]);
  const live=await read();assert.equal(live.attempts.length,current.attempts.length+1);
  for(const state of [...states,live])assert.ok(state.attempts.every(attempt=>!Object.hasOwn(attempt,'submission')));
  assert.equal((await request(lookup,undefined,{authenticated:false})).status,401);
  assert.equal((await request(lookup,undefined,{originHeader:'https://untrusted.invalid'})).status,403);
  const found=await (await request(lookup)).json();
  assert.equal(found.attemptId,live.attempts.at(-1).id);assert.equal(found.executionAuthorized,false);
  assert.equal((await request(path+'/run',{...body,version:live.version})).status,409);
  assert.equal((await request(path+'/run',{...body,model:'different'})).status,409);
  assert.equal((await request(path+'/run',{...body,approve:false})).status,400);
  const settled=await stop();
  const events=JSON.stringify(settled.events);
  const replay=await request(path+'/run',body);assert.equal(replay.status,200);
  const recovered=await replay.json();
  assert.equal(recovered.runSubmission.attemptStatus,settled.attempts.at(-1).status);
  assert.equal(recovered.version,settled.version);assert.equal(JSON.stringify(recovered.events),events);
  assert.equal(recovered.live,null);
  // A deliberate new attempt requires a new ID and current version.
  const fresh={...body,requestId:randomUUID(),version:settled.version};
  assert.equal((await request(path+'/run',fresh)).status,202);
  const prior=await (await request(path+'/run',body)).json();
  assert.equal(prior.runSubmission.attemptId,found.attemptId);
  assert.notEqual(prior.attempts.at(-1).id,found.attemptId);
  await stop();
  // IDs are namespaced by task, not global workspace command identifiers.
  const otherResponse=await request('/api/tasks',{kind:'change',title:'Separate explicitly approved task',
    filename:'example.txt',source:'Before',request:'Return After',expected:'After'});
  const other=await otherResponse.json(),otherPath='/api/tasks/'+other.id;
  const otherRun=await request(otherPath+'/run',{...body,version:other.version,sourceHash:other.sourceHash});
  assert.equal(otherRun.status,202);
  const otherAttemptId=(await otherRun.json()).runSubmission.attemptId;
  assert.notEqual(otherAttemptId,found.attemptId);
  assert.equal((await (await request(lookup)).json()).attemptId,found.attemptId);
  assert.equal((await (await request(otherPath+'/run-submissions/'+body.requestId)).json()).attemptId,otherAttemptId);
  await stop(otherPath);
  const preview=await (await request(path+'/removal-preview')).json();
  assert.equal((await request(path+'/remove',{version:preview.version,expiresAt:preview.expiresAt,
    token:preview.token,confirmation:'REMOVE'})).status,200);
  assert.equal((await request(lookup)).status,404);
  assert.equal((await request(path+'/run',body)).status,404);
});
