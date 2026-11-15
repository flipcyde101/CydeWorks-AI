const {app,BrowserWindow,dialog,session,utilityProcess}=require('electron');
const {randomUUID}=require('node:crypto');
const {mkdirSync}=require('node:fs');
const path=require('node:path');
const {createUtilityWorker,launchWorkspace,requestLocal,queryWorkspaceStatus,createWriteFence}=require('./service.cjs');

const root=path.resolve(__dirname,'..');
const desktopData=path.join(root,'.state','desktop');
mkdirSync(desktopData,{recursive:true});
app.setPath('userData',desktopData);
let service,window,browserSession,serviceAlive=false,allowClose=false,closing=false;
const writeFence=createWriteFence();
async function legacyPreviewActive() {
  try { await requestLocal('http://127.0.0.1:15371/'); return true; }
  catch(error) { if(error.code==='ECONNREFUSED')return false; throw error; }
}
function childEnvironment() {
  const env=Object.fromEntries(['PATH','PATHEXT','SystemRoot','WINDIR','ComSpec','LANG','LC_ALL','BFE_OLLAMA_PORT']
    .filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
  const temporary=path.join(desktopData,'temp');
  mkdirSync(temporary,{recursive:true});
  Object.assign(env,{TEMP:temporary,TMP:temporary});
  return env;
}
async function activeRunState() {
  if(!serviceAlive||!service?.child.connected)return 'unknown';
  try {
    const active=await queryWorkspaceStatus(service.child);
    return serviceAlive?(active?'running':'idle'):'unknown';
  } catch { return 'unknown'; }
}
async function createWorkspace() {
  // Older previews did not participate in the workspace lock. Do not open
  // the same workspace alongside the known legacy preview address.
  if(await legacyPreviewActive()) throw Error('The existing browser preview is still running. Close it before opening the desktop workspace.');
  service=await launchWorkspace({serverPath:path.join(root,'server.mjs'),env:childEnvironment(),
    workerFactory:(serverPath,env)=>createUtilityWorker(utilityProcess,serverPath,env)});
  serviceAlive=true;
  service.child.once('exit',()=>{
    serviceAlive=false;
    if(browserSession)void browserSession.closeAllConnections().catch(()=>{});
    if(window&&!window.isDestroyed()) {
      window.webContents.stop();
      window.destroy();
      if(!allowClose)dialog.showErrorBox('Workspace disconnected','The local workspace stopped. Reopen the app to inspect saved task state.');
      if(!allowClose)app.quit();
    }
  });
  if(service.child.exitCode!==null||service.child.signalCode!==null)throw Error('The local workspace stopped during startup.');
  browserSession=session.fromPartition('bfe-desktop-'+randomUUID());
  browserSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  browserSession.setPermissionCheckHandler(()=>false);
  browserSession.webRequest.onBeforeRequest((details,callback)=>{
    try {
      const mutating=!['GET','HEAD','OPTIONS'].includes(details.method.toUpperCase());
      let cancel=!serviceAlive||new URL(details.url).origin!==service.origin;
      if(!cancel&&mutating)cancel=!writeFence.begin(details.id);
      callback({cancel});
    }
    catch { callback({cancel:true}); }
  });
  browserSession.webRequest.onCompleted(details=>writeFence.completed(details.id));
  browserSession.webRequest.onErrorOccurred(details=>writeFence.failed(details.id));
  await browserSession.cookies.set({url:service.origin+'/api',name:'bfe_session',value:service.session,
    path:'/api',httpOnly:true,sameSite:'strict'});
  service.session=undefined;
  if(!serviceAlive)throw Error('The local workspace stopped during startup.');
  window=new BrowserWindow({width:1280,height:850,minWidth:720,minHeight:560,show:false,
    title:'CydeWorks AI',webPreferences:{session:browserSession,nodeIntegration:false,contextIsolation:true,
      sandbox:true,webSecurity:true,webviewTag:false}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{
    try { if(!serviceAlive||new URL(url).origin!==service.origin)event.preventDefault(); }
    catch { event.preventDefault(); }
  });
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  window.on('close',event=>{
    if(allowClose)return;
    event.preventDefault();
    if(closing)return;
    closing=true;
    writeFence.beginClose();
    void (async()=>{
      const drained=await writeFence.drained();
      if(!serviceAlive||!window||window.isDestroyed())return;
      const state=drained?await activeRunState():'unknown';
      if(!serviceAlive||!window||window.isDestroyed())return;
      if(state!=='idle') {
        const choice=await dialog.showMessageBox(window,{type:'warning',title:'A task may still be running',
          message:'Closing the workspace may interrupt observation of a task.',
          detail:'The run may continue and its outcome may need recovery when you reopen the app.',
          buttons:['Keep open','Close anyway'],defaultId:0,cancelId:0,noLink:true});
        if(!serviceAlive||!window||window.isDestroyed())return;
        if(choice.response!==1){closing=false;writeFence.cancelClose();return;}
      }
      allowClose=true;
      window.close();
    })().catch(()=>{
      if(serviceAlive&&window&&!window.isDestroyed()) {
        closing=false;
        writeFence.cancelClose();
        dialog.showErrorBox('Could not close safely','The workspace status could not be checked. The window remains open.');
      }
    });
  });
  await window.loadURL(service.origin+'/');
  window.show();
}
app.whenReady().then(createWorkspace).catch(error=>{
  dialog.showErrorBox('CydeWorks AI could not open',error.message);
  app.quit();
});
app.on('window-all-closed',()=>app.quit());
app.on('will-quit',()=>{if(service?.child&&!service.child.killed)service.child.kill();});
