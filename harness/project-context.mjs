// Offline local project context and reusable skill library (RB-P08-A).
// Pure in-memory contract with deterministic prompt preview, explicit owner
// selection, provenance tracking, approval invalidation on version change,
// expiry, immediate revocation, cross-project isolation, and inputs-only task
// templates that never store or transfer executable approvals.
//
// Every public method copies caller input into inert library-owned data before
// reading the clock or state, and runs under a non-reentrant lock, so caller
// code (Proxy traps or the clock) cannot interleave with state checks and
// transitions. This library remains disconnected from live callers: a future
// adapter must authenticate the owner and derive projectId from trusted state.
//
// No filesystem, network, process, environment, credential, UI, or runtime
// execution dependencies.

import {
  FORBIDDEN_FIELD_CATEGORIES,
  FORBIDDEN_IDENTIFIER_NAMES,
  LIMITS,
  PROTOTYPE_KEYS,
  TASK_WORKFLOW_KINDS,
  deepFreeze,
} from './portable-manifest-contract.mjs';
import { sha256Hex, utf8Bytes } from './portable-sha256.mjs';

export const PROJECT_CONTEXT_ENTRY_KINDS = Object.freeze(['memory', 'skill']);
export const PROJECT_CONTEXT_SOURCE_KINDS = Object.freeze([
  'owner-selected-file',
  'owner-authored',
  'explicit-import',
]);

export const PROJECT_CONTEXT_LIMITS = deepFreeze({
  identifier: LIMITS.identifier,
  purposeLabel: LIMITS.purposeLabel,
  version: 64,
  sourceRef: 240,
  maxContentBytes: 65536,
  maxCapabilities: 16,
  maxSelectedEntries: 64,
  maxEntriesPerProject: 256,
  maxTemplatesPerProject: 64,
  maxRequestTextBytes: 16384,
  maxScopeLabels: 32,
  maxPreviewPromptBytes: LIMITS.maxArtifactBytes,
});

const PROTOTYPE_KEY_SET = new Set(PROTOTYPE_KEYS);
const FORBIDDEN_IDENTIFIER_SET = new Set(FORBIDDEN_IDENTIFIER_NAMES);
const FORBIDDEN_AUTHORITY_KEY_SET = new Set([
  ...FORBIDDEN_FIELD_CATEGORIES.authorityTransfer,
  'executableApproval',
  'autoApprove',
  'canAutoApprove',
  'grantId',
  'claimId',
  'policyVersion',
]);
const FORBIDDEN_CREDENTIAL_KEY_SET = new Set(FORBIDDEN_FIELD_CATEGORIES.credential);
const FORBIDDEN_ENV_KEY_SET = new Set(FORBIDDEN_FIELD_CATEGORIES.environmentVariable);
const FORBIDDEN_CONNECTION_KEY_SET = new Set(FORBIDDEN_FIELD_CATEGORIES.connectionSetting);

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_OR_BIDI_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const CONTENT_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const LONE_SURROGATE_PATTERN = /[\uD800-\uDFFF]/;

const CREDENTIAL_PATTERNS = Object.freeze([
  /\b(?:access\.key|bfe_session)\b/i,
  /\b(?:Bearer|Basic)\s+\S+/i,
  /\bsk-[a-zA-Z0-9_-]{6,}\b/i,
  /\bsk_(?:live|test)_[a-zA-Z0-9_]{4,}\b/i,
  /\bgh[pousr]_[a-zA-Z0-9_]{6,}\b/i,
  /\bgithub_pat_[a-zA-Z0-9_]{6,}\b/i,
  /\bxox[baprs]-[a-zA-Z0-9-]{6,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z0-9 ]+-----/,
]);

function compareAscii(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hasWellFormedUnicode(value) {
  if (typeof value.isWellFormed === 'function') {
    return value.isWellFormed();
  }
  return !LONE_SURROGATE_PATTERN.test(value);
}

function fail(message) {
  throw new Error(message);
}

function assertPlainObject(value, label, allowedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ArrayBuffer.isView(value)) {
    fail(`${label} must be a plain object.`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail(`${label} must have a standard object prototype.`);
  }
  const allowedSet = new Set(allowedKeys);
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      fail(`${label} contains a non-string property key.`);
    }
    if (PROTOTYPE_KEY_SET.has(key)) {
      fail(`${label} contains a forbidden prototype key.`);
    }
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !('value' in desc) || desc.get !== undefined || desc.set !== undefined) {
      fail(`${label} cannot contain accessor properties.`);
    }
    if (!allowedSet.has(key)) {
      if (FORBIDDEN_AUTHORITY_KEY_SET.has(key)) {
        fail(`${label} cannot carry authority or approval field "${key}".`);
      }
      if (FORBIDDEN_CREDENTIAL_KEY_SET.has(key)) {
        fail(`${label} cannot carry credential field "${key}".`);
      }
      if (FORBIDDEN_ENV_KEY_SET.has(key) || /^BFE_[A-Z0-9_]+$/.test(key)) {
        fail(`${label} cannot carry environment field "${key}".`);
      }
      if (FORBIDDEN_CONNECTION_KEY_SET.has(key)) {
        fail(`${label} cannot carry connection field "${key}".`);
      }
      fail(`${label} contains unknown field "${key}".`);
    }
  }
}

function readOwnValue(obj, key) {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  return desc ? desc.value : undefined;
}

