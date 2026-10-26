# 03 Directory Map and Code Placement

<p align="center">
  <a href="../cn/03-directory-map.md">简体中文</a> · <b>English</b> · <a href="../ja/03-directory-map.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="02-architecture.md">← Prev: 02 Architecture</a> · <a href="04-invariants.md">Next: 04 Invariants →</a>
</p>

---

This document answers the core organizational question: **"Where does existing code live, and where should new code go?"** Specific coding styles, parameter count limits, and TypeScript import conventions are defined in ESLint and [`AGENTS.md`](../../AGENTS.md).

## Directory Responsibilities

- **`LICENSES/`**
  - **Contents**: The project's MIT [`LICENSE`](../../LICENSES/LICENSE), [`Unicode-3.0.txt`](../../LICENSES/Unicode-3.0.txt) for CJK character variants, [`audio-resample-polyphase-MIT.txt`](../../LICENSES/audio-resample-polyphase-MIT.txt) for polyphase audio resampling, and third-party licenses for Opus audio encoding ([`audio-encode-opus-MIT.txt`](../../LICENSES/audio-encode-opus-MIT.txt) and [`libopus-BSD.txt`](../../LICENSES/libopus-BSD.txt)).
- **`packages/app/`**
  - **Responsibility**: System lifecycle orchestration, startup configuration preflight checks, `config/dynamic/` hot-reload watching and propagation, handler registration, command menu assembly, and the Telegram update polling runner.
  - **Key Modules**: `lifecycle.ts` and `lifecycle/` (`maintenance.ts`, `shutdown.ts`), `lifecycleDependencies.ts`, `configReload.ts`, `registerHandlers.ts`, `updatePreamble.ts`, `updateRunner.ts` / `updateFetcher.ts`.
- **`packages/commands/`**
  - **Responsibility**: Explicit Telegram slash command handlers organized by command domain; sub-commands dispatch within their domain and shared permission/config gates are extracted into dedicated modules.
  - **Key Modules**: `copy.ts`, `icon.ts`, `mood.ts`, `qa.ts` and `qa/` (`board.ts`, `ingress.ts`, `notices.ts`, `rendering.ts`, `session.ts`), `wed.ts` and `wed/` (`memberReview.ts`, `messages.ts`, `persistence.ts`, `rendering.ts`), `block.ts`, `hImage.ts` and `hImage/` (image drawing and collection), `info.ts`, `deferredCommands.ts`, `blocklistFanOut.ts`, `mute.ts`, `batchKick.ts`, `targetResolution.ts`, `configGate.ts`, `arguments.ts`; gag speech restrictions in `gag.ts` (entry), `gag/runtime.ts` (lifecycle), `gag/inline.ts`, `gag/notices.ts`, `gag/refresh.ts`, and `gag/rendering.ts`; `/delete_message` in `deleteMessage.ts` (command and message ingress) and `deleteMessage/queue.ts` (deletion queue and shutdown drain); daily fortune draws in `luckChallenge/` (`cache.ts`, `draw.ts`, `key.ts`, `rateLimit.ts`, `receipt.ts`, `rendering.ts`, `telegramAdapter.ts`).
