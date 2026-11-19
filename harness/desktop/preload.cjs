'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('bfeDesktop',{
  claimDocument(){return ipcRenderer.invoke('bfe-desktop-claim');},
});
