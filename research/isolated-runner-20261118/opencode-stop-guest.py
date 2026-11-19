"""WSL-side ownership supervisor for the disconnected OpenCode Stop adapter.

Research only. Not wired into pilot.mjs. The actual OpenCode profile is
refused by a constant gate; only the inert fixture profile can dispatch.

The supervisor runs as the unprivileged WSL launcher user and owns exactly one
bubblewrap PID namespace per process lifetime:

1. bwrap starts with --info-fd and --block-fd, so the namespace exists but the
   workload command is held before exec.
2. The supervisor opens a pidfd on the namespace init, verifies its identity
   (boot id, PID, start time, PID namespace) and emits a "held" frame.
3. The workload is released only after the Windows controller returns the
   exact identity digest, which it sends only after its durable record fsyncs.
4. Stop signals the namespace init through the verified pidfd. The kernel then
   terminates every process in that PID namespace. Cleanup is "verified" only
   when the pidfd reports exit and a scan finds no remaining member.

Control frames come only from this supervisor. Workload stdout is JSON-encoded
inside "workload" frames, so workload bytes can never be read as control.
Any ambiguity yields cleanup "unknown". Nothing here retries a dispatch.
"""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parent
SCHEMA = "cydeworks.opencode-stop.v1"
FRAME_MAX = 8192
WORKLOAD_LINE_MAX = 4096
WORKLOAD_FRAMES_MAX = 512
PROFILES = ("inert-fixture", "actual-opencode")
# Real OpenCode dispatch stays disabled until the Stop and verifier gates pass
# independent review. Changing this constant is out of scope for this change.
ACTUAL_OPENCODE_DISPATCH_ENABLED = False
HOLD_SECONDS = 10.0
LIFETIME_SECONDS = {"inert-fixture": 30.0, "actual-opencode": 110.0}
EXIT_WAIT_SECONDS = 3.0
SETTLE_SECONDS = 2.0
NONCE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
PID_NS_RE = re.compile(r"^pid:\[\d+\]$")
BOOT_ID_RE = re.compile(r"^[0-9A-Za-z._-]{1,128}$")
PAYLOAD = "opencode-stop-payload.py"


class Ambiguous(Exception):
    """Process state could not be classified. Callers must report unknown."""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


class Proc:
    """Minimal /proc reader. The root is injectable for fixture tests."""

    def __init__(self, root="/proc"):
        self.root = Path(root)

    def stat(self, pid):
        raw = (self.root / str(pid) / "stat").read_text()
        end = raw.rfind(")")
        if end < 0 or raw[end:end + 2] != ") ":
            raise ValueError("malformed stat")
        rest = raw[end + 2:].split()
        if len(rest) <= 19 or not rest[19].isdigit():
            raise ValueError("malformed stat fields")
        return {"state": rest[0], "ppid": int(rest[1]), "start": rest[19]}

    def pid_ns(self, pid):
        return os.readlink(self.root / str(pid) / "ns" / "pid")

    def status(self, pid):
        fields = {}
        for line in (self.root / str(pid) / "status").read_text().splitlines():
            key, _, value = line.partition(":")
            fields[key] = value.split()
        return fields

    def boot_id(self):
        return (self.root / "sys" / "kernel" / "random" / "boot_id").read_text().strip()

    def pids(self):
        return [int(name) for name in os.listdir(self.root) if name.isdigit()]


class Ops:
    """Kernel operations. Replaced by recording fakes in unit tests."""

    pidfd_open = staticmethod(os.pidfd_open)
    close = staticmethod(os.close)

    @staticmethod
    def kill(fd):
        signal.pidfd_send_signal(fd, signal.SIGKILL)

    @staticmethod
    def exited(fd, seconds):
        return bool(select.select([fd], [], [], max(0.0, seconds))[0])


def identify(proc, pid):
    """Return the live identity of pid, or None if it is gone or a zombie."""
    try:
        state = proc.stat(pid)
        if state["state"] in ("Z", "X"):
            return None
        return {"pid": pid, "start": state["start"], "pidNs": proc.pid_ns(pid)}
    except (FileNotFoundError, ProcessLookupError):
        return None
    except (OSError, ValueError, IndexError) as error:
        raise Ambiguous(f"identity unreadable for {pid}: {type(error).__name__}") from error


