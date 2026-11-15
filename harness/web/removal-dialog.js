export function bindRemovalDialog({openButton,dialog,target,preview,status,confirmation,removeButton,closeButton,
  currentTaskId,load,remove,onRemoved}) {
  let revision=0,approval,busy=false;
  const update=()=>{removeButton.disabled=busy||!approval?.allowed||confirmation.value!=='REMOVE';};
  openButton.onclick=async()=>{
    const stamp=++revision,id=currentTaskId();
    approval=undefined;busy=false;confirmation.value='';target.textContent='';preview.textContent='';
    status.textContent='Preparing a removal preview.';
    update();
    dialog.showModal();
    try {
      const data=await load(id);
      if(stamp!==revision||currentTaskId()!==id||!dialog.open)return;
      approval=data;
      target.textContent='Task: '+data.title;
      preview.textContent=['Will remove:',...data.removes.map(item=>'• '+item),'',
        'Will retain:',...data.retains.map(item=>'• '+item),'',
        'Limitations:',...data.limitations.map(item=>'• '+item)].join('\n');
      status.textContent=data.allowed?'Review the scope, then type REMOVE to confirm.':data.reason;
      update();
    } catch(error) {
      if(stamp===revision&&dialog.open)status.textContent='Preview unavailable: '+error.message;
    }
  };
  confirmation.oninput=update;
  removeButton.onclick=async()=>{
    if(busy||!approval?.allowed||confirmation.value!=='REMOVE')return;
    const id=currentTaskId(),request={version:approval.version,expiresAt:approval.expiresAt,
      token:approval.token,confirmation:confirmation.value};
    busy=true;closeButton.disabled=true;update();
    status.textContent='Removing the workspace record.';
    try {
      await remove(id,request);
      busy=false;closeButton.disabled=false;
      dialog.close();
      onRemoved(id);
    } catch(error) {
      approval=undefined;
      status.textContent=error.status===404?'The record is no longer in the workspace. Refresh the task list.'
        :error.status&&error.status<500?'This removal request was not accepted: '+error.message
        :'The outcome could not be confirmed. Refresh the task list before trying again. No action was repeated.';
    } finally {busy=false;closeButton.disabled=false;update();}
  };
  closeButton.onclick=()=>{if(!busy)dialog.close();};
  dialog.oncancel=event=>{if(busy)event.preventDefault();};
  dialog.onclose=()=>{revision++;approval=undefined;confirmation.value='';target.textContent='';preview.textContent='';update();openButton.focus({preventScroll:true});};
}
