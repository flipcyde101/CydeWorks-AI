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
   - *Design recommendation (not separately selected by the owner):* This document also recommends keeping `harness/SESSION-LOCK.md`'s existing workspace-wide Lock scope (`scope: "all-workspace-views"`) so that if a second browser profile is independently unlocked against the same workspace service, a Lock revokes all admitted profiles together. The owner did not separately select cross-profile revocation policy; keeping it shared vs. displacing an older profile on second-profile unlock remains an explicit design choice in Section 9.1 (OD-5).

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
  - Protected local state: `.state/workspace.sqlite`, `.state/workspace.sqlite.owner.sqlite`, `.state/access.key` (owner-only permissions), `.state/pending-saves.json` (or SQLite pending-save journal), and (if T1 provisioning is approved) `.state/tls/` leaf private key.
- **Electron Desktop Mode (`BFE_DESKTOP_IPC=1`):**
  - Trusted Electron Main process (`harness/desktop/main.cjs`) and its spawned Node `utilityProcess` workspace service communicating solely over `utilityProcess.parentPort` (zero listening TCP sockets).
  - Sandboxed Electron Renderer loading assets over a privileged `cydeworks://` custom protocol at exact URL `cydeworks://app/index.html` with `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, `nodeIntegration: false`, and `webviewTag: false` (preserving and extending `harness/desktop/main.cjs` lines 66-74).

### 2.2 Adversary Classes Addressed by This Design

Adversaries are defined strictly by their **actual access to keys, files, and processes**, not by generic privilege labels:

- **Adversary A1 (Passive loopback observer without key, file, or process access):** A process or loopback packet capture that can read loopback network traffic, **but cannot** read `.state/access.key`, `.state/tls/` private keys, or browser profile storage, and cannot inspect or inject into the browser or service processes. Mitigated by TLS 1.3 (Option T1) or OS-authenticated local pipes with zero TCP sockets (Option T2 / Electron IPC), plus removing all bearer cookies and URL secrets.
- **Adversary A2 (Active local port replacer without access to CydeWorks keys, other trusted localhost keys, broker files, or target processes):** A local process (for example, another OS user account, a restricted service account, or a sandboxed/AppContainer process) that can bind the workspace loopback port before the legitimate service starts or after it exits to serve malicious HTML/JS on `GET /` or capture unlock secrets, **subject to the exact credential-access boundary below**:
  - Under **Option T1 (local HTTPS):** Mitigated **only** when the port replacer has **neither** read access to `.state/tls/` leaf private key **nor** access to any *other* private key whose certificate is already trusted by the browser/OS for `localhost` (such as a pre-existing developer CA or corporate root; see Section 3.2).
  - Under **Option T2 (signed extension + Native Messaging):** Mitigated when the attacker has no write access to the signed extension package, `HKCU` Native Messaging manifest/binary, or owner-only workspace Named Pipe / `.state/` files (immune to unrelated `localhost` TLS certificates).
  - *Critical boundary note:* An ordinary unprivileged process running as the **same Windows user** may already have filesystem read access to `.state/tls/`, `.state/access.key`, and Named Pipes, as well as process access to the browser and Node service. Such an equivalent-user process belongs to **Adversary Class B**, not Adversary A2. **Local HTTPS does not protect against an equivalent-user process.**
- **Adversary A3 (Cross-origin web page / CSRF / direct navigation):** A malicious third-party website or direct browser address-bar navigation attempting to invoke `/api/*` endpoints without access to local files, keys, or the CydeWorks origin. Mitigated by eliminating cookies entirely (`Set-Cookie` removed), requiring per-request Proof-of-Possession (PoP) signatures in custom headers over a single canonical request target, strict `Host`/`Origin` and framing checks, `Sec-Fetch-Site` defense-in-depth checks, and strict Content-Security-Policy (`default-src 'none'`).
- **Adversary A4 (Distinct browser profile without `.state/access.key`, or another network device):** Another browser profile on the same machine that has not been given `.state/access.key` and cannot read Profile 1's IndexedDB/extension storage, or another host on the network (blocked by loopback-only binding on `127.0.0.1` / `::1`, or zero TCP sockets under T2/Electron).

### 2.3 Explicitly Out-of-Scope Threats and Non-Claims

The following threats are **not** solved by this browser session design and must never be claimed as mitigated without a separate, qualified OS, browser-pinning, or hardware boundary:

1. **Adversary Class B (Equivalent-user local process with access to keys, files, or target processes):** Any local process running as the same Windows user (even without Administrator elevation) may be able to read `.state/access.key`, read `.state/tls/` leaf private keys, connect to owner-accessible Named Pipes, read browser profile directories, attach a debugger, or inject code into the browser or Node process. Local HTTPS, NTFS user-only ACLs, Named Pipe owner DACLs, and browser-side Web Crypto do **not** defend against an equivalent-user process. Defending against Adversary Class B requires OS-level isolation (a separate OS account, Windows AppContainer, or VM), which is outside this design.
2. **Pre-existing unrelated browser-trusted `localhost` certificates (Option T1 limit):** Under standard browser TLS (T1a/T1b), the browser trusts *any* certificate chaining to *any* CA in `CurrentUser\Root`, `LocalMachine\Root`, or Firefox NSS that is valid for `localhost` (for example, an existing `mkcert` CA, `dotnet dev-certs`, or enterprise inspection root). Ordinary browser TLS **does not pin CydeWorks's specific leaf certificate**. If an adversary holds the private key for another already-trusted `localhost` certificate and replaces the port before `GET /`, browser TLS will accept that listener and load attacker-controlled HTML/JS. Closing that gap requires either **Option T2** (pinned extension UI + authenticated local broker) or removing/excluding competing trusted `localhost` certs from the host trust store.
3. **Malicious same-origin JavaScript or browser compromise:** Storing a Web Crypto `CryptoKey` with `extractable: false` in IndexedDB prevents same-origin script from calling `crypto.subtle.exportKey` to read raw key bytes. It does **not** prevent malicious same-origin JavaScript (such as an XSS payload or a compromised browser extension with host permissions) from invoking `crypto.subtle.sign` on that key handle to forge authorized API requests, nor does it protect against a compromised browser renderer process or equivalent-user memory inspection.
4. **Offline copy of browser profile storage to another profile or device:** If an attacker with filesystem access copies a signed-in browser profile directory (including its IndexedDB backing files), whether the stored `extractable: false` `CryptoKey` remains usable in another profile or on another Windows machine depends on each browser's proprietary OS key-wrapping implementation (for example, Chromium DPAPI / App-Bound Encryption or Firefox NSS key storage). This design **does not claim** that copied browser profile storage is cryptographically unexportable or non-transferable without empirical Windows verification.
5. **Non-authentication signals:** `window.opener`, `Sec-Fetch-*` Fetch Metadata headers, `Referer`, `localStorage`, `BroadcastChannel`, and caller-supplied client/tab labels are never treated as proof of identity or document lineage. Fetch Metadata and `Origin`/`Host` serve strictly as defense-in-depth CSRF barriers alongside cryptographic PoP verification.

---

## 3. Authenticating Initial HTML/JS, Intended Service Identity, Migration, and Transport Options

Because plaintext HTTP delivers initial HTML and JavaScript without integrity or server authentication, an active pre-load port replacer (Adversary A2) can serve trojanized JavaScript on `GET /` that captures unlock secrets before any application-layer cryptography runs. **Plaintext HTTP plus application-layer encryption (Option T4 below) is therefore explicitly rejected as insufficient.**

### 3.1 Comparison of Concrete Supportable Options

| Option | Initial HTML/JS & Service Auth Mechanism | Intended Service Identity & Pinning Boundary | Browser / OS Dependencies & Scope/Renewal | Concrete Approval Gate |
| :--- | :--- | :--- | :--- | :--- |
| **T1a. Local HTTPS with Scoped Local Root CA** *(Primary HTTPS candidate)* | Dedicated Name-Constrained local Root CA signs a loopback leaf cert (`https://localhost:<port>`). Leaf private key kept in `.state/tls/` (owner-only NTFS ACL). TLS 1.3 authenticates server before `GET /`; mutual HMAC admission verifies server holds `.state/access.key`. | Authenticates `localhost` via OS/browser trust store, **NOT pinned to CydeWorks alone** if another trusted `localhost` cert exists on the host (Section 2.3 #2). Using a narrow hostname (`cydeworks.localhost` with RFC 6761 loopback resolution) reduces accidental collision with plain `localhost` dev certs, but still does not defeat unconstrained root CAs in the OS store. | Chrome/Edge: one-time import of Root CA into Windows `CurrentUser\Root`. Firefox (if in scope): `security.enterprise_roots.enabled` or NSS `cert9.db`. Root CA Name Constraints: `DNS:cydeworks.localhost`, `DNS:localhost`, `IP:127.0.0.1/32`, `IP:::1/128`, `pathLenConstraint: 0`. Leaf validity 90-365 days. | Separate owner approval for CA/leaf ceremony, `CurrentUser\Root` import, and Firefox scope. |
| **T1b. Local HTTPS with Directly Trusted Loopback Leaf Cert (No CA)** *(Zero-CA HTTPS candidate)* | Self-signed non-CA loopback leaf cert (`CA:FALSE`, SAN `DNS:cydeworks.localhost`, `DNS:localhost`, `IP:127.0.0.1`, `IP:::1`) trusted directly as a leaf anchor. Zero CA signing capability exists. | Same browser trust-store boundary as T1a (does not prevent another already-trusted `localhost` cert from validating in the browser). Eliminates CA over-issuance risk entirely. | Same OS/browser store touchpoint as T1a; must be empirically verified on Windows Chrome, Edge, and Firefox (some NSS/CryptoAPI/Chromium paths reject `CA:FALSE` end-entity certs in Root stores). Rotation requires replacing leaf anchor and removing old thumbprint. | Separate owner approval for leaf cert trust + empirical Windows compatibility proof first. |
| **T2. Signed Browser Extension + Native Messaging Broker** *(Pinned-UI / Zero-TLS / Optional Strict Save Broker)* | Initial HTML/JS packaged inside a cryptographically signed extension (`chrome-extension://<id>` / `moz-extension://<id>`). Thin Native Messaging broker authenticates to a long-lived workspace service over an owner-only Windows Named Pipe (zero TCP ports). | **Establishes pinned CydeWorks UI identity** independent of OS TLS trust stores and competing `localhost` certs; broker authenticates workspace service via owner-only Named Pipe + mutual challenge-response bound to `.state/access.key` (Section 3.5). Can also mediate OS file saves to satisfy strict Stage C Save/Lock ordering (Section 6.3). | Signed extension distribution (Chrome Web Store / Edge Add-ons / Mozilla AMO, or enterprise policy), plus one-time `HKCU\Software\{Google\Chrome,Microsoft\Edge,Mozilla}\NativeMessagingHosts\...` registry keys and manifest JSON files. 1 MB Native Messaging message framing required. | Separate owner approval for extension packaging, store publication, and `HKCU` registry registration. |
| **T3. Public CA / ACME with DNS -> `127.0.0.1`** *(Not recommended)* | Publicly trusted CA certificate for a real DNS name resolving to loopback. | External DNS/CA dependency; still non-pinned in browser unless using extension/CT monitoring. | Requires external DNS provider, internet connectivity for ACME issuance/renewal, and per-user unique subdomains. Conflicts with local-first offline personal release. | Not recommended; would require cloud DNS and external CA approval. |
| **T4. Plaintext HTTP + App-Layer Crypto** *(Rejected)* | None for initial HTML/JS delivery. | Fails Adversary A2 completely: port replacer modifies initial JS before any crypto runs. | N/A | Rejected as non-compliant with `docs/T3-BROWSER-LOCK-REQUIREMENTS-2026-11-19.md`. |

*Note on Electron Desktop mode:* Electron uses a separate **Zero-TCP Main-Brokered IPC** transport (`cydeworks://app/index.html` privileged scheme + `utilityProcess.parentPort`). It pins initial HTML/JS in Main's verified asset map, requires no local CA, no browser extension, and no loopback TCP listener, and remains unaffected by the T1 vs. T2 standalone-browser decision.

### 3.2 Certificate Authority Scope, Renewal, Retirement, and Intended-Identity Limits (T1a / T1b)

1. **Mandatory X.509 v3 constraints (T1a):**
   - Root CA: `basicConstraints = critical, CA:TRUE, pathLenConstraint:0`; `keyUsage = critical, keyCertSign, cRLSign`; `nameConstraints = critical, permitted;DNS:cydeworks.localhost, permitted;DNS:localhost, permitted;IP:127.0.0.1/255.255.255.255, permitted;IP:0:0:0:0:0:0:0:1/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff`. (If `cydeworks.localhost` passes Windows Chrome/Edge/Firefox RFC 6761 resolution verification in Stage 2, narrow permitted DNS further to `DNS:cydeworks.localhost` alone so unrelated `localhost` names are excluded from the CA's own scope.)
   - Leaf certificate: `basicConstraints = critical, CA:FALSE`; `keyUsage = critical, digitalSignature`; `extendedKeyUsage = serverAuth`; `subjectAltName = DNS:cydeworks.localhost, DNS:localhost, IP:127.0.0.1, IP:::1`; validity bounded to at most 365 days (within the 398-day industry ceiling).
2. **Honest intended-service-identity boundary under T1:**
   - **Pre-load limitation:** Browser TLS validates the server against all roots in Windows `CurrentUser\Root`, `LocalMachine\Root`, and (if enabled) Firefox NSS. It does **not** pin the CydeWorks leaf thumbprint. Therefore, T1 protects against an Adversary A2 that does **not** possess any other browser-trusted private key valid for the origin hostname. Stage 2 provisioning must audit and warn the owner if existing unconstrained developer CAs (for example `mkcert`, `dotnet dev-certs`) are present in `CurrentUser\Root`, and explicitly disclose this boundary.
   - **Post-load mutual service-identity proof at admission:** Once the trusted page loads, `POST /api/session/admit` uses a two-step **mutual HMAC challenge-response** bound to `.state/access.key` (Section 4.2) rather than sending raw `.state/access.key` bytes over the wire. An honest page therefore also proves that the local listener actually holds `.state/access.key` before accepting `sessionGen` or revealing UI. (This is defense-in-depth and does **not** rescue an already-replaced initial HTML/JS document.)
3. **What happens if constraints are not honored, or on expiry, rotation, and retirement:**
   - **Ignored Name Constraints + retained CA key:** Because Windows CryptoAPI and NSS edge cases around combined `IP` + `DNS` Name Constraints can vary across versions, **mitigation cannot rely solely on Name Constraints**: the T1a Root CA private key must never be written to disk (Section 3.3), and out-of-scope issuance (`example.com`, non-loopback IP) must be explicitly tested in both synthetic and Windows Stage 2 suites.
   - **Rotation and retirement:** Replacing a leaf (or CA + leaf) requires: (a) installing the new anchor/leaf, (b) restarting/reloading the service with the new leaf keypair, (c) **explicitly deleting the retired Root CA / leaf certificate thumbprint from `CurrentUser\Root` (and Firefox NSS if in scope)**, and (d) deleting the retired `.state/tls/` leaf key file. A verification check must confirm the retired leaf cert now fails TLS validation.
   - **Leaf expiry or mismatch:** Browsers must fail closed with a hard TLS error. CydeWorks UI/docs must never instruct bypassing warnings or passing `--ignore-certificate-errors`.
   - **Dual-stack loopback binding mismatch:** On Windows, `localhost` and `*.localhost` resolve to both `::1` and `127.0.0.1`. The service must bind both `127.0.0.1` and `::1` on the same port (or fail startup if either loopback family cannot be secured) to prevent single-stack port squatting DoS.

### 3.3 Private-Key Lifecycle and Limitations of Claiming Secure Deletion on Modern Storage

1. **Root CA private key lifecycle (T1a):**
   - Generate the Root CA keypair **strictly in process RAM** inside the one-time provisioning tool, sign the loopback leaf certificate in memory, zero the allocated key buffer (`Buffer.fill(0)`) immediately after signing, and **never write the Root CA private key to disk**.
   - Even with RAM-only generation, V8 garbage-collected copies, OpenSSL internal heap buffers, Windows virtual-memory paging (`pagefile.sys`), hibernation images (`hiberfil.sys`), and OS crash dumps mean zeroing a JS/Node buffer is best-effort hygiene rather than a hardware-enforced erasure proof.
2. **Leaf private key lifecycle (T1a / T1b):**
   - The leaf private key persists under `.state/tls/` with owner-only NTFS ACLs (or, as a future Windows hardening option requiring separate evaluation, wrapped via Windows CNG / DPAPI so the raw PEM key is not plaintext on disk).
   - Because `.state/tls/` is readable by the same OS user, it does not resist Adversary Class B; it protects against Adversary A1/A2 and non-owner local accounts.
3. **Explicit limitations of claiming secure deletion on modern storage:**
   - Modern NVMe/SATA SSDs implement Flash Translation Layer (FTL) wear-leveling, over-provisioning, and copy-on-write block remapping. Overwriting and unlinking a file does **not** guarantee previous flash pages containing private-key bytes were physically erased.
   - Windows NTFS journaling (`$LogFile`, USN journal), Volume Shadow Copies (VSS), system restore points, antivirus scans, and backup agents can retain historical copies of any key file that ever touched disk.
   - **Design rule:** Never claim "cryptographically secure deletion" of key material written to disk on Windows. Keep the T1a Root CA key RAM-only, enforce narrow Name Constraints, remove retired anchors from `CurrentUser\Root` during rotation, and treat any suspected leaf key exposure under Adversary Class B as requiring full key rotation and trust-store replacement.

### 3.4 Trusted First-Launch and Migration Path from Legacy HTTP Links

1. **Canonical first-launch entry point:**
   - Before Stage 2 transport provisioning (T1 cert enrollment or T2 extension/registry setup) is approved and verified, standalone browser mode **fails closed** on startup with an actionable CLI message (never silently falling back to plaintext HTTP).
   - Once provisioned, the CydeWorks launcher opens **only** the canonical authenticated origin (`https://cydeworks.localhost:<port>/` or `https://localhost:<port>/` under T1; `chrome-extension://<pinned-id>/index.html` under T2).
2. **Migration from legacy `http://127.0.0.1:<port>` bookmarks and links:**
   - **No plaintext HTTP redirect listener:** CydeWorks must **never** run a plaintext HTTP listener to redirect `http://127.0.0.1:<port>` to HTTPS, because Adversary A2 can intercept the initial plaintext HTTP request before any redirect executes.
   - **Fail-closed legacy cutoff:** Legacy `http://127.0.0.1:<port>` bookmarks fail closed (TLS protocol error on the HTTPS port under T1, or connection refused under zero-TCP T2). Old `bfe_session` cookies and legacy HTTP-origin `localStorage`/`sessionStorage` data reside on a separate origin and are never read or honored.
   - **Defense-in-depth HSTS (T1):** Authenticated HTTPS responses emit `Strict-Transport-Security: max-age=31536000` (without `includeSubDomains` on `localhost`, or scoped to `cydeworks.localhost`) so browsers upgrade subsequent visits to the same host, while explicitly noting that HSTS does not protect first visit or different ports.

### 3.5 Option T2 Architecture: Broker Authentication and Service Survival Across Browser Relaunch

Because standard browser Native Messaging spawns a host child process bound to the browser extension's port lifecycle (terminating that host when the browser closes), Option T2 decouples the **thin Native Messaging broker** from the **long-lived workspace service** so the owner's relaunch UX is preserved without prompts:

1. **Long-lived Workspace Service (`harness/workspace-service.mjs`):**
   - Runs independently of the browser process (started by the CydeWorks launcher / Windows user session), holds `acquireWorkspaceLock`, and maintains `ACTIVE` session state across browser quit and relaunch (within the 15-minute idle window).
   - Listens **solely** on a local OS-authenticated IPC endpoint: on Windows, a Named Pipe `\\.\pipe\cydeworks-ws-<sha256(workspacePath).slice(0,16)>` created with `FILE_FLAG_FIRST_PIPE_INSTANCE` and an explicit owner-only DACL (`D:(A;;GA;;;OW)`); in Linux synthetic tests, an owner-only Unix domain socket (`0600`). Zero TCP ports are opened.
2. **Thin Native Messaging Broker (`cydeworks-nm-broker`):**
   - Registered under `HKCU\Software\{Google\Chrome,Microsoft\Edge,Mozilla}\NativeMessagingHosts\com.cydeworks.broker` with `allowed_origins` / `allowed_extensions` pinned strictly to the exact signed extension ID.
   - Spawned transiently whenever the extension connects (`runtime.connectNative`), connects to the workspace service's Named Pipe, and handles length-prefixed chunking to stay safely below Native Messaging's 1 MB host-to-extension message cap.
3. **Broker-to-Service Mutual Authentication:**
   - On startup, the workspace service writes a per-launch random 256-bit `pipeAuthSecret` (or derives a broker-authentication key from `.state/access.key` + `launchNonce`) to an owner-only runtime file `.state/broker-auth.token` (deleted on clean shutdown).
   - Upon connecting to the Named Pipe, the thin broker and workspace service execute a mutual HMAC handshake over `pipeAuthSecret` (proving the pipe server is the live workspace service for this workspace, and proving the broker belongs to the same owner workspace) before forwarding any framed API request, PoP signature, or revocation event.
   - *Boundary note:* Just like T1, owner-only Named Pipe DACLs and `.state/broker-auth.token` defend against non-owner local accounts and unauthorized extensions/pages (Adversaries A1-A4), and do **not** defend against an equivalent-user local process (Adversary Class B).
4. **Survival Across Browser Relaunch:**
   - When the owner closes all browser windows, only the thin Native Messaging broker exits; the workspace service remains live and keeps `sessionGen` and `admittedClients` intact.
   - On browser relaunch, the extension reconnects via `connectNative`, spawning a new thin broker that re-attaches to the live workspace service Named Pipe. The extension reads `{clientId, sessionGen, credentialId, keyPair}` from its IndexedDB profile store and completes signed `GET /api/session/status` with **zero Windows Hello or `.state/access.key` prompt**.
   - If T2 is adopted, the long-lived workspace service can also serve as the **single privileged authority** for both Lock and staged OS file saves (Path 3A in Section 6.3).

---

## 4. Shared-Profile Session Protocol, Canonical Request Framing, and Revocation Channel

### 4.1 Elimination of Cookies and URL Secrets

- Remove `bfe_session` cookies completely (`Set-Cookie` must never be emitted; see current `harness/server.mjs` lines 252, 255-258, 272).
- Remove any legacy cookie-only bypass or `/api/desktop-view` loopback ticket endpoint.
- Never place `.state/access.key`, `clientId`, private keys, or session tokens in URL query parameters, fragments, `localStorage`, `sessionStorage`, DOM attributes, or logs.

### 4.2 Per-Profile PoP Key Registration, Mutual Admission, and Canonical Request Target

1. **Key creation and authoritative profile storage:** On unlock, the browser generates an ECDSA P-256 (`SHA-256`) `CryptoKeyPair` via Web Crypto with `extractable: false` and key usages `['sign']` / `['verify']`, plus a fresh 128-bit random `credentialId`. The sole authoritative client-side store is the origin-scoped IndexedDB database `cydeworks-session-v1` (see Section 5.2).
2. **Two-step mutual HMAC admission (`POST /api/session/challenge` -> `POST /api/session/admit`):**
   - The user selects `.state/access.key`. The page reads the 64-hex key into JS memory (rejecting files `> 1024` bytes), requests a short-lived single-use server challenge (`POST /api/session/challenge` returning `{challengeId, challengeHex, arrivalGen}`, bounded in memory with 30s TTL), computes `clientProof = HMAC-SHA256(accessKey, "cydeworks-admit-v1\n" + challengeHex + "\n" + sha256(canonicalPublicKeyJwk))`, sends `{challengeId, publicKeyJwk, clientProof}` to `POST /api/session/admit`, and clears `accessKey` from JS memory after verifying `serverProof` in `finally`.
   - The server verifies `challengeId` (single-use, unexpired), checks `arrivalGen === sessionGen` (else `409 Conflict`), verifies `clientProof` in constant time (`timingSafeEqual`), validates `publicKeyJwk` as P-256, enforces `MAX_ADMITTED_CLIENTS`, mints a random 128-bit `clientId`, registers `{publicKey, sessionGen, admittedAtMono}`, initializes/refreshes `idleClock`, computes `serverProof = HMAC-SHA256(accessKey, "cydeworks-server-v1\n" + challengeHex + "\n" + sessionGen + "\n" + clientId)`, and returns `200 {clientId, sessionGen, idleTimeoutMs, serverProof}`.
   - The browser verifies `serverProof` before committing `{storeSeq, status: 'ACTIVE', sessionGen, clientId, credentialId, keyPair}` to IndexedDB via an atomic compare-and-update transaction (Section 5.2). Thus `.state/access.key` is never sent raw over the wire, and an honest page verifies the server holds `.state/access.key`. (As noted in Section 3.2, this does not rescue initial HTML/JS if an attacker already replaced `GET /` via another browser-trusted `localhost` certificate.)
3. **Single Canonical Request Target and Strict HTTP Framing (`parseCanonicalRequest`):**
   - A single parser `parseCanonicalRequest(req, rawBody)` runs ONCE before PoP verification and produces an immutable `CanonicalRequest {method, canonicalTarget, pathname, searchParams, rawBody, bodySha256Hex, headers}`. **Both the PoP verifier and the HTTP route dispatcher MUST consume ONLY this exact `CanonicalRequest` object** (never re-parsing `req.url`, raw headers, or body downstream).
   - **Strict target rules (reject ambiguous encodings with `400 Bad Request` before PoP/routing):**
     - Require origin-form target starting with `/` (reject absolute-form `https://...`, authority-form, `*`, fragments `#`, ASCII control bytes `0x00-0x1F`/`0x7F`, whitespace, and backslashes `\`).
     - Reject empty path segments (`//`), dot-segments (`.` or `..`, raw or percent-encoded `%2e`/`%2E`), encoded path separators (`%2f`/`%2F`, `%5c`/`%5C`), malformed percent sequences, and non-canonical percent-encoding. Because CydeWorks API paths use ASCII route literals and `[A-Za-z0-9._-]` IDs, reject `%` in `pathname` entirely (or require exact canonical round-trip if any future route needs percent-encoded path values).
     - Validate query string syntax, reject duplicate query parameter keys unless a route explicitly declares multi-value support, and define `canonicalTarget = pathname + (rawQuery ? '?' + rawQuery : '')`.
   - **Strict header uniqueness and authority rules:**
     - Inspect raw header tuples (`req.rawHeaders` on HTTP/1.1 and raw header entries on HTTP/2) and reject with `400` if any security-critical header appears more than once: `X-Workspace-Client`, `X-Workspace-Generation`, `X-Request-Ts`, `X-Request-Nonce`, `X-Client-Sig`, `Host`, `Origin`, `Content-Length`, `Content-Type`, `Transfer-Encoding`.
     - Under HTTP/2, verify `:authority` matches the allowed loopback host+port, and if `Host` is also present verify exact byte equality with `:authority` (else `400`).
   - **Strict method/body consistency:**
     - For `GET` and `HEAD`: reject any non-empty body, non-zero `Content-Length`, or `Transfer-Encoding` header with `400`; `bodySha256Hex` MUST equal `SHA256("")`.
     - For `POST`: require `Content-Type: application/json` (allowing only optional `; charset=utf-8`), reject any request combining both `Content-Length` and `Transfer-Encoding` (`400`), enforce the `48 KB` raw body cap, verify `Content-Length` (if present) equals `rawBody.byteLength`, compute `bodySha256Hex = SHA256(rawBody)`, and pass `rawBody` directly to the route JSON parser.
4. **Authenticated requests (every protected `GET` and `POST`):**
   - Every tab in the same signed-in profile loads `{clientId, sessionGen, credentialId, keyPair}` from the authoritative IndexedDB store (only when `status === 'ACTIVE'`; see Section 5.2 for `LOCK_PENDING`) and attaches:
     - `X-Workspace-Client: <clientId>`
     - `X-Workspace-Generation: <sessionGen>`
     - `X-Request-Ts: <epochMs integer>`
     - `X-Request-Nonce: <128-bit random lowercase hex>`
     - `X-Client-Sig: <base64url(ECDSA-P256-SHA256(canonicalPayload))>`
   - Canonical signing string (`UTF-8`, newline-delimited, unambiguous because `canonicalTarget` rejects whitespace/newlines):
     ```text
     cydeworks-pop-v1
     <METHOD_UPPER>
     <CANONICAL_TARGET>
     <SHA256_HEX_OF_RAW_REQUEST_BODY>
     <clientId>
     <sessionGen>
     <ts_ms>
     <nonce_hex>
     ```
   - Direct address-bar navigation (for example `GET /api/tasks` or `GET /api/tasks/:id/artifact`) lacks PoP headers and fails closed with `401` without modifying or revoking the live session.

### 4.3 Authenticated Revocation Stream, Resume Freshness, and Leader Fallback

1. **Authenticated SSE transport:** `EventSource` is not used because it cannot attach custom PoP headers without leaking credentials into URLs. Streams use `fetch('/api/session/events', {method: 'POST', headers: {Accept: 'text/event-stream', 'Content-Type': 'application/json', ...popHeaders}, body: '{}', signal: abortCtrl.signal})` and read SSE frames from `response.body` (`ReadableStream`). The server emits `event: ready` on connect and `event: ping` (`{serverTimeMs, sessionGen}`) every `15_000 ms`.
2. **Stream freshness after sleep, tab freeze, or stall:**
   - Each active tab records both `lastStreamActivityMono = performance.now()` and `lastStreamActivityWall = Date.now()` on every received `event: ready`, `event: ping`, or leader heartbeat.
   - Because OS sleep/hibernation can pause `performance.now()` on some browser/OS builds, freshness checks **both** clocks: if `performance.now() - lastStreamActivityMono > 45_000` OR `Date.now() - lastStreamActivityWall > 45_000` (missed `> 2` keepalive intervals), OR immediately upon `visibilitychange` (transitioning to `visible` after `>= 15s` hidden), Page Lifecycle `resume`, or `online`:
     1. Synchronously set `revocationStreamHealthy = false` (pausing protected exports/saves immediately until re-verified).
     2. Issue a fresh signed `GET /api/session/status` (or tear down and re-open `POST /api/session/events` waiting for fresh `event: ready`) verifying `sessionGen` matches the authoritative IndexedDB record.
     3. Restore `revocationStreamHealthy = true` ONLY after fresh server confirmation succeeds; if `401` or generation mismatch occurs, conceal immediately and run CAS reconciliation (Section 5.2).
3. **Stream-cap and HTTP/1.1 fallback without silently degrading supported workflows:**
   - Under Option T1 with `node:http2` over TLS 1.3 (`allowHTTP1: true`), up to `MAX_EVENT_STREAMS_PER_CLIENT = 16` tabs per profile multiplex cleanly over one TCP connection.
   - If the transport downgrades to HTTP/1.1 (where browsers enforce a 6-connection-per-origin pool) OR if opening a direct stream returns `429 {code: 'STREAM_CAP'}` (for example when 17+ tabs are open in one profile), tabs **do not silently lose revocation push or silently break saves**. Instead, the profile runs a **Profile Leader Stream Coordinator**:
     - Tabs contend for one per-profile Web Lock (`navigator.locks.request('cydeworks-sse-leader-' + sessionGen, ...)` with a `localStorage` lease fallback if Web Locks are unavailable).
     - The elected leader holds **1** authenticated `POST /api/session/events` stream (consuming 1 HTTP/1.1 slot and 1 server stream slot) and broadcasts `event: ready`, `event: ping`, and `event: session-ended` to follower tabs over `BroadcastChannel('cydeworks-session-lock')` tagged with `{storeSeq, sessionGen, clientId, leaderEpoch, seq}` every `5_000 ms`.
     - Followers treat the relayed stream as healthy (`revocationStreamHealthy = true`) while leader heartbeats remain fresh (`<= 15_000 ms` on both monotonic and wall clocks) and match the authoritative IndexedDB `(storeSeq, sessionGen, clientId)`. If the leader tab closes, freezes, or stalls, `navigator.locks` automatically promotes the next waiting tab to open a fresh SSE stream.
     - Only if **both** direct stream AND leader-relayed stream fail to re-establish within `10_000 ms` does the UI set `revocationStreamHealthy = false` and render an **explicit, visible degraded status banner** ("Live revocation link interrupted; exports paused until reconnected - Retry now"). Supported workflows never degrade silently.

### 4.4 Cross-Profile Behavior (Design Recommendation)

- Browser Profile 2 has a separate IndexedDB, `localStorage`, and `BroadcastChannel`. It cannot read Profile 1's `{clientId, credentialId, keyPair}` and opens concealed at the `.state/access.key` prompt.
- As a design recommendation (not separately selected by the owner; see Section 1.1 and OD-5), if the owner explicitly unlocks Profile 2 using `.state/access.key` while Profile 1 is active, Profile 2 receives its own `clientId_2` registered under the **same** server `sessionGen` so that an explicit Lock (or idle expiry) from either profile rotates `sessionGen` and revokes **all** `clientId` entries together, matching `harness/SESSION-LOCK.md`'s existing `all-workspace-views` scope.

---

## 5. Implementable State Machine

### 5.1 Server Session State Machine (`harness/workspace-service.mjs`)

**Server State Tuple:**
- `state`: `'LOCKED' | 'ACTIVE'`
- `sessionGen`: 256-bit random hex string (freshly generated at startup and on every `ACTIVE -> LOCKED` transition)
- `admittedClients`: `Map<clientId, {publicKey, sessionGen, admittedAtMono, activeStreams: Set<StreamHandle>}>` (capped at `MAX_ADMITTED_CLIENTS = 16`)
- `admissionChallenges`: `Map<challengeId, {challengeHex, arrivalGen, expiresAtMonoNs}>` (capped at `MAX_CHALLENGES = 32`, 30s TTL)
- `seenNonces`: `Map<string, {pruneAfterWallMs: number, pruneAfterMonoNs: bigint}>` for general API requests (capped at `MAX_SEEN_NONCES = 4096`, per-client `MAX_NONCES_PER_CLIENT = 512`)
- `lockSeenNonces`: **Dedicated reserved replay cache** for `POST /api/session/lock` (and `POST /api/session/lock-with-key` challenges) capped at `MAX_LOCK_NONCES = 64` so general API traffic saturation (`429`) can **never** block authenticated Lock!
- `clockState`: `{maxObservedWallMs: number, lastSampleMonoNs: bigint, lastOpMonoNs: bigint, lastOpWallMs: number}` (15-minute idle threshold `IDLE_MS = 900_000`; `MAX_SKEW_MS = 30_000`; `MAX_CUMULATIVE_BACKWARD_MS = 2_000`)
- `activeRun`: existing single-run executor + `terminalControl` lease handle (per `harness/server.mjs` and `harness/SESSION-LOCK.md`)

**Clock-Guard and Idle-Expiry Helper (`sampleClockAndCheckSession()`):**
- Executed on **every** incoming request (including passive reads and `POST /api/session/lock`) and on a `10_000 ms` server timer.
- Samples `nowMonoNs = process.hrtime.bigint()` and `nowWallMs = Date.now()`.
- **Clock-fault fail-closed rules:**
  1. If either clock is non-finite or `nowMonoNs < clockState.lastSampleMonoNs` (monotonic regression) -> atomic `ACTIVE -> LOCKED(reason='clock-fault')`.
  2. If `nowWallMs < clockState.maxObservedWallMs - MAX_CUMULATIVE_BACKWARD_MS` (wall-clock rollback exceeding `2_000 ms` measured strictly against the **monotonic high-water mark** `maxObservedWallMs`, NOT against `lastOpWallMs`) -> atomic `ACTIVE -> LOCKED(reason='clock-fault')`.
  3. Otherwise update `clockState.lastSampleMonoNs = nowMonoNs` and `clockState.maxObservedWallMs = Math.max(clockState.maxObservedWallMs, nowWallMs)`.
- **Idle expiry:** When `state === 'ACTIVE'`, if `(nowMonoNs - clockState.lastOpMonoNs) >= IDLE_MS * 1_000_000n` OR `(nowWallMs - clockState.lastOpWallMs) >= IDLE_MS`, trigger atomic `ACTIVE -> LOCKED(reason='idle')`.
- **Policy on genuine user read-only activity vs. background polling:**
  - **Background polling and automated status checks NEVER extend `idleClock`:** `GET /api/session/status`, `GET /api/tasks`, `GET /api/attention`, `GET /api/tasks/:id`, `POST /api/session/events`, `POST /api/session/check`, `POST /api/cost-presentation`, terminal `heartbeat` and `detach` do **not** advance `lastOpMonoNs`/`lastOpWallMs`.
  - **Explicit operator mutations and actions extend `idleClock`:** Unlock, task creation/scope edit, explicit operator refresh, run approval, review/revise, copy-draft, remove, terminal `take`/`release`/`stop`, and artifact export/download advance `idleClock` after passing Commit Boundary 1.
  - **Genuine user read-only workspace activity extends `idleClock` via dedicated `POST /api/session/touch`:** The browser UI sends a PoP-authenticated `POST /api/session/touch` (debounced client-side and rate-limited server-side to at most once per `60_000 ms` per client) **strictly inside genuine user-interaction event handlers (`event.isTrusted === true`)** such as selecting a task, switching workspace panels, opening a diff/artifact preview, or actively navigating read-only views. *Honest security boundary:* Because malicious same-origin JS (Adversary Class B / XSS, already out of scope per Section 2.3) can invoke any PoP-signed route, `POST /api/session/touch` defends against **unattended honest browser tabs** staying alive via background polling, while preventing active readers from being unexpectedly locked out mid-review.

**Server Transition Table:**

| Current State | Trigger / Event | Guard Conditions | Atomic Actions & Commit Boundary | Next State |
| :--- | :--- | :--- | :--- | :--- |
| `LOCKED` or `ACTIVE` | `POST /api/session/challenge` | Valid canonical request; `Host`/`Origin` valid; `admissionChallenges.size < MAX_CHALLENGES` | Mint `challengeId` + 256-bit `challengeHex` bound to current `arrivalGen = sessionGen` (30s TTL); return `200 {challengeId, challengeHex, arrivalGen}` | Unchanged |
| `LOCKED` or `ACTIVE` | `POST /api/session/admit` | Valid canonical request; body `<= 48 KB`; valid single-use `challengeId`; valid `clientProof` (`timingSafeEqual`); valid P-256 `publicKeyJwk`; `arrivalGen === sessionGen`; if `ACTIVE`: `!expired` and `admittedClients.size < MAX_ADMITTED_CLIENTS` | Consume challenge; mint `clientId`; insert into `admittedClients`; initialize/advance `idleClock`; compute `serverProof`; return `200 {clientId, sessionGen, idleTimeoutMs, serverProof}` | `ACTIVE` |
| `LOCKED` or `ACTIVE` | `POST /api/session/admit` (raced Lock) | Valid `clientProof`, but `arrivalGen !== sessionGen` (Lock or expiry occurred while unlocking) | Consume challenge; do not register `clientId`; return `409 Conflict` | Unchanged |
| `ACTIVE` | `POST /api/session/retire-client` | `!expired`; valid canonical request + PoP; exact `{}` | Remove **only** caller's `clientId` from `admittedClients` and close only its streams without rotating `sessionGen` (used by CAS-loser tabs on concurrent same-profile unlock); if `admittedClients` becomes empty, transition cleanly to `LOCKED`; return `200 {retired: true}` | `ACTIVE` (or `LOCKED` if last client) |
| `ACTIVE` | `POST /api/session/touch` | `!expired`; valid canonical request + PoP; exact `{}`; `>= 60s` since client's last `touch` (else `200 {extended: false}` no-op) | Record nonce; advance `idleClock`; return `200 {extended: true}` | `ACTIVE` |
| `ACTIVE` | Protected `GET` / passive `POST` (`status`, `check`, `tasks`, `artifact`, `models`, `readiness`) | `!expired`; valid canonical request + PoP (`seenNonces` capacity check) | Record nonce; for async probes (`/api/models`, `/api/tasks/:id/readiness`), **recheck** `state === 'ACTIVE' && arrivalGen === sessionGen && !expired` **after** probes settle and before `writeHead`; return `200` (or `401` if revoked during probe) | `ACTIVE` |
| `ACTIVE` | Protected operator `POST` (`/api/tasks`, `/scope`, `/run`, `/cancel`, `/review`, `/revise`, `/remove`, `/copy-draft`, `/terminal`) | Body read complete (`<= 48 KB`); **Commit Boundary 1**: valid canonical request, `!expired`, `arrivalGen === sessionGen`, valid PoP, `admittedClients.has(clientId)` | Record nonce; advance `idleClock`; execute SQLite `BEGIN IMMEDIATE` write (with `task.version` check or idempotency lookup) or run dispatch; return `200`/`201`/`202` | `ACTIVE` |
| `ACTIVE` | `POST /api/session/events` | `!expired`; valid canonical request + PoP; exact `{}`; per-client/global stream caps not exceeded (else `429 {code: 'STREAM_CAP'}` triggering profile leader fallback) | Register stream under `admittedClients.get(clientId).activeStreams`; send `200 text/event-stream` + `event: ready {sessionGen, serverTimeMs}`; emit `event: ping` every 15s | `ACTIVE` |
| `ACTIVE` | `POST /api/session/lock` | Valid canonical request; exact `{}`; `!expired`; valid PoP checked against **dedicated `lockSeenNonces` lane** (bypasses general `seenNonces` saturation); `arrivalGen === sessionGen` | **Atomic single-turn `L_lock`:** capture `lockedGeneration = sessionGen`, `revokedClientCount = admittedClients.size`; rotate `sessionGen = randomBytes(32).hex`; clear `admittedClients`, `seenNonces`, `lockSeenNonces`, `idleClock`; reset `clockState.maxObservedWallMs = Date.now()`; call `activeRun?.control.revoke()` (`stopsWork: false`); push `event: session-ended {reason: 'locked', lockedGeneration}` to all streams and end/destroy them; return `200 {locked: true, lockedGeneration, revokedClientCount, scope: 'all-workspace-views', terminalControlReleased: true, stopsWork: false, requiresAccessFile: true}` | `LOCKED` |
| `ACTIVE` | `POST /api/session/lock` (auth rejected while `ACTIVE`) | Server is `ACTIVE`, but PoP fails (wrong `sessionGen`, unknown `clientId`, bad signature, skew, or replay) | **Zero state mutation.** Return `401 {code: 'AUTH_FAILED', locked: false}` (never reporting `already-locked` while a session is `ACTIVE`!) | `ACTIVE` |
| `LOCKED` or `ACTIVE` | `POST /api/session/lock-with-key` | Valid canonical request; valid single-use `challengeId`; valid `HMAC-SHA256(accessKey, "cydeworks-lock-v1\n" + challengeHex)` (`timingSafeEqual`); uses dedicated Lock lane | Zero-reveal recovery Lock: if `ACTIVE`, execute full atomic `L_lock` immediately; if already `LOCKED`, confirm locked without unlocking or revealing workspace data; return `200 {locked: true, alreadyLocked: <bool>, lockedGeneration}` | `LOCKED` |
| `ACTIVE` | Idle timer (`>= 15 min`) or clock fault | `sampleClockAndCheckSession()` triggers expiry or fault | Same atomic single-turn `L_lock` with `reason: 'idle'` or `'clock-fault'`; push `session-ended` and close all streams | `LOCKED` |
| `LOCKED` | `POST /api/session/lock` | Valid canonical request | Zero state mutation; return `401 {code: 'LOCKED', locked: true}` (confirms server is currently `LOCKED` without leaking workspace data or `sessionGen`) | `LOCKED` |
| `LOCKED` | Any other protected route | Any | Return `401 {code: 'LOCKED'}`; zero state mutation; never rotate/renew session | `LOCKED` |
| Any | Service restart / process exit | Startup of new process | `acquireWorkspaceLock` ensures single writer; new process starts `LOCKED` with fresh `sessionGen`, empty `admittedClients`/`seenNonces`; persisted `'running'` tasks marked interrupted via `recordInterruption` (`harness/server.mjs` lines 557-560) | `LOCKED` |

### 5.2 Browser Tab and Authoritative Profile Store State Machine (Legacy `harness/web/` and Experience `harness/web-experience/`)

**Single Authoritative Profile Store (IndexedDB `cydeworks-session-v1`):**
- Two object stores accessed together inside single atomic IndexedDB `readwrite` transactions (serialized by IndexedDB across all tabs in the same browser profile):
  1. `profile_session` (singleton key `'current'`):
     `{id: 'current', storeSeq: number, status: 'ACTIVE' | 'LOCK_PENDING', sessionGen: string, clientId: string, credentialId: string, keyPair: CryptoKeyPair, lockErrorCode?: string}`
  2. `profile_meta` (singleton key `'meta'`):
     `{id: 'meta', storeSeq: number, revokedGenerations: string[] /* bounded LRU 64 */}`
- **`localStorage` and `BroadcastChannel` are strictly advisory hints:**
  - `localStorage['bfe-session-hint']` stores non-secret JSON `{storeSeq, status, sessionGen, clientId}` and `BroadcastChannel('cydeworks-session-lock')` carries `{type, storeSeq, sessionGen, clientId, credentialId}`.
  - **Hard invariant:** No tab may EVER write or delete IndexedDB based solely on a `localStorage` value or `BroadcastChannel` message. Any hint with `hint.storeSeq < tab.storeSeq` is ignored as stale. Any hint with `hint.storeSeq > tab.storeSeq` (or status `'LOCK_PENDING'`/`'REVOKED'` matching the tab's active credential) immediately triggers fail-closed local UI concealment, followed by reading the authoritative IndexedDB `'current'` record inside a transaction.

**Atomic Compare-and-Update / Compare-and-Delete Rules:**
- **Rule CAS-ADMIT (commit new unlock):** Given `baseStoreSeq` read before `POST /api/session/admit` and verified `{clientId, sessionGen, credentialId, keyPair}`:
  - Inside one `readwrite` transaction on `['profile_session', 'profile_meta']`: succeed ONLY if `meta.storeSeq === baseStoreSeq` AND `!meta.revokedGenerations.includes(sessionGen)`.
  - On success: `meta.storeSeq = baseStoreSeq + 1`, write `current = {id: 'current', storeSeq: meta.storeSeq, status: 'ACTIVE', sessionGen, clientId, credentialId, keyPair}`, commit, then emit advisory `localStorage` + `BroadcastChannel` hint.
  - On CAS mismatch (another tab unlocked concurrently under the same or newer `sessionGen`, OR a Lock occurred while this unlock was in flight): **do NOT overwrite `'current'`**; discard the local `keyPair`; best-effort invoke `POST /api/session/retire-client` (signed with the discarded `keyPair` to free its own `clientId` slot without affecting the winning session); re-read `'current'` to either join the winning `ACTIVE` credential or remain `CONCEALED`.
- **Rule CAS-LOCK-PENDING (start explicit Lock before network transmission):** Given tab's `(storeSeq, sessionGen, clientId, credentialId)`:
  - Inside one `readwrite` transaction: succeed ONLY if `current !== null && current.storeSeq === target.storeSeq && current.sessionGen === target.sessionGen && current.clientId === target.clientId && current.credentialId === target.credentialId`.
  - On success: increment `meta.storeSeq`, add `target.sessionGen` to `meta.revokedGenerations`, update `current.status = 'LOCK_PENDING'` and `current.storeSeq = meta.storeSeq` (**retaining `keyPair` strictly for Lock retries!**), commit, and broadcast advisory `{type: 'lock-pending', storeSeq: meta.storeSeq, sessionGen, clientId, credentialId}`.
  - On mismatch (a newer session already replaced `'current'`): abort stale Lock mutation without touching the newer record.
- **Rule CAS-DELETE (cleanup after confirmed revocation or credential-scoped `401`):** Given target `(sessionGen, clientId, credentialId)`:
  - Inside one `readwrite` transaction: delete `'current'` ONLY if `current !== null && current.sessionGen === target.sessionGen && current.clientId === target.clientId && current.credentialId === target.credentialId`. (Record `target.sessionGen` in `meta.revokedGenerations` only when server confirmed revocation or `LOCKED`, never on a generic unconfirmed `401`!)
  - Because deletion checks all three fields `(sessionGen, clientId, credentialId)`, a stale `401`, delayed admission, or stale Lock callback from an older credential (even one that shared the same `sessionGen` during a concurrent unlock) can **never** delete or overwrite a newer active credential.

**Per-Tab State Tuple:**
- `phase`: `'BOOTING' | 'CONCEALED' | 'UNLOCKING' | 'ACTIVE' | 'LOCKING' | 'LOCK_RECOVERY'`
- `docEpoch`: strictly increasing local integer (incremented synchronously on every concealment, Lock, or `pagehide`)
- `boundCred`: `{storeSeq, sessionGen, clientId, credentialId}` (null when not `ACTIVE`)
- `abortCtrl`: `AbortController` aborted synchronously on every `ACTIVE -> LOCKING|CONCEALED` transition
- `revocationStreamHealthy`, `lastStreamActivityMono`, `lastStreamActivityWall`, `pagehideFired`

**Browser Tab Transitions:**

1. **Admission (`CONCEALED -> UNLOCKING -> ACTIVE`):**
   - Tab reads `baseStoreSeq` from `profile_meta`, generates non-extractable `keyPair` + `credentialId`, executes two-step mutual HMAC admission (`challenge` -> `admit`), verifies `serverProof`, clears `.state/access.key` in `finally`, and commits via **Rule CAS-ADMIT**.
   - On `409`, `401`, invalid `serverProof`, or network failure: discard `keyPair`, stay `CONCEALED`, display specific non-retrying message.
2. **Ordinary Refresh (`F5`), Browser Relaunch, and Second Tab (`BOOTING -> ACTIVE`, `CONCEALED`, or `LOCK_RECOVERY`):**
   - Read authoritative `'current'` directly from IndexedDB (never deleting it on `localStorage` hints alone).
   - If `'current'` is absent -> transition to `CONCEALED` (prompt for `.state/access.key`).
   - If `current.status === 'LOCK_PENDING'` -> **stay strictly `CONCEALED` in `LOCK_RECOVERY`**, NEVER reveal workspace data, NEVER call workspace APIs, and display the pending-Lock confirmation/recovery UI (allowing immediate retry of `POST /api/session/lock` or `POST /api/session/lock-with-key`).
   - If `current.status === 'ACTIVE'` -> sign and send `GET /api/session/status` bound to `target = {storeSeq, sessionGen, clientId, credentialId}`:
     - `200 {authorized: true, sessionGen}` matching `target.sessionGen` (and authoritative `'current'` still matches `target` after await): transition directly to `ACTIVE` with **zero Windows Hello or access-file prompt**, start/join the SSE revocation stream, and restore non-sensitive route state.
     - `401 {code: 'LOCKED'}`: server confirmed workspace is locked -> run **Rule CAS-DELETE** for `target` (adding `sessionGen` to `revokedGenerations`), stay `CONCEALED`.
     - `401 {code: 'AUTH_FAILED'}` (generic auth failure, could be clock skew or superseded session): stay `CONCEALED`, do NOT reveal data; run **Rule CAS-DELETE** for `target` only after verifying `'current'` still matches `target` (never touching a newer credential), and inform user that re-unlock is required.
     - Network error / unreachable: stay `CONCEALED` ("Workspace unavailable"), preserving `'current'` untouched.
3. **Explicit Lock (`ACTIVE -> LOCKING -> CONCEALED | LOCK_RECOVERY`):**
   - **Synchronously before any `await` or network call:**
     1. Increment `docEpoch`, abort `abortCtrl`, set `phase = 'LOCKING'`.
     2. Wipe all in-memory UI state and module caches (`state.task`, `state.tasks`, `state.routes`, `state.cache`, `state.compose`, `state.lease`, `state.approval`, export/receipt buffers, and `usage.js` `presented` Map; preserving only non-sensitive pending submission correlation IDs).
     3. Close all open dialogs, conceal workspace DOM, render Lock screen ("Concealed locally; waiting for server revocation confirmation...").
     4. Emit immediate advisory hint (`localStorage['bfe-session-hint']` + `BroadcastChannel` `{type: 'lock-initiated', storeSeq, sessionGen, clientId, credentialId}`) so sibling tabs conceal immediately.
   - **Step A (Atomic `ACTIVE -> LOCK_PENDING` before transmission):** Execute **Rule CAS-LOCK-PENDING** on IndexedDB. Do **NOT** delete the IndexedDB key yet! If the tab refreshes, crashes, or loses power during transmission, `BOOTING` will find `status: 'LOCK_PENDING'`, remain concealed, and preserve the recovery path.
   - **Step B (Authenticated Lock transmission):** Sign a fresh `POST /api/session/lock` (exact body `{}`, fresh `ts_ms`, fresh `nonce`, routed to server's dedicated `lockSeenNonces` lane) and transmit.
   - **Step C (Explicit outcome distinction, updating UI only if `docEpoch` is still current):**
     - **`200 {locked: true, lockedGeneration}` (matching `target.sessionGen`) -> `CONFIRMED_REVOKED`:** Run **Rule CAS-DELETE** on `'current'`, emit advisory `{type: 'lock-confirmed', storeSeq, sessionGen}`, transition to `CONCEALED` with `CONFIRMED_REVOKED` banner (stating exact server guarantees vs. unknown remote-tab state per Section 6.5).
     - **`401 {code: 'LOCKED'}` -> `CONFIRMED_REVOKED (already locked)`:** Server confirmed state is `LOCKED`; run **Rule CAS-DELETE** on `'current'`, transition to `CONCEALED`.
     - **`401 {code: 'AUTH_FAILED'}` -> `AUTH_REJECTED (server revocation NOT confirmed)`:** Do **NOT** report `already-locked`! Keep `'current'` in `LOCK_PENDING` (or mark `lockErrorCode = 'AUTH_FAILED'`), transition to `LOCK_RECOVERY` (strictly concealed), explain that the Lock request was rejected (possible clock skew, stale/replayed request, or already-superseded session) and the server session **may still be active**, and present two safe zero-reveal actions: (1) **Retry Lock** (fresh `ts` + `nonce`), or (2) **Confirm Lock with `.state/access.key`** (`POST /api/session/lock-with-key`, which revokes any active session without revealing data, then CAS-deletes `'current'`).
     - **Network error / timeout / interrupted transmission / `429` / `5xx` / unreadable body -> `UNKNOWN_OUTCOME`:** Keep `'current'` in `LOCK_PENDING`, transition to `LOCK_RECOVERY` (strictly concealed), warn clearly that server revocation is unconfirmed and the shared session may still be active, and offer **Retry Lock** (re-signing with fresh `ts` + `nonce` using the `LOCK_PENDING` key) or **Confirm Lock with `.state/access.key`**. Never auto-reveal workspace data and never silently discard the key while server revocation is unconfirmed (offer explicit "Discard local pending key anyway" only behind a clear warning).
4. **Foreign Lock, SSE `session-ended`, Hint Wakeup, or Credential-Scoped `401` (`ACTIVE -> CONCEALED`):**
   - Any advisory hint (`localStorage`/`BroadcastChannel`) with `hint.storeSeq >= boundCred.storeSeq` signaling Lock/revocation, any SSE `event: session-ended`, or any API `401` originating from `boundCred` immediately executes synchronous concealment (`docEpoch++`, `abortCtrl.abort()`, wipe all caches including `usage.js` `presented` Map, close dialogs, conceal DOM).
   - **Stale notification / stale `401` immunity:** Every async API response handler captures `reqCred = boundCred` at dispatch. If a `401` arrives for an older `reqCred` after the user has already re-unlocked a newer `boundCred` (`boundCred.storeSeq !== reqCred.storeSeq || boundCred.credentialId !== reqCred.credentialId`), the stale `401` is **dropped silently** and never conceals the newer session or touches IndexedDB!
   - When `reqCred` matches current `boundCred`, run **Rule CAS-DELETE** scoped strictly to `reqCred` (only if server confirmed `LOCKED` or `session-ended`, or reconcile against `'current'` in IndexedDB if `LOCK_PENDING`).
5. **`pagehide` / `bfcache` Handling:**
   - On `pagehide`, set `pagehideFired = true`, increment `docEpoch`, abort `abortCtrl`, wipe sensitive DOM/state, and close/detach the revocation stream.
   - Responses serve `Cache-Control: no-store`. If restored via `pageshow` (`event.persisted === true`), force `phase = 'BOOTING'` and re-verify against authoritative IndexedDB + `GET /api/session/status` before revealing any DOM.
6. **Interrupted Requests:**
   - Any fetch rejection without HTTP status, abort, or malformed JSON is treated as `unknownOutcome`. Pending run submissions and draft copies retain only correlation IDs (`requestId`, `taskId`) for explicit lookup/reconciliation; Lock never treats `401` or dropped sockets as proof that a prior run did not start.

### 5.3 Electron Desktop Mode State Machine (Zero-TCP Parallel Path)

Electron Desktop mode (`harness/desktop/main.cjs`) preserves `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, `nodeIntegration: false`, and `webviewTag: false`, eliminates all loopback TCP listeners and cookies, and enforces strict document binding and correlated utility-process Lock confirmation:

1. **Startup and preserved security denials:**
   - Main spawns `workspace-service.mjs` via `utilityProcess.fork` (`BFE_DESKTOP_IPC=1`), exchanges a per-launch `launchNonce`, maintains `ownerLease` heartbeats, and serves UI assets via `protocol.handle('cydeworks', ...)` from the verified in-memory asset map at exact URL `cydeworks://app/index.html`.
   - Main explicitly enforces and preserves all browser/navigation/permission denials:
     - `webContents.setWindowOpenHandler(() => ({action: 'deny'}))`
     - `webContents.on('will-attach-webview', (e) => e.preventDefault())`
     - `session.setPermissionRequestHandler((_, __, cb) => cb(false))` and `session.setPermissionCheckHandler(() => false)`
     - `will-navigate` and `will-redirect` deny any URL other than `cydeworks://app/index.html`.
2. **Strict Document-Bound IPC and Pre-Reply Revalidation:**
   - Whenever Main loads `cydeworks://app/index.html`, Main mints an `authorizedDocument` record: `{docEpoch, docToken, webContentsId, frameProcessId, frameRoutingId, exactUrl: 'cydeworks://app/index.html'}` and delivers `{docEpoch, docToken}` only to that authorized main frame via preload.
   - **IPC ingress validation (every `ipcMain.handle` call):** Main rejects unless ALL of the following match `authorizedDocument`:
     1. `event.sender.id === authorizedDocument.webContentsId`
     2. `event.senderFrame` is non-null and `event.senderFrame.top === event.senderFrame` (main frame only, never a subframe)
     3. `event.senderFrame.processId === authorizedDocument.frameProcessId && event.senderFrame.routingId === authorizedDocument.frameRoutingId`
     4. `event.senderFrame.url === 'cydeworks://app/index.html'` (exact URL match)
     5. `payload.docEpoch === authorizedDocument.docEpoch && payload.docToken === authorizedDocument.docToken` and `mainLockState === 'ACTIVE'` (except unlock/lock control channels).
   - **Navigation lifecycle invalidation:** On `will-navigate`, `did-start-navigation` (covering programmatic navigation), `did-navigate`, `did-frame-navigate`, `render-process-gone`, and `closed`, Main synchronously increments `authorizedDocument.docEpoch`, rotates/clears `docToken`, and sends `bfe-rpc-cancel` to the utility process for all in-flight RPCs.
   - **Pre-reply revalidation (IPC egress):** After awaiting any async utility-process RPC and **immediately before resolving the `ipcMain.handle` promise back to the renderer**, Main re-checks that `authorizedDocument` (same `docEpoch`, `docToken`, `frameProcessId`, `frameRoutingId`, `exactUrl`), `!window.isDestroyed()`, and `mainLockState === 'ACTIVE'` still hold. If anything changed while the RPC was in flight (Lock, navigation, reload, crash), Main drops the payload and returns `{aborted: true, reason: 'document_or_session_changed'}`.
