import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {terminalWorkspace} from './test-support/terminal-workspace.mjs';
import {presentSubmittedCost,reviewSubmittedHandoff} from './contributor-api.mjs';

const bytes=Buffer.from('Synthetic handoff reference');
const digest=createHash('sha256').update(bytes).digest('hex');
const manifest=()=>({format:'cydeworks.task-handoff-manifest',schemaVersion:1,
  manifestId:'manifest-one',purposeLabel:'Review reference metadata',
  task:{taskId:'task-one',workflowKind:'change',purposeLabel:'Review a synthetic change',
    scopeHashClaim:{algorithm:'sha256',digest},artifactIds:['artifact-one']},
  artifacts:[{artifactId:'artifact-one',purposeLabel:'Reference',byteLength:bytes.length,
    contentHashClaim:{algorithm:'sha256',digest}}]});
const supplied=()=>({artifactId:'artifact-one',bytesBase64:bytes.toString('base64')});

test('cost presentation retains exact units and caller-supplied evidence limits',()=>{
  for(const [delta,currency] of [[3000,'USD'],[-3000,'EUR'],[0,'JPY'],[Number.MAX_SAFE_INTEGER,'USD']]) {
    const out=presentSubmittedCost({available:true,deltaMicros:delta,currency,evidence:'estimated'});
    assert.equal(out.ok,true);assert.equal(out.billingAuthenticated,false);
    assert.equal(out.executionAuthorized,false);assert.match(out.presentation.headline,/Estimated/);
    assert.match(out.presentation.detail,new RegExp(String(delta)+' micros'));
    assert.ok(out.presentation.detail.includes(currency));
  }
  assert.match(presentSubmittedCost({available:true,deltaMicros:3000,currency:'USD',evidence:'provider-billed'}).presentation.detail,/3000 micros = 0.003 USD/);
  for(const input of [{available:false},{available:true,deltaMicros:'PRIVATE_123'}]) {
    const out=presentSubmittedCost(input);
    assert.equal(out.presentation.available,false);
    assert.doesNotMatch(JSON.stringify(out.presentation),/[0-9]|PRIVATE/);
  }
});

test('portable review distinguishes missing, claimed and verified bytes without transferring authority',()=>{
  const absent=reviewSubmittedHandoff({manifest:manifest()});
  assert.equal(absent.ok,true);
  assert.deepEqual(absent.plan.artifactReview.missingArtifactIds,['artifact-one']);
  const claim=reviewSubmittedHandoff({manifest:manifest(),artifacts:[{artifactId:'artifact-one',claimedDigest:digest}]});
  assert.deepEqual(claim.plan.artifactReview.suppliedHashOnlyArtifactIds,['artifact-one']);
  const verified=reviewSubmittedHandoff({manifest:manifest(),artifacts:[supplied()]});
  assert.equal(verified.ok,true);
  assert.deepEqual(verified.plan.artifactReview.verifiedByteArtifactIds,['artifact-one']);
  assert.equal(verified.plan.artifactReview.authenticityProven,false);
  assert.equal(verified.plan.destinationProposal.createsTaskRecord,false);
  assert.equal(verified.plan.destinationProposal.proposedState,'draft');
  assert.equal(verified.plan.ownerScopeReview.required,true);
  assert.equal(verified.executionAuthorized,false);assert.equal(verified.persisted,false);
  assert.equal(verified.manifestHistoryChecked,false);
  const mismatch=reviewSubmittedHandoff({manifest:manifest(),artifacts:[{...supplied(),bytesBase64:Buffer.from('Wrong reference').toString('base64')}]});
  assert.equal(mismatch.ok,true);
  assert.deepEqual(mismatch.plan.artifactReview.mismatchedArtifactIds,['artifact-one']);
});

test('host intake rejects hidden destination context, paths, invalid base64 and oversized bytes',()=>{
  for(const data of [null,{manifest:manifest(),context:{}},
    {manifest:manifest(),artifacts:[{...supplied(),path:'PRIVATE_PATH'}]},
    ...['A','Zh==','!!!!','Zg==\n',Buffer.alloc(32769).toString('base64')].map(value=>
      ({manifest:manifest(),artifacts:[{artifactId:'artifact-one',bytesBase64:value}]})),
    {manifest:{...manifest(),credentials:'PRIVATE_SECRET'}},
    {manifest:manifest(),artifacts:null}]) {
    const out=reviewSubmittedHandoff(data);
    assert.equal(out.ok,false);assert.doesNotMatch(JSON.stringify(out),/PRIVATE_/);
  }
  assert.equal(reviewSubmittedHandoff({manifest:manifest()},['task-one']).ok,false);
  const data={manifest:manifest(),artifacts:[supplied()]},before=JSON.stringify(data);
  reviewSubmittedHandoff(data);assert.equal(JSON.stringify(data),before);
});

test('authenticated HTTP integrations are bounded, read-only and use host conflict context',{timeout:15000},async t=>{
  const {request,path,task}=await terminalWorkspace(t,{startImmediately:false});
  const before=await (await request(path)).text();
  const inventory=await (await request('/api/tasks')).text();
  for(const endpoint of ['/api/cost-presentation','/api/handoffs/review']) {
    assert.equal((await request(endpoint,{}, {authenticated:false})).status,401);
    assert.equal((await request(endpoint,{}, {originHeader:'https://untrusted.invalid'})).status,403);
    assert.equal((await request(endpoint)).status,405);
  }
  const cost=await request('/api/cost-presentation',{available:false});
  assert.equal(cost.status,200);assert.equal((await cost.json()).presentation.available,false);
  assert.equal((await request('/api/cost-presentation',{available:true})).status,400);
  const valid=await request('/api/handoffs/review',{manifest:manifest(),artifacts:[supplied()]});
  assert.equal(valid.status,200);assert.equal((await valid.json()).plan.artifactReview.bytesVerifiedCount,1);
  const conflict=manifest();conflict.task.taskId=task.id;
  assert.equal((await request('/api/handoffs/review',{manifest:conflict})).status,400);
  assert.equal((await request('/api/handoffs/review',{manifest:manifest(),junk:'x'.repeat(48000)})).status,413);
  assert.equal(await (await request(path)).text(),before);
  assert.equal(await (await request('/api/tasks')).text(),inventory);
});
