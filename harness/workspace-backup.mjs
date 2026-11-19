import {createHash, timingSafeEqual} from 'node:crypto';
import {copyFile, lstat, mkdir, readdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {DatabaseSync, backup} from 'node:sqlite';
import {exportReceipt} from './receipt-export.mjs';

export const BACKUP_FORMAT='cydeworks-workspace-backup';
export const BACKUP_SCHEMA_VERSION=1;

const SHA256_HEX=/^[a-f0-9]{64}$/;
const TABLE_NAME=/^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL_CHARS=/[\x00-\x1f\x7f]/;
const WINDOWS_RESERVED=/^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;
const SECRET_BASENAME=/^(?:\.env(?:\..+)?|access\.key|bfe_session|auth\.json|credentials(?:\.[^.]+)?|secrets?(?:\.[^.]+)?|removal[_-]?secret(?:\.[^.]+)?|.*(?:secret|credential|password|passwd|auth[_-]?token).*)$/i;
const SECRET_EXTENSION=/\.(?:key|pem|p12|pfx|secret|token|kdbx)$/i;
const SECRET_DIR_SEGMENT=new Set(['secrets','credentials','.ssh','.gnupg','tokens']);
const PROTOTYPE_KEYS=new Set(['__proto__','constructor','prototype']);

export class BackupError extends Error {
  constructor(code,message,cause) {
    super(message,cause?{cause}:undefined);
    this.name='BackupError';
    this.code=code;
  }
}

const fail=(code,message,cause)=>{throw new BackupError(code,message,cause);};
const sha256Hex=bytes=>createHash('sha256').update(bytes).digest('hex');

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
  try { info=await lstat(targetPath); }
  catch (error) {
    if (error.code==='ENOENT') return null;
    throw error;
  }
  if (info.isSymbolicLink()) fail('SYMLINK_REJECTED',`Symbolic links are not allowed at ${label}.`);
  return info;
}

async function resolveComparablePath(targetPath,label) {
  const resolved=assertRootPath(targetPath,label);
  await statNoFollow(resolved,label);
  let cursor=resolved;
  const tail=[];
  while (true) {
    const info=await statNoFollow(cursor,label);
    if (info) {
      const canonicalBase=await realpath(cursor);
      const full=tail.length?resolve(canonicalBase,...tail.reverse()):canonicalBase;
      return process.platform==='win32'?full.toLowerCase():full;
    }
    const parent=dirname(cursor);
    if (parent===cursor) {
      return process.platform==='win32'?resolved.toLowerCase():resolved;
    }
    tail.push(relative(parent,cursor));
    cursor=parent;
  }
}

async function assertDistinctPaths(firstDir,secondDir,firstLabel,secondLabel) {
  const a=await resolveComparablePath(firstDir,firstLabel);
  const b=await resolveComparablePath(secondDir,secondLabel);
  const sep=process.platform==='win32'?'\\':'/';
  const prefixA=a.endsWith(sep)?a:a+sep;
  const prefixB=b.endsWith(sep)?b:b+sep;
  if (a===b||a.startsWith(prefixB)||b.startsWith(prefixA)) {
    fail('OVERLAPPING_PATHS',`${firstLabel} and ${secondLabel} must be separate non-overlapping directories.`);
  }
}

function inferStoreCategory(relPath) {
  if (relPath.startsWith('opencode/')) return 'opencode';
  if (relPath.startsWith('hermes/')) return 'hermes';
  if (relPath.startsWith('terminal-replay/')||relPath.startsWith('terminal/')) return 'terminal-replay';
  if (relPath.startsWith('artifacts/')) return 'derived-artifacts';
  return 'workspace-files';
}

