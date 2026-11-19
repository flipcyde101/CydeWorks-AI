import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {claimRun, digest, reconcileClaim} from './runner-lifecycle.mjs';
import {
  APPROVED_FIXTURE_FILES,
  assertSafeFixtureRelativePath,
  buildCandidatePatch,
  buildScope,
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

const APPROVED_CASES = Object.freeze([
  ['clamp', -8, 0], ['clamp', 0, 0], ['clamp', 56, 56], ['clamp', 100, 100], ['clamp', 164, 100],
  ['normalize', '-12', 0], ['normalize', ' 42 ', 42], ['normalize', '150', 100], ['normalize', 75, 75],
  ['normalize', 'bad', 0], ['normalize', null, 0], ['normalize', '', 0],
]);
const EXPECTED_RESULTS = Object.freeze(APPROVED_CASES.map(([, , expected]) => ({value: expected})));

function git(cwd, args) {
  return execFileSync(GIT_BIN, ['--no-optional-locks', '-c', `core.hooksPath=${NULL_DEV}`,
    '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.symlinks=false', ...args], {
    cwd, encoding: 'utf8', windowsHide: true,
    env: {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_DEV, GIT_TERMINAL_PROMPT: '0'},
  });
}

function withScratch(fn) {
  const root = mkdtempSync(join(tmpdir(), 'vp-unit-'));
  const baseRepoDir = join(root, 'base-repo');
  const helperScratch = join(root, 'scratch');
  const hostClaimsDir = join(root, 'host-claims');
  mkdirSync(baseRepoDir);
  mkdirSync(helperScratch);
  mkdirSync(hostClaimsDir);
  for (const name of APPROVED_FIXTURE_FILES) writeFileSync(join(baseRepoDir, name), BASE_FILES[name], 'utf8');
  git(baseRepoDir, ['init', '--quiet', '--initial-branch=pilot', '--template=']);
  git(baseRepoDir, ['add', '--', ...APPROVED_FIXTURE_FILES]);
  git(baseRepoDir, ['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '--no-verify', '-m', 'Baseline']);
  const baseRevision = git(baseRepoDir, ['rev-parse', 'HEAD']).trim();
  const baseDigests = computeSortedFileDigests(BASE_FILES);
  const {scope, scopeHash} = buildScope({baseRevision, baseFileDigests: baseDigests.fileDigests, cases: APPROVED_CASES});
  const journalPath = join(hostClaimsDir, 'claim.jsonl');
  const journal = claimRun(journalPath, scope);
  journal.close();
  const claim = {claimId: journal.id, scope, scopeHash};
  const resolveClaim = claimId => {
    const row = reconcileClaim(journalPath).rows?.[0];
    if (!row || row.id !== claimId) return null;
    return {trusted: true, claimId: row.id, scope: row.scope, scopeHash: row.scopeHash};
  };
  try {
    return fn({root, baseRepoDir, baseRevision, baseDigests, claim, resolveClaim, journalPath, helperScratch});
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

const makeVerification = (claim, d, overrides = {}) => ({
  trusted: true, passed: true, claimId: claim.claimId, baseRevision: claim.scope.baseRevision,
  casesDigest: claim.scope.casesDigest, totalCases: claim.scope.totalCases, passedCases: claim.scope.totalCases,
  failures: [], results: EXPECTED_RESULTS, fileDigests: d.fileDigests, treeSha256: d.treeSha256, ...overrides,
});

test('reproduces exact checked bytes via host-resolved claim without mutating base repo', () => {
  const a = computeSortedFileDigests({'limits.py': CANDIDATE_FILES['limits.py'], 'measurement.py': CANDIDATE_FILES['measurement.py']});
  const b = computeSortedFileDigests({'measurement.py': CANDIDATE_FILES['measurement.py'], 'limits.py': CANDIDATE_FILES['limits.py']});
  assert.deepEqual(a.fileDigests, b.fileDigests);
  assert.equal(a.treeSha256, b.treeSha256);
  assert.throws(() => computeSortedFileDigests({...CANDIDATE_FILES, 'extra.py': 'x = 1\n'}));

  withScratch(({baseRepoDir, baseRevision, baseDigests, claim, resolveClaim, helperScratch}) => {
    const candDigests = computeSortedFileDigests(CANDIDATE_FILES);
    const built = buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles: CANDIDATE_FILES, scratchRoot: helperScratch});
    const bound = verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, resolveClaim, patch: built.patch, approvedCases: APPROVED_CASES,
      candidateFiles: CANDIDATE_FILES, verification: makeVerification(claim, candDigests),
      scratchRoot: helperScratch,
    });
    assert.equal(bound.status, 'verified-patch');
    assert.equal(Object.isFrozen(bound.scope), true);
    assert.equal(bound.scopeHash, claim.scopeHash);
    assert.equal(bound.baseTreeSha256, baseDigests.treeSha256);
    assert.deepEqual(bound.patchedFiles, ['limits.py', 'measurement.py']);
    assert.deepEqual(bound.baseFileDigests, baseDigests.fileDigests);
    assert.deepEqual(bound.fileDigests, candDigests.fileDigests);
    assert.equal(bound.treeSha256, candDigests.treeSha256);
    assert.equal(bound.verification.callerAssertedTrusted, true);
    assert.equal('provenanceEnforcedByCaller' in bound.verification, false);
    assert.equal('trusted' in bound.verification, false);
    assert.equal(bound.baseUnchanged, true);
    assert.equal(bound.reproducedFromDisposableBase, true);
    assert.equal(git(baseRepoDir, ['status', '--porcelain']), '');
    assert.deepEqual(readdirSync(helperScratch), []);

    // Omitting approvedCases still works when claim resolves from the protected host source.
    const boundDefaultScratch = verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, resolveClaim, patch: built.patch,
      verification: makeVerification(claim, candDigests),
    });
    assert.equal(boundDefaultScratch.treeSha256, candDigests.treeSha256);
  });
});

