# T3 delegated execution boundary

Status: unreviewed design evidence. No operating-system policy, WSL configuration, provider connection or credential was changed. This document does not authorize delegated coding, target execution or browser staging.

## Why the hold remains

Two T3 workers reported processing project-controlled code on the Windows host despite instructions to use the verified offline sandbox. One ran a syntax check and one ran tests. The latter branch remains held. A prompt, a worktree, or the parent's decision to run tests separately does not prevent a provider or its descendants from executing target code on the host. The operational hold in [T3-DISPATCH.md](T3-DISPATCH.md) remains in force.

Claude's post-reset design proposed an online edit zone and a separate offline execution zone using WSL. This is an option to investigate, not an implemented or independently reviewed boundary. The [T3 Code v0.1.10 installation guide](https://github.com/pingdotgg/t3code/blob/v0.1.10/docs/user/install.md) documents choosing a WSL distribution for agents and installing provider CLIs there. It does not establish that this machine has an isolated environment or that provider actions are confined.

## Constraints that the proposal must prove

- **Provider and child execution:** Identify the exact process that applies the policy before the provider starts, and prove that its restrictions cover descendants, already-open handles and alternate execution paths. The provider may need an interpreter or embedded runtime. An executable-file allowlist alone does not prove that an allowed interpreter cannot run project code in the same process. This is an inference from the [Linux Landlock documentation](https://docs.kernel.org/next/userspace-api/landlock.html), which distinguishes execute and read permissions and notes that files opened before restriction are not covered by those filesystem restrictions.
- **Windows and WSL access:** Microsoft's [WSL configuration documentation](https://learn.microsoft.com/en-us/windows/wsl/wsl-config) says disabling automatic drive mounting does not itself prevent manual mounts. Interop settings, mounts, shared WSL resources and the actual provider launch must therefore be checked at runtime. Separate WSL distributions must not be represented as independent machines or as proof of isolation.
- **Online versus offline:** The provider connection may need network access. The target-test process must have none beyond its isolated loopback, and must not inherit provider credentials, browser state, the Docker socket or a path to the canonical checkout. A provider-side network allowance is not proof that a target subprocess is offline.
- **Writable scope:** The editing process may change only its assigned worktree. Import must bind the exact base and bounded patch bytes, reject unsafe paths and modes, and preserve the user's other work. A test container receives a separately exported, hash-verified source snapshot as read-only data and scratch-only writable storage.
- **Limits and recovery:** A qualified execution path must impose and verify a wall deadline, memory, CPU, process and file-size limits for the full process tree. A failed preflight, unconfirmed termination or ambiguous result stays unresolved and cannot authorize a retry or integration.

## Evidence before resuming delegated coding

1. Record the exact provider, executable, environment, permission mode and process tree. Verify the enforcement mechanism on the installed host, not just its documentation or a model's description.
2. With owner-authorized disposable canaries, demonstrate that disallowed host execution, unauthorized paths, inherited handles and unwanted network routes are denied. Include a negative control that deliberately lacks the boundary and causes the preflight to refuse work. Do not use destructive, denial-of-service or out-of-scope tests.
3. Verify the offline test sandbox before every target run: network isolation, read-only source and toolchain, scratch-only writes, minimal environment, missing credential and management sockets, non-root identity, and the required limits. Record the exact commit and test results.
4. Give the actual enforcement evidence and the final candidate diff to an independent Codex GPT-6.2 Sol High reviewer. Retain the runner Stop, recovery, verifier and patch-binding gates before any browser staging.

Installing a distribution or provider CLI, signing into a new environment, changing a security policy or network setting, and any paid service remain subject to the owner's applicable per-action approvals. No such change is made by this design note.
