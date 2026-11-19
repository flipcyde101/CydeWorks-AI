// Synthetic fixtures. Every name, figure and identifier here is invented.
// Nothing in this file was produced by a model, a provider or the real workspace.

const hex = seed => (seed.repeat(64)).slice(0, 64);

// Route inventory in the shape of GET /api/models, plus presentation fields the
// candidate proposes (type, adapter and backend labels, destination, permissions).
// Host material facts carried as the host names them: bytes, quantization, remote and
// cloudDisabled (null where the host would not report one).
export const ROUTES = [
  {key: 'fixture', engine: 'fixture', backend: 'fixture', id: 'fixture', label: 'Synthetic fixture', type: 'local',
    adapterLabel: 'None', backendLabel: 'In-page sample generator', endpoint: null, terminal: false, script: 'fixture',
    identity: {kind: 'none', value: null, note: 'No model runs on this route.'},
    destination: 'Nothing leaves this browser tab. A sample result is generated without a model.',
    billing: {type: 'local', detail: 'No model runs. No usage is recorded.'},
    permissions: ['Read the approved source snapshot'],
    readiness: {eligible: true, reason: 'Synthetic fixture only. It does not run a model.'}},
  {key: 'opencode-llamacpp', engine: 'opencode', backend: 'llamacpp', id: 'demo-coder-4b', label: 'demo-coder 4b', quantization: 'Q4_K_M',
    bytes: 2497280000, remote: false, cloudDisabled: null, type: 'local', adapterLabel: 'OpenCode (tools denied)', backendLabel: 'llama.cpp on loopback', endpoint: 'http://127.0.0.1:8091',
    terminal: true, script: 'opencode',
    identity: {kind: 'server-metadata', value: hex('3fa9c1'), note: 'Server metadata fingerprint. It does not verify model weights.'},
    destination: 'OpenCode sends the approved request and source to llama.cpp on this computer. Network isolation is not verified.',
    billing: {type: 'local', detail: 'No provider charge is recorded. Electricity and hardware are not metered.'},
    permissions: ['Read the approved source snapshot', 'Loopback HTTP to 127.0.0.1'],
    readiness: {eligible: true, reason: 'The system memory threshold is met. This does not qualify the model for coding.'}},
  {key: 'ollama-direct', engine: 'ollama', backend: 'ollama', id: 'demo-small 1.7b', label: 'demo-small 1.7b', quantization: 'Q4_K_M',
    bytes: 1359000000, remote: false, cloudDisabled: false, type: 'local',
    adapterLabel: 'Direct', backendLabel: 'Ollama on loopback', endpoint: 'http://127.0.0.1:11434', terminal: false, script: 'fixture',
    identity: {kind: 'digest', value: hex('b07e55'), note: 'Digest reported at preflight. The model tag could change before execution.'},
    destination: 'Ollama on this computer would receive the approved request and source.',
    billing: {type: 'local', detail: 'No provider charge is recorded.'},
    permissions: ['Read the approved source snapshot', 'Loopback HTTP to 127.0.0.1'],
    readiness: {eligible: false, reason: 'Ollama reports cloud features enabled. This route is held.'}},
  {key: 'subscription-sample', engine: 'planned', backend: 'remote-provider', id: 'sample-subscription', label: 'Subscription sample', type: 'subscription',
    adapterLabel: 'Provider CLI (not implemented)', backendLabel: 'Remote provider', endpoint: 'https://models.example.invalid', terminal: false,
    planned: true, identity: {kind: 'provider-model-id', value: null, note: 'A remote provider controls its own weights.'},
    destination: 'A remote provider would receive the approved request and source.',
    billing: {type: 'subscription', detail: 'Plan allowance is unknown and is never treated as unlimited.'},
    permissions: ['Read the approved source snapshot', 'Send the approved payload to a remote endpoint'],
    readiness: {eligible: false, reason: 'Planned. Subscription connections are not implemented, and not every consumer subscription permits this use.'}},
  {key: 'metered-sample', engine: 'planned', backend: 'remote-provider', id: 'sample-metered', label: 'Metered API sample', type: 'metered',
    adapterLabel: 'API client (not implemented)', backendLabel: 'Remote provider', endpoint: 'https://api.example.invalid', terminal: false,
    planned: true, identity: {kind: 'provider-model-id', value: null, note: 'A remote provider controls its own weights.'},
    destination: 'A remote provider would receive the approved request and source.',
    billing: {type: 'metered', detail: 'Billed per use. Never selected automatically.'},
    permissions: ['Read the approved source snapshot', 'Send the approved payload to a remote endpoint'],
    readiness: {eligible: false, reason: 'Planned. Metered API connections are not implemented. A task is held rather than moved to metered billing.'}},
];

