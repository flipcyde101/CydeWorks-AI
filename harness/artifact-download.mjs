import {createHash} from 'node:crypto';
import {unifiedPatch} from './patch.mjs';

const hash=value=>createHash('sha256').update(value,'utf8').digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest=/^[a-f0-9]{64}$/;
const reject=(status,message)=>{throw Object.assign(Error(message),{status});};

// Boundary: URLSearchParams created by the authenticated HTTP handler.
export function artifactDownloadRequest(params) {
  const allowed=['version','attemptId','artifactHash','format'];
  if([...params.keys()].some(key=>!allowed.includes(key))||allowed.some(key=>params.getAll(key).length>1))
    reject(400,'Use one exact accepted-proposal download request.');
  const rawVersion=params.get('version'),version=Number(rawVersion);
  const attemptId=params.get('attemptId'),artifactHash=params.get('artifactHash'),format=params.get('format')??'content';
  if(!/^(0|[1-9][0-9]{0,15})$/.test(rawVersion??'')||!Number.isSafeInteger(version)||
      !uuid.test(attemptId??'')||!digest.test(artifactHash??'')||!['content','patch'].includes(format))
    reject(400,'Use a valid task version, attempt and accepted artifact hash.');
  return {version,attemptId,artifactHash,format};
}

// Pure preparation only. Never opens files, applies patches or mutates a task.
export function acceptedArtifactDownload(task,binding) {
  const attempt=task.attempts?.at(-1),artifact=attempt?.artifact;
  if(task.status!=='accepted'||attempt?.status!=='accepted'||binding.version!==task.version||
      binding.attemptId!==attempt?.id||binding.artifactHash!==artifact?.sha256)
    reject(409,'The accepted proposal changed or is unavailable. Refresh and review the task.');
  if(!Array.isArray(attempt.checks)||attempt.checks.length===0||attempt.checks.some(check=>check?.pass!==true)||
      typeof artifact?.content!=='string'||!artifact.content.trim()||artifact.content.length>12000||
      hash(artifact.content)!==artifact.sha256)
    reject(409,'The accepted proposal record cannot be verified. Review the task before downloading.');
  if(!['change','brief'].includes(task.kind))reject(409,'The accepted workflow is unavailable.');
  let content=artifact.content,filename='brief.md';
  if(task.kind==='change') {
    if(typeof task.filename!=='string'||task.filename.length>100||
        !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(task.filename)||task.filename.endsWith('.'))
      reject(409,'The accepted file name is invalid.');
    filename='proposed-'+task.filename;
  }
  if(binding.format==='patch') {
    if(task.kind!=='change')reject(400,'Patch download is available only for file changes.');
    if(typeof task.source!=='string'||task.source.length>5000||hash(task.source)!==task.sourceHash)
      reject(409,'The source snapshot cannot be verified for this patch.');
    content=unifiedPatch(task.filename,task.source,artifact.content);
    filename='proposal.patch';
  } else if(binding.format!=='content')reject(400,'Choose content or patch download.');
  return {content,filename,sha256:hash(content),format:binding.format};
}