- **`packages/mini-app-server/`**
  - **Responsibility**: Server side of the SuperAdmin-only Telegram Mini App management console: local `Bun.serve` HTTP server, unified auth middleware chain and API/asset routes, runtime status & AI mood switching / managed chats / hot 256 messages / identities & permissions / gallery data views, Google Authenticator (TOTP) 2FA persistence, native contact & channel picker sessions, and protected SVG and `/favicon.ico` icon resources. Shares the constants, types and capability modules under `packages/` with the bot service. `server/serve.ts` starts and stops `Bun.serve`; routes are registered per domain under `routes/`, where each file provides both its `Bun.serve` native route table fragment and the fallback dispatch match used when no native route hits, combined by `server/register.ts`; request handlers live in `handlers/`, auth middlewares and chain definitions in `middleware/`, password sessions, lockout and the TOTP authenticator in `auth/`, native picker sessions in `picker/`, data views in `view/`, and business-agnostic request parsing, response building, path normalization and resource reads in `libs/`. `server/register.ts` HTML-imports `packages/mini-app-frontend/index.html` so `Bun.serve` bundles and hosts the frontend, which is the server's only reference into the frontend.
  - **Key Modules**: `server/` (`serve.ts`, `register.ts`), `routes/` (`page.ts`, `auth.ts`, `status.ts`, `totp.ts`, `chats.ts`, `identities.ts`, `gallery.ts`, `resource.ts`), `handlers/` (per-domain handlers named after `routes/`), `middleware/` (`pipeline.ts`, `chains.ts`, `crossSite.ts`, `assetNavigation.ts`, `initData.ts`, `sessionToken.ts`), `auth/` (`session.ts`, `totpStorage.ts`), `picker/` (`sessions.ts`, `prepare.ts`, `sharedMessage.ts`), `view/` (`status.ts`, `gallery.ts`, `messages.ts`) with its subdirectories `chats/` (`query.ts`, `toggle.ts`) and `identities/` (`whitelist.ts`, `blocklist.ts`, `metadata.ts`), `libs/` (`request.ts`, `response.ts`, `routePath.ts`, `resource.ts`, `downloadFileName.ts`), `resource/` (`favicon.ico` and protected SVG icons); `index.ts` provides a thin stateless public facade.
- **`packages/mini-app-frontend/`**
  - **Responsibility**: Trilingual (`zh`/`ja`/`en`) Light/Dark-themed React + Zustand WebApp frontend of the Mini App. Data and rendering are separated: `api/` holds one file per endpoint (shared auth headers and JSON requests in `api/client.ts`), `store/` holds one file per page component with its state and async actions (`app.ts` is the global singleton; the others are created per component instance through `libs/componentStore.ts` on mount and discarded on unmount), `components/` only render, and loading skeletons live in `components/skeletons/`. Its code depends on no file outside this directory (including `import type` and HTML/CSS asset references) and shares npm dependencies through the root `package.json`; constants, types, functions and the favicon that overlap with the server are copied into `consts/`, `types/`, `libs/` (`formatters.ts`, `errorMessage.ts`) and `resource/`, kept identical to the server by `test/mini-app-frontend/frontendParity.test.ts`, and the boundary is enforced by `bun run check:conventions`.
  - **Key Modules**: `index.html`, `main.tsx`, `App.tsx`, `styles.css`, `api/`, `store/` (`app.ts`, `status.ts`, `chats.ts`, `messages.ts`, `identities.ts`, `permissionDrawer.ts`, `gallery.ts`, `totp.ts`), `components/` (including `skeletons/`), `libs/` (`componentStore.ts`, `credentials.ts`, `telegram.ts`, `formatters.ts`, `loading.ts`, `errorMessage.ts` and others), `i18n/`, `consts/`, `types/`, `resource/` (`favicon.ico`, `icons.tsx`, `index.ts`).
- **`packages/auto/`**
  - **Responsibility**: Non-command automatic behaviors, including message copying, AI chat transcription and trigger evaluation, and reaction synchronization.
  - **Key Modules**: `message/` (including `triggerPolicy.ts`), `reactionSync.ts`.
- **`packages/aiChat/`**
  - **Responsibility**: Main-thread conversational AI proxy and model capability integration, including Worker supervision, memory mirrors, startup and hot-reload state hydration, availability checks, and provider clients/tools (`gemini/`, `openai/`, `anthropic/`).
  - **Key Modules**: `workerBridge.ts`, `hydration.ts`, `messageIngress.ts`, `abuseMark.ts`, `botImages.ts`, `voiceSynthesis.ts`, `webDigest.ts`, `memoryMirror.ts`, `stickerMirror.ts`, `workerJob.ts`, `availability.ts`, `provider.ts`, `providerFacades.ts`, `providerLanes.ts`, `capabilityClient.ts`, `gemini/`, `openai/`, `anthropic/`, `ai/`; `index.ts` provides a thin stateless public facade.
