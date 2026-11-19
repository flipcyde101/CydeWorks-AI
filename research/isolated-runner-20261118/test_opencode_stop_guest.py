"""Tests for opencode-stop-guest.py.

Designed to run inside an OS-enforced Bubblewrap sandbox with no external
network, empty allowlisted environment, read-only target and toolchain mounts,
scratch-only /tmp and /work writes, and strict CPU/memory/process/time limits.
"""

import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("opencode_stop_guest", ROOT / "opencode-stop-guest.py")
GUEST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GUEST)

NONCE_A = "11111111-2222-4333-8444-555555555555"
NONCE_B = "66666666-7777-4888-9999-aaaaaaaaaaaa"
BOOT_ID = "01234567-89ab-cdef-0123-456789abcdef"


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

            # Issue Stop and confirm every process in the namespace exits.
            stop_cmd = json.dumps({"op": "stop", "nonce": NONCE_B}) + "\n"
            proc.stdin.write(stop_cmd.encode())
            proc.stdin.close()
            stopped = json.loads(proc.stdout.readline().decode())
            proc.wait(timeout=5)
            self.assertEqual(stopped["event"], "stopped")
            self.assertEqual(stopped["cleanup"], "verified")
            self.assertTrue(GUEST.confirm_identity(GUEST.Proc(), identity)["absent"])

            # Out-of-band oneshot stop and confirm on the exited identity are idempotent.
            for mode, expected_event in (("stop", "stopped"), ("confirm", "confirmed")):
                oneshot = subprocess.run(
                    ["/usr/bin/python3", "-I", "-B", str(ROOT / "opencode-stop-guest.py"), mode],
                    input=(json.dumps(identity) + "\n").encode(),
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
