const port=process.env.BFE_OLLAMA_PORT??'11434';
if(!/^\d{1,5}$/.test(port)||Number(port)<1||Number(port)>65535)throw Error('Invalid synthetic Ollama port.');
const base='http://127.0.0.1:'+Number(port);
globalThis.fetch=async(input,options={})=>{
  const url=typeof input==='string'?input:input.url;
  if(url===base+'/api/tags')return Response.json({models:[{
    name:'qwen3:1.7b',size:1,digest:'a'.repeat(64),
    ...(process.env.BFE_MOCK_REMOTE==='1'?{remote_host:'https://example.invalid'}:{}),
  }]});
  if(url===base+'/api/status')return Response.json({cloud:{disabled:process.env.BFE_MOCK_CLOUD==='disabled'}});
  if(url===base+'/api/chat') {
    if(process.send&&process.connected)process.send({type:'synthetic-chat-call'});
    return new Response(JSON.stringify({done:true,done_reason:'stop',prompt_eval_count:4,eval_count:3,
      message:{content:'{"summary":"Synthetic replacement","content":"Revised example"}'}}));
  }
  throw Error('Unexpected synthetic HTTP target.');
};
