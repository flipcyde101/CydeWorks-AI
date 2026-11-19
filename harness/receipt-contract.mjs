// The authoritative contract for CydeWorks AI run receipts and for the export
// envelope that carries them. Pure data checks: no I/O, clock or randomness.
//
// RECEIPT_CONTRACT is the inspector payload, schemaVersion 1. It keeps the
// field names, allowed values and meanings of the Run Inspector's version 1
// and adds only structural hardening: closed objects, bounded strings and
// lists, dense arrays, no accessors. Every payload valid here is valid for the
// inspector's validateRun. The reverse does not hold for payloads carrying
// undocumented properties, control characters or oversized values.
//
// EXPORT_CONTRACT is the envelope. Token usage and provenance live in its
// `evidence` section, outside the inspector payload.

export const RECEIPT_SCHEMA_VERSION=1;
export const RECEIPT_EXPORT_FORMAT='cydeworks.run-receipt-export';
export const RECEIPT_EXPORT_VERSION=2;
export const ATTEMPT_STATUSES=Object.freeze(['running','succeeded','failed','cancelled','interrupted']);
export const COST_EVIDENCE=Object.freeze(['provider-billed','estimated']);
export const TIMEBASES=Object.freeze(['run-relative','epoch']);
export const LIMITS=Object.freeze({identifier:200,label:120,attempts:1000,steps:64,note:400,issues:50});

// Why a task record cannot be turned into a truthful receipt.
export const UNAVAILABLE_REASONS=Object.freeze({
  'task-record-invalid':'The task record is not a plain object.',
  'task-id-missing':'The task record has no usable identifier.',
  'input-identity-missing':'The approved instruction or source snapshot is not fully recorded.',
  'input-unicode-invalid':'The recorded input contains malformed Unicode and cannot establish exact approved input identity.',
  'source-hash-mismatch':'The recorded snapshot hash does not match the stored source snapshot.',
  'attempt-records-missing':'The task is past draft but its attempt records are absent.',
  'no-attempts-recorded':'The task is a draft. No attempt has been recorded, so there is no run.',
  'attempt-limit-exceeded':'The task holds more attempts than a receipt can carry.',
  'attempt-record-invalid':'An attempt record is malformed or repeats an identifier.',
  'attempt-status-unrecognized':'An attempt has a status this contract does not define.',
  'approved-input-unrecorded':'An attempt has no recorded scope hash, so its approved input cannot be verified.',
  'approved-input-mismatch':'An attempt scope hash does not match the task instruction and source snapshot now on record.',
  'charge-input-invalid':'The supplied charge records are not a bounded list.',
  'contract-violation':'The adapter produced output outside the receipt contract. Nothing was exported.',
});

const text=(max,pattern)=>({type:'string',max,...(pattern?{pattern}:{})});
const flag={type:'boolean'};
const count={type:'integer'};
const amount={type:'number'};
const nullable=spec=>({...spec,nullable:true});
const optional=spec=>({...spec,optional:true});
const oneOf=(...values)=>({type:'enum',values});
const exactly=value=>({type:'const',value});
const shape=keys=>({type:'object',keys});
const list=(items,max)=>({type:'array',items,max});
function deepFreeze(value) {
  if(value&&typeof value==='object'&&!(value instanceof RegExp)&&!Object.isFrozen(value)) {
    Object.freeze(value);
    for(const child of Object.values(value))deepFreeze(child);
  }
  return value;
}

const COST=shape({amountMicros:count,currency:text(3,/^[A-Z]{3}$/),evidence:oneOf(...COST_EVIDENCE),complete:flag});
const ATTEMPT=shape({
  attemptId:text(LIMITS.identifier),provider:text(LIMITS.label),model:text(LIMITS.label),
  status:oneOf(...ATTEMPT_STATUSES),outcomeKnown:flag,
  startedAtMs:nullable(count),endedAtMs:nullable(count),cost:nullable(COST),
});
export const RECEIPT_CONTRACT=deepFreeze(shape({
  schemaVersion:exactly(RECEIPT_SCHEMA_VERSION),
  runId:text(LIMITS.identifier),taskKey:text(LIMITS.identifier),inputRevision:text(LIMITS.identifier),
  accepted:flag,attemptsComplete:flag,attempts:list(ATTEMPT,LIMITS.attempts),
}));

const TOKENS={input:nullable(count),output:nullable(count),cached:nullable(count),
  cacheWrite:nullable(count),reasoning:nullable(count)};