def same(current, expected):
    return current is not None and all(current[key] == expected[key] for key in ("pid", "start", "pidNs"))


def matches_expected(proc, expected, uid=None):
    """Return True if expected['pid'] is still the exact recorded process, False if absent or reused.

    Checks /proc/<pid>/stat before /proc/<pid>/ns/pid so a PID reused by another
    UID with a different start time is proven absent rather than failing with
    PermissionError on ns/pid. Any inconclusive read raises Ambiguous.
    """
    pid = expected["pid"]
    try:
        state = proc.stat(pid)
    except (FileNotFoundError, ProcessLookupError):
        return False
    except (OSError, ValueError, IndexError) as error:
        raise Ambiguous(f"stat unreadable for {pid}: {type(error).__name__}") from error
    if state["state"] in ("Z", "X"):
        return False
    if state["start"] != expected["start"]:
        return False
    try:
        current_ns = proc.pid_ns(pid)
    except (FileNotFoundError, ProcessLookupError):
        return False
    except PermissionError as error:
        if uid is not None:
            try:
                status = proc.status(pid)
                uids = status.get("Uid")
                if not uids:
                    raise Ambiguous(f"uid unreadable for {pid}") from error
                if str(uid) not in uids:
                    return False
            except (FileNotFoundError, ProcessLookupError):
                return False
            except (OSError, ValueError, IndexError) as status_error:
                raise Ambiguous(f"status unreadable for {pid}: {type(status_error).__name__}") from status_error
        raise Ambiguous(f"namespace unreadable for {pid}: PermissionError") from error
    except (OSError, ValueError) as error:
        raise Ambiguous(f"namespace unreadable for {pid}: {type(error).__name__}") from error
    return current_ns == expected["pidNs"]


def open_verified(proc, expected, ops, uid=None):
    """Open a pidfd, then verify identity. Returns (fd, state).

    state is "owned" (fd refers to the expected process), or "absent" (the
    expected process no longer exists; any process now holding that PID is a
    different process and is never signalled). Verifying after pidfd_open
    closes the PID reuse window: a pidfd never follows a reused PID.
    """
    try:
        fd = ops.pidfd_open(expected["pid"])
    except ProcessLookupError:
        return None, "absent"
    except OSError as error:
        raise Ambiguous(f"pidfd_open failed: {type(error).__name__}") from error
    try:
        if matches_expected(proc, expected, uid=uid):
            return fd, "owned"
    except Ambiguous:
        ops.close(fd)
        raise
    ops.close(fd)
    return None, "absent"


def namespace_members(proc, pid_ns, uid, depth):
    """List live processes in pid_ns. Sound for processes owned by uid.

    Every sandbox member runs as the single mapped launcher uid, so other
    uids cannot be members. Any unreadable uid-owned process, missing Uid/NSpid
    field, or uid-owned process deeper than a direct sandbox member is reported
    as ambiguous.
    """
    members, ambiguous = [], []
    for pid in proc.pids():
        try:
            status = proc.status(pid)
            uids = status.get("Uid")
            if not uids:
                ambiguous.append(pid)
                continue
            if str(uid) not in uids:
                continue
            if status.get("State", ["?"])[0] in ("Z", "X"):
                continue
            nspid = status.get("NSpid")
            if not nspid:
                ambiguous.append(pid)
                continue
            if proc.pid_ns(pid) == pid_ns:
                members.append(pid)
            elif len(nspid) > depth + 1:
                ambiguous.append(pid)
        except (FileNotFoundError, ProcessLookupError):
            continue
        except (OSError, ValueError, IndexError):
            ambiguous.append(pid)
    return sorted(members), sorted(ambiguous)


