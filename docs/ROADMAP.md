# CydeWorks AI roadmap checkpoint

This checkpoint captures the November 18, 2026 local handoff. Verify the current code and evidence before relying on a dated status.

## Verified scope

- The existing Dell preview supports a scoped source brief or single-file proposal workflow. Receipt repair was exercised against four saved receipts and five attempts, and the workspace suite passed 288 tests.
- A standalone isolated OpenCode and local Qwen pilot passed 18 boundary checks against a disposable synthetic repository. Its two-file candidate passed 12 behavior checks and the patch applied cleanly to the pinned baseline. This is evidence for that pilot, not general repository execution.
- The pilot's source is in `research/isolated-runner-20261118/`. Its original local run artifacts and runtime dependencies are not part of this source snapshot.

## Next gates

1. Verify Windows-initiated Stop against a disposable worker and its descendants, including repeated and stale requests. Keep uncertain outcomes unresolved.
2. Verify controller restart recovery and request replay without duplicate execution. Record worker identity, outcome, and evidence.
3. Only after those gates pass and receive independent review, integrate the runner behind an off-by-default switch in a disposable staging workspace. Verify approval, diff review, and a version 2 receipt in the browser.
4. Continue the broader plan for scoped projects and approvals, model and provider choice, usage and receipts, terminal continuity, reusable context, multi-agent coordination, backup and recovery, accessibility, and a signed Windows release.

Do not cut over the existing live preview, broaden repository access, publish, or change accounts or security settings without the owner's specific approval. Preserve the separate original workspace and its historical evidence during source reconciliation.
