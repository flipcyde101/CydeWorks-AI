import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {selectOpenCodeExecutable,openCodeAvailability,createOpenCode} from './opencode.mjs';
import {buildReadiness} from './readiness.mjs';

test('the operator can select an absolute OpenCode executable without exposing it',()=>{
  const fallback='existing-fallback';
  assert.equal(selectOpenCodeExecutable(undefined,{platform:'win32',fallback}),fallback);
  assert.equal(selectOpenCodeExecutable('C:\\Synthetic\\opencode.exe',{platform:'win32',fallback}),'C:\\Synthetic\\opencode.exe');
  assert.equal(selectOpenCodeExecutable('/opt/synthetic/opencode',{platform:'linux',fallback}),'/opt/synthetic/opencode');
  assert.equal(selectOpenCodeExecutable('/opt/link/../opencode',{platform:'linux',fallback}),'/opt/link/../opencode');
  for(const path of ['', 'opencode.exe', 'C:opencode.exe', '\\\\server\\share\\opencode.exe',
    'C:\\Synthetic\\opencode.cmd', 'C:\\Synthetic\\opencode.exe\nextra'])
    assert.equal(selectOpenCodeExecutable(path,{platform:'win32',fallback}),null);
  assert.equal(selectOpenCodeExecutable('relative/opencode',{platform:'linux',fallback}),null);
});

test('an invalid configured path is held without touching the filesystem',async()=>{
  const status=await openCodeAvailability({candidate:null,inspect:async()=>{throw Error('must not inspect');},
    probe:async()=>{throw Error('must not probe');}});
  assert.equal(status,'invalid');
  const report=buildReadiness({status:'rejected',reason:Error('PRIVATE_PATH')},{status:'fulfilled',value:status});
  assert.ok(report.messages.some(message=>message.code==='opencode_invalid'));
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_PATH/);
});

test('availability checks the exact configured executable',async()=>{
  const candidate='C:\\Synthetic\\opencode.exe';
  const checked=[];
  assert.equal(await openCodeAvailability({candidate,inspect:async value=>{checked.push(value);return {isFile:()=>true};},
    probe:async value=>checked.push(value)}),'present');
  assert.deepEqual(checked,[candidate,candidate]);
});

test('the startup environment selects the configured executable',async t=>{
  const prior=process.env.BFE_OPENCODE_EXECUTABLE;
  t.after(()=>{if(prior===undefined)delete process.env.BFE_OPENCODE_EXECUTABLE;else process.env.BFE_OPENCODE_EXECUTABLE=prior;});
  process.env.BFE_OPENCODE_EXECUTABLE=resolve('test-support',randomUUID()+'.exe');
  const configured=await import('./opencode.mjs?synthetic-config');
  assert.equal(await configured.opencode.availability(),'missing');
  process.env.BFE_OPENCODE_EXECUTABLE='relative.exe';
  const invalid=await import('./opencode.mjs?synthetic-invalid');
  assert.equal(await invalid.opencode.availability(),'invalid');
});

test('the adapter invokes the selected executable for an approved synthetic task',async()=>{
  const candidate=resolve('synthetic-opencode.exe');
  let invoked;
  const io={mkdir:async()=>{},writeFile:async()=>{}};
  const spawnProcess=(file,args,options)=>{
    invoked={file,args,options};
    const child=new EventEmitter();
    child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    setImmediate(()=>{
      child.stdout.write(JSON.stringify({type:'text',part:{text:'Synthetic result'}})+'\n');
      child.stdout.write(JSON.stringify({type:'step_finish',part:{reason:'stop'}})+'\n');
      child.stdout.end();child.stderr.end();child.emit('close',0,null);
    });
    return child;
  };
  const adapter=createOpenCode({executablePath:candidate,workspaceRoot:resolve('synthetic-work'),io,spawnProcess});
  const result=await adapter.run({kind:'change',source:'Synthetic source',request:'Revise it',model:'synthetic'},
    {signal:new AbortController().signal,progress(){},terminal(){},attemptId:'synthetic-attempt'});
  assert.equal(invoked.file,candidate);
  assert.equal(invoked.options.windowsHide,true);
  assert.equal(result.artifact.content,'Synthetic result');
});

test('an invalid configured executable cannot be run even through the adapter directly',async()=>{
  let touched=false;
  const adapter=createOpenCode({executablePath:'relative.exe',io:{mkdir:async()=>{touched=true;},writeFile:async()=>{touched=true;}},
    spawnProcess:()=>{touched=true;}});
  await assert.rejects(()=>adapter.run({},{signal:new AbortController().signal}),/absolute path/i);
  assert.equal(touched,false);
});

test('OpenCode sends a selected llama.cpp route to its configured loopback endpoint',async()=>{
  const candidate=resolve('synthetic-opencode.exe');
  let configuration,closed=false;
  const spawnProcess=(_file,_args,options)=>{
    configuration=JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
    const child=new EventEmitter();
    child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    setImmediate(()=>{
      child.stdout.write(JSON.stringify({type:'text',part:{text:'Synthetic result'}})+'\n');
      child.stdout.write(JSON.stringify({type:'step_finish',part:{reason:'stop'}})+'\n');
      child.stdout.end();child.stderr.end();child.emit('close',0,null);
    });
    return child;
  };
  const adapter=createOpenCode({executablePath:candidate,workspaceRoot:resolve('synthetic-work'),
    io:{mkdir:async()=>{},writeFile:async()=>{}},spawnProcess,
    brokerFactory:async(target,options)=>{
      assert.equal(target,'http://127.0.0.1:8080');
      assert.equal(options.model,'synthetic');
      return {endpoint:'http://127.0.0.1:45678',token:'synthetic-token',close:async()=>{closed=true;}};
    },
    llamaProvider:{endpoint:'http://127.0.0.1:8080',models:async()=>[]}});
  await adapter.run({kind:'change',backend:'llamacpp',source:'Synthetic',request:'Revise',model:'synthetic'},
    {signal:new AbortController().signal,progress(){},terminal(){},attemptId:'synthetic-attempt'});
  assert.equal(configuration.provider['harness-ollama'].options.baseURL,'http://127.0.0.1:45678/v1');
  assert.equal(configuration.provider['harness-ollama'].options.headers['x-cydeworks-local'],'synthetic-token');
  assert.equal(configuration.permission['*'],'deny');
  assert.equal(closed,true);
});
