// Tokens remain in this page's memory. Never persist them or include them in logs.
export function terminalRequest(task,held,command,confirm=false) {
  const control=command==='take'?task?.live?.control:held;
  return {command,confirm,attemptId:control?.attemptId,generation:control?.generation,
    ...(command==='take'?{}:{lease:held?.lease})};
}

export function ownsTerminal(task,held) {
  const current=task?.live?.control;
  return !!held&&task.status==='running'&&current?.owner==='Operator'&&!current.closed&&
    held.attemptId===current.attemptId&&held.generation===current.generation;
}
