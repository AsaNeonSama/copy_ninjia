# 08 Image Library and Scheduled Tasks

<p align="center">
  <a href="../cn/08-images-and-cron.md">简体中文</a> · <b>English</b> · <a href="../ja/08-images-and-cron.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="07-operations.md">← Prev: 07 Operations</a> · <a href="09-commands.md">Next: 09 Command Reference →</a>
</p>

---

This guide covers configuring the dedicated image library, collecting and drawing pictures via commands, and scheduling automated delivery of images, albums, voice notes, and AI web digests. For full JSON schemas, see the [Deployment Configuration Guide](../../config_example/README/en.md); for command permissions and runtime rules, see [09 Command Reference](09-commands.md).

## Prepare the Dedicated Library

Configure the library directory in `config/dynamic/assets.json`:

```json
{
  "onlyPath": {
    "random_h_image_dir": "./h_image"
  }
}
```

- **Path format**: Accepts absolute paths or relative paths starting with `./` or `../` (resolved against `RUNTIME_DATA_ROOT`; see [07 Operations](07-operations.md)).
- **Directory permissions**: The service account needs read, write, and traverse (`rwx`) access. A missing directory is created automatically at startup; an existing directory is scanned and validated entry by entry.
- **Naming conventions**: Only regular image files may live in this directory, and every filename must match `RANDOM_IMAGE_CONTENT_NAME_PATTERN` (the lowercase hex SHA-256 digest of the image bytes plus an extension in `RANDOM_IMAGE_EXTENSIONS`). Subdirectories, symlinks, or non-matching filenames abort startup immediately.
- **Dynamic updates and cache behavior**:
  - Uploading via `/h_image add` or the Mini App gallery hashes the image bytes automatically and skips duplicates already present on disk.
  - Adding or deleting compliant files through `/h_image add` or the Mini App gallery updates the in-memory caches immediately with no restart required.
  - Files copied into the directory manually on disk do not enter the in-memory caches until the service restarts (or a hot reload switches `random_h_image_dir` to that path); files deleted manually on disk are detected and evicted from the caches when next drawn or read by the Mini App gallery.

For full path constraints, see [assets.json](../../config_example/README/en.md#assetsjson).

## Collect and Draw Pictures

1. A superadmin runs `/init enable` in the target group.
2. A user with `isCanAddHImage` replies to an image message with `/h_image add` (if the target belongs to a media album, all received images in that album are collected together).
3. The bot replies with a summary receipt listing newly stored files, skipped duplicates, dimension rejections, and download failures.
4. Any group member sends `/h_image` to draw a uniformly random image from the library, delivered behind a Telegram spoiler mask until tapped.

For supported formats, byte/pixel bounds, cooldowns, and `COMMAND_MESSAGE_AUTO_DELETE_MS` notice retention rules, see [Random Pictures](09-commands.md#random-images).

## Schedule Image Delivery

Scheduled tasks live as a top-level array in `config/dynamic/cron.json` and hot-reload at runtime. The example below posts one random library image every day at noon in `Asia/Tokyo`:

```json
[
  {
    "name": "daily-library-image",
    "chat_id": [-1001234567890],
    "cron": "0 12 * * *",
    "time_zone": "Asia/Tokyo",
    "actions": [
      {
        "type": "send_image",
        "payload": {
          "rand_image": true,
          "content": "Daily random picture",
          "is_blurred": true
        }
      }
    ]
  }
]
```

Replace `chat_id` with real target group IDs and adjust the schedule and caption as needed. Every task `name` must be unique across the file, and entries inside `actions` execute sequentially in array order.

### Single Images, Albums, and Random Pictures

Configure image sources inside `send_image.payload`:

| Delivery Mode | Field Combination |
| :--- | :--- |
| **Fixed single image** | `url: ["https://example.com/a.jpg"]` or `path: ["./posters/a.jpg"]` |
| **Fixed album** | Multiple entries in the `url` or `path` array |
| **Dedicated library random picture** | `rand_image: true` with `path` omitted |
| **Custom directory random picture** | `rand_image: true` with a directory string, e.g. `path: "./gallery"` |

- For fixed images, `url` and `path` are mutually exclusive; wrap single items in a 1-element array, and pass multiple items to send a Telegram media group (album).
- In random mode (`rand_image: true`), `path` takes a single directory string, and custom directories do not require SHA-256 filenames (`RANDOM_IMAGE_CONTENT_NAME_PATTERN`).
- `is_blurred` controls whether scheduled images carry a Telegram spoiler mask (defaults to `false`).

### Times and Delivery Targets

- **Cron expressions**: `cron` accepts 5-field cron expressions or standard macros such as `@daily`. `time_zone` takes an IANA zone name and inherits `time_zone` from `config/static/bot.json` when omitted (default `DEFAULT_BOT_TIME_ZONE`).
- **Randomized intervals**: `rand_cron` schedules randomized intervals within `[CRON_RANDOM_INTERVAL_MIN_MS, CRON_RANDOM_INTERVAL_MAX_MS]` (for example `"6h-12h"`). The first run follows `cron`; after each completion, the next trigger is sampled uniformly from the range and rounded up to whole minutes. `just_once: true` runs once per process lifetime and is mutually exclusive with `rand_cron`.
- **Target groups**: `chat_id` accepts explicit numeric group IDs, `["all"]` (`CRON_ALL_CHATS`) for every initialized group where the bot can post, or `["except", -1001234567890]` (`CRON_EXCEPT_CHATS`) to broadcast to all initialized groups except the listed IDs.

## Scheduled Voice and Other Actions

Configure `agent.tts` in `config/dynamic/agent.json` first, then add a `send_voice` action to `actions`:

```json
{
  "type": "send_voice",
  "payload": {
    "content": "Good night, see you tomorrow",
    "tone": "Speak softly"
  }
}
```

- **Voice synthesis reuse**: Uses `agent.tts.voice` with optional `tone` guidance. When a single task delivers a voice note to multiple groups, audio is synthesized once per run without consuming extra TTS quota; after the first successful send returns a Telegram `file_id`, subsequent groups in that run reuse that `file_id` directly instead of re-uploading the audio bytes. See [agent.json](../../config_example/README/en.md#agentjson) for full TTS options.
- **Additional action types**: Tasks also support plain text (`send_message`), file attachments (`send_file`), and AI-summarized web digests (`send_web_digest`). See [cron.json](../../config_example/README/en.md#cronjson) for payload schemas, capability dependencies, and length caps.

## Verify and Update at Runtime

- **Preflight check**: Confirm library directory permissions, verify `/init enable` has been run in target groups, and check bot send permissions before testing `/h_image add` and `/h_image`.
- **Schedule verification**: Inspect startup/reload logs to verify resolved time zones and next-fire timestamps, then confirm delivery in the target groups.
- **Live hot-reloading**: Editing `assets.json`, `cron.json`, or `agent.json` reloads live without restarting. Tasks are reconciled by `name`: unchanged tasks keep their active timers, while added or modified tasks recompute their next run. For startup validation, forum-topic routing, and shutdown drains, see [04 Runtime Invariants](04-invariants.md); for legacy library filename migrations, see [07 Operations](07-operations.md).

---

<div align="center">

[← Prev: 07 Operations](07-operations.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#08-image-library-and-scheduled-tasks) · [Next: 09 Command Reference →](09-commands.md)

</div>
