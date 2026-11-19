/**
 * Disconnected Windows-to-WSL OpenCode process ownership and Stop adapter.
 *
 * Research only. This file is not imported by pilot.mjs or harness/.
 * Real OpenCode dispatch is disabled by constant gate; only the inert
 * multi-process namespace fixture profile can execute, and all evidence is
 * tagged with qualificationScope: 'inert-fixture-only'.
 */

import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const SCHEMA = 'cydeworks.opencode-stop.v1';
export const ACTUAL_OPENCODE_DISPATCH_ENABLED = false;
export const QUALIFICATION_SCOPE = 'inert-fixture-only';

const NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FRAME_MAX = 8192;
const GUEST_WIN_PATH = fileURLToPath(new URL('./opencode-stop-guest.py', import.meta.url));

export function toWslPath(windowsPath) {
  if (windowsPath.startsWith('/')) return windowsPath;
  const drive = windowsPath[0].toLowerCase();
  return `/mnt/${drive}${windowsPath.slice(2).replaceAll('\\', '/')}`;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function digestIdentity(identity) {
  const core = {
    birthIdentity: identity.birthIdentity,
    bootId: identity.bootId,
    bwrap: identity.bwrap,
    depth: identity.depth,
    init: identity.init,
    nonce: identity.nonce,
    profile: identity.profile,
    schema: identity.schema,
    supervisor: identity.supervisor,
    uid: identity.uid,
  };
  return createHash('sha256').update(canonicalJson(core)).digest('hex');
}

export function validateOwnedIdentity(identity, expectedNonce) {
  if (!identity || typeof identity !== 'object' || identity.schema !== SCHEMA) return false;
  if (typeof identity.nonce !== 'string' || !NONCE_RE.test(identity.nonce)) return false;
  if (expectedNonce !== undefined && identity.nonce !== expectedNonce) return false;
  if (typeof identity.bootId !== 'string' || !identity.bootId) return false;
  if (!Number.isInteger(identity.uid) || !Number.isInteger(identity.depth) || identity.depth < 1) return false;
  for (const role of ['init', 'bwrap']) {
    const proc = identity[role];
    if (!proc || typeof proc !== 'object') return false;
    if (!Number.isInteger(proc.pid) || proc.pid <= 1) return false;
    if (typeof proc.start !== 'string' || !proc.start) return false;
    if (typeof proc.pidNs !== 'string' || !proc.pidNs.startsWith('pid:[')) return false;
  }
  if (identity.init.pidNs === identity.bwrap.pidNs) return false;
  const expectedBirth = `${identity.bootId}:${identity.init.pid}:${identity.init.start}:${identity.init.pidNs}`;
  if (identity.birthIdentity !== expectedBirth) return false;
  return true;
}

function defaultSpawnGuest(mode, {distribution = 'Ubuntu-24.04', user = 'nobody', guestPath = GUEST_WIN_PATH} = {}) {
  if (process.platform === 'win32') {
    const linuxGuest = toWslPath(guestPath);
    return spawn(
      'wsl.exe',
      ['--distribution', distribution, '--user', user, '--exec', '/usr/bin/python3', '-I', '-B', linuxGuest, mode],
      {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']},
    );
  }
  return spawn('/usr/bin/python3', ['-I', '-B', guestPath, mode], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runOneshot(spawnGuest, mode, payload, timeoutMs) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawnGuest(mode);
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(null);
    }, timeoutMs);
    child.stdin.on('error', () => {});
    child.on('error', () => finish(null));
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (stdout.length > FRAME_MAX * 2) {
        try { child.kill(); } catch {}
        finish(null);
      }
    });
    child.on('close', code => {
      if (code !== 0) {
        finish(null);
        return;
      }
      const line = stdout.trim().split('\n')[0];
      try {
        finish(JSON.parse(line));
      } catch {
        finish(null);
      }
    });
    try {
      child.stdin.end(JSON.stringify(payload) + '\n');
    } catch {
      finish(null);
    }
  });
}

