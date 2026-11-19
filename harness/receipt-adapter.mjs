// Turns one stored CydeWorks task record into a run receipt.
//
// Pure and deterministic: no I/O, clock or randomness, and the input is never
// written to. It reads own data properties only, so accessors are not run and
// inherited values are ignored. It reads the task's instruction and source
// snapshot to derive identifiers and never emits them.
//
// A run is the complete recorded attempt history of exactly one task record.
// See FIELD-MAPPING.md beside the candidate for the full mapping.
import {createHash} from 'node:crypto';
import {exportTask} from './export.mjs';
import {COST_EVIDENCE,LIMITS,RECEIPT_SCHEMA_VERSION,TIMEBASES,UNAVAILABLE_REASONS,validateReceipt} from './receipt-contract.mjs';

const DIGEST=/^[a-f0-9]{64}$/;
// Execution status as the inspector defines it. Review states all mean the
// harness received a proposal; whether a person accepted it is separate.
const STATUS={running:'running',review:'succeeded',accepted:'succeeded',rejected:'succeeded',
  failed:'failed',cancelled:'cancelled',interrupted:'interrupted'};
const TASK_STATUSES=['draft','running','review','accepted','rejected','failed','cancelled','interrupted'];
const START_EVENT='attempt.approved_and_started';

const sha256=value=>createHash('sha256').update(value).digest('hex');
// Derived identifiers: a version prefix plus 128 bits of a labelled SHA-256.
const derive=(prefix,...parts)=>prefix+'-'+sha256(JSON.stringify(parts)).slice(0,32);
function own(holder,key) {
  if(holder===null||typeof holder!=='object')return undefined;
  const descriptor=Object.getOwnPropertyDescriptor(holder,key);
  return descriptor&&'value' in descriptor?descriptor.value:undefined;
}
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const isText=value=>typeof value==='string'&&value.length>0&&value.length<=LIMITS.identifier;
const scalar=value=>value===undefined||value===null||typeof value==='string';
const pick=(value,allowed,absent,other)=>value===undefined||value===null?absent:allowed.includes(value)?value:other;

// A bounded copy holding plain data only, for code that reads properties directly.
function plain(value,depth=0) {
  if(value===null||['string','boolean','number'].includes(typeof value))return value;
  if(typeof value!=='object'||depth>=6)return undefined;
  if(Array.isArray(value)) {
    if(value.length>256)return undefined;
    return Array.from({length:value.length},(_,index)=>plain(own(value,index),depth+1)??null);
  }
  const copy=Object.create(null);
  for(const key of Object.keys(value).slice(0,64)) {
    const item=key==='__proto__'?undefined:plain(own(value,key),depth+1);
    if(item!==undefined)copy[key]=item;
  }
  return copy;
}

function inputIdentity(task) {
  const kind=own(task,'kind'),request=own(task,'request'),source=own(task,'source'),sourceHash=own(task,'sourceHash');
  const expected=own(task,'expected')??null,filename=own(task,'filename')??null;
  const shaped=kind==='change'?typeof expected==='string'&&typeof filename==='string'
    :kind==='brief'&&expected===null&&filename===null;
  if(!shaped||typeof request!=='string'||typeof source!=='string'||typeof sourceHash!=='string'||!DIGEST.test(sourceHash))
    return {problem:'input-identity-missing'};
  // UTF-8 hashing replaces lone UTF-16 surrogates, losing source identity.
  // Reject rather than repairing text that was never approved in that form.
  if(![source,request,expected,filename].every(value=>value===null||value.isWellFormed()))
    return {problem:'input-unicode-invalid'};
  if(sha256(source)!==sourceHash)return {problem:'source-hash-mismatch'};
  return {kind,request,expected,filename,sourceHash};
}

// Recomputes the scope hash server.mjs stores when an attempt is approved.
function approvedInputProblem(identity,attempt) {
  const recorded=own(attempt,'scopeHash');
  if(typeof recorded!=='string'||!DIGEST.test(recorded))return 'approved-input-unrecorded';
  const model=own(attempt,'model'),provider=own(attempt,'provider'),backend=own(attempt,'backend');
  const approved=own(attempt,backend==='llamacpp'?'approvedModelFingerprint':'approvedModelDigest');
  if(![model,provider,backend,approved].every(scalar))return 'approved-input-mismatch';
  const binding=[identity.sourceHash,identity.request,identity.expected,identity.kind,model,provider];
  // The original server bound six input fields. The first published preview
  // added a model digest before later versions added backend and route facts.
  // Select an older format only when every later binding field is absent.
  if(['backend','approvedModelFingerprint','approvedRouteRevision']
      .every(key=>Object.getOwnPropertyDescriptor(attempt,key)===undefined)) {
    const digest=Object.getOwnPropertyDescriptor(attempt,'approvedModelDigest');
    if(digest) {
      if(!('value' in digest)||!(digest.value===null||typeof digest.value==='string'&&DIGEST.test(digest.value)))
        return 'approved-input-mismatch';
      binding.push(digest.value);
    }
    return sha256(JSON.stringify(binding))===recorded?null:'approved-input-mismatch';
  }
  binding.push(backend,approved);
  const revision=Object.getOwnPropertyDescriptor(attempt,'approvedRouteRevision');
  if(revision) {
    if(!('value' in revision)||typeof revision.value!=='string'||!DIGEST.test(revision.value))
      return 'approved-input-mismatch';
    binding.push(['routeRevision',revision.value]);
  }
  return sha256(JSON.stringify(binding))===recorded?null:'approved-input-mismatch';
}

