import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {claimRun, digest, reconcileClaim} from './runner-lifecycle.mjs';
import {
  authenticateVerifierEvidence,
  beginHostAcceptance,
  canonicalAttestationHmac,
  FIXED_CASES_DIGEST,
} from './host-evidence-authenticator.mjs';
import {
  APPROVED_FIXTURE_FILES,
  assertSafeFixtureRelativePath,
  buildCandidatePatch,
  buildScope,
  computeSortedFileDigests,
  createVerifiedPatchController,
  validatePatchAllowlist,
  verifyAndBindPatch,
} from './verified-patch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GIT_BIN = process.platform === 'win32' ? 'git.exe' : 'git';
const NULL_DEV = process.platform === 'win32' ? 'NUL' : '/dev/null';

const SYNTHETIC_KEY = Buffer.from('controller-test-hmac-key-32bytes');
const OTHER_KEY = Buffer.from('different-synthetic-hmac-key-32b');
const SYNTHETIC_NONCE = 'nonce-20261118-0001';
const OTHER_NONCE = 'nonce-20261118-0002';
const PYTHON_CASES_DIGEST = 'bf1298ec5b5209a192042da7cc85814aacc24590c11b38263700b45fdb9c624f';
const PYTHON_HMAC = 'f8d41dd4ccc7607865142d7fb9a4abd5227b86eaaafa7179384fa34b7dd02feb';
const PYTHON_UNICODE_HMAC = '220fcd9c948ea73cfcf5c1a810300351364aa77ff2dc127958ef14dc0c8a4174';
const PYTHON_ATTESTATION_B64 = "eyJzY29wZSI6ImZpeGVkLXN5bnRoZXRpYy1vbmx5IiwidGFyZ2V0IjoibGltaXRzLnB5K21lYXN1cmVtZW50LnB5IiwidmVyaWZpZXIiOiJwcm90ZWN0ZWQtZml4dHVyZS12ZXJpZmllci1hc3QtdjIiLCJlbnRyeVBvaW50RGlzY29ubmVjdGVkIjp0cnVlLCJ0cnVzdGVkIjp0cnVlLCJwYXNzZWQiOnRydWUsImNsYWltSWQiOiJjbGFpbS0yMDI2MTExOC0wMDEiLCJzY29wZUhhc2giOiIyMjdlMjdkYmY2NjA1ZTE4MDdmNmE3YzU3OWJhNzEyZGNhNGU2MTk1ODAzNDRmYmIxNzhlZWY4N2I4YjA0OTEwIiwiY2xhaW1TY29wZSI6eyJmaWxlcyI6WyJsaW1pdHMucHkiLCJtZWFzdXJlbWVudC5weSJdLCJiYXNlUmV2aXNpb24iOiJhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhIiwiYmFzZUZpbGVEaWdlc3RzIjp7ImxpbWl0cy5weSI6ImFiYTZlNDE3NGZhOGQwNWIwMzU5ZmQyYzczNmM2ODZjNmExZmJiNTc4NGY3YTYyODA4NDk1YWNkZWVhN2FkZTIiLCJtZWFzdXJlbWVudC5weSI6ImI0YjVhNzg1NjA4MzNmMjM4YjU5Mzg1N2UyMGI4ZWE4YjlkZmQyYzllNmIwYzMxZTBlNTdlODVkMDYyZDJkMjMifSwiY2FzZXNEaWdlc3QiOiJiZjEyOThlYzViNTIwOWExOTIwNDJkYTdjYzg1ODE0YWFjYzI0NTkwYzExYjM4MjYzNzAwYjQ1ZmRiOWM2MjRmIiwidG90YWxDYXNlcyI6MTJ9LCJiYXNlUmV2aXNpb24iOiJhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhIiwiYmFzZUZpbGVEaWdlc3RzIjp7ImxpbWl0cy5weSI6ImFiYTZlNDE3NGZhOGQwNWIwMzU5ZmQyYzczNmM2ODZjNmExZmJiNTc4NGY3YTYyODA4NDk1YWNkZWVhN2FkZTIiLCJtZWFzdXJlbWVudC5weSI6ImI0YjVhNzg1NjA4MzNmMjM4YjU5Mzg1N2UyMGI4ZWE4YjlkZmQyYzllNmIwYzMxZTBlNTdlODVkMDYyZDJkMjMifSwiYmFzZVRyZWVTaGEyNTYiOiIxNWJkZDRiMGMxM2Q4MjFjYThmZWU2M2JmODg3M2JhNjQyYTM0OWE3MmRlZGZiMWE4NzJiODM4ZjMzMGUxOTk0IiwiY2FzZXNEaWdlc3QiOiJiZjEyOThlYzViNTIwOWExOTIwNDJkYTdjYzg1ODE0YWFjYzI0NTkwYzExYjM4MjYzNzAwYjQ1ZmRiOWM2MjRmIiwidG90YWxDYXNlcyI6MTIsInBhc3NlZENhc2VzIjoxMiwiZmFpbHVyZXMiOltdLCJyZXN1bHRzIjpbeyJ2YWx1ZSI6MH0seyJ2YWx1ZSI6MH0seyJ2YWx1ZSI6NTZ9LHsidmFsdWUiOjEwMH0seyJ2YWx1ZSI6MTAwfSx7InZhbHVlIjowfSx7InZhbHVlIjo0Mn0seyJ2YWx1ZSI6MTAwfSx7InZhbHVlIjo3NX0seyJ2YWx1ZSI6MH0seyJ2YWx1ZSI6MH0seyJ2YWx1ZSI6MH1dLCJjYXNlUmVzdWx0cyI6W3siY2FzZSI6MSwiZnVuY3Rpb24iOiJjbGFtcCIsInBhc3NlZCI6dHJ1ZSwiZXhwZWN0ZWQiOjAsInN0ZXBzIjo3LCJhY3R1YWwiOjB9LHsiY2FzZSI6MiwiZnVuY3Rpb24iOiJjbGFtcCIsInBhc3NlZCI6dHJ1ZSwiZXhwZWN0ZWQiOjAsInN0ZXBzIjoxMSwiYWN0dWFsIjowfSx7ImNhc2UiOjMsImZ1bmN0aW9uIjoiY2xhbXAiLCJwYXNzZWQiOnRydWUsImV4cGVjdGVkIjo1Niwic3RlcHMiOjExLCJhY3R1YWwiOjU2fSx7ImNhc2UiOjQsImZ1bmN0aW9uIjoiY2xhbXAiLCJwYXNzZWQiOnRydWUsImV4cGVjdGVkIjoxMDAsInN0ZXBzIjoxMSwiYWN0dWFsIjoxMDB9LHsiY2FzZSI6NSwiZnVuY3Rpb24iOiJjbGFtcCIsInBhc3NlZCI6dHJ1ZSwiZXhwZWN0ZWQiOjEwMCwic3RlcHMiOjExLCJhY3R1YWwiOjEwMH0seyJjYXNlIjo2LCJmdW5jdGlvbiI6Im5vcm1hbGl6ZSIsInBhc3NlZCI6dHJ1ZSwiZXhwZWN0ZWQiOjAsInN0ZXBzIjoxMywiYWN0dWFsIjowfSx7ImNhc2UiOjcsImZ1bmN0aW9uIjoibm9ybWFsaXplIiwicGFzc2VkIjp0cnVlLCJleHBlY3RlZCI6NDIsInN0ZXBzIjoxNywiYWN0dWFsIjo0Mn0seyJjYXNlIjo4LCJmdW5jdGlvbiI6Im5vcm1hbGl6ZSIsInBhc3NlZCI6dHJ1ZSwiZXhwZWN0ZWQiOjEwMCwic3RlcHMiOjE3LCJhY3R1YWwiOjEwMH0seyJjYXNlIjo5LCJmdW5jdGlvbiI6Im5vcm1hbGl6ZSIsInBhc3NlZCI6dHJ1ZSwiZXhwZWN0ZWQiOjc1LCJzdGVwcyI6MTcsImFjdHVhbCI6NzV9LHsiY2FzZSI6MTAsImZ1bmN0aW9uIjoibm9ybWFsaXplIiwicGFzc2VkIjp0cnVlLCJleHBlY3RlZCI6MCwic3RlcHMiOjgsImFjdHVhbCI6MH0seyJjYXNlIjoxMSwiZnVuY3Rpb24iOiJub3JtYWxpemUiLCJwYXNzZWQiOnRydWUsImV4cGVjdGVkIjowLCJzdGVwcyI6OCwiYWN0dWFsIjowfSx7ImNhc2UiOjEyLCJmdW5jdGlvbiI6Im5vcm1hbGl6ZSIsInBhc3NlZCI6dHJ1ZSwiZXhwZWN0ZWQiOjAsInN0ZXBzIjo4LCJhY3R1YWwiOjB9XSwiZmlsZURpZ2VzdHMiOnsibGltaXRzLnB5IjoiMzhjMTIzMWMyZTY1MWIzYTY5YmNmNzMxM2NlZTI2NzM2MTlkY2I5NWMyNDZlNzM5OTcxZGY2ZjRhYjA1MGQ4NCIsIm1lYXN1cmVtZW50LnB5IjoiOTI5NjgwNTdlNDA1NGQ2ZjRkNDVlOWVjZmU4MmI0YzYyMWQ0OGIwZDE0ZDA4YjZhNWJlODEwMTQ3OGVhOTg4YSJ9LCJ0cmVlU2hhMjU2IjoiNGE5OWY2MzMxZjQwMzkwZGM4MjE5ZmYxMWI3MTRkZDYwYWE1MDJjOTBiM2U0Y2RlNjEwNjhlZWNmMWEyNDdlOSIsInVuY2hhbmdlZEZpbGVzIjpbXSwid29ya0JvdW5kcyI6eyJtYXhGaWxlQnl0ZXMiOjgxOTIsIm1heEFzdE5vZGVzIjoxOTIsIm1heEFzdERlcHRoIjoyNCwibWF4U3RlcHNQZXJDYXNlIjoyNTYsIm1heEludEFicyI6MTAwMDAwMDAwMDAwMDAwMDAwMCwibWF4U3RyTGVuIjo2NH0sIndvcmtPYnNlcnZlZCI6eyJhc3ROb2RlcyI6eyJsaW1pdHMucHkiOjIwLCJtZWFzdXJlbWVudC5weSI6MTl9LCJhc3REZXB0aCI6eyJsaW1pdHMucHkiOjUsIm1lYXN1cmVtZW50LnB5Ijo3fSwibWF4Q2FzZVN0ZXBzIjoxN30sInByb3ZlbmFuY2UiOnsiY2xhaW1Cb3VuZCI6dHJ1ZSwiaW52b2NhdGlvbk5vbmNlIjoibm9uY2UtMjAyNjExMTgtMDAwMSIsImhtYWNTaGEyNTYiOiJmOGQ0MWRkNGNjYzc2MDc4NjUxNDJkN2ZiOWE0YWJkNTIyN2I4NmVhYWFmYTcxNzkzODRmYTM0YjdkZDAyZmViIn19";
const PYTHON_UNICODE_B64 = "eyJzY29wZSI6ImZpeGVkLXN5bnRoZXRpYy1vbmx5Iiwibm90ZSI6ImEvYiDDqeKAqHgiLCJuIjoxLCJvayI6dHJ1ZSwieiI6bnVsbCwicHJvdmVuYW5jZSI6eyJjbGFpbUJvdW5kIjp0cnVlLCJpbnZvY2F0aW9uTm9uY2UiOiJub25jZS0yMDI2MTExOC0wMDAxIiwiaG1hY1NoYTI1NiI6Imlnbm9yZWQifX0=";

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

