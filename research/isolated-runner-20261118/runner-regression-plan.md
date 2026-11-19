# Isolated runner regression plan

Date: 2026-11-18  
Scope owner: `work/t3-runner-regressions`  
Owned artifact: this file only  
Pilot source: `research/isolated-runner-20261118/`  
Roadmap gates: `docs/ROADMAP.md` next gates 1 through 3

This plan turns the November 18 pilot and roadmap findings into a concrete pass or fail matrix. Every case uses benign inert fixtures only: synthetic `limits.py` and `measurement.py`, a disposable `host-marker.txt`, local sleep or echo workers, and recorded JSON claim or result stubs. No live inference, no external targets, no real repositories, and no credential access.

Passing the existing unit suite (`node --test research/isolated-runner-20261118/pilot.test.mjs`) proves proposal and boundary helper contracts only. It does not satisfy this matrix.

## Fixture inventory (inert only)

| Fixture | Purpose | Allowed contents |
| --- | --- | --- |
| `fixtures/limits.py` and `fixtures/measurement.py` | Baseline two-file synthetic repo | Pure functions; no I/O, network, or subprocess |
| Disposable `fixture-repo/` copy | Synthetic Git baseline for patch binding | Exact copies of the two fixtures; never a real project |
| `host-marker.txt` | Outside-marker preservation probe | Fresh non-sensitive bytes created for the run |
| Linger sleep child | Process-tree Stop and ownership probes | `python -c "import time; time.sleep(N)"` or equivalent echo loop |
| Claim and result JSON stubs | Durable record and replay proofs | Synthetic UUIDs, digests, dispositions; no secrets |
| Protected case vector | Check integrity and case binding | The twelve clamp or normalize cases already defined in `pilot.mjs` |
| Fake check-result injector | Verifier integrity adversarial case | Candidate that prints a forged `{"value": ...}` on stdout |

All worker directories stay under the pilot folder. Destroy them after each case. Keep uncertain outcomes unresolved; do not coerce them to pass or fail.

## Shared verdict rules

- **PASS**: Observed evidence matches the pass criteria, including negative controls where required.
- **FAIL**: Any required assertion fails, a duplicate side effect appears, or a protected invariant is broken.
- **UNRESOLVED**: Process state, ownership, or outcome cannot be confirmed within the case deadline. Record the last known facts and stop. Do not retry into a live or paid path.

A case that depends on Windows-initiated Stop against a WSL or namespace tree must prove the actual descendant PIDs exited. The current Linux-side `stop_probe()` in `sandbox.py` is necessary but not sufficient for Windows Stop evidence.

## Matrix

### 1. Known ownership

Goal: Only one controller owns a given worker identity. Stale or foreign controllers cannot Stop, inspect as owner, or collect as owner.

| ID | Case | Setup (inert) | Action | PASS | FAIL |
| --- | --- | --- | --- | --- | --- |
| OWN-01 | Fresh claim binds one owner | Write `claim-<id>.json` with `disposition: claimed`, unique `id`, synthetic `scopeHash` | Start a linger worker; record `workerId`, controller token, and claim id | Inspect returns the same `workerId` and owner token; second controller without the token is denied | Second controller can Stop or collect; claim mutates without owner proof |
| OWN-02 | Exclusive writer lease | One linger worker; two synthetic observer clients | Client A takes ownership; Client B attempts Take or Stop | A remains sole owner; B receives explicit denial; worker stays running | B becomes owner, or worker exits from B's request |
| OWN-03 | Foreign workerId rejected | Record real `workerId-A`; mint unused `workerId-B` | Call Stop or collect with `workerId-B` | Operation rejected; worker A still alive; no durable outcome written for B | Worker A stops, or a durable record is written for B |
| OWN-04 | Ownership survives read-only observe | Owner A; observer B with read cursor only | B reads events; A still owns | Event replay works for B; ownership generation unchanged; only A may Stop | Observe path upgrades B to owner, or clears A's lease |

Proof method: spawn the linger fixture under the pilot sandbox or an equivalent disposable local child. Compare PID tree and claim JSON before and after. No model call.

### 2. Stale Stop

Goal: Stop is idempotent for the true owner after exit, rejects stale generations, and leaves uncertain trees unresolved.

