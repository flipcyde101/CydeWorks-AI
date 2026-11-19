import test from 'node:test';
import assert from 'node:assert/strict';
import {createLlamaCpp} from './llamacpp.mjs';

const model={id:'synthetic-model',owned_by:'llamacpp',meta:{size:2500000000,n_ctx:4096,n_params:4000000000}};
const transportFor=value=>async url=>url.endsWith('/health')
  ?Response.json({status:'ok'}):Response.json({data:[value]});

test('llama.cpp discovery is opt-in and fingerprints reported metadata',async()=>{
  assert.deepEqual(await createLlamaCpp({port:undefined}).models(),[]);
  const adapter=createLlamaCpp({port:'12345',transport:transportFor(model)});
  const [route]=await adapter.models();
  assert.equal(route.id,'synthetic-model');
  assert.equal(route.backend,'llamacpp');
  assert.equal(route.endpoint,'http://127.0.0.1:12345');
  assert.match(route.fingerprint,/^[a-f0-9]{64}$/);
  assert.notEqual(route.fingerprint,(await createLlamaCpp({port:'12345',transport:transportFor({...model,
    meta:{...model.meta,size:model.meta.size+1}})}).models())[0].fingerprint);
  assert.equal(route.digest,undefined);
});

test('invalid ports, private path identifiers, and non-llama services are held',async()=>{
  await assert.rejects(()=>createLlamaCpp({port:'example.com'}).models(),/port/i);
  for(const value of [{...model,id:'C:\\Users\\PRIVATE\\model.gguf'},{...model,id:'fixture'},{...model,owned_by:'other'}]) {
    const adapter=createLlamaCpp({port:'12345',transport:transportFor(value)});
    await assert.rejects(()=>adapter.models(),error=>!/PRIVATE|Users/.test(error.message));
  }
  const unavailable=createLlamaCpp({port:'12345',transport:async()=>{throw Error('PRIVATE_PATH');}});
  await assert.rejects(()=>unavailable.models(),error=>!/PRIVATE_PATH/.test(error.message));
});

test('recognized llama.cpp quantization is labeled as server metadata and affects the fingerprint',async()=>{
  const reported=async ftype=>(await createLlamaCpp({port:'12345',transport:transportFor({...model,
    meta:{...model.meta,ftype}})}).models())[0];
  const medium=await reported('Q4_K - Medium');
  assert.equal(medium.quantization,'Q4_K - Medium');
  assert.equal(medium.identityKind,'server-metadata');
  assert.notEqual(medium.fingerprint,(await reported('Q4_K - Small')).fingerprint);
  assert.equal((await reported('C:\\PRIVATE\\model.gguf')).quantization,null);
  assert.doesNotMatch(JSON.stringify(await reported('C:\\PRIVATE\\model.gguf')),/PRIVATE/);
  assert.equal((await reported('Q8_K_L - Large')).quantization,null);
  assert.equal((await reported('all F32')).quantization,'all F32');
  assert.equal((await reported('IQ4_XS - 4.25 bpw')).quantization,'IQ4_XS - 4.25 bpw');
  assert.equal((await reported('(guessed) Q4_K - Medium')).quantization,'(guessed) Q4_K - Medium');
  assert.equal((await reported(15)).quantization,null);
  assert.notEqual((await reported('C:\\PRIVATE\\model.gguf')).fingerprint,
    (await reported('C:\\OTHER\\model.gguf')).fingerprint);
  assert.notEqual((await reported('\ud800')).fingerprint,(await reported('\ud801')).fingerprint);
  await assert.rejects(()=>reported('x'.repeat(257)),/metadata/i);
});
