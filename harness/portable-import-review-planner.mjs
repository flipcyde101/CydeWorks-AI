// Pure import-review planner for CydeWorks AI portable task-handoff manifests.
// Distinguishes manifest hash claims, caller-supplied hash claims, claim-only
// conflicts, and verified artifact bytes; identifies missing, unverified,
// claim-conflicting, and byte-mismatched artifacts; requires fresh owner scope
// review; proposes only the draft destination state; and never transfers
// authority.

import {
  DESTINATION_TASK_STATE,
  HANDOFF_SCHEMA_VERSION,
  IMPORT_REVIEW_CONTEXT_CONTRACT,
  LIMITS,
  deepFreeze,
  staticIssue,
} from './portable-manifest-contract.mjs';
import { checkSpec, validateHandoffManifest } from './portable-handoff-validator.mjs';
import { getUint8ArrayByteLength, isBoundedUint8Array, sha256Hex } from './portable-sha256.mjs';

const NON_TRANSFERRED_AUTHORITY = deepFreeze({
  approvals: 'never-transferred',
  permissions: 'never-transferred',
  authentication: 'never-transferred',
  acceptance: 'never-transferred',
  modelQualification: 'never-transferred',
  hostAttestation: 'never-transferred',
  terminalControl: 'never-transferred',
  runningSessions: 'never-transferred',
});

const PRIVACY_REVIEW_NOTICE = deepFreeze({
  valueScrubbingGuaranteed: false,
  requiresOwnerPreviewBeforeExternalSharing: true,
  labelsTrust: 'untrusted-text',
  renderMode: 'plain-text-only',
  scopeNote: 'Closed keys and heuristic pattern checks are not a semantic privacy scrubber; allowed labels and identifiers can still carry sensitive filenames, network notes, or source excerpts.',
});

function pushIssue(issues, path, code) {
  if (issues.length < LIMITS.maxIssues) {
    issues.push(staticIssue(path, code));
  }
}

function untrustedLabelEnvelope(text) {
  return {
    text,
    trust: 'untrusted-text',
    renderMode: 'plain-text-only',
  };
}

function crossCheckContext(manifest, context, issues, computedDigestsByIndex) {
  const existingTaskSet = new Set(context.existingTaskIds ?? []);
  const existingManifestSet = new Set(context.existingManifestIds ?? []);

  if (existingTaskSet.has(manifest.task.taskId) || existingTaskSet.has(manifest.manifestId)) {
    pushIssue(issues, '$.context.existingTaskIds', 'existing-id-conflict');
  }
  if (existingManifestSet.has(manifest.manifestId) || existingManifestSet.has(manifest.task.taskId)) {
    pushIssue(issues, '$.context.existingManifestIds', 'existing-id-conflict');
  }

  const declaredArtifactIds = new Set(manifest.artifacts.map((item) => item.artifactId));
  const suppliedById = new Map();
  const suppliedList = context.artifacts ?? [];

  for (let i = 0; i < suppliedList.length; i++) {
    if (issues.length >= LIMITS.maxIssues) {
      return;
    }
    const item = suppliedList[i];
    const itemPath = `$.context.artifacts[${i}]`;
    const hasBytes = isBoundedUint8Array(item.bytes);
    const hasClaimedDigest = typeof item.claimedDigest === 'string';

    if (!declaredArtifactIds.has(item.artifactId)) {
      pushIssue(issues, `${itemPath}.artifactId`, 'unexpected-supplied-artifact');
    }

    if (!hasBytes && !hasClaimedDigest) {
      pushIssue(issues, itemPath, 'invalid-supplied-artifact');
      continue;
    }

    let computedDigest = null;
    let effectiveLength = item.byteLength ?? null;
    if (hasBytes) {
      const actualByteLength = getUint8ArrayByteLength(item.bytes);
      computedDigest = sha256Hex(item.bytes);
      computedDigestsByIndex.set(i, {
        digest: computedDigest,
        byteLength: actualByteLength,
      });
      if (item.byteLength !== undefined && item.byteLength !== actualByteLength) {
        pushIssue(issues, itemPath, 'conflicting-supplied-artifact');
      }
      if (hasClaimedDigest && item.claimedDigest !== computedDigest) {
        pushIssue(issues, itemPath, 'conflicting-supplied-artifact');
      }
      effectiveLength = actualByteLength;
    }

    const effectiveDigest = computedDigest ?? item.claimedDigest;
    if (suppliedById.has(item.artifactId)) {
      pushIssue(issues, `${itemPath}.artifactId`, 'duplicate-supplied-artifact-id');
      const prev = suppliedById.get(item.artifactId);
      if (
        prev.effectiveDigest !== effectiveDigest ||
        prev.effectiveLength !== effectiveLength ||
        prev.hasBytes !== hasBytes
      ) {
        pushIssue(issues, itemPath, 'conflicting-supplied-artifact');
      }
    } else {
      suppliedById.set(item.artifactId, {
        index: i,
        hasBytes,
        effectiveDigest,
        effectiveLength,
      });
    }
  }
}