const brief = {kind: 'brief', request: 'Summarize the handoff and flag what still needs a decision.',
  source: 'The intake checklist is drafted. Riley owns the review.\nThe team has not decided who will approve the final checklist.\nThe pilot starts after approval.'};
const change = {kind: 'change', filename: 'retry.js', expected: 'export function retryWithBackoff',
  request: 'Rename retry to retryWithBackoff and keep behavior the same.',
  source: 'export function retry(task, attempts) {\n  for (let i = 0; i < attempts; i++) {\n    try { return task(); } catch (error) { if (i === attempts - 1) throw error; }\n  }\n}\n'};
const changed = change.source.replace('export function retry(', 'export function retryWithBackoff(');

// Seeds for a returning workspace. `ago` is minutes before the demo clock. Hashes are filled by the backend.
// Seeds with a receiptKey match the route order, timings and synthetic charges of the real envelope
// generated for them in host-fixtures.js, so the task view and its receipt tell the same story.
export const SEED_TASKS = [
  {title: 'Intake handoff brief', ...brief, status: 'review', ago: 6, attempts: [
    {route: 'fixture', status: 'review', elapsedMs: 4100, artifact: {summary: 'Synthetic sample brief with citations to the supplied lines. No model produced this.',
      content: '- The intake checklist is drafted and Riley owns the review. [1]\n- Nobody has been chosen to approve the final checklist. [2]\n- The pilot waits on that approval. [3]\nOpen decision: choose an approver.'},
      usage: {evidence: 'synthetic'}, cost: null, claims: []}]},
  {title: 'Rename retry helper', ...change, status: 'accepted', ago: 190, receiptKey: 'rename-a', attempts: [
    {route: 'ollama-direct', status: 'failed', elapsedMs: 2000, gapMs: 1000, problem: 'The proposal did not contain the expected text.', phase: 'settled',
      usage: {evidence: 'provider reported', input: 12, output: 6, cached: null}, cost: {amountMicros: 8000, currency: 'USD', evidence: 'estimated', complete: true}, claims: []},
    {route: 'opencode-llamacpp', status: 'accepted', elapsedMs: 5000, phase: 'settled', artifact: {summary: 'Renamed the exported function.', content: changed},
      usage: {evidence: 'OpenCode reported', input: 1840, output: 312, cached: 0,
        steps: {items: [{input: 900, output: 150, cached: 0}, {input: 940, output: 162, cached: 0}], duplicates: 1}},
      cost: {amountMicros: 15000, currency: 'USD', evidence: 'estimated', complete: true},
      claims: [{text: 'All callers were updated.', why: 'Only one file was supplied. Other files were not inspected.'},
        {text: 'Existing tests still pass.', why: 'No test runner is connected. Nothing was executed.'}],
      reviewMs: 95000, decision: 'accepted'}]},
  {title: 'Rename retry helper (second route)', ...change, status: 'accepted', ago: 150, receiptKey: 'rename-b', attempts: [
    {route: 'ollama-direct', status: 'accepted', elapsedMs: 4000, phase: 'settled', artifact: {summary: 'Renamed the exported function.', content: changed},
      usage: {evidence: 'provider reported', input: 1790, output: 305, cached: null}, cost: {amountMicros: 20000, currency: 'USD', evidence: 'estimated', complete: true},
      claims: [], reviewMs: 41000, decision: 'accepted'}]},
  {title: 'Summarize incident notes', ...brief, request: 'Summarize the incident notes for the weekly review.', status: 'interrupted', ago: 55, receiptKey: 'incident', attempts: [
    {route: 'opencode-llamacpp', status: 'interrupted', elapsedMs: null, phase: 'dispatching', usage: null, cost: null, claims: [],
      recovery: {state: 'unresolved', evidence: 'no-terminal-evidence',
        message: 'The earlier provider request may still be active. A retry is held until its outcome is reconciled.'}}]},
  {title: 'Config cleanup', ...change, filename: 'config.yaml', expected: 'timeout: 30', request: 'Set the timeout to 30 seconds.',
    source: 'service:\n  timeout: 10\n  retries: 2\n', status: 'failed', ago: 30, attempts: [
    {route: 'opencode-llamacpp', status: 'failed', elapsedMs: 300, phase: 'claimed',
      problem: 'The model identity changed or is unavailable. Refresh routes and approve the current model again.',
      usage: null, cost: null, claims: []}]},
  {title: 'Draft release note', ...brief, request: 'Draft a two line release note from these changes.', receiptKey: 'draft-note',
    source: 'Added Copy as new draft.\nTerminal control now checks the attempt and ownership generation.', status: 'draft', ago: 2, attempts: []},
];

