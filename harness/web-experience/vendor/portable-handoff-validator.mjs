// Pure validator for CydeWorks AI portable task-handoff manifests (v1).
// Deterministic, bounded, side-effect-free, and never echoes rejected content.
//
// Privacy note: closed schema keys and heuristic pattern checks reject
// documented forbidden field names and obvious structural tokens, but do not
// act as a semantic privacy scrubber for free-text labels or identifiers.
// Allowed labels and IDs remain untrusted plain text and require owner preview
// before external sharing.

import {
  DESTINATION_TASK_STATE,
  FORBIDDEN_FIELD_CATEGORIES,
  FORBIDDEN_IDENTIFIER_NAMES,
  HANDOFF_MANIFEST_CONTRACT,
  HANDOFF_MANIFEST_FORMAT,
  HANDOFF_SCHEMA_VERSION,
  LIMITS,
  PROTOTYPE_KEYS,
  SUPPORTED_HASH_ALGORITHMS,
  SUPPORTED_SCHEMA_VERSIONS,
  TASK_WORKFLOW_KINDS,
  deepFreeze,
  staticIssue,
} from './portable-manifest-contract.mjs';
import { isBoundedUint8Array } from './portable-sha256.mjs';

// Private enforcement sets constructed from exported frozen arrays so external
// callers cannot mutate policy state.
const PROTOTYPE_KEY_SET = new Set(PROTOTYPE_KEYS);
const FORBIDDEN_IDENTIFIER_SET = new Set(FORBIDDEN_IDENTIFIER_NAMES);
const EXCLUDED_CONTENT_KEY_SET = new Set(FORBIDDEN_FIELD_CATEGORIES.excludedContent);
const EXECUTABLE_OR_PATH_KEY_SET = new Set(FORBIDDEN_FIELD_CATEGORIES.executableOrPath);
const CREDENTIAL_KEY_SET = new Set(FORBIDDEN_FIELD_CATEGORIES.credential);
const ENV_KEY_SET = new Set(FORBIDDEN_FIELD_CATEGORIES.environmentVariable);
const ACCOUNT_KEY_SET = new Set(FORBIDDEN_FIELD_CATEGORIES.accountIdentifier);
const CONNECTION_KEY_SET = new Set(FORBIDDEN_FIELD_CATEGORIES.connectionSetting);
const AUTHORITY_KEY_SET = new Set(FORBIDDEN_FIELD_CATEGORIES.authorityTransfer);

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SHA256_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_OR_BIDI_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const LONE_SURROGATE_PATTERN = /[\uD800-\uDFFF]/;
const MAX_INSPECT_CHARS = 256;

const CREDENTIAL_VALUE_PATTERNS = Object.freeze([
  /\b(?:access\.key|bfe_session)\b/i,
  /\b(?:Bearer|Basic)\s+\S+/i,
  /\bsk-[a-zA-Z0-9_-]{6,}\b/i,
  /\bsk_(?:live|test)_[a-zA-Z0-9_]{4,}\b/i,
  /\bgh[pousr]_[a-zA-Z0-9_]{6,}\b/i,
  /\bgithub_pat_[a-zA-Z0-9_]{6,}\b/i,
  /\bxox[baprs]-[a-zA-Z0-9-]{6,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z0-9 ]+-----/,
  /\b(?:api[_-]?key|access[_-]?key|secret|removal[_-]?secret|password|passwd|token|auth[_-]?token|private[_-]?key|cookie)\s*[:=]/i,
  /\b[a-f0-9]{64}\b/i,
]);

const ENV_VALUE_PATTERNS = Object.freeze([
  /\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}]+\}/,
  /%[A-Za-z_][A-Za-z0-9_]*%/,
  /\b(?:process\.env|BFE_PORT|BFE_TEST_KEY|BFE_TEST_MEMORY|BFE_DESKTOP_BOOTSTRAP|BFE_TEST_OWNER_TIMEOUT_MS|OPENAI_API_KEY|ANTHROPIC_API_KEY)\b/,
  /\b[A-Z][A-Z0-9_]{2,}=[^\s]+/,
]);

