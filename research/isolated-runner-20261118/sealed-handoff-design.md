# Sealed project and artifact handoff

Date: 2026-11-19
Base: `0923289a8297185478d93aa7aaf8cfc1c15bc72b`
Status: research, disconnected. The Linux reader and materializer pass their synthetic tests in a verified offline sandbox on native Linux filesystems. This is NOT qualification for the browser or Windows. Windows: NEEDS QUALIFICATION. Browser connection: HELD. Independent review is still in progress and may add findings.

## 1. What the current code does (pinned commit, not edited here)

- `harness/workspace-projects.mjs`: `canonicalDirectory` (line 90) and `lstatDirectoryChain` (line 67) resolve a pathname, `lstat` every component, call `realpathSync.native`, then `lstat` the chain again. Each call walks the pathname again.
- `captureDirectoryIdentity` (line 261) walks with `readdirSync(path)`, `lstatSync(path)` and `realpathSync.native(path)`. It reads through `readPinnedFile` (line 228), which opens by pathname and compares `fstat` with the earlier `lstat`.
- `verifyContainedRootIdentity` (line 339) returns a canonical path string. `approval-audit.mjs` returns `sealedHandoff:false` from `beginDispatch` (line 1405) and `consumeActionGrant` (line 1848). Its comment at line 435 records the open limitation.
- Downstream, `sandbox.py` `command()` passes host paths to `bwrap --ro-bind <path> /input/<name>`, and `pilot.mjs` `checkFiles('fixture-repo')` passes a directory name. Both look the pathname up again at use time.

Why it is still racy: `lstat` does not follow the final component, but it does follow every ancestor. An attacker who can rename entries inside the project can do this:

1. Swap an ancestor for a junction before the child `lstat`.
2. Swap it back before `realpath`.
3. Swap it again before `open`.

The `fstat` then matches the redirected `lstat`, so the outside file is accepted. More checks or file hashes only move the window, because every check and the use resolve the pathname independently.

Node on Windows exposes no `O_NOFOLLOW`, no `O_DIRECTORY` and no handle-relative open. `fs.constants` on this host has only `UV_FS_O_FILEMAP`.

## 2. Threat model

- **Attacker:** code or content that can create, rename or delete entries inside the project root. Examples: an agent with project write access, a checked-out repository containing links, or a concurrent tool. The attacker cannot write outside the project root. A same-user unsandboxed process that can write anywhere is out of scope, because it can read secrets directly.
- **Goal to prevent:** the trusted side reading bytes from outside the root, or delivering bytes other than the expected ones, by replacing a parent directory, junction, symlink, bind mount or file between verification and use.

## 3. Design

Stop handing pathnames downstream. Verification and use become the same operation on the same objects, and after that only immutable bytes move.

### 3.1 Handle owner: the sealing reader

`sealed_handoff.py` `seal_tree(root, expected_dev, expected_ino)` is the one component that owns trusted handles.

1. Open the root once with `O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC`. This is the only pathname resolution.
2. `fstat` that handle. Its `(dev, ino)` must equal the expected root identity. An ancestor swapped before the open yields a different object and fails with `SEALED_ROOT_IDENTITY_MISMATCH`. The check binds the handle that is actually used.
   - The expected identity is caller supplied today. A trusted host must supply it independently; this module does not establish root identity on its own.
3. Each child is opened with Linux `openat2(dir_fd, name, how)` and `RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV`. The call is made through stdlib `ctypes`, syscall 437 on x86_64 and aarch64.
   - `RESOLVE_NO_XDEV` makes the kernel refuse any mount crossing, including same-filesystem bind mounts that keep the same `st_dev`.
   - The earlier `st_dev` comparison is kept only as a secondary check. It is not the mount boundary.
   - The sandbox shows the difference directly: a bind mount in the same tmpfs reports the same `st_dev`, and `openat2` returns `EXDEV` (tests `test_same_filesystem_bind_mount_rejected` and `test_bind_mount_swapped_in_after_pin_rejected`).