export const DIAGNOSTICS = [
  {id: 'node', label: 'Node.js', state: 'ok', value: 'v24 or later required', help: 'Run node --version. The workspace uses node:sqlite and node:test.'},
  {id: 'port', label: 'Workspace port 15371', state: 'ok', value: 'Loopback only', help: 'Set BFE_PORT to change it. Never start a second service on the same workspace.'},
  {id: 'state', label: 'State folder', state: 'ok', value: '.state is present and private', help: 'Keep .state out of version control and backups you share.'},
  {id: 'ollama', label: 'Ollama', state: 'warn', value: 'Reachable, cloud features enabled', help: 'Ollama routes stay held until cloud features are disabled.'},
  {id: 'opencode', label: 'OpenCode executable', state: 'ok', value: 'Present at the configured absolute path', help: 'Set an absolute path and restart the preview if this reads invalid.'},
  {id: 'llamacpp', label: 'llama.cpp', state: 'unknown', value: 'Not configured', help: 'Optional. Configure a loopback endpoint to list llama.cpp routes.'},
  {id: 'isolation', label: 'OS-level network isolation', state: 'blocked', value: 'Not verified', help: 'No check exists yet. A loopback address is not proof of isolation.'},
];

// Design sample for the planned coordinated-agents view. Shape follows harness/swarm.mjs plan nodes.
export const SWARM_SAMPLE = {
  maxConcurrent: 2, approval: {state: 'needs-approval', ttl: 'Expires 30 minutes after approval'},
  nodes: [
    {id: 'plan', role: 'planner', title: 'Split the change into steps', status: 'succeeded', dependsOn: [], writes: [], owner: 'Planner'},
    {id: 'impl-api', role: 'builder', title: 'Rename helper in api/', status: 'running', dependsOn: ['plan'], writes: ['api/retry.js'], owner: 'Agent A'},
    {id: 'impl-web', role: 'builder', title: 'Update callers in web/', status: 'blocked', dependsOn: ['impl-api'], writes: ['web/client.js'], owner: 'Agent B',
      blockedBy: 'Waits for api/retry.js, which Agent A owns.'},
    {id: 'review', role: 'reviewer', title: 'Review both changes', status: 'pending', dependsOn: ['impl-api', 'impl-web'], writes: [], owner: 'Reviewer'},
    {id: 'you', role: 'human', title: 'Accept or revise', status: 'pending', dependsOn: ['review'], writes: [], owner: 'You'},
  ],
};