export function createOpenCodeStopWslAdapter({
  profile = 'inert-fixture',
  bwrapPath = null,
  distribution = 'Ubuntu-24.04',
  user = 'nobody',
  guestPath = GUEST_WIN_PATH,
  holdTimeoutMs = 6000,
  stopTimeoutMs = 5000,
  spawnGuest = mode => defaultSpawnGuest(mode, {distribution, user, guestPath}),
} = {}) {
  const activeSessions = new Map();

  return {
    profile,
    qualificationScope: QUALIFICATION_SCOPE,
    actualOpenCodeEnabled: ACTUAL_OPENCODE_DISPATCH_ENABLED,

    async start({record, signal, nonce = randomUUID()} = {}) {
      signal?.throwIfAborted();
      if (typeof record !== 'function') {
        throw Error('Durable identity record callback is required before dispatch.');
      }
      if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) {
        throw Error('Invalid dispatch nonce.');
      }
      if (profile === 'actual-opencode' && !ACTUAL_OPENCODE_DISPATCH_ENABLED) {
        throw Error('BLOCKED: actual OpenCode dispatch disabled pending qualification.');
      }
      if (profile !== 'inert-fixture') {
        throw Error(`Unsupported profile: ${String(profile)}`);
      }
      if (activeSessions.has(nonce)) {
        throw Error('Duplicate active session nonce.');
      }

      const child = spawnGuest('serve');
      child.stdin.on('error', () => {});
      let buffer = '';
      let stoppedFrame = null;
      const workloadFrames = [];
      const waiters = [];

      const notify = (frame, error) => {
        for (let i = 0; i < waiters.length; i++) {
          const waiter = waiters[i];
          if (waiter.predicate(frame, error)) {
            waiters.splice(i, 1);
            clearTimeout(waiter.timer);
            if (error) waiter.reject(error);
            else waiter.resolve(frame);
            return;
          }
        }
      };

      let exitError = null;
      const closedPromise = new Promise(resolve => {
        child.once('error', error => {
          exitError = error;
          notify(null, error);
          resolve();
        });
        child.once('close', code => {
          if (!exitError) exitError = Error(`Guest supervisor exited (${String(code)})`);
          notify(null, exitError);
          resolve();
        });
      });

      child.stdout.on('data', chunk => {
        buffer += chunk.toString('utf8');
        if (buffer.length > FRAME_MAX * 4) {
          try { child.stdin.end(); child.kill(); } catch {}
          notify(null, Error('Oversized supervisor frame buffer.'));
          return;
        }
        while (buffer.includes('\n')) {
          const idx = buffer.indexOf('\n');
          const rawLine = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (rawLine.length > FRAME_MAX) {
            try { child.stdin.end(); child.kill(); } catch {}
            notify(null, Error('Oversized supervisor frame.'));
            return;
          }
          let frame;
          try {
            frame = JSON.parse(rawLine);
          } catch (error) {
            try { child.stdin.end(); child.kill(); } catch {}
            notify(null, error);
            return;
          }
          if (frame.event === 'workload') {
            if (workloadFrames.length < 64) workloadFrames.push(frame.data);
          } else if (frame.event === 'stopped') {
            stoppedFrame = frame;
          }
          notify(frame, null);
        }
      });

      const nextFrame = (predicate, timeoutMs, timeoutMessage) =>
        new Promise((resolve, reject) => {
          if (stoppedFrame && predicate(stoppedFrame, null)) {
            resolve(stoppedFrame);
            return;
          }
          if (exitError) {
            reject(exitError);
            return;
          }
          const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason ?? Error('Startup aborted.'));
          };
          signal?.addEventListener('abort', onAbort, {once: true});
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            reject(Error(timeoutMessage));
          }, timeoutMs);
          waiters.push({
            predicate: (frame, err) => {
              if (err || predicate(frame, null)) {
                signal?.removeEventListener('abort', onAbort);
                return true;
              }
              return false;
            },
            timer,
            resolve,
            reject,
          });
        });

      const sendFrame = payload => {
        child.stdin.write(JSON.stringify(payload) + '\n');
      };

      const session = {
        nonce,
        child,
        closedPromise,
        getStoppedFrame: () => stoppedFrame,
        workloadFrames,
        waitForWorkload: timeoutMs => {
          if (workloadFrames.length > 0) return Promise.resolve(workloadFrames[0]);
          return nextFrame(f => f?.event === 'workload', timeoutMs, 'Workload frame timeout.').then(f => f.data);
        },
      };
      activeSessions.set(nonce, session);

      let heldIdentity = null;
      try {
        const startFrame = {op: 'start', nonce, profile};
        if (bwrapPath) startFrame.bwrap = toWslPath(bwrapPath);
        sendFrame(startFrame);

        const held = await nextFrame(
          f => f?.event === 'held' || f?.event === 'blocked',
          holdTimeoutMs,
          'Held identity deadline exceeded.',
        );
        if (held.event === 'blocked') {
          throw Error(`Guest supervisor blocked: ${String(held.reason)}`);
        }
        const candidate = held.identity;
        const computedDigest = digestIdentity(candidate);
        if (held.nonce !== nonce || held.digest !== computedDigest || !validateOwnedIdentity(candidate, nonce)) {
          throw Error('Guest supervisor returned an invalid ownership identity.');
        }
        heldIdentity = {
          ...candidate,
          identityDigest: computedDigest,
          qualificationScope: QUALIFICATION_SCOPE,
          synthetic: true,
        };

        signal?.throwIfAborted();
        // Durable persistence happens BEFORE releasing the held namespace.
        record(heldIdentity);
        signal?.throwIfAborted();

        sendFrame({op: 'dispatch', nonce, digest: computedDigest});
        const dispatched = await nextFrame(
          f => f?.event === 'dispatched' || f?.event === 'blocked',
          holdTimeoutMs,
          'Dispatch confirmation deadline exceeded.',
        );
        if (dispatched.event !== 'dispatched' || dispatched.nonce !== nonce) {
          throw Error(`Guest dispatch rejected: ${String(dispatched.reason ?? 'unexpected frame')}`);
        }
        session.identity = heldIdentity;
        return heldIdentity;
      } catch (error) {
        try { child.stdin.end(); } catch {}
        await this.stopAndVerify(heldIdentity, nonce).catch(() => {});
        activeSessions.delete(nonce);
        throw error;
      }
    },

    async stopAndVerify(identity, nonce = identity?.nonce) {
      if (!validateOwnedIdentity(identity, nonce)) {
        return {
          cleanup: 'unknown',
          reason: 'stale-or-invalid-identity',
          qualificationScope: QUALIFICATION_SCOPE,
        };
      }
      const expectedDigest = digestIdentity(identity);
      if (identity.identityDigest && identity.identityDigest !== expectedDigest) {
        return {
          cleanup: 'unknown',
          reason: 'identity-digest-mismatch',
          qualificationScope: QUALIFICATION_SCOPE,
        };
      }

      const session = activeSessions.get(nonce);
      let sessionStopped = null;
      if (session) {
        activeSessions.delete(nonce);
        try {
          session.child.stdin.write(JSON.stringify({op: 'stop', nonce}) + '\n');
          session.child.stdin.end();
        } catch {}
        let timer;
        try {
          await Promise.race([
            session.closedPromise,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(Error('Session stop timeout')), stopTimeoutMs);
            }),
          ]);
          sessionStopped = session.getStoppedFrame();
        } catch {
          try { session.child.kill(); } catch {}
          sessionStopped = null;
        } finally {
          clearTimeout(timer);
        }
      }

      const outOfBand = await runOneshot(spawnGuest, 'stop', identity, stopTimeoutMs);
      if (!outOfBand || outOfBand.event !== 'stopped' || outOfBand.cleanup !== 'verified') {
        return {
          cleanup: 'unknown',
          reason: outOfBand?.reason ?? 'unverified-out-of-band-stop',
          evidence: outOfBand?.evidence ?? null,
          qualificationScope: QUALIFICATION_SCOPE,
        };
      }
      if (session && sessionStopped && sessionStopped.cleanup !== 'verified') {
        return {
          cleanup: 'unknown',
          reason: 'supervisor-stop-unverified',
          evidence: sessionStopped.evidence ?? null,
          qualificationScope: QUALIFICATION_SCOPE,
        };
      }
      return {
        cleanup: 'verified',
        evidence: outOfBand.evidence ?? sessionStopped?.evidence ?? null,
        qualificationScope: QUALIFICATION_SCOPE,
      };
    },

    async confirmAbsent(identity, nonce = identity?.nonce) {
      if (!validateOwnedIdentity(identity, nonce)) {
        return {absent: false, reason: 'stale-or-invalid-identity'};
      }
      const frame = await runOneshot(spawnGuest, 'confirm', identity, stopTimeoutMs);
      if (!frame || frame.event !== 'confirmed') {
        return {absent: false, reason: 'confirm-failed'};
      }
      return {absent: frame.absent === true, frame};
    },

    getSession(nonce) {
      return activeSessions.get(nonce) ?? null;
    },
  };
}
