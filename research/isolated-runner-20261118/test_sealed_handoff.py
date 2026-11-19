"""Synthetic tests for the sealed handoff. Linux only; all paths are fresh temp dirs."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

PILOT_DIR = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("sealed_handoff", PILOT_DIR / "sealed_handoff.py")
sh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sh)

LINUX = sys.platform == "linux"


def _write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _identity(path):
    st = os.stat(path, follow_symlinks=False)
    return st.st_dev, st.st_ino


def _swap_dir_for_link(path, target):
    os.rename(path, str(path) + "-old")
    os.symlink(target, path)


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


@unittest.skipUnless(LINUX, "sealed handoff is Linux only")
class SealTreeTests(unittest.TestCase):
    def assertCode(self, code, fn, *args, **kw):
        with self.assertRaises(sh.SealError) as ctx:
            fn(*args, **kw)
        self.assertEqual(ctx.exception.code, code)

    def test_seals_regular_tree_with_digests(self):
        t = Tree(self)
        bundle = t.seal()
        self.assertEqual([e.path for e in bundle.entries], ["a.txt", "sub", "sub/file.txt"])
        self.assertEqual(bundle.files(), {"a.txt": b"alpha\n", "sub/file.txt": b"inside\n"})
        self.assertEqual(bundle.entries[0].sha256, hashlib.sha256(b"alpha\n").digest())
        self.assertEqual(t.seal().seal_digest, bundle.seal_digest)

    def test_negative_control_pathname_reader_is_redirected(self):
        # Proves the swap below really redirects a pathname consumer.
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
        decoy = t.base / "decoy" / "proj"
        _write(decoy / "a.txt", b"SECRET-DECOY\n")
        os.rename(t.base, str(t.base) + "-moved")
        os.symlink(str(t.base) + "-moved", t.base)  # same tree via link: identity still matches
        self.assertEqual(sh.seal_tree(str(t.root), t.dev, t.ino).files()["a.txt"], b"alpha\n")
        os.unlink(t.base)
        os.symlink(str(t.base) + "-moved/decoy", t.base)  # ancestor now names a different proj
        self.addCleanup(subprocess.run, ["rm", "-rf", "--", str(t.base) + "-moved"], check=False)
        self.assertCode("SEALED_ROOT_IDENTITY_MISMATCH", sh.seal_tree, str(t.root), t.dev, t.ino)

    def test_root_itself_a_link_is_rejected(self):
        t = Tree(self)
        link = t.base / "rootlink"
        os.symlink(t.root, link)
        self.assertCode("SEALED_ROOT_UNAVAILABLE", sh.seal_tree, str(link), t.dev, t.ino)

    def test_static_link_fifo_and_hardlink_rejected(self):
        t = Tree(self)
        os.symlink(t.outside / "a.txt", t.root / "z-link")
        self.assertCode("SEALED_LINK_REJECTED", t.seal)
        os.unlink(t.root / "z-link")
        os.mkfifo(t.root / "z-fifo")
        self.assertCode("SEALED_ENTRY_UNSUPPORTED", t.seal)
        os.unlink(t.root / "z-fifo")
        os.link(t.outside / "a.txt", t.root / "z-hard")
        self.assertCode("SEALED_HARDLINK_REJECTED", t.seal)

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

    def test_mount_crossing_rejected_when_mount_is_possible(self):
        t = Tree(self)
        (t.root / "m").mkdir()
        if subprocess.run(["mount", "-t", "tmpfs", "tmpfs", str(t.root / "m")],
                          capture_output=True).returncode != 0:
            self.skipTest("no private mount namespace available")
        self.addCleanup(subprocess.run, ["umount", str(t.root / "m")], check=False)
        self.assertCode("SEALED_MOUNT_CROSSING", t.seal)

    def test_materialize_writes_only_through_held_handles(self):
        t = Tree(self)
        bundle = t.seal()
        dest = t.base / "dest"
        dest.mkdir()
        victim = t.base / "victim"
        victim.mkdir()
        parent_fd = os.open(dest, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.addCleanup(os.close, parent_fd)
        def hook(event, rel):
            if event == "before-create" and rel == "a.txt":
                _swap_dir_for_link(dest, victim)
        out_fd = sh.materialize_bundle(bundle, parent_fd, "sealed", _hook=hook)
        self.addCleanup(os.close, out_fd)
        self.assertEqual(os.listdir(victim), [])
        self.assertEqual((Path(str(dest) + "-old") / "sealed" / "sub" / "file.txt").read_bytes(), b"inside\n")
        st = os.fstat(out_fd)
        resealed = sh.seal_tree(f"/proc/self/fd/{out_fd}/.", st.st_dev, st.st_ino)
        self.assertEqual(resealed.seal_digest, bundle.seal_digest)
        self.assertCode("SEALED_PATH_INVALID", sh.materialize_bundle, bundle, parent_fd, "..")


@unittest.skipUnless(LINUX, "sealed handoff is Linux only")
class CodecTests(unittest.TestCase):
    def sample(self):
        d = lambda b: hashlib.sha256(b).digest()
        return sh.build_bundle([
            sh.SealedEntry(sh.KIND_FILE, "limits.py", 6, d(b"limit\n"), b"limit\n"),
            sh.SealedEntry(sh.KIND_DIR, "pkg"),
            sh.SealedEntry(sh.KIND_FILE, "pkg/m.py", 2, d(b"m\n"), b"m\n"),
        ])

    def assertCode(self, code, fn, *args, **kw):
        with self.assertRaises(sh.SealError) as ctx:
            fn(*args, **kw)
        self.assertEqual(ctx.exception.code, code)

    def test_round_trip_and_expected_digest(self):
        b = self.sample()
        raw = sh.encode_bundle(b)
        self.assertEqual(sh.decode_bundle(raw, b.seal_digest).files(), b.files())
        self.assertCode("SEALED_DIGEST_MISMATCH", sh.decode_bundle, raw, "0" * 64)

    def test_golden_vector_matches(self):
        vector = json.loads((PILOT_DIR / "sealed-handoff-vector.json").read_text())
        b = self.sample()
        self.assertEqual(sh.encode_bundle(b).hex(), vector["hex"])
        self.assertEqual(b.seal_digest, vector["sealDigest"])

    def test_tampering_detected(self):
        raw = bytearray(sh.encode_bundle(self.sample()))
        content_flip = bytearray(raw)
        content_flip[-33] ^= 1
        self.assertCode("SEALED_BUNDLE_INVALID", sh.decode_bundle, bytes(content_flip))
        manifest_flip = bytearray(raw)
        manifest_flip[len(sh.MAGIC) + 4 + 5] ^= 1
        with self.assertRaises(sh.SealError):
            sh.decode_bundle(bytes(manifest_flip))
        self.assertCode("SEALED_DIGEST_MISMATCH", sh.decode_bundle, bytes(raw) + b"\0")
        self.assertCode("SEALED_BUNDLE_INVALID", sh.decode_bundle, bytes(raw[:20]))

    def test_invalid_paths_and_order_rejected(self):
        d = hashlib.sha256(b"").digest()
        for bad in ("..", "a/../b", "/abs", "a\\b", "c:x", "a//b", "x\x01"):
            self.assertCode("SEALED_PATH_INVALID", sh.build_bundle, [sh.SealedEntry(sh.KIND_FILE, bad, 0, d, b"")])
        self.assertCode("SEALED_BUNDLE_INVALID", sh.build_bundle, [sh.SealedEntry(sh.KIND_FILE, "nodir/x", 0, d, b"")])
        self.assertCode("SEALED_CASE_COLLISION", sh.build_bundle,
                        [sh.SealedEntry(sh.KIND_FILE, "A", 0, d, b""), sh.SealedEntry(sh.KIND_FILE, "a", 0, d, b"")])
        # A hand-built unsorted frame is rejected even with a correct digest.
        entries = list(reversed(self.sample().entries))
        manifest = sh._manifest_bytes(entries)
        raw = manifest + b"".join(e.data for e in entries) + hashlib.sha256(manifest).digest()
        self.assertCode("SEALED_BUNDLE_INVALID", sh.decode_bundle, raw)


class PlatformGateTests(unittest.TestCase):
    def test_non_linux_fails_closed(self):
        for platform in ("win32", "darwin", "cygwin", "freebsd14"):
            with self.assertRaises(sh.SealError) as ctx:
                sh.require_supported(platform=platform, supports_dir_fd=True)
            self.assertEqual(ctx.exception.code, "SEALED_HANDOFF_UNSUPPORTED")

    def test_missing_dir_fd_fails_closed(self):
        with self.assertRaises(sh.SealError):
            sh.require_supported(platform="linux", supports_dir_fd=False)


if __name__ == "__main__":
    unittest.main()
