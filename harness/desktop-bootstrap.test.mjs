import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {request as httpRequest} from 'node:http';

test('desktop bootstrap authenticates only its private in-memory session', {timeout:10000},async t=>{
  const child=fork(new URL('./server.mjs',import.meta.url),[],{windowsHide:true,
    env:{...process.env,BFE_PORT:'0',BFE_TEST_MEMORY:'1',BFE_TEST_KEY:'f'.repeat(64),BFE_DESKTOP_BOOTSTRAP:'1'},
    stdio:['ignore','pipe','pipe','ipc']});
  let stdout='';
  child.stdout.on('data',chunk=>{stdout+=chunk.toString();});
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
  });
  const [ready]=await Promise.race([once(child,'message'),once(child,'exit').then(([code])=>{throw Error('Service exited '+code);})]);
  assert.equal(ready.type,'bfe-desktop-ready');
  assert.ok(Number.isInteger(ready.port)&&ready.port>0);
  assert.match(ready.session,/^[a-f0-9]{64}$/);
  const origin='http://127.0.0.1:'+ready.port;
  assert.equal((await fetch(origin+'/api/tasks')).status,401);
  assert.equal((await fetch(origin+'/api/tasks',{headers:{Cookie:'bfe_session='+ready.session}})).status,200);
  assert.equal((await fetch(origin+'/api/tasks',{headers:{Cookie:'bfe_session='+ready.session,Origin:'https://elsewhere.invalid'}})).status,403);
  assert.doesNotMatch(stdout,new RegExp(ready.session));
});

function rawHttp(origin, path, {method='GET', headers={}, body}={}) {
  const payload=body===undefined?null:JSON.stringify(body);
  return new Promise((resolve,reject)=>{
    const req=httpRequest(origin+path,{method,headers:{
      ...headers,
      ...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}),
    }},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8'),path,headers:res.headers}));
    });
    req.on('error',reject);
    req.setTimeout(5000,()=>req.destroy(Error('Desktop request timed out')));
    if(payload) req.write(payload);
    req.end();
  });
}
function desktopChild(t) {
  const child=fork(new URL('./server.mjs',import.meta.url),[],{windowsHide:true,
    env:{...process.env,BFE_PORT:'0',BFE_TEST_MEMORY:'1',BFE_TEST_KEY:'f'.repeat(64),BFE_DESKTOP_BOOTSTRAP:'1'},
    stdio:['ignore','pipe','pipe','ipc']});
  let stdout='';
  child.stdout.on('data',chunk=>{stdout+=chunk.toString();});
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
  });
  return {child, stdout:()=>stdout};
}
const documentHeaders={
  'Sec-Fetch-Dest':'document',
  'Sec-Fetch-Mode':'navigate',
  'Sec-Fetch-Site':'none',
  Accept:'text/html',
};
function claimDesktop(origin, cookie) {
  return rawHttp(origin,'/api/desktop-view',{method:'POST',body:{},headers:{
    Origin:origin, Accept:'application/json', ...(cookie?{Cookie:cookie}:{}),
  }});
}

