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
import {isAbsolute, join, relative, resolve, sep} from 'node:path';

export const APPROVED_FIXTURE_FILES = Object.freeze(['limits.py', 'measurement.py']);
export const MAX_FILE_BYTES = 8192;
export const MAX_PATCH_BYTES = 65536;
export const GIT_TIMEOUT_MS = 6000;
export const GIT_MAX_BUFFER_BYTES = 262144;

const HEX_REVISION_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const CLAIM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const WINDOWS_RESERVED_BASENAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_DEVICE_OR_UNC_RE = /^(?:\\\\|\/\/)/;
const SAFE_ENV_KEYS = new Set([
  'path',
  'pathext',
  'systemroot',
  'windir',
  'comspec',
  'temp',
  'tmp',
  'tmpdir',
]);

const GIT_BIN = process.platform === 'win32' ? 'git.exe' : 'git';
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const SAFE_GIT_FLAGS = Object.freeze([
  '--no-optional-locks',
  '-c',
  `core.hooksPath=${NULL_DEVICE}`,
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.eol=lf',
  '-c',
  'core.symlinks=false',
  '-c',
  'core.filemode=false',
  '-c',
  'safe.bareRepository=explicit',
  '-c',
  'protocol.allow=never',
]);

function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function pathsEqualForHost(a, b) {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isInsideRealDir(realBase, realTarget) {
  const rel = relative(
    process.platform === 'win32' ? realBase.toLowerCase() : realBase,
    process.platform === 'win32' ? realTarget.toLowerCase() : realTarget,
  );
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function sha256Hex(value) {
  const data = typeof value === 'string'
    ? Buffer.from(value, 'utf8')
    : Buffer.isBuffer(value) || value instanceof Uint8Array
      ? value
      : (() => { throw Error('sha256Hex requires string, Buffer, or Uint8Array.'); })();
  return createHash('sha256').update(data).digest('hex');
}

export function computeScopeHash(scope) {
  if (!isPlainObject(scope)) throw Error('Scope must be a plain object.');
  const canonicalize = value => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (isPlainObject(value)) {
      const sorted = {};
      for (const key of Object.keys(value).sort(compareCodeUnits)) {
        if (value[key] !== undefined) sorted[key] = canonicalize(value[key]);
      }
      return sorted;
    }
    return value;
  };
  return sha256Hex(JSON.stringify(canonicalize(scope)));
}

export function assertSafeFixtureRelativePath(filePath) {
  if (
    typeof filePath !== 'string' ||
    filePath.length === 0 ||
    filePath.length > 255 ||
    !filePath.isWellFormed()
  ) {
    throw Error('Fixture path must be a bounded well-formed string.');
  }
  if (
    CONTROL_CHAR_RE.test(filePath) ||
    filePath.includes('\\') ||
    filePath.includes(':') ||
    filePath.startsWith('/') ||
    filePath.endsWith('/') ||
    filePath.startsWith('-') ||
    filePath.trim() !== filePath
  ) {
    throw Error(`Unsafe fixture relative path: ${filePath}`);
  }
  const segments = filePath.split('/');
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.endsWith(' ') ||
      segment.endsWith('.') ||
      WINDOWS_RESERVED_BASENAME_RE.test(segment)
    ) {
      throw Error(`Unsafe fixture path segment in: ${filePath}`);
    }
  }
  return filePath;
}

function normalizeApprovedFiles(approvedFiles = APPROVED_FIXTURE_FILES) {
  if (!Array.isArray(approvedFiles) || approvedFiles.length === 0) {
    throw Error('Approved fixture files list must be a non-empty array.');
  }
  const seen = new Set();
  const seenLower = new Set();
  const validated = approvedFiles.map(name => {
    const safe = assertSafeFixtureRelativePath(name);
    if (seen.has(safe) || seenLower.has(safe.toLowerCase())) {
      throw Error(`Duplicate or case-colliding approved file: ${safe}`);
    }
    seen.add(safe);
    seenLower.add(safe.toLowerCase());
    return safe;
  });
  const sorted = [...validated].sort(compareCodeUnits);
  return Object.freeze(sorted);
}

