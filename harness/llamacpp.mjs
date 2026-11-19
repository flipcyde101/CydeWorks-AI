import {createHash} from 'node:crypto';
import {directLocalFetch} from './direct-local-fetch.mjs';

const safeInteger=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const fileTypes=new Set(['all F32','F16','BF16','Q1_0','Q2_0','F8_E4M3','Q4_0','Q4_1','Q5_0','Q5_1','Q8_0',
  'MXFP4 MoE','NVFP4','Q2_K - Medium','Q2_K - Small','Q3_K - Small','Q3_K - Medium','Q3_K - Large',
  'Q4_K - Small','Q4_K - Medium','Q5_K - Small','Q5_K - Medium','Q6_K',
  'TQ1_0 - 1.69 bpw ternary','TQ2_0 - 2.06 bpw ternary','IQ2_XXS - 2.0625 bpw','IQ2_XS - 2.3125 bpw',
  'IQ2_S - 2.5 bpw','IQ2_M - 2.7 bpw','IQ3_XS - 3.3 bpw','IQ3_XXS - 3.0625 bpw',
  'IQ1_S - 1.5625 bpw','IQ1_M - 1.75 bpw','IQ4_NL - 4.5 bpw','IQ4_XS - 4.25 bpw',
  'IQ3_S - 3.4375 bpw','IQ3_S mix - 3.66 bpw']);
const quantization=value=>{
  if(typeof value!=='string')return null;
  const label=value.startsWith('(guessed) ')?value.slice(10):value;
  return fileTypes.has(label)?value:null;
};
function fingerprintFileType(value) {
  if(typeof value==='string') {
    if(value.length>256)throw Error('The local model file type is invalid.');
    return 'reported-string:'+createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  return safeInteger(value);
}

async function readJson(url,transport) {
  const response=await transport(url,{redirect:'error',signal:AbortSignal.timeout(3000)});
  if(!response.ok) {
    try {await response.body?.cancel();} catch {}
    throw Error('The local model service did not respond successfully.');
  }
  if(!response.body)throw Error('The local model service returned an empty response.');
  const chunks=[];
  let bytes=0;
  for await(const chunk of response.body) {
    bytes+=chunk.byteLength;
    if(bytes>100000)throw Error('The local model response exceeded its limit.');
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));
}

export function createLlamaCpp({port,transport=directLocalFetch}={}) {
  const configured=port!==undefined;
  const valid=typeof port==='string'&&/^\d{1,5}$/.test(port)&&Number(port)>0&&Number(port)<=65535;
  const endpoint=valid?'http://127.0.0.1:'+Number(port):null;
  return {
    configured,endpoint,
    async inspect() {
      if(!configured)return {models:[]};
      if(!endpoint)throw Error('The llama.cpp port is invalid.');
      try {
        const [health,inventory]=await Promise.all([
          readJson(endpoint+'/health',transport),readJson(endpoint+'/v1/models',transport),
        ]);
        if(health?.status!=='ok'||!Array.isArray(inventory?.data)||inventory.data.length!==1)
          throw Error('The local model is unavailable.');
        const model=inventory.data[0];
        if(model?.owned_by!=='llamacpp'||typeof model.id!=='string'||model.id==='fixture'||
            !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model.id)||
            !Number.isSafeInteger(model.meta?.size)||model.meta.size<=0||
            !Number.isSafeInteger(model.meta?.n_ctx)||model.meta.n_ctx<=0)
          throw Error('The local model metadata is unavailable.');
        const metadata=[model.id,model.owned_by,model.meta.size,
          ...['n_ctx','n_ctx_train','n_params','n_embd'].map(key=>safeInteger(model.meta[key])),
          fingerprintFileType(model.meta.ftype)];
        const fingerprint=createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
        return {models:[{id:model.id,label:model.id,bytes:model.meta.size,backend:'llamacpp',
          identityKind:'server-metadata',fingerprint,endpoint,quantization:quantization(model.meta.ftype)}]};
      } catch {
        throw Error('Could not verify the local llama.cpp model metadata.');
      }
    },
    async models() {return (await this.inspect()).models;},
  };
}

export const llamaCpp=createLlamaCpp({port:process.env.BFE_LLAMACPP_PORT});