3. **Correlated Utility-Process Lock Acknowledgement (Main Never Attests Without Proof):**
   - Advancing `authorizedDocument.docEpoch` in Main blocks renderer IPC, **but does NOT prove the `utilityProcess` executed `L_lock`**.
   - On Desktop Lock:
     1. Main synchronously advances `authorizedDocument.docEpoch`, sets `mainLockState = 'LOCKING'`, rejects new IPC calls, conceals the renderer UI ("Waiting for workspace service lock confirmation"), and blocks new saves / cancels `DIALOG` and `STAGING_WRITE` saves.
     2. Main sends a correlated `{type: 'bfe-rpc-lock', lockRequestId, expectedSessionGen}` message over `utilityProcess.parentPort` and waits (bounded timeout, for example 5 seconds) for a correlated `{type: 'bfe-rpc-lock-ack', lockRequestId, locked: true, lockedGeneration, terminalControlReleased}` reply from the utility process, while also serializing against any already-dispatched `COMMITTING_RENAME` (Section 6.2).
     3. **Explicit Lock outcome mapping:**
        - **`LOCKED_CONFIRMED`:** Correlated `bfe-rpc-lock-ack` received (`locked: true` matching `lockRequestId` and `expectedSessionGen`) AND no `COMMITTING_RENAME` timed out.
        - **`LOCKED_SERVICE_EXITED`:** Utility process exited/crashed (`exit` event) before `lock-ack` arrived. In-memory utility session ended with the process, but Main explicitly discloses that any in-flight mutation or pending rename outcome is unknown and requires inspection on restart.
        - **`LOCK_UNCONFIRMED`:** Bounded timeout expired (or port error occurred) while the utility process is still alive without sending a correlated `lock-ack`. Main **never** reports confirmed revocation; Main keeps the renderer strictly concealed and blocked, and offers explicit fail-closed recovery ("Retry service lock" or "Force-terminate workspace service and inspect disk/task state").

