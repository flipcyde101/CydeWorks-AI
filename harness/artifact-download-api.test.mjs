import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {terminalWorkspace} from './test-support/terminal-workspace.mjs';
import {unifiedPatch} from './patch.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const urlFor=(path,task,format='content')=>path+'/artifact?'+new URLSearchParams({
  version:String(task.version),attemptId:task.attempts.at(-1).id,
  artifactHash:task.attempts.at(-1).artifact.sha256,format});

test('accepted downloads bind current proposal and preserve bytes without changing task state',
  {timeout:15000},async t=>{
  const {request,path,task:initial}=await terminalWorkspace(t,{startImmediately:false,configure:folder=>
    writeFile(join(folder,'providers.mjs'),`
export const ollamaEndpoint='http://127.0.0.1:1';
export const ollama={inspect:async()=>({models:[]})};
export const fixture={models:async()=>[{id:'fixture'}],run:async()=>({settled:true,
  artifact:{summary:'Synthetic output',content:'After café 😀\\r\\nMixed\\nFinal'},usage:null})};
`)});
  const state=async()=>await (await request(path)).json();
  const run=async task=>{
    assert.equal((await request(path+'/run',{version:task.version,sourceHash:task.sourceHash,
      approve:true,engine:'fixture',model:'fixture'})).status,202);
    for(let i=0;i<100;i++) {
      const current=await state();if(current.status!=='running')return current;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw Error('Synthetic fixture did not settle.');
  };
  assert.equal((await request(path+'/artifact')).status,400);
  let task=await run(initial);assert.equal(task.status,'review');
  assert.equal((await request(urlFor(path,task))).status,409);
  const oldProposalUrl=urlFor(path,task);
  const editContent='After edited café 😀\r\nMixed\nFinal';
  task=await (await request(path+'/revise',{version:task.version,
    artifactHash:task.attempts[0].artifact.sha256,content:editContent})).json();
  task=await (await request(path+'/review',{version:task.version,
    artifactHash:task.attempts[0].artifact.sha256,decision:'accepted'})).json();
  assert.equal(task.status,'accepted');
  const url=urlFor(path,task),baseline=JSON.stringify(await state());
  assert.equal((await request(url,undefined,{authenticated:false})).status,401);
  assert.equal((await request(url,undefined,{originHeader:'https://untrusted.invalid'})).status,403);
  assert.equal((await request(url,{})).status,405);
  assert.equal((await request(oldProposalUrl)).status,409);
  assert.equal((await request(url+'&format=patch')).status,400);
  for(let i=0;i<2;i++) {
    const response=await request(url);assert.equal(response.status,200);
    const bytes=Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes,Buffer.from(editContent,'utf8'));
    assert.equal(response.headers.get('content-type'),'text/plain; charset=utf-8');
    assert.equal(response.headers.get('content-disposition'),'attachment; filename="proposed-example.txt"');
    assert.equal(response.headers.get('content-length'),String(bytes.length));
    assert.equal(response.headers.get('x-artifact-sha256'),hash(bytes));
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  }
  const patch=await request(urlFor(path,task,'patch'));
  assert.equal(patch.status,200);assert.equal(patch.headers.get('content-disposition'),'attachment; filename="proposal.patch"');
  const patchText=await patch.text();assert.equal(patchText,unifiedPatch(task.filename,task.source,editContent));
  assert.equal(patch.headers.get('x-artifact-sha256'),hash(patchText));
  assert.equal(JSON.stringify(await state()),baseline);
  assert.equal((await request('/api/tasks/'+randomUUID()+'/artifact')).status,404);
  const previousAttempt=task.attempts[0].id;
  task=await run(task);assert.equal(task.status,'review');
  assert.equal((await request(url)).status,409);
  task=await (await request(path+'/review',{version:task.version,
    artifactHash:task.attempts.at(-1).artifact.sha256,decision:'accepted'})).json();
  assert.equal((await request(urlFor(path,task).replace(task.attempts.at(-1).id,previousAttempt))).status,409);
  assert.equal((await request(urlFor(path,task))).status,200);
  const preview=await (await request(path+'/removal-preview')).json();
  assert.equal((await request(path+'/remove',{version:preview.version,token:preview.token,
    expiresAt:preview.expiresAt,confirmation:'REMOVE'})).status,200);
  assert.equal((await request(urlFor(path,task))).status,404);
});
