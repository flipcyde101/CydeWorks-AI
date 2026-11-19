import {evaluateRouterDecisions} from './router-evaluator.mjs';

// Reporting only. A report can never grant permission to the execution path.
export function evaluateSubmittedBatch(body, evaluatedAt) {
  const invalid=()=>({ok:false,error:'INVALID_EVALUATION_REQUEST',executionAuthorized:false});
  if(!body||typeof body!=='object'||Array.isArray(body)||
    Object.keys(body).some(key=>!['dataset','decisionsPayload'].includes(key))||
    body.dataset?.isSynthetic!==true||!Array.isArray(body.dataset.cases)||
    body.dataset.cases.length<1||body.dataset.cases.length>10||
    !Array.isArray(body.decisionsPayload?.decisions)||body.decisionsPayload.decisions.length>30)
    return invalid();
  let report;
  // Submitted decisions are replayed at server time, never authenticated as
  // live execution authority. Preserve the evaluator's non-authoritative mode.
  try {report=evaluateRouterDecisions({...body,evaluatedAt,evaluationMode:'historical_replay'});}
  catch {return invalid();}
  if(!report.ok)return invalid();
  return {ok:true,formatVersion:1,scope:'synthetic-evaluation',executionAuthorized:false,
    caveat:'Reported approval validity is a synthetic finding, never permission to execute. Cost and time comparisons are estimates.',report};
}
