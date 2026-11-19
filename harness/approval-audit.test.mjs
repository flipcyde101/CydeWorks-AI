import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,mkdtempSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,parse,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  DEFAULT_PROJECT_ID,
  WorkspaceProjects,
  resolveLocalRoot,
  verifyContainedRoot,
} from './workspace-projects.mjs';
import {
  ACTION_GRANT_TTL_MS,
  ApprovalAuditStore,
  DEFAULT_POLICY_VERSION,
  projectGrantRecord,
} from './approval-audit.mjs';

const sha=text=>createHash('sha256').update(text).digest('hex');
const SRC_HASH=sha('source-v1');
const ROUTE_REV=sha('route-v1');
const MODEL_DIGEST=sha('model-v1');
const TARGET_DIGEST=sha('target-payload-v1');
const GIT_REV='a'.repeat(40);
const GIT_REV_2='b'.repeat(40);

function makeScratchDir(t,prefix='pkg02-synthetic-') {
  const workRoot=resolve(fileURLToPath(new URL('../work/',import.meta.url)));
  mkdirSync(workRoot,{recursive:true});
  const dir=mkdtempSync(join(workRoot,prefix));
  t.after(()=>{rmSync(dir,{recursive:true,force:true});});
  return dir;
}

function makeStores({clock=()=>1_795_000_000_000,policyVersion=DEFAULT_POLICY_VERSION,dbPath=':memory:',defaultRoot=null}={}) {
  const db=new DatabaseSync(dbPath);
  const projects=new WorkspaceProjects(db,{clock,defaultRoot});
  const audit=new ApprovalAuditStore(db,{clock,policyVersion,projects});
  return {db,projects,audit};
}

function validSubmission(overrides={}) {
  return {
    requestId:randomUUID(),
    version:1,
    sourceHash:SRC_HASH,
    approve:true,
    model:'qwen3:1.7b',
    engine:'ollama',
    backend:'ollama',
    modelDigest:MODEL_DIGEST,
    routeRevision:ROUTE_REV,
    ...overrides,
  };
}

function validAttemptInput({projectId=DEFAULT_PROJECT_ID,approvedRoots=[],submission=validSubmission(),...rest}={}) {
  return {
    taskId:randomUUID(),
    projectId,
    submission,
    destination:{kind:'local-loopback',endpoint:'http://127.0.0.1:11434'},
    accountRef:'local-preview',
    approvedRoots,
    permissions:['read-only-source','loopback-http'],
    testPlan:{kind:'change',checks:['Proposed content differs','Contains expected text'],filename:'sample.js',expected:'return true;'},
    ...rest,
  };
}

function scopeFromGrant(grant,overrides={}) {
  return {
    taskId:grant.taskId,
    taskVersion:grant.taskVersion,
    projectId:grant.projectId,
    projectRevision:grant.projectRevision,
    sourceHash:grant.sourceHash,
    routeRevision:grant.routeRevision,
    model:grant.model,
    engine:grant.engine,
    backend:grant.backend,
    modelDigest:grant.modelDigest,
    modelFingerprint:grant.modelFingerprint,
    destination:grant.destination,
    accountRef:grant.accountRef,
    approvedRoots:grant.approvedRoots,
    permissions:grant.permissions,
    testPlan:grant.testPlan,
    ...overrides,
  };
}

function validActionInput({projectId,approvedRoots=[],...rest}={}) {
  return {
    action:'apply-patch',
    sessionId:'session-owner-1',
    target:{kind:'patch',id:'patch-1',digest:TARGET_DIGEST},
    destination:{kind:'local-workspace',endpoint:null},
    taskId:randomUUID(),
    taskVersion:3,
    projectId,
    sourceHash:SRC_HASH,
    routeRevision:ROUTE_REV,
    accountRef:'owner-local',
    approvedRoots,
    permissions:['read-only-source','repository-write'],
    ...rest,
  };
}

function consumeArgsFromGrant(grant,overrides={}) {
  return {
    grantId:grant.grantId,
    sessionId:grant.sessionId,
    action:grant.action,
    target:grant.target,
    destination:grant.destination,
    taskId:grant.taskId,
    taskVersion:grant.taskVersion,
    projectId:grant.projectId,
    projectRevision:grant.projectRevision,
    sourceHash:grant.sourceHash,
    routeRevision:grant.routeRevision,
    accountRef:grant.accountRef,
    approvedRoots:grant.approvedRoots,
    permissions:grant.permissions,
    ...overrides,
  };
}

