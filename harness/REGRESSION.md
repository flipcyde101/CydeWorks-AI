# Terminal regression map

## Workspace experience and receipt analytics, 2026-11-18

`browser-assets.mjs` supplies the browser asset map to `server.mjs` and the Dell cutover helper. `BFE_UI=experience` selects the pinned files in `web-experience/asset-manifest.json`. The legacy UI remains selectable at startup. The workspace host serves the new UI directly.

`GET /api/receipts/analytics` summarizes up to 100 stored task snapshots through the version 2 receipt exporter. Real unrun drafts are counted separately. Missing receipt evidence remains visible, and the route returns no task prompts, source, file names, or raw record IDs. It uses the same session and origin checks as the per-task receipt route.

Run `node --test harness/first-usable-api.test.mjs harness/preview-health.test.mjs work/preview-cutover-guard.test.mjs` from the project root and rerun the full harness suite. The receipt candidate suite is at `work/codex-receipt-analytics-repair-20261118/`. Run `node work/first-usable-20261118/workspace-browser-check.mjs synthetic` for the new UI on a disposable workspace. The `live` mode uses the existing local Qwen service. Run it when local inference is authorized.

## Preview health and cutover, 2026-11-17

Dependency evidence: `rg -n 'serverRevision|/api/health' harness/server.mjs work/restart-cydeworks-llamacpp-20261115.mjs` from the project root. The restart helper uses the public loopback health check to compare the server entry point's startup hash against the expected source. This identifies the entry point, not the entire build or any provider's health. The response contains only its ready status and the hash. The normal host and origin restrictions apply.

Acceptance from the project root: `node --test harness/preview-health.test.mjs work/preview-cutover-guard.test.mjs`, then the full harness suite. For an authorized Dell restart, pin the existing listener PID and local start time, run the cutover helper with `--dry-run`, and repeat without that flag only if it passes. The helper holds the database write lock during the idle snapshot and stop, checks the replacement listener and served assets, confirms protected tasks still require authentication, and compares saved task records after startup.

## Workspace session lock, 2026-11-17

Dependency evidence: `rg -n 'sessionAtArrival|authenticatedBody|requireSession|control.revoke|session/lock' server.mjs terminal-control.mjs`. Downstream consumers: every authenticated HTTP handler, active terminal leases and desktop startup cookies. Claude's frontend must integrate the documented Lock behavior separately.

Acceptance: `node --test session-lock.test.mjs terminal-control.test.mjs terminal-api.test.mjs desktop-bootstrap.test.mjs desktop-service.test.mjs`, then `node --test`. Synthetic tests cover old cookies and leases, auth/origin errors, pending mutation and unlock bodies, slow probes, completion while locked and fresh authentication. Final full suite: 277 passed, zero failed or skipped, Node v24.19.0. Evidence: project `work/session-lock-20261117/`. No real provider or owner-state test was run for this change.

## Accepted artifact download, 2026-11-16

Dependency evidence: `rg -n 'artifact-download|acceptedArtifactDownload|artifactDownloadRequest' . -g '*.mjs'`. artifact-download.mjs uses the existing patch builder and feeds the authenticated server GET path. recovery.test.mjs's disposable source manifest includes the new import. No frontend or contributor module changed.

Acceptance: `node --test artifact-download.test.mjs artifact-download-api.test.mjs proposal-edit.test.mjs`, then `node --test` with BFE_LIVE_TEST=0 and BFE_LIVE_OLLAMA=0. Downstream checks cover proposal edits/review, task removal, export/receipt compatibility and recovery. The HTTP test runs a copied server and synthetic providers. Evidence: project work/artifact-download-20261116. The download contract grants no execution permission and applies no patch.

## Optional run route binding, 2026-11-16

Dependency evidence: `rg -n 'routeRevision|approvedRouteRevision|observedRouteRevision' . -g '*.mjs'`. route-inventory.mjs supplies the same revision function to server inventory and dispatch preflight. run-submission.mjs validates and fingerprints the optional binding; server.mjs stores it in the existing task record. recovery.test.mjs verifies bound replay through a disposable SQLite restart while preserving unbound legacy replay. No new persistent store or schema migration.

