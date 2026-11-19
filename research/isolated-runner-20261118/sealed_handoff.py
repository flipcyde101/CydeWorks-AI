"""Sealed project and artifact handoff (research, disconnected).

This module owns trusted directory handles. It walks an approved tree using only
handle-relative operations (openat with O_NOFOLLOW, fstatat without following
links, fstat on the opened handle) starting from one pinned root handle whose
(dev, ino) must equal the registered identity. The bytes it reads are sealed into
an in-memory, content-addressed bundle. Downstream consumers receive that bundle,
never a pathname, so replacing a parent directory, junction, symlink or file after
sealing cannot redirect what they use.

Scope and limits:
- Linux only. Every other platform fails closed with SEALED_HANDOFF_UNSUPPORTED.
- Native Linux filesystems (ext4, tmpfs) are what the synthetic tests exercise.
  Windows trees reached through WSL drvfs (9p) are NOT qualified; see
  sealed-handoff-design.md for the required qualification.
- Not connected to the browser, production approval/auth code or the live runner.
"""

from dataclasses import dataclass
import hashlib
import os
import stat
import struct
import sys

MAGIC = b"CWSEAL1\0"
KIND_DIR = 1
KIND_FILE = 2
DIGEST_LEN = 32

DEFAULT_LIMITS = {
    "max_entries": 4096,
    "max_total_bytes": 64 * 1024 * 1024,
    "max_file_bytes": 16 * 1024 * 1024,
    "max_depth": 32,
    "max_path_bytes": 1024,
}

_FORBIDDEN_NAME_CHARS = set('/\\:')


class SealError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _fail(code, message):
    raise SealError(code, message)


def require_supported(platform=None, supports_dir_fd=None):
    """Fail closed unless handle-relative, no-follow opens are really available."""
    platform = sys.platform if platform is None else platform
    if supports_dir_fd is None:
        supports_dir_fd = (os.open in os.supports_dir_fd and os.stat in os.supports_dir_fd
                           and os.mkdir in os.supports_dir_fd and os.scandir in os.supports_fd)
    needed = ("O_NOFOLLOW", "O_DIRECTORY", "O_CLOEXEC", "O_NONBLOCK", "O_NOCTTY")
    if platform != "linux" or not supports_dir_fd or not all(hasattr(os, name) for name in needed):
        _fail("SEALED_HANDOFF_UNSUPPORTED",
              "Sealed handoff requires Linux handle-relative no-follow opens; failing closed.")


def validate_component(name):
    if not isinstance(name, str) or name in ("", ".", ".."):
        _fail("SEALED_PATH_INVALID", "Entry name is empty or a relative reference.")
    if any(ch in _FORBIDDEN_NAME_CHARS or ord(ch) < 0x20 or ord(ch) == 0x7F for ch in name):
        _fail("SEALED_PATH_INVALID", "Entry name contains a separator, colon or control character.")
    try:
        encoded = name.encode("utf-8")
    except UnicodeEncodeError:
        _fail("SEALED_PATH_INVALID", "Entry name is not valid UTF-8.")
    if len(encoded) > 255:
        _fail("SEALED_PATH_INVALID", "Entry name is too long.")
    return encoded


def validate_rel_path(path, limits=None):
    limits = {**DEFAULT_LIMITS, **(limits or {})}
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
    ordered = tuple(sorted(entries, key=lambda e: e.path.encode("utf-8")))
    if len(ordered) > limits["max_entries"]:
        _fail("SEALED_LIMIT_EXCEEDED", "Too many entries.")
    _check_canonical_order(ordered, limits)
    total = 0
    for e in ordered:
        if e.kind == KIND_FILE:
            if len(e.data) != e.size or hashlib.sha256(e.data).digest() != e.sha256:
                _fail("SEALED_BUNDLE_INVALID", "File entry content does not match its digest.")
            total += e.size
        elif e.kind != KIND_DIR or e.data or e.size:
            _fail("SEALED_BUNDLE_INVALID", "Unsupported entry kind.")
    if total > limits["max_total_bytes"]:
        _fail("SEALED_LIMIT_EXCEEDED", "Too many bytes.")
    digest = hashlib.sha256(_manifest_bytes(ordered)).hexdigest()
    return SealedBundle(entries=ordered, seal_digest=digest, root_dev=root_dev, root_ino=root_ino)