function assertValidRevision(revision, label = 'baseRevision') {
  if (typeof revision !== 'string' || !HEX_REVISION_RE.test(revision)) {
    throw Error(`${label} must be a lowercase 40- or 64-character Git commit SHA.`);
  }
  return revision;
}

function assertValidSha256(digest, label = 'digest') {
  if (typeof digest !== 'string' || !HEX_SHA256_RE.test(digest)) {
    throw Error(`${label} must be a lowercase 64-character SHA-256 hex digest.`);
  }
  return digest;
}

function assertSafeHostDirectory(dirPath, label) {
  if (
    typeof dirPath !== 'string' ||
    dirPath.length === 0 ||
    !dirPath.isWellFormed() ||
    CONTROL_CHAR_RE.test(dirPath) ||
    WINDOWS_DEVICE_OR_UNC_RE.test(dirPath)
  ) {
    throw Error(`${label} must be a safe local directory path.`);
  }
  const resolved = resolve(dirPath);
  if (WINDOWS_DEVICE_OR_UNC_RE.test(resolved)) {
    throw Error(`${label} cannot be a UNC or device path.`);
  }
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw Error(`${label} must be an existing non-symlink directory.`);
  }
  const real = realpathSync(resolved);
  if (!pathsEqualForHost(real, resolved)) {
    throw Error(`${label} must not traverse symbolic links or junctions.`);
  }
  return real;
}

function readSafeRegularFile(baseDir, relPath) {
  const safeRel = assertSafeFixtureRelativePath(relPath);
  const fullPath = join(baseDir, ...safeRel.split('/'));
  const stat = lstatSync(fullPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw Error(`Expected regular non-symlink file for ${safeRel}.`);
  }
  const realBase = realpathSync(baseDir);
  const realFile = realpathSync(fullPath);
  if (!isInsideRealDir(realBase, realFile)) {
    throw Error(`File path escaped directory boundary: ${safeRel}`);
  }
  const bytes = readFileSync(realFile);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) {
    throw Error(`File size out of bounds for ${safeRel}.`);
  }
  if (bytes.includes(0)) {
    throw Error(`NUL byte rejected in ${safeRel}.`);
  }
  return bytes;
}

function toSafeFileBytes(name, content) {
  let bytes;
  if (typeof content === 'string') {
    if (!content.isWellFormed() || content.includes('\0')) {
      throw Error(`Invalid text content for ${name}.`);
    }
    bytes = Buffer.from(content, 'utf8');
  } else if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
    bytes = Buffer.from(content);
    if (bytes.includes(0)) {
      throw Error(`NUL byte rejected in ${name}.`);
    }
  } else {
    throw Error(`Unsupported file content type for ${name}.`);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) {
    throw Error(`File byte length out of bounds for ${name}.`);
  }
  if (bytes.toString('utf8').trim().length === 0) {
    throw Error(`File content cannot be whitespace-only for ${name}.`);
  }
  return bytes;
}

export function computeSortedFileDigests(files, approvedFiles = APPROVED_FIXTURE_FILES) {
  const approved = normalizeApprovedFiles(approvedFiles);
  if (!isPlainObject(files)) {
    throw Error('Files map must be a plain object.');
  }
  const actualKeys = Object.keys(files).sort(compareCodeUnits);
  if (
    actualKeys.length !== approved.length ||
    actualKeys.some((key, index) => key !== approved[index])
  ) {
    const extra = actualKeys.filter(key => !approved.includes(key));
    const missing = approved.filter(key => !actualKeys.includes(key));
    throw Error(
      `Files must match approved fixture set exactly (extra: ${extra.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}).`,
    );
  }
  const fileDigests = {};
  const fileBytes = {};
  for (const name of approved) {
    const bytes = toSafeFileBytes(name, files[name]);
    fileBytes[name] = bytes;
    fileDigests[name] = sha256Hex(bytes);
  }
  const treeSha256 = sha256Hex(
    JSON.stringify(approved.map(name => [name, fileDigests[name]])),
  );
  return {
    files: Object.freeze(approved.slice()),
    fileDigests: Object.freeze(fileDigests),
    treeSha256,
    fileBytes,
  };
}

