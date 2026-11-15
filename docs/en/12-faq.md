# 12 FAQ

<p align="center">
  <a href="../cn/12-faq.md">简体中文</a> · <b>English</b> · <a href="../ja/12-faq.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="11-performance.md">← Prev: 11 Performance Benchmark</a> · <b>Next: None →</b>
</p>

---

If the bot process is running but does not respond as expected in chat, work through the checklist below. For required BotFather settings and group administrator permissions per feature, see the [project README](../../README.md#botfather-setup).

## The Bot Is Running, Why Is There No Reply?

<table width="100%">
<thead>
  <tr>
    <th width="28%" align="left">Symptom</th>
    <th width="72%" align="left">What to Check</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>❌ <b>No response in the group</b></nobr></td>
    <td>
      • <b>Group not initialized</b>: The superadmin has not run <code>/init enable</code> in this group yet.<br>
      • <b>Group Privacy blocking updates</b>: The bot is not a group admin and Group Privacy is still enabled in @BotFather (<code>/setprivacy → Disable</code>). <i>Note: After toggling Group Privacy in BotFather, remove and re-add the bot to the group so Telegram applies the change.</i>
    </td>
  </tr>
  <tr>
    <td><nobr>🤖 <b>AI stays silent</b></nobr></td>
    <td>
      • <b>Switch off</b>: Run <code>/ai_chat enable</code> in the group (disabled by default).<br>
      • <b>Incomplete AI config</b>: Requires valid <code>text</code>, <code>summary</code>, and <code>media</code> in <code>agent.json</code> plus valid <code>stickers.json</code> and <code>mood.json</code>; missing any one disables AI chat.<br>
      • <b>Trigger probability</b>: Only direct replies to the bot or <code>@bot_username</code> mentions guarantee a trigger; ordinary group messages trigger probabilistically (and never interject during <code>/quiet</code>).<br>
      • <b>Copy mode active</b>: Active <code>/copy</code> repetition in the group pauses AI chat and autonomous interjections.<br>
      • <b>Rate limits &amp; <code>abuse_mark</code> cooldown</b>: Rapid triggers hit sliding-window limits (<code>RATE_LIMIT_LONG_WINDOW_MS</code>, <code>RATE_LIMIT_LONG_MAX_TRIGGERS</code>); users flagged via <code>abuse_mark</code> for repeated policy-violating prompts or abusive behavior (scolding, humiliation, etc.) are ignored by AI chat for <code>ABUSE_MARK_DURATION_MS</code>.
    </td>
  </tr>
  <tr>
    <td><nobr>📨 <b>No reply in private chat</b></nobr></td>
    <td>
      • Private chat responds <b>only to superadmin <code>/send</code> relay commands</b> (and mounts the bottom-left <code>App</code> button when <code>mini_app</code> is configured); all other private messages and commands are ignored.
    </td>
  </tr>
  <tr>
    <td><nobr>⏱️ <b>Notices vanish automatically</b></nobr></td>
    <td>
      • <b>Expected behavior</b>: Validation errors, permission denials, usage hints, and command receipts auto-delete after <code>COMMAND_MESSAGE_AUTO_DELETE_MS</code> to keep chats clean (see retained exceptions in <a href="09-commands.md#parameter-and-target-resolution-rules">09 Command Reference</a>).
    </td>
  </tr>
  <tr>
    <td><nobr>🎲 <b><code>@Bot</code> fortune prompt does not appear</b></nobr></td>
    <td>
      • Inline Mode has not been enabled in @BotFather (send <code>/setinline</code>).
    </td>
  </tr>
  <tr>
    <td><nobr>🫧 <b>Action commands (e.g. <code>/咬</code>) get no reply</b></nobr></td>
    <td>
      • Only Chinese action words matching <code>CJK_ACTION_COMMAND_PATTERN</code> are recognized, and a global sliding window caps execution at <code>CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW</code> per <code>CJK_ACTION_RATE_LIMIT_WINDOW_MS</code> (excess calls are dropped silently).
    </td>
  </tr>
  <tr>
    <td><nobr>🌐 <b>Cannot translate another bot's messages</b></nobr></td>
    <td>
      • Enable <b>Bot-to-Bot Communication Mode</b> for this bot in @BotFather.<br>
      • Other-bot messages pass through a global ingress limiter: a bot exceeding <code>BOT_MESSAGE_ACTIVITY_LIMIT</code> messages is ignored until <code>BOT_MESSAGE_ACTIVITY_TTL_MS</code> of silence elapses, and new bots are ignored once <code>BOT_MESSAGE_ACTIVITY_MAX_ENTRIES</code> bots are tracked—except <code>/delete_message</code> targets in that group, whose messages bypass counting so every one is deleted (see <a href="04-invariants.md">04 Runtime Invariants</a>).<br>
      • Translation processes text and captions only; captionless media, digits/punctuation-only messages, and messages already in the target language are skipped.
    </td>
  </tr>
  <tr>
    <td><nobr>🛡️ <b>Anti-Raid / Ads / Flood inactive</b></nobr></td>
    <td>
      • <b>Disabled by default</b>: Run <code>/antiraid enable</code>, <code>/ad_detect enable</code>, or <code>/flood_control enable</code> in the group.<br>
      • <b>Missing admin rights</b>: Grant the bot group administrator rights with "Delete messages" and "Ban users".<br>
      • <b>Ad detection config missing</b>: Requires both <code>agent.ad_detect</code> in <code>config/dynamic/agent.json</code> and a valid <code>config/dynamic/ad_detect.json</code>.
    </td>
  </tr>
  <tr>
    <td><nobr>💀 <b>Process dead, menu missing</b></nobr></td>
    <td>
      • <b>Check systemd status</b>: Run <code>systemctl status &lt;service&gt;</code> to verify the process is active.<br>
      • <b>Inspect fail-fast logs</b>: Check <code>logs/&lt;date&gt;.json</code> under the data root—invalid configuration or state exits non-zero at startup with the exact offending file and field path.<br>
      • <b>Token conflict (HTTP 409)</b>: Status 409 means another instance is polling the same Bot Token or a stale Webhook is still set (see <a href="07-operations.md#startup-failures">07 Operations</a>).
    </td>
  </tr>
</tbody>
</table>

---

## How Do I Change the Notice Atmosphere?

- **Explicit setting**: Set `atmosphere` in `config/static/bot.json` to `"mesugaki"` (teasing) or `"normal"` (restrained) and restart the service. An explicit value always takes precedence.
- **Default selection**: When `atmosphere` is omitted, the presence of a custom `prompt/persona.md` selects `"normal"`, whereas using the built-in persona selects `DEFAULT_BOT_ATMOSPHERE` (`"mesugaki"`).
- **What it controls**: `atmosphere` changes command notices, permission descriptions in chat, menu descriptions, cron announcements, button labels, and inline fortunes. It does not change the AI chat persona prompt or the Mini App console UI (which always uses the teasing tone).

---

## Why Does the Image Library Refuse Startup or Miss Duplicates?

- **Strict content-addressed filenames**: The dedicated library directory (`onlyPath.random_h_image_dir` in `assets.json`) **must contain regular image files only**, named strictly after each file's lowercase SHA-256 hex digest (`RANDOM_IMAGE_CONTENT_NAME_PATTERN`) with an allowed extension (`RANDOM_IMAGE_EXTENSIONS`: `.jpg`, `.jpeg`, `.png`, `.webp`).
- **Fail-fast startup check**: Any subdirectory, symlink, dotfile/temp file, or non-hash filename causes startup validation to exit immediately. Stop the service, back up the directory, and clean or rename files per [07 Operations](07-operations.md).
- **How deduplication works**: `/h_image add` (and Mini App gallery uploads) compute the SHA-256 digest of the downloaded bytes and skip writing when that hash already exists in the library. Files copied into the folder manually are deduplicated only if their filenames match their lowercase SHA-256 hash.

---

## Why Does a Scheduled Task Send Again After Restart?

- **One-shot tasks (`just_once`)**: Completion markers live in memory only (capped at `CRON_JUST_ONCE_RECORD_MAX`), so a restart reloads and schedules them again. Delete completed `just_once` entries from `config/dynamic/cron.json`.
- **Randomized windows (`rand_cron`)**: A restart picks a fresh random trigger time inside the configured window; triggers missed while stopped are never backfilled.
- **Array paths and relative resolution**: Fixed-image `url` or `path` fields must be arrays (see the [Deployment Configuration Guide](../../config_example/README/en.md#cronjson)), and relative paths in `cron.json` resolve against the runtime data root without needing `./`.

---

## Why Is Scheduled Voice or `/send` Voice Not Sending?

Both scheduled `send_voice` tasks and superadmin `/send` TTS relays require `agent.tts` in `config/dynamic/agent.json` and synthesize audio asynchronously inside the AI Worker:

### Key Log Troubleshooting

<table width="100%">
<thead>
  <tr>
    <th width="35%" align="left">Log Signature</th>
    <th width="65%" align="left">Cause &amp; Fix</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><code>speech synthesis failed: worker unavailable</code></td>
    <td>The AI Worker is not ready—verify that <code>stickers.json</code>, <code>mood.json</code>, and <code>agent.json</code> all load cleanly.</td>
  </tr>
  <tr>
    <td><code>tts unsupported</code></td>
    <td>The configured provider does not support TTS (only <code>google</code> and <code>openai</code> are supported).</td>
  </tr>
  <tr>
    <td><code>synthesis failed</code> / <code>timed out</code></td>
    <td>Upstream API error or timeout; OpenAI-compatible endpoints must support <code>audio/speech</code> with <code>opus</code> output.</td>
  </tr>
  <tr>
    <td><code>not an Ogg Opus stream</code> / <code>not an MP3 stream</code></td>
    <td>The upstream response stream does not match the audio container expected by the configured speech protocol.</td>
  </tr>
  <tr>
    <td><code>daily limit reached</code></td>
    <td>The TTS quota for the active <code>TTS_USAGE_WINDOW_MS</code> window is exhausted and resets automatically once the window expires.</td>
  </tr>
</tbody>
</table>

### Quota and Allocation Mechanics

- Superadmin `/send` and `cron.json` `send_voice` tasks share a dedicated **`daily_reserve_quota`** (`reserveCount` in global state).
- Group AI chat uses the remaining **`daily_limit - daily_reserve_quota`** (`agentCount`).
- The two pools are strictly isolated. A counting window starts on its first request; once `TTS_USAGE_WINDOW_MS` elapses, the next request opens a fresh window and resets both counters to zero.

### Private Chat `/send` Format Requirements

To synthesize a voice bubble during a `/send` session, **send the entire private message as a single JSON code block** with `"type": "tts"`:
```json
{ "type": "tts", "tone": "tsundere", "text": "line to synthesize" }
```
Payloads are parsed as JSONC (comments and trailing commas allowed). If parsing fails or `type !== "tts"`, the raw message is forwarded as normal text; if `type === "tts"` has invalid fields, the bot replies with a format hint in private chat without posting to the target group.

---

## How Are Voice Length, Temperature, and Memory Configured?

| Entry Point | Text Limit (UTF-16) | Recorded in AI Context Memory |
| :--- | :---: | :--- |
| **AI `send_voice` Tool** | `VOICE_TEXT_MAX_CHARS` | Yes |
| **Private `/send` TTS** | `VOICE_OPERATOR_TEXT_MAX_CHARS` | No |
| **Scheduled `send_voice`** | `VOICE_OPERATOR_TEXT_MAX_CHARS` | No |

- **Tone and size limits**: `tone` is capped at `VOICE_TONE_MAX_CHARS` (UTF-16 code units after whitespace normalization), and synthesized audio bytes are capped at `VOICE_SPEECH_MAX_BYTES`.
- **Voice and base style**:
  - `agent.tts.voice` selects the speaker voice.
  - Optional `agent.tts.style` sets the base vocal style (hot-reloadable; defaults to `TTS_DEFAULT_STYLE`).
  - Style prompts are assembled as `<base style>; 细节: <tone>`, with AI replies inserting spoken-language guidance in between.
  - `speech_protocol: "xai"` does not support `style` or `tone` prompts.
- **Spoken language for AI replies (`bot_language`)**:
  - Optional `agent.tts.bot_language` (`TTS_BOT_LANGUAGES`: `en`, `zh`, or `ja`; defaults to `TTS_DEFAULT_BOT_LANGUAGE`, hot-reloaded on the next reply) controls the spoken language of AI `send_voice` calls.
  - It switches `send_voice` and `send_message` tool descriptions, updates system-prompt voice deduplication rules, and injects spoken-language guidance into AI TTS prompts (`<base style>; <language rule>; 细节: <tone>` from `VOICE_LANGUAGE_PROMPTS`).
  - It does not rewrite `style` or affect `/send` and `cron.json` voice tasks; for `speech_protocol: "xai"`, output language is controlled by `language`.
- **Recommended checklist when switching `bot_language`**:
  - Rewrite `style` in the target language to describe vocal timbre only (default `TTS_DEFAULT_STYLE` is written in Japanese). Because `style` is shared with `/send` and cron tasks, put any task-specific language hints inside each task's `tone` instead; if pronunciation still sounds off, switch `voice` to one tuned for that language.
  - If you use a custom `prompt/voice_tool.md`, update its examples and tone notes to match the target language and restart the service.
  - On `speech_protocol: "xai"`, update `language` directly.
- **Customizing `send_voice` tool instructions**: Creating a non-empty UTF-8 `prompt/voice_tool.md` at the project root replaces `send_voice`'s tool description on restart (independent of `bot_language`, while `text`/`tone` parameter descriptions and deduplication rules still follow `bot_language`; no hot reload).
- **Sampling temperature**: Gemini TTS temperature is fixed by `GEMINI_SPEECH_TEMPERATURE`.

---

## How Do I Call Google Models via Third-Party Gateways (e.g., Cloudflare AI Gateway)?

1. **Set the gateway endpoint**: Replace `base_url` on the Google capability (or enter it in the `install.sh` wizard):
   `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/google-ai-studio`
2. **Configure `api_key`**:
   - **Direct Google key**: Put your Google AI Studio key in `api_key` (sent as `x-goog-api-key`). Because no extra gateway auth header is sent, disable Authenticated Gateway on Cloudflare.
   - **Gateway-stored key (BYOK / Unified Billing)**: Put your Cloudflare token in `api_key` instead. `api_key` is automatically redacted from logs.
3. **Verify routing**: Text, vision, and image generation call `generateContent`, while TTS calls the `Interactions API`. Test end-to-end by sending a `/send` TTS block in private chat.

---

## How Do I Call Anthropic Models via Cloudflare AI Gateway?

Set `base_url` on `provider: "anthropic"` capabilities (`text`, `summary`, `media`, `web_search`, `ad_detect`)—either in `agent.json` or during `install.sh`:
`https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`

1. **Bring your own Anthropic key**: Set `api_key` to your Anthropic API key (sent as `Authorization: Bearer`). Because no extra headers are attached, disable Authenticated Gateway on Cloudflare.
2. **Gateway-stored key (BYOK / Unified Billing)**: Set `api_key` directly to your Cloudflare token `<CF_AIG_TOKEN>`. Cloudflare detects the token in `Authorization` and substitutes your stored Anthropic key or Unified Billing (leaving a placeholder string in `api_key` forwards it to Anthropic and fails with `401`).

---

<div align="center">

[← Prev: 11 Performance Benchmark](11-performance.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#12-faq) · **Next: None →**

</div>
