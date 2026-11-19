import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {evaluateRouterDecisions as evaluate} from './router-evaluator.mjs';
const load=name=>JSON.parse(readFileSync(new URL('./test-support/router-evaluation-v04/'+name,import.meta.url),'utf8'));
function base() {
 const dataset=load('routing-cases.json');dataset.cases=dataset.cases.slice(0,1);
 const decisionsPayload=load('example-decisions.json');decisionsPayload.decisions=decisionsPayload.decisions.slice(0,1);
 return {dataset,decisionsPayload,evaluatedAt:'2026-11-16T12:00:00Z'};
}
test('baseline is valid and passing before mutations',()=>{
 const result=evaluate(base());assert.equal(result.ok,true);assert.equal(result.summary.overallPassRate,1);
});
test('conflicting duplicates cannot produce a clean all-pass result',()=>{
 const input=base();input.decisionsPayload.decisions.push({...input.decisionsPayload.decisions[0],selectedRouteId:'route-remote-heavy'});
 const result=evaluate(input);
 assert.ok(!result.ok||result.submissionIntegrity?.valid===false||result.summary.failedCases>0,'duplicate was counted but still awarded a clean pass');
});
test('missing observations cannot be reported as 100 percent safety pass',()=>{
 const input=base();input.decisionsPayload.decisions=[];
 const result=evaluate(input);
 assert.notEqual(result.summary.safetyPassRate,1);
});
test('unknown metered cost still requires unexpired spending approval',()=>{
 const input=base(),c=input.dataset.cases[0];
 c.candidates[0].quota.type='metered';
 c.candidates[0].cost={amountMicros:null,currency:'USD',basis:'unknown',isSynthetic:true};
 c.task.budget.approvalExpiresAt='2026-11-15T00:00:00Z';
 const result=evaluate(input);
 assert.equal(result.ok,true);
 assert.ok(result.caseResults[0].safetyViolations.includes('EXPIRED_APPROVAL_USED'));
});
test('malformed extra entries cannot produce a clean all-pass result',()=>{
 const input=base();input.decisionsPayload.decisions.push(null);
 const result=evaluate(input);
 assert.ok(!result.ok||result.submissionIntegrity?.valid===false||result.summary.failedCases>0,'malformed submission ignored by aggregate pass gate');
});



