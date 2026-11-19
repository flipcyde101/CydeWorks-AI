import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {adaptTaskToReceipt} from './receipt-adapter.mjs';
import {validateReceipt} from './receipt-contract.mjs';
import {createStepReceipt} from './opencode-usage.mjs';
import {T0,acceptedTask,clone,deepFreeze,dispatch,draft,finish,reportedUsage,review,scenarios,sha,start}
  from './test-support/receipt-synthetic.mjs';

const adapt=(task,options)=>adaptTaskToReceipt(task,options);
const codes=result=>result.reasons.map(reason=>reason.code);
function available(task,options) {
  const result=adapt(task,options);
  assert.equal(result.available,true,JSON.stringify(result.reasons));
  assert.equal(validateReceipt(result.run).ok,true);
  return result;
}
const charge=(attemptId,overrides={})=>({attemptId,amountMicros:1500,currency:'USD',evidence:'estimated',complete:true,...overrides});

test('an accepted run maps to one succeeded attempt with recorded acceptance',()=>{
  const {run,evidence}=available(acceptedTask());
  assert.deepEqual(Object.keys(run),['schemaVersion','runId','taskKey','inputRevision','accepted','attemptsComplete','attempts']);
  assert.equal(run.schemaVersion,1);
  assert.match(run.runId,/^cwr1-[a-f0-9]{32}$/);
  assert.match(run.taskKey,/^cwt1-[a-f0-9]{32}$/);
  assert.match(run.inputRevision,/^cwi1-[a-f0-9]{32}$/);
  assert.equal(run.accepted,true);
  assert.equal(run.attemptsComplete,true);
  assert.deepEqual(run.attempts,[{attemptId:run.attempts[0].attemptId,provider:'fixture',model:'withheld',
    status:'succeeded',outcomeKnown:true,startedAtMs:0,endedAtMs:4000,cost:null}]);
  assert.match(run.attempts[0].attemptId,/^cwa1-[a-f0-9]{32}$/);
  assert.equal(evidence.acceptance.state,'accepted');
  assert.equal(evidence.attempts[0].recordedStatus,'accepted');
  assert.equal(evidence.attempts[0].outcomeBasis,'in-process-fixture');
  assert.deepEqual(evidence.attemptList,{complete:true,basis:['event-log-accounts-for-every-attempt']});
  const epoch=available(acceptedTask(),{timebase:'epoch'});
  assert.equal(epoch.run.attempts[0].startedAtMs,T0+1000);
  assert.equal(epoch.run.attempts[0].endedAtMs,T0+5000);
  assert.throws(()=>adapt(acceptedTask(),{timebase:'local'}),RangeError);
});

test('a failed attempt followed by success keeps both, in order, without a retry label',()=>{
  const {run,evidence}=available(scenarios().failedThenAccepted);
  assert.deepEqual(run.attempts.map(({provider,model,status,outcomeKnown,startedAtMs,endedAtMs,cost})=>
    ({provider,model,status,outcomeKnown,startedAtMs,endedAtMs,cost})),[
    {provider:'ollama',model:'withheld',status:'failed',outcomeKnown:true,startedAtMs:0,endedAtMs:2000,cost:null},
    {provider:'opencode+llamacpp',model:'withheld',status:'succeeded',outcomeKnown:true,startedAtMs:3000,endedAtMs:8000,cost:null},
  ]);
  assert.equal(run.accepted,true);
  assert.equal(evidence.attemptLinkage,'recorded-order-only');
  const keys=[];
  JSON.stringify({run,evidence},(key,value)=>{keys.push(key);return value;});
  assert.equal(keys.some(key=>/retr/i.test(key)),false);
});