- **`packages/antiRaid/`**
  - **Responsibility**: Main-thread Anti-Raid proxy, including Worker supervision, durable message delivery, join/message update ingress, ad candidate queuing and disposal, blocklist enforcement, and verification scheduling.
  - **Key Modules**: `workerBridge/` (`controller.ts`, `events.ts`, `observers.ts`, `replay.ts`), `durableDelivery.ts`, `updateIngress.ts`, `adCandidate.ts`, `adDetect.ts`; `index.ts` provides a thin stateless public facade.
- **`packages/cron/`**
  - **Responsibility**: Main-thread scheduler for `cron.json` tasks (standard cron expressions, one-shot `just_once`, and random interval `rand_cron`), sequential action execution with retries, and Telegram outbound delivery.
  - **Key Modules**: `scheduler.ts`, `run.ts`, `delivery.ts`, `targets.ts`.
- **`packages/copy/`**
  - **Responsibility**: Message echoing logic, text transformations (reverse, nya), and avatar update queues.
  - **Key Modules**: `echo.ts`, `copyModes.ts`, `avatarQueue.ts`.
- **`packages/translate/`**
  - **Responsibility**: Per-group translation sessions, state recovery, regex language detection, and Google Translation client wrapper.
  - **Key Modules**: `state.ts`, `recovery.ts`, `message.ts`, `language.ts`, `client.ts`.
- **`packages/users/`**
  - **Responsibility**: In-memory sender identity cache, visible sender extraction and label formatting, and shared identity/message metadata resolution.
  - **Key Modules**: `senderIdentity.ts`, `visibleSender.ts`, `userLabel.ts`, `identityMetadata.ts`, `messageContent.ts`, `messageOrigin.ts`.
- **`packages/states/`**
  - **Responsibility**: **Completely I/O-free, pure functional state machines** and admission predicates for join verification transitions, lockdown transitions, AI reply admission, ad-detection admission, temporary ad bypasses, and media input support reduction.
  - **Key Modules**: `verification.ts` and `verification/` (`join`/`pending`/`terminal`/`disable` phases and `adopt.ts` recovery), `lockdown.ts` and `lockdown/` (`apply`/`persistence`/`restore`/`announcement`/`adopt` phases), `replyAdmission.ts`, `adDetectAdmission.ts`, `temporaryAdBypass.ts`, `mediaInputSupport.ts`.
- **`packages/config/`**
  - **Responsibility**: Strict schema validation, in-memory snapshots, hot-reload diffing, and capability readiness checks for `config/{static,dynamic}/*.json`.
  - **Key Modules**: `bot.ts`, `botInput.ts`, `layout.ts`, `agent.ts`, `agentCapability.ts`, `agentTts.ts`, `assets.ts`, `cron.ts`, `cronAction.ts`, `mood.ts`, `persona.ts`, `promptFile.ts`, `stickers.ts`, `adSamples.ts`, `googleAuth.ts`, `time.ts`, `timeZoneInput.ts`, `readiness.ts`, `reload.ts`.
- **`packages/database/`**
  - **Responsibility**: Shared SQLite database schemas, codecs, row validations, and Drizzle ORM interaction boundaries; runtime database handles are exclusively owned by the Disk I/O Worker.
  - **Key Modules**: `schema/` (including `migrations/`), `codec/identity.ts`, `codec/chatState.ts`, `codec/chatQa.ts`, `codec/temporaryAdBypass.ts`, `interact/` (`connection.ts`, `transaction.ts`, `identityPolicy.ts`, `chatState.ts`, `chatQa.ts`, `temporaryAdBypass.ts`, `aiContext.ts`, `migration.ts`, `initialization.ts`, `inspection.ts`), `validation/storageRows.ts`.
