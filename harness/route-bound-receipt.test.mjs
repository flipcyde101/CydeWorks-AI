import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {acceptedTask,sha} from './test-support/receipt-synthetic.mjs';
import {exportReceipt} from './receipt-export.mjs';
import {terminalWorkspace} from './test-support/terminal-workspace.mjs';

function bind(task,...values) {
  const revision=values.length?values[0]:'a'.repeat(64);
  const attempt=task.attempts[0];attempt.approvedRouteRevision=revision;
  attempt.scopeHash=sha(JSON.stringify([task.sourceHash,task.request,task.expected,task.kind,
    attempt.model,attempt.provider,attempt.backend,
    attempt.backend==='llamacpp'?attempt.approvedModelFingerprint:attempt.approvedModelDigest,
    ['routeRevision',revision]]));
  return task;
}
test('receipt verifies route-bound approval hash without weakening legacy or mismatch checks',()=>{
  assert.equal(exportReceipt(acceptedTask()).available,true);
  const task=bind(acceptedTask());
  assert.equal(exportReceipt(task).available,true);
  task.attempts[0].approvedRouteRevision='b'.repeat(64);
  assert.equal(exportReceipt(task).available,false);
  delete task.attempts[0].approvedRouteRevision;
  assert.equal(exportReceipt(task).available,false);
  for(const value of [null,undefined,'',123,'z'.repeat(64)]) {
    assert.equal(exportReceipt(bind(acceptedTask(),value)).available,false);
  }
  let calls=0;
  const getter=acceptedTask();Object.defineProperty(getter.attempts[0],'approvedRouteRevision',{get(){calls++;return 'a'.repeat(64);}});
  assert.equal(exportReceipt(getter).available,false);assert.equal(calls,0);
});

test('actual host route-bound run exports a usable receipt after acceptance',{timeout:15000},async t=>{
  const {request,path,task}=await terminalWorkspace(t,{startImmediately:false,configure:folder=>
    writeFile(join(folder,'providers.mjs'),`
export const ollamaEndpoint='http://127.0.0.1:1';
export const ollama={inspect:async()=>({models:[]})};
export const fixture={models:async()=>[{id:'fixture'}],run:async()=>({settled:true,
artifact:{summary:'Synthetic result',content:'After'},usage:null})};
`)});
  const inventory=await (await request('/api/models')).json();
  const route=inventory.models.find(row=>row.id==='fixture');
  assert.equal((await request(path+'/run',{version:task.version,sourceHash:task.sourceHash,
    approve:true,model:'fixture',engine:'fixture',routeRevision:route.revision})).status,202);
  let current;
  for(let i=0;i<100;i++) {
    current=await (await request(path)).json();if(current.status!=='running')break;
    await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(current.status,'review');
  assert.equal((await request(path+'/review',{version:current.version,artifactHash:current.attempts[0].artifact.sha256,
    decision:'accepted'})).status,200);
  const response=await request(path+'/receipt'),receipt=await response.json();
  assert.equal(response.status,200);assert.equal(receipt.available,true,JSON.stringify(receipt.reasons));
  assert.equal(receipt.run.accepted,true);assert.equal(receipt.run.attempts[0].cost,null);
});
