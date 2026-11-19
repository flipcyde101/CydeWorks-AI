import {spawn, execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
const exec = promisify(execFile);
const source = readFileSync(new URL('./lifecycle-fixture.py', import.meta.url), 'utf8');
const prefix = ['--distribution', 'Ubuntu-24.04', '--user', 'nobody', '--exec', '/usr/bin/python3', '-I', '-B', '-c', source];

// Deliberately limited to the inert fixture. This is not a general guest adapter.
export function createSyntheticWslAdapter() {
  let owned, launcher;
  return {
    async start({record, signal, nonce = randomUUID()}) {
      signal?.throwIfAborted();
      launcher = spawn('wsl.exe', [...prefix, 'start', nonce], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
      let stderr = '';
      launcher.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
      let removeAbort;
      const identity = await new Promise((resolve, reject) => {
        let buffer = '';
        const aborted = () => { clearTimeout(timer); reject(signal.reason ?? Error('Startup cancelled.')); };
        signal?.addEventListener('abort', aborted, {once: true});
        removeAbort = () => signal?.removeEventListener('abort', aborted);
        const timer = setTimeout(() => reject(Error('Fixture identity timeout; cleanup unresolved.')), 6000);
        launcher.once('error', error => { clearTimeout(timer); reject(error); });
        launcher.once('exit', code => { clearTimeout(timer); reject(Error(`Fixture exited ${code}: ${stderr}`)); });
        launcher.stdout.on('data', chunk => {
          buffer += chunk;
          if (buffer.length > 8192) { clearTimeout(timer); reject(Error('Oversized fixture identity.')); return; }
          if (buffer.includes('\n')) {
            clearTimeout(timer);
            try { resolve(JSON.parse(buffer.split('\n')[0])); } catch (error) { reject(error); }
          }
        });
      }).finally(() => removeAbort?.());
      if (identity.nonce !== nonce) throw Error('Fixture ownership mismatch.');
      owned = identity;
      if (signal?.aborted) {
        await this.stopAndVerify(identity);
        signal.throwIfAborted();
      }
      record(identity);
      return identity;
    },
    async stopAndVerify(identity = owned, nonce = identity?.nonce) {
      if (!identity) {
        if (launcher && launcher.exitCode === null) launcher.kill();
        return {cleanup: 'unknown'};
      }
      try {
        const {stdout} = await exec('wsl.exe', [...prefix, 'stop', JSON.stringify(identity), nonce],
          {windowsHide: true, timeout: 6000, maxBuffer: 16384});
        const evidence = JSON.parse(stdout);
        return {cleanup: evidence.cleanup};
      } catch { return {cleanup: 'unknown', inference: 'unknown'}; }
    },
  };
}
