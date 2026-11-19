import test from 'node:test';
import assert from 'node:assert/strict';
import {bindDraftCopyDialog} from './web/draft-copy-dialog.js';
const requestId='11111111-1111-4111-8111-111111111111';
function memoryStorage() {const map=new Map();return {getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};}
function rig({submit=async()=>({task:{id:'new'}}),lookup=async()=>({taskId:'new'}),storage=memoryStorage()}={}) {
  let task={id:'old',version:3,title:'Original',copy:{allowed:true}},opened;
  const openButton={focus(){}},target={},status={},copyButton={},checkButton={},retryButton={},closeButton={};
  const dialog={open:false,showModal(){this.open=true;},close(){this.open=false;this.onclose();}};
  bindDraftCopyDialog({openButton,dialog,target,status,copyButton,checkButton,retryButton,closeButton,current:()=>task,submit,lookup,storage,
    nonce:()=>requestId,onCopied:id=>{opened=id;}});
  return {openButton,dialog,target,status,copyButton,checkButton,retryButton,closeButton,get opened(){return opened;},
    get task(){return task;},set task(value){task=value;}};
}
test('draft copy submits the exact viewed version once and opens saved result',async()=>{
  const calls=[];let finish;
  const r=rig({submit:(id,body)=>{calls.push({id,body});return new Promise(resolve=>{finish=resolve;});}});
  r.openButton.onclick();const pending=r.copyButton.onclick();await r.copyButton.onclick();
  assert.equal(calls.length,1);assert.equal(r.closeButton.disabled,true);
  assert.deepEqual(calls[0],{id:'old',body:{version:3,confirm:true,requestId}});
  finish({task:{id:'new'}});await pending;
  assert.equal(r.opened,'new');assert.equal(r.dialog.open,false);
});
test('changed or blocked source cannot be copied from an old dialog',async()=>{
  let calls=0;const r=rig({submit:async()=>{calls++;}});r.openButton.onclick();r.task.version=4;
  await r.copyButton.onclick();assert.equal(calls,0);assert.equal(r.copyButton.disabled,true);
  r.closeButton.onclick();r.task.copy={allowed:false,reason:'Outcome unresolved'};
  r.openButton.onclick();assert.equal(r.copyButton.disabled,true);assert.match(r.status.textContent,/unresolved/);
});
test('uncertain copy survives close and reopen, and only read-only result checks follow',async()=>{
  let creates=0,reads=0;
  const r=rig({submit:async()=>{creates++;throw Error('Connection dropped');},lookup:async id=>{
    reads++;assert.equal(id,requestId);
    if(reads===1)throw Object.assign(Error('Not yet visible'),{status:404});return {taskId:'saved-copy'};
  }});
  r.openButton.onclick();await r.copyButton.onclick();
  assert.equal(r.checkButton.hidden,false);r.closeButton.onclick();
  r.openButton.onclick();assert.match(r.target.textContent,/Original/);
  await r.copyButton.onclick();await r.checkButton.onclick();
  assert.match(r.status.textContent,/No saved result/);assert.equal(r.copyButton.disabled,true);
  await r.checkButton.onclick();assert.equal(creates,1);assert.equal(reads,2);assert.equal(r.opened,'saved-copy');
});
test('reload restores pending identity per source without storing task text or blocking unrelated tasks',async()=>{
  const storage=memoryStorage();let creates=0;
  const submit=async()=>{creates++;throw Error('Lost response');};
  const r=rig({storage,submit});r.openButton.onclick();await r.copyButton.onclick();
  const serialized=storage.getItem('cydeworks-pending-copy:old');
  assert.deepEqual(JSON.parse(serialized),{version:3,requestId});
  const reload=rig({storage,submit});reload.openButton.onclick();
  assert.equal(reload.copyButton.disabled,true);assert.equal(reload.checkButton.hidden,false);
  await reload.copyButton.onclick();assert.equal(creates,1);
  reload.closeButton.onclick();reload.task={...reload.task,id:'other',title:'Other task'};reload.openButton.onclick();
  assert.equal(reload.copyButton.disabled,false);assert.equal(reload.checkButton.hidden,true);
  reload.closeButton.onclick();reload.task={...reload.task,id:'old'};reload.openButton.onclick();
  await reload.checkButton.onclick();assert.equal(reload.opened,'new');
  assert.equal(storage.getItem('cydeworks-pending-copy:old'),null);
});
test('explicit retry preserves the same approved identity and never starts automatically',async()=>{
  const calls=[];const r=rig({submit:async(id,body)=>{calls.push({...body});if(calls.length===1)throw Error('Dropped');return {task:{id:'same-copy'}};}});
  r.openButton.onclick();await r.copyButton.onclick();
  assert.equal(calls.length,1);await r.retryButton.onclick();
  assert.deepEqual(calls[0],calls[1]);assert.equal(r.opened,'same-copy');
});
test('unavailable storage prevents any create request',async()=>{
  let calls=0;
  const r=rig({storage:{getItem:()=>null,setItem(){throw Error('Unavailable');}},submit:async()=>{calls++;}});
  r.openButton.onclick();await r.copyButton.onclick();assert.equal(calls,0);
  assert.equal(r.copyButton.disabled,true);assert.match(r.status.textContent,/Nothing was sent/);
});
test('rejected retry cannot erase an earlier unknown commit across reload',async()=>{
  for(const statusCode of [400,401,403,404,409,429]) {
    const storage=memoryStorage();let calls=0;
    const r=rig({storage,submit:async()=>{calls++;if(calls===1)throw Error('Lost response');
      throw Object.assign(Error('Retry rejected'),{status:statusCode});}});
    r.openButton.onclick();await r.copyButton.onclick();await r.retryButton.onclick();
    assert.deepEqual(JSON.parse(storage.getItem('cydeworks-pending-copy:old')),{version:3,requestId});
    const reload=rig({storage});reload.openButton.onclick();
    assert.equal(reload.copyButton.disabled,true);assert.equal(reload.checkButton.hidden,false);
    await reload.checkButton.onclick();assert.equal(reload.opened,'new');
  }
});
test('removed result is never recreated and known rejection requires a fresh preview',async()=>{
  const r=rig({submit:async()=>{throw Error('Unknown');},lookup:async()=>{throw Object.assign(Error('Removed'),{status:410});}});
  r.openButton.onclick();await r.copyButton.onclick();await r.checkButton.onclick();
  assert.equal(r.copyButton.disabled,true);assert.match(r.status.textContent,/removed/);
  const rejected=rig({submit:async()=>{throw Object.assign(Error('Changed'),{status:409});}});
  rejected.openButton.onclick();await rejected.copyButton.onclick();
  assert.equal(rejected.copyButton.disabled,true);assert.equal(rejected.checkButton.hidden,true);
});
