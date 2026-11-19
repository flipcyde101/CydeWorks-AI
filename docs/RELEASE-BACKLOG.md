# CydeWorks AI Personal Release Backlog

Date: November 18, 2026
Owner worktree: `work/t3-release-backlog`
Owned artifact: `docs/RELEASE-BACKLOG.md`
Baseline commit: `7fc7bd8` (`Add defensive check-result parser unit tests`)
References: [AGENTS.md](../AGENTS.md) · [docs/ROADMAP.md](ROADMAP.md) · [docs/NEXT-WAVE.md](NEXT-WAVE.md) · [12-Package Feature Plan](superpowers/plans/2026-11-18-cydeworks-ai-feature-and-reuse-plan.md) · separate plan [docs/STIG-READINESS-PLAN.md](STIG-READINESS-PLAN.md)

Section 8 is a later unreviewed planning cross-reference on branch `work/t3-stig-readiness-plan`. It does not revise sections 1 through 7, does not merge the STIG plan, and does not accept any package as release-ready.

This document defines the dependency-ordered release backlog to finish the CydeWorks AI personal Windows release. It separates verified source and test evidence in the current repository from remaining implementation and qualification gaps, enforces the browser connection safety gates, assigns T3 provider and reasoning effort routing, and isolates branch file scopes so parallel worktrees never collide or revert peer work.

---

## 1. Verified Baseline vs. Remaining Release Gaps

The table below reconciles the 12-package feature plan against the actual source in `harness/` and `research/isolated-runner-20261118/` at commit `7fc7bd8`.

| Package | Verified in Source Today (`7fc7bd8`) | Remaining Gaps to Personal Release Finish Line | Backlog IDs |
| --- | --- | --- | --- |
| **Pkg 1: Preview stability and legacy receipts** | `harness/receipt-adapter.mjs`, `harness/receipt-export.mjs`, `harness/receipt-contract.mjs`, and `harness/receipt-analytics.mjs` support v2 receipt exports and legacy 6-field and pre-backend digest projection (`harness/receipt-legacy.test.mjs`, `harness/receipt-repair.test.mjs`). 288 workspace tests pass. | Diagnose and project any remaining historical Dell task shapes on a read-only snapshot, surface plain-language unavailable reasons in `harness/web-experience/views/usage.js` and `harness/web-experience/logic/usage-rows.js`, and refresh dated checkpoint tables in `README.md` and `harness/README.md`. | `RB-P01-A` |
| **Pkg 2: Projects and authoritative scope / approval** | Single-file or brief scope validation in `harness/server.mjs`, route revision binding (`harness/route-inventory.mjs`), idempotent `requestId` submission recovery (`harness/run-submission.mjs`), session lock (`harness/workspace-lock.mjs`), and browser approval logic (`harness/web-experience/logic/approval.js`). | Local project registry (`GET /api/projects`, `POST /api/projects` in `harness/workspace-projects.mjs`), project switcher in `harness/web-experience/views/work.js`, immutable approval grants (`grantId`, `claimId`, `policyVersion`, `expiresAt`, 5-minute single-use action grants in `harness/approval-audit.mjs`), and explicit `claimed` to `dispatching` crash hold. | `RB-P02-A`, `RB-P02-B` |
| **Pkg 3: Isolated runner qualification** | Standalone research pilot in `research/isolated-runner-20261118/` (`pilot.mjs`, `sandbox.py`, `guest.py`, `runner-lifecycle.mjs`, `lifecycle-wsl.mjs`, `runner-regression-plan.md`, `test_check_parser.py`). Inert WSL fixture Stop/restart and defensive check parser unit tests pass (7 lifecycle tests, 3 pilot helper tests, 5 parser unit tests). `pilot.mjs` live execution fails closed. | **Browser Connection Gates:** Windows-initiated Stop for the actual OpenCode/bwrap worker tree (not just Linux `stop_probe()` or the inert sleep fixture), controller restart and request replay reconciliation without duplicate dispatch, sealed verifier channel isolating `/proc/self/fd` so candidate code cannot forge check results, cryptographic binding of checked candidate bytes to the proposed patch, Codex GPT-6.2 Sol High safety review, off-by-default synthetic staging (`BFE_STAGING_RUNNER`), and production `harness/runner.mjs` adapter. | `RB-G01-A`, `RB-G01-B`, `RB-G01-C`, `RB-G01-D`, `RB-G01-R`, `RB-S02-A`, `RB-S02-B`, `RB-P03-A` |
| **Pkg 4: Multi-file changes, protected checks, explicit apply** | Single-file unified diff (`harness/patch.mjs`) and read-only accepted artifact/patch download (`harness/artifact-download.mjs`). | Multi-file candidate tree extraction, separate execution of base-pinned protected checks vs. repo-owned checks, multi-file diff review and edit invalidation in `harness/web-experience/views/task.js`, and confirmed local branch/worktree patch application (`POST /api/tasks/:id/apply` in `harness/repository-workflow.mjs`). | `RB-P04-A`, `RB-P04-B` |
| **Pkg 5: Terminal ownership, continuity, and progress** | Per-attempt 15-second control lease with 5-second heartbeat and ownership generation (`harness/terminal-control.mjs`, `harness/owner-lease.mjs`), task attention rules (`harness/attention.mjs`), and read-only event stream with Take, Take over, Release, Detach, Reattach, and Stop. | Qualify external Herdr Core PTY protocol or retain read-only fallback (`harness/herdr-core.mjs`), brokered PTY input bound to `attemptId` + `lease` + `ownerGeneration`, durable replay cursor across service restarts, and measured worker progress/ETA counters in `harness/web-experience/views/task.js`. | `RB-P05-A`, `RB-P05-B` |
| **Pkg 6: Model choice, receipts, and router comparisons** | Route readiness and inventory (`harness/route.mjs`, `harness/route-inventory.mjs`, `harness/connection-readiness.mjs`), deterministic evaluator (`harness/router-evaluator.mjs`, `harness/router-evaluation-api.mjs`), OpenCode step receipt parser (`harness/opencode-usage.mjs`), cost formatter (`harness/cost-presentation.mjs`), and standalone SQLite `UsageLedger` (`harness/usage-ledger.mjs`). | Qualify two local runtime profiles (Qwen3-4B on `llama.cpp` plus a second local profile via `ollama` or `llama.cpp`) across brief and repo workflows, wire `UsageLedger` reservations into `harness/server.mjs` before metered dispatch, expose phase timings and cache buckets in `harness/web-experience/views/usage.js`, and run shadow/paired route comparisons (`harness/router-qualification.test.mjs`). | `RB-P06-A`, `RB-P06-B` |
| **Pkg 7: Supported provider connections** | Host connection inspection and contract (`harness/connection-host.mjs`, `harness/connection-contract.mjs`) and Connections view scaffold (`harness/web-experience/views/connections.js`). | Settings -> Connections CRUD (Add, Check, Revoke, hold reasons) backed by OS credential store or vendor CLI sign-in, synthetic provider adapters under `harness/providers/`, and one-by-one qualification of owner-authorized connections (`harness/provider-connection.test.mjs`). | `RB-P07-A`, `RB-P07-B` |
| **Pkg 8: Hermes, reusable context, and brief workflow** | Portable manifest contracts (`harness/portable-manifest-contract.mjs`), single-citation structural check in `harness/server.mjs`, and 20-case synthetic brief rubric in `outputs/Brief Builder - Synthetic Test Cases.md` and `outputs/Brief Builder - Scoring Rubric.md`. | Project context and skill library with provenance, approval, and revocation (`harness/project-context.mjs`), read-only Hermes ACP engine adapter (`harness/hermes.mjs`), anchored source-line brief review with unsupported-claim flags, and 20-case + 5-holdout evaluation pass. | `RB-P08-A`, `RB-P08-B`, `RB-P08-C` |
| **Pkg 9: Coordinated agent team (Swarm)** | Validated DAG plan builder `prepareSwarmPlan` and SQLite state machine `SwarmCoordinator` (`harness/swarm.mjs`, `harness/swarm.test.mjs`) plus Agents view scaffold (`harness/web-experience/views/agents.js`). | Runtime dispatch broker (`harness/swarm-dispatch.mjs`) connecting `SwarmCoordinator` claims to the qualified runner and `UsageLedger` parent caps, builder-then-reviewer execution (max 1-2 concurrent workers), and live Agents view wiring. | `RB-P09-A` |
| **Pkg 10: Factory interop and OpenClaw connection** | Portable import review planner (`harness/portable-import-review-planner.mjs`, `harness/contributor-api.mjs`) and deduplicated submission keys (`harness/run-submission.mjs`). | Paperclip issue draft import (`GET /api/issues/{issueId}`) and replay-safe comment evidence return with wake off (`harness/paperclip.mjs`), plus read-only OpenClaw gateway session observation (`harness/openclaw.mjs`, `harness/factory-interop.test.mjs`). | `RB-P10-A` |
| **Pkg 11: Data controls and signed Windows delivery** | Metadata export (`harness/export.mjs`), active task removal with audit (`harness/removal.mjs`), portable handoff validator (`harness/portable-handoff-validator.mjs`), and Electron utilityProcess bootstrap with write fence (`harness/desktop/main.cjs`, `harness/desktop/service.cjs`, `harness/desktop/environment.cjs`). | Multi-store storage inventory, consistent SQLite backup and disposable-workspace restore verification (`harness/workspace-backup.mjs`), native OS folder picker, keyboard/screen-reader/forced-colors accessibility pass, and signed Windows installer with upgrade and rollback rehearsal. | `RB-P11-A`, `RB-P11-B`, `RB-P11-C` |
| **Pkg 12: Personal release readiness** | Historical 1-file Dell preview smoke tests and 288 synthetic unit tests. | 10-task paired coding benchmark across two local profiles, brief holdout score report, live rehearsals of Hermes, Swarm, Paperclip, OpenClaw, and backup restore, R01-R15 sign-off matrix, and owner release handoff. | `RB-P12-A` |