test('rejects missing/untrusted claim resolution and dual claim+verifier substitution when approvedCases omitted', () => {
  withScratch(({baseRepoDir, baseRevision, baseDigests, claim, resolveClaim, journalPath, helperScratch}) => {
    const candDigests = computeSortedFileDigests(CANDIDATE_FILES);
    const built = buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles: CANDIDATE_FILES, scratchRoot: helperScratch});
    const okVer = makeVerification(claim, candDigests);

    // Dual substitution regression (omitting approvedCases): both claim (with valid self-consistent scopeHash)
    // and matching verification are substituted to a 1-case scope under the real claimId.
    const subBound = buildScope({baseRevision, baseFileDigests: baseDigests.fileDigests, cases: [['clamp', 0, 0]]});
    const subClaim = {claimId: claim.claimId, ...subBound};
    const subVer = makeVerification(subClaim, candDigests, {results: [{value: 0}]});
    assert.throws(() => verifyAndBindPatch({
      baseRepoDir, baseRevision, claim: subClaim, resolveClaim, verification: subVer, patch: built.patch, scratchRoot: helperScratch,
    }), /does not match protected host record/);

    // Dual substitution with an unknown claimId also fails closed against the host resolver.
    const unknownClaim = {claimId: 'claim-forged-001', ...subBound};
    assert.throws(() => verifyAndBindPatch({
      baseRepoDir, baseRevision, claim: unknownClaim, resolveClaim,
      verification: makeVerification(unknownClaim, candDigests, {results: [{value: 0}]}),
      patch: built.patch, scratchRoot: helperScratch,
    }), /Missing or untrusted host claim resolution/);

    // Missing, non-function, untrusted, or corrupted host claim resolution must fail closed.
    for (const badResolver of [
      undefined,
      () => null,
      id => ({claimId: id, scope: claim.scope, scopeHash: claim.scopeHash}),
      id => ({trusted: false, claimId: id, scope: claim.scope, scopeHash: claim.scopeHash}),
      id => ({trusted: true, untrusted: true, claimId: id, scope: claim.scope, scopeHash: claim.scopeHash}),
      () => ({trusted: true, claimId: 'wrong-id', scope: claim.scope, scopeHash: claim.scopeHash}),
      id => ({trusted: true, claimId: id, scope: {...claim.scope, totalCases: 1}, scopeHash: claim.scopeHash}),
    ]) {
      assert.throws(() => verifyAndBindPatch({
        baseRepoDir, baseRevision, claim, resolveClaim: badResolver, verification: okVer, patch: built.patch, scratchRoot: helperScratch,
      }));
    }

    // Mutating scopeHash on supplied claim or passing mismatched approvedCases or verifier fields fails.
    assert.throws(() => verifyAndBindPatch({
      baseRepoDir, baseRevision, claim: {...claim, scope: {...claim.scope, totalCases: 1, casesDigest: digest([['clamp', 0, 0]])}},
      resolveClaim, verification: okVer, patch: built.patch, scratchRoot: helperScratch,
    }), /scopeHash does not match/);

    assert.throws(() => verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, resolveClaim, verification: okVer,
      approvedCases: [['clamp', 0, 0]], patch: built.patch, scratchRoot: helperScratch,
    }), /check digest or count/);

    assert.throws(() => verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, resolveClaim, patch: built.patch, scratchRoot: helperScratch,
      verification: makeVerification(claim, candDigests, {casesDigest: 'a'.repeat(64)}),
    }), /verifier attestation/);

    assert.throws(() => verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, resolveClaim, patch: built.patch, scratchRoot: helperScratch,
      verification: makeVerification(claim, candDigests, {totalCases: 11, passedCases: 11}),
    }), /verifier attestation/);

    assert.throws(() => verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, resolveClaim, patch: built.patch, scratchRoot: helperScratch,
      verification: makeVerification(claim, candDigests, {results: [{error: 'failed'}, ...EXPECTED_RESULTS.slice(1)]}),
    }), /verifier results/);

    // Truncated/corrupted host journal yields unresolved -> rejected.
    writeFileSync(journalPath, '{');
    assert.throws(() => verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, resolveClaim, verification: okVer, patch: built.patch, scratchRoot: helperScratch,
    }), /Missing or untrusted host claim resolution/);
  });
});