test('workspace projects register disposable local roots, associate legacy tasks, and reject unsafe/network paths pre-FS',t=>{
  const scratch=makeScratchDir(t);
  const projectDir=join(scratch,'repo-alpha');
  const subDir=join(projectDir,'packages','core');
  const outsideDir=join(scratch,'outside-repo');
  const filePath=join(scratch,'not-a-dir.txt');
  const linkPath=join(scratch,'repo-link');
  mkdirSync(subDir,{recursive:true});
  mkdirSync(outsideDir);
  writeFileSync(filePath,'synthetic');
  let symlinkCreated=false;
  try {
    symlinkSync(projectDir,linkPath,'junction');
    symlinkCreated=true;
  } catch {
    symlinkCreated=false;
  }

  const dbPath=join(scratch,'workspace.sqlite');
  let now=1_795_000_000_000;
  const {db,projects}=makeStores({clock:()=>now,dbPath});
  try {
    const initial=projects.listProjects();
    assert.equal(initial.defaultProjectId,DEFAULT_PROJECT_ID);
    assert.equal(initial.projects.length,1);
    assert.equal(initial.projects[0].isDefault,true);
    assert.equal(initial.projects[0].root,null);

    const legacyTask={id:randomUUID(),title:'Legacy task',status:'draft'};
    const associated=projects.associateTask(legacyTask);
    assert.equal(associated.id,legacyTask.id);
    assert.equal(associated.projectId,DEFAULT_PROJECT_ID);
    assert.equal(Object.hasOwn(legacyTask,'projectId'),false);
    assert.deepEqual(projects.approvedRoots(DEFAULT_PROJECT_ID),[]);

    const created=projects.registerProject({label:'Alpha Synthetic',root:projectDir,revision:GIT_REV});
    assert.equal(created.created,true);
    assert.equal(created.project.label,'Alpha Synthetic');
    assert.equal(created.project.root,resolveLocalRoot(projectDir));
    assert.equal(created.project.revision,GIT_REV);
    assert.equal(created.project.isDefault,false);

    const retry=projects.registerProject({label:'Alpha Synthetic',root:projectDir,revision:GIT_REV});
    assert.equal(retry.created,false);
    assert.equal(retry.project.id,created.project.id);

    assert.throws(()=>projects.registerProject({label:'Renamed Alpha',root:projectDir}),{status:409,code:'PROJECT_ROOT_CONFLICT'});
    assert.deepEqual(projects.approvedRoots(created.project.id),[created.project.root]);
    assert.equal(verifyContainedRoot(created.project.root,subDir),resolveLocalRoot(subDir));
    assert.throws(()=>verifyContainedRoot(created.project.root,outsideDir),{status:400,code:'APPROVED_ROOT_OUTSIDE_PROJECT'});

    now+=1000;
    const updated=projects.updateRevision(created.project.id,GIT_REV_2);
    assert.equal(updated.revision,GIT_REV_2);

    const boundTask=projects.associateTask({id:randomUUID(),projectId:created.project.id});
    assert.equal(boundTask.projectId,created.project.id);

    // Pre-FS path syntax rejections (network/UNC, Windows device namespaces, drive-relative, DOS devices, wildcards, trailing dot/space, traversal) and non-dir/missing paths.
    for(const badRoot of [
      'relative/dir',
      join(scratch,'missing'),
      filePath,
      '',
      'C:\\\u0000bad',
      '\\\\server\\share\\repo',
      '//server/share/repo',
      '\\\\?\\C:\\work\\repo',
      '\\\\.\\NUL',
      'C:relative\\repo',
      'C:\\work\\CON',
      'C:\\work\\nul.txt\\repo',
      'C:\\work\\bad*dir',
      'C:\\work\\stream:ads',
      'C:\\work\\trailing.',
      'C:\\work\\trailing ',
      'C:\\work\\..\\escape',
      parse(process.cwd()).root,
    ]) {
      assert.throws(()=>projects.registerProject({label:'Bad',root:badRoot}),{status:400});
    }
    if(symlinkCreated) {
      assert.throws(()=>projects.registerProject({label:'Symlink',root:linkPath}),{status:400,code:'PROJECT_ROOT_SYMLINK'});
      assert.throws(()=>resolveLocalRoot(join(linkPath,'packages')),{status:400,code:'PROJECT_ROOT_SYMLINK'});
    }
    assert.throws(()=>projects.registerProject({label:' ',root:projectDir}),{status:400});
    assert.throws(()=>projects.registerProject({label:'Extra',root:projectDir,extra:true}),{status:400});
    assert.throws(()=>projects.registerProject({label:'BadRev',root:projectDir,revision:'not-hex'}),{status:400});
    assert.throws(()=>projects.associateTask({id:randomUUID(),projectId:randomUUID()}),{status:404});
  } finally {
    db.close();
  }

  // Reopen persisted SQLite file to verify persistence across restarts.
  const db2=new DatabaseSync(dbPath);
  try {
    const reopened=new WorkspaceProjects(db2);
    const list=reopened.listProjects();
    assert.equal(list.projects.length,2);
    assert.equal(list.projects[1].label,'Alpha Synthetic');
    assert.equal(list.projects[1].revision,GIT_REV_2);
  } finally {
    db2.close();
  }
});