| ID | Case | Setup (inert) | Action | PASS | FAIL |
| --- | --- | --- | --- | --- | --- |
| STP-01 | Windows-initiated Stop ends descendants | Linger worker with at least two observed descendants (parent plus sleep child) | Issue Stop from the Windows controller that owns the worker | Every recorded descendant PID is confirmed exited; durable outcome is `stopped` with worker identity | Only the wrapper exits while children remain; or Linux-only probe is treated as Windows proof |
| STP-02 | Repeated Stop after confirmed exit | Complete STP-01 | Issue Stop again with the same owner token and `workerId` | Second Stop returns already-exited or equivalent; no new kill storm; durable record unchanged except an audit note | Second Stop creates a new worker, rewrites outcome to running, or crashes the controller |
| STP-03 | Stale ownership generation | Owner takes lease generation `g1`, then releases or is superseded to `g2` | Replay Stop signed with `g1` | Rejected as stale; worker under `g2` unaffected if still running | Stale Stop kills the current worker |
| STP-04 | Stop after unknown tree state | Kill the controller process mid-run so child liveness is unclear | On restart, call Stop or inspect | Result is `unresolved` until a fresh inspect proves exit or running; no silent success | Controller reports stopped without PID evidence |
| STP-05 | Stop against already-collected worker | Worker exited and `collect` completed | Stop again | Harmless already-final response; no second collect artifacts | Duplicate result files or altered patch hashes |

Proof method: record descendant PIDs before Stop; poll `/proc` inside the guest or Windows process listing for the disposable tree only. Prefer the Windows controller path named in `docs/ROADMAP.md` gate 1. Keep STP-01 UNRESOLVED if only the Linux `process.kill()` probe ran.

### 3. Restart

Goal: Controller or service restart recovers worker identity without duplicate execution.

| ID | Case | Setup (inert) | Action | PASS | FAIL |
| --- | --- | --- | --- | --- | --- |
| RST-01 | Controller crash while worker running | Claim written; linger worker running; last event sequence `n` persisted | Kill controller; restart; inspect by `workerId` | Same worker identity and sequence cursor resume; no second spawn | New worker starts for the same claim |
| RST-02 | Controller crash after worker exit, before collect | Worker exited; result not yet collected | Restart; collect | Single durable result; claim disposition moves to collected once | Collect runs twice or claim stays claimed while artifacts duplicate |
| RST-03 | Crash between claim and dispatch | Write claim with `disposition: claimed` and no `workerId` | Restart; attempt recover | Status is recoverable pre-dispatch hold; dispatch requires explicit continue; zero workers spawned automatically | Automatic dispatch on restart |
| RST-04 | Host interrupted mid-check | Start protected check on fixture candidate; interrupt controller | Restart; inspect check state | Check marked unresolved or failed-closed; no forged pass; base fixture-repo unchanged | Check recorded as passed without verifier output |

Proof method: use claim JSON and a local linger or check fixture. Restart only the disposable controller process under test. Do not touch the live preview service.

### 4. Replay

Goal: Replaying the same request identity does not duplicate execution or charges; observers can replay events safely.

| ID | Case | Setup (inert) | Action | PASS | FAIL |
| --- | --- | --- | --- | --- | --- |
| RPL-01 | Identical requestId reopens attempt | Completed claim with `requestId`, `scopeHash`, synthetic usage snapshot | Resubmit the exact same request envelope | Returns the existing attempt and evidence; worker count stays 1 | Second worker or second inference reservation |
| RPL-02 | Changed scope requires new grant | Same `requestId` but altered `fileDigests` or instruction text | Submit | Rejected or requires new grant; original evidence intact | Silently binds new scope to old attempt |
| RPL-03 | Event cursor replay | Worker emitted sequences 1..n | Observer opens `afterSequence: k` | Receives only `k+1..n` in order; no mutation | Events rewrite, reorder, or drop required fields (`attemptId`, `sequence`, `type`) |
| RPL-04 | Replay after Stop | Stopped worker with final events flushed | Replay from 0 | Full history available or explicitly unavailable; outcome remains stopped | Replay restarts the worker |

Proof method: stub request envelopes and event logs on disk. Count spawn and claim files. No broker or model process.

### 5. Timeout

Goal: Deadlines kill the owned tree, record a typed timeout, and never promote partial work to verified.

