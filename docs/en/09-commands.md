# 09 Command and Behavior Reference

<p align="center">
  <a href="../cn/09-commands.md">简体中文</a> · <b>English</b> · <a href="../ja/09-commands.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="08-images-and-cron.md">← Prev: 08 Images and Scheduled Tasks</a> · <a href="10-performance.md">Next: 10 Performance Benchmark →</a>
</p>

---

This page provides the complete command list, permission requirements, and execution behavior for end users. The root README contains only a brief overview; this document serves as the authoritative technical reference. Command implementations live in `packages/commands/`, and permission keys are defined in [`packages/types/identityPolicy.ts`](../../packages/types/identityPolicy.ts).

## 🎭 Copy Modes

The repeat target is **globally unique across the entire bot instance**: a single bot instance can only imitate one target at any given time, and repetitions only take place inside the group where the command was initiated.
Running `/copy stop` from any group immediately halts the active repeat state. When the originating group is disabled via `/init disable`, or if the bot is kicked or loses administrator permissions there, the repeat state terminates automatically, persists immediately to disk, and resets the bot avatar to its default in the background without posting in the group.

| Command | Behavior |
| :---: | :--- |
| `/copy` | Echoes the target's subsequent messages verbatim |
| `/copy reverse` | Reverses text and captions by Unicode grapheme clusters |
| `/copy nya` | Appends `NYA_SUFFIX` (`"喵~"`) to the end of text and captions |
| `/icon steal` | Copies the target's current avatar without echoing text |
| `/icon reset` | Restores the bot's configured default avatar |
| `/copy stop` | Stops active global repetition and restores the default avatar |

### Sending and Transformation Mechanics

The `/copy` command suite shares message transformation rules with the autonomous random echo engine:
- **Text and captions**: Processed as plain strings. Messages containing links or `@usernames` undergo identical transformations. Plain text is resent, while links and `@mentions` are re-parsed by Telegram clients, preserving the original link preview settings.
- **Entity styling stripped**: Rich formatting (bold, underline, inline URLs, spoilers, custom emojis) is discarded. Spoilers in the original message are emitted as cleartext.
- **Rich media**: Photos, videos, documents, and stickers are duplicated server-side by Telegram; captions are replaced with transformed text without downloading files locally. Paid media cannot be duplicated; only text captions are forwarded.
- **Pure non-text messages**: Polls, dice, locations, and contacts without text or files are forwarded verbatim.
- **Command loop prevention**: If text before or after transformation matches a renderable slash command, the entire message is dropped.
- **Length overflow protection**: If transformed text exceeds `TELEGRAM_MESSAGE_MAX_CHARS` or `TELEGRAM_CAPTION_MAX_CHARS`, the entire message is dropped.

### Target and Parameter Specification

Specify targets by replying to a user's message or by passing an explicit `@username`:
- **Syntax order**: Place the mode keyword before the target parameter, e.g. `/copy reverse @username` or `/copy nya @username`; use `/icon steal @username` to copy avatars only. `/copy stop` and `/icon reset` take no additional parameters.
- **Username cache dependency**: Looking up users via `@username` requires that the bot has previously observed them speaking in the group and cached their profile. If a user modifies, deletes, or reassigns their username, historical cache mappings expire immediately. For destructive operations like `/block … enable`, prefer replying to target messages or supplying numerical IDs directly. When `/block`, `/mute`, `/white`, or a `/permission` change targets `@username`, the bot re-checks the target's current username before acting and refuses if it has changed or cannot be verified.
- **Anonymous group administrators**: When an administrator speaks anonymously as the group, the message source represents the group itself. Copying that message targets the group, adopting its avatar and imitating the group identity; however, `/block` rejects blocking the current group identity.
- **Global cooldown**: `/copy`, `/copy reverse`, `/copy nya`, `/icon steal`, and `/icon reset` share a global cooldown (`COPY_COOLDOWN_MS`). Only the configured superadmin (`SUPER_ADMIN_USER_ID`) is exempt; regular whitelisted users must respect cooldowns. `/copy stop` is never subject to cooldowns.

---

## 🌐 Per-Group Translation

Per-group translation operates independently of global repeat modes, avatars, and repeat cooldowns. Before use, an administrator with `isCanControllTranslatePermission` must enable it via `/translate enable` (disabled by default), and the deployment must have a valid `g-auth.json` configured.
To translate another bot's messages, enable Bot-to-Bot Communication Mode for this bot in @BotFather; incoming messages remain protected by the [bot message rate limits](04-invariants.md) (see [01 Getting Started](01-getting-started.md)).
Translations are processed in background FIFO queues per group without blocking standard message throughput. If pending translation messages in a single group accumulate to `TRANSLATE_CHAT_BACKLOG_MAX`, new messages are dropped until the queue drains.

| Command | Behavior |
| :--- | :--- |
| `/translate ja` | Reply to a message to translate subsequent speech into Japanese |
| `/translate cn @username` | Target a known username to translate speech into Simplified Chinese |
| `/translate en` | Reply to a message to translate subsequent speech into American English |
| `/translate uk` | Reply to a message to translate subsequent speech into Ukrainian |
| `/translate ru` | Reply to a message to translate subsequent speech into Russian |
| `/translate list` | Outputs the supported target languages as a JSON code block |
| `/translate stop` | Stop all active translations in this group when invoked without arguments (keeps feature enabled) |
| `/translate stop @username` or `/translate stop 123456789` | Stop translation for a specific target; replies and negative channel IDs are supported |
| `/translate disable` | Clears all translation sessions in this group and turns off the feature (requires admin rights) |

