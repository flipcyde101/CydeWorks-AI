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
  });
  assert.equal(approvedMem.status, 'approved');
  assert.equal(approvedMem.approval.version, '1.0.0');
  assert.equal(approvedMem.approval.approvalDigest, approvedMem.approvalDigest);

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

  lib.registerEntry(
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
  });

  lib.registerEntry(
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

  lib.registerEntry(
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
        expiresAt: 1_090_000,
      }),
    /expired/i,
  );
});

test('revocation immediately excludes entry and blocks subsequent approvals or revisions', () => {
  const { clock } = makeClock();
  const lib = createProjectContextLibrary({ clock });

  lib.registerEntry(makeMemoryInput());
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-style',
    version: '1.0.0',
    approvedBy: 'owner-local',
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

  lib.registerEntry(makeSkillInput({ entryId: 'skill-z' }));
  lib.registerEntry(makeMemoryInput({ entryId: 'mem-b', content: 'Memory B content.' }));
  lib.registerEntry(makeMemoryInput({ entryId: 'mem-a', content: 'Memory A content.' }));

  for (const entryId of ['skill-z', 'mem-b', 'mem-a']) {
    lib.approveEntry({
      projectId: 'proj-alpha',
      entryId,
      version: '1.0.0',
      approvedBy: 'owner-local',
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

  lib.registerEntry(makeMemoryInput());
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-style',
    version: '1.0.0',
    approvedBy: 'owner-local',
  });
  lib.registerEntry(makeSkillInput());
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'skill-brief',
    version: '1.0.0',
    approvedBy: 'owner-local',
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
  lib.proposeEntryVersion({
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

  lib.registerEntry(makeMemoryInput({ entryId: 'mem-active' }));
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-active',
    version: '1.0.0',
    approvedBy: 'owner-local',
  });

  lib.registerEntry(makeMemoryInput({ entryId: 'mem-pending' }));
  lib.registerEntry(makeMemoryInput({ entryId: 'mem-expired', expiresAt: 2_010_000 }));
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-expired',
    version: '1.0.0',
    approvedBy: 'owner-local',
  });
  lib.registerEntry(makeSkillInput({ entryId: 'skill-cap-change' }));
  const skillV1 = lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'skill-cap-change',
    version: '1.0.0',
    approvedBy: 'owner-local',
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
  lib.registerEntry(makeMemoryInput({ entryId: 'mem-expiring', expiresAt: 3_005_000 }));
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'mem-expiring',
    version: '1.0.0',
    approvedBy: 'owner-local',
  });
  lib.registerEntry(makeSkillInput({ entryId: 'skill-wrong-kind' }));
  lib.approveEntry({
    projectId: 'proj-alpha',
    entryId: 'skill-wrong-kind',
    version: '1.0.0',
    approvedBy: 'owner-local',
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

