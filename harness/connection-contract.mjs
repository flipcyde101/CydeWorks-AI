/**
 * Authoritative Connection, Task, and Readiness Contract for CydeWorks AI.
 * Pure, immutable normalization and validation with zero side effects.
 */

export const BILLING_TYPES = Object.freeze(['local', 'subscription', 'metered', 'unknown']);
export const EXECUTION_LOCATIONS = Object.freeze(['local-machine', 'remote-provider', 'unknown']);
export const CLIENT_LOCATIONS = Object.freeze(['local-process', 'local-cli-adapter', 'unknown']);
export const DATA_DESTINATIONS = Object.freeze(['local-loopback', 'remote-endpoint', 'unknown']);
export const AUTH_STATUSES = Object.freeze(['not-required', 'verified', 'expired', 'missing', 'invalid', 'unknown']);
export const QUOTA_STATUSES = Object.freeze(['not-applicable', 'available', 'low', 'exhausted', 'unknown']);
export const EVIDENCE_SOURCES = Object.freeze(['synthetic', 'observed', 'configured', 'unknown']);
export const FIELD_PROVENANCE_KEYS = Object.freeze([
  'software',
  'configuration',
  'authentication',
  'reachability',
  'capabilities',
  'quota',
  'destination',
]);
export const FACT_TRISTATE = Object.freeze(['yes', 'no', 'unknown']);
export const CONFIG_STATES = Object.freeze(['yes', 'no', 'invalid', 'unknown']);
export const AUTH_FACT_STATES = Object.freeze(['yes', 'not-required', 'no', 'expired', 'unknown']);
export const CAPABILITY_STATES = Object.freeze(['supported', 'unsupported', 'unknown']);
export const CAPABILITY_KEYS = Object.freeze([
  'structuredJson',
  'sourceCitationBrief',
  'fileChangeProposal',
  'toolUseDeniedSafe',
  'longContext',
]);
export const PERMISSION_SCOPES = Object.freeze([
  'read-only-source',
  'loopback-http',
  'local-process-spawn',
  'remote-data-egress',
  'repository-write',
  'shell-execution',
]);
export const WORK_MODES = Object.freeze(['read-only', 'repository-write', 'shell-execution']);
export const READINESS_STATES = Object.freeze(['ready', 'blocked', 'unknown']);
export const ADAPTER_KINDS = Object.freeze(['ollama', 'llamacpp', 'opencode', 'synthetic-external', 'unknown']);
export const BACKEND_KINDS = Object.freeze(['ollama', 'llamacpp', 'remote-provider', 'unknown']);
export const IDENTITY_KINDS = Object.freeze(['digest', 'server-metadata', 'provider-model-id', 'unknown']);
export const CLOUD_ROUTING_STATES = Object.freeze(['disabled', 'enabled', 'not-applicable', 'unknown']);

export const LOCAL_PREVIEW_MAX_MODEL_BYTES = 4_000_000_000;
export const LOCAL_PREVIEW_RESERVE_BYTES = 1_300_000_000;

export const LOOPBACK_DISCLAIMER =
  'Loopback access (127.0.0.1) means the local adapter communicates over a local socket; it is not proof of OS network isolation, zero cost, or absence of downstream remote forwarding.';

export const CAPABILITY_LABELS = Object.freeze({
  structuredJson: 'Structured JSON output',
  sourceCitationBrief: 'Source citation brief',
  fileChangeProposal: 'Single-file change proposal',
  toolUseDeniedSafe: 'Proposal-only (tool permissions denied)',
  longContext: 'Extended context specification audit',
});

export const PERMISSION_LABELS = Object.freeze({
  'read-only-source': 'Read approved source snapshot',
  'loopback-http': 'Loopback HTTP transport (127.0.0.1)',
  'local-process-spawn': 'Spawn local adapter process',
  'remote-data-egress': 'Send approved task payload to remote endpoint',
  'repository-write': 'Write directly to repository files',
  'shell-execution': 'Execute local shell commands',
});

const WORK_MODE_PERMISSIONS = Object.freeze({
  'read-only': Object.freeze(['read-only-source']),
  'repository-write': Object.freeze(['read-only-source', 'repository-write']),
  'shell-execution': Object.freeze(['read-only-source', 'repository-write', 'shell-execution']),
});

const OPAQUE_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,80}$/;
const ISSUE_CODE_PATTERN = /^[a-zA-Z0-9_:-]{1,80}$/;
const STRICT_ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Strictly parses an ISO-8601 timestamp string and rejects impossible calendar dates
 * (such as Feb 29 in non-leap years or Apr 31) that Date.parse would roll over.
 */
export function parseStrictIsoTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = STRICT_ISO_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (month < 1 || month > 12) return null;
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  if (match[8]) {
    const offHour = Number(match[9]);
    const offMin = Number(match[10]);
    if (offHour > 23 || offMin > 59) return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeDisplayText(value, fallback, maxLen = 160) {
  if (typeof value !== 'string') return { value: fallback, valid: false };
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned) return { value: fallback, valid: false };
  return { value: cleaned.slice(0, maxLen), valid: true };
}

function pickEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value)
    ? { value, valid: true }
    : { value: fallback, valid: false };
}

function pickOpaqueId(value, fallback) {
  if (typeof value === 'string' && OPAQUE_ID_PATTERN.test(value)) return { value, valid: true };
  return { value: fallback, valid: false };
}

function pickOptionalNonNegativeSafeInt(value) {
  if (value === null || value === undefined) return { value: null, valid: true };
  if (Number.isSafeInteger(value) && value >= 0) return { value, valid: true };
  return { value: null, valid: false };
}

