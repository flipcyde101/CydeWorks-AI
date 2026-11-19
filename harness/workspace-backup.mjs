import {createHash, timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, mkdtemp, open, readdir, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {DatabaseSync, backup} from 'node:sqlite';
import {exportTask} from './export.mjs';
import {exportReceipt} from './receipt-export.mjs';

export const BACKUP_FORMAT='cydeworks-workspace-backup';
export const BACKUP_SCHEMA_VERSION=2;
export const BACKUP_MODE='redacted-metadata-v1';

const MAX_FILE_BYTES=64*1024*1024;
const SQLITE_MAGIC=Buffer.from('SQLite format 3\0','ascii');
const SHA256_HEX=/^[a-f0-9]{64}$/;
const SAFE_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ID_OR_DIGEST=/^(?:[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const SAFE_EVENT_NAME=/^(?:task|attempt|review|runner|recovery)\.[a-z][a-z0-9_]{0,32}$/;
const TABLE_NAME=/^[A-Za-z_][A-Za-z0-9_]*$/;
const SUSPICIOUS_TABLE_NAME=/(?:secret|credential|password|passwd|token|session|access_key|auth)/i;
const CONTROL_CHARS=/[\x00-\x1f\x7f]/;
const WINDOWS_RESERVED=/^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;
const SECRET_BASENAME=/^(?:\.env(?:\..+)?|access\.key|bfe_session|auth\.json|credentials(?:\.[^.]+)?|secrets?(?:\.[^.]+)?|removal[_-]?secret(?:\.[^.]+)?|.*(?:secret|credential|password|passwd|auth[_-]?token).*)$/i;
const SECRET_EXTENSION=/\.(?:key|pem|p12|pfx|secret|token|kdbx)$/i;
const SECRET_DIR_SEGMENT=new Set(['secrets','credentials','.ssh','.gnupg','tokens']);
const PROTOTYPE_KEYS=new Set(['__proto__','constructor','prototype']);

const TASK_KINDS=new Set(['brief','change']);
const TASK_STATUSES=new Set(['draft','running','review','accepted','rejected','failed','cancelled','interrupted']);
const PROVIDERS=new Set(['fixture','ollama','opencode','other']);
const BACKENDS=new Set(['fixture','ollama','llamacpp','opencode','other']);
const EXECUTION_PHASES=new Set(['claimed','dispatching','settled','interrupted','unresolved']);

const SUPPORTED_TABLES=Object.freeze({
  tasks:['id','updated','data'],
  task_removal_audit:['id','reference','removed_at','scope'],
  task_draft_copies:['request_id','source_id','source_version','draft_id'],
});

export const ATOMIC_PUBLICATION_LIMIT=
  'Atomic no-replace directory publication into caller-supplied destinations is disabled under Node.js 24 platform APIs: O_NOFOLLOW is unavailable on win32, and openat, unlinkat, renameat2(RENAME_NOREPLACE), and handle-pinned no-replace rename are not exposed in node:fs. Path-based rollback cannot safely unlink without risking replacement files or replaced parent junctions.';

export const RAW_RECOVERY_LIMIT=
  'Raw full-database snapshots and arbitrary workspace file copies are disabled because they can retain secrets in row fields, deleted SQLite freelist pages, and unvalidated files without a separately approved retention contract.';

export const BACKUP_LIMITS=Object.freeze([
  ATOMIC_PUBLICATION_LIMIT,
  RAW_RECOVERY_LIMIT,
  'Redacted metadata backups rebuild a fresh SQLite database containing only strictly allowlisted task, removal-audit, and draft-copy metadata fields; free-text prompts, sources, expected text, model aliases, proposals, unknown tables, deleted SQLite pages, and arbitrary workspace files are excluded.',
  'Because free-text task content and workspace files are excluded, a redacted backup cannot restore editable task prompts or workspace artifacts.',
  'SHA-256 digests detect archive corruption and verify handle-bound SQLite bytes in private staging, but archives are unsigned and cannot prove origin authenticity.',
]);

export class BackupError extends Error {
  constructor(code,message,cause,details) {
    super(message,cause?{cause}:undefined);
    this.name='BackupError';
    this.code=code;
    if (details&&typeof details==='object') {
      if ('publication' in details) this.publication=details.publication;
      if ('cleanup' in details) this.cleanup=details.cleanup;
    }
  }
}

const fail=(code,message,cause,details)=>{throw new BackupError(code,message,cause,details);};
const sha256Hex=bytes=>createHash('sha256').update(bytes).digest('hex');

function assertIsoTimestamp(value,label) {
  if (typeof value!=='string'||value.length!==24) fail('UNSUPPORTED_WORKSPACE_SCHEMA',`Invalid ${label} timestamp.`);
  const ms=Date.parse(value);
  if (!Number.isSafeInteger(ms)||ms<0||new Date(ms).toISOString()!==value) {
    fail('UNSUPPORTED_WORKSPACE_SCHEMA',`Invalid ${label} ISO timestamp.`);
  }
  return value;
}

function assertRootPath(value,label) {
  if (typeof value!=='string'||!value.trim()||CONTROL_CHARS.test(value)) {
    fail('INVALID_PATH',`Invalid ${label} path.`);
  }
  return resolve(value);
}

export function assertSafeRelativePath(relPath,label='relative path') {
  if (typeof relPath!=='string'||!relPath||relPath.length>240||CONTROL_CHARS.test(relPath)) {
    fail('INVALID_PATH',`Invalid ${label}.`);
  }
  if (relPath.includes('\\')||relPath.startsWith('/')||/^[A-Za-z]:/.test(relPath)) {
    fail('INVALID_PATH',`The ${label} must be a relative POSIX path.`);
  }
  const parts=relPath.split('/');
  for (const part of parts) {
    if (!part||part==='.'||part==='..'||part.endsWith('.')||part.endsWith(' ')||WINDOWS_RESERVED.test(part)) {
      fail('INVALID_PATH',`The ${label} contains an unsafe path segment.`);
    }
  }
  return relPath;
}

function assertDbFilename(dbFilename) {
  assertSafeRelativePath(dbFilename,'database filename');
  if (dbFilename.includes('/')||SECRET_BASENAME.test(dbFilename)||SECRET_EXTENSION.test(dbFilename)) {
    fail('INVALID_PATH','The database filename is invalid.');
  }
  return dbFilename;
}

function resolveContainedPath(baseDir,relPath,label='path') {
  const safeRel=assertSafeRelativePath(relPath,label);
  const resolvedBase=resolve(baseDir);
  const resolvedTarget=resolve(resolvedBase,safeRel);
  const rel=relative(resolvedBase,resolvedTarget);
  if (!rel||rel.startsWith('..')||isAbsolute(rel)) {
    fail('INVALID_PATH',`The ${label} escapes its root directory.`);
  }
  return resolvedTarget;
}

async function statNoFollow(targetPath,label) {
  let info;
  try { info=await lstat(targetPath,{bigint:true}); }
  catch (error) {
    if (error.code==='ENOENT') return null;
    throw error;
  }
  if (info.isSymbolicLink()) fail('SYMLINK_REJECTED',`Symbolic links are not allowed at ${label}.`);
  return info;
}

async function assertAncestorsNoFollow(targetPath,label) {
  let cursor=resolve(targetPath);
  while (true) {
    await statNoFollow(cursor,label);
    const parent=dirname(cursor);
    if (parent===cursor) break;
    cursor=parent;
  }
}

async function resolveComparablePath(targetPath,label) {
  const resolved=assertRootPath(targetPath,label);
  let cursor=resolved;
  const tail=[];
  let nearestCanonical=null;
  while (true) {
    const info=await statNoFollow(cursor,label);
    if (info&&!nearestCanonical) {
      nearestCanonical=await realpath(cursor);
      const tailCopy=[...tail];
      const full=tailCopy.length?resolve(nearestCanonical,...tailCopy.reverse()):nearestCanonical;
      nearestCanonical=process.platform==='win32'?full.toLowerCase():full;
    }
    const parent=dirname(cursor);
    if (parent===cursor) {
      return nearestCanonical??(process.platform==='win32'?resolved.toLowerCase():resolved);
    }
    if (!info) tail.push(relative(parent,cursor));
    cursor=parent;
  }
}

async function assertDistinctPaths(firstDir,secondDir,firstLabel,secondLabel) {
  const a=await resolveComparablePath(firstDir,firstLabel);
  const b=await resolveComparablePath(secondDir,secondLabel);
  const platformSep=process.platform==='win32'?'\\':'/';
  const prefixA=a.endsWith(platformSep)?a:a+platformSep;
  const prefixB=b.endsWith(platformSep)?b:b+platformSep;
  if (a===b||a.startsWith(prefixB)||b.startsWith(prefixA)) {
    fail('OVERLAPPING_PATHS',`${firstLabel} and ${secondLabel} must be separate non-overlapping directories.`);
  }
}

export function classifyWorkspaceFile(relPath,dbFilename='workspace.sqlite') {
  assertSafeRelativePath(relPath,'workspace path');
  assertDbFilename(dbFilename);
  const parts=relPath.split('/');
  const base=parts.at(-1);
  if (relPath===dbFilename) {
    return {included:false,category:'sqlite-primary',reason:'Captured via SQLite online backup API and redacted schema projection; not raw-copied.'};
  }
  if (relPath===`${dbFilename}.owner.sqlite`||base.endsWith('.owner.sqlite')) {
    return {included:false,category:'runtime-lock',reason:'Workspace owner lock file is transient runtime state.'};
  }
  if (relPath===`${dbFilename}-wal`||relPath===`${dbFilename}-shm`||relPath===`${dbFilename}-journal`||
      /-(?:wal|shm|journal)$/i.test(base)) {
    return {included:false,category:'sqlite-journal',reason:'SQLite journal sidecars are folded into the SQLite snapshot.'};
  }
  if (parts.slice(0,-1).some(part=>SECRET_DIR_SEGMENT.has(part.toLowerCase()))||
      SECRET_BASENAME.test(base)||SECRET_EXTENSION.test(base)) {
    return {included:false,category:'credential-or-secret',reason:'Access keys, session secrets, and credential files are excluded.'};
  }
  if (relPath==='backups'||relPath.startsWith('backups/')) {
    return {included:false,category:'backup-archive',reason:'Existing backup archives are excluded.'};
  }
  return {
    included:false,
    category:'unverified-arbitrary-file',
    reason:'Arbitrary workspace files are excluded from redacted backups because ordinary files can contain unredacted credentials.',
  };
}

function isContainedCanonical(rootReal,targetReal) {
  const normRoot=process.platform==='win32'?rootReal.toLowerCase():rootReal;
  const normTarget=process.platform==='win32'?targetReal.toLowerCase():targetReal;
  const prefix=normRoot.endsWith(sep)?normRoot:normRoot+sep;
  return normTarget.startsWith(prefix);
}

async function walkDirectory(rootDir,prefix='',rootReal=null) {
  const entries=[];
  const canonicalRoot=rootReal??await realpath(rootDir);
  if (!rootReal) {
    await assertAncestorsNoFollow(rootDir,'directory root');
  }
  const dirents=await readdir(rootDir,{withFileTypes:true});
  dirents.sort((a,b)=>a.name.localeCompare(b.name));
  for (const dirent of dirents) {
    const rel=prefix?`${prefix}/${dirent.name}`:dirent.name;
    assertSafeRelativePath(rel,'directory entry');
    const full=resolveContainedPath(rootDir,dirent.name,'directory entry');
    const info=await statNoFollow(full,rel);
    if (!info) fail('INVALID_PATH',`Missing directory entry at ${rel}.`);
    const entryReal=await realpath(full);
    if (!isContainedCanonical(canonicalRoot,entryReal)) {
      fail('SYMLINK_REJECTED',`Directory entry escapes canonical root at ${rel}.`);
    }
    if (info.isDirectory()) {
      entries.push(...await walkDirectory(full,rel,canonicalRoot));
    } else if (info.isFile()) {
      entries.push({rel,full,lstatInfo:info,byteLength:Number(info.size)});
    } else {
      fail('INVALID_PATH',`Unsupported non-regular file at ${rel}.`);
    }
  }
  return entries;
}

function sameFileIdentity(a,b) {
  return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.birthtimeNs===b.birthtimeNs;
}

async function readBoundFile(filePath,expectedLstat,label,onBeforeOpenFile) {
  if (onBeforeOpenFile) await onBeforeOpenFile(filePath,label);
  await assertAncestorsNoFollow(filePath,label);
  const preLstat=await statNoFollow(filePath,label);
  if (!preLstat||!preLstat.isFile()) {
    fail('INVALID_PATH',`Expected regular file at ${label}.`);
  }
  if (expectedLstat&&!sameFileIdentity(preLstat,expectedLstat)) {
    fail('IDENTITY_MISMATCH',`File identity changed before opening ${label}.`);
  }
  const flags=constants.O_RDONLY|(constants.O_NOFOLLOW??0);
  let handle;
  try {
    handle=await open(filePath,flags);
    const fdStat=await handle.stat({bigint:true});
    if (!fdStat.isFile()) fail('INVALID_PATH',`Opened handle is not a regular file at ${label}.`);
    if (fdStat.size>BigInt(MAX_FILE_BYTES)) {
      fail('RESOURCE_LIMIT_EXCEEDED',`File at ${label} exceeds maximum supported byte limit.`);
    }
    if (!sameFileIdentity(fdStat,preLstat)) {
      fail('IDENTITY_MISMATCH',`Opened handle identity mismatched pre-open lstat at ${label}.`);
    }
    const bytes=await handle.readFile();
    if (BigInt(bytes.byteLength)!==fdStat.size) {
      fail('IDENTITY_MISMATCH',`Read byte count mismatched stat size at ${label}.`);
    }
    const postLstat=await statNoFollow(filePath,label);
    if (!postLstat||!sameFileIdentity(postLstat,fdStat)) {
      fail('IDENTITY_MISMATCH',`File identity changed during read at ${label}.`);
    }
    return {bytes,byteLength:bytes.byteLength,sha256:sha256Hex(bytes),stat:fdStat};
  } catch (error) {
    if (error instanceof BackupError) throw error;
    if (error.code==='ELOOP') fail('SYMLINK_REJECTED',`Symbolic link rejected while opening ${label}.`,error);
    throw error;
  } finally {
    try { await handle?.close(); } catch {}
  }
}

function validateSqliteHeaderBytes(bytes,label,{requireDeleteJournal=false}={}) {
  if (bytes.byteLength<100||!bytes.subarray(0,16).equals(SQLITE_MAGIC)) {
    fail('BACKUP_CORRUPTED',`${label} is not a valid SQLite database file.`);
  }
  if (requireDeleteJournal&&(bytes[18]!==1||bytes[19]!==1)) {
    fail('BACKUP_CORRUPTED',`${label} must use SQLite legacy DELETE journal format rather than WAL.`);
  }
}

async function writePrivateVerifiedDbFile(stageRoot,filename,dbBytes,expectedSha256) {
  const stagedPath=resolveContainedPath(stageRoot,filename,'staged database');
  let handle;
  try {
    handle=await open(stagedPath,'wx',0o600);
    await handle.writeFile(dbBytes);
  } finally {
    try { await handle?.close(); } catch {}
  }
  const bound=await readBoundFile(stagedPath,null,'staged verified database');
  if (!timingSafeEqual(Buffer.from(bound.sha256,'hex'),Buffer.from(expectedSha256,'hex'))) {
    fail('BACKUP_CORRUPTED','Private staged database bytes do not match verified digest.');
  }
  return stagedPath;
}

function sanitizeIdentifier(value,label) {
  if (typeof value!=='string'||!SAFE_ID_OR_DIGEST.test(value)) {
    fail('UNSUPPORTED_WORKSPACE_SCHEMA',`Unsupported ${label} identifier format for redacted backup.`);
  }
  return value;
}

function redactTaskRecord(rowId,parsed,receiptHash) {
  const id=sanitizeIdentifier(parsed.id,'task.id');
  if (id!==rowId) fail('BACKUP_CORRUPTED','Task row ID does not match serialized task.id.');
  if (!Number.isSafeInteger(parsed.version)||parsed.version<0) {
    fail('BACKUP_CORRUPTED',`Invalid task version for ${rowId}.`);
  }
  if (!TASK_KINDS.has(parsed.kind)) {
    fail('UNSUPPORTED_WORKSPACE_SCHEMA',`Unsupported task kind for ${rowId}.`);
  }
  if (!TASK_STATUSES.has(parsed.status)) {
    fail('UNSUPPORTED_WORKSPACE_SCHEMA',`Unsupported task status for ${rowId}.`);
  }
  if (typeof parsed.sourceHash!=='string'||!SHA256_HEX.test(parsed.sourceHash)) {
    fail('UNSUPPORTED_WORKSPACE_SCHEMA',`Invalid task sourceHash for ${rowId}.`);
  }

  if (!Array.isArray(parsed.attempts)) {
    fail('BACKUP_CORRUPTED',`Task attempts must be an array for ${rowId}.`);
  }
  const minimalExport=exportTask(parsed,'minimal');
  const rawAttempts=parsed.attempts;
  const attempts=rawAttempts.map((attempt,index)=>{
    if (!attempt||typeof attempt!=='object'||Array.isArray(attempt)) {
      fail('BACKUP_CORRUPTED',`Invalid attempt entry at index ${index} for ${rowId}.`);
    }
    const attemptId=sanitizeIdentifier(attempt.id,`attempt[${index}].id`);
    const minAttempt=minimalExport.task.attempts[index];
    const provider=PROVIDERS.has(attempt.provider)?attempt.provider:'other';
    const backend=BACKENDS.has(attempt.backend)?attempt.backend:'other';
    const status=TASK_STATUSES.has(attempt.status)?attempt.status:'failed';
    const started=attempt.started==null?null:assertIsoTimestamp(attempt.started,`attempt[${index}].started`);
    const ended=attempt.ended==null?null:assertIsoTimestamp(attempt.ended,`attempt[${index}].ended`);
    const elapsedMs=typeof attempt.elapsedMs==='number'&&Number.isFinite(attempt.elapsedMs)&&attempt.elapsedMs>=0
      ?attempt.elapsedMs:null;
    const scopeHash=attempt.scopeHash==null?null:(
      typeof attempt.scopeHash==='string'&&SHA256_HEX.test(attempt.scopeHash)
        ?attempt.scopeHash
        :fail('UNSUPPORTED_WORKSPACE_SCHEMA',`Invalid scopeHash on attempt ${attemptId}.`)
    );
    let executionPhase=null;
    let claimId=null;
    if (attempt.execution&&typeof attempt.execution==='object'&&!Array.isArray(attempt.execution)) {
      if (attempt.execution.phase!=null) {
        if (!EXECUTION_PHASES.has(attempt.execution.phase)) {
          fail('UNSUPPORTED_WORKSPACE_SCHEMA',`Unsupported execution phase on attempt ${attemptId}.`);
        }
        executionPhase=attempt.execution.phase;
      }
      if (attempt.execution.claimId!=null) {
        claimId=sanitizeIdentifier(attempt.execution.claimId,`attempt[${index}].execution.claimId`);
      }
    }
    const artifactSha256=typeof attempt.artifact?.sha256==='string'&&SHA256_HEX.test(attempt.artifact.sha256)
      ?attempt.artifact.sha256:null;
    const checks=Array.isArray(attempt.checks)?attempt.checks:[];
    let checksPassedCount=0;
    let checksFailedCount=0;
    for (const check of checks) {
      if (check?.pass===true) checksPassedCount++;
      else checksFailedCount++;
    }
    return {
      id:attemptId,
      provider,
      backend,
      started,
      ended,
      elapsedMs,
      status,
      scopeHash,
      executionPhase,
      claimId,
      usage:minAttempt.usage,
      artifactSha256,
      checksPassedCount,
      checksFailedCount,
    };
  });

  const rawEvents=Array.isArray(parsed.events)?parsed.events:[];
  const events=rawEvents.map((entry,index)=>{
    if (!entry||typeof entry!=='object'||Array.isArray(entry)||
        !Number.isSafeInteger(entry.seq)||entry.seq<1) {
      fail('BACKUP_CORRUPTED',`Invalid event sequence at index ${index} for ${rowId}.`);
    }
    const at=assertIsoTimestamp(entry.at,`event[${index}].at`);
    if (typeof entry.event!=='string'||!SAFE_EVENT_NAME.test(entry.event)) {
      fail('UNSUPPORTED_WORKSPACE_SCHEMA',`Unsupported event name at index ${index} for ${rowId}.`);
    }
    return {seq:entry.seq,at,event:entry.event};
  });

  return {
    redacted:true,
    id,
    version:parsed.version,
    kind:parsed.kind,
    status:parsed.status,
    sourceHash:parsed.sourceHash,
    receiptHash:receiptHash??null,
    attempts,
    events,
  };
}

function assertValidRedactedUsage(usage) {
  const allowed=new Set([
    'evidence','semantics','input','output','cached','cacheWrite','reasoning',
    'generationMs','loadMs','promptMs','steps',
  ]);
  if (!usage||typeof usage!=='object'||Array.isArray(usage)) {
    fail('SECRET_LEAK_DETECTED','Invalid redacted attempt usage object.');
  }
  for (const key of Reflect.ownKeys(usage)) {
    if (typeof key!=='string'||PROTOTYPE_KEYS.has(key)||!allowed.has(key)) {
      fail('SECRET_LEAK_DETECTED',`Unexpected usage field '${String(key)}' in redacted backup.`);
    }
  }
  if (!['synthetic','provider reported','OpenCode reported','unavailable'].includes(usage.evidence)) {
    fail('SECRET_LEAK_DETECTED','Invalid usage evidence enum in redacted backup.');
  }
  if (!['opencode-engine-defined','provider-defined','unavailable'].includes(usage.semantics)) {
    fail('SECRET_LEAK_DETECTED','Invalid usage semantics enum in redacted backup.');
  }
  for (const field of ['input','output','cached','cacheWrite','reasoning']) {
    const val=usage[field];
    if (val!==null&&(!Number.isSafeInteger(val)||val<0)) {
      fail('BACKUP_CORRUPTED',`Invalid usage count '${field}' in redacted backup.`);
    }
  }
  for (const field of ['generationMs','loadMs','promptMs']) {
    const val=usage[field];
    if (val!==null&&(typeof val!=='number'||!Number.isFinite(val)||val<0)) {
      fail('BACKUP_CORRUPTED',`Invalid usage duration '${field}' in redacted backup.`);
    }
  }
}

function assertValidRedactedTaskRecord(rowId,parsed) {
  assertNoUnsafeObjectKeys(parsed);
  const allowed=new Set(['redacted','id','version','kind','status','sourceHash','receiptHash','attempts','events']);
  for (const key of Reflect.ownKeys(parsed)) {
    if (typeof key!=='string'||PROTOTYPE_KEYS.has(key)||!allowed.has(key)) {
      fail('SECRET_LEAK_DETECTED',`Unexpected or unredacted task field '${String(key)}' in redacted backup.`);
    }
  }
  if (parsed.redacted!==true) {
    fail('SECRET_LEAK_DETECTED','Redacted backup task record must carry redacted: true.');
  }
  const id=sanitizeIdentifier(parsed.id,'task.id');
  if (id!==rowId) fail('BACKUP_CORRUPTED','Redacted task ID mismatch.');
  if (!Number.isSafeInteger(parsed.version)||parsed.version<0||!TASK_KINDS.has(parsed.kind)||!TASK_STATUSES.has(parsed.status)) {
    fail('BACKUP_CORRUPTED','Invalid redacted task metadata.');
  }
  if (typeof parsed.sourceHash!=='string'||!SHA256_HEX.test(parsed.sourceHash)) {
    fail('BACKUP_CORRUPTED','Invalid redacted task sourceHash.');
  }
  if (parsed.receiptHash!==null&&(typeof parsed.receiptHash!=='string'||!SHA256_HEX.test(parsed.receiptHash))) {
    fail('BACKUP_CORRUPTED','Invalid redacted task receiptHash.');
  }
  if (!Array.isArray(parsed.attempts)||!Array.isArray(parsed.events)) {
    fail('BACKUP_CORRUPTED','Redacted task attempts and events must be arrays.');
  }
  const attemptAllowed=new Set([
    'id','provider','backend','started','ended','elapsedMs','status',
    'scopeHash','executionPhase','claimId','usage','artifactSha256',
    'checksPassedCount','checksFailedCount',
  ]);
  for (const attempt of parsed.attempts) {
    if (!attempt||typeof attempt!=='object'||Array.isArray(attempt)) fail('BACKUP_CORRUPTED','Invalid redacted attempt.');
    for (const key of Reflect.ownKeys(attempt)) {
      if (typeof key!=='string'||PROTOTYPE_KEYS.has(key)||!attemptAllowed.has(key)) {
        fail('SECRET_LEAK_DETECTED',`Unexpected attempt field '${String(key)}' in redacted backup.`);
      }
    }
    sanitizeIdentifier(attempt.id,'redacted attempt.id');
    assertValidRedactedUsage(attempt.usage);
    if (attempt.artifactSha256!==null&&!SHA256_HEX.test(attempt.artifactSha256)) {
      fail('BACKUP_CORRUPTED','Invalid artifactSha256 in redacted attempt.');
    }
  }
  for (const event of parsed.events) {
    if (!event||typeof event!=='object'||Array.isArray(event)||
        !Number.isSafeInteger(event.seq)||event.seq<1||
        typeof event.event!=='string'||!SAFE_EVENT_NAME.test(event.event)) {
      fail('BACKUP_CORRUPTED','Invalid event entry in redacted task.');
    }
    assertIsoTimestamp(event.at,'redacted event.at');
  }
}

function assertSupportedWorkspaceSchema(db,{requireRedactedOnly=false}={}) {
  let integrityRows;
  try {
    integrityRows=db.prepare('PRAGMA integrity_check').all();
  } catch (error) {
    fail('SQLITE_INTEGRITY_FAILED','SQLite integrity check failed.',error);
  }
  if (integrityRows.length!==1||integrityRows[0]?.integrity_check!=='ok') {
    fail('SQLITE_INTEGRITY_FAILED','SQLite database failed PRAGMA integrity_check.');
  }

  const tableRows=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const tableNames=tableRows.map(row=>row.name);
  for (const name of tableNames) {
    if (!TABLE_NAME.test(name)) fail('BACKUP_CORRUPTED',`Unsupported SQLite table name: ${name}.`);
  }
  const tableSet=new Set(tableNames);
  for (const [requiredTable,requiredCols] of Object.entries(SUPPORTED_TABLES)) {
    if (!tableSet.has(requiredTable)) {
      fail('UNSUPPORTED_WORKSPACE_SCHEMA',`Database is missing required workspace table: ${requiredTable}.`);
    }
    const colRows=db.prepare(`PRAGMA table_info("${requiredTable}")`).all();
    const colNames=colRows.map(col=>col.name);
    if (colNames.length!==requiredCols.length||requiredCols.some((name,idx)=>colNames[idx]!==name)) {
      fail('UNSUPPORTED_WORKSPACE_SCHEMA',`Workspace table ${requiredTable} does not match supported column schema.`);
    }
  }
  if (requireRedactedOnly) {
    const allowed=new Set(Object.keys(SUPPORTED_TABLES));
    for (const name of tableNames) {
      if (!allowed.has(name)) {
        fail('SECRET_LEAK_DETECTED',`Unexpected table '${name}' present in redacted backup database.`);
      }
    }
  }
  return tableNames;
}

function computeTableDigest(db,tableName) {
  const orderBy=tableName==='tasks'?'id'
    :tableName==='task_removal_audit'?'id'
    :tableName==='task_draft_copies'?'request_id'
    :'rowid';
  const rows=db.prepare(`SELECT * FROM "${tableName}" ORDER BY ${orderBy}`).all();
  const hasher=createHash('sha256');
  for (const row of rows) {
    hasher.update(JSON.stringify(row));
    hasher.update('\n');
  }
  return {count:rows.length,sha256:hasher.digest('hex'),rows};
}

function summarizeAndValidateWorkspaceDb(db,{requireRedacted=false}={}) {
  const tableNames=assertSupportedWorkspaceSchema(db,{requireRedactedOnly:requireRedacted});
  const tables={};
  const tableDigests={};
  const summary={taskCount:0,taskIds:[],versions:{},eventSequences:{},acceptedArtifactHashes:{},receiptHashes:{}};

  for (const name of tableNames) {
    const info=computeTableDigest(db,name);
    tables[name]=info.count;
    tableDigests[name]=info.sha256;

    if (name==='tasks') {
      summary.taskCount=info.count;
      for (const row of info.rows) {
        assertIsoTimestamp(row.updated,`tasks[${row.id}].updated`);
        let parsed;
        try { parsed=JSON.parse(row.data); }
        catch (error) { fail('BACKUP_CORRUPTED',`Corrupt task JSON for ${row.id}.`,error); }
        if (!parsed||typeof parsed!=='object'||Array.isArray(parsed)) {
          fail('BACKUP_CORRUPTED',`Invalid task JSON structure for ${row.id}.`);
        }
        assertNoUnsafeObjectKeys(parsed);
        if (requireRedacted) {
          assertValidRedactedTaskRecord(row.id,parsed);
          summary.taskIds.push(row.id);
          summary.versions[row.id]=parsed.version;
          summary.eventSequences[row.id]=parsed.events.map(entry=>entry.seq);
          summary.acceptedArtifactHashes[row.id]=parsed.attempts
            .filter(attempt=>attempt.status==='accepted'&&typeof attempt.artifactSha256==='string')
            .map(attempt=>attempt.artifactSha256);
          summary.receiptHashes[row.id]=parsed.receiptHash;
        } else {
          if (parsed.id!==row.id||!Number.isSafeInteger(parsed.version)||parsed.version<0) {
            fail('BACKUP_CORRUPTED',`Invalid task record structure for ${row.id}.`);
          }
          const events=Array.isArray(parsed.events)?parsed.events:[];
          const seqs=events.map(entry=>entry?.seq);
          if (seqs.some(seq=>!Number.isSafeInteger(seq)||seq<1)) {
            fail('BACKUP_CORRUPTED',`Invalid event sequence for ${row.id}.`);
          }
          const attempts=Array.isArray(parsed.attempts)?parsed.attempts:[];
          const acceptedHashes=attempts
            .filter(attempt=>attempt?.status==='accepted'&&typeof attempt?.artifact?.sha256==='string'&&SHA256_HEX.test(attempt.artifact.sha256))
            .map(attempt=>attempt.artifact.sha256);
          summary.taskIds.push(row.id);
          summary.versions[row.id]=parsed.version;
          summary.eventSequences[row.id]=seqs;
          summary.acceptedArtifactHashes[row.id]=acceptedHashes;
          const envelope=exportReceipt(parsed,{timebase:'run-relative'});
          summary.receiptHashes[row.id]=sha256Hex(Buffer.from(JSON.stringify(envelope),'utf8'));
        }
      }
    } else if (name==='task_removal_audit') {
      for (const row of info.rows) {
        if (!Number.isSafeInteger(row.id)||row.id<1) fail('UNSUPPORTED_WORKSPACE_SCHEMA','Invalid task_removal_audit.id.');
        sanitizeIdentifier(row.reference,'task_removal_audit.reference');
        assertIsoTimestamp(row.removed_at,'task_removal_audit.removed_at');
        if (row.scope!=='workspace-record-only-v1') {
          fail('UNSUPPORTED_WORKSPACE_SCHEMA',`Unsupported task_removal_audit.scope: ${row.scope}.`);
        }
      }
    } else if (name==='task_draft_copies') {
      for (const row of info.rows) {
        sanitizeIdentifier(row.request_id,'task_draft_copies.request_id');
        sanitizeIdentifier(row.source_id,'task_draft_copies.source_id');
        sanitizeIdentifier(row.draft_id,'task_draft_copies.draft_id');
        if (!Number.isSafeInteger(row.source_version)||row.source_version<0) {
          fail('UNSUPPORTED_WORKSPACE_SCHEMA','Invalid task_draft_copies.source_version.');
        }
      }
    }
  }
  return {integrity:'ok',tables,tableDigests,summary};
}

function buildRedactedDatabaseFromSnapshot(rawSnapshotPath,redactedPath) {
  let rawDb;
  let outDb;
  const excludedTables=[];
  try {
    rawDb=new DatabaseSync(rawSnapshotPath,{readOnly:true});
    const sourceMeta=summarizeAndValidateWorkspaceDb(rawDb,{requireRedacted:false});
    const tableRows=rawDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const allowed=new Set(Object.keys(SUPPORTED_TABLES));
    for (const row of tableRows) {
      if (!allowed.has(row.name)) {
        const countRow=rawDb.prepare(`SELECT count(*) AS count FROM "${row.name}"`).get();
        excludedTables.push({
          name:row.name,
          rowCount:countRow.count,
          reason:'Non-allowlisted SQLite table excluded from redacted metadata backup.',
        });
      }
    }

    outDb=new DatabaseSync(redactedPath);
    outDb.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      CREATE TABLE tasks (id TEXT PRIMARY KEY, updated TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE task_removal_audit (id INTEGER PRIMARY KEY, reference TEXT NOT NULL, removed_at TEXT NOT NULL, scope TEXT NOT NULL);
      CREATE TABLE task_draft_copies (request_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_version INTEGER NOT NULL, draft_id TEXT NOT NULL);
    `);

    const insertTask=outDb.prepare('INSERT INTO tasks VALUES (?, ?, ?)');
    for (const row of rawDb.prepare('SELECT id, updated, data FROM tasks ORDER BY id').all()) {
      const parsed=JSON.parse(row.data);
      const receiptHash=sourceMeta.summary.receiptHashes[row.id]??null;
      const redactedTask=redactTaskRecord(row.id,parsed,receiptHash);
      insertTask.run(row.id,row.updated,JSON.stringify(redactedTask));
    }

    const insertAudit=outDb.prepare('INSERT INTO task_removal_audit VALUES (?, ?, ?, ?)');
    for (const row of rawDb.prepare('SELECT id, reference, removed_at, scope FROM task_removal_audit ORDER BY id').all()) {
      insertAudit.run(row.id,row.reference,row.removed_at,row.scope);
    }

    const insertDraftCopy=outDb.prepare('INSERT INTO task_draft_copies VALUES (?, ?, ?, ?)');
    for (const row of rawDb.prepare('SELECT request_id, source_id, source_version, draft_id FROM task_draft_copies ORDER BY request_id').all()) {
      insertDraftCopy.run(row.request_id,row.source_id,row.source_version,row.draft_id);
    }

    const redactedMeta=summarizeAndValidateWorkspaceDb(outDb,{requireRedacted:true});
    return {sourceMeta,redactedMeta,excludedTables};
  } catch (error) {
    if (error instanceof BackupError) throw error;
    fail('SQLITE_INTEGRITY_FAILED','Failed to project redacted workspace database.',error);
  } finally {
    try { rawDb?.close(); } catch {}
    try { outDb?.close(); } catch {}
  }
}

function buildBackupConsistencyReport(exclusions,sourceTables) {
  const activeLockOrWalObserved=exclusions.some(
    item=>item.category==='runtime-lock'||item.category==='sqlite-journal',
  );
  const suspiciousSecretTables=Object.keys(sourceTables).filter(name=>SUSPICIOUS_TABLE_NAME.test(name));
  return {
    sqliteSnapshot:'online-backup-then-redacted-rebuild',
    copiedFilesBinding:'none-arbitrary-files-excluded',
    crossStoreConsistency:'not-applicable-redacted-db-only',
    activeLockOrWalObserved,
    archiveAuthenticity:'unsigned-sha256-checksums',
    databaseContentSecrets:'redacted-allowlisted-metadata-only',
    suspiciousSecretTables,
    sqlitePagesMayRetainDeletedData:false,
  };
}

function buildInventoryConsistencyReport(exclusions,sourceTables) {
  const activeLockOrWalObserved=exclusions.some(
    item=>item.category==='runtime-lock'||item.category==='sqlite-journal',
  );
  const suspiciousSecretTables=Object.keys(sourceTables).filter(name=>SUSPICIOUS_TABLE_NAME.test(name));
  return {
    sqliteSnapshot:'single-read-transaction-on-source',
    filesystemBinding:'unverified-sequential-traversal',
    crossStoreConsistency:'unknown',
    activeLockOrWalObserved,
    archiveAuthenticity:'unsigned-sha256-checksums',
    databaseContentSecrets:'unknown-source-database-unredacted',
    suspiciousSecretTables,
    sqlitePagesMayRetainDeletedData:true,
  };
}

function assertNoUnsafeObjectKeys(value) {
  if (value===null||typeof value!=='object') return;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key!=='string'||PROTOTYPE_KEYS.has(key)) {
      fail('MANIFEST_INVALID','Manifest contains a forbidden property key.');
    }
    assertNoUnsafeObjectKeys(Object.getOwnPropertyDescriptor(value,key).value);
  }
}

function assertPlainObject(value,allowedKeys,label) {
  if (!value||typeof value!=='object'||Array.isArray(value)) {
    fail('MANIFEST_INVALID',`${label} must be a plain object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail('MANIFEST_INVALID',`${label} contains unexpected key: ${key}.`);
  }
  return value;
}

function validateManifestSchema(manifest) {
  assertNoUnsafeObjectKeys(manifest);
  assertPlainObject(
    manifest,
    new Set([
      'format','schemaVersion','mode','createdAt','hashAlgorithm',
      'consistency','database','artifacts','exclusions','excludedTables','limits',
    ]),
    'manifest',
  );
  if (manifest.format!==BACKUP_FORMAT) fail('MANIFEST_INVALID','Unsupported backup manifest format.');
  if (manifest.schemaVersion!==BACKUP_SCHEMA_VERSION) fail('MANIFEST_INVALID','Unsupported backup schema version.');
  if (manifest.mode!==BACKUP_MODE) fail('MANIFEST_INVALID','Unsupported backup mode.');
  if (manifest.hashAlgorithm!=='sha256') fail('MANIFEST_INVALID','Unsupported hash algorithm.');
  if (typeof manifest.createdAt!=='string'||!Number.isFinite(Date.parse(manifest.createdAt))) {
    fail('MANIFEST_INVALID','Invalid manifest timestamp.');
  }

  const consistency=assertPlainObject(
    manifest.consistency,
    new Set([
      'sqliteSnapshot',
      'copiedFilesBinding',
      'crossStoreConsistency',
      'activeLockOrWalObserved',
      'archiveAuthenticity',
      'databaseContentSecrets',
      'suspiciousSecretTables',
      'sqlitePagesMayRetainDeletedData',
    ]),
    'manifest.consistency',
  );
  if (consistency.sqliteSnapshot!=='online-backup-then-redacted-rebuild'||
      consistency.copiedFilesBinding!=='none-arbitrary-files-excluded'||
      consistency.crossStoreConsistency!=='not-applicable-redacted-db-only'||
      typeof consistency.activeLockOrWalObserved!=='boolean'||
      consistency.archiveAuthenticity!=='unsigned-sha256-checksums'||
      consistency.databaseContentSecrets!=='redacted-allowlisted-metadata-only'||
      !Array.isArray(consistency.suspiciousSecretTables)||
      consistency.suspiciousSecretTables.some(name=>typeof name!=='string'||!TABLE_NAME.test(name))||
      consistency.sqlitePagesMayRetainDeletedData!==false) {
    fail('MANIFEST_INVALID','Invalid or overstated consistency metadata in manifest.');
  }

  const db=assertPlainObject(
    manifest.database,
    new Set(['path','byteLength','sha256','integrity','tables','tableDigests','summary']),
    'manifest.database',
  );
  if (db.path!=='database/workspace.sqlite') fail('MANIFEST_INVALID','Invalid database snapshot path in manifest.');
  if (!Number.isSafeInteger(db.byteLength)||db.byteLength<=0) fail('MANIFEST_INVALID','Invalid database byteLength.');
  if (typeof db.sha256!=='string'||!SHA256_HEX.test(db.sha256)) fail('MANIFEST_INVALID','Invalid database sha256.');
  if (db.integrity!=='ok') fail('MANIFEST_INVALID','Database integrity flag is not ok.');
  if (!db.tables||typeof db.tables!=='object'||Array.isArray(db.tables)) fail('MANIFEST_INVALID','Invalid tables inventory.');
  if (!db.tableDigests||typeof db.tableDigests!=='object'||Array.isArray(db.tableDigests)) {
    fail('MANIFEST_INVALID','Invalid tableDigests inventory.');
  }
  for (const [tbl,digest] of Object.entries(db.tableDigests)) {
    if (!Object.hasOwn(SUPPORTED_TABLES,tbl)||typeof digest!=='string'||!SHA256_HEX.test(digest)) {
      fail('MANIFEST_INVALID',`Invalid tableDigest entry for ${tbl}.`);
    }
  }
  assertPlainObject(db.summary,new Set(['taskCount','taskIds','versions','eventSequences','acceptedArtifactHashes','receiptHashes']),'manifest.database.summary');

  if (!Array.isArray(manifest.artifacts)||manifest.artifacts.length!==0) {
    fail('SECRET_LEAK_DETECTED','Redacted backup manifests must not include arbitrary workspace file artifacts.');
  }
  if (!Array.isArray(manifest.exclusions)||!Array.isArray(manifest.excludedTables)||!Array.isArray(manifest.limits)) {
    fail('MANIFEST_INVALID','Manifest exclusions, excludedTables, and limits must be arrays.');
  }
  for (const exc of manifest.exclusions) {
    assertPlainObject(exc,new Set(['path','category','reason']),'exclusion entry');
    assertSafeRelativePath(exc.path,'exclusion path');
    if (typeof exc.category!=='string'||typeof exc.reason!=='string') {
      fail('MANIFEST_INVALID','Invalid exclusion entry.');
    }
  }
  for (const tbl of manifest.excludedTables) {
    assertPlainObject(tbl,new Set(['name','rowCount','reason']),'excludedTable entry');
    if (typeof tbl.name!=='string'||!TABLE_NAME.test(tbl.name)||!Number.isSafeInteger(tbl.rowCount)||tbl.rowCount<0||typeof tbl.reason!=='string') {
      fail('MANIFEST_INVALID','Invalid excludedTable entry.');
    }
  }
}

async function cleanupStageDirectory(stageRoot,onCleanupStage) {
  let cleanupError=null;
  try {
    if (onCleanupStage) await onCleanupStage(stageRoot);
    await rm(stageRoot,{recursive:true,force:true});
  } catch (error) {
    cleanupError=error instanceof Error?error.message:String(error);
  }
  let residualPaths=[];
  try {
    await lstat(stageRoot,{bigint:true});
    residualPaths=[stageRoot];
  } catch (error) {
    if (error?.code!=='ENOENT') {
      residualPaths=[stageRoot];
      cleanupError??=error.message;
    }
  }
  return {
    ok:cleanupError===null&&residualPaths.length===0,
    stageDir:stageRoot,
    residualPaths,
    error:cleanupError,
  };
}

export async function inventoryWorkspace(stateDir,{dbFilename='workspace.sqlite',_testHooks={}}={}) {
  const root=assertRootPath(stateDir,'stateDir');
  assertDbFilename(dbFilename);
  await assertAncestorsNoFollow(root,'stateDir');
  const rootInfo=await statNoFollow(root,'stateDir');
  if (!rootInfo||!rootInfo.isDirectory()) fail('INVALID_PATH','Workspace state directory does not exist.');
  const dbPath=resolveContainedPath(root,dbFilename,'database path');
  const dbPreInfo=await statNoFollow(dbPath,'database file');
  if (!dbPreInfo||!dbPreInfo.isFile()) fail('MISSING_DATABASE','Workspace SQLite database does not exist.');

  let db;
  let database;
  try {
    db=new DatabaseSync(dbPath,{readOnly:true});
    db.exec('BEGIN');
    try {
      database=summarizeAndValidateWorkspaceDb(db,{requireRedacted:false});
    } finally {
      try { db.exec('ROLLBACK'); } catch {}
    }
  } catch (error) {
    if (error instanceof BackupError) throw error;
    fail('SQLITE_INTEGRITY_FAILED','Failed to open or verify SQLite database.',error);
  } finally {
    try { db?.close(); } catch {}
  }
  const dbPostInfo=await statNoFollow(dbPath,'database file');
  if (!dbPostInfo||dbPostInfo.dev!==dbPreInfo.dev||dbPostInfo.ino!==dbPreInfo.ino) {
    fail('IDENTITY_MISMATCH','Source database identity changed during inventory.');
  }

  const files=await walkDirectory(root);
  const exclusions=[];
  for (const entry of files) {
    const classification=classifyWorkspaceFile(entry.rel,dbFilename);
    const bound=await readBoundFile(entry.full,entry.lstatInfo,entry.rel,_testHooks.onBeforeOpenFile);
    exclusions.push({
      path:entry.rel,
      category:classification.category,
      byteLength:bound.byteLength,
      reason:classification.reason,
    });
  }
  const consistency=buildInventoryConsistencyReport(exclusions,database.tables);
  return {
    stateDir:root,
    dbFilename,
    consistency,
    database,
    included:[],
    exclusions,
    limits:[...BACKUP_LIMITS],
  };
}

export async function createWorkspaceBackup({
  sourceDir,
  backupDir,
  publish=true,
  mode=BACKUP_MODE,
  includeRawDatabase=false,
  includeArbitraryFiles=false,
  dbFilename='workspace.sqlite',
  now=()=>new Date().toISOString(),
  _testHooks={},
}={}) {
  if (mode!==BACKUP_MODE||includeRawDatabase===true||includeArbitraryFiles===true) {
    fail('RAW_RECOVERY_DISABLED',RAW_RECOVERY_LIMIT);
  }

  const sourceRoot=assertRootPath(sourceDir,'sourceDir');
  assertDbFilename(dbFilename);
  await assertAncestorsNoFollow(sourceRoot,'sourceDir');

  let backupRoot=null;
  if (backupDir!==undefined) {
    backupRoot=assertRootPath(backupDir,'backupDir');
    await assertDistinctPaths(sourceRoot,backupRoot,'sourceDir','backupDir');
    await assertAncestorsNoFollow(backupRoot,'backupDir');
    const backupInfo=await statNoFollow(backupRoot,'backupDir');
    if (backupInfo) {
      if (!backupInfo.isDirectory()) fail('INVALID_PATH','Backup destination must be a directory.');
      if ((await readdir(backupRoot)).length>0) {
        fail('DESTINATION_NOT_EMPTY','Backup destination directory must be empty.');
      }
    }
  } else if (publish!==false) {
    fail('INVALID_PATH','Invalid backupDir path.');
  }

  const sourceInfo=await statNoFollow(sourceRoot,'sourceDir');
  if (!sourceInfo||!sourceInfo.isDirectory()) fail('INVALID_PATH','Source workspace directory does not exist.');
  const sourceDbPath=resolveContainedPath(sourceRoot,dbFilename,'database path');
  const sourceDbPreInfo=await statNoFollow(sourceDbPath,'source database');
  if (!sourceDbPreInfo||!sourceDbPreInfo.isFile()) fail('MISSING_DATABASE','Source workspace SQLite database does not exist.');

  const allEntries=await walkDirectory(sourceRoot);
  const exclusions=[];
  for (const entry of allEntries) {
    const classification=classifyWorkspaceFile(entry.rel,dbFilename);
    exclusions.push({path:entry.rel,category:classification.category,reason:classification.reason});
  }

  const stageRoot=await mkdtemp(join(tmpdir(),'cydeworks-backup-stage-'));
  const publication={
    status:'disabled',
    targetPath:backupRoot,
    atomicNoReplaceSupported:false,
    destinationMutated:false,
    reason:ATOMIC_PUBLICATION_LIMIT,
  };

  let primaryResult=null;
  let primaryError=null;
  try {
    const stagedRawPath=resolveContainedPath(stageRoot,'raw-snapshot.sqlite','raw snapshot');
    const stagedRedactedPath=resolveContainedPath(stageRoot,'redacted.sqlite','redacted database');

    let srcDb;
    try {
      srcDb=new DatabaseSync(sourceDbPath,{readOnly:true});
      await backup(srcDb,stagedRawPath);
    } catch (error) {
      if (error instanceof BackupError) throw error;
      fail('SQLITE_INTEGRITY_FAILED','Failed to create SQLite backup snapshot.',error);
    } finally {
      try { srcDb?.close(); } catch {}
    }

    const sourceDbPostInfo=await statNoFollow(sourceDbPath,'source database');
    if (!sourceDbPostInfo||sourceDbPostInfo.dev!==sourceDbPreInfo.dev||sourceDbPostInfo.ino!==sourceDbPreInfo.ino) {
      fail('IDENTITY_MISMATCH','Source database identity changed during backup snapshot.');
    }

    let snapDb;
    try {
      snapDb=new DatabaseSync(stagedRawPath);
      snapDb.exec('PRAGMA journal_mode=DELETE;');
    } catch (error) {
      fail('SQLITE_INTEGRITY_FAILED','Failed to normalize staged SQLite snapshot journal mode.',error);
    } finally {
      try { snapDb?.close(); } catch {}
    }

    const {sourceMeta,redactedMeta,excludedTables}=buildRedactedDatabaseFromSnapshot(stagedRawPath,stagedRedactedPath);
    const dbBound=await readBoundFile(stagedRedactedPath,null,'staged redacted database');
    validateSqliteHeaderBytes(dbBound.bytes,'staged redacted database',{requireDeleteJournal:true});

    const consistency=buildBackupConsistencyReport(exclusions,sourceMeta.tables);
    const manifest={
      format:BACKUP_FORMAT,
      schemaVersion:BACKUP_SCHEMA_VERSION,
      mode:BACKUP_MODE,
      createdAt:now(),
      hashAlgorithm:'sha256',
      consistency,
      database:{
        path:'database/workspace.sqlite',
        byteLength:dbBound.byteLength,
        sha256:dbBound.sha256,
        integrity:redactedMeta.integrity,
        tables:redactedMeta.tables,
        tableDigests:redactedMeta.tableDigests,
        summary:redactedMeta.summary,
      },
      artifacts:[],
      exclusions,
      excludedTables,
      limits:[...BACKUP_LIMITS],
    };
    validateManifestSchema(manifest);

    const manifestJson=JSON.stringify(manifest,null,2)+'\n';
    const manifestBytes=Buffer.from(manifestJson,'utf8');
    const manifestSha256=sha256Hex(manifestBytes);
    const manifestDigestBytes=Buffer.from(manifestSha256+'\n','utf8');

    if (publish!==false) {
      fail('ATOMIC_PUBLICATION_UNAVAILABLE',ATOMIC_PUBLICATION_LIMIT,null,{publication});
    }

    primaryResult={
      published:false,
      publication,
      manifest,
      manifestSha256,
      archiveBytes:{
        database:dbBound.bytes,
        manifest:manifestBytes,
        manifestSha256:manifestDigestBytes,
      },
    };
  } catch (error) {
    primaryError=error;
  }

  const cleanup=await cleanupStageDirectory(stageRoot,_testHooks.onCleanupStage);
  if (primaryError) {
    if (primaryError instanceof BackupError) {
      primaryError.publication=publication;
      primaryError.cleanup=cleanup;
    }
    throw primaryError;
  }
  return {...primaryResult,cleanup};
}

async function verifyWorkspaceBackupIntoStage({backupDir,dbFilename='workspace.sqlite',stageRoot,_testHooks={}}) {
  const backupRoot=assertRootPath(backupDir,'backupDir');
  assertDbFilename(dbFilename);
  await assertAncestorsNoFollow(backupRoot,'backupDir');
  const info=await statNoFollow(backupRoot,'backupDir');
  if (!info||!info.isDirectory()) fail('INVALID_PATH','Backup directory does not exist.');

  const entries=await walkDirectory(backupRoot);
  const actualEntries=new Map();
  for (const entry of entries) {
    const parts=entry.rel.split('/');
    const base=parts.at(-1);
    if (SECRET_BASENAME.test(base)||SECRET_EXTENSION.test(base)||
        parts.slice(0,-1).some(part=>SECRET_DIR_SEGMENT.has(part.toLowerCase()))) {
      fail('SECRET_LEAK_DETECTED',`Forbidden secret file present in backup archive: ${entry.rel}.`);
    }
    if (entry.rel!=='manifest.json'&&entry.rel!=='manifest.sha256'&&entry.rel!=='database/workspace.sqlite') {
      fail('BACKUP_CORRUPTED',`Unexpected file inside redacted backup archive: ${entry.rel}.`);
    }
    actualEntries.set(entry.rel,entry);
  }

  const manifestEntry=actualEntries.get('manifest.json');
  const digestEntry=actualEntries.get('manifest.sha256');
  const dbEntry=actualEntries.get('database/workspace.sqlite');
  if (!manifestEntry||!digestEntry||!dbEntry) {
    fail('BACKUP_CORRUPTED','Backup archive is missing manifest.json, manifest.sha256, or database/workspace.sqlite.');
  }

  const manifestBound=await readBoundFile(manifestEntry.full,manifestEntry.lstatInfo,'manifest.json',_testHooks.onBeforeOpenFile);
  const digestBound=await readBoundFile(digestEntry.full,digestEntry.lstatInfo,'manifest.sha256',_testHooks.onBeforeOpenFile);
  const recordedDigest=digestBound.bytes.toString('utf8').trim();
  if (!SHA256_HEX.test(recordedDigest)) fail('BACKUP_CORRUPTED','Backup manifest.sha256 is malformed.');
  if (!timingSafeEqual(Buffer.from(manifestBound.sha256,'hex'),Buffer.from(recordedDigest,'hex'))) {
    fail('BACKUP_CORRUPTED','Backup manifest.sha256 does not match manifest.json.');
  }

  let manifest;
  try { manifest=JSON.parse(manifestBound.bytes.toString('utf8')); }
  catch (error) { fail('MANIFEST_INVALID','Backup manifest.json is not valid JSON.',error); }
  validateManifestSchema(manifest);

  const dbBound=await readBoundFile(dbEntry.full,dbEntry.lstatInfo,'database/workspace.sqlite',_testHooks.onBeforeOpenFile);
  if (dbBound.byteLength!==manifest.database.byteLength||
      !timingSafeEqual(Buffer.from(dbBound.sha256,'hex'),Buffer.from(manifest.database.sha256,'hex'))) {
    fail('BACKUP_CORRUPTED','Backup SQLite snapshot hash or byte length mismatch.');
  }
  validateSqliteHeaderBytes(dbBound.bytes,'database/workspace.sqlite',{requireDeleteJournal:true});

  const stagedVerifiedDbPath=await writePrivateVerifiedDbFile(
    stageRoot,
    'verified-input.sqlite',
    dbBound.bytes,
    manifest.database.sha256,
  );

  let db;
  let verifiedDb;
  try {
    db=new DatabaseSync(stagedVerifiedDbPath,{readOnly:true});
    verifiedDb=summarizeAndValidateWorkspaceDb(db,{requireRedacted:true});
  } catch (error) {
    if (error instanceof BackupError) throw error;
    fail('SQLITE_INTEGRITY_FAILED','Failed to open or verify private staged SQLite database.',error);
  } finally {
    try { db?.close(); } catch {}
  }

  if (JSON.stringify(verifiedDb.tables)!==JSON.stringify(manifest.database.tables)||
      JSON.stringify(verifiedDb.tableDigests)!==JSON.stringify(manifest.database.tableDigests)||
      JSON.stringify(verifiedDb.summary)!==JSON.stringify(manifest.database.summary)) {
    fail('BACKUP_CORRUPTED','Backup SQLite contents do not match manifest database summary or table digests.');
  }

  return {
    ok:true,
    manifest,
    manifestSha256:manifestBound.sha256,
    consistency:manifest.consistency,
    database:verifiedDb,
    stagedVerifiedDbPath,
    dbSha256:dbBound.sha256,
  };
}

export async function verifyWorkspaceBackup({backupDir,dbFilename='workspace.sqlite',_testHooks={}}={}) {
  const stageRoot=await mkdtemp(join(tmpdir(),'cydeworks-verify-stage-'));
  let primaryResult=null;
  let primaryError=null;
  try {
    const verified=await verifyWorkspaceBackupIntoStage({backupDir,dbFilename,stageRoot,_testHooks});
    primaryResult={
      ok:true,
      manifest:verified.manifest,
      manifestSha256:verified.manifestSha256,
      consistency:verified.consistency,
      database:verified.database,
    };
  } catch (error) {
    primaryError=error;
  }
  const cleanup=await cleanupStageDirectory(stageRoot,_testHooks.onCleanupStage);
  if (primaryError) {
    if (primaryError instanceof BackupError) primaryError.cleanup=cleanup;
    throw primaryError;
  }
  return {...primaryResult,cleanup};
}

export async function restoreWorkspaceBackup({
  backupDir,
  restoreDir,
  publish=true,
  dbFilename='workspace.sqlite',
  _testHooks={},
}={}) {
  const backupRoot=assertRootPath(backupDir,'backupDir');
  assertDbFilename(dbFilename);
  await assertAncestorsNoFollow(backupRoot,'backupDir');

  let restoreRoot=null;
  if (restoreDir!==undefined) {
    restoreRoot=assertRootPath(restoreDir,'restoreDir');
    await assertDistinctPaths(backupRoot,restoreRoot,'backupDir','restoreDir');
    await assertAncestorsNoFollow(restoreRoot,'restoreDir');
    const restoreInfo=await statNoFollow(restoreRoot,'restoreDir');
    if (restoreInfo) {
      if (!restoreInfo.isDirectory()) fail('INVALID_PATH','Restore destination must be a directory.');
      if ((await readdir(restoreRoot)).length>0) {
        fail('DESTINATION_NOT_EMPTY','Restore destination must be an empty disposable directory.');
      }
    }
  } else if (publish!==false) {
    fail('INVALID_PATH','Invalid restoreDir path.');
  }

  const stageRoot=await mkdtemp(join(tmpdir(),'cydeworks-restore-stage-'));
  const publication={
    status:'disabled',
    targetPath:restoreRoot,
    atomicNoReplaceSupported:false,
    destinationMutated:false,
    reason:ATOMIC_PUBLICATION_LIMIT,
  };

  let primaryResult=null;
  let primaryError=null;
  try {
    const verification=await verifyWorkspaceBackupIntoStage({backupDir:backupRoot,dbFilename,stageRoot,_testHooks});
    const stagedRestoredDbPath=resolveContainedPath(stageRoot,dbFilename,'staged restored database');

    let verifiedDb;
    try {
      verifiedDb=new DatabaseSync(verification.stagedVerifiedDbPath,{readOnly:true});
      await backup(verifiedDb,stagedRestoredDbPath);
    } catch (error) {
      if (error instanceof BackupError) throw error;
      fail('SQLITE_INTEGRITY_FAILED','Failed to restore verified SQLite database in staging.',error);
    } finally {
      try { verifiedDb?.close(); } catch {}
    }

    const restoredBound=await readBoundFile(stagedRestoredDbPath,null,'staged restored database');
    validateSqliteHeaderBytes(restoredBound.bytes,'staged restored database',{requireDeleteJournal:true});

    let restoredHandle;
    let restoredDb;
    try {
      restoredHandle=new DatabaseSync(stagedRestoredDbPath,{readOnly:true});
      restoredDb=summarizeAndValidateWorkspaceDb(restoredHandle,{requireRedacted:true});
    } catch (error) {
      if (error instanceof BackupError) throw error;
      fail('SQLITE_INTEGRITY_FAILED','Restored SQLite database failed verification in staging.',error);
    } finally {
      try { restoredHandle?.close(); } catch {}
    }

    if (JSON.stringify(restoredDb.tables)!==JSON.stringify(verification.manifest.database.tables)||
        JSON.stringify(restoredDb.tableDigests)!==JSON.stringify(verification.manifest.database.tableDigests)||
        JSON.stringify(restoredDb.summary)!==JSON.stringify(verification.manifest.database.summary)) {
      fail('BACKUP_CORRUPTED','Restored SQLite database does not match verified manifest summary or table digests.');
    }

    if (publish!==false) {
      fail('ATOMIC_PUBLICATION_UNAVAILABLE',ATOMIC_PUBLICATION_LIMIT,null,{publication});
    }

    primaryResult={
      restored:false,
      verifiedInStaging:true,
      publication,
      manifestSha256:verification.manifestSha256,
      consistency:verification.consistency,
      database:restoredDb,
      limits:[...verification.manifest.limits],
    };
  } catch (error) {
    primaryError=error;
  }

  const cleanup=await cleanupStageDirectory(stageRoot,_testHooks.onCleanupStage);
  if (primaryError) {
    if (primaryError instanceof BackupError) {
      primaryError.publication=publication;
      primaryError.cleanup=cleanup;
    }
    throw primaryError;
  }
  return {...primaryResult,cleanup};
}