function normalizeDigestMap(digestMap, approved, label) {
  if (!isPlainObject(digestMap)) {
    throw Error(`${label} must be a plain object.`);
  }
  const actualKeys = Object.keys(digestMap).sort(compareCodeUnits);
  if (
    actualKeys.length !== approved.length ||
    actualKeys.some((key, index) => key !== approved[index])
  ) {
    const extra = actualKeys.filter(key => !approved.includes(key));
    const missing = approved.filter(key => !actualKeys.includes(key));
    throw Error(
      `${label} must match approved fixture files exactly (extra: ${extra.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}).`,
    );
  }
  const normalized = {};
  for (const name of approved) {
    normalized[name] = assertValidSha256(digestMap[name], `${label}[${name}]`);
  }
  return Object.freeze(normalized);
}

function buildSanitizedGitEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SAFE_ENV_KEYS.has(key.toLowerCase()) && typeof value === 'string') {
      env[key] = value;
    }
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = NULL_DEVICE;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ALLOW_PROTOCOL = '';
  env.GIT_ASKPASS = '';
  env.LC_ALL = 'C';
  env.LANG = 'C';
  return env;
}

function runGit(args, {cwd, input, encoding = 'utf8'} = {}) {
  for (const arg of args) {
    if (typeof arg !== 'string' || CONTROL_CHAR_RE.test(arg)) {
      throw Error('Unsafe Git argument rejected.');
    }
  }
  return execFileSync(GIT_BIN, [...SAFE_GIT_FLAGS, ...args], {
    cwd,
    input,
    encoding,
    env: buildSanitizedGitEnv(),
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  });
}

