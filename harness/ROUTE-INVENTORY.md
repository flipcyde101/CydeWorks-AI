# Route inventory revisions

The authenticated `GET /api/models` response keeps its existing `models` and `diagnostics` fields and adds:

- `revision`: SHA-256 identifier for the current set of material route facts.
- `models[i].revision`: identifier for the material facts of that individual route.
- `revisionKind`: `route-facts-sha256-v1`.
- `observedAt`: start of the host inspection, before asynchronous probes.
- `expiresAt`: observation time plus 30 seconds. This is a client freshness limit, not an approval expiry enforced by the run endpoint.
- `executionAuthorized`: always `false`.

Revisions are deterministic content identifiers, not counters, signatures, credentials or permission. They can return to a previous value when the same facts return. They are stable across process restart if the same facts are observed. A fresh observation does not prove model weights, isolation or coding competence.

## Material facts

Each route binds model ID, engine, normalized backend, endpoint, digest, server metadata fingerprint, size, quantization, remote/local declaration, cloud-disabled declaration and the readiness eligibility and explanation. An internal policy version is included. Inventory revision includes the sorted route revisions, retaining duplicates; row order does not matter.

Display labels and observation timestamps do not affect the revision. Free RAM is not hashed directly; a resulting readiness change is. Newly introduced permissions, routing destinations or other material configuration must be added to the facts and regression tests before relying on this revision for those fields. Current tool permissions are fixed by the runner and are not a new editable inventory contract.

## Consumer rules for Claude's adapter

1. Preserve the inventory revision and selected route revision through mapping. Preserve freshness timestamps separately.
2. Capture the reviewed task ID, version, full scope binding and selected route facts when approval is checked. Clear it when any of those facts changes. Inventory revisions cannot fix task polling that replaces the approved scope.
3. At `now >= expiresAt`, or when observation is in the future, freshness is unavailable. Clear approval and refresh before offering another run. A network failure must not keep old evidence indefinitely. A slower probe can return already-expired evidence, which remains expired.
4. A changed selected route revision means re-review. An inventory change confined to an unrelated route need not invalidate a selection if the client independently verifies its selected route and scope remained unchanged. Conservative invalidation of all route changes is also safe.
5. If revisions are missing, compare material facts conservatively; do not assume absence means unchanged. Do not derive authorization from the hash.
6. An approved run may include the selected model row's `revision` as `routeRevision`. Use the per-route revision, not the aggregate inventory revision. This adds a pre-dispatch equality check; it does not grant authority. Task version, source hash, explicit approval, model identity and all existing eligibility checks still apply. For keyed submission recovery, preserve the original request body and requestId as described in RUN-SUBMISSIONS.md.

## Optional pre-dispatch binding

`POST /api/tasks/:id/run` accepts an optional lowercase 64-character hexadecimal `routeRevision`. Omit it for legacy behavior; null, malformed or wrong-type values receive a static 400 error before an attempt is claimed. The field works with or without a requestId. New clients should always include the revision of the exact selected route they presented for approval.

After the normal model-identity and readiness checks, the executor derives the route facts using the same host projection as the inventory endpoint. A mismatch ends the attempt before adapter.run is called. HTTP 202 acknowledges the claim, not preflight success; clients must observe the resulting task. A mismatch remains a recorded failed preflight with execution.phase equal to claimed, proving this executor did not begin dispatch. Refresh and obtain explicit approval before a deliberate new attempt.

The attempt records `approvedRouteRevision` when supplied and `observedRouteRevision` when preflight matches. The latter proves only that these host observations matched; it is not a provider dispatch or model-weight attestation. Hashes contain no raw endpoint or source but remain correlatable. They appear in authenticated task views and standard task exports; minimal and receipt exports keep their existing schemas.

The binding is included in keyed submission identity and attempt scope hashing. Removing or replacing it while replaying the same requestId conflicts. Exact replay still retrieves the original attempt without another dispatch, including after restart. Existing persisted submissions with no routeRevision keep their original fingerprint calculation.

This does not turn observation timestamps into signed approval expiry, prevent every change after preflight, or prove a human saw the current scope. Clients still need the scope-binding and freshness rules above. The server continues to enforce its actual execution gates independently of client hashes.

This update does not add UI controls, change routing policy, call an inference endpoint or restart the active preview. `/api/tasks/:id/readiness` retains its existing diagnostic contract. Endpoint inspection still performs the same bounded model-inventory probes as before.

## Verification

Run `node --test route-inventory.test.mjs route-inventory-api.test.mjs recovery.test.mjs`, then the full `node --test` suite with BFE_LIVE_TEST=0 and BFE_LIVE_OLLAMA=0. The API test uses an isolated copied host with synthetic provider modules and no model inference. It verifies authentication, stable refreshes, identity changes, cloud holds, missing inventory, recovery and unchanged task records.