---

## 2. Browser Connection Safety Gates

No live runner, WSL worker, or tool-capable OpenCode instance may be wired into `harness/server.mjs` or exposed to `harness/web-experience/` until all five gates below pass and are committed with reproducible evidence:

1. **Gate G1 (`RB-G01-A`): Windows Stop for Actual Runner Tree**
   - Issuing Stop from the Windows host controller must terminate the actual guest runner process (`wsl.exe` -> `runner-bwrap` -> `/guest.py` -> `/opencode` and all descendant processes), not merely the Linux-side `stop_probe()` or the inert `lifecycle-fixture.py` wrapper.
   - Repeated, concurrent, and stale-generation Stop requests must be handled deterministically (`STP-01` through `STP-05` in `research/isolated-runner-20261118/runner-regression-plan.md`).
   - Any unconfirmed process tree termination within the cleanup deadline must record `cleanup: 'unknown'` and transition the claim to `unresolved`, blocking automatic retry.
2. **Gate G2 (`RB-G01-B`): Controller Restart, Crash Recovery, and Request Replay**
   - Killing and restarting the Windows controller mid-attempt or between claim and dispatch must reconcile persisted worker birth identity (`nonce`, `birthIdentity`) and event sequence cursors without spawning duplicate workers (`RST-01` through `RST-04`).
   - Replaying an identical `requestId` and `scopeHash` must return the existing durable claim/result without re-running inference or double-counting usage (`RPL-01` through `RPL-04`, `DUR-01` through `DUR-05`).
3. **Gate G3 (`RB-G01-C`): Protected Verifier Safety and Timeout Isolation**
   - The candidate check execution path in `research/isolated-runner-20261118/sandbox.py` and `guest.py` must seal the result descriptor so untrusted candidate code cannot discover or write to the result pipe via `/proc/self/fd` or shared stdio (`CHK-01` through `CHK-07`).
   - Per-case wall-clock and CPU timeouts and outer generation deadlines must terminate runaway candidate code and fail closed (`TMO-01` through `TMO-04`).
4. **Gate G4 (`RB-G01-D`): Cryptographic Checked-File to Patch Binding**
   - The SHA-256 digests of the candidate files verified by the protected check runner must be cryptographically bound to the base Git revision (`baseRevision`), the protected check vector digest (`protectionCases`), and the exact unified diff (`patchSha256`) via `bindCheckedPatch` (`PAT-01` through `PAT-06`).
   - Any post-check file swap, single-file partial edit in a two-file scope, or moved base HEAD must fail closed.
5. **Gate G5 (`RB-G01-R`): Independent Safety Review by Codex GPT-6.2 Sol High**
   - Codex GPT-6.2 Sol with `High` reasoning effort must independently audit the code, process boundary proofs, and test transcripts for Gates G1 through G4 in `review/t3-runner-safety` before any live runner adapter connects to the browser service.

---

## 3. T3 Provider and Effort Routing Rules

All waves follow strict role and model routing:

| Role | Provider & Model | Effort / Configuration | Permitted Scope |
| --- | --- | --- | --- |
| **Independent Review & Safety Gatekeeper** | **Codex GPT-6.2 Sol** | `High` reasoning effort | Mandatory independent reviewer for every wave merge and sole sign-off authority for the Browser Connection Safety Gates (`RB-G01-R`) and release readiness (`RB-P12-R`). Read-only defect-first review. |
| **Difficult Architecture & Isolation Design** | **Antigravity Gemini 4 Neon** | High / architectural design mode | Complex security boundaries, cross-OS process tree lifecycle, sealed verifier IPC, multi-store transaction design, and PTY ownership protocol design. |
| **Alternate Planning & Matrix Reconciliation** | **Antigravity Gemini 4 Argon** | Planning / analytical mode | Backlog orchestration, regression matrix updates, router evaluation analysis, brief scoring audit, and multi-worktree dependency reconciliation. |
| **Bounded Implementation & Unit Tests** | **Antigravity Gemini 4 Hydrogen** | Bounded execution mode | Scoped feature implementation, synthetic fixtures, adapter wiring, and unit/integration test authoring within a single worktree's file scope. |

**Routing invariants:**
- Always specify exact provider, model, and effort.
- If a model or quota is unavailable, halt and report the exact limit; never fall back to paid API billing, spend paid credits, or silently substitute a non-approved reviewer.
- Preserve all owner approvals and existing worktrees. Never run destructive git commands or revert peer worktree commits.

---

## 4. Dependency-Ordered Waves and Work Items

### Wave 0: Offline Foundations, Receipt Repair, and Scope/Backup Contracts (Can Run Immediately in Parallel)

Wave 0 items have zero dependency on live runner qualification or browser connection gates and touch disjoint file scopes in `harness/`.

| ID | Title & Package | Concrete File & Entry-Point Scope | Branch Owner | Provider & Effort Routing | Dependencies | Acceptance Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `RB-P01-A` | Legacy receipt diagnostics, Usage coverage UI, and dated README sync (Pkg 1) | `harness/receipt-adapter.mjs`, `harness/receipt-legacy.test.mjs`, `harness/web-experience/logic/usage-rows.js`, `harness/web-experience/views/usage.js`, `README.md`, `harness/README.md` | `work/t3-pkg01-legacy-receipts` | Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | None | `node --test harness/receipt-legacy.test.mjs harness/receipt-endpoint.test.mjs harness/route-bound-receipt.test.mjs` passes; legacy, unavailable, and current v2 receipts render together in Usage with accurate coverage counts. |
| `RB-P02-A` | Local project registry and immutable approval audit module (Pkg 2 backend) | `harness/workspace-projects.mjs` (new), `harness/approval-audit.mjs` (new), `harness/approval-audit.test.mjs` (new), `harness/run-submission.mjs` | `work/t3-pkg02-approval-audit` | Design: **Gemini 4 Neon**; Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | None | `node --test harness/approval-audit.test.mjs harness/run-submission.test.mjs` passes; verifies immutable grant fields (`grantId`, `claimId`, `sourceHash`, `routeRevision`, `policyVersion`, `expiresAt`), 5-minute single-use action grants, and expired/stale grant rejection. |
| `RB-P11-A` | Offline SQLite backup, artifact manifest, and disposable restore verifier (Pkg 11 data) | `harness/workspace-backup.mjs` (new), `harness/workspace-backup.test.mjs` (new), `harness/export.mjs`, `harness/removal.mjs` | `work/t3-pkg11-workspace-backup` | Design: **Gemini 4 Neon**; Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | None | `node --test harness/workspace-backup.test.mjs harness/export.test.mjs harness/removal.test.mjs` passes; backup excludes `.state/access.key` and session secrets, verifies SHA-256 manifest, and restores cleanly into a disposable SQLite path while rejecting corrupted archives without mutating live state. |
| `RB-P08-A` | Project context and reusable skill library with provenance and revocation (Pkg 8 offline) | `harness/project-context.mjs` (new), `harness/project-context.test.mjs` (new), `harness/portable-manifest-contract.mjs` | `work/t3-pkg08-project-context` | Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | None | `node --test harness/project-context.test.mjs` passes; proves cross-project isolation, prompt preview of included memory/skills, approval invalidation on skill version change, and immediate exclusion upon revocation. |

---

### Wave 1: Isolated Runner Hardening & Browser Connection Gate Closure (Offline in `research/`)

Wave 1 resolves the November 18 runner review findings entirely offline inside `research/isolated-runner-20261118/` using inert fixtures.