- **`packages/libs/`**
  - **Responsibility**: Domain-agnostic foundation utilities, including atomic file operations, bounded queues, and concurrency/IPC helpers.
  - **Key Modules**: `flushBarrier.ts`, `linkedQueue.ts`, `fifoMap.ts` and `lruCache.ts`, `acknowledgedBatchQueue.ts`, `boundedResponse.ts`, `boundedSettledBatch.ts`, `monotonicDeadline.ts`, `text.ts`, `errorMessage.ts`, `telegramMarkdown.ts`, `webDigest.ts` and `webDigestMarkdown.ts`, `webDigestUrls.ts`, `workerRequestTable.ts`.
- **`packages/workers/`**
  - **Responsibility**: Internal implementations for the three Worker threads.
  - **Key Modules**: `aiChatWorker.ts`, `antiRaidWorker.ts`, `diskIOWorker.ts`, `businessWorkerPort.ts`, `aiChat/`, `antiRaid/verificationEffects/`, `diskIO/storageDatabase.ts` and `diskIO/storageDatabase/` (including `flushHold.ts`), `diskIO/verification{Codec,Recovery,Writes}.ts`.
- **`packages/aiChat/ai/`**
  - **Responsibility**: Tool and prompt implementations for AI capabilities.
  - **Key Modules**: `tools/replyToolset/`, `tools/webSearch.ts`, `webDigest.ts`, `utils/`, `stickers/`, `voiceSynthesis.ts`, `ttsUsage.ts`.
- **`packages/workers/antiRaid/adDetect/`**
  - **Responsibility**: Ad detection pipeline, including batch queuing, message bundling, classifier invocation, and violation disposal.
  - **Key Modules**: `queue.ts`, `queueState.ts`, `verdict.ts`, `bundle.ts`, `classifier.ts`, `disposal.ts`, `config.ts`, `ai/`.
- **`packages/infra/`**
  - **Responsibility**: Main-thread sole Telegram client and outbound gate, Worker duplex IPC hosts, structured logging, main-thread I/O proxies, and dedicated image library management.
  - **Key Modules & Directories**:
    - `telegram/` (including `telegram/outboundGate.ts`, `telegram/outboundRetryLane.ts`, `telegram/sendLane.ts`, `telegram/sendScheduler.ts`, `telegram/avatar/`, `telegram/actions/`)
    - `diskIO.ts` and `diskIO/` (`businessWrite.ts`, `diagnosticChannel.ts`, `fatal.ts`, `host.ts`, `observers.ts`, `recovery.ts`, `requests.ts`, `storageAdmission.ts`, `transport.ts`)
    - `identityStorage.ts` and `identityStorage/` (`read.ts`, `shared.ts`, `sweep.ts`, `write.ts`)
    - `logger.ts` and `logger/` (`forwarding.ts`, `redaction.ts`, `serialization.ts`)
    - `supervisedWorker.ts`, `workerSupervisor.ts`
    - `aiCacheUsage.ts`, `geminiContextCache.ts`
    - `randomImage.ts`, `mediaGroups.ts`
    - `telegram/fileDownload.ts`, `telegram/commandPhotos.ts`, `commandExecutor.ts`
- **`packages/infra/identityPolicy/`**
  - **Responsibility**: Main-thread read boundaries for allowlist permissions, temporary ad bypasses, and list mutual-exclusion coordination.
  - **Key Modules**: `whitelist.ts`, `temporaryAdBypass.ts`, `coordination.ts`.
- **`packages/infra/blocklist/`**
  - **Responsibility**: Main-thread blocklist infrastructure, including membership checks, durable outbox, cross-group member sweeps, and deleted-account detection.
  - **Key Modules**: `membership.ts`, `outbox.ts`, `participantInvalid.ts`, `sweep.ts`, `sweepEligibility.ts`, `sweepReplay.ts`, `sweepRetryState.ts`, `sweepScheduler.ts`.
- **`packages/infra/storage/`**
  - **Responsibility**: Data root preflight checks, single-instance lock protection, global state (`memory/global/state.json`) facade, and startup cleanup.
  - **Key Modules**: `dataRoot.ts`, `instanceLock.ts`, `stateStore.ts`, `statePersistence.ts`, `cleanup.ts`.