function pickPositiveSafeInt(value) {
  if (value === null || value === undefined) return { value: null, valid: true };
  if (Number.isSafeInteger(value) && value > 0) return { value, valid: true };
  return { value: null, valid: false };
}

function deepFreeze(target) {
  if (target === null || typeof target !== 'object') return target;
  Object.freeze(target);
  for (const key of Object.keys(target)) {
    deepFreeze(target[key]);
  }
  return target;
}

function addUniqueIssue(issues, code) {
  if (!issues.includes(code)) issues.push(code);
}

function mergePriorIssues(issues, raw) {
  if (Array.isArray(raw?.validationIssues)) {
    for (const item of raw.validationIssues.slice(0, 64)) {
      if (typeof item === 'string' && ISSUE_CODE_PATTERN.test(item)) {
        addUniqueIssue(issues, item);
      }
    }
  }
  if (raw?.malformed === true && issues.length === 0) {
    addUniqueIssue(issues, 'preserved_malformed_flag');
  }
}

function deriveAuthFact(authStatus, explicitFact) {
  if (typeof explicitFact === 'string' && AUTH_FACT_STATES.includes(explicitFact)) {
    return { value: explicitFact, valid: true };
  }
  if (authStatus === 'not-required') return { value: 'not-required', valid: true };
  if (authStatus === 'verified') return { value: 'yes', valid: true };
  if (authStatus === 'expired') return { value: 'expired', valid: true };
  if (authStatus === 'missing' || authStatus === 'invalid') return { value: 'no', valid: true };
  return { value: 'unknown', valid: explicitFact === undefined };
}

function deriveBackendKind(adapterKind, rawProvider) {
  if (rawProvider?.backendKind !== undefined) {
    return pickEnum(rawProvider.backendKind, BACKEND_KINDS, 'unknown');
  }
  if (adapterKind === 'ollama') return { value: 'ollama', valid: true };
  if (adapterKind === 'llamacpp') return { value: 'llamacpp', valid: true };
  if (adapterKind === 'synthetic-external') return { value: 'remote-provider', valid: true };
  return { value: 'unknown', valid: true };
}

/**
 * Classifies a structured endpoint URL into loopback, remote, missing, or invalid.
 * Never returns credential-bearing, query-bearing, or fragment-bearing strings.
 */
export function classifyEndpointUrl(endpoint) {
  if (endpoint === null || endpoint === undefined) {
    return Object.freeze({
      kind: 'missing',
      protocol: null,
      hostname: null,
      port: null,
      pathname: null,
      canonicalEndpoint: null,
      redactionReason: null,
      issueCode: null,
    });
  }
  if (typeof endpoint !== 'string' || !endpoint.trim() || /\s/.test(endpoint)) {
    return Object.freeze({
      kind: 'invalid',
      protocol: null,
      hostname: null,
      port: null,
      pathname: null,
      canonicalEndpoint: null,
      redactionReason: 'invalid_url_redacted',
      issueCode: 'invalid_endpoint_url',
    });
  }

  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return Object.freeze({
      kind: 'invalid',
      protocol: null,
      hostname: null,
      port: null,
      pathname: null,
      canonicalEndpoint: null,
      redactionReason: 'invalid_url_redacted',
      issueCode: 'invalid_endpoint_url',
    });
  }

  if (parsed.username || parsed.password) {
    return Object.freeze({
      kind: 'invalid',
      protocol: null,
      hostname: null,
      port: null,
      pathname: null,
      canonicalEndpoint: null,
      redactionReason: 'credentials_redacted',
      issueCode: 'endpoint_contains_credentials',
    });
  }

  if (parsed.search) {
    return Object.freeze({
      kind: 'invalid',
      protocol: null,
      hostname: null,
      port: null,
      pathname: null,
      canonicalEndpoint: null,
      redactionReason: 'query_redacted',
      issueCode: 'endpoint_contains_query_string',
    });
  }

  if (parsed.hash) {
    return Object.freeze({
      kind: 'invalid',
      protocol: null,
      hostname: null,
      port: null,
      pathname: null,
      canonicalEndpoint: null,
      redactionReason: 'fragment_redacted',
      issueCode: 'endpoint_contains_fragment',
    });
  }

  if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1') {
    let port = 80;
    if (parsed.port) {
      if (!/^\d{1,5}$/.test(parsed.port)) {
        return Object.freeze({
          kind: 'invalid',
          protocol: null,
          hostname: null,
          port: null,
          pathname: null,
          canonicalEndpoint: null,
          redactionReason: 'invalid_url_redacted',
          issueCode: 'invalid_endpoint_url',
        });
      }
      port = Number(parsed.port);
      if (port < 1 || port > 65535) {
        return Object.freeze({
          kind: 'invalid',
          protocol: null,
          hostname: null,
          port: null,
          pathname: null,
          canonicalEndpoint: null,
          redactionReason: 'invalid_url_redacted',
          issueCode: 'invalid_endpoint_url',
        });
      }
    }
    const cleanPath = parsed.pathname === '/' ? '' : parsed.pathname;
    const canonicalEndpoint = `http://127.0.0.1${parsed.port ? `:${port}` : ''}${cleanPath}`;
    return Object.freeze({
      kind: 'loopback',
      protocol: 'http:',
      hostname: '127.0.0.1',
      port,
      pathname: parsed.pathname,
      canonicalEndpoint,
      redactionReason: null,
      issueCode: null,
    });
  }

  if (
    (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
    parsed.hostname &&
    parsed.hostname !== '127.0.0.1' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '[::1]' &&
    !parsed.hostname.startsWith('127.')
  ) {
    const port = parsed.port ? Number(parsed.port) : null;
    if (parsed.port && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      return Object.freeze({
        kind: 'invalid',
        protocol: null,
        hostname: null,
        port: null,
        pathname: null,
        canonicalEndpoint: null,
        redactionReason: 'invalid_url_redacted',
        issueCode: 'invalid_endpoint_url',
      });
    }
    const cleanPath = parsed.pathname === '/' ? '' : parsed.pathname;
    const canonicalEndpoint = `${parsed.protocol}//${parsed.hostname}${port ? `:${port}` : ''}${cleanPath}`;
    return Object.freeze({
      kind: 'remote',
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port,
      pathname: parsed.pathname,
      canonicalEndpoint,
      redactionReason: null,
      issueCode: null,
    });
  }

  return Object.freeze({
    kind: 'invalid',
    protocol: null,
    hostname: null,
    port: null,
    pathname: null,
    canonicalEndpoint: null,
    redactionReason: 'invalid_url_redacted',
    issueCode: 'invalid_endpoint_url',
  });
}