function readDenseArray(value, label, maxLength) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${label} must be a dense plain array.`);
  }
  if (value.length > maxLength) {
    fail(`${label} exceeds maximum length.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1) {
    fail(`${label} must be a dense array without extra properties.`);
  }
  const copied = new Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const desc = Object.getOwnPropertyDescriptor(value, String(i));
    if (!desc || !('value' in desc) || desc.get !== undefined || desc.set !== undefined) {
      fail(`${label} must be a dense array without holes or accessor properties.`);
    }
    copied[i] = desc.value;
  }
  return copied;
}

// Data-only input boundary. Every public method copies its caller-supplied
// argument into an inert, library-owned tree of plain data BEFORE it reads the
// clock or any library state. All caller-observable introspection (including
// Proxy traps such as getPrototypeOf, ownKeys and getOwnPropertyDescriptor)
// therefore happens in this phase only. Later validation and state transitions
// operate exclusively on the copy, which has no traps, accessors or custom
// prototypes, so caller code cannot run between a state check and the state
// transition that depends on it. Standard JavaScript offers no portable way to
// detect a Proxy, so the boundary copies instead of attempting detection.
const INPUT_SNAPSHOT_LIMITS = Object.freeze({
  maxDepth: 4,
  maxNodes: 512,
  maxObjectKeys: 32,
  maxArrayLength: 64,
});

function snapshotInput(value, label) {
  const budget = { nodes: 0 };
  return snapshotValue(value, label, 0, budget);
}

function snapshotValue(value, label, depth, budget) {
  if (typeof value === 'function') {
    fail(`${label} must be plain data, not a function.`);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  budget.nodes += 1;
  if (budget.nodes > INPUT_SNAPSHOT_LIMITS.maxNodes) {
    fail(`${label} exceeds the maximum number of input nodes.`);
  }
  if (depth > INPUT_SNAPSHOT_LIMITS.maxDepth) {
    fail(`${label} exceeds the maximum input nesting depth.`);
  }
  if (ArrayBuffer.isView(value)) {
    fail(`${label} must be a plain object or dense plain array.`);
  }
  if (Array.isArray(value)) {
    return snapshotArray(value, label, depth, budget);
  }
  return snapshotObject(value, label, depth, budget);
}

function readDataDescriptor(value, key, label, kindLabel) {
  const desc = Reflect.getOwnPropertyDescriptor(value, key);
  if (!desc || !('value' in desc) || desc.get !== undefined || desc.set !== undefined) {
    fail(`${label} ${kindLabel}`);
  }
  return desc.value;
}

function snapshotArray(value, label, depth, budget) {
  if (Reflect.getPrototypeOf(value) !== Array.prototype) {
    fail(`${label} must be a dense plain array.`);
  }
  const length = readDataDescriptor(value, 'length', label, 'must be a dense plain array.');
  if (!Number.isSafeInteger(length) || length < 0) {
    fail(`${label} must be a dense plain array.`);
  }
  if (length > INPUT_SNAPSHOT_LIMITS.maxArrayLength) {
    fail(`${label} exceeds maximum length.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1) {
    fail(`${label} must be a dense array without extra properties.`);
  }
  for (const key of ownKeys) {
    if (key === 'length') {
      continue;
    }
    if (typeof key !== 'string' || String(Number(key)) !== key || !(Number(key) < length)) {
      fail(`${label} must be a dense array without extra properties.`);
    }
  }
  const copied = new Array(length);
  for (let i = 0; i < length; i++) {
    const element = readDataDescriptor(
      value,
      String(i),
      label,
      'must be a dense array without holes or accessor properties.',
    );
    copied[i] = snapshotValue(element, `${label}[${i}]`, depth + 1, budget);
  }
  return Object.freeze(copied);
}

function snapshotObject(value, label, depth, budget) {
  const proto = Reflect.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail(`${label} must have a standard object prototype.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > INPUT_SNAPSHOT_LIMITS.maxObjectKeys) {
    fail(`${label} contains too many fields.`);
  }
  const copied = Object.create(null);
  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      fail(`${label} contains a non-string property key.`);
    }
    if (PROTOTYPE_KEY_SET.has(key)) {
      fail(`${label} contains a forbidden prototype key.`);
    }
    const field = readDataDescriptor(value, key, label, 'cannot contain accessor properties.');
    Object.defineProperty(copied, key, {
      value: snapshotValue(field, `${label}.${key}`, depth + 1, budget),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(copied);
}

function validateIdentifier(value, label) {
  if (typeof value !== 'string' || !hasWellFormedUnicode(value)) {
    fail(`Invalid ${label}.`);
  }
  if (PROTOTYPE_KEY_SET.has(value) || FORBIDDEN_IDENTIFIER_SET.has(value)) {
    fail(`Forbidden ${label} identifier.`);
  }
  if (value.length === 0 || value.length > PROJECT_CONTEXT_LIMITS.identifier || !IDENTIFIER_PATTERN.test(value)) {
    fail(`Invalid ${label} format.`);
  }
  return value;
}

function validateSingleLineLabel(value, label, maxLength = PROJECT_CONTEXT_LIMITS.purposeLabel) {
  if (typeof value !== 'string' || !hasWellFormedUnicode(value)) {
    fail(`Invalid ${label}.`);
  }
  if (value.length === 0 || value.length > maxLength || !value.trim() || CONTROL_OR_BIDI_PATTERN.test(value)) {
    fail(`Invalid ${label}.`);
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(value)) {
      fail(`${label} cannot contain credential material.`);
    }
  }
  return value;
}

function validateVersion(value) {
  if (typeof value !== 'string' || !hasWellFormedUnicode(value)) {
    fail('Invalid entry version.');
  }
  if (value.length === 0 || value.length > PROJECT_CONTEXT_LIMITS.version || !VERSION_PATTERN.test(value)) {
    fail('Invalid entry version format.');
  }
  return value;
}

function validateSourceRef(value) {
  if (typeof value !== 'string' || !hasWellFormedUnicode(value)) {
    fail('Invalid sourceRef.');
  }
  if (
    value.length === 0 ||
    value.length > PROJECT_CONTEXT_LIMITS.sourceRef ||
    value.trim() !== value ||
    CONTROL_OR_BIDI_PATTERN.test(value) ||
    value.startsWith('/') ||
    /^[a-zA-Z]:/.test(value) ||
    value.includes('\\') ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i.test(value) ||
    /[<>:"|?*]/.test(value)
  ) {
    fail('Invalid sourceRef path.');
  }
  const parts = value.split('/');
  for (const part of parts) {
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      part.endsWith('.') ||
      part.endsWith(' ') ||
      /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/i.test(part)
    ) {
      fail('Invalid sourceRef path segment.');
    }
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(value)) {
      fail('sourceRef cannot contain credential material.');
    }
  }
  return value;
}

function validateContent(value, label = 'content', maxBytes = PROJECT_CONTEXT_LIMITS.maxContentBytes) {
  if (typeof value !== 'string' || !hasWellFormedUnicode(value)) {
    fail(`Invalid ${label}.`);
  }
  if (!value.trim() || CONTENT_CONTROL_PATTERN.test(value)) {
    fail(`Invalid ${label}.`);
  }
  const encoded = utf8Bytes(value);
  if (encoded.byteLength === 0 || encoded.byteLength > maxBytes) {
    fail(`${label} exceeds allowed byte length.`);
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(value)) {
      fail(`${label} cannot contain credential material.`);
    }
  }
  return { text: value, bytes: encoded };
}

