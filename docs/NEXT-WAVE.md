# CydeWorks AI Next Bounded Workwave Plan

This plan establishes the architecture and execution sequence for browser staging of repository changes and the isolated runner. It is grounded in `docs/ROADMAP.md` (November 18, 2026 checkpoint), the detailed implementation plan (`docs/superpowers/plans/2026-11-18-cydeworks-ai-feature-and-reuse-plan.md`), and the current application codebase in `harness/`.

## 1. Context and Baseline

The verified starting baseline includes:
- The Dell browser preview runs against the Node 24 workspace service (`harness/server.mjs`) backed by SQLite (`.state/workspace.sqlite`).
- The test suite verified 288 tests across workspace operations, receipt analytics, session locking, route binding, and contributor APIs.
- The browser interface (`harness/web-experience/`) provides an access-key unlocked workspace, route inventory inspection, scoped proposal workflows, read-only terminal observation, and version 2 receipt exports.
- A standalone research pilot (`research/isolated-runner-20261118/`) demonstrated an isolated OpenCode and local Qwen worker against a synthetic two-file repository (`limits.py`, `measurement.py`).

The November 18 runner reviews identified critical gaps in the pilot:
1. Process lifecycle: The Linux-side Stop probe does not prove that a Windows-initiated Stop terminates the worker process tree and all its descendants.
2. Channel integrity: The candidate under test can influence the check-result communication channel, meaning reported passing checks do not prove a protected verifier.
3. Recovery gaps: Controller restart recovery, handling of repeated or stale requests, and cryptographic binding of the verified candidate to the final patch remain unverified.

Until those defects are remediated and pass an independent safety review, connecting live runners or unconfined tools to the browser experience is strictly prohibited.

## 2. Browser Connection Safety Gate

Live runner connection to the browser experience is gated on four prerequisite verification items:

1. Windows-initiated Stop verification:
   - Prove that aborting or stopping from the Windows host terminates the worker process, any intermediate shells or runners, and all descendant processes.
   - Handle repeated, concurrent, and stale Stop requests deterministically.
   - Keep any uncertain or unverified termination outcomes explicitly marked as unresolved, preventing premature retry.

2. Controller restart recovery and replay safety:
   - Verify that restarting the host service or dropping connection during an active attempt leaves the durable attempt in an interrupted or unresolved state.
   - Verify that request replay with an identical request identifier returns the existing submission outcome without duplicate dispatch or charging.

3. Protected verifier and patch binding:
   - Isolate the verifier output channel so that candidate code cannot spoof, alter, or suppress test failure signals.
   - Enforce timeouts independently of worker cooperation.
   - Cryptographically bind the candidate files that passed verification to the exact patch presented for human review.

4. Independent safety review:
   - A dedicated, independent security and safety review must sign off on the process confinement, verifier isolation, and credential boundaries before any live worker connects to the browser.

## 3. Off-by-Default Loopback Staging Architecture

To allow safe iteration and verification of the user experience without exposing the system to live runner risks, CydeWorks will use the smallest off-by-default loopback staging approach using an inert synthetic fixture.

### 3.1 Off-by-Default Switch and Loopback Isolation
- The staging capability is controlled by an environment flag: `BFE_STAGING_RUNNER=0` by default.
- When disabled (the default), staging routes and models are completely omitted from route inventory and task submission rejection paths.
- Network confinement is strictly preserved: the service binds only to `127.0.0.1`, validates origin and host headers, enforces SameSite cookies, and rejects cross-origin requests.

### 3.2 Inert Synthetic Fixture
- An adapter (`harness/providers/synthetic-runner-fixture.mjs`) acts as an inert synthetic runner.
- It executes entirely in-memory within Node without spawning WSL, bash, Python, or external processes.
- It uses static, pinned fixture files (the synthetic `limits.py` and `measurement.py` baseline and replacement pair) to simulate candidate generation and check execution.
- It emits sequence-numbered progress and terminal events with realistic timing (via deterministic timer ticks) to exercise the frontend observation layer safely.

### 3.3 Authoritative Scope and Approval
- Follows the existing server approval contract (`POST /api/tasks/:id/run` in `harness/server.mjs` and `harness/web-experience/logic/approval.js`).
- The operator reviews:
  - Exact source snapshot hash (`sourceHash`).
  - Proposed request and expected result criteria.
  - Staged route details (engine: `fixture`, destination: `127.0.0.1 loopback`, cost: `Synthetic. No model ran`).
- Dispatch requires ticking the approval checkbox, binding `sourceHash`, `routeRevision`, and model identity into an immutable attempt record with a unique `scopeHash`.

### 3.4 Read-Only Observation, Detach, and Reattach
- Uses `harness/terminal-control.mjs` to govern terminal state:
  - Default view: Terminal renders in read-only mode (`owner: 'None'`).
  - Take control: An operator may take control, establishing a short-lived lease (15-second timeout, 5-second heartbeat) with an incremented ownership generation.
  - Detach: The operator can click Detach, which revokes the local lease and sets the view to detached while the synthetic worker continues running in the background.
  - Reattach: Clicking Reattach reconnects the view to the active attempt in read-only mode, validating that the attempt ID and generation match, and replaying bounded terminal output without taking a writer lease.
  - Stop: The operator can issue a confirmed Stop, terminating the synthetic run and transitioning the attempt to cancelled status.

