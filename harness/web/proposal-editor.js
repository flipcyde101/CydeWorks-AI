const normalized=value=>value.replace(/\r\n?/g,'\n');
function lineEndings(value) {
  const withoutCRLF=value.replace(/\r\n/g,'');
  const styles=[value.includes('\r\n')?'\r\n':null,withoutCRLF.includes('\r')?'\r':null,
    withoutCRLF.includes('\n')?'\n':null].filter(Boolean);
  return {separator:styles.length===1?styles[0]:'\n',mixed:styles.length>1};
}

export function bindProposalEditor({openButton,dialog,form,content,status,saveButton,cancelButton,normalizeChoice,normalizeGroup,
  current,submit,onSaved}) {
  let base,busy=false,locked=false;
  const serialized=()=>normalized(content.value).replace(/\n/g,base?.separator??'\n');
  function update() {
    saveButton.disabled=busy||locked||!base||!content.value.trim()||serialized().length>12000||
      normalized(content.value)===base.content||(base.mixed&&!normalizeChoice.checked);
    cancelButton.disabled=busy;
    content.disabled=busy;
    normalizeChoice.disabled=busy;
  }
  openButton.onclick=()=>{
    const task=current();
    if(dialog.open||task?.status!=='review'||!task.artifact?.sha256||typeof task.artifact.content!=='string')return;
    const style=lineEndings(task.artifact.content);
    base={id:task.id,version:task.version,artifactHash:task.artifact.sha256,
      content:normalized(task.artifact.content),separator:style.separator,mixed:style.mixed};
    busy=false;locked=false;content.value=base.content;
    normalizeChoice.checked=false;normalizeGroup.hidden=!base.mixed;
    status.textContent='Saving reruns basic checks. Review accuracy and behavior before accepting.';
    update();dialog.showModal();content.focus();
  };
  content.oninput=update;
  normalizeChoice.onchange=update;
  form.onsubmit=async event=>{
    event.preventDefault();
    update();
    if(saveButton.disabled)return;
    const task=current();
    if(task?.id!==base.id||task.version!==base.version||task.status!=='review'||task.artifact?.sha256!==base.artifactHash) {
      locked=true;status.textContent='The proposal changed. Copy your edits, then close and reopen the editor.';update();return;
    }
    const id=base.id,body={version:base.version,artifactHash:base.artifactHash,content:serialized()};
    busy=true;update();status.textContent='Saving the edited proposal.';
    let result;
    try {
      result=await submit(id,body);
    } catch(error) {
      busy=false;
      if(error?.status===400)status.textContent='The edit was not accepted. Review its content and try again.';
      else {
        locked=true;
        status.textContent=error?.status===409?'The proposal changed. Copy your edits, then close and reopen the editor.'
          :'The save outcome could not be confirmed. Copy your edits, then refresh the task before trying again.';
      }
      update();
      return;
    }
    busy=false;dialog.close();onSaved(id,result);
  };
  cancelButton.onclick=()=>{if(!busy)dialog.close();};
  dialog.oncancel=event=>{if(busy)event.preventDefault();};
  dialog.onclose=()=>{base=undefined;locked=false;content.value='';status.textContent='';
    normalizeChoice.checked=false;normalizeGroup.hidden=true;update();openButton.focus({preventScroll:true});};
}