const USAGE=shape({
  evidence:oneOf('synthetic','provider reported','OpenCode reported','unavailable'),
  semantics:oneOf('opencode-engine-defined','provider-defined','unavailable'),
  ...TOKENS,generationMs:nullable(amount),loadMs:nullable(amount),promptMs:nullable(amount),
  steps:optional(shape({items:list(shape(TOKENS),LIMITS.steps),duplicates:count,unidentified:flag,
    identityAmbiguous:flag,conflict:flag,truncated:flag})),
});
const ATTEMPT_EVIDENCE=shape({
  attemptId:text(LIMITS.identifier),
  recordedStatus:oneOf('running','review','accepted','rejected','failed','cancelled','interrupted'),
  backend:oneOf('fixture','ollama','llamacpp','other','unrecorded'),
  executionPhase:oneOf('claimed','dispatching','settled','unrecognized','unrecorded'),
  recovery:oneOf('none','retry-safe','unresolved','unrecognized'),
  recoveryEvidence:oneOf('none','dispatch-not-started','in-process-fixture-stopped','no-terminal-evidence','unrecognized'),
  outcomeBasis:oneOf('running','recovery-unresolved','recovery-unrecognized','in-process-fixture','provider-settled',
    'never-dispatched','recovery-retry-safe','no-completion-evidence'),
  startedAt:oneOf('recorded','missing','invalid','withheld-inconsistent'),
  endedAt:oneOf('recorded','missing','invalid','withheld-inconsistent','not-ended','withheld-interruption-record'),
  recordedElapsedMs:nullable(amount),
  cost:oneOf('not-recorded','caller-supplied','charge-record-invalid','charge-records-conflict'),
  modelWithheld:flag,
  operatorEditCount:nullable(count),
  checks:nullable(shape({passed:count,failed:count})),
  usage:USAGE,
});
const EVIDENCE=shape({
  runDefinition:exactly('one-task-record-attempt-history'),
  attemptLinkage:exactly('recorded-order-only'),
  timebase:oneOf(...TIMEBASES),
  task:shape({kind:oneOf('brief','change'),
    status:oneOf('draft','running','review','accepted','rejected','failed','cancelled','interrupted','unrecognized'),
    recordVersion:nullable(count)}),
  acceptance:shape({state:oneOf('accepted','unconfirmed','not-accepted'),operatorEdited:nullable(flag),earlierAcceptedAttempts:count}),
  attemptList:shape({complete:flag,basis:list(oneOf('event-log-accounts-for-every-attempt','event-log-missing-or-gapped',
    'start-events-do-not-match-attempts','charge-for-unrecorded-attempt'),4)}),
  inputIdentity:shape({basis:exactly('attempt-scope-hash-recomputed'),attemptsVerified:count}),
  chargeInput:shape({records:count,duplicates:count,unattributed:count}),
  attempts:list(ATTEMPT_EVIDENCE,LIMITS.attempts),
});
const HEAD={format:exactly(RECEIPT_EXPORT_FORMAT),formatVersion:exactly(RECEIPT_EXPORT_VERSION)};
const NOTES=list(text(LIMITS.note),12);
export const EXPORT_CONTRACT=deepFreeze({
  available:shape({...HEAD,available:exactly(true),run:RECEIPT_CONTRACT,evidence:EVIDENCE,limits:NOTES}),
  unavailable:shape({...HEAD,available:exactly(false),
    reasons:list(shape({code:oneOf(...Object.keys(UNAVAILABLE_REASONS)),message:text(LIMITS.note),
      attemptIndexes:list(count,LIMITS.attempts)}),Object.keys(UNAVAILABLE_REASONS).length),
    limits:NOTES}),
});

const CONTROL=/[\u0000-\u001f\u007f]/;
const issue=(path,code,message)=>({path,code,message});
// Reads an own data property without running accessors or consulting the
// prototype chain.
function held(holder,key) {
  const descriptor=Object.getOwnPropertyDescriptor(holder,key);
  return descriptor&&'value' in descriptor&&descriptor.value!==undefined?descriptor:null;
}

