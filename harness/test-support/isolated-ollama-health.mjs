import {spawn,spawnSync} from 'node:child_process';
import {mkdir,lstat,realpath,unlink,access} from 'node:fs/promises';
import {resolve,join,sep,parse,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {freemem} from 'node:os';
import {directJson} from './direct-loopback.mjs';

// Owner-approved one-time health check. No model is loaded and no original model store is opened.
const project=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const work=join(project,'work');
const home=join(work,'ollama-isolated-probe-20261114');
const executable='D:\\Apps\\Ollama\\ollama.exe';
const validationEnv=Object.fromEntries(['PATH','PATHEXT','SystemRoot','WINDIR','ComSpec'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
if(process.platform!=='win32'||process.env.BFE_APPROVED_ISOLATED_HEALTH!=='1')throw Error('The approved Windows test is not enabled.');
if(freemem()<2*1024*1024*1024)throw Error('Available system memory is below the health-check reserve.');
const workInfo=await lstat(work);
if(!workInfo.isDirectory()||workInfo.isSymbolicLink())throw Error('The project work directory is not a plain directory.');
const realProject=await realpath(project),realWork=await realpath(work);
if(!realWork.startsWith(realProject+sep))throw Error('The test work directory is outside the project.');
noReparsePoints([work]);
await mkdir(home);
const realHome=await realpath(home);
if(!realHome.startsWith(realWork+sep))throw Error('The test home is outside the project work directory.');
const models=join(home,'models'),temp=join(home,'temp'),appdata=join(home,'appdata'),localapp=join(home,'localapp');
for(const directory of [models,temp,appdata,localapp])await mkdir(directory);
noReparsePoints([home,models,temp,appdata,localapp]);
const env={...validationEnv};
Object.assign(env,{HOME:home,USERPROFILE:home,APPDATA:appdata,LOCALAPPDATA:localapp,TEMP:temp,TMP:temp,
  OLLAMA_HOST:'127.0.0.1:0',OLLAMA_MODELS:models,OLLAMA_NO_CLOUD:'1',OLLAMA_NOPRUNE:'1',
  OLLAMA_KEEP_ALIVE:'0',OLLAMA_NUM_PARALLEL:'1',OLLAMA_MAX_LOADED_MODELS:'1',OLLAMA_MAX_QUEUE:'1',
  OLLAMA_DEBUG_LOG_REQUESTS:'0',NO_PROXY:'127.0.0.1,localhost'});

let child,stopped=false;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{if(child&&child.exitCode===null&&child.signalCode===null)child.kill();});
function noReparsePoints(targets) {
  const paths=new Set();
  for(const target of targets) {
    let current=resolve(target);
    while(true) {
      paths.add(current);
      const parent=dirname(current);
      if(parent===current||current===parse(current).root)break;
      current=parent;
    }
  }
  const script=`$ErrorActionPreference = 'Stop'
$paths = ConvertFrom-Json -InputObject $env:BFE_TEST_INSPECT_PATHS
foreach ($path in $paths) {
  $item = Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 42 }
}`;
  const executable=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=spawnSync(executable,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:5000,
    env:{...validationEnv,BFE_TEST_INSPECT_PATHS:JSON.stringify([...paths])},stdio:'ignore'});
  if(result.status!==0)throw Error('Windows reparse attributes could not be verified. Test keys were retained.');
}
async function removeApprovedTestKeys() {
  const homeInfo=await lstat(home);
  if(!homeInfo.isDirectory()||homeInfo.isSymbolicLink()||await realpath(home)!==realHome)
    throw Error('The test home changed before cleanup.');
  const directory=join(home,'.ollama');
  let info;
  try {info=await lstat(directory);} catch(error) {if(error.code==='ENOENT')return 0;throw error;}
  if(!info.isDirectory()||info.isSymbolicLink())throw Error('The test key directory is not a plain directory.');
  const actual=await realpath(directory);
  if(actual.toLowerCase()!==join(realHome,'.ollama').toLowerCase())throw Error('The test key directory is outside the approved test home.');
  let removed=0;
  const present=[];
  for(const name of ['id_ed25519','id_ed25519.pub']) {
    const target=join(directory,name);
    try {
      const item=await lstat(target);
      if(!item.isFile()||item.isSymbolicLink()||item.nlink!==1)throw Error('A test key is not a plain single-link file.');
      if((await realpath(target)).toLowerCase()!==join(realHome,'.ollama',name).toLowerCase())
        throw Error('A test key resolved outside the approved location.');
      present.push(target);
    } catch(error) {if(error.code!=='ENOENT')throw error;}
  }
  if(present.length)noReparsePoints(present);
  for(const target of present) {
    try {
      await unlink(target);
      try {await access(target);throw Error('A test key remains after cleanup.');}
      catch(error) {if(error.code!=='ENOENT')throw error;}
      removed++;
    } catch {throw Error('Removed '+removed+' test key file(s); remaining cleanup requires review.');}
  }
  return removed;
}

function ensureChildAlive() {
  if(!child||!child.pid||child.exitCode!==null||child.signalCode!==null)throw Error('The test service is no longer running.');
}

try {
  console.log('Starting the isolated Ollama health check. No model will be loaded.');
  child=spawn(executable,['serve'],{cwd:home,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.resume();
  let tail='',port;
  const ready=new Promise((resolveReady,rejectReady)=>{
    const timer=setTimeout(()=>rejectReady(Error('The test service did not report a loopback listener.')),30000);
    child.once('error',error=>{clearTimeout(timer);rejectReady(Error(error.code==='EACCES'
      ?'The operating system or sandbox denied the test service start.' :'The test service could not be started.'));});
    child.once('exit',()=>{clearTimeout(timer);rejectReady(Error('The test service exited before readiness.'));});
    child.stderr.on('data',chunk=>{
      tail=(tail+chunk.toString('utf8')).slice(-4096);
      const match=/Listening on 127\.0\.0\.1:(\d{1,5})/i.exec(tail);
      if(match){port=Number(match[1]);clearTimeout(timer);resolveReady();}
    });
  });
  await ready;
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('The test listener is not available.');
  ensureChildAlive();
  let status,inventory;
  for(let i=0;i<2;i++) {
    try {
      ensureChildAlive();
      status=await directJson(port,'/api/status');
      ensureChildAlive();
      break;
    } catch(error) {
      ensureChildAlive();
      if(!/not reachable|timed out/i.test(error.message)||i===1)throw error;
    }
    await new Promise(resolveWait=>setTimeout(resolveWait,500));
  }
  if(status?.cloud?.disabled!==true)throw Error('The test instance did not confirm cloud features are disabled.');
  ensureChildAlive();
  inventory=await directJson(port,'/api/tags');
  ensureChildAlive();
  if(!Array.isArray(inventory.models)||inventory.models.length!==0)throw Error('The test model store is not empty.');
  const active=await directJson(port,'/api/ps');
  ensureChildAlive();
  if(!Array.isArray(active.models)||active.models.length!==0)throw Error('A model is unexpectedly loaded in the test instance.');
  console.log('Test instance reached loopback, reported cloud disabled, and used an empty model store.');
  console.log('No model was loaded and no inference request was sent.');
} finally {
  if(child) {
    if(!child.pid)stopped=true;
    else if(child.exitCode===null&&child.signalCode===null) {
      const exited=once(child,'exit');
      child.kill();
      await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(Error('The test process did not stop.')),5000))]);
    }
    if(child.pid)stopped=child.exitCode!==null||child.signalCode!==null;
  } else stopped=true;
  if(stopped){const removed=await removeApprovedTestKeys();console.log('Removed '+removed+' approved temporary key file(s).');}
}
