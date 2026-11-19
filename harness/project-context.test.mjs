import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_CONTEXT_ENTRY_KINDS,
  PROJECT_CONTEXT_SOURCE_KINDS,
  ProjectContextLibrary,
  createProjectContextLibrary,
} from './project-context.mjs';

function makeClock(initial = 1_700_000_000_000) {
  let now = initial;
  return {
    clock: () => now,
    advance: (ms) => {
      now += ms;
      return now;
    },
    set: (ts) => {
      now = ts;
      return now;
    },
  };
}

function makeMemoryInput(overrides = {}) {
  return {
    projectId: 'proj-alpha',
    entryId: 'mem-style',
    kind: 'memory',
    purposeLabel: 'Synthetic coding style notes',
    content: 'Use strict equality and explicit error messages.',
    provenance: {
      selectionMode: 'explicit',
      sourceKind: 'owner-selected-file',
      sourceRef: 'docs/conventions.md',
      version: '1.0.0',
    },
    ...overrides,
  };
}

function makeSkillInput(overrides = {}) {
  return {
    projectId: 'proj-alpha',
    entryId: 'skill-brief',
    kind: 'skill',
    purposeLabel: 'Synthetic brief grounding skill',
    content: 'Cite line numbers for every factual claim.',
    requestedCapabilities: ['read-only-source'],
    provenance: {
      selectionMode: 'explicit',
      sourceKind: 'owner-authored',
      sourceRef: 'skills/brief-grounding.md',
      version: '1.0.0',
    },
    ...overrides,
  };
}

test('exports supported entry and source kinds as frozen arrays', () => {
  assert.deepEqual(PROJECT_CONTEXT_ENTRY_KINDS, ['memory', 'skill']);
  assert.deepEqual(PROJECT_CONTEXT_SOURCE_KINDS, [
    'owner-selected-file',
    'owner-authored',
    'explicit-import',
  ]);
  assert.ok(Object.isFrozen(PROJECT_CONTEXT_ENTRY_KINDS));
  assert.ok(Object.isFrozen(PROJECT_CONTEXT_SOURCE_KINDS));
});

test('explicitly selected entries require owner approval before entering prompt preview', () => {
  const { clock } = makeClock();
  const lib = createProjectContextLibrary({ clock });
  assert.ok(lib instanceof ProjectContextLibrary);

  const mem = lib.registerEntry(makeMemoryInput());
  const skill = lib.registerEntry(makeSkillInput());

  assert.equal(mem.status, 'pending-approval');
  assert.equal(mem.approval, null);
  assert.equal(skill.status, 'pending-approval');
  assert.equal(skill.approval, null);
  assert.ok(Object.isFrozen(mem));
  assert.ok(Object.isFrozen(mem.provenance));

  const beforeApproval = lib.previewPromptContext({
    projectId: 'proj-alpha',
    entryIds: ['mem-style', 'skill-brief'],
  });
  assert.equal(beforeApproval.included.length, 0);
  assert.equal(beforeApproval.promptText, '');
  assert.deepEqual(
    beforeApproval.excluded.map((item) => [item.entryId, item.reason]),
    [
      ['mem-style', 'unapproved'],
      ['skill-brief', 'unapproved'],
    ],
  );

  const approvedMem = lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-style',
    version: '1.0.0',
    approvedBy: 'owner-local',
    expectedDigest: mem.approvalDigest,
  });
  assert.equal(approvedMem.status, 'approved');
  assert.equal(approvedMem.approval.version, '1.0.0');
  assert.equal(approvedMem.approval.revisionId, mem.revisionId);
  assert.equal(approvedMem.approval.approvalDigest, approvedMem.approvalDigest);
  assert.equal(approvedMem.provenance.sourceHash, null);
  assert.equal(approvedMem.provenance.sourceHashStatus, 'not-provided');
  assert.equal(approvedMem.provenance.sourceHashVerified, false);

  const partialPreview = lib.previewPromptContext({
    projectId: 'proj-alpha',
    entryIds: ['mem-style', 'skill-brief'],
  });
  assert.deepEqual(
    partialPreview.included.map((item) => item.entryId),
    ['mem-style'],
  );
  assert.deepEqual(
    partialPreview.excluded.map((item) => [item.entryId, item.reason]),
    [['skill-brief', 'unapproved']],
  );
  assert.match(partialPreview.promptText, /Use strict equality and explicit error messages\./);
  assert.doesNotMatch(partialPreview.promptText, /Cite line numbers/);
});

test('rejects hidden imports, automatic discovery, traversal paths, credentials, and prototype hazards', () => {
  const { clock } = makeClock();
  const lib = createProjectContextLibrary({ clock });

  for (const selectionMode of ['auto', 'automatic', 'discovered', 'implicit', undefined, null]) {
    assert.throws(
      () =>
        lib.registerEntry(
          makeMemoryInput({
            entryId: 'mem-bad-mode',
            provenance: {
              selectionMode,
              sourceKind: 'owner-selected-file',
              sourceRef: 'docs/a.md',
              version: '1.0.0',
            },
          }),
        ),
      /explicit/i,
    );
  }

  for (const sourceRef of [
    '../secret.md',
    '/etc/passwd',
    'C:\\Users\\owner\\secret.txt',
    'file:///tmp/a.md',
    'docs/NUL.md',
    'docs/a..b/../../x.md',
  ]) {
    assert.throws(
      () =>
        lib.registerEntry(
          makeMemoryInput({
            entryId: 'mem-bad-path',
            provenance: {
              selectionMode: 'explicit',
              sourceKind: 'owner-selected-file',
              sourceRef,
              version: '1.0.0',
            },
          }),
        ),
      /sourceRef|path/i,
    );
  }

  assert.throws(
    () =>
      lib.registerEntry(
        makeMemoryInput({
          entryId: 'mem-cred-key',
          apiKey: 'sk-synthetic-123456',
        }),
      ),
    /forbidden|unknown|credential/i,
  );

  assert.throws(
    () =>
      lib.registerEntry(
        makeMemoryInput({
          entryId: 'mem-cred-content',
          content: 'Use token sk-synthetic1234567890 for auth.',
        }),
      ),
    /credential/i,
  );

  assert.throws(
    () =>
      lib.registerEntry(
        makeMemoryInput({
          entryId: '__proto__',
        }),
      ),
    /identifier|prototype/i,
  );

  const withAccessor = makeMemoryInput({ entryId: 'mem-accessor' });
  Object.defineProperty(withAccessor, 'purposeLabel', {
    enumerable: true,
    get() {
      return 'trap';
    },
  });
  assert.throws(() => lib.registerEntry(withAccessor), /accessor/i);

  assert.throws(
    () =>
      lib.registerEntry(
        makeMemoryInput({
          entryId: 'mem-caps',
          kind: 'memory',
          requestedCapabilities: ['write-files'],
        }),
      ),
    /capabilit/i,
  );
});

