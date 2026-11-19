import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readdir,mkdir,mkdtemp,copyFile,cp,writeFile,rm,lstat,realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,sep} from 'node:path';

// Copy source only. Never open the real workspace state or call a model.
export async function terminalWorkspace(t,{configure,startImmediately=true,uiMode='legacy'}={}) {
  const source=fileURLToPath(new URL('../',import.meta.url));
  const work=fileURLToPath(new URL('../../work/',import.meta.url));
  await mkdir(work,{recursive:true});
  if((await lstat(work)).isSymbolicLink())throw Error('The synthetic scratch parent must not be a link.');
  const realWork=await realpath(work);
  const folder=await mkdtemp(join(work,'terminal-synthetic-'));
  let child;
  t.after(async()=>{
    if(child&&child.exitCode===null&&child.signalCode===null) {
      const exited=once(child,'exit');child.kill();await exited;
    }
    if((await lstat(folder)).isSymbolicLink()||!(await realpath(folder)).startsWith(realWork+sep))
      throw Error('The synthetic scratch destination changed.');
    await rm(folder,{recursive:true,force:true});
  });
  for(const entry of await readdir(source,{withFileTypes:true})) {
    if(entry.isFile()&&((entry.name.endsWith('.mjs')&&!entry.name.endsWith('.test.mjs'))||entry.name==='package.json'))
      await copyFile(join(source,entry.name),join(folder,entry.name));
  }
  await mkdir(join(folder,'web'));
  for(const entry of await readdir(join(source,'web'),{withFileTypes:true}))
    if(entry.isFile())await copyFile(join(source,'web',entry.name),join(folder,'web',entry.name));
  if(uiMode==='experience')await cp(join(source,'web-experience'),join(folder,'web-experience'),{recursive:true,errorOnExist:true});
  await writeFile(join(folder,'opencode.mjs'),`
export const opencode={
  availability:async()=>'present',
  models:async()=>[{id:'qwen3:1.7b',bytes:1,digest:'a'.repeat(64),remote:false,cloudDisabled:true}],
  run:async(task,{signal,terminal})=>new Promise(resolve=>{
    terminal('Synthetic adapter active. No worker process or model was started.');
    const finish=()=>resolve({settled:true,artifact:null,usage:null,problem:'Synthetic adapter stopped.'});
    if(signal.aborted)finish();else signal.addEventListener('abort',finish,{once:true});
  })
};
`);
  await writeFile(join(folder,'providers.mjs'),`
const model={id:'qwen3:1.7b',bytes:1,digest:'a'.repeat(64),remote:false,cloudDisabled:true};
export const ollamaEndpoint='http://127.0.0.1:1';
export const ollama={inspect:async()=>({models:[model],cloudDisabled:true}),models:async()=>[model],
  run:async()=>{throw Error('Direct inference is disabled in this synthetic test.');}};
export const fixture={models:async()=>[]};
`);
  await writeFile(join(folder,'llamacpp.mjs'),`export const llamaCpp={configured:false,inspect:async()=>({models:[]})};`);
  if(configure)await configure(folder); // Test-owned synthetic modules only, before startup.
  const env={...process.env,BFE_PORT:'0',BFE_TEST_MEMORY:'1',BFE_TEST_KEY:'a'.repeat(64),BFE_UI:uiMode};
  delete env.BFE_DESKTOP_BOOTSTRAP;
  child=spawn(process.execPath,['server.mjs'],{cwd:folder,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',chunk=>{errors+=chunk;});
  const origin=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Synthetic workspace startup timed out.')),5000);
    let output='';
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);reject(Error('Synthetic workspace exited: '+code+' '+errors));});
    child.stdout.on('data',chunk=>{
      output+=chunk;
      const match=/http:\/\/127\.0\.0\.1:\d+/.exec(output);
      if(match){clearTimeout(timer);resolve(match[0]);}
    });
  });
  let cookie;
  const request=(path,body,{authenticated=true,originHeader=origin}={})=>fetch(origin+path,{
    method:body===undefined?'GET':'POST',signal:AbortSignal.timeout(5000),
    headers:{Origin:originHeader,'Content-Type':'application/json',...(authenticated&&cookie?{Cookie:cookie}:{})},
    body:body===undefined?undefined:JSON.stringify(body),
  });
  const login=await request('/api/session',{key:'a'.repeat(64)});
  if(login.status!==200)throw Error('Synthetic sign-in failed.');
  cookie=login.headers.get('set-cookie').split(';')[0];
  const created=await request('/api/tasks',{kind:'change',title:'Synthetic terminal contention',
    filename:'example.txt',source:'Before',request:'Return After',expected:'After'});
  const task=await created.json(),path='/api/tasks/'+task.id;
  async function start(current) {
    const response=await request(path+'/run',{version:current.version,sourceHash:current.sourceHash,approve:true,
      engine:'opencode',model:'qwen3:1.7b',modelDigest:'a'.repeat(64)});
    if(response.status!==202)throw Error('Synthetic run rejected: '+response.status);
    await response.json();
    for(let i=0;i<100;i++) {
      const saved=await (await request(path)).json();
      if(saved.live?.terminal.some(line=>line.message.startsWith('Synthetic adapter active')))return saved;
      if(saved.status!=='running')throw Error('Synthetic preflight failed: '+saved.status);
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw Error('Synthetic adapter did not start.');
  }
  return {origin,request,path,start,task:startImmediately?await start(task):task};
}
