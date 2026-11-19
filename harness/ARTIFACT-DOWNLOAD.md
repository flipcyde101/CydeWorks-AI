# Accepted proposal downloads

GET /api/tasks/:id/artifact returns an attachment for the current accepted proposal. The endpoint uses the existing workspace session and origin checks. It is read-only and does not apply changes to any repository or filesystem.

Required query fields:

- version: the exact current task version, as a canonical nonnegative integer string.
- attemptId: the current accepted attempt's lowercase UUID.
- artifactHash: the current accepted artifact's lowercase SHA-256.
- format: optional content (default) or patch.

Unknown or repeated query parameters are rejected. Bind these values to the task/result the user reviewed. Do not silently refresh a failed request into a different proposal download.

## Responses

Successful responses use text/plain; charset=utf-8 and Content-Disposition: attachment. Content-Length is the actual UTF-8 byte count. X-Artifact-SHA256 is the SHA-256 of those response bytes. Existing no-store, nosniff and restrictive CSP headers remain applied.

For content, the body is only the accepted artifact's content, without added metadata or explanatory wrappers. Valid Unicode, mixed CRLF/LF and missing final newlines are preserved through UTF-8 encoding. The filename is proposed- plus the validated single filename for a change, or brief.md for a brief. Returning content does not mean it is safe to execute.

For patch, the task must be a change. Both artifact and source hashes are checked, and the unified patch is regenerated from the stored source and accepted content. The filename is proposal.patch. A patch contains original source as well as proposed content; the UI should disclose that before download or external sharing. No patch is applied by this endpoint.

Malformed bindings return static 400 errors. A stale version, different attempt/hash, unaccepted task, unverifiable artifact or invalid filename returns a static 409. A missing or removed task returns 404. Other methods return 405. Errors retain JSON format and do not echo rejected query values or source content.

The task and latest attempt must both be accepted, with recorded checks passing. The artifact's stored hash is recomputed before returning bytes. A new attempt makes the former download binding stale even when its content matches an earlier result. This is a consistency check against the local record, not authentication of imported data or proof of quality.

## UI and privacy boundary

Claude owns wiring the user-facing download action. This change does not replace the existing browser download controls or restart the preview. Use the exact current accepted tuple and handle 401, 404 and 409 as review/reconciliation states. Do not automatically accept, retry model work or change tasks after a failed download.

Task, attempt and artifact identifiers in the URL are correlatable and should not be placed in analytics or public links. No credential belongs in the URL. Content and patches can contain sensitive model output or source, so downloading is distinct from authorizing external sharing.

The authenticated task API already exposes proposal content for review. This endpoint enforces the accepted-download workflow; it does not create a new role-based secrecy boundary around otherwise readable proposals. It adds no download-history record, durable file, signed package or acceptance receipt schema.

## Tests

Run node --test artifact-download.test.mjs artifact-download-api.test.mjs proposal-edit.test.mjs, then the full suite with BFE_LIVE_TEST=0 and BFE_LIVE_OLLAMA=0. The API test uses a copied server with synthetic provider modules, in-memory task state and no real model. It covers edit, acceptance, content/patch download, stale attempts, authentication, invalid requests, read-only behavior and removal.