test('cancellation is known only when the harness holds terminal evidence',()=>{
  const all=scenarios();
  const unresolved=available(all.cancelledUnresolved);
  // The stored problem text says a process exit was observed. That is not used.
  assert.match(all.cancelledUnresolved.attempts[0].problem,/process exit was observed/);
  assert.equal(unresolved.run.attempts[0].status,'cancelled');
  assert.equal(unresolved.run.attempts[0].outcomeKnown,false);
  assert.equal(unresolved.run.attempts[0].endedAtMs,6000);
  assert.equal(unresolved.evidence.attempts[0].outcomeBasis,'recovery-unresolved');
  assert.equal(unresolved.evidence.attempts[0].recoveryEvidence,'no-terminal-evidence');
  const early=available(all.cancelledBeforeDispatch);
  assert.equal(early.run.attempts[0].outcomeKnown,true);
  assert.equal(early.evidence.attempts[0].outcomeBasis,'never-dispatched');
  const failed=available(all.failedUnresolved);
  assert.equal(failed.run.attempts[0].status,'failed');
  assert.equal(failed.run.attempts[0].outcomeKnown,false);
  const legacy=clone(all.cancelledBeforeDispatch);
  delete legacy.attempts[0].execution;
  assert.equal(available(legacy).run.attempts[0].outcomeKnown,false);
  assert.equal(available(legacy).evidence.attempts[0].outcomeBasis,'no-completion-evidence');
  const odd=clone(all.cancelledBeforeDispatch);
  odd.attempts[0].recovery={state:'somehow-fine'};
  assert.equal(available(odd).run.attempts[0].outcomeKnown,false);
  assert.equal(available(odd).evidence.attempts[0].outcomeBasis,'recovery-unrecognized');
});

test('an interrupted controller never establishes when or whether the worker stopped',()=>{
  const all=scenarios();
  const unknown=available(all.interruptedUnresolved);
  assert.ok(all.interruptedUnresolved.attempts[0].ended,'the record does carry a restart time');
  assert.deepEqual(unknown.run.attempts[0],{attemptId:unknown.run.attempts[0].attemptId,provider:'opencode+llamacpp',
    model:'withheld',status:'interrupted',outcomeKnown:false,startedAtMs:0,endedAtMs:null,cost:null});
  assert.equal(unknown.evidence.attempts[0].endedAt,'withheld-interruption-record');
  assert.equal(unknown.run.accepted,false);
  assert.equal(unknown.run.attemptsComplete,true);
  const safe=available(all.interruptedBeforeDispatch);
  assert.equal(safe.run.attempts[0].outcomeKnown,true);
  assert.equal(safe.run.attempts[0].endedAtMs,null);
  assert.equal(safe.evidence.attempts[0].recoveryEvidence,'dispatch-not-started');
});

test('a running attempt has a complete list and an unknown outcome',()=>{
  const {run,evidence}=available(scenarios().running);
  assert.equal(run.attemptsComplete,true);
  assert.equal(run.accepted,false);
  assert.equal(run.attempts[0].status,'running');
  assert.equal(run.attempts[0].outcomeKnown,false);
  assert.equal(run.attempts[0].endedAtMs,null);
  assert.equal(evidence.attempts[0].endedAt,'not-ended');
  const stale=clone(scenarios().running);
  stale.attempts[0].ended=stale.attempts[0].started;
  assert.equal(available(stale).run.attempts[0].endedAtMs,null);
});

test('missing or invalid timestamps stay null and elapsed time never becomes an end time',()=>{
  const base=acceptedTask();
  const noStart=clone(base);
  delete noStart.attempts[0].started;
  assert.equal(available(noStart).run.attempts[0].startedAtMs,null);
  assert.equal(available(noStart).run.attempts[0].endedAtMs,0);
  assert.equal(available(noStart).evidence.attempts[0].startedAt,'missing');
  const noEnd=clone(base);
  delete noEnd.attempts[0].ended;
  const withheld=available(noEnd);
  assert.equal(noEnd.attempts[0].elapsedMs,4000);
  assert.equal(withheld.run.attempts[0].endedAtMs,null);
  assert.equal(withheld.evidence.attempts[0].endedAt,'missing');
  assert.equal(withheld.evidence.attempts[0].recordedElapsedMs,4000);
  for(const value of ['yesterday','2026-02-30T00:00:00.000Z','2026-11-01T12:00:00Z','2026-11-01 12:00:00.000Z',
    '+275760-09-13T00:00:00.000Z',1793534400000,{toString:null},['2026-11-01T12:00:00.000Z'],true]) {
    const bad=clone(base);
    bad.attempts[0].started=value;
    assert.equal(available(bad).run.attempts[0].startedAtMs,null,JSON.stringify(value));
    assert.equal(available(bad).evidence.attempts[0].startedAt,'invalid');
  }
  const reversed=clone(base);
  [reversed.attempts[0].started,reversed.attempts[0].ended]=[reversed.attempts[0].ended,reversed.attempts[0].started];
  const both=available(reversed);
  assert.equal(both.run.attempts[0].startedAtMs,null);
  assert.equal(both.run.attempts[0].endedAtMs,null);
  assert.equal(both.evidence.attempts[0].endedAt,'withheld-inconsistent');
});