| ID | Title & Package | Concrete File & Entry-Point Scope | Branch Owner | Provider & Effort Routing | Dependencies | Acceptance Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `RB-G01-A` | Windows-initiated Stop for actual runner process tree (Gate G1 / Pkg 3) | `research/isolated-runner-20261118/lifecycle-wsl.mjs`, `research/isolated-runner-20261118/runner-lifecycle.mjs`, `research/isolated-runner-20261118/runner-lifecycle.test.mjs` | `work/t3-runner-lifecycle` | Design: **Gemini 4 Neon**; Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | None | `node --test research/isolated-runner-20261118/runner-lifecycle.test.mjs` passes `OWN-01..04` and `STP-01..05`; proves Windows-initiated Stop terminates actual `runner-bwrap` and descendant PIDs and leaves unverified trees `unresolved`. |
| `RB-G01-B` | Controller restart reconciliation and request replay idempotency (Gate G2 / Pkg 3) | `research/isolated-runner-20261118/runner-lifecycle.mjs`, `research/isolated-runner-20261118/runner-lifecycle.test.mjs` | `work/t3-runner-lifecycle` | Design: **Gemini 4 Neon**; Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-G01-A` | Passes `RST-01..04`, `RPL-01..04`, and `DUR-01..05`; controller kill/restart recovers worker identity without duplicate spawn or automatic redispatch of pre-dispatch claims. |
| `RB-G01-C` | Sealed verifier result channel and timeout enforcement (Gate G3 / Pkg 3) | `research/isolated-runner-20261118/sandbox.py`, `research/isolated-runner-20261118/guest.py`, `research/isolated-runner-20261118/test_check_parser.py` | `work/t3-runner-verifier` | Design: **Gemini 4 Neon**; Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | None | `python3 -m unittest research/isolated-runner-20261118/test_check_parser.py` and verifier matrix `CHK-01..07`, `TMO-01..04` pass; candidate code cannot forge `{"value": ...}` via stdout or `/proc/self/fd` inspection. |
| `RB-G01-D` | Cryptographic checked-candidate to patch binding (Gate G4 / Pkg 3) | `research/isolated-runner-20261118/pilot.mjs`, `research/isolated-runner-20261118/pilot.test.mjs`, `research/isolated-runner-20261118/runner-lifecycle.mjs` | `work/t3-verified-patch-binding` | Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-G01-C` | `node --test research/isolated-runner-20261118/pilot.test.mjs` passes `PAT-01..06`; `bindCheckedPatch` rejects post-check file swaps, single-file edits in a two-file scope, and moved base revisions. |
| `RB-G01-R` | Independent Browser Connection Safety Gate Audit (Gate G5) | Read-only audit of `research/isolated-runner-20261118/*` and gate test evidence recorded in `docs/ROADMAP.md` / review transcript | `review/t3-runner-safety` | Review: **Codex GPT-6.2 Sol High** (exclusive) | `RB-G01-A`, `RB-G01-B`, `RB-G01-C`, `RB-G01-D` | Signed-off defect-free review from Codex GPT-6.2 Sol High confirming Gates G1-G4 pass with zero unresolved safety blockers. |

---

### Wave 2: Off-by-Default Inert Browser Staging & Server Project/Approval Integration

Wave 2 integrates the Wave 0 approval/project modules into `harness/server.mjs` and introduces the inert synthetic runner fixture behind `BFE_STAGING_RUNNER=0` after Gate G5 (`RB-G01-R`) passes.

| ID | Title & Package | Concrete File & Entry-Point Scope | Branch Owner | Provider & Effort Routing | Dependencies | Acceptance Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `RB-P02-B` | Wire project endpoints, approval grants, and project switcher into server and Work UI (Pkg 2) | `harness/server.mjs`, `harness/web-experience/views/work.js`, `harness/web-experience/logic/approval.js`, `harness/route-binding-api.test.mjs`, `harness/run-submission-api.test.mjs` | `work/t3-pkg02-server-projects` | Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-P02-A` | `node --test harness/approval-audit.test.mjs harness/route-binding-api.test.mjs harness/run-submission-api.test.mjs harness/session-lock.test.mjs` and full `npm --prefix harness test` pass; two-tab approval races dispatch at most once. |
| `RB-S02-A` | Inert synthetic runner fixture behind `BFE_STAGING_RUNNER=0` switch (NEXT-WAVE Milestone 2) | `harness/providers/synthetic-runner-fixture.mjs` (new), `harness/route-inventory.mjs`, `harness/providers.mjs`, `harness/synthetic-staging.test.mjs` (new) | `work/t3-staging-synthetic-adapter` | Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-G01-R` | `node --test harness/synthetic-staging.test.mjs harness/route-inventory.test.mjs` passes; when `BFE_STAGING_RUNNER=0`, staging routes are absent from `GET /api/models` and rejected on run; when `BFE_STAGING_RUNNER=1`, the in-memory fixture runs without spawning external processes. |
| `RB-S02-B` | End-to-end browser staging rehearsal with inert synthetic fixture (NEXT-WAVE Milestone 3) | `harness/server.mjs`, `harness/web-experience/views/task.js`, `harness/receipt-endpoint.test.mjs`, `harness/terminal-control.test.mjs` | `work/t3-staging-browser-rehearsal` | Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-P02-B`, `RB-S02-A` | Full rehearsal in disposable staging workspace (`BFE_STAGING_RUNNER=1`): scope approval, terminal Detach/Reattach/Stop, two-file diff review (`limits.py`, `measurement.py`) with "Nothing applied" invariant, and valid v2 receipt (`evidence.usage: 'synthetic'`). |

---

### Wave 3: Qualified Production Runner, Multi-File Repository Workflow, and Terminal Continuity

Wave 3 promotes the qualified runner contract into `harness/runner.mjs`, enables multi-file protected checks and explicit local branch patch application, and completes terminal continuity.

| ID | Title & Package | Concrete File & Entry-Point Scope | Branch Owner | Provider & Effort Routing | Dependencies | Acceptance Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `RB-P03-A` | Production isolated runner adapter and host qualification record (Pkg 3) | `harness/runner.mjs` (new), `harness/runner.test.mjs` (new), `harness/inference-broker.mjs`, `harness/recovery.mjs`, `harness/test-support/runner-qualification-fixture.mjs` (new) | `work/t3-pkg03-runner-adapter` | Design: **Gemini 4 Neon**; Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-G01-R`, `RB-S02-B` | `node --test harness/runner.test.mjs harness/inference-broker.test.mjs harness/recovery.test.mjs` passes; implements `runner.start`, `runner.events`, `runner.inspect`, `runner.stop`, `runner.collect` with persisted worker identity before startup ack. |
| `RB-P04-A` | Multi-file diff extraction, base-pinned protected checks, and explicit branch apply backend (Pkg 4) | `harness/repository-workflow.mjs` (new), `harness/repository-workflow.test.mjs` (new), `harness/patch.mjs`, `harness/artifact-download.mjs` | `work/t3-pkg04-repo-workflow` | Design: **Gemini 4 Neon**; Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-P03-A` | `node --test harness/repository-workflow.test.mjs harness/artifact-download-api.test.mjs` passes; verifies base-pinned protected checks run independently of candidate-edited tests, multi-file patch download, and idempotent `POST /api/tasks/:id/apply` onto a clean review branch/worktree. |
| `RB-P04-B` | Multi-file review UI, edit check invalidation, and confirmed apply dialog (Pkg 4 UI) | `harness/web-experience/views/task.js`, `harness/web-experience/views/dialogs.js`, `harness/proposal-edit.test.mjs` | `work/t3-pkg04-review-ui` | Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-P04-A` | `node --test harness/proposal-edit.test.mjs harness/proposal-editor.test.mjs` passes; highlights test/CI/dependency changes, invalidates check badges on human edit until rechecked, and holds apply on moved base revision. |
| `RB-P05-A` | Herdr Core PTY qualification / brokered terminal input and durable replay across restart (Pkg 5) | `harness/herdr-core.mjs` (new), `harness/herdr-core.test.mjs` (new), `harness/terminal-control.mjs`, `harness/owner-lease.mjs`, `harness/terminal-api.test.mjs` | `work/t3-pkg05-terminal-pty` | Design: **Gemini 4 Neon**; Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-P03-A` | `node --test harness/herdr-core.test.mjs harness/terminal-api.test.mjs harness/terminal-control.test.mjs harness/owner-lease.test.mjs` passes; enforces single input owner (`attemptId` + `lease` + `ownerGeneration`), suspends agent steps on Take, requires explicit Resume on Release, and preserves read-only replay across service restart. |
| `RB-P05-B` | Measured progress counters, heartbeat ETA, and aggregated task-level Needs-you attention (Pkg 5) | `harness/attention.mjs`, `harness/attention.test.mjs`, `harness/progress.test.mjs`, `harness/web-experience/logic/situation.js` | `work/t3-pkg05-progress-attention` | Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-P05-A` | `node --test harness/attention.test.mjs harness/progress.test.mjs` passes; computes ETA strictly from measured worker step rates and surfaces a single task-level attention item for approvals, stalls, or unresolved recovery holds. |

---

### Wave 4: Model Qualification, Usage Ledger Wiring, Provider Connections, and Hermes Briefs

Wave 4 qualifies the second local runtime, wires `UsageLedger` reservations into dispatch, adds Settings -> Connections with synthetic and owner-approved provider adapters, and completes the Hermes ACP and 25-case brief workflow.