- **`packages/cache/`**
  - **Responsibility**: In-process mutable state containers. **The first directory level strictly corresponds to the owning thread**.
  - **Key Subdirectories**: `main/`, `workers/aiChat/`, `workers/antiRaid/`, `workers/diskIO/`, `perThread/`.
- **`packages/consts/`**
  - **Responsibility**: Immutable literal constants, runtime parameters, and user-facing copy tables organized by domain.
  - **Key Modules**: `atmosphere/{teasing,plain}/`, `commands.ts`, `whitelist.ts`, `aiChat/rateLimit.ts`, `antiRaid/`, `diskIO/`.
- **`packages/types/`**
  - **Responsibility**: Cross-module contracts, domain model types, and state machine state/event definitions (`types/states/`).
  - **Key Modules**: `chatState.ts`, `commands.ts`, `lifecycle.ts`, `diskIO/` (`messages.ts`, `replies.ts`).
- **`test/`**
  - **Responsibility**: Bun unit and integration test suites mirroring `packages/`.
- **`scripts/`**
  - **Responsibility**: Convention checks, build/release packaging, performance benchmark suites, installer scripts, and offline cold migration scripts.

---

## Deciding Where New Code Belongs

When introducing new code or refactoring existing modules, follow this decision order:

1. **Is it a literal parameter, threshold, or user-facing text?**
   - Put it in `packages/consts/<domain>.ts` (or split into `packages/consts/<domain>/` when large); Mini App frontend constants go in `packages/mini-app-frontend/consts/<domain>.ts`.
   - Include Chinese JSDoc explaining its purpose and invariants. Command notices and receipts belong in copy tables rather than inline in handlers.
   - Deployment JSON parsing and validation belong in `packages/config/<domain>.ts`; environment variables may only be read in `packages/consts/paths.ts` and `packages/consts/environment.ts`.
2. **Is it a shared type definition or protocol across modules?**
   - Put it in `packages/types/<domain>.ts`. Pure state machine state, event, and decision contracts go in `packages/types/states/`. Mini App frontend types go in `packages/mini-app-frontend/types/<domain>.ts`, and copies that overlap with the server are registered in `test/mini-app-frontend/frontendParity.test.ts`.
3. **Is it long-lived mutable state (Map, Set, queue, timer, or singleton)?**
   - Put it in `packages/cache/` under the owning thread's subdirectory (`main/`, `workers/<worker>/`, or `perThread/`).
   - Wrap singletons in `{ current: T | null }` holders (never `export let`), and document initialization, cleanup, and Worker crash-recovery behavior in JSDoc.
4. **Is it pure state transition logic (zero I/O, pure computation)?**
   - Put it in `packages/states/`. Actual I/O side effects are executed by the main-thread or Worker interpreter.
5. **Is it operational business logic, side effects, or external integration?**
   - Place it in its owning domain: user commands in `packages/commands/`, non-command automatic behavior in `packages/auto/`, internal Worker logic in `packages/workers/<domain>/`, model capabilities in the domain's `ai/` directory, and shared infrastructure in `packages/infra/`.

> [!CAUTION]
> **Prohibited Patterns**:
> - Declaring module-level `Map` or `Set` collections inside ordinary business files.
> - Scattering constants inside business logic.
> - Reading or writing shared data directly via `fs` inside Worker threads, bypassing the Disk I/O Worker.

---

## Cache Partitioned by Owning Thread

The first directory level under `packages/cache/` declares which thread owns the state—threads communicate exclusively by message passing without shared memory, so importing the same cache module from two threads instantiates two independent copies:

- **`main/`**
  - **Owner**: Main thread.
  - **Contents**: Command and auto-pipeline state, global `memory/global/state.json` mirror (`storage.ts`, managed via the `stateStore.ts` facade), `config/dynamic/assets.json` asset snapshots (`assets.ts`), `chat_states` hot-read map (`chatState.ts`, up to `STATE_MANAGED_CHAT_LIMIT` chats including per-group translation sessions), Disk I/O host state, and **main-thread Worker proxies and recovery mirrors** (`main/aiChat.ts`, `main/antiRaid/`).
