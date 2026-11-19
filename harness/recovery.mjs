import {sanitizeOpenCodeUsage} from './opencode-usage.mjs';

// An uncertain external run must never become retryable merely because the
// local service restarted or its connection closed.
export function retryHold(task) {
  const attempt=task.attempts?.at(-1);
  if (!['interrupted','failed','cancelled'].includes(task.status)) return null;
  if (!attempt) return task.status==='interrupted'
    ? 'The earlier run has no recoverable attempt record. A retry is held until its outcome is reconciled.' : null;
  if (attempt.recovery?.state==='unresolved') return attempt.recovery.message;
  if (attempt.provider!=='fixture' && ['failed','cancelled'].includes(task.status) &&
      !['claimed','settled'].includes(attempt.execution?.phase) && attempt.recovery?.state!=='retry-safe') {
    return 'This earlier attempt has no recorded completion evidence. A retry is held until its outcome is reconciled.';
  }
  if (task.status==='interrupted' && attempt.recovery?.state!=='retry-safe') {
    return 'The previous run outcome is unknown. A retry is held until the earlier request is reconciled.';
  }
  return null;
}

export function recordInterruption(task, at) {
  if (task.status!=='running') return false;
  const attempt=task.attempts?.at(-1);
  if (!attempt) {
    task.status='interrupted';
    return true;
  }
  const notDispatched=attempt.execution?.phase==='claimed';
  const localFixture=attempt.provider==='fixture';
  const safe=notDispatched || localFixture;
  attempt.recovery={state:safe?'retry-safe':'unresolved',at,
    evidence:notDispatched?'dispatch-not-started':localFixture?'in-process-fixture-stopped':'no-terminal-evidence',
    message:safe
      ? 'The previous attempt stopped before an external request could remain active. You may review the scope and retry.'
      : 'The earlier provider request may still be active. A retry is held until its outcome is reconciled.'};
  attempt.status='interrupted';
  attempt.ended=at;
  attempt.problem=attempt.recovery.message;
  task.status='interrupted';
  return true;
}

export function recordOutcomeUncertainty(attempt,at) {
  if (attempt.execution?.phase!=='dispatching' || attempt.provider==='fixture') return;
  attempt.recovery={state:'unresolved',at,evidence:'no-terminal-evidence',
    message:'The provider did not confirm that the earlier request settled. A retry is held until its outcome is reconciled.'};
}

export function recordObservedUsage(attempt,error) {
  if (attempt.provider!=='opencode') return false;
  const usage=sanitizeOpenCodeUsage(error?.partialUsage);
  if(!usage)return false;
  attempt.usage=usage;
  return true;
}