| ID | Title & Package | Concrete File & Entry-Point Scope | Branch Owner | Provider & Effort Routing | Dependencies | Acceptance Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `RB-P06-A` | Dual local runtime qualification and router shadow/paired comparison suite (Pkg 6) | `harness/route.mjs`, `harness/route-inventory.mjs`, `harness/connection-readiness.mjs`, `harness/router-evaluator.mjs`, `harness/router-qualification.test.mjs` (new) | `work/t3-pkg06-router-qualification` | Plan: **Gemini 4 Argon**; Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-P01-A`, `RB-P04-A` | `node --test harness/router-qualification.test.mjs harness/router-readiness.test.mjs harness/router-regression.test.mjs` passes; pins two local profiles (Qwen3-4B on `llama.cpp` + second local profile) with exact model fingerprint/quantization and separates measured paired run differences from hypothetical router estimates. |
| `RB-P06-B` | Wire `UsageLedger` reservations, cumulative sample replacement, and cache/timing drilldown (Pkg 6) | `harness/usage-ledger.mjs`, `harness/opencode-usage.mjs`, `harness/cost-presentation.mjs`, `harness/server.mjs`, `harness/web-experience/views/usage.js`, `harness/usage-ledger.test.mjs` | `work/t3-pkg06-ledger-wiring` | Design: **Gemini 4 Neon**; Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-P01-A`, `RB-P02-B` | `node --test harness/usage-ledger.test.mjs harness/opencode-usage.test.mjs harness/cost-presentation.test.mjs harness/receipt-inspector-compat.test.mjs` passes; enforces pre-dispatch integer-micros budget reservation, retains reservation on unsettled cancellation, and prohibits automatic fallback to paid routes on quota exhaustion. |
| `RB-P07-A` | Settings -> Connections CRUD, credential broker, and synthetic provider adapters (Pkg 7 offline) | `harness/connection-host.mjs`, `harness/connection-contract.mjs`, `harness/providers/connection-adapters.mjs` (new), `harness/provider-connection.test.mjs` (new), `harness/web-experience/views/connections.js` | `work/t3-pkg07-connections` | Design: **Gemini 4 Neon**; Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-P02-B`, `RB-P06-B` | `node --test harness/provider-connection.test.mjs harness/connection-regression.test.mjs` passes; tests Add, Check, Revoke, expired credentials, quota exhaustion hold, changed data destination rejection, and zero credential leakage in `/api/models` or receipts. |
| `RB-P07-B` | Owner-approved live provider connection qualification one at a time (Pkg 7 live gate) | `harness/providers/connection-adapters.mjs`, `harness/provider-connection.test.mjs` | `work/t3-pkg07-live-qualification` | Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-P07-A` + **Explicit Owner Account & Spend Approval** | One bounded real attempt per owner-authorized connection (starting with included subscription / CLI paths such as Antigravity CLI or Codex App Server where entitled); documents passed vs. held auth modes without spending unauthorized credits. |
| `RB-P08-B` | Hermes ACP read-only engine adapter (Pkg 8) | `harness/hermes.mjs` (new), `harness/hermes.test.mjs` (new), `harness/providers.mjs` | `work/t3-pkg08-hermes-adapter` | Design: **Gemini 4 Neon**; Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-P08-A`, `RB-P03-A` | `node --test harness/hermes.test.mjs` passes; executes one isolated read-only brief/research subtask over ACP with only approved project context fragments and maps events/usage into the task attempt receipt. |
| `RB-P08-C` | Anchored brief review, unsupported-claim detector, and 20+5 holdout evaluation (Pkg 8) | `harness/web-experience/views/task.js`, `harness/brief-evaluation.mjs` (new), `harness/brief-evaluation.test.mjs` (new) | `work/t3-pkg08-brief-eval` | Plan: **Gemini 4 Argon**; Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-P08-A` | `node --test harness/brief-evaluation.test.mjs` passes; scores all 20 synthetic cases in `outputs/Brief Builder - Synthetic Test Cases.md` (with B18 scoring clarified and B13 inference limits preserved) plus 5 fresh holdouts, exposing line anchors and unsupported claims. |

---

### Wave 5: Coordinated Agent Team (Swarm), Factory Interop, Accessibility, and Signed Windows Packaging

Wave 5 connects the multi-agent coordinator and external factory/gateway adapters and prepares the accessible, signed Windows desktop package.

| ID | Title & Package | Concrete File & Entry-Point Scope | Branch Owner | Provider & Effort Routing | Dependencies | Acceptance Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `RB-P09-A` | Swarm runtime dispatch broker (builder + reviewer) and live Agents view (Pkg 9) | `harness/swarm-dispatch.mjs` (new), `harness/swarm-dispatch.test.mjs` (new), `harness/swarm.mjs`, `harness/web-experience/views/agents.js` | `work/t3-pkg09-swarm-dispatch` | Design: **Gemini 4 Neon**; Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-P04-A`, `RB-P06-B` | `node --test harness/swarm-dispatch.test.mjs harness/swarm.test.mjs` passes; proves atomic child claims, disjoint file ownership enforcement, stopped builder blocking reviewer dispatch, parent budget cap enforcement, per-worker receipts, and owner review before apply. |
| `RB-P10-A` | Paperclip assignment import/evidence return and OpenClaw read-only gateway observation (Pkg 10) | `harness/paperclip.mjs` (new), `harness/openclaw.mjs` (new), `harness/factory-interop.test.mjs` (new), `harness/contributor-api.mjs` | `work/t3-pkg10-factory-interop` | Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-P02-B`, `RB-P06-B` | `node --test harness/factory-interop.test.mjs` passes; verifies unapproved draft import from `GET /api/issues/{issueId}`, idempotent evidence comment return with wake off, OpenClaw read-only session status recovery, and invariant that external board approval never grants CydeWorks execution permissions. |
| `RB-P11-B` | Multi-store data inventory UI, portable handoff recreate flow, and accessibility/diagnostics pass (Pkg 11 & 12) | `harness/web-experience/views/data.js`, `harness/web-experience/views/developer.js`, `harness/web-experience/views/shell.js`, `harness/web-experience/styles/app.css`, `harness/accessibility.test.mjs` (new) | `work/t3-pkg11-data-a11y` | Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-P11-A` | `node --test harness/accessibility.test.mjs harness/export-dialog.test.mjs harness/removal-dialog.test.mjs` passes; verifies keyboard navigation, focus retention across polling, ARIA live status announcements, forced-colors mode, narrow-window layout (720x560 min), and privacy-safe diagnostics disabled by default. |
| `RB-P11-C` | Electron desktop completion, native folder picker, pinned OpenCode resolution, and signed Windows installer/rollback rehearsal (Pkg 11) | `harness/desktop/main.cjs`, `harness/desktop/service.cjs`, `harness/desktop/environment.cjs`, `harness/desktop/package.json`, `harness/opencode.mjs`, `harness/desktop-bootstrap.test.mjs`, `harness/desktop-service.test.mjs` | `work/t3-pkg11-windows-desktop` | Design: **Gemini 4 Neon**; Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | `RB-P11-A`, `RB-P11-B`, `RB-P04-A` | `node --test harness/desktop-bootstrap.test.mjs harness/desktop-service.test.mjs harness/desktop-environment.test.mjs harness/opencode-path.test.mjs` passes; resolves OpenCode binary independently of Paperclip trial dir, verifies cold start, single-instance lock, legacy-preview fence, signed binary/installer hashes, upgrade, and rollback preserving `.state/workspace.sqlite`. |

---

### Wave 6: Personal Release Readiness Proof & Final Owner Handoff

| ID | Title & Package | Concrete File & Entry-Point Scope | Branch Owner | Provider & Effort Routing | Dependencies | Acceptance Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `RB-P12-A` | 10-task dual-profile coding benchmark, full workflow rehearsals, and release dossier (Pkg 12) | `docs/RELEASE-READINESS-REPORT.md` (new), `harness/release-readiness.test.mjs` (new) | `work/t3-pkg12-release-proof` | Plan: **Gemini 4 Argon**; Impl: **Gemini 4 Hydrogen**; Review: **Codex GPT-6.2 Sol High** | Waves 0-5 complete | 10 coding tasks across 2 qualified local configs (including multi-file edit, expected failure + retry, denied action, stale base, detach/reattach), 20+5 brief evaluation, 1 Hermes brief, 1 builder/reviewer swarm run, 1 Paperclip round-trip, 1 OpenClaw read-only observation, 1 disposable workspace backup restore, and 100% green `npm --prefix harness test`. |
| `RB-P12-R` | Final Codex GPT-6.2 Sol High Release Audit & Owner Cutover Gate (Pkg 12) | Read-only audit of release candidate commit, SHA-256 package manifest, R01-R15 matrix, and rollback runbook | `review/t3-personal-release-audit` | Review: **Codex GPT-6.2 Sol High** (exclusive) | `RB-P12-A` | Written release sign-off by Codex GPT-6.2 Sol High and explicit owner approval from Dillon before cutting over the live Dell preview or distributing the signed Windows package. |

---

## 5. Critical Path

The critical path to the daily-use personal release runs through the Browser Connection Safety Gates and repository workflow integration:

```
RB-G01-A (Windows Stop for actual worker tree)
  -> RB-G01-B (Controller restart & request replay safety)
  +  RB-G01-C (Sealed verifier fd isolation & timeouts)
  -> RB-G01-D (Cryptographic checked-file to patch binding)
  -> RB-G01-R (Codex GPT-6.2 Sol High Browser Connection Safety Review)
  -> RB-S02-A (Off-by-default BFE_STAGING_RUNNER synthetic fixture)
  -> RB-S02-B (Disposable browser staging rehearsal)
  -> RB-P03-A (Production harness/runner.mjs adapter & host qualification)
  -> RB-P04-A / RB-P04-B (Multi-file diff, base-pinned protected checks, confirmed branch apply)
  -> RB-P06-A / RB-P09-A / RB-P11-C (Dual-model benchmark, builder/reviewer swarm, signed Windows package)
  -> RB-P12-A -> RB-P12-R (Final release proof & Codex GPT-6.2 Sol High audit)
