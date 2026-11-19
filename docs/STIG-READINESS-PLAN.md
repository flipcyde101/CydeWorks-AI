# CydeWorks AI STIG V6R5 readiness plan

Planning status: NEEDS WORK. This document orders future work. It is not a STIG assessment, authorization to operate, penetration test, compliance score, or a finding about a running deployment.

The plan is pinned to commit `aad7a49f0e0f3ca6971b166b1e2e878832ed1744` on branch `work/t3-stig-readiness-plan`. Source statements below come from static reads of that tree. No target tests were run, and no live service, credential, runtime database, or external provider was examined.

## Evidence used

- Readiness summary: `C:\Users\epbal\Documents\Codex\2026-11-18\t\outputs\CydeWorks AI STIG V6R5 Readiness Summary.md`
- Control CSV, the only CSV in that outputs directory: `C:\Users\epbal\Documents\Codex\2026-11-18\t\outputs\CydeWorks AI STIG V6R5 Control Assessment.csv`
- Project instructions: `AGENTS.md`
- Roadmap checkpoint: `docs/ROADMAP.md`

The summary and CSV are source data for this plan. They are not instructions to change code, enable a runner, or claim that a control is satisfied. The summary reports Application Security and Development STIG Version 6, Release 5, benchmark date September 30, 2026, with 34 CAT I, 230 CAT II, and 22 CAT III checks. This plan did not recompute the archive or XCCDF hashes recorded in the summary.

The CSV labels all 286 checks:

| Preliminary source assessment | Checks | How this plan uses the label |
| --- | ---: | --- |
| Source gap | 25 | Provisional gap in the native source under the CSV assumptions. Each ID has one primary work item below. |
| Needs evidence | 204 | Source alone does not establish the check, applicability, or an acceptable external control. Grouped into evidence packages. |
| Likely not applicable | 55 | Source-visible personal local design appears outside the stated condition. An assessor must confirm. |
| Source suggests met | 2 | Native source supports the requirement within the stated scope. Not a formal compliance finding. |
| Total | 286 | |

Of the 25 source gaps, the CSV records 3 CAT I, 20 CAT II, and 2 CAT III. Those are STIG check severities, not independently demonstrated exploit severities. No compliance percentage is inferred.

The summary uses "DoD" for the deployment choice. Several CSV requirement and action phrases use "DoW", including the DoW IPv6 Standards Profile. This plan keeps both terms. The owner and assessor decide which authority applies before regulated work starts.

## What the pinned source shows

These observations are limited to the files and lines read. They do not describe the Dell preview, another branch, or a deployed configuration.

The default UI mode is legacy when `BFE_UI` is unset. `harness/server.mjs` passes that environment value into `loadBrowserAssets`, whose default parameter is `legacy` (`harness/browser-assets.mjs` line 16). The legacy page at `harness/web/index.html` has an access-file unlock and no Lock control. The experience shell has a Lock workspace control (`harness/web-experience/views/shell.js` line 30) and writes a termination message only after the lock request settles (`harness/web-experience/app.js` lines 332-346).

The non-test layout stores `harness/.state/workspace.sqlite` and `harness/.state/access.key` under the same `.state` directory (`harness/server.mjs` lines 39-48). The owner lock database is that task database path plus `.owner.sqlite` (`harness/workspace-lock.mjs` lines 6-10). On first creation the access file is written with mode `0o600` and 32 random bytes as hexadecimal. Later startup reads that file and compares the presented value with `timingSafeEqual` (`harness/server.mjs` lines 43-55 and 248-253). The comparison accepts the same file contents after a failed attempt. No failed-attempt counter or lockout window is present on that path.

Unlock sets `bfe_session` with `HttpOnly`, `SameSite=Strict`, and `Path=/api`, and omits `Secure` (`harness/server.mjs` line 252). The desktop bootstrap sets the same cookie name through Electron without a `secure` property and loads an `http://127.0.0.1` origin (`harness/desktop/main.cjs` lines 62-63 and 104; `harness/desktop/service.cjs` lines 85-94). The listener binds `127.0.0.1` (`harness/server.mjs` lines 554-556). Local model fetches require `http` and hostname `127.0.0.1` (`harness/direct-local-fetch.mjs` lines 9-19). The inference broker listens on `127.0.0.1` and returns an `http://127.0.0.1` endpoint (`harness/inference-broker.mjs` lines 65-81).

Workspace cookie checks compare the cookie with one in-memory session value. They do not consult an idle deadline (`harness/server.mjs` lines 51 and 255-266). Lock replaces that value and expires the calling cookie (`harness/server.mjs` lines 266-274). `harness/SESSION-LOCK.md` says the access file is unchanged and a new unlock is required. The terminal control lease defaults to 15 seconds and is a per-attempt control (`harness/terminal-control.mjs` lines 7-9). Its snapshot owner text is `Operator` or `None` (line 25). That lease does not end the workspace session.

