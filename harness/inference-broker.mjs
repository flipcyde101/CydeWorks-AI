import {Agent,createServer,request} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';

const MAX_BODY_BYTES=2000000;
const MAX_SSE_LINE_BYTES=262144;
const MAX_SSE_EVENT_LINES=256;
const MAX_RECORDS=64;
const MAX_FINISH_REASONS=8;
const TERMINAL_FINISH_REASONS=new Set(['stop','length','tool_calls']);

function deepFreeze(value) {
  if(!value||typeof value!=='object')return value;
  for(const child of Array.isArray(value)?value:Object.values(value))deepFreeze(child);
  return Object.freeze(value);
}

function mediaTypeOf(header) {
  if(typeof header!=='string')return '';
  return header.split(';',1)[0].trim().toLowerCase();
}

function normalizeFinishReason(value) {
  return typeof value==='string'&&TERMINAL_FINISH_REASONS.has(value)?value:null;
}

function evaluateJsonCompletion(buffer) {
  let text;
  try {text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}
  catch {return {settled:false,evidence:'ambiguous-response',finishReasons:[]};}
  let parsed;
  try {parsed=JSON.parse(text);}
  catch {return {settled:false,evidence:'ambiguous-response',finishReasons:[]};}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))
    return {settled:false,evidence:'ambiguous-response',finishReasons:[]};
  if(parsed.error!==undefined&&parsed.error!==null)
    return {settled:false,evidence:'upstream-error',finishReasons:[]};
  if(parsed.object!==undefined&&parsed.object!=='chat.completion')
    return {settled:false,evidence:'ambiguous-response',finishReasons:[]};
  if(parsed.model!==undefined&&(typeof parsed.model!=='string'||!parsed.model))
    return {settled:false,evidence:'ambiguous-response',finishReasons:[]};
  if(!Array.isArray(parsed.choices)||parsed.choices.length===0)
    return {settled:false,evidence:'ambiguous-response',finishReasons:[]};
  const reasons=[];
  for(const choice of parsed.choices) {
    if(!choice||typeof choice!=='object'||Array.isArray(choice))
      return {settled:false,evidence:'ambiguous-response',finishReasons:[]};
    const reason=normalizeFinishReason(choice.finish_reason);
    if(!reason)return {settled:false,evidence:'ambiguous-response',finishReasons:[]};
    if(!reasons.includes(reason)&&reasons.length<MAX_FINISH_REASONS)reasons.push(reason);
  }
  return {settled:true,evidence:'json-finish-reason',finishReasons:reasons};
}

