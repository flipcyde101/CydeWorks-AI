# BFE Harness+ Completion Plan

Version 3.0 | 2026-11-11 | Owner and Claude review draft

## 1. Outcome and authority

Build Dillon's personal, model-agnostic DevSecOps workspace on the Dell. It must turn a scoped request into useful work, preserve user control, explain resource consumption, and recover safely. Reuse suitable open-source engines and components. Harness+ owns the consistent workflow and enforcement across them.

This is the proposed delivery baseline following Claude's independent review. It supersedes the sequencing in the November 11 implementation draft and the earlier v2.4 development roadmap. Historical evidence remains intact. Approval of model agnosticism establishes a requirement, not approval to send data to every provider. This document does not start implementation, paid calls, installations, security changes or deployment.

There are two completion milestones:

- **Personal pilot complete:** one qualified coding engine and local model can execute a scoped task, produce a protected test result and reviewable patch, recover after interruption, and explain usage. The operator can observe, detach, reattach and stop execution. Ten comparative tasks establish whether it is useful.
- **Personal release complete:** terminal Take/Release, qualified model routing, data lifecycle controls, memory and skills, the brief builder, selected orchestration/connector capabilities, and a signed Windows delivery with recovery documentation pass their release gates. Requested features remain tracked until delivered or explicitly changed by Dillon.

A public/team SaaS launch, ads, sponsorship, commercial credits, billing customers, broad autonomous external actions and production deployments are separate future product decisions. The personal release does not require them.

## 2. Product requirements

| ID | Required outcome | Acceptance evidence |
| --- | --- | --- |
| R01 | One workspace for projects, tasks, context, patches and artifacts | A task survives UI/service restart with its identity and review history intact |
| R02 | Model and provider independence | Two qualified model configurations execute the same task contract; provider-specific fields remain attributable |
| R03 | Engine independence | Fixture and OpenCode implement a versioned engine contract; no OpenCode-specific state is required in core task records |
| R04 | User control of data | Preview included/excluded context and destinations; local-only mode blocks every unapproved outbound route |
| R05 | Useful scoped permissions | One task-scope grant permits bounded routine work; additional authority requires a separate, exact action decision |
| R06 | Safe terminal control | Read-only entry; visible owner; Take and Release; exclusive writer; Detach differs from Stop; reattach read-only |
| R07 | Clear attention and progress | One Needs you item per task; measurable progress, heartbeat and honest ETA; failures have safe recovery paths |
| R08 | Detailed usage receipts | Project/task/attempt breakdown, provenance, retries, tools, context/cache/reasoning when reported, timing and unresolved fields |
| R09 | Credible model routing | Show selected route, eligibility, reason, user override, fallback rules, quality threshold and measured versus estimated savings |
| R10 | Reliable change evidence | Diff and protected checks tied to the exact revision; test/config changes visible; stale review invalidated |
| R11 | Continuity and recovery | No automatic duplicate dispatch after uncertain execution; preserve partial work and reconcile before retry |
| R12 | Controlled memory and skills | Inspect source, scope, version and proposed persistent changes; approve, reject, revoke and export |
| R13 | Reusable workflow beyond coding | Ad-free brief builder produces editable, source-linked briefs and flags unsupported claims |
| R14 | Lab/factory interoperability | Selected Paperclip/OpenClaw integration or equivalent bounded capability is qualified without duplicate task authority |
| R15 | Sustainable personal delivery | Install, update, rollback, backup/restore, dependency inventory, signature verification and support evidence |

The design uses a dark gunmetal Black Flag scheme, restrained backglow and familiar desktop hierarchy. Accessibility, readable contrast and reduced motion take precedence over decorative effects. The primary layout is a project/task rail, central work surface and optional context/usage inspector.

## 3. Evidence baseline and limits

Existing local records describe a clickable synthetic terminal prototype, a live Herdr terminal walkthrough, a Paperclip local trial, supervised Q3/Q4 samples and a receipt normalizer. These are inputs to engineering, not proof of a completed Harness+ product. This planning pass read the current implementation plan, source feature matrix, project spec and development roadmap. It did not repeat their runtime experiments.

Claude reviewed the previous plan text without its linked local evidence. The review is architectural evidence, not implementation approval. Exact upstream versions, APIs, licenses and host compatibility must be rechecked in the relevant adoption package.

