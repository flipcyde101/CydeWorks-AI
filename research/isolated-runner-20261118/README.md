# Isolated runner pilot

This folder contains the source of a standalone November 18, 2026 experiment. The experiment exercised a disposable two-file repository using OpenCode and a local Qwen model. It is not a general-purpose repository runner or an integrated product feature.

The original pilot evidence reported 18 boundary checks and 12 passing candidate behavior checks. Its binaries, runtime environment, logs, claims, and results are not included here. Windows-initiated Stop, controller restart recovery, and integration into the browser approval and review flow remain open.

The two synthetic baseline files are preserved in `fixtures/`. To prepare a new disposable pilot, copy those files into a new `fixture-repo/` directory alongside this README. The pilot initializes that directory as a separate synthetic Git repository if needed. Never point it at a real repository. The recreated commit will have its own identifier, which the pilot records and binds to its scope. Runtime downloads and generated artifacts are excluded by the local `.gitignore`.

The qualification probe also expects a `host-marker.txt` file beside the pilot scripts. Use only a newly created, non-sensitive synthetic marker for that check; the file is ignored by Git.

`extract-runtime.sh` is an experimental historical helper. A clean extraction can create non-executable files even though the helper expects executable files, so its setup needs repair and verification before another live pilot.

From the repository root, `node --test research/isolated-runner-20261118/pilot.test.mjs` checks the proposal and boundary-validation helpers. Passing these unit tests does not repeat the live isolation pilot.
