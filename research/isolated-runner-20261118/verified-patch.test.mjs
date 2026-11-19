import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  APPROVED_FIXTURE_FILES,
  assertSafeFixtureRelativePath,
  buildCandidatePatch,
  computeScopeHash,
  computeSortedFileDigests,
  sha256Hex,
  validatePatchText,
  verifyAndBindPatch,
} from './verified-patch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures');
const GIT_BIN = process.platform === 'win32' ? 'git.exe' : 'git';
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

const BASE_FIXTURE_FILES = Object.freeze({
  'limits.py': readFileSync(join(FIXTURES_DIR, 'limits.py'), 'utf8'),
  'measurement.py': readFileSync(join(FIXTURES_DIR, 'measurement.py'), 'utf8'),
});

const CORRECTED_FIXTURE_FILES = Object.freeze({
  'limits.py': [
    'def clamp(value):',
    '    if value < 0:',
    '        return 0',
    '    if value > 100:',
    '        return 100',
    '    return value',
    '',
  ].join('\n'),
  'measurement.py': [
    'from limits import clamp',
    '',
    '',
    'def normalize(raw):',
    '    try:',
    '        converted = int(raw)',
    '    except (TypeError, ValueError):',
    '        return 0',
    '    return clamp(converted)',
    '',
  ].join('\n'),
});

const CASES_DIGEST = sha256Hex(
  JSON.stringify([
    ['clamp', -8, 0],
    ['clamp', 0, 0],
    ['clamp', 56, 56],
    ['clamp', 100, 100],
    ['clamp', 164, 100],
    ['normalize', '-12', 0],
    ['normalize', ' 42 ', 42],
    ['normalize', '150', 100],
    ['normalize', 75, 75],
    ['normalize', 'bad', 0],
    ['normalize', null, 0],
    ['normalize', '', 0],
  ]),
);

function runTestGit(cwd, args) {
  return execFileSync(
    GIT_BIN,
    [
      '--no-optional-locks',
      '-c',
      `core.hooksPath=${NULL_DEVICE}`,
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.eol=lf',
      '-c',
      'core.symlinks=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: NULL_DEVICE,
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  );
}

function withScratchContext(fn) {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'vp-unit-'));
  const baseRepoDir = join(scratchRoot, 'disposable-base-repo');
  const helperScratch = join(scratchRoot, 'helper-scratch');
  mkdirSync(baseRepoDir);
  mkdirSync(helperScratch);
  for (const name of APPROVED_FIXTURE_FILES) {
    writeFileSync(join(baseRepoDir, name), BASE_FIXTURE_FILES[name], 'utf8');
  }
  runTestGit(baseRepoDir, ['init', '--quiet', '--initial-branch=pilot', '--template=']);
  runTestGit(baseRepoDir, ['add', '--', ...APPROVED_FIXTURE_FILES]);
  runTestGit(baseRepoDir, [
    '-c',
    'user.name=CydeWorks Synthetic Test',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '--no-verify',
    '-m',
    'Create inert baseline',
  ]);
  const baseRevision = runTestGit(baseRepoDir, ['rev-parse', 'HEAD']).trim();
  const baseDigests = computeSortedFileDigests(BASE_FIXTURE_FILES);
  const claimId = 'claim-20261118-001';
  const scopeHash = computeScopeHash({
    claimId,
    baseRevision,
    baseFileDigests: baseDigests.fileDigests,
    casesDigest: CASES_DIGEST,
  });
  const claim = {
    claimId,
    scopeHash,
    baseRevision,
    baseFileDigests: baseDigests.fileDigests,
  };
  try {
    return fn({
      scratchRoot,
      helperScratch,
      baseRepoDir,
      baseRevision,
      baseDigests,
      claim,
    });
  } finally {
    rmSync(scratchRoot, {recursive: true, force: true});
  }
}

function makeVerification({claimId, baseRevision, fileDigests, treeSha256}) {
  return {
    trusted: true,
    passed: true,
    claimId,
    baseRevision,
    casesDigest: CASES_DIGEST,
    totalCases: 12,
    passedCases: 12,
    failures: [],
    fileDigests,
    treeSha256,
  };
}

