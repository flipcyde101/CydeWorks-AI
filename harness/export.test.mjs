import test from 'node:test';
import assert from 'node:assert/strict';
import {exportTask} from './export.mjs';
import {createStepReceipt} from './opencode-usage.mjs';

test('minimal export removes potentially identifying metadata and preserves only measured usage',()=>{
  const secret='PRIVATE_SENTINEL';
  const task={kind:'brief',status:'accepted',title:secret,filename:secret,id:secret,source:secret,request:secret,
    expected:secret,sourceHash:secret,events:[secret],attempts:[{
      id:secret,model:secret,engineSessionId:secret,provider:'opencode',status:'accepted',elapsedMs:150,
      terminal:[secret],artifact:{content:secret},problem:secret,usage:{evidence:'OpenCode reported',input:3,output:4,cached:null},
    }]};
  const result=exportTask(task,'minimal');
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_SENTINEL/);
  assert.equal(result.task.attempts[0].usage.input,3);
  assert.equal(result.task.attempts[0].usage.cached,null);
  assert.equal(result.task.attempts[0].elapsedMs,150);
  const standard=exportTask(task,'standard');
  assert.equal(standard.task.title,secret);
  assert.equal(standard.task.source,undefined);
  assert.equal(standard.task.attempts[0].artifact,undefined);
  assert.throws(()=>exportTask(task,'unknown'),/supported export mode/);
});

test('minimal export includes only sanitized observed step counts',()=>{
  const collector=createStepReceipt();
  collector.observe({type:'step_finish',sessionID:'PRIVATE_SENTINEL',part:{id:'SECRET_ID',
    sessionID:'PRIVATE_SENTINEL',messageID:'SECRET_MESSAGE',tokens:{input:3,output:4,cache:{read:1},reasoning:0}}});
  const usage=collector.snapshot();
  usage.input=999;
  usage.steps.items[0].unexpected='PRIVATE_SENTINEL';
  const result=exportTask({kind:'brief',status:'accepted',attempts:[{provider:'opencode',status:'accepted',usage}]},'minimal');
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_SENTINEL|SECRET_ID|SECRET_MESSAGE/);
  assert.equal(result.task.attempts[0].usage.steps.items[0].input,3);
  assert.equal(result.task.attempts[0].usage.input,3);
  assert.equal(result.task.attempts[0].usage.semantics,'opencode-engine-defined');
});
