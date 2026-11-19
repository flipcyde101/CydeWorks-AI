# Browser and desktop Lock redesign requirements

Status: design input. This document does not approve a security design, change trust settings, authorize an installation, or qualify the runner for browser staging.

## Owner decisions

- The standalone browser remains a fully supported personal-release mode alongside the Windows desktop app.
- Ordinary refresh and relaunch should not require Windows Hello on every occurrence. An explicit Lock, session expiry or a separately justified security event may require a fresh unlock. The exact experience must be verified with the owner before imposing a new recurring prompt.
- The owner has not approved an extension installation, new credential, local certificate authority, trust-store change, or a weaker copied-session boundary.

## Findings the replacement must address

The independent Sol High review of `f07ecc365758b070d831ec21610e4eb68a1b70c8` found four high-severity gaps: loopback bearer disclosure, copied browser storage retaining a view without an opener, protected continuations racing a foreign Lock, and launcher claims that can remain effective after navigation or service lifecycle changes. The candidate is not integrated.

The next design must state its trusted processes and endpoints, the adversary it covers, and the linearization point for Lock, admission and saves. It must demonstrate that an older generation cannot publish a protected result or complete an unauthorized save after the applicable Lock boundary. It must separately describe data already delivered or saved before that boundary. A same-user process with direct access to the application process or its files is a different threat from a passive loopback observer; do not claim protection against either without evidence for the specified boundary.

## Design constraints

- Do not accept a cookie, copied Web Storage value, `window.opener`, Fetch Metadata header, or caller-supplied label alone as proof of a particular document. Test a duplicate with no opener as well as a legitimate reload.
- Authenticate the browser's initial application content and service identity, not just later API payloads. An application-layer encryption handshake delivered by unauthenticated HTTP does not by itself establish the integrity of the initial script. The [W3C Web Cryptography specification](https://www.w3.org/TR/webcrypto/) discusses script injection and transport security; the [OWASP TLS guidance](https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Security_Cheat_Sheet.html) describes confidentiality, integrity and server authentication.
- Treat a browser extension or native broker as an unverified option, not an approved dependency. [Chrome's tabs documentation](https://developer.chrome.com/docs/extensions/reference/api/tabs) states that tab IDs are unique within a browser session; it does not establish continuity across browser restart. [Chrome's native messaging documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) describes host registration and allowed extension origins. Installation, registry changes and publication require the owner's applicable approval.
- Preserve Electron context isolation, sandboxing, web security and disabled Node integration. Validate IPC senders and navigation lifecycles. [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security) recommends those controls, and its [navigation documentation](https://www.electronjs.org/docs/latest/api/web-contents) notes that `will-navigate` does not cover programmatic navigation.
- An abort signal alone is not proof that a save wrote nothing. [Node's file-system documentation](https://nodejs.org/api/fs.html) describes `writeFile` cancellation as best effort. Design and test a bounded save protocol with explicit commit and recovery semantics.
- Keep credentials and sensitive material out of URLs, logs, repositories and test fixtures. Any HTTPS certificate or credential provisioning must be a separate concrete owner-approved action.

## Reference session patterns

The installed `t3` CLI reported `v0.1.10` on November 19, 2026. Its [versioned remote-access documentation](https://github.com/pingdotgg/t3code/blob/v0.1.10/docs/user/remote-access.md) describes one-time device pairing followed by reuse for later connections. Its [versioned authentication design](https://github.com/pingdotgg/t3code/blob/v0.1.10/docs/internals/environment-auth.md) describes scoped browser-cookie, bearer and proof-bound sessions, with revocation and server-side permission checks. The proof-bound mechanism applies to those clients that use it; it must not be assumed to protect every browser cookie or media request.

This is a useful usability reference for persistent sessions without a prompt on every refresh. The cited T3 documentation does not establish the stricter exclusive-document and copied-storage guarantees required above. T3 also describes projects as organizational boundaries rather than filesystem sandboxes. Do not substitute its session model for CydeWorks' unresolved Lock and runner safety gates without a separate design decision and review.

[Code-server's usage guide](https://coder.com/docs/code-server/guide) documents password authentication and recommends protected transports for remote access. [Open WebUI's hardening guide](https://docs.openwebui.com/getting-started/advanced-topics/hardening/) describes HTTPS, cookie settings, session lifetime and revocation. These are comparison inputs, not proof that either product meets the CydeWorks per-document boundary.

## Evidence required before use

1. A reviewed state machine for admission, reload, duplicate, Lock, idle expiry, service restart and save cancellation, including browser restart and a replaced local service.
2. Deterministic synthetic tests for copied state without an opener, concurrent views, delayed reads and saves, Lock-before-callback, navigation and process exit during a claim, and stale or replayed messages.
3. Real Windows tests in each supported browser and Electron for the actual identity, transport and lifecycle behavior. Record any differences rather than inferring them from synthetic tests.
4. Independent Codex GPT-6.2 Sol High security review of the final implementation and evidence. Preserve all owner approval gates.
5. Separate qualification of Windows Stop, recovery, verifier and patch binding before connecting the runner to browser staging.

No threat-model relaxation, trust-store change, browser extension, deployment or live cutover is implied by this plan.
