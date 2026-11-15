import {Agent,get} from 'node:http';

export function directJson(port,path) {
  if(!Number.isInteger(port)||port<1||port>65535||!['/api/status','/api/tags','/api/ps'].includes(path))
    throw Error('Invalid test endpoint.');
  return new Promise((resolveJson,rejectJson)=>{
    let done=false,request;
    const agent=new Agent({keepAlive:false,proxyEnv:{}});
    const timer=setTimeout(()=>finish(Error('The test service response timed out.')),3000);
    function finish(error,value) {
      if(done)return;
      done=true;clearTimeout(timer);
      if(error)request?.destroy();
      agent.destroy();
      if(error)rejectJson(error);else resolveJson(value);
    }
    request=get({hostname:'127.0.0.1',port,path,agent},response=>{
      if(response.statusCode!==200){response.resume();finish(Error('The test service returned an unsuccessful response.'));return;}
      let size=0;const chunks=[];
      response.on('data',chunk=>{
        size+=chunk.length;
        if(size>32000){finish(Error('The test service response exceeded the size limit.'));return;}
        chunks.push(chunk);
      });
      response.on('error',()=>finish(Error('The test service response failed.')));
      response.on('end',()=>{
        try {finish(null,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size))));}
        catch {finish(Error('The test service returned invalid data.'));}
      });
    });
    request.on('error',()=>finish(Error('The test service is not reachable.')));
  });
}