function git(cwd, args) {
  return execFileSync(GIT_BIN, ['--no-optional-locks', '-c', `core.hooksPath=${NULL_DEV}`,
    '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.symlinks=false', ...args], {
    cwd, encoding: 'utf8', windowsHide: true,
    env: {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_DEV, GIT_TERMINAL_PROMPT: '0'},
  });
}

function hostController(claim, {key = SYNTHETIC_KEY, nonce = SYNTHETIC_NONCE} = {}) {
  return createVerifiedPatchController({
    attestationKey: Buffer.from(key),
    expectedInvocationNonce: nonce,
    claimRecord: {claimId: claim.claimId, scope: claim.scope, scopeHash: claim.scopeHash},
  });
}

function makeEvidence(claim, candDigests, baseDigests, overrides = {}, signing = {}) {
  const key = signing.key ?? SYNTHETIC_KEY;
  const nonce = signing.nonce ?? SYNTHETIC_NONCE;
  const evidence = {
    scope: 'fixed-synthetic-only',
    target: 'limits.py+measurement.py',
    verifier: 'protected-fixture-verifier-ast-v2',
    entryPointDisconnected: true,
    trusted: true,
    passed: true,
    claimId: claim.claimId,
    scopeHash: claim.scopeHash,
    claimScope: {
      files: [...claim.scope.files],
      baseRevision: claim.scope.baseRevision,
      baseFileDigests: {...claim.scope.baseFileDigests},
      casesDigest: claim.scope.casesDigest,
      totalCases: claim.scope.totalCases,
    },
    baseRevision: claim.scope.baseRevision,
    baseFileDigests: {...claim.scope.baseFileDigests},
    baseTreeSha256: baseDigests.treeSha256,
    casesDigest: claim.scope.casesDigest,
    totalCases: claim.scope.totalCases,
    passedCases: claim.scope.totalCases,
    failures: [],
    results: APPROVED_CASES.map(([, , expected]) => ({value: expected})),
    caseResults: APPROVED_CASES.map(([fn, , expected], index) => ({
      case: index + 1,
      function: fn,
      passed: true,
      expected,
      steps: 1,
      actual: expected,
    })),
    fileDigests: {...candDigests.fileDigests},
    treeSha256: candDigests.treeSha256,
    unchangedFiles: [],
    provenance: {claimBound: true, invocationNonce: nonce},
  };
  for (const [name, value] of Object.entries(overrides)) evidence[name] = value;
  if (signing.sign !== false) {
    delete evidence.provenance.hmacSha256;
    evidence.provenance.hmacSha256 = canonicalAttestationHmac(evidence, key);
  }
  return evidence;
}

