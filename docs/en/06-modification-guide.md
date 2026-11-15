# 06 Common Modification Recipes

<p align="center">
  <a href="../cn/06-modification-guide.md">简体中文</a> · <b>English</b> · <a href="../ja/06-modification-guide.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="05-dev-workflow.md">← Prev: 05 Dev Workflow</a> · <a href="07-operations.md">Next: 07 Operations →</a>
</p>

---

This guide covers common modification scenarios, listing the exact files to touch and the standard implementation steps.

> [!IMPORTANT]
> **Universal Development Rules**:
> - Read [`AGENTS.md`](../../AGENTS.md) first to understand repository conventions and operational boundaries.
> - Back up live files externally before modifying production configs, runtime state, or executing entry points that touch live deployment paths. Ordinary source edits and tests backed by isolated temp roots do not require deployment backups.
> - Run `bun run lint && bun run typecheck` (or the full `bun run check`) before committing; `bun run check` must pass before merging into `master`. Update docs, READMEs, and metrics only when explicitly requested.

---

## Adding a Concurrent Batch

When coordinating concurrent async tasks, follow these reliability rules:

- **Never swallow errors silently**: Use `Promise.allSettled` for fixed, independent async operations. Inspect and handle every `rejected` entry explicitly; never hide failures with empty `catch` blocks or ignored settlement results.
- **Bound dynamic batches**: When input cardinality comes from external data, never fire unbounded `Promise.all(list.map(...))` calls. Use [`runBoundedSettledBatch`](../../packages/libs/boundedSettledBatch.ts) with an explicit concurrency cap and attribute failures via the returned `item` or `index`.
- **Keep retries at a single layer**: `runBoundedSettledBatch` executes each item once without retrying. Add bounded backoff only inside the owning domain layer when transient errors (such as brief network drops) can be distinguished reliably; never nest retries across layers or retry non-idempotent side effects.
- **Task draining**: Waiting on a snapshot of in-flight tasks during shutdown or teardown needs no extra worker pool when each task isolates its own errors and spawns no further work.

---

## Adding a Slash Command

To implement a standard slash command (for example `/my_cmd`), follow this sequence:

1. **Implement the command handler**:
   - Create a module under `packages/commands/` exporting an explicitly typed `handleXxxCommand`.
   - **Permission checks**: Gate feature-scoped commands with `rejectUnlessPermitted(ctx, key, rejection)` and superadmin-only commands with `rejectUnlessSuperAdmin(ctx, rejection)` (see `commands/commandActor.ts`).
   - **Atmosphere copy**: Define reply copy in matching domain modules under `packages/consts/atmosphere/{teasing,plain}/` implementing a shared interface, and read the active copy on the main thread via `chatAtmosphere()`.
   - **Command replies**: Send plain-text replies to the triggering message (usage, permission denials, failures, and receipts) via `replyCommandNotice(ctx, text)` (`infra/telegram/commandMessages.ts`), which inherits auto-deletion (`COMMAND_MESSAGE_AUTO_DELETE_MS` in `packages/consts/commands.ts`) and forum-topic propagation from `sendCommandMessage`. Call `sendCommandMessage` directly when formatting, long-term retention, or out-of-update sending is needed.
2. **Export the handler**: Re-export `handleXxxCommand` from `packages/commands/index.ts`.
3. **Register the route**:
   - Register `commands.command("xxx", ...)` on the `commands` sub-Composer in [`packages/app/registerHandlers.ts`](../../packages/app/registerHandlers.ts).
   - **Never attach commands directly to root `bot`**: Mounting behind the `:entities:bot_command` gateway places the command downstream of the `/init` gate, private-chat filter, identity prefetch, join verification, gag enforcement, and `/qa` form capture.
