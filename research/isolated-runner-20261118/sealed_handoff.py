"""Sealed project and artifact handoff (research, disconnected).

This module owns trusted directory handles. It walks a tree with Linux openat2 using
RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV relative to
directory handles it holds, starting from one pinned root handle whose (dev, ino) must
equal the identity the caller supplies. The bytes it reads become an immutable,
content-addressed bundle. Consumers receive bytes, never a pathname.

What the seal digest is: byte integrity of the bundle only. It is not owner approval,
host attestation, root identity or replay protection. The expected digest and expected
root identity are caller supplied here; a trusted host must supply them independently
before any authorization or provenance claim can be made.

What the bundle is not: a whole-tree point-in-time filesystem snapshot. Concurrent
edits inside the root can make sealing fail or seal files that never coexisted.

Scope: Linux on x86_64 or aarch64 with a working openat2. Everything else fails closed
with SEALED_HANDOFF_UNSUPPORTED. Windows trees reached through WSL drvfs are not
qualified. Not connected to the browser, production approval/auth or the live runner.
"""

from dataclasses import dataclass
import ctypes
import errno
import hashlib
import os
import platform as _platform
import secrets
import stat
import struct
import sys

MAGIC = b"CWSEAL1\0"
KIND_DIR = 1
KIND_FILE = 2
DIGEST_LEN = 32
FILE_HEAD = 5 + 8 + DIGEST_LEN

DEFAULT_LIMITS = {
    "max_entries": 4096,
    "max_total_bytes": 64 * 1024 * 1024,
    "max_file_bytes": 16 * 1024 * 1024,
    "max_depth": 32,
    "max_path_bytes": 1024,
}

_FORBIDDEN_NAME_CHARS = set("/\\:﻿")

# openat2(2): syscall 437 on x86_64 and aarch64 (unified numbering), struct open_how.
_SYS_OPENAT2 = 437
RESOLVE_NO_XDEV = 0x01
RESOLVE_NO_MAGICLINKS = 0x02
RESOLVE_NO_SYMLINKS = 0x04
RESOLVE_BENEATH = 0x08
_RESOLVE = RESOLVE_NO_XDEV | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH


class _OpenHow(ctypes.Structure):
    _fields_ = [("flags", ctypes.c_uint64), ("mode", ctypes.c_uint64), ("resolve", ctypes.c_uint64)]


class SealError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _fail(code, message):
    raise SealError(code, message)


_libc = None
_openat2_state = None


def _syscall_openat2(dir_fd, name, flags, mode=0):
    how = _OpenHow(flags, mode, _RESOLVE)
    fd = _libc.syscall(ctypes.c_long(_SYS_OPENAT2), ctypes.c_int(dir_fd), ctypes.c_char_p(os.fsencode(name)),
                       ctypes.byref(how), ctypes.c_size_t(ctypes.sizeof(how)))
    if fd < 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))
    return fd


def _probe_openat2():
    global _libc, _openat2_state
    if _openat2_state is not None:
        return _openat2_state
    _openat2_state = False
    if sys.platform != "linux" or _platform.machine() not in ("x86_64", "aarch64"):
        return False
    try:
        _libc = ctypes.CDLL(None, use_errno=True)
        _libc.syscall.restype = ctypes.c_long
        base = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.close(_syscall_openat2(base, ".", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC))
        finally:
            os.close(base)
    except (OSError, AttributeError):
        return False
    _openat2_state = True
    return True


def require_supported(platform=None, supports_dir_fd=None, openat2_available=None):
    """Fail closed unless handle-relative, no-follow, no-cross-mount opens really work."""
    platform = sys.platform if platform is None else platform
    if supports_dir_fd is None:
        supports_dir_fd = (os.stat in os.supports_dir_fd and os.mkdir in os.supports_dir_fd
                           and os.scandir in os.supports_fd)
    needed = ("O_NOFOLLOW", "O_DIRECTORY", "O_CLOEXEC", "O_NONBLOCK", "O_NOCTTY")
    if platform != "linux" or not supports_dir_fd or not all(hasattr(os, n) for n in needed):
        _fail("SEALED_HANDOFF_UNSUPPORTED", "Sealed handoff requires Linux handle-relative opens; failing closed.")
    if openat2_available is None:
        openat2_available = _probe_openat2()
    if not openat2_available:
        _fail("SEALED_HANDOFF_UNSUPPORTED", "openat2 with RESOLVE_NO_XDEV is unavailable; failing closed.")