export function validatePatchText(patch, approvedFiles = APPROVED_FIXTURE_FILES) {
  const approved = normalizeApprovedFiles(approvedFiles);
  const approvedSet = new Set(approved);
  if (
    typeof patch !== 'string' ||
    patch.length === 0 ||
    !patch.isWellFormed() ||
    patch.includes('\0')
  ) {
    throw Error('Patch must be a non-empty well-formed UTF-8 string.');
  }
  const byteLength = Buffer.byteLength(patch, 'utf8');
  if (byteLength > MAX_PATCH_BYTES) {
    throw Error(`Patch exceeded ${MAX_PATCH_BYTES} byte limit.`);
  }

  const lines = patch.split('\n');
  if (lines.length > 0 && lines.at(-1) === '') {
    lines.pop();
  }
  if (lines.length === 0) {
    throw Error('Patch contains no diff lines.');
  }

  let currentFile = null;
  let sawMinus = false;
  let sawPlus = false;
  let sawHunk = false;
  let remainingOld = 0;
  let remainingNew = 0;
  let lastHunkLineType = null;
  const touchedFiles = [];
  const seenFiles = new Set();

  const finishCurrentFile = () => {
    if (currentFile !== null && (!sawMinus || !sawPlus || !sawHunk)) {
      throw Error(`Incomplete diff section for ${currentFile}.`);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (remainingOld > 0 || remainingNew > 0) {
      if (line === '\\ No newline at end of file') {
        if (lastHunkLineType === null) {
          throw Error('Unexpected no-newline marker in patch hunk.');
        }
        lastHunkLineType = null;
        continue;
      }
      const prefix = line[0];
      if (prefix === ' ') {
        if (remainingOld <= 0 || remainingNew <= 0) {
          throw Error('Patch hunk context count mismatch.');
        }
        remainingOld--;
        remainingNew--;
        lastHunkLineType = ' ';
        continue;
      }
      if (prefix === '-') {
        if (remainingOld <= 0) {
          throw Error('Patch hunk deletion count mismatch.');
        }
        remainingOld--;
        lastHunkLineType = '-';
        continue;
      }
      if (prefix === '+') {
        if (remainingNew <= 0) {
          throw Error('Patch hunk addition count mismatch.');
        }
        remainingNew--;
        lastHunkLineType = '+';
        continue;
      }
      throw Error(`Malformed patch hunk line at line ${i + 1}.`);
    }

    if (line === '\\ No newline at end of file' && lastHunkLineType !== null) {
      lastHunkLineType = null;
      continue;
    }

    lastHunkLineType = null;
    if (line.includes('\r')) {
      throw Error(`Carriage return rejected in patch metadata at line ${i + 1}.`);
    }

    if (line.startsWith('diff --git ')) {
      finishCurrentFile();
      const match = /^diff --git a\/([^\s"]+) b\/([^\s"]+)$/.exec(line);
      if (!match || match[1] !== match[2]) {
        throw Error(`Unsafe or mismatched diff --git header: ${line}`);
      }
      const filePath = assertSafeFixtureRelativePath(match[1]);
      if (!approvedSet.has(filePath)) {
        throw Error(`Patch targets unapproved file: ${filePath}`);
      }
      if (seenFiles.has(filePath)) {
        throw Error(`Duplicate diff section for ${filePath}.`);
      }
      seenFiles.add(filePath);
      touchedFiles.push(filePath);
      currentFile = filePath;
      sawMinus = false;
      sawPlus = false;
      sawHunk = false;
      continue;
    }

    if (currentFile === null) {
      throw Error('Patch must begin with a valid diff --git header.');
    }

    if (line.startsWith('index ')) {
      if (sawMinus || sawPlus || sawHunk) {
        throw Error('Unexpected index header after patch body.');
      }
      const indexMatch = /^index [0-9a-f]{4,64}\.\.[0-9a-f]{4,64}(?: (100644|100755))?$/.exec(line);
      if (!indexMatch) {
        throw Error(`Unsupported or unsafe git index header: ${line}`);
      }
      continue;
    }

    if (line.startsWith('--- ')) {
      if (sawMinus || sawPlus || sawHunk) {
        throw Error('Unexpected --- header in patch.');
      }
      if (line !== `--- a/${currentFile}`) {
        throw Error(`Invalid --- header for ${currentFile}: ${line}`);
      }
      sawMinus = true;
      continue;
    }

    if (line.startsWith('+++ ')) {
      if (!sawMinus || sawPlus || sawHunk) {
        throw Error('Unexpected +++ header in patch.');
      }
      if (line !== `+++ b/${currentFile}`) {
        throw Error(`Invalid +++ header for ${currentFile}: ${line}`);
      }
      sawPlus = true;
      continue;
    }

    if (line.startsWith('@@ ')) {
      if (!sawMinus || !sawPlus) {
        throw Error('Patch hunk appeared before ---/+++ headers.');
      }
      const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
      if (!hunkMatch) {
        throw Error(`Malformed hunk header: ${line}`);
      }
      remainingOld = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
      remainingNew = hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]);
      if (!Number.isSafeInteger(remainingOld) || !Number.isSafeInteger(remainingNew)) {
        throw Error('Invalid hunk line counts.');
      }
      sawHunk = true;
      continue;
    }

    throw Error(`Unsupported or forbidden patch metadata line: ${line}`);
  }

  if (remainingOld !== 0 || remainingNew !== 0) {
    throw Error('Truncated patch hunk.');
  }
  finishCurrentFile();
  if (touchedFiles.length === 0) {
    throw Error('Patch did not touch any approved fixture files.');
  }

  return {
    filesTouched: Object.freeze([...touchedFiles].sort(compareCodeUnits)),
    patchSha256: sha256Hex(patch),
  };
}