```

Every item on the critical path up to `RB-G01-R` executes offline in `research/isolated-runner-20261118/`. If `RB-G01-A` (`STP-01` Windows Stop of actual descendant PIDs) or `RB-G01-C` (`CHK-03` sealed verifier channel) remains `UNRESOLVED`, `RB-G01-R` holds the browser connection gate closed while offline `harness/` waves (Wave 0, `RB-P02-B`, `RB-P06-B`, `RB-P07-A`, `RB-P08-A`, `RB-P08-C`, `RB-P11-A`, `RB-P11-B`) continue without delay.

---

## 6. Independent Tasks That Can Run Now

The following tasks have no unmet prerequisites, require no live model calls, installs, or paid credits, and own completely disjoint file scopes across `harness/` and `research/isolated-runner-20261118/`:

1. **`RB-P01-A` (`work/t3-pkg01-legacy-receipts`)**: Legacy receipt diagnostics, Usage coverage row counts, and dated README checkpoint updates (`harness/receipt-adapter.mjs`, `harness/receipt-legacy.test.mjs`, `harness/web-experience/logic/usage-rows.js`, `harness/web-experience/views/usage.js`, `README.md`, `harness/README.md`).
2. **`RB-P02-A` (`work/t3-pkg02-approval-audit`)**: Local project registry (`harness/workspace-projects.mjs`) and immutable approval grant / single-use 5-minute action grant engine (`harness/approval-audit.mjs`, `harness/approval-audit.test.mjs`).
3. **`RB-P11-A` (`work/t3-pkg11-workspace-backup`)**: Consistent SQLite backup generator, SHA-256 artifact manifest, secret exclusion, and disposable workspace restore verifier (`harness/workspace-backup.mjs`, `harness/workspace-backup.test.mjs`).
4. **`RB-P08-A` (`work/t3-pkg08-project-context`)**: Project memory and reusable skill library with provenance, prompt inclusion preview, and revocation (`harness/project-context.mjs`, `harness/project-context.test.mjs`).
5. **Runner Gate Worktrees (`RB-G01-A`..`RB-G01-D`)**: Concurrent runner gate worktrees under `research/isolated-runner-20261118/` (`work/t3-runner-lifecycle`, `work/t3-runner-verifier`, `work/t3-verified-patch-binding`) leading into `review/t3-runner-safety` (`RB-G01-R`).

### Recommended Two Bounded Parallel Tasks to Start Next

To maximize progress on `harness/` without colliding with the active `research/isolated-runner-20261118/` worktrees (`work/t3-runner-lifecycle`, `work/t3-runner-verifier`, `work/t3-verified-patch-binding`, `review/t3-runner-safety`), start these two bounded tasks in parallel right now:

- **Parallel Task 1: `RB-P02-A`: Local Project Registry & Immutable Approval Audit Module (Package 2)**
  - **Branch / Worktree**: `work/t3-pkg02-approval-audit`
  - **Provider & Effort**: Antigravity **Gemini 4 Hydrogen** for implementation and tests (with **Gemini 4 Neon** if schema design trade-offs arise), followed by **Codex GPT-6.2 Sol High** independent review.
  - **Exact File Scope**: `harness/workspace-projects.mjs` (new), `harness/approval-audit.mjs` (new), `harness/approval-audit.test.mjs` (new). (Does not touch `harness/server.mjs` until Wave 2 `RB-P02-B`).
  - **Deliverable & Verification**: Pure Node 24 SQLite project registry (`GET`/`POST` project contract with local root resolution and default workspace association) and transactional approval grant store (`grantId`, `claimId`, `requestId`, `sourceHash`, `routeRevision`, `policyVersion`, `expiresAt`, plus 5-minute single-use action grants). Verified via `node --test harness/approval-audit.test.mjs`.

- **Parallel Task 2: `RB-P11-A`: Consistent SQLite Backup & Disposable Restore Verifier (Package 11)**
  - **Branch / Worktree**: `work/t3-pkg11-workspace-backup`
  - **Provider & Effort**: Antigravity **Gemini 4 Hydrogen** for implementation and tests, followed by **Codex GPT-6.2 Sol High** independent review.
  - **Exact File Scope**: `harness/workspace-backup.mjs` (new), `harness/workspace-backup.test.mjs` (new).
  - **Deliverable & Verification**: Offline SQLite backup and restore module that inventories workspace tables and derived artifacts, emits a SHA-256 manifest while excluding `.state/access.key` and session/credential secrets, and verifies full restoration in a disposable temporary directory while leaving live state untouched on corrupt or incompatible archives. Verified via `node --test harness/workspace-backup.test.mjs`.

---

## 7. Release, Cutover, and Rollback Requirements

### 7.1 Live Preview Protection and Concurrency Rules
- **Never disrupt the running Dell preview**: The live service on `http://127.0.0.1:15371` and its private `.state/workspace.sqlite` and `.state/access.key` must not be stopped, restarted, read, or mutated by development or test tasks.
- **Disposable state for all tests**: Every unit, integration, and staging test must use `BFE_TEST_MEMORY=1` or a disposable temporary directory with `BFE_PORT=0`.
- **Strict worktree isolation**: One branch owner per file scope. Reconcile merges in a dedicated integration worktree after `npm --prefix harness test` and focused package tests pass and receive **Codex GPT-6.2 Sol High** sign-off.
- **Preserved owner gates**: No public GitHub push, merge to default branch, external service mutation, credential change, or paid compute/API expenditure is permitted without Dillon's explicit per-action approval.

### 7.2 Staged Cutover Requirements
Before cutting over the personal Windows workspace or updating the Dell preview:
1. **Pre-cutover backup**: Run `harness/workspace-backup.mjs` (`RB-P11-A`) against a quiet snapshot of the workspace and verify the restored task count, event sequences, and receipt hashes in a separate disposable directory.
2. **Feature flag & UI fallback verification**: Confirm `BFE_UI=experience` serves the verified asset manifest (`harness/web-experience/asset-manifest.json`), `BFE_UI=legacy` remains functional as an immediate UI rollback switch, and `BFE_STAGING_RUNNER=0` is the default so unapproved runner routes stay closed.
3. **Entry-point and signature verification**: Record the exact Git commit SHA, `serverRevision` SHA-256 from `GET /api/health`, pinned external binary hashes (`OpenCode 1.18.34`, `llama-server`, `runner-bwrap`), and Windows Authenticode signature verification output for the desktop package.

### 7.3 Rollback Procedure
If any regression, unexpected route behavior, recovery hold anomaly, or desktop shell failure occurs during or after cutover:
1. **Immediate Runner / Route Rollback**: Set `BFE_STAGING_RUNNER=0` and revoke or disable any newly added provider connection in Settings -> Connections. Active or uncertain attempts transition to `interrupted` / `unresolved` hold so no automatic retry or duplicate charge can occur.
2. **UI Rollback**: Start the workspace service with `BFE_UI=legacy` to restore the prior verified interface without altering SQLite task records.
3. **Service & Binary Rollback**:
   - Stop the staged desktop or preview process cleanly (waiting for the write fence in `harness/desktop/service.cjs` to drain).
   - Check out the prior verified baseline commit (`7fc7bd8` or the last owner-approved checkpoint tag).
   - If a database migration ran, restore the pre-cutover SQLite backup verified in Section 7.2 into `.state/workspace.sqlite` and verify `GET /api/health` and `GET /api/receipts/analytics` before unlocking with `.state/access.key`.

---

## 8. Unreviewed STIG Cross-Reference and Gate Ledger

Tracking status: unreviewed planning note. This section records dependency order from `docs/STIG-READINESS-PLAN.md` and the completed review transcripts named below. It is not a STIG assessment, authorization to operate, penetration test, compliance score, or a new independent safety review. The STIG plan stays a separate document. It is not merged into sections 1 through 7, and no control is marked met.

The plan's own first line is `Planning status: NEEDS WORK`. Its source pin is commit `aad7a49f0e0f3ca6971b166b1e2e878832ed1744`. Sections 1 through 7 stay pinned to backlog baseline `7fc7bd8993c2080ce6dd460fb4b432325e91b7f1`. Neither pin includes the six reviewed package revisions or their follow-up commits. Those revisions are absent from this branch history.

