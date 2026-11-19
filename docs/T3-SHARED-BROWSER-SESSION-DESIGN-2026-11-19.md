# CydeWorks Shared Browser-Profile Session and Lock Redesign

Status: Reviewable design document only. This document does not approve a security design, enable or restart any service, authorize certificate enrollment or trust-store changes, authorize browser extension installation or registry changes, modify source code, or qualify the runner for browser staging.

Baseline commit: `c0df0f576db84bb9b962a2ac50a95ceda4c02079` (branch `work/t3-shared-session-design-neon`).

Primary inputs:
- `docs/T3-BROWSER-LOCK-REQUIREMENTS-2026-11-19.md`
- `docs/T3-LOCK-VALIDATION-2026-11-19.md`
- `docs/T3-REQUEST-CLAIMS-LIMITS-2026-11-19.md`
- `harness/SESSION-LOCK.md`
- Read-only architecture update in T3 thread `mcp:2e5da21e-7259-41b4-930f-3b167d153334` run 5

---

## 1. Approved Design Preferences, Routine Decisions, and Gated Actions

This design separates preferences the owner has already stated, routine engineering decisions covered by existing CydeWorks development authority, and concrete operational, cryptographic, OS, and deployment actions that remain gated on specific owner approval.

### 1.1 Owner-Approved Design Preferences (Design Scope Only)

1. **Full standalone browser support:** The standalone local browser remains a fully supported personal-release mode alongside the Windows Electron desktop application.
2. **Shared same-profile browser session:** Multiple tabs within the same signed-in browser profile on the authenticated CydeWorks local origin share one CydeWorks workspace session until explicit Lock, idle expiry, or local service restart. This replaces the earlier requirement that a duplicated tab in the same signed-in profile must be treated as an isolated document.
3. **No mandatory Windows Hello on ordinary refresh or browser relaunch:** Ordinary tab refresh (`F5`) and browser relaunch (while the local workspace service remains live and within the idle window) must stay signed in without prompting for Windows Hello or re-selecting `.state/access.key` on every occurrence.
4. **Cross-tab revocation on Lock (same signed-in profile):** Explicit Lock must revoke the shared session across all tabs in that signed-in browser profile, subject to the exact commit boundaries defined in Section 6.
   - *Design recommendation (not separately selected by the owner):* This document also recommends keeping `harness/SESSION-LOCK.md`'s existing workspace-wide Lock scope (`scope: "all-workspace-views"`) so that if a second browser profile is independently unlocked against the same workspace service, a Lock revokes all admitted profiles together. The owner did not separately select cross-profile revocation policy; keeping it shared vs. displacing an older profile on second-profile unlock remains an explicit design choice in Section 9.1 (OQ-5).

### 1.2 Routine Development Decisions vs. Concrete Approval-Gated Actions

CydeWorks development is already authorized. Selecting a candidate architecture, splitting local modules, implementing the session/PoP state machine, wiring frontend reveal/save fences, refactoring Electron IPC, and running deterministic offline synthetic tests (using ephemeral in-test keys only, with zero OS or trust-store side effects) are **routine design and local implementation decisions** that do **not** require another general go-ahead.

By contrast, none of the following **concrete gated actions** are authorized by this document or by the owner's session preference; each requires specific owner approval before execution:

1. **Certificate or credential creation:** Generating any persistent local Root CA, loopback leaf certificate, or new long-lived credential for owner use.
2. **OS or browser trust-store and security-setting changes:** Installing any certificate into Windows `CurrentUser\Root`, modifying Firefox trust settings (`security.enterprise_roots.enabled` or NSS `cert9.db` import), changing Windows Hello policy, or altering host security settings.
3. **Browser extension installation or registry changes:** Installing, signing, or publishing a browser extension, or writing Native Messaging host manifests to `HKCU` Windows Registry keys.
4. **Service lifecycle, deployment, live staging, or runner cutover:** Enabling, starting, restarting, or replacing the live preview service, deploying packages, running live browser staging, or connecting any runner/worker surface to browser staging.

### 1.3 Brief Contrast with Earlier Per-Document Isolation

The earlier candidate (`f07ecc365758b070d831ec21610e4eb68a1b70c8`, not integrated) attempted to reject duplicate tabs using `window.opener` and `sessionStorage` markers. Independent Sol High review identified four high-severity gaps: (1) loopback bearer cookie disclosure over plaintext HTTP, (2) copied browser storage retaining access without an opener, (3) protected continuations racing a foreign Lock, and (4) launcher/ticket claims surviving navigation or service lifecycle changes. Adopting a shared same-profile session aligns browser ergonomics with real browser storage boundaries without extension-only tab-ID tracking, while keeping Gaps 1, 3, and 4 fully in scope and redefining Gap 2 around cross-profile and cross-device credential boundaries.

---

## 2. Trust Model, Trusted Boundary, and Honesty Limits

### 2.1 Trusted Processes and Endpoints

- **Standalone Browser Mode (`BFE_BROWSER_MODE=1`):**
  - Trusted local service: Node.js workspace process (`harness/workspace-service.mjs` extracted from `harness/server.mjs`, holding the exclusive SQLite lock via `harness/workspace-lock.mjs` `acquireWorkspaceLock`).
  - Trusted user agent: One owner-operated Windows browser profile running uncompromised CydeWorks HTML/JS loaded from the authenticated local origin (under T1 or T2).
  - Protected local state: `.state/workspace.sqlite`, `.state/workspace.sqlite.owner.sqlite`, `.state/access.key` (owner-only permissions), and (if T1 is approved and provisioned) `.state/tls/` leaf private key.
