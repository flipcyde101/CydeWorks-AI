import {createHmac,timingSafeEqual} from 'node:crypto';

const LIFETIME=300000;
const scope='workspace-record-only-v1';
const failure=message=>Object.assign(Error(message),{status:409});
const signature=(task,expiresAt,secret)=>createHmac('sha256',secret)
  .update(JSON.stringify([scope,task.id,task.version,expiresAt])).digest('hex');

function holdReason(task,active) {
  if(active||['running','cancelling'].includes(task.status))return 'The task is still active. Stop it and confirm its outcome first.';
  const attempts=task.attempts??[];
  if(task.status!=='draft'&&attempts.length===0)return 'The earlier attempt record is missing. Reconcile the task before removing this record.';
  if(task.status==='interrupted'&&attempts.at(-1)?.recovery?.state!=='retry-safe')
    return 'The interrupted task has no retry-safe recovery evidence. Reconcile it before removing this record.';
  for(const attempt of attempts) {
    if(attempt.status==='running'||attempt.recovery?.state==='unresolved')
      return 'An earlier attempt is active or unresolved. Reconcile it before removing this record.';
    if(attempt.provider!=='fixture'&&!['claimed','settled'].includes(attempt.execution?.phase)&&attempt.recovery?.state!=='retry-safe')
      return 'An earlier external attempt has no recorded completion evidence. Reconcile it before removing this record.';
  }
  return null;
}

export function previewRemoval(task,{secret,now=Date.now(),active=false}) {
  const hold=holdReason(task,active);
  const preview={scope,title:task.title,allowed:!hold,reason:hold,
    removes:['The task record, including its title, request, source snapshot, proposals, checks, usage and task history, from the active workspace database.'],
    retains:['Possible OpenCode working files in the local state folder.',
      'Other tasks, the access file, backups, provider copies and a minimal pseudonymous removal audit.'],
    limitations:['Database pages, journals and backups may retain recoverable copies. This action is not secure erasure.',
      'Local removal does not delete data held by a model provider.'],version:task.version};
  if(!hold) {
    preview.expiresAt=now+LIFETIME;
    preview.token=signature(task,preview.expiresAt,secret);
  }
  return preview;
}

export function verifyRemoval(task,approval,{secret,now=Date.now(),active=false}) {
  const hold=holdReason(task,active);
  if(hold)throw failure(hold);
  if(approval?.version!==task.version)throw failure('The task changed. Review a new removal preview.');
  if(approval.confirmation!=='REMOVE')throw failure('Type REMOVE to confirm this exact removal.');
  if(!Number.isSafeInteger(approval.expiresAt)||approval.expiresAt<now||approval.expiresAt>now+LIFETIME)
    throw failure('The removal preview expired. Review a new preview.');
  if(typeof approval.token!=='string'||!/^[a-f0-9]{64}$/.test(approval.token))throw failure('The removal preview is invalid.');
  const actual=Buffer.from(approval.token,'hex'),expected=Buffer.from(signature(task,approval.expiresAt,secret),'hex');
  if(!timingSafeEqual(actual,expected))throw failure('The removal preview is invalid or belongs to an earlier session.');
  return true;
}