Builder test counts quoted below are reports carried in the review prompts. The review transcripts say no tests ran. Those counts are not independent proof.

Re-review rule for every changed revision: after a fix is committed, the next evidence is one focused read-only review of that exact revision by Codex `gpt-6.2-sol` with `reasoningEffort` high, with no model or effort fallback and no paid compute. One review per revision. This tracking note does not launch it. A parent review does not cover a child commit.

### 8.1 STIG plan commit checked in this worktree

Checked on branch `work/t3-stig-readiness-plan` before this backlog section was committed:

| Check | Result |
| --- | --- |
| Worktree HEAD at the check | `729a40485f4173c9c7ec3599b6b11c677900d80b` |
| Subject | Add a STIG V6R5 readiness plan for the pinned source. |
| Parent | `aad7a49f0e0f3ca6971b166b1e2e878832ed1744` |
| Changed paths | `docs/STIG-READINESS-PLAN.md` added. No other path. |
| Blob | Working tree `docs/STIG-READINESS-PLAN.md` matched `HEAD:docs/STIG-READINESS-PLAN.md` (`d85fe0b559235625aff0f58c16b773c208a6b42e`). |
| Plan text read | Yes, for this cross-reference. This note does not re-review the plan. |

The plan says it did not recompute the readiness-summary archive or XCCDF hashes. This backlog note does not recompute them either. The summary figures copied by the plan are 286 checks: 34 CAT I, 230 CAT II, and 22 CAT III. CSV labels used by the plan: 25 source gap, 204 needs evidence, 55 likely not applicable, 2 source suggests met. Those labels are provisional source judgments. No compliance percentage is inferred.

### 8.2 RP dependency order

Design precedes code. Evidence documents can be collected. Code, product-executing fixtures, and regulated controls wait for the owner decisions in each item. This order is copied from the separate plan. Copying it does not approve implementation.

| Item | Depends on | Blocks | Release-backlog cross-reference, not a merge |
| --- | --- | --- | --- |
| RP-01 deployment and applicability decision | None | Regulated implementation inside RP-03, RP-04, RP-06, RP-08, and RP-10 | No wave item. Does not publish a compliance percentage. |
| RP-02 research runner stays disconnected | None | Browser connection of the isolated runner. Does not block personal session or audit design. | Same release constraint as Gates G1 through G5 (`RB-G01-A` through `RB-G01-R`) and the hold on `RB-S02-A`. Not one of the 25 source-gap rows. Does not re-verify inert Stop, replay, or patch-binding evidence. |
| RP-03 local session lifecycle | RP-01 before a regulated attempt limit. Personal idle and Lock design can be written first. V-222437 also waits for the RP-04 principal and the RP-05 log record. | Regulated lockout until RP-01 classifies the credential and selects that limit | No section 1 through 7 item. Session work must keep V-222580 and V-222581 as already implemented in the pinned source. The plan does not reopen those two rows. |
| RP-04 credential decision | RP-01 | A verifier or transport change. Supplies the actor name used by RP-05. | Not `RB-P07-A`. No hash replacement and no move of the access file until RP-01 and the owner approve it. |
| RP-05 security-event capture | RP-04 for the actor name. V-222445 also waits for RP-03 idle behavior. The audit schema may be drafted beside RP-03. | Fail-closed shutdown, or a written availability override, before code keeps serving after an audit write failure | Adjacent words in `RB-P02-A` are a different store. The approval review in section 8.6 does not close RP-05. |
| RP-06 transport, cookie flags, and hash modules | RP-01 and RP-04 | Changes to `Secure`, the listen address, and hashing | No wave item. Setting `Secure` on the current HTTP cookie is not the fix. The listener stays on loopback unless a later approved design says otherwise. |
| RP-07 separate control state from user data | RP-04, so the secret moves once | Live migration of an existing workspace | Adjacent to `RB-P11-A` data controls. Directory separation is not the backup module. |
| RP-08 IPv6 as a deployment profile | RP-01 and RP-06 | Non-loopback binding. Opening `0.0.0.0` or a public address is not a way to close V-222634. | No wave item. V-222635 stays in the RP-11 register and is a different row from V-222634. |
| RP-09 input-handling and fail-secure evidence | None for a static inventory. Executable tests need owner approval and disposable fixtures. | Nothing in the personal design sequence. Results stay evidence. | No wave item. The plan does not claim a vulnerability was found or ruled out. |
| RP-10 release and operations evidence | RP-01 for which regulated artifacts are required. Document collection can start. | Signing, backup drills, and cutover | Names the same neighborhood as `RB-P11-A`, `RB-P11-C`, and `RB-P12-R`. Those backlog items do not close the evidence rows. |
| RP-11 applicability register | RP-01 | Formal reliance on a likely-not-applicable label until an assessor confirms it | No wave item. The 55 likely-not-applicable checks stay provisional. |

Recommended sequence in the plan, which the plan does not grant:

1. RP-01 decision.
2. RP-02 remains closed for the life of runner qualification.
3. Personal designs for RP-03, RP-04, RP-05, and RP-06, reviewed before code.
4. Personal code for idle timeout, legacy Lock or legacy removal, secret-safe audit, and directory separation.
5. Regulated credential, TLS, FIPS, IPv6, identity, and governance work only where RP-01 includes them.
6. RP-09 and RP-10 evidence beside design. Executable tests, signing, and cutover stay gated.
7. RP-11 updated when the architecture adds SAML, WS-Security, PKI authentication, a new cryptographic mandate, or a multi-tier deployment.

### 8.3 Personal app versus conditional regulated owner decisions

Personal-app work is useful while CydeWorks remains one local operator on loopback. It still needs the owner's implementation approval. Conditional work starts only after the owner selects a DoD, DoW, or other regulated deployment and an assessor confirms applicability. The plan keeps both "DoD" and "DoW" because the source summary and CSV use both. Host file mode `0o600` and loopback binding stay useful local protections. They do not close a row whose CSV label is source gap or needs evidence.

| Item | Personal-app owner decision | Conditional regulated owner decision |
| --- | --- | --- |
| RP-01 | Name one local operator, one workspace, loopback HTTP, legacy UI by default, experience UI optional, research runner disconnected. | If regulated use is intended, name users, roles, data categories, host and network boundary, inherited controls, and the assessor. Record DoD, DoW, or both. Classify `access.key` as a password, a local key file, or something else. V-222542 and V-222543 stay open until that classification exists. |
| RP-02 | Keep the `pilot.mjs` disable throw. Decide later whether it is ever removed. Default is keep it. | Same hold. Regulated deployment does not by itself authorize browser connection. |
| RP-03 | Whether legacy ships. Whether the 15-minute idle rule is adopted. Lock is not Stop. Polling must not move the idle deadline. | Whether the access file is a password and the three-attempt, 15-minute limit is in scope, and how the only local operator recovers without a second always-valid secret in the repository or client. |
| RP-04 | Whether a personal local key file remains acceptable. Do not log the secret. Do not replace it with a hash until approved. | If an assessor treats it as a password: approved one-way storage, RP-06 protected channel, and the related identity, length, composition, PKI, display, embedded-authentication, and default-password evidence rows. A hash change without transport protection does not close V-222543. |
| RP-05 | Local principal name. Whether audit failure stops the listener. Retention period. Records omit the access file, cookie, terminal lease, and request body. | External collector only after its coverage is shown. Centralized shipping, review, protection, retention, and backup are evidence needs. A personal principal does not close organizational unique identity (V-222522). |
| RP-06 | Keep loopback HTTP, or approve local TLS. If HTTP remains, V-222576, V-222598, and V-222599 stay open for an assessment that requires TLS. | Whether FIPS validation is required. Node's default configuration is not that evidence. At-rest and transmitted-information rows follow the same decision. |
| RP-07 | Approve target directories. A later move of a real workspace needs its own approval. | No separate regulated start. The secret still moves only to the place RP-04 chooses. |
| RP-08 | Record IPv4 loopback as intentional. V-222634 stays open for an assessment that requires the DoW IPv6 profile. | Whether that profile applies. If it does, design loopback IPv6 with the RP-06 origin checks. `::1` and `127.0.0.1` stay loopback. |
| RP-09 | Which disposable checks are worth a later isolated test, and who may run them. | Same gate. No network scan is authorized by the plan. |
| RP-10 | Whether a signed Windows release is in scope, and where backups go. Threat-model note and software list can be written for the personal app. | Whether regulated governance documents are required. Classification markings, banners, and incident response are produced only for the deployment named in RP-01. |
| RP-11 | Keep the 55 likely-not-applicable IDs provisional. | Assessor confirmation before a formal package relies on a label. Seven CAT I rows in that register become active work only if the product adds the mechanism or tier they name. |

Approval gates that remain one owner action at a time, and that this section does not grant: credential or access-file changes, connected-service changes, paid usage, public push, merge to the default branch, deployment, live-preview cutover, and migration of an existing workspace database.

### 8.4 Twenty-five provisional source gaps

