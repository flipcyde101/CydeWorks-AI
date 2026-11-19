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

const PROFILES = new Set(['inert-fixture', 'actual-opencode']);
const NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PID_NS_RE = /^pid:\[\d+\]$/;
const BOOT_ID_RE = /^[0-9A-Za-z._-]{1,128}$/;
const DIGITS_RE = /^\d+$/;
const FRAME_MAX = 8192;
const GUEST_WIN_PATH = fileURLToPath(new URL('./opencode-stop-guest.py', import.meta.url));

export function toWslPath(windowsPath) {
  if (windowsPath.startsWith('/')) return windowsPath;
  const drive = windowsPath[0].toLowerCase();
  return `/mnt/${drive}${windowsPath.slice(2).replaceAll('\\', '/')}`;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
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

function freezeTree(value) {
  if (!value || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) freezeTree(value[key]);
  return Object.freeze(value);
}

export function validateOwnedIdentity(identity, expectedNonce) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return false;
  if (identity.schema !== SCHEMA) return false;
  if (typeof identity.nonce !== 'string' || !NONCE_RE.test(identity.nonce)) return false;
  if (expectedNonce !== undefined && identity.nonce !== expectedNonce) return false;
  if (typeof identity.profile !== 'string' || !PROFILES.has(identity.profile)) return false;
  if (typeof identity.bootId !== 'string' || !BOOT_ID_RE.test(identity.bootId)) return false;
  if (!Number.isInteger(identity.uid) || identity.uid < 0) return false;
  if (!Number.isInteger(identity.depth) || identity.depth < 1) return false;
  for (const role of ['init', 'bwrap']) {
    const proc = identity[role];
    if (!proc || typeof proc !== 'object' || Array.isArray(proc)) return false;
    if (!Number.isInteger(proc.pid) || proc.pid <= 1) return false;
    if (typeof proc.start !== 'string' || !DIGITS_RE.test(proc.start)) return false;
    if (typeof proc.pidNs !== 'string' || !PID_NS_RE.test(proc.pidNs)) return false;
  }
  if (identity.init.pid === identity.bwrap.pid) return false;
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
    let stdoutBytes = 0;
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
      if (settled) return;
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stdoutBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.length;
      stdout += text;
      if (stdoutBytes > FRAME_MAX) {
        try { child.kill(); } catch {}
        finish(null);
      }
    });
    child.on('close', code => {
      if (code !== 0) {
        finish(null);
        return;
      }
      if (
        !stdout ||
        Buffer.byteLength(stdout, 'utf8') > FRAME_MAX ||
        !stdout.endsWith('\n') ||
        stdout.indexOf('\n') !== stdout.length - 1
      ) {
        finish(null);
        return;
      }
      try {
        finish(JSON.parse(stdout));
      } catch {
        finish(null);
      }
    });
    try {
      const encoded = JSON.stringify(payload) + '\n';
      if (Buffer.byteLength(encoded, 'utf8') > FRAME_MAX) {
        try { child.kill(); } catch {}
        finish(null);
        return;
      }
      child.stdin.end(encoded);
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
  const inFlightStops = new Map();

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
        if (Buffer.byteLength(buffer, 'utf8') > FRAME_MAX * 4) {
          try { child.stdin.end(); child.kill(); } catch {}
          notify(null, Error('Oversized supervisor frame buffer.'));
          return;
        }
        while (buffer.includes('\n')) {
          const idx = buffer.indexOf('\n');
          const rawLine = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (Buffer.byteLength(rawLine, 'utf8') + 1 > FRAME_MAX) {
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

      const nextFrame = (predicate, timeoutMs, timeoutMessage, transmit) =>
        new Promise((resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          if (stoppedFrame && predicate(stoppedFrame, null)) {
            resolve(stoppedFrame);
            return;
          }
          if (exitError) {
            reject(exitError);
            return;
          }
          const removeWaiter = entry => {
            const idx = waiters.indexOf(entry);
            if (idx >= 0) waiters.splice(idx, 1);
          };
          const onAbort = () => {
            clearTimeout(timer);
            removeWaiter(entry);
            reject(signal?.reason ?? Error('Startup aborted.'));
          };
          signal?.addEventListener('abort', onAbort, {once: true});
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            removeWaiter(entry);
            reject(Error(timeoutMessage));
          }, timeoutMs);
          const entry = {
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
          };
          waiters.push(entry);
          try {
            transmit?.();
          } catch (error) {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            removeWaiter(entry);
            reject(error);
          }
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
        const held = await nextFrame(
          f => f?.event === 'held' || f?.event === 'blocked',
          holdTimeoutMs,
          'Held identity deadline exceeded.',
          () => sendFrame(startFrame),
        );
        if (held.event === 'blocked') {
          throw Error(`Guest supervisor blocked: ${String(held.reason)}`);
        }
        const candidate = held.identity;
        if (
          held.nonce !== nonce ||
          !validateOwnedIdentity(candidate, nonce) ||
          candidate.profile !== profile
        ) {
          throw Error('Guest supervisor returned an invalid ownership identity.');
        }
        const computedDigest = digestIdentity(candidate);
        if (held.digest !== computedDigest) {
          throw Error('Guest supervisor returned an invalid ownership identity.');
        }
        heldIdentity = {
          ...candidate,
          identityDigest: computedDigest,
          qualificationScope: QUALIFICATION_SCOPE,
          synthetic: true,
        };

        session.identity = freezeTree(structuredClone(heldIdentity));
        signal?.throwIfAborted();
        // Durable persistence happens BEFORE releasing the held namespace.
        // The callback receives a copy. The private identity stays frozen.
        const recordResult = record(structuredClone(session.identity));
        if (recordResult !== undefined) {
          Promise.resolve(recordResult).catch(() => {});
          throw Error('Durable identity record must complete synchronously.');
        }
        signal?.throwIfAborted();

        const dispatched = await nextFrame(
          f => f?.event === 'dispatched' || f?.event === 'blocked',
          holdTimeoutMs,
          'Dispatch confirmation deadline exceeded.',
          () => sendFrame({op: 'dispatch', nonce, digest: computedDigest}),
        );
        if (dispatched.event !== 'dispatched' || dispatched.nonce !== nonce) {
          throw Error(`Guest dispatch rejected: ${String(dispatched.reason ?? 'unexpected frame')}`);
        }
        return structuredClone(heldIdentity);
      } catch (error) {
        if (heldIdentity) {
          await this.stopAndVerify(heldIdentity, nonce).catch(() => {});
        } else {
          try { child.stdin.end(); } catch {}
          let timer;
          try {
            await Promise.race([
              closedPromise,
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(Error('Startup abort cleanup timeout')), stopTimeoutMs);
              }),
            ]);
          } catch {
            try { child.kill(); } catch {}
          } finally {
            clearTimeout(timer);
          }
        }
        if (activeSessions.get(nonce) === session) activeSessions.delete(nonce);
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
      if (session && session.identity?.identityDigest !== expectedDigest) {
        return {cleanup: 'unknown', reason: 'session-identity-mismatch', qualificationScope: QUALIFICATION_SCOPE};
      }

      const flightKey = `${nonce}:${expectedDigest}`;
      const existing = inFlightStops.get(flightKey);
      if (existing) {
        return existing;
      }

      // Snapshot the private identity before any await. Later mutation of the
      // caller's object, or of a getSession view, cannot retarget this Stop.
      let stopIdentity;
      try {
        stopIdentity = structuredClone(session?.identity ?? identity);
      } catch {
        return {cleanup: 'unknown', reason: 'identity-unreadable', qualificationScope: QUALIFICATION_SCOPE};
      }

      const runStop = (async () => {
        let sessionStopped = null;
        if (session) {
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

        const outOfBand = await runOneshot(
          spawnGuest,
          'stop',
          {identity: stopIdentity, expectedNonce: nonce},
          stopTimeoutMs,
        );
        if (!outOfBand || outOfBand.event !== 'stopped' || outOfBand.cleanup !== 'verified') {
          return {
            cleanup: 'unknown',
            reason: outOfBand?.reason ?? outOfBand?.evidence?.reason ?? 'unverified-out-of-band-stop',
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

        const confirmed = await this.confirmAbsent(stopIdentity, nonce);
        if (!confirmed.absent) {
          return {
            cleanup: 'unknown',
            reason: confirmed.reason ?? 'confirm-absent-failed',
            evidence: {
              outOfBand: outOfBand.evidence ?? null,
              confirm: confirmed.frame ?? null,
            },
            qualificationScope: QUALIFICATION_SCOPE,
          };
        }

        return {
          cleanup: 'verified',
          evidence: {
            ...(outOfBand.evidence ?? sessionStopped?.evidence ?? {}),
            confirmedAbsent: true,
          },
          qualificationScope: QUALIFICATION_SCOPE,
        };
      })();

      inFlightStops.set(flightKey, runStop);
      try {
        return await runStop;
      } finally {
        if (inFlightStops.get(flightKey) === runStop) {
          inFlightStops.delete(flightKey);
          if (session && activeSessions.get(nonce) === session) activeSessions.delete(nonce);
        }
      }
    },

    async confirmAbsent(identity, nonce = identity?.nonce) {
      if (!validateOwnedIdentity(identity, nonce)) {
        return {absent: false, reason: 'stale-or-invalid-identity'};
      }
      const expectedDigest = digestIdentity(identity);
      if (identity.identityDigest && identity.identityDigest !== expectedDigest) {
        return {absent: false, reason: 'identity-digest-mismatch'};
      }
      const frame = await runOneshot(
        spawnGuest,
        'confirm',
        {identity, expectedNonce: nonce},
        stopTimeoutMs,
      );
      if (!frame || frame.event !== 'confirmed') {
        return {absent: false, reason: frame?.reason ?? 'confirm-failed', frame: frame ?? null};
      }
      return {
        absent: frame.absent === true,
        ...(frame.reason ? {reason: frame.reason} : {}),
        frame,
      };
    },

    getSession(nonce) {
      const session = activeSessions.get(nonce);
      if (!session) return null;
      // Public view only. No child, stdin, stdout, or the private identity object.
      return {
        nonce: session.nonce,
        qualificationScope: QUALIFICATION_SCOPE,
        ...(session.identity ? {identity: structuredClone(session.identity)} : {}),
      };
    },
  };
}
