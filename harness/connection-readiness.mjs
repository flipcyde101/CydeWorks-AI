import {
  CAPABILITY_LABELS,
  FIELD_PROVENANCE_KEYS,
  PERMISSION_LABELS,
  normalizeConnectionContract,
  normalizeTaskContract,
  parseStrictIsoTimestamp,
  routeRevisionSignature,
  taskRequirementSignature,
} from './connection-contract.mjs';

function parseClockMs(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
  }
  if (typeof value === 'string') {
    return parseStrictIsoTimestamp(value);
  }
  return null;
}

function safeClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(safeClone);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const copy = {};
  for (const key of Object.keys(value)) {
    copy[key] = safeClone(value[key]);
  }
  return copy;
}

function deepFreeze(target) {
  if (target === null || typeof target !== 'object') return target;
  Object.freeze(target);
  for (const key of Object.keys(target)) {
    deepFreeze(target[key]);
  }
  return target;
}

/**
 * Evaluates evidence freshness against an explicitly injected clock timestamp.
 * Uses strict `< ttlMs` so `nowMs === observedAtMs + ttlMs` is stale.
 */
export function evaluateEvidenceFreshness(evidence, nowInput) {
  const nowMs = parseClockMs(nowInput);
  if (nowMs === null) {
    return deepFreeze({
      status: 'clock-unavailable',
      isFresh: false,
      observedAt: evidence?.observedAt ?? null,
      observedAtMs: null,
      nowMs: null,
      ttlMs: evidence?.ttlMs ?? null,
      ageMs: null,
      remainingMs: null,
      expiresAtMs: null,
      explanation: 'No valid evaluation clock was supplied; evidence freshness cannot be verified.',
    });
  }

  const observedAt = typeof evidence?.observedAt === 'string' ? evidence.observedAt : null;
  const observedAtMs = observedAt ? parseClockMs(observedAt) : null;
  const ttlMs = Number.isSafeInteger(evidence?.ttlMs) && evidence.ttlMs > 0 ? evidence.ttlMs : null;

  if (observedAtMs === null || ttlMs === null) {
    return deepFreeze({
      status: 'missing',
      isFresh: false,
      observedAt,
      observedAtMs,
      nowMs,
      ttlMs,
      ageMs: null,
      remainingMs: null,
      expiresAtMs: null,
      explanation: 'Evidence observation timestamp or TTL is missing; readiness cannot be treated as fresh.',
    });
  }

  const ageMs = nowMs - observedAtMs;
  const expiresAtMs = observedAtMs + ttlMs;

  if (ageMs < 0) {
    return deepFreeze({
      status: 'future-skew',
      isFresh: false,
      observedAt,
      observedAtMs,
      nowMs,
      ttlMs,
      ageMs,
      remainingMs: null,
      expiresAtMs,
      explanation: 'Evidence observation timestamp is ahead of the evaluation clock.',
    });
  }

  if (ageMs < ttlMs) {
    return deepFreeze({
      status: 'fresh',
      isFresh: true,
      observedAt,
      observedAtMs,
      nowMs,
      ttlMs,
      ageMs,
      remainingMs: expiresAtMs - nowMs,
      expiresAtMs,
      explanation: 'Evidence is within its validity window at the evaluation timestamp.',
    });
  }

  return deepFreeze({
    status: 'stale',
    isFresh: false,
    observedAt,
    observedAtMs,
    nowMs,
    ttlMs,
    ageMs,
    remainingMs: 0,
    expiresAtMs,
    explanation: 'Evidence TTL has expired at or before the evaluation timestamp.',
  });
}

function addReason(reasons, code, severity, title, explanation, suggestedAction) {
  reasons.push({ code, severity, title, explanation, suggestedAction });
}

function deriveRoutePermissionScopes(connection) {
  const scopes = new Set(['read-only-source']);
  const { executionLocation, dataDestination, clientLocation, endpointClassification } =
    connection.executionRoute;

  if (
    dataDestination === 'remote-endpoint' ||
    executionLocation === 'remote-provider' ||
    endpointClassification.kind === 'remote' ||
    connection.provider.backendKind === 'remote-provider'
  ) {
    scopes.add('remote-data-egress');
  }
  if (dataDestination === 'local-loopback') {
    scopes.add('loopback-http');
  }
  if (clientLocation === 'local-cli-adapter') {
    scopes.add('local-process-spawn');
  }
  return scopes;
}

