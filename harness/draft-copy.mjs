const settledStates=new Set(['review','accepted','rejected','failed','cancelled','interrupted']);

// Copy only reviewed input scope. A new draft cannot settle or hide an old run.
export function draftCopyHold(task,{active=false}={}) {
  if(active||['running','cancelling'].includes(task?.status))
    return 'Wait for this task to finish and confirm its outcome before copying it.';
  if(!task||!['draft',...settledStates].includes(task.status)||!Array.isArray(task.attempts))
    return 'The saved task state is incomplete. Review its records before copying it.';
  if(task.status==='draft'&&task.attempts.length)
    return 'The draft has unexpected attempt records. Review them before copying it.';
  if(task.status!=='draft'&&!task.attempts.length)
    return 'The earlier attempt record is missing. Reconcile the task before copying it.';
  for(const attempt of task.attempts) {
    if(!attempt||!settledStates.has(attempt.status)||attempt.recovery?.state==='unresolved')
      return 'An earlier attempt is active or unresolved. Reconcile it before copying this task.';
    if(!['fixture','ollama','opencode'].includes(attempt.provider))
      return 'An earlier provider outcome cannot be verified. Reconcile it before copying this task.';
    if(attempt.provider!=='fixture'&&!['claimed','settled'].includes(attempt.execution?.phase)&&
        attempt.recovery?.state!=='retry-safe')
      return 'An earlier external request has no recorded completion evidence. Reconcile it before copying this task.';
  }
  return null;
}

export function copiedDraftScope(task,options) {
  const hold=draftCopyHold(task,options);
  if(hold)throw Object.assign(Error(hold),{status:409});
  return {kind:task.kind,title:task.title.slice(0,113)+' (copy)',request:task.request,source:task.source,
    filename:task.filename,expected:task.expected};
}
