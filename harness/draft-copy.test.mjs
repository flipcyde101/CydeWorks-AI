import test from 'node:test';
import assert from 'node:assert/strict';
import {draftCopyHold,copiedDraftScope} from './draft-copy.mjs';

const original=()=>({id:'old-task',version:9,status:'accepted',title:'Source task',kind:'change',
  request:'Change the supplied text',source:'Original source',filename:'example.txt',expected:'Revised',
  model:'PRIVATE_MODEL',approval:'PRIVATE_APPROVAL',terminal:'PRIVATE_TERMINAL',
  attempts:[{status:'accepted',provider:'opencode',execution:{phase:'settled'},artifact:{content:'DO_NOT_COPY_OUTPUT'},usage:{input:123}}],
  events:[{event:'OLD_EVENT'}]});

test('copy scope is an explicit input allowlist without results or approvals',()=>{
  const source=original(),before=structuredClone(source);
  assert.deepEqual(copiedDraftScope(source),{kind:'change',title:'Source task (copy)',request:'Change the supplied text',
    source:'Original source',filename:'example.txt',expected:'Revised'});
  assert.deepEqual(source,before);
  assert.doesNotMatch(JSON.stringify(copiedDraftScope(source)),/PRIVATE_|DO_NOT_COPY|OLD_EVENT/);
  source.title='x'.repeat(120);assert.equal(copiedDraftScope(source).title.length,120);
});

test('every earlier unresolved or active attempt holds copying, not only the latest',()=>{
  for(const attempt of [
    {status:'running',provider:'opencode',execution:{phase:'claimed'}},
    {status:'failed',provider:'opencode',execution:{phase:'dispatching'}},
    {status:'failed',provider:'ollama',execution:{phase:'settled'},recovery:{state:'unresolved'}},
    {status:'interrupted',provider:'opencode'},
    {status:'accepted',provider:'unrecognized',execution:{phase:'settled'}},null,
  ]) {
    const source=original();source.attempts.unshift(attempt);
    assert.ok(draftCopyHold(source));assert.throws(()=>copiedDraftScope(source),error=>error.status===409);
  }
  assert.ok(draftCopyHold(original(),{active:true}));
});

test('draft and settled failures can be reused while incomplete records remain held',()=>{
  const source=original();source.status='draft';source.attempts=[];
  assert.equal(draftCopyHold(source),null);
  source.status='interrupted';assert.ok(draftCopyHold(source));
  source.attempts=[{status:'interrupted',provider:'opencode',execution:{phase:'claimed'},recovery:{state:'retry-safe'}}];
  assert.equal(draftCopyHold(source),null);
  source.status='draft';assert.ok(draftCopyHold(source));
  source.status='failed';source.attempts=[{status:'failed',provider:'opencode',execution:{phase:'settled'}}];
  assert.equal(draftCopyHold(source),null);
});