// Accepts only the exact form the harness writes, e.g. 2026-11-01T12:00:00.000Z.
function instant(value) {
  if(value===undefined||value===null)return {state:'missing',ms:null};
  if(typeof value!=='string'||value.length!==24)return {state:'invalid',ms:null};
  const ms=Date.parse(value);
  return Number.isSafeInteger(ms)&&ms>=0&&new Date(ms).toISOString()===value?{state:'recorded',ms}:{state:'invalid',ms:null};
}

function chargeCost(record) {
  if(!isObject(record))return null;
  const keys=Reflect.ownKeys(record);
  if(keys.length!==5||!['attemptId','amountMicros','currency','evidence','complete'].every(key=>keys.includes(key)))return null;
  const amountMicros=own(record,'amountMicros'),currency=own(record,'currency'),evidence=own(record,'evidence'),complete=own(record,'complete');
  if(!Number.isSafeInteger(amountMicros)||amountMicros<0||typeof currency!=='string'||!/^[A-Z]{3}$/.test(currency)||
      typeof evidence!=='string'||!COST_EVIDENCE.includes(evidence)||typeof complete!=='boolean')return null;
  return {amountMicros:amountMicros+0,currency,evidence,complete};
}

// Charge records are caller-supplied billing evidence keyed by the stored
// attempt id. Exact repeats collapse, differing records for one attempt
// cancel each other, and a malformed record leaves that cost unknown.
function readCharges(charges,known) {
  const byAttempt=new Map(),summary={records:0,duplicates:0,unattributed:0};
  if(charges===undefined)return {byAttempt,summary};
  if(!Array.isArray(charges)||charges.length>LIMITS.attempts*4)return null;
  for(let index=0;index<charges.length;index++) {
    const record=own(charges,index),id=own(record,'attemptId');
    summary.records++;
    if(typeof id!=='string'||!known.has(id)) {summary.unattributed++;continue;}
    const cost=chargeCost(record),prior=byAttempt.get(id);
    if(!cost)byAttempt.set(id,{state:'charge-record-invalid',cost:null});
    else if(!prior)byAttempt.set(id,{state:'caller-supplied',cost,key:JSON.stringify(cost)});
    else if(prior.state==='caller-supplied'&&prior.key===JSON.stringify(cost))summary.duplicates++;
    else if(prior.state==='caller-supplied')byAttempt.set(id,{state:'charge-records-conflict',cost:null});
  }
  return {byAttempt,summary};
}

// The event names, or null unless sequence numbers run 1..version without gaps.
function eventNames(task) {
  const events=own(task,'events'),version=own(task,'version');
  if(!Array.isArray(events)||!Number.isSafeInteger(version)||version<0||events.length!==version)return null;
  const names=[];
  for(let index=0;index<events.length;index++) {
    const entry=own(events,index),name=own(entry,'event');
    if(own(entry,'seq')!==index+1||typeof name!=='string')return null;
    names.push(name);
  }
  return names;
}

// Whether the harness holds terminal evidence for the provider request. This
// is the rule recovery.mjs and removal.mjs apply before allowing a retry or a
// removal. A stopped controller or an observed process exit is not evidence.
function outcomeBasis(recorded,provider,phase,recovery) {
  if(recorded==='running')return 'running';
  if(recovery==='unresolved')return 'recovery-unresolved';
  if(recovery!==undefined&&recovery!==null&&recovery!=='retry-safe')return 'recovery-unrecognized';
  if(recorded==='interrupted'&&recovery!=='retry-safe')return 'no-completion-evidence';
  if(provider==='fixture')return 'in-process-fixture';
  if(phase==='settled')return 'provider-settled';
  if(phase==='claimed')return 'never-dispatched';
  return recovery==='retry-safe'?'recovery-retry-safe':'no-completion-evidence';
}
const KNOWN_OUTCOMES=['in-process-fixture','provider-settled','never-dispatched','recovery-retry-safe'];