function resign(evidence, key = SYNTHETIC_KEY) {
  delete evidence.provenance.hmacSha256;
  evidence.provenance.hmacSha256 = canonicalAttestationHmac(evidence, key);
  return evidence;
}

function bindPatch(ctx, evidence, extra = {}) {
  const controller = extra.controller ?? hostController(ctx.claim, extra.host);
  return verifyAndBindPatch({
    controller,
    baseRepoDir: ctx.baseRepoDir,
    baseRevision: ctx.baseRevision,
    evidence,
    patch: extra.patch,
    approvedCases: extra.approvedCases,
    candidateFiles: extra.candidateFiles,
    scratchRoot: extra.scratchRoot === undefined ? ctx.helperScratch : extra.scratchRoot,
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
  try {
    return fn({root, baseRepoDir, baseRevision, baseDigests, claim, journalPath, helperScratch});
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

function assertNoKeyLeak(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes(SYNTHETIC_KEY.toString('utf8')), false);
  assert.equal(text.includes(OTHER_KEY.toString('utf8')), false);
}

test('reproduces exact checked bytes from host-authenticated evidence without mutating the base repo', () => {
  assert.equal(FIXED_CASES_DIGEST, PYTHON_CASES_DIGEST);
  const a = computeSortedFileDigests({'limits.py': CANDIDATE_FILES['limits.py'], 'measurement.py': CANDIDATE_FILES['measurement.py']});
  const b = computeSortedFileDigests({'measurement.py': CANDIDATE_FILES['measurement.py'], 'limits.py': CANDIDATE_FILES['limits.py']});
  assert.deepEqual(a.fileDigests, b.fileDigests);
  assert.equal(a.treeSha256, b.treeSha256);
  assert.throws(() => computeSortedFileDigests({...CANDIDATE_FILES, 'extra.py': 'x = 1\n'}));

  withScratch(({baseRepoDir, baseRevision, baseDigests, claim, helperScratch}) => {
    const candDigests = computeSortedFileDigests(CANDIDATE_FILES);
    const built = buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles: CANDIDATE_FILES, scratchRoot: helperScratch});
    const evidence = makeEvidence(claim, candDigests, baseDigests);
    const bound = bindPatch(
      {baseRepoDir, baseRevision, claim, helperScratch},
      evidence,
      {patch: built.patch, approvedCases: APPROVED_CASES, candidateFiles: CANDIDATE_FILES},
    );
    assert.equal(bound.status, 'verified-patch');
    assert.equal(Object.isFrozen(bound.scope), true);
    assert.equal(bound.scopeHash, claim.scopeHash);
    assert.equal(bound.baseTreeSha256, baseDigests.treeSha256);
    assert.deepEqual(bound.patchedFiles, ['limits.py', 'measurement.py']);
    assert.deepEqual(bound.baseFileDigests, baseDigests.fileDigests);
    assert.deepEqual(bound.fileDigests, candDigests.fileDigests);
    assert.equal(bound.treeSha256, candDigests.treeSha256);
    assert.equal(bound.patchSha256, digest(built.patch));
    assert.equal(bound.verification.provenanceAuthenticated, true);
    assert.equal(bound.verification.caseRowsBound, 12);
    assert.equal(bound.verification.invocationNonce, SYNTHETIC_NONCE);
    assert.equal('trusted' in bound.verification, false);
    assert.equal('callerAssertedTrusted' in bound.verification, false);
    assertNoKeyLeak(bound);
    assert.equal(bound.baseUnchanged, true);
    assert.equal(bound.reproducedFromDisposableBase, true);
    assert.equal(git(baseRepoDir, ['status', '--porcelain']), '');
    assert.deepEqual(readdirSync(helperScratch), []);

    const boundWithoutCases = bindPatch(
      {baseRepoDir, baseRevision, claim, helperScratch},
      makeEvidence(claim, candDigests, baseDigests),
      {patch: built.patch},
    );
    assert.equal(boundWithoutCases.treeSha256, candDigests.treeSha256);
    assert.equal(boundWithoutCases.patchSha256, built.patch ? digest(built.patch) : '');
  });
});

test('rejects trusted flags, wrong key, tampering, wrong nonce, wrong claim or scope, and absent results', () => {
  withScratch(({baseRepoDir, baseRevision, baseDigests, claim, helperScratch}) => {
    const ctx = {baseRepoDir, baseRevision, claim, helperScratch};
    const candDigests = computeSortedFileDigests(CANDIDATE_FILES);
    const built = buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles: CANDIDATE_FILES, scratchRoot: helperScratch});
    const ok = makeEvidence(claim, candDigests, baseDigests);
    const patch = built.patch;

    assert.throws(() => verifyAndBindPatch({
      baseRepoDir, baseRevision, claim, resolveClaim: () => ({trusted: true, ...claim}),
      verification: {trusted: true, passed: true}, patch, scratchRoot: helperScratch,
    }), /Caller-supplied trusted flags are not accepted/);
    assert.throws(() => verifyAndBindPatch({
      baseRepoDir, baseRevision, evidence: {trusted: true, passed: true, results: []}, patch, scratchRoot: helperScratch,
    }), /Host controller is required/);
    assert.throws(() => createVerifiedPatchController({
      trusted: true, attestationKey: SYNTHETIC_KEY, expectedInvocationNonce: SYNTHETIC_NONCE, claimRecord: claim,
    }), /Caller-supplied trusted flags are not accepted/);
    assert.throws(() => createVerifiedPatchController({
      attestationKey: SYNTHETIC_KEY, expectedInvocationNonce: SYNTHETIC_NONCE,
      claimRecord: {...claim, trusted: true},
    }), /Host claim record is invalid/);

    const wrongKey = () => bindPatch(ctx, makeEvidence(claim, candDigests, baseDigests, {}, {key: OTHER_KEY}), {patch});
    assert.throws(wrongKey, /HMAC verification failed/);
    assert.throws(() => {
      const tampered = makeEvidence(claim, candDigests, baseDigests);
      tampered.passedCases = 11;
      bindPatch(ctx, tampered, {patch});
    }, /HMAC verification failed/);
    assert.throws(() => bindPatch(ctx, makeEvidence(claim, candDigests, baseDigests, {}, {nonce: OTHER_NONCE}), {patch}),
      /invocationNonce mismatch/);

    const forgedClaim = makeEvidence(claim, candDigests, baseDigests);
    forgedClaim.claimId = 'claim-forged-001';
    resign(forgedClaim);
    assert.throws(() => bindPatch(ctx, forgedClaim, {patch}), /claim or scope binding mismatch/);

    for (const mutate of [
      evidence => { evidence.casesDigest = 'a'.repeat(64); evidence.claimScope.casesDigest = 'a'.repeat(64); },
      evidence => { evidence.claimScope.files = ['measurement.py', 'limits.py']; },
      evidence => { evidence.claimScope.totalCases = 11; evidence.totalCases = 11; },
      evidence => { evidence.baseFileDigests = {...evidence.baseFileDigests, 'limits.py': 'b'.repeat(64)}; },
      evidence => { evidence.baseRevision = 'c'.repeat(40); evidence.claimScope.baseRevision = 'c'.repeat(40); },
    ]) {
      const shifted = makeEvidence(claim, candDigests, baseDigests);
      mutate(shifted);
      resign(shifted);
      assert.throws(() => bindPatch(ctx, shifted, {patch}), /claim or scope binding mismatch/);
    }

    const absent = makeEvidence(claim, candDigests, baseDigests);
    delete absent.results;
    resign(absent);
    assert.throws(() => bindPatch(ctx, absent, {patch}), /results must contain all case rows/);

    const noCaseRows = makeEvidence(claim, candDigests, baseDigests);
    delete noCaseRows.caseResults;
    resign(noCaseRows);
    assert.throws(() => bindPatch(ctx, noCaseRows, {patch}), /case results are missing, failed, or mismatched/);

    const failedRow = makeEvidence(claim, candDigests, baseDigests, {
      results: [{error: 'failed'}, ...APPROVED_CASES.slice(1).map(([, , expected]) => ({value: expected}))],
      passed: false,
      passedCases: 11,
      failures: [1],
    });
    assert.throws(() => bindPatch(ctx, failedRow, {patch}), /case results are missing, failed, or mismatched/);
    assert.throws(() => bindPatch(ctx, ok, {patch, approvedCases: [['clamp', 0, 0]]}), /fixed 12-case vector/);

    try { wrongKey(); } catch (error) { assertNoKeyLeak(error.message); assertNoKeyLeak(error.stack); }
  });
});

