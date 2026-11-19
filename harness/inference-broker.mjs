import {Agent,createServer,request} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';

const MAX_BODY_BYTES=2000000;
const MAX_OBSERVATION_BYTES=4000000;
const MAX_SSE_LINE_BYTES=262144;
const MAX_SSE_EVENT_BYTES=262144;
const MAX_SSE_EVENT_LINES=256;
const MAX_EXPECTED_CHOICES=32;
const MAX_ACTIVE_ENTRIES=64;
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

function parseExpectedChoices(parsed) {
  if(parsed.n===undefined||parsed.n===null)return 1;
  if(Number.isSafeInteger(parsed.n)&&parsed.n>=1&&parsed.n<=MAX_EXPECTED_CHOICES)return parsed.n;
  return null;
}

function normalizeFinishReason(value) {
  return typeof value==='string'&&TERMINAL_FINISH_REASONS.has(value)?value:null;
}

function evaluateJsonCompletion(buffer,expectedChoices) {
  if(expectedChoices===null)
    return {settled:false,evidence:'ambiguous-response',finishReasons:[]};
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
  if(parsed.id!==undefined&&(typeof parsed.id!=='string'||!parsed.id))
    return {settled:false,evidence:'ambiguous-response',finishReasons:[]};
  if(parsed.object!==undefined&&parsed.object!=='chat.completion')
    return {settled:false,evidence:'ambiguous-response',finishReasons:[]};
  if(parsed.model!==undefined&&(typeof parsed.model!=='string'||!parsed.model))
    return {settled:false,evidence:'ambiguous-response',finishReasons:[]};
  if(!Array.isArray(parsed.choices)||parsed.choices.length!==expectedChoices)
    return {settled:false,evidence:'ambiguous-response',finishReasons:[]};
  const seen=new Set();
  const reasonsByIndex=new Array(expectedChoices).fill(null);
  for(const choice of parsed.choices) {
    if(!choice||typeof choice!=='object'||Array.isArray(choice))
      return {settled:false,evidence:'ambiguous-response',finishReasons:[]};
    if(choice.error!==undefined&&choice.error!==null)
      return {settled:false,evidence:'upstream-error',finishReasons:[]};
    if(choice.message!==undefined&&(!choice.message||typeof choice.message!=='object'||Array.isArray(choice.message)))
      return {settled:false,evidence:'ambiguous-response',finishReasons:[]};
    let index;
    if(choice.index===undefined) {
      if(expectedChoices!==1)return {settled:false,evidence:'ambiguous-response',finishReasons:[]};
      index=0;
    } else if(Number.isSafeInteger(choice.index)&&choice.index>=0&&choice.index<expectedChoices) {
      index=choice.index;
    } else {
      return {settled:false,evidence:'ambiguous-response',finishReasons:[]};
    }
    if(seen.has(index))
      return {settled:false,evidence:'ambiguous-response',finishReasons:[]};
    seen.add(index);
    const reason=normalizeFinishReason(choice.finish_reason);
    if(!reason)return {settled:false,evidence:'ambiguous-response',finishReasons:[]};
    reasonsByIndex[index]=reason;
  }
  if(seen.size!==expectedChoices)
    return {settled:false,evidence:'ambiguous-response',finishReasons:[]};
  const finishReasons=[];
  for(const reason of reasonsByIndex) {
    if(!finishReasons.includes(reason)&&finishReasons.length<MAX_FINISH_REASONS)finishReasons.push(reason);
  }
  return {settled:true,evidence:'json-finish-reason',finishReasons};
}

