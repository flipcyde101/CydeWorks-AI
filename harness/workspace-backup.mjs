import {createHash, timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdtemp, open, readdir, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {exportTask} from './export.mjs';
import {exportReceipt} from './receipt-export.mjs';

export const BACKUP_FORMAT='cydeworks-workspace-backup';
export const BACKUP_SCHEMA_VERSION=3;
export const BACKUP_MODE='redacted-metadata-v1';

const MAX_FILE_BYTES=64*1024*1024;
const MAX_SOURCE_DB_BYTES=256*1024*1024;
const MAX_NESTING_DEPTH=32;
const MAX_USAGE_STEPS=64;
const SQLITE_MAGIC=Buffer.from('SQLite format 3\0','ascii');
const SHA256_HEX=/^[a-f0-9]{64}$/;
const SAFE_ID_OR_DIGEST=/^(?:[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const TABLE_NAME=/^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
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

// Every event name the workspace server persists through save(task,event).
const SAFE_EVENT_NAMES=new Set([
  'task.created',
  'task.copied_as_draft',
  'scope.updated',
  'attempt.approved_and_started',
  'attempt.dispatching',
  'attempt.review',
  'attempt.failed',
  'attempt.cancelled',
  'attempt.interrupted',
  'proposal.operator_edited',
  'review.accepted',
  'review.rejected',
]);

const USAGE_COUNT_FIELDS=Object.freeze(['input','output','cached','cacheWrite','reasoning']);
const USAGE_DURATION_FIELDS=Object.freeze(['generationMs','loadMs','promptMs']);
const USAGE_KEYS=Object.freeze(['evidence','semantics',...USAGE_COUNT_FIELDS,...USAGE_DURATION_FIELDS]);
const USAGE_SEMANTICS=new Map([
  ['synthetic','unavailable'],
  ['provider reported','provider-defined'],
  ['OpenCode reported','opencode-engine-defined'],
  ['unavailable','unavailable'],
]);
const USAGE_STEP_KEYS=Object.freeze(['items','duplicates','unidentified','identityAmbiguous','conflict','truncated']);
const ATTEMPT_KEYS=Object.freeze([
  'id','provider','backend','started','ended','elapsedMs','status',
  'scopeHash','executionPhase','claimId','usage','artifactSha256',
  'checksPassedCount','checksFailedCount',
]);
const EVENT_KEYS=Object.freeze(['seq','at','event']);
const TASK_KEYS=Object.freeze(['redacted','id','version','kind','status','sourceHash','receiptHash','attempts','events']);

const SUPPORTED_TABLES=Object.freeze({
  tasks:['id','updated','data'],
  task_removal_audit:['id','reference','removed_at','scope'],
  task_draft_copies:['request_id','source_id','source_version','draft_id'],
});
const REDACTED_TABLE_SQL=Object.freeze({
  tasks:'CREATE TABLE tasks (id TEXT PRIMARY KEY, updated TEXT NOT NULL, data TEXT NOT NULL)',
  task_removal_audit:'CREATE TABLE task_removal_audit (id INTEGER PRIMARY KEY, reference TEXT NOT NULL, removed_at TEXT NOT NULL, scope TEXT NOT NULL)',
  task_draft_copies:'CREATE TABLE task_draft_copies (request_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_version INTEGER NOT NULL, draft_id TEXT NOT NULL)',
});
const REDACTED_AUTOINDEXES=Object.freeze({
  sqlite_autoindex_tasks_1:'tasks',
  sqlite_autoindex_task_draft_copies_1:'task_draft_copies',
});
const REMOVAL_AUDIT_SCOPE='workspace-record-only-v1';

// Diagnostic text recorded in manifests is generated here, never copied from workspace data.
const EXCLUSION_REASONS=new Map([
  ['sqlite-primary','Read in one read-only SQLite transaction and projected into a fresh redacted database; never raw-copied.'],
  ['runtime-lock','Workspace owner lock file is transient runtime state.'],
  ['sqlite-journal','SQLite journal sidecars are read through the SQLite transaction and never copied.'],
  ['credential-or-secret','Access keys, session secrets, and credential files are excluded and never opened.'],
  ['backup-archive','Existing backup archives are excluded.'],
  ['unverified-arbitrary-file','Arbitrary workspace files are excluded from redacted backups because ordinary files can contain unredacted credentials.'],
]);
const EXCLUSION_ORDER=Object.freeze([...EXCLUSION_REASONS.keys()]);
const EXCLUDED_TABLE_REASON='Non-allowlisted SQLite table excluded from redacted metadata backup.';
const SQLITE_SNAPSHOT_KIND='single-read-transaction-then-redacted-rebuild';

export const ATOMIC_PUBLICATION_LIMIT=
  'Atomic no-replace directory publication into caller-supplied destinations is disabled under Node.js 24 platform APIs: O_NOFOLLOW is unavailable on win32, and openat, unlinkat, renameat2(RENAME_NOREPLACE), and handle-pinned no-replace rename are not exposed in node:fs. Path-based rollback cannot safely unlink without risking replacement files or replaced parent junctions.';

export const RAW_RECOVERY_LIMIT=
  'Raw full-database snapshots and arbitrary workspace file copies are disabled because they can retain secrets in row fields, deleted SQLite freelist pages, and unvalidated files without a separately approved retention contract.';

export const BACKUP_LIMITS=Object.freeze([
  ATOMIC_PUBLICATION_LIMIT,
  RAW_RECOVERY_LIMIT,
  'Redacted metadata backups read the source database in one read-only SQLite transaction and write only strictly validated, allowlisted task, removal-audit, and draft-copy metadata into a fresh SQLite database; no raw database copy is written. Free-text prompts, sources, expected text, model aliases, proposals, unknown tables, views, triggers, deleted SQLite pages, and arbitrary workspace files are excluded.',
  'Excluded workspace files are disclosed only as per-category counts with locally generated reasons; their names and contents are not recorded or read. Excluded SQLite table names are recorded as validated identifiers of at most 64 characters.',
  'Because free-text task content and workspace files are excluded, a redacted backup cannot restore editable task prompts or workspace artifacts. Staged restore rebuilds a fresh database from validated fields only and is not a full workspace restore.',
  'SHA-256 digests detect archive corruption and verify handle-bound SQLite bytes in private staging, but archives are unsigned and cannot prove origin authenticity.',
  'Verification rejects SQLite freelist pages in an archive but cannot prove the absence of deleted-cell residue inside allocated pages of an archive written by another writer; staged restore output is rebuilt and does not carry that residue.',
  'Private staging directories use owner-only POSIX modes; Windows ACLs on staging directories are not verified, and Windows junction races during path checks are not prevented.',
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

const SOURCE_CODES=Object.freeze({extra:'SECRET_LEAK_DETECTED',value:'UNSUPPORTED_WORKSPACE_SCHEMA'});
const ARCHIVE_CODES=Object.freeze({extra:'SECRET_LEAK_DETECTED',value:'BACKUP_CORRUPTED'});
const MANIFEST_CODES=Object.freeze({extra:'MANIFEST_INVALID',value:'MANIFEST_INVALID'});

const isCount=value=>Number.isSafeInteger(value)&&value>=0;
const isDuration=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const isSha256=value=>typeof value==='string'&&SHA256_HEX.test(value);
const isSafeId=value=>typeof value==='string'&&SAFE_ID_OR_DIGEST.test(value);
const isTableName=value=>typeof value==='string'&&TABLE_NAME.test(value);

function isIsoTimestamp(value) {
  if (typeof value!=='string'||value.length!==24) return false;
  const ms=Date.parse(value);
  return Number.isSafeInteger(ms)&&ms>=0&&new Date(ms).toISOString()===value;
}

function assertIsoTimestamp(value,code,label) {
  if (!isIsoTimestamp(value)) fail(code,`Invalid ${label} timestamp.`);
  return value;
}

function isPlainObject(value) {
  if (!value||typeof value!=='object'||Array.isArray(value)) return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype||proto===null;
}

function assertNoUnsafeObjectKeys(value,code='MANIFEST_INVALID',depth=0) {
  if (value===null||typeof value!=='object') return;
  if (depth>MAX_NESTING_DEPTH) fail(code,'Structure is nested too deeply.');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key!=='string'||PROTOTYPE_KEYS.has(key)) fail(code,'Structure contains a forbidden property key.');
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if (!('value' in descriptor)) fail(code,'Structure contains an accessor property.');
    assertNoUnsafeObjectKeys(descriptor.value,code,depth+1);
  }
}

function assertExactKeys(value,required,optional,codes,label) {
  if (!isPlainObject(value)) fail(codes.value,`Invalid ${label} structure.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key!=='string'||PROTOTYPE_KEYS.has(key)||(!required.includes(key)&&!optional.includes(key))) {
      fail(codes.extra,`Unexpected field in ${label}.`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value,key)) fail(codes.value,`Missing field in ${label}.`);
  }
  return value;
}

function assertPlainArray(value,codes,label) {
  if (!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype) fail(codes.value,`Invalid ${label} list.`);
  for (const key of Reflect.ownKeys(value)) {
    if (key==='length') continue;
    if (typeof key!=='string'||!/^(?:0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length) {
      fail(codes.extra,`Unexpected property on ${label} list.`);
    }
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
  if (info.isSymbolicLink()) fail('SYMLINK_REJECTED',`Symbolic links are not allowed at the ${label}.`);
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

function classification(category) {
  return {included:false,category,reason:EXCLUSION_REASONS.get(category)};
}

export function classifyWorkspaceFile(relPath,dbFilename='workspace.sqlite') {
  assertSafeRelativePath(relPath,'workspace path');
  assertDbFilename(dbFilename);
  const parts=relPath.split('/');
  const base=parts.at(-1);
  if (relPath===dbFilename) return classification('sqlite-primary');
  if (relPath===`${dbFilename}.owner.sqlite`||base.endsWith('.owner.sqlite')) return classification('runtime-lock');
  if (relPath===`${dbFilename}-wal`||relPath===`${dbFilename}-shm`||relPath===`${dbFilename}-journal`||
      /-(?:wal|shm|journal)$/i.test(base)) {
    return classification('sqlite-journal');
  }
  if (parts.slice(0,-1).some(part=>SECRET_DIR_SEGMENT.has(part.toLowerCase()))||
      SECRET_BASENAME.test(base)||SECRET_EXTENSION.test(base)) {
    return classification('credential-or-secret');
  }
  if (relPath==='backups'||relPath.startsWith('backups/')) return classification('backup-archive');
  return classification('unverified-arbitrary-file');
}

function isContainedCanonical(rootReal,targetReal) {
  const normRoot=process.platform==='win32'?rootReal.toLowerCase():rootReal;
  const normTarget=process.platform==='win32'?targetReal.toLowerCase():targetReal;
  const prefix=normRoot.endsWith(sep)?normRoot:normRoot+sep;
  return normTarget.startsWith(prefix);
}

// Metadata-only traversal: entries are lstat'ed and realpath'ed but never opened or read.
async function walkDirectory(rootDir,prefix='',rootReal=null) {
  const entries=[];
  const canonicalRoot=rootReal??await realpath(rootDir);
  if (!rootReal) {
    await assertAncestorsNoFollow(rootDir,'directory root');
  }
  const dirents=await readdir(rootDir,{withFileTypes:true});
  dirents.sort((a,b)=>(a.name<b.name?-1:a.name>b.name?1:0));
  for (const dirent of dirents) {
    const rel=prefix?`${prefix}/${dirent.name}`:dirent.name;
    assertSafeRelativePath(rel,'directory entry');
    const full=resolveContainedPath(rootDir,dirent.name,'directory entry');
    const info=await statNoFollow(full,'directory entry');
    if (!info) fail('INVALID_PATH','A directory entry disappeared during traversal.');
    const entryReal=await realpath(full);
    if (!isContainedCanonical(canonicalRoot,entryReal)) {
      fail('SYMLINK_REJECTED','A directory entry escapes its canonical root.');
    }
    if (info.isDirectory()) {
      entries.push(...await walkDirectory(full,rel,canonicalRoot));
    } else if (info.isFile()) {
      entries.push({rel,full,lstatInfo:info,byteLength:Number(info.size)});
    } else {
      fail('INVALID_PATH','Unsupported non-regular file in directory tree.');
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

// ---------------------------------------------------------------------------
// Strict redacted record shapes. Every value written to or accepted from a
// redacted archive passes through one of these canonical builders, so the
// output contains only fields constructed here.
// ---------------------------------------------------------------------------

function canonicalUsageSteps(steps,codes) {
  assertExactKeys(steps,USAGE_STEP_KEYS,[],codes,'usage steps');
  assertPlainArray(steps.items,codes,'usage step');
  if (steps.items.length<1||steps.items.length>MAX_USAGE_STEPS) fail(codes.value,'Invalid usage step count.');
  const items=steps.items.map(item=>{
    assertExactKeys(item,USAGE_COUNT_FIELDS,[],codes,'usage step');
    const out={};
    for (const field of USAGE_COUNT_FIELDS) {
      if (item[field]!==null&&!isCount(item[field])) fail(codes.value,'Invalid usage step count value.');
      out[field]=item[field];
    }
    return out;
  });
  if (!isCount(steps.duplicates)) fail(codes.value,'Invalid usage step duplicate count.');
  for (const flag of ['unidentified','identityAmbiguous','conflict','truncated']) {
    if (typeof steps[flag]!=='boolean') fail(codes.value,'Invalid usage step flag.');
  }
  return {
    items,
    duplicates:steps.duplicates,
    unidentified:steps.unidentified,
    identityAmbiguous:steps.identityAmbiguous,
    conflict:steps.conflict,
    truncated:steps.truncated,
  };
}

function canonicalUsage(usage,codes) {
  assertExactKeys(usage,USAGE_KEYS,['steps'],codes,'attempt usage');
  if (typeof usage.evidence!=='string'||!USAGE_SEMANTICS.has(usage.evidence)) fail(codes.value,'Invalid usage evidence.');
  if (usage.semantics!==USAGE_SEMANTICS.get(usage.evidence)) fail(codes.value,'Invalid usage semantics.');
  const out={evidence:usage.evidence,semantics:usage.semantics};
  for (const field of USAGE_COUNT_FIELDS) {
    if (usage[field]!==null&&!isCount(usage[field])) fail(codes.value,'Invalid usage count.');
    out[field]=usage[field];
  }
  for (const field of USAGE_DURATION_FIELDS) {
    if (usage[field]!==null&&!isDuration(usage[field])) fail(codes.value,'Invalid usage duration.');
    out[field]=usage[field];
  }
  if (Object.hasOwn(usage,'steps')) {
    if (usage.evidence!=='OpenCode reported') fail(codes.extra,'Usage steps are only allowed for OpenCode reported usage.');
    out.steps=canonicalUsageSteps(usage.steps,codes);
  }
  return out;
}

function canonicalAttempt(attempt,codes) {
  assertExactKeys(attempt,ATTEMPT_KEYS,[],codes,'attempt');
  const nullable=(value,check)=>value===null||check(value);
  if (!isSafeId(attempt.id)) fail(codes.value,'Invalid attempt identifier.');
  if (!PROVIDERS.has(attempt.provider)) fail(codes.value,'Invalid attempt provider.');
  if (!BACKENDS.has(attempt.backend)) fail(codes.value,'Invalid attempt backend.');
  if (!nullable(attempt.started,isIsoTimestamp)) fail(codes.value,'Invalid attempt start timestamp.');
  if (!nullable(attempt.ended,isIsoTimestamp)) fail(codes.value,'Invalid attempt end timestamp.');
  if (!nullable(attempt.elapsedMs,isDuration)) fail(codes.value,'Invalid attempt elapsed time.');
  if (!TASK_STATUSES.has(attempt.status)) fail(codes.value,'Invalid attempt status.');
  if (!nullable(attempt.scopeHash,isSha256)) fail(codes.value,'Invalid attempt scope hash.');
  if (!nullable(attempt.executionPhase,value=>EXECUTION_PHASES.has(value))) fail(codes.value,'Invalid attempt execution phase.');
  if (!nullable(attempt.claimId,isSafeId)) fail(codes.value,'Invalid attempt claim identifier.');
  if (!nullable(attempt.artifactSha256,isSha256)) fail(codes.value,'Invalid attempt artifact digest.');
  if (!isCount(attempt.checksPassedCount)||!isCount(attempt.checksFailedCount)) fail(codes.value,'Invalid attempt check counts.');
  return {
    id:attempt.id,
    provider:attempt.provider,
    backend:attempt.backend,
    started:attempt.started,
    ended:attempt.ended,
    elapsedMs:attempt.elapsedMs,
    status:attempt.status,
    scopeHash:attempt.scopeHash,
    executionPhase:attempt.executionPhase,
    claimId:attempt.claimId,
    usage:canonicalUsage(attempt.usage,codes),
    artifactSha256:attempt.artifactSha256,
    checksPassedCount:attempt.checksPassedCount,
    checksFailedCount:attempt.checksFailedCount,
  };
}

function canonicalEvent(event,codes) {
  assertExactKeys(event,EVENT_KEYS,[],codes,'event');
  if (!Number.isSafeInteger(event.seq)||event.seq<1) fail(codes.value,'Invalid event sequence.');
  assertIsoTimestamp(event.at,codes.value,'event');
  if (typeof event.event!=='string'||!SAFE_EVENT_NAMES.has(event.event)) fail(codes.value,'Unsupported event name.');
  return {seq:event.seq,at:event.at,event:event.event};
}

function canonicalRedactedTask(record,rowId,codes) {
  assertExactKeys(record,TASK_KEYS,[],codes,'task');
  if (record.redacted!==true) fail(codes.extra,'Redacted task record must carry redacted: true.');
  if (!isSafeId(record.id)||record.id!==rowId) fail(codes.value,'Task record identifier does not match its row.');
  if (!Number.isSafeInteger(record.version)||record.version<0) fail(codes.value,'Invalid task version.');
  if (!TASK_KINDS.has(record.kind)) fail(codes.value,'Unsupported task kind.');
  if (!TASK_STATUSES.has(record.status)) fail(codes.value,'Unsupported task status.');
  if (!isSha256(record.sourceHash)) fail(codes.value,'Invalid task source hash.');
  if (record.receiptHash!==null&&!isSha256(record.receiptHash)) fail(codes.value,'Invalid task receipt hash.');
  assertPlainArray(record.attempts,codes,'attempt');
  assertPlainArray(record.events,codes,'event');
  const attempts=record.attempts.map(attempt=>canonicalAttempt(attempt,codes));
  const events=record.events.map(event=>canonicalEvent(event,codes));
  let previous=0;
  for (const event of events) {
    if (event.seq<=previous) fail(codes.value,'Task event sequences must strictly increase.');
    previous=event.seq;
  }
  if (previous>record.version) fail(codes.value,'Task event sequence exceeds task version.');
  return {
    redacted:true,
    id:record.id,
    version:record.version,
    kind:record.kind,
    status:record.status,
    sourceHash:record.sourceHash,
    receiptHash:record.receiptHash,
    attempts,
    events,
  };
}

// Project one source task into a candidate redacted record, then pass it
// through the same canonical validator used for archives.
function projectSourceTask(rowId,parsed) {
  const codes=SOURCE_CODES;
  if (!isSafeId(parsed.id)||parsed.id!==rowId) fail('BACKUP_CORRUPTED','Task row identifier does not match its serialized record.');
  if (!Array.isArray(parsed.attempts)) fail('BACKUP_CORRUPTED','Task attempts must be a list.');
  if (!Array.isArray(parsed.events)) fail('BACKUP_CORRUPTED','Task events must be a list.');

  let receiptHash;
  let minimal;
  try {
    receiptHash=sha256Hex(Buffer.from(JSON.stringify(exportReceipt(parsed,{timebase:'run-relative'})),'utf8'));
    minimal=exportTask(parsed,'minimal');
  } catch {
    fail(codes.value,'Task receipt or usage metadata could not be derived.');
  }

  const attempts=parsed.attempts.map((attempt,index)=>{
    if (!isPlainObject(attempt)) fail('BACKUP_CORRUPTED','Invalid attempt entry.');
    const execution=attempt.execution;
    if (execution!=null&&!isPlainObject(execution)) fail(codes.value,'Invalid attempt execution record.');
    const checks=attempt.checks??[];
    if (!Array.isArray(checks)) fail(codes.value,'Invalid attempt checks list.');
    let checksPassedCount=0;
    let checksFailedCount=0;
    for (const check of checks) {
      if (check?.pass===true) checksPassedCount++;
      else checksFailedCount++;
    }
    const artifact=isPlainObject(attempt.artifact)?attempt.artifact:null;
    return canonicalAttempt({
      id:attempt.id,
      provider:PROVIDERS.has(attempt.provider)?attempt.provider:'other',
      backend:BACKENDS.has(attempt.backend)?attempt.backend:'other',
      started:attempt.started??null,
      ended:attempt.ended??null,
      elapsedMs:isDuration(attempt.elapsedMs)?attempt.elapsedMs:null,
      status:attempt.status,
      scopeHash:attempt.scopeHash??null,
      executionPhase:execution?.phase??null,
      claimId:execution?.claimId??null,
      usage:minimal.task.attempts[index].usage,
      artifactSha256:isSha256(artifact?.sha256)?artifact.sha256:null,
      checksPassedCount,
      checksFailedCount,
    },codes);
  });

  const events=parsed.events.map(entry=>{
    if (!isPlainObject(entry)) fail('BACKUP_CORRUPTED','Invalid event entry.');
    return {seq:entry.seq,at:entry.at,event:entry.event};
  });

  return canonicalRedactedTask({
    redacted:true,
    id:parsed.id,
    version:parsed.version,
    kind:parsed.kind,
    status:parsed.status,
    sourceHash:parsed.sourceHash,
    receiptHash,
    attempts,
    events,
  },rowId,codes);
}

// ---------------------------------------------------------------------------
// SQLite reading and writing.
// ---------------------------------------------------------------------------

function pragmaValue(db,name) {
  const row=db.prepare(`PRAGMA ${name}`).get();
  return row?Object.values(row)[0]:undefined;
}

function assertSchemaObjects(db,{redacted}) {
  const objectCode=redacted?'SECRET_LEAK_DETECTED':'UNSUPPORTED_WORKSPACE_SCHEMA';
  const objects=db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();
  const tableNames=[];
  for (const object of objects) {
    if (typeof object.type!=='string'||typeof object.name!=='string') fail(objectCode,'Invalid SQLite schema object.');
    if (object.type==='table') {
      if (object.name.startsWith('sqlite_')) {
        if (redacted) fail(objectCode,'Unexpected internal SQLite table in redacted backup.');
        continue;
      }
      if (!isTableName(object.name)) fail(objectCode,'Unsupported SQLite table name.');
      tableNames.push(object.name);
    } else if (object.type==='view'||object.type==='trigger') {
      if (!redacted) fail(objectCode,'SQLite views and triggers are not supported in the source workspace.');
    } else if (object.type!=='index') {
      fail(objectCode,'Unsupported SQLite schema object type.');
    }
  }
  tableNames.sort();

  for (const [requiredTable,requiredCols] of Object.entries(SUPPORTED_TABLES)) {
    if (!tableNames.includes(requiredTable)) {
      fail('UNSUPPORTED_WORKSPACE_SCHEMA','Database is missing a required workspace table.');
    }
    const colNames=db.prepare(`PRAGMA table_info("${requiredTable}")`).all().map(col=>col.name);
    if (colNames.length!==requiredCols.length||requiredCols.some((name,idx)=>colNames[idx]!==name)) {
      fail('UNSUPPORTED_WORKSPACE_SCHEMA','A workspace table does not match the supported column schema.');
    }
  }

  if (redacted) {
    const expectedCount=Object.keys(REDACTED_TABLE_SQL).length+Object.keys(REDACTED_AUTOINDEXES).length;
    if (objects.length!==expectedCount) fail(objectCode,'Unexpected SQLite schema objects in redacted backup.');
    for (const object of objects) {
      if (object.type==='table') {
        if (!Object.hasOwn(REDACTED_TABLE_SQL,object.name)||object.tbl_name!==object.name||
            object.sql!==REDACTED_TABLE_SQL[object.name]) {
          fail(objectCode,'Unexpected SQLite table definition in redacted backup.');
        }
      } else if (object.type==='index') {
        if (!Object.hasOwn(REDACTED_AUTOINDEXES,object.name)||object.tbl_name!==REDACTED_AUTOINDEXES[object.name]||
            object.sql!==null) {
          fail(objectCode,'Unexpected SQLite index in redacted backup.');
        }
      } else {
        fail(objectCode,'Unexpected SQLite view or trigger in redacted backup.');
      }
    }
    if (pragmaValue(db,'freelist_count')!==0) fail(objectCode,'Redacted backup contains SQLite freelist pages that can retain deleted data.');
    if (pragmaValue(db,'user_version')!==0||pragmaValue(db,'application_id')!==0) {
      fail(objectCode,'Unexpected SQLite header metadata in redacted backup.');
    }
  }
  return tableNames;
}

function digestRows(rows) {
  const hasher=createHash('sha256');
  for (const row of rows) {
    hasher.update(JSON.stringify(row));
    hasher.update('\n');
  }
  return hasher.digest('hex');
}

// Reads, validates, and projects a workspace database. The caller owns the
// read transaction. In source mode the result is the redacted projection; in
// redacted mode every row must already be canonical.
function readWorkspaceDb(db,{redacted}) {
  const codes=redacted?ARCHIVE_CODES:SOURCE_CODES;
  let integrityRows;
  try {
    integrityRows=db.prepare('PRAGMA integrity_check').all();
  } catch (error) {
    fail('SQLITE_INTEGRITY_FAILED','SQLite integrity check failed.',error);
  }
  if (integrityRows.length!==1||integrityRows[0]?.integrity_check!=='ok') {
    fail('SQLITE_INTEGRITY_FAILED','SQLite database failed PRAGMA integrity_check.');
  }

  const tableNames=assertSchemaObjects(db,{redacted});

  const tasks=[];
  const summary={taskCount:0,taskIds:[],versions:{},eventSequences:{},acceptedArtifactHashes:{},receiptHashes:{}};
  for (const row of db.prepare('SELECT id, updated, data FROM tasks ORDER BY id').all()) {
    if (!isSafeId(row.id)) fail(codes.value,'Unsupported task row identifier.');
    assertIsoTimestamp(row.updated,codes.value,'task updated');
    if (typeof row.data!=='string') fail(codes.value,'Task data must be text.');
    let parsed;
    try { parsed=JSON.parse(row.data); }
    catch { fail('BACKUP_CORRUPTED','Task JSON could not be parsed.'); }
    if (!isPlainObject(parsed)) fail('BACKUP_CORRUPTED','Task JSON must be an object.');
    assertNoUnsafeObjectKeys(parsed,redacted?'SECRET_LEAK_DETECTED':'UNSUPPORTED_WORKSPACE_SCHEMA');
    const record=redacted?canonicalRedactedTask(parsed,row.id,codes):projectSourceTask(row.id,parsed);
    const data=JSON.stringify(record);
    if (redacted&&data!==row.data) {
      fail('SECRET_LEAK_DETECTED','Redacted task data is not in canonical locally generated form.');
    }
    tasks.push({id:row.id,updated:row.updated,data});
    summary.taskIds.push(record.id);
    summary.versions[record.id]=record.version;
    summary.eventSequences[record.id]=record.events.map(event=>event.seq);
    summary.acceptedArtifactHashes[record.id]=record.attempts
      .filter(attempt=>attempt.status==='accepted'&&attempt.artifactSha256!==null)
      .map(attempt=>attempt.artifactSha256);
    summary.receiptHashes[record.id]=record.receiptHash;
  }
  summary.taskCount=tasks.length;

  const audit=[];
  for (const row of db.prepare('SELECT id, reference, removed_at, scope FROM task_removal_audit ORDER BY id').all()) {
    if (!Number.isSafeInteger(row.id)||row.id<1) fail(codes.value,'Invalid removal audit identifier.');
    if (!isSafeId(row.reference)) fail(codes.value,'Invalid removal audit reference.');
    assertIsoTimestamp(row.removed_at,codes.value,'removal audit');
    if (row.scope!==REMOVAL_AUDIT_SCOPE) fail(codes.value,'Unsupported removal audit scope.');
    audit.push({id:row.id,reference:row.reference,removed_at:row.removed_at,scope:row.scope});
  }

  const copies=[];
  for (const row of db.prepare('SELECT request_id, source_id, source_version, draft_id FROM task_draft_copies ORDER BY request_id').all()) {
    if (!isSafeId(row.request_id)||!isSafeId(row.source_id)||!isSafeId(row.draft_id)) {
      fail(codes.value,'Invalid draft copy identifier.');
    }
    if (!Number.isSafeInteger(row.source_version)||row.source_version<0) fail(codes.value,'Invalid draft copy source version.');
    copies.push({request_id:row.request_id,source_id:row.source_id,source_version:row.source_version,draft_id:row.draft_id});
  }

  const tables={};
  const excludedTables=[];
  for (const name of tableNames) {
    if (name==='tasks') tables[name]=tasks.length;
    else if (name==='task_removal_audit') tables[name]=audit.length;
    else if (name==='task_draft_copies') tables[name]=copies.length;
    else {
      let rowCount;
      try { rowCount=db.prepare(`SELECT count(*) AS count FROM "${name}"`).get().count; }
      catch { fail('UNSUPPORTED_WORKSPACE_SCHEMA','A non-allowlisted SQLite table could not be counted.'); }
      if (!isCount(rowCount)) fail('UNSUPPORTED_WORKSPACE_SCHEMA','A non-allowlisted SQLite table count is invalid.');
      tables[name]=rowCount;
      excludedTables.push({name,rowCount,reason:EXCLUDED_TABLE_REASON});
    }
  }
  const tableDigests={
    task_draft_copies:digestRows(copies),
    task_removal_audit:digestRows(audit),
    tasks:digestRows(tasks),
  };
  return {
    integrity:'ok',
    tables,
    tableDigests,
    summary,
    rows:{tasks,audit,copies},
    excludedTables,
    sourceTableNames:tableNames,
  };
}

function publicDatabaseFacts(facts) {
  return {integrity:facts.integrity,tables:facts.tables,tableDigests:facts.tableDigests,summary:facts.summary};
}

function sameDatabaseFacts(a,b) {
  return JSON.stringify(a.tables)===JSON.stringify(b.tables)&&
    JSON.stringify(a.tableDigests)===JSON.stringify(b.tableDigests)&&
    JSON.stringify(a.summary)===JSON.stringify(b.summary);
}

function readDatabaseFile(dbPath,{redacted}) {
  let db;
  try {
    db=new DatabaseSync(dbPath,{readOnly:true});
    db.exec('BEGIN');
    try {
      return readWorkspaceDb(db,{redacted});
    } finally {
      try { db.exec('ROLLBACK'); } catch {}
    }
  } catch (error) {
    if (error instanceof BackupError) throw error;
    fail('SQLITE_INTEGRITY_FAILED',redacted
      ?'Failed to open or verify private staged SQLite database.'
      :'Failed to open or read source SQLite database.',error);
  } finally {
    try { db?.close(); } catch {}
  }
}

// Writes a brand-new SQLite file from validated canonical rows only. No pages
// are copied from any other database.
function writeRedactedDatabase(dbPath,rows) {
  let out;
  try {
    out=new DatabaseSync(dbPath);
    out.exec('PRAGMA journal_mode=DELETE');
    out.exec('PRAGMA synchronous=FULL');
    out.exec('PRAGMA secure_delete=ON');
    for (const sql of Object.values(REDACTED_TABLE_SQL)) out.exec(sql);
    out.exec('BEGIN');
    const insertTask=out.prepare('INSERT INTO tasks VALUES (?, ?, ?)');
    for (const row of rows.tasks) insertTask.run(row.id,row.updated,row.data);
    const insertAudit=out.prepare('INSERT INTO task_removal_audit VALUES (?, ?, ?, ?)');
    for (const row of rows.audit) insertAudit.run(row.id,row.reference,row.removed_at,row.scope);
    const insertCopy=out.prepare('INSERT INTO task_draft_copies VALUES (?, ?, ?, ?)');
    for (const row of rows.copies) insertCopy.run(row.request_id,row.source_id,row.source_version,row.draft_id);
    out.exec('COMMIT');
  } finally {
    try { out?.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Manifest construction and validation.
// ---------------------------------------------------------------------------

function summarizeExclusions(entries) {
  const counts=new Map();
  for (const entry of entries) counts.set(entry.category,(counts.get(entry.category)??0)+1);
  return EXCLUSION_ORDER.filter(category=>counts.has(category)).map(category=>({category,count:counts.get(category)}));
}

function buildManifest({createdAt,database,exclusions,excludedTables}) {
  const excludedNames=excludedTables.map(table=>table.name);
  return {
    format:BACKUP_FORMAT,
    schemaVersion:BACKUP_SCHEMA_VERSION,
    mode:BACKUP_MODE,
    createdAt,
    hashAlgorithm:'sha256',
    consistency:{
      sqliteSnapshot:SQLITE_SNAPSHOT_KIND,
      copiedFilesBinding:'none-arbitrary-files-excluded',
      crossStoreConsistency:'not-applicable-redacted-db-only',
      activeLockOrWalObserved:exclusions.some(item=>item.category==='runtime-lock'||item.category==='sqlite-journal'),
      archiveAuthenticity:'unsigned-sha256-checksums',
      databaseContentSecrets:'redacted-allowlisted-metadata-only',
      suspiciousSecretTables:excludedNames.filter(name=>SUSPICIOUS_TABLE_NAME.test(name)),
      sqlitePagesMayRetainDeletedData:false,
    },
    database:{
      path:'database/workspace.sqlite',
      byteLength:database.byteLength,
      sha256:database.sha256,
      integrity:'ok',
      tables:database.tables,
      tableDigests:database.tableDigests,
      summary:database.summary,
    },
    artifacts:[],
    exclusions:exclusions.map(item=>({category:item.category,count:item.count,reason:EXCLUSION_REASONS.get(item.category)})),
    excludedTables:excludedTables.map(table=>({name:table.name,rowCount:table.rowCount,reason:EXCLUDED_TABLE_REASON})),
    limits:[...BACKUP_LIMITS],
  };
}

const serializeManifest=manifest=>JSON.stringify(manifest,null,2)+'\n';

function validateManifestSchema(manifest) {
  const codes=MANIFEST_CODES;
  assertNoUnsafeObjectKeys(manifest,'MANIFEST_INVALID');
  assertExactKeys(manifest,[
    'format','schemaVersion','mode','createdAt','hashAlgorithm',
    'consistency','database','artifacts','exclusions','excludedTables','limits',
  ],[],codes,'manifest');
  if (manifest.format!==BACKUP_FORMAT) fail('MANIFEST_INVALID','Unsupported backup manifest format.');
  if (manifest.schemaVersion!==BACKUP_SCHEMA_VERSION) fail('MANIFEST_INVALID','Unsupported backup schema version.');
  if (manifest.mode!==BACKUP_MODE) fail('MANIFEST_INVALID','Unsupported backup mode.');
  if (manifest.hashAlgorithm!=='sha256') fail('MANIFEST_INVALID','Unsupported hash algorithm.');
  assertIsoTimestamp(manifest.createdAt,'MANIFEST_INVALID','manifest');

  if (!Array.isArray(manifest.artifacts)||manifest.artifacts.length!==0) {
    fail('SECRET_LEAK_DETECTED','Redacted backup manifests must not include arbitrary workspace file artifacts.');
  }

  const consistency=assertExactKeys(manifest.consistency,[
    'sqliteSnapshot','copiedFilesBinding','crossStoreConsistency','activeLockOrWalObserved',
    'archiveAuthenticity','databaseContentSecrets','suspiciousSecretTables','sqlitePagesMayRetainDeletedData',
  ],[],codes,'manifest consistency');
  if (consistency.sqliteSnapshot!==SQLITE_SNAPSHOT_KIND||
      consistency.copiedFilesBinding!=='none-arbitrary-files-excluded'||
      consistency.crossStoreConsistency!=='not-applicable-redacted-db-only'||
      typeof consistency.activeLockOrWalObserved!=='boolean'||
      consistency.archiveAuthenticity!=='unsigned-sha256-checksums'||
      consistency.databaseContentSecrets!=='redacted-allowlisted-metadata-only'||
      !Array.isArray(consistency.suspiciousSecretTables)||
      consistency.suspiciousSecretTables.some(name=>!isTableName(name))||
      consistency.sqlitePagesMayRetainDeletedData!==false) {
    fail('MANIFEST_INVALID','Invalid or overstated consistency metadata in manifest.');
  }

  const db=assertExactKeys(manifest.database,
    ['path','byteLength','sha256','integrity','tables','tableDigests','summary'],[],codes,'manifest database');
  if (db.path!=='database/workspace.sqlite') fail('MANIFEST_INVALID','Invalid database snapshot path in manifest.');
  if (!Number.isSafeInteger(db.byteLength)||db.byteLength<=0||db.byteLength>MAX_FILE_BYTES) {
    fail('MANIFEST_INVALID','Invalid database byteLength.');
  }
  if (!isSha256(db.sha256)) fail('MANIFEST_INVALID','Invalid database sha256.');
  if (db.integrity!=='ok') fail('MANIFEST_INVALID','Database integrity flag is not ok.');
  assertExactKeys(db.tables,Object.keys(SUPPORTED_TABLES),[],codes,'manifest tables inventory');
  assertExactKeys(db.tableDigests,Object.keys(SUPPORTED_TABLES),[],codes,'manifest table digests');
  for (const name of Object.keys(SUPPORTED_TABLES)) {
    if (!isCount(db.tables[name])) fail('MANIFEST_INVALID','Invalid table count in manifest.');
    if (!isSha256(db.tableDigests[name])) fail('MANIFEST_INVALID','Invalid table digest in manifest.');
  }
  assertExactKeys(db.summary,
    ['taskCount','taskIds','versions','eventSequences','acceptedArtifactHashes','receiptHashes'],[],codes,'manifest summary');

  assertPlainArray(manifest.exclusions,codes,'manifest exclusions');
  let previousIndex=-1;
  for (const exclusion of manifest.exclusions) {
    assertExactKeys(exclusion,['category','count','reason'],[],codes,'manifest exclusion');
    const index=EXCLUSION_ORDER.indexOf(exclusion.category);
    if (index<0||index<=previousIndex) fail('MANIFEST_INVALID','Unsupported or out-of-order exclusion category.');
    previousIndex=index;
    if (!Number.isSafeInteger(exclusion.count)||exclusion.count<1) fail('MANIFEST_INVALID','Invalid exclusion count.');
    if (exclusion.reason!==EXCLUSION_REASONS.get(exclusion.category)) {
      fail('MANIFEST_INVALID','Exclusion reason is not locally generated text.');
    }
  }

  assertPlainArray(manifest.excludedTables,codes,'manifest excluded tables');
  let previousName=null;
  for (const table of manifest.excludedTables) {
    assertExactKeys(table,['name','rowCount','reason'],[],codes,'manifest excluded table');
    if (!isTableName(table.name)||Object.hasOwn(SUPPORTED_TABLES,table.name)||table.name.startsWith('sqlite_')||
        (previousName!==null&&table.name<=previousName)) {
      fail('MANIFEST_INVALID','Invalid excluded table name.');
    }
    previousName=table.name;
    if (!isCount(table.rowCount)) fail('MANIFEST_INVALID','Invalid excluded table row count.');
    if (table.reason!==EXCLUDED_TABLE_REASON) fail('MANIFEST_INVALID','Excluded table reason is not locally generated text.');
  }

  assertPlainArray(manifest.limits,codes,'manifest limits');
  if (manifest.limits.length!==BACKUP_LIMITS.length||manifest.limits.some((limit,index)=>limit!==BACKUP_LIMITS[index])) {
    fail('MANIFEST_INVALID','Manifest limits are not locally generated text.');
  }
}

// ---------------------------------------------------------------------------
// Staging lifecycle.
// ---------------------------------------------------------------------------

const notStagedCleanup=()=>({ok:true,staged:false,stageDir:null,residualPaths:[],error:null});

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
      cleanupError??=error instanceof Error?error.message:String(error);
    }
  }
  return {
    ok:cleanupError===null&&residualPaths.length===0,
    staged:true,
    stageDir:stageRoot,
    residualPaths,
    error:cleanupError,
  };
}

// Every failure after a stage exists carries the cleanup result. Native errors
// are wrapped so callers always receive a BackupError with the original cause.
function attachStageOutcome(error,{publication,cleanup}) {
  const out=error instanceof BackupError
    ?error
    :new BackupError('STAGING_FAILED','Operation failed after the private staging directory was created.',error);
  if (publication) out.publication=publication;
  out.cleanup=cleanup;
  return out;
}

async function runInStage(prefix,hooks,publication,work) {
  const stageRoot=await mkdtemp(join(tmpdir(),prefix));
  let result=null;
  let primaryError=null;
  try {
    result=await work(stageRoot);
  } catch (error) {
    primaryError=error??new Error('Unknown staging failure.');
  }
  const cleanup=await cleanupStageDirectory(stageRoot,hooks.onCleanupStage);
  if (primaryError) throw attachStageOutcome(primaryError,{publication,cleanup});
  return {...result,cleanup};
}

function disabledPublication(targetPath) {
  return {
    status:'disabled',
    targetPath,
    atomicNoReplaceSupported:false,
    destinationMutated:false,
    reason:ATOMIC_PUBLICATION_LIMIT,
  };
}

async function assertEmptyDestination(root,code,message) {
  const info=await statNoFollow(root,'destination');
  if (info) {
    if (!info.isDirectory()) fail('INVALID_PATH','Destination must be a directory.');
    if ((await readdir(root)).length>0) fail(code,message);
  }
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

async function openSourceDatabase(root,dbFilename) {
  const dbPath=resolveContainedPath(root,dbFilename,'database path');
  const preInfo=await statNoFollow(dbPath,'database file');
  if (!preInfo||!preInfo.isFile()) fail('MISSING_DATABASE','Workspace SQLite database does not exist.');
  if (preInfo.size>BigInt(MAX_SOURCE_DB_BYTES)) fail('RESOURCE_LIMIT_EXCEEDED','Workspace SQLite database exceeds the supported size.');
  const facts=readDatabaseFile(dbPath,{redacted:false});
  const postInfo=await statNoFollow(dbPath,'database file');
  if (!postInfo||postInfo.dev!==preInfo.dev||postInfo.ino!==preInfo.ino) {
    fail('IDENTITY_MISMATCH','Source database identity changed while it was read.');
  }
  return facts;
}

export async function inventoryWorkspace(stateDir,{dbFilename='workspace.sqlite'}={}) {
  const root=assertRootPath(stateDir,'stateDir');
  assertDbFilename(dbFilename);
  await assertAncestorsNoFollow(root,'stateDir');
  const rootInfo=await statNoFollow(root,'stateDir');
  if (!rootInfo||!rootInfo.isDirectory()) fail('INVALID_PATH','Workspace state directory does not exist.');
  const facts=await openSourceDatabase(root,dbFilename);

  // Filesystem metadata only: no workspace file, including credential files, is opened or read.
  const files=await walkDirectory(root);
  const exclusions=files.map(entry=>{
    const {category,reason}=classifyWorkspaceFile(entry.rel,dbFilename);
    return {path:entry.rel,category,byteLength:entry.byteLength,reason};
  });
  const activeLockOrWalObserved=exclusions.some(item=>item.category==='runtime-lock'||item.category==='sqlite-journal');
  return {
    stateDir:root,
    dbFilename,
    consistency:{
      sqliteSnapshot:'single-read-transaction-on-source',
      filesystemBinding:'unverified-sequential-traversal-metadata-only',
      crossStoreConsistency:'unknown',
      activeLockOrWalObserved,
      archiveAuthenticity:'unsigned-sha256-checksums',
      databaseContentSecrets:'unknown-source-database-unredacted',
      suspiciousSecretTables:facts.sourceTableNames.filter(name=>SUSPICIOUS_TABLE_NAME.test(name)),
      sqlitePagesMayRetainDeletedData:true,
    },
    database:publicDatabaseFacts(facts),
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
    await assertEmptyDestination(backupRoot,'DESTINATION_NOT_EMPTY','Backup destination directory must be empty.');
  } else if (publish!==false) {
    fail('INVALID_PATH','Invalid backupDir path.');
  }

  const publication=disabledPublication(backupRoot);
  if (publish!==false) {
    // Rejected before any database read or staging write.
    fail('ATOMIC_PUBLICATION_UNAVAILABLE',ATOMIC_PUBLICATION_LIMIT,null,{publication,cleanup:notStagedCleanup()});
  }

  const sourceInfo=await statNoFollow(sourceRoot,'sourceDir');
  if (!sourceInfo||!sourceInfo.isDirectory()) fail('INVALID_PATH','Source workspace directory does not exist.');

  const exclusions=summarizeExclusions((await walkDirectory(sourceRoot)).map(entry=>classifyWorkspaceFile(entry.rel,dbFilename)));
  const createdAt=now();
  if (!isIsoTimestamp(createdAt)) fail('INVALID_ARGUMENT','The backup timestamp must be an ISO 8601 UTC string.');

  // One read-only transaction; redacted rows are projected in memory and no raw copy is written.
  const projected=await openSourceDatabase(sourceRoot,dbFilename);

  return runInStage('cydeworks-backup-stage-',_testHooks,publication,async stageRoot=>{
    const stagedRedactedPath=resolveContainedPath(stageRoot,'redacted.sqlite','redacted database');
    writeRedactedDatabase(stagedRedactedPath,projected.rows);
    if (_testHooks.onStaged) await _testHooks.onStaged(stageRoot);

    const dbBound=await readBoundFile(stagedRedactedPath,null,'staged redacted database');
    validateSqliteHeaderBytes(dbBound.bytes,'staged redacted database',{requireDeleteJournal:true});
    const redacted=readDatabaseFile(stagedRedactedPath,{redacted:true});
    const expected={
      tables:Object.fromEntries(Object.keys(SUPPORTED_TABLES).sort().map(name=>[name,projected.tables[name]])),
      tableDigests:projected.tableDigests,
      summary:projected.summary,
    };
    if (!sameDatabaseFacts(redacted,expected)) {
      fail('BACKUP_CORRUPTED','Staged redacted database does not match the validated projection.');
    }

    const manifest=buildManifest({
      createdAt,
      database:{byteLength:dbBound.byteLength,sha256:dbBound.sha256,...publicDatabaseFacts(redacted)},
      exclusions,
      excludedTables:projected.excludedTables,
    });
    const manifestJson=serializeManifest(manifest);
    validateManifestSchema(JSON.parse(manifestJson));
    const manifestBytes=Buffer.from(manifestJson,'utf8');
    const manifestSha256=sha256Hex(manifestBytes);

    return {
      published:false,
      publication,
      manifest,
      manifestSha256,
      archiveBytes:{
        database:dbBound.bytes,
        manifest:manifestBytes,
        manifestSha256:Buffer.from(manifestSha256+'\n','utf8'),
      },
    };
  });
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
      fail('SECRET_LEAK_DETECTED','A forbidden secret file is present in the backup archive.');
    }
    if (entry.rel!=='manifest.json'&&entry.rel!=='manifest.sha256'&&entry.rel!=='database/workspace.sqlite') {
      fail('BACKUP_CORRUPTED','An unexpected file is present inside the redacted backup archive.');
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
  const recordedDigest=digestBound.bytes.toString('utf8');
  if (!/^[a-f0-9]{64}\n$/.test(recordedDigest)) fail('BACKUP_CORRUPTED','Backup manifest.sha256 is malformed.');
  if (!timingSafeEqual(Buffer.from(manifestBound.sha256,'hex'),Buffer.from(recordedDigest.slice(0,64),'hex'))) {
    fail('BACKUP_CORRUPTED','Backup manifest.sha256 does not match manifest.json.');
  }

  let manifest;
  try { manifest=JSON.parse(manifestBound.bytes.toString('utf8')); }
  catch { fail('MANIFEST_INVALID','Backup manifest.json is not valid JSON.'); }
  validateManifestSchema(manifest);

  const dbBound=await readBoundFile(dbEntry.full,dbEntry.lstatInfo,'database/workspace.sqlite',_testHooks.onBeforeOpenFile);
  if (dbBound.byteLength!==manifest.database.byteLength||
      !timingSafeEqual(Buffer.from(dbBound.sha256,'hex'),Buffer.from(manifest.database.sha256,'hex'))) {
    fail('BACKUP_CORRUPTED','Backup SQLite snapshot hash or byte length mismatch.');
  }
  validateSqliteHeaderBytes(dbBound.bytes,'database/workspace.sqlite',{requireDeleteJournal:true});

  const stagedVerifiedDbPath=await writePrivateVerifiedDbFile(stageRoot,'verified-input.sqlite',dbBound.bytes,manifest.database.sha256);
  const verifiedDb=readDatabaseFile(stagedVerifiedDbPath,{redacted:true});
  if (!sameDatabaseFacts(verifiedDb,manifest.database)) {
    fail('BACKUP_CORRUPTED','Backup SQLite contents do not match manifest database summary or table digests.');
  }

  // The manifest must be byte-identical to one regenerated locally from
  // validated values, so duplicate keys or reformatting cannot hide content.
  const regenerated=serializeManifest(buildManifest({
    createdAt:manifest.createdAt,
    database:{byteLength:dbBound.byteLength,sha256:dbBound.sha256,...publicDatabaseFacts(verifiedDb)},
    exclusions:manifest.exclusions,
    excludedTables:manifest.excludedTables,
  }));
  if (!manifestBound.bytes.equals(Buffer.from(regenerated,'utf8'))) {
    fail('MANIFEST_INVALID','Backup manifest is not in canonical locally generated form.');
  }

  return {
    manifest,
    manifestSha256:manifestBound.sha256,
    consistency:manifest.consistency,
    verifiedDb,
  };
}

export async function verifyWorkspaceBackup({backupDir,dbFilename='workspace.sqlite',_testHooks={}}={}) {
  return runInStage('cydeworks-verify-stage-',_testHooks,null,async stageRoot=>{
    const verified=await verifyWorkspaceBackupIntoStage({backupDir,dbFilename,stageRoot,_testHooks});
    return {
      ok:true,
      manifest:verified.manifest,
      manifestSha256:verified.manifestSha256,
      consistency:verified.consistency,
      database:publicDatabaseFacts(verified.verifiedDb),
    };
  });
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
    await assertEmptyDestination(restoreRoot,'DESTINATION_NOT_EMPTY','Restore destination must be an empty disposable directory.');
  } else if (publish!==false) {
    fail('INVALID_PATH','Invalid restoreDir path.');
  }

  const publication=disabledPublication(restoreRoot);
  if (publish!==false) {
    fail('ATOMIC_PUBLICATION_UNAVAILABLE',ATOMIC_PUBLICATION_LIMIT,null,{publication,cleanup:notStagedCleanup()});
  }

  return runInStage('cydeworks-restore-stage-',_testHooks,publication,async stageRoot=>{
    const verification=await verifyWorkspaceBackupIntoStage({backupDir:backupRoot,dbFilename,stageRoot,_testHooks});

    // Rebuild a fresh database from validated canonical rows instead of copying archive pages.
    const stagedRestoredDbPath=resolveContainedPath(stageRoot,dbFilename,'staged restored database');
    writeRedactedDatabase(stagedRestoredDbPath,verification.verifiedDb.rows);

    const restoredBound=await readBoundFile(stagedRestoredDbPath,null,'staged restored database');
    validateSqliteHeaderBytes(restoredBound.bytes,'staged restored database',{requireDeleteJournal:true});
    if (_testHooks.onRestoredDatabaseBytes) await _testHooks.onRestoredDatabaseBytes(Buffer.from(restoredBound.bytes));

    const restoredDb=readDatabaseFile(stagedRestoredDbPath,{redacted:true});
    if (!sameDatabaseFacts(restoredDb,verification.manifest.database)) {
      fail('BACKUP_CORRUPTED','Restored SQLite database does not match verified manifest summary or table digests.');
    }

    return {
      restored:false,
      verifiedInStaging:true,
      publication,
      manifestSha256:verification.manifestSha256,
      consistency:verification.consistency,
      database:publicDatabaseFacts(restoredDb),
      limits:[...verification.manifest.limits],
    };
  });
}