def validate_identity(identity):
    """Shape check for identities read back from a controller journal."""
    if not isinstance(identity, dict) or identity.get("schema") != SCHEMA:
        raise ValueError("identity schema")
    nonce = identity.get("nonce")
    if not isinstance(nonce, str) or not NONCE.match(nonce):
        raise ValueError("identity nonce")
    if identity.get("profile") not in PROFILES:
        raise ValueError("identity profile")
    for name in ("init", "bwrap"):
        item = identity.get(name)
        if not isinstance(item, dict) or type(item.get("pid")) is not int or item["pid"] <= 1:
            raise ValueError(f"identity {name}")
        if not isinstance(item.get("start"), str) or not item["start"].isdigit():
            raise ValueError(f"identity {name}")
        if not isinstance(item.get("pidNs"), str) or not PID_NS_RE.match(item["pidNs"]):
            raise ValueError(f"identity {name}")
    if identity["init"]["pid"] == identity["bwrap"]["pid"]:
        raise ValueError("identity init and bwrap pids collide")
    if identity["init"]["pidNs"] == identity["bwrap"]["pidNs"]:
        raise ValueError("identity namespace is not private")
    if type(identity.get("uid")) is not int or identity["uid"] < 0:
        raise ValueError("identity uid")
    if type(identity.get("depth")) is not int or identity["depth"] < 1:
        raise ValueError("identity depth")
    boot_id = identity.get("bootId")
    if not isinstance(boot_id, str) or not BOOT_ID_RE.match(boot_id):
        raise ValueError("identity boot")
    expected = f"{boot_id}:{identity['init']['pid']}:{identity['init']['start']}:{identity['init']['pidNs']}"
    if identity.get("birthIdentity") != expected:
        raise ValueError("identity birth")
    return identity


def stop_identity(proc, identity, ops, init_fd=None, expected_nonce=None, wait=EXIT_WAIT_SECONDS, settle=SETTLE_SECONDS):
    """Stop the namespace named by identity and report evidence.

    Never signals a process whose identity cannot be proven. Repeated or
    stale calls are harmless: a stale expected_nonce returns unknown without
    signalling, a stopped namespace verifies as absent, and a reused PID never
    matches the recorded start time and namespace.
    """
    evidence = {"signalled": [], "bootChanged": False}
    try:
        validate_identity(identity)
        if expected_nonce is not None and identity["nonce"] != expected_nonce:
            evidence["reason"] = "stale-nonce"
            return {"cleanup": "unknown", "evidence": evidence}
        if proc.boot_id() != identity["bootId"]:
            # A different kernel boot cannot host the recorded processes.
            evidence["bootChanged"] = True
            return {"cleanup": "verified", "evidence": evidence}
        handles = []
        try:
            if init_fd is not None:
                evidence["init"] = "owned-fd"
                handles.append(("init", init_fd, False))
            for name in ("init", "bwrap"):
                if name == "init" and init_fd is not None:
                    continue
                fd, state = open_verified(proc, identity[name], ops, uid=identity["uid"])
                evidence[name] = state
                if fd is not None:
                    handles.append((name, fd, True))
            # Every identity is validated before any signal is delivered.
            for name, fd, _ in handles:
                try:
                    ops.kill(fd)
                    evidence["signalled"].append(name)
                except ProcessLookupError:
                    pass
            deadline = time.monotonic() + wait
            for name, fd, _ in handles:
                if not ops.exited(fd, deadline - time.monotonic()):
                    evidence["exitTimeout"] = name
                    return {"cleanup": "unknown", "evidence": evidence}
        finally:
            for _, fd, owned in handles:
                if owned:
                    ops.close(fd)
        deadline = time.monotonic() + settle
        while True:
            members, ambiguous = namespace_members(proc, identity["init"]["pidNs"], identity["uid"], identity["depth"])
            if not members and not ambiguous:
                break
            if time.monotonic() >= deadline:
                evidence["remaining"] = members
                evidence["ambiguous"] = ambiguous
                return {"cleanup": "unknown", "evidence": evidence}
            time.sleep(0.02)
        for name in ("init", "bwrap"):
            if matches_expected(proc, identity[name], uid=identity["uid"]):
                evidence["survivor"] = name
                return {"cleanup": "unknown", "evidence": evidence}
        return {"cleanup": "verified", "evidence": evidence}
    except (Ambiguous, ValueError, OSError, KeyError, TypeError) as error:
        evidence["error"] = type(error).__name__
        return {"cleanup": "unknown", "evidence": evidence}


