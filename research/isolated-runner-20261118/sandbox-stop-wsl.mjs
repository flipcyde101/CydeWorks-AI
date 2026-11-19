import {spawn} from 'node:child_process';
import {openSync, writeSync, fsyncSync, closeSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Fixed fixture only. No caller-supplied executable, source, or WSL arguments.
const requests = new Map();

export async function qualifySandboxStop({requestId = 'default', interrupt = 'durable'} = {}) {
  if (!['startup', 'durable'].includes(interrupt)) throw new Error('Invalid interruption phase');
  if (requests.has(requestId)) return {...requests.get(requestId), replay: true};
  requests.set(requestId, {cleanup: 'unknown', state: 'held', blocker: 'Request already reserved; no relaunch'});
  const result = await runStop(interrupt);
  requests.set(requestId, result);
  return result;
}

// Exclusive, durable claim precedes dispatch. Incomplete records hold, never retry.
function persist(path, value) {
  const fd = openSync(path, 'wx');
  try { writeSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
}
const fixturePath = fileURLToPath(new URL('./sandbox-stop-fixture.py', import.meta.url));
const linuxPath = '/mnt/' + fixturePath[0].toLowerCase() + fixturePath.slice(2).replaceAll('\\', '/');
export async function durableStop(directory, phase) {
  if (!['startup', 'durable'].includes(phase)) throw new Error('Invalid phase');
  const claim = join(directory, 'claim.json');
  try { persist(claim, {request: 'fixed-inert-stop', controller: process.pid}); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      const saved = JSON.parse(readFileSync(claim, 'utf8'));
      const dispatched = JSON.parse(readFileSync(join(directory, 'dispatch.json'), 'utf8'));
      if (saved.request !== 'fixed-inert-stop' || dispatched.dispatch !== 1 ||
          dispatched.fixture !== 'sandbox-stop-fixture.py') throw new Error('Invalid record');
    } catch { return {replay: true, cleanup: 'unknown', state: 'held', blocker: 'Incomplete claim or dispatch record'}; }
    const ownership = join(directory, 'ownership.json');
    let journal;
    try { journal = JSON.parse(readFileSync(ownership, 'utf8')); } catch {}
    const absent = journal?.event === 'ready' && await confirm(linuxPath, journal);
    return {replay: true, dispatches: 1, cleanup: absent ? 'verified' : 'unknown',
      state: absent ? 'resolved' : 'held', blocker: absent ? undefined : 'Incomplete identity or cleanup evidence', journal};
  }
  persist(join(directory, 'dispatch.json'), {fixture: 'sandbox-stop-fixture.py', dispatch: 1});
  return runStop(phase, frame => {
    if (frame.event === 'starting') persist(join(directory, 'startup.json'), frame);
    if (frame.event === 'ready') persist(join(directory, 'ownership.json'), frame);
    if ((phase === 'startup' && frame.event === 'starting') ||
        (phase === 'durable' && frame.event === 'ready')) process.send?.({event: 'interruptible', phase});
  }, true);
}

async function confirm(linux, journal) {
  if (!journal?.worker || !journal?.child) return false;
  const verifier = spawn('wsl.exe', ['--distribution', 'Ubuntu-24.04', '--user', 'nobody',
    '--exec', '/usr/bin/python3', '-I', '-B', linux, '--confirm'],
    {windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']});
  verifier.stdin.on('error', () => {});
  verifier.stdin.end(JSON.stringify([journal.worker, journal.child]) + '\n');
  return await new Promise(resolve => {
    let output = '';
    const timer = setTimeout(() => resolve(false), 5000);
    verifier.stdout.on('data', chunk => {output += chunk;});
    verifier.on('error', () => {clearTimeout(timer); resolve(false);});
    verifier.on('close', code => {
      clearTimeout(timer);
      try {const frame = JSON.parse(output); resolve(code === 0 && frame.event === 'confirmed' && frame.absent === true);}
      catch {resolve(false);}
    });
  });
}

async function runStop(interrupt, onFrame = () => {}, hold = false) {
  if (process.platform !== 'win32') return {cleanup: 'unknown', blocker: 'Windows required'};
  const path = fileURLToPath(new URL('./sandbox-stop-fixture.py', import.meta.url));
  const linux = '/mnt/' + path[0].toLowerCase() + path.slice(2).replaceAll('\\', '/');
  const child = spawn('wsl.exe', ['--distribution', 'Ubuntu-24.04', '--user', 'nobody',
    '--exec', '/usr/bin/python3', '-I', '-B', linux], {windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']});
  return await new Promise(resolve => {
    let buffer = '', journal, result;
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => {
      child.stdin.end();
      resolve({cleanup: 'unknown', blocker: 'Bounded shutdown evidence timeout', journal});
    }, 12000);
    child.on('error', error => {clearTimeout(timer); resolve({cleanup: 'unknown', blocker: error.code});});
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 8192) {child.stdin.end(); return;}
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const frame = JSON.parse(line);
          onFrame(frame);
          if (hold) { if (frame.event === 'ready') journal = frame; continue; }
          if (frame.event === 'starting' && interrupt === 'startup') child.stdin.end();
          else if (frame.event === 'ready' && !journal) {journal = frame; child.stdin.end();}
          else if (frame.event === 'stopped' && journal) result = frame;
          else if (frame.event === 'blocked') result = {cleanup: 'unknown', blocker: frame.reason};
        } catch {child.stdin.end();}
      }
    });
    child.on('close', async code => {
      clearTimeout(timer);
      resolve(code === 0 && result?.cleanup === 'verified' && await confirm(linux, journal) ? {...result, journal, independentCleanup: true}
        : {cleanup: 'unknown', blocker: result?.blocker ?? 'Missing successful namespace exit evidence', journal});
    });
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = process.argv[2] === '--controller'
    ? await durableStop(process.argv[3], process.argv[4]) : await qualifySandboxStop();
  console.log(JSON.stringify(result));
  process.disconnect?.();
}