test('rejects replay and binds only reproduced bytes and the applied patch digest', () => {
  withScratch(({baseRepoDir, baseRevision, baseDigests, claim, helperScratch}) => {
    const ctx = {baseRepoDir, baseRevision, claim, helperScratch};
    const candDigests = computeSortedFileDigests(CANDIDATE_FILES);
    const built = buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles: CANDIDATE_FILES, scratchRoot: helperScratch});
    const controller = hostController(claim);
    const evidence = makeEvidence(claim, candDigests, baseDigests);
    const tampered = makeEvidence(claim, candDigests, baseDigests);
    tampered.treeSha256 = 'd'.repeat(64);

    assert.throws(() => bindPatch(ctx, tampered, {patch: built.patch, controller}), /HMAC verification failed/);
    const bound = bindPatch(ctx, evidence, {
      patch: built.patch, controller, candidateFiles: CANDIDATE_FILES,
    });
    assert.equal(bound.patchSha256, digest(built.patch));
    assert.deepEqual(bound.fileDigests, candDigests.fileDigests);
    assert.throws(() => bindPatch(ctx, evidence, {patch: built.patch, controller}), /Replayed invocation nonce/);

    const alteredBytes = {
      'limits.py': CANDIDATE_FILES['limits.py'].replace('return value', 'return 0'),
      'measurement.py': CANDIDATE_FILES['measurement.py'],
    };
    assert.throws(() => bindPatch(ctx, makeEvidence(claim, candDigests, baseDigests), {
      patch: built.patch, candidateFiles: alteredBytes,
    }), /Candidate digest mismatch/);
    assert.throws(() => bindPatch(ctx, makeEvidence(claim, candDigests, baseDigests), {
      patch: built.patch.replace('return 100', 'return 99'),
    }), /Reproduced raw bytes mismatch/);
  });
});