test('attempt grant binds registered project and revision, enforces SQLite immutability, and replays idempotently',t=>{
  const scratch=makeScratchDir(t);
  const projectDir=join(scratch,'repo-beta');
  mkdirSync(projectDir);
  const now=1_795_000_000_000;
  const {db,projects,audit}=makeStores({clock:()=>now});
  try {
    const {project}=projects.registerProject({label:'Beta',root:projectDir,revision:GIT_REV});
    const input=validAttemptInput({
      projectId:project.id,
      approvedRoots:projects.approvedRoots(project.id),
      sessionId:'session-1',
    });
    const issued=audit.issueAttemptGrant(input);
    assert.equal(issued.replayed,false);
    assert.match(issued.grant.grantId,/^[a-f0-9-]{36}$/);
    assert.match(issued.grant.claimId,/^[a-f0-9-]{36}$/);
    assert.match(issued.grant.attemptId,/^[a-f0-9-]{36}$/);
    assert.equal(issued.grant.requestId,input.submission.requestId);
    assert.equal(issued.grant.projectRevision,GIT_REV);
    assert.equal(issued.grant.sourceHash,SRC_HASH);
    assert.equal(issued.grant.routeRevision,ROUTE_REV);
    assert.equal(issued.grant.policyVersion,DEFAULT_POLICY_VERSION);
    assert.equal(issued.grant.issuedAt,new Date(now).toISOString());
    assert.equal(issued.grant.expiresAt,new Date(now+ACTION_GRANT_TTL_MS).toISOString());
    assert.equal(issued.claim.phase,'claimed');
    assert.ok(Object.isFrozen(issued.grant));

    // Unregistered projects and outside roots fail closed.
    assert.throws(()=>audit.issueAttemptGrant(validAttemptInput({projectId:'missing-project'})),{status:404,code:'PROJECT_NOT_FOUND'});
    assert.throws(()=>audit.issueAttemptGrant(validAttemptInput({
      projectId:DEFAULT_PROJECT_ID,
      approvedRoots:[projectDir],
    })),{status:400,code:'APPROVED_ROOT_OUTSIDE_PROJECT'});

    // Exact replay returns the original grant and claim without creating a second record.
    const replayed=audit.issueAttemptGrant(input);
    assert.equal(replayed.replayed,true);
    assert.equal(replayed.grant.grantId,issued.grant.grantId);
    assert.equal(replayed.claim.claimId,issued.claim.claimId);

    // Reusing requestId with changed inputs conflicts.
    assert.throws(()=>audit.issueAttemptGrant({
      ...input,
      submission:{...input.submission,sourceHash:sha('tampered')},
    }),{status:409,code:'SUBMISSION_CONFLICT'});
    assert.throws(()=>audit.issueAttemptGrant({
      ...input,
      destination:{kind:'remote-endpoint',endpoint:'https://api.example.com/v1'},
      permissions:['read-only-source','remote-data-egress'],
    }),{status:409,code:'SUBMISSION_CONFLICT'});

    // SQLite triggers block UPDATE and DELETE on immutable grant and audit tables and DELETE on claims.
    assert.throws(()=>db.prepare('UPDATE approval_grants SET policy_version=? WHERE grant_id=?').run('v2',issued.grant.grantId),/immutable/);
    assert.throws(()=>db.prepare('DELETE FROM approval_grants WHERE grant_id=?').run(issued.grant.grantId),/cannot be deleted/);
    assert.throws(()=>db.prepare('UPDATE approval_audit_log SET event_type=? WHERE grant_id=?').run('tamper',issued.grant.grantId),/append-only/);
    assert.throws(()=>db.prepare('DELETE FROM approval_audit_log WHERE grant_id=?').run(issued.grant.grantId),/append-only/);
    assert.throws(()=>db.prepare('DELETE FROM approval_claims WHERE claim_id=?').run(issued.claim.claimId),/cannot be deleted/);
    assert.throws(()=>db.prepare('UPDATE approval_claims SET attempt_id=? WHERE claim_id=?').run(randomUUID(),issued.claim.claimId),/immutable/);

    const log=audit.listAuditLog(issued.grant.grantId);
    assert.equal(log.length,1);
    assert.equal(log[0].eventType,'grant.issued_and_claimed');
  } finally {
    db.close();
  }
});

test('two-tab approval races and multi-connection SQLite module dispatch at most once',t=>{
  const scratch=makeScratchDir(t);
  const dbPath=join(scratch,'race.sqlite');
  const now=1_795_000_000_000;
  const {db:dbA,audit:auditA}=makeStores({clock:()=>now,dbPath});
  const dbB=new DatabaseSync(dbPath);
  const auditB=new ApprovalAuditStore(dbB,{clock:()=>now});

  try {
    const taskId=randomUUID();
    const firstInput=validAttemptInput({taskId});
    const tabBInput=validAttemptInput({taskId,submission:validSubmission({requestId:randomUUID()})});

    // Connection A wins the claim; Connection B with a different requestId is blocked.
    const tabAResult=auditA.issueAttemptGrant(firstInput);
    assert.equal(tabAResult.replayed,false);
    assert.throws(()=>auditB.issueAttemptGrant(tabBInput),{status:409,code:'CLAIM_CONFLICT'});

    // Two SQLite connections racing to dispatch the same grant/claim: exactly one succeeds.
    let workerDispatches=0;
    let billingReservations=0;
    const scope=scopeFromGrant(tabAResult.grant);
    const attemptDispatch=store=>{
      const res=store.beginDispatch({
        grantId:tabAResult.grant.grantId,
        claimId:tabAResult.claim.claimId,
        currentScope:scope,
        workerId:'worker-tab-1',
      });
      workerDispatches++;
      billingReservations++;
      return res;
    };

    const outcomes=[attemptDispatch,attemptDispatch].map((fn,idx)=>{
      try {
        return {ok:true,value:fn(idx===0?auditA:auditB)};
      } catch(error) {
        return {ok:false,error};
      }
    });
    assert.equal(outcomes.filter(o=>o.ok).length,1);
    assert.equal(outcomes.filter(o=>!o.ok).length,1);
    assert.equal(outcomes.find(o=>!o.ok).error.code,'ALREADY_DISPATCHED');
    assert.equal(workerDispatches,1);
    assert.equal(billingReservations,1);

    const settled=auditA.completeDispatch({
      grantId:tabAResult.grant.grantId,
      claimId:tabAResult.claim.claimId,
      outcome:'succeeded',
    });
    assert.equal(settled.duplicate,false);
    assert.equal(settled.claim.phase,'settled');
    assert.equal(auditA.completeDispatch({
      grantId:tabAResult.grant.grantId,
      claimId:tabAResult.claim.claimId,
      outcome:'succeeded',
    }).duplicate,true);
    assert.throws(()=>auditA.completeDispatch({
      grantId:tabAResult.grant.grantId,
      claimId:tabAResult.claim.claimId,
      outcome:'failed',
    }),{status:409,code:'SETTLEMENT_CONFLICT'});
  } finally {
    dbA.close();
    dbB.close();
  }
});

