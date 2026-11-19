import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {artifactDownloadRequest,acceptedArtifactDownload} from './artifact-download.mjs';
import {unifiedPatch} from './patch.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
function sample() {
  const content='Accepted café 😀\r\nSecond line\nFinal line',source='Original\r\n';
  const task={version:5,status:'accepted',kind:'change',filename:'example.js',source,sourceHash:hash(source),
    title:'PRIVATE_TITLE',request:'PRIVATE_REQUEST',attempts:[{id:randomUUID(),status:'accepted',
      checks:[{pass:true}],artifact:{content,sha256:hash(content),patch:'UNTRUSTED_STORED_PATCH'}}]};
  const binding={version:5,attemptId:task.attempts[0].id,artifactHash:hash(content),format:'content'};
  return {task,binding,content};
}

test('accepted content preserves Unicode, mixed endings and no final newline without metadata',()=>{
  const {task,binding,content}=sample(),before=structuredClone(task);
  const result=acceptedArtifactDownload(task,binding);
  assert.equal(result.content,content);assert.equal(result.sha256,hash(Buffer.from(content,'utf8')));
  assert.equal(result.filename,'proposed-example.js');
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_TITLE|PRIVATE_REQUEST|UNTRUSTED_STORED_PATCH/);
  assert.deepEqual(task,before);
  task.kind='brief';assert.equal(acceptedArtifactDownload(task,binding).filename,'brief.md');
});

test('patches are regenerated from hash-checked snapshots, never trusted stored patch text',()=>{
  const {task,binding}=sample();binding.format='patch';
  const result=acceptedArtifactDownload(task,binding);
  assert.equal(result.content,unifiedPatch(task.filename,task.source,task.attempts[0].artifact.content));
  assert.equal(result.filename,'proposal.patch');assert.equal(result.sha256,hash(result.content));
  task.source+='tampered';assert.throws(()=>acceptedArtifactDownload(task,binding),{status:409});
  task.kind='brief';assert.throws(()=>acceptedArtifactDownload(task,binding),{status:400});
});

test('nonaccepted, stale, corrupt and unsafe filenames fail without echoing record values',()=>{
  const {task,binding}=sample();
  for(const status of ['draft','running','review','rejected','failed','cancelled','interrupted'])
    assert.throws(()=>acceptedArtifactDownload({...task,status},binding),{status:409});
  for(const change of [{version:4},{attemptId:randomUUID()},{artifactHash:'b'.repeat(64)}])
    assert.throws(()=>acceptedArtifactDownload(task,{...binding,...change}),{status:409});
  for(const mutate of [t=>t.attempts[0].status='review',t=>t.attempts[0].checks=[],
    t=>t.attempts[0].checks=[{pass:'true'}],t=>t.attempts[0].artifact.content+='tampered',
    t=>t.attempts[0].artifact.content='x'.repeat(12001),t=>t.attempts=[]]) {
    const changed=structuredClone(task);mutate(changed);
    assert.throws(()=>acceptedArtifactDownload(changed,binding),{status:409});
  }
  for(const filename of ['../PRIVATE','C:\\PRIVATE','a\r\nX-Header: PRIVATE','"PRIVATE','bad.','a'.repeat(101)])
    assert.throws(()=>acceptedArtifactDownload({...task,filename},binding),
      error=>error.status===409&&!error.message.includes('PRIVATE'));
});

test('query parsing requires exactly one valid binding and rejects ambiguous parameters',()=>{
  const {binding}=sample();
  const params=new URLSearchParams(Object.entries(binding).map(([key,value])=>[key,String(value)]));
  assert.deepEqual(artifactDownloadRequest(params),binding);
  params.delete('format');assert.deepEqual(artifactDownloadRequest(params),binding);
  for(const [key,value] of [['version','01'],['version','1.0'],['version','-1'],['version','9007199254740992'],
    ['attemptId','PRIVATE'],['artifactHash','A'.repeat(64)],['format','html'],['extra','PRIVATE']]) {
    const bad=new URLSearchParams(params);bad.set(key,value);
    assert.throws(()=>artifactDownloadRequest(bad),error=>error.status===400&&!error.message.includes('PRIVATE'));
  }
  for(const key of ['version','attemptId','artifactHash']) {
    const missing=new URLSearchParams(params);missing.delete(key);
    assert.throws(()=>artifactDownloadRequest(missing),{status:400});
    const duplicate=new URLSearchParams(params);duplicate.append(key,params.get(key));
    assert.throws(()=>artifactDownloadRequest(duplicate),{status:400});
  }
});
