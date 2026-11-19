# CydeWorks AI roadmap checkpoint

This checkpoint captures the November 18, 2026 local handoff. Verify the current code and evidence before relying on a dated status.

## Verified scope

- The existing Dell preview supports a scoped source brief or single-file proposal workflow. Receipt repair was exercised against four saved receipts and five attempts, and the workspace suite passed 288 tests.
- A standalone isolated OpenCode and local Qwen pilot passed 18 boundary checks against a disposable synthetic repository. Its two-file candidate passed 12 behavior checks and the patch applied cleanly to the pinned baseline. This is evidence for that pilot, not general repository execution.
- The pilot's source is in `research/isolated-runner-20261118/`. Its original local run artifacts and runtime dependencies are not part of this source snapshot.

The November 18 runner reviews identified limits in the pilot's evidence. Its Linux-side Stop probe does not prove that a Windows Stop ended the actual worker tree. The candidate can also influence the check-result channel, so the reported passing cases are not sufficient evidence of a protected verifier. Treat the pilot as research until those findings and the recovery gaps are addressed and tested.

## Project handoff and reference material

- [Detailed implementation and reuse plan](superpowers/plans/2026-11-18-cydeworks-ai-feature-and-reuse-plan.md)
- [Dependency-ordered release backlog](RELEASE-BACKLOG.md)
- [Runner qualification and browser rehearsal plan](NEXT-WAVE.md)
- [Project specification](../outputs/Project%20Spec.md) and [completion requirements](../outputs/BFE%20Harness%20Completion%20Plan.md)
- [Earlier implementation handoff](../outputs/BFE%20Harness%20Implementation%20Handoff%202026-11-14.md)

These documents are historical planning references, not evidence of the current checkout's behavior. Some historical local evidence was not imported. Runtime state, logs, receipts and credentials remain outside the repository.

## Next gates

The Windows controller has stopped an inert child in the pinned Bubblewrap fixture. The recovery evidence so far covers a separate inert WSL fixture. The standalone patch verifier reproduced the checked bytes from a disposable Git base in its focused tests. The actual worker, protected result source, and integrated proposal path still require qualification and independent review.

1. Verify Windows-initiated Stop against a disposable worker and its descendants, including repeated and stale requests. Keep uncertain outcomes unresolved.
2. Verify controller restart recovery and request replay without duplicate execution. Record worker identity, outcome, and evidence.
3. Validate and address the review findings on timeout handling, test-result integrity, and binding the checked candidate to the final patch.
4. Only after those gates pass and receive independent review, integrate the runner behind an off-by-default switch in a disposable staging workspace. Verify approval, diff review, and a version 2 receipt in the browser.
5. Continue the broader plan for scoped projects and approvals, model and provider choice, usage and receipts, terminal continuity, reusable context, multi-agent coordination, backup and recovery, accessibility, and a signed Windows release.

Do not cut over the existing live preview, broaden repository access, publish, or change accounts or security settings without the owner's specific approval. Preserve the separate original workspace and its historical evidence during source reconciliation.
