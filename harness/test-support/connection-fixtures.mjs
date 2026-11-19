/**
 * Synthetic fixtures and failure/recovery simulation scenarios for the
 * CydeWorks AI Connections and Model Readiness Center standalone demo.
 *
 * Notice: No real provider endpoints, OAuth URLs, subscription entitlements,
 * or credential stores are included.
 */

import { createRouteSelection } from '../connection-contract.mjs';

export const DEFAULT_DEMO_NOW = '2026-11-16T15:30:00.000Z';
export const DEFAULT_DEMO_NOW_MS = Date.parse(DEFAULT_DEMO_NOW);
const RECENT_OBSERVED_AT = '2026-11-16T15:28:00.000Z';
const FIVE_MINUTES_MS = 300_000;

export const SYNTHETIC_TASKS = Object.freeze([
  {
    id: 'task-local-brief',
    title: 'Local Source Brief',
    description: 'Summarize an approved source snapshot locally with inline [number] citations.',
    requireLocalOnly: true,
    workMode: 'read-only',
    requiredCapabilities: ['structuredJson', 'sourceCitationBrief'],
    requiredPermissions: ['read-only-source'],
    allowedBillingTypes: ['local'],
    requireVerifiedQuota: true,
  },
  {
    id: 'task-local-patch',
    title: 'Single-File Change Proposal',
    description: 'Draft a JSON-structured change proposal for operator diff review without writing files.',
    requireLocalOnly: true,
    workMode: 'read-only',
    requiredCapabilities: ['structuredJson', 'fileChangeProposal', 'toolUseDeniedSafe'],
    requiredPermissions: ['read-only-source'],
    allowedBillingTypes: ['local'],
    requireVerifiedQuota: true,
  },
  {
    id: 'task-remote-sub-brief',
    title: 'External Subscription Synthesis',
    description: 'Synthetic task permitting external subscription-backed execution when explicitly approved.',
    requireLocalOnly: false,
    workMode: 'read-only',
    requiredCapabilities: ['structuredJson', 'sourceCitationBrief'],
    requiredPermissions: ['read-only-source', 'remote-data-egress'],
    allowedBillingTypes: ['local', 'subscription'],
    requireVerifiedQuota: true,
  },
  {
    id: 'task-long-context',
    title: 'Extended Context Specification Audit',
    description: 'Audit a large technical specification requiring extended context support and remote-capable billing.',
    requireLocalOnly: false,
    workMode: 'read-only',
    requiredCapabilities: ['structuredJson', 'longContext'],
    requiredPermissions: ['read-only-source', 'remote-data-egress'],
    allowedBillingTypes: ['local', 'subscription', 'metered'],
    requireVerifiedQuota: true,
  },
  {
    id: 'task-repo-write',
    title: 'Direct Repository Write and Shell Verification',
    description: 'Requires repository write and local shell execution permissions (blocked on proposal-only routes).',
    requireLocalOnly: true,
    workMode: 'shell-execution',
    requiredCapabilities: ['fileChangeProposal'],
    requiredPermissions: ['read-only-source', 'repository-write', 'shell-execution'],
    allowedBillingTypes: ['local'],
    requireVerifiedQuota: true,
  },
]);