test('ignores Git replace objects and rejects changed revision, single-file patch, and extra files', () => {
  withScratch(({baseRepoDir, baseRevision, baseDigests, claim, helperScratch}) => {
    const ctx = {baseRepoDir, baseRevision, claim, helperScratch};
    const candDigests = computeSortedFileDigests(CANDIDATE_FILES);
    const built = buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles: CANDIDATE_FILES, scratchRoot: helperScratch});
    const ok = makeEvidence(claim, candDigests, baseDigests);

    const realBlob = git(baseRepoDir, ['rev-parse', `${baseRevision}:limits.py`]).trim();
    const fakeBlob = execFileSync(GIT_BIN, ['hash-object', '-w', '--stdin'], {
      cwd: baseRepoDir, input: 'def clamp(value):\n    return 999\n', encoding: 'utf8', windowsHide: true,
    }).trim();
    execFileSync(GIT_BIN, ['replace', realBlob, fakeBlob], {cwd: baseRepoDir, windowsHide: true});
    const verifiedWithReplace = bindPatch(ctx, ok, {patch: built.patch});
    assert.equal(verifiedWithReplace.treeSha256, candDigests.treeSha256);
    assert.equal(verifiedWithReplace.patchSha256, digest(built.patch));

    const oneFile = {'limits.py': CANDIDATE_FILES['limits.py'], 'measurement.py': BASE_FILES['measurement.py']};
    const onePatch = buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles: oneFile, scratchRoot: helperScratch});
    assert.throws(() => bindPatch(ctx, makeEvidence(claim, computeSortedFileDigests(oneFile), baseDigests), {
      patch: onePatch.patch,
    }), /both approved files modified|file digest binding mismatch/);

    for (const badPatch of [
      built.patch + 'diff --git a/extra.py b/extra.py\nnew file mode 100644\n--- /dev/null\n+++ b/extra.py\n@@ -0,0 +1 @@\n+x=1\n',
      'diff --git a/limits.py b/limits.py\nold mode 100644\nnew mode 120000\n',
      'diff --git a/limits.py b/limits.py\nGIT binary patch\nliteral 0\n',
    ]) {
      assert.throws(() => validatePatchAllowlist(badPatch));
      assert.throws(() => bindPatch(ctx, ok, {patch: badPatch}));
    }

    writeFileSync(join(baseRepoDir, 'limits.py'), 'def clamp(value):\n    return value\n# moved\n', 'utf8');
    git(baseRepoDir, ['add', 'limits.py']);
    git(baseRepoDir, ['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '--no-verify', '-m', 'Advance']);
    assert.throws(() => bindPatch(ctx, ok, {patch: built.patch}), /Base revision changed/);
  });
});