4. A `fstatat(dir_fd, name, AT_SYMLINK_NOFOLLOW)` pre-filter runs before each open, and `fstat` runs on the new handle. The walk rejects:
   - links
   - anything other than directories and regular files
   - identity or type changes between the two stats
   - `st_nlink != 1`
5. Listing is bounded. Directory names are counted while they are iterated, and the walk fails at `max_entries` before anything is collected or sorted. Byte, depth and path limits are also enforced before reading.
6. Files are read through the handle, then `fstat` runs again. A change in size, mtime or ctime fails with `SEALED_ENTRY_CHANGED`.
7. The output is a canonical `CWSEAL1` bundle: sorted entries, per-file SHA-256 and a `sealDigest` over the manifest. `build_bundle` copies all entry data into immutable `bytes` before hashing and keeps only those copies.

Fail-closed fallback: if `openat2` is missing, blocked by seccomp, or unsupported on the architecture, `require_supported` raises `SEALED_HANDOFF_UNSUPPORTED`. There is no fallback to `openat` without `RESOLVE_NO_XDEV`.

Property: every sealed byte came from an object reached from the pinned root handle through link-free components with no mount crossing, at the moment it was opened. A parent swap after the pin cannot redirect reads (`test_parent_swap_after_pin_cannot_redirect_reads`). The negative control (`test_negative_control_pathname_reader_is_redirected`) shows the same swap does redirect a pathname reader.

### 3.2 What the seal digest is and is not

- It is **byte integrity**: an exact, canonical description of the bundle's paths and contents.
- It is **not** owner approval, host attestation, root identity or replay protection.
- Every expected digest in this prototype (`decode_bundle`, `verify_bundle`, `materialize_bundle`, `decodeSealedBundle`) is caller supplied. Nothing here may claim authorization or provenance until a trusted host independently supplies the expected digest, the root identity and the replay scope.
- Intended later binding, pending review of the approval files:
  - The approval store records `sealDigest` next to the grant.
  - `hostVerifiers.resolveTargetDigest` returns it.
  - Dispatch uses the controller-held sealed bytes rather than re-reading the project.
  - `sealedHandoff` may become `true` only when the result carries a verified bundle handle instead of `approvedRoots` path strings.
  - None of that wiring exists yet.

### 3.3 Controller and consumer contract

`sealed-handoff.mjs` `decodeSealedBundle(raw, {expectedSealDigest})`:

1. Accepts only a genuine `Uint8Array` (including `Buffer`) over a non-shared, non-detached `ArrayBuffer`. It identifies the input by its internal typed-array slot, through the intrinsic `%TypedArray%.prototype[@@toStringTag]` getter. Proxies, look-alike objects, other typed arrays, `DataView`s and `SharedArrayBuffer` backing are rejected.
2. Reads the backing store, offset and byte length only through intrinsic getters captured at module load. It never reads caller-visible `buffer`, `byteOffset`, `byteLength`, `length`, `slice` or `subarray`, which a caller can shadow. For example, a shadowed `buffer` whose `slice` returns the caller's own backing store previously made the "copy" alias caller memory.
3. Checks the intrinsic byte length against `maxFrameBytes(limits)` before copying anything.
4. Copies the bytes into a fresh, unpooled `ArrayBuffer` that only this module references. `readSealedFile` and `sealedConsumerInput` return fresh unpooled copies the same way.
5. Re-verifies framing, canonical order, path safety, case collisions, limits, per-file digests and the seal digest.
6. Returns an opaque frozen handle backed by a module-private `WeakMap`.

Code that rewrites built-in prototypes before this module loads is outside its trust boundary.

UTF-8 is decoded with `ignoreBOM: true`, so a leading U+FEFF is preserved rather than silently stripped. Both languages then reject U+FEFF in any path component. The cross-language vectors include a non-ASCII case.

Consumers accept only that handle (`requireSealedBundle`) or its exact bytes (`sealedConsumerInput`). Strings, `URL`s and look-alike objects are refused. A consumer API must not take a project, root or artifact path.