test('computeSortedFileDigests is deterministic regardless of key insertion order', () => {
  const ordered = computeSortedFileDigests({
    'limits.py': CORRECTED_FIXTURE_FILES['limits.py'],
    'measurement.py': CORRECTED_FIXTURE_FILES['measurement.py'],
  });
  const reversed = computeSortedFileDigests({
    'measurement.py': CORRECTED_FIXTURE_FILES['measurement.py'],
    'limits.py': CORRECTED_FIXTURE_FILES['limits.py'],
  });

  assert.deepEqual(Object.keys(ordered.fileDigests), ['limits.py', 'measurement.py']);
  assert.deepEqual(Object.keys(reversed.fileDigests), ['limits.py', 'measurement.py']);
  assert.deepEqual(ordered.fileDigests, reversed.fileDigests);
  assert.equal(ordered.treeSha256, reversed.treeSha256);

  assert.throws(
    () => computeSortedFileDigests({'limits.py': CORRECTED_FIXTURE_FILES['limits.py']}),
    /missing: measurement\.py/,
  );
  assert.throws(
    () => computeSortedFileDigests({...CORRECTED_FIXTURE_FILES, 'extra.py': 'x = 1\n'}),
    /extra: extra\.py/,
  );
  assert.throws(
    () => computeSortedFileDigests({...CORRECTED_FIXTURE_FILES, 'limits.py': 'bad\0byte\n'}),
    /Invalid text content/,
  );
});

test('binds verified patch outcome and reproduces exact checked bytes from isolated disposable base', () => {
  withScratchContext(({baseRepoDir, baseRevision, baseDigests, claim, helperScratch}) => {
    const candidateDigests = computeSortedFileDigests(CORRECTED_FIXTURE_FILES);
    const built = buildCandidatePatch({
      baseRepoDir,
      baseRevision,
      candidateFiles: CORRECTED_FIXTURE_FILES,
      scratchRoot: helperScratch,
    });

    const verification = makeVerification({
      claimId: claim.claimId,
      baseRevision,
      fileDigests: candidateDigests.fileDigests,
      treeSha256: candidateDigests.treeSha256,
    });

    const bound = verifyAndBindPatch({
      baseRepoDir,
      baseRevision,
      claim,
      verification,
      patch: built.patch,
      candidateFiles: CORRECTED_FIXTURE_FILES,
      requireAllFilesChanged: true,
      scratchRoot: helperScratch,
    });

    assert.equal(bound.status, 'verified-patch');
    assert.equal(bound.claimId, claim.claimId);
    assert.equal(bound.scopeHash, claim.scopeHash);
    assert.equal(bound.baseRevision, baseRevision);
    assert.deepEqual(bound.baseFileDigests, baseDigests.fileDigests);
    assert.deepEqual(bound.fileDigests, candidateDigests.fileDigests);
    assert.equal(bound.treeSha256, candidateDigests.treeSha256);
    assert.equal(bound.patchSha256, built.patchSha256);
    assert.deepEqual(bound.patchedFiles, ['limits.py', 'measurement.py']);
    assert.equal(bound.baseUnchanged, true);
    assert.equal(bound.reproducedFromDisposableBase, true);

    assert.equal(readFileSync(join(baseRepoDir, 'limits.py'), 'utf8'), BASE_FIXTURE_FILES['limits.py']);
    assert.equal(readFileSync(join(baseRepoDir, 'measurement.py'), 'utf8'), BASE_FIXTURE_FILES['measurement.py']);
    assert.equal(runTestGit(baseRepoDir, ['rev-parse', 'HEAD']).trim(), baseRevision);
    assert.equal(runTestGit(baseRepoDir, ['status', '--porcelain']), '');
    assert.deepEqual(readdirSync(helperScratch), []);
  });
});