### 3.5 Proposal Review and Safe Application Boundary
- Upon completion, the task transitions to `review` status.
- The review panel renders:
  - Proposal summary and replacement content.
  - Unified multi-file diff (`limits.py` and `measurement.py`).
  - Structural validation checks and verifier test outcomes.
  - Human acceptance control: Accept, Edit proposal (revising content and invalidating old checks), or Reject.
- Safety invariant: Accepting a proposal does not modify files in the working directory or git worktree. It unlocks an explicit, confirmed download of the patch artifact.

### 3.6 Version 2 Receipt Export
- Once an attempt concludes, `GET /api/tasks/:id/receipt` produces an authoritative export via `exportReceipt(task)` adhering to `cydeworks.run-receipt-export` version 2 (`RECEIPT_EXPORT_VERSION = 2`).
- Envelope contents include:
  - Run metadata: task ID, attempt ID, status (`succeeded`, `failed`, or `cancelled`).
  - Evidence: synthetic token and step usage (`evidence: 'synthetic'`), recorded elapsed time, and engine details.
  - Cost: zero or unknown charge indicator (`chargeEvidence: 'unavailable'`).
  - Contract limits: explicit statement of unverified synthetic boundaries.
- All envelope checks in `harness/receipt-contract.mjs` must pass validation.

## 4. Next Bounded Workwave Plan

The remaining wave starts in the research worktree. After the runner fixes and tests, record the independent safety review. Browser staging begins only if that review and the lifecycle and verifier evidence pass. The first browser rehearsal uses the inert fixture. Any later connection to the actual worker also requires proof for that worker path.

### Milestone 1: Runner Core Fixes and Verifier Hardening (Offline)
- Scope: Work exclusively in `research/isolated-runner-20261118/` and new test suites.
- Objectives:
  1. Implement robust Windows process tree termination for the guest runner using Windows Job Objects or equivalent kernel-level hierarchy termination.
  2. Isolate the verifier output channel: candidate code cannot write to the verifier pipe, modify test definitions, or forge exit codes.
  3. Validate crash recovery and stale request rejection in `recovery.mjs`.
  4. Implement cryptographic binding between the verified candidate tree and the generated patch.
- Tests: `research/isolated-runner-20261118/pilot.test.mjs`, `harness/recovery.test.mjs`.

### Milestone 2: Inert Synthetic Staging Adapter and Harness Wiring
- Scope: Implement the mock staging provider in `harness/providers/` and connect it behind the off-by-default environment switch.
- Objectives:
  1. Add `BFE_STAGING_RUNNER` configuration gate (defaulting to false).
  2. Implement `harness/providers/synthetic-runner-fixture.mjs` matching the runner interface: start, sequence events, inspect, stop, and collect.
  3. Wire the synthetic staging route into route inventory only when `BFE_STAGING_RUNNER=1`.
  4. Ensure zero disruption to standard preview execution and existing tests.
- Tests: `harness/route-inventory.test.mjs`, `harness/route-binding-api.test.mjs`, new `harness/synthetic-staging.test.mjs`.

### Milestone 3: End-to-End Browser Staging Rehearsal
- Scope: Validate the full browser staging loop using the inert synthetic fixture.
- Objectives:
  1. Exercise draft creation, route selection, and scope approval for a multi-file synthetic change.
  2. Verify terminal rendering, progress steps, Detach action, and read-only Reattach.
  3. Verify confirmed Stop behavior and recovery status display.
  4. Review the candidate proposal: inspect multi-file diff, verify checks, and accept proposal.
  5. Export and validate the version 2 receipt envelope.
- Tests: `harness/receipt-endpoint.test.mjs`, `harness/terminal-control.test.mjs`, `harness/run-submission-api.test.mjs`.

## 5. Objective Completion Criteria

Each milestone has clear, unambiguous completion criteria:

1. Milestone 1 Completion Criteria:
   - [ ] Windows Stop test terminates worker process tree and child processes within the test’s documented deadline.
   - [ ] Injected candidate attempting to write to verifier stdout/stderr fails and is recorded as a failed check.
   - [ ] Controller restart leaves active claim in an explicit unresolved recovery hold.
   - [ ] Verified candidate tree hash strictly matches the base plus unified patch hash.

2. Milestone 2 Completion Criteria:
   - [ ] `npm --prefix harness test` passes 100% of existing 288 tests with `BFE_STAGING_RUNNER=0`.
   - [ ] When `BFE_STAGING_RUNNER=0`, staging routes return 404/ineligible and do not appear in `GET /api/models`.
   - [ ] When `BFE_STAGING_RUNNER=1`, synthetic staging route appears in `GET /api/models` with `readiness.eligible === true` and explicit synthetic labels.
   - [ ] Synthetic adapter completes start, progress event streaming, and proposal generation without spawning external processes.

3. Milestone 3 Completion Criteria:
   - [ ] Approval workflow validates exact sourceHash and binds immutable `scopeHash`.
   - [ ] Terminal Detach releases lease; Reattach reconnects in read-only mode with matching generation.
   - [ ] Review panel displays the multi-file diff and structural checks with "Nothing applied" status.
   - [ ] `GET /api/tasks/:id/receipt` returns an envelope where:
     - `format` is `cydeworks.run-receipt-export`.
     - `formatVersion` is `2`.
     - `available` is `true`.
     - `evidence.usage` is marked as synthetic.
     - `validateReceiptExport(envelope).ok` evaluates to `true`.

4. Prerequisite Safety Gate Criteria:
   - [ ] Independent reviewer inspects Milestone 1 test logs, boundary definitions, and verifier channel code.
   - [ ] Formal sign-off recorded before any live runner or WSL integration is merged or exposed to browser controls.
