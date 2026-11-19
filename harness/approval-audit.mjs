import {createHash,randomUUID} from 'node:crypto';
import {prepareRunSubmission,validSubmissionId,approvedRouteRevision} from './run-submission.mjs';
import {PERMISSION_SCOPES,classifyEndpointUrl,parseStrictIsoTimestamp} from './connection-contract.mjs';
import {
  WorkspaceProjects,
  resolveLocalRoot,
  validateLocalPathSyntax,
  verifyContainedRoot,
} from './workspace-projects.mjs';

export const DEFAULT_POLICY_VERSION='approval-policy-v1';
export const ACTION_GRANT_TTL_MS=300_000;
export const DEFAULT_ATTEMPT_GRANT_TTL_MS=300_000;
export const MAX_ATTEMPT_GRANT_TTL_MS=3_600_000;
export const CONTROLLER_LEASE_TTL_MS=300_000;

const DIGEST_PATTERN=/^[a-f0-9]{64}$/;
const REVISION_PATTERN=/^[a-f0-9]{40,64}$/;
const OPAQUE_ID_PATTERN=/^[A-Za-z0-9._:-]{1,80}$/;
const POLICY_PATTERN=/^[A-Za-z0-9._:-]{1,64}$/;
const ACTION_PATTERN=/^[a-z][a-z0-9_.:-]{0,79}$/;
const KIND_PATTERN=/^[a-z][a-z0-9_-]{0,39}$/;
const CONTROL_CHARS_PATTERN=/[\u0000-\u001f\u007f]/;
const PERMISSION_SET=new Set(PERMISSION_SCOPES);
const DESTINATION_KINDS=new Set(['local-loopback','remote-endpoint','local-workspace']);
const ALLOWED_TARGET_FIELDS=new Set(['kind','id','digest']);
const REQUIRED_DISPATCH_SCOPE_FIELDS=Object.freeze([
  'taskId','taskVersion','projectId','projectRevision','sourceHash','routeRevision',
  'model','engine','backend','modelDigest','modelFingerprint',
  'destination','accountRef','approvedRoots','permissions','testPlan',
]);

function fail(status,code,message) {
  throw Object.assign(Error(message),{status,code});
}