const CONNECTION_VALUE_PATTERNS = Object.freeze([
  /\b(?:https?|wss?|ftp|ssh|tcp|unix|postgres|sqlite):\/\//i,
  /\b(?:127\.0\.0\.1|0\.0\.0\.0|localhost)\b/i,
  /\[::1\]|:(?:15371|11434|8080)\b/,
]);

const ACCOUNT_VALUE_PATTERNS = Object.freeze([
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  /\b(?:acct_[a-zA-Z0-9_-]+|arn:aws:iam::\S+)\b/i,
  /\b(?:user[_-]?id|owner[_-]?id|account[_-]?id|tenant[_-]?id)\s*[:=]\s*\S+/i,
]);

const EXECUTABLE_OR_PATH_VALUE_PATTERNS = Object.freeze([
  /[a-zA-Z]:[\\/]|\\/,
  /\bfile:\//i,
  /^(?:\/|\.\.?\/|~\/)/,
  /(?:^|\s)(?:\/(?:etc|usr|var|tmp|opt|home|Users|root|bin|sbin|dev|proc|sys)\b|\.\.\/|\.\/)/,
  /[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+/,
  /\.(?:exe|bat|cmd|ps1|sh|bash|zsh|msi|dll|so|dylib|py|rb|pl|jar|mjs|cjs|js)\b/i,
  /<\s*\/?\s*script\b|javascript:|vbscript:|data:text\/html/i,
  /\$\(|`|\|\||&&|;\s*(?:rm|curl|wget|sh|bash|powershell|cmd)\b|\|\s*(?:sh|bash|powershell|cmd)\b|\b(?:cmd\.exe|powershell(?:\.exe)?|\/bin\/(?:sh|bash)|eval\s*\()/i,
]);

const EXCLUDED_CONTENT_VALUE_PATTERNS = Object.freeze([
  /\r|\n/,
  /```/,
  /@@\s+-\d+/,
  /(?:---|\+\+\+)\s+[ab]\//,
]);

function hasWellFormedUnicode(value) {
  if (typeof value.isWellFormed === 'function') {
    return value.isWellFormed();
  }
  return !LONE_SURROGATE_PATTERN.test(value);
}

export function classifyUnknownKey(key) {
  if (typeof key !== 'string') {
    return 'unknown-field';
  }
  if (PROTOTYPE_KEY_SET.has(key)) {
    return 'prototype-key-rejected';
  }
  if (EXCLUDED_CONTENT_KEY_SET.has(key)) {
    return 'excluded-content-rejected';
  }
  if (EXECUTABLE_OR_PATH_KEY_SET.has(key)) {
    return 'executable-or-path-rejected';
  }
  if (CREDENTIAL_KEY_SET.has(key)) {
    return 'credential-rejected';
  }
  if (ENV_KEY_SET.has(key) || /^BFE_[A-Z0-9_]+$/.test(key)) {
    return 'environment-variable-rejected';
  }
  if (ACCOUNT_KEY_SET.has(key)) {
    return 'account-identifier-rejected';
  }
  if (CONNECTION_KEY_SET.has(key)) {
    return 'connection-setting-rejected';
  }
  if (AUTHORITY_KEY_SET.has(key)) {
    return 'authority-transfer-rejected';
  }
  return 'unknown-field';
}

export function inspectStringHazard(value, kind) {
  if (typeof value !== 'string') {
    return kind === 'identifier' ? 'invalid-identifier' : 'invalid-label';
  }
  const sample = value.length > MAX_INSPECT_CHARS ? value.slice(0, MAX_INSPECT_CHARS) : value;
  const trimmed = sample.trim();

  if (PROTOTYPE_KEY_SET.has(trimmed) || (kind === 'identifier' && FORBIDDEN_IDENTIFIER_SET.has(trimmed))) {
    return 'prototype-key-rejected';
  }
  for (const pattern of EXCLUDED_CONTENT_VALUE_PATTERNS) {
    if (pattern.test(sample)) {
      return 'excluded-content-rejected';
    }
  }
  for (const pattern of CONNECTION_VALUE_PATTERNS) {
    if (pattern.test(sample)) {
      return 'connection-setting-rejected';
    }
  }
  for (const pattern of ENV_VALUE_PATTERNS) {
    if (pattern.test(sample)) {
      return 'environment-variable-rejected';
    }
  }
  for (const pattern of ACCOUNT_VALUE_PATTERNS) {
    if (pattern.test(sample)) {
      return 'account-identifier-rejected';
    }
  }
  for (const pattern of EXECUTABLE_OR_PATH_VALUE_PATTERNS) {
    if (pattern.test(sample)) {
      return 'executable-or-path-rejected';
    }
  }
  for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
    if (pattern.test(sample)) {
      return 'credential-rejected';
    }
  }
  return null;
}

function pushIssue(issues, path, code) {
  if (issues.length < LIMITS.maxIssues) {
    issues.push(staticIssue(path, code));
  }
}

// Reads an own property descriptor without invoking getters or consulting the
// prototype chain.
export function ownDataProperty(holder, key, path, issues) {
  const descriptor = Object.getOwnPropertyDescriptor(holder, key);
  if (!descriptor) {
    return { state: 'absent', value: undefined };
  }
  if (!('value' in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
    pushIssue(issues, path, 'accessor-property-rejected');
    return { state: 'accessor', value: undefined };
  }
  if (descriptor.value === undefined) {
    return { state: 'undefined', value: undefined };
  }
  return { state: 'present', value: descriptor.value };
}

export function checkSpec(value, spec, path, issues) {
  if (issues.length >= LIMITS.maxIssues) {
    return;
  }
  if (value === null || value === undefined) {
    pushIssue(issues, path, spec.type === 'object' ? 'invalid-object' : 'missing-field');
    return;
  }

  switch (spec.type) {
    case 'manifest-format': {
      if (value !== HANDOFF_MANIFEST_FORMAT) {
        pushIssue(issues, path, 'unsupported-format');
      }
      return;
    }
    case 'schema-version': {
      if (!Number.isSafeInteger(value) || !SUPPORTED_SCHEMA_VERSIONS.includes(value)) {
        pushIssue(issues, path, 'unsupported-version');
      }
      return;
    }
    case 'hash-algorithm': {
      if (typeof value !== 'string' || !SUPPORTED_HASH_ALGORITHMS.includes(value)) {
        pushIssue(issues, path, 'unsupported-hash-algorithm');
      }
      return;
    }
    case 'sha256-digest': {
      if (typeof value !== 'string' || !SHA256_DIGEST_PATTERN.test(value)) {
        pushIssue(issues, path, 'malformed-hash');
      }
      return;
    }
    case 'workflow-kind': {
      if (typeof value !== 'string' || !TASK_WORKFLOW_KINDS.includes(value)) {
        pushIssue(issues, path, 'invalid-workflow-kind');
      }
      return;
    }
    case 'byte-length': {
      if (!Number.isSafeInteger(value) || value < 0 || value > LIMITS.maxArtifactBytes) {
        pushIssue(issues, path, 'invalid-byte-length');
      }
      return;
    }
    case 'byte-buffer': {
      if (!isBoundedUint8Array(value)) {
        pushIssue(issues, path, 'invalid-byte-buffer');
      }
      return;
    }
    case 'identifier': {
      if (typeof value !== 'string') {
        pushIssue(issues, path, 'invalid-identifier');
        return;
      }
      const hazard = inspectStringHazard(value, 'identifier');
      if (hazard) {
        pushIssue(issues, path, hazard);
        return;
      }
      if (
        value.length === 0 ||
        value.length > LIMITS.identifier ||
        !hasWellFormedUnicode(value) ||
        !IDENTIFIER_PATTERN.test(value)
      ) {
        pushIssue(issues, path, 'invalid-identifier');
      }
      return;
    }
    case 'purpose-label': {
      if (typeof value !== 'string') {
        pushIssue(issues, path, 'invalid-label');
        return;
      }
      const hazard = inspectStringHazard(value, 'purpose-label');
      if (hazard) {
        pushIssue(issues, path, hazard);
        return;
      }
      if (
        value.length === 0 ||
        value.length > LIMITS.purposeLabel ||
        !value.trim() ||
        !hasWellFormedUnicode(value) ||
        CONTROL_OR_BIDI_PATTERN.test(value)
      ) {
        pushIssue(issues, path, 'invalid-label');
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
        pushIssue(issues, path, 'invalid-array');
        return;
      }
      if (value.length > spec.max) {
        pushIssue(issues, path, 'too-many-items');
        return;
      }
      const keys = Reflect.ownKeys(value);
      for (let i = 0; i < keys.length; i++) {
        if (issues.length >= LIMITS.maxIssues) {
          return;
        }
        const key = keys[i];
        if (key === 'length') {
          continue;
        }
        if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
          const code = classifyUnknownKey(key);
          pushIssue(issues, path, code === 'unknown-field' ? 'invalid-array' : code);
          return;
        }
      }
      if (keys.length !== value.length + 1) {
        pushIssue(issues, path, 'invalid-array');
        return;
      }
      for (let index = 0; index < value.length; index++) {
        if (issues.length >= LIMITS.maxIssues) {
          return;
        }
        const itemPath = `${path}[${index}]`;
        const prop = ownDataProperty(value, String(index), itemPath, issues);
        if (prop.state === 'accessor') {
          continue;
        }
        if (prop.state !== 'present' || prop.value === null) {
          pushIssue(issues, itemPath, 'invalid-array');
          continue;
        }
        checkSpec(prop.value, spec.items, itemPath, issues);
      }
      return;
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value) || ArrayBuffer.isView(value)) {
        pushIssue(issues, path, 'invalid-object');
        return;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        pushIssue(issues, path, 'invalid-object');
        return;
      }
      const ownKeys = Reflect.ownKeys(value);
      const allowedCount = Object.keys(spec.keys).length;
      const inspectLimit = Math.min(ownKeys.length, allowedCount + LIMITS.maxIssues);
      for (let i = 0; i < inspectLimit; i++) {
        if (issues.length >= LIMITS.maxIssues) {
          return;
        }
        const key = ownKeys[i];
        if (typeof key !== 'string' || !Object.hasOwn(spec.keys, key)) {
          pushIssue(issues, path, classifyUnknownKey(key));
        }
      }
      if (ownKeys.length > inspectLimit && issues.length < LIMITS.maxIssues) {
        pushIssue(issues, path, 'unknown-field');
      }
      for (const [key, childSpec] of Object.entries(spec.keys)) {
        if (issues.length >= LIMITS.maxIssues) {
          return;
        }
        const childPath = `${path}.${key}`;
        const prop = ownDataProperty(value, key, childPath, issues);
        if (prop.state === 'accessor') {
          continue;
        }
        if (prop.state === 'present') {
          checkSpec(prop.value, childSpec, childPath, issues);
        } else if (prop.state === 'undefined') {
          pushIssue(issues, childPath, 'missing-field');
        } else if (!childSpec.optional) {
          pushIssue(issues, childPath, 'missing-field');
        }
      }
      return;
    }
  }
}

