'use strict';
const proofText=/^[a-f0-9]{64}$/;
const viewText=/^[a-f0-9]{32}$/;

function isClaimProof(value) {
  return typeof value==='string'&&proofText.test(value);
}
function mayAcceptLauncherClaim({senderWebContentsId,intendedWebContentsId,frameIsMain,frameOrigin,serviceOrigin,armed}={}) {
  if(armed!==true)return false;
  if(!Number.isInteger(senderWebContentsId)||!Number.isInteger(intendedWebContentsId))return false;
  if(senderWebContentsId!==intendedWebContentsId)return false;
  if(frameIsMain!==true)return false;
  if(typeof frameOrigin!=='string'||typeof serviceOrigin!=='string'||frameOrigin!==serviceOrigin)return false;
  return true;
}
function performLauncherClaim({proof,post}) {
  let pending;
  try { pending=Promise.resolve(post({proof})); }
  catch { return Promise.resolve({clear:false,body:null}); }
  return pending.then(result=>{
    const status=result?.status;
    if(status===401||status===404)return {clear:true,body:null};
    if(status!==200)return {clear:false,body:null};
    const viewId=result.body?.viewId, viewGeneration=result.body?.viewGeneration;
    if(!viewText.test(viewId)||!viewText.test(viewGeneration))return {clear:false,body:null};
    return {clear:true,body:{viewId,viewGeneration}};
  },()=>({clear:false,body:null}));
}
function createLauncherClaimGate({proof,serviceOrigin,post,intendedWebContentsId}) {
  let armedProof=isClaimProof(proof)?proof:null;
  let busy=false;
  const intended=()=>typeof intendedWebContentsId==='function'?intendedWebContentsId():intendedWebContentsId;
  return {
    disarm(){armedProof=null;},
    claim(request) {
      const accepted=mayAcceptLauncherClaim({
        senderWebContentsId:request?.senderWebContentsId,
        intendedWebContentsId:intended(),
        frameIsMain:request?.frameIsMain,
        frameOrigin:request?.frameOrigin,
        serviceOrigin,
        armed:armedProof!==null,
      });
      if(!accepted||busy)return null;
      const presented=armedProof;
      busy=true;
      return performLauncherClaim({proof:presented,post}).then(result=>{
        if(result.clear)armedProof=null;
        return result.body;
      }).finally(()=>{busy=false;});
    },
  };
}
module.exports={isClaimProof,mayAcceptLauncherClaim,performLauncherClaim,createLauncherClaimGate};
