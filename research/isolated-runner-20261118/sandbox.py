"""Launch the disposable pilot in a private Ubuntu WSL namespace.

Check-result integrity note:
The controller check interface is unchanged: stdin carries the case list and
stdout carries a JSON array of {value} or {error} objects. Candidate stdout is
not trusted. The guest must isolate it; this host accepts only one bounded,
single-line JSON object per case and fails closed on timeout, non-zero exit,
oversize output, trailing bytes, or any other ambiguous framing.

Complete verifier integrity is not established under the current trust model
while the candidate can still reach a guest result fd (for example through
/proc/self/fd). Passing values from this pilot remain research observations,
not sealed verifier proof.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import select
import socket
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parent
PYTHON = "/usr/bin/python3.12"
FILES = ("limits.py", "measurement.py")
CHECK_CASE_TIMEOUT = 3
CHECK_OUTPUT_MAX = 4096
PINNED = {
    "runner-bwrap": "e318903862396f96de3df57264e0158682b952fd3fb53ac23d876413e7b30f71",
    "runner-opencode": "9ca0b9953d49997601655e54f846a3efa464f237e47c6f1b04716d0f2e64c4c2",
}


def pinned(name):
    path = ROOT / name
    if not path.is_file() or path.is_symlink():
        raise RuntimeError("A pinned runner dependency is unavailable.")
    with path.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != PINNED[name]:
            raise RuntimeError("A runner dependency failed its digest check.")
    return str(path)


def command(mode, source=None, extra=()):
    args = [pinned("runner-bwrap"), "--unshare-all", "--unshare-user", "--disable-userns",
            "--die-with-parent", "--new-session", "--clearenv"]
    for path in ("/usr/lib/x86_64-linux-gnu", "/usr/lib64", "/usr/lib/python3.12", PYTHON):
        args += ["--ro-bind", path, path]
    args += ["--ro-bind", str(ROOT / "guest.py"), "/guest.py",
             "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
             "--dev", "/dev", "--proc", "/proc",
             "--size", "16777216", "--tmpfs", "/work",
             "--size", "33554432", "--tmpfs", "/tmp",
             "--size", "33554432", "--tmpfs", "/state",
             "--setenv", "HOME", "/state", "--setenv", "TMPDIR", "/tmp",
             "--setenv", "PATH", "/usr/bin", "--chdir", "/work"]
    if source is not None:
        if not source.is_dir() or source.is_symlink() or source.resolve().parent != ROOT:
            raise RuntimeError("The pilot source is outside its staging directory.")
        for name in FILES:
            path = source / name
            if not path.is_file() or path.is_symlink() or path.stat().st_size > 8192:
                raise RuntimeError("The pilot input is not a bounded regular file.")
            args += ["--ro-bind", str(path), "/input/" + name]
    if mode in ("generate", "version"):
        args += ["--ro-bind", pinned("runner-opencode"), "/opencode",
                 "--ro-bind", "/usr/bin/git", "/usr/bin/git",
                 "--ro-bind", "/usr/bin/dash", "/usr/bin/sh",
                 "--symlink", "usr/bin", "/bin"]
    return args + ["--", PYTHON, "-I", "-B", "/guest.py", mode, *extra]


def descendants(pid):
    file = Path(f"/proc/{pid}/task/{pid}/children")
    try:
        children = [int(child) for child in file.read_text().split()]
    except FileNotFoundError:
        return []
    return children + [nested for child in children for nested in descendants(child)]


def alive(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] != "Z"
    except FileNotFoundError:
        return False


def stop_probe():
    with subprocess.Popen(command("linger"), stdout=subprocess.PIPE, text=True) as process:
        try:
            if not select.select([process.stdout], [], [], 8)[0] or process.stdout.readline().strip() != "ready":
                raise RuntimeError("The disposable worker did not start.")
            children = descendants(process.pid)
            if len(children) < 2:
                raise RuntimeError("The process tree was not observed prior to Stop.")
            process.kill()
            process.wait(timeout=5)
            deadline = time.monotonic() + 4
            while any(alive(pid) for pid in children) and time.monotonic() < deadline:
                time.sleep(0.05)
            return not any(alive(pid) for pid in children)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)


def qualify():
    marker = ROOT / "host-marker.txt"
    saved = marker.read_bytes()
    os.environ["CYDEWORKS_SYNTHETIC_PARENT_MARKER"] = "outside-worker"
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(2)
        port = listener.getsockname()[1]
        with socket.create_connection(("127.0.0.1", port), timeout=2), listener.accept()[0]:
            pass
        result = subprocess.run(command("probe", ROOT / "fixture-repo", (str(marker), str(port))),
                                text=True, stdout=subprocess.PIPE, check=True, timeout=16)
    cuts = json.loads(result.stdout)
    cuts["ownedProcessTreeStopped"] = stop_probe()
    cuts["outsideMarkerPreserved"] = marker.read_bytes() == saved
    limits = subprocess.run(command("check-limits"), text=True, stdout=subprocess.PIPE, check=True, timeout=8)
    cuts.update(json.loads(limits.stdout))
    print(json.dumps(cuts, sort_keys=True), flush=True)
    return all(cuts.values())


def parse_check_outcome(raw):
    """Parse one guest check frame. Reject trailing data and non-value shapes."""
    if not raw or len(raw) > CHECK_OUTPUT_MAX:
        raise ValueError("Check process did not return a bounded result.")
    if not raw.endswith(b"\n") or raw.count(b"\n") != 1:
        raise ValueError("Check evidence framing is invalid.")
    value = json.loads(raw)
    if not isinstance(value, dict) or set(value) != {"value"} or type(value["value"]) is not int:
        raise ValueError("The check result is invalid.")
    return value


def verify_cases(source):
    cases = json.loads(sys.stdin.buffer.readline(32769))
    if not isinstance(cases, list) or not 1 <= len(cases) <= 16:
        raise RuntimeError("Protected check inputs are invalid.")
    outcomes = []
    for case in cases:
        with os.fdopen(os.memfd_create("cydeworks-check-output"), "w+b") as output:
            try:
                completed = subprocess.run(command("invoke", source), input=json.dumps(case).encode() + b"\n",
                                           stdout=output, stderr=subprocess.DEVNULL, check=False,
                                           timeout=CHECK_CASE_TIMEOUT)
            except subprocess.TimeoutExpired:
                outcomes.append({"error": "timeout"})
                continue
            output.seek(0)
            raw = output.read(CHECK_OUTPUT_MAX + 1)
        try:
            if completed.returncode != 0:
                raise ValueError("Check process did not return a bounded result.")
            outcomes.append(parse_check_outcome(raw))
        except (ValueError, json.JSONDecodeError):
            outcomes.append({"error": "failed"})
    print(json.dumps(outcomes, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "qualify":
        sys.exit(0 if qualify() else 1)
    if mode == "check":
        name = sys.argv[2]
        if name != "fixture-repo" and not re.fullmatch(r"candidate-[A-Za-z0-9]{6}", name):
            raise RuntimeError("Select a pilot candidate directory.")
        verify_cases(ROOT / name)
        sys.exit(0)
    if mode in ("generate", "version"):
        args = command(mode, ROOT / "fixture-repo" if mode == "generate" else None)
        seconds = "105s" if mode == "generate" else "8s"
    else:
        raise RuntimeError("Unknown pilot operation.")
    os.execv("/usr/bin/timeout", ["timeout", "--kill-after=2s", seconds, *args])