- **Electron Desktop Mode (`BFE_DESKTOP_IPC=1`):**
  - Trusted Electron Main process (`harness/desktop/main.cjs`) and its spawned Node `utilityProcess` workspace service communicating solely over `utilityProcess.parentPort` (zero listening TCP sockets).
  - Sandboxed Electron Renderer loading assets over a privileged `cydeworks://` custom protocol with `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, `nodeIntegration: false`, and `webviewTag: false` (preserving and extending `harness/desktop/main.cjs` lines 66-74).

### 2.2 Adversary Classes Addressed by This Design

Adversaries are defined strictly by their **actual access to keys, files, and processes**, not by generic privilege labels:

- **Adversary A1 (Passive loopback observer without key, file, or process access):** A process or loopback packet capture that can read loopback network traffic, **but cannot** read `.state/access.key`, `.state/tls/` private keys, or browser profile storage, and cannot inspect or inject into the browser or service processes. Mitigated by TLS 1.3 (Option T1) or OS anonymous pipes with zero TCP sockets (Option T2 / Electron IPC), plus removing all bearer cookies and URL secrets.
- **Adversary A2 (Active local port replacer without access to the service private key, extension/broker files, or target processes):** A local process (for example, another OS user account, a restricted service account, or a sandboxed/AppContainer process) that can bind the workspace loopback port before the legitimate service starts or after it exits to serve malicious HTML/JS on `GET /` or capture `.state/access.key`, **but has no read access to the `.state/tls/` leaf private key (Option T1), no write access to the signed extension or native host binary/manifest (Option T2), and no debug/injection access to the browser or Node processes**. Mitigated by authenticating initial HTML/JS and server identity before any page script executes.
  - *Critical boundary note:* An ordinary unprivileged process running as the **same Windows user** may already have filesystem read access to `.state/tls/` and `.state/access.key` as well as process access to the browser and Node service. Such an equivalent-user process belongs to **Adversary Class B**, not Adversary A2. **Local HTTPS does not protect against an equivalent-user process.**
- **Adversary A3 (Cross-origin web page / CSRF / direct navigation):** A malicious third-party website or direct browser address-bar navigation attempting to invoke `/api/*` endpoints without access to local files, keys, or the CydeWorks origin. Mitigated by eliminating cookies entirely (`Set-Cookie` removed), requiring per-request Proof-of-Possession (PoP) signatures in custom headers, strict `Host` and `Origin` checks, `Sec-Fetch-Site` defense-in-depth checks, and strict Content-Security-Policy (`default-src 'none'`).
- **Adversary A4 (Distinct browser profile without `.state/access.key`, or another network device):** Another browser profile on the same machine that has not been given `.state/access.key` and cannot read Profile 1's IndexedDB/extension storage, or another host on the network (blocked by loopback-only binding on `127.0.0.1` / `::1`).

### 2.3 Explicitly Out-of-Scope Threats and Non-Claims

The following threats are **not** solved by this browser session design and must never be claimed as mitigated without a separate, qualified OS or hardware boundary:

1. **Adversary Class B (Equivalent-user local process with access to keys, files, or target processes):** Any local process running as the same Windows user (even without Administrator elevation) may be able to read `.state/access.key`, read `.state/tls/` leaf private keys, read browser profile directories, attach a debugger, or inject code into the browser or Node process. Local HTTPS, NTFS user-only ACLs, and browser-side Web Crypto do **not** defend against an equivalent-user process. Defending against Adversary Class B requires OS-level isolation (a separate OS account, Windows AppContainer, or VM), which is outside this design.
2. **Malicious same-origin JavaScript or browser compromise:** Storing a Web Crypto `CryptoKey` with `extractable: false` in IndexedDB prevents same-origin script from calling `crypto.subtle.exportKey` to read raw key bytes. It does **not** prevent malicious same-origin JavaScript (such as an XSS payload or a compromised browser extension with host permissions) from invoking `crypto.subtle.sign` on that key handle to forge authorized API requests, nor does it protect against a compromised browser renderer process or equivalent-user memory inspection.
3. **Offline copy of browser profile storage to another profile or device:** If an attacker with filesystem access copies a signed-in browser profile directory (including its IndexedDB backing files), whether the stored `extractable: false` `CryptoKey` remains usable in another profile or on another Windows machine depends on each browser's proprietary OS key-wrapping implementation (for example, Chromium DPAPI / App-Bound Encryption or Firefox NSS key storage). This design **does not claim** that copied browser profile storage is cryptographically unexportable or non-transferable without empirical Windows verification.
4. **Non-authentication signals:** `window.opener`, `Sec-Fetch-*` Fetch Metadata headers, `Referer`, and caller-supplied client/tab labels are never treated as proof of identity or document lineage. Fetch Metadata and `Origin`/`Host` serve strictly as defense-in-depth CSRF barriers alongside cryptographic PoP verification.

---

## 3. Authenticating Initial HTML/JS and Local Service Identity

Because plaintext HTTP delivers initial HTML and JavaScript without integrity or server authentication, an active pre-load port replacer (Adversary A2) can serve trojanized JavaScript on `GET /` that exfiltrates `.state/access.key` before any application-layer cryptography runs. **Plaintext HTTP plus application-layer encryption (Option T4 below) is therefore explicitly rejected as insufficient.**

### 3.1 Comparison of Concrete Supportable Options

| Option | Initial HTML/JS & Service Auth Mechanism | Browser / OS Dependencies & Likely One-Time Setup | Scope & Renewal | Approval Gate |
| :--- | :--- | :--- | :--- | :--- |
| **T1a. Local HTTPS with Scoped Local Root CA** *(Primary candidate for review)* | Dedicated Name-Constrained local Root CA signs a loopback leaf cert (`https://localhost:<port>`). Leaf private key kept in `.state/tls/` (owner-only NTFS ACL). TLS 1.3 authenticates server before `GET /`. | Chrome/Edge: one-time import of Root CA cert into Windows `CurrentUser\Root` store (triggers Windows security confirmation dialog). Firefox (only if in scope): enable `security.enterprise_roots.enabled` or import CA into Firefox NSS `cert9.db`. | Root CA constrained via RFC 5280 Name Constraints (`DNS:localhost`, `IP:127.0.0.1/32`, `IP:::1/128`, `pathLenConstraint: 0`). Leaf validity 90-398 days. Periodic renewal ceremony required (or CA re-provisioning if Root CA key is destroyed immediately after signing). | Separate owner approval for CA/leaf ceremony, `CurrentUser\Root` import, and Firefox scope. |
| **T1b. Local HTTPS with Directly Trusted Loopback Leaf Cert (No CA)** *(Zero-CA HTTPS candidate)* | Self-signed non-CA loopback leaf cert (`CA:FALSE`, SAN `DNS:localhost`, `IP:127.0.0.1`, `IP:::1`) trusted directly as a leaf anchor. Zero CA signing capability exists. | Same OS/browser store touchpoint as T1a, but must be empirically verified on Windows Chrome, Edge, and Firefox: some NSS/CryptoAPI/Chromium paths reject `CA:FALSE` end-entity certs in Root stores or enforce stricter EKU/validity checks. | Leaf validity bounded (90-398 days); every rotation requires repeating the owner-approved leaf trust replacement and removing the old thumbprint. | Separate owner approval for leaf cert trust + empirical Windows compatibility proof first. |
| **T2. Signed Browser Extension + Native Messaging Broker** *(Zero-TLS / Zero-CA alternative)* | Initial HTML/JS packaged inside a cryptographically signed extension (`chrome-extension://` / `moz-extension://`). Browser spawns local Native Messaging host over anonymous stdin/stdout OS pipes (zero TCP ports). | Requires signed extension distribution (Chrome Web Store / Edge Add-ons / Mozilla AMO, or enterprise policy), plus one-time `HKCU\Software\{Google\Chrome,Microsoft\Edge,Mozilla}\NativeMessagingHosts\...` registry keys and manifest JSON files. | Extension updates follow store review cycles; `allowed_origins` / `allowed_extensions` pins which extension ID may launch the native host. Native Messaging imposes a 1 MB per-message host-to-extension limit (requires framing/chunking). | Separate owner approval for extension packaging, store publication, and `HKCU` registry registration. |
| **T3. Public CA / ACME with DNS -> `127.0.0.1`** *(Not recommended)* | Publicly trusted CA certificate for a real DNS name resolving to loopback. | Requires external DNS provider, internet connectivity for ACME issuance/renewal, and per-user unique subdomains (shipping a shared private key violates CA/B Forum Baseline Requirements and triggers revocation). | 47-90 day ACME auto-renewal; exposes hostnames in public Certificate Transparency logs. Conflicts with local-first offline personal release. | Not recommended; would require cloud DNS and external CA approval. |
| **T4. Plaintext HTTP + App-Layer Crypto** *(Rejected)* | None for initial HTML/JS delivery. | No trust setup, but fails Adversary A2 completely: an attacker on the loopback port serves modified JS on `GET /` that captures `.state/access.key` and intercepts all plaintext before encryption. | N/A | Rejected as non-compliant with `docs/T3-BROWSER-LOCK-REQUIREMENTS-2026-11-19.md`. |

*Note on Electron Desktop mode:* Electron uses a separate **Zero-TCP Main-Brokered IPC** transport (`cydeworks://` privileged scheme + `utilityProcess.parentPort`). It requires no local CA, no browser extension, and no loopback TCP listener, and remains unaffected by the T1 vs. T2 standalone-browser decision.

### 3.2 Certificate Authority Scope, Renewal, and Unhonored-Constraint Failures (T1a / T1b)

1. **Mandatory X.509 v3 constraints (T1a):**
   - Root CA: `basicConstraints = critical, CA:TRUE, pathLenConstraint:0`; `keyUsage = critical, keyCertSign, cRLSign`; `nameConstraints = critical, permitted;DNS:localhost, permitted;IP:127.0.0.1/255.255.255.255, permitted;IP:0:0:0:0:0:0:0:1/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff`.
   - Leaf certificate: `basicConstraints = critical, CA:FALSE`; `keyUsage = critical, digitalSignature`; `extendedKeyUsage = serverAuth`; `subjectAltName = DNS:localhost, IP:127.0.0.1, IP:::1`; validity bounded to at most 365 days (within the 398-day industry ceiling enforced by modern Chromium/Apple/Mozilla stacks; shorter 90-day rotation is preferable only if renewal ergonomics are acceptable to the owner).
2. **What happens if constraints are not honored or misconfigured:**
   - **Ignored or non-critical Name Constraints + retained CA private key:** If any TLS stack on the system ignores Name Constraints and an attacker obtains the Root CA private key, the attacker could issue trusted certificates for arbitrary external domains (such as banking or cloud sites) in that Windows user's trust store. Because Windows CryptoAPI and NSS edge cases around `IP` + `DNS` Name Constraints can vary across versions, **mitigation cannot rely solely on Name Constraints**: the Root CA private key must never be kept long-term on disk (see Section 3.3), and the renewal model must either re-run an explicit short ceremony (installing a fresh CA + removing the old CA) or prove T1b direct leaf trust works cleanly with zero CA bit.
   - **Leaf certificate expiry or mismatch:** Browsers must fail closed with a hard TLS error. CydeWorks documentation and UI must never instruct the owner to bypass certificate warnings or pass `--ignore-certificate-errors`.
   - **Dual-stack `localhost` binding mismatch:** On Windows, `localhost` resolves to both `::1` (IPv6) and `127.0.0.1` (IPv4). If CydeWorks binds only `127.0.0.1:<port>`, another local process could bind `[::1]:<port>` and race `https://localhost:<port>` connections (though TLS authentication still causes the rogue listener to fail closed without the leaf private key, it creates a reliable local DoS). The service must bind both `127.0.0.1` and `::1` on the same port, or standardize on an explicit verified address strategy tested on Windows.
   - **Native Messaging misconfiguration (if T2 is chosen):** If `allowed_origins` is overly broad or points to an unsigned/unpacked developer ID, another local extension could launch the native broker. If the host binary path is writable by non-owner accounts, another user could replace it.

### 3.3 Private-Key Lifecycle and Limitations of Claiming Secure Deletion on Modern Storage

1. **Root CA private key lifecycle (T1a):**
   - Generate the Root CA keypair **strictly in process RAM** inside the one-time provisioning tool, sign the loopback leaf certificate in memory, zero the allocated key buffer (`Buffer.fill(0)`) immediately after signing, and **never write the Root CA private key to disk**.
   - Even with RAM-only generation, V8 garbage-collected copies, OpenSSL internal heap buffers, Windows virtual-memory paging (`pagefile.sys`), hibernation images (`hiberfil.sys`), and OS crash dumps mean zeroing a JS/Node buffer is best-effort hygiene rather than a hardware-enforced erasure proof.
2. **Leaf private key lifecycle (T1a / T1b):**
   - The leaf private key must persist so the local service can start without an owner ceremony on every launch. It is stored under `.state/tls/` with owner-only NTFS ACLs (or, as a future Windows hardening option requiring separate evaluation, wrapped via Windows CNG / DPAPI so the raw PEM key is not plaintext on disk).
   - Because `.state/tls/` is readable by the same OS user, it does not resist Adversary Class B; it protects against Adversary A1/A2 and non-owner local accounts.
3. **Explicit limitations of claiming secure deletion on modern storage:**
   - Modern NVMe/SATA SSDs implement Flash Translation Layer (FTL) wear-leveling, over-provisioning, and copy-on-write block remapping. Overwriting a file and calling `unlink` does **not** guarantee that previous flash pages containing private-key bytes were physically erased.
   - Windows NTFS journaling (`$LogFile`, USN journal), Volume Shadow Copies (VSS), system restore points, antivirus scans, and cloud/local backup agents can also retain historical copies of any key file that ever touched disk.
   - **Design rule:** Never claim "cryptographically secure deletion" of any key material that has been written to disk on Windows. Instead, (a) keep the T1a Root CA private key RAM-only so it never enters the filesystem, (b) enforce narrow Name Constraints (`localhost`, `127.0.0.1`, `::1`), (c) remove retired CA/leaf certificates from `CurrentUser\Root` during rotation, and (d) treat any suspected leaf key exposure under Adversary Class B as requiring full key rotation and trust-store replacement.

---

## 4. Shared-Profile Session Protocol and Revocation Channel

### 4.1 Elimination of Cookies and URL Secrets

- Remove `bfe_session` cookies completely (`Set-Cookie` must never be emitted; see current `harness/server.mjs` lines 252, 255-258, 272).
- Remove any legacy cookie-only bypass or `/api/desktop-view` loopback ticket endpoint.
- Never place `.state/access.key`, `clientId`, private keys, or session tokens in URL query parameters, fragments, `localStorage`, `sessionStorage`, DOM attributes, or logs.

### 4.2 Per-Profile Proof-of-Possession (PoP) Key Registration

1. **Key creation and storage:** On unlock, the browser generates an ECDSA P-256 (`SHA-256`) `CryptoKeyPair` via Web Crypto with `extractable: false` and key usages `['sign']` / `['verify']`. The pair and server-assigned `{clientId, sessionGen}` are stored in an origin-scoped IndexedDB object store (`cydeworks-session-v1`).
2. **Admission (`POST /api/session/admit`):**
   - The user selects `.state/access.key`. The page reads the 64-hex key into JS memory (rejecting files `> 1024` bytes), exports only `publicKeyJwk`, sends `{key, publicKeyJwk}` over TLS 1.3 (Option T1) or Native Messaging (Option T2), and immediately clears the `key` variable reference.
   - The server verifies `key` in constant time (`timingSafeEqual`), confirms no Lock occurred while the request body was arriving (`arrivalGen === currentSessionGen`, else `409 Conflict`), validates `publicKeyJwk` is a valid P-256 public key, enforces the `MAX_ADMITTED_CLIENTS` cap, mints a random 128-bit `clientId`, stores `admittedClients.set(clientId, {publicKey, sessionGen, admittedAtMono})`, initializes or refreshes the 15-minute idle clock, and returns `200 {clientId, sessionGen, idleTimeoutMs}`.
   - The browser writes `{clientId, sessionGen, keyPair}` to IndexedDB and writes the non-secret `sessionGen` string to `localStorage['bfe-shared-generation']` (used only as a same-profile local hint/fence, never as a credential).
3. **Authenticated requests (every protected `GET` and `POST`):**
   - Every tab in the same signed-in profile loads `{clientId, sessionGen, keyPair}` from IndexedDB and signs each request with:
     - `X-Workspace-Client: <clientId>`
     - `X-Workspace-Generation: <sessionGen>`
     - `X-Request-Ts: <epochMs>`
     - `X-Request-Nonce: <128-bit random lowercase hex>`
     - `X-Client-Sig: <base64url(ECDSA-P256-SHA256(canonicalPayload))>`
   - Canonical signing string (`UTF-8`, newline-delimited, length/delimiter-unambiguous):
     ```text
     cydeworks-pop-v1
     <METHOD_UPPER>
     <PATH_AND_QUERY>
     <SHA256_HEX_OF_RAW_REQUEST_BODY>
     <clientId>
     <sessionGen>
     <ts_ms>
     <nonce_hex>
     ```
   - Using per-request random 128-bit `nonce` + timestamp `ts_ms` instead of a monotonic counter allows multiple tabs in the same profile to issue concurrent requests without cross-tab lockstep coordination.
   - Direct address-bar navigation (for example `GET /api/tasks` or `GET /api/tasks/:id/artifact`) lacks PoP headers and fails closed with `401` without modifying or revoking the live session.

### 4.3 Authenticated Revocation Stream

- `EventSource` is not used because it cannot attach custom PoP headers without leaking credentials into URLs.
- Each active tab opens an authenticated server-push stream via `fetch('/api/session/events', {method: 'POST', headers: {Accept: 'text/event-stream', 'Content-Type': 'application/json', ...popHeaders}, body: '{}', signal: abortCtrl.signal})` and parses SSE frames from `response.body` (`ReadableStream`).
- **Multiplexing requirement:** Under Option T1, serving via `node:http2` over TLS 1.3 (`allowHTTP1: true`) multiplexes revocation streams across open tabs over a single TCP connection, avoiding HTTP/1.1's 6-connection-per-origin browser limit when 6+ tabs are open.
- **HTTP/1.1 fallback (if HTTP/2 is unavailable):** Elect one leader tab per profile using Web Locks API (`navigator.locks`) or a lease in `localStorage`/`BroadcastChannel` to hold the single SSE stream and broadcast revocation frames to sibling tabs. If leader election fails or the stream drops without reconnect within the grace interval (for example 5 seconds), tabs mark `revocationStreamHealthy = false` and fail closed on protected saves/downloads until verified.

### 4.4 Cross-Profile Behavior (Design Recommendation)

- Browser Profile 2 has a separate IndexedDB, `localStorage`, and `BroadcastChannel`. It cannot read Profile 1's `{clientId, keyPair}` and opens concealed at the `.state/access.key` prompt.
- As a design recommendation (not separately selected by the owner; see Section 1.1 and OQ-5), if the owner explicitly unlocks Profile 2 using `.state/access.key` while Profile 1 is active, Profile 2 receives its own `clientId_2` registered under the **same** server `sessionGen` so that an explicit Lock (or idle expiry) from either profile rotates `sessionGen` and revokes **all** `clientId` entries together, matching `harness/SESSION-LOCK.md`'s existing `all-workspace-views` scope.

---

## 5. Implementable State Machine

### 5.1 Server Session State Machine (`harness/workspace-service.mjs`)

**Server State Tuple:**
- `state`: `'LOCKED' | 'ACTIVE'`
- `sessionGen`: 256-bit random hex string (freshly generated at startup and on every `ACTIVE -> LOCKED` transition)
- `admittedClients`: `Map<clientId, {publicKey, sessionGen, admittedAtMono, activeStreams: Set<StreamHandle>}>` (capped at `MAX_ADMITTED_CLIENTS = 16`)
- `seenNonces`: `Map<string, number>` mapping `clientId + ':' + nonce` to expiry monotonic timestamp (bounded; see Section 7.1)
- `idleClock`: `{lastOpMonoNs: bigint, lastOpWallMs: number}` (15-minute idle threshold `IDLE_MS = 900_000`)
- `activeRun`: existing single-run executor + `terminalControl` lease handle (per `harness/server.mjs` and `harness/SESSION-LOCK.md`)

**Idle and Clock-Fault Helper (`isSessionExpired()`):**
- Samples `process.hrtime.bigint()` (monotonic) and `Date.now()` (wall).
- If either clock is non-finite, if `nowMonoNs < lastOpMonoNs` (monotonic regression), if `nowWallMs + 5000 < lastOpWallMs` (material wall-clock backward jump beyond minor NTP slew), or if either elapsed delta `>= IDLE_MS`, the helper triggers an atomic `ACTIVE -> LOCKED(reason='idle'|'clock-fault')` transition before rejecting the request with `401`.
- **Passive vs. operator-active routes:** Background polling and read-only status checks (`GET /api/session/status`, `GET /api/tasks`, `GET /api/attention`, `GET /api/tasks/:id`, `POST /api/session/events`, `POST /api/session/check`, `POST /api/cost-presentation`, terminal `heartbeat` and `detach`) do **not** advance `idleClock`. Explicit operator actions (unlock, task creation/scope edit, route refresh triggered by operator, run approval, review/revise, copy-draft, remove, terminal `take`/`release`/`stop`, artifact download) advance `idleClock` only after passing all authentication and commit-boundary checks. *(Open question OQ-4 in Section 9 flags confirming the exact route list for idle extension.)*

**Server Transition Table:**

| Current State | Trigger / Event | Guard Conditions | Atomic Actions & Commit Boundary | Next State |
| :--- | :--- | :--- | :--- | :--- |
| `LOCKED` | `POST /api/session/admit` | `Host`/`Origin` valid; body `<= 48 KB`; valid `access.key` (`timingSafeEqual`); valid P-256 `publicKeyJwk`; `arrivalGen === sessionGen` | Mint `clientId`; insert into `admittedClients`; sample `idleClock`; return `200 {clientId, sessionGen, idleTimeoutMs}` | `ACTIVE` |
| `LOCKED` or `ACTIVE` | `POST /api/session/admit` (raced Lock) | Valid `access.key`, but `arrivalGen !== sessionGen` (Lock or expiry occurred while body arrived) | Do not register `clientId`; return `409 Conflict` ("The workspace was locked while unlocking. Choose the access file again.") | Unchanged (`LOCKED` or newer `ACTIVE`) |
| `ACTIVE` | `POST /api/session/admit` (2nd profile unlock) | `!isSessionExpired()`; valid `access.key`; `arrivalGen === sessionGen`; `admittedClients.size < MAX_ADMITTED_CLIENTS` | Mint `clientId_2` under current `sessionGen`; advance `idleClock`; return `200 {clientId: clientId_2, sessionGen, idleTimeoutMs}` | `ACTIVE` |
| `ACTIVE` | Protected `GET` / passive `POST` (including `GET /api/session/status`, `POST /api/session/check`, `GET /api/tasks/:id/artifact`) | `!isSessionExpired()`; valid PoP (`clientId`, `sessionGen`, `ts`, fresh `nonce`, valid ECDSA sig) | Record `nonce`; for slow async probes (`/api/models`, `/api/tasks/:id/readiness`), **recheck** `state === 'ACTIVE' && arrivalGen === sessionGen && !isSessionExpired()` **after** probes settle and before `writeHead` (commit boundary); return `200` (or `401` if revoked during probe) | `ACTIVE` |
| `ACTIVE` | Protected operator `POST` (`/api/tasks`, `/scope`, `/run`, `/cancel`, `/review`, `/revise`, `/remove`, `/copy-draft`, `/terminal`) | Body read complete (`<= 48 KB`); **Commit Boundary 1**: `!isSessionExpired()`, `arrivalGen === sessionGen`, valid PoP (`clientId`, `ts`, fresh `nonce`, sig), `admittedClients.has(clientId)` | Record `nonce`; advance `idleClock`; execute SQLite `BEGIN IMMEDIATE` write (with `task.version` check or idempotency lookup) or run dispatch; return `200`/`201`/`202` | `ACTIVE` |
| `ACTIVE` | `POST /api/session/events` | `!isSessionExpired()`; valid PoP; body `{}`; per-client and global stream caps not exceeded | Register stream under `admittedClients.get(clientId).activeStreams`; send `200 text/event-stream` + initial `event: ready` carrying `{sessionGen, serverTimeMs}`; emit periodic keepalive comments (`: ping`) every 20s | `ACTIVE` |
| `ACTIVE` | `POST /api/session/lock` | Body read complete; exact `{}`; `!isSessionExpired()`; valid PoP; `arrivalGen === sessionGen` | **Atomic single-turn Lock linearization:** capture `lockedGeneration = sessionGen`, `revokedClientCount = admittedClients.size`, `activeStreamCount`; rotate `sessionGen = randomBytes(32).hex`; clear `admittedClients`; clear `seenNonces`; clear `idleClock`; call `activeRun?.control.revoke()` (`stopsWork: false`); push `event: session-ended` (`{reason: 'locked', lockedGeneration}`) to all streams and end/destroy them; return `200 {locked: true, lockedGeneration, revokedClientCount, scope: 'all-workspace-views', terminalControlReleased: true, stopsWork: false, requiresAccessFile: true}` | `LOCKED` |
| `ACTIVE` | Idle timer (`>= 15 min`) or clock fault | `isSessionExpired()` returns true | Same atomic single-turn revocation as Lock with `reason: 'idle'` or `'clock-fault'`; push `session-ended` and close all streams | `LOCKED` |
| `LOCKED` | Any protected route or repeated `POST /api/session/lock` | Any | Return `401`; zero state mutation; do not rotate or renew session | `LOCKED` |
| Any | Service restart / process exit | Startup of new process | `acquireWorkspaceLock` ensures single writer; new process starts in `LOCKED` with fresh `sessionGen`, empty `admittedClients`, empty `seenNonces`; any persisted `'running'` tasks are marked interrupted via `recordInterruption` (preserving `harness/server.mjs` lines 557-560) | `LOCKED` |
| Any | Interrupted request (client disconnects mid-body or before response) | Socket `close`/`aborted` | If before Commit Boundary 1: reject/discard with no mutation. If after Commit Boundary 1: SQLite commit stands; client reconciles on reconnect via existing `GET /api/tasks/:id/run-submissions/:requestId` or `GET /api/draft-copies/:requestId` without blind replay. | Unchanged |

### 5.2 Browser Tab State Machine (Both Legacy `harness/web/` and Experience `harness/web-experience/`)

**Per-Tab State Tuple:**
- `phase`: `'BOOTING' | 'CONCEALED' | 'UNLOCKING' | 'ACTIVE' | 'LOCKING'`
- `docEpoch`: strictly increasing local integer (incremented synchronously on every concealment, Lock, or `pagehide`)
- `sessionGen`: current server generation string (null when not `ACTIVE`)
- `clientId`: current profile client ID (null when not `ACTIVE`)
- `abortCtrl`: `AbortController` aborted on every `ACTIVE -> LOCKING|CONCEALED` transition
- `revocationStreamHealthy`: boolean tracking whether the tab's HTTP/2 SSE stream (or leader-tab heartbeat) is live and fresh
- `pagehideFired`: boolean set synchronously on `pagehide`

**Browser Tab Transitions:**

1. **Admission (`CONCEALED -> UNLOCKING -> ACTIVE`):**
   - Operator selects `.state/access.key`. Tab increments `attemptEpoch`, generates non-extractable ECDSA P-256 `keyPair`, sends `POST /api/session/admit` over authenticated transport, and clears `key` from JS memory in `finally`.
   - On `200 {clientId, sessionGen}` (and if `attemptEpoch` is still current): persist `{clientId, sessionGen, keyPair}` to IndexedDB, write `sessionGen` to `localStorage['bfe-shared-generation']`, transition to `ACTIVE`, open `POST /api/session/events` revocation stream, and restore non-sensitive route state (or read-only `lockedTaskId` if unlocked after passive expiry; explicit Lock clears `lockedTaskId`).
   - On `409` (Lock raced unlock), `401`, or network failure: discard keypair, stay `CONCEALED`, display specific non-retrying message.
2. **Ordinary Refresh (`F5`) and Browser Relaunch (`BOOTING -> ACTIVE` or `CONCEALED`):**
   - On document load (`BOOTING`), read `{clientId, sessionGen, keyPair}` from IndexedDB.
   - Check `localStorage['bfe-shared-generation']`: if missing or prefixed with `lock.`, delete stale IndexedDB record and transition directly to `CONCEALED`.
   - Otherwise, sign and send `GET /api/session/status`.
     - If `200 {authorized: true, sessionGen}` matches the IndexedDB `sessionGen` and synchronous `localStorage['bfe-shared-generation'] === sessionGen`: transition directly to `ACTIVE` with **zero Windows Hello or access-file prompt**, open the revocation stream, and reopen the non-sensitive `sessionStorage` `lastTaskId` read-only (refresh) or default workspace list (relaunch, since `sessionStorage` resets on browser restart).
     - If `401` (service restarted, idle expired, or locked from another profile while browser was closed): delete the stale IndexedDB record, transition to `CONCEALED`, and prompt for `.state/access.key`.
     - If network error / service unreachable: stay `CONCEALED` with a "Workspace unavailable" status (never reveal cached data, never silently drop the IndexedDB record until the server confirms `401` or the user clicks Lock).
3. **Second Tab / Duplicate Tab in Same Profile (`BOOTING -> ACTIVE`):**
   - Follows the exact same `BOOTING` path as refresh: reads the shared `{clientId, sessionGen, keyPair}` from the profile's IndexedDB, passes signed `GET /api/session/status`, opens its own HTTP/2 multiplexed revocation stream (or joins the leader channel), and shares `localStorage['bfe-shared-generation']` and `BroadcastChannel('cydeworks-session-lock')`.
   - Concurrent actions across Tab 1 and Tab 2 sign independently with fresh random nonces. Optimistic `task.version` checks on the server prevent lost updates (`409 Conflict` prompts refresh).
4. **Explicit Lock (`ACTIVE -> LOCKING -> CONCEALED`):**
   - **Synchronously before any `await` or network call:**
     1. Increment `docEpoch`, abort `abortCtrl`, set `phase = 'LOCKING'`.
     2. Wipe all in-memory UI state and module caches: `state.task`, `state.tasks`, `state.routes`, `state.cache`, `state.compose`, `state.lease`, `state.approval`, export/receipt dialog buffers, and module-level caches such as `presented` Map in `harness/web-experience/views/usage.js` (line 15). Preserve only minimal pending submission identifiers (`taskId`, `requestId`, `version`, hashes, route labels; never source text or secrets, per `harness/SESSION-LOCK.md` line 29).
     3. Close all open dialogs, conceal workspace DOM, render the Lock screen with "Waiting for workspace confirmation" wording.
     4. Synchronously write a fresh random sentinel `lock.<32-hex>` to `localStorage['bfe-shared-generation']` and post `{type: 'lock-initiated', sessionGen}` on `BroadcastChannel`.
   - **Asynchronously (capturing a single pre-wipe signature over `{}` for `POST /api/session/lock`):**
     1. Delete the `{clientId, sessionGen, keyPair}` record from IndexedDB (so a simultaneous `F5` or relaunch cannot reuse it).
     2. Transmit `POST /api/session/lock` with exact `{}`.
     3. Map response (only if `docEpoch` is still current):
        - `200 {locked: true, ...}` -> update Lock screen to `server-revoked` confirmation (stating clearly what is and is not guaranteed; see Section 6.5).
        - `401` -> update Lock screen to `already-locked`.
        - Network error / timeout / unreadable body -> update Lock screen to `unconfirmed` ("This view locked locally and discarded its local key, but server confirmation was lost. Other profiles or tabs may not be locked until verified."). Never restore unlocked UI and never silently retry.
5. **Foreign Lock, Idle Expiry, Service Restart, or `401` (`ACTIVE -> CONCEALED`):**
   - Triggered immediately by: `storage` event showing `lock.*`, `BroadcastChannel` `lock-initiated`, SSE `event: session-ended`, SSE unexpected close followed by `401` on status check, any API `401`, or `assertViewCurrentSync` detecting generation mismatch.
   - Synchronously executes steps 1-3 of concealment (`docEpoch++`, `abortCtrl.abort()`, wipe all caches including `usage.js` `presented` Map, close dialogs, conceal DOM), deletes the IndexedDB record if its stored `sessionGen` matches the revoked generation, and transitions to `CONCEALED`.
6. **`pagehide` / `bfcache` Handling:**
   - On `pagehide`, set `pagehideFired = true`, increment `docEpoch`, abort `abortCtrl`, wipe sensitive DOM/state, and close the revocation stream.
   - Responses serve `Cache-Control: no-store` (already set in `harness/server.mjs` line 226). If a browser still restores a page via `pageshow` (`event.persisted === true`), force `phase = 'BOOTING'` and re-verify via `GET /api/session/status` before revealing any workspace DOM.
7. **Interrupted Requests:**
   - Any fetch rejection without HTTP status, abort, or malformed/uncorrelated JSON response is treated as an unknown outcome (`unknownOutcome` in `harness/web-experience/adapters/http.js` line 26).
   - Pending run submissions and draft copies retain only their correlation IDs (`requestId`, `taskId`) for explicit user-triggered lookup or exact idempotent resend after reconciliation; Lock never treats a `401` or dropped socket as proof that a prior run did not start.

### 5.3 Electron Desktop Mode State Machine (Zero-TCP Parallel Path)

Electron Desktop mode (`harness/desktop/main.cjs`) is updated in parallel so it preserves `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, `nodeIntegration: false`, and `webviewTag: false`, while eliminating all loopback TCP listeners and cookies:

1. **Startup:** Main spawns `workspace-service.mjs` via `utilityProcess.fork` (`BFE_DESKTOP_IPC=1`), exchanges a per-launch `launchNonce`, maintains `ownerLease` heartbeats, and serves UI assets via `protocol.handle('cydeworks', ...)` from the verified in-memory asset map.
2. **Navigation and IPC validation:** Main validates every `ipcMain.handle` call against `event.sender === window.webContents`, `event.senderFrame === activeMainFrame`, and `requestEpoch === mainWindowSessionState.epoch`. Because Electron's `will-navigate` does not cover all programmatic navigation paths, Main also listens to `did-start-navigation` (for non-same-document navigations), `did-navigate`, `render-process-gone`, and `closed` to advance `mainWindowSessionState.epoch` and cancel in-flight utility RPCs (`bfe-rpc-cancel`).
3. **Desktop Lock and Saves:** Desktop Lock immediately advances `mainWindowSessionState.epoch`, revokes the utility-process session, cancels pending IPC replies, and conceals the renderer. File exports and accepted artifact saves are mediated by Main through an explicit state machine (`DIALOG` -> `STAGING_WRITE` -> `COMMITTING_RENAME` -> `COMMITTED | CANCELLED | UNRESOLVED`) that serializes Lock completion acknowledgement against any already-dispatched `fs.rename` (see Section 6.2).

---

## 6. Linearization Boundaries, Pre-Lock vs. Pending Work, and Lock Races

### 6.1 Server-Side Commit or Rejection Boundary

Because Node.js executes JavaScript handlers on a single event loop and SQLite writes use `BEGIN IMMEDIATE`, the server has a clean, deterministic linearization point for every operation:

- **Lock Linearization Point (`L_lock`):** The synchronous JS turn inside `POST /api/session/lock` (or `isSessionExpired()`) that rotates `sessionGen`, empties `admittedClients` and `seenNonces`, and calls `activeRun?.control.revoke()`.
- **Admission Linearization Point (`L_admit`):** The synchronous turn after `await jsonBody(req)` that checks `arrivalGen === sessionGen` before inserting into `admittedClients`. If `L_lock` occurred while the unlock body was in flight, `L_admit` fails closed with `409 Conflict`.
- **Protected Read Linearization Point (`L_read`):** For synchronous SQLite reads, the PoP check precedes the query in the same turn. For asynchronous probes (`/api/models`, `/api/tasks/:id/readiness`), the server performs a mandatory **second** `state === 'ACTIVE' && arrivalGen === sessionGen && !isSessionExpired()` check *after* all async probes resolve and *before* calling `res.writeHead(200)` (extending `harness/server.mjs` line 305).
- **Protected Mutation / Workspace Save Linearization Point (`L_write`):** After `await jsonBody(req)` finishes reading the full payload, the server runs **Commit Boundary 1** (verifying `state === 'ACTIVE'`, `arrivalGen === sessionGen`, `!isSessionExpired()`, `admittedClients.has(clientId)`, unused `nonce`, valid ECDSA signature) synchronously before entering `db.exec('BEGIN IMMEDIATE')` / `save()` or launching `execute(task, run)`. A body still arriving when `L_lock` fires can never commit a mutation.

### 6.2 Client-Side Reveal Fence, Download Fence, and Serialized Desktop Save Protocol

1. **Commit Boundary 2 (Browser DOM Reveal Fence):** Every async continuation in both `harness/web/` and `harness/web-experience/` (including `getTask`, `listTasks`, `readiness`, `loadSourceFile`, `openHandoffReview` `arrayBuffer()`/`text()`, `usage.js` `costPresentation`, and export/receipt dialogs) must call `assertViewCurrentSync(captured)` immediately before mutating UI state, opening a dialog, announcing screen-reader text, or calling `render()`. `assertViewCurrentSync(captured)` verifies:
   - `phase === 'ACTIVE'`
   - `docEpoch === captured.docEpoch`
   - `sessionGen === captured.sessionGen`
   - `!abortCtrl.signal.aborted && !pagehideFired`
   - Synchronous read: `localStorage.getItem('bfe-shared-generation') === captured.sessionGen`
   - *Scope of this check:* `assertViewCurrentSync` prevents reveals **once the tab has observed Lock or revocation** (locally, via `localStorage`, via `BroadcastChannel`, via SSE, or via `401`). It does not guarantee global cross-process ordering before the tab observes revocation (see Section 6.4).
2. **Commit Boundary 3 (Browser Download / Save Fence):** Before triggering `URL.createObjectURL` + `a.click()` (in `downloadAccepted`, `actions.download`, and export/receipt downloads):
   1. Run `assertViewCurrentSync(captured)` after `response.arrayBuffer()` and `sha256Hex()` complete.
   2. Require `revocationStreamHealthy === true` (fail closed if the tab's revocation stream is disconnected).
   3. Execute a signed `POST /api/session/check` to verify the server session is still `ACTIVE` at `captured.sessionGen`.
   4. Re-run `assertViewCurrentSync(captured)` immediately before `a.click()`.
   - *Scope of this check:* This narrows post-Lock downloads when the tab observes Lock or fails `POST /api/session/check`, but does not form an atomic global fence against a concurrent Lock after step 3 returns `200` (see Section 6.4).
3. **Serialized Desktop File Save Protocol (Electron Main):** As noted in Node's `fs` documentation, passing an `AbortSignal` to `fs.writeFile` is best-effort cancellation and does **not** prove nothing was written to disk. Likewise, checking Lock state immediately before an asynchronous `fs.rename` does **not** prove commit ordering because the libuv threadpool / OS kernel can execute the rename after Lock has already been acknowledged on Main's event loop. Electron Main therefore serializes saves against Lock acknowledgement using an explicit `activeSaves` state machine:
   - **States per save:** `DIALOG` -> `STAGING_WRITE` -> `COMMITTING_RENAME` -> `COMMITTED | CANCELLED | UNRESOLVED`.
   - **Pre-commit phases (`DIALOG` and `STAGING_WRITE`):** User chooses `finalPath` via `dialog.showSaveDialog` (tagged with `capturedEpoch`). Main verifies `epoch === capturedEpoch && unlocked && !lockInProgress`, then writes bytes in bounded chunks to a same-directory temporary file (`.cydeworks-tmp-<random>.part`), rechecking `epoch === capturedEpoch && !lockInProgress` between chunks and calling `fileHandle.sync()`. If Lock arrives during `DIALOG` or `STAGING_WRITE`, Main immediately advances `epoch`, revokes the utility-process session, cancels the save before `COMMITTING_RENAME`, closes the file handle, and best-effort unlinks `tmpPath` without ever invoking `fs.rename`.
   - **Entering `COMMITTING_RENAME`:** Only if `epoch === capturedEpoch && unlocked && !lockInProgress` holds in the same synchronous JS turn does Main transition `save.state = 'COMMITTING_RENAME'`, register the save's settlement promise in `committingRenames`, and dispatch `fs.rename(tmpPath, finalPath)`.
   - **Serializing Lock acknowledgement with an in-flight `COMMITTING_RENAME`:**
     - If Lock arrives while `committingRenames.size > 0`, Main **immediately** executes session revocation (`epoch++`, utility-process `L_lock`, renderer concealment, blocking all new saves and blocking any `DIALOG`/`STAGING_WRITE` save from entering `COMMITTING_RENAME`).
     - Main then **holds final Lock completion acknowledgement** until every already-dispatched `COMMITTING_RENAME` settles or a bounded wait timeout (for example, 5 seconds) expires.
     - If the in-flight rename settles with success before Lock acknowledges, that save is ordered **before** Lock acknowledgement (`saveOutcome: 'committed-before-lock'`); Lock reports that an already-committing save finished and does not delete it.
     - If the in-flight rename fails (for example, `EACCES`, `EBUSY`, Windows Defender/antivirus handle lock, or I/O error), Main best-effort unlinks `tmpPath` and reports whether `finalPath` error handling succeeded or left disk state uncertain.
     - If the in-flight rename has **not** settled when the bounded wait expires (for example, stalled SMB/network drive or hung filesystem filter driver), Main still reports `sessionRevoked: true`, marks the save `UNRESOLVED`, and returns an explicit **`saveOutcome: 'unresolved'`** status warning that an in-flight rename did not finish before timeout and the user must inspect the destination path directly.
   - **Crash, power-loss, and failure behavior:** Once a write or rename syscall is handed to the OS kernel, neither an abort signal nor a pre-call check promises final-path immutability. If Main crashes, loses power, or encounters a filesystem driver error during `COMMITTING_RENAME`, whether `finalPath` holds the old or new contents is **unknown** until reconciled on disk. If Main crashes during `STAGING_WRITE` or unlink fails, `.cydeworks-tmp-*.part` residue can remain in the destination directory and must be treated as uncommitted residue rather than assumed erased.

### 6.3 Distinction: Server-Side Revocation vs. Client Observation (Already Delivered/Saved vs. Pending)

The table below separates what is deterministically guaranteed at the server (`L_lock`) from what depends on when a browser tab actually observes revocation or on Main-broker serialization:

| Category | Boundary / Observation Point | Actual Guarantee (and Honest Limit) |
| :--- | :--- | :--- |
| **SQLite mutations committed before `L_lock`** | Already saved on server | Committed permanently; Lock does not roll back prior task edits, reviews, or removals. |
| **Approved runs dispatched before `L_lock`** | Already started on server | Continue running (`stopsWork: false`, per `harness/SESSION-LOCK.md`); terminal control lease is revoked so locked views cannot issue commands. |
| **HTTP responses / artifact bytes written to socket before `L_lock`** | Already delivered | Cannot be pulled back off the wire; already-rendered DOM pixels, OS clipboard contents, and browser/GPU memory buffers cannot be provably erased by JavaScript. |
| **Files already handed to browser download manager (`a.click()`) or settled `COMMITTED` in Electron Main** | Already saved | Lock does not delete already-saved user files from the OS filesystem. |
| **Server requests mid-body or mid-probe at `L_lock`** | Pending on server | **Deterministic server guarantee:** Rejected with `401` (or `409` for mid-flight unlock) at Commit Boundary 1 / `L_read`; zero DB mutation and zero probe disclosure after `L_lock`. |
| **Browser fetch continuations in the locking tab, or in a sibling tab that has observed Lock before Commit Boundary 2** | Pending in tab (Lock observed) | Dropped silently at Commit Boundary 2 (`assertViewCurrentSync`); zero DOM reveal, zero dialog open, zero announcement, zero module-cache write. |
| **Browser fetch continuations in a sibling tab (same-profile or other profile) that has NOT yet observed Lock at Commit Boundary 2** | Pending in tab (Lock unobserved) | **Not guaranteed suppressed:** If the response bytes already arrived before `L_lock` and the tab reaches Commit Boundary 2 before observing `localStorage`, `BroadcastChannel`, SSE `session-ended`/EOF, or `401`, the tab can still reveal those already-delivered bytes until it observes Lock. |
| **Browser downloads in a tab that has observed Lock (or whose `POST /api/session/check` arrives after `L_lock`)** | Pending in tab (Lock observed) | Aborted before `a.click()` at Commit Boundary 3. |
| **Browser downloads whose `POST /api/session/check` returned `200` before `L_lock`, before the tab observes revocation** | Pending in tab (Lock unobserved) | **Not guaranteed aborted:** Can still invoke `a.click()` after the server already acknowledged Lock; the race window is **not** bounded to one RTT (see Section 6.4). |
| **Electron Main saves in `DIALOG` or `STAGING_WRITE` when Lock arrives** | Pending in Main broker | Cancelled before `COMMITTING_RENAME`; `fs.rename` is never called; temp file is best-effort unlinked (orphan `.part` possible on crash or unlink error). |
| **Electron Main saves already in `COMMITTING_RENAME` when Lock arrives** | In-flight rename in OS/libuv | Session revokes immediately; Lock acknowledgement waits (bounded) for rename settlement to report `committed-before-lock`, rename error, or `unresolved` (never falsely claiming final-path immutability). |

### 6.4 Cross-Profile and Cross-Process Lock Races (Explicit Honesty Analysis)

Prior reviews identified two distinct race surfaces that cannot be hand-waved, and neither has a fixed upper-bound time window:

1. **Same-profile, cross-process renderer race:** Modern browsers run tabs in separate renderer processes backed by an asynchronous storage IPC service. Waiting for `window.addEventListener('storage', ...)` is insufficient because a `fetch()` promise microtask in Tab B can run before the queued `storage` event fires. Reading `localStorage.getItem('bfe-shared-generation')` synchronously inside `assertViewCurrentSync` avoids the queued-event delay within one storage backing store, **but** multi-process `localStorage` propagation timing across Chromium/Edge/Firefox renderer processes is **unverified on Windows** and **is not an atomic global fence**.
2. **Cross-profile Lock race:** Profile 1 and Profile 2 do not share `localStorage`, `BroadcastChannel`, or `IndexedDB`. When Profile 2 clicks Lock:
   - Profile 1 receives no `localStorage` or `BroadcastChannel` update.
   - Profile 1 learns of Lock only when it receives `event: session-ended` / stream EOF over `POST /api/session/events`, or receives `401` on its next server call.
   - If Tab B in Profile 1 already received `200` from `POST /api/session/check` (or already received read response bytes before `L_lock`), and Profile 2 hits `L_lock` before Tab B invokes `a.click()` or renders, Tab B can still execute that local step after the server acknowledged Lock.
3. **Why the race window has NO fixed one-RTT maximum:** Under real OS and browser execution, tab backgrounding/timer throttling, renderer process suspension or OS sleep, CPU/scheduler contention, multi-process storage IPC queues, and loopback/kernel socket buffering delays can delay a tab's observation of `localStorage`, `BroadcastChannel`, or SSE `session-ended` arbitrarily longer than one loopback RTT. This design therefore **never claims a fixed one-RTT maximum race window**.

**Therefore: Neither a pre-save `POST /api/session/check` nor a `localStorage` sentinel alone is an atomic global fence.** The design combines server revocation push, a stream-liveness gate, a pre-save server check, and synchronous `localStorage` generation checks as defense-in-depth to reduce practical races, while stating clearly what remains unguaranteed in standalone browsers.

### 6.5 Honest Lock Completion and Acknowledgement Contract

When an operator clicks Lock, the UI and backend adhere to a strict honesty contract separating **proven server state** from **unknown remote-tab state**:

1. **What server acknowledgement (`200 {locked: true, lockedGeneration, revokedClientCount, ...}`) PROVES:**
   - `L_lock` completed atomically on the server for `lockedGeneration`.
   - Every `clientId` registered in `lockedGeneration` has been purged from `admittedClients` and `seenNonces`.
   - No future read, mutation, stream event, or terminal command authenticated under `lockedGeneration` will be accepted by the server.
   - Any active terminal control lease was revoked (`activeRun?.control.revoke()`).
   - The server enqueued `session-ended` frames and initiated close/destroy on all active SSE sockets known to it.
2. **What server acknowledgement DOES NOT PROVE (remains UNKNOWN to the locking tab and server):**
   - Whether any other open browser tab (in another renderer process of the same profile or in another profile) has finished observing revocation or concealing its rendered DOM.
   - Whether a tab that already held response bytes or a pre-Lock `200` from `POST /api/session/check` crossed Commit Boundary 2 or Commit Boundary 3 during scheduling, suspension, IPC, or network delay before observing revocation.
   - Whether already-delivered bytes have been cleared from browser memory, GPU buffers, OS clipboard, or previously saved files.
   - Whether an already-approved worker run has stopped (`stopsWork: false`).
3. **Fail-closed behavior for unreachable tabs, delayed responses, and lost Lock replies:**
   - **Unreachable / throttled / suspended tabs:** Because the server closes their SSE stream on Lock, when such a tab resumes or runs its next check it sees stream EOF/error, sets `revocationStreamHealthy = false` (blocking new saves immediately), and fails closed on its next server check (`401 -> CONCEALED`). However, how long it takes a suspended or throttled tab to wake and observe EOF is **unbounded and unknown**.
   - **Optional non-authoritative tab-concealment telemetry:** Within the same profile, sibling tabs may reply to `BroadcastChannel` with `{type: 'concealed', tabId, sessionGen}` for diagnostic display only. The Lock UI must **never** represent best-effort tab telemetry as a proof of global concealment.
   - **Delayed responses:** Any API promise or file read settling in a tab *after* that tab's `docEpoch` advances is discarded before Commit Boundaries 2 and 3.
   - **Lost Lock response:** The locking tab stays `CONCEALED`, deletes its IndexedDB PoP key, and displays explicit `unconfirmed` wording. It never unlocks automatically and never retries `POST /api/session/lock` silently.
4. **What requires a stronger broker, an acknowledgement protocol, or fresh user interaction to guarantee:**
   - **Ordered file-save commit vs. Lock:** Guaranteeing that no file write commits after Lock acknowledgement without reporting an explicit `unresolved` state requires a **single privileged local broker** owning both Lock and the filesystem commit step (as specified for Electron Main in Section 6.2, or an Option T2 Native Messaging host performing the file write directly instead of browser `a.click()`).
   - **Guaranteed post-Lock prohibition of browser downloads without a broker:** In a standalone browser using `a.click()`, closing the post-check window would require **fresh user interaction / re-authentication** bound to the save action itself, and even then browser download-manager handoff cannot be recalled once triggered.
   - **Confirmed multi-tab concealment before Lock acknowledgement:** Proving that sibling tabs concealed before Lock finishes would require an explicit **two-phase tab acknowledgement protocol** (where Lock waits for registered tabs to confirm concealment). Because a suspended, throttled, or crashed tab can fail to reply indefinitely, such a protocol still must **never block server revocation** and must report an explicit **partial / unresolved concealment status** for non-responding tabs rather than claiming global concealment.
   - **Defense against Adversary Class B or malicious same-origin JS:** Requires OS process/user isolation (AppContainer, dedicated OS user, or VM).

---

## 7. Bounded Replay Tracking, Concurrency, DoS Behavior, and Session Revocation

### 7.1 Bounded Replay Tracking (Fail-Closed Under Saturation)

- **Timestamp window:** Server checks `Math.abs(Date.now() - reqTsMs) <= 30_000` (30 seconds). Requests outside this window or with non-integer `ts` fail closed with `401`.
- **Nonce TTL cache:** Every accepted authenticated request inserts `key = clientId + ':' + nonce` with `expiresAtMonoNs = nowMonoNs + 60_000_000_000n` (60s = 2x timestamp skew window, ensuring a nonce cannot expire while its timestamp is still acceptable).
- **Duplicate nonce:** If `seenNonces.has(key)` and `expiresAtMonoNs > nowMonoNs`, fail closed with `401` (replayed request rejected).
- **Hard memory bounds and saturation behavior:**
  - Global cap: `MAX_SEEN_NONCES = 4096`.
  - Per-client cap: `MAX_NONCES_PER_CLIENT = 512`.
  - Pruning: Before rejecting for capacity, sweep expired entries (`expiresAtMonoNs <= nowMonoNs`, amortized O(1) via FIFO insertion order in JS `Map` since TTL is fixed at 60s).
  - **Fail-closed invariant:** Never evict an **unexpired** nonce to make room for a new request (evicting live nonces would allow replay within the 30s timestamp window). If the table remains at capacity after pruning expired entries, reject the incoming request with `429 Too Many Requests` (`Retry-After: 5`) without mutating workspace state.
- **No unproven claims:** Replay tracking is strictly in-memory per live `sessionGen`. Across service restarts, `sessionGen` changes, so old signed requests from a previous process lifetime are rejected by generation mismatch without needing disk-backed replay storage.

### 7.2 Concurrency Controls

- **Multi-tab same-profile concurrency:** Parallel requests from Tab 1..N use the same `clientId` and distinct 128-bit random nonces. No shared client-side sequence counter is needed, eliminating cross-tab counter-skew failures.
- **Bounded server resources:**
  - `MAX_TCP_CONNECTIONS = 32`
  - `MAX_HTTP2_CONCURRENT_STREAMS_PER_CONN = 32`
  - `MAX_ADMITTED_CLIENTS = 16` per active `sessionGen` (reject excess admissions with `429` rather than evicting active clients)
  - `MAX_EVENT_STREAMS_PER_CLIENT = 16`, `MAX_TOTAL_EVENT_STREAMS = 64` (excess stream opens return `429`, forcing the tab into degraded `revocationStreamHealthy = false` mode or leader sharing)
- **Workspace write concurrency:** Preserves existing single-process `acquireWorkspaceLock` mutual exclusion, SQLite `BEGIN IMMEDIATE` transactions, optimistic `task.version` checks (`409` on stale version), single-active-run guard, and keyed `run-submission` / `draft-copy` idempotency.

### 7.3 Denial-of-Service (DoS) Behavior and Honest Limits

- **Payload and timeout bounds:** Keep existing `48 KB` JSON body limit (`harness/server.mjs` line 208), enforce `headersTimeout = 10_000 ms`, `requestTimeout = 15_000 ms` (exempting authenticated long-lived `POST /api/session/events` streams after header/body verification), and cap raw header size at `16 KB`.
- **Failed-unlock throttling:** Track failed `POST /api/session/admit` attempts in a fixed sliding window (for example, 10 failures per 60 seconds -> `429` with `Retry-After`). Failed unauthenticated unlock attempts must **never** revoke or alter an already-active `sessionGen`, preventing unauthenticated loopback callers from forcing Lock DoS on an active session.
- **Honest DoS boundary:** These caps protect against runaway tab floods, accidental infinite loops, and basic slowloris connections. They do **not** defend against a hostile same-user local process (Adversary Class B), which can exhaust OS sockets, CPU, or terminate the Node process directly.

### 7.4 Session Revocation Mechanics

- Revocation is always single-turn atomic: rotate `sessionGen` (256-bit CSPRNG), `admittedClients.clear()`, `seenNonces.clear()`, clear `idleClock`, `activeRun?.control.revoke()`, push `session-ended`, and destroy all active SSE streams.
- Because `bfe_session` cookies and cookie-only fallbacks are deleted from the server, no secondary ambient credential exists that could bypass revocation.

---

## 8. Implementation Slices, Verification Plan, Review, and Separate Gates

### 8.1 Dependency-Ordered Small Implementation Slices

Each slice is sized for isolated review and deterministic testing. **Stage 1 (Slices 1-4)** consists of routine local development and offline synthetic tests (using ephemeral in-test keys only, with zero persistent certificates, trust-store edits, extensions, registry writes, or live service changes) and is covered by existing CydeWorks development authority without requiring another general go-ahead. **Stage 2 (Slices 5-6)** executes concrete OS/security/trust/extension/live-environment actions and is gated strictly on specific owner approval of those concrete actions before execution.

1. **Slice 1 (Stage 1 - Routine Local Implementation): Core Service Extraction & Session/Idle State Machine**
   - Extract `harness/workspace-service.mjs` from `harness/server.mjs`, preserving `acquireWorkspaceLock`, SQLite schema, single-active-run guard, terminal control, `recordInterruption`, and all runner holds.
   - Implement `LOCKED`/`ACTIVE` state machine, 15-minute monotonic+wall idle clock, clock-fault fail-closed handling, and `POST /api/session/lock` atomic revocation contract.
   - Remove `bfe_session` cookies and any cookie-only fallback.
2. **Slice 2 (Stage 1 - Routine Local Implementation): PoP Verifier, Bounded Replay Cache, Concurrency Caps & HTTP/2 SSE Stream**
   - Implement `POST /api/session/admit`, `GET /api/session/status`, `POST /api/session/check`, and `POST /api/session/events` over `node:http2` (TLS 1.3 with `allowHTTP1: true`; synthetic tests use ephemeral in-memory self-signed test certs only).
   - Implement ECDSA P-256 PoP signature verification, bounded `seenNonces` cache with fail-closed `429` saturation, connection/stream/client caps, read timeouts, and failed-unlock throttling.
3. **Slice 3 (Stage 1 - Routine Local Implementation): Browser UI PoP Adapter, Shared-Profile Lifecycle & Reveal/Save Fences**
   - Update both `harness/web/` and `harness/web-experience/` (`adapters/http.js`, `app.js`, `views/usage.js`, dialogs) to use IndexedDB `extractable: false` ECDSA P-256 keys, `POST /api/session/events` stream listener, `localStorage['bfe-shared-generation']` sentinel, `pagehide`/`bfcache` concealment, Commit Boundary 2 (`assertViewCurrentSync` across all continuations and `usage.js` `presented` Map wipe), and Commit Boundary 3 (pre-download check + stream-liveness gate).
   - Update asset integrity manifests (`harness/browser-assets.mjs`).
4. **Slice 4 (Stage 1 - Routine Local Implementation): Electron Zero-TCP Main-Brokered IPC & Serialized Staged Save**
   - Refactor `harness/desktop/main.cjs`, `service.cjs`, and add `preload.cjs` / `broker.cjs` for zero-TCP `utilityProcess.parentPort` RPC, `cydeworks://` asset serving, full navigation-lifecycle epoch invalidation (`did-start-navigation`, `did-navigate`, `render-process-gone`), and the Main-mediated `activeSaves` state machine (`DIALOG` -> `STAGING_WRITE` -> `COMMITTING_RENAME`) that serializes Lock acknowledgement against in-flight `fs.rename` and reports explicit `committed-before-lock`, error, or `unresolved` outcomes.
5. **Slice 5 (Stage 2 - Concrete Gated Actions): Transport Provisioning (T1a / T1b / T2)**
   - *Concrete owner approval required before executing:* persistent certificate/CA or credential creation, Windows `CurrentUser\Root` or Firefox trust-store changes (T1a/T1b), or extension signing/installation and `HKCU` Native Messaging registry writes (T2).
   - Implement and execute only the specifically approved provisioning ceremony, binding dual-stack loopback (`127.0.0.1` + `::1`) if local HTTPS is provisioned.
6. **Slice 6 (Stage 2 - Concrete Gated Actions): Real Windows Browser & Electron Acceptance Execution**
   - Execute real Windows acceptance tests across target browsers and Electron once any required trust/extension/staging actions are approved; record observed browser/OS differences and race latencies explicitly rather than extrapolating from Linux synthetic tests.
7. **Slice 7 (Final Security Gate): Independent Codex GPT-6.2 Sol High Review**
   - Submit final diffs, synthetic offline test results, and real Windows acceptance evidence for independent security review before any integration, deployment, or release packaging.

### 8.2 Deterministic Synthetic Offline Tests (Linux Sandbox, Ephemeral In-Test Certs Only)

Run in the verified offline Linux container (nonroot, loopback-only, read-only source, zero OS trust-store edits, ephemeral in-test TLS keys):

1. **Zero-cookie & transport auth:** Assert zero `Set-Cookie` headers anywhere; `401` on legacy cookie headers, unsigned direct navigation (`GET /api/tasks`, `GET /api/tasks/:id/artifact`), invalid `Origin`/`Host`, or rogue untrusted TLS listener.
2. **Admission & Lock races:** Mid-body `POST /api/session/admit` racing Lock returns `409`; mid-body operator `POST` racing Lock returns `401` with zero SQLite mutation; slow probe (`/api/models`, `/api/tasks/:id/readiness`) finishing after Lock returns `401` with zero disclosure.
3. **Bounded replay & DoS limits:** Reject replayed `(clientId, nonce)` with `401`; reject timestamp skew `> 30s` with `401`; fill `seenNonces` with unexpired entries to `MAX_SEEN_NONCES` and assert fail-closed `429` (proving live nonces are never evicted); verify expired nonces prune cleanly and allow subsequent requests; verify failed-unlock throttling returns `429` without revoking an active session.
4. **Multi-tab & cross-profile concurrency:** Parallel signed requests from one `clientId` with distinct nonces succeed without contention; two distinct `clientId`s (simulating Profile 1 and Profile 2) unlocked under one `sessionGen` are both revoked and both SSE streams closed when either calls `POST /api/session/lock`.
5. **Idle expiry & clock faults:** Simulated monotonic advance `>= 15 min` revokes session; passive reads/heartbeats do not extend deadline; backward monotonic or wall clock jump fails closed to `LOCKED`.
6. **Frontend Reveal & Save Fence race matrix:** Inject foreign `lock.<32-hex>` into `localStorage` *without* dispatching a `storage` event while `getTask`, `listTasks`, `readiness`, `downloadArtifact`, `loadSourceFile`, `openHandoffReview`, `costPresentation`, and `actions.download` are pending -> assert zero DOM mutations, zero `a.click()`, zero dialog opens, and `usage.js` `presented` Map emptied. Also test disconnected SSE stream blocking downloads (`revocationStreamHealthy === false`) and lost Lock response keeping view concealed with `unconfirmed` notice.
7. **Interrupted requests & service restart:** Dropped socket after Commit Boundary 1 reconciles cleanly via `run-submission` / `draft-copy` lookup; service restart clears `admittedClients`, rotates `sessionGen`, rejects old `clientId` with `401`, and marks running tasks interrupted.
8. **Electron Zero-TCP & serialized staged save:** Zero listening TCP sockets; `will-navigate` and programmatic `did-start-navigation` invalidate in-flight IPC replies; Lock during `DIALOG` or `STAGING_WRITE` never calls `fs.rename`, leaves `finalPath` untouched, and attempts `.cydeworks-tmp-*.part` cleanup; Lock during an injected delayed `COMMITTING_RENAME` revokes session immediately, holds Lock acknowledgement until rename settles (`committed-before-lock` or rename error), and returns `saveOutcome: 'unresolved'` on bounded timeout without claiming final-path immutability; `acquireWorkspaceLock` prevents concurrent desktop + browser service launch.

### 8.3 Real Windows Browser and Electron Acceptance Tests (Stage 2)

Synthetic Linux tests do **not** prove Windows CryptoAPI, Firefox NSS, IndexedDB persistence, HTTP/2 multiplexing, or Electron 45 Windows behavior. Each target browser (Chrome, Edge, and Firefox if in scope) and Electron must be tested directly on Windows, recording any browser-specific variance:

1. **TLS / Identity (T1) or Native Host (T2):** Zero browser certificate warnings on `https://localhost:<port>`; verify Root CA private key is absent from disk (T1a); verify `localhost` IPv4 + IPv6 dual-stack behavior; inspect loopback capture to confirm zero plaintext workspace data or secrets; stop service and bind a rogue self-signed listener (without `.state/tls/` private key) on the same port and confirm browser fails closed before HTML/JS loads.
2. **Refresh & Relaunch UX:** Unlock once with `.state/access.key`; press `F5` multiple times (including opener-launched tabs) -> zero prompts; fully close all browser windows, relaunch browser within 15 minutes while service stays running -> verify IndexedDB `extractable: false` `CryptoKey` persists and stays signed in with zero prompts.
3. **Same-Profile Multi-Tab & Cross-Profile Isolation:** Open 8+ tabs in Profile 1 -> verify HTTP/2 multiplexes SSE streams without 6-connection starvation. Open Profile 2 -> verify it lands on the concealed `.state/access.key` prompt and cannot read Profile 1's session. Test copying Profile 1's IndexedDB storage files into a disposable test profile on Windows and record empirically whether Windows DPAPI/App-Bound Encryption blocks or allows key use (do not assume the result).
4. **Live Cross-Tab & Cross-Profile Lock Races:** Throttle an artifact download and task read in Profile 1 Tab B, trigger Lock in Profile 1 Tab A (and separately in Profile 2) while Tab B is still before Commit Boundary 3 -> verify Tab B conceals and aborts download once Lock is observed, and measure/record actual cross-process `localStorage` and SSE propagation delays (including backgrounded/throttled tabs). Test browser Back/Forward `bfcache` after Lock (`pagehide`/`pageshow`). Wait past 15-minute idle timeout (or configured test window) and restart service -> confirm all tabs conceal and require `.state/access.key`.
5. **Real Windows Electron Acceptance:** Verify zero listening TCP sockets via `netstat`; verify seamless open, `F5` reload, programmatic navigation cancellation, Lock during native `showSaveDialog` and `STAGING_WRITE` leaving `finalPath` untouched, Lock-vs-`COMMITTING_RENAME` serialization and `unresolved` timeout handling, and utility process crash/exit teardown.

### 8.4 Required Independent Security Review Gate

Before integrating any implementation slice into the release line or qualifying browser staging:
- Run an independent read-only security review using exact provider `codex`, model `gpt-6.2-sol`, option `reasoningEffort=high` (Codex GPT-6.2 Sol High), with no paid/API fallback.
- Provide the exact git diff, synthetic offline test evidence, and (for Stage 2) real Windows browser and Electron acceptance records, including any recorded browser/OS discrepancies.

### 8.5 Separate Qualification Gates Preserved Before Live Runner Staging

Completing and approving this shared browser session design does **not** authorize connecting any runner or live worker to browser staging. The following remain separate, independent gates (consistent with `docs/T3-BROWSER-LOCK-REQUIREMENTS-2026-11-19.md`, `docs/T3-LOCK-VALIDATION-2026-11-19.md`, and `docs/T3-REQUEST-CLAIMS-LIMITS-2026-11-19.md`):

1. **Windows Stop qualification:** Real OS-level process-tree termination verification for OpenCode / worker processes on Windows.
2. **Recovery qualification:** Real worker-tree and Windows durability/power-loss recovery (the disconnected request-claims helper in `docs/T3-REQUEST-CLAIMS-LIMITS-2026-11-19.md` is not qualified for live runner attachment and still requires external resource/time bounds and keyed provenance).
3. **Verifier qualification:** Independent verification of worker output against trusted fixtures and host isolation boundaries.
4. **Patch binding qualification:** Verified end-to-end binding of approved patches, sealed handoff, and write-back gates before any writable repository runner is exposed to browser staging.

---

## 9. Open Questions, Residual Risks, and Unverified Browser/OS Behavior

### 9.1 Open Questions Requiring Engineering Resolution or Concrete Action Approval

1. **OQ-1 (Concrete transport provisioning approval before Stage 2):** Engineering recommends preparing **T1a** (Name-Constrained local Root CA + RAM-only CA key) or evaluating **T1b** (directly trusted loopback leaf cert) as the primary local HTTPS design, with **T2** (signed extension + Native Messaging) as the zero-CA alternative. Executing the chosen transport's concrete host changes (creating persistent certificates/credentials, editing `CurrentUser\Root` or Firefox trust stores, or installing an extension and writing `HKCU` registry manifests) requires specific owner approval before Stage 2 execution.
2. **OQ-2 (Target Windows browser scope):** Clarify whether personal-release browser scope is Chrome and Edge only (Windows `CurrentUser\Root`) or also includes Firefox (which adds a concrete Firefox trust-store or Mozilla AMO approval step).
3. **OQ-3 (Leaf certificate renewal cadence under T1):** Determine leaf validity lifetime (for example 90 days vs. 180 days vs. 365 days) and pre-expiry UI reminder threshold (for example 14 days) prior to any owner-approved certificate enrollment.
4. **OQ-4 (Idle-clock extension routes):** Decide whether read-only interactive navigation (clicking between tasks in the UI without mutating data) should extend the 15-minute idle deadline via an explicit user-gesture route, or whether only state-mutating / explicit operator actions extend it. (Background polling must never extend it.)
5. **OQ-5 (Cross-profile Lock and concurrent unlock policy - design recommendation not yet selected by owner):** The owner approved shared-session Lock across tabs within one signed-in profile. This design additionally recommends retaining `harness/SESSION-LOCK.md`'s workspace-wide Lock across independently admitted profiles; decide whether to keep concurrent multi-profile sessions sharing a revocable `sessionGen`, or instead rotate `sessionGen` to displace Profile 1 whenever Profile 2 unlocks.
6. **OQ-6 (HTTP/1.1 downgrade behavior):** Decide whether to allow single-leader-tab SSE fallback if a local Windows configuration downgrades `https://localhost:<port>` to HTTP/1.1, or fail closed with a single-tab warning.

### 9.2 Residual Risks

| Risk | Severity | Cause | Mitigation & Honest Boundary |
| :--- | :--- | :--- | :--- |
| **Equivalent-user local process compromise (Adversary Class B)** | High (Out of Scope) | Same Windows user account may have filesystem/process access to `.state/access.key`, `.state/tls/` private keys, browser profile files, and Node/browser process memory. | Local HTTPS does not defend against an equivalent-user process; explicitly out of scope for user-mode local web apps and requires future OS isolation (AppContainer, dedicated OS user, or VM). |
| **Malicious same-origin JS / browser extension with host permissions** | High | `extractable: false` blocks raw key export, not `crypto.subtle.sign` abuse inside the same origin. | Mitigated by strict CSP (`default-src 'none'; script-src 'self'`), zero inline scripts, asset hash verification, and TLS/extension initial-load authentication; not mitigated if browser itself is compromised. |
| **Cross-process and cross-profile post-Lock reveal / download TOCTOU (unbounded window)** | Medium | Neither `localStorage` nor `POST /api/session/check` is an atomic global fence; tab suspension, OS scheduling, storage IPC queues, and network buffering can delay revocation observation arbitrarily beyond one RTT. | Narrowed by SSE push + stream-liveness gate + pre-save server check + synchronous `localStorage` check; strict ordering requires a single privileged broker owning Lock and file commits (Electron Main / T2 native write), a partial-failure-aware tab ACK protocol, or fresh user interaction on save. |
| **Unresolved Electron rename on crash, driver hang, or power loss** | Medium | OS kernel / filesystem rename cannot be atomically rolled back once dispatched, and may stall on network shares or antivirus filter drivers. | Electron Main serializes Lock acknowledgement against `COMMITTING_RENAME` with a bounded wait and reports explicit `committed-before-lock`, error, or `unresolved` outcomes; never claims final-path immutability from an abort or pre-call check. |
| **Stolen browser profile directory reuse** | Medium (Unverified) | Browser IndexedDB at-rest protection varies by browser and Windows DPAPI/App-Bound Encryption version. | Not claimed as mitigated; must be empirically tested on Windows in Stage 2 and documented truthfully. |
| **Non-erasable disk/memory remnants of keys or rendered data** | Medium | SSD wear-leveling/FTL, NTFS journals, VSS, pagefile, GPU buffers, clipboard, and already-saved files. | Keep T1a Root CA key RAM-only; never claim secure disk deletion; disclose already-delivered data limits clearly in Lock UI. |
| **Clock skew affecting 30s PoP window** | Low | Large wall-clock jump between browser and server (unlikely on single-host loopback since both read the OS clock, except across VM/WSL boundaries or NTP steps). | Monotonic clock guards idle expiry and nonce TTL; wall-clock backward jump fails closed to `LOCKED`. |

### 9.3 Unverified Browser and OS Behavior (Must Be Tested Empirically on Windows)

The following behaviors are **unverified** as of commit `c0df0f576db84bb9b962a2ac50a95ceda4c02079` and must be confirmed in Stage 2 Windows tests before any release claim:

1. **Windows CryptoAPI (Chrome/Edge) and Mozilla NSS (Firefox) Name Constraints handling:** Whether `critical` RFC 5280 Name Constraints combining `DNS:localhost`, `IP:127.0.0.1/32`, and `IP:::1/128` validate cleanly without warnings across all target Windows browser versions.
2. **Direct leaf certificate trust (Option T1b):** Whether Chrome, Edge, and Firefox on Windows accept a `CA:FALSE` self-signed loopback leaf certificate placed in `CurrentUser\Root` / NSS without CA warnings.
3. **IndexedDB `extractable: false` `CryptoKey` persistence across browser restarts and crashes:** Verified persistence across full quit+relaunch on Windows Chrome, Edge, and Firefox, and empirical behavior when profile storage files are copied to a second profile.
4. **HTTP/2 `fetch()` `ReadableStream` SSE multiplexing:** Confirming 8+ simultaneous tabs multiplex cleanly over one TLS 1.3 HTTP/2 connection without triggering HTTP/1.1 connection-pool starvation or browser background-tab stream throttling.
5. **Multi-process `localStorage` and SSE revocation visibility latency:** Measuring actual propagation delay across distinct renderer processes and backgrounded/throttled tabs on Windows under CPU load.
6. **`bfcache` interaction with `Cache-Control: no-store` and `pagehide`:** Confirming Back/Forward navigation after Lock never flashes stale workspace DOM before `BOOTING` re-verification runs.
7. **Dual-stack `localhost` (`127.0.0.1` and `::1`) resolution and bind behavior on Windows:** Confirming no race or port-conflict failure between IPv4 and IPv6 loopback listeners.
8. **Electron 45 on Windows:** Confirming `cydeworks://` ES module loading under strict CSP, `WebFrameMain` identity stability across reloads, `did-start-navigation` / `ipcMain.handle` late-reply disposal, and Main-broker Lock-vs-`COMMITTING_RENAME` serialization and error/timeout handling over Windows Defender/antivirus file-handle locks.
