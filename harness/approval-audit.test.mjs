import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,parse,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  DEFAULT_PROJECT_ID,
  WorkspaceProjects,
  resolveLocalRoot,
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
const GIT_REV='a'.repeat(40);

function makeScratchDir(t,prefix='pkg02-synthetic-') {
  const workRoot=resolve(fileURLToPath(new URL('../work/',import.meta.url)));
  mkdirSync(workRoot,{recursive:true});
  const dir=mkdtempSync(join(workRoot,prefix));
  t.after(()=>{rmSync(dir,{recursive:true,force:true});});
  return dir;
}

function makeStores({clock=()=>1_795_000_000_000,policyVersion=DEFAULT_POLICY_VERSION,dbPath=':memory:'}={}) {
  const db=new DatabaseSync(dbPath);
  const projects=new WorkspaceProjects(db,{clock});
  const audit=new ApprovalAuditStore(db,{clock,policyVersion});
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

test('workspace projects register disposable local roots, associate legacy tasks, and reject unsafe roots',t=>{
  const scratch=makeScratchDir(t);
  const projectDir=join(scratch,'repo-alpha');
  const filePath=join(scratch,'not-a-dir.txt');
  const linkPath=join(scratch,'repo-link');
  mkdirSync(projectDir);
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

    const nextRev='b'.repeat(40);
    now+=1000;
    const updated=projects.updateRevision(created.project.id,nextRev);
    assert.equal(updated.revision,nextRev);

    const boundTask=projects.associateTask({id:randomUUID(),projectId:created.project.id});
    assert.equal(boundTask.projectId,created.project.id);

    // Reject invalid roots and payloads.
    for(const badRoot of ['relative/dir',join(scratch,'missing'),filePath,'','C:\\\u0000bad']) {
      assert.throws(()=>projects.registerProject({label:'Bad',root:badRoot}),{status:400});
    }
    if(symlinkCreated) {
      assert.throws(()=>projects.registerProject({label:'Symlink',root:linkPath}),{status:400,code:'PROJECT_ROOT_SYMLINK'});
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
    assert.equal(list.projects[1].revision,'b'.repeat(40));
  } finally {
    db2.close();
  }
});

test('attempt grant records immutable scope fields, enforces SQLite immutability, and replays idempotently',t=>{
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
    assert.equal(issued.grant.sourceHash,SRC_HASH);
    assert.equal(issued.grant.routeRevision,ROUTE_REV);
    assert.equal(issued.grant.policyVersion,DEFAULT_POLICY_VERSION);
    assert.equal(issued.grant.issuedAt,new Date(now).toISOString());
    assert.equal(issued.grant.expiresAt,new Date(now+ACTION_GRANT_TTL_MS).toISOString());
    assert.equal(issued.claim.phase,'claimed');
    assert.ok(Object.isFrozen(issued.grant));

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

    // SQLite triggers block UPDATE and DELETE on immutable grant and audit tables.
    assert.throws(()=>db.prepare('UPDATE approval_grants SET policy_version=? WHERE grant_id=?').run('v2',issued.grant.grantId),/immutable/);
    assert.throws(()=>db.prepare('DELETE FROM approval_grants WHERE grant_id=?').run(issued.grant.grantId),/cannot be deleted/);
    assert.throws(()=>db.prepare('UPDATE approval_audit_log SET event_type=? WHERE grant_id=?').run('tamper',issued.grant.grantId),/append-only/);
    assert.throws(()=>db.prepare('DELETE FROM approval_audit_log WHERE grant_id=?').run(issued.grant.grantId),/append-only/);

    const log=audit.listAuditLog(issued.grant.grantId);
    assert.equal(log.length,1);
    assert.equal(log[0].eventType,'grant.issued_and_claimed');
  } finally {
    db.close();
  }
});