| ID | Case | Setup (inert) | Action | PASS | FAIL |
| --- | --- | --- | --- | --- | --- |
| TMO-01 | Generate wall-clock timeout | Linger or slow echo fixture under generate deadline (pilot uses `timeout --kill-after=2s`) | Exceed deadline | Worker tree exited; result status is timeout or failed; no `verified-proposal` | Partial files treated as verified |
| TMO-02 | Protected check per-case timeout | Invoke fixture that sleeps beyond check timeout (sandbox uses 6s) | Run `check` | That case returns `{"error":"timeout"}`; siblings still recorded; overall candidate not verified | Timeout coerced to a numeric pass value |
| TMO-03 | AbortSignal from controller | Start linger; fire controller abort or `AbortSignal.timeout` | Abort path runs | stdin closed or kill issued; closed promise observed; claim not verified | Orphaned children remain after deadline |
| TMO-04 | Nested kill-after | Outer timeout fires; child ignores first signal briefly | Wait kill-after window | Descendants gone after kill-after; durable record notes timeout | Descendants persist past kill-after without UNRESOLVED |

Proof method: sleep fixtures and recorded clocks only. Compare descendant liveness and claim disposition.

### 6. Durable records

Goal: Claim, scope, outcome, and evidence files are append-safe, exclusive-create where required, and survive restart.

| ID | Case | Setup (inert) | Action | PASS | FAIL |
| --- | --- | --- | --- | --- | --- |
| DUR-01 | Exclusive claim create | Target `claim-<id>.json` absent | Write with exclusive create (`wx`) | File exists once with `scopeHash` and `disposition: claimed` | Overwrite of an existing claim succeeds |
| DUR-02 | Scope hash binds immutable fields | Build scope with revision, digests, model id, engine, `protectionCases`, deadline | Persist claim | Recomputed `scopeHash` matches; mutating any bound field without new claim is rejected | Hash ignores `protectionCases` or digests |
| DUR-03 | Result artifact exclusivity | Prepare `pilot-result-<id>.json` and `proposal-<id>.patch` | Write results with exclusive create | Both created once; second write fails | Silent overwrite changes `patchSha256` |
| DUR-04 | Disposition monotonicity | claimed → running → stopped or verified or failed | Attempt illegal reverse (verified → claimed) | Rejected; prior evidence retained | Disposition rolls backward |
| DUR-05 | Restart reads same bytes | Complete DUR-01 through DUR-03 | Restart controller; read claim and result | Byte-identical records; same ids and hashes | Records missing, truncated, or rewritten |

Proof method: file existence flags, SHA-256 of JSON and patch bytes, and a cold reopen of the disposable controller. Keep all paths under the pilot directory.

### 7. Protected check evidence

Goal: Check results are produced by a verifier the candidate cannot control, bound to the approved case vector, and honest about failure modes.

Roadmap finding: the candidate can influence the check-result channel, so pilot pass counts alone are not protected-verifier evidence.

| ID | Case | Setup (inert) | Action | PASS | FAIL |
| --- | --- | --- | --- | --- | --- |
| CHK-01 | Baseline fails intentionally | Unchanged fixture-repo with stock `limits.py` / `measurement.py` | Run protected cases | `before.failures.length > 0` | Baseline unexpectedly passes all twelve |
| CHK-02 | Honest candidate passes | Hand-authored inert corrected sources in a `candidate-*` dir (no model) | Run protected cases | All twelve match expected values; failures empty | Pass recorded with mismatched values |
| CHK-03 | Forged stdout rejected | Candidate whose imported functions are wrong, but a wrapper prints forged `{"value": expected}` | Run through the protected invoke path | Verifier fails closed (`failed` or mismatch); no verified status | Forged channel yields a pass |
| CHK-04 | Case vector binding | Claim stores `protectionCases: sha(JSON.stringify(CASES))` | Alter case order or expected values without new claim | Check refused or hash mismatch; old evidence invalidated | Altered vector accepted under old claim |
| CHK-05 | Incomplete output | Verifier returns fewer rows than CASES | Controller evaluates | Incomplete output is an error; not a partial pass | Controller pads or ignores missing rows |
| CHK-06 | Invalid shape | Row is `{}`, `{"value":"1"}`, or multi-key object | Controller evaluates | Row treated as failed; candidate not verified | Non-int or multi-key row accepted |
| CHK-07 | Independent of agent-edited tests | Candidate adds a fake `test_limits.py` that always passes | Run protected plan from approved base only | Protected plan ignores candidate-added tests; only invoke path counts | Agent-edited tests can mark protected evidence green |

Proof method: hand-write corrected and adversarial fixture files. Feed JSON case lists on stdin. Compare outcomes to the fixed CASES table in `pilot.mjs`. Never call OpenCode or a model.

### 8. Checked-file patch binding

Goal: The patch presented for review is exactly the tree that passed protected checks, against the pinned baseline revision.

