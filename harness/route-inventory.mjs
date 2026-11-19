import {createHash} from 'node:crypto';

export const ROUTE_INVENTORY_TTL_MS=30000;
const policy='local-preview-route-facts-v1';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Internal boundary: host-normalized inventory rows, not client attestation.
// Keep material fields explicit. Labels, observation times and changing free
// memory counts must not churn approval while the eligibility result is stable.
function facts(model) {
  return [policy,model.id,model.engine,model.backend??(model.engine==='fixture'?'fixture':'ollama'),
    model.endpoint??null,model.digest??null,model.fingerprint??null,model.bytes??null,
    model.quantization??null,model.remote??null,model.cloudDisabled??null,
    model.readiness?.eligible===true,model.readiness?.reason??null];
}

export const routeRevision=model=>digest(facts(model));

export function buildRouteInventory(models,{observedAtMs=Date.now()}={}) {
  if(!Array.isArray(models)||models.some(model=>!model||typeof model!=='object'||Array.isArray(model))||
      !Number.isSafeInteger(observedAtMs)||observedAtMs<0||observedAtMs>8640000000000000-ROUTE_INVENTORY_TTL_MS)
    throw new TypeError('Invalid host route inventory.');
  const rows=models.map(model=>({...model,revision:routeRevision(model)}));
  return {
    models:rows,
    revision:digest([policy,rows.map(model=>model.revision).sort()]),
    revisionKind:'route-facts-sha256-v1',
    observedAt:new Date(observedAtMs).toISOString(),
    expiresAt:new Date(observedAtMs+ROUTE_INVENTORY_TTL_MS).toISOString(),
    executionAuthorized:false,
  };
}