function createSseTracker(expectedChoices,tryReserveObservation,releaseObservation) {
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let lineBuffer='';
  let ignoreNextLf=false;
  let eventType='';
  let eventDataLines=[];
  let eventDataBytes=0;
  let sawDone=false;
  let sawError=false;
  let sawMalformed=expectedChoices===null;
  let sawDuplicateOrContradictory=false;
  let observationLimitExceeded=false;
  const choiceFinishReasons=expectedChoices?new Array(expectedChoices).fill(null):[];

  const clearBuffers=()=>{
    lineBuffer='';
    eventDataLines=[];
    eventDataBytes=0;
    releaseObservation();
  };

  const failObservationLimit=()=>{
    observationLimitExceeded=true;
    clearBuffers();
  };

  const dispatchEvent=()=>{
    const currentType=eventType;
    eventType='';
    if(currentType==='error') {
      eventDataLines=[];
      eventDataBytes=0;
      sawError=true;
      return;
    }
    if(eventDataLines.length===0)return;
    const payload=eventDataLines.join('\n');
    eventDataLines=[];
    eventDataBytes=0;
    if(sawDone) {
      try {
        const afterDone=JSON.parse(payload);
        if(afterDone&&typeof afterDone==='object'&&!Array.isArray(afterDone)&&afterDone.error!==undefined&&afterDone.error!==null) {
          sawError=true;
          return;
        }
      } catch {}
      sawMalformed=true;
      return;
    }
    if(payload==='[DONE]'){sawDone=true;return;}
    let parsed;
    try {parsed=JSON.parse(payload);}
    catch {sawMalformed=true;return;}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)){sawMalformed=true;return;}
    if(parsed.error!==undefined&&parsed.error!==null){sawError=true;return;}
    if(parsed.id!==undefined&&(typeof parsed.id!=='string'||!parsed.id)){sawMalformed=true;return;}
    if(parsed.object!==undefined&&parsed.object!=='chat.completion.chunk'&&parsed.object!=='chat.completion') {
      sawMalformed=true;return;
    }
    if(parsed.model!==undefined&&(typeof parsed.model!=='string'||!parsed.model)){sawMalformed=true;return;}
    if(parsed.choices===undefined){if(parsed.usage===undefined)sawMalformed=true;return;}
    if(!Array.isArray(parsed.choices)){sawMalformed=true;return;}
    const seenInChunk=new Set();
    for(const choice of parsed.choices) {
      if(!choice||typeof choice!=='object'||Array.isArray(choice)){sawMalformed=true;return;}
      if(choice.error!==undefined&&choice.error!==null){sawError=true;return;}
      let index;
      if(choice.index===undefined) {
        if(expectedChoices!==1||parsed.choices.length!==1){sawMalformed=true;return;}
        index=0;
      } else if(expectedChoices!==null&&Number.isSafeInteger(choice.index)&&choice.index>=0&&choice.index<expectedChoices) {
        index=choice.index;
      } else {
        sawMalformed=true;return;
      }
      if(seenInChunk.has(index)){sawDuplicateOrContradictory=true;return;}
      seenInChunk.add(index);
      if(choice.finish_reason!==undefined&&choice.finish_reason!==null) {
        const reason=normalizeFinishReason(choice.finish_reason);
        if(!reason){sawMalformed=true;return;}
        if(choiceFinishReasons[index]!==null){sawDuplicateOrContradictory=true;return;}
        choiceFinishReasons[index]=reason;
      } else if(choiceFinishReasons[index]!==null) {
        sawDuplicateOrContradictory=true;return;
      }
    }
  };

  const processLine=line=>{
    if(Buffer.byteLength(line)>MAX_SSE_LINE_BYTES){failObservationLimit();return;}
    if(line===''){dispatchEvent();return;}
    if(line.startsWith(':'))return;
    const colon=line.indexOf(':');
    const field=colon===-1?line:line.slice(0,colon);
    let value=colon===-1?'':line.slice(colon+1);
    if(value.startsWith(' '))value=value.slice(1);
    if(field==='event')eventType=value;
    else if(field==='data') {
      const valueBytes=Buffer.byteLength(value);
      if(eventDataLines.length>=MAX_SSE_EVENT_LINES||eventDataBytes+valueBytes>MAX_SSE_EVENT_BYTES) {
        failObservationLimit();
        return;
      }
      eventDataLines.push(value);
      eventDataBytes+=valueBytes;
    }
  };

  return {
    get observationLimitExceeded(){return observationLimitExceeded;},
    push(chunk) {
      if(observationLimitExceeded)return false;
      let text;
      try {text=decoder.decode(chunk,{stream:true});}
      catch {sawMalformed=true;return true;}
      let pos=0;
      if(ignoreNextLf&&text.length>0) {
        ignoreNextLf=false;
        if(text[0]==='\n')pos=1;
      }
      while(pos<text.length) {
        const cr=text.indexOf('\r',pos);
        const lf=text.indexOf('\n',pos);
        let next=-1;
        if(cr!==-1&&lf!==-1)next=cr<lf?cr:lf;
        else next=cr!==-1?cr:lf;
        if(next===-1) {
          const tail=text.slice(pos);
          const nextBytes=Buffer.byteLength(lineBuffer)+Buffer.byteLength(tail);
          if(nextBytes>MAX_SSE_LINE_BYTES||!tryReserveObservation(nextBytes+eventDataBytes)) {
            failObservationLimit();
            return false;
          }
          lineBuffer+=tail;
          return true;
        }
        const segment=text.slice(pos,next);
        if(Buffer.byteLength(lineBuffer)+Buffer.byteLength(segment)>MAX_SSE_LINE_BYTES) {
          failObservationLimit();
          return false;
        }
        const fullLine=lineBuffer+segment;
        lineBuffer='';
        processLine(fullLine);
        if(observationLimitExceeded)return false;
        if(!tryReserveObservation(eventDataBytes)){failObservationLimit();return false;}
        if(text[next]==='\r') {
          if(next+1<text.length&&text[next+1]==='\n')pos=next+2;
          else if(next+1===text.length){ignoreNextLf=true;pos=next+1;}
          else pos=next+1;
        } else {
          pos=next+1;
        }
      }
      if(!tryReserveObservation(Buffer.byteLength(lineBuffer)+eventDataBytes)){failObservationLimit();return false;}
      return true;
    },
    finish(complete) {
      if(!observationLimitExceeded) {
        try {
          const tail=decoder.decode();
          if(tail)lineBuffer+=tail;
        } catch {sawMalformed=true;}
      }
      if(eventType==='error')sawError=true;
      const hadDangling=lineBuffer.length>0||eventDataLines.length>0;
      clearBuffers();
      const allChoicesFinished=expectedChoices!==null&&choiceFinishReasons.every(reason=>reason!==null);
      const settled=complete&&!observationLimitExceeded&&!sawError&&!sawMalformed&&
        !sawDuplicateOrContradictory&&!hadDangling&&allChoicesFinished&&sawDone;
      const evidence=settled?'sse-finish-reason-and-done'
        :!complete?'upstream-incomplete-stream'
        :sawError?'upstream-error'
        :observationLimitExceeded?'observation-limit-exceeded'
        :'ambiguous-response';
      const finishReasons=[];
      for(const reason of choiceFinishReasons) {
        if(reason&&!finishReasons.includes(reason)&&finishReasons.length<MAX_FINISH_REASONS)
          finishReasons.push(reason);
      }
      return {settled,evidence,finishReasons,sawDone};
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
  let activeObservationBytes=0;
  let overflowInFlight=0;
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
    delete entry.releaseObservation;
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
      const expectedChoices=parseExpectedChoices(parsed);
      dispatched++;

      if(activeEntries.size>=MAX_ACTIVE_ENTRIES) {
        unknownCount++;
        lastUnknownEvidence='observation-limit-exceeded';
        recordsTruncated=true;
        overflowInFlight++;
        let overflowReleased=false;
        const releaseOverflow=()=>{
          if(!overflowReleased){overflowReleased=true;if(!isClosed)overflowInFlight=Math.max(0,overflowInFlight-1);}
        };
        const upstream=request({hostname:'127.0.0.1',port:Number(target.port||'80'),path:'/v1/chat/completions',
          method:'POST',agent,headers:{'Content-Type':'application/json','Accept':incoming.headers.accept??'application/json'}},response=>{
          if(response.statusCode>=300&&response.statusCode<400) {
            releaseOverflow();
            response.destroy();outgoing.writeHead(502);outgoing.end();return;
          }
          const headers={};
          if(response.headers['content-type'])headers['Content-Type']=response.headers['content-type'];
          outgoing.writeHead(response.statusCode,headers);
          let responseBytes=0;
          response.on('data',chunk=>{
            responseBytes+=chunk.length;
            if(responseBytes>MAX_BODY_BYTES){releaseOverflow();response.destroy();outgoing.destroy();}
          });
          response.once('end',releaseOverflow);
          response.once('aborted',releaseOverflow);
          response.once('close',releaseOverflow);
          response.on('error',()=>{releaseOverflow();outgoing.destroy();});
          response.pipe(outgoing);
        });
        const failed=()=>{
          releaseOverflow();
          if(!outgoing.headersSent){outgoing.writeHead(502);outgoing.end();}else outgoing.destroy();
        };
        upstream.once('error',failed);
        upstream.once('upgrade',(_response,socket)=>{socket.destroy();failed();});
        outgoing.once('close',()=>{
          if(!outgoing.writableFinished){releaseOverflow();upstream.destroy();}
        });
        upstream.end(body);
        return;
      }

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

      let reservedBytes=0;
      const releaseObservation=()=>{
        if(reservedBytes>0) {
          activeObservationBytes=Math.max(0,activeObservationBytes-reservedBytes);
          reservedBytes=0;
        }
      };
      const tryReserveObservation=nextTotal=>{
        if(nextTotal<=reservedBytes) {
          const freed=reservedBytes-nextTotal;
          reservedBytes=nextTotal;
          activeObservationBytes=Math.max(0,activeObservationBytes-freed);
          return true;
        }
        const needed=nextTotal-reservedBytes;
        if(activeObservationBytes+needed>MAX_OBSERVATION_BYTES)return false;
        activeObservationBytes+=needed;
        reservedBytes=nextTotal;
        return true;
      };
      entry.releaseObservation=releaseObservation;

      const upstream=request({hostname:'127.0.0.1',port:Number(target.port||'80'),path:'/v1/chat/completions',
        method:'POST',agent,headers:{'Content-Type':'application/json','Accept':incoming.headers.accept??'application/json'}},response=>{
        if(entry.state==='in-flight')entry.statusCode=response.statusCode??null;
        if(response.statusCode>=300&&response.statusCode<400) {
          releaseObservation();
          settleEntry(entry,'unknown','upstream-redirect-blocked',{statusCode:response.statusCode});
          response.destroy();outgoing.writeHead(502);outgoing.end();return;
        }
        const headers={};
        if(response.headers['content-type'])headers['Content-Type']=response.headers['content-type'];
        const mediaType=mediaTypeOf(response.headers['content-type']);
        const okStatus=response.statusCode===200;
        const format=mediaType==='text/event-stream'?'sse'
          :(mediaType==='application/json'||mediaType==='')?'json':'other';
        if(entry.state==='in-flight')entry.format=format;
        const sseTracker=okStatus&&format==='sse'?createSseTracker(expectedChoices,tryReserveObservation,releaseObservation):null;
        const jsonChunks=okStatus&&format==='json'&&expectedChoices!==null?[]:null;
        let responseBytes=0;
        let truncated=false;
        let observationLimitExceeded=false;

        outgoing.writeHead(response.statusCode,headers);
        response.on('data',chunk=>{
          responseBytes+=chunk.length;
          if(entry.state==='in-flight')entry.responseBytes=responseBytes;
          if(responseBytes>MAX_BODY_BYTES) {
            truncated=true;
            if(jsonChunks)jsonChunks.length=0;
            releaseObservation();
            settleEntry(entry,'unknown','response-truncated',{responseBytes});
            response.destroy();outgoing.destroy();
            return;
          }
          if(entry.state!=='in-flight'||observationLimitExceeded)return;
          if(sseTracker) {
            if(!sseTracker.push(chunk))observationLimitExceeded=true;
          } else if(jsonChunks) {
            if(!tryReserveObservation(responseBytes)) {
              observationLimitExceeded=true;
              jsonChunks.length=0;
              releaseObservation();
              return;
            }
            jsonChunks.push(chunk);
          }
        });
        response.once('end',()=>{
          if(entry.state!=='in-flight'){releaseObservation();if(jsonChunks)jsonChunks.length=0;return;}
          if(truncated) {
            if(jsonChunks)jsonChunks.length=0;
            releaseObservation();
            settleEntry(entry,'unknown','response-truncated',{responseBytes,responseComplete:response.complete===true});
            return;
          }
          if(!response.complete) {
            if(jsonChunks)jsonChunks.length=0;
            releaseObservation();
            settleEntry(entry,'unknown','upstream-incomplete-stream',{responseBytes,responseComplete:false});
            return;
          }
          if(!okStatus) {
            if(jsonChunks)jsonChunks.length=0;
            releaseObservation();
            settleEntry(entry,'unknown','upstream-http-error',{responseBytes,responseComplete:true});
            return;
          }
          if(observationLimitExceeded||sseTracker?.observationLimitExceeded) {
            if(jsonChunks)jsonChunks.length=0;
            releaseObservation();
            settleEntry(entry,'unknown','observation-limit-exceeded',{responseBytes,responseComplete:true});
            return;
          }
          if(format==='sse'&&sseTracker) {
            const outcome=sseTracker.finish(true);
            releaseObservation();
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
            releaseObservation();
            const outcome=evaluateJsonCompletion(combined,expectedChoices);
            settleEntry(entry,outcome.settled?'settled':'unknown',outcome.evidence,{
              finishReasons:outcome.finishReasons,
              responseComplete:true,
              responseBytes,
            });
            return;
          }
          releaseObservation();
          settleEntry(entry,'unknown','ambiguous-response',{responseComplete:true,responseBytes});
        });
        response.once('aborted',()=>{
          if(jsonChunks)jsonChunks.length=0;
          releaseObservation();
          settleEntry(entry,'unknown','upstream-incomplete-stream',{responseBytes,responseComplete:false});
        });
        response.once('close',()=>{
          if(jsonChunks)jsonChunks.length=0;
          releaseObservation();
          settleEntry(entry,'unknown','upstream-incomplete-stream',{responseBytes,responseComplete:response.complete===true});
        });
        response.on('error',()=>{
          if(jsonChunks)jsonChunks.length=0;
          releaseObservation();
          settleEntry(entry,'unknown','upstream-error',{responseBytes});
          outgoing.destroy();
        });
        response.pipe(outgoing);
      });
      const failed=()=>{
        releaseObservation();
        settleEntry(entry,'unknown','upstream-error');
        if(!outgoing.headersSent){outgoing.writeHead(502);outgoing.end();}else outgoing.destroy();
      };
      upstream.once('error',failed);
      upstream.once('upgrade',(_response,socket)=>{socket.destroy();failed();});
      outgoing.once('close',()=>{
        if(!outgoing.writableFinished) {
          releaseObservation();
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
    for(const entry of [...activeEntries]) {
      entry.releaseObservation?.();
      settleEntry(entry,'unknown','broker-closed');
    }
    overflowInFlight=0;
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
    const activeCount=activeEntries.size+overflowInFlight;
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
      observationBytes:activeObservationBytes,
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
