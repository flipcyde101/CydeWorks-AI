import {createHash,randomUUID} from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import {isAbsolute,join,parse,resolve} from 'node:path';

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

// Directory identity is the on-disk (dev, ino) pair. Path strings are never case-folded:
// Windows supports per-directory case sensitivity, so two spellings that differ only by
// case can name different directories.
function sameIdentity(a,b) {
  return a!==null&&b!==null&&a.dev===b.dev&&a.ino===b.ino;
}

const PROJECT_ROOT_CODES=Object.freeze({
  syntax:'INVALID_PROJECT_ROOT',
  label:'local project root path',
  missing:'PROJECT_ROOT_MISSING',
  symlink:'PROJECT_ROOT_SYMLINK',
  notDirectory:'PROJECT_ROOT_NOT_DIRECTORY',
  filesystemRoot:'PROJECT_ROOT_FILESYSTEM_ROOT',
});

const APPROVED_ROOT_CODES=Object.freeze({
  syntax:'INVALID_APPROVED_ROOTS',
  label:'approved root path',
  missing:'APPROVED_ROOT_MISSING',
  symlink:'APPROVED_ROOT_SYMLINK',
  notDirectory:'APPROVED_ROOT_NOT_DIRECTORY',
  filesystemRoot:'APPROVED_ROOT_OUTSIDE_PROJECT',
});

function splitPath(absolutePath) {
  const root=parse(absolutePath).root;
  return {root,segments:absolutePath.slice(root.length).split(/[\\/]+/).filter(Boolean)};
}

// lstat every component from the filesystem root down. Symbolic links, junctions and
// mount-point reparse points are rejected by their actual on-disk type, not by comparing
// a resolved path string with the requested one.
function lstatDirectoryChain(absolutePath,codes,errStatus) {
  const {root,segments}=splitPath(absolutePath);
  const chain=[];
  let cursor=root;
  for(const segment of segments) {
    cursor=join(cursor,segment);
    let st;
    try {
      st=lstatSync(cursor,{bigint:true});
    } catch {
      fail(errStatus,codes.missing,'The selected '+codes.label+' does not exist.');
    }
    if(st.isSymbolicLink()) {
      fail(errStatus,codes.symlink,'The '+codes.label+' cannot be or traverse a symbolic link or junction.');
    }
    if(!st.isDirectory()) {
      fail(errStatus,codes.notDirectory,'The '+codes.label+' must be a directory.');
    }
    chain.push({path:cursor,dev:st.dev,ino:st.ino});
  }
  return chain;
}

function canonicalDirectory(rawPath,codes,errStatus) {
  validateLocalPathSyntax(rawPath,codes.syntax,codes.label);
  const resolved=resolve(rawPath);
  if(parse(resolved).root===resolved) {
    fail(errStatus,codes.filesystemRoot,'Choose a project directory rather than a filesystem root.');
  }
  const requestedChain=lstatDirectoryChain(resolved,codes,errStatus);
  let canonical;
  try {
    // The native call returns the on-disk spelling, including actual letter case on Windows.
    canonical=realpathSync.native(resolved);
  } catch {
    fail(errStatus,codes.missing,'The selected '+codes.label+' could not be resolved.');
  }
  validateLocalPathSyntax(canonical,codes.syntax,codes.label);
  if(parse(canonical).root===canonical) {
    fail(errStatus,codes.filesystemRoot,'Choose a project directory rather than a filesystem root.');
  }
  const chain=lstatDirectoryChain(canonical,codes,errStatus);
  if(!sameIdentity(requestedChain.at(-1),chain.at(-1))) {
    fail(errStatus,codes.symlink,'The '+codes.label+' resolves to a different directory than requested.');
  }
  return {path:canonical,chain,dev:chain.at(-1).dev,ino:chain.at(-1).ino};
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
  return canonicalDirectory(rawRoot,PROJECT_ROOT_CODES,useTime?409:400).path;
}

/**
 * Containment is decided by directory identity, never by comparing or case-folding path
 * strings. Both paths are canonicalized to link-free on-disk spellings, then the candidate's
 * actual ancestor chain must contain the project root's (dev, ino) at exactly the project's
 * canonical spelling. This stays correct for Windows case-sensitive directories, where
 * `C:\x\proj` and `C:\x\PROJ` can be different directories.
 */
export function verifyContainedRoot(projectRoot,candidateRoot,{useTime=false}={}) {
  const errStatus=useTime?409:400;
  validateLocalPathSyntax(candidateRoot,APPROVED_ROOT_CODES.syntax,APPROVED_ROOT_CODES.label);
  if(typeof projectRoot!=='string'||!projectRoot) {
    fail(errStatus,'APPROVED_ROOT_OUTSIDE_PROJECT','Project has no registered local root for approved filesystem paths.');
  }
  const project=canonicalDirectory(projectRoot,PROJECT_ROOT_CODES,errStatus);
  const candidate=canonicalDirectory(candidateRoot,APPROVED_ROOT_CODES,errStatus);
  const ancestor=candidate.chain.find(entry=>sameIdentity(entry,project));
  if(!ancestor||ancestor.path!==project.path) {
    fail(errStatus,'APPROVED_ROOT_OUTSIDE_PROJECT','Approved root must be inside the registered project root.');
  }
  return candidate.path;
}

