"""WSL-side ownership supervisor for the disconnected OpenCode Stop adapter.

Research only. Not wired into pilot.mjs. The actual OpenCode profile is
refused by a constant gate; only the inert fixture profile can dispatch.

The supervisor runs as the unprivileged WSL launcher user and owns exactly one
bubblewrap PID namespace per process lifetime:

1. bwrap starts with --info-fd. Its command is a fixed trusted bootstrap.
   The inert payload is mounted read-only and is not executed yet.
2. The supervisor opens a pidfd on the namespace init and verifies parentage,
   boot id, PID, start time, and PID namespace before that pidfd may be
   signalled. A failed check closes the candidate. Stop then handles only the
   directly owned launcher.
3. The bootstrap reads one line from the supervisor pipe. It executes the
   payload only for the exact release token. EOF and every other input exit
   without executing the payload. Bubblewrap --block-fd is not a release gate.
4. Stop signals the namespace init only through a pidfd that still matches the
   recorded identity. The kernel then terminates every process in that PID
   namespace. Cleanup is "verified" only when the pidfd reports exit and a
   scan finds no remaining member.

Control frames come only from this supervisor. Workload stdout is JSON-encoded
inside "workload" frames, so workload bytes can never be read as control.
Guest stdout writes are bounded. A lost or backed-up reader cannot stall
cleanup or the hold and lifetime deadlines. A frame that cannot be written
inside that bound is dropped for the rest of the session. Healthy output
remains one NDJSON object per line.
Any ambiguity yields cleanup "unknown". Nothing here retries a dispatch.
"""

from collections import deque
import errno
import fcntl
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
OUTPUT_WRITE_SECONDS = 0.25
RELEASE_TOKEN = b"cydeworks-release-v1\n"
BOOTSTRAP_PAYLOAD = "/stop-payload.py"
BOOTSTRAP_GUEST = "/stop-guest.py"
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

    @staticmethod
    def pidfd_pid(fd):
        """Return the PID named by this pidfd, or raise OSError if it is unreadable."""
        raw = Path(f"/proc/self/fdinfo/{fd}").read_text()
        for line in raw.splitlines():
            if line.startswith("Pid:"):
                value = line.split(":", 1)[1].strip()
                if value.isdigit():
                    return int(value)
                break
        raise OSError("pidfd pid unreadable")


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


def init_fd_verified(proc, ops, fd, expected, uid):
    """Return True only when fd still names the recorded init process.

    An unreadable or mismatched pidfd is not a signalling handle. Ambiguous
    /proc reads propagate so the caller reports cleanup unknown.
    """
    try:
        target = ops.pidfd_pid(fd)
    except (AttributeError, OSError, ValueError):
        return False
    if type(target) is not int or target != expected["pid"]:
        return False
    return matches_expected(proc, expected, uid=uid)


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
            verified_init = False
            if init_fd is not None:
                if init_fd_verified(proc, ops, init_fd, identity["init"], identity["uid"]):
                    evidence["init"] = "owned-fd"
                    handles.append(("init", init_fd, False))
                    verified_init = True
                else:
                    evidence["initFd"] = "rejected"
            for name in ("init", "bwrap"):
                if name == "init" and verified_init:
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