test('guards scratchRoot, enforces path safety, and isolates ambient hooks and autocrlf', () => {
  for (const unsafe of ['', '../limits.py', 'sub\\limits.py', 'C:limits.py', 'limits.py:ADS', '/limits.py', 'CON', 'nul.py', 'limits.py.', '-limits.py', 'limits.py\0']) {
    assert.throws(() => assertSafeFixtureRelativePath(unsafe));
  }
  withScratch(({root, baseRepoDir, baseRevision, baseDigests, claim, helperScratch}) => {
    const ctx = {baseRepoDir, baseRevision, claim, helperScratch};
    const candDigests = computeSortedFileDigests(CANDIDATE_FILES);
    const built = buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles: CANDIDATE_FILES, scratchRoot: helperScratch});
    const ok = makeEvidence(claim, candDigests, baseDigests);

    assert.throws(() => bindPatch(ctx, ok, {patch: built.patch, scratchRoot: '\\\\server\\share\\tmp'}),
      /UNC or device|safe local directory/);
    assert.throws(() => bindPatch(ctx, ok, {patch: built.patch, scratchRoot: join(root, 'missing-dir')}));

    const marker = join(root, 'hook-ran.txt');
    const hooksDir = join(baseRepoDir, '.git', 'hooks');
    mkdirSync(hooksDir, {recursive: true});
    for (const hook of ['post-checkout', 'pre-applypatch', 'applypatch-msg', 'pre-commit']) {
      writeFileSync(join(hooksDir, hook), `#!/bin/sh\necho x > "${marker.replace(/\\/g, '/')}"\nexit 1\n`, {mode: 0o755});
    }
    execFileSync(GIT_BIN, ['config', '--local', 'core.autocrlf', 'true'], {cwd: baseRepoDir, windowsHide: true});
    execFileSync(GIT_BIN, ['config', '--local', 'core.hooksPath', hooksDir], {cwd: baseRepoDir, windowsHide: true});

    const bound = bindPatch(ctx, ok, {patch: built.patch});
    assert.equal(existsSync(marker), false);
    assert.deepEqual(bound.fileDigests, candDigests.fileDigests);
    assertNoKeyLeak(bound);
  });
});