test('incomplete currentScope, expired/revoked grants, root mutations, and scope drift reject dispatch',t=>{
  const scratch=makeScratchDir(t);
  const projectDir=join(scratch,'repo-scope');
  const rootA=join(projectDir,'pkg-a');
  const rootB=join(projectDir,'pkg-b');
  mkdirSync(rootA,{recursive:true});
  mkdirSync(rootB,{recursive:true});

  let now=1_795_000_000_000;
  const {db,projects,audit}=makeStores({clock:()=>now});
  try {
    const {project}=projects.registerProject({label:'ScopeRepo',root:projectDir,revision:GIT_REV});
    let workerDispatches=0;
    let billingCharges=0;
    const tryDispatch=(grant,claim,scopeOverrides={})=>{
      const result=audit.beginDispatch({
        grantId:grant.grantId,
        claimId:claim.claimId,
        currentScope:scopeFromGrant(grant,scopeOverrides),
      });
      workerDispatches++;
      billingCharges++;
      return result;
    };

    // 1. Expiry at exact millisecond boundary.
    const expCase=audit.issueAttemptGrant(validAttemptInput({ttlMs:60_000}));
    now+=60_000;
    assert.throws(()=>tryDispatch(expCase.grant,expCase.claim),{status:409,code:'GRANT_EXPIRED'});
    assert.equal(workerDispatches,0);
    assert.equal(billingCharges,0);

    // 2. Clock skew (future-dated grant) and revocation fail closed and block revocation table tampering.
    const futureCase=audit.issueAttemptGrant(validAttemptInput());
    now-=1;
    assert.throws(()=>tryDispatch(futureCase.grant,futureCase.claim),{status:409,code:'GRANT_NOT_YET_VALID'});
    now+=1;
    assert.equal(audit.revokeGrant(futureCase.grant.grantId,{reason:'operator-cancelled'}).revoked,true);
    assert.equal(audit.revokeGrant(futureCase.grant.grantId).duplicate,true);
    assert.throws(()=>db.prepare('DELETE FROM approval_grant_revocations WHERE grant_id=?').run(futureCase.grant.grantId),/cannot be deleted/);
    assert.throws(()=>db.prepare('UPDATE approval_grant_revocations SET reason=? WHERE grant_id=?').run('tamper',futureCase.grant.grantId),/immutable/);
    assert.throws(()=>tryDispatch(futureCase.grant,futureCase.claim),{status:409,code:'GRANT_REVOKED'});

    // 3. Omitting ANY required field in currentScope fails closed.
    const scopeCase=audit.issueAttemptGrant(validAttemptInput({
      projectId:project.id,
      approvedRoots:[rootA],
      sessionId:'session-attempt-1',
    }));
    const fullScope=scopeFromGrant(scopeCase.grant);
    for(const field of Object.keys(fullScope)) {
      const partial={...fullScope};
      delete partial[field];
      assert.throws(()=>audit.beginDispatch({
        grantId:scopeCase.grant.grantId,
        claimId:scopeCase.claim.claimId,
        currentScope:partial,
      }),{status:400,code:'MISSING_CURRENT_SCOPE'});
    }

    // 4. Changed scope, route, destination, permissions, roots, projectRevision, testPlan, and policy fail closed.
    const changes=[
      [{taskVersion:scopeCase.grant.taskVersion+1},'SCOPE_CHANGED'],
      [{projectRevision:GIT_REV_2},'PROJECT_REVISION_CHANGED'],
      [{sourceHash:sha('changed-source')},'SCOPE_CHANGED'],
      [{routeRevision:sha('changed-route')},'ROUTE_CHANGED'],
      [{model:'different-model'},'ROUTE_CHANGED'],
      [{destination:{kind:'remote-endpoint',endpoint:'https://api.example.com/v1'}},'DESTINATION_CHANGED'],
      [{accountRef:'other-account'},'SCOPE_CHANGED'],
      [{approvedRoots:[rootB]},'SCOPE_CHANGED'],
      [{permissions:['read-only-source','repository-write']},'SCOPE_CHANGED'],
      [{testPlan:{kind:'change',checks:['Changed check'],filename:'sample.js',expected:'return true;'}},'SCOPE_CHANGED'],
    ];
    for(const [override,code] of changes) {
      assert.throws(()=>tryDispatch(scopeCase.grant,scopeCase.claim,override),{status:409,code});
    }

    // 5. Moving/deleting an approved root between approval and dispatch fails closed on disk revalidation.
    const movedRoot=join(scratch,'moved-root');
    renameSync(rootA,movedRoot);
    assert.throws(()=>tryDispatch(scopeCase.grant,scopeCase.claim),{status:409,code:'APPROVED_ROOT_MISSING'});
    renameSync(movedRoot,rootA);

    // 6. Project revision change in registry fails closed even if currentScope passes old revision.
    projects.updateRevision(project.id,GIT_REV_2);
    assert.throws(()=>tryDispatch(scopeCase.grant,scopeCase.claim),{status:409,code:'PROJECT_REVISION_CHANGED'});
    projects.updateRevision(project.id,GIT_REV);

    // 7. Policy version bump fails closed.
    audit.setPolicyVersion('approval-policy-v2');
    assert.throws(()=>tryDispatch(scopeCase.grant,scopeCase.claim),{status:409,code:'POLICY_CHANGED'});
    audit.setPolicyVersion(DEFAULT_POLICY_VERSION);
    assert.equal(workerDispatches,0);
    assert.equal(billingCharges,0);

    // 8. Locking UI sessions (revokeSession) invalidates pending action grants while preserving already-authorized attempt dispatch/settlement.
    audit.revokeSession('session-attempt-1');
    const dispatchedAfterLock=tryDispatch(scopeCase.grant,scopeCase.claim);
    assert.equal(dispatchedAfterLock.dispatched,true);
    const settledAfterLock=audit.completeDispatch({
      grantId:scopeCase.grant.grantId,
      claimId:scopeCase.claim.claimId,
      outcome:'succeeded',
    });
    assert.equal(settledAfterLock.claim.phase,'settled');
    assert.throws(()=>audit.revokeGrant(scopeCase.grant.grantId),{status:409,code:'ALREADY_DISPATCHED'});

    // 9. Superseded expired pre-dispatch claim does not block a fresh approved attempt on the same task.
    const fresh=audit.issueAttemptGrant(validAttemptInput({taskId:expCase.grant.taskId}));
    const dispatched=tryDispatch(fresh.grant,fresh.claim);
    assert.equal(dispatched.dispatched,true);
    assert.equal(workerDispatches,2);
    assert.equal(billingCharges,2);
  } finally {
    db.close();
  }
});

