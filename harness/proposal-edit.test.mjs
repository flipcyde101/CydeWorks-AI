import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('operator edits preserve the model proposal and rerun checks before acceptance', {timeout:12000},async t=>{
  const key='a'.repeat(64);
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('.',import.meta.url),windowsHide:true,
    env:{...process.env,BFE_PORT:'0',BFE_TEST_MEMORY:'1',BFE_TEST_KEY:key},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
  });
  const [started]=await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Test service exited.');})]);
  const origin=/http:\/\/127\.0\.0\.1:\d+/.exec(started.toString())[0];
  const send=(path,body,cookie)=>fetch(origin+path,{method:body===undefined?'GET':'POST',
    headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const session=await send('/api/session',{key});
  const cookie=session.headers.get('set-cookie').split(';')[0];
  const request=(path,body)=>send(path,body,cookie);
  const created=await (await request('/api/tasks',{title:'Synthetic',kind:'brief',request:'Summarize',
    source:'Synthetic source that must remain private'})).json();
  const path='/api/tasks/'+created.id;
  assert.equal((await request(path+'/run',{version:created.version,sourceHash:created.sourceHash,approve:true,
    engine:'fixture',model:'fixture'})).status,202);
  let task;
  for(let i=0;i<100;i++) {
    task=await (await request(path)).json();
    if(task.status!=='running')break;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(task.status,'review');
  const original=task.attempts[0].artifact;
  const edit={version:task.version,artifactHash:original.sha256,content:'Unsourced edit'};
  assert.equal((await request(path+'/revise',{...edit,content:''})).status,400);
  assert.equal((await request(path+'/revise',{...edit,content:'x'.repeat(12001)})).status,400);
  const revised=await request(path+'/revise',edit);
  assert.equal(revised.status,200);
  task=await revised.json();
  assert.equal(task.attempts[0].originalArtifact.content,original.content);
  assert.equal(task.attempts[0].artifact.content,'Unsourced edit');
  assert.equal(task.attempts[0].checks[0].pass,false);
  assert.equal(task.attempts[0].operatorEdits.length,1);
  assert.equal((await request(path+'/review',{version:task.version,artifactHash:task.attempts[0].artifact.sha256,
    decision:'accepted'})).status,409);
  assert.equal((await request(path+'/revise',edit)).status,409);
  const competing={version:task.version,artifactHash:task.attempts[0].artifact.sha256};
  const results=await Promise.all([request(path+'/revise',{...competing,content:'Edited summary [1].'}),
    request(path+'/revise',{...competing,content:'Alternative summary [1].'})]);
  assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  task=await results.find(result=>result.status===200).json();
  assert.equal(task.attempts[0].originalArtifact.sha256,original.sha256);
  assert.equal(task.attempts[0].checks[0].pass,true);
  assert.equal(task.attempts[0].operatorEdits.length,2);
  const exported=await (await request(path+'/export?mode=standard')).text();
  assert.doesNotMatch(exported,/Synthetic source that must remain private|Unsourced edit|Edited summary|Alternative summary|Synthetic brief/);
  const reviewed=await request(path+'/review',{version:task.version,artifactHash:task.attempts[0].artifact.sha256,
    decision:'accepted'});
  assert.equal(reviewed.status,200);
  const accepted=await reviewed.json();
  assert.equal((await request(path+'/revise',{version:accepted.version,artifactHash:accepted.attempts[0].artifact.sha256,
    content:'Too late [1]'})).status,409);
  const file=await (await request('/api/tasks',{title:'Synthetic code',kind:'change',filename:'example.js',
    request:'Change the synthetic file',source:'before',expected:'new'})).json();
  const filePath='/api/tasks/'+file.id;
  assert.equal((await request(filePath+'/run',{version:file.version,sourceHash:file.sourceHash,approve:true,
    engine:'fixture',model:'fixture'})).status,202);
  let fileTask;
  for(let i=0;i<100;i++) {
    fileTask=await (await request(filePath)).json();
    if(fileTask.status!=='running')break;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  const fileEdit=await request(filePath+'/revise',{version:fileTask.version,artifactHash:fileTask.attempts[0].artifact.sha256,
    content:'manual new content'});
  assert.equal(fileEdit.status,200);
  const changed=await fileEdit.json();
  assert.equal(changed.attempts[0].originalArtifact.content,'new');
  assert.ok(changed.attempts[0].checks.every(check=>check.pass));
  assert.match(changed.attempts[0].artifact.patch,/\+manual new content/);
});