function evaluatePermissions(connection, task, reasons) {
  const byScope = new Map(connection.permissions.map((perm) => [perm.scope, perm]));
  const derivedRouteScopes = deriveRoutePermissionScopes(connection);
  const requiredScopes = new Set([...task.requiredPermissions, ...derivedRouteScopes]);
  for (const perm of connection.permissions) {
    if (perm.requiredForConnection) requiredScopes.add(perm.scope);
  }

  const hasConflicts =
    connection.invalidPermissions.length > 0 ||
    connection.permissions.some((perm) => perm.conflict === true);
  if (hasConflicts) {
    addReason(
      reasons,
      'PERMISSION_CONFLICT',
      'blocker',
      'Invalid or conflicting permission records',
      'Connection permission records contain conflicting or unrecognized scope declarations.',
      'Reconcile duplicate permission entries so each scope has one consistent record.'
    );
  }

  // Enforce task operational scope against combined task, connection, and route-derived scopes
  const outOfScope = [];
  for (const scope of requiredScopes) {
    const label = byScope.get(scope)?.label ?? PERMISSION_LABELS[scope] ?? scope;
    if (scope === 'repository-write' && task.workMode === 'read-only') {
      outOfScope.push(`${label} (read-only task rejects repository writes)`);
    } else if (scope === 'shell-execution' && task.workMode !== 'shell-execution') {
      outOfScope.push(`${label} (task work mode "${task.workMode}" disallows shell execution)`);
    } else if (scope === 'remote-data-egress' && task.requireLocalOnly === true) {
      outOfScope.push(`${label} (local-only task rejects remote egress)`);
    }
  }
  if (outOfScope.length > 0) {
    addReason(
      reasons,
      'PERMISSION_EXCEEDS_TASK_SCOPE',
      'blocker',
      'Combined task and route requirements exceed task operational scope',
      `Required permissions violate task policy: ${outOfScope.join('; ')}.`,
      'Use a read-only/local route without contradictory permission requirements, or update task scope outside this advisory center.'
    );
  }

  const items = [];
  const missingOrDenied = [];
  const unknown = [];
  let missingMandatoryEgress = false;

  for (const scope of requiredScopes) {
    const entry = byScope.get(scope);
    const label = entry?.label ?? PERMISSION_LABELS[scope] ?? scope;
    const granted = entry ? entry.granted : 'unknown';
    const explanation =
      entry?.explanation ?? 'No permission grant record was supplied for this required scope.';
    items.push({
      scope,
      label,
      granted,
      requiredByTask: task.requiredPermissions.includes(scope),
      requiredByConnection: Boolean(entry?.requiredForConnection) || derivedRouteScopes.has(scope),
      conflict: Boolean(entry?.conflict),
      explanation,
    });
    if (granted === 'no') {
      missingOrDenied.push({ scope, label });
    } else if (granted === 'unknown') {
      unknown.push({ scope, label });
      if (scope === 'remote-data-egress' && derivedRouteScopes.has('remote-data-egress')) {
        missingMandatoryEgress = true;
        missingOrDenied.push({ scope, label });
      }
    }
  }

  if (missingOrDenied.length > 0) {
    addReason(
      reasons,
      'PERMISSION_UNGRANTED',
      'blocker',
      missingMandatoryEgress
        ? 'Remote destination requires explicit remote-data-egress permission'
        : 'Required permissions are not granted',
      `Ungranted permissions: ${missingOrDenied.map((p) => p.label).join('; ')}.`,
      'Grant the required permission through an explicit host approval gate, or choose a task requiring fewer privileges.'
    );
  }
  if (unknown.length > 0) {
    addReason(
      reasons,
      'PERMISSION_STATUS_UNKNOWN',
      'unknown',
      'Required permission status is unknown',
      `Unverified permission scopes: ${unknown.map((p) => p.label).join('; ')}.`,
      'Confirm permission grant records before running this task.'
    );
  }

  return items;
}

function evaluateCapabilities(connection, task) {
  const items = [];
  const missing = [];
  const unverified = [];

  for (const cap of task.requiredCapabilities) {
    const status = connection.capabilities[cap] ?? 'unknown';
    const label = CAPABILITY_LABELS[cap] ?? cap;
    items.push({ key: cap, label, status });
    if (status === 'unsupported') missing.push(label);
    else if (status === 'unknown') unverified.push(label);
  }

  for (const badCap of task.invalidRequiredCapabilities) {
    items.push({ key: badCap, label: `Unrecognized capability: ${badCap}`, status: 'unsupported' });
    missing.push(badCap);
  }

  let requiredCapabilitiesVerified = 'yes';
  if (
    missing.length > 0 ||
    task.invalidRequiredCapabilities.length > 0 ||
    connection.facts.capabilitiesVerified === 'no'
  ) {
    requiredCapabilitiesVerified = 'no';
  } else if (unverified.length > 0 || connection.facts.capabilitiesVerified === 'unknown') {
    requiredCapabilitiesVerified = 'unknown';
  }

  return { items, missing, unverified, requiredCapabilitiesVerified };
}

function evaluateProvenance(connection, task, now, reasons) {
  const weakFields = [];
  for (const key of FIELD_PROVENANCE_KEYS) {
    if (key === 'quota' && !task.requireVerifiedQuota && connection.billingType !== 'local') {
      continue;
    }
    const src = connection.evidence.fieldSources[key];
    if (src === 'configured' || src === 'unknown') {
      weakFields.push(`${key}=${src}`);
    }
  }

  if (
    connection.evidence.source === 'configured' ||
    connection.evidence.source === 'unknown' ||
    weakFields.length > 0
  ) {
    const detail = weakFields.length > 0
      ? `Weak or unverified field-level evidence sources: ${weakFields.join(', ')}.`
      : `Top-level readiness evidence source is "${connection.evidence.source}".`;
    addReason(
      reasons,
      'PROVENANCE_UNVERIFIED',
      'unknown',
      'Evidence source is not observed',
      `${detail} Top-level labels cannot upgrade unverified or configured fields.`,
      'Run an authorized host readiness probe to collect fresh observed evidence for every required field.'
    );
  }

  const staleFieldKeys = new Set();
  const stalePerField = [];
  for (const key of FIELD_PROVENANCE_KEYS) {
    const fieldTs = connection.evidence.fieldObservedAt[key];
    if (!fieldTs) continue;
    const fieldFresh = evaluateEvidenceFreshness(
      { observedAt: fieldTs, ttlMs: connection.evidence.ttlMs },
      now
    );
    if (!fieldFresh.isFresh) {
      staleFieldKeys.add(key);
      stalePerField.push(`${key}:${fieldFresh.status}`);
    }
  }
  if (stalePerField.length > 0) {
    addReason(
      reasons,
      'EVIDENCE_STALE',
      'unknown',
      'Per-field evidence has expired or is invalid',
      `Field observation timestamps failed freshness check: ${stalePerField.join(', ')}.`,
      'Re-verify affected fields via host inspection.'
    );
  }
  return staleFieldKeys;
}

