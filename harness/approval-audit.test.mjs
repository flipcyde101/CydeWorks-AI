import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,mkdtempSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,parse,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Worker} from 'node:worker_threads';
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
const TARGET_PAYLOAD_V1='diff --git a/app.js b/app.js\n+return true;\n';
const TARGET_DIGEST=sha(TARGET_PAYLOAD_V1);
const GIT_REV='a'.repeat(40);
const GIT_REV_2='b'.repeat(40);
const AUDIT_MODULE_URL=pathToFileURL(fileURLToPath(new URL('./approval-audit.mjs',import.meta.url))).href;

function makeScratchDir(t,prefix='pkg02-synthetic-') {
  const workRoot=resolve(fileURLToPath(new URL('../work/',import.meta.url)));
  mkdirSync(workRoot,{recursive:true});
  const dir=mkdtempSync(join(workRoot,prefix));
  t.after(()=>{rmSync(dir,{recursive:true,force:true});});
  return dir;
}

/**
 * Independent synthetic host state for testing ApprovalAuditStore without reconstructing
 * dispatch scopes from grants or trusting caller-supplied worker/receipt assertions.
 */
function makeHostHarness({clock=()=>1_795_000_000_000}={}) {
  const serverTasks=new Map();
  const serverActions=new Map();
  const scopeRequests=[];
  const artifacts=new Map([['patch:patch-1',TARGET_PAYLOAD_V1]]);
  const workers=new Map();
  const receipts=new Map();
  const stoppedControllers=new Map();
  const lockedSessions=new Set();

  const scopeResolver=request=>{
    scopeRequests.push(request);
    const {taskId,grantKind,action}=request;
    if(grantKind==='action') {
      const pending=serverActions.get(`${taskId}:${action}`);
      return pending?{...pending}:null;
    }
    const state=serverTasks.get(taskId);
    if(!state)return null;
    return {
      taskId:state.taskId,
      taskVersion:state.taskVersion,
      projectId:state.projectId,
      projectRevision:state.projectRevision,
      sourceHash:state.sourceHash,
      routeRevision:state.routeRevision,
      model:state.model,
      engine:state.engine,
      backend:state.backend,
      modelDigest:state.modelDigest,
      modelFingerprint:state.modelFingerprint,
      destination:state.destination,
      accountRef:state.accountRef,
      approvedRoots:state.approvedRoots,
      permissions:state.permissions,
      testPlan:state.testPlan,
    };
  };

  const hostVerifiers={
    verifyControllerStopped({controllerId,ownerGeneration}) {
      const key=`${controllerId}:${ownerGeneration}`;
      const rec=stoppedControllers.get(key);
      if(!rec)return {stopped:false,controllerId,ownerGeneration};
      return rec;
    },
    verifyWorkerStopped({attemptId,workerId}) {
      const rec=workers.get(attemptId);
      if(!rec)return {stopped:false,cleanupConfirmed:false};
      if(workerId!==null&&rec.workerId!==workerId)return {stopped:false,cleanupConfirmed:false};
      return rec;
    },
    verifySettlementReceipt({attemptId}) {
      return receipts.get(attemptId)??{settled:false};
    },
    resolveTargetDigest({target}) {
      const key=`${target.kind}:${target.id}`;
      if(!artifacts.has(key))return null;
      return {digest:sha(artifacts.get(key))};
    },
    verifySession({sessionId}) {
      return {active:!lockedSessions.has(sessionId)};
    },
  };

  const registerTaskScope=(taskId,scope)=>{
    serverTasks.set(taskId,{taskId,...scope});
  };
  const updateTaskScope=(taskId,patch)=>{
    const prev=serverTasks.get(taskId);
    if(!prev)throw Error('Missing synthetic server task '+taskId);
    serverTasks.set(taskId,{...prev,...patch});
  };
  const registerActionScope=(taskId,action,scope)=>{
    serverActions.set(`${taskId}:${action}`,{taskId,action,...scope});
  };
  const updateActionScope=(taskId,action,patch)=>{
    const key=`${taskId}:${action}`;
    const prev=serverActions.get(key);
    if(!prev)throw Error('Missing synthetic server action '+key);
    serverActions.set(key,{...prev,...patch});
  };
  const setArtifact=(kind,id,content)=>{
    artifacts.set(`${kind}:${id}`,content);
  };
  const setWorkerState=(attemptId,state)=>{
    workers.set(attemptId,state);
  };
  const setReceipt=(attemptId,receipt)=>{
    receipts.set(attemptId,receipt);
  };
  const markControllerStopped=(controllerId,ownerGeneration)=>{
    stoppedControllers.set(`${controllerId}:${ownerGeneration}`,{
      stopped:true,
      controllerId,
      ownerGeneration,
      stoppedAt:new Date(clock()).toISOString(),
    });
  };

  return {
    serverTasks,
    serverActions,
    scopeRequests,
    registerActionScope,
    updateActionScope,
    artifacts,
    workers,
    receipts,
    lockedSessions,
    scopeResolver,
    hostVerifiers,
    registerTaskScope,
    updateTaskScope,
    setArtifact,
    setWorkerState,
    setReceipt,
    markControllerStopped,
  };
}

