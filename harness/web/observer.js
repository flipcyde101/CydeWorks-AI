// This loop only reads state. Commands and approvals are never replayed.
export function createObserver({read, onData, onState, onDisconnect, schedule=setTimeout, cancel=clearTimeout}) {
  let generation=0, timer, failures=0, current, started;
  function stop() {
    generation++;
    cancel(timer);
    current=undefined;
  }
  function start(id, delay=0) {
    stop();
    current=id;
    failures=0;
    started=undefined;
    const stamp=generation;
    const valid=()=>stamp===generation && current===id;
    async function tick() {
      if (!valid()) return;
      let next=850;
      try {
        const record=await read(id);
        if (!valid()) return;
        const applied=await onData(record,valid);
        if (!valid()) return;
        if (applied!==false) {
          failures=0;
          started=undefined;
          onState({phase:'connected'});
        }
        next=record.status==='running'?850:4000;
      } catch (error) {
        if (!valid()) return;
        failures++;
        started ??= Date.now();
        onDisconnect();
        if (error.status===401 || error.status===404) {
          onState({phase:error.status===401?'locked':'missing', failures, started});
          return;
        }
        next=Math.min(8000,1000*2**Math.min(failures-1,3));
        onState({phase:'reconnecting', failures, started, retryMs:next});
      }
      if (valid()) timer=schedule(tick,next);
    }
    timer=schedule(tick,delay);
  }
  return {start, stop};
}
