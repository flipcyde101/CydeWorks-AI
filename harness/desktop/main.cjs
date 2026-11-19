const {app,BrowserWindow,dialog,session,utilityProcess,ipcMain}=require('electron');
const {randomUUID,randomBytes}=require('node:crypto');
const {mkdirSync}=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {createUtilityWorker,launchWorkspace,requestLocal,queryWorkspaceStatus,createWriteFence}=require('./service.cjs');
const {desktopChildEnvironment}=require('./environment.cjs');
const {createLauncherClaimGate}=require('./claim.cjs');

const root=path.resolve(__dirname,'..');
const desktopData=path.join(root,'.state','desktop');
mkdirSync(desktopData,{recursive:true});
app.setPath('userData',desktopData);
let service,window,browserSession,claimGate=null,serviceAlive=false,allowClose=false,closing=false;
const writeFence=createWriteFence();
async function legacyPreviewActive() {
  try { await requestLocal('http://127.0.0.1:15371/'); return true; }
  catch(error) { if(error.code==='ECONNREFUSED')return false; throw error; }
}
function childEnvironment() {
  const temporary=path.join(desktopData,'temp');
  mkdirSync(temporary,{recursive:true});
  return desktopChildEnvironment(process.env,temporary);
}
async function activeRunState() {
  if(!serviceAlive||!service?.child.connected)return 'unknown';
  try {
    const active=await queryWorkspaceStatus(service.child);
    return serviceAlive?(active?'running':'idle'):'unknown';
  } catch { return 'unknown'; }
}
function postDesktopClaim({origin,cookie,proof}) {
  const payload=Buffer.from('{}');
  return new Promise((resolve,reject)=>{
    const req=http.request(origin+'/api/desktop-view',{method:'POST',headers:{
      Origin:origin,Cookie:'bfe_session='+cookie,'Content-Type':'application/json',Accept:'application/json',
      'Content-Length':payload.length,'X-Desktop-Claim':proof,
    }},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>{
        let body=null;
        try { body=JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { body=null; }
        resolve({status:res.statusCode,body});
      });
    });
    req.on('error',()=>reject(Error('The desktop claim could not be completed.')));
    req.setTimeout(5000,()=>req.destroy(Error('The desktop claim timed out.')));
    req.end(payload);
  });
}
function bindClaimProof(child, proof) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(Error('The desktop claim could not be bound.'));},5000);
    timer.unref();
    function onMessage(message) {
      if(message?.type!=='bfe-desktop-claim-bound')return;
      cleanup();
      if(message.ok===true)resolve();
      else reject(Error('The desktop claim could not be bound.'));
    }
    function onExit() {
      cleanup();
      reject(Error('The local workspace stopped during startup.'));
    }
    function cleanup() {
      clearTimeout(timer);
      child.off('message',onMessage);
      child.off('exit',onExit);
    }
    child.on('message',onMessage);
    child.on('exit',onExit);
    try { child.send({type:'bfe-desktop-claim-bind',proof}); }
    catch { cleanup(); reject(Error('The desktop claim could not be bound.')); }
  });
}
ipcMain.handle('bfe-desktop-claim',event=>{
  if(!claimGate||!window||window.isDestroyed()||!serviceAlive)return null;
  const frame=event.senderFrame;
  let frameOrigin='';
  try { frameOrigin=frame?.url?new URL(frame.url).origin:''; }
  catch { frameOrigin=''; }
  const frameIsMain=!!frame&&event.sender?.mainFrame===frame;
  return claimGate.claim({
    senderWebContentsId:event.sender?.id,
    frameIsMain,
    frameOrigin,
  });
});
async function createWorkspace() {
  // Older previews did not participate in the workspace lock. Do not open
  // the same workspace alongside the known legacy preview address.
  if(await legacyPreviewActive()) throw Error('The existing browser preview is still running. Close it before opening the desktop workspace.');
  service=await launchWorkspace({serverPath:path.join(root,'server.mjs'),env:childEnvironment(),
    workerFactory:(serverPath,env)=>createUtilityWorker(utilityProcess,serverPath,env)});
  serviceAlive=true;
  service.child.once('exit',()=>{
    serviceAlive=false;
    claimGate?.disarm();
    if(browserSession)void browserSession.closeAllConnections().catch(()=>{});
    if(window&&!window.isDestroyed()) {
      window.webContents.stop();
      window.destroy();
      if(!allowClose)dialog.showErrorBox('Workspace disconnected','The local workspace stopped. Reopen the app to inspect saved task state.');
      if(!allowClose)app.quit();
    }
  });
  if(service.child.exitCode!==null||service.child.signalCode!==null)throw Error('The local workspace stopped during startup.');
  const launcherSession=service.session;
  const claimProof=randomBytes(32).toString('hex');
  try { await bindClaimProof(service.child, claimProof); }
  catch(error) { service.session=undefined; throw error; }
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
  await browserSession.cookies.set({url:service.origin+'/api',name:'bfe_session',value:launcherSession,
    path:'/api',httpOnly:true,sameSite:'strict'});
  service.session=undefined;
  if(!serviceAlive)throw Error('The local workspace stopped during startup.');
  window=new BrowserWindow({width:1280,height:850,minWidth:720,minHeight:560,show:false,
    title:'CydeWorks AI',webPreferences:{preload:path.join(__dirname,'preload.cjs'),session:browserSession,nodeIntegration:false,contextIsolation:true,
      sandbox:true,webSecurity:true,webviewTag:false}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{
    try { if(!serviceAlive||new URL(url).origin!==service.origin)event.preventDefault(); }
    catch { event.preventDefault(); }
  });
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  claimGate=createLauncherClaimGate({
    proof:claimProof,
    serviceOrigin:service.origin,
    intendedWebContentsId:()=>window?.webContents?.id,
    post:({proof})=>postDesktopClaim({origin:service.origin,cookie:launcherSession,proof}),
  });
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
