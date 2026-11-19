import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {digest} from './runner-lifecycle.mjs';
import {
  APPROVED_FIXTURE_FILES,
  assertSafeFixtureRelativePath,
  buildCandidatePatch,
  computeSortedFileDigests,
  validatePatchAllowlist,
  verifyAndBindPatch,
} from './verified-patch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GIT_BIN = process.platform === 'win32' ? 'git.exe' : 'git';
const NULL_DEV = process.platform === 'win32' ? 'NUL' : '/dev/null';

const BASE_FILES = Object.freeze({
  'limits.py': readFileSync(join(HERE, 'fixtures', 'limits.py'), 'utf8'),
  'measurement.py': readFileSync(join(HERE, 'fixtures', 'measurement.py'), 'utf8'),
});

const CANDIDATE_FILES = Object.freeze({
  'limits.py': 'def clamp(value):\n    if value < 0:\n        return 0\n    if value > 100:\n        return 100\n    return value\n',
  'measurement.py': 'from limits import clamp\n\n\ndef normalize(raw):\n    try:\n        return clamp(int(raw))\n    except (TypeError, ValueError):\n        return 0\n',
});

const CASES_DIGEST = digest([
  ['clamp', -8, 0], ['clamp', 0, 0], ['clamp', 56, 56], ['clamp', 100, 100], ['clamp', 164, 100],
  ['normalize', '-12', 0], ['normalize', ' 42 ', 42], ['normalize', '150', 100], ['normalize', 75, 75],
  ['normalize', 'bad', 0], ['normalize', null, 0], ['normalize', '', 0],
]);

function git(cwd, args) {
  return execFileSync(GIT_BIN, ['--no-optional-locks', `-c`, `core.hooksPath=${NULL_DEV}`,
    '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.symlinks=false', ...args], {
    cwd, encoding: 'utf8', windowsHide: true,
    env: {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_DEV, GIT_TERMINAL_PROMPT: '0'},
  });
}

function withScratch(fn) {
  const root = mkdtempSync(join(tmpdir(), 'vp-unit-'));
  const baseRepoDir = join(root, 'base-repo');
  const helperScratch = join(root, 'scratch');
  mkdirSync(baseRepoDir);
  mkdirSync(helperScratch);
  for (const name of APPROVED_FIXTURE_FILES) writeFileSync(join(baseRepoDir, name), BASE_FILES[name], 'utf8');
  git(baseRepoDir, ['init', '--quiet', '--initial-branch=pilot', '--template=']);
  git(baseRepoDir, ['add', '--', ...APPROVED_FIXTURE_FILES]);
  git(baseRepoDir, ['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '--no-verify', '-m', 'Baseline']);
  const baseRevision = git(baseRepoDir, ['rev-parse', 'HEAD']).trim();
  const baseDigests = computeSortedFileDigests(BASE_FILES);
  const claimId = 'claim-20261118-001';
  const claim = {
    claimId,
    scopeHash: digest({claimId, baseRevision, baseFileDigests: baseDigests.fileDigests, casesDigest: CASES_DIGEST}),
    baseRevision,
    baseFileDigests: baseDigests.fileDigests,
  };
  try {
    return fn({root, baseRepoDir, baseRevision, baseDigests, claim, helperScratch});
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

const makeVerification = (claimId, baseRevision, d) => ({
  trusted: true, passed: true, claimId, baseRevision, casesDigest: CASES_DIGEST,
  totalCases: 12, passedCases: 12, failures: [], fileDigests: d.fileDigests, treeSha256: d.treeSha256,
});

test('stable sorted digests reject missing or extra keys', () => {
  const a = computeSortedFileDigests({'limits.py': CANDIDATE_FILES['limits.py'], 'measurement.py': CANDIDATE_FILES['measurement.py']});
  const b = computeSortedFileDigests({'measurement.py': CANDIDATE_FILES['measurement.py'], 'limits.py': CANDIDATE_FILES['limits.py']});
  assert.deepEqual(Object.keys(b.fileDigests), ['limits.py', 'measurement.py']);
  assert.deepEqual(a.fileDigests, b.fileDigests);
  assert.equal(a.treeSha256, b.treeSha256);
  assert.throws(() => computeSortedFileDigests({'limits.py': CANDIDATE_FILES['limits.py']}));
  assert.throws(() => computeSortedFileDigests({...CANDIDATE_FILES, 'extra.py': 'x = 1\n'}));
});

test('reproduces exact checked bytes from isolated disposable base without mutating base repo', () => {
  withScratch(({baseRepoDir, baseRevision, baseDigests, claim, helperScratch}) => {
    const candDigests = computeSortedFileDigests(CANDIDATE_FILES);
    const built = buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles: CANDIDATE_FILES, scratchRoot: helperScratch});
    const bound = verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, patch: built.patch, candidateFiles: CANDIDATE_FILES,
      verification: makeVerification(claim.claimId, baseRevision, candDigests),
      requireAllFilesChanged: true, scratchRoot: helperScratch,
    });
    assert.equal(bound.status, 'verified-patch');
    assert.deepEqual(bound.baseFileDigests, baseDigests.fileDigests);
    assert.deepEqual(bound.fileDigests, candDigests.fileDigests);
    assert.equal(bound.treeSha256, candDigests.treeSha256);
    assert.equal(bound.patchSha256, built.patchSha256);
    assert.equal(bound.baseUnchanged, true);
    assert.equal(bound.reproducedFromDisposableBase, true);
    assert.equal(git(baseRepoDir, ['status', '--porcelain']), '');
    assert.deepEqual(readdirSync(helperScratch), []);
  });
});

