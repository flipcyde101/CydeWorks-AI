import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute, join, relative, resolve} from 'node:path';
import {digest as jsonOrTextDigest} from './runner-lifecycle.mjs';

export const APPROVED_FIXTURE_FILES = Object.freeze(['limits.py', 'measurement.py']);
const MAX_FILE_BYTES = 8192;
const MAX_PATCH_BYTES = 65536;
const GIT_TIMEOUT_MS = 6000;
const GIT_MAX_BUFFER = 262144;

const HEX_REV_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const CLAIM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CTRL_RE = /[\x00-\x1f\x7f]/;
const WIN_RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SAFE_ENV = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir']);

const GIT_BIN = process.platform === 'win32' ? 'git.exe' : 'git';
const NULL_DEV = process.platform === 'win32' ? 'NUL' : '/dev/null';
const SAFE_GIT_ARGS = [
  '--no-optional-locks',
  '-c', `core.hooksPath=${NULL_DEV}`,
  '-c', 'core.fsmonitor=false',
  '-c', 'core.autocrlf=false',
  '-c', 'core.eol=lf',
  '-c', 'core.symlinks=false',
  '-c', 'core.filemode=false',
  '-c', 'safe.bareRepository=explicit',
  '-c', 'protocol.allow=never',
];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isPlainObj = v => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const rawSha256 = buf => createHash('sha256').update(buf).digest('hex');
const sameHostPath = (a, b) => process.platform === 'win32'
  ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
  : resolve(a) === resolve(b);

export function assertSafeFixtureRelativePath(name) {
  if (typeof name !== 'string' || !name || name.length > 255 || !name.isWellFormed() ||
      CTRL_RE.test(name) || name.includes('\\') || name.includes(':') || name.includes('/') ||
      name.startsWith('-') || name.trim() !== name || name.endsWith('.') ||
      name === '.' || name === '..' || WIN_RESERVED_RE.test(name)) {
    throw Error(`Unsafe fixture path: ${String(name)}`);
  }
  return name;
}

function assertSafeHostDir(dirPath, label) {
  if (typeof dirPath !== 'string' || !dirPath || !dirPath.isWellFormed() ||
      CTRL_RE.test(dirPath) || /^(?:\\\\|\/\/)/.test(dirPath)) {
    throw Error(`${label} must be a safe local directory path.`);
  }
  const resolved = resolve(dirPath);
  if (/^(?:\\\\|\/\/)/.test(resolved)) throw Error(`${label} cannot be a UNC or device path.`);
  const st = lstatSync(resolved);
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error(`${label} must be a non-symlink directory.`);
  const real = realpathSync(resolved);
  if (!sameHostPath(real, resolved)) throw Error(`${label} must not traverse symlinks or junctions.`);
  return real;
}

function readSafeFileBytes(baseDir, name) {
  const safe = assertSafeFixtureRelativePath(name);
  const full = join(baseDir, safe);
  const st = lstatSync(full);
  if (!st.isFile() || st.isSymbolicLink()) throw Error(`Expected regular file for ${safe}.`);
  const realBase = realpathSync(baseDir);
  const realFile = realpathSync(full);
  const rel = relative(
    process.platform === 'win32' ? realBase.toLowerCase() : realBase,
    process.platform === 'win32' ? realFile.toLowerCase() : realFile,
  );
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error(`Path escaped base directory: ${safe}`);
  const bytes = readFileSync(realFile);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES || bytes.includes(0)) {
    throw Error(`Invalid or out-of-bounds file bytes for ${safe}.`);
  }
  return bytes;
}

function toBytes(name, value) {
  let bytes;
  if (typeof value === 'string') {
    if (!value.isWellFormed() || value.includes('\0')) throw Error(`Invalid text content for ${name}.`);
    bytes = Buffer.from(value, 'utf8');
  } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    bytes = Buffer.from(value);
    if (bytes.includes(0)) throw Error(`NUL byte rejected in ${name}.`);
  } else {
    throw Error(`Unsupported content type for ${name}.`);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES || !bytes.toString('utf8').trim()) {
    throw Error(`File byte length out of bounds for ${name}.`);
  }
  return bytes;
}