test('version changes invalidate previous approval until new version is explicitly approved', () => {
  const { clock } = makeClock();
  const lib = createProjectContextLibrary({ clock });

  const v1 = lib.registerEntry(makeSkillInput());
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'skill-brief',
    version: '1.0.0',
    approvedBy: 'owner-local',
    expectedDigest: v1.approvalDigest,
  });

  const v1Preview = lib.previewPromptContext({
    projectId: 'proj-alpha',
    entryIds: ['skill-brief'],
  });
  assert.equal(v1Preview.included.length, 1);
  assert.equal(v1Preview.included[0].version, '1.0.0');

  assert.throws(
    () =>
      lib.proposeEntryVersion({
        projectId: 'proj-alpha',
        entryId: 'skill-brief',
        content: 'Modified instructions without version bump.',
        requestedCapabilities: ['read-only-source'],
        provenance: {
          selectionMode: 'explicit',
          sourceKind: 'owner-authored',
          sourceRef: 'skills/brief-grounding.md',
          version: '1.0.0',
        },
      }),
    /version/i,
  );

  const v2 = lib.proposeEntryVersion({
    projectId: 'proj-alpha',
    entryId: 'skill-brief',
    purposeLabel: 'Synthetic brief grounding skill v2',
    content: 'Cite line numbers and flag unsupported claims.',
    requestedCapabilities: ['read-only-source', 'claim-check'],
    provenance: {
      selectionMode: 'explicit',
      sourceKind: 'owner-authored',
      sourceRef: 'skills/brief-grounding.md',
      version: '2.0.0',
    },
  });

  assert.equal(v2.status, 'pending-approval');
  assert.equal(v2.approval, null);
  assert.equal(v2.previousApprovalInvalidated, true);

  assert.throws(
    () =>
      lib.approveEntry({
        projectId: 'proj-alpha',
        entryId: 'skill-brief',
        version: '1.0.0',
        approvedBy: 'owner-local',
      }),
    /version/i,
  );

  assert.throws(
    () =>
      lib.approveEntry({
        projectId: 'proj-alpha',
        entryId: 'skill-brief',
        version: '2.0.0',
        approvedBy: 'owner-local',
        expectedDigest: v1.approvalDigest,
      }),
    /digest/i,
  );

  const invalidatedPreview = lib.previewPromptContext({
    projectId: 'proj-alpha',
    entryIds: ['skill-brief'],
  });
  assert.equal(invalidatedPreview.included.length, 0);
  assert.equal(invalidatedPreview.promptText, '');
  assert.deepEqual(
    invalidatedPreview.excluded.map((item) => [item.entryId, item.reason]),
    [['skill-brief', 'approval-invalidated']],
  );

  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'skill-brief',
    version: '2.0.0',
    approvedBy: 'owner-local',
    expectedDigest: v2.approvalDigest,
  });

  const v2Preview = lib.previewPromptContext({
    projectId: 'proj-alpha',
    entryIds: ['skill-brief'],
  });
  assert.equal(v2Preview.included.length, 1);
  assert.equal(v2Preview.included[0].version, '2.0.0');
  assert.match(v2Preview.promptText, /Cite line numbers and flag unsupported claims\./);
  assert.match(v2Preview.promptText, /claim-check/);
});

test('enforces strict cross-project isolation across lookup, listing, approval, and preview', () => {
  const { clock } = makeClock();
  const lib = createProjectContextLibrary({ clock });

  const alphaV1 = lib.registerEntry(
    makeMemoryInput({
      projectId: 'proj-alpha',
      entryId: 'mem-alpha-only',
      content: 'Alpha confidential synthetic project note.',
    }),
  );
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-alpha-only',
    version: '1.0.0',
    approvedBy: 'owner-local',
    expectedDigest: alphaV1.approvalDigest,
  });

  const betaV1 = lib.registerEntry(
    makeMemoryInput({
      projectId: 'proj-beta',
      entryId: 'mem-beta-only',
      content: 'Beta synthetic project note.',
    }),
  );
  lib.approveEntry({
    projectId: 'proj-beta',
    entryId: 'mem-beta-only',
    version: '1.0.0',
    approvedBy: 'owner-local',
    expectedDigest: betaV1.approvalDigest,
  });

  assert.equal(lib.getEntry({ projectId: 'proj-beta', entryId: 'mem-alpha-only' }), null);
  assert.deepEqual(
    lib.listEntries({ projectId: 'proj-beta' }).map((entry) => entry.entryId),
    ['mem-beta-only'],
  );

  assert.throws(
    () =>
      lib.approveEntry({
        projectId: 'proj-beta',
        entryId: 'mem-alpha-only',
        version: '1.0.0',
        approvedBy: 'owner-local',
        expectedDigest: alphaV1.approvalDigest,
      }),
    /not found/i,
  );

  const betaPreview = lib.previewPromptContext({
    projectId: 'proj-beta',
    entryIds: [
      'mem-beta-only',
      'mem-alpha-only',
      { projectId: 'proj-alpha', entryId: 'mem-alpha-only' },
    ],
  });
  assert.deepEqual(
    betaPreview.included.map((item) => item.entryId),
    ['mem-beta-only'],
  );
  assert.deepEqual(
    betaPreview.excluded.map((item) => [item.entryId, item.reason]),
    [
      ['mem-alpha-only', 'cross-project-excluded'],
      ['mem-alpha-only', 'not-found-in-project'],
    ],
  );
  assert.doesNotMatch(betaPreview.promptText, /Alpha confidential/);
  assert.doesNotMatch(JSON.stringify(betaPreview), /Alpha confidential/);
});

test('excludes expired entries and blocks approving expired entries', () => {
  const { clock, advance } = makeClock(1_000_000);
  const lib = createProjectContextLibrary({ clock });

  const shortLived = lib.registerEntry(
    makeMemoryInput({
      entryId: 'mem-short-lived',
      expiresAt: 1_060_000,
    }),
  );
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-short-lived',
    version: '1.0.0',
    approvedBy: 'owner-local',
    expectedDigest: shortLived.approvalDigest,
    expiresAt: 1_030_000,
  });

  const beforeExpiry = lib.previewPromptContext({
    projectId: 'proj-alpha',
    entryIds: ['mem-short-lived'],
  });
  assert.equal(beforeExpiry.included.length, 1);

  advance(30_000);
  const atApprovalExpiry = lib.previewPromptContext({
    projectId: 'proj-alpha',
    entryIds: ['mem-short-lived'],
  });
  assert.equal(atApprovalExpiry.included.length, 0);
  assert.equal(atApprovalExpiry.promptText, '');
  assert.deepEqual(
    atApprovalExpiry.excluded.map((item) => [item.entryId, item.reason]),
    [['mem-short-lived', 'expired']],
  );

  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-short-lived',
    version: '1.0.0',
    approvedBy: 'owner-local',
    expectedDigest: shortLived.approvalDigest,
    expiresAt: 1_055_000,
  });
  assert.equal(
    lib.previewPromptContext({
      projectId: 'proj-alpha',
      entryIds: ['mem-short-lived'],
    }).included.length,
    1,
  );

  advance(30_000);
  const afterEntryExpiry = lib.previewPromptContext({
    projectId: 'proj-alpha',
    entryIds: ['mem-short-lived'],
  });
  assert.equal(afterEntryExpiry.included.length, 0);
  assert.deepEqual(
    afterEntryExpiry.excluded.map((item) => [item.entryId, item.reason]),
    [['mem-short-lived', 'expired']],
  );

  assert.throws(
    () =>
      lib.approveEntry({
        projectId: 'proj-alpha',
        entryId: 'mem-short-lived',
        version: '1.0.0',
        approvedBy: 'owner-local',
        expectedDigest: shortLived.approvalDigest,
        expiresAt: 1_090_000,
      }),
    /expired/i,
  );
});