test('5-minute single-use action grants enforce target/digest, session binding, root revalidation, expiry, and revocation',t=>{
  const scratch=makeScratchDir(t);
  const projectDir=join(scratch,'repo-action');
  const repoSub=join(projectDir,'src');
  const outsideTarget=join(scratch,'outside-target');
  mkdirSync(repoSub,{recursive:true});
  mkdirSync(outsideTarget);

  let now=1_795_000_000_000;
  const {db,projects,audit}=makeStores({clock:()=>now});
  try {
    const {project}=projects.registerProject({label:'ActionRepo',root:projectDir,revision:GIT_REV});
    const baseInput=validActionInput({
      projectId:project.id,
      approvedRoots:[repoSub],
      requestId:randomUUID(),
    });
    const grant=audit.issueActionGrant(baseInput);
    assert.equal(grant.expiresAt,new Date(now+300_000).toISOString());
    assert.equal(grant.projectRevision,GIT_REV);
    assert.equal(grant.sessionId,'session-owner-1');
    assert.equal(grant.target.digest,TARGET_DIGEST);

    // Missing sessionId or target fails closed at issue time.
    assert.throws(()=>audit.issueActionGrant({...baseInput,requestId:null,sessionId:''}),{status:400,code:'MISSING_SESSION_ID'});
    assert.throws(()=>audit.issueActionGrant({...baseInput,requestId:null,target:{kind:'patch',id:'p1'}}),{status:400,code:'INVALID_ACTION_TARGET'});

    const consumeArgs=consumeArgsFromGrant(grant);

    // Cross-session, target/digest mismatch, changed action/destination/roots/permissions/source fail without consuming.
    assert.throws(()=>audit.consumeActionGrant({...consumeArgs,sessionId:'session-other'}),{status:409,code:'SESSION_MISMATCH'});
    assert.throws(()=>audit.consumeActionGrant({
      ...consumeArgs,
      target:{kind:'patch',id:'patch-1',digest:sha('tampered-patch')},
    }),{status:409,code:'TARGET_MISMATCH'});
    assert.throws(()=>audit.consumeActionGrant({...consumeArgs,action:'remove-task'}),{status:409,code:'ACTION_MISMATCH'});
    assert.throws(()=>audit.consumeActionGrant({
      ...consumeArgs,
      destination:{kind:'remote-endpoint',endpoint:'https://api.example.com/v1'},
    }),{status:409,code:'DESTINATION_CHANGED'});
    assert.throws(()=>audit.consumeActionGrant({...consumeArgs,approvedRoots:[]}),{status:409,code:'SCOPE_CHANGED'});
    assert.throws(()=>audit.consumeActionGrant({...consumeArgs,permissions:['read-only-source']}),{status:409,code:'SCOPE_CHANGED'});
    assert.throws(()=>audit.consumeActionGrant({...consumeArgs,sourceHash:sha('other')}),{status:409,code:'SCOPE_CHANGED'});
    assert.throws(()=>audit.consumeActionGrant({...consumeArgs,projectRevision:GIT_REV_2}),{status:409,code:'PROJECT_REVISION_CHANGED'});

    // Missing field in consumeActionGrant fails closed.
    const incomplete={...consumeArgs};
    delete incomplete.target;
    assert.throws(()=>audit.consumeActionGrant(incomplete),{status:400,code:'INVALID_ACTION_TARGET'});

    // First consumption succeeds; second fails as one-time use and consumption table cannot be tampered.
    const consumed=audit.consumeActionGrant(consumeArgs);
    assert.equal(consumed.consumed,true);
    assert.throws(()=>audit.consumeActionGrant(consumeArgs),{status:409,code:'GRANT_ALREADY_USED'});
    assert.throws(()=>audit.revokeGrant(grant.grantId),{status:409,code:'GRANT_ALREADY_USED'});
    assert.throws(()=>db.prepare('DELETE FROM approval_action_consumptions WHERE grant_id=?').run(grant.grantId),/cannot be deleted/);
    assert.throws(()=>db.prepare('UPDATE approval_action_consumptions SET consumed_at_ms=0 WHERE grant_id=?').run(grant.grantId),/immutable/);

    // Symlink/deleted root between approval and use fails closed on consumeActionGrant.
    const toctouGrant=audit.issueActionGrant(validActionInput({
      projectId:project.id,
      approvedRoots:[repoSub],
    }));
    rmSync(repoSub,{recursive:true,force:true});
    let replacedWithJunction=false;
    try {
      symlinkSync(outsideTarget,repoSub,'junction');
      replacedWithJunction=true;
    } catch {
      replacedWithJunction=false;
    }
    assert.throws(()=>audit.consumeActionGrant(consumeArgsFromGrant(toctouGrant)),error=>{
      return error.status===409&&(replacedWithJunction?error.code==='APPROVED_ROOT_SYMLINK':error.code==='APPROVED_ROOT_MISSING');
    });
    if(replacedWithJunction) {
      rmSync(repoSub,{recursive:true,force:true});
    }
    mkdirSync(repoSub,{recursive:true});

    // Workspace lock (revokeSession) invalidates unconsumed action grants for that session.
    const lockGrant=audit.issueActionGrant(validActionInput({
      projectId:project.id,
      approvedRoots:[repoSub],
      sessionId:'session-to-lock',
    }));
    const lockRes=audit.revokeSession('session-to-lock');
    assert.equal(lockRes.revokedCount,1);
    assert.throws(()=>audit.consumeActionGrant(consumeArgsFromGrant(lockGrant)),{status:409,code:'GRANT_REVOKED'});

    // Expiry at 5 minutes (300_000 ms).
    const expGrant=audit.issueActionGrant(validActionInput({
      action:'export-artifact',
      projectId:project.id,
      approvedRoots:[repoSub],
    }));
    now+=300_000;
    assert.throws(()=>audit.consumeActionGrant(consumeArgsFromGrant(expGrant)),{status:409,code:'GRANT_EXPIRED'});

    // Explicit revocation before use.
    const revGrant=audit.issueActionGrant(validActionInput({
      action:'export-artifact',
      projectId:project.id,
      approvedRoots:[repoSub],
    }));
    audit.revokeGrant(revGrant.grantId,{reason:'user-denied'});
    assert.throws(()=>audit.consumeActionGrant(consumeArgsFromGrant(revGrant)),{status:409,code:'GRANT_REVOKED'});

    // Reject TTL > 5 minutes.
    assert.throws(()=>audit.issueActionGrant(validActionInput({
      projectId:project.id,
      approvedRoots:[repoSub],
      ttlMs:300_001,
    })),{status:400,code:'INVALID_ACTION_TTL'});
  } finally {
    db.close();
  }
});