function createSseTracker() {
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let lineBuffer='';
  let eventType='';
  let eventDataLines=[];
  let sawDone=false;
  let sawTerminalFinishReason=false;
  let sawError=false;
  let sawMalformed=false;
  let truncated=false;
  const finishReasons=[];

  const dispatchEvent=()=>{
    if(eventDataLines.length===0){eventType='';return;}
    const payload=eventDataLines.join('\n');
    eventDataLines=[];
    const currentType=eventType;
    eventType='';
    if(currentType==='error'){sawError=true;return;}
    if(sawDone){sawMalformed=true;return;}
    if(payload==='[DONE]'){sawDone=true;return;}
    let parsed;
    try {parsed=JSON.parse(payload);}
    catch {sawMalformed=true;return;}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)){sawMalformed=true;return;}
    if(parsed.error!==undefined&&parsed.error!==null){sawError=true;return;}
    if(parsed.object!==undefined&&parsed.object!=='chat.completion.chunk'&&parsed.object!=='chat.completion') {
      sawMalformed=true;return;
    }
    if(Array.isArray(parsed.choices)) {
      for(const choice of parsed.choices) {
        if(!choice||typeof choice!=='object'||Array.isArray(choice)){sawMalformed=true;return;}
        if(choice.finish_reason!==undefined&&choice.finish_reason!==null) {
          const reason=normalizeFinishReason(choice.finish_reason);
          if(!reason){sawMalformed=true;return;}
          sawTerminalFinishReason=true;
          if(!finishReasons.includes(reason)&&finishReasons.length<MAX_FINISH_REASONS)finishReasons.push(reason);
        }
      }
    }
  };

  const processLine=rawLine=>{
    const line=rawLine.endsWith('\r')?rawLine.slice(0,-1):rawLine;
    if(Buffer.byteLength(line)>MAX_SSE_LINE_BYTES){truncated=true;return;}
    if(line===''){dispatchEvent();return;}
    if(line.startsWith(':'))return;
    const colon=line.indexOf(':');
    const field=colon===-1?line:line.slice(0,colon);
    let value=colon===-1?'':line.slice(colon+1);
    if(value.startsWith(' '))value=value.slice(1);
    if(field==='event')eventType=value;
    else if(field==='data') {
      if(eventDataLines.length>=MAX_SSE_EVENT_LINES){truncated=true;return;}
      eventDataLines.push(value);
    }
  };

  return {
    push(chunk) {
      if(truncated)return;
      let text;
      try {text=decoder.decode(chunk,{stream:true});}
      catch {sawMalformed=true;return;}
      lineBuffer+=text;
      let start=0;
      for(let idx=lineBuffer.indexOf('\n',start);idx!==-1;idx=lineBuffer.indexOf('\n',start)) {
        processLine(lineBuffer.slice(start,idx));
        start=idx+1;
        if(truncated){lineBuffer='';return;}
      }
      lineBuffer=lineBuffer.slice(start);
      if(Buffer.byteLength(lineBuffer)>MAX_SSE_LINE_BYTES){truncated=true;lineBuffer='';}
    },
    finish(complete) {
      try {
        const tail=decoder.decode();
        if(tail)lineBuffer+=tail;
      } catch {sawMalformed=true;}
      const hadDangling=lineBuffer.length>0||eventDataLines.length>0;
      lineBuffer='';
      eventDataLines=[];
      const settled=complete&&!truncated&&!sawError&&!sawMalformed&&!hadDangling&&sawTerminalFinishReason&&sawDone;
      const evidence=settled?'sse-finish-reason-and-done'
        :truncated?'response-truncated'
        :!complete?'upstream-incomplete-stream'
        :sawError?'upstream-error'
        :'ambiguous-response';
      return {settled,evidence,finishReasons:[...finishReasons],sawDone};
    },
  };
}

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
  let dispatched=0;
  let completedCount=0;
  let unknownCount=0;
  let rejectedBeforeDispatch=0;
  let recordsTruncated=false;
  let lastUnknownEvidence=null;
  let isClosed=false;
  const records=[];
  const activeEntries=new Set();

  const settleEntry=(entry,nextState,evidence,extra={})=>{
    if(entry.state!=='in-flight')return;
    entry.state=nextState;
    entry.evidence=evidence;
    if(extra.statusCode!==undefined)entry.statusCode=extra.statusCode;
    if(extra.format!==undefined)entry.format=extra.format;
    if(extra.finishReasons!==undefined)entry.finishReasons=extra.finishReasons;
    if(extra.sawDone!==undefined)entry.sawDone=extra.sawDone;
    if(extra.responseComplete!==undefined)entry.responseComplete=extra.responseComplete;
    if(extra.responseBytes!==undefined)entry.responseBytes=extra.responseBytes;
    activeEntries.delete(entry);
    if(nextState==='settled')completedCount++;
    else {
      unknownCount++;
      lastUnknownEvidence=evidence;
    }
  };

  const server=createServer((incoming,outgoing)=>{
    if(incoming.method!=='POST'||incoming.url!=='/v1/chat/completions') {
      rejectedBeforeDispatch++;
      incoming.resume();outgoing.writeHead(404);outgoing.end();return;
    }
    const supplied=incoming.headers['x-cydeworks-local'];
    if(incoming.headers.host!=='127.0.0.1:'+server.address().port||typeof supplied!=='string'||
        !/^[a-f0-9]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied),expected)) {
      rejectedBeforeDispatch++;
      incoming.resume();outgoing.writeHead(403);outgoing.end();return;
    }
    const chunks=[];
    let bytes=0,tooLarge=false,handled=false;
    incoming.on('data',chunk=>{
      bytes+=chunk.length;
      if(bytes>MAX_BODY_BYTES)tooLarge=true;
      else chunks.push(chunk);
    });
    incoming.on('end',()=>{
      handled=true;
      if(tooLarge){rejectedBeforeDispatch++;outgoing.writeHead(413);outgoing.end();return;}
      if(!incoming.complete||outgoing.destroyed||isClosed){
        rejectedBeforeDispatch++;outgoing.destroy();return;
      }
      const body=Buffer.concat(chunks,bytes);
      let parsed;
      try {parsed=JSON.parse(body.toString('utf8'));}
      catch {rejectedBeforeDispatch++;outgoing.writeHead(400);outgoing.end();return;}
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||parsed.model!==model) {
        rejectedBeforeDispatch++;outgoing.writeHead(403);outgoing.end();return;
      }
      dispatched++;
      const entry={
        sequence:dispatched,
        state:'in-flight',
        evidence:'awaiting-response',
        statusCode:null,
        format:null,
        finishReasons:[],
        sawDone:false,
        responseComplete:false,
        responseBytes:0,
      };
      if(records.length<MAX_RECORDS)records.push(entry);
      else recordsTruncated=true;
      activeEntries.add(entry);

      const upstream=request({hostname:'127.0.0.1',port:Number(target.port||'80'),path:'/v1/chat/completions',
        method:'POST',agent,headers:{'Content-Type':'application/json','Accept':incoming.headers.accept??'application/json'}},response=>{
        entry.statusCode=response.statusCode??null;
        if(response.statusCode>=300&&response.statusCode<400) {
          settleEntry(entry,'unknown','upstream-redirect-blocked',{statusCode:response.statusCode});
          response.destroy();outgoing.writeHead(502);outgoing.end();return;
        }
        const headers={};
        if(response.headers['content-type'])headers['Content-Type']=response.headers['content-type'];
        const mediaType=mediaTypeOf(response.headers['content-type']);
        const okStatus=response.statusCode===200;
        const format=mediaType==='text/event-stream'?'sse'
          :(mediaType==='application/json'||mediaType==='')?'json':'other';
        entry.format=format;
        const sseTracker=okStatus&&format==='sse'?createSseTracker():null;
        const jsonChunks=okStatus&&format==='json'?[]:null;
        let responseBytes=0;
        let truncated=false;

        outgoing.writeHead(response.statusCode,headers);
        response.on('data',chunk=>{
          responseBytes+=chunk.length;
          entry.responseBytes=responseBytes;
          if(responseBytes>MAX_BODY_BYTES) {
            truncated=true;
            if(jsonChunks)jsonChunks.length=0;
            settleEntry(entry,'unknown','response-truncated',{responseBytes});
            response.destroy();outgoing.destroy();
            return;
          }
          if(sseTracker)sseTracker.push(chunk);
          else if(jsonChunks)jsonChunks.push(chunk);
        });
        response.once('end',()=>{
          entry.responseComplete=response.complete===true;
          if(truncated) {
            if(jsonChunks)jsonChunks.length=0;
            settleEntry(entry,'unknown','response-truncated',{responseBytes,responseComplete:entry.responseComplete});
            return;
          }
          if(!response.complete) {
            if(jsonChunks)jsonChunks.length=0;
            settleEntry(entry,'unknown','upstream-incomplete-stream',{responseBytes,responseComplete:false});
            return;
          }
          if(!okStatus) {
            if(jsonChunks)jsonChunks.length=0;
            settleEntry(entry,'unknown','upstream-http-error',{responseBytes,responseComplete:true});
            return;
          }
          if(format==='sse'&&sseTracker) {
            const outcome=sseTracker.finish(true);
            settleEntry(entry,outcome.settled?'settled':'unknown',outcome.evidence,{
              finishReasons:outcome.finishReasons,
              sawDone:outcome.sawDone,
              responseComplete:true,
              responseBytes,
            });
            return;
          }
          if(format==='json'&&jsonChunks) {
            const combined=Buffer.concat(jsonChunks,responseBytes);
            jsonChunks.length=0;
            const outcome=evaluateJsonCompletion(combined);
            settleEntry(entry,outcome.settled?'settled':'unknown',outcome.evidence,{
              finishReasons:outcome.finishReasons,
              responseComplete:true,
              responseBytes,
            });
            return;
          }
          settleEntry(entry,'unknown','ambiguous-response',{responseComplete:true,responseBytes});
        });
        response.once('aborted',()=>{
          if(jsonChunks)jsonChunks.length=0;
          settleEntry(entry,'unknown','upstream-incomplete-stream',{responseBytes,responseComplete:false});
        });
        response.once('close',()=>{
          if(jsonChunks)jsonChunks.length=0;
          settleEntry(entry,'unknown','upstream-incomplete-stream',{responseBytes,responseComplete:response.complete===true});
        });
        response.on('error',()=>{
          if(jsonChunks)jsonChunks.length=0;
          settleEntry(entry,'unknown','upstream-error',{responseBytes});
          outgoing.destroy();
        });
        response.pipe(outgoing);
      });
      const failed=()=>{
        settleEntry(entry,'unknown','upstream-error');
        if(!outgoing.headersSent){outgoing.writeHead(502);outgoing.end();}else outgoing.destroy();
      };
      upstream.once('error',failed);
      upstream.once('upgrade',(_response,socket)=>{socket.destroy();failed();});
      outgoing.once('close',()=>{
        if(!outgoing.writableFinished) {
          settleEntry(entry,'unknown','client-aborted');
          upstream.destroy();
        }
      });
      upstream.end(body);
    });
    incoming.once('close',()=>{
      if(!handled) {
        handled=true;
        rejectedBeforeDispatch++;
        outgoing.destroy();
      }
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
    isClosed=true;
    for(const entry of [...activeEntries])settleEntry(entry,'unknown','broker-closed');
    signal?.removeEventListener('abort',abort);
    agent.destroy();
    server.closeAllConnections();
    closed=new Promise(resolveClose=>server.close(()=>resolveClose()));
    return closed;
  };
  const abort=()=>{void close();};
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted){await close();signal.throwIfAborted();}
  const settlement=()=>{
    const activeCount=activeEntries.size;
    let state;
    let evidence;
    if(dispatched===0) {
      state='zero-dispatch';
      evidence='zero-dispatch';
    } else if(activeCount===0&&unknownCount===0&&completedCount===dispatched) {
      state='settled';
      evidence='positive-completion-evidence';
    } else {
      state='unknown';
      evidence=activeCount>0&&unknownCount===0?'in-flight':(lastUnknownEvidence??'unverified-outcome');
    }
    return deepFreeze({
      state,
      evidence,
      dispatched,
      inFlight:activeCount,
      completed:completedCount,
      unknown:unknownCount,
      rejectedBeforeDispatch,
      closed:isClosed,
      modelCancellationVerified:false,
      recordsTruncated,
      records:records.map(record=>({
        sequence:record.sequence,
        state:record.state,
        evidence:record.evidence,
        statusCode:record.statusCode,
        format:record.format,
        finishReasons:[...record.finishReasons],
        sawDone:record.sawDone,
        responseComplete:record.responseComplete,
        responseBytes:record.responseBytes,
      })),
    });
  };
  return {endpoint:'http://127.0.0.1:'+server.address().port,token,close,settlement};
}