The current planning directory is not a Git repository. Do not silently initialize it as the product repository. At kickoff, inventory any existing designated private checkout and agree the product path. Prefer E:\Codex for new runtime/build state where the owner-approved storage plan and drive checks permit it; keep planning records here until an approved cutover. Never migrate live state as part of a documentation update.

## 4. Reuse and component ownership

Favor supported APIs, then independently testable modules. Fork upstream only for a documented blocker with an upgrade strategy. Do not combine multiple independent supervisors into one undocumented execution path.

| Source | Proposed reuse | Harness+ responsibility | Adoption point |
| --- | --- | --- | --- |
| OpenCode | Coding engine, session/tool interfaces and change workflow | Scope, action policy, task authority, evidence and adapter mapping | P02/P05 |
| Ollama and llama.cpp | Existing local inference runtimes | Endpoint policy, model capabilities, health, resource admission and normalized usage | P02/P05/P08 |
| Herdr Core | PTY lifetime, replay and attach/detach where qualified | Exclusive input broker, owner visibility, lease expiry, Stop and attention grouping | P06/P07 |
| Hermes | Selected memory/skill interfaces or modules | Provenance, project scoping, review, revocation and lifecycle | P09 |
| Paperclip | Supported orchestration API for a named factory workflow | One execution authority and ledger per route, exact mapping and reconciliation | P10 |
| OpenClaw | One selected connector or background-job interface | Destination permissions, credential references, recovery and explicit external-action boundaries | P10 |
| T3 Code | Navigation/session/diff patterns; modules only after qualification | Unified product UX and attribution for any imported code | P01/P03 |
| DeepSeek Harness | Usage/context/caching patterns; qualified metering modules | Provider semantics, unknown handling, complete-attempt accounting and savings evidence | P06/P08 |
| bot-hq | Comparative input for factory visibility and coordination | Verify source and use case before adopting code | P10 inventory |
| React, Node, SQLite, Git | UI, local service, durable state and repository operations | Integration, migrations, security configuration and maintenance | P02/P03 |

Each adoption record must contain canonical repository URL, exact commit/package version, license and notices, imported paths or API surface, Windows compatibility, capabilities exercised, data/network footprint, dependency risks, maintenance owner and rollback. The source names above are candidates rather than a blanket claim of compatible open-source licensing. Model-weight licenses are reviewed separately from inference-runtime licenses. No numeric reuse percentage is claimed before the bill of materials exists.

Qwen is a candidate model family, never a hardcoded requirement. Codex or other engines may be added through supported, authorized interfaces. A consumer subscription is not assumed to permit API usage, credential extraction or session portability.

## 5. Architecture and model agnosticism

```text
Workspace UI
  -> Local control service: tasks, grants, journal, receipts, evidence
     -> Policy and route planner
        -> Engine adapter: fixture / OpenCode / later qualified engine
           -> Isolated runner and mediated tools
              -> Approved inference endpoint or restricted model gateway
                 -> Provider adapter: Ollama / llama.cpp / authorized cloud
     -> Controlled artifacts, SQLite and operator-only secret references
```

Core records use stable task, attempt, action, session, event, artifact and route IDs. Keep engine/provider IDs in adapter mappings. A model switch creates a new attributed attempt or an explicitly supported continuation; it never rewrites the old receipt. A handoff exports a reviewed summary and selected artifacts. Hidden reasoning, unsupported provider state and engine-private session formats are not assumed transferable.

**Engine contract:** capabilities, start with durable idempotency key, event subscription/replay, cancel, reconcile and artifact collection. Missing required capabilities disqualify a route. OpenCode may own its provider transport; its adapter must still enforce the declared endpoint and normalize the reported metadata. Do not create a second competing inference path merely to fit the diagram.

**Provider contract:** supported models, local/remote classification, context limit, tool/structured-output/image support, generation parameters, usage fields, cancellation limits and error classification. Similar API shapes do not establish equivalent behavior. Qualify exact model/runtime/version combinations, including quantization and prompt/tool template.

**Router:** first filters by allowed destination, data policy, required capabilities, context size, budget and host capacity. It then ranks eligible routes by measured quality, cost and latency. Show exclusions and selection reasons. A user override cannot bypass policy. No eligible route means a clear hold, with a useful next action. Never silently send local-only work to cloud or escalate to a more expensive route without an applicable grant and cap.