test('crash reconciliation enforces verifiable controller ownership and positive worker evidence before release',t=>{
  const scratch=makeScratchDir(t);
  const dbPath=join(scratch,'crash.sqlite');
  let now=1_795_000_000_000;
  const {db,audit}=makeStores({clock:()=>now,dbPath});
  let preDispatch;
  let inDispatch;
  let preCrashLease;
  try {
    preCrashLease=audit.acquireControllerLease({
      controllerId:'controller-1',
      leaseToken:'pre-crash-secret-token-001',
    });
    preDispatch=audit.issueAttemptGrant(validAttemptInput());
    inDispatch=audit.issueAttemptGrant(validAttemptInput());
    audit.beginDispatch({
      grantId:inDispatch.grant.grantId,
      claimId:inDispatch.claim.claimId,
      currentScope:scopeFromGrant(inDispatch.grant),
      workerId:'worker-in-flight-1',
    });
  } finally {
    db.close();
  }

  // Simulated service restart.
  now+=1000;
  const db2=new DatabaseSync(dbPath);
  try {
    const restarted=new ApprovalAuditStore(db2,{clock:()=>now});
    const summary=restarted.reconcileInterrupted();
    assert.equal(summary.retrySafeCount,1);
    assert.equal(summary.unresolvedCount,1);

    // Neither crashed claim can dispatch after restart.
    assert.throws(()=>restarted.beginDispatch({
      grantId:preDispatch.grant.grantId,
      claimId:preDispatch.claim.claimId,
      currentScope:scopeFromGrant(preDispatch.grant),
    }),{status:409,code:'CLAIM_NOT_DISPATCHABLE'});
    assert.throws(()=>restarted.beginDispatch({
      grantId:inDispatch.grant.grantId,
      claimId:inDispatch.claim.claimId,
      currentScope:scopeFromGrant(inDispatch.grant),
    }),{status:409,code:'CLAIM_NOT_DISPATCHABLE'});

    // Retry-safe task can accept a fresh explicit approval; unresolved task is held.
    const freshForPre=restarted.issueAttemptGrant(validAttemptInput({taskId:preDispatch.grant.taskId}));
    assert.equal(freshForPre.claim.phase,'claimed');
    assert.throws(()=>restarted.issueAttemptGrant(validAttemptInput({taskId:inDispatch.grant.taskId})),
      {status:409,code:'UNRESOLVED_CLAIM_HOLD'});

    const stopEvidence={
      attemptId:inDispatch.grant.attemptId,
      workerId:'worker-in-flight-1',
      processExited:true,
      cleanup:'confirmed',
      exitCode:0,
      exitedAt:new Date(now).toISOString(),
    };

    // Pre-crash controller ownership or missing lease fails closed (claim stays crash-held).
    assert.throws(()=>restarted.resolveCrashHold({
      claimId:inDispatch.claim.claimId,
      resolution:'confirmed-stopped',
      ownership:{
        controllerId:preCrashLease.controllerId,
        ownerGeneration:preCrashLease.ownerGeneration,
        leaseToken:preCrashLease.leaseToken,
      },
      evidence:stopEvidence,
    }),{status:409,code:'UNVERIFIED_CONTROLLER_OWNERSHIP'});

    // Acquire new post-restart controller lease.
    const postLease=restarted.acquireControllerLease({
      controllerId:'controller-2',
      leaseToken:'post-crash-secret-token-002',
    });
    assert.equal(postLease.ownerGeneration,preCrashLease.ownerGeneration+1);

    // Incomplete, unknown-cleanup, mismatched-worker, or forged evidence fails closed and keeps hold unresolved.
    const badEvidenceCases=[
      {...stopEvidence,cleanup:'unknown'},
      {...stopEvidence,processExited:false},
      {...stopEvidence,workerId:'different-worker'},
      {...stopEvidence,attemptId:randomUUID()},
      {attemptId:inDispatch.grant.attemptId,workerId:'worker-in-flight-1',processExited:true,cleanup:'confirmed',exitedAt:new Date(now).toISOString()},
    ];
    for(const badEvidence of badEvidenceCases) {
      assert.throws(()=>restarted.resolveCrashHold({
        claimId:inDispatch.claim.claimId,
        resolution:'confirmed-stopped',
        ownership:postLease,
        evidence:badEvidence,
      }),{status:409,code:'INSUFFICIENT_RECOVERY_EVIDENCE'});
    }
    // Missing resolution fails without default.
    assert.throws(()=>restarted.resolveCrashHold({
      claimId:inDispatch.claim.claimId,
      ownership:postLease,
      evidence:stopEvidence,
    }),{status:400,code:'INVALID_RESOLUTION'});
    // Hold is still unresolved after rejected attempts.
    assert.throws(()=>restarted.issueAttemptGrant(validAttemptInput({taskId:inDispatch.grant.taskId})),
      {status:409,code:'UNRESOLVED_CLAIM_HOLD'});

    // Undispatched retry-safe claim cannot be resolved as confirmed-settled.
    assert.throws(()=>restarted.resolveCrashHold({
      claimId:preDispatch.claim.claimId,
      resolution:'confirmed-settled',
      ownership:postLease,
      evidence:{
        attemptId:preDispatch.grant.attemptId,
        settled:true,
        settlementOutcome:'succeeded',
        receiptDigest:sha('fake-receipt'),
        settledAt:new Date(now).toISOString(),
      },
    }),{status:409,code:'INSUFFICIENT_RECOVERY_EVIDENCE'});

    // Valid controller ownership + positive exit/cleanup evidence releases the hold.
    const resolved=restarted.resolveCrashHold({
      claimId:inDispatch.claim.claimId,
      resolution:'confirmed-stopped',
      ownership:postLease,
      evidence:stopEvidence,
    });
    assert.equal(resolved.phase,'aborted');
    assert.equal(resolved.outcome,'confirmed-stopped');
    const freshAfterResolve=restarted.issueAttemptGrant(validAttemptInput({taskId:inDispatch.grant.taskId}));
    assert.equal(freshAfterResolve.claim.phase,'claimed');

    // Dispatched claim can also settle via confirmed-settled when verified receipt evidence is provided.
    const dispatched2=restarted.issueAttemptGrant(validAttemptInput());
    restarted.beginDispatch({
      grantId:dispatched2.grant.grantId,
      claimId:dispatched2.claim.claimId,
      currentScope:scopeFromGrant(dispatched2.grant),
      workerId:'worker-settle-2',
    });
    const rec2=restarted.reconcileInterrupted();
    assert.equal(rec2.unresolvedCount,1);
    const postLease2=restarted.acquireControllerLease({
      controllerId:'controller-3',
      leaseToken:'post-crash-secret-token-003',
    });
    const settledHold=restarted.resolveCrashHold({
      claimId:dispatched2.claim.claimId,
      resolution:'confirmed-settled',
      ownership:postLease2,
      evidence:{
        attemptId:dispatched2.grant.attemptId,
        workerId:'worker-settle-2',
        settled:true,
        settlementOutcome:'succeeded',
        receiptDigest:sha('settlement-receipt-2'),
        settledAt:new Date(now).toISOString(),
      },
    });
    assert.equal(settledHold.phase,'settled');
    assert.equal(settledHold.outcome,'confirmed-settled');
  } finally {
    db2.close();
  }
});

