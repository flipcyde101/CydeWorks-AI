# Disconnected request-claims evidence and limits

The local research helper is not connected to the runner or browser. It records synthetic request claims and does not establish real worker-tree recovery, Windows Stop, operating-system process identity, inference settlement or cross-store atomicity.

The independent Codex GPT-6.2 Sol High review of candidate `99b9310f3e8f54dc73988e028e4481f5a36d1990` found that the journal-mode and page-limit checks fail closed for claim decisions and found no new production correctness or security regression in that delta. The parent ran 29 of 29 candidate tests in a verified offline Linux sandbox. Windows durability and power-loss behavior remain unverified.

`maxPages` limits accepted store size, but the helper runs SQLite `integrity_check` before it rejects an oversized store. It is therefore not a bound on the time or I/O needed to inspect an already oversized database. A future trusted host must enforce a qualified external resource and time boundary before using this helper, or the implementation must be changed and independently reviewed. Do not attach it to a live runner on the strength of the current tests.

The edited-index regression verifies that the table rows and seals are consistent, `integrity_check` detects the edit, and the registry rejects the database. On the parent's Linux run, `quick_check` returned `ok`, demonstrating the intended difference. On another platform, the test may pass with a portability diagnostic even if `quick_check` also detects the edit; a pass count alone does not establish that distinction there.

The checksums are unkeyed. A consistently rewritten store or a restored older valid snapshot can pass. Completion and continuation depend on trusted host attestations, and matching a supplied process identity is not operating-system proof. These limits must remain visible in any future host integration and release evidence.