function crossCheckManifest(manifest, issues) {
  const manifestId = manifest.manifestId;
  const taskId = manifest.task.taskId;

  if (manifestId === taskId) {
    pushIssue(issues, '$.task.taskId', 'conflicting-id');
  }

  const seenTaskArtifactRefs = new Set();
  for (let i = 0; i < manifest.task.artifactIds.length; i++) {
    if (issues.length >= LIMITS.maxIssues) {
      return;
    }
    const refId = manifest.task.artifactIds[i];
    const refPath = `$.task.artifactIds[${i}]`;
    if (refId === manifestId || refId === taskId) {
      pushIssue(issues, refPath, 'conflicting-id');
    }
    if (seenTaskArtifactRefs.has(refId)) {
      pushIssue(issues, refPath, 'duplicate-artifact-reference');
    }
    seenTaskArtifactRefs.add(refId);
  }

  const declaredArtifacts = new Map();
  for (let i = 0; i < manifest.artifacts.length; i++) {
    if (issues.length >= LIMITS.maxIssues) {
      return;
    }
    const artifact = manifest.artifacts[i];
    const idPath = `$.artifacts[${i}].artifactId`;
    if (artifact.artifactId === manifestId || artifact.artifactId === taskId) {
      pushIssue(issues, idPath, 'conflicting-id');
    }
    if (declaredArtifacts.has(artifact.artifactId)) {
      pushIssue(issues, idPath, 'duplicate-artifact-id');
      const first = declaredArtifacts.get(artifact.artifactId);
      if (
        first.byteLength !== artifact.byteLength ||
        first.digest !== artifact.contentHashClaim.digest ||
        first.purposeLabel !== artifact.purposeLabel
      ) {
        pushIssue(issues, idPath, 'conflicting-artifact-id');
      }
    } else {
      declaredArtifacts.set(artifact.artifactId, {
        byteLength: artifact.byteLength,
        digest: artifact.contentHashClaim.digest,
        purposeLabel: artifact.purposeLabel,
      });
    }
  }

  for (let i = 0; i < manifest.task.artifactIds.length; i++) {
    if (issues.length >= LIMITS.maxIssues) {
      return;
    }
    const refId = manifest.task.artifactIds[i];
    if (!declaredArtifacts.has(refId)) {
      pushIssue(issues, `$.task.artifactIds[${i}]`, 'artifact-reference-mismatch');
    }
  }

  for (let i = 0; i < manifest.artifacts.length; i++) {
    if (issues.length >= LIMITS.maxIssues) {
      return;
    }
    const artifact = manifest.artifacts[i];
    if (!seenTaskArtifactRefs.has(artifact.artifactId)) {
      pushIssue(issues, `$.artifacts[${i}].artifactId`, 'artifact-reference-mismatch');
    }
  }
}