function providerLabel(provider,backend) {
  if(!['fixture','ollama','opencode'].includes(provider))return 'other';
  return provider==='opencode'&&['ollama','llamacpp'].includes(backend)?'opencode+'+backend:provider;
}
function checkCounts(checks) {
  if(!Array.isArray(checks)||checks.length>64)return null;
  let passed=0,failed=0;
  for(let index=0;index<checks.length;index++) {
    const pass=own(own(checks,index),'pass');
    if(typeof pass!=='boolean')return null;
    if(pass)passed++;else failed++;
  }
  return {passed,failed};
}
function editCount(attempt) {
  const edits=own(attempt,'operatorEdits');
  if(edits===undefined||edits===null)return 0;
  if(!Array.isArray(edits)||edits.length>LIMITS.attempts)return null;
  for(let index=0;index<edits.length;index++) {
    const edit=own(edits,index);
    if(!['previousHash','artifactHash'].every(key=>typeof own(edit,key)==='string'&&DIGEST.test(own(edit,key)))||
        instant(own(edit,'at')).state!=='recorded')return null;
  }
  return edits.length;
}

function unavailable(found) {
  return {available:false,reasons:Object.keys(UNAVAILABLE_REASONS).filter(code=>found.has(code))
    .map(code=>({code,message:UNAVAILABLE_REASONS[code],attemptIndexes:[...found.get(code)]}))};
}

