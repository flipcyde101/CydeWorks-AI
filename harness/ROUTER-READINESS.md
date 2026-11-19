# Router evaluation and connection qualification

Local source integration, 2026-11-16. No UI integration or live provider qualification is implied.

The evaluator uses Gemini's reviewed 0.4.0 provisional contract. The connection engine uses Antigravity's reviewed host-attestation repair. These are separate domains: evaluation fixture vocabulary is not the execution router's schema. Neither can authorize work.

## Authenticated interfaces

POST /api/router/evaluate accepts exactly `{dataset, decisionsPayload}` as application/json. Both follow router-evaluation-contract.mjs. HTTP batches require synthetic data, 1 to 10 cases, at most 30 submitted decisions and the existing 48,000-byte body limit. The server supplies evaluation time after reading the request. Clients cannot supply evaluation time or mode at the top level. A timestamp inside decisionsPayload is submission metadata only.

Success is HTTP 200 with `{ok:true, formatVersion:1, scope:'synthetic-evaluation', executionAuthorized:false, caveat, report}`. Evaluation completion is different from a passing report. Consumers must show report.overallVerdict, submissionIntegrity and summary.safetyViolationsCount. Do not infer safety from overallPassRate. Invalid input returns HTTP 400 with a fixed INVALID_EVALUATION_REQUEST error. Oversized bodies return 413. All requests require the existing workspace cookie and same-origin POST protections. No evaluation is saved or dispatched.

HTTP reports always use the evaluator's non-authoritative historical_replay mode with the server's current time, so report.authoritativeAuthorization is false as well. This is a replay of submitted synthetic decisions, not a live routing decision. Report validation proves internal consistency only, not authenticity. Valid synthetic identifiers and case aliases remain in the report; it is not an anonymization tool. Cost and time fixture deltas are estimates, not measured router savings.

Larger offline evaluations use router-evaluator.mjs with explicit --cases, --decisions and --evaluated-at arguments. The reviewed 53-case fixtures are under test-support/router-evaluation-v04. The example intentionally fails safety and exits nonzero. Offline authoritative mode checks submitted synthetic approval facts against the supplied clock; it does not authorize real execution.

GET /api/tasks/:id/readiness probes the same configured inventory sources as GET /api/models, then re-reads the current task. It returns formatVersion, scope:'inventory-diagnostic', taskId, taskVersion, observedAt, executionAuthorized:false, connections, diagnostics and limitation. Every connection has an opaque route reference, previewEligibility and qualification from the integrated engine. Probes inspect inventory, not inference quality. The task's source, instructions and title are not passed into qualification. Provider-supplied attestation and capability fields are ignored.

The diagnostic deliberately carries no run approval and no verified capability or isolation attestation. productionEligible is therefore false until a separate trusted capability-inspection integration is built. Existing bounded preview eligibility remains separately visible and the existing execution preflight is unchanged. The UI must label these two meanings separately. A reachable service is not a coding-qualified model, and a loopback endpoint is not proof of no downstream forwarding. Missing inventory yields an empty connections list plus diagnostics. Reading these endpoints does not mutate tasks, receipts, approvals or terminal ownership.

The response evaluates at most 50 inventory routes. Its inventory object reports totalRoutes, evaluatedRoutes, limit and truncated. Consumers must show truncation and must not treat omitted routes as evaluated. Inventory listing leaves modelReachable unknown because no inference request was made.

## Consumers and ownership

Codex owns these backend adapters and tests. Claude owns UI consumption and must preserve the scope labels and qualification limits above. Gemini and Antigravity work in their new isolated assignment folders. Runtime validators in router-evaluation-contract.mjs and connection-contract.mjs remain authoritative for their respective payloads. No contributor UI was copied.

## Provenance and verification

The four imported logic files differ from reviewed candidate files only in relative import names. Source and integrated hashes are recorded in ../work/router-readiness-integration-20261116/sources.json. Test-only fixtures and carried-forward independent regressions exercise both engines through their integrated imports. The API tests use a disposable memory database and stubbed adapters, with an existing synthetic run active while reports are requested. They verify authentication, origin rejection, current version binding, limits, deliberate evaluation failures and unchanged task history.

Run `node --test` from this directory with BFE_LIVE_TEST=0 and BFE_LIVE_OLLAMA=0. These results do not establish live model quality, real subscription availability, billing correctness or a preview restart.
