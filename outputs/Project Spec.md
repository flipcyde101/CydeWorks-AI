# BFE Harness+ | Project Spec

Updated 2026-11-10. This current contract supersedes the earlier brief-only product proposal retained below.

## Current product

A local personal DevSecOps agent workspace for Dillon, with an eventual community product considered after personal usefulness is demonstrated. Proposed engines: Hermes for coordination and OpenCode for coding, with selected DeepSeek Harness metering patterns and OpenClaw integration/background-work patterns. Engine selection and exact modules remain subject to adapter, license and security review.

Core capabilities: project/task continuity, source-linked artifacts, scoped permissions, inspectable context, owner-controlled memory, versioned skills, integrations, recoverable jobs, detailed cost receipts and honest routing comparisons.

## Required product behavior

- Exact proposed actions and data destinations are visible before approval. Model instructions cannot grant permissions.
- Local storage and remote inference are clearly distinguished. User exports and deletion receipts cover active data, derived indexes, backups and upstream status separately.
- Task progress reports measured counters, rates, heartbeat, elapsed time and justified ETA. Output is accessible when ready even if usage settlement is pending.
- Usage can be inspected by project, task, engine, model and attempt, including failures, retries, tools, cache and reasoning where reported.
- Estimated context attribution, price estimates, actual provider usage and reconciled charges have separate labels.
- Router savings include overhead, escalation and quality requirements. Counterfactual estimates stay distinct from paired measurements; a cheaper route can be slower.
- DevSecOps connects the source change to tests, findings, review, artifact provenance and release approval. Patch approval does not deploy.
- The brief builder preserves source IDs, exposes unsupported claims and allows edits/export as one bounded workflow.

See [Development Plan v2](https://drive.google.com/file/d/1aaX9FRuAs2HwYso3rRgcg6SezTdscHdm/view) for architecture, event/data contracts, milestones and acceptance tests.

## Current scope and design gate

Authorized now: planning, source research, synthetic offline test materials and Flag Design mockup. Production coding, actual model experiments, new credentials/integrations, spending and release remain gated.

Seventeen desktop design boards exist. Clickable product behavior, mobile states and full accessibility verification remain open. The design is not evidence of implemented security, provider compatibility or savings.

## Historical exploration retained for reference

The material below records the initial commercial brief-builder/ad exploration. It is not the active implementation scope. Its facts and terms need refresh before any future adoption.

## Audience and positioning

| Audience hypothesis | Recurring job | Reason to test or defer |
| --- | --- | --- |
| Independent operators and small agency owners | Turn messy notes into weekly decision briefs and assigned next steps | Easy to recruit around a recurring job and compare with existing chat. Start with non-sensitive material. |
| Developers and technical creators | Summarize public change notes or technical research into a review brief | Clear workflow and possible sponsor fit. Model switching and repo workflows already have strong incumbents. |
| Students and budget-first casual users | Stretch a usage allowance | Ads may sound appealing, but willingness to pay, abuse risk, and age-related restrictions complicate a first pilot. Defer. |

## Product approaches

1. **Ad-free workflow:** One repeatable template, exportable brief, transparent usage estimate and receipt, hard caps. Test subscription with capped usage as a price hypothesis. BYOK could be a second-stage alternative where permitted. The user pays the provider directly and pays us for the workflow, if priced that way.
2. **Direct sponsorship:** A fixed campaign budget underwrites a limited pool of eligible tasks. Use first-party static creative with a clear “Advertisement” label on an optional progress or funding surface. No trackers, user-level advertiser reports, or click incentives. Test buyer interest and minimum contract value. A static card can disappear as soon as the output arrives. Funding a cohort can work without measuring a minimum watch time.
3. **Rewarded web inventory:** Explicit opt-in to a disclosed reward on a provider-supported surface. Google’s full-screen format and close behavior make it a poor default for the work surface. If validated, use a separate Earn screen with bounded redemptions, or a separate optional surface that never obstructs the answer. Do not assume the network supports an embedded quiet rewarded card.

## MVP proposal

Private ad-free prototype, one workflow, one candidate API adapter and one fixture/replay adapter. Paste plain text, show estimated maximum usage, stream the brief, let users cancel, export Markdown, and show a receipt. The brief includes evidence references to numbered input segments and flags missing facts. Start with public or synthetic samples. Exclude file uploads, repositories, autonomous tools, integrations, live checkout, balances, and ads from the first prototype. Candidate model and pricing require approval and comparison with a baseline.

## Proposed architecture

- **Work path:** Web client → authenticated app API → job controller → provider adapter → streamed output. Version adapter model IDs, pricing and allowed features. Server-held provider credentials stay in a secret manager. BYOK, if approved later, uses separately scoped encrypted credentials or provider-supported delegated auth, with per-user revocation. Consumer sessions are outside the design. Any cross-provider retry requires an allowed route with equivalent data controls and user expectations.
- **Metering:** Reserve a maximum before dispatch, enforce per-job/account/day limits, record provider request ID, model, cache/read/write usage where available, total output including reasoning, tool charges, pricing version, and outcome per attempt. Release unused reserve after authoritative settlement. On disconnect or timeout reconcile the upstream attempt before retrying. Record ambiguous charges as pending and reconcile against provider reporting, including costs on failed jobs.
- **Credits:** Future, account-bound entitlements with no cash-out, transfer, third-party redemption or provider-account funding. Separate paid entitlements from promo grants. Append-only integer-unit ledger with grant, reserve, capture, release, expiry and correction entries. Atomic reservations prevent overspending. Use idempotency keys on grants and debits. Publish clear reward amount, eligible usage, expiry if applicable and support route. Start with a bounded allowance rather than selling stored balances. Consider the cost of both subsidized runs and displaced paid usage.
- **Ad path:** Keep an optional separate-origin surface with no work cookies, shared storage, prompt IDs, sensitive URLs, or task content. Prefer self-hosted static sponsor assets. Before any network pilot, verify vendor support for isolated placement and callback identity. Use strict CSP and referrer policy, host-only cookies and origin-checked messages with a minimal schema, or a separate page if iframe behavior is incompatible. The work app never waits for a view, grant, consent decision, or ad request. Avoid passing campaign metadata to prompts, tools, model routing or answers.
- **Reward verification:** Server issues a short-lived opaque nonce tied internally to the account, campaign, entitlement and expiry. Validate callbacks using the vendor’s documented authentication, identifiers and replay controls. Correlate a single eligible grant and consume the nonce atomically. Client timers, clicks and UI events alone never mint durable credits. Before launch prove the callback delay fits the published reward timing. Later advertiser invalid-traffic adjustments belong in publisher settlement. Do not silently claw back a promised valid reward.
- **Fraud and audit:** Limits per account and campaign, daily liability cap, rate limiting, duplicate detection and manual review of anomalies using minimal metadata. Pause new offers when verification or settlement drifts. Audit price changes, grants, reversals, administrative actions and consent/version events with role-scoped access. Keep content out of financial telemetry, ad events and sponsor reports. Reconcile billed impressions, reward grants, redemptions and provider spend independently. Define retention, deletion and access controls before private inputs are accepted.

Architecture is a proposal. The initial workflow can be tested with replay fixtures before choosing infrastructure, a provider contract, or a repository.
