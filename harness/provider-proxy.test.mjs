import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {connect} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('local model inventory and synthetic prompts bypass an enabled environment proxy', {timeout:20000},async t=>{
  const marker='SYNTHETIC_PROMPT_ONLY';
  const paths=[];let proxyRequests=0,proxySawPrompt=false,targetSawPrompt=false;
  const sockets=new Set();
  const track=socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));};
  const target=createServer((req,res)=>{
    const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
      paths.push(req.url);
      if(Buffer.concat(chunks).toString().includes(marker))targetSawPrompt=true;
      res.setHeader('content-type','application/json');
      if(req.url==='/api/tags')return res.end(JSON.stringify({models:[{name:'qwen3:1.7b',digest:'a'.repeat(64),size:100}]}));
      if(req.url==='/api/status')return res.end(JSON.stringify({cloud:{disabled:true}}));
      if(req.url==='/api/chat')return res.end(JSON.stringify({message:{content:JSON.stringify({summary:'Synthetic',content:'Revised'})},done:true})+'\n');
      res.writeHead(404);res.end();
    });
  });
  const proxy=createServer((req,res)=>{
    proxyRequests++;
    const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
      const body=Buffer.concat(chunks);if(body.toString().includes(marker))proxySawPrompt=true;
      const path=new URL(req.url,'http://127.0.0.1').pathname;
      const upstream=httpRequest({hostname:'127.0.0.1',port:target.address().port,path,method:req.method,headers:req.headers,agent:false},reply=>{
        res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);
      });
      upstream.on('error',()=>{res.writeHead(502);res.end();});upstream.end(body);
    });
  });
  proxy.on('connect',(req,client,head)=>{
    proxyRequests++;track(client);
    if(req.url!=='127.0.0.1:'+target.address().port){client.destroy();return;}
    const upstream=connect(target.address().port,'127.0.0.1');track(upstream);
    let observed='';client.on('data',chunk=>{observed=(observed+chunk.toString()).slice(-65536);if(observed.includes(marker))proxySawPrompt=true;});
    upstream.on('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
    upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());
  });
  for(const server of [target,proxy]){server.on('connection',track);server.listen(0,'127.0.0.1');}
  await Promise.all([once(target,'listening'),once(proxy,'listening')]);
  t.after(async()=>{for(const socket of sockets)socket.destroy();for(const server of [proxy,target])await new Promise(resolve=>server.close(resolve));});
  const code=`import {ollama} from './providers.mjs';
    const models=await ollama.models();
    const result=await ollama.run({kind:'change',model:models[0].id,request:'${marker}',source:'Original'},
      {signal:AbortSignal.timeout(8000),progress:()=>{}});
    if(result.artifact?.content!=='Revised')process.exitCode=2;`;
  const proxyUrl='http://127.0.0.1:'+proxy.address().port;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:new URL('.',import.meta.url),windowsHide:true,
    env:{...process.env,NODE_OPTIONS:'',NODE_USE_ENV_PROXY:'1',HTTP_PROXY:proxyUrl,http_proxy:proxyUrl,
      HTTPS_PROXY:proxyUrl,https_proxy:proxyUrl,NO_PROXY:'',no_proxy:'',BFE_OLLAMA_PORT:String(target.address().port)},
    stdio:['ignore','pipe','pipe']});
  child.stdout.resume();child.stderr.resume();
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();});
  const [exitCode]=await once(child,'exit');
  assert.equal(exitCode,0,'the model adapter should complete against the mock server');
  assert.equal(targetSawPrompt,true,'the target must receive the synthetic prompt');
  assert.deepEqual(paths.sort(),['/api/chat','/api/status','/api/tags']);
  assert.equal(proxySawPrompt,false,'the environment proxy must not see the synthetic prompt');
  assert.equal(proxyRequests,0,'loopback requests must not pass through the environment proxy');
});