function safeEndpointSummary(connection) {
  if (connection.executionRoute.endpoint) return connection.executionRoute.endpoint;
  if (connection.executionRoute.endpointRedactionReason) return 'redacted unsafe endpoint';
  return 'missing endpoint';
}

function evaluateBackendAndTopology(connection, task, reasons) {
  const { adapterKind, backendKind } = connection.provider;
  const { executionLocation, dataDestination, endpointClassification, cloudRouting } =
    connection.executionRoute;
  const displayEndpoint = safeEndpointSummary(connection);

  if (backendKind === 'unknown' || adapterKind === 'unknown') {
    addReason(
      reasons,
      'BACKEND_UNKNOWN',
      task.requireLocalOnly ? 'blocker' : 'unknown',
      'Inference backend cannot be established',
      `Connection adapter "${adapterKind}" reported backendKind "${backendKind}". Adapter names alone do not establish the inference backend.`,
      'Explicitly identify the verified inference backend before routing a run.'
    );
  }

  const isLocalOrUnknownBackend =
    executionLocation === 'local-machine' ||
    dataDestination === 'local-loopback' ||
    backendKind === 'ollama' ||
    adapterKind === 'ollama' ||
    backendKind === 'unknown';

  if (cloudRouting === 'enabled' && (isLocalOrUnknownBackend || task.requireLocalOnly)) {
    addReason(
      reasons,
      'CLOUD_ROUTING_ENABLED',
      'blocker',
      'Cloud routing is enabled on a restricted or local backend',
      'Cloud routing is enabled on the inference backend or local route. Policy holds this route regardless of wrapper.',
      'Disable cloud routing on the local service and re-verify.'
    );
  }

  // Ollama-backed routes must explicitly verify cloudRouting === 'disabled'
  if (backendKind === 'ollama' || adapterKind === 'ollama') {
    if (cloudRouting === 'not-applicable') {
      addReason(
        reasons,
        'CLOUD_ROUTING_INVALID_FOR_OLLAMA',
        'blocker',
        'Ollama-backed route cannot declare cloud routing not-applicable',
        'Ollama-backed routes require verified /api/status cloud-disabled evidence regardless of adapter wrapper.',
        'Verify cloud.disabled === true on the Ollama service before enabling this route.'
      );
    } else if (cloudRouting === 'unknown') {
      addReason(
        reasons,
        'CLOUD_ROUTING_UNKNOWN',
        'unknown',
        'Ollama cloud routing status is unavailable',
        'Could not verify whether Ollama cloud features are disabled on the backend. The route is held.',
        'Inspect /api/status on the Ollama backend and refresh readiness evidence.'
      );
    }
  } else if (backendKind === 'unknown' && cloudRouting !== 'disabled' && cloudRouting !== 'enabled') {
    addReason(
      reasons,
      'CLOUD_ROUTING_UNKNOWN',
      'unknown',
      'Cloud routing status is unverified for unknown backend',
      'Could not establish whether cloud forwarding is disabled on an unverified backend.',
      'Establish the backend type and cloud routing state before routing.'
    );
  }

  if (backendKind === 'llamacpp' && adapterKind === 'ollama') {
    addReason(
      reasons,
      'BACKEND_REQUIRES_OPENCODE',
      'blocker',
      'llama.cpp backend requires OpenCode route adapter',
      'Direct Ollama adapter cannot drive a llama.cpp backend.',
      'Select an OpenCode-wrapped llama.cpp route.'
    );
  }

  // Validate structured endpoint against declared destination and execution location
  if (dataDestination === 'unknown' || executionLocation === 'unknown') {
    if (task.requireLocalOnly) {
      addReason(
        reasons,
        'LOCAL_ONLY_DESTINATION_UNVERIFIED',
        'blocker',
        'Destination cannot be verified for local-only task',
        'Task requires local-only handling, but this connection has an unknown execution location or data destination.',
        'Switch to a verified local-loopback connection or relax the task locality requirement only if permitted.'
      );
    } else {
      addReason(
        reasons,
        'DESTINATION_UNKNOWN',
        'unknown',
        'Data destination is unknown',
        'Where task data will be sent could not be determined from supplied evidence.',
        'Verify the endpoint destination before dispatching data.'
      );
    }
  } else if (dataDestination === 'local-loopback' || executionLocation === 'local-machine') {
    const contradictory =
      dataDestination !== 'local-loopback' ||
      executionLocation !== 'local-machine' ||
      endpointClassification.kind !== 'loopback';
    if (contradictory) {
      addReason(
        reasons,
        'TOPOLOGY_CONTRADICTION',
        'blocker',
        'Contradictory local route endpoint or topology',
        `Route declared ${dataDestination} / ${executionLocation}, but structured endpoint (${displayEndpoint}) classified as "${endpointClassification.kind}".`,
        'Ensure local routes use a valid http://127.0.0.1:<port> loopback URL with local-machine execution.'
      );
    }
  } else if (dataDestination === 'remote-endpoint' || executionLocation === 'remote-provider') {
    const contradictory =
      dataDestination !== 'remote-endpoint' ||
      executionLocation !== 'remote-provider' ||
      endpointClassification.kind !== 'remote';
    if (contradictory) {
      addReason(
        reasons,
        'TOPOLOGY_CONTRADICTION',
        'blocker',
        'Contradictory remote route endpoint or topology',
        `Route declared ${dataDestination} / ${executionLocation}, but structured endpoint (${displayEndpoint}) classified as "${endpointClassification.kind}".`,
        'Supply a valid remote https:// endpoint URL matching remote-provider execution.'
      );
    }
    if (task.requireLocalOnly) {
      addReason(
        reasons,
        'LOCAL_ONLY_REJECTS_REMOTE_DESTINATION',
        'blocker',
        'Remote destination rejected by local-only task',
        `Client runs on ${connection.executionRoute.clientLocation}, but task data leaves to ${dataDestination} (${displayEndpoint}) on ${executionLocation}.`,
        'Select a local-machine connection or change the task locality policy if remote egress is intended.'
      );
    }
  }

  // Local memory bounds
  if (executionLocation === 'local-machine' && adapterKind !== 'synthetic-external') {
    const { modelBytes, freeSystemBytes, maxModelBytes, reserveBytes } = connection.memory;
    if (modelBytes === null || freeSystemBytes === null) {
      addReason(
        reasons,
        'MEMORY_STATUS_UNKNOWN',
        'unknown',
        'Local memory or model size is unknown',
        'Model byte size or free system memory was not reported, so memory headroom cannot be verified.',
        'Inspect model metadata and free system memory before routing a local run.'
      );
    } else if (modelBytes > maxModelBytes) {
      addReason(
        reasons,
        'MEMORY_LIMIT_EXCEEDED',
        'blocker',
        'Model exceeds local preview size limit',
        `Model size (${modelBytes} bytes) exceeds the ${maxModelBytes} byte preview cap.`,
        'Choose a smaller quantization or another approved local model within the 4 GB cap.'
      );
    } else if (freeSystemBytes < modelBytes + reserveBytes) {
      addReason(
        reasons,
        'MEMORY_THRESHOLD_UNMET',
        'blocker',
        'Insufficient free system memory',
        `Available system memory (${freeSystemBytes} bytes) is below model size plus ${reserveBytes} bytes reserve.`,
        'Free system memory or select a smaller local model.'
      );
    }
  }
}

