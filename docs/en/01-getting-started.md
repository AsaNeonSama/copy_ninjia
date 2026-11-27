# 01 Environment Setup and First Run

<p align="center">
  <a href="../cn/01-getting-started.md">简体中文</a> · <b>English</b> · <a href="../ja/01-getting-started.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <b>← Prev: None</b> · <a href="02-architecture.md">Next: 02 Architecture →</a>
</p>

---

This guide walks you through the quickest path to take a clean server environment and get Copy Ninjia running smoothly in your group. For deep dives into system architecture, thread topology, and message flow, see [02 Architecture Overview](02-architecture.md).

## Prerequisites

- **Linux Operating System** (must have a readable `/proc` filesystem): The instance lock depends strictly on `/proc/<pid>/stat` and the system boot ID. Unsupported operating systems will fail closed and refuse to start.
- **Bun** (version per `package.json` `packageManager`): Required for source installs and local development. Install via:
  ```bash
  curl -fsSL https://bun.sh/install | bash -s bun-v1.4.5
  ```
  > [!NOTE]
  > Binary release packages bundle a standalone Bun runtime, requiring no pre-installed Bun or Node.js on the host. Node.js is not used anywhere in this project.
- **Telegram Bot Token**: Message [@BotFather](https://t.me/BotFather) with `/newbot` to create your bot and obtain its API Token.
- **API Keys for AI Capabilities**: Each capability configured in `config/dynamic/agent.json` (chat, vision, image generation, speech synthesis, web search, ad detection) independently configures its provider, model, endpoint, and key. Obtain credentials from [Google AI Studio](https://aistudio.google.com/), [OpenAI Platform](https://platform.openai.com/), [Anthropic Console](https://console.anthropic.com/), or compatible endpoints.
- **(Optional) Google Cloud Service Account JSON**: Required only if you intend to enable the `/translate` command. Place the file at `config/static/g-auth.json` (structure matches [`config_example/static/g-auth.json`](../../config_example/static/g-auth.json)).
  - **Key Specifications**: Must contain `client_email` and an RSA PEM private key for RS256 signing (EC, Ed25519, and RSA-PSS keys are rejected); `type` must be `service_account` if present.
  - **Graceful Degradation**: Missing this file does not prevent the bot from running; `/translate` simply informs users that translation is unconfigured. If the file exists but contains invalid JSON or unsupported keys, the startup check will fail fast.
  - **Safety**: Credentials are read once into an immutable snapshot during startup. Error logs print file paths and missing fields, never secret tokens or private keys.

---

## Installation

### Automated Installation

For a fresh deployment, using the automated [`install.sh`](../../install.sh) script is recommended:

```bash
curl -fsSL https://raw.githubusercontent.com/AsaNeonSama/copy_ninjia/master/install.sh | bash
```

You can specify the installation mode using command-line flags or the `COPY_NINJIA_INSTALL_MODE` environment variable (`binary` | `source`). When omitted, the installer prompts interactively:

```bash
# Standalone binary installation (Recommended for production; no git or Bun required)
curl -fsSL https://raw.githubusercontent.com/AsaNeonSama/copy_ninjia/master/install.sh | bash -s -- --binary

# Source installation (Ideal for contributors and local development)
curl -fsSL https://raw.githubusercontent.com/AsaNeonSama/copy_ninjia/master/install.sh | bash -s -- --source
```

#### Installation Mode Comparison and Behavior

<table width="100%">
<thead>
  <tr>
    <th width="20%" align="left">Dimension</th>
    <th width="40%" align="left">Binary Distribution (<code>--binary</code>)</th>
    <th width="40%" align="left">Source Clone (<code>--source</code>)</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>📦 <b>Distribution</b></nobr></td>
    <td>Pulls the latest precompiled release matching your host architecture from GitHub Releases</td>
    <td>Clones the matching release tag via <code>git clone --branch</code> (detached HEAD)</td>
  </tr>
  <tr>
    <td><nobr>⚙️ <b>Dependencies</b></nobr></td>
    <td>Zero external tool requirements; no Bun, git, or compiler needed on the server</td>
    <td>Requires git and the Bun version specified in <code>package.json</code> <code>packageManager</code>; the installer will attempt to install missing tools if permitted</td>
  </tr>
  <tr>
    <td><nobr>🚀 <b>Runtime</b></nobr></td>
    <td>Single self-contained executable bundling Bun runtime and Worker code</td>
    <td>Managed via <code>bun install --frozen-lockfile</code></td>
  </tr>
  <tr>
    <td><nobr>▶️ <b>Run Command</b></nobr></td>
    <td>Directly run <code>./copy-ninjia</code></td>
    <td>Run <code>bun run start</code></td>
  </tr>
</tbody>
</table>

> [!TIP]
> **Installer Flow & Safeguards** (matches `install.sh` step indicators; see [07 Operations](07-operations.md)):
> 1. **Platform Check**: Verifies a Linux environment, readable `/proc`, and an interactive terminal (`/dev/tty`).
> 2. **Target Repository & Binary Resolution**: Checks the script directory, current directory, and target directory for an existing deployment; otherwise clones the latest Release tag or downloads and SHA-256-verifies the platform-matched binary bundle (x64/arm64, glibc/musl).
> 3. **Toolchain & Bun**: Ensures the pinned Bun version (`packageManager` in `package.json`) is installed in source mode, or uses the bundled binary in binary mode.
> 4. **Dependencies**: Runs `bun install --frozen-lockfile` in source mode (skipped in binary mode).
> 5. **Configuration Directory Layout**: Enforces the three-level `config/` directory whitelist (`config/` allows only `static/` and `dynamic/`, and each subdirectory allows only its declared files; legacy files such as `ad_samples.json`, misplaced entries, hidden/backup/swap files, or root-level `state.json`/`storage.sqlite` abort immediately). Copies only missing templates without overwriting existing files (`agent.json`, `g-auth.json`, and `cron.json` are left for wizard or manual setup).
> 6. **Interactive Configuration Wizard**: Prompts for required `config/static/bot.json` fields and, when `config/dynamic/agent.json` is absent, walks through each AI capability (including custom `base_url` endpoints). Edits to existing configs take an external backup first and atomically replace files only after strict validation passes.
> 7. **Database Initialization**: Validates an existing `database/storage.sqlite` in read-only mode against `bot.json`'s `time_zone`, or bootstraps a fresh schema and stamps the time-zone marker.
> 8. **Service Registration & Health Check**: Registers and starts `copy-ninjia.service` under systemd (or runs in the foreground when systemd is unavailable), confirms `active/running` status without restart loops or non-zero exits, and cleans up the temporary backup.

### Manual Source Installation

```bash
# 1. Clone the repository
git clone https://github.com/AsaNeonSama/copy_ninjia.git
cd copy_ninjia

# 2. Install dependencies with strict lockfile verification
bun install --frozen-lockfile

# 3. Prepare deployment directories and copy example templates (never overwrites existing configs)
mkdir -p config/static config/dynamic
for example in config_example/static/*.json config_example/dynamic/*.json; do
  case "${example##*/}" in
    agent.json | g-auth.json | cron.json) ;;
    *) cp -n "$example" "config/${example#config_example/}" ;;
  esac
done
```

> [!WARNING]
> The examples for `agent.json`, `g-auth.json`, and `cron.json` contain placeholder credentials or sample schedules and should be copied and filled in only when enabling those features; remove the `mini_app` section from `config/static/bot.json` unless enabling the Mini App (otherwise configure it and replace its placeholder `password`). Replace all `replace-with-…` placeholder values (`bot_token`, `mini_app.password`, and provider `api_key` entries) with actual credentials; unedited placeholders will trigger a fail-fast error at startup. See [`config_example/README/en.md`](../../config_example/README/en.md).

---

## Configuring Telegram Identity

Core bot credentials and administrator ownership are declared in `config/static/bot.json`:

- **`bot_token`** (required, string)
  - The Telegram Bot API Token issued by @BotFather. Placeholder values cause immediate startup termination.
- **`super_admin_user_id`** (required, positive integer)
  - The Telegram numeric user ID of the primary operator.
  - **Privilege Boundary**: Holds all system permissions inherently. Does not need to be added to the SQLite allowlist table.
  - **Exemption Protections**: Completely exempt from rate limits and cooldowns (copying, image generation, etc.). Cannot be targeted by `/block`, `/mute`, `/delete_message`, `/batch_kick`, or AI `abuse_mark`.
  - **Exclusive Authority**: Commands such as `/init`, `/batch_kick`, `/delete_message`, `/permission` assignments, `/white disable`, private `/send` relays, and the Mini App management console are restricted exclusively to this user ID.
- **`atmosphere`** (optional, enum: `"mesugaki"` | `"normal"`)
  - Sets the communication tone for system notices, menus, and help messages (`mesugaki` for teasing tone, `normal` for clean/restrained tone).
  - Explicit configuration takes precedence. If omitted, custom personas use `normal` tone by default, while the built-in persona uses `mesugaki`.
- **`time_zone`** (optional IANA time zone string, default `DEFAULT_BOT_TIME_ZONE`)
  - Defines the authoritative calendar time zone for fortunes, rotation logs, daily maintenance crons, AI time awareness, and ad quotas.
  - Trimmed and case-normalized via Temporal (aliases are preserved).
  - **Data Root Binding**: The initial setup permanently stamps this time zone into `database/storage.sqlite`. Changing `time_zone` on an existing data root will be rejected at startup to prevent time-series corruption.
- **`log_level`** (optional, enum: `"info"` | `"operation"` | `"warn"` | `"error"`, defaulting to `"operation"` when omitted or from template)
  - Sets the minimum severity threshold for both console output and disk persistence under `logs/<YYYY-MM-DD>.json` (`info` < `operation` < `warn` < `error`); trimmed and strictly validated when present (invalid values fail closed).
  - `info` captures internal behavior diagnostics plus all higher levels; `operation` captures Telegram `/` commands, `/wed` callbacks, `/qa set` forms, Mini App login/logout and state mutations (plus `warn`/`error`); `warn` captures warnings and errors; `error` records errors only. `info`/`operation`/`warn` logs batch-buffer on the main thread (up to 32 entries or 30 seconds), while `error` logs flush immediately.
- **`mini_app`** (optional, object: `{ url: string, port: number, host?: string, password: string }`)
  - Configures the SuperAdmin-only Telegram Mini App management console. When omitted, no HTTP server, routes, or private-chat menu button are registered; when present, `url`, `port`, and `password` are required and `host` is optional.
  - **Fields**:
    - `url` (required): Public `https://` URL (subpath prefixes supported).
    - `port` (required): Local listening port (`MINI_APP_PORT_MIN`–`MINI_APP_PORT_MAX` integer; `3000` in the example config).
    - `host` (optional): Non-empty local bind address, defaulting to `MINI_APP_DEFAULT_HOST` (`"127.0.0.1"`).
    - `password` (required): First-screen access password (non-placeholder string containing at least 6 digits `0-9`; remove the `mini_app` section if copying `config_example/static/bot.json` manually without enabling the Mini App).
  - **Runtime & Authentication**: Starts a local `Bun.serve` HTTP console, attaches `MenuButtonWebApp` (`App`) to the SuperAdmin's private chat, enforces two-tier authentication (`initData` signature + runtime-generated `Ed25519` / ephemeral `X25519` ECDH credential handshake) with 256-bit temporary-key AES-256-GCM transport encryption (45-minute sliding renewal after a randomized 5s–5min per-epoch cooldown, capped at 2 hours), provides an online highlighted JSON config editor, and supports optional Google Authenticator TOTP 2FA persisted at `memory/mini-app-totp/totp.json`. See [10 Mini App Setup and Recommended Configuration](10-mini-app.md).

---

## Project Configuration Files

The `config/` directory stores private deployment data and is excluded from Git tracking. Configuration files are strictly organized into static and dynamic subdirectories:

```text
config/
├── static/                 # Static configuration (requires process restart to take effect)
│   ├── bot.json            # Bot credentials and super administrator ID
│   └── g-auth.json         # Google Cloud service account credentials (optional)
└── dynamic/                # Dynamic configuration (automatically reloaded with debouncing)
    ├── agent.json          # AI model capabilities and provider endpoints
    ├── assets.json         # Paths for avatars, thumbnails, and dedicated image library
    ├── stickers.json       # Whitelisted sticker packs
    ├── mood.json           # AI mood tiers and weight distribution
    ├── ad_detect.json      # Ad punishment and reference ad samples
    └── cron.json           # Scheduled tasks and periodic broadcasts (optional)
```

> [!IMPORTANT]
> - Configuration files placed in the root of `config/` or misplaced across subdirectories will cause the bot to fail fast and exit immediately on startup.
> - Modifications to files in `config/dynamic/` trigger debounced hot-reloading at runtime. Syntax or schema errors are rejected safely, keeping the existing valid snapshot in memory while logging an error.

### Core Configuration Files Explained

- **`prompt/persona.md`** (optional, located at project root; see [example](../../prompt_example/persona.md))
  - **Purpose**: Defines the custom AI chat persona and behavioral guidelines.
  - **Behavior**: Uses the built-in teasing persona ([`persona.ts`](../../packages/consts/aiChat/prompts/persona.ts)) by default. When this file exists, its entire trimmed text replaces the built-in prompt upon process restart.
  - **Validation**: Must be valid non-empty UTF-8 text.

- **`prompt/voice_tool.md`** (optional, located at project root; see [example](../../prompt_example/voice_tool.md))
  - **Purpose**: Custom instruction prompt for the `send_voice` AI speech synthesis tool.
  - **Behavior**: When omitted, the built-in instruction is chosen according to `agent.tts.bot_language` (`en` / `zh` / `ja`). When present, this file replaces the tool description completely.
  - **Validation**: Plain text; empty files or invalid UTF-8 will prevent startup. Requires a restart to take effect.

- **`config/static/bot.json`** ([Example](../../config_example/static/bot.json))
  - Holds primary bot token, owner user ID, notice atmosphere, time zone, and optional Mini App console settings (see "Configuring Telegram Identity" above). Strictly parsed with zero tolerance for unknown fields.

- **`config/dynamic/stickers.json`** ([Example](../../config_example/dynamic/stickers.json))
  - Defines the `packs` array of Telegram sticker pack short names available for AI expression. Each pack name must be unique, with total count capped at `MAX_CONFIGURED_STICKER_PACKS`.

- **`config/dynamic/mood.json`** ([Example](../../config_example/dynamic/mood.json))
  - Configures the AI mood tiers `moods`. Each mood defines a `name`, positive integer `weight`, and character `instruction`. Weights must strictly sum to `MOOD_WEIGHT_TOTAL`.

- **`config/dynamic/ad_detect.json`** ([Example](../../config_example/dynamic/ad_detect.json))
  - Configures ad disposal and few-shot classifier samples (ad sticker and custom-emoji pack blacklists are persisted separately in SQLite `ad_pack_blacklists` with no per-kind entry cap and a 768-entry shared main-thread LRU read cache, managed via `/ad_detect sticker|emoji` or the Mini App, and automatically persisted when AI classification attributes an ad pack; `ad_detect.json` is never modified at runtime):
    - `punishment`: Disposal applied after an ad verdict, specifying **exactly one** of `mute` or `kick`:
      - `mute`: Mutes the sender in the triggering chat — permanently when `permanent: true`, or for `duration` otherwise.
      - `kick`: Removes the sender from the triggering chat — without banning when `block: false`, or banning either in that chat only (`block_scope: "chat"`) or across all managed chats via the permanent blocklist (`block_scope: "global"`).
      - Channel identities have only their offending messages deleted under every setting except a `"global"` block.
    - `samples`: Few-shot reference texts for the AI ad classifier. After whitespace normalization and trimming, each entry must be non-empty, at most `AD_SAMPLE_MAX_CHARS` characters, and unique (up to `MAX_CONFIGURED_AD_SAMPLES` entries).

- **`config/dynamic/agent.json`** ([Example](../../config_example/dynamic/agent.json))
  - Declares all AI model capabilities under the top-level `agent` object. Each capability is isolated and configured independently:
    1. **Core Conversational Suite** (all three required for AI chatting):
       - `text`: Primary text generation model.
       - `summary`: Memory condensation and rolling summarization model.
       - `media`: Multimodal vision and audio transcription model.
    2. **Extended Generation Tools** (absence automatically disables the corresponding tool):
       - `image`: Image generation. OpenAI-compatible endpoints declare `image_protocol` (`openai` | `openai-standard` | `xai`). Optional `max_reference_images` (up to `IMAGE_GENERATION_MAX_REFERENCE_IMAGES`, default `IMAGE_GENERATION_DEFAULT_REFERENCE_IMAGES`) sets the maximum reference images passed to the model per generation; album images fill the remaining slots in album order.
       - `tts`: Speech synthesis. Must declare a `voice` identifier; OpenAI-compatible endpoints set `speech_protocol` (`openai` | `xai`). Optional `style` (default `TTS_DEFAULT_STYLE`) provides baseline voice characteristics.
         - `bot_language` (`en` | `zh` | `ja`, default `TTS_DEFAULT_BOT_LANGUAGE`) sets the speaking language for AI-generated voice lines.
         - `daily_limit` (default `TTS_DEFAULT_DAILY_LIMIT`) and `daily_reserve_quota` (default `TTS_DEFAULT_DAILY_RESERVE_QUOTA`, must be less than `daily_limit`) partition daily synthesis volume between AI chatter and administrative `/send`/cron broadcasts.
    3. **Search & Moderation**:
       - `web_search`: Function tool for real-time web search (`max_calls_per_use` limits calls per turn, default `WEB_SEARCH_DEFAULT_MAX_CALLS_PER_USE`). If omitted, the text model's native search is used if supported.
       - `ad_detect`: Dedicated multimodal and text spam/ad classifier model (inspects text, photos, stickers, and custom emojis). With `provider: "google"`, an optional boolean `use_decision` (default `false`) enables the Google Decisions API. Omitting this block disables ad detection.
    4. **Common Capability Attributes**:
       - `provider`: `google` | `openai` | `anthropic`.
       - `api_key`: API key string (placeholders trigger startup failure).
       - `model`: Provider model identifier.
       - `base_url`: Custom HTTPS proxy or API gateway endpoint.
       - `fallback_model`: Fallback model, allowed only for the `anthropic` provider (must differ from `model`). When `model` refuses, the same request is resent with it; if the fallback model also refuses, or none is configured, the request fails without retrying.

---

### Initializing Identity Storage

Copy Ninjia does not perform dynamic schema migrations at runtime. Fresh deployments must initialize the SQLite database prior to first launch:

```bash
mkdir -p database
bun -e '
  import { bootstrapStorageDatabase } from "./packages/database/interact/initialization";
  import { loadBotConfig } from "./packages/config/botInput";
  import { IDENTITY_DATABASE_PATH } from "./packages/consts/paths";

  const { timeZone } = await loadBotConfig();
  bootstrapStorageDatabase(IDENTITY_DATABASE_PATH, timeZone);
'
chmod 2770 database
chmod 660 database/storage.sqlite
```

> [!IMPORTANT]
> Running `bootstrapStorageDatabase` creates the schema, writes the current schema version and the `bot.json` `time_zone` binding into `storage_metadata`, and enables WAL mode. Skipping this initialization will cause the bot to abort during startup due to missing metadata.

---

### Customizing Inline Thumbnails and Default Avatar

Customize visual assets and local image library paths in `config/dynamic/assets.json` (supports dynamic hot-reloading):

```json
{
  "onlyPath": {
    "random_h_image_dir": "./h_image"
  },
  "pathOrUrl": {
    "bot_default_avatar": "https://example.com/avatar.png"
  },
  "onlyUrl": {
    "fortune_thumbnail_url": "https://example.com/fortune.png",
    "probability_thumbnail_url": "https://example.com/probability.png",
    "gag_thumbnail_url": "https://example.com/gag.png"
  }
}
```

- **`onlyPath`**: Local path (relative paths resolve against the data root). `random_h_image_dir` sets the dedicated image library directory used by `/h_image` and cron tasks.
- **`pathOrUrl`**: Local filesystem path or HTTP(S) URL. `bot_default_avatar` provides the media used when restoring the bot's original avatar: a JPEG/PNG image (up to `BOT_PROFILE_PHOTO_MAX_BYTES`) becomes a static avatar, and an MP4 video (up to `BOT_PROFILE_ANIMATION_MAX_BYTES`, with square video no larger than `BOT_PROFILE_ANIMATION_MAX_SIDE`) becomes an animated avatar. Each URL download times out after `DEFAULT_AVATAR_FETCH_TIMEOUT_MS`.
- **`onlyUrl`**: Direct HTTPS URLs providing thumbnail icons for fortunes, probability rolls, and `/gag` buttons.

---

## Telegram-Side Configuration (BotFather and Group)

Configure the following settings in [@BotFather](https://t.me/BotFather):

1. **Disable Privacy Mode**: Send `/setprivacy` -> Select your bot -> Choose **Disable** (allows the bot to receive normal group messages for copying, translation, AI conversation, group Q&A, and moderation).
2. **Grant Administrator Permissions**: Add the bot to your target group and grant administrative permissions (delete messages, restrict users, ban members).
3. **Enable Inline Mode**: Send `/setinline` -> Choose **Enable** (used by `@bot` daily fortune queries and `/gag` speech entry buttons).
4. **Set Inline Feedback Rate**: Send `/setinlinefeedback` -> Set to **100%** (delivers `chosen_inline_result` events used to confirm and persist fortune draws).
5. **(Optional) Enable Bot-to-Bot Communication**: If you plan to copy or translate messages sent by other bots, enable this setting in BotFather. Inbound bot messages remain subject to global rate-limiting gates.

---

## First Startup

```bash
# 1. Run full quality gates to verify project integrity
bun run check

# 2. Launch the long-polling process
bun run start
```

Once online, the **super administrator** must activate business logic inside the target group by running:

```text
/init enable      # Onboard this group (mandatory; uninitialized groups are completely ignored)
/ai_chat enable   # (Optional) Enable conversational AI chat in this group
/ad_detect enable # (Optional) Enable smart spam detection (requires admin rights)
/antiraid enable  # (Optional) Enable join verification challenge and anti-raid mode
```

### Verification

- Reply to any message in the group with `/copy`: The bot should echo the text and assume the user's avatar.
- Check the `logs/` directory: Structured error and operational logs should appear normally.
- Send `Ctrl+C`: Observe graceful shutdown logs confirming that incoming gates closed, queues drained, and states persisted cleanly before exit.

---

<div align="center">

**← Prev: None** · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#01-environment-setup-and-first-run) · [Next: 02 Architecture →](02-architecture.md)

</div>