4. **Configure private-chat access**: If the command is allowed in DMs, add it to the allowlist in [`packages/infra/updateGate.ts`](../../packages/infra/updateGate.ts) (private chats allow only `/send` by default). Group-only commands need no change here.
5. **Update the command menu**: Add the command entry to `BOT_COMMANDS` in both `packages/consts/atmosphere/{teasing,plain}/commands.ts` files.
6. **Extract constants**: Place cooldowns, limits, and thresholds in `packages/consts/commands.ts` or `packages/consts/<domain>.ts` with Chinese JSDoc comments.
7. **Add unit tests**: Cover permission rejection, argument validation edge cases, and happy-path execution in `test/commands/xxx.test.ts`.
8. **Sync command docs**: Document the command and its required permission in `docs/{cn,en,ja}/09-commands.md`.

### Non-ASCII Command Names

Telegram generates `bot_command` entities only for ASCII command names. CJK action commands (such as `/咬` or `/贴贴`, matched by `CJK_ACTION_COMMAND_PATTERN`) use the dedicated pipeline in [`cjkAction.ts`](../../packages/commands/cjkAction.ts):

- **Match raw text via `bot.hears`**: Register `hears(regex, ...)` on the `cjkActions` child Composer (`^\/` prefix; see `CJK_ACTION_COMMAND_PATTERN`) ahead of ordinary group-message fallbacks.
- **Resolve targets or pass through**: Pass candidates to `resolveCommandTarget`; when text does not match valid action syntax, call `next()` explicitly rather than consuming the update.
- **Text messages only**: Handle only `message.text`; media messages with captions must call `next()` immediately to return to standard media/message handling.
- **Run prerequisite checks explicitly**: Call `isBotOwnMessage`, `needsBotOwnMessageWait`, and `waitForBotOwnMessage` for bot-authored messages, and refresh sender cache state via `updateCachedIdentity`.
- **Retention vs. auto-deletion**: Successful action results stay permanently in the group by passing `preserveInGroup: true` and the triggering `messageThreadId` to `sendCommandMessage`; target-validation errors and `/x` usage hints auto-delete after `COMMAND_MESSAGE_AUTO_DELETE_MS`.
- **ASCII menu placeholder**: Because Telegram command menus accept only ASCII names, expose `/x` in `BOT_COMMANDS` and wire `handleCjkActionUsageCommand` to reply with usage examples.
- **Sliding-window rate limit**: Throttle global instance-wide frequency with `libs/slidingWindowRateLimit.ts` using `CJK_ACTION_RATE_LIMIT_WINDOW_MS` and `CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW`.

---

## Adding Links or Formatting to a Reply

Telegram rich-text outbound formatting supports two mutually exclusive modes (`SendMessageFormat` in [`packages/infra/telegram/actions/messages.ts`](../../packages/infra/telegram/actions/messages.ts)):

- **MarkdownV2 mode (recommended for static/templated messages)**:
  - Pass `parseMode: MARKDOWN_V2_PARSE_MODE` to `sendMessage` or `sendCommandMessage`.
  - Construct **every piece** of the body through [`libs/telegramMarkdown.ts`](../../packages/libs/telegramMarkdown.ts): escape plain text via `escapeMarkdownV2` and build bold spans, code blocks, or links with the dedicated helpers.
  - Never interpolate unescaped display names or model output into templates. Markdown parse errors surface as send failures and never fall back silently to unescaped plain text.
  - Validate rendered strings in unit tests using the reference parser in `test/helpers/markdownV2.ts`.
- **Entities mode (for exact offset highlighting)**:
  - Assemble plain text manually and compute UTF-16 code-unit `offset` and `length` values for each entity.
  - Surrogate pairs (such as astral emojis) occupy 2 UTF-16 code units, and zero-length entities are rejected by Telegram.

---

## Switching Languages: No i18n Here — Fork It

All user-facing bot copy and prompts are written in Simplified Chinese, with two built-in tones under `packages/consts/atmosphere/`: `teasing` and `plain`. The Mini App console is separate: its trilingual UI dictionary (`packages/mini-app-frontend/i18n/`) always uses the teasing persona and does not switch with `atmosphere`.