def _openat2(dir_fd, name, flags, mode=0):
    require_supported()
    return _syscall_openat2(dir_fd, name, flags, mode)


def validate_component(name):
    if not isinstance(name, str) or name in ("", ".", ".."):
        _fail("SEALED_PATH_INVALID", "Entry name is empty or a relative reference.")
    if any(ch in _FORBIDDEN_NAME_CHARS or ord(ch) < 0x20 or ord(ch) == 0x7F for ch in name):
        _fail("SEALED_PATH_INVALID", "Entry name contains a separator, colon, BOM or control character.")
    try:
        encoded = name.encode("utf-8")
    except UnicodeEncodeError:
        _fail("SEALED_PATH_INVALID", "Entry name is not valid UTF-8.")
    if len(encoded) > 255:
        _fail("SEALED_PATH_INVALID", "Entry name is too long.")
    return encoded


def validate_rel_path(path, limits=None):
    limits = {**DEFAULT_LIMITS, **(limits or {})}
    if not isinstance(path, str):
        _fail("SEALED_PATH_INVALID", "Entry path is not text.")
    parts = path.split("/")
    for part in parts:
        validate_component(part)
    encoded = path.encode("utf-8")
    if len(encoded) > limits["max_path_bytes"]:
        _fail("SEALED_PATH_INVALID", "Entry path is too long.")
    if len(parts) > limits["max_depth"]:
        _fail("SEALED_LIMIT_EXCEEDED", "Entry path is too deep.")
    return encoded


@dataclass(frozen=True)
class SealedEntry:
    kind: int
    path: str
    size: int = 0
    sha256: bytes = b""
    data: bytes = b""


@dataclass(frozen=True)
class SealedBundle:
    entries: tuple
    seal_digest: str
    root_dev: int = -1
    root_ino: int = -1

    def files(self):
        return {e.path: e.data for e in self.entries if e.kind == KIND_FILE}


def max_frame_bytes(limits=None):
    limits = {**DEFAULT_LIMITS, **(limits or {})}
    return (len(MAGIC) + 4 + limits["max_entries"] * (FILE_HEAD + limits["max_path_bytes"])
            + limits["max_total_bytes"] + DIGEST_LEN)


def _manifest_bytes(entries):
    out = [MAGIC, struct.pack(">I", len(entries))]
    for e in entries:
        p = e.path.encode("utf-8")
        out.append(struct.pack(">BI", e.kind, len(p)))
        out.append(p)
        if e.kind == KIND_FILE:
            out.append(struct.pack(">Q", e.size))
            out.append(e.sha256)
    return b"".join(out)


def _immutable_entry(e):
    """Copy caller data into immutable bytes before anything is hashed or retained."""
    if not isinstance(e, SealedEntry):
        _fail("SEALED_BUNDLE_INVALID", "Entry is not a SealedEntry.")
    if e.kind == KIND_DIR:
        if e.size or e.data or e.sha256:
            _fail("SEALED_BUNDLE_INVALID", "Directory entry carries data.")
        return SealedEntry(KIND_DIR, e.path)
    if e.kind != KIND_FILE:
        _fail("SEALED_BUNDLE_INVALID", "Unsupported entry kind.")
    if not isinstance(e.data, (bytes, bytearray, memoryview)) or not isinstance(e.sha256, (bytes, bytearray)):
        _fail("SEALED_BUNDLE_INVALID", "File entry data must be bytes.")
    data = bytes(e.data)
    sha = bytes(e.sha256)
    if not isinstance(e.size, int) or len(data) != e.size or hashlib.sha256(data).digest() != sha:
        _fail("SEALED_BUNDLE_INVALID", "File entry content does not match its digest.")
    return SealedEntry(KIND_FILE, e.path, e.size, sha, data)


