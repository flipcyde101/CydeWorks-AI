import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBaselineConnections, DEFAULT_DEMO_NOW_MS, SYNTHETIC_TASKS,
} from './test-support/connection-fixtures.mjs';
import {
  createRouteSelection, FIELD_PROVENANCE_KEYS, normalizeConnectionContract, reconfirmRouteSelection,
} from './connection-contract.mjs';
import {
  evaluateConnectionReadiness, reconcileSelectionOnStateChange, validateRouteSelection,
} from './connection-readiness.mjs';

const now = DEFAULT_DEMO_NOW_MS;
const options = { now };
const timestamp = new Date(now - 10).toISOString();
const connection = (id = 'conn-ollama-local') => createBaselineConnections().find(item => item.id === id);
const task = (index = 0) => structuredClone(SYNTHETIC_TASKS[index]);
const evaluate = (route, requirements = task()) => evaluateConnectionReadiness(route, requirements, options);

function observedRoute() {
  const route = connection();
  route.evidence.source = 'observed';
  route.evidence.fieldSources = Object.fromEntries(FIELD_PROVENANCE_KEYS.map(key => [key, 'observed']));
  route.evidence.fieldObservedAt = Object.fromEntries(FIELD_PROVENANCE_KEYS.map(key => [key, timestamp]));
  route.evidence.hostVerification = { verifiedByHost: true, inspectorId: 'synthetic-inspector', verifiedAt: timestamp };
  return route;
}

function remoteRouteWithoutEgress() {
  const route = connection('conn-synth-subscription');
  route.authentication.status = 'verified';
  route.facts.authenticationVerified = 'yes';
  route.quota.status = 'available';
  route.permissions = route.permissions.filter(permission => permission.scope !== 'remote-data-egress');
  const requirements = task(2);
  requirements.requiredPermissions = ['read-only-source'];
  return { route, requirements };
}

test('unknown inference backend and unverifiable Ollama cloud routing hold local tasks', () => {
  const ollama = connection();
  assert.equal(evaluate(ollama).state, 'ready');
  ollama.executionRoute.cloudRouting = 'not-applicable';
  assert.ok(evaluate(ollama).reasonCodes.includes('CLOUD_ROUTING_INVALID_FOR_OLLAMA'));

  const wrapper = connection('conn-opencode-route');
  wrapper.facts.modelReachable = 'yes';
  delete wrapper.provider.backendKind;
  wrapper.executionRoute.cloudRouting = 'enabled';
  const readiness = evaluate(wrapper);
  assert.notEqual(readiness.state, 'ready');
  assert.ok(readiness.reasonCodes.includes('BACKEND_UNKNOWN'));
  assert.ok(readiness.reasonCodes.includes('CLOUD_ROUTING_ENABLED'));
});

test('task permission contradictions and missing derived egress grant block', () => {
  const readOnly = task();
  readOnly.requiredPermissions.push('repository-write');
  const repoRoute = connection();
  repoRoute.permissions.find(permission => permission.scope === 'repository-write').granted = 'yes';
  assert.ok(evaluate(repoRoute, readOnly).reasonCodes.includes('PERMISSION_EXCEEDS_TASK_SCOPE'));

  const localOnly = task();
  localOnly.requiredPermissions.push('remote-data-egress');
  const egressRoute = connection();
  egressRoute.permissions.push({ scope: 'remote-data-egress', requiredForConnection: false, granted: 'yes' });
  assert.ok(evaluate(egressRoute, localOnly).reasonCodes.includes('PERMISSION_EXCEEDS_TASK_SCOPE'));

  const { route, requirements } = remoteRouteWithoutEgress();
  const assessment = evaluate(route, requirements);
  assert.notEqual(assessment.state, 'ready');
  assert.ok(assessment.reasonCodes.includes('PERMISSION_UNGRANTED'));
});