test('revocation immediately excludes entry and blocks subsequent approvals or revisions', () => {
  const { clock } = makeClock();
  const lib = createProjectContextLibrary({ clock });

  const mem = lib.registerEntry(makeMemoryInput());
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-style',
    version: '1.0.0',
    approvedBy: 'owner-local',
    expectedDigest: mem.approvalDigest,
  });

  assert.equal(
    lib.previewPromptContext({
      projectId: 'proj-alpha',
      entryIds: ['mem-style'],
    }).included.length,
    1,
  );

  const revoked = lib.revokeEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-style',
    revokedBy: 'owner-local',
    reason: 'Superseded by new project rules',
  });
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.approval, null);

  const afterRevoke = lib.previewPromptContext({
    projectId: 'proj-alpha',
    entryIds: ['mem-style'],
  });
  assert.equal(afterRevoke.included.length, 0);
  assert.equal(afterRevoke.promptText, '');
  assert.deepEqual(
    afterRevoke.excluded.map((item) => [item.entryId, item.reason]),
    [['mem-style', 'revoked']],
  );

  assert.throws(
    () =>
      lib.approveEntry({
        projectId: 'proj-alpha',
        entryId: 'mem-style',
        version: '1.0.0',
        approvedBy: 'owner-local',
        expectedDigest: mem.approvalDigest,
      }),
    /revoked/i,
  );

  assert.throws(
    () =>
      lib.proposeEntryVersion({
        projectId: 'proj-alpha',
        entryId: 'mem-style',
        content: 'Attempted resurrection',
        provenance: {
          selectionMode: 'explicit',
          sourceKind: 'owner-selected-file',
          sourceRef: 'docs/conventions.md',
          version: '2.0.0',
        },
      }),
    /revoked/i,
  );
});

test('produces deterministic canonical prompt preview and digests regardless of selection order', () => {
  const { clock } = makeClock(5_000_000);
  const lib = createProjectContextLibrary({ clock });

  const skillZ = lib.registerEntry(makeSkillInput({ entryId: 'skill-z' }));
  const memB = lib.registerEntry(makeMemoryInput({ entryId: 'mem-b', content: 'Memory B content.' }));
  const memA = lib.registerEntry(makeMemoryInput({ entryId: 'mem-a', content: 'Memory A content.' }));

  for (const entry of [skillZ, memB, memA]) {
    lib.approveEntry({
      projectId: 'proj-alpha',
      entryId: entry.entryId,
      version: '1.0.0',
      approvedBy: 'owner-local',
      expectedDigest: entry.approvalDigest,
    });
  }

  const previewForward = lib.previewPromptContext({
    projectId: 'proj-alpha',
    entryIds: ['mem-a', 'mem-b', 'skill-z'],
  });
  const previewReversed = lib.previewPromptContext({
    projectId: 'proj-alpha',
    entryIds: ['skill-z', 'mem-b', 'mem-a'],
  });

  assert.deepEqual(
    previewForward.included.map((item) => [item.kind, item.entryId]),
    [
      ['memory', 'mem-a'],
      ['memory', 'mem-b'],
      ['skill', 'skill-z'],
    ],
  );
  assert.equal(previewForward.promptText, previewReversed.promptText);
  assert.equal(previewForward.promptSha256, previewReversed.promptSha256);
  assert.equal(previewForward.previewDigest, previewReversed.previewDigest);
  assert.ok(Object.isFrozen(previewForward));
  assert.ok(Object.isFrozen(previewForward.included));
  assert.match(previewForward.promptText, /^\[context:memory:mem-a@1\.0\.0 sha256=[a-f0-9]{64}\]/m);
  assert.match(previewForward.promptText, /^capabilities: read-only-source$/m);

  assert.throws(
    () =>
      lib.previewPromptContext({
        projectId: 'proj-alpha',
        entryIds: ['mem-a', 'mem-a'],
      }),
    /duplicate/i,
  );
});

test('templates preserve inputs for review and never store or transfer executable approvals', () => {
  const { clock } = makeClock();
  const lib = createProjectContextLibrary({ clock });

  const memV1 = lib.registerEntry(makeMemoryInput());
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-style',
    version: '1.0.0',
    approvedBy: 'owner-local',
    expectedDigest: memV1.approvalDigest,
  });
  const skillV1 = lib.registerEntry(makeSkillInput());
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'skill-brief',
    version: '1.0.0',
    approvedBy: 'owner-local',
    expectedDigest: skillV1.approvalDigest,
  });

  for (const forbidden of [
    { approval: { approved: true } },
    { approved: true },
    { executableApproval: { approvalId: 'appr-1' } },
    { permissions: ['exec'] },
    { inputs: { requestText: 'Review brief', targetScopeLabels: ['docs'], selectedEntryRefs: [], approval: 'yes' } },
  ]) {
    assert.throws(
      () =>
        lib.createTaskTemplate({
          projectId: 'proj-alpha',
          templateId: 'tpl-bad',
          title: 'Bad template',
          workflowKind: 'brief',
          inputs: {
            requestText: 'Summarize synthetic release notes.',
            targetScopeLabels: ['release-notes'],
            selectedEntryRefs: [{ entryId: 'mem-style', pinnedVersion: '1.0.0' }],
          },
          ...forbidden,
        }),
      /approval|authority|forbidden|unknown/i,
    );
  }

  const template = lib.createTaskTemplate({
    projectId: 'proj-alpha',
    templateId: 'tpl-brief-weekly',
    title: 'Weekly synthetic brief',
    workflowKind: 'brief',
    inputs: {
      requestText: 'Summarize synthetic release notes with citations.',
      targetScopeLabels: ['docs/notes.md'],
      selectedEntryRefs: [
        { entryId: 'mem-style', pinnedVersion: '1.0.0' },
        { entryId: 'skill-brief', pinnedVersion: '1.0.0' },
      ],
    },
  });

  assert.equal(template.executableApproval, null);
  assert.equal(template.canAutoApprove, false);
  assert.equal(template.requiresOwnerApproval, true);
  assert.equal(template.authorityStatus, 'inputs-only-never-executable-approval');
  assert.ok(Object.isFrozen(template));

  const draft1 = lib.instantiateTemplateDraft({
    projectId: 'proj-alpha',
    templateId: 'tpl-brief-weekly',
  });
  assert.equal(draft1.draftOnly, true);
  assert.equal(draft1.executableApproval, null);
  assert.equal(draft1.canAutoApprove, false);
  assert.equal(draft1.requiresOwnerApproval, true);
  assert.equal(draft1.inputs.requestText, 'Summarize synthetic release notes with citations.');
  assert.deepEqual(
    draft1.contextPreview.included.map((item) => item.entryId),
    ['mem-style', 'skill-brief'],
  );

  // Version bump + approval of skill-brief v2 still excludes it from a template pinned to v1
  // and revoking mem-style excludes it immediately from template draft instantiation.
  const skillV2 = lib.proposeEntryVersion({
    projectId: 'proj-alpha',
    entryId: 'skill-brief',
    content: 'Updated v2 instructions.',
    requestedCapabilities: ['read-only-source'],
    provenance: {
      selectionMode: 'explicit',
      sourceKind: 'owner-authored',
      sourceRef: 'skills/brief-grounding.md',
      version: '2.0.0',
    },
  });
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'skill-brief',
    version: '2.0.0',
    approvedBy: 'owner-local',
    expectedDigest: skillV2.approvalDigest,
  });
  lib.revokeEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-style',
    revokedBy: 'owner-local',
    reason: 'No longer applicable',
  });

  const draft2 = lib.instantiateTemplateDraft({
    projectId: 'proj-alpha',
    templateId: 'tpl-brief-weekly',
  });
  assert.equal(draft2.contextPreview.included.length, 0);
  assert.equal(draft2.contextPreview.promptText, '');
  assert.deepEqual(
    draft2.entryChecks.map((check) => [check.entryId, check.eligible, check.reason]),
    [
      ['mem-style', false, 'revoked'],
      ['skill-brief', false, 'pinned-version-mismatch'],
    ],
  );

  assert.throws(
    () =>
      lib.instantiateTemplateDraft({
        projectId: 'proj-beta',
        templateId: 'tpl-brief-weekly',
      }),
    /not found/i,
  );
});

