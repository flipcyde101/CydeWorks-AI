import {createHash,randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {prepareRunSubmission,validSubmissionId,approvedRouteRevision} from './run-submission.mjs';
import {PERMISSION_SCOPES,classifyEndpointUrl,parseStrictIsoTimestamp} from './connection-contract.mjs';
import {DEFAULT_PROJECT_ID} from './workspace-projects.mjs';

export const DEFAULT_POLICY_VERSION='approval-policy-v1';
export const ACTION_GRANT_TTL_MS=300_000;
export const DEFAULT_ATTEMPT_GRANT_TTL_MS=300_000;
export const MAX_ATTEMPT_GRANT_TTL_MS=3_600_000;

const DIGEST_PATTERN=/^[a-f0-9]{64}$/;
const OPAQUE_ID_PATTERN=/^[A-Za-z0-9._:-]{1,80}$/;
const POLICY_PATTERN=/^[A-Za-z0-9._:-]{1,64}$/;
const ACTION_PATTERN=/^[a-z][a-z0-9_.:-]{0,79}$/;
const KIND_PATTERN=/^[a-z][a-z0-9_-]{0,39}$/;
const PERMISSION_SET=new Set(PERMISSION_SCOPES);
const DESTINATION_KINDS=new Set(['local-loopback','remote-endpoint','local-workspace']);

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

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function needUuid(value,label) {
  if(!validSubmissionId(value))fail(400,'INVALID_IDENTIFIER','Invalid '+label+'.');
  return value;
}

function needText(value,max,label) {
  if(typeof value!=='string'||/[\u0000-\u001f\u007f]/.test(value))fail(400,'INVALID_TEXT','Invalid '+label+'.');
  const trimmed=value.trim();
  if(!trimmed||trimmed.length>max)fail(400,'INVALID_TEXT','Invalid '+label+'.');
  return trimmed;
}

export function normalizePolicyVersion(value) {
  if(typeof value!=='string'||!POLICY_PATTERN.test(value)) {
    fail(400,'INVALID_POLICY_VERSION','Invalid policy version.');
  }
  return value;
}

function normalizeProjectId(value) {
  if(value===undefined||value===null)return DEFAULT_PROJECT_ID;
  if(typeof value!=='string'||!OPAQUE_ID_PATTERN.test(value)) {
    fail(400,'INVALID_PROJECT_ID','Invalid project identifier.');
  }
  return value;
}

function normalizeAccountRef(value) {
  if(value===undefined||value===null)return null;
  return needText(value,120,'account reference');
}

function normalizeApprovedRoots(roots) {
  if(roots===undefined||roots===null)return [];
  if(!Array.isArray(roots)||roots.length>64)fail(400,'INVALID_APPROVED_ROOTS','Approved roots must be a bounded list.');
  const normalized=roots.map(root=>{
    const item=needText(root,512,'approved root');
    if(!isAbsolute(item))fail(400,'INVALID_APPROVED_ROOTS','Approved roots must be absolute paths.');
    return item;
  });
  return [...new Set(normalized)].sort();
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

function validateRemotePermission(destination,permissions) {
  if(destination.kind==='remote-endpoint'&&!permissions.includes('remote-data-egress')) {
    fail(400,'MISSING_EGRESS_PERMISSION','Remote destinations require the remote-data-egress permission.');
  }
}

function attemptBindingKey(grant) {
  return JSON.stringify({
    submissionFingerprint:grant.submissionFingerprint,
    projectId:grant.projectId,
    destination:grant.destination,
    accountRef:grant.accountRef,
    approvedRoots:grant.approvedRoots,
    permissions:grant.permissions,
    testPlanHash:grant.testPlanHash,
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
    claimedAt:row.claimed_at,
    dispatchedAt:row.dispatched_at,
    settledAt:row.settled_at,
    updatedAt:row.updated_at,
  });
}

const LEGACY_GRANT_FIELDS=[
  'grantId','grantKind','claimId','attemptId','requestId','taskId','taskVersion',
  'projectId','sourceHash','routeRevision','model','engine','backend',
  'modelDigest','modelFingerprint','destination','accountRef','approvedRoots',
  'permissions','testPlan','testPlanHash','submissionFingerprint','policyVersion',
  'action','issuedAt','expiresAt','grantHash',
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
  constructor(db,{clock=()=>Date.now(),nonce=randomUUID,policyVersion=DEFAULT_POLICY_VERSION}={}) {
    if(!db||typeof db.exec!=='function'||typeof db.prepare!=='function') {
      throw new TypeError('ApprovalAuditStore requires a SQLite DatabaseSync handle.');
    }
    this.db=db;
    this.clock=clock;
    this.nonce=nonce;
    this.policyVersion=normalizePolicyVersion(policyVersion);
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

      CREATE TABLE IF NOT EXISTS approval_action_consumptions (
        grant_id TEXT PRIMARY KEY REFERENCES approval_grants(grant_id),
        consumed_at TEXT NOT NULL,
        consumed_at_ms INTEGER NOT NULL
      );

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
        claimed_at TEXT NOT NULL,
        dispatched_at TEXT,
        settled_at TEXT,
        updated_at TEXT NOT NULL
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
    const {grantHash,...withoutHash}=payload;
    if(grantHash!==row.grant_hash||sha256Json(withoutHash)!==row.grant_hash) {
      fail(409,'GRANT_INTEGRITY_ERROR','Stored approval grant failed integrity verification.');
    }
    if(payload.grantId!==row.grant_id||payload.grantKind!==row.grant_kind||
       payload.policyVersion!==row.policy_version||payload.expiresAt!==row.expires_at||
       parseStrictIsoTimestamp(row.expires_at)!==row.expires_at_ms) {
      fail(409,'GRANT_INTEGRITY_ERROR','Stored approval grant metadata is inconsistent.');
    }
    return {row,grant:deepFreeze(payload)};
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
    const destination=normalizeDestination(input.destination);
    const accountRef=normalizeAccountRef(input.accountRef);
    const approvedRoots=normalizeApprovedRoots(input.approvedRoots);
    const permissions=normalizePermissions(input.permissions);
    validateRemotePermission(destination,permissions);
    const testPlan=normalizeTestPlan(input.testPlan);
    const testPlanHash=sha256Json(testPlan);
    const requestedPolicy=input.policyVersion===undefined?this.policyVersion:normalizePolicyVersion(input.policyVersion);
    if(requestedPolicy!==this.policyVersion) {
      fail(409,'POLICY_CHANGED','Approval policy version changed. Refresh and re-approve.');
    }
    const sessionId=input.sessionId===undefined||input.sessionId===null?null:needText(input.sessionId,120,'session id');
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
        const claimRow=this.db.prepare('SELECT * FROM approval_claims WHERE grant_id=?').get(loaded.grant.grantId);
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
           phase,recovery_state,outcome,claimed_at,dispatched_at,settled_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        claimId,grantId,attemptId,taskId,input.submission.version,submission.requestId,
        'claimed',null,null,nowIso,null,null,nowIso
      );

      this.#audit(grantId,claimId,'grant.issued_and_claimed',nowIso,{
        taskId,taskVersion:input.submission.version,projectId,policyVersion:requestedPolicy,
      });

      const claimRow=this.db.prepare('SELECT * FROM approval_claims WHERE claim_id=?').get(claimId);
      return Object.freeze({replayed:false,grant,claim:rowToClaim(claimRow)});
    });
  }

  beginDispatch({grantId,claimId,currentScope,policyVersion=this.policyVersion}) {
    needUuid(grantId,'grant id');
    needUuid(claimId,'claim id');
    if(!isPlainObject(currentScope))fail(400,'MISSING_CURRENT_SCOPE','Current task and route scope is required before dispatch.');
    const checkedPolicy=normalizePolicyVersion(policyVersion);

    return this.transaction(()=>{
      const nowMs=this.#nowMs();
      const nowIso=new Date(nowMs).toISOString();
      const loaded=this.#loadVerifiedGrant(grantId);
      if(!loaded||loaded.grant.grantKind!=='attempt')fail(404,'GRANT_NOT_FOUND','Approval grant not found.');
      const {row,grant}=loaded;

      const claim=this.db.prepare('SELECT * FROM approval_claims WHERE claim_id=?').get(claimId);
      if(!claim||claim.grant_id!==grantId)fail(404,'CLAIM_NOT_FOUND','Approval claim not found.');

      this.#checkActiveTiming(row,nowMs);

      if(checkedPolicy!==grant.policyVersion||this.policyVersion!==grant.policyVersion) {
        fail(409,'POLICY_CHANGED','Approval policy version changed. Fresh authorization is required.');
      }

      if(claim.phase==='dispatching')fail(409,'ALREADY_DISPATCHED','This claim has already begun dispatch.');
      if(claim.phase!=='claimed')fail(409,'CLAIM_NOT_DISPATCHABLE','This claim is no longer eligible for dispatch.');

      if(currentScope.taskId!==grant.taskId||currentScope.taskVersion!==grant.taskVersion) {
        fail(409,'SCOPE_CHANGED','The task or task version changed after approval.');
      }
      if(currentScope.sourceHash!==grant.sourceHash) {
        fail(409,'SCOPE_CHANGED','The approved source snapshot changed after approval.');
      }
      if(currentScope.routeRevision!==grant.routeRevision) {
        fail(409,'ROUTE_CHANGED','The selected route revision changed after approval.');
      }
      if(currentScope.projectId!==undefined&&normalizeProjectId(currentScope.projectId)!==grant.projectId) {
        fail(409,'SCOPE_CHANGED','The task project changed after approval.');
      }
      if((currentScope.model!==undefined&&currentScope.model!==grant.model)||
         (currentScope.engine!==undefined&&currentScope.engine!==grant.engine)||
         (currentScope.backend!==undefined&&currentScope.backend!==grant.backend)||
         (currentScope.modelDigest!==undefined&&(currentScope.modelDigest??null)!==grant.modelDigest)||
         (currentScope.modelFingerprint!==undefined&&(currentScope.modelFingerprint??null)!==grant.modelFingerprint)) {
        fail(409,'ROUTE_CHANGED','The approved model or engine identity changed.');
      }
      if(currentScope.destination!==undefined&&
         JSON.stringify(normalizeDestination(currentScope.destination))!==JSON.stringify(grant.destination)) {
        fail(409,'DESTINATION_CHANGED','The provider destination changed after approval.');
      }
      if(currentScope.accountRef!==undefined&&normalizeAccountRef(currentScope.accountRef)!==grant.accountRef) {
        fail(409,'SCOPE_CHANGED','The account reference changed after approval.');
      }
      if(currentScope.approvedRoots!==undefined&&
         JSON.stringify(normalizeApprovedRoots(currentScope.approvedRoots))!==JSON.stringify(grant.approvedRoots)) {
        fail(409,'SCOPE_CHANGED','The approved project roots changed after approval.');
      }
      if(currentScope.permissions!==undefined&&
         JSON.stringify(normalizePermissions(currentScope.permissions))!==JSON.stringify(grant.permissions)) {
        fail(409,'SCOPE_CHANGED','The approved permissions changed after approval.');
      }
      if(currentScope.testPlan!==undefined&&
         sha256Json(normalizeTestPlan(currentScope.testPlan))!==grant.testPlanHash) {
        fail(409,'SCOPE_CHANGED','The approved test plan changed after approval.');
      }

      const updated=this.db.prepare(
        "UPDATE approval_claims SET phase='dispatching',dispatched_at=?,updated_at=? WHERE claim_id=? AND phase='claimed'"
      ).run(nowIso,nowIso,claimId);
      if(updated.changes!==1)fail(409,'CLAIM_NOT_DISPATCHABLE','The claim state changed concurrently.');

      this.#audit(grantId,claimId,'claim.dispatching',nowIso,{attemptId:grant.attemptId});
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
      const claim=this.db.prepare('SELECT * FROM approval_claims WHERE claim_id=?').get(claimId);
      if(!claim||claim.grant_id!==grantId)fail(404,'CLAIM_NOT_FOUND','Approval claim not found.');
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

  reconcileInterrupted() {
    return this.transaction(()=>{
      const nowIso=new Date(this.#nowMs()).toISOString();
      const inFlight=this.db.prepare(
        "SELECT * FROM approval_claims WHERE phase IN ('claimed','dispatching') ORDER BY claimed_at ASC"
      ).all();
      let retrySafeCount=0;
      let unresolvedCount=0;
      const claims=[];
      for(const row of inFlight) {
        const recoveryState=row.phase==='claimed'?'retry-safe':'unresolved';
        if(recoveryState==='retry-safe')retrySafeCount++;
        else unresolvedCount++;
        this.db.prepare(
          "UPDATE approval_claims SET phase='crash-held',recovery_state=?,updated_at=? WHERE claim_id=?"
        ).run(recoveryState,nowIso,row.claim_id);
        this.#audit(row.grant_id,row.claim_id,'claim.crash_held',nowIso,{
          previousPhase:row.phase,
          recoveryState,
        });
        claims.push(rowToClaim(this.db.prepare('SELECT * FROM approval_claims WHERE claim_id=?').get(row.claim_id)));
      }
      return Object.freeze({retrySafeCount,unresolvedCount,claims:Object.freeze(claims)});
    });
  }

  resolveCrashHold({claimId,resolution='confirmed-stopped'}) {
    needUuid(claimId,'claim id');
    if(!['confirmed-stopped','confirmed-settled'].includes(resolution)) {
      fail(400,'INVALID_RESOLUTION','Unsupported crash-hold resolution.');
    }
    return this.transaction(()=>{
      const nowIso=new Date(this.#nowMs()).toISOString();
      const claim=this.db.prepare('SELECT * FROM approval_claims WHERE claim_id=?').get(claimId);
      if(!claim)fail(404,'CLAIM_NOT_FOUND','Approval claim not found.');
      if(claim.phase!=='crash-held')fail(409,'CLAIM_NOT_HELD','This claim is not in a crash-held state.');
      const nextPhase=resolution==='confirmed-settled'?'settled':'aborted';
      this.db.prepare(
        'UPDATE approval_claims SET phase=?,outcome=?,updated_at=? WHERE claim_id=?'
      ).run(nextPhase,resolution,nowIso,claimId);
      this.#audit(claim.grant_id,claimId,'claim.crash_hold_resolved',nowIso,{resolution,nextPhase});
      return rowToClaim(this.db.prepare('SELECT * FROM approval_claims WHERE claim_id=?').get(claimId));
    });
  }

  issueActionGrant(input) {
    if(!isPlainObject(input))fail(400,'INVALID_ACTION_GRANT','An action grant input object is required.');
    if(typeof input.action!=='string'||!ACTION_PATTERN.test(input.action)) {
      fail(400,'INVALID_ACTION','Specify a valid action identifier.');
    }
    const destination=normalizeDestination(input.destination);
    const taskId=input.taskId===undefined||input.taskId===null?null:needUuid(input.taskId,'task id');
    const taskVersion=input.taskVersion===undefined||input.taskVersion===null?null:input.taskVersion;
    if(taskVersion!==null&&(!Number.isSafeInteger(taskVersion)||taskVersion<0)) {
      fail(400,'INVALID_TASK_VERSION','Task version must be a non-negative integer.');
    }
    const projectId=normalizeProjectId(input.projectId);
    const sourceHash=input.sourceHash===undefined||input.sourceHash===null?null:input.sourceHash;
    if(sourceHash!==null&&(typeof sourceHash!=='string'||!DIGEST_PATTERN.test(sourceHash))) {
      fail(400,'INVALID_SOURCE_HASH','Source hash must be a 64-character lowercase hex digest.');
    }
    const routeRevision=input.routeRevision===undefined||input.routeRevision===null?null:input.routeRevision;
    if(routeRevision!==null&&(typeof routeRevision!=='string'||!DIGEST_PATTERN.test(routeRevision))) {
      fail(400,'INVALID_ROUTE_REVISION','Route revision must be a 64-character lowercase hex digest.');
    }
    const accountRef=normalizeAccountRef(input.accountRef);
    const approvedRoots=normalizeApprovedRoots(input.approvedRoots);
    const permissions=normalizePermissions(input.permissions??['read-only-source']);
    validateRemotePermission(destination,permissions);
    const requestedPolicy=input.policyVersion===undefined?this.policyVersion:normalizePolicyVersion(input.policyVersion);
    if(requestedPolicy!==this.policyVersion) {
      fail(409,'POLICY_CHANGED','Approval policy version changed. Refresh and re-approve.');
    }
    const requestId=input.requestId===undefined||input.requestId===null?null:needUuid(input.requestId,'request id');
    if(requestId!==null&&taskId===null)fail(400,'MISSING_TASK_ID','A keyed action grant requires a taskId.');
    const sessionId=input.sessionId===undefined||input.sessionId===null?null:needText(input.sessionId,120,'session id');
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
          if(loaded.grant.grantKind!=='action'||
             loaded.grant.action!==input.action||
             JSON.stringify(loaded.grant.destination)!==JSON.stringify(destination)||
             loaded.grant.taskVersion!==taskVersion||
             loaded.grant.projectId!==projectId||
             loaded.grant.sourceHash!==sourceHash||
             loaded.grant.routeRevision!==routeRevision||
             loaded.grant.accountRef!==accountRef||
             JSON.stringify(loaded.grant.approvedRoots)!==JSON.stringify(approvedRoots)||
             JSON.stringify(loaded.grant.permissions)!==JSON.stringify(permissions)||
             loaded.grant.policyVersion!==requestedPolicy) {
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
        destination,
        taskId,
        taskVersion,
        projectId,
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
        action:input.action,destination,policyVersion:requestedPolicy,
      });
      return grant;
    });
  }

  consumeActionGrant(input) {
    if(!isPlainObject(input))fail(400,'INVALID_ACTION_CONSUME','Action grant consumption parameters are required.');
    const grantId=needUuid(input.grantId,'grant id');
    if(typeof input.action!=='string'||!ACTION_PATTERN.test(input.action)) {
      fail(400,'INVALID_ACTION','Specify a valid action identifier.');
    }
    const destination=normalizeDestination(input.destination);
    const checkedPolicy=normalizePolicyVersion(input.policyVersion??this.policyVersion);
    const projectId=normalizeProjectId(input.projectId);
    const approvedRoots=normalizeApprovedRoots(input.approvedRoots);
    const permissions=normalizePermissions(input.permissions??['read-only-source']);

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
      if(input.action!==grant.action)fail(409,'ACTION_MISMATCH','Grant action does not match the requested operation.');
      if(JSON.stringify(destination)!==JSON.stringify(grant.destination)) {
        fail(409,'DESTINATION_CHANGED','The destination changed after the action grant was issued.');
      }
      if((input.taskId??null)!==grant.taskId||(input.taskVersion??null)!==grant.taskVersion||
         projectId!==grant.projectId||(input.sourceHash??null)!==grant.sourceHash||
         (input.routeRevision??null)!==grant.routeRevision||normalizeAccountRef(input.accountRef)!==grant.accountRef||
         JSON.stringify(approvedRoots)!==JSON.stringify(grant.approvedRoots)||
         JSON.stringify(permissions)!==JSON.stringify(grant.permissions)) {
        fail(409,'SCOPE_CHANGED','The approved scope changed after the action grant was issued.');
      }

      this.db.prepare(
        'INSERT INTO approval_action_consumptions (grant_id,consumed_at,consumed_at_ms) VALUES (?,?,?)'
      ).run(grantId,nowIso,nowMs);
      this.#audit(grantId,null,'action_grant.consumed',nowIso,{
        action:grant.action,destination:grant.destination,
      });
      return Object.freeze({consumed:true,grant});
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
        const claim=this.db.prepare('SELECT phase FROM approval_claims WHERE grant_id=?').get(grantId);
        if(claim&&['dispatching','settled'].includes(claim.phase)) {
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
    const revocation=this.db.prepare('SELECT revoked_at,reason FROM approval_grant_revocations WHERE grant_id=?').get(grantId);
    const consumption=this.db.prepare('SELECT consumed_at FROM approval_action_consumptions WHERE grant_id=?').get(grantId);
    const claim=this.db.prepare('SELECT * FROM approval_claims WHERE grant_id=?').get(grantId);
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
