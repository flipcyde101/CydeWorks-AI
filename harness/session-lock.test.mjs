import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {writeFile,readFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {terminalWorkspace} from './test-support/terminal-workspace.mjs';
import {createTerminalControl} from './terminal-control.mjs';
import {bindWorkspaceLock,createLegacySessionController,createSessionEpoch,workspaceLockCopy} from './web/workspace-lock.js';
import {classifyLockOutcome} from './web-experience/adapters/contract.js';

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

const sessionIdleMs=15*60*1000;
const sessionClockNeedle=`const sessionMonotonic = () => performance.now();
const sessionWall = () => Date.now();`;
const issuedCookie=/^bfe_session=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/api$/;
const survivorCookie=/^bfe_session=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/api\/$/;
const expiredCookie='bfe_session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/api';

function clockPatch(code) {
  if(!code.includes(sessionClockNeedle))throw Error('Copied server is missing the session clock.');
  return "import {readFileSync as readSessionClock} from 'node:fs';\n"+code.replace(sessionClockNeedle,
    `const readSessionClocks = () => {
      const parts=readSessionClock('session-clock.txt','utf8').trim().split(/\\s+/).map(Number);
      const wall=parts[0], mono=parts.length>1?parts[1]:wall;
      return {wall, mono};
    };
    const sessionMonotonic = () => {
      try {
        const value=readSessionClocks().mono;
        if(Number.isSafeInteger(value)&&value>=0)return value;
      } catch {}
      return performance.now();
    };
    const sessionWall = () => {
      try {
        const value=readSessionClocks().wall;
        if(Number.isSafeInteger(value)&&value>=0)return value;
      } catch {}
      return Date.now();
    };`);
}

function cookiePath(header) {
  const match=/;\s*Path=([^;,\s]+)/i.exec(header);
  return match?match[1]:'/';
}
function cookieKey(header) {
  const [pair]=String(header).split(';');
  const name=pair.slice(0,pair.indexOf('='));
  return name+'\n'+cookiePath(header);
}
function applyCookie(jar, header) {
  if(!header)return;
  const [pair]=String(header).split(';');
  const value=pair.slice(pair.indexOf('=')+1);
  const key=cookieKey(header);
  if(/Max-Age=0/i.test(header))delete jar[key];
  else jar[key]=value;
}
function setCookies(response) {
  assert.equal(typeof response.headers.getSetCookie,'function');
  const cookies=response.headers.getSetCookie();
  assert.ok(cookies.length);
  return cookies;
}
function primaryIssued(response) {
  const cookies=setCookies(response);
  const primary=cookies.find(value=>issuedCookie.test(value));
  const survivor=cookies.find(value=>survivorCookie.test(value));
  assert.ok(primary);
  assert.ok(survivor);
  assert.equal(primary.split(';')[0],survivor.split(';')[0]);
  return primary;
}
function cookieValue(header) {
  return header.split(';')[0].slice('bfe_session='.length);
}

// The copied host reads session-clock.txt. Production uses performance.now() and Date.now().
async function withSessionClock(t,{configure,startImmediately=false}={}) {
  let folder;
  const rig=await terminalWorkspace(t,{startImmediately,configure:async dir=>{
    folder=dir;
    const file=join(dir,'server.mjs');
    let code=clockPatch(await readFile(file,'utf8'));
    if(configure){
      const next=await configure(dir,code);
      if(typeof next==='string')code=next;
    }
    if(!code.includes("readSessionClock('session-clock.txt'"))throw Error('Session clock patch was lost.');
    await writeFile(file,code);
    await writeFile(join(dir,'session-clock.txt'),'0');
  }});
  return {...rig,folder,at:(wall,mono)=>writeFile(join(folder,'session-clock.txt'),mono===undefined?String(wall):wall+' '+mono)};
}

test('the workspace idle deadline stays 15 minutes and is not the terminal lease',async()=>{
  const source=await readFile(new URL('./server.mjs',import.meta.url),'utf8');
  assert.match(source,/const sessionIdleMs=15\*60\*1000;/);
  assert.match(source,/const sessionMonotonic = \(\) => performance\.now\(\);/);
  assert.match(source,/const sessionWall = \(\) => Date\.now\(\);/);
  assert.match(source,/sessionSeenWall===undefined\|\|wall>=sessionSeenWall/);
  assert.match(source,/path==='\/api\/cost-presentation'/);
  assert.match(source,/data\.command==='heartbeat'\|\|data\.command==='detach'/);
  assert.doesNotMatch(source,/const sessionNow = \(\) => Date\.now\(\);/);
});

test('polls and heartbeats do not move the 15-minute deadline',{timeout:15000},async t=>{
  const {origin,request,path,at}=await withSessionClock(t,{startImmediately:true});
  const issued=await client(origin)('/api/session',{key:'a'.repeat(64)});
  assert.equal(issued.status,200);
  const original=primaryIssued(issued);
  const before=await (await request(path)).json();
  const taken=await request(path+'/terminal',{command:'take',...before.live.control});
  assert.equal(taken.status,200);
  const held=await taken.json();
  assert.equal((await request(path+'/terminal',{command:'heartbeat',...held})).status,200);
  const page=await request('/');
  const html=await page.text();
  assert.equal(page.status,200);
  assert.match(html,/id="lock-workspace"/);
  assert.match(html,/id="lock-confirm"/);
  const script=await (await request('/workspace-lock.js')).text();
  assert.match(script,/Workspace session terminated in every view/);
  await at(sessionIdleMs-1);
  for(const target of ['/api/health','/api/tasks','/api/attention','/api/models',path])
    assert.equal((await request(target)).status,200,target);
  assert.equal((await request(path+'/terminal',{command:'heartbeat',...held})).status,200);
  await at(sessionIdleMs);
  const expired=await request('/api/tasks');
  assert.equal(expired.status,401);
  assert.equal(expired.headers.get('set-cookie'),expiredCookie);
  assert.equal((await request(path)).status,401);
  assert.equal((await request('/api/health')).status,200);
  assert.equal((await request('/api/session/lock',{})).status,401);
  const fresh=await client(origin)('/api/session',{key:'a'.repeat(64)});
  assert.equal(fresh.status,200);
  const next=primaryIssued(fresh);
  assert.notEqual(next.split(';')[0],original.split(';')[0]);
  assert.equal((await request('/api/tasks')).status,401);
  assert.equal((await client(origin,next.split(';')[0])('/api/tasks')).status,200);
});

test('an operator POST moves the deadline and the boundary is exact',{timeout:15000},async t=>{
  const {request,at}=await withSessionClock(t);
  await at(sessionIdleMs-1);
  assert.equal((await request('/api/tasks')).status,200);
  const created=await request('/api/tasks',{kind:'brief',title:'Idle extension',request:'Summarize',source:'Synthetic source'});
  assert.equal(created.status,201);
  await at(sessionIdleMs*2-2);
  assert.equal((await request('/api/tasks')).status,200);
  await at(sessionIdleMs*2-1);
  const expired=await request('/api/tasks');
  assert.equal(expired.status,401);
  assert.equal(expired.headers.get('set-cookie'),expiredCookie);
});

test('unlock at the deadline replaces the secret before issuing a cookie',{timeout:15000},async t=>{
  const {origin,request,at}=await withSessionClock(t);
  const first=await client(origin)('/api/session',{key:'a'.repeat(64)});
  const original=primaryIssued(first);
  await at(sessionIdleMs);
  const fresh=await client(origin)('/api/session',{key:'a'.repeat(64)});
  assert.equal(fresh.status,200);
  const next=primaryIssued(fresh);
  assert.notEqual(next.split(';')[0],original.split(';')[0]);
  assert.equal((await request('/api/tasks')).status,401);
  assert.equal((await client(origin,next.split(';')[0])('/api/tasks')).status,200);
});

test('a task body still arriving at the deadline cannot mutate the workspace',{timeout:15000},async t=>{
  const {origin,request,folder,at}=await withSessionClock(t,{configure:(dir,code)=>{
    code="import {writeFileSync as markArrival} from 'node:fs';\n"+code;
    code=code.replace('const authenticatedBody=async()=>{',
      "const authenticatedBody=async()=>{\n      if(req.headers['x-test-arrival']==='mutation')markArrival('mutation.marker','ready');");
    if(!code.includes('mutation.marker'))throw Error('Arrival marker was not installed.');
    return code;
  }});
  const session=await login(origin);
  const baseline=await (await request('/api/tasks')).json();
  const pending=partialPost(origin,'/api/tasks',{kind:'brief',title:'Late task',request:'Summarize',source:'Synthetic'},session.cookie,'mutation');
  t.after(pending.abort);
  await until(()=>exists(join(folder,'mutation.marker')));
  await at(sessionIdleMs);
  pending.finish();
  assert.equal((await pending.response).status,401);
  const fresh=await login(origin);
  assert.deepEqual(await (await fresh.request('/api/tasks')).json(),baseline);
});

test('idle revocation does not stop approved work',{timeout:15000},async t=>{
  let folder;
  const {origin,request,path,at}=await withSessionClock(t,{startImmediately:true,configure:async (dir,code)=>{
    folder=dir;
    await writeFile(join(dir,'opencode.mjs'),`
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
    return code;
  }});
  const before=await (await request(path)).json();
  assert.equal(before.status,'running');
  await at(sessionIdleMs);
  assert.equal((await request(path)).status,401);
  const fresh=await login(origin);
  assert.equal((await (await fresh.request(path)).json()).status,'running');
  await writeFile(join(folder,'finish.release'),'ready');
  let current;
  await until(async()=>{current=await (await fresh.request(path)).json();return current.status!=='running';});
  assert.equal(current.status,'review');
  assert.equal(current.attempts[0].id,before.attempts[0].id);
  assert.equal(current.attempts[0].artifact.content,'After');
  assert.equal((await request(path)).status,401);
});

function lockHarness(send, focusTarget) {
  const status={textContent:'stale'};
  const dialog={open:false,showModal(){this.open=true;},close(){this.open=false;}};
  const openButton={onclick:null,focus(){this.focused=true;}};
  const confirmButton={onclick:null,disabled:false};
  const cancelButton={onclick:null};
  const sent=[];
  const outcomes=[];
  let local=0;
  bindWorkspaceLock({openButton,dialog,confirmButton,cancelButton,status,focusTarget,send:async body=>{
    sent.push(structuredClone(body));return send(body);
  },onLocalLock(){local++;},onOutcome(outcome){outcomes.push(outcome);}});
  return {status,dialog,openButton,confirmButton,cancelButton,sent,outcomes,local:()=>local};
}

test('legacy Lock sends nothing until confirm and shows termination only after the server',async()=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const ui=lockHarness(()=>pending);
  ui.openButton.onclick();
  assert.equal(ui.dialog.open,true);
  assert.equal(ui.status.textContent,'');
  assert.equal(ui.local(),0);
  ui.cancelButton.onclick();
  assert.equal(ui.dialog.open,false);
  assert.equal(ui.openButton.focused,true);
  assert.deepEqual(ui.sent,[]);
  assert.deepEqual(ui.outcomes,[]);
  ui.openButton.onclick();
  const done=ui.confirmButton.onclick();
  assert.deepEqual(ui.sent,[{}]);
  assert.equal(ui.status.textContent,workspaceLockCopy.waiting);
  assert.doesNotMatch(ui.status.textContent,/terminated/);
  assert.equal(ui.dialog.open,false);
  assert.equal(ui.local(),1);
  assert.deepEqual(ui.outcomes,[]);
  assert.equal(ui.confirmButton.disabled,true);
  release({locked:true});
  await done;
  assert.equal(ui.status.textContent,workspaceLockCopy.confirmed);
  assert.deepEqual(ui.outcomes,['confirmed']);
  assert.equal(ui.confirmButton.disabled,false);
});

test('a lost lock response stays unconfirmed and a 401 is already ended',async()=>{
  const lost=lockHarness(()=>{throw Error('lost');});
  const lostDone=lost.confirmButton.onclick();
  await lostDone;
  assert.deepEqual(lost.sent,[{}]);
  assert.equal(lost.status.textContent,workspaceLockCopy.unconfirmed);
  assert.deepEqual(lost.outcomes,['unconfirmed']);
  const odd=lockHarness(async()=>({}));
  await odd.confirmButton.onclick();
  assert.equal(odd.status.textContent,workspaceLockCopy.unconfirmed);
  const ended=lockHarness(()=>{throw Object.assign(Error('ended'),{status:401});});
  await ended.confirmButton.onclick();
  assert.equal(ended.status.textContent,workspaceLockCopy.already);
  assert.deepEqual(ended.outcomes,['already']);
});

test('confirm moves focus to a visible unlock control',async()=>{
  const unlock={hidden:false,focused:false,focus(){this.focused=true;}};
  const ui=lockHarness(async()=>({locked:true}),unlock);
  ui.openButton.onclick();
  await ui.confirmButton.onclick();
  assert.equal(unlock.focused,true);
  assert.notEqual(ui.openButton.focused,true);
  const hidden={hidden:true,focused:false,focus(){this.focused=true;}};
  const concealed=lockHarness(async()=>({locked:true}),hidden);
  concealed.openButton.focused=false;
  await concealed.confirmButton.onclick();
  assert.equal(hidden.focused,false);
  assert.notEqual(concealed.openButton.focused,true);
});

test('a pending task read and an older lock outcome cannot restore a concealed or unlocked view',async()=>{
  const gate=createSessionEpoch();
  gate.unlock();
  let controls='open';
  let releaseRead;
  const read=new Promise(resolve=>{releaseRead=resolve;});
  const started=gate.epoch();
  const pending=read.then(()=>gate.current(started)?'restored':'dropped');
  const lockEpoch=gate.conceal();
  controls='concealed';
  releaseRead({id:'task'});
  assert.equal(await pending,'dropped');
  assert.equal(controls,'concealed');
  assert.equal(gate.locked(),true);
  assert.equal(gate.current(started),false);
  assert.equal(gate.outcomeCurrent(lockEpoch),true);
  let notice='waiting';
  let releaseLock;
  const lockResult=new Promise(resolve=>{releaseLock=resolve;});
  const outcome=lockResult.then(result=>{
    if(!gate.outcomeCurrent(lockEpoch))return 'ignored';
    notice=result?.locked===true?'confirmed':'unconfirmed';
    return 'applied';
  });
  gate.unlock();
  notice='unlocked';
  controls='open';
  releaseLock({locked:true});
  assert.equal(await outcome,'ignored');
  assert.equal(notice,'unlocked');
  assert.equal(controls,'open');
  assert.equal(gate.locked(),false);
  const failed=createSessionEpoch();
  failed.unlock();
  const failedEpoch=failed.conceal();
  assert.equal(failed.locked(),true);
  assert.equal(failed.outcomeCurrent(failedEpoch),true);
  assert.equal(failed.current(failed.epoch()),false);
});

test('lock confirmation requires locked true',()=>{
  assert.equal(classifyLockOutcome({locked:true}),'confirmed');
  assert.equal(classifyLockOutcome({}),'unconfirmed');
  assert.equal(classifyLockOutcome({locked:false}),'unconfirmed');
  assert.equal(classifyLockOutcome(null),'unconfirmed');
  assert.equal(classifyLockOutcome(undefined,Object.assign(Error('ended'),{status:401})),'already');
  assert.equal(classifyLockOutcome(undefined,Error('lost')),'unconfirmed');
});

test('legacy lock stays hidden until the workspace opens and continuations check the epoch',async()=>{
  const html=await readFile(new URL('./web/index.html',import.meta.url),'utf8');
  const app=await readFile(new URL('./web/app.js',import.meta.url),'utf8');
  const experience=await readFile(new URL('./web-experience/app.js',import.meta.url),'utf8');
  assert.match(html,/id="lock-workspace"[^>]*hidden/);
  const enterStart=app.indexOf('async function enter()');
  const enter=app.slice(enterStart,app.indexOf("$('access-file')",enterStart));
  const listed=enter.indexOf('await refreshList()');
  const reveal=enter.indexOf("$('lock-workspace').hidden=false");
  assert.ok(listed>0&&reveal>listed);
  assert.match(app,/if \(stamp!==selection\|\|!sessionGate\.current\(epoch\)\) return;/);
  assert.match(app,/if\(stamp!==listRevision\|\|!sessionGate\.current\(epoch\)\)return;/);
  assert.match(app,/if\(!sessionGate\.outcomeCurrent\(lockEpoch\)\)/);
  assert.match(app,/if \(busy\|\|sessionGate\.locked\(\)\) return;/);
  assert.match(app,/sessionUi\.readSource\(/);
  assert.match(app,/sessionUi\.takeControl\(/);
  assert.match(app,/sessionUi\.runApproved\(/);
  assert.match(app,/sessionUi\.allowDownload\(/);
  assert.match(app,/sessionUi\.settle\(/);
  assert.match(enter,/sessionUi\.failRestore\(entered\)/);
  assert.match(enter,/observer\.stop\(\)/);
  assert.match(enter,/clearTimeout\(listTimer\)/);
  assert.match(experience,/classifyLockOutcome\(result\)/);
  assert.match(experience,/state\.sessionEpoch !== epoch \|\| state\.session\.unlocked/);
});

test('a backward session clock ends the workspace session',{timeout:15000},async t=>{
  const {origin,request,at}=await withSessionClock(t);
  await at(1000);
  assert.equal((await request('/api/tasks')).status,200);
  await at(500,1000);
  const wall=await request('/api/tasks');
  assert.equal(wall.status,401);
  assert.equal(wall.headers.get('set-cookie'),expiredCookie);
  const unlocked=await client(origin)('/api/session',{key:'a'.repeat(64)});
  assert.equal(unlocked.status,200);
  const cookie=primaryIssued(unlocked);
  const next=client(origin,cookie.split(';')[0]);
  assert.equal((await next('/api/tasks')).status,200);
  await at(2000,500);
  const mono=await next('/api/tasks');
  assert.equal(mono.status,401);
  assert.equal(mono.headers.get('set-cookie'),expiredCookie);
});

test('cost presentation and detach do not move the 15-minute deadline',{timeout:15000},async t=>{
  const {request,path,at}=await withSessionClock(t,{startImmediately:true});
  const before=await (await request(path)).json();
  const taken=await request(path+'/terminal',{command:'take',...before.live.control});
  assert.equal(taken.status,200);
  const held=await taken.json();
  await at(sessionIdleMs-1);
  assert.equal((await request('/api/tasks')).status,200);
  assert.equal((await request('/api/cost-presentation',{})).status,400);
  assert.equal((await request(path+'/terminal',{command:'detach',...held})).status,200);
  await at(sessionIdleMs);
  const expired=await request('/api/tasks');
  assert.equal(expired.status,401);
  assert.equal(expired.headers.get('set-cookie'),expiredCookie);
});

test('handoff review and terminal status still move the deadline',{timeout:15000},async t=>{
  const {request,path,at}=await withSessionClock(t,{startImmediately:true});
  const before=await (await request(path)).json();
  const taken=await request(path+'/terminal',{command:'take',...before.live.control});
  assert.equal(taken.status,200);
  const held=await taken.json();
  await at(sessionIdleMs-1);
  assert.equal((await request('/api/tasks')).status,200);
  assert.equal((await request('/api/handoffs/review',{})).status,400);
  await at(sessionIdleMs*2-2);
  assert.equal((await request('/api/tasks')).status,200);
  assert.equal((await request(path+'/terminal',{command:'status',...held})).status,200);
  await at(sessionIdleMs*3-3);
  assert.equal((await request('/api/tasks')).status,200);
  await at(sessionIdleMs*3-2);
  const expired=await request('/api/tasks');
  assert.equal(expired.status,401);
  assert.equal(expired.headers.get('set-cookie'),expiredCookie);
});

test('a late idle probe does not clear a cookie issued by a newer unlock',{timeout:15000},async t=>{
  const {origin,request,folder,at}=await withSessionClock(t,{configure:async dir=>{
    await writeFile(join(dir,'providers.mjs'),`
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
  await at(sessionIdleMs);
  const unlocked=await client(origin)('/api/session',{key:'a'.repeat(64)});
  assert.equal(unlocked.status,200);
  const issued=primaryIssued(unlocked);
  await writeFile(join(folder,'probe.release'),'ready');
  const late=await pending;
  assert.equal(late.status,401);
  const lateCookie=late.headers.get('set-cookie');
  assert.ok(lateCookie==null||!String(lateCookie).includes('Max-Age=0'));
  assert.equal(Object.hasOwn(await late.json(),'models'),false);
  const jar={};
  for(const header of setCookies(unlocked)) applyCookie(jar,header);
  applyCookie(jar,lateCookie);
  const secret=cookieValue(issued);
  assert.equal(jar['bfe_session\n/api'],secret);
  assert.equal(jar['bfe_session\n/api/'],secret);
  assert.equal((await client(origin,'bfe_session='+jar['bfe_session\n/api/'])('/api/tasks')).status,200);
  assert.equal((await request('/api/tasks')).status,401);
});

test('an already issued cookie deletion leaves the newer path survivor',{timeout:15000},async t=>{
  const {origin,at}=await withSessionClock(t);
  const first=await client(origin)('/api/session',{key:'a'.repeat(64)});
  const oldHeader=primaryIssued(first);
  const oldSecret=cookieValue(oldHeader);
  await at(sessionIdleMs);
  const expired=await client(origin,'bfe_session='+oldSecret)('/api/tasks');
  assert.equal(expired.status,401);
  assert.equal(expired.headers.get('set-cookie'),expiredCookie);
  const deletion=expired.headers.get('set-cookie');
  const fresh=await client(origin)('/api/session',{key:'a'.repeat(64)});
  const next=primaryIssued(fresh);
  const secret=cookieValue(next);
  assert.notEqual(secret,oldSecret);
  const jar={};
  for(const header of setCookies(fresh)) applyCookie(jar,header);
  applyCookie(jar,deletion);
  assert.equal(jar['bfe_session\n/api'],undefined);
  assert.equal(jar['bfe_session\n/api/'],secret);
  assert.equal((await client(origin,'bfe_session='+jar['bfe_session\n/api/'])('/api/tasks')).status,200);
  assert.equal((await client(origin,'bfe_session='+oldSecret)('/api/tasks')).status,401);
  const onlyOld={};
  applyCookie(onlyOld,oldHeader);
  applyCookie(onlyOld,deletion);
  assert.equal(onlyOld['bfe_session\n/api'],undefined);
});

function deferred() {
  let release;
  const promise=new Promise(resolve=>{release=resolve;});
  return {promise,release};
}

test('a current file read, take, and run update the legacy session view',async()=>{
  const ui=createLegacySessionController();
  ui.gate.unlock();
  assert.equal(await ui.readSource(async()=>({source:'shown',filename:'note.txt'})),true);
  assert.equal(ui.view.fields.source,'shown');
  assert.equal(ui.view.fields.filename,'note.txt');
  assert.equal(await ui.takeControl(async()=>({attemptId:'attempt',generation:2})),true);
  assert.deepEqual(ui.view.lease,{attemptId:'attempt',generation:2});
  assert.equal(ui.view.polling,false);
  const task=await ui.runApproved(async()=>({id:'task'}));
  assert.deepEqual(task,{id:'task'});
  assert.equal(ui.view.polling,true);
  assert.equal(ui.view.runs,1);
  assert.equal(ui.view.uiWrites,3);
});

test('delayed file, take, and run successes do not write or poll after Lock',async()=>{
  const ui=createLegacySessionController();
  ui.gate.unlock();
  ui.view.fields.source='already shown';
  ui.view.fields.filename='kept.txt';
  const file=deferred();
  const take=deferred();
  const run=deferred();
  const fileResult=ui.readSource(()=>file.promise);
  const takeResult=ui.takeControl(()=>take.promise);
  const runResult=ui.runApproved(()=>run.promise);
  const lock=ui.beginLock();
  file.release({source:'late source',filename:'late.txt'});
  take.release({attemptId:'late',generation:9});
  run.release({id:'late-task'});
  assert.equal(await fileResult,false);
  assert.equal(await takeResult,false);
  assert.equal(await runResult,false);
  assert.equal(ui.view.fields.source,'already shown');
  assert.equal(ui.view.fields.filename,'kept.txt');
  assert.equal(ui.view.lease,null);
  assert.equal(ui.view.polling,false);
  assert.equal(ui.view.runs,0);
  assert.equal(ui.view.uiWrites,0);
  assert.equal(ui.view.workspaceHidden,true);
  assert.equal(ui.view.workspaceInert,true);
  assert.equal(ui.gate.outcomeCurrent(lock.epoch),true);
});

test('each Lock keeps its own epoch and only the latest outcome can publish',async()=>{
  const ui=createLegacySessionController();
  ui.gate.unlock();
  const first=ui.beginLock();
  const second=ui.beginLock();
  assert.notEqual(first.epoch,second.epoch);
  assert.equal(ui.finishLock(first,'confirmed'),false);
  assert.equal(ui.view.notice,null);
  assert.equal(ui.gate.outcomeCurrent(first.epoch),false);
  assert.equal(ui.finishLock(second,'confirmed'),true);
  assert.equal(ui.view.notice,'confirmed');
  assert.equal(ui.gate.outcomeCurrent(second.epoch),true);
  assert.equal(first.epoch+1,second.epoch);
});

test('an older Lock response cannot replace a later Lock status',async()=>{
  const ui=createLegacySessionController();
  const status={textContent:'initial'};
  const dialog={open:false,showModal(){this.open=true;},close(){this.open=false;}};
  const openButton={onclick:null,focus(){this.focused=true;}};
  const confirmButton={onclick:null,disabled:false};
  const cancelButton={onclick:null};
  const held=deferred();
  let firstEpoch;
  bindWorkspaceLock({
    openButton,dialog,confirmButton,cancelButton,status,
    async send(){
      held.later=ui.beginLock();
      status.textContent='second-waiting';
      return held.promise;
    },
    onLocalLock(){
      firstEpoch=ui.beginLock().epoch;
      return firstEpoch;
    },
    onOutcome(outcome, epoch){
      return ui.finishLock({epoch},outcome)?true:false;
    },
  });
  const done=confirmButton.onclick();
  assert.equal(status.textContent,'second-waiting');
  assert.notEqual(held.later.epoch,firstEpoch);
  held.release({locked:true});
  await done;
  assert.equal(status.textContent,'second-waiting');
  assert.equal(ui.view.notice,null);
  assert.equal(ui.finishLock({epoch:firstEpoch},'confirmed'),false);
  assert.equal(ui.finishLock(held.later,'confirmed'),true);
  assert.equal(ui.view.notice,'confirmed');
  assert.equal(status.textContent,'second-waiting');
});

test('Lock closes dialogs and refuses a cached export download',async()=>{
  const ui=createLegacySessionController();
  ui.gate.unlock();
  ui.view.fields.source='already shown';
  const dialog={open:false,inert:false,cached:null};
  ui.openDialog(dialog);
  dialog.cached='export-body';
  assert.equal(ui.allowDownload(dialog),true);
  assert.deepEqual(ui.view.downloads,['export-body']);
  ui.beginLock();
  assert.equal(dialog.open,false);
  assert.equal(dialog.inert,true);
  assert.equal(dialog.cached,null);
  assert.equal(ui.view.workspaceHidden,true);
  assert.equal(ui.view.workspaceInert,true);
  assert.equal(ui.view.fields.source,'already shown');
  assert.equal(ui.allowDownload({open:true,inert:false,cached:'export-body'}),false);
  assert.deepEqual(ui.view.downloads,['export-body']);
});

test('a failed restore after the access panel is hidden recovers unlock and drops the late read',async()=>{
  const ui=createLegacySessionController();
  const entered={epoch:ui.gate.unlock()};
  ui.noteAccessHidden();
  assert.equal(ui.view.unlockHidden,true);
  assert.equal(ui.view.workspaceHidden,false);
  const late=deferred();
  const pending=ui.readSource(()=>late.promise);
  assert.equal(ui.failRestore(entered),'recovered');
  assert.equal(ui.view.unlockHidden,false);
  assert.equal(ui.view.unlockDisabled,false);
  assert.equal(ui.view.workspaceHidden,true);
  assert.equal(ui.view.workspaceInert,true);
  assert.equal(ui.view.polling,false);
  late.release({source:'late',filename:'late.txt'});
  assert.equal(await pending,false);
  assert.equal(ui.view.fields.source,'');
  assert.equal(ui.view.uiWrites,0);
  const opened=ui.gate.unlock();
  assert.equal(ui.gate.current(opened),true);
  ui.noteAccessHidden();
  assert.equal(ui.view.workspaceHidden,false);
  assert.equal(ui.view.workspaceInert,false);
});

test('a failed restore for an older epoch does not replace a newer Lock',async()=>{
  const ui=createLegacySessionController();
  const entered={epoch:ui.gate.unlock()};
  ui.noteAccessHidden();
  const lock=ui.beginLock();
  assert.equal(ui.failRestore(entered),'stale');
  assert.equal(ui.gate.outcomeCurrent(lock.epoch),true);
  assert.equal(ui.view.notice,null);
  assert.equal(ui.view.workspaceHidden,true);
  assert.equal(ui.view.workspaceInert,true);
});

test('a settled result that arrives after Lock is stale',async()=>{
  const ui=createLegacySessionController();
  ui.gate.unlock();
  const token=ui.capture();
  const late=deferred();
  const pending=ui.settle(token,()=>late.promise);
  ui.beginLock();
  late.release({id:'task'});
  await assert.rejects(pending,error=>error.stale===true);
  assert.equal(ui.view.uiWrites,0);
});