// planHandoffImportReview(manifest, context) ->
//   { ok: true, plan } | { ok: false, issues }
// Pure, deterministic, side-effect-free, and never mutates its inputs.
export function planHandoffImportReview(manifest, context = {}) {
  const manifestValidation = validateHandoffManifest(manifest);
  const issues = manifestValidation.ok ? [] : [...manifestValidation.issues];

  const normalizedContext = context === undefined ? {} : context;
  checkSpec(normalizedContext, IMPORT_REVIEW_CONTEXT_CONTRACT, '$.context', issues);

  const computedDigestsByIndex = new Map();
  if (issues.length === 0) {
    crossCheckContext(manifestValidation.manifest, normalizedContext, issues, computedDigestsByIndex);
  }

  if (issues.length > 0) {
    return deepFreeze({
      ok: false,
      issues: issues.slice(0, LIMITS.maxIssues),
    });
  }

  const canonical = manifestValidation.manifest;
  const suppliedList = normalizedContext.artifacts ?? [];
  const suppliedMap = new Map();
  for (let i = 0; i < suppliedList.length; i++) {
    suppliedMap.set(suppliedList[i].artifactId, {
      record: suppliedList[i],
      computed: computedDigestsByIndex.get(i) ?? null,
    });
  }

  const missingArtifactIds = [];
  const unverifiedArtifactIds = [];
  const suppliedHashOnlyArtifactIds = [];
  const conflictingClaimArtifactIds = [];
  const mismatchedArtifactIds = [];
  const verifiedByteArtifactIds = [];
  const items = [];

  for (const declared of canonical.artifacts) {
    const suppliedEntry = suppliedMap.get(declared.artifactId);
    let verificationState;
    let hashComparison;
    let observedByteLength = null;
    let observedByteDigest = null;
    let suppliedClaim = null;
    let bytesVerified = false;

    if (!suppliedEntry) {
      verificationState = 'missing';
      hashComparison = 'not-inspected';
      missingArtifactIds.push(declared.artifactId);
      unverifiedArtifactIds.push(declared.artifactId);
    } else if (suppliedEntry.computed !== null) {
      // Actual non-detached Uint8Array bytes were inspected.
      observedByteLength = suppliedEntry.computed.byteLength;
      observedByteDigest = suppliedEntry.computed.digest;
      if (suppliedEntry.record.claimedDigest !== undefined || suppliedEntry.record.byteLength !== undefined) {
        suppliedClaim = {
          claimedDigest: suppliedEntry.record.claimedDigest ?? null,
          claimedByteLength: suppliedEntry.record.byteLength ?? null,
          claimOrigin: 'caller-supplied',
        };
      }
      const lengthMatches = observedByteLength === declared.byteLength;
      const digestMatches = observedByteDigest === declared.contentHashClaim.digest;
      if (lengthMatches && digestMatches) {
        verificationState = 'bytes-verified';
        hashComparison = 'matched-manifest-claim';
        bytesVerified = true;
        verifiedByteArtifactIds.push(declared.artifactId);
      } else {
        verificationState = 'byte-mismatch';
        hashComparison = 'mismatched';
        mismatchedArtifactIds.push(declared.artifactId);
        unverifiedArtifactIds.push(declared.artifactId);
      }
    } else {
      // Caller supplied only a hash/length claim without artifact bytes.
      // No bytes were inspected, so observedByteLength and observedByteDigest
      // remain strictly null and bytesVerified remains false.
      const callerDigest = suppliedEntry.record.claimedDigest;
      const callerByteLength = suppliedEntry.record.byteLength ?? null;
      suppliedClaim = {
        claimedDigest: callerDigest,
        claimedByteLength: callerByteLength,
        claimOrigin: 'caller-unverified-claim-only',
      };
      const digestMatches = callerDigest === declared.contentHashClaim.digest;
      const lengthMatches = callerByteLength === null || callerByteLength === declared.byteLength;
      if (digestMatches && lengthMatches) {
        verificationState = 'unverified-hash-claim-only';
        hashComparison = 'supplied-claim-matched-manifest-claim';
        suppliedHashOnlyArtifactIds.push(declared.artifactId);
        unverifiedArtifactIds.push(declared.artifactId);
      } else {
        verificationState = 'claim-conflict-only';
        hashComparison = 'supplied-claim-conflicted-with-manifest-claim';
        conflictingClaimArtifactIds.push(declared.artifactId);
        suppliedHashOnlyArtifactIds.push(declared.artifactId);
        unverifiedArtifactIds.push(declared.artifactId);
      }
    }

    items.push({
      artifactId: declared.artifactId,
      purpose: untrustedLabelEnvelope(declared.purposeLabel),
      claimedByteLength: declared.byteLength,
      observedByteLength,
      claimedHash: {
        algorithm: declared.contentHashClaim.algorithm,
        digest: declared.contentHashClaim.digest,
        claimOrigin: 'manifest-unauthenticated',
      },
      suppliedClaim,
      observedByteDigest,
      verificationState,
      hashComparison,
      bytesVerified,
      authenticity: 'unproven-manifest-claim',
      authenticityProven: false,
      requiresOwnerReview: true,
    });
  }

  const allDeclaredBytesVerified =
    canonical.artifacts.length > 0 &&
    verifiedByteArtifactIds.length === canonical.artifacts.length &&
    mismatchedArtifactIds.length === 0 &&
    conflictingClaimArtifactIds.length === 0 &&
    missingArtifactIds.length === 0 &&
    unverifiedArtifactIds.length === 0;

  let disposition;
  let requiredActions;
  if (mismatchedArtifactIds.length > 0) {
    disposition = 'blocked-artifact-mismatch';
    requiredActions = [
      'reject-or-reconcile-mismatched-artifacts',
      ...(conflictingClaimArtifactIds.length > 0 ? ['resolve-conflicting-artifact-hash-claims'] : []),
      ...(missingArtifactIds.length > 0 ? ['provide-missing-artifact-bytes'] : []),
      'verify-artifact-bytes',
      'supply-fresh-task-scope-in-destination',
      'owner-confirm-draft-scope',
    ];
  } else if (conflictingClaimArtifactIds.length > 0) {
    disposition = 'blocked-artifact-claim-conflict';
    requiredActions = [
      'resolve-conflicting-artifact-hash-claims',
      ...(missingArtifactIds.length > 0 ? ['provide-missing-artifact-bytes'] : []),
      'verify-artifact-bytes',
      'supply-fresh-task-scope-in-destination',
      'owner-confirm-draft-scope',
    ];
  } else if (missingArtifactIds.length > 0 || unverifiedArtifactIds.length > 0) {
    disposition = 'hold-missing-or-unverified-artifacts';
    requiredActions = [
      ...(missingArtifactIds.length > 0 ? ['provide-missing-artifact-bytes'] : []),
      'verify-artifact-bytes',
      'supply-fresh-task-scope-in-destination',
      'owner-confirm-draft-scope',
    ];
  } else {
    disposition = 'ready-for-owner-draft-scope-review';
    requiredActions = [
      'supply-fresh-task-scope-in-destination',
      'owner-confirm-draft-scope',
    ];
  }

  return deepFreeze({
    ok: true,
    plan: {
      schemaVersion: HANDOFF_SCHEMA_VERSION,
      handoffMode: 'portable-metadata-import-review',
      manifestId: canonical.manifestId,
      purpose: untrustedLabelEnvelope(canonical.purposeLabel),
      privacyReview: PRIVACY_REVIEW_NOTICE,
      destinationProposal: {
        proposedState: DESTINATION_TASK_STATE,
        workflowKind: canonical.task.workflowKind,
        sourceTaskRef: canonical.task.taskId,
        purpose: untrustedLabelEnvelope(canonical.task.purposeLabel),
        scopeHashClaim: {
          algorithm: canonical.task.scopeHashClaim.algorithm,
          digest: canonical.task.scopeHashClaim.digest,
          claimOrigin: 'manifest-unauthenticated',
          claimStatus: 'claimed-only',
          bytesVerified: false,
          authenticityProven: false,
        },
        createsTaskRecord: false,
        duplicatesWorkspaceDraftCopy: false,
      },
      artifactReview: {
        totalDeclared: canonical.artifacts.length,
        bytesVerifiedCount: verifiedByteArtifactIds.length,
        missingArtifactIds,
        unverifiedArtifactIds,
        suppliedHashOnlyArtifactIds,
        conflictingClaimArtifactIds,
        mismatchedArtifactIds,
        verifiedByteArtifactIds,
        allDeclaredBytesVerified,
        authenticityProven: false,
        items,
      },
      ownerScopeReview: {
        required: true,
        status: 'pending-fresh-owner-review',
        canAutoApprove: false,
        disposition,
        requiredActions,
      },
      nonTransferredAuthority: NON_TRANSFERRED_AUTHORITY,
    },
  });
}