export function computeSortedFileDigests(files) {
  if (!isPlainObj(files)) throw Error('Files map must be a plain object.');
  const keys = Object.keys(files).sort(cmp);
  if (keys.join('\0') !== APPROVED_FIXTURE_FILES.join('\0')) {
    throw Error(`Files must match exact allowlist (${APPROVED_FIXTURE_FILES.join(', ')}).`);
  }
  const fileDigests = {};
  const fileBytes = {};
  for (const name of APPROVED_FIXTURE_FILES) {
    const bytes = toBytes(name, files[name]);
    fileBytes[name] = bytes;
    fileDigests[name] = rawSha256(bytes);
  }
  const treeSha256 = jsonOrTextDigest(APPROVED_FIXTURE_FILES.map(name => [name, fileDigests[name]]));
  return {files: APPROVED_FIXTURE_FILES, fileDigests: Object.freeze(fileDigests), treeSha256, fileBytes};
}

function normalizeDigestMap(map, label) {
  if (!isPlainObj(map) || Object.keys(map).sort(cmp).join('\0') !== APPROVED_FIXTURE_FILES.join('\0')) {
    throw Error(`${label} must match exact two-file allowlist.`);
  }
  const out = {};
  for (const name of APPROVED_FIXTURE_FILES) {
    if (typeof map[name] !== 'string' || !HEX_SHA256_RE.test(map[name])) {
      throw Error(`${label}[${name}] must be a lowercase 64-char SHA-256 hex digest.`);
    }
    out[name] = map[name];
  }
  return Object.freeze(out);
}

function runGit(args, {cwd, input, encoding = 'utf8'} = {}) {
  if (args.some(a => typeof a !== 'string' || CTRL_RE.test(a))) throw Error('Unsafe Git argument.');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => SAFE_ENV.has(k.toLowerCase()) && typeof v === 'string'),
  );
  return execFileSync(GIT_BIN, [...SAFE_GIT_ARGS, ...args], {
    cwd, input, encoding, windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER,
    env: {...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_DEV,
      GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '', GIT_ASKPASS: '', LC_ALL: 'C', LANG: 'C'},
  });
}

export function validatePatchAllowlist(patch) {
  if (typeof patch !== 'string' || !patch || !patch.isWellFormed() || patch.includes('\0') ||
      Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
    throw Error('Patch must be a bounded, non-empty UTF-8 string.');
  }
  const touched = new Set();
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^\s"]+) b\/([^\s"]+)$/.exec(line);
      if (!m || m[1] !== m[2] || !APPROVED_FIXTURE_FILES.includes(assertSafeFixtureRelativePath(m[1]))) {
        throw Error(`Patch targets unapproved or mismatched path: ${line}`);
      }
      if (touched.has(m[1])) throw Error(`Duplicate diff section for ${m[1]}.`);
      touched.add(m[1]);
    } else if (/^(?:GIT binary patch|Binary files |rename (?:from|to) |copy (?:from|to) |new file mode |deleted file mode |old mode |new mode )/.test(line) ||
               /^index .* (?:120000|160000)$/.test(line) || line === '--- /dev/null' || line === '+++ /dev/null') {
      throw Error(`Forbidden patch directive: ${line}`);
    }
  }
  if (touched.size === 0) throw Error('Patch must target at least one approved fixture file.');
  return {filesTouched: Object.freeze([...touched].sort(cmp)), patchSha256: jsonOrTextDigest(patch)};
}

function inspectBaseRepo(baseRepoDir, expectedRev) {
  const realDir = assertSafeHostDir(baseRepoDir, 'baseRepoDir');
  if (runGit(['rev-parse', '--is-inside-work-tree'], {cwd: realDir}).trim() !== 'true') {
    throw Error('baseRepoDir must be a Git working tree.');
  }
  if (!sameHostPath(runGit(['rev-parse', '--show-toplevel'], {cwd: realDir}).trim(), realDir)) {
    throw Error('baseRepoDir must be the exact repository root.');
  }
  const head = runGit(['rev-parse', '--verify', 'HEAD^{commit}'], {cwd: realDir}).trim();
  if (head !== expectedRev) throw Error(`Base revision changed (expected ${expectedRev}, got ${head}).`);
  if (runGit(['status', '--porcelain', '-z', '--untracked-files=all', '--ignored=matching'], {cwd: realDir, encoding: 'buffer'}).byteLength !== 0) {
    throw Error('Base repository working tree must be clean.');
  }
  if (readdirSync(realDir).sort(cmp).join('\0') !== ['.git', ...APPROVED_FIXTURE_FILES].sort(cmp).join('\0')) {
    throw Error('Base repository contains unexpected entries.');
  }
  const tree = runGit(['ls-tree', '-r', '-z', '--full-tree', expectedRev], {cwd: realDir, encoding: 'buffer'}).toString('utf8');
  const treeFiles = tree.split('\0').filter(Boolean).map(entry => {
    const m = /^(100644|100755) blob [0-9a-f]{40,64}\t(.+)$/.exec(entry);
    if (!m) throw Error(`Unsupported Git tree entry: ${entry}`);
    return assertSafeFixtureRelativePath(m[2]);
  }).sort(cmp);
  if (treeFiles.join('\0') !== APPROVED_FIXTURE_FILES.join('\0')) {
    throw Error('Base revision tree must contain exactly the two approved files.');
  }
  const baseFiles = {};
  for (const name of APPROVED_FIXTURE_FILES) {
    const disk = readSafeFileBytes(realDir, name);
    const blob = runGit(['cat-file', 'blob', `${expectedRev}:${name}`], {cwd: realDir, encoding: 'buffer'});
    if (!disk.equals(blob)) throw Error(`Base file bytes differ from committed revision for ${name}.`);
    baseFiles[name] = disk;
  }
  return {baseFiles, ...computeSortedFileDigests(baseFiles)};
}

