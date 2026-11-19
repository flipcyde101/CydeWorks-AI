import {openSync, writeSync, fsyncSync, closeSync, readFileSync} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

// Exclusive creation is the replay lock. An incomplete journal is never reusable.
export function claimRun(path, scope) {
  const fd = openSync(path, 'wx', 0o600);
  const id = randomUUID();
  let sequence = 0;
  const append = event => {
    writeSync(fd, JSON.stringify({...event, id, sequence: sequence++}) + '\n');
    fsyncSync(fd);
  };
  try { append({state: 'claimed', scopeHash: digest(scope), scope}); }
  catch (error) { closeSync(fd); throw error; }
  let closed = false;
  return {id, append(event) { if (closed) throw Error('Claim closed.'); append(event); },
    close() { if (!closed) { closed = true; closeSync(fd); } }};
}

export function reconcileClaim(path) {
  try {
    const text = readFileSync(path, 'utf8');
    if (!text.endsWith('\n')) throw Error('Truncated claim.');
    const rows = text.trim().split('\n').map(line => JSON.parse(line));
    if (!rows.length || rows[0].state !== 'claimed' || rows[0].scopeHash !== digest(rows[0].scope) ||
        rows.some((row, index) => row.sequence !== index || row.id !== rows[0].id)) throw Error('Invalid claim.');
    const last = rows.at(-1);
    return {replayAllowed: false, state: last.state === 'complete' && last.cleanup === 'verified' && last.inference === 'settled' ? 'complete' : 'unresolved', rows};
  } catch { return {replayAllowed: false, state: 'unresolved'}; }
}

// The adapter must prove guest identity and complete tree termination, not just
// termination of the Windows launcher. No PID-only recovery or broad taskkill.
export async function runOwned({claim, adapter, signal, execute, cleanupTimeoutMs = 5000}) {
  if (!adapter || typeof adapter.start !== 'function' || typeof adapter.stopAndVerify !== 'function') {
    claim.append({state: 'unresolved', cleanup: 'unknown', inference: 'unknown'});
    throw Error('A qualified process ownership adapter is required.');
  }
  let worker, result, failure;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? Error('Cancelled.'));
  signal?.addEventListener('abort', abort, {once: true});
  if (signal?.aborted) abort();
  try {
    controller.signal.throwIfAborted();
    // start must persist identity through record before allowing worker work.
    worker = await adapter.start({signal: controller.signal, record: identity => {
      if (!identity || !identity.nonce || !identity.birthIdentity) throw Error('Incomplete ownership identity.');
      claim.append({state: 'owned', identity});
    }});
    controller.signal.throwIfAborted();
    let cancel;
    try {
      result = await Promise.race([execute(worker, controller.signal), new Promise((_, reject) => {
        cancel = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', cancel, {once: true});
        if (controller.signal.aborted) cancel();
      })]);
    } finally { controller.signal.removeEventListener('abort', cancel); }
    controller.signal.throwIfAborted();
  } catch (error) { failure = error; }
  finally { signal?.removeEventListener('abort', abort); controller.abort(); }
  let evidence;
  let timer;
  try {
    evidence = await Promise.race([
      adapter.stopAndVerify(worker),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Cleanup deadline exceeded.')), cleanupTimeoutMs); }),
    ]);
  } catch { evidence = null; }
  finally { clearTimeout(timer); }
  const verified = evidence?.cleanup === 'verified' && evidence?.inference === 'settled';
  claim.append({state: verified && !failure ? 'complete' : 'unresolved',
    cleanup: verified ? 'verified' : 'unknown', inference: verified ? 'settled' : 'unknown'});
  if (!verified) throw Error('Worker cleanup or inference outcome unresolved.');
  if (failure) throw failure;
  return result;
}

export function bindCheckedPatch({files, patch, verification}) {
  const candidateSha256 = digest(files);
  if (verification?.trusted !== true || verification.candidateSha256 !== candidateSha256 || verification.passed !== true) {
    throw Error('Protected verification must bind the exact candidate.');
  }
  return {candidateSha256, patchSha256: digest(patch)};
}