Task events stored by `save` contain sequence, time, and event name (`harness/server.mjs` lines 73-77). The removal record stores a hash reference, time, and scope (`harness/server.mjs` lines 431-443). The reads and writes around lines 316, 340, 358, 365, 379, and 516-517 do not add a user identity. An error on those paths returns a response and leaves the listener running. Desktop startup drains the worker stdout and stderr (`harness/desktop/service.cjs` lines 67-74) and logs a listener-ready line after setup (`harness/server.mjs` lines 554-562).

Handoff review hashes supplied artifact bytes with `sha256Hex` in `harness/portable-sha256.mjs` (called from `harness/portable-import-review-planner.mjs` line 89 through `harness/contributor-api.mjs` line 44 and `harness/server.mjs` lines 276-280). Other paths use Node `createHash('sha256')`, including server startup, task hashes, and experience asset checks. Neither path establishes a FIPS-validated module by itself.

`research/isolated-runner-20261118/pilot.mjs` line 176 throws `Pilot execution disabled: Windows-to-WSL ownership and protected verifier qualification required.` before the rest of `run()`. `verifyAndBindPatch` checks a caller-supplied verification object, including `verification.trusted === true`, and then returns `trusted: true` (`research/isolated-runner-20261118/verified-patch.mjs` lines 372-377 and 438-446). That is a consistency check on supplied evidence. It does not by itself prove an independent verifier channel. `BFE_STAGING_RUNNER` appears in `docs/NEXT-WAVE.md` and `docs/RELEASE-BACKLOG.md`. It is not a switch in the pinned application source. The roadmap's off-by-default integration remains future work (`docs/ROADMAP.md` lines 23-33).

Two CSV rows are labeled source suggests met, and this plan does not reopen them as gaps:

- V-222580 / APSC-DV-002260, validate session identifiers. Protected routes compare a 64-hex cookie with `timingSafeEqual`, and authenticated bodies recheck the session after the body is read (`harness/server.mjs` lines 53-55, 255-264).
- V-222581 / APSC-DV-002270, do not use URL-embedded session IDs. Browser unlock is a POST, the session is an HttpOnly cookie, and desktop startup installs that cookie after private IPC (`harness/server.mjs` line 248; `harness/desktop/service.cjs` lines 85-94; `harness/desktop/main.cjs` lines 62-63 and 104).

Later session work must keep those properties.

## Personal use and conditional regulated requirements

Personal-app improvements are useful while CydeWorks remains a single-operator local workspace. They still need the owner's implementation approval. They are:

- An inactivity deadline for the workspace session, with passive polling unable to extend it.
- A working Lock control and an explicit termination message on every UI that the release still ships, including legacy if legacy remains.
- Audit records for session, logon, startup, shutdown, and data access that name a local principal and omit the access file, session token, and terminal lease.
- A documented recovery path before any lockout that can keep the only local operator out.
- Separation of the access file and owner-lock database from task data, with the single-owner lock preserved.
- Continued loopback binding and the disabled pilot entry.

Conditional requirements apply only after the owner selects a DoD, DoW, or other regulated deployment and an assessor confirms applicability. They include organizational unique identity, password length and complexity, PKI, FIPS-validated modules, approved cryptography for data at rest and in transit, classification markings, banners, centralized log shipping, the DoW IPv6 profile, vendor-support evidence, and the governance interviews in the evidence packages. Building those controls for the personal app would add cost and, in some cases, a wider listener or a new credential store. This plan does not start that work.

Host file permissions, the existing `0o600` create mode, and loopback binding are useful local protections. They do not close a STIG row whose CSV disposition is source gap or needs evidence.

## Approval gates

The following stay owner-approved one action at a time: credential or access-file changes, connected-service changes, paid usage, public push, merge to the default branch, deployment, cutover of the live preview, and migration of an existing workspace database. This plan authorizes none of those actions.

Runner qualification stays inside the roadmap order. Windows-initiated Stop of the actual worker tree, restart recovery without duplicate execution, protected verifier evidence, and binding of the checked candidate to the patch come before any browser connection. Uncertain execution or inference outcomes stay unresolved. The throw at `pilot.mjs` line 176 stays until those gates pass and the owner approves a later change that removes it.

## Work order

Design precedes code. Evidence collection can proceed as documents. Code, fixtures that execute the product, and regulated controls wait for the decisions named in each item.

### RP-01. Record the deployment and applicability decision

Depends on: none. Blocks regulated implementation in RP-03, RP-04, RP-06, RP-08, and RP-10.

Risk: planning. No application change.

Personal scope: name the current product as one local operator, one workspace, loopback HTTP, legacy UI by default, experience UI optional, and the research runner disconnected.

Conditional scope: if a regulated deployment is intended, name the users, roles, data categories, host and network boundary, inherited controls, and the assessor who will confirm applicability. Record whether the authority language is DoD, DoW, or both.