function initDisposableCopy(dir, baseFiles) {
  mkdirSync(dir, {recursive: false});
  for (const name of APPROVED_FIXTURE_FILES) writeFileSync(join(dir, name), baseFiles[name], {flag: 'wx'});
  runGit(['init', '--quiet', '--initial-branch=disposable-base', '--template='], {cwd: dir});
  runGit(['add', '--', ...APPROVED_FIXTURE_FILES], {cwd: dir});
  runGit(['-c', 'user.name=Disposable Verifier', '-c', 'user.email=verifier@example.invalid',
    'commit', '--quiet', '--no-verify', '-m', 'Disposable base copy'], {cwd: dir});
}

function makeScratch(scratchRoot) {
  const parent = scratchRoot === undefined ? realpathSync(tmpdir()) : assertSafeHostDir(scratchRoot, 'scratchRoot');
  return mkdtempSync(join(parent, 'verified-patch-'));
}

export function buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles, scratchRoot}) {
  if (typeof baseRevision !== 'string' || !HEX_REV_RE.test(baseRevision)) throw Error('Invalid baseRevision commit SHA.');
  const cand = computeSortedFileDigests(candidateFiles);
  const base = inspectBaseRepo(baseRepoDir, baseRevision);
  const scratch = makeScratch(scratchRoot);
  try {
    const dir = join(scratch, 'diff-base');
    initDisposableCopy(dir, base.baseFiles);
    for (const name of APPROVED_FIXTURE_FILES) writeFileSync(join(dir, name), cand.fileBytes[name]);
    const patch = runGit(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--full-index', '--', ...APPROVED_FIXTURE_FILES], {cwd: dir});
    const {patchSha256, filesTouched} = validatePatchAllowlist(patch);
    return {patch, patchSha256, filesTouched, fileDigests: cand.fileDigests, treeSha256: cand.treeSha256};
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
}

export function verifyAndBindPatch({
  baseRepoDir,
  baseRevision,
  claim,
  verification,
  patch,
  candidateFiles,
  requireAllFilesChanged = false,
  scratchRoot,
}) {
  if (typeof baseRevision !== 'string' || !HEX_REV_RE.test(baseRevision)) throw Error('Invalid baseRevision commit SHA.');
  const {filesTouched, patchSha256} = validatePatchAllowlist(patch);
  if (requireAllFilesChanged && filesTouched.length !== APPROVED_FIXTURE_FILES.length) {
    throw Error('Patch must modify both approved fixture files.');
  }

  const base = inspectBaseRepo(baseRepoDir, baseRevision);
  if (!isPlainObj(claim) || typeof claim.claimId !== 'string' || !CLAIM_ID_RE.test(claim.claimId) ||
      typeof claim.scopeHash !== 'string' || !HEX_SHA256_RE.test(claim.scopeHash) || claim.baseRevision !== baseRevision) {
    throw Error('Invalid or mismatched claim binding.');
  }
  if (claim.baseFileDigests !== undefined) {
    const claimedBase = normalizeDigestMap(claim.baseFileDigests, 'claim.baseFileDigests');
    for (const name of APPROVED_FIXTURE_FILES) {
      if (claimedBase[name] !== base.fileDigests[name]) throw Error(`Claim base digest mismatch for ${name}.`);
    }
  }

  if (!isPlainObj(verification) || verification.trusted !== true || verification.passed !== true ||
      verification.claimId !== claim.claimId || verification.baseRevision !== baseRevision ||
      typeof verification.casesDigest !== 'string' || !HEX_SHA256_RE.test(verification.casesDigest) ||
      !Number.isSafeInteger(verification.totalCases) || verification.totalCases <= 0 ||
      verification.passedCases !== verification.totalCases ||
      !Array.isArray(verification.failures) || verification.failures.length !== 0) {
    throw Error('Missing or invalid protected verifier evidence.');
  }
  const verifiedDigests = normalizeDigestMap(verification.fileDigests, 'verification.fileDigests');
  const expectedTreeSha = jsonOrTextDigest(APPROVED_FIXTURE_FILES.map(name => [name, verifiedDigests[name]]));
  if (verification.treeSha256 !== expectedTreeSha) throw Error('Verifier treeSha256 mismatch.');

  let expectedRawBytes = null;
  if (candidateFiles !== undefined) {
    const cand = computeSortedFileDigests(candidateFiles);
    for (const name of APPROVED_FIXTURE_FILES) {
      if (cand.fileDigests[name] !== verifiedDigests[name]) throw Error(`Candidate digest mismatch for ${name}.`);
    }
    expectedRawBytes = cand.fileBytes;
  }

  const scratch = makeScratch(scratchRoot);
  let reproduced;
  try {
    const dir = join(scratch, 'base-copy');
    initDisposableCopy(dir, base.baseFiles);
    runGit(['apply', '--check', '--index', '-'], {cwd: dir, input: patch});
    runGit(['apply', '--index', '-'], {cwd: dir, input: patch});

    if (readdirSync(dir).sort(cmp).join('\0') !== ['.git', ...APPROVED_FIXTURE_FILES].sort(cmp).join('\0')) {
      throw Error('Disposable copy contains unexpected files after apply.');
    }
    if (runGit(['ls-files', '-z'], {cwd: dir, encoding: 'buffer'}).toString('utf8').split('\0').filter(Boolean).sort(cmp).join('\0') !== APPROVED_FIXTURE_FILES.join('\0')) {
      throw Error('Disposable copy tracked files changed unexpectedly.');
    }
    for (const rec of runGit(['status', '--porcelain', '-z', '--untracked-files=all', '--ignored=matching'], {cwd: dir, encoding: 'buffer'}).toString('utf8').split('\0').filter(Boolean)) {
      if (rec.slice(0, 2) !== 'M ' || !APPROVED_FIXTURE_FILES.includes(rec.slice(3))) {
        throw Error(`Forbidden change in disposable copy: ${rec}`);
      }
    }
    const rawFiles = Object.fromEntries(APPROVED_FIXTURE_FILES.map(name => [name, readSafeFileBytes(dir, name)]));
    reproduced = computeSortedFileDigests(rawFiles);
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }

  for (const name of APPROVED_FIXTURE_FILES) {
    if (reproduced.fileDigests[name] !== verifiedDigests[name] ||
        (expectedRawBytes && !reproduced.fileBytes[name].equals(expectedRawBytes[name]))) {
      throw Error(`Reproduced raw bytes mismatch for ${name}.`);
    }
    if (requireAllFilesChanged && reproduced.fileDigests[name] === base.fileDigests[name]) {
      throw Error(`Approved file ${name} remained unchanged.`);
    }
  }
  if (reproduced.treeSha256 !== verification.treeSha256) throw Error('Reproduced treeSha256 mismatch.');

  const postBase = inspectBaseRepo(baseRepoDir, baseRevision);
  if (postBase.treeSha256 !== base.treeSha256) throw Error('Base repository changed during verification.');

  return Object.freeze({
    status: 'verified-patch',
    claimId: claim.claimId,
    scopeHash: claim.scopeHash,
    baseRevision,
    baseFileDigests: base.fileDigests,
    baseTreeSha256: base.treeSha256,
    files: APPROVED_FIXTURE_FILES,
    fileDigests: reproduced.fileDigests,
    treeSha256: reproduced.treeSha256,
    patchSha256,
    patchedFiles: filesTouched,
    verification: Object.freeze({
      trusted: true,
      passed: true,
      claimId: claim.claimId,
      baseRevision,
      casesDigest: verification.casesDigest,
      totalCases: verification.totalCases,
      passedCases: verification.passedCases,
    }),
    baseUnchanged: true,
    reproducedFromDisposableBase: true,
  });
}
