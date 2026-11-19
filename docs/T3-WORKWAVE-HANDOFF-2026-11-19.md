# CydeWorks T3 workwave handoff

Snapshot for the November 19 workwave. This is a local development checkpoint, not a release or security authorization. Recheck live thread state and branch heads before acting.

## Later status update

The sections below preserve an earlier snapshot. The owner's goal has since been resumed and was confirmed active. The current operational hold applies to all new full-access T3 coding or target-execution assignments, not only Cursor. Two workers reported processing target code on the Windows host contrary to the required offline sandbox. See [the dispatch rules](T3-DISPATCH.md) for the hold, current Claude quota status and safe reassignment process.

The owner chose a shared session across tabs in the same browser profile and allows downloads authorized before Lock to finish afterward. See [browser Lock requirements](T3-BROWSER-LOCK-REQUIREMENTS-2026-11-19.md). The previous Lock candidate and custom proof design remain held; the simpler cookie proposal is unreviewed and does not resolve service identity or copied-bearer risks.

After this earlier snapshot, the parent locally integrated disconnected attention, request-claims and synthetic-runner-fixture changes. The application suite passed 432 tests in the offline Linux sandbox on `d9c2aca6e337290bb3d852e6f388fd9aade8cd08`. Windows runner qualification and live browser staging remain open. Check the current integration branch and run evidence before relying on this snapshot.

## Source and routing

- Canonical repository: `C:\Users\epbal\Documents\Codex\2026-11-10\name-this-chat-bfe-harness-2\work\cydeworks-canonical-source`.
- Local integration worktree: `work\runner-integration-20261118`, branch `work/t3-runner-integration`.
- The parent integrated the disconnected Stop adapter, fail-closed legacy patch binder, progress helper, unwired progress presentation, approval module, fixed-fixture verifier and provisional brief evaluator. The last code checkpoint before this handoff update is `03a65100240518f1fc047d1a3837530f8151091b`.
- Follow [T3 dispatch rules](T3-DISPATCH.md). Use one writer per scope and Codex GPT-6.2 Sol High for independent review. Do not use paid fallback. The target-code execution hold applies across delegated full-access providers; read-only research remains available.
- The owner resumed the saved Codex goal after its earlier blocked status. Check the current goal before changing its status.

## Tested local candidates

- The disconnected OpenCode Stop adapter matched reviewed `70842ab`: Node 8/8 and Python 25 passed with 3 live tests skipped. Actual Windows Stop and recovery remain unqualified.
- The disconnected fixed-fixture verifier matched reviewed `1e6b352`: Node 8/8 and Python/interoperability 20/20. Trusted host creation and durable cross-process replay protection remain open.
- The disconnected approval module matched `41b4e77`: 16/16 isolated tests. Sol High verified the scoped source fixes at `310570a`; the later commit changed a test fixture only. Windows behavior and pathname handoff races remain open.
- The progress helper matched `858030b`: 25/25 isolated tests. It is imported by the Legacy interface; the new measured counters are not yet connected to live runner telemetry. Legacy still labels UTF-16 code units as characters.
- The unwired progress presentation and helper matched combined candidate `ebcbc78`: 9/9 and 25/25 isolated tests. Sol High reviewed earlier revisions; the parent checked the final formatter corrections after that review. Interface wiring and browser behavior remain unverified.
- The disconnected brief evaluator matched `cc9c8b7`: 35/35 isolated tests. Sol High reviewed earlier revisions; the parent checked the final empty-source correction after that review. Results remain provisional and require human semantic review.
- The legacy caller-trusted patch binder is fail-closed. Its regression failed before the fix and passed afterward in an isolated test.

## Active and held work

- **Session Lock:** `work/t3-stig-personal-session`, T3 thread `mcp:11e94414-5fd8-4bfe-9666-f3d0a5befa32`. The later candidate `f07ecc365758b070d831ec21610e4eb68a1b70c8` passed 70 synthetic tests but its focused review found four high-severity Lock and claim-lifecycle gaps. The thread is terminal; hold that implementation and do not infer live Windows or browser qualification.
- **Progress presentation:** `work/t3-progress-presentation-antigravity`, T3 thread `mcp:285bdd78-7235-4b87-b227-64c09b70e111`. The mapper is integrated in the local branch. A separate parent-owned wiring candidate is under test on branch `work/t3-progress-display-wiring-20261119`; its independent review and live browser behavior remain pending. Do not infer live runner telemetry from synthetic tests.
- **Brief evaluation:** `work/t3-brief-semantic-grok`, T3 thread `mcp:a0f3ce04-8c83-403a-8483-777d750313e1`. The correction at `cc9c8b7` holds all empty-source briefs outside the usable gate pending human review. Pattern scans do not establish factual truth.
- **Sealed handoff:** `work/t3-sealed-root-claude`, candidate `a5b69ee`. Parent checks passed Node 15/15 and Python 30/33, with 3 mount tests skipped. Claude reported the mount tests passing in its separate sandbox. Same-user mutation of materialization scratch, authoritative approval and provenance, replay, Windows/drvfs, write-back and live integration remain open. Do not connect it to the browser.
- **Redacted backup:** `work/t3-backup-redaction-claude`, T3 thread `mcp:76898af2-389f-4b8c-a199-22127865e3a3`. Sol High reviewed `9773eb8` and found that verification could leave unvalidated archive bytes in scratch and reported deleted-data residue too confidently. Claude's follow-up `cfc219d` passed 11 isolated tests; the parent checked that final delta after the review. Archive residue is still possible, Windows staging safety is unqualified, publication remains disabled, and this is not full workspace recovery. The candidate is not integrated.

## Release boundaries

Do not connect the runner to browser staging until the specified Stop, recovery, verifier and patch-binding gates have passed independent review. Do not merge to the default branch, publish, deploy, change credentials or connected services, spend beyond included usage, or perform live cutover without the owner's applicable approval. Run target-controlled tests only in a verified offline OS sandbox with read-only source/toolchain, scratch-only writes and resource limits. Report skipped tests and platform limits explicitly.