function samePermissionRecord(a, b) {
  return (
    a.id === b.id &&
    a.scope === b.scope &&
    a.label === b.label &&
    a.requiredForConnection === b.requiredForConnection &&
    a.granted === b.granted &&
    a.explanation === b.explanation
  );
}

/**
 * Normalizes a raw connection descriptor into an authoritative, frozen Connection Contract.
 * Validation is idempotent across re-normalization and never mutates caller input.
 */
export function normalizeConnectionContract(raw) {
  const issues = [];
  if (!isPlainObject(raw)) {
    addUniqueIssue(issues, 'connection_not_object');
    raw = {};
  }
  mergePriorIssues(issues, raw);

  const idCheck = pickOpaqueId(raw.id, 'unknown-connection');
  if (!idCheck.valid) addUniqueIssue(issues, 'invalid_connection_id');

  const labelCheck = sanitizeDisplayText(raw.label, 'Unknown connection', 140);
  if (!labelCheck.valid) addUniqueIssue(issues, 'invalid_connection_label');

  // Provider and separate inference backend
  const rawProvider = isPlainObject(raw.provider) ? raw.provider : {};
  if (!isPlainObject(raw.provider)) addUniqueIssue(issues, 'invalid_provider_object');
  const providerId = pickOpaqueId(rawProvider.id, 'unknown-provider');
  if (!providerId.valid) addUniqueIssue(issues, 'invalid_provider_id');
  const providerLabel = sanitizeDisplayText(rawProvider.label, 'Unknown provider', 120);
  if (!providerLabel.valid) addUniqueIssue(issues, 'invalid_provider_label');
  const adapterKind = pickEnum(rawProvider.adapterKind, ADAPTER_KINDS, 'unknown');
  if (!adapterKind.valid) addUniqueIssue(issues, 'invalid_adapter_kind');

  // Model
  const rawModel = isPlainObject(raw.model) ? raw.model : {};
  if (!isPlainObject(raw.model)) addUniqueIssue(issues, 'invalid_model_object');
  const modelId = pickOpaqueId(rawModel.id, 'unknown-model');
  if (!modelId.valid) addUniqueIssue(issues, 'invalid_model_id');
  const modelLabel = sanitizeDisplayText(rawModel.label, 'Unknown model', 120);
  if (!modelLabel.valid) addUniqueIssue(issues, 'invalid_model_label');
  const quantization =
    rawModel.quantization == null
      ? null
      : sanitizeDisplayText(rawModel.quantization, '', 60).value || null;

  const backendKind = deriveBackendKind(adapterKind.value, rawProvider);
  if (!backendKind.valid) addUniqueIssue(issues, 'invalid_backend_kind');

  const rawIdentity = isPlainObject(rawModel.identity) ? rawModel.identity : {};
  const idKind = pickEnum(rawIdentity.kind, IDENTITY_KINDS, 'unknown');
  if (rawModel.identity !== undefined && !idKind.valid) addUniqueIssue(issues, 'invalid_identity_kind');
  const idValue =
    rawIdentity.value == null
      ? null
      : sanitizeDisplayText(rawIdentity.value, '', 128).value || null;
  const idVerified = typeof rawIdentity.verified === 'boolean' ? rawIdentity.verified : false;
  const idNote = sanitizeDisplayText(
    rawIdentity.note,
    'Model weight identity has not been independently verified.',
    200
  ).value;

  // Execution route & data destination
  const rawRoute = isPlainObject(raw.executionRoute) ? raw.executionRoute : {};
  if (!isPlainObject(raw.executionRoute)) addUniqueIssue(issues, 'invalid_execution_route');
  const clientLocation = pickEnum(rawRoute.clientLocation, CLIENT_LOCATIONS, 'unknown');
  if (!clientLocation.valid) addUniqueIssue(issues, 'invalid_client_location');
  const executionLocation = pickEnum(rawRoute.executionLocation, EXECUTION_LOCATIONS, 'unknown');
  if (!executionLocation.valid) addUniqueIssue(issues, 'invalid_execution_location');
  const dataDestination = pickEnum(rawRoute.dataDestination, DATA_DESTINATIONS, 'unknown');
  if (!dataDestination.valid) addUniqueIssue(issues, 'invalid_data_destination');
  const rawEndpointInput =
    rawRoute.endpoint == null
      ? null
      : typeof rawRoute.endpoint === 'string'
        ? rawRoute.endpoint.replace(/[\u0000-\u001f\u007f]/g, '').trim()
        : null;
  const endpointClassification = classifyEndpointUrl(
    rawRoute.endpoint === undefined || rawRoute.endpoint === null
      ? null
      : typeof rawRoute.endpoint === 'string'
        ? rawEndpointInput
        : rawRoute.endpoint
  );
  if (rawRoute.endpoint !== undefined && rawRoute.endpoint !== null && endpointClassification.kind === 'invalid') {
    addUniqueIssue(issues, endpointClassification.issueCode ?? 'invalid_endpoint_url');
  }
  const endpoint = endpointClassification.canonicalEndpoint;
  const endpointParts = Object.freeze({
    kind: endpointClassification.kind,
    protocol: endpointClassification.protocol,
    hostname: endpointClassification.hostname,
    port: endpointClassification.port,
  });
  const endpointRedactionReason =
    endpointClassification.redactionReason ??
    (typeof rawRoute.endpointRedactionReason === 'string' &&
    ISSUE_CODE_PATTERN.test(rawRoute.endpointRedactionReason)
      ? rawRoute.endpointRedactionReason
      : null);
  const transportNote =
    rawRoute.transportNote == null
      ? null
      : sanitizeDisplayText(rawRoute.transportNote, '', 160).value || null;
  const hostPolicyRevision =
    rawRoute.hostPolicyRevision == null
      ? 'v1'
      : sanitizeDisplayText(rawRoute.hostPolicyRevision, 'v1', 80).value;
  const cloudRouting =
    rawRoute.cloudRouting === undefined
      ? 'unknown'
      : pickEnum(rawRoute.cloudRouting, CLOUD_ROUTING_STATES, 'unknown').value;
  if (rawRoute.cloudRouting !== undefined && !CLOUD_ROUTING_STATES.includes(rawRoute.cloudRouting)) {
    addUniqueIssue(issues, 'invalid_cloud_routing_state');
  }

  // Billing
  const billing = pickEnum(raw.billingType, BILLING_TYPES, 'unknown');
  if (!billing.valid) addUniqueIssue(issues, 'invalid_billing_type');
  const defaultBillingDetail =
    billing.value === 'local'
      ? 'Runs locally using host hardware; electricity and hardware costs are not metered here.'
      : billing.value === 'subscription'
        ? 'Synthetic subscription-backed route; external plan entitlement is not verified here.'
        : billing.value === 'metered'
          ? 'Synthetic metered API route; requests may incur provider usage charges.'
          : 'Billing model is unknown. Unknown billing is never treated as zero cost.';
  const billingDetail = sanitizeDisplayText(raw.billingDetail, defaultBillingDetail, 200).value;

  // Authentication
  const rawAuth = isPlainObject(raw.authentication) ? raw.authentication : {};
  if (!isPlainObject(raw.authentication)) addUniqueIssue(issues, 'invalid_authentication_object');
  const authStatus = pickEnum(rawAuth.status, AUTH_STATUSES, 'unknown');
  if (!authStatus.valid) addUniqueIssue(issues, 'invalid_auth_status');
  const authMethod = sanitizeDisplayText(rawAuth.method, 'Unknown authentication method', 100).value;
  const authDetail = sanitizeDisplayText(
    rawAuth.detail,
    'Authentication status has not been verified.',
    200
  ).value;

  // Separate readiness facts
  const rawFacts = isPlainObject(raw.facts) ? raw.facts : {};
  if (!isPlainObject(raw.facts)) addUniqueIssue(issues, 'invalid_facts_object');
  const softwareDetected = pickEnum(rawFacts.softwareDetected, FACT_TRISTATE, 'unknown');
  if (!softwareDetected.valid) addUniqueIssue(issues, 'invalid_fact_software_detected');
  const connectionConfigured = pickEnum(rawFacts.connectionConfigured, CONFIG_STATES, 'unknown');
  if (!connectionConfigured.valid) addUniqueIssue(issues, 'invalid_fact_connection_configured');
  const authenticationVerified = deriveAuthFact(authStatus.value, rawFacts.authenticationVerified);
  if (!authenticationVerified.valid) addUniqueIssue(issues, 'invalid_fact_authentication_verified');
  const modelReachable = pickEnum(rawFacts.modelReachable, FACT_TRISTATE, 'unknown');
  if (!modelReachable.valid) addUniqueIssue(issues, 'invalid_fact_model_reachable');
  const capabilitiesVerified = pickEnum(rawFacts.capabilitiesVerified, FACT_TRISTATE, 'unknown');
  if (!capabilitiesVerified.valid) addUniqueIssue(issues, 'invalid_fact_capabilities_verified');

  // Capabilities map
  const rawCaps = isPlainObject(raw.capabilities) ? raw.capabilities : {};
  if (raw.capabilities !== undefined && !isPlainObject(raw.capabilities)) {
    addUniqueIssue(issues, 'invalid_capabilities_object');
  }
  const capabilities = {};
  for (const key of CAPABILITY_KEYS) {
    const picked = pickEnum(rawCaps[key], CAPABILITY_STATES, 'unknown');
    if (rawCaps[key] !== undefined && !picked.valid) addUniqueIssue(issues, `invalid_capability_${key}`);
    capabilities[key] = picked.value;
  }

  // Memory constraints
  const rawMem = isPlainObject(raw.memory) ? raw.memory : {};
  if (raw.memory !== undefined && !isPlainObject(raw.memory)) addUniqueIssue(issues, 'invalid_memory_object');
  const modelBytes = pickPositiveSafeInt(rawMem.modelBytes);
  if (!modelBytes.valid) addUniqueIssue(issues, 'invalid_model_bytes');
  const freeSystemBytes = pickOptionalNonNegativeSafeInt(rawMem.freeSystemBytes);
  if (!freeSystemBytes.valid) addUniqueIssue(issues, 'invalid_free_system_bytes');
  const maxModelBytes = pickPositiveSafeInt(rawMem.maxModelBytes);
  const reserveBytes = pickOptionalNonNegativeSafeInt(rawMem.reserveBytes);

  // Permissions: deduplicate exact identical entries; reject conflicts and preserve invalid entries
  const permissionMap = new Map();
  const invalidPermissions = [];
  if (Array.isArray(raw.invalidPermissions)) {
    for (const inv of raw.invalidPermissions) {
      invalidPermissions.push(sanitizeDisplayText(String(inv ?? 'invalid'), 'invalid', 120).value);
    }
    if (invalidPermissions.length > 0) addUniqueIssue(issues, 'preserved_invalid_permissions');
  }

  if (Array.isArray(raw.permissions)) {
    for (const item of raw.permissions) {
      if (!isPlainObject(item)) {
        addUniqueIssue(issues, 'invalid_permission_entry');
        invalidPermissions.push('non_object_permission_entry');
        continue;
      }
      const scopePick = pickEnum(item.scope, PERMISSION_SCOPES, null);
      if (!scopePick.valid || !scopePick.value) {
        addUniqueIssue(issues, 'invalid_permission_scope');
        invalidPermissions.push(
          sanitizeDisplayText(
            typeof item.scope === 'string' ? item.scope : 'missing_scope',
            'missing_scope',
            80
          ).value
        );
        continue;
      }
      const grantedPick = pickEnum(item.granted, FACT_TRISTATE, 'unknown');
      if (!grantedPick.valid) addUniqueIssue(issues, `invalid_permission_granted_${scopePick.value}`);

      const entry = {
        id: pickOpaqueId(item.id, `perm-${scopePick.value}`).value,
        scope: scopePick.value,
        label: sanitizeDisplayText(item.label, PERMISSION_LABELS[scopePick.value], 120).value,
        requiredForConnection: Boolean(item.requiredForConnection),
        granted: grantedPick.value,
        explanation: sanitizeDisplayText(
          item.explanation,
          'Permission status must be verified before allowing this scope.',
          200
        ).value,
        conflict: item.conflict === true,
      };

      if (entry.conflict) {
        addUniqueIssue(issues, `conflicting_permission_scope_${entry.scope}`);
      }

      if (permissionMap.has(entry.scope)) {
        const existing = permissionMap.get(entry.scope);
        if (samePermissionRecord(existing, entry)) {
          continue;
        }
        addUniqueIssue(issues, `conflicting_permission_scope_${entry.scope}`);
        invalidPermissions.push(`conflict:${entry.scope}`);
        permissionMap.set(entry.scope, {
          ...existing,
          granted: 'no',
          requiredForConnection: existing.requiredForConnection || entry.requiredForConnection,
          conflict: true,
        });
      } else {
        permissionMap.set(entry.scope, entry);
      }
    }
  } else if (raw.permissions !== undefined) {
    addUniqueIssue(issues, 'invalid_permissions_array');
  }

  // Quota
  const rawQuota = isPlainObject(raw.quota) ? raw.quota : {};
  if (raw.quota !== undefined && !isPlainObject(raw.quota)) addUniqueIssue(issues, 'invalid_quota_object');
  const quotaStatus = pickEnum(rawQuota.status, QUOTA_STATUSES, 'unknown');
  if (!quotaStatus.valid) addUniqueIssue(issues, 'invalid_quota_status');
  const defaultQuotaLabel =
    quotaStatus.value === 'not-applicable'
      ? 'Not applicable (local compute)'
      : quotaStatus.value === 'available'
        ? 'Synthetic quota available'
        : quotaStatus.value === 'low'
          ? 'Synthetic quota low'
          : quotaStatus.value === 'exhausted'
            ? 'Quota exhausted'
            : 'Quota unknown (not treated as unlimited)';
  const quotaLabel = sanitizeDisplayText(rawQuota.label, defaultQuotaLabel, 120).value;
  const quotaDetail = sanitizeDisplayText(
    rawQuota.detail,
    quotaStatus.value === 'unknown'
      ? 'Remaining allowance is unknown and is never assumed to be unlimited or zero cost.'
      : 'Quota status supplied in connection evidence.',
    200
  ).value;

  // Evidence and strict per-field provenance
  const rawEvidence = isPlainObject(raw.evidence) ? raw.evidence : {};
  if (!isPlainObject(raw.evidence)) addUniqueIssue(issues, 'invalid_evidence_object');
  const evidenceSource = pickEnum(rawEvidence.source, EVIDENCE_SOURCES, 'unknown');
  if (!evidenceSource.valid) addUniqueIssue(issues, 'invalid_evidence_source');

  let observedAt = null;
  if (rawEvidence.observedAt !== undefined && rawEvidence.observedAt !== null) {
    if (parseStrictIsoTimestamp(rawEvidence.observedAt) !== null) {
      observedAt = rawEvidence.observedAt;
    } else {
      addUniqueIssue(issues, 'invalid_observed_at');
    }
  }
  const ttlMs = pickPositiveSafeInt(rawEvidence.ttlMs);
  if (!ttlMs.valid) addUniqueIssue(issues, 'invalid_evidence_ttl');

  const hasFieldSources = rawEvidence.fieldSources !== undefined;
  const fieldSourcesValidObj = !hasFieldSources || isPlainObject(rawEvidence.fieldSources);
  if (!fieldSourcesValidObj) addUniqueIssue(issues, 'invalid_field_sources_object');
  const rawFieldSources = fieldSourcesValidObj && isPlainObject(rawEvidence.fieldSources)
    ? rawEvidence.fieldSources
    : {};

  const fieldSources = {};
  let explicitObservedCount = 0;
  for (const key of FIELD_PROVENANCE_KEYS) {
    if (!fieldSourcesValidObj) {
      fieldSources[key] = 'unknown';
      continue;
    }
    const rawVal = rawFieldSources[key];
    if (rawVal === undefined) {
      // Never upgrade omitted per-field sources to top-level 'observed'
      fieldSources[key] = evidenceSource.value === 'observed' ? 'unknown' : evidenceSource.value;
    } else {
      const picked = pickEnum(rawVal, EVIDENCE_SOURCES, 'unknown');
      if (!picked.valid) {
        addUniqueIssue(issues, `invalid_field_source_${key}`);
        fieldSources[key] = 'unknown';
      } else {
        fieldSources[key] = picked.value;
        if (picked.value === 'observed') explicitObservedCount++;
      }
    }
  }
  const explicitFieldSourcesComplete =
    evidenceSource.value === 'observed' &&
    fieldSourcesValidObj &&
    explicitObservedCount === FIELD_PROVENANCE_KEYS.length;

  const rawHostVerification = isPlainObject(rawEvidence.hostVerification)
    ? rawEvidence.hostVerification
    : {};
  if (rawEvidence.hostVerification !== undefined && !isPlainObject(rawEvidence.hostVerification)) {
    addUniqueIssue(issues, 'invalid_host_verification_object');
  }
  if (
    rawHostVerification.verifiedByHost !== undefined &&
    typeof rawHostVerification.verifiedByHost !== 'boolean'
  ) {
    addUniqueIssue(issues, 'invalid_host_verified_by_host');
  }
  const verifiedByHost = rawHostVerification.verifiedByHost === true;

  let inspectorId = null;
  if (rawHostVerification.inspectorId !== undefined && rawHostVerification.inspectorId !== null) {
    if (
      typeof rawHostVerification.inspectorId === 'string' &&
      OPAQUE_ID_PATTERN.test(rawHostVerification.inspectorId)
    ) {
      inspectorId = rawHostVerification.inspectorId;
    } else {
      addUniqueIssue(issues, 'invalid_host_inspector_id');
    }
  }

  let hostVerifiedAt = null;
  if (rawHostVerification.verifiedAt !== undefined && rawHostVerification.verifiedAt !== null) {
    if (parseStrictIsoTimestamp(rawHostVerification.verifiedAt) !== null) {
      hostVerifiedAt = rawHostVerification.verifiedAt;
    } else {
      addUniqueIssue(issues, 'invalid_host_verified_at');
    }
  }
  const hostVerification = {
    verifiedByHost,
    inspectorId,
    verifiedAt: hostVerifiedAt,
  };

  const fieldObservedAt = {};
  const rawFieldObservedAt = isPlainObject(rawEvidence.fieldObservedAt) ? rawEvidence.fieldObservedAt : {};
  if (rawEvidence.fieldObservedAt !== undefined && !isPlainObject(rawEvidence.fieldObservedAt)) {
    addUniqueIssue(issues, 'invalid_field_observed_at_object');
  }
  for (const key of FIELD_PROVENANCE_KEYS) {
    const val = rawFieldObservedAt[key];
    if (val === undefined || val === null) {
      fieldObservedAt[key] = null;
    } else if (parseStrictIsoTimestamp(val) !== null) {
      fieldObservedAt[key] = val;
    } else {
      addUniqueIssue(issues, `invalid_field_observed_at_${key}`);
      fieldObservedAt[key] = null;
    }
  }

  return deepFreeze({
    id: idCheck.value,
    label: labelCheck.value,
    malformed: issues.length > 0,
    validationIssues: issues,
    provider: {
      id: providerId.value,
      label: providerLabel.value,
      adapterKind: adapterKind.value,
      backendKind: backendKind.value,
    },
    model: {
      id: modelId.value,
      label: modelLabel.value,
      quantization,
      identity: {
        kind: idKind.value,
        value: idValue,
        verified: idVerified,
        note: idNote,
      },
    },
    executionRoute: {
      uiLocation: 'local-browser',
      clientLocation: clientLocation.value,
      executionLocation: executionLocation.value,
      dataDestination: dataDestination.value,
      endpoint,
      endpointParts,
      endpointRedactionReason,
      endpointClassification,
      transportNote,
      hostPolicyRevision,
      cloudRouting,
      loopbackDisclaimer: LOOPBACK_DISCLAIMER,
    },
    billingType: billing.value,
    billingDetail,
    authentication: {
      status: authStatus.value,
      method: authMethod,
      detail: authDetail,
    },
    facts: {
      softwareDetected: softwareDetected.value,
      connectionConfigured: connectionConfigured.value,
      authenticationVerified: authenticationVerified.value,
      modelReachable: modelReachable.value,
      capabilitiesVerified: capabilitiesVerified.value,
    },
    capabilities,
    memory: {
      modelBytes: modelBytes.value,
      freeSystemBytes: freeSystemBytes.value,
      maxModelBytes: maxModelBytes.value ?? LOCAL_PREVIEW_MAX_MODEL_BYTES,
      reserveBytes: reserveBytes.value ?? LOCAL_PREVIEW_RESERVE_BYTES,
    },
    permissions: [...permissionMap.values()],
    invalidPermissions,
    quota: {
      status: quotaStatus.value,
      label: quotaLabel,
      detail: quotaDetail,
    },
    evidence: {
      source: evidenceSource.value,
      observedAt,
      ttlMs: ttlMs.value,
      summary: sanitizeDisplayText(rawEvidence.summary, 'No evidence summary recorded.', 200).value,
      fieldSources,
      explicitFieldSourcesComplete,
      fieldObservedAt,
      hostVerification,
    },
  });
}