Start with manually selected routes. Add shadow recommendations before automatic selection. Route version, candidate set and selection reason are stored with each attempt. Provider fallbacks, retries and corrections count toward the outcome cost and time.

## 6. Security and data contracts

### 6.1 Prove the runner boundary before depending on it

P02 compares feasible isolation candidates on the actual Dell. A worktree, a separate clone, Node, a Job Object, WSL or a VM label alone is insufficient proof. Candidate combinations must address process lifetime, filesystem access, network access, credentials and child processes. WSL requires deliberate host-drive and Windows-interoperability controls. A VM or sandbox requires explicit shared-folder, clipboard and network configuration.

Use a separate attempt clone or staged source snapshot with independent metadata. The runner must not write the main checkout, common Git metadata, operator credentials or control-service storage. Broker-side extraction treats the entire attempt as untrusted; it must avoid attacker-controlled hooks, filters, textconv, config and executable helpers. Prefer a trusted extraction path with sanitized environment/config and inert patch rendering. The exact method is tested, not inferred from a command-line flag.

The runner may reach only a qualified inference interface and explicitly allowed tools. An inference-only gateway must reject administration, model downloads, arbitrary proxying, redirects and alternate destinations. The runner cannot reach approval mutations or read operator credentials. Bind the control service to loopback, authenticate it, and retain browser Origin/Host/CSRF protections as a separate layer.

Test allowed coding and npm test behavior alongside denied out-of-scope reads/writes, junction/symlink escapes and swaps, child-process escape, unauthorized egress, approval self-service and resource exhaustion. Include inference connectivity in the same experiment. Stop/timeout must terminate the owned process tree; an unverifiable stop is shown as unresolved. No OS protection is weakened to get a passing result.

### 6.2 Two levels of permission

**Scope grant:** one explicit approval for a task attempt, pinned to the source revision, allowed roots, operations, tools, endpoint destinations, resources and policy version. Routine reads/writes/tests within the qualified boundary do not prompt repeatedly. The grant ends on completion, cancellation, revocation, scope change or its approved maximum run duration. A service restart holds resumption until grant validity and process identity are established.

**Boundary grant:** Allow once or Deny for a specific additional action. Digest includes action type, arguments, resolved destination, scope revision and policy version. Proposed expiry is five minutes after approval and before dispatch; consume atomically with the durable execution claim. Scope change, revocation or mismatch invalidates it immediately. Expiry does not undo an already started action. Use monotonic validity within a process and invalidate unconsumed grants on restart; test clock change and sleep/resume explicitly.

Operations outside the runner remain blocked unless a specific broker capability exists and is authorized. An Allow button never grants arbitrary host shell access. Installation/fetch can execute package scripts and therefore requires its own declared dependencies and network scope. Preprovisioned pinned dependencies are preferred for offline tests.

Resolve paths and enforce scope at the operation itself using the selected OS boundary and safe handle semantics. A string-prefix check or validate-then-open sequence is inadequate.

### 6.3 Terminal ownership

Only the authenticated owner can take terminal control in the personal release. Agents and viewers cannot grant themselves operator authority. Team roles are a later design. Every connection starts read-only. Taking control issues a generation-bound lease, invalidates the previous writer and suspends engine input. All input paths pass through the broker. Herdr integration is disqualified for writable use if a direct attach path bypasses this rule.

Proposed lease: heartbeat every 5 seconds, revoke after 15 seconds without a heartbeat. Release, disconnect, Stop and service restart revoke it. Reattach is always read-only. These timings must be usability-tested on the Dell. The displayed owner follows authoritative lease state, not a client label. Releasing human control requires an explicit Resume agent action before engine input resumes. Human commands remain inside the same execution boundary.

Detach closes the view and retains execution. Stop requests process termination, revokes input and reports confirmation or unresolved state. Preserve authorized history and partial artifacts. One Needs you entry per task aggregates reasons, including approval, recovery and control conflicts.

### 6.4 Data lifecycle

Preview exactly which context is sent and to where. Exclusions affect model context, tools, memory and exports, not only the UI list. Default telemetry is metadata-only and opt-in external diagnostics remain separate. Provider adapters disclose their retention limits; local deletion cannot promise provider deletion.

