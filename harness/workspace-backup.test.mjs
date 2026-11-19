import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {
  BACKUP_FORMAT,
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

function buildSampleTasks() {
  const source='line one\nline two\n';
  const sourceHash=sha256(source);
  const artifactContent='Revised output\n';
  const artifactHash=sha256(artifactContent);
  const scopeHash=sha256(JSON.stringify([sourceHash,'Update file','Revised','change','fixture','fixture','fixture',null]));
  const acceptedTask={
    id:'11111111-1111-4111-8111-111111111111',
    version:3,
    status:'accepted',
    kind:'change',
    title:'Synthetic change',
    request:'Update file',
    source,
    filename:'example.txt',
    expected:'Revised',
    sourceHash,
    model:'fixture',
    attempts:[{
      id:'22222222-2222-4222-8222-222222222222',
      model:'fixture',
      provider:'fixture',
      backend:'fixture',
      started:'2026-11-18T10:00:00.000Z',
      ended:'2026-11-18T10:00:01.000Z',
      elapsedMs:1000,
      status:'accepted',
      scopeHash,
      execution:{phase:'settled',claimId:'22222222-2222-4222-8222-222222222222'},
      usage:{evidence:'synthetic',input:10,output:5},
      artifact:{summary:'Updated',content:artifactContent,sha256:artifactHash,patch:null},
      checks:[{name:'Contains expected',pass:true}],
    }],
    events:[
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

async function seedDisposableWorkspace(sourceDir) {
  const {acceptedTask,draftTask,artifactHash}=buildSampleTasks();
  const dbPath=join(sourceDir,'workspace.sqlite');
  const db=new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE tasks (id TEXT PRIMARY KEY, updated TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE task_removal_audit (id INTEGER PRIMARY KEY, reference TEXT NOT NULL, removed_at TEXT NOT NULL, scope TEXT NOT NULL);
    CREATE TABLE task_draft_copies (request_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_version INTEGER NOT NULL, draft_id TEXT NOT NULL);
    CREATE TABLE ledger_usage_events (event_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, phase TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL);`);
  const insertTask=db.prepare('INSERT INTO tasks VALUES (?, ?, ?)');
  insertTask.run(acceptedTask.id,'2026-11-18T10:00:01.000Z',JSON.stringify(acceptedTask));
  insertTask.run(draftTask.id,'2026-11-18T10:05:00.000Z',JSON.stringify(draftTask));
  db.prepare('INSERT INTO task_removal_audit (reference, removed_at, scope) VALUES (?, ?, ?)')
    .run('ref-hash','2026-11-18T09:00:00.000Z','workspace-record-only-v1');
  db.prepare('INSERT INTO ledger_usage_events VALUES (?, ?, ?, ?, ?)')
    .run('ev-1',acceptedTask.attempts[0].id,'final',1,'{"input":10,"output":5}');

  await mkdir(join(sourceDir,'artifacts'),{recursive:true});
  await mkdir(join(sourceDir,'opencode'),{recursive:true});
  await mkdir(join(sourceDir,'hermes'),{recursive:true});
  await mkdir(join(sourceDir,'terminal-replay'),{recursive:true});
  await mkdir(join(sourceDir,'secrets'),{recursive:true});
  await mkdir(join(sourceDir,'backups'),{recursive:true});

  await writeFile(join(sourceDir,'artifacts','proposal.txt'),'Revised output\n','utf8');
  await writeFile(join(sourceDir,'opencode','session-meta.json'),'{"session":"ok"}\n','utf8');
  await writeFile(join(sourceDir,'hermes','context.md'),'# Approved note\n','utf8');
  await writeFile(join(sourceDir,'terminal-replay','events.jsonl'),'{"seq":1,"type":"done"}\n','utf8');

  const secret='SUPER_SECRET_SENTINEL_DO_NOT_BACKUP';
  await writeFile(join(sourceDir,'access.key'),secret,'utf8');
  await writeFile(join(sourceDir,'.env'),`API_KEY=${secret}\n`,'utf8');
  await writeFile(join(sourceDir,'.env.local'),secret,'utf8');
  await writeFile(join(sourceDir,'credentials.json'),JSON.stringify({token:secret}),'utf8');
  await writeFile(join(sourceDir,'opencode','auth.json'),JSON.stringify({key:secret}),'utf8');
  await writeFile(join(sourceDir,'secrets','session.token'),secret,'utf8');
  await writeFile(join(sourceDir,'workspace.sqlite.owner.sqlite'),'lock','utf8');
  await writeFile(join(sourceDir,'backups','previous.json'),'{"old":true}\n','utf8');

  return {db,acceptedTask,draftTask,artifactHash,secret};
}

async function listAllRelative(dir,prefix='') {
  const entries=await readdir(dir,{withFileTypes:true});
  const out=[];
  for (const entry of entries) {
    const rel=prefix?`${prefix}/${entry.name}`:entry.name;
    if (entry.isDirectory()) out.push(...await listAllRelative(join(dir,entry.name),rel));
    else out.push(rel);
  }
  return out.sort();
}

test('inventory, consistent WAL backup, secret exclusion, and disposable restore verification',async t=>{
  const root=await makeTempDir(t,'bfe-bak-happy-');
  const sourceDir=join(root,'source');
  const backupDir=join(root,'backup');
  const restoreDir=join(root,'restore');
  await mkdir(sourceDir,{recursive:true});

  const {db,acceptedTask,draftTask,artifactHash,secret}=await seedDisposableWorkspace(sourceDir);
  t.after(()=>{try {db.close();} catch {}});

  // Keep the WAL writer connection open during inventory and backup to verify online snapshot consistency.
  const inventory=await inventoryWorkspace(sourceDir);
  assert.equal(inventory.database.integrity,'ok');
  assert.equal(inventory.consistency.crossStoreConsistency,'unknown');
  assert.equal(inventory.consistency.copiedFilesBinding,'unverified-best-effort-copy');
  assert.equal(inventory.consistency.activeLockOrWalObserved,true);
  assert.equal(inventory.consistency.databaseContentSecrets,'unknown-full-db-retained');
  assert.deepEqual(inventory.database.tables,{
    ledger_usage_events:1,
    task_draft_copies:0,
    task_removal_audit:1,
    tasks:2,
  });
  assert.equal(inventory.database.summary.taskCount,2);
  assert.deepEqual(inventory.included.map(item=>[item.sourcePath,item.store]),[
    ['artifacts/proposal.txt','derived-artifacts'],
    ['hermes/context.md','hermes'],
    ['opencode/session-meta.json','opencode'],
    ['terminal-replay/events.jsonl','terminal-replay'],
  ]);
  const excludedPaths=inventory.exclusions.map(item=>item.path);
  for (const mustExclude of [
    'access.key','.env','.env.local','credentials.json',
    'opencode/auth.json','secrets/session.token','workspace.sqlite.owner.sqlite',
    'workspace.sqlite-wal','workspace.sqlite-shm','backups/previous.json',
  ]) {
    assert.ok(excludedPaths.includes(mustExclude),`Expected exclusion for ${mustExclude}`);
  }
  assert.doesNotMatch(JSON.stringify(inventory),new RegExp(secret));

  const created=await createWorkspaceBackup({
    sourceDir,
    backupDir,
    now:()=>'2026-11-18T12:00:00.000Z',
  });
  assert.equal(created.manifest.format,BACKUP_FORMAT);
  assert.equal(created.manifest.schemaVersion,BACKUP_SCHEMA_VERSION);
  assert.equal(created.manifest.consistency.crossStoreConsistency,'unknown');
  assert.equal(created.manifest.consistency.databaseContentSecrets,'unknown-full-db-retained');
  assert.equal(created.manifest.consistency.activeLockOrWalObserved,true);
  assert.equal(created.manifest.database.summary.taskCount,2);
  assert.deepEqual(created.manifest.database.summary.acceptedArtifactHashes[acceptedTask.id],[artifactHash]);
  assert.deepEqual(created.manifest.database.summary.eventSequences[acceptedTask.id],[1,2,3]);

  const backupFiles=await listAllRelative(backupDir);
  assert.deepEqual(backupFiles,[
    'database/workspace.sqlite',
    'files/artifacts/proposal.txt',
    'files/hermes/context.md',
    'files/opencode/session-meta.json',
    'files/terminal-replay/events.jsonl',
    'manifest.json',
    'manifest.sha256',
  ]);
  for (const rel of backupFiles) {
    const content=await readFile(join(backupDir,rel));
    assert.equal(content.includes(secret),false,`Secret sentinel leaked into ${rel}`);
  }

  db.close();

  const verified=await verifyWorkspaceBackup({backupDir});
  assert.equal(verified.ok,true);
  assert.equal(verified.manifestSha256,created.manifestSha256);
  assert.equal(verified.consistency.crossStoreConsistency,'unknown');

  const restored=await restoreWorkspaceBackup({backupDir,restoreDir});
  assert.equal(restored.restored,true);
  assert.equal(restored.consistency.crossStoreConsistency,'unknown');
  assert.deepEqual(restored.database.tables,created.manifest.database.tables);
  assert.deepEqual(restored.database.summary,created.manifest.database.summary);
  assert.equal(restored.database.summary.taskCount,2);
  assert.deepEqual(restored.database.summary.versions,{
    [acceptedTask.id]:3,
    [draftTask.id]:1,
  });

  const restoredFiles=await listAllRelative(restoreDir);
  assert.deepEqual(restoredFiles,[
    'artifacts/proposal.txt',
    'hermes/context.md',
    'opencode/session-meta.json',
    'terminal-replay/events.jsonl',
    'workspace.sqlite',
  ]);
  assert.equal(await readFile(join(restoreDir,'artifacts','proposal.txt'),'utf8'),'Revised output\n');

  const checkDb=new DatabaseSync(join(restoreDir,'workspace.sqlite'),{readOnly:true});
  try {
    const rows=checkDb.prepare('SELECT id, data FROM tasks ORDER BY id').all();
    assert.equal(rows.length,2);
    assert.equal(JSON.parse(rows[0].data).id,acceptedTask.id);
    assert.equal(JSON.parse(rows[1].data).id,draftTask.id);
  } finally {
    checkDb.close();
  }
});

test('whole-DB secret retention and suspicious table names are disclosed, not hidden',async t=>{
  const root=await makeTempDir(t,'bfe-bak-dbsecrets-');
  const sourceDir=join(root,'source');
  const backupDir=join(root,'backup');
  await mkdir(sourceDir,{recursive:true});

  const inlineDbSecret='INLINE_DB_TEXT_RETAINED_VERBATIM';
  const db=new DatabaseSync(join(sourceDir,'workspace.sqlite'));
  db.exec(`PRAGMA journal_mode=DELETE;
    CREATE TABLE tasks (id TEXT PRIMARY KEY, updated TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE oauth_tokens (id TEXT PRIMARY KEY, note TEXT NOT NULL);`);
  db.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run(
    '44444444-4444-4444-8444-444444444444',
    '2026-11-18T11:00:00.000Z',
    JSON.stringify({
      id:'44444444-4444-4444-8444-444444444444',
      version:1,
      status:'draft',
      kind:'brief',
      title:'Note',
      request:'Summarize',
      source:inlineDbSecret,
      filename:null,
      expected:null,
      sourceHash:sha256(inlineDbSecret),
      model:null,
      attempts:[],
      events:[{seq:1,at:'2026-11-18T11:00:00.000Z',event:'task.created'}],
    }),
  );
  db.close();

  const created=await createWorkspaceBackup({sourceDir,backupDir});
  assert.equal(created.manifest.consistency.activeLockOrWalObserved,false);
  assert.equal(created.manifest.consistency.databaseContentSecrets,'unknown-full-db-retained');
  assert.deepEqual(created.manifest.consistency.suspiciousSecretTables,['oauth_tokens']);
  assert.ok(created.manifest.limits.some(line=>/may contain secrets/i.test(line)));
});

test('tampered or corrupted backups are rejected without creating or mutating restore destination',async t=>{
  const root=await makeTempDir(t,'bfe-bak-tamper-');
  const sourceDir=join(root,'source');
  const validBackup=join(root,'valid-backup');
  await mkdir(sourceDir,{recursive:true});

  const {db}=await seedDisposableWorkspace(sourceDir);
  try {
    await createWorkspaceBackup({sourceDir,backupDir:validBackup});
  } finally {
    db.close();
  }

  let caseIndex=0;
  async function assertTamperRejected(label,expectedCode,mutateFn) {
    caseIndex++;
    const copyDir=join(root,`tampered-${caseIndex}`);
    const restoreDir=join(root,`restore-${caseIndex}`);
    await cp(validBackup,copyDir,{recursive:true});
    await mutateFn(copyDir);
    await assert.rejects(
      ()=>verifyWorkspaceBackup({backupDir:copyDir}),
      error=>error instanceof BackupError&&error.code===expectedCode,
      `verifyWorkspaceBackup should fail with ${expectedCode} for: ${label}`,
    );
    await assert.rejects(
      ()=>restoreWorkspaceBackup({backupDir:copyDir,restoreDir}),
      error=>error instanceof BackupError&&error.code===expectedCode,
      `restoreWorkspaceBackup should fail with ${expectedCode} for: ${label}`,
    );
    await assert.rejects(()=>stat(restoreDir),{code:'ENOENT'});
  }

  await assertTamperRejected('tampered artifact byte','BACKUP_CORRUPTED',async dir=>{
    await writeFile(join(dir,'files','artifacts','proposal.txt'),'Tampered output\n','utf8');
  });

  await assertTamperRejected('corrupted sqlite bytes','BACKUP_CORRUPTED',async dir=>{
    await writeFile(join(dir,'database','workspace.sqlite'),'not-a-valid-sqlite-database','utf8');
  });

  await assertTamperRejected('modified manifest without updating manifest.sha256','BACKUP_CORRUPTED',async dir=>{
    const m=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
    m.database.summary.taskCount=99;
    await writeFile(join(dir,'manifest.json'),JSON.stringify(m,null,2)+'\n','utf8');
  });

  await assertTamperRejected('modified manifest AND re-signed manifest.sha256','BACKUP_CORRUPTED',async dir=>{
    const m=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
    m.database.summary.taskCount=99;
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

  await assertTamperRejected('tampered sqlite rows without updating manifest','BACKUP_CORRUPTED',async dir=>{
    const bakDb=new DatabaseSync(join(dir,'database','workspace.sqlite'));
    try {
      bakDb.exec('DELETE FROM task_removal_audit');
    } finally {
      bakDb.close();
    }
  });

  await assertTamperRejected('missing manifest.sha256','BACKUP_CORRUPTED',async dir=>{
    await rm(join(dir,'manifest.sha256'));
  });

  await assertTamperRejected('missing listed artifact','BACKUP_CORRUPTED',async dir=>{
    await rm(join(dir,'files','hermes','context.md'));
  });

  await assertTamperRejected('unexpected extra file in archive','BACKUP_CORRUPTED',async dir=>{
    await writeFile(join(dir,'files','artifacts','extra.txt'),'unexpected','utf8');
  });

  await assertTamperRejected('planted access.key inside backup files','SECRET_LEAK_DETECTED',async dir=>{
    await writeFile(join(dir,'files','access.key'),'leaked','utf8');
  });

  await assertTamperRejected('prototype pollution key in manifest','MANIFEST_INVALID',async dir=>{
    const raw=await readFile(join(dir,'manifest.json'),'utf8');
    const polluted=raw.replace('{','{\n  "__proto__": {"polluted": true},');
    await writeFile(join(dir,'manifest.json'),polluted,'utf8');
    await writeFile(join(dir,'manifest.sha256'),sha256(polluted)+'\n','utf8');
  });

  await assertTamperRejected('unsupported manifest schema version','MANIFEST_INVALID',async dir=>{
    const m=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
    m.schemaVersion=999;
    const raw=JSON.stringify(m,null,2)+'\n';
    await writeFile(join(dir,'manifest.json'),raw,'utf8');
    await writeFile(join(dir,'manifest.sha256'),sha256(raw)+'\n','utf8');
  });

  await assertTamperRejected('path traversal in manifest artifact','INVALID_PATH',async dir=>{
    const m=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
    m.artifacts[0].path='files/../escape.txt';
    const raw=JSON.stringify(m,null,2)+'\n';
    await writeFile(join(dir,'manifest.json'),raw,'utf8');
    await writeFile(join(dir,'manifest.sha256'),sha256(raw)+'\n','utf8');
  });

  // Verify an existing non-empty live-like destination is never opened or mutated on restore.
  const sentinelDir=join(root,'existing-live');
  await mkdir(sentinelDir,{recursive:true});
  const sentinelDbPath=join(sentinelDir,'workspace.sqlite');
  const sentinelDb=new DatabaseSync(sentinelDbPath);
  sentinelDb.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY); INSERT INTO tasks VALUES ('live-sentinel');");
  sentinelDb.close();
  const beforeBytes=await readFile(sentinelDbPath);
  await assert.rejects(
    ()=>restoreWorkspaceBackup({backupDir:validBackup,restoreDir:sentinelDir}),
    error=>error instanceof BackupError&&error.code==='DESTINATION_NOT_EMPTY',
  );
  const afterBytes=await readFile(sentinelDbPath);
  assert.equal(sha256(afterBytes),sha256(beforeBytes));
});

test('concurrent destination races preserve original and concurrently added files on publish failure',async t=>{
  const root=await makeTempDir(t,'bfe-bak-race-');
  const sourceDir=join(root,'source');
  await mkdir(sourceDir,{recursive:true});
  const {db}=await seedDisposableWorkspace(sourceDir);
  db.close();

  // 1. Non-existent backupDir raced before publish: concurrent file is preserved.
  const racedNewBackup=join(root,'raced-new-backup');
  await assert.rejects(
    ()=>createWorkspaceBackup({
      sourceDir,
      backupDir:racedNewBackup,
      _testHooks:{
        async onBeforePublish(target) {
          await mkdir(target,{recursive:true});
          await writeFile(join(target,'concurrent-owner.txt'),'keep-new','utf8');
        },
      },
    }),
    error=>error instanceof BackupError&&error.code==='DESTINATION_NOT_EMPTY',
  );
  assert.deepEqual(await listAllRelative(racedNewBackup),['concurrent-owner.txt']);
  assert.equal(await readFile(join(racedNewBackup,'concurrent-owner.txt'),'utf8'),'keep-new');

  // 2. Pre-created empty backupDir raced before publish: concurrent file is preserved, dir not removed.
  const racedEmptyBackup=join(root,'raced-empty-backup');
  await mkdir(racedEmptyBackup,{recursive:true});
  await assert.rejects(
    ()=>createWorkspaceBackup({
      sourceDir,
      backupDir:racedEmptyBackup,
      _testHooks:{
        async onBeforePublish(target) {
          await writeFile(join(target,'unrelated.txt'),'keep-unrelated','utf8');
        },
      },
    }),
    error=>error instanceof BackupError&&error.code==='DESTINATION_NOT_EMPTY',
  );
  assert.deepEqual(await listAllRelative(racedEmptyBackup),['unrelated.txt']);
  assert.equal(await readFile(join(racedEmptyBackup,'unrelated.txt'),'utf8'),'keep-unrelated');

  // 3. Pre-created empty backupDir raced mid-publish with conflicting manifest.json:
  // concurrent manifest.json is preserved and operation-created files/empty subdirs are rolled back.
  const midRaceBackup=join(root,'mid-race-backup');
  await mkdir(midRaceBackup,{recursive:true});
  await assert.rejects(
    ()=>createWorkspaceBackup({
      sourceDir,
      backupDir:midRaceBackup,
      _testHooks:{
        async onAfterFileWrite(_rel,index,target) {
          if (index===0) {
            await writeFile(join(target,'manifest.json'),'{"concurrent":true}\n','utf8');
          }
        },
      },
    }),
    error=>error instanceof BackupError&&error.code==='CONCURRENT_MODIFICATION',
  );
  assert.deepEqual(await listAllRelative(midRaceBackup),['manifest.json']);
  assert.equal(await readFile(join(midRaceBackup,'manifest.json'),'utf8'),'{"concurrent":true}\n');

  // 4. Create a clean backup, then race restoreWorkspaceBackup mid-publish with an unrelated sibling file
  // inside a pre-created empty restoreDir and inside a new non-existent restoreDir.
  const validBackup=join(root,'valid-backup');
  await createWorkspaceBackup({sourceDir,backupDir:validBackup});

  const midRacePreRestore=join(root,'mid-race-pre-restore');
  await mkdir(midRacePreRestore,{recursive:true});
  await assert.rejects(
    ()=>restoreWorkspaceBackup({
      backupDir:validBackup,
      restoreDir:midRacePreRestore,
      _testHooks:{
        async onAfterFileWrite(_rel,index,target) {
          if (index===0) {
            await mkdir(join(target,'concurrent-dir'),{recursive:true});
            await writeFile(join(target,'concurrent-dir','keep.txt'),'concurrent-data','utf8');
          }
        },
      },
    }),
    error=>error instanceof BackupError&&error.code==='CONCURRENT_MODIFICATION',
  );
  assert.deepEqual(await listAllRelative(midRacePreRestore),['concurrent-dir/keep.txt']);
  assert.equal(await readFile(join(midRacePreRestore,'concurrent-dir','keep.txt'),'utf8'),'concurrent-data');

  const midRaceNewRestore=join(root,'mid-race-new-restore');
  await assert.rejects(
    ()=>restoreWorkspaceBackup({
      backupDir:validBackup,
      restoreDir:midRaceNewRestore,
      _testHooks:{
        async onAfterFileWrite(_rel,index,target) {
          if (index===0) {
            await writeFile(join(target,'workspace.sqlite'),'concurrent-db-bytes','utf8');
          }
        },
      },
    }),
    error=>error instanceof BackupError&&error.code==='CONCURRENT_MODIFICATION',
  );
  assert.deepEqual(await listAllRelative(midRaceNewRestore),['workspace.sqlite']);
  assert.equal(await readFile(join(midRaceNewRestore,'workspace.sqlite'),'utf8'),'concurrent-db-bytes');

  // Verify no leftover operation staging directories remain in tmpdir.
  const tmpEntries=await readdir(tmpdir());
  assert.equal(tmpEntries.some(name=>name.startsWith('cydeworks-backup-stage-')||name.startsWith('cydeworks-restore-stage-')),false);
});

test('strict path checks, overlapping directories, corrupt source DB, and symlink rejection',async t=>{
  for (const bad of ['','../secret','/abs','C:/temp','a\\b','sub/./x','NUL.txt','COM¹.txt','sub/file ','sub/file.','a\0b']) {
    assert.throws(
      ()=>assertSafeRelativePath(bad),
      error=>error instanceof BackupError&&error.code==='INVALID_PATH',
      `Expected INVALID_PATH for ${JSON.stringify(bad)}`,
    );
  }

  assert.equal(classifyWorkspaceFile('.state/access.key').included,false);
  assert.equal(classifyWorkspaceFile('.state/access.key').category,'credential-or-secret');
  assert.equal(classifyWorkspaceFile('workspace.sqlite-wal').category,'sqlite-journal');
  assert.equal(classifyWorkspaceFile('workspace.sqlite.owner.sqlite').category,'runtime-lock');
  assert.equal(classifyWorkspaceFile('artifacts/ok.txt').included,true);

  const root=await makeTempDir(t,'bfe-bak-paths-');
  const sourceDir=join(root,'source');
  await mkdir(sourceDir,{recursive:true});

  // Missing database
  await assert.rejects(
    ()=>inventoryWorkspace(sourceDir),
    error=>error instanceof BackupError&&error.code==='MISSING_DATABASE',
  );

  // Corrupt source database leaves empty backupDir clean with no leaked file handles
  await writeFile(join(sourceDir,'workspace.sqlite'),'corrupt-bytes','utf8');
  const emptyBackupDir=join(root,'empty-bak');
  await mkdir(emptyBackupDir,{recursive:true});
  await assert.rejects(
    ()=>createWorkspaceBackup({sourceDir,backupDir:emptyBackupDir}),
    error=>error instanceof BackupError&&error.code==='SQLITE_INTEGRITY_FAILED',
  );
  assert.deepEqual(await readdir(emptyBackupDir),[]);

  // Overlapping / nested directories rejected
  await assert.rejects(
    ()=>createWorkspaceBackup({sourceDir,backupDir:join(sourceDir,'nested-bak')}),
    error=>error instanceof BackupError&&error.code==='OVERLAPPING_PATHS',
  );
  await assert.rejects(
    ()=>createWorkspaceBackup({sourceDir,backupDir:sourceDir}),
    error=>error instanceof BackupError&&error.code==='OVERLAPPING_PATHS',
  );

  // Symlink / Windows junction rejection in sourceDir and backupDir
  const outsideDir=join(root,'outside-dir');
  await mkdir(outsideDir,{recursive:true});
  await writeFile(join(outsideDir,'secret.txt'),'outside','utf8');
  const validSource=join(root,'valid-source');
  await mkdir(validSource,{recursive:true});
  const validDb=new DatabaseSync(join(validSource,'workspace.sqlite'));
  validDb.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, updated TEXT NOT NULL, data TEXT NOT NULL);');
  validDb.close();

  const linkPath=join(validSource,'linked-dir');
  await symlink(outsideDir,linkPath,process.platform==='win32'?'junction':'dir');
  await assert.rejects(
    ()=>inventoryWorkspace(validSource),
    error=>error instanceof BackupError&&error.code==='SYMLINK_REJECTED',
  );
  await rm(linkPath,{recursive:true,force:true});

  const validBak=join(root,'valid-bak');
  await createWorkspaceBackup({sourceDir:validSource,backupDir:validBak});
  const bakLink=join(validBak,'files','linked-dir');
  await mkdir(join(validBak,'files'),{recursive:true});
  await symlink(outsideDir,bakLink,process.platform==='win32'?'junction':'dir');
  await assert.rejects(
    ()=>verifyWorkspaceBackup({backupDir:validBak}),
    error=>error instanceof BackupError&&error.code==='SYMLINK_REJECTED',
  );
});
