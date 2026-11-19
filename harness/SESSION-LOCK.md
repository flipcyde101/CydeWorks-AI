# Workspace session lock

Backend and UI contract, 2026-11-18. Lock and the inactivity deadline end the single in-memory operator session. They do not restart the existing preview.

## Request and response

Send authenticated, same-origin `POST /api/session/lock` with `Content-Type: application/json` and exactly `{}`. Unknown fields return 400, other methods return 405, missing/expired sessions return 401, and origin violations return 403. The existing request-size limit applies.

Successful response:

```json
{"locked":true,"scope":"all-workspace-views","terminalControlReleased":true,"stopsWork":false,"requiresAccessFile":true}
```

The server replaces its in-memory session value and expires the calling browser's session cookie. Every existing view's old cookie is rejected, even if a view keeps that cookie locally. The workspace access file is unchanged. A new POST to `/api/session` using that file is required to unlock. A repeated Lock using the revoked cookie returns 401 and does not renew access.

## Inactivity

The workspace session ends 15 minutes after the last operator action. The deadline starts when the in-memory session secret is created, including a desktop bootstrap that creates the secret without `POST /api/session`. The server samples a monotonic clock and a wall clock and remembers the last finite sample. If either sample is not finite or moves backward, the session ends instead of lasting longer. It also ends when either clock is at least 15 minutes ahead of the last operator action. The deadline moves on a successful unlock and on an authenticated POST, except a terminal heartbeat, a terminal detach, and `POST /api/cost-presentation`. Those three are lease renewal, view teardown, or automatic presentation. Authenticated GETs do not move the deadline. That includes task lists, task reads, attention, route inventory, and other reads. A terminal heartbeat renews only the 15-second terminal control lease. Terminal release, status, take, stop, task changes, and handoff review still move the workspace deadline.

At the deadline the server replaces the session secret, revokes terminal control, and expires a cookie that still matches the old secret. It does not stop approved work. The 15-second terminal lease is unchanged. Unlocking after the deadline still requires the access file. The session id is not put in a URL. The cookie stays HttpOnly, SameSite Strict, and Path `/api`. The current HTTP preview does not add Secure.

A Lock request for a session that has already reached the deadline returns 401. The access file is unchanged. An authenticated POST body that is still arriving when the deadline passes is rejected by the same recheck used for Lock. An authenticated POST whose body is later rejected still moves the deadline, because the deadline moves after that recheck and before the route's own validation. A terminal heartbeat, a terminal detach, and `POST /api/cost-presentation` do not. A models probe that is still running when the deadline passes, and that finishes only after a newer unlock, returns 401 and does not send a cookie deletion. The unlock cookie stays in effect. A response whose presented cookie still matches the secret being ended still expires that cookie.

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

This is authorization revocation. It does not erase already-rendered text, clipboard contents, downloaded files, browser memory, task records, worker artifacts or provider data. Legacy and experience both offer Lock. Legacy posts exactly `{}` and shows "Workspace session terminated in every view. Approved work keeps running, and terminal control was released. Unlock with the access file." only after the server returns `locked: true`. A lost response is an unconfirmed local lock. A 401 means the session had already ended. Any other success body is unconfirmed. Experience uses the same confirmation rule and the same termination sentence, and it still ignores that result when a newer unlock or Lock owns the screen. Legacy keeps a session epoch. Lock conceals the view before the response: polls stop, the terminal lease is dropped, and task actions stay disabled. That concealment remains when the lock request fails. A task or list read that was already in flight cannot mark the view connected or rebuild an actionable list afterward. A lock response that arrives after a newer unlock does not lock the view again or replace the unlock status. The Lock control stays hidden until this view has opened the workspace, and confirming Lock moves focus to the access file when that control is visible. Neither view erases already rendered text. Reading the workspace does not keep the session open. Restart, Lock, and 15 minutes without an operator action end it. No desktop-bootstrap session is automatically reissued after Lock or after the idle deadline; the current app view must use the normal unlock flow.

## Verification

`node --test session-lock.test.mjs terminal-control.test.mjs terminal-api.test.mjs` from `harness` exercises multiple views, authentication/origin/shape errors, lease revocation, continued approved work, completion while locked, fresh unlock, a delayed task mutation, an older delayed unlock, an inventory probe that finishes after Lock, the 15-minute idle boundary, polls and heartbeats that do not move that deadline, an operator POST that does, a body still in flight at the deadline, approved work that finishes after idle, the legacy Lock dialog copy, a backward wall or monotonic sample, cost presentation and detach that do not move the deadline, handoff review and terminal status that do, a malformed lock success, a pending task read after local lock, a failed lock that stays concealed, an older lock outcome after a newer unlock, Lock focus, and a late idle probe that must not delete a newer unlock cookie. Race tests mark the exact wait point in a copied synthetic host. Idle tests replace only that host's session clock. No owner state or real provider is used. This document does not record that those cases have been run.

Run the full `node --test` suite after changes to session checks, asynchronous HTTP handling or terminal control. Independent review and observed results are recorded in `work/session-lock-20261117/` at the project root.
