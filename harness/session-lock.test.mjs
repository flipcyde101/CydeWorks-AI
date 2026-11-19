import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {writeFile,readFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {terminalWorkspace} from './test-support/terminal-workspace.mjs';
import {createTerminalControl} from './terminal-control.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn) {
  for(let i=0;i<100;i++){if(await fn())return;await sleep(10);}
  throw Error('Test barrier timed out.');
}
const exists=async path=>{try{await access(path);return true;}catch{return false;}};
function client(origin,cookie) {
  return (path,body)=>fetch(origin+path,{method:body===undefined?'GET':'POST',signal:AbortSignal.timeout(5000),
    headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function login(origin) {
  const response=await client(origin)('/api/session',{key:'a'.repeat(64)});
  assert.equal(response.status,200);const cookie=response.headers.get('set-cookie').split(';')[0];
  return {cookie,request:client(origin,cookie)};
}

test('workspace revocation releases ownership without closing or stopping the terminal',()=>{
  const control=createTerminalControl('attempt');
  const old=control.command({...control.snapshot(),command:'take'}).response;
  control.revoke();assert.equal(control.snapshot().owner,'None');assert.equal(control.snapshot().closed,false);
  assert.throws(()=>control.command({...old,command:'stop',confirm:true}),e=>e.status===409);
  assert.ok(control.command({...control.snapshot(),command:'take'}).response.lease);
  control.close();control.revoke();assert.equal(control.snapshot().closed,true);
});

test('locking invalidates every view and control lease but an approved run continues',{timeout:15000},async t=>{
  const {origin,request,path}=await terminalWorkspace(t);
  const other=await login(origin);
  const before=await (await request(path)).json();
  const held=await (await request(path+'/terminal',{command:'take',...before.live.control})).json();
  assert.equal((await request('/api/session/lock',{}, {authenticated:false})).status,401);
  assert.equal((await request('/api/session/lock',{}, {originHeader:'https://untrusted.invalid'})).status,403);
  assert.equal((await request('/api/session/lock')).status,405);
  assert.equal((await request('/api/session/lock',{stop:true})).status,400);
  assert.equal((await request(path)).status,200);
  const locked=await request('/api/session/lock',{});
  assert.equal(locked.status,200);assert.match(locked.headers.get('set-cookie'),/Max-Age=0.*HttpOnly.*SameSite=Strict/);
  assert.deepEqual(await locked.json(),{locked:true,scope:'all-workspace-views',terminalControlReleased:true,stopsWork:false,requiresAccessFile:true});
  for(const send of [request,other.request]) {
    for(const target of [path,path+'/receipt','/api/tasks','/api/models'])assert.equal((await send(target)).status,401);
    assert.equal((await send(path+'/terminal',{...held,command:'stop',confirm:true})).status,401);
    assert.equal((await send('/api/session/lock',{})).status,401);
  }
  assert.equal((await client(origin)('/api/session',{key:'wrong'})).status,401);
  const fresh=await login(origin);assert.notEqual(fresh.cookie,other.cookie);
  const current=await (await fresh.request(path)).json();
  assert.equal(current.version,before.version);assert.deepEqual(current.events,before.events);
  assert.equal(current.status,'running');assert.equal(current.attempts[0].id,before.attempts[0].id);
  assert.equal(current.live.control.owner,'None');assert.equal(current.live.control.closed,false);
  assert.equal((await fresh.request(path+'/terminal',{...held,command:'status'})).status,409);
  const next=await (await fresh.request(path+'/terminal',{command:'take',...current.live.control})).json();
  assert.equal((await fresh.request(path+'/terminal',{...next,command:'stop',confirm:true})).status,200);
  await until(async()=> (await (await fresh.request(path)).json()).status!=='running');
  assert.equal((await other.request(path)).status,401);
});

// A marker in the copied host makes the race deterministic: the request has
// passed initial auth but its JSON body has not finished when Lock occurs.
async function instrumented(t) {
  let folder;
  const rig=await terminalWorkspace(t,{startImmediately:false,configure:async dir=>{
    folder=dir;const file=join(dir,'server.mjs');let code=await readFile(file,'utf8');
    code="import {writeFileSync as markArrival} from 'node:fs';\n"+code;
    code=code.replace('const data=await jsonBody(req);',
      "if(req.headers['x-test-arrival']==='login')markArrival('login.marker','ready');\n      const data=await jsonBody(req);");
    code=code.replace('const authenticatedBody=async()=>{',
      "const authenticatedBody=async()=>{\n      if(req.headers['x-test-arrival']==='mutation')markArrival('mutation.marker','ready');");
    await writeFile(file,code);
  }});
  return {...rig,folder};
}
function partialPost(origin,path,body,cookie,marker) {
  const text=JSON.stringify(body);
  let req;
  const response=new Promise((resolve,reject)=>{
    req=httpRequest(new URL(origin+path),{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',
      'Content-Length':Buffer.byteLength(text),'X-Test-Arrival':marker,...(cookie?{Cookie:cookie}:{})}},res=>{
      let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(data)}));
    });
    req.on('error',reject);req.setTimeout(5000,()=>req.destroy(Error('Partial request timed out')));
    req.write(text.slice(0,1));
  });
  return {response,finish:()=>req.end(text.slice(1)),abort:()=>req.destroy()};
}