test('does not treat a plain trusted object as proof and does not echo untrusted flags', () => {
  withScratch(({baseRepoDir, baseRevision, baseDigests, claim, journalPath, helperScratch}) => {
    const ctx = {baseRepoDir, baseRevision, claim, helperScratch};
    const candDigests = computeSortedFileDigests(CANDIDATE_FILES);
    const built = buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles: CANDIDATE_FILES, scratchRoot: helperScratch});
    const flagged = makeEvidence(claim, candDigests, baseDigests, {provenanceEnforcedByCaller: true});
    const bound = bindPatch(ctx, flagged, {patch: built.patch});
    assert.equal(bound.verification.provenanceAuthenticated, true);
    assert.equal('provenanceEnforcedByCaller' in bound, false);
    assert.equal('provenanceEnforcedByCaller' in bound.verification, false);
    assert.equal('trusted' in bound.verification, false);
    assertNoKeyLeak(controllerView(claim));

    writeFileSync(journalPath, '{');
    const reconciled = reconcileClaim(journalPath);
    assert.equal(reconciled.state, 'unresolved');
    assert.throws(() => createVerifiedPatchController({
      attestationKey: SYNTHETIC_KEY,
      expectedInvocationNonce: SYNTHETIC_NONCE,
      claimRecord: reconciled.rows?.[0],
    }), /Host claim record is invalid/);
  });
});

