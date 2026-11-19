import test from 'node:test';
import assert from 'node:assert/strict';
import {assessRoute,matchesModelIdentity} from './route.mjs';
import {spawnSync} from 'node:child_process';

test('local routes explain the system memory threshold without asserting model quality',()=>{
  const route={engine:'ollama',id:'qwen3:1.7b',bytes:1000000000,remote:false,cloudDisabled:true,digest:'a'.repeat(64)};
  assert.equal(assessRoute(route,2299999999).eligible,false);
  const ready=assessRoute(route,2300000000);
  assert.equal(ready.eligible,true);
  assert.match(ready.reason,/does not qualify.*coding/i);
  assert.equal(assessRoute({...route,engine:'opencode',bytes:0},9000000000).eligible,false);
  assert.match(assessRoute({...route,bytes:4000000001},9000000000).reason,/larger than 4 GB/);
  assert.match(assessRoute({...route,remote:true},9000000000).reason,/remote destination/);
  assert.equal(assessRoute({...route,remote:undefined},9000000000).eligible,false);
  assert.match(assessRoute({...route,cloudDisabled:false},9000000000).reason,/cloud features/);
  assert.equal(assessRoute({...route,cloudDisabled:null},9000000000).eligible,false);
  assert.match(assessRoute({...route,digest:null},9000000000).reason,/identity digest/);
  assert.equal(matchesModelIdentity('a'.repeat(64),'a'.repeat(64)),true);
  assert.equal(matchesModelIdentity('a'.repeat(64),'b'.repeat(64)),false);
  assert.equal(assessRoute(route,null).eligible,false);
});

test('a configured Ollama endpoint remains restricted to a valid loopback port',()=>{
  const code="import {ollamaEndpoint} from './providers.mjs'; process.stdout.write(ollamaEndpoint)";
  const run=port=>spawnSync(process.execPath,['--input-type=module','-e',code],{
    cwd:new URL('.',import.meta.url),env:{...process.env,BFE_OLLAMA_PORT:port},encoding:'utf8',windowsHide:true});
  const valid=run('11534');
  assert.equal(valid.status,0);
  assert.equal(valid.stdout,'http://127.0.0.1:11534');
  for(const port of ['0','65536','example.com','11434/path'])assert.notEqual(run(port).status,0);
});

test('the synthetic fixture is clearly separate and unknown engines are held',()=>{
  const fixture=assessRoute({engine:'fixture'},null);
  assert.equal(fixture.eligible,true);
  assert.match(fixture.reason,/synthetic/i);
  assert.equal(assessRoute({engine:'unapproved-cloud',bytes:1},9000000000).eligible,false);
  assert.match(assessRoute({engine:'ollama',id:'another-local-model',bytes:1000},9000000000).reason,/not enabled/i);
});

test('an explicitly configured llama.cpp route is identified by metadata and checks free memory',()=>{
  const route={engine:'opencode',backend:'llamacpp',id:'synthetic-model',bytes:2500000000,fingerprint:'b'.repeat(64)};
  assert.equal(assessRoute(route,3799999999).eligible,false);
  assert.equal(assessRoute(route,3800000000).eligible,true);
  assert.match(assessRoute(route,3800000000).reason,/metadata/i);
  assert.equal(assessRoute({...route,fingerprint:null},9000000000).eligible,false);
  assert.equal(assessRoute({...route,bytes:4000000001},9000000000).eligible,false);
  assert.equal(assessRoute({...route,engine:'ollama'},9000000000).eligible,false);
});
