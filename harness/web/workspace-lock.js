export const workspaceLockCopy={
  waiting:'This view is locked. Waiting for the workspace to confirm that every view is locked.',
  confirmed:'Workspace session terminated in every view. Approved work keeps running, and terminal control was released. Unlock with the access file.',
  already:'The workspace session had already ended. This view is locked.',
  unconfirmed:'The lock response was lost, so this view locked itself. Whether other views were locked is not confirmed. Unlock with the access file; nothing was sent again.',
};

// Shows the termination message only after the workspace confirms revocation.
// A lost response stays an unconfirmed local lock. send receives exactly {}.
export function bindWorkspaceLock({openButton,dialog,confirmButton,cancelButton,status,send,onLocalLock,onOutcome}) {
  let pending=false;
  openButton.onclick=()=>{
    if(pending)return;
    status.textContent='';
    dialog.showModal();
  };
  cancelButton.onclick=()=>{
    dialog.close();
    openButton.focus();
  };
  confirmButton.onclick=async()=>{
    if(pending)return;
    pending=true;
    confirmButton.disabled=true;
    dialog.close();
    onLocalLock();
    status.textContent=workspaceLockCopy.waiting;
    let outcome='unconfirmed';
    try {
      const result=await send({});
      outcome=result?.locked===true?'confirmed':'unconfirmed';
    } catch(error) {
      outcome=error?.status===401?'already':'unconfirmed';
    } finally {
      pending=false;
      confirmButton.disabled=false;
    }
    status.textContent=workspaceLockCopy[outcome];
    onOutcome(outcome);
  };
}