test('usage never becomes cost: local, token-reporting and unreported attempts are all unknown',()=>{
  const {run,evidence}=available(scenarios().failedThenAccepted);
  assert.deepEqual(run.attempts.map(attempt=>attempt.cost),[null,null]);
  assert.deepEqual(evidence.attempts.map(attempt=>attempt.cost),['not-recorded','not-recorded']);
  assert.equal(evidence.attempts[0].usage.evidence,'provider reported');
  assert.equal(evidence.attempts[0].usage.input,12);
  assert.equal(evidence.attempts[0].usage.cached,null);
  assert.equal(evidence.attempts[1].usage.evidence,'unavailable');
  assert.equal(evidence.attempts[1].usage.input,null);
  assert.deepEqual(Object.keys(evidence.attempts[0].usage),['evidence','semantics','input','output','cached','cacheWrite',
    'reasoning','generationMs','loadMs','promptMs']);
  const fixture=available(acceptedTask());
  assert.equal(fixture.run.attempts[0].cost,null);
  const charged=clone(scenarios().reviewPending);
  charged.attempts[0].usage.providerCharge=0;
  assert.equal(available(charged).run.attempts[0].cost,null,'a bare number has no currency or evidence class');
});

test('an explicit zero charge differs from an unknown cost',()=>{
  const task=scenarios().failedThenAccepted;
  const [first,second]=task.attempts.map(attempt=>attempt.id);
  const {run,evidence}=available(task,{charges:[charge(second,{amountMicros:0,evidence:'provider-billed'})]});
  assert.equal(run.attempts[0].cost,null);
  assert.deepEqual(run.attempts[1].cost,{amountMicros:0,currency:'USD',evidence:'provider-billed',complete:true});
  assert.deepEqual(evidence.attempts.map(attempt=>attempt.cost),['not-recorded','caller-supplied']);
  const mixed=available(task,{charges:[charge(first,{currency:'EUR',evidence:'provider-billed',complete:false}),charge(second)]});
  assert.deepEqual(mixed.run.attempts.map(attempt=>attempt.cost),[
    {amountMicros:1500,currency:'EUR',evidence:'provider-billed',complete:false},
    {amountMicros:1500,currency:'USD',evidence:'estimated',complete:true}]);
  const largest=available(task,{charges:[charge(first,{amountMicros:Number.MAX_SAFE_INTEGER})]});
  assert.equal(largest.run.attempts[0].cost.amountMicros,Number.MAX_SAFE_INTEGER);
});

test('repeated, conflicting, malformed and unattributed charge records fail closed',()=>{
  const task=scenarios().failedThenAccepted;
  const [first,second]=task.attempts.map(attempt=>attempt.id);
  const repeated=available(task,{charges:[charge(first),charge(first),charge(second)]});
  assert.equal(repeated.run.attempts[0].cost.amountMicros,1500);
  assert.equal(repeated.evidence.chargeInput.duplicates,1);
  const conflict=available(task,{charges:[charge(first),charge(first,{amountMicros:1600}),charge(first)]});
  assert.equal(conflict.run.attempts[0].cost,null);
  assert.equal(conflict.evidence.attempts[0].cost,'charge-records-conflict');
  for(const bad of [{amountMicros:Number.MAX_SAFE_INTEGER+1},{amountMicros:-1},{amountMicros:1.5},{amountMicros:'5'},
    {amountMicros:NaN},{amountMicros:Infinity},{amountMicros:null},{currency:'usd'},{currency:'USDD'},{currency:5},
    {evidence:'guessed'},{evidence:['estimated']},{complete:'yes'},{note:'extra property'}]) {
    const result=available(task,{charges:[charge(first,bad),charge(first)]});
    assert.equal(result.run.attempts[0].cost,null,JSON.stringify(bad));
    assert.equal(result.evidence.attempts[0].cost,'charge-record-invalid');
  }
  const {complete,...partial}=charge(first);
  assert.equal(available(task,{charges:[partial]}).run.attempts[0].cost,null);
  const stray=available(task,{charges:[charge('not-an-attempt-of-this-task'),null,charge(second)]});
  assert.equal(stray.run.attemptsComplete,false);
  assert.deepEqual(stray.evidence.attemptList.basis,['charge-for-unrecorded-attempt']);
  assert.equal(stray.evidence.chargeInput.unattributed,2);
  assert.equal(stray.run.attempts[1].cost.amountMicros,1500);
  for(const input of [{},'charges',5,null])assert.deepEqual(codes(adapt(task,{charges:input})),['charge-input-invalid']);
});