test('rejects changed or non-commit base revisions', () => {
  withScratchContext(({baseRepoDir, baseRevision, claim, helperScratch}) => {
    const candidateDigests = computeSortedFileDigests(CORRECTED_FIXTURE_FILES);
    const built = buildCandidatePatch({
      baseRepoDir,
      baseRevision,
      candidateFiles: CORRECTED_FIXTURE_FILES,
      scratchRoot: helperScratch,
    });
    const verification = makeVerification({
      claimId: claim.claimId,
      baseRevision,
      fileDigests: candidateDigests.fileDigests,
      treeSha256: candidateDigests.treeSha256,
    });

    assert.throws(
      () => verifyAndBindPatch({
        baseRepoDir,
        baseRevision: 'HEAD',
        claim,
        verification,
        patch: built.patch,
        scratchRoot: helperScratch,
      }),
      /Git commit SHA/,
    );

    writeFileSync(join(baseRepoDir, 'limits.py'), 'def clamp(value):\n    return value\n# moved\n', 'utf8');
    runTestGit(baseRepoDir, ['add', 'limits.py']);
    runTestGit(baseRepoDir, [
      '-c',
      'user.name=CydeWorks Synthetic Test',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      'Advance base revision',
    ]);
    const movedRevision = runTestGit(baseRepoDir, ['rev-parse', 'HEAD']).trim();
    assert.notEqual(movedRevision, baseRevision);

    assert.throws(
      () => verifyAndBindPatch({
        baseRepoDir,
        baseRevision,
        claim,
        verification,
        patch: built.patch,
        scratchRoot: helperScratch,
      }),
      /Base revision changed or mismatched/,
    );

    assert.throws(
      () => verifyAndBindPatch({
        baseRepoDir,
        baseRevision: movedRevision,
        claim,
        verification,
        patch: built.patch,
        scratchRoot: helperScratch,
      }),
      /Claim baseRevision mismatch/,
    );

    assert.throws(
      () => verifyAndBindPatch({
        baseRepoDir,
        baseRevision: movedRevision,
        claim: {claimId: claim.claimId, scopeHash: claim.scopeHash, baseRevision: movedRevision},
        verification,
        patch: built.patch,
        scratchRoot: helperScratch,
      }),
      /Verifier evidence baseRevision changed/,
    );
  });
});

test('rejects patch byte mismatch, swap-after-check, and unapproved single-file-only patch', () => {
  withScratchContext(({baseRepoDir, baseRevision, claim, helperScratch}) => {
    const candidateDigests = computeSortedFileDigests(CORRECTED_FIXTURE_FILES);
    const built = buildCandidatePatch({
      baseRepoDir,
      baseRevision,
      candidateFiles: CORRECTED_FIXTURE_FILES,
      scratchRoot: helperScratch,
    });
    const verification = makeVerification({
      claimId: claim.claimId,
      baseRevision,
      fileDigests: candidateDigests.fileDigests,
      treeSha256: candidateDigests.treeSha256,
    });

    const swappedPatch = built.patch.replace('return 100', 'return 99');
    assert.notEqual(swappedPatch, built.patch);
    assert.throws(
      () => verifyAndBindPatch({
        baseRepoDir,
        baseRevision,
        claim,
        verification,
        patch: swappedPatch,
        scratchRoot: helperScratch,
      }),
      /Patched output digest mismatch for limits\.py/,
    );

    const swappedCandidate = {
      ...CORRECTED_FIXTURE_FILES,
      'measurement.py': CORRECTED_FIXTURE_FILES['measurement.py'] + '# post-check swap\n',
    };
    assert.throws(
      () => verifyAndBindPatch({
        baseRepoDir,
        baseRevision,
        claim,
        verification,
        patch: built.patch,
        candidateFiles: swappedCandidate,
        scratchRoot: helperScratch,
      }),
      /Candidate file digest mismatch for measurement\.py/,
    );

    const oneFileCandidate = {
      'limits.py': CORRECTED_FIXTURE_FILES['limits.py'],
      'measurement.py': BASE_FIXTURE_FILES['measurement.py'],
    };
    const oneFileDigests = computeSortedFileDigests(oneFileCandidate);
    const oneFilePatch = buildCandidatePatch({
      baseRepoDir,
      baseRevision,
      candidateFiles: oneFileCandidate,
      scratchRoot: helperScratch,
    });
    const oneFileVerification = makeVerification({
      claimId: claim.claimId,
      baseRevision,
      fileDigests: oneFileDigests.fileDigests,
      treeSha256: oneFileDigests.treeSha256,
    });

    assert.throws(
      () => verifyAndBindPatch({
        baseRepoDir,
        baseRevision,
        claim,
        verification: oneFileVerification,
        patch: oneFilePatch.patch,
        requireAllFilesChanged: true,
        scratchRoot: helperScratch,
      }),
      /modify all approved fixture files/,
    );

    const allowedPartial = verifyAndBindPatch({
      baseRepoDir,
      baseRevision,
      claim,
      verification: oneFileVerification,
      patch: oneFilePatch.patch,
      requireAllFilesChanged: false,
      scratchRoot: helperScratch,
    });
    assert.deepEqual(allowedPartial.patchedFiles, ['limits.py']);
    assert.deepEqual(allowedPartial.fileDigests, oneFileDigests.fileDigests);
  });
});

