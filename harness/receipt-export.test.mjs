import test from 'node:test';
import assert from 'node:assert/strict';
import {exportReceipt,RECEIPT_LIMITS} from './receipt-export.mjs';
import {exportTask} from './export.mjs';
import {EXPORT_CONTRACT,UNAVAILABLE_REASONS,validateReceiptExport} from './receipt-contract.mjs';
import {createStepReceipt} from './opencode-usage.mjs';
import {at,clone,deepFreeze,dispatch,draft,edit,finish,review,scenarios,start} from './test-support/receipt-synthetic.mjs';

// Every word the contract can emit as a fixed value.
function vocabulary(spec,words=new Set()) {
  if(spec.type==='enum')for(const value of spec.values)words.add(value);
  if(spec.type==='const'&&typeof spec.value==='string')words.add(spec.value);
  if(spec.type==='array')vocabulary(spec.items,words);
  if(spec.type==='object')for(const child of Object.values(spec.keys))vocabulary(child,words);
  return words;
}
function walk(value,visit,key) {
  visit(key,value);
  if(Array.isArray(value))for(const item of value)walk(item,visit,undefined);
  else if(value&&typeof value==='object')for(const [name,item] of Object.entries(value))walk(item,visit,name);
}

// The complete set of property names the export may contain.
const ALLOWED_KEYS=new Set(['format','formatVersion','available','run','evidence','limits','reasons','code','message',
  'attemptIndexes','schemaVersion','runId','taskKey','inputRevision','accepted','attemptsComplete','attempts','attemptId',
  'provider','model','status','outcomeKnown','startedAtMs','endedAtMs','cost','amountMicros','currency','complete',
  'runDefinition','attemptLinkage','timebase','task','kind','recordVersion','acceptance','state','operatorEdited',
  'earlierAcceptedAttempts','attemptList','basis','inputIdentity','attemptsVerified','chargeInput','records','duplicates',
  'unattributed','recordedStatus','backend','executionPhase','recovery','recoveryEvidence','outcomeBasis','startedAt',
  'endedAt','recordedElapsedMs','modelWithheld','operatorEditCount','checks','passed','failed','usage','semantics',
  'input','output','cached','cacheWrite','reasoning','generationMs','loadMs','promptMs','steps','items','unidentified',
  'identityAmbiguous','conflict','truncated']);

// A record with a canary in every place the export must not read from.
function canaryTask() {
  const task=draft({id:'c0ffee00-0000-4000-8000-00000000cafe',title:'CANARY_TITLE',
    request:'CANARY_REQUEST read C:\\Users\\canary\\notes.txt',source:'CANARY_SOURCE sk-canary-0000 /home/canary/.ssh/id_rsa',
    filename:'canary-file.txt',expected:'CANARY_EXPECTED'});
  start(task,1000,{provider:'ollama',identity:'d'.repeat(64)});dispatch(task,1100);
  finish(task,3000,{status:'failed',problem:'CANARY_PROBLEM at C:\\Users\\canary\\work and /home/canary/work'});
  const collector=createStepReceipt();
  collector.observe({type:'step_finish',sessionID:'CANARY_SESSION',part:{id:'CANARY_PART',sessionID:'CANARY_SESSION',
    messageID:'CANARY_MESSAGE',tokens:{input:7,output:3,cache:{read:1,write:0},reasoning:0}}});
  const usage=collector.snapshot();
  usage.rawResponse='CANARY_RAW_RESPONSE';
  usage.steps.items[0].content='CANARY_STEP';
  start(task,4000,{provider:'opencode',backend:'llamacpp',model:'synthetic-gguf-q4',identity:'e'.repeat(64)});
  dispatch(task,4100);finish(task,9000,{usage});edit(task,10000);review(task,12000);
  const [first,second]=task.attempts;
  Object.assign(task,{apiKey:'sk-CANARY-KEY',cookie:'bfe_session=CANARY_COOKIE',accessKeyPath:'C:\\CANARY\\.state\\access.key',
    notes:{deep:{deeper:['CANARY_NESTED']}}});
  Object.assign(first,{terminal:[{at:at(3000),message:'CANARY_TERMINAL'}],env:{PATH:'C:\\CANARY\\bin'},
    modelDigest:'f'.repeat(64),rawProviderResponse:{body:'CANARY_PROVIDER_BODY'}});
  Object.assign(second,{engineSessionId:'CANARY_ENGINE_SESSION',modelFingerprint:'b'.repeat(64),
    workingDirectory:'C:\\CANARY\\.state\\opencode\\'+second.id,conversation:[{role:'user',content:'CANARY_CONVERSATION'}]});
  second.artifact.content='CANARY_ARTIFACT';
  second.artifact.rawContent='CANARY_RAW_ARTIFACT';
  second.originalArtifact.content='CANARY_ORIGINAL_ARTIFACT';
  second.checks[0].name='CANARY_CHECK_NAME';
  second.recovery={state:'retry-safe',evidence:'CANARY_EVIDENCE',message:'CANARY_RECOVERY_MESSAGE',at:at(9000)};
  task.events[1].note='CANARY_EVENT';
  return task;
}