/**
 * Normalizes a raw task requirement specification into an authoritative, frozen Task Contract.
 * Preserves unrecognized constraints across repeated normalizations and never mutates input.
 */
export function normalizeTaskContract(raw) {
  const issues = [];
  if (!isPlainObject(raw)) {
    addUniqueIssue(issues, 'task_not_object');
    raw = {};
  }
  mergePriorIssues(issues, raw);

  const idCheck = pickOpaqueId(raw.id, 'unknown-task');
  if (!idCheck.valid) addUniqueIssue(issues, 'invalid_task_id');
  const titleCheck = sanitizeDisplayText(raw.title, 'Unnamed task', 120);
  if (!titleCheck.valid) addUniqueIssue(issues, 'invalid_task_title');
  const descCheck = sanitizeDisplayText(raw.description, 'No task description supplied.', 240);

  const requireLocalOnly = typeof raw.requireLocalOnly === 'boolean' ? raw.requireLocalOnly : true;
  if (typeof raw.requireLocalOnly !== 'boolean') addUniqueIssue(issues, 'invalid_require_local_only');

  const workMode = pickEnum(raw.workMode, WORK_MODES, 'read-only');
  if (!workMode.valid) addUniqueIssue(issues, 'invalid_work_mode');

  const requiredCapabilities = [];
  const invalidRequiredCapabilities = [];
  if (Array.isArray(raw.invalidRequiredCapabilities)) {
    for (const item of raw.invalidRequiredCapabilities) {
      const cleaned = sanitizeDisplayText(String(item ?? 'invalid'), 'invalid', 80).value;
      if (!invalidRequiredCapabilities.includes(cleaned)) invalidRequiredCapabilities.push(cleaned);
    }
    if (invalidRequiredCapabilities.length > 0) addUniqueIssue(issues, 'invalid_required_capability');
  }

  if (Array.isArray(raw.requiredCapabilities)) {
    for (const cap of raw.requiredCapabilities) {
      if (typeof cap === 'string' && CAPABILITY_KEYS.includes(cap)) {
        if (!requiredCapabilities.includes(cap)) requiredCapabilities.push(cap);
      } else {
        addUniqueIssue(issues, 'invalid_required_capability');
        const cleaned = sanitizeDisplayText(String(cap ?? 'invalid'), 'invalid', 80).value;
        if (!invalidRequiredCapabilities.includes(cleaned)) invalidRequiredCapabilities.push(cleaned);
      }
    }
  } else if (raw.requiredCapabilities !== undefined) {
    addUniqueIssue(issues, 'invalid_required_capabilities_array');
  }

  const permissionSet = new Set(WORK_MODE_PERMISSIONS[workMode.value]);
  const invalidRequiredPermissions = [];
  if (Array.isArray(raw.invalidRequiredPermissions)) {
    for (const item of raw.invalidRequiredPermissions) {
      const cleaned = sanitizeDisplayText(String(item ?? 'invalid'), 'invalid', 80).value;
      if (!invalidRequiredPermissions.includes(cleaned)) invalidRequiredPermissions.push(cleaned);
    }
    if (invalidRequiredPermissions.length > 0) addUniqueIssue(issues, 'invalid_required_permission');
  }

  if (Array.isArray(raw.requiredPermissions)) {
    for (const perm of raw.requiredPermissions) {
      if (typeof perm === 'string' && PERMISSION_SCOPES.includes(perm)) {
        permissionSet.add(perm);
      } else {
        addUniqueIssue(issues, 'invalid_required_permission');
        const cleaned = sanitizeDisplayText(String(perm ?? 'invalid'), 'invalid', 80).value;
        if (!invalidRequiredPermissions.includes(cleaned)) invalidRequiredPermissions.push(cleaned);
      }
    }
  } else if (raw.requiredPermissions !== undefined) {
    addUniqueIssue(issues, 'invalid_required_permissions_array');
  }

  const allowedBillingTypes = [];
  const invalidAllowedBillingTypes = [];
  if (Array.isArray(raw.invalidAllowedBillingTypes)) {
    for (const item of raw.invalidAllowedBillingTypes) {
      const cleaned = sanitizeDisplayText(String(item ?? 'invalid'), 'invalid', 80).value;
      if (!invalidAllowedBillingTypes.includes(cleaned)) invalidAllowedBillingTypes.push(cleaned);
    }
    if (invalidAllowedBillingTypes.length > 0) addUniqueIssue(issues, 'invalid_allowed_billing_type');
  }

  if (Array.isArray(raw.allowedBillingTypes)) {
    for (const b of raw.allowedBillingTypes) {
      if (typeof b === 'string' && ['local', 'subscription', 'metered'].includes(b)) {
        if (!allowedBillingTypes.includes(b)) allowedBillingTypes.push(b);
      } else {
        addUniqueIssue(issues, 'invalid_allowed_billing_type');
        const cleaned = sanitizeDisplayText(String(b ?? 'invalid'), 'invalid', 80).value;
        if (!invalidAllowedBillingTypes.includes(cleaned)) invalidAllowedBillingTypes.push(cleaned);
      }
    }
  } else {
    addUniqueIssue(issues, 'invalid_allowed_billing_types_array');
  }

  const requireVerifiedQuota =
    typeof raw.requireVerifiedQuota === 'boolean' ? raw.requireVerifiedQuota : true;
  if (raw.requireVerifiedQuota !== undefined && typeof raw.requireVerifiedQuota !== 'boolean') {
    addUniqueIssue(issues, 'invalid_require_verified_quota');
  }

  return deepFreeze({
    id: idCheck.value,
    title: titleCheck.value,
    description: descCheck.value,
    malformed: issues.length > 0,
    validationIssues: issues,
    requireLocalOnly,
    workMode: workMode.value,
    requiredCapabilities,
    invalidRequiredCapabilities,
    requiredPermissions: [...permissionSet],
    invalidRequiredPermissions,
    allowedBillingTypes,
    invalidAllowedBillingTypes,
    requireVerifiedQuota,
  });
}