test('rejects changed revision, patch/candidate mismatch, and single-file-only patch when both required', () => {
  withScratch(({baseRepoDir, baseRevision, claim, helperScratch}) => {
    const candDigests = computeSortedFileDigests(CANDIDATE_FILES);
    const built = buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles: CANDIDATE_FILES, scratchRoot: helperScratch});
    const verification = makeVerification(claim.claimId, baseRevision, candDigests);

    assert.throws(() => verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, verification, patch: built.patch.replace('return 100', 'return 99'), scratchRoot: helperScratch,
    }), /Reproduced raw bytes mismatch/);

    assert.throws(() => verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, verification, patch: built.patch,
      candidateFiles: {...CANDIDATE_FILES, 'measurement.py': CANDIDATE_FILES['measurement.py'] + '# swapped\n'},
      scratchRoot: helperScratch,
    }), /Candidate digest mismatch/);

    const oneFile = {'limits.py': CANDIDATE_FILES['limits.py'], 'measurement.py': BASE_FILES['measurement.py']};
    const onePatch = buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles: oneFile, scratchRoot: helperScratch});
    assert.throws(() => verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, patch: onePatch.patch, requireAllFilesChanged: true,
      verification: makeVerification(claim.claimId, baseRevision, computeSortedFileDigests(oneFile)),
      scratchRoot: helperScratch,
    }), /modify both approved/);

    writeFileSync(join(baseRepoDir, 'limits.py'), 'def clamp(value):\n    return value\n# moved\n', 'utf8');
    git(baseRepoDir, ['add', 'limits.py']);
    git(baseRepoDir, ['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '--no-verify', '-m', 'Advance']);
    const moved = git(baseRepoDir, ['rev-parse', 'HEAD']).trim();
    assert.throws(() => verifyAndBindPatch({baseRepoDir, baseRevision, claim, verification, patch: built.patch, scratchRoot: helperScratch}), /Base revision changed/);
    assert.throws(() => verifyAndBindPatch({baseRepoDir, baseRevision: moved, claim, verification, patch: built.patch, scratchRoot: helperScratch}), /claim binding/);
    assert.throws(() => verifyAndBindPatch({
      baseRepoDir, baseRevision: moved,
      claim: {claimId: claim.claimId, scopeHash: claim.scopeHash, baseRevision: moved},
      verification, patch: built.patch, scratchRoot: helperScratch,
    }), /verifier evidence/);
  });
});

