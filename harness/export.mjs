const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const duration=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const provider=value=>['fixture','ollama','opencode'].includes(value)?value:'other';
const evidence=value=>['synthetic','provider reported','OpenCode reported'].includes(value)?value:'unavailable';
const status=value=>['draft','running','review','accepted','rejected','failed','cancelled','interrupted'].includes(value)?value:'unknown';

export function exportTask(task,mode='minimal') {
  if (mode==='standard') {
    const {source,request,expected,attempts,...meta}=task;
    return {schema:1,mode,task:{...meta,attempts:attempts.map(({artifact,checks,...attempt})=>({...attempt,checks}))}};
  }
  if (mode!=='minimal') throw Object.assign(Error('Choose a supported export mode.'),{status:400});
  return {schema:2,mode,task:{
    kind:['brief','change'].includes(task.kind)?task.kind:'other',status:status(task.status),
    attempts:task.attempts.map(attempt=>({
      provider:provider(attempt.provider),status:status(attempt.status),elapsedMs:duration(attempt.elapsedMs),
      usage:{evidence:evidence(attempt.usage?.evidence),input:count(attempt.usage?.input),
        output:count(attempt.usage?.output),cached:count(attempt.usage?.cached),
        reasoning:count(attempt.usage?.reasoning),generationMs:duration(attempt.usage?.generationMs),
        loadMs:duration(attempt.usage?.loadMs),promptMs:duration(attempt.usage?.promptMs)},
    })),
  }};
}
