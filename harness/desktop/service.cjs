const {fork}=require('node:child_process');
const http=require('node:http');
const {randomUUID}=require('node:crypto');
const {EventEmitter}=require('node:events');

function createUtilityWorker(utilityProcess,serverPath,env) {
  const worker=utilityProcess.fork(serverPath,[],{env,stdio:'pipe',serviceName:'CydeWorks AI workspace'});
  const child=new EventEmitter();
  Object.assign(child,{connected:true,exitCode:null,signalCode:null,killed:false,stdout:worker.stdout,stderr:worker.stderr});
  child.send=(message,callback)=>{
    try {
      if(!child.connected)throw Error('Workspace disconnected.');
      worker.postMessage(message);
      if(callback)callback(null);
    } catch(error) {if(callback)callback(error);else throw error;}
  };
  const heartbeat=setInterval(()=>{
    try {if(child.connected)worker.postMessage({type:'bfe-owner-heartbeat'});}
    catch {child.kill();}
  },2000);
  heartbeat.unref();
  child.kill=()=>{clearInterval(heartbeat);child.killed=worker.kill();return child.killed;};
  worker.on('message',message=>child.emit('message',message));
  worker.on('error',error=>child.emit('error',error));
  worker.once('exit',code=>{
    clearInterval(heartbeat);
    child.connected=false;
    child.exitCode=code;
    child.emit('exit',code);
    child.emit('disconnect');
  });
  return child;
}

function requestLocal(url,headers={},timeoutMs=2000,maxBytes=200000) {
  return new Promise((resolve,reject)=>{
    let done=false,response;
    const finish=(error,value)=>{
      if(done)return;
      done=true;
      clearTimeout(timer);
      if(error)reject(error);else resolve(value);
    };
    const request=http.get(url,{headers},res=>{
      response=res;
      let body='',bytes=0;
      res.setEncoding('utf8');
      res.on('data',chunk=>{
        bytes+=Buffer.byteLength(chunk);
        if(bytes>maxBytes){finish(new Error('The local response was too large.'));res.destroy();request.destroy();return;}
        body+=chunk;
      });
      res.on('aborted',()=>finish(new Error('The local response was interrupted.')));
      res.on('error',error=>finish(error));
      res.on('end',()=>finish(null,{status:res.statusCode,body}));
    });
    const timer=setTimeout(()=>{
      const error=new Error('The local request timed out.');
      finish(error);
      response?.destroy();
      request.destroy();
    },timeoutMs);
    request.on('error',error=>finish(error));
  });
}

function launchWorkspace({serverPath,execPath,env,workerFactory,timeoutMs=15000}) {
  return new Promise((resolve,reject)=>{
    const childEnv={...env,BFE_PORT:'0',BFE_DESKTOP_BOOTSTRAP:'1'};
    const child=workerFactory?workerFactory(serverPath,childEnv):fork(serverPath,[],{execPath,env:childEnv,
      windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    child.stdout?.resume();
    child.stderr?.resume();
    let ready=false;
    const timer=setTimeout(()=>fail('The local workspace did not start in time.'),timeoutMs);
    function fail(message) {
      if(ready)return;
      ready=true;
      clearTimeout(timer);
      child.kill();
      reject(new Error(message));
    }
    child.once('error',()=>fail('The local workspace could not start.'));
    child.once('exit',code=>fail('The local workspace exited during startup'+(code===null?'.':' with code '+code+'.')));
    child.on('message',message=>{
      if(ready||message?.type!=='bfe-desktop-ready')return;
      if(!Number.isInteger(message.port)||message.port<1||message.port>65535||
        typeof message.session!=='string'||!/^[a-f0-9]{64}$/.test(message.session)) {
        fail('The local workspace returned an invalid startup response.');
        return;
      }
      ready=true;
      clearTimeout(timer);
      resolve({child,origin:'http://127.0.0.1:'+message.port,session:message.session});
    });
  });
}

function queryWorkspaceStatus(child,timeoutMs=2000) {
  return new Promise((resolve,reject)=>{
    const id=randomUUID();
    let done=false;
    const timer=setTimeout(()=>finish(new Error('Workspace status is unavailable.')),timeoutMs);
    function finish(error,value) {
      if(done)return;
      done=true;
      clearTimeout(timer);
      child.off('message',onMessage);
      child.off('exit',onExit);
      child.off('disconnect',onExit);
      if(error)reject(error);else resolve(value);
    }
    const onMessage=message=>{
      if(message?.type==='bfe-status-result'&&message.id===id&&typeof message.active==='boolean')finish(null,message.active);
    };
    const onExit=()=>finish(new Error('Workspace status is unavailable.'));
    child.on('message',onMessage);
    child.once('exit',onExit);
    child.once('disconnect',onExit);
    if(!child.connected||child.exitCode!==null||child.signalCode!==null)return onExit();
    try { child.send({type:'bfe-status-query',id},error=>{if(error)onExit();}); }
    catch { onExit(); }
  });
}

function createWriteFence() {
  let closing=false,uncertain=false;
  const pending=new Set();
  return {
    beginClose(){closing=true;},
    cancelClose(){closing=false;},
    begin(id){if(closing)return false;pending.add(id);return true;},
    completed(id){pending.delete(id);},
    failed(id){if(pending.delete(id))uncertain=true;},
    async drained(timeoutMs=2000){
      const deadline=Date.now()+timeoutMs;
      while(pending.size&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
      return pending.size===0&&!uncertain;
    },
  };
}
module.exports={createUtilityWorker,launchWorkspace,requestLocal,queryWorkspaceStatus,createWriteFence};