test('rejects extra files, dirty base, forbidden patch directives, and missing/invalid verifier evidence', () => {
  withScratch(({baseRepoDir, baseRevision, claim, helperScratch}) => {
    const candDigests = computeSortedFileDigests(CANDIDATE_FILES);
    const built = buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles: CANDIDATE_FILES, scratchRoot: helperScratch});
    const okVer = makeVerification(claim.claimId, baseRevision, candDigests);

    for (const badPatch of [
      built.patch + 'diff --git a/extra.py b/extra.py\nnew file mode 100644\n--- /dev/null\n+++ b/extra.py\n@@ -0,0 +1 @@\n+x=1\n',
      'diff --git a/limits.py b/extra.py\n--- a/limits.py\n+++ b/extra.py\n@@ -1 +1 @@\n-a\n+b\n',
      'diff --git a/limits.py b/limits.py\nold mode 100644\nnew mode 120000\n',
      'diff --git a/limits.py b/limits.py\nGIT binary patch\nliteral 0\n',
    ]) {
      assert.throws(() => validatePatchAllowlist(badPatch));
      assert.throws(() => verifyAndBindPatch({baseRepoDir, baseRevision, claim, verification: okVer, patch: badPatch, scratchRoot: helperScratch}));
    }

    for (const badVer of [
      undefined, null, {...okVer, trusted: false}, {...okVer, passed: false},
      {...okVer, claimId: 'other'}, {...okVer, passedCases: 11}, {...okVer, failures: [2]},
      {...okVer, treeSha256: '0'.repeat(64)},
    ]) {
      assert.throws(() => verifyAndBindPatch({baseRepoDir, baseRevision, claim, verification: badVer, patch: built.patch, scratchRoot: helperScratch}));
    }

    writeFileSync(join(baseRepoDir, 'extra.txt'), 'untracked\n', 'utf8');
    assert.throws(() => verifyAndBindPatch({baseRepoDir, baseRevision, claim, verification: okVer, patch: built.patch, scratchRoot: helperScratch}), /clean/);
  });
});

test('enforces Windows path safety and isolates against ambient base hooks and autocrlf', () => {
  for (const unsafe of ['', '../limits.py', 'sub\\limits.py', 'C:limits.py', 'limits.py:ADS', '/limits.py', 'CON', 'nul.py', 'limits.py.', '-limits.py', 'limits.py\0']) {
    assert.throws(() => assertSafeFixtureRelativePath(unsafe));
  }
  withScratch(({root, baseRepoDir, baseRevision, claim, helperScratch}) => {
    const marker = join(root, 'hook-ran.txt');
    const hooksDir = join(baseRepoDir, '.git', 'hooks');
    mkdirSync(hooksDir, {recursive: true});
    for (const hook of ['post-checkout', 'pre-applypatch', 'applypatch-msg', 'pre-commit']) {
      writeFileSync(join(hooksDir, hook), `#!/bin/sh\necho x > "${marker.replace(/\\/g, '/')}"\nexit 1\n`, {mode: 0o755});
    }
    execFileSync(GIT_BIN, ['config', '--local', 'core.autocrlf', 'true'], {cwd: baseRepoDir, windowsHide: true});
    execFileSync(GIT_BIN, ['config', '--local', 'core.hooksPath', hooksDir], {cwd: baseRepoDir, windowsHide: true});

    const candDigests = computeSortedFileDigests(CANDIDATE_FILES);
    const built = buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles: CANDIDATE_FILES, scratchRoot: helperScratch});
    const bound = verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, patch: built.patch,
      verification: makeVerification(claim.claimId, baseRevision, candDigests),
      scratchRoot: helperScratch,
    });
    assert.equal(existsSync(marker), false);
    assert.deepEqual(bound.fileDigests, candDigests.fileDigests);
  });
});
