# CydeWorks AI

**Your AI. Your agents. Your work.**

CydeWorks AI is an experimental, open-source AI workspace. The goal is to bring models, agents, workflows, permissions and usage information together while keeping the user in control. The current version is an early preview for scoped briefs and single-file change proposals, not a stable release or a finished autonomous coding product.

## What works in the current preview

- **Scoped tasks and review:** Create a brief or a one-file change proposal, approve the source snapshot, inspect structural checks, and accept or reject a result. The synthetic fixture exercises this flow without an AI model. Citation-number and text checks do not prove factual or code correctness.
- **Local records and recovery holds:** Tasks and review history are stored locally in SQLite. Uncertain provider outcomes hold automatic retry so an interrupted request is not silently dispatched again.
- **Attention, progress and usage:** The preview groups attention by task, distinguishes waiting and possible stalls, and shows available per-attempt usage fields. Missing provider data is shown as unavailable rather than zero.
- **Data controls:** Preview and export minimal metadata, or separately confirm removal of a task record from the active workspace database. Removal does not erase OpenCode files, backups or provider copies and is not secure erasure.
- **Terminal observation:** A read-only event panel exposes Take, Release, Detach, Reattach and Stop controls. The interaction design was demonstrated separately in a synthetic prototype; the current live sequence and writable terminal still need qualification.

An OpenCode adapter and a direct Ollama adapter are present, but the latest local model and OpenCode tests did not qualify a reliable live coding route. The accounting ledger and swarm coordinator have synthetic test coverage only; they are not connected to real agents or provider billing. This preview does not establish a secure repository sandbox or local-only network isolation.

## Still in development

- A qualified local model and OpenCode route, followed by supported connections for additional models, providers and eligible subscriptions.
- A protected repository runner, multi-file changes, independent checks, complete process termination and safe recovery after interruptions.
- Full terminal input with enforced ownership, plus live detach, reattach and takeover verification.
- Coordinated agent execution, dependency-aware delegation, and selected Paperclip or connector workflows.
- Detailed provider receipts, budget enforcement, model routing, and evidence-based comparisons of cost and time.
- Reviewed memory and skills, broader data lifecycle controls, backup and restore, and accessible signed desktop distribution.

These are product goals, not claims that the features are already available.

## Inspirations and reuse

CydeWorks AI combines ideas from several projects. The table distinguishes external adapters from design inspiration; a reference does not mean its code is included or its product is integrated.

| Project | Influence and current status |
| --- | --- |
| [OpenCode](https://github.com/anomalyco/opencode) | Coding-agent sessions and execution. An adapter can invoke a separately supplied OpenCode executable configured to deny tool use; the live route still needs qualification. |
| [Ollama](https://github.com/ollama/ollama) | Local model serving and reported usage. A loopback adapter is present; real routes are held when cloud status is enabled or unknown and still need qualification. |
| [Herdr](https://github.com/herdrdev/herdr-core) | Terminal observation, detach and reattach, and attention grouping. CydeWorks AI implements its own preliminary controls; it does not include Herdr Core. |
| [T3 Code](https://github.com/pingdotgg/t3code) | A task-centered workspace and accessible usage information informed the preview design. No T3 Code source is bundled. |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | Detailed token, cache and attempt accounting informed the usage view. Provider billing reconciliation and demonstrated savings are still planned; no DeepSeek Harness source is bundled. |
| [Paperclip](https://github.com/paperclipai/paperclip) | Agent organization, task ownership and factory coordination inform the roadmap. No Paperclip integration is present. |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Reusable skills and persistent memory inform planned user-controlled memory and skills. No Hermes integration is present. |
| [OpenClaw](https://github.com/openclaw/openclaw) | Connectors and background-job lifecycle inform planned integrations. No OpenClaw integration is present. |
| [bot-hq](https://github.com/nickvasilescu/bot-hq) and [Swarms](https://github.com/am-will/swarms) | Agent visibility and dependency-aware delegation are research inputs for future coordination. Neither project is integrated into the current runtime. |

OpenCode and Ollama run as separate software when configured. Their code and binaries, and those of the other reference projects, are not bundled in this repository.

## Run the browser preview

Requirements: Node.js 24 and npm. The local browser preview has no runtime package installation step.

1. In the `harness` directory, run `npm start`.
2. Visit <http://127.0.0.1:15371>.
3. When prompted, select the generated `harness/.state/access.key` file. Keep this file and the rest of `.state` private.
4. Choose the synthetic fixture to explore the review flow.

The service binds to loopback. It stores local task records under `.state`; the folder is excluded from this repository. A restart expires browser sessions. Avoid starting two versions against the same workspace.

## Real model and desktop limitations

The Ollama route is held if the local service reports cloud features enabled or its cloud status is unavailable. The direct Ollama adapter uses a dedicated loopback connection that ignores environment proxy settings. This does not establish OS-enforced network isolation or constrain separate runtimes. A reported model digest is checked before dispatch, but a mutable model tag means this is not proof of execution identity. Local models and OpenCode have not passed the intended live coding and detach/reattach qualification.

The OpenCode adapter currently expects an existing Windows executable at `work/paperclip-evaluation/node_modules/opencode-windows-x64/bin/opencode.exe`, relative to this repository root. That executable and its dependencies are not included. The route is unavailable when the file is absent; the fixture remains available. Do not use the preview on sensitive or real repositories until an isolation boundary has been independently qualified.

The Electron desktop directory is source and a dependency lockfile only. Native execution, signed packaging, OS acceptance, update, rollback and cross-platform delivery remain unverified.

## Tests

From `harness`, run `npm test`. The latest complete run of the source used for this snapshot passed 76 synthetic tests. These tests do not establish model quality, protected repository execution or a signed desktop release.

## License

The CydeWorks AI source in this repository is available under the [MIT License](LICENSE).

OpenCode and Ollama are external candidate integrations. Electron is an optional development dependency. None of their source or binaries is bundled in this snapshot, and those projects have their own licenses.