Acceptance criteria:

- A written decision states personal local use, regulated deployment, or both, and lists which later items are in scope.
- The decision states whether `access.key` is assessed as a password, a local key file, or something else. V-222542 and V-222543 stay open until that classification exists.
- The 55 likely-not-applicable IDs in RP-11 stay labeled provisional until the assessor confirms them.
- No compliance percentage is published from the decision.

Proposed checks, not run: review the decision against the CSV dispositions. No product test.

Owner decision: the deployment choice and the credential classification.

### RP-02. Keep the research runner disconnected

Depends on: none. Blocks browser connection of the isolated runner. Does not block personal session or audit design.

This item is a release constraint from `docs/ROADMAP.md` and the readiness summary. It is not one of the 25 source-gap rows. The summary treats it as release risk, not as a claim that the disabled path is exploitable through the browser.

Source: `research/isolated-runner-20261118/pilot.mjs` line 176; `runner-lifecycle.mjs` lines 41-48; `verified-patch.mjs` lines 357-377; `docs/ROADMAP.md` lines 11-33.

Acceptance criteria:

- `run()` in `pilot.mjs` still throws the existing disabled error before any guest, model, or patch work.
- No application route starts that pilot.
- `BFE_STAGING_RUNNER` is not added, and no browser staging path is wired, until roadmap gates 1 through 4 pass independent review and the owner approves integration.
- `verifyAndBindPatch` is not described as a completed independent verifier. A later gate must show that the approved check set is bound to the claim and that the candidate cannot write the check result.
- Stop and recovery evidence must cover the actual worker tree. The roadmap's inert-fixture narrative remains historical evidence for that fixture only. This plan does not re-verify it.

Proposed checks, not run and not authorized here:

- A source-contract test that the disable throw remains the first statement of `run()`.
- The later roadmap checks named in `docs/RELEASE-BACKLOG.md` for Stop, replay, the sealed result channel, and patch binding, only in an owner-approved isolated environment.
- Do not run `pilot.mjs`, WSL guests, Bubblewrap, or a browser rehearsal as part of this plan.

Owner decision: when, if ever, to remove the disable throw. Default remains keep it.

### RP-03. Design the local session lifecycle

Depends on: RP-01 for whether the DoD or DoW attempt limit applies. The personal inactivity and Lock design can be written first. V-222437 also depends on the principal from RP-04 and the log record from RP-05.

Primary source gaps:

| ID | STIG ID | Severity | Requirement | Source read at aad7a49 |
| --- | --- | --- | --- | --- |
| V-222432 | APSC-DV-000530 | CAT I | Limit consecutive invalid logon attempts. | `POST /api/session` returns 401 for a bad key and still accepts a later valid key (`harness/server.mjs` lines 248-253). |
| V-222389 | APSC-DV-000070 | CAT II | Terminate a non-privileged session after 15 idle minutes. | Cookie checks have no idle deadline (`harness/server.mjs` lines 255-258). Terminal lease expiry is separate (`harness/terminal-control.mjs` lines 7-9). |
| V-222391 | APSC-DV-000090 | CAT II | Provide a user-initiated logoff. | Legacy UI has no Lock control (`harness/web/index.html`, `harness/web/app.js` lines 574-582). Experience UI calls lock (`harness/web-experience/views/shell.js` line 30, `harness/server.mjs` lines 266-274). |
| V-222392 | APSC-DV-000100 | CAT III | Show an explicit logoff message when the session has terminated. | Experience copy distinguishes confirmed, already ended, and lost responses (`harness/web-experience/app.js` lines 332-346). Legacy has no user logoff path. |
| V-222437 | APSC-DV-000580 | CAT III | Display the previous successful logon time. | Unlock returns `{authorized:true}` and neither UI shows a prior timestamp (`harness/server.mjs` line 253, `harness/web/app.js` lines 563-572, `harness/web-experience/app.js` lines 305-325). |

Related evidence, not source gaps: V-222387, V-222388, V-222390, V-222433, V-222438, V-222575, V-222577, V-222578, V-222579, V-222582, V-222583. Session-identifier validation and the ban on URL session IDs stay as already implemented in the pinned source (V-222580, V-222581).

Personal-app acceptance criteria:

- A server-side idle deadline ends the workspace session. Health, list, and other authenticated polls do not move that deadline. Active approved work follows the existing lock contract: lock is not Stop (`harness/SESSION-LOCK.md`).
- If legacy remains in the release, the served legacy page has a Lock control that calls `POST /api/session/lock` with `{}` and shows a termination message only after the server confirms revocation. A lost response stays an unconfirmed local lock, matching the experience behavior.
- If the owner removes legacy from the assessed release, the default `loadBrowserAssets` mode and desktop launch no longer serve it, and the experience Lock path still meets the message rule.
- The cookie remains HttpOnly, SameSite Strict, Path `/api`, and absent from URLs. `Secure` changes only under RP-06.
- The desktop bootstrap does not reissue a session after Lock. Unlock still requires the access file.