def _check_canonical_order(entries, limits):
    previous = None
    kinds = {}
    case_seen = set()
    for e in entries:
        encoded = validate_rel_path(e.path, limits)
        if previous is not None and not previous < encoded:
            _fail("SEALED_BUNDLE_INVALID", "Entries are not in strict canonical order.")
        previous = encoded
        parent = e.path.rpartition("/")[0]
        if parent and kinds.get(parent) != KIND_DIR:
            _fail("SEALED_BUNDLE_INVALID", "Entry parent is not a sealed directory.")
        folded = e.path.casefold()
        if folded in case_seen:
            _fail("SEALED_CASE_COLLISION", "Entries collide when compared without case.")
        case_seen.add(folded)
        kinds[e.path] = e.kind


def build_bundle(entries, limits=None, root_dev=-1, root_ino=-1):
    limits = {**DEFAULT_LIMITS, **(limits or {})}
    entries = list(entries)
    if len(entries) > limits["max_entries"]:
        _fail("SEALED_LIMIT_EXCEEDED", "Too many entries.")
    total = 0
    for e in entries:
        size = getattr(e, "size", 0)
        if not isinstance(size, int) or size < 0 or size > limits["max_file_bytes"]:
            _fail("SEALED_LIMIT_EXCEEDED", "File entry is too large.")
        total += size
    if total > limits["max_total_bytes"]:
        _fail("SEALED_LIMIT_EXCEEDED", "Too many bytes.")
    copied = [_immutable_entry(e) for e in entries]
    for e in copied:
        validate_rel_path(e.path, limits)
    ordered = tuple(sorted(copied, key=lambda e: e.path.encode("utf-8")))
    _check_canonical_order(ordered, limits)
    digest = hashlib.sha256(_manifest_bytes(ordered)).hexdigest()
    return SealedBundle(entries=ordered, seal_digest=digest, root_dev=root_dev, root_ino=root_ino)


def verify_bundle(bundle, expected_digest, limits=None):
    """Rebuild from the bundle's entries (copying data) and require the caller-supplied digest.

    Integrity only: a matching digest says these are the expected bytes. Whether that digest
    was approved by the owner is for a trusted host to establish independently.
    """
    if not isinstance(bundle, SealedBundle):
        _fail("SEALED_BUNDLE_INVALID", "Not a sealed bundle.")
    if not isinstance(expected_digest, str) or len(expected_digest) != 64:
        _fail("SEALED_EXPECTED_DIGEST_REQUIRED", "An independently supplied expected digest is required.")
    rebuilt = build_bundle(bundle.entries, limits)
    if rebuilt.entries != tuple(bundle.entries):
        _fail("SEALED_BUNDLE_INVALID", "Bundle entries are not canonical.")
    if rebuilt.seal_digest != expected_digest or bundle.seal_digest != expected_digest:
        _fail("SEALED_DIGEST_MISMATCH", "Bundle is not the expected seal.")
    return rebuilt


def _hook_call(hook, event, rel):
    if hook is not None:
        hook(event, rel)


def _same_object(a, b):
    return a.st_dev == b.st_dev and a.st_ino == b.st_ino and stat.S_IFMT(a.st_mode) == stat.S_IFMT(b.st_mode)


_scandir = os.scandir  # single listing entry point (tests count yields through it)

_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
_FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK | os.O_NOCTTY


