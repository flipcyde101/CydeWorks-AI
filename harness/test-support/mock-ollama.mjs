import {createServer} from 'node:http';

export function createMockOllama({cloud='disabled',remote=false,inventoryFailure=false,onChat=()=>{}}={}) {
  return createServer((request,response)=>{
    response.setHeader('content-type','application/json');
    if(request.url==='/api/tags'&&inventoryFailure){response.writeHead(503);return response.end('PRIVATE_SYNTHETIC_ERROR');}
    if(request.url==='/api/tags')return response.end(JSON.stringify({models:[{
      name:'qwen3:1.7b',size:1,digest:'a'.repeat(64),
      ...(remote?{remote_host:'https://example.invalid'}:{}),
    }]}));
    if(request.url==='/api/status'&&cloud==='unknown'){response.writeHead(503);return response.end('PRIVATE_SYNTHETIC_ERROR');}
    if(request.url==='/api/status')return response.end(JSON.stringify({cloud:{disabled:cloud==='disabled'}}));
    if(request.url==='/api/chat') {
      request.resume();onChat();
      return response.end(JSON.stringify({done:true,done_reason:'stop',prompt_eval_count:4,eval_count:3,
        message:{content:'{"summary":"Synthetic replacement","content":"Revised example"}'}}));
    }
    response.writeHead(404);response.end();
  });
}