export function classifyWorkspaceFile(relPath,dbFilename='workspace.sqlite') {
  assertSafeRelativePath(relPath,'workspace path');
  assertDbFilename(dbFilename);
  const parts=relPath.split('/');
  const base=parts.at(-1);
  if (relPath===dbFilename) {
    return {included:false,category:'sqlite-primary',reason:'Captured via consistent SQLite backup snapshot.'};
  }
  if (relPath===`${dbFilename}.owner.sqlite`||base.endsWith('.owner.sqlite')) {
    return {included:false,category:'runtime-lock',reason:'Workspace owner lock file is transient runtime state.'};
  }
  if (relPath===`${dbFilename}-wal`||relPath===`${dbFilename}-shm`||relPath===`${dbFilename}-journal`||
      /-(?:wal|shm|journal)$/i.test(base)) {
    return {included:false,category:'sqlite-journal',reason:'SQLite journal sidecars are folded into the snapshot.'};
  }
  if (parts.slice(0,-1).some(part=>SECRET_DIR_SEGMENT.has(part.toLowerCase()))||
      SECRET_BASENAME.test(base)||SECRET_EXTENSION.test(base)) {
    return {included:false,category:'credential-or-secret',reason:'Access keys, session secrets, and credentials are excluded.'};
  }
  if (relPath==='backups'||relPath.startsWith('backups/')) {
    return {included:false,category:'backup-archive',reason:'Existing backup archives are excluded.'};
  }
  return {included:true,store:inferStoreCategory(relPath)};
}

async function clearDirectoryContents(dir) {
  const names=await readdir(dir);
  await Promise.all(names.map(name=>rm(join(dir,name),{recursive:true,force:true})));
}

async function walkDirectory(rootDir,prefix='') {
  const entries=[];
  const dirents=await readdir(rootDir,{withFileTypes:true});
  dirents.sort((a,b)=>a.name.localeCompare(b.name));
  for (const dirent of dirents) {
    const rel=prefix?`${prefix}/${dirent.name}`:dirent.name;
    assertSafeRelativePath(rel,'directory entry');
    const full=resolveContainedPath(rootDir,dirent.name,'directory entry');
    const info=await statNoFollow(full,rel);
    if (!info) fail('INVALID_PATH',`Missing directory entry at ${rel}.`);
    if (info.isDirectory()) {
      entries.push(...await walkDirectory(full,rel));
    } else if (info.isFile()) {
      entries.push({rel,full,byteLength:info.size});
    } else {
      fail('INVALID_PATH',`Unsupported non-regular file at ${rel}.`);
    }
  }
  return entries;
}