/**
 * Produces a canonical signature of a Task Contract's compatibility-affecting fields.
 */
export function taskRequirementSignature(rawTask) {
  const task = normalizeTaskContract(rawTask);
  return JSON.stringify({
    id: task.id,
    malformed: task.malformed,
    requireLocalOnly: task.requireLocalOnly,
    workMode: task.workMode,
    requiredCapabilities: [...task.requiredCapabilities].sort(),
    invalidRequiredCapabilities: [...task.invalidRequiredCapabilities].sort(),
    requiredPermissions: [...task.requiredPermissions].sort(),
    invalidRequiredPermissions: [...task.invalidRequiredPermissions].sort(),
    allowedBillingTypes: [...task.allowedBillingTypes].sort(),
    invalidAllowedBillingTypes: [...task.invalidAllowedBillingTypes].sort(),
    requireVerifiedQuota: task.requireVerifiedQuota,
  });
}

/**
 * Produces a canonical snapshot signature of the reviewed route's material attributes.
 * Note: This deterministic structural revision detects drift; it is not cryptographic authentication.
 */
export function routeRevisionSignature(rawConnection) {
  const conn = normalizeConnectionContract(rawConnection);
  return JSON.stringify({
    connectionId: conn.id,
    providerId: conn.provider.id,
    adapterKind: conn.provider.adapterKind,
    backendKind: conn.provider.backendKind,
    modelId: conn.model.id,
    quantization: conn.model.quantization,
    modelIdentity: {
      kind: conn.model.identity.kind,
      value: conn.model.identity.value,
      verified: conn.model.identity.verified,
    },
    topology: {
      clientLocation: conn.executionRoute.clientLocation,
      executionLocation: conn.executionRoute.executionLocation,
      dataDestination: conn.executionRoute.dataDestination,
      endpoint: conn.executionRoute.endpoint,
      cloudRouting: conn.executionRoute.cloudRouting,
      hostPolicyRevision: conn.executionRoute.hostPolicyRevision,
    },
    billingType: conn.billingType,
    quotaStatus: conn.quota.status,
    permissions: conn.permissions
      .map((p) => ({
        scope: p.scope,
        requiredForConnection: p.requiredForConnection,
        granted: p.granted,
        conflict: p.conflict,
      }))
      .sort((a, b) => a.scope.localeCompare(b.scope)),
  });
}