function inspectBaseRepository(baseRepoDir, expectedRevision, approved) {
  const realBaseDir = assertSafeHostDirectory(baseRepoDir, 'baseRepoDir');
  const inside = runGit(['rev-parse', '--is-inside-work-tree'], {cwd: realBaseDir}).trim();
  if (inside !== 'true') {
    throw Error('baseRepoDir must be a valid Git working tree.');
  }
  const topLevel = runGit(['rev-parse', '--show-toplevel'], {cwd: realBaseDir}).trim();
  if (!pathsEqualForHost(topLevel, realBaseDir)) {
    throw Error('baseRepoDir must be the exact root of the disposable Git repository.');
  }
  const actualRevision = runGit(['rev-parse', '--verify', 'HEAD^{commit}'], {cwd: realBaseDir}).trim();
  if (actualRevision !== expectedRevision) {
    throw Error(
      `Base revision changed or mismatched (expected ${expectedRevision}, got ${actualRevision}).`,
    );
  }

  const statusRaw = runGit(['status', '--porcelain', '-z', '--untracked-files=all', '--ignored=matching'], {
    cwd: realBaseDir,
    encoding: 'buffer',
  });
  if (statusRaw.byteLength !== 0) {
    throw Error('Base repository working tree must be clean with no extra or untracked files.');
  }

  const entries = readdirSync(realBaseDir).sort(compareCodeUnits);
  const expectedTopEntries = Object.freeze([...new Set(['.git', ...approved.map(p => p.split('/')[0])])].sort(compareCodeUnits));
  if (
    entries.length !== expectedTopEntries.length ||
    entries.some((entry, idx) => entry !== expectedTopEntries[idx])
  ) {
    throw Error('Base repository directory contains unexpected entries.');
  }

  const lsTreeRaw = runGit(['ls-tree', '-r', '-z', '--full-tree', expectedRevision], {
    cwd: realBaseDir,
    encoding: 'buffer',
  }).toString('utf8');
  const treeEntries = lsTreeRaw.split('\0').filter(Boolean);
  const treePaths = [];
  for (const entry of treeEntries) {
    const match = /^(100644|100755) blob [0-9a-f]{40,64}\t(.+)$/.exec(entry);
    if (!match) {
      throw Error(`Unsupported Git tree entry in base revision: ${entry}`);
    }
    treePaths.push(assertSafeFixtureRelativePath(match[2]));
  }
  treePaths.sort(compareCodeUnits);
  if (
    treePaths.length !== approved.length ||
    treePaths.some((p, idx) => p !== approved[idx])
  ) {
    throw Error('Base revision tree must contain exactly the approved fixture files.');
  }

  const baseFiles = {};
  for (const name of approved) {
    const diskBytes = readSafeRegularFile(realBaseDir, name);
    const gitBytes = runGit(['cat-file', 'blob', `${expectedRevision}:${name}`], {
      cwd: realBaseDir,
      encoding: 'buffer',
    });
    if (!diskBytes.equals(gitBytes)) {
      throw Error(`Base repository file bytes differ from committed revision for ${name}.`);
    }
    baseFiles[name] = diskBytes;
  }

  const baseDigestInfo = computeSortedFileDigests(baseFiles, approved);
  return {
    realBaseDir,
    actualRevision,
    baseFiles,
    baseFileDigests: baseDigestInfo.fileDigests,
    baseTreeSha256: baseDigestInfo.treeSha256,
  };
}