Inventory Harness+, OpenCode, inference-runtime, temporary, crash-dump and backup stores. Redirect only supported locations within authorized setup. Seed privacy sentinels and test all controlled stores. Record any OS-managed location or retention limitation explicitly. Raw sessions stay excluded from ordinary exports unless separately selected; merely listing a store in a manifest does not upload its contents.

Proposed default: retain accepted work until owner deletion; retain failed-attempt content for 14 days only under an explicitly approved retention policy; retain minimal audit metadata according to an owner-selected policy. Until deletion policy is approved, provide reviewable deletion candidates without automatic cleanup. Export preview lists files, hashes, omissions and destination. Deletion reports local, backup and upstream status separately. Secrets are references, never prompt/log/export content.

## 7. Accounting, evidence and recovery

The first pilot uses direct OpenCode and one Harness+ ledger. Paperclip integration later must select one execution and financial authority per task. Imported records are attributed projections, never additional charges. Migration requires matching source IDs and totals plus a rollback point.

Usage receipts distinguish reported, estimated, reconciled and unavailable values. Capture model/version/quantization when known; input/output/cache/reasoning fields with provider semantics; context categories when measurable; queue/load/prefill/generation/tool/test/review time; retries; cancellations; and tool costs. Do not sum overlapping timing spans or count reasoning twice when included in output. Unsupported fields remain unavailable. Raw hidden reasoning is not required.

Local inference may have zero provider charge while consuming electricity and hardware resources. Show these separately, and estimate energy only with a disclosed measurement/model. Included subscription usage is not equivalent to a known API price. Preserve price version, currency and integer cost units.

For paid routes, reserve a conservative configured upper bound transactionally before dispatch. Unknown pricing or unenforceable caps hold the route. Apply per-attempt, task and period caps, explicit retry limits and late settlement. Price updates do not rewrite historical rates. Unsettled cancellation retains the appropriate reservation until reconciled.

Required ledger fixtures: partial 12 then final 20 then replay stays 20; final before partial stays 20; same event ID with changed payload conflicts; failed 7 plus retry 13 totals 20; unknown is not zero; concurrent reservations cannot overspend; late usage after cancellation remains attributed. A 24-cent result versus a hypothetical 40-cent baseline is a 16-cent/40% estimated saving. A 42-second result versus 35 seconds is 7 seconds slower.

Freeze protected acceptance checks independently of the agent's editable tests. Execute both inside the qualified boundary. Hash the source snapshot, patch, protected test set, command/config, environment and results. Flag test, package-script and CI modifications. Repository tests alone cannot certify acceptance. Review rejection creates a new linked attempt. Accepted does not imply merged or deployed. If the target base moved, hold application and rerun review/checks against the new base.

Persist attempt and action claims before execution. Idempotency conflicts on changed payloads. A closed stream proves neither completion nor cancellation. Unknown execution is held for reconciliation. For purely isolated work, a new attempt may start only after the old process is confirmed stopped and evidence/partial work is preserved. External actions require durable provider identity and outcome reconciliation. Never delete an uncertain attempt to make recovery appear successful.

## 8. Delivery sequence and estimates

Estimates are planning allowances for one builder, not promised elapsed dates or progress ETAs. A focused day means roughly six hours of implementation/verification effort. Reviews, approval waits, dependency changes and hardware constraints can extend elapsed time. Re-estimate after P02 and P06. Every package is split into reviewable changes of roughly 0.5 to 2 focused days before execution.

| Package | Deliverable | Dependencies | Focused days |
| --- | --- | --- | ---: |
| P01 | Scope, source register and accepted core prototype | Owner plan review | 2-4 |
| P02 | Isolation and inference feasibility decision | P01 scope; action-specific setup approval | 2-4 |
| P03 | Core contracts, state and fixture workflow | P01/P02 | 3-5 |
| P04 | Review, protected evidence and recovery | P03 | 3-5 |
| P05 | Qualified OpenCode/local inference route | P02/P04 | 3-6 |
| P06 | Pilot receipts, observe/recovery and data controls | P05 | 3-5 |
| P07 | Pilot decision and exclusive terminal control | P06 | 4-7 plus 2 pilot weeks |
| P08 | Model qualification, routing and budget enforcement | P06; pilot decision | 5-8 |
| P09 | Memory, skills and brief builder | P06; pilot decision | 4-7 |
| P10 | Selected factory integration and reconciliation | P08/P09 | 4-7 |
| P11 | Hardening, signed delivery and restore | P07-P10 | 4-7 |
| P12 | Owner acceptance and stabilization | P11 | 2-4 plus 1 observation week |