test('listEntries filters excluded entries when includeExcluded is false and capability changes invalidate approval', () => {
  const { clock, advance } = makeClock(2_000_000);
  const lib = createProjectContextLibrary({ clock });

  const memActive = lib.registerEntry(makeMemoryInput({ entryId: 'mem-active' }));
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-active',
    version: '1.0.0',
    approvedBy: 'owner-local',
    expectedDigest: memActive.approvalDigest,
  });

  lib.registerEntry(makeMemoryInput({ entryId: 'mem-pending' }));
  const memExpired = lib.registerEntry(makeMemoryInput({ entryId: 'mem-expired', expiresAt: 2_010_000 }));
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-expired',
    version: '1.0.0',
    approvedBy: 'owner-local',
    expectedDigest: memExpired.approvalDigest,
  });
  const skillReg = lib.registerEntry(makeSkillInput({ entryId: 'skill-cap-change' }));
  const skillV1 = lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'skill-cap-change',
    version: '1.0.0',
    approvedBy: 'owner-local',
    expectedDigest: skillReg.approvalDigest,
  });

  advance(15_000);

  assert.deepEqual(
    lib.listEntries({ projectId: 'proj-alpha', includeExcluded: false }).map((item) => item.entryId),
    ['mem-active', 'skill-cap-change'],
  );

  // Even with identical content, changing requestedCapabilities + version invalidates prior approval.
  const skillV2 = lib.proposeEntryVersion({
    projectId: 'proj-alpha',
    entryId: 'skill-cap-change',
    content: skillV1.content,
    requestedCapabilities: ['read-only-source', 'export-brief'],
    provenance: {
      selectionMode: 'explicit',
      sourceKind: 'owner-authored',
      sourceRef: 'skills/brief-grounding.md',
      version: '1.1.0',
    },
  });
  assert.notEqual(skillV2.approvalDigest, skillV1.approvalDigest);
  assert.equal(skillV2.status, 'pending-approval');
  assert.deepEqual(
    lib.listEntries({ projectId: 'proj-alpha', includeExcluded: false }).map((item) => item.entryId),
    ['mem-active'],
  );
});

test('template draft checks unapproved, expired, and kind-mismatched entry references', () => {
  const { clock, advance } = makeClock(3_000_000);
  const lib = createProjectContextLibrary({ clock });

  lib.registerEntry(makeMemoryInput({ entryId: 'mem-unapproved' }));
  const memExpiring = lib.registerEntry(makeMemoryInput({ entryId: 'mem-expiring', expiresAt: 3_005_000 }));
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-expiring',
    version: '1.0.0',
    approvedBy: 'owner-local',
    expectedDigest: memExpiring.approvalDigest,
  });
  const skillWrongKind = lib.registerEntry(makeSkillInput({ entryId: 'skill-wrong-kind' }));
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'skill-wrong-kind',
    version: '1.0.0',
    approvedBy: 'owner-local',
    expectedDigest: skillWrongKind.approvalDigest,
  });

  lib.createTaskTemplate({
    projectId: 'proj-alpha',
    templateId: 'tpl-checks',
    title: 'Template boundary check',
    workflowKind: 'change',
    inputs: {
      requestText: 'Review proposed change inputs.',
      targetScopeLabels: ['harness'],
      selectedEntryRefs: [
        { entryId: 'mem-unapproved', kind: 'memory' },
        { entryId: 'mem-expiring', kind: 'memory' },
        { entryId: 'skill-wrong-kind', kind: 'memory' },
        { entryId: 'mem-missing' },
      ],
    },
  });

  advance(6_000);

  const draft = lib.instantiateTemplateDraft({
    projectId: 'proj-alpha',
    templateId: 'tpl-checks',
  });
  assert.equal(draft.contextPreview.included.length, 0);
  assert.equal(draft.executableApproval, null);
  assert.deepEqual(
    draft.entryChecks.map((check) => [check.entryId, check.eligible, check.reason]),
    [
      ['mem-unapproved', false, 'unapproved'],
      ['mem-expiring', false, 'expired'],
      ['skill-wrong-kind', false, 'kind-mismatch'],
      ['mem-missing', false, 'not-found-in-project'],
    ],
  );
});

test('requires expectedDigest on approval and enforces immutable revision identity without version reuse', () => {
  const { clock } = makeClock();
  const lib = createProjectContextLibrary({ clock });

  const v1 = lib.registerEntry(makeSkillInput({ entryId: 'skill-immutable' }));
  assert.match(v1.revisionId, /^[a-f0-9]{64}$/);
  assert.equal(v1.revisionNumber, 1);

  assert.throws(
    () =>
      lib.approveEntry({
        projectId: 'proj-alpha',
        entryId: 'skill-immutable',
        version: '1.0.0',
        approvedBy: 'owner-local',
      }),
    /expectedDigest/i,
  );

  const approvedV1 = lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'skill-immutable',
    version: '1.0.0',
    approvedBy: 'owner-local',
    expectedDigest: v1.approvalDigest,
    expectedRevisionId: v1.revisionId,
  });
  assert.equal(approvedV1.approval.revisionId, v1.revisionId);

  const v2 = lib.proposeEntryVersion({
    projectId: 'proj-alpha',
    entryId: 'skill-immutable',
    content: 'v2 instructions.',
    requestedCapabilities: ['read-only-source'],
    provenance: {
      selectionMode: 'explicit',
      sourceKind: 'owner-authored',
      sourceRef: 'skills/brief-grounding.md',
      version: '2.0.0',
    },
  });
  assert.notEqual(v2.revisionId, v1.revisionId);
  assert.equal(v2.revisionNumber, 2);

  // Reusing previously used version label '1.0.0' must fail even after moving to '2.0.0'.
  assert.throws(
    () =>
      lib.proposeEntryVersion({
        projectId: 'proj-alpha',
        entryId: 'skill-immutable',
        content: 'Malicious replacement disguised as 1.0.0.',
        requestedCapabilities: ['read-only-source'],
        provenance: {
          selectionMode: 'explicit',
          sourceKind: 'owner-authored',
          sourceRef: 'skills/brief-grounding.md',
          version: '1.0.0',
        },
      }),
    /reused|immutable|version/i,
  );

  // Mismatched expectedRevisionId is rejected on approval even if digest matches.
  assert.throws(
    () =>
      lib.approveEntry({
        projectId: 'proj-alpha',
        entryId: 'skill-immutable',
        version: '2.0.0',
        approvedBy: 'owner-local',
        expectedDigest: v2.approvalDigest,
        expectedRevisionId: v1.revisionId,
      }),
    /revision/i,
  );

  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'skill-immutable',
    version: '2.0.0',
    approvedBy: 'owner-local',
    expectedDigest: v2.approvalDigest,
    expectedRevisionId: v2.revisionId,
  });

  // Template pinning by digest/revisionId rejects mismatched revisions.
  lib.createTaskTemplate({
    projectId: 'proj-alpha',
    templateId: 'tpl-pinned-v1',
    title: 'Pinned to v1 revision',
    workflowKind: 'brief',
    inputs: {
      requestText: 'Use v1 only.',
      targetScopeLabels: ['docs'],
      selectedEntryRefs: [
        {
          entryId: 'skill-immutable',
          pinnedVersion: '1.0.0',
          pinnedDigest: v1.approvalDigest,
          pinnedRevisionId: v1.revisionId,
        },
      ],
    },
  });
  const pinnedDraft = lib.instantiateTemplateDraft({
    projectId: 'proj-alpha',
    templateId: 'tpl-pinned-v1',
  });
  assert.equal(pinnedDraft.contextPreview.included.length, 0);
  assert.equal(pinnedDraft.entryChecks[0].reason, 'pinned-version-mismatch');

  // Digest and revision pins are each exercised independently with the version
  // pin matching the current version (or absent), so an earlier version
  // mismatch cannot mask them.
  const pinCases = [
    {
      templateId: 'tpl-pin-digest-only',
      ref: { entryId: 'skill-immutable', pinnedDigest: v1.approvalDigest },
      reason: 'pinned-digest-mismatch',
    },
    {
      templateId: 'tpl-pin-digest-current-version',
      ref: { entryId: 'skill-immutable', pinnedVersion: '2.0.0', pinnedDigest: v1.approvalDigest },
      reason: 'pinned-digest-mismatch',
    },
    {
      templateId: 'tpl-pin-revision-only',
      ref: { entryId: 'skill-immutable', pinnedRevisionId: v1.revisionId },
      reason: 'pinned-revision-mismatch',
    },
    {
      templateId: 'tpl-pin-revision-current-digest',
      ref: {
        entryId: 'skill-immutable',
        pinnedVersion: '2.0.0',
        pinnedDigest: v2.approvalDigest,
        pinnedRevisionId: v1.revisionId,
      },
      reason: 'pinned-revision-mismatch',
    },
  ];
  for (const pinCase of pinCases) {
    lib.createTaskTemplate({
      projectId: 'proj-alpha',
      templateId: pinCase.templateId,
      title: 'Independent pin check',
      workflowKind: 'brief',
      inputs: {
        requestText: 'Check one pin at a time.',
        targetScopeLabels: ['docs'],
        selectedEntryRefs: [pinCase.ref],
      },
    });
    const draft = lib.instantiateTemplateDraft({
      projectId: 'proj-alpha',
      templateId: pinCase.templateId,
    });
    assert.equal(draft.contextPreview.included.length, 0, pinCase.templateId);
    assert.deepEqual(
      draft.entryChecks.map((check) => [check.entryId, check.eligible, check.reason]),
      [['skill-immutable', false, pinCase.reason]],
      pinCase.templateId,
    );
  }

  // Positive control: all pins matching the current revision are eligible.
  lib.createTaskTemplate({
    projectId: 'proj-alpha',
    templateId: 'tpl-pin-all-current',
    title: 'All pins current',
    workflowKind: 'brief',
    inputs: {
      requestText: 'Use current revision.',
      targetScopeLabels: ['docs'],
      selectedEntryRefs: [
        {
          entryId: 'skill-immutable',
          pinnedVersion: '2.0.0',
          pinnedDigest: v2.approvalDigest,
          pinnedRevisionId: v2.revisionId,
        },
      ],
    },
  });
  const currentDraft = lib.instantiateTemplateDraft({
    projectId: 'proj-alpha',
    templateId: 'tpl-pin-all-current',
  });
  assert.deepEqual(
    currentDraft.entryChecks.map((check) => [check.entryId, check.eligible, check.reason]),
    [['skill-immutable', true, 'approved']],
  );
  assert.equal(currentDraft.contextPreview.included.length, 1);
  assert.equal(currentDraft.contextPreview.included[0].revisionId, v2.revisionId);
});