function isPlainObject(value) {
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

function deepFreeze(value) {
  if(value===null||typeof value!=='object')return value;
  Object.freeze(value);
  for(const key of Object.keys(value))deepFreeze(value[key]);
  return value;
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

function sha256Json(value) {
  return sha256Text(JSON.stringify(value));
}

function needUuid(value,label) {
  if(!validSubmissionId(value))fail(400,'INVALID_IDENTIFIER','Invalid '+label+'.');
  return value;
}

function needText(value,max,label,code='INVALID_TEXT') {
  if(typeof value!=='string'||CONTROL_CHARS_PATTERN.test(value))fail(400,code,'Invalid '+label+'.');
  const trimmed=value.trim();
  if(!trimmed||trimmed.length>max)fail(400,code,'Invalid '+label+'.');
  return trimmed;
}

function needSessionId(value) {
  if(typeof value!=='string'||CONTROL_CHARS_PATTERN.test(value)) {
    fail(400,'MISSING_SESSION_ID','An authenticated session identifier is required.');
  }
  const trimmed=value.trim();
  if(!trimmed||trimmed.length>120) {
    fail(400,'MISSING_SESSION_ID','An authenticated session identifier is required.');
  }
  return trimmed;
}

function requireOwnField(obj,field,code,label) {
  if(!Object.hasOwn(obj,field)||obj[field]===undefined) {
    fail(400,code,'Missing required '+label+': '+field+'.');
  }
}

export function normalizePolicyVersion(value) {
  if(typeof value!=='string'||!POLICY_PATTERN.test(value)) {
    fail(400,'INVALID_POLICY_VERSION','Invalid policy version.');
  }
  return value;
}

function normalizeProjectId(value) {
  if(typeof value!=='string'||!OPAQUE_ID_PATTERN.test(value)) {
    fail(400,'INVALID_PROJECT_ID','Invalid project identifier.');
  }
  return value;
}

function normalizeProjectRevision(value) {
  if(value===null)return null;
  if(typeof value!=='string'||!REVISION_PATTERN.test(value)) {
    fail(400,'INVALID_PROJECT_REVISION','Project revision must be null or a lowercase 40 to 64 character hex digest.');
  }
  return value;
}

function normalizeAccountRef(value) {
  if(value===null)return null;
  return needText(value,120,'account reference');
}

function resolveAndVerifyRoots(project,roots,{useTime=false}={}) {
  if(!Array.isArray(roots)||roots.length>64) {
    fail(400,'INVALID_APPROVED_ROOTS','Approved roots must be a bounded list.');
  }
  if(useTime&&project.root!==null) {
    resolveLocalRoot(project.root,{useTime:true});
  }
  if(roots.length===0)return [];
  for(const root of roots) {
    validateLocalPathSyntax(root,'INVALID_APPROVED_ROOTS','approved root path');
  }
  const canonical=roots.map(root=>verifyContainedRoot(project.root,root,{useTime}));
  return [...new Set(canonical)].sort();
}

function normalizePermissions(permissions) {
  if(!Array.isArray(permissions)||permissions.length<1||permissions.length>16) {
    fail(400,'INVALID_PERMISSIONS','At least one valid permission scope is required.');
  }
  const normalized=permissions.map(scope=>{
    if(typeof scope!=='string'||!PERMISSION_SET.has(scope)) {
      fail(400,'INVALID_PERMISSIONS','Unsupported permission scope.');
    }
    return scope;
  });
  return [...new Set(normalized)].sort();
}

export function normalizeDestination(destination) {
  if(!isPlainObject(destination)||typeof destination.kind!=='string'||!DESTINATION_KINDS.has(destination.kind)) {
    fail(400,'INVALID_DESTINATION','A known provider or workspace destination is required.');
  }
  const endpointInput=destination.endpoint===undefined?null:destination.endpoint;
  if(destination.kind==='local-workspace') {
    if(endpointInput!==null)fail(400,'INVALID_DESTINATION','A local workspace destination cannot carry an endpoint URL.');
    return Object.freeze({kind:'local-workspace',endpoint:null});
  }
  if(destination.kind==='local-loopback') {
    if(endpointInput===null)return Object.freeze({kind:'local-loopback',endpoint:null});
    const classified=classifyEndpointUrl(endpointInput);
    if(classified.kind!=='loopback') {
      fail(400,'INVALID_DESTINATION','Loopback destination must be a clean 127.0.0.1 HTTP URL without credentials or query strings.');
    }
    return Object.freeze({kind:'local-loopback',endpoint:classified.canonicalEndpoint});
  }
  const classified=classifyEndpointUrl(endpointInput);
  if(classified.kind!=='remote') {
    fail(400,'INVALID_DESTINATION','Remote destination must be a clean remote URL without credentials, query strings, or fragments.');
  }
  return Object.freeze({kind:'remote-endpoint',endpoint:classified.canonicalEndpoint});
}

function normalizeCheckList(list,label) {
  if(!Array.isArray(list)||list.length>32)fail(400,'INVALID_TEST_PLAN','Invalid '+label+' list.');
  return list.map(item=>needText(item,120,label));
}

function normalizeTestPlan(testPlan) {
  if(!isPlainObject(testPlan)||typeof testPlan.kind!=='string'||!KIND_PATTERN.test(testPlan.kind)) {
    fail(400,'INVALID_TEST_PLAN','A valid test plan is required.');
  }
  const checks=normalizeCheckList(testPlan.checks,'test plan check');
  const protectedChecks=testPlan.protectedChecks===undefined?[]:normalizeCheckList(testPlan.protectedChecks,'protected check');
  const filename=testPlan.filename===undefined||testPlan.filename===null?null:needText(testPlan.filename,100,'test plan filename');
  const expected=testPlan.expected===undefined||testPlan.expected===null?null:needText(testPlan.expected,400,'test plan expected text');
  return Object.freeze({kind:testPlan.kind,checks,protectedChecks,filename,expected});
}

function normalizeActionTarget(target) {
  if(!isPlainObject(target)||Object.keys(target).some(key=>!ALLOWED_TARGET_FIELDS.has(key))) {
    fail(400,'INVALID_ACTION_TARGET','An action target with kind, id, and sha256 digest is required.');
  }
  if(typeof target.kind!=='string'||!KIND_PATTERN.test(target.kind)) {
    fail(400,'INVALID_ACTION_TARGET','Specify a valid action target kind.');
  }
  const id=needText(target.id,120,'action target id','INVALID_ACTION_TARGET');
  if(typeof target.digest!=='string'||!DIGEST_PATTERN.test(target.digest)) {
    fail(400,'INVALID_ACTION_TARGET','Action target digest must be a 64-character lowercase hex digest.');
  }
  return Object.freeze({kind:target.kind,id,digest:target.digest});
}

function validateRemotePermission(destination,permissions) {
  if(destination.kind==='remote-endpoint'&&!permissions.includes('remote-data-egress')) {
    fail(400,'MISSING_EGRESS_PERMISSION','Remote destinations require the remote-data-egress permission.');
  }
}

function attemptBindingKey(grant) {
  return JSON.stringify({
    submissionFingerprint:grant.submissionFingerprint,
    projectId:grant.projectId,
    projectRevision:grant.projectRevision,
    destination:grant.destination,
    accountRef:grant.accountRef,
    approvedRoots:grant.approvedRoots,
    permissions:grant.permissions,
    testPlanHash:grant.testPlanHash,
    policyVersion:grant.policyVersion,
  });
}

function actionBindingKey(grant) {
  return JSON.stringify({
    action:grant.action,
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
    targetHash:grant.targetHash,
    sessionId:grant.sessionId,
    policyVersion:grant.policyVersion,
  });
}

function rowToClaim(row) {
  if(!row)return null;
  return deepFreeze({
    claimId:row.claim_id,
    grantId:row.grant_id,
    attemptId:row.attempt_id,
    taskId:row.task_id,
    taskVersion:row.task_version,
    requestId:row.request_id,
    phase:row.phase,
    recoveryState:row.recovery_state,
    outcome:row.outcome,
    workerId:row.worker_id??null,
    claimedAt:row.claimed_at,
    dispatchedAt:row.dispatched_at,
    settledAt:row.settled_at,
    updatedAt:row.updated_at,
  });
}

const LEGACY_GRANT_FIELDS=[
  'grantId','grantKind','claimId','attemptId','requestId','taskId','taskVersion',
  'projectId','projectRevision','sourceHash','routeRevision','model','engine','backend',
  'modelDigest','modelFingerprint','destination','accountRef','approvedRoots',
  'permissions','testPlan','testPlanHash','submissionFingerprint','policyVersion',
  'action','target','targetHash','sessionId','issuedAt','expiresAt','grantHash',
];

export function projectGrantRecord(raw) {
  if(!isPlainObject(raw))return Object.freeze({recordedFields:Object.freeze([])});
  const projected={};
  const recordedFields=[];
  for(const field of LEGACY_GRANT_FIELDS) {
    if(Object.hasOwn(raw,field)&&raw[field]!==undefined) {
      projected[field]=raw[field];
      recordedFields.push(field);
    } else {
      projected[field]=null;
    }
  }
  projected.recordedFields=Object.freeze(recordedFields);
  return deepFreeze(projected);
}

export class ApprovalAuditStore {
  constructor(db,{clock=()=>Date.now(),nonce=randomUUID,policyVersion=DEFAULT_POLICY_VERSION,projects=null}={}) {
    if(!db||typeof db.exec!=='function'||typeof db.prepare!=='function') {
      throw new TypeError('ApprovalAuditStore requires a SQLite DatabaseSync handle.');
    }
    this.db=db;
    this.clock=clock;
    this.nonce=nonce;
    this.policyVersion=normalizePolicyVersion(policyVersion);
    if(projects!==null) {
      if(typeof projects.requireProject!=='function'||typeof projects.getProject!=='function') {
        throw new TypeError('ApprovalAuditStore projects option must be a WorkspaceProjects instance.');
      }
      this.projects=projects;
    } else {
      this.projects=new WorkspaceProjects(db,{clock:this.clock,nonce:this.nonce});
    }
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS approval_grants (
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
      CREATE TRIGGER IF NOT EXISTS approval_grants_no_update
        BEFORE UPDATE ON approval_grants
        BEGIN SELECT RAISE(ABORT,'Approval grants are immutable.'); END;
      CREATE TRIGGER IF NOT EXISTS approval_grants_no_delete
        BEFORE DELETE ON approval_grants
        BEGIN SELECT RAISE(ABORT,'Approval grants cannot be deleted.'); END;

      CREATE TABLE IF NOT EXISTS approval_grant_revocations (
        grant_id TEXT PRIMARY KEY REFERENCES approval_grants(grant_id),
        revoked_at TEXT NOT NULL,
        revoked_at_ms INTEGER NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS approval_grant_revocations_no_update
        BEFORE UPDATE ON approval_grant_revocations
        BEGIN SELECT RAISE(ABORT,'Approval grant revocations are immutable.'); END;
      CREATE TRIGGER IF NOT EXISTS approval_grant_revocations_no_delete
        BEFORE DELETE ON approval_grant_revocations
        BEGIN SELECT RAISE(ABORT,'Approval grant revocations cannot be deleted.'); END;

      CREATE TABLE IF NOT EXISTS approval_action_consumptions (
        grant_id TEXT PRIMARY KEY REFERENCES approval_grants(grant_id),
        consumed_at TEXT NOT NULL,
        consumed_at_ms INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS approval_action_consumptions_no_update
        BEFORE UPDATE ON approval_action_consumptions
        BEGIN SELECT RAISE(ABORT,'Action grant consumptions are immutable.'); END;
      CREATE TRIGGER IF NOT EXISTS approval_action_consumptions_no_delete
        BEFORE DELETE ON approval_action_consumptions
        BEGIN SELECT RAISE(ABORT,'Action grant consumptions cannot be deleted.'); END;

      CREATE TABLE IF NOT EXISTS approval_claims (
        claim_id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL UNIQUE REFERENCES approval_grants(grant_id),
        attempt_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        task_version INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('claimed','dispatching','settled','crash-held','aborted')),
        recovery_state TEXT CHECK(recovery_state IN ('retry-safe','unresolved')),
        outcome TEXT,
        worker_id TEXT,
        reconciled_at_ms INTEGER,
        claimed_at TEXT NOT NULL,
        dispatched_at TEXT,
        settled_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS approval_claims_immutable_identity
        BEFORE UPDATE ON approval_claims
        WHEN NEW.claim_id!=OLD.claim_id OR NEW.grant_id!=OLD.grant_id OR NEW.attempt_id!=OLD.attempt_id OR
             NEW.task_id!=OLD.task_id OR NEW.task_version!=OLD.task_version OR NEW.request_id!=OLD.request_id OR
             NEW.claimed_at!=OLD.claimed_at
        BEGIN SELECT RAISE(ABORT,'Approval claim identity is immutable.'); END;
      CREATE TRIGGER IF NOT EXISTS approval_claims_no_delete
        BEFORE DELETE ON approval_claims
        BEGIN SELECT RAISE(ABORT,'Approval claims cannot be deleted.'); END;

      CREATE TABLE IF NOT EXISTS approval_controller_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        controller_id TEXT NOT NULL,
        owner_generation INTEGER NOT NULL CHECK(owner_generation>=1),
        lease_token_hash TEXT NOT NULL,
        active INTEGER NOT NULL CHECK(active IN (0,1)),
        acquired_at TEXT NOT NULL,
        acquired_at_ms INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approval_audit_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        grant_id TEXT NOT NULL REFERENCES approval_grants(grant_id),
        claim_id TEXT,
        event_type TEXT NOT NULL,
        at TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS approval_audit_no_update
        BEFORE UPDATE ON approval_audit_log
        BEGIN SELECT RAISE(ABORT,'Approval audit log is append-only.'); END;
      CREATE TRIGGER IF NOT EXISTS approval_audit_no_delete
        BEFORE DELETE ON approval_audit_log
        BEGIN SELECT RAISE(ABORT,'Approval audit log is append-only.'); END;`);
  }

  #nowMs() {
    const ms=this.clock();
    if(!Number.isSafeInteger(ms)||ms<0)fail(500,'INVALID_CLOCK','Invalid approval clock value.');
    return ms;
  }

  setPolicyVersion(nextPolicyVersion) {
    this.policyVersion=normalizePolicyVersion(nextPolicyVersion);
    return this.policyVersion;
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value=fn();
      this.db.exec('COMMIT');
      return value;
    } catch(error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  #audit(grantId,claimId,eventType,at,detail={}) {
    this.db.prepare(
      'INSERT INTO approval_audit_log (grant_id,claim_id,event_type,at,detail) VALUES (?,?,?,?,?)'
    ).run(grantId,claimId,eventType,at,JSON.stringify(detail));
  }

  #loadVerifiedGrant(grantId) {
    needUuid(grantId,'grant id');
    const row=this.db.prepare('SELECT * FROM approval_grants WHERE grant_id=?').get(grantId);
    if(!row)return null;
    let payload;
    try {
      payload=JSON.parse(row.payload);
    } catch {
      fail(409,'GRANT_INTEGRITY_ERROR','Stored approval grant is unreadable.');
    }
    if(!isPlainObject(payload)) {
      fail(409,'GRANT_INTEGRITY_ERROR','Stored approval grant has invalid format.');
    }
    const {grantHash,...withoutHash}=payload;
    if(grantHash!==row.grant_hash||sha256Json(withoutHash)!==row.grant_hash) {
      fail(409,'GRANT_INTEGRITY_ERROR','Stored approval grant failed integrity verification.');
    }
    const parsedIssuedAt=parseStrictIsoTimestamp(row.issued_at);
    const parsedExpiresAt=parseStrictIsoTimestamp(row.expires_at);
    if(payload.grantId!==row.grant_id||payload.grantKind!==row.grant_kind||
       payload.policyVersion!==row.policy_version||
       payload.issuedAt!==row.issued_at||parsedIssuedAt!==row.issued_at_ms||
       payload.expiresAt!==row.expires_at||parsedExpiresAt!==row.expires_at_ms||
       !Number.isSafeInteger(row.issued_at_ms)||!Number.isSafeInteger(row.expires_at_ms)||
       row.issued_at_ms>=row.expires_at_ms||
       payload.projectId!==row.project_id||
       (payload.taskId??null)!==row.task_id||
       (payload.requestId??null)!==row.request_id||
       (payload.sessionId??null)!==row.session_id) {
      fail(409,'GRANT_INTEGRITY_ERROR','Stored approval grant metadata is inconsistent.');
    }
    if(row.grant_kind==='attempt') {
      if(row.claim_id===null||row.attempt_id===null||row.task_id===null||row.request_id===null||
         payload.claimId!==row.claim_id||payload.attemptId!==row.attempt_id) {
        fail(409,'GRANT_INTEGRITY_ERROR','Stored attempt grant identity is inconsistent.');
      }
    } else if(row.claim_id!==null||row.attempt_id!==null||row.session_id===null) {
      fail(409,'GRANT_INTEGRITY_ERROR','Stored action grant identity is inconsistent.');
    }
    return {row,grant:deepFreeze(payload)};
  }

  #loadVerifiedClaim(claimId,grant) {
    needUuid(claimId,'claim id');
    const claim=this.db.prepare('SELECT * FROM approval_claims WHERE claim_id=?').get(claimId);
    if(!claim)return null;
    if(claim.grant_id!==grant.grantId) {
      if(grant.grantKind==='attempt'&&claim.claim_id===grant.claimId) {
        fail(409,'CLAIM_INTEGRITY_ERROR','Stored approval claim does not match its immutable grant.');
      }
      return null;
    }
    if(grant.grantKind!=='attempt'||
       claim.claim_id!==grant.claimId||
       claim.attempt_id!==grant.attemptId||
       claim.task_id!==grant.taskId||
       claim.task_version!==grant.taskVersion||
       claim.request_id!==grant.requestId||
       parseStrictIsoTimestamp(claim.claimed_at)===null) {
      fail(409,'CLAIM_INTEGRITY_ERROR','Stored approval claim failed grant-to-claim verification.');
    }
    return claim;
  }

  #checkActiveTiming(row,nowMs) {
    const revoked=this.db.prepare('SELECT revoked_at,reason FROM approval_grant_revocations WHERE grant_id=?').get(row.grant_id);
    if(revoked)fail(409,'GRANT_REVOKED','This approval grant has been revoked.');
    if(nowMs<row.issued_at_ms)fail(409,'GRANT_NOT_YET_VALID','Approval grant issue time is in the future.');
    if(nowMs>=row.expires_at_ms)fail(409,'GRANT_EXPIRED','This approval grant has expired.');
  }

  issueAttemptGrant(input) {
    if(!isPlainObject(input))fail(400,'INVALID_APPROVAL_INPUT','An approval grant input object is required.');
    const taskId=needUuid(input.taskId,'task id');
    const submission=prepareRunSubmission(taskId,input.submission);
    if(!submission)fail(400,'MISSING_REQUEST_ID','A keyed run submission with requestId is required.');
    const routeRevision=approvedRouteRevision(input.submission);
    if(!routeRevision)fail(400,'MISSING_ROUTE_REVISION','An approved routeRevision is required for an attempt grant.');

    const projectId=normalizeProjectId(input.projectId);
    const project=this.projects.requireProject(projectId);
    if(Object.hasOwn(input,'projectRevision')&&input.projectRevision!==undefined) {
      const expectedRev=normalizeProjectRevision(input.projectRevision);
      if(expectedRev!==project.revision) {
        fail(409,'PROJECT_REVISION_CHANGED','Project revision changed before approval.');
      }
    }
    const projectRevision=project.revision;
    if(project.root!==null) {
      resolveLocalRoot(project.root,{useTime:false});
    }
    const destination=normalizeDestination(input.destination);
    const accountRef=input.accountRef===undefined||input.accountRef===null?null:normalizeAccountRef(input.accountRef);
    const approvedRoots=resolveAndVerifyRoots(project,input.approvedRoots,{useTime:false});
    const permissions=normalizePermissions(input.permissions);
    validateRemotePermission(destination,permissions);
    const testPlan=normalizeTestPlan(input.testPlan);
    const testPlanHash=sha256Json(testPlan);
    const requestedPolicy=input.policyVersion===undefined?this.policyVersion:normalizePolicyVersion(input.policyVersion);
    if(requestedPolicy!==this.policyVersion) {
      fail(409,'POLICY_CHANGED','Approval policy version changed. Refresh and re-approve.');
    }
    const sessionId=input.sessionId===undefined||input.sessionId===null?null:needSessionId(input.sessionId);
    const ttlMs=input.ttlMs===undefined?DEFAULT_ATTEMPT_GRANT_TTL_MS:input.ttlMs;
    if(!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>MAX_ATTEMPT_GRANT_TTL_MS) {
      fail(400,'INVALID_TTL','Attempt grant lifetime must be between 1 ms and 1 hour.');
    }

    const engine=input.submission.engine??(input.submission.model==='fixture'?'fixture':'ollama');
    const backend=input.submission.backend??(engine==='fixture'?'fixture':'ollama');

    return this.transaction(()=>{
      const nowMs=this.#nowMs();
      const nowIso=new Date(nowMs).toISOString();

      const existingRow=this.db.prepare(
        'SELECT grant_id FROM approval_grants WHERE task_id=? AND request_id=?'
      ).get(taskId,submission.requestId);

      const candidateBinding=attemptBindingKey({
        submissionFingerprint:submission.fingerprint,
        projectId,
        projectRevision,
        destination,
        accountRef,
        approvedRoots,
        permissions,
        testPlanHash,
        policyVersion:requestedPolicy,
      });

      if(existingRow) {
        const loaded=this.#loadVerifiedGrant(existingRow.grant_id);
        if(loaded.grant.grantKind!=='attempt'||attemptBindingKey(loaded.grant)!==candidateBinding) {
          fail(409,'SUBMISSION_CONFLICT','This request ID belongs to different approved inputs.');
        }
        const claimRow=this.#loadVerifiedClaim(loaded.grant.claimId,loaded.grant);
        if(!claimRow)fail(409,'CLAIM_INTEGRITY_ERROR','Approval claim missing for replayed attempt grant.');
        return Object.freeze({replayed:true,grant:loaded.grant,claim:rowToClaim(claimRow)});
      }

      const activeClaims=this.db.prepare(
        `SELECT c.claim_id,c.grant_id,c.phase,c.recovery_state,g.expires_at_ms,
                (SELECT 1 FROM approval_grant_revocations r WHERE r.grant_id=c.grant_id) AS revoked
         FROM approval_claims c
         JOIN approval_grants g ON g.grant_id=c.grant_id
         WHERE c.task_id=? AND c.phase IN ('claimed','dispatching','crash-held')`
      ).all(taskId);

      for(const existing of activeClaims) {
        const existingGrant=this.#loadVerifiedGrant(existing.grant_id);
        if(!existingGrant)fail(409,'CLAIM_INTEGRITY_ERROR','Active claim references missing grant.');
        this.#loadVerifiedClaim(existing.claim_id,existingGrant.grant);
        if(existing.phase==='crash-held'&&existing.recovery_state==='unresolved') {
          fail(409,'UNRESOLVED_CLAIM_HOLD','An earlier claim has an unresolved crash hold. Reconcile it before approving new work.');
        }
        if(existing.phase==='dispatching') {
          fail(409,'CLAIM_CONFLICT','Another approved attempt is currently dispatching for this task.');
        }
        if(existing.phase==='claimed') {
          if(existing.revoked||nowMs>=existing.expires_at_ms) {
            this.db.prepare(
              "UPDATE approval_claims SET phase='aborted',updated_at=? WHERE claim_id=? AND phase='claimed'"
            ).run(nowIso,existing.claim_id);
            this.#audit(existing.grant_id,existing.claim_id,'claim.superseded',nowIso,{
              reason:existing.revoked?'revoked':'expired',
            });
          } else {
            fail(409,'CLAIM_CONFLICT','An active approved claim already exists for this task.');
          }
        }
      }

      const grantId=needUuid(this.nonce(),'grant id');
      const claimId=needUuid(this.nonce(),'claim id');
      const attemptId=needUuid(this.nonce(),'attempt id');
      const expiresAtMs=nowMs+ttlMs;
      const expiresAt=new Date(expiresAtMs).toISOString();

      const withoutHash={
        grantId,
        grantKind:'attempt',
        claimId,
        attemptId,
        requestId:submission.requestId,
        taskId,
        taskVersion:input.submission.version,
        projectId,
        projectRevision,
        sourceHash:input.submission.sourceHash,
        routeRevision,
        model:input.submission.model,
        engine,
        backend,
        modelDigest:input.submission.modelDigest??null,
        modelFingerprint:input.submission.modelFingerprint??null,
        destination,
        accountRef,
        approvedRoots,
        permissions,
        testPlan,
        testPlanHash,
        submissionFingerprint:submission.fingerprint,
        policyVersion:requestedPolicy,
        sessionId,
        issuedAt:nowIso,
        expiresAt,
      };
      const grantHash=sha256Json(withoutHash);
      const grant=deepFreeze({...withoutHash,grantHash});

      this.db.prepare(
        `INSERT INTO approval_grants (
           grant_id,grant_kind,task_id,project_id,request_id,claim_id,attempt_id,
           session_id,policy_version,issued_at,issued_at_ms,expires_at,expires_at_ms,grant_hash,payload
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        grantId,'attempt',taskId,projectId,submission.requestId,claimId,attemptId,
        sessionId,requestedPolicy,nowIso,nowMs,expiresAt,expiresAtMs,grantHash,JSON.stringify(grant)
      );

      this.db.prepare(
        `INSERT INTO approval_claims (
           claim_id,grant_id,attempt_id,task_id,task_version,request_id,
           phase,recovery_state,outcome,worker_id,reconciled_at_ms,claimed_at,dispatched_at,settled_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        claimId,grantId,attemptId,taskId,input.submission.version,submission.requestId,
        'claimed',null,null,null,null,nowIso,null,null,nowIso
      );

      this.#audit(grantId,claimId,'grant.issued_and_claimed',nowIso,{
        taskId,taskVersion:input.submission.version,projectId,projectRevision,policyVersion:requestedPolicy,
      });

      const claimRow=this.db.prepare('SELECT * FROM approval_claims WHERE claim_id=?').get(claimId);
      return Object.freeze({replayed:false,grant,claim:rowToClaim(claimRow)});
    });
  }

  beginDispatch({grantId,claimId,currentScope,policyVersion=this.policyVersion,workerId=null}) {
    needUuid(grantId,'grant id');
    needUuid(claimId,'claim id');
    if(!isPlainObject(currentScope))fail(400,'MISSING_CURRENT_SCOPE','Current task and route scope is required before dispatch.');
    for(const field of REQUIRED_DISPATCH_SCOPE_FIELDS) {
      requireOwnField(currentScope,field,'MISSING_CURRENT_SCOPE','currentScope field');
    }
    const checkedPolicy=normalizePolicyVersion(policyVersion);
    const normalizedWorkerId=workerId===null||workerId===undefined?null:needText(workerId,120,'worker id');

    const scopeTaskId=needUuid(currentScope.taskId,'scope task id');
    if(!Number.isSafeInteger(currentScope.taskVersion)||currentScope.taskVersion<0) {
      fail(400,'INVALID_TASK_VERSION','Current scope taskVersion must be a non-negative integer.');
    }
    const scopeProjectId=normalizeProjectId(currentScope.projectId);
    const scopeProjectRevision=normalizeProjectRevision(currentScope.projectRevision);
    if(typeof currentScope.sourceHash!=='string'||!DIGEST_PATTERN.test(currentScope.sourceHash)) {
      fail(400,'INVALID_SOURCE_HASH','Current scope sourceHash must be a 64-character lowercase hex digest.');
    }
    if(typeof currentScope.routeRevision!=='string'||!DIGEST_PATTERN.test(currentScope.routeRevision)) {
      fail(400,'INVALID_ROUTE_REVISION','Current scope routeRevision must be a 64-character lowercase hex digest.');
    }
    const scopeModel=needText(currentScope.model,100,'scope model');
    const scopeEngine=needText(currentScope.engine,40,'scope engine');
    const scopeBackend=needText(currentScope.backend,40,'scope backend');
    const scopeModelDigest=currentScope.modelDigest===null?null:needText(currentScope.modelDigest,64,'scope modelDigest');
    const scopeModelFingerprint=currentScope.modelFingerprint===null?null:needText(currentScope.modelFingerprint,64,'scope modelFingerprint');
    const scopeDestination=normalizeDestination(currentScope.destination);
    const scopeAccountRef=normalizeAccountRef(currentScope.accountRef);
    if(!Array.isArray(currentScope.approvedRoots)||currentScope.approvedRoots.length>64) {
      fail(400,'INVALID_APPROVED_ROOTS','Current scope approvedRoots must be a bounded list.');
    }
    for(const root of currentScope.approvedRoots) {
      validateLocalPathSyntax(root,'INVALID_APPROVED_ROOTS','approved root path');
    }
    const scopePermissions=normalizePermissions(currentScope.permissions);
    const scopeTestPlan=normalizeTestPlan(currentScope.testPlan);

    return this.transaction(()=>{
      const nowMs=this.#nowMs();
      const nowIso=new Date(nowMs).toISOString();
      const loaded=this.#loadVerifiedGrant(grantId);
      if(!loaded||loaded.grant.grantKind!=='attempt')fail(404,'GRANT_NOT_FOUND','Approval grant not found.');
      const {row,grant}=loaded;

      const claim=this.#loadVerifiedClaim(claimId,grant);
      if(!claim)fail(404,'CLAIM_NOT_FOUND','Approval claim not found.');

      this.#checkActiveTiming(row,nowMs);

      if(checkedPolicy!==grant.policyVersion||this.policyVersion!==grant.policyVersion) {
        fail(409,'POLICY_CHANGED','Approval policy version changed. Fresh authorization is required.');
      }

      if(claim.phase==='dispatching')fail(409,'ALREADY_DISPATCHED','This claim has already begun dispatch.');
      if(claim.phase!=='claimed')fail(409,'CLAIM_NOT_DISPATCHABLE','This claim is no longer eligible for dispatch.');

      const project=this.projects.getProject(grant.projectId);
      if(!project)fail(409,'PROJECT_NOT_FOUND','Registered project no longer exists.');
      if(project.revision!==grant.projectRevision||scopeProjectRevision!==grant.projectRevision) {
        fail(409,'PROJECT_REVISION_CHANGED','The project revision changed after approval.');
      }

      if(scopeTaskId!==grant.taskId||currentScope.taskVersion!==grant.taskVersion) {
        fail(409,'SCOPE_CHANGED','The task or task version changed after approval.');
      }
      if(scopeProjectId!==grant.projectId) {
        fail(409,'SCOPE_CHANGED','The task project changed after approval.');
      }
      if(currentScope.sourceHash!==grant.sourceHash) {
        fail(409,'SCOPE_CHANGED','The approved source snapshot changed after approval.');
      }
      if(currentScope.routeRevision!==grant.routeRevision) {
        fail(409,'ROUTE_CHANGED','The selected route revision changed after approval.');
      }
      if(scopeModel!==grant.model||scopeEngine!==grant.engine||scopeBackend!==grant.backend||
         scopeModelDigest!==grant.modelDigest||scopeModelFingerprint!==grant.modelFingerprint) {
        fail(409,'ROUTE_CHANGED','The approved model or engine identity changed.');
      }
      if(JSON.stringify(scopeDestination)!==JSON.stringify(grant.destination)) {
        fail(409,'DESTINATION_CHANGED','The provider destination changed after approval.');
      }
      if(scopeAccountRef!==grant.accountRef) {
        fail(409,'SCOPE_CHANGED','The account reference changed after approval.');
      }

      const verifiedGrantRoots=resolveAndVerifyRoots(project,grant.approvedRoots,{useTime:true});
      const verifiedScopeRoots=resolveAndVerifyRoots(project,currentScope.approvedRoots,{useTime:true});
      if(JSON.stringify(verifiedScopeRoots)!==JSON.stringify(grant.approvedRoots)||
         JSON.stringify(verifiedGrantRoots)!==JSON.stringify(grant.approvedRoots)) {
        fail(409,'SCOPE_CHANGED','The approved project roots changed after approval.');
      }
      if(JSON.stringify(scopePermissions)!==JSON.stringify(grant.permissions)) {
        fail(409,'SCOPE_CHANGED','The approved permissions changed after approval.');
      }
      if(sha256Json(scopeTestPlan)!==grant.testPlanHash) {
        fail(409,'SCOPE_CHANGED','The approved test plan changed after approval.');
      }

      const updated=this.db.prepare(
        "UPDATE approval_claims SET phase='dispatching',worker_id=?,dispatched_at=?,updated_at=? WHERE claim_id=? AND phase='claimed'"
      ).run(normalizedWorkerId,nowIso,nowIso,claimId);
      if(updated.changes!==1)fail(409,'CLAIM_NOT_DISPATCHABLE','The claim state changed concurrently.');

      this.#audit(grantId,claimId,'claim.dispatching',nowIso,{
        attemptId:grant.attemptId,
        workerId:normalizedWorkerId,
      });
      const updatedClaim=this.db.prepare('SELECT * FROM approval_claims WHERE claim_id=?').get(claimId);
      return Object.freeze({dispatched:true,grant,claim:rowToClaim(updatedClaim)});
    });
  }

  completeDispatch({grantId,claimId,outcome}) {
    needUuid(grantId,'grant id');
    needUuid(claimId,'claim id');
    if(!['succeeded','failed','cancelled'].includes(outcome)) {
      fail(400,'INVALID_OUTCOME','Unsupported dispatch settlement outcome.');
    }
    return this.transaction(()=>{
      const nowIso=new Date(this.#nowMs()).toISOString();
      const loaded=this.#loadVerifiedGrant(grantId);
      if(!loaded||loaded.grant.grantKind!=='attempt')fail(404,'CLAIM_NOT_FOUND','Approval claim not found.');
      const claim=this.#loadVerifiedClaim(claimId,loaded.grant);
      if(!claim)fail(404,'CLAIM_NOT_FOUND','Approval claim not found.');
      if(claim.phase==='settled') {
        if(claim.outcome===outcome)return Object.freeze({duplicate:true,claim:rowToClaim(claim)});
        fail(409,'SETTLEMENT_CONFLICT','This claim was already settled with a different outcome.');
      }
      if(claim.phase!=='dispatching')fail(409,'CLAIM_NOT_DISPATCHING','Only dispatching claims can be settled.');
      this.db.prepare(
        "UPDATE approval_claims SET phase='settled',outcome=?,settled_at=?,updated_at=? WHERE claim_id=?"
      ).run(outcome,nowIso,nowIso,claimId);
      this.#audit(grantId,claimId,'claim.settled',nowIso,{outcome});
      return Object.freeze({
        duplicate:false,
        claim:rowToClaim(this.db.prepare('SELECT * FROM approval_claims WHERE claim_id=?').get(claimId)),
      });
    });
  }

  acquireControllerLease({controllerId,leaseToken=this.nonce(),ttlMs=CONTROLLER_LEASE_TTL_MS}={}) {
    const cleanControllerId=needText(controllerId,80,'controller id','INVALID_CONTROLLER_ID');
    if(!OPAQUE_ID_PATTERN.test(cleanControllerId)) {
      fail(400,'INVALID_CONTROLLER_ID','Controller id must be an opaque identifier.');
    }
    if(typeof leaseToken!=='string'||CONTROL_CHARS_PATTERN.test(leaseToken)||leaseToken.length<16||leaseToken.length>200) {
      fail(400,'INVALID_LEASE_TOKEN','Controller lease token must be between 16 and 200 characters.');
    }
    if(!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>MAX_ATTEMPT_GRANT_TTL_MS) {
      fail(400,'INVALID_TTL','Controller lease lifetime must be between 1 ms and 1 hour.');
    }
    const tokenHash=sha256Text(leaseToken);
    return this.transaction(()=>{
      const nowMs=this.#nowMs();
      const nowIso=new Date(nowMs).toISOString();
      const expiresAtMs=nowMs+ttlMs;
      const expiresAt=new Date(expiresAtMs).toISOString();
      const existing=this.db.prepare('SELECT owner_generation FROM approval_controller_state WHERE singleton=1').get();
      const ownerGeneration=existing?existing.owner_generation+1:1;
      this.db.prepare(
        `INSERT INTO approval_controller_state (
           singleton,controller_id,owner_generation,lease_token_hash,active,
           acquired_at,acquired_at_ms,expires_at,expires_at_ms
         ) VALUES (1,?,?,?,1,?,?,?,?)
         ON CONFLICT(singleton) DO UPDATE SET
           controller_id=excluded.controller_id,
           owner_generation=excluded.owner_generation,
           lease_token_hash=excluded.lease_token_hash,
           active=1,
           acquired_at=excluded.acquired_at,
           acquired_at_ms=excluded.acquired_at_ms,
           expires_at=excluded.expires_at,
           expires_at_ms=excluded.expires_at_ms`
      ).run(cleanControllerId,ownerGeneration,tokenHash,nowIso,nowMs,expiresAt,expiresAtMs);
      return Object.freeze({
        controllerId:cleanControllerId,
        ownerGeneration,
        leaseToken,
        acquiredAt:nowIso,
        expiresAt,
      });
    });
  }

  reconcileInterrupted() {
    return this.transaction(()=>{
      const nowMs=this.#nowMs();
      const nowIso=new Date(nowMs).toISOString();
      // Invalidate any pre-restart controller lease so stale controllers cannot resolve crash holds.
      this.db.prepare('UPDATE approval_controller_state SET active=0 WHERE singleton=1').run();

      const inFlight=this.db.prepare(
        "SELECT * FROM approval_claims WHERE phase IN ('claimed','dispatching') ORDER BY claimed_at ASC"
      ).all();
      let retrySafeCount=0;
      let unresolvedCount=0;
      const claims=[];
      for(const row of inFlight) {
        const loaded=this.#loadVerifiedGrant(row.grant_id);
        if(!loaded)fail(409,'CLAIM_INTEGRITY_ERROR','Interrupted claim references missing grant.');
        this.#loadVerifiedClaim(row.claim_id,loaded.grant);
        const recoveryState=row.phase==='claimed'?'retry-safe':'unresolved';
        if(recoveryState==='retry-safe')retrySafeCount++;
        else unresolvedCount++;
        this.db.prepare(
          "UPDATE approval_claims SET phase='crash-held',recovery_state=?,reconciled_at_ms=?,updated_at=? WHERE claim_id=?"
        ).run(recoveryState,nowMs,nowIso,row.claim_id);
        this.#audit(row.grant_id,row.claim_id,'claim.crash_held',nowIso,{
          previousPhase:row.phase,
          recoveryState,
        });
        claims.push(rowToClaim(this.db.prepare('SELECT * FROM approval_claims WHERE claim_id=?').get(row.claim_id)));
      }
      return Object.freeze({retrySafeCount,unresolvedCount,claims:Object.freeze(claims)});
    });
  }

  resolveCrashHold(input) {
    if(!isPlainObject(input))fail(400,'INVALID_RESOLUTION','Crash-hold resolution input object is required.');
    const claimId=needUuid(input.claimId,'claim id');
    const resolution=input.resolution;
    if(!['confirmed-stopped','confirmed-settled'].includes(resolution)) {
      fail(400,'INVALID_RESOLUTION','Explicit crash-hold resolution (confirmed-stopped or confirmed-settled) is required.');
    }

    return this.transaction(()=>{
      const nowMs=this.#nowMs();
      const nowIso=new Date(nowMs).toISOString();
      const claimRow=this.db.prepare('SELECT * FROM approval_claims WHERE claim_id=?').get(claimId);
      if(!claimRow)fail(404,'CLAIM_NOT_FOUND','Approval claim not found.');
      const loaded=this.#loadVerifiedGrant(claimRow.grant_id);
      if(!loaded)fail(409,'CLAIM_INTEGRITY_ERROR','Approval claim references missing grant.');
      const claim=this.#loadVerifiedClaim(claimId,loaded.grant);
      if(claim.phase!=='crash-held')fail(409,'CLAIM_NOT_HELD','This claim is not in a crash-held state.');

      // 1. Verify current active controller ownership against persisted host lease state.
      const ownership=input.ownership;
      if(!isPlainObject(ownership)||
         typeof ownership.controllerId!=='string'||!OPAQUE_ID_PATTERN.test(ownership.controllerId)||
         !Number.isSafeInteger(ownership.ownerGeneration)||ownership.ownerGeneration<1||
         typeof ownership.leaseToken!=='string'||CONTROL_CHARS_PATTERN.test(ownership.leaseToken)||
         ownership.leaseToken.length<16||ownership.leaseToken.length>200) {
        fail(409,'UNVERIFIED_CONTROLLER_OWNERSHIP','Verifiable current controller ownership is required to release a crash hold.');
      }
      const controller=this.db.prepare('SELECT * FROM approval_controller_state WHERE singleton=1').get();
      if(!controller||controller.active!==1) {
        fail(409,'UNVERIFIED_CONTROLLER_OWNERSHIP','No active controller lease is registered to authorize crash-hold release.');
      }
      if(nowMs>=controller.expires_at_ms) {
        fail(409,'CONTROLLER_LEASE_EXPIRED','The controller lease has expired.');
      }
      if(controller.controller_id!==ownership.controllerId||
         controller.owner_generation!==ownership.ownerGeneration||
         controller.lease_token_hash!==sha256Text(ownership.leaseToken)||
         (claim.reconciled_at_ms!==null&&controller.acquired_at_ms<claim.reconciled_at_ms)) {
        fail(409,'UNVERIFIED_CONTROLLER_OWNERSHIP','Controller ownership proof does not match the current active controller lease.');
      }

      // 2. Verify positive termination or settlement evidence for the held attempt.
      const evidence=input.evidence;
      if(!isPlainObject(evidence)||evidence.attemptId!==claim.attempt_id) {
        fail(409,'INSUFFICIENT_RECOVERY_EVIDENCE','Crash-hold release requires positive recovery evidence matching the held attemptId.');
      }
      if(claim.worker_id!==null&&evidence.workerId!==claim.worker_id) {
        fail(409,'INSUFFICIENT_RECOVERY_EVIDENCE','Recovery evidence workerId does not match the dispatched worker.');
      }
      const claimedAtMs=parseStrictIsoTimestamp(claim.claimed_at);

      if(resolution==='confirmed-stopped') {
        const hasValidWorker=typeof evidence.workerId==='string'&&!CONTROL_CHARS_PATTERN.test(evidence.workerId)&&evidence.workerId.trim().length>0;
        const exitedAtMs=parseStrictIsoTimestamp(evidence.exitedAt);
        const hasExitIndicator=Number.isSafeInteger(evidence.exitCode)||
          (typeof evidence.signal==='string'&&!CONTROL_CHARS_PATTERN.test(evidence.signal)&&evidence.signal.trim().length>0);
        if(!hasValidWorker||
           evidence.processExited!==true||
           evidence.cleanup!=='confirmed'||
           !hasExitIndicator||
           exitedAtMs===null||exitedAtMs<claimedAtMs||exitedAtMs>nowMs) {
          fail(409,'INSUFFICIENT_RECOVERY_EVIDENCE','Positive worker exit and confirmed cleanup evidence are required before releasing a crash hold.');
        }
      } else {
        const dispatchedAtMs=parseStrictIsoTimestamp(claim.dispatched_at);
        const settledAtMs=parseStrictIsoTimestamp(evidence.settledAt);
        if(dispatchedAtMs===null||
           evidence.settled!==true||
           !['succeeded','failed','cancelled'].includes(evidence.settlementOutcome)||
           typeof evidence.receiptDigest!=='string'||!DIGEST_PATTERN.test(evidence.receiptDigest)||
           settledAtMs===null||settledAtMs<dispatchedAtMs||settledAtMs>nowMs) {
          fail(409,'INSUFFICIENT_RECOVERY_EVIDENCE','Verified settlement receipt evidence is required for confirmed-settled resolution.');
        }
      }

      const nextPhase=resolution==='confirmed-settled'?'settled':'aborted';
      const settledAt=resolution==='confirmed-settled'?nowIso:claim.settled_at;
      this.db.prepare(
        'UPDATE approval_claims SET phase=?,outcome=?,settled_at=?,updated_at=? WHERE claim_id=?'
      ).run(nextPhase,resolution,settledAt,nowIso,claimId);
      this.#audit(claim.grant_id,claimId,'claim.crash_hold_resolved',nowIso,{
        resolution,
        nextPhase,
        controllerId:ownership.controllerId,
        ownerGeneration:ownership.ownerGeneration,
        attemptId:claim.attempt_id,
        workerId:evidence.workerId??claim.worker_id??null,
      });
      return rowToClaim(this.db.prepare('SELECT * FROM approval_claims WHERE claim_id=?').get(claimId));
    });
  }

  issueActionGrant(input) {
    if(!isPlainObject(input))fail(400,'INVALID_ACTION_GRANT','An action grant input object is required.');
    if(typeof input.action!=='string'||!ACTION_PATTERN.test(input.action)) {
      fail(400,'INVALID_ACTION','Specify a valid action identifier.');
    }
    const sessionId=needSessionId(input.sessionId);
    const target=normalizeActionTarget(input.target);
    const targetHash=sha256Json(target);
    const destination=normalizeDestination(input.destination);
    const taskId=needUuid(input.taskId,'task id');
    if(!Number.isSafeInteger(input.taskVersion)||input.taskVersion<0) {
      fail(400,'INVALID_TASK_VERSION','Task version must be a non-negative integer.');
    }
    const taskVersion=input.taskVersion;
    const projectId=normalizeProjectId(input.projectId);
    const project=this.projects.requireProject(projectId);
    if(Object.hasOwn(input,'projectRevision')&&input.projectRevision!==undefined) {
      const expectedRev=normalizeProjectRevision(input.projectRevision);
      if(expectedRev!==project.revision) {
        fail(409,'PROJECT_REVISION_CHANGED','Project revision changed before action approval.');
      }
    }
    const projectRevision=project.revision;
    if(project.root!==null) {
      resolveLocalRoot(project.root,{useTime:false});
    }
    const sourceHash=input.sourceHash;
    if(typeof sourceHash!=='string'||!DIGEST_PATTERN.test(sourceHash)) {
      fail(400,'INVALID_SOURCE_HASH','Source hash must be a 64-character lowercase hex digest.');
    }
    const routeRevision=input.routeRevision;
    if(typeof routeRevision!=='string'||!DIGEST_PATTERN.test(routeRevision)) {
      fail(400,'INVALID_ROUTE_REVISION','Route revision must be a 64-character lowercase hex digest.');
    }
    requireOwnField(input,'accountRef','INVALID_TEXT','action grant accountRef');
    const accountRef=normalizeAccountRef(input.accountRef);
    const approvedRoots=resolveAndVerifyRoots(project,input.approvedRoots,{useTime:false});
    const permissions=normalizePermissions(input.permissions);
    validateRemotePermission(destination,permissions);
    const requestedPolicy=input.policyVersion===undefined?this.policyVersion:normalizePolicyVersion(input.policyVersion);
    if(requestedPolicy!==this.policyVersion) {
      fail(409,'POLICY_CHANGED','Approval policy version changed. Refresh and re-approve.');
    }
    const requestId=input.requestId===undefined||input.requestId===null?null:needUuid(input.requestId,'request id');
    const ttlMs=input.ttlMs===undefined?ACTION_GRANT_TTL_MS:input.ttlMs;
    if(!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>ACTION_GRANT_TTL_MS) {
      fail(400,'INVALID_ACTION_TTL','Single-use action grant lifetime must be between 1 ms and 5 minutes.');
    }

    return this.transaction(()=>{
      const nowMs=this.#nowMs();
      const nowIso=new Date(nowMs).toISOString();

      if(requestId!==null) {
        const existing=this.db.prepare(
          'SELECT grant_id FROM approval_grants WHERE task_id=? AND request_id=?'
        ).get(taskId,requestId);
        if(existing) {
          const loaded=this.#loadVerifiedGrant(existing.grant_id);
          const candidateBinding=actionBindingKey({
            action:input.action,
            destination,
            taskId,
            taskVersion,
            projectId,
            projectRevision,
            sourceHash,
            routeRevision,
            accountRef,
            approvedRoots,
            permissions,
            targetHash,
            sessionId,
            policyVersion:requestedPolicy,
          });
          if(loaded.grant.grantKind!=='action'||actionBindingKey(loaded.grant)!==candidateBinding) {
            fail(409,'SUBMISSION_CONFLICT','This action request ID belongs to different parameters.');
          }
          return loaded.grant;
        }
      }

      const grantId=needUuid(this.nonce(),'grant id');
      const expiresAtMs=nowMs+ttlMs;
      const expiresAt=new Date(expiresAtMs).toISOString();
      const withoutHash={
        grantId,
        grantKind:'action',
        action:input.action,
        target,
        targetHash,
        destination,
        taskId,
        taskVersion,
        projectId,
        projectRevision,
        sourceHash,
        routeRevision,
        accountRef,
        approvedRoots,
        permissions,
        requestId,
        sessionId,
        policyVersion:requestedPolicy,
        issuedAt:nowIso,
        expiresAt,
      };
      const grantHash=sha256Json(withoutHash);
      const grant=deepFreeze({...withoutHash,grantHash});

      this.db.prepare(
        `INSERT INTO approval_grants (
           grant_id,grant_kind,task_id,project_id,request_id,claim_id,attempt_id,
           session_id,policy_version,issued_at,issued_at_ms,expires_at,expires_at_ms,grant_hash,payload
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        grantId,'action',taskId,projectId,requestId,null,null,
        sessionId,requestedPolicy,nowIso,nowMs,expiresAt,expiresAtMs,grantHash,JSON.stringify(grant)
      );
      this.#audit(grantId,null,'action_grant.issued',nowIso,{
        action:input.action,target,destination,projectId,projectRevision,sessionId,policyVersion:requestedPolicy,
      });
      return grant;
    });
  }

  consumeActionGrant(input) {
    if(!isPlainObject(input))fail(400,'INVALID_ACTION_CONSUME','Action grant consumption parameters are required.');
    const grantId=needUuid(input.grantId,'grant id');
    const sessionId=needSessionId(input.sessionId);
    if(typeof input.action!=='string'||!ACTION_PATTERN.test(input.action)) {
      fail(400,'INVALID_ACTION','Specify a valid action identifier.');
    }
    const target=normalizeActionTarget(input.target);
    const targetHash=sha256Json(target);
    const destination=normalizeDestination(input.destination);
    const checkedPolicy=normalizePolicyVersion(input.policyVersion??this.policyVersion);
    const taskId=needUuid(input.taskId,'task id');
    if(!Number.isSafeInteger(input.taskVersion)||input.taskVersion<0) {
      fail(400,'INVALID_TASK_VERSION','Task version must be a non-negative integer.');
    }
    const projectId=normalizeProjectId(input.projectId);
    requireOwnField(input,'projectRevision','INVALID_PROJECT_REVISION','action grant projectRevision');
    const reqProjectRevision=normalizeProjectRevision(input.projectRevision);
    if(typeof input.sourceHash!=='string'||!DIGEST_PATTERN.test(input.sourceHash)) {
      fail(400,'INVALID_SOURCE_HASH','Source hash must be a 64-character lowercase hex digest.');
    }
    if(typeof input.routeRevision!=='string'||!DIGEST_PATTERN.test(input.routeRevision)) {
      fail(400,'INVALID_ROUTE_REVISION','Route revision must be a 64-character lowercase hex digest.');
    }
    requireOwnField(input,'accountRef','INVALID_TEXT','action grant accountRef');
    const accountRef=normalizeAccountRef(input.accountRef);
    if(!Array.isArray(input.approvedRoots)||input.approvedRoots.length>64) {
      fail(400,'INVALID_APPROVED_ROOTS','Approved roots must be a bounded list.');
    }
    for(const root of input.approvedRoots) {
      validateLocalPathSyntax(root,'INVALID_APPROVED_ROOTS','approved root path');
    }
    const permissions=normalizePermissions(input.permissions);

    return this.transaction(()=>{
      const nowMs=this.#nowMs();
      const nowIso=new Date(nowMs).toISOString();
      const loaded=this.#loadVerifiedGrant(grantId);
      if(!loaded||loaded.grant.grantKind!=='action')fail(404,'GRANT_NOT_FOUND','Action grant not found.');
      const {row,grant}=loaded;

      const consumed=this.db.prepare('SELECT consumed_at FROM approval_action_consumptions WHERE grant_id=?').get(grantId);
      if(consumed)fail(409,'GRANT_ALREADY_USED','This single-use action grant has already been consumed.');

      this.#checkActiveTiming(row,nowMs);

      if(checkedPolicy!==grant.policyVersion||this.policyVersion!==grant.policyVersion) {
        fail(409,'POLICY_CHANGED','Approval policy version changed. Fresh authorization is required.');
      }
      if(sessionId!==grant.sessionId) {
        fail(409,'SESSION_MISMATCH','Action grant session does not match the current authenticated session.');
      }
      if(input.action!==grant.action)fail(409,'ACTION_MISMATCH','Grant action does not match the requested operation.');
      if(targetHash!==grant.targetHash) {
        fail(409,'TARGET_MISMATCH','The target or target digest changed after the action grant was issued.');
      }
      if(JSON.stringify(destination)!==JSON.stringify(grant.destination)) {
        fail(409,'DESTINATION_CHANGED','The destination changed after the action grant was issued.');
      }
      const project=this.projects.getProject(grant.projectId);
      if(!project)fail(409,'PROJECT_NOT_FOUND','Registered project no longer exists.');
      if(project.revision!==grant.projectRevision||reqProjectRevision!==grant.projectRevision) {
        fail(409,'PROJECT_REVISION_CHANGED','The project revision changed after the action grant was issued.');
      }
      if(taskId!==grant.taskId||input.taskVersion!==grant.taskVersion||
         projectId!==grant.projectId||input.sourceHash!==grant.sourceHash||
         input.routeRevision!==grant.routeRevision||accountRef!==grant.accountRef||
         JSON.stringify(permissions)!==JSON.stringify(grant.permissions)) {
        fail(409,'SCOPE_CHANGED','The approved scope changed after the action grant was issued.');
      }
      const verifiedGrantRoots=resolveAndVerifyRoots(project,grant.approvedRoots,{useTime:true});
      const verifiedInputRoots=resolveAndVerifyRoots(project,input.approvedRoots,{useTime:true});
      if(JSON.stringify(verifiedInputRoots)!==JSON.stringify(grant.approvedRoots)||
         JSON.stringify(verifiedGrantRoots)!==JSON.stringify(grant.approvedRoots)) {
        fail(409,'SCOPE_CHANGED','The approved roots changed after the action grant was issued.');
      }

      this.db.prepare(
        'INSERT INTO approval_action_consumptions (grant_id,consumed_at,consumed_at_ms) VALUES (?,?,?)'
      ).run(grantId,nowIso,nowMs);
      this.#audit(grantId,null,'action_grant.consumed',nowIso,{
        action:grant.action,target:grant.target,destination:grant.destination,sessionId:grant.sessionId,
      });
      return Object.freeze({consumed:true,grant});
    });
  }

  revokeSession(sessionId,{reason='workspace-locked'}={}) {
    const cleanSessionId=needSessionId(sessionId);
    const cleanReason=needText(reason,120,'revocation reason');
    return this.transaction(()=>{
      const nowMs=this.#nowMs();
      const nowIso=new Date(nowMs).toISOString();
      const pending=this.db.prepare(
        `SELECT g.grant_id
         FROM approval_grants g
         LEFT JOIN approval_grant_revocations r ON r.grant_id=g.grant_id
         LEFT JOIN approval_action_consumptions c ON c.grant_id=g.grant_id
         WHERE g.grant_kind='action' AND g.session_id=? AND r.grant_id IS NULL AND c.grant_id IS NULL`
      ).all(cleanSessionId);
      for(const row of pending) {
        this.db.prepare(
          'INSERT INTO approval_grant_revocations (grant_id,revoked_at,revoked_at_ms,reason) VALUES (?,?,?,?)'
        ).run(row.grant_id,nowIso,nowMs,cleanReason);
        this.#audit(row.grant_id,null,'grant.revoked',nowIso,{reason:cleanReason,sessionId:cleanSessionId});
      }
      return Object.freeze({sessionId:cleanSessionId,revokedCount:pending.length});
    });
  }

  revokeGrant(grantId,{reason='operator-revoked'}={}) {
    needUuid(grantId,'grant id');
    const cleanReason=needText(reason,120,'revocation reason');
    return this.transaction(()=>{
      const nowMs=this.#nowMs();
      const nowIso=new Date(nowMs).toISOString();
      const loaded=this.#loadVerifiedGrant(grantId);
      if(!loaded)fail(404,'GRANT_NOT_FOUND','Approval grant not found.');

      const existing=this.db.prepare('SELECT revoked_at FROM approval_grant_revocations WHERE grant_id=?').get(grantId);
      if(existing)return Object.freeze({revoked:true,duplicate:true});

      if(loaded.grant.grantKind==='action') {
        const consumed=this.db.prepare('SELECT consumed_at FROM approval_action_consumptions WHERE grant_id=?').get(grantId);
        if(consumed)fail(409,'GRANT_ALREADY_USED','Cannot revoke an already consumed action grant.');
      } else {
        const claim=this.#loadVerifiedClaim(loaded.grant.claimId,loaded.grant);
        if(!claim)fail(409,'CLAIM_INTEGRITY_ERROR','Approval claim missing for attempt grant.');
        if(['dispatching','settled'].includes(claim.phase)) {
          fail(409,'ALREADY_DISPATCHED','Cannot revoke an attempt grant after dispatch has begun.');
        }
      }

      this.db.prepare(
        'INSERT INTO approval_grant_revocations (grant_id,revoked_at,revoked_at_ms,reason) VALUES (?,?,?,?)'
      ).run(grantId,nowIso,nowMs,cleanReason);
      this.#audit(grantId,loaded.grant.claimId??null,'grant.revoked',nowIso,{reason:cleanReason});
      return Object.freeze({revoked:true,duplicate:false});
    });
  }

  readGrant(grantId) {
    const loaded=this.#loadVerifiedGrant(grantId);
    if(!loaded)return null;
    let claim=null;
    if(loaded.grant.grantKind==='attempt') {
      claim=this.#loadVerifiedClaim(loaded.grant.claimId,loaded.grant);
      if(!claim)fail(409,'CLAIM_INTEGRITY_ERROR','Approval claim missing for attempt grant.');
    } else {
      const strayClaim=this.db.prepare('SELECT 1 FROM approval_claims WHERE grant_id=?').get(grantId);
      if(strayClaim)fail(409,'CLAIM_INTEGRITY_ERROR','Action grant cannot own an attempt claim.');
    }
    const revocation=this.db.prepare('SELECT revoked_at,reason FROM approval_grant_revocations WHERE grant_id=?').get(grantId);
    const consumption=this.db.prepare('SELECT consumed_at FROM approval_action_consumptions WHERE grant_id=?').get(grantId);
    return deepFreeze({
      grant:loaded.grant,
      claim:rowToClaim(claim),
      revoked:revocation?{at:revocation.revoked_at,reason:revocation.reason}:null,
      consumedAt:consumption?.consumed_at??null,
    });
  }

  listAuditLog(grantId) {
    needUuid(grantId,'grant id');
    const rows=this.db.prepare(
      'SELECT seq,grant_id,claim_id,event_type,at,detail FROM approval_audit_log WHERE grant_id=? ORDER BY seq ASC'
    ).all(grantId);
    return deepFreeze(rows.map(row=>({
      seq:row.seq,
      grantId:row.grant_id,
      claimId:row.claim_id,
      eventType:row.event_type,
      at:row.at,
      detail:JSON.parse(row.detail),
    })));
  }
}
