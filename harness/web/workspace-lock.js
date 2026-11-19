export const workspaceLockCopy={
  waiting:'This view is locked. Waiting for the workspace to confirm that every view is locked.',
  confirmed:'Workspace session terminated in every view. Approved work keeps running, and terminal control was released. Unlock with the access file.',
  already:'The workspace session had already ended. This view is locked.',
  unconfirmed:'The lock response was lost, so this view locked itself. Whether other views were locked is not confirmed. Unlock with the access file; nothing was sent again.',
};

// Shows the termination message only after the workspace confirms revocation.
// A lost response stays an unconfirmed local lock. send receives exactly {}.
// focusTarget receives focus after confirm when it is visible. A hidden control is left alone.
export function bindWorkspaceLock({openButton,dialog,confirmButton,cancelButton,status,send,onLocalLock,onOutcome,focusTarget}) {
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
    if(focusTarget&&focusTarget.hidden!==true&&typeof focusTarget.focus==='function')focusTarget.focus();
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

// Local generation for one view. Conceal and unlock both move the epoch, so an
// in-flight read or an older lock outcome cannot restore or override the newer state.
export function createSessionEpoch() {
  let epoch=0, locked=false;
  return {
    epoch:()=>epoch,
    locked:()=>locked,
    conceal(){epoch+=1;locked=true;return epoch;},
    unlock(){epoch+=1;locked=false;return epoch;},
    current(at){return at===epoch&&!locked;},
    outcomeCurrent(at){return at===epoch&&locked;},
  };
}