function evaluateBillingPolicy(connection, task, reasons) {
  const { executionLocation, dataDestination, endpointClassification, cloudRouting } =
    connection.executionRoute;
  const localTopologyValid =
    executionLocation === 'local-machine' &&
    dataDestination === 'local-loopback' &&
    endpointClassification.kind === 'loopback' &&
    connection.provider.backendKind !== 'remote-provider' &&
    cloudRouting !== 'enabled';

  if (connection.billingType === 'local' && !localTopologyValid) {
    addReason(
      reasons,
      'BILLING_TOPOLOGY_CONTRADICTION',
      'blocker',
      'Local billing contradicts remote or unverified execution topology',
      `Connection declares billingType "local", but route uses ${executionLocation} / ${dataDestination} (${endpointClassification.kind}).`,
      'Classify remote routes with subscription, metered, or unknown billing rather than local billing.'
    );
  }

  if (connection.billingType === 'unknown') {
    addReason(
      reasons,
      'BILLING_TYPE_UNKNOWN',
      'unknown',
      'Billing type is unknown',
      'Billing model is unknown and is never treated as zero cost or local.',
      'Confirm whether this connection is local, subscription-backed, or metered.'
    );
  } else if (!task.allowedBillingTypes.includes(connection.billingType)) {
    addReason(
      reasons,
      'BILLING_TYPE_DISALLOWED',
      'blocker',
      `Billing type "${connection.billingType}" is not allowed for this task`,
      `Task allows [${task.allowedBillingTypes.join(', ') || 'none'}], but this connection uses "${connection.billingType}".`,
      'Select an allowed billing route or explicitly update task billing permissions.'
    );
  }
}

function evaluateHostAttestation(connection, now) {
  const hv = connection.evidence.hostVerification;
  const attestationFreshness = evaluateEvidenceFreshness(
    { observedAt: hv?.verifiedAt ?? null, ttlMs: connection.evidence.ttlMs },
    now
  );
  const gaps = [];

  if (hv?.verifiedByHost !== true) {
    gaps.push('Host must supply evidence.hostVerification.verifiedByHost === true from an authorized inspector.');
  }
  if (typeof hv?.inspectorId !== 'string' || hv.inspectorId.length === 0) {
    gaps.push('Host attestation is missing or has an invalid inspectorId.');
  }
  if (typeof hv?.verifiedAt !== 'string' || hv.verifiedAt.length === 0) {
    gaps.push('Host attestation is missing or has an invalid verifiedAt timestamp.');
  } else if (attestationFreshness.status === 'future-skew') {
    gaps.push('Host attestation verifiedAt timestamp is in the future relative to the evaluation clock.');
  } else if (attestationFreshness.status === 'stale') {
    gaps.push('Host attestation verifiedAt timestamp has expired against the evidence TTL.');
  } else if (!attestationFreshness.isFresh) {
    gaps.push('Host attestation freshness could not be verified against the evaluation clock and evidence TTL.');
  }

  return { attestationFreshness, gaps };
}

function evaluateQuotaRules(connection, task, reasons) {
  const isPaidOrRemote =
    connection.billingType === 'subscription' ||
    connection.billingType === 'metered' ||
    connection.executionRoute.executionLocation === 'remote-provider';

  if (isPaidOrRemote && connection.quota.status === 'not-applicable') {
    addReason(
      reasons,
      'QUOTA_APPLICABILITY_CONTRADICTION',
      'blocker',
      'Quota cannot be not-applicable for subscription, metered, or remote routes',
      `Connection declares billing "${connection.billingType}" at "${connection.executionRoute.executionLocation}" with contradictory quota status "not-applicable".`,
      'Supply an observed quota status (available, low, exhausted, or unknown) for non-local routes.'
    );
    return;
  }

  if (connection.quota.status === 'exhausted') {
    addReason(
      reasons,
      'QUOTA_EXHAUSTED',
      'blocker',
      'Connection quota is exhausted',
      connection.quota.detail,
      'Wait for quota reset, update provider allowance externally, or select another approved route.'
    );
  } else if (connection.quota.status === 'unknown') {
    if (!task.requireVerifiedQuota && isPaidOrRemote) {
      addReason(
        reasons,
        'QUOTA_NOT_VERIFIED_INFO',
        'info',
        'Quota is unknown (permitted by task requireVerifiedQuota=false)',
        'Remaining usage quota is unknown and is never assumed unlimited; task explicitly waived verified quota requirement.',
        'Check provider allowance externally before dispatching large workloads.'
      );
    } else {
      addReason(
        reasons,
        'QUOTA_UNKNOWN',
        'unknown',
        'Quota status is unknown',
        'Remaining usage quota is unknown and is never assumed to be unlimited or zero cost.',
        'Check provider allowance state externally or choose a local connection with known capacity.'
      );
    }
  } else if (connection.quota.status === 'low') {
    addReason(
      reasons,
      'QUOTA_LOW',
      'info',
      'Quota is running low',
      connection.quota.detail,
      'Review remaining allowance before dispatching large tasks.'
    );
  }
}