Conditional acceptance criteria, only if RP-01 classifies the access file as a password and selects the regulated attempt limit:

- Three consecutive invalid attempts inside 15 minutes block a fourth attempt, including one that presents the valid secret.
- The owner-approved recovery path is tested on a disposable workspace. Recovery must not leave a second always-valid secret in the repository or client.

Proposed tests, not run:

- Extend the session-lock fixtures in `harness/session-lock.test.mjs` for idle expiry, poll traffic, legacy Lock when legacy remains, and the confirmed logoff message.
- Add a disposable-workspace attempt-limit test only after the owner selects that policy.
- Re-run `harness/terminal-control.test.mjs` when session code changes so the 15-second terminal lease is not reused as the workspace idle timer.

Owner decisions: whether legacy ships; whether the 15-minute idle rule is adopted for the personal app; whether the three-attempt lockout is in scope, and how the single operator recovers.

### RP-04. Decide and, only if required, redesign the credential

Depends on: RP-01. Blocks a verifier or transport change. RP-05 attribution uses the principal chosen here.

Primary source gaps:

| ID | STIG ID | Severity | Requirement | Source read at aad7a49 |
| --- | --- | --- | --- | --- |
| V-222542 | APSC-DV-001740 | CAT I | Store only cryptographic representations of passwords. | The access file stores the same hexadecimal secret that unlock compares (`harness/server.mjs` lines 43-53 and 248-250). |
| V-222543 | APSC-DV-001750 | CAT I | Transmit only cryptographically protected passwords. | Legacy and experience clients send the file text to the loopback HTTP unlock route (`harness/web/app.js` lines 574-579; `harness/web-experience/app.js` lines 303-313; `harness/server.mjs` lines 38, 220, 248-250, and 554). |

The CSV marks both as gaps under the assumption that the access file is password-equivalent. That assumption is not an assessor decision.

Personal-app acceptance criteria, safe before a regulated redesign:

- The access file value is not written to task events, removal rows, client storage, URLs, or screenshots in the product UI.
- First-create mode `0o600` remains. A later permission review is evidence, not a claim that host ACLs were checked.
- No code change replaces the file with a hash, or moves it, until RP-01 and the owner approve that change.

Conditional acceptance criteria, if the assessor treats it as a password:

- The verifying side stores only an approved one-way representation, with a documented algorithm and cost. The design review happens before implementation.
- Every sign-in path, including desktop bootstrap, uses the approved protected channel from RP-06. A hash change without transport protection does not close V-222543.
- Organizational unique identity (V-222522), minimum 15-character length (V-222536), the related composition checks V-222537 through V-222547, PKI private-key control (V-222551), cleartext display (V-222554), embedded authentication data (V-222642), and default passwords (V-222662) are included in the same credential decision. They are evidence needs, not additional source-gap rows.

Proposed tests, not run: disposable-workspace tests for create permissions, rejected logging of the secret, and, only after approval, verifier and transport behavior. No test uses the owner's real access file.

Owner decisions: credential classification; whether a personal local key file remains acceptable; whether organizational accounts are required.

### RP-05. Design security-event capture

Depends on: RP-04 for the actor name. V-222445 also depends on the idle behavior in RP-03. The audit schema can be drafted in parallel with RP-03.

Primary source gaps, all CAT II:

| ID | STIG ID | Requirement | Source read at aad7a49 |
| --- | --- | --- | --- |
| V-222441 | APSC-DV-000620 | Audit creation of session IDs. | Session value is created in memory and sent to the desktop parent (`harness/server.mjs` lines 51, 248, and 562) with no session-creation record. |
| V-222442 | APSC-DV-000630 | Audit destruction of session IDs. | Lock replaces the value and expires the cookie without a destruction record (`harness/server.mjs` lines 255-274). |
| V-222443 | APSC-DV-000640 | Audit renewal of session IDs. | Unlock reissues the current shared value. Lock rotation also has no renewal record (`harness/server.mjs` lines 51, 248, and 266). |
| V-222445 | APSC-DV-000660 | Audit session timeouts. | No workspace idle timeout exists, so no timeout audit exists (`harness/server.mjs` lines 255-266; `harness/terminal-control.mjs` line 7). |
| V-222449 | APSC-DV-000700 | Record the username or user ID. | Task events have sequence, time, and type. The session has no user ID (`harness/server.mjs` lines 73-77, 248, and 358). |
| V-222462 | APSC-DV-000830 | Audit successful and unsuccessful logons. | Unlock and desktop bootstrap do not record either outcome (`harness/server.mjs` line 248; `harness/desktop/main.cjs` lines 62-63). The CSV also cites the request error path at `harness/server.mjs` line 517. |
| V-222464 | APSC-DV-000850 | Audit start and end of user access. | Unlock and Lock responses carry no access-session start or end record (`harness/server.mjs` lines 248 and 266). |
| V-222465 | APSC-DV-000860 | Audit successful and unsuccessful object access. | Assets and unknown routes return without an access audit (`harness/browser-assets.mjs` lines 16-26; `harness/server.mjs` lines 242-246 and 516-518). |
| V-222468 | APSC-DV-000910 | Initiate session auditing at startup. | Desktop pipes are resumed and not stored by the shell. The server writes a ready line and recovery events for tasks already marked running (`harness/desktop/service.cjs` lines 67-74; `harness/server.mjs` lines 39 and 554-561). |
| V-222471 | APSC-DV-000960 | Log user actions that access data. | Task list, task read, export, and receipt routes do not record the reader (`harness/server.mjs` lines 316-318, 340-342, and 379-385). |
| V-222477 | APSC-DV-001020 | Identify the individual or process for the event. | Persisted task events lack an actor. Terminal text uses `Operator` (`harness/server.mjs` lines 73-77 and 248; `harness/terminal-control.mjs` lines 23-44). |
| V-222486 | APSC-DV-001120 | Shut down by default when audit fails, unless availability is an overriding concern. | A failed removal-audit insert rolls back that transaction and the outer handler returns an error. The listener stays up (`harness/server.mjs` lines 431-443 and 517-519). |

Personal-app acceptance criteria:

- One durable audit schema covers session creation, destruction, renewal, idle timeout, logon success, logon failure, access start, access end, startup, shutdown, task list, task read, export, receipt, artifact download, and removal.
- Each record has a timestamp, a local principal or identified service component, an action, an outcome, and a correlation ID. The correlation ID is not the session token.
- The access file, cookie value, terminal lease, and request body are absent from the record. V-222444 is the matching evidence need.
- Audit storage is separate from the task payload that an ordinary export returns.
- For a personal single operator, the principal may be one local operator identity plus a component name. That does not close organizational unique identity (V-222522).

Conditional acceptance criteria:

- If the owner or ISSO requires fail-closed audit, an audit write failure stops the service and is demonstrated with a disposable store.
- If availability overrides shutdown, the written approval and the fallback or spool behavior exist before the code keeps serving. The current request-level rollback is not that approval.
- Centralized log shipping (V-222482), review, protection, retention, and backup of audit records use the evidence IDs in the audit package. An external collector is accepted only after its coverage is shown. This plan does not assume one exists.

Proposed tests, not run:

- A synthetic audit contract test that performs one success and one failure unlock, one lock, one idle timeout, one startup, one list, one read, one export, and one removal, then asserts actor, time, outcome, and the absence of secrets.
- A failure-injection test for the approved audit-failure policy, on a disposable database only.

Owner decisions: local principal name; whether audit failure stops the listener; retention period; whether an external collector is in scope.

### RP-06. Design transport, cookie flags, and hash modules

Depends on: RP-01 and RP-04. Blocks changes to `Secure`, the listen address, and hashing.

Primary source gaps, all CAT II:

| ID | STIG ID | Requirement | Source read at aad7a49 |
| --- | --- | --- | --- |
| V-222571 | APSC-DV-002030 | Use FIPS-validated modules when generating cryptographic hashes. | Handoff review uses the standalone JavaScript SHA-256 in `harness/portable-sha256.mjs` (entry at line 131, compression loop at line 178). Node `createHash` is a different path and is also not identified here as a validated module. |
| V-222576 | APSC-DV-002220 | Set the secure flag on session cookies. | Browser `Set-Cookie` and Electron `cookies.set` omit `Secure` (`harness/server.mjs` lines 38 and 252; `harness/desktop/main.cjs` line 62; `harness/desktop/service.cjs` line 94). |
| V-222598 | APSC-DV-002460 | Protect confidentiality and integrity while preparing transmission. | The browser origin is built as HTTP and Electron loads it (`harness/server.mjs` lines 37-38 and 554-556; `harness/desktop/main.cjs` line 104; `harness/desktop/service.cjs` line 94). |
| V-222599 | APSC-DV-002470 | Protect confidentiality and integrity during reception. | Browser and local model receives use HTTP (`harness/server.mjs` lines 220 and 554; `harness/direct-local-fetch.mjs` lines 9-19; `harness/desktop/main.cjs` line 104). |

Setting `Secure` on the current HTTP cookie would prevent the browser from storing the session. A flag-only change is not the fix.

Personal-app acceptance criteria:

- The listener remains bound to loopback. No new non-loopback address is added.
- The transport decision is written: keep loopback HTTP for the personal app, or move to an owner-approved local TLS origin.
- If HTTP remains, the plan records that V-222576, V-222598, and V-222599 stay open for any assessment that requires TLS. The cookie keeps HttpOnly and SameSite Strict.
- If local TLS is approved, every cookie issuance path sets `Secure`, both clients use that origin by default, and model receive paths in scope are included.
- An inventory lists every hash implementation, including `portable-sha256.mjs`, Node `createHash`, and experience asset checks. New hash code fails review when it is missing from that inventory.

Conditional acceptance criteria:

- FIPS applicability (V-222571 and evidence rows V-222570, V-222572, V-265634, V-222513, V-222587) is closed only by the approved module, mode, algorithm, and runtime configuration, or by a documented risk acceptance. Node's default configuration is not that evidence.
- At-rest integrity and confidentiality (V-222588, V-222589) and transmitted-information protection (V-222596, V-222597) follow the same deployment decision. WAL files, provider state, and backups are in the data map before any encryption work.

Proposed tests, not run: a cookie fixture that expects `Secure` only when the approved origin is `https`; a static inventory test for hash implementations; disposable TLS checks only after the owner approves the certificate approach. No test weakens origin checks.

Owner decisions: keep loopback HTTP, or approve local TLS; whether FIPS validation is required.

### RP-07. Separate control state from user data

Depends on: RP-04, so the secret moves once to the location the credential design chooses. Useful for the personal app.

Primary source gap:

| ID | STIG ID | Severity | Requirement | Source read at aad7a49 |
| --- | --- | --- | --- | --- |
| V-222626 | APSC-DV-002960 | CAT II | Keep configuration and control files out of the same directory as user data. | Task data, `access.key`, and the owner-lock database share `.state` (`harness/server.mjs` lines 39-48 and 247-253; `harness/workspace-lock.mjs` lines 3-10). |

Personal-app acceptance criteria:

- User task data and the access and owner-control files resolve to different directories.
- A disposable migration test copies a synthetic workspace, opens it once, and still rejects a second opener through the owner lock.
- The migration does not copy `access.key` into an export, backup of task data, or the repository.
- Live owner state is not moved under this plan. A later move of a real workspace needs its own approval.

Proposed tests, not run: disposable directory-layout and second-process lock tests beside `harness/workspace.test.mjs`. No test points at the owner's `.state`.

Owner decision: approve the target directories and any later live migration.

### RP-08. Treat IPv6 as a deployment-profile item

Depends on: RP-01 and RP-06.

Primary source gap:

| ID | STIG ID | Severity | Requirement | Source read at aad7a49 |
| --- | --- | --- | --- | --- |
| V-222634 | APSC-DV-003030 | CAT II | Application services and interfaces must be ready for IPv6 networks. | Server, desktop origin, direct model transport, and inference broker hard-code IPv4 loopback (`harness/server.mjs` lines 554-556; `harness/desktop/service.cjs` lines 85-95; `harness/desktop/main.cjs` line 104; `harness/direct-local-fetch.mjs` lines 9-19; `harness/inference-broker.mjs` lines 65-81). |

Personal-app acceptance criteria:

- The personal deployment decision records IPv4 loopback as intentional. V-222634 stays open for an assessment that requires the DoW IPv6 profile.
- No work item opens `0.0.0.0`, a public address, or a firewall change in order to mark this row.

Conditional acceptance criteria, only when the selected deployment must meet that profile:

- Loopback IPv6 is designed together with the RP-06 origin checks. `::1` and `127.0.0.1` stay loopback.
- The deployed application and its host are checked against the profile the assessor names. Source changes alone do not close the row.

Proposed tests, not run and only if authorized: disposable listeners prove the approved loopback addresses accept a local client and non-loopback addresses are not bound.

Owner decision: whether the DoW IPv6 profile applies.

### RP-09. Gather input-handling and fail-secure evidence

Depends on: none for a static inventory. Executable tests need owner approval and disposable fixtures.

This package is evidence, not a claim that a vulnerability was found or ruled out. The pinned reads show prepared SQLite statements on the task, removal, and draft-copy paths that were opened, and origin checks before mutation (`harness/server.mjs` lines 57-66 and 231-247). Those reads are not a SQL, XSS, CSRF, command, XML, overflow, or race assessment.

CAT I evidence rows: V-222585 fail secure on initialization, shutdown, and abort; V-222601 hidden fields; V-222602 XSS; V-222604 command injection; V-222607 SQL injection; V-222608 XML-oriented attacks; V-222609 input handling; V-222612 overflow.

Other rows in this package: V-222515, V-222567, V-222593, V-222600, V-222603, V-222605, V-222606, V-222610, V-222611, V-222624, V-222656.

Acceptance criteria:

- An inventory names parsers, process launches, SQL call sites, hidden client fields, and error responses for both UIs.
- Any later test uses synthetic data and the existing isolated test style. It does not target the live preview.
- Results are recorded as evidence. A missing scan stays an evidence gap.