test('malformed inputs, secret-bearing URLs, and legacy grant projections fail closed or preserve exact fields',()=>{
  const {db,audit}=makeStores();
  try {
    for(const badDest of [
      {kind:'unknown',endpoint:null},
      {kind:'remote-endpoint',endpoint:'https://user:SECRET_TOKEN_CANARY@api.example.com/v1'},
      {kind:'remote-endpoint',endpoint:'https://api.example.com/v1?apiKey=SECRET_TOKEN_CANARY'},
      {kind:'local-loopback',endpoint:'https://api.example.com/v1'},
    ]) {
      assert.throws(()=>audit.issueAttemptGrant(validAttemptInput({
        destination:badDest,
        permissions:['read-only-source','remote-data-egress'],
      })),error=>error.status===400&&!error.message.includes('SECRET_TOKEN_CANARY'));
    }

    assert.throws(()=>audit.issueAttemptGrant(validAttemptInput({
      destination:{kind:'remote-endpoint',endpoint:'https://api.example.com/v1'},
      permissions:['read-only-source'],
    })),{status:400,code:'MISSING_EGRESS_PERMISSION'});

    assert.throws(()=>audit.issueAttemptGrant(validAttemptInput({
      submission:{version:1,sourceHash:SRC_HASH,approve:true,model:'fixture'},
    })),{status:400,code:'MISSING_REQUEST_ID'});

    assert.throws(()=>audit.issueAttemptGrant(validAttemptInput({
      submission:{requestId:randomUUID(),version:1,sourceHash:SRC_HASH,approve:true,model:'fixture'},
    })),{status:400,code:'MISSING_ROUTE_REVISION'});

    // Legacy approval projection shows only fields actually recorded.
    const legacy=projectGrantRecord({
      grantId:'legacy-1',
      taskId:randomUUID(),
      taskVersion:2,
      sourceHash:SRC_HASH,
      model:'qwen3:1.7b',
    });
    assert.equal(legacy.grantId,'legacy-1');
    assert.equal(legacy.policyVersion,null);
    assert.equal(legacy.routeRevision,null);
    assert.equal(legacy.destination,null);
    assert.equal(legacy.expiresAt,null);
    assert.deepEqual(legacy.recordedFields,['grantId','taskId','taskVersion','sourceHash','model']);
  } finally {
    db.close();
  }
});