def confirm_identity(proc, identity, expected_nonce=None):
    """Read-only check that the recorded namespace no longer exists."""
    try:
        validate_identity(identity)
        if expected_nonce is not None and identity["nonce"] != expected_nonce:
            return {"absent": False, "reason": "stale-nonce"}
        if proc.boot_id() != identity["bootId"]:
            return {"absent": True, "bootChanged": True}
        for name in ("init", "bwrap"):
            if matches_expected(proc, identity[name], uid=identity["uid"]):
                return {"absent": False, "survivor": name}
        members, ambiguous = namespace_members(proc, identity["init"]["pidNs"], identity["uid"], identity["depth"])
        return {"absent": not members and not ambiguous, "remaining": members, "ambiguous": ambiguous}
    except (Ambiguous, ValueError, OSError, KeyError, TypeError) as error:
        return {"absent": False, "error": type(error).__name__}


def load_sandbox():
    spec = importlib.util.spec_from_file_location("cydeworks_pilot_sandbox", ROOT / "sandbox.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def pinned_bwrap(sandbox, path):
    """Reject any bwrap other than the binary pinned in sandbox.py."""
    path = Path(path)
    if not path.is_file() or path.is_symlink():
        raise RuntimeError("BLOCKED: pinned runner-bwrap unavailable")
    with path.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != sandbox.PINNED["runner-bwrap"]:
            raise RuntimeError("BLOCKED: runner-bwrap digest differs from sandbox.py")
    return str(path)


def build_command(profile, sandbox, bwrap, info_fd, block_fd, payload=None):
    """Build the bwrap argv for a profile with the hold and identity fds.

    Reuses sandbox.command() so the namespace flags, mounts and pinned
    dependency checks stay identical to the pilot. The pilot's outer
    `timeout` wrapper is replaced by the supervisor's own hold and lifetime
    bounds, because the supervisor must be the direct parent of bwrap.
    """
    original = sandbox.pinned
    sandbox.pinned = lambda name: bwrap if name == "runner-bwrap" else original(name)
    try:
        if profile == "actual-opencode":
            if not ACTUAL_OPENCODE_DISPATCH_ENABLED:
                raise RuntimeError("BLOCKED: actual OpenCode dispatch disabled pending qualification")
            args = sandbox.command("generate", ROOT / "fixture-repo")
        elif profile == "inert-fixture":
            args = sandbox.command("linger")
            split = args.index("--")
            payload = Path(payload or ROOT / PAYLOAD)
            if not payload.is_file() or payload.is_symlink():
                raise RuntimeError("BLOCKED: inert payload unavailable")
            args = args[:split] + ["--ro-bind", str(payload), "/stop-payload.py", "--",
                                   sandbox.PYTHON, "-I", "-B", "/stop-payload.py"]
        else:
            raise RuntimeError("BLOCKED: unknown profile")
    finally:
        sandbox.pinned = original
    if args[0] != bwrap or "--unshare-all" not in args or "--die-with-parent" not in args:
        raise RuntimeError("BLOCKED: unexpected sandbox launcher")
    return [bwrap, "--info-fd", str(info_fd), "--block-fd", str(block_fd), *args[1:]]


def read_info(fd, seconds):
    """Read bwrap's --info-fd JSON object, bounded in size and time.

    Parses as soon as a complete object arrives, so it does not depend on
    every inheritor closing the descriptor.
    """
    data, deadline = b"", time.monotonic() + seconds
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise RuntimeError("BLOCKED: bwrap identity timeout")
        chunk = os.read(fd, FRAME_MAX)
        if not chunk:
            raise RuntimeError("BLOCKED: bwrap identity truncated")
        data += chunk
        if len(data) > FRAME_MAX:
            raise RuntimeError("BLOCKED: bwrap identity oversized")
        try:
            info = json.loads(data)
            break
        except ValueError:
            continue
    pid = info.get("child-pid") if isinstance(info, dict) else None
    if type(pid) is not int or pid <= 1:
        raise RuntimeError("BLOCKED: bwrap child identity invalid")
    namespace = info.get("pid-namespace")
    if namespace is not None and type(namespace) is not int:
        raise RuntimeError("BLOCKED: bwrap namespace identity invalid")
    return pid, namespace


class Supervisor:
    """One supervisor instance owns at most one namespace, then exits."""

    def __init__(self, emit, proc=None, ops=Ops, bwrap=None, payload=None, sandbox=None,
                 hold=HOLD_SECONDS, lifetime=None):
        self.emit = emit
        self.proc = proc or Proc()
        self.ops = ops
        self.sandbox = sandbox or load_sandbox()
        self.bwrap_path = bwrap
        self.bwrap = None
        self.payload = payload
        self.hold = hold
        self.lifetime = lifetime
        self.process = None
        self.init_fd = None
        self.identity = None
        self.release_fd = None
        self.dispatched = False
        self.used = False

    def start(self, nonce, profile, bwrap=None):
        if self.used:
            raise RuntimeError("BLOCKED: supervisor already used")
        self.used = True
        if not NONCE.match(str(nonce)) or profile not in PROFILES:
            raise RuntimeError("BLOCKED: invalid start request")
        if profile == "actual-opencode" and not ACTUAL_OPENCODE_DISPATCH_ENABLED:
            raise RuntimeError("BLOCKED: actual OpenCode dispatch disabled pending qualification")
        self.bwrap = pinned_bwrap(self.sandbox, bwrap or self.bwrap_path or ROOT / "runner-bwrap")
        self.profile = profile
        self.lifetime = self.lifetime or LIFETIME_SECONDS[profile]
        info_read, info_write = os.pipe()
        block_read, block_write = os.pipe()
        self.release_fd = block_write
        try:
            argv = build_command(profile, self.sandbox, self.bwrap, info_write, block_read, self.payload)
            self.process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                            stderr=subprocess.DEVNULL, pass_fds=(info_write, block_read),
                                            close_fds=True, bufsize=0)
        finally:
            os.close(info_write)
            os.close(block_read)
        try:
            pid, reported_ns = read_info(info_read, self.hold)
        finally:
            os.close(info_read)
        # The init is an unreaped child of our bwrap child, so its PID cannot be
        # reused yet. Open the pidfd first, then verify parentage and namespace.
        self.init_fd = self.ops.pidfd_open(pid)
        state = self.proc.stat(pid)
        if state["ppid"] != self.process.pid or state["state"] in ("Z", "X"):
            raise RuntimeError("BLOCKED: namespace init parentage mismatch")
        init = identify(self.proc, pid)
        bwrap = identify(self.proc, self.process.pid)
        own_ns = self.proc.pid_ns(os.getpid())
        if init is None or bwrap is None or init["pidNs"] == bwrap["pidNs"] or bwrap["pidNs"] != own_ns:
            raise RuntimeError("BLOCKED: namespace identity unavailable or not private")
        if reported_ns is not None and init["pidNs"] != f"pid:[{reported_ns}]":
            raise RuntimeError("BLOCKED: bwrap and /proc disagree on the namespace")
        boot = self.proc.boot_id()
        depth = len(self.proc.status(os.getpid()).get("NSpid", []))
        if depth < 1:
            raise RuntimeError("BLOCKED: namespace depth unavailable")
        self.identity = {"schema": SCHEMA, "nonce": nonce, "profile": profile, "bootId": boot,
                         "uid": os.getuid(), "depth": depth,
                         "supervisor": identify(self.proc, os.getpid()), "bwrap": bwrap, "init": init,
                         "birthIdentity": f"{boot}:{init['pid']}:{init['start']}:{init['pidNs']}"}
        validate_identity(self.identity)
        self.emit({"event": "held", "nonce": nonce, "identity": self.identity, "digest": digest(self.identity)})

    def dispatch(self, nonce, identity_digest):
        if self.identity is None or self.dispatched or nonce != self.identity["nonce"]:
            raise RuntimeError("BLOCKED: dispatch without held identity")
        if identity_digest != digest(self.identity):
            raise RuntimeError("BLOCKED: controller did not record this identity")
        if not same(identify(self.proc, self.identity["init"]["pid"]), self.identity["init"]):
            raise RuntimeError("BLOCKED: namespace changed before dispatch")
        os.write(self.release_fd, b"1")
        os.close(self.release_fd)
        self.release_fd = None
        self.dispatched = True
        self.emit({"event": "dispatched", "nonce": nonce})

    def stop(self, reason):
        if self.release_fd is not None:
            os.close(self.release_fd)
            self.release_fd = None
        if self.identity is None:
            # No complete identity: kill only our own bwrap child by handle and
            # report unknown, because namespace members were never identified.
            if self.process and self.process.poll() is None:
                self.process.kill()
            result = {"cleanup": "unknown", "evidence": {"reason": "identity-incomplete"}}
        else:
            result = stop_identity(self.proc, self.identity, self.ops, init_fd=self.init_fd)
        if self.process:
            try:
                self.process.wait(timeout=EXIT_WAIT_SECONDS)
            except subprocess.TimeoutExpired:
                result = {"cleanup": "unknown", "evidence": {**result.get("evidence", {}), "bwrapWait": "timeout"}}
            if self.process.stdout and not self.process.stdout.closed:
                self.process.stdout.close()
        if self.init_fd is not None:
            self.ops.close(self.init_fd)
            self.init_fd = None
        result["evidence"]["reason"] = reason
        self.emit({"event": "stopped", "nonce": self.identity and self.identity["nonce"], **result})
        return result