export function captureProjectRootIdentity(projectRoot,{useTime=false}={}) {
  const canonical=canonicalDirectory(projectRoot,PROJECT_ROOT_CODES,useTime?409:400);
  return Object.freeze({
    path:canonical.path,
    dev:String(canonical.dev),
    ino:String(canonical.ino),
  });
}

function readPinnedFile(fullPath,expected,errStatus) {
  let fd;
  try {
    // O_NOFOLLOW is POSIX-only; Windows has no equivalent flag through node:fs.
    fd=openSync(fullPath,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW??0));
  } catch {
    fail(errStatus,'APPROVED_ROOT_UNREADABLE','Approved root file could not be read for snapshot verification.');
  }
  try {
    let st;
    try {
      st=fstatSync(fd,{bigint:true});
    } catch {
      fail(errStatus,'APPROVED_ROOT_UNREADABLE','Approved root file could not be inspected for snapshot verification.');
    }
    if(!st.isFile()||st.dev!==expected.dev||st.ino!==expected.ino||st.size!==expected.size) {
      fail(errStatus,'APPROVED_ROOT_CHANGED','Approved root entry changed while its snapshot was being read.');
    }
    let data;
    try {
      data=readFileSync(fd);
    } catch {
      fail(errStatus,'APPROVED_ROOT_UNREADABLE','Approved root file could not be read for snapshot verification.');
    }
    if(BigInt(data.length)!==expected.size) {
      fail(errStatus,'APPROVED_ROOT_CHANGED','Approved root entry changed while its snapshot was being read.');
    }
    return data;
  } finally {
    closeSync(fd);
  }
}

