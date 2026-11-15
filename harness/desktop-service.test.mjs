import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {createUtilityWorker,launchWorkspace,requestLocal,queryWorkspaceStatus,createWriteFence}=require('./desktop/service.cjs');

test('utility-process bridge starts and queries the private workspace through a simulated parent port', {timeout:10000},async t=>{
  let receivedOptions,heartbeats=0;
  const fakeUtility={fork(_server,_args,options){
    receivedOptions=options;
    const child=fork(fileURLToPath(new URL('./desktop/utility-test-child.cjs',import.meta.url)),[],{
      env:options.env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],
    });
    child.postMessage=message=>{if(message?.type==='bfe-owner-heartbeat')heartbeats++;child.send(message);};
    return child;
  }};
  const service=await launchWorkspace({serverPath:fileURLToPath(new URL('./server.mjs',import.meta.url)),
    env:{...process.env,BFE_TEST_MEMORY:'1',BFE_TEST_KEY:'e'.repeat(64),BFE_TEST_OWNER_TIMEOUT_MS:'3000'},
    workerFactory:(script,env)=>createUtilityWorker(fakeUtility,script,env)});
  t.after(async()=>{
    if(service.child.exitCode===null&&service.child.signalCode===null){
      const exited=once(service.child,'exit');service.child.kill();await exited;
    }
  });
  assert.equal(receivedOptions.env.ELECTRON_RUN_AS_NODE,undefined);
  assert.equal((await fetch(service.origin+'/api/tasks',{headers:{Cookie:'bfe_session='+service.session}})).status,200);
  assert.equal(await queryWorkspaceStatus(service.child),false);
  await new Promise(resolve=>setTimeout(resolve,3500));
  assert.ok(heartbeats>=1);
  assert.equal(await queryWorkspaceStatus(service.child),false);
});

test('utility workspace closes when its owner heartbeat stops', {timeout:10000},async()=>{
  const child=fork(fileURLToPath(new URL('./desktop/utility-test-child.cjs',import.meta.url)),[],{windowsHide:true,
    env:{...process.env,BFE_PORT:'0',BFE_TEST_MEMORY:'1',BFE_TEST_KEY:'e'.repeat(64),
      BFE_DESKTOP_BOOTSTRAP:'1',BFE_TEST_OWNER_TIMEOUT_MS:'200'},stdio:['ignore','pipe','pipe','ipc']});
  child.stdout.resume();child.stderr.resume();
  const [ready]=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('Workspace exited early');})]);
  assert.equal(ready.type,'bfe-desktop-ready');
  const [code]=await once(child,'exit');
  assert.equal(code,0);
});

test('desktop service starts an isolated authenticated workspace without a file picker', {timeout:10000},async t=>{
  const service=await launchWorkspace({serverPath:fileURLToPath(new URL('./server.mjs',import.meta.url)),
    execPath:process.execPath,env:{...process.env,BFE_TEST_MEMORY:'1',BFE_TEST_KEY:'d'.repeat(64)}});
  t.after(async()=>{
    if(service.child.exitCode===null&&service.child.signalCode===null){
      const exited=once(service.child,'exit');service.child.kill();await exited;
    }
  });
  assert.match(service.origin,/^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(service.origin+'/api/tasks')).status,401);
  assert.equal((await fetch(service.origin+'/api/tasks',{headers:{Cookie:'bfe_session='+service.session}})).status,200);
  assert.equal((await fetch(service.origin+'/api/tasks',{headers:{Cookie:'bfe_session='+service.session,
    Origin:'https://elsewhere.invalid'}})).status,403);
  assert.equal(await queryWorkspaceStatus(service.child),false);
  const exited=once(service.child,'exit');
  service.child.disconnect();
  await exited;
  await assert.rejects(()=>queryWorkspaceStatus(service.child),/unavailable/);
});

test('closing fences new writes and treats failed delivered writes as uncertain',async()=>{
  const uncertain=createWriteFence();
  assert.equal(uncertain.begin('first'),true);
  uncertain.beginClose();
  assert.equal(uncertain.begin('later'),false);
  uncertain.failed('first');
  assert.equal(await uncertain.drained(20),false);
  uncertain.cancelClose();
  assert.equal(uncertain.begin('retry'),true);
  uncertain.completed('retry');
  assert.equal(await uncertain.drained(20),false);
  const settled=createWriteFence();
  assert.equal(settled.begin('first'),true);
  settled.beginClose();
  settled.completed('first');
  assert.equal(await settled.drained(20),true);
  const stuck=createWriteFence();
  stuck.begin('first');
  stuck.beginClose();
  assert.equal(await stuck.drained(20),false);
});

test('desktop service reports startup failure instead of hanging', {timeout:10000},async()=>{
  await assert.rejects(()=>launchWorkspace({serverPath:fileURLToPath(new URL('./missing-test-service.mjs',import.meta.url)),
    execPath:process.execPath,env:{...process.env,BFE_TEST_MEMORY:'1',BFE_TEST_KEY:'d'.repeat(64)},timeoutMs:3000}),
  /could not start|exited during startup|did not start in time/);
});

test('desktop local requests time out on stalled bodies and reject oversized responses', {timeout:10000},async t=>{
  const server=createServer((request,response)=>{
    response.writeHead(200,{'Content-Type':'text/plain'});
    if(request.url==='/stall'){response.write('partial');return;}
    response.end('x'.repeat(200));
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const origin='http://127.0.0.1:'+server.address().port;
  await assert.rejects(()=>requestLocal(origin+'/stall',{},100),/timed out/);
  await assert.rejects(()=>requestLocal(origin+'/large',{},1000,32),/too large/);
});