Acceptance: `node --test route-binding-api.test.mjs route-inventory.test.mjs route-inventory-api.test.mjs run-submission.test.mjs run-submission-api.test.mjs recovery.test.mjs`, then `node --test` with BFE_LIVE_TEST=0 and BFE_LIVE_OLLAMA=0. Propagation includes model preflight, receipt/export compatibility, recovery and existing clients. Tests use synthetic copied hosts and controlled provider modules, not owner state or models. Evidence: work/route-binding-20261116. Frontend implementation remains Claude's responsibility.

## Route inventory revision, 2026-11-16

Dependency evidence: `rg -n 'buildRouteInventory|route-inventory' . -g '*.mjs'`. route-inventory.mjs feeds server.mjs's authenticated model inventory response. recovery.test.mjs copies the new module for its disposable restart checks. terminal-workspace.mjs has a test-only configuration callback used before its synthetic host starts; production does not import it.

Acceptance: `node --test route-inventory.test.mjs route-inventory-api.test.mjs recovery.test.mjs`, followed by `node --test` with BFE_LIVE_TEST=0 and BFE_LIVE_OLLAMA=0. Inventory changes propagate to route, model-preflight, readiness, API, recovery and existing UI compatibility tests; the full suite covers them. No frontend file changed. Evidence: project work/route-inventory-20261116. Revisions and freshness are diagnostic, not new authorization. See ROUTE-INVENTORY.md.

## Run submission recovery, 2026-11-16

Dependency evidence: `rg -n 'run-submission|submissionResult|prepareRunSubmission' . -g '*.mjs'`. run-submission.mjs feeds server.mjs before version checking and dispatch. The existing atomic task write persists its claim. export.mjs and view() suppress the internal metadata. recovery.test.mjs includes the new module in its explicit server-copy manifest.

Acceptance: `node --test run-submission.test.mjs run-submission-api.test.mjs recovery.test.mjs`, then `node --test` with BFE_LIVE_TEST=0 and BFE_LIVE_OLLAMA=0. Changes to submission identity or replay semantics require API, recovery, export, receipt and terminal consumers to pass. The full suite includes them. UI behavior is unchanged; RUN-SUBMISSIONS.md defines the contract for its future consumer. Evidence is under project work/run-submission-20261116.

## Router and readiness integration, 2026-11-16

server.mjs consumes router-evaluation-api.mjs and connection-host.mjs. These wrap the pinned evaluator and connection engines. recovery.test.mjs explicitly copies all six modules into its disposable server. terminal-workspace.mjs copies root modules automatically. Claude's web assets are unchanged.

Run router-readiness.test.mjs and router-readiness-api.test.mjs for adapter and HTTP boundaries. The carried-forward connection-regression, router-regression, router-result-contract and router-imported-result tests protect previously repaired permission, attestation, expired approval, duplicate submission and imported-report bugs. Then run the full suite. Evidence is in project work/router-readiness-integration-20261116. These endpoints are diagnostic and synthetic reporting only, not new execution permission. See ROUTER-READINESS.md for consumers and limitations.

## Receipt integration, 2026-11-16

Dependency evidence: `rg -n 'receipt-adapter|receipt-contract|receipt-export' *.mjs` through a shell that expands the file glob, or `rg -n 'receipt-adapter|receipt-contract|receipt-export' . -g '*.mjs'`.

receipt-contract.mjs feeds the pure adapter and envelope exporter; receipt-export.mjs feeds server.mjs's authenticated GET route. recovery.test.mjs copies all three modules into its disposable workspace. test-support/inspector-v1 contains pinned test-only compatibility inputs, with hashes and provenance. The envelope is version 2; Inspector run schema stays version 1.

