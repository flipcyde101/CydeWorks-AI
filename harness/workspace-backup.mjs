import {createHash, timingSafeEqual} from 'node:crypto';
import {copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, rmdir, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {DatabaseSync, backup} from 'node:sqlite';
import {exportReceipt} from './receipt-export.mjs';

export const BACKUP_FORMAT='cydeworks-workspace-backup';
export const BACKUP_SCHEMA_VERSION=1;

const SHA256_HEX=/^[a-f0-9]{64}$/;
const TABLE_NAME=/^[A-Za-z_][A-Za-z0-9_]*$/;
const SUSPICIOUS_TABLE_NAME=/(?:secret|credential|password|passwd|token|session|access_key|auth)/i;
const CONTROL_CHARS=/[\x00-\x1f\x7f]/;
const WINDOWS_RESERVED=/^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;
const SECRET_BASENAME=/^(?:\.env(?:\..+)?|access\.key|bfe_session|auth\.json|credentials(?:\.[^.]+)?|secrets?(?:\.[^.]+)?|removal[_-]?secret(?:\.[^.]+)?|.*(?:secret|credential|password|passwd|auth[_-]?token).*)$/i;
const SECRET_EXTENSION=/\.(?:key|pem|p12|pfx|secret|token|kdbx)$/i;
const SECRET_DIR_SEGMENT=new Set(['secrets','credentials','.ssh','.gnupg','tokens']);
const PROTOTYPE_KEYS=new Set(['__proto__','constructor','prototype']);

export const BACKUP_LIMITS=Object.freeze([
  'SQLite snapshot is transactionally consistent within SQLite, but copied files under files/ are not bound to the database snapshot; cross-store consistency is unknown.',
  'Backup excludes separate key, credential, lock, and journal files, but retains all SQLite table rows and pages verbatim (including task source, requests, proposals, and terminal history), which may contain secrets.',
  'SHA-256 checksums detect corruption and post-backup edits against manifest.sha256, but the archive is unsigned and cannot prove origin authenticity.',
  'Restore must be verified in a separate disposable destination before replacing any workspace.',
]);

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
    return {included:false,category:'sqlite-primary',reason:'Captured via SQLite online backup API; not raw-copied.'};
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
    return {included:false,category:'credential-or-secret',reason:'Separate access keys, session secrets, and credential files are excluded.'};
  }
  if (relPath==='backups'||relPath.startsWith('backups/')) {
    return {included:false,category:'backup-archive',reason:'Existing backup archives are excluded.'};
  }
  return {included:true,store:inferStoreCategory(relPath)};
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