---

## 6. Linearization Boundaries, Save/Lock Reconciliation, and Lock Races

### 6.1 Server-Side Commit or Rejection Boundary

Because Node.js executes JavaScript handlers on a single event loop and SQLite writes use `BEGIN IMMEDIATE`, the server has a clean, deterministic linearization point for every operation after `parseCanonicalRequest(req, rawBody)` and `sampleClockAndCheckSession()`:

- **Lock Linearization Point (`L_lock`):** The synchronous JS turn inside `POST /api/session/lock`, `POST /api/session/lock-with-key`, or `sampleClockAndCheckSession()` (`idle` / `clock-fault`) that rotates `sessionGen`, empties `admittedClients`, `seenNonces`, and `lockSeenNonces`, and calls `activeRun?.control.revoke()`.
- **Admission Linearization Point (`L_admit`):** The synchronous turn after challenge and `clientProof` verification that checks `arrivalGen === sessionGen` before inserting into `admittedClients`. If `L_lock` occurred while the unlock was in flight, `L_admit` fails closed with `409 Conflict`.
- **Protected Read / Export Release Linearization Point (`L_read`):** For synchronous SQLite reads and artifact stream release, PoP verification precedes byte release in the same turn. For asynchronous probes (`/api/models`, `/api/tasks/:id/readiness`), the server performs a mandatory **second** `state === 'ACTIVE' && arrivalGen === sessionGen && !expired` check *after* all async probes resolve and *before* calling `res.writeHead(200)` (extending `harness/server.mjs` line 305).
- **Protected Mutation Linearization Point (`L_write`):** After raw body reading and `parseCanonicalRequest` finish, the server runs **Commit Boundary 1** (verifying `state === 'ACTIVE'`, `arrivalGen === sessionGen`, `!expired`, `admittedClients.has(clientId)`, unused `nonce` under the dual-condition replay rule, valid ECDSA signature) synchronously before entering `db.exec('BEGIN IMMEDIATE')` / `save()` or launching `execute(task, run)`. A body still arriving when `L_lock` fires can never commit a mutation.

