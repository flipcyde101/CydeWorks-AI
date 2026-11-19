"""Fixed inert namespace fixture. Stdin EOF is the only Stop command."""
import ast
import hashlib
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent

def pinned():
    tree = ast.parse((ROOT / 'sandbox.py').read_text())
    pins = [ast.literal_eval(n.value) for n in tree.body
            if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'PINNED' for t in n.targets)]
    binary = ROOT / 'runner-bwrap'
    if len(pins) != 1 or binary.is_symlink() or not binary.is_file():
        raise RuntimeError('BLOCKED: preexisting pinned runner-bwrap unavailable')
    if hashlib.sha256(binary.read_bytes()).hexdigest() != pins[0]['runner-bwrap']:
        raise RuntimeError('BLOCKED: runner-bwrap hash differs from sandbox.py')
    return str(binary)

def identity(pid):
    fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
    return {'pid': pid, 'birth': fields[19], 'namespace': os.readlink(f'/proc/{pid}/ns/pid')}

def main():
    binary = pinned()
    args = [binary, '--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent',
            '--new-session', '--clearenv']
    for path in ('/usr/lib/x86_64-linux-gnu', '/usr/lib64', '/usr/lib/python3.12', '/usr/bin/python3.12'):
        args += ['--ro-bind', path, path]
    args += ['--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
             '--proc', '/proc', '--dev', '/dev', '--', '/usr/bin/python3.12', '-I', '-B', '-c',
             'import os,time; print(os.getpid(),flush=True); time.sleep(30)']
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        ready = select.select([process.stdout], [], [], 5)[0]
        frame = process.stdout.readline() if ready else b''
        if not frame.strip().isdigit():
            process.kill() if process.poll() is None else None
            process.wait(timeout=3)
            detail = process.stderr.read(1024).decode('utf-8', 'replace')
            raise RuntimeError('BLOCKED: private PID namespace startup failed: ' + detail.strip())
        children = Path(f'/proc/{process.pid}/task/{process.pid}/children').read_text().split()
        if not children:
            raise RuntimeError('BLOCKED: namespace child identity unavailable')
        child = identity(int(children[0]))
        if child['namespace'] == identity(process.pid)['namespace']:
            raise RuntimeError('BLOCKED: child PID namespace is not private')
        fd = os.pidfd_open(child['pid'])
        try:
            if identity(child['pid']) != child:
                raise RuntimeError('namespace identity changed')
            print(json.dumps({'event': 'ready', 'worker': identity(process.pid), 'child': child}), flush=True)
            # EOF, controller disappearance, or expiry all stop only this owned process.
            select.select([sys.stdin], [], [], 20)
            process.kill()
            process.wait(timeout=3)
            exited = bool(select.select([fd], [], [], 3)[0])
            print(json.dumps({'event': 'stopped', 'cleanup': 'verified' if exited else 'unknown'}), flush=True)
        finally:
            os.close(fd)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=3)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'event': 'blocked', 'reason': str(error)}), flush=True)
        sys.exit(1)
