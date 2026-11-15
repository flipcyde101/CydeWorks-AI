export function buildReadiness(ollamaResult,opencodeResult) {
  const inspection=ollamaResult?.status==='fulfilled'&&Array.isArray(ollamaResult.value?.models)
    ?ollamaResult.value:null;
  const reported=inspection?.cloudDisabled;
  const cloud=reported===true?'disabled':reported===false?'enabled':'unknown';
  const opencode=opencodeResult?.status==='fulfilled'&&['present','missing','unknown'].includes(opencodeResult.value)
    ?opencodeResult.value:'unknown';
  const report={ollama:{status:inspection?'available':'unavailable',cloud,modelCount:inspection?inspection.models.length:null},
    opencode:{status:opencode},messages:[]};
  const add=(code,text)=>report.messages.push({code,text});
  if(!inspection)add('ollama_unavailable','Could not read the Ollama model inventory. Check the local service and refresh routes.');
  else {
    if(!inspection.models.length)add('no_models','Ollama responded but reported no usable model names.');
    if(cloud==='enabled')add('cloud_enabled','Ollama reports cloud features enabled. Real model routes are held.');
    if(cloud==='unknown')add('cloud_unknown','Ollama cloud status is unavailable. Real model routes are held.');
  }
  if(opencode==='missing')add('opencode_missing','The configured OpenCode executable was not found. The direct Ollama route is separate.');
  if(opencode==='unknown')add('opencode_unknown','The configured OpenCode executable could not be checked.');
  return report;
}