### 6.2 Client-Side Reveal Fence, Browser Handoff Fence, and Serialized Brokered Save Protocol

1. **Commit Boundary 2 (Browser DOM Reveal Fence):** Every async continuation in both `harness/web/` and `harness/web-experience/` (including `getTask`, `listTasks`, `readiness`, `loadSourceFile`, `openHandoffReview` `arrayBuffer()`/`text()`, `usage.js` `costPresentation`, and export/receipt dialogs) must call `assertViewCurrentSync(captured)` immediately before mutating UI state, opening a dialog, announcing screen-reader text, or calling `render()`. `assertViewCurrentSync(captured)` verifies:
   - `phase === 'ACTIVE'`
   - `docEpoch === captured.docEpoch`
   - `boundCred !== null` matching all of `(storeSeq, sessionGen, clientId, credentialId)` captured at request dispatch
   - `!abortCtrl.signal.aborted && !pagehideFired`
   - Advisory fast-path hint check: if `localStorage['bfe-session-hint']` has `hint.storeSeq > captured.storeSeq` (or `hint.status === 'LOCK_PENDING'` for `captured.credentialId`), abort reveal immediately and reconcile against the authoritative IndexedDB `'current'` record. (A hint with `hint.storeSeq < captured.storeSeq` is stale and ignored.)
   - *Scope of this check:* Prevents reveals **once the tab has observed Lock or revocation**. Does not guarantee global cross-process ordering before the tab observes revocation (Section 6.4).
2. **Commit Boundary 3 (Browser Download Handoff Fence - Stage B Only):** Before invoking `URL.createObjectURL` + `a.click()` in plain standalone browser mode:
   1. Run `assertViewCurrentSync(captured)` after `response.arrayBuffer()` and `sha256Hex()` complete.
   2. Require `revocationStreamHealthy === true` (including post-resume freshness verification in Section 4.3).
   3. Execute a signed `POST /api/session/check` to verify the server session is still `ACTIVE` at `captured.sessionGen`.
   4. Re-run `assertViewCurrentSync(captured)` immediately before `a.click()`.
   - *Honest limit:* This fence aborts browser handoff when the tab observes Lock or `POST /api/session/check` fails, **but does NOT close the race between check/interaction and `a.click()` / OS disk commit** (Section 6.3).