P01-P06 total 16-29 focused days to pilot entry. Full P01-P12 total 39-69 focused days plus three observation weeks and approval/dependency delays. At five focused days per week, that is roughly 11-17 calendar weeks including observation if work stays sequential. This is a range, not a delivery commitment. A hardware or isolation failure changes the estimate before the main build.

Critical path: approved scope -> isolation -> contracts -> evidence -> real engine -> pilot -> remaining personal-release capabilities -> release -> owner acceptance. P08 and P09 are technically separable, but the default execution remains one builder. Do not start parallel agents automatically.

## 9. Executable work packages

### P01 Scope and design

Context: the existing mockup proves selected synthetic terminal interactions. The complete owner design gate is open. Inventory the latest Flag Design document and supported clickable tooling. Use a companion preview only with owner's acceptance of that review surface.

Tasks: reconcile source versions and licenses; choose private checkout/runtime path; document the architecture decisions; refine five primary journeys: scope/resume, patch review, receipt/comparison, data exclusion/export, and recovery/terminal ownership. Keep memory/skills, brief and factory screens in the subsequent design backlog.

Exit: Dillon can identify destinations, deny added scope, review a patch, distinguish Detach from Stop, Take/Release control in the mockup, and explain measured versus estimated usage. Keyboard, focus, reduced motion, 200% zoom and narrow layouts work. Record the exact approved prototype revision. Rollback: keep previous design revisions; no runtime cutover.

### P02 Isolation feasibility

Context: the main architecture depends on actual process confinement. No fixture can prove it. Inventory compatible mechanisms without changing OS settings, then prepare the exact setup/reversal actions for owner approval where required.

Tasks: run one pinned OpenCode task and test subprocess in a disposable synthetic source copy; allow only the intended model route; execute the adversarial boundary checks from section 6. Measure startup time, peak RAM/VRAM, responsiveness and Stop latency with the model loaded. Compare practical candidates within a four-day investigation budget.

Exit: allowed work succeeds and denied paths have observed enforcement; the engine cannot self-approve; stop confirms the owned process tree ended; selected mechanism and fallback are documented. A focused security review examines actual configuration and results. If no candidate passes, hold live execution and present a narrower typed-tool or isolated-host alternative. Rollback restores only explicitly authorized configuration changes and preserves evidence.

### P03 Contracts and offline workflow

Context: the runner decision is known; implement an engine-neutral core before provider details. Proposed modules: apps/workspace, packages/core, packages/runner, packages/adapters and tests.

Tasks: schema/migrations for tasks, attempts, grants, events, artifacts and usage; transactional admission and journal sequence; fixture engine; scope approval; task timeline and progress; one attention item per task. Define named verification commands in the selected repo, mapping to existing tooling where possible: check, test:contract and test:offline.

Exit: deterministic accepted/denied/interrupted UI journeys; duplicate start/replay cannot duplicate work; schema incompatibility does not overwrite state; unknown values display honestly. Rollback: migration rehearsal from a disposable verified backup, and feature disablement without deleting source evidence.

### P04 Protected evidence and recovery

Context: a reviewable patch requires trustworthy evidence and safe application. Tasks: protected acceptance-test mounting/execution; inert diff extraction; revision/hash binding; review accept/reject; changed-base conflict flow; crash injection around claim, dispatch and completion; preserved partial artifacts; export preview and isolated restore.

Exit: malicious test/config changes cannot manufacture protected passes; no host-side execution of untrusted test code; stale reviews are invalidated; no silent redispatch; restore recovers matching IDs/hashes without replaying actions. Verify unsafe Git metadata cannot affect the main checkout or trusted extractor. Rollback: retain the base branch and original artifacts; patch application remains explicit.

### P05 Real local engine

Context: qualify direct OpenCode first, using a pinned existing local runtime/model where suitable. No new model download or provider spend is implied.

Tasks: supported engine adapter; model endpoint constraints; session mapping; structured tool behavior; event/usage normalization; cancellation and process reconciliation; missing-field tests; one running coding attempt by default. Resource admission must hold a run that cannot fit the approved host budget instead of freezing the desktop. Preserve OS security and report command-runner policy rejection with its actual reason.