const step=(id,input,output)=>({type:'step_finish',sessionID:'session-1',
  part:{id,sessionID:'session-1',messageID:'message-1',tokens:{input,output,cache:{read:2,write:4},reasoning:1}}});
function withSteps(events,tamper) {
  const collector=createStepReceipt();
  for(const event of events)collector.observe(event);
  const usage=collector.snapshot();
  tamper?.(usage);
  const task=draft();
  start(task,1000,{provider:'opencode'});dispatch(task,1100);finish(task,5000,{usage});
  return available(task).evidence.attempts[0].usage;
}

test('replayed and conflicting usage events reuse the existing step handling',()=>{
  const replayed=withSteps([step('part-1',12,3),step('part-1',12,3),step('part-2',20,5)],usage=>{
    usage.input=999;
    usage.steps.items[0].privateContent='PRIVATE';
  });
  assert.equal(replayed.input,32);
  assert.equal(replayed.output,8);
  assert.equal(replayed.cached,4);
  assert.equal(replayed.reasoning,2);
  assert.equal(replayed.steps.duplicates,1);
  assert.equal(replayed.steps.items.length,2);
  assert.equal(replayed.semantics,'opencode-engine-defined');
  assert.doesNotMatch(JSON.stringify(replayed),/PRIVATE|total/i);
  const conflicting=withSteps([step('part-1',12,3),step('part-1',20,3)]);
  assert.equal(conflicting.steps.conflict,true);
  assert.deepEqual([conflicting.input,conflicting.output,conflicting.cached,conflicting.reasoning],[null,null,null,null]);
  const overflow=withSteps([step('part-1',Number.MAX_SAFE_INTEGER,1),step('part-2',1,1)]);
  assert.equal(overflow.input,null);
  assert.equal(overflow.output,2);
  const oversized=withSteps([step('part-1',1,1)],usage=>{usage.steps.items=Array.from({length:65},()=>usage.steps.items[0]);});
  assert.deepEqual(Object.keys(oversized).includes('steps'),false);
  assert.equal(oversized.input,null);
});

test('empty and incomplete attempt lists are reported, never papered over',()=>{
  assert.deepEqual(codes(adapt(draft())),['no-attempts-recorded']);
  const lost=clone(scenarios().interruptedUnresolved);
  lost.attempts=[];
  assert.deepEqual(codes(adapt(lost)),['attempt-records-missing']);
  delete lost.attempts;
  assert.deepEqual(codes(adapt(lost)),['attempt-records-missing']);
  const dropped=clone(scenarios().failedThenAccepted);
  dropped.attempts.shift();
  const partial=available(dropped);
  assert.equal(partial.run.attempts.length,1);
  assert.equal(partial.run.attemptsComplete,false);
  assert.deepEqual(partial.evidence.attemptList.basis,['start-events-do-not-match-attempts']);
  const gapped=clone(acceptedTask());
  gapped.events.splice(2,1);
  const unsure=available(gapped);
  assert.equal(unsure.run.attemptsComplete,false);
  assert.deepEqual(unsure.evidence.attemptList.basis,['event-log-missing-or-gapped']);
  assert.equal(unsure.run.accepted,false);
  assert.equal(unsure.evidence.acceptance.state,'unconfirmed');
  for(const events of [undefined,'events',[{seq:1,event:'task.created'}],[null,null,null,null,null]]) {
    const odd=clone(acceptedTask());
    odd.events=events;
    assert.equal(available(odd).run.attemptsComplete,false);
  }
});

