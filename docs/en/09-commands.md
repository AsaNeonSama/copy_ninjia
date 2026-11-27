# 09 Command and Behavior Reference

<p align="center">
  <a href="../cn/09-commands.md">简体中文</a> · <b>English</b> · <a href="../ja/09-commands.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="08-images-and-cron.md">← Prev: 08 Images and Scheduled Tasks</a> · <a href="10-mini-app.md">Next: 10 Mini App Setup →</a>
</p>

---

This page is the complete reference for end-user commands, required permissions, and runtime behavior. The root README keeps only a brief overview; this document is the authoritative specification. Command implementations live in `packages/commands/`, and permission keys are defined in [`packages/types/identityPolicy.ts`](../../packages/types/identityPolicy.ts).

## 🎭 Copy Modes

- **Global singleton target**: A bot instance can imitate only **one target at a time** across the entire instance, and echoing occurs exclusively inside the group where `/copy` was started.
- **Stopping and automatic teardown**: Running `/copy stop` from any group halts the active copy state immediately. If the originating group is disabled via `/init disable`, or if the bot leaves or loses administrator privileges there, the copy state stops automatically, persists to disk immediately, and resets the bot avatar silently in the background without posting a group notice.

| Command | Behavior |
| :---: | :--- |
| `/copy` | Echoes the target's subsequent messages verbatim |
| `/copy reverse` | Reverses text and captions by Unicode grapheme clusters |
| `/copy nya` | Appends `NYA_SUFFIX` (`"喵~"`) to the end of text and captions |
| `/icon steal` | Copies the target's current avatar without echoing text |
| `/icon reset` | Restores the bot's configured default avatar |
| `/copy stop` | Stops active global repetition and restores the default avatar |

### Sending and Transformation Mechanics

The `/copy` command family shares message transformation rules with autonomous random echoing:
- **Text and captions**: Processed as plain strings, including messages with URLs or `@username` mentions. Plain text is resent while Telegram clients re-parse links and mentions, preserving the original link preview setting.
- **Entity styling stripped**: Rich text entities (bold, underline, inline URLs, spoilers, custom emojis) are discarded; spoiler-masked text in the original message is sent as cleartext.
- **Rich media**: Photos, videos, documents, and stickers are duplicated server-side by Telegram without downloading files locally, replacing any caption with the transformed text. Paid media cannot be duplicated: captioned paid media forwards only the text caption, and captionless paid media is ignored.
- **Pure non-text messages**: Polls, dice, locations, and contacts without text or media files are forwarded verbatim.
- **Command loop prevention**: If text before or after transformation contains a renderable slash command, the entire message is dropped.
- **Length overflow protection**: If transformed text exceeds `TELEGRAM_MESSAGE_MAX_CHARS` or `TELEGRAM_CAPTION_MAX_CHARS`, the entire message is dropped.

### Target and Parameter Specification

Specify targets by replying to a message or passing an explicit `@username`:
- **Syntax order**: Place the mode keyword before the target, e.g. `/copy reverse @username` or `/copy nya @username`; use `/icon steal @username` to copy only the avatar. `/copy stop` and `/icon reset` accept no extra arguments.
- **Username cache dependency**:
  - Resolving `@username` requires the bot to have previously observed that account speaking in a group and cached its identity. When a user changes, removes, or reassigns their username, stale cache entries are invalidated immediately.
  - For destructive management commands such as `/block … enable`, prefer replying to the target's message or passing a numeric ID directly.
  - When `/block`, `/mute`, `/white`, or `/permission` modifies access via `@username`, the bot re-verifies the target's live username before executing and aborts if it has changed or cannot be verified.
- **Anonymous group administrators**: When an admin speaks anonymously as the group, the message source is the group itself. Copying that message adopts the group's avatar and imitates the group persona; `/block` refuses to block the current group identity.
- **Global cooldown**: `/copy`, `/copy reverse`, `/copy nya`, `/icon steal`, and `/icon reset` share a global cooldown (`COPY_COOLDOWN_MS`). Only `SUPER_ADMIN_USER_ID` is exempt; whitelisted users still observe the cooldown. `/copy stop` is never rate-limited by cooldown.

---

## 🌐 Per-Group Translation

Per-group translation runs independently of global copy mode, avatars, and copy cooldowns:
- **Prerequisites**: An operator with `isCanControllTranslatePermission` must run `/translate enable` in the group (disabled by default), and a valid `g-auth.json` must be configured.
- **Translating other bots**: Enable Bot-to-Bot Communication Mode in @BotFather so this bot receives messages from other bots; incoming bot messages remain governed by [other-bot ingress rate limits](04-invariants.md) (see [01 Getting Started](01-getting-started.md)).
- **Background FIFO queue**: Translations dispatch sequentially per group in the background without blocking normal message pipelines. Once pending messages in a group reach `TRANSLATE_CHAT_BACKLOG_MAX`, new messages are dropped until the queue drains.

| Command | Behavior |
| :--- | :--- |
| `/translate ja` | Reply to a message to translate subsequent speech into Japanese |
| `/translate cn @username` | Target an observed username to translate speech into Simplified Chinese |
| `/translate en` | Reply to a message to translate subsequent speech into American English |
| `/translate uk` | Reply to a message to translate subsequent speech into Ukrainian |
| `/translate ru` | Reply to a message to translate subsequent speech into Russian |
| `/translate list` | Display the supported target languages as a JSON code block |
| `/translate stop` | Stop all active translations in this group when called without arguments (keeps the feature enabled) |
| `/translate stop @username` or `/translate stop 123456789` | Stop translation for a specific target; also supports message replies and negative channel IDs |
| `/translate disable` | Clear all translation sessions in this group and disable the feature (requires permission) |

### Session Capacity and Exclusion Rules

- **Session quotas**: Any group member can start or stop translation sessions. Each group supports up to `TRANSLATE_CHAT_USER_LIMIT` distinct identities concurrently, each with its own target language, and total managed groups are bounded by `STATE_MANAGED_CHAT_LIMIT`. Requests beyond capacity are rejected without evicting existing sessions; stop the target's active session first before switching languages.
- **Parameter conflict check**: Replying to a message while passing a conflicting target argument is rejected rather than falling back to stopping all sessions in the group.
- **Priority over copy mode**: `/copy stop` does not affect active translation sessions. If the same identity is targeted by both copy and translation, **translation takes priority** (no verbatim echo, media copy, or reaction syncing); copying other targets continues unaffected.

Running `/translate list` outputs `TRANSLATE_LANGUAGE_LABELS` as a Telegram `pre` entity with `TRANSLATE_LIST_JSON_LANGUAGE` syntax highlighting (auto-deleted after `COMMAND_MESSAGE_AUTO_DELETE_MS`):

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