Exit: a fresh synthetic change completes through the same UI with actual patch, protected tests and receipt; denial/timeout/model unavailable/restart cases pass. Run check, test:contract, test:offline and the explicit real-local test:adapter mode. Each result records revision, engine/runtime/model versions and actual exit status. Rollback: disable real adapter and retain fixture mode, without changing existing lab services.

### P06 Pilot controls and receipts

Context: one qualified route exists. Tasks: read-only terminal and replay; Detach/Reattach/Stop; identity validation after reconnect; receipt drilldowns and timing spans; privacy sentinel inventory; context exclusions; export/restore; meaningful progress and stalled/waiting states.

Exit: no input is accepted through observe paths; reattach preserves task identity and opens read-only; Stop has verified result; receipt totals match raw provider evidence without duplicate accounting; export excludes configured content; restored metadata cannot silently resume execution. At this gate the pilot can begin. Rollback: disable optional terminal surface while keeping durable task evidence.

### P07 Pilot and terminal ownership

Context: establish actual usefulness before adding many integrations. Run the pilot in section 10. Implement exclusive terminal input only after the observe/recovery surface qualifies.

Tasks: brokered writer lease, owner label, Take/Release and Resume agent; stale generation rejection; two-view contention; heartbeat/disconnect/restart cases; clipboard/input size policy; kernel-enforced scope remains unchanged under human input. Do not treat operator terminal access as blanket host approval.

Exit: one writer in all race cases, agent input suspended during human control, old writers rejected, reattach read-only, no direct writable bypass. Pilot proceed/revise decision documented. Rollback: return to read-only terminal and preserve continuity. Take/Release remains NEEDS WORK until requalified, rather than being silently removed from release scope.

### P08 Model independence and routing

Context: the task core must remain portable and usage claims must be defensible. Tasks: capability registry; two qualified model configurations; provider adapter contract tests; reviewed handoff; manual model selection and shadow routing; measured comparisons; opt-in automatic routing; paid budget/reservation fixtures and settlement.

Exit: both configurations pass the shared task suite; inappropriate model/capability combinations are rejected with reasons; local-only cannot fall back remotely; model switches preserve attempt provenance. Router decisions include all retries and overhead. A cloud route is enabled only after its data/spend/credential authorization and live qualification. Without that authority, mark cloud execution and settlement pending; never claim production cloud support from mocks. Rollback: pin a known route and disable auto-selection.

### P09 Memory, skills and briefs

Context: reuse Hermes where its interface qualifies. Tasks: reviewed memory proposals with source/scope/version; explicit skill permissions and pinned content; deletion/revocation; source-grounded brief workflow with editable output and export. Treat imported skills and memory as untrusted data, never authority to change permissions.

Exit: project isolation, conflicting memories, stale skills and prompt-injection fixtures pass. Run the existing 20 brief cases, resolve B18 scoring ambiguity and preserve B13 inference limits before scoring. Add a fresh holdout; no unsupported factual assertions may pass as sourced. Record editing time and the full rubric results. Five interviews remain an optional owner-authorized research activity, not fabricated user validation. Rollback: disable memory/skill application and retain reviewed artifacts for inspection.

### P10 Factory interoperability

Context: add a concrete factory use case, such as importing one Paperclip task for scoped execution and returning an evidence reference. Qualify a disposable instance and preserve the owner's current lab.

Tasks: pin Paperclip/OpenClaw sources; choose one bounded workflow for each desired integration; map IDs/ownership; test replay, cancellation, revocation and uncertain outcomes; apply connector destination limits. A fake/synthetic connector proves contracts only. If the named source fails qualification, document whether a thin supported alternative meets the requirement; owner approval is needed to remove a requested capability.

Exit: exactly one execution and accounting authority, zero duplicate dispatch after reconnect, no board approval bypass of runner policy, and no messages/publication beyond explicit authorization. Rollback: disable integration, retain original IDs/receipts and keep direct OpenCode usable. No migration of existing factory records until separately scoped and verified.

### P11 Hardening and delivery

Context: functional completion requires operational reliability. Tasks: dependency/license/SBOM review; secret scanning; focused security review; accessibility pass; idle and busy resource tests; offline boot; update/rollback and interrupted migration tests; backup restore; disconnect/power-loss simulation in disposable environments; signing and packaging using an existing approved identity where available.

