"""Tests for opencode-stop-guest.py.

Designed to run inside an OS-enforced Bubblewrap sandbox with no external
network, empty allowlisted environment, read-only target and toolchain mounts,
scratch-only /tmp and /work writes, and strict CPU/memory/process/time limits.
"""

import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("opencode_stop_guest", ROOT / "opencode-stop-guest.py")
GUEST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GUEST)

NONCE_A = "11111111-2222-4333-8444-555555555555"
NONCE_B = "66666666-7777-4888-9999-aaaaaaaaaaaa"
BOOT_ID = "01234567-89ab-cdef-0123-456789abcdef"
RELEASE_TOKEN = b"cydeworks-release-v1\n"


class CommandSandbox:
    """Stand-in for sandbox.command() that still carries the launcher guardrails."""

    PINNED = {"runner-bwrap": "0" * 64}
    PYTHON = "/usr/bin/python3"

    @staticmethod
    def pinned(name):
        return f"/{name}"

    @staticmethod
    def command(_mode):
        return ["/fake-bwrap", "--unshare-all", "--unshare-user", "--disable-userns",
                "--die-with-parent", "--new-session", "--clearenv", "--",
                "/usr/bin/python3", "-I", "-B", "/guest.py", "linger"]


class FakeLauncher:
    """Direct child handle. kill() records the owned launcher, not a pidfd."""

    def __init__(self, pid):
        self.pid = pid
        self.stdout = io.BytesIO()
        self.killed = False
        self.returncode = None

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9

    def wait(self, timeout=None):
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


def drain_nonblocking(fds):
    data = b""
    for fd in fds:
        os.set_blocking(fd, False)
        try:
            while True:
                chunk = os.read(fd, 256)
                if not chunk:
                    break
                data += chunk
        except BlockingIOError:
            continue
    return data


class FakeProc:
    """In-memory /proc model for deterministic PID-reuse and ambiguity tests."""

    def __init__(self, boot=BOOT_ID, uid=65534):
        self.boot = boot
        self.uid = uid
        self.table = {}
        self.unreadable = set()

    def add(self, pid, start, pid_ns, ppid=1, state="S", uid=None, nspid=(1,)):
        self.table[pid] = {
            "start": str(start),
            "pidNs": pid_ns,
            "ppid": ppid,
            "state": state,
            "uid": self.uid if uid is None else uid,
            "nspid": [str(x) for x in nspid],
        }

    def remove(self, pid):
        self.table.pop(pid, None)

    def stat(self, pid):
        if pid in self.unreadable:
            raise PermissionError("simulated unreadable stat")
        if pid not in self.table:
            raise FileNotFoundError(pid)
        row = self.table[pid]
        return {"state": row["state"], "ppid": row["ppid"], "start": row["start"]}

    def pid_ns(self, pid):
        if pid in self.unreadable:
            raise PermissionError("simulated unreadable ns")
        if pid not in self.table:
            raise FileNotFoundError(pid)
        return self.table[pid]["pidNs"]

    def status(self, pid):
        if pid in self.unreadable:
            raise PermissionError("simulated unreadable status")
        if pid not in self.table:
            raise FileNotFoundError(pid)
        row = self.table[pid]
        return {
            "Uid": [str(row["uid"])] * 4,
            "State": [row["state"]],
            "NSpid": row["nspid"],
        }

    def boot_id(self):
        return self.boot

    def pids(self):
        return sorted(self.table.keys())


class FakeOps:
    """Recording pidfd operations backed by FakeProc."""

    def __init__(self, proc, auto_reap=True, on_open=None, fail_wait=False):
        self.proc = proc
        self.auto_reap = auto_reap
        self.on_open = on_open
        self.fail_wait = fail_wait
        self.next_fd = 100
        self.open_fds = {}
        self.closed_fds = []
        self.signalled_pids = []

    def pidfd_open(self, pid):
        if self.on_open:
            self.on_open(pid)
        if pid not in self.proc.table:
            raise ProcessLookupError(pid)
        fd = self.next_fd
        self.next_fd += 1
        self.open_fds[fd] = pid
        return fd

    def close(self, fd):
        self.open_fds.pop(fd, None)
        self.closed_fds.append(fd)

    def pidfd_pid(self, fd):
        if fd not in self.open_fds:
            raise OSError(fd)
        return self.open_fds[fd]

    def kill(self, fd):
        pid = self.open_fds[fd]
        self.signalled_pids.append(pid)
        if self.auto_reap:
            for member_pid, row in list(self.proc.table.items()):
                if member_pid == pid or row["pidNs"] == "pid:[4026532500]":
                    self.proc.remove(member_pid)

    def exited(self, fd, _seconds):
        if self.fail_wait:
            return False
        pid = self.open_fds.get(fd)
        return pid not in self.proc.table


def sample_identity(nonce=NONCE_A):
    init = {"pid": 420, "start": "99002", "pidNs": "pid:[4026532500]"}
    bwrap = {"pid": 419, "start": "99001", "pidNs": "pid:[4026531836]"}
    sup = {"pid": 418, "start": "99000", "pidNs": "pid:[4026531836]"}
    return {
        "schema": GUEST.SCHEMA,
        "nonce": nonce,
        "profile": "inert-fixture",
        "bootId": BOOT_ID,
        "uid": 65534,
        "depth": 1,
        "supervisor": sup,
        "bwrap": bwrap,
        "init": init,
        "birthIdentity": f"{BOOT_ID}:420:99002:pid:[4026532500]",
    }