test('changed or unverifiable approved input makes the receipt unavailable',()=>{
  const base=scenarios().failedThenAccepted;
  const reworded=clone(base);
  reworded.request='A different instruction';
  assert.deepEqual(adapt(reworded).reasons.map(({code,attemptIndexes})=>[code,attemptIndexes]),[['approved-input-mismatch',[0,1]]]);
  const resnapped=clone(base);
  resnapped.source='A different snapshot';
  assert.deepEqual(codes(adapt(resnapped)),['source-hash-mismatch']);
  resnapped.sourceHash=sha(resnapped.source);
  assert.deepEqual(codes(adapt(resnapped)),['approved-input-mismatch']);
  const legacy=clone(base);
  delete legacy.attempts[0].scopeHash;
  assert.deepEqual(adapt(legacy).reasons.map(({code,attemptIndexes})=>[code,attemptIndexes]),[['approved-input-unrecorded',[0]]]);
  const rerouted=clone(base);
  rerouted.attempts[1].model='another-model';
  assert.deepEqual(codes(adapt(rerouted)),['approved-input-mismatch']);
  for(const [field,value] of [['kind','other'],['request',null],['source',undefined],['expected',5],['filename',null],
    ['sourceHash','not-a-digest']]) {
    const broken=clone(base);
    broken[field]=value;
    assert.deepEqual(codes(adapt(broken)),['input-identity-missing'],field);
  }
});

test('identifiers follow the approved instruction and snapshot, not the task id alone',()=>{
  const id=overrides=>available(acceptedTask(overrides)).run;
  const base=id();
  const sameWorkElsewhere=id({id:'00000000-0000-4000-8000-000000000002',title:'Another title'});
  assert.notEqual(sameWorkElsewhere.runId,base.runId);
  assert.equal(sameWorkElsewhere.taskKey,base.taskKey);
  assert.equal(sameWorkElsewhere.inputRevision,base.inputRevision);
  assert.notEqual(sameWorkElsewhere.attempts[0].attemptId,base.attempts[0].attemptId);
  const newSnapshot=id({source:'A later snapshot'});
  assert.equal(newSnapshot.taskKey,base.taskKey);
  assert.notEqual(newSnapshot.inputRevision,base.inputRevision);
  for(const overrides of [{request:'Another instruction'},{expected:'Other text'},{filename:'other.txt'},{kind:'brief'}]) {
    assert.notEqual(id(overrides).taskKey,base.taskKey,JSON.stringify(overrides));
    assert.notEqual(id(overrides).inputRevision,base.inputRevision);
  }
  // A later export of the same record is the same run, not a second one.
  const grown=clone(scenarios().acceptedThenCancelled);
  const earlier=clone(grown);
  earlier.attempts.pop();earlier.events.length=5;earlier.version=5;earlier.status='accepted';
  assert.equal(available(earlier).run.accepted,true);
  assert.equal(available(grown).run.accepted,false);
  assert.equal(available(earlier).run.runId,available(grown).run.runId);
  assert.equal(available(earlier).run.attempts[0].attemptId,available(grown).run.attempts[0].attemptId);
});

test('acceptance needs a recorded review of the latest attempt',()=>{
  const all=scenarios();
  const pending=available(all.reviewPending);
  assert.deepEqual(pending.evidence.attempts[0].checks,{passed:1,failed:0});
  assert.equal(pending.run.attempts[0].status,'succeeded');
  assert.equal(pending.run.accepted,false,'passing structural checks are not acceptance');
  const asserted=clone(all.reviewPending);
  asserted.status=asserted.attempts[0].status='accepted';
  assert.equal(available(asserted).run.accepted,false);
  assert.equal(available(asserted).evidence.acceptance.state,'unconfirmed');
  const rejected=available(all.rejected);
  assert.equal(rejected.run.accepted,false);
  assert.equal(rejected.run.attempts[0].status,'succeeded');
  assert.equal(rejected.evidence.attempts[0].recordedStatus,'rejected');
  const superseded=available(all.acceptedThenCancelled);
  assert.equal(superseded.run.accepted,false);
  assert.equal(superseded.evidence.acceptance.earlierAcceptedAttempts,1);
  assert.deepEqual(superseded.run.attempts.map(attempt=>attempt.status),['succeeded','cancelled']);
  const stale=clone(all.acceptedThenCancelled);
  stale.status=stale.attempts[1].status='accepted';
  assert.equal(available(stale).run.accepted,false,'the only review event predates the latest attempt');
  const taskOnly=clone(all.reviewPending);
  taskOnly.status='accepted';
  assert.equal(available(taskOnly).run.accepted,false);
});

