import {retryHold} from './recovery.mjs';

export function attentionFor(task) {
  const reasons=[];
  if(task.status==='draft')reasons.push('Approval needed');
  if(task.status==='review') {
    reasons.push('Proposal needs review');
    if(task.attempts?.at(-1)?.checks?.some(check=>!check.pass))reasons.push('A check failed');
  }
  if(task.status==='failed')reasons.push('Run failed');
  if(task.status==='interrupted')reasons.push('Run interrupted');
  if(retryHold(task))reasons.push('Earlier outcome needs recovery');
  return reasons.length?{id:task.id,title:task.title,status:task.status,reasons}:null;
}