Runner input:
- The guest receives the bytes on stdin.
- `decode_bundle(raw, expected_digest)` verifies them.
- `materialize_bundle(bundle, expected_digest, parent_fd)` writes them (section 3.4).
- This replaces `--ro-bind <host path> /input/<name>` in `sandbox.py`.

Protected checks, diff review and patch binding compare sealed bytes with the candidate's returned bytes. They never re-read the project tree.

### 3.4 Materializer trust boundary

Linux has no `mkdir` that returns a handle. Between `mkdirat` and `openat2`, an actor that can modify the parent directory can replace the new directory with a different real directory. `O_NOFOLLOW` and `RESOLVE_NO_SYMLINKS` do not prevent that, because the replacement is not a link.

**Enforced**
- The bundle is rebuilt from its entries with data copied, and must equal an expected digest. A forged digest, forged data, or a mutable buffer changed after hashing fails before anything is created.
- `parent_fd` must be a directory owned by the effective user with no group or other access (`SEALED_SCRATCH_NOT_EXCLUSIVE` otherwise). Only processes running as that user can then modify it.
- The new top directory has a random 128-bit name.
- Every created directory is opened with `openat2` and must be private, owned by the effective user, and empty (`SEALED_SCRATCH_REPLACED` otherwise).
- Files are created with `O_CREAT|O_EXCL` through `openat2`.
- After writing, the materialized tree is sealed again from the held top handle and must equal the expected digest.

**Not provable here**
- No other process running as the same user can reach `parent_fd` during the operation.
- A same-user actor can still swap in a fresh, empty, private directory in the window and later read or change what is written there.
- The checks catch populated, foreign-owned or non-private replacements and content drift, but not that case.

**Required of the caller**: run the materializer in the guest before any untrusted process starts, in a private tmpfs that only the guest controller's user can reach. Until that ordering is enforced and reviewed in the runner, materialization is not a qualified boundary.

### 3.5 Atomicity

- **Per object:** each open is atomic with respect to the held handle it is relative to. Each read is bracketed by `fstat` on the same handle.
- **Whole tree:** this is NOT a filesystem-level point-in-time snapshot. Concurrent edits inside the root can make sealing fail, or produce a set of files that never coexisted. Every byte is still from inside the root and matches `sealDigest`.
- **Point-in-time consistency** would need a filesystem snapshot as the source. That is not proposed.
- **After sealing:** only immutable bytes move. No later filesystem change alters what consumers receive.

### 3.6 Windows and WSL

Node on Windows cannot be the handle owner.

- **Option A (preferred, partly built):** run `sealed_handoff.py` in the existing Ubuntu WSL 2 distribution against the project through drvfs (`/mnt/c`, 9p).
  - It is unproven whether the Windows-side 9p server pins each walked directory by handle, and whether `openat2` resolve flags behave as on native Linux. That is the core qualification.
  - Defense in depth: run the reader in a private mount namespace with only the project root bind-mounted.
- **Option B (fallback, not built):** a Windows-native reader using:
  - `NtCreateFile` with `OBJECT_ATTRIBUTES.RootDirectory`, `FILE_OPEN_REPARSE_POINT` and `FILE_FLAG_BACKUP_SEMANTICS`
  - `GetFileInformationByHandleEx(FileIdInfo, FileAttributeTagInfo)`
  - directory handles held without `FILE_SHARE_DELETE`

  No reviewed component in this repository exposes these calls, and building one needs its own review.

### 3.7 Unsupported platforms

- `require_supported()` fails closed with `SEALED_HANDOFF_UNSUPPORTED` unless all of these hold:
  - the platform is Linux on x86_64 or aarch64
  - `dir_fd` support and the needed `O_*` flags are present
  - a live `openat2` probe succeeds
- `planSealedReader()` returns a reader only for `linux`. It throws `SEALED_HANDOFF_UNQUALIFIED` for `win32`, even if a qualification object is passed, and `SEALED_HANDOFF_UNSUPPORTED` for every other platform.

## 4. Remaining real Windows qualification (option A)

Run each case on the real Windows host, against a disposable synthetic tree in an owner-approved scratch location, with the reader in the offline sandbox. A case passes only if the reader returns in-root bytes or fails closed, and never returns outside bytes.