function materializeDisposableBaseCopy(disposableDir, baseFiles, approved) {
  mkdirSync(disposableDir, {recursive: false});
  for (const name of approved) {
    const targetPath = join(disposableDir, ...name.split('/'));
    writeFileSync(targetPath, baseFiles[name], {flag: 'wx'});
  }
  runGit(['init', '--quiet', '--initial-branch=disposable-base', '--template='], {
    cwd: disposableDir,
  });
  runGit(['add', '--', ...approved], {cwd: disposableDir});
  runGit(
    [
      '-c',
      'user.name=CydeWorks Disposable Verifier',
      '-c',
      'user.email=verifier@example.invalid',
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      'Disposable base copy',
    ],
    {cwd: disposableDir},
  );
}

function createScratchWorkspace(scratchRoot) {
  const parent = scratchRoot === undefined
    ? realpathSync(tmpdir())
    : assertSafeHostDirectory(scratchRoot, 'scratchRoot');
  return mkdtempSync(join(parent, 'verified-patch-'));
}

function validateClaim(claim, expectedRevision, approved, actualBaseDigests) {
  if (!isPlainObject(claim)) {
    throw Error('Claim identity must be a plain object.');
  }
  if (typeof claim.claimId !== 'string' || !CLAIM_ID_RE.test(claim.claimId)) {
    throw Error('claim.claimId must be a bounded non-empty identifier.');
  }
  assertValidSha256(claim.scopeHash, 'claim.scopeHash');
  const claimRevision = assertValidRevision(claim.baseRevision, 'claim.baseRevision');
  if (claimRevision !== expectedRevision) {
    throw Error(
      `Claim baseRevision mismatch (expected ${expectedRevision}, got ${claimRevision}).`,
    );
  }
  if (claim.baseFileDigests !== undefined) {
    const claimedBase = normalizeDigestMap(claim.baseFileDigests, approved, 'claim.baseFileDigests');
    for (const name of approved) {
      if (claimedBase[name] !== actualBaseDigests[name]) {
        throw Error(`Claim baseFileDigests mismatch for ${name}.`);
      }
    }
  }
  return {
    claimId: claim.claimId,
    scopeHash: claim.scopeHash,
    baseRevision: claimRevision,
  };
}

function validateVerificationEvidence(verification, claimId, expectedRevision, approved) {
  if (!isPlainObject(verification)) {
    throw Error('Missing verifier evidence: verification must be a plain object.');
  }
  if (verification.trusted !== true) {
    throw Error('Missing or untrusted verifier evidence (trusted !== true).');
  }
  if (verification.passed !== true) {
    throw Error('Verifier evidence did not pass (passed !== true).');
  }
  if (verification.claimId !== claimId) {
    throw Error('Verifier evidence claimId does not match claim identity.');
  }
  const verifiedRevision = assertValidRevision(verification.baseRevision, 'verification.baseRevision');
  if (verifiedRevision !== expectedRevision) {
    throw Error(
      `Verifier evidence baseRevision changed (expected ${expectedRevision}, got ${verifiedRevision}).`,
    );
  }
  const casesDigest = assertValidSha256(verification.casesDigest, 'verification.casesDigest');
  if (!Number.isSafeInteger(verification.totalCases) || verification.totalCases <= 0) {
    throw Error('Verifier evidence must record a positive totalCases count.');
  }
  if (verification.passedCases !== verification.totalCases) {
    throw Error('Verifier evidence passedCases must equal totalCases.');
  }
  if (!Array.isArray(verification.failures) || verification.failures.length !== 0) {
    throw Error('Verifier evidence failures must be an empty array.');
  }
  const fileDigests = normalizeDigestMap(verification.fileDigests, approved, 'verification.fileDigests');
  const expectedTreeSha256 = sha256Hex(
    JSON.stringify(approved.map(name => [name, fileDigests[name]])),
  );
  const treeSha256 = assertValidSha256(verification.treeSha256, 'verification.treeSha256');
  if (treeSha256 !== expectedTreeSha256) {
    throw Error('Verifier evidence treeSha256 does not match sorted fileDigests.');
  }
  return {
    trusted: true,
    passed: true,
    claimId,
    baseRevision: verifiedRevision,
    casesDigest,
    totalCases: verification.totalCases,
    passedCases: verification.passedCases,
    fileDigests,
    treeSha256,
  };
}

