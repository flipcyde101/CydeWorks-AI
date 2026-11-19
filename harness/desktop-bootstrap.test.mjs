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
function claimDesktop(origin, cookie, proof) {
  return rawHttp(origin,'/api/desktop-view',{method:'POST',body:{},headers:{
    Origin:origin, Accept:'application/json', ...(cookie?{Cookie:cookie}:{}),
    ...(proof?{'X-Desktop-Claim':proof}:{}),
  }});
}
function claimAck(child) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(Error('Claim bind timed out'));},5000);
    function onMessage(message) {
      if(message?.type!=='bfe-desktop-claim-bound')return;
      cleanup();
      resolve(message);
    }
    function onExit(code) {
      cleanup();
      reject(Error('Service exited '+code));
    }
    function cleanup() {
      clearTimeout(timer);
      child.off('message',onMessage);
      child.off('exit',onExit);
    }
    child.on('message',onMessage);
    child.on('exit',onExit);
  });
}
function bindClaim(child, proof) {
  const pending=claimAck(child);
  child.send({type:'bfe-desktop-claim-bind',proof});
  return pending;
}
function pausedClaim(origin, cookie, proof) {
  let req;
  let settled=false;
  const response=new Promise((resolve,reject)=>{
    req=httpRequest(origin+'/api/desktop-view',{method:'POST',headers:{
      Origin:origin, Accept:'application/json', Cookie:cookie, 'Content-Type':'application/json',
      'Content-Length':2, 'X-Desktop-Claim':proof,
    }},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>{
        settled=true;
        resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8'),headers:res.headers});
      });
    });
    req.on('error',error=>{if(!settled)reject(error);});
    req.setTimeout(5000,()=>req.destroy(Error('Paused claim timed out')));
  });
  const ready=new Promise(resolve=>{req.write('{',()=>resolve());});
  return {response,ready,settled:()=>settled,finish(){req.end('}');},abort(){req.destroy();}};
}
async function readyMessage(child) {
  const [ready]=await Promise.race([once(child,'message'),once(child,'exit').then(([code])=>{throw Error('Service exited '+code);})]);
  return ready;
}

test('desktop bootstrap claims one launcher view after an unrelated navigation',{timeout:10000},async t=>{
  const {child, stdout}=desktopChild(t);
  const ready=await readyMessage(child);
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
  const withoutProof=await claimDesktop(origin, cookie);
  assert.equal(withoutProof.status, 401);
  assert.equal(withoutProof.headers['set-cookie'], undefined);
  const wrongProof='cd'.repeat(32);
  const wrong=await claimDesktop(origin, cookie, wrongProof);
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers['set-cookie'], undefined);
  const malformed=await bindClaim(child, 'not-a-proof');
  assert.equal(malformed.ok, false);
  assert.equal(Object.hasOwn(malformed, 'proof'), false);
  const proof='ab'.repeat(32);
  const bound=await bindClaim(child, proof);
  assert.equal(bound.ok, true);
  assert.deepEqual(Object.keys(bound).sort(), ['ok','type']);
  const replaced=await bindClaim(child, wrongProof);
  assert.equal(replaced.ok, false);
  assert.equal(Object.hasOwn(replaced, 'proof'), false);
  const otherCookie='bfe_session='+'e'.repeat(64);
  const other=await claimDesktop(origin, otherCookie, proof);
  assert.equal(other.status, 401);
  assert.equal(other.headers['set-cookie'], undefined);
  const claimed=await claimDesktop(origin, cookie, proof);
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
  const second=await claimDesktop(origin, cookie, proof);
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
  const afterLock=await claimDesktop(origin, cookie, proof);
  assert.notEqual(afterLock.status, 200);
  assert.equal(afterLock.body.includes(ticket.viewId), false);
  assert.equal(afterLock.headers['set-cookie'], undefined);
  const after=await rawHttp(origin,'/',{headers:documentHeaders});
  assert.equal(after.body.includes('bfe-desktop-view'), false);
  assert.equal(after.body.includes(ticket.viewId), false);
  assert.doesNotMatch(stdout(), new RegExp(ready.session));
  assert.doesNotMatch(stdout(), new RegExp(ticket.viewId));
  assert.doesNotMatch(stdout(), new RegExp(proof));
});