test('binds sourceHash into approvalDigest while labeling sourceHash provenance unverified', () => {
  const { clock } = makeClock();
  const lib = createProjectContextLibrary({ clock });
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);

  const entryA = lib.registerEntry(
    makeMemoryInput({
      entryId: 'mem-source-a',
      provenance: {
        selectionMode: 'explicit',
        sourceKind: 'owner-selected-file',
        sourceRef: 'docs/conventions.md',
        version: '1.0.0',
        sourceHash: hashA,
      },
    }),
  );
  const entryB = lib.registerEntry(
    makeMemoryInput({
      entryId: 'mem-source-b',
      provenance: {
        selectionMode: 'explicit',
        sourceKind: 'owner-selected-file',
        sourceRef: 'docs/conventions.md',
        version: '1.0.0',
        sourceHash: hashB,
      },
    }),
  );
  const entryNone = lib.registerEntry(
    makeMemoryInput({
      entryId: 'mem-source-none',
    }),
  );

  // entryA, entryB and entryNone differ in entryId as well as sourceHash, so
  // comparing them alone cannot prove sourceHash is bound. Register the same
  // entryId with identical project, kind, content, version, sourceRef and
  // clock in isolated libraries, varying only sourceHash.
  const fixedEntryId = 'mem-source-fixed';
  const registerFixed = (sourceHash) => {
    const isolated = createProjectContextLibrary({ clock: makeClock().clock });
    const provenance = {
      selectionMode: 'explicit',
      sourceKind: 'owner-selected-file',
      sourceRef: 'docs/conventions.md',
      version: '1.0.0',
    };
    if (sourceHash !== undefined) {
      provenance.sourceHash = sourceHash;
    }
    return isolated.registerEntry(makeMemoryInput({ entryId: fixedEntryId, provenance }));
  };
  const fixedA = registerFixed(hashA);
  const fixedA2 = registerFixed(hashA);
  const fixedB = registerFixed(hashB);
  const fixedNone = registerFixed(undefined);
  for (const fixed of [fixedA, fixedA2, fixedB, fixedNone]) {
    assert.equal(fixed.entryId, fixedEntryId);
    assert.equal(fixed.projectId, 'proj-alpha');
    assert.equal(fixed.version, '1.0.0');
    assert.equal(fixed.revisionNumber, 1);
    assert.equal(fixed.contentSha256, fixedA.contentSha256);
    assert.equal(fixed.createdAt, fixedA.createdAt);
  }
  // Same inputs produce the same digest, so the differences below come only from sourceHash.
  assert.equal(fixedA.approvalDigest, fixedA2.approvalDigest);
  assert.equal(fixedA.revisionId, fixedA2.revisionId);
  assert.notEqual(fixedA.approvalDigest, fixedB.approvalDigest);
  assert.notEqual(fixedA.approvalDigest, fixedNone.approvalDigest);
  assert.notEqual(fixedB.approvalDigest, fixedNone.approvalDigest);
  assert.notEqual(fixedA.revisionId, fixedB.revisionId);

  assert.notEqual(entryA.approvalDigest, entryB.approvalDigest);
  assert.notEqual(entryA.approvalDigest, entryNone.approvalDigest);
  assert.equal(entryA.provenance.sourceHash, hashA);
  assert.equal(entryA.provenance.sourceHashStatus, 'claimed-unverified');
  assert.equal(entryA.provenance.sourceHashVerified, false);

  assert.throws(
    () =>
      lib.approveEntry({
        projectId: 'proj-alpha',
        entryId: 'mem-source-a',
        version: '1.0.0',
        approvedBy: 'owner-local',
        expectedDigest: entryNone.approvalDigest,
      }),
    /digest/i,
  );

  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-source-a',
    version: '1.0.0',
    approvedBy: 'owner-local',
    expectedDigest: entryA.approvalDigest,
  });

  const preview = lib.previewPromptContext({
    projectId: 'proj-alpha',
    entryIds: ['mem-source-a'],
  });
  assert.equal(preview.included[0].provenance.sourceHash, hashA);
  assert.equal(preview.included[0].provenance.sourceHashStatus, 'claimed-unverified');
  assert.equal(preview.included[0].provenance.sourceHashVerified, false);
});

