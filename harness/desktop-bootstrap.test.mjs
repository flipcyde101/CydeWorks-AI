import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';

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