/**
 * Deterministic readiness evaluator for one Connection Contract + Task Contract + injected clock.
 * Performs zero I/O and never mutates inputs.
 */
export function evaluateConnectionReadiness(rawConnection, rawTask, { now } = {}) {
  const connection = normalizeConnectionContract(rawConnection);
  const task = normalizeTaskContract(rawTask);
  const reasons = [];

  if (connection.malformed || task.malformed) {
    const allIssues = [...connection.validationIssues, ...task.validationIssues];
    addReason(
      reasons,
      'CONTRACT_MALFORMED',
      'blocker',
      'Malformed connection or task contract data',
      `Contract normalization flagged invalid fields: ${allIssues.join(', ')}.`,
      'Repair the supplied connection or task metadata before selecting this route.'
    );
  }

  const freshness = evaluateEvidenceFreshness(connection.evidence, now);
  if (freshness.status === 'missing') {
    addReason(
      reasons,
      'EVIDENCE_MISSING',
      'unknown',
      'Readiness evidence timestamp is missing',
      freshness.explanation,
      'Refresh readiness evidence from the host inspection service.'
    );
  } else if (freshness.status === 'clock-unavailable') {
    addReason(
      reasons,
      'EVIDENCE_CLOCK_UNAVAILABLE',
      'unknown',
      'Evaluation clock unavailable',
      freshness.explanation,
      'Supply an explicit evaluation clock timestamp.'
    );
  } else if (freshness.status === 'future-skew') {
    addReason(
      reasons,
      'EVIDENCE_CLOCK_SKEW',
      'unknown',
      'Evidence timestamp is in the future',
      freshness.explanation,
      'Verify system clock alignment and re-collect readiness evidence.'
    );
  } else if (freshness.status === 'stale') {
    addReason(
      reasons,
      'EVIDENCE_STALE',
      'unknown',
      'Readiness evidence has expired',
      'Observation age met or exceeded the evidence TTL. Expired evidence cannot remain ready.',
      'Re-check service reachability, authentication, and destination status to obtain fresh evidence.'
    );
  }

  const staleFieldKeys = evaluateProvenance(connection, task, now, reasons);

  // Separate readiness facts: 1. softwareDetected
  if (connection.facts.softwareDetected === 'no') {
    addReason(
      reasons,
      'SOFTWARE_NOT_DETECTED',
      'blocker',
      'Required local software or adapter was not detected',
      `The runtime or CLI adapter for ${connection.provider.label} was not found.`,
      'Verify the local binary or runtime installation path outside this UI and re-check.'
    );
  } else if (connection.facts.softwareDetected === 'unknown') {
    addReason(
      reasons,
      'SOFTWARE_DETECTION_UNKNOWN',
      'unknown',
      'Software detection status is unknown',
      `Could not verify whether ${connection.provider.label} software is installed.`,
      'Inspect executable availability and refresh readiness.'
    );
  }

  // 2. connectionConfigured
  if (connection.facts.connectionConfigured === 'no') {
    addReason(
      reasons,
      'CONNECTION_NOT_CONFIGURED',
      'blocker',
      'Connection is not configured',
      'No active route endpoint or profile is configured for this connection.',
      'Supply a valid connection configuration in host settings.'
    );
  } else if (connection.facts.connectionConfigured === 'invalid') {
    addReason(
      reasons,
      'CONNECTION_CONFIG_INVALID',
      'blocker',
      'Connection configuration is invalid',
      'Configured endpoint, port, or executable path failed validation.',
      'Correct the invalid configuration path or loopback port and refresh.'
    );
  } else if (connection.facts.connectionConfigured === 'unknown') {
    addReason(
      reasons,
      'CONNECTION_CONFIG_UNKNOWN',
      'unknown',
      'Connection configuration status is unknown',
      'Configuration state could not be confirmed.',
      'Inspect host route configuration and refresh.'
    );
  }

  // 3. authenticationVerified
  if (connection.facts.authenticationVerified === 'expired' || connection.authentication.status === 'expired') {
    addReason(
      reasons,
      'AUTH_EXPIRED',
      'blocker',
      'Authentication session has expired',
      connection.authentication.detail,
      'Re-authenticate through an authorized sign-in flow outside this preview and refresh.'
    );
  } else if (
    connection.facts.authenticationVerified === 'no' ||
    connection.authentication.status === 'missing' ||
    connection.authentication.status === 'invalid'
  ) {
    const isInvalid = connection.authentication.status === 'invalid';
    addReason(
      reasons,
      isInvalid ? 'AUTH_INVALID' : 'AUTH_MISSING',
      'blocker',
      isInvalid ? 'Authentication credential was rejected' : 'Authentication is missing',
      connection.authentication.detail,
      'Provide valid credentials via the host credential store and re-verify.'
    );
  } else if (
    connection.facts.authenticationVerified === 'unknown' ||
    connection.authentication.status === 'unknown'
  ) {
    addReason(
      reasons,
      'AUTH_UNKNOWN',
      'unknown',
      'Authentication status is unknown',
      'Authentication could not be verified for this connection.',
      'Confirm credential or session state before using this route.'
    );
  }

  // 4. modelReachable
  if (connection.facts.modelReachable === 'no') {
    addReason(
      reasons,
      'MODEL_UNREACHABLE',
      'blocker',
      'Model service is unreachable',
      `Could not reach model "${connection.model.label}" at ${safeEndpointSummary(connection)}.`,
      'Confirm the target service is running, verify the configured endpoint, and refresh readiness.'
    );
  } else if (connection.facts.modelReachable === 'unknown') {
    addReason(
      reasons,
      'MODEL_REACHABILITY_UNKNOWN',
      'unknown',
      'Model reachability has not been verified',
      `Reachability for "${connection.model.label}" is unknown.`,
      'Run a connectivity check against the target model inventory.'
    );
  }

  if (connection.model.identity.kind === 'unknown' || !connection.model.identity.value) {
    addReason(
      reasons,
      'MODEL_IDENTITY_UNKNOWN',
      'unknown',
      'Model identity evidence is missing or unknown',
      'Model identity kind or identifier value is unavailable; readiness cannot remain green.',
      'Obtain a model digest, server-metadata fingerprint, or provider model identifier from the host.'
    );
  }

  evaluateBackendAndTopology(connection, task, reasons);
  evaluateBillingPolicy(connection, task, reasons);
  evaluateQuotaRules(connection, task, reasons);

  // 5. requiredCapabilitiesVerified
  const capEval = evaluateCapabilities(connection, task);
  if (capEval.missing.length > 0) {
    addReason(
      reasons,
      'CAPABILITY_MISSING',
      'blocker',
      'Required model capabilities are unsupported',
      `Connection lacks required capability support: ${capEval.missing.join(', ')}.`,
      'Choose a connection whose model supports all task capabilities.'
    );
  } else if (capEval.requiredCapabilitiesVerified === 'no') {
    addReason(
      reasons,
      'CAPABILITY_MISSING',
      'blocker',
      'Required capabilities failed verification',
      'Connection capability verification reported failure.',
      'Select a connection with verified capability support.'
    );
  } else if (capEval.requiredCapabilitiesVerified === 'unknown') {
    const detail = capEval.unverified.length
      ? `Capabilities have unknown support status: ${capEval.unverified.join(', ')}.`
      : 'Capability verification has not been completed for this connection.';
    addReason(
      reasons,
      'CAPABILITY_UNVERIFIED',
      'unknown',
      'Required capabilities are unverified',
      detail,
      'Verify model capability metadata before relying on this route.'
    );
  }

  const permissionItems = evaluatePermissions(connection, task, reasons);

  const hasBlocker = reasons.some((r) => r.severity === 'blocker');
  const hasUnknown = reasons.some((r) => r.severity === 'unknown');
  const state = hasBlocker ? 'blocked' : hasUnknown ? 'unknown' : 'ready';

  const fs = connection.evidence.fieldSources;
  const weakOrStale = (key) => fs[key] === 'configured' || fs[key] === 'unknown' || staleFieldKeys.has(key);
  const distinctFacts = {
    softwareDetected:
      weakOrStale('software') && connection.facts.softwareDetected === 'yes'
        ? 'unknown'
        : connection.facts.softwareDetected,
    connectionConfigured:
      weakOrStale('configuration') && connection.facts.connectionConfigured === 'yes'
        ? 'unknown'
        : connection.facts.connectionConfigured,
    authenticationVerified:
      weakOrStale('authentication') &&
      ['yes', 'not-required'].includes(connection.facts.authenticationVerified)
        ? 'unknown'
        : connection.facts.authenticationVerified,
    modelReachable:
      weakOrStale('reachability') && connection.facts.modelReachable === 'yes'
        ? 'unknown'
        : connection.facts.modelReachable,
    requiredCapabilitiesVerified:
      weakOrStale('capabilities') && capEval.requiredCapabilitiesVerified === 'yes'
        ? 'unknown'
        : capEval.requiredCapabilitiesVerified,
    readyForSelectedTask: state,
  };

  const productionEligibilityGaps = [];
  if (state !== 'ready') {
    productionEligibilityGaps.push(`Readiness state is "${state}" (must be "ready").`);
  }
  if (connection.evidence.source !== 'observed') {
    productionEligibilityGaps.push(
      `Top-level evidence source is "${connection.evidence.source}" (host must supply "observed").`
    );
  }
  if (!connection.evidence.explicitFieldSourcesComplete) {
    productionEligibilityGaps.push(
      'Host must supply explicit "observed" provenance in evidence.fieldSources for all required fields.'
    );
  }
  if (!freshness.isFresh || staleFieldKeys.size > 0) {
    productionEligibilityGaps.push('Host must supply fresh, non-expired evidence timestamps.');
  }
  if (
    connection.model.identity.kind === 'unknown' ||
    !connection.model.identity.value ||
    connection.model.identity.verified !== true
  ) {
    productionEligibilityGaps.push(
      'Host must supply verified model identity evidence (verified: true with non-unknown kind and value).'
    );
  }
  if (
    permissionItems.some((p) => p.granted !== 'yes' || p.conflict) ||
    connection.invalidPermissions.length > 0
  ) {
    productionEligibilityGaps.push(
      'Host must confirm explicit non-conflicting "yes" grants for all required permission scopes.'
    );
  }
  const { attestationFreshness: hostAttestationFreshness, gaps: hostAttestationGaps } =
    evaluateHostAttestation(connection, now);
  for (const gap of hostAttestationGaps) {
    productionEligibilityGaps.push(gap);
  }

  const demonstrationReady = state === 'ready';
  const productionEligible = demonstrationReady && productionEligibilityGaps.length === 0;
  const readinessScope = productionEligible
    ? 'observed-production-candidate'
    : demonstrationReady
      ? 'synthetic-demo-only'
      : 'not-ready';

  const limitations = [connection.model.identity.note, connection.executionRoute.loopbackDisclaimer];
  if (connection.evidence.source === 'synthetic') {
    limitations.unshift('Synthetic demonstration data only; no live provider was contacted.');
  } else if (!productionEligible && demonstrationReady) {
    limitations.unshift(
      `Demonstration readiness only; missing production eligibility requirements: ${productionEligibilityGaps.join(' ')}`
    );
  }

  return deepFreeze({
    connectionId: connection.id,
    connectionLabel: connection.label,
    modelId: connection.model.id,
    modelLabel: connection.model.label,
    taskId: task.id,
    taskTitle: task.title,
    state,
    readyForTask: demonstrationReady,
    demonstrationReady,
    productionEligible,
    productionEligibilityGaps,
    readinessScope,
    reasonCodes: reasons.map((r) => r.code),
    reasons,
    distinctFacts,
    evidenceFreshness: freshness,
    hostAttestationFreshness,
    evidenceSource: connection.evidence.source,
    fieldSources: fs,
    destinationSummary: {
      uiLocation: connection.executionRoute.uiLocation,
      clientLocation: connection.executionRoute.clientLocation,
      executionLocation: connection.executionRoute.executionLocation,
      dataDestination: connection.executionRoute.dataDestination,
      endpoint: connection.executionRoute.endpoint,
      endpointParts: connection.executionRoute.endpointParts,
      endpointStatus: connection.executionRoute.endpointClassification.kind,
      endpointRedactionReason: connection.executionRoute.endpointRedactionReason,
      transportNote: connection.executionRoute.transportNote,
      cloudRouting: connection.executionRoute.cloudRouting,
      adapterKind: connection.provider.adapterKind,
      backendKind: connection.provider.backendKind,
    },
    billingSummary: {
      billingType: connection.billingType,
      detail: connection.billingDetail,
    },
    quotaSummary: connection.quota,
    capabilitySummary: capEval.items,
    permissionSummary: permissionItems,
    limitations,
  });
}