test('enforces aggregate preview byte budget aligned with shared 256 KiB hasher limit', () => {
  const { clock } = makeClock();
  const lib = createProjectContextLibrary({ clock });

  // Register 4 entries of 64 KiB (each individually <= 65536 bytes) and 1 small entry
  // sized to hit the exact 262144-byte aggregate rendered preview boundary vs 262145 bytes.
  const largeIds = ['mem-big-1', 'mem-big-2', 'mem-big-3', 'mem-big-4'];
  for (const entryId of largeIds) {
    const entry = lib.registerEntry(
      makeMemoryInput({
        entryId,
        content: 'x'.repeat(65536),
      }),
    );
    lib.approveEntry({
      projectId: 'proj-alpha',
      entryId,
      version: '1.0.0',
      approvedBy: 'owner-local',
      expectedDigest: entry.approvalDigest,
    });
  }

  // Four 64 KiB entries plus framing exceed 262144 bytes and must fail with an explicit budget error,
  // not an internal hasher TypeError.
  assert.throws(
    () =>
      lib.previewPromptContext({
        projectId: 'proj-alpha',
        entryIds: largeIds,
      }),
    /maxPreviewPromptBytes|preview.*budget|exceeds/i,
  );

  // Measure the exact framing overhead of 4 entries so we test 262144 bytes (pass) vs 262145 bytes (fail).
  const probe = lib.previewPromptContext({
    projectId: 'proj-alpha',
    entryIds: ['mem-big-1', 'mem-big-2', 'mem-big-3'],
  });
  const threeEntriesBytes = Buffer.byteLength(probe.promptText, 'utf8');
  const fillerEntryBase = lib.registerEntry(
    makeMemoryInput({
      entryId: 'mem-exact-fit',
      content: 'a',
    }),
  );
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-exact-fit',
    version: '1.0.0',
    approvedBy: 'owner-local',
    expectedDigest: fillerEntryBase.approvalDigest,
  });
  const fourProbe = lib.previewPromptContext({
    projectId: 'proj-alpha',
    entryIds: ['mem-big-1', 'mem-big-2', 'mem-big-3', 'mem-exact-fit'],
  });
  const baseFourBytes = Buffer.byteLength(fourProbe.promptText, 'utf8');
  const remainingForExact256KiB = 262144 - baseFourBytes + 1;
  assert.ok(remainingForExact256KiB > 1 && remainingForExact256KiB <= 65536);

  const exactFitV2 = lib.proposeEntryVersion({
    projectId: 'proj-alpha',
    entryId: 'mem-exact-fit',
    content: 'a'.repeat(remainingForExact256KiB),
    provenance: {
      selectionMode: 'explicit',
      sourceKind: 'owner-selected-file',
      sourceRef: 'docs/conventions.md',
      version: '2.0.0',
    },
  });
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-exact-fit',
    version: '2.0.0',
    approvedBy: 'owner-local',
    expectedDigest: exactFitV2.approvalDigest,
  });

  const exactPreview = lib.previewPromptContext({
    projectId: 'proj-alpha',
    entryIds: ['mem-big-1', 'mem-big-2', 'mem-big-3', 'mem-exact-fit'],
  });
  assert.equal(Buffer.byteLength(exactPreview.promptText, 'utf8'), 262144);
  assert.ok(threeEntriesBytes < 262144);
  assert.match(exactPreview.promptSha256, /^[a-f0-9]{64}$/);

  const overByOneV3 = lib.proposeEntryVersion({
    projectId: 'proj-alpha',
    entryId: 'mem-exact-fit',
    content: 'a'.repeat(remainingForExact256KiB + 1),
    provenance: {
      selectionMode: 'explicit',
      sourceKind: 'owner-selected-file',
      sourceRef: 'docs/conventions.md',
      version: '3.0.0',
    },
  });
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-exact-fit',
    version: '3.0.0',
    approvedBy: 'owner-local',
    expectedDigest: overByOneV3.approvalDigest,
  });

  assert.throws(
    () =>
      lib.previewPromptContext({
        projectId: 'proj-alpha',
        entryIds: ['mem-big-1', 'mem-big-2', 'mem-big-3', 'mem-exact-fit'],
      }),
    /maxPreviewPromptBytes|preview.*budget|exceeds/i,
  );

  lib.createTaskTemplate({
    projectId: 'proj-alpha',
    templateId: 'tpl-over-budget',
    title: 'Over aggregate preview budget',
    workflowKind: 'brief',
    inputs: {
      requestText: 'Check aggregate budget failure.',
      targetScopeLabels: ['docs'],
      selectedEntryRefs: [
        { entryId: 'mem-big-1', pinnedVersion: '1.0.0' },
        { entryId: 'mem-big-2', pinnedVersion: '1.0.0' },
        { entryId: 'mem-big-3', pinnedVersion: '1.0.0' },
        { entryId: 'mem-exact-fit', pinnedVersion: '3.0.0' },
      ],
    },
  });
  assert.throws(
    () =>
      lib.instantiateTemplateDraft({
        projectId: 'proj-alpha',
        templateId: 'tpl-over-budget',
      }),
    /maxPreviewPromptBytes|preview.*budget|exceeds/i,
  );
});

test('instantiateTemplateDraft samples clock once so eligibility and preview agree at expiry boundary', () => {
  let tick = 10_000;
  const lib = createProjectContextLibrary({ clock: () => tick++ });

  // tick 10000: registerEntry
  const entry = lib.registerEntry(
    makeMemoryInput({
      entryId: 'mem-tick-boundary',
      expiresAt: 10_003,
    }),
  );
  // tick 10001: approveEntry
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-tick-boundary',
    version: '1.0.0',
    approvedBy: 'owner-local',
    expectedDigest: entry.approvalDigest,
  });
  // tick 10002: createTaskTemplate (with single-tick clock, next call is 10002 -> wait, createTaskTemplate takes tick 10002!)
  lib.createTaskTemplate({
    projectId: 'proj-alpha',
    templateId: 'tpl-tick',
    title: 'Tick boundary template',
    workflowKind: 'brief',
    inputs: {
      requestText: 'Check single evaluation timestamp.',
      targetScopeLabels: ['docs'],
      selectedEntryRefs: [{ entryId: 'mem-tick-boundary', pinnedVersion: '1.0.0' }],
    },
  });

  // Reset tick to 10002 right before expiresAt (10003):
  // The first clock read returns 10002 (eligible), and a second clock read would return 10003 (expired!).
  // Single evaluation time ensures both entryChecks and contextPreview evaluate at 10002 and agree.
  tick = 10_002;
  const draft = lib.instantiateTemplateDraft({
    projectId: 'proj-alpha',
    templateId: 'tpl-tick',
  });
  assert.equal(draft.evaluatedAt, 10_002);
  assert.equal(draft.contextPreview.evaluatedAt, 10_002);
  assert.equal(draft.entryChecks[0].eligible, true);
  assert.equal(draft.contextPreview.included.length, 1);
  assert.equal(draft.contextPreview.excluded.length, 0);
});

