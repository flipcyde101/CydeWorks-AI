# Lock validation checkpoint

Snapshot at 2026-11-19 09:16 UTC. Recheck live thread state and heads before acting.

## Ownership and candidate

- Coordinator accepted local integration ownership at clean `9d3ce337897a44b1b7192296a4c4a87fed1dd3` on `work/t3-runner-integration`.
- Grok Lock thread `mcp:11e94414-5fd8-4bfe-9666-f3d0a5befa32` completed runs 6 and 7. Clean final head: `8dcd5e2b6b0ff3c2e9992bb9af478c2094341203`; preceding correction: `444a040a602cf6e6ee4ac869602dac74c620010a`.
- Builder worktree and branch remain preserved. No source was copied or integrated by this pass.

## Independent synthetic validation

Exact final candidate: 61 tests passed, 0 failed, 0 skipped; duration 30.8 seconds.

Test files: `session-lock.test.mjs`, `terminal-control.test.mjs`, `terminal-api.test.mjs`, `recovery.test.mjs`, `first-usable-api.test.mjs`, `desktop-bootstrap.test.mjs`, `desktop-service.test.mjs`.

Existing local image `8602f5dfacbe`, Node 26.12.1. Probe verified nonroot UID 1000, loopback-only interfaces and no external route, zero capabilities, no-new-privileges, read-only source and toolchain, allowlisted PATH/HOME/TMPDIR only. Container limits: 1 GiB, 128 PIDs, 2 CPUs. Scratch was container-only tmpfs at `/tmp` and `/src/work`; source files were read-only. Tests ran serially with a 40-second per-file test limit and 70-second overall process limit. No image pull, live worker, inference or browser was used.

These are Linux synthetic protocol/controller results, not Windows or browser execution proof. Full harness suite has not been rerun for this candidate.

## Independent review

One read-only review submitted through native T3 delegation, exact provider `codex`, model `gpt-6.2-sol`, option `reasoningEffort=high`, echoed by T3. Task ID: `node:delegated-task:command%3Amcp%3Af372787b-9137-42d2-b8f2-228b0c36ec67%3Adelegate-task%3Acydeworks-lock-8dcd5e2-sol-high-20261119`.

Review received the actual `93193ab..8dcd5e2` diff, acceptance criteria, exact test evidence and platform limits. Verdict pending. Do not integrate until addressed. If a defect is found, preserve the branch and return it once to its original owner. No automatic review chain.

## Separate UI wiring plan

Lock runs are terminal, but wiring must wait for the security review and integration decision. Then use one separate worktree from the exact reviewed integration commit, proposed branch `work/t3-progress-ui-wiring-20261119`. Do not reuse the Lock builder checkout.

Scope the smallest initial wiring to the Legacy progress presentation and its controller-level synthetic tests. Confirm ownership of `harness/web/app.js` and relevant assets before dispatch; leave the helper and presentation library owned files unchanged unless explicitly reassigned. Consume the validated presentation contract, retain session epochs and Lock concealment, use truthful measured units and withheld ETA, safe local diagnostic summaries, accessible status announcements and focus behavior. Keep output UTF-16 measurements distinct from work counters.

Validate synthetic active, waiting, stale/stalled, failed, complete, missing counters, zero remaining, delayed response after Lock and safe error display. Use the verified offline sandbox, update asset hashes if needed, and perform the applicable focused/full tests and one risk-proportionate review before integration. This plan does not authorize actual runner telemetry or browser staging.

## Unchanged gates

Trusted host creation, durable replay, Windows Stop/recovery, sealed handoff, write-back and browser qualification remain open. Backup `cfc219d` remains unintegrated, with 11 parent tests, archive-residue and Windows limits; it cannot restore a full workspace. Sealed handoff `a5b69ee` remains unqualified for same-user scratch, Windows/drvfs, provenance, replay and write-back.

No paid/API fallback, push, default-branch merge, publication, deployment, credential/service changes or live cutover. Quota holds remain evidence-based. No provider failure occurred during this pass.
