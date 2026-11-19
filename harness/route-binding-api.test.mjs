import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {terminalWorkspace} from './test-support/terminal-workspace.mjs';

async function setup(t,backend='ollama') {
  let folder;
  const model={id:backend==='llamacpp'?'synthetic-model':'qwen3:1.7b',backend,bytes:1,
    ...(backend==='llamacpp'?{fingerprint:'a'.repeat(64)}:{digest:'a'.repeat(64),remote:false,cloudDisabled:true}),
    quantization:'Q4_K_M'};
  const update=value=>writeFile(join(folder,'inventory.json'),JSON.stringify(value));
  const workspace=await terminalWorkspace(t,{startImmediately:false,configure:async target=>{
    folder=target;await update(model);await writeFile(join(folder,'dispatches.txt'),'');
    await writeFile(join(folder,'synthetic-route.mjs'),`
import {readFile,appendFile} from 'node:fs/promises';
export const models=async()=>[JSON.parse(await readFile(new URL('./inventory.json',import.meta.url),'utf8'))];
export const run=async()=>{
  await appendFile(new URL('./dispatches.txt',import.meta.url),'dispatch\\n');
  return {settled:true,artifact:{summary:'Synthetic',content:'After'},usage:null};
};`);
    await writeFile(join(folder,'providers.mjs'),`
import {models,run} from './synthetic-route.mjs';
export const ollamaEndpoint='http://127.0.0.1:1';
export const ollama={models,run,inspect:async()=>({models:${backend==='ollama'?'await models()':'[]'},cloudDisabled:true})};
export const fixture={models:async()=>[{id:'fixture',label:'Synthetic fixture',digest:null}],run};`);
    await writeFile(join(folder,'opencode.mjs'),`
import {models,run} from './synthetic-route.mjs';
export const opencode={availability:async()=>'present',models,run};`);
    await writeFile(join(folder,'llamacpp.mjs'),`
import {models} from './synthetic-route.mjs';
export const llamaCpp={configured:${backend==='llamacpp'},endpoint:'http://127.0.0.1:2',
  inspect:async()=>({models:${backend==='llamacpp'?'await models()':'[]'}})};`);
  }});
  const {request,path}=workspace;
  const inventory=async()=>await (await request('/api/models')).json();
  const finish=async()=>{
    for(let i=0;i<100;i++) {
      const task=await (await request(path)).json();
      if(task.status!=='running')return task;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw Error('Synthetic route did not settle.');
  };
  const calls=async()=>(await readFile(join(folder,'dispatches.txt'),'utf8')).split('\n').filter(Boolean).length;
  function approval(task,route) {
    return {requestId:randomUUID(),version:task.version,sourceHash:task.sourceHash,approve:true,
      model:route.id,engine:route.engine,backend:route.backend??(route.engine==='fixture'?'fixture':'ollama'),
      ...(route.digest?{modelDigest:route.digest}:{}),...(route.fingerprint?{modelFingerprint:route.fingerprint}:{}),
      routeRevision:route.revision};
  }
  return {...workspace,model,update,inventory,finish,calls,approval};
}

test('matching reviewed route permits one synthetic dispatch for each supported engine/backend',
  {timeout:20000},async t=>{
  for(const [engine,backend] of [['fixture','ollama'],['ollama','ollama'],['opencode','ollama'],['opencode','llamacpp']]) {
    await t.test(engine+'/'+backend,async t=>{
      const s=await setup(t,backend),route=(await s.inventory()).models.find(row=>row.engine===engine);
      const body=s.approval(s.task,route);
      assert.equal((await s.request(s.path+'/run',body)).status,202);
      const done=await s.finish();assert.equal(done.status,'review');assert.equal(await s.calls(),1);
      assert.equal(done.attempts[0].approvedRouteRevision,route.revision);
      assert.equal(done.attempts[0].observedRouteRevision,route.revision);
      assert.equal((await s.request(s.path+'/run',body)).status,200);
      assert.equal(await s.calls(),1);
    });
  }
});

test('changed route is held before dispatch and keyed replay cannot drop or replace its binding',
  {timeout:10000},async t=>{
  const s=await setup(t),route=(await s.inventory()).models.find(row=>row.engine==='opencode');
  const body=s.approval(s.task,route);
  await s.update({...s.model,quantization:'Q3_K_M'});
  assert.equal((await s.request(s.path+'/run',body)).status,202);
  const held=await s.finish();assert.equal(held.status,'failed');assert.equal(await s.calls(),0);
  assert.equal(held.attempts[0].execution.phase,'claimed');
  assert.match(held.attempts[0].problem,/selected route changed/i);
  assert.equal(held.attempts[0].observedRouteRevision,undefined);
  const fresh=(await s.inventory()).models.find(row=>row.engine==='opencode');
  assert.notEqual(fresh.revision,route.revision);
  assert.equal((await s.request(s.path+'/run',body)).status,200);
  const {routeRevision,...unbound}=body;
  assert.equal((await s.request(s.path+'/run',unbound)).status,409);
  assert.equal((await s.request(s.path+'/run',{...body,routeRevision:fresh.revision})).status,409);
  const latest=await (await s.request(s.path)).json();assert.equal(latest.attempts.length,1);
  assert.equal((await s.request(s.path+'/run',s.approval(latest,fresh))).status,202);
  assert.equal((await s.finish()).status,'review');assert.equal(await s.calls(),1);
});

test('a revision cannot bypass session, scope, identity or readiness gates',
  {timeout:10000},async t=>{
  const s=await setup(t),route=(await s.inventory()).models.find(row=>row.engine==='ollama');
  const body=s.approval(s.task,route);
  assert.equal((await s.request(s.path+'/run',body,{authenticated:false})).status,401);
  assert.equal((await s.request(s.path+'/run',body,{originHeader:'https://untrusted.invalid'})).status,403);
  for(const change of [{approve:false},{sourceHash:'b'.repeat(64)},{version:0}])
    assert.ok([400,409].includes((await s.request(s.path+'/run',{...body,...change})).status));
  for(const keyed of [true,false])for(const value of [null,123,'bad']) {
    const invalid={...body,routeRevision:value};if(!keyed)delete invalid.requestId;
    assert.equal((await s.request(s.path+'/run',invalid)).status,400);
  }
  assert.equal((await (await s.request(s.path)).json()).attempts.length,0);
  assert.equal((await s.request(s.path+'/run',{...body,modelDigest:'b'.repeat(64)})).status,202);
  let held=await s.finish();assert.match(held.attempts[0].problem,/identity changed/i);
  assert.equal(await s.calls(),0);
  await s.update({...s.model,cloudDisabled:false});
  const heldRoute=(await s.inventory()).models.find(row=>row.engine==='ollama');
  assert.equal((await s.request(s.path+'/run',s.approval(held,heldRoute))).status,202);
  held=await s.finish();assert.match(held.attempts.at(-1).problem,/cloud features/i);
  assert.equal(await s.calls(),0);
});