The plan assigns each of the 25 CSV source-gap IDs to one primary work item. Severities below are the CSV check severities, not independently demonstrated exploit severities. CAT I source gaps are V-222432, V-222542, and V-222543. CAT III source gaps are V-222392 and V-222437. The other 20 are CAT II.

| Work item | IDs | Count |
| --- | --- | ---: |
| RP-03 session lifecycle | V-222389, V-222391, V-222392, V-222432, V-222437 | 5 |
| RP-04 credential architecture | V-222542, V-222543 | 2 |
| RP-05 audit capture | V-222441, V-222442, V-222443, V-222445, V-222449, V-222462, V-222464, V-222465, V-222468, V-222471, V-222477, V-222486 | 12 |
| RP-06 transport and hashes | V-222571, V-222576, V-222598, V-222599 | 4 |
| RP-07 control and user data | V-222626 | 1 |
| RP-08 IPv6 profile | V-222634 | 1 |
| Total |  | 25 |

Full requirement text and the source lines read at `aad7a49` stay in the STIG plan. They are not restated here and are not accepted as closed.

### 8.5 Evidence packages for the 204 needs-evidence rows

Each ID appears once in the STIG plan. These rows are not restated as source gaps, and they are not copied into a second register here. Package totals below were read from that plan: 57 + 62 + 9 + 19 + 10 + 47 = 204.

| Package | Count | Owned with | CAT I members named by the plan |
| --- | ---: | --- | --- |
| Audit and logging | 57 | RP-05 | None named in the package summary |
| Identity, session, and access evidence | 62 | RP-03 and RP-04 | V-222425, V-222430, V-222522, V-222536, V-222551, V-222554, V-222577, V-222578, V-222642, V-222662 |
| Cryptography and transmission evidence | 9 | RP-06 | V-222588, V-222589, V-222596 |
| Input handling and fail-secure evidence | 19 | RP-09 | V-222585, V-222601, V-222602, V-222604, V-222607, V-222608, V-222609, V-222612 |
| Availability and recovery evidence | 10 | RP-10 | None named in the package summary |
| Governance, release, and data-management evidence | 47 | RP-01 and RP-10 | V-222643, V-222658, V-222659 |

The full ID lists remain only in `docs/STIG-READINESS-PLAN.md`. Tracking a package does not close V-222652 or any other row.

### 8.6 NEEDS WORK ledger for the six reviewed revisions

Each transcript below was read through `t3_thread_read`. Each review branch tip matches the reviewed commit. The reviewer identity in every transcript is Codex `gpt-6.2-sol` with `reasoningEffort` high. No tests were run in those static reviews. Browser and release approval were outside every verdict. Earlier threads cited inside those transcripts were not read again for this note.

Integration of all six reviewed revisions stays held. Sections 4 and 6 still describe the original unstarted scopes. They are not a current acceptance status for these revisions.

#### Patch binding, `RB-G01-D` helper