test('two-tab approval races and multi-connection SQLite dispatch at most once',async t=>{
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

    // Tab A wins the claim; Tab B with a different requestId is blocked.
    const tabAResult=auditA.issueAttemptGrant(firstInput);
    assert.equal(tabAResult.replayed,false);
    assert.throws(()=>auditB.issueAttemptGrant(tabBInput),{status:409,code:'CLAIM_CONFLICT'});

    // Two tabs racing to dispatch the same grant/claim: exactly one succeeds.
    let workerDispatches=0;
    let billingReservations=0;
    const scope=scopeFromGrant(tabAResult.grant);
    const attemptDispatch=store=>{
      const res=store.beginDispatch({
        grantId:tabAResult.grant.grantId,
        claimId:tabAResult.claim.claimId,
        currentScope:scope,
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

test('expired, revoked, and changed-scope attempt grants reject dispatch without touching worker or billing state',()=>{
  let now=1_795_000_000_000;
  const {db,audit}=makeStores({clock:()=>now});
  try {
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

    // 2. Clock skew (future-dated grant) fails closed.
    const futureCase=audit.issueAttemptGrant(validAttemptInput());
    now-=1;
    assert.throws(()=>tryDispatch(futureCase.grant,futureCase.claim),{status:409,code:'GRANT_NOT_YET_VALID'});
    now+=1;
    // Clean up futureCase by revoking it before reusing/testing revocation.
    assert.equal(audit.revokeGrant(futureCase.grant.grantId,{reason:'operator-cancelled'}).revoked,true);
    assert.equal(audit.revokeGrant(futureCase.grant.grantId).duplicate,true);
    assert.throws(()=>tryDispatch(futureCase.grant,futureCase.claim),{status:409,code:'GRANT_REVOKED'});

    // 3. Changed scope, route, destination, permissions, roots, testPlan, and policy fail closed.
    const scopeCase=audit.issueAttemptGrant(validAttemptInput({approvedRoots:['C:\\synthetic\\a']}));
    const changes=[
      [{taskVersion:scopeCase.grant.taskVersion+1},'SCOPE_CHANGED'],
      [{sourceHash:sha('changed-source')},'SCOPE_CHANGED'],
      [{routeRevision:sha('changed-route')},'ROUTE_CHANGED'],
      [{model:'different-model'},'ROUTE_CHANGED'],
      [{destination:{kind:'remote-endpoint',endpoint:'https://api.example.com/v1'}},'DESTINATION_CHANGED'],
      [{accountRef:'other-account'},'SCOPE_CHANGED'],
      [{approvedRoots:['C:\\synthetic\\b']},'SCOPE_CHANGED'],
      [{permissions:['read-only-source','repository-write']},'SCOPE_CHANGED'],
      [{testPlan:{kind:'change',checks:['Changed check'],filename:'sample.js',expected:'return true;'}},'SCOPE_CHANGED'],
    ];
    for(const [override,code] of changes) {
      assert.throws(()=>tryDispatch(scopeCase.grant,scopeCase.claim,override),{status:409,code});
    }
    audit.setPolicyVersion('approval-policy-v2');
    assert.throws(()=>tryDispatch(scopeCase.grant,scopeCase.claim),{status:409,code:'POLICY_CHANGED'});
    assert.equal(workerDispatches,0);
    assert.equal(billingCharges,0);

    // Superseded expired/revoked pre-dispatch claim does not block a fresh approved attempt on the same task.
    const fresh=audit.issueAttemptGrant(validAttemptInput({taskId:expCase.grant.taskId}));
    const dispatched=tryDispatch(fresh.grant,fresh.claim);
    assert.equal(dispatched.dispatched,true);
    assert.equal(workerDispatches,1);
    assert.equal(billingCharges,1);
    assert.throws(()=>audit.revokeGrant(fresh.grant.grantId),{status:409,code:'ALREADY_DISPATCHED'});
  } finally {
    db.close();
  }
});

test('5-minute single-use action grants enforce one-time use, expiry, revocation, and exact binding',()=>{
  let now=1_795_000_000_000;
  const {db,audit}=makeStores({clock:()=>now});
  try {
    const taskId=randomUUID();
    const destination={kind:'local-workspace',endpoint:null};
    const grant=audit.issueActionGrant({
      action:'apply-patch',
      destination,
      taskId,
      taskVersion:3,
      sourceHash:SRC_HASH,
      routeRevision:ROUTE_REV,
      accountRef:'owner-local',
      approvedRoots:['C:\\synthetic\\repo'],
      permissions:['read-only-source','repository-write'],
      requestId:randomUUID(),
    });
    assert.equal(grant.expiresAt,new Date(now+300_000).toISOString());

    const consumeArgs={
      grantId:grant.grantId,
      action:'apply-patch',
      destination,
      taskId,
      taskVersion:3,
      sourceHash:SRC_HASH,
      routeRevision:ROUTE_REV,
      accountRef:'owner-local',
      approvedRoots:['C:\\synthetic\\repo'],
      permissions:['read-only-source','repository-write'],
    };

    // Changed action, destination, roots, permissions, or source fail without consuming the grant.
    assert.throws(()=>audit.consumeActionGrant({...consumeArgs,action:'remove-task'}),{status:409,code:'ACTION_MISMATCH'});
    assert.throws(()=>audit.consumeActionGrant({
      ...consumeArgs,
      destination:{kind:'remote-endpoint',endpoint:'https://api.example.com/v1'},
    }),{status:409,code:'DESTINATION_CHANGED'});
    assert.throws(()=>audit.consumeActionGrant({...consumeArgs,approvedRoots:[]}),{status:409,code:'SCOPE_CHANGED'});
    assert.throws(()=>audit.consumeActionGrant({...consumeArgs,permissions:['read-only-source']}),{status:409,code:'SCOPE_CHANGED'});
    assert.throws(()=>audit.consumeActionGrant({...consumeArgs,sourceHash:sha('other')}),{status:409,code:'SCOPE_CHANGED'});

    // First consumption succeeds; second fails as one-time use.
    const consumed=audit.consumeActionGrant(consumeArgs);
    assert.equal(consumed.consumed,true);
    assert.throws(()=>audit.consumeActionGrant(consumeArgs),{status:409,code:'GRANT_ALREADY_USED'});
    assert.throws(()=>audit.revokeGrant(grant.grantId),{status:409,code:'GRANT_ALREADY_USED'});

    // Expiry at 5 minutes (300_000 ms).
    const expGrant=audit.issueActionGrant({action:'export-artifact',destination});
    now+=300_000;
    assert.throws(()=>audit.consumeActionGrant({
      grantId:expGrant.grantId,
      action:'export-artifact',
      destination,
    }),{status:409,code:'GRANT_EXPIRED'});

    // Revocation before use.
    const revGrant=audit.issueActionGrant({action:'export-artifact',destination});
    audit.revokeGrant(revGrant.grantId,{reason:'user-denied'});
    assert.throws(()=>audit.consumeActionGrant({
      grantId:revGrant.grantId,
      action:'export-artifact',
      destination,
    }),{status:409,code:'GRANT_REVOKED'});

    // Reject TTL > 5 minutes.
    assert.throws(()=>audit.issueActionGrant({
      action:'apply-patch',
      destination,
      ttlMs:300_001,
    }),{status:400,code:'INVALID_ACTION_TTL'});
  } finally {
    db.close();
  }
});

test('crash reconciliation holds claimed as retry-safe and dispatching as unresolved across restart',t=>{
  const scratch=makeScratchDir(t);
  const dbPath=join(scratch,'crash.sqlite');
  const now=1_795_000_000_000;
  const {db,audit}=makeStores({clock:()=>now,dbPath});
  let preDispatch;
  let inDispatch;
  try {
    preDispatch=audit.issueAttemptGrant(validAttemptInput());
    inDispatch=audit.issueAttemptGrant(validAttemptInput());
    audit.beginDispatch({
      grantId:inDispatch.grant.grantId,
      claimId:inDispatch.claim.claimId,
      currentScope:scopeFromGrant(inDispatch.grant),
    });
  } finally {
    db.close();
  }

  // Simulated service restart.
  const db2=new DatabaseSync(dbPath);
  try {
    const restarted=new ApprovalAuditStore(db2,{clock:()=>now+1000});
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

    // Retry-safe task can accept a fresh explicit approval; unresolved task is held until reconciled.
    const freshForPre=restarted.issueAttemptGrant(validAttemptInput({taskId:preDispatch.grant.taskId}));
    assert.equal(freshForPre.claim.phase,'claimed');
    assert.throws(()=>restarted.issueAttemptGrant(validAttemptInput({taskId:inDispatch.grant.taskId})),
      {status:409,code:'UNRESOLVED_CLAIM_HOLD'});

    const resolved=restarted.resolveCrashHold({claimId:inDispatch.claim.claimId,resolution:'confirmed-stopped'});
    assert.equal(resolved.phase,'aborted');
    const freshAfterResolve=restarted.issueAttemptGrant(validAttemptInput({taskId:inDispatch.grant.taskId}));
    assert.equal(freshAfterResolve.claim.phase,'claimed');
  } finally {
    db2.close();
  }
});

test('malformed inputs, secret-bearing URLs, and legacy grant projections fail closed or preserve exact fields',()=>{
  const {db,audit}=makeStores();
  try {
    // Credential-bearing, query-bearing, unknown, and unpermitted remote destinations fail closed without leaking secrets.
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

test('llamacpp fingerprint binding, tampered grants, action grant replay/policy bump, and filesystem roots fail closed',()=>{
  const {db,audit}=makeStores();
  try {
    assert.throws(()=>resolveLocalRoot(parse(process.cwd()).root),{status:400,code:'PROJECT_ROOT_FILESYSTEM_ROOT'});
    assert.equal(audit.readGrant(randomUUID()),null);

    const fp=sha('llamacpp-fp');
    const llama=audit.issueAttemptGrant(validAttemptInput({
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
    assert.throws(()=>audit.resolveCrashHold({claimId:llama.claim.claimId}),{status:409,code:'CLAIM_NOT_HELD'});
    assert.throws(()=>audit.resolveCrashHold({claimId:llama.claim.claimId,resolution:'bad'}),{status:400,code:'INVALID_RESOLUTION'});

    // Keyed action grant replay and policy version invalidation.
    const taskId=randomUUID();
    const requestId=randomUUID();
    const destination={kind:'local-workspace',endpoint:null};
    const g1=audit.issueActionGrant({action:'apply-patch',destination,taskId,requestId});
    const g2=audit.issueActionGrant({action:'apply-patch',destination,taskId,requestId});
    assert.equal(g1.grantId,g2.grantId);
    assert.throws(()=>audit.issueActionGrant({action:'remove-task',destination,taskId,requestId}),
      {status:409,code:'SUBMISSION_CONFLICT'});
    audit.setPolicyVersion('approval-policy-v2');
    assert.throws(()=>audit.consumeActionGrant({grantId:g1.grantId,action:'apply-patch',destination,taskId}),
      {status:409,code:'POLICY_CHANGED'});

    // Tampered payload in SQLite triggers GRANT_INTEGRITY_ERROR even if triggers were bypassed.
    db.exec('DROP TRIGGER approval_grants_no_update');
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

