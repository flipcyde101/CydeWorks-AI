import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticMessages} from './web/route-diagnostics.js';

test('route diagnostics show the server explanation and bound unexpected text',()=>{
  const messages=diagnosticMessages({models:[{engine:'fixture'}],diagnostics:{messages:[
    {text:'Ollama reports cloud features enabled. Real model routes are held.'},
    {text:'x'.repeat(400)},{text:null},null,
  ]}});
  assert.equal(messages.length,2);
  assert.match(messages[0],/cloud features enabled/);
  assert.equal(messages[1].length,220);
});

test('older or incomplete inventory retains an actionable fallback',()=>{
  assert.deepEqual(diagnosticMessages({models:[{engine:'fixture'}]}),[
    'No supported local models were discovered. Check Ollama and refresh the route list.',
  ]);
  assert.deepEqual(diagnosticMessages({models:[{engine:'ollama'}]}),[]);
  assert.equal(diagnosticMessages({models:[null,{}]}).length,1);
});