- **`workers/aiChat/`**
  - **Owner**: AI Chat Worker.
  - **Contents**: Rolling conversation memory, reply admission counters, bot-sent image description backfill registrations, active mood state, sticker catalogs and sets, in-flight voice synthesis and web digest jobs delegated from the main thread, daily voice synthesis counters, and model provider client singletons.
- **`workers/antiRaid/`**
  - **Owner**: Anti-Raid Worker.
  - **Contents**: Verification and lockdown state machines, flood windows, ad detection queues, and Google/OpenAI/Anthropic moderation clients.
- **`workers/diskIO/`**
  - **Owner**: Disk I/O Worker.
  - **Contents**: Per-domain write buffers, indexes, dirty flags, and coalesced periodic flush timers (`timedFlush.ts`).
- **`perThread/`**
  - **Owner**: Instantiated independently once per thread.
  - **Contents**: Telegram capability implementation holders (real adapter on the main thread, duplex proxy in business Workers), Worker duplex waiters, deployment config singletons, self-sent message registry, update cancellation context storage, and AI cache usage reporting sink.

> [!IMPORTANT]
> `main/antiRaid/` and `workers/antiRaid/` are **two non-shared sets of state**: the authoritative state machine lives inside the Anti-Raid Worker, while the main thread holds only a pure data mirror for crash replay. `bun run check:conventions` verifies ownership against the actual module import graph (see [04 Authoritative Runtime Invariants](04-invariants.md#thread-and-state-ownership)) and prints the full import chain on violation.
>
> Domain modules reused across threads (such as `packages/aiChat/ai/`) must separate pure functions from thread-exclusive caches: for example, [`packages/aiChat/ai/stickers/describe.ts`](../../packages/aiChat/ai/stickers/describe.ts) is called directly by the main-thread message pipeline, while the sticker set cache in `sets.ts` is owned exclusively by the AI Worker.

---

## Compatibility Entry-Point (Barrel) Convention

When a large file is split into submodules, the original path may remain as a thin, stateless compatibility export entry point (such as `packages/infra/telegram/actions.ts` for `packages/infra/telegram/actions/`, or `packages/workers/diskIO/storageDatabase.ts` for `packages/workers/diskIO/storageDatabase/`):

- Compatibility entry points serve only gradual migration of existing imports; **all new code must import directly from domain leaf files**.
- Compatibility entry points must never hold mutable state, parse configuration, or introduce import side effects.
- Package `index.ts` files are kept only when callers genuinely need a single package surface; `packages/aiChat/index.ts`, `packages/antiRaid/index.ts`, and `packages/infra/telegram/index.ts` are explicit thin exports with no state (`infra/telegram/index.ts` re-exports only the client, common actions, and command receipt symbols used by existing modules, while new code imports leaf modules such as `client`, `actions/*`, and `commandMessages` directly). Production internals of `aiChat` and `antiRaid` import their owner leaf modules directly, and none of these entry points use unbounded `export *`.

---

## Mirrored Test Structure

Paths under `test/` mirror `packages/` in principle; modules split from one domain may share a domain-level test. For example, `packages/workers/diskIO/verificationCodec.ts`, `verificationRecovery.ts`, and `verificationWrites.ts` are all covered by `test/workers/diskIO/verificationFiles.test.ts`. Tests for other new modules follow the directory structure. Cross-domain test doubles, fixtures, and harnesses reside in `test/helpers/`, and domain-agnostic small utilities in `test/helpers/common.ts`. For details on sandbox isolation and temporary data roots, see [05 Development Workflow](05-dev-workflow.md#test-isolation).

---

<div align="center">

[← Prev: 02 Architecture](02-architecture.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#03-directory-map-and-code-placement) · [Next: 04 Invariants →](04-invariants.md)

</div>