function makeStores({
  clock=()=>1_795_000_000_000,
  policyVersion=DEFAULT_POLICY_VERSION,
  dbPath=':memory:',
  defaultRoot=null,
  disconnected=false,
  host=null,
}={}) {
  const db=new DatabaseSync(dbPath);
  const projects=new WorkspaceProjects(db,{clock,defaultRoot});
  const activeHost=disconnected?null:(host??makeHostHarness({clock}));
  const audit=new ApprovalAuditStore(db,{
    clock,
    policyVersion,
    projects,
    scopeResolver:activeHost?.scopeResolver??null,
    hostVerifiers:activeHost?.hostVerifiers??null,
  });
  return {db,projects,audit,host:activeHost};
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

function registerScopeFromInput(host,projects,input) {
  const project=projects.requireProject(input.projectId);
  const engine=input.submission.engine??(input.submission.model==='fixture'?'fixture':'ollama');
  const backend=input.submission.backend??(engine==='fixture'?'fixture':'ollama');
  host.registerTaskScope(input.taskId,{
    taskVersion:input.submission.version,
    projectId:input.projectId,
    projectRevision:project.revision,
    sourceHash:input.submission.sourceHash,
    routeRevision:input.submission.routeRevision,
    model:input.submission.model,
    engine,
    backend,
    modelDigest:input.submission.modelDigest??null,
    modelFingerprint:input.submission.modelFingerprint??null,
    destination:input.destination,
    accountRef:input.accountRef??null,
    approvedRoots:input.approvedRoots,
    permissions:input.permissions,
    testPlan:input.testPlan,
  });
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

// Records the synthetic server's own pending-action state from the inputs shown at approval,
// independently of the stored grant.
function registerActionScopeFromInput(host,projects,input) {
  const project=projects.requireProject(input.projectId);
  host.registerActionScope(input.taskId,input.action,{
    taskVersion:input.taskVersion,
    projectId:input.projectId,
    projectRevision:project.revision,
    sourceHash:input.sourceHash,
    routeRevision:input.routeRevision,
    target:{kind:input.target.kind,id:input.target.id},
    destination:input.destination,
    accountRef:input.accountRef,
    approvedRoots:input.approvedRoots,
    permissions:input.permissions,
  });
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

test('workspace projects register disposable local roots, capture dev/ino, associate legacy tasks, and reject unsafe/network paths pre-FS',t=>{
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
    assert.ok(created.project.rootDev&&created.project.rootIno);
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

  const db2=new DatabaseSync(dbPath);
  try {
    const reopened=new WorkspaceProjects(db2);
    const list=reopened.listProjects();
    assert.equal(list.projects.length,2);
    assert.equal(list.projects[1].label,'Alpha Synthetic');
    assert.equal(list.projects[1].revision,GIT_REV_2);
    assert.ok(list.projects[1].rootIno);
  } finally {
    db2.close();
  }
});

test('disconnected ApprovalAuditStore retains fail-closed holds instead of trusting caller scopes, flags, or raw digests',t=>{
  const scratch=makeScratchDir(t);
  const projectDir=join(scratch,'repo-disconnected');
  mkdirSync(projectDir);
  let now=1_795_000_000_000;
  const {db,projects,audit}=makeStores({clock:()=>now,disconnected:true});
  try {
    const {project}=projects.registerProject({label:'DisconnectedRepo',root:projectDir,revision:GIT_REV});
    const lease=audit.acquireControllerLease({
      controllerId:'ctrl-disconnected',
      leaseToken:'disconnected-lease-token-001',
    });
    const input=validAttemptInput({
      projectId:project.id,
      approvedRoots:[projectDir],
    });
    const issued=audit.issueAttemptGrant(input);

    // Even if caller passes a complete currentScope object, disconnected beginDispatch holds closed.
    assert.throws(()=>audit.beginDispatch({
      grantId:issued.grant.grantId,
      claimId:issued.claim.claimId,
      ownership:lease,
      currentScope:{
        taskId:issued.grant.taskId,
        taskVersion:issued.grant.taskVersion,
        projectId:issued.grant.projectId,
        projectRevision:issued.grant.projectRevision,
        sourceHash:issued.grant.sourceHash,
        routeRevision:issued.grant.routeRevision,
        model:issued.grant.model,
        engine:issued.grant.engine,
        backend:issued.grant.backend,
        modelDigest:issued.grant.modelDigest,
        modelFingerprint:issued.grant.modelFingerprint,
        destination:issued.grant.destination,
        accountRef:issued.grant.accountRef,
        approvedRoots:issued.grant.approvedRoots,
        permissions:issued.grant.permissions,
        testPlan:issued.grant.testPlan,
      },
    }),{status:409,code:'UNVERIFIED_DISPATCH_SCOPE'});

    // Disconnected action grant issuance fails closed without trusted host artifact digest resolution.
    assert.throws(()=>audit.issueActionGrant(validActionInput({
      projectId:project.id,
      approvedRoots:[projectDir],
    })),{status:409,code:'UNVERIFIED_ACTION_TARGET'});

    // Disconnected crash-hold release fails closed even with caller-supplied exit flags or raw receipt digest.
    const rec=audit.reconcileInterrupted({ownership:lease});
    assert.equal(rec.retrySafeCount,1);
    assert.throws(()=>audit.resolveCrashHold({
      claimId:issued.claim.claimId,
      resolution:'confirmed-stopped',
      ownership:lease,
      evidence:{
        attemptId:issued.grant.attemptId,
        workerId:'forged-worker',
        processExited:true,
        cleanup:'confirmed',
        exitCode:0,
        exitedAt:new Date(now).toISOString(),
      },
    }),{status:409,code:'UNVERIFIED_WORKER_STOP'});
    assert.equal(audit.readGrant(issued.grant.grantId).claim.phase,'crash-held');
  } finally {
    db.close();
  }
});

test('attempt grant binds registered project, root identities, enforces SQLite immutability, and replays idempotently',t=>{
  const scratch=makeScratchDir(t);
  const projectDir=join(scratch,'repo-beta');
  mkdirSync(projectDir);
  writeFileSync(join(projectDir,'index.js'),'export const v = 1;\n');
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
    assert.equal(issued.grant.rootIdentities.length,1);
    assert.ok(issued.grant.rootIdentities[0].ino);
    assert.match(issued.grant.rootIdentities[0].treeDigest,/^[a-f0-9]{64}$/);
    assert.ok(issued.grant.projectRootIdentity);
    assert.equal(issued.claim.phase,'claimed');
    assert.ok(Object.isFrozen(issued.grant));

    assert.throws(()=>audit.issueAttemptGrant(validAttemptInput({projectId:'missing-project'})),{status:404,code:'PROJECT_NOT_FOUND'});
    assert.throws(()=>audit.issueAttemptGrant(validAttemptInput({
      projectId:DEFAULT_PROJECT_ID,
      approvedRoots:[projectDir],
    })),{status:400,code:'APPROVED_ROOT_OUTSIDE_PROJECT'});

    const replayed=audit.issueAttemptGrant(input);
    assert.equal(replayed.replayed,true);
    assert.equal(replayed.grant.grantId,issued.grant.grantId);
    assert.equal(replayed.claim.claimId,issued.claim.claimId);

    assert.throws(()=>audit.issueAttemptGrant({
      ...input,
      submission:{...input.submission,sourceHash:sha('tampered')},
    }),{status:409,code:'SUBMISSION_CONFLICT'});
    assert.throws(()=>audit.issueAttemptGrant({
      ...input,
      destination:{kind:'remote-endpoint',endpoint:'https://api.example.com/v1'},
      permissions:['read-only-source','remote-data-egress'],
    }),{status:409,code:'SUBMISSION_CONFLICT'});

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

test('overlapping multi-connection SQLite worker_threads race dispatches and bills at most once',async t=>{
  const scratch=makeScratchDir(t);
  const dbPath=join(scratch,'concurrent-race.sqlite');
  const now=1_795_000_000_000;
  const {db,projects,audit,host}=makeStores({clock:()=>now,dbPath});
  let issued;
  let lease;
  let taskScope;
  try {
    db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS test_billing_reservations (
        grant_id TEXT PRIMARY KEY,
        worker_thread INTEGER NOT NULL,
        reserved_at_ms INTEGER NOT NULL
      );
    `);
    lease=audit.acquireControllerLease({
      controllerId:'controller-race-1',
      leaseToken:'race-controller-token-0001',
    });
    const input=validAttemptInput();
    registerScopeFromInput(host,projects,input);
    taskScope=host.serverTasks.get(input.taskId);
    issued=audit.issueAttemptGrant(input);

    // Two-tab approval race across two SQLite connections for the same task.
    const dbTab2=new DatabaseSync(dbPath);
    try {
      const auditTab2=new ApprovalAuditStore(dbTab2,{clock:()=>now});
      const tab2Input=validAttemptInput({
        taskId:input.taskId,
        submission:validSubmission({requestId:randomUUID()}),
      });
      assert.throws(()=>auditTab2.issueAttemptGrant(tab2Input),{status:409,code:'CLAIM_CONFLICT'});
    } finally {
      dbTab2.close();
    }
  } finally {
    db.close();
  }

  // Launch 2 worker threads synchronized on a SharedArrayBuffer barrier so both open independent
  // SQLite connections and execute beginDispatch + billing reservation at the exact same instant.
  const sab=new SharedArrayBuffer(8);
  const barrier=new Int32Array(sab);
  const workerScript=`
    import { workerData, parentPort } from 'node:worker_threads';
    import { DatabaseSync } from 'node:sqlite';
    const { ApprovalAuditStore } = await import(workerData.auditModuleUrl);
    const db = new DatabaseSync(workerData.dbPath);
    const audit = new ApprovalAuditStore(db, {
      clock: () => workerData.now,
      scopeResolver: ({ taskId }) => taskId === workerData.taskScope.taskId ? workerData.taskScope : null,
    });
    Atomics.add(workerData.barrier, 0, 1);
    while (Atomics.load(workerData.barrier, 1) === 0) {
      Atomics.wait(workerData.barrier, 1, 0, 5);
    }
    let message;
    try {
      const res = audit.beginDispatch({
        grantId: workerData.grantId,
        claimId: workerData.claimId,
        ownership: workerData.lease,
        workerId: 'worker-thread-' + workerData.idx,
      });
      db.prepare('INSERT INTO test_billing_reservations (grant_id, worker_thread, reserved_at_ms) VALUES (?, ?, ?)')
        .run(workerData.grantId, workerData.idx, workerData.now);
      message = { ok: true, idx: workerData.idx, dispatchId: res.dispatch.dispatchId };
    } catch (error) {
      message = { ok: false, idx: workerData.idx, code: error.code, status: error.status, message: error.message };
    } finally {
      db.close();
    }
    parentPort.postMessage(message);
  `;

  const runWorker=idx=>new Promise((resolvePromise,rejectPromise)=>{
    const w=new Worker(workerScript,{
      eval:true,
      workerData:{
        idx,
        dbPath,
        now,
        grantId:issued.grant.grantId,
        claimId:issued.claim.claimId,
        lease,
        taskScope,
        auditModuleUrl:AUDIT_MODULE_URL,
        barrier,
      },
    });
    let result;
    w.on('message',msg=>{ result=msg; });
    w.on('error',err=>rejectPromise(err));
    w.on('exit',()=>resolvePromise(result));
  });

  const p0=runWorker(0);
  const p1=runWorker(1);
  while(Atomics.load(barrier,0)<2) {
    await new Promise(r=>setTimeout(r,2));
  }
  Atomics.store(barrier,1,1);
  Atomics.notify(barrier,1);

  const results=await Promise.all([p0,p1]);
  const winners=results.filter(r=>r.ok);
  const losers=results.filter(r=>!r.ok);
  assert.equal(winners.length,1);
  assert.equal(losers.length,1);
  assert.ok(['ALREADY_DISPATCHED','CLAIM_NOT_DISPATCHABLE'].includes(losers[0].code));

  const verifyDb=new DatabaseSync(dbPath);
  verifyDb.exec('PRAGMA busy_timeout=5000;');
  try {
    const dispatchCount=verifyDb.prepare('SELECT COUNT(*) AS c FROM approval_dispatches WHERE grant_id=?').get(issued.grant.grantId).c;
    const billingCount=verifyDb.prepare('SELECT COUNT(*) AS c FROM test_billing_reservations WHERE grant_id=?').get(issued.grant.grantId).c;
    const auditCount=verifyDb.prepare("SELECT COUNT(*) AS c FROM approval_audit_log WHERE grant_id=? AND event_type='claim.dispatching'").get(issued.grant.grantId).c;
    assert.equal(dispatchCount,1);
    assert.equal(billingCount,1);
    assert.equal(auditCount,1);

    const verifyAudit=new ApprovalAuditStore(verifyDb,{clock:()=>now});
    const settled=verifyAudit.completeDispatch({
      grantId:issued.grant.grantId,
      claimId:issued.claim.claimId,
      ownership:lease,
      outcome:'succeeded',
    });
    assert.equal(settled.duplicate,false);
    assert.equal(settled.claim.phase,'settled');
    assert.equal(verifyAudit.completeDispatch({
      grantId:issued.grant.grantId,
      claimId:issued.claim.claimId,
      ownership:lease,
      outcome:'succeeded',
    }).duplicate,true);
    assert.throws(()=>verifyAudit.completeDispatch({
      grantId:issued.grant.grantId,
      claimId:issued.claim.claimId,
      ownership:lease,
      outcome:'failed',
    }),{status:409,code:'SETTLEMENT_CONFLICT'});
  } finally {
    verifyDb.close();
  }
});

test('server-derived scope drift, same-path ordinary directory replacement, content mutation, expiry, and revocation reject dispatch',t=>{
  const scratch=makeScratchDir(t);
  const projectDir=join(scratch,'repo-scope');
  const rootA=join(projectDir,'pkg-a');
  const rootB=join(projectDir,'pkg-b');
  mkdirSync(rootA,{recursive:true});
  mkdirSync(rootB,{recursive:true});
  writeFileSync(join(rootA,'sample.js'),'export const ok = true;\n');

  let now=1_795_000_000_000;
  const {db,projects,audit,host}=makeStores({clock:()=>now});
  try {
    const lease=audit.acquireControllerLease({
      controllerId:'controller-scope-1',
      leaseToken:'scope-controller-token-001',
    });
    const {project}=projects.registerProject({label:'ScopeRepo',root:projectDir,revision:GIT_REV});
    let billingCount=0;
    const tryDispatch=(grant,claim,extra={})=>{
      const result=audit.beginDispatch({
        grantId:grant.grantId,
        claimId:claim.claimId,
        ownership:lease,
        ...extra,
      });
      billingCount++;
      return result;
    };

    // 1. Expiry at exact millisecond boundary.
    const expInput=validAttemptInput({ttlMs:60_000});
    registerScopeFromInput(host,projects,expInput);
    const expCase=audit.issueAttemptGrant(expInput);
    now+=60_000;
    assert.throws(()=>tryDispatch(expCase.grant,expCase.claim),{status:409,code:'GRANT_EXPIRED'});
    assert.equal(billingCount,0);

    // 2. Clock skew and explicit grant revocation fail closed.
    const futureInput=validAttemptInput();
    registerScopeFromInput(host,projects,futureInput);
    const futureCase=audit.issueAttemptGrant(futureInput);
    now-=1;
    assert.throws(()=>tryDispatch(futureCase.grant,futureCase.claim),{status:409,code:'GRANT_NOT_YET_VALID'});
    now+=1;
    assert.equal(audit.revokeGrant(futureCase.grant.grantId,{reason:'operator-cancelled'}).revoked,true);
    assert.equal(audit.revokeGrant(futureCase.grant.grantId).duplicate,true);
    assert.throws(()=>db.prepare('DELETE FROM approval_grant_revocations WHERE grant_id=?').run(futureCase.grant.grantId),/cannot be deleted/);
    assert.throws(()=>db.prepare('UPDATE approval_grant_revocations SET reason=? WHERE grant_id=?').run('tamper',futureCase.grant.grantId),/immutable/);
    assert.throws(()=>tryDispatch(futureCase.grant,futureCase.claim),{status:409,code:'GRANT_REVOKED'});

    // 3. Independent server scope derivation rejects drift even when caller omits currentScope.
    const scopeInput=validAttemptInput({
      projectId:project.id,
      approvedRoots:[rootA],
      sessionId:'session-attempt-1',
    });
    registerScopeFromInput(host,projects,scopeInput);
    const scopeCase=audit.issueAttemptGrant(scopeInput);

    // Omitting any required field from optional caller currentScope still fails closed with 400.
    const fullScope=host.scopeResolver({taskId:scopeCase.grant.taskId});
    for(const field of Object.keys(fullScope)) {
      const partial={...fullScope};
      delete partial[field];
      assert.throws(()=>tryDispatch(scopeCase.grant,scopeCase.claim,{currentScope:partial}),{status:400,code:'MISSING_CURRENT_SCOPE'});
    }

    // Mutate independent server scope fields one by one and confirm dispatch rejects.
    const baselineTask=host.serverTasks.get(scopeCase.grant.taskId);
    const driftCases=[
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
    for(const [patch,code] of driftCases) {
      host.updateTaskScope(scopeCase.grant.taskId,patch);
      assert.throws(()=>tryDispatch(scopeCase.grant,scopeCase.claim),{status:409,code});
      host.serverTasks.set(scopeCase.grant.taskId,baselineTask);
    }

    // 4. Modifying a file inside an approved root between approval and dispatch fails closed.
    writeFileSync(join(rootA,'sample.js'),'export const ok = false;\n');
    assert.throws(()=>tryDispatch(scopeCase.grant,scopeCase.claim),{status:409,code:'APPROVED_ROOT_CHANGED'});
    writeFileSync(join(rootA,'sample.js'),'export const ok = true;\n');

    // 5. Moving an approved root fails closed with APPROVED_ROOT_MISSING.
    const movedRoot=join(scratch,'moved-root');
    renameSync(rootA,movedRoot);
    assert.throws(()=>tryDispatch(scopeCase.grant,scopeCase.claim),{status:409,code:'APPROVED_ROOT_MISSING'});
    renameSync(movedRoot,rootA);

    // 6. Replacing an approved root with a brand-new ordinary directory at the exact same path fails closed.
    const victimInput=validAttemptInput({
      projectId:project.id,
      approvedRoots:[rootB],
    });
    registerScopeFromInput(host,projects,victimInput);
    const victimCase=audit.issueAttemptGrant(victimInput);
    rmSync(rootB,{recursive:true,force:true});
    mkdirSync(rootB);
    assert.throws(()=>tryDispatch(victimCase.grant,victimCase.claim),{status:409,code:'APPROVED_ROOT_REPLACED'});

    // 7. Project revision bump and policy bump fail closed.
    projects.updateRevision(project.id,GIT_REV_2);
    assert.throws(()=>tryDispatch(scopeCase.grant,scopeCase.claim),{status:409,code:'PROJECT_REVISION_CHANGED'});
    projects.updateRevision(project.id,GIT_REV);

    audit.setPolicyVersion('approval-policy-v2');
    assert.throws(()=>tryDispatch(scopeCase.grant,scopeCase.claim),{status:409,code:'POLICY_CHANGED'});
    audit.setPolicyVersion(DEFAULT_POLICY_VERSION);
    assert.equal(billingCount,0);

    // 8. Locking UI session (revokeSession) blocks NEW grants for that session while preserving already-authorized attempt dispatch/settlement.
    audit.revokeSession('session-attempt-1');
    assert.throws(()=>audit.issueAttemptGrant(validAttemptInput({
      projectId:project.id,
      approvedRoots:[rootA],
      sessionId:'session-attempt-1',
    })),{status:409,code:'SESSION_REVOKED'});

    const dispatchedAfterLock=tryDispatch(scopeCase.grant,scopeCase.claim);
    assert.equal(dispatchedAfterLock.dispatched,true);
    const settledAfterLock=audit.completeDispatch({
      grantId:scopeCase.grant.grantId,
      claimId:scopeCase.claim.claimId,
      ownership:lease,
      outcome:'succeeded',
    });
    assert.equal(settledAfterLock.claim.phase,'settled');
    assert.throws(()=>audit.revokeGrant(scopeCase.grant.grantId),{status:409,code:'ALREADY_DISPATCHED'});

    // 9. Superseded expired pre-dispatch claim does not block a fresh approved attempt on the same task.
    const freshInput=validAttemptInput({taskId:expCase.grant.taskId});
    registerScopeFromInput(host,projects,freshInput);
    const fresh=audit.issueAttemptGrant(freshInput);
    const dispatched=tryDispatch(fresh.grant,fresh.claim);
    assert.equal(dispatched.dispatched,true);
    assert.equal(billingCount,2);
  } finally {
    db.close();
  }
});

test('5-minute single-use action grants verify actual artifact digest, bind session against Lock-vs-issuance races, and block same-path directory replacement',async t=>{
  const scratch=makeScratchDir(t);
  const projectDir=join(scratch,'repo-action');
  const repoSub=join(projectDir,'src');
  const repoOther=join(projectDir,'other');
  const outsideTarget=join(scratch,'outside-target');
  mkdirSync(repoSub,{recursive:true});
  mkdirSync(repoOther,{recursive:true});
  mkdirSync(outsideTarget);
  writeFileSync(join(repoSub,'mod.js'),'export const a = 1;\n');

  let now=1_795_000_000_000;
  const dbPath=join(scratch,'action-race.sqlite');
  const {db,projects,audit,host}=makeStores({clock:()=>now,dbPath});
  let project;
  try {
    db.exec('PRAGMA journal_mode=WAL;');
    ({project}=projects.registerProject({label:'ActionRepo',root:projectDir,revision:GIT_REV}));
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

    assert.throws(()=>audit.issueActionGrant({...baseInput,requestId:null,sessionId:''}),{status:400,code:'MISSING_SESSION_ID'});
    assert.throws(()=>audit.issueActionGrant({...baseInput,requestId:null,target:{kind:'patch',id:'p1'}}),{status:400,code:'INVALID_ACTION_TARGET'});

    // Mismatched actual artifact digest fails at issue time and consume time.
    assert.throws(()=>audit.issueActionGrant({
      ...baseInput,
      requestId:null,
      target:{kind:'patch',id:'patch-1',digest:sha('stale-digest')},
    }),{status:409,code:'TARGET_MISMATCH'});

    const consumeArgs=consumeArgsFromGrant(grant);
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

    // Mutating actual artifact bytes on disk/store before consumption fails closed with TARGET_MISMATCH without consuming.
    host.setArtifact('patch','patch-1','mutated patch payload');
    assert.throws(()=>audit.consumeActionGrant(consumeArgs),{status:409,code:'TARGET_MISMATCH'});
    host.setArtifact('patch','patch-1',TARGET_PAYLOAD_V1);

    const incomplete={...consumeArgs};
    delete incomplete.target;
    assert.throws(()=>audit.consumeActionGrant(incomplete),{status:400,code:'INVALID_ACTION_TARGET'});

    // Matching caller arguments are not enough: without the server's pending action scope it holds closed.
    assert.throws(()=>audit.consumeActionGrant(consumeArgs),{status:409,code:'UNVERIFIED_ACTION_SCOPE'});
    assert.equal(audit.readGrant(grant.grantId).consumedAt,null);
    registerActionScopeFromInput(host,projects,baseInput);

    const consumed=audit.consumeActionGrant(consumeArgs);
    assert.equal(consumed.consumed,true);
    assert.equal(consumed.sealedHandoff,false);
    assert.throws(()=>audit.consumeActionGrant(consumeArgs),{status:409,code:'GRANT_ALREADY_USED'});
    assert.throws(()=>audit.revokeGrant(grant.grantId),{status:409,code:'GRANT_ALREADY_USED'});
    assert.throws(()=>db.prepare('DELETE FROM approval_action_consumptions WHERE grant_id=?').run(grant.grantId),/cannot be deleted/);
    assert.throws(()=>db.prepare('UPDATE approval_action_consumptions SET consumed_at_ms=0 WHERE grant_id=?').run(grant.grantId),/immutable/);

    // Same-path ordinary directory replacement between action approval and consumption fails closed.
    const samePathGrant=audit.issueActionGrant(validActionInput({
      projectId:project.id,
      approvedRoots:[repoOther],
    }));
    rmSync(repoOther,{recursive:true,force:true});
    mkdirSync(repoOther);
    assert.throws(()=>audit.consumeActionGrant(consumeArgsFromGrant(samePathGrant)),{status:409,code:'APPROVED_ROOT_REPLACED'});

    // Nested symlink/junction inside an approved root fails closed.
    let nestedLink=false;
    try {
      symlinkSync(outsideTarget,join(repoSub,'escape-link'),'junction');
      nestedLink=true;
    } catch {
      nestedLink=false;
    }
    if(nestedLink) {
      assert.throws(()=>audit.issueActionGrant(validActionInput({
        projectId:project.id,
        approvedRoots:[repoSub],
      })),{status:400,code:'APPROVED_ROOT_SYMLINK'});
      rmSync(join(repoSub,'escape-link'),{recursive:true,force:true});
    }

    // Workspace lock (revokeSession) invalidates pending action grants AND blocks future action grant issuance & replay for that session.
    const preLockRequestId=randomUUID();
    const lockGrant=audit.issueActionGrant(validActionInput({
      projectId:project.id,
      approvedRoots:[repoSub],
      sessionId:'session-to-lock',
      requestId:preLockRequestId,
    }));
    const lockRes=audit.revokeSession('session-to-lock');
    assert.equal(lockRes.revokedCount,1);
    assert.equal(lockRes.sessionLocked,true);
    assert.throws(()=>audit.consumeActionGrant(consumeArgsFromGrant(lockGrant)),{status:409,code:'GRANT_REVOKED'});
    assert.throws(()=>audit.issueActionGrant(validActionInput({
      projectId:project.id,
      approvedRoots:[repoSub],
      sessionId:'session-to-lock',
    })),{status:409,code:'SESSION_REVOKED'});
    assert.throws(()=>audit.issueActionGrant(validActionInput({
      projectId:project.id,
      approvedRoots:[repoSub],
      sessionId:'session-to-lock',
      requestId:preLockRequestId,
    })),{status:409,code:'SESSION_REVOKED'});

    // Expiry at 5 minutes (300_000 ms) and explicit revocation.
    const expGrant=audit.issueActionGrant(validActionInput({
      action:'export-artifact',
      projectId:project.id,
      approvedRoots:[repoSub],
    }));
    now+=300_000;
    assert.throws(()=>audit.consumeActionGrant(consumeArgsFromGrant(expGrant)),{status:409,code:'GRANT_EXPIRED'});

    const revGrant=audit.issueActionGrant(validActionInput({
      action:'export-artifact',
      projectId:project.id,
      approvedRoots:[repoSub],
    }));
    audit.revokeGrant(revGrant.grantId,{reason:'user-denied'});
    assert.throws(()=>audit.consumeActionGrant(consumeArgsFromGrant(revGrant)),{status:409,code:'GRANT_REVOKED'});

    assert.throws(()=>audit.issueActionGrant(validActionInput({
      projectId:project.id,
      approvedRoots:[repoSub],
      ttlMs:300_001,
    })),{status:400,code:'INVALID_ACTION_TTL'});
  } finally {
    db.close();
  }

  // Concurrent SQLite worker_threads race between Workspace Lock (revokeSession) and action grant issuance/consumption.
  const sab=new SharedArrayBuffer(8);
  const barrier=new Int32Array(sab);
  const raceSession='session-lock-race-1';
  const taskId=randomUUID();
  const lockWorkerScript=`
    import { workerData, parentPort } from 'node:worker_threads';
    import { DatabaseSync } from 'node:sqlite';
    const { ApprovalAuditStore } = await import(workerData.auditModuleUrl);
    const db = new DatabaseSync(workerData.dbPath);
    const audit = new ApprovalAuditStore(db, { clock: () => workerData.now });
    Atomics.add(workerData.barrier, 0, 1);
    while (Atomics.load(workerData.barrier, 1) === 0) {
      Atomics.wait(workerData.barrier, 1, 0, 5);
    }
    const res = audit.revokeSession(workerData.raceSession, { reason: 'workspace-locked' });
    db.close();
    parentPort.postMessage({ role: 'lock', res });
  `;
  const issueWorkerScript=`
    import { workerData, parentPort } from 'node:worker_threads';
    import { DatabaseSync } from 'node:sqlite';
    const { ApprovalAuditStore } = await import(workerData.auditModuleUrl);
    const db = new DatabaseSync(workerData.dbPath);
    const audit = new ApprovalAuditStore(db, {
      clock: () => workerData.now,
      hostVerifiers: {
        resolveTargetDigest: () => ({ digest: workerData.targetDigest }),
      },
    });
    Atomics.add(workerData.barrier, 0, 1);
    while (Atomics.load(workerData.barrier, 1) === 0) {
      Atomics.wait(workerData.barrier, 1, 0, 5);
    }
    try {
      const g = audit.issueActionGrant({
        action: 'apply-patch',
        sessionId: workerData.raceSession,
        target: { kind: 'patch', id: 'patch-1', digest: workerData.targetDigest },
        destination: { kind: 'local-workspace', endpoint: null },
        taskId: workerData.taskId,
        taskVersion: 1,
        projectId: workerData.projectId,
        sourceHash: workerData.sourceHash,
        routeRevision: workerData.routeRevision,
        accountRef: 'owner-local',
        approvedRoots: workerData.approvedRoots,
        permissions: ['read-only-source', 'repository-write'],
      });
      parentPort.postMessage({ role: 'issue', issued: true, grantId: g.grantId });
    } catch (error) {
      parentPort.postMessage({ role: 'issue', issued: false, code: error.code });
    } finally {
      db.close();
    }
  `;

  const wLock=new Promise((res,rej)=>{
    const w=new Worker(lockWorkerScript,{eval:true,workerData:{dbPath,now,raceSession,auditModuleUrl:AUDIT_MODULE_URL,barrier}});
    w.on('message',res);
    w.on('error',rej);
  });
  const wIssue=new Promise((res,rej)=>{
    const w=new Worker(issueWorkerScript,{
      eval:true,
      workerData:{
        dbPath,now,raceSession,taskId,
        projectId:project.id,
        approvedRoots:[repoSub],
        targetDigest:TARGET_DIGEST,
        sourceHash:SRC_HASH,
        routeRevision:ROUTE_REV,
        auditModuleUrl:AUDIT_MODULE_URL,
        barrier,
      },
    });
    w.on('message',res);
    w.on('error',rej);
  });
  while(Atomics.load(barrier,0)<2)await new Promise(r=>setTimeout(r,2));
  Atomics.store(barrier,1,1);
  Atomics.notify(barrier,1);
  const [,issueOutcome]=await Promise.all([wLock,wIssue]);

  const checkDb=new DatabaseSync(dbPath);
  try {
    const checkAudit=new ApprovalAuditStore(checkDb,{
      clock:()=>now,
      hostVerifiers:{resolveTargetDigest:()=>({digest:TARGET_DIGEST})},
    });
    if(issueOutcome.issued) {
      // If issuance committed just before revokeSession, revokeSession revoked it so consume must fail.
      const loaded=checkAudit.readGrant(issueOutcome.grantId);
      assert.throws(()=>checkAudit.consumeActionGrant(consumeArgsFromGrant(loaded.grant)),{status:409,code:'GRANT_REVOKED'});
    } else {
      assert.equal(issueOutcome.code,'SESSION_REVOKED');
    }
    // Regardless of ordering, subsequent issuance for the locked session always fails.
    assert.throws(()=>checkAudit.issueActionGrant(validActionInput({
      projectId:project.id,
      approvedRoots:[repoSub],
      sessionId:raceSession,
    })),{status:409,code:'SESSION_REVOKED'});
  } finally {
    checkDb.close();
  }
});

test('crash reconciliation enforces fenced controller ownership, blocks second controller while active, and requires trusted worker/receipt verification',t=>{
  const scratch=makeScratchDir(t);
  const dbPath=join(scratch,'crash.sqlite');
  let now=1_795_000_000_000;
  const host=makeHostHarness({clock:()=>now});
  const {db,projects,audit}=makeStores({clock:()=>now,dbPath,host});
  let preDispatch;
  let inDispatch;
  let lease1;
  try {
    lease1=audit.acquireControllerLease({
      controllerId:'controller-1',
      leaseToken:'pre-crash-secret-token-001',
    });

    // A second controller cannot acquire or take over while controller-1 holds an active unexpired lease
    // and controller-1 has not been verified stopped.
    assert.throws(()=>audit.acquireControllerLease({
      controllerId:'controller-rogue',
      leaseToken:'rogue-controller-token-002',
    }),{status:409,code:'CONTROLLER_LEASE_ACTIVE'});
    assert.throws(()=>audit.acquireControllerLease({
      controllerId:'controller-rogue',
      leaseToken:'rogue-controller-token-002',
      takeover:true,
    }),{status:409,code:'CONTROLLER_LEASE_ACTIVE'});

    // Unauthenticated/forged reconciliation fails closed.
    assert.throws(()=>audit.reconcileInterrupted(),{status:409,code:'UNVERIFIED_CONTROLLER_OWNERSHIP'});
    assert.throws(()=>audit.reconcileInterrupted({
      ownership:{controllerId:'controller-rogue',ownerGeneration:1,leaseToken:'rogue-controller-token-002'},
    }),{status:409,code:'UNVERIFIED_CONTROLLER_OWNERSHIP'});

    const preInput=validAttemptInput();
    const inInput=validAttemptInput();
    registerScopeFromInput(host,projects,preInput);
    registerScopeFromInput(host,projects,inInput);
    preDispatch=audit.issueAttemptGrant(preInput);
    inDispatch=audit.issueAttemptGrant(inInput);
    audit.beginDispatch({
      grantId:inDispatch.grant.grantId,
      claimId:inDispatch.claim.claimId,
      ownership:lease1,
      workerId:'worker-in-flight-1',
    });

    // While worker-in-flight-1 is active, controller-1 marks it running.
    host.setWorkerState(inDispatch.grant.attemptId,{
      workerId:'worker-in-flight-1',
      stopped:false,
      cleanupConfirmed:false,
    });
  } finally {
    db.close();
  }

  // Simulated restart: controller-1 process died (verified by host), worker-in-flight-1 is STILL running!
  now+=1000;
  host.markControllerStopped(lease1.controllerId,lease1.ownerGeneration);
  const db2=new DatabaseSync(dbPath);
  try {
    const restarted=new ApprovalAuditStore(db2,{
      clock:()=>now,
      scopeResolver:host.scopeResolver,
      hostVerifiers:host.hostVerifiers,
    });

    // Acquiring lease2 with verified controller-1 stop fences out stale lease1.
    const lease2=restarted.acquireControllerLease({
      controllerId:'controller-2',
      leaseToken:'post-crash-secret-token-002',
      takeover:true,
    });
    assert.equal(lease2.ownerGeneration,lease1.ownerGeneration+1);

    // Pre-crash controller-1 (stale generation 1) is fenced out on reconcile, dispatch, settle, and release.
    assert.throws(()=>restarted.reconcileInterrupted({ownership:lease1}),{status:409,code:'UNVERIFIED_CONTROLLER_OWNERSHIP'});
    assert.throws(()=>restarted.completeDispatch({
      grantId:inDispatch.grant.grantId,
      claimId:inDispatch.claim.claimId,
      ownership:lease1,
      outcome:'succeeded',
    }),{status:409,code:'UNVERIFIED_CONTROLLER_OWNERSHIP'});

    const summary=restarted.reconcileInterrupted({ownership:lease2});
    assert.equal(summary.retrySafeCount,1);
    assert.equal(summary.unresolvedCount,1);
    assert.equal(summary.ownerGeneration,lease2.ownerGeneration);

    assert.throws(()=>restarted.beginDispatch({
      grantId:preDispatch.grant.grantId,
      claimId:preDispatch.claim.claimId,
      ownership:lease2,
    }),{status:409,code:'CLAIM_NOT_DISPATCHABLE'});
    assert.throws(()=>restarted.beginDispatch({
      grantId:inDispatch.grant.grantId,
      claimId:inDispatch.claim.claimId,
      ownership:lease2,
    }),{status:409,code:'CLAIM_NOT_DISPATCHABLE'});

    // Retry-safe task can accept a fresh explicit approval; unresolved task is held.
    const freshPreInput=validAttemptInput({taskId:preDispatch.grant.taskId});
    registerScopeFromInput(host,new WorkspaceProjects(db2,{clock:()=>now}),freshPreInput);
    const freshForPre=restarted.issueAttemptGrant(freshPreInput);
    assert.equal(freshForPre.claim.phase,'claimed');
    assert.throws(()=>restarted.issueAttemptGrant(validAttemptInput({taskId:inDispatch.grant.taskId})),
      {status:409,code:'UNRESOLVED_CLAIM_HOLD'});

    // While original worker remains active, even controller-2 with forged caller flags CANNOT release the hold.
    assert.throws(()=>restarted.resolveCrashHold({
      claimId:inDispatch.claim.claimId,
      resolution:'confirmed-stopped',
      ownership:lease2,
      evidence:{
        attemptId:inDispatch.grant.attemptId,
        workerId:'worker-in-flight-1',
        processExited:true,
        cleanup:'confirmed',
        exitCode:0,
        exitedAt:new Date(now).toISOString(),
      },
    }),{status:409,code:'UNVERIFIED_WORKER_STOP'});

    // Worker stops, but cleanup not yet confirmed -> still holds closed.
    host.setWorkerState(inDispatch.grant.attemptId,{
      workerId:'worker-in-flight-1',
      stopped:true,
      cleanupConfirmed:false,
      exitCode:137,
      exitedAt:new Date(now).toISOString(),
    });
    assert.throws(()=>restarted.resolveCrashHold({
      claimId:inDispatch.claim.claimId,
      resolution:'confirmed-stopped',
      ownership:lease2,
    }),{status:409,code:'UNVERIFIED_WORKER_STOP'});

    // Hold remains unresolved.
    assert.throws(()=>restarted.issueAttemptGrant(validAttemptInput({taskId:inDispatch.grant.taskId})),
      {status:409,code:'UNRESOLVED_CLAIM_HOLD'});

    // Undispatched retry-safe claim cannot be resolved as confirmed-settled.
    assert.throws(()=>restarted.resolveCrashHold({
      claimId:preDispatch.claim.claimId,
      resolution:'confirmed-settled',
      ownership:lease2,
    }),{status:409,code:'INSUFFICIENT_RECOVERY_EVIDENCE'});

    // Trusted host verifier confirms worker stopped & cleanup confirmed -> release succeeds.
    host.setWorkerState(inDispatch.grant.attemptId,{
      workerId:'worker-in-flight-1',
      stopped:true,
      cleanupConfirmed:true,
      exitCode:0,
      exitedAt:new Date(now).toISOString(),
    });
    assert.throws(()=>restarted.resolveCrashHold({
      claimId:inDispatch.claim.claimId,
      ownership:lease2,
    }),{status:400,code:'INVALID_RESOLUTION'});
    assert.throws(()=>restarted.resolveCrashHold({
      claimId:inDispatch.claim.claimId,
      resolution:'confirmed-stopped',
      ownership:lease1,
    }),{status:409,code:'UNVERIFIED_CONTROLLER_OWNERSHIP'});

    const resolved=restarted.resolveCrashHold({
      claimId:inDispatch.claim.claimId,
      resolution:'confirmed-stopped',
      ownership:lease2,
    });
    assert.equal(resolved.phase,'aborted');
    assert.equal(resolved.outcome,'confirmed-stopped');
    const freshAfterResolve=restarted.issueAttemptGrant(validAttemptInput({taskId:inDispatch.grant.taskId}));
    assert.equal(freshAfterResolve.claim.phase,'claimed');

    // Dispatched claim can also settle via confirmed-settled when trusted host receipt exists.
    const d2Input=validAttemptInput();
    registerScopeFromInput(host,new WorkspaceProjects(db2,{clock:()=>now}),d2Input);
    const dispatched2=restarted.issueAttemptGrant(d2Input);
    restarted.beginDispatch({
      grantId:dispatched2.grant.grantId,
      claimId:dispatched2.claim.claimId,
      ownership:lease2,
      workerId:'worker-settle-2',
    });
    now+=500;
    host.markControllerStopped(lease2.controllerId,lease2.ownerGeneration);
    const lease3=restarted.acquireControllerLease({
      controllerId:'controller-3',
      leaseToken:'post-crash-secret-token-003',
      takeover:true,
    });
    const rec2=restarted.reconcileInterrupted({ownership:lease3});
    assert.equal(rec2.unresolvedCount,1);

    // Without trusted receipt, confirmed-settled fails closed even if caller passes a 64-hex digest.
    assert.throws(()=>restarted.resolveCrashHold({
      claimId:dispatched2.claim.claimId,
      resolution:'confirmed-settled',
      ownership:lease3,
      evidence:{
        attemptId:dispatched2.grant.attemptId,
        settled:true,
        settlementOutcome:'succeeded',
        receiptDigest:sha('caller-forged-receipt'),
        settledAt:new Date(now).toISOString(),
      },
    }),{status:409,code:'UNVERIFIED_SETTLEMENT_RECEIPT'});

    host.setReceipt(dispatched2.grant.attemptId,{
      settled:true,
      outcome:'succeeded',
      receiptDigest:sha('settlement-receipt-2'),
      settledAt:new Date(now).toISOString(),
      workerId:'worker-settle-2',
    });
    const settledHold=restarted.resolveCrashHold({
      claimId:dispatched2.claim.claimId,
      resolution:'confirmed-settled',
      ownership:lease3,
    });
    assert.equal(settledHold.phase,'settled');
    assert.equal(settledHold.outcome,'confirmed-settled');
  } finally {
    db2.close();
  }
});

test('SQLite integrity blocks illegal claim transitions, replacement writes, and migrates f741151 databases cleanly',t=>{
  const scratch=makeScratchDir(t);
  const projectDir=join(scratch,'repo-migrate');
  mkdirSync(projectDir);
  let now=1_795_000_000_000;

  // 1. Create a real f741151-era SQLite DB file (without worker_id, controller_id, owner_generation, reconciled_at_ms, root_dev, root_ino)
  // and populate existing project, grant, claim, and audit rows.
  const f741151DbPath=join(scratch,'legacy-f741151.sqlite');
  const legacyTaskId=randomUUID();
  const legacyGrantId=randomUUID();
  const legacyClaimId=randomUUID();
  const legacyAttemptId=randomUUID();
  const legacyReqId=randomUUID();
  const legacyNowIso=new Date(now).toISOString();
  const legacyExpIso=new Date(now+300_000).toISOString();
  {
    const oldDb=new DatabaseSync(f741151DbPath);
    try {
      oldDb.exec(`
        CREATE TABLE workspace_projects (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          root TEXT UNIQUE,
          revision TEXT,
          is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE approval_grants (
          grant_id TEXT PRIMARY KEY,
          grant_kind TEXT NOT NULL CHECK(grant_kind IN ('attempt','action')),
          task_id TEXT,
          project_id TEXT NOT NULL,
          request_id TEXT,
          claim_id TEXT,
          attempt_id TEXT,
          session_id TEXT,
          policy_version TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          issued_at_ms INTEGER NOT NULL,
          expires_at TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          grant_hash TEXT NOT NULL,
          payload TEXT NOT NULL,
          UNIQUE(task_id,request_id)
        );
        CREATE TABLE approval_claims (
          claim_id TEXT PRIMARY KEY,
          grant_id TEXT NOT NULL UNIQUE REFERENCES approval_grants(grant_id),
          attempt_id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL,
          task_version INTEGER NOT NULL,
          request_id TEXT NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('claimed','dispatching','settled','crash-held','aborted')),
          recovery_state TEXT CHECK(recovery_state IN ('retry-safe','unresolved')),
          outcome TEXT,
          claimed_at TEXT NOT NULL,
          dispatched_at TEXT,
          settled_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE approval_audit_log (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          grant_id TEXT NOT NULL REFERENCES approval_grants(grant_id),
          claim_id TEXT,
          event_type TEXT NOT NULL,
          at TEXT NOT NULL,
          detail TEXT NOT NULL
        );
      `);
      oldDb.prepare(
        'INSERT INTO workspace_projects (id,label,root,revision,is_default,created_at,updated_at) VALUES (?,?,?,?,1,?,?)'
      ).run(DEFAULT_PROJECT_ID,'Default local workspace',null,null,legacyNowIso,legacyNowIso);
      const legacyGrantBody={
        grantId:legacyGrantId,
        grantKind:'attempt',
        claimId:legacyClaimId,
        attemptId:legacyAttemptId,
        requestId:legacyReqId,
        taskId:legacyTaskId,
        taskVersion:1,
        projectId:DEFAULT_PROJECT_ID,
        projectRevision:null,
        sourceHash:SRC_HASH,
        routeRevision:ROUTE_REV,
        model:'fixture',
        engine:'fixture',
        backend:'fixture',
        modelDigest:null,
        modelFingerprint:null,
        destination:{kind:'local-workspace',endpoint:null},
        accountRef:null,
        approvedRoots:[],
        permissions:['read-only-source'],
        testPlan:{kind:'change',checks:['ok'],protectedChecks:[],filename:null,expected:null},
        testPlanHash:sha('plan'),
        submissionFingerprint:sha('sub'),
        policyVersion:DEFAULT_POLICY_VERSION,
        sessionId:null,
        issuedAt:legacyNowIso,
        expiresAt:legacyExpIso,
      };
      const legacyGrantHash=sha(JSON.stringify(legacyGrantBody));
      const legacyGrant={...legacyGrantBody,grantHash:legacyGrantHash};
      oldDb.prepare(
        `INSERT INTO approval_grants (
           grant_id,grant_kind,task_id,project_id,request_id,claim_id,attempt_id,
           session_id,policy_version,issued_at,issued_at_ms,expires_at,expires_at_ms,grant_hash,payload
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        legacyGrantId,'attempt',legacyTaskId,DEFAULT_PROJECT_ID,legacyReqId,legacyClaimId,legacyAttemptId,
        null,DEFAULT_POLICY_VERSION,legacyNowIso,now,legacyExpIso,now+300_000,legacyGrantHash,JSON.stringify(legacyGrant)
      );
      oldDb.prepare(
        `INSERT INTO approval_claims (
           claim_id,grant_id,attempt_id,task_id,task_version,request_id,
           phase,recovery_state,outcome,claimed_at,dispatched_at,settled_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        legacyClaimId,legacyGrantId,legacyAttemptId,legacyTaskId,1,legacyReqId,
        'dispatching',null,null,legacyNowIso,legacyNowIso,null,legacyNowIso
      );
      oldDb.prepare(
        'INSERT INTO approval_audit_log (grant_id,claim_id,event_type,at,detail) VALUES (?,?,?,?,?)'
      ).run(legacyGrantId,legacyClaimId,'grant.issued_and_claimed',legacyNowIso,'{}');
    } finally {
      oldDb.close();
    }
  }

  // Reopen f741151 DB with current WorkspaceProjects + ApprovalAuditStore.
  const migratedDb=new DatabaseSync(f741151DbPath);
  try {
    const projects=new WorkspaceProjects(migratedDb,{clock:()=>now});
    const host=makeHostHarness({clock:()=>now});
    const audit=new ApprovalAuditStore(migratedDb,{
      clock:()=>now,
      projects,
      scopeResolver:host.scopeResolver,
      hostVerifiers:host.hostVerifiers,
    });

    const claimCols=new Set(migratedDb.prepare('PRAGMA table_info(approval_claims)').all().map(c=>c.name));
    for(const expectedCol of ['worker_id','controller_id','owner_generation','reconciled_at_ms','reconciled_generation']) {
      assert.equal(claimCols.has(expectedCol),true,`Expected migrated column ${expectedCol}`);
    }
    const projCols=new Set(migratedDb.prepare('PRAGMA table_info(workspace_projects)').all().map(c=>c.name));
    assert.equal(projCols.has('root_dev'),true);
    assert.equal(projCols.has('root_ino'),true);

    const readLegacy=audit.readGrant(legacyGrantId);
    assert.equal(readLegacy.claim.phase,'dispatching');
    assert.equal(readLegacy.claim.workerId,null);

    const lease=audit.acquireControllerLease({
      controllerId:'controller-migrated',
      leaseToken:'migrated-lease-token-001',
    });
    const rec=audit.reconcileInterrupted({ownership:lease});
    assert.equal(rec.unresolvedCount,1);
    assert.equal(audit.readGrant(legacyGrantId).claim.phase,'crash-held');
    assert.equal(audit.readGrant(legacyGrantId).claim.recoveryState,'unresolved');

    // 2. Test SQLite state-machine transition triggers, replacement writes (INSERT OR REPLACE / ON CONFLICT DO UPDATE),
    // and tampering guards on an active database.
    const {project}=projects.registerProject({label:'MigRepo',root:projectDir,revision:GIT_REV});
    const cInput=validAttemptInput({projectId:project.id,approvedRoots:[projectDir]});
    registerScopeFromInput(host,projects,cInput);
    const cIssued=audit.issueAttemptGrant(cInput);

    // Illegal claim transitions directly via SQL must abort.
    assert.throws(()=>migratedDb.prepare("UPDATE approval_claims SET phase='settled',settled_at=?,outcome='succeeded' WHERE claim_id=?")
      .run(legacyNowIso,cIssued.claim.claimId),/Invalid approval claim state transition/);
    assert.throws(()=>migratedDb.prepare("UPDATE approval_claims SET recovery_state='retry-safe' WHERE claim_id=?")
      .run(legacyClaimId),/Invalid approval claim state transition/);
    assert.throws(()=>migratedDb.prepare("UPDATE approval_claims SET phase='settled',outcome='confirmed-settled',settled_at=? WHERE claim_id=?")
      .run(legacyNowIso,cIssued.claim.claimId),/Invalid approval claim state transition/);

    // Replacement writes (INSERT OR REPLACE, REPLACE INTO, ON CONFLICT DO UPDATE) must be blocked by recursive_triggers + BEFORE DELETE/UPDATE triggers.
    assert.throws(()=>migratedDb.prepare(
      `INSERT OR REPLACE INTO approval_grants (
         grant_id,grant_kind,task_id,project_id,request_id,claim_id,attempt_id,
         session_id,policy_version,issued_at,issued_at_ms,expires_at,expires_at_ms,grant_hash,payload
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      cIssued.grant.grantId,'attempt',cIssued.grant.taskId,project.id,cIssued.grant.requestId,
      cIssued.grant.claimId,cIssued.grant.attemptId,null,'tampered',legacyNowIso,now,legacyExpIso,now+1000,'0'.repeat(64),'{}'
    ),/cannot be deleted/);

    assert.throws(()=>migratedDb.prepare(
      `INSERT INTO approval_grants (
         grant_id,grant_kind,task_id,project_id,request_id,claim_id,attempt_id,
         session_id,policy_version,issued_at,issued_at_ms,expires_at,expires_at_ms,grant_hash,payload
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(grant_id) DO UPDATE SET policy_version='tampered'`
    ).run(
      cIssued.grant.grantId,'attempt',cIssued.grant.taskId,project.id,cIssued.grant.requestId,
      cIssued.grant.claimId,cIssued.grant.attemptId,null,'tampered',legacyNowIso,now,legacyExpIso,now+1000,'0'.repeat(64),'{}'
    ),/immutable/);

    assert.throws(()=>migratedDb.prepare(
      `INSERT OR REPLACE INTO approval_claims (
         claim_id,grant_id,attempt_id,task_id,task_version,request_id,phase,claimed_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      cIssued.claim.claimId,cIssued.grant.grantId,cIssued.grant.attemptId,cIssued.grant.taskId,1,cIssued.grant.requestId,'settled',legacyNowIso,legacyNowIso
    ),/cannot be deleted/);

    audit.revokeSession('session-locked-replace-test');
    assert.throws(()=>migratedDb.prepare(
      'INSERT OR REPLACE INTO approval_revoked_sessions (session_id,revoked_at,revoked_at_ms,reason) VALUES (?,?,?,?)'
    ).run('session-locked-replace-test',legacyNowIso,now,'unlock'),/cannot be deleted/);
    assert.throws(()=>migratedDb.prepare(
      'INSERT INTO approval_revoked_sessions (session_id,revoked_at,revoked_at_ms,reason) VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET reason=excluded.reason'
    ).run('session-locked-replace-test',legacyNowIso,now,'unlock'),/immutable/);

    // Dispatch, settle, then verify terminal claim immutability & approval_dispatches replacement protection.
    const dRes=audit.beginDispatch({
      grantId:cIssued.grant.grantId,
      claimId:cIssued.claim.claimId,
      ownership:lease,
      workerId:'worker-mig-1',
    });
    assert.throws(()=>migratedDb.prepare("UPDATE approval_claims SET phase='claimed' WHERE claim_id=?")
      .run(cIssued.claim.claimId),/Invalid approval claim state transition/);
    assert.throws(()=>migratedDb.prepare('INSERT OR REPLACE INTO approval_dispatches (dispatch_id,grant_id,claim_id,attempt_id,task_id,controller_id,owner_generation,worker_id,scope_digest,dispatched_at,dispatched_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(dRes.dispatch.dispatchId,cIssued.grant.grantId,cIssued.claim.claimId,cIssued.grant.attemptId,cIssued.grant.taskId,'ctrl',1,'w','0'.repeat(64),legacyNowIso,now),/cannot be deleted/);

    audit.completeDispatch({
      grantId:cIssued.grant.grantId,
      claimId:cIssued.claim.claimId,
      ownership:lease,
      outcome:'succeeded',
    });
    assert.throws(()=>migratedDb.prepare("UPDATE approval_claims SET outcome='failed' WHERE claim_id=?")
      .run(cIssued.claim.claimId),/Terminal approval claims are immutable/);
  } finally {
    migratedDb.close();
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

test('llamacpp fingerprint binding, tampered grants/claims, action grant replay/policy bump, and project-root replacement fail closed',t=>{
  const scratch=makeScratchDir(t);
  const projectDir=join(scratch,'repo-tamper');
  mkdirSync(projectDir);
  const {db,projects,audit,host}=makeStores();
  try {
    const lease=audit.acquireControllerLease({
      controllerId:'controller-tamper',
      leaseToken:'tamper-lease-token-0001',
    });
    const {project}=projects.registerProject({label:'TamperRepo',root:projectDir,revision:GIT_REV});
    assert.throws(()=>resolveLocalRoot(parse(process.cwd()).root),{status:400,code:'PROJECT_ROOT_FILESYSTEM_ROOT'});
    assert.equal(audit.readGrant(randomUUID()),null);

    const fp=sha('llamacpp-fp');
    const llamaInput=validAttemptInput({
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
    });
    registerScopeFromInput(host,projects,llamaInput);
    const llama=audit.issueAttemptGrant(llamaInput);
    assert.equal(llama.grant.modelFingerprint,fp);
    assert.equal(llama.grant.modelDigest,null);

    host.updateTaskScope(llama.grant.taskId,{modelFingerprint:sha('other-fp')});
    assert.throws(()=>audit.beginDispatch({
      grantId:llama.grant.grantId,
      claimId:llama.claim.claimId,
      ownership:lease,
    }),{status:409,code:'ROUTE_CHANGED'});
    host.updateTaskScope(llama.grant.taskId,{modelFingerprint:fp});

    assert.throws(()=>audit.resolveCrashHold({claimId:llama.claim.claimId,resolution:'confirmed-stopped',ownership:lease}),{status:409,code:'CLAIM_NOT_HELD'});
    assert.throws(()=>audit.resolveCrashHold({claimId:llama.claim.claimId,resolution:'bad'}),{status:400,code:'INVALID_RESOLUTION'});

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

    // Replacing registered project.root itself at the same path fails closed on both attempt and action use.
    const replacedRootDir=join(scratch,'repo-self-replace');
    mkdirSync(replacedRootDir);
    const {project:selfReplaceProj}=projects.registerProject({label:'SelfReplace',root:replacedRootDir,revision:GIT_REV});
    const srAction=audit.issueActionGrant(validActionInput({
      projectId:selfReplaceProj.id,
      approvedRoots:[],
    }));
    rmSync(replacedRootDir,{recursive:true,force:true});
    mkdirSync(replacedRootDir);
    assert.throws(()=>audit.consumeActionGrant(consumeArgsFromGrant(srAction)),{status:409,code:'PROJECT_ROOT_REPLACED'});

    db.exec('DROP TRIGGER approval_claims_immutable_identity');
    db.prepare('UPDATE approval_claims SET attempt_id=? WHERE claim_id=?').run(randomUUID(),llama.claim.claimId);
    assert.throws(()=>audit.readGrant(llama.grant.grantId),{status:409,code:'CLAIM_INTEGRITY_ERROR'});
    assert.throws(()=>audit.beginDispatch({
      grantId:llama.grant.grantId,
      claimId:llama.claim.claimId,
      ownership:lease,
    }),{status:409,code:'CLAIM_INTEGRITY_ERROR'});

    db.exec('DROP TRIGGER approval_grants_no_update');
    db.prepare('UPDATE approval_grants SET issued_at_ms=issued_at_ms-1000 WHERE grant_id=?').run(g1.grantId);
    assert.throws(()=>audit.readGrant(g1.grantId),{status:409,code:'GRANT_INTEGRITY_ERROR'});
    const tampered=JSON.stringify({...llama.grant,policyVersion:'tampered-v99'});
    db.prepare('UPDATE approval_grants SET payload=? WHERE grant_id=?').run(tampered,llama.grant.grantId);
    assert.throws(()=>audit.readGrant(llama.grant.grantId),{status:409,code:'GRANT_INTEGRITY_ERROR'});
    assert.throws(()=>audit.beginDispatch({
      grantId:llama.grant.grantId,
      claimId:llama.claim.claimId,
      ownership:lease,
    }),{status:409,code:'GRANT_INTEGRITY_ERROR'});
  } finally {
    db.close();
  }
});

test('action grant consumption requires an independently resolved authoritative scope and rejects server-side drift without consuming',t=>{
  const scratch=makeScratchDir(t);
  const projectDir=join(scratch,'repo-action-scope');
  const srcDir=join(projectDir,'src');
  const otherDir=join(projectDir,'other');
  const outsideDir=join(scratch,'outside-action-scope');
  mkdirSync(srcDir,{recursive:true});
  mkdirSync(otherDir);
  mkdirSync(outsideDir);
  const now=1_795_000_000_000;

  // A trusted target verifier alone is not enough: without a scopeResolver consumption holds closed.
  const bareDb=new DatabaseSync(':memory:');
  try {
    const bareProjects=new WorkspaceProjects(bareDb,{clock:()=>now});
    const bareAudit=new ApprovalAuditStore(bareDb,{
      clock:()=>now,
      projects:bareProjects,
      hostVerifiers:{resolveTargetDigest:()=>({digest:TARGET_DIGEST})},
    });
    const {project:bareProject}=bareProjects.registerProject({label:'BareScope',root:projectDir,revision:GIT_REV});
    const bareGrant=bareAudit.issueActionGrant(validActionInput({projectId:bareProject.id,approvedRoots:[srcDir]}));
    assert.throws(()=>bareAudit.consumeActionGrant(consumeArgsFromGrant(bareGrant)),{status:409,code:'UNVERIFIED_ACTION_SCOPE'});
    assert.equal(bareAudit.readGrant(bareGrant.grantId).consumedAt,null);
    assert.equal(bareAudit.listAuditLog(bareGrant.grantId).some(entry=>entry.eventType==='action_grant.consumed'),false);
  } finally {
    bareDb.close();
  }

  const {db,projects,audit,host}=makeStores({clock:()=>now});
  try {
    const {project}=projects.registerProject({label:'ActionScope',root:projectDir,revision:GIT_REV});
    const input=validActionInput({projectId:project.id,approvedRoots:[srcDir]});
    const grant=audit.issueActionGrant(input);
    const args=consumeArgsFromGrant(grant);
    const assertNotConsumed=()=>assert.equal(audit.readGrant(grant.grantId).consumedAt,null);

    // No pending server action for this task: unverified, even though caller arguments match the grant.
    assert.throws(()=>audit.consumeActionGrant(args),{status:409,code:'UNVERIFIED_ACTION_SCOPE'});
    assertNotConsumed();
    const request=host.scopeRequests.at(-1);
    assert.equal(request.grantKind,'action');
    assert.deepEqual(Object.keys(request).sort(),['action','attemptId','claimId','grantId','grantKind','projectId','taskId']);
    assert.equal(request.taskId,grant.taskId);

    registerActionScopeFromInput(host,projects,input);
    const key=`${input.taskId}:${input.action}`;
    const baseline={...host.serverActions.get(key)};

    // Partial or malformed server scope is unverified, not repaired from caller input.
    const withoutRoots={...baseline};
    delete withoutRoots.approvedRoots;
    for(const broken of [
      withoutRoots,
      {...baseline,accountRef:undefined},
      {...baseline,sourceHash:'not-a-digest'},
      {...baseline,taskId:'not-a-uuid'},
      {...baseline,target:{kind:'patch',id:'patch-1',extra:true}},
      {...baseline,destination:{kind:'remote-endpoint',endpoint:'https://user:pw@example.com/v1'}},
      {...baseline,permissions:['not-a-scope']},
    ]) {
      host.serverActions.set(key,broken);
      assert.throws(()=>audit.consumeActionGrant(args),{status:409,code:'UNVERIFIED_ACTION_SCOPE'});
      assertNotConsumed();
    }
    host.serverActions.set(key,baseline);

    // Throwing, asynchronous, or non-object resolvers fail closed.
    for(const resolver of [
      ()=>{throw Error('host state unavailable');},
      ()=>Promise.resolve(baseline),
      ()=>'scope',
    ]) {
      const alt=new ApprovalAuditStore(db,{clock:()=>now,projects,scopeResolver:resolver,hostVerifiers:host.hostVerifiers});
      assert.throws(()=>alt.consumeActionGrant(args),{status:409,code:'UNVERIFIED_ACTION_SCOPE'});
      assertNotConsumed();
    }

    // Server-side drift rejects consumption while the caller still presents the original approved values.
    const driftCases=[
      [{taskVersion:baseline.taskVersion+1},'SCOPE_CHANGED'],
      [{projectId:DEFAULT_PROJECT_ID},'SCOPE_CHANGED'],
      [{projectRevision:GIT_REV_2},'PROJECT_REVISION_CHANGED'],
      [{action:'export-artifact'},'ACTION_MISMATCH'],
      [{target:{kind:'patch',id:'patch-2'}},'TARGET_MISMATCH'],
      [{target:{kind:'patch',id:'patch-1',digest:sha('superseded-patch')}},'TARGET_MISMATCH'],
      [{sourceHash:sha('source-v2')},'SCOPE_CHANGED'],
      [{routeRevision:sha('route-v2')},'ROUTE_CHANGED'],
      [{destination:{kind:'local-loopback',endpoint:'http://127.0.0.1:11434'}},'DESTINATION_CHANGED'],
      [{accountRef:'other-account'},'SCOPE_CHANGED'],
      [{accountRef:null},'SCOPE_CHANGED'],
      [{permissions:['read-only-source']},'SCOPE_CHANGED'],
      [{approvedRoots:[otherDir]},'SCOPE_CHANGED'],
      [{approvedRoots:[]},'SCOPE_CHANGED'],
      [{approvedRoots:[outsideDir]},'APPROVED_ROOT_OUTSIDE_PROJECT'],
    ];
    for(const [patch,code] of driftCases) {
      host.serverActions.set(key,{...baseline,...patch});
      assert.throws(()=>audit.consumeActionGrant(args),{status:409,code},JSON.stringify(patch));
      assertNotConsumed();
    }

    // The server may also report the target digest; a matching digest is accepted.
    host.serverActions.set(key,{...baseline,target:{kind:'patch',id:'patch-1',digest:TARGET_DIGEST}});
    const consumed=audit.consumeActionGrant(args);
    assert.equal(consumed.consumed,true);
    assert.equal(consumed.sealedHandoff,false);
    assert.throws(()=>audit.consumeActionGrant(args),{status:409,code:'GRANT_ALREADY_USED'});
  } finally {
    db.close();
  }
});

test('approved-root containment uses on-disk directory identity rather than case-folded path text',t=>{
  const scratch=makeScratchDir(t);
  const projectDir=join(scratch,'proj');
  mkdirSync(join(projectDir,'src'),{recursive:true});
  mkdirSync(join(scratch,'case-probe'));
  const caseSensitive=!existsSync(join(scratch,'CASE-PROBE'));
  const {db,projects,audit,host}=makeStores();
  try {
    const {project}=projects.registerProject({label:'CaseRepo',root:projectDir,revision:GIT_REV});
    assert.equal(project.rootIdentityState,'bound');
    if(caseSensitive) {
      // A sibling whose name differs only by letter case is a different directory, outside the project.
      const twin=join(scratch,'PROJ');
      mkdirSync(join(twin,'src'),{recursive:true});
      assert.throws(()=>verifyContainedRoot(project.root,twin),{status:400,code:'APPROVED_ROOT_OUTSIDE_PROJECT'});
      assert.throws(()=>verifyContainedRoot(project.root,join(twin,'src')),{status:400,code:'APPROVED_ROOT_OUTSIDE_PROJECT'});
      assert.throws(()=>verifyContainedRoot(project.root,join(twin,'src'),{useTime:true}),{status:409,code:'APPROVED_ROOT_OUTSIDE_PROJECT'});
      assert.throws(()=>audit.issueAttemptGrant(validAttemptInput({
        projectId:project.id,
        approvedRoots:[join(twin,'src')],
      })),{status:400,code:'APPROVED_ROOT_OUTSIDE_PROJECT'});

      // Case-variant children inside the project remain distinct approved roots; exact duplicates collapse.
      mkdirSync(join(projectDir,'SRC'));
      const input=validAttemptInput({
        projectId:project.id,
        approvedRoots:[join(projectDir,'src'),join(projectDir,'SRC'),join(projectDir,'src')],
      });
      registerScopeFromInput(host,projects,input);
      const issued=audit.issueAttemptGrant(input);
      assert.deepEqual(issued.grant.approvedRoots,[join(projectDir,'SRC'),join(projectDir,'src')]);
      assert.notEqual(issued.grant.rootIdentities[0].ino,issued.grant.rootIdentities[1].ino);

      // The case-variant twin registers as its own project rather than aliasing the original.
      const twinReg=projects.registerProject({label:'Twin',root:twin});
      assert.equal(twinReg.created,true);
      assert.notEqual(twinReg.project.rootIno,project.rootIno);
    } else {
      // Case-insensitive volume: a wrong-case spelling resolves to the on-disk spelling of the same directory.
      assert.equal(verifyContainedRoot(project.root,join(projectDir,'SRC')),join(project.root,'src'));
      assert.throws(()=>projects.registerProject({label:'Alias',root:join(scratch,'PROJ')}),{status:409,code:'PROJECT_ROOT_CONFLICT'});
    }

    // A link anywhere in the candidate chain is rejected by type, even when it points into the project.
    const alias=join(scratch,'proj-alias');
    let linked=false;
    try {
      symlinkSync(projectDir,alias,'junction');
      linked=true;
    } catch {
      linked=false;
    }
    if(linked) {
      assert.throws(()=>verifyContainedRoot(project.root,join(alias,'src')),{status:400,code:'APPROVED_ROOT_SYMLINK'});
      assert.throws(()=>verifyContainedRoot(alias,join(projectDir,'src')),{status:400,code:'PROJECT_ROOT_SYMLINK'});
    }
  } finally {
    db.close();
  }
});

test('migrated project rows without a recorded root identity fail closed until an owner revalidates them',t=>{
  const scratch=makeScratchDir(t);
  const projectDir=join(scratch,'legacy-repo');
  const otherDir=join(scratch,'other-repo');
  mkdirSync(join(projectDir,'src'),{recursive:true});
  mkdirSync(otherDir);
  const dbPath=join(scratch,'legacy-projects.sqlite');
  const legacyId='legacy-project-1';
  const createdIso=new Date(1_795_000_000_000).toISOString();
  const oldDb=new DatabaseSync(dbPath);
  try {
    oldDb.exec(`
      CREATE TABLE workspace_projects (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        root TEXT UNIQUE,
        revision TEXT,
        is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
    oldDb.prepare(
      'INSERT INTO workspace_projects (id,label,root,revision,is_default,created_at,updated_at) VALUES (?,?,?,?,0,?,?)'
    ).run(legacyId,'Legacy Repo',resolveLocalRoot(projectDir),GIT_REV,createdIso,createdIso);
  } finally {
    oldDb.close();
  }

  let now=1_795_000_100_000;
  const {db,projects,audit,host}=makeStores({clock:()=>now,dbPath});
  try {
    const legacy=projects.requireProject(legacyId);
    assert.equal(legacy.rootIdentityState,'unverified');
    assert.equal(legacy.rootDev,null);
    assert.throws(()=>projects.verifyProjectRootIdentity(legacy),{status:409,code:'PROJECT_ROOT_IDENTITY_UNVERIFIED'});

    const attemptInput=validAttemptInput({projectId:legacyId,approvedRoots:[join(projectDir,'src')]});
    registerScopeFromInput(host,projects,attemptInput);
    assert.throws(()=>audit.issueAttemptGrant(attemptInput),{status:409,code:'PROJECT_ROOT_IDENTITY_UNVERIFIED'});
    assert.throws(()=>audit.issueActionGrant(validActionInput({
      projectId:legacyId,
      approvedRoots:[],
    })),{status:409,code:'PROJECT_ROOT_IDENTITY_UNVERIFIED'});

    // Re-registering the same path does not silently bind the unverified row.
    assert.throws(()=>projects.registerProject({label:'Legacy Repo',root:projectDir,revision:GIT_REV}),{status:409,code:'PROJECT_ROOT_IDENTITY_UNVERIFIED'});
    assert.equal(projects.requireProject(legacyId).rootIdentityState,'unverified');

    // Revalidation requires exactly the owner-confirmed root and revision for the stored record.
    assert.throws(()=>projects.revalidateProjectRoot(legacyId,{root:projectDir}),{status:400,code:'INVALID_PROJECT_INPUT'});
    assert.throws(()=>projects.revalidateProjectRoot(legacyId,{root:projectDir,revision:GIT_REV,label:'x'}),{status:400,code:'INVALID_PROJECT_INPUT'});
    assert.throws(()=>projects.revalidateProjectRoot(legacyId,{root:projectDir,revision:GIT_REV_2}),{status:409,code:'PROJECT_REVISION_CHANGED'});
    assert.throws(()=>projects.revalidateProjectRoot(legacyId,{root:otherDir,revision:GIT_REV}),{status:409,code:'PROJECT_ROOT_CONFLICT'});
    assert.throws(()=>projects.revalidateProjectRoot(legacyId,{root:join(projectDir,'src'),revision:GIT_REV}),{status:409,code:'PROJECT_ROOT_CONFLICT'});
    assert.throws(()=>projects.revalidateProjectRoot('missing-project',{root:projectDir,revision:GIT_REV}),{status:404,code:'PROJECT_NOT_FOUND'});
    assert.throws(()=>projects.revalidateProjectRoot(DEFAULT_PROJECT_ID,{root:projectDir,revision:null}),{status:409,code:'PROJECT_ROOT_CONFLICT'});
    assert.equal(projects.requireProject(legacyId).rootIdentityState,'unverified');

    // A legacy root that now resolves through a link cannot be revalidated and stays unusable.
    const linkRoot=join(scratch,'legacy-link');
    let linked=false;
    try {
      symlinkSync(otherDir,linkRoot,'junction');
      linked=true;
    } catch {
      linked=false;
    }
    if(linked) {
      db.prepare(
        'INSERT INTO workspace_projects (id,label,root,revision,is_default,created_at,updated_at) VALUES (?,?,?,?,0,?,?)'
      ).run('legacy-link-project','Legacy Link',linkRoot,null,createdIso,createdIso);
      assert.throws(()=>projects.revalidateProjectRoot('legacy-link-project',{root:linkRoot,revision:null}),{status:400,code:'PROJECT_ROOT_SYMLINK'});
      assert.throws(()=>projects.revalidateProjectRoot('legacy-link-project',{root:otherDir,revision:null}),{status:409,code:'PROJECT_ROOT_REVALIDATION_FAILED'});
      assert.throws(()=>audit.issueActionGrant(validActionInput({
        projectId:'legacy-link-project',
        approvedRoots:[],
      })),{status:409,code:'PROJECT_ROOT_IDENTITY_UNVERIFIED'});
    }

    now+=1000;
    const revalidated=projects.revalidateProjectRoot(legacyId,{root:projectDir,revision:GIT_REV});
    assert.equal(revalidated.revalidated,true);
    assert.equal(revalidated.project.rootIdentityState,'bound');
    assert.equal(revalidated.project.root,resolveLocalRoot(projectDir));
    assert.ok(revalidated.project.rootDev&&revalidated.project.rootIno);
    assert.equal(revalidated.project.updatedAt,new Date(now).toISOString());
    assert.equal(projects.revalidateProjectRoot(legacyId,{root:projectDir,revision:GIT_REV}).revalidated,false);
    assert.equal(projects.registerProject({label:'Legacy Repo',root:projectDir,revision:GIT_REV}).project.id,legacyId);

    const issued=audit.issueAttemptGrant(attemptInput);
    assert.equal(issued.grant.projectRootIdentity.ino,revalidated.project.rootIno);

    // Once bound, same-path replacement is detected again and cannot be re-anchored by revalidation.
    rmSync(projectDir,{recursive:true,force:true});
    mkdirSync(join(projectDir,'src'),{recursive:true});
    assert.throws(()=>audit.issueAttemptGrant(validAttemptInput({
      projectId:legacyId,
      approvedRoots:[join(projectDir,'src')],
    })),{status:409,code:'PROJECT_ROOT_REPLACED'});
    assert.throws(()=>projects.revalidateProjectRoot(legacyId,{root:projectDir,revision:GIT_REV}),{status:409,code:'PROJECT_ROOT_REPLACED'});
  } finally {
    db.close();
  }
});