Exit: no unresolved critical permission/data defects; signature and final hash verified; actual Windows execution acceptance separately demonstrated; install/update/rollback preserve tasks and settings; restore works without external side effects; supported OS/runtime/model matrix and known limits published in the private handoff. Never weaken Smart App Control or other protections. Rollback: last verified package plus compatible state backup; no automatic destructive downgrade.

### P12 Owner acceptance and stabilization

Context: finish with a usable product and a reproducible handoff. Tasks: Dillon runs a new coding task, reviews its checks, changes an allowed model, inspects usage, takes/releases terminal control, excludes data, exports a brief and restores a disposable backup. Observe one week of ordinary use with explicit fault reporting.

Exit: R01-R15 are individually VERIFIED or explicitly owner-approved as deferred with reason and next milestone. The default claim of a complete personal release requires all required outcomes verified. Hand over source revision, signed package, hashes, dependency register, runbook, tests, recovery guide, model scorecard and open limitations. Close the development milestone only after owner acceptance. Routine maintenance becomes a separately scoped backlog, not an endless completion phase.

## 10. Pilot methodology and model quality

Freeze ten task families and paired equivalent variants before execution. Use the same model/configuration and acceptance criteria in the workflow comparison. Counterbalance order, record cold/warm runs and dependency state, and report unavoidable learning effects. Compare different models separately from different interfaces.

Measure task setup, approval count/time, review/correction time, retries, time to an accepted result, elapsed execution, usage and failures. Interaction timestamps support estimates of active time; they do not prove cognitive effort. Use an explicit work timer with idle handling and operator correction. Keep local event metadata, not global activity or keystroke contents.

Proposed success threshold: at least 8/10 Harness+ tasks accepted and no more than one fewer accepted than baseline, zero critical permission/privacy violations, and at least 25% lower median active operator time on successful pairs. Report all ten tasks, failed/capped effort, exclusion reasons and aggregate completion rate alongside the paired subset. A 10-task personal study is directional evidence, not a market claim. Safety failures stop the affected route; weak productivity results trigger one bounded revision and rerun rather than indefinite tuning.

Hypothesized savings: less manual setup, fewer repeated permission prompts, faster evidence review and less recovery effort. Measure those components directly. Routing savings require equivalent accepted outcomes. If a cheaper model creates more review effort, show the tradeoff.

Local models receive small bounded tasks with frozen checks. Record first-pass quality, revised quality, interventions and resource use. Models do not approve their own work, alter protected checks, merge or expand scope. The existing Q3/Q4 scorecard is prior evidence; a new model/runtime/quantization or tool-template change triggers affected requalification.

## 11. DevSecOps and change control

Use one private product repo, specific staged paths and work/review branches. Inspect push workflows before the first push; keep deployment, merge and publication separately gated. No force push. Run staged secret scanning, license/dependency checks and applicable tests. Keep source, runtime state, credentials and archives separated.

Every change records requirement IDs, scope, acceptance evidence, affected contracts and rollback. Medium-risk changes get one focused Reviewer or Claude review; high-risk security/privacy/release changes get the required independent review and Claude when routed by Dillon. Planning self-check does not claim an independent review. No review chains or automatic multi-agent fleet.

Progress UI must show current/completed/remaining steps, known done/total counters, measured rate, elapsed time, last activity and heartbeat. ETA and projected local completion appear only when measured; distinguish current-step from overall. Test unknown totals, stalled work, waiting for approval, slow progress, failure/retry and final verification. If the host app closes, the worker/tracker lifetime must be established independently.

Stop at a repeated unexplained failure after two attempts, regressions, exhausted package budget or missing authority. Preserve diagnostics and present the smallest decision needed. Do not try an alternate host/path to evade a security rejection. Hold only the affected branch where independent authorized work can continue.

## 12. Review disposition