function validateOptionalTimestamp(value, label) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`Invalid ${label} timestamp.`);
  }
  return value;
}

function validateCapabilities(kind, rawCapabilities) {
  if (rawCapabilities === undefined) {
    return [];
  }
  const capabilities = readDenseArray(
    rawCapabilities,
    'requestedCapabilities',
    PROJECT_CONTEXT_LIMITS.maxCapabilities,
  );
  if (kind === 'memory' && capabilities.length > 0) {
    fail('Memory entries cannot declare requestedCapabilities.');
  }
  const seen = new Set();
  const normalized = [];
  for (let i = 0; i < capabilities.length; i++) {
    const cap = validateIdentifier(capabilities[i], `requestedCapabilities[${i}]`);
    if (seen.has(cap)) {
      fail('Duplicate requestedCapabilities are not allowed.');
    }
    seen.add(cap);
    normalized.push(cap);
  }
  normalized.sort(compareAscii);
  return normalized;
}

function validateProvenance(rawProvenance) {
  assertPlainObject(rawProvenance, 'provenance', [
    'selectionMode',
    'sourceKind',
    'sourceRef',
    'version',
    'sourceHash',
  ]);
  const selectionMode = readOwnValue(rawProvenance, 'selectionMode');
  if (selectionMode !== 'explicit') {
    fail('Context entries require provenance.selectionMode === "explicit" (no automatic discovery).');
  }
  const sourceKind = readOwnValue(rawProvenance, 'sourceKind');
  if (!PROJECT_CONTEXT_SOURCE_KINDS.includes(sourceKind)) {
    fail('Unsupported provenance.sourceKind.');
  }
  const sourceRef = validateSourceRef(readOwnValue(rawProvenance, 'sourceRef'));
  const version = validateVersion(readOwnValue(rawProvenance, 'version'));
  const rawSourceHash = readOwnValue(rawProvenance, 'sourceHash');
  let sourceHash = null;
  if (rawSourceHash !== undefined && rawSourceHash !== null) {
    if (typeof rawSourceHash !== 'string' || !SHA256_PATTERN.test(rawSourceHash)) {
      fail('Invalid provenance.sourceHash.');
    }
    sourceHash = rawSourceHash;
  }
  return {
    selectionMode,
    sourceKind,
    sourceRef,
    version,
    sourceHash,
  };
}

function snapshotProvenance(provenance) {
  return {
    ...provenance,
    sourceHashStatus: provenance.sourceHash === null ? 'not-provided' : 'claimed-unverified',
    sourceHashVerified: false,
  };
}

function computeRevisionId(record) {
  const payload = JSON.stringify([
    record.projectId,
    record.entryId,
    record.kind,
    record.revisionNumber,
    record.provenance.version,
    record.contentSha256,
    record.requestedCapabilities,
    record.provenance.sourceKind,
    record.provenance.sourceRef,
    record.provenance.sourceHash,
    record.expiresAt,
    record.updatedAt,
  ]);
  return sha256Hex(utf8Bytes(payload));
}

function computeApprovalDigest(record) {
  const payload = JSON.stringify([
    record.projectId,
    record.entryId,
    record.kind,
    record.revisionId,
    record.revisionNumber,
    record.provenance.version,
    record.contentSha256,
    record.requestedCapabilities,
    record.provenance.sourceKind,
    record.provenance.sourceRef,
    record.provenance.sourceHash,
    record.expiresAt,
  ]);
  return sha256Hex(utf8Bytes(payload));
}

function resolveEntryStatus(record, now) {
  if (record.revoked) {
    return 'revoked';
  }
  if (record.expiresAt !== null && now >= record.expiresAt) {
    return 'expired';
  }
  if (!record.approval) {
    return 'pending-approval';
  }
  if (
    record.approval.revisionId !== record.revisionId ||
    record.approval.revisionNumber !== record.revisionNumber ||
    record.approval.version !== record.provenance.version ||
    record.approval.approvalDigest !== record.approvalDigest
  ) {
    return 'pending-approval';
  }
  if (record.approval.expiresAt !== null && now >= record.approval.expiresAt) {
    return 'expired';
  }
  return 'approved';
}

