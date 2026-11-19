# Browser and desktop Lock redesign requirements

Status: design input. This document does not approve a security design, change trust settings, authorize an installation, or qualify the runner for browser staging.

## Owner decisions

- The standalone browser remains a fully supported personal-release mode alongside the Windows desktop app.
- Ordinary refresh and relaunch should not require Windows Hello on every occurrence. An explicit Lock, session expiry or a separately justified security event may require a fresh unlock. The exact experience must be verified with the owner before imposing a new recurring prompt.
- The owner explicitly allows tabs in the same signed-in browser profile to share a session until Lock or expiry. Lock must revoke that shared session across its tabs. This replaces the earlier requirement that a duplicated tab in that same profile must be treated as a separate document.
- The owner allows a download already authorized before Lock to finish afterward. Once the server confirms Lock, it must reject new requests using the revoked session. Bytes already queued or delivered to a browser, and files already saved, cannot be recalled by server-side revocation.
- This decision does not approve credential disclosure, unauthorized access by another browser profile or device, an extension installation, a new credential, a local certificate authority, or a trust-store change.

## Findings the replacement must address

The independent Sol High review of `f07ecc365758b070d831ec21610e4eb68a1b70c8` found four high-severity gaps: loopback bearer disclosure, copied browser storage retaining a view without an opener, protected continuations racing a foreign Lock, and launcher claims that can remain effective after navigation or service lifecycle changes. The owner now permits same-profile tabs to share a session, so that specific duplicate-tab case must be assessed against the revised session contract. The other findings remain open. The candidate is not integrated.

The next design must state its trusted processes and endpoints, the adversary it covers, and the linearization point for Lock, admission and download authorization. After confirmed Lock, the server must reject new requests from the revoked session. A download authorized before Lock may finish afterward, including delivery or saving of bytes already queued; the design must not claim those bytes can be recalled. Browser views should conceal protected content when they observe Lock, while honestly describing delayed or suspended tabs. A same-user process with direct access to the application process or its files is a different threat from a passive loopback observer; do not claim protection against either without evidence for the specified boundary.

## Design constraints

- Treat a shared browser-profile session as a session, not as proof of a particular document. A legitimate duplicate tab in the same signed-in profile may use the session until Lock or expiry. Do not treat `window.opener`, Fetch Metadata headers or caller-supplied labels as authentication. Specify and test the handling of copied credentials in another profile or device, and disclose any protection that has not been established.
- Authenticate the browser's initial application content and service identity, not just later API payloads. An application-layer encryption handshake delivered by unauthenticated HTTP does not by itself establish the integrity of the initial script. The [W3C Web Cryptography specification](https://www.w3.org/TR/webcrypto/) discusses script injection and transport security; the [OWASP TLS guidance](https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Security_Cheat_Sheet.html) describes confidentiality, integrity and server authentication.
- Treat a browser extension or native broker as an unverified option, not an approved dependency. [Chrome's tabs documentation](https://developer.chrome.com/docs/extensions/reference/api/tabs) states that tab IDs are unique within a browser session; it does not establish continuity across browser restart. [Chrome's native messaging documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) describes host registration and allowed extension origins. Installation, registry changes and publication require the owner's applicable approval.
- Preserve Electron context isolation, sandboxing, web security and disabled Node integration. Validate IPC senders and navigation lifecycles. [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security) recommends those controls, and its [navigation documentation](https://www.electronjs.org/docs/latest/api/web-contents) notes that `will-navigate` does not cover programmatic navigation.
- An abort signal alone is not proof that a save wrote nothing. [Node's file-system documentation](https://nodejs.org/api/fs.html) describes `writeFile` cancellation as best effort. For application-managed writes, design and test bounded commit and recovery semantics; do not mislabel an already-authorized browser download as cancelled merely because Lock occurred.
- Keep credentials and sensitive material out of URLs, logs, repositories and test fixtures. Any HTTPS certificate or credential provisioning must be a separate concrete owner-approved action.

## Reference session patterns

The installed `t3` CLI reported `v0.1.10` on November 19, 2026. Its [versioned remote-access documentation](https://github.com/pingdotgg/t3code/blob/v0.1.10/docs/user/remote-access.md) describes one-time device pairing followed by reuse for later connections. Its [versioned authentication design](https://github.com/pingdotgg/t3code/blob/v0.1.10/docs/internals/environment-auth.md) describes scoped browser-cookie, bearer and proof-bound sessions, with revocation and server-side permission checks. The proof-bound mechanism applies to those clients that use it; it must not be assumed to protect every browser cookie or media request.

This is a useful usability reference for persistent sessions without a prompt on every refresh. The cited T3 documentation does not establish CydeWorks' Lock, cross-profile credential handling or runner safety guarantees. T3 also describes projects as organizational boundaries rather than filesystem sandboxes. The CydeWorks design and implementation still need separate review and verification.

[Code-server's usage guide](https://coder.com/docs/code-server/guide) documents password authentication and recommends protected transports for remote access. [Open WebUI's hardening guide](https://docs.openwebui.com/getting-started/advanced-topics/hardening/) describes HTTPS, cookie settings, session lifetime and revocation. These are comparison inputs, not proof that either product meets the CydeWorks session and Lock requirements.

## Evidence required before use

1. A reviewed state machine for admission, reload, same-profile duplicate tabs, Lock across all session tabs, idle expiry, service restart and download authorization, including browser restart and a replaced local service.
2. Deterministic synthetic tests for authorized shared tabs, copied credentials outside the authorized profile or device under the chosen threat model, new requests after confirmed Lock, downloads authorized before Lock, concurrent views, delayed reads, Lock-before-callback, navigation and process exit during a claim, and stale or replayed messages.
3. Real Windows tests in each supported browser and Electron for the actual identity, transport and lifecycle behavior. Record any differences rather than inferring them from synthetic tests.
4. Independent Codex GPT-6.2 Sol High security review of the final implementation and evidence. Preserve all owner approval gates.
5. Separate qualification of Windows Stop, recovery, verifier and patch binding before connecting the runner to browser staging.

No other threat-model relaxation, trust-store change, browser extension, deployment or live cutover is implied by this plan.
