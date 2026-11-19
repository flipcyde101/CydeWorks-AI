import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {terminalWorkspace} from './test-support/terminal-workspace.mjs';

test('copy API is authenticated, version-bound, deduplicated and input-only', {timeout:15000},async t=>{
  const host=await terminalWorkspace(t),{request,path,task}=host;
  const body={version:task.version,confirm:true,requestId:randomUUID()};
  assert.equal(task.copy.allowed,false);
  assert.equal((await request(path+'/copy-draft',body,{authenticated:false})).status,401);
  assert.equal((await request(path+'/copy-draft',body,{originHeader:'https://example.invalid'})).status,403);
  assert.equal((await request(path+'/copy-draft',body)).status,409);
  const held=await (await request(path+'/terminal',{...task.live.control,command:'take'})).json();
  await request(path+'/terminal',{...held,command:'stop',confirm:true});
  let source;
  for(let i=0;i<100;i++) {
    source=await (await request(path)).json();if(source.status!=='running')break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(source.copy.allowed,true);
  assert.equal((await request(path+'/copy-draft',body)).status,409);
  body.version=source.version;
  assert.equal((await request(path+'/copy-draft',{...body,confirm:false})).status,400);
  assert.equal((await request(path+'/copy-draft',{...body,requestId:'bad'})).status,400);
  const responses=await Promise.all([request(path+'/copy-draft',body),request(path+'/copy-draft',body)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,201]);
  const [first,second]=await Promise.all(responses.map(r=>r.json()));
  assert.equal(first.task.id,second.task.id);
  const copy=first.task;
  assert.equal(copy.status,'draft');assert.equal(copy.model,null);
  assert.deepEqual(copy.attempts,[]);assert.equal(copy.events.length,1);
  assert.equal(copy.source,source.source);assert.equal(copy.request,source.request);
  assert.equal(copy.filename,source.filename);assert.equal(copy.expected,source.expected);
  assert.equal(copy.sourceHash,source.sourceHash);assert.notEqual(copy.id,source.id);
  assert.deepEqual(await (await request(path)).json(),source);
  assert.equal((await (await request('/api/tasks')).json()).tasks.length,2);
  const lookup='/api/draft-copies/'+body.requestId;
  assert.equal((await request(lookup,undefined,{authenticated:false})).status,401);
  assert.equal((await (await request(lookup)).json()).taskId,copy.id);
  assert.equal((await request('/api/tasks/'+copy.id+'/copy-draft',{...body,version:copy.version})).status,409);
  const alert=await (await request('/api/attention')).json();
  assert.equal(alert.tasks.filter(item=>item.id===copy.id).length,1);
  assert.deepEqual(alert.tasks.find(item=>item.id===copy.id).reasons,['Approval needed']);
  // Changed source does not convert a duplicate identity into another copy.
  const draftBody={title:'Second source',kind:'brief',request:'Summarize',source:'SYNTHETIC_SOURCE'};
  const other=await (await request('/api/tasks',draftBody)).json(),otherPath='/api/tasks/'+other.id;
  const originalRequest={version:other.version,confirm:true,requestId:randomUUID()};
  const saved=await (await request(otherPath+'/copy-draft',originalRequest)).json();
  await request(otherPath+'/scope',{...draftBody,version:other.version,source:'CHANGED_SYNTHETIC_SOURCE'});
  const repeat=await request(otherPath+'/copy-draft',originalRequest);
  assert.equal(repeat.status,200);assert.equal((await repeat.json()).task.id,saved.task.id);
});

test('removed copies stay removed when a create request is replayed', {timeout:15000},async t=>{
  const {request}=await terminalWorkspace(t);
  const source=await (await request('/api/tasks',{kind:'brief',title:'Draft',request:'Summarize',source:'Synthetic'})).json();
  const path='/api/tasks/'+source.id,body={version:source.version,confirm:true,requestId:randomUUID()};
  const copy=await (await request(path+'/copy-draft',body)).json(),copyPath='/api/tasks/'+copy.task.id;
  const preview=await (await request(copyPath+'/removal-preview')).json();
  assert.match(preview.retains.join(' '),/draft-copy request references/);
  const removal=await request(copyPath+'/remove',{version:preview.version,expiresAt:preview.expiresAt,
    token:preview.token,confirmation:'REMOVE'});
  assert.equal(removal.status,200);
  assert.equal((await request('/api/draft-copies/'+body.requestId)).status,410);
  assert.equal((await request(path+'/copy-draft',body)).status,410);
  assert.equal((await request(copyPath)).status,404);
});