test('desktop bootstrap claims one launcher view after an unrelated navigation',{timeout:10000},async t=>{
  const {child, stdout}=desktopChild(t);
  const [ready]=await Promise.race([once(child,'message'),once(child,'exit').then(([code])=>{throw Error('Service exited '+code);})]);
  assert.equal(ready.type,'bfe-desktop-ready');
  assert.deepEqual(Object.keys(ready).sort(),['port','session','type']);
  assert.equal(Object.hasOwn(ready,'viewId'), false);
  const origin='http://127.0.0.1:'+ready.port;
  const cookie='bfe_session='+ready.session;
  const probe=await rawHttp(origin,'/',{headers:{Accept:'text/html'}});
  assert.equal(probe.status, 200);
  assert.equal(probe.path, '/');
  assert.equal(probe.body.includes('bfe-desktop-view'), false);
  const unrelated=await rawHttp(origin,'/',{headers:documentHeaders});
  assert.equal(unrelated.path, '/');
  assert.equal(unrelated.status, 200);
  assert.equal(unrelated.body.includes('bfe-desktop-view'), false);
  const withCookie=await rawHttp(origin,'/',{headers:{...documentHeaders, Cookie:cookie}});
  assert.equal(withCookie.status, 200);
  assert.equal(withCookie.body.includes('bfe-desktop-view'), false);
  const stranger=await claimDesktop(origin);
  assert.equal(stranger.status, 401);
  assert.equal(stranger.headers['set-cookie'], undefined);
  const claimed=await claimDesktop(origin, cookie);
  assert.equal(claimed.path, '/api/desktop-view');
  assert.equal(claimed.status, 200);
  assert.equal(claimed.headers['set-cookie'], undefined);
  const ticket=JSON.parse(claimed.body);
  assert.match(ticket.viewId,/^[a-f0-9]{32}$/);
  assert.match(ticket.viewGeneration,/^[a-f0-9]{32}$/);
  assert.equal(claimed.headers['x-view-generation'], ticket.viewGeneration);
  assert.equal(unrelated.body.includes(ticket.viewId), false);
  assert.equal(withCookie.body.includes(ticket.viewId), false);
  assert.equal(probe.body.includes(ticket.viewId), false);
  assert.equal(claimed.body.includes(ticket.viewId), true);
  const second=await claimDesktop(origin, cookie);
  assert.notEqual(second.status, 200);
  assert.equal(second.body.includes(ticket.viewId), false);
  const browser={'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty',Cookie:cookie,Origin:origin,Accept:'application/json'};
  assert.equal((await rawHttp(origin,'/api/tasks',{headers:browser})).status, 401);
  assert.equal((await rawHttp(origin,'/api/tasks',{headers:{...browser,'X-Workspace-View':ticket.viewId}})).status, 200);
  const navigation={
    'Sec-Fetch-Dest':'document',
    'Sec-Fetch-Mode':'navigate',
    'Sec-Fetch-Site':'none',
    'Sec-Fetch-User':'?1',
    Accept:'text/html',
    Cookie:cookie,
  };
  const direct=await rawHttp(origin,'/api/tasks',{headers:navigation});
  assert.equal(direct.path, '/api/tasks');
  assert.equal(direct.status, 401);
  assert.equal(direct.headers['set-cookie'], undefined);
  assert.equal((await rawHttp(origin,'/api/tasks',{headers:{Cookie:cookie,Accept:'application/json'}})).status, 200);
  assert.equal((await rawHttp(origin,'/api/tasks',{headers:{...navigation,'X-Workspace-View':ticket.viewId}})).status, 200);
  assert.equal((await rawHttp(origin,'/api/tasks',{headers:{...browser,'X-Workspace-View':ticket.viewId}})).status, 200);
  const stillUnissued=await rawHttp(origin,'/',{headers:documentHeaders});
  assert.equal(stillUnissued.body.includes('bfe-desktop-view'), false);
  assert.equal(stillUnissued.body.includes(ticket.viewId), false);
  const locked=await rawHttp(origin,'/api/session/lock',{method:'POST',body:{},headers:{...browser,'X-Workspace-View':ticket.viewId}});
  assert.equal(locked.status, 200);
  assert.equal((await rawHttp(origin,'/api/tasks',{headers:{...browser,'X-Workspace-View':ticket.viewId}})).status, 401);
  const afterLock=await claimDesktop(origin, cookie);
  assert.notEqual(afterLock.status, 200);
  assert.equal(afterLock.body.includes(ticket.viewId), false);
  assert.equal(afterLock.headers['set-cookie'], undefined);
  const after=await rawHttp(origin,'/',{headers:documentHeaders});
  assert.equal(after.body.includes('bfe-desktop-view'), false);
  assert.equal(after.body.includes(ticket.viewId), false);
  assert.doesNotMatch(stdout(), new RegExp(ready.session));
  assert.doesNotMatch(stdout(), new RegExp(ticket.viewId));
});

test('desktop bootstrap does not mint a view after lock',{timeout:10000},async t=>{
  const {child, stdout}=desktopChild(t);
  const [ready]=await Promise.race([once(child,'message'),once(child,'exit').then(([code])=>{throw Error('Service exited '+code);})]);
  const origin='http://127.0.0.1:'+ready.port;
  const cookie='bfe_session='+ready.session;
  const locked=await rawHttp(origin,'/api/session/lock',{method:'POST',body:{},headers:{
    Origin:origin, Cookie:cookie, Accept:'application/json',
  }});
  assert.equal(locked.status, 200);
  const page=await rawHttp(origin,'/',{headers:documentHeaders});
  assert.equal(page.path, '/');
  assert.equal(page.body.includes('bfe-desktop-view'), false);
  const claim=await claimDesktop(origin, cookie);
  assert.notEqual(claim.status, 200);
  assert.equal(claim.headers['set-cookie'], undefined);
  const again=await rawHttp(origin,'/',{headers:documentHeaders});
  assert.equal(again.body.includes('bfe-desktop-view'), false);
  assert.doesNotMatch(stdout(), /bfe-desktop-view/);
  assert.doesNotMatch(stdout(), new RegExp(ready.session));
});