def build_command(profile, sandbox, bwrap, info_fd, payload=None, guest=None):
    """Build the bwrap argv for a profile with the identity fd.

    Reuses sandbox.command() so the namespace flags, mounts and pinned
    dependency checks stay identical to the pilot. The pilot's outer
    `timeout` wrapper is replaced by the supervisor's own hold and lifetime
    bounds, because the supervisor must be the direct parent of bwrap.
    The inert profile runs a fixed bootstrap. The payload is mounted
    read-only and is not the program after `--`. Bubblewrap --block-fd is
    not a release gate.
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
            payload_path = Path(payload or ROOT / PAYLOAD)
            guest_path = Path(guest or ROOT / "opencode-stop-guest.py")
            if not payload_path.is_file() or payload_path.is_symlink():
                raise RuntimeError("BLOCKED: inert payload unavailable")
            if not guest_path.is_file() or guest_path.is_symlink():
                raise RuntimeError("BLOCKED: trusted bootstrap unavailable")
            args = args[:split] + [
                "--ro-bind", str(guest_path), BOOTSTRAP_GUEST,
                "--ro-bind", str(payload_path), BOOTSTRAP_PAYLOAD,
                "--",
                sandbox.PYTHON, "-I", "-B", BOOTSTRAP_GUEST, "bootstrap",
            ]
        else:
            raise RuntimeError("BLOCKED: unknown profile")
    finally:
        sandbox.pinned = original
    if args[0] != bwrap or "--unshare-all" not in args or "--die-with-parent" not in args:
        raise RuntimeError("BLOCKED: unexpected sandbox launcher")
    if "--block-fd" in args:
        raise RuntimeError("BLOCKED: block-fd is not a release gate")
    return [bwrap, "--info-fd", str(info_fd), *args[1:]]


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
        try:
            release_read, release_write = os.pipe()
        except Exception:
            os.close(info_read)
            os.close(info_write)
            raise
        try:
            try:
                argv = build_command(profile, self.sandbox, self.bwrap, info_write, self.payload)
                self.process = subprocess.Popen(argv, stdin=release_read, stdout=subprocess.PIPE,
                                                stderr=subprocess.DEVNULL, pass_fds=(info_write,),
                                                close_fds=True, bufsize=0)
            finally:
                os.close(info_write)
                os.close(release_read)
            self.release_fd = release_write
        except Exception:
            os.close(info_read)
            if self.release_fd is None:
                os.close(release_write)
            raise
        try:
            pid, reported_ns = read_info(info_read, self.hold)
        finally:
            os.close(info_read)
        # Open the pidfd first so the PID cannot be reused under this handle,
        # then verify parentage and namespace. A failed check closes the
        # candidate and never stores it for signalling.
        candidate = None
        try:
            try:
                candidate = self.ops.pidfd_open(pid)
            except ProcessLookupError as error:
                raise RuntimeError("BLOCKED: namespace init unavailable") from error
            except OSError as error:
                raise RuntimeError("BLOCKED: namespace init pidfd unavailable") from error
            state = self.proc.stat(pid)
            if state["ppid"] != self.process.pid or state["state"] in ("Z", "X"):
                raise RuntimeError("BLOCKED: namespace init parentage mismatch")
            init = identify(self.proc, pid)
            bwrap_identity = identify(self.proc, self.process.pid)
            own_ns = self.proc.pid_ns(os.getpid())
            if (init is None or bwrap_identity is None or init["pidNs"] == bwrap_identity["pidNs"]
                    or bwrap_identity["pidNs"] != own_ns):
                raise RuntimeError("BLOCKED: namespace identity unavailable or not private")
            if reported_ns is not None and init["pidNs"] != f"pid:[{reported_ns}]":
                raise RuntimeError("BLOCKED: bwrap and /proc disagree on the namespace")
            boot = self.proc.boot_id()
            depth = len(self.proc.status(os.getpid()).get("NSpid", []))
            if depth < 1:
                raise RuntimeError("BLOCKED: namespace depth unavailable")
            identity = {"schema": SCHEMA, "nonce": nonce, "profile": profile, "bootId": boot,
                        "uid": os.getuid(), "depth": depth,
                        "supervisor": identify(self.proc, os.getpid()), "bwrap": bwrap_identity, "init": init,
                        "birthIdentity": f"{boot}:{init['pid']}:{init['start']}:{init['pidNs']}"}
            validate_identity(identity)
            self.identity = identity
            self.init_fd = candidate
            candidate = None
            self.emit({"event": "held", "nonce": nonce, "identity": self.identity, "digest": digest(self.identity)})
        finally:
            if candidate is not None:
                self.ops.close(candidate)

    def dispatch(self, nonce, identity_digest):
        if self.identity is None or self.dispatched or nonce != self.identity["nonce"]:
            raise RuntimeError("BLOCKED: dispatch without held identity")
        if identity_digest != digest(self.identity):
            raise RuntimeError("BLOCKED: controller did not record this identity")
        if not same(identify(self.proc, self.identity["init"]["pid"]), self.identity["init"]):
            raise RuntimeError("BLOCKED: namespace changed before dispatch")
        pending = RELEASE_TOKEN
        while pending:
            wrote = os.write(self.release_fd, pending)
            if wrote <= 0:
                raise OSError("release token write failed")
            pending = pending[wrote:]
        os.close(self.release_fd)
        self.release_fd = None
        self.dispatched = True
        self.emit({"event": "dispatched", "nonce": nonce})

    def stop(self, reason):
        if self.release_fd is not None:
            os.close(self.release_fd)
            self.release_fd = None
        try:
            if self.identity is None:
                # No complete identity: close any leftover pidfd without
                # signalling it, and stop only the directly owned launcher.
                leftover = self.init_fd
                self.init_fd = None
                if leftover is not None:
                    try:
                        self.ops.close(leftover)
                    except OSError:
                        pass
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
        finally:
            if self.process and self.process.stdout and not self.process.stdout.closed:
                self.process.stdout.close()
            if self.init_fd is not None:
                self.ops.close(self.init_fd)
                self.init_fd = None
        result["evidence"]["reason"] = reason
        self.emit({"event": "stopped", "nonce": self.identity and self.identity["nonce"], **result})
        return result


_TIMEOUT = object()


class LineReader:
    """Incremental non-blocking line reader for select()-driven streams."""

    def __init__(self, stream, max_bytes, strict=True, max_lines=None):
        self.stream = stream
        self.fd = None
        if hasattr(stream, "fileno"):
            try:
                self.fd = stream.fileno()
            except (OSError, ValueError):
                self.fd = None
        self.max_bytes = max_bytes
        self.strict = strict
        self.max_lines = max_lines
        self.lines = deque()
        self.buf = bytearray()
        self.eof = False
        self.total_lines = 0
        self._discarding = False
        if self.fd is not None:
            os.set_blocking(self.fd, False)

    def read_available(self):
        """Read currently available bytes without blocking on incomplete lines."""
        if self.eof:
            return
        if self.fd is None:
            chunk = self.stream.read(self.max_bytes + 1)
        else:
            try:
                chunk = os.read(self.fd, self.max_bytes + 1)
            except BlockingIOError:
                return
        if not chunk:
            self.eof = True
            return
        if self.strict:
            pos = 0
            while pos < len(chunk):
                nl = chunk.find(b"\n", pos)
                if nl == -1:
                    self.buf.extend(chunk[pos:])
                    if len(self.buf) >= self.max_bytes:
                        raise RuntimeError("BLOCKED: control frame invalid")
                    break
                part = bytes(self.buf) + chunk[pos:nl + 1]
                self.buf.clear()
                if len(part) > self.max_bytes:
                    raise RuntimeError("BLOCKED: control frame invalid")
                self.lines.append(part)
                pos = nl + 1
        else:
            if self.max_lines is not None and self.total_lines >= self.max_lines:
                return
            pos = 0
            while pos < len(chunk) and (self.max_lines is None or self.total_lines < self.max_lines):
                nl = chunk.find(b"\n", pos)
                if nl == -1:
                    part = chunk[pos:]
                    if not self._discarding:
                        space = self.max_bytes - len(self.buf)
                        if len(part) <= space:
                            self.buf.extend(part)
                        else:
                            if space > 0:
                                self.buf.extend(part[:space])
                            self._discarding = True
                    break
                part = chunk[pos:nl + 1]
                if not self._discarding:
                    space = self.max_bytes - len(self.buf)
                    if len(part) <= space:
                        self.buf.extend(part)
                    elif space > 0:
                        self.buf.extend(part[:space])
                self.lines.append(bytes(self.buf))
                self.buf.clear()
                self._discarding = False
                self.total_lines += 1
                pos = nl + 1

    def pop_line(self):
        """Return complete bytes line, None on clean EOF, or False if incomplete."""
        if self.lines:
            return self.lines.popleft()
        if self.eof:
            if self.buf:
                if self.strict:
                    raise RuntimeError("BLOCKED: control frame invalid")
                if self.max_lines is None or self.total_lines < self.max_lines:
                    line = bytes(self.buf)
                    self.buf.clear()
                    self._discarding = False
                    self.total_lines += 1
                    return line
                self.buf.clear()
                self._discarding = False
            return None
        return False


def parse_control_frame(line):
    if not line or len(line) > FRAME_MAX or not line.endswith(b"\n"):
        raise RuntimeError("BLOCKED: control frame invalid")
    frame = json.loads(line)
    if not isinstance(frame, dict) or not isinstance(frame.get("op"), str):
        raise RuntimeError("BLOCKED: control frame invalid")
    return frame


def read_frame(stream):
    line = stream.readline(FRAME_MAX + 1)
    if not line:
        return None
    return parse_control_frame(line)


def next_line_bounded(reader, deadline):
    while True:
        item = reader.pop_line()
        if item is not False:
            return item
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return _TIMEOUT
        if reader.fd is None:
            reader.read_available()
            if not reader.lines and not reader.eof:
                return _TIMEOUT
            continue
        if not select.select([reader.fd], [], [], remaining)[0]:
            return _TIMEOUT
        reader.read_available()


def write_frame(frame):
    """Write one NDJSON frame without letting a stalled reader block the caller.

    Returns True when the full frame is written. Returns False on EAGAIN,
    EPIPE, or the output deadline. Never raises BrokenPipeError. A frame
    over FRAME_MAX is replaced by the existing blocked frame. Smaller frames
    keep their bytes, including frames between PIPE_BUF and FRAME_MAX.
    """
    data = canonical(frame).encode() + b"\n"
    if len(data) > FRAME_MAX:
        data = canonical({"event": "blocked", "reason": "frame too large"}).encode() + b"\n"
    try:
        fd = sys.stdout.buffer.fileno()
    except (AttributeError, OSError, ValueError):
        return False
    try:
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    except OSError:
        return False
    was_blocking = (flags & os.O_NONBLOCK) == 0
    changed = False
    view = memoryview(data)
    sent = 0
    deadline = time.monotonic() + OUTPUT_WRITE_SECONDS
    try:
        os.set_blocking(fd, False)
        changed = True
        while sent < len(view):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            try:
                writable = select.select([], [fd], [], remaining)[1]
            except OSError as error:
                if error.errno == errno.EINTR:
                    continue
                return False
            if not writable:
                return False
            try:
                wrote = os.write(fd, view[sent:])
            except BrokenPipeError:
                return False
            except OSError as error:
                if error.errno in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EINTR):
                    continue
                return False
            if wrote <= 0:
                return False
            sent += wrote
        return True
    except OSError:
        return False
    finally:
        if changed:
            try:
                os.set_blocking(fd, was_blocking)
            except OSError:
                pass


def serve(stdin=None, emit=write_frame, **options):
    """Serve one ownership session over NDJSON stdin and stdout.

    Stdin EOF, an invalid frame, hold expiry, or lifetime expiry all Stop.
    A stale-nonce stop frame is rejected without disturbing the live namespace.
    A stdout write that cannot finish inside OUTPUT_WRITE_SECONDS is dropped,
    and later frames in this session are skipped, so cleanup is not stuck
    on a full pipe.
    """
    output_stalled = False

    def publish(frame):
        nonlocal output_stalled
        if output_stalled:
            return False
        result = emit(frame)
        if result is False:
            output_stalled = True
            return False
        return True

    stdin = stdin or sys.stdin.buffer
    supervisor_factory = options.pop("supervisor_factory", Supervisor)
    start_hold = options.get("hold", HOLD_SECONDS)
    supervisor = None
    reason = "eof"
    try:
        stdin_reader = LineReader(stdin, FRAME_MAX, strict=True)
        first = next_line_bounded(stdin_reader, time.monotonic() + start_hold)
        if first is _TIMEOUT:
            raise RuntimeError("BLOCKED: start frame timeout")
        if first is None:
            raise RuntimeError("BLOCKED: start frame required")
        frame = parse_control_frame(first)
        if frame["op"] != "start":
            raise RuntimeError("BLOCKED: start frame required")
        supervisor = supervisor_factory(publish, **options)
        supervisor.start(frame.get("nonce"), frame.get("profile"), frame.get("bwrap"))
        started = time.monotonic()
        workload_stream = supervisor.process.stdout if supervisor.process else None
        workload_reader = (
            LineReader(workload_stream, WORKLOAD_LINE_MAX, strict=False, max_lines=WORKLOAD_FRAMES_MAX)
            if workload_stream is not None
            else None
        )
        while True:
            limit = supervisor.hold if not supervisor.dispatched else supervisor.lifetime
            remaining = started + limit - time.monotonic()
            if remaining <= 0:
                reason = "hold-expired" if not supervisor.dispatched else "lifetime-expired"
                break

            if supervisor.dispatched and workload_reader is not None:
                while True:
                    wline = workload_reader.pop_line()
                    if wline is None:
                        workload_reader = None
                        break
                    if wline is False:
                        break
                    publish({"event": "workload", "data": wline[:WORKLOAD_LINE_MAX].decode("utf-8", "replace")})

            cline = stdin_reader.pop_line()
            if cline is None:
                reason = "eof"
                break
            if cline is not False:
                frame = parse_control_frame(cline)
                if frame["op"] == "dispatch":
                    supervisor.dispatch(frame.get("nonce"), frame.get("digest"))
                    started = time.monotonic()
                elif frame["op"] == "stop":
                    if frame.get("nonce") == supervisor.identity["nonce"]:
                        reason = "stop"
                        break
                    stale_nonce = frame.get("nonce")
                    publish({
                        "event": "ignored",
                        "op": "stop",
                        "nonce": stale_nonce[:64] if isinstance(stale_nonce, str) else None,
                        "cleanup": "unknown",
                        "reason": "stale-nonce",
                    })
                else:
                    reason = "invalid-frame"
                    break
                continue

            fds = []
            if stdin_reader.fd is not None:
                fds.append(stdin_reader.fd)
            elif not stdin_reader.eof:
                stdin_reader.read_available()
                continue
            if supervisor.dispatched and workload_reader is not None:
                if workload_reader.fd is not None:
                    fds.append(workload_reader.fd)
                elif not workload_reader.eof:
                    workload_reader.read_available()
                    continue
            if not fds:
                reason = "eof"
                break
            ready = select.select(fds, [], [], remaining)[0]
            if not ready:
                continue
            if workload_reader is not None and workload_reader.fd in ready:
                workload_reader.read_available()
            if stdin_reader.fd in ready:
                stdin_reader.read_available()
    except Exception as error:  # Any failure stops the owned namespace.
        reason = "blocked"
        publish({"event": "blocked", "reason": str(error)[:500]})
    finally:
        if supervisor is not None:
            if supervisor.process is not None:
                supervisor.stop(reason)
            elif supervisor.release_fd is not None:
                os.close(supervisor.release_fd)
                supervisor.release_fd = None
    return 0


def parse_oneshot_payload(line):
    if not line or len(line) > FRAME_MAX or not line.endswith(b"\n"):
        raise RuntimeError("BLOCKED: oneshot frame invalid")
    payload = json.loads(line)
    if not isinstance(payload, dict):
        raise RuntimeError("BLOCKED: oneshot frame invalid")
    if "identity" in payload:
        if not set(payload.keys()).issubset({"identity", "expectedNonce"}):
            raise RuntimeError("BLOCKED: oneshot envelope invalid")
        identity = payload["identity"]
        if "expectedNonce" in payload:
            expected_nonce = payload["expectedNonce"]
            if not isinstance(expected_nonce, str) or not NONCE.match(expected_nonce):
                raise RuntimeError("BLOCKED: oneshot expectedNonce invalid")
        else:
            expected_nonce = None
        return identity, expected_nonce
    return payload, None


def oneshot(op, stdin=None, emit=write_frame, proc=None, ops=Ops, timeout=HOLD_SECONDS):
    """Out-of-band confirm or stop for a fresh controller. Identity or envelope on stdin."""
    if op not in ("confirm", "stop"):
        emit({"event": "blocked", "reason": "unknown mode"})
        return 2
    stdin = stdin or sys.stdin.buffer
    proc = proc or Proc()
    try:
        reader = LineReader(stdin, FRAME_MAX, strict=True)
        deadline = time.monotonic() + timeout
        line = next_line_bounded(reader, deadline)
        if line is _TIMEOUT:
            raise RuntimeError("BLOCKED: oneshot frame timeout")
        if line is None:
            raise RuntimeError("BLOCKED: oneshot frame empty")
        if next_line_bounded(reader, deadline) is not None:
            raise RuntimeError("BLOCKED: oneshot trailing data")
        identity, expected_nonce = parse_oneshot_payload(line)
        if op == "confirm":
            emit({"event": "confirmed", **confirm_identity(proc, identity, expected_nonce=expected_nonce)})
        else:
            emit({"event": "stopped", **stop_identity(proc, identity, ops, expected_nonce=expected_nonce)})
    except Exception as error:
        emit({"event": "blocked", "reason": type(error).__name__})
    return 0


def run_bootstrap(stdin, payload=BOOTSTRAP_PAYLOAD, execv=None):
    """Execute the inert payload only after the exact release token.

    EOF and every other line return 0 without exec. Extra CLI arguments are
    ignored by the caller: the payload path is this argument, and the CLI
    always passes the fixed in-sandbox path. stdin is replaced with
    /dev/null before exec so the payload cannot read the release pipe.
    """
    runner = os.execv if execv is None else execv
    try:
        line = stdin.readline(len(RELEASE_TOKEN) + 1)
    except (OSError, ValueError):
        return 0
    if line != RELEASE_TOKEN:
        return 0
    path = Path(payload)
    try:
        if path.is_symlink() or not path.is_file():
            return 0
    except OSError:
        return 0
    try:
        null_fd = os.open(os.devnull, os.O_RDONLY)
        try:
            os.dup2(null_fd, 0)
        finally:
            os.close(null_fd)
    except OSError:
        return 0
    python = sys.executable
    try:
        runner(python, [python, "-I", "-B", str(path)])
    except OSError:
        return 0
    return 0


if __name__ == "__main__":
    mode = sys.argv[1:] or ["serve"]
    if mode[:1] == ["bootstrap"]:
        sys.exit(run_bootstrap(sys.stdin.buffer))
    if mode == ["serve"]:
        sys.exit(serve())
    if mode in (["confirm"], ["stop"]):
        sys.exit(oneshot(mode[0]))
    write_frame({"event": "blocked", "reason": "unknown mode"})
    sys.exit(2)