test('llamacpp fingerprint binding, tampered grants/claims, action grant replay/policy bump, and filesystem roots fail closed',t=>{
  const scratch=makeScratchDir(t);
  const projectDir=join(scratch,'repo-tamper');
  mkdirSync(projectDir);
  const {db,projects,audit}=makeStores();
  try {
    const {project}=projects.registerProject({label:'TamperRepo',root:projectDir,revision:GIT_REV});
    assert.throws(()=>resolveLocalRoot(parse(process.cwd()).root),{status:400,code:'PROJECT_ROOT_FILESYSTEM_ROOT'});
    assert.equal(audit.readGrant(randomUUID()),null);

    const fp=sha('llamacpp-fp');
    const llama=audit.issueAttemptGrant(validAttemptInput({
      projectId:project.id,
      approvedRoots:[projectDir],
      submission:{
        requestId:randomUUID(),
        version:1,
        sourceHash:SRC_HASH,
        approve:true,
        model:'qwen3.5:4b-q4_K_M',
        engine:'opencode',
        backend:'llamacpp',
        modelFingerprint:fp,
        routeRevision:ROUTE_REV,
      },
      destination:{kind:'local-loopback',endpoint:'http://127.0.0.1:8080'},
    }));
    assert.equal(llama.grant.modelFingerprint,fp);
    assert.equal(llama.grant.modelDigest,null);
    assert.throws(()=>audit.beginDispatch({
      grantId:llama.grant.grantId,
      claimId:llama.claim.claimId,
      currentScope:scopeFromGrant(llama.grant,{modelFingerprint:sha('other-fp')}),
    }),{status:409,code:'ROUTE_CHANGED'});
    assert.throws(()=>audit.resolveCrashHold({claimId:llama.claim.claimId,resolution:'confirmed-stopped'}),{status:409,code:'CLAIM_NOT_HELD'});
    assert.throws(()=>audit.resolveCrashHold({claimId:llama.claim.claimId,resolution:'bad'}),{status:400,code:'INVALID_RESOLUTION'});

    // Keyed action grant replay, conflict on changed session/target, and policy version invalidation.
    const requestId=randomUUID();
    const actionArgs=validActionInput({
      projectId:project.id,
      approvedRoots:[projectDir],
      requestId,
    });
    const g1=audit.issueActionGrant(actionArgs);
    const g2=audit.issueActionGrant(actionArgs);
    assert.equal(g1.grantId,g2.grantId);
    assert.throws(()=>audit.issueActionGrant({...actionArgs,action:'remove-task'}),{status:409,code:'SUBMISSION_CONFLICT'});
    assert.throws(()=>audit.issueActionGrant({...actionArgs,sessionId:'other-session'}),{status:409,code:'SUBMISSION_CONFLICT'});
    audit.setPolicyVersion('approval-policy-v2');
    assert.throws(()=>audit.consumeActionGrant(consumeArgsFromGrant(g1)),{status:409,code:'POLICY_CHANGED'});
    audit.setPolicyVersion(DEFAULT_POLICY_VERSION);

    // Tampered claim identity in SQLite fails closed with CLAIM_INTEGRITY_ERROR.
    db.exec('DROP TRIGGER approval_claims_immutable_identity');
    db.prepare('UPDATE approval_claims SET attempt_id=? WHERE claim_id=?').run(randomUUID(),llama.claim.claimId);
    assert.throws(()=>audit.readGrant(llama.grant.grantId),{status:409,code:'CLAIM_INTEGRITY_ERROR'});
    assert.throws(()=>audit.beginDispatch({
      grantId:llama.grant.grantId,
      claimId:llama.claim.claimId,
      currentScope:scopeFromGrant(llama.grant),
    }),{status:409,code:'CLAIM_INTEGRITY_ERROR'});

    // Tampered grant payload/metadata in SQLite triggers GRANT_INTEGRITY_ERROR even if triggers were bypassed.
    db.exec('DROP TRIGGER approval_grants_no_update');
    db.prepare('UPDATE approval_grants SET issued_at_ms=issued_at_ms-1000 WHERE grant_id=?').run(g1.grantId);
    assert.throws(()=>audit.readGrant(g1.grantId),{status:409,code:'GRANT_INTEGRITY_ERROR'});
    const tampered=JSON.stringify({...llama.grant,policyVersion:'tampered-v99'});
    db.prepare('UPDATE approval_grants SET payload=? WHERE grant_id=?').run(tampered,llama.grant.grantId);
    assert.throws(()=>audit.readGrant(llama.grant.grantId),{status:409,code:'GRANT_INTEGRITY_ERROR'});
    assert.throws(()=>audit.beginDispatch({
      grantId:llama.grant.grantId,
      claimId:llama.claim.claimId,
      currentScope:scopeFromGrant(llama.grant),
    }),{status:409,code:'GRANT_INTEGRITY_ERROR'});
  } finally {
    db.close();
  }
});