def _hook_call(hook, event, rel):
    if hook is not None:
        hook(event, rel)


def _same_object(a, b):
    return a.st_dev == b.st_dev and a.st_ino == b.st_ino and stat.S_IFMT(a.st_mode) == stat.S_IFMT(b.st_mode)


def seal_tree(root_path, expected_dev, expected_ino, limits=None, _hook=None):
    """Seal the tree under one pinned root handle.

    The root pathname is resolved exactly once, by an O_DIRECTORY|O_NOFOLLOW open. The
    opened handle's (dev, ino) must equal the registered identity; an ancestor swapped
    before the open therefore yields a different object and fails. After that, every
    lookup is relative to a directory handle this function holds, so ancestors replaced
    later are not consulted again.
    """
    require_supported()
    limits = {**DEFAULT_LIMITS, **(limits or {})}
    dir_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
    file_flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK | os.O_NOCTTY
    try:
        root_fd = os.open(root_path, dir_flags)
    except OSError:
        _fail("SEALED_ROOT_UNAVAILABLE", "The approved root could not be opened as a link-free directory.")
    entries = []
    state = {"bytes": 0}
    try:
        root_st = os.fstat(root_fd)
        if root_st.st_dev != expected_dev or root_st.st_ino != expected_ino:
            _fail("SEALED_ROOT_IDENTITY_MISMATCH", "The opened root is not the registered directory.")
        _hook_call(_hook, "root-pinned", "")

        def walk(dir_fd, prefix, depth):
            if depth > limits["max_depth"]:
                _fail("SEALED_LIMIT_EXCEEDED", "Approved tree is too deep.")
            try:
                with os.scandir(dir_fd) as listing:
                    names = sorted(entry.name for entry in listing)
            except OSError:
                _fail("SEALED_ENTRY_UNREADABLE", "An approved directory could not be listed.")
            for name in names:
                validate_component(name)
                rel = f"{prefix}/{name}" if prefix else name
                validate_rel_path(rel, limits)
                if len(entries) + 1 > limits["max_entries"]:
                    _fail("SEALED_LIMIT_EXCEEDED", "Approved tree has too many entries.")
                try:
                    pre = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
                except OSError:
                    _fail("SEALED_ENTRY_CHANGED", "An approved entry disappeared during sealing.")
                if stat.S_ISLNK(pre.st_mode):
                    _fail("SEALED_LINK_REJECTED", "Approved trees cannot contain symbolic links or junctions.")
                if not (stat.S_ISDIR(pre.st_mode) or stat.S_ISREG(pre.st_mode)):
                    _fail("SEALED_ENTRY_UNSUPPORTED", "Approved trees may contain only directories and regular files.")
                _hook_call(_hook, "before-open", rel)
                is_dir = stat.S_ISDIR(pre.st_mode)
                try:
                    fd = os.open(name, dir_flags if is_dir else file_flags, dir_fd=dir_fd)
                except OSError:
                    # ELOOP (link swapped in), ENOTDIR or ENOENT: the entry changed under us.
                    _fail("SEALED_ENTRY_CHANGED", "An approved entry changed type during sealing.")
                try:
                    st = os.fstat(fd)
                    if not _same_object(pre, st):
                        _fail("SEALED_ENTRY_CHANGED", "An approved entry was replaced during sealing.")
                    if st.st_dev != root_st.st_dev:
                        _fail("SEALED_MOUNT_CROSSING", "Approved trees cannot cross a mount point.")
                    if is_dir:
                        entries.append(SealedEntry(KIND_DIR, rel))
                        walk(fd, rel, depth + 1)
                        continue
                    if st.st_nlink != 1:
                        _fail("SEALED_HARDLINK_REJECTED", "Approved files cannot have additional hard links.")
                    if st.st_size > limits["max_file_bytes"] or state["bytes"] + st.st_size > limits["max_total_bytes"]:
                        _fail("SEALED_LIMIT_EXCEEDED", "Approved tree exceeds its byte limit.")
                    chunks, total = [], 0
                    while True:
                        piece = os.read(fd, min(1 << 20, st.st_size + 1 - total) or 1)
                        if not piece:
                            break
                        chunks.append(piece)
                        total += len(piece)
                        if total > st.st_size:
                            break
                    _hook_call(_hook, "after-read", rel)
                    after = os.fstat(fd)
                    data = b"".join(chunks)
                    if (len(data) != st.st_size or after.st_size != st.st_size or
                            after.st_mtime_ns != st.st_mtime_ns or after.st_ctime_ns != st.st_ctime_ns):
                        _fail("SEALED_ENTRY_CHANGED", "An approved file changed while it was read.")
                    state["bytes"] += len(data)
                    entries.append(SealedEntry(KIND_FILE, rel, len(data), hashlib.sha256(data).digest(), data))
                finally:
                    os.close(fd)

        walk(root_fd, "", 1)
    finally:
        os.close(root_fd)
    return build_bundle(entries, limits, root_st.st_dev, root_st.st_ino)


