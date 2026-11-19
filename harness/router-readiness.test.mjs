import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {evaluateSubmittedBatch} from './router-evaluation-api.mjs';
import {evaluateRouterDecisions} from './router-evaluator.mjs';
import {validateEvaluationResult} from './router-evaluation-contract.mjs';
import {inspectTaskConnections} from './connection-host.mjs';

const dataset=JSON.parse(await readFile(new URL('./test-support/router-evaluation-v04/routing-cases.json',import.meta.url)));
const decisionsPayload=JSON.parse(await readFile(new URL('./test-support/router-evaluation-v04/example-decisions.json',import.meta.url)));
const now='2026-11-16T12:00:00Z';
const batch={dataset:{...dataset,cases:dataset.cases.slice(0,1)},
  decisionsPayload:{...decisionsPayload,decisions:decisionsPayload.decisions.slice(0,1)}};

test('integrated evaluator preserves all 53 supplied cases and deliberate failures',()=>{
  const report=evaluateRouterDecisions({dataset,decisionsPayload,evaluatedAt:now});
  assert.equal(report.ok,true);
  assert.equal(report.caseResults.length,53);
  assert.equal(validateEvaluationResult(report).valid,true);
  assert.equal(report.overallVerdict,'fail_safety');
  assert.ok(report.summary.safetyViolationsCount>0);
});

test('evaluation boundary uses the host clock and never authorizes execution',()=>{
  const input=structuredClone(batch),before=JSON.stringify(input);
  input.decisionsPayload.evaluatedAt='2020-01-01T00:00:00Z';
  const result=evaluateSubmittedBatch(input,now);
  assert.equal(result.ok,true);assert.equal(result.report.evaluatedAt,now);
  assert.equal(result.executionAuthorized,false);
  assert.equal(result.report.authoritativeAuthorization,false);
  assert.equal(result.report.evaluationMode,'historical_replay');
  assert.equal(result.scope,'synthetic-evaluation');
  assert.equal(input.decisionsPayload.evaluatedAt,'2020-01-01T00:00:00Z');
  assert.equal(JSON.stringify(batch),before);
});

test('evaluation rejects unknown options, oversized batches and non-synthetic input without echo',()=>{
  for(const body of [null,[],{}, {...batch,evaluatedAt:now}, {...batch,evaluationMode:'historical_replay'},
    {...batch,dataset:{...batch.dataset,isSynthetic:false}},
    {...batch,dataset:{...batch.dataset,cases:Array(11).fill(batch.dataset.cases[0])}},
    {...batch,decisionsPayload:{...batch.decisionsPayload,decisions:Array(31).fill({})}},
    {...batch,dataset:{...batch.dataset,cases:[{caseId:'PRIVATE_CANARY'}]}}]) {
    const result=evaluateSubmittedBatch(body,now);
    assert.equal(result.ok,false);assert.equal(result.executionAuthorized,false);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_CANARY/);
  }
});

const task={id:'task-001',version:3,kind:'change',source:'PRIVATE_SOURCE',title:'PRIVATE_TITLE',request:'PRIVATE_REQUEST'};
const model={engine:'ollama',id:'qwen3:1.7b',bytes:1,digest:'a'.repeat(64),remote:false,cloudDisabled:true};
const options={now,freeBytes:8e9,endpoints:{ollama:'http://127.0.0.1:11434',llamacpp:'http://127.0.0.1:18444'}};

test('host inventory never promotes metadata or supplied attestation into production qualification',()=>{
  const input={...model,capabilities:{structuredJson:'supported'},hostVerification:{verifiedByHost:true},
    evidence:{source:'observed',verifiedAt:now},label:'PRIVATE_MODEL'};
  const before=JSON.stringify(input);
  const result=inspectTaskConnections(task,[input],options);
  assert.equal(result.executionAuthorized,false);assert.equal(result.taskVersion,3);
  assert.equal(result.connections[0].previewEligibility.eligible,true);
  const q=result.connections[0].qualification;
  assert.equal(q.productionEligible,false);assert.equal(q.demonstrationReady,false);
  assert.equal(q.evidenceSource,'observed');assert.equal(q.fieldSources.capabilities,'unknown');
  assert.equal(q.fieldSources.reachability,'unknown');
  assert.equal(q.distinctFacts.modelReachable,'unknown');
  assert.ok(q.productionEligibilityGaps.length>0);
  assert.ok(q.capabilitySummary.every(item=>item.status!=='supported'));
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_SOURCE|PRIVATE_TITLE|PRIVATE_REQUEST|PRIVATE_MODEL/);
  assert.equal(JSON.stringify(input),before);
});

test('large inventories are visibly bounded without claiming all routes were evaluated',()=>{
  const result=inspectTaskConnections(task,Array.from({length:70},(_,i)=>({...model,id:'model-'+i})),options);
  assert.equal(result.connections.length,50);
  assert.deepEqual(result.inventory,{totalRoutes:70,evaluatedRoutes:50,limit:50,truncated:true});
});

test('readiness preserves cloud, memory, model identity and backend holds',()=>{
  for(const change of [{cloudDisabled:false},{cloudDisabled:undefined},{remote:true},{digest:null},{bytes:5e9},
    {id:'unapproved-model'},{engine:'unknown'}]) {
    const row=inspectTaskConnections(task,[{...model,...change}],options).connections[0];
    assert.equal(row.previewEligibility.eligible,false);
    assert.equal(row.qualification.productionEligible,false);
  }
  assert.equal(inspectTaskConnections(task,[model],{...options,freeBytes:1}).connections[0].previewEligibility.eligible,false);
  assert.deepEqual(inspectTaskConnections(task,[{engine:'fixture'}],options).connections,[]);
  const llama=inspectTaskConnections(task,[{engine:'opencode',backend:'llamacpp',id:'local',bytes:1,fingerprint:'b'.repeat(64)}],options);
  assert.equal(llama.connections[0].qualification.productionEligible,false);
  assert.equal(llama.connections[0].qualification.destinationSummary.executionLocation,'unknown');
});
