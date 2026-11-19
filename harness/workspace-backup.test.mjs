import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {
  BACKUP_FORMAT,
  BACKUP_MODE,
  BACKUP_SCHEMA_VERSION,
  BackupError,
  assertSafeRelativePath,
  classifyWorkspaceFile,
  createWorkspaceBackup,
  inventoryWorkspace,
  restoreWorkspaceBackup,
  verifyWorkspaceBackup,
} from './workspace-backup.mjs';

const sha256=value=>createHash('sha256').update(value).digest('hex');

async function makeTempDir(t,prefix) {
  const dir=await mkdtemp(join(tmpdir(),prefix));
  t.after(async()=>{await rm(dir,{recursive:true,force:true});});
  return dir;
}

async function writeSyntheticBackup(backupDir,archiveBytes) {
  await mkdir(join(backupDir,'database'),{recursive:true});
  await writeFile(join(backupDir,'database','workspace.sqlite'),archiveBytes.database);
  await writeFile(join(backupDir,'manifest.json'),archiveBytes.manifest);
  await writeFile(join(backupDir,'manifest.sha256'),archiveBytes.manifestSha256);
}

function buildSampleTasks(sentinels={}) {
  const source=sentinels.taskSource??'line one\nline two\n';
  const sourceHash=sha256(source);
  const artifactContent=sentinels.artifactContent??'Revised output\n';
  const artifactHash=sha256(artifactContent);
  const scopeHash=sha256(JSON.stringify([sourceHash,'Update file','Revised','change','fixture','fixture','fixture',null]));
  const acceptedTask={
    id:'11111111-1111-4111-8111-111111111111',
    version:sentinels.acceptedVersion??3,
    status:'accepted',
    kind:'change',
    title:sentinels.taskTitle??'Synthetic change',
    request:sentinels.taskRequest??'Update file',
    source,
    filename:'example.txt',
    expected:sentinels.taskExpected??'Revised',
    sourceHash,
    model:sentinels.taskModel??'fixture-model',
    attempts:[{
      id:'22222222-2222-4222-8222-222222222222',
      model:sentinels.attemptModel??'fixture-model',
      provider:'fixture',
      backend:'fixture',
      started:'2026-11-18T10:00:00.000Z',
      ended:'2026-11-18T10:00:01.000Z',
      elapsedMs:1000,
      status:'accepted',
      scopeHash,
      execution:{phase:'settled',claimId:'22222222-2222-4222-8222-222222222222'},
      usage:{evidence:'synthetic',input:10,output:5},
      artifact:{
        summary:sentinels.artifactSummary??'Updated',
        content:artifactContent,
        sha256:artifactHash,
        patch:sentinels.artifactPatch??'@@ -1 +1 @@',
        rawContent:sentinels.artifactRawContent??'raw-candidate',
      },
      checks:[{name:sentinels.checkName??'Contains expected',pass:true}],
      ...(sentinels.extraAttemptFields??{}),
    }],
    events:sentinels.acceptedEvents??[
      {seq:1,at:'2026-11-18T10:00:00.000Z',event:'task.created'},
      {seq:2,at:'2026-11-18T10:00:00.500Z',event:'attempt.approved_and_started'},
      {seq:3,at:'2026-11-18T10:00:01.000Z',event:'review.accepted'},
    ],
  };
  const draftTask={
    id:'33333333-3333-4333-8333-333333333333',
    version:1,
    status:'draft',
    kind:'brief',
    title:'Draft brief',
    request:'Summarize notes',
    source:'Note line one',
    filename:null,
    expected:null,
    sourceHash:sha256('Note line one'),
    model:null,
    attempts:[],
    events:[{seq:1,at:'2026-11-18T10:05:00.000Z',event:'task.created'}],
  };
  return {acceptedTask,draftTask,artifactHash};
}

