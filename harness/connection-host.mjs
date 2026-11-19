import {createHash} from 'node:crypto';
import {CAPABILITY_KEYS,PERMISSION_SCOPES,FIELD_PROVENANCE_KEYS} from './connection-contract.mjs';
import {evaluateConnectionReadiness} from './connection-readiness.mjs';
import {assessRoute} from './route.mjs';

// Accept server-owned inventory only. This adapter deliberately does not accept
// attestation, capabilities or approvals from the browser or provider metadata.
export function inspectTaskConnections(task,models,{now,freeBytes,endpoints}) {
  const requirements={id:task.id,title:'Current task',description:'Approved snapshot proposal workflow',
    requireLocalOnly:true,workMode:'read-only',requiredCapabilities:task.kind==='brief'
      ?['structuredJson','sourceCitationBrief']:['structuredJson','fileChangeProposal','toolUseDeniedSafe'],
    requiredPermissions:['read-only-source'],allowedBillingTypes:['local'],requireVerifiedQuota:true};
  const inventory=models.filter(model=>model.engine!=='fixture');
  const limit=50;
  const connections=inventory.slice(0,limit).map(model=>{
    const backend=model.backend==='llamacpp'?'llamacpp':'ollama';
    const id=createHash('sha256').update(JSON.stringify([model.engine,backend,model.id])).digest('hex');
    const local=backend==='llamacpp'?null:model.remote===false&&model.cloudDisabled===true;
    const scopes=['read-only-source','loopback-http',...(model.engine==='opencode'?['local-process-spawn']:[])];
    const connection={id,label:'Local preview route',
      provider:{id:model.engine,label:'Local preview adapter',adapterKind:model.engine,backendKind:backend},
      model:{id,label:'Inventory model',identity:{kind:backend==='llamacpp'?'server-metadata':'digest',
        value:backend==='llamacpp'?model.fingerprint:model.digest,verified:false}},
      executionRoute:{clientLocation:model.engine==='opencode'?'local-cli-adapter':'local-process',
        executionLocation:local===true?'local-machine':'unknown',
        dataDestination:'local-loopback',endpoint:endpoints[backend],
        transportNote:'Inventory probe only; downstream isolation and task capabilities are not attested.',
        hostPolicyRevision:'inventory-v1',cloudRouting:backend==='llamacpp'?'not-applicable':
          model.cloudDisabled===true?'disabled':model.cloudDisabled===false?'enabled':'unknown'},
      billingType:local===true?'local':'unknown',billingDetail:'Inventory does not measure operating cost.',
      authentication:{status:'not-required',method:'Loopback inventory',detail:'Inventory response only.'},
      facts:{softwareDetected:'yes',connectionConfigured:'yes',authenticationVerified:'not-required',
        modelReachable:'unknown',capabilitiesVerified:'unknown'},
      capabilities:Object.fromEntries(CAPABILITY_KEYS.map(key=>[key,'unknown'])),
      memory:{modelBytes:model.bytes,freeSystemBytes:freeBytes},
      permissions:PERMISSION_SCOPES.map(scope=>({id:scope,scope,label:scope,
        requiredForConnection:scopes.includes(scope),granted:'no',
        explanation:'This diagnostic does not carry or grant run approval.'})),
      quota:{status:local===true?'not-applicable':'unknown',label:'Inventory only',detail:'No entitlement attested.'},
      evidence:{source:'observed',observedAt:now,ttlMs:30000,
        fieldSources:Object.fromEntries(FIELD_PROVENANCE_KEYS.map(key=>[key,
          key==='software'?'observed':'unknown'])),
        fieldObservedAt:{software:now},
        hostVerification:{verifiedByHost:false,inspectorId:null,verifiedAt:null}}};
    return {route:{id,engine:model.engine,backend},previewEligibility:assessRoute(model,freeBytes),
      qualification:evaluateConnectionReadiness(connection,requirements,{now})};
  });
  return {formatVersion:1,scope:'inventory-diagnostic',taskId:task.id,taskVersion:task.version,
    observedAt:now,executionAuthorized:false,connections,
    inventory:{totalRoutes:inventory.length,evaluatedRoutes:connections.length,limit,truncated:inventory.length>limit},
    limitation:'Inventory reachability is not task qualification. No capability or host isolation attestation has been recorded. Run approval and preflight remain separate.'};
}