test('ignores Git replace objects and rejects changed revision, swap, single-file patch, and extra files', () => {
  withScratch(({baseRepoDir, baseRevision, claim, resolveClaim, helperScratch}) => {
    const candDigests = computeSortedFileDigests(CANDIDATE_FILES);
    const built = buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles: CANDIDATE_FILES, scratchRoot: helperScratch});
    const okVer = makeVerification(claim, candDigests);

    const realBlob = git(baseRepoDir, ['rev-parse', `${baseRevision}:limits.py`]).trim();
    const fakeBlob = execFileSync(GIT_BIN, ['hash-object', '-w', '--stdin'], {
      cwd: baseRepoDir, input: 'def clamp(value):\n    return 999\n', encoding: 'utf8', windowsHide: true,
    }).trim();
    execFileSync(GIT_BIN, ['replace', realBlob, fakeBlob], {cwd: baseRepoDir, windowsHide: true});
    const verifiedWithReplace = verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, resolveClaim, verification: okVer, patch: built.patch, scratchRoot: helperScratch,
    });
    assert.equal(verifiedWithReplace.treeSha256, candDigests.treeSha256);

    assert.throws(() => verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, resolveClaim, verification: okVer,
      patch: built.patch.replace('return 100', 'return 99'), scratchRoot: helperScratch,
    }), /Reproduced raw bytes mismatch/);

    const oneFile = {'limits.py': CANDIDATE_FILES['limits.py'], 'measurement.py': BASE_FILES['measurement.py']};
    const onePatch = buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles: oneFile, scratchRoot: helperScratch});
    assert.throws(() => verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, resolveClaim, patch: onePatch.patch, scratchRoot: helperScratch,
      verification: makeVerification(claim, computeSortedFileDigests(oneFile)),
    }), /both approved files modified/);

    for (const badPatch of [
      built.patch + 'diff --git a/extra.py b/extra.py\nnew file mode 100644\n--- /dev/null\n+++ b/extra.py\n@@ -0,0 +1 @@\n+x=1\n',
      'diff --git a/limits.py b/limits.py\nold mode 100644\nnew mode 120000\n',
      'diff --git a/limits.py b/limits.py\nGIT binary patch\nliteral 0\n',
    ]) {
      assert.throws(() => validatePatchAllowlist(badPatch));
      assert.throws(() => verifyAndBindPatch({baseRepoDir, baseRevision, claim, resolveClaim, verification: okVer, patch: badPatch, scratchRoot: helperScratch}));
    }

    writeFileSync(join(baseRepoDir, 'limits.py'), 'def clamp(value):\n    return value\n# moved\n', 'utf8');
    git(baseRepoDir, ['add', 'limits.py']);
    git(baseRepoDir, ['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '--no-verify', '-m', 'Advance']);
    assert.throws(() => verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, resolveClaim, verification: okVer, patch: built.patch, scratchRoot: helperScratch,
    }), /Base revision changed/);
  });
});

