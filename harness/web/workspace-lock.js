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
    const epoch=onLocalLock();
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
    // A later Lock has its own epoch. This response may publish only its own.
    if(onOutcome(outcome, epoch)!==false) status.textContent=workspaceLockCopy[outcome];
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

// DOM-free view rules for legacy Lock. Each returned epoch belongs to that call.
// A later Lock or conceal does not replace an earlier request's epoch.
export function createLegacySessionController(gate=createSessionEpoch()) {
  const view={
    workspaceHidden:true,
    workspaceInert:false,
    unlockHidden:false,
    unlockDisabled:false,
    polling:false,
    lease:null,
    fields:{source:'',filename:''},
    downloads:[],
    dialogs:[],
    runs:0,
    notice:null,
    uiWrites:0,
    concealed:false,
  };
  const capture=()=>({epoch:gate.epoch()});
  const current=token=>!!token&&gate.current(token.epoch);
  function hideWorkspace() {
    view.workspaceHidden=true;
    view.workspaceInert=true;
    view.polling=false;
    view.concealed=true;
    view.unlockHidden=false;
    view.unlockDisabled=false;
    for(const dialog of view.dialogs) {
      dialog.open=false;
      dialog.inert=true;
      dialog.cached=null;
    }
  }
  function staleResult() {
    const error=Error('The workspace session changed before this result could be shown.');
    error.stale=true;
    return error;
  }
  return {
    gate,
    view,
    capture,
    current,
    useDialogs(entries){view.dialogs=entries;},
    openDialog(dialog) {
      dialog.open=true;
      dialog.inert=false;
      view.dialogs.push(dialog);
    },
    noteAccessHidden() {
      view.unlockHidden=true;
      view.workspaceHidden=false;
      view.workspaceInert=false;
      view.concealed=false;
    },
    beginLock() {
      const token={epoch:gate.conceal()};
      hideWorkspace();
      view.lease=null;
      return token;
    },
    finishLock(token, outcome) {
      if(!token||!gate.outcomeCurrent(token.epoch))return false;
      view.notice=outcome;
      return true;
    },
    failRestore(token) {
      if(!current(token))return 'stale';
      gate.conceal();
      hideWorkspace();
      view.unlockHidden=false;
      view.unlockDisabled=false;
      view.polling=false;
      return 'recovered';
    },
    allowDownload(dialog) {
      if(gate.locked()||view.workspaceInert||!dialog||dialog.inert||!dialog.open||dialog.cached==null)return false;
      view.downloads.push(dialog.cached);
      return true;
    },
    async settle(token, work) {
      const value=await work();
      if(!current(token))throw staleResult();
      return value;
    },
    async readSource(read) {
      const token=capture();
      let text;
      try { text=await read(); }
      catch(error) {
        if(!current(token))return false;
        throw error;
      }
      if(!text||!current(token))return false;
      view.fields.source=text.source;
      view.fields.filename=text.filename;
      view.uiWrites+=1;
      return true;
    },
    async takeControl(read) {
      const token=capture();
      let lease;
      try { lease=await read(); }
      catch(error) {
        if(!current(token))return false;
        throw error;
      }
      if(!current(token))return false;
      view.lease=lease;
      view.polling=false;
      view.uiWrites+=1;
      return true;
    },
    async runApproved(read) {
      const token=capture();
      let result;
      try { result=await read(); }
      catch(error) {
        if(!current(token))return false;
        throw error;
      }
      if(!current(token))return false;
      view.runs+=1;
      view.polling=true;
      view.uiWrites+=1;
      return result;
    },
  };
}
