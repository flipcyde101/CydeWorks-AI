import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {evaluateRouterDecisions} from './router-evaluator.mjs';
import {validateEvaluationResult} from './router-evaluation-contract.mjs';
const load=name=>JSON.parse(readFileSync(new URL('./test-support/router-evaluation-v04/'+name,import.meta.url),'utf8'));
function result() {
 const value=evaluateRouterDecisions({dataset:load('routing-cases.json'),decisionsPayload:load('example-decisions.json'),evaluatedAt:'2026-11-16T12:00:00Z'});
 assert.equal(value.overallVerdict,'fail_safety');
 assert.equal(validateEvaluationResult(value).valid,true);
 return value;
}
test('valid generated result passes its own contract',()=>{result();});
test('validator refuses a passing verdict attached to failing safety cases',()=>{
 const value=result();value.overallVerdict='pass';
 assert.equal(validateEvaluationResult(value).valid,false);
});
test('validator refuses valid-range rates contradicting the counts',()=>{
 const value=result();value.summary.safetyPassRate=1;
 assert.equal(validateEvaluationResult(value).valid,false);
});
test('validator checks nested case result field types',()=>{
 const value=result();value.caseResults[0].safetyViolations=null;
 assert.equal(validateEvaluationResult(value).valid,false);
});