test('the export carries allowlisted fields only and none of the planted canaries',()=>{
  const task=canaryTask();
  const charges=[{attemptId:task.attempts[1].id,amountMicros:0,currency:'USD',evidence:'estimated',complete:true,
    invoice:'CANARY_INVOICE'}];
  const exported=exportReceipt(task,{charges});
  assert.equal(exported.available,true);
  assert.equal(validateReceiptExport(exported).ok,true);
  const text=JSON.stringify(exported);
  assert.doesNotMatch(text,/canary|bfe_session|access\.key|\.state|opencode\\\\/i);
  assert.doesNotMatch(text,/[A-Za-z]:\\\\|\\\\Users|\/home\/|\/Users\//);
  assert.doesNotMatch(text,/[a-f0-9]{64}/,'no full digests');
  assert.doesNotMatch(text,/\d{4}-\d{2}-\d{2}T/,'no wall-clock timestamps');
  for(const raw of [task.id,task.sourceHash,...task.attempts.flatMap(attempt=>[attempt.id,attempt.scopeHash,
    attempt.execution.claimId,attempt.approvedModelDigest,attempt.approvedModelFingerprint,attempt.artifact?.sha256])])
    if(raw)assert.equal(text.includes(raw),false,raw);
  const words=new Set([...vocabulary(EXPORT_CONTRACT.available),...RECEIPT_LIMITS,
    'ollama','opencode+llamacpp','withheld']);
  walk(exported,(key,value)=>{
    if(key!==undefined)assert.ok(ALLOWED_KEYS.has(key),'unexpected property '+key);
    if(typeof value==='string')assert.ok(words.has(value)||/^cw[rtia]1-[a-f0-9]{32}$/.test(value),'unexpected text '+value);
  });
  assert.equal(exported.run.attempts[1].cost,null,'a charge record with extra properties is not trusted');
  assert.equal(exported.evidence.attempts[1].recoveryEvidence,'unrecognized');
  assert.equal(exported.evidence.attempts[1].usage.input,7);
  assert.equal(exported.evidence.acceptance.operatorEdited,true);
});

test('token usage and provenance stay outside the inspector payload',()=>{
  const {run,evidence}=exportReceipt(scenarios().failedThenAccepted);
  walk(run,key=>{
    if(key!==undefined)assert.ok(['schemaVersion','runId','taskKey','inputRevision','accepted','attemptsComplete','attempts',
      'attemptId','provider','model','status','outcomeKnown','startedAtMs','endedAtMs','cost'].includes(key),key);
  });
  assert.equal(evidence.attempts[0].usage.input,12);
  assert.equal(evidence.timebase,'run-relative');
  assert.equal(evidence.runDefinition,'one-task-record-attempt-history');
});

test('repeated exports are byte-identical and leave the record and the existing exports unchanged',()=>{
  for(const [name,task] of Object.entries({...scenarios(),canary:canaryTask()})) {
    const before=JSON.stringify(task),minimal=JSON.stringify(exportTask(task,'minimal')),standard=JSON.stringify(exportTask(task,'standard'));
    deepFreeze(task);
    const first=JSON.stringify(exportReceipt(task));
    assert.equal(JSON.stringify(exportReceipt(task)),first,name);
    assert.equal(JSON.stringify(exportReceipt(clone(task))),first,name);
    assert.equal(JSON.stringify(task),before,name);
    assert.equal(JSON.stringify(exportTask(task,'minimal')),minimal,name);
    assert.equal(JSON.stringify(exportTask(task,'standard')),standard,name);
    // The sidecar usage is exactly what the existing minimal export reports.
    const receipt=JSON.parse(first);
    assert.deepEqual(receipt.evidence.attempts.map(attempt=>attempt.usage),JSON.parse(minimal).task.attempts.map(attempt=>attempt.usage),name);
  }
});

test('unavailable results are structured, validated and carry no run',()=>{
  const refused=exportReceipt(draft());
  assert.deepEqual(Object.keys(refused),['format','formatVersion','available','reasons','limits']);
  assert.equal(refused.format,'cydeworks.run-receipt-export');
  assert.equal(refused.formatVersion,2);
  assert.deepEqual(refused.reasons,[{code:'no-attempts-recorded',message:UNAVAILABLE_REASONS['no-attempts-recorded'],attemptIndexes:[]}]);
  assert.equal(validateReceiptExport(refused).ok,true);
  const tampered=clone(canaryTask());
  tampered.request='CANARY_CHANGED_REQUEST';
  const mismatch=exportReceipt(tampered);
  assert.equal(mismatch.available,false);
  assert.deepEqual(mismatch.reasons.map(reason=>[reason.code,reason.attemptIndexes]),[['approved-input-mismatch',[0,1]]]);
  assert.doesNotMatch(JSON.stringify(mismatch),/canary/i);
  for(const junk of [null,'task',{attempts:'CANARY'},{id:'CANARY',attempts:[{id:'CANARY',status:'CANARY'}]}]) {
    const result=exportReceipt(junk);
    assert.equal(result.available,false);
    assert.equal(validateReceiptExport(result).ok,true);
    assert.doesNotMatch(JSON.stringify(result),/canary/i);
  }
});

test('the timebase option is allowlisted and changes instants only',()=>{
  const task=scenarios().failedThenAccepted;
  const relative=exportReceipt(task),epoch=exportReceipt(task,{timebase:'epoch'});
  assert.equal(epoch.evidence.timebase,'epoch');
  assert.equal(epoch.run.attempts[0].startedAtMs,Date.parse(task.attempts[0].started));
  const shift=epoch.run.attempts[0].startedAtMs-relative.run.attempts[0].startedAtMs;
  assert.deepEqual(epoch.run.attempts.map(attempt=>[attempt.startedAtMs-shift,attempt.endedAtMs-shift]),
    relative.run.attempts.map(attempt=>[attempt.startedAtMs,attempt.endedAtMs]));
  assert.deepEqual({...epoch.run,attempts:null},{...relative.run,attempts:null});
  for(const timebase of ['local','',null,5,['epoch']])
    assert.throws(()=>exportReceipt(task,{timebase}),error=>error.status===400&&/supported receipt timebase/.test(error.message));
});