test('an operator-edited proposal is accepted with its edit provenance and no content hashes',()=>{
  const task=scenarios().editedThenAccepted;
  const {run,evidence}=available(task);
  assert.equal(run.accepted,true);
  assert.deepEqual(evidence.acceptance,{state:'accepted',operatorEdited:true,earlierAcceptedAttempts:0});
  assert.equal(evidence.attempts[0].operatorEditCount,2);
  const text=JSON.stringify({run,evidence});
  for(const entry of task.attempts[0].operatorEdits)assert.equal(text.includes(entry.artifactHash),false);
  assert.equal(text.includes(task.attempts[0].artifact.sha256),false);
  const unreadable=clone(task);
  unreadable.attempts[0].operatorEdits='two';
  assert.equal(available(unreadable).evidence.attempts[0].operatorEditCount,null);
  assert.equal(available(unreadable).evidence.acceptance.operatorEdited,null,'unknown edit history stays unknown');
  assert.deepEqual(available(acceptedTask()).evidence.acceptance,{state:'accepted',operatorEdited:false,earlierAcceptedAttempts:0});
});

test('provider categories are allowlisted and all model labels are withheld',()=>{
  const label=options=>{
    const task=draft();
    start(task,1000,options);dispatch(task,1100);finish(task,2000);
    const {run,evidence}=available(task);
    return [run.attempts[0].provider,run.attempts[0].model,evidence.attempts[0].modelWithheld];
  };
  assert.deepEqual(label({provider:'ollama',model:'qwen3.5:4b-q4_K_M'}),['ollama','withheld',true]);
  assert.deepEqual(label({provider:'opencode',backend:'ollama',model:'hf.co/org/model:Q4'}),['opencode+ollama','withheld',true]);
  for(const model of ['C:/Users/someone/models/secret.gguf','C:\\Users\\someone\\secret.gguf','/home/someone/model',
    '../outside','models/../outside','a//b','has space','<img src=x>','line\nbreak','x'.repeat(101),''])
    assert.deepEqual(label({provider:'ollama',model}),['ollama','withheld',true],JSON.stringify(model));
  assert.deepEqual(label({provider:'paid-cloud',model:'m'}).slice(0,2),['other','withheld']);
  assert.deepEqual(label({provider:'opencode',backend:'vendor-x',model:'m'}).slice(0,2),['opencode','withheld']);
});