class OpenCodeStopGuestUnitTests(unittest.TestCase):
    def test_actual_opencode_profile_is_disabled_by_constant_gate(self):
        self.assertFalse(GUEST.ACTUAL_OPENCODE_DISPATCH_ENABLED)
        frames = []
        sup = GUEST.Supervisor(frames.append, proc=FakeProc(), ops=FakeOps(FakeProc()), sandbox=object())
        with self.assertRaisesRegex(RuntimeError, "actual OpenCode dispatch disabled"):
            sup.start(NONCE_A, "actual-opencode")

    def test_stop_verifies_and_kills_owned_namespace_tree(self):
        proc = FakeProc()
        proc.add(419, "99001", "pid:[4026531836]", nspid=(419,))
        proc.add(420, "99002", "pid:[4026532500]", ppid=419, nspid=(420, 1))
        proc.add(421, "99003", "pid:[4026532500]", ppid=420, nspid=(421, 2))
        ops = FakeOps(proc)
        identity = sample_identity()

        result = GUEST.stop_identity(proc, identity, ops, wait=0.2, settle=0.2)
        self.assertEqual(result["cleanup"], "verified")
        self.assertEqual(ops.signalled_pids, [420, 419])
        self.assertEqual(ops.open_fds, {})

        # Repeated Stop after confirmed exit is idempotent and sends zero signals.
        ops2 = FakeOps(proc)
        repeat = GUEST.stop_identity(proc, identity, ops2, wait=0.2, settle=0.2)
        self.assertEqual(repeat["cleanup"], "verified")
        self.assertEqual(ops2.signalled_pids, [])

    def test_pid_reuse_is_never_signalled(self):
        proc = FakeProc()
        # PID 420 and 419 were reused by unrelated processes with newer start times.
        proc.add(419, "105000", "pid:[4026531836]", nspid=(419,))
        proc.add(420, "105001", "pid:[4026531836]", nspid=(420,))
        ops = FakeOps(proc)
        identity = sample_identity()

        result = GUEST.stop_identity(proc, identity, ops, wait=0.2, settle=0.2)
        self.assertEqual(result["cleanup"], "verified")
        self.assertEqual(ops.signalled_pids, [])
        self.assertIn(419, proc.table)
        self.assertIn(420, proc.table)

    def test_pid_reuse_race_during_pidfd_open_closes_fd_without_signal(self):
        proc = FakeProc()
        proc.add(419, "99001", "pid:[4026531836]", nspid=(419,))
        proc.add(420, "99002", "pid:[4026532500]", ppid=419, nspid=(420, 1))

        def mutate_on_open(pid):
            if pid == 420:
                # Simulate PID 420 exiting and being reused right as pidfd_open runs.
                proc.add(420, "199999", "pid:[4026531836]", nspid=(420,))

        ops = FakeOps(proc, on_open=mutate_on_open)
        result = GUEST.stop_identity(proc, sample_identity(), ops, wait=0.2, settle=0.2)
        self.assertEqual(result["cleanup"], "verified")
        self.assertNotIn(420, ops.signalled_pids)
        self.assertEqual(ops.open_fds, {})

    def test_ambiguous_proc_or_surviving_member_returns_unknown(self):
        proc = FakeProc()
        proc.add(419, "99001", "pid:[4026531836]", nspid=(419,))
        proc.add(420, "99002", "pid:[4026532500]", ppid=419, nspid=(420, 1))
        proc.add(421, "99003", "pid:[4026532500]", ppid=420, nspid=(421, 2))
        # auto_reap=False leaves processes alive so cleanup must report unknown.
        ops = FakeOps(proc, auto_reap=False, fail_wait=True)
        result = GUEST.stop_identity(proc, sample_identity(), ops, wait=0.05, settle=0.05)
        self.assertEqual(result["cleanup"], "unknown")
        self.assertEqual(ops.open_fds, {})

        # Unreadable /proc entry during verification also yields unknown without signal.
        proc2 = FakeProc()
        proc2.add(419, "99001", "pid:[4026531836]", nspid=(419,))
        proc2.add(420, "99002", "pid:[4026532500]", ppid=419, nspid=(420, 1))
        proc2.unreadable.add(420)
        ops2 = FakeOps(proc2)
        result2 = GUEST.stop_identity(proc2, sample_identity(), ops2, wait=0.05, settle=0.05)
        self.assertEqual(result2["cleanup"], "unknown")
        self.assertEqual(ops2.signalled_pids, [])

    def test_invalid_or_forged_identity_returns_unknown(self):
        proc = FakeProc()
        ops = FakeOps(proc)
        forged = sample_identity()
        forged["birthIdentity"] += "0"
        self.assertEqual(GUEST.stop_identity(proc, forged, ops)["cleanup"], "unknown")
        self.assertEqual(GUEST.confirm_identity(proc, forged)["absent"], False)
        self.assertEqual(ops.signalled_pids, [])

    def test_stale_nonce_and_boot_id_change_handling(self):
        proc = FakeProc()
        proc.add(419, "99001", "pid:[4026531836]", nspid=(419,))
        proc.add(420, "99002", "pid:[4026532500]", ppid=419, nspid=(420, 1))
        ops = FakeOps(proc)
        identity = sample_identity(NONCE_A)

        stale = GUEST.stop_identity(proc, identity, ops, expected_nonce=NONCE_B)
        self.assertEqual(stale["cleanup"], "unknown")
        self.assertEqual(stale["evidence"].get("reason"), "stale-nonce")
        self.assertEqual(ops.signalled_pids, [])
        self.assertFalse(GUEST.confirm_identity(proc, identity, expected_nonce=NONCE_B)["absent"])

        rebooted = FakeProc(boot="ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb")
        rebooted.add(419, "99001", "pid:[4026531836]", nspid=(419,))
        rebooted.add(420, "99002", "pid:[4026532500]", ppid=419, nspid=(420, 1))
        ops_reboot = FakeOps(rebooted)
        after_boot = GUEST.stop_identity(rebooted, identity, ops_reboot, expected_nonce=NONCE_A)
        self.assertEqual(after_boot["cleanup"], "verified")
        self.assertTrue(after_boot["evidence"]["bootChanged"])
        self.assertEqual(ops_reboot.signalled_pids, [])
        self.assertTrue(GUEST.confirm_identity(rebooted, identity, expected_nonce=NONCE_A)["absent"])

    def _make_pipe_supervisor_factory(self, workload_read_file, nonce=NONCE_A):
        identity = sample_identity(nonce)
        expected_digest = GUEST.digest(identity)
        records = {"stop_reasons": [], "dispatched": False}

        class FakeProcess:
            def __init__(self, stdout):
                self.stdout = stdout

        class FakeSupervisor:
            def __init__(self, emit, hold=5.0, lifetime=5.0, **_kwargs):
                self.emit = emit
                self.hold = hold
                self.lifetime = lifetime
                self.process = FakeProcess(workload_read_file)
                self.identity = None
                self.dispatched = False
                self.release_fd = None

            def start(self, req_nonce, _profile, _bwrap=None):
                self.identity = sample_identity(req_nonce)
                self.emit({"event": "held", "nonce": req_nonce, "identity": self.identity, "digest": expected_digest})

            def dispatch(self, req_nonce, identity_digest):
                if req_nonce != self.identity["nonce"] or identity_digest != expected_digest:
                    raise RuntimeError("BLOCKED: invalid dispatch")
                self.dispatched = True
                records["dispatched"] = True
                self.emit({"event": "dispatched", "nonce": req_nonce})

            def stop(self, reason):
                records["stop_reasons"].append(reason)
                if self.process.stdout and not self.process.stdout.closed:
                    self.process.stdout.close()
                result = {"cleanup": "verified", "evidence": {"reason": reason}}
                self.emit({"event": "stopped", "nonce": self.identity and self.identity["nonce"], **result})
                return result

        return FakeSupervisor, expected_digest, records

    def test_serve_partial_workload_line_does_not_block_stop_or_lifetime(self):
        # Case A: workload emits a partial line without newline, then valid stop arrives.
        in_r, in_w = os.pipe()
        wl_r, wl_w = os.pipe()
        in_read = os.fdopen(in_r, "rb", buffering=0)
        wl_read = os.fdopen(wl_r, "rb", buffering=0)
        frames = []
        factory, expected_digest, records = self._make_pipe_supervisor_factory(wl_read, NONCE_A)
        try:
            def driver():
                os.write(in_w, (json.dumps({"op": "start", "nonce": NONCE_A, "profile": "inert-fixture"}) + "\n").encode())
                os.write(in_w, (json.dumps({"op": "dispatch", "nonce": NONCE_A, "digest": expected_digest}) + "\n").encode())
                time.sleep(0.03)
                os.write(wl_w, b"partial-without-newline")
                time.sleep(0.03)
                os.write(in_w, (json.dumps({"op": "stop", "nonce": NONCE_A}) + "\n").encode())

            t = threading.Thread(target=driver, daemon=True)
            t.start()
            t0 = time.monotonic()
            GUEST.serve(stdin=in_read, emit=frames.append, supervisor_factory=factory, hold=2.0, lifetime=5.0)
            elapsed = time.monotonic() - t0
            t.join(timeout=2.0)
            self.assertLess(elapsed, 1.5)
            self.assertEqual(records["stop_reasons"], ["stop"])
            self.assertTrue(any(f.get("event") == "stopped" and f["evidence"]["reason"] == "stop" for f in frames))
        finally:
            for fd in (in_w, wl_w):
                try:
                    os.close(fd)
                except OSError:
                    pass
            for stream in (in_read, wl_read):
                if not stream.closed:
                    stream.close()

        # Case B: workload emits a partial line without newline and never sends stop; lifetime must expire.
        in_r2, in_w2 = os.pipe()
        wl_r2, wl_w2 = os.pipe()
        in_read2 = os.fdopen(in_r2, "rb", buffering=0)
        wl_read2 = os.fdopen(wl_r2, "rb", buffering=0)
        frames2 = []
        factory2, expected_digest2, records2 = self._make_pipe_supervisor_factory(wl_read2, NONCE_A)
        try:
            os.write(in_w2, (json.dumps({"op": "start", "nonce": NONCE_A, "profile": "inert-fixture"}) + "\n").encode())
            os.write(in_w2, (json.dumps({"op": "dispatch", "nonce": NONCE_A, "digest": expected_digest2}) + "\n").encode())
            os.write(wl_w2, b"stalled-partial-line")
            t0 = time.monotonic()
            GUEST.serve(stdin=in_read2, emit=frames2.append, supervisor_factory=factory2, hold=1.0, lifetime=0.15)
            elapsed = time.monotonic() - t0
            self.assertLess(elapsed, 1.5)
            self.assertEqual(records2["stop_reasons"], ["lifetime-expired"])
        finally:
            for fd in (in_w2, wl_w2):
                try:
                    os.close(fd)
                except OSError:
                    pass
            for stream in (in_read2, wl_read2):
                if not stream.closed:
                    stream.close()

    def test_workload_drain_cannot_delay_stop_or_lifetime(self):
        # Many complete workload lines plus a slow successful emit. An unbounded
        # drain would publish every line before the next control or lifetime check.
        line_count = 120
        payload = b"line\n" * line_count
        sleep_s = 0.02

        def run_case(lifetime, write_stop):
            in_r, in_w = os.pipe()
            wl_r, wl_w = os.pipe()
            in_read = os.fdopen(in_r, "rb", buffering=0)
            wl_read = os.fdopen(wl_r, "rb", buffering=0)
            os.write(wl_w, payload)
            frames = []
            factory, expected_digest, records = self._make_pipe_supervisor_factory(wl_read, NONCE_A)
            emitted = {"n": 0}

            def slow_emit(frame):
                if frame.get("event") == "workload":
                    emitted["n"] += 1
                    time.sleep(sleep_s)
                frames.append(frame)
                return True

            try:
                os.write(in_w, (json.dumps({"op": "start", "nonce": NONCE_A, "profile": "inert-fixture"}) + "\n").encode())
                os.write(in_w, (json.dumps({"op": "dispatch", "nonce": NONCE_A, "digest": expected_digest}) + "\n").encode())
                if write_stop:
                    os.write(in_w, (json.dumps({"op": "stop", "nonce": NONCE_A}) + "\n").encode())
                started = time.monotonic()
                GUEST.serve(
                    stdin=in_read,
                    emit=slow_emit,
                    supervisor_factory=factory,
                    hold=2.0,
                    lifetime=lifetime,
                )
                return time.monotonic() - started, emitted["n"], records["stop_reasons"]
            finally:
                for fd in (in_w, wl_w):
                    try:
                        os.close(fd)
                    except OSError:
                        pass
                for stream in (in_read, wl_read):
                    if not stream.closed:
                        stream.close()

        elapsed, emitted, reasons = run_case(5.0, True)
        self.assertEqual(reasons, ["stop"])
        self.assertLess(emitted, line_count)
        self.assertLessEqual(emitted, GUEST.WORKLOAD_DRAIN_BATCH)
        self.assertLess(elapsed, 1.0)

        elapsed, emitted, reasons = run_case(0.25, False)
        self.assertEqual(reasons, ["lifetime-expired"])
        self.assertLess(emitted, line_count)
        self.assertLess(elapsed, 1.0)

    def test_serve_partial_stdin_line_does_not_block_hold_or_start_timeout(self):
        # Partial control frame after start must still hit hold-expired without wedging.
        in_r, in_w = os.pipe()
        wl_r, wl_w = os.pipe()
        in_read = os.fdopen(in_r, "rb", buffering=0)
        wl_read = os.fdopen(wl_r, "rb", buffering=0)
        frames = []
        factory, _, records = self._make_pipe_supervisor_factory(wl_read, NONCE_A)
        try:
            os.write(in_w, (json.dumps({"op": "start", "nonce": NONCE_A, "profile": "inert-fixture"}) + "\n").encode())
            os.write(in_w, b'{"op":"dispatch","partial')
            t0 = time.monotonic()
            GUEST.serve(stdin=in_read, emit=frames.append, supervisor_factory=factory, hold=0.15, lifetime=1.0)
            elapsed = time.monotonic() - t0
            self.assertLess(elapsed, 1.5)
            self.assertEqual(records["stop_reasons"], ["hold-expired"])
        finally:
            for fd in (in_w, wl_w):
                try:
                    os.close(fd)
                except OSError:
                    pass
            for stream in (in_read, wl_read):
                if not stream.closed:
                    stream.close()

        # Partial initial start frame must time out instead of blocking indefinitely.
        in_r2, in_w2 = os.pipe()
        in_read2 = os.fdopen(in_r2, "rb", buffering=0)
        frames2 = []
        try:
            os.write(in_w2, b'{"op":"sta')
            t0 = time.monotonic()
            GUEST.serve(stdin=in_read2, emit=frames2.append, hold=0.15, lifetime=1.0)
            elapsed = time.monotonic() - t0
            self.assertLess(elapsed, 1.5)
            self.assertTrue(any(f.get("event") == "blocked" and "timeout" in f.get("reason", "") for f in frames2))
        finally:
            try:
                os.close(in_w2)
            except OSError:
                pass
            if not in_read2.closed:
                in_read2.close()

    def test_serve_stale_nonce_stop_does_not_kill_active_namespace(self):
        in_r, in_w = os.pipe()
        wl_r, wl_w = os.pipe()
        in_read = os.fdopen(in_r, "rb", buffering=0)
        wl_read = os.fdopen(wl_r, "rb", buffering=0)
        frames = []
        factory, expected_digest, records = self._make_pipe_supervisor_factory(wl_read, NONCE_A)
        try:
            def driver():
                os.write(in_w, (json.dumps({"op": "start", "nonce": NONCE_A, "profile": "inert-fixture"}) + "\n").encode())
                os.write(in_w, (json.dumps({"op": "dispatch", "nonce": NONCE_A, "digest": expected_digest}) + "\n").encode())
                time.sleep(0.03)
                # Stale stop must be ignored without stopping the live namespace.
                os.write(in_w, (json.dumps({"op": "stop", "nonce": NONCE_B}) + "\n").encode())
                time.sleep(0.03)
                os.write(wl_w, b"still-alive-after-stale-stop\n")
                time.sleep(0.03)
                os.write(in_w, (json.dumps({"op": "stop", "nonce": NONCE_A}) + "\n").encode())

            t = threading.Thread(target=driver, daemon=True)
            t.start()
            GUEST.serve(stdin=in_read, emit=frames.append, supervisor_factory=factory, hold=2.0, lifetime=2.0)
            t.join(timeout=2.0)
            ignored = [f for f in frames if f.get("event") == "ignored"]
            self.assertEqual(len(ignored), 1)
            self.assertEqual(ignored[0]["reason"], "stale-nonce")
            self.assertEqual(ignored[0]["cleanup"], "unknown")
            workloads = [f["data"] for f in frames if f.get("event") == "workload"]
            self.assertEqual(workloads, ["still-alive-after-stale-stop\n"])
            self.assertEqual(records["stop_reasons"], ["stop"])
        finally:
            for fd in (in_w, wl_w):
                try:
                    os.close(fd)
                except OSError:
                    pass
            for stream in (in_read, wl_read):
                if not stream.closed:
                    stream.close()

    def test_start_failure_in_build_command_or_popen_leaks_no_fds(self):
        proc = FakeProc()
        ops = FakeOps(proc)

        class DummySandbox:
            PINNED = {"runner-bwrap": "0" * 64}
            PYTHON = "/usr/bin/python3"

            @staticmethod
            def pinned(name):
                return f"/{name}"

            @staticmethod
            def command(_mode):
                return ["/fake-bwrap", "--unshare-all", "--die-with-parent", "--", "/usr/bin/python3"]

        # Case A: build_command raises (missing payload file).
        before_a = set(os.listdir("/proc/self/fd")) if Path("/proc/self/fd").is_dir() else None
        sup_a = GUEST.Supervisor(lambda _f: None, proc=proc, ops=ops, sandbox=DummySandbox(),
                                 payload="/nonexistent-payload-file.py")
        with mock.patch.object(GUEST, "pinned_bwrap", return_value="/fake-bwrap"):
            with self.assertRaisesRegex(RuntimeError, "inert payload unavailable"):
                sup_a.start(NONCE_A, "inert-fixture")
        self.assertIsNone(sup_a.process)
        self.assertIsNone(sup_a.release_fd)
        if before_a is not None:
            after_a = set(os.listdir("/proc/self/fd"))
            self.assertEqual(after_a, before_a)

        # Case B: subprocess.Popen raises OSError.
        before_b = set(os.listdir("/proc/self/fd")) if Path("/proc/self/fd").is_dir() else None
        sup_b = GUEST.Supervisor(lambda _f: None, proc=proc, ops=ops, sandbox=DummySandbox(),
                                 payload=str(ROOT / "opencode-stop-payload.py"))
        with mock.patch.object(GUEST, "pinned_bwrap", return_value="/fake-bwrap"), \
             mock.patch.object(GUEST.subprocess, "Popen", side_effect=OSError("simulated Popen error")):
            with self.assertRaises(OSError):
                sup_b.start(NONCE_A, "inert-fixture")
        self.assertIsNone(sup_b.process)
        self.assertIsNone(sup_b.release_fd)
        if before_b is not None:
            after_b = set(os.listdir("/proc/self/fd"))
            self.assertEqual(after_b, before_b)

    def test_oneshot_bounds_newline_trailing_data_and_expected_nonce(self):
        proc = FakeProc()
        proc.add(419, "99001", "pid:[4026531836]", nspid=(419,))
        proc.add(420, "99002", "pid:[4026532500]", ppid=419, nspid=(420, 1))
        identity = sample_identity(NONCE_A)

        def run_one(op, raw_bytes, local_proc=proc, local_ops=None):
            out = []
            local_ops = local_ops or FakeOps(local_proc)
            GUEST.oneshot(op, stdin=io.BytesIO(raw_bytes), emit=out.append, proc=local_proc, ops=local_ops, timeout=0.2)
            self.assertEqual(len(out), 1)
            return out[0], local_ops

        # Missing trailing newline rejected without signalling.
        reply, ops = run_one("stop", json.dumps(identity).encode())
        self.assertEqual(reply["event"], "blocked")
        self.assertEqual(ops.signalled_pids, [])

        # Oversized frame (> FRAME_MAX) rejected without signalling.
        oversized = (json.dumps({"identity": identity, "expectedNonce": NONCE_A}) + (" " * GUEST.FRAME_MAX) + "\n").encode()
        reply, ops = run_one("stop", oversized)
        self.assertEqual(reply["event"], "blocked")
        self.assertEqual(ops.signalled_pids, [])

        # Trailing data after newline rejected without signalling.
        trailing = (json.dumps(identity) + "\n" + "{}\n").encode()
        reply, ops = run_one("stop", trailing)
        self.assertEqual(reply["event"], "blocked")
        self.assertEqual(ops.signalled_pids, [])

        # Empty input rejected without signalling.
        reply, ops = run_one("confirm", b"")
        self.assertEqual(reply["event"], "blocked")
        self.assertEqual(ops.signalled_pids, [])

        # Unknown envelope keys and malformed expectedNonce rejected without signalling.
        bad_env = (json.dumps({"identity": identity, "expectedNonce": NONCE_A, "extra": 1}) + "\n").encode()
        reply, ops = run_one("stop", bad_env)
        self.assertEqual(reply["event"], "blocked")
        self.assertEqual(ops.signalled_pids, [])

        for bad_nonce in (None, "", "not-a-uuid", 123):
            bad_nonce_env = (json.dumps({"identity": identity, "expectedNonce": bad_nonce}) + "\n").encode()
            reply, ops = run_one("stop", bad_nonce_env)
            self.assertEqual(reply["event"], "blocked")
            self.assertEqual(ops.signalled_pids, [])

        # Stale expectedNonce returns unknown / absent: False with zero signals.
        stale_env = (json.dumps({"identity": identity, "expectedNonce": NONCE_B}) + "\n").encode()
        reply, ops = run_one("stop", stale_env)
        self.assertEqual(reply["event"], "stopped")
        self.assertEqual(reply["cleanup"], "unknown")
        self.assertEqual(reply["evidence"].get("reason"), "stale-nonce")
        self.assertEqual(ops.signalled_pids, [])

        reply_c, _ = run_one("confirm", stale_env)
        self.assertEqual(reply_c["event"], "confirmed")
        self.assertFalse(reply_c["absent"])
        self.assertEqual(reply_c.get("reason"), "stale-nonce")

        # Partial line on a pipe times out cleanly instead of blocking forever.
        p_r, p_w = os.pipe()
        p_read = os.fdopen(p_r, "rb", buffering=0)
        out_timeout = []
        try:
            os.write(p_w, b'{"identity":')
            t0 = time.monotonic()
            GUEST.oneshot("confirm", stdin=p_read, emit=out_timeout.append, proc=proc, ops=FakeOps(proc), timeout=0.1)
            self.assertLess(time.monotonic() - t0, 1.0)
            self.assertEqual(out_timeout[0]["event"], "blocked")
        finally:
            os.close(p_w)
            if not p_read.closed:
                p_read.close()

        # Matching expectedNonce stops and then confirms absent cleanly.
        valid_env = (json.dumps({"identity": identity, "expectedNonce": NONCE_A}) + "\n").encode()
        reply_ok, ops_ok = run_one("stop", valid_env)
        self.assertEqual(reply_ok["event"], "stopped")
        self.assertEqual(reply_ok["cleanup"], "verified")
        self.assertEqual(ops_ok.signalled_pids, [420, 419])

        reply_ok_c, _ = run_one("confirm", valid_env)
        self.assertEqual(reply_ok_c["event"], "confirmed")
        self.assertTrue(reply_ok_c["absent"])

    def _capture_popen(self, captured):
        def fake_popen(argv, stdin=None, pass_fds=(), **_kwargs):
            captured["argv"] = list(argv)
            captured["stdin"] = stdin
            reads = []
            candidates = []
            if isinstance(stdin, int) and stdin >= 0:
                candidates.append(stdin)
            candidates.extend(pass_fds)
            for fd in candidates:
                cloned = os.dup(fd)
                mode = fcntl.fcntl(cloned, fcntl.F_GETFL) & os.O_ACCMODE
                if mode == os.O_WRONLY:
                    os.close(cloned)
                    continue
                reads.append(cloned)
            captured["reads"] = reads
            launcher = FakeLauncher(419)
            captured["launcher"] = launcher
            return launcher
        return fake_popen

    def _held_namespace(self):
        me = os.getpid()
        own = "pid:[4026531836]"
        guest_ns = "pid:[4026532500]"
        proc = FakeProc(uid=os.getuid())
        proc.add(419, "99001", own, ppid=me, nspid=(419,))
        proc.add(420, "99002", guest_ns, ppid=419, nspid=(420, 1))
        proc.add(me, "99000", own, ppid=1, nspid=(me,))
        return proc, FakeOps(proc)

    def test_failed_identity_closes_candidate_and_signals_only_owned_launcher(self):
        proc = FakeProc()
        proc.add(420, "99002", "pid:[4026532500]", ppid=1, nspid=(420, 1))
        ops = FakeOps(proc)
        captured = {}
        sup = GUEST.Supervisor(lambda _frame: None, proc=proc, ops=ops, sandbox=CommandSandbox(),
                               payload=str(ROOT / "opencode-stop-payload.py"))
        try:
            with mock.patch.object(GUEST, "pinned_bwrap", return_value="/fake-bwrap"), \
                 mock.patch.object(GUEST.subprocess, "Popen", side_effect=self._capture_popen(captured)), \
                 mock.patch.object(GUEST, "read_info", return_value=(420, 4026532500)):
                with self.assertRaisesRegex(RuntimeError, "parentage"):
                    sup.start(NONCE_A, "inert-fixture")
            sup.stop("blocked")
            self.assertEqual(ops.signalled_pids, [])
            self.assertEqual(ops.open_fds, {})
            self.assertTrue(captured["launcher"].killed)
        finally:
            for fd in captured.get("reads", ()):
                os.close(fd)

    def test_stop_identity_does_not_signal_unverified_init_fd(self):
        proc = FakeProc()
        proc.add(419, "99001", "pid:[4026531836]", nspid=(419,))
        proc.add(420, "99002", "pid:[4026532500]", ppid=419, nspid=(420, 1))
        proc.add(777, "105001", "pid:[4026531999]", nspid=(777,))
        ops = FakeOps(proc)
        foreign = ops.pidfd_open(777)
        result = GUEST.stop_identity(proc, sample_identity(), ops, init_fd=foreign, wait=0.2, settle=0.2)
        self.assertEqual(result["cleanup"], "verified")
        self.assertNotIn(777, ops.signalled_pids)
        self.assertIn(420, ops.signalled_pids)
        self.assertIn(419, ops.signalled_pids)
        self.assertIn(777, proc.table)

        proc.add(419, "99001", "pid:[4026531836]", nspid=(419,))
        proc.add(420, "99002", "pid:[4026532500]", ppid=419, nspid=(420, 1))
        owned = ops.pidfd_open(420)
        ops.signalled_pids.clear()
        verified = GUEST.stop_identity(proc, sample_identity(), ops, init_fd=owned, wait=0.2, settle=0.2)
        self.assertEqual(verified["cleanup"], "verified")
        self.assertEqual(ops.signalled_pids, [420, 419])

    def test_verified_release_writes_token_and_keeps_launcher_guardrails(self):
        proc, ops = self._held_namespace()
        captured = {}
        frames = []
        sup = GUEST.Supervisor(frames.append, proc=proc, ops=ops, sandbox=CommandSandbox(),
                               payload=str(ROOT / "opencode-stop-payload.py"))
        try:
            with mock.patch.object(GUEST, "pinned_bwrap", return_value="/fake-bwrap"), \
                 mock.patch.object(GUEST.subprocess, "Popen", side_effect=self._capture_popen(captured)), \
                 mock.patch.object(GUEST, "read_info", return_value=(420, 4026532500)):
                sup.start(NONCE_A, "inert-fixture")
            argv = captured["argv"]
            self.assertNotIn("--block-fd", argv)
            self.assertNotEqual(captured["stdin"], subprocess.DEVNULL)
            self.assertIn("--unshare-all", argv)
            self.assertIn("--die-with-parent", argv)
            self.assertIn("--disable-userns", argv)
            self.assertIn("bootstrap", argv)
            self.assertIn("/stop-payload.py", argv)
            tail = argv[argv.index("--") + 1:]
            self.assertEqual(tail[-2:], ["/stop-guest.py", "bootstrap"])
            self.assertNotIn("/stop-payload.py", tail)
            sup.dispatch(NONCE_A, frames[0]["digest"])
            self.assertEqual(drain_nonblocking(captured["reads"]), RELEASE_TOKEN)
            sup.stop("stop")
            self.assertEqual(ops.signalled_pids, [420, 419])
            self.assertNotIn(os.getpid(), ops.signalled_pids)
        finally:
            for fd in captured.get("reads", ()):
                os.close(fd)

    def test_cancel_before_release_sends_eof_and_does_not_write_token(self):
        proc, ops = self._held_namespace()
        captured = {}
        sup = GUEST.Supervisor(lambda _frame: None, proc=proc, ops=ops, sandbox=CommandSandbox(),
                               payload=str(ROOT / "opencode-stop-payload.py"))
        try:
            with mock.patch.object(GUEST, "pinned_bwrap", return_value="/fake-bwrap"), \
                 mock.patch.object(GUEST.subprocess, "Popen", side_effect=self._capture_popen(captured)), \
                 mock.patch.object(GUEST, "read_info", return_value=(420, 4026532500)):
                sup.start(NONCE_A, "inert-fixture")
            sup.stop("eof")
            self.assertEqual(drain_nonblocking(captured["reads"]), b"")
            self.assertEqual(ops.signalled_pids, [420, 419])
        finally:
            for fd in captured.get("reads", ()):
                os.close(fd)

    def _run_bootstrap(self, payload, stdin_bytes):
        code = (
            "import importlib.util, sys\n"
            f"spec = importlib.util.spec_from_file_location('guest', {str(ROOT / 'opencode-stop-guest.py')!r})\n"
            "mod = importlib.util.module_from_spec(spec)\n"
            "spec.loader.exec_module(mod)\n"
            f"sys.exit(mod.run_bootstrap(sys.stdin.buffer, payload={str(payload)!r}))\n"
        )
        return subprocess.run(
            [sys.executable, "-I", "-B", "-c", code],
            input=stdin_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=5,
            check=False,
        )

    def test_release_token_executes_fixture_without_controller_forwarding(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            marker = directory / "ran.txt"
            payload = directory / "opencode-stop-payload.py"
            payload.write_text(
                "import json, os, pathlib\n"
                f"pathlib.Path({str(marker)!r}).write_text('ran', encoding='utf-8')\n"
                "print(json.dumps({'payload':'inert-fixture','direct':True,'pid':os.getpid()}), flush=True)\n",
                encoding="utf-8",
            )
            proc = self._run_bootstrap(payload, RELEASE_TOKEN)
            self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", "replace"))
            self.assertEqual(marker.read_text(encoding="utf-8"), "ran")
            observed = json.loads(proc.stdout.decode())
            self.assertEqual(observed["payload"], "inert-fixture")
            self.assertTrue(observed["direct"])
            self.assertGreater(observed["pid"], 1)
            self.assertNotIn(b"workload", proc.stdout)

    def test_eof_and_non_release_never_execute_payload(self):
        samples = (b"", b"1\n", b"release\n", b"cydeworks-release-v1", b"cydeworks-release-v1!\n", b"\x00\n")
        for sample in samples:
            with self.subTest(sample=sample), tempfile.TemporaryDirectory() as directory:
                directory = Path(directory)
                marker = directory / "ran.txt"
                payload = directory / "opencode-stop-payload.py"
                payload.write_text(
                    "import pathlib\n"
                    f"pathlib.Path({str(marker)!r}).write_text('ran', encoding='utf-8')\n"
                    "print('executed', flush=True)\n",
                    encoding="utf-8",
                )
                proc = self._run_bootstrap(payload, sample)
                self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", "replace"))
                self.assertFalse(marker.exists())
                self.assertNotIn(b"executed", proc.stdout)

    def test_bootstrap_cli_ignores_extra_path_and_requires_fixed_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            evil = Path(directory) / "evil.py"
            evil.write_text("print('executed-evil', flush=True)\n", encoding="utf-8")
            proc = subprocess.run(
                [sys.executable, "-I", "-B", str(ROOT / "opencode-stop-guest.py"), "bootstrap", str(evil)],
                input=RELEASE_TOKEN,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=5,
                check=False,
            )
            combined = proc.stdout + proc.stderr
            self.assertNotIn(b"executed-evil", combined)
            self.assertEqual(proc.returncode, 0, combined.decode("utf-8", "replace"))

    def test_real_inert_payload_is_observable_without_controller_forwarding(self):
        proc = subprocess.Popen(
            [sys.executable, "-I", "-B", str(ROOT / "opencode-stop-payload.py")],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            ready = select.select([proc.stdout], [], [], 3)[0]
            self.assertTrue(ready)
            info = json.loads(proc.stdout.readline().decode())
            self.assertEqual(info["payload"], "inert-fixture")
            self.assertGreater(info["nsChildPid"], 0)
            self.assertNotEqual(info["nsChildPid"], info["nsInitPid"])
        finally:
            if proc.stdout is not None and not proc.stdout.closed:
                proc.stdout.close()
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=3)

    def test_backed_up_stdout_does_not_stall_cleanup(self):
        read_fd, write_fd = os.pipe()
        os.set_blocking(write_fd, False)
        filler = b"x" * 65536
        try:
            while True:
                os.write(write_fd, filler)
        except BlockingIOError:
            pass
        os.set_blocking(write_fd, True)
        raw = os.fdopen(write_fd, "wb", buffering=0)
        held = sys.stdout
        wrapper = io.TextIOWrapper(raw, encoding="utf-8", write_through=True)
        sys.stdout = wrapper
        box = {}

        def attempt():
            try:
                box["ok"] = GUEST.write_frame({"event": "stopped", "nonce": NONCE_A, "cleanup": "verified"})
            except Exception as error:
                box["error"] = type(error).__name__

        worker = threading.Thread(target=attempt, daemon=True)
        worker.start()
        worker.join(1.0)
        stalled = worker.is_alive()
        sys.stdout = held
        os.close(read_fd)
        worker.join(1.0)
        wrapper.close()
        self.assertFalse(stalled)
        self.assertIs(box.get("ok"), False)
        self.assertNotIn("error", box)

    def test_lost_stdout_does_not_stall_or_raise(self):
        read_fd, write_fd = os.pipe()
        os.close(read_fd)
        raw = os.fdopen(write_fd, "wb", buffering=0)
        held = sys.stdout
        wrapper = io.TextIOWrapper(raw, encoding="utf-8", write_through=True)
        sys.stdout = wrapper
        try:
            started = time.monotonic()
            try:
                ok = GUEST.write_frame({"event": "stopped", "nonce": NONCE_A, "cleanup": "unknown"})
            except BrokenPipeError:
                ok = "raised"
            elapsed = time.monotonic() - started
        finally:
            sys.stdout = held
            wrapper.close()
        self.assertIs(ok, False)
        self.assertLess(elapsed, 1.0)

    def test_kept_up_stdout_preserves_ndjson_frame(self):
        read_fd, write_fd = os.pipe()
        raw = os.fdopen(write_fd, "wb", buffering=0)
        held = sys.stdout
        wrapper = io.TextIOWrapper(raw, encoding="utf-8", write_through=True)
        sys.stdout = wrapper
        frame = {"event": "stopped", "nonce": NONCE_A, "cleanup": "verified"}
        try:
            result = GUEST.write_frame(frame)
            os.set_blocking(read_fd, False)
            data = os.read(read_fd, 8192)
        finally:
            sys.stdout = held
            os.close(read_fd)
            wrapper.close()
        self.assertTrue(data.endswith(b"\n"))
        self.assertEqual(json.loads(data.decode()), frame)
        self.assertIs(result, True)

    def test_pidfd_pid_reads_own_process_without_signalling(self):
        fd = os.pidfd_open(os.getpid())
        try:
            self.assertEqual(GUEST.Ops.pidfd_pid(fd), os.getpid())
        finally:
            os.close(fd)


@unittest.skipUnless(
    os.environ.get("CYDEWORKS_PINNED_BWRAP") and Path(os.environ["CYDEWORKS_PINNED_BWRAP"]).is_file(),
    "Live inner-bwrap supervisor tests require CYDEWORKS_PINNED_BWRAP inside the sandbox",
)
class OpenCodeStopGuestSandboxLiveTests(unittest.TestCase):
    def setUp(self):
        self.bwrap = os.environ["CYDEWORKS_PINNED_BWRAP"]

    def test_mismatched_dispatch_digest_blocks_release_and_stops_held_namespace(self):
        proc = subprocess.Popen(
            ["/usr/bin/python3", "-I", "-B", str(ROOT / "opencode-stop-guest.py"), "serve"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        try:
            start_cmd = json.dumps({"op": "start", "nonce": NONCE_A, "profile": "inert-fixture", "bwrap": self.bwrap}) + "\n"
            proc.stdin.write(start_cmd.encode())
            held = json.loads(proc.stdout.readline().decode())
            self.assertEqual(held["event"], "held")
            identity = held["identity"]

            bad_dispatch = json.dumps({"op": "dispatch", "nonce": NONCE_A, "digest": "0" * 64}) + "\n"
            proc.stdin.write(bad_dispatch.encode())
            frames = [json.loads(line.decode()) for line in proc.stdout]
            proc.wait(timeout=5)
            self.assertFalse(any(f.get("event") == "workload" for f in frames))
            self.assertTrue(any(f.get("event") == "blocked" for f in frames))
            stopped = [f for f in frames if f.get("event") == "stopped"]
            self.assertEqual(len(stopped), 1)
            self.assertEqual(stopped[0]["cleanup"], "verified")
            self.assertTrue(GUEST.confirm_identity(GUEST.Proc(), identity)["absent"])
        finally:
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream and not stream.closed:
                    stream.close()
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=3)

    def test_held_namespace_does_not_execute_workload_when_aborted_before_dispatch(self):
        proc = subprocess.Popen(
            ["/usr/bin/python3", "-I", "-B", str(ROOT / "opencode-stop-guest.py"), "serve"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        try:
            start_cmd = json.dumps({"op": "start", "nonce": NONCE_A, "profile": "inert-fixture", "bwrap": self.bwrap}) + "\n"
            proc.stdin.write(start_cmd.encode())
            held = json.loads(proc.stdout.readline().decode())
            self.assertEqual(held["event"], "held")
            self.assertEqual(held["nonce"], NONCE_A)
            identity = held["identity"]

            # Close stdin without sending dispatch: workload must never run.
            proc.stdin.close()
            frames = [json.loads(line.decode()) for line in proc.stdout]
            proc.wait(timeout=5)
            self.assertFalse(any(f.get("event") == "workload" for f in frames))
            stopped = [f for f in frames if f.get("event") == "stopped"]
            self.assertEqual(len(stopped), 1)
            self.assertEqual(stopped[0]["cleanup"], "verified")
            self.assertTrue(GUEST.confirm_identity(GUEST.Proc(), identity)["absent"])
        finally:
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream and not stream.closed:
                    stream.close()
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=3)

    def test_dispatched_multi_process_namespace_stops_and_verifies_cleanly(self):
        proc = subprocess.Popen(
            ["/usr/bin/python3", "-I", "-B", str(ROOT / "opencode-stop-guest.py"), "serve"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        try:
            start_cmd = json.dumps({"op": "start", "nonce": NONCE_B, "profile": "inert-fixture", "bwrap": self.bwrap}) + "\n"
            proc.stdin.write(start_cmd.encode())
            held = json.loads(proc.stdout.readline().decode())
            self.assertEqual(held["event"], "held")
            identity = held["identity"]

            dispatch_cmd = json.dumps({"op": "dispatch", "nonce": NONCE_B, "digest": held["digest"]}) + "\n"
            proc.stdin.write(dispatch_cmd.encode())
            dispatched = json.loads(proc.stdout.readline().decode())
            self.assertEqual(dispatched["event"], "dispatched")

            workload = json.loads(proc.stdout.readline().decode())
            self.assertEqual(workload["event"], "workload")
            payload_info = json.loads(workload["data"])
            self.assertEqual(payload_info["payload"], "inert-fixture")
            self.assertGreaterEqual(payload_info["nsInitPid"], 1)
            self.assertGreater(payload_info["nsChildPid"], payload_info["nsInitPid"])

            # Verify live namespace members (init reaper + payload + child) exist before Stop.
            members, ambiguous = GUEST.namespace_members(
                GUEST.Proc(), identity["init"]["pidNs"], identity["uid"], identity["depth"]
            )
            self.assertGreaterEqual(len(members), 3)
            self.assertEqual(ambiguous, [])

            # Stale nonce stop must not kill the live namespace.
            stale_stop = json.dumps({"op": "stop", "nonce": NONCE_A}) + "\n"
            proc.stdin.write(stale_stop.encode())
            ignored = json.loads(proc.stdout.readline().decode())
            self.assertEqual(ignored["event"], "ignored")
            self.assertEqual(ignored["reason"], "stale-nonce")
            self.assertEqual(ignored["cleanup"], "unknown")
            still_members, still_ambiguous = GUEST.namespace_members(
                GUEST.Proc(), identity["init"]["pidNs"], identity["uid"], identity["depth"]
            )
            self.assertGreaterEqual(len(still_members), 3)
            self.assertEqual(still_ambiguous, [])

            # Issue matching Stop and confirm every process in the namespace exits.
            stop_cmd = json.dumps({"op": "stop", "nonce": NONCE_B}) + "\n"
            proc.stdin.write(stop_cmd.encode())
            proc.stdin.close()
            stopped = json.loads(proc.stdout.readline().decode())
            proc.wait(timeout=5)
            self.assertEqual(stopped["event"], "stopped")
            self.assertEqual(stopped["cleanup"], "verified")
            self.assertTrue(GUEST.confirm_identity(GUEST.Proc(), identity)["absent"])

            # Out-of-band oneshot stop and confirm with expectedNonce envelope.
            for mode, expected_event in (("stop", "stopped"), ("confirm", "confirmed")):
                stale_oneshot = subprocess.run(
                    ["/usr/bin/python3", "-I", "-B", str(ROOT / "opencode-stop-guest.py"), mode],
                    input=(json.dumps({"identity": identity, "expectedNonce": NONCE_A}) + "\n").encode(),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=True,
                    timeout=5,
                )
                stale_reply = json.loads(stale_oneshot.stdout.decode())
                self.assertEqual(stale_reply["event"], expected_event)
                if mode == "stop":
                    self.assertEqual(stale_reply["cleanup"], "unknown")
                    self.assertEqual(stale_reply["evidence"].get("reason"), "stale-nonce")
                else:
                    self.assertFalse(stale_reply["absent"])
                    self.assertEqual(stale_reply.get("reason"), "stale-nonce")

                oneshot = subprocess.run(
                    ["/usr/bin/python3", "-I", "-B", str(ROOT / "opencode-stop-guest.py"), mode],
                    input=(json.dumps({"identity": identity, "expectedNonce": NONCE_B}) + "\n").encode(),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=True,
                    timeout=5,
                )
                reply = json.loads(oneshot.stdout.decode())
                self.assertEqual(reply["event"], expected_event)
                if mode == "stop":
                    self.assertEqual(reply["cleanup"], "verified")
                else:
                    self.assertTrue(reply["absent"])
        finally:
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream and not stream.closed:
                    stream.close()
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=3)


if __name__ == "__main__":
    unittest.main()
