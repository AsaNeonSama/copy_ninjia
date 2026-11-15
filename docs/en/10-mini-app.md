# 10 Mini App Setup and Recommended Configuration

<p align="center">
  <a href="../cn/10-mini-app.md">简体中文</a> · <b>English</b> · <a href="../ja/10-mini-app.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="09-commands.md">← Prev: 09 Command Reference</a> · <a href="11-performance.md">Next: 11 Performance Benchmark →</a>
</p>

---

This guide explains how to enable the SuperAdmin-exclusive Telegram Mini App management console in `config/static/bot.json`, expose the local HTTP server as a public HTTPS endpoint via Cloudflare Tunnel (`cloudflared`), and sign in with two-tier authentication (password or Google Authenticator TOTP). For full JSON field schemas, see the [Deployment Configuration Guide](../../config_example/README/en.md#botjson); for HTTP API routes and permission guards, see [09 Command Reference](09-commands.md#mini-app-console).

## Configure `bot.json` to Enable the Mini App

Add the optional `mini_app` object to `config/static/bot.json`:

```json
{
  "bot_token": "replace-with-telegram-bot-token",
  "super_admin_user_id": 123456789,
  "atmosphere": "mesugaki",
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
| `host` | Optional | Local `Bun.serve` HTTP bind address, defaulting to `MINI_APP_DEFAULT_HOST` (`"127.0.0.1"`); binds to loopback only so no inbound firewall port needs to be exposed |
| `password` | **Required** | First-screen access password; must be a non-empty string containing at least 6 digits (`0-9`, matching `MINI_APP_PASSWORD_AT_LEAST_SIX_DIGITS_PATTERN`) and must not remain `MINI_APP_PASSWORD_PLACEHOLDER` (`"replace-with-mini-app-password"`) |

- **Optional activation**:
  - Omitting the entire `mini_app` section disables the local `Bun.serve` server, skips route registration, and omits `MenuButtonWebApp` from private chat.
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
- **Tier 1 — Header guard and Telegram WebApp `initData` verification**:
  - Every API request runs synchronously through `authorizeMiniAppRequest` (`MiniAppAuthPolicy`), passing `headerGuard` (same-origin and credential-header fast path, extracting `initData` once) before verifying the raw Telegram `initData` string (`X-Telegram-Init-Data` or `Authorization: tma <initData>`, capped at `MINI_APP_MAX_INIT_DATA_LENGTH`).
  - The server checks the HMAC-SHA256 signature derived from `BOT_TOKEN` and `MINI_APP_WEB_APP_DATA_SECRET_SEED` (`"WebAppData"`), enforces the `MINI_APP_AUTH_MAX_AGE_SECONDS` (45-minute) freshness window, and requires `user.id === SUPER_ADMIN_USER_ID`. Any other user is rejected immediately.
- **Tier 2 — First-screen credential and 45-minute session renewal**:
  - **First-screen unlock**: When no authenticator is bound, enter `mini_app.password` to unlock; once Google Authenticator (TOTP) is bound, login requires the current 30-second 6-digit TOTP code instead of `mini_app.password`.
  - **Session persistence and lock**:
    - Login issues a 45-minute `sessionToken` (`MINI_APP_SESSION_TTL_MS`, sent in `X-Mini-App-Session`) and a deterministic gallery `assetToken` while refreshing the gate cookie.
    - The client stores the session in Web Storage and resumes via `GET /api/auth/precheck` across refreshes/reopens within 45 minutes, converting server expiry timestamps into local clock time via the response `Date` header for auto-lock.
    - Failed prechecks clear only the token sent with that request (preserving any newer token written while in flight); tapping "Lock" clears storage and fires `POST /api/auth/logout` asynchronously.
  - **Sliding token rotation**: Requests carrying a valid token older than `MINI_APP_SESSION_REFRESH_THRESHOLD_MS` (5 minutes) automatically rotate the token and extend expiry by 45 minutes (via `X-Mini-App-Session` / `X-Mini-App-Session-Expires-At` headers and `/api/auth/precheck`'s body, continuing to accept the static `initData.auth_date`). Previous tokens remain valid for 5 minutes for concurrent requests, up to `MINI_APP_SESSION_MAX` (8) active sessions in memory.
- **Brute-force lockout**:
  - `MINI_APP_PASSWORD_MAX_ATTEMPTS` (3) consecutive failed password or TOTP attempts lock out `SUPER_ADMIN_USER_ID` for `MINI_APP_PASSWORD_LOCKOUT_MS` (30 minutes), clearing all active sessions and expiring the gate cookie via `Max-Age=0` (rejecting single-page and chunk requests throughout the lockout).
  - Concurrent login requests still in flight when lockout begins count as failures without checking credentials and extend the lockout to 30 minutes from that moment.
  - Entering lockout sends one private-chat alert with unlock time and source IP (lockout extensions do not resend).

### 3. Binding Google Authenticator (TOTP) (Recommended)

After signing in with `mini_app.password`, bind a Google Authenticator 2FA secret under the **Authenticator** tab:

1. Open the **Authenticator** tab to generate a pending Base32 secret and QR code (held in main-thread memory for `MINI_APP_TOTP_PENDING_TTL_MS` = 10 minutes, and discarded after `MINI_APP_PASSWORD_MAX_ATTEMPTS` failed verification attempts).
2. Scan the QR code in Google Authenticator or any RFC 6238 app (or enter the 32-character Base32 secret manually) and submit the 6-digit code (`MINI_APP_TOTP_DIGITS`) for the current 30-second step (`MINI_APP_TOTP_STEP_SECONDS`).
3. Once verified, the secret is written atomically (`0o600` mode) to `memory/mini-app-totp/totp.json` (schema version `MINI_APP_TOTP_RECORD_VERSION`) under the runtime data root. Subsequent logins require the current 30-second 6-digit TOTP code instead of `mini_app.password`. Enabling, replacing, or deleting the authenticator automatically revokes every other active session except the caller's current session; deleting it reverts login to `mini_app.password`.

---

## Verification and Operational Notes

- **Startup log check**: Confirm that startup logs print `Mini App HTTP server listening on http://127.0.0.1:3000 (public URL: https://app.example.com/).` and that `cloudflared` reports `active (running)`.
- **Edge caching and security headers**:
  - **Dynamic HTML and JSON APIs**: `index.html`, `reject.html`, and all `/api/*` JSON responses carry `MINI_APP_NO_STORE_CACHE_CONTROL` (`no-store, no-cache, must-revalidate, max-age=0`), `CDN-Cache-Control: no-store`, and `Cloudflare-CDN-Cache-Control: no-store` so Cloudflare edge nodes and browsers never cache live state.
  - **Gated frontend bundle chunks**: Authorized `/chunk-*` responses carry `MINI_APP_BUNDLE_CACHE_CONTROL` (`private, no-cache, must-revalidate`), `CDN-Cache-Control: no-store`, `Cloudflare-CDN-Cache-Control: no-store`, `Vary: Cookie, X-Telegram-Init-Data, Authorization` (`MINI_APP_BUNDLE_VARY_HEADER_VALUE`), and `ETag` `304` revalidation—preventing public CDN caching while re-checking the SuperAdmin gate and lockout state on reuse.
  - **Gallery previews and static icon**: `assetToken`-authenticated gallery previews (`ETag` derived from `sizeBytes` + `mtimeMs`) and `/favicon.ico` return `MINI_APP_ASSET_CACHE_CONTROL` (7-day immutable cache) with `ETag` `304` revalidation supporting weak tags and multi-value `If-None-Match`.
  - **Universal security headers**: Every response includes `MINI_APP_CSP_HEADER_VALUE` (permitting only `'self'`, `https://telegram.org`, and the static SHA-256 hashes of `index.html` and `reject.html` inline scripts) and `X-Frame-Options: DENY`.
- **Backing up persisted TOTP state**: When TOTP is bound, include `memory/mini-app-totp/totp.json` in data-root backups. Both service startup and `install.sh` preflight validate this file strictly (a missing file means unbound; non-regular files or malformed contents refuse startup—see [07 Operations](07-operations.md) and [04 Runtime Invariants](04-invariants.md)).

---

<div align="center">

[← Prev: 09 Command Reference](09-commands.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#10-mini-app-setup-and-recommended-configuration) · [Next: 11 Performance Benchmark →](11-performance.md)

</div>