### Session Capacity and Exclusion Rules

- **Session limits**: Regular group members can start or stop translation sessions. Each group supports up to `TRANSLATE_CHAT_USER_LIMIT` distinct identities translating simultaneously, each choosing their own target language. Total managed groups are constrained by `STATE_MANAGED_CHAT_LIMIT`. New requests exceeding capacity are rejected without evicting active sessions; stop an existing session before changing languages.
- **Parameter conflicts**: If a command replies to a message while also specifying a conflicting target argument, it is rejected rather than falling back to clearing the whole group.
- **Mutual exclusion with copy**: `/copy stop` does not affect active translation sessions. When a user is simultaneously designated as both a copy target and a translation target, **translation takes priority** (no verbatim echoes, no media duplication, no reaction emojis); copying other users continues normally.

Running `/translate list` returns the supported language dictionary (`TRANSLATE_LANGUAGE_LABELS`, sent as a Telegram `pre` entity with `TRANSLATE_LIST_JSON_LANGUAGE` syntax highlighting and auto-deleted after `COMMAND_MESSAGE_AUTO_DELETE_MS`):

```json
{
  "ja": "日语",
  "cn": "简体中文",
  "en": "美式英语",
  "uk": "乌克兰语",
  "ru": "俄语"
}
```

### Language Regex and Dispatch Rules

