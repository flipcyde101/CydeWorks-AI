function pastTime(value,now) {
  if (typeof value!=='string') return null;
  const time=Date.parse(value);
  return Number.isFinite(time)&&time<=now?time:null;
}

export function describeProgress(task,attempt,now=Date.now()) {
  const started=pastTime(attempt?.started,now);
  const dispatched=pastTime(attempt?.execution?.dispatchedAt,now);
  const last=pastTime(task.live?.lastActivity,now);
  const heartbeat=pastTime(task.live?.heartbeat,now);
  const chars=Number.isSafeInteger(task.live?.chars)&&task.live.chars>=0?task.live.chars:null;
  const idle=last===null?null:now-last;
  let status='Waiting for run state', explanation='Waiting for a current status from the local workspace.';
  if (task.live?.stopping) {
    status='Stop requested';
    explanation='Waiting for the local request to end. Provider termination is not yet confirmed.';
  } else if (task.live && attempt?.execution?.phase==='claimed') {
    status='Checking selected route';
    explanation='The request has not yet been dispatched.';
  } else if (task.live && idle!==null && idle>=60000) {
    status='Possibly stalled';
    explanation='No new model output for at least 60 seconds. The model may still be working.';
  } else if (task.live && (chars===0 || (idle!==null && idle>=15000))) {
    status='Waiting for model output';
    explanation='The model may be loading, processing context or generating.';
  } else if (task.live && chars>0) {
    status='Receiving output';
    explanation='Output is arriving. The total output length is not known.';
  }
  return {status,explanation,elapsedMs:started===null?null:now-started,
    chars,rate:chars!==null&&chars>0&&dispatched!==null&&now>dispatched ? chars*1000/(now-dispatched) : null,
    heartbeat,lastActivity:last,
    remaining:task.live?.stopping?'Confirm local termination and review recovery status.'
      :attempt?.provider==='fixture'?'Complete the synthetic result, validate it and review the proposal.'
      :'Finish generation, validate output and review the proposal.',
    eta:'Unavailable because total work and remaining output are unknown.',
    completion:'Unavailable until a reliable remaining time can be measured.'};
}

export function progressAnnouncement(task,progress,connection) {
  if (connection!=='connected') return 'Connection interrupted. The saved task state may be stale.';
  if (task.status==='running') return progress?.status??'Waiting for run state';
  if (task.status==='review') return 'Proposal ready for review.';
  if (task.status==='interrupted' && task.attempts?.at(-1)?.recovery?.state==='retry-safe')
    return 'Previous attempt interrupted. It is safe to retry after reviewing the scope.';
  if (task.status==='interrupted' || task.recovery?.blocked) return 'Run outcome may be unknown. Review recovery status.';
  if (task.status==='failed') return 'Attempt failed. Review the problem and recovery status.';
  if (task.status==='cancelled') return 'Cancellation recorded. Review recovery status.';
  if (task.status==='accepted') return 'Proposal accepted.';
  if (task.status==='rejected') return 'Proposal rejected.';
  return '';
}
