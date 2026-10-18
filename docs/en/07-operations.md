# 07 Operations and Troubleshooting

<p align="center">
  <a href="../cn/07-operations.md">简体中文</a> · <b>English</b> · <a href="../ja/07-operations.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="06-modification-guide.md">← Prev: 06 Recipes</a> · <a href="08-images-and-cron.md">Next: 08 Images and Scheduled Tasks →</a>
</p>

---

## Deployment Model

Copy Ninjia uses a **single-instance long-polling** daemon architecture:
- No inbound webhooks or reverse proxy ports required;
- No external database services (such as MySQL or PostgreSQL) needed;
- Permission policies and active chat states are stored locally in SQLite;
- All other state is persisted as JSON or text files directly under the local data root.

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
    <td>Runs reliably for text. CPU contention between Workers may occur during peak multimodal loads; 2 GB swap is strongly recommended.</td>
  </tr>
  <tr>
    <td><nobr>⚡ <b>Light Production</b></nobr><br><sub>(Few groups with AI)</sub></td>
    <td>4 vCPU / 2 GB RAM / Local SSD</td>
    <td>Solid for text handling. 2 GB RAM is tight during rich-media bursts; configure 2 GB swap.</td>
  </tr>
  <tr>
    <td><nobr>🌟 <b>Recommended Production</b></nobr><br><sub>(Moderately active groups)</sub></td>
    <td>4 vCPU / 4 GB RAM / Local SSD</td>
    <td>Standard scale for groups with moderate daily message traffic, balancing stability and hardware costs (2 GB swap recommended).</td>
  </tr>
  <tr>
    <td><nobr>🔥 <b>High-Load Production</b></nobr><br><sub>(All groups AI / heavy images)</sub></td>
    <td>4 vCPU / 8 GB RAM / Local SSD</td>
    <td>Provides ample memory headroom for concurrent media downloads, Base64 transcoding, and image encoding.</td>
  </tr>
</tbody>
</table>

> [!NOTE]
> A single instance can manage up to `STATE_MANAGED_CHAT_LIMIT` chats simultaneously. Real bottlenecks arise from Telegram Bot API rate limits, model vendor quotas, and message throughput, not raw group member counts.

---

### systemd Example

We recommend managing the daemon with systemd:

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

- **Pre-creating the data root**: When provisioning, create the dedicated user and data root first:
  ```bash
  sudo install -d -o copy-ninjia -g copy-ninjia -m 0750 /var/lib/copy-ninjia
  ```
  In containerized environments, mount this directory as a persistent volume, ensuring ownership is configured by the host or an init container. Never store `memory/` or `database/` in ephemeral container layers.
- **Automatic initialization and strict write protection**: At startup, the bot creates the data root, the subdirectories listed in `RUNTIME_SENSITIVE_DIRECTORY_NAMES` (`logs/`, `memory/`, `memory/global/`, with maximum mode `RUNTIME_DATA_ROOT_MAX_MODE` in `packages/consts/paths.ts`), and the initial `database/` (`IDENTITY_DATABASE_DIRECTORY_MODE` in `packages/consts/identityStorage.ts`), subject to process umask. None of these paths may be **symbolic links**.
  - The data root and `RUNTIME_SENSITIVE_DIRECTORY_NAMES` must be owned by the runtime UID and cannot be more permissive than `RUNTIME_DATA_ROOT_MAX_MODE`. If write permissions (`w`) are granted to group or other, the application **refuses to start**.

> [!WARNING]
> **Data Isolation in Multi-Tenant Environments**:
> Newly created files under `memory/` use `PERSISTED_FILE_MODE` (`packages/consts/diskIO/common.ts`). If parent directories allow world read/execute (`RUNTIME_DATA_ROOT_MAX_MODE`), other local users on the server can read chat logs. On shared multi-user servers, restrict `other` permissions on the data root and `memory/`, and restrict existing files to owner-only or owner/group read access (the runtime preserves existing file permissions without overwriting them).
> Configure `database/` with `IDENTITY_DATABASE_DIRECTORY_MODE` (optionally with the setgid bit for shared service groups); the main database file and its WAL/SHM sidecars are created with `IDENTITY_DATABASE_FILE_MODE`. **Never strip group write permissions recursively across the entire data root**, because `database/` requires group write access when shared by a service group. Keep `config/` strictly read-only.

