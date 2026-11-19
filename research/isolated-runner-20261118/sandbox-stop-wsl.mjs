import {spawn} from 'node:child_process';
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

async function runStop(interrupt) {
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
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await qualifySandboxStop()));