export function createBaselineConnections() {
  return [
    {
      id: 'conn-ollama-local',
      label: 'Local Ollama Service (Direct)',
      provider: {
        id: 'ollama-loopback',
        label: 'Ollama Loopback Engine (Synthetic)',
        adapterKind: 'ollama',
        backendKind: 'ollama',
      },
      model: {
        id: 'qwen3:1.7b',
        label: 'qwen3:1.7b',
        quantization: 'Q4_K_M',
        identity: {
          kind: 'digest',
          value: 'a'.repeat(64),
          verified: true,
          note: 'Ollama preflight reported SHA-256 digest; tag could change before execution.',
        },
      },
      executionRoute: {
        clientLocation: 'local-process',
        executionLocation: 'local-machine',
        dataDestination: 'local-loopback',
        endpoint: 'http://127.0.0.1:11434',
        transportNote: 'Direct loopback HTTP socket',
        hostPolicyRevision: 'v1',
        cloudRouting: 'disabled',
      },
      billingType: 'local',
      billingDetail: 'Local compute only; electricity and hardware wear are not metered here.',
      authentication: {
        status: 'not-required',
        method: 'Local loopback socket',
        detail: 'No provider account or API key required for synthetic loopback service.',
      },
      facts: {
        softwareDetected: 'yes',
        connectionConfigured: 'yes',
        authenticationVerified: 'not-required',
        modelReachable: 'yes',
        capabilitiesVerified: 'yes',
      },
      capabilities: {
        structuredJson: 'supported',
        sourceCitationBrief: 'supported',
        fileChangeProposal: 'supported',
        toolUseDeniedSafe: 'supported',
        longContext: 'unsupported',
      },
      memory: {
        modelBytes: 1_450_000_000,
        freeSystemBytes: 8_200_000_000,
      },
      permissions: [
        {
          id: 'perm-ollama-read',
          scope: 'read-only-source',
          label: 'Read approved source snapshot',
          requiredForConnection: true,
          granted: 'yes',
          explanation: 'Operator supplies explicit text snapshot in task scope.',
        },
        {
          id: 'perm-ollama-loopback',
          scope: 'loopback-http',
          label: 'Loopback HTTP transport (127.0.0.1)',
          requiredForConnection: true,
          granted: 'yes',
          explanation: 'Direct loopback HTTP transport without proxy forwarding.',
        },
        {
          id: 'perm-ollama-write',
          scope: 'repository-write',
          label: 'Write directly to repository files',
          requiredForConnection: false,
          granted: 'no',
          explanation: 'Blocked: CydeWorks AI restricts direct proposal routes to review-only output.',
        },
        {
          id: 'perm-ollama-shell',
          scope: 'shell-execution',
          label: 'Execute local shell commands',
          requiredForConnection: false,
          granted: 'no',
          explanation: 'Blocked: shell execution is not granted on this route.',
        },
      ],
      quota: {
        status: 'not-applicable',
        label: 'Not applicable (local compute)',
        detail: 'Constrained by host memory and CPU/GPU capacity rather than API quota.',
      },
      evidence: {
        source: 'synthetic',
        observedAt: RECENT_OBSERVED_AT,
        ttlMs: FIVE_MINUTES_MS,
        summary: 'Synthetic baseline imitating /api/tags and /api/status with cloud disabled.',
      },
    },
    {
      id: 'conn-opencode-route',
      label: 'OpenCode Execution Route (Brokered)',
      provider: {
        id: 'opencode-ollama-broker',
        label: 'OpenCode CLI Adapter via Local Broker (Synthetic)',
        adapterKind: 'opencode',
        backendKind: 'ollama',
      },
      model: {
        id: 'qwen3.5:4b-q4_K_M',
        label: 'harness-ollama/qwen3.5:4b-q4_K_M',
        quantization: 'Q4_K_M',
        identity: {
          kind: 'digest',
          value: 'b'.repeat(64),
          verified: true,
          note: 'OpenCode runs in --pure mode against an ephemeral 127.0.0.1 broker token.',
        },
      },
      executionRoute: {
        clientLocation: 'local-cli-adapter',
        executionLocation: 'local-machine',
        dataDestination: 'local-loopback',
        endpoint: 'http://127.0.0.1:11434',
        transportNote: 'Via ephemeral 127.0.0.1 loopback inference broker',
        hostPolicyRevision: 'v1',
        cloudRouting: 'disabled',
      },
      billingType: 'local',
      billingDetail: 'Local compute only via OpenCode proposal-only wrapper.',
      authentication: {
        status: 'not-required',
        method: 'Ephemeral per-attempt loopback broker token',
        detail: 'Local adapter authenticates only to the per-run loopback broker.',
      },
      facts: {
        softwareDetected: 'yes',
        connectionConfigured: 'yes',
        authenticationVerified: 'not-required',
        modelReachable: 'yes',
        capabilitiesVerified: 'yes',
      },
      capabilities: {
        structuredJson: 'supported',
        sourceCitationBrief: 'supported',
        fileChangeProposal: 'supported',
        toolUseDeniedSafe: 'supported',
        longContext: 'unsupported',
      },
      memory: {
        modelBytes: 2_850_000_000,
        freeSystemBytes: 8_200_000_000,
      },
      permissions: [
        {
          id: 'perm-oc-read',
          scope: 'read-only-source',
          label: 'Read approved source snapshot',
          requiredForConnection: true,
          granted: 'yes',
          explanation: 'Reads only the approved single input file written to isolated attempt directory.',
        },
        {
          id: 'perm-oc-spawn',
          scope: 'local-process-spawn',
          label: 'Spawn local adapter process',
          requiredForConnection: true,
          granted: 'yes',
          explanation: 'Configured OpenCode executable verified for proposal-only run.',
        },
        {
          id: 'perm-oc-loopback',
          scope: 'loopback-http',
          label: 'Loopback HTTP transport (127.0.0.1)',
          requiredForConnection: true,
          granted: 'yes',
          explanation: 'Broker binds strictly to 127.0.0.1.',
        },
        {
          id: 'perm-oc-write',
          scope: 'repository-write',
          label: 'Write directly to repository files',
          requiredForConnection: false,
          granted: 'no',
          explanation: 'Denied by OpenCode permission policy {"*":"deny"} in proposal-only route.',
        },
        {
          id: 'perm-oc-shell',
          scope: 'shell-execution',
          label: 'Execute local shell commands',
          requiredForConnection: false,
          granted: 'no',
          explanation: 'Denied by OpenCode permission policy {"*":"deny"}.',
        },
      ],
      quota: {
        status: 'not-applicable',
        label: 'Not applicable (local compute)',
        detail: 'OpenCode engine reports normalized step usage locally; no external quota.',
      },
      evidence: {
        source: 'synthetic',
        observedAt: RECENT_OBSERVED_AT,
        ttlMs: FIVE_MINUTES_MS,
        summary: 'Synthetic OpenCode executable and loopback Ollama route check.',
      },
    },
    {
      id: 'conn-llamacpp-local',
      label: 'Local llama.cpp Server (OpenCode Route)',
      provider: {
        id: 'llamacpp-loopback',
        label: 'llama.cpp Server via OpenCode (Synthetic)',
        adapterKind: 'llamacpp',
        backendKind: 'llamacpp',
      },
      model: {
        id: 'qwen3.5-4b-q4_k_m.gguf',
        label: 'qwen3.5-4b-q4_k_m.gguf',
        quantization: 'Q4_K - Medium',
        identity: {
          kind: 'server-metadata',
          value: 'c'.repeat(64),
          verified: false,
          note: 'The server metadata fingerprint does not verify model weights.',
        },
      },
      executionRoute: {
        clientLocation: 'local-cli-adapter',
        executionLocation: 'local-machine',
        dataDestination: 'local-loopback',
        endpoint: 'http://127.0.0.1:8080',
        transportNote: 'OpenCode wrapper targeting local llama.cpp server',
        hostPolicyRevision: 'v1',
        cloudRouting: 'not-applicable',
      },
      billingType: 'local',
      billingDetail: 'Local llama.cpp server compute; no external provider billing.',
      authentication: {
        status: 'not-required',
        method: 'Local loopback HTTP',
        detail: 'No account sign-in required for local llama.cpp server.',
      },
      facts: {
        softwareDetected: 'yes',
        connectionConfigured: 'yes',
        authenticationVerified: 'not-required',
        modelReachable: 'no',
        capabilitiesVerified: 'yes',
      },
      capabilities: {
        structuredJson: 'supported',
        sourceCitationBrief: 'supported',
        fileChangeProposal: 'supported',
        toolUseDeniedSafe: 'supported',
        longContext: 'unsupported',
      },
      memory: {
        modelBytes: 2_600_000_000,
        freeSystemBytes: 8_200_000_000,
      },
      permissions: [
        {
          id: 'perm-llama-read',
          scope: 'read-only-source',
          label: 'Read approved source snapshot',
          requiredForConnection: true,
          granted: 'yes',
          explanation: 'Reads approved task source snapshot only.',
        },
        {
          id: 'perm-llama-spawn',
          scope: 'local-process-spawn',
          label: 'Spawn local adapter process',
          requiredForConnection: true,
          granted: 'yes',
          explanation: 'OpenCode adapter executable verified.',
        },
        {
          id: 'perm-llama-loopback',
          scope: 'loopback-http',
          label: 'Loopback HTTP transport (127.0.0.1)',
          requiredForConnection: true,
          granted: 'yes',
          explanation: 'Targets configured loopback llama.cpp port 8080.',
        },
        {
          id: 'perm-llama-write',
          scope: 'repository-write',
          label: 'Write directly to repository files',
          requiredForConnection: false,
          granted: 'no',
          explanation: 'Proposal-only route denies file write tools.',
        },
      ],
      quota: {
        status: 'not-applicable',
        label: 'Not applicable (local compute)',
        detail: 'Bounded by host memory and local server queue.',
      },
      evidence: {
        source: 'synthetic',
        observedAt: RECENT_OBSERVED_AT,
        ttlMs: FIVE_MINUTES_MS,
        summary: 'Synthetic baseline showing configured llama.cpp server with /health unreachable.',
      },
    },
    {
      id: 'conn-synth-subscription',
      label: 'Synthetic External Subscription Relay',
      provider: {
        id: 'synthetic-sub-provider',
        label: 'Generic Synthetic Subscription Provider',
        adapterKind: 'synthetic-external',
        backendKind: 'remote-provider',
      },
      model: {
        id: 'synth-reasoner-pro-v1',
        label: 'synth-reasoner-pro-v1',
        quantization: null,
        identity: {
          kind: 'provider-model-id',
          value: 'synth-reasoner-pro-v1',
          verified: false,
          note: 'Remote provider controls weight deployment; local harness cannot verify remote weights.',
        },
      },
      executionRoute: {
        clientLocation: 'local-process',
        executionLocation: 'remote-provider',
        dataDestination: 'remote-endpoint',
        endpoint: 'https://models.synthetic-subscription.example/v1',
        transportNote: 'HTTPS egress from local client process',
        hostPolicyRevision: 'v1',
        cloudRouting: 'enabled',
      },
      billingType: 'subscription',
      billingDetail: 'Synthetic subscription-backed route. External plan entitlements are not verified by this app.',
      authentication: {
        status: 'expired',
        method: 'Synthetic external session token',
        detail: 'Simulated external subscription session expired and must be re-verified outside this UI.',
      },
      facts: {
        softwareDetected: 'yes',
        connectionConfigured: 'yes',
        authenticationVerified: 'expired',
        modelReachable: 'yes',
        capabilitiesVerified: 'yes',
      },
      capabilities: {
        structuredJson: 'supported',
        sourceCitationBrief: 'supported',
        fileChangeProposal: 'supported',
        toolUseDeniedSafe: 'supported',
        longContext: 'supported',
      },
      memory: {
        modelBytes: null,
        freeSystemBytes: null,
      },
      permissions: [
        {
          id: 'perm-sub-read',
          scope: 'read-only-source',
          label: 'Read approved source snapshot',
          requiredForConnection: true,
          granted: 'yes',
          explanation: 'Approved source snapshot available to local client.',
        },
        {
          id: 'perm-sub-egress',
          scope: 'remote-data-egress',
          label: 'Send approved task payload to remote endpoint',
          requiredForConnection: true,
          granted: 'no',
          explanation: 'Remote egress is not granted until operator approves sending data off this machine.',
        },
      ],
      quota: {
        status: 'unknown',
        label: 'Quota unknown (not verified)',
        detail: 'Provider subscription allowance is unknown and is never treated as unlimited.',
      },
      evidence: {
        source: 'synthetic',
        observedAt: RECENT_OBSERVED_AT,
        ttlMs: FIVE_MINUTES_MS,
        summary: 'Synthetic external subscription route illustrating local client -> remote destination.',
      },
    },
    {
      id: 'conn-synth-metered',
      label: 'Synthetic External Metered API',
      provider: {
        id: 'synthetic-metered-provider',
        label: 'Generic Synthetic Metered API Provider',
        adapterKind: 'synthetic-external',
        backendKind: 'remote-provider',
      },
      model: {
        id: 'synth-api-large-v2',
        label: 'synth-api-large-v2',
        quantization: null,
        identity: {
          kind: 'provider-model-id',
          value: 'synth-api-large-v2',
          verified: false,
          note: 'Remote metered API model; exact remote execution weights are unverified.',
        },
      },
      executionRoute: {
        clientLocation: 'local-process',
        executionLocation: 'remote-provider',
        dataDestination: 'remote-endpoint',
        endpoint: 'https://api.synthetic-metered.example/v1',
        transportNote: 'HTTPS egress from local client process',
        hostPolicyRevision: 'v1',
        cloudRouting: 'enabled',
      },
      billingType: 'metered',
      billingDetail: 'Synthetic pay-per-token metered API. Never selected automatically via fallback.',
      authentication: {
        status: 'verified',
        method: 'Synthetic API credential handle',
        detail: 'Simulated API key check passed in memory (no real key stored or transmitted).',
      },
      facts: {
        softwareDetected: 'yes',
        connectionConfigured: 'yes',
        authenticationVerified: 'yes',
        modelReachable: 'yes',
        capabilitiesVerified: 'yes',
      },
      capabilities: {
        structuredJson: 'supported',
        sourceCitationBrief: 'supported',
        fileChangeProposal: 'supported',
        toolUseDeniedSafe: 'supported',
        longContext: 'supported',
      },
      memory: {
        modelBytes: null,
        freeSystemBytes: null,
      },
      permissions: [
        {
          id: 'perm-met-read',
          scope: 'read-only-source',
          label: 'Read approved source snapshot',
          requiredForConnection: true,
          granted: 'yes',
          explanation: 'Approved source snapshot available to local client.',
        },
        {
          id: 'perm-met-egress',
          scope: 'remote-data-egress',
          label: 'Send approved task payload to remote endpoint',
          requiredForConnection: true,
          granted: 'no',
          explanation: 'Remote egress requires explicit approval before task data leaves this machine.',
        },
      ],
      quota: {
        status: 'available',
        label: 'Synthetic allowance: $14.20 remaining',
        detail: 'Simulated metered spend allowance is available; usage incurs metered charges.',
      },
      evidence: {
        source: 'synthetic',
        observedAt: RECENT_OBSERVED_AT,
        ttlMs: FIVE_MINUTES_MS,
        summary: 'Synthetic metered API route demonstrating remote execution and explicit billing guard.',
      },
    },
  ];
}