// Recursion follows the contract, never the input, so deeply nested input
// cannot exhaust the stack. Paths name contract keys and indexes only.
function check(value,spec,path,issues) {
  if(issues.length>=LIMITS.issues)return;
  if(value===null) {
    if(!spec.nullable)issues.push(issue(path,'null-not-allowed','A value is required here.'));
    return;
  }
  switch(spec.type) {
    case 'const':
      if(value!==spec.value)issues.push(issue(path,'unsupported-value','Only the documented value is supported.'));
      return;
    case 'boolean':
      if(typeof value!=='boolean')issues.push(issue(path,'invalid-boolean','Expected true or false.'));
      return;
    case 'enum':
      if(typeof value!=='string'||!spec.values.includes(value))issues.push(issue(path,'invalid-enum','Expected one of the documented values.'));
      return;
    case 'string':
      if(typeof value!=='string'||value.length>spec.max||!value.trim()||CONTROL.test(value)||(spec.pattern&&!spec.pattern.test(value)))
        issues.push(issue(path,'invalid-string','Expected a nonempty bounded string without control characters.'));
      return;
    case 'integer':
      if(!Number.isSafeInteger(value)||value<0)issues.push(issue(path,'invalid-integer','Expected a nonnegative safe integer.'));
      return;
    case 'number':
      if(typeof value!=='number'||!Number.isFinite(value)||value<0)issues.push(issue(path,'invalid-number','Expected a nonnegative finite number.'));
      return;
    case 'array':
      if(!Array.isArray(value))return void issues.push(issue(path,'invalid-array','Expected a list.'));
      if(value.length>spec.max)return void issues.push(issue(path,'too-many-items','The list exceeds its documented limit.'));
      if(Reflect.ownKeys(value).length!==value.length+1)
        return void issues.push(issue(path,'invalid-array','Lists must be dense and carry no extra properties.'));
      for(let index=0;index<value.length;index++) {
        if(issues.length>=LIMITS.issues)return;
        const item=held(value,index);
        if(!item)issues.push(issue(path+'['+index+']','invalid-array','Lists must hold plain data values.'));
        else check(item.value,spec.items,path+'['+index+']',issues);
      }
      return;
    case 'object': {
      if(typeof value!=='object'||Array.isArray(value))return void issues.push(issue(path,'invalid-object','Expected a plain object.'));
      const prototype=Object.getPrototypeOf(value);
      if(prototype!==Object.prototype&&prototype!==null)
        return void issues.push(issue(path,'invalid-object','Expected a plain object.'));
      for(const key of Reflect.ownKeys(value)) {
        if(issues.length>=LIMITS.issues)return;
        if(typeof key!=='string'||!Object.hasOwn(spec.keys,key))
          issues.push(issue(path,'unknown-property','An undocumented property is present.'));
      }
      for(const [key,child] of Object.entries(spec.keys)) {
        if(issues.length>=LIMITS.issues)return;
        const item=held(value,key);
        if(item)check(item.value,child,path+'.'+key,issues);
        else if(Object.hasOwn(value,key))issues.push(issue(path+'.'+key,'invalid-property','Expected a plain data value.'));
        else if(!child.optional)issues.push(issue(path+'.'+key,'missing-property','A documented property is missing.'));
      }
      return;
    }
  }
}

function crossChecks(run,path,issues) {
  const seen=new Set();
  run.attempts.forEach((attempt,index)=>{
    if(issues.length>=LIMITS.issues)return;
    if(seen.has(attempt.attemptId))
      issues.push(issue(path+'.attempts['+index+'].attemptId','duplicate-attempt-id','Attempt identifiers must be unique within a run.'));
    seen.add(attempt.attemptId);
    if(issues.length<LIMITS.issues&&attempt.startedAtMs!==null&&attempt.endedAtMs!==null&&attempt.endedAtMs<attempt.startedAtMs)
      issues.push(issue(path+'.attempts['+index+'].endedAtMs','end-before-start','An attempt cannot end before it starts.'));
  });
}

// validateReceipt(run) -> {ok:true, run} | {ok:false, issues:[{path,code,message}]}
// Never throws for malformed data and never mutates its input.
export function validateReceipt(run) {
  const issues=[];
  check(run,RECEIPT_CONTRACT,'$',issues);
  if(!issues.length)crossChecks(run,'$',issues);
  return issues.length?{ok:false,issues:issues.slice(0,LIMITS.issues)}:{ok:true,run};
}

// validateReceiptExport(envelope) -> {ok:true, envelope} | {ok:false, issues}
export function validateReceiptExport(envelope) {
  const issues=[];
  const available=envelope!==null&&typeof envelope==='object'&&!Array.isArray(envelope)?held(envelope,'available')?.value:undefined;
  if(typeof available!=='boolean')return {ok:false,issues:[issue('$.available','invalid-boolean','Expected true or false.')]};
  check(envelope,available?EXPORT_CONTRACT.available:EXPORT_CONTRACT.unavailable,'$',issues);
  if(available&&!issues.length) {
    crossChecks(envelope.run,'$.run',issues);
    const run=envelope.run.attempts,evidence=envelope.evidence.attempts;
    if(run.length!==evidence.length||run.some((attempt,index)=>attempt.attemptId!==evidence[index].attemptId))
      issues.push(issue('$.evidence.attempts','evidence-misaligned','Evidence must describe the same attempts in the same order.'));
  }
  return issues.length?{ok:false,issues:issues.slice(0,LIMITS.issues)}:{ok:true,envelope};
}
