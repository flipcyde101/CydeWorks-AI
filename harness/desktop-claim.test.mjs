import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {isClaimProof,mayAcceptLauncherClaim,createLauncherClaimGate}=require('./desktop/claim.cjs');
const origin='http://127.0.0.1:9';
const proof='ab'.repeat(32);
const viewId='a'.repeat(32);
const viewGeneration='b'.repeat(32);
function request(extra={}) {
  return {senderWebContentsId:7,frameIsMain:true,frameOrigin:origin,...extra};
}

test('launcher claim acceptance fails closed',()=>{
  const accepted={senderWebContentsId:7,intendedWebContentsId:7,frameIsMain:true,frameOrigin:origin,serviceOrigin:origin,armed:true};
  assert.equal(mayAcceptLauncherClaim(accepted), true);
  assert.equal(isClaimProof(proof), true);
  assert.equal(isClaimProof('ab'), false);
  for(const change of [
    {senderWebContentsId:8},
    {intendedWebContentsId:8},
    {senderWebContentsId:7.5},
    {intendedWebContentsId:7.5},
    {frameIsMain:false},
    {frameIsMain:null},
    {frameOrigin:'http://127.0.0.1:10'},
    {frameOrigin:null},
    {serviceOrigin:null},
    {armed:false},
    {armed:null},
  ]) assert.equal(mayAcceptLauncherClaim({...accepted,...change}), false);
});

test('the launcher posts one claim for the intended main frame',async()=>{
  let calls=0;
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const gate=createLauncherClaimGate({
    proof, serviceOrigin:origin, intendedWebContentsId:()=>7,
    post:({proof:presented})=>{
      assert.equal(presented, proof);
      calls+=1;
      return pending;
    },
  });
  const first=gate.claim(request());
  assert.equal(gate.claim(request({senderWebContentsId:8})), null);
  assert.equal(gate.claim(request({frameIsMain:false})), null);
  assert.equal(gate.claim(request({frameOrigin:'http://elsewhere.invalid'})), null);
  assert.equal(gate.claim(request()), null);
  assert.equal(calls, 1);
  release({status:200,body:{viewId,viewGeneration,extra:'hidden'}});
  assert.deepEqual(await first, {viewId,viewGeneration});
  assert.equal(await gate.claim(request()), null);
  assert.equal(calls, 1);
});

test('a lost launcher claim can retry and a refusal cannot',async()=>{
  let calls=0;
  let outcome={status:500,body:{viewId,viewGeneration}};
  const gate=createLauncherClaimGate({
    proof, serviceOrigin:origin, intendedWebContentsId:7,
    post:()=>{calls+=1;if(outcome instanceof Error)throw outcome;return outcome;},
  });
  assert.equal(await gate.claim(request()), null);
  outcome=new Error('lost');
  assert.equal(await gate.claim(request()), null);
  outcome={status:200,body:{viewId:'short',viewGeneration}};
  assert.equal(await gate.claim(request()), null);
  outcome={status:200,body:{viewId,viewGeneration,secret:proof}};
  assert.deepEqual(await gate.claim(request()), {viewId,viewGeneration});
  assert.equal(calls, 4);
  assert.equal(await gate.claim(request()), null);
  assert.equal(calls, 4);
  const refused=createLauncherClaimGate({
    proof, serviceOrigin:origin, intendedWebContentsId:()=>4,
    post:()=>{calls+=1;return {status:401,body:{viewId}};},
  });
  assert.equal(await refused.claim(request({senderWebContentsId:4})), null);
  assert.equal(await refused.claim(request({senderWebContentsId:4})), null);
  const missing=createLauncherClaimGate({
    proof, serviceOrigin:origin, intendedWebContentsId:()=>4,
    post:()=>{calls+=1;return {status:404,body:null};},
  });
  assert.equal(await missing.claim(request({senderWebContentsId:4})), null);
  assert.equal(await missing.claim(request({senderWebContentsId:4})), null);
  assert.equal(calls, 6);
  let disarmedCalls=0;
  const disarmed=createLauncherClaimGate({
    proof, serviceOrigin:origin, intendedWebContentsId:()=>7,
    post:()=>{disarmedCalls+=1;return {status:200,body:{viewId,viewGeneration}};},
  });
  disarmed.disarm();
  assert.equal(await disarmed.claim(request()), null);
  assert.equal(disarmedCalls, 0);
  const unbound=createLauncherClaimGate({
    proof:'no', serviceOrigin:origin, intendedWebContentsId:()=>7,
    post:()=>{disarmedCalls+=1;return {status:200,body:{viewId,viewGeneration}};},
  });
  assert.equal(await unbound.claim(request()), null);
  assert.equal(disarmedCalls, 0);
  const fractional=createLauncherClaimGate({
    proof, serviceOrigin:origin, intendedWebContentsId:()=>7.2,
    post:()=>{disarmedCalls+=1;return {status:200,body:{viewId,viewGeneration}};},
  });
  assert.equal(await fractional.claim(request()), null);
  assert.equal(disarmedCalls, 0);
});

test('the desktop preload exposes only the claim bridge',async()=>{
  const main=await readFile(new URL('./desktop/main.cjs',import.meta.url),'utf8');
  const preload=await readFile(new URL('./desktop/preload.cjs',import.meta.url),'utf8');
  const claim=await readFile(new URL('./desktop/claim.cjs',import.meta.url),'utf8');
  assert.match(main,/preload:path\.join\(__dirname,'preload\.cjs'\)/);
  assert.match(main,/createLauncherClaimGate/);
  assert.match(main,/bindClaimProof/);
  assert.match(main,/contextIsolation:true/);
  assert.match(main,/sandbox:true/);
  assert.match(main,/nodeIntegration:false/);
  assert.match(main,/webSecurity:true/);
  assert.match(main,/action:'deny'/);
  assert.match(main,/claimGate\?\.disarm\(\)/);
  assert.ok(main.indexOf("ipcMain.handle('bfe-desktop-claim'")<main.indexOf('async function createWorkspace'));
  assert.match(preload,/contextBridge\.exposeInMainWorld\('bfeDesktop'/);
  assert.match(preload,/ipcRenderer\.invoke\('bfe-desktop-claim'\)/);
  assert.doesNotMatch(preload,/localStorage|sessionStorage|bfe_session|proof/);
  assert.doesNotMatch(main,/localStorage|sessionStorage/);
  assert.doesNotMatch(claim,/require\('electron'\)/);
});
