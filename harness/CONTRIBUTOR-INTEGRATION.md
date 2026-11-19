# Reviewed cost presentation and portable handoff intake

Backend integration, 2026-11-17. These interfaces do not replace the frontend or enable execution. Both require the existing local workspace session, same-origin POST, JSON input and the server's 48,000-byte request limit. Responses are not cached. No submitted input or result is persisted.

## Cost presentation

`POST /api/cost-presentation` accepts the reviewed Qwen formatter input:

```json
{"available":true,"deltaMicros":3000,"currency":"USD","evidence":"estimated"}
```

It returns `ok`, `formatVersion: 1`, `scope: "caller-supplied-cost-presentation"`, `executionAuthorized: false`, `billingAuthenticated: false` and `presentation` containing `available`, `headline`, `detail`, `caveat` and the optional malformed-input reason code. Malformed formatter input returns HTTP 400. Valid unavailable input, `{ "available": false }`, returns HTTP 200 and unavailable text with no numeric amount.

This only formats a supplied delta. It does not compare receipts, sum charges, read task history, authenticate bills or establish router savings. The delta is baseline minus candidate, in integer micros. Unknown charges must use `available: false`, never zero. Clients must first establish comparison eligibility and amount provenance through the relevant comparison contract. Gemini's analytics candidate is not imported here. All presentation strings must be rendered as plain text.

## Portable handoff review

`POST /api/handoffs/review` accepts `{ manifest, artifacts? }`. The manifest is the reviewed `cydeworks.task-handoff-manifest`, schema version 1, metadata-only contract. Each optional artifact record accepts only `artifactId`, `bytesBase64`, `claimedDigest` and `byteLength`. Base64 must be canonical, including padding. Decoded bytes are bounded to 32 KiB in total, within the overall JSON body limit; the pure library's larger per-artifact limit does not expand the HTTP limit.

The host supplies current task IDs for destination conflict checks. Caller-provided context, destination IDs, paths and URLs are not intake mechanisms. No file is read, remote artifact fetched, task created or manifest history stored. `manifestHistoryChecked: false` discloses that previous manifest imports are not tracked. `destinationConflictCheck` is `current-workspace-task-ids-only`.

Success returns the library's `plan`, plus `formatVersion: 1`, `executionAuthorized: false`, `persisted: false` and those conflict-check disclosures. Invalid input returns HTTP 400 with static diagnostics; oversized request bodies return 413. A well-formed plan with missing or mismatched artifacts can return 200: inspect its disposition and artifact review, not HTTP status alone.

Matching supplied bytes to an unauthenticated hash does not prove authenticity. Claims without bytes remain unverified. Fresh owner scope review is always required, the proposed state is always draft, and approval, permissions, terminal control and sessions never transfer. Labels remain untrusted free text, can contain sensitive information and need owner preview before external sharing. Render them with `textContent`, never HTML.

## Provenance and verification

`cost-presentation.mjs` is an exact copy of the final reviewed Qwen candidate, SHA-256 `aa52a33736e04ba2e45faa83771d011202678b3b29dbdec56da5e6bed87a64cb`. The four `portable-*` files copy Antigravity's manifest contract, validator, planner and SHA-256 implementation. Only their relative import names changed. Source candidates remain untouched.

The host adapter is `contributor-api.mjs`. `contributor-api.test.mjs` verifies authentication, origin checks, bounds, exact formatting, claim/byte distinctions, conflicts, no task mutation and no authority transfer. The original formatter's 25 tests are retained. Run `node --test contributor-api.test.mjs cost-presentation.test.mjs` from `harness`, then the full `node --test` suite. The separate integration handoff records live-model evidence and its limits.

Claude's UI, Gemini's analytics repairs and the existing preview are outside this backend integration. Consumers can adopt these interfaces after their own review and tests.
