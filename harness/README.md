# CydeWorks AI local workspace

**Your AI. Your agents. Your work.**

The Dell preview now serves the reviewed experience interface, with Workspace Lock, recoverable run submissions, verified downloads and aggregate receipt analytics in Usage. The preview starts with `BFE_UI=experience`. The startup setting `BFE_UI=legacy` selects the older UI for rollback. The Dell cutover preserved the three saved tasks and verified the served asset hashes. [Open the preview](http://127.0.0.1:15371/) · [Delivery and test evidence](../work/first-usable-20261118/DELIVERY.md)

Session-lock source update, 2026-11-17: the authenticated backend can now lock every workspace view and release terminal control while approved work continues. Delayed requests cannot mutate the workspace after their session is revoked. All 277 synthetic tests and independent review passed. Claude's UI and the running preview remain unchanged. See [the session-lock contract](SESSION-LOCK.md).

Verified contributor source integration, 2026-11-17: authenticated backend interfaces now expose the reviewed Qwen cost formatter and Antigravity portable handoff review planner. These are read-only processing interfaces, not billing proof or permission to create or run imported tasks. Claude's UI and Gemini's repair candidate are unchanged. See [the integration contract](CONTRIBUTOR-INTEGRATION.md).

Real local workflow checkpoint, 2026-11-17: an isolated current-source host passed a real OpenCode plus Qwen3-4B Q4 workflow through review, acceptance, receipt and downloads, including terminal controls. The existing frontend separately passed the real-model browser journey with proposal editing and reload. A route-bound receipt hash incompatibility discovered live was fixed; all 271 synthetic tests pass. The existing preview was not restarted. This proves a bounded one-file proposal workflow, not autonomous repository editing or a completed replacement UI. See [evidence and remaining integration work](../work/verified-pieces-integration-20261117/HANDOFF.md).

Accepted download source update, 2026-11-16: an authenticated read-only endpoint now returns accepted content or a regenerated patch bound to the current task version, attempt and artifact hash. It preserves UTF-8 content and line endings, rejects stale proposals and applies nothing. Claude's UI and the running preview are unchanged. See [download contract](ARTIFACT-DOWNLOAD.md).

Route binding source update, 2026-11-16: approved run requests may now include the selected route revision. The backend rechecks the route before dispatch and records a failed preflight if it changed. Lost-response replay cannot remove or replace the binding. Existing clients remain compatible; no frontend or running preview was changed. See [route binding and its limits](ROUTE-INVENTORY.md).

Route inventory source update, 2026-11-16: model inventory now exposes stable revisions for material route facts and a separate freshness window. Clients can detect changed routes without clearing approval on every ordinary poll. Revisions grant no execution permission, and Claude's UI still needs its approval-binding repairs. See [route inventory contract](ROUTE-INVENTORY.md).

Run submission source update, 2026-11-16: API clients can attach a task-scoped request ID and recover the recorded attempt after a lost response without launching duplicate work. The record survives restart and does not clear unknown-outcome holds. This is backend support awaiting Claude's UI integration. See [run submission recovery](RUN-SUBMISSIONS.md).

Router and readiness source update, 2026-11-16: reviewed Gemini evaluation and Antigravity qualification engines now have authenticated backend interfaces. Synthetic evaluation reports cannot dispatch work. Task readiness uses host inventory and keeps untested capabilities and isolation unverified. See [the integration contract](ROUTER-READINESS.md). Claude's UI and the running preview are unchanged.

Receipt bridge source update, 2026-11-16: the authenticated, read-only `GET /api/tasks/:id/receipt` endpoint now returns a version 2 export envelope containing a version 1 Inspector run and evidence, or structured reasons when records cannot support a receipt. Model labels are withheld, interrupted outcomes need explicit recovery evidence, and unknown costs remain unknown. Timestamps are run-relative by default; `?timebase=epoch` explicitly includes wall-clock values. Receipts contain correlatable derived identifiers and are not anonymous or signed. Exporting changes no task state. This backend integration has no new UI control and does not update the already-running preview. See the receipt section in REGRESSION.md for verification scope.

Draft reuse source update, 2026-11-16: Scope and data now includes Copy as new draft. It reuses original input without copying results, approvals or routes, holds unresolved source attempts, and recovers lost responses using a deduplicated request identity. All 145 synthetic tests and the browser recovery flow passed. The existing Dell preview has not been restarted to load it. Copy-reference metadata remains after removal to prevent an old request recreating a deleted copy; the removal preview discloses that retention.

Terminal source update, 2026-11-16: control commands now require an attempt ID and ownership generation, preventing stale takeover and Stop requests. Detach remains a local observation action even if lease release fails. This update passed 132 synthetic tests and a two-view browser check; it has not been loaded into the existing Dell preview or tested with a real worker this round. See [terminal regression checks](REGRESSION.md).

## Earlier preview checkpoints and operating notes

The source in this folder is a work in progress, not a finished or signed desktop release. On 2026-11-14 the owner approved a restart of the browser preview at `http://127.0.0.1:15371`. That process served the then-current assets, rejected an unauthenticated API request, and preserved the three saved task records. It started before the CydeWorks AI rename, so it retains the previous display name until a safe restart. The restarted session requires unlocking again. Do not start another service against the same workspace.

The data controls include a minimal metadata export and a separately confirmed task-record removal preview. Removal affects only the active workspace database record. OpenCode files, backups and provider copies remain, and SQLite storage may retain recoverable pages. The removal flow was tested only with disposable synthetic records.

The latest synthetic tests cover the fixture workflow, cautious restart recovery, export preview, usage summaries, progress states, and isolated accounting and swarm foundations. The accounting and swarm modules are not connected to real providers or workers. They do not enable paid calls or autonomous repository edits.

The current preview holds real model routes when Ollama reports cloud features enabled or cannot report their status. At the latest read-only check, the existing Ollama service reported cloud features enabled. Ollama's reported preflight digest does not prove execution identity because the model tag can change, and network isolation has not been verified.

The source now makes direct Ollama requests through a dedicated loopback connection that ignores environment proxy settings. This does not constrain OpenCode or establish OS-level network isolation. The running preview predates this change and needs a safe restart to load it.

The latest live direct Ollama check returned the unchanged source, so that model has not passed the coding-quality check. The latest live OpenCode checks did not complete the detach and reattach scenario. Do not treat the current source as a qualified local coding route until those failures are resolved and retested. The terminal surface currently provides observation and run controls, not a general interactive shell or writable repository runner.

The desktop source has a private startup handoff tested with a synthetic service. The native Electron window, signed package, OS acceptance, restart recovery and cross-platform delivery remain unverified. The executable downloaded for local development is unsigned and must not be treated as an approved release.

Run `npm start` from this folder with Node 24, then visit <http://127.0.0.1:15371>. Select `.state/access.key` through the workspace access prompt. Keep the state folder private. The key stays local, and the browser session expires when the service restarts.

Create a source brief or a one-file change proposal. Inspect the source snapshot, choose an available route and approve the run, then review the result and checks. Accept to download the result or patch. Metadata export is a separate action. A real model route must pass the qualification described above before it is relied upon.

The OpenCode terminal opens read-only. **Take control** gives this view exclusive access to Check status and Stop. **Take over** transfers control from another view after confirmation. **Release** gives up control. **Detach** closes the terminal view and leaves the run active. **Reattach** opens it read-only. **Stop** asks for confirmation, then waits for the managed OpenCode process to exit. The terminal records that exit independently of Ollama's process state. Each lease expires after 15 seconds without a heartbeat.

Connection loss now shows a stale-state notice and retries state reads with a bounded backoff. Commands and approvals are never replayed. Task actions stay disabled until the saved state is reconciled. The browser drops its control token on a read failure; the server's previous lease may remain until its heartbeat expires. An expired workspace session shows the access-file prompt. After unlocking, observation resumes read-only. Reloading the same tab reopens its last task using a task ID in session storage, without saving source text there. Receipt disclosures and keyboard focus survive ordinary polling. This is browser reconnection, not recovery of a worker after a server or machine crash.

The OpenCode adapter sends the approved user instruction through stdin and attaches only the reference source. Requests are not included in the process command-line arguments. Proposal checks are structural. Human review must still establish accuracy, source support and whether the task was actually completed.

The preview uses SQLite under `.state`, with no third-party packages. The model adapter sends the approved snapshot to the existing Ollama service on loopback and uses the model's reported token counts and timings. Ollama model availability, model size and available RAM affect dispatch. The preview requires available RAM above model file size plus 1.3 GB. The fixture runs without Ollama. Local comparisons use accepted attempts on the same task and report observed request time, with no claim about savings on other tasks.

The change workflow returns a replacement for one supplied snapshot. Acceptance confirms the configured text check and the operator's review. Brief checks validate citation references, while source support still needs human review. The OpenCode adapter uses the existing 1.18.34 binary from the workspace's Paperclip evaluation. It starts OpenCode with a dedicated state directory, external plugins disabled, a single configured loopback Ollama provider, and a deny-all tool policy. The terminal exposes run controls only. OS-level confinement remains required before enabling a writable repo or shell. Approved input and OpenCode session artifacts are retained under `.state/opencode`. Treat this directory and the SQLite workspace as private local data.

Run `npm test` to verify the synthetic workflow and adapter contracts. The optional `BFE_LIVE_TEST` mode is intended to exercise a local model, but the latest attempts failed before detach and reattach could be verified. Investigate the recorded failure before repeating it. Process isolation, broader terminal input, restore, richer data lifecycle and signed packaging remain in the completion plan.

## Provider connections

The planned setup is **Settings → Connections → Add connection**. Use the provider's supported sign-in or API setup. Each connection has a label, provider, account or project identifier, allowed models, data destination and billing type. A task picks one connection and model and shows those details before approval. A retry can select a different approved route and receives its own receipt.

The first candidates are Google Antigravity CLI for eligible Google AI personal subscriptions, Claude Code for eligible Claude subscriptions, and a separate Google Cloud project route. Each candidate requires verification that its official integration permits this use, including headless execution and quota visibility. A consumer account, organization entitlement and paid API connection have independent setup and limits. CydeWorks AI will show provider-reported values when exposed and hold a task at an exhausted quota rather than switch to metered billing automatically. This preview exposes the local routes only.

- [Google's personal subscription transition](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
- [Antigravity sign-in](https://antigravity.google/docs/install)
- [Claude Code plan access](https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan)

## License

Project source is available under the [MIT License](LICENSE). External projects and dependencies retain their own licenses.