/**
 * Evaluates a full connection fleet against a single Task Contract.
 */
export function evaluateFleetCompatibility(connections, task, { now } = {}) {
  const normalizedTask = normalizeTaskContract(task);
  const list = Array.isArray(connections) ? connections : [];
  const evaluations = list.map((conn) => evaluateConnectionReadiness(conn, normalizedTask, { now }));

  const counts = {
    total: evaluations.length,
    ready: evaluations.filter((e) => e.state === 'ready').length,
    blocked: evaluations.filter((e) => e.state === 'blocked').length,
    unknown: evaluations.filter((e) => e.state === 'unknown').length,
  };

  return deepFreeze({
    task: normalizedTask,
    evaluations,
    counts,
  });
}

/**
 * Validates a candidate or previously confirmed route selection against the complete bound route.
 * Never mutates permissions or readiness state, and never treats structural hashes as cryptographic auth.
 */
export function validateRouteSelection(connections, task, selection, { now } = {}) {
  const normalizedTask = normalizeTaskContract(task);
  const currentSignature = taskRequirementSignature(normalizedTask);
  const list = Array.isArray(connections) ? connections : [];

  if (!selection || typeof selection !== 'object' || !selection.connectionId) {
    return deepFreeze({
      status: 'none',
      demoConfirmationAllowed: false,
      stale: false,
      guardCodes: [],
      message: 'No connection route is currently selected.',
      evaluation: null,
      limitations: [],
    });
  }

  const guardCodes = [];
  const messages = [];

  const hasCompleteBinding =
    typeof selection.connectionId === 'string' &&
    selection.connectionId.length > 0 &&
    typeof selection.modelId === 'string' &&
    selection.modelId.length > 0 &&
    typeof selection.taskSnapshotSignature === 'string' &&
    selection.taskSnapshotSignature.length > 0 &&
    typeof selection.routeSnapshotSignature === 'string' &&
    selection.routeSnapshotSignature.length > 0 &&
    selection.boundRoute !== null &&
    typeof selection.boundRoute === 'object' &&
    !Array.isArray(selection.boundRoute);

  if (!hasCompleteBinding) {
    guardCodes.push('SELECTION_BINDING_INCOMPLETE');
    messages.push(
      'Route selection lacks complete model, topology, billing, permission, or task bindings.'
    );
  }

  const found = list.find(
    (item) =>
      item?.id === selection.connectionId &&
      (!selection.modelId || item?.model?.id === selection.modelId)
  );

  if (!found) {
    guardCodes.push('SELECTED_MODEL_UNAVAILABLE');
    return deepFreeze({
      status: 'unavailable',
      demoConfirmationAllowed: false,
      stale: true,
      guardCodes,
      message:
        'The previously selected connection or model is no longer available in the route inventory.',
      evaluation: null,
      limitations: ['Selection is held; no replacement route was chosen automatically.'],
    });
  }

  const normalizedConn = normalizeConnectionContract(found);

  if (selection.boundRoute && typeof selection.boundRoute === 'object') {
    const bound = selection.boundRoute;
    if (
      normalizedConn.model.identity.kind !== bound.modelIdentityKind ||
      normalizedConn.model.identity.value !== bound.modelIdentityValue ||
      normalizedConn.model.identity.verified !== bound.modelIdentityVerified
    ) {
      guardCodes.push('STALE_SELECTION_MODEL_IDENTITY_CHANGED');
      messages.push('Model identity evidence changed after this route was selected.');
    }

    if (
      normalizedConn.executionRoute.endpoint !== bound.endpoint ||
      normalizedConn.executionRoute.dataDestination !== bound.dataDestination ||
      normalizedConn.executionRoute.executionLocation !== bound.executionLocation ||
      normalizedConn.executionRoute.clientLocation !== bound.clientLocation ||
      normalizedConn.executionRoute.cloudRouting !== bound.cloudRouting ||
      normalizedConn.provider.adapterKind !== bound.adapterKind ||
      normalizedConn.provider.backendKind !== bound.backendKind ||
      normalizedConn.executionRoute.hostPolicyRevision !== bound.hostPolicyRevision
    ) {
      guardCodes.push('STALE_SELECTION_TOPOLOGY_CHANGED');
      messages.push('Route destination, execution topology, or host policy changed after selection.');
    }

    if (normalizedConn.billingType !== bound.billingType) {
      guardCodes.push('STALE_SELECTION_BILLING_CHANGED');
      messages.push('Billing type changed after selection; explicit reconfirmation is required.');
    }

    const currentReqPerms = JSON.stringify(
      normalizedConn.permissions
        .filter((p) => p.requiredForConnection)
        .map((p) => p.scope)
        .sort()
    );
    const boundReqPerms = JSON.stringify(
      Array.isArray(bound.requiredPermissionScopes) ? [...bound.requiredPermissionScopes].sort() : []
    );
    if (currentReqPerms !== boundReqPerms) {
      guardCodes.push('STALE_SELECTION_PERMISSIONS_CHANGED');
      messages.push('Connection permission requirements changed after selection.');
    }
  }

  if (
    typeof selection.routeSnapshotSignature === 'string' &&
    selection.routeSnapshotSignature !== routeRevisionSignature(normalizedConn) &&
    !guardCodes.some((c) => c.startsWith('STALE_SELECTION_'))
  ) {
    guardCodes.push('STALE_SELECTION_ROUTE_CHANGED');
    messages.push('Reviewed route properties changed after selection.');
  }

  if (selection.invalidated === true) {
    guardCodes.push('SELECTION_PREVIOUSLY_INVALIDATED');
    messages.push(
      'Selection confirmation was previously invalidated; explicit reconfirmation against the current route and task snapshot is required.'
    );
  }

  if (
    typeof selection.taskSnapshotSignature === 'string' &&
    selection.taskSnapshotSignature !== currentSignature
  ) {
    guardCodes.push('STALE_SELECTION_TASK_CHANGED');
    messages.push(
      'Task requirements changed after this route was selected. Review compatibility and re-confirm explicitly.'
    );
  }

  const evaluation = evaluateConnectionReadiness(normalizedConn, normalizedTask, { now });
  if (evaluation.state !== 'ready') {
    guardCodes.push('SELECTED_MODEL_UNAVAILABLE');
    messages.push(
      `Selected connection is currently ${evaluation.state} (${evaluation.reasonCodes.join(', ')}).`
    );
  }

  const valid = guardCodes.length === 0 && evaluation.readyForTask;

  return deepFreeze({
    status: valid ? 'valid' : 'invalid',
    demoConfirmationAllowed: valid,
    stale: guardCodes.some(
      (c) =>
        c.startsWith('STALE_SELECTION_') ||
        c === 'SELECTION_BINDING_INCOMPLETE' ||
        c === 'SELECTION_PREVIOUSLY_INVALIDATED'
    ),
    guardCodes,
    message:
      messages.join(' ') ||
      'Candidate route satisfies all evaluated requirements for this synthetic demonstration.',
    evaluation,
    limitations: [
      ...evaluation.limitations,
      'Demo confirmation records selection intent only; it does not grant permissions, authenticate, or start execution.',
    ],
  });
}