function cloneEntrySnapshot(record, now) {
  const status = resolveEntryStatus(record, now);
  return deepFreeze({
    projectId: record.projectId,
    entryId: record.entryId,
    kind: record.kind,
    purposeLabel: record.purposeLabel,
    version: record.provenance.version,
    revisionId: record.revisionId,
    revisionNumber: record.revisionNumber,
    usedVersions: [...record.usedVersions],
    content: record.content,
    contentSha256: record.contentSha256,
    approvalDigest: record.approvalDigest,
    requestedCapabilities: [...record.requestedCapabilities],
    provenance: snapshotProvenance(record.provenance),
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    previousApprovalInvalidated: record.previousApprovalInvalidated,
    revoked: record.revoked,
    revokedAt: record.revokedAt,
    revokedBy: record.revokedBy,
    revocationReason: record.revocationReason,
    status,
    approval: record.approval ? { ...record.approval } : null,
  });
}

function cloneTemplateSnapshot(template) {
  return deepFreeze({
    projectId: template.projectId,
    templateId: template.templateId,
    title: template.title,
    workflowKind: template.workflowKind,
    inputs: {
      requestText: template.inputs.requestText,
      targetScopeLabels: [...template.inputs.targetScopeLabels],
      selectedEntryRefs: template.inputs.selectedEntryRefs.map((ref) => ({ ...ref })),
    },
    createdAt: template.createdAt,
    executableApproval: null,
    canAutoApprove: false,
    requiresOwnerApproval: true,
    authorityStatus: 'inputs-only-never-executable-approval',
  });
}

function entryKey(projectId, entryId) {
  return `${projectId}\u0000${entryId}`;
}

export class ProjectContextLibrary {
  #clock;
  #entries;
  #projectEntryCounts;
  #templates;
  #projectTemplateCounts;
  #approvalSequence;
  #busy;

  constructor({ clock = () => Date.now() } = {}) {
    if (typeof clock !== 'function') {
      fail('clock must be a function.');
    }
    this.#clock = clock;
    this.#entries = new Map();
    this.#projectEntryCounts = new Map();
    this.#templates = new Map();
    this.#projectTemplateCounts = new Map();
    this.#approvalSequence = 0;
    this.#busy = false;
  }

