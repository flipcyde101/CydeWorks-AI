import test from 'node:test';
import assert from 'node:assert/strict';
import {bindRemovalDialog} from './web/removal-dialog.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(load,remove) {
  const openButton={focus(){}},target={},preview={},status={},confirmation={value:''},removeButton={},closeButton={};
  const dialog={open:false,showModal(){this.open=true;},close(){this.open=false;this.onclose();}};
  let id='task-one',removed;
  bindRemovalDialog({openButton,dialog,target,preview,status,confirmation,removeButton,closeButton,
    currentTaskId:()=>id,load,remove,onRemoved:value=>{removed=value;}});
  return {openButton,dialog,target,preview,status,confirmation,removeButton,closeButton,
    set id(value){id=value;},get removed(){return removed;}};
}
const ready=()=>({allowed:true,title:'Example task',version:2,expiresAt:100,token:'x',removes:['Record'],retains:['Backups'],limitations:['Not secure erasure']});

test('removal requires the exact typed confirmation and submits the reviewed preview once',async()=>{
  const calls=[];
  const ui=setup(async()=>ready(),async(id,body)=>{calls.push({id,body});});
  await ui.openButton.onclick();
  assert.equal(ui.target.textContent,'Task: Example task');
  assert.match(ui.preview.textContent,/Backups/);
  assert.equal(ui.removeButton.disabled,true);
  ui.confirmation.value='remove';ui.confirmation.oninput();
  assert.equal(ui.removeButton.disabled,true);
  ui.confirmation.value='REMOVE';ui.confirmation.oninput();
  assert.equal(ui.removeButton.disabled,false);
  await ui.removeButton.onclick();
  assert.equal(calls.length,1);
  assert.equal(calls[0].body.version,2);
  assert.equal(calls[0].body.confirmation,'REMOVE');
  assert.equal(ui.removed,'task-one');
  assert.equal(ui.dialog.open,false);
});

test('a stale preview or unknown submission outcome cannot be replayed',async()=>{
  let finish;
  const ui=setup(()=>new Promise(resolve=>{finish=resolve;}),async()=>{});
  const opening=ui.openButton.onclick();
  ui.id='task-two';finish(ready());await opening;
  ui.confirmation.value='REMOVE';ui.confirmation.oninput();
  assert.equal(ui.removeButton.disabled,true);
  let calls=0;
  const failed=setup(async()=>ready(),async()=>{calls++;throw Error('Connection lost');});
  await failed.openButton.onclick();
  failed.confirmation.value='REMOVE';failed.confirmation.oninput();
  await failed.removeButton.onclick();
  await tick();
  assert.equal(failed.removeButton.disabled,true);
  assert.match(failed.status.textContent,/could not be confirmed/);
  await failed.removeButton.onclick();
  assert.equal(calls,1);
  const absent=setup(async()=>ready(),async()=>{throw Object.assign(Error('Not found'),{status:404});});
  await absent.openButton.onclick();
  absent.confirmation.value='REMOVE';absent.confirmation.oninput();
  await absent.removeButton.onclick();
  assert.match(absent.status.textContent,/no longer in the workspace/);
});