test('guards scratchRoot, enforces Windows path safety, and isolates ambient hooks and autocrlf', () => {
  for (const unsafe of ['', '../limits.py', 'sub\\limits.py', 'C:limits.py', 'limits.py:ADS', '/limits.py', 'CON', 'nul.py', 'limits.py.', '-limits.py', 'limits.py\0']) {
    assert.throws(() => assertSafeFixtureRelativePath(unsafe));
  }
  withScratch(({root, baseRepoDir, baseRevision, claim, resolveClaim, helperScratch}) => {
    const candDigests = computeSortedFileDigests(CANDIDATE_FILES);
    const built = buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles: CANDIDATE_FILES, scratchRoot: helperScratch});
    const okVer = makeVerification(claim, candDigests);

    assert.throws(() => verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, resolveClaim, verification: okVer, patch: built.patch, scratchRoot: '\\\\server\\share\\tmp',
    }), /UNC or device|safe local directory/);
    assert.throws(() => verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, resolveClaim, verification: okVer, patch: built.patch, scratchRoot: join(root, 'missing-dir'),
    }));

    const marker = join(root, 'hook-ran.txt');
    const hooksDir = join(baseRepoDir, '.git', 'hooks');
    mkdirSync(hooksDir, {recursive: true});
    for (const hook of ['post-checkout', 'pre-applypatch', 'applypatch-msg', 'pre-commit']) {
      writeFileSync(join(hooksDir, hook), `#!/bin/sh\necho x > "${marker.replace(/\\/g, '/')}"\nexit 1\n`, {mode: 0o755});
    }
    execFileSync(GIT_BIN, ['config', '--local', 'core.autocrlf', 'true'], {cwd: baseRepoDir, windowsHide: true});
    execFileSync(GIT_BIN, ['config', '--local', 'core.hooksPath', hooksDir], {cwd: baseRepoDir, windowsHide: true});

    const bound = verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, resolveClaim, patch: built.patch, verification: okVer, scratchRoot: helperScratch,
    });
    assert.equal(existsSync(marker), false);
    assert.deepEqual(bound.fileDigests, candDigests.fileDigests);
  });
});

test('never claims unobserved host provenance and rejects untrusted verifier metadata', () => {
  withScratch(({baseRepoDir, baseRevision, claim, helperScratch}) => {
    const candDigests = computeSortedFileDigests(CANDIDATE_FILES);
    const built = buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles: CANDIDATE_FILES, scratchRoot: helperScratch});
    const syntheticResolveClaim = claimId => ({
      trusted: true,
      claimId,
      scope: claim.scope,
      scopeHash: claim.scopeHash,
    });

    for (const badVer of [
      makeVerification(claim, candDigests, {trusted: undefined}),
      makeVerification(claim, candDigests, {trusted: false}),
      makeVerification(claim, candDigests, {trusted: true, untrusted: true}),
    ]) {
      assert.throws(() => verifyAndBindPatch({
        baseRepoDir, baseRevision, claim, resolveClaim: syntheticResolveClaim,
        verification: badVer, patch: built.patch, scratchRoot: helperScratch,
      }), /verifier attestation/);
    }

    const bound = verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, resolveClaim: syntheticResolveClaim,
      verification: makeVerification(claim, candDigests, {provenanceEnforcedByCaller: true}),
      patch: built.patch, scratchRoot: helperScratch,
    });
    assert.equal(bound.verification.callerAssertedTrusted, true);
    assert.equal('provenanceEnforcedByCaller' in bound.verification, false);
    assert.equal('trusted' in bound.verification, false);
  });
});