def _seal_fd(root_fd, limits, hook):
    entries = []
    state = {"bytes": 0}
    root_st = os.fstat(root_fd)
    if not stat.S_ISDIR(root_st.st_mode):
        _fail("SEALED_ROOT_UNAVAILABLE", "The root handle is not a directory.")

    def list_bounded(dir_fd):
        names = []
        try:
            with _scandir(dir_fd) as listing:
                for entry in listing:
                    if len(entries) + len(names) + 1 > limits["max_entries"]:
                        _fail("SEALED_LIMIT_EXCEEDED", "Approved tree has too many entries.")
                    validate_component(entry.name)
                    names.append(entry.name)
        except OSError:
            _fail("SEALED_ENTRY_UNREADABLE", "A directory could not be listed.")
        return sorted(names)

    def walk(dir_fd, prefix, depth):
        if depth > limits["max_depth"]:
            _fail("SEALED_LIMIT_EXCEEDED", "Tree is too deep.")
        for name in list_bounded(dir_fd):
            rel = f"{prefix}/{name}" if prefix else name
            validate_rel_path(rel, limits)
            if len(entries) + 1 > limits["max_entries"]:
                _fail("SEALED_LIMIT_EXCEEDED", "Tree has too many entries.")
            try:
                pre = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
            except OSError:
                _fail("SEALED_ENTRY_CHANGED", "An entry disappeared during sealing.")
            if stat.S_ISLNK(pre.st_mode):
                _fail("SEALED_LINK_REJECTED", "Trees cannot contain symbolic links or junctions.")
            if not (stat.S_ISDIR(pre.st_mode) or stat.S_ISREG(pre.st_mode)):
                _fail("SEALED_ENTRY_UNSUPPORTED", "Trees may contain only directories and regular files.")
            _hook_call(hook, "before-open", rel)
            is_dir = stat.S_ISDIR(pre.st_mode)
            try:
                fd = _openat2(dir_fd, name, _DIR_FLAGS if is_dir else _FILE_FLAGS)
            except OSError as error:
                if error.errno == errno.EXDEV:
                    _fail("SEALED_MOUNT_CROSSING", "Trees cannot cross a mount point, including bind mounts.")
                _fail("SEALED_ENTRY_CHANGED", "An entry changed type during sealing.")
            try:
                st = os.fstat(fd)
                if not _same_object(pre, st):
                    _fail("SEALED_ENTRY_CHANGED", "An entry was replaced during sealing.")
                if st.st_dev != root_st.st_dev:
                    _fail("SEALED_MOUNT_CROSSING", "Trees cannot cross a mount point.")
                if is_dir:
                    entries.append(SealedEntry(KIND_DIR, rel))
                    walk(fd, rel, depth + 1)
                    continue
                if st.st_nlink != 1:
                    _fail("SEALED_HARDLINK_REJECTED", "Files cannot have additional hard links.")
                if st.st_size > limits["max_file_bytes"] or state["bytes"] + st.st_size > limits["max_total_bytes"]:
                    _fail("SEALED_LIMIT_EXCEEDED", "Tree exceeds its byte limit.")
                chunks, total = [], 0
                while total <= st.st_size:
                    piece = os.read(fd, min(1 << 20, st.st_size + 1 - total))
                    if not piece:
                        break
                    chunks.append(piece)
                    total += len(piece)
                _hook_call(hook, "after-read", rel)
                after = os.fstat(fd)
                data = b"".join(chunks)
                if (len(data) != st.st_size or after.st_size != st.st_size or
                        after.st_mtime_ns != st.st_mtime_ns or after.st_ctime_ns != st.st_ctime_ns):
                    _fail("SEALED_ENTRY_CHANGED", "A file changed while it was read.")
                state["bytes"] += len(data)
                entries.append(SealedEntry(KIND_FILE, rel, len(data), hashlib.sha256(data).digest(), data))
            finally:
                os.close(fd)

    walk(root_fd, "", 1)
    return build_bundle(entries, limits, root_st.st_dev, root_st.st_ino)


def seal_tree(root_path, expected_dev, expected_ino, limits=None, _hook=None):
    """Seal under one pinned root handle.

    The root pathname is resolved once with O_DIRECTORY|O_NOFOLLOW. The opened handle's
    (dev, ino) must equal the caller-supplied identity, which a trusted host must supply.
    Every later lookup is openat2 relative to a held handle with no symlinks, no magic
    links, no escape and no mount crossing.
    """
    require_supported()
    limits = {**DEFAULT_LIMITS, **(limits or {})}
    try:
        root_fd = os.open(root_path, _DIR_FLAGS)
    except OSError:
        _fail("SEALED_ROOT_UNAVAILABLE", "The root could not be opened as a link-free directory.")
    try:
        root_st = os.fstat(root_fd)
        if root_st.st_dev != expected_dev or root_st.st_ino != expected_ino:
            _fail("SEALED_ROOT_IDENTITY_MISMATCH", "The opened root is not the expected directory.")
        _hook_call(_hook, "root-pinned", "")
        return _seal_fd(root_fd, limits, _hook)
    finally:
        os.close(root_fd)


