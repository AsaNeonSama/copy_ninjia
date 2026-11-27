# 10 Mini App Setup and Recommended Configuration

<p align="center">
  <a href="../cn/10-mini-app.md">简体中文</a> · <b>English</b> · <a href="../ja/10-mini-app.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="09-commands.md">← Prev: 09 Command Reference</a> · <a href="11-performance.md">Next: 11 Performance Benchmark →</a>
</p>

---

This guide explains how to enable the SuperAdmin-exclusive Telegram Mini App management console in `config/static/bot.json`, expose the local HTTP server as a public HTTPS endpoint via Cloudflare Tunnel (`cloudflared`), sign in with two-tier authentication and 256-bit temporary-key AES-256-GCM transport encryption, bind Google Authenticator TOTP, and edit deployment JSON configurations online with syntax highlighting. For full JSON field schemas, see the [Deployment Configuration Guide](../../config_example/README/en.md#botjson); for HTTP API routes and permission guards, see [09 Command Reference](09-commands.md#mini-app-console).

## Configure `bot.json` to Enable the Mini App

Add the optional `mini_app` object to `config/static/bot.json`:

```json
{
  "bot_token": "replace-with-telegram-bot-token",
  "super_admin_user_id": 123456789,
  "atmosphere": "mesugaki",
  "log_level": "operation",
  "time_zone": "Asia/Tokyo",
  "mini_app": {
    "url": "https://app.example.com",
    "port": 3000,
    "host": "127.0.0.1",
    "password": "your-secure-password-123456"
  }
}
```

| Field | Required / Optional | Constraints and Notes |
| :--- | :---: | :--- |
| `url` | **Required** | Public `https://` URL opened by the Telegram WebApp client; supports subpath prefixes (e.g. `https://app.example.com/sub`) and works with reverse proxies whether they preserve or strip the path prefix |
| `port` | **Required** | Local `Bun.serve` HTTP listening port; safe integer in `MINI_APP_PORT_MIN`–`MINI_APP_PORT_MAX` (`1`–`65535`), recommended `3000` to match your tunnel target port |
| `host` | Optional | Non-empty local `Bun.serve` HTTP bind address, defaulting to `MINI_APP_DEFAULT_HOST` (`"127.0.0.1"`); binds to loopback only so no inbound firewall port needs to be exposed |
| `password` | **Required** | First-screen access password; must be a non-empty string containing at least 6 digits (`0-9`, matching `MINI_APP_PASSWORD_AT_LEAST_SIX_DIGITS_PATTERN`) and must not remain `MINI_APP_PASSWORD_PLACEHOLDER` (`"replace-with-mini-app-password"`) |

- **Optional activation**:
  - Omitting the entire `mini_app` section disables the local `Bun.serve` server, skips route registration, and omits `MenuButtonWebApp` from private chat. When present, `url`, `port`, and `password` are required, `host` is optional (defaulting to `MINI_APP_DEFAULT_HOST`), and legacy `signing_private_key` / `signing_public_key` fields are rejected.
  - If you copy `config_example/static/bot.json` manually without using the Mini App, delete the `mini_app` block—leaving the placeholder password halts startup validation. Running `install.sh` automatically strips a placeholder `mini_app` block while preserving any already-configured real password on re-runs.
- **Restart required**: `config/static/bot.json` is static; restart the bot service after changing `mini_app`.

---

## Recommended Setup: Using Cloudflare Tunnel

Telegram Mini Apps require a public `https://` URL. **Cloudflare Tunnel (`cloudflared`)** is recommended: with the configuration above, the bot binds strictly to local loopback `127.0.0.1:3000` (`host` defaults to `MINI_APP_DEFAULT_HOST`; `port` matches `mini_app.port`) without opening inbound firewall ports or managing TLS certificates manually, while `cloudflared` maintains an outbound encrypted tunnel forwarding `https://app.example.com` to `http://localhost:3000`.

### Install `cloudflared`

```shell
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
rm -f cloudflared.deb
```

### Log In and Configure Domain Routing

```shell
# 1. Log in and authorize (opens a browser to select your Cloudflare zone and writes cert.pem)
cloudflared tunnel login

# 2. Create a tunnel named my-app (writes the credential JSON file and prints the Tunnel UUID)
cloudflared tunnel create my-app

# 3. Create a CNAME DNS record routing your subdomain to the tunnel
cloudflared tunnel route dns my-app app.example.com

# 4. Test forwarding in the foreground to your local port (e.g. port 3000)
cloudflared tunnel run --url http://localhost:3000 my-app
```

### Configure the Tunnel Service

Once foreground forwarding works, install the tunnel as a persistent systemd service enabled on boot:

```shell
# Look up <Tunnel-UUID>
cloudflared tunnel list
cd ~/.cloudflared
# Create the configuration file
vim config.yml
```

```yaml
tunnel: <Tunnel-UUID>
credentials-file: /root/.cloudflared/<Tunnel-UUID>.json # Note: for a non-root user or macOS, use the matching absolute path (e.g. /home/ubuntu/.cloudflared/...)

ingress:
  - hostname: app.example.com
    service: http://localhost:3000
  - service: http_status:404
```

```shell
# Install as a systemd service (copies ~/.cloudflared/config.yml to /etc/cloudflared/)
sudo cloudflared --config ~/.cloudflared/config.yml service install

# Enable on boot and start immediately
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

### Uninstall the Service and Delete the Tunnel

To stop and remove the tunnel service cleanly:

```shell
sudo cloudflared service uninstall
cloudflared tunnel cleanup <tunnel-name>
cloudflared tunnel delete -f <tunnel-name>
```

---

## Opening the Console and Two-Tier Authentication

### 1. Private-Chat Entry Button

When `mini_app` is configured, startup menu registration automatically attaches `MenuButtonWebApp` (labeled `MINI_APP_BUTTON_TEXT`, i.e. `App`) to the bottom-left corner of the private chat between `SUPER_ADMIN_USER_ID` and the bot. Tap **`App`** in private chat to open the console inside Telegram's WebView.

### 2. Two-Tier Authentication and Lockout Protection

- **Single-page entry and frontend bundle gate (`MINI_APP_REJECT_HTML_PATH` / `MINI_APP_PAGE_GATE_COOKIE_NAME`)**:
  - **HTML entry gate**:
    - Single-page routes (`/` and `/index.html`, plus `${basePath}` aliases) check same-origin headers, lockout state, and SuperAdmin gate credentials—either `X-Telegram-Init-Data` / `Authorization: tma <initData>` headers, or the `MINI_APP_PAGE_GATE_COOKIE_NAME` `HttpOnly; SameSite=Lax` cookie (`; Secure` over HTTPS, valid for `MINI_APP_PAGE_GATE_COOKIE_MAX_AGE_SECONDS` = 45 minutes, HMAC-SHA256 signed with a key derived from `BOT_TOKEN` + `MINI_APP_PAGE_GATE_SECRET_SEED` and bound to `SUPER_ADMIN_USER_ID`).
    - Non-Telegram visits, non-SuperAdmin accounts, invalid credentials, and locked-out requests receive only standalone `packages/mini-app-api-server/resource/reject.html` (`MINI_APP_REJECT_HTML_PATH`, pre-split at `<body>` in `miniAppRejectHtmlHolder` with HTML-escaped diagnostic `data-*` attributes and zero external network requests), never exposing the SPA HTML or bundle chunks.
  - **Bundle chunk gate**: Frontend chunks (`/chunk-*`, matched by `MINI_APP_BUNDLE_ASSET_ROUTE_PATTERN` and materialized on demand in `miniAppBundledAssetsHolder`) enforce the same gate plus cross-site and direct-navigation guards, returning `401`/`403` JSON when unauthorized.
  - **WebView cold-launch handshake**:
    - On cold launch inside Telegram's WebView, `reject.html`'s inline script reads `initData` locally (`window.Telegram.WebApp.initData`, `?tgWebAppData`, `#tgWebAppData`, or `sessionStorage.__telegram__initParams`) and calls `GET ./api/auth/precheck`.
    - A `200` response from `GET /api/auth/precheck` or `POST /api/auth/login` sets/refreshes the gate cookie via `Set-Cookie`, and `reject.html` reloads once (guarded by a 5-second `sessionStorage` loop guard) into the full console; rejected prechecks or invalid gate cookies clear the cookie immediately via `Max-Age=0`.
  - **Per-startup Ed25519 injection & anti-replay**: `startMiniAppServer` generates a fresh non-extractable Web Crypto `Ed25519` signing keypair in main-thread memory on every startup (`ensureMiniAppRuntimeSigningKeyPair`, cleared via `clearMiniAppRuntimeSigningKeyPair` on shutdown). When materializing bundled frontend JS chunks, `handlers/page.ts` substitutes the compile-time placeholder `MINI_APP_SERVER_SIGNING_PUBLIC_KEY_PLACEHOLDER` with that 32-byte raw public key in Base64 and recomputes `ETag`; clients seeing an unreplaced or malformed public key fail closed with `INVALID_HANDSHAKE`.
- **Tier 1 — Header guard and Telegram WebApp `initData` verification**:
  - Every API request runs synchronously through `authorizeMiniAppRequest` (`MiniAppAuthPolicy`), passing `headerGuard` (same-origin check trusting only the exact `https:` origin (scheme, host and port) of the configured `mini_app.url`, or the request URL's own origin when the request URL is loopback, while ignoring `Host` / `X-Forwarded-Host` / `X-Forwarded-Proto`, and credential-header fast path) before verifying the raw Telegram `initData` string (`X-Telegram-Init-Data` or `Authorization: tma <initData>`, capped at `MINI_APP_MAX_INIT_DATA_LENGTH`).
  - The server checks the HMAC-SHA256 signature derived from `BOT_TOKEN` and `MINI_APP_WEB_APP_DATA_SECRET_SEED` (`"WebAppData"`), enforces `MINI_APP_AUTH_MAX_AGE_SECONDS` (45 minutes, extended up to `2 hours + 45 minutes` while an active session exists), and requires `user.id === SUPER_ADMIN_USER_ID`. Any other user is rejected immediately.
- **Tier 2 — Runtime Ed25519 + ephemeral X25519 ECDH handshake, 256-bit temporary session keys, and 45m/2h lifecycle**:
  - **First-screen unlock and 5-session hard cap**: When no authenticator is bound, enter `mini_app.password` to unlock; once Google Authenticator (TOTP) is bound, login requires the current 30-second 6-digit TOTP code (`miniAppLastConsumedTotpStepHolder` records the step only after verification and session issuance succeed to prevent same-step replay). The main thread caches at most `MINI_APP_SESSION_MAX` (`5`) unexpired active sessions and keys; when 5 unexpired sessions are already active, a valid login still succeeds and evicts the session whose issuance or latest rotation is oldest (revoking its download tickets); the evicted client must log in again on its next request.
  - **Ephemeral X25519 ECDH handshake & non-extractable key storage**: When unauthenticated, `GET /api/auth/precheck` issues an ephemeral `X25519` offer (`handshakeId`, `serverPublicKey`, `expiresAt`, FIFO cap `MINI_APP_HANDSHAKE_MAX` = 16, TTL `MINI_APP_HANDSHAKE_TTL_MS` = 5 minutes) signed with the per-startup `Ed25519` private key and sets/refreshes `MINI_APP_PAGE_GATE_COOKIE_NAME`; on an already-unlocked session, precheck returns read-only status (`sessionValid`, `sessionExpiresAt`) without rotating tokens or issuing keys. The client verifies the injected `Ed25519` public key (triggering a single `location.reload()` guarded by a 10-second `sessionStorage` window on `signatureMismatch`, or mapping missing Web Crypto / `NotSupportedError` to `WEBCRYPTO_UNSUPPORTED` without reloading), generates an ephemeral `X25519` keypair, derives direction-separated `c2sKey` / `s2cKey` via `ECDH + HKDF-SHA256` (`salt` = raw `handshakeId` bytes, `info` bound to `c2s`/`s2c` direction and both ephemeral public keys), and encrypts `{ handshakeId, password }` or `{ handshakeId, totpCode }` under `c2sKey` (`MINI_APP_LOGIN_REQUEST_AAD`) to `POST /api/auth/login`. `miniAppInFlightHandshakeIds` blocks concurrent replay and `handshakeId` is destroyed immediately on consumption/failure; `200`/`403` responses are encrypted under `s2cKey` (`MINI_APP_LOGIN_RESPONSE_AAD`, plaintext success and credential-verdict downgrades rejected), directly returning 45-minute `sessionToken` (`X-Mini-App-Session`) and 256-bit `sessionKey` (`MINI_APP_SESSION_KEY_BITS`) while clearing `pendingSessionKey` immediately after serialization. `sessionKey` is issued **only** on `POST /api/auth/login` and on sliding renewal of encrypted-response business routes; the client persists the token and its non-extractable `CryptoKey` as a same-generation `{ token, cryptoKey }` pair in IndexedDB plus `{ token, expiresAt }` metadata in `sessionStorage` (rejecting `localStorage` and `globalThis` globals; hydration trusts the IndexedDB pair, restores the previous pair and rewrites the metadata when `sessionStorage` already holds a newer token whose key was not yet persisted, and wipes both if either is missing or malformed) and **never** transmits `sessionKey`. Failed prechecks clear only the sent token, and tapping "Lock" clears local storage and calls `POST /api/auth/logout` asynchronously to revoke the session, key, and bound download tickets.
  - **Randomized cooldown sliding rotation, 2-hour max lifetime, and immediate supersession invalidation**: Total sliding-renewal lifetime per login is capped at `MINI_APP_SESSION_MAX_LIFETIME_MS` (2 hours). Each issued or rotated session samples a uniform cooldown in `[MINI_APP_SESSION_REFRESH_MIN_MS, MINI_APP_SESSION_REFRESH_MAX_MS]` (5s–5min); once elapsed—or whenever `seenRequestIvs.size` reaches `MINI_APP_SESSION_ROTATE_AT_SEEN_IVS` (3,072) first—any encrypted-response business request still inside the 45-minute TTL and 2-hour cap rotates both `sessionToken` and `sessionKey` in place, resets the new epoch's `seenRequestIvs` and re-samples the cooldown, and extends expiry by 45 minutes, returning `X-Mini-App-Session` (`newToken`), `X-Mini-App-Session-Expires-At`, and `X-Mini-App-Session-Key` (`<ivBase64>.<cipherBase64>` sealed via AES-256-GCM under the request's matched key with `additionalData = UTF8(newToken)`). Concurrent frontend requests snapshot `(sentSessionToken, cryptoKeyAtSend)` and only commit rotated credentials when the local active token still matches `sentSessionToken`. Superseded `previousToken` / `previousCryptoKey` remain valid for an independent 5-minute grace window (`MINI_APP_SESSION_PREVIOUS_GRACE_MS`) solely for concurrent in-flight requests and are **immediately invalidated** upon the first committed request authenticated with `newToken` (or cleared on logout, TOTP change, or lockout). On rotation commit the server synchronously starts a shared `sealedSessionKeyPromise` (resolving solely to the sealed ciphertext without writing `pendingSessionKey`), records the settled ciphertext in `sealedSessionKey`, and keeps it until the new token is confirmed or the grace window expires; until then, encrypted-response requests carrying `previousToken` do not rotate again, instead awaiting that same `sealedSessionKeyPromise` or reading `sealedSessionKey` to re-attach the same new token and the same `X-Mini-App-Session-Key` ciphertext so a client that lost the rotation response can still catch up.
- **AES-256-GCM encrypted transport (`MiniAppEncryptedEnvelope`, binary upload frames, `?e=`), atomic commit, and exemptions**:
  - **End-to-end JSON, binary uploads, `?e=` URL queries, and two-phase commit**: Session-authenticated business JSON routes wrap payloads with 256-bit `sessionKey` (`AES-GCM`, `12`-byte IV `MINI_APP_AES_GCM_IV_BYTES`, `128`-bit tag `MINI_APP_AES_GCM_TAG_BITS`) in `{ encrypted: true, iv, payload }` envelopes (default cap `MINI_APP_MAX_ENCRYPTED_JSON_BODY_BYTES` = `64 KiB`, `4 MiB` on `POST /api/configs/save`), and `POST /api/gallery/upload` wraps uploads in `[12B IV || ciphertext+16B tag]` raw binary frames (`MINI_APP_MAX_UPLOAD_BODY_BYTES` = `11 MiB`), all bound via `buildMiniAppEnvelopeAad` to `"${method} ${routePath}:req"` / `":res"`; non-`GET`/`HEAD` encrypted routes reject `0`-byte bodies. Every `encryptRequest: true` route encrypts non-empty query strings into `?e=<ivBase64>.<cipherBase64>` (`MINI_APP_ENCRYPTED_QUERY_PARAM`, ciphertext cap `MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH` = `4096`) allowing only a single `e` parameter with AEAD `additionalData = "${method} ${routePath}"`. Bare `?`, plaintext/duplicate/unauthorized query params, empty or `?`-prefixed decrypted queries, invalid envelopes/frames, and replayed IVs return `400 INVALID_ENCRYPTED_PAYLOAD` (`seenRequestIvs` triggers proactive rotation at `MINI_APP_SESSION_ROTATE_AT_SEEN_IVS` = `3_072` on encrypted-response routes, resetting the IV set and refresh cooldown, while exceeding the `MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS` = `4_096` hard cap revokes with `401 SESSION_EXPIRED`); two-phase commit (`authorizeMiniAppRequest` -> async decrypt -> `commitMiniAppSessionAccess`) prevents async-decrypt TOCTOU races and preserves `previousToken` on `400` failures (when a request's token is rotated and confirmed by concurrent requests during its decrypt window, the commit locates the live session by its login-stable `lineageId` and commits on the key epoch observed at lookup without rotating), while the client decrypts and validates encrypted responses before adopting rotation headers, rejects plaintext `2xx` business responses, and blocks encrypted JSON, query, and binary-upload requests before sending whenever the local session token or key is missing, requiring a fresh unlock. Across all pages, config editor actions, multi-file uploads, picker polling, gallery previews, and background pollers, `packages/mini-app-frontend/api/authError.ts` classifies transport auth failures using a private `Symbol`-tagged `sentSessionToken` context: session expiration or key revocation/decryption errors (`MINI_APP_SESSION_REAUTH_ERROR_CODES` or bare HTTP `401`) clear matching credentials and redirect to `AuthGatePage`, while Tier-1 gateway, lockout, or WebCrypto rejections (`MINI_APP_ACCESS_DENIED_ERROR_CODES`) unconditionally clear credentials—except the session-extended `MINI_APP_EXPIRED_AUTH_DATE_CODE` (`EXPIRED_AUTH_DATE`), which guards against stale-token clears—and re-precheck through `checking` into `AccessDeniedPage`; stale-token re-auth and `EXPIRED_AUTH_DATE` responses from superseded tokens are suppressed across transport, global `notify()` toasts, and config-editor error banners so newer active sessions are neither cleared, locked, nor shown false expiry alerts, while current-session redirects are never swallowed by stale-request guards or downgraded back to `password` by trailing `401`s.
  - **Download dual paths & exemptions**: `/api/auth/precheck`, `/api/auth/logout`, SPA/bundle/probe routes (`/`, `/index.html`, `reject.html`, `/chunk-*`, `/favicon.ico`, `/healthz`) stay unencrypted, and `POST /api/auth/login` uses ephemeral ECDH (`c2sKey`/`s2cKey`); among session-authenticated `/api/*` routes, `encryptResponse: false` (no session key rotation) applies strictly to `GET|HEAD /api/gallery/file` (`header` + `?e=`) and `GET|HEAD /api/gallery/download` (browser fallback using headers + `?e=` + `blob:` save; Telegram native `WebApp.downloadFile` using 60s single-use 64-hex `?ticket=` from encrypted `POST /api/gallery/download-ticket`, cap 64, non-consuming on `HEAD`, single-consume on `GET`, bound to `sessionLineageId` so tickets stay valid across session rotations and are revoked immediately by lineage on logout/lockout/expiry/eviction/IV-cap/TOTP-change/delete). `POST /api/gallery/upload` encrypts both its binary request frame and its JSON response under `sessionKey`, and image deletion runs exclusively via encrypted `POST /api/gallery/delete` (`{ fileName }`).
- **Brute-force lockout**:
  - `MINI_APP_PASSWORD_MAX_ATTEMPTS` (3) consecutive failed password or TOTP attempts lock out `SUPER_ADMIN_USER_ID` for `MINI_APP_PASSWORD_LOCKOUT_MS` (30 minutes), clearing all active sessions, session keys, pending handshakes, and download tickets and expiring the gate cookie via `Max-Age=0` (rejecting single-page and chunk requests throughout the lockout).
  - Concurrent login requests still in flight when lockout begins count as failures without checking credentials and extend the lockout to 30 minutes from that moment.
  - Entering lockout sends one private-chat alert with unlock time and source IP (lockout extensions do not resend).

### 3. Binding Google Authenticator (TOTP) (Recommended)

After signing in with `mini_app.password`, bind a Google Authenticator 2FA secret under the **Authenticator** tab:

1. Open the **Authenticator** tab to generate a pending Base32 secret and QR code (held in main-thread memory for `MINI_APP_TOTP_PENDING_TTL_MS` = 10 minutes, and discarded after `MINI_APP_PASSWORD_MAX_ATTEMPTS` failed verification attempts).
2. Scan the QR code in Google Authenticator or any RFC 6238 app (or enter the 32-character Base32 secret manually) and submit the 6-digit code (`MINI_APP_TOTP_DIGITS`) for the current 30-second step (`MINI_APP_TOTP_STEP_SECONDS`).
3. Once verified, bind, replacement, and deletion operations execute serially through `runSerialChain` over `miniAppTotpMutationChainHolder` (keeping `totp.json` and main-thread memory state strictly ordered): the secret is written atomically (`0o600` mode) to `memory/mini-app-totp/totp.json` (schema version `MINI_APP_TOTP_RECORD_VERSION`) under the runtime data root. Subsequent logins require the current 30-second 6-digit TOTP code instead of `mini_app.password`. Enabling, replacing, or deleting the authenticator automatically revokes every other active session and its keys except the caller's current session; deleting it reverts login to `mini_app.password`.

### 4. Content Blacklist ("Content Blacklist" Tab)

In the sidebar right below **Access Control** and above **Config Editor**, the **Content Blacklist** tab (navigation key `adBlacklists`, with its ban SVG icon shown exclusively in the navigation menu; implemented in `packages/mini-app-frontend/pages/AdBlacklistsPage.tsx`, backed by session-encrypted `GET|POST /api/ad-blacklists` and `GET /api/ad-blacklists/preview` under `MINI_APP_API_AUTH_POLICY`) manages global sticker and custom emoji pack blacklists stored in SQLite `ad_pack_blacklists`:

- **Dual subtabs and cold-read isolation**: Displays **Sticker Packs** (`sticker`) and **Emoji Packs** (`emoji`) subtabs (without per-tab count badges or an in-page ban icon above the search bar; totals are shown in the bottom pagination bar). Pagination and search cold-read SQLite cursors without polluting the 768-entry main-thread ad pack blacklist LRU cache, and no per-kind entry cap is imposed.
- **Search, collapsible add input (with Telegram share-link routing), and pagination**: Pairs a `MINI_APP_SEARCH_DEBOUNCE_MS` (0.5 s) debounced case-insensitive substring search bar (capped at `MINI_APP_AD_BLACKLIST_QUERY_MAX_LENGTH` = 128 chars; changing the query resets both kinds to page 1) with a toggle button that expands/collapses the add form via `CollapseGrid` pull-down/pull-up animation (collapsed by default, collapsing automatically after a successful add). `parseAdBlacklistPackInput` accepts plain short names (using the active subtab kind), Telegram web share links (`addstickers/<pack>` or `addemoji/<pack>` under `t.me`, `telegram.me`, or `telegram.dog` with optional `http(s)://` scheme and trailing slash), and native deep links (`tg://addstickers?set=<pack>` or `tg://addemoji?set=<pack>`), preserving original case, routing links automatically to `"sticker"` or `"emoji"`, and switching to the target subtab with a single refresh upon actual cross-tab mutation. Pagination aligns with all other paginated tabs (default `MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE` = 10, selectable via `MINI_APP_AD_BLACKLIST_PAGE_SIZE_OPTIONS` = `10 / 15 / 20`, server cap `MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE` = 20).
- **In-app pack preview modal (`AdBlacklistPreviewModal`)**: Clicking a pack button opens an in-app preview modal powered by session-encrypted `GET /api/ad-blacklists/preview` in two phases—phase 1 queries `metaOnly=1` (showing a compact `LoadingDotsWave`) to confirm pack title, sticker type, total item count, and per-item `hasImage` flags; phase 2 renders the exact number of tiles (`GalleryImageSkeleton` on `hasImage` tiles, immediate Emoji placeholders plus `TGS`/`WEBM` badges on non-image tiles) and hydrates thumbnails in place (`metaOnly=0`). Larger packs append exact remaining skeleton tiles on **Load more** (`MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE` = 16 items per page). The modal footer provides clipboard link copying and optional handoff via `Telegram.WebApp.openTelegramLink` (falling back to `window.open` outside Telegram); closing the modal, switching subtabs, or leaving the page immediately aborts in-flight preview requests.
- **Validation, confirmed removal, and audit logging**: The add form pre-validates short names and Telegram pack links against `STICKER_PACK_NAME_PATTERN` (`1–64` `[A-Za-z0-9_]`), while the server validates parameters (`400 INVALID_AD_BLACKLIST_PARAMS` / `INVALID_AD_BLACKLIST_PACK`), blocks the bot's own packs configured in `config/dynamic/stickers.json` (`409 AD_BLACKLIST_BOT_OWN_PACK`), and flags duplicates (`200 AD_BLACKLIST_DUPLICATE` with an inline notice banner). Removal requires a danger confirmation modal; mutations update the main-thread 768-entry LRU cache and counts, sync updated counts to the Anti-Raid Worker, await SQLite `"adPackBlacklist"` persistence confirmation (`503 AD_BLACKLIST_STORAGE_UNAVAILABLE` if unavailable or unconfirmed), and record `logger.operation("[MiniApp] adBlacklists.mutate", ...)`.

### 5. Online JSON Configuration Editor ("Config Editor" Tab)

Placed below **Content Blacklist**, the **Config Editor** tab (`ConfigsPage`, backed by `/api/configs/*`) provides syntax-highlighted inspection, editing, and validated saving for managed deployment JSON files:

- **Managed file allowlists**: Matches `packages/config/layout.ts` strictly across **Dynamic** (`config/dynamic/`: `ad_detect.json`, `agent.json`, `assets.json`, `cron.json`, `mood.json`, `stickers.json`) and **Static** (`config/static/`: `bot.json`, `g-auth.json`). The file dropdown displays `MINI_APP_CONFIG_SELECTOR_VISIBLE_OPTIONS` (3) items per viewport with a vertical parallelogram scrollbar; the editor provides vertical/horizontal parallelogram scrollbars, line numbers, JSON token highlighting, formatting, 1-based line/column syntax diagnostics, and direct creation of missing optional files. Only **Format** is shown when unmodified (matching the single-button footer placeholder in `ConfigEditorSkeleton`), while **Discard** and **Save** reveal when edits appear and play `MINI_APP_MIN_LOADING_MS` skeleton transitions only on reveal and on passive hiding from draft deletion/reversion or formatting back to baseline; tapping **Format**, **Discard**, or **Save** (including post-save service restart) plays the electric-glint 3-dots wave busy animation on the active button, and discard, save, or restart completion exits cleanly without a skeleton flash.
- **Direct session-encrypted saving**: Tapping **Save** submits `{ scope, fileName, content }` directly inside the active session `sessionKey` AES-256-GCM envelope to `POST /api/configs/save` (outer body cap `MINI_APP_MAX_CONFIG_BODY_BYTES` = `4 MiB`, UTF-8 plaintext cap `MINI_APP_MAX_CONFIG_CONTENT_BYTES` = `2 MiB`).
- **Strict validation and atomic write**: `saveMiniAppConfigFile` runs validation and atomic writes serially through `runSerialChain` over the main-thread holder `deploymentConfigWriteChainHolder` (`packages/cache/main/configWrite.ts`) to eliminate cross-file validation TOCTOU races (`agent.json` ↔ `cron.json`). It enforces target allowlists (`INVALID_CONFIG_TARGET`), JSON syntax (`INVALID_JSON_SYNTAX`), and strict domain parsers (`CONFIG_VALIDATION_FAILED`, with `g-auth.json` sharing startup's `parseGoogleServiceAccountKey`: required `client_email`, parseable RSA PEM `private_key`, optional `type: "service_account"`, optional trimmed non-empty `private_key_id`/`project_id`/`quota_project_id`/`universe_domain`, preserving all other fields unchanged), plus `bot.json` `time_zone` immutability when `database/storage.sqlite` exists, bidirectional `agent.json` ↔ `cron.json` capability checks (preferring the latest on-disk counterpart), and regular-file/non-symlink checks (`inspectOptionalFile`). Validated text is written via `atomicWriteText` (preserving existing file modes, or `MINI_APP_CONFIG_DEFAULT_FILE_MODE` = `0o600` for newly created optional files).
- **Dynamic hot reload vs. static restart confirmation**: Dynamic saves under `config/dynamic/` trigger the `fs.watch` hot-reload coordinator automatically; static saves (`bot.json`, `g-auth.json`, `requiresRestart: true`) open a confirmation modal (**"Not Now"** / **"Run Now"**), where confirming calls `POST /api/configs/restart` to execute `systemctl restart --no-block copy-ninjia` (`MINI_APP_SERVICE_RESTART_COMMAND`, timeout `MINI_APP_SERVICE_RESTART_TIMEOUT_MS` = 5 s).

---

## Verification and Operational Notes

- **Startup log check**: Confirm that startup logs print `Mini App HTTP server listening on http://127.0.0.1:3000 (public URL: https://app.example.com/).` and that `cloudflared` reports `active (running)`.
- **Edge caching and security headers**:
  - **Dynamic HTML and JSON APIs**: `index.html`, `reject.html`, and all `/api/*` JSON responses carry `MINI_APP_NO_STORE_CACHE_CONTROL` (`no-store, no-cache, must-revalidate, max-age=0`), `CDN-Cache-Control: no-store`, and `Cloudflare-CDN-Cache-Control: no-store` so Cloudflare edge nodes and browsers never cache live state.
  - **Gated frontend bundle chunks**: Authorized `/chunk-*` responses carry `MINI_APP_BUNDLE_CACHE_CONTROL` (`private, no-cache, must-revalidate`), `CDN-Cache-Control: no-store`, `Cloudflare-CDN-Cache-Control: no-store`, `Vary: Cookie, X-Telegram-Init-Data, Authorization` (`MINI_APP_BUNDLE_VARY_HEADER_VALUE`), and `ETag` `304` revalidation—preventing public CDN caching while re-checking the SuperAdmin gate and lockout state on reuse.
  - **Protected gallery previews (`GET|HEAD /api/gallery/file`, `serveGalleryFileResponse`)**: Authenticated with SuperAdmin `initData` headers, `X-Mini-App-Session`, and encrypted `?e=` (forbidding query credentials), responses send 7-day `MINI_APP_GALLERY_FILE_CACHE_CONTROL` (`private, no-cache, max-age=604800, must-revalidate`), `CDN-Cache-Control: no-store`, `Cloudflare-CDN-Cache-Control: no-store`, `Vary: MINI_APP_GALLERY_FILE_VARY_HEADER_VALUE` (`X-Telegram-Init-Data, Authorization, X-Mini-App-Session`), strong `ETag` (derived from `sizeBytes` + `mtimeMs`, supporting weak/multi-value `If-None-Match` `304` and `HEAD`), and security headers; the frontend maintains filename-keyed binary `Blob` + `ETag` entries in `galleryImageCache.ts` across browser `CacheStorage` (bucket `MINI_APP_GALLERY_CACHE_NAME`, 7-day TTL `MINI_APP_GALLERY_CACHE_TTL_MS`) and a bounded in-memory map, revalidating with `cache: "no-store"` + `If-None-Match` via `fetchMiniAppGalleryImageObjectUrl` / `useGalleryImageUrls` to materialize `304` hits into in-memory `blob:` URLs (evicting immediately on delete/`404` and hard-expiring after 7 days). `GET|HEAD /api/gallery/download` streams attachments with `no-store` (via header + `?e=` fallback or 60-second single-use `?ticket=` native handoff).
  - **Public static icon (`/favicon.ico`, `serveCachedAssetResponse`)**: Returns `MINI_APP_ASSET_CACHE_CONTROL` (`public, max-age=604800, s-maxage=604800, immutable`, 7-day persistent cache), `ETag` `304` revalidation (weak tags and multi-value `If-None-Match`), `HEAD` support, and security headers.
  - **Universal security headers**: Every response includes `MINI_APP_CSP_HEADER_VALUE` (permitting only `'self'`, `https://telegram.org`, and the static SHA-256 hashes of `index.html` and `reject.html` inline scripts) and `X-Frame-Options: DENY`.
- **Online config editing and service restart permissions**: `config/` stays read-only by default; enabling online config saves requires granting the service user write, temp-file creation, and atomic `rename` permissions on `config/dynamic/` and/or `config/static/`. Online static-config restart invokes `systemctl restart --no-block copy-ninjia` (matching `copy-ninjia.service` registered by `install.sh`, so non-`root` deployments using online restart only need polkit authorization permitting the service user to restart `copy-ninjia.service`).
- **Backing up persisted TOTP state**: When TOTP is bound, include `memory/mini-app-totp/totp.json` in data-root backups. Both service startup and `install.sh` preflight validate this file strictly (a missing file means unbound; non-regular files or malformed contents refuse startup—see [07 Operations](07-operations.md) and [04 Runtime Invariants](04-invariants.md)).

---

<div align="center">

[← Prev: 09 Command Reference](09-commands.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#10-mini-app-setup-and-recommended-configuration) · [Next: 11 Performance Benchmark →](11-performance.md)

</div>