test('untrusted shapes are read as plain data: no accessors, inheritance or coercion',()=>{
  for(const input of [null,undefined,5,'task',[],true])assert.deepEqual(codes(adapt(input)),['task-record-invalid']);
  const base=scenarios().reviewPending;
  const trapped=clone(base);
  let touched=0;
  Object.defineProperty(trapped,'title',{enumerable:true,get(){touched++;throw Error('accessor ran');}});
  Object.defineProperty(trapped.attempts[0],'problem',{enumerable:true,get(){touched++;throw Error('accessor ran');}});
  trapped.toJSON=()=>{touched++;throw Error('toJSON ran');};
  assert.equal(adapt(trapped).available,true);
  Object.defineProperty(trapped,'attempts',{enumerable:true,get(){touched++;return [];}});
  assert.deepEqual(codes(adapt(trapped)),['attempt-records-missing']);
  assert.equal(touched,0);
  const inherited=clone(base);
  inherited.attempts[0]=Object.create(inherited.attempts[0]);
  assert.deepEqual(codes(adapt(inherited)),['attempt-record-invalid']);
  const coerced=clone(base);
  coerced.attempts[0].status=['review'];
  assert.deepEqual(codes(adapt(coerced)),['attempt-status-unrecognized']);
  coerced.attempts[0].status='exploded';
  assert.deepEqual(codes(adapt(coerced)),['attempt-status-unrecognized']);
  const nested=clone(base);
  nested.attempts[0].model={toJSON(){touched++;return 'synthetic-model:1b';}};
  assert.deepEqual(codes(adapt(nested)),['approved-input-mismatch']);
  assert.equal(touched,0);
  const twins=clone(scenarios().failedThenAccepted);
  twins.attempts[1].id=twins.attempts[0].id;
  assert.deepEqual(adapt(twins).reasons.map(({code,attemptIndexes})=>[code,attemptIndexes]),[['attempt-record-invalid',[1]]]);
  const polluted=clone(base);
  polluted.attempts[0].usage=JSON.parse('{"__proto__":{"evidence":"OpenCode reported","input":5},"output":{"nested":"PRIVATE"},"steps":"PRIVATE"}');
  const usage=available(polluted).evidence.attempts[0].usage;
  assert.equal(usage.evidence,'unavailable');
  assert.equal(usage.input,null);
  assert.equal(usage.output,null);
  assert.doesNotMatch(JSON.stringify(available(polluted)),/PRIVATE/);
  const deep=clone(base);
  let pit=deep.attempts[0].usage;
  for(let depth=0;depth<9000;depth++)pit=pit.next={};
  assert.equal(available(deep).evidence.attempts[0].usage.input,12);
});

test('unsafe numbers are dropped rather than rounded',()=>{
  const base=scenarios().reviewPending;
  const versioned=clone(base);
  versioned.version=2**53;
  assert.equal(available(versioned).run.attemptsComplete,false);
  assert.equal(available(versioned).evidence.task.recordVersion,null);
  for(const elapsedMs of [Infinity,NaN,-5,'4000',null]) {
    const timed=clone(base);
    timed.attempts[0].elapsedMs=elapsedMs;
    assert.equal(available(timed).evidence.attempts[0].recordedElapsedMs,null);
  }
  const counted=clone(base);
  Object.assign(counted.attempts[0].usage,{input:2**53,output:-1,cached:1.5,generationMs:Infinity});
  const usage=available(counted).evidence.attempts[0].usage;
  assert.deepEqual([usage.input,usage.output,usage.cached,usage.generationMs],[null,null,null,null]);
  const crowded=draft();
  start(crowded,1000);dispatch(crowded,1100);finish(crowded,2000);
  const template=crowded.attempts[0];
  crowded.attempts=Array.from({length:1001},(_,index)=>({...template,id:'attempt-'+index}));
  assert.deepEqual(codes(adapt(crowded)),['attempt-limit-exceeded']);
});

test('the adapter is deterministic and leaves frozen input untouched',()=>{
  for(const [name,task] of Object.entries(scenarios())) {
    const before=JSON.stringify(task);
    deepFreeze(task);
    const options={charges:deepFreeze([charge(task.attempts[0].id)])};
    const first=JSON.stringify(adapt(task,options)),second=JSON.stringify(adapt(task,options));
    assert.equal(first,second,name);
    assert.equal(JSON.stringify(task),before,name);
    assert.equal(JSON.parse(first).available,true,name);
    assert.equal(JSON.stringify(adapt(clone(task),clone(options))),first,name);
  }
});

test('receipt modules stay pure and do not reach the isolated ledger',async()=>{
  for(const file of ['receipt-adapter.mjs','receipt-export.mjs','receipt-contract.mjs']) {
    const source=await readFile(new URL('./'+file,import.meta.url),'utf8');
    assert.doesNotMatch(source,/usage-ledger|node:sqlite|node:fs|node:http|node:net|node:child_process|fetch\(|Date\.now|Math\.random|process\.env/,file);
    const imports=[...source.matchAll(/from '([^']+)'/g)].map(match=>match[1]).sort();
    assert.deepEqual(imports.filter(name=>!['node:crypto','./export.mjs','./receipt-contract.mjs','./receipt-adapter.mjs'].includes(name)),[],file);
  }
});