def seal_fd(root_fd, limits=None):
    """Seal a tree from a directory handle the caller already holds."""
    require_supported()
    return _seal_fd(root_fd, {**DEFAULT_LIMITS, **(limits or {})}, None)


def encode_bundle(bundle):
    if not isinstance(bundle, SealedBundle):
        _fail("SEALED_BUNDLE_INVALID", "Not a sealed bundle.")
    rebuilt = verify_bundle(bundle, bundle.seal_digest)
    content = b"".join(e.data for e in rebuilt.entries if e.kind == KIND_FILE)
    manifest = _manifest_bytes(rebuilt.entries)
    return manifest + content + hashlib.sha256(manifest).digest()


def decode_bundle(raw, expected_digest, limits=None):
    limits = {**DEFAULT_LIMITS, **(limits or {})}
    if not isinstance(raw, (bytes, bytearray)):
        _fail("SEALED_BUNDLE_INVALID", "Bundle must be bytes.")
    if len(raw) > max_frame_bytes(limits):
        _fail("SEALED_LIMIT_EXCEEDED", "Bundle exceeds the frame limit.")
    if not isinstance(expected_digest, str) or len(expected_digest) != 64:
        _fail("SEALED_EXPECTED_DIGEST_REQUIRED", "An independently supplied expected digest is required.")
    if len(raw) < len(MAGIC) + 4 + DIGEST_LEN:
        _fail("SEALED_BUNDLE_INVALID", "Bundle is truncated.")
    raw = bytes(raw)  # bounded above; later caller mutation cannot change what is verified
    if raw[:len(MAGIC)] != MAGIC:
        _fail("SEALED_BUNDLE_INVALID", "Bundle has an unknown format.")
    pos = len(MAGIC)
    (count,) = struct.unpack_from(">I", raw, pos)
    pos += 4
    if count > limits["max_entries"]:
        _fail("SEALED_LIMIT_EXCEEDED", "Too many entries.")
    heads = []
    total = 0
    try:
        for _ in range(count):
            kind, plen = struct.unpack_from(">BI", raw, pos)
            pos += 5
            if plen > limits["max_path_bytes"] or pos + plen > len(raw):
                _fail("SEALED_BUNDLE_INVALID", "Entry path is malformed.")
            path = raw[pos:pos + plen].decode("utf-8")
            pos += plen
            if kind == KIND_FILE:
                (size,) = struct.unpack_from(">Q", raw, pos)
                pos += 8
                sha = raw[pos:pos + DIGEST_LEN]
                if len(sha) != DIGEST_LEN:
                    _fail("SEALED_BUNDLE_INVALID", "File entry header is malformed.")
                if size > limits["max_file_bytes"] or total + size > limits["max_total_bytes"]:
                    _fail("SEALED_LIMIT_EXCEEDED", "Bundle content exceeds its limit.")
                total += size
                pos += DIGEST_LEN
                heads.append((kind, path, size, sha))
            elif kind == KIND_DIR:
                heads.append((kind, path, 0, b""))
            else:
                _fail("SEALED_BUNDLE_INVALID", "Unsupported entry kind.")
    except (struct.error, UnicodeDecodeError):
        _fail("SEALED_BUNDLE_INVALID", "Bundle manifest is malformed.")
    manifest_end = pos
    digest = hashlib.sha256(raw[:manifest_end]).digest()
    if len(raw) != manifest_end + total + DIGEST_LEN or raw[-DIGEST_LEN:] != digest:
        _fail("SEALED_DIGEST_MISMATCH", "Bundle framing or seal digest is wrong.")
    if digest.hex() != expected_digest:
        _fail("SEALED_DIGEST_MISMATCH", "Bundle is not the expected seal.")
    entries = []
    for kind, path, size, sha in heads:
        data = raw[pos:pos + size] if kind == KIND_FILE else b""
        pos += size
        entries.append(SealedEntry(kind, path, size, sha, data))
    bundle = build_bundle(entries, limits)
    if tuple(entries) != bundle.entries:
        _fail("SEALED_BUNDLE_INVALID", "Entries are not in canonical order.")
    return bundle