- Fixed strings and formatters live in atmosphere dictionaries, and Telegram entity offsets are computed against final rendered strings.
- CJK action triggers and templates (such as `/咬`) are stored separately from slash-command copy.
- The AI persona defaults to `packages/consts/aiChat/prompts/persona.ts`; placing `prompt/persona.md` in the project root overrides it on restart.
- The `send_voice` tool description defaults to `VOICE_LANGUAGE_PROMPTS` in `packages/consts/aiChat/prompts/tools.ts` keyed by `agent.tts.bot_language`; placing `prompt/voice_tool.md` in the project root overrides the body description.
- Runtime multi-language switching is out of scope by design. To localize bot replies into another language, fork the repository and replace the constants and prompt files directly.

---

## Adjusting Behavioral Parameters

Operational parameters live under `packages/consts/`, so tuning behavior rarely requires changing business logic:

| What to Tune | Target File |
| :--- | :--- |
| AI trigger probability, rate limits, concurrency slots, queue depth | `packages/consts/aiChat/rateLimit.ts` |
| AI context memory caps, snapshot cadence, summary backpressure | `packages/consts/aiChat/memory.ts` |
| Media description length, vision concurrency slots, LRU cache size | `packages/consts/aiChat/media.ts` |
| Image generation cooldowns, byte ceilings, reference-image cap | `packages/consts/aiChat/imageGeneration.ts` |
| Mood decay cadence and toggle cooldowns | `packages/consts/aiChat/mood.ts` |
| Per-turn tool caps, typing simulation, typo probabilities | `packages/consts/aiChat/tools.ts` |
| Voice transcription duration/byte ceilings and placeholder copy | `packages/consts/aiChat/voice.ts` |
| Voice synthesis per-turn cap, line/tone length limits, daily quota | `packages/consts/aiChat/voiceMessage.ts` |
| Provider request timeouts, retries, temperature, safety settings | `packages/consts/aiChat/gemini.ts`, `openai.ts`, `anthropic.ts` |
| **Model names, provider selection, API keys, endpoints** | **Not code constants**: configure per capability in `config/dynamic/agent.json` |
| OpenAI-compatible image wire protocol and output dimensions | `config/dynamic/agent.json` (`agent.image.image_protocol`) |
| Reference images sent per generation call | `config/dynamic/agent.json` (`agent.image.max_reference_images`) |
| Join verification window, spam thresholds, mute escalation | `packages/consts/antiRaid/` |
| Repeat cooldowns, `/quiet` duration bounds, CJK action rate limits | `packages/consts/commands.ts` |
| Per-speaker cooldowns for autonomous random replies | `packages/consts/auto.ts` |

**Update workflow**: Edit the constant → update its Chinese JSDoc → run `bun run lint && bun run typecheck` (and update README figures only if requested) → pass `bun run check` before merging.

