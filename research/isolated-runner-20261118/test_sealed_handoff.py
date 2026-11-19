"""Synthetic tests for the sealed handoff. Linux only; all paths are fresh temp dirs."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

PILOT_DIR = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("sealed_handoff", PILOT_DIR / "sealed_handoff.py")
sh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sh)

LINUX = sys.platform == "linux"
def load_vectors():
    return json.loads((PILOT_DIR / "sealed-handoff-vector.json").read_text(encoding="utf-8"))["vectors"]
d = lambda b: hashlib.sha256(bytes(b)).digest()


def vector_entries(name):
    if name == "ascii":
        return [sh.SealedEntry(sh.KIND_FILE, "limits.py", 6, d(b"limit\n"), b"limit\n"),
                sh.SealedEntry(sh.KIND_DIR, "pkg"),
                sh.SealedEntry(sh.KIND_FILE, "pkg/m.py", 2, d(b"m\n"), b"m\n")]
    a, b = "é\n".encode(), "データ\n".encode()
    return [sh.SealedEntry(sh.KIND_DIR, "café"),
            sh.SealedEntry(sh.KIND_FILE, "café/naïve.py", len(a), d(a), a),
            sh.SealedEntry(sh.KIND_FILE, "日本.txt", len(b), d(b), b)]


def _write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _identity(path):
    st = os.stat(path, follow_symlinks=False)
    return st.st_dev, st.st_ino


def _swap_dir_for_link(path, target):
    os.rename(path, str(path) + "-old")
    os.symlink(target, path)


def _can_mount():
    probe = Path(tempfile.mkdtemp(prefix="mnt-probe-"))
    try:
        ok = subprocess.run(["mount", "-t", "tmpfs", "tmpfs", str(probe)], capture_output=True).returncode == 0
        if ok:
            subprocess.run(["umount", str(probe)], check=True)
        return ok
    finally:
        probe.rmdir()


CAN_MOUNT = LINUX and _can_mount()


class Tree:
    def __init__(self, case):
        self.base = Path(tempfile.mkdtemp(prefix="seal-"))
        case.addCleanup(subprocess.run, ["rm", "-rf", "--", str(self.base)], check=False)
        self.root = self.base / "proj"
        self.outside = self.base / "outside"
        _write(self.root / "a.txt", b"alpha\n")
        _write(self.root / "sub" / "file.txt", b"inside\n")
        _write(self.outside / "file.txt", b"SECRET-OUTSIDE\n")
        _write(self.outside / "a.txt", b"SECRET-OUTSIDE\n")
        self.dev, self.ino = _identity(self.root)

    def seal(self, **kw):
        return sh.seal_tree(str(self.root), self.dev, self.ino, **kw)


class Base(unittest.TestCase):
    def assertCode(self, code, fn, *args, **kw):
        with self.assertRaises(sh.SealError) as ctx:
            fn(*args, **kw)
        self.assertEqual(ctx.exception.code, code)


@unittest.skipUnless(LINUX, "sealed handoff is Linux only")
class SealTreeTests(Base):
    def test_seals_regular_tree_with_digests(self):
        t = Tree(self)
        bundle = t.seal()
        self.assertEqual([e.path for e in bundle.entries], ["a.txt", "sub", "sub/file.txt"])
        self.assertEqual(bundle.files(), {"a.txt": b"alpha\n", "sub/file.txt": b"inside\n"})
        self.assertEqual(t.seal().seal_digest, bundle.seal_digest)

    def test_negative_control_pathname_reader_is_redirected(self):
        t = Tree(self)
        _swap_dir_for_link(t.root / "sub", t.outside)
        self.assertEqual((t.root / "sub" / "file.txt").read_bytes(), b"SECRET-OUTSIDE\n")

    def test_parent_swap_after_pin_cannot_redirect_reads(self):
        t = Tree(self)
        def hook(event, rel):
            if event == "before-open" and rel == "sub/file.txt":
                _swap_dir_for_link(t.root / "sub", t.outside)
        bundle = t.seal(_hook=hook)
        self.assertEqual(bundle.files()["sub/file.txt"], b"inside\n")
        self.assertNotIn(b"SECRET", b"".join(bundle.files().values()))

    def test_directory_swapped_for_link_before_open_fails_closed(self):
        t = Tree(self)
        def hook(event, rel):
            if event == "before-open" and rel == "sub":
                _swap_dir_for_link(t.root / "sub", t.outside)
        self.assertCode("SEALED_ENTRY_CHANGED", t.seal, _hook=hook)

    def test_file_swapped_for_link_before_open_fails_closed(self):
        t = Tree(self)
        def hook(event, rel):
            if event == "before-open" and rel == "a.txt":
                os.rename(t.root / "a.txt", t.root / "a.old")
                os.symlink(t.outside / "a.txt", t.root / "a.txt")
        self.assertCode("SEALED_ENTRY_CHANGED", t.seal, _hook=hook)

    def test_file_replaced_by_other_regular_file_fails_closed(self):
        t = Tree(self)
        def hook(event, rel):
            if event == "before-open" and rel == "a.txt":
                os.rename(t.root / "a.txt", t.root / "a.old")
                _write(t.root / "a.txt", b"alpha\n")
        self.assertCode("SEALED_ENTRY_CHANGED", t.seal, _hook=hook)

    def test_ancestor_swap_before_root_open_fails_identity(self):
        t = Tree(self)
        _write(t.base / "decoy" / "proj" / "a.txt", b"SECRET-DECOY\n")
        moved = str(t.base) + "-moved"
        os.rename(t.base, moved)
        self.addCleanup(subprocess.run, ["rm", "-rf", "--", moved], check=False)
        os.symlink(moved, t.base)
        self.assertEqual(sh.seal_tree(str(t.root), t.dev, t.ino).files()["a.txt"], b"alpha\n")
        os.unlink(t.base)
        os.symlink(moved + "/decoy", t.base)
        self.assertCode("SEALED_ROOT_IDENTITY_MISMATCH", sh.seal_tree, str(t.root), t.dev, t.ino)

    def test_root_itself_a_link_is_rejected(self):
        t = Tree(self)
        os.symlink(t.root, t.base / "rootlink")
        self.assertCode("SEALED_ROOT_UNAVAILABLE", sh.seal_tree, str(t.base / "rootlink"), t.dev, t.ino)

    def test_static_link_fifo_hardlink_and_bom_name_rejected(self):
        t = Tree(self)
        os.symlink(t.outside / "a.txt", t.root / "z-link")
        self.assertCode("SEALED_LINK_REJECTED", t.seal)
        os.unlink(t.root / "z-link")
        os.mkfifo(t.root / "z-fifo")
        self.assertCode("SEALED_ENTRY_UNSUPPORTED", t.seal)
        os.unlink(t.root / "z-fifo")
        os.link(t.outside / "a.txt", t.root / "z-hard")
        self.assertCode("SEALED_HARDLINK_REJECTED", t.seal)
        os.unlink(t.root / "z-hard")
        _write(t.root / "\ufeffbom.txt", b"x")
        self.assertCode("SEALED_PATH_INVALID", t.seal)

    def test_file_modified_during_read_fails_closed(self):
        t = Tree(self)
        def hook(event, rel):
            if event == "after-read" and rel == "a.txt":
                with open(t.root / "a.txt", "ab") as f:
                    f.write(b"tail")
        self.assertCode("SEALED_ENTRY_CHANGED", t.seal, _hook=hook)

    def test_limits_enforced(self):
        t = Tree(self)
        self.assertCode("SEALED_LIMIT_EXCEEDED", t.seal, limits={"max_entries": 2})
        self.assertCode("SEALED_LIMIT_EXCEEDED", t.seal, limits={"max_total_bytes": 8})
        self.assertCode("SEALED_LIMIT_EXCEEDED", t.seal, limits={"max_depth": 1})

    def test_directory_listing_stops_at_entry_limit(self):
        t = Tree(self)
        for i in range(200):
            _write(t.root / "many" / f"f{i:03}", b"")
        real = sh._scandir
        yielded = {"n": 0}

        class Counting:
            def __init__(self, inner):
                self.inner = inner
            def __enter__(self):
                self.inner.__enter__()
                return self
            def __exit__(self, *exc):
                return self.inner.__exit__(*exc)
            def __iter__(self):
                for entry in self.inner:
                    yielded["n"] += 1
                    yield entry

        with mock.patch.object(sh, "_scandir", lambda fd: Counting(real(fd))):
            self.assertCode("SEALED_LIMIT_EXCEEDED", t.seal, limits={"max_entries": 10})
        self.assertLessEqual(yielded["n"], 11 + 3)

    @unittest.skipUnless(CAN_MOUNT, "UNVERIFIED: no private mount namespace in this environment")
    def test_tmpfs_mount_crossing_rejected(self):
        t = Tree(self)
        (t.root / "m").mkdir()
        subprocess.run(["mount", "-t", "tmpfs", "tmpfs", str(t.root / "m")], check=True)
        self.addCleanup(subprocess.run, ["umount", str(t.root / "m")], check=False)
        self.assertCode("SEALED_MOUNT_CROSSING", t.seal)

    @unittest.skipUnless(CAN_MOUNT, "UNVERIFIED: no private mount namespace in this environment")
    def test_same_filesystem_bind_mount_rejected(self):
        t = Tree(self)
        (t.root / "m").mkdir()
        subprocess.run(["mount", "--bind", str(t.outside), str(t.root / "m")], check=True)
        self.addCleanup(subprocess.run, ["umount", str(t.root / "m")], check=False)
        # Precondition: st_dev alone cannot see this mount.
        self.assertEqual(os.stat(t.root / "m").st_dev, os.stat(t.root).st_dev)
        self.assertCode("SEALED_MOUNT_CROSSING", t.seal)

    @unittest.skipUnless(CAN_MOUNT, "UNVERIFIED: no private mount namespace in this environment")
    def test_bind_mount_swapped_in_after_pin_rejected(self):
        t = Tree(self)
        def hook(event, rel):
            if event == "before-open" and rel == "sub":
                subprocess.run(["mount", "--bind", str(t.outside), str(t.root / "sub")], check=True)
                self.addCleanup(subprocess.run, ["umount", str(t.root / "sub")], check=False)
        self.assertCode("SEALED_MOUNT_CROSSING", t.seal, _hook=hook)


@unittest.skipUnless(LINUX, "sealed handoff is Linux only")
class MaterializeTests(Base):
    def setUp(self):
        self.t = Tree(self)
        self.bundle = self.t.seal()
        self.scratch = self.t.base / "scratch"
        self.scratch.mkdir(mode=0o700)
        self.parent_fd = os.open(self.scratch, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.addCleanup(os.close, self.parent_fd)

    def test_materializes_and_reseals(self):
        out = sh.materialize_bundle(self.bundle, self.bundle.seal_digest, self.parent_fd)
        self.addCleanup(os.close, out)
        self.assertEqual(sh.seal_fd(out).seal_digest, self.bundle.seal_digest)

    def test_ancestor_swap_cannot_redirect_writes(self):
        victim = self.t.base / "victim"
        victim.mkdir()
        def hook(event, rel):
            if event == "before-create" and rel == "a.txt":
                _swap_dir_for_link(self.scratch, victim)
        out = sh.materialize_bundle(self.bundle, self.bundle.seal_digest, self.parent_fd, _hook=hook)
        self.addCleanup(os.close, out)
        self.assertEqual(os.listdir(victim), [])

    def test_non_private_scratch_refused(self):
        os.chmod(self.scratch, 0o770)
        self.assertCode("SEALED_SCRATCH_NOT_EXCLUSIVE", sh.materialize_bundle,
                        self.bundle, self.bundle.seal_digest, self.parent_fd)

    def test_new_directory_replaced_by_populated_directory_detected(self):
        def hook(event, rel):
            if event == "after-mkdir" and rel == "sub":
                top = next(p for p in self.scratch.iterdir() if p.name.startswith("sealed-"))
                os.rename(top / "sub", self.scratch / "evicted")
                (top / "sub").mkdir(mode=0o700)
                _write(top / "sub" / "planted", b"x")
        self.assertCode("SEALED_SCRATCH_REPLACED", sh.materialize_bundle,
                        self.bundle, self.bundle.seal_digest, self.parent_fd, _hook=hook)

    def test_new_directory_replaced_by_non_private_directory_detected(self):
        def hook(event, rel):
            if event == "after-mkdir" and rel == "":
                top = next(p for p in self.scratch.iterdir() if p.name.startswith("sealed-"))
                top.rmdir()
                top.mkdir()
                os.chmod(top, 0o755)
        self.assertCode("SEALED_SCRATCH_NOT_EXCLUSIVE", sh.materialize_bundle,
                        self.bundle, self.bundle.seal_digest, self.parent_fd, _hook=hook)

    def test_requires_expected_digest_and_rejects_forged_bundles(self):
        self.assertCode("SEALED_EXPECTED_DIGEST_REQUIRED", sh.materialize_bundle, self.bundle, None, self.parent_fd)
        self.assertCode("SEALED_DIGEST_MISMATCH", sh.materialize_bundle, self.bundle, "0" * 64, self.parent_fd)
        forged_digest = sh.SealedBundle(self.bundle.entries, "1" * 64)
        self.assertCode("SEALED_DIGEST_MISMATCH", sh.materialize_bundle, forged_digest, self.bundle.seal_digest, self.parent_fd)
        e = self.bundle.entries[0]
        forged_data = sh.SealedBundle((sh.SealedEntry(e.kind, e.path, e.size, e.sha256, b"ALPHA\n"),) + self.bundle.entries[1:],
                                      self.bundle.seal_digest)
        self.assertCode("SEALED_BUNDLE_INVALID", sh.materialize_bundle, forged_data, self.bundle.seal_digest, self.parent_fd)
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_mutable_data_cannot_change_after_digest(self):
        data = bytearray(b"alpha\n")
        bundle = sh.build_bundle([sh.SealedEntry(sh.KIND_FILE, "a.txt", 6, d(data), data)])
        data[:] = b"EVIL!\n"
        self.assertIsInstance(bundle.entries[0].data, bytes)
        self.assertEqual(bundle.files()["a.txt"], b"alpha\n")
        # A hand-built bundle that keeps a mutable buffer is re-verified at materialization.
        shared = bytearray(b"alpha\n")
        handmade = sh.SealedBundle((sh.SealedEntry(sh.KIND_FILE, "a.txt", 6, d(shared), shared),), bundle.seal_digest)
        shared[:] = b"EVIL!\n"
        self.assertCode("SEALED_BUNDLE_INVALID", sh.materialize_bundle, handmade, bundle.seal_digest, self.parent_fd)


@unittest.skipUnless(LINUX, "sealed handoff is Linux only")
class CodecTests(Base):
    def test_cross_language_vectors_match(self):
        vectors = load_vectors()
        self.assertEqual({v["name"] for v in vectors}, {"ascii", "non-ascii"})
        for v in vectors:
            b = sh.build_bundle(vector_entries(v["name"]))
            self.assertEqual(sh.encode_bundle(b).hex(), v["hex"], v["name"])
            self.assertEqual(b.seal_digest, v["sealDigest"])
            decoded = sh.decode_bundle(bytes.fromhex(v["hex"]), v["sealDigest"])
            self.assertEqual({k: x.decode() for k, x in decoded.files().items()}, v["files"])

    def test_round_trip_requires_expected_digest(self):
        b = sh.build_bundle(vector_entries("ascii"))
        raw = sh.encode_bundle(b)
        self.assertCode("SEALED_EXPECTED_DIGEST_REQUIRED", sh.decode_bundle, raw, None)
        self.assertCode("SEALED_DIGEST_MISMATCH", sh.decode_bundle, raw, "0" * 64)

    def test_tampering_detected(self):
        b = sh.build_bundle(vector_entries("ascii"))
        raw = sh.encode_bundle(b)
        flip = lambda i: bytes(x ^ 1 if j == i else x for j, x in enumerate(raw))
        self.assertCode("SEALED_BUNDLE_INVALID", sh.decode_bundle, flip(len(raw) - 33), b.seal_digest)
        self.assertCode("SEALED_DIGEST_MISMATCH", sh.decode_bundle, flip(len(sh.MAGIC) + 9), b.seal_digest)
        self.assertCode("SEALED_DIGEST_MISMATCH", sh.decode_bundle, raw + b"\0", b.seal_digest)
        self.assertCode("SEALED_BUNDLE_INVALID", sh.decode_bundle, raw[:20], b.seal_digest)

    def test_bom_path_rejected_in_bundle_and_frame(self):
        self.assertCode("SEALED_PATH_INVALID", sh.build_bundle,
                        [sh.SealedEntry(sh.KIND_FILE, "\ufeffa", 0, d(b""), b"")])
        p = "\ufeffa".encode()
        manifest = sh.MAGIC + (1).to_bytes(4, "big") + bytes([2]) + len(p).to_bytes(4, "big") + p + (0).to_bytes(8, "big") + d(b"")
        dg = hashlib.sha256(manifest).digest()
        self.assertCode("SEALED_PATH_INVALID", sh.decode_bundle, manifest + dg, dg.hex())

    def test_size_caps_apply_before_copy_or_parse(self):
        limits = {"max_entries": 1, "max_total_bytes": 8, "max_file_bytes": 8, "max_path_bytes": 8}
        class Tripwire(bytearray):
            def __bytes__(self):
                raise AssertionError("input was copied before the size cap")
        self.assertCode("SEALED_LIMIT_EXCEEDED", sh.decode_bundle,
                        Tripwire(sh.max_frame_bytes(limits) + 1), "0" * 64, limits)
        with self.assertRaises(AssertionError):  # positive control: in-cap input is copied
            sh.decode_bundle(Tripwire(64), "0" * 64, limits)
        self.assertCode("SEALED_LIMIT_EXCEEDED", sh.build_bundle,
                        [sh.SealedEntry(sh.KIND_FILE, "a", 9, b"", bytearray(9))], limits)
        self.assertCode("SEALED_LIMIT_EXCEEDED", sh.build_bundle,
                        [sh.SealedEntry(sh.KIND_DIR, "a"), sh.SealedEntry(sh.KIND_DIR, "b")], limits)

    def test_entry_iterable_consumption_is_bounded(self):
        pulled = {"n": 0}

        def endless():
            while True:
                pulled["n"] += 1
                if pulled["n"] > 1000:
                    raise AssertionError("iterable consumed without bound")
                yield sh.SealedEntry(sh.KIND_DIR, f"d{pulled['n']}")

        self.assertCode("SEALED_LIMIT_EXCEEDED", sh.build_bundle, endless(), {"max_entries": 3})
        self.assertLessEqual(pulled["n"], 4)

    def test_declared_size_cannot_smuggle_large_buffers_into_copy_or_hash(self):
        calls = []

        def trip(*_args, **_kwargs):
            calls.append(1)
            raise AssertionError("copied or hashed before inspection")

        class Liar(bytearray):
            def __len__(self):
                return 1

        big = bytearray(1 << 20)
        small_sha = d(b"x")
        eight = bytearray(8)
        eight_sha = d(eight)
        liar = Liar(big)
        limits = {"max_file_bytes": 8, "max_total_bytes": 16}
        F, D = sh.KIND_FILE, sh.KIND_DIR
        with mock.patch.object(sh, "bytes", trip, create=True), \
                mock.patch.object(sh, "hashlib", types.SimpleNamespace(sha256=trip)):
            cases = [
                ("SEALED_LIMIT_EXCEEDED", [sh.SealedEntry(F, "a", 1, small_sha, big)]),
                ("SEALED_BUNDLE_INVALID", [sh.SealedEntry(F, "a", 1, small_sha, bytearray(5))]),
                ("SEALED_BUNDLE_INVALID", [sh.SealedEntry(F, "a", 1, big, b"x")]),
                ("SEALED_LIMIT_EXCEEDED", [sh.SealedEntry(F, n, 8, eight_sha, eight) for n in "abc"]),
                ("SEALED_BUNDLE_INVALID", [sh.SealedEntry(D, "d", 0, b"", big)]),
                ("SEALED_BUNDLE_INVALID", [sh.SealedEntry(F, "a", 1, small_sha, liar)]),
                ("SEALED_BUNDLE_INVALID", [sh.SealedEntry(F, "a", 1, small_sha, memoryview(big))]),
                ("SEALED_BUNDLE_INVALID", [sh.SealedEntry(F, "a", True, small_sha, b"x")]),
            ]
            for expected, entries in cases:
                self.assertCode(expected, sh.build_bundle, entries, limits)
            self.assertEqual(calls, [])
            with self.assertRaises(AssertionError):  # positive control: a valid entry reaches the copy
                sh.build_bundle([sh.SealedEntry(F, "a", 1, small_sha, bytearray(b"x"))], limits)
        self.assertEqual(len(calls), 1)

    def test_invalid_paths_and_order_rejected(self):
        for bad in ("..", "a/../b", "/abs", "a\\b", "c:x", "a//b", "x\x01"):
            self.assertCode("SEALED_PATH_INVALID", sh.build_bundle, [sh.SealedEntry(sh.KIND_FILE, bad, 0, d(b""), b"")])
        self.assertCode("SEALED_BUNDLE_INVALID", sh.build_bundle, [sh.SealedEntry(sh.KIND_FILE, "nodir/x", 0, d(b""), b"")])
        self.assertCode("SEALED_CASE_COLLISION", sh.build_bundle,
                        [sh.SealedEntry(sh.KIND_FILE, "A", 0, d(b""), b""), sh.SealedEntry(sh.KIND_FILE, "a", 0, d(b""), b"")])
        entries = list(reversed(sh.build_bundle(vector_entries("ascii")).entries))
        manifest = sh._manifest_bytes(entries)
        raw = manifest + b"".join(e.data for e in entries) + hashlib.sha256(manifest).digest()
        self.assertCode("SEALED_BUNDLE_INVALID", sh.decode_bundle, raw, hashlib.sha256(manifest).hexdigest())


class PlatformGateTests(Base):
    def test_non_linux_fails_closed(self):
        for platform in ("win32", "darwin", "cygwin", "freebsd14"):
            self.assertCode("SEALED_HANDOFF_UNSUPPORTED", sh.require_supported,
                            platform=platform, supports_dir_fd=True, openat2_available=True)

    def test_missing_dir_fd_or_openat2_fails_closed(self):
        self.assertCode("SEALED_HANDOFF_UNSUPPORTED", sh.require_supported,
                        platform="linux", supports_dir_fd=False, openat2_available=True)
        self.assertCode("SEALED_HANDOFF_UNSUPPORTED", sh.require_supported,
                        platform="linux", supports_dir_fd=True, openat2_available=False)

    @unittest.skipUnless(LINUX, "Linux only")
    def test_openat2_unavailable_blocks_sealing(self):
        t = Tree(self)
        with mock.patch.object(sh, "_probe_openat2", return_value=False):
            self.assertCode("SEALED_HANDOFF_UNSUPPORTED", t.seal)


def emit_vectors():
    out = []
    for name in ("ascii", "non-ascii"):
        b = sh.build_bundle(vector_entries(name))
        out.append({"name": name, "sealDigest": b.seal_digest, "hex": sh.encode_bundle(b).hex(),
                    "files": {k: v.decode() for k, v in b.files().items()}})
    print(json.dumps({"vectors": out}, ensure_ascii=True, indent=1))


if __name__ == "__main__":
    if sys.argv[1:] == ["--emit-vectors"]:
        emit_vectors()
    else:
        unittest.main()
