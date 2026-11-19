"""Inert lifecycle fixture only. No inference or candidate execution."""
import json
import os
import select
import signal
import subprocess
import sys
import time


def identity(pid):
    try:
        raw = open(f'/proc/{pid}/stat').read()
        fields = raw[raw.rfind(')') + 2:].split()
        if fields[0] == 'Z':
            return None
        return {'pid': pid, 'birthIdentity': fields[19],
                'boot': open('/proc/sys/kernel/random/boot_id').read().strip()}
    except FileNotFoundError:
        return None


def matches(expected):
    return identity(expected['pid']) == expected


mode = sys.argv[1]
if mode == 'start':
    nonce = sys.argv[2]
    child = subprocess.Popen(['/usr/bin/python3', '-I', '-B', '-c', 'import time; time.sleep(40)'])
    record = {'nonce': nonce, 'birthIdentity': identity(os.getpid())['birthIdentity'],
              'parent': identity(os.getpid()), 'child': identity(child.pid)}
    print(json.dumps(record), flush=True)
    # Safety expiry bounds orphan lifetime even if the Windows controller vanishes.
    try:
        time.sleep(35)
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
elif mode == 'stop':
    record = json.loads(sys.argv[2])
    expected_nonce = sys.argv[3]
    if record['nonce'] != expected_nonce:
        print(json.dumps({'cleanup': 'unknown', 'reason': 'stale nonce'}))
        sys.exit(0)
    parent, child = record['parent'], record['child']
    # pidfds prevent PID reuse between validation and signal delivery.
    handles = []
    try:
        for expected in (child, parent):
            current = identity(expected['pid'])
            if current is None:
                continue
            fd = os.pidfd_open(expected['pid'])
            handles.append(fd)
            if not matches(expected):
                raise RuntimeError('identity mismatch')
        # Validate every identity before delivering any signal.
        for fd in handles:
            signal.pidfd_send_signal(fd, signal.SIGKILL)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and any(matches(item) for item in (parent, child)):
            time.sleep(.02)
        clean = not any(matches(item) for item in (parent, child))
        print(json.dumps({'cleanup': 'verified' if clean else 'unknown', 'inference': 'settled',
                          'synthetic': True}))
    except (OSError, RuntimeError):
        print(json.dumps({'cleanup': 'unknown', 'inference': 'unknown'}))
    finally:
        for fd in handles:
            os.close(fd)