function cloneCanonicalManifest(manifest) {
  return deepFreeze({
    format: HANDOFF_MANIFEST_FORMAT,
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    manifestId: manifest.manifestId,
    purposeLabel: manifest.purposeLabel,
    task: {
      taskId: manifest.task.taskId,
      workflowKind: manifest.task.workflowKind,
      purposeLabel: manifest.task.purposeLabel,
      scopeHashClaim: {
        algorithm: manifest.task.scopeHashClaim.algorithm,
        digest: manifest.task.scopeHashClaim.digest,
      },
      artifactIds: [...manifest.task.artifactIds],
    },
    artifacts: manifest.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      purposeLabel: artifact.purposeLabel,
      byteLength: artifact.byteLength,
      contentHashClaim: {
        algorithm: artifact.contentHashClaim.algorithm,
        digest: artifact.contentHashClaim.digest,
      },
    })),
  });
}

// validateHandoffManifest(manifest) ->
//   { ok: true, manifest, annotations } | { ok: false, issues }
// Never throws for malformed input, never mutates input, and never echoes
// rejected input values or unknown property names.
export function validateHandoffManifest(manifest) {
  const issues = [];
  checkSpec(manifest, HANDOFF_MANIFEST_CONTRACT, '$', issues);
  if (issues.length === 0) {
    crossCheckManifest(manifest, issues);
  }
  if (issues.length > 0) {
    return deepFreeze({
      ok: false,
      issues: issues.slice(0, LIMITS.maxIssues),
    });
  }
  return deepFreeze({
    ok: true,
    manifest: cloneCanonicalManifest(manifest),
    annotations: {
      handoffKind: 'metadata-only',
      proposedDestinationState: DESTINATION_TASK_STATE,
      requiresOwnerScopeReview: true,
      requiresOwnerExportPreview: true,
      labelsTrust: 'untrusted-text',
      valuePrivacyGuarantee: 'heuristic-only-not-a-privacy-scrubber',
      hashClaimsStatus: 'claimed-only',
      bytesVerified: false,
      authenticityProven: false,
    },
  });
}
