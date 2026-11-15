import test from 'node:test';
import assert from 'node:assert/strict';
import {bindExportDialog} from './web/export-dialog.js';

function setup(load) {
  const openButton={focus(){this.focused=true;}},mode={value:''},description={},status={},preview={},saveButton={},closeButton={};
  const dialog={open:false,showModal(){this.open=true;},close(){this.open=false;this.onclose();}};
  let downloaded;
  bindExportDialog({openButton,dialog,mode,description,status,preview,saveButton,closeButton,
    currentTaskId:()=> 'task-one',load,download:content=>{downloaded=content;}});
  return {openButton,dialog,mode,description,status,preview,saveButton,closeButton,get downloaded(){return downloaded;}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('export defaults to minimal and downloads exactly the displayed preview',async()=>{
  const seen=[];
  const ui=setup(async(id,mode)=>{seen.push({id,mode});return {mode,task:{status:'accepted'}};});
  ui.openButton.onclick();
  await tick();
  assert.deepEqual(seen,[{id:'task-one',mode:'minimal'}]);
  assert.equal(ui.mode.value,'minimal');
  assert.equal(ui.saveButton.disabled,false);
  const visible=ui.preview.textContent;
  ui.saveButton.onclick();
  assert.equal(ui.downloaded,visible);
  assert.equal(ui.dialog.open,false);
  assert.equal(ui.preview.textContent,'');
  assert.equal(ui.openButton.focused,true);
});

test('a slower earlier export cannot overwrite a later selection',async()=>{
  const requests=[];
  const ui=setup((id,mode)=>new Promise(resolve=>requests.push({id,mode,resolve})));
  ui.openButton.onclick();
  ui.mode.value='standard';
  ui.mode.onchange();
  requests[1].resolve({mode:'standard'});
  await tick();
  requests[0].resolve({mode:'minimal'});
  await tick();
  assert.equal(JSON.parse(ui.preview.textContent).mode,'standard');
  ui.saveButton.onclick();
  assert.equal(JSON.parse(ui.downloaded).mode,'standard');
});

test('failed and closed previews cannot download a stale result',async()=>{
  let resolve;
  const ui=setup(()=>new Promise(done=>{resolve=done;}));
  ui.openButton.onclick();
  ui.closeButton.onclick();
  resolve({mode:'minimal'});
  await tick();
  ui.saveButton.onclick();
  assert.equal(ui.downloaded,undefined);
  assert.equal(ui.preview.textContent,'');
  const failure=setup(async()=>{throw Error('Service unavailable');});
  failure.openButton.onclick();
  await tick();
  assert.equal(failure.saveButton.disabled,true);
  assert.match(failure.status.textContent,/Service unavailable/);
});
