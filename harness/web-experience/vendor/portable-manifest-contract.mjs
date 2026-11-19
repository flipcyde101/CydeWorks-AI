// Authoritative contract for CydeWorks AI portable task-handoff manifests (v1)
// and import-review planning context. Pure data definitions: no I/O, clock,
// randomness, filesystem, network, process, or Node built-in dependencies.
//
// Security and privacy boundary note:
// Closed object keys prevent dedicated fields for prompts, source snapshots,
// credentials, environment variables, account identifiers, connection settings,
// paths, executables, or authority state. Heuristic string pattern checks catch
// only obvious structural tokens and are NOT a general semantic privacy
// scrubber. Allowed purpose labels and opaque identifiers can still carry
// sensitive free-text content (such as filenames, IP/port notes, or source
// sentences) and require owner preview before external sharing.

export const HANDOFF_MANIFEST_FORMAT = 'cydeworks.task-handoff-manifest';
export const HANDOFF_SCHEMA_VERSION = 1;
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1]);
export const SUPPORTED_HASH_ALGORITHMS = Object.freeze(['sha256']);
export const TASK_WORKFLOW_KINDS = Object.freeze(['brief', 'change']);
export const DESTINATION_TASK_STATE = 'draft';

export const LIMITS = Object.freeze({
  identifier: 64,
  purposeLabel: 120,
  maxArtifacts: 32,
  maxArtifactBytes: 262144,
  maxExistingIds: 100,
  maxIssues: 50,
});

export const ISSUE_MESSAGES = Object.freeze({
  'invalid-object': 'Expected a plain data object.',
  'invalid-array': 'Expected a dense list of plain data values.',
  'invalid-boolean': 'Expected true or false.',
  'invalid-integer': 'Expected a nonnegative safe integer within the documented limit.',
  'invalid-string': 'Expected a nonempty bounded string without control characters.',
  'invalid-identifier': 'Expected a bounded opaque identifier using only ASCII letters, digits, hyphens, or underscores.',
  'invalid-label': 'Expected a single-line bounded purpose label without control characters.',
  'invalid-workflow-kind': 'Expected a supported task workflow kind.',
  'invalid-byte-length': 'Expected a nonnegative safe integer within the artifact byte limit.',
  'invalid-byte-buffer': 'Expected artifact bytes as a non-detached Uint8Array within the artifact byte limit.',
  'invalid-supplied-artifact': 'Expected a supplied artifact record with bytes or a claimed digest.',
  'accessor-property-rejected': 'Accessor properties are not allowed.',
  'prototype-key-rejected': 'Prototype-related keys and identifiers are not allowed.',
  'missing-field': 'A required contract property is missing.',
  'unknown-field': 'An undocumented property is present.',
  'unsupported-format': 'Only the documented handoff manifest format is supported.',
  'unsupported-version': 'Only supported handoff manifest schema versions are accepted.',
  'unsupported-hash-algorithm': 'Only the sha256 content-hash algorithm is supported.',
  'malformed-hash': 'Expected a 64-character lowercase hexadecimal sha256 digest.',
  'too-many-items': 'A collection exceeds its documented size limit.',
  'duplicate-artifact-id': 'Artifact identifiers must be unique within a manifest.',
  'conflicting-artifact-id': 'Duplicate artifact identifiers carry conflicting metadata or hash claims.',
  'duplicate-artifact-reference': 'Task artifact references must not repeat an identifier.',
  'artifact-reference-mismatch': 'Task artifact references and declared manifest artifacts must reference the exact same identifiers.',
  'conflicting-id': 'Manifest, task, and artifact identifiers must be distinct from one another.',
  'duplicate-supplied-artifact-id': 'Supplied artifact verification records must not repeat an identifier.',
  'conflicting-supplied-artifact': 'Supplied artifact verification records carry conflicting digests or byte evidence.',
  'unexpected-supplied-artifact': 'A supplied artifact verification record does not match any declared manifest artifact.',
  'existing-id-conflict': 'A manifest or task identifier conflicts with an existing destination workspace identifier.',
  'excluded-content-rejected': 'Prompt, source snapshot, patch, and proposal fields or multiline dumps are not allowed in handoff manifests.',
  'executable-or-path-rejected': 'Filesystem path fields, executable fields, path separators, and script/command tokens are not allowed.',
  'credential-rejected': 'Credential fields and recognized key, token, secret, or session patterns are not allowed.',
  'environment-variable-rejected': 'Environment variable fields and recognized environment expansion tokens are not allowed.',
  'account-identifier-rejected': 'Account identifier fields and recognized email or account token patterns are not allowed.',
  'connection-setting-rejected': 'Connection setting fields and recognized URL, loopback, or endpoint tokens are not allowed.',
  'authority-transfer-rejected': 'Approvals, permissions, authentication, acceptance, model qualification, host attestation, terminal control, and running session state cannot be transferred.',
});

