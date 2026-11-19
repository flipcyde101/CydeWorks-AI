# Sealed project and artifact handoff

Date: 2026-11-19
Base: `0923289a8297185478d93aa7aaf8cfc1c15bc72b`
Status: research, disconnected. Linux reader VERIFIED on native Linux filesystems in a sandbox. Windows NEEDS QUALIFICATION. Browser connection stays held.

## 1. What the current code does (pinned commit, not edited here)

- `harness/workspace-projects.mjs` `canonicalDirectory` (line 90) and `lstatDirectoryChain` (line 67) resolve a pathname, `lstat` every component, call `realpathSync.native`, then `lstat` the chain again. Each call re-walks the pathname.
- `captureDirectoryIdentity` (line 261) walks with `readdirSync(path)`, `lstatSync(path)`, `realpathSync.native(path)` and `readPinnedFile` (line 228), which opens by pathname and compares `fstat` with the earlier `lstat`.
- `verifyContainedRootIdentity` (line 339) returns a canonical path string. `approval-audit.mjs` returns `sealedHandoff:false` from `beginDispatch` (line 1405) and `consumeActionGrant` (line 1848). Its comment at line 435 records the open limitation.
- Downstream, `sandbox.py` `command()` passes host paths to `bwrap --ro-bind <path> /input/<name>`, and `pilot.mjs` `checkFiles('fixture-repo')` passes a directory name. Both re-resolve pathnames at use time.

Why it is still racy: `lstat` does not follow the final component but does follow every ancestor. An attacker who can rename inside the project can swap an ancestor for a junction before the child `lstat`, swap it back before `realpath`, then swap it again before `open`. The `fstat` then matches the redirected `lstat`, so the outside file is accepted. More checks or file hashes only move the window, because every check and the use resolve the pathname independently. Node on Windows exposes no `O_NOFOLLOW`, no `O_DIRECTORY` and no handle-relative open (`fs.constants` on this host has only `UV_FS_O_FILEMAP`), so Node cannot fix this itself.

## 2. Threat model

- Attacker: code or content that can create, rename or delete entries inside the project root (an agent with project write access, a checked-out repository with links, a concurrent tool). It cannot write outside the project root. A same-user unsandboxed process that can write anywhere is out of scope because it can read secrets directly.
- Goal to prevent: the trusted side reading or delivering bytes from outside the approved root, or delivering bytes other than the approved ones, by replacing a parent directory, junction, symlink or file between verification and use.

## 3. Design

The fix is to stop handing pathnames downstream. Verification and use become the same operation on the same objects, after which only immutable bytes move.

### 3.1 Handle owner: the sealing reader

One component owns trusted handles: `sealed_handoff.py` `seal_tree(root, expected_dev, expected_ino)`.

1. Open the root once with `O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC`. This is the only pathname resolution.
2. `fstat` that handle. Its `(dev, ino)` must equal the registered root identity. An ancestor swapped before the open yields a different object and fails with `SEALED_ROOT_IDENTITY_MISMATCH`. The check binds the handle actually used, so it is not a repeated pathname check.
3. List with `scandir(dir_fd)`. For each name, `fstatat(dir_fd, name, AT_SYMLINK_NOFOLLOW)` as a pre-filter, then `openat(dir_fd, name, O_NOFOLLOW|O_NONBLOCK|O_NOCTTY|O_CLOEXEC [|O_DIRECTORY])`, then `fstat` the new handle. Reject links (`ELOOP`), anything other than directories and regular files, identity or type changes between `fstatat` and `fstat`, a different `st_dev` (mount crossing), and `st_nlink != 1`.
4. Directories recurse on the handle just opened. Ancestors are never consulted again.
5. Read files through the handle with bounds. `fstat` again after the read. Size, mtime or ctime changes fail with `SEALED_ENTRY_CHANGED`.
6. Build a canonical `CWSEAL1` bundle: sorted entries, per-file SHA-256 and a `sealDigest` over the manifest. The result is in memory and immutable.

Property: every sealed byte came from an object reached from the pinned root handle through link-free, same-device components at the moment it was opened. A parent swap after the pin cannot redirect reads (test `test_parent_swap_after_pin_cannot_redirect_reads`). The negative control (`test_negative_control_pathname_reader_is_redirected`) shows the same swap redirects a pathname reader.

