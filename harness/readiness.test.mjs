import test from 'node:test';
import assert from 'node:assert/strict';
import {createOllama} from './providers.mjs';
import {buildReadiness} from './readiness.mjs';
import {openCodeAvailability} from './opencode.mjs';

const ok=value=>({status:'fulfilled',value});
const failed=reason=>({status:'rejected',reason});

test('an empty local inventory is distinct from a failed service',async()=>{
  const adapter=createOllama({transport:async url=>url.endsWith('/api/status')
    ?Response.json({cloud:{disabled:true}}):Response.json({models:[]})});
  const inspection=await adapter.inspect();
  assert.deepEqual(inspection,{models:[],cloudDisabled:true});
  const report=buildReadiness(ok(inspection),ok('missing'));
  assert.deepEqual(report.ollama,{status:'available',cloud:'disabled',modelCount:0});
  assert.equal(report.opencode.status,'missing');
  assert.ok(report.messages.some(message=>message.code==='no_models'));
  assert.ok(report.messages.some(message=>message.code==='opencode_missing'));
});

test('a failed inventory produces safe diagnostic text without exposing the error',()=>{
  const report=buildReadiness(failed(Error('PRIVATE_SYNTHETIC_ERROR')),ok('unknown'));
  assert.deepEqual(report.ollama,{status:'unavailable',cloud:'unknown',modelCount:null});
  assert.equal(report.opencode.status,'unknown');
  assert.ok(report.messages.some(message=>message.code==='ollama_unavailable'));
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_SYNTHETIC_ERROR/);
});

test('cloud-enabled and unknown cloud status remain distinct and do not enable a route',async()=>{
  let state=false;
  const adapter=createOllama({transport:async url=>url.endsWith('/api/status')
    ?state===null?new Response('',{status:503}):Response.json({cloud:{disabled:state}})
    :Response.json({models:[{name:'qwen3:1.7b',size:1,digest:'a'.repeat(64)}]})});
  const enabled=buildReadiness(ok(await adapter.inspect()),ok('present'));
  assert.equal(enabled.ollama.cloud,'enabled');
  assert.ok(enabled.messages.some(message=>message.code==='cloud_enabled'));
  state=null;
  const unknown=buildReadiness(ok(await adapter.inspect()),failed(Error('PRIVATE_SYNTHETIC_PATH')));
  assert.equal(unknown.ollama.cloud,'unknown');
  assert.equal(unknown.opencode.status,'unknown');
  assert.ok(unknown.messages.some(message=>message.code==='cloud_unknown'));
  assert.doesNotMatch(JSON.stringify(unknown),/PRIVATE_SYNTHETIC_PATH/);
});

test('OpenCode file checks distinguish missing from an unknown access failure',async()=>{
  const regular=async()=>({isFile:()=>true});
  assert.equal(await openCodeAvailability({inspect:regular,probe:async()=>{}}),'present');
  assert.equal(await openCodeAvailability({inspect:async()=>({isFile:()=>false}),probe:async()=>{throw Error('must not run');}}),'missing');
  assert.equal(await openCodeAvailability({inspect:async()=>{throw Object.assign(Error('PRIVATE_SYNTHETIC_PATH'),{code:'ENOENT'});}}),'missing');
  assert.equal(await openCodeAvailability({inspect:regular,probe:async()=>{throw Object.assign(Error('PRIVATE_SYNTHETIC_PATH'),{code:'EACCES'});}}),'unknown');
});

test('an inventory timeout is not reported as a long inference timeout',async()=>{
  const adapter=createOllama({transport:async url=>{
    if(url.endsWith('/api/tags'))throw new DOMException('PRIVATE_SYNTHETIC_ERROR','TimeoutError');
    return Response.json({cloud:{disabled:true}});
  }});
  await assert.rejects(()=>adapter.models(),error=>/inventory check timed out/i.test(error.message)&&!/PRIVATE_SYNTHETIC_ERROR/.test(error.message));
});