test('validates dense arrays without invoking caller accessors, holes, or overridden array methods', () => {
  const { clock } = makeClock();
  const lib = createProjectContextLibrary({ clock });

  const mem = lib.registerEntry(makeMemoryInput());
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-style',
    version: '1.0.0',
    approvedBy: 'owner-local',
    expectedDigest: mem.approvalDigest,
  });

  // 1. Accessor element on entryIds must never be invoked.
  let invoked = false;
  const accessorIds = [];
  Object.defineProperty(accessorIds, '0', {
    enumerable: true,
    get() {
      invoked = true;
      return 'mem-style';
    },
  });
  assert.throws(
    () => lib.previewPromptContext({ projectId: 'proj-alpha', entryIds: accessorIds }),
    /dense|accessor/i,
  );
  assert.equal(invoked, false);

  // 2. Sparse array with hole must be rejected.
  // eslint-disable-next-line no-sparse-arrays
  const sparseIds = [, 'mem-style'];
  assert.throws(
    () => lib.previewPromptContext({ projectId: 'proj-alpha', entryIds: sparseIds }),
    /dense|accessor/i,
  );

  // 3. Array with overridden .map or extra own property must be rejected without calling .map.
  const evilScopeLabels = ['docs/notes.md'];
  let mapCalled = false;
  Object.defineProperty(evilScopeLabels, 'map', {
    value() {
      mapCalled = true;
      return ['hijacked'];
    },
  });
  assert.throws(
    () =>
      lib.createTaskTemplate({
        projectId: 'proj-alpha',
        templateId: 'tpl-evil-map',
        title: 'Evil map test',
        workflowKind: 'brief',
        inputs: {
          requestText: 'Check array safety.',
          targetScopeLabels: evilScopeLabels,
          selectedEntryRefs: [],
        },
      }),
    /dense|extra/i,
  );
  assert.equal(mapCalled, false);

  // 4. Accessor element on requestedCapabilities must never be invoked.
  const evilCaps = [];
  Object.defineProperty(evilCaps, '0', {
    enumerable: true,
    get() {
      invoked = true;
      return 'read-only-source';
    },
  });
  assert.throws(
    () => lib.registerEntry(makeSkillInput({ entryId: 'skill-evil-cap', requestedCapabilities: evilCaps })),
    /dense|accessor/i,
  );
  assert.equal(invoked, false);

  // 5. Overridden .map on selectedEntryRefs must be rejected without invoking it.
  const evilRefs = [{ entryId: 'mem-style', pinnedVersion: '1.0.0' }];
  Object.defineProperty(evilRefs, 'map', {
    value() {
      mapCalled = true;
      return [];
    },
  });
  assert.throws(
    () =>
      lib.createTaskTemplate({
        projectId: 'proj-alpha',
        templateId: 'tpl-evil-refs',
        title: 'Evil refs test',
        workflowKind: 'brief',
        inputs: {
          requestText: 'Check refs array safety.',
          targetScopeLabels: ['docs'],
          selectedEntryRefs: evilRefs,
        },
      }),
    /dense|extra/i,
  );
  assert.equal(mapCalled, false);
});

function approveCurrent(lib, snapshot) {
  return lib.approveEntry({
    projectId: snapshot.projectId,
    entryId: snapshot.entryId,
    version: snapshot.version,
    approvedBy: 'owner-local',
    expectedDigest: snapshot.approvalDigest,
  });
}

function makeSkillProposal(entryId, version, content, requestedCapabilities) {
  return {
    projectId: 'proj-alpha',
    entryId,
    content,
    requestedCapabilities,
    provenance: {
      selectionMode: 'explicit',
      sourceKind: 'owner-authored',
      sourceRef: 'skills/brief-grounding.md',
      version,
    },
  };
}

test('reentrant proposal from a caller Proxy trap cannot reuse a version', () => {
  const lib = createProjectContextLibrary({ clock: makeClock().clock });
  const v1 = lib.registerEntry(makeSkillInput({ entryId: 'skill-reentrant' }));
  approveCurrent(lib, v1);

  // Variant A: the trap fires during capability array inspection, which the
  // previous implementation performed after the version-reuse check. The trap
  // attempts a nested proposal of the same version and swallows any error.
  let nestedError = null;
  let trapCalls = 0;
  const swallowingCaps = new Proxy(['read-only-source'], {
    ownKeys(target) {
      trapCalls += 1;
      try {
        lib.proposeEntryVersion(
          makeSkillProposal('skill-reentrant', '2.0.0', 'Nested replacement content.', ['read-only-source']),
        );
      } catch (error) {
        nestedError = error;
      }
      return Reflect.ownKeys(target);
    },
  });
  const outer = lib.proposeEntryVersion(
    makeSkillProposal('skill-reentrant', '2.0.0', 'Outer v2 content.', swallowingCaps),
  );
  assert.ok(trapCalls >= 1);
  assert.ok(nestedError instanceof Error);
  assert.match(nestedError.message, /reentrant/);
  assert.equal(outer.version, '2.0.0');
  assert.equal(outer.revisionNumber, 2);
  assert.equal(outer.content, 'Outer v2 content.');
  assert.deepEqual(outer.usedVersions, ['1.0.0', '2.0.0']);
  const afterA = lib.getEntry({ projectId: 'proj-alpha', entryId: 'skill-reentrant' });
  assert.equal(afterA.revisionNumber, 2);
  assert.equal(afterA.content, 'Outer v2 content.');
  assert.equal(afterA.revisionId, outer.revisionId);
  assert.equal(afterA.approvalDigest, outer.approvalDigest);
  assert.equal(afterA.status, 'pending-approval');
  assert.throws(
    () =>
      lib.proposeEntryVersion(
        makeSkillProposal('skill-reentrant', '2.0.0', 'Second 2.0.0 attempt.', ['read-only-source']),
      ),
    /version/i,
  );

  // Variant B: the nested error propagates out of the trap. The outer
  // proposal fails and leaves state unchanged; the version stays unused.
  const before = lib.getEntry({ projectId: 'proj-alpha', entryId: 'skill-reentrant' });
  const propagatingCaps = new Proxy(['read-only-source'], {
    ownKeys(target) {
      lib.proposeEntryVersion(
        makeSkillProposal('skill-reentrant', '3.0.0', 'Nested v3 content.', ['read-only-source']),
      );
      return Reflect.ownKeys(target);
    },
  });
  assert.throws(
    () =>
      lib.proposeEntryVersion(
        makeSkillProposal('skill-reentrant', '3.0.0', 'Outer v3 content.', propagatingCaps),
      ),
    /reentrant/,
  );
  assert.deepEqual(lib.getEntry({ projectId: 'proj-alpha', entryId: 'skill-reentrant' }), before);

  const v3 = lib.proposeEntryVersion(
    makeSkillProposal('skill-reentrant', '3.0.0', 'Plain v3 content.', ['read-only-source']),
  );
  assert.equal(v3.revisionNumber, 3);
  assert.deepEqual(v3.usedVersions, ['1.0.0', '2.0.0', '3.0.0']);
});

test('reentrant preview selection trap cannot invalidate an already admitted item', () => {
  const lib = createProjectContextLibrary({ clock: makeClock().clock });
  const memA = lib.registerEntry(makeMemoryInput({ entryId: 'mem-a', content: 'Alpha admitted content.' }));
  const memB = lib.registerEntry(makeMemoryInput({ entryId: 'mem-b', content: 'Bravo admitted content.' }));
  approveCurrent(lib, memA);
  approveCurrent(lib, memB);

  // The second selection is an object whose traps run after the first
  // selection would previously have been admitted. They try to revoke mem-a
  // and to replace it with a new version, swallowing any error.
  const nestedErrors = [];
  const laterSelection = new Proxy(
    { entryId: 'mem-b' },
    {
      ownKeys(target) {
        try {
          lib.revokeEntry({ projectId: 'proj-alpha', entryId: 'mem-a', revokedBy: 'owner-local' });
        } catch (error) {
          nestedErrors.push(error);
        }
        try {
          lib.proposeEntryVersion({
            projectId: 'proj-alpha',
            entryId: 'mem-a',
            content: 'Replacement content.',
            provenance: {
              selectionMode: 'explicit',
              sourceKind: 'owner-selected-file',
              sourceRef: 'docs/conventions.md',
              version: '2.0.0',
            },
          });
        } catch (error) {
          nestedErrors.push(error);
        }
        return Reflect.ownKeys(target);
      },
    },
  );
  const preview = lib.previewPromptContext({
    projectId: 'proj-alpha',
    entryIds: ['mem-a', laterSelection],
  });
  assert.equal(nestedErrors.length, 2);
  for (const error of nestedErrors) {
    assert.match(error.message, /reentrant/);
  }
  assert.deepEqual(
    preview.included.map((item) => item.entryId),
    ['mem-a', 'mem-b'],
  );
  assert.deepEqual(preview.excluded, []);

  // Every admitted item still matches current, approved, unrevoked state.
  for (const item of preview.included) {
    const current = lib.getEntry({ projectId: 'proj-alpha', entryId: item.entryId });
    assert.equal(current.status, 'approved');
    assert.equal(current.revoked, false);
    assert.equal(current.version, item.version);
    assert.equal(current.revisionId, item.revisionId);
    assert.equal(current.approvalDigest, item.approvalDigest);
    assert.equal(current.approval.approvalId, item.approvalId);
    assert.equal(current.content, item.content);
  }
  assert.match(preview.promptText, /Alpha admitted content\./);
  assert.doesNotMatch(preview.promptText, /Replacement content\./);

  // A propagating trap fails the whole preview and leaves mem-a approved.
  const propagatingSelection = new Proxy(
    { entryId: 'mem-b' },
    {
      ownKeys(target) {
        lib.revokeEntry({ projectId: 'proj-alpha', entryId: 'mem-a', revokedBy: 'owner-local' });
        return Reflect.ownKeys(target);
      },
    },
  );
  assert.throws(
    () =>
      lib.previewPromptContext({
        projectId: 'proj-alpha',
        entryIds: ['mem-a', propagatingSelection],
      }),
    /reentrant/,
  );
  const memAAfter = lib.getEntry({ projectId: 'proj-alpha', entryId: 'mem-a' });
  assert.equal(memAAfter.status, 'approved');
  assert.equal(memAAfter.revoked, false);
});