test('desktop bootstrap does not mint a view after lock',{timeout:10000},async t=>{
  const {child, stdout}=desktopChild(t);
  const ready=await readyMessage(child);
  const origin='http://127.0.0.1:'+ready.port;
  const cookie='bfe_session='+ready.session;
  const page=await rawHttp(origin,'/',{headers:documentHeaders});
  assert.equal(page.path, '/');
  assert.equal(page.body.includes('bfe-desktop-view'), false);
  const locked=await rawHttp(origin,'/api/session/lock',{method:'POST',body:{},headers:{
    Origin:origin, Cookie:cookie, Accept:'application/json',
  }});
  assert.equal(locked.status, 200);
  const proof='ab'.repeat(32);
  const bound=await bindClaim(child, proof);
  assert.equal(bound.ok, true);
  assert.equal(Object.hasOwn(bound, 'proof'), false);
  const claim=await claimDesktop(origin, cookie, proof);
  assert.notEqual(claim.status, 200);
  assert.equal(claim.headers['set-cookie'], undefined);
  assert.equal(claim.body.includes('viewId'), false);
  const again=await rawHttp(origin,'/',{headers:documentHeaders});
  assert.equal(again.body.includes('bfe-desktop-view'), false);
  assert.doesNotMatch(stdout(), /bfe-desktop-view/);
  assert.doesNotMatch(stdout(), new RegExp(ready.session));
  assert.doesNotMatch(stdout(), new RegExp(proof));
});

test('Lock during a desktop claim does not admit the view',{timeout:10000},async t=>{
  const {child, stdout}=desktopChild(t);
  const ready=await readyMessage(child);
  const origin='http://127.0.0.1:'+ready.port;
  const cookie='bfe_session='+ready.session;
  const proof='ab'.repeat(32);
  const page=await rawHttp(origin,'/',{headers:documentHeaders});
  assert.equal(page.status, 200);
  assert.equal(page.body.includes('bfe-desktop-view'), false);
  const bound=await bindClaim(child, proof);
  assert.equal(bound.ok, true);
  const paused=pausedClaim(origin, cookie, proof);
  t.after(()=>paused.abort());
  await paused.ready;
  await new Promise(resolve=>setTimeout(resolve, 50));
  assert.equal(paused.settled(), false);
  const locked=await rawHttp(origin,'/api/session/lock',{method:'POST',body:{},headers:{
    Origin:origin, Cookie:cookie, Accept:'application/json',
  }});
  assert.equal(locked.status, 200);
  assert.equal(paused.settled(), false);
  paused.finish();
  const claim=await paused.response;
  assert.equal(claim.status, 401);
  assert.equal(claim.headers['set-cookie'], undefined);
  assert.equal(claim.body.includes('viewId'), false);
  const later=await claimDesktop(origin, cookie, proof);
  assert.notEqual(later.status, 200);
  assert.equal(later.body.includes('viewId'), false);
  assert.doesNotMatch(stdout(), new RegExp(proof));
  assert.doesNotMatch(stdout(), new RegExp(ready.session));
});

test('a restarted desktop service requires its own claim proof',{timeout:10000},async t=>{
  const first=desktopChild(t);
  const readyA=await readyMessage(first.child);
  const proofA='ab'.repeat(32);
  assert.equal((await bindClaim(first.child, proofA)).ok, true);
  const exited=once(first.child, 'exit');
  first.child.kill();
  await exited;
  const second=desktopChild(t);
  const readyB=await readyMessage(second.child);
  const origin='http://127.0.0.1:'+readyB.port;
  const cookie='bfe_session='+readyB.session;
  const before=await claimDesktop(origin, cookie, proofA);
  assert.equal(before.status, 401);
  assert.equal(before.headers['set-cookie'], undefined);
  const proofB='cd'.repeat(32);
  const bound=await bindClaim(second.child, proofB);
  assert.equal(bound.ok, true);
  assert.equal(Object.hasOwn(bound, 'proof'), false);
  const foreign=await claimDesktop(origin, cookie, proofA);
  assert.notEqual(foreign.status, 200);
  assert.equal(foreign.body.includes('viewId'), false);
  const claimed=await claimDesktop(origin, cookie, proofB);
  assert.equal(claimed.status, 200);
  const ticket=JSON.parse(claimed.body);
  assert.match(ticket.viewId, /^[a-f0-9]{32}$/);
  assert.match(ticket.viewGeneration, /^[a-f0-9]{32}$/);
  assert.equal(foreign.body.includes(ticket.viewId), false);
  assert.doesNotMatch(second.stdout(), new RegExp(proofA));
  assert.doesNotMatch(second.stdout(), new RegExp(proofB));
  assert.doesNotMatch(second.stdout(), new RegExp(readyB.session));
  assert.doesNotMatch(first.stdout(), new RegExp(readyA.session));
});