def read_frame(stream):
    line = stream.readline(FRAME_MAX + 1)
    if not line:
        return None
    if len(line) > FRAME_MAX or not line.endswith(b"\n"):
        raise RuntimeError("BLOCKED: control frame invalid")
    frame = json.loads(line)
    if not isinstance(frame, dict) or not isinstance(frame.get("op"), str):
        raise RuntimeError("BLOCKED: control frame invalid")
    return frame


def write_frame(frame):
    data = canonical(frame).encode() + b"\n"
    if len(data) > FRAME_MAX:
        data = canonical({"event": "blocked", "reason": "frame too large"}).encode() + b"\n"
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def serve(stdin=None, emit=write_frame, **options):
    """Serve one ownership session over NDJSON stdin and stdout.

    Stdin EOF, an invalid frame, hold expiry, or lifetime expiry all Stop.
    """
    stdin = stdin or sys.stdin.buffer
    supervisor = None
    reason = "eof"
    try:
        frame = read_frame(stdin)
        if frame is None or frame["op"] != "start":
            raise RuntimeError("BLOCKED: start frame required")
        supervisor = Supervisor(emit, **options)
        supervisor.start(frame.get("nonce"), frame.get("profile"), frame.get("bwrap"))
        started = time.monotonic()
        relayed = 0
        workload = supervisor.process.stdout
        while True:
            limit = supervisor.hold if not supervisor.dispatched else supervisor.lifetime
            remaining = started + limit - time.monotonic()
            if remaining <= 0:
                reason = "hold-expired" if not supervisor.dispatched else "lifetime-expired"
                break
            streams = [stdin] + ([workload] if supervisor.dispatched and workload else [])
            ready = select.select(streams, [], [], remaining)[0]
            if workload in ready:
                line = workload.readline(WORKLOAD_LINE_MAX + 1)
                if not line:
                    workload = None
                elif relayed < WORKLOAD_FRAMES_MAX:
                    relayed += 1
                    emit({"event": "workload", "data": line[:WORKLOAD_LINE_MAX].decode("utf-8", "replace")})
            if stdin in ready:
                frame = read_frame(stdin)
                if frame is None:
                    reason = "eof"
                    break
                if frame["op"] == "dispatch":
                    supervisor.dispatch(frame.get("nonce"), frame.get("digest"))
                    started = time.monotonic()
                elif frame["op"] == "stop" and frame.get("nonce") == supervisor.identity["nonce"]:
                    reason = "stop"
                    break
                else:
                    reason = "invalid-frame"
                    break
    except Exception as error:  # Any failure stops the owned namespace.
        reason = "blocked"
        emit({"event": "blocked", "reason": str(error)[:500]})
    finally:
        if supervisor is not None and supervisor.process is not None:
            supervisor.stop(reason)
    return 0


def oneshot(op):
    """Out-of-band confirm or stop for a fresh controller. Identity on stdin."""
    try:
        identity = json.loads(sys.stdin.buffer.readline(FRAME_MAX + 1))
        if op == "confirm":
            write_frame({"event": "confirmed", **confirm_identity(Proc(), identity)})
        else:
            write_frame({"event": "stopped", **stop_identity(Proc(), identity, Ops)})
    except Exception as error:
        write_frame({"event": "blocked", "reason": type(error).__name__})
    return 0


if __name__ == "__main__":
    mode = sys.argv[1:] or ["serve"]
    if mode == ["serve"]:
        sys.exit(serve())
    if mode in (["confirm"], ["stop"]):
        sys.exit(oneshot(mode[0]))
    write_frame({"event": "blocked", "reason": "unknown mode"})
    sys.exit(2)
