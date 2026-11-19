const RESERVE_BYTES=1300000000;
const validBytes=value=>Number.isSafeInteger(value)&&value>0;
const previewModels=new Set(['qwen3:1.7b','qwen3:1.7b-dell-cpu','qwen3.5:4b-dell-gpu','qwen3.5:4b-q4_K_M']);
const validDigest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

export function matchesModelIdentity(expected,actual) {
  return validDigest(expected)&&validDigest(actual)&&expected===actual;
}

export function assessRoute(route,freeBytes) {
  if(route?.engine==='fixture')return {eligible:true,reason:'Synthetic fixture only. It does not run a model.'};
  if(!['ollama','opencode'].includes(route?.engine))return {eligible:false,reason:'This route is not approved in the local preview.'};
  if(route.backend==='llamacpp') {
    if(route.engine!=='opencode')return {eligible:false,reason:'Choose the OpenCode route for llama.cpp.'};
    if(!validBytes(route.bytes)||route.bytes>4000000000)return {eligible:false,reason:'The local model size is unavailable or exceeds 4 GB.'};
    if(!validDigest(route.fingerprint))return {eligible:false,reason:'The server metadata fingerprint is unavailable.'};
    if(!validBytes(freeBytes)||freeBytes<route.bytes+RESERVE_BYTES)
      return {eligible:false,reason:'Available system memory is below the model-size plus 1.3 GB threshold.'};
    return {eligible:true,reason:'The server metadata fingerprint does not verify model weights.'};
  }
  if(!previewModels.has(route.id))return {eligible:false,reason:'This installed model is not enabled for the local preview yet.'};
  if(route.remote!==false)return {eligible:false,reason:'Ollama reports a remote destination or its locality is unknown. This preview does not approve cloud routing.'};
  if(route.cloudDisabled!==true)return {eligible:false,reason:'Ollama cloud features are enabled or their status is unavailable. This route is held.'};
  if(!validBytes(route.bytes))return {eligible:false,reason:'The local model size is unavailable.'};
  if(route.bytes>4000000000)return {eligible:false,reason:'This preview does not admit models larger than 4 GB.'};
  if(!validDigest(route.digest))return {eligible:false,reason:'The model identity digest is unavailable.'};
  if(!validBytes(freeBytes))return {eligible:false,reason:'Available system memory is unavailable.'};
  if(freeBytes<route.bytes+RESERVE_BYTES)return {eligible:false,
    reason:'Available system memory is below the model-size plus 1.3 GB threshold. Free memory or choose a smaller route.'};
  return {eligible:true,reason:'The system memory threshold is met. This does not qualify the model for coding.'};
}
