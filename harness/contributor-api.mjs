import {describeCostDifference} from './cost-presentation.mjs';
import {planHandoffImportReview} from './portable-import-review-planner.mjs';

const invalidHandoff=()=>({ok:false,error:'INVALID_HANDOFF_REQUEST',executionAuthorized:false});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(value));
const keys=(value,allowed)=>record(value)&&Object.keys(value).every(key=>allowed.includes(key));

// The HTTP caller supplies plain JSON. This is presentation, not a charge ledger,
// a receipt comparator, billing authentication or evidence of router savings.
export function presentSubmittedCost(data) {
  const presentation=describeCostDifference(data);
  return {ok:presentation.reasonCode!=='INVALID_INPUT',formatVersion:1,
    scope:'caller-supplied-cost-presentation',executionAuthorized:false,
    billingAuthenticated:false,presentation};
}

// Decode only inline bytes. No filesystem paths, URLs, remote fetches, persisted
// imports, task creation or caller-provided destination context are accepted.
export function reviewSubmittedHandoff(data,existingTaskIds=[]) {
  try {
    if(!keys(data,['manifest','artifacts'])||!Object.hasOwn(data,'manifest')||
      (Object.hasOwn(data,'artifacts')&&(!Array.isArray(data.artifacts)||data.artifacts.length>32)))
      return invalidHandoff();
    let totalBytes=0;
    const artifacts=[];
    for(const item of data.artifacts??[]) {
      if(!keys(item,['artifactId','bytesBase64','claimedDigest','byteLength']))return invalidHandoff();
      const supplied={artifactId:item.artifactId};
      if(Object.hasOwn(item,'claimedDigest'))supplied.claimedDigest=item.claimedDigest;
      if(Object.hasOwn(item,'byteLength'))supplied.byteLength=item.byteLength;
      if(Object.hasOwn(item,'bytesBase64')) {
        const value=item.bytesBase64;
        if(typeof value!=='string'||value.length>43692||value.length%4!==0||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))return invalidHandoff();
        const decoded=Buffer.from(value,'base64');
        if(decoded.toString('base64')!==value)return invalidHandoff();
        totalBytes+=decoded.length;
        if(totalBytes>32768)return invalidHandoff();
        supplied.bytes=new Uint8Array(decoded);
      }
      artifacts.push(supplied);
    }
    const result=planHandoffImportReview(data.manifest,{artifacts,existingTaskIds,existingManifestIds:[]});
    return {...result,formatVersion:1,executionAuthorized:false,persisted:false,
      destinationConflictCheck:'current-workspace-task-ids-only',
      manifestHistoryChecked:false};
  } catch {return invalidHandoff();}
}