function verifyDisposablePostApplyState(disposableDir, approved) {
  const entries = readdirSync(disposableDir).sort(compareCodeUnits);
  const expectedTopEntries = Object.freeze([...new Set(['.git', ...approved.map(p => p.split('/')[0])])].sort(compareCodeUnits));
  if (
    entries.length !== expectedTopEntries.length ||
    entries.some((entry, idx) => entry !== expectedTopEntries[idx])
  ) {
    throw Error('Disposable copy contains unexpected files after patch application.');
  }

  const lsFilesRaw = runGit(['ls-files', '-z'], {cwd: disposableDir, encoding: 'buffer'}).toString('utf8');
  const tracked = lsFilesRaw.split('\0').filter(Boolean).sort(compareCodeUnits);
  if (tracked.length !== approved.length || tracked.some((p, idx) => p !== approved[idx])) {
    throw Error('Disposable copy tracked files changed unexpectedly after patch application.');
  }

  const statusRaw = runGit(
    ['status', '--porcelain', '-z', '--untracked-files=all', '--ignored=matching'],
    {cwd: disposableDir, encoding: 'buffer'},
  ).toString('utf8');
  const statusRecords = statusRaw.split('\0').filter(Boolean);
  const approvedSet = new Set(approved);
  for (const record of statusRecords) {
    if (record.length < 4 || record[2] !== ' ') {
      throw Error(`Unexpected Git status entry in disposable copy: ${record}`);
    }
    const statusCode = record.slice(0, 2);
    const filePath = record.slice(3);
    if (statusCode !== 'M ' || !approvedSet.has(filePath)) {
      throw Error(`Forbidden change in disposable copy (${statusCode}): ${filePath}`);
    }
  }

  const cachedRaw = runGit(['diff', '--cached', '--name-only', '-z'], {
    cwd: disposableDir,
    encoding: 'buffer',
  }).toString('utf8');
  const cachedFiles = cachedRaw.split('\0').filter(Boolean);
  for (const filePath of cachedFiles) {
    if (!approvedSet.has(filePath)) {
      throw Error(`Patch modified unapproved file in disposable copy: ${filePath}`);
    }
  }

  const reproducedFiles = {};
  for (const name of approved) {
    reproducedFiles[name] = readSafeRegularFile(disposableDir, name);
  }
  return computeSortedFileDigests(reproducedFiles, approved);
}

export function buildCandidatePatch({
  baseRepoDir,
  baseRevision,
  candidateFiles,
  approvedFiles = APPROVED_FIXTURE_FILES,
  scratchRoot,
}) {
  const approved = normalizeApprovedFiles(approvedFiles);
  const expectedRevision = assertValidRevision(baseRevision, 'baseRevision');
  const candidateDigestInfo = computeSortedFileDigests(candidateFiles, approved);
  const baseState = inspectBaseRepository(baseRepoDir, expectedRevision, approved);

  const scratchDir = createScratchWorkspace(scratchRoot);
  try {
    const disposableDir = join(scratchDir, 'diff-base');
    materializeDisposableBaseCopy(disposableDir, baseState.baseFiles, approved);
    for (const name of approved) {
      writeFileSync(join(disposableDir, ...name.split('/')), candidateDigestInfo.fileBytes[name]);
    }
    const patch = runGit(
      ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--full-index', '--', ...approved],
      {cwd: disposableDir, encoding: 'utf8'},
    );
    const validated = validatePatchText(patch, approved);
    return {
      patch,
      patchSha256: validated.patchSha256,
      filesTouched: validated.filesTouched,
      fileDigests: candidateDigestInfo.fileDigests,
      treeSha256: candidateDigestInfo.treeSha256,
    };
  } finally {
    rmSync(scratchDir, {recursive: true, force: true});
  }
}