function buildConsistencyReport(exclusions,tables) {
  const activeLockOrWalObserved=exclusions.some(
    item=>item.category==='runtime-lock'||item.category==='sqlite-journal',
  );
  const suspiciousSecretTables=Object.keys(tables).filter(name=>SUSPICIOUS_TABLE_NAME.test(name));
  return {
    sqliteSnapshot:'online-backup-consistent',
    copiedFilesBinding:'unverified-best-effort-copy',
    crossStoreConsistency:'unknown',
    activeLockOrWalObserved,
    archiveAuthenticity:'unsigned-sha256-checksums',
    databaseContentSecrets:'unknown-full-db-retained',
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

function validateManifestSchema(manifest,dbFilename) {
  assertNoUnsafeObjectKeys(manifest);
  assertPlainObject(
    manifest,
    new Set(['format','schemaVersion','createdAt','hashAlgorithm','consistency','database','artifacts','exclusions','limits']),
    'manifest',
  );
  if (manifest.format!==BACKUP_FORMAT) fail('MANIFEST_INVALID','Unsupported backup manifest format.');
  if (manifest.schemaVersion!==BACKUP_SCHEMA_VERSION) fail('MANIFEST_INVALID','Unsupported backup schema version.');
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
  if (consistency.sqliteSnapshot!=='online-backup-consistent'||
      consistency.copiedFilesBinding!=='unverified-best-effort-copy'||
      consistency.crossStoreConsistency!=='unknown'||
      typeof consistency.activeLockOrWalObserved!=='boolean'||
      consistency.archiveAuthenticity!=='unsigned-sha256-checksums'||
      consistency.databaseContentSecrets!=='unknown-full-db-retained'||
      !Array.isArray(consistency.suspiciousSecretTables)||
      consistency.suspiciousSecretTables.some(name=>typeof name!=='string'||!TABLE_NAME.test(name))||
      consistency.sqlitePagesMayRetainDeletedData!==true) {
    fail('MANIFEST_INVALID','Invalid or overstated consistency metadata in manifest.');
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

async function publishStagedToDestination({
  stageRoot,
  targetRoot,
  targetLabel,
  relativeFiles,
  targetPreexisted,
  onBeforePublish,
  onAfterFileWrite,
}) {
  if (onBeforePublish) await onBeforePublish(targetRoot);

  const createdFiles=[];
  const createdDirs=[];
  const createdDirSet=new Set();

  // Only remove exact files opened exclusively ('wx') and empty directories created by this operation.
  // Never clear or recursively delete a caller-supplied destination.
  const rollbackCreated=async()=>{
    for (let i=createdFiles.length-1;i>=0;i--) {
      try { await unlink(createdFiles[i]); } catch {}
    }
    for (let i=createdDirs.length-1;i>=0;i--) {
      try { await rmdir(createdDirs[i]); } catch {}
    }
  };

  try {
    const currentInfo=await statNoFollow(targetRoot,targetLabel);
    if (!targetPreexisted) {
      if (currentInfo) {
        fail('DESTINATION_NOT_EMPTY',`${targetLabel} was created concurrently before publish.`);
      }
      await mkdir(dirname(targetRoot),{recursive:true});
      try {
        await mkdir(targetRoot);
      } catch (error) {
        if (error.code==='EEXIST') {
          fail('DESTINATION_NOT_EMPTY',`${targetLabel} was created concurrently before publish.`);
        }
        throw error;
      }
      createdDirs.push(targetRoot);
      createdDirSet.add(targetRoot);
    } else {
      if (!currentInfo||!currentInfo.isDirectory()) {
        fail('INVALID_PATH',`${targetLabel} is no longer a valid directory.`);
      }
      if ((await readdir(targetRoot)).length>0) {
        fail('DESTINATION_NOT_EMPTY',`${targetLabel} contains existing or concurrently added entries.`);
      }
    }

    for (const rel of relativeFiles) {
      const parts=rel.split('/');
      let cur=targetRoot;
      for (let i=0;i<parts.length-1;i++) {
        cur=join(cur,parts[i]);
        if (!createdDirSet.has(cur)) {
          try {
            await mkdir(cur);
          } catch (error) {
            if (error.code==='EEXIST') {
              fail('CONCURRENT_MODIFICATION',`Concurrent entry appeared at ${parts.slice(0,i+1).join('/')} in ${targetLabel}.`);
            }
            throw error;
          }
          createdDirs.push(cur);
          createdDirSet.add(cur);
        }
      }
    }

    for (let i=0;i<relativeFiles.length;i++) {
      const rel=relativeFiles[i];
      const srcPath=resolveContainedPath(stageRoot,rel,'staged file');
      const dstPath=resolveContainedPath(targetRoot,rel,'destination file');
      const bytes=await readFile(srcPath);
      let handle;
      try {
        handle=await open(dstPath,'wx');
        createdFiles.push(dstPath);
        await handle.writeFile(bytes);
      } catch (error) {
        if (error.code==='EEXIST') {
          fail('CONCURRENT_MODIFICATION',`Concurrent file appeared at ${rel} in ${targetLabel}.`);
        }
        throw error;
      } finally {
        try { await handle?.close(); } catch {}
      }
      if (onAfterFileWrite) await onAfterFileWrite(rel,i,targetRoot);
    }

    const publishedEntries=await walkDirectory(targetRoot);
    const expectedSet=new Set(relativeFiles);
    if (publishedEntries.length!==expectedSet.size||publishedEntries.some(entry=>!expectedSet.has(entry.rel))) {
      fail('CONCURRENT_MODIFICATION',`${targetLabel} was modified concurrently during publish.`);
    }
  } catch (error) {
    await rollbackCreated();
    throw error;
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
  const consistency=buildConsistencyReport(exclusions,database.tables);
  return {stateDir:root,dbFilename,consistency,database,included,exclusions,limits:[...BACKUP_LIMITS]};
}

export async function createWorkspaceBackup({
  sourceDir,
  backupDir,
  dbFilename='workspace.sqlite',
  now=()=>new Date().toISOString(),
  _testHooks={},
}={}) {
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
  let targetPreexisted=false;
  if (backupInfo) {
    if (!backupInfo.isDirectory()) fail('INVALID_PATH','Backup destination must be a directory.');
    if ((await readdir(backupRoot)).length>0) {
      fail('DESTINATION_NOT_EMPTY','Backup destination directory must be empty.');
    }
    targetPreexisted=true;
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

  const stageRoot=await mkdtemp(join(tmpdir(),'cydeworks-backup-stage-'));
  try {
    await mkdir(join(stageRoot,'database'),{recursive:true});
    const stagedDbPath=resolveContainedPath(stageRoot,'database/workspace.sqlite','staged database');

    let srcDb;
    try {
      srcDb=new DatabaseSync(sourceDbPath,{readOnly:true});
      await backup(srcDb,stagedDbPath);
    } catch (error) {
      if (error instanceof BackupError) throw error;
      fail('SQLITE_INTEGRITY_FAILED','Failed to create consistent SQLite backup snapshot.',error);
    } finally {
      try { srcDb?.close(); } catch {}
    }

    let snapDb;
    try {
      snapDb=new DatabaseSync(stagedDbPath);
      snapDb.exec('PRAGMA journal_mode=DELETE;');
    } catch (error) {
      fail('SQLITE_INTEGRITY_FAILED','Failed to finalize SQLite backup snapshot.',error);
    } finally {
      try { snapDb?.close(); } catch {}
    }

    const dbMeta=inspectSnapshotFile(stagedDbPath);
    const dbDigest=await hashFile(stagedDbPath);
    const artifacts=[];
    const relativeFiles=['database/workspace.sqlite'];
    for (const item of included) {
      const targetRel=`files/${item.sourcePath}`;
      const targetPath=resolveContainedPath(stageRoot,targetRel,'staged artifact');
      await mkdir(dirname(targetPath),{recursive:true});
      await copyFile(item.full,targetPath);
      const digest=await hashFile(targetPath);
      artifacts.push({path:targetRel,sourcePath:item.sourcePath,store:item.store,byteLength:digest.byteLength,sha256:digest.sha256});
      relativeFiles.push(targetRel);
    }

    const consistency=buildConsistencyReport(exclusions,dbMeta.tables);
    const manifest={
      format:BACKUP_FORMAT,
      schemaVersion:BACKUP_SCHEMA_VERSION,
      createdAt:now(),
      hashAlgorithm:'sha256',
      consistency,
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
      limits:[...BACKUP_LIMITS],
    };
    const manifestJson=JSON.stringify(manifest,null,2)+'\n';
    const manifestSha256=sha256Hex(Buffer.from(manifestJson,'utf8'));
    await writeFile(resolveContainedPath(stageRoot,'manifest.json','manifest'),manifestJson,'utf8');
    await writeFile(resolveContainedPath(stageRoot,'manifest.sha256','manifest digest'),manifestSha256+'\n','utf8');
    relativeFiles.push('manifest.json','manifest.sha256');
    relativeFiles.sort();

    await publishStagedToDestination({
      stageRoot,
      targetRoot:backupRoot,
      targetLabel:'backupDir',
      relativeFiles,
      targetPreexisted,
      onBeforePublish:_testHooks.onBeforePublish,
      onAfterFileWrite:_testHooks.onAfterFileWrite,
    });

    return {backupDir:backupRoot,manifest,manifestSha256};
  } finally {
    await rm(stageRoot,{recursive:true,force:true});
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

  return {
    ok:true,
    manifest,
    manifestSha256:actualManifestDigest,
    consistency:manifest.consistency,
    database:verifiedDb,
  };
}

export async function restoreWorkspaceBackup({
  backupDir,
  restoreDir,
  dbFilename='workspace.sqlite',
  _testHooks={},
}={}) {
  const backupRoot=assertRootPath(backupDir,'backupDir');
  const restoreRoot=assertRootPath(restoreDir,'restoreDir');
  assertDbFilename(dbFilename);
  await assertDistinctPaths(backupRoot,restoreRoot,'backupDir','restoreDir');

  const restoreInfo=await statNoFollow(restoreRoot,'restoreDir');
  let targetPreexisted=false;
  if (restoreInfo) {
    if (!restoreInfo.isDirectory()) fail('INVALID_PATH','Restore destination must be a directory.');
    if ((await readdir(restoreRoot)).length>0) {
      fail('DESTINATION_NOT_EMPTY','Restore destination must be an empty disposable directory.');
    }
    targetPreexisted=true;
  }

  // Verify the entire backup archive before staging or touching restoreDir.
  const verification=await verifyWorkspaceBackup({backupDir:backupRoot,dbFilename});

  const stageRoot=await mkdtemp(join(tmpdir(),'cydeworks-restore-stage-'));
  try {
    const backupDbPath=resolveContainedPath(backupRoot,'database/workspace.sqlite','backup database');
    const stagedDbPath=resolveContainedPath(stageRoot,dbFilename,'staged restored database');

    let srcDb;
    try {
      srcDb=new DatabaseSync(backupDbPath,{readOnly:true});
      await backup(srcDb,stagedDbPath);
    } catch (error) {
      if (error instanceof BackupError) throw error;
      fail('SQLITE_INTEGRITY_FAILED','Failed to restore SQLite database in staging.',error);
    } finally {
      try { srcDb?.close(); } catch {}
    }

    const relativeFiles=[dbFilename];
    const restoredFiles=[];
    for (const artifact of verification.manifest.artifacts) {
      const srcArtifact=resolveContainedPath(backupRoot,artifact.path,'backup artifact');
      const dstArtifact=resolveContainedPath(stageRoot,artifact.sourcePath,'staged artifact');
      await mkdir(dirname(dstArtifact),{recursive:true});
      await copyFile(srcArtifact,dstArtifact);
      const written=await hashFile(dstArtifact);
      if (written.byteLength!==artifact.byteLength||written.sha256!==artifact.sha256) {
        fail('BACKUP_CORRUPTED',`Restored artifact checksum mismatch for ${artifact.sourcePath}.`);
      }
      relativeFiles.push(artifact.sourcePath);
      restoredFiles.push(artifact.sourcePath);
    }

    const restoredDb=inspectSnapshotFile(stagedDbPath);
    if (JSON.stringify(restoredDb.tables)!==JSON.stringify(verification.manifest.database.tables)||
        JSON.stringify(restoredDb.summary)!==JSON.stringify(verification.manifest.database.summary)) {
      fail('BACKUP_CORRUPTED','Restored SQLite database does not match verified manifest summary.');
    }

    relativeFiles.sort();
    await publishStagedToDestination({
      stageRoot,
      targetRoot:restoreRoot,
      targetLabel:'restoreDir',
      relativeFiles,
      targetPreexisted,
      onBeforePublish:_testHooks.onBeforePublish,
      onAfterFileWrite:_testHooks.onAfterFileWrite,
    });

    return {
      restored:true,
      restoreDir:restoreRoot,
      databasePath:resolveContainedPath(restoreRoot,dbFilename,'restored database'),
      manifestSha256:verification.manifestSha256,
      consistency:verification.consistency,
      database:restoredDb,
      restoredFiles,
      limits:[...verification.manifest.limits],
    };
  } finally {
    await rm(stageRoot,{recursive:true,force:true});
  }
}