- **Pre-filtering checks**: Text and captions are evaluated as raw strings. If regular expressions determine that a message already belongs to the target language, or consists purely of digits, punctuation, or emojis, the external translation API is bypassed and no message is sent:
  - **Japanese**: Must contain kana (`TRANSLATE_JAPANESE_EVIDENCE` / `TRANSLATE_JAPANESE_TEXT`).
  - **Simplified Chinese**: Excludes traditional characters with simplified counterparts in Unicode Unihan (`TRANSLATE_CHINESE_EVIDENCE` / `TRANSLATE_CHINESE_TEXT`).
  - **English**: Accepts ASCII alphabet letters (`TRANSLATE_ENGLISH_EVIDENCE` / `TRANSLATE_ENGLISH_TEXT`). American English calls the [Google Translation LLM](https://docs.cloud.google.com/translate/docs/languages#translation-llm) (`TRANSLATE_REGIONAL_MODEL`) supporting `en-US`.
  - **Ukrainian**: Accepts Ukrainian-specific letters and apostrophes, excluding Russian `ёъыэ` (`TRANSLATE_UKRAINIAN_EVIDENCE` / `TRANSLATE_UKRAINIAN_TEXT`).
  - **Russian**: Accepts `Ё/ё`, excluding Ukrainian-specific `єіїґ` (`TRANSLATE_RUSSIAN_EVIDENCE` / `TRANSLATE_RUSSIAN_TEXT`).
  - *Note*: Shared CJK ideographs, unaccented Latin characters, and short Cyrillic phrases may carry ambiguities; regex pre-filtering does not perform semantic classification.
- **Delivery format**: Translation emits only the translated result—it never echoes the original message or forwards media files. If translation fails, or if the translated text matches the source verbatim, nothing is sent.
  - Translations are sent as plain text without rich formatting; if the original message contains URLs, link preview settings are preserved.
  - Captioned photos, videos, audio, documents, or paid media have only their captions translated and sent as text; the underlying media is not copied.
  - Non-text messages (stickers, media without captions, polls, locations) are not translated and do not fall back to copy mode.
  - Translations exceeding `TELEGRAM_MESSAGE_MAX_CHARS` are dropped. Output preserves original forum topic IDs and filters out renderable slash commands. Command receipts auto-delete after `COMMAND_MESSAGE_AUTO_DELETE_MS`.
- **Persistence and recovery**: Active sessions persist in the `translate` JSONB array within the group's `chat_states` SQLite row. Stopping one user cancels only their session, leaving in-flight tasks for others intact. Disabling translation or removing the bot from the group cleans up all sessions. Run `/bot_status` to inspect current translation counts and limits.

---

## 🎮 Commands and Permissions

| Command | Permission | Description |
| :--- | :---: | :--- |
| `/copy`<br>`/copy reverse`<br>`/copy nya` | Group member | Start corresponding text and caption repeat mode |
| `/copy stop` | Group member | Stop global repeat mode and reset the bot avatar |
| `/icon steal` | Group member | Copy target avatar only |
| `/icon reset` | Group member | Reset avatar to system default |
| `/translate ja\|cn\|en\|uk\|ru [@username]`<br>`/translate list`<br>`/translate stop [@username/id]` | Group member | Select target language, list languages, or stop all / specific translation sessions |
| `/translate enable\|disable` | `isCanControllTranslatePermission` | Enable or disable translation in this group (disabled by default) |
| `/wed` | Group member | Randomly draw a group member as "partner" and display their avatar; supports confirm, reroll, and remove; requires `/init enable` |
| `/h_image` | Group member | Post a uniformly random picture from the library (sent behind spoiler mask, permanently retained; failure notices auto-delete after `COMMAND_MESSAGE_AUTO_DELETE_MS`) |
| `/h_image add` | `isCanAddHImage` | Reply to an image message to add it (and other photos in the album seen so far) to the library; summary notice auto-deletes after `COMMAND_MESSAGE_AUTO_DELETE_MS` |
| `/info [@username\|id]` | Group member | Query target's nickname, username, numeric ID, and avatar (supports users, channels, bots, and the bot itself; notices auto-delete after `COMMAND_MESSAGE_AUTO_DELETE_MS`) |
| `/<action word>` | Group member | Chinese action commands matching `CJK_ACTION_COMMAND_PATTERN` (e.g. `/咬`, `/揪住`), replying "caller 动作了 target!"; successful outcomes retained permanently |
| `/quiet [<minutes>]` | Group member | Temporarily mute the bot's random banter and echoes (minutes clamped to `QUIET_MIN_MINUTES`..`QUIET_MAX_MINUTES`; defaults to `QUIET_DEFAULT_MINUTES`) |
| `/unquiet` | Group member | Lift quiet mode early |
| `/mute … <duration>`<br>`/unmute` | `isCanMute`<br>`isCanUnMute` | Mute or unmute members in a supergroup; targets support replies, `@username`, or numeric ID; durations support `m/h/d` units (clamped to `MUTE_MIN_DURATION_MS`..`MUTE_MAX_DURATION_MS`) |
| `/gag … [<minutes>] [<tool>]`<br>`/ungag …` | `isCanGag` | Restrict user or channel to speak exclusively via the bot's inline entry point (minutes in `GAG_DURATION_MINUTES`, default `GAG_DEFAULT_DURATION_MINUTES`; tool defaults to `GAG_DEFAULT_TOOL`), or release restrictions early |
| `/delete_message …`<br>`/delete_message stop …` | `SUPER_ADMIN_USER_ID` | Delete every message the target sends in this group from now on (earlier messages are untouched), or stop; accepts a reply, `@username`, user ID, or negative channel ID |
| `/block … enable` | `isCanBlock` | Blacklist target: records in permanent SQLite blacklist and bans them across all managed supergroups (supports reply, `@username`, or positive user ID) |
| `/block … disable` | `isCanUnBlock` | Unban target: removes from database and lifts bans across all managed supergroups (also accepts bare negative channel IDs; rejects the group itself) |
| `/ai_chat enable\|disable` | `isCanControllAIPermission` | Enable or disable AI chat in this group |
| `/clear_context` | `isCanClearContext` | Clears AI memory for this group (resets verbatim buffer and summaries, nullifies database snapshot); invalidates in-flight replies |
| `/mood query` | Group member | Check the current global AI mood (does not reroll; requires AI enabled and healthy model configuration) |
| `/mood switch` | `isCanSwitchMood` | Immediately reroll global AI mood (applies to all groups) and broadcast the new mood name |
| `/ad_detect enable\|disable` | `isCanControllAdDetectPermission` | Enable or disable smart ad detection in this group; violators are banned following `/block` rules and announced |
| `/flood_control enable\|disable` | `isCanControllFloodControlPermission` | Enable or disable flood muting in this group (disabled by default) |
| `/antiraid enable\|disable` | `isCanControllAntiRaidPermission` | Enable or disable join verification and anti-raid lockdown mode in this group (disabled by default) |
| `/qa set` | `isCanControllQaPermission` | Open a Q&A entry form; the caller provides "问题:" and "回答:" across two messages to register a pair (capped at `CHAT_QA_MAX_PER_CHAT` per group; lengths capped at `CHAT_QA_QUESTION_MAX_CHARS` and `CHAT_QA_ANSWER_MAX_CHARS`) |
| `/qa query`<br>`/qa query <question>` | Group member | List all custom Q&As in this group or query a specific question; answers previewed up to `QA_QUERY_ANSWER_PREVIEW_MAX_CHARS`, paginated at `QA_QUERY_PAGE_MAX_ENTRIES` per page (board retained; misses auto-delete after `COMMAND_MESSAGE_AUTO_DELETE_MS`) |
| `/qa remove <question>` | `isCanControllQaPermission` | Delete a specific custom Q&A entry from this group |
| `/permission query`<br>`/permission help` | User/channel | Query own, replied user's, or specified target's permissions, or list permission descriptions as JSON (boards retained permanently) |
| `/permission …` | `SUPER_ADMIN_USER_ID` | Modify individual permissions for an existing whitelisted identity; `all` grants all permissions |
| `/white … enable\|disable` | Add: `isCanWhiteOther`<br>Remove: `SUPER_ADMIN_USER_ID` | Add or remove whitelisted identities; delegated additions grant default permissions only; custom configurations require superadmin |
| `/bot_status` | `isCanViewBotStatus` | View system metrics, model readiness, Telegram 429 queue depth, AI memory capacity, active gag count, translation count, and group flags |
| `/init enable\|disable` | `SUPER_ADMIN_USER_ID` | Master toggle to enable or disable bot operation in the current group |
| `/batch_kick <Nm\|Nh\|Nd>` | `SUPER_ADMIN_USER_ID` | Batch kick members who joined within the given window (`BATCH_KICK_MIN_DURATION_MS`..`BATCH_KICK_MAX_DURATION_MS`) from a supergroup (kicks only, does not blacklist) |
| `/send <group_id>`<br>`/send finish` | `SUPER_ADMIN_USER_ID` (DM only) | Start or stop message relay from private chat to target group; supports sending speech bubbles via specific JSON code blocks |

> [!IMPORTANT]
> **Understanding the Permission Column**:
> - Commands marked `isCanXxx` are assigned via the permission dictionary. The superadmin (`SUPER_ADMIN_USER_ID`) inherently possesses **all** permissions without needing an entry in the whitelist.
> - Commands marked `SUPER_ADMIN_USER_ID` represent the **highest security boundary and can only be executed by the configured superadmin; they cannot be delegated via whitelists**.

### Parameter and Target Resolution Rules

- **Forum topic service messages**: Automated service messages generated when creating forum topics are treated as "no explicit reply". Commands can still target users via `@username` or numerical IDs. Comment replies inside linked channel discussion groups are treated as standard message replies.
- **Permission pre-warming**: Commands modifying or querying access lists must complete in-memory permission pre-warming before execution. If warming fails, the bot outputs a temporary error notice and aborts, preventing unauthenticated actions.
- **Command menus**: Commands with subcommands (`/copy`, `/qa`, `/mood`, `/icon`) are registered as single entries in the client menu, with syntax detailed in their description. Passing invalid or missing subcommands prints usage instructions.
  - `/qa set`, `/mood query`, and `/mood switch` accept no additional arguments.
  - `/qa query` lists all entries when omitting arguments; `/qa remove` requires the exact question text. Both commands strictly preserve internal whitespace and line breaks.
- **Notice retention**: Non-functional feedback generated by in-group commands (validation errors, permission denials, usage hints, and operation receipts) automatically deletes after `COMMAND_MESSAGE_AUTO_DELETE_MS`.
  - **Permanently retained exceptions**: Permission boards (`/permission help`, `/permission query`), Q&A boards (`/qa query`), direct Q&A answers, successful Chinese action command results, images from `/h_image`, messages from `cron.json`, and conversational content (echoes, translations, AI chat).
  - **State-machine messages**: Join verification buttons, `/qa set` forms, `/wed` result cards, and gag restriction notices are managed by state machines or teardown paths rather than static timers.
- **Case-insensitive subcommands**: Keywords such as `/copy stop|reverse|nya`, `/icon steal|reset`, `/qa set|remove|query`, `/translate <lang>|stop`, `/mood query|switch`, `/h_image add`, and `/delete_message stop` are case-insensitive, consistent with `/block`, `/white`, and `/init`. Target arguments and Q&A question texts retain their original casing.
- **Button callback validation**: Numeric tokens in `callback_data` for verification, `/wed`, and `/qa query` pagination must strictly parse as canonical decimal integers (`QA_QUERY_PAGE_ARG_PATTERN` for 0-based page numbers, positive integers for IDs; rejecting signs, leading zeros, whitespace, decimals, and scientific notation). Invalid payloads are treated as expired buttons.

---

### Behavior Details

#### 1. Persona and Notice Atmosphere
- System personas are configured globally and cannot be toggled per group via commands.
- The AI persona prompt defaults to `prompt/persona.md` at the project root; if absent, it falls back to the built-in teasing persona. Prompt tone for notices, buttons, menus, and inline fortunes follows the `atmosphere` setting in `config/static/bot.json` (`mesugaki` for teasing, `normal` for reserved). When omitted, custom personas default to `normal` (reserved tone), while the built-in persona defaults to `DEFAULT_BOT_ATMOSPHERE`.
- Atmosphere settings are initialized at startup; modifications require a process restart.
- At startup, the bot registers command menus for group chats only. No menu is shown in private chat; private chat only responds to superadmin `/send` relay commands.

#### 2. `/bot_status` Metric Collection
- **Wording follows the notice style**: the labels of the CPU, uptime, memory, model capability, and Telegram outbound lines come from the current notice style's text table (`packages/consts/atmosphere/{plain,teasing}/notices.ts`). The restrained and teasing styles each have their own set; values and inclusion rules are the same.
- **Model capability breakdown**: Lists only configured and ready capabilities in the format `capability: model name`. Model names omit namespace prefixes; xAI speech synthesis shows the configured voice name. Unconfigured capabilities (image generation, voice synthesis, web search) or unready modules are omitted. If no model capabilities are available, the entire section is omitted.
- **Memory footprint**: Calls `Bun.unsafe.memoryFootprint()` to measure the physical resident memory (PSS on Linux) across the bot process and all Worker threads, proportionally distributing shared libraries. Percentages use container cgroup limits as denominator, or host RAM if unconstrained.
- **AI context memory saturation**: Evaluates rolling verbatim memory (up to `VERBATIM_CONTEXT_MAX`) and summary rounds (up to `MAX_SUMMARY_ROUNDS`), returning a composite percentage weighted by `BOT_STATUS_HOT_MEMORY_WEIGHT` and `BOT_STATUS_COLD_MEMORY_WEIGHT`. This figure is periodically reported by the AI Worker via memory snapshots (`AI_SNAPSHOT_INTERVAL_MS`); the main thread reads the cached snapshot.
- **Permissions and group state**: Outputs a JSON block listing the bot's current administrator privileges in the group, followed by the active boolean states of all group feature switches.

#### 3. Action Commands and `/x`
- When an action command succeeds, the bot replies in the format `caller action target`. Users with public Telegram usernames have their names hyperlinked to their profiles; targets are resolved via reply or `@username`.
- Successful action replies are retained permanently. If targets are missing, parameters are invalid, or users tap the `/x` placeholder, notices auto-delete after `COMMAND_MESSAGE_AUTO_DELETE_MS`.

> [!TIP]
> **Chinese action commands require no prior registration**; any slash prefix matching `CJK_ACTION_COMMAND_PATTERN` (e.g. `/咬`, `/抱`, `/摸摸`) is handled directly:
> - Action commands do not appear in client suggestion menus. The menu includes `/x` as an ASCII placeholder that replies with usage examples.
> - Slash inputs not matching `CJK_ACTION_COMMAND_PATTERN` (e.g. `/咬咬咬`) fall through to standard message handling.
> - A global sliding window limits execution frequency: across all groups and users, at most `CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW` actions are processed per `CJK_ACTION_RATE_LIMIT_WINDOW_MS` window. Excess calls are silently dropped.

#### 4. Group Q&A: `/qa` Full Lifecycle
- **Interactive form submission**:
  - Sending `/qa set` opens an interactive submission session for the group (requires `isCanControllQaPermission`). Once open, it exclusively accepts subsequent inputs from the user who initiated the form (supports channel identities and anonymous admins).
  - Inputs must begin with a line-start label from `QA_QUESTION_LABELS` (`问题:` / `问题：`) or `QA_ANSWER_LABELS` (`回答:` / `回答：` / `答案:` / `答案：`). They can be submitted across two separate messages or combined into one.
  - Answers containing ```` ```json ```` code blocks are stored with literal fences and emitted with formatting during direct answers; fences count towards `CHAT_QA_ANSWER_MAX_CHARS`.
  - The whole question, and the answer outside code blocks, must not contain slash text that would render as a clickable command (such as `/start` or `/etc/hosts`). Like an over-length field, it is not recorded; the form stays open and the receipt asks for a rewrite. Command examples inside code blocks are accepted.
  - Claimed submission messages are deleted immediately without entering the regular pipeline, and the form card edits in place to reflect progress (truncating the answer preview with `QA_TRUNCATION_MARK` if the rendered prompt exceeds `TELEGRAM_MESSAGE_MAX_CHARS`, while storing the full answer in the database). Once both fields are received, the entry is committed to SQLite.
- **Concurrency and lifecycle**:
  - Each group supports at most one active form session at a time (up to `QA_FORM_SESSION_MAX` globally), expiring after `QA_FORM_SESSION_TTL_MS` of inactivity. Resubmitting an existing field overwrites previous content; sending `/qa set` again cancels the old session and starts fresh; submissions from other users while a form is active are rejected.
  - When a group is disabled via `/init disable` or the bot leaves, all Q&A entries for that chat are deleted from SQLite. Revoking admin rights alone retains Q&A data.
- **Board pagination and direct answers**:
  - Run `/qa query` to inspect registered Q&A entries, paginated at `QA_QUERY_PAGE_MAX_ENTRIES` items per page with inline pagination buttons. Answers are truncated to `QA_QUERY_ANSWER_PREVIEW_MAX_CHARS` on the board, while **questions are never truncated**.
  - **Direct verbatim matching**: When a user's message matches a registered question word-for-word (after stripping leading `@bot_username`), the bot replies immediately with the preset answer without AI processing or quiet-mode suppression. Semantically related but non-identical questions are retrieved and answered by the AI during conversation turns via `group_qa_query` and `group_qa_answer`.

#### 5. Speech Restriction: `/gag`
- **Session quotas and entry points**:
  - The system supports up to `GAG_SESSION_MAX` active gag sessions globally across all groups (including starting and ending transitions). Multiple targets per group are allowed, but duplicate sessions for the same user are rejected.
  - When restricting a regular user, the bot posts a public notice in the group and uses `ephemeral_message_parameters` to deliver an interactive "Speak" button visible only to that user. Channel identities receive a public message with the button.
  - Clicking the button launches Telegram Inline Mode prefilled with `GAG_INLINE_QUERY_PREFIX<target_id>` (`gag:<target_id>`). When sent, the message carries hidden verification parameters. The bot verifies the target ID, group ID, and sender upon arrival, immediately deleting forged or cross-group messages.
- **Dynamic text obfuscation**:
  - Grapheme clusters are sampled: with probability `GAG_FILL_OPERATION_PROBABILITY`, the engine appends dots (`GAG_FILLER_MIN_DOTS` to `GAG_FILLER_MAX_DOTS`, with spaces inserted at `GAG_FILLER_GAP_SPACE_PROBABILITY`); otherwise, it substitutes the character with one from `GAG_REPLACEMENT_CHARACTERS`.
  - Consecutive identical transformations are limited to `GAG_MAX_CONSECUTIVE_SAME_OPERATIONS` characters. Short messages enforce baseline disturbance per `GAG_MIN_OPERATION_TIERS`.
- **Heartbeat and refresh**:
  - Every `GAG_SPEAK_NOTICE_MESSAGE_INTERVAL` messages in the group, the bot sends a refreshed entry notice (tracked independently per session).
  - User-specific entry notices refresh after `GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS`. If a restricted user stays silent for `GAG_SPEAK_NOTICE_IDLE_INTERVAL_MS`, their next message triggers an immediate replacement entry notice.
- **Group teardown**: Running `/init disable` or revoking admin permissions terminates all gag sessions and deletes notices. If the bot is removed from the chat, session slots are freed immediately.

#### 6. Target Message Deletion: `/delete_message`
- **Syntax**: `/delete_message <target>` starts deleting and `/delete_message stop <target>` stops. Targets accept a reply, `@username`, a numeric user ID, or a negative channel ID; `stop` is case-insensitive. Only the super administrator can run it, and the bot must hold the delete-messages right in the group. The bot itself, the current group identity (anonymous admins), and the super administrator cannot be targets.
- **Scope**: Only messages the target sends in this group after the command are deleted; earlier messages are untouched. A message with `sender_chat` is matched by that channel identity, otherwise by `from`. The target's messages still pass join verification, ad detection, and flood counting first; they are then claimed and never reach gag, commands, AI, or copy, so commands sent by the target do not run.
- **Bot targets**: The bot only receives another bot's messages after Bot-to-Bot Communication Mode is enabled in @BotFather. Messages from a deletion target are checked before the ingress throttle for other bots: they pass without counting toward `BOT_MESSAGE_ACTIVITY_LIMIT`, so every message of a target bot that keeps talking is deleted, while the same bot is still counted in groups where it is not a target.
- **Queueing and deletion**: Each target message enqueues one entry into the main-thread in-memory deletion queue (at most `DELETE_MESSAGE_QUEUE_MAX` entries across all groups). A single consumer loop deletes them with `deleteMessages` through the unified Telegram outbound gate; entries from the same group that arrive back to back while a request is in flight form one batch of at most `TELEGRAM_DELETE_MESSAGES_BATCH_MAX`. Failed deletions are only written to the unified Telegram error log and are not retried. When the queue is full, new messages are still claimed but not enqueued; one warn line marks the overflow, and another summarizes the dropped count once the queue drains.
- **Capacity and persistence**: Each group holds at most `DELETE_MESSAGE_CHAT_TARGET_MAX` targets at a time. Targets are stored as a list of user/channel IDs in the `deleteMessageTargets` JSONB field of the group's SQLite `chat_states` row and survive restarts. Both arming and `stop` reply only after the write is durable. `stop` only removes the target; entries already queued are still deleted. `/init disable`, the bot leaving the group, or the bot losing admin rights clears and persists the removal of every target in that group and drops the group's unsent entries. Startup is refused if a stored target is the group itself or the configured super administrator; the deletion queue itself is in memory only. On a normal shutdown the queue drains before the Telegram outbound gate closes; whatever remains past the budget is dropped with an error log. Start, stop, and rejection notices auto-delete after `COMMAND_MESSAGE_AUTO_DELETE_MS` like other command notices.

#### 7. Blacklist: `/block`
- **Command syntax**: Run `/block <target> enable` to blacklist, and `/block <target> disable` to unban. Targets can be specified via reply (including channel-identity messages), `@username`, numerical user ID, or bare negative channel ID (bare negative channel IDs are accepted for `disable` unban only).
- **Scope of enforcement**: Blacklisted users are written to the authoritative SQLite table and banned across all active supergroups managed by the bot. When joining a new group or gaining admin permissions, the bot automatically sweeps and bans blacklisted members.
- **Asynchronous batch processing**: Once the blacklist record is written to disk, cross-group bans execute concurrently in the background, followed by a summary report. Groups where the bot lacks ban permissions are skipped and counted as failures. Unbanning likewise removes the target from the list and confirms persistence first, then lifts bans across groups in the background and replies when done; groups with confirmed missing ban rights are skipped and counted as failures. Blacklisting, unbanning and ad disposals for the same target run one after another in arrival order.
- **Deleted account pruning**: During member sweeps, if an account returns `PARTICIPANT_ID_INVALID` (deleted account) for `BLOCKLIST_PARTICIPANT_INVALID_LIMIT` consecutive attempts, the system automatically purges the deleted ID from the database.

#### 8. Ad Detection and Anti-Raid
- **`/ad_detect` (Intelligent Ad Blocker)**: Messages from the same sender are aggregated, and batches are submitted to the ad classification model every `AD_DETECT_QUEUE_TICK_MS`. Violators are permanently blacklisted and kicked across all groups, with ban notices posted in the group (auto-deleted after `COMMAND_MESSAGE_AUTO_DELETE_MS`). Pure proxy URLs (`vless://`, `vmess://`, `trojan://`, `ss://`) without promotional text are not flagged as ads.
- **`/flood_control` (Anti-Flood Protection)**: If a user sends `FLOOD_MESSAGE_LIMIT` messages within a sliding window of `FLOOD_WINDOW_MS`, they are temporarily muted for `FLOOD_MUTE_DURATION_MS` with an in-group warning (auto-deleted after `COMMAND_MESSAGE_AUTO_DELETE_MS`). Administrators (except bots) and channels are exempt; users with `isCanBypassFloodControl` bypass this check.
- **`/antiraid` (Verification & Lockdown)**: When enabled, new members must complete an interactive verification challenge within `VERIFICATION_TIMEOUT_MS`; more than `ANTI_RAID_PER_MINUTE_LIMIT` joins within `JOIN_WINDOW_MS` trigger private lockdown protection (`LOCKDOWN_MS`). Disabling this cancels all pending verifications and deletes reminders. Ad detection and blacklists operate independently of this toggle.
- **`/batch_kick` (Mass Kick Recent Joins)**: Superadmin only. Analyzes join logs to kick all members who joined within a specified timeframe (e.g. `30m`, `2h`, `1d`, bounded between `BATCH_KICK_MIN_DURATION_MS` and `BATCH_KICK_MAX_DURATION_MS`). Members are kicked without being blacklisted; whitelisted and already-blacklisted users are skipped. The bot replies with an acceptance receipt, executes kicks in the background, and posts a final report upon completion.

#### 9. Private Chat Relay and Voice Delegation: `/send`
- Superadmins send `/send <group_id>` in private chat to initiate relay. The bot validates chat reachability before forwarding subsequent direct messages to the target group.
- **Voice delegation**: Send messages formatted as JSON code blocks:
  ```json
  { "type": "tts", "tone": "gentle", "text": "text to speak" }
  ```
  - Text length is capped at `VOICE_OPERATOR_TEXT_MAX_CHARS`, and tone description at `VOICE_TONE_MAX_CHARS` (UTF-16 code units).
  - Audio is synthesized asynchronously in the background using `agent.tts` from `config/dynamic/agent.json`.
  - Quotas are deducted from `agent.tts.daily_reserve_quota` (shared with cron, isolated from conversational AI quotas).

> [!TIP]
> **`/luck_challenge` is an Inline Mode feature, not a slash command**: Type `@bot_username [query]` in any chat window to draw a daily fortune. Requires enabling Inline Mode in @BotFather. This endpoint is protected by a sliding window: up to `RATE_LIMIT_MAX_CALLS_PER_WINDOW` queries per `RATE_LIMIT_WINDOW_MS` window (defined in `packages/consts/luckChallenge.ts`); excess queries receive a rate-limit placeholder result. If refreshing the day's fortune secret fails, the error is logged and an empty result is returned. Both answers let the client cache them for only `LUCK_INLINE_NO_DRAW_CACHE_SECONDS` seconds.

---

## 💍 Group Marriage: `/wed`

In groups initialized with `/init enable`, members can send `/wed` (with no arguments) to draw a fellow member as their "partner" for the day. The bot replies with the selected member's avatar captioned "caller, 你的群友老婆是 member!", accompanied by interactive buttons. Button text reflects the active atmosphere: teasing (`mesugaki`) tone uses "移除", "娶老婆!", and "换一只" (updating to "已确认♡" once locked in); reserved (`normal`) tone uses "移除", "确认", and "更换" (updating to "已确认" once locked in).

| Button | Behavior |
| :--- | :--- |
| **移除** | Deletes the result message and releases the session |
| **娶老婆! / 确认** | Locks in the current choice, updating the button to "已确认♡" / "已确认"; rerolling remains available |
| **换一只 / 更换** | Redraws a new candidate in the same card, updating avatar and caption while excluding the caller and current target |

### Core Mechanics

- **Caller exclusivity**: Only the user who sent `/wed` can click the buttons. Clicking old buttons while a redraw is in progress does not affect the new target. Sending `/wed` again starts a new draw, deleting the previous card only after the new card arrives; if the new card fails to send, the old card is kept; if the old card fails to delete, it remains with deactivated buttons. Each user retains at most one active card per group.
- **Candidate pool construction**:
  - The bot maintains an in-memory **`Map<number, number>`** (member ID → entry time) candidate window for each group, with a capacity of `WED_MEMBER_LIMIT`.
  - Only users who actively speak as **personal accounts** in the group are added (channels, anonymous admins, and service messages are excluded).
  - A member outside the window is appended by entry time when they speak; members already in the window keep their entry time. A full window evicts the earliest entrant. Departure events remove members immediately.
  - On the daily maintenance schedule (`DISK_IO_MAINTENANCE_CRON` in the configured timezone), background maintenance instructs the main thread to verify candidate presence sequentially via `getChatMember` at `WED_MEMBER_REVIEW_INTERVAL_MS` intervals (requires admin permissions); non-admin groups rely on leave service notices.
- **Avatar retrieval and caching**:
  - Upon selecting a candidate, the bot queries `getChat` and `getUserProfilePhotos` (up to `USER_PROFILE_PHOTOS_LIMIT`) concurrently, matching active avatars via `big_file_unique_id`.
  - Matching avatars are forwarded directly using Telegram's cached `PhotoSize.file_id` without downloading or re-uploading bytes. Unmatched avatars fall back to downloading and uploading.
- **Concurrency and capacity**:
  - All draws and button clicks route through a dedicated main-thread scheduler: global concurrency is capped at `WED_MAX_CONCURRENT`, the waiting queue at `WED_MAX_PENDING` (FIFO), and each draw or delivery stage has a timeout of `WED_OPERATION_TIMEOUT_MS`.
  - The candidate window persists as a JSON array of `{ id, enteredAt }` entries in entry order in `memory/wed/<chatId>.json`, written in batches by the Disk I/O Worker (see flush rules in [07 Operations](07-operations.md#data-root)).
  - Each group retains the most recently delivered `WED_SESSION_LIMIT` results: when a new result is delivered, the earliest idle result slides out, leaving its photo in the group with buttons replying expired; failed draws or deliveries never evict existing results; only reaching the `STATE_MANAGED_CHAT_LIMIT` group limit rejects requests from new groups. Result cards do not have static auto-deletion timers; they are removed via buttons or during group teardown (results that slide out are no longer deleted by the bot).

---

## 🔎 Profiles: `/info`

In initialized groups, members can query an identity's public profile via `/info`: reply to their message, or specify `/info @username`, `/info <user ID>`, or `/info <channel/group ID>`. Supports regular users, broadcast channels, other bots, and the bot itself.

- **Profile information**: Displays public display names (`first_name last_name` for users, title for channels/groups), usernames (noted if unset), and numeric IDs (tap to copy). If the target has a public avatar, it is attached; if not, this is noted.
- **Live data sources**: Queries Telegram APIs live. Resolves group member profiles for users, chat info for channels/groups, and startup configurations for the bot itself. If live queries fail, cached identities are used; if even names cannot be resolved, the bot replies "not found". Avatar fetching reuses `/wed` logic; groups omit avatars by default.
- **Lifecycles and queues**: Results and error notices auto-delete after `COMMAND_MESSAGE_AUTO_DELETE_MS`. Queries route through the shared deferred command executor, with an execution budget of `INFO_TASK_BUDGET_MS` per task; full queues reply "try again later". `/info` does not respond in private chat.

---

<a id="random-images"></a>

## 🖼️ Random Pictures: `/h_image`

**Library setup**: The local library path is configured in `config/dynamic/assets.json` under `onlyPath.random_h_image_dir` (defaults to `RANDOM_H_IMAGE_DIR` relative to the data root).

In initialized groups, sending `/h_image` (without arguments) picks a uniformly random image from the library and posts it to the group.

- **Format filtering**: Scans files matching `RANDOM_IMAGE_EXTENSIONS` (`jpg`, `jpeg`, `png`, and `webp`) in the library root (ignoring hidden files, subfolders, and symlinks). Files exceeding `RANDOM_IMAGE_MAX_BYTES` are skipped, triggering a redraw. Adding or removing images takes effect dynamically without restarts.
- **Spoiler protection**: Drawn images always include Telegram spoiler masks (`has_spoiler`), appearing blurred until clicked.
- **Retention policy**: Output pictures are functional content and **retained permanently**; syntax errors, empty libraries, or lookup failures auto-delete after `COMMAND_MESSAGE_AUTO_DELETE_MS`.
- **Concurrency and rate limits**:
  - Shared deferred executor limits: concurrency capped at `DEFERRED_COMMAND_MAX_CONCURRENT`, and pending queue at `DEFERRED_COMMAND_MAX_PENDING`.
  - Sliding-window rate limit: combined with `/h_image add` and usage hints, up to `H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW` calls are accepted per `H_IMAGE_RATE_LIMIT_WINDOW_MS` window. Excess calls are silently dropped.

### Collecting Pictures: `/h_image add`

Users with `isCanAddHImage` can reply to an image message with `/h_image add` to add images to the library.

- **Eligible inputs**: Native photos in the replied message (highest resolution selected), or uncompressed files matching `RANDOM_IMAGE_DOCUMENT_MIME_TYPES` (`image/jpeg`, `image/png`, or `image/webp`) sent as documents. If the message belongs to an album (Media Group), all received photos in that album are collected in batch (capped at `MEDIA_GROUP_ITEMS_MAX` items per album, with `MEDIA_GROUP_CACHE_MAX` albums in cache).
- **Content-addressed deduplication**:
  - Filenames are strictly the **lowercase SHA-256 hash of the binary file** (`RANDOM_IMAGE_CONTENT_NAME_PATTERN`) with the extension mapped by `RANDOM_IMAGE_SAVE_EXTENSIONS` (e.g. `<hash>.jpg`).
  - Deduplication happens after downloading: if an identical hash exists in the library, writing is skipped and marked as duplicate in the receipt.
- **Dimension pre-checks**: Resolutions are verified against Telegram `sendPhoto` limits: width + height must not exceed `TELEGRAM_PHOTO_MAX_DIMENSION_SUM`, and aspect ratio must not exceed `TELEGRAM_PHOTO_MAX_ASPECT_RATIO`. Files exceeding limits, larger than `RANDOM_IMAGE_MAX_BYTES`, in unsupported formats, or timing out are marked as failures.
- **Atomic file writes**: Images are written to temporary files prefixed with `RANDOM_IMAGE_TEMP_PREFIX` in the library directory and renamed atomically upon verification. Draws ignore dot-prefixed files.
- **Batching and receipts**: Albums download in batches of `H_IMAGE_ADD_DOWNLOAD_BATCH_SIZE` concurrently. The overall task budget is `H_IMAGE_ADD_TASK_BUDGET_MS`; images exceeding this budget count as failures. Upon completion, a summary receipt reports new additions, pre-collection library size, duplicates, invalid dimensions, and download failures (auto-deleted after `COMMAND_MESSAGE_AUTO_DELETE_MS`).

---

## ⏰ Scheduled Posts: `cron.json`

Scheduled tasks are configured by administrators in `config/dynamic/cron.json` and support hot-reloading without group commands. For field definitions, see the [Configuration Guide](../../config_example/README/en.md#cronjson); for examples, see [08 Images and Scheduled Tasks](08-images-and-cron.md).

- **Flexible targeting**: Broadcasts text, photos, documents, voice bubbles, or web summaries to specific groups, all enabled groups, or all groups except an excluded list.
- **Media and spoilers**: Fixed images can specify public URLs or local file paths in an array (up to `CRON_MAX_IMAGES`); multiple images assemble into an album with a caption on the first image. Random mode draws one image per trigger. The `is_blurred` flag toggles spoiler masks.
- **Scheduled voice notes (`send_voice`)**: Synthesizes `content` into voice notes using optional `tone` hints. Requires valid `agent.tts` configuration in `agent.json`; invalid setups fail validation at startup or reload.
- **AI web search summaries (`send_web_digest`)**: Searches web results for a brief `topic` and formats them into a MarkdownV2 summary following `instructions` (up to `max_items`). Prefers `agent.web_search`, falling back to text model search capabilities. If the model does not trigger an external search, `WEB_DIGEST_UNSEARCHED_WARNING` is prepended.
- **Lifecycle and routing**: Scheduled messages are permanent functional messages; in supergroups with topics, they post to the General topic. One-off schedules and randomized delays are tracked in memory only; tasks scheduled during downtime are not backfilled upon restart.

---

<div align="center">

[← Prev: 08 Images and Scheduled Tasks](08-images-and-cron.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#09-command-and-behavior-reference) · [Next: 10 Performance Benchmark →](10-performance.md)

</div>
