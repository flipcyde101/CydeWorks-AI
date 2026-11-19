# CydeWorks AI project instructions

Read `docs/ROADMAP.md` and the relevant code before changing this project. The application source is in `harness/`. The standalone isolated-runner pilot is in `research/isolated-runner-20261118/` and is not yet qualified for general repository execution.

Before supervising T3 work, follow [the CydeWorks T3 dispatch rules](docs/T3-DISPATCH.md). The coordinator owns route verification, quota holds, and routing a failed task to an available included builder.

Use separate branches or worktrees for independent changes, with one owner per file scope and a clear integration review. Run focused tests and the applicable full suite. Report what was actually verified, including any live or synthetic limits.

Protect the running preview and its data. Do not read or publish runtime state, credentials, private records, or access files. Do not stop processes you did not start. Never publish, deploy, merge to the default branch, delete owner data, change credentials or connected services, or spend money or paid compute without the owner's specific approval. Included subscription usage may be used for authorized work.

Follow the owner's current instructions and applicable parent guidance. Never use the em dash character in authored content.
