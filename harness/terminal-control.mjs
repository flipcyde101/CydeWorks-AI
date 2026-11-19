import {randomUUID} from 'node:crypto';

const deny=message=>{throw Object.assign(Error(message),{status:409});};

// A per-attempt control lease, not permission to run shell commands or edit files.
// Neither its bearer token nor its clocks are exposed in observer snapshots.
export function createTerminalControl(attemptId,{
  timeout=15000,monotonic=()=>performance.now(),wall=()=>Date.now(),token=randomUUID,
}={}) {
  if(typeof attemptId!=='string'||!attemptId||!Number.isSafeInteger(timeout)||timeout<=0)
    throw Error('Invalid terminal control configuration.');
  let lease,generation=0,closed=false,lastMono,lastWall;
  function revoke() {if(lease){lease=undefined;generation++;}}
  function sample() {
    const mono=monotonic(),real=wall();
    const reliable=Number.isFinite(mono)&&Number.isFinite(real)&&
      (lastMono===undefined||mono>=lastMono)&&(lastWall===undefined||real>=lastWall);
    lastMono=Number.isFinite(mono)?mono:undefined;
    lastWall=Number.isFinite(real)?real:undefined;
    if(lease&&(!reliable||mono>=lease.monoEnd||real>=lease.wallEnd))revoke();
    return {mono,real,reliable};
  }
  function snapshot() {
    sample();
    return {attemptId,generation,owner:lease?'Operator':'None',closed};
  }
  return {
    snapshot,
    revoke(){revoke();},
    close(){closed=true;revoke();},
    command(data) {
      const clock=sample();
      if(!clock.reliable)deny('The control clock changed. Refresh before taking control again.');
      if(closed)deny('This terminal is stopping or finished.');
      if(data?.attemptId!==attemptId)deny('The terminal attempt changed. Refresh and review the current run.');
      if(!Number.isSafeInteger(data.generation)||data.generation!==generation)
        deny('Terminal ownership changed. Refresh before taking another action.');
      if(data.command==='take') {
        if(lease&&data.confirm!==true)deny('Another view controls this terminal. Confirm takeover after refreshing.');
        const transferred=!!lease;
        lease={id:token(),monoEnd:clock.mono+timeout,wallEnd:clock.real+timeout};
        generation++;
        return {response:{lease:lease.id,attemptId,generation},
          message:transferred?'Operator transferred control to this view.':'Operator took control.'};
      }
      if(!lease||typeof data.lease!=='string'||data.lease!==lease.id)
        deny('Terminal control expired or belongs to another view.');
      if(data.command==='heartbeat') {
        lease.monoEnd=clock.mono+timeout;lease.wallEnd=clock.real+timeout;
        return {response:{accepted:true}};
      }
      if(data.command==='release'||data.command==='detach') {
        revoke();
        return {response:{accepted:true},message:data.command==='release'
          ?'Operator released control.':'Operator detached. OpenCode continues.'};
      }
      if(data.command==='status')return {response:{accepted:true},message:'OpenCode is running.'};
      if(data.command==='stop'&&data.confirm===true) {
        closed=true;revoke();
        return {response:{accepted:true},message:'Operator requested Stop.',stop:true};
      }
      throw Object.assign(Error('Choose a supported terminal control.'),{status:400});
    },
  };
}
