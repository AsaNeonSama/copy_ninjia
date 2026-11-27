# 04 Authoritative Runtime Invariants

<p align="center">
  <a href="../cn/04-invariants.md">简体中文</a> · <b>English</b> · <a href="../ja/04-invariants.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="03-directory-map.md">← Prev: 03 Directory Map</a> · <a href="05-dev-workflow.md">Next: 05 Workflow →</a>
</p>

---

This page records the **authoritative constraints** across modules and lifecycles. Source comments should explain local invariants and link here, for example with `@see ../../docs/cn/04-invariants.md` (adjusting `../` for source depth), instead of maintaining complete startup or persistence narratives in multiple modules. When a change touches any rule below, update this page before changing the code.

For a guided explanation, see [02 Architecture Overview](02-architecture.md). For procedures that touch these constraints, see [06 Common Modification Recipes](06-modification-guide.md).

> [!TIP]
> This page is a complete reference for implementation and review; it is not intended to be read linearly. Start from the navigation below. In long entries, the bold text at the start of a paragraph usually states the conclusion that must be preserved.

## Quick Navigation

| Area | Topics |
| --- | --- |
| [Startup and Import Boundaries](#startup-and-import-boundaries) | [Startup Order and Resource Acquisition](#startup-order-and-resource-acquisition) · [Optional Credentials and Strict Configuration Preflight](#optional-credentials-and-strict-configuration-preflight) · [Data Root and Background Tasks](#data-root-and-background-tasks) · [Outbound Requests and Message Safety](#outbound-requests-and-message-safety) |
| [Worker and State Ownership](#worker-and-state-ownership) | [Thread and State Ownership](#thread-and-state-ownership) · [State-Machine Contracts](#state-machine-contracts) · [AI Chat Runtime](#ai-chat-runtime) · [AI Prompts and Transcript](#ai-prompts-and-transcript) · [Join Verification and Terminal Disposal](#join-verification-and-terminal-disposal) · [Flood Muting and the Bot's Own Permission Cache](#flood-muting-and-the-bots-own-permission-cache) · [Identity Resolution and Runtime Teardown](#identity-resolution-and-runtime-teardown) |
| [Persistence](#persistence) | [Durability and Snapshot Contracts](#durability-and-snapshot-contracts) · [Chat State and `chat_states`](#chat-state-and-chat_states) · [Chat Q&A and `chat_qa`](#chat-qa-and-chat_qa) · [Blocklist and Ad Detection](#blocklist-and-ad-detection) · [Fortune and AI-Memory Recovery](#fortune-and-ai-memory-recovery) · [Acknowledgement Boundary and Shutdown](#acknowledgement-boundary-and-shutdown) · [File Permissions and Schema](#file-permissions-and-schema) · [Lockdown Mirror and Terminal Flags](#lockdown-mirror-and-terminal-flags) |
| [Compatibility Entry Points](#compatibility-entry-points) | Top-level barrels and fortune-receipt format |

## Startup and Import Boundaries

### Startup Order and Resource Acquisition
<a id="startup-sequence-and-resource-acquisition"></a>

- **The default time zone is a process-startup read-only snapshot**:
  - `config/static/bot.json` accepts an optional `time_zone` field using standard IANA names, defaulting to `DEFAULT_BOT_TIME_ZONE`.
  - After trimming leading and trailing whitespace, startup strictly validates that `Intl`, `Temporal`, and Bun native cron all accept the zone, keeping the `Temporal`-normalized IANA name (for example normalizing `asia/tokyo` to `Asia/Tokyo` while preserving aliases such as `Japan` as-is). Empty strings, non-string types, or unsupported zones abort startup before any external connection is opened.
  - The main thread holds the authoritative snapshot and distributes it to the AI, Anti-Raid, and Disk I/O Workers via `init`, `agentConfig`, and `load` messages; Worker respawns replay the same snapshot.
  - Each isolate's `cache/perThread/time.ts` maintains its own copy of the zone, an `Intl` formatter, a single-slot date prefix, and the active UTC offset segment: day indexes, date strings, local wall-clock times, and hour checks use integer arithmetic within the current offset segment, recalculating through `Temporal` only when crossing segment boundaries.
  - Fortune draws, log timestamps, temporary ad-bypass day tracking, join logs, AI time perception, and daily maintenance all share this zone. The Tokyo weather tool (`GET_TOKYO_WEATHER_TOOL`) is registered only when the startup zone equals `TOKYO_TIME_ZONE`; other zones omit the tool declaration altogether.

- **The data root is permanently bound to its time zone**:
  - When initializing the database, `initializeStorageDatabase` writes `{ timeZone }` to `storage_metadata` under `IDENTITY_DATABASE_TIME_ZONE_KEY`.
  - Both Disk I/O Worker startup and the service installer verify that this database marker matches `bot.json`'s `time_zone`; any mismatch aborts startup and names `storage_metadata.time-zone`. Existing data roots cannot switch time zones.

- **Side-Effect-Free Module Imports**:
  - Importing production modules never spawns Workers, schedules timers, opens network connections, or writes to disk.

- **Data Root Preflight and Exclusive Instance Lock**:
  - Before acquiring `bot.lock`, the main process recursively creates the runtime data root and preflights write, file-`fsync`, hard-link, atomic-`rename`, and directory-`fsync` support.
  - **Path and permission rules**:
    - The data root, `memory/`, `logs/`, and `database/` must be physical directories (symlinks fail closed).
    - When `COPY_NINJIA_DATA_ROOT` is explicitly set, permissions on the data root, `memory/`, and `logs/` must not grant group or world write bits (`RUNTIME_DATA_ROOT_MAX_MODE`), while `database/` permits group write (`IDENTITY_DATABASE_DIRECTORY_MODE`) for SQLite WAL/SHM sidecar files.
  - **Cold-start cleanup and recovery**:
    - Once `bot.lock` is held, `cleanupOrphanedTempFiles` sweeps orphaned runtime atomic temporary files (`state.json`, `totp.json`, `bot.lock`), inactive lock helper files, and whitelisted atomic temporary files in `config/static/` and `config/dynamic/` whose owner PID is dead or equals this process's PID (the sweep runs before this process writes any config, so a matching PID can only be a pre-reuse leftover) before layout validation runs; startup aborts if legacy unmigrated `state.json` or `state.json.bak` exists at the data root, and strictly loads `memory/mini-app-totp/totp.json` (when present) and `memory/global/state.json` before opening network connections or spawning Workers.
  - **Single-instance lock boundary**:
    - Exactly one live process may hold a given data root at a time, verified against `/proc/<pid>/stat` process start ticks and the kernel boot ID.

- **Strict Lifecycle Progression Order** (`packages/app/lifecycle.ts`):
  1. Acquire `bot.lock`, initialize in-memory main-thread runtimes, call `cleanupOrphanedTempFiles` before checking layout (`assertDeploymentConfigLayout`), load `memory/global/state.json`, strictly validate all existing deployment inputs (`validateExistingDeploymentInputs`, including `memory/mini-app-totp/totp.json` when present) and random-image storage (`prepareRandomImageDirectory`), and spawn the Disk I/O Worker (`initDiskIO`).
  2. Hydrate persisted SQLite state (`chatStates`, `chatQa`, `adPackBlacklistCounts`, `wedMembers`, and identity entry counts), initialize Telegram clients, run super-administrator mutual-exclusion assertions (`assertSuperAdminNotBlocked`, `assertSuperAdminNotDeleteMessageTarget`), restore the copied user and translate targets, and restore fortune state and pending verifications.
  3. Register the update middleware chain and command menus (`registerHandlers`, `registerCommandMenu`, attaching `MenuButtonWebApp` in the superadmin's private chat when `mini_app` is configured), then complete the `bot.init()` handshake.
  4. Spawn the AI Chat Worker (`initAiChat`) and hydrate AI memories and sticker catalogs; hydrate the blocklist removal outbox (`hydrateBlocklist`) and spawn the Anti-Raid Worker (`initAntiRaid`).
  5. Start the `cron.json` scheduler (`startCronScheduler`), `config/dynamic/` hot reload (`startConfigReload`), the Mini App HTTP server (`startMiniAppServer`), and the blocklist sweep scheduler (`initBlocklistSweepScheduler`), run an initial blocklist sweep across managed chats (`sweepManagedBlocklistChats`), launch `runAcknowledgedUpdateBatches` to begin polling, and finally enable `/wed` member review (`enableWedMemberReview`) and background chat-title refresh (`refreshAllChatTitles`).
- **Unified Lifecycle Teardown**:
  - Initialization failures and normal shutdowns converge on `ApplicationLifecycle`, releasing acquired resources in reverse dependency order.

### Optional Credentials and Strict Configuration Preflight

- **Strict configuration preflight at startup**:
  - Configuration parsers perform no I/O. Before spawning Workers or opening network connections, the main thread strictly validates every existing deployment file via `validateExistingDeploymentInputs`; disabling a feature never excuses malformed configuration.
  - Truly absent optional files do not block startup; readiness gates simply mark the corresponding capability unavailable. The main thread holds authoritative snapshots: files under `config/dynamic/` support runtime hot reload, whereas `config/static/` files require a process restart.
  - In `config/dynamic/agent.json`, ad detection reads `agent.ad_detect`, while AI chat reads `text`, `summary`, `media`, and optional tool capabilities (`image`, `tts`, `web_search`). Startup validates every capability declared in the file.

- **SQLite is the sole authoritative source for identity policies and ad pack blacklists**:
  - Allowlists, blocklists, temporary ad-bypass records, pending moderation state, and ad sticker/custom-emoji pack blacklists (`ad_pack_blacklists`) live exclusively in `database/storage.sqlite`; runtime code never reads or writes policy JSON files and never writes ad pack blacklists back to `config/dynamic/ad_detect.json`.
  - On startup, the Disk I/O Worker validates SQLite integrity, JSONB storage class, schema migration version (`IDENTITY_DATABASE_SCHEMA_VERSION` = 14, 13 migrations in `STORAGE_MIGRATION_LINEAGE` through `0012_ad_pack_blacklists`), the `storage_metadata.time-zone` marker, every row codec (including streaming validation of `ad_pack_blacklists` without loading the table into memory or capping its row count), and mutual exclusivity between the blocklist and allowlists. Any violation aborts startup immediately.

- **Main-thread synchronous authorization via bounded LRU caches**:
  - **Unified three-field LRU**: The main thread holds one LRU cache of capacity `IDENTITY_READ_CACHE_MAX_ENTRIES` (`identityPolicyCache` in `packages/cache/main/identityStorage.ts`). Each entry stores three policy fields together—permanent allowlist, blocklist, and temporary ad bypass—which are evicted as a unit. `undefined` marks an unloaded field, `null` marks an explicit negative cache hit, and an identity counts as cached only when all three fields are loaded.
  - **Batch prefetching**:
    - Inbound update preamble batches all user and channel identities referenced in the update and cold-reads up to `IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES` IDs per request from the Disk I/O Worker, populating all three fields at once so downstream handlers and permission checks read synchronously from memory.
    - On the Disk I/O side, allowlist, blocklist, temporary ad-bypass, and `chat_states` ID lookups reuse per-connection prepared statements (single-ID queries bind `WHERE id = ?`; multi-ID batch queries bind a JSON array via `json_each`).
  - **Fail-closed cold-read handling**: If a prefetch fails, regular commands fail closed (denying permission), and destructive bulk actions cancel rather than treating unresolved identities as unprotected.
  - **Batch kick exception (`/batch_kick`)**: Does not rely on LRU residency; before each `IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES` chunk, `readIdentityPolicyVerdicts` cold-reads permanent policies for the chunk and holds them locally, evaluating protection and blocklist skips over `local verdict ∪ live cache`.
  - **Mini App list exception**:
    - **Cold-read pagination and profile alignment**: Mini App allowlist and blocklist pages and searches cold-read through `readIdentityPolicyEntries` under the `IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES` chunk cap. Unacknowledged local mutations override database rows on both cursor pagination and entry payloads, and display metadata is bidirectionally aligned with the main-thread `senderIdentity` cache (preferring fresher cached profiles and backfilling unclaimed usernames without overwriting reassigned handles).
    - **Request-local isolation**: Listing results stay local to that HTTP request and are never read from or written into `identityPolicyCache`, leaving hot message-path entries untouched; a cold-read failure fails the HTTP request.
    - **Shared mutation and target guards**: Adding or removing entries and editing permission bits share the exact prefetch and write path of `/white`, `/block`, and `/permission`—rejecting `SUPER_ADMIN_USER_ID`, the bot itself, and any initialized managed group chat identity, enforcing strict allowlist/blocklist mutual exclusivity, and propagating the first boundary rejection code when a native `users_shared` or `chat_shared` picker import adds zero entries.
    - **Duplicate persistence confirmation and cross-chat fan-out**: Duplicate allowlist additions confirm persistence (`confirmIdentityPolicyPersisted(..., retryUnacknowledged=true)`) and return `{ ok: true, changed: false, duplicate: true }`; duplicate blocklist additions confirm persistence (`confirmBlocklistPersisted(..., retryUnacknowledged=true)`) and re-dispatch cross-chat bans across managed admin chats (matching `/block enable`), returning `{ ok: true, changed: false, duplicate: true, persisted, affectedChats, totalChats }`; the frontend duplicate toast also shows the re-ban chat count and persistence status.

- **Temporary ad bypass cross-chat accumulation**:
  - Regular messages from user or channel identities count toward accumulation only when ad detection is ready and enabled in that chat. Messages from the bot itself, linked-channel auto-forwards, anonymous group admins, and permanent allowlist members are ignored.
  - Exceeding `TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD` messages within a configured local calendar day qualifies that day (at most once per day); the first qualifying day immediately grants `TEMPORARY_AD_BYPASS_PERMISSIONS`.
  - Reaching `TEMPORARY_AD_BYPASS_REQUIRED_DAYS` consecutive qualifying days promotes the identity to the permanent allowlist (with ad-bypass permission only) and removes its temporary record.
  - If a calendar day ends without qualifying, daily maintenance deletes the temporary record; any ad infraction or manual `/block` clears it immediately.

- **Capacity admission, write-through, and exact revision ACKs**:
  - Before mutating local caches, identity policy writes check pending entry and byte budgets (`STORAGE_PENDING_MAX_ENTRIES`, `STORAGE_PENDING_MAX_BYTES`), then update the local cache, assign a monotonic revision, and post to Disk I/O.
  - Pending budgets are released only when the Disk I/O Worker returns an ACK matching the latest revision.
  - Disk I/O commits buffered mutations in a single SQLite transaction when pending entries reach their batch threshold (`IDENTITY_WRITE_BATCH_MAX_ENTRIES` for identity policies and outbox, `STATE_MANAGED_CHAT_LIMIT` for chat states, `CHAT_QA_WRITE_BATCH_MAX_ENTRIES` for chat Q&A, `AD_PACK_BLACKLIST_WRITE_BATCH_MAX_ENTRIES` for ad pack blacklists) or the `IDENTITY_WRITE_FLUSH_INTERVAL_MS` timer fires.
  - Transaction failures retain buffered mutations and retry with exponential backoff; exceeding `STORAGE_WRITE_MAX_FAILURES` triggers a fatal shutdown so the runner stops accepting updates.

- **Super administrator permissions derive from identity, not database rows**:
  - `SUPER_ADMIN_USER_ID` receives all-`true` permissions directly in code without reading or writing database rows.
  - `/white` and `/permission` reject the current chat's own ID as a target. Delegated `/white enable` callers can only add members with default permissions; removing allowlist members or editing permission bits is restricted to `SUPER_ADMIN_USER_ID`.

- **Bot identity and AI configuration boundaries**:
  - `bot_token`, `super_admin_user_id`, and optional `log_level` (defaulting to `DEFAULT_LOG_LEVEL`, `"operation"`, when omitted) come exclusively from `config/static/bot.json`; startup validation completes before connecting to Telegram and propagates `log_level` into the per-thread logger threshold holders (`packages/cache/perThread/logger.ts`) across the main thread and every Worker.
  - **Per-capability explicit AI clients**:
    - `config/dynamic/agent.json` configures `provider`, `api_key`, optional `base_url`, and `model` independently per capability with zero cross-capability fallback; `agent.ad_detect` under `provider: "google"` additionally accepts optional boolean `use_decision` (default `false`, rejected on `openai`, `anthropic`, and all other capabilities).
    - OpenAI, Anthropic, and Gemini SDK clients are constructed with explicit credentials, explicit base URLs (defaulting to each provider's official endpoint when `base_url` is omitted), and options that disable implicit environment-variable reads for keys, endpoints, and SDK log levels (all Gemini clients explicitly set `httpOptions.apiVersion: GEMINI_API_VERSION` and `enterprise: false`, isolating `GOOGLE_GENAI_API_VERSION` and Vertex/Enterprise environment variables).
    - Because their SDKs expose no constructor flag to ignore `SDK_REQUEST_HEADER_ENVS` (`ANTHROPIC_CUSTOM_HEADERS`, `OPENAI_CUSTOM_HEADERS`, `GOOGLE_GENAI_USER_PROJECT`, and `GOOGLE_GENAI_DEBUG`—the first two merge into every request and can override `Authorization`, while the latter two are read directly by `@google/genai` NextGen clients to inject `x-goog-user-project` or log unredacted output to `console`), `packages/consts/paths.ts` aborts startup whenever any of them is present in `process.env`.
  - **Main-thread-only file reads**: Only the main thread reads `agent.json` (at startup and on hot reload) and pushes read-only snapshots to Workers; Worker threads never read config files from disk.
  - **Capability gates**: Core AI chat requires `text`, `summary`, and `media`. Omitting `image` or `tts` disables only those tools; omitting `ad_detect` disables automated ad detection.

- **Dynamic media modality probing**:
  - The AI Worker probes each media input modality (`image`, `sticker`, `voice`) on its first live request, advancing per-modality state via `reduceMediaInputResult`.
  - Each probe settles into `supported`, `unsupported` (provider explicitly rejects the modality), or `misconfigured` (invalid model or base URL, HTTP 404/405); transient errors back off between `MEDIA_PROBE_BACKOFF_BASE_MS` and `MEDIA_PROBE_BACKOFF_MAX_MS` for up to `MEDIA_PROBE_MAX_TRANSIENT_FAILURES` attempts.
  - Once marked `unsupported` or `misconfigured`, that modality skips media downloads on subsequent messages until a `config/dynamic/agent.json` hot reload resets the probe table.

- **Configuration directory layout check** (`packages/config/layout.ts`):
  - Before parsing `bot.json`, `packages/config/bot.ts` runs `assertNoLegacyOrMisplacedBotConfig` to check top-level `config/` entry names for legacy `telegram.json` or misplaced `bot.json`; the installer (`assertNoMisplacedConfigFiles`), startup preflight (`assertDeploymentConfigLayout`, run after acquiring `bot.lock` and `cleanupOrphanedTempFiles`), and dynamic reload (`readDynamicConfigLayoutRejections`) enforce a strict three-level directory whitelist:
    - `config/`: only `static/` and `dynamic/` subdirectories (`config/dynamic/` must exist as a physical directory).
    - `config/static/`: only `bot.json` and `g-auth.json`.
    - `config/dynamic/`: only `assets.json`, `ad_detect.json`, `agent.json`, `mood.json`, `stickers.json`, and `cron.json`.
  - Non-directories or dangling symlinks at any config directory path, misplaced files, legacy files (`telegram.json`, `ad_samples.json`), hidden/swap/backup files, and undeclared subdirectories are rejected before file contents are read. Every new deployment config file must be registered in `STATIC_ALLOWED_NAMES` or `DYNAMIC_ALLOWED_NAMES` in `packages/config/layout.ts`.

- **Dynamic hot reload via `config/dynamic/`**:
  - **Debounced watcher**: After Workers start, the main thread watches `config/dynamic/` via filesystem notifications and coalesces burst writes with `CONFIG_RELOAD_DEBOUNCE_MS` into serial reload passes (`config/static/` requires a restart).
  - **Atomic preflight and cross-file check**:
    - `packages/config/reload.ts` first runs `readDynamicConfigLayoutRejections` and then runs the same strict schema validators as startup; any non-whitelisted entry or malformed file aborts the reload, logs an error, and keeps the previous valid snapshots active. Byte-identical snapshots are skipped as no-ops.
    - Cross-file check (`assertCronAgentSupported`): if `cron.json` declares `send_voice` or `send_web_digest` actions, reload verifies that `agent.json` supplies `tts` or core conversational capabilities (`AGENT_AI_CHAT_REQUIRED_CAPABILITIES`: `text`, `summary`, `media`) respectively before committing the new snapshots.
  - **In-flight AI session isolation**:
    - Adopting a new `agent.json` snapshot drops cached capability facades and SDK clients in the AI Worker so subsequent calls rebuild them lazily.
    - Each AI reply pins its `text` model and client when the reply session starts and keeps them across every tool round of that reply (including Anthropic `pause_turn` continuations).
  - **Readiness transitions and secret redaction**:
    - Applying a reload recomputes feature readiness: capabilities transitioning to ready wake or re-hydrate Workers, while capabilities transitioning to unavailable stop new tasks and reject toggle commands without erasing persisted per-chat switches.
    - All newly loaded tokens and API keys are registered with the logger redaction table, and sensitive field/header names in `LOGGER_SENSITIVE_FIELD_NAMES` (including `x-goog-api-key`) are redacted in structured and inline logs.
- **Mini App temporary session keys, AES-256-GCM transport, and online config save boundaries**:
  - **Per-startup in-memory Ed25519, ephemeral X25519 ECDH handshake, 5-session cap, and 2-hour max lifetime**: On each startup, `startMiniAppServer` generates an in-memory non-extractable Web Crypto `Ed25519` signing keypair (`ensureMiniAppRuntimeSigningKeyPair`, cleared on shutdown via `clearMiniAppRuntimeSigningKeyPair`), and `handlers/page.ts` injects its 32-byte raw public key Base64 into bundled JS chunks (`MINI_APP_SERVER_SIGNING_PUBLIC_KEY_PLACEHOLDER`) while recomputing `ETag`. When unlocked sessions are absent, `GET /api/auth/precheck` issues an ephemeral `X25519` offer (`handshakeId`, `serverPublicKey`, `expiresAt`, bounded by `MINI_APP_HANDSHAKE_MAX` with TTL `MINI_APP_HANDSHAKE_TTL_MS`) signed by the runtime `Ed25519` private key (`MINI_APP_HANDSHAKE_SIGNATURE_DOMAIN`); already-unlocked requests perform read-only verification without rotating tokens or issuing keys. The client verifies the `Ed25519` signature (performing a single `location.reload()` guarded by a 10-second `sessionStorage` loop window on `signatureMismatch`, or failing closed without reload as `WEBCRYPTO_UNSUPPORTED` when Web Crypto is unavailable), generates an ephemeral `X25519` keypair, derives direction-separated `c2sKey` / `s2cKey` via `ECDH + HKDF-SHA256`, and encrypts `POST /api/auth/login` under `c2sKey` (`MINI_APP_LOGIN_REQUEST_AAD`, mutually exclusive `{ handshakeId, password }` or `{ handshakeId, totpCode }`). `miniAppInFlightHandshakeIds` blocks concurrent replay, `handshakeId` is destroyed immediately on consumption or failure, and `200`/`403` responses are encrypted under `s2cKey` (`MINI_APP_LOGIN_RESPONSE_AAD`, rejecting plaintext downgrades), clearing `pendingSessionKey` right after response serialization and recording `miniAppLastConsumedTotpStepHolder` only once TOTP verification and session issuance succeed. At most `MINI_APP_SESSION_MAX` (`5`) unexpired 45-minute sessions and 256-bit keys (`MINI_APP_SESSION_KEY_BITS`) are cached (when full, a new login evicts the session whose issuance or latest rotation is oldest and revokes its download tickets). Each epoch uniformly samples its next sliding-rotation cooldown within `[MINI_APP_SESSION_REFRESH_MIN_MS, MINI_APP_SESSION_REFRESH_MAX_MS]` (5s–5min) and also proactively rotates whenever `seenRequestIvs.size` reaches `MINI_APP_SESSION_ROTATE_AT_SEEN_IVS` (3,072)—resetting the new epoch's IV set and re-sampling the cooldown—decoupled from the 5-minute `MINI_APP_SESSION_PREVIOUS_GRACE_MS` in-flight window for `previousToken`/`previousCryptoKey`; total lifetime per login is capped at `MINI_APP_SESSION_MAX_LIFETIME_MS` (2 hours, allowing `initData.auth_date` up to `2 hours + 45 minutes` while active). `sessionKey` is issued solely on `POST /api/auth/login` and encrypted-response sliding renewal (`X-Mini-App-Session-Key`, `additionalData = UTF8(newToken)`), stored by the client only as a same-generation `{ token, cryptoKey }` IndexedDB pair (non-extractable `CryptoKey`, authoritative on hydration) plus `sessionStorage` token metadata (never in `localStorage`, HTTP requests, or `globalThis`); on rotation commit the server synchronously starts a shared `sealedSessionKeyPromise` (resolving solely to the sealed ciphertext without storing `pendingSessionKey`), records the settled ciphertext in `sealedSessionKey`, and clears both once the new token is confirmed or the grace window expires—during which encrypted-response requests carrying `previousToken` await that same `sealedSessionKeyPromise` or read `sealedSessionKey` to re-attach the same new token and ciphertext without rotating again.
  - **AES-256-GCM envelopes, encrypted binary uploads, `?e=` URL queries, and two-phase atomic commit**: Session-authenticated business JSON routes wrap payloads in `MiniAppEncryptedEnvelope` (`AES-GCM`, `MINI_APP_AES_GCM_IV_BYTES` IV, `MINI_APP_AES_GCM_TAG_BITS` tag) bound via `buildMiniAppEnvelopeAad` to `"${method} ${routePath}:req"` / `":res"`, while `POST /api/gallery/upload` enforces `[12B IV || ciphertext+16B tag]` binary frames encrypted under `sessionKey`; non-`GET`/`HEAD` encrypted routes reject `0`-byte bodies (no-payload POST/DELETE send encrypted `"{}"`). Every `encryptRequest: true` route encrypts non-empty query strings into `?e=<ivBase64>.<cipherBase64>` (`MINI_APP_ENCRYPTED_QUERY_PARAM`, ciphertext cap `MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH`) allowing only a single `e` parameter with AEAD `additionalData = "${method} ${routePath}"` (rejecting bare `?`, plaintext/extra parameters, empty or `?`-prefixed decrypted queries, and replayed IVs; `seenRequestIvs` has hard cap `MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS` = 4,096 per key epoch with proactive sliding rotation at `MINI_APP_SESSION_ROTATE_AT_SEEN_IVS` = 3,072 on encrypted-response routes, revoking on hard-cap overflow with `401`). `runMiniAppAuthorized` uses two-phase execution (read-only `authorizeMiniAppRequest` -> async decrypt -> `commitMiniAppSessionAccess` atomic re-verification, IV commitment, supersession cleanup, and sliding rotation), preventing async-decrypt TOCTOU races (`replay` -> `400 INVALID_ENCRYPTED_PAYLOAD`, mid-decrypt session revocation -> `401 SESSION_EXPIRED`, a token rotated and confirmed mid-decrypt commits on the live session found by its `lineageId` against the key epoch seen at lookup without rotating, and failed `400` decrypts preserve `previousToken` without rotating). On encrypted-response routes, the client decrypts and validates the response body before applying rotation headers and classifies auth failures centrally in `packages/mini-app-frontend/api/authError.ts` with a private `Symbol`-tagged `sentSessionToken` context on transport errors: session re-authentication errors (`MINI_APP_SESSION_REAUTH_ERROR_CODES`, decrypt/unseal failures, and bare HTTP `401`) clear matching local credentials and redirect to `AuthGatePage`, while Tier-1 gate/lockout/WebCrypto rejections (`MINI_APP_ACCESS_DENIED_ERROR_CODES`) unconditionally clear credentials—except the session-extended `MINI_APP_EXPIRED_AUTH_DATE_CODE` (`EXPIRED_AUTH_DATE`), which guards against stale-token clears—and transition through `checking` re-precheck to `AccessDeniedPage`; stale-token re-auth and `EXPIRED_AUTH_DATE` responses from superseded tokens are suppressed across transport and global `notify()` so newer sessions are neither cleared nor locked, while current-session redirects are never swallowed by stale-request guards or downgraded back to `password` by trailing `401`s.
  - **Binary download dual paths and exemptions**: Among session-authenticated `/api/*` routes, `encryptResponse: false` (unencrypted response without rotating keys) applies strictly to `GET|HEAD /api/gallery/file` (`MINI_APP_GALLERY_FILE_AUTH_POLICY`: header auth + `?e=`, 7-day `MINI_APP_GALLERY_FILE_CACHE_CONTROL`, `CDN-Cache-Control: no-store`, `Vary: MINI_APP_GALLERY_FILE_VARY_HEADER_VALUE`, and `ETag` `304`) and `GET|HEAD /api/gallery/download` (`MINI_APP_GALLERY_DOWNLOAD_AUTH_POLICY`: browser fallback using auth headers + `?e=` + `blob:` save; Telegram native `WebApp.downloadFile` using 60s single-use 64-hex `?ticket=` issued by encrypted `POST /api/gallery/download-ticket`, FIFO cap `MINI_APP_DOWNLOAD_TICKET_MAX` = 64, non-consuming on `HEAD`, single-consume on `GET`, bound to the login-stable `sessionLineageId` so tickets stay valid across session rotations and are revoked immediately by lineage on logout/lockout/expiry/eviction/IV-cap/TOTP-change/delete). `/api/auth/precheck`, `/api/auth/logout`, SPA/bundle/`/healthz`, and public `/favicon.ico` (`MINI_APP_ASSET_CACHE_CONTROL`) remain unencrypted; `POST /api/auth/login` uses ephemeral ECDH (`c2sKey`/`s2cKey`); and `POST /api/gallery/upload` (`MINI_APP_GALLERY_UPLOAD_AUTH_POLICY`) encrypts both its binary request frame and its JSON response under `sessionKey`.
  - **Direct session-encrypted config save, content blacklist management, and validation gates**: `POST /api/configs/save` (`MINI_APP_CONFIG_SAVE_AUTH_POLICY`, outer body cap `MINI_APP_MAX_CONFIG_BODY_BYTES`) submits `{ scope, fileName, content }` directly inside the session `AES-GCM` envelope; `saveMiniAppConfigFile` serializes validation and atomic writes via `runSerialChain` (`packages/libs/serialChain.ts`) over the shared main-thread holder `deploymentConfigWriteChainHolder` (`packages/cache/main/configWrite.ts`) to eliminate cross-file validation TOCTOU races (`agent.json` ↔ `cron.json`) and concurrent config-save overwrites. Before writing, it enforces `MINI_APP_DYNAMIC_CONFIG_FILES` / `MINI_APP_STATIC_CONFIG_FILES` allowlists, strict domain parsers (with `g-auth.json` sharing startup's `parseGoogleServiceAccountKey`), `bot.json` `time_zone` immutability once `database/storage.sqlite` exists, bidirectional `agent.json` ↔ `cron.json` capability checks (preferring on-disk counterparts), and non-symlink regular-file checks (`inspectOptionalFile`). The **Content Blacklist** (`adBlacklists`) tab routes (`GET|POST /api/ad-blacklists` and `GET /api/ad-blacklists/preview`, all under `MINI_APP_API_AUTH_POLICY`) operate under the same session-encrypted envelope boundary: `GET /api/ad-blacklists` cold-reads SQLite cursor pages via `listAdPackBlacklistPage` (overlaying unacked writes without polluting the main-thread 768-entry LRU cache); `POST /api/ad-blacklists` reuses `packages/infra/adPackBlacklistStorage.ts` shared with `/ad_detect sticker|emoji` for pack-name validation, bot own-pack protection, 768-entry LRU write-through, and Anti-Raid count sync (with no per-kind entry cap); and `GET /api/ad-blacklists/preview` (`packages/mini-app-api-server/view/adBlacklistsPreview.ts`) queries `telegramApi.getStickerSet` on the main thread, slices pages by `MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE` (16), returns metadata + `hasImage` flags on `metaOnly=1`, and on `metaOnly=0` downloads static thumbnails through `runBoundedSettledBatch` (`MINI_APP_AD_BLACKLIST_PREVIEW_DOWNLOAD_CONCURRENCY` = 4, `MINI_APP_AD_BLACKLIST_PREVIEW_ITEM_MAX_BYTES` = 512 KiB per item, `MINI_APP_AD_BLACKLIST_PREVIEW_BATCH_TIMEOUT_MS` = 15 s) + `downloadTelegramFileBytes` + magic-byte sniffing into inline `data:image/...;base64,...` (forwarding `request.signal` for cancellation and degrading per-item failures to `null`).

### Data Root and Background Tasks

- **Data root derivation**:
  - Every runtime path (`bot.lock`, `logs/`, `database/`, and `memory/`) derives from `COPY_NINJIA_DATA_ROOT` (defaulting to the repository root).
  - Test suites inject isolated temporary data roots prior to module imports.
- **Low-priority group title maintenance**:
  - Runs asynchronously in the background after startup, handler registration, and runner launch complete.
  - Executes `getChat` across known chats via `runBoundedSettledBatch` at concurrency `CHAT_TITLE_REFRESH_CONCURRENCY`, isolating per-chat failures and honoring shutdown signals.
  - **Absence classification** (`classifyChatAbsence` in `infra/telegram/errors.ts`):
    - `gone`: HTTP 400 with description `chat not found` or `group chat was upgraded to a supergroup chat`, or carrying `parameters.migrate_to_chat_id`.
    - `departed`: HTTP 403 with description `bot was kicked from the (super)group chat` or `bot is not a member of the (super)group chat`.
    - All other errors are logged without tearing down chat state.
  - **Multi-probe confirmation**: Unreachable chats are re-probed every `CHAT_ABSENCE_CONFIRM_INTERVAL_MS` until `CHAT_ABSENCE_CONFIRM_ATTEMPTS` total probes complete. Only when every probe returns the identical absence class does `completeChatDeparture` tear down the chat (emitting a single warning). A successful `getChat`, a different error/class, or prior removal from `chat_states` abandons confirmation for that run.
  - **Immediate shutdown quiesce**: Inter-probe sleeps listen on `chatTitleRefreshRuntime.absenceConfirmation`, so shutdown quiesce or abort wakes them immediately while any in-flight `getChat` finishes within the maintenance budget.

### Outbound Requests and Message Safety

- **Main thread owns Telegram networking**:
  - The grammY `Bot` instance, raw HTTP transport, and CDN file downloads live exclusively on the main thread.
  - AI and Anti-Raid Workers hold neither Bot tokens nor HTTP clients; they invoke allowlisted actions over duplex IPC channels backed by the main-thread outbound gateway (Anti-Raid Worker's `downloadFile` allowlist is strictly restricted to `purpose === "vision"`).
  - **Worker send projections**:
    - Worker sends (`sendMessage`, `sendSticker`, `sendPhoto`, `sendVoice`) register the full sent message in the main-thread self-sent table first, then return only `{ message_id, link }` (`TelegramSentMessage`, plus the single `PhotoSize` selected by `pickPhotoSize` for `sendPhoto`).
    - All other allowlisted Worker calls return their result unchanged.
    - Main-thread-only primitives (`sendEphemeralMessage`, `copyMessage`, `editMessageText`, `deleteEphemeralMessage`, `unbanChatSenderChat`) are not exposed to Workers.

- **Unified outbound gateway with token bucket scheduling and 429 backoff**:
  - Outbound calls enter category-specific lanes (`send`, queries, deletions, restrictions, kicks, `download`, `externalFetch`).
  - **Token-bucket rate limiting**: Message sends pass through per-chat burst (`TELEGRAM_SEND_CHAT_BURST` / `TELEGRAM_SEND_CHAT_REFILL_MS`), group-chat window (`TELEGRAM_SEND_GROUP_LIMIT` / `TELEGRAM_SEND_GROUP_WINDOW_MS`), and global window (`TELEGRAM_SEND_GLOBAL_LIMIT` / `TELEGRAM_SEND_GLOBAL_WINDOW_MS`) buckets.
  - **429 smart backoff and fault isolation**:
    - On HTTP 429 for a message send, only **that target chat's** send queue pauses for `retry_after`; other chats continue unimpeded.
    - Non-message categories maintain independent backoff timers so throttling in one category never stalls another.
    - `download` carries only `getFile` and Telegram file-CDN fetches, whereas default-avatar URLs and `telegram.me` public profile/avatar fetches use `externalFetch`; an external HTTP 429 never stalls Telegram media downloads, while both still pass through the main-thread outbound gate.
    - Entering a new backoff window logs one warning with the category and wait duration; additional 429 responses during the active window are coalesced silently.
  - **Distinct timeout vs cancellation errors**:
    - Exhausting a caller's timeout budget rejects with `TimeoutError` across the outbound gate, send scheduler, and Worker duplex bridge; shutdown revocation and caller `AbortSignal` cancellation reject with `AbortError`.
    - `infra/telegram/fileDownload.ts` maps per-stage `getFile` and CDN stream timeouts to structured `metadataTimeout` and `downloadTimeout` outcomes, while caller cancellation or outer-budget expiry still throws.

- **Echo loop and self-sent message prevention**:
  - Every bot-authored outbound message is recorded at the outbound proxy boundary for `SELF_SENT_MESSAGE_TTL_MS`.
  - In groups linked to channels that auto-forward posts, inbound updates wait up to `SELF_SENT_RENDEZVOUS_TIMEOUT_MS` for in-flight self-sends to register before evaluating auto-reply triggers.

- **Outbound rich-text safety**:
  - Formatted outbound messages use one of two explicit contracts:
    1. **Explicit `entities` arrays**: Callers compute exact UTF-16 code-unit offsets and pass structured entities without `parse_mode`.
    2. **`MarkdownV2` mode**: Every dynamic string (display names, model outputs, config copy) is escaped via [`libs/telegramMarkdown.ts`](../../packages/libs/telegramMarkdown.ts); raw string interpolation is forbidden, and parse errors log an error without falling back to unescaped plain text.
  - Plain-text notices omit `parse_mode` and `entities` entirely.

- **Command guard (`containsRenderableCommand`)**:
  - All bot-authored text and captions (echo repeats, AI replies, image captions, cron digests) pass through `containsRenderableCommand` (`RENDERABLE_COMMAND_PATTERN`).
  - Repeat mode checks the **final transformed text** (for example after reversal) rather than the raw source text, dropping any output that would render a clickable `/command`.

- **Mute duration bounds and dispatch deadlines**:
  - `/mute` durations must fall within `[MUTE_MIN_DURATION_MS, MUTE_MAX_DURATION_MS]` (strictly below `TELEGRAM_RESTRICTION_FOREVER_AFTER_MS`).
  - Restriction calls carry a `dispatchTimeoutMs` deadline (requiring at least `MUTE_DISPATCH_MIN_REMAINING_MS` remaining for `/mute` and `FLOOD_MUTE_DISPATCH_TIMEOUT_MS` for flood mutes); queued requests whose deadline expires before leaving the queue are abandoned without calling Telegram.

- **Auto-deletion for non-functional group notices (`COMMAND_MESSAGE_AUTO_DELETE_MS`)**:
  - Group validation errors, permission denials, usage prompts, and command receipts schedule automatic deletion after `COMMAND_MESSAGE_AUTO_DELETE_MS` (30 s) through the shared notice boundary.
  - **Permanent retention allowlist**: `/permission help` and `/permission query` boards, `/qa query` boards, direct Q&A answers, successful CJK action replies, `/h_image` spoiler photos, `cron.json` scheduled messages, and conversational outputs (echoes, translations, AI replies, bath replies).
  - **State-machine-owned messages**: Join-verification prompts, `/qa set` forms, `/wed` cards, and gag notices/prompts carry no fixed timer and are deleted solely by button handlers, state transitions, or chat teardown (`/wed` cards evicted from the active session window stay in chat).

- **Forum topics (`message_thread_id`) routing and background scope isolation**:
  - **User-triggered replies**: Command notices, state-machine prompts, and conversational replies inherit the triggering message's `message_thread_id` (injected automatically by the main-thread send boundary within an update context, or passed explicitly when sending outside an update).
  - **Proactive broadcasts**: Bot-initiated alerts (flood-mute notices, ad warnings and ban announcements, verification reminders, lockdown announcements) and `cron.json` tasks omit `message_thread_id`, landing in General in forum supergroups.
  - **Detached background loops, timers, and queues**: Background queues and timers (`packages/copy/avatarQueue.ts`, `packages/infra/telegram/actions/messageLifecycle.ts`, `packages/commands/gag/refresh.ts`, `packages/translate/message.ts`) leave the triggering update's `AsyncLocalStorage` context via `runOutsideUpdateScope` (`packages/infra/updateContext.ts`) so they never inherit the triggering update's `AbortSignal` or forum topic; detached executors needing their own cancellation scope or preserved topic enter `runWithUpdateAbortSignal` explicitly (`commands/wed/runtime.ts`, `commands/deferredCommands.ts`, `commands/deleteMessage/queue.ts`).

- **Consistency in toggle command feedback**:
  - Toggle commands (`/init`, `/ai_chat`, `/ad_detect`, `/antiraid`, etc.) compare the requested state against the current state and report "already in this state" on a no-op.
  - `/init disable` and Mini App chat `init` disable share `disableManagedChat` in `packages/infra/botAdmin.ts`: the `init = false` flag is durably committed first, after which runtime caches and AI memory are torn down and the pruned chat state is persisted.

<p align="right"><a href="#quick-navigation">↑ Back to quick navigation</a></p>

## Worker and State Ownership

### Thread and State Ownership

- **Strict thread state boundaries without shared memory**:
  - **Main thread**: Owns the Telegram update runner, Worker supervisors, the per-chat `chat_states` hot snapshot (`packages/infra/chatStateStorage.ts`), the 768-entry shared ad pack blacklist LRU read cache, counts, and unacknowledged write tracking (`packages/cache/main/adPackBlacklist.ts` and `packages/infra/adPackBlacklistStorage.ts`), and the in-memory mirror of `memory/global/state.json` (`cache/main/storage.ts`).
    - `infra/storage/stateStore.ts` is the domain facade for `memory/global/state.json` (`copy` and `ttsUsage`), hydrating the mirror on startup and assembling domain snapshots; per-chat state lives separately in SQLite `chat_states` via `infra/chatStateStorage.ts` and the Disk I/O Worker.
    - `StateStore` in `infra/storage/statePersistence.ts` strictly decodes via `decodeGlobalStateFile` (`libs/stateFileCodec.ts`) and drives latest-only atomic file writes, bounded retry backoff (`STATE_SAVE_RETRY_DELAYS_MS`, `STATE_SAVE_MAX_ATTEMPTS`), and shutdown flushes.
    - While a retry timer is pending, new writes awaiting durability and non-shutdown flushes leave the latest snapshot for that scheduled retry without firing early or spending extra attempts; a shutdown flush cancels the timer and writes immediately when its budget is positive; with a zero budget it starts no new write and settles as `timedOut` while a dirty or in-flight write remains, or as `flushed` when there is neither.
    - Exhausting `STATE_SAVE_MAX_ATTEMPTS` is a fatal durability failure that stops the runner immediately before any further Telegram update offsets are acknowledged.
  - **AI Worker**: Exclusively owns rolling group-chat memory, reply admission evaluation, multimodal media description pipelines, global mood state, and sticker catalog indexing.
  - **Anti-Raid Worker**: Exclusively owns the join-verification and lockdown state machines and their timers; the main thread holds read-only crash-recovery mirrors.
  - **Disk I/O Worker**: Exclusively owns SQLite (`database/storage.sqlite`), diagnostic/join logs, AI memory snapshots, sticker catalogs, fortune records, and pending-verification snapshots, serializing shared-directory I/O on one thread.
    - Only `memory/global/` (`stateStore.ts` and `statePersistence.ts`), `memory/mini-app-totp/totp.json` (`mini-app-api-server/auth/totpStorage.ts`), and whitelisted `config/{dynamic,static}/*.json` files (exclusively through the Mini App config editor `mini-app-api-server/view/configs/storage.ts`, serialized on `deploymentConfigWriteChainHolder`; ad detection and auto-blacklisting never modify `config/dynamic/ad_detect.json`) are written atomically by the main thread; business Workers never touch shared storage directories directly.
  - **Long-lived container contracts**: Every persistent `Map`, `Set`, queue, and timer in `packages/cache/` documents its owner, population/eviction triggers, capacity bound, and Worker respawn reconstruction rule.

- **Cache file ownership is declared by directory structure and verified statically**:
  - The top-level subdirectory under `packages/cache/` declares the sole thread owner:
    - `main/`: Main thread only.
    - `workers/aiChat/`, `workers/antiRaid/`, `workers/diskIO/`: Respective Worker thread only.
    - `perThread/`: Independent per-isolate instance (Telegram capability holders, Worker duplex waiters, deployment config singletons, self-sent message table, update cancellation scopes).
  - Every cache module starts with `/** owner: <main|perThread|workers/<thread>>。` matching its directory.
  - Threads share zero mutable memory and communicate strictly by IPC messages. `bun run check:conventions` walks runtime import closures from `index.ts` and each `*Worker.ts`, failing with the full import chain on any cross-owner import.
  - **Exemption registry**: Cross-owner exemptions must be listed in `CACHE_OWNER_EXEMPTIONS` (currently empty). `infra/logger.ts` avoids importing `infra/diskIO.ts` by routing main-thread logs at or above the configured `log_level` through `logRelaySink` in `cache/perThread/logger.ts` (wired to `relayLogMessage` by `initDiskIO`), while Worker logs at or above `log_level` batch-forward to the main thread first.

- **Workers requiring main-thread state receive pre-evaluated final values**:
  - Workers receive resolved scalar/snapshot payloads (for example `SUPER_ADMIN_USER_ID` arrives in the AI Worker's `init` payload rather than importing `config/bot.ts`).
  - Worker Telegram actions send minimal allowlisted payloads to the main thread instead of mirroring Bot tokens, HTTP clients, or rate-limit queues.
  - High-frequency per-message paths never perform duplex request/reply round-trips; duplex awaits are reserved for actions that inherently depend on a remote result.

- **IPC failure handling and two-hop log forwarding**:
  - Synchronous `postMessage` failures are handled explicitly: duplex callers clear timers and reject waiters immediately, while critical control/persistence dispatches trigger fatal shutdown.
  - **Two-hop accepted-log (`>= log_level`) ACK pipeline**:
    1. Hop 1: Business Worker → Main thread (at most `LOGGER_FORWARD_BATCH_MAX_MESSAGES` in flight).
    2. Hop 2: Main thread → Disk I/O Worker (at most `DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES` in flight).
    - **Main-thread log buffering**: `info`, `operation`, and `warn` logs wait in the main-thread `diagnosticQueue` until reaching `DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES` entries or firing the `FLUSH_INTERVAL_MS` (30-second) timer, whereas `error` logs, overflow drop summaries, non-log diagnostics (`adSample` / `aiCacheUsage`), and explicit `flushDiskIO()` / `flushDiskIODomain("log")` calls flush immediately.
    - Each hop retains its batch until downstream ACK arrives: unacknowledged in-flight batches replay across Worker respawns, while still-buffered normal-level logs keep waiting on their existing batch/timer window. Disk I/O ACKs only after the log write flushes to disk; disk open/write failures enter exponential reopen backoff that new batches cannot bypass.
  - **Bounded backpressure and drop summaries**:
    - Per-Worker pending + in-flight buffers cap at `LOGGER_FORWARD_MAX_PENDING_MESSAGES` messages and `LOGGER_FORWARD_MAX_SERIALIZED_BYTES` bytes; Main → Disk I/O caps at `DISK_DIAGNOSTIC_MAX_PENDING_MESSAGES` messages and `DISK_DIAGNOSTIC_MAX_SERIALIZED_BYTES` bytes.
    - Overflowing logs are dropped immediately while incrementing dropped-message and dropped-byte counters, emitting a single summary line once buffer space recovers; accepted logs have already written directly to the originating thread's console stream (`stdout`/`stderr`).

- **Concurrent batch processing principles**:
  - Production code avoids raw `Promise.all` for batch execution.
  - Fixed independent task sets use `Promise.allSettled` and inspect every settled outcome individually.
  - Variable-length inputs run through `runBoundedSettledBatch` with an explicit concurrency cap, executing each element once and preserving input index order.
  - Callers do not wrap side-effecting calls in outer retry loops when the underlying layer (such as the Telegram outbound gateway) already owns retry/backoff semantics.
  - Shutdown drainers may `Promise.allSettled` over registered task snapshots directly when each tracked task handles its own errors without leaking unhandled rejections.

- **Disk I/O runtime recovery handshake**:
  - **Indivisible generation-scoped sequence**: After opening storage, a respawned Disk I/O Worker replays main-thread mirrors in registration order over generation-scoped transport (`await`ing async replay handlers), then drains the recovery-window business FIFO before marking the Worker writable.
  - **Hold-and-verify bracket (`storageFlushHold`)**:
    - Mirror replay runs between `storageFlushHold` open and close markers. While open, automatic batch/timer SQLite commits queue on timers, AI memory context deletions and first post-purge snapshots wait on hold, and cross-row aggregate invariants for `chat_states` (`STATE_MANAGED_CHAT_LIMIT` and `/send` target uniqueness) and `chat_qa` (per-chat entry cap) defer until close.
    - On close, waiting AI memory purges/snapshots flush immediately and deferred aggregate invariants are verified: any domain failing verification discards its held writes without committing invalid state and reports `recoveryReplayFailed` (triggering fatal main-thread shutdown), while valid domains commit in one transaction. Explicit shutdown flushes bypass the hold.
  - **Strict failure propagation**: Any replay listener returning `false`, throwing, rejecting, timing out, or hitting `postMessage` failure aborts that Worker generation and triggers fatal shutdown; stale generation callbacks are ignored. Callers that require durability treat `false` as failure and withhold update acknowledgement.
  - **Recovery FIFO vs steady-state write errors (`recoveryReplay`)**: Normal online SQLite write failures surface domain errors and only turn fatal after exhausting `STORAGE_WRITE_MAX_FAILURES` retries, whereas any rejection inside the `recoveryReplay` (`RecoveryReplayRequest`) bracket immediately returns `recoveryReplayFailed` and triggers fatal shutdown so Telegram redelivers from the last durable offset.

- **Bounded Main-to-Disk-I/O business transport**:
  - Queued plus in-flight business messages are capped at `DEFAULT_MAX_PENDING_BUSINESS_MESSAGES` and `DISK_BUSINESS_MAX_RETAINED_BYTES`, reserving `DISK_OPERATION_CONTROL_RESERVE` slots for control/flush commands.
  - At most one batch of up to `DISK_BUSINESS_BATCH_MAX_MESSAGES` messages is in flight at a time, and the Worker's internal serial queue caps at `DISK_WORKER_MAX_QUEUED_OPERATIONS`.
  - Transport batch ACKs release queue budget, while domain revision ACKs confirm durable commits; missing a batch ACK within `DISK_BUSINESS_ACK_TIMEOUT_MS` triggers fatal shutdown. Inside `packages/workers/diskIO/`, timed SQLite batch flushes share `workers/diskIO/timedFlush.ts` (`armDiskIOFlushTimer`, which calls `unref()` on its timer, and `queueTimedDiskIOOperation`, which coalesces due flushes into one queued operation).
  - Across Worker respawns, the business FIFO stays intact: mirrors suppress superseded queued writes via revision numbers and object markers, requests that failed before replay reject their waiters immediately, and replayed in-flight requests settle once the respawned Worker finishes them.

- **Main thread unifies sending and cleanup of Worker notices**:
  - AI rate-limit notices, lockdown-release notices, verification notices, and flood-mute announcements all auto-delete after `COMMAND_MESSAGE_AUTO_DELETE_MS`.
  - Workers send these notices exclusively through `sendTemporaryMessageFromMain`, inheriting group notice lifetime rules and optional `replyToMessageId` anchors.
  - The 30-second deletion timer (`unref()`ed) is armed inside the send's `onSent` hook before returning the `messageId` to the Worker, and deletion errors route through standard Telegram error logging.
  - Interactive verification prompts and `/qa set` forms stay state-machine-owned, and inline fortunes are answered directly via `answerInlineQuery`.

- **Ingress rate-limiting for other bots**:
  - `app/registerHandlers.ts` runs `shouldPassBotMessage` (`infra/botMessageGate.ts`) at update entry before entering preamble business steps.
  - Only messages with `message.from.is_bot === true` and no `sender_chat` are counted; channel personas, non-message updates, and messages from this bot itself pass straight through untracked.
  - Messages sent by a configured `/delete_message` target in that chat are checked before counting: they bypass the counter without extending TTL so the preamble's `/delete_message` ingress can enqueue their deletion.
  - All other bot senders share a global sliding activity map (`BOT_MESSAGE_ACTIVITY_MAX_ENTRIES`): the first `BOT_MESSAGE_ACTIVITY_LIMIT` messages pass and refresh the sender's `BOT_MESSAGE_ACTIVITY_TTL_MS` expiry, while subsequent messages are dropped silently (and new bot IDs arriving when the map is full are dropped without allocating timers).

- **Update dispatch chain and gateway design** (`app/registerHandlers.ts`, `app/updatePreamble.ts`):
  - **Command gateway aggregation**: Slash commands mount on a child `Composer` behind a shared `:entities:bot_command` filter rather than flatly on `bot`, so plain chat messages skip command regex matching in O(1).
  - **Single `bot.use` preamble continuation chain**:
    - `app/registerHandlers.ts` registers exactly one `bot.use` (and zero root `bot.on` handlers, enforced by `test/app/registerHandlers.test.ts` and benchmarked by the `registered-middleware` hot-path gate).
    - After recording `update_id` and checking `shouldPassBotMessage`, execution enters the ordered continuation chain in `app/updatePreamble.ts`:
      1. Fortune inline receipt → `/init` & private-mode gate (uninitialized chats only strip departing `/wed` members) → supergroup migration teardown (`migrate_to_chat_id`) → `/wed` member observation → batch identity prefetch → Mini App `users_shared`/`chat_shared` picker receipt & private `/send` relay.
      2. Four claiming message ingresses in order: Anti-Raid → `/delete_message` targets → gag → `/qa set`.
      3. Slash-command `Composer` → CJK action-command `Composer` → regular message pipeline → non-message update `Composer` (calling the outer `next` at most once when unclaimed).
    - **Chat-state read discipline**:
      - `getChatState` is read once at the `/init` gate and threaded synchronously into `/wed` member observation, Anti-Raid ingress, `/delete_message` ingress, and the message pipeline.
      - Every `Promise` resumption point (identity prefetch, async claiming ingresses, command/CJK `Composer` `next`, and self-sent rendezvous wait) re-reads `getChatState` from the cache so concurrent `/init disable` or chat teardown is observed immediately. New preamble stages must be added inside this continuation chain, never as an extra `bot.use` or `bot.on`.
  - **Synchronous vs `Promise` return contracts**:
    - Ingress gates and bot-admin checks return `boolean | Promise<boolean>`: steady-state checks return synchronous booleans, allocating a `Promise` only when performing on-demand permission probes, message deletions, or durable Disk I/O writes (`/delete_message` target ingress only enqueues and always returns `boolean`).
    - Preamble continuations branch synchronously on `boolean` returns and `await` only when handed a `Promise`.
    - Callback queries (`callback_query:data`) follow the same contract via `claimOrContinue` and non-`async` `dispatchCallbackQuery`: `/wed` and `/qa query` prefix misses return `false` synchronously, calling `next()` into join verification without allocating a `Promise` unless a handler matches.
    - Handlers whose durability gates update acknowledgement (join/leave service events, verification button presses) always return a `Promise` that settles after persistence completes.
  - **Unified message ingress predicate**: Because `TELEGRAM_ALLOWED_UPDATES` omits `edited_message` and `edited_channel_post`, `ctx.msg` inside message continuations is strictly `ctx.message ?? ctx.channelPost`. The CJK action gate checks for a leading `'/'` character before testing `CJK_ACTION_COMMAND_PATTERN`.

- **Worker-owned timers must call `unref()`**:
  - Timer handles owned inside `packages/workers/` must never hold a Worker isolate's event loop open on their own; ordered shutdown completes internal drain/flush phases first and then terminates the Worker from the main thread.
  - Short-lived wait timers in shared libraries (`libs/sleep.ts` signal branch and `libs/drainWaiter.ts`) are explicitly cleared by caller `abort` or `clearTimeout` and therefore do not call `unref()`.
  - `bun run check:conventions` (`scripts/conventions/workerTimers.ts`) statically inspects every `setTimeout` and `setInterval` in `packages/workers/`: each call must assign its handle to a variable or property and call `<target>.unref()` in the same function scope before any subsequent write to that target (unassigned calls such as `return setTimeout(...)` are rejected; main-thread code is exempt).

### State-Machine Contracts

- **Decoupled state machines and pure transitions**:
  - State-machine types (`State`, `Event`, `Effect`, `Transition`, `Decision`) live in `packages/types/states/`.
  - `packages/states/` contains pure deterministic functions with zero I/O; runtime interpreters and caches depend upward on these types.
  - Both direct imports and transitive runtime imports from `packages/states/` are restricted to `consts`, `libs`, `types`, and `states` via full import-graph tracing in `scripts/conventions/moduleBoundaries.ts`. Day-index math in `libs/time.ts` reads the per-thread startup time-zone snapshot through `config/time.ts`, which is the sole opaque boundary exemption (`STATES_CLOSURE_OPAQUE_MODULES`).
  - **Three structural models**:
    - **Discrete state machines**: Domains with durable multi-phase lifecycles (`verification`, `lockdown`), modeled as `transition(state, event) → { next, effects }`.
    - **Pure rule functions**: Stateless single-shot gates (`replyAdmission`, `adDetectAdmission`) that map pre-computed inputs to a decision without internal timers.
    - **Single-record reducers**: Single-entry state advanced by call outcomes or timestamps while container storage and write-back stay outside—`reduceMediaInputResult(current, event) → { next, effects }` (`mediaInputSupport`), `advanceTemporaryAdBypassActivity(current, now) → next` (`temporaryAdBypass`), and `commitReferencedAdWarning` / `cancelsReferencedAdWarning` / `referencedAdWarningWindow` (`adReferenceWarning`). No-op transitions return the exact input reference so callers skip map writes via `===`.

- **Lockdown default chat permission updates must set independent flags**:
  - Every read-modify-write of group default permissions passes `use_independent_chat_permissions: true`.
  - Lockdown entry, scheduled expiry restoration, late-receipt repair, and emergency `/antiraid disable` restoration all go through `packages/workers/antiRaid/lockdownApi.ts` and `packages/infra/telegram/lockdownPermissions.ts`.
  - Both helpers fetch fresh `getChat().permissions`, toggle only `can_invite_users`, and forward all other permission bits and unknown fields unchanged.

- **Lockdown announcements bound to round lifecycle**:
  - `LockdownState.announced` and `announcementMessageId` track announcement state per round (`lockdownRuntime.ts`, `lockdownApi.ts`).
  - Announcement sends enter the per-chat serial queue ahead of permission queries; stale-round sends abort before dispatch, and restoration deletes only that round's recorded `announcementMessageId`.
  - `onSent` records the remote `messageId` before propagating any cancellation. If active-state persistence (`persistState`) or permission restoration fails after the announcement was sent, the group announcement stays visible until restoration succeeds; deletion failures after successful restoration log an error without blocking recovery.

- **Unlock announcements require active lockdown announcements**:
  - An unlock notice is sent only when the round actually posted a lockdown announcement (`announced === true`).
  - **Reason-dependent copy**: Scheduled round expiry sends `lockdownEnded` (including the lockdown duration in minutes), whereas pre-expiry restoration (manual `/antiraid disable`, uncertain commit outcome, or persistence failure) sends `lockdownLifted`. Because the reason is held in memory only, adopting a persisted `RESTORING` record uses `lockdownLifted`, while a manual lift arriving during an already-running expiry restoration keeps `lockdownEnded`.
  - Announcement metadata carries across `APPLYING → ACTIVE → RESTORING → RECONCILING`; join-threshold spikes arriving during `RESTORING` keep the restore intent rather than starting an overlapping round.
  - Worker respawns send the lockdown announcement only if the adopted state is still active and unannounced (never in `RESTORING`). Completing restoration emits `reportUnlock` for main-thread cleanup and starts a `LOCKDOWN_RETRIGGER_COOLDOWN_MS` cooldown window (skipped on `abandonLockdown` or manual `/antiraid disable`).

- **Lockdown expiration, persistence guards, and wall-clock rollback progression**:
  - Entering `ACTIVE` fixes `expiresAt` (`LOCKDOWN_MS`); subsequent joins do not extend the deadline. Main-thread recovery snapshots (`packages/antiRaid/lockdownMirror.ts`) clamp `remainingMs` to `[0, LOCKDOWN_MS]`, and `adoptLockdowns` (`packages/workers/antiRaid/lockdownRuntime.ts`) advances `lastLockdownIntentId` to the maximum adopted `intentId` so wall-clock rollbacks never stretch lockdowns or collide intent IDs.
  - Expiry transitions to `RESTORING`, persists the restore intent (`persistState`), awaits its durable ACK (suppressing restore/reconcile retry timers in `packages/states/lockdown/restore.ts` while awaiting persistence, while `packages/antiRaid/workerBridge/events.ts` wraps `getOrCreateChatState` inside the error boundary so persistence failures reply `lockdownPersistFailed`), and calls Telegram to restore `can_invite_users`.
  - Failed restorations retry every `RESTORE_RETRY_MS`. Repeated permission denials (`RESTORE_PERMANENT_FAILURE_LOG_LIMIT`) double the interval up to `RESTORE_PERMANENT_RETRY_MAX_MS` while retaining the record; Worker shutdown aborts (`AbortSignal`) do not increment the permanent-failure counter.
  - **Gone-chat exception (`chatGone`)**:
    - When a chat is confirmed non-existent (teardown reason `gone`), the main thread sends `deactivateChat` with `abandonLockdown: true`, and the Worker dispatches `chatGone`—dropping the record from any phase, clearing timers, and emitting `reportUnlock` without calling Telegram to restore permissions or delete announcements.
    - On `unlock`, the main thread clears `ChatState.lockdown` (and deletes the `ChatState` row, freeing its managed-chat slot, if no other state remains) rather than deleting `lockdown` directly while a Worker report could still be in flight.
  - Successful restoration clears the chat's sliding join window; announcement deletion errors log without blocking future rounds.

- **Schema normalization for persisted permissions**:
  - Persisted `originalPermissions` pass through `normalizeChatPermissions` so only known schema fields are stored.
  - Restoration reads only `originalPermissions.can_invite_users` and applies it onto freshly queried `getChat().permissions`, leaving all other live group permissions intact.

- **Fail-safe compensation on persistence failure (`persistFailed`)**:
  - **Uncommitted `APPLYING`**: If persistence fails before `commitApply` has tightened permissions, the round aborts cleanly and emits `reportUnlock`.
  - **Dispatched `APPLYING`, `ACTIVE`, or `RECONCILING`**: Transitions immediately to `RESTORING`, persists the restore intent (`persistState`), and restores `can_invite_users` on Telegram so tightened group permissions are never stranded.
  - **`RESTORING` or `reportUnlock` failure**: `RESTORING` proceeds with Telegram restoration without re-emitting a duplicate persist request even when its own `persistState` write fails; if the final `reportUnlock` persistence fails, the Worker retries `reportUnlock` every `RESTORE_RETRY_MS` until acknowledged.

- **Pre-mutation persistence assertions**:
  - Every Worker lockdown snapshot must pass `assertPersistableLockdown` (`{ phase, intentId, originalPermissions, announced, announcementMessageId?, expiresAt }`, requiring a finite integer `expiresAt` in `ACTIVE`, forbidding it in `APPLYING`/`RESTORING`, and allowing an optional finite integer in `RECONCILING`) before mutating main-thread `ChatState`, rather than deferring validation to `encodeChatStateData`.

- **Single dispatch per applying intent**:
  - Each `APPLYING` intent dispatches `commitApply` at most once (`commitStarted` guard) and re-verifies round entry, phase, and `intentId` both before `getChat` and before `setChatPermissions`; cancelled tasks never tighten group permissions.

### AI Chat Runtime

- **Tokyo weather refresh**:
  - Owned exclusively by the AI Worker and started only when `init` delivers `timeZone === TOKYO_TIME_ZONE` (matching the `get_tokyo_weather` tool mount condition).
  - Under any other startup time zone, zero weather HTTP requests are made and daily mood selection applies no weather weighting.
  - Stopping clears the refresh interval, aborts in-flight HTTP fetches, and revokes cache-write permission; a rebuilt Worker accepts results from the new generation only, and every fetch enforces caller `AbortSignal`, timeout, and response-body byte caps.

- **Global mood management (`/mood query` and `/mood switch`)**:
  - Both commands run a main-thread waiter handshake acknowledged by the AI Worker:
    - `/mood query`: Any group member may inspect the active global mood without rerolling.
    - `/mood switch`: Requires `isCanSwitchMood` permission and triggers a global reroll.
  - Waiters register before `postMessage` and settle uniformly on timeout, Worker crash, abandoned respawn, or shutdown; requests carry absolute monotonic deadlines so the AI Worker drops expired queued requests on arrival.
  - Only an ACK matching both `requestId` and event type (`moodQueried` / `moodSwitched`) confirms completion; a subsequent Telegram reply failure never marks the mood query or switch itself as failed.
  - Mood state is global across all managed chats (requests and ACKs carry no `chatId`); `/clear_context`, `/ai_chat disable`, chat teardown, and memory eviction leave global mood untouched.

- **AI chat memory teardown and invalidation**:
  - **Teardown finalization survives timeouts**:
    - Complete chat teardown registers in `pendingAiMemoryTeardowns` on the main thread until both durable SQLite/file deletion and matching `chatInvalidated` ACKs arrive (Worker respawns or shutdowns settle stale waiters).
    - A waiter timeout releases only the caller's await; background finalization continues on late ACKs, and if a late Worker `memoryDeleted` triggers another tombstone write, teardown waits for that tombstone ACK as well.
    - Re-enabling `/init` or writing a new memory snapshot cancels stale finalization; ordinary `/ai_chat disable` invalidates memory without running full chat teardown.
    - Managed-chat count release and FIFO `forgetAiMemory` fire only when zero snapshots, initial-persist flags, tombstones, or waiters remain, guarded by a monotonic global revision floor.
    - Unfinished teardowns cap at `STATE_MANAGED_CHAT_LIMIT` (overflow triggers a fatal storage shutdown). Disk I/O respawns replay pending deletions from the main thread; full process restarts do not replay pure in-memory teardowns.
  - **Invalidation cancellation boundary and `epoch` isolation**:
    - Each chat receives a monotonically increasing `epoch` on its first generation-sensitive task, never reused within that Worker isolate.
    - Invalidation synchronously deletes the chat's active `epoch`, aborts in-flight tasks via `AbortSignal`, purges queued triggers, and waits up to `AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS` (strictly below main-thread `AI_CHAT_INVALIDATE_TIMEOUT_MS`, using an `unref()`ed timer cleared on settlement) for active reply rounds, rate-limit notices, media descriptions, and compactions to settle before posting `chatInvalidated`. Any task outliving the drain budget cannot mutate state once its `epoch` is gone.
    - `/ai_chat disable` and `/clear_context` both call `invalidateAiChat(chatId)` (clearing rolling memory and setting `chat_states.ai_context` to `NULL`) and report success only after both `chatInvalidated` and durable memory deletion settle.

- **Clear context permissions**:
  - `/clear_context` requires `isCanClearContext` (always `true` for `SUPER_ADMIN_USER_ID`, defaulting to `false` for newly added allowlist members and configurable via `/permission`).

- **Model provider requests, timeouts, and retries**:
  - HTTP transport, 429, and 5xx retries belong solely to provider SDKs (`@google/genai` `retryOptions`, OpenAI and Anthropic `maxRetries`, bounded by `GEMINI_REQUEST_RETRY_ATTEMPTS`, `OPENAI_REQUEST_MAX_RETRIES`, and `ANTHROPIC_REQUEST_MAX_RETRIES`).
  - SDK timeouts cap individual HTTP attempts, while `workers/aiChat/gemini/client.ts`, `workers/aiChat/openai/client.ts`, and `workers/aiChat/anthropic/client.ts` wrap the entire call (retries + backoff included) in a `signalWithTimeout` deadline (`GEMINI_REQUEST_TIMEOUTS_MS`, `OPENAI_REQUEST_TIMEOUTS_MS`, `ANTHROPIC_REQUEST_TIMEOUTS_MS`; `OPENAI_IMAGE_REQUEST_TIMEOUT_MS` in `workers/aiChat/openai/image.ts`).
  - **Failure classification and resampling**:
    - Chat invalidation `AbortSignal`s compose into request signals.
    - Transport/HTTP failures (`failureKind: "request"`) are never retried again by outer callers; outer resampling runs only when a completed HTTP response yields a malformed/truncated completion (`failureKind: "response"`) or empty text.
    - Anthropic refusals return `failureKind: "refused"` (`refused: true`, `retryable: false`) and are never resampled. OpenAI Responses payloads with `status === "completed"` containing any `refusal` content part return `failureKind: "response"` with finish reason `"refusal"`.
  - **Structured finish-detail diagnostics** (`aiProviders/finishDetails.ts`):
    - Unusable responses log structured provider finish-detail fields on the client error logs (`Anthropic API returned an unusable response.` with `model`, `stopReason`, `stopDetails`, `hasPartialText`; `Gemini API returned an unusable response.` with `reason`, `finishReason`, `finishDetails` from candidate `finishMessage` + `safetyRatings` or `promptFeedback`; `OpenAI API returned an unusable response.` with `reason`, `incompleteReason`, `finishDetails` from `error` + `refusal`).
    - `finishDetailsJson` JSON-serializes and truncates details to `AI_FINISH_DETAILS_MAX_CHARS` (omitting `finishDetails` / `stopDetails` when empty); the same string propagates via `AiReplyTurn.finishDetails` to the reply-layer `AI reply received an unusable response.` log's `finishDetails` field.

- **Model quota lanes and isolation**:
  - AI model calls bypass the Telegram outbound gateway and group into quota lanes keyed by `(provider, base_url, api_key)` (different model names under the same key share one lane).
  - Each lane admits up to `AI_PROVIDER_MAX_CONCURRENT` active calls and `AI_PROVIDER_MAX_PENDING` queued calls (with background tasks capped at `AI_PROVIDER_BACKGROUND_MAX_PENDING`). After `AI_PROVIDER_INTERACTIVE_BURST` consecutive interactive dispatches, at least one waiting background task is scheduled next.
  - In-SDK retries stay inside their acquired lane slot; full queues fail fast without buffering unbounded prompts or media in memory.
  - When Telegram's outbound send queue hits `AI_TELEGRAM_MESSAGE_ACTIVE_HIGH_WATER`, `AI_TELEGRAM_MESSAGE_RETRY_HIGH_WATER`, or HTTP 429 backoff, random interjections pause and direct-trigger concurrency drops to 1 per chat while keeping AI and Telegram queues separate.

- **Reply toolset and serial action chains**:
  - **Synchronous admission and immediate receipts**: Action tools validate arguments, claim cooldowns, and reserve quotas synchronously at call time (`send_voice` reserves a daily slot and settles accounting only if TTS synthesis succeeds). Accepted calls immediately return `{"success": true, "queued": true, "actions_used": ...}` without Telegram `message_id`s so model generation never blocks on typing delays, TTS synthesis, or Telegram network sends.
  - **Serial action chain (`actionChains.ts`)**:
    - Every reply round owns one FIFO action chain executing accepted actions in tool-call order (text formatting, typing delays, foreground voice wait, and Telegram enqueue).
    - Ordered parallel rounds wait for their turn at the delivery gate, whereas direct-trigger rounds enter without waiting; each step resets the chat action indicator to idle when done.
    - Reply rounds deliver in trigger arrival order so later rounds never interleave messages, typo corrections, or captions into an earlier round.
  - **Chat action heartbeats (`workers/aiChat/ai/chatActionHeartbeat.ts`)**:
    - Statuses (`typing`, `choose_sticker`, `record_voice`, `upload_photo`) activate only while the active chain step runs, never at tool-call admission.
    - Direct rounds run `createDirectPacing` to show `typing` during the initial model turn; if the first accepted tool is `send_message` or `abuse_mark`, it dispatches without an extra artificial pause.
    - Returning to idle starts a `CHAT_ACTION_REST_MS` quiet window before another heartbeat is sent.
    - Typo corrections wait silently for `TYPO_QUICK_CORRECTION_MIN_MS`–`TYPO_QUICK_CORRECTION_MAX_MS`, show `typing` for `TYPO_QUICK_CORRECTION_TYPING_MS`, and then send the `*correction`.
  - **Sticker pack viewing (`view_sticker_pack`)**:
    - Synchronously returns the pack's sticker indices, descriptions, and metadata, up to `MAX_STICKER_PACK_VIEWS_PER_REPLY` distinct packs per round (each viewed at most once); `send_sticker` accepts only stickers from packs viewed in that round.
  - **Abuse cooldown marking (`abuse_mark`)**:
    - `user_id` must be a non-zero safe integer equal to the current round's `triggerSenderId`, and never the bot itself or `SUPER_ADMIN_USER_ID`.
    - Once accepted, `abuse_mark` performs four steps atomically on the Worker side:
      1. Runs `dropQueuedReplyTriggersForUser` to purge queued direct triggers from that user across all chats in `pendingReplyTriggers`.
      2. Posts `abuseMark` to the main thread (`aiChat/abuseMark.ts` inserts the user into `abuseMarkedUsers`—a `FifoMap` capped at `ABUSE_MARK_MAX_USERS`—with a per-entry `unref()`ed `setTimeout` of `ABUSE_MARK_DURATION_MS` that intercepts their messages at the `auto/message` AI ingress).
      3. Enqueues the atmosphere-matched `ABUSE_MARK_NOTICE_TEXT` onto the serial action chain (kept permanently in chat and recorded into rolling AI memory).
      4. Immediately ends `runFunctionCalls` for the current round, skipping any remaining tool calls in that model turn and any further tool round-trips.
  - **Concurrency and delivery queues**:
    - `activeReplyCounts` caps ordered parallel rounds at `REPLY_ROUND_MAX_CONCURRENT` per chat (direct triggers use an independent model slot; Telegram backpressure collapses concurrency to 1 per chat).
    - `pendingReplyTriggers` buffers up to `REPLY_TRIGGER_QUEUE_MAX` unstarted direct triggers per chat; `replyDelivery.ts` caps FIFO delivery windows at `REPLY_DELIVERY_MAX_PER_CHAT` per chat and `REPLY_DELIVERY_MAX_TOTAL` globally.
    - Full queues drop random triggers silently and record overflow notices for direct triggers without charging rate-limit quotas. Only messages confirmed sent by Telegram enter rolling self-recorded memory.

- **Action budget caps and text deduplication**:
  - Prompts recommend at most `AI_MAX_ACTIONS_PER_REPLY` actions while execution enforces `HARD_MAX_ACTIONS_PER_REPLY` across `ACTION_TOOL_NAMES` (including `abuse_mark`, naming all counted tools in the cap-exceeded error).
  - Stickers, reactions, image generations, and voice messages are each capped at 1 per round.
  - Plain assistant text falls back to `send_message` **only** when zero action tools succeeded in the round; otherwise visible output comes strictly from tool calls.
  - **Two visible text outlets**: `send_message` text and `generate_image` `caption`.
    - A captioned image counts as 1 action unless `caption` exceeds `TELEGRAM_CAPTION_MAX_CHARS`, in which case delivery splits into "uncaptioned photo + standalone text message" when at least `IMAGE_SEPARATE_CAPTION_MIN_REMAINING_ACTIONS` budget slots remain (otherwise only the photo sends and the tool receipt reports `caption_delivery: "no_action_budget"`).
  - **Duplicate text suppression (`modelAuthoredTextPolicyResult`)**:
    - Compares whitespace-collapsed, Unicode-NFC-normalized text against already accepted messages, captions, and reserved typo-correction characters in the round.
    - Duplicates return `{"success": true, "skipped": "duplicate", "actions_used": 0}` without typing pauses, cooldown charges, network calls, or memory writes.

- **Image generation reference images**:
  - Only direct-trigger rounds attach reference images: the triggering message's own photo/sticker (or the replied-to message's photo/sticker) is placed first as the primary reference.
  - If the primary reference carries a `media_group_id`, the AI Worker appends sibling photos from `cache/workers/aiChat/imageReferenceAlbums.ts` in ascending `message_id` order up to `agent.image.max_reference_images` total (falling back to the primary image alone on cache miss or after Worker respawn).
  - `imageReferenceAlbums.ts` records incoming album photos on the AI Worker, keeping the `IMAGE_GENERATION_MAX_REFERENCE_IMAGES` lowest-`message_id` entries per album across at most `IMAGE_REFERENCE_ALBUM_CACHE_MAX` LRU albums; it is Worker-local, unpersisted, and survives single-chat invalidation.
  - Reference media downloads run concurrently in order via the media executor only after the model invokes `generate_image`; if any download fails, aborts, or pushes cumulative bytes past `MEDIA_MAX_DOWNLOAD_BYTES`, `generate_image` fails and releases the chat image cooldown because no image-generation request was sent.

- **Tool declaration invariants and language alignment**:
  - Mounted tool declarations depend **solely** on static/dynamic deployment configuration, never on per-message trigger type, Q&A count, or typo rolls:
    - Always mounted: `send_message`, `add_reaction`, `group_qa_query`, `group_qa_answer`, `abuse_mark`.
    - `generate_image`: mounted when `agent.image` is configured.
    - `send_voice`: mounted when `agent.tts` is configured.
    - `view_sticker_pack` & `send_sticker`: mounted when the configured sticker menu is non-empty.
    - `get_tokyo_weather`: mounted only when startup `time_zone` equals `TOKYO_TIME_ZONE`.
    - `web_search`: mounted as a local function tool when `agent.web_search` is configured; omitted when using the `text` model's native server-side search.
  - **Voice language alignment**: Tool schemas and prompt voice rules derive from `agent.tts.bot_language` via `VOICE_LANGUAGE_PROMPTS` (defaulting to `TTS_DEFAULT_BOT_LANGUAGE`).
  - **Round tool-status snapshot**: The `【本轮工具状态】` (current-round tool status) runtime block reports live snapshots (image cooldown/readiness, remaining voice quota, Q&A entry count, web-search budget), all re-verified by tool executors on invocation.

- **Voice synthesis details (`send_voice`)**:
  - **Admission & sanitization**: Checks round liveness, `MAX_VOICES_PER_REPLY`, TTS readiness, single-line `text` (`<= VOICE_TEXT_MAX_CHARS`), optional `tone` (`<= VOICE_TONE_MAX_CHARS`), boolean `reply_to_trigger`, and daily quota (`reserveAiTtsUsage`, failing immediately with `SEND_VOICE_DAILY_LIMIT_TOOL_ERROR` when exhausted).
  - **Foreground wait & background handoff**:
    - When the action chain reaches the voice step while synthesis is still running, it shows `record_voice` for at most `VOICE_FOREGROUND_WAIT_MS`.
    - If still unfinished, recording status clears and delivery moves to `chains.defer` so subsequent actions proceed; once ready, the audio appends to the chain tail.
    - Synthesis failures send nothing and log `"AI reply voice was not sent."` (`{ chatId, reason }`) without surfacing errors back to the model; confirmed sends record `voiceSentTagTemplate` in self-memory.
  - **Quota accounting**:
    - Reservations live only in AI Worker memory (`pendingAiTtsReservations`) and commit to `agentCount` via `settleAiTtsReservation` once the TTS HTTP call succeeds (pre-synthesis errors release the reservation; post-synthesis Opus/network failures do not refund provider usage).
    - AI chat daily budget equals `agent.tts.daily_limit - daily_reserve_quota`, isolated from operator reserve usage.
  - **Audio validation and Opus encoding** (`VOICE_SPEECH_MAX_BYTES` response cap):
    - **WAV**: Extracts mono PCM and encodes to OGG/Opus via `@audio/encode-opus` in `VOICE_OPUS_ENCODE_CHUNK_SECONDS` slices, yielding the event loop between slices and checking `AbortSignal` before each slice and after the final yield (freeing the native encoder and returning `aborted` cleanly on cancellation). Continuous resampling runs from the source sample rate to `OPUS_GRANULE_RATE`, joining output pages with `Bun.concatArrayBuffers`.
    - **OGG/Opus & MP3**: Validates Ogg/OpusHead pages or MPEG Layer III frame headers, computes duration, and forwards bytes verbatim.

- **Operator voice borrowing (`/send` and `cron.json`)**:
  - The main thread requests synthesis over IPC via `requestVoiceSynthesis` (timeout `VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS`; cancellation sends `cancelVoiceSynthesis`) and receives the encoded audio buffer by `requestId`.
  - Operator synthesis draws exclusively from `reserveCount` (capped at `daily_reserve_quota`) inside `createSpeechFacade` (`packages/workers/aiChat/providerFacades.ts`), never consuming AI chat's `agentCount`.

- **Anthropic model response handling**:
  - **Stop reasons and refusals**: Requests use the SDK beta Messages API. `max_tokens` and `model_context_window_exceeded` return `failureKind: "response"` (eligible for resampling where configured), whereas `refusal` (any `stop_details.category`) returns `failureKind: "refused"` and is never resampled—compaction, sticker cataloging, and ad detection stop immediately, `web_search` returns `WEB_SEARCH_REFUSED_TEXT`, and cron digests fail as `refused`.
  - **Automatic refusal fallback (`fallback_model`)**:
    - Capabilities configuring `fallback_model` attach `betaRefusalFallbackMiddleware` (`fallback-credit-2026-07-01` beta header): on primary refusal, the middleware resends the request to `fallback_model` on the same endpoint/credentials and redeems `fallback_credit_token` in `best_effort` mode (running at normal billing if credit redemption fails).
    - One `BetaFallbackState` is shared across an entire reply session (all tool rounds and `pause_turn` continuations) or a single standalone search, pinning the session to `fallback_model` after a reroute while the next reply starts fresh on `model`.
  - **Reroute diagnostics and usage attribution**:
    - `aiProviders/anthropic/sdkClient.ts` detects a reroute when `BetaFallbackState`'s pinned index changes across a call and logs one structured warning: `"Anthropic request fell back after a refusal."` with `{ errorLabel, from, to, trigger, fallbackCredit }` on success (`trigger` and `fallbackCredit` formatted via `finishDetailsJson`, `null` when absent), `{ errorLabel, from, to, stopReason }` on double refusal, or `"Anthropic request fell back after a refusal; fallback request did not complete."` with `{ errorLabel, from, to }` on transport failure/timeout. Subsequent calls in an already-rerouted session log nothing.
    - Token usage attributes to the configured `fallback_model` (or `model` when unrerouted), never the provider's canonical response model ID, and drops the refused primary attempt's usage. `fallback_credit_token` is stripped from `stop_details` before logging or storing `finishDetails`.
  - **Ad-detection empty-body retries and `pause_turn`**:
    - Empty ad-detection bodies resample up to `AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS` times (Anthropic refusals abort immediately), logging once on final exhaustion with structured context for the final attempt: Anthropic logs `"Ad detection request produced no usable body."` with `{ errorLabel, attempts, model, stopReason, stopDetails, hasPartialText, maxTokens }`, Gemini logs `"Ad detection request returned no usable body."` with `{ errorLabel, attempts, abnormalReason, finishReason, finishDetails }`, and OpenAI-compatible Chat Completions logs `"Ad detection request produced no usable body."` with `{ errorLabel, attempts, finishReason, finishDetails, hasPartialText, reasoningTokens, maxTokens }`.
    - Server-side tool `pause_turn` continues assistant turns up to `ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS` times, summing web-search counts across segments.

- **Token and usage accounting** (`packages/infra/aiCacheUsage.ts`):
  - Accounting records only authoritative SDK usage payloads (including valid usage returned on cancelled calls) and never estimates missing fields; cost-billed endpoints (such as xAI `cost_in_usd_ticks`) record USD ticks instead of tokens.
  - **Per-provider token mapping**:
    - **Gemini**: Input sums `promptTokenCount` + `toolUsePromptTokenCount`; thinking + candidate text tokens validate and sum as output. Decisions API usage is recorded by `reportGeminiDecisionUsage` (reading `total_input_tokens` and `total_cached_tokens`, recording `0` output tokens when both `total_output_tokens` and `total_thought_tokens` are omitted while leaving omitted `total_cached_tokens` unknown, and still reporting when `prompt_feedback.block_reason` returns `usage`). Responses report cached reads (`cachedContentTokenCount` / `total_cached_tokens`) without cache-write counts.
    - **Anthropic**: `input_tokens` excludes cached tokens, so total input = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, with reads = `cache_read_input_tokens` and writes = `cache_creation_input_tokens`.
    - **OpenAI**: Output does not double-count reasoning tokens; cache writes read from Responses `input_tokens_details.cache_write_tokens` or Chat Completions `prompt_tokens_details.cache_write_tokens`.
    - **Sanity guard**: Cache reads and writes count inside total input without overlapping; if `reads + writes > input`, token fields are discarded as invalid while preserving search counts. Omitted write fields record nothing rather than `0`.
  - **Web-search usage**: Server-side searches (Anthropic `server_tool_use.web_search_requests`, OpenAI completed `action.type === "search"`) fold into the host call's daily usage report; standalone `web_search` function calls report under their own model entry.

- **Two-stage reply admission**:
  - **Stage 1 — Concurrency gate (`admitTrigger`)**: Checks active/queued capacity on trigger arrival; non-empty queues strictly append new triggers at the tail (no queue jumping).
  - **Stage 2 — Rate-limit gate (`isReplyRoundRateLimited`)**: Evaluates the `RATE_LIMIT_LONG_WINDOW_MS` sliding window right before launching a round; rejections send a 30-second group notice for direct triggers (`directInvokerId`) and drop random interjections silently.
  - Queue drains run on `onModelFinished`, `onFinished`, new enqueues, and `drainReplyQueueIfWindowAllows` maintenance ticks; overflow notices flush regardless of the rate window.

- **Chat activity probabilities and JIT performance**:
  - Incoming visible messages raise a chat's random-interjection probability toward the hot-chat cap independently per chat (starting cold on process restart; direct triggers bypass probability draws).
  - **Hot-path allocation discipline**: Existing chats mutate fixed-shape `AiReplyActivityEntry` records in place without `Map.delete`/`Map.set` churn or composite string keys, scanning for LRU eviction only when inserting a brand-new chat. Per-user cooldowns use two-level `Map<chatId, Map<userId, ...>>` tables with a centralized count and single `unref()`ed sweep timer.
  - **Single clock read per message (`updateNow()`)**: `packages/infra/updateContext.ts` caches the first `Date.now()` read in `UpdateScope.now` so `antiRaid/updateIngress.ts`, `auto/message/index.ts`, silence windows, activity decay, cooldowns, and flood windows share one timestamp; if `waitForBotOwnMessage` waits up to `SELF_SENT_RENDEZVOUS_TIMEOUT_MS` on a channel post/auto-forward without matching, `refreshUpdateNow()` refreshes the timestamp once before continuing.

- **Multimodal media processing pipeline (Images, Stickers, GIFs, Voice)**:
  - Follows a unified **placeholder → async media task → in-place memory backfill** pipeline.
  - `transientDescriptionCache` deduplicates in-flight and completed descriptions by `file_unique_id` up to `MEDIA_DESCRIPTION_CACHE_MAX` (LRU eviction on overflow; immediate removal on failure) using `libs/sharedResult.ts` reference-counted subscriptions so cancelling one consumer aborts the underlying download/model call only when the last subscriber leaves.
  - Concurrency caps at `MEDIA_DESCRIPTION_MAX_CONCURRENCY` active tasks with `MEDIA_DESCRIPTION_MAX_PENDING` queued/cold-probe slots.
  - **Vision transcoding limits (`packages/infra/image.ts`)**: Animated WebP inputs slice out their first frame at the RIFF chunk level (scanning at most `WEBP_MAX_SCANNED_CHUNKS` chunks per span); `Bun.Image` enforces `VISION_TRANSCODE_MAX_PIXELS` at header decode before allocating pixel buffers and downscales (never upscales) any image whose longest edge exceeds `VISION_TRANSCODE_MAX_EDGE` prior to PNG encoding.

- **Self-sent image memory backfills and pre-download voice checks**:
  - Bot-sent images enter rolling memory in **placeholder state** (prompt/caption marker + `pendingImage`) and transition to **content state** (marker replaced with vision description, `pendingImage` cleared):
    - `/wed`, `/h_image`, and cron `send_image` photos record placeholders lazily without eager vision calls.
    - `generate_image` writes a prompt-tagged placeholder, kicks off background vision description immediately, and backfills in place on completion.
    - When a user replies to a bot image whose entry is still a placeholder, resolving the description backfills both the original memory entry and the reply reference.
  - **Voice pre-download bounds**: Voices exceeding `VOICE_MAX_DURATION_SECONDS` or `VOICE_MAX_DOWNLOAD_BYTES` skip download/transcription and record `voiceDurationPlaceholder` directly; transcribed text truncates at `VOICE_TRANSCRIPT_MAX_CHARS`.

- **Allowlisted sticker pack maintenance and mirroring**:
  - AI Worker startup and periodic maintenance reconcile configured packs via `retryIncompleteStickerCatalogs` with negative-cache retry backoffs (`STICKER_CATALOG_ENTRY_FAILURE_RETRY_MS` per sticker, `STICKER_SET_FAILURE_RETRY_MS` per set); `stickers.json` hot reload immediately evicts removed packs.
  - Main-thread `stickerMirror.ts` stamps monotonic revisions, and Disk I/O confirms `stickerCatalogPersisted` after atomic file replacement and directory `fsync`.

### AI Prompts and Transcript

- **Bot self-identity and speaker labels**:
  - Across self-records, speaker rosters, reply headers, and cold-history summaries, the bot's own messages use `SELF_SPEAKER_NAME` (never Telegram `first_name`, `last_name`, or `username`) and roster code `SELF_ROSTER_CODE`.
  - **Self inline-result attribution** (`via_bot.id === bot.id`, `recordSelfInlineResult` in `packages/auto/message/guards.ts`): Gag inline posts (`hasGagInlineMarker`) record under the human sender's identity (`buildInlineSenderRecordMessage`), whereas other self inline results (such as fortune cards after `stripLuckReceipt`) record under `SELF_SPEAKER_NAME` (`buildSelfRecordMessage`) without triggering AI replies.
  - The read-only reference memory block injects one sentence naming the bot's `@username`, captured once from `bot.init()` (`getMe`) at startup and replayed via `initAiChat` across Worker respawns.

- **Web-search verification prompt and dual-mode dispatch**:
  - **Shared verification rules**: Provider-neutral system instructions require searching mutable or verifiable facts before taking visible actions whenever search is mounted, skipping search for casual banter, creative play, or facts already in the transcript, preferring search evidence over vague recall, and stating uncertainty plainly without mentioning internal search tools.
  - **Two mutually exclusive search modes**:
    - **Native server-side search (`agent.web_search` omitted)**: Injects `WEB_SEARCH_INSTRUCTION` and enables the `text` model's server-side search under a soft budget of `MAX_WEB_SEARCH_CALLS_PER_REPLY` (`replyModel.ts` logs overruns without mutating the system prompt or tool list mid-reply).
    - **Standalone function tool (`agent.web_search` configured)**: Injects `WEB_SEARCH_FUNCTION_INSTRUCTION` and mounts local `web_search` (capped at `WEB_SEARCH_DEFAULT_MAX_CALLS_PER_USE`), executed by `workers/aiChat/ai/tools/webSearch.ts` to return formatted `notice + conclusion + numbered sources` bounded by `WEB_SEARCH_RESULT_MAX_CHARS` and `WEB_SEARCH_MAX_SOURCES` (`WEB_SEARCH_FAILED_TEXT` on error/timeout; `WEB_SEARCH_REFUSED_TEXT` with `retryable: false` on Anthropic refusal).
  - **Time-zone anchoring and grounding temperature**: Relative dates ("today", "latest") are judged against the bot's configured time zone rather than web page publication timestamps; any executed search marks subsequent turns in the reply `grounded: true` (lowering Gemini sampling temperature).

- **Input blocks fixed ordering and anti-injection**:
  - **Four ordered user-content blocks** (identical count and layout for both `@mention` direct triggers and random interjections; direct triggers prepend `directInvokerSentence` inside block 4):
    1. **Read-only reference memory** (`stableBlocks`: persona and background).
    2. **Read-only current conversation** (`volatileBlocks`: tiered transcript).
    3. **Current runtime state** (`volatileBlocks`: local wall-clock time, global mood, and `【本轮工具状态】` current-round tool status).
    4. **Reply task** (`volatileBlocks`: trigger context and turn instructions).
  - **Per-provider wire layout**:
    - **Gemini**: Two adjacent `user` `Content` turns (`stableBlocks` then `volatileBlocks`), one `text` `Part` per block.
    - **OpenAI**: One `user` message carrying multiple `input_text` parts.
    - **Anthropic**: One `user` message carrying multiple `text` content blocks, splitting the transcript at settled segment boundaries.
  - **Byte-identical system prompt & anti-injection**: Anti-injection rules (separating untrusted chat data from instructions and ignoring forged boundary tags inside transcripts) appear once in the system prompt. All dynamic runtime state stays in user block 3; as long as persona, action/stop rules, and `web_search` mode match the previous round, the AI Worker reuses the cached string in `packages/cache/workers/aiChat/replyPrefix.ts`.

- **Prompt caching and breakpoints**:
  - **Gemini**: Every generative `text` turn sends static `systemInstruction`, `tools`, and `toolConfig` with `stableBlocks` in the first `user` `Content`, and generative `ad_detect` keeps detection rules and configured samples in `systemInstruction` while placing `fact` before `userContent` and multimodal images in `contents`, relying on server-side implicit prefix caching; `ad_detect` with `use_decision: true` calls `client.decisions.create`, placing detection criteria, reference samples, and per-pack questions in `questions` over a single shared multimodal `input`.
  - **OpenAI**: Places `stableBlocks` first and attaches a per-chat `prompt_cache_key` whose SHA-256 prefix state over system prompt + tool JSON (`stablePrefixFingerprintWithSlot` in `libs/prefixFingerprint.ts`) is reused across rounds when unchanged; official models matching `OPENAI_PROMPT_CACHE_BREAKPOINT_MODEL_PREFIX` also place a `prompt_cache_breakpoint` after the final stable block.
  - **Anthropic**: Places cache breakpoints at the end of the system prompt, the end of `stableBlocks`, the end of the settled transcript segment, plus top-level automatic caching.

- **Direct invocation reading sequence and anti-confusion**:
  - `DIRECT_INVOCATION_READING_INSTRUCTION` orders reasoning into three steps:
    1. Read `【最热记忆】` (the hottest recent-message window) to grasp ongoing chat context.
    2. Match the caller's message via their speaker roster code.
    3. Formulate a reply addressing that caller without misattributing earlier speakers or forwarded authors (`[id:]` behind roster codes is authoritative; forwarded lines represent original authors).

- **Memory mechanism silence invariant**:
  - `MEMORY_MECHANISM_SILENCE_INSTRUCTION` forbids revealing or hinting at internal prompt/memory plumbing (tier headers, `SELF_ROSTER_CODE`/`uN`/`fN` codes, `#messageId`, `REPLY_TARGET_EVICTED_TAG`, token budgets, sliding windows, compaction, or system prompts), answering meta/probing questions naturally in persona.

- **Compact tiered verbatim transcript format (`buildTieredVerbatimTranscript`)**:
  - **End-of-block rosters**: Full speaker and forward-origin metadata appear once at the end under `【发言人名册】` (speaker roster) and `【转发来源名册】` (forward-origin roster), while verbatim lines print compact codes (`SELF_ROSTER_CODE`, `u1`, `f1`, ...).
  - **Minimal per-line chrome**: Date headers appear only on calendar-day transitions; lines carry `HH:MM:SS`, attach `#messageId` only on replied-to targets and trigger lines, link in-window replies by pointer, and inline evicted reply targets with `REPLY_TARGET_EVICTED_TAG`. Duplicate `message_id`s in the hot window render only the latest copy.
  - **Append-only tier & cache alignment**: `【较早逐字记录】` (earlier verbatim tier) rounds length up to multiples of `TIER_BOUNDARY_ALIGNMENT` so tier shifts occur only at stride boundaries, and settled transcript offsets align every `TRANSCRIPT_SETTLED_SEGMENT_SIZE` messages for block-cached providers.

- **Single-hop reply consistency**:
  - Roster references never invent non-existent codes, and transcript context records single-hop reply targets, forward origins, and exact quote slices without recursive reply chains.

- **Cold-history compaction format (`summarizeBatch`)**:
  - Formats messages as self-contained lines (`formatBufferedMessageLine`) without roster tables and pairs the fixed `SUMMARY_SYSTEM_PROMPT` with the current timestamp at the end of `userContent`.

- **Hard execution-side interception of action markers**:
  - Action tags (`SELF_ACTION_TAG_MARKERS`, formatted via `stickerSentTagTemplate`, `imageSentTagTemplate`, `voiceSentTagTemplate`, and `botImageTagTemplate` in `transcript.ts`) are written exclusively by runtime delivery handlers after an action succeeds.
  - `send_message` and `generate_image` (before claiming image cooldown) test outputs against stateless `SELF_ACTION_TAG_PATTERNS` regexes (no `g`/`y` flags) and reject any model-forged tag so the model regenerates clean text.

### Join Verification and Terminal Disposal

- **Verification terminal retry, wall-clock rollback guards, and persistence guarantees**:
  - Terminal verification actions run at most `VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS` attempts per process. `packages/workers/antiRaid/verificationRuntime.ts` clamps pending timeout delays to `[0, VERIFICATION_TIMEOUT_MS]` against wall-clock rollback, `packages/states/verification/pending.ts` guarantees `expiresAt >= joinedAt` and treats wall-clock rollback as an elapsed reminder retry window (`isRecordedWithin`), and `packages/states/verification/join.ts` treats wall-clock rollback as an elapsed `KICKED_REJOIN_GRACE_MS` rejoin grace window via `isRecordedWithin`.
  - **Batched critical journal `fsync`**: While the Disk I/O Worker executes an operation batch, critical verification writes inside that batch (creations, terminal transitions, and deletions) register in memory and append + `fsync` once at the end of the batch (even if an operation throws), emitting `verificationPersisted` receipts before batch acceptance. A standalone critical write arriving outside a batch appends and `fsync`s immediately.
  - **Final revision settlement**: Completed terminal actions await the durable ACK of their final revision before removing in-memory state; if a newer revision is stamped while waiting, the newer revision settles without stalling completed terminal cleanup.
  - **State-machine-owned execution gates**: Worker-local terminal flags (`effectStarted`, `executionStarted`) are never persisted and mutate exclusively via state-machine events bound to the exact state reference captured when the attempt began:
    - `kickRequestSent`: sets `executionStarted` synchronously right before issuing a lockdown fast-kick request.
    - `kickRequestFailed`: clears `executionStarted` if that request returns unsettled.
    - `terminalAttemptUnsettled`: clears execution gates (both flags on `kickPending`) when an attempt finishes unsettled or its side-effect batch rejects mid-flight (`retryTerminalAttempt` logs the error, dispatches `terminalAttemptUnsettled`, and schedules one backoff step—`kickRetry` for `kickPending`, or `terminalPersisted` for `checkingInviter` and `expelling`; timeout-kick notices go through `runTelegramAction` so send failures follow the same backoff).
  - **Emergency lockdown announcement cleanup**: Main-thread emergency lockdown recovery dispatches deletion of any recorded `announcementMessageId` before clearing state, logging deletion failures via the shared Telegram logger without blocking recovery.

- **Timeout verification rechecks inviter identity (`checkingInviter`)**:
  - When a member is invited by another user, ingress checks the inviter synchronously against an unexpired Worker admin cache and exempts the newcomer immediately on hit; `startAdminCheck` fetches `getChatAdministrators` only when `adminCacheFresh` is `false` (applying identically when the same join arrives via both `chat_member` and `new_chat_members`).
  - On verification timeout, `checkingInviter` re-evaluates the inviter via `isChatAdmin`:
    - **Confirmed admin**: Exempts the invited member.
    - **Confirmed non-admin**: Transitions to `expelling`.
    - **Inconclusive (timeout or API error)**: Preserves terminal and disk snapshots, clears local execution gates, and retries with exponential backoff (spending one terminal attempt per retry).

- **Execution permits and deferral latching**:
  - A terminal execution permit is valid only while its captured state reference, Worker generation, revision, and chat lifecycle all remain current.
  - When a permit is denied, turns `stale`, or exhausts `VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS`, Worker runtime state unloads and records a process-level deferral latch on the main thread without advancing revisions or writing a tombstone; Worker respawns honor that latch without recreating the session, whereas a full process restart reloads the durable snapshot from disk.

- **Backoff timers and durable persistence ACKs**:
  - Duplicate `verificationPersisted` ACKs never short-circuit an active terminal backoff timer.
  - Timer callbacks verify entry identity, state object identity, and timer handle identity before clearing the handle and firing a retry; superseded or torn-down callbacks exit as no-ops.
  - An exact durable ACK for `expelling.successNoticeSent` finalizes the entry immediately even if a retry timer is still armed.

- **Worker runtime capacity limits**:
  - The Anti-Raid Worker enforces a hard cap of `VERIFICATION_RUNTIME_CAPACITY` across persistent verification entries plus `exempt`/`kicked` deduplication entries.
  - At capacity, new keys are rejected before join counting, state transitions, or side effects—emitting one fatal error per Worker generation and blocking new join admissions until adopted by a fresh generation or stopped, while existing entries continue settling normally.
  - New Worker generations wipe prior runtime tables before replaying durable mirrors; same-generation recovery at capacity evicts only non-persistent deduplication entries while keeping the admission latch closed.
  - Main-thread revision tracking likewise caps at `VERIFICATION_REVISION_CAPACITY` across active and retained terminal keys, purging expired tombstones first and triggering fatal shutdown if still saturated.

- **Unified switch for join verification and anti-raid lockdown**:
  - Join verification and join-spike lockdown share `ChatState.isAntiRaidEnabled` (default `false`), toggled and persisted via `/antiraid enable|disable` by callers holding `isCanControllAntiRaidPermission` (always `true` for `SUPER_ADMIN_USER_ID`).
  - Both share the inbound join stream, whereas `/ad_detect`, `/flood_control`, blocklist instant kicks, and `/batch_kick` join logs run under independent switches and boundaries.
  - **Main-thread ingress filtering**: Disabled chats drop joins, leaves, and verification messages/callbacks at ingress, **except `adminsChanged` updates**, which still forward as low-frequency admin-cache maintenance without touching verification or lockdown state machines (blocklist instant kicks omit `joinedAt` when anti-raid is disabled).

- **Teardown on disabling anti-raid (`/antiraid disable`)**:
  - Disabling immediately stops active sessions and cleans up group artifacts:
    - `deactivateJoinGuard` transitions every verification record in that chat through `guardDisabled` to `ABSENT`, deletes bot-sent verification reminders/buttons (leaving join service messages and member messages untouched), voids pending expulsions without kicking, and writes tombstones for persisted expulsion records.
    - Lockdown receives `deactivate`: `applying/preparing` cancels directly, while `applying/prepared` and all subsequent phases transition to `RESTORING` to restore `can_invite_users`, delete lockdown announcements, and clear sliding join windows.
  - Telegram message deletions run only on explicit `/antiraid disable` or `/init disable`; if the bot lost admin rights or left the chat, local emergency teardown runs without calling restricted Telegram APIs.
  - If the Worker is unavailable during disable, `isAntiRaidEnabled = false` still persists durably and `purgeDisabledJoinGuards` sweeps residual records on Worker respawn or process restart.

- **Linked-channel discussion group exemptions**:
  - Top-level channel comments and nested replies in linked discussion supergroups share one exemption rule (the comment cache stores only `message_id` and observation timestamp), restricted to non-forum threads (`is_topic_message !== true`).
  - An uncached `message_thread_id` is treated as a normal pending-verification message while asynchronously checking `getChat().linked_chat_id`; a confirmed match under the same generation revokes the pending verification, while lookup errors fail closed and permit later retries.

- **Worker admin cache in-flight slot management**:
  - Concurrent `getChatAdministrators` calls coalesce per chat via `libs/keyedTask.ts`, clearing the in-flight slot in `.finally()` only when the slot still holds that exact `Promise`.
  - `resetAdminCache()` wipes all snapshots, in-flight slots, and buffered increments globally, whereas `clearChatAdminCache(chatId)` wipes only that chat's entries; an in-flight fetch finishing after its slot was cleared still resolves current callers without writing back to `cacheAdminIds` or buffered increments.

- **Verification button interaction permissions**:
  - **Self-answer challenge buttons**:
    - Human joiners receive `VERIFICATION_CHALLENGE_OPTION_COUNT` arithmetic options on row 1 plus `"通过"` (Approve) on row 2; bot joiners receive only the `"通过"` (Approve) row.
    - Challenges pick an operator uniformly from `VERIFICATION_CHALLENGE_OPERATORS` (`+`, `-`, `×`, `÷`) and operands in `[VERIFICATION_CHALLENGE_OPERAND_MIN, VERIFICATION_CHALLENGE_OPERAND_MAX]` (non-negative subtraction, exact integer division). Non-negative distractors within `±VERIFICATION_CHALLENGE_DISTRACTOR_SPREAD` pick the answer's rank uniformly from feasible ranks, sample lower/higher distractors without replacement, and shuffle (`0` is always rank 0).
    - `callback_data` uses `verify:<userId>:<option>`, validated on the main thread via `parseUserIdArgument` and `VERIFY_ANSWER_ARG_PATTERN`.
    - Only the pending member (`callback_query.from.id === userId`) pressing the active `reminderMessageId` or `replyReminderMessageId` is evaluated (other users are ignored; stale reminder messages return an expired toast). A correct choice passes; a wrong choice transitions to `expelling` (`reason: "wrongAnswer"`), deleting verification prompts after persistence ACK, kicking without banning, and skipping `checkingInviter`.
  - **Ephemeral challenge cache (`VerificationEntry.challenge`)**:
    - Generated once when a human member's reminder is first registered, shared across the initial reminder, reply reminder, and resends of that pending state, bounded by the entry's verification timeout timer, and never persisted to disk.
    - After a Worker respawn or replay (where `challenge` is absent), a self-answer tap deletes the old reminder messages, clears their IDs, and sends a fresh challenge under the current reminder mode.
  - **`"通过"` (Approve) button & allowlist independence**:
    - Only **non-anonymous human group administrators** in that chat (verified via `isChatAdmin` / `getChatAdministrators`) may approve a candidate; allowlist members and `SUPER_ADMIN_USER_ID` have no special approval or inviter-exemption privilege unless they are group admins, and candidates cannot approve themselves.
  - **Bots are never treated as group admins**: `getChatAdministrators` omits `return_bots` and filters `user.is_bot`, and `isInviterExemptAdmin` applies the same filter to `chat_member` diffs—so bot-invited newcomers require verification, and flood/ad admin gates never exempt bots.

- **Terminal member kicks and group type adaptation**:
  - **Presence check before kick**: Every `kickChatMember` call is preceded by `probeChatMembership` (`getChatMember`). Confirmed `left`/`kicked` settles silently as `absent` without sending battle reports; probe errors enter retry backoff. In supergroups, "kick without ban" calls `unbanChatMember` without `only_if_banned` (which lifts existing bans), so confirming live presence first is mandatory (explicit unbans pass `only_if_banned: true` and skip the probe).
  - **Missing `can_restrict_members` (`botCanRestrictIn === false`)**: `probeChatMembership` still runs while the kick call itself is skipped—departed targets settle immediately, and present targets keep their terminal state on backoff. Once `cleanupSettled === true`, retries stop re-issuing message deletes; once the failure notice has been sent (or `removalConfirmed` was already set on a prior round), each retry performs only a single membership probe (emitting the success notice once the member leaves).
  - **Group-kind routing**: Basic groups remove via `banChatMember`, whereas supergroups use `unbanChatMember`. Chat kind is mirrored from the main thread before adopting terminals, falling back on cold miss to `getChat` bounded by `VERIFICATION_CHAT_KIND_FETCH_MAX` concurrency and `CHAT_KIND_FETCH_TIMEOUT_MS`.

- **Fast kicks and irreversible execution tokens (`kickPending`)**:
  - Lockdown fast-kicks persist a write-ahead `kickPending` snapshot before probing and kicking so restarts resume cleanly, verifying exact state-object identity synchronously (zero intervening `await`s) right before `kickChatMember` and transitioning to `kicked` only on token-matched success.
  - **Join-counter retractions**: Retract only physical joins carrying `countedJoinAt` (`joinCreatesNewRecord === true`, including rejoins after `KICKED_REJOIN_GRACE_MS` and `kickPending` entries rebuilt during lockdown; duplicate deliveries of the same join announcement remain deduplicated).
  - Uncancelable admin fast-kick exemptions (`logUncancelableKickExemption`) log via `logger.error` as permanent audit traces.

- **Verification reminder delivery and member message safety**:
  - Each pending state owns at most one active reminder delivery; superseding the state (recovery adoption, chat deactivation, or shutdown) cancels delivery synchronously and self-deletes any late-sent message.
  - Timeout expulsion requires at least one delivered `reminderMessageId` or `replyReminderMessageId`, extending the window up to `VERIFICATION_REMINDER_UNDELIVERED_MAX_MS` while retrying delivery before settling as an ordinary timeout kick.
  - **Member messages are never deleted by verification**: `trackedMessageTimes` counts member messages toward `ANTI_RAID_PER_MINUTE_LIMIT` flood expulsion, but expulsion deletes only bot-authored verification prompts/notices (member message wiping belongs strictly to `/block` and ad-detection bans).

### Flood Muting and the Bot's Own Permission Cache

This section covers [counting and enforcement boundaries](#counting-and-enforcement-boundaries), [verdict-time suppression and concurrency safety](#verdict-time-suppression-and-concurrency-safety), [permission gates before enforcement](#permission-gates-before-enforcement), and [the bot's own permission mirror](#the-bots-own-permission-mirror).

#### Counting and enforcement boundaries

- **Flood counting and enforcement are owned entirely by the Anti-Raid Worker**:
  - Disabled by default (`ChatState.isFloodControlEnabled === true` required), toggled and persisted via `/flood_control enable|disable` by callers holding `isCanControllFloodControlPermission` (disabling clears active sliding windows).
  - **Supergroups only**: Sending `FLOOD_MESSAGE_LIMIT` messages within `FLOOD_WINDOW_MS` triggers a `FLOOD_MUTE_DURATION_MS` mute via `restrictChatMember`.
  - **Main-thread synchronous prefilter**: Checks group toggle, supergroup type, real user sender (excluding channel personas and anonymous admins), and `isCanBypassFloodControl` (default `true` for allowlist members; always `true` for `SUPER_ADMIN_USER_ID`) before posting plain `post` events to the Worker.
  - Sliding windows live in `cache/workers/antiRaid/flood.ts` (capped at `FLOOD_WINDOW_MAX_MEMBERS` with LRU eviction and periodic sweeps); Telegram's `until_date` lifts mutes automatically without Worker timers or disk state.

#### Verdict-time suppression and concurrency safety

- **Suppression markers are applied at verdict time**:
  - Applied synchronously on threshold match before awaiting any network probe or mute call.
  - Deterministic outcomes (`muted`, target is admin, or `forbidden`) **keep** the suppression marker; transient probe/network failures **roll back** the marker so subsequent messages can re-trigger enforcement.
  - Every `await` resumption checks `stillManaged`: chat deactivation or LRU eviction aborts enforcement immediately without posting notices.

#### Permission gates before enforcement

- **Dual permission preflight**:
  - Before calling `muteChatMemberWithOutcome`, the Worker checks:
    1. Bot permission mirror `canRestrictMembers` (`false` aborts; `true` or `undefined` proceeds).
    2. Target non-admin confirmation via `freshAdminIds` / cold `getChatAdministrators` (`true` = admin or `undefined` = unconfirmed **never mutes**; only confirmed `false` proceeds).
  - `muteChatMemberWithOutcome` returns `muted`, `forbidden` (retains suppression without retry), or `failed` (rolls back suppression), bounded by `FLOOD_MUTE_DISPATCH_TIMEOUT_MS` and `antiRaidDispatchSignal`, sending a `COMMAND_MESSAGE_AUTO_DELETE_MS` group notice only on `muted`.

#### The bot's own permission mirror

- **Bot permissions are mirrored from main thread to Worker**:
  - Authoritative snapshots live in `ChatState.botPermissions` (`packages/infra/botAdmin.ts`) and push incrementally to the Anti-Raid Worker via `botPermissionsChanged` (persisting whenever any permission bit changes, while cross-thread broadcasts diff only `canRestrictMembers` and `canDeleteMessages`).
  - Other users' `chat_member` updates only confirm that the bot has admin status and never overwrite specific permission bits with partial snapshots. Missing or contradicted snapshots trigger a non-blocking `getChatMember` probe throttled by `BOT_PERMISSION_PROBE_RETRY_MS` (never `await`ed on the update runner path).
  - **Strict tri-state (`true` / `false` / `undefined`)**: Never coerced to boolean—flood mutes (`canRestrictMembers`), ad-disposal bulk deletes, channel-alias straggler deletes, and verification-expel trace deletes (`canDeleteMessages`) short-circuit **only** on confirmed `false`, sending requests normally on `undefined`.
  - **Deletion outcomes and honest notice copy** (`deleteMessageWithOutcome` → `deleted` | `gone` | `forbidden` | `failed`):
    - Both `deleted` and `gone` (HTTP 400 when an admin/member already deleted the message, another bot cleared the join service message, or the message aged past Telegram's delete window) count as settled cleanups.
    - When confirmed missing `canDeleteMessages` skips deletion calls, notices omit any claim that traces were cleaned up; among failed `deleteMessageWithOutcome` calls, only `forbidden` blames missing admin rights, whereas transient `failed` outcomes report the exact missed-vs-total count. Ad-disposal notices omit deletion status altogether because bulk deletes run in parallel on the main thread after `ruleAdDisposal` approves.
  - **Distinct from chat-admin cache**: The Worker's `workers/antiRaid/adminCache.ts` tracks which human members are group admins; `botPermissions` tracks the bot's own privilege bits. Neither substitutes for the other.

### Identity Resolution and Runtime Teardown

- **Two-Way Username Cache Consistency**:
  - `senderIdentity` maintains atomic bidirectional maps (`normalized username -> identity` and `sender ID -> current username`) across renames, removals, handle reassignments, and LRU evictions, rejecting alias collisions.
  - **Live `@username` re-verification on policy commands** (`commands/liveTargetIdentity.ts`):
    - Because cached `@username` entries reflect only the last observed message, commands gated by `requireIdentityPolicies` (`/block … enable|disable`, `/mute`, `/white`, and `/permission` mutations) re-query the resolved ID live before acting (`getChatMember` in the current chat for positive user IDs; `getChat` for negative channel/group IDs) and write the fresh profile back to `senderIdentity`.
    - Execution proceeds only when the live username still matches; mismatches evict the stale alias and refuse the command, and lookup failures likewise refuse (prompting the caller to reply to the message or pass a numeric ID). Direct message replies and numeric ID arguments are already authoritative and skip this probe.
- **Anonymous Admins and Group Identities**:
  - Anonymous group admins keep admin immunity for their own messages, cannot pass inviter verification exemptions to newcomers, resolve to the group identity for `/copy` and `/icon`, and are rejected as targets of destructive moderation commands.
- **Numeric User ID Arguments (`acceptUserId`)**:
  - Opt-in per command (`/block … enable|disable`, `/info`, etc., never `/copy` or CJK actions) for positive safe integers matching `USER_ID_ARG_PATTERN`; cache misses synthesize a minimal `{ id }` target through `resolveIdTarget`.
  - **Reply-vs-argument conflict rejection**: Supplying both a replied-to message and command arguments that resolve to different targets (or an unresolvable argument alongside a reply) fails closed rather than picking one silently; matching targets succeed.
- **Negative Chat ID Arguments (`acceptChatId`)**:
  - Opt-in via `acceptChatId` (`CHAT_ID_ARG_PATTERN`), permitted **only** on `/gag`, `/ungag`, `/delete_message`, `/block disable`, `/permission`, `/white`, `/translate` (stop target), and `/info`; all other commands reject negative IDs.
  - Channel personas enter the blocklist only via `/block` replies to a `sender_chat` message or automated ad detection (`/block enable` rejects raw negative IDs, while `/block disable` accepts them so operators can unban channels; `resolveIdTarget` sets `isChannel` from the ID sign so `workers/antiRaid/blocklistEffects.ts` calls `unbanChatSenderChat` instead of `unbanChatMemberIfBanned`).
- **`/gag` State Machine and Message Lifecycle**:
  - **Global slot ownership**: Main-thread sessions cap at `GAG_SESSION_MAX` globally; one `(chatId, targetId)` holds an exclusive slot across `starting → active → ending`.
  - **Activation & notice pairing**:
    - Human users receive an un-buttoned public group notice followed by a button-bearing ephemeral prompt scoped via `ephemeral_message_parameters.receiver_user_id`; channel targets receive a single public notice carrying the inline speak button.
    - The session enters `active` and arms its `unref()`ed expiry timer only after all required sends succeed and both `message_id` and `ephemeral_message_id` are recorded synchronously (if the second send fails, the first notice is deleted before freeing the slot).
  - **Teardown & bounded retry cleanup**:
    - Expiry, `/ungag`, or chat teardown synchronously claims `ending` and clears timers before deleting session messages sequentially, freeing the slot only once every message settles (`deleted` or `gone`) and any release receipt finishes.
    - `failed` or `forbidden` deletes retain the `ending` slot (blocking overlapping `/gag` sessions for that target, bounded globally by `GAG_SESSION_MAX`) and retry on `unref()`ed `GAG_CLEANUP_RETRY_DELAYS_MS` backoff; if exhausted, cleanup suspends until a later `/ungag`, chat teardown, or shutdown retries it.
    - Session notices bypass `COMMAND_MESSAGE_AUTO_DELETE_MS`, whereas `/ungag` receipts auto-delete after 30 s. Gag drains before the Telegram outbound gate on shutdown; unsettled cleanup withholds final offset confirmation and `bot.lock` release.
  - **Speak-notice refresh (`commands/gag/counter.ts` & `commands/gag/refresh.ts`)**:
    - Re-posts the speak prompt after `GAG_SPEAK_NOTICE_MESSAGE_INTERVAL` chat messages (if no `speakNoticeRefreshTask` is already running, up to `GAG_SESSION_MAX` tasks in `gagBackgroundTasks`) and, for human users only, on an `unref()`ed `GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS` timer.
    - Each refresh cleans any `retired` slot, sends the new prompt (`pending` recorded synchronously in `onSent`), swaps active IDs/topic, resets the message counter, and deletes the old prompt (retaining IDs to retry on failure).
    - **Post-idle speech**: `lastTargetMessageAt` updates only when the gagged user speaks; speaking after `>= GAG_SPEAK_NOTICE_IDLE_INTERVAL_MS` of silence triggers an immediate refresh and resets the timer (channel sessions refresh only on message-count thresholds or forum-topic changes).
  - **Inline protocol isolation & authentication**:
    - Queries lacking `GAG_INLINE_QUERY_PREFIX` route exclusively to inline fortune; queries starting with `GAG_INLINE_QUERY_PREFIX` terminate in gag (`${GAG_INLINE_QUERY_PREFIX}<canonical safe integer targetId> ` with zero extra tokens, digests, or chat IDs; `ParsedGagInlineQuery` carries no scope fields, and invalid/expired queries return an empty inline result without falling back to fortune).
    - `recordInlineResultSources` feeds ad-detection text matching only, never identity or chat authorization; posted inline cards embed `<target profile>#<session chatId>` and are deleted immediately on mismatch or cross-chat delivery.
- **`/delete_message` Targets and Deletion Queue**:
  - Stored in `ChatState.deleteMessageTargets` (`chat_states.status`, hot snapshot only, up to `DELETE_MESSAGE_CHAT_TARGET_MAX` distinct non-zero safe integers per initialized chat), strictly validated on startup (`decodeStoredChatStates` rejects the chat's own ID; `assertSuperAdminNotDeleteMessageTarget` rejects `SUPER_ADMIN_USER_ID`).
  - Main-thread queue (`packages/cache/main/deleteMessage.ts`, unpersisted, capped at `DELETE_MESSAGE_QUEUE_MAX`): preamble ingress runs synchronously between Anti-Raid and gag (single `Map` lookup when empty; claims without enqueueing when full). One consumer loop runs under its own `runWithUpdateAbortSignal` scope, batching consecutive same-chat IDs into `deleteMessages` without retries; chat teardown purges unsent entries and persists target removal, and shutdown drops un-drained entries past budget with an error log.
- **`/icon steal` Profile Fallback**:
  - Always queries live `getChat(targetId)` as authoritative; context usernames never short-circuit the lookup and serve solely as diagnostic log hints.
- **Chat Runtime Teardown**:
  - Domain handlers (`copy`, `translate`, `gag`, `deleteMessage`, `qa`, `batchKick`, `wed`, `aiChat`, `antiRaid`, `joinLog`) register in `packages/cache/main/chatTeardown.ts` via `packages/infra/chatTeardownRegistry.ts` so `packages/infra/chatTeardown.ts` has zero static imports of business modules, starting synchronously in `CHAT_TEARDOWN_ORDER` (`packages/consts/chatTeardown.ts`) before awaiting settlement together.
  - **Reason predicates (`packages/libs/chatTeardown.ts` over `ChatTeardownReason`)**:
    - `explicitDisable` (`/init disable`), `departed` (bot removed/left), and `gone` (group upgraded via `migrate_to_chat_id` or `chat not found`): `purgesChatData === true`—purges `/wed` pools, join logs, Q&A rows, batch-kick sequences and Mini App completion snapshots (`batchKickPreflightSeqsByChat`, `batchKickInFlightSeqByChat`, `miniAppBatchKickCompletedByChat`), and `chat_states`.
    - `lostAuthority` (bot demoted from admin while still in chat): pauses runtime state while keeping persisted data and Mini App snapshots intact for permission recovery.
    - `isChatUnreachable` (`departed` | `gone`) skips Telegram delete/restore API calls and drops local message IDs only; `abandonsLockdown` (`gone` only) drops lockdown records via `chatGone`; AI memory purges on **every** teardown reason.
  - **Idempotent departure boundary (`completeChatDeparture` in `packages/infra/botAdmin.ts`)**: Clears `botPermissions`, runs all teardown owners, resets blocklist sweep state, and clears `ChatState` (except any active `lockdown` awaiting `unlock`) from exactly three entry points: `my_chat_member` kick/leave (`departed`), `migrate_to_chat_id` preamble ingress (`gone`; the upgraded supergroup requires a fresh `/init`), and confirmed unreachable chats in startup title maintenance.
- **Membership Probe Boundary**:
  - Zero `await` points may sit between verifying the unchanged in-memory terminal state reference after `probeChatMembership` and invoking `kickChatMember`.
- **No Ban Outcome Cache for `/block`**:
  - Every `/block` fan-out re-sends `banChatMember` (with `revoke_messages`) across all managed chats, and every `/block disable` re-sends cross-chat unbans, skipping only chats where `canRestrictMembers` is confirmed `false`.

### `/wed` Member Persistence and Interaction

- **Daily Member Review** (`commands/wed/memberReview.ts`):
  - Triggered exclusively by the Disk I/O Worker's native Bun cron (`DISK_IO_MAINTENANCE_CRON` in the configured time zone via `midnightMaintenance`); the main thread runs no separate cron.
  - Iterates every restored managed group sequentially (up to `WED_MEMBER_LIMIT` user IDs per group), spacing `getChatMember` probes by `WED_MEMBER_REVIEW_INTERVAL_MS` with a `WED_OPERATION_TIMEOUT_MS` per-call budget.
  - Calls `removeWedMember` only on confirmed departure or HTTP 400 `PARTICIPANT_ID_INVALID` (unlogged as an error), while live speech, `chat_member`, or join observations during the scan veto stale removals and transient errors retain the member. Non-admin groups hitting 403 or 400 `CHAT_ADMIN_REQUIRED` log once, abort that group's scan, and retain all members (drawing departed members in non-admin groups is expected).
- **Admission and Permissions Gateway**:
  - `/wed` commands and callbacks require `/init` (`isInitEnabled === true`); uninitialized chats only strip departing users on leave events without allocating state.
- **Cache and Persistence Architecture**:
  - **Authoritative Member Cache (`packages/cache/main/wedMembers.ts`)**: Per-chat `FifoMap<number, number>` (`packages/libs/fifoMap.ts`, `userId → enteredAt`) capped at `WED_MEMBER_LIMIT` in monotonic `enteredAt` order (`max(now, lastEnteredAt)` on insert; existing speakers keep their original `enteredAt`; full maps evict the oldest entry; channels, forwards, and anonymous admins are excluded).
  - **Session Interaction Cache (`packages/cache/main/wed.ts`)**: One session per `(chatId, userId)` in a per-chat `FifoMap` of capacity `WED_SESSION_CAPACITY` (`WED_SESSION_LIMIT + WED_MAX_CONCURRENT`, across at most `STATE_MANAGED_CHAT_LIMIT` chats without LRU eviction); `trimWedSessions` evicts the oldest idle delivered entry down to `WED_SESSION_LIMIT` after each delivery (or after restoring `previous` on a failed redraw) while skipping busy sessions.
  - **Disk Flush & Group Purge**: Marks dirty only on real insertions, removals, or evictions (`FLUSH_MAX_ENTRIES` or `FLUSH_INTERVAL_MS`), posting a flat `[id, enteredAt, ...]` array that Disk I/O atomically writes as `{ id, enteredAt }[]` to `memory/wed/<chatId>.json`. `purgeWedMembers` tracks monotonic delete IDs in `pendingWedMemberDeletes` until durably acknowledged (replayed across Worker respawns).
- **Read-Only Startup Gate**:
  - Startup validates every `memory/wed/<chatId>.json` file (canonical negative group ID filename, `{ id, enteredAt }` shape, unique positive safe-integer user IDs, non-decreasing non-negative `enteredAt`, per-group cap, and total group cap), aborting startup on any violation without modifying files.
- **Drawing and Avatar Pipeline**:
  - Draws candidates from `memory/wed`, fetches avatars via `readCurrentAvatar` (`getChat`, purging the user across all groups on HTTP 400 `Bad Request: chat not found`), and schedules work on `createPrioritizedBoundedTaskRunner` (`WED_MAX_CONCURRENT` active, `WED_MAX_PENDING` queued).
  - **Photo Delivery & Redraw (`sendWedResult` in `commands/wed/messages.ts`)**: Sole send boundary; cards stay permanently in chat (including after sliding out of `WED_SESSION_LIMIT`). Redraws delete the previous photo **only after** the replacement sends (retaining the old photo and session on failure, and sending zero delete calls if the bot already `departed`).

<p align="right"><a href="#quick-navigation">↑ Back to quick navigation</a></p>

### `/info` Profile Lookups

- **Argument Parsing & Budget**:
  - `commands/info.ts` enables `acceptUserId`, `acceptChatId`, and `allowSelfTarget` (the sole command allowed to inspect the bot itself), running in the `interactive` tier of `deferredCommands.ts` under `INFO_TASK_BUDGET_MS` (replying with partial fields on timeout and aborting silently on shutdown).
- **Profile & Avatar Acquisition**:
  - Queries users via `readChatMemberUser`, channels/groups via `getChat`, and the bot via `ctx.me` (falling back to cached sender metadata), sanitizing names with `sanitizeDisplayName` (stripping bidi controls), formatting IDs as `code` entities, and fetching user/channel avatars via `readCurrentAvatar`.
- **Receipt Delivery**:
  - Sends via `sendCommandPhoto` (`infra/telegram/commandPhotos.ts`, auto-deleted after `COMMAND_MESSAGE_AUTO_DELETE_MS` in groups and retained in private chats), falling back to `sendCommandMessage` if photo delivery fails.

### `/h_image` Random Pictures

- **Read-Only Library Directory Inspection, Adoption Separation, and Hot Reload**:
  - Configured via `onlyPath.random_h_image_dir` in `config/dynamic/assets.json` (default `RANDOM_H_IMAGE_DIR`), `packages/infra/imageGallery.ts` separates read-only inspection (`inspectRandomImageDirectory`, validating existing readable/writable/executable directories of `<64 lowercase SHA-256 hex>.jpg/.jpeg/.png/.webp` regular files—allowing a symlinked root directory—or the nearest writable/executable ancestor when `ENOENT`, without creating directories or mutating caches) from adoption (`adoptRandomImageDirectory`, creating missing directories via `mkdirSync` only on commit and synchronously replacing live caches). Invalid directories abort startup or reject hot reload/Mini App saves without mutating existing caches; a directory deleted at runtime is never recreated automatically.
- **Drawing Algorithm & Gallery Dual Caches** (`cache/main/hImage.ts`):
  - **Dual sorted caches**: `inspectRandomImageDirectory` + `adoptRandomImageDirectory` at startup or hot reload (and lazy first access when uncached) populate `randomImageDirectoryCache` (ascending filename order for uniform draws and counts) and `randomImageGalleryCache` (descending `mtimeMs` order for Mini App gallery pagination). `storeRandomImage` (`/h_image add` and Mini App uploads) binary-inserts into both caches in place, and `deleteRandomImageFile` (Mini App delete) removes from both in place without re-sorting on page turns.
  - **Uniform draw (`pickRandomImage`)**: Samples uniformly from `randomImageDirectoryCache` entries `<= RANDOM_IMAGE_MAX_BYTES`, evicting vanished files from both caches on `ENOENT` and excluding oversized candidates for that draw (`tooLarge` if only oversized files existed; `empty` if none remain).
- **Rate Limiting & Deferred Scheduling**:
  - `/h_image` and `/h_image add` share a global sliding window (`H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW` per `H_IMAGE_RATE_LIMIT_WINDOW_MS`, dropping excess calls silently) and run on `commands/deferredCommands.ts` (`interactive` tier for draws; `background` tier for `add`, `/batch_kick`, and `/block` fan-out, draining before the Telegram outbound gate on shutdown).
- **Send Boundary & Album Collection (`add`)**:
  - `sendHImageResult` (`commands/hImage/draw.ts`) is the sole photo boundary (permanent spoiler photo routed to the trigger's forum topic and message; notices use `COMMAND_MESSAGE_AUTO_DELETE_MS`).
  - `/h_image add` requires `isCanAddHImage`, collects the replied photo plus same-`media_group_id` siblings from `mediaGroups.ts` in batches of `H_IMAGE_ADD_DOWNLOAD_BATCH_SIZE` within `H_IMAGE_ADD_TASK_BUDGET_MS`, hashes SHA-256, writes via UUIDv7 temp file + atomic rename, and deduplicates identical hashes.

### `cron.json` Scheduled Tasks

- **Configuration Parsing and Source Verification** (`packages/config/cron.ts`, `packages/config/cronAction.ts`):
  - Missing `cron.json` means zero scheduled tasks; any malformed entry rejects the entire file with `{ filePath, fieldPath, expected }` diagnostics only. `parseCronConfig` is pure (zero I/O), while `loadCronConfig` verifies that local `path` files are regular files (following symlinks) and `rand_image` paths are directories.
  - **Table & schedule constraints**:
    - Top-level array bounded by `CRON_MAX_TASKS`, `CRON_MAX_ACTIONS_PER_TASK`, and unique trimmed task names `<= CRON_TASK_NAME_MAX_CHARS` (no undeclared keys; `just_once`, `rand_image`, and `is_blurred` must be booleans).
    - `payload.path` resolves relative to `RUNTIME_DATA_ROOT` (rejecting empty strings and NUL bytes). `time_zone` defaults to the startup zone and validates via `parseTimeZone`; `cron` parses via `Bun.cron.parse` in that zone and must have at least one future fire time; optional `rand_cron` (`"<min>-<max>"` or single `m`/`h`/`d` token within `[CRON_RANDOM_INTERVAL_MIN_MS, CRON_RANDOM_INTERVAL_MAX_MS]`) is mutually exclusive with `just_once: true`.
  - **Per-action payload rules**:
    - `send_message`: non-empty trimmed `content` (`<= TELEGRAM_MESSAGE_MAX_CHARS`).
    - `send_image` & `send_file`: optional `content` caption (`<= TELEGRAM_CAPTION_MAX_CHARS`). `send_file` requires exactly one of `url` (trimmed absolute HTTP/HTTPS) or `path`; fixed `send_image` accepts 1–`CRON_MAX_IMAGES` items (`sendPhoto` for 1, `sendMediaGroup` with caption on item 0 for 2+), whereas `rand_image: true` sends a single photo.
    - `send_voice`: single-line `content` (`<= VOICE_OPERATOR_TEXT_MAX_CHARS`) and optional `tone` (`<= VOICE_TONE_MAX_CHARS`).
    - `send_web_digest`: single-line `topic` (`<= WEB_DIGEST_TOPIC_MAX_CHARS`), optional `language` (`WEB_DIGEST_LANGUAGES`, default `WEB_DIGEST_DEFAULT_LANGUAGE`), integer `max_items` in `[WEB_DIGEST_MIN_ITEMS, WEB_DIGEST_MAX_ITEMS]` (default `WEB_DIGEST_DEFAULT_MAX_ITEMS`), and optional `instructions` (`<= WEB_DIGEST_INSTRUCTIONS_MAX_CHARS`).
  - **Cross-config gates & `chat_id` targets**: `assertCronAgentSupported` verifies `agent.tts` for `send_voice` and core AI chat readiness for `send_web_digest` on startup and hot reload; `chat_id` must be a non-empty array—`["all"]` (`CRON_ALL_CHATS`), `["except", <id>, ...]` (`CRON_EXCEPT_CHATS`), or up to `CRON_MAX_CHAT_IDS_PER_TASK` unique safe-integer chat IDs.
- **Hot Reload and Schedule Reconciliation** (`packages/cron/scheduler.ts`, `cache/main/cron.ts`):
  - Starts before `startConfigReload`; each task owns an `unref()`ed in-process Bun cron handle that skips overlapping triggers while a prior run is still active. Deleting `cron.json` swaps in an empty schedule; invalid reloads keep the active schedule untouched.
  - **Diff reconciliation**: Deep-equal tasks keep their live handles; modified or deleted tasks cancel action-gap and retry sleeps immediately and stop after any in-flight Telegram call settles; `just_once` unregisters on fire and records in a `CRON_JUST_ONCE_RECORD_MAX` LRU (cleared if edited to recurring); `rand_cron` picks a uniform delay on each fire, rounds up to `CRON_MINUTE_MS`, and arms a single-shot cron in `CRON_RANDOM_FIRE_TIME_ZONE` without catching up missed downtime ticks.
- **Delivery and Execution Dispatch** (`packages/cron/run.ts`, `packages/cron/delivery.ts`):
  - Spaces actions by `CRON_ACTION_GAP_MS`, retrying transient network/5xx/429/`TelegramSendQueueFullError`/TTS/search errors on `CRON_ACTION_RETRY_DELAYS_MS` while aborting the round immediately on permanent failures (missing TTS, exhausted reserve quota, invalid audio, or sourceless/oversized digests).
  - **Per-round caching**: `CronRoundVoices` synthesizes `send_voice` once per round (reusing the returned Telegram `file_id` after the first chat upload), and `CronRoundDigests` renders `send_web_digest` MarkdownV2 once per round across all target chats.
  - **Broadcast (`all` / `except`) & upload rules**: `packages/cron/targets.ts` iterates initialized non-excluded chats in ascending ID order, probing live `can_send_*` rights via `getChatMember`/`getChat` and logging skipped chats once at round end. `delivery.ts` sends permanently without `message_thread_id`, enforces `TELEGRAM_PHOTO_UPLOAD_MAX_BYTES` and `TELEGRAM_DOCUMENT_UPLOAD_MAX_BYTES`, and reopens local file streams on every attempt so HTTP 429 retries never read a consumed stream.
- **AI Digest Generation (`send_web_digest` in `workers/aiChat/ai/webDigest.ts`)**:
  - Uses `agent.web_search` when configured (otherwise the `text` model's native search): zero-search non-empty replies prepend a model-memory warning, whereas searched replies enforce an HTTPS URL allowlist built strictly from returned source metadata (rejecting fabricated URLs), structured-JSON-formatted by the `text` model (`libs/webDigest.ts`, up to `WEB_DIGEST_COMPOSE_ATTEMPTS` attempts) within main-thread timeout `WEB_DIGEST_REQUEST_TIMEOUT_MS`.

### Reply and Response-Body Resource Boundaries

- **Bounded Reads and Memory Management** (`libs/boundedResponse.ts`):
  - Tracks cumulative chunk bytes while streaming (ignoring empty chunks), coalescing into `Bun.ArrayBufferSink` once chunk count reaches `BOUNDED_RESPONSE_CHUNK_THRESHOLD` with mean size below `BOUNDED_RESPONSE_COALESCE_BYTES`, and aborting immediately on byte-cap overflow, disconnect, or `AbortSignal` (non-2xx avatar fetches actively cancel unconsumed bodies).
- **AI Concurrency & Delivery Capacity Controls**:
  - Tool execution scopes span through final Telegram delivery and cleanup, bounded at `REPLY_DELIVERY_MAX_PER_CHAT` per chat and `REPLY_DELIVERY_MAX_TOTAL` across the AI Worker.

## Persistence

- **Strict Validation of Persisted Inputs and Ancestor Paths**:
  - `libs/fileAccess.ts` (`inspectOptionalDirectory` and `inspectOptionalFile`) recursively checks ancestor directories whenever paths are absent, aborting startup on broken or cyclic symlinks, directories occupying file paths, `ENOTDIR`, or `EACCES`.
  - Domain directories may be valid symlinks, whereas regular persisted data files (including `memory/global/state.json`) strictly forbid symlinks.
  - Startup inspects every persistence domain read-only first (SQLite database, pending verifications, logs, fortunes, AI memory, and `/wed` member pools); any error aborts startup immediately before generating secrets, publishing state, or touching on-disk files.

### Durability and Snapshot Contracts

- **Identity Fields Persisted Verbatim**:
  - Target metadata for `/copy` and `/translate` (`username`, `first_name`, `last_name`, `title`) persists and reloads byte-for-byte as returned by Telegram without trimming (empty and whitespace-only strings remain valid; unknown fields render static placeholders, and sensitive keys are excluded from logs).
- **Global State `memory/global/state.json`**:
  - Persisted via latest-snapshot coalescing, temporary file + `fsync` + atomic `rename`, holding only top-level `copy` (required) and `ttsUsage` (optional) with zero `.bak` files.
  - `loadCurrentGlobalState` aborts startup if legacy `state.json` or `state.json.bak` exists at the data root (`assertLegacyStateFilesAbsent`) or if schema decoding fails. `/copy` target mutations wait for durable revision confirmation before replying or taking effect in middleware.
- **`ttsUsage` Thread Ownership and Flushing**:
  - The AI Worker (`cache/workers/aiChat/ttsUsage.ts`) owns authoritative daily counts; main-thread `cache/main/storage.ts` keeps a persistence mirror updated by full `ttsUsage` snapshots (`{ windowStartedAt, agentCount, reserveCount }` or `null`) and flushed lazily after `STATE_BACKGROUND_SAVE_DELAY_MS` (or immediately on shutdown/explicit flush).
  - `pendingAiTtsReservations` stays strictly in AI Worker memory. The `TTS_USAGE_WINDOW_MS` window resets on wall-clock rollback past `windowStartedAt`, and lowering configured quotas rejects new over-limit calls without rewriting recorded counts.
- **Translation Sessions (`ChatState.translate`)**:
  - Stored inside SQLite `chat_states.status` (hot read copy capped at `STATE_MANAGED_CHAT_LIMIT`), holding up to `TRANSLATE_CHAT_USER_LIMIT` target identities and languages (`TRANSLATE_LANGUAGE_LABELS`) per chat (`undefined` when empty; startup rejects any `translate` key inside `memory/global/state.json`).
  - `translate/message.ts` translates serially per chat in the background (capped at `TRANSLATE_CHAT_BACKLOG_MAX`, skipping empty/command/already-in-target-language messages before queueing); `/translate` toggles await durable `persistChatState` before replying.
- **Read Boundaries for State Files**:
  - `memory/global/state.json` is checked via `lstat`: symlinks (valid or dangling), directories, and `EACCES`/`ELOOP`/`ENOTDIR` abort startup; only `ENOENT` counts as absent. UTF-8 decoding runs in fatal `TextDecoder` mode (stripping UTF-8 BOM) without modifying corrupt files.
- **Asset Configuration `config/dynamic/assets.json`**:
  - Permits exactly three top-level groups—`onlyPath` (`random_h_image_dir`), `pathOrUrl` (`bot_default_avatar`), and `onlyUrl` (inline fortune and gag thumbnails)—falling back to `consts/ui/assets.ts` defaults when omitted and rejecting undeclared groups or keys.
  - **Transport & path rules**: Client-fetched `onlyUrl` thumbnails require `https://`, whereas `bot_default_avatar` accepts `http://`, `https://`, or local paths (absolute, `./`, or `../`).
  - **Default-avatar media validation (`defaultAvatarPhotoType`)**:
    - **Static avatar**: JPEG or PNG `<= BOT_PROFILE_PHOTO_MAX_BYTES`.
    - **Animated avatar**: MP4 `<= BOT_PROFILE_ANIMATION_MAX_BYTES` containing at least one `vide` (`hdlr`) track whose `tkhd` presentation dimensions are all non-zero squares `<= BOT_PROFILE_ANIMATION_MAX_SIDE`.
    - **MP4 box integrity**: Must begin with an `ftyp` box declaring an MP4 brand followed by top-level boxes filling the exact file length with a single `moov` box; children inside `moov`, `trak`, and `mdia` must likewise tile their parent payloads cleanly within `MP4_MAX_SCANNED_BOXES` total boxes.
    - **Validation timing & read bounds**: Local avatar files are validated both at config load and before avatar restoration, while remote URLs are validated at restoration (`DEFAULT_AVATAR_MAX_READ_BYTES` read cap; `DEFAULT_AVATAR_FETCH_TIMEOUT_MS` fetch timeout).
- **Unified Log Threshold and Redaction**:
  - `logger.*` calls below the active `log_level` threshold return before serialization or redaction; accepted logs prepend `CONSOLE_PREFIX_BY_LOG_LEVEL` (`[INFO]` / `[OPERATION]` / `[WARN]` / `[ERROR]`) on console output with native structured object rendering, forward across threads as prefix-free `LogMessage` payloads, and persist to `logs/<YYYY-MM-DD>.json` as `{ level, message, args? }` (`message` joins string arguments, while `args` stores only non-string structured arguments and is omitted when absent).
  - Before writing to stdout/stderr, Worker log envelopes, or `logs/`, accepted logs scrub every configured token and API key, strip query strings, fragments, and userinfo from logged HTTP(S) URLs (`origin + pathname` only), exclude passwords/OTP/`initData` signatures/raw chat or Q&A bodies from `operation` audits, expand `cause` / `AggregateError` chains up to `LOGGER_NESTED_ERROR_MAX_DEPTH`, and cap serialized arguments at `LOGGER_MAX_SERIALIZED_BYTES` (replacing cycles with static markers).
- **Canonical Chat State Shape and Normalizer**:
  - `createChatState` (`libs/chatState.ts`) initializes every `ChatState` property up front (using `undefined` for absent fields and never calling `delete`). `normalizeChatState` clears expired `quietUntil` timestamps (allowing `QUIET_CLOCK_SKEW_TOLERANCE_MS` skew and clamping large clock rollbacks to `now + QUIET_MAX_DURATION_MS`).
  - `chat_states.status` encodes only non-default fields; confirmed `botPermissions` snapshots persist even when all bits are `false` so confirmed lack of privilege remains distinct from unprobed `undefined`.
- **Batch Persistence and Midnight Maintenance**:
  - Dirty AI memories flush every `AI_SNAPSHOT_INTERVAL_MS` into shared Disk I/O SQLite transactions updating `chat_states.ai_context`. Append-only files (fortunes, pending verifications, logs, AI cache usage, and ad samples) batch-flush with `fsync` at `FLUSH_MAX_ENTRIES` or `FLUSH_INTERVAL_MS`.
  - On `DISK_IO_MAINTENANCE_CRON` in the configured time zone, Disk I/O triggers `midnightMaintenance`: notifying the main thread to run `/wed` daily member review and rotating cross-day files for fortunes, logs, join records, and verification journals.
- **Join Log (`joinLog`) Batching and `/batch_kick` Retrieval**:
  - `recordJoinLog` appends `chat_member` joins to the main-thread unacknowledged mirror and returns synchronously; Disk I/O batches by `chatId:day`, ACKs via `(through, pending)` sequence numbers, and retains failed writes on backoff without dropping records.
  - `/batch_kick` reads `[since, now]` windows (`<= DAY_MS`) keyed by Telegram event `joinedAt` in the configured time zone, deduplicating to each user's latest join, skipping protected identities, handing blocklisted users to blocklist repair/resweep, and kicking remaining present members via `kickChatMemberWithOutcome`.
- **Startup Snapshots for Prompts and Atmospheric Copy**:
  - `prompt/persona.md` (default `DEFAULT_AI_PERSONA`) and `prompt/voice_tool.md` are captured once at startup preflight as immutable snapshots without hot reload.
  - Group notice tone comes from `bot.json` `atmosphere` (`mesugaki` | `normal`, defaulting to `normal` when a custom `prompt/persona.md` exists and `DEFAULT_BOT_ATMOSPHERE` otherwise). Mini App console copy ignores this setting and always uses the teasing (`mesugaki`) tone.

### Chat State and `chat_states`

- **Authoritative Storage and Capacity Limits**:
  - Stored in SQLite `chat_states` with a main-thread hot read copy capped at `STATE_MANAGED_CHAT_LIMIT` (`packages/cache/main/chatState.ts`). `status` stores feature switches (including `isProxySendEnabled`), `quietUntil`, `lockdown` WAL state, `botPermissions`, `title`, `translate` sessions, and `deleteMessageTargets`.
- **Capacity Enforcement**:
  - **Zero LRU eviction**: `assertChatStateCapacity` rejects additions when full (enforced at startup decode, main-thread admission, and Disk I/O commit). Map iteration preserves insertion order (`get` never reorders) for deterministic cross-chat `/block` fan-out. Only `/init enable` may allocate a new chat slot (replying `INIT_CHAT_LIMIT_TEXT` when full).
- **State Cleanup and Tombstoning**:
  - Pre-write `normalizeChatState` strips expired fields; when `isEmptyChatState` becomes `true`, the hot entry is removed and a deletion tombstone commits to SQLite (`/init disable` clears `title` as well so unmanaged chats release their slot).
- **Unique Proxy-Send Target (`isProxySendEnabled`)**:
  - At most one chat globally may hold `isProxySendEnabled === true`, verified across rows whenever enabling `/send`.
- **Durability Barriers**:
  - Authoritative toggles await exact revision ACKs via `persistChatState`, whereas reconstructible metadata updates (title refreshes, invalidated permission probes) write asynchronously via `saveChatStateInBackground`.

<p align="right"><a href="#quick-navigation">↑ Back to quick navigation</a></p>

### Chat Q&A and `chat_qa`

- **Authoritative Storage & Composite Primary Key**:
  - Stored in SQLite `chat_qa` (`PRIMARY KEY (chat_id, q)` with an index on `q`; total rows `<= STATE_MANAGED_CHAT_LIMIT × CHAT_QA_MAX_PER_CHAT`), loaded in full at startup into the main-thread hot copy (`packages/cache/main/qa.ts`).
- **Multi-Layer Limit Enforcement**:
  - Per-chat `CHAT_QA_MAX_PER_CHAT` is checked independently in `setChatQa`, Disk I/O transaction staging, and startup full-table decode.
- **`/qa set` Form Authentication & Lifecycle**:
  - Checks `isCanControllQaPermission` and binds the session to `(openedById, messageThreadId)`; subsequent messages are claimed only when sent by that same visible sender inside that exact forum topic (`forumTopicThreadId`), re-checking session liveness after every `await` and routing prompts/cleanup through `qa/notices.ts`.
  - **Field validation**: Rejects questions `> CHAT_QA_QUESTION_MAX_CHARS`, answers `> CHAT_QA_ANSWER_MAX_CHARS`, or slash commands matching `containsRenderableCommand` anywhere in the question or outside ```` ``` ```` code fences in the answer (parsed with `renderFencedText`), keeping the form open and replying with `QaFormIngressResult.rejection`.
- **Echo Prevention for Bot Messages**:
  - Listens on `["message", "channel_post"]` and filters self-sends via `isBotOwnMessage` in ascending cost order: `Map` chat-ID lookup → local `selfSentTracker.ts` ID check → cross-thread `waitForBotOwnMessage`.
- **Formatting, Preview Truncation & Board Paging**:
  - Stores literal ```` ``` ```` fences in SQLite (counted toward `CHAT_QA_ANSWER_MAX_CHARS` and converted to entities on direct reply). `renderQaFormPrompt` truncates only the answer preview when long while keeping the question intact and saving full text; `/qa query` previews `QA_QUERY_ANSWER_PREVIEW_MAX_CHARS` per row across `QA_QUERY_PAGE_MAX_ENTRIES`-row pages via `callback_data`.
- **Direct Answer Matching & AI Isolation**:
  - Questions trim on write and match character-for-character at runtime (case-folding only a leading `@bot_username` mention), firing ahead of AI chat regardless of `/quiet`, terminating the update, and staying out of AI rolling memory.
  - **Lazy JSON payload for AI tools**: The main-thread Q&A cache lazily builds and caches `{ jsonText, count }` per chat (invalidated on Q&A write/delete or chat teardown) and passes only those two primitives in `trigger` so `group_qa_query` and `group_qa_answer` parse JSON on demand without cross-thread mirrors or fuzzy matching.

### Blocklist and Ad Detection

This section covers the [authoritative blocklist and the block command](#authoritative-blocklist-and-the-block-command), [ad-detection admission, classification, and disposal](#ad-detection-admission-classification-and-disposal), [bans and message revocation](#bans-and-message-revocation), the [blocklist-removal outbox](#blocklist-removal-outbox), [replay after permission restoration](#replay-after-permission-restoration), and [deleted-account detection in the blocklist](#deleted-account-detection-in-the-blocklist).

#### Authoritative blocklist and the block command

- **Authoritative Storage & Cache Consistency**:
  - Stored in SQLite `blocklist_entries` with main-thread LRU + pending-write overlay (`identityPolicyCache`). Entries never expire by time and are removed solely via `/block disable` or [deleted-account detection](#deleted-account-detection-in-the-blocklist).
  - Strict JSONB rows store `blockedAt`, Telegram profile fields, and optional `participantInvalidCount` (integer in `[1, BLOCKLIST_PARTICIPANT_INVALID_LIMIT - 1]` when present; `0` omitted).
- **Full Unblock Workflow (`/block disable`)**:
  - Requires `isCanUnBlock`. If listed, the main thread writes a negative cache entry, strips the ID from `pendingBlockedRemovals`, posts the updated outbox rows **before** queueing `queueBlocklistDeletion` (so Disk I/O commits outbox updates ahead of deleting the referenced blocklist row), and then unbans across all `managedAdminChatIds` (origin chat first; `unbanChatMemberIfBanned` with `only_if_banned: true` for users, `unbanChatSenderChat` for channels; chats confirmed lacking `canRestrictMembers` skip the call and count as failures).
- **Protected Identities & Serialization**:
  - `isWhitelisted` (`SUPER_ADMIN_USER_ID` + permanent allowlist; temporary ad bypass excluded) protects targets across `/block`, `/mute`, and `/batch_kick`, while `/white enable` rejects blocklisted IDs. `runProtectedIdentityMutation` serializes policy checks and cache updates on the main thread (queueing temporary-bypass tombstones before blocklist writes) while keeping network calls and flush waits outside the critical section.
- **Persistence Barriers & Domain Isolation**:
  - `confirmBlocklistPersisted` (`confirmIdentityPolicyPersisted("blocklist", id, …)`) flushes only the shared SQLite transaction domain and verifies an exact revision ACK for `id`, isolating unrelated file domains (AI cache usage and ad samples log errors as non-fatal side channels during full flushes). Re-running `/block` while an entry or tombstone is still unacknowledged resubmits the same revision via `requeueUnacknowledgedIdentityWrite`.
- **Chat-Level Sweeps & State Latch (`sweepBlockedMembers`)**:
  - Runs whenever `isInitEnabled && botIsAdmin`, setting `blocklistSweepState.sweptAt` only on `blockedMembersRemoved` with `complete: true` (reset to `null` via `requestBlocklistResweep` on incomplete removals, backing off linearly from `BLOCKLIST_SWEEP_RETRY_INTERVAL_MS` to `BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS` before fetching ID pages, and cleared via `forgetChatBlocklistWork` on `/init disable`, demotion, or departure).
- **Missing Permissions vs. Target is Admin**:
  - HTTP 403 or HTTP 400 matching `TELEGRAM_PERMISSION_DENIED_DESCRIPTION_PATTERN` (`packages/consts/telegram.ts`, covering missing admin/right errors as well as admin/owner/self protection refusals) classifies as `forbidden` via `isPermissionDenied`:
    - **Target is group admin**: Probing sweeps (`probeMembership: true`) detect admin status directly from `probeChatMembershipWithOutcome` without calling `banChatMember`; non-probing instant kicks and ad disposals (`probeMembership: false`) call `probeChatAdmin` after receiving `forbidden`. Confirmed admin targets log an error, settle that target so the rest of the batch continues, and set `targetIsAdmin: true` so the main thread leaves `sweptAt` unset.
    - **Bot lacks `can_restrict_members`**: Worker returns `permissionDenied`, setting `permissionBlocked` on the main thread and marking outbox rows `missing-permission` until `my_chat_member` or a probe confirms `canRestrictMembers: true`.
- **Task Durability & Instant Bans**:
  - `trackBlockedRemoval` records batches in `pendingBlockedRemovals` for replay across Worker respawns; blocklisted joins bypass verification for instant ban (`recentBlockedJoinCounts` deduplicates paired `chat_member` + `new_chat_members` events, increments join-spike counters, and deletes join service messages).
- **Thread Coordination & Cross-Chat Fan-Out** (`commands/blocklistFanOut.ts`):
  - `/block enable|disable` acquires a FIFO turn on the target's per-identity `blocklistIdentityMutationRunner` slot (shared with ad disposal):
    - When idle, the SQLite write and persistence ACK finish inside the current update before handing cross-chat bans/unbans (`MANAGED_CHAT_BATCH_CONCURRENCY`) to the `background` deferred-command tier; when an earlier disposal for that same identity is still running, the write, fan-out, and receipt all defer in order so the update returns immediately.
    - Shutdown cancellation before execution logs an error and skips both the deferred list mutation and receipt.
    - Each list mutation re-checks that the target identity is still in the identity LRU at its own mutation point (`enable` inside the `runProtectedIdentityMutation` critical section, `disable` at the start of `removeFromBlocklist` within the slot), re-prefetching if it was evicted while waiting; a failed prefetch only replies that storage is unavailable, without touching the list or fanning out.

#### Ad-detection admission, classification, and disposal

- **Admission Gates & Re-check**:
  - Requires `ChatState.isAdDetectEnabled === true`, bot admin status, and a non-protected sender (`SUPER_ADMIN_USER_ID`, all permanent whitelist members, and active temporary ad bypass identities are uniformly exempt across candidate admission, referenced-ad warnings, and disposal re-checks). Granting permanent whitelist membership (`/white enable` or Mini App) or entering temporary ad bypass posts `clearIdentityAdDetect` to clear queued bundles, referenced warnings, and suppression keys in the Worker. Before deleting or punishing on `adDetected`, the main thread re-checks chat toggles, whitelist protection, and `ad_detect.json` inside `blocklistIdentityMutationRunner` and `runProtectedIdentityMutation`; rejected verdicts delete zero messages and immediately post `releaseAdDetectDedup` to the Worker (toggling off mid-flight logs an info message as an expected race).
- **Exemptions & Special Message Sources**:
  - Skips `is_automatic_forward`, `isBotOwnMessage`, channel post bodies quoted in discussion replies, and human group owners/admins (admin bots are still inspected and punished). Self-inline posts (`via_bot === self`) inspect the user's raw query registered in `recordInlineResultSources` (`INLINE_RESULT_SOURCE_MAX_AUTHORS`), skipping unregistered/mismatched posts.
- **Queue Management & Flow Control** (Anti-Raid Worker):
  - Coalesces consecutive messages per `chatId:senderId` into one `pendingAdMessages` bundle (up to `AD_DETECT_MAX_PENDING_SENDERS` senders without evicting unjudged entries; `AD_DETECT_MAX_MESSAGES_PER_SENDER` messages and `AD_DETECT_BUNDLE_MAX_CHARS` chars per bundle, moving overflow message IDs into `pendingDeleteIds`).
  - Pops up to `AD_DETECT_BATCH_SIZE` bundles every `AD_DETECT_QUEUE_TICK_MS` under global `AD_DETECT_MAX_IN_FLIGHT`. Recently flagged `chatId:senderId` keys enter `recentlyDisposedAdKeys` for `AD_DETECT_JUDGED_RETENTION_WINDOW_MS`, deleting straggler messages one by one without re-classifying (skipped for ordinary users already on the permanent blocklist, whose `revoke_messages` ban removes history). The main thread immediately releases `recentlyDisposedAdKeys` via `releaseAdDetectDedup` when rejecting a verdict, finishing an in-chat punishment (`mute` / `kick` / `banChat` / `deleteOnly`), or completing a global block without handing off a trigger-chat removal batch; when the trigger-chat batch is handed off, `blocklistEffects` releases the key once the ban settles.
- **Three-Stage Detection Pipeline & Multimodal Classification**:
  - Candidate collection (`packages/antiRaid/adCandidate.ts`) extracts photos (`message.photo`), image documents matching `AD_DETECT_IMAGE_DOCUMENT_MIME_TYPES` (falling back to `document.thumbnail` when `file_size > MEDIA_MAX_DOWNLOAD_BYTES`), static/animated/video stickers, and custom emojis strictly from the sender's own message (never `reply_to_message` or `quote`), admitting media-only messages without text.
  1. **Sticker pack blacklist** (Worker count mirror `adPackBlacklistCounts.sticker`, authoritative store in main-thread 768-entry LRU / SQLite `ad_pack_blacklists`): Short-circuits synchronously in O(1) when count is zero; otherwise deduplicates valid `sticker.set_name` values and checks via the duplex bridge (`matchAdPackBlacklist`) against the main-thread 768-entry LRU (falling through to Disk I/O SQLite on cold misses and backfilling the LRU). Hits dispose immediately without calling AI; lookup failures log an error and fail-safe to later stages.
  2. **Custom emoji pack blacklist** (Worker count mirror `adPackBlacklistCounts.emoji`, authoritative store in main-thread 768-entry LRU / SQLite `ad_pack_blacklists`):
     - Short-circuits in O(1) when count is zero; otherwise checks `custom_emoji_id` against the Worker's `customEmojiMetaCache` (`packages/cache/workers/antiRaid/adDetect.ts`, capacity `AD_DETECT_CUSTOM_EMOJI_SET_CACHE_MAX`, cleared on Worker stop, storing `{ setName, visionFileId, fileUniqueId }` shared with Stage 3 vision downloads) first and batch-checks cached pack names via the duplex bridge against the main-thread 768-entry LRU / SQLite; uncached IDs batch (`TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS`) through `getCustomEmojiStickers` on the main-thread `query` lane, cache results, and check each batch's resolved pack names against the main-thread 768-entry LRU / SQLite—any match disposes immediately without calling AI.
     - Transient lookup errors share `AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES` immediate retries across batches (4xx errors never retry); exhausting retries or hitting shutdown logs an error and falls through to stage 3.
  3. **AI multimodal and text classification** (`agent.ad_detect` with `samples` in `ad_detect.json`):
     - **Media selection & cumulative byte budget** (`packages/workers/antiRaid/adDetect/media.ts`): Deduplicates by `kind + fileUniqueId` up to `AD_DETECT_MAX_IMAGES_PER_BUNDLE` images per bundle, selecting unchecked entries (`seq > checkedSeq`) first, backfilling remaining slots from context entries (`seq <= checkedSeq`) newest-to-oldest, and emitting in chronological order. Downloads concurrently via main-thread `downloadFile` (`purpose: "vision"`) and transcodes via `prepareVisionImage`, enforcing a cumulative prepared-image byte budget of `MEDIA_MAX_DOWNLOAD_BYTES` across the bundle (budgeting unchecked attachments before context attachments and skipping overflow items with a warning) while producing both `combined` and `direct` (non-forwarded) slices without re-downloading. Media-only rounds with zero loaded unchecked attachments skip redundant AI calls (`notAd`).
     - **Google Decisions API path** (`provider: "google"` with `use_decision: true`, `packages/workers/antiRaid/adDetect/ai/googleDecision.ts`): Normalizes `base_url` via `resolveGeminiDecisionEndpoint` (accepting gateway root, `/<apiVersion>`, or `/<apiVersion>/decisions`, defaulting to `GEMINI_API_BASE_URL` + `GEMINI_API_VERSION`) and evaluates `ad` (`AD_DETECT_DECISION_AD_THRESHOLD`), `category` (`AD_DETECT_DECISION_CATEGORIES`), and per-candidate `sticker_pack_N` / `emoji_pack_N` (`AD_DETECT_DECISION_PACK_THRESHOLD`) in a single `client.decisions.create` request; fails closed (`null`) on non-empty `prompt_feedback.block_reason`, malformed answers, or API errors.
     - **Generative multimodal path** (`google` with `use_decision: false`, `openai`, `anthropic`): Pairs `firstName`/`lastName`, non-forwarded text, declarative newcomer verification facts outside user text, and labeled images, requiring bare `"JSON"` output (switching Google and Anthropic structured output to `AD_DETECT_PACK_JSON_SCHEMA` with pack attribution instructions whenever pack candidates exist, and filtering returned packs strictly against current slice candidates); bare link-only messages without promotional/commercial copy always classify as `false`. On explicit vision-unsupported errors (`isExplicitUnsupportedMediaError` in `packages/aiProviders/mediaSupportError.ts`), guards against hot-reload races via config identity before caching `adDetectVisionSupport.current = "unsupported"` (reset on `agent.ad_detect` reload or Worker stop) and falls back to text-only classification (or `{ isAd: false }` without text).
     - **Referenced-only warning boundary** (`verdict.ts` & `referencedWarning.ts`): `referencedOnly` warnings strip all pack attributions and never auto-blacklist packs.
- **Disposal Execution, Ad Pack Blacklist Persistence & Notices** (`states/adPunishment.ts`, `packages/infra/adPackBlacklistStorage.ts`, `packages/antiRaid/adBlacklistPersistence.ts`):
  - On hit, the Worker bundles `deleteMessageIds` into `adDetected` without deleting prematurely; once the main thread approves the verdict and reads `punishment` from `ad_detect.json`, it schedules batched message deletion (`TELEGRAM_DELETE_MESSAGES_BATCH_MAX`) in parallel inside `inFlightAdDisposals` and applies the selected punishment:
    - `kick` + `block_scope: "global"`: runs `blockUser`, flushes SQLite, and posts durable cross-chat removal batches (users and channels alike).
    - `mute`: mutes in the triggering chat (`duration - MUTE_DISPATCH_MIN_REMAINING_MS` deadline for timed mutes; no `until_date` for permanent).
    - `kick` + `block: false`: kicks without ban once `chatIsSupergroupById` is known and live membership is confirmed (skipping if already permanently blocklisted).
    - `kick` + `block_scope: "chat"`: bans in the triggering chat via `banChatMember` (`revoke_messages: true`) without adding to the global blocklist.
    - **Channel identities** under non-global modes have their messages deleted without sending member-restriction calls. In-chat punishments track in `inFlightAdDisposals` without entering the durable outbox (abandoned on shutdown timeout, restart, or `ad_detect.json` removal).
  - **Ad pack blacklist storage, 768-entry LRU cache & auto-blacklisting**:
    - **Authoritative store, 768-entry shared LRU & cold-read isolation**: Sticker and custom emoji pack blacklists persist in the SQLite `ad_pack_blacklists` table (`PRIMARY KEY (kind, pack)`, `kind IN ('sticker', 'emoji')`, with no per-kind entry cap; startup streams and validates every row in Disk I/O and hydrates only per-kind counts into `packages/cache/main/adPackBlacklist.ts` before `initAntiRaid` without loading the table into memory). The main thread maintains one shared bounded LRU read cache (`adPackBlacklistCache`, capacity `AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES` = 768 across sticker and emoji packs, storing positive and negative hits): hot lookups (`findFirstBlacklistedAdPack` / `readAdPackBlacklistStates`) check unacknowledged writes and the 768-entry LRU first, falling through to Disk I/O SQLite in chunks of `AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES` (256) using connection-level prepared statements (key equality for single packs, `json_each` for batches) and backfilling the LRU; listings and searches (`/ad_detect <sticker|emoji> list` and Mini App `GET /api/ad-blacklists`) cold-read SQLite cursor pages via `listAdPackBlacklistPage` (`AD_PACK_BLACKLIST_PAGE_SIZE` = 256, overlaying unacked writes) without reading or writing the 768-entry LRU.
    - **Write protocol & isolated count sync**: All main-thread mutations serialize on `adPackBlacklistMutationChain` (cold-reading SQLite before mutating cold keys to preserve exact counts), follow shared SQLite pending budgets, write through the 768-entry LRU, and track monotonic revision ACKs (`"adPackBlacklist"` domain, batch threshold `AD_PACK_BLACKLIST_WRITE_BATCH_MAX_ENTRIES`, Disk I/O respawn replay at `DISK_IO_RESPAWN_PRIORITIES.AD_PACK_BLACKLIST` directly from unacknowledged write intent without depending on LRU residency). Main-thread updates push an independent `AdPackBlacklistSyncMessage` (`stickerCount` / `emojiCount`) via `registerAdPackBlacklistObserver`: `adoptAdPackBlacklistSyncMessage` updates only `adPackBlacklistCounts` and never resets AI SDK clients, `adDetectPrompts`, or `adDetectVisionSupport`.
    - **Auto-blacklisting persistence**: When a direct ad hit carries AI-attributed sticker or custom emoji packs, the main thread schedules `persistAutoBlacklistedAdPacks` inside `inFlightAdDisposals` (non-blocking to sender punishment, drained on shutdown): normalizes and deduplicates names against `STICKER_PACK_NAME_PATTERN`, excludes packs configured in `config/dynamic/stickers.json`, writes via `addAdPackBlacklistBatch` into the 768-entry LRU, counts, and Disk I/O queue (broadcasting `AdPackBlacklistSyncMessage` once after updates), and confirms durability via `flushAdPackBlacklistWrites` (`"adPackBlacklist"` domain). When disk confirmation fails, it logs a warning and retains unacknowledged revisions in memory for Disk I/O replay without throwing or modifying `config/dynamic/ad_detect.json`.
    - **Shared manual management boundary**: `/ad_detect sticker|emoji` (`list|add|remove`, requiring `isCanControllAdDetectPermission`) and Mini App `GET|POST /api/ad-blacklists` share `packages/infra/adPackBlacklistStorage.ts` (`listAdPackBlacklistPage` / `persistAdPackBlacklistAdd` / `persistAdPackBlacklistRemove` / `confirmAdPackBlacklistPersisted`, re-queuing unacknowledged revisions on duplicate/no-op calls), enforcing `STICKER_PACK_NAME_PATTERN` and `stickers.json` own-pack protection uniformly with no per-kind entry cap.
  - Notices send via `sendTemporaryMessageOnMain` (`COMMAND_MESSAGE_AUTO_DELETE_MS`), and matched samples append to daily-rotated `memory/ad-detected/sample.json`.

#### Bans and message revocation

- **Message Revocation Mechanisms**:
  - User blocklist bans (`/block`, instant kicks, sweeps, global ad blocks) and in-chat ad bans pass `revoke_messages: true` to `banChatMember`; channel persona bans (`banChatSenderChat`) have no `revoke_messages` parameter, so main-thread ad disposal explicitly deletes captured channel `deleteMessageIds` after approval.

#### Blocklist-removal outbox

- **Row-Level Write-Ahead & Budgeted ACKs** (`pending_blocked_removals`):
  - Every outbox row mutation or deletion posts a per-row `blocklistRemovalWrite` with a monotonic revision (checked upfront against `STORAGE_PENDING_MAX_ENTRIES` and `STORAGE_PENDING_MAX_BYTES`; overflow withdraws new rows and raises Disk I/O fatal shutdown) and releases its byte budget only on an exact `(removalId, revision)` commit ACK.
  - Diagnostic-only updates (`attempts`, `lastFailure`) stay in memory until flushed ahead of the next Worker dispatch; the main thread dispatches to the Anti-Raid Worker and acknowledges the Telegram update **only after** every active outbox row's current payload is durable (replaying unacknowledged rows in revision order on Disk I/O respawn).
- **Referential Integrity & Row Shapes**:
  - Disk I/O validates that every frozen `userIds` entry in an instant-kick row (`probeMembership: false`) exists in the effective blocklist and that sweep rows (`probeMembership: true`, storing only `chatId` and paging `BLOCKLIST_SWEEP_PAGE_SIZE` cursors at runtime) coexist with a non-empty blocklist—conversely rejecting blocklist deletions that are still referenced by outbox rows (skipped only inside `storageFlushHold` mirror replay, which re-verifies on close/startup). Outbox size caps at `BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES`.

#### Replay after permission restoration

- **Permission Recovery Sequencing**:
  - Restoring `can_restrict_members` replays `missing-permission` instant-kick and ad-ban outbox rows first, then schedules a full-list sweep (settling independently).

#### Deleted-account detection in the blocklist

- **Error Detection & Automatic Release**:
  - Sweep targets returning HTTP 400 `PARTICIPANT_ID_INVALID` across all `BLOCKLIST_REMOVAL_MAX_ATTEMPTS` attempts report in `participantInvalidUserIds` (incrementing `participantInvalidCount`, whereas `settledUserIds` resets it to `0`).
  - Reaching `BLOCKLIST_PARTICIPANT_INVALID_LIMIT` confirms a permanently deleted Telegram account and calls `unblockUser` (writing negative cache + deletion tombstone with an audit log, without broadcasting cross-chat unbans).

### Fortune and AI-Memory Recovery

- **Fortune Day Rollover & Deferral Queue**:
  - Switching local calendar days requires flushing the prior day's append buffer first (retaining the prior day owner on failure while queueing new draws in a `LUCK_DEFERRED_DRAW_MAX` FIFO so main-thread `dailyLuckCache` receipts are replayed once flush succeeds; missing secrets or date mismatches on non-empty day files abort startup/rollover).
- **Midnight Startup Tolerance**:
  - A 1-day boundary skew between main thread and Worker during midnight startup discards the stale day's cache non-fatally and lazily fetches today's secret via `ensureLuckCacheFreshForToday` on first draw.
- **AI-Memory Snapshot Hydration Gate**:
  - Startup accepts only current-schema snapshots (`AI_MEMORY_SNAPSHOT_KEYS`, single-line fields, quotes `<= REPLY_REFERENCE_MAX_CHARS`, `LOCAL_TIMESTAMP_PATTERN` timestamps, `<= AI_MEMORY_HYDRATE_BUFFER_MAX` messages, `<= MAX_SUMMARY_ROUNDS` summaries, across `<= AI_MEMORY_MAX_CHATS` chats) without truncation. If the AI Worker exhausts respawn attempts, `lastInitState.current` clears so `flushAiMemory` resolves `flushed` cleanly on shutdown.
- **In-Memory Message Index (`chatMessageIndexes`)**:
  - Ephemeral hot-window index updated synchronously on window edges; bot self-replies link via `reply_to_message` and fall back to the trigger snapshot once targets slide out of the hot window.

### Acknowledgement Boundary and Shutdown

- **Telegram Update Acknowledgement Boundary**:
  - Polls with `limit: UPDATE_POLL_LIMIT` and advances the offset only after middleware and durable side effects settle; any failed or shutdown-aborted update latches `hasFailedUpdate()`, withholding final offset confirmation and exiting non-zero for Telegram redelivery.
- **Long Polling & Network Backoff** (`app/updateFetcher.ts`):
  - Polls with `UPDATE_POLL_TIMEOUT_SECONDS` inside `UPDATE_POLL_RETRY_WINDOW_MS`, backing off exponentially from `UPDATE_POLL_INITIAL_RETRY_MS` to `UPDATE_POLL_MAX_RETRY_MS` (HTTP 429 waits full `retry_after` first and then applies the attempt's exponential backoff within the shared retry window; HTTP 401/409 exits fatally; linked-channel lookups time out after `LINKED_CHANNEL_FETCH_TIMEOUT_MS` and fail closed as `undefined`).
- **Final Offset Confirmation & Three-State Shutdown**:
  - Final `getUpdates` confirmation runs under `FINAL_OFFSET_CONFIRM_TIMEOUT_MS`, classifying shutdown via `classifyShutdown` into:
    - `clean`: All owners drained/flushed and final offset confirmed (`exit 0`, releases `bot.lock`).
    - `offsetWithheld`: All owners drained/flushed and Workers terminated, but final offset unconfirmed (`exit 1`, releases `bot.lock` so the next instance receives redelivery).
    - `unsettled`: Unfinished drain or persistence flush failure (`exit 1`, **retains `bot.lock`** until OS process exit).
- **Ordered Drain, SQLite Close & Monotonic Budgets** (`packages/app/lifecycle/maintenance.ts`, `packages/app/lifecycle/shutdown.ts`):
  - **Three-stage shutdown order**:
    1. Quiesce new work: stop `config/dynamic/` hot reload, update fetcher, and Mini App HTTP server (`stopMiniAppServer`), quiesce schedulers, and drain the update runner via `drainAcknowledgedUpdateRunner` using `runner.activeTask()` and `settleWithinBudget` within `RUNNER_DRAIN_TIMEOUT_MS` (calling `runner.abortActive()` on timeout and awaiting cancellation settlement within `RUNNER_CANCELLATION_SETTLEMENT_TIMEOUT_MS`, classifying `drained` / `aborted` / `unsettled`).
    2. Drain `SHUTDOWN_DRAIN_OWNERS` in strict order: `avatar` → `translate` → `antiRaid` (sends Worker `drain` to stop ad ticker and reconcile in-flight actions/persistence) → `gag` → `qa form` → `wed` → `deferred commands` → `cron` → `target message deletion` → `Telegram delayed deletion` → `ai` (`flushAiMemory`) → `telegram` (outbound gate) → `disk` (Disk I/O flush), followed by `StateStore` `flushAllToDisk` before confirming the final Telegram offset.
    3. `dispose()` repeats owner drains alongside terminal closes (close translate client, terminate AI Worker, close Telegram gate), runs `SHUTDOWN_TERMINATION_OWNERS` (`terminateAntiRaid` → `terminateDiskIO`), flushes `StateStore` (`flushStateToDisk`), and releases or retains `bot.lock` per `classifyShutdown`.
  - **Closing the shared SQLite database (`closeStorage`)**:
    - When the active Disk I/O generation is recovered, writable, and non-fatal, `terminateDiskIO` flips `writable = false` and sends `closeStorage` (`DISK_IO_STORAGE_CLOSE_TIMEOUT_MS`): the Worker commits remaining buffered writes in one transaction, runs `PRAGMA wal_checkpoint(TRUNCATE)` (a reader-blocked checkpoint logs a diagnostic without failing the commit), closes SQLite, and ignores subsequent identity writes.
    - Uncommitted writes, timeouts, rejections, or error replies still terminate the Worker while marking disk termination failed (`unsettled`). `closeStorage` is a control message and is never replayed across Worker respawns.
  - **Per-owner & total monotonic deadlines** (`monotonicDeadline.ts` on `performance.now()`):
    - `FlushTimeouts` assigns `antiRaidMs` (`ANTI_RAID_DRAIN_TIMEOUT_MS >= DISK_IO_FLUSH_TIMEOUT_MS`), `translateMs` (`TRANSLATE_REQUEST_TIMEOUT_MS`), and `maintenanceMs` for remaining maintenance owners (all `0` in `EMERGENCY_FLUSH_TIMEOUTS` on uncaught errors).
    - `SHUTDOWN_TOTAL_BUDGET_MS` starts at the first stop signal/fatal error (or `wait()`/`dispose()` entry) and caps every drain step, background-maintenance wait, final offset `getUpdates`, and `StateStore` flush to `min(stepBudget, remainingDeadline)` (`0` once expired). A zero-budget step starts no new write or request: `StateStore` settles as `timedOut` while a dirty or in-flight write remains (otherwise `flushed`), a Disk I/O flush sends no flush barrier and never counts as flushed, and the final offset confirmation skips `getUpdates`, withholds the offset, and sets exit code 1. In contrast, runner draining, Worker termination, `closeStorage`, and `bot.lock` release are never shortened by the total deadline.

### File Permissions and Schema

- **Runtime Directory Permission Baseline**:
  - Startup verifies (without `chmod`/`chown`) that the data root, `memory/`, and `logs/` do not exceed `RUNTIME_DATA_ROOT_MAX_MODE` (no group/other write bits), while `database/` uses setgid mode `IDENTITY_DATABASE_DIRECTORY_MODE` and files default to `IDENTITY_DATABASE_FILE_MODE`.
- **Preserving Permissions on Atomic Replacement**:
  - Every `tmp + fsync + rename` replacement reads and preserves the existing target file's mode, applying the default mode only when creating a brand-new file (`MINI_APP_CONFIG_DEFAULT_FILE_MODE` = `0o600` when the Mini App creates a missing optional deployment config file; `config/` stays read-only by default unless writable access is explicitly granted for Mini App online config editing).
- **Speculative Migration Prohibited & Current Schema Baseline**:
  - Runtime code accepts the current schema version only (`database/storage.sqlite` at `IDENTITY_DATABASE_SCHEMA_VERSION = 14`, 13 migrations in `STORAGE_MIGRATION_LINEAGE` from `0000_identity_storage` through `0012_ad_pack_blacklists` including the `ad_pack_blacklists` STRICT table; `config/dynamic/ad_detect.json` requiring exactly `{ punishment, samples }`); legacy or malformed persisted files abort startup immediately without automatic upgrades. Offline upgrades run explicitly via the active cold migration scripts registered in `scripts/migrations/active.ts` (`migrate:wed-member-window`, `migrate:ad-pack-blacklists`).

### Lockdown Mirror and Terminal Flags

See [Lockdown Mirror and Terminal Flags](04-lockdown-invariants.md) for persistence fingerprints, mirror recovery, and terminal-snapshot constraints.

## Compatibility Entry Points

- **Barrel Export Purity**: Top-level compatibility barrels re-export symbols only and never hold state, parse config, or trigger side effects on import.
- **Luck Receipt Signature Format & Safe Decoding**:
  - `libs/luckReceipt.ts` rotates HMAC secrets daily in the configured local time zone, requires the receipt date to match today, and catches malformed Base64/JSON `SyntaxError`s locally (returning `undefined` without throwing into update middleware).

---

<div align="center">

[← Prev: 03 Directory Map](03-directory-map.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#04-authoritative-runtime-invariants) · [Next: 05 Workflow →](05-dev-workflow.md)

</div>