### 3.2 Controller: binds bytes, not paths

- `sealed-handoff.mjs` `decodeSealedBundle(raw, {expectedSealDigest})` independently re-verifies framing, order, path safety, case collisions, limits, per-file digests and the seal digest. It copies the input and returns an opaque frozen handle backed by a module-private `WeakMap`.
- Approval records `sealDigest` and the root identity. At dispatch, the controller uses the bytes sealed at approval time. It keeps them in memory or in a controller-private store keyed by `sealDigest` and re-verifies them on load. The project is not re-read. This is a digest check of bytes the controller holds, not a re-resolution of a path.
- `hostVerifiers.resolveTargetDigest` in `approval-audit.mjs` should return the `sealDigest` of the bundle being consumed. `sealedHandoff` may become `true` only when the result carries a verified bundle handle instead of `approvedRoots` path strings.

### 3.3 What downstream consumers must accept

- Only a verified sealed bundle. `requireSealedBundle` refuses strings, `URL`s and look-alike objects. A consumer API must not take a project path, root path or artifact path.
- Runner input: `sealedConsumerInput(bundle)` gives the exact verified byte stream. The guest receives it on stdin, decodes it with `decode_bundle(raw, expected_digest)`, and writes it into its private tmpfs with `materialize_bundle(bundle, parent_fd, name)`. That function uses only handle-relative `mkdirat` and `openat(O_CREAT|O_EXCL|O_NOFOLLOW)` (test `test_materialize_writes_only_through_held_handles`). This replaces `--ro-bind <host path> /input/<name>` in `sandbox.py`, so `/mnt` stays absent from the worker.
- Protected checks, diff review and patch binding (matrix CHK and PAT cases) compare against sealed bytes and the candidate's returned bytes. They never compare against a re-read of the project tree.
- Artifact download or export serves the sealed bytes.

### 3.4 Atomicity

- Per object: each open is atomic with respect to the handle it is relative to. Each file read is bracketed by `fstat` on the same handle.
- Whole tree: this is not a filesystem-level point-in-time snapshot. Concurrent edits inside the root can produce a set of files that never coexisted, or a walk can fail closed. Every byte is still in-root and bound to `sealDigest`, and the owner approves exactly that digest. If point-in-time consistency is required later, use a filesystem snapshot (VSS on Windows) as a source for the same reader. That is optional and not proposed now.
- Handoff: after sealing, the only shared state is immutable bytes. No later filesystem change can alter what consumers receive.

### 3.5 Windows and WSL

Node on Windows cannot be the handle owner. There are two candidate owners, both built on standard platform facilities.

- A (preferred, partly built): run `sealed_handoff.py` in the existing Ubuntu WSL 2 distribution against the project through drvfs (`/mnt/c`, 9p). Linux handle semantics are fully exercised here. Whether the Windows-side 9p server keeps each walked directory pinned by handle, rather than re-resolving full Windows paths per request, is unproven. That is the core qualification below. Defense in depth: run the reader in a private mount namespace with only the project root bind-mounted, so an escaping link resolves into an empty namespace. Verify the bound root's identity on the handle as in 3.1.
- B (fallback): a Windows-native reader that uses `NtCreateFile` with `OBJECT_ATTRIBUTES.RootDirectory` (handle-relative), `FILE_OPEN_REPARSE_POINT`, `FILE_FLAG_BACKUP_SEMANTICS` and `GetFileInformationByHandleEx(FileIdInfo, FileAttributeTagInfo)`. It would hold directory handles without `FILE_SHARE_DELETE` so walked directories cannot be renamed during the seal. No reviewed component in this repository exposes these calls. Node does not expose them. Building one is new code that needs its own review, so it is not implemented here.

### 3.6 Unsupported platforms

`require_supported()` raises `SEALED_HANDOFF_UNSUPPORTED` on anything other than Linux with `dir_fd` support and `O_NOFOLLOW`, `O_DIRECTORY`, `O_CLOEXEC`, `O_NONBLOCK` and `O_NOCTTY`. `planSealedReader()` returns a reader only for `linux`. It throws `SEALED_HANDOFF_UNQUALIFIED` for `win32`, even if a qualification object is passed, and `SEALED_HANDOFF_UNSUPPORTED` for every other platform. There is no pathname fallback.