def _require_private_dir(fd, *, expect_empty):
    st = os.fstat(fd)
    if (not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) & 0o077):
        _fail("SEALED_SCRATCH_NOT_EXCLUSIVE", "Scratch directory is not private to this user.")
    if expect_empty:
        with os.scandir(fd) as listing:
            if next(listing, None) is not None:
                _fail("SEALED_SCRATCH_REPLACED", "A newly created scratch directory was not empty.")
    return st


def materialize_bundle(bundle, expected_digest, parent_fd, _hook=None):
    """Write a verified bundle under a caller-held private scratch handle.

    Trust boundary, enforced where it can be checked and stated where it cannot:
    - `parent_fd` must be a directory owned by this effective user with no group or other
      access, so only this user can create, rename or replace entries beneath it.
    - The caller must guarantee that no other process running as this user can reach that
      directory for the whole operation (in the guest: materialize before any untrusted
      process starts). Linux has no mkdir that returns a handle, so a same-user actor
      could replace a new directory between mkdirat and openat2 with another empty 0700
      directory. These checks detect non-empty, foreign or non-private replacements and a
      final re-seal detects changed content, but they cannot prove the absence of such an
      actor. O_NOFOLLOW alone does not prevent a real-directory replacement.
    Returns an open handle to a new, randomly named directory. Only bytes that rebuild to
    `expected_digest` are written.
    """
    require_supported()
    verified = verify_bundle(bundle, expected_digest)
    _require_private_dir(parent_fd, expect_empty=False)
    name = "sealed-" + secrets.token_hex(16)
    dir_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    os.mkdir(name, 0o700, dir_fd=parent_fd)
    _hook_call(_hook, "after-mkdir", "")
    top = _openat2(parent_fd, name, dir_flags)
    handles = {}
    try:
        _require_private_dir(top, expect_empty=True)
        handles[""] = top
        for e in verified.entries:
            parent, _, leaf = e.path.rpartition("/")
            pfd = handles[parent]
            _hook_call(_hook, "before-create", e.path)
            if e.kind == KIND_DIR:
                os.mkdir(leaf, 0o700, dir_fd=pfd)
                _hook_call(_hook, "after-mkdir", e.path)
                handles[e.path] = _openat2(pfd, leaf, dir_flags)
                _require_private_dir(handles[e.path], expect_empty=True)
            else:
                fd = _openat2(pfd, leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
                try:
                    view = memoryview(e.data)
                    while view:
                        view = view[os.write(fd, view):]
                    os.fchmod(fd, 0o400)
                    os.fsync(fd)
                finally:
                    os.close(fd)
        if seal_fd(top).seal_digest != expected_digest:
            _fail("SEALED_SCRATCH_REPLACED", "Materialized tree does not re-seal to the expected digest.")
    except BaseException:
        for key, fd in handles.items():
            if key:
                os.close(fd)
        os.close(top)
        raise
    for key, fd in handles.items():
        if key:
            os.close(fd)
    return top


def main(argv):
    """CLI: `seal <root> <dev> <ino>` writes an encoded bundle to stdout."""
    try:
        if len(argv) == 4 and argv[0] == "seal":
            bundle = seal_tree(argv[1], int(argv[2]), int(argv[3]))
            sys.stdout.buffer.write(encode_bundle(bundle))
            return 0
        _fail("SEALED_USAGE", "usage: sealed_handoff.py seal <root> <dev> <ino>")
    except SealError as error:
        sys.stderr.write(error.code + "\n")
        return 2
    except ValueError:
        sys.stderr.write("SEALED_USAGE\n")
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
