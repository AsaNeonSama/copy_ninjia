# 10 Mini App Setup and Recommended Configuration

<p align="center">
  <a href="../cn/10-mini-app.md">简体中文</a> · <b>English</b> · <a href="../ja/10-mini-app.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="09-commands.md">← Prev: 09 Command Reference</a> · <a href="11-performance.md">Next: 11 Performance Benchmark →</a>
</p>

---

This guide explains how to enable the SuperAdmin-exclusive Telegram Mini App management console in `config/static/bot.json`, expose the local HTTP server as a public HTTPS endpoint using the recommended Cloudflare Tunnel (`cloudflared`) setup, and access the console with two-tier authentication (password / Google Authenticator TOTP). For complete JSON field definitions, see the [Deployment Configuration Guide](../../config_example/README/en.md#botjson). For HTTP API routes and permission boundaries, see [09 Command Reference](09-commands.md#mini-app-console).

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
| `url` | **Required** | Public `https://` URL opened by the Telegram WebApp client; supports subpath prefixes (e.g. `https://app.example.com/sub`) and works with reverse proxies that either preserve or strip the path prefix |
| `port` | **Required** | Local `Bun.serve` HTTP listening port; safe integer in `MINI_APP_PORT_MIN`–`MINI_APP_PORT_MAX` (`1`–`65535`), recommended `3000` to match the tunnel target port |
| `host` | Optional | Local `Bun.serve` HTTP listening address, defaulting to `MINI_APP_DEFAULT_HOST` (`"127.0.0.1"`); binds to loopback only so no inbound firewall port needs to be exposed |
| `password` | **Required** | First-screen access password; must be a non-empty string containing at least 6 digits (`0-9`, matching `MINI_APP_PASSWORD_AT_LEAST_SIX_DIGITS_PATTERN`) and must not remain the placeholder `MINI_APP_PASSWORD_PLACEHOLDER` (`"replace-with-mini-app-password"`) |

- **Optional activation**: When `mini_app` is omitted, no local `Bun.serve` HTTP server or routes are started and `MenuButtonWebApp` is not registered in private chat. When copying `config_example/static/bot.json` manually without using the Mini App, remove the `mini_app` section (leaving the placeholder password refuses startup; the `install.sh` wizard automatically strips a placeholder `mini_app` section and preserves an already-configured `mini_app` section on subsequent runs).
- **Restart required**: `config/static/bot.json` is a static configuration file; restart the bot service after modifying `mini_app`.

---

## Recommended Setup: Using Cloudflare Tunnel

Telegram Mini Apps require a public `https://` URL. **Cloudflare Tunnel (`cloudflared`)** is recommended: with the configuration above, the bot listens only on local loopback `127.0.0.1:3000` (`host` defaults to `MINI_APP_DEFAULT_HOST`; `port` comes from the configuration) without opening inbound firewall ports or managing TLS certificates manually, while `cloudflared` establishes an outbound encrypted tunnel that routes traffic from your subdomain (e.g. `https://app.example.com`) to `http://localhost:3000`.

### Install `cloudflared`

```shell
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
rm -f cloudflared.deb
```

### Log In and Configure Domain Routing

```shell
# 1. Log in and authorize (opens a browser to select the Cloudflare domain and generates cert.pem)
cloudflared tunnel login

# 2. Create a tunnel named my-app (generates the credential JSON file and Tunnel UUID)
cloudflared tunnel create my-app

# 3. Automatically add a CNAME DNS route from your subdomain to the tunnel
cloudflared tunnel route dns my-app app.example.com

# 4. Forward traffic from the subdomain to the local port (e.g. port 3000) and run in foreground
cloudflared tunnel run --url http://localhost:3000 my-app
```

### Configure the Tunnel Service

After verifying foreground forwarding, install the tunnel configuration as a managed systemd service and enable it on boot:

```shell
# Retrieve <Tunnel-UUID>
cloudflared tunnel list
cd ~/.cloudflared
# Edit the configuration file
vim config.yml
```

```yaml
tunnel: <Tunnel-UUID>
credentials-file: /root/.cloudflared/<Tunnel-UUID>.json # Note: for a non-root user or macOS, replace with the corresponding absolute path (e.g. /home/ubuntu/.cloudflared/...)

ingress:
  - hostname: app.example.com
    service: http://localhost:3000
  - service: http_status:404
```

```shell
# Start the service
# Install the configuration as a systemd service (automatically copies ~/.cloudflared/config.yml to /etc/cloudflared/)
sudo cloudflared --config ~/.cloudflared/config.yml service install

# Enable on boot and start immediately
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

### Uninstall the Service and Delete the Tunnel

To remove the systemd service and delete the tunnel:

```shell
sudo cloudflared service uninstall
cloudflared tunnel cleanup <tunnel-name>
cloudflared tunnel delete -f <tunnel-name>
```

---

## Opening the Console and Two-Tier Authentication

### 1. Private-Chat Entry Button

When `mini_app` is configured and the bot starts, command menu registration automatically attaches `MenuButtonWebApp` (with label `MINI_APP_BUTTON_TEXT`, i.e. `App`) to the bottom-left corner of the private chat between `SUPER_ADMIN_USER_ID` and the bot. Tap **`App`** in private chat to launch the management console inside Telegram's WebView.

### 2. Two-Tier Authentication and Lockout Protection

- **Tier 1 (Request header guard and Telegram WebApp `initData` signature verification)**: Every API request first passes fast-path same-origin and credential header shape checks (`headerGuard`), then carries the raw `initData` query string issued by Telegram via `X-Telegram-Init-Data` (or `Authorization: tma <initData>`, bounded by `MINI_APP_MAX_INIT_DATA_LENGTH`). The server verifies the HMAC-SHA256 signature derived from `BOT_TOKEN` and `MINI_APP_WEB_APP_DATA_SECRET_SEED` (`"WebAppData"`), enforces the `MINI_APP_AUTH_MAX_AGE_SECONDS` (45-minute) freshness window, and checks `user.id === SUPER_ADMIN_USER_ID`. Any non-SuperAdmin user is rejected immediately.
- **Tier 2 (First-screen credential and 45-minute session renewal)**:
  - When no authenticator is bound, enter `mini_app.password` on the first screen to unlock;
  - Upon login, the server issues a `sessionToken` (`X-Mini-App-Session`) valid for `MINI_APP_SESSION_TTL_MS` (45 minutes) along with a deterministic gallery `assetToken`, which the client persists in Web Storage and verifies on `GET /api/auth/precheck` so refreshing or reopening within 45 minutes resumes without re-entering credentials, and clears immediately on expiration or manual lock; tapping "Lock" in the top bar also asks the server to revoke that session via `POST /api/auth/logout` (without waiting for the result). The client converts the session expiry returned by the server into local time using the response `Date` header before using it for expiry checks and automatic locking;
  - When a request carries a valid session token issued more than `MINI_APP_SESSION_REFRESH_THRESHOLD_MS` (5 minutes) ago, the server automatically rotates the token and extends expiration by 45 minutes (returning the refreshed credentials via `X-Mini-App-Session` and `X-Mini-App-Session-Expires-At` response headers and the `/api/auth/precheck` response body while permitting the static `initData.auth_date` across active session renewals, and keeping the previous token valid for 5 minutes for concurrent in-flight requests), up to `MINI_APP_SESSION_MAX` (8) active sessions in memory.
- **Brute-force lockout**: After `MINI_APP_PASSWORD_MAX_ATTEMPTS` (3) consecutive failed password or TOTP attempts, the SuperAdmin ID is locked out for `MINI_APP_PASSWORD_LOCKOUT_MS` (30 minutes) and all active sessions are cleared; concurrent login requests still in flight when the lockout takes effect are counted as failures without checking credentials, extending the lockout to 30 minutes from that moment. Entering a lockout sends one private-chat alert containing the unlock time and source IP, while extending an active lockout does not resend.

### 3. Binding Google Authenticator (TOTP) (Recommended)

After logging in with your access password, binding a single Google Authenticator 2FA secret under the "Authenticator" tab is recommended:

1. Open the "Authenticator" tab to generate a pending Base32 secret and QR code (valid in main-thread memory for `MINI_APP_TOTP_PENDING_TTL_MS`, i.e. 10 minutes, and invalidated after `MINI_APP_PASSWORD_MAX_ATTEMPTS` failed verification attempts).
2. Scan the QR code with Google Authenticator or another RFC 6238 app (or enter the 32-character Base32 secret manually) and submit the 6-digit code (`MINI_APP_TOTP_DIGITS`) for the current 30-second step (`MINI_APP_TOTP_STEP_SECONDS`).
3. Once verified, the secret is persisted atomically (`0o600` permissions) to `memory/mini-app-totp/totp.json` (schema version `MINI_APP_TOTP_RECORD_VERSION`) under the runtime data root. Subsequent logins prioritize the 6-digit TOTP code (accepting only the code for the current 30-second time step); deleting the authenticator in the console reverts login verification to `mini_app.password`.

---

## Verification and Operational Notes

- **Startup log check**: Confirm that startup logs print `Mini App HTTP server listening on http://127.0.0.1:3000 (public URL: https://app.example.com/).` and that `cloudflared` reports `active (running)`.
- **Edge caching and security headers**: All dynamic HTML/JSON API responses carry `MINI_APP_NO_STORE_CACHE_CONTROL` (`no-store, no-cache, must-revalidate, max-age=0`) so Cloudflare edge nodes never cache dynamic state. Gallery preview images authenticated via `assetToken` and the static `/favicon.ico` icon return `MINI_APP_ASSET_CACHE_CONTROL` (7-day immutable cache) with `ETag` 304 revalidation. Every response includes `MINI_APP_CSP_HEADER_VALUE` and `X-Frame-Options: DENY`.
- **Backing up persisted TOTP state**: When a TOTP authenticator is bound, include `memory/mini-app-totp/totp.json` in data-root backups. Both startup preflight and `install.sh` validate this file strictly (missing file means unbound; non-regular files or malformed contents halt startup—see [07 Operations](07-operations.md) and [04 Runtime Invariants](04-invariants.md)).

---

<div align="center">

[← Prev: 09 Command Reference](09-commands.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#10-mini-app-setup-and-recommended-configuration) · [Next: 11 Performance Benchmark →](11-performance.md)

</div>