function summarizeDatabase(db) {
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
  const tables={};
  for (const row of tableRows) {
    if (!TABLE_NAME.test(row.name)) fail('BACKUP_CORRUPTED',`Unsupported SQLite table name: ${row.name}.`);
    const countRow=db.prepare(`SELECT count(*) AS count FROM "${row.name}"`).get();
    tables[row.name]=countRow.count;
  }
  const summary={taskCount:0,taskIds:[],versions:{},eventSequences:{},acceptedArtifactHashes:{},receiptHashes:{}};
  if (Object.hasOwn(tables,'tasks')) {
    const taskRows=db.prepare('SELECT id, updated, data FROM tasks ORDER BY id').all();
    summary.taskCount=taskRows.length;
    for (const row of taskRows) {
      let parsed;
      try { parsed=JSON.parse(row.data); }
      catch (error) { fail('BACKUP_CORRUPTED',`Corrupt task JSON for ${row.id}.`,error); }
      if (!parsed||typeof parsed!=='object'||Array.isArray(parsed)||parsed.id!==row.id||!Number.isSafeInteger(parsed.version)) {
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
  return {integrity:'ok',tables,summary};
}

function inspectSnapshotFile(dbPath) {
  let db;
  try {
    db=new DatabaseSync(dbPath,{readOnly:true});
    return summarizeDatabase(db);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    fail('SQLITE_INTEGRITY_FAILED','Failed to open or verify SQLite database.',error);
  } finally {
    try { db?.close(); } catch {}
  }
}

async function hashFile(filePath) {
  const bytes=await readFile(filePath);
  return {byteLength:bytes.byteLength,sha256:sha256Hex(bytes)};
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
  const keys=Object.keys(value);
  for (const key of keys) {
    if (!allowedKeys.has(key)) fail('MANIFEST_INVALID',`${label} contains unexpected key: ${key}.`);
  }
  return value;
}

function validateManifestSchema(manifest,dbFilename) {
  assertNoUnsafeObjectKeys(manifest);
  assertPlainObject(manifest,new Set(['format','schemaVersion','createdAt','hashAlgorithm','database','artifacts','exclusions','limits']),'manifest');
  if (manifest.format!==BACKUP_FORMAT) fail('MANIFEST_INVALID','Unsupported backup manifest format.');
  if (manifest.schemaVersion!==BACKUP_SCHEMA_VERSION) fail('MANIFEST_INVALID','Unsupported backup schema version.');
  if (manifest.hashAlgorithm!=='sha256') fail('MANIFEST_INVALID','Unsupported hash algorithm.');
  if (typeof manifest.createdAt!=='string'||!Number.isFinite(Date.parse(manifest.createdAt))) {
    fail('MANIFEST_INVALID','Invalid manifest timestamp.');
  }
  const db=assertPlainObject(manifest.database,new Set(['path','byteLength','sha256','integrity','tables','summary']),'manifest.database');
  if (db.path!=='database/workspace.sqlite') fail('MANIFEST_INVALID','Invalid database snapshot path in manifest.');
  if (!Number.isSafeInteger(db.byteLength)||db.byteLength<=0) fail('MANIFEST_INVALID','Invalid database byteLength.');
  if (typeof db.sha256!=='string'||!SHA256_HEX.test(db.sha256)) fail('MANIFEST_INVALID','Invalid database sha256.');
  if (db.integrity!=='ok') fail('MANIFEST_INVALID','Database integrity flag is not ok.');
  if (!db.tables||typeof db.tables!=='object'||Array.isArray(db.tables)) fail('MANIFEST_INVALID','Invalid tables inventory.');
  assertPlainObject(db.summary,new Set(['taskCount','taskIds','versions','eventSequences','acceptedArtifactHashes','receiptHashes']),'manifest.database.summary');
  if (!Array.isArray(manifest.artifacts)||!Array.isArray(manifest.exclusions)||!Array.isArray(manifest.limits)) {
    fail('MANIFEST_INVALID','Manifest artifacts, exclusions, and limits must be arrays.');
  }
  const seenPaths=new Set();
  for (const item of manifest.artifacts) {
    assertPlainObject(item,new Set(['path','sourcePath','store','byteLength','sha256']),'artifact entry');
    assertSafeRelativePath(item.path,'artifact backup path');
    assertSafeRelativePath(item.sourcePath,'artifact source path');
    if (!item.path.startsWith('files/')||item.path!==`files/${item.sourcePath}`) {
      fail('MANIFEST_INVALID','Artifact backup path does not match sourcePath.');
    }
    const classification=classifyWorkspaceFile(item.sourcePath,dbFilename);
    if (!classification.included) {
      fail('SECRET_LEAK_DETECTED',`Excluded path cannot appear in backup artifacts: ${item.sourcePath}.`);
    }
    if (!Number.isSafeInteger(item.byteLength)||item.byteLength<0||typeof item.sha256!=='string'||!SHA256_HEX.test(item.sha256)) {
      fail('MANIFEST_INVALID','Invalid artifact digest metadata.');
    }
    if (seenPaths.has(item.path)) fail('MANIFEST_INVALID','Duplicate artifact path in manifest.');
    seenPaths.add(item.path);
  }
  for (const exc of manifest.exclusions) {
    assertPlainObject(exc,new Set(['path','category','reason']),'exclusion entry');
    assertSafeRelativePath(exc.path,'exclusion path');
    if (typeof exc.category!=='string'||typeof exc.reason!=='string') {
      fail('MANIFEST_INVALID','Invalid exclusion entry.');
    }
  }
}

export async function inventoryWorkspace(stateDir,{dbFilename='workspace.sqlite'}={}) {
  const root=assertRootPath(stateDir,'stateDir');
  assertDbFilename(dbFilename);
  const rootInfo=await statNoFollow(root,'stateDir');
  if (!rootInfo||!rootInfo.isDirectory()) fail('INVALID_PATH','Workspace state directory does not exist.');
  const dbPath=resolveContainedPath(root,dbFilename,'database path');
  const dbInfo=await statNoFollow(dbPath,'database file');
  if (!dbInfo||!dbInfo.isFile()) fail('MISSING_DATABASE','Workspace SQLite database does not exist.');

  const database=inspectSnapshotFile(dbPath);
  const files=await walkDirectory(root);
  const included=[];
  const exclusions=[];
  for (const entry of files) {
    const classification=classifyWorkspaceFile(entry.rel,dbFilename);
    if (classification.included) {
      const digest=await hashFile(entry.full);
      included.push({sourcePath:entry.rel,store:classification.store,byteLength:digest.byteLength,sha256:digest.sha256});
    } else {
      exclusions.push({path:entry.rel,category:classification.category,reason:classification.reason});
    }
  }
  return {stateDir:root,dbFilename,database,included,exclusions};
}

export async function createWorkspaceBackup({sourceDir,backupDir,dbFilename='workspace.sqlite',now=()=>new Date().toISOString()}={}) {
  const sourceRoot=assertRootPath(sourceDir,'sourceDir');
  const backupRoot=assertRootPath(backupDir,'backupDir');
  assertDbFilename(dbFilename);
  await assertDistinctPaths(sourceRoot,backupRoot,'sourceDir','backupDir');

  const sourceInfo=await statNoFollow(sourceRoot,'sourceDir');
  if (!sourceInfo||!sourceInfo.isDirectory()) fail('INVALID_PATH','Source workspace directory does not exist.');
  const sourceDbPath=resolveContainedPath(sourceRoot,dbFilename,'database path');
  const sourceDbInfo=await statNoFollow(sourceDbPath,'source database');
  if (!sourceDbInfo||!sourceDbInfo.isFile()) fail('MISSING_DATABASE','Source workspace SQLite database does not exist.');

  const backupInfo=await statNoFollow(backupRoot,'backupDir');
  let createdBackupRoot=false;
  if (backupInfo) {
    if (!backupInfo.isDirectory()) fail('INVALID_PATH','Backup destination must be a directory.');
    if ((await readdir(backupRoot)).length>0) {
      fail('DESTINATION_NOT_EMPTY','Backup destination directory must be empty.');
    }
  } else {
    createdBackupRoot=true;
  }

  const allEntries=await walkDirectory(sourceRoot);
  const included=[];
  const exclusions=[];
  for (const entry of allEntries) {
    const classification=classifyWorkspaceFile(entry.rel,dbFilename);
    if (classification.included) {
      included.push({sourcePath:entry.rel,full:entry.full,store:classification.store});
    } else {
      exclusions.push({path:entry.rel,category:classification.category,reason:classification.reason});
    }
  }

  await mkdir(join(backupRoot,'database'),{recursive:true});
  const backupDbPath=resolveContainedPath(backupRoot,'database/workspace.sqlite','backup database');
  const rollbackBackup=()=>createdBackupRoot?rm(backupRoot,{recursive:true,force:true}):clearDirectoryContents(backupRoot);

  try {
    let srcDb;
    try {
      srcDb=new DatabaseSync(sourceDbPath,{readOnly:true});
      await backup(srcDb,backupDbPath);
    } catch (error) {
      if (error instanceof BackupError) throw error;
      fail('SQLITE_INTEGRITY_FAILED','Failed to create consistent SQLite backup snapshot.',error);
    } finally {
      try { srcDb?.close(); } catch {}
    }

    let snapDb;
    try {
      snapDb=new DatabaseSync(backupDbPath);
      snapDb.exec('PRAGMA journal_mode=DELETE;');
    } catch (error) {
      fail('SQLITE_INTEGRITY_FAILED','Failed to finalize SQLite backup snapshot.',error);
    } finally {
      try { snapDb?.close(); } catch {}
    }

    const dbMeta=inspectSnapshotFile(backupDbPath);
    const dbDigest=await hashFile(backupDbPath);
    const artifacts=[];
    for (const item of included) {
      const targetRel=`files/${item.sourcePath}`;
      const targetPath=resolveContainedPath(backupRoot,targetRel,'backup artifact');
      await mkdir(dirname(targetPath),{recursive:true});
      await copyFile(item.full,targetPath);
      const digest=await hashFile(targetPath);
      artifacts.push({path:targetRel,sourcePath:item.sourcePath,store:item.store,byteLength:digest.byteLength,sha256:digest.sha256});
    }

    const manifest={
      format:BACKUP_FORMAT,
      schemaVersion:BACKUP_SCHEMA_VERSION,
      createdAt:now(),
      hashAlgorithm:'sha256',
      database:{
        path:'database/workspace.sqlite',
        byteLength:dbDigest.byteLength,
        sha256:dbDigest.sha256,
        integrity:dbMeta.integrity,
        tables:dbMeta.tables,
        summary:dbMeta.summary,
      },
      artifacts,
      exclusions,
      limits:[
        'Backup excludes access keys, session tokens, credentials, and transient lock/journal files.',
        'Restore must be verified in a separate disposable destination before replacing any workspace.',
      ],
    };
    const manifestJson=JSON.stringify(manifest,null,2)+'\n';
    const manifestSha256=sha256Hex(Buffer.from(manifestJson,'utf8'));
    await writeFile(resolveContainedPath(backupRoot,'manifest.json','manifest'),manifestJson,'utf8');
    await writeFile(resolveContainedPath(backupRoot,'manifest.sha256','manifest digest'),manifestSha256+'\n','utf8');
    return {backupDir:backupRoot,manifest,manifestSha256};
  } catch (error) {
    await rollbackBackup();
    throw error;
  }
}

export async function verifyWorkspaceBackup({backupDir,dbFilename='workspace.sqlite'}={}) {
  const backupRoot=assertRootPath(backupDir,'backupDir');
  assertDbFilename(dbFilename);
  const info=await statNoFollow(backupRoot,'backupDir');
  if (!info||!info.isDirectory()) fail('INVALID_PATH','Backup directory does not exist.');

  const entries=await walkDirectory(backupRoot);
  const actualFiles=new Map();
  for (const entry of entries) {
    const parts=entry.rel.split('/');
    const base=parts.at(-1);
    if (SECRET_BASENAME.test(base)||SECRET_EXTENSION.test(base)||
        parts.slice(0,-1).some(part=>SECRET_DIR_SEGMENT.has(part.toLowerCase()))) {
      fail('SECRET_LEAK_DETECTED',`Forbidden file present in backup archive: ${entry.rel}.`);
    }
    if (entry.rel!=='manifest.json'&&entry.rel!=='manifest.sha256'&&entry.rel!=='database/workspace.sqlite') {
      if (!entry.rel.startsWith('files/')) {
        fail('BACKUP_CORRUPTED',`Unexpected file inside backup archive: ${entry.rel}.`);
      }
      const sourceRel=entry.rel.slice('files/'.length);
      if (!classifyWorkspaceFile(sourceRel,dbFilename).included) {
        fail('SECRET_LEAK_DETECTED',`Forbidden or secret file present in backup archive: ${entry.rel}.`);
      }
    }
    actualFiles.set(entry.rel,entry);
  }

  const manifestEntry=actualFiles.get('manifest.json');
  const digestEntry=actualFiles.get('manifest.sha256');
  const dbEntry=actualFiles.get('database/workspace.sqlite');
  if (!manifestEntry||!digestEntry||!dbEntry) {
    fail('BACKUP_CORRUPTED','Backup archive is missing manifest.json, manifest.sha256, or database/workspace.sqlite.');
  }

  const manifestBytes=await readFile(manifestEntry.full);
  const recordedDigest=(await readFile(digestEntry.full,'utf8')).trim();
  if (!SHA256_HEX.test(recordedDigest)) fail('BACKUP_CORRUPTED','Backup manifest.sha256 is malformed.');
  const actualManifestDigest=sha256Hex(manifestBytes);
  if (!timingSafeEqual(Buffer.from(actualManifestDigest,'hex'),Buffer.from(recordedDigest,'hex'))) {
    fail('BACKUP_CORRUPTED','Backup manifest.sha256 does not match manifest.json.');
  }

  let manifest;
  try { manifest=JSON.parse(manifestBytes.toString('utf8')); }
  catch (error) { fail('MANIFEST_INVALID','Backup manifest.json is not valid JSON.',error); }
  validateManifestSchema(manifest,dbFilename);

  const expectedPaths=new Set(['manifest.json','manifest.sha256','database/workspace.sqlite']);
  for (const artifact of manifest.artifacts) expectedPaths.add(artifact.path);
  for (const actualPath of actualFiles.keys()) {
    if (!expectedPaths.has(actualPath)) {
      fail('BACKUP_CORRUPTED',`Unexpected file not listed in manifest: ${actualPath}.`);
    }
  }
  for (const expectedPath of expectedPaths) {
    if (!actualFiles.has(expectedPath)) {
      fail('BACKUP_CORRUPTED',`Missing file listed in manifest: ${expectedPath}.`);
    }
  }

  const dbHash=await hashFile(dbEntry.full);
  if (dbHash.byteLength!==manifest.database.byteLength||dbHash.sha256!==manifest.database.sha256) {
    fail('BACKUP_CORRUPTED','Backup SQLite snapshot hash or byte length mismatch.');
  }

  for (const artifact of manifest.artifacts) {
    const fileEntry=actualFiles.get(artifact.path);
    const fileHash=await hashFile(fileEntry.full);
    if (fileHash.byteLength!==artifact.byteLength||fileHash.sha256!==artifact.sha256) {
      fail('BACKUP_CORRUPTED',`Backup artifact checksum mismatch for ${artifact.path}.`);
    }
  }

  const verifiedDb=inspectSnapshotFile(dbEntry.full);
  if (JSON.stringify(verifiedDb.tables)!==JSON.stringify(manifest.database.tables)||
      JSON.stringify(verifiedDb.summary)!==JSON.stringify(manifest.database.summary)) {
    fail('BACKUP_CORRUPTED','Backup SQLite contents do not match manifest database summary.');
  }

  return {ok:true,manifest,manifestSha256:actualManifestDigest,database:verifiedDb};
}

export async function restoreWorkspaceBackup({backupDir,restoreDir,dbFilename='workspace.sqlite'}={}) {
  const backupRoot=assertRootPath(backupDir,'backupDir');
  const restoreRoot=assertRootPath(restoreDir,'restoreDir');
  assertDbFilename(dbFilename);
  await assertDistinctPaths(backupRoot,restoreRoot,'backupDir','restoreDir');

  const restoreInfo=await statNoFollow(restoreRoot,'restoreDir');
  let createdRestoreRoot=false;
  if (restoreInfo) {
    if (!restoreInfo.isDirectory()) fail('INVALID_PATH','Restore destination must be a directory.');
    if ((await readdir(restoreRoot)).length>0) {
      fail('DESTINATION_NOT_EMPTY','Restore destination must be an empty disposable directory.');
    }
  } else {
    createdRestoreRoot=true;
  }

  // Verify the entire backup archive before creating or modifying anything in restoreDir.
  const verification=await verifyWorkspaceBackup({backupDir:backupRoot,dbFilename});

  await mkdir(restoreRoot,{recursive:true});
  const backupDbPath=resolveContainedPath(backupRoot,'database/workspace.sqlite','backup database');
  const targetDbPath=resolveContainedPath(restoreRoot,dbFilename,'restored database');
  const rollbackRestore=()=>createdRestoreRoot?rm(restoreRoot,{recursive:true,force:true}):clearDirectoryContents(restoreRoot);

  try {
    let srcDb;
    try {
      srcDb=new DatabaseSync(backupDbPath,{readOnly:true});
      await backup(srcDb,targetDbPath);
    } catch (error) {
      if (error instanceof BackupError) throw error;
      fail('SQLITE_INTEGRITY_FAILED','Failed to restore SQLite database to disposable destination.',error);
    } finally {
      try { srcDb?.close(); } catch {}
    }

    const restoredFiles=[];
    for (const artifact of verification.manifest.artifacts) {
      const srcArtifact=resolveContainedPath(backupRoot,artifact.path,'backup artifact');
      const dstArtifact=resolveContainedPath(restoreRoot,artifact.sourcePath,'restored artifact');
      await mkdir(dirname(dstArtifact),{recursive:true});
      await copyFile(srcArtifact,dstArtifact);
      const written=await hashFile(dstArtifact);
      if (written.byteLength!==artifact.byteLength||written.sha256!==artifact.sha256) {
        fail('BACKUP_CORRUPTED',`Restored artifact checksum mismatch for ${artifact.sourcePath}.`);
      }
      restoredFiles.push(artifact.sourcePath);
    }

    const restoredDb=inspectSnapshotFile(targetDbPath);
    if (JSON.stringify(restoredDb.tables)!==JSON.stringify(verification.manifest.database.tables)||
        JSON.stringify(restoredDb.summary)!==JSON.stringify(verification.manifest.database.summary)) {
      fail('BACKUP_CORRUPTED','Restored SQLite database does not match verified manifest summary.');
    }

    return {
      restored:true,
      restoreDir:restoreRoot,
      databasePath:targetDbPath,
      manifestSha256:verification.manifestSha256,
      database:restoredDb,
      restoredFiles,
    };
  } catch (error) {
    await rollbackRestore();
    throw error;
  }
}
