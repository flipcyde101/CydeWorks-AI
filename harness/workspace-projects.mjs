import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,readdirSync,readFileSync,realpathSync,statSync} from 'node:fs';
import {isAbsolute,join,parse,relative,resolve} from 'node:path';

export const DEFAULT_PROJECT_ID='default-workspace';
export const DEFAULT_PROJECT_LABEL='Default local workspace';
export const DEFAULT_ROOT_MAX_ENTRIES=4096;
export const DEFAULT_ROOT_MAX_BYTES=8*1024*1024;

const ID_PATTERN=/^[A-Za-z0-9._:-]{1,80}$/;
const REVISION_PATTERN=/^[a-f0-9]{40,64}$/;
const ALLOWED_CREATE_FIELDS=new Set(['label','root','revision']);
const CONTROL_CHARS_PATTERN=/[\u0000-\u001f\u007f]/;
const RESERVED_CHARS_PATTERN=/[<>:"|?*]/;
const DOS_DEVICE_PATTERN=/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function fail(status,code,message) {
  throw Object.assign(Error(message),{status,code});
}

function isPlainObject(value) {
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

function pathsEqual(a,b) {
  return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
}

function normalizeLabel(rawLabel) {
  if(typeof rawLabel!=='string'||CONTROL_CHARS_PATTERN.test(rawLabel)) {
    fail(400,'INVALID_PROJECT_LABEL','Enter a valid project label.');
  }
  const trimmed=rawLabel.trim();
  if(!trimmed||trimmed.length>120) {
    fail(400,'INVALID_PROJECT_LABEL','Project label must be between 1 and 120 characters.');
  }
  return trimmed;
}

function normalizeRevision(rawRevision) {
  if(rawRevision===undefined||rawRevision===null)return null;
  if(typeof rawRevision!=='string'||!REVISION_PATTERN.test(rawRevision)) {
    fail(400,'INVALID_PROJECT_REVISION','Project revision must be a lowercase 40 to 64 character hex digest.');
  }
  return rawRevision;
}

function normalizeProjectId(id) {
  if(typeof id!=='string'||!ID_PATTERN.test(id)) {
    fail(400,'INVALID_PROJECT_ID','Invalid project identifier.');
  }
  return id;
}

export function validateLocalPathSyntax(rawPath,code='INVALID_PROJECT_ROOT',label='local project root path') {
  if(typeof rawPath!=='string'||CONTROL_CHARS_PATTERN.test(rawPath)) {
    fail(400,code,'Enter a valid '+label+'.');
  }
  if(rawPath!==rawPath.trim()||!rawPath||rawPath.length>512) {
    fail(400,code,'Enter a valid '+label+'.');
  }
  if(/^[\\/]{2}/.test(rawPath)) {
    fail(400,code,'Network, UNC, and device paths are not permitted for '+label+'.');
  }
  const drivePrefix=/^([A-Za-z]):(.*)$/.exec(rawPath);
  let remainder;
  if(drivePrefix) {
    if(!/^[\\/]/.test(drivePrefix[2])) {
      fail(400,code,'Drive-relative paths are not permitted for '+label+'.');
    }
    if(process.platform!=='win32') {
      fail(400,code,'Enter a valid '+label+' for this host.');
    }
    remainder=drivePrefix[2];
  } else {
    if(process.platform==='win32') {
      fail(400,code,'Enter an absolute local drive path for '+label+'.');
    }
    if(!rawPath.startsWith('/')) {
      fail(400,code,'Enter an absolute local path for '+label+'.');
    }
    remainder=rawPath;
  }
  if(!isAbsolute(rawPath)) {
    fail(400,code,'Enter an absolute local path for '+label+'.');
  }
  if(RESERVED_CHARS_PATTERN.test(remainder)) {
    fail(400,code,'Reserved or wildcard characters are not permitted in '+label+'.');
  }
  const segments=remainder.split(/[\\/]+/);
  for(const seg of segments) {
    if(seg==='')continue;
    if(seg==='.'||seg==='..') {
      fail(400,code,'Relative traversal segments are not permitted in '+label+'.');
    }
    if(/[ .]$/.test(seg)) {
      fail(400,code,'Path segments in '+label+' cannot end with a space or dot.');
    }
    const baseName=seg.split('.')[0];
    if(DOS_DEVICE_PATTERN.test(baseName)) {
      fail(400,code,'Reserved DOS device names are not permitted in '+label+'.');
    }
  }
  return rawPath;
}

export function resolveLocalRoot(rawRoot,{useTime=false}={}) {
  const errStatus=useTime?409:400;
  const trimmed=validateLocalPathSyntax(rawRoot,'INVALID_PROJECT_ROOT','local project root path');
  const resolved=resolve(trimmed);
  if(parse(resolved).root===resolved) {
    fail(errStatus,'PROJECT_ROOT_FILESYSTEM_ROOT','Choose a project directory rather than a filesystem root.');
  }
  let linkStat;
  try {
    linkStat=lstatSync(resolved);
  } catch {
    fail(errStatus,'PROJECT_ROOT_MISSING','The selected project root does not exist.');
  }
  if(linkStat.isSymbolicLink()) {
    fail(errStatus,'PROJECT_ROOT_SYMLINK','Project root must be a real directory, not a symbolic link.');
  }
  if(!linkStat.isDirectory()) {
    fail(errStatus,'PROJECT_ROOT_NOT_DIRECTORY','The selected project root must be a directory.');
  }
  let canonical;
  try {
    canonical=realpathSync(resolved);
  } catch {
    fail(errStatus,'PROJECT_ROOT_MISSING','The selected project root could not be resolved.');
  }
  validateLocalPathSyntax(canonical,'INVALID_PROJECT_ROOT','local project root path');
  if(!pathsEqual(canonical,resolved)) {
    fail(errStatus,'PROJECT_ROOT_SYMLINK','Project root cannot traverse symbolic links or junctions.');
  }
  if(!statSync(canonical).isDirectory()) {
    fail(errStatus,'PROJECT_ROOT_NOT_DIRECTORY','The selected project root must be a directory.');
  }
  if(parse(canonical).root===canonical) {
    fail(errStatus,'PROJECT_ROOT_FILESYSTEM_ROOT','Choose a project directory rather than a filesystem root.');
  }
  return canonical;
}

export function verifyContainedRoot(projectRoot,candidateRoot,{useTime=false}={}) {
  const errStatus=useTime?409:400;
  validateLocalPathSyntax(candidateRoot,'INVALID_APPROVED_ROOTS','approved root path');
  if(typeof projectRoot!=='string'||!projectRoot) {
    fail(errStatus,'APPROVED_ROOT_OUTSIDE_PROJECT','Project has no registered local root for approved filesystem paths.');
  }
  const canonicalProject=resolveLocalRoot(projectRoot,{useTime});
  const candidateResolved=resolve(candidateRoot);
  const synRel=relative(canonicalProject,candidateResolved);
  if(synRel.startsWith('..')||isAbsolute(synRel)) {
    fail(errStatus,'APPROVED_ROOT_OUTSIDE_PROJECT','Approved root must be inside the registered project root.');
  }
  if(synRel!=='') {
    let cursor=canonicalProject;
    for(const seg of synRel.split(/[\\/]+/)) {
      if(!seg)continue;
      cursor=join(cursor,seg);
      let segStat;
      try {
        segStat=lstatSync(cursor);
      } catch {
        fail(errStatus,'APPROVED_ROOT_MISSING','Approved root does not exist on disk.');
      }
      if(segStat.isSymbolicLink()) {
        fail(errStatus,'APPROVED_ROOT_SYMLINK','Approved root cannot be or traverse a symbolic link or junction.');
      }
      if(!segStat.isDirectory()) {
        fail(errStatus,'APPROVED_ROOT_NOT_DIRECTORY','Approved root must be a directory.');
      }
    }
  }
  let canonicalCandidate;
  try {
    canonicalCandidate=realpathSync(candidateResolved);
  } catch {
    fail(errStatus,'APPROVED_ROOT_MISSING','Approved root could not be resolved.');
  }
  const canonRel=relative(canonicalProject,canonicalCandidate);
  if(canonRel.startsWith('..')||isAbsolute(canonRel)||!pathsEqual(canonRel,synRel)) {
    fail(errStatus,'APPROVED_ROOT_OUTSIDE_PROJECT','Approved root resolves outside the registered project root.');
  }
  return canonicalCandidate;
}

export function captureProjectRootIdentity(projectRoot,{useTime=false}={}) {
  const canonical=resolveLocalRoot(projectRoot,{useTime});
  let st;
  try {
    st=statSync(canonical,{bigint:true});
  } catch {
    fail(useTime?409:400,'PROJECT_ROOT_MISSING','The selected project root does not exist.');
  }
  if(!st.isDirectory()) {
    fail(useTime?409:400,'PROJECT_ROOT_NOT_DIRECTORY','The selected project root must be a directory.');
  }
  return Object.freeze({
    path:canonical,
    dev:String(st.dev),
    ino:String(st.ino),
  });
}

export function captureDirectoryIdentity(
  rawDir,
  {useTime=false,maxEntries=DEFAULT_ROOT_MAX_ENTRIES,maxBytes=DEFAULT_ROOT_MAX_BYTES}={}
) {
  const errStatus=useTime?409:400;
  const canonical=resolveLocalRoot(rawDir,{useTime});
  let rootStat;
  try {
    rootStat=statSync(canonical,{bigint:true});
  } catch {
    fail(errStatus,'APPROVED_ROOT_MISSING','Approved root does not exist on disk.');
  }
  if(!rootStat.isDirectory()) {
    fail(errStatus,'APPROVED_ROOT_NOT_DIRECTORY','Approved root must be a directory.');
  }

  const treeHash=createHash('sha256').update('ROOT_TREE_V1\0');
  let entryCount=0;
  let totalBytes=0;

  const walk=(currentDir,relPrefix)=>{
    let entries;
    try {
      entries=readdirSync(currentDir,{withFileTypes:true});
    } catch {
      fail(errStatus,'APPROVED_ROOT_UNREADABLE','Approved root directory could not be read.');
    }
    entries.sort((a,b)=>(a.name<b.name?-1:a.name>b.name?1:0));
    for(const entry of entries) {
      entryCount++;
      if(entryCount>maxEntries) {
        fail(errStatus,'ROOT_SNAPSHOT_LIMIT_EXCEEDED','Approved root exceeds maximum entry count for snapshot verification.');
      }
      const fullPath=join(currentDir,entry.name);
      const relPath=relPrefix?`${relPrefix}/${entry.name}`:entry.name;
      let lst;
      try {
        lst=lstatSync(fullPath,{bigint:true});
      } catch {
        fail(errStatus,'APPROVED_ROOT_UNREADABLE','Approved root entry could not be inspected.');
      }
      if(lst.isSymbolicLink()||entry.isSymbolicLink()) {
        fail(errStatus,'APPROVED_ROOT_SYMLINK','Approved root cannot contain symbolic links or junctions.');
      }
      let realEntry;
      try {
        realEntry=realpathSync(fullPath);
      } catch {
        fail(errStatus,'APPROVED_ROOT_UNREADABLE','Approved root entry could not be resolved.');
      }
      if(!pathsEqual(realEntry,fullPath)) {
        fail(errStatus,'APPROVED_ROOT_SYMLINK','Approved root entry resolves through a symbolic link or junction.');
      }
      if(lst.isDirectory()) {
        treeHash.update(`D:${relPath}\0${String(lst.ino)}\0`);
        walk(fullPath,relPath);
      } else if(lst.isFile()) {
        const size=Number(lst.size);
        if(!Number.isSafeInteger(size)||size<0||totalBytes+size>maxBytes) {
          fail(errStatus,'ROOT_SNAPSHOT_LIMIT_EXCEEDED','Approved root exceeds maximum byte size for snapshot verification.');
        }
        totalBytes+=size;
        let fileDigest;
        try {
          fileDigest=createHash('sha256').update(readFileSync(fullPath)).digest('hex');
        } catch {
          fail(errStatus,'APPROVED_ROOT_UNREADABLE','Approved root file could not be read for snapshot verification.');
        }
        treeHash.update(`F:${relPath}\0${size}\0${fileDigest}\0`);
      } else {
        fail(errStatus,'INVALID_APPROVED_ROOT_ENTRY','Approved root contains an unsupported filesystem entry.');
      }
    }
  };

  walk(canonical,'');
  return Object.freeze({
    path:canonical,
    dev:String(rootStat.dev),
    ino:String(rootStat.ino),
    treeDigest:treeHash.digest('hex'),
    entryCount,
    totalBytes,
  });
}

export function verifyContainedRootIdentity(
  projectRoot,
  candidateRoot,
  expectedIdentity=null,
  {useTime=false,maxEntries=DEFAULT_ROOT_MAX_ENTRIES,maxBytes=DEFAULT_ROOT_MAX_BYTES}={}
) {
  let canonicalCandidate;
  try {
    canonicalCandidate=verifyContainedRoot(projectRoot,candidateRoot,{useTime});
  } catch(error) {
    if(useTime&&error.code==='PROJECT_ROOT_MISSING') {
      fail(409,'APPROVED_ROOT_MISSING','Registered project root is missing on disk.');
    }
    throw error;
  }
  const identity=captureDirectoryIdentity(canonicalCandidate,{useTime,maxEntries,maxBytes});
  if(expectedIdentity!==null) {
    if(!isPlainObject(expectedIdentity)||
       typeof expectedIdentity.path!=='string'||
       typeof expectedIdentity.dev!=='string'||
       typeof expectedIdentity.ino!=='string'||
       typeof expectedIdentity.treeDigest!=='string') {
      fail(409,'APPROVED_ROOT_IDENTITY_INVALID','Expected approved root identity is invalid.');
    }
    if(!pathsEqual(identity.path,expectedIdentity.path)||
       identity.dev!==expectedIdentity.dev||
       identity.ino!==expectedIdentity.ino) {
      fail(409,'APPROVED_ROOT_REPLACED','Approved root directory identity changed on disk after approval.');
    }
    if(identity.treeDigest!==expectedIdentity.treeDigest||
       identity.entryCount!==expectedIdentity.entryCount||
       identity.totalBytes!==expectedIdentity.totalBytes) {
      fail(409,'APPROVED_ROOT_CHANGED','Approved root directory snapshot changed on disk after approval.');
    }
  }
  return identity;
}

function rowToProject(row) {
  return Object.freeze({
    id:row.id,
    label:row.label,
    root:row.root,
    rootDev:row.root_dev??null,
    rootIno:row.root_ino??null,
    revision:row.revision,
    isDefault:row.is_default===1,
    createdAt:row.created_at,
    updatedAt:row.updated_at,
  });
}

export class WorkspaceProjects {
  constructor(db,{clock=()=>Date.now(),nonce=randomUUID,defaultRoot=null}={}) {
    if(!db||typeof db.exec!=='function'||typeof db.prepare!=='function') {
      throw new TypeError('WorkspaceProjects requires a SQLite DatabaseSync handle.');
    }
    this.db=db;
    this.clock=clock;
    this.nonce=nonce;
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA recursive_triggers=ON;');
    const defaultIdentity=defaultRoot===null||defaultRoot===undefined?null:captureProjectRootIdentity(defaultRoot);
    const nowIso=this.#nowIso();
    this.transaction(()=>{
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS workspace_projects (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          root TEXT UNIQUE,
          root_dev TEXT,
          root_ino TEXT,
          revision TEXT,
          is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`);
      const existingCols=new Set(this.db.prepare('PRAGMA table_info(workspace_projects)').all().map(c=>c.name));
      if(!existingCols.has('root_dev')) {
        this.db.exec('ALTER TABLE workspace_projects ADD COLUMN root_dev TEXT');
      }
      if(!existingCols.has('root_ino')) {
        this.db.exec('ALTER TABLE workspace_projects ADD COLUMN root_ino TEXT');
      }
      this.db.prepare(
        `INSERT OR IGNORE INTO workspace_projects (id,label,root,root_dev,root_ino,revision,is_default,created_at,updated_at)
         VALUES (?,?,?,?,?,?,1,?,?)`
      ).run(
        DEFAULT_PROJECT_ID,
        DEFAULT_PROJECT_LABEL,
        defaultIdentity?.path??null,
        defaultIdentity?.dev??null,
        defaultIdentity?.ino??null,
        null,
        nowIso,
        nowIso
      );
    });
  }

  #nowIso() {
    const ms=this.clock();
    if(!Number.isSafeInteger(ms)||ms<0)fail(500,'INVALID_CLOCK','Invalid workspace clock value.');
    return new Date(ms).toISOString();
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

  listProjects() {
    const rows=this.db.prepare(
      'SELECT id,label,root,root_dev,root_ino,revision,is_default,created_at,updated_at FROM workspace_projects ORDER BY is_default DESC,created_at ASC,id ASC'
    ).all();
    return Object.freeze({
      defaultProjectId:DEFAULT_PROJECT_ID,
      projects:Object.freeze(rows.map(rowToProject)),
    });
  }

  getProject(id) {
    normalizeProjectId(id);
    const row=this.db.prepare(
      'SELECT id,label,root,root_dev,root_ino,revision,is_default,created_at,updated_at FROM workspace_projects WHERE id=?'
    ).get(id);
    return row?rowToProject(row):null;
  }

  requireProject(id) {
    const project=this.getProject(id);
    if(!project)fail(404,'PROJECT_NOT_FOUND','Project not found.');
    return project;
  }

  verifyProjectRootIdentity(project,{useTime=false}={}) {
    if(!project||project.root===null)return null;
    const current=captureProjectRootIdentity(project.root,{useTime});
    if(project.rootDev!==null&&project.rootIno!==null&&
       (current.dev!==project.rootDev||current.ino!==project.rootIno)) {
      fail(409,'PROJECT_ROOT_REPLACED','Registered project root directory identity changed on disk.');
    }
    return current;
  }

  registerProject(input) {
    if(!isPlainObject(input)||Object.keys(input).some(key=>!ALLOWED_CREATE_FIELDS.has(key))) {
      fail(400,'INVALID_PROJECT_INPUT','Provide only label, root, and optional revision.');
    }
    const label=normalizeLabel(input.label);
    const identity=captureProjectRootIdentity(input.root);
    const root=identity.path;
    const revision=normalizeRevision(input.revision);
    return this.transaction(()=>{
      const existing=this.db.prepare(
        'SELECT id,label,root,root_dev,root_ino,revision,is_default,created_at,updated_at FROM workspace_projects WHERE root=?'
      ).get(root);
      if(existing) {
        if(existing.root_dev!==null&&existing.root_ino!==null&&
           (existing.root_dev!==identity.dev||existing.root_ino!==identity.ino)) {
          fail(409,'PROJECT_ROOT_REPLACED','Registered project root directory at this path was replaced on disk.');
        }
        if(existing.label===label&&existing.revision===revision) {
          return Object.freeze({created:false,project:rowToProject(existing)});
        }
        fail(409,'PROJECT_ROOT_CONFLICT','This local root is already registered under a different project record.');
      }
      const id=this.nonce();
      normalizeProjectId(id);
      const nowIso=this.#nowIso();
      this.db.prepare(
        `INSERT INTO workspace_projects (id,label,root,root_dev,root_ino,revision,is_default,created_at,updated_at)
         VALUES (?,?,?,?,?,?,0,?,?)`
      ).run(id,label,root,identity.dev,identity.ino,revision,nowIso,nowIso);
      return Object.freeze({
        created:true,
        project:rowToProject({
          id,
          label,
          root,
          root_dev:identity.dev,
          root_ino:identity.ino,
          revision,
          is_default:0,
          created_at:nowIso,
          updated_at:nowIso,
        }),
      });
    });
  }

  updateRevision(id,revision) {
    normalizeProjectId(id);
    const nextRevision=normalizeRevision(revision);
    return this.transaction(()=>{
      const existing=this.db.prepare(
        'SELECT id,label,root,root_dev,root_ino,revision,is_default,created_at,updated_at FROM workspace_projects WHERE id=?'
      ).get(id);
      if(!existing)fail(404,'PROJECT_NOT_FOUND','Project not found.');
      const nowIso=this.#nowIso();
      this.db.prepare('UPDATE workspace_projects SET revision=?,updated_at=? WHERE id=?').run(nextRevision,nowIso,id);
      return rowToProject({...existing,revision:nextRevision,updated_at:nowIso});
    });
  }

  associateTask(task) {
    if(!isPlainObject(task))fail(400,'INVALID_TASK','A valid task record is required.');
    const projectId=task.projectId===undefined||task.projectId===null?DEFAULT_PROJECT_ID:normalizeProjectId(task.projectId);
    this.requireProject(projectId);
    return {...task,projectId};
  }

  approvedRoots(projectId=DEFAULT_PROJECT_ID) {
    const project=this.requireProject(projectId);
    return Object.freeze(project.root?[project.root]:[]);
  }
}