test('remote execution cannot satisfy a local billing policy by changing its billing label', () => {
  const { route, requirements } = remoteRouteWithoutEgress();
  route.permissions.push({ scope: 'remote-data-egress', requiredForConnection: false, granted: 'yes' });
  assert.equal(evaluate(route, requirements).state, 'ready');
  route.billingType = 'local';
  requirements.allowedBillingTypes = ['local'];
  const assessment = evaluate(route, requirements);
  assert.equal(assessment.state, 'blocked');
  assert.ok(assessment.reasonCodes.includes('BILLING_TOPOLOGY_CONTRADICTION'));
});

test('observed production eligibility requires explicit provenance and a verified model identity', () => {
  const route = observedRoute();
  assert.equal(evaluate(route).productionEligible, true);
  delete route.evidence.fieldSources.destination;
  assert.equal(evaluate(route).productionEligible, false);
  route.evidence.fieldSources.destination = 'observed';
  route.model.identity = { kind: 'unknown', value: null, verified: false };
  assert.equal(evaluate(route).productionEligible, false);
});

test('repeated normalization preserves endpoint redaction and invalidity', () => {
  const urls = [
    'http://syntheticUser:syntheticPassword@127.0.0.1:11434/v1',
    'http://127.0.0.1:11434/v1?test=syntheticQuery',
    'http://127.0.0.1:11434/v1#syntheticFragment',
  ];
  for (const url of urls) {
    const route = connection();
    route.executionRoute.endpoint = url;
    const first = normalizeConnectionContract(route);
    const second = normalizeConnectionContract(first);
    const assessment = evaluate(second);
    assert.equal(first.executionRoute.endpoint, null);
    assert.equal(second.executionRoute.endpoint, null);
    assert.equal(second.malformed, true);
    assert.equal(assessment.state, 'blocked');
    const serialized = JSON.stringify([first, second, assessment, createRouteSelection(first, task())]);
    assert.doesNotMatch(serialized, /syntheticUser|syntheticPassword|syntheticQuery|syntheticFragment/);
  }
});

test('recovered readiness still requires explicit confirmation after a hold', () => {
  const route = connection();
  const requirements = task();
  const selection = createRouteSelection(route, requirements, { confirmed: true, confirmedAt: timestamp });
  assert.equal(validateRouteSelection([route], requirements, selection, options).status, 'valid');
  const unavailable = structuredClone(route);
  unavailable.facts.modelReachable = 'no';
  const hold = reconcileSelectionOnStateChange([unavailable], requirements, selection, options);
  assert.equal(hold.activeSelection.confirmed, false);
  assert.equal(hold.activeSelection.confirmedAt, null);
  assert.equal(hold.activeSelection.invalidated, true);
  const recovered = reconcileSelectionOnStateChange([route], requirements, hold.activeSelection, options);
  assert.equal(recovered.action, 'hold');
  assert.ok(recovered.guardCodes.includes('SELECTION_PREVIOUSLY_INVALIDATED'));
  const reconfirmed = reconfirmRouteSelection(route, requirements, { confirmedAt: timestamp });
  assert.equal(validateRouteSelection([route], requirements, reconfirmed, options).status, 'valid');
});

for (const [label, adjust] of [
  ['attestation missing inspector ID', attestation => { delete attestation.inspectorId; }],
  ['attestation missing verification time', attestation => { delete attestation.verifiedAt; }],
  ['expired attestation', (attestation, ttl) => { attestation.verifiedAt = new Date(now - ttl).toISOString(); }],
  ['future attestation', attestation => { attestation.verifiedAt = new Date(now + 1).toISOString(); }],
]) {
  test(`${label} cannot establish production eligibility`, () => {
    const route = observedRoute();
    assert.equal(evaluate(route).productionEligible, true);
    adjust(route.evidence.hostVerification, route.evidence.ttlMs);
    assert.equal(evaluate(route).productionEligible, false);
  });
}
