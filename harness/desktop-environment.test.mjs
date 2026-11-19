import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {desktopChildEnvironment}=require('./desktop/environment.cjs');

test('desktop forwards only allowed settings including the exact OpenCode selection',()=>{
  const input={PATH:'synthetic-path',BFE_OLLAMA_PORT:'11434',BFE_LLAMACPP_PORT:'8080',BFE_OPENCODE_EXECUTABLE:'synthetic-executable',
    UNRELATED_SECRET:'synthetic-secret'};
  const env=desktopChildEnvironment(input,'synthetic-temp');
  assert.equal(env.BFE_OPENCODE_EXECUTABLE,'synthetic-executable');
  assert.equal(env.BFE_OLLAMA_PORT,'11434');
  assert.equal(env.BFE_LLAMACPP_PORT,'8080');
  assert.equal(env.TEMP,'synthetic-temp');
  assert.equal(env.TMP,'synthetic-temp');
  assert.equal(Object.hasOwn(env,'UNRELATED_SECRET'),false);
  assert.equal(desktopChildEnvironment({BFE_OPENCODE_EXECUTABLE:''},'tmp').BFE_OPENCODE_EXECUTABLE,'');
});
