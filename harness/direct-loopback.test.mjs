import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {directJson} from './test-support/direct-loopback.mjs';

test('health client rejects oversized, malformed and unexpected responses',async t=>{
  const server=createServer((request,response)=>{
    if(request.url==='/api/status')return response.end(Buffer.from([123,34,120,34,58,34,255,34,125]));
    if(request.url==='/api/tags')return response.end('x'.repeat(32001));
    response.writeHead(503);response.end('unavailable');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const port=server.address().port;
  await assert.rejects(()=>directJson(port,'/api/status'),/invalid data/);
  await assert.rejects(()=>directJson(port,'/api/tags'),/size limit/);
  await assert.rejects(()=>directJson(port,'/api/ps'),/unsuccessful response/);
  assert.throws(()=>directJson(port,'/elsewhere'),/invalid test endpoint/i);
});

test('health client bypasses an enabled environment proxy for loopback', {timeout:10000},async t=>{
  let proxied=0;
  const proxy=createServer((_request,response)=>{proxied++;response.writeHead(500);response.end();});
  const target=createServer((_request,response)=>response.end('{"cloud":{"disabled":true}}'));
  proxy.listen(0,'127.0.0.1');target.listen(0,'127.0.0.1');
  await Promise.all([once(proxy,'listening'),once(target,'listening')]);
  t.after(async()=>{
    for(const server of [proxy,target]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  });
  const code="import {directJson} from './test-support/direct-loopback.mjs'; const result=await directJson(Number(process.env.BFE_TEST_PORT),'/api/status'); if(result.cloud.disabled!==true)process.exit(2);";
  const child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:new URL('.',import.meta.url),windowsHide:true,
    env:{...process.env,NODE_USE_ENV_PROXY:'1',HTTP_PROXY:'http://127.0.0.1:'+proxy.address().port,
      http_proxy:'http://127.0.0.1:'+proxy.address().port,NO_PROXY:'',no_proxy:'',BFE_TEST_PORT:String(target.address().port)},
    stdio:['ignore','pipe','pipe']});
  child.stdout.resume();child.stderr.resume();
  assert.equal((await once(child,'exit'))[0],0);
  assert.equal(proxied,0);
});