Acceptance: `node --test receipt-*.test.mjs`, then `node --test`, with BFE_LIVE_TEST=0 and BFE_LIVE_OLLAMA=0. receipt-flow.test.mjs exercises the real workspace API and Ollama adapter against a controlled synthetic loopback provider, including approval, running observation, operator edit, acceptance, export, copied draft comparison, preflight failure and cancellation with unknown outcome. The separate receipt-endpoint test verifies authentication, origin rejection, export repeatability and existing export compatibility. No real model or owner workspace is used.

Any changes to scope identity, acceptance history, model disclosure, recovery, costs or envelope fields require rerunning these consumers. The API does not add a UI button and the active preview needs a separate authorized restart to load changes. Integration evidence is under project work/receipt-integration-20261116.

This scoped map covers the terminal change of 2026-11-16, not every application module.

Dependency evidence: `rg -n 'terminal-control|terminal-request|ownsTerminal|terminalRequest' server.mjs web/app.js terminal-control.test.mjs terminal-api.test.mjs` from this folder.

| Module | Downstream consumers | Acceptance |
| --- | --- | --- |
| terminal-control.mjs | server.mjs terminal mutation and view paths | node --test terminal-control.test.mjs terminal-api.test.mjs |
| web/terminal-request.js | web/app.js heartbeat, ownership rendering and terminal actions | node --test terminal-control.test.mjs observer.test.mjs |
| server.mjs and web/app.js | workspace, recovery and browser flows | node --test; then project work/terminal-control-20261116/browser-check.mjs from its own directory |

Any ownership contract change requires both backend and browser consumers to be checked. The browser script requires the existing project-local Playwright package and installed Edge; it uses only a synthetic temporary workspace. Do not substitute the active preview or real workspace data.

The new module and browser asset must also remain in recovery.test.mjs's explicit copied-source list. All 132 tests and the saved two-view browser check passed on 2026-11-16. These results do not prove live worker behavior.

## Draft-copy addition

Dependency evidence: `rg -n 'draft-copy|draftCopyHold|copiedDraftScope|bindDraftCopyDialog' server.mjs web/app.js recovery.test.mjs`.

draft-copy.mjs feeds server.mjs's copy eligibility and transactional creation path. web/draft-copy-dialog.js is consumed by web/app.js. The new module and asset are included in the recovery fixture's explicit manifest. Removal disclosures account for retained deduplication references.

Acceptance: `node --test draft-copy.test.mjs draft-copy-api.test.mjs draft-copy-dialog.test.mjs recovery.test.mjs removal.test.mjs`, then `node --test`. For browser behavior run project work/draft-copy-20261116/browser-check.mjs from its own directory. Changes to copy semantics, request identity, authentication errors or retention require those consumers to be rechecked. All 145 tests and the saved browser flow passed on 2026-11-16.
## Verified contributor API integration, 2026-11-17

Downstream consumers: `server.mjs` and source-copy restart tests; future frontend consumers are not yet connected. Dependency evidence: `rg -n 'contributor-api|cost-presentation|portable-' harness -g '*.mjs'`.

Regression acceptance: from `harness`, run `node --test contributor-api.test.mjs cost-presentation.test.mjs`, then `node --test`. Changes to API envelopes, source imports, authentication or intake limits require both commands. The test-copy manifest in `recovery.test.mjs` must include every imported runtime module. Input/authority boundaries and unchanged source provenance are documented in `CONTRIBUTOR-INTEGRATION.md`.

## Route-bound receipt compatibility, 2026-11-17

Dependency evidence: `rg -n 'approvedRouteRevision|scopeBinding|scopeHash|approvedInputProblem' server.mjs receipt-adapter.mjs`. The adapter must reproduce the server's optional route-bound scope hash while preserving legacy records. Regression: `node --test route-bound-receipt.test.mjs receipt-adapter.test.mjs receipt-export.test.mjs`, then the full suite. Both pure and HTTP regression tests failed before the fix and passed afterward. Final full suite: 271 passed, zero failed or skipped on Node v24.19.0. Real-model and existing-frontend browser evidence is in project `work/verified-pieces-integration-20261117/HANDOFF.md`; neither result implies adoption of the replacement UI.