Proposed tests, not run: the smallest disposable checks the owner later approves for command boundaries, SQL parameters, and XSS rendering. No network scan.

Owner decision: which checks are worth a later isolated test, and who may run them.

### RP-10. Assemble release and operations evidence

Depends on: RP-01 for which regulated artifacts are required. Document collection can start immediately. Signing, backup drills, and cutover cannot.

The summary's release gaps are evidence needs: deployment architecture, validated cryptographic modules, protected log collection and retention, threat model, incident response, a signed Windows package, and a tested backup and restore. They are not proof that no external document exists, and they are not deployment findings.

Personal-app acceptance criteria:

- A threat-model note covers the local operator, the access file, loopback HTTP, the disabled runner, task data, and exports. It names untrusted model output as data.
- A software list covers Node, Electron, SQLite, and the model tools the release expects to find. Support dates are recorded when the owner has them (V-222658, V-222659).
- Backup and restore steps for a disposable workspace are written and, when the owner approves a drill, rehearsed without using the live preview (V-222592, V-222594, V-222636, V-222637, V-222638, V-222639, V-222640, V-222667, V-222668, plus V-222586).
- Known source gaps in this plan are tracked as open work (V-222652). Tracking them does not close that check.
- Signing identity, public release, and cutover remain separate approvals.

Conditional acceptance criteria:

- Classification markings (V-222643), banners, incident response, and the rest of the governance package are produced only for the regulated deployment named in RP-01.
- Embedded-secret review (V-222642) and default-password review (V-222662) cover the release package, not only the git tree. Test fixtures must be identified and excluded from any package.

Proposed checks, not run: inventory diff against `harness/package.json` and `harness/desktop/package.json`; a later disposable backup drill. No signing and no publish.

Owner decisions: whether a signed Windows release is in scope; where backups go; whether regulated governance documents are required.

### RP-11. Keep the applicability register

Depends on: RP-01. Update the register when the architecture gains a protocol or tier that a likely-not-applicable row mentions.

The CSV labels these 55 checks likely not applicable. This plan does not convert them to met, not met, or a waiver.

CAT I: V-222399, V-222400, V-222403, V-222404, V-222550, V-222555, V-222620.

CAT II: V-222396, V-222397, V-222398, V-222401, V-222402, V-222405, V-222406, V-222426, V-222439, V-222460, V-222466, V-222503, V-222504, V-222505, V-222506, V-222510, V-222517, V-222520, V-222521, V-222535, V-222548, V-222552, V-222553, V-222557, V-222558, V-222559, V-222560, V-222561, V-222562, V-222563, V-222564, V-222565, V-222566, V-222573, V-222584, V-222595, V-222618, V-222628, V-222629, V-222635, V-222641, V-222645, V-222661, V-222665, V-222666, V-222671.

CAT III: V-222436, V-222672.

The seven CAT I rows concern WS-Security timestamps, SAML conditions, PKI certification-path validation, federal cryptographic policy, and a separate network segment for a tiered web server. They become active work if the product adds those mechanisms or that tier. V-222635 stays in this register and is not the same row as the IPv6 source gap V-222634.

Acceptance criteria:

- The register is revisited in the same change that adds SAML, WS-Security, PKI authentication, a new cryptographic mandate, or a multi-tier deployment.
- An assessor confirmation replaces a source-visible label before any formal package relies on it.

Proposed checks, not run: none beyond review of the register when the architecture changes.

## Coverage of the 25 source gaps

| Work item | IDs | Count |
| --- | --- | ---: |
| RP-03 session lifecycle | V-222389, V-222391, V-222392, V-222432, V-222437 | 5 |
| RP-04 credential architecture | V-222542, V-222543 | 2 |
| RP-05 audit capture | V-222441, V-222442, V-222443, V-222445, V-222449, V-222462, V-222464, V-222465, V-222468, V-222471, V-222477, V-222486 | 12 |
| RP-06 transport and hashes | V-222571, V-222576, V-222598, V-222599 | 4 |
| RP-07 control and user data | V-222626 | 1 |
| RP-08 IPv6 profile | V-222634 | 1 |
| Total |  | 25 |

CAT I source gaps are V-222432, V-222542, and V-222543. CAT III source gaps are V-222392 and V-222437. The other 20 are CAT II.

Recommended implementation order after the designs are approved, which this plan does not grant:

1. RP-01 decision.
2. RP-02 remains closed for the life of the runner qualification.
3. Personal designs for RP-03, RP-04, RP-05, and RP-06, reviewed before code.
4. Personal code for idle timeout, legacy Lock or legacy removal, secret-safe audit, and directory separation.
5. Regulated credential, TLS, FIPS, IPv6, identity, and governance work only where RP-01 includes them.
6. RP-09 and RP-10 evidence in parallel with design. Executable tests, signing, and cutover stay gated.
7. RP-11 updated whenever the architecture changes.