export const ISSUE_CODES = Object.freeze(Object.keys(ISSUE_MESSAGES));

// Exported as frozen arrays so callers cannot mutate enforcement policy state
// (unlike Object.freeze(new Set()), which leaves Set membership mutable).
export const PROTOTYPE_KEYS = Object.freeze([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

export const FORBIDDEN_IDENTIFIER_NAMES = Object.freeze([
  ...PROTOTYPE_KEYS,
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
]);

export const FORBIDDEN_FIELD_CATEGORIES = deepFreeze({
  excludedContent: [
    'prompt',
    'prompts',
    'systemPrompt',
    'userPrompt',
    'request',
    'source',
    'sourceText',
    'sourceSnapshot',
    'content',
    'rawContent',
    'expected',
    'patch',
    'diff',
    'summary',
    'body',
    'markdown',
    'messages',
    'instructions',
    'proposal',
    'originalArtifact',
  ],
  executableOrPath: [
    'path',
    'filePath',
    'filepath',
    'filename',
    'fileName',
    'file',
    'dir',
    'directory',
    'cwd',
    'root',
    'worktree',
    'archive',
    'archivePath',
    'bundle',
    'bundlePath',
    'command',
    'cmd',
    'exec',
    'executable',
    'script',
    'shell',
    'args',
    'argv',
    'binary',
    'entryPoint',
    'hook',
  ],
  credential: [
    'key',
    'accessKey',
    'apiKey',
    'secret',
    'removalSecret',
    'password',
    'passwd',
    'token',
    'authToken',
    'accessToken',
    'refreshToken',
    'bearer',
    'cookie',
    'cookies',
    'sessionKey',
    'privateKey',
    'clientSecret',
    'credential',
    'credentials',
    'authorization',
    'signature',
    'hmac',
  ],
  environmentVariable: [
    'env',
    'environment',
    'processEnv',
    'envVars',
    'dotenv',
    'BFE_PORT',
    'BFE_TEST_KEY',
    'BFE_TEST_MEMORY',
    'BFE_DESKTOP_BOOTSTRAP',
    'BFE_TEST_OWNER_TIMEOUT_MS',
  ],
  accountIdentifier: [
    'account',
    'accountId',
    'userId',
    'user',
    'username',
    'owner',
    'ownerId',
    'email',
    'mail',
    'tenant',
    'tenantId',
    'orgId',
    'organizationId',
    'customerId',
    'principal',
    'subject',
    'sub',
  ],
  connectionSetting: [
    'endpoint',
    'endpoints',
    'url',
    'uri',
    'href',
    'host',
    'hostname',
    'origin',
    'port',
    'protocol',
    'socket',
    'proxy',
    'headers',
    'ollamaEndpoint',
    'llamacppEndpoint',
    'dsn',
    'connectionString',
    'connection',
    'connections',
  ],
  authorityTransfer: [
    'status',
    'state',
    'destinationStatus',
    'proposedState',
    'targetState',
    'approve',
    'approved',
    'approval',
    'approvals',
    'accepted',
    'acceptance',
    'decision',
    'permissions',
    'permission',
    'role',
    'roles',
    'auth',
    'authenticated',
    'authorized',
    'model',
    'modelDigest',
    'modelFingerprint',
    'approvedModelDigest',
    'approvedModelFingerprint',
    'quantization',
    'identityKind',
    'readiness',
    'eligible',
    'modelQualification',
    'hostAttestation',
    'attestation',
    'terminal',
    'terminalControl',
    'control',
    'live',
    'active',
    'running',
    'session',
    'sessionId',
    'engineSessionId',
    'attempts',
    'events',
    'recovery',
    'checks',
    'usage',
    'cost',
    'ownerLease',
    'operatorEdits',
  ],
});

export function deepFreeze(value) {
  if (value instanceof Set || value instanceof Map || value instanceof WeakSet || value instanceof WeakMap) {
    throw new TypeError('Set and Map instances remain mutable under Object.freeze; use plain objects or arrays.');
  }
  if (
    value &&
    typeof value === 'object' &&
    !(value instanceof RegExp) &&
    !ArrayBuffer.isView(value) &&
    !Object.isFrozen(value)
  ) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

// Creates a static validation issue. Path must only contain contract property
// names and numeric array indexes; message is always looked up from the static
// table so rejected input content is never echoed.
export function staticIssue(path, code) {
  const validCode = Object.hasOwn(ISSUE_MESSAGES, code) ? code : 'unknown-field';
  return Object.freeze({
    path,
    code: validCode,
    message: ISSUE_MESSAGES[validCode],
  });
}

const HASH_CLAIM_SPEC = {
  type: 'object',
  keys: {
    algorithm: { type: 'hash-algorithm' },
    digest: { type: 'sha256-digest' },
  },
};

const ARTIFACT_REFERENCE_SPEC = {
  type: 'object',
  keys: {
    artifactId: { type: 'identifier' },
    purposeLabel: { type: 'purpose-label' },
    byteLength: { type: 'byte-length' },
    contentHashClaim: HASH_CLAIM_SPEC,
  },
};

const TASK_REFERENCE_SPEC = {
  type: 'object',
  keys: {
    taskId: { type: 'identifier' },
    workflowKind: { type: 'workflow-kind' },
    purposeLabel: { type: 'purpose-label' },
    scopeHashClaim: HASH_CLAIM_SPEC,
    artifactIds: {
      type: 'array',
      max: LIMITS.maxArtifacts,
      items: { type: 'identifier' },
    },
  },
};

export const HANDOFF_MANIFEST_CONTRACT = deepFreeze({
  type: 'object',
  keys: {
    format: { type: 'manifest-format' },
    schemaVersion: { type: 'schema-version' },
    manifestId: { type: 'identifier' },
    purposeLabel: { type: 'purpose-label' },
    task: TASK_REFERENCE_SPEC,
    artifacts: {
      type: 'array',
      max: LIMITS.maxArtifacts,
      items: ARTIFACT_REFERENCE_SPEC,
    },
  },
});

const SUPPLIED_ARTIFACT_SPEC = {
  type: 'object',
  keys: {
    artifactId: { type: 'identifier' },
    bytes: { type: 'byte-buffer', optional: true },
    claimedDigest: { type: 'sha256-digest', optional: true },
    byteLength: { type: 'byte-length', optional: true },
  },
};

export const IMPORT_REVIEW_CONTEXT_CONTRACT = deepFreeze({
  type: 'object',
  keys: {
    artifacts: {
      type: 'array',
      max: LIMITS.maxArtifacts,
      optional: true,
      items: SUPPLIED_ARTIFACT_SPEC,
    },
    existingTaskIds: {
      type: 'array',
      max: LIMITS.maxExistingIds,
      optional: true,
      items: { type: 'identifier' },
    },
    existingManifestIds: {
      type: 'array',
      max: LIMITS.maxExistingIds,
      optional: true,
      items: { type: 'identifier' },
    },
  },
});