> [!WARNING]
> **Capacity Constants Coupled to Persisted Snapshots**:
> Before lowering capacity constants backed by stored records (such as `AI_MEMORY_HYDRATE_BUFFER_MAX` or `MAX_SUMMARY_ROUNDS`), stop the service and trim existing snapshots in SQLite transactions per [04 Invariants](04-invariants.md#persistence). Startup validation rejects persisted records that exceed the active bounds.

---

## Adding an Optional Provider Capability

Model capabilities are factored into narrow single-responsibility interfaces (`AiTextProvider`, `AiSummaryProvider`, `AiMediaProvider`, `AiImageProvider`, `AiSpeechProvider`, `AiWebSearchProvider`, `AiStructuredTextProvider`) composed into `AiChatProvider`:

1. **Declare the contract**: Add the optional method on its capability interface in [`packages/types/aiChat/provider.ts`](../../packages/types/aiChat/provider.ts) with an explicit `this: void` receiver.
2. **Implement per provider**: Implement and export the capability only in providers that support it; unsupported providers leave the property `undefined`.
3. **Branch on capability presence**: Check `if (provider.someCapability) ...` at call sites—never hardcode vendor names such as `provider.name === "gemini"`.
4. **Define fallback behavior**:
   - Degradable capabilities (such as vision or speech transcription) substitute a text placeholder and log a diagnostic without crossing over to another vendor mid-turn.
   - Non-degradable capabilities (such as unconfigured TTS synthesis) omit the tool from the turn's toolset altogether.
5. **Assemble toolsets per turn**: Build the model toolset dynamically at the start of each turn, omitting both the schema declaration and executor whenever the capability or config is absent.

---

## Adding an AI Tool

1. **Declare the tool name**: Add the constant in [`packages/consts/tools.ts`](../../packages/consts/tools.ts), and add tools with visible group side effects (sending messages, images, stickers, reactions, or voice) to `ACTION_TOOL_NAMES`.
2. **Define the schema**: Register read-only query tools in `TOOL_DECLARATIONS`; for reply action tools, add a definition builder under `packages/aiChat/ai/tools/replyToolset/`. Vendor adapters convert neutral `AiToolDefinition` schemas into OpenAI, Gemini, and Anthropic formats.
3. **Implement execution**: Place the tool logic under `packages/aiChat/ai/tools/`, delegating any Telegram API calls to the main thread over Worker IPC.
4. **Wire dispatch**: Connect query tools to `callTool` in `tools/index.ts`, and connect reply action tools to the assembler and `execute` dispatcher in `replyToolset/orchestrator.ts`.
5. **Enforce action budgets**: Count visible side-effect tools against the per-reply action budget (hard-capped at execution time by `HARD_MAX_ACTIONS_PER_REPLY`), adding dedicated per-turn caps only where domain quotas require them (`MAX_STICKERS_PER_REPLY`, `MAX_GENERATED_IMAGES_PER_REPLY`, `MAX_VOICES_PER_REPLY`).
6. **Document prompt rules**: Add tool guidance under `packages/consts/aiChat/prompts/`, reusing `transcript.ts` formatting whenever message history is referenced.
7. **Add tests and docs**: Add unit tests under `test/aiChat/ai/` and document the tool across `docs/{cn,en,ja}/`.

---

## Adding a Generic JSON API Call

1. Add the exact `https://` origin to `JSON_API_ALLOWED_ORIGINS` in [`packages/consts/httpFetch.ts`](../../packages/consts/httpFetch.ts). Wildcards and plaintext `http://` origins are prohibited.
2. Perform requests through the bounded JSON client in [`packages/infra/httpFetch.ts`](../../packages/infra/httpFetch.ts), which blocks redirects and caps both response byte size and error-log snippets.
3. Add unit tests covering origin rejection, redirect blocking, response size ceilings, and network failures.

---

## Changing Persona and JSON Configuration

- **Persona prompt**: Built-in persona copy lives in `packages/consts/aiChat/prompts/persona.ts`. Create `prompt/persona.md` at the project root (see [`prompt_example/persona.md`](../../prompt_example/persona.md)) and restart the service to override it. For notification tone precedence, see [01 Environment Setup](01-getting-started.md#configuring-telegram-identity).
- **Voice tool prompt**: Built-in `send_voice` instructions live in `VOICE_LANGUAGE_PROMPTS` (`packages/consts/aiChat/prompts/tools.ts`) for Chinese, English, and Japanese. Placing `prompt/voice_tool.md` at the project root replaces the main tool body on restart while parameter schemas continue to follow `bot_language` (see [`prompt_example/voice_tool.md`](../../prompt_example/voice_tool.md)).
- **Sample prompt parity**: `prompt_example/` ships in release archives and is validated by `test/config/promptExamples.test.ts` via `loadPromptFile`. Quota, per-turn cap, and character-limit figures in `prompt_example/voice_tool.md` must match code constants, and its language must match `bot_language` in `config_example/dynamic/agent.json`.
- **Config directory tiers**: Edit only Git-ignored files under `config/`; treat `config_example/` strictly as a reference template:
  - `config/dynamic/` reloads live without a restart (`assets.json`, `ad_detect.json`, `agent.json`, `mood.json`, `stickers.json`, `cron.json`).
  - `config/static/` is read at startup and requires a restart (`bot.json`, `g-auth.json`).
- **Reactions and identity lists**: Allowed AI reaction emojis come from `AI_REACTION_EMOJIS`; blocklists and permission policies live in SQLite rather than JSON files.

---

## Adding Deployment JSON Configuration

1. Define the path constant in `packages/consts/paths.ts`, register its filename in the 3-level directory allowlist (`STATIC_ALLOWED_NAMES` or `DYNAMIC_ALLOWED_NAMES`) in `packages/config/layout.ts`, and implement strict schema validation in `packages/config/<domain>.ts` (explicit required/optional fields, range checks, and rejection of unknown keys).
2. Wire startup preflight validation into `validateExistingDeploymentInputs` in `packages/config/readiness.ts` (and update `test/preloadEnv.ts` / `test/preload.ts` if test isolates adopt a default snapshot).
3. Add a sanitized example under `config_example/static/` or `config_example/dynamic/` and update the trilingual guides in `config_example/README/`. If the example holds placeholder credentials or dummy IDs that must not be auto-copied on first install, skip it in `scripts/install/runtime.sh`.
4. For `config/dynamic/` files, register hot-reload loading and Worker snapshot/readiness reconciliation in `packages/config/reload.ts` and `packages/app/configReload.ts`.
5. Document the new configuration across all three `01-getting-started.md` guides.

---

## Adding a Runtime Cache

1. Create `packages/cache/<owner>/<domain>.ts` starting with `/** owner: <main|perThread|workers/<worker>>. ...` matching its directory (enforced by `bun run check:conventions`). Wrap mutable singletons in `{ current: T | null }` holders rather than `export let`.
2. Add Chinese JSDoc on every export documenting fill/eviction timing, capacity bounds, and Worker crash reconstruction.
3. Bound every `Map`, `Set`, and queue so all cached state stays owned, bounded, and reconstructible.
4. Register caches participating in shutdown persistence drains with `packages/libs/flushBarrier.ts`.

---

## Changing a Persistence Schema

> [!CAUTION]
> **Strict Invariant**: **Production code never retains backward-compatibility branches or performs silent runtime migrations**. Any schema mismatch fails startup immediately.

1. Update persisted types in `packages/types/` and tighten load-time validators in lockstep.
2. Update unit tests and pass `bun run test:fault-injection`.
3. **Stop the running service** and verify `bot.lock` is gone.
4. Back up data outside the working tree, then convert `memory/global/state.json` and affected files offline (manually or via a cold-migration CLI).
5. Start the updated service and resolve any reported path/field validation errors before accepting traffic.
6. Observe at least two supervisor restart intervals with zero unexpected restarts before removing external backups.

---

## Adding a SQLite Table

Runtime code never auto-migrates SQLite tables; schema mismatches abort startup immediately:

1. Declare the table in `packages/database/schema/<domain>.ts` and export it through `packages/database/schema/storage.ts`.
2. Generate `packages/database/schema/migrations/000N_<name>.sql` and record the entry in `packages/database/schema/migrations/meta/_journal.json`.
3. Apply the migration to a temp database, copy the resulting `created_at` and `hash` from `__drizzle_migrations` into `STORAGE_MIGRATION_LINEAGE` in `packages/consts/identityStorage.ts`, and increment `IDENTITY_DATABASE_SCHEMA_VERSION`.
4. Implement an offline cold-migration script, register the single active edge in `scripts/migrations/active.ts`, and delete superseded migration edges and their tests.
5. Decode source rows against frozen historical schemas inside the migration script rather than current production types.
6. Verify migrated data with bidirectional hash reconciliation before writing `ready.json`.
7. Route runtime mutations through the Disk I/O Worker write-through transaction pipeline.

---

## Changing an Inter-Worker Protocol

Cross-thread message contracts live under `packages/types/`. Update all three sides together:
1. Payload union definitions in `packages/types/`.
2. Main-thread IPC senders/waiters (`packages/infra/` or `packages/cache/main/`).
3. Worker-side message handlers and dispatchers (`packages/workers/<domain>/`).
Request-reply flows must register waiters before posting messages, enforce bounded timeouts, and settle pending waiters deterministically when a Worker crashes or exits.

---

<div align="center">

[← Prev: 05 Dev Workflow](05-dev-workflow.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#06-common-modification-recipes) · [Next: 07 Operations →](07-operations.md)

</div>
