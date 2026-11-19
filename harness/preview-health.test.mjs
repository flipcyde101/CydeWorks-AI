import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {terminalWorkspace} from './test-support/terminal-workspace.mjs';

test('preview health identifies the loaded entry point without unlocking or probing providers',{timeout:15000},async context=>{
  let entry;
  const {origin,request,path}=await terminalWorkspace(context,{startImmediately:false,configure:async folder=>{
    entry=join(folder,'server.mjs');
    await writeFile(join(folder,'providers.mjs'),`
export const ollamaEndpoint='http://127.0.0.1:1';
export const ollama={inspect:()=>{process.exit(85);}};
export const fixture={models:()=>{process.exit(86);}};
`);
  }});
  const revision=createHash('sha256').update(await readFile(entry)).digest('hex');
  const baseline=await (await request(path)).text();
  const readHealth=()=>request('/api/health',undefined,{authenticated:false});
  const response=await readHealth();
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.deepEqual(await response.json(),{status:'ready',serverRevision:revision});
  assert.equal((await request(path,undefined,{authenticated:false})).status,401);
  assert.equal((await request('/api/health',undefined,{originHeader:'https://example.invalid'})).status,403);
  assert.equal((await fetch(origin+'/api/health',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  const wrongMethod=await request('/api/health',{});
  assert.equal(wrongMethod.status,405);
  assert.equal(wrongMethod.headers.get('allow'),'GET');
  assert.equal(await (await request(path)).text(),baseline);
  await writeFile(entry,await readFile(entry,'utf8')+'\n');
  assert.deepEqual(await (await readHealth()).json(),{status:'ready',serverRevision:revision});
  assert.equal((await request('/api/session/lock',{})).status,200);
  assert.deepEqual(await (await readHealth()).json(),{status:'ready',serverRevision:revision});
});
