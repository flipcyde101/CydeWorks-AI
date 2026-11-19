const reported=new Set(['provider reported','OpenCode reported']);
const validDuration=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const validCount=value=>Number.isSafeInteger(value)&&value>=0;
const fields=['input','output','cached','cacheWrite','reasoning'];
const hasNumericUsage=attempt=>reported.has(attempt.usage?.evidence)&&fields.some(field=>validCount(attempt.usage[field]));
const outcomeUnknown=attempt=>attempt.recovery?.state==='unresolved' ||
  (attempt.status==='interrupted' && attempt.recovery?.state!=='retry-safe') ||
  (['failed','cancelled'].includes(attempt.status) && attempt.provider!=='fixture' &&
    !['claimed','settled'].includes(attempt.execution?.phase) && attempt.recovery?.state!=='retry-safe');

function tokenCounter(attempts,field) {
  let value=0, count=0, partial=0, overflow=false;
  for (const attempt of attempts) {
    const usage=attempt.usage;
    if (!reported.has(usage?.evidence) || !validCount(usage[field])) continue;
    count++;
    if (usage.evidence==='OpenCode reported') partial++;
    if (!Number.isSafeInteger(value+usage[field])) overflow=true;
    else if (!overflow) value+=usage[field];
  }
  return {value:count&&!overflow?value:null,reported:count,partial,attempts:attempts.length,...(overflow?{overflow:true}:{})};
}

export function summarizeUsage(attempts) {
  const ended=attempts.filter(attempt=>attempt.status!=='running');
  const unresolved=ended.filter(outcomeUnknown);
  const finished=ended.filter(attempt=>!outcomeUnknown(attempt));
  const timed=ended.filter(attempt=>validDuration(attempt.elapsedMs));
  const withReceipt=attempts.filter(attempt=>reported.has(attempt.usage?.evidence));
  const byEvidence=evidence=>{
    const selected=attempts.filter(attempt=>attempt.usage?.evidence===evidence);
    return {attempts:selected.length,counters:Object.fromEntries(fields.map(field=>[field,tokenCounter(selected,field)]))};
  };
  return {attempts:attempts.length,finished:finished.length,unresolved:unresolved.length,
    active:attempts.length-ended.length,timed:timed.length,ended:ended.length,
    totalElapsedMs:timed.length?timed.reduce((sum,attempt)=>sum+attempt.elapsedMs,0):null,
    observed:withReceipt.length,reported:attempts.filter(hasNumericUsage).length,missing:ended.filter(attempt=>!hasNumericUsage(attempt)).length,
    pending:attempts.filter(attempt=>attempt.status==='running').length,
    groups:{provider:byEvidence('provider reported'),opencode:byEvidence('OpenCode reported')}};
}

export function describeStepReceipt(usage) {
  const receipt=usage?.evidence==='OpenCode reported'?usage.steps:null;
  if(!Array.isArray(receipt?.items)||!receipt.items.length)return null;
  const notes=['These are observed OpenCode events. Missing events and later provider activity may not be included.'];
  if(receipt.duplicates)notes.push(receipt.duplicates+' repeated event(s) were ignored.');
  if(receipt.unidentified)notes.push('Some step events had no usable identity.');
  if(receipt.identityAmbiguous)notes.push('The events cannot be established as one unique set, so step totals are unavailable.');
  if(receipt.conflict)notes.push('A repeated step disagreed with the earlier event, so step totals are unavailable.');
  if(receipt.truncated)notes.push('The receipt reached its 64-step limit, so step totals are unavailable.');
  return {notes,items:receipt.items.map(item=>Object.fromEntries(
    fields.map(field=>[field,validCount(item?.[field])?item[field]:null])))};
}
