# 07 Operations and Troubleshooting

<p align="center">
  <a href="../cn/07-operations.md">简体中文</a> · <b>English</b> · <a href="../ja/07-operations.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="06-modification-guide.md">← Prev: 06 Recipes</a> · <a href="08-images-and-cron.md">Next: 08 Images and Scheduled Tasks →</a>
</p>

---

## Deployment Model

Copy Ninjia runs as a **single-instance long-polling** daemon:
- Requires no inbound webhook port or reverse proxy for Telegram updates (only the optional Mini App console uses HTTPS ingress; see [10 Mini App](10-mini-app.md)).
- Requires no external database service such as MySQL or PostgreSQL.
- Stores identity policies and managed-chat runtime state in a local SQLite database.
- Persists all other domain data as JSON or text files under the local data root.

<a id="hardware-guidance"></a>

### Hardware Guidance

<table width="100%">
<thead>
  <tr>
    <th width="24%" align="left">Deployment Scale</th>
    <th width="32%" align="left">Recommended Specs</th>
    <th width="44%" align="left">Capacity & Resource Planning Notes</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>🌱 <b>Starter</b></nobr><br><sub>(Low activity / text only)</sub></td>
    <td>2 vCPU / 2 GB RAM / Local SSD</td>
    <td>Runs reliably for text workloads. Workers may contend for CPU during multimodal bursts; 2 GB swap is strongly recommended.</td>
  </tr>
  <tr>
    <td><nobr>⚡ <b>Light Production</b></nobr><br><sub>(Few groups with AI)</sub></td>
    <td>4 vCPU / 2 GB RAM / Local SSD</td>
    <td>Stable for text traffic. 2 GB RAM leaves little headroom for concurrent media bursts; configure 2 GB swap.</td>
  </tr>
  <tr>
    <td><nobr>🌟 <b>Recommended Production</b></nobr><br><sub>(Moderately active groups)</sub></td>
    <td>4 vCPU / 4 GB RAM / Local SSD</td>
    <td>Balanced production sizing for moderate daily message volume (2 GB swap recommended).</td>
  </tr>
  <tr>
    <td><nobr>🔥 <b>High-Load Production</b></nobr><br><sub>(All groups AI / heavy images)</sub></td>
    <td>4 vCPU / 8 GB RAM / Local SSD</td>
    <td>Provides ample heap headroom for concurrent media downloads, Base64 encoding, and image transcoding.</td>
  </tr>
</tbody>
</table>

> [!NOTE]
> A single instance manages up to `STATE_MANAGED_CHAT_LIMIT` chats simultaneously. Practical ceilings come from Telegram Bot API rate limits, model provider quotas, and actual message/media throughput rather than raw group member counts.

---

### systemd Example

Manage the long-running service with systemd:

```ini
[Unit]
Description=Copy Ninjia Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=copy-ninjia
Group=copy-ninjia
WorkingDirectory=/opt/copy_ninjia
Environment=COPY_NINJIA_DATA_ROOT=/var/lib/copy-ninjia
ExecStart=/usr/local/bin/bun run start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

#### Directory Permissions and Security Controls

- **Pre-creating the data root**: Provision a dedicated service user and data root directory first:
  ```bash
  sudo install -d -o copy-ninjia -g copy-ninjia -m 0750 /var/lib/copy-ninjia
  ```
  In containerized deployments, mount the data root on a persistent volume with ownership configured on the host or by an init container. Never place `memory/` or `database/` on ephemeral container layers.
- **Automatic initialization and strict write protection**:
  - At startup, missing directories are created automatically: the data root and `RUNTIME_SENSITIVE_DIRECTORY_NAMES` (`logs/`, `memory/`, `memory/global/`) use ceiling `RUNTIME_DATA_ROOT_MAX_MODE` (`packages/consts/storage.ts`), and `database/` uses `IDENTITY_DATABASE_DIRECTORY_MODE` (`packages/consts/identityStorage.ts`), subject to process `umask`. **Symbolic links are rejected** across all of these paths.
  - The data root and `RUNTIME_SENSITIVE_DIRECTORY_NAMES` must be owned by the runtime UID with mode no broader than `RUNTIME_DATA_ROOT_MAX_MODE`. Any `group` or `other` write bit (`w`) causes **immediate startup rejection**.

> [!WARNING]
> **Data Isolation in Multi-Tenant Environments**:
> New files under `memory/` are created with `PERSISTED_FILE_MODE` (`packages/consts/diskIO/common.ts`, `0644`). If parent directories leave `other` read/traverse bits open, other local accounts on a shared host can read group records. On multi-user hosts, tighten the data root and `memory/` to `0750` and existing files to `0600` or `0640` (runtime code preserves existing file modes).
> Configure `database/` up to `IDENTITY_DATABASE_DIRECTORY_MODE` (`02770` with `setgid` when shared across a service group); the main database and WAL/SHM sidecars are created with `IDENTITY_DATABASE_FILE_MODE`. **Never run recursive `chmod 0750` across the entire data root**, because `database/` must retain group write access when shared by a service group. Keep `config/` read-only.

- **Automated crash recovery**: On an unexpected crash or non-zero exit, systemd restarts the process (`Restart=on-failure`). Pending join verifications, lockdown timers, identity writes, AI conversation memory, and unacknowledged Telegram updates recover deterministically per [04 Runtime Invariants](04-invariants.md#persistence).

---

### Binary Deployment

Official standalone binary archives bundle the `copy-ninjia` executable, `binary.json`, `package.json`, `install.sh`, cold-migration CLIs, configuration and prompt templates, and SQLite migration SQL files—no `node_modules/` directory is needed.
- **Initial setup**: Run `bash install.sh` inside the extracted release directory to walk through config generation and empty database creation; run `./copy-ninjia` directly for foreground verification.
- **systemd integration**: Set `WorkingDirectory` to the extracted directory and `ExecStart` to the absolute path of `copy-ninjia` (with no `start` argument). System-wide Bun does not need to be installed on the host.
- **Version upgrades**: The one-liner installer downloads the Latest archive and SHA-256 into a fresh directory and never overwrites a live deployment in place. Upgrade by stopping the service, backing up externally, verifying the new archive in a staging directory, running any required cold migrations, and replacing program files while preserving live `config/` and data-root state. Any leftover `node_modules/` directory is ignored and can be removed while stopped.
- **Cold-migration CLIs**: Packaged scripts live under `scripts/migrations/` and run via `BUN_BE_BUN=1 ./copy-ninjia scripts/migrations/<script>.js --help`. Production startup accepts only the current schema and never auto-migrates legacy formats.
- For build and release packaging details, see [05 Dev Workflow](05-dev-workflow.md#release).

---

<a id="data-root"></a>

## Data Root

Every runtime data path resolves under `COPY_NINJIA_DATA_ROOT` (defaults to the project root when unset; an explicit empty or whitespace-only value fails startup immediately):

### Calendar time zone

Set `time_zone` in `config/static/bot.json` (defaults to `DEFAULT_BOT_TIME_ZONE` in `packages/consts/bot.ts`). It is read once at startup and never hot-reloaded; individual tasks in `cron.json` can override it with their own `time_zone`.

**Permanent data-root time-zone binding**:
- When `database/storage.sqlite` is initialized, `IDENTITY_DATABASE_TIME_ZONE_KEY` (`"time-zone"`) is recorded in `storage_metadata`. Daily file rollovers, fortune receipt HMAC keys, temporary ad-bypass quotas, and join-log windows all follow this bound time zone.
- If `bot.json`'s `time_zone` disagrees with `storage_metadata.time-zone` at startup (or during `install.sh` preflight), the process aborts immediately and logs both values.
- Existing data roots cannot change time zones; restore `time_zone` in `bot.json` to the recorded value to start. Always back up and restore `database/` and `memory/` together from the same point in time.

### 1. Global State: `memory/global/state.json`
- **Responsibilities**: Persists global repeat settings `copy` (target user, mode, origin chat, cooldown timestamp) and the global TTS quota window `ttsUsage` (`windowStartedAt`, AI `agentCount`, reserved relay `reserveCount`).
- **Schema rules**:
  - Top-level keys allow only required `copy` and optional `ttsUsage` (unknown keys or malformed values **fail startup and installer preflight immediately**; a missing file starts clean).
  - `copy.copiedUser` is required (`null` when idle), and `copy.copyMode` accepts omitted, `reverse`, or `nya`.
  - When `ttsUsage` is present, `windowStartedAt`, `agentCount`, and `reserveCount` must all be non-negative integers with at least one greater than `0`.
- **Write mechanics**: Owned exclusively by the main thread via temp-file + `fsync` + atomic `rename` (the Disk I/O Worker never touches this directory). `copy` flushes immediately; `ttsUsage` coalesces over `STATE_BACKGROUND_SAVE_DELAY_MS` and flushes cleanly on shutdown (`kill -9` or power loss can drop at most the uncoalesced window delta).
- **Manual edits**: Stop the service, confirm process exit, back up outside the working tree with `mktemp -d`, preserve required fields, and validate against the schema before restarting.
- **Root-level legacy guard**: Any leftover `state.json` or `state.json.bak` directly in the data root aborts both startup and `install.sh`. Complete the [staged upgrade](#staged-upgrade) through 17.2.1 first, then move those legacy files out of the data root.
- **Mini App Authenticator: `memory/mini-app-totp/totp.json`** (optional; see [10 Mini App](10-mini-app.md)):
  - Written atomically by the main thread (`0o600`, temp file + `fsync` + `rename`) as `{ version: 1, secret, createdAt }` when the SuperAdmin binds a Google Authenticator (TOTP) secret in the Mini App console.
  - Loaded and validated once at startup into a main-thread holder (and checked read-only by `install.sh` preflight: missing = unbound; non-regular or malformed = rejected).
  - Runtime TOTP verification and status queries perform zero disk I/O; disk writes occur only when binding, rotating, or deleting the authenticator.

### 2. Dedicated Image Library: `random_h_image_dir`
- **Responsibilities**: Path configured by `onlyPath.random_h_image_dir` in `config/dynamic/assets.json` (defaults to `RANDOM_H_IMAGE_DIR` in `packages/consts/ui/assets.ts`, relative to the data root). Serves uniform random draws for `/h_image` and default `cron.json` `rand_image` actions, and supports uploads/deletions via `/h_image add` and the Mini App gallery.
- **Naming rules**: Every file must be a regular image whose basename matches `RANDOM_IMAGE_CONTENT_NAME_PATTERN` (lowercase hex SHA-256 of the file bytes plus an extension in `RANDOM_IMAGE_EXTENSIONS` from `packages/consts/imageGallery.ts`). Non-image files, subdirectories, and symlinks are forbidden.
- **Startup scan and live cache sync**:
  - Creates the directory if absent, then scans every entry into memory; invalid filenames, subdirectories, symlinks, or stray `RANDOM_IMAGE_TEMP_PREFIX` (`.h_image-add-*`) files **abort startup**.
  - Adding or deleting compliant files through `/h_image add` or the Mini App gallery updates in-memory caches immediately without a restart; hot-reloading `random_h_image_dir` pre-validates the new directory before swapping caches.
  - Files copied into the directory manually stay invisible to draws and the Mini App gallery until a service restart (or a hot reload switching to that directory); files deleted manually on disk are evicted from memory caches when next drawn or read by the gallery.

### 3. Group Marriage Candidates: `memory/wed/<chatId>.json`
- **Responsibilities**: Per-chat sliding window of active speakers stored in entry order (for example `[{"id":5974478892,"enteredAt":1791770134683}]`, where `enteredAt` is Unix milliseconds). Backed on the main thread by a reusable `Map<number, number>` per chat, capped at `STATE_MANAGED_CHAT_LIMIT` chats and `WED_MEMBER_LIMIT` members per chat.
- **Sliding-window rules**: A personal speaker not yet in the window is appended with the current timestamp (clamped so it never precedes the window's latest `enteredAt`); existing window members keep their original `enteredAt` on subsequent messages; when full, the earliest entry is evicted first.
- **Validation rules**: Filenames must be canonical negative safe-integer chat IDs, and each item must have exact keys `{ id, enteredAt }` with unique positive safe-integer `id`, non-decreasing non-negative safe-integer `enteredAt`, and length at most `WED_MEMBER_LIMIT`. Violations abort startup and `install.sh`; 17.2.1 member-ID arrays must first run the [/wed member window cold migration](#upgrade-wed-member-window).
- **Persistence**: Flushes via full atomic replacement on the Disk I/O Worker after `FLUSH_MAX_ENTRIES` mutations or `FLUSH_INTERVAL_MS`. Running `/init disable` or leaving the chat deletes the file.
- **Departure pruning**: Left-member service messages, `chat_member` events, and daily midnight sweeps prune departed users (the latter two require bot admin rights; in large non-admin groups with hidden member lists, departed members can remain eligible due to Telegram API visibility limits).

### 4. Stickers and Fortunes: `memory/stickers/` and `memory/luck/`
- **`memory/stickers/<pack>.json`**: Cached catalog for whitelisted sticker packs (`version`, per-sticker `file_unique_id`, emoji, description, and pack summary). Missing files resync from Telegram on demand; packs removed from the whitelist are deleted on startup.
- **`memory/luck/<YYYY-MM-DD>.json`**: Current day's fortune draws in the bound time zone, keyed by user ID with grade and query summary. Only today's file is retained.
- **`memory/luck/receipt-secret.json`**: Daily HMAC key authenticating inline fortune receipts (`version`, date, and hex secret matching `LUCK_RECEIPT_SECRET_PATTERN`). **Always back up and restore this file together with today's fortune file**—deleting or regenerating it alone invalidates existing receipts.

### 5. Pending Verification and Join Logs: `memory/anti-raid/` and `memory/joinlog/`
- **`memory/anti-raid/<YYYY-MM-DD>.json`**: Append-only daily log of join-verification Challenges (`active` records, revisions, settled tombstones, and unconfirmed `kickPending` evictions resumed on restart).
  - Steady state keeps only the current local day, compacting once appends or bytes reach `VERIFICATION_FILE_COMPACT_ENTRIES` or `VERIFICATION_FILE_COMPACT_BYTES`.
  - During compaction, if an earlier day file still exists, tombstones are appended for records that were active in the newest prior-day file and are now settled, preventing settled challenges from reviving if the process exits before prior-day cleanup finishes.
  - If that newest prior-day file fails decoding (invalid UTF-8 or schema mismatch) `VERIFICATION_PRIOR_DAY_DECODE_MAX_ATTEMPTS` consecutive times during live compaction, it is renamed with `VERIFICATION_CORRUPT_DAY_FILE_SUFFIX` (`<YYYY-MM-DD>.json.corrupt`) for manual inspection while the new day writes from the in-memory mirror (startup recovery and daily cleanup ignore `.corrupt` files, whereas a corrupt newest prior-day file encountered at cold startup still refuses startup).
- **`memory/joinlog/<chatId>.<YYYY-MM-DD>.json`**: Authoritative `chat_member` join log queried across a sliding window by `/batch_kick`.
  - **Persistence**: Buffered in the Disk I/O Worker and batch-appended with `fsync` at `FLUSH_MAX_ENTRIES` or `FLUSH_INTERVAL_MS`, with forced flushes before `/batch_kick` reads and during shutdown.
  - **Retention**: Keeps at least `JOIN_LOG_FILE_RETENTION_DAYS` calendar days in the bound time zone (extended across short DST days) and at most `JOIN_LOG_MAX_USERS_PER_CHAT_DAY` newest joins per chat-day; purged on `/init disable` or bot departure.

### 6. Core Identity and Chat State: `database/storage.sqlite`
Accompanied while open by SQLite WAL (`-wal`) and shared-memory (`-shm`) sidecars:
- **Stored tables** (schema `IDENTITY_DATABASE_SCHEMA_VERSION`):
  - `storage_metadata`: Holds `IDENTITY_DATABASE_METADATA_KEYS` (`IDENTITY_DATABASE_SCHEMA_KEY` and `IDENTITY_DATABASE_TIME_ZONE_KEY`).
  - `permission_list.policy`: Persistent user permission policies stored as strict JSONB.
  - `blocklist_entries`: Authoritative global blocklist.
  - `temporary_ad_bypass_entries`: Accumulated temporary ad-detection bypass credits.
  - `pending_blocked_removals`: Pending cross-chat ban enforcement queue.
  - `chat_qa`: Per-chat Q&A pairs keyed by `(chat_id, q)`.
  - `chat_states`: Up to `STATE_MANAGED_CHAT_LIMIT` managed-chat rows containing required `status` JSONB (including `translate` sessions capped at `TRANSLATE_CHAT_USER_LIMIT`) and nullable `ai_context` JSONB (verbatim dialogue memory and rolling summaries).
- **Exclusive ownership**: Only the Disk I/O Worker opens `storage.sqlite` read-write. Startup runs SQLite integrity checks, JSONB decoding, schema/lineage verification, and mutual-exclusion checks before hydrating chat state and AI memory.
- **Shutdown close**:
  - On clean shutdown, the Disk I/O Worker commits pending writes, checkpoints and truncates the WAL into `storage.sqlite`, and closes the handle, leaving only `storage.sqlite` in `database/`.
  - `-wal` and `-shm` remain on disk if the process was killed (`SIGKILL`) or if an external reader blocked checkpoint truncation.
  - If shutdown cannot confirm all pending writes were committed, it exits non-zero as `unsettled` and logs a `[diskIO]` error.
- **Backup rule**: **Always back up and restore `storage.sqlite` together with its contemporaneous `-wal` and `-shm` sidecars (when present) as a single atomic unit**—never copy `.sqlite` alone.

### 7. Ad Samples and AI Usage: `memory/ad-detected/` and `memory/ai-daily-usage/`
- **`memory/ad-detected/sample.json`**: Audit log of messages caught by ad detection (timestamp, raw text, verdict reason, context; sticker-only hits record the sticker pack short name). Rotates to `sample.<date>[.<seq>].json` at `AD_SAMPLE_FILE_MAX_BYTES` and prunes archives older than `AD_SAMPLE_ARCHIVE_RETENTION_DAYS`.
- **`memory/ai-daily-usage/usage.json`**: Token and request counters containing zero message text:
  - **Layout**: `summary` holds the most recently completed local calendar day grouped by capability, provider, and model; remaining entries record unsummarized calls for the current day.
  - **Coverage**: Tracks every capability in `AGENT_CAPABILITY_NAMES`.

### 8. Logs and Instance Lock: `logs/` and `bot.lock`
- **`logs/`**: English structured error logs written asynchronously in batches by the Disk I/O Worker.
- **`bot.lock`** (plus `.guard` / `.recovery`): Linux `/proc`-backed single-instance lock guaranteeing at most one active process per data root.

---

### Data Root Management and Maintenance Scheduling

- **Directory isolation**: `memory/` holds no loose root files—every domain owns a dedicated subdirectory, while identity policies and chat states live in `database/`.
- **Read-only startup preflight**: Startup scans and decodes every persisted file in read-only mode first (including all `joinlog/` files within the retention window), adopts state into memory only after every domain passes, then provisions missing directories, cleans orphan temp files, and schedules daily maintenance in `bot.json`'s `time_zone`.
- **Midnight maintenance cron**: Runs daily at `00:00` (`DISK_IO_MAINTENANCE_CRON` in `packages/consts/diskIO/maintenance.ts`) in order: `/wed` member revalidation, fortune rollover, log rotation, AI token aggregation, join-log pruning, ad-sample cleanup, Challenge log compaction, and ad-bypass credit decay. An error in one task never aborts the rest.
- **Temporary files vs. pure in-memory state**:
  - Atomic-write temp files (`.<target>.<pid>.<uuid>.tmp`) left behind by hard crashes are logged without deletion during preflight and reclaimed by post-adoption maintenance.
  - `storage.sqlite-wal` and `storage.sqlite-shm` are active SQLite WAL files—**never delete them as temp files**.
  - Join-challenge countdown timers, pending ad-detection queues, and short-lived Telegram caches live purely in memory.

---

<a id="identity-storage-migration"></a>

## Persistent Data Migration

**Production code carries zero backward-compatibility branches and never auto-migrates schemas at startup**. Every migration runs offline after stopping the service and confirming process exit. If any step fails, preserve external backups and the staging state—never force-start the new version or overwrite live `config/` with `config_example/`.

Before any offline migration, create an external backup directory with `mktemp -d` outside the working tree, copy all affected files, and record paths, ownership, modes, and SHA-256 digests. After running a migration script, reconcile source and output SHA-256 hashes in `ready.json`, verify startup validation passes, restore original ownership and modes when swapping files in, and observe at least two supervisor restart intervals (`active/running`, unchanged `NRestarts`, zero non-zero journal exits) before removing external backups.

### Fresh Deployment Database Initialization

If `database/storage.sqlite` is missing at startup, the bot exits with an error instead of creating an implicit database. Fresh deployments initialize an empty current-schema database via the [identity storage initialization steps in 01 Getting Started](01-getting-started.md#initializing-identity-storage) (`install.sh` runs this automatically when no database exists, and the initializer refuses to overwrite an existing file).

<a id="upgrade-wed-member-window"></a>

### /wed Member Window Cold Migration (Member ID Arrays → `{ id, enteredAt }`)

Use [`scripts/migrateWedMemberWindow.ts`](../../scripts/migrateWedMemberWindow.ts) to convert `memory/wed/<chatId>.json` from 17.2.1 member-ID arrays into entry-ordered `{ id, enteredAt }` sliding-window arrays:
- **Window conversion**: Keeps the last (most recent) `WED_MEMBER_LIMIT` IDs per chat in original order with `enteredAt` set to the migration start timestamp; older excess IDs are dropped from the front and counted under `truncatedMembers` in `ready.json`.
- **Accepted inputs**: Accepts only 17.2.1 member-ID arrays (up to `WED_MEMBER_WINDOW_SOURCE_LIMIT` unique positive safe-integer IDs per file across at most `STATE_MANAGED_CHAT_LIMIT` chat files). Already migrated files, non-canonical filenames, and symlinks are rejected; non-`.json` files such as `*.tmp` are ignored.
- **Other persistent files & `ad_samples.json` → `ad_detect.json` config change**:
  - All other `memory/` subdirectories and `database/storage.sqlite` (Schema v13) from 17.2.1–18.2.0 use the same format and carry over directly.
  - If `config/dynamic/ad_samples.json` is present (from 17.2.1–18.2.0), manually migrate it while stopped to `config/dynamic/ad_detect.json`—carrying over `samples` and adding required `punishment` (`mute` or `kick`), `sticker_black_list`, and `emoji_black_list`—and remove `ad_samples.json` (`packages/config/layout.ts` and `install.sh` reject `ad_samples.json`).

1. **Stop service and back up**: Stop the service, confirm it is `inactive`, and back up `memory/wed/` (plus `config/` if migrating `ad_samples.json`) with ownership, modes, and SHA-256 manifest to an external directory preserving the `memory/wed/` relative path.
2. **Execute the migration script**:
   ```bash
   bun run migrate:wed-member-window \
     --source-root /absolute/cold-backup \
     --output-root /absolute/new-staging-directory
   ```
   Binary releases run `BUN_BE_BUN=1 ./copy-ninjia scripts/migrations/migrateWedMemberWindow.js` with the same flags.
3. **Verify migration output**: Check `ready.json` in the output directory, reconciling SHA-256 digests in `sourceFiles` and `outputFiles` along with `chatCount`, `keptMembers`, `truncatedMembers`, and `enteredAt` (staged files are created readable/writable only by the current user).
4. **Swap migrated files and update `ad_detect.json` if needed**: While stopped, replace each deployed `memory/wed/<chatId>.json` with its staged counterpart, restore ownership and modes from `sourceFiles`, and confirm the service user can write `memory/wed/`. If `config/dynamic/ad_samples.json` exists, convert it to `config/dynamic/ad_detect.json` (with `punishment`, `samples`, `sticker_black_list`, and `emoji_black_list`) and delete `ad_samples.json`.
5. **Verify startup**: Start the service, observe two supervisor restart intervals cleanly, and only then remove external backups.

---

<a id="staged-upgrade"></a>

### Staged Upgrades from Older Layouts

- **Deployments older than 17.2.1**: Current cold-migration scripts accept only 17.2.1 inputs. Upgrade to 17.2.1 first and complete its migrations (16.3.2 runs `migrate:chat-persona-removal`; earlier versions step through their own guides up to 16.3.2), confirm 17.2.1 starts stably, and then stop the service to run this release's [/wed member window cold migration](#upgrade-wed-member-window) and manually migrate any `config/dynamic/ad_samples.json` to `config/dynamic/ad_detect.json` (adding `punishment`, `sticker_black_list`, and `emoji_black_list`, then deleting `ad_samples.json`).
- **Major version path from 11.0.9 (Schema v8)**:
  Run each historical cold-migration edge sequentially in isolated checkouts:
  1. Commit `500e848fae`: `migrate:ai-context` (v8 → v9)
  2. Tag `12.1.0`: `migrate:clear-context-permission` (v9 → v10)
  3. Tag `13.0.2`: `migrate:h-image-add-permission` (v10 → v11) and `migrate:bot-config`
  4. Tag `14.0.0`: `migrate:translate-sessions`
  5. Tag `16.3.2`: `migrate:global-state` and `migrate:random-image-names`
  6. Tag `17.2.1`: `migrate:chat-persona-removal` (v11 → v13)
  7. Latest version: `migrate:wed-member-window`, plus manual migration of any `config/dynamic/ad_samples.json` → `config/dynamic/ad_detect.json` (adding `punishment`, `sticker_black_list`, and `emoji_black_list`, then removing `ad_samples.json`)

  *Tip*: Step 1 can also use `copy-ninjia-schema-v9-source-500e848f.tar.gz` attached to the 12.0.0 Release (SHA-256: `df6502625512d8fde136dc66d8470e1d4c977856e8a0bd3909b9b6c763c820f8`).

---

<a id="startup-failures"></a>

## Startup Failures

Startup follows a strict **Fail-Fast** contract: any config or persistence violation aborts before network polling starts and prints the offending file path, JSONPath/field, and expected shape. Fix the underlying data rather than bypassing checks:

### 1. Data-Root Preflight Failure
- **Cause**: Symlinks under the data root, `memory/`, `memory/global/`, `logs/`, or `database/`; directory UID mismatch or permissions broader than `RUNTIME_DATA_ROOT_MAX_MODE` (`group`/`other` write bits); `database/` broader than `IDENTITY_DATABASE_DIRECTORY_MODE` or missing service-group write access; or a filesystem lacking `fsync`, hard links, or atomic `rename`.
- **Solution**: Stop the service, set the data root and `RUNTIME_SENSITIVE_DIRECTORY_NAMES` to the runtime UID with mode `0750` (within `RUNTIME_DATA_ROOT_MAX_MODE`), set `database/` to `0750` or `02770` (within `IDENTITY_DATABASE_DIRECTORY_MODE`), and place the data root on a local POSIX filesystem.

### 2. `bot.lock` Refuses Startup
- **Cause**: Another live instance holds the data root (even under a different Bot Token), or `bot.lock` is malformed or from a legacy format.
- **Solution**: Follow [`bot.lock` Refuses Startup](#botlock-refuses-startup) below.

### 3. Configuration Directory Layout Mismatch
- **Cause**: `config/`, `config/static/`, or `config/dynamic/` contains non-allowlisted entries (misplaced files, legacy `telegram.json` or `ad_samples.json`, dotfiles/swap/backup files, extra subdirectories, or broken symlinks), `config/dynamic/` is missing, or a config directory path is not a directory.
- **Solution**: While stopped, leave only `bot.json` and `g-auth.json` in `config/static/`, leave only the 6 dynamic JSON configs in `config/dynamic/`, and move backups or stray files outside `config/`. For legacy `telegram.json`, follow the [staged upgrade](#staged-upgrade) (`migrate:bot-config`); for legacy `ad_samples.json`, manually migrate it to `config/dynamic/ad_detect.json` (preserving `samples` and adding required `punishment`, `sticker_black_list`, and `emoji_black_list`) and remove `ad_samples.json`.

### 4. Config Schema Validation Failure
- **Cause**: A file in `config/{static,dynamic}/*.json` is missing required keys, has wrong types/bounds/enums, or includes unknown keys.
- **Solution**: Fix the exact file and JSONPath reported in the startup error against the [Deployment Configuration Guide](../../config_example/README/en.md).

### 5. Identity Database Validation Failure
- **Cause**: `storage.sqlite` is unwritable or corrupt, its schema version is unmigrated, `bot.json` `time_zone` disagrees with `storage_metadata.time-zone`, or an ID appears in both the blocklist and temporary ad-bypass table.
- **Solution**: Restore `time_zone` in `bot.json` to match `storage_metadata.time-zone`; for pre-v13 databases (such as v11 from 16.3.2), run the [staged upgrade](#staged-upgrade) through 17.2.1; for physical corruption, restore `storage.sqlite` together with its matching `-wal`/`-shm` sidecars from backup. Never overwrite with a blank DB or hand-edit rows.

### 6. Inconsistent Fortune Results and Receipt Key
- **Cause**: Today's fortune file and `receipt-secret.json` come from mismatched backups, failing HMAC verification.
- **Solution**: Stop the service and restore the entire `memory/luck/` directory from one consistent backup snapshot; never delete or regenerate `receipt-secret.json` by itself.

### 7. Invalid Global State File or Residual Legacy state.json
- **Cause**: `memory/global/state.json` fails schema validation, or legacy `state.json` / `state.json.bak` remains in the data root.
- **Solution**: Back up first, then fix invalid fields or run the [staged upgrade](#staged-upgrade) through 17.2.1 and move root-level legacy files out of the data root.

### 8. Invalid /wed Candidate Files
- **Cause**: `memory/wed/<chatId>.json` fails window validation (for example, still a 17.2.1 member-ID array, missing `enteredAt`, decreasing `enteredAt`, or more than `WED_MEMBER_LIMIT` items) or has a non-canonical chat-ID filename.
- **Solution**: Back up while stopped and run the [/wed member window cold migration](#upgrade-wed-member-window) for 17.2.1 ID arrays, or repair/restore the reported file from backup.

---

<a id="botlock-refuses-startup"></a>

### `bot.lock` Refuses Startup

Instance locking uses Linux `/proc` with exact line format `BOT_LOCK_LINE_PATTERN` (`v2:<pid>:<starttime>:<boot_id>:<sha256(token)>`, reading `starttime` from field 22 of `/proc/<pid>/stat`) and fails closed:

- **Live conflict**: An owner is treated as live if and only if PID, `starttime`, and host `boot_id` all match. Stop the running instance first—sharing a data root across live processes is forbidden.
- **Stale lock after crash or reboot**: Locks left behind by `kill -9` or host reboots are recognized automatically and reclaimed on the next startup or shutdown.
- **Corrupt or legacy lock file**: Anything other than a single current-format line plus newline causes both lock acquisition and shutdown release to refuse without modifying the file. After **confirming zero bot processes are running**, delete `bot.lock` manually and start again.
- **Lock release error on shutdown**: Logs an error and exits non-zero; check `/proc` mount state, directory write permissions, and any leftover `.guard` file.
- **Candidate cleanup**: Orphan `.candidate.*` hard-link lock candidates and `.tmp` files from inactive owners are cleaned up automatically during startup.

> [!CAUTION]
> The token SHA-256 in `bot.lock` checks credential consistency for the single owner—it is not multi-tenant storage isolation. Running multiple bots on one host **requires a separate `COPY_NINJIA_DATA_ROOT` per bot**.

---

## Upgrades and Releases

1. **Pre-release gate**: On the source checkout, run the full validation pipeline (frozen lockfile, conventions, lint, typecheck, coverage, fault injection, and binary build):
   ```bash
   bun run release:check -- --version <tag>
   # Run security audits in networked environments
   bun run audit:release
   ```
2. **Git hygiene check**: Before any Git operation, inspect `git status --short`, revision diffs, and `git ls-files config .env g-auth.json`. Never overwrite live `config/` with `config_example/`.
3. **Isolated build checkout**: When systemd's `WorkingDirectory` points to the live checkout, build and test in a separate git worktree or clone using only `dev` and `master`. For in-place updates, **stop the systemd service and verify `inactive` first**, then create external backups before pulling or migrating.
4. **Offline migrations**: Execute any required cold migrations and config updates while stopped.
5. **Post-startup observation**: Start the service only after config and persistence validation succeed, then monitor at least two supervisor restart intervals (`ActiveState=active`, `SubState=running`, flat `NRestarts`, zero non-zero journal exits) before removing external backups.

### Installer Service and Backup Boundaries

`install.sh` enforces strict operational guards:
- **Stopped-service requirement**: Refuses to write if an existing systemd unit is active or declares multiple conflicting `ExecStart` directives.
- **External SHA-256 backups**: Backs up existing configs and unit files outside the working tree with recorded ownership, modes, and verified SHA-256 hashes. Backups are removed only after post-start health observation passes; failed checks or foreground runs leave backups and staging state intact.
- **Data-root environment parity**: Unset `COPY_NINJIA_DATA_ROOT` resolves to the project root; when explicitly set, the installer environment and existing unit `Environment=` must resolve to the exact same path. Non-empty `EnvironmentFiles` or `PassEnvironment` / `UnsetEnvironment` rules touching `COPY_NINJIA_DATA_ROOT` are rejected.
- **Health observation window**: Computes `service_observation_seconds` (`scripts/install/service.sh`) from `RestartUSec`, `RestartMaxDelayUSec`, and `RestartRandomizedDelayUSec` (two effective restart intervals plus 2s) and fails the install if `NRestarts` increments, the unit leaves running state, journal reads fail, or non-zero exits appear.

---

## Routine Observability

### Key Log Characteristics and Troubleshooting

- **Structured English logs**: Batched asynchronously into `logs/` by the Disk I/O Worker for straightforward `grep` and log-shipper filtering.
- **Worker crash self-healing**: Unexpected Worker exits trigger rate-limited respawn and automatic snapshot re-hydration from the main thread.
- **Fail-fast storage exits**: Persistent disk write failures that exhaust bounded retries exit non-zero so systemd restarts cleanly from durable state rather than running with diverged memory.

#### Common Log Patterns

- `Cron task "<name>" action #<n> (<type>) failed after <k> attempt(s)`:
  Scheduled action exhausted retries:
  - `403`: Bot was kicked or lacks access in the target chat/channel.
  - `400`: Invalid remote media URL or unsupported image/audio format.
  - `local file ... is missing`: Configured local file path does not exist.
  - `speech synthesis failed: ...`: TTS failure (`tts unconfigured` / `tts unsupported` = config mismatch; `worker unavailable` = AI Worker still starting; `synthesis failed` / `timed out` = upstream provider/network failure; `daily limit reached` = daily quota exhausted).
- `/send TTS for chat <id> produced no voice: <reason>`:
  Superadmin private `/send` voice synthesis failed for the reasons above; the error is reported in DM and the relay session stays open.
- `AI reply voice was not sent (chat <id>): <reason>`:
  `send_voice` failed during a group AI turn (timeout, quota exhaustion, etc.); text replies in the turn still deliver normally.
- `Failed to probe chat membership ... PARTICIPANT_ID_INVALID`:
  Blocklist sweep hit a deleted Telegram account; after `BLOCKLIST_PARTICIPANT_INVALID_LIMIT` consecutive `PARTICIPANT_ID_INVALID` responses, the ID is automatically removed from the blocklist.
- `Chat <id> was upgraded to supergroup <newId>; tearing down the old chat.`:
  A managed basic group upgraded to a supergroup; the old chat ID was torn down as `gone` (state purged, slot freed). Run `/init enable` in the new supergroup.
- `Chat <id> was gone|departed in <n> lookups <ms>ms apart; tearing it down.`:
  Startup title refresh confirmed across repeated lookups that a chat no longer exists (`gone`) or the bot left (`departed`), tearing it down (unrestored private-lockdown state on a `departed` chat is retained and restored once the bot rejoins with member-restriction rights).
- `Chat <id> looked gone|departed at startup but lookup <n> disagreed; keeping it.`:
  Initial startup lookup failed transiently while a follow-up check disagreed; teardown is skipped and re-evaluated on the next boot.
- `Gemini context cache API ... create rejected (<n>/<max>): 400`:
  Gemini rejected context-cache creation with HTTP 400 (typically below minimum token count or unsupported parameters). Retries back off for `GEMINI_CONTEXT_CACHE_REJECTION_RETRY_AFTER_MS` and stop for that payload after `GEMINI_CONTEXT_CACHE_MAX_REJECTIONS` rejections while uncached chat calls continue uninterrupted.

---

<div align="center">

[← Prev: 06 Recipes](06-modification-guide.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#07-operations-and-troubleshooting) · [Next: 08 Images and Scheduled Tasks →](08-images-and-cron.md)

</div>