- **Automated crash recovery**: If the bot crashes or exits unexpectedly, systemd restarts it automatically (`Restart=on-failure`). Pending verification state, lockdown timers, pending database writes, AI memory, and unacknowledged Telegram updates resume cleanly according to [04 Runtime Invariants](04-invariants.md#persistence).

---

### Binary Deployment

Precompiled binary releases contain the `copy-ninjia` executable, `binary.json`, `package.json`, the installer script, cold-migration scripts, configuration and prompt templates, and schema migration SQL files. No `node_modules/` directory is needed because all runtime dependencies are bundled into the binary.
- **Initial configuration**: Run `bash install.sh` inside the unpacked release directory to generate configurations and initialize an empty database via interactive prompts. Run `./copy-ninjia` directly for interactive foreground testing.
- **systemd configuration**: Point `WorkingDirectory` to the release directory, and set `ExecStart` directly to the absolute path of the binary (without passing `start`). The target host does not even need Bun installed.
- **Upgrades**: The automated installer downloads the Latest release archive and checksums into a fresh directory; it does not overwrite live production directories in place. Upgrades require stopping the service, creating external backups, validating checksums, and performing offline migrations: verify the new archive in a temporary directory, preserve existing configs and data roots, and swap the program files. Any leftover `node_modules/` directory in the deployment folder is safely ignored and can be deleted while the service is stopped.
- **Offline cold migrations**: Migration scripts are located under `scripts/migrations/`. Inspect options by running `BUN_BE_BUN=1 ./copy-ninjia scripts/migrations/<script>.js --help`. The application entry point only accepts the current data format and does not perform live schema migrations.
- For packaging details, see [05 Dev Workflow](05-dev-workflow.md#release).

---

<a id="data-root"></a>

## Data Root

All runtime data paths are derived from `COPY_NINJIA_DATA_ROOT` (defaults to the project root when unset; passing an empty string or whitespace causes startup rejection):

### Calendar time zone

Configure the system time zone in `config/static/bot.json` via `time_zone` (defaults to `DEFAULT_BOT_TIME_ZONE` in `packages/consts/bot.ts`). This value is loaded once at startup and is not refreshed dynamically. Scheduled tasks in `cron.json` can specify an independent `time_zone` to override the global setting.

**Permanent time zone binding**: When the database is first initialized, `IDENTITY_DATABASE_TIME_ZONE_KEY` (`"time-zone"`) is persisted in the `storage_metadata` table inside `database/storage.sqlite`. From that point on, daily log cuts, fortune receipt signatures, temporary ad bypass allowances, and join-log retention periods are computed strictly within this bound time zone.
If the `time_zone` in `bot.json` does not match the database marker at startup, the process terminates immediately, logging both `storage_metadata.time-zone` and the expected value. The installer runs this exact check before registering system services. Changing time zones on existing data roots is unsupported; restore `time_zone` to match the stored database marker to resume. Back up and restore `database/` and `memory/` together as an inseparable snapshot.

### 1. Global State: `memory/global/state.json`
- **Responsibilities**: Stores the global repeat configuration `copy` (target user, mode, origin chat, and cooldown timer) and speech synthesis quota window `ttsUsage` (window start timestamp `windowStartedAt`, generated count `agentCount`, and reserved relay count `reserveCount`).
- **Schema requirements**: Top-level keys must contain only the required `copy` object and an optional `ttsUsage` object. `copy.copiedUser` is mandatory (`null` when no user is targeted); `copy.copyMode` accepts omitted, `reverse`, or `nya`. When `ttsUsage` is present, `windowStartedAt`, `agentCount`, and `reserveCount` must all be non-negative integers, with at least one greater than 0. Missing files are treated as fresh deployments; malformed files or undeclared keys cause **immediate startup rejection**. The installer validates this file with equal strictness.
- **Write pattern**: The main thread writes this file exclusively (writing to a temporary file + `fsync` + atomic `rename`). The Disk I/O Worker never accesses this directory. Modifications to `copy` flush to disk immediately; `ttsUsage` changes are coalesced and flushed in the background after `STATE_BACKGROUND_SAVE_DELAY_MS`. Clean shutdowns commit all pending writes; abrupt termination (`kill -9` or power failure) may lose uncoalesced quota increments.
- **Manual editing**: Always stop the service and ensure the process has exited before making manual adjustments. Make an external backup via `mktemp -d` before editing. Never delete unrecognized fields, and verify JSON syntax against schema requirements before restarting.
- **Root-level legacy check**: If legacy files like `state.json` or `state.json.bak` linger in the root of the data directory, the service and installer will refuse to start. Follow the [staged upgrade](#staged-upgrade) guide to reach version 17.2.1 and complete its migrations, then move these files out of the root.

### 2. Dedicated Image Library: `random_h_image_dir`
- **Responsibilities**: Configured by `onlyPath.random_h_image_dir` in `config/dynamic/assets.json` (defaults to `RANDOM_H_IMAGE_DIR` in `packages/consts/paths.ts`, resolved relative to the data root). The `/h_image` command and scheduled image tasks select images uniformly at random from this directory. Administrators can upload new files using `/h_image add`.
- **Naming requirements**: Every image filename must match `RANDOM_IMAGE_CONTENT_NAME_PATTERN` (the lowercase hex SHA-256 digest of its binary contents with an extension from `RANDOM_IMAGE_EXTENSIONS` in `packages/consts/randomImage.ts`). Non-image files, folders, or documentation files are strictly forbidden.
- **Startup preflight**: A missing directory is created automatically. At boot, the system scans the directory; invalid filenames, subdirectories, symlinks, or stray `RANDOM_IMAGE_TEMP_PREFIX` (`.h_image-add-*`) temporary files cause **startup failure**. Adding or removing valid images does not require a service restart; updating the directory path dynamically at runtime pre-validates the new target directory before switching.

### 3. Group Marriage Candidates: `memory/wed/<chatId>.json`
- **Responsibilities**: One sliding window of speaking members per chat, stored as an array of objects in entry order (e.g. `[{"id":5974478892,"enteredAt":1791770134683}]`), where `enteredAt` is the Unix millisecond timestamp at which the member entered the window. The main thread keeps a reusable `Map<number, number>` (member ID → entry time) for each group. The system manages up to `STATE_MANAGED_CHAT_LIMIT` chats, with a window capacity of `WED_MEMBER_LIMIT` per chat.
- **Window rules**: When a member outside the window speaks as a personal account, they are appended with the current time (never earlier than the largest entry time already recorded). Members already in the window keep their entry time when they speak again. When the window is full, the member with the earliest entry time is evicted first.
- **Validation rules**: The filename must be a canonical negative safe-integer chat ID. Each entry must contain exactly `id` and `enteredAt`; `id` must be a unique positive safe integer, `enteredAt` a non-negative safe integer that never decreases along the array, and the array may hold at most `WED_MEMBER_LIMIT` entries. Any violation fails startup checks, and the installer applies the same checks. Legacy files that are still arrays of member IDs must first go through the [/wed member window cold migration](#upgrade-wed-member-window).
- **Persistence flow**: Once `FLUSH_MAX_ENTRIES` additions, deletions, or evictions accumulate or `FLUSH_INTERVAL_MS` passes since the first change, the main thread dispatches an atomic replacement job to the Disk I/O Worker. Running `/init disable` or removing the bot from a chat deletes the corresponding file permanently.
- **Pruning departures**: Departed users are pruned via service messages, `chat_member` updates, and midnight sweeps (the latter two require bot administrator rights). In large supergroups where member lists are hidden and the bot lacks administrator privileges, departure events may not be received, meaning former members can remain in the pool; this is expected under Telegram API limitations.

### 4. Stickers and Fortunes: `memory/stickers/` and `memory/luck/`
- **`memory/stickers/<pack>.json`**: Metadata cache for whitelisted sticker packs (including the schema `version` field), mapping `file_unique_id` to emojis, prompts, and pack digests. Missing entries can be reconciled from Telegram on demand; packs removed from configuration are pruned on startup.
- **`memory/luck/<YYYY-MM-DD>.json`**: Daily fortune draw results in the bound time zone, keyed by user ID and containing fortune grades and query digests. Kept for the current day only.
- **`memory/luck/receipt-secret.json`**: HMAC secret key used to verify the authenticity of fortune receipts (including the schema `version` field, the active date, and a hex key matching `LUCK_RECEIPT_SECRET_PATTERN`). **This file must be backed up and restored alongside daily fortune files**; deleting or regenerating it independently invalidates all outstanding receipts.

### 5. Pending Verification and Join Logs: `memory/anti-raid/` and `memory/joinlog/`
- **`memory/anti-raid/<YYYY-MM-DD>.json`**: Append-only log of join-verification Challenges, tracking active challenges, revisions, solved tombstones, and unconfirmed `kickPending` eviction tasks (evictions resume automatically across reboots). Steady-state operation retains only the current local day, compacting when append counts or file size hit `VERIFICATION_FILE_COMPACT_ENTRIES` or `VERIFICATION_FILE_COMPACT_BYTES`. If an earlier day file is still in the directory during compaction, tombstones are written for records that are active in the most recent such file but already settled, so a process exit before the old file is deleted cannot revive settled records on recovery. If the same most recent earlier day file fails to decode (invalid UTF-8 or not the current format) `VERIFICATION_PRIOR_DAY_DECODE_MAX_ATTEMPTS` times in a row, the running compaction renames it with `VERIFICATION_CORRUPT_DAY_FILE_SUFFIX` (`<YYYY-MM-DD>.json.corrupt`) and keeps it untouched for manual inspection, and the new day is written straight from the in-memory mirror; the renamed file no longer ends in `.json`, so startup recovery and old-day cleanup neither read nor delete it. A corrupt most recent earlier day file at startup still refuses startup.
- **`memory/joinlog/<chatId>.<YYYY-MM-DD>.json`**: Accurate record of `chat_member` join events, queried by `/batch_kick` across a sliding time window.
  - **Persistence**: Events are buffered in Disk I/O Worker memory, batch-appended to disk with `fsync` when `FLUSH_MAX_ENTRIES` events accumulate or `FLUSH_INTERVAL_MS` elapses. Unwritten logs are flushed before executing `/batch_kick` queries and during graceful shutdowns.
  - **Retention lifecycle**: Retains the last `JOIN_LOG_FILE_RETENTION_DAYS` days in the configured time zone, ensuring full multi-day query coverage (automatically extended during daylight saving transitions). Stores up to `JOIN_LOG_MAX_USERS_PER_CHAT_DAY` newest members per chat per day. Logs are purged when `/init disable` is run or when the bot leaves the chat.

### 6. Core Identity and Chat State: `database/storage.sqlite`
Accompanied at runtime by SQLite temporary WAL (`-wal`) and shared memory (`-shm`) sidecars:
- **Stored entities**: Primary SQLite database adhering to the current schema (`IDENTITY_DATABASE_SCHEMA_VERSION`):
  - `storage_metadata`: Metadata table storing the keys in `IDENTITY_DATABASE_METADATA_KEYS` (`IDENTITY_DATABASE_SCHEMA_KEY` and `IDENTITY_DATABASE_TIME_ZONE_KEY`).
  - `permission_list.policy`: Persistent user permission policies encoded as JSONB.
  - `blocklist_entries`: Authoritative global blocklist.
  - `temporary_ad_bypass_entries`: Tracking records for temporary ad detection bypass credits.
  - `pending_blocked_removals`: Queue of pending cross-group member eviction jobs.
  - `chat_qa`: Group custom Q&A library, keyed by composite primary key `(chat_id, q)`.
  - `chat_states`: Chat operational state table (up to `STATE_MANAGED_CHAT_LIMIT` rows). Contains required JSONB state (`status`, holding translation sessions `translate` capped at `TRANSLATE_CHAT_USER_LIMIT`) and optional `ai_context` (nullable JSONB snapshots of verbatim memory and summaries).
- **Concurrency and transactions**: The Disk I/O Worker holds an exclusive read-write connection to the database. Startup strictly verifies database integrity, JSONB validity, schema versions, migration lineage, and constraint conflicts. Group state and AI snapshots hydrate from this connection.
- **Shutdown close**: on a clean shutdown the Disk I/O Worker commits remaining writes, checkpoints the WAL back into the main database, truncates it, and closes the connection, so normally only `storage.sqlite` is left in `database/` after the service stops. If the process is killed, or the checkpoint is blocked by another reader (such as an externally opened SQLite editor), the `-wal` and `-shm` files stay in the directory. If the close cannot confirm that remaining writes were committed, the shutdown ends as `unsettled` with a non-zero exit, and the journal carries the matching `[diskIO]` error.
- **Backup protocol**: Contains critical security and state data. **Always back up and restore the main database alongside its contemporaneous `-wal` and `-shm` sidecars (when present) as a single indivisible unit**. Never copy the `.sqlite` file in isolation.

### 7. Ad Samples and AI Usage: `memory/ad-detected/` and `memory/ai-daily-usage/`
- **`memory/ad-detected/sample.json`**: Captured raw messages triggered by the ad detection engine (including timestamp, original text, verdict reasons, and quoted context). Used purely for auditing; automatically rolls over to `sample.<date>[.<seq>].json` upon reaching `AD_SAMPLE_FILE_MAX_BYTES`. Archives are retained for `AD_SAMPLE_ARCHIVE_RETENTION_DAYS`.
- **`memory/ai-daily-usage/usage.json`**: Model token and request counts (contains zero conversation text).
  - **Data structure**: The root `summary` object tracks usage for the most recent completed calendar day (aggregated by capability, provider, and model name); all other keys represent individual unsummarized daily calls.
  - **Capability coverage**: Tracks all capabilities listed in `AGENT_CAPABILITY_NAMES`.

### 8. Logs and Instance Lock: `logs/` and `bot.lock`
- **`logs/`**: English structured error log files written asynchronously in batches by the Disk I/O Worker.
- **`bot.lock`** (along with `.guard` / `.recovery`): Linux `/proc`-based single-instance mutex lock ensuring only one live process binds to a data root.

---

### Data Root Management and Maintenance Scheduling

- **Physical directory isolation**: The root of `memory/` contains no loose files; each domain owns an isolated subdirectory. Permissions and group state reside in `database/`.
- **Read-only preflight checks**: The bot starts by scanning and strictly decoding all persistent files in read-only mode (including every file in the `joinlog/` retention window). Memory ownership is handed to functional modules only after all checks pass. The process then creates missing directories, clears orphan temporary files, and registers daily midnight cleanup jobs in the configured `time_zone`.
- **Midnight maintenance cron**: On the daily midnight schedule (`DISK_IO_MAINTENANCE_CRON` in `packages/consts/diskIO/maintenance.ts`) in the configured time zone, the bot runs scheduled maintenance tasks in order: `/wed` membership validation, fortune rotation, log rotation, AI token usage aggregation, join-log expiration, ad sample rotation, Challenge log compaction, and ad bypass quota decay. Failures in one task do not disrupt subsequent tasks.
- **Temporary files and memory state**:
  - Temporary files created during atomic writes (`.<target>.<pid>.<uuid>.tmp`) are cleaned up automatically in normal operation. Abrupt termination may leave them on disk; startup checks log them and defer safe removal to post-startup maintenance routines.
  - `storage.sqlite-wal` and `storage.sqlite-shm` are vital runtime files in SQLite WAL mode—**never delete them as temporary files**.
  - Challenge timers, ad detection queues, and transient Telegram caches exist solely in memory and do not persist to disk across reboots.

---

<a id="identity-storage-migration"></a>

## Persistent Data Migration

**The codebase contains zero legacy compatibility layers and never alters database schemas automatically at startup**. Schema migrations require stopping the bot and confirming that processes have exited. If a migration fails, keep external backups intact; never launch the new version prematurely, and never overwrite real configurations with `config_example/`.

Before performing offline migrations, create an external backup via `mktemp -d` outside the repository tree. Back up all affected files, recording ownership, permissions, and SHA-256 hashes. Verify source and destination hashes inside `ready.json`. Ensure migrated data passes the new version's strict startup checks. Swap the files, restore correct ownership and permissions, and observe the service over at least two supervisor restart cycles (`active/running`, unchanged `NRestarts`, no journal errors) before purging external backups.

### Fresh Deployment Database Initialization

When booting with a missing database, the bot halts with an error instead of guessing default configurations. Fresh deployments must initialize an empty database using the [identity storage initialization steps in 01 Getting Started](01-getting-started.md#initializing-identity-storage). The `install.sh` script executes this automatically if no database is found. The script safely refuses to overwrite existing databases.

<a id="upgrade-wed-member-window"></a>

### /wed Member Window Cold Migration (Member ID Arrays → `{ id, enteredAt }`)

Run the migration script at [`scripts/migrateWedMemberWindow.ts`](../../scripts/migrateWedMemberWindow.ts). This script rewrites `memory/wed/<chatId>.json` from the 17.2.1 member ID arrays into `{ id, enteredAt }` window arrays in entry order. Each chat keeps only the last (most recently entered) `WED_MEMBER_LIMIT` IDs in their original order, and every `enteredAt` is set to the migration start time; the overflow is dropped from the earliest end and counted as `truncatedMembers` in `ready.json`. The script only accepts 17.2.1 member files (at most `WED_MEMBER_WINDOW_SOURCE_LIMIT` unique positive safe-integer IDs per file, and no more than `STATE_MANAGED_CHAT_LIMIT` chat files); already migrated files, non-canonical filenames, and symbolic links are rejected, while non-`.json` leftovers such as `*.tmp` are not migrated. All other persistent files and JSON configs from 17.2.1 remain unchanged.

1. **Stop service and back up**: Stop the service and confirm it is inactive. Back up the entire `memory/wed/` directory with its ownership, permissions, and SHA-256 manifest to an external directory, keeping the `memory/wed/` relative path under the backup root.
2. **Execute the migration script**:
   ```bash
   bun run migrate:wed-member-window \
     --source-root /absolute/cold-backup \
     --output-root /absolute/new-staging-directory
   ```
   Binary releases run `BUN_BE_BUN=1 ./copy-ninjia scripts/migrations/migrateWedMemberWindow.js` with the same arguments.
3. **Verify migration output**: Inspect `ready.json` in the output directory, verifying the SHA-256 hashes in `sourceFiles` and `outputFiles` and confirming `chatCount`, `keptMembers`, `truncatedMembers`, and `enteredAt`. Output files are readable and writable only by the current account.
4. **Replace the member files**: While the service is stopped, replace each deployed `memory/wed/<chatId>.json` with the migrated file, restore the original ownership and permissions from `sourceFiles`, and make sure the service account can write `memory/wed/` and its files.
5. **Verify startup**: Start the bot and verify operation. Clean up temporary backups only after confirming stable execution.

---

<a id="staged-upgrade"></a>

### Staged Upgrades from Older Layouts

- **Deployments older than 17.2.1**: This release provides direct migration scripts exclusively for version 17.2.1. If running an earlier version, you must first upgrade to 17.2.1 and complete its migrations (16.3.2 runs the shared database cold migration `migrate:chat-persona-removal`; older versions first follow their own guides up to 16.3.2), verify that 17.2.1 boots stably, and then proceed with this release's [/wed member window cold migration](#upgrade-wed-member-window).
- **Major version path from 11.0.9 (Schema v8)**:
  Run sequential cold migrations across isolated directories using tagged releases:
  1. Commit `500e848fae`: Run `migrate:ai-context` (v8 → v9)
  2. Tag `12.1.0`: Run `migrate:clear-context-permission` (v9 → v10)
  3. Tag `13.0.2`: Run `migrate:h-image-add-permission` (v10 → v11) and `migrate:bot-config`
  4. Tag `14.0.0`: Run `migrate:translate-sessions`
  5. Tag `16.3.2`: Run `migrate:global-state` and `migrate:random-image-names`
  6. Tag `17.2.1`: Run `migrate:chat-persona-removal` (v11 → v13)
  7. Latest version: Run `migrate:wed-member-window`

  *Tip*: You can also use the intermediate source archive `copy-ninjia-schema-v9-source-500e848f.tar.gz` attached to the 12.0.0 Release (SHA-256: `df6502625512d8fde136dc66d8470e1d4c977856e8a0bd3909b9b6c763c820f8`).

---

<a id="startup-failures"></a>

## Startup Failures

The application deliberately follows a **Fail-Fast** design. Any configuration or data inconsistency halts startup immediately, outputting the exact cause and field path. Fix the identified issue rather than trying to bypass checks:

### 1. Data-Root Preflight Failure
- **Cause**: The data root, `memory/`, `memory/global/`, `logs/`, or `database/` contains symbolic links; directories are not owned by the runtime UID or have permissions broader than `RUNTIME_DATA_ROOT_MAX_MODE` (write bits for group/other); `database/` is broader than `IDENTITY_DATABASE_DIRECTORY_MODE` or lacks group write permissions when accessed by a shared service group; or the underlying filesystem lacks support for `fsync`, hard links, or atomic renames.
- **Solution**: Stop the service and fix directory ownership and permissions so the data root and `RUNTIME_SENSITIVE_DIRECTORY_NAMES` are owned by the runtime UID with mode at most `RUNTIME_DATA_ROOT_MAX_MODE` (no group/other write bits), and `database/` uses `IDENTITY_DATABASE_DIRECTORY_MODE` (optionally with setgid). Ensure the data root resides on a standard local POSIX filesystem.

### 2. `bot.lock` Refuses Startup
- **Cause**: An active process bound to the same data root was detected (even with a different token), or the lock file is corrupt or formatted for an older version.
- **Solution**: Follow troubleshooting steps in [`bot.lock` Refuses Startup](#botlock-refuses-startup).

### 3. Configuration Directory Layout Mismatch
- **Cause**: Configuration files are located flat in the root of `config/` instead of subdirectories; an outdated `telegram.json` sits in `config/`; or `config/dynamic/` is missing.
- **Solution**: Stop the service. Move `bot.json` and `g-auth.json` into `config/static/`, and place dynamic configurations into `config/dynamic/`. If a legacy `telegram.json` exists, complete the [staged upgrade](#staged-upgrade) using `migrate:bot-config`.

### 4. Config Schema Validation Failure
- **Cause**: Content in `config/{static,dynamic}/*.json` violates the schema (missing required fields, incorrect types, invalid enums, or undeclared keys).
- **Solution**: Check the console log for the exact JSON error path and adjust the configuration. Detailed requirements are documented in the [deployment configuration guide](../../config_example/README/en.md).

### 5. Identity Database Validation Failure
- **Cause**: `storage.sqlite` is unwritable; the database file is corrupt; the database schema is outdated; the `time_zone` setting conflicts with the zone recorded in the database (the log states `storage_metadata.time-zone` and the expected value); or user IDs overlap between the blocklist and ad bypass whitelist.
- **Solution**: For time zone mismatches, restore `time_zone` in `bot.json` to the database value. If the database is not on the current schema (for example a Schema v11 database from 16.3.2), follow the [staged upgrade](#staged-upgrade) to 17.2.1 and complete its migrations first. If the file is corrupt, restore the database and its matching `-wal`/`-shm` files from backup. Never overwrite with a blank database or edit SQLite tables manually.

### 6. Inconsistent Fortune Results and Receipt Key
- **Cause**: The current day's fortune files and `receipt-secret.json` originate from different backup points, causing cryptographic signature verification to fail.
- **Solution**: Stop the service and restore the entire `memory/luck/` directory from a single consistent backup. Never delete or regenerate the secret key in isolation.

### 7. Invalid Global State File or Residual Legacy state.json
- **Cause**: `memory/global/state.json` fails current schema parsing, or legacy `state.json` files linger in the data root.
- **Solution**: Back up the file, identify the issue, and correct invalid fields. For legacy formats, follow the [staged upgrade](#staged-upgrade) to 17.2.1 and complete its migrations, then remove lingering files from the data root.

### 8. Invalid /wed Candidate Files
- **Cause**: `memory/wed/<chatId>.json` does not match the current window format (for example it is still a 17.2.1 member ID array, lacks `enteredAt`, has decreasing entry times, or exceeds `WED_MEMBER_LIMIT` entries), or the filename is not a canonical chat ID.
- **Solution**: After a stopped backup, run the [/wed member window cold migration](#upgrade-wed-member-window) for legacy member ID arrays; otherwise fix the file and field path named in the error, or restore from backup.

---

<a id="botlock-refuses-startup"></a>

### `bot.lock` Refuses Startup

The system uses a Linux `/proc`-based instance lock matching `BOT_LOCK_LINE_PATTERN` (`v2:<pid>:<starttime>:<boot_id>:<sha256(token)>`, where `starttime` is read from `/proc/<pid>/stat`). The lock fails closed to guarantee data integrity:

- **Active process conflict**: A process is deemed active if and only if its PID, starttime, and system boot ID all match. This indicates another instance is already running; stop the old instance first. Running multiple instances against the same data root is strictly prohibited.
- **Stale locks from abnormal exits**: If an instance was terminated abruptly (`kill -9`) or the host rebooted, stale locks are detected and cleared automatically on the next startup or clean shutdown without manual intervention.
- **Corrupt or legacy lock files**: The lock file must contain a single owner record in the current format followed by a newline; multiple lines, a mismatched format, or extra content make both acquisition and shutdown release refuse and leave the file untouched. The bot will not guess lock contents or attempt automatic upgrades. Once you have **verified that no related process is running**, manually delete the invalid lock file and restart.
- **Failure to release lock on shutdown**: If the lock cannot be released during clean shutdown, the process logs an error and exits with a non-zero code. Check `/proc` mount options, directory write permissions, and leftover `.guard` files.
- **Temporary file cleanup**: Temporary candidates (`.candidate.*`) and `.tmp` files generated during atomic hard-link locking are reclaimed automatically at startup once the previous owner is confirmed inactive.

> [!CAUTION]
> The token hash inside the lock file only validates credential ownership; it does not provide multi-tenant data isolation. Running multiple distinct bots **requires configuring an independent `COPY_NINJIA_DATA_ROOT` for each bot**.

---

## Upgrades and Releases

1. **Full pre-release validation**: Run the comprehensive release validation suite on the source tree (frozen lockfile, conventions, type checks, test coverage, fault injection, and binary compilation):
   ```bash
   bun run release:check -- --version <tag>
   # Run security audits in networked environments
   bun run audit:release
   ```
2. **Git status verification**: Before running Git commands, check `git status --short`, diffs against target revisions, and protected files via `git ls-files config .env g-auth.json`. Never overwrite deployment files with repository templates.
3. **Work in an isolated working directory**: If systemd's `WorkingDirectory` points directly to the repository, perform builds and tests in an isolated git worktree or fresh clone, strictly sticking to `dev` and `master`. If upgrading in place, **stop the systemd service and confirm it is inactive**, back up deployment files and databases externally, and then pull and migrate.
4. **Handle persistence changes**: If the update includes data format changes, execute the prescribed offline cold migrations.
5. **Post-release observation**: Start the service only after verifying all configuration and state files. Monitor the instance across at least two supervisor restart cycles to confirm `ActiveState=active`, `SubState=running`, no growth in `NRestarts` from its baseline, and no non-zero exit codes in the system journal. Purge external backups only after all verifications pass.

### Installer Service and Backup Boundaries

The `install.sh` installation script enforces several safeguards:
- **Service state verification**: The installer requires existing services to be `inactive` (or `dead`) before touching any files. If the service is running, or if the unit file defines conflicting `ExecStart` commands, the script halts immediately.
- **External backups**: Before replacing configuration or unit files, the installer creates an external backup outside the tree, verifying files against their SHA-256 hashes and logging ownership and permissions. Backups are cleaned up automatically only after service health checks pass; failed checks or foreground runs preserve backups and staging state completely.
- **Environment variable consistency**: An unset `COPY_NINJIA_DATA_ROOT` resolves to the repository root. If set explicitly, both the systemd unit `Environment` and the installer environment must resolve to the identical absolute path. Units declaring `EnvironmentFiles` or setting `PassEnvironment`/`UnsetEnvironment` for this variable are rejected.
- **Health monitoring window**: After startup, the installer monitors the service across the observation window computed by `service_observation_seconds` (`scripts/install/service.sh`) from systemd's `RestartUSec`, `RestartMaxDelayUSec`, and `RestartRandomizedDelayUSec` across two restart intervals plus a safety margin. If `NRestarts` grows, the process exits, logs become unreadable, or non-zero exits occur, the installer reports failure and offers rollback options.

---

## Routine Observability

### Key Log Characteristics and Troubleshooting

- **Unified structured logging**: Located in `logs/`, asynchronously appended in batches by the Disk I/O Worker. All logs are in English to facilitate grepping and log collector ingestion.
- **Worker thread self-healing**: If a Worker thread crashes, the main thread throttles restarts and spins up a replacement thread, re-initializing Worker state from memory snapshots.
- **Fail-fast persistence shutdowns**: If underlying disk writes fail repeatedly and exhaust bounded retries, the bot terminates with a non-zero exit code to trigger a clean supervisor restart, preventing in-memory state from diverging from disk.

#### Common Log Patterns

- `Cron task "<name>" action #<n> (<type>) failed after <k> attempt(s)`:
  A scheduled task reached terminal failure. Common causes:
  - `403`: The bot was removed from the target chat or channel.
  - `400`: The media URL is invalid, or the image/audio format is unsupported by Telegram.
  - `local file ... is missing`: The local media asset path does not exist.
  - `speech synthesis failed: ...`: Voice synthesis failed (`tts unconfigured` / `tts unsupported` indicate config mismatches; `worker unavailable` indicates the AI Worker is still initializing; `synthesis failed` / `timed out` indicate vendor API errors; `daily limit reached` means the current window quota is exhausted).
- `/send TTS for chat <id> produced no voice: <reason>`:
  Voice synthesis failed during superadmin private relay; causes match above. Superadmins receive error feedback directly in private chat, and the relay session remains open.
- `AI reply voice was not sent (chat <id>): <reason>`:
  The `send_voice` tool failed to generate audio during an AI reply (API timeout, quota limit, etc.). Text replies continue to be sent normally.
- `Failed to probe chat membership ... PARTICIPANT_ID_INVALID`:
  The blocklist sweep encountered a deleted Telegram account. When a user ID returns this error for `BLOCKLIST_PARTICIPANT_INVALID_LIMIT` consecutive checks, the system automatically purges the deleted ID from the blocklist.
- `Chat <id> was upgraded to supergroup <newId>; tearing down the old chat.`:
  A managed group was upgraded to a supergroup, and the old chat id has been torn down as "chat no longer exists" (data purged, managed-chat slot freed). Run `/init enable` again in the new supergroup; the old settings are not carried over.
- `Chat <id> was gone|departed in <n> lookups <ms>ms apart; tearing it down.`:
  At startup the title refresh confirmed several times in a row that a chat no longer exists (`gone`) or that the bot is no longer a member (`departed`), and tore it down. For a `departed` chat, a lockdown record that has not been restored yet is kept and restored automatically once the bot is back with the right to restrict members.
- `Chat <id> looked gone|departed at startup but lookup <n> disagreed; keeping it.`:
  The first lookup looked unreachable but a later one disagreed (usually a transient Telegram error). Nothing is torn down this time; the next startup confirms again from scratch.
- `Gemini context cache API ... create rejected (<n>/<max>): 400`:
  Gemini returned HTTP 400 when attempting to create a context cache. This usually means the context contains fewer tokens than the required minimum, or parameters are invalid. The system waits for `GEMINI_CONTEXT_CACHE_REJECTION_RETRY_AFTER_MS` before retrying; after `GEMINI_CONTEXT_CACHE_MAX_REJECTIONS` consecutive failures, caching is disabled for that content. Regular chat replies continue to function normally without caching.

---

<div align="center">

[← Prev: 06 Recipes](06-modification-guide.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#07-operations-and-troubleshooting) · [Next: 08 Images and Scheduled Tasks →](08-images-and-cron.md)

</div>