| ID | Must prove |
| --- | --- |
| WQ-01 | A directory handle held by the WSL reader keeps reading the original directory after Windows renames it and puts an NTFS junction at its name. |
| WQ-02 | Same as WQ-01 with directory and file symbolic links. If creating symlinks needs privileges that are unavailable, record UNRESOLVED. Do not change settings to enable them. |
| WQ-03 | drvfs reports junctions, symlinks, mount-point reparse points, AppExecLink, cloud placeholders and other reparse tags as links or unsupported types, so they are rejected. Reading never triggers hydration or network access. |
| WQ-04 | `openat2` with `RESOLVE_NO_XDEV`, `RESOLVE_NO_SYMLINKS` and `RESOLVE_BENEATH` works on drvfs, and a Windows mount point or a volume reached through a junction is refused. |
| WQ-05 | `st_dev`/`st_ino` on drvfs are stable and unique per NTFS file ID, and `fstatat` matches `fstat`. Also define how the registered Windows root identity maps to the drvfs `(dev, ino)`. Without a proven mapping, the trusted host must re-register the root identity from the WSL view. |
| WQ-06 | `st_nlink` is accurate on drvfs, so NTFS hard links are rejected. |
| WQ-07 | With the mount's `cache=0x5`, the `fstat` after a read reflects concurrent Windows-side writes. Otherwise change detection is treated as unavailable and fails closed. |
| WQ-08 | Per-directory case sensitivity cannot make entries collapse, and alternate data streams are never included or followed. |
| WQ-09 | If the reader is launched from Windows and Stop is requested, it is fully terminated before the controller decides anything (shared with matrix STP-01). |
| WQ-10 | End to end: seal through WSL, deliver over stdin to the sandboxed guest, materialize before any untrusted process starts, and confirm that the guest's re-seal digest equals the expected digest while an adversarial swapper runs during sealing. |

If WQ-01 to WQ-07 cannot all pass, option A is rejected for Windows and option B needs its own design review. Until then, Windows stays `SEALED_HANDOFF_UNQUALIFIED`.

## 5. Open limitations

- Windows qualification (section 4) has not run. The browser connection stays held.
- The materializer's same-user exclusivity is a caller obligation that is not yet enforced by the runner (section 3.4).
- The digest is integrity only. Approval, provenance, root identity and replay binding need a trusted host and the reviewed approval store (section 3.2).
- Not a point-in-time snapshot (section 3.5).
- Write-back to the project (applying a patch) needs the same handle-relative treatment in the other direction and has no owner yet.
- `approval-audit.mjs` and `workspace-projects.mjs` are unchanged while their pinned commit is under independent review.
- Case-fold rules differ slightly between Node (`toLowerCase`) and Python (`casefold`). Both only reject, and the guest-side Python check runs before materialization.
- `openat2` is reached through `ctypes` with a fixed syscall number for x86_64 and aarch64. Other architectures are refused.
- The bind-mount and tmpfs-mount regressions need a private mount namespace. They ran in this sandbox. Elsewhere they skip with an `UNVERIFIED` reason and do not count as evidence.

## 6. Files and verification

- `sealed_handoff.py`: handle-owning reader, codec, materializer and CLI `seal`.
- `sealed-handoff.mjs`: controller verifier, consumer contract and platform gate.
- `test_sealed_handoff.py` (31 tests) and `sealed-handoff.test.mjs` (15 tests).
- `sealed-handoff-vector.json`: ASCII and non-ASCII vectors, generated in the sandbox and checked by both languages.
- `sealed-handoff-sandbox.sh`: runs the Python tests as `nobody` in private user, net, mount and pid namespaces. The source is a read-only bind, scratch is tmpfs, host drives are hidden, and `prlimit` and `timeout` limits apply. A probe aborts the run if any write, network or mount boundary is missing.
- The Node tests run in an already-present local Node 22 image with `--network none --read-only --cap-drop ALL --security-opt no-new-privileges`, tmpfs scratch, memory, pid and CPU limits and a read-only source mount, after a similar probe.