function controllerView(claim) {
  return hostController(claim);
}

test('authenticates a Python canonical attestation and unicode HMAC fixture', () => {
  const evidence = JSON.parse(Buffer.from(PYTHON_ATTESTATION_B64, 'base64').toString('utf8'));
  const unicodeEvidence = JSON.parse(Buffer.from(PYTHON_UNICODE_B64, 'base64').toString('utf8'));
  assert.equal(canonicalAttestationHmac(unicodeEvidence, SYNTHETIC_KEY), PYTHON_UNICODE_HMAC);
  assert.equal(canonicalAttestationHmac(evidence, SYNTHETIC_KEY), PYTHON_HMAC);
  assert.equal(evidence.provenance.hmacSha256, PYTHON_HMAC);
  assert.equal(evidence.results.length, 12);
  assert.equal(evidence.caseResults.length, 12);

  const baseDigests = computeSortedFileDigests(BASE_FILES);
  const candDigests = computeSortedFileDigests(CANDIDATE_FILES);
  const built = buildScope({
    baseRevision: 'a'.repeat(40),
    baseFileDigests: baseDigests.fileDigests,
    cases: APPROVED_CASES,
  });
  const claim = {claimId: 'claim-20261118-001', scope: built.scope, scopeHash: built.scopeHash};
  assert.equal(claim.scopeHash, evidence.scopeHash);
  assert.deepEqual(candDigests.fileDigests, evidence.fileDigests);
  const controller = hostController(claim);
  const acceptance = beginHostAcceptance(controller);
  const authenticated = authenticateVerifierEvidence(controller, evidence, {
    actualBaseRevision: 'a'.repeat(40),
    actualBaseDigests: baseDigests.fileDigests,
    approvedCases: APPROVED_CASES,
  });
  acceptance.commit();
  assert.equal(authenticated.totalCases, 12);
  assert.equal(authenticated.passedCases, 12);
  assert.deepEqual(authenticated.fileDigests, candDigests.fileDigests);
  assert.equal(authenticated.invocationNonce, SYNTHETIC_NONCE);
  assert.equal(JSON.stringify(controller).includes('hmacSha256'), false);
  assertNoKeyLeak(authenticated);
  assert.throws(() => authenticateVerifierEvidence(controller, {...evidence, trusted: true}, {
    actualBaseRevision: 'a'.repeat(40),
    actualBaseDigests: baseDigests.fileDigests,
  }), /Replayed invocation nonce/);
});