## 4. Remaining real Windows qualification (option A)

Run each case on the real Windows host, against a disposable synthetic tree in an owner-approved scratch location, with the reader in the offline sandbox. Each case passes only if the reader either returns in-root bytes or fails closed, and never returns outside bytes.

| ID | Must prove |
| --- | --- |
| WQ-01 | A directory handle held by the WSL reader keeps reading the original directory after Windows renames it and puts an NTFS junction (`mklink /J`) at its name. Use a hook at `before-open`, as in the Linux test. |
| WQ-02 | Same as WQ-01 with directory and file symbolic links. If creating symlinks needs privileges that are unavailable, record UNRESOLVED. Do not change settings to enable them. |
| WQ-03 | drvfs reports junctions, symlinks, mount-point reparse points, AppExecLink, cloud placeholders (OneDrive, Files On-Demand) and other reparse tags as `S_ISLNK` or as an unsupported type, so they are rejected. Reading a placeholder must never trigger hydration or network access. |
| WQ-04 | `st_dev`/`st_ino` on drvfs are stable and unique per NTFS file ID during a walk, and `fstatat` matches `fstat` on the same object. Also define and test how the registered root identity (Node `lstat` on Windows: volume serial and file index) maps to the drvfs `(dev, ino)`. Without a proven mapping, approval must re-register the root identity from the WSL view. |
| WQ-05 | `st_nlink` is accurate on drvfs, so NTFS hard links are rejected. |
| WQ-06 | With the mount's `cache=0x5`, the `fstat` after a read reflects concurrent Windows-side writes, so torn reads are detected. Otherwise the reader must use an uncached mount or treat change detection as unavailable and fail closed. |
| WQ-07 | Per-directory case sensitivity on Windows cannot make two entries collapse, and case collisions are rejected. |
| WQ-08 | Alternate data streams are never included or followed. |
| WQ-09 | If the reader is launched from Windows and Stop is requested, it is fully terminated before the controller decides anything (shared with matrix STP-01). |
| WQ-10 | End to end: seal on Windows through WSL, approve the digest, deliver over stdin to the sandboxed guest, materialize, and confirm that the guest's re-seal digest equals the approved digest while an adversarial swapper runs during sealing. |

If WQ-01 to WQ-06 cannot all pass, option A is rejected for Windows and option B needs its own design review. Until then, Windows stays `SEALED_HANDOFF_UNQUALIFIED`.

## 5. Blockers and limits

- Windows qualification (section 4) has not run. Browser connection must stay held.
- Write-back to the project (applying an approved patch) is a separate handoff in the other direction. It needs the same handle-relative treatment under a pinned project root, and Windows has no qualified owner for it yet. It is out of scope here.
- `approval-audit.mjs` and `workspace-projects.mjs` are unchanged while their pinned commit is under independent review. Wiring `sealDigest` into `resolveTargetDigest`, and replacing `approvedRoots` paths in dispatch results, waits for that review.
- The Node and Python case-fold rules differ slightly (`toLowerCase` vs `casefold`). Both only reject, and the guest-side Python check is authoritative before materialization.
- `O_NONBLOCK` opens avoid blocking on FIFOs. Device nodes are pre-filtered by `fstatat`. Planting them requires privileges outside the threat model.

## 6. Files and verification

- `sealed_handoff.py`: handle-owning reader, codec, handle-relative materializer, CLI `seal`.
- `sealed-handoff.mjs`: controller verifier, consumer contract and platform gate.
- `test_sealed_handoff.py` (19 tests) and `sealed-handoff.test.mjs` (8 tests). The golden vector `sealed-handoff-vector.json` is shared by both languages.
- `sealed-handoff-sandbox.sh` runs the Python tests as `nobody` in private user, net, mount and pid namespaces. The source is a read-only bind, scratch is tmpfs, host drives are hidden, and `prlimit` and `timeout` limits apply. A probe aborts if any write, network or mount boundary is missing.
- The Node tests ran in an existing local Node 22 image with `--network none --read-only --cap-drop ALL --security-opt no-new-privileges`, a tmpfs scratch, memory/pid/cpu limits and a read-only source mount, after the same kind of probe.