export const SIMULATION_PRESETS = Object.freeze([
  {
    id: 'baseline',
    label: 'Baseline mixed fleet',
    description: 'Default synthetic snapshot: two ready local routes, unreachable llama.cpp, and held external routes.',
  },
  {
    id: 'service-unavailable',
    label: 'Sim: Local services unavailable',
    description: 'Simulates unreachable Ollama and llama.cpp endpoints while keeping metered routes gated.',
  },
  {
    id: 'expired-auth',
    label: 'Sim: Expired authentication',
    description: 'Selects external subscription task while subscription session is expired.',
  },
  {
    id: 'unknown-quota',
    label: 'Sim: Unknown quota',
    description: 'Auth and egress are granted on subscription route, but quota remains unknown (stays non-green).',
  },
  {
    id: 'missing-capability',
    label: 'Sim: Missing capability',
    description: 'Selects Extended Context Audit task where local models lack longContext support.',
  },
  {
    id: 'stale-evidence',
    label: 'Sim: Stale evidence (+10m clock)',
    description: 'Advances the injected clock past the 5-minute TTL so previously ready connections become unknown.',
  },
  {
    id: 'exhausted-quota-no-fallback',
    label: 'Sim: Exhausted quota and no paid fallback',
    description: 'Prior selection becomes unavailable while metered API is exhausted or blocked from silent fallback.',
  },
  {
    id: 'empty-fleet',
    label: 'Sim: Empty connection list',
    description: 'Simulates zero configured connections to verify the accessible empty state.',
  },
]);