async function seedDisposableWorkspace(sourceDir,sentinels={}) {
  const {acceptedTask,draftTask,artifactHash}=buildSampleTasks(sentinels);
  const dbPath=join(sourceDir,'workspace.sqlite');
  const db=new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE tasks (id TEXT PRIMARY KEY, updated TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE task_removal_audit (id INTEGER PRIMARY KEY, reference TEXT NOT NULL, removed_at TEXT NOT NULL, scope TEXT NOT NULL);
    CREATE TABLE task_draft_copies (request_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_version INTEGER NOT NULL, draft_id TEXT NOT NULL);
    CREATE TABLE oauth_tokens (id TEXT PRIMARY KEY, token TEXT NOT NULL);`);

  const insertTask=db.prepare('INSERT INTO tasks VALUES (?, ?, ?)');
  insertTask.run(acceptedTask.id,'2026-11-18T10:00:01.000Z',JSON.stringify(acceptedTask));
  insertTask.run(draftTask.id,'2026-11-18T10:05:00.000Z',JSON.stringify(draftTask));

  if (sentinels.deletedFreelistSecret) {
    const deletedId='99999999-9999-4999-8999-999999999999';
    insertTask.run(deletedId,'2026-11-18T10:06:00.000Z',JSON.stringify({
      ...draftTask,
      id:deletedId,
      source:sentinels.deletedFreelistSecret,
      sourceHash:sha256(sentinels.deletedFreelistSecret),
    }));
    db.prepare('DELETE FROM tasks WHERE id = ?').run(deletedId);
  }

  for (const [id,updated,data] of sentinels.rawTaskRows??[]) insertTask.run(id,updated,data);

  db.prepare('INSERT INTO task_removal_audit (reference, removed_at, scope) VALUES (?, ?, ?)')
    .run(sha256('removed-task-ref'),'2026-11-18T09:00:00.000Z',sentinels.auditScope??'workspace-record-only-v1');
  db.prepare('INSERT INTO task_draft_copies VALUES (?, ?, ?, ?)')
    .run('55555555-5555-4555-8555-555555555555',acceptedTask.id,3,'66666666-6666-4666-8666-666666666666');
  db.prepare('INSERT INTO oauth_tokens VALUES (?, ?)')
    .run('provider-token-1',sentinels.tableSecret??'OAUTH_TABLE_SECRET_SENTINEL');
  if (sentinels.extraSql) db.exec(sentinels.extraSql);

  await mkdir(join(sourceDir,'artifacts'),{recursive:true});
  await mkdir(join(sourceDir,'opencode'),{recursive:true});
  await mkdir(join(sourceDir,'hermes'),{recursive:true});
  await mkdir(join(sourceDir,'terminal-replay'),{recursive:true});
  await mkdir(join(sourceDir,'secrets'),{recursive:true});
  await mkdir(join(sourceDir,'backups'),{recursive:true});

  await writeFile(join(sourceDir,'artifacts','proposal.txt'),sentinels.ordinaryArtifact??'Revised output\n','utf8');
  await writeFile(join(sourceDir,'opencode','session-meta.json'),sentinels.opencodeArtifact??'{"session":"ok"}\n','utf8');
  await writeFile(join(sourceDir,'hermes','context.md'),sentinels.hermesArtifact??'# Approved note\n','utf8');
  await writeFile(join(sourceDir,'terminal-replay','events.jsonl'),sentinels.replayArtifact??'{"seq":1,"type":"done"}\n','utf8');
  await writeFile(join(sourceDir,'notes.txt'),sentinels.notesArtifact??'ordinary workspace note\n','utf8');
  if (sentinels.fileName) await writeFile(join(sourceDir,`${sentinels.fileName}.txt`),'named note\n','utf8');

  const fileSecret=sentinels.fileSecret??'FILE_SECRET_SENTINEL_DO_NOT_BACKUP';
  await writeFile(join(sourceDir,'access.key'),fileSecret,'utf8');
  await writeFile(join(sourceDir,'.env'),`API_KEY=${fileSecret}\n`,'utf8');
  await writeFile(join(sourceDir,'.env.local'),fileSecret,'utf8');
  await writeFile(join(sourceDir,'credentials.json'),JSON.stringify({token:fileSecret}),'utf8');
  await writeFile(join(sourceDir,'opencode','auth.json'),JSON.stringify({key:fileSecret}),'utf8');
  await writeFile(join(sourceDir,'secrets','session.token'),fileSecret,'utf8');
  await writeFile(join(sourceDir,'workspace.sqlite.owner.sqlite'),'lock','utf8');
  await writeFile(join(sourceDir,'backups','previous.json'),'{"old":true}\n','utf8');

  return {db,acceptedTask,draftTask,artifactHash};
}

test('inventory uses single read transaction, enforces supported schema, and separates inventory status',async t=>{
  const root=await makeTempDir(t,'bfe-bak-inv-');
  const sourceDir=join(root,'source');
  await mkdir(sourceDir,{recursive:true});

  const {db}=await seedDisposableWorkspace(sourceDir);
  t.after(()=>{try {db.close();} catch {}});

  const opened=[];
  const inventory=await inventoryWorkspace(sourceDir,{_testHooks:{async onBeforeOpenFile(_path,label) {opened.push(label);}}});
  assert.deepEqual(opened,[],'inventory must not open or read workspace files');
  assert.equal(inventory.database.integrity,'ok');
  assert.equal(inventory.consistency.sqliteSnapshot,'single-read-transaction-on-source');
  assert.equal(inventory.consistency.filesystemBinding,'unverified-sequential-traversal-metadata-only');
  assert.equal(inventory.consistency.crossStoreConsistency,'unknown');
  assert.equal(inventory.consistency.databaseContentSecrets,'unknown-source-database-unredacted');
  assert.equal(inventory.consistency.activeLockOrWalObserved,true);
  assert.deepEqual(inventory.consistency.suspiciousSecretTables,['oauth_tokens']);
  assert.deepEqual(inventory.included,[]);
  assert.deepEqual(inventory.database.tables,{
    oauth_tokens:1,
    task_draft_copies:1,
    task_removal_audit:1,
    tasks:2,
  });

  const categoriesByPath=new Map(inventory.exclusions.map(item=>[item.path,item.category]));
  assert.equal(categoriesByPath.get('access.key'),'credential-or-secret');
  assert.equal(categoriesByPath.get('.env'),'credential-or-secret');
  assert.equal(categoriesByPath.get('credentials.json'),'credential-or-secret');
  assert.equal(categoriesByPath.get('opencode/auth.json'),'credential-or-secret');
  assert.equal(categoriesByPath.get('secrets/session.token'),'credential-or-secret');
  assert.equal(categoriesByPath.get('workspace.sqlite.owner.sqlite'),'runtime-lock');
  assert.equal(categoriesByPath.get('backups/previous.json'),'backup-archive');
  assert.equal(categoriesByPath.get('artifacts/proposal.txt'),'unverified-arbitrary-file');
  assert.equal(categoriesByPath.get('notes.txt'),'unverified-arbitrary-file');
  const keyEntry=inventory.exclusions.find(item=>item.path==='access.key');
  assert.equal(keyEntry.byteLength,(await stat(join(sourceDir,'access.key'))).size);
});

test('redacted backup excludes credential sentinels in files, DB rows, unknown tables, and deleted pages; raw mode disabled',async t=>{
  const root=await makeTempDir(t,'bfe-bak-redact-');
  const sourceDir=join(root,'source');
  const syntheticBackupDir=join(root,'synthetic-backup');
  await mkdir(sourceDir,{recursive:true});

  const sentinels={
    fileSecret:'SENTINEL_KEY_FILE_9901',
    ordinaryArtifact:'SENTINEL_ORDINARY_ARTIFACT_9902',
    opencodeArtifact:'SENTINEL_OPENCODE_ARTIFACT_9903',
    hermesArtifact:'SENTINEL_HERMES_ARTIFACT_9904',
    replayArtifact:'SENTINEL_REPLAY_ARTIFACT_9905',
    notesArtifact:'SENTINEL_NOTES_ARTIFACT_9906',
    taskSource:'SENTINEL_TASK_SOURCE_9907',
    taskRequest:'SENTINEL_TASK_REQUEST_9908',
    taskExpected:'SENTINEL_TASK_EXPECTED_9909',
    taskTitle:'SENTINEL_TASK_TITLE_9910',
    taskModel:'SENTINEL_TASK_MODEL_9911',
    attemptModel:'SENTINEL_ATTEMPT_MODEL_9912',
    artifactContent:'SENTINEL_ARTIFACT_CONTENT_9913',
    artifactSummary:'SENTINEL_ARTIFACT_SUMMARY_9914',
    artifactPatch:'SENTINEL_ARTIFACT_PATCH_9915',
    artifactRawContent:'SENTINEL_ARTIFACT_RAW_9916',
    checkName:'SENTINEL_CHECK_NAME_9917',
    tableSecret:'SENTINEL_OAUTH_TABLE_9918',
    deletedFreelistSecret:'SENTINEL_DELETED_FREELIST_9919',
    fileName:'SENTINEL_FILE_NAME_9920',
    extraAttemptFields:{
      operatorEdits:[{previousHash:sha256('a'),artifactHash:sha256('b'),at:'2026-11-18T10:00:00.700Z',note:'SENTINEL_EDIT_9921'}],
      originalArtifact:{content:'SENTINEL_ORIGINAL_ARTIFACT_9922',sha256:sha256('x')},
      terminal:[{at:'2026-11-18T10:00:00.600Z',message:'SENTINEL_TERMINAL_9923'}],
      problem:'SENTINEL_PROBLEM_9924',
    },
  };

  const {db,acceptedTask,draftTask,artifactHash}=await seedDisposableWorkspace(sourceDir,sentinels);
  t.after(()=>{try {db.close();} catch {}});

  // Raw full-DB and arbitrary-file paths must fail closed.
  await assert.rejects(
    ()=>createWorkspaceBackup({sourceDir,publish:false,mode:'raw'}),
    error=>error instanceof BackupError&&error.code==='RAW_RECOVERY_DISABLED',
  );
  await assert.rejects(
    ()=>createWorkspaceBackup({sourceDir,publish:false,includeRawDatabase:true}),
    error=>error instanceof BackupError&&error.code==='RAW_RECOVERY_DISABLED',
  );
  await assert.rejects(
    ()=>createWorkspaceBackup({sourceDir,publish:false,includeArbitraryFiles:true}),
    error=>error instanceof BackupError&&error.code==='RAW_RECOVERY_DISABLED',
  );

  let stageEntries=null;
  const created=await createWorkspaceBackup({
    sourceDir,
    publish:false,
    now:()=>'2026-11-18T12:00:00.000Z',
    _testHooks:{async onCleanupStage(stageRoot) {stageEntries=await readdir(stageRoot);}},
  });
  db.close();
  assert.deepEqual(stageEntries,['redacted.sqlite'],'staging must hold only the fresh redacted database, never a raw snapshot');

  assert.equal(created.published,false);
  assert.equal(created.publication.status,'disabled');
  assert.equal(created.publication.atomicNoReplaceSupported,false);
  assert.equal(created.cleanup.ok,true);
  assert.deepEqual(created.cleanup.residualPaths,[]);

  assert.equal(created.manifest.format,BACKUP_FORMAT);
  assert.equal(created.manifest.schemaVersion,BACKUP_SCHEMA_VERSION);
  assert.equal(created.manifest.mode,BACKUP_MODE);
  assert.deepEqual(created.manifest.artifacts,[]);
  assert.deepEqual(created.manifest.excludedTables,[
    {
      name:'oauth_tokens',
      rowCount:1,
      reason:'Non-allowlisted SQLite table excluded from redacted metadata backup.',
    },
  ]);
  assert.equal(created.manifest.consistency.sqliteSnapshot,'single-read-transaction-then-redacted-rebuild');
  assert.equal(created.manifest.exclusions.some(item=>Object.hasOwn(item,'path')),false);
  assert.deepEqual(created.manifest.exclusions.map(item=>item.category),[
    'sqlite-primary','runtime-lock','sqlite-journal','credential-or-secret','backup-archive','unverified-arbitrary-file',
  ]);
  assert.equal(created.manifest.consistency.copiedFilesBinding,'none-arbitrary-files-excluded');
  assert.equal(created.manifest.consistency.crossStoreConsistency,'not-applicable-redacted-db-only');
  assert.equal(created.manifest.consistency.databaseContentSecrets,'redacted-allowlisted-metadata-only');
  assert.equal(created.manifest.consistency.sqlitePagesMayRetainDeletedData,false);

  // Verify every single sentinel is absent from the raw redacted SQLite bytes and manifest bytes.
  const nestedSentinels={
    operatorEditNote:'SENTINEL_EDIT_9921',
    originalArtifact:'SENTINEL_ORIGINAL_ARTIFACT_9922',
    terminalMessage:'SENTINEL_TERMINAL_9923',
    attemptProblem:'SENTINEL_PROBLEM_9924',
  };
  const stringSentinels=Object.entries(sentinels).filter(([,value])=>typeof value==='string');
  for (const [key,sentinel] of [...stringSentinels,...Object.entries(nestedSentinels)]) {
    assert.equal(created.archiveBytes.database.includes(sentinel),false,`Database bytes leaked ${key}`);
    assert.equal(created.archiveBytes.manifest.includes(sentinel),false,`Manifest bytes leaked ${key}`);
    assert.equal(created.archiveBytes.manifestSha256.includes(sentinel),false,`Digest bytes leaked ${key}`);
  }

  // Write synthetic archive and verify + stage-restore in disposable staging.
  await writeSyntheticBackup(syntheticBackupDir,created.archiveBytes);
  const verified=await verifyWorkspaceBackup({backupDir:syntheticBackupDir});
  assert.equal(verified.ok,true);
  assert.equal(verified.cleanup.ok,true);
  assert.equal(verified.manifestSha256,created.manifestSha256);

  const restored=await restoreWorkspaceBackup({backupDir:syntheticBackupDir,publish:false});
  assert.equal(restored.restored,false);
  assert.equal(restored.verifiedInStaging,true);
  assert.equal(restored.publication.status,'disabled');
  assert.equal(restored.cleanup.ok,true);
  assert.deepEqual(restored.database.tables,{
    task_draft_copies:1,
    task_removal_audit:1,
    tasks:2,
  });
  assert.deepEqual(restored.database.summary.acceptedArtifactHashes[acceptedTask.id],[artifactHash]);
  assert.deepEqual(restored.database.summary.versions,{
    [acceptedTask.id]:3,
    [draftTask.id]:1,
  });
});

test('caller-destination publication fails closed without mutation or unlink, and reports cleanup failures separately',async t=>{
  const root=await makeTempDir(t,'bfe-bak-pubdisabled-');
  const sourceDir=join(root,'source');
  const syntheticBackupDir=join(root,'synthetic-backup');
  await mkdir(sourceDir,{recursive:true});

  const {db}=await seedDisposableWorkspace(sourceDir);
  db.close();

  const staged=await createWorkspaceBackup({sourceDir,publish:false});
  await writeSyntheticBackup(syntheticBackupDir,staged.archiveBytes);

  // 1. Non-existent backupDir: fails closed before staging and never creates backupDir.
  const newBackupDir=join(root,'new-backup');
  const stagedCalls=[];
  const spyHooks={
    async onStaged(stageRoot) {stagedCalls.push(stageRoot);},
    async onCleanupStage(stageRoot) {stagedCalls.push(stageRoot);},
  };
  await assert.rejects(
    ()=>createWorkspaceBackup({sourceDir,backupDir:newBackupDir,_testHooks:spyHooks}),
    error=>error instanceof BackupError&&
      error.code==='ATOMIC_PUBLICATION_UNAVAILABLE'&&
      error.publication?.status==='disabled'&&
      error.publication?.destinationMutated===false&&
      error.cleanup?.ok===true&&
      error.cleanup?.staged===false,
  );
  assert.deepEqual(stagedCalls,[],'publication must be rejected before any staging');
  await assert.rejects(()=>stat(newBackupDir),{code:'ENOENT'});

  // 2. Pre-created non-empty destination with concurrent file: fails with DESTINATION_NOT_EMPTY and never unlinks.
  const occupiedDir=join(root,'occupied');
  await mkdir(occupiedDir,{recursive:true});
  await writeFile(join(occupiedDir,'other-writer.txt'),'preserve-me','utf8');
  await assert.rejects(
    ()=>createWorkspaceBackup({sourceDir,backupDir:occupiedDir}),
    error=>error instanceof BackupError&&error.code==='DESTINATION_NOT_EMPTY',
  );
  assert.equal(await readFile(join(occupiedDir,'other-writer.txt'),'utf8'),'preserve-me');

  // 3. Pre-created empty restoreDir: fails closed with ATOMIC_PUBLICATION_UNAVAILABLE and leaves it empty.
  const emptyRestoreDir=join(root,'empty-restore');
  await mkdir(emptyRestoreDir,{recursive:true});
  await assert.rejects(
    ()=>restoreWorkspaceBackup({backupDir:syntheticBackupDir,restoreDir:emptyRestoreDir,_testHooks:spyHooks}),
    error=>error instanceof BackupError&&
      error.code==='ATOMIC_PUBLICATION_UNAVAILABLE'&&
      error.publication?.destinationMutated===false&&
      error.cleanup?.ok===true&&
      error.cleanup?.staged===false,
  );
  assert.deepEqual(await readdir(emptyRestoreDir),[]);
  assert.deepEqual(stagedCalls,[],'restore publication must be rejected before any staging');

  // 4. Simulated staging cleanup failure on dry-run success does not throw or mask publication status.
  const dryRunCleanupFail=await createWorkspaceBackup({
    sourceDir,
    publish:false,
    _testHooks:{
      async onCleanupStage() {
        throw new Error('simulated EBUSY during stage cleanup');
      },
    },
  });
  assert.equal(dryRunCleanupFail.publication.status,'disabled');
  assert.equal(dryRunCleanupFail.cleanup.ok,false);
  assert.match(dryRunCleanupFail.cleanup.error,/simulated EBUSY/);
  assert.equal(dryRunCleanupFail.cleanup.residualPaths.length,1);
  t.after(async()=>{
    for (const residual of dryRunCleanupFail.cleanup.residualPaths) {
      await rm(residual,{recursive:true,force:true});
    }
  });

  // 5. Simulated staging cleanup failure during a post-staging verification failure does not mask the primary error.
  let leakedStageDir=null;
  const corruptBackup=join(root,'corrupt-backup');
  await cp(syntheticBackupDir,corruptBackup,{recursive:true});
  await writeFile(join(corruptBackup,'manifest.sha256'),'0'.repeat(64)+'\n','utf8');
  await assert.rejects(
    ()=>restoreWorkspaceBackup({
      backupDir:corruptBackup,
      publish:false,
      _testHooks:{
        async onCleanupStage(stageRoot) {
          leakedStageDir=stageRoot;
          throw new Error('simulated stage rm failure');
        },
      },
    }),
    error=>error instanceof BackupError&&
      error.code==='BACKUP_CORRUPTED'&&
      error.publication?.status==='disabled'&&
      error.cleanup?.ok===false&&
      error.cleanup?.residualPaths.length===1,
  );
  t.after(async()=>{
    if (leakedStageDir) await rm(leakedStageDir,{recursive:true,force:true});
  });
});

test('tampered archives, non-task row swaps, unsupported schemas, and handle identity mismatches are rejected',async t=>{
  const root=await makeTempDir(t,'bfe-bak-tamper-');
  const sourceDir=join(root,'source');
  const validBackup=join(root,'valid-backup');
  await mkdir(sourceDir,{recursive:true});

  const {db}=await seedDisposableWorkspace(sourceDir);
  db.close();
  const created=await createWorkspaceBackup({sourceDir,publish:false});
  await writeSyntheticBackup(validBackup,created.archiveBytes);

  let caseIndex=0;
  async function assertTamperRejected(label,expectedCode,mutateFn,hooks={}) {
    caseIndex++;
    const copyDir=join(root,`tampered-${caseIndex}`);
    await cp(validBackup,copyDir,{recursive:true});
    await mutateFn(copyDir);
    await assert.rejects(
      ()=>verifyWorkspaceBackup({backupDir:copyDir,_testHooks:hooks}),
      error=>error instanceof BackupError&&error.code===expectedCode,
      `verifyWorkspaceBackup should fail with ${expectedCode} for: ${label}`,
    );
    await assert.rejects(
      ()=>restoreWorkspaceBackup({backupDir:copyDir,publish:false,_testHooks:hooks}),
      error=>error instanceof BackupError&&error.code===expectedCode,
      `restoreWorkspaceBackup should fail with ${expectedCode} for: ${label}`,
    );
  }

  await assertTamperRejected('modified manifest without updating manifest.sha256','BACKUP_CORRUPTED',async dir=>{
    const m=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
    m.database.summary.taskCount=99;
    await writeFile(join(dir,'manifest.json'),JSON.stringify(m,null,2)+'\n','utf8');
  });

  await assertTamperRejected('corrupted sqlite bytes','BACKUP_CORRUPTED',async dir=>{
    await writeFile(join(dir,'database','workspace.sqlite'),'not-a-valid-sqlite-database','utf8');
  });

  await assertTamperRejected('tampered non-task row preserving counts and tasks summary','BACKUP_CORRUPTED',async dir=>{
    const bakDb=new DatabaseSync(join(dir,'database','workspace.sqlite'));
    try {
      bakDb.prepare('UPDATE task_removal_audit SET reference = ?').run(sha256('tampered-ref'));
    } finally {
      bakDb.close();
    }
  });

  await assertTamperRejected('WAL-mode SQLite archive re-signed','BACKUP_CORRUPTED',async dir=>{
    const dbFile=join(dir,'database','workspace.sqlite');
    const bakDb=new DatabaseSync(dbFile);
    try {
      bakDb.exec('PRAGMA journal_mode=WAL;');
    } finally {
      bakDb.close();
    }
    const bytes=await readFile(dbFile);
    const m=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
    m.database.byteLength=bytes.byteLength;
    m.database.sha256=sha256(bytes);
    const raw=JSON.stringify(m,null,2)+'\n';
    await writeFile(join(dir,'manifest.json'),raw,'utf8');
    await writeFile(join(dir,'manifest.sha256'),sha256(raw)+'\n','utf8');
  });

  await assertTamperRejected('missing required task_draft_copies table in re-signed archive','UNSUPPORTED_WORKSPACE_SCHEMA',async dir=>{
    const dbFile=join(dir,'database','workspace.sqlite');
    const bakDb=new DatabaseSync(dbFile);
    try {
      bakDb.exec('DROP TABLE task_draft_copies;');
    } finally {
      bakDb.close();
    }
    const bytes=await readFile(dbFile);
    const m=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
    m.database.byteLength=bytes.byteLength;
    m.database.sha256=sha256(bytes);
    const raw=JSON.stringify(m,null,2)+'\n';
    await writeFile(join(dir,'manifest.json'),raw,'utf8');
    await writeFile(join(dir,'manifest.sha256'),sha256(raw)+'\n','utf8');
  });

  await assertTamperRejected('unredacted source field injected into redacted SQLite DB','SECRET_LEAK_DETECTED',async dir=>{
    const dbFile=join(dir,'database','workspace.sqlite');
    const bakDb=new DatabaseSync(dbFile);
    try {
      const row=bakDb.prepare('SELECT id, data FROM tasks LIMIT 1').get();
      const parsed=JSON.parse(row.data);
      parsed.source='UNREDACTED_SECRET';
      bakDb.prepare('UPDATE tasks SET data = ? WHERE id = ?').run(JSON.stringify(parsed),row.id);
    } finally {
      bakDb.close();
    }
    const bytes=await readFile(dbFile);
    const m=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
    m.database.byteLength=bytes.byteLength;
    m.database.sha256=sha256(bytes);
    const raw=JSON.stringify(m,null,2)+'\n';
    await writeFile(join(dir,'manifest.json'),raw,'utf8');
    await writeFile(join(dir,'manifest.sha256'),sha256(raw)+'\n','utf8');
  });

  await assertTamperRejected('unexpected table in redacted SQLite DB','SECRET_LEAK_DETECTED',async dir=>{
    const dbFile=join(dir,'database','workspace.sqlite');
    const bakDb=new DatabaseSync(dbFile);
    try {
      bakDb.exec('CREATE TABLE oauth_tokens (id TEXT PRIMARY KEY);');
    } finally {
      bakDb.close();
    }
    const bytes=await readFile(dbFile);
    const m=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
    m.database.byteLength=bytes.byteLength;
    m.database.sha256=sha256(bytes);
    const raw=JSON.stringify(m,null,2)+'\n';
    await writeFile(join(dir,'manifest.json'),raw,'utf8');
    await writeFile(join(dir,'manifest.sha256'),sha256(raw)+'\n','utf8');
  });

  await assertTamperRejected('planted access.key in backup archive','SECRET_LEAK_DETECTED',async dir=>{
    await mkdir(join(dir,'files'),{recursive:true});
    await writeFile(join(dir,'files','access.key'),'leaked','utf8');
  });

  await assertTamperRejected('unexpected artifact entry in re-signed manifest','SECRET_LEAK_DETECTED',async dir=>{
    const m=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
    m.artifacts=[{path:'files/notes.txt',sourcePath:'notes.txt',byteLength:4,sha256:sha256('test')}];
    const raw=JSON.stringify(m,null,2)+'\n';
    await writeFile(join(dir,'manifest.json'),raw,'utf8');
    await writeFile(join(dir,'manifest.sha256'),sha256(raw)+'\n','utf8');
  });

  await assertTamperRejected('overstated consistency claim in re-signed manifest','MANIFEST_INVALID',async dir=>{
    const m=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
    m.consistency.crossStoreConsistency='verified';
    const raw=JSON.stringify(m,null,2)+'\n';
    await writeFile(join(dir,'manifest.json'),raw,'utf8');
    await writeFile(join(dir,'manifest.sha256'),sha256(raw)+'\n','utf8');
  });

  await assertTamperRejected('prototype pollution key in manifest','MANIFEST_INVALID',async dir=>{
    const raw=await readFile(join(dir,'manifest.json'),'utf8');
    const polluted=raw.replace('{','{\n  "__proto__": {"polluted": true},');
    await writeFile(join(dir,'manifest.json'),polluted,'utf8');
    await writeFile(join(dir,'manifest.sha256'),sha256(polluted)+'\n','utf8');
  });

  await assertTamperRejected(
    'file swapped between traversal and handle-bound open',
    'IDENTITY_MISMATCH',
    async()=>{},
    {
      async onBeforeOpenFile(filePath,label) {
        if (label==='database/workspace.sqlite') {
          await rm(filePath);
          await writeFile(filePath,'swapped-after-lstat','utf8');
        }
      },
    },
  );
});

test('strict path checks, unsupported source schema, overlapping paths, and symlink rejection',async t=>{
  for (const bad of ['','../secret','/abs','C:/temp','a\\b','sub/./x','NUL.txt','COM\u00b9.txt','sub/file ','sub/file.','a\0b']) {
    assert.throws(
      ()=>assertSafeRelativePath(bad),
      error=>error instanceof BackupError&&error.code==='INVALID_PATH',
      `Expected INVALID_PATH for ${JSON.stringify(bad)}`,
    );
  }

  assert.equal(classifyWorkspaceFile('.state/access.key').included,false);
  assert.equal(classifyWorkspaceFile('.state/access.key').category,'credential-or-secret');
  assert.equal(classifyWorkspaceFile('artifacts/proposal.txt').included,false);
  assert.equal(classifyWorkspaceFile('artifacts/proposal.txt').category,'unverified-arbitrary-file');

  const root=await makeTempDir(t,'bfe-bak-paths-');
  const sourceDir=join(root,'source');
  await mkdir(sourceDir,{recursive:true});

  // Missing database
  await assert.rejects(
    ()=>inventoryWorkspace(sourceDir),
    error=>error instanceof BackupError&&error.code==='MISSING_DATABASE',
  );

  // Unsupported source schema (missing task_removal_audit / task_draft_copies)
  const partialDb=new DatabaseSync(join(sourceDir,'workspace.sqlite'));
  partialDb.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, updated TEXT NOT NULL, data TEXT NOT NULL);');
  partialDb.close();
  await assert.rejects(
    ()=>inventoryWorkspace(sourceDir),
    error=>error instanceof BackupError&&error.code==='UNSUPPORTED_WORKSPACE_SCHEMA',
  );
  await assert.rejects(
    ()=>createWorkspaceBackup({sourceDir,publish:false}),
    error=>error instanceof BackupError&&error.code==='UNSUPPORTED_WORKSPACE_SCHEMA',
  );

  // Overlapping directories rejected
  await assert.rejects(
    ()=>createWorkspaceBackup({sourceDir,backupDir:join(sourceDir,'nested-bak'),publish:false}),
    error=>error instanceof BackupError&&error.code==='OVERLAPPING_PATHS',
  );

  // Symlink / Windows junction rejection in sourceDir and backupDir
  const outsideDir=join(root,'outside-dir');
  await mkdir(outsideDir,{recursive:true});
  await writeFile(join(outsideDir,'secret.txt'),'outside','utf8');

  const validSource=join(root,'valid-source');
  await mkdir(validSource,{recursive:true});
  const {db}=await seedDisposableWorkspace(validSource);
  db.close();
  const validStaged=await createWorkspaceBackup({sourceDir:validSource,publish:false});

  const linkPath=join(validSource,'linked-dir');
  await symlink(outsideDir,linkPath,process.platform==='win32'?'junction':'dir');
  await assert.rejects(
    ()=>inventoryWorkspace(validSource),
    error=>error instanceof BackupError&&error.code==='SYMLINK_REJECTED',
  );
  await rm(linkPath,{recursive:true,force:true});

  const validBak=join(root,'valid-bak');
  await writeSyntheticBackup(validBak,validStaged.archiveBytes);
  const bakLink=join(validBak,'linked-dir');
  await symlink(outsideDir,bakLink,process.platform==='win32'?'junction':'dir');
  await assert.rejects(
    ()=>verifyWorkspaceBackup({backupDir:validBak}),
    error=>error instanceof BackupError&&error.code==='SYMLINK_REJECTED',
  );
});

const SYNTHETIC_TIME='2026-11-18T12:00:00.000Z';
const ACCEPTED_ID='11111111-1111-4111-8111-111111111111';

async function makeValidArchive(t,prefix,sentinels={}) {
  const root=await makeTempDir(t,prefix);
  const sourceDir=join(root,'source');
  await mkdir(sourceDir,{recursive:true});
  const {db}=await seedDisposableWorkspace(sourceDir,sentinels);
  db.close();
  const created=await createWorkspaceBackup({sourceDir,publish:false,now:()=>SYNTHETIC_TIME});
  const validBackup=join(root,'valid-backup');
  await writeSyntheticBackup(validBackup,created.archiveBytes);
  return {root,sourceDir,validBackup,created};
}

// Applies a synthetic tamper and re-signs the archive so only the verifier's own checks can reject it.
async function resignArchive(dir,{mutateDb,mutateManifest,rawManifest}={}) {
  const dbFile=join(dir,'database','workspace.sqlite');
  if (mutateDb) {
    const bakDb=new DatabaseSync(dbFile);
    try {
      bakDb.exec('PRAGMA secure_delete=OFF;');
      mutateDb(bakDb);
    } finally {
      bakDb.close();
    }
  }
  const bytes=await readFile(dbFile);
  const m=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
  m.database.byteLength=bytes.byteLength;
  m.database.sha256=sha256(bytes);
  if (mutateManifest) mutateManifest(m);
  let raw=JSON.stringify(m,null,2)+'\n';
  if (rawManifest) raw=rawManifest(raw);
  await writeFile(join(dir,'manifest.json'),raw,'utf8');
  await writeFile(join(dir,'manifest.sha256'),sha256(raw)+'\n','utf8');
}

function updateAcceptedTask(db,mutate) {
  const row=db.prepare('SELECT data FROM tasks WHERE id = ?').get(ACCEPTED_ID);
  const parsed=JSON.parse(row.data);
  const replacement=mutate(parsed,row.data);
  db.prepare('UPDATE tasks SET data = ? WHERE id = ?')
    .run(typeof replacement==='string'?replacement:JSON.stringify(parsed),ACCEPTED_ID);
}

const omitsSentinel=(error,sentinel)=>
  !String(error?.message).includes(sentinel)&&!String(error?.cause?.message??'').includes(sentinel);

test('redacted archive verifier rejects nested, extra-field, schema-object, duplicate-key, deleted-page, and manifest-string sentinels',async t=>{
  const {root,validBackup}=await makeValidArchive(t,'bfe-bak-strict-');
  let index=0;
  async function assertStrictRejection(label,code,buildMutation) {
    index++;
    const sentinel=`SENTINEL_STRICT_${index}_99${index}`;
    const dir=join(root,`strict-${index}`);
    await cp(validBackup,dir,{recursive:true});
    await resignArchive(dir,buildMutation(sentinel));
    const archive=Buffer.concat([
      await readFile(join(dir,'manifest.json')),
      await readFile(join(dir,'database','workspace.sqlite')),
    ]);
    assert.equal(archive.includes(sentinel),true,`precondition: tampered archive carries the sentinel for ${label}`);
    for (const [name,run] of [
      ['verify',()=>verifyWorkspaceBackup({backupDir:dir})],
      ['restore',()=>restoreWorkspaceBackup({backupDir:dir,publish:false})],
    ]) {
      await assert.rejects(
        run,
        error=>error instanceof BackupError&&error.code===code&&omitsSentinel(error,sentinel)&&error.cleanup?.ok===true,
        `${name} should fail with ${code} and locally generated text for: ${label}`,
      );
    }
  }

  await assertStrictRejection('extra field nested in usage.steps items','SECRET_LEAK_DETECTED',sentinel=>({mutateDb(db) {
    updateAcceptedTask(db,task=>{
      task.attempts[0].usage={
        ...task.attempts[0].usage,
        evidence:'OpenCode reported',
        semantics:'opencode-engine-defined',
        steps:{
          items:[{input:1,output:1,cached:null,cacheWrite:null,reasoning:null,note:sentinel}],
          duplicates:0,unidentified:false,identityAmbiguous:false,conflict:false,truncated:false,
        },
      };
    });
  }}));
  await assertStrictRejection('arbitrary usage.steps contents on non-OpenCode usage','SECRET_LEAK_DETECTED',sentinel=>({mutateDb(db) {
    updateAcceptedTask(db,task=>{task.attempts[0].usage.steps={items:[sentinel]};});
  }}));
  await assertStrictRejection('extra event field','SECRET_LEAK_DETECTED',sentinel=>({mutateDb(db) {
    updateAcceptedTask(db,task=>{task.events[0].note=sentinel;});
  }}));
  await assertStrictRejection('unchecked attempt provider value','BACKUP_CORRUPTED',sentinel=>({mutateDb(db) {
    updateAcceptedTask(db,task=>{task.attempts[0].provider=sentinel;});
  }}));
  await assertStrictRejection('unchecked attempt claimId value','BACKUP_CORRUPTED',sentinel=>({mutateDb(db) {
    updateAcceptedTask(db,task=>{task.attempts[0].claimId=sentinel;});
  }}));
  await assertStrictRejection('duplicate JSON key hiding content','SECRET_LEAK_DETECTED',sentinel=>({mutateDb(db) {
    updateAcceptedTask(db,(_task,raw)=>raw.replace('"kind":"change"',`"kind":"${sentinel}","kind":"change"`));
  }}));
  await assertStrictRejection('SQLite view','SECRET_LEAK_DETECTED',sentinel=>({mutateDb(db) {
    db.exec(`CREATE VIEW leak_view AS SELECT '${sentinel}' AS v;`);
  }}));
  await assertStrictRejection('SQLite trigger','SECRET_LEAK_DETECTED',sentinel=>({mutateDb(db) {
    db.exec(`CREATE TRIGGER leak_trigger AFTER INSERT ON tasks BEGIN SELECT '${sentinel}'; END;`);
  }}));
  await assertStrictRejection('SQLite freelist pages from deleted content','SECRET_LEAK_DETECTED',sentinel=>({mutateDb(db) {
    db.exec('CREATE TABLE junk (x TEXT);');
    db.prepare('INSERT INTO junk VALUES (?)').run(sentinel.repeat(4000));
    db.exec('DROP TABLE junk;');
  }}));
  await assertStrictRejection('arbitrary exclusion reason','MANIFEST_INVALID',sentinel=>({mutateManifest(m) {
    m.exclusions[0].reason=sentinel;
  }}));
  await assertStrictRejection('exclusion entry carrying a file path','MANIFEST_INVALID',sentinel=>({mutateManifest(m) {
    m.exclusions[0].path=`${sentinel}.txt`;
  }}));
  await assertStrictRejection('appended manifest limit','MANIFEST_INVALID',sentinel=>({mutateManifest(m) {
    m.limits.push(sentinel);
  }}));
  await assertStrictRejection('arbitrary excluded-table reason','MANIFEST_INVALID',sentinel=>({mutateManifest(m) {
    m.excludedTables[0].reason=sentinel;
  }}));
  await assertStrictRejection('free-text createdAt','MANIFEST_INVALID',sentinel=>({mutateManifest(m) {
    m.createdAt=`${SYNTHETIC_TIME} ${sentinel}`;
  }}));
  await assertStrictRejection('suspicious table not derived from excluded tables','MANIFEST_INVALID',sentinel=>({mutateManifest(m) {
    m.consistency.suspiciousSecretTables.push(`token_${sentinel}`);
  }}));
  await assertStrictRejection('duplicate manifest key hiding content','MANIFEST_INVALID',sentinel=>({rawManifest(raw) {
    return raw.replace('"mode": "redacted-metadata-v1"',`"mode": "${sentinel}",\n  "mode": "redacted-metadata-v1"`);
  }}));
});

test('staged restore rebuilds a fresh database from validated fields and drops deleted-cell residue',async t=>{
  const {root,validBackup}=await makeValidArchive(t,'bfe-bak-rebuild-');
  const sentinel='SENTINEL_DELETED_CELL_9940';
  const dir=join(root,'residue');
  await cp(validBackup,dir,{recursive:true});
  await resignArchive(dir,{mutateDb(db) {
    db.prepare('INSERT INTO task_removal_audit (id, reference, removed_at, scope) VALUES (?, ?, ?, ?)')
      .run(999,sentinel,'2026-11-18T09:30:00.000Z','workspace-record-only-v1');
    db.prepare('DELETE FROM task_removal_audit WHERE id = ?').run(999);
  }});
  assert.equal((await readFile(join(dir,'database','workspace.sqlite'))).includes(sentinel),true,
    'precondition: archive page retains deleted-cell residue');

  const verified=await verifyWorkspaceBackup({backupDir:dir});
  assert.equal(verified.ok,true);

  let restoredBytes=null;
  const restored=await restoreWorkspaceBackup({
    backupDir:dir,
    publish:false,
    _testHooks:{async onRestoredDatabaseBytes(bytes) {restoredBytes=bytes;}},
  });
  assert.equal(restored.verifiedInStaging,true);
  assert.equal(restored.cleanup.ok,true);
  assert.ok(Buffer.isBuffer(restoredBytes),'restore must expose rebuilt staged bytes to the test hook');
  assert.equal(restoredBytes.includes(sentinel),false,'restored staging database must be rebuilt, not page-copied');
  assert.deepEqual(restored.database.tables,{task_draft_copies:1,task_removal_audit:1,tasks:2});
});

test('normal scope, dispatch, proposal edit, and draft-copy history events are backed up with strict field validation',async t=>{
  const root=await makeTempDir(t,'bfe-bak-events-');
  const sourceDir=join(root,'source');
  await mkdir(sourceDir,{recursive:true});
  const sentinel='SENTINEL_SOURCE_EVENT_EXTRA_9950';
  const copiedDraftId='77777777-7777-4777-8777-777777777777';
  const copiedDraft={
    id:copiedDraftId,version:1,status:'draft',kind:'change',title:'Copy',request:'Update file',source:'line',
    filename:'example.txt',expected:'Revised',sourceHash:sha256('line'),model:null,attempts:[],
    events:[{seq:1,at:'2026-11-18T10:10:00.000Z',event:'task.copied_as_draft'}],
  };
  const {db}=await seedDisposableWorkspace(sourceDir,{
    acceptedVersion:7,
    acceptedEvents:[
      {seq:1,at:'2026-11-18T09:59:00.000Z',event:'task.created'},
      {seq:2,at:'2026-11-18T09:59:30.000Z',event:'scope.updated',note:sentinel},
      {seq:3,at:'2026-11-18T10:00:00.000Z',event:'attempt.approved_and_started'},
      {seq:4,at:'2026-11-18T10:00:00.200Z',event:'attempt.dispatching'},
      {seq:5,at:'2026-11-18T10:00:00.500Z',event:'attempt.review'},
      {seq:6,at:'2026-11-18T10:00:00.700Z',event:'proposal.operator_edited'},
      {seq:7,at:'2026-11-18T10:00:01.000Z',event:'review.accepted'},
    ],
    rawTaskRows:[[copiedDraftId,'2026-11-18T10:10:00.000Z',JSON.stringify(copiedDraft)]],
  });
  db.close();

  const created=await createWorkspaceBackup({sourceDir,publish:false,now:()=>SYNTHETIC_TIME});
  assert.equal(created.archiveBytes.database.includes(sentinel),false,'source event extras must be dropped');
  assert.deepEqual(created.manifest.database.summary.eventSequences[ACCEPTED_ID],[1,2,3,4,5,6,7]);
  assert.deepEqual(created.manifest.database.summary.eventSequences[copiedDraftId],[1]);

  const backupDir=join(root,'backup');
  await writeSyntheticBackup(backupDir,created.archiveBytes);
  const verified=await verifyWorkspaceBackup({backupDir});
  assert.equal(verified.ok,true);
  const restored=await restoreWorkspaceBackup({backupDir,publish:false});
  assert.deepEqual(restored.database.summary.eventSequences[ACCEPTED_ID],[1,2,3,4,5,6,7]);

  let caseIndex=0;
  for (const [label,events] of [
    ['unknown event name',[{seq:1,at:'2026-11-18T09:59:00.000Z',event:'scope.bogus'}]],
    ['non-increasing event sequence',[
      {seq:1,at:'2026-11-18T09:59:00.000Z',event:'task.created'},
      {seq:1,at:'2026-11-18T09:59:30.000Z',event:'scope.updated'},
    ]],
    ['event sequence beyond task version',[{seq:9,at:'2026-11-18T09:59:00.000Z',event:'task.created'}]],
  ]) {
    caseIndex++;
    const badSource=join(root,`bad-${caseIndex}`);
    await mkdir(badSource,{recursive:true});
    const seeded=await seedDisposableWorkspace(badSource,{acceptedEvents:events});
    seeded.db.close();
    await assert.rejects(
      ()=>createWorkspaceBackup({sourceDir:badSource,publish:false}),
      error=>error instanceof BackupError&&error.code==='UNSUPPORTED_WORKSPACE_SCHEMA',
      `Expected UNSUPPORTED_WORKSPACE_SCHEMA for ${label}`,
    );
  }
});

test('source views, triggers, and invalid values are rejected with locally generated diagnostics',async t=>{
  const root=await makeTempDir(t,'bfe-bak-source-');
  const cases=[
    ['source view','UNSUPPORTED_WORKSPACE_SCHEMA',sentinel=>({extraSql:`CREATE VIEW leak_view AS SELECT '${sentinel}' AS v;`})],
    ['source trigger','UNSUPPORTED_WORKSPACE_SCHEMA',sentinel=>({
      extraSql:`CREATE TRIGGER leak_trigger AFTER INSERT ON tasks BEGIN SELECT '${sentinel}'; END;`,
    })],
    ['removal audit scope text','UNSUPPORTED_WORKSPACE_SCHEMA',sentinel=>({auditScope:sentinel})],
    ['unknown attempt status','UNSUPPORTED_WORKSPACE_SCHEMA',sentinel=>({extraAttemptFields:{status:sentinel}})],
    ['corrupt task JSON','BACKUP_CORRUPTED',sentinel=>({
      rawTaskRows:[['88888888-8888-4888-8888-888888888888','2026-11-18T10:07:00.000Z',`${sentinel} not json`]],
    })],
  ];
  let index=0;
  for (const [label,code,build] of cases) {
    index++;
    const sentinel=`SENTINEL_SOURCE_${index}_996${index}`;
    const sourceDir=join(root,`source-${index}`);
    await mkdir(sourceDir,{recursive:true});
    const {db}=await seedDisposableWorkspace(sourceDir,build(sentinel));
    db.close();
    for (const [name,run] of [
      ['inventory',()=>inventoryWorkspace(sourceDir)],
      ['create',()=>createWorkspaceBackup({sourceDir,publish:false})],
    ]) {
      await assert.rejects(
        run,
        error=>error instanceof BackupError&&error.code===code&&omitsSentinel(error,sentinel)&&
          (code!=='BACKUP_CORRUPTED'||error.cause===undefined),
        `${name} should fail with ${code} without echoing workspace content for: ${label}`,
      );
    }
  }
});

test('native errors after staging keep the original cause and attach cleanup results',async t=>{
  const {sourceDir,validBackup}=await makeValidArchive(t,'bfe-bak-native-');
  const nativeError=()=>Object.assign(new Error('simulated native EIO'),{code:'EIO'});

  let injected=null;
  await assert.rejects(
    ()=>verifyWorkspaceBackup({backupDir:validBackup,_testHooks:{
      async onBeforeOpenFile() {injected=nativeError();throw injected;},
    }}),
    error=>error instanceof BackupError&&error.code==='STAGING_FAILED'&&
      error.cause===injected&&error.cause.code==='EIO'&&
      error.cleanup?.ok===true&&error.cleanup.staged===true&&error.cleanup.residualPaths.length===0,
  );

  let residual=null;
  t.after(async()=>{if (residual) await rm(residual,{recursive:true,force:true});});
  await assert.rejects(
    ()=>restoreWorkspaceBackup({backupDir:validBackup,publish:false,_testHooks:{
      async onBeforeOpenFile() {injected=nativeError();throw injected;},
      async onCleanupStage(stageRoot) {residual=stageRoot;throw new Error('simulated EBUSY during stage cleanup');},
    }}),
    error=>error instanceof BackupError&&error.code==='STAGING_FAILED'&&
      error.cause===injected&&error.publication?.status==='disabled'&&
      error.cleanup?.ok===false&&/EBUSY/.test(error.cleanup.error)&&
      error.cleanup.residualPaths.length===1&&error.cleanup.residualPaths[0]===residual,
  );

  await assert.rejects(
    ()=>createWorkspaceBackup({sourceDir,publish:false,_testHooks:{
      async onStaged() {injected=nativeError();throw injected;},
    }}),
    error=>error instanceof BackupError&&error.code==='STAGING_FAILED'&&
      error.cause===injected&&error.publication?.status==='disabled'&&
      error.cleanup?.ok===true&&error.cleanup.staged===true,
  );
});