test('Lock wins over an already-authenticated task body still in transit',{timeout:15000},async t=>{
  const {origin,request,path,folder}=await instrumented(t),session=await login(origin);
  const baseline=await (await request('/api/tasks')).json();
  const pending=partialPost(origin,'/api/tasks',{kind:'brief',title:'Late task',request:'Summarize',source:'Synthetic'},session.cookie,'mutation');
  t.after(pending.abort);
  await until(()=>exists(join(folder,'mutation.marker')));
  assert.equal((await request('/api/session/lock',{})).status,200);
  pending.finish();assert.equal((await pending.response).status,401);
  const fresh=await login(origin);assert.deepEqual(await (await fresh.request('/api/tasks')).json(),baseline);
  assert.equal((await fresh.request(path)).status,200);
});

test('an unlock body begun before Lock cannot restore access afterward',{timeout:15000},async t=>{
  const {origin,request,folder}=await instrumented(t);
  const pending=partialPost(origin,'/api/session',{key:'a'.repeat(64)},null,'login');t.after(pending.abort);
  await until(()=>exists(join(folder,'login.marker')));
  assert.equal((await request('/api/session/lock',{})).status,200);
  pending.finish();assert.equal((await pending.response).status,409);
  assert.equal((await client(origin)('/api/tasks')).status,401);
  assert.equal((await (await login(origin)).request('/api/tasks')).status,200);
});

test('a slow inventory probe does not disclose its result to a locked view',{timeout:15000},async t=>{
  let folder;
  const {origin,request}=await terminalWorkspace(t,{startImmediately:false,configure:async dir=>{
    folder=dir;await writeFile(join(dir,'providers.mjs'),`
import {writeFile,access} from 'node:fs/promises';
export const ollamaEndpoint='http://127.0.0.1:1';
export const ollama={inspect:async()=>{
 await writeFile('probe.marker','ready');
 for(let i=0;i<300;i++){try{await access('probe.release');break;}catch{}await new Promise(r=>setTimeout(r,10));}
 return {models:[],cloudDisabled:true};
}};
export const fixture={models:async()=>[]};
`);
  }});
  const pending=request('/api/models');
  await until(()=>exists(join(folder,'probe.marker')));
  assert.equal((await request('/api/session/lock',{})).status,200);
  await writeFile(join(folder,'probe.release'),'ready');
  const response=await pending;assert.equal(response.status,401);
  assert.equal(Object.hasOwn(await response.json(),'models'),false);
  assert.equal((await (await login(origin)).request('/api/tasks')).status,200);
});

test('approved work may finish while locked and is reviewable after a fresh unlock',{timeout:15000},async t=>{
  let folder;
  const {origin,request,path}=await terminalWorkspace(t,{configure:async dir=>{
    folder=dir;await writeFile(join(dir,'opencode.mjs'),`
import {access} from 'node:fs/promises';
export const opencode={availability:async()=>'present',
models:async()=>[{id:'qwen3:1.7b',bytes:1,digest:'a'.repeat(64),remote:false,cloudDisabled:true}],
run:async(task,{signal,terminal})=>{
 terminal('Synthetic adapter active. Waiting for completion gate.');
 for(let i=0;i<300;i++){signal.throwIfAborted();try{await access('finish.release');break;}catch{}await new Promise(r=>setTimeout(r,10));}
 signal.throwIfAborted();
 return {settled:true,artifact:{summary:'Synthetic completion',content:'After'},usage:null};
}};
`);
  }});
  const before=await (await request(path)).json();
  assert.equal((await request('/api/session/lock',{})).status,200);
  await writeFile(join(folder,'finish.release'),'ready');
  assert.equal((await request(path)).status,401);
  const fresh=await login(origin);let current;
  await until(async()=>{current=await (await fresh.request(path)).json();return current.status!=='running';});
  assert.equal(current.status,'review');assert.equal(current.attempts[0].id,before.attempts[0].id);
  assert.equal(current.attempts[0].artifact.content,'After');assert.equal(current.live,null);
  assert.equal((await request(path)).status,401);
});