/**
 * Reconciles an active or confirmed route selection after fleet, clock, or task changes.
 * Deep-clones caller-owned selection metadata so input objects are never frozen or mutated.
 * Persistently revokes confirmation upon hold so temporary recovery never restores authorization automatically.
 */
export function reconcileSelectionOnStateChange(connections, task, previousSelection, { now } = {}) {
  const fleet = evaluateFleetCompatibility(connections, task, { now });
  const validation = validateRouteSelection(connections, task, previousSelection, { now });

  if (!previousSelection || typeof previousSelection !== 'object' || !previousSelection.connectionId) {
    return deepFreeze({
      action: 'none',
      activeSelection: null,
      validation,
      guardCodes: [],
      silentFallbackPrevented: false,
      message: 'No prior route selection to reconcile.',
    });
  }

  if (validation.status === 'valid' && previousSelection.invalidated !== true) {
    return deepFreeze({
      action: 'keep',
      activeSelection: safeClone(previousSelection),
      validation,
      guardCodes: [],
      silentFallbackPrevented: false,
      message: 'Selected route remains ready under the current task requirements.',
    });
  }

  const guardCodes = [...validation.guardCodes];
  const readyPaidAlternative = fleet.evaluations.some(
    (ev) =>
      ev.connectionId !== previousSelection.connectionId &&
      ev.state === 'ready' &&
      (ev.billingSummary.billingType === 'metered' ||
        ev.billingSummary.billingType === 'subscription')
  );

  guardCodes.push('SILENT_PAID_FALLBACK_PREVENTED');

  const fallbackNote = readyPaidAlternative
    ? 'A ready paid or external route exists in the fleet, but CydeWorks AI held this selection rather than silently switching.'
    : 'Selection is held without automatically switching to another or metered connection.';

  const heldSelection = safeClone(previousSelection);
  heldSelection.confirmed = false;
  heldSelection.confirmedAt = null;
  heldSelection.invalidated = true;

  return deepFreeze({
    action: 'hold',
    activeSelection: heldSelection,
    validation,
    guardCodes,
    silentFallbackPrevented: true,
    message: `${validation.message} ${fallbackNote}`,
  });
}
