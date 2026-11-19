function tabStorage() {try{return globalThis.sessionStorage;}catch{return null;}}
export function bindDraftCopyDialog({openButton,dialog,target,status,copyButton,checkButton,retryButton,closeButton,
  current,submit,lookup,onCopied,nonce=()=>crypto.randomUUID(),storage=tabStorage()}) {
  let source,request,busy=false,uncertain=false,finished=false,storageError=false;
  const key=()=> 'cydeworks-pending-copy:'+source.id;
  function clearPending() {try {storage.removeItem(key());}catch{/* Keeping a resolved identity is safe; lookup can resolve it again. */}}
  function update() {
    copyButton.disabled=busy||uncertain||finished||storageError||!source?.copy?.allowed;
    checkButton.hidden=!uncertain;checkButton.disabled=busy||finished;
    retryButton.hidden=!uncertain;retryButton.disabled=busy||finished;
    closeButton.disabled=busy;
  }
  openButton.onclick=()=>{
    if(busy)return;
    source=current();
    source=source?{id:source.id,version:source.version,title:source.title,copy:source.copy}:null;
    finished=false;uncertain=false;storageError=false;request=null;
    if(source) {
      try {
        const pending=storage.getItem(key());
        if(pending) {
          const saved=JSON.parse(pending);
          if(!Number.isSafeInteger(saved.version)||saved.version<0||typeof saved.requestId!=='string'||
              !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(saved.requestId))
            throw Error('Invalid pending copy identity.');
          request={version:saved.version,requestId:saved.requestId,confirm:true};uncertain=true;
        } else request={version:source.version,confirm:true,requestId:nonce()};
      } catch {storageError=true;}
    }
    target.textContent=source?'Original task: '+source.title:'No task selected.';
    status.textContent=storageError?'Pending copy information could not be retained or read. Copying is held to prevent duplicate drafts.'
      :uncertain?'A previous copy could not be confirmed. Check its result, or explicitly retry the same request. No new request identity will be used.'
      :source?.copy?.allowed?'The copy will be saved as a new draft. Review its scope and select a route before running.'
      :source?.copy?.reason??'Open a saved task first.';
    update();dialog.showModal();
  };
  function complete(taskId) {
    clearPending();
    uncertain=false;finished=true;busy=false;update();dialog.close();onCopied(taskId);
  }
  async function sendCopy(retry=false) {
    if(busy||!request||finished||storageError)return;
    if(retry?!uncertain:copyButton.disabled)return;
    const latest=current();
    if(latest?.id!==source.id||(!retry&&(latest.version!==source.version||!latest.copy?.allowed))) {
      finished=true;status.textContent='The original task changed. Close this dialog and review a fresh copy request.';update();return;
    }
    try {
      storage.setItem(key(),JSON.stringify({version:request.version,requestId:request.requestId}));
    } catch {
      storageError=true;status.textContent='Could not retain the copy request in this tab. Nothing was sent.';update();return;
    }
    busy=true;update();
    status.textContent='Saving the draft copy. Completion time is unavailable until the local workspace responds.';
    try {
      const result=await submit(source.id,request);
      complete(result.task.id);
    } catch(error) {
      if(error.status&&error.status<500&&(!retry||error.status===410)) {
        clearPending();uncertain=false;
        finished=true;status.textContent='The copy request was not accepted: '+error.message;
      } else {
        uncertain=true;
        status.textContent=retry&&error.status&&error.status<500
          ?'The retry was not accepted, but the earlier outcome remains unknown. Keep this request and check its result after restoring access. No new identity was created.'
          :'The copy outcome could not be confirmed. Check its result or explicitly retry the same request. Nothing is retried automatically.';
      }
    } finally {busy=false;update();}
  }
  copyButton.onclick=()=>sendCopy();
  retryButton.onclick=()=>sendCopy(true);
  checkButton.onclick=async()=>{
    if(busy||!uncertain||!request||finished)return;
    busy=true;update();status.textContent='Checking the existing copy request. No new draft is being created.';
    try {const result=await lookup(request.requestId);complete(result.taskId);}
    catch(error) {
      // A missing result is not proof an earlier request cannot still commit.
      status.textContent=error.status===404
        ?'No saved result is visible yet. Keep this request and check again; no new copy was sent.'
        :error.status===410?'The recorded copy was removed. This request will not recreate it.'
        :'The result check could not be completed. Check again when the workspace is reachable.';
      if(error.status===410){clearPending();uncertain=false;finished=true;}
    } finally {busy=false;update();}
  };
  closeButton.onclick=()=>{if(!busy)dialog.close();};
  dialog.oncancel=event=>{if(busy)event.preventDefault();};
  dialog.onclose=()=>{
    target.textContent='';status.textContent='';
    source=undefined;request=undefined;
    openButton.focus({preventScroll:true});
  };
}