/**
 * Creates a fully bound route selection record tying connection, model identity,
 * topology, billing, permissions, host policy revision, and task snapshot together.
 */
export function createRouteSelection(
  rawConnection,
  rawTask,
  { confirmed = false, confirmedAt = null } = {}
) {
  const conn = normalizeConnectionContract(rawConnection);
  return {
    connectionId: conn.id,
    modelId: conn.model.id,
    taskSnapshotSignature: taskRequirementSignature(rawTask),
    routeSnapshotSignature: routeRevisionSignature(conn),
    boundRoute: {
      connectionId: conn.id,
      modelId: conn.model.id,
      modelIdentityKind: conn.model.identity.kind,
      modelIdentityValue: conn.model.identity.value,
      modelIdentityVerified: conn.model.identity.verified,
      adapterKind: conn.provider.adapterKind,
      backendKind: conn.provider.backendKind,
      clientLocation: conn.executionRoute.clientLocation,
      executionLocation: conn.executionRoute.executionLocation,
      dataDestination: conn.executionRoute.dataDestination,
      endpoint: conn.executionRoute.endpoint,
      cloudRouting: conn.executionRoute.cloudRouting,
      billingType: conn.billingType,
      requiredPermissionScopes: conn.permissions
        .filter((p) => p.requiredForConnection)
        .map((p) => p.scope)
        .sort(),
      grantedPermissionScopes: conn.permissions
        .filter((p) => p.granted === 'yes')
        .map((p) => p.scope)
        .sort(),
      hostPolicyRevision: conn.executionRoute.hostPolicyRevision,
    },
    confirmed: Boolean(confirmed),
    confirmedAt,
    invalidated: false,
  };
}

/**
 * Explicitly reconfirms a route selection against the current connection and task snapshot.
 */
export function reconfirmRouteSelection(rawConnection, rawTask, { confirmedAt = null } = {}) {
  return createRouteSelection(rawConnection, rawTask, { confirmed: true, confirmedAt });
}
