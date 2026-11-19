const fields=['input','output','cached','cacheWrite','reasoning'];
const limit=64;
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\u0000-\u001f\u007f]/.test(value);
const normalizeStep=step=>Object.fromEntries(fields.map(field=>[field,count(step?.[field])]));

function asUsage(items,flags) {
  const unsafe=flags.identityAmbiguous||flags.conflict||flags.truncated;
  const totals=Object.fromEntries(fields.map(field=>{
    let value=0;
    if(unsafe || !items.length || items.some(item=>item[field]===null)) return [field,null];
    for(const item of items) {
      if(!Number.isSafeInteger(value+item[field]))return [field,null];
      value+=item[field];
    }
    return [field,value];
  }));
  return {evidence:'OpenCode reported',...totals,generationMs:null,loadMs:null,providerCharge:null,
    steps:{items,...flags}};
}

export function createStepReceipt() {
  const items=[],seen=new Map();
  let duplicates=0,unidentified=false,conflict=false,truncated=false,identityConflict=false,firstSession=null;
  return {
    observe(event) {
      const part=event?.part;
      const tokens=part?.tokens;
      if(validId(event?.sessionID)) {
        if(firstSession && firstSession!==event.sessionID)identityConflict=true;
        firstSession ??= event.sessionID;
      }
      if(validId(event?.sessionID)&&validId(part?.sessionID)&&event.sessionID!==part.sessionID)identityConflict=true;
      const step=normalizeStep({input:tokens?.input,output:tokens?.output,
        cached:tokens?.cache?.read,cacheWrite:tokens?.cache?.write,reasoning:tokens?.reasoning});
      const id=validId(event?.sessionID)&&event.sessionID===part?.sessionID&&
        validId(part?.messageID)&&validId(part?.id)
        ?part.id:null;
      const body=JSON.stringify([event?.sessionID,part?.messageID,part?.reason,step]);
      if(id && seen.has(id)) {
        if(seen.get(id)!==body) {conflict=true;return {duplicate:true,unsafe:true};}
        duplicates++;
        return {duplicate:true,unsafe:identityConflict||conflict||truncated};
      }
      if(!id) unidentified=true;
      if(items.length>=limit) {truncated=true;return {duplicate:false,unsafe:true};}
      if(id)seen.set(id,body);
      items.push(step);
      return {duplicate:false,unsafe:identityConflict||conflict||truncated||(unidentified&&items.length>1)};
    },
    snapshot() {
      if(!items.length)return null;
      return asUsage(items.map(normalizeStep),{duplicates,unidentified,
        identityAmbiguous:identityConflict||(unidentified&&items.length>1),conflict,truncated});
    },
  };
}

export function sanitizeOpenCodeUsage(usage) {
  if(usage?.evidence!=='OpenCode reported')return null;
  if(!usage.steps) return {evidence:'OpenCode reported',...normalizeStep(usage),
    generationMs:null,loadMs:null,providerCharge:null};
  const source=usage.steps;
  if(!Array.isArray(source.items)||source.items.length===0||source.items.length>limit)return null;
  const flags={duplicates:count(source.duplicates),unidentified:source.unidentified===true,
    identityAmbiguous:source.identityAmbiguous===true,conflict:source.conflict===true,truncated:source.truncated===true};
  if(flags.duplicates===null || ['unidentified','identityAmbiguous','conflict','truncated'].some(key=>typeof source[key]!=='boolean'))
    return null;
  if(flags.unidentified&&source.items.length>1)flags.identityAmbiguous=true;
  return asUsage(source.items.map(normalizeStep),flags);
}