- **Regex pre-filtering**: Text and captions are checked as plain strings. If regexes classify a message as already written in the target language—or consisting solely of digits, punctuation, or emojis—the translation API is skipped and nothing is sent:
  - **Japanese**: Requires kana (`TRANSLATE_JAPANESE_EVIDENCE` / `TRANSLATE_JAPANESE_TEXT`).
  - **Simplified Chinese**: Excludes traditional characters that have simplified variants in Unicode Unihan (`TRANSLATE_CHINESE_EVIDENCE` / `TRANSLATE_CHINESE_TEXT`).
  - **English**: Accepts ASCII letters (`TRANSLATE_ENGLISH_EVIDENCE` / `TRANSLATE_ENGLISH_TEXT`). American English calls the [Google Translation LLM](https://docs.cloud.google.com/translate/docs/languages#translation-llm) (`TRANSLATE_REGIONAL_MODEL`) with `en-US`.
  - **Ukrainian**: Accepts Ukrainian-specific letters and apostrophes while excluding Russian `ёъыэ` (`TRANSLATE_UKRAINIAN_EVIDENCE` / `TRANSLATE_UKRAINIAN_TEXT`).
  - **Russian**: Accepts `Ё/ё` while excluding Ukrainian-specific `єіїґ` (`TRANSLATE_RUSSIAN_EVIDENCE` / `TRANSLATE_RUSSIAN_TEXT`).
  - *Note*: Shared CJK characters, unaccented Latin words, and short Cyrillic phrases can be ambiguous; pre-filtering performs character-set matching rather than semantic language detection.
- **Delivery format**: Only the translated text is sent—never the original text or media files. Nothing is sent if the API call fails or returns text identical to the input:
  - Output is sent as plain text without rich formatting, preserving the source message's link preview setting when URLs are present.
  - Captioned photos, videos, audio, documents, and paid media have only their captions translated and sent as plain text.
  - Captionless media, stickers, polls, and locations are skipped without falling back to copy mode.
  - Translations exceeding `TELEGRAM_MESSAGE_MAX_CHARS` are dropped. Output stays in the triggering forum topic (`message_thread_id`) and suppresses renderable slash commands; command notices auto-delete after `COMMAND_MESSAGE_AUTO_DELETE_MS`.
- **Persistence and recovery**: Active sessions are stored in the `translate` JSONB column of the group's row in SQLite `chat_states`. Stopping one target cancels only that target without interrupting in-flight translations for others. Running `/translate disable` or removing the bot from the group clears all sessions for that group. `/bot_status` displays the active translation count and limit.

---

## 🎮 Commands and Permissions

| Command | Permission | Description |
| :--- | :---: | :--- |
| `/copy`<br>`/copy reverse`<br>`/copy nya` | Group member | Start the corresponding text and caption copy mode |
| `/copy stop` | Group member | Stop global copy mode and restore the default avatar |
| `/icon steal` | Group member | Copy only the target's avatar |
| `/icon reset` | Group member | Restore the bot's configured default avatar |
| `/translate ja\|cn\|en\|uk\|ru [@username]`<br>`/translate list`<br>`/translate stop [@username/id]` | Group member | Start translation in a target language, list languages, or stop all / specific sessions |
| `/translate enable\|disable` | `isCanControllTranslatePermission` | Enable or disable translation in this group (disabled by default) |
| `/wed` | Group member | Draw a random group member as "partner" with their avatar; supports confirm, reroll, and remove; requires `/init enable` |
| `/h_image` | Group member | Send a uniformly random image from the dedicated library (with spoiler mask, kept permanently; failure notices auto-delete after `COMMAND_MESSAGE_AUTO_DELETE_MS`) |
| `/h_image add` | `isCanAddHImage` | Reply to an image message to add it (plus any received photos from the same album) to the library; summary auto-deletes after `COMMAND_MESSAGE_AUTO_DELETE_MS` |
| `/info [@username\|id]` | Group member | Query display name, username, numeric ID, and avatar for a user, channel, bot, or this bot (auto-deletes after `COMMAND_MESSAGE_AUTO_DELETE_MS`) |
| `/<action word>` | Group member | Chinese action command matching `CJK_ACTION_COMMAND_PATTERN` (e.g. `/咬`, `/揪住`), replying "caller 动作了 target!"; successful replies are kept permanently |
| `/quiet [<minutes>]` | Group member | Pause autonomous AI banter and random echoes (`QUIET_MIN_MINUTES`..`QUIET_MAX_MINUTES`; defaults to `QUIET_DEFAULT_MINUTES`) |
| `/unquiet` | Group member | End quiet mode early |
| `/mute … <duration>`<br>`/unmute` | `isCanMute`<br>`isCanUnMute` | Temporarily mute or unmute a member in a supergroup via reply, `@username`, or numeric ID; duration accepts `m/h/d` (`MUTE_MIN_DURATION_MS`..`MUTE_MAX_DURATION_MS`) |
| `/gag … [<minutes>] [<tool>]`<br>`/ungag …` | `isCanGag` | Restrict a user or channel to speak only via the bot's inline entry (`GAG_DURATION_MINUTES`, default `GAG_DEFAULT_DURATION_MINUTES`; tool defaults to `GAG_DEFAULT_TOOL`), or lift early |
| `/delete_message …`<br>`/delete_message stop …` | `SUPER_ADMIN_USER_ID` | Delete every subsequent message sent by the target in this group (earlier messages are untouched), or stop; accepts reply, `@username`, user ID, or negative channel ID |
| `/block … enable` | `isCanBlock` | Blacklist target: persist to SQLite blocklist and ban across all managed supergroups (accepts reply, `@username`, or positive user ID) |
| `/block … disable` | `isCanUnBlock` | Unblock target: remove from SQLite blocklist and unban across all managed supergroups (also accepts bare negative channel IDs; rejects the group itself) |
| `/ai_chat enable\|disable` | `isCanControllAIPermission` | Enable or disable AI chat in this group |
| `/clear_context` | `isCanClearContext` | Clear AI context memory for this group (resets verbatim buffer and summaries, sets `chat_states.ai_context` to `NULL`, and invalidates in-flight replies) |
| `/mood query` | Group member | View the active global AI mood without rerolling (requires AI chat enabled and valid AI configuration) |
| `/mood switch` | `isCanSwitchMood` | Reroll the global AI mood immediately across all groups and announce the new mood |
| `/ad_detect enable\|disable` | `isCanControllAdDetectPermission` | Enable or disable smart ad detection in this group (enabling requires `agent.ad_detect` and `ad_detect.json` to be ready); non-protected senders are muted, kicked, or banned per `ad_detect.json` and announced |
| `/ad_detect sticker\|emoji list [page]`<br>`/ad_detect sticker\|emoji add [pack...]`<br>`/ad_detect sticker\|emoji remove [pack...]` | `isCanControllAdDetectPermission` | Manage global ad sticker / custom-emoji pack blacklists persisted in SQLite `ad_pack_blacklists` (independent of `ad_detect.json` readiness); supports paginated listing (20 per page) and adding/removing by pack names or message reply; notices auto-delete after `COMMAND_MESSAGE_AUTO_DELETE_MS` |
| `/flood_control enable\|disable` | `isCanControllFloodControlPermission` | Enable or disable anti-flood muting in this group (disabled by default) |
| `/antiraid enable\|disable` | `isCanControllAntiRaidPermission` | Enable or disable join verification and anti-raid private lockdown in this group (disabled by default) |
| `/qa set` | `isCanControllQaPermission` | Open a Q&A entry form; submit `问题:` and `回答:` to register a pair (up to `CHAT_QA_MAX_PER_CHAT` per group; bounded by `CHAT_QA_QUESTION_MAX_CHARS` and `CHAT_QA_ANSWER_MAX_CHARS`) |
| `/qa query`<br>`/qa query <question>` | Group member | List all custom Q&As or query one question; paginated at `QA_QUERY_PAGE_MAX_ENTRIES` per page with answers previewed to `QA_QUERY_ANSWER_PREVIEW_MAX_CHARS` (board kept; misses auto-delete after `COMMAND_MESSAGE_AUTO_DELETE_MS`) |
| `/qa remove <question>` | `isCanControllQaPermission` | Delete a specific custom Q&A entry from this group |
| `/permission query`<br>`/permission help` | User/channel | Query permissions for yourself, a replied message, or an explicit target, or list permission descriptions as JSON (boards kept permanently) |
| `/permission …` | `SUPER_ADMIN_USER_ID` | Update individual permissions on a whitelisted identity; pass `all` to grant every permission |
| `/white … enable\|disable` | Add: `isCanWhiteOther`<br>Remove: `SUPER_ADMIN_USER_ID` | Add or remove whitelisted identities; delegated additions grant default permissions only, while custom permission edits require superadmin |
| `/bot_status` | `isCanViewBotStatus` | Inspect runtime metrics, model readiness, Telegram 429 queue depth, AI context saturation, active gags, active translations, bot admin rights, and group feature flags |
| `/init enable\|disable` | `SUPER_ADMIN_USER_ID` | Master switch enabling or disabling bot management in the current group |
| `/batch_kick <Nm\|Nh\|Nd>` | `SUPER_ADMIN_USER_ID` | Kick members who joined a supergroup within the specified lookback window (`BATCH_KICK_MIN_DURATION_MS`..`BATCH_KICK_MAX_DURATION_MS`) without blacklisting |
| `/send <group_id>`<br>`/send finish` | `SUPER_ADMIN_USER_ID` (DM only) | Start or finish private-chat message relay to a managed group; supports synthesizing speech bubbles via a JSON code block |

> [!IMPORTANT]
> **Reading the Permission Column**:
> - Commands marked `isCanXxx` are controlled by whitelist permission flags. `SUPER_ADMIN_USER_ID` permanently holds **all** permission flags without needing a whitelist row.
> - Commands marked `SUPER_ADMIN_USER_ID` form the **top-level security boundary: only the configured superadmin user ID can invoke them, and they can never be delegated via the whitelist**.

### Parameter and Target Resolution Rules

- **Forum topic creation service messages**: Replying to the automatic service message generated when a forum topic is created counts as "no explicit message reply", allowing commands to resolve targets via `@username` or numeric ID. Comment replies on auto-forwarded linked-channel posts inside discussion groups work as normal replies.
- **Permission pre-warming**: Any command that queries or mutates allowlists or blocklists requires in-memory identity policy pre-warming to succeed first. If pre-warming fails, the bot sends a short-lived error notice and aborts.
- **Command menu entries**: Multi-subcommand commands (`/copy`, `/qa`, `/mood`, `/icon`) register as single menu entries whose descriptions list common subcommands. Missing or unknown subcommands return usage instructions:
  - `/qa set`, `/mood query`, and `/mood switch` take no extra arguments.
  - `/qa query` lists all entries when called without arguments; `/qa remove` requires the exact question text. Both preserve internal spaces and line breaks verbatim.
- **Notice retention**: All non-functional in-group command notices (validation errors, permission denials, usage hints, and action receipts) auto-delete after `COMMAND_MESSAGE_AUTO_DELETE_MS`.
  - **Permanently retained exceptions**: Permission boards (`/permission help`, `/permission query`), Q&A boards (`/qa query`), direct Q&A answers, successful Chinese action command outputs, `/h_image` photos, scheduled `cron.json` messages, and conversational outputs (echoes, translations, AI replies).
  - **State-machine messages**: Join verification prompts, `/qa set` forms, `/wed` cards and buttons, and gag notices or speak entry prompts do not carry fixed timers; they are deleted by button interactions, state-machine transitions, or group teardown.
- **Case-insensitive subcommands**: Subcommand keywords (`/copy stop|reverse|nya`, `/icon steal|reset`, `/qa set|remove|query`, `/translate <lang>|stop`, `/mood query|switch`, `/h_image add`, `/delete_message stop`, `/ad_detect sticker|emoji list|add|remove`) are case-insensitive, matching `/block`, `/white`, and `/init`. Target usernames, IDs, ad pack short names, and Q&A texts preserve original casing.
- **Strict callback validation**: Numeric tokens in `callback_data` for join verification, `/wed`, and `/qa query` pagination are parsed strictly as canonical decimal integers (`QA_QUERY_PAGE_ARG_PATTERN` for 0-based pages, `VERIFY_ANSWER_ARG_PATTERN` for verification options, positive integers for IDs—rejecting leading `+`, leading zeros, whitespace, decimals, and scientific notation). Malformed payloads reply as expired buttons and are ignored.

---

### Behavior Details

#### 1. Persona and Notice Atmosphere
- **Instance-wide scope**: Persona prompts apply across the entire bot instance and cannot be switched per group via commands.
- **Persona vs. notice tone**:
  - **AI persona**: Loads `prompt/persona.md` from the repository root if present; otherwise falls back to the built-in teasing persona.
  - **Bot notices and menus**: Command notices, permission help, inline buttons, cron announcements, and inline fortunes follow `atmosphere` in `config/static/bot.json` (`mesugaki` = teasing, `normal` = restrained). When `atmosphere` is omitted, a custom `persona.md` defaults to `normal` while the built-in persona defaults to `DEFAULT_BOT_ATMOSPHERE`.
  - **Mini App console**: Always uses the teasing (`mesugaki`) tone (including its permission descriptions), regardless of `atmosphere`.
- **Startup initialization**: Both persona and atmosphere lock in at startup; changes require a service restart.
- **Command menu scope**: Startup registers command menus for `all_group_chats` only and clears the default private-chat menu. Private chat responds only to superadmin `/send` relay commands and, when `mini_app` is configured, mounts `MenuButtonWebApp` (`App`) in the superadmin's private chat.

#### 2. `/bot_status` Metric Collection
- **Atmosphere-aware labels**: Row labels for CPU, uptime, memory, model capabilities, and Telegram outbound gates come from the active notice table (`packages/consts/atmosphere/{plain,teasing}/notices.ts`), sharing identical metrics and inclusion rules across both tones.
- **Model capability list**: Displays only configured and ready capabilities as `capability: model_name` (stripping namespace prefixes before the last `/`, and showing the voice name for xAI TTS). Unconfigured optional capabilities (image generation, TTS, standalone web search) and unready AI chat or ad detection modules are omitted; if none are ready, the entire section is omitted.
- **Memory footprint**: Calls `Bun.unsafe.memoryFootprint()` on demand to sample resident memory across the process and all Workers (PSS on Linux, proportionally splitting shared pages). Usage percentage divides by the container cgroup limit when present, or host physical RAM otherwise (displaying "unavailable" if unreadable).
- **Group AI context saturation**: Computes usage ratios for rolling hot verbatim messages (`VERBATIM_CONTEXT_MAX`) and cold summary rounds (`MAX_SUMMARY_ROUNDS`), combined into a single percentage weighted by `BOT_STATUS_HOT_MEMORY_WEIGHT` and `BOT_STATUS_COLD_MEMORY_WEIGHT`. The AI Worker reports counts on its `AI_SNAPSHOT_INTERVAL_MS` snapshot cadence, and the main thread reads its read-only mirror.
- **Permissions and feature switches**: Prints two JSON code blocks—one for the bot's current administrator rights in the group, and one mapping Chinese capability keys (`BOT_STATUS_FEATURE_LABELS`) to `true` / `false` for every group feature switch.

#### 3. Action Commands and `/x`
- Successful action commands reply with `caller action target`, hyperlinking display names to public Telegram profiles when available; targets are resolved by reply or `@username`.
- Successful action replies are kept permanently, whereas missing targets, invalid arguments, and `/x` placeholder taps auto-delete after `COMMAND_MESSAGE_AUTO_DELETE_MS`.

> [!TIP]
> **Chinese action commands need no registration**—any slash word matching `CJK_ACTION_COMMAND_PATTERN` (such as `/咬`, `/抱`, `/摸摸`) works out of the box:
> - Because Telegram's native menu accepts ASCII commands only, `/x` serves as the menu placeholder and replies with usage examples when tapped.
> - Inputs exceeding `CJK_ACTION_COMMAND_PATTERN` length limits (e.g. `/咬咬咬`) are not parsed as action commands and pass through as ordinary chat messages.
> - A global sliding-window limiter caps execution at `CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW` calls per `CJK_ACTION_RATE_LIMIT_WINDOW_MS` across the entire instance, silently dropping excess calls.

#### 4. Group Q&A: `/qa` Full Lifecycle
- **Interactive form submission**:
  - `/qa set` opens a form session for the group (requires `isCanControllQaPermission`) and binds the triggering forum topic (`message_thread_id`) in forum supergroups. Only subsequent messages from that same caller (including channel identities and anonymous admins) inside the same group and topic are claimed; messages in other topics are untouched.
  - Submissions must start with a line-start prefix from `QA_QUESTION_LABELS` (`问题:` / `问题：`) or `QA_ANSWER_LABELS` (`回答:` / `回答：` / `答案:` / `答案：`), sent in either two messages or a single combined message.
  - ```` ```json ```` code blocks inside answers are stored with literal fences and rendered on direct replies; the fences count toward `CHAT_QA_ANSWER_MAX_CHARS`.
  - Neither the question nor text outside code blocks in the answer may contain slash tokens that Telegram renders as clickable commands (such as `/start` or `/etc/hosts`). Just like over-length inputs, offending fields are rejected while keeping the form open and prompting for a rewrite; slash commands inside code blocks are allowed.
  - Claimed input messages are deleted immediately before entering the message pipeline, and the form message edits in place to show progress (truncating the rendered answer preview with `QA_TRUNCATION_MARK` if the card would exceed `TELEGRAM_MESSAGE_MAX_CHARS`, while saving the full answer to SQLite once both fields arrive).
- **Concurrency and teardown**:
  - At most one form session may be open per group (`QA_FORM_SESSION_MAX` globally), expiring after `QA_FORM_SESSION_TTL_MS` of idle time. Resending a field overwrites its draft value; re-running `/qa set` by the same caller replaces the previous form; `/qa set` from another user while a form is open is rejected.
  - `/init disable` or bot departure deletes all Q&A rows for that group from SQLite; losing administrator privileges alone keeps stored Q&A entries intact.
- **Board pagination and direct matching**:
  - `/qa query` paginates entries at `QA_QUERY_PAGE_MAX_ENTRIES` per page with inline page buttons. Board previews truncate answers at `QA_QUERY_ANSWER_PREVIEW_MAX_CHARS`, while **questions are never truncated**.
  - **Exact direct reply**: When a group message matches a stored question character-for-character (after stripping a leading `@bot_username`), the bot replies immediately with the preset answer—bypassing the AI model, consuming zero model quota, and ignoring quiet mode. Semantically similar phrasings are looked up by the AI during normal chat turns via `group_qa_query` and `group_qa_answer`.

#### 5. Speech Restriction: `/gag`
- **Quotas and inline entry**:
  - Up to `GAG_SESSION_MAX` gag sessions may exist globally (counting starting and ending transitions). A group can hold multiple restricted targets, with at most one active session per target identity.
  - Restricting a regular user posts a public status card in the group plus a private "Speak" button visible only to that user via `ephemeral_message_parameters`. Channel identities receive a public status card with the button attached.
  - Tapping the button opens Telegram Inline Mode prefilled with `GAG_INLINE_QUERY_PREFIX<target_id>` (`gag:<target_id>`). Sent inline messages embed a hidden verification link encoding the target and group ID; on arrival, the bot verifies target ID, group ID, and actual sender, immediately deleting forged or cross-group messages.
- **Dynamic grapheme obfuscation**:
  - Each grapheme cluster is sampled: with probability `GAG_FILL_OPERATION_PROBABILITY`, `GAG_FILLER_MIN_DOTS`..`GAG_FILLER_MAX_DOTS` dots are appended (inserting spaces between dots at probability `GAG_FILLER_GAP_SPACE_PROBABILITY`); otherwise, the grapheme is replaced uniformly from `GAG_REPLACEMENT_CHARACTERS`.
  - Identical operations apply to at most `GAG_MAX_CONSECUTIVE_SAME_OPERATIONS` adjacent graphemes, and short inputs guarantee minimum perturbation counts via `GAG_MIN_OPERATION_TIERS`.
- **Heartbeat and entry refresh**:
  - Every `GAG_SPEAK_NOTICE_MESSAGE_INTERVAL` regular group messages triggers an entry refresh (counted independently per session).
  - Personal entry prompts refresh on `GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS`. If a restricted user stays silent for `GAG_SPEAK_NOTICE_IDLE_INTERVAL_MS`, their next message triggers an immediate replacement prompt.
- **Group teardown**: `/init disable` or losing administrator rights ends all gag sessions in that group and deletes active notices; if the bot has already left the group, session slots are released immediately without attempting message deletions.

#### 6. Target Message Deletion: `/delete_message`
- **Syntax and eligibility**: `/delete_message <target>` starts deletion and `/delete_message stop <target>` stops it (`stop` is case-insensitive). Targets accept a reply, `@username`, numeric user ID, or negative channel ID. Restricted to `SUPER_ADMIN_USER_ID`, and the bot must hold `can_delete_messages` in the group; the bot itself, the current group identity (anonymous admins), and `SUPER_ADMIN_USER_ID` are rejected.
- **Intercept scope**: Deletes only new messages sent in the group after the command takes effect (earlier messages are untouched). Messages carrying `sender_chat` match by channel identity; others match by `from`. Target messages still pass through join verification, ad detection, and flood counting first, and are then claimed so they never reach gag, commands, AI chat, or copy mode.
- **Targeting other bots**: Requires Bot-to-Bot Communication Mode enabled in @BotFather. Deletion-target checks run before the other-bot ingress rate limiter (`BOT_MESSAGE_ACTIVITY_LIMIT`) without incrementing its counter, ensuring every message from a targeted bot is deleted while non-targeted groups still rate-limit that bot normally.
- **Queueing and batch deletion**:
  - Each claimed message enqueues one item into the main-thread in-memory deletion queue (global cap `DELETE_MESSAGE_QUEUE_MAX`).
  - A single consumer loop calls `deleteMessages` through the unified Telegram outbound gate, coalescing back-to-back messages from the same group while a request is in flight into batches of up to `TELEGRAM_DELETE_MESSAGES_BATCH_MAX`.
  - Deletion API errors are logged via the unified Telegram error logger without retries. When the queue is full, new target messages are still claimed (blocking commands/AI/copy) without enqueueing—logging one warning on overflow and one summary of dropped count once the queue drains.
- **Capacity, persistence, and shutdown**:
  - Up to `DELETE_MESSAGE_CHAT_TARGET_MAX` targets per group, persisted in the `deleteMessageTargets` JSONB array of SQLite `chat_states` across restarts; both arming and `stop` reply only after disk persistence succeeds.
  - `stop` removes only the target while keeping already-queued deletions; `/init disable`, bot departure, or losing admin rights clears and persists all targets for that group and drops unsent queue items for that group.
  - Startup refuses to boot if persisted targets include the group itself or `SUPER_ADMIN_USER_ID`.
  - On graceful shutdown, the in-memory queue drains before closing the Telegram outbound gate (dropping any remainder past the shutdown budget with an error log). All command notices auto-delete after `COMMAND_MESSAGE_AUTO_DELETE_MS`.

#### 7. Blacklist: `/block`
- **Syntax**: `/block <target> enable` blacklists a target; `/block <target> disable` unblocks them. Targets accept a reply (including channel-identity posts), `@username`, positive numeric user ID, or—for `disable` only—a bare negative channel ID.
- **Enforcement scope**: Blacklisted IDs are persisted to the authoritative SQLite blocklist and banned across every managed supergroup. Whenever the bot joins a group or gains admin rights, it sweeps and bans any present blocklisted members automatically.
- **Asynchronous cross-group execution**:
  - **`enable`**: After SQLite persistence succeeds, cross-group bans run in the background and post a summary of succeeded vs. failed groups; groups where the bot is confirmed to lack ban privileges are skipped without API calls and counted as failures.
  - **`disable`**: Removes the entry from SQLite first, lifts bans across managed groups in the background (skipping groups lacking ban rights as failures), and posts a completion receipt.
  - **Per-target serialization**: Sequential `/block … enable`, `/block … disable`, and ad-detection disposals targeting the same identity execute strictly in arrival order.
- **Deleted-account pruning**: During sweeps, if Telegram returns `PARTICIPANT_ID_INVALID` for `BLOCKLIST_PARTICIPANT_INVALID_LIMIT` consecutive checks on a target (and no group confirms an active ban), the ID is treated as a deleted account and purged from the SQLite blocklist automatically.

#### 8. Ad Detection and Anti-Raid
- **`/ad_detect` (Smart Ad Detection)**:
  - **Three-stage evaluation pipeline**: Rapid messages from the same sender (`chatId:senderId`) are bundled and drained every `AD_DETECT_QUEUE_TICK_MS` in strict order:
    1. Sticker pack blacklist fast-path (Anti-Raid Worker holds a count mirror and, when non-zero, checks via duplex bridge against the main-thread 768-entry shared LRU cache / SQLite `ad_pack_blacklists`, `kind = 'sticker'`)
    2. Custom emoji pack blacklist (Worker count mirror; when non-zero, resolves custom emoji sets via the main-thread unified Telegram outbound gate and checks them via the same main-thread 768-entry LRU / SQLite `ad_pack_blacklists`, `kind = 'emoji'`)
    3. AI multimodal and text ad classification (`agent.ad_detect` with `samples`): inspects sender-authored text, photos, image documents, stickers, and custom emojis (up to `AD_DETECT_MAX_IMAGES_PER_BUNDLE` images per bundle; supports the Google Decisions API via `use_decision: true` under `provider: "google"`; generative models that explicitly reject vision fall back to text-only)
  - **Punishment, auto-blacklisting, and channel rule**: Any hit deletes the offending messages and applies `punishment` from `ad_detect.json` to non-protected senders—`mute` mutes in the current group (timed or permanent); `kick` removes from the group with no ban, a per-chat ban, or a global permanent blocklist ban matching `/block`. Channel identities have only their messages deleted under every setting except global blocklist ban. A group notice stating the reason and outcome auto-deletes after `COMMAND_MESSAGE_AUTO_DELETE_MS`. When a direct ad verdict attributes offending sticker or custom emoji packs (excluding packs in `stickers.json` and excluding `referencedOnly` warnings), those packs are written into the main-thread 768-entry LRU cache and SQLite `ad_pack_blacklists` via the `"adPackBlacklist"` Disk I/O domain (with no per-kind entry cap) and updated counts sync immediately to the Anti-Raid Worker (if disk flush confirmation fails, entries remain in memory for Disk I/O replay with a warning log; `config/dynamic/ad_detect.json` is never modified at runtime).
  - **Global ad pack blacklist subcommands**: `/ad_detect <sticker|emoji> <list [page]|add [pack...]|remove [pack...]>` is decoupled from the per-group `/ad_detect enable|disable` toggle, checks `isCanControllAdDetectPermission` (always held by `SUPER_ADMIN_USER_ID`), and reads/writes SQLite `ad_pack_blacklists` directly without requiring `ad_detect.json` or `agent.ad_detect` readiness. All replies go through `replyCommandNotice` (auto-deleted in groups after `COMMAND_MESSAGE_AUTO_DELETE_MS` and routed to the triggering forum topic), and every mutation records an `operation` audit entry (`[TelegramCommand] /ad_detect blacklist`):
    - `list [page]`: cold-reads SQLite cursor pages (without polluting the main-thread 768-entry LRU cache) and prints 20 entries per page in ascending ASCII order along with the current total; `page` must be a safe positive decimal integer without leading zeros.
    - `add [pack...]` / `remove [pack...]`: accepts one or more space-separated pack short names, or omits arguments while explicitly replying to a sticker message (`sticker` reads `replied.sticker.set_name`) or a message containing `custom_emoji` entities (`emoji` batches `getCustomEmojiStickers` by `TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS` to resolve `set_name`).
    - **Validation and guardrails**: every target pack must match `STICKER_PACK_NAME_PATTERN` (`1–64` `[A-Za-z0-9_]`; any invalid entry rejects the whole batch) and is deduplicated in order; `sticker add` blocks packs configured in the bot's own `config/dynamic/stickers.json`; no per-kind entry cap is enforced; mutations update the main-thread 768-entry LRU cache and counts, sync updated counts to the Anti-Raid Worker, and await SQLite `"adPackBlacklist"` persistence confirmation.
  - **Proxy link exemption**: Bare proxy node links (`vless://`, `vmess://`, `trojan://`, `ss://`) without recruitment or promotional copy are not flagged as ads.
- **`/flood_control` (Anti-Flood Protection)**: Sending `FLOOD_MESSAGE_LIMIT` messages within a `FLOOD_WINDOW_MS` sliding window in a supergroup triggers an immediate `FLOOD_MUTE_DURATION_MS` mute and an auto-deleted group warning (`COMMAND_MESSAGE_AUTO_DELETE_MS`). Group admins (except bots), channel identities, and identities holding `isCanBypassFloodControl` are exempt.
- **`/antiraid` (Join Verification & Lockdown)**: New members must answer a three-choice arithmetic challenge within `VERIFICATION_TIMEOUT_MS` (wrong answers kick immediately without banning; bot joins require an admin to tap "通过"). Exceeding `ANTI_RAID_PER_MINUTE_LIMIT` joins within `JOIN_WINDOW_MS` activates private lockdown for `LOCKDOWN_MS`. Disabling `/antiraid` cancels pending verifications and deletes active prompts immediately; ad detection, flood control, and blocklists remain unaffected.
- **`/batch_kick` (Mass Kick Recent Joins)**:
  - **Window and exclusions**: Superadmin only. Scans join logs to kick members who joined within the requested window (e.g. `30m`, `2h`, `1d`, bounded by `BATCH_KICK_MIN_DURATION_MS`..`BATCH_KICK_MAX_DURATION_MS`) without adding them to the blocklist; whitelisted and already-blocklisted identities are skipped.
  - **Single-flight background execution**: Sends an immediate acceptance receipt, runs kicks asynchronously (at most one active batch per group), and posts a final summary. If the group undergoes `/init disable` (including disable-then-reenable), bot departure, or loss of admin rights during preflight or execution, the batch aborts silently without posting a summary.

#### 9. Private Chat Relay and Voice Delegation: `/send`
- Superadmins send `/send <group_id>` in private chat with the bot to open a relay session. The target group must have `/init enable` active; after verifying chat reachability, subsequent private messages are forwarded to that group until `/send finish`.
- **Voice delegation**: Send the entire private message as a JSON code block to synthesize and post a voice bubble in the target group:
  ```json
  { "type": "tts", "tone": "gentle", "text": "text to speak" }
  ```
  - `text` is capped at `VOICE_OPERATOR_TEXT_MAX_CHARS` and `tone` at `VOICE_TONE_MAX_CHARS` (measured in UTF-16 code units).
  - Synthesis runs asynchronously in the background and requires a valid `agent.tts` section in `config/dynamic/agent.json`.
  - Calls draw from `agent.tts.daily_reserve_quota` (shared with scheduled `send_voice` tasks and isolated from conversational AI daily quotas).

> [!TIP]
> **`/luck_challenge` is an Inline Mode feature, not a slash command**: Type `@bot_username [wish]` in any chat after enabling Inline Mode in @BotFather to draw a daily fortune. A global sliding-window limiter caps responses at `RATE_LIMIT_MAX_CALLS_PER_WINDOW` per `RATE_LIMIT_WINDOW_MS` (`packages/consts/luckChallenge.ts`), returning a placeholder item when exceeded; if refreshing the daily fortune secret fails, an error is logged and an empty result is returned. Both fallback responses set client caching to `LUCK_INLINE_NO_DRAW_CACHE_SECONDS` seconds.

---

## 💍 Group Marriage: `/wed`

In `/init enable` groups, any member can run `/wed` (no arguments) to draw a fellow member as today's "partner". The bot replies with the chosen member's current avatar captioned `"caller, 你的群友老婆是 member!"` and interactive action buttons. Button labels follow `atmosphere`: teasing (`mesugaki`) renders `移除` / `娶老婆!` / `换一只` (locking to `已确认♡`), whereas restrained (`normal`) renders `移除` / `确认` / `更换` (locking to `已确认`).

| Button | Behavior |
| :--- | :--- |
| **移除** | Deletes the result card and releases the session |
| **娶老婆! / 确认** | Locks in the current draw, changing the middle button to `已确认♡` / `已确认` (rerolling stays available) |
| **换一只 / 更换** | Redraws in place within the same message, excluding the caller and current target and restoring the confirm button |

### Core Mechanics

- **Caller exclusivity**: Only the caller who invoked `/wed` can use the card's buttons, and clicking stale buttons during an in-flight redraw never mutates the new target. Running `/wed` again draws a fresh card and deletes the previous card only after the new one is delivered (keeping the old card if sending fails, or leaving its buttons expired if deleting the old card fails). Each user holds at most one active card per group.
- **Candidate sliding window**:
  - Maintains a per-group in-memory **`Map<number, number>`** (`memberId -> enteredAt`) capped at `WED_MEMBER_LIMIT`.
  - Records only users who speak publicly as **personal accounts** in initialized groups (ignoring channel personas, anonymous admins, and service notices).
  - First-time speakers outside the window are appended at the tail; repeat messages from members already inside the window do not refresh `enteredAt`; full windows evict the earliest entrant; leave events evict the departing ID immediately.
  - At daily maintenance (`DISK_IO_MAINTENANCE_CRON` in the configured timezone), the Disk I/O Worker notifies the main thread to re-verify window members one by one via `getChatMember` spaced by `WED_MEMBER_REVIEW_INTERVAL_MS` (where the bot holds admin rights; non-admin groups rely on leave service messages).
- **Zero-download avatar reuse**:
  - Queries `getChat` and `getUserProfilePhotos` (first `USER_PROFILE_PHOTOS_LIMIT` photos) concurrently and matches the current profile photo via `big_file_unique_id`.
  - When matched, forwards directly using Telegram's existing `PhotoSize.file_id` without local download or upload; otherwise falls back to downloading and re-uploading the current chat photo.
- **Concurrency, persistence, and retention**:
  - All `/wed` commands and button callbacks share a main-thread scheduler capped at `WED_MAX_CONCURRENT` active tasks, `WED_MAX_PENDING` queued tasks (FIFO), and `WED_OPERATION_TIMEOUT_MS` per stage.
  - Candidate windows flush in batches via the Disk I/O Worker to `memory/wed/<chatId>.json` as `{ id, enteredAt }` arrays ordered by entry (see flush conditions in [07 Operations](07-operations.md#data-root)).
  - Each group tracks up to `WED_SESSION_LIMIT` delivered cards (sliding out the oldest idle card—whose photo stays in chat with expired buttons—only after a new card succeeds; failed draws never evict). Total managed groups are bounded by `STATE_MANAGED_CHAT_LIMIT`. Cards never carry fixed `COMMAND_MESSAGE_AUTO_DELETE_MS` timers and are deleted only via `移除`, card replacement, or group teardown.

---

## 🔎 Profiles: `/info`

In `/init enable` groups, any member can inspect an identity's public profile by replying with `/info` or running `/info @username`, `/info <user ID>`, or `/info <channel/group ID>` (supporting users, channels, other bots, and this bot itself).

- **Displayed fields**: Public display name (`first_name last_name` for users, title for channels/groups), username (explicitly noted when unset), copyable numeric ID, and current public avatar (explicitly noted when absent; group chats omit avatars).
- **Live lookup with cache fallback**: Queries Telegram live on each call (`getChatMember` for users, `getChat` for channels/groups, local config for the bot itself), falling back to resolved identity cache metadata if the live request fails, or replying "not found" if neither name nor username is available. Avatar retrieval reuses `/wed` (`file_id` reuse for users, download-and-upload with `t.me` fallback for channels).
- **Retention and execution budget**: Both profile cards and error notices auto-delete after `COMMAND_MESSAGE_AUTO_DELETE_MS`. Tasks run through the shared deferred command executor with a `INFO_TASK_BUDGET_MS` per-task budget (replying "try again later" when full). `/info` is ignored in private chat.

---

<a id="random-images"></a>

## 🖼️ Random Pictures: `/h_image`

**Library path**: Configured in `config/dynamic/assets.json` under `onlyPath.random_h_image_dir` (defaults to `RANDOM_H_IMAGE_DIR` under the runtime data root).

In `/init enable` groups, `/h_image` (no arguments) selects a uniformly random image from the library and sends it to the group.

- **File filtering**: Indexes only regular files in the library root whose extension matches `RANDOM_IMAGE_EXTENSIONS` (`jpg`, `jpeg`, `png`, `webp`), ignoring hidden files, subdirectories, and symlinks. Files exceeding `RANDOM_IMAGE_MAX_BYTES` are skipped and redrawn automatically. Additions and deletions via `/h_image add` or the Mini App gallery update the in-memory index immediately without restarting.
- **Spoiler mask**: Sent photos always enable Telegram's spoiler overlay (`has_spoiler`), requiring a tap to reveal.
- **Message retention**: Delivered photos are kept **permanently**; argument errors, empty-library notices, and failures auto-delete after `COMMAND_MESSAGE_AUTO_DELETE_MS`.
- **Concurrency and rate limiting**:
  - Uses the shared deferred command executor (`DEFERRED_COMMAND_MAX_CONCURRENT` active, `DEFERRED_COMMAND_MAX_PENDING` queued).
  - Shares a global sliding-window limiter with `/h_image add` and usage replies: at most `H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW` calls per `H_IMAGE_RATE_LIMIT_WINDOW_MS` across the instance, silently dropping excess calls.

### Collecting Pictures: `/h_image add`

Users with `isCanAddHImage` can reply to an image message with `/h_image add` to import it into the dedicated library.

- **Supported sources**: Native photos on the replied message (picking the highest resolution) and image documents matching `RANDOM_IMAGE_DOCUMENT_MIME_TYPES` (`image/jpeg`, `image/png`, `image/webp`). If the replied message belongs to a media group (album), all observed images from that album are imported together (up to `MEDIA_GROUP_ITEMS_MAX` per album across `MEDIA_GROUP_CACHE_MAX` cached albums).
- **Content-addressed deduplication**:
  - Saved filenames use the **lowercase SHA-256 hex digest of the raw image bytes** (`RANDOM_IMAGE_CONTENT_NAME_PATTERN`) plus the canonical extension sniffed from magic bytes via `RANDOM_IMAGE_SAVE_EXTENSIONS` (e.g. `<hash>.jpg`).
  - If an identical hash already exists in the library after download, disk writes are skipped and counted as "already exists" in the summary.
- **Dimension and size pre-checks**: Rejects images violating Telegram `sendPhoto` constraints (`width + height > TELEGRAM_PHOTO_MAX_DIMENSION_SUM` or aspect ratio `> TELEGRAM_PHOTO_MAX_ASPECT_RATIO`); files exceeding `RANDOM_IMAGE_MAX_BYTES`, using unsupported formats, or failing download count as failures.
- **Atomic writes**: Writes to a sibling temporary file prefixed with `RANDOM_IMAGE_TEMP_PREFIX` first and atomically `rename`s it into place after verification (dot-prefixed temp files are ignored by random draws).
- **Batched downloads and receipt**: Downloads candidates concurrently in pages of `H_IMAGE_ADD_DOWNLOAD_BATCH_SIZE` under an overall `H_IMAGE_ADD_TASK_BUDGET_MS` budget (marking unfinished items on timeout as failures), then posts a summary receipt (added count, previous library total, duplicates, invalid dimensions, and failures) that auto-deletes after `COMMAND_MESSAGE_AUTO_DELETE_MS`.

---

## ⏰ Scheduled Posts: `cron.json`

Scheduled tasks are configured in `config/dynamic/cron.json` and hot-reloaded at runtime without chat commands. See the [Deployment Configuration Guide](../../config_example/README/en.md#cronjson) for schema details and [08 Images and Scheduled Tasks](08-images-and-cron.md) for practical examples.

- **Target scopes**: Broadcast text, photo albums, documents, synthesized voice bubbles, or AI web digests to an explicit chat list, all enabled chats where the bot can speak, or all enabled chats minus an exclusion list.
- **Images and spoiler control**: Fixed-image tasks accept arrays of public `url`s or local `path`s (up to `CRON_MAX_IMAGES`), sending multiple images as a Telegram album captioned on the first item; random-image tasks draw one image per trigger. `is_blurred` controls whether photos carry a spoiler mask.
- **Scheduled voice (`send_voice`)**: Synthesizes `content` with an optional `tone` prompt into a voice bubble. Requires a valid `agent.tts` block in `agent.json` (validated strictly on startup and hot reload).
- **AI web search digests (`send_web_digest`)**: Searches a concise `topic` and formats up to `max_items` bullet items in MarkdownV2 per `instructions`, preferring `agent.web_search` and falling back to `agent.text`'s built-in search. If the model produces output without invoking search, `WEB_DIGEST_UNSEARCHED_WARNING` is prepended.
- **Retention and topic routing**: Scheduled posts are kept permanently and land in the General topic in forum supergroups. One-shot (`just_once`) tasks and randomized window timers live in memory only; triggers missed while the service is stopped are never replayed on restart.

---

<a id="mini-app-console"></a>

## 🖥️ Mini App Management Console: APIs and Permission Boundaries

When `mini_app` is configured in `config/static/bot.json`, the bot starts a local `Bun.serve` HTTP server (`packages/mini-app-api-server/`, serving the frontend from `packages/mini-app-frontend/`) and attaches `MenuButtonWebApp` (`App`) in the SuperAdmin's private chat. See the [Deployment Configuration Guide](../../config_example/README/en.md#botjson) for field schemas and [10 Mini App Setup and Recommended Configuration](10-mini-app.md) for Cloudflare Tunnel setup.

### 1. Authentication and Security Boundaries
- **Single-page entry and frontend bundle gate (`MINI_APP_REJECT_HTML_PATH` / `MINI_APP_PAGE_GATE_COOKIE_NAME`)**:
  - Enforced by `packages/mini-app-api-server/auth/pageGate.ts` across single-page routes (`/`, `/index.html`, and `${basePath}` aliases) and bundled frontend chunks (`/chunk-*` matching `MINI_APP_BUNDLE_ASSET_ROUTE_PATTERN`).
  - **Unauthorized SPA isolation**: Requests lacking a valid SuperAdmin `initData` header or `MINI_APP_PAGE_GATE_COOKIE_NAME` cookie (`HttpOnly; SameSite=Lax`, 45-minute `MINI_APP_PAGE_GATE_COOKIE_MAX_AGE_SECONDS`), or arriving during a 30-minute password lockout, never receive the SPA bundle—returning standalone `packages/mini-app-api-server/resource/reject.html` (zero external requests; on WebView cold launch it extracts local `initData`, calls `./api/auth/precheck` to obtain the gate cookie, and reloads once).
  - **Frontend chunk protection**: Unauthorized `/chunk-*` requests return `401`/`403` JSON; authorized chunks carry `MINI_APP_BUNDLE_CACHE_CONTROL`, `CDN-Cache-Control: no-store`, and `Vary` (`MINI_APP_BUNDLE_VARY_HEADER_VALUE`).
- **SuperAdmin exclusive, 5-session cap, ephemeral ECDH login, and 256-bit temporary session keys (`SUPER_ADMIN_USER_ID`)**:
  - Every API route runs synchronously through `authorizeMiniAppRequest` (`MiniAppAuthPolicy`): `headerGuard` validates same-origin headers and credential header shape, followed by HMAC-SHA256 verification of Telegram WebApp `initData`, freshness (`MINI_APP_AUTH_MAX_AGE_SECONDS` = 45m, extended to `2 hours + 45 minutes` while an active session exists), and `user.id === SUPER_ADMIN_USER_ID`.
  - All business routes except `GET /api/auth/precheck`, `POST /api/auth/login`, and `POST /api/auth/logout` also require an active 45-minute session token (`X-Mini-App-Session`), with total sliding-renewal lifetime per login capped at `MINI_APP_SESSION_MAX_LIFETIME_MS` (2 hours).
  - **5-session hard cap**: At most `MINI_APP_SESSION_MAX` (`5`) unexpired active sessions and 256-bit temporary session keys (`MINI_APP_SESSION_KEY_BITS`) are cached; when 5 unexpired sessions are active, a valid login still succeeds and evicts the session whose issuance or latest rotation is oldest; the evicted client must log in again on its next request.
  - **Runtime Ed25519 + ephemeral X25519 ECDH login, key secrecy, and sliding renewal**:
    - `startMiniAppServer` generates an in-memory non-extractable `Ed25519` signing keypair per startup and `handlers/page.ts` injects its 32-byte raw public key Base64 when materializing bundled frontend JS chunks. When unauthenticated, `GET /api/auth/precheck` issues an ephemeral `X25519` handshake (`handshakeId`, `serverPublicKey`, `expiresAt`, TTL `MINI_APP_HANDSHAKE_TTL_MS`) signed with that runtime `Ed25519` private key (`GET /api/auth/precheck` is strictly read-only for active sessions and never rotates tokens or issues keys). After signature verification, the client generates an ephemeral `X25519` keypair, derives direction-separated `c2sKey` / `s2cKey` via `ECDH + HKDF-SHA256`, and encrypts `POST /api/auth/login` under `c2sKey`; the server burns `handshakeId` immediately upon consumption/failure and returns `{ sessionToken, sessionKey, expiresAt, ttlMs }` encrypted under `s2cKey` (clients reject plaintext login downgrades). `sessionKey` is issued **only** on `POST /api/auth/login` and sliding renewal of encrypted-response business routes; the client keeps only a non-extractable IndexedDB `CryptoKey` + `sessionStorage` token metadata and never transmits `sessionKey`.
    - Each key epoch uniformly samples a randomized cooldown within `[MINI_APP_SESSION_REFRESH_MIN_MS, MINI_APP_SESSION_REFRESH_MAX_MS]` (5s–5min); once elapsed—or whenever `seenRequestIvs.size` reaches `MINI_APP_SESSION_ROTATE_AT_SEEN_IVS` (`3,072`) first—any encrypted-response business request still inside its 45-minute TTL and 2-hour max lifetime rotates both `sessionToken` and `sessionKey` in place, resets the new epoch's `seenRequestIvs` and re-samples the cooldown, and extends expiry by 45 minutes (`MINI_APP_SESSION_TTL_MS`) via `X-Mini-App-Session`, `X-Mini-App-Session-Expires-At`, and `X-Mini-App-Session-Key` (`<ivBase64>.<cipherBase64>` sealed via AES-256-GCM under the request's matched key with `additionalData = UTF8(newToken)`).
    - Superseded `previousToken` / `previousCryptoKey` remain valid for an independent 5-minute grace window (`MINI_APP_SESSION_PREVIOUS_GRACE_MS`) solely for concurrent in-flight requests and are **immediately invalidated** upon the first committed request authenticated with `newToken` (or revoked on logout, TOTP rotation/deletion, or lockout).
- **AES-256-GCM encrypted transport (`MiniAppEncryptedEnvelope`, binary upload frames, `?e=`), atomic commit, and exemptions**: Session-authenticated business JSON routes wrap request bodies and JSON response bodies in `{ encrypted: true, iv, payload }` (`12`-byte IV, `128`-bit tag; default outer cap `MINI_APP_MAX_ENCRYPTED_JSON_BODY_BYTES` = `64 KiB`, `4 MiB` on `POST /api/configs/save`), and `POST /api/gallery/upload` wraps raw binary image uploads in `[12B IV || ciphertext+16B tag]` frames (`MINI_APP_MAX_UPLOAD_BODY_BYTES`), all bound via `buildMiniAppEnvelopeAad` to `"${method} ${routePath}:req"` / `":res"`; non-`GET`/`HEAD` encrypted routes reject `0`-byte bodies (no-payload writes send encrypted `"{}"`). Every `encryptRequest: true` route encrypts non-empty query strings into `?e=<ivBase64>.<cipherBase64>` (`MINI_APP_ENCRYPTED_QUERY_PARAM`, ciphertext cap `MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH`) allowing only a single `e` parameter with AEAD `additionalData = "${method} ${routePath}"`. Bare `?`, plaintext/duplicate/unauthorized query parameters, empty or `?`-prefixed decrypted queries, invalid envelopes, and replayed IVs return `400 INVALID_ENCRYPTED_PAYLOAD`; reaching `MINI_APP_SESSION_ROTATE_AT_SEEN_IVS` (`3_072`) IVs proactively rotates on encrypted-response routes (resetting `seenRequestIvs` and the refresh cooldown), while exceeding the `MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS` (`4_096`) hard cap in a key epoch returns `401 SESSION_EXPIRED` and revokes the session. Two-phase execution (`authorizeMiniAppRequest` -> async decrypt -> atomic `commitMiniAppSessionAccess`) prevents async-decrypt TOCTOU races and preserves `previousToken` on failed `400` decrypts. Among session-authenticated `/api/*` routes, `encryptResponse: false` (unencrypted binary stream without rotating keys) applies strictly to `GET|HEAD /api/gallery/file` and `GET|HEAD /api/gallery/download`; `/api/auth/{precheck,logout}`, SPA/bundle, `/favicon.ico`, and `/healthz` remain unencrypted, `POST /api/auth/login` uses ephemeral ECDH (`c2sKey`/`s2cKey`), and `POST /api/gallery/upload` encrypts both its binary request frame and its JSON response.
- **First-screen credentials and lockout**: Validates `mini_app.password` until Google Authenticator (TOTP) is bound (`memory/mini-app-totp/totp.json`), after which login requires the current 30-second 6-digit TOTP code (blocking same-step replay after session issuance). Three consecutive failures lock out `SUPER_ADMIN_USER_ID` for 30 minutes, clear all sessions, session keys, pending handshakes, download tickets, and the gate cookie, and send a one-time private-chat alert with unlock time and source IP.
- **Protected gallery previews, dual-path downloads, and static icon cache boundaries**:
  - `GET|HEAD /api/gallery/file` (`MINI_APP_GALLERY_FILE_AUTH_POLICY`): requires SuperAdmin `initData` headers, an active 45-minute `X-Mini-App-Session` header, and encrypted `?e=` query `{ fileName }` (query credentials forbidden); served via `serveGalleryFileResponse` with 7-day `MINI_APP_GALLERY_FILE_CACHE_CONTROL` (`private, no-cache, max-age=604800, must-revalidate`), `CDN-Cache-Control: no-store`, `Cloudflare-CDN-Cache-Control: no-store`, `Vary: MINI_APP_GALLERY_FILE_VARY_HEADER_VALUE` (`X-Telegram-Init-Data, Authorization, X-Mini-App-Session`), `ETag` (`304` `If-None-Match` supporting weak/multi-value tags and `HEAD`), and security headers; the frontend pairs `galleryImageCache.ts` (7-day `CacheStorage` + bounded in-memory `ETag` negotiated cache, immediately evicted on image deletion or `404`) with `fetchMiniAppGalleryImageObjectUrl` / `useGalleryImageUrls` to revalidate via `cache: "no-store"` + `If-None-Match` and materialize `304` hits into in-memory `blob:` URLs.
  - `GET|HEAD /api/gallery/download` (`MINI_APP_GALLERY_DOWNLOAD_AUTH_POLICY`) supports dual auth paths: browser fallback uses auth headers + encrypted `?e=` (`{ fileName }`) + `blob:` save, while Telegram native `WebApp.downloadFile` exchanges encrypted `POST /api/gallery/download-ticket` for a 60-second single-use 64-hex `?ticket=` (`MINI_APP_DOWNLOAD_TICKET_MAX` = 64; `HEAD` does not consume, `GET` consumes immediately, bound to `sessionLineageId` so tickets stay valid across session rotation and are revoked by lineage on logout/lockout/expiry/eviction/IV-cap/TOTP-change/delete). Both stream `no-store` attachments without session tokens in URLs; public `/favicon.ico` keeps `serveCachedAssetResponse` with 7-day `MINI_APP_ASSET_CACHE_CONTROL`.

### 2. HTTP API Routes and Capabilities

| Route | Method | Permission and Boundary Notes |
| :--- | :---: | :--- |
| `/`<br>`/index.html`<br>`/favicon.ico`<br>`/healthz` | `GET`/`HEAD` | `/` and `/index.html` enforce the SuperAdmin gate (serving on-demand materialized SPA HTML when authorized, or standalone `reject.html` when unauthorized/locked out); `/chunk-*` serves gated chunks with private revalidated caching (injecting per-startup `Ed25519` public key into JS chunks with recomputed `ETag`); `/favicon.ico` serves the static icon via `serveCachedAssetResponse` (`MINI_APP_ASSET_CACHE_CONTROL`); `/healthz` returns `{ ok: true }` |
| `/api/auth/precheck`<br>`/api/auth/login`<br>`/api/auth/logout` | `GET`<br>`POST`<br>`POST` | Auth handshake routes verifying `initData` + SuperAdmin ID: `precheck` returns login mode (`password`/`totp`), performs read-only verification for active sessions (no rotation/key issuance), and issues a runtime `Ed25519`-signed ephemeral `X25519` handshake when unauthenticated; `login` decrypts via `ECDH + HKDF-SHA256` (`c2sKey`/`s2cKey`) and directly returns encrypted 45-min `sessionToken` (2h max lifetime) and 256-bit `sessionKey` (evicting the oldest session when 5 are active; `200` sets/refreshes `MINI_APP_PAGE_GATE_COOKIE_NAME`, while rejected prechecks and lockouts clear it); `logout` revokes `X-Mini-App-Session`, its `sessionKey`, and bound download tickets idempotently |
| `/api/totp`<br>`/api/totp/setup`<br>`/api/totp/enable`<br>`/api/totp/delete` | `GET`/`DELETE`<br>`POST` | Queries status, generates a pending secret + QR code, verifies a 6-digit code to enable, or deletes Google Authenticator 2FA; enabling, replacing, or deleting revokes all other active sessions and keys besides the caller's session |
| `/api/status`<br>`/api/mood`<br>`/api/mood/switch` | `GET`<br>`GET`<br>`POST` | Queries live runtime metrics (uptime, CPU load, memory PSS, managed chats, active sessions, AI capability readiness, Telegram outbound gate `inFlight`/`retryWaiting`/`retryQueueMax` = `TELEGRAM_429_RETRY_QUEUE_MAX`) and queries or rerolls the global AI mood |
| `/api/chats`<br>`/api/chats/detail` | `GET` | Lists `/init`-enabled managed chats, or inspects a single chat via encrypted `?e=` query `chatId` (feature flags, hot message count, quiet/lockdown remaining time, `botPermissions`, 1–24h deduplicated join counts `joinedCountsByHour`, and `/batch_kick` state; invalid `chatId` returns `400 INVALID_CHAT_ID`) |
| `/api/chats/messages` | `GET` | Paginates recent messages in the chat's 256-entry in-memory hot buffer via encrypted `?e=` query (`chatId`, optional `page`, `pageSize`; frontend applies keyword filtering on the active page) |
| `/api/chats/feature` | `POST` | Toggles per-chat switches (`init`, `aiChat`, `translation`, `adDetect`, `floodControl`, `antiRaid`, `proxySend`) via encrypted JSON body `{ chatId, feature, enabled }`; disabling `init` runs teardown and purge in `/init disable` order, disabling `antiRaid` returns `ANTI_RAID_DISABLED_TEARDOWN_FAILED` if runtime teardown fails after persisting, and `proxySend` shares single-chat exclusivity with private `/send` |
| `/api/chats/batch-kick` | `POST` | Runs `/batch_kick` for a `1..24`h window in a verified supergroup via encrypted JSON body `{ chatId, hours }` (checks `chatIsSupergroupById` or probes `getChat`; rejects basic groups with `notSupergroup` and probe failures with `unavailable`); shares `batchKickChats`, `batchKickInFlightSeqByChat`, and the background executor with `/batch_kick`, storing completion reports in `miniAppBatchKickCompletedByChat` (cleared on data-purging teardowns, kept on `lostAuthority`) |
| `/api/chats/targets` | `GET`<br>`POST` | `GET` queries via encrypted `?e=` query (`chatId`), `POST` mutates via encrypted JSON body (`{ chatId, action, ... }`) per-chat custom Q&A pairs (`setQa`/`removeQa`), delete-message targets (`addDeleteTarget`/`removeDeleteTarget`), and translate targets (`addTranslateTarget`/`removeTranslateTarget`); manual `target` input on `addDeleteTarget`/`addTranslateTarget` accepts only canonical positive safe integer user IDs or `-100...` negative safe integer channel IDs |
| `/api/identities/whitelist`<br>`/api/identities/permission`<br>`/api/identities/blocklist` | `GET`/`POST`<br>`POST`<br>`GET`/`POST` | Paginates (by `page`/`pageSize` or `afterId`/`limit` cursor) and searches (by name, username, or ID via `query`/`q`) allowlist/blocklist via `readIdentityPolicyEntries` cold reads (overlaying unacked writes without polluting the hot policy LRU and syncing display metadata with `senderIdentity`), adds/removes entries, and updates permissions or grants all (`enableAll`) |
| `/api/picker/prepare`<br>`/api/picker/result` | `POST`<br>`GET` | Calls `savePreparedKeyboardButton` to prepare a native user/channel picker and polls `users_shared`/`chat_shared` imports (`whitelist`, `blocklist`, `deleteMessage`, `translate`; per-chat `deleteMessage` and `translate` verify `/init` first and return `CHAT_NOT_INITIALIZED` otherwise) |
| `/api/configs`<br>`/api/configs/file`<br>`/api/configs/save`<br>`/api/configs/restart` | `GET`<br>`GET`<br>`POST`<br>`POST` | Lists or reads raw UTF-8 text of whitelisted `config/{dynamic,static}/*.json` files (`exists: false` when an optional file is absent); validates session-encrypted `{ scope, fileName, content }` serially via `runSerialChain` against strict schemas and saves atomically (`4 MiB` outer cap, `2 MiB` UTF-8 cap; dynamic configs trigger `fs.watch` hot reload, static configs return `requiresRestart: true`); executes `systemctl restart --no-block copy-ninjia` |
| `/api/ad-blacklists`<br>`/api/ad-blacklists/preview` | `GET`<br>`POST`<br>`GET` | `GET /api/ad-blacklists` cold-reads SQLite `ad_pack_blacklists` cursor pages (overlaying unacked writes without polluting the main-thread 768-entry LRU cache) via encrypted `?e=` query (optional `kind` default `"sticker"`, `page` default `1`, `pageSize` `1..20` default `10`, `query` max `128` chars case-insensitive substring) returning both totals (`400 INVALID_AD_BLACKLIST_PARAMS` on invalid params); `POST /api/ad-blacklists` adds or removes one sticker/custom-emoji pack in the content blacklist via encrypted JSON `{ kind, pack, enabled }` and logs an `operation` audit entry (`[MiniApp] adBlacklists.mutate`); `GET /api/ad-blacklists/preview` calls `getStickerSet` via encrypted `?e=` query (required `kind` and `pack`, optional non-negative `offset` default `0` and `metaOnly` `"0"\|"1"` default `"0"`), slicing by `MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE` (16)—returning metadata + `hasImage` on `metaOnly=1` or inline magic-byte-sniffed `data:image/...;base64,...` thumbnails via 4-way bounded `downloadTelegramFileBytes` on `metaOnly=0` (without writing `operation` logs) |
| `/api/gallery`<br>`/api/gallery/upload`<br>`/api/gallery/delete`<br>`/api/gallery/download-ticket`<br>`/api/gallery/file`<br>`/api/gallery/download` | `GET`<br>`POST`<br>`POST`<br>`POST`<br>`GET`/`HEAD`<br>`GET`/`HEAD` | Paginates the dedicated image library (`GET /api/gallery` with encrypted `?e=`); `upload` accepts session-encrypted `[12B IV \|\| ciphertext+16B tag]` raw binary image frames and returns an encrypted JSON result (enforcing `sessionKey` verification, IV replay protection, and shared magic-byte/SHA-256/dimension checks); `POST /api/gallery/delete` deletes an image via encrypted JSON `{ fileName }` and revokes bound download tickets; `POST /api/gallery/download-ticket` issues 60s single-use `?ticket=` for native `WebApp.downloadFile`; `GET\|HEAD /api/gallery/file` requires auth headers + session + encrypted `?e=` `{ fileName }` (`serveGalleryFileResponse` with 7-day `MINI_APP_GALLERY_FILE_CACHE_CONTROL`, `CDN-Cache-Control: no-store`, `Vary`, and `ETag` `304`); `GET\|HEAD /api/gallery/download` supports browser header + `?e=` or native single-use `?ticket=` attachment streaming (`no-store`) |

### 3. Conflict and Boundary Guards for Lists, Chat Targets, and Config Editing
- **Allowlist and Blocklist Addition Guards (shared by ID input and native picker)**:
  - **Strict mutual exclusivity**: Adding a blocklisted identity to the allowlist returns `IDENTITY_IN_BLOCKLIST`; adding an allowlisted identity to the blocklist returns `IDENTITY_IN_WHITELIST`.
  - **SuperAdmin exemption**: Adding `SUPER_ADMIN_USER_ID` to the allowlist returns `SUPER_ADMIN_EXEMPT`; adding to the blocklist returns `BLOCKLIST_SUPER_ADMIN_FORBIDDEN`.
  - **Self and managed-chat rejection**: Adding the Bot itself (`TARGET_SELF_FORBIDDEN`) or any `/init`-enabled managed group (`TARGET_CURRENT_CHAT_FORBIDDEN`) is rejected.
  - **Duplicate persistence confirmation and cross-chat fan-out**: Duplicate allowlist adds still confirm persistence (`confirmIdentityPolicyPersisted(..., retryUnacknowledged=true)`) and return `{ ok: true, changed: false, duplicate: true }` (`WHITELIST_DUPLICATE`); duplicate blocklist adds confirm persistence (`confirmBlocklistPersisted(..., retryUnacknowledged=true)`) and re-dispatch cross-chat bans across managed admin chats (matching `/block enable`), returning `{ ok: true, changed: false, duplicate: true, persisted, affectedChats, totalChats }` (`BLOCKLIST_DUPLICATE`).
  - **Picker error propagation**: When a native picker import (`handleMiniAppSharedMessage`) adds zero entries and hits non-duplicate rejections, it surfaces the first specific boundary code and rejected ID for targeted UI warnings.
- **Per-Chat QA, Delete-Message, and Translate Target Guards**:
  - **QA pairs (`qa`)**: Non-empty question and answer bounded by `CHAT_QA_QUESTION_MAX_CHARS`, `CHAT_QA_ANSWER_MAX_CHARS`, and `CHAT_QA_MAX_PER_CHAT`; renderable `/command` tokens are rejected in questions and outside `pre` code fences in answers.
  - **Delete-message targets (`deleteMessage`)**: Requires `canDeleteMessages` (`DELETE_TARGET_MISSING_BOT_PERMISSION`); manual `target` validation via `resolveTargetInput` and frontend `isValidChatTargetNumericInput` accepts only canonical positive safe integer user IDs or `-100...` negative safe integer channel IDs (usernames and invalid integers return `TARGET_INVALID`); rejects `SUPER_ADMIN_USER_ID` (`DELETE_TARGET_SUPER_ADMIN_FORBIDDEN`), the Bot itself (`TARGET_SELF_FORBIDDEN`), and the current chat (`TARGET_CURRENT_CHAT_FORBIDDEN`); checks live chat membership when online (`TARGET_NOT_IN_CHAT`); capped at `DELETE_MESSAGE_CHAT_TARGET_MAX`.
  - **Translate targets (`translate`)**: Requires `g-auth.json` readiness and per-chat `isTranslationEnabled` (`TRANSLATE_FEATURE_DISABLED`); manual `target` validation likewise permits only canonical positive safe integer user IDs or `-100...` negative safe integer channel IDs (`TARGET_INVALID` otherwise); accepts `ja`/`cn`/`en`/`uk`/`ru`; rejects the Bot itself and the current chat, checks live user membership when online, and enforces `TRANSLATE_CHAT_USER_LIMIT` (updating target language in place for existing targets).
- **Ad Pack Blacklist and Preview Guards (`/api/ad-blacklists`, `/api/ad-blacklists/preview`)**:
  - `POST /api/ad-blacklists` requires exact `{ kind, pack, enabled }` keys (`kind` in `"sticker" | "emoji"`, otherwise `400 INVALID_AD_BLACKLIST_PARAMS`); trimmed `pack` must match `STICKER_PACK_NAME_PATTERN` (`1–64` `[A-Za-z0-9_]`, otherwise `400 INVALID_AD_BLACKLIST_PACK`).
  - Adding a sticker pack (`kind: "sticker"`, `enabled: true`) rejects packs configured in the bot's own `config/dynamic/stickers.json` (`409 AD_BLACKLIST_BOT_OWN_PACK`); no per-kind entry cap is enforced; failed or unconfirmed SQLite persistence returns `503 AD_BLACKLIST_STORAGE_UNAVAILABLE`; successful and idempotent mutations return `200` (`AD_BLACKLIST_ADDED`, `AD_BLACKLIST_DUPLICATE`, `AD_BLACKLIST_REMOVED`, `AD_BLACKLIST_NOT_FOUND`).
  - `GET /api/ad-blacklists/preview` strictly validates its encrypted query keys (required `kind` and `pack`, optional non-negative safe integer `offset` and `metaOnly` `"0"|"1"`, rejecting unknown/duplicate/out-of-range params with `400 INVALID_AD_BLACKLIST_PARAMS` and invalid packs with `400 INVALID_AD_BLACKLIST_PACK`); Telegram `400 STICKERSET_INVALID` maps to `404 AD_BLACKLIST_PREVIEW_NOT_FOUND` and other fetch failures map to `503 AD_BLACKLIST_PREVIEW_UNAVAILABLE`; prefers 128px static thumbnails (falling back to the static WebP sticker file when no thumbnail exists; animated/video items without thumbnails, items exceeding `MINI_APP_AD_BLACKLIST_PREVIEW_ITEM_MAX_BYTES`, or non-image bytes degrade per item to `null`) while forwarding `request.signal` to abort in-flight downloads.
- **Deployment Configuration Editor Guards (`/api/configs/*`)**:
  - **Strict file allowlists**: Permits only `MINI_APP_DYNAMIC_CONFIG_FILES` (`ad_detect.json`, `agent.json`, `assets.json`, `cron.json`, `mood.json`, `stickers.json`) and `MINI_APP_STATIC_CONFIG_FILES` (`bot.json`, `g-auth.json`) with exact `{ scope, fileName, content }` fields, rejecting all other scopes, names, or extra keys with `400 INVALID_CONFIG_TARGET`.
  - **Schema, cross-file, and atomic-write guards**: Serially under `runSerialChain` and session 256-bit temporary-key encryption, rejects oversized content (`> MINI_APP_MAX_CONFIG_CONTENT_BYTES`), invalid JSON syntax (`400 INVALID_JSON_SYNTAX`), strict parser errors (with `g-auth.json` validated via startup's `parseGoogleServiceAccountKey`), `bot.json` `time_zone` edits when `database/storage.sqlite` exists, `agent.json` ↔ `cron.json` capability mismatches, and symlinks or non-regular targets (`400 CONFIG_VALIDATION_FAILED`). Writes normalized text via `atomicWriteText` (`0o600` for newly created optional files, preserving existing modes) and runs `systemctl restart --no-block copy-ninjia` on `POST /api/configs/restart` (`500 SERVICE_RESTART_FAILED` on failure or timeout).

---

<div align="center">

[← Prev: 08 Images and Scheduled Tasks](08-images-and-cron.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#09-command-and-behavior-reference) · [Next: 10 Mini App Setup →](10-mini-app.md)

</div>
