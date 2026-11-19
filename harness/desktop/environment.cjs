function desktopChildEnvironment(source,temporary) {
  const env=Object.fromEntries(['PATH','PATHEXT','SystemRoot','WINDIR','ComSpec','LANG','LC_ALL','BFE_OLLAMA_PORT']
    .filter(key=>source[key]).map(key=>[key,source[key]]));
  if(typeof source.BFE_OPENCODE_EXECUTABLE==='string')env.BFE_OPENCODE_EXECUTABLE=source.BFE_OPENCODE_EXECUTABLE;
  if(typeof source.BFE_LLAMACPP_PORT==='string')env.BFE_LLAMACPP_PORT=source.BFE_LLAMACPP_PORT;
  return Object.assign(env,{TEMP:temporary,TMP:temporary});
}

module.exports={desktopChildEnvironment};