function setPermGranted(conn, scope, granted) {
  const entry = conn.permissions.find((p) => p.scope === scope);
  if (entry) entry.granted = granted;
}

/**
 * Generates a fresh simulation state snapshot for a named preset without mutating constants.
 */
export function buildSimulationScenario(presetId = 'baseline') {
  const connections = createBaselineConnections();
  let taskId = 'task-local-brief';
  let nowMs = DEFAULT_DEMO_NOW_MS;
  let preselectedConnectionId = 'conn-ollama-local';
  let preselectedSelection = null;

  if (presetId === 'service-unavailable') {
    for (const id of ['conn-ollama-local', 'conn-opencode-route', 'conn-llamacpp-local']) {
      const conn = connections.find((c) => c.id === id);
      if (conn) conn.facts.modelReachable = 'no';
    }
  } else if (presetId === 'expired-auth') {
    taskId = 'task-remote-sub-brief';
    const sub = connections.find((c) => c.id === 'conn-synth-subscription');
    if (sub) {
      setPermGranted(sub, 'remote-data-egress', 'yes');
      sub.authentication.status = 'expired';
      sub.facts.authenticationVerified = 'expired';
      sub.quota = {
        status: 'available',
        label: 'Synthetic allowance: available',
        detail: 'Simulated allowance available, but expired auth blocks use.',
      };
    }
    preselectedConnectionId = 'conn-synth-subscription';
  } else if (presetId === 'unknown-quota') {
    taskId = 'task-remote-sub-brief';
    const sub = connections.find((c) => c.id === 'conn-synth-subscription');
    if (sub) {
      setPermGranted(sub, 'remote-data-egress', 'yes');
      sub.authentication.status = 'verified';
      sub.authentication.detail = 'Simulated session verified in synthetic preset.';
      sub.facts.authenticationVerified = 'yes';
      sub.quota = {
        status: 'unknown',
        label: 'Quota unknown (not verified)',
        detail: 'External subscription quota endpoint not verified; cannot mark green.',
      };
    }
    preselectedConnectionId = 'conn-synth-subscription';
  } else if (presetId === 'missing-capability') {
    taskId = 'task-long-context';
    const met = connections.find((c) => c.id === 'conn-synth-metered');
    if (met) setPermGranted(met, 'remote-data-egress', 'yes');
    preselectedConnectionId = 'conn-ollama-local';
  } else if (presetId === 'stale-evidence') {
    const baselineOllama = connections.find((c) => c.id === 'conn-ollama-local');
    const baselineTask = SYNTHETIC_TASKS.find((t) => t.id === 'task-local-brief');
    if (baselineOllama && baselineTask) {
      preselectedSelection = createRouteSelection(baselineOllama, baselineTask, {
        confirmed: true,
        confirmedAt: DEFAULT_DEMO_NOW,
      });
    }
    nowMs = DEFAULT_DEMO_NOW_MS + 600_000;
    preselectedConnectionId = 'conn-ollama-local';
  } else if (presetId === 'exhausted-quota-no-fallback') {
    const priorTask = SYNTHETIC_TASKS.find((t) => t.id === 'task-local-brief');
    const priorConn = connections.find((c) => c.id === 'conn-ollama-local');
    if (priorConn && priorTask) {
      preselectedSelection = createRouteSelection(priorConn, priorTask, {
        confirmed: true,
        confirmedAt: new Date(DEFAULT_DEMO_NOW_MS - 30_000).toISOString(),
      });
    }

    taskId = 'task-long-context';
    if (priorConn) {
      priorConn.capabilities.longContext = 'supported';
      priorConn.facts.modelReachable = 'no';
    }
    const metered = connections.find((c) => c.id === 'conn-synth-metered');
    if (metered) {
      setPermGranted(metered, 'remote-data-egress', 'yes');
      metered.quota = {
        status: 'exhausted',
        label: 'Synthetic allowance: $0.00 remaining (exhausted)',
        detail: 'Simulated metered credit reached $0.00; route is blocked.',
      };
    }
    const sub = connections.find((c) => c.id === 'conn-synth-subscription');
    if (sub) {
      setPermGranted(sub, 'remote-data-egress', 'yes');
      sub.authentication.status = 'verified';
      sub.facts.authenticationVerified = 'yes';
      sub.quota = {
        status: 'available',
        label: 'Synthetic allowance: available',
        detail: 'Even though subscription route is ready, prior local selection is held.',
      };
    }
    preselectedConnectionId = 'conn-ollama-local';
  } else if (presetId === 'empty-fleet') {
    return {
      presetId,
      connections: [],
      taskId,
      nowMs,
      preselectedConnectionId: null,
      preselectedSelection: null,
    };
  }

  return {
    presetId,
    connections,
    taskId,
    nowMs,
    preselectedConnectionId,
    preselectedSelection,
  };
}