  // Runs one public operation under a non-reentrant lock. Caller-controlled
  // code (input Proxy traps or the injected clock) that calls back into this
  // library while an operation is in progress is rejected, so no operation can
  // observe or mutate state between another operation's checks and its state
  // transition. The raw input is snapshotted into inert data before the clock
  // or any library state is read (see snapshotInput).
  #run(rawInput, label, operation) {
    if (this.#busy) {
      fail('ProjectContextLibrary rejects reentrant calls while another operation is in progress.');
    }
    this.#busy = true;
    try {
      const input = snapshotInput(rawInput, label);
      return operation(input);
    } finally {
      this.#busy = false;
    }
  }

  registerEntry(input) {
    return this.#run(input, 'entry', (data) => this.#registerEntry(data));
  }

  proposeEntryVersion(input) {
    return this.#run(input, 'entryVersionProposal', (data) => this.#proposeEntryVersion(data));
  }

  approveEntry(input) {
    return this.#run(input, 'approval', (data) => this.#approveEntry(data));
  }

  revokeEntry(input) {
    return this.#run(input, 'revocation', (data) => this.#revokeEntry(data));
  }

  getEntry(input) {
    return this.#run(input, 'entryLookup', (data) => this.#getEntry(data));
  }

  listEntries(input) {
    return this.#run(input, 'listEntries', (data) => this.#listEntries(data));
  }

  previewPromptContext(input) {
    return this.#run(input, 'previewPromptContext', (data) => this.#previewPromptContext(data));
  }

  createTaskTemplate(input) {
    return this.#run(input, 'taskTemplate', (data) => this.#createTaskTemplate(data));
  }

  instantiateTemplateDraft(input) {
    return this.#run(input, 'instantiateTemplateDraft', (data) => this.#instantiateTemplateDraft(data));
  }

  #now() {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      fail('Clock must return a nonnegative safe integer timestamp.');
    }
    return now;
  }

  #registerEntry(input) {
    assertPlainObject(input, 'entry', [
      'projectId',
      'entryId',
      'kind',
      'purposeLabel',
      'content',
      'requestedCapabilities',
      'provenance',
      'expiresAt',
    ]);
    const now = this.#now();
    const projectId = validateIdentifier(readOwnValue(input, 'projectId'), 'projectId');
    const entryId = validateIdentifier(readOwnValue(input, 'entryId'), 'entryId');
    const key = entryKey(projectId, entryId);
    if (this.#entries.has(key)) {
      fail('Entry already exists in this project. Use proposeEntryVersion for new versions.');
    }

    const projectCount = this.#projectEntryCounts.get(projectId) ?? 0;
    if (projectCount >= PROJECT_CONTEXT_LIMITS.maxEntriesPerProject) {
      fail('Project entry limit exceeded.');
    }

    const kind = readOwnValue(input, 'kind');
    if (!PROJECT_CONTEXT_ENTRY_KINDS.includes(kind)) {
      fail('Unsupported entry kind.');
    }

    const purposeLabel = validateSingleLineLabel(readOwnValue(input, 'purposeLabel'), 'purposeLabel');
    const { text: content, bytes: contentBytes } = validateContent(readOwnValue(input, 'content'));
    const requestedCapabilities = validateCapabilities(kind, readOwnValue(input, 'requestedCapabilities'));
    const provenance = validateProvenance(readOwnValue(input, 'provenance'));
    const expiresAt = validateOptionalTimestamp(readOwnValue(input, 'expiresAt'), 'expiresAt');
    if (expiresAt !== null && expiresAt <= now) {
      fail('Cannot register an already-expired entry.');
    }

    const contentSha256 = sha256Hex(contentBytes);
    const record = {
      projectId,
      entryId,
      kind,
      purposeLabel,
      content,
      contentSha256,
      requestedCapabilities,
      provenance,
      expiresAt,
      createdAt: now,
      updatedAt: now,
      revisionNumber: 1,
      revisionId: '',
      usedVersions: new Set([provenance.version]),
      previousApprovalInvalidated: false,
      revoked: false,
      revokedAt: null,
      revokedBy: null,
      revocationReason: null,
      approval: null,
      approvalDigest: '',
    };
    record.revisionId = computeRevisionId(record);
    record.approvalDigest = computeApprovalDigest(record);

    this.#entries.set(key, record);
    this.#projectEntryCounts.set(projectId, projectCount + 1);
    return cloneEntrySnapshot(record, now);
  }

  #proposeEntryVersion(input) {
    assertPlainObject(input, 'entryVersionProposal', [
      'projectId',
      'entryId',
      'purposeLabel',
      'content',
      'requestedCapabilities',
      'provenance',
      'expiresAt',
    ]);
    const now = this.#now();
    const projectId = validateIdentifier(readOwnValue(input, 'projectId'), 'projectId');
    const entryId = validateIdentifier(readOwnValue(input, 'entryId'), 'entryId');
    const key = entryKey(projectId, entryId);
    const existing = this.#entries.get(key);
    if (!existing) {
      fail('Entry not found in project.');
    }
    if (existing.revoked) {
      fail('Cannot propose a new version for a revoked entry.');
    }

    const provenance = validateProvenance(readOwnValue(input, 'provenance'));
    if (provenance.version === existing.provenance.version) {
      fail('Version must change when proposing an updated entry.');
    }
    if (existing.usedVersions.has(provenance.version)) {
      fail('Entry versions are immutable and cannot reuse a previously used version.');
    }

    const rawLabel = readOwnValue(input, 'purposeLabel');
    const purposeLabel =
      rawLabel === undefined ? existing.purposeLabel : validateSingleLineLabel(rawLabel, 'purposeLabel');
    const { text: content, bytes: contentBytes } = validateContent(readOwnValue(input, 'content'));
    const requestedCapabilities = validateCapabilities(
      existing.kind,
      readOwnValue(input, 'requestedCapabilities'),
    );
    const rawExpiresAt = readOwnValue(input, 'expiresAt');
    const expiresAt =
      rawExpiresAt === undefined ? existing.expiresAt : validateOptionalTimestamp(rawExpiresAt, 'expiresAt');
    if (expiresAt !== null && expiresAt <= now) {
      fail('Cannot propose an already-expired entry version.');
    }

    const hadApproval = existing.approval !== null || existing.previousApprovalInvalidated;
    existing.revisionNumber += 1;
    existing.purposeLabel = purposeLabel;
    existing.content = content;
    existing.contentSha256 = sha256Hex(contentBytes);
    existing.requestedCapabilities = requestedCapabilities;
    existing.provenance = provenance;
    existing.usedVersions.add(provenance.version);
    existing.expiresAt = expiresAt;
    existing.updatedAt = now;
    existing.revisionId = computeRevisionId(existing);
    existing.approval = null;
    existing.previousApprovalInvalidated = hadApproval;
    existing.approvalDigest = computeApprovalDigest(existing);

    return cloneEntrySnapshot(existing, now);
  }

  #approveEntry(input) {
    assertPlainObject(input, 'approval', [
      'projectId',
      'entryId',
      'version',
      'approvedBy',
      'expiresAt',
      'expectedDigest',
      'expectedRevisionId',
    ]);
    const now = this.#now();
    const projectId = validateIdentifier(readOwnValue(input, 'projectId'), 'projectId');
    const entryId = validateIdentifier(readOwnValue(input, 'entryId'), 'entryId');
    const version = validateVersion(readOwnValue(input, 'version'));
    const approvedBy = validateIdentifier(readOwnValue(input, 'approvedBy'), 'approvedBy');
    const expiresAt = validateOptionalTimestamp(readOwnValue(input, 'expiresAt'), 'approval.expiresAt');
    const expectedDigest = readOwnValue(input, 'expectedDigest');
    const expectedRevisionId = readOwnValue(input, 'expectedRevisionId');

    const record = this.#entries.get(entryKey(projectId, entryId));
    if (!record) {
      fail('Entry not found in project.');
    }
    if (record.revoked) {
      fail('Cannot approve a revoked entry.');
    }
    if (record.expiresAt !== null && now >= record.expiresAt) {
      fail('Cannot approve an expired entry.');
    }
    if (record.provenance.version !== version) {
      fail('Approval version does not match the current entry version.');
    }
    if (expectedDigest === undefined || expectedDigest === null) {
      fail('expectedDigest is required for entry approval.');
    }
    if (typeof expectedDigest !== 'string' || !SHA256_PATTERN.test(expectedDigest)) {
      fail('Invalid expectedDigest.');
    }
    if (expectedDigest !== record.approvalDigest) {
      fail('Approval digest does not match the current entry.');
    }
    if (expectedRevisionId !== undefined) {
      if (typeof expectedRevisionId !== 'string' || !SHA256_PATTERN.test(expectedRevisionId)) {
        fail('Invalid expectedRevisionId.');
      }
      if (expectedRevisionId !== record.revisionId) {
        fail('Approval expectedRevisionId does not match the current entry revision.');
      }
    }
    if (expiresAt !== null && expiresAt <= now) {
      fail('Approval expiresAt must be in the future.');
    }

    this.#approvalSequence += 1;
    record.approval = {
      approvalId: `appr-${this.#approvalSequence}`,
      projectId,
      entryId,
      version,
      revisionId: record.revisionId,
      revisionNumber: record.revisionNumber,
      contentSha256: record.contentSha256,
      approvalDigest: record.approvalDigest,
      approvedBy,
      approvedAt: now,
      expiresAt,
    };
    record.previousApprovalInvalidated = false;

    return cloneEntrySnapshot(record, now);
  }

  #revokeEntry(input) {
    assertPlainObject(input, 'revocation', ['projectId', 'entryId', 'revokedBy', 'reason']);
    const now = this.#now();
    const projectId = validateIdentifier(readOwnValue(input, 'projectId'), 'projectId');
    const entryId = validateIdentifier(readOwnValue(input, 'entryId'), 'entryId');
    const revokedBy = validateIdentifier(readOwnValue(input, 'revokedBy'), 'revokedBy');
    const rawReason = readOwnValue(input, 'reason');
    const reason =
      rawReason === undefined ? 'owner-revoked' : validateSingleLineLabel(rawReason, 'revocation.reason');

    const record = this.#entries.get(entryKey(projectId, entryId));
    if (!record) {
      fail('Entry not found in project.');
    }

    if (!record.revoked) {
      record.revoked = true;
      record.revokedAt = now;
      record.revokedBy = revokedBy;
      record.revocationReason = reason;
      record.approval = null;
      record.updatedAt = now;
    }

    return cloneEntrySnapshot(record, now);
  }

  #getEntry(input) {
    assertPlainObject(input, 'entryLookup', ['projectId', 'entryId']);
    const now = this.#now();
    const projectId = validateIdentifier(readOwnValue(input, 'projectId'), 'projectId');
    const entryId = validateIdentifier(readOwnValue(input, 'entryId'), 'entryId');
    const record = this.#entries.get(entryKey(projectId, entryId));
    if (!record) {
      return null;
    }
    return cloneEntrySnapshot(record, now);
  }

  #listEntries(input) {
    assertPlainObject(input, 'listEntries', ['projectId', 'includeExcluded']);
    const now = this.#now();
    const projectId = validateIdentifier(readOwnValue(input, 'projectId'), 'projectId');
    const rawIncludeExcluded = readOwnValue(input, 'includeExcluded');
    const includeExcluded = rawIncludeExcluded === undefined ? true : rawIncludeExcluded;
    if (typeof includeExcluded !== 'boolean') {
      fail('includeExcluded must be a boolean.');
    }

    const items = [];
    for (const record of this.#entries.values()) {
      if (record.projectId !== projectId) {
        continue;
      }
      const snapshot = cloneEntrySnapshot(record, now);
      if (!includeExcluded && snapshot.status !== 'approved') {
        continue;
      }
      items.push(snapshot);
    }

    items.sort((a, b) => compareAscii(a.kind, b.kind) || compareAscii(a.entryId, b.entryId));
    return deepFreeze(items);
  }

  #previewPromptContext(input) {
    assertPlainObject(input, 'previewPromptContext', ['projectId', 'entryIds']);
    const now = this.#now();
    return this.#previewPromptContextAt(input, now);
  }

  #previewPromptContextAt(input, now) {
    const projectId = validateIdentifier(readOwnValue(input, 'projectId'), 'projectId');
    const entryIds = readDenseArray(
      readOwnValue(input, 'entryIds'),
      'entryIds',
      PROJECT_CONTEXT_LIMITS.maxSelectedEntries,
    );

    const seenSelectionKeys = new Set();
    const included = [];
    const excluded = [];

    for (let i = 0; i < entryIds.length; i++) {
      const item = entryIds[i];
      let targetProjectId = projectId;
      let entryId;

      if (typeof item === 'string') {
        entryId = validateIdentifier(item, `entryIds[${i}]`);
      } else {
        assertPlainObject(item, `entryIds[${i}]`, ['projectId', 'entryId']);
        const itemProjectId = readOwnValue(item, 'projectId');
        targetProjectId =
          itemProjectId === undefined
            ? projectId
            : validateIdentifier(itemProjectId, `entryIds[${i}].projectId`);
        entryId = validateIdentifier(readOwnValue(item, 'entryId'), `entryIds[${i}].entryId`);
      }

      const dedupeKey = `${targetProjectId}\u0000${entryId}`;
      if (seenSelectionKeys.has(dedupeKey)) {
        fail('Duplicate entry selection in previewPromptContext.');
      }
      seenSelectionKeys.add(dedupeKey);

      if (targetProjectId !== projectId) {
        excluded.push({
          entryId,
          reason: 'cross-project-excluded',
        });
        continue;
      }

      const record = this.#entries.get(entryKey(projectId, entryId));
      if (!record) {
        excluded.push({
          entryId,
          reason: 'not-found-in-project',
        });
        continue;
      }

      if (record.revoked) {
        excluded.push({
          entryId,
          reason: 'revoked',
        });
        continue;
      }

      if (!record.approval) {
        excluded.push({
          entryId,
          reason: record.previousApprovalInvalidated ? 'approval-invalidated' : 'unapproved',
        });
        continue;
      }

      if (
        record.approval.revisionId !== record.revisionId ||
        record.approval.revisionNumber !== record.revisionNumber ||
        record.approval.version !== record.provenance.version ||
        record.approval.approvalDigest !== record.approvalDigest
      ) {
        excluded.push({
          entryId,
          reason: 'approval-invalidated',
        });
        continue;
      }

      if (
        (record.expiresAt !== null && now >= record.expiresAt) ||
        (record.approval.expiresAt !== null && now >= record.approval.expiresAt)
      ) {
        excluded.push({
          entryId,
          reason: 'expired',
        });
        continue;
      }

      included.push({
        projectId: record.projectId,
        entryId: record.entryId,
        kind: record.kind,
        purposeLabel: record.purposeLabel,
        version: record.provenance.version,
        revisionId: record.revisionId,
        revisionNumber: record.revisionNumber,
        contentSha256: record.contentSha256,
        approvalId: record.approval.approvalId,
        approvalDigest: record.approvalDigest,
        requestedCapabilities: [...record.requestedCapabilities],
        provenance: snapshotProvenance(record.provenance),
        content: record.content,
      });
    }

    included.sort((a, b) => compareAscii(a.kind, b.kind) || compareAscii(a.entryId, b.entryId));
    excluded.sort((a, b) => compareAscii(a.entryId, b.entryId) || compareAscii(a.reason, b.reason));

    const promptBlocks = included.map((entry) => {
      const lines = [
        `[context:${entry.kind}:${entry.entryId}@${entry.version} sha256=${entry.contentSha256}]`,
      ];
      if (entry.kind === 'skill' && entry.requestedCapabilities.length > 0) {
        lines.push(`capabilities: ${entry.requestedCapabilities.join(', ')}`);
      }
      lines.push(entry.content);
      lines.push(`[/context:${entry.kind}:${entry.entryId}]`);
      return lines.join('\n');
    });

    const promptText = promptBlocks.join('\n\n');
    const promptBytes = utf8Bytes(promptText);
    if (promptBytes.byteLength > PROJECT_CONTEXT_LIMITS.maxPreviewPromptBytes) {
      fail(
        `Prompt preview exceeds maxPreviewPromptBytes (${promptBytes.byteLength} > ${PROJECT_CONTEXT_LIMITS.maxPreviewPromptBytes}).`,
      );
    }
    const promptSha256 = sha256Hex(promptBytes);
    const previewDigestBytes = utf8Bytes(
      JSON.stringify([
        projectId,
        included.map((entry) => [
          entry.entryId,
          entry.kind,
          entry.revisionId,
          entry.version,
          entry.approvalDigest,
          entry.contentSha256,
        ]),
        promptSha256,
      ]),
    );
    if (previewDigestBytes.byteLength > PROJECT_CONTEXT_LIMITS.maxPreviewPromptBytes) {
      fail(
        `Prompt preview digest payload exceeds maxPreviewPromptBytes (${previewDigestBytes.byteLength} > ${PROJECT_CONTEXT_LIMITS.maxPreviewPromptBytes}).`,
      );
    }
    const previewDigest = sha256Hex(previewDigestBytes);

    return deepFreeze({
      projectId,
      evaluatedAt: now,
      included,
      excluded,
      promptText,
      promptSha256,
      previewDigest,
    });
  }

  #createTaskTemplate(input) {
    assertPlainObject(input, 'taskTemplate', [
      'projectId',
      'templateId',
      'title',
      'workflowKind',
      'inputs',
    ]);
    const now = this.#now();
    const projectId = validateIdentifier(readOwnValue(input, 'projectId'), 'projectId');
    const templateId = validateIdentifier(readOwnValue(input, 'templateId'), 'templateId');
    const key = entryKey(projectId, templateId);
    if (this.#templates.has(key)) {
      fail('Template already exists in this project.');
    }

    const templateCount = this.#projectTemplateCounts.get(projectId) ?? 0;
    if (templateCount >= PROJECT_CONTEXT_LIMITS.maxTemplatesPerProject) {
      fail('Project template limit exceeded.');
    }

    const title = validateSingleLineLabel(readOwnValue(input, 'title'), 'template.title');
    const workflowKind = readOwnValue(input, 'workflowKind');
    if (!TASK_WORKFLOW_KINDS.includes(workflowKind)) {
      fail('Unsupported template workflowKind.');
    }

    const rawInputs = readOwnValue(input, 'inputs');
    assertPlainObject(rawInputs, 'template.inputs', [
      'requestText',
      'targetScopeLabels',
      'selectedEntryRefs',
    ]);

    const { text: requestText } = validateContent(
      readOwnValue(rawInputs, 'requestText'),
      'template.inputs.requestText',
      PROJECT_CONTEXT_LIMITS.maxRequestTextBytes,
    );

    const rawScopeLabels = readOwnValue(rawInputs, 'targetScopeLabels');
    const scopeLabels =
      rawScopeLabels === undefined
        ? []
        : readDenseArray(
            rawScopeLabels,
            'template.inputs.targetScopeLabels',
            PROJECT_CONTEXT_LIMITS.maxScopeLabels,
          );
    const targetScopeLabels = scopeLabels.map((item, idx) =>
      validateSingleLineLabel(item, `targetScopeLabels[${idx}]`),
    );

    const rawRefs = readOwnValue(rawInputs, 'selectedEntryRefs');
    const refs =
      rawRefs === undefined
        ? []
        : readDenseArray(
            rawRefs,
            'template.inputs.selectedEntryRefs',
            PROJECT_CONTEXT_LIMITS.maxSelectedEntries,
          );
    const seenRefIds = new Set();
    const selectedEntryRefs = refs.map((ref, idx) => {
      assertPlainObject(ref, `selectedEntryRefs[${idx}]`, [
        'entryId',
        'kind',
        'pinnedVersion',
        'pinnedDigest',
        'pinnedRevisionId',
      ]);
      const entryId = validateIdentifier(readOwnValue(ref, 'entryId'), `selectedEntryRefs[${idx}].entryId`);
      if (seenRefIds.has(entryId)) {
        fail('Duplicate selectedEntryRefs in template.');
      }
      seenRefIds.add(entryId);
      const rawKind = readOwnValue(ref, 'kind');
      const kind = rawKind === undefined ? null : rawKind;
      if (kind !== null && !PROJECT_CONTEXT_ENTRY_KINDS.includes(kind)) {
        fail('Invalid selectedEntryRef kind.');
      }
      const rawPinnedVersion = readOwnValue(ref, 'pinnedVersion');
      const pinnedVersion = rawPinnedVersion === undefined ? null : validateVersion(rawPinnedVersion);
      const rawPinnedDigest = readOwnValue(ref, 'pinnedDigest');
      let pinnedDigest = null;
      if (rawPinnedDigest !== undefined && rawPinnedDigest !== null) {
        if (typeof rawPinnedDigest !== 'string' || !SHA256_PATTERN.test(rawPinnedDigest)) {
          fail(`Invalid selectedEntryRefs[${idx}].pinnedDigest.`);
        }
        pinnedDigest = rawPinnedDigest;
      }
      const rawPinnedRevisionId = readOwnValue(ref, 'pinnedRevisionId');
      let pinnedRevisionId = null;
      if (rawPinnedRevisionId !== undefined && rawPinnedRevisionId !== null) {
        if (typeof rawPinnedRevisionId !== 'string' || !SHA256_PATTERN.test(rawPinnedRevisionId)) {
          fail(`Invalid selectedEntryRefs[${idx}].pinnedRevisionId.`);
        }
        pinnedRevisionId = rawPinnedRevisionId;
      }
      return {
        entryId,
        kind,
        pinnedVersion,
        pinnedDigest,
        pinnedRevisionId,
      };
    });

    const template = {
      projectId,
      templateId,
      title,
      workflowKind,
      inputs: {
        requestText,
        targetScopeLabels,
        selectedEntryRefs,
      },
      createdAt: now,
    };

    this.#templates.set(key, template);
    this.#projectTemplateCounts.set(projectId, templateCount + 1);
    return cloneTemplateSnapshot(template);
  }

  #instantiateTemplateDraft(input) {
    assertPlainObject(input, 'instantiateTemplateDraft', ['projectId', 'templateId']);
    const now = this.#now();
    const projectId = validateIdentifier(readOwnValue(input, 'projectId'), 'projectId');
    const templateId = validateIdentifier(readOwnValue(input, 'templateId'), 'templateId');
    const template = this.#templates.get(entryKey(projectId, templateId));
    if (!template) {
      fail('Template not found in project.');
    }

    const eligibleEntryIds = [];
    const entryChecks = [];

    for (const ref of template.inputs.selectedEntryRefs) {
      const record = this.#entries.get(entryKey(projectId, ref.entryId));
      if (!record) {
        entryChecks.push({
          entryId: ref.entryId,
          eligible: false,
          reason: 'not-found-in-project',
        });
        continue;
      }
      if (ref.kind !== null && record.kind !== ref.kind) {
        entryChecks.push({
          entryId: ref.entryId,
          eligible: false,
          reason: 'kind-mismatch',
        });
        continue;
      }
      if (record.revoked) {
        entryChecks.push({
          entryId: ref.entryId,
          eligible: false,
          reason: 'revoked',
        });
        continue;
      }
      if (ref.pinnedVersion !== null && record.provenance.version !== ref.pinnedVersion) {
        entryChecks.push({
          entryId: ref.entryId,
          eligible: false,
          reason: 'pinned-version-mismatch',
        });
        continue;
      }
      if (ref.pinnedDigest !== null && record.approvalDigest !== ref.pinnedDigest) {
        entryChecks.push({
          entryId: ref.entryId,
          eligible: false,
          reason: 'pinned-digest-mismatch',
        });
        continue;
      }
      if (ref.pinnedRevisionId !== null && record.revisionId !== ref.pinnedRevisionId) {
        entryChecks.push({
          entryId: ref.entryId,
          eligible: false,
          reason: 'pinned-revision-mismatch',
        });
        continue;
      }
      const status = resolveEntryStatus(record, now);
      if (status !== 'approved') {
        entryChecks.push({
          entryId: ref.entryId,
          eligible: false,
          reason:
            status === 'pending-approval' && record.previousApprovalInvalidated
              ? 'approval-invalidated'
              : status === 'pending-approval'
                ? 'unapproved'
                : status,
        });
        continue;
      }

      eligibleEntryIds.push(ref.entryId);
      entryChecks.push({
        entryId: ref.entryId,
        eligible: true,
        reason: 'approved',
      });
    }

    const contextPreview = this.#previewPromptContextAt(
      {
        projectId,
        entryIds: eligibleEntryIds,
      },
      now,
    );

    return deepFreeze({
      draftOnly: true,
      projectId: template.projectId,
      templateId: template.templateId,
      title: template.title,
      workflowKind: template.workflowKind,
      evaluatedAt: now,
      inputs: {
        requestText: template.inputs.requestText,
        targetScopeLabels: [...template.inputs.targetScopeLabels],
        selectedEntryRefs: template.inputs.selectedEntryRefs.map((ref) => ({ ...ref })),
      },
      entryChecks,
      contextPreview,
      executableApproval: null,
      canAutoApprove: false,
      requiresOwnerApproval: true,
      authorityStatus: 'inputs-only-never-executable-approval',
    });
  }
}

export function createProjectContextLibrary(options) {
  return new ProjectContextLibrary(options);
}