- Reviewed commit: `57068451a6e38ea21d27dcf86c5978a4e5ac698e`
- Parent: `526e33ec1d0d59447c5726317eb221b7d9b4d95f`
- Subject: Resolve claimId from host-owned store and document verifier trust boundary
- Branch and worktree: `review/t3-patch-5706845` at `C:\Users\epbal\Documents\Codex\2026-11-10\name-this-chat-bfe-harness-2\work\cydeworks-canonical-source\work\review-patch-5706845`
- Transcript: [CydeWorks patch focused independent review 5706845](t3-thread://v2/128ef247-4f3b-4453-9010-34f041b0c658/mcp:35cc5c4e-b80d-4409-b218-e3a60f6e4bcc)
- Completed: 2026-11-19T05:05:19.578Z
- Verdict: NEEDS WORK
- High blocker: host provenance remains an integration blocker. The helper compares a `claimId` lookup with the supplied scope, digest, and case count, but the only resolver in that checkout is a test fixture over a synthetic journal. Verifier evidence still enters as a caller-supplied object. Integration needs a host-controlled claim store and a verifier channel outside candidate control.
- Medium blocker: `provenanceEnforcedByCaller: true` is unconditional and overstates verifier provenance.
- Transcript says closed by static inspection: the new regression rejects a self-consistent substituted claim with matching forged verifier evidence when `approvedCases` is omitted. Earlier Git replacement, default scratch guard, and exact staged-file findings stay closed in that inspection. Closure still depends on an independently protected resolver, which this commit does not establish.
- Builder count, reported only: 7/7 focused tests.

#### Inference broker settlement

- Reviewed commit: `dc46ab2241ed8308393f5eb2eb7fe5c436f06880`
- Parent: `4ed0dd156e87ecd516dfa1c2816a6934a085dc89`
- Subject: Address Codex review findings on broker settlement evidence and memory bounds
- Branch and worktree: `review/t3-broker-dc46ab2` at `C:\Users\epbal\Documents\Codex\2026-11-10\name-this-chat-bfe-harness-2\work\cydeworks-canonical-source\work\review-broker-dc46ab2`
- Transcript: [CydeWorks broker focused independent review dc46ab2](t3-thread://v2/128ef247-4f3b-4453-9010-34f041b0c658/mcp:7cbd8318-9454-4a83-9b86-b9e4baa32240)
- Completed: 2026-11-19T05:05:35.300Z
- Verdict: NEEDS WORK. Hold broker integration.
- High blocker: per-choice settlement is only partial. SSE can combine terminal reasons across different completion IDs and settle a two-choice request.
- Medium blocker: the 4 MB observation budget does not charge retained SSE event names. The transcript describes nearly 16 MiB retained across 64 paused streams while `observationBytes` stays at zero.
- Low blocker: overflow dispatches are counted twice while active (`inFlight` and `unknown` together).
- Transcript says closed by static inspection: CR, LF, and split CRLF handling, including late errors after `[DONE]`; `observation-limit-exceeded` and `response-truncated` labels; zero dispatch remains distinct; socket closure leaves model cancellation unverified.
- Tests: the transcript says the updated tests were UNRUN. An earlier builder 20/20 count is an attributed report, not proof for this revision.

#### Approval audit, `RB-P02-A`

- Reviewed commit: `f1efdfaa6e43ef8e36f8e86503a37519a2c42eb9`
- Parent: `f7411512fbdc73d95e0137ec816290960a165ddd`
- Subject: Harden RB-P02-A approval scope, root containment, crash hold, and audit triggers
- Branch and worktree: `review/t3-approval-f1efdfa` at `C:\Users\epbal\Documents\Codex\2026-11-10\name-this-chat-bfe-harness-2\work\cydeworks-canonical-source\work\review-approval-f1efdfa`
- Transcript: [CydeWorks approval focused independent review f1efdfa](t3-thread://v2/128ef247-4f3b-4453-9010-34f041b0c658/mcp:3e656d82-cba1-427a-bca5-e1625c72c815)
- Completed: 2026-11-19T05:06:12.035Z
- Verdict: NEEDS WORK. Hold `RB-P02-A` out of server wiring (`RB-P02-B`).
- High blocker: crash-hold release can proceed without proof that the original worker stopped. Lease acquisition can replace an active owner, and release trusts caller-supplied exit flags or a syntactically valid receipt digest.
- High blocker: dispatch scope is complete in shape only. `currentScope` is accepted from the caller. The two-connection test is sequential and uses local counters.
- High blocker: Lock leaves an issuance race. `revokeSession` revokes grants already present, so issuance can still accept the same session ID after Lock.
- High blocker: root checks can accept a different directory at the same path. The grant binds path strings and a stored revision.
- Medium blocker: SQLite integrity is partial. Claim phase and recovery state remain writable outside allowed transitions. `CREATE TABLE IF NOT EXISTS` leaves an `f741151` database without the new columns. Replacement writes were uncovered.
- Builder counts, reported only: 18/18 focused and 295/296 full-suite, with the remaining failure attributed to the inherited environment. Independent runtime evidence was pending in the transcript.

#### Project context, `RB-P08-A`

- Reviewed commit: `79d0fff0693c6f06bb8f6b367e4cba2c81af9d60`
- Parent: `aad7a49f0e0f3ca6971b166b1e2e878832ed1744` (sibling of the STIG plan commit, not an ancestor of this branch)
- Subject: Add RB-P08-A offline project context and skill library
- Branch and worktree: `review/t3-context-79d0fff` at `C:\Users\epbal\Documents\Codex\2026-11-10\name-this-chat-bfe-harness-2\work\cydeworks-canonical-source\work\review-context-79d0fff`
- Transcript: [CydeWorks context focused independent review 79d0fff](t3-thread://v2/128ef247-4f3b-4453-9010-34f041b0c658/mcp:d66f7581-78ee-4d49-a65b-e5e43214b938)
- Completed: 2026-11-19T05:06:00.424Z
- Verdict: NEEDS WORK. Hold `RB-P08-A` integration.
- P1 blocker: version reuse can approve replacement content under an older version label because `expectedDigest` is optional, and a template pin follows that label.
- P2 blocker: four permitted 64 KiB entries can exceed the shared hasher's 256 KiB input after framing, so a valid selection can fail to preview.
- P2 blocker: `sourceHash` is a caller claim outside the approval digest.
- P2 blocker: template eligibility and preview sample the clock separately, so one draft can mark an entry eligible and then exclude it as expired.
- P2 blocker: template and selection validation can invoke caller-supplied JavaScript on arrays.
- Transcript limits: explicit selection, project-scoped lookup, immediate revocation, ordinary version-change invalidation, deterministic ordering, and input-only templates were present for the fixtures inspected. No prior `RB-P08-A` finding record was in that checkout. A trailing blank line was flagged at `harness/project-context.test.mjs` line 843.
- Builder counts, reported only: 11/11 focused and 298/299 full-suite, with the remaining failure attributed to the inherited environment.

#### Workspace backup, `RB-P11-A`

- Reviewed commit: `0f24c02ac1f4af66cfe9474bce98f92392635a6e`
- Parent: `c907420ec4cdc4c8ab7d287870ab3e7df8ae81be` (subject: Add offline workspace SQLite backup and restore verifier (RB-P11-A); parent `ee6b4a161453d104273dba76a73e211887f6fc2e`)
- Range named by the review prompt: `ee6b4a1..0f24c02`, which contains both commits above. This note checked that range with `git log`. It did not re-review the patches.
- Subject of the reviewed tip: Harden workspace backup destination rollback and document consistency limits
- Branch and worktree: `review/t3-backup-0f24c02` at `C:\Users\epbal\Documents\Codex\2026-11-10\name-this-chat-bfe-harness-2\work\cydeworks-canonical-source\work\review-backup-0f24c02`
- Transcript: [CydeWorks backup independent review](t3-thread://v2/128ef247-4f3b-4453-9010-34f041b0c658/mcp:4661229a-960a-4086-8a90-e7eeba7f510a)
- Completed: 2026-11-19T04:54:39.940Z
- Verdict: NEEDS WORK. `RB-P11-A` does not meet acceptance.
- High blocker: rollback can delete another writer's file. Exclusive create protects the first open, then unlink uses the recorded pathname.
- High blocker: source and restore reads can escape the checked tree or publish different bytes from the bytes that were hashed.
- High blocker: credential exclusion is filename-based. Ordinary artifacts and the full SQLite snapshot, including deleted pages, can retain secrets. The manifest discloses database retention. Disclosure is not the acceptance requirement to select eligible fields.
- Medium blocker: partial failure can leave output with an ambiguous status because rollback suppresses deletion errors and cleanup can mask the original error.
- Medium blocker: a self-consistent SQLite database with no `tasks` table can pass. Cross-store consistency stays unknown. Standalone inventory is not a single read transaction and needs its own consistency status.
- Builder count, reported only: 9/9, matching five backup tests, two export tests, and two removal tests in source. The transcript had no run transcript tied to this HEAD.

#### Disconnected synthetic verifier

- Reviewed commit: `a2394a15c86bd3458671af6a64d1078eb9c26e0f`
- Parent: `9539ace75161338b4304e9a9f86afbf1bc541448`
- Subject: Add disconnected allowlisted AST verifier for fixed synthetic fixture
- Branch and worktree: `review/t3-verifier-a2394a1` at `C:\Users\epbal\Documents\Codex\2026-11-10\name-this-chat-bfe-harness-2\work\cydeworks-canonical-source\work\review-verifier-a2394a1`
- Transcript: [CydeWorks verifier independent review](t3-thread://v2/128ef247-4f3b-4453-9010-34f041b0c658/mcp:b5f46640-0884-427d-90b9-99872507b163)
- Completed: 2026-11-19T04:54:25.773Z
- Verdict: NEEDS WORK. General code execution and browser integration stay unapproved.
- High blocker: a passing attestation can misrepresent the checked Python files because decoding, local binding, and exception-target cleanup differ from Python.
- High blocker: attestation shape does not establish provenance. The result copies caller claim ID and base revision. `trusted: true` can validate without `caseResults`. The consumer at `aad7a49` also accepts the trust flag and makes `results` optional.
- High blocker: the directory reader checks a path, then opens by pathname, so a concurrent replacement can invalidate the check. There is no deadline on a blocking open or read.
- Medium blocker: the interoperability test targets the older helper contract and is incompatible with `aad7a49`, where `validateBoundScope` requires nested `claim.scope`.
- Medium blocker: module initialization runs before the per-case error boundary, and the CLI does not catch those exceptions.
- Transcript limits: no direct candidate execution was found in the AST evaluator. The case vector matches `pilot.mjs` by inspection. Twelve fixed observations do not establish general fixture behavior. Incomplete evidence, wall-clock isolation, and end-to-end patch binding stay unqualified.
- Builder counts, reported only: 14/14 verifier, 6/6 parser, and 3/3 pilot. The interop test can skip when Node or Git is unavailable, so the reported count does not establish compatibility with `aad7a49`.

### 8.7 Follow-up commits whose re-review evidence is missing

Each reviewed commit has exactly one child on a separate work branch. `git merge-base --is-ancestor` showed each child is a descendant of its reviewed parent and that none of these twelve commits is an ancestor of `729a40485f4173c9c7ec3599b6b11c677900d80b`. No local branch named `review/*` points at a child. This note read each child's commit id, parent, subject, author date, and `git diff-tree --name-status` output. It did not read the patch bodies, did not run tests, and did not read a completed re-review thread for any child. Commit subjects are labels, not evidence that a blocker is closed.

Author dates are UTC-7. Each child is later than the review completion time in section 8.6.

| Reviewed parent | Follow-up commit, not reviewed | Branch tip | Author date | Paths in the commit | Subject label, not a finding closure |
| --- | --- | --- | --- | --- | --- |
| `57068451a6e38ea21d27dcf86c5978a4e5ac698e` | `162c2f8aacf34397ba1ec725416c1a1dd270161e` | `work/t3-verified-patch-binding` | 2026-11-18T22:11:40-07:00 | `research/isolated-runner-20261118/verified-patch.mjs`, `research/isolated-runner-20261118/verified-patch.test.mjs` | Remove unobserved provenanceEnforcedByCaller claim and reject untrusted verifier flag |
| `dc46ab2241ed8308393f5eb2eb7fe5c436f06880` | `5366dde492b7f8428801059ea5ad13575858eac2` | `work/t3-broker-settlement-evidence` | 2026-11-18T22:12:40-07:00 | `harness/inference-broker.mjs`, `harness/inference-broker.test.mjs` | Address re-review findings on SSE ID consistency, event memory bounds, and overflow accounting |
| `f1efdfaa6e43ef8e36f8e86503a37519a2c42eb9` | `26aec86f68cf7ee365ac7c6be23ef2c3ed3744fe` | `work/t3-pkg02-approval-audit` | 2026-11-18T22:19:19-07:00 | `harness/approval-audit.mjs`, `harness/approval-audit.test.mjs`, `harness/workspace-projects.mjs` | Address RB-P02-A approval hardening review findings |
| `79d0fff0693c6f06bb8f6b367e4cba2c81af9d60` | `2e7f7f213a99cdd6876e2b87ed8da8e10fd474af` | `work/t3-pkg08-project-context` | 2026-11-18T22:14:00-07:00 | `harness/project-context.mjs`, `harness/project-context.test.mjs` | Harden project context revisions, digests, preview budget, and dense arrays |
| `0f24c02ac1f4af66cfe9474bce98f92392635a6e` | `beffebd7e3bd3080392aec97258e3d2076f8a774` | `work/t3-pkg11-workspace-backup` | 2026-11-18T22:04:47-07:00 | `harness/workspace-backup.mjs`, `harness/workspace-backup.test.mjs` | Address Codex backup review: fail closed on unsafe publish/raw paths, bind handle identities, and enforce workspace schema |
| `a2394a15c86bd3458671af6a64d1078eb9c26e0f` | `29bb54a05134c357c81817936a0ae91662238995` | `work/t3-trusted-fixture-verifier` | 2026-11-18T22:04:44-07:00 | `research/isolated-runner-20261118/protected-fixture-verifier.py`, `research/isolated-runner-20261118/test_protected_fixture_verifier.py` | Harden protected synthetic fixture verifier provenance and Python parity |

The patch follow-up subject names the unconditional provenance field and an untrusted verifier flag. That subject does not mention the High host-owned store and out-of-band verifier channel. Even if it did, this note would not treat the subject as closure. Each of the six children still needs its own single Codex `gpt-6.2-sol` high re-review after the fix commit. Those reviews were not launched here.

### 8.8 Limits of this ledger

- Sections 1 through 7 were left in place, including their `7fc7bd8` baseline and their original "can run now" wording.
- No target code, test, live runtime, credential, network call, install, setting, MCP server, browser session, push, or merge was used to produce this section.
- Peer worktrees were not checked out, edited, or merged.
- `docs/STIG-READINESS-PLAN.md` was not edited.
- This section does not authorize RP implementation, Wave 2 server wiring, browser staging, or removal of the pilot disable throw.
