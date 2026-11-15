export function bindExportDialog({openButton,dialog,mode,description,status,preview,saveButton,closeButton,
  currentTaskId,load,download}) {
  let revision=0,content;
  async function refresh() {
    const stamp=++revision, id=currentTaskId(), selected=mode.value;
    content=undefined;
    saveButton.disabled=true;
    preview.textContent='';
    status.textContent='Preparing export preview.';
    description.textContent=selected==='minimal'
      ? 'Omits the task name, file name, source, request, model name, identifiers, timestamps and terminal history.'
      : 'Includes task name, file name, model identifiers, timestamps and operational history. Excludes the request, source and proposal.';
    try {
      const data=await load(id,selected);
      if(stamp!==revision||currentTaskId()!==id||!dialog.open)return;
      content=JSON.stringify(data,null,2);
      preview.textContent=content;
      saveButton.disabled=false;
      status.textContent='Preview ready.';
    } catch(error) {
      if(stamp===revision)status.textContent='Preview unavailable: '+error.message;
    }
  }
  openButton.onclick=()=>{mode.value='minimal';dialog.showModal();void refresh();};
  mode.onchange=()=>{void refresh();};
  saveButton.onclick=()=>{
    if(!content)return;
    download(content);
    dialog.close();
  };
  closeButton.onclick=()=>dialog.close();
  dialog.onclose=()=>{revision++;content=undefined;preview.textContent='';openButton.focus({preventScroll:true});};
}
