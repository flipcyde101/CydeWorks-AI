import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Fixed fixture only. No caller-supplied executable, source, or WSL arguments.
export async function qualifySandboxStop() {
  if (process.platform !== 'win32') return {cleanup: 'unknown', blocker: 'Windows required'};
  const path = fileURLToPath(new URL('./sandbox-stop-fixture.py', import.meta.url));
  const linux = '/mnt/' + path[0].toLowerCase() + path.slice(2).replaceAll('\\', '/');
  const child = spawn('wsl.exe', ['--distribution', 'Ubuntu-24.04', '--user', 'nobody',
    '--exec', '/usr/bin/python3', '-I', '-B', linux], {windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']});
  return await new Promise(resolve => {
    let buffer = '', journal, result;
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
          if (frame.event === 'ready' && !journal) {journal = frame; child.stdin.end();}
          else if (frame.event === 'stopped' && journal) result = frame;
          else if (frame.event === 'blocked') result = {cleanup: 'unknown', blocker: frame.reason};
        } catch {child.stdin.end();}
      }
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve(code === 0 && result?.cleanup === 'verified' ? {...result, journal}
        : {cleanup: 'unknown', blocker: result?.blocker ?? 'Missing successful namespace exit evidence', journal});
    });
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await qualifySandboxStop()));