| Claude item | Disposition in this plan |
| --- | --- |
| B1 isolation sequencing | P02 precedes contracts that depend on the runner; inference access and resource cost included |
| B2 self-approval | Separate operator authority and denied runner access; live malicious-client test |
| B3 Git metadata leakage | Independent clone/snapshot and trusted inert extraction; common metadata inaccessible |
| B4 approval fatigue | Scope grant plus exact boundary action grants; approval effort measured |
| M1 self-certified checks | Protected acceptance set, sandboxed execution, test/config diff flag |
| M2 path race | Enforced resolution at operation; junction swap race test |
| M3 upstream stores | Complete supported-store inventory, sentinel checks, disclosed exceptions |
| M4 Paperclip too early | Direct OpenCode first; named interoperability in P10 |
| M5 pilot validity | Equivalent variants, explicit measurement, all failures, numerical quality threshold |
| M6 excess scope | Five core journeys first; requested terminal/routing features retained with delivery gates |
| M7 recovery simplification | Bounded retry after confirmed stop and preserved evidence; durable external reconciliation |
| R1 rejection | Review rejection creates a new linked attempt |
| R2 post-acceptance | Explicit application/branch workflow and moved-base revalidation |
| R3 operator auth | Separate runner identity/access boundary plus local browser protections |
| R4 expiry | Monotonic in-process validity; restart invalidates unconsumed grants; sleep tests |
| R5 storage durability | Qualify SQLite WAL/FULL with backups and external-drive failure simulation; no durability guarantee from settings alone |
| R6 ordering | Final-before-partial and changed-payload conflicts included |
| R7 progress | Shared progress contract applies to qualification and pilot tooling |

## 13. Decisions and handoff

Proposed defaults: Windows/Dell first; private local-first product; OpenCode first engine; local inference first; one running coding attempt; owner-only terminal control; five-minute boundary grant; no ads or commercial credits; direct local ledger; scoped data and no silent provider fallback.

Before implementation, Dillon approves the revised scope and interactive design revision and selects the private checkout. P02 then requests only the concrete OS/install/security actions its evidence requires. Provider credentials, paid usage, external integration changes and release actions remain separately scoped. The goal is a few meaningful decisions, not repeated commands for Dillon to paste.

The builder performs authorized setup, tests and diagnostics directly where tools permit. When a command runner or OS blocks an action, report the exact action and reason and prepare one consolidated owner action if unavoidable. Never claim a saved setting fixed runtime behavior without a live check.

At each package boundary update the plan status, decisions, source register, test evidence and handoff. Track status as NOT STARTED, IN PROGRESS, VERIFIED, NEEDS WORK or BLOCKED with a concrete cause. New requirements get an ID, estimate and explicit impact on completion; no untracked expansion. At present all P01-P12 execution packages are NOT STARTED under this revised baseline.

```text
BFE Harness+ restart handoff
Read Completion Plan v3.0 and the owner-approved design revision first.
Scope: model-agnostic personal DevSecOps workspace; reuse qualified open-source components.
Current authority: planning and review; implementation approval remains pending.
First engineering dependency: P02 runner/inference isolation, following approved scope/setup.
First live route: direct OpenCode and one local authoritative ledger.
Preserve terminal Take/Release, Detach/Stop, data ownership and granular usage as requirements.
Use existing historical artifacts as bounded evidence; requalify exact dependencies before adoption.
For the next package record requirement IDs, branch/revision, tests, limits and rollback.
Do not resume old goals, change live services, spend, send or deploy from this handoff alone.
```

## 14. Evidence and technical references

- Previous implementation draft: docs/superpowers/plans/2026-11-11-bfe-harness-plus.md in this workspace.
- Historical capability roadmap: outputs/BFE Harness Development Plan.md, version 2.4.
- Design coverage: outputs/BFE Harness Source Feature Matrix.md and outputs/BFE Harness Prototype QA.json.
- Runtime observations: outputs/Herdr Live Walkthrough.md; Paperclip trial section in the historical roadmap.
- Model evaluations: work/bfe-qwen-work/REVIEW.md and reviewed-fixtures.json; receipt seed in work/local-run-receipt.
- Claude review: owner-supplied independent review dated November 11, 2026, reproduced by finding ID in section 12.
- Microsoft Windows Sandbox configuration: https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file
- Microsoft WSL configuration: https://learn.microsoft.com/en-us/windows/wsl/wsl-config
- Git worktree reference: https://git-scm.com/docs/git-worktree

The technical references informed the prior review. Refresh their version-specific applicability at P02. This plan specifies required tests and proposed decisions; it does not assert that any candidate sandbox, provider or imported module has already passed them.
