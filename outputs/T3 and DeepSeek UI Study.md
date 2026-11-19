# BFE Harness+ | T3 and DeepSeek UI study

2026-11-10. Status: VERIFIED for acquisition, scoped static analysis and the local UI observations below. The existing 17-board mockup is rejected by the owner and superseded as a visual direction. This report is a redesign brief, not a finished interactive prototype.

## Recommendation

Use a task-first workspace: a restrained project/session sidebar, a large conversation and artifact area, a compact composer, and an optional inspector. Borrow the interaction principles of T3 Code and DeepSeek Harness while creating an original BFE identity. Put security and cost evidence at the point of action. Do not turn the landing view into a wall of explanation cards.

Begin the redesign with three representative states: a new task, a run waiting for permission, and a completed result with its usage receipt. Review these at actual desktop size before expanding into every secondary screen. The full clickable journey remains a prerequisite to harness implementation.

## What was downloaded and inspected

| Item | Verified acquisition | Execution boundary |
| --- | --- | --- |
| T3 Code v0.1.8 | Official Windows x64 standalone archive; SHA256 matched the release SHA256SUMS | Ran its shipped local server/web client. This was not the Electron installer. |
| DeepSeek Harness Windows installer | Official vendor download; valid Authenticode signer Hangzhou DeepSeek Artificial Intelligence Co., Ltd. | Downloaded but did not run the installer. |
| DeepSeek Harness 0.2.2-rc.1 | Official @deepseek-ai/dsh npm package, task-local install, scripts disabled, lockfile retained | Ran the shipped Web runtime in an isolated task profile. This does not establish byte equivalence with the downloaded installer. |

T3 archive SHA256: `347066125898DD1FE0265816D0480B038A301973C0F85B6E49967C0E29710F3F`.
DeepSeek installer SHA256: `830947F8996DC05D991CA9133FFF4D3400073E47B9CFA6507754867E79482B23`.

Downloaded packages and local analysis are retained under this chat's `work/harness-inspection`. No global install, model download, provider login, paid model call or real project import was performed. The software was acquired online; the UI study used localhost and no inference. This was not an air-gapped or network-isolation verification.

