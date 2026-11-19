import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {terminalWorkspace} from './test-support/terminal-workspace.mjs';

test('host inventory revisions track synthetic identity, holds, disappearance and recovery without dispatch',
  {timeout:20000},async t=>{
  let fixturePath;
  const model={id:'qwen3:1.7b',bytes:1,digest:'a'.repeat(64),remote:false,cloudDisabled:true};
  const update=state=>writeFile(fixturePath,JSON.stringify(state));
  const {request,path}=await terminalWorkspace(t,{configure:async folder=>{
    fixturePath=join(folder,'inventory.json');await update({models:[model]});
    await writeFile(join(folder,'providers.mjs'),`
import {readFile} from 'node:fs/promises';
export const ollamaEndpoint='http://127.0.0.1:1';
export const ollama={inspect:async()=>{
  const state=JSON.parse(await readFile(new URL('./inventory.json',import.meta.url),'utf8'));
  if(state.failed)throw Error('Synthetic unavailable inventory');
  return {models:state.models,cloudDisabled:true};
}};
export const fixture={models:async()=>[]};
`);
  }});
  const before=await (await request(path)).json();
  assert.equal((await request('/api/models',undefined,{authenticated:false})).status,401);
  assert.equal((await request('/api/models',undefined,{originHeader:'https://untrusted.invalid'})).status,403);
  const read=async()=>{
    const response=await request('/api/models');assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    const data=await response.json();
    assert.equal(data.executionAuthorized,false);
    assert.match(data.revision,/^[a-f0-9]{64}$/);
    assert.equal(Date.parse(data.expiresAt)-Date.parse(data.observedAt),30000);
    assert.ok(data.diagnostics);return data;
  };
  const first=await read(),same=await read();
  assert.equal(first.revision,same.revision);
  assert.equal(first.models.length,2);
  assert.ok(first.models.every(item=>/^[a-f0-9]{64}$/.test(item.revision)));
  await update({models:[{...model,digest:'b'.repeat(64)}]});
  const changed=await read();assert.notEqual(changed.revision,first.revision);
  await update({models:[{...model,cloudDisabled:false}]});
  const held=await read();assert.notEqual(held.revision,first.revision);
  assert.ok(held.models.every(item=>item.readiness.eligible===false));
  await update({failed:true});
  const absent=await read();assert.equal(absent.models.length,0);
  assert.notEqual(absent.revision,held.revision);
  await update({models:[model]});
  assert.equal((await read()).revision,first.revision);
  const after=await (await request(path)).json();
  assert.equal(after.status,'running');assert.equal(after.version,before.version);
  assert.deepEqual(after.attempts,before.attempts);assert.deepEqual(after.events,before.events);
});
