import {createHash} from 'node:crypto';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest=/^[a-f0-9]{64}$/;
const fields=new Set(['requestId','version','sourceHash','approve','model','engine','backend','modelDigest','modelFingerprint','routeRevision']);
const invalid=()=>{throw Object.assign(Error('Use a valid, scope-bound run submission.'),{status:400});};
export const validSubmissionId=value=>typeof value==='string'&&uuid.test(value);

export function approvedRouteRevision(data) {
  if(!Object.hasOwn(data,'routeRevision'))return undefined;
  if(typeof data.routeRevision!=='string'||!digest.test(data.routeRevision))invalid();
  return data.routeRevision;
}

export function publicAttempts(attempts) {
  if(!Array.isArray(attempts))return attempts;
  return attempts.map(attempt=>{
    if(!attempt||typeof attempt!=='object'||Array.isArray(attempt))return attempt;
    const {submission,...visible}=attempt;
    return visible;
  });
}

// Boundary: parsed JSON from the authenticated API. The fingerprint records
// submission identity only. It is not permission or a model execution receipt.
export function prepareRunSubmission(taskId,data) {
  const revision=approvedRouteRevision(data);
  if(!Object.hasOwn(data,'requestId'))return null; // Legacy clients retain existing version checks.
  if(!validSubmissionId(data.requestId)||!validSubmissionId(taskId)||
      Object.keys(data).some(key=>!fields.has(key))||data.approve!==true||
      !Number.isSafeInteger(data.version)||data.version<0||
      typeof data.sourceHash!=='string'||!digest.test(data.sourceHash)||
      typeof data.model!=='string'||!data.model.trim()||data.model.length>100)invalid();
  const engine=data.engine??(data.model==='fixture'?'fixture':'ollama');
  const backend=data.backend??(engine==='fixture'?'fixture':'ollama');
  if(!['fixture','ollama','opencode'].includes(engine)||
      (engine==='fixture')!==(data.model==='fixture')||
      !['fixture','ollama','llamacpp'].includes(backend)||
      (backend==='fixture')!==(engine==='fixture')||
      (backend==='llamacpp'&&engine!=='opencode'))invalid();
  for(const field of ['modelDigest','modelFingerprint'])
    if(data[field]!=null&&(typeof data[field]!=='string'||!digest.test(data[field])))invalid();
  if(engine!=='fixture'&&!(backend==='llamacpp'?data.modelFingerprint:data.modelDigest))invalid();
  const binding=[taskId,data.version,data.sourceHash,
    data.model,engine,backend,data.modelDigest??null,data.modelFingerprint??null];
  // Keep persisted legacy fingerprints unchanged when the optional field is absent.
  if(revision!==undefined)binding.push(['routeRevision',revision]);
  const fingerprint=createHash('sha256').update(JSON.stringify(binding)).digest('hex');
  return {requestId:data.requestId,fingerprint};
}

export function findRunSubmission(task,requestId) {
  if(!validSubmissionId(requestId))invalid();
  const matches=task.attempts.filter(attempt=>attempt.submission?.requestId===requestId);
  if(matches.length>1)throw Object.assign(Error('The run submission record is ambiguous. Review this task.'),{status:409});
  return matches[0]??null;
}

export function replayRunSubmission(task,submission) {
  if(!submission)return null;
  const attempt=findRunSubmission(task,submission.requestId);
  if(!attempt)return null;
  if(attempt.submission.fingerprint!==submission.fingerprint)
    throw Object.assign(Error('This run submission ID belongs to different approved inputs. Review the task before submitting new work.'),{status:409});
  return attempt;
}

export function submissionResult(task,attempt,replayed) {
  return {requestId:attempt.submission.requestId,taskId:task.id,attemptId:attempt.id,
    attemptStatus:attempt.status,replayed,executionAuthorized:false};
}
