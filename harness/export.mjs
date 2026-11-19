import {sanitizeOpenCodeUsage} from './opencode-usage.mjs';

const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const duration=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const provider=value=>['fixture','ollama','opencode'].includes(value)?value:'other';
const evidence=value=>['synthetic','provider reported','OpenCode reported'].includes(value)?value:'unavailable';
const status=value=>['draft','running','review','accepted','rejected','failed','cancelled','interrupted'].includes(value)?value:'unknown';

function minimalAttempt(attempt) {
  const recorded=attempt.usage;
  const safeOpenCode=sanitizeOpenCodeUsage(recorded);
  const usage=safeOpenCode ?? (recorded?.evidence==='OpenCode reported' && recorded.steps
    ? {evidence:'OpenCode reported'} : recorded);
  return {
    provider:provider(attempt.provider),status:status(attempt.status),elapsedMs:duration(attempt.elapsedMs),
    usage:{evidence:evidence(usage?.evidence),semantics:usage?.evidence==='OpenCode reported'?'opencode-engine-defined'
      :usage?.evidence==='provider reported'?'provider-defined':'unavailable',input:count(usage?.input),
      output:count(usage?.output),cached:count(usage?.cached),cacheWrite:count(usage?.cacheWrite),reasoning:count(usage?.reasoning),
      generationMs:duration(usage?.generationMs),loadMs:duration(usage?.loadMs),promptMs:duration(usage?.promptMs),
      ...(safeOpenCode?.steps?{steps:safeOpenCode.steps}:{})},
  };
}

export function exportTask(task,mode='minimal') {
  if (mode==='standard') {
    const {source,request,expected,attempts,...meta}=task;
    return {schema:1,mode,task:{...meta,attempts:attempts.map(({artifact,originalArtifact,submission,checks,...attempt})=>({...attempt,checks}))}};
  }
  if (mode!=='minimal') throw Object.assign(Error('Choose a supported export mode.'),{status:400});
  return {schema:2,mode,task:{
    kind:['brief','change'].includes(task.kind)?task.kind:'other',status:status(task.status),
    attempts:task.attempts.map(minimalAttempt),
  }};
}