test('copies caller input into inert data before sampling the clock and never invokes get traps', () => {
  const events = [];
  const base = makeClock();
  let reenter = null;
  const lib = createProjectContextLibrary({
    clock: () => {
      events.push('clock');
      if (reenter) {
        const callback = reenter;
        reenter = null;
        callback();
      }
      return base.clock();
    },
  });
  const mem = lib.registerEntry(makeMemoryInput());
  approveCurrent(lib, mem);

  let getTrapCalls = 0;
  const handler = {
    get(target, key, receiver) {
      getTrapCalls += 1;
      return Reflect.get(target, key, receiver);
    },
    getPrototypeOf(target) {
      events.push('trap');
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      events.push('trap');
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      events.push('trap');
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  };
  events.length = 0;
  const preview = lib.previewPromptContext(
    new Proxy(
      {
        projectId: 'proj-alpha',
        entryIds: new Proxy([new Proxy({ entryId: 'mem-style' }, handler)], handler),
      },
      handler,
    ),
  );
  assert.equal(preview.included.length, 1);
  assert.equal(getTrapCalls, 0);
  const firstClock = events.indexOf('clock');
  assert.ok(firstClock > 0);
  assert.ok(events.slice(0, firstClock).every((event) => event === 'trap'));
  assert.ok(events.slice(firstClock).every((event) => event === 'clock'));

  // An injected clock that calls back into the library is rejected as reentrant.
  reenter = () => lib.revokeEntry({ projectId: 'proj-alpha', entryId: 'mem-style', revokedBy: 'owner-local' });
  assert.throws(
    () => lib.previewPromptContext({ projectId: 'proj-alpha', entryIds: ['mem-style'] }),
    /reentrant/,
  );
  assert.equal(lib.getEntry({ projectId: 'proj-alpha', entryId: 'mem-style' }).status, 'approved');

  // The data-only boundary rejects functions and excessive nesting.
  assert.throws(
    () => lib.previewPromptContext({ projectId: 'proj-alpha', entryIds: [() => 'mem-style'] }),
    /plain data/,
  );
  let deep = { entryId: 'mem-style' };
  for (let i = 0; i < 6; i++) {
    deep = { entryId: deep };
  }
  assert.throws(
    () => lib.previewPromptContext({ projectId: 'proj-alpha', entryIds: [deep] }),
    /nesting depth/,
  );
});

test('bounds oversized strings before validation scans, UTF-8 encoding, clock, or state', () => {
  let clockCalls = 0;
  const base = makeClock();
  const lib = createProjectContextLibrary({
    clock: () => {
      clockCalls += 1;
      return base.clock();
    },
  });

  // A very large string is rejected at the data-only boundary, before the
  // clock is sampled, so no validation, regex scan, or UTF-8 encoding runs.
  const huge = 'x'.repeat(2 ** 24);
  clockCalls = 0;
  assert.throws(
    () => lib.registerEntry(makeMemoryInput({ entryId: 'mem-huge', content: huge })),
    /maximum string length/,
  );
  assert.throws(
    () => lib.previewPromptContext({ projectId: 'proj-alpha', entryIds: [huge] }),
    /maximum string length/,
  );
  assert.equal(clockCalls, 0);
  assert.equal(lib.getEntry({ projectId: 'proj-alpha', entryId: 'mem-huge' }), null);

  // One code unit over the content limit fails at the boundary too.
  assert.throws(
    () => lib.registerEntry(makeMemoryInput({ entryId: 'mem-over', content: 'x'.repeat(65537) })),
    /exceeds/,
  );

  // A field with a smaller byte limit is length-checked before the
  // well-formedness scan: an over-length string containing a lone surrogate
  // reports the length bound, not the Unicode error.
  const registerTemplate = (templateId, requestText) =>
    lib.createTaskTemplate({
      projectId: 'proj-alpha',
      templateId,
      title: 'Request bound check',
      workflowKind: 'brief',
      inputs: { requestText, targetScopeLabels: ['docs'], selectedEntryRefs: [] },
    });
  assert.throws(() => registerTemplate('tpl-request-over', `${'r'.repeat(16384)}\uD800`), /exceeds allowed byte length/);
  assert.throws(() => registerTemplate('tpl-request-surrogate', 'short \uD800'), /^Error: Invalid template\.inputs\.requestText\.$/);
  assert.equal(registerTemplate('tpl-request-exact', 'r'.repeat(16384)).inputs.requestText.length, 16384);

  // Multibyte content within the code-unit bound is still checked by UTF-8 bytes.
  const exactTwoByte = 'é'.repeat(32768);
  assert.equal(Buffer.byteLength(exactTwoByte, 'utf8'), 65536);
  const fits = lib.registerEntry(makeMemoryInput({ entryId: 'mem-two-byte-exact', content: exactTwoByte }));
  assert.equal(fits.content.length, 32768);
  assert.throws(
    () => lib.registerEntry(makeMemoryInput({ entryId: 'mem-two-byte-over', content: `${exactTwoByte}é` })),
    /exceeds allowed byte length/,
  );
});

test('rejects Proxy arrays whose reported keys are not exactly the canonical indexes', () => {
  const lib = createProjectContextLibrary({ clock: makeClock().clock });
  approveCurrent(lib, lib.registerEntry(makeMemoryInput({ entryId: 'mem-style' })));
  approveCurrent(lib, lib.registerEntry(makeMemoryInput({ entryId: 'mem-other' })));

  const withKeys = (keys) =>
    new Proxy(['mem-style', 'mem-other'], {
      ownKeys() {
        return keys;
      },
    });

  // Each list has length + 1 entries and includes "length", which the
  // previous count-and-numeric check accepted for non-index keys.
  for (const keys of [
    ['0', '-1', 'length'],
    ['0', '0.5', 'length'],
    ['0', '01', 'length'],
    ['0', '2', 'length'],
    ['0', 'NaN', 'length'],
  ]) {
    assert.throws(
      () => lib.previewPromptContext({ projectId: 'proj-alpha', entryIds: withKeys(keys) }),
      /dense|extra/,
      keys.join(','),
    );
  }

  // Positive control: exactly the canonical keys, in any order, is accepted.
  const preview = lib.previewPromptContext({
    projectId: 'proj-alpha',
    entryIds: withKeys(['length', '1', '0']),
  });
  assert.deepEqual(
    preview.included.map((item) => item.entryId),
    ['mem-other', 'mem-style'],
  );
});