export function verifyAndBindPatch({
  baseRepoDir,
  baseRevision,
  claim,
  verification,
  patch,
  candidateFiles,
  approvedFiles = APPROVED_FIXTURE_FILES,
  requireAllFilesChanged = false,
  scratchRoot,
}) {
  const approved = normalizeApprovedFiles(approvedFiles);
  const expectedRevision = assertValidRevision(baseRevision, 'baseRevision');
  const validatedPatch = validatePatchText(patch, approved);
  if (requireAllFilesChanged && validatedPatch.filesTouched.length !== approved.length) {
    throw Error('Patch must modify all approved fixture files.');
  }

  const baseState = inspectBaseRepository(baseRepoDir, expectedRevision, approved);
  const boundClaim = validateClaim(claim, expectedRevision, approved, baseState.baseFileDigests);
  const boundVerification = validateVerificationEvidence(
    verification,
    boundClaim.claimId,
    expectedRevision,
    approved,
  );

  if (candidateFiles !== undefined) {
    const candidateDigestInfo = computeSortedFileDigests(candidateFiles, approved);
    for (const name of approved) {
      if (candidateDigestInfo.fileDigests[name] !== boundVerification.fileDigests[name]) {
        throw Error(`Candidate file digest mismatch for ${name} against verifier evidence.`);
      }
    }
    if (candidateDigestInfo.treeSha256 !== boundVerification.treeSha256) {
      throw Error('Candidate treeSha256 mismatch against verifier evidence.');
    }
  }

  const scratchDir = createScratchWorkspace(scratchRoot);
  let reproduced;
  try {
    const disposableDir = join(scratchDir, 'base-copy');
    materializeDisposableBaseCopy(disposableDir, baseState.baseFiles, approved);
    runGit(['apply', '--check', '--index', '-'], {cwd: disposableDir, input: patch});
    runGit(['apply', '--index', '-'], {cwd: disposableDir, input: patch});
    reproduced = verifyDisposablePostApplyState(disposableDir, approved);
  } finally {
    rmSync(scratchDir, {recursive: true, force: true});
  }

  for (const name of approved) {
    if (reproduced.fileDigests[name] !== boundVerification.fileDigests[name]) {
      throw Error(
        `Patched output digest mismatch for ${name} (expected ${boundVerification.fileDigests[name]}, got ${reproduced.fileDigests[name]}).`,
      );
    }
    if (requireAllFilesChanged && reproduced.fileDigests[name] === baseState.baseFileDigests[name]) {
      throw Error(`Approved file ${name} remained identical to base revision.`);
    }
  }
  if (reproduced.treeSha256 !== boundVerification.treeSha256) {
    throw Error('Patched output treeSha256 does not match independently checked bytes.');
  }

  const postBaseState = inspectBaseRepository(baseRepoDir, expectedRevision, approved);
  if (postBaseState.baseTreeSha256 !== baseState.baseTreeSha256) {
    throw Error('Base repository contents changed during patch verification.');
  }

  return Object.freeze({
    status: 'verified-patch',
    claimId: boundClaim.claimId,
    scopeHash: boundClaim.scopeHash,
    baseRevision: expectedRevision,
    baseFileDigests: baseState.baseFileDigests,
    baseTreeSha256: baseState.baseTreeSha256,
    files: approved,
    fileDigests: reproduced.fileDigests,
    treeSha256: reproduced.treeSha256,
    patchSha256: validatedPatch.patchSha256,
    patchedFiles: validatedPatch.filesTouched,
    verification: Object.freeze({
      trusted: true,
      passed: true,
      claimId: boundClaim.claimId,
      baseRevision: expectedRevision,
      casesDigest: boundVerification.casesDigest,
      totalCases: boundVerification.totalCases,
      passedCases: boundVerification.passedCases,
    }),
    baseUnchanged: true,
    reproducedFromDisposableBase: true,
  });
}
