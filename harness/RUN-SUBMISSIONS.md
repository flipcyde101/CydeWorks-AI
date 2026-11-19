# Recovering a submitted run

Backend contract, 2026-11-16. The existing browser UI does not yet send submission IDs. Claude owns that integration. This feature does not restart the preview or permit automatic approval replay.

## Client protocol

An explicitly approved POST /api/tasks/:taskId/run may include requestId, a lowercase UUID. Create it once for that logical submission and retain the task ID plus request ID while its outcome is uncertain. It is an idempotency identifier, not a credential or permission. Existing clients without requestId retain their current optimistic version checks.

Keyed requests accept only requestId, version, sourceHash, approve, model, engine, backend, modelDigest, modelFingerprint and optional routeRevision. approve must be true. Existing task version, scope, model identity, route availability, capacity and uncertain-outcome holds apply before any new attempt is accepted. Defaults for engine/backend are normalized before fingerprinting. Changed inputs with the same task/request ID return 409. Malformed keyed requests return a static 400 error.

routeRevision is the selected inventory row's lowercase SHA-256 revision, not the inventory-wide revision. It binds a pre-dispatch comparison of route facts. Its inclusion, removal or replacement changes the submission identity. Submissions without it retain the previous fingerprint exactly, including after restart. See ROUTE-INVENTORY.md for the fresh-approval and preflight evidence boundaries.

The identifier is namespaced by task ID. It is not workspace-global. Another task with the same UUID is a separate operation and requires its own explicit scope approval. All API access retains the existing workspace authentication and origin checks.

The first accepted submission returns 202 with the ordinary task view plus runSubmission:

`{requestId, taskId, attemptId, attemptStatus, replayed:false, executionAuthorized:false}`

An exact repeat for the same task returns 200 with current task state and runSubmission.replayed:true identifying the originally recorded attempt. It does not start another attempt, renew approval, bypass an uncertain-outcome hold, change terminal ownership or append events. When newer work exists, runSubmission.attemptId can refer to an older attempt than the task view's latest attempt. Consumers must use that explicit identifier.

GET /api/tasks/:taskId/run-submissions/:requestId returns the same small reference with replayed:true. Use this read-only endpoint after a response is lost. executionAuthorized:false means the returned reference grants no authority; it does not mean the recorded attempt never started.

A 404 means no matching saved record was visible at that instant, or the task was removed. It does not prove that an earlier request still in transit will never arrive. Never mint a new request ID just because lookup returned 404 or timed out. Keep the original pair while reconciling, and do not automatically issue a fresh approval. An intentional new attempt after a settled or retry-safe result needs a new ID and current explicit approval. Existing execution gates still decide whether it can start.

## Persistence and privacy

The request ID and a SHA-256 fingerprint of task/version/source/route inputs are stored inside the attempt. They are saved in the same atomic task-row write as the execution claim, before dispatch. There is no separate ledger or schema migration. Internal submission metadata is omitted from normal task views, both task export modes and receipt envelopes. The small reference is returned only by keyed submission responses and the authenticated lookup. No input content or credentials are added to the submission record.

Records survive workspace restart with their attempts. Recovery still marks unconfirmed external outcomes unresolved. Retrieving a submission is not proof of provider completion and is not an exactly-once guarantee at an external provider. Removing the task removes its submission references from the active task record; ordinary SQLite/backup retention limitations continue to apply. Removed tasks cannot be recreated by replaying this endpoint.

## Acceptance coverage

run-submission.test.mjs covers normalization, scope/identity binding, invalid keyed inputs, conflicting records, interruption and export exclusion. run-submission-api.test.mjs covers authentication, origin checks, concurrent identical requests, read-only lookup, stopped and older attempts, public-view exclusion, explicit new attempts, task namespace and removal. recovery.test.mjs verifies real disposable SQLite persistence across server restart, including unresolved provider attempts remaining blocked.

These are local synthetic tests. No model provider or live workspace was used. Evidence and the independent review are in project work/run-submission-20261116.
