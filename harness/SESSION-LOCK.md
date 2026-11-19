# Workspace session lock

Backend contract, 2026-11-17. Claude owns UI integration. This endpoint does not add a frontend control or restart the existing preview.

## Request and response

Send authenticated, same-origin `POST /api/session/lock` with `Content-Type: application/json` and exactly `{}`. Unknown fields return 400, other methods return 405, missing/expired sessions return 401, and origin violations return 403. The existing request-size limit applies.

Successful response:

```json
{"locked":true,"scope":"all-workspace-views","terminalControlReleased":true,"stopsWork":false,"requiresAccessFile":true}
```

The server replaces its in-memory session value and expires the calling browser's session cookie. Every existing view's old cookie is rejected, even if a view keeps that cookie locally. The workspace access file is unchanged. A new POST to `/api/session` using that file is required to unlock. A repeated Lock using the revoked cookie returns 401 and does not renew access.

## Running work and request races

Lock releases any active terminal lease without closing its control channel, cancelling the task or stopping a worker. Already-approved work may finish while locked. Freshly unlocked observers must explicitly Take control again. A lease held before Lock is invalid even after unlocking.

Authenticated POST requests recheck their session after the complete body is received and before dispatching a mutation or returning a processing result. A body that was still arriving when Lock occurred cannot mutate a task afterward. An unlock request already in flight before Lock returns 409 if it finishes afterward; it must be consciously retried with the access file. Slow inventory/readiness probes recheck authentication before returning their results.

Lock cannot undo a mutation already committed or work already approved. A lost response can still have an unknown outcome. Keep pending submission identifiers for reconciliation and never treat a lock or 401 as proof that an earlier run did not start. Lock is distinct from Stop, Detach and task removal.

## Frontend obligations

- Explain that Lock affects every view while approved work continues.
- Discard local terminal lease tokens, disable mutation/download controls and conceal sensitive task content when locking or receiving 401.
- Preserve only the minimum pending request identifiers needed for recovery. Do not store source or session secrets for convenience.
- After a lost Lock response, locally lock the view and use a read-only authenticated check if needed. Do not silently unlock or resubmit earlier commands.
- Unlock using the existing access-file flow, reconcile saved state, and reattach read-only.

This is backend authorization revocation. It does not erase already-rendered text, clipboard contents, downloaded files, browser memory, task records, worker artifacts or provider data. The current frontend and Claude's candidate were not modified, so their display-clearing and Lock-button behavior require separate integration tests. No desktop-bootstrap session is automatically reissued after Lock; the current app view must use the normal unlock flow.

## Verification

`node --test session-lock.test.mjs terminal-control.test.mjs terminal-api.test.mjs` from `harness` exercises multiple views, authentication/origin/shape errors, lease revocation, continued approved work, completion while locked, fresh unlock, a delayed task mutation, an older delayed unlock, and an inventory probe that finishes after Lock. Race tests mark the exact wait point in a copied synthetic host. No owner state or real provider is used.

Run the full `node --test` suite after changes to session checks, asynchronous HTTP handling or terminal control. Independent review and observed results are recorded in `work/session-lock-20261117/` at the project root.
