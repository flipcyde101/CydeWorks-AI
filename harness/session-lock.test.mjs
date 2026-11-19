import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {writeFile,readFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {terminalWorkspace} from './test-support/terminal-workspace.mjs';
import {createTerminalControl} from './terminal-control.mjs';
import {bindWorkspaceLock,workspaceLockCopy} from './web/workspace-lock.js';

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
const sessionNowNeedle='const sessionNow = () => Date.now();';
const issuedCookie=/^bfe_session=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/api$/;
const expiredCookie='bfe_session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/api';

function clockPatch(code) {
  if(!code.includes(sessionNowNeedle))throw Error('Copied server is missing the session clock.');
  return "import {readFileSync as readSessionClock} from 'node:fs';\n"+code.replace(sessionNowNeedle,
    `const sessionNow = () => {
      try {
        const value=Number(readSessionClock('session-clock.txt','utf8'));
        if(Number.isSafeInteger(value)&&value>=0)return value;
      } catch {}
      return Date.now();
    };`);
}

// The copied host reads session-clock.txt. Production keeps Date.now().
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
  return {...rig,folder,at:ms=>writeFile(join(folder,'session-clock.txt'),String(ms))};
}

test('the workspace idle deadline stays 15 minutes and is not the terminal lease',async()=>{
  const source=await readFile(new URL('./server.mjs',import.meta.url),'utf8');
  assert.match(source,/const sessionIdleMs=15\*60\*1000;/);
  assert.match(source,/const sessionNow = \(\) => Date\.now\(\);/);
  assert.match(source,/command==='heartbeat'\)\)noteSessionActivity\(\)/);
});

test('polls and heartbeats do not move the 15-minute deadline',{timeout:15000},async t=>{
  const {origin,request,path,at}=await withSessionClock(t,{startImmediately:true});
  const issued=await client(origin)('/api/session',{key:'a'.repeat(64)});
  assert.equal(issued.status,200);
  const original=issued.headers.get('set-cookie');
  assert.match(original,issuedCookie);
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
  const next=fresh.headers.get('set-cookie');
  assert.match(next,issuedCookie);
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
  const original=first.headers.get('set-cookie');
  assert.match(original,issuedCookie);
  await at(sessionIdleMs);
  const fresh=await client(origin)('/api/session',{key:'a'.repeat(64)});
  assert.equal(fresh.status,200);
  const next=fresh.headers.get('set-cookie');
  assert.match(next,issuedCookie);
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

function lockHarness(send) {
  const status={textContent:'stale'};
  const dialog={open:false,showModal(){this.open=true;},close(){this.open=false;}};
  const openButton={onclick:null,focus(){this.focused=true;}};
  const confirmButton={onclick:null,disabled:false};
  const cancelButton={onclick:null};
  const sent=[];
  const outcomes=[];
  let local=0;
  bindWorkspaceLock({openButton,dialog,confirmButton,cancelButton,status,send:async body=>{
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