Sources: [T3 official release](https://github.com/pingdotgg/t3code/releases/tag/v0.1.8), [T3 repository](https://github.com/pingdotgg/t3code), [DeepSeek Harness official site and download](https://www.deepseek.com/en/harness/), [DeepSeek Harness source](https://github.com/deepseek-ai/deepseek-harness).

## Direct computer-use observations

| Surface | T3 Code v0.1.8 | DeepSeek Harness 0.2.2-rc.1 | BFE design implication |
| --- | --- | --- | --- |
| Task entry | Narrow sidebar, project grouping, central task prompt; allows starting without a project | Session/workspace tree, central composer, workspace and preset selectors | The task is the primary object, not a dashboard metric. |
| Composition | Wide, quiet input with provider setup when unavailable; attachments, voice and permissions nearby | Attachments, workspace access, model and send controls live in/around the composer | Keep context, routing, access and budget visible in a compact control row. |
| Secondary work | Thread details, terminal and right panel toggles | Collapsible right panel with tabs, split/fullscreen controls, workspace files and terminal entry | Use an inspector that can be closed. Preserve conversation width. |
| Permissions | Draft displayed Full access. Menu offered Supervised, Auto-accept edits, Auto and Full access | Default showed Workspace Write; menu offered Read Only, Workspace Write and Full access | Default BFE to a constrained review state; show exact paths/actions and one-time scope. Menu observation is not enforcement proof. |
| Usage | Dedicated overlay, Cost/Tokens/Limits, provider/environment filters and periods. Cost labels include cached/uncached input, output and cache savings | Settings expose Compact/Detailed performance and usage; detailed work display and collapse behavior | A short per-run receipt should open a detailed ledger. Separate cache savings from routing savings. |
| Settings | Searchable category navigation; structured rows and grouped controls | Smaller category list; general settings expose detail level, busy-send behavior and coding view | Use progressive disclosure, preserve keyboard discoverability, and explain consequential settings locally. |
| Extensions | Provider and environment settings visible, not enabled during inspection | Built-in plugins list exposed session/global composition and enabled/disabled state | Inspect capability scope before enablement; do not confuse installed with permitted. |

T3 onboarding discovered existing agent history despite a separate base directory. Its import checkbox was initially selected. It was explicitly unchecked, and no projects or threads were imported. Isolation of app state alone therefore did not prevent discovery. BFE should require an explicit source selection before discovery/import of unrelated history.

DeepSeek's General settings displayed session-log upload to improve its models/products as enabled when using its official model API. No API was configured and no model message was sent. This is an observed setting, not a network-traffic finding. BFE should expose local storage, provider submission and optional diagnostics as separate decisions.

Observed limitations: T3's cost view remained in a skeleton state during this inspection, so no populated chart or cost calculation was validated. DeepSeek had no configured models. Neither application generated a response, executed an agent tool, produced a diff, or demonstrated a live usage receipt. These flows need a separately authorized test or an explicitly labeled synthetic replay. Do not present blank-screen inspection as a full end-to-end benchmark.

Screenshots retained beside this report: `t3-home.jpg`, `t3-composer.jpg`, `t3-settings.jpg`, `t3-usage.jpg` (loading state), `deepseek-composer.jpg`, `deepseek-sidebar.jpg`, `deepseek-settings.jpg`, `deepseek-usage-controls.jpg`.

## REA findings and evidence boundary

Applied the reverse-engineer-anything skill and connected REA JavaScript analyzer to the shipped T3 web client and the installed DeepSeek token-meter package. This was scoped artifact analysis, not a security audit or complete reconstruction.

T3 selected index and settings/home/appearance bundles. The graph hit its configured semantic-node limits; 961 inventoried files were outside the selected analysis. DeepSeek selected package metadata and `dsh-token-meter/lib/index.js`; 748 inventoried files, largely dependencies, were outside scope. The selected DeepSeek JS parsed without failure; this does not validate every runtime path.

DeepSeek's shipped meter uses separate uncached-input, cache-read, cache-write and output buckets. Updates replace the prior usage sample for the same attempt rather than adding repeated samples. A retry event clears that replacement slot so retry usage can add to totals. The code sums disjoint buckets without adding reasoning tokens again on top of output. Context measurement can use a provider usage baseline or an estimate. These are static implementation findings, not billing reconciliation results.

Reference documentation: [DeepSeek token-meter package](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/token-meter/README.md), [token-meter subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/token-meter.md). Current branch documentation may differ from the inspected npm release; artifact findings above use the installed release.

Canonical REA evidence IDs:
- T3: `ev_e17bf5fa6cf2bd871920358157b3d6bae5394da3b3918ea157d4921a88d4345c`
- DeepSeek: `ev_589472f7b7c65ba1f0bba4239e150dc54594b492ab0d17661ec37d80bba6e59f`

The local bundle `work/harness-inspection/rea-evidence.json` contains five records, 55,554,967 bytes. Do not upload raw runtime logs, app state, bootstrap authentication data or dependencies to Drive. Export metadata's unknown count is not a claim of complete coverage; the analysis limitations above still apply.

## Proposed visual direction

Working direction: restrained developer workspace with charcoal surfaces, readable warm-white text, a single cool accent and semantic status colors. No neon dashboard, large decorative metric tiles, repeated bordered paragraphs or marketing hero. The reference products suggest this direction, but there is no evidence yet that it meets the broader market's preferences.

- Desktop shell: approximately 240 px collapsible sidebar; 48 px task header; flexible conversation/artifact area; optional 360 px inspector. At narrower widths, the inspector becomes a drawer rather than squeezing the task.
- Typography: 14-16 px working text, 12-13 px supporting metadata with adequate contrast, 20-24 px task headings. Use actual icons, consistent spacing, and short labels. Avoid using long text blocks as fake controls.
- Sidebar: workspace switcher, new task, search, grouped recent sessions, then usage and settings. Run status is visible without exposing private task content unnecessarily.
- Composer: goal/input, selected context chips, model/router control, access scope and spending cap. The primary action describes the next step. Details open anchored menus or drawers.
- In progress: current step, completed/remaining steps where known, elapsed time, heartbeat, meaningful counters and measured rate. ETA and projected local completion only when evidence supports them. Waiting for approval, provider wait, stalled, failed and complete are distinct states. Never simulate a trustworthy countdown.
- Result: readable answer or diff first, evidence and tests nearby, then a compact cost/time receipt. Detailed traces do not displace the useful output.

The initial three states must contain real interface components and coherent synthetic task content, not explanatory documentation presented as screens. Test empty, long-content, denied, failed, cancelled and narrow-width variants before scaling the system.

## Usage and router inspector contract

Show total job cost and elapsed time at the top, with a label for provider-reported, estimated or unavailable data. Expand into attempts, model/provider, input/output/cache/reasoning categories, tool costs, retries, fallback, cancellation and infrastructure allocation. Reasoning is a subset or separate category according to the provider contract, never blindly summed twice. Preserve price version and currency.

Every router decision shows: eligible models, exclusions caused by privacy/capability policies, selected model, reason, intended tradeoff, fallback path and user override. A router must not silently relax a privacy boundary to recover from failure.

Cost saving = comparable baseline cost minus total routed job cost, including routing calls, retries and tools. Report negative savings too. Label a price-only comparison as an estimate. Measured savings require matched tasks, quality acceptance, dated prices and a stated sample. Time saved requires measured end-to-end baseline and routed completion, including review/retries. Never infer time saved from token price or model speed alone. Avoid showing a percentage if the baseline is zero or unavailable.

Synthetic review example retained from the earlier plan: USD 0.024 versus estimated baseline USD 0.040 is 40% lower estimated cost, while seven seconds slower. Label both outcomes and the unverified quality comparison. It is not product performance evidence.

## Flag Design clickable prototype status

The Flag Design chat reviewed the capability gap and wrote a concrete plan: `D:/Codex/Flag-Design/docs/superpowers/plans/2026-11-10-clickable-prototypes.md`. Current editing, artboards, save/recovery and static export exist. Clickable product flow support was not implemented by this coordination request.

Proposed smallest addition:
1. Saved project prototype metadata: start artboard plus labeled source-layer links.
2. Navigate, Back, swap state, open overlay and close overlay actions.
3. Inspector controls and revision-checked MCP operations, with atomic Undo.
4. Shared preview behavior and local HTML playback; no arbitrary scripts or external destinations in links.
5. Keyboard activation, focus handling, Escape/back behavior, validation for missing targets, save/reopen, and malicious-label tests.

The Flag Design chat estimated 12-18 engineering hours for that feature and tests, plus half to one day to wire an approved mockup. This is its planning estimate, not a delivery commitment. Application implementation scope remains a separate decision; this chat requested assessment and a plan only.

## Next development gate

1. Review three redesigned principal states using this study and the owner's critique.
2. Resolve the Flag Design prototype feature implementation scope.
3. Complete task creation, route explanation, permission approval/denial, run progress, result/diff review, usage inspection, and data export/deletion preview journeys using synthetic data.
4. Verify pointer and keyboard navigation, focus/overlays, persistence, local offline playback, responsive layout and failure/recovery. Provide a click-path checklist and known limits.
5. Obtain owner acceptance of the interactive mockup before harness coding. Then evaluate engine adapters against the product contract rather than merging multiple agent runtimes by default.

No study result establishes production readiness, actual router savings, provider billing accuracy or enforced security controls in BFE.
