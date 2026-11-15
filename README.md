# CydeWorks AI

**Your AI. Your agents. Your work.**

CydeWorks AI is an experimental, local-first workspace for reviewing AI-assisted briefs and single-file change proposals. This is the latest tested preview snapshot, not a stable release or a finished autonomous coding product.

## What works in this preview

- Create a scoped brief or a one-file proposal, review structural checks, and accept or reject the result.
- Use a synthetic fixture to explore the workflow without calling an AI model.
- Inspect task progress, a per-task attention list, available usage fields, and minimal metadata exports.
- Preview a separately confirmed removal of a task record from the active workspace database. This does not remove provider files or backups and is not secure erasure.
- Open a read-only OpenCode observation surface with Take, Release, Detach, Reattach and Stop controls. The live model path and writable terminal are not qualified.

Recovery, accounting and swarm coordination have synthetic test coverage. The accounting and swarm modules are not connected to real agents or provider billing. No claim is made that the program enforces a secure repository sandbox or local-only network isolation.

## Run the browser preview

Requirements: Node.js 24 and npm. The local browser preview has no runtime package installation step.

1. In the `harness` directory, run `npm start`.
2. Visit <http://127.0.0.1:15371>.
3. When prompted, select the generated `harness/.state/access.key` file. Keep this file and the rest of `.state` private.
4. Choose the synthetic fixture to explore the review flow.

The service binds to loopback. It stores local task records under `.state`; the folder is excluded from this repository. A restart expires browser sessions. Avoid starting two versions against the same workspace.

## Real model and desktop limitations

The Ollama route is held if the local service reports cloud features enabled or its cloud status is unavailable. A reported model digest is checked before dispatch, but a mutable model tag and the absence of OS-enforced network isolation mean this is not proof of offline execution identity. Local models and OpenCode have not passed the intended live coding and detach/reattach qualification.

The OpenCode adapter currently expects an existing Windows executable at `work/paperclip-evaluation/node_modules/opencode-windows-x64/bin/opencode.exe`, relative to this repository root. That executable and its dependencies are not included. The route is unavailable when the file is absent; the fixture remains available. Do not use the preview on sensitive or real repositories until an isolation boundary has been independently qualified.

The Electron desktop directory is source and a dependency lockfile only. Native execution, signed packaging, OS acceptance, update, rollback and cross-platform delivery remain unverified.

## Tests

From `harness`, run `npm test`. The latest complete run of the source used for this snapshot passed 71 synthetic tests. These tests do not establish model quality, protected repository execution or a signed desktop release.

## License

The CydeWorks AI source in this repository is available under the [MIT License](LICENSE).

OpenCode and Ollama are external candidate integrations. Electron is an optional development dependency. None of their source or binaries is bundled in this snapshot, and those projects have their own licenses.
