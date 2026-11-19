import {Agent,request} from 'node:http';
import {Readable} from 'node:stream';

const routes=new Map([['/api/tags','GET'],['/api/status','GET'],['/api/chat','POST'],
  ['/health','GET'],['/v1/models','GET']]);

// A dedicated agent prevents Node's environment proxy settings from receiving
// local model requests. This is not an operating-system network sandbox.
export function directLocalFetch(address,options={}) {
  const url=new URL(address);
  const method=options.method??'GET';
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||
      routes.get(url.pathname)!==method||options.redirect!=='error') throw Error('Invalid local model destination.');
  const port=Number(url.port||80);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid local model port.');
  return new Promise((resolve,reject)=>{
    const agent=new Agent({keepAlive:false,proxyEnv:{}});
    let responseStarted=false;
    const req=request({hostname:'127.0.0.1',port,path:url.pathname,method,headers:options.headers,agent,signal:options.signal},res=>{
      responseStarted=true;
      const cleanup=()=>agent.destroy();
      res.once('end',cleanup);res.once('close',cleanup);res.once('error',cleanup);
      if(res.statusCode>=300&&res.statusCode<400) {
        res.resume();cleanup();reject(new TypeError('The local model service returned a redirect.'));return;
      }
      try {
        const empty=[204,205].includes(res.statusCode);
        if(empty)res.resume();
        resolve(new Response(empty?null:Readable.toWeb(res),{status:res.statusCode}));
      } catch(error) {res.destroy();cleanup();reject(error);}
    });
    req.once('error',error=>{
      agent.destroy();
      if(!responseStarted) {
        responseStarted=true;
        reject(options.signal?.aborted?options.signal.reason??error:new TypeError('The local model service is unavailable.'));
      }
    });
    req.once('upgrade',(_response,socket)=>{
      socket.destroy();agent.destroy();
      if(!responseStarted) {responseStarted=true;reject(new TypeError('The local model service returned an unsupported protocol upgrade.'));}
    });
    req.once('close',()=>{
      if(!responseStarted) {responseStarted=true;agent.destroy();reject(new TypeError('The local model service closed before responding.'));}
    });
    if(options.body!==undefined)req.end(options.body);else req.end();
  });
}