export function captureDirectoryIdentity(
  rawDir,
  {useTime=false,maxEntries=DEFAULT_ROOT_MAX_ENTRIES,maxBytes=DEFAULT_ROOT_MAX_BYTES}={}
) {
  const errStatus=useTime?409:400;
  const rootDir=canonicalDirectory(rawDir,APPROVED_ROOT_CODES,errStatus);
  const canonical=rootDir.path;

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
        realEntry=realpathSync.native(fullPath);
      } catch {
        fail(errStatus,'APPROVED_ROOT_UNREADABLE','Approved root entry could not be resolved.');
      }
      // fullPath joins the canonical on-disk root with readdir names, so an exact match is
      // expected; any difference means a reparse point or alias that lstat did not report.
      if(realEntry!==fullPath) {
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
        // Reads through an fd whose identity must match the lstat result. This narrows, but
        // does not close, the pathname check-to-use window: node:fs has no openat, so an
        // ancestor directory swapped between checks is not handle-pinned.
        const fileDigest=createHash('sha256').update(readPinnedFile(fullPath,lst,errStatus)).digest('hex');
        treeHash.update(`F:${relPath}\0${size}\0${fileDigest}\0`);
      } else {
        fail(errStatus,'INVALID_APPROVED_ROOT_ENTRY','Approved root contains an unsupported filesystem entry.');
      }
    }
  };

  walk(canonical,'');
  return Object.freeze({
    path:canonical,
    dev:String(rootDir.dev),
    ino:String(rootDir.ino),
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
    if(identity.path!==expectedIdentity.path||
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

function rootIdentityState(row) {
  if(row.root===null)return 'none';
  return row.root_dev!==null&&row.root_dev!==undefined&&row.root_ino!==null&&row.root_ino!==undefined
    ?'bound'
    :'unverified';
}

function rowToProject(row) {
  return Object.freeze({
    id:row.id,
    label:row.label,
    root:row.root,
    rootDev:row.root_dev??null,
    rootIno:row.root_ino??null,
    rootIdentityState:rootIdentityState(row),
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

  /**
   * Rows migrated from schemas without root_dev/root_ino never recorded which directory
   * they named, so the current directory at that path cannot be trusted implicitly. Such
   * rows fail closed until an owner calls revalidateProjectRoot.
   */
  verifyProjectRootIdentity(project,{useTime=false}={}) {
    if(!project||project.root===null)return null;
    if(project.rootDev===null||project.rootIno===null) {
      fail(
        409,
        'PROJECT_ROOT_IDENTITY_UNVERIFIED',
        'Registered project root has no recorded directory identity. Revalidate the project root before use.'
      );
    }
    const current=captureProjectRootIdentity(project.root,{useTime});
    if(current.dev!==project.rootDev||current.ino!==project.rootIno) {
      fail(409,'PROJECT_ROOT_REPLACED','Registered project root directory identity changed on disk.');
    }
    if(current.path!==project.root) {
      fail(
        409,
        'PROJECT_ROOT_IDENTITY_UNVERIFIED',
        'Registered project root spelling is not its canonical on-disk path. Revalidate the project root before use.'
      );
    }
    return current;
  }

  #identityConflict(identity,excludeId) {
    const bound=this.db.prepare(
      'SELECT id FROM workspace_projects WHERE root_dev=? AND root_ino=? AND id IS NOT ?'
    ).get(identity.dev,identity.ino,excludeId);
    if(bound)return bound.id;
    const unbound=this.db.prepare(
      'SELECT id,root FROM workspace_projects WHERE root IS NOT NULL AND (root_dev IS NULL OR root_ino IS NULL) AND id IS NOT ?'
    ).all(excludeId);
    for(const row of unbound) {
      let other;
      try {
        other=captureProjectRootIdentity(row.root);
      } catch {
        continue;
      }
      if(other.dev===identity.dev&&other.ino===identity.ino)return row.id;
    }
    return null;
  }

  /**
   * Explicit owner re-confirmation for a row that lacks a recorded root identity or whose
   * stored spelling is not canonical. The owner supplies the root path and the revision they
   * reviewed; both must match the stored record, and the path must resolve link-free to the
   * same directory the stored root names now. This re-anchors trust at the moment of owner
   * confirmation. It cannot prove the directory is the one originally registered, because
   * the legacy row never recorded that identity.
   */
  revalidateProjectRoot(id,input) {
    normalizeProjectId(id);
    if(!isPlainObject(input)||Object.keys(input).some(key=>key!=='root'&&key!=='revision')||
       !Object.hasOwn(input,'root')||!Object.hasOwn(input,'revision')) {
      fail(400,'INVALID_PROJECT_INPUT','Provide only the confirmed root and revision.');
    }
    const confirmedRevision=normalizeRevision(input.revision);
    const confirmed=captureProjectRootIdentity(input.root);
    return this.transaction(()=>{
      const existing=this.db.prepare(
        'SELECT id,label,root,root_dev,root_ino,revision,is_default,created_at,updated_at FROM workspace_projects WHERE id=?'
      ).get(id);
      if(!existing)fail(404,'PROJECT_NOT_FOUND','Project not found.');
      if(existing.root===null) {
        fail(409,'PROJECT_ROOT_CONFLICT','This project has no registered local root to revalidate.');
      }
      if(existing.revision!==confirmedRevision) {
        fail(409,'PROJECT_REVISION_CHANGED','Confirmed revision does not match the registered project revision.');
      }
      const state=rootIdentityState(existing);
      if(state==='bound'&&existing.root===confirmed.path) {
        if(existing.root_dev!==confirmed.dev||existing.root_ino!==confirmed.ino) {
          fail(409,'PROJECT_ROOT_REPLACED','Registered project root directory identity changed on disk.');
        }
        return Object.freeze({revalidated:false,project:rowToProject(existing)});
      }
      let stored;
      try {
        stored=captureProjectRootIdentity(existing.root,{useTime:true});
      } catch(error) {
        fail(409,'PROJECT_ROOT_REVALIDATION_FAILED','Registered project root could not be safely resolved: '+(error.code??'UNKNOWN')+'.');
      }
      if(stored.path!==confirmed.path||stored.dev!==confirmed.dev||stored.ino!==confirmed.ino) {
        fail(409,'PROJECT_ROOT_CONFLICT','Confirmed root is not the directory named by the registered project root.');
      }
      if(state==='bound'&&(existing.root_dev!==confirmed.dev||existing.root_ino!==confirmed.ino)) {
        fail(409,'PROJECT_ROOT_REPLACED','Registered project root directory identity changed on disk.');
      }
      const clash=this.db.prepare('SELECT id FROM workspace_projects WHERE root=? AND id!=?').get(confirmed.path,id);
      if(clash||this.#identityConflict(confirmed,id)!==null) {
        fail(409,'PROJECT_ROOT_CONFLICT','This directory is already registered under a different project record.');
      }
      const nowIso=this.#nowIso();
      this.db.prepare(
        'UPDATE workspace_projects SET root=?,root_dev=?,root_ino=?,updated_at=? WHERE id=?'
      ).run(confirmed.path,confirmed.dev,confirmed.ino,nowIso,id);
      return Object.freeze({
        revalidated:true,
        project:rowToProject({
          ...existing,
          root:confirmed.path,
          root_dev:confirmed.dev,
          root_ino:confirmed.ino,
          updated_at:nowIso,
        }),
      });
    });
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
        if(rootIdentityState(existing)!=='bound') {
          fail(
            409,
            'PROJECT_ROOT_IDENTITY_UNVERIFIED',
            'This local root is registered without a recorded directory identity. Revalidate it instead.'
          );
        }
        if(existing.root_dev!==identity.dev||existing.root_ino!==identity.ino) {
          fail(409,'PROJECT_ROOT_REPLACED','Registered project root directory at this path was replaced on disk.');
        }
        if(existing.label===label&&existing.revision===revision) {
          return Object.freeze({created:false,project:rowToProject(existing)});
        }
        fail(409,'PROJECT_ROOT_CONFLICT','This local root is already registered under a different project record.');
      }
      if(this.#identityConflict(identity,null)!==null) {
        fail(409,'PROJECT_ROOT_CONFLICT','This directory is already registered under a different path or project record.');
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