test('rejects extra files, dirty base, and symlink or mode-change patches', () => {
  withScratchContext(({baseRepoDir, baseRevision, claim, helperScratch}) => {
    const candidateDigests = computeSortedFileDigests(CORRECTED_FIXTURE_FILES);
    const built = buildCandidatePatch({
      baseRepoDir,
      baseRevision,
      candidateFiles: CORRECTED_FIXTURE_FILES,
      scratchRoot: helperScratch,
    });
    const verification = makeVerification({
      claimId: claim.claimId,
      baseRevision,
      fileDigests: candidateDigests.fileDigests,
      treeSha256: candidateDigests.treeSha256,
    });

    const extraFilePatch = built.patch + [
      'diff --git a/extra.py b/extra.py',
      'new file mode 100644',
      'index 0000000..e69de29',
      '--- /dev/null',
      '+++ b/extra.py',
      '@@ -0,0 +1 @@',
      '+x = 1',
      '',
    ].join('\n');
    assert.throws(() => validatePatchText(extraFilePatch), /unapproved file: extra\.py/);
    assert.throws(
      () => verifyAndBindPatch({
        baseRepoDir,
        baseRevision,
        claim,
        verification,
        patch: extraFilePatch,
        scratchRoot: helperScratch,
      }),
      /unapproved file: extra\.py/,
    );

    const symlinkModePatch = [
      'diff --git a/limits.py b/limits.py',
      'old mode 100644',
      'new mode 120000',
      '--- a/limits.py',
      '+++ b/limits.py',
      '@@ -1,2 +1 @@',
      '-def clamp(value):',
      '-    return value',
      '+../outside.py',
      '',
    ].join('\n');
    assert.throws(() => validatePatchText(symlinkModePatch), /forbidden patch metadata/);

    writeFileSync(join(baseRepoDir, 'extra.txt'), 'untracked\n', 'utf8');
    assert.throws(
      () => verifyAndBindPatch({
        baseRepoDir,
        baseRevision,
        claim,
        verification,
        patch: built.patch,
        scratchRoot: helperScratch,
      }),
      /must be clean/,
    );
  });

  withScratchContext(({baseRepoDir, baseRevision, claim, helperScratch}) => {
    const candidateDigests = computeSortedFileDigests(CORRECTED_FIXTURE_FILES);
    const verification = makeVerification({
      claimId: claim.claimId,
      baseRevision,
      fileDigests: candidateDigests.fileDigests,
      treeSha256: candidateDigests.treeSha256,
    });
    const built = buildCandidatePatch({
      baseRepoDir,
      baseRevision,
      candidateFiles: CORRECTED_FIXTURE_FILES,
      scratchRoot: helperScratch,
    });

    for (const badPatch of [
      'diff --git a/limits.py b/extra.py\n--- a/limits.py\n+++ b/extra.py\n@@ -1 +1 @@\n-a\n+b\n',
      'diff --git a/limits.py b/limits.py\nrename from limits.py\nrename to extra.py\n',
      'diff --git a/limits.py b/limits.py\nGIT binary patch\nliteral 0\n',
    ]) {
      assert.throws(() => validatePatchText(badPatch));
    }

    writeFileSync(join(baseRepoDir, 'extra.py'), 'x = 1\n', 'utf8');
    runTestGit(baseRepoDir, ['add', 'extra.py']);
    runTestGit(baseRepoDir, [
      '-c',
      'user.name=CydeWorks Synthetic Test',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      'Commit extra file',
    ]);
    const extraRevision = runTestGit(baseRepoDir, ['rev-parse', 'HEAD']).trim();
    assert.throws(
      () => verifyAndBindPatch({
        baseRepoDir,
        baseRevision: extraRevision,
        claim: {claimId: claim.claimId, scopeHash: claim.scopeHash, baseRevision: extraRevision},
        verification: {...verification, baseRevision: extraRevision},
        patch: built.patch,
        scratchRoot: helperScratch,
      }),
      /unexpected entries/,
    );
  });
});

test('handles files without trailing newline accurately when verifier evidence binds those exact bytes', () => {
  withScratchContext(({baseRepoDir, baseRevision, claim, helperScratch}) => {
    const noNewlineFiles = {
      'limits.py': CORRECTED_FIXTURE_FILES['limits.py'].slice(0, -1),
      'measurement.py': CORRECTED_FIXTURE_FILES['measurement.py'],
    };
    const digests = computeSortedFileDigests(noNewlineFiles);
    const built = buildCandidatePatch({
      baseRepoDir,
      baseRevision,
      candidateFiles: noNewlineFiles,
      scratchRoot: helperScratch,
    });
    assert.match(built.patch, /\\ No newline at end of file/);
    const bound = verifyAndBindPatch({
      baseRepoDir,
      baseRevision,
      claim,
      verification: makeVerification({
        claimId: claim.claimId,
        baseRevision,
        fileDigests: digests.fileDigests,
        treeSha256: digests.treeSha256,
      }),
      patch: built.patch,
      candidateFiles: noNewlineFiles,
      scratchRoot: helperScratch,
    });
    assert.deepEqual(bound.fileDigests, digests.fileDigests);
    assert.equal(bound.treeSha256, digests.treeSha256);
  });
});

