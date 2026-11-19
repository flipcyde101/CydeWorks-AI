// Approval binding. Pure functions, no DOM and no clock.
//
// An approval is a person's decision about one exact task version, one exact scope and one exact
// set of route facts. It is captured once when the box is ticked, compared against every later
// read, and submitted exactly as captured. Current values are never substituted into an old
// approval. The host's own version, scope and model preflight checks remain authoritative.

const sorted = list => Array.isArray(list) ? [...list].map(String).sort() : [];

// The parts of a task a route would receive, plus the version that identifies them.
export function scopeIdentity(task) {
  if (!task) return null;
  return {taskId: task.id ?? null, version: task.version ?? null, kind: task.kind ?? null, request: task.request ?? null,
    sourceHash: task.sourceHash ?? null, filename: task.filename ?? null, expected: task.expected ?? null};
}

// Material route facts. Observation times are excluded on purpose so a refresh that changes nothing
// material does not clear an approval. `revision` is the host's per-route content identifier
// (harness/route-inventory.mjs, route-facts-sha256-v1) when present. Facts are always compared as
// well, so a missing revision is never read as "unchanged". The host's own material facts are all
// here (model, engine, backend, endpoint, digest or fingerprint, size in bytes, quantization,
// remote, cloud-disabled, readiness eligibility and explanation), plus the facts the client shows
// that the host formula does not cover (destination text, permissions, billing type, planned).
export function routeFacts(route) {
  if (!route) return null;
  const opt = value => value === undefined ? null : value;
  return {key: route.key ?? null, model: route.id ?? null, engine: route.engine ?? null, backend: route.backend ?? null,
    identityKind: route.identity?.kind ?? null, identity: route.identity?.value ?? null,
    quantization: opt(route.quantization), bytes: opt(route.bytes ?? route.size),
    destination: route.destination ?? null, endpoint: route.endpoint ?? null,
    remote: opt(route.remote), cloudDisabled: opt(route.cloudDisabled), type: route.type ?? null,
    permissions: sorted(route.permissions), eligible: route.readiness?.eligible === true, planned: route.planned === true,
    readinessReason: opt(route.readiness?.reason),
    revision: typeof route.revision === 'string' ? route.revision : null};
}

const GROUPS = [
  ['model identity', ['model', 'engine', 'backend', 'identityKind', 'identity']],
  ['model build', ['quantization', 'bytes']],
  ['data destination', ['destination', 'endpoint', 'remote']],
  ['cloud setting', ['cloudDisabled']],
  ['permissions', ['permissions']],
  ['preview check', ['eligible', 'planned']],
  ['readiness details', ['readinessReason']],
  ['billing type', ['type']],
  ['host route revision', ['revision']],
];

// Route evidence freshness (host GET /api/models, ROUTE-INVENTORY.md rule 3). Usable only while
// observedAt <= now < expiresAt, with no tolerance: any future observation holds, and expiry holds
// at the exact millisecond. Inventory that reports neither time (a revisionless legacy response) is
// "freshness not reported". A response that reports only one time, or a time that is not a
// parseable string, is malformed and holds rather than reading as fresh.
export function evidenceProblem(inventory, nowMs) {
  if (!inventory) return null;
  const hasObserved = inventory.observedAt != null, hasExpires = inventory.expiresAt != null;
  if (!hasObserved && !hasExpires) return null;
  const observed = hasObserved && typeof inventory.observedAt === 'string' ? Date.parse(inventory.observedAt) : NaN;
  const expires = hasExpires && typeof inventory.expiresAt === 'string' ? Date.parse(inventory.expiresAt) : NaN;
  if (!Number.isFinite(observed) || !Number.isFinite(expires)) return 'the route evidence times could not be read';
  if (observed > nowMs) return 'the route evidence is dated in the future';
  if (nowMs >= expires) return 'the route evidence expired';
  return null;
}
const SCOPE_LABELS = [['request', 'request'], ['sourceHash', 'source snapshot'], ['kind', 'workflow'], ['filename', 'file name'], ['expected', 'expected text']];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Names of the route fact groups that differ. A missing route counts as a change.
export function routeChanges(before, after) {
  if (!before && !after) return [];
  if (!before || !after) return ['route availability'];
  if (before.key !== after.key) return ['selected route'];
  return GROUPS.filter(([, keys]) => keys.some(key => !same(before[key], after[key]))).map(([label]) => label);
}

export function captureApproval(task, route, {requestId}) {
  if (!task || !route || typeof requestId !== 'string' || !requestId) throw Error('An approval needs a task, a route and a request identity.');
  return Object.freeze({taskId: task.id, scope: Object.freeze(scopeIdentity(task)), route: Object.freeze(routeFacts(route)),
    attemptNumber: (task.attempts?.length ?? 0) + 1, requestId});
}

// Every reason the captured approval no longer describes what is on screen. Empty means it still holds.
// Pass {inventory, now} to include route evidence freshness.
export function approvalProblems(binding, task, route, {inventory = null, now = null} = {}) {
  if (!binding) return ['no approval is recorded'];
  const problems = [];
  if (!task || task.id !== binding.taskId) return ['a different task is open'];
  const scope = scopeIdentity(task);
  if (scope.version !== binding.scope.version) problems.push('the task changed (version ' + binding.scope.version + ' is now ' + scope.version + ')');
  const scopeChanges = SCOPE_LABELS.filter(([key]) => scope[key] !== binding.scope[key]).map(([, label]) => label);
  if (scopeChanges.length) problems.push('the ' + scopeChanges.join(', ') + ' changed');
  if ((task.attempts?.length ?? 0) + 1 !== binding.attemptNumber) problems.push('another attempt was recorded');
  const changes = routeChanges(binding.route, routeFacts(route));
  if (changes[0] === 'route availability') problems.push('the route is no longer available');
  else if (changes[0] === 'selected route') problems.push('a different route is selected');
  else if (changes.length) problems.push('the route ' + changes.join(', ') + ' changed');
  else if (!binding.route.eligible) problems.push('the route does not pass the preview check');
  const stale = now === null ? null : evidenceProblem(inventory, now);
  if (stale) problems.push(stale);
  return problems;
}

// The host's keyed run body (harness/run-submission.mjs), built only from the captured binding.
// routeRevision is the selected route's own revision (never the aggregate inventory revision); the
// host compares it before dispatch and records a failed preflight on mismatch.
export function submissionBody(binding) {
  const {scope, route, requestId} = binding;
  const body = {requestId, version: scope.version, sourceHash: scope.sourceHash, approve: true,
    model: route.model, engine: route.engine, backend: route.backend};
  if (route.engine !== 'fixture') body[route.backend === 'llamacpp' ? 'modelFingerprint' : 'modelDigest'] = route.identity;
  if (route.revision) body.routeRevision = route.revision;
  return body;
}

// Terminal confirmations bind to the exact attempt, ownership generation and, for Stop, lease
// observed when the dialog opened.
export function terminalTarget(task, lease = null) {
  const control = task?.live?.control;
  if (!control) return null;
  return Object.freeze({attemptId: control.attemptId, generation: control.generation, owner: control.owner, closed: !!control.closed,
    lease: lease && lease.attemptId === control.attemptId && lease.generation === control.generation ? lease.lease : null});
}

export function terminalTargetHolds(target, task, lease = null) {
  if (!target) return false;
  const now = terminalTarget(task, lease);
  return !!now && task.status === 'running' && !now.closed && now.attemptId === target.attemptId &&
    now.generation === target.generation && now.owner === target.owner && now.lease === target.lease;
}
