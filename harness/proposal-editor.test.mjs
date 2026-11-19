import test from 'node:test';
import assert from 'node:assert/strict';
import {bindProposalEditor} from './web/proposal-editor.js';

function setup(submit) {
  let current={id:'task-1',version:4,status:'review',artifact:{sha256:'hash-1',content:'Original'}};
  const openButton={focus(){}},form={},content={value:'',focus(){}},status={},saveButton={},cancelButton={},
    normalizeChoice={checked:false},normalizeGroup={hidden:true};
  const dialog={open:false,showModal(){this.open=true;},close(){this.open=false;this.onclose();}};
  let saved;
  bindProposalEditor({openButton,dialog,form,content,status,saveButton,cancelButton,normalizeChoice,normalizeGroup,
    current:()=>current,submit,onSaved:(id,task)=>{saved={id,task};}});
  return {openButton,dialog,form,content,status,saveButton,cancelButton,normalizeChoice,normalizeGroup,
    set current(value){current=value;},get saved(){return saved;}};
}
const event=()=>({preventDefault(){}});

test('proposal editor submits the exact reviewed version and clears its text on close',async()=>{
  const calls=[];
  const ui=setup(async(id,body)=>{calls.push({id,body});return {version:5};});
  ui.openButton.onclick();
  assert.equal(ui.content.value,'Original');
  assert.equal(ui.saveButton.disabled,true);
  ui.content.value='Edited [1]';ui.content.oninput();
  assert.equal(ui.saveButton.disabled,false);
  await ui.form.onsubmit(event());
  assert.deepEqual(calls,[{id:'task-1',body:{version:4,artifactHash:'hash-1',content:'Edited [1]'}}]);
  assert.deepEqual(ui.saved,{id:'task-1',task:{version:5}});
  assert.equal(ui.dialog.open,false);
  assert.equal(ui.content.value,'');
});

test('unknown or stale saves keep edits visible and do not retry automatically',async()=>{
  let calls=0;
  const ui=setup(async()=>{calls++;throw Error('Connection lost');});
  ui.openButton.onclick();ui.content.value='My unsaved work';ui.content.oninput();
  await ui.form.onsubmit(event());
  assert.equal(ui.content.value,'My unsaved work');
  assert.equal(ui.saveButton.disabled,true);
  assert.match(ui.status.textContent,/could not be confirmed/i);
  await ui.form.onsubmit(event());
  assert.equal(calls,1);
  const stale=setup(async()=>{throw Object.assign(Error('Changed'),{status:409});});
  stale.openButton.onclick();stale.content.value='Keep this';stale.content.oninput();
  await stale.form.onsubmit(event());
  assert.equal(stale.content.value,'Keep this');
  assert.equal(stale.saveButton.disabled,true);
  assert.match(stale.status.textContent,/changed/i);
});

test('proposal editor refuses to submit against another task or a changed draft',async()=>{
  let calls=0;
  const ui=setup(async()=>{calls++;});
  ui.openButton.onclick();ui.content.value='Edited';ui.content.oninput();
  ui.current={id:'task-2',version:4,status:'review',artifact:{sha256:'hash-1',content:'Original'}};
  await ui.form.onsubmit(event());
  assert.equal(calls,0);
  assert.equal(ui.saveButton.disabled,true);
  assert.match(ui.status.textContent,/changed/i);
});

test('the draft cannot change while its save is in flight',async()=>{
  let complete;
  const ui=setup(()=>new Promise(resolve=>{complete=resolve;}));
  ui.openButton.onclick();ui.content.value='Saved edit';ui.content.oninput();
  const pending=ui.form.onsubmit(event());
  assert.equal(ui.content.disabled,true);
  assert.equal(ui.cancelButton.disabled,true);
  complete({version:5});
  await pending;
  assert.equal(ui.content.disabled,false);
  assert.equal(ui.content.value,'');
});

test('uniform Windows and CR-only line endings are preserved and unchanged text is not dirty',async()=>{
  for(const ending of ['\r\n','\r']) {
    let sent;
    const ui=setup(async(id,body)=>{sent=body;return {version:5};});
    ui.current={id:'task-1',version:4,status:'review',artifact:{sha256:'hash-1',content:'one'+ending+'two'+ending}};
    ui.openButton.onclick();
    assert.equal(ui.content.value,'one\ntwo\n');
    assert.equal(ui.saveButton.disabled,true);
    assert.equal(ui.normalizeGroup.hidden,true);
    ui.content.value='one\nTWO\n';ui.content.oninput();
    await ui.form.onsubmit(event());
    assert.equal(sent.content,'one'+ending+'TWO'+ending);
  }
});

test('mixed line endings require an explicit choice before normalizing an edit',async()=>{
  let sent;
  const ui=setup(async(id,body)=>{sent=body;return {version:5};});
  ui.current={id:'task-1',version:4,status:'review',artifact:{sha256:'hash-1',content:'one\r\ntwo\nthree'}};
  ui.openButton.onclick();
  assert.equal(ui.normalizeGroup.hidden,false);
  ui.content.value='ONE\ntwo\nthree';ui.content.oninput();
  assert.equal(ui.saveButton.disabled,true);
  ui.normalizeChoice.checked=true;ui.normalizeChoice.onchange();
  assert.equal(ui.saveButton.disabled,false);
  await ui.form.onsubmit(event());
  assert.equal(sent.content,'ONE\ntwo\nthree');
  assert.equal(ui.normalizeChoice.checked,false);
});
