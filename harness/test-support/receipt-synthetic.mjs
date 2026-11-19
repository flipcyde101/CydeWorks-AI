// Invented task records for receipt tests, built the way server.mjs builds
// them. Nothing here comes from a real workspace.
import {createHash} from 'node:crypto';
import {recordInterruption,recordOutcomeUncertainty} from '../recovery.mjs';

export const sha=value=>createHash('sha256').update(value).digest('hex');
export const T0=Date.UTC(2026,10,1,12,0,0);
export const at=offset=>new Date(T0+offset).toISOString();
export const clone=value=>JSON.parse(JSON.stringify(value));
export function deepFreeze(value) {
  if(value&&typeof value==='object'&&!Object.isFrozen(value)) {
    Object.freeze(value);
    for(const child of Object.values(value))deepFreeze(child);
  }
  return value;
}
const uuid=number=>'00000000-0000-4000-8000-'+String(number).padStart(12,'0');

function log(task,event,offset) {
  task.version++;
  task.events.push({seq:task.version,at:at(offset),event});
  return task;
}

export function draft(overrides={}) {
  const scope={kind:'change',title:'Synthetic receipt task',request:'Replace the synthetic example',
    source:'Synthetic source line',filename:'example.txt',expected:'Revised example',...overrides};
  if(scope.kind==='brief') {scope.filename=null;scope.expected=null;}
  return log({id:uuid(1),version:0,status:'draft',...scope,sourceHash:sha(scope.source),model:null,attempts:[],events:[]},
    'task.created',0);
}

export function start(task,offset,{provider='fixture',model=provider==='fixture'?'fixture':'synthetic-model:1b',
  backend=provider==='fixture'?'fixture':'ollama',identity=provider==='fixture'?null:'a'.repeat(64)}={}) {
  const id=uuid(100+task.attempts.length);
  task.model=model;
  task.attempts.push({id,model,provider,started:at(offset),status:'running',usage:null,backend,
    approvedModelDigest:backend==='llamacpp'?null:identity,approvedModelFingerprint:backend==='llamacpp'?identity:null,
    scopeHash:sha(JSON.stringify([task.sourceHash,task.request,task.expected,task.kind,model,provider,backend,identity])),
    execution:{phase:'claimed',claimId:id,claimedAt:at(offset)}});
  task.status='running';
  return log(task,'attempt.approved_and_started',offset);
}

export function dispatch(task,offset) {
  const attempt=task.attempts.at(-1);
  attempt.execution.phase='dispatching';
  attempt.execution.dispatchedAt=at(offset);
  return log(task,'attempt.dispatching',offset);
}

// Mirrors the end of execute(): a settled provider result, or an outcome the
// real recovery module marks as uncertain.
export function finish(task,offset,{status='review',settled=true,usage=null,checks,problem}={}) {
  const attempt=task.attempts.at(-1);
  attempt.usage=usage;
  if(settled&&attempt.execution.phase==='dispatching')attempt.execution.phase='settled';
  else recordOutcomeUncertainty(attempt,at(offset));
  if(status==='review') {
    attempt.artifact={summary:'Synthetic proposal',content:'Synthetic proposal content',
      sha256:sha('Synthetic proposal content'),patch:null};
    attempt.checks=checks??[{name:'Synthetic structural check',pass:true}];
  } else {
    attempt.artifact=null;
    attempt.checks=[];
    attempt.problem=problem??'Synthetic failure description.';
  }
  attempt.terminal=[{at:at(offset),message:'Attempt '+status+'.'}];
  attempt.status=task.status=status;
  attempt.ended=at(offset);
  attempt.elapsedMs=Date.parse(attempt.ended)-Date.parse(attempt.started);
  return log(task,'attempt.'+status,offset);
}

export function review(task,offset,decision='accepted') {
  task.status=task.attempts.at(-1).status=decision;
  return log(task,'review.'+decision,offset);
}

export function edit(task,offset) {
  const attempt=task.attempts.at(-1);
  attempt.originalArtifact??=attempt.artifact;
  attempt.operatorEdits??=[];
  const content='Operator edited content '+attempt.operatorEdits.length;
  attempt.operatorEdits.push({previousHash:attempt.artifact.sha256,artifactHash:sha(content),at:at(offset)});
  attempt.artifact={...attempt.artifact,content,sha256:sha(content)};
  return log(task,'proposal.operator_edited',offset);
}

// Uses the real restart-recovery routine.
export function interrupt(task,offset) {
  recordInterruption(task,at(offset));
  return log(task,'attempt.interrupted',offset);
}

export function acceptedTask(overrides) {
  const task=draft(overrides);
  start(task,1000);dispatch(task,1100);finish(task,5000);
  return review(task,9000);
}

const local={provider:'ollama'};
const engine={provider:'opencode',backend:'llamacpp',model:'synthetic-gguf-q4'};
export const reportedUsage=()=>({evidence:'provider reported',input:12,output:6,cached:null,generationMs:500,loadMs:null,
  promptMs:20,providerMs:900,providerCharge:null});

// One task per situation the receipt has to describe truthfully.
export function scenarios() {
  const build=(steps,overrides)=>{const task=draft(overrides);steps(task);return task;};
  return {
    accepted:acceptedTask(),
    failedThenAccepted:build(task=>{
      start(task,1000,local);dispatch(task,1100);finish(task,3000,{status:'failed',usage:reportedUsage()});
      start(task,4000,engine);dispatch(task,4100);finish(task,9000);review(task,12000);
    }),
    reviewPending:build(task=>{start(task,1000,local);dispatch(task,1100);finish(task,6000,{usage:reportedUsage()});}),
    rejected:build(task=>{start(task,1000,local);dispatch(task,1100);finish(task,6000);review(task,8000,'rejected');}),
    editedThenAccepted:build(task=>{
      start(task,1000,local);dispatch(task,1100);finish(task,6000);edit(task,7000);edit(task,7500);review(task,9000);
    }),
    acceptedThenCancelled:build(task=>{
      start(task,1000);dispatch(task,1100);finish(task,2000);review(task,3000);
      start(task,4000);finish(task,4500,{status:'cancelled'});
    }),
    cancelledBeforeDispatch:build(task=>{start(task,1000,engine);finish(task,1500,{status:'cancelled'});}),
    cancelledUnresolved:build(task=>{
      start(task,1000,engine);dispatch(task,1100);
      finish(task,7000,{status:'cancelled',settled:false,
        problem:'OpenCode process exit was observed. Local model server termination was not verified.'});
    }),
    failedUnresolved:build(task=>{start(task,1000,local);dispatch(task,1100);finish(task,7000,{status:'failed',settled:false});}),
    interruptedUnresolved:build(task=>{start(task,1000,engine);dispatch(task,1100);interrupt(task,3600000);}),
    interruptedBeforeDispatch:build(task=>{start(task,1000,engine);interrupt(task,3600000);}),
    running:build(task=>{start(task,1000,local);dispatch(task,1100);}),
    brief:build(task=>{start(task,1000);dispatch(task,1100);finish(task,2000);review(task,3000);},{kind:'brief'}),
  };
}