| ID | Case | Setup (inert) | Action | PASS | FAIL |
| --- | --- | --- | --- | --- | --- |
| PAT-01 | Name-only and content bind | Candidate that passed CHK-02 | `git diff` name-only and full patch against pinned `fixture-repo` HEAD | Diff names equal `limits.py` and `measurement.py` only; patch applies with `--check`; base unchanged | Extra paths, missing paths, or dirty base |
| PAT-02 | Checked bytes equal patch bytes | After checks, hash each candidate file | Build patch; re-extract or re-apply to a temp tree | File digests after apply equal checked digests; `patchSha256` matches written patch | Patch content differs from checked candidate |
| PAT-03 | Swap-after-check detected | Pass checks; replace one candidate file before patch capture | Attempt verify-proposal | Binding fails; no verified status | Verified proposal references post-swap content |
| PAT-04 | Stale base held | Change fixture-repo HEAD after claim recorded `revision` | Attempt patch verify or apply | Held for moved base; original revision still in evidence | Patch verified against a different HEAD |
| PAT-05 | Unchanged file rejected | Proposal changes only one of the two approved files | `validateProposal` | Throws; no patch written | Single-file change accepted for the two-file scope |
| PAT-06 | Apply does not mutate base | Valid patch from PAT-01 | `git apply --check` then re-read base files | Base bytes identical to pre-claim originals; `git status` clean | Base files mutated during verify |

Proof method: use Git only on the disposable `fixture-repo`. Capture `rev-parse HEAD`, file SHA-256 digests, and patch SHA-256. The unit test `validateProposal` covers PAT-05 style rejects locally without Git.

## Suggested execution order

1. DUR-01, DUR-02, OWN-01 (records and ownership before lifecycle).
2. STP-01, STP-02, STP-03, TMO-01, TMO-03 (Stop and timeout trees).
3. RST-01 through RST-03, RPL-01, RPL-03 (recovery and replay).
4. CHK-01 through CHK-07 (protected verifier integrity).
5. PAT-01 through PAT-06 (bind checked tree to patch).
6. Re-run DUR-05 last as a cold-start smoke over retained stubs.

Stop the lane if STP-01 remains UNRESOLVED: Windows Stop evidence is a roadmap gate and blocks treating the pilot as qualified.

## Mapping to existing pilot code

| Matrix theme | Current pilot touchpoint | Known limit to close |
| --- | --- | --- |
| Ownership | `claim-<id>.json` exclusive write in `pilot.mjs` | No multi-controller lease or generation checks |
| Stale Stop | `sandbox.stop_probe()` via Linux `process.kill()` | Does not prove Windows-initiated Stop of the real tree |
| Restart | Claim file on disk before generate | No inspect or recover API after controller death |
| Replay | Scope hash and request text in claim | No requestId idempotent reopen path in the pilot |
| Timeout | `AbortSignal.timeout`, `timeout --kill-after`, check 6s | Partial versus verified disposition needs explicit tests |
| Durable records | `wx` claim, patch, and result writes | Disposition state machine not enforced beyond one happy path |
| Protected checks | `checkFiles` → guest `invoke` | Candidate-influenced result channel; not a sealed verifier |
| Patch binding | Diff name-only, `apply --check`, base reread | No digest equality gate between checked files and patch bytes |

## Local verification allowed in this worktree

- Read-only review of pilot sources and this plan.
- `node --test research/isolated-runner-20261118/pilot.test.mjs` for helper contracts.
- Future small inert fixtures and tests added by a later owned change set; this document does not add them.

## Explicit non-goals for this document

- Integrating the runner into `harness/` or the browser preview.
- Live OpenCode, llama.cpp, or Qwen runs.
- Pushing, publishing, merging, or touching the live preview.
- Broad system changes, installs, external targets, exploits, credentials, inference, delegation, or paid credits.

## Exit criteria for roadmap gates 1 through 3

| Gate | Required PASS set | Blocker if missing |
| --- | --- | --- |
| 1. Windows Stop and stale Stop | STP-01, STP-02, STP-03 (STP-04 may be UNRESOLVED with recorded reason) | Linux-only probe presented as Windows evidence |
| 2. Restart and replay | RST-01, RST-02, RST-03, RPL-01, RPL-03 | Duplicate workers or automatic redispatch |
| 3. Timeout, check integrity, patch binding | TMO-01, TMO-02, CHK-03, CHK-04, CHK-07, PAT-02, PAT-03, PAT-04 | Forged check channel or unbound patch |

Independent review is still required after the matrix is executed. This plan alone is not qualification evidence.