test('rejects missing, failed, untrusted, or cross-claim verifier evidence', () => {
  withScratchContext(({baseRepoDir, baseRevision, claim, helperScratch}) => {
    const candidateDigests = computeSortedFileDigests(CORRECTED_FIXTURE_FILES);
    const built = buildCandidatePatch({
      baseRepoDir,
      baseRevision,
      candidateFiles: CORRECTED_FIXTURE_FILES,
      scratchRoot: helperScratch,
    });
    const validVerification = makeVerification({
      claimId: claim.claimId,
      baseRevision,
      fileDigests: candidateDigests.fileDigests,
      treeSha256: candidateDigests.treeSha256,
    });

    const invalidCases = [
      [undefined, /Missing verifier evidence/],
      [null, /Missing verifier evidence/],
      [{...validVerification, trusted: false}, /trusted !== true/],
      [{...validVerification, trusted: 'true'}, /trusted !== true/],
      [{...validVerification, passed: false}, /passed !== true/],
      [{...validVerification, claimId: 'claim-other'}, /claimId does not match/],
      [{...validVerification, passedCases: 11}, /passedCases must equal totalCases/],
      [{...validVerification, failures: [4]}, /failures must be an empty array/],
      [{...validVerification, treeSha256: '0'.repeat(64)}, /treeSha256 does not match/],
      [{...validVerification, fileDigests: {'limits.py': candidateDigests.fileDigests['limits.py']}}, /missing: measurement\.py/],
    ];

    for (const [badVerification, pattern] of invalidCases) {
      assert.throws(
        () => verifyAndBindPatch({
          baseRepoDir,
          baseRevision,
          claim,
          verification: badVerification,
          patch: built.patch,
          scratchRoot: helperScratch,
        }),
        pattern,
      );
    }
  });
});

test('enforces Windows path safety and isolates against ambient base hooks and autocrlf config', () => {
  for (const unsafePath of [
    '',
    '../limits.py',
    'sub\\limits.py',
    'C:limits.py',
    'limits.py:Zone.Identifier',
    '/limits.py',
    'CON',
    'nul.py',
    'COM1.py',
    'limits.py.',
    'limits.py ',
    '-limits.py',
    'limits.py\0',
  ]) {
    assert.throws(() => assertSafeFixtureRelativePath(unsafePath));
  }

  withScratchContext(({scratchRoot, baseRepoDir, baseRevision, claim, helperScratch}) => {
    const hookMarker = join(scratchRoot, 'hook-ran.txt');
    const hooksDir = join(baseRepoDir, '.git', 'hooks');
    mkdirSync(hooksDir, {recursive: true});
    for (const hookName of ['post-checkout', 'pre-applypatch', 'applypatch-msg', 'pre-commit']) {
      writeFileSync(
        join(hooksDir, hookName),
        `#!/bin/sh\necho triggered > "${hookMarker.replace(/\\/g, '/')}"\nexit 1\n`,
        {mode: 0o755},
      );
    }
    execFileSync(GIT_BIN, ['config', '--local', 'core.autocrlf', 'true'], {cwd: baseRepoDir, windowsHide: true});
    execFileSync(GIT_BIN, ['config', '--local', 'core.hooksPath', hooksDir], {cwd: baseRepoDir, windowsHide: true});

    const candidateDigests = computeSortedFileDigests(CORRECTED_FIXTURE_FILES);
    const built = buildCandidatePatch({
      baseRepoDir,
      baseRevision,
      candidateFiles: CORRECTED_FIXTURE_FILES,
      scratchRoot: helperScratch,
    });
    const verification = makeVerification({
      claimId: claim.claimId,
      baseRevision,
      fileDigests: candidateDigests.fileDigests,
      treeSha256: candidateDigests.treeSha256,
    });

    const bound = verifyAndBindPatch({
      baseRepoDir,
      baseRevision,
      claim,
      verification,
      patch: built.patch,
      scratchRoot: helperScratch,
    });

    assert.equal(bound.status, 'verified-patch');
    assert.equal(existsSync(hookMarker), false);
    assert.deepEqual(bound.fileDigests, candidateDigests.fileDigests);
  });
});