## Evidence packages for the 204 needs-evidence rows

Each ID appears once. These rows are not restated as source gaps.

Audit and logging, 57: V-222413, V-222414, V-222415, V-222416, V-222421, V-222431, V-222444, V-222446, V-222447, V-222448, V-222450, V-222451, V-222452, V-222453, V-222454, V-222455, V-222456, V-222457, V-222458, V-222459, V-222461, V-222463, V-222467, V-222469, V-222470, V-222473, V-222474, V-222475, V-222476, V-222478, V-222479, V-222480, V-222481, V-222482, V-222483, V-222484, V-222485, V-222487, V-222488, V-222489, V-222490, V-222491, V-222492, V-222495, V-222496, V-222497, V-222498, V-222499, V-222500, V-222501, V-222502, V-222507, V-222508, V-222509, V-222512, V-222621, V-222622. Owned with RP-05.

Identity, session, and access evidence, 62: V-222387, V-222388, V-222390, V-222407, V-222408, V-222409, V-222410, V-222411, V-222412, V-222417, V-222418, V-222419, V-222420, V-222422, V-222425, V-222427, V-222428, V-222429, V-222430, V-222433, V-222438, V-222514, V-222522, V-222523, V-222524, V-222525, V-222526, V-222527, V-222528, V-222529, V-222530, V-222531, V-222532, V-222533, V-222534, V-222536, V-222537, V-222538, V-222539, V-222540, V-222541, V-222544, V-222545, V-222546, V-222547, V-222549, V-222551, V-222554, V-222556, V-222568, V-222575, V-222577, V-222578, V-222579, V-222582, V-222583, V-222616, V-222619, V-222631, V-222632, V-222642, V-222662. Owned with RP-03 and RP-04. CAT I members are V-222425, V-222430, V-222522, V-222536, V-222551, V-222554, V-222577, V-222578, V-222642, and V-222662.

Cryptography and transmission evidence, 9: V-222513, V-222570, V-222572, V-222587, V-222588, V-222589, V-222596, V-222597, V-265634. Owned with RP-06. CAT I members are V-222588, V-222589, and V-222596.

Input handling and fail-secure evidence, 19: V-222515, V-222567, V-222585, V-222593, V-222600, V-222601, V-222602, V-222603, V-222604, V-222605, V-222606, V-222607, V-222608, V-222609, V-222610, V-222611, V-222612, V-222624, V-222656. Owned with RP-09. CAT I members are V-222585, V-222601, V-222602, V-222604, V-222607, V-222608, V-222609, and V-222612.

Availability and recovery evidence, 10: V-222586, V-222592, V-222594, V-222636, V-222637, V-222638, V-222639, V-222640, V-222667, V-222668. Owned with RP-10.

Governance, release, and data-management evidence, 47: V-222393, V-222394, V-222395, V-222423, V-222424, V-222434, V-222435, V-222472, V-222493, V-222494, V-222511, V-222516, V-222518, V-222519, V-222574, V-222590, V-222591, V-222613, V-222614, V-222615, V-222617, V-222623, V-222625, V-222627, V-222630, V-222633, V-222643, V-222644, V-222646, V-222647, V-222648, V-222649, V-222650, V-222651, V-222652, V-222653, V-222654, V-222655, V-222657, V-222658, V-222659, V-222660, V-222663, V-222664, V-222669, V-222670, V-222673. Owned with RP-01 and RP-10. CAT I members are V-222643, V-222658, and V-222659.

Package count: 57 + 62 + 9 + 19 + 10 + 47 = 204.

## Tests and historical claims

No product test, installer, browser session, or live preview check was run for this plan. The roadmap's earlier counts, including a 288-test workspace suite and the isolated-runner pilot checks, are historical statements in `docs/ROADMAP.md`. They are not STIG evidence and were not repeated.

Proposed test names above are future work. They are not acceptance evidence until they are run and their output is recorded.

## Unverified assumptions

- The CSV assumption that `access.key` is password-equivalent is unconfirmed. V-222542 and V-222543 depend on it.
- The CSV assumption that audit failure must shut down the service is unconfirmed. An availability override would be a separate approval.
- Likely-not-applicable labels are source-visible judgments. An assessor has not confirmed them.
- Electron's omitted `secure` property is read as the cookie call that was written. The desktop cookie was not observed in a running Electron session.
- Archive and XCCDF hashes in the readiness summary were not recomputed.
- Other worktrees and branches were not reviewed. The roadmap says work outside this commit was not treated as integrated.
- No claim is made about the running Dell preview, host firewall, file ACLs on an existing `.state` directory, or external logging.
- The JavaScript SHA-256 and Node `createHash` paths were identified. Their FIPS status was not established.
- `verifyAndBindPatch` was read as a supplied-evidence check. The protected verifier channel was not executed.