3. **Serialized Staged Save Protocol with Persistent Destination-Conflict Tracking (Electron Main, and Optional Path 3A Browser Save Broker):**
   As noted in Node's `fs` documentation, passing an `AbortSignal` to `fs.writeFile` is best-effort cancellation and does **not** prove nothing was written to disk. Likewise, checking Lock state immediately before an asynchronous `fs.rename` does **not** prove commit ordering because the libuv threadpool / OS kernel can execute the rename after Lock has already been acknowledged. The privileged save broker (Electron Main, or the workspace service under Path 3A) therefore serializes saves against Lock acknowledgement **and** tracks unresolved destinations across re-unlock and restart:
   - **Canonical destination key (`destKey`):** Normalize `finalPath` via `path.resolve`, `fs.realpath` of the parent directory (resolving symlinks/junctions), and Windows case-folding (`.toLowerCase()` on case-insensitive NTFS volumes).
   - **Destination-conflict gate (checked BEFORE `DIALOG` / `STAGING_WRITE`):** If `unresolvedDestinations.has(destKey)` (whether in-flight from an earlier timed-out rename, late-settled without acknowledgement, or loaded from a prior run's crash journal), the broker **MUST reject any new save targeting `destKey`** with an explicit destination-conflict error ("An earlier save to this destination has not settled or reconciled; writing here risks silent clobber. Choose another path or resolve the prior save first."). Saves to distinct canonical paths remain permitted.
   - **States per save:** `DIALOG` -> `STAGING_WRITE` -> `COMMITTING_RENAME` -> `COMMITTED | CANCELLED | UNRESOLVED` (with background transitions `UNRESOLVED -> LATE_COMMITTED | LATE_FAILED`).
   - **Pre-commit phases (`DIALOG` and `STAGING_WRITE`):** User chooses `finalPath` (tagged with `capturedEpoch`). Broker verifies `epoch === capturedEpoch && mainLockState === 'ACTIVE' && !unresolvedDestinations.has(destKey)`, writes bytes in bounded chunks to a same-directory temp file (`.cydeworks-tmp-<random>.part`), rechecks `epoch` and `mainLockState` between chunks, computes `expectedSha256`, and calls `fileHandle.sync()`. If Lock arrives during `DIALOG` or `STAGING_WRITE`, broker immediately cancels the save before `COMMITTING_RENAME`, closes the handle, and best-effort unlinks `tmpPath` without ever calling `fs.rename`.
   - **Write-ahead journal + entering `COMMITTING_RENAME`:** Only if `epoch === capturedEpoch && mainLockState === 'ACTIVE' && !unresolvedDestinations.has(destKey)` holds in the same synchronous turn does the broker durably persist a write-ahead record `{saveId, destKey, finalPath, tmpPath, expectedSha256, state: 'COMMITTING_RENAME', createdAt}` to `.state/pending-saves.json` (atomic temp+fsync+rename) or SQLite `pending_saves`, transition `save.state = 'COMMITTING_RENAME'`, register the settlement promise in `committingRenames`, and dispatch `fs.rename(tmpPath, finalPath)`.
   - **Serializing Lock acknowledgement with an in-flight `COMMITTING_RENAME`:**
     - If Lock arrives while `committingRenames.size > 0`, the broker **immediately** begins session revocation (`epoch++`, correlated utility-process `bfe-rpc-lock`, renderer concealment, blocking new saves and blocking any `DIALOG`/`STAGING_WRITE` save from entering `COMMITTING_RENAME`).
     - The broker then **holds final Lock completion acknowledgement** until every already-dispatched `COMMITTING_RENAME` settles or a bounded wait timeout (for example, 5 seconds) expires.
     - **Settled with success before Lock acknowledgement:** Clear the journal entry and report **`saveOutcome: 'committed-before-lock-ack'`** ("An already-dispatched file save finished before Lock acknowledgement was issued; Lock did not delete it."). Never mislabel this as "committed before Lock was clicked."
     - **Settled with error before Lock acknowledgement:** Best-effort unlink `tmpPath`, update/clear journal, and report exact error status (including if disk state or `.part` cleanup is uncertain).
     - **Bounded wait expires before settlement (`UNRESOLVED`):** Keep the journal entry marked `UNRESOLVED`, insert `{saveId, destKey, finalPath, tmpPath, expectedSha256, state: 'UNRESOLVED_IN_FLIGHT', settlePromise}` into **`unresolvedDestinations`**, keep the background settlement listener attached, and return **`saveOutcome: 'unresolved'`** alongside the utility-process Lock status (`LOCKED_CONFIRMED` / `LOCKED_SERVICE_EXITED` / `LOCK_UNCONFIRMED`).
   - **Late settlement and restart recovery (preventing silent clobber after re-unlock or restart):**
     - **Late settlement while process stays alive:** Because `destKey` remains locked in `unresolvedDestinations` across Lock and re-unlock, no later save can race the hanging rename. When the hanging `fs.rename` eventually settles:
       - On late success -> update journal and `unresolvedDestinations` to `LATE_COMMITTED`, emit explicit user notice that the prior save completed late at `finalPath`, and clear `destKey` only after explicit user acknowledgement (or inspection).
       - On late failure -> best-effort unlink `tmpPath`, update state to `LATE_FAILED`, emit explicit notice, and allow user-confirmed clearing of `destKey`.
     - **App crash, power loss, or restart with unresolved disk state:** On startup, the broker loads every surviving `COMMITTING_RENAME` or `UNRESOLVED` journal entry into `unresolvedDestinations` as **`UNRESOLVED_FROM_PRIOR_RUN`**, performs a **non-destructive** inspection of `tmpPath` and `finalPath` (existence, byte size, optional SHA-256 comparison against `expectedSha256`), **never silently deletes or overwrites `finalPath`**, continues blocking new saves to `destKey`, and requires an explicit user recovery action ("Mark destination reconciled", "Delete uncommitted `.part` residue", or "Save elsewhere") before clearing `destKey` and removing the journal entry.

### 6.3 Browser Save Stages, Honest Limits, and Reconciliation with Strict Save/Lock Requirement

To avoid any ambiguity or hidden weakening of `docs/T3-BROWSER-LOCK-REQUIREMENTS-2026-11-19.md` ("demonstrate that an older generation cannot publish a protected result or complete an unauthorized save after the applicable Lock boundary"), every file save is split into **three distinct stages**:

1. **Stage A (Bytes queued / released by workspace service):** Controlled atomically by server `L_lock`. After `L_lock` runs, zero new bytes are queued or transmitted for the revoked generation.
2. **Stage B (Browser handoff: `URL.createObjectURL` + `a.click()` or File System Access handoff):** Occurs inside the browser renderer after bytes already arrived from the server. **Crucial honesty rule: even a fresh user interaction or re-authentication immediately prior to `a.click()` does NOT close the race against a concurrent Lock**, because another tab or profile can execute `L_lock` between server verification/user click and `a.click()` execution.
3. **Stage C (Completed OS disk save):** In standard browser downloads (`a.click()`), the browser's download manager writes to the OS filesystem asynchronously outside page JavaScript control; page JavaScript cannot observe, abort, or serialize OS filesystem commit against `L_lock`.

**Explicit Reconciliation with `docs/T3-BROWSER-LOCK-REQUIREMENTS-2026-11-19.md` (No Silent Weakening, Full Browser Support Preserved):**
- **What is impossible in plain standalone browser mode (T1 + `a.click()`):** Without a single privileged local authority owning **both** Lock and the OS filesystem commit, a plain browser tab **cannot** strictly guarantee that Stage C (a browser-managed disk save) does not complete after `L_lock`.
- **Two explicit resolution paths (requires explicit owner decision; never silently relaxed):**
  - **Path 3A (Strict Stage C Save/Lock Ordering in Standalone Browser - Approval-Gated Option):** Preserve strict completed-disk-save ordering in full browser mode by routing workspace file exports/saves through **one privileged local authority** that executes both `L_lock` and the Section 6.2 staged-save / `COMMITTING_RENAME` / `unresolvedDestinations` protocol:
    - Under **Option T2 (Signed Extension + Native Messaging):** The long-lived workspace service (reached over the authenticated Named Pipe) performs both `L_lock` and OS-brokered staged file saves (avoiding `a.click()` entirely).
    - Under **Option T1 + Approval-Gated Local Brokered Export:** Instead of browser `a.click()`, the authenticated browser UI invokes a server-mediated export route (`POST /api/tasks/:id/export-to-path` or OS-native save picker invoked by a local companion broker) serialized directly against `L_lock` on the workspace service's single event loop.
    - *Approval status:* Adding native file-picker / local filesystem export authority or a browser extension is an **approval-gated option** requiring specific owner approval before Stage 2 execution.
  - **Path 3B (Explicit Owner Scoping of Standalone Browser Boundary to Stage A):** If the owner chooses plain T1 browser downloads (`a.click()`) without a local file-save broker, the owner must **explicitly ratify** that for standalone browser mode, the "applicable Lock boundary" in `docs/T3-BROWSER-LOCK-REQUIREMENTS-2026-11-19.md` is **Stage A (server byte release `L_lock`)**, classifying any bytes released by the server before `L_lock` as "already delivered" before the Lock boundary (while Electron Desktop mode continues to enforce strict Stage C disk-commit ordering via Electron Main).

**Guarantee Matrix (Server Revocation vs. Tab Observation vs. Privileged Broker):**

| Category | Boundary / Stage | Actual Guarantee (and Honest Limit) |
| :--- | :--- | :--- |
| **SQLite mutations committed before `L_lock`** | Stage A (already committed on server) | Committed permanently; Lock does not roll back prior edits, reviews, or removals. |
| **Approved runs dispatched before `L_lock`** | Stage A (already started on server) | Continue running (`stopsWork: false`, per `harness/SESSION-LOCK.md`); terminal control lease is revoked. |
| **Server requests mid-body, mid-probe, or not yet releasing bytes at `L_lock`** | Pending on server (pre-Stage A) | **Deterministic server guarantee:** Rejected with `401` (or `409` for raced unlock) at Commit Boundary 1 / `L_read`; zero DB mutation and zero byte release after `L_lock`. |
| **HTTP bytes already written to socket before `L_lock`** | Post-Stage A (already delivered) | Cannot be pulled back off the wire; already-rendered DOM pixels, OS clipboard contents, and browser/GPU buffers cannot be provably erased by JavaScript. |
| **Browser fetch continuations in locking tab or in sibling tab that has observed Lock** | Pending in tab (Lock observed) | Dropped silently at Commit Boundary 2 (`assertViewCurrentSync`); zero DOM reveal, zero dialog open, zero module-cache write. |
| **Browser fetch continuations in sibling tab that has NOT yet observed Lock** | Pending in tab (Lock unobserved) | **Not guaranteed suppressed:** Already-delivered bytes can still render until the tab observes `localStorage`, `BroadcastChannel`, SSE `session-ended`/EOF, or `401`. |
| **Plain browser downloads (`a.click()`) when tab has observed Lock or `POST /api/session/check` fails** | Stage B (Lock observed) | Aborted before `a.click()` at Commit Boundary 3. |
| **Plain browser downloads (`a.click()`) after Stage A bytes arrived and `POST /api/session/check` returned `200`, before tab observes Lock** | Stage B / Stage C (Lock unobserved) | **Not guaranteed aborted (unbounded race window):** Can still invoke `a.click()` and finish writing to disk after `L_lock`. Neither fresh user interaction nor re-authentication closes this race. Strict Stage C ordering requires **Path 3A** (single privileged authority). |
| **Electron Main (or Path 3A broker) saves in `DIALOG` or `STAGING_WRITE` when Lock arrives** | Pre-commit in privileged broker | Cancelled before `COMMITTING_RENAME`; `fs.rename` never called; `.part` best-effort unlinked. |
| **Electron Main (or Path 3A broker) saves already in `COMMITTING_RENAME` when Lock arrives** | Stage C in-flight rename in OS/libuv | Revocation starts immediately; Lock ack waits (bounded) and reports `committed-before-lock-ack`, error, or `unresolved` while locking `destKey` in `unresolvedDestinations` across re-unlock and restart until settled/recovered. |

### 6.4 Cross-Profile and Cross-Process Lock Races (Explicit Honesty Analysis)

1. **Same-profile, cross-process renderer race:** Modern browsers run tabs in separate renderer processes backed by an asynchronous storage IPC service. Advisory `localStorage` and `BroadcastChannel` hints accelerate concealment, **but** multi-process propagation timing across Windows Chromium/Edge/Firefox renderer processes is **unverified** and **is not an atomic global fence**.
2. **Cross-profile Lock race:** Profile 1 and Profile 2 share no IndexedDB, `localStorage`, or `BroadcastChannel`. Profile 1 learns of Profile 2's Lock only via SSE `event: session-ended` / stream EOF or `401` on its next server request.
3. **No fixed one-RTT maximum window:** Tab backgrounding/timer throttling, renderer suspension or OS sleep, CPU scheduling contention, storage IPC queues, and loopback/kernel socket buffering can extend a tab's observation delay arbitrarily beyond one loopback RTT. This design **never claims a fixed one-RTT maximum race window**.

### 6.5 Honest Lock Completion and Acknowledgement Contract

When an operator clicks Lock, the UI and backend strictly separate **confirmed server revocation**, **auth rejection**, **unknown outcome**, and **unknown remote-tab state**:

1. **Three distinct Lock outcomes shown to the user (never conflated):**
   - **`CONFIRMED_REVOKED`** (`200 {locked: true, lockedGeneration}` matching target, `401 {code: 'LOCKED'}`, or `POST /api/session/lock-with-key` `200`): Proves `L_lock` completed atomically on the server, all `admittedClients` and replay caches for `lockedGeneration` were purged, no future requests for `lockedGeneration` will be accepted, terminal control lease was revoked, and `session-ended` + socket close were initiated on all known SSE streams. Only on `CONFIRMED_REVOKED` does the client CAS-delete `'current'` from IndexedDB.
   - **`AUTH_REJECTED`** (`401 {code: 'AUTH_FAILED'}` while server is not confirmed `LOCKED`): Explicitly warns that server revocation is **not confirmed** (a `401` can reflect clock skew, signature/replay rejection, or a superseded session while a server session remains active). Keeps the view strictly concealed in `LOCK_RECOVERY` and offers **Retry Lock** (fresh `ts`/`nonce`) or **Confirm Lock with `.state/access.key`** (`POST /api/session/lock-with-key`).
   - **`UNKNOWN_OUTCOME`** (interrupted transmission, refresh mid-Lock, timeout, network error, `429`/`5xx`): Explicitly warns that the view is concealed locally and `'current'` is held in `LOCK_PENDING`, but the shared session may still be active on the server. Offers **Retry Lock** (using the `LOCK_PENDING` key without revealing workspace data) or **Confirm Lock with `.state/access.key`**.
2. **What even `CONFIRMED_REVOKED` DOES NOT PROVE (remains UNKNOWN):**
   - Whether any sibling tab (same-profile or cross-profile) has finished observing revocation or concealing already-rendered DOM.
   - Whether a plain-browser tab that already received Stage A bytes crossed Stage B (`a.click()`) or Stage C (browser download disk write) during scheduling/suspension/network delay before observing Lock.
   - Whether already-delivered bytes have been cleared from browser/GPU memory, OS clipboard, or previously saved files, or whether an already-approved run has stopped (`stopsWork: false`).
3. **What requires stronger mechanisms to guarantee:**
   - **Strict Stage C file-save ordering vs. Lock:** Requires **one privileged local authority** owning both Lock and filesystem commits (Electron Main or Path 3A browser save broker). Fresh user interaction or re-auth before `a.click()` does **not** guarantee this.
   - **Confirmed multi-tab concealment before Lock finishes:** Requires a **two-phase tab acknowledgement protocol** that never blocks server `L_lock` and explicitly reports **partial / unresolved concealment** for suspended, throttled, or crashed tabs that fail to reply within timeout.
   - **Defense against Adversary Class B or malicious same-origin JS:** Requires OS process/user isolation (AppContainer, dedicated OS user, or VM).

---

## 7. Bounded Replay Tracking, Concurrency, DoS Behavior, and Session Revocation

### 7.1 Clock-Rollback-Safe Bounded Replay Tracking (Mathematical Invariant)

A naive fixed `60s` monotonic TTL for nonces with a `±30s` timestamp window is vulnerable to replay if wall-clock rollback is tolerated without locking (for example, a request accepted with `reqTsMs = T + 30s` would remain inside `[T' - 30s, T' + 30s]` after 60 monotonic seconds if wall time slipped back even a few seconds). This design eliminates that gap with a **strict high-water-mark clock guard + dual-condition nonce retention rule**:

- **Constants:** `MAX_SKEW_MS = 30_000`; `MAX_CUMULATIVE_BACKWARD_MS = 2_000`; `MIN_MONO_RETENTION_NS = 62_000_000_000n` (`2 * MAX_SKEW_MS + MAX_CUMULATIVE_BACKWARD_MS`).
- **Timestamp check:** Require integer `reqTsMs` with `Math.abs(nowWallMs - reqTsMs) <= MAX_SKEW_MS`, evaluated only after `sampleClockAndCheckSession()` confirms `nowWallMs >= clockState.maxObservedWallMs - MAX_CUMULATIVE_BACKWARD_MS` (else immediate atomic `L_lock(reason='clock-fault')` rotating `sessionGen`).
- **Dual-condition retention entry:** Every accepted PoP request inserts `key = clientId + ':' + nonce` with:
  - `pruneAfterWallMs = reqTsMs + MAX_SKEW_MS + MAX_CUMULATIVE_BACKWARD_MS` (`reqTsMs + 32_000`)
  - `pruneAfterMonoNs = nowMonoNs + MIN_MONO_RETENTION_NS` (`nowMonoNs + 62s`)
- **Pruning rule:** An entry may be pruned **ONLY** when **BOTH** conditions hold:
  1. `clockState.maxObservedWallMs > entry.pruneAfterWallMs` **AND**
  2. `nowMonoNs >= entry.pruneAfterMonoNs`
- **Replay-impossibility proof:** Suppose nonce `k` (with timestamp `reqTsMs`) is pruned at time `t1`. Then `maxObservedWallMs(t1) > reqTsMs + 32_000`. Because `maxObservedWallMs` is non-decreasing within a live `sessionGen`, at any later time `t2 >= t1` we have `maxObservedWallMs(t2) >= maxObservedWallMs(t1) > reqTsMs + 32_000`. Any future request arriving at `t2` either: (a) observes `nowWallMs(t2) < maxObservedWallMs(t2) - 2_000`, which immediately triggers `clock-fault` and rotates `sessionGen` (invalidating the replay by generation mismatch), OR (b) observes `nowWallMs(t2) >= maxObservedWallMs(t2) - 2_000 > reqTsMs + 30_000`, which unconditionally fails `|nowWallMs(t2) - reqTsMs| <= 30_000` with `401`. Thus a pruned nonce can **never** become eligible for replay.
- **Hard memory bounds and dedicated Lock lane:**
  - General API cache (`seenNonces`): `MAX_SEEN_NONCES = 4096`, per-client `MAX_NONCES_PER_CLIENT = 512`. Never evict an unprunable nonce; if still full after pruning eligible entries, fail closed with `429 Too Many Requests` (`Retry-After: 5`) without mutating state.
  - **Dedicated Lock lane (`lockSeenNonces`):** Separate map (`MAX_LOCK_NONCES = 64`) used exclusively by `POST /api/session/lock` (and `POST /api/session/lock-with-key` challenges). General API `seenNonces` saturation can **never** cause `POST /api/session/lock` to return `429`.
- **No unproven claims:** Replay caches are strictly in-memory per live `sessionGen`. Across service restarts, `sessionGen` rotates so old requests fail by generation mismatch.

### 7.2 Concurrency Controls

- **Multi-tab same-profile concurrency:** Parallel requests from Tab 1..N use the shared authoritative `clientId` and distinct 128-bit random nonces (no cross-tab sequence counter). Concurrent same-profile unlocks resolve atomically via IndexedDB **Rule CAS-ADMIT** with CAS losers freeing their orphan slot via `POST /api/session/retire-client`.
- **Bounded server resources:**
  - `MAX_TCP_CONNECTIONS = 32` (with reserved capacity / priority handling for `POST /api/session/lock` on existing HTTP/2 streams)
  - `MAX_HTTP2_CONCURRENT_STREAMS_PER_CONN = 32`
  - `MAX_ADMITTED_CLIENTS = 16` per active `sessionGen` (`429` when full; never evicting active clients)
  - `MAX_EVENT_STREAMS_PER_CLIENT = 16`, `MAX_TOTAL_EVENT_STREAMS = 64` (returning `429 {code: 'STREAM_CAP'}` to trigger seamless profile Leader Stream Coordinator fallback per Section 4.3 rather than silently degrading)
- **Workspace write concurrency:** Preserves existing single-process `acquireWorkspaceLock` mutual exclusion, SQLite `BEGIN IMMEDIATE` transactions, optimistic `task.version` checks (`409`), single-active-run guard, and keyed `run-submission` / `draft-copy` idempotency.

### 7.3 Denial-of-Service (DoS) Behavior and Honest Limits

- **Payload and timeout bounds:** Keep existing `48 KB` JSON body limit (`harness/server.mjs` line 208), enforce `headersTimeout = 10_000 ms`, `requestTimeout = 15_000 ms` (exempting authenticated long-lived `POST /api/session/events` streams after header/body verification), and cap raw header size at `16 KB`.
- **Failed-unlock throttling:** Track failed `POST /api/session/challenge` and `POST /api/session/admit` attempts in a fixed sliding window (for example, 10 failures per 60 seconds -> `429` with `Retry-After`). Failed unauthenticated unlock attempts must **never** revoke or alter an already-active `sessionGen`.
- **Honest DoS boundary:** These caps protect against runaway tab floods, accidental infinite loops, and basic slowloris connections. They do **not** defend against a hostile same-user local process (Adversary Class B), which can exhaust OS sockets, CPU, or terminate the Node process directly.

### 7.4 Session Revocation Mechanics

- Revocation (`L_lock`) is always single-turn atomic: rotate `sessionGen` (256-bit CSPRNG), clear `admittedClients`, `seenNonces`, `lockSeenNonces`, and `idleClock`, reset `maxObservedWallMs = Date.now()`, call `activeRun?.control.revoke()`, push `event: session-ended`, and end/destroy all active SSE streams.
- Because `bfe_session` cookies and cookie-only fallbacks are deleted from the server, no secondary ambient credential exists that could bypass revocation.

---

## 8. Implementation Slices, Verification Plan, Review, and Separate Gates

### 8.1 Dependency-Ordered Small Implementation Slices

Each slice is sized for isolated review and deterministic testing. **Stage 1 (Slices 1-4)** consists of routine local development and offline synthetic tests (using ephemeral in-test keys only, with zero persistent certificates, trust-store edits, extensions, registry writes, or live service changes) and is covered by existing CydeWorks development authority without requiring another general go-ahead. **Stage 2 (Slices 5-6)** executes concrete OS/security/trust/extension/live-environment actions and is gated strictly on specific owner approval of those concrete actions before execution.

1. **Slice 1 (Stage 1 - Routine Local Implementation): Core Service Extraction, Canonical Request Parser & Clock/Idle/Lock Engine**
   - Extract `harness/workspace-service.mjs` from `harness/server.mjs`, preserving `acquireWorkspaceLock`, SQLite schema, single-active-run guard, terminal control, `recordInterruption`, and all runner holds.
   - Implement `parseCanonicalRequest(req, rawBody)` (single source of truth for PoP verifier and router; rejecting ambiguous encodings, duplicate raw headers, and method/body mismatches).
   - Implement `LOCKED`/`ACTIVE` state machine, high-water-mark `sampleClockAndCheckSession()`, `POST /api/session/touch` (debounced genuine user read-only idle extension), `POST /api/session/lock` (dedicated `lockSeenNonces` lane + `401 {code: 'LOCKED'}` vs `401 {code: 'AUTH_FAILED'}`), `POST /api/session/lock-with-key`, and `POST /api/session/retire-client`.
   - Remove `bfe_session` cookies and any cookie-only fallback.
2. **Slice 2 (Stage 1 - Routine Local Implementation): Mutual HMAC Admission, Dual-Condition Replay Cache, Concurrency Caps & HTTP/2 SSE Stream**
   - Implement `POST /api/session/challenge`, `POST /api/session/admit` (mutual HMAC), `GET /api/session/status`, `POST /api/session/check`, and `POST /api/session/events` (`event: ready` + 15s `event: ping`) over `node:http2` (TLS 1.3 with `allowHTTP1: true`; synthetic tests use ephemeral in-memory test certs only).
   - Implement ECDSA P-256 PoP verification, dual-condition `seenNonces` + dedicated `lockSeenNonces`, connection/stream/client caps (`429 {code: 'STREAM_CAP'}`), read timeouts, and failed-unlock throttling.
3. **Slice 3 (Stage 1 - Routine Local Implementation): Authoritative CAS Profile Store, `LOCK_PENDING` Recovery, Resume Freshness & Leader SSE Fallback**
   - Update both `harness/web/` and `harness/web-experience/` (`adapters/http.js`, `app.js`, `views/usage.js`, dialogs) to use the single authoritative IndexedDB profile store (`profile_session` + `profile_meta`) with `Rule CAS-ADMIT`, `Rule CAS-LOCK-PENDING`, and `Rule CAS-DELETE`, advisory-only `localStorage`/`BroadcastChannel` hints ordered by `storeSeq`, zero-reveal `LOCK_RECOVERY` (`Retry Lock` / `lock-with-key`), post-resume stream freshness verification, Profile Leader Stream Coordinator (HTTP/1.1 & `429 STREAM_CAP` fallback), `POST /api/session/touch` on trusted UI events, `pagehide`/`bfcache` concealment, Commit Boundary 2 (`usage.js` `presented` Map wipe), and Commit Boundary 3.
   - Update asset integrity manifests (`harness/browser-assets.mjs`).
4. **Slice 4 (Stage 1 - Routine Local Implementation): Electron Zero-TCP Document-Bound IPC, Correlated Lock Ack & Persistent Destination-Conflict Saves**
   - Refactor `harness/desktop/main.cjs`, `service.cjs`, and add `preload.cjs` / `broker.cjs` for zero-TCP `utilityProcess.parentPort` RPC, `cydeworks://app/index.html` asset serving, preserved navigation/window-open/webview/permission denials, strict `authorizedDocument` ingress + pre-reply IPC egress revalidation, correlated `bfe-rpc-lock` / `bfe-rpc-lock-ack` (`LOCKED_CONFIRMED` / `LOCKED_SERVICE_EXITED` / `LOCK_UNCONFIRMED`), and the `activeSaves` + write-ahead `pending-saves` journal + `unresolvedDestinations` conflict registry across Lock, re-unlock, and restart.
5. **Slice 5 (Stage 2 - Concrete Gated Actions): Approved Transport Provisioning (T1a / T1b / T2) and Optional Path 3A Save Broker**
   - *Concrete owner approval required before executing:* persistent certificate/CA or credential creation, Windows `CurrentUser\Root` or Firefox trust-store changes (T1a/T1b), extension signing/installation and `HKCU` Native Messaging registry writes (T2), or enabling a local brokered browser file-save authority (Path 3A).
   - Implement and execute only the specifically approved provisioning ceremony, auditing pre-existing `localhost` CAs (T1), enforcing fail-closed legacy HTTP cutoff (no HTTP redirect listener), and binding dual-stack loopback (`127.0.0.1` + `::1`) if T1 is provisioned.
6. **Slice 6 (Stage 2 - Concrete Gated Actions): Real Windows Browser & Electron Acceptance Execution**
   - Execute real Windows acceptance tests across target browsers and Electron once concrete Stage 2 actions are approved; record observed browser/OS differences and race latencies explicitly rather than extrapolating from Linux synthetic tests.
7. **Slice 7 (Final Security Gate): Independent Codex GPT-6.2 Sol High Review**
   - Submit final diffs, synthetic offline test results, and real Windows acceptance evidence for independent security review before any integration, deployment, or release packaging.

### 8.2 Deterministic Synthetic Offline Tests (Linux Sandbox, Ephemeral In-Test Certs Only)

Run in the verified offline Linux container (nonroot, loopback-only, read-only source, zero OS trust-store edits, ephemeral in-test TLS keys / Unix domain socket for T2 broker tests):

1. **Zero-cookie, canonical framing & PoP target integrity (Finding 5):**
   - Assert zero `Set-Cookie` headers; `401` on legacy cookies, unsigned direct navigation, invalid `Origin`/`Host`.
   - Assert `parseCanonicalRequest` rejects with `400`: `%2f`/`%2F`, `%2e`/`..`, `//`, `\`, fragments, control chars, duplicate security-critical headers in `rawHeaders` (e.g., duplicate `X-Request-Nonce`, `X-Client-Sig`, `Host`, `Content-Length`), HTTP/2 `:authority` vs `Host` mismatch, `GET` with non-empty body or non-zero `Content-Length`, `Content-Length` + `Transfer-Encoding` smuggling, and method/query/body tampering against the PoP signature.
2. **Clock-rollback-safe replay invariant & DoS saturation (Findings 1 & 5):**
   - Accept request with `reqTsMs = T + 30s`; advance monotonic clock 61s while simulating wall-clock rollback (`-1.5s` within `MAX_CUMULATIVE_BACKWARD_MS` and `-5s` exceeding it): verify the nonce is NOT pruned early (or `clock-fault` rotates `sessionGen`) and replay is unconditionally rejected!
   - Test gradual cumulative wall-clock rollbacks (three `-1s` steps totaling `-3s` below `maxObservedWallMs`) -> assert `clock-fault` triggers `LOCKED`.
   - Fill `seenNonces` to `MAX_SEEN_NONCES` with unprunable entries -> assert ordinary API calls fail closed with `429`, **AND assert `POST /api/session/lock` STILL SUCCEEDS (`200`) via the dedicated `lockSeenNonces` lane!**
3. **Authenticated Lock under failure, refresh, saturation & recovery (Finding 1):**
   - Test interrupted Lock transmission, lost Lock response, simulated refresh (`F5`) during `LOCKING`, and `429`/`5xx` on Lock -> assert IndexedDB `'current'` stays in `LOCK_PENDING`, refreshed/sibling tabs stay strictly `CONCEALED` with zero workspace data revealed, and retrying `POST /api/session/lock` with fresh `ts`/`nonce` confirms revocation and CAS-deletes `'current'`.
   - Test `POST /api/session/lock` returning `401 {code: 'AUTH_FAILED'}` while server is `ACTIVE` (e.g., injected clock skew or bad signature) -> assert UI shows `AUTH_REJECTED` (NEVER `already-locked`), keeps view concealed, and succeeds via zero-reveal `POST /api/session/lock-with-key` recovery without unlocking or revealing workspace data.
4. **Authoritative CAS Profile Store concurrency & stale-event immunity (Finding 2):**
   - **Delayed admission after Lock:** Start unlock in Tab A, complete Lock in Tab B before Tab A's `admit` response arrives -> assert **Rule CAS-ADMIT** rejects write, discards `keyPair`, retires orphan `clientId`, and stays `CONCEALED`.
   - **Concurrent unlocks sharing one `sessionGen`:** Unlock Tab A (`clientId_A`) and Tab B (`clientId_B`) simultaneously under the same `sessionGen` -> assert one wins `storeSeq+1`, the loser CAS-fails without overwriting `'current'`, calls `POST /api/session/retire-client` for its own orphan `clientId` without revoking `sessionGen`, and joins the winning credential.
   - **Stale notifications after re-unlock:** Deliver delayed `BroadcastChannel` / `localStorage` Lock hints with older `storeSeq` after re-unlock -> assert ignored and newer active session remains intact.
   - **Stale `401` after re-unlock:** Deliver a delayed `401` from pre-re-unlock `(sessionGen_1, clientId_1, cred_1)` after re-unlocking `(sessionGen_2, clientId_2, cred_2)` (and also from retired `clientId_A` under the same `sessionGen_1`) -> assert **Rule CAS-DELETE** does NOT delete or conceal the newer session.
5. **Certificate trust chains, out-of-scope issuance, rotation, retirement, legacy HTTP & T2 broker survival (Finding 4):**
   - **Unintended trust chain test:** Verify a TLS client trusting two test CAs accepts a rogue loopback server signed by the second CA, documenting empirically why ordinary browser TLS does not pin CydeWorks's specific leaf cert.
   - **Out-of-scope issuance test (T1a):** Sign synthetic leaf certs for `example.com` and `192.0.2.1` with the Name-Constrained Root CA -> assert TLS validation rejects both.
   - **Rotation & retirement test:** Rotate CA/leaf, remove retired anchor from test trust store -> assert new leaf succeeds and retired leaf fails closed.
   - **Legacy HTTP fail-closed test:** Send plaintext HTTP to the HTTPS port -> assert failure with zero redirect and zero cookie acceptance.
   - **Option T2 broker auth & survival test (Unix socket synthetic stand-in):** Verify mutual `pipeAuthSecret` handshake rejects unauthorized clients, disconnect/kill the thin broker (simulating browser quit) while workspace service stays live, spawn a fresh broker (simulating browser relaunch), and confirm signed `GET /api/session/status` succeeds with zero prompts.
6. **Stream freshness after resume, stream-cap / HTTP/1.1 leader fallback, and read-only idle activity:**
   - Advance simulated monotonic/wall timers past `45s` without `event: ping` and fire `visibilitychange`/`resume` -> assert `revocationStreamHealthy` drops to `false` immediately and blocks exports until fresh `GET /api/session/status` or `event: ready` confirms liveness.
   - Trigger `429 {code: 'STREAM_CAP'}` (and simulated HTTP/1.1 mode) across 8 simulated tabs -> assert leader election holds 1 SSE stream, relays `ping` and `session-ended` to all followers, promotes a new leader on leader close/crash, and renders an explicit degraded banner only if both direct and leader links fail past 10s.
   - Verify automated polling (`GET /api/tasks`, `GET /api/session/status`, `POST /api/session/check`, `heartbeat`) does NOT extend the 15-minute idle timer, while trusted-UI `POST /api/session/touch` (rate-limited to 1/60s) DOES extend it.
7. **Frontend Reveal & Save Fence race matrix:**
   - Inject foreign Lock hints/SSE `session-ended` while `getTask`, `listTasks`, `readiness`, `downloadArtifact`, `loadSourceFile`, `openHandoffReview`, `costPresentation`, and `actions.download` are pending -> assert zero DOM mutations, zero `a.click()`, zero dialog opens, and `usage.js` `presented` Map emptied.
8. **Electron Zero-TCP, Document-Bound IPC, Correlated Lock Ack & Destination-Conflict Save Tests (Findings 6 & 7):**
   - Zero listening TCP sockets; verify `setWindowOpenHandler`, `will-attach-webview`, `setPermissionRequestHandler`, `will-navigate`, and `will-redirect` denials.
   - Verify IPC ingress rejects wrong `webContentsId`, subframe (`top !== senderFrame`), wrong `frameRoutingId`/`frameProcessId`, non-exact URL, or stale `docEpoch`/`docToken`.
   - **In-flight mutation & late IPC reply:** Dispatch async RPC, trigger Lock or programmatic `did-start-navigation` before utility reply returns -> assert pre-reply revalidation drops the late payload (`{aborted: true}`).
   - **Utility exit / lost `lock-ack` during Lock:** Kill utility process mid-Lock -> assert Main reports `LOCKED_SERVICE_EXITED` (unknown in-flight mutation disclosure). Hang utility process so `lock-ack` times out -> assert Main reports `LOCK_UNCONFIRMED` (never attesting confirmed revocation) and keeps renderer concealed/blocked.
   - **Late rename settlement, conflicting later save, and restart with unresolved disk state:**
     - Lock during `DIALOG` or `STAGING_WRITE` never calls `fs.rename` and cleans up `.part`.
     - Lock during delayed `COMMITTING_RENAME` settling within timeout reports `committed-before-lock-ack`.
     - Lock during delayed `COMMITTING_RENAME` exceeding timeout reports `unresolved`, retains `destKey` in `unresolvedDestinations`, **blocks a later save to the same `finalPath` (and Windows case-variant path) after re-unlock** while allowing saves to a different path, and transitions to `LATE_COMMITTED` with user notice when the hanging rename finally resolves.
     - Restart with a persisted `COMMITTING_RENAME` / `UNRESOLVED` journal entry loads `UNRESOLVED_FROM_PRIOR_RUN`, inspects `tmpPath`/`finalPath` non-destructively against `expectedSha256`, blocks overwriting `finalPath`, and clears only after explicit user recovery.

### 8.3 Real Windows Browser and Electron Acceptance Tests (Stage 2)

Synthetic Linux tests do **not** prove Windows CryptoAPI, Firefox NSS, IndexedDB persistence, HTTP/2 multiplexing, OS sleep/resume timers, Named Pipe ACLs, or Electron 45 Windows behavior. Each target browser (Chrome, Edge, and Firefox if in scope) and Electron must be tested directly on Windows, recording any browser-specific variance:

1. **TLS / Identity / Rotation (T1) or Native Host / Relaunch Survival (T2):**
   - T1: Audit pre-existing `CurrentUser\Root` / `LocalMachine\Root` CAs; verify zero browser warnings on `https://cydeworks.localhost:<port>` (or `https://localhost:<port>`); verify Root CA key absent from disk (T1a); test out-of-scope leaf rejection (`example.com`, `192.0.2.1`) in Windows CryptoAPI + Firefox NSS; test cert rotation + retirement confirming retired leaf fails; verify dual-stack IPv4+IPv6 loopback bind and fail-closed legacy `http://127.0.0.1:<port>` cutoff.
   - T2: Verify owner-only Named Pipe DACL (`D:(A;;GA;;;OW)`), mutual `pipeAuthSecret` auth, full browser quit+relaunch survival with zero prompts, and (if Path 3A enabled) brokered staged save serialization.
2. **Refresh, Relaunch & Multi-Tab UX:** Unlock once with `.state/access.key`; press `F5` multiple times and fully quit+relaunch browser within 15 minutes while service stays running -> verify zero Windows Hello or access-file prompts. Open 8+ and 18+ tabs in Profile 1 -> verify HTTP/2 multiplexing and seamless Leader Stream Coordinator failover past `MAX_EVENT_STREAMS_PER_CLIENT` (and under forced HTTP/1.1).
3. **Sleep/Resume Freshness, Cross-Profile Isolation & Lock Races:** Suspend/resume Windows (or freeze tab `> 45s`) -> confirm stream freshness re-verifies before allowing exports. Test Profile 2 isolation and empirically test copying Profile 1 IndexedDB files into a disposable profile under Windows DPAPI/App-Bound Encryption. Trigger cross-tab and cross-profile Locks (including interrupted/offline Lock recovery via `LOCK_PENDING` + `lock-with-key`) and record actual propagation latencies and `bfcache` behavior.
4. **Real Windows Electron Acceptance:** Verify zero listening TCP sockets via `netstat`; verify navigation/permission/webview denials, pre-reply IPC drop on reload/Lock, utility-process crash/hang `LOCKED_SERVICE_EXITED`/`LOCK_UNCONFIRMED` reporting, Lock-vs-`COMMITTING_RENAME` (`committed-before-lock-ack` vs `unresolved`), destination-conflict blocking across Windows case-insensitive path variants after re-unlock and restart, and Windows Defender/antivirus handle-lock behavior.

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

## 9. Open Decisions, Residual Risks, and Unverified Browser/OS Behavior

### 9.1 Open Decisions Requiring Owner Selection or Concrete Action Approval

1. **OD-1 (Strict Browser Save/Lock Requirement Reconciliation - Path 3A vs. Path 3B, Section 6.3):** Plain standalone browser downloads (`a.click()`) cannot guarantee strict Stage C (completed OS disk save) ordering against Lock, even with fresh user interaction or re-authentication. Decide between:
   - **Path 3A (Approval-Gated Single Privileged Local Save/Lock Broker):** Adopt Option T2 (Signed Extension + Native Messaging -> long-lived workspace service performing brokered saves) or T1 + an approval-gated local brokered export endpoint so one privileged authority serializes both Lock and OS file commits; OR
   - **Path 3B (Explicit Requirement Scoping):** Explicitly amend `docs/T3-BROWSER-LOCK-REQUIREMENTS-2026-11-19.md` to scope standalone browser Lock ordering to **Stage A (server byte release `L_lock`)** while preserving strict Stage C disk-commit ordering in Electron Desktop mode.
2. **OD-2 (Concrete Stage 2 Transport Provisioning Approval):** Execute T1a/T1b certificate/trust-store enrollment (with explicit non-pinning boundary against competing `localhost` CAs) OR T2 extension signing/publication and `HKCU` registry registration only after specific owner approval of those concrete host actions.
3. **OD-3 (Target Windows browser scope):** Clarify whether personal-release browser scope is Chrome and Edge only (Windows `CurrentUser\Root`) or also includes Firefox (which adds a concrete Firefox trust-store or Mozilla AMO approval step).
4. **OD-4 (Leaf certificate renewal cadence under T1):** Determine leaf validity lifetime (for example 90 days vs. 180 days vs. 365 days) and pre-expiry UI reminder threshold (for example 14 days) prior to any owner-approved certificate enrollment.
5. **OD-5 (Cross-profile Lock and concurrent unlock policy - design recommendation not yet selected by owner):** The owner approved shared-session Lock across tabs within one signed-in profile. This design additionally recommends retaining `harness/SESSION-LOCK.md`'s workspace-wide Lock across independently admitted profiles; decide whether to keep concurrent multi-profile sessions sharing a revocable `sessionGen`, or instead rotate `sessionGen` to displace Profile 1 whenever Profile 2 unlocks.

*(Resolved in this revision: genuine user read-only activity extends idle expiry via trusted-UI debounced `POST /api/session/touch` while automated polling never extends it; HTTP/1.1 and `429 STREAM_CAP` fall back seamlessly via the Profile Leader Stream Coordinator without silently degrading supported workflows.)*

### 9.2 Residual Risks

| Risk | Severity | Cause | Mitigation & Honest Boundary |
| :--- | :--- | :--- | :--- |
| **Equivalent-user local process compromise (Adversary Class B)** | High (Out of Scope) | Same Windows user account may access `.state/access.key`, `.state/tls/` private keys, owner Named Pipes, browser profile files, and Node/browser process memory. | Local HTTPS and Named Pipe ACLs do not defend against an equivalent-user process; requires OS isolation (AppContainer, dedicated OS user, or VM). |
| **Competing browser-trusted `localhost` certificate (Option T1)** | High (Conditional) | Ordinary browser TLS does not pin CydeWorks's specific leaf cert if another CA/leaf trusted by Windows/Firefox for `localhost` exists and its private key is held by an attacker. | Mitigated by narrowing T1 threat claim, auditing `CurrentUser\Root` during Stage 2, using `cydeworks.localhost` where supported, and mutual HMAC admission (post-load); eliminated pre-load only by **Option T2** (pinned signed extension UI) or removing competing trusted roots. |
| **Malicious same-origin JS / browser extension with host permissions** | High | `extractable: false` blocks raw key export, not `crypto.subtle.sign` abuse inside the same origin. | Mitigated by strict CSP (`default-src 'none'; script-src 'self'`), zero inline scripts, asset hash verification, and TLS/extension initial-load auth; not mitigated if browser itself is compromised. |
| **Plain browser post-Lock Stage B/C download race (unbounded window)** | Medium / High vs. Strict Req | Plain browser `a.click()` handoff and download-manager disk write happen outside server control; fresh interaction or re-auth does NOT close the race; suspension/scheduling/IPC/buffering make observation latency unbounded. | Strictly solved ONLY by **Path 3A** (single privileged local authority owning Lock and file commits); otherwise requires **Path 3B** (explicitly scoping standalone browser requirement to Stage A server byte release). |
| **Unresolved Electron / Path 3A rename on crash, driver hang, or power loss** | Medium | OS kernel / filesystem rename cannot be atomically rolled back once dispatched, and may stall on network shares or antivirus filter drivers. | Broker serializes Lock ack with bounded wait (`committed-before-lock-ack`, error, or `unresolved`), persists write-ahead journal, and blocks conflicting later saves to `destKey` in `unresolvedDestinations` across re-unlock and restart until settled/reconciled. |
| **Electron utility process hang or exit during Lock** | Medium | Utility process may crash or fail to reply over `parentPort`. | Main never falsely attests revocation without correlated `bfe-rpc-lock-ack`; explicitly reports `LOCKED_SERVICE_EXITED` or `LOCK_UNCONFIRMED`, keeps renderer concealed/blocked, and requires recovery/inspection. |
| **Stolen browser profile directory reuse** | Medium (Unverified) | Browser IndexedDB at-rest protection varies by browser and Windows DPAPI/App-Bound Encryption version. | Not claimed as mitigated; must be empirically tested on Windows in Stage 2 and documented truthfully. |
| **Non-erasable disk/memory remnants of keys or rendered data** | Medium | SSD wear-leveling/FTL, NTFS journals, VSS, pagefile, GPU buffers, clipboard, and already-saved files. | Keep T1a Root CA key RAM-only; never claim secure disk deletion; disclose already-delivered data limits clearly in Lock UI. |

### 9.3 Unverified Browser and OS Behavior (Must Be Tested Empirically on Windows)

The following behaviors are **unverified** as of commit `c0df0f576db84bb9b962a2ac50a95ceda4c02079` and must be confirmed in Stage 2 Windows tests before any release claim:

1. **Windows CryptoAPI (Chrome/Edge) and Mozilla NSS (Firefox) Name Constraints and `cydeworks.localhost` resolution:** Whether `critical` RFC 5280 Name Constraints (`DNS:cydeworks.localhost`, `DNS:localhost`, `IP:127.0.0.1/32`, `IP:::1/128`) validate cleanly, reject out-of-scope certs (`example.com`, `192.0.2.1`), and resolve `cydeworks.localhost` to loopback without external DNS across all target Windows browsers.
2. **Direct leaf certificate trust (Option T1b):** Whether Chrome, Edge, and Firefox on Windows accept a `CA:FALSE` self-signed loopback leaf certificate placed in `CurrentUser\Root` / NSS without CA warnings.
3. **IndexedDB `extractable: false` `CryptoKey` persistence, CAS transactions, and profile-copy behavior:** Verified persistence across full quit+relaunch and crashes on Windows Chrome, Edge, and Firefox, plus empirical behavior when profile storage files are copied to a second profile under DPAPI/App-Bound Encryption.
4. **HTTP/2 `fetch()` `ReadableStream` SSE multiplexing, sleep/resume clock behavior, and Web Locks leader failover:** Confirming 8+ tabs multiplex cleanly, OS sleep/hibernation triggers post-resume freshness re-verification, and `navigator.locks` + `BroadcastChannel` leader failover operates cleanly under HTTP/1.1 or `429 STREAM_CAP` on Windows.
5. **Multi-process `localStorage` / `BroadcastChannel` / SSE revocation visibility latency:** Measuring actual propagation delay across distinct renderer processes and backgrounded/throttled tabs on Windows under CPU load.
6. **`bfcache` interaction with `Cache-Control: no-store` and `pagehide`:** Confirming Back/Forward navigation after Lock never flashes stale workspace DOM before `BOOTING` re-verification runs.
7. **Dual-stack loopback (`127.0.0.1` and `::1`) bind behavior (T1) and Windows Named Pipe DACL + Native Messaging broker survival across browser relaunch (T2):** Confirming no IPv4/IPv6 race under T1 and clean owner-only pipe + relaunch re-attachment under T2.
8. **Electron 45 on Windows:** Confirming `cydeworks://app/index.html` ES module loading under strict CSP, `WebFrameMain` `processId`/`routingId`/`url` stability across reloads, pre-reply IPC drop on Lock/navigation, correlated `bfe-rpc-lock-ack` timeout/crash handling, and persistent `unresolvedDestinations` conflict blocking across Windows case-insensitive paths and Defender/antivirus handle locks.

