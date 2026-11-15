const reported=new Set(['provider reported','OpenCode reported']);
const validDuration=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const validCount=value=>Number.isSafeInteger(value)&&value>=0;
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
  return {attempts:attempts.length,finished:finished.length,unresolved:unresolved.length,
    active:attempts.length-ended.length,timed:timed.length,ended:ended.length,
    totalElapsedMs:timed.length?timed.reduce((sum,attempt)=>sum+attempt.elapsedMs,0):null,
    reported:withReceipt.length,missing:ended.filter(attempt=>!reported.has(attempt.usage?.evidence)).length,
    pending:attempts.filter(attempt=>attempt.status==='running').length,
    counters:Object.fromEntries(['input','output','cached','reasoning'].map(field=>[field,tokenCounter(attempts,field)]))};
}