// adaptTaskToReceipt(task, options) ->
//   {available:true, run, evidence} | {available:false, reasons:[{code,message,attemptIndexes}]}
//
// options.timebase  'run-relative' (default) shifts instants so the earliest
//                   emitted one is 0. 'epoch' keeps Unix milliseconds.
// options.charges   optional list of {attemptId, amountMicros, currency,
//                   evidence, complete} keyed by the stored attempt id. The
//                   harness records no charges today, so the server passes none.
export function adaptTaskToReceipt(task,{timebase='run-relative',charges}={}) {
  if(!TIMEBASES.includes(timebase))throw new RangeError('Unsupported receipt timebase.');
  const found=new Map();
  const mark=(code,index)=>{
    if(!found.has(code))found.set(code,new Set());
    if(index!==undefined)found.get(code).add(index);
  };
  if(!isObject(task)) {mark('task-record-invalid');return unavailable(found);}
  const taskId=own(task,'id'),taskStatus=own(task,'status'),attempts=own(task,'attempts');
  if(!isText(taskId))mark('task-id-missing');
  const identity=inputIdentity(task);
  if(identity.problem)mark(identity.problem);
  const records=[],ids=new Set();
  if(!Array.isArray(attempts))mark('attempt-records-missing');
  else if(attempts.length===0)mark(taskStatus==='draft'?'no-attempts-recorded':'attempt-records-missing');
  else if(attempts.length>LIMITS.attempts)mark('attempt-limit-exceeded');
  else for(let index=0;index<attempts.length;index++) {
    const attempt=own(attempts,index),id=own(attempt,'id'),status=own(attempt,'status');
    if(!isObject(attempt)||!isText(id)||ids.has(id)) {mark('attempt-record-invalid',index);continue;}
    ids.add(id);
    if(typeof status!=='string'||!Object.hasOwn(STATUS,status))mark('attempt-status-unrecognized',index);
    const problem=identity.problem?null:approvedInputProblem(identity,attempt);
    if(problem)mark(problem,index);
    records.push(attempt);
  }
  const charge=readCharges(charges,ids);
  if(!charge)mark('charge-input-invalid');
  if(found.size)return unavailable(found);

  const names=eventNames(task);
  const basis=[];
  if(!names)basis.push('event-log-missing-or-gapped');
  else if(names.filter(name=>name===START_EVENT).length!==records.length)basis.push('start-events-do-not-match-attempts');
  if(charge.summary.unattributed>0)basis.push('charge-for-unrecorded-attempt');
  const attemptsComplete=basis.length===0;
  if(attemptsComplete)basis.push('event-log-accounts-for-every-attempt');

  // Acceptance is a recorded human decision about the latest attempt. Status
  // alone is not enough: the review event must follow that attempt's start.
  let acceptance='not-accepted';
  if(taskStatus==='accepted'&&own(records.at(-1),'status')==='accepted') {
    const started=names?names.lastIndexOf(START_EVENT):-1;
    const reviewed=names?Math.max(names.lastIndexOf('review.accepted'),names.lastIndexOf('review.rejected')):-1;
    const proposed=names?names.lastIndexOf('attempt.review'):-1;
    const startsMatch=names?.filter(name=>name===START_EVENT).length===records.length;
    const cleanReview=names&&proposed>=0&&reviewed>proposed&&
      names.slice(proposed+1,reviewed).every(name=>name==='proposal.operator_edited');
    acceptance=startsMatch&&started>=0&&proposed>started&&cleanReview&&names[reviewed]==='review.accepted'?'accepted':'unconfirmed';
  }

  // The existing minimal export already sanitizes usage and collapses replayed
  // step events. Reuse it rather than restating those rules.
  const usage=exportTask({attempts:records.map(attempt=>({provider:own(attempt,'provider'),status:own(attempt,'status'),
    elapsedMs:own(attempt,'elapsedMs'),usage:plain(own(attempt,'usage'))}))},'minimal').task.attempts;

  const built=records.map((attempt,index)=>{
    const recorded=own(attempt,'status'),provider=own(attempt,'provider'),backend=own(attempt,'backend');
    const phase=own(own(attempt,'execution'),'phase'),recoveryRecord=own(attempt,'recovery');
    const recovery=recoveryRecord===undefined||recoveryRecord===null?undefined:own(recoveryRecord,'state')??'unrecognized';
    const outcome=outcomeBasis(recorded,provider,phase,recovery);
    let start=instant(own(attempt,'started')),end=instant(own(attempt,'ended'));
    if(recorded==='running')end={state:'not-ended',ms:null};
    // An interruption is stamped when a restarted service notices it, which
    // says nothing about when the work stopped.
    else if(recorded==='interrupted'&&end.state!=='missing')end={state:'withheld-interruption-record',ms:null};
    else if(start.ms!==null&&end.ms!==null&&end.ms<start.ms)start=end={state:'withheld-inconsistent',ms:null};
    // Labels are caller-controlled and may contain private aliases or paths.
    // Provider identity remains available; display names are never exported.
    const model=null;
    const charged=charge.byAttempt.get(own(attempt,'id'));
    return {start,end,
      run:{attemptId:derive('cwa1','cydeworks.receipt.attempt.v1',taskId,own(attempt,'id')),
        provider:providerLabel(provider,backend),model:model??'withheld',status:STATUS[recorded],
        outcomeKnown:KNOWN_OUTCOMES.includes(outcome),startedAtMs:null,endedAtMs:null,cost:charged?.cost??null},
      evidence:{recordedStatus:recorded,backend:pick(backend,['fixture','ollama','llamacpp'],'unrecorded','other'),
        executionPhase:pick(phase,['claimed','dispatching','settled'],'unrecorded','unrecognized'),
        recovery:pick(recovery,['retry-safe','unresolved'],'none','unrecognized'),
        recoveryEvidence:pick(own(recoveryRecord,'evidence'),
          ['dispatch-not-started','in-process-fixture-stopped','no-terminal-evidence'],'none','unrecognized'),
        outcomeBasis:outcome,startedAt:start.state,endedAt:end.state,recordedElapsedMs:usage[index].elapsedMs,
        cost:charged?.state??'not-recorded',modelWithheld:model===null,operatorEditCount:editCount(attempt),
        checks:checkCounts(own(attempt,'checks')),usage:usage[index].usage}};
  });
  const instants=built.flatMap(({start,end})=>[start.ms,end.ms]).filter(ms=>ms!==null);
  const base=timebase==='run-relative'&&instants.length?Math.min(...instants):0;
  for(const {start,end,run} of built) {
    run.startedAtMs=start.ms===null?null:start.ms-base;
    run.endedAtMs=end.ms===null?null:end.ms-base;
  }

  const {kind,request,expected,filename,sourceHash}=identity;
  const run={schemaVersion:RECEIPT_SCHEMA_VERSION,
    runId:derive('cwr1','cydeworks.receipt.run.v1',taskId),
    taskKey:derive('cwt1','cydeworks.receipt.task.v1',kind,request,expected,filename),
    inputRevision:derive('cwi1','cydeworks.receipt.input.v1',kind,request,expected,filename,sourceHash),
    accepted:acceptance==='accepted',attemptsComplete,attempts:built.map(item=>item.run)};
  if(!validateReceipt(run).ok) {mark('contract-violation');return unavailable(found);}
  const version=own(task,'version');
  const evidence={runDefinition:'one-task-record-attempt-history',attemptLinkage:'recorded-order-only',timebase,
    task:{kind,status:typeof taskStatus==='string'&&TASK_STATUSES.includes(taskStatus)?taskStatus:'unrecognized',
      recordVersion:Number.isSafeInteger(version)&&version>=0?version:null},
    acceptance:{state:acceptance,operatorEdited:editCount(records.at(-1))===null?null:editCount(records.at(-1))>0,
      earlierAcceptedAttempts:records.slice(0,-1).filter(attempt=>own(attempt,'status')==='accepted').length},
    attemptList:{complete:attemptsComplete,basis},
    inputIdentity:{basis:'attempt-scope-hash-recomputed',attemptsVerified:records.length},
    chargeInput:charge.summary,
    attempts:built.map(item=>({attemptId:item.run.attemptId,...item.evidence}))};
  return {available:true,run,evidence};
}
