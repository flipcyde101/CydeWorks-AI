import {Agent,createServer,request} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';

export async function createInferenceBroker(destination,{signal,model}={}) {
  let target;
  try {target=new URL(destination);} catch {throw Error('Invalid local model endpoint.');}
  if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||target.username||target.password||
      target.pathname!=='/'||target.search||target.hash)
    throw Error('Invalid local model endpoint.');
  if(typeof model!=='string'||!model||model.length>100||/[\u0000-\u001f\u007f]/.test(model))
    throw Error('Invalid approved model.');
  signal?.throwIfAborted();
  const token=randomBytes(32).toString('hex');
  const expected=Buffer.from(token);
  const agent=new Agent({keepAlive:false,proxyEnv:{}});
  const server=createServer((incoming,outgoing)=>{
    if(incoming.method!=='POST'||incoming.url!=='/v1/chat/completions') {
      incoming.resume();outgoing.writeHead(404);outgoing.end();return;
    }
    const supplied=incoming.headers['x-cydeworks-local'];
    if(incoming.headers.host!=='127.0.0.1:'+server.address().port||typeof supplied!=='string'||
        !/^[a-f0-9]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied),expected)) {
      incoming.resume();outgoing.writeHead(403);outgoing.end();return;
    }
    const chunks=[];
    let bytes=0,tooLarge=false;
    incoming.on('data',chunk=>{
      bytes+=chunk.length;
      if(bytes>2000000)tooLarge=true;
      else chunks.push(chunk);
    });
    incoming.on('end',()=>{
      if(tooLarge){outgoing.writeHead(413);outgoing.end();return;}
      if(outgoing.destroyed)return;
      const body=Buffer.concat(chunks,bytes);
      let parsed;
      try {parsed=JSON.parse(body.toString('utf8'));} catch {outgoing.writeHead(400);outgoing.end();return;}
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||parsed.model!==model) {
        outgoing.writeHead(403);outgoing.end();return;
      }
      const upstream=request({hostname:'127.0.0.1',port:Number(target.port||'80'),path:'/v1/chat/completions',
        method:'POST',agent,headers:{'Content-Type':'application/json','Accept':incoming.headers.accept??'application/json'}},response=>{
        if(response.statusCode>=300&&response.statusCode<400) {
          response.destroy();outgoing.writeHead(502);outgoing.end();return;
        }
        const headers={};
        if(response.headers['content-type'])headers['Content-Type']=response.headers['content-type'];
        outgoing.writeHead(response.statusCode,headers);
        let responseBytes=0;
        response.on('data',chunk=>{
          responseBytes+=chunk.length;
          if(responseBytes>2000000){response.destroy();outgoing.destroy();}
        });
        response.on('error',()=>outgoing.destroy());
        response.pipe(outgoing);
      });
      const failed=()=>{if(!outgoing.headersSent){outgoing.writeHead(502);outgoing.end();}else outgoing.destroy();};
      upstream.once('error',failed);
      upstream.once('upgrade',(_response,socket)=>{socket.destroy();failed();});
      outgoing.once('close',()=>{if(!outgoing.writableFinished)upstream.destroy();});
      upstream.end(body);
    });
    incoming.on('error',()=>outgoing.destroy());
  });
  await new Promise((resolveListen,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolveListen();});
  });
  let closed;
  const close=()=>{
    if(closed)return closed;
    signal?.removeEventListener('abort',abort);
    agent.destroy();
    server.closeAllConnections();
    closed=new Promise(resolveClose=>server.close(()=>resolveClose()));
    return closed;
  };
  const abort=()=>{void close();};
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted){await close();signal.throwIfAborted();}
  return {endpoint:'http://127.0.0.1:'+server.address().port,token,close};
}