def encode_bundle(bundle):
    content = b"".join(e.data for e in bundle.entries if e.kind == KIND_FILE)
    manifest = _manifest_bytes(bundle.entries)
    digest = hashlib.sha256(manifest).digest()
    if digest.hex() != bundle.seal_digest:
        _fail("SEALED_BUNDLE_INVALID", "Bundle digest does not match its manifest.")
    return manifest + content + digest


def decode_bundle(raw, expected_digest=None, limits=None):
    limits = {**DEFAULT_LIMITS, **(limits or {})}
    if not isinstance(raw, (bytes, bytearray)) or len(raw) < len(MAGIC) + 4 + DIGEST_LEN:
        _fail("SEALED_BUNDLE_INVALID", "Bundle is truncated.")
    raw = bytes(raw)
    if raw[:len(MAGIC)] != MAGIC:
        _fail("SEALED_BUNDLE_INVALID", "Bundle has an unknown format.")
    pos = len(MAGIC)
    (count,) = struct.unpack_from(">I", raw, pos)
    pos += 4
    if count > limits["max_entries"]:
        _fail("SEALED_LIMIT_EXCEEDED", "Too many entries.")
    heads = []
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
                if len(sha) != DIGEST_LEN or size > limits["max_file_bytes"]:
                    _fail("SEALED_BUNDLE_INVALID", "File entry header is malformed.")
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
    total = sum(h[2] for h in heads)
    if total > limits["max_total_bytes"]:
        _fail("SEALED_LIMIT_EXCEEDED", "Too many bytes.")
    if len(raw) != manifest_end + total + DIGEST_LEN or raw[-DIGEST_LEN:] != digest:
        _fail("SEALED_DIGEST_MISMATCH", "Bundle framing or seal digest is wrong.")
    if expected_digest is not None and digest.hex() != expected_digest:
        _fail("SEALED_DIGEST_MISMATCH", "Bundle is not the approved seal.")
    entries = []
    for kind, path, size, sha in heads:
        data = raw[pos:pos + size] if kind == KIND_FILE else b""
        pos += size
        entries.append(SealedEntry(kind, path, size, sha, data))
    bundle = build_bundle(entries, limits)
    if tuple(entries) != bundle.entries:
        _fail("SEALED_BUNDLE_INVALID", "Entries are not in canonical order.")
    return bundle


def materialize_bundle(bundle, parent_fd, name, _hook=None):
    """Create `name` under a caller-held directory handle and write the bundle into it.

    Every create is handle-relative with O_EXCL|O_NOFOLLOW, so a pathname swapped during
    materialization cannot redirect writes. Returns an open handle to the new directory.
    """
    require_supported()
    validate_component(name)
    dir_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    os.mkdir(name, 0o700, dir_fd=parent_fd)
    top = os.open(name, dir_flags, dir_fd=parent_fd)
    handles = {"": top}
    try:
        for e in bundle.entries:
            parent, _, leaf = e.path.rpartition("/")
            pfd = handles[parent]
            _hook_call(_hook, "before-create", e.path)
            if e.kind == KIND_DIR:
                os.mkdir(leaf, 0o700, dir_fd=pfd)
                handles[e.path] = os.open(leaf, dir_flags, dir_fd=pfd)
            else:
                fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                             0o400, dir_fd=pfd)
                try:
                    view = memoryview(e.data)
                    while view:
                        view = view[os.write(fd, view):]
                    os.fsync(fd)
                finally:
                    os.close(fd)
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
