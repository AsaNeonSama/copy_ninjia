# 05 Development Workflow and Quality Gates

<p align="center">
  <a href="../cn/05-dev-workflow.md">简体中文</a> · <b>English</b> · <a href="../ja/05-dev-workflow.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="04-invariants.md">← Prev: 04 Invariants</a> · <a href="06-modification-guide.md">Next: 06 Recipes →</a>
</p>

---

## Command Reference

| Command | Purpose | Notes |
| :--- | :--- | :--- |
| `bun run start` | Start long polling | Production entry point |
| `bun run lint`<br>`bun run lint:fix` | ESLint check / auto-fix | Enforces strict code conventions; CI and quality gates always run uncached `lint` |
| `bun run lint:fast` | Local cached ESLint | Appends `--cache` for fast local iteration only |
| `bun run typecheck` | TypeScript type check | Runs `bun --check` across the entire project in full strict mode per `tsconfig.json`; writes no incremental cache |
| `bun run test` | Full test suite | Enforces per-file context isolation (`bun test --isolate`) |
| `bun run test:coverage` | Tests + coverage | Runs the full suite in random order (`--randomize`; prints `--seed=` for reproduction), measures full-source coverage, and surfaces cross-test state or mock leaks |
| `bun run check:install-script-syntax` | Install script syntax check | Parses `install.sh` and all sourced shell modules via `bash -n` without executing them |
| `bun run check:install-isolation` | Installer isolation test | Runs real `install.sh` fixtures in a dedicated temp root to verify rollback, resumption, backup retention, credential isolation, service protection, and startup monitoring |
| `bun run check:conventions` | Repository convention check | Runs `scripts/checkProjectConventions.ts` to validate constants, cache ownership, doc links, and architectural boundaries |
| `bun run check` | **Full integration gate** | Syntax + installer isolation + conventions + lint + typecheck + randomized coverage (`coverageThreshold` in `bunfig.toml`) + hot-path gate (required before merging to `master`) |
| `bun run check:coverage` | Coverage metrics reconciliation | Verifies that figures in trilingual READMEs, docs, and SVG badges match actual coverage readings |
| `bun run test:fault-injection` | Deterministic fault-injection suite | Runs `FAULT_INJECTION_TESTS` via `scripts/testFaultInjection.ts`, verifying recovery across process crashes, abnormal exits, database drops, and Worker respawns |
| `bun run perf:hot-paths -- <scenario> [--profile]` | Hot-path standalone measurement | Measures one hot-path scenario across `HOT_PATH_PROFILE_REPEATS` isolated processes against a temp data root and config copy under `performance/` (`--profile` enables CPU sampling); direct execution of `scripts/perf/hotPaths.ts` is rejected before loading any scenario |
| `bun run perf:hot-path-gate` | **Hot-path performance gate** | Enforces hard memory, GC, and JIT ceilings on core hot paths (bundled into `check`) |
| `bun run perf:disk-transport` | Business-channel transport stress | Measures main-thread business-channel queue overhead, ACK throughput, and latency against a mock Worker to isolate IPC transport from disk I/O |
| `bun run perf:join-log` | Join-log performance benchmark | Standalone process benchmark for join-log capacity limits, snapshots, and append accounting |
| `bun run perf:identity-database` | Identity database benchmark | Standalone process benchmark for cold/hot SQLite I/O, main-thread LRU reads, and write-through pipelines |
| `bun run perf:full` | Full performance benchmark suite | Runs every section across independent child processes for `FULL_SUITE_ROUNDS` rounds (`--write-doc` updates all three `11-performance.md` files and `performance-result.json`) |
| `bun run perf:review` | Targeted performance review | Deep-dive suite covering hot paths, AI replies/payloads/audio encoding, full command chains, and Disk I/O Worker stress |
| `bun run build -- --version <tag>` | Build binary package | Requires an explicit unprefixed version; outputs the `dist/` archive and `.sha256` file for the current platform |
| `bun run release:check -- --version <tag>` | Pre-release full validation | Frozen lockfile + `check` + coverage reconciliation + fault injection + binary build verification |
| `bun run release:build -- --version <tag>` | Build release package | Natively builds the current platform's release asset on a clean `dev` branch; other platforms must be built natively in their matching environments |
| `bun run release:verify -- --version <tag> --platforms <list>` | Release package verification | Verifies archives, SHA-256 hashes, embedded versions, and Git tree alignment across all target platforms |
| `bun run release:publish -- --version <tag> --platforms <list> --notes-file <file>` | Publish to GitHub | Verifies remote refs, creates a draft release, uploads and re-verifies assets, and publishes as Latest |
| `bun run audit:release` | Dependency security audit | Scans dependencies for vulnerabilities rated `moderate` or higher |
| `bun run migrate:wed-member-window` | `/wed` member-window cold migration | Offline migration converting 17.2.1 `memory/wed` member ID arrays into `{ id, enteredAt }` sliding-window entries (see [07 Operations](07-operations.md#upgrade-wed-member-window)) |
| `bun run migrate:ad-pack-blacklists` | Ad pack blacklists & v13 → v14 cold migration | Offline migration upgrading a schema v13 database and optional legacy 4-key `ad_detect.json` to schema v14 (`ad_pack_blacklists`) and 2-key config (see [07 Operations](07-operations.md#upgrade-ad-pack-blacklists)) |

---

## Quality-Gate Definitions

- **Isolated installer startup verification**:
  - Fixtures run against dedicated temporary configuration and data roots. They stub out system service managers, dependency downloads, and live network traffic while executing real `index.ts` startup, Worker threads, and shutdown persistence.
  - Workers use Bun's `preload` hook to inject network stubs: the Tokyo weather endpoint returns canned data, while all other outbound requests are blocked.
  - The suite asserts that stubs load cleanly, the polling pipeline starts, `SIGTERM` drains all in-flight work, and lock files are released.
- **Source file line limit (`MAX_SOURCE_LINES` / `MAX_FRONTEND_SOURCE_LINES`)**:
  - Handwritten TypeScript, JavaScript, CSS, HTML, and Shell files exceeding their ceiling in `scripts/conventions/fileLength.ts` fail the gate immediately (see [`AGENTS.md`](../../AGENTS.md)).
  - Backend files over 512 lines should be evaluated for splitting and must be split before exceeding `MAX_SOURCE_LINES` (1024 lines); `.tsx` and `.css` files under `packages/mini-app-frontend/` and `.html` files are capped at `MAX_FRONTEND_SOURCE_LINES` (1536 lines).
  - The check covers all Git-tracked files and untracked non-ignored files while skipping Git-ignored deployment data. Installer syntax checks cover `install.sh` and every shell module under `scripts/install/`.
- **Universal source code coverage**:
  - `test/productionModules.test.ts` eagerly imports `index.ts` and every `.ts` / `.tsx` runtime module under `packages/` (excluding pure type declarations in `packages/types/` and the top-level mount entry `packages/mini-app-frontend/main.tsx`), counting untouched modules as 0% in the denominator.
  - `bunfig.toml` configures `coverageSkipTestFiles = true` and `coveragePathIgnorePatterns = ["test/**"]` (excluding test files and test helpers under `test/` from coverage reporting), and both function and line coverage must meet `coverageThreshold`; adding untested runtime modules directly lowers overall coverage.
- **Strict typing and syntax standards**:
  - `tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, and `noUnusedParameters`.
  - Production code forbids `any` (tests are exempt). Native `Promise.all` is rejected by ESLint (`no-restricted-syntax`) in favor of `Promise.allSettled` with bounded concurrency. JSX/TSX fragments must explicitly use `<Fragment>` from `react`; the `<>...</>` shorthand is disallowed.
- **Standalone type imports**:
  - Production code, scripts, and tests must declare type-only imports with standalone `import type` statements. ESLint rejects mixed imports such as `import { value, type Shape }`.
- **Explicit type annotations**:
  - Variables, function parameters, and destructuring patterns in production code (`index.ts`, `packages/`, `scripts/`) require explicit type annotations (`@typescript-eslint/typedef`), and functions and callbacks require explicit return types (`@typescript-eslint/explicit-function-return-type`).
  - Loop variables in `for...of` / `for...in` statements and `const` bindings initialized directly with fully annotated arrow functions are exempt; test files are exempt as well.
- **Repository convention checks (`check:conventions`)**:
  - **Structure and links**:
    - Checks source line counts, file placement, local Markdown relative links, and in-page anchor fragments.
    - Verifies that directory module lists and inline backtick repository paths cited in docs exist in the tracked tree, checks script executable bits, and reconciles installer step numbers against shell modules.
  - **Architectural boundaries**:
    - Verifies constant placement, thread-single-owner cache boundaries (`packages/cache/<owner>/`), and Worker / Telegram client capability isolation against the real import graph.
    - Restricts `process.env` reads to `consts/paths.ts` and `consts/environment.ts`.
    - Restricts `consts/` runtime dependencies to `consts` (other `packages/` modules may only be imported via `import type`); `packages/mini-app-frontend/consts/` obeys the same constant rules and depends only on itself at runtime.
    - Enforces Mini App frontend isolation: TS/TSX specifiers (including `import type`) and relative HTML/CSS asset links inside `packages/mini-app-frontend/` cannot reach outside that directory, and no other `packages/` module or `index.ts` may import the frontend except the server HTML entry registered in `MINI_APP_FRONTEND_ENTRY_IMPORTS` (`scripts/conventions/miniAppFrontend.ts`; stale entries also fail).
    - Enforces `states/` closure: direct and transitive runtime dependencies of `states/` must stay within `consts`, `libs`, `types`, and `states` (`config/time.ts` is the sole exception registered in `STATES_CLOSURE_OPAQUE_MODULES`).
    - Enforces `infra/` layering: at runtime `infra/` may only import `cache`, `config`, `consts`, `database`, `infra`, `libs`, `states`, `types`, and `users` (`INFRA_ALLOWED_PREFIXES`, with `workers/diskIO/diagnosticSink.ts` as the sole exemption), preventing upward imports into business layers; the full-benchmark parent process may only import pure constants and types.
  - **Constant table rules**:
    - Exported regular expressions and any `RegExp` exposed inside containers or properties must be annotated as `Readonly<RegExp>`; exported constant tables with object elements (excluding `Readonly<RegExp>` and functions) must have a mutation check in `test/consts/immutability.test.ts` on the line immediately following `@ts-expect-error` (`scripts/conventions/constImmutability.ts`).
    - Exported array tables typed over a literal union must use `exhaustiveList<U>()([...])` (`packages/consts/exhaustiveList.ts`, or `packages/mini-app-frontend/consts/exhaustiveList.ts` in the frontend), where `U` matches the declared element type and every element is a string or number literal so union drift fails compilation.
    - Intentional subset tables must be registered as `<relative path>#<table name>` in `PARTIAL_LITERAL_TABLES` (`scripts/conventions/constExhaustiveLists.ts`); stale entries fail the gate.
  - **Runtime safety and APIs**:
    - Every timer in `packages/workers/` must call `.unref()`.
    - `packages/` forbids `Object.freeze` and forbids reading the oldest entry via `.keys().next()`, `.values().next()`, or `.entries().next()`; bounded FIFO/LRU structures obtain their oldest entry through `FifoMap` in `libs/fifoMap.ts` (or `LruCache`, which extends it).
    - Node compatibility modules and `Buffer` are restricted to explicit allowlists (unused entries fail); CLI arguments must be read via `Bun.argv`; `collectUndeclaredDependencyProblems` restricts bare runtime imports in `index.ts` and `packages/` strictly to packages declared in `package.json` `dependencies` (while `scripts/` and `test/` allow `dependencies` and `devDependencies`).
    - Direct `console.*` property access is forbidden across `packages/`, except `console.error` strictly at the `packages/workers/diskIOWorker.ts` and `packages/workers/diskIO/` boundary.
  - **Gate reconciliation**:
    - Statically checks JSDoc on top-level functions, class methods, and `*Params`/`*Options` interface properties across `index.ts`, `packages/`, and `scripts/`, including `@param` and non-`void`/`never` `@returns` tags (`collectFunctionJsDocProblems` in `scripts/conventions/sourceRules.ts`).
    - Reconciles Telegram prompt auto-delete exemptions, topic propagation, property-access `*.sendMessage(...)` bypasses, `sendMessageWithResult` imports in command text files, and existence of every `directBoundaries` target file and boundary function in `collectTelegramMessageProblems`; matches cold migration scripts against `migrate:*` entries in `package.json`; verifies the fault-injection suite manifest; and checks trilingual coverage and performance figures against `performance-result.json`.
    - Verifies "`<module>.ts` 的 `<symbol>`" cross-references in comments: `./` and `../` paths resolve from the commented file's directory and fail if the file or symbol is missing; bare paths are checked whenever they resolve to a unique repository file.
  - **Test assertion rules**:
    - Tests must not compare imported uppercase constants against raw literals, nor pass string literals matching `packages/consts` exports (at least `STRING_CONSTANT_MIN_LENGTH` chars) or CJK prompt fragments (at least `CONSTANT_TEXT_FRAGMENT_MIN_CJK` CJK chars) directly to matchers; import the constant or render static template slices via `test/helpers/templateText.ts`.
    - Explicit prompt contract tests must be registered in `CONSTANT_TEXT_CONTRACT_EXEMPTIONS` (`scripts/conventions/testAssertionFragments.ts`).
  - **Test double resets**:
    - Any mock that queues `mockReturnValueOnce`, `mockResolvedValueOnce`, `mockRejectedValueOnce`, or `mockImplementationOnce` in a test must call `mockReset()` and reinstall its default implementation inside its lifecycle reset hook (`beforeEach`, `afterEach`, `beforeAll`, `afterAll`, or helpers they call transitively), because `mockClear()` leaves queued `Once` handlers intact (`scripts/conventions/testMockReset.ts`).
    - Any `spyOn` created at file top level, directly inside `describe`, or inside `beforeAll` / `beforeEach` (including transitive `test/` helpers) must be restored in a covering cleanup hook (`afterAll` for top-level and `beforeAll` spies, or same-scope synchronous top-level cleanup; `afterEach` or `afterAll` for `beforeEach` spies; or within the same setup hook).
    - Valid restore calls are `mockRestore()`, `mock.restore()`, or `jest.restoreAllMocks()`; when spying on a shared mock itself, only the latter two are allowed because `mockRestore()` wipes its implementation (`scripts/conventions/testSpyRestore.ts`). Both checks resolve symbols via the TypeScript type checker and ignore mid-test `mockClear()` calls that only reset call history.

---

### Dependency Release-Age Gate

All dependency installations enforce the release cooling period configured by `install.minimumReleaseAge` in `bunfig.toml`:
- **Emergency security patch exemption**: When an urgent vulnerability fix is newer than `install.minimumReleaseAge`, add only that single package name to `install.minimumReleaseAgeExcludes` and remove it immediately after installation. Bypassing the gate via `--minimum-release-age` is prohibited.
- **Verification protocol**: Cross-check the exempted version against at least two independent security advisories, verify the npm registry `integrity` hash, confirm no malicious payloads or persistence hooks exist, and record the package name, CVE/incident ID, and removal timestamp.
- **Pinned runtime versions**: The Bun runtime and `@types/bun` are pinned to the exact versions declared in `package.json`, locked jointly by `packageManager` and `install.sh`.
- **TypeScript compilers**: `bun run typecheck` runs Bun's built-in checker via `bun --check` (`bun check` runs the repository's `check` script). ESLint and convention checks use the TypeScript 6 compiler API via `typescript` (aliased to `@typescript/typescript6` in `package.json`).

---

### Bun Runtime Boundaries

- **Execution mode**: `bunfig.toml` sets `run.bun = true`, running dependency CLIs with Node shebangs directly on Bun.
- **Image transcoding**: Images are processed via native `Bun.Image` (`packages/infra/image.ts`):
  - JPEG and PNG pass through untouched; WebP and GIF transcode to PNG with full Alpha transparency preserved. Animated GIFs use the first frame, and animated WebPs repackage the first `ANMF` frame into a static WebP before decoding.
  - Decoding is capped at `VISION_TRANSCODE_MAX_PIXELS` per image (oversized inputs are rejected before pixel allocation), and images whose longer edge exceeds `VISION_TRANSCODE_MAX_EDGE` are downsampled proportionally without upscaling smaller images. Codecs ship inside Bun with zero native C/C++ addons in `node_modules`.
- **Native file I/O guidelines**:
  - Prefer `Bun.write` and `Bun.file` for reading, writing, and deleting files; use `Bun.file().stat()` for async metadata reads and `Bun.file().exists()` for regular-file existence checks.
  - Exclusive atomic writes (`atomicWriteText`) pair `Bun.write(Bun.file(handle.fd), content)` with `fsync` and atomic `rename`.
  - Use explicit `node:` modules for operations outside Bun's native file API: directory existence checks (`Bun.file().exists()` is always `false` on directories), missing-tolerant deletions (`force: true`, whereas `Bun.file().delete()` throws `ENOENT`), synchronous file I/O, directory traversal, path manipulation, and hard links.
- **Performance recalibration**: After upgrading the Bun runtime, recalibrate all performance benchmarks on the matching Bun version and commit revision.

---

### Measurements for This Documentation Version

`bun run test:coverage`: **7674 tests / 667 files / 595279 `expect()` calls**; full-source **function coverage 98.00% / line coverage 97.97%**. The Coverage badge in each project README displays line coverage.

---

## Test Isolation

All tests run via `bun run test` (`bun test --isolate`), providing automatic multi-layer isolation:

1. **Test file context isolation**: Bun gives every test file an independent global context so `mock.module` overrides and module-scoped state never leak across files.
2. **Dedicated temporary data root**:
   - Before any production module loads, `test/preloadEnv.ts` creates an isolated data root (`mkdtempSync`) for `COPY_NINJIA_DATA_ROOT` and a separate temp directory for `TMPDIR` so `os.tmpdir()` calls from tests and production code stay contained.
   - Both directories are placed under `/dev/shm` when it is a `tmpfs` with at least `TMPFS_MIN_AVAILABLE_BYTES` (defined in `test/preloadEnv.ts`) free, falling back to the original `os.tmpdir()` otherwise.
   - File I/O never touches live paths (`memory/`, `logs/`, `database/`, `bot.lock`), and both trees are removed while `TMPDIR` is restored on exit.
3. **Isolated configuration root**: Copies `config_example/static/` and `config_example/dynamic/` into `config/static/` and `config/dynamic/` under the temp root and sets `COPY_NINJIA_CONFIG_ROOT`. Placeholder secrets are replaced with safe dummy credentials, `g-auth.json` is omitted, and `cron.json` starts as an empty schedule.
4. **Snapshot sync and empty database setup**: `test/preload.ts` adopts the test copies of `agent.json`, `ad_detect.json`, `mood.json`, `stickers.json`, `cron.json`, bot atmosphere, and built-in persona into per-isolate holders, initializes an empty SQLite database with time-zone metadata, and marks feature readiness caches available.

### Key Test Suite Distribution

- **Installation and upgrade suites**: `test/scripts/installStartup.test.ts` and `test/scripts/installMigration.test.ts` verify installer workflows, fresh database setup, full startup sequences, and non-destructive rejection of outdated configs, SQLite schemas, or `/wed` member files.
- **Cold migration suites**: `test/scripts/migrateWedMemberWindow.test.ts` verifies that `migrate:wed-member-window` accepts only 17.2.1 `memory/wed` member ID arrays, preserves the last `WED_MEMBER_LIMIT` IDs in order as `{ id, enteredAt }` entries sharing one timestamp, produces output that passes startup validation, and rejects migrated/invalid inputs, symlinks, or pre-existing output directories without touching source backups; `test/scripts/migrateAdPackBlacklists.test.ts` verifies that `migrate:ad-pack-blacklists` accepts only schema v13 databases and optional legacy 4-key `ad_detect.json`, migrates to schema v14 with `ad_pack_blacklists`, writes a `parseAdDetectConfig`-validated 2-key config, completes `wal_checkpoint(TRUNCATE)`, and leaves source backups untouched.
- **Media and outbound suites**: `test/aiChat/ai/mediaAdmission.test.ts`, `test/aiChat/ai/imageDescription.test.ts`, and `test/infra/telegramWorkerCapabilities.test.ts` verify multimodal safety admission and duplex Worker Telegram capability gates.
- **Unified outbound integration suites**: `test/infra/telegramOutboundIntegration.test.ts` runs real client initialization, outbound schedulers, and per-chat lanes while stubbing only the innermost HTTP transport to verify cross-thread per-chat FIFO order, category-scoped 429 backoff, download throttling, and shutdown drain.
- **Security and logger suites**: `test/infra/loggerSecurity.test.ts` verifies credential redaction across nested and serialized error shapes.

---

## Fault-Injection Suite

`bun run test:fault-injection` verifies recovery and state invariants across crashes, abrupt shutdowns, and edge failures (the full manifest lives in `FAULT_INJECTION_TESTS` in [`scripts/conventions/faultInjectionSuite.ts`](../../scripts/conventions/faultInjectionSuite.ts), one path per line in lexical order):
- **Lifecycle and recovery limits**: Application and Worker lifecycles (including per-stage shutdown budgets and the overall deadline), group lockdown recovery, AI reply concurrency caps and cancellation, credential snapshots, Telegram outbound and auto-delete shutdown drains, and chat teardown cleanup.
- **Data durability and consistency**: Unacknowledged join-log mirrors and moderation receipts, Anti-Raid task draining and verification recovery, duplex Worker respawn cancellation, SQLite startup validation and shutdown close (pending write commit and WAL checkpoint), cold migrations, Mini App TOTP and config atomic persistence and service restart boundaries (`test/mini-app-api-server/persistenceAndRestartFaults.test.ts`, `test/mini-app-api-server/totpStorageConcurrency.test.ts`), and Disk I/O Worker atomic-write failure recovery.
- **Interactive state machines**: `test/workers/antiRaid/verificationWelcome.test.ts` (duplex protocol and temporary notice auto-deletion) and `/wed` interactive workflows (managed-chat cap `STATE_MANAGED_CHAT_LIMIT`, queued cancellation, avatar fetches, and shutdown drain).

---

## Hot-Path Gate

`bun run perf:hot-path-gate` is a hard stage inside `bun run check`. For every scenario in `HOT_PATH_PROFILE_SCENARIOS` (`packages/consts/performance.ts`), it spawns two isolated child-process modes for `HOT_PATH_PROFILE_REPEATS` rounds each:
- `steadyProfile`: Runs steady-state loops with `JSC_GC_LOG_ENV=1` (`BUN_JSC_logGC=1`) to measure GC pause ratio and JIT compilation tiers.
- `retained`: Runs without profiler hooks to measure true RSS peak, `heapUsed` peak, and retained heap/objects after a full GC.

All performance child processes (`perf:hot-path-gate`, `perf:full`, `perf:review`, `perf:disk-transport`, `perf:identity-database`, and `perf:join-log`) build their environment via `perfChildEnvironment` (`scripts/perf/childEnvironment.ts`):
- Inherits the parent environment and layers on isolated data/config roots.
- Strips Bun inspector attach variables listed in `BUN_INSPECTOR_ENVS` (such as `BUN_INSPECT_CONNECT_TO` injected by VS Code terminals) so each child contains only the main-thread JSC heap.
- Requires exactly one `starting` handshake line in the GC log and refuses to emit GC metrics if multiple heaps appear.

### Gate Metrics and Tiers

- **GC pause budget**: Scaled automatically by available CPU cores (`HOT_PATH_GC_CPU_BUDGETS`). Exceeding the core-tier budget plus `HOT_PATH_GC_SOFT_OVERRUN_PERCENT` percentage points fails the gate; smaller overruns emit soft warnings.
- **Hard gate thresholds**: Enforces ceilings on GC pause ratio, sampled RSS peak, process RSS peak, heap growth, post-full-GC retained heap/extra memory/object counts, minimum sample counts, and warmup entry into DFG JIT, checked against `calibration.limits` in [`performance-result.json`](../../performance-result.json).
- **Soft warning alerts**: Prints stderr warnings without changing the exit code when median latency exceeds `calibration.medianNsPerOpReportThresholds` or when calibrated ceilings grow stale relative to measured values (`HOT_PATH_CALIBRATION_STALE_RATIO`).
- **Calibration record management**: `calibration` must be recalibrated manually on an idle host and committed to Git; normal gate runs read the file without writing, updating `lastRun` only when `--write-result` is passed.

---

## Join-Log Performance Benchmark

`bun run perf:join-log` sizes its fixtures directly from production constants: per-chat daily cap `JOIN_LOG_MAX_USERS_PER_CHAT_DAY`, flush threshold `FLUSH_MAX_ENTRIES`, and append batch limit `JOIN_LOG_MAX_BUFFERED_ENTRIES`. Across `snapshot`, `capacity`, and `append-accounting`, it alternates baseline and current runs in separate child processes to verify checksum parity, throughput, and heap deltas.

---

## Identity-Database Performance Benchmark

`bun run perf:identity-database` measures end-to-end storage operations inside an isolated temp root and SQLite database: main-thread LRU reads, main-thread write-through (Worker IPC, JSONB transactions, and ACKs), hot-connection reads/writes, and cold-connection reads/writes. Fixture cardinalities follow `IDENTITY_READ_CACHE_MAX_ENTRIES` and `IDENTITY_WRITE_BATCH_MAX_ENTRIES`, with each case sampled in its own process and GC plus integrity checks kept outside timed windows.

---

## Targeted Scenarios and Transport Stress Validation

`bun run perf:review` conducts deep-dive stress runs across `FULL_SUITE_ROUNDS` isolated child-process rounds per case, executing `--hot-paths`, `--chains`, `--ai`, and `--worker` by default:
- `--hot-paths`: Sender resolution, message sliding windows, permission checks, AI active windows, pending verification snapshots, bounded streaming responses, and middleware pipelines.
- `--ai`: Reply admission gates, standard outbound sends, concurrent load capacity, Base64 transcoding, and Opus audio encoding.
- `--chains`: Full end-to-end command pipelines for ad detection (`ad-detect-command`), AI chat (`ai-reply-command`), and scheduled voice delivery (`cron-send-voice`).
- `--worker`: Batched transactional writes, ACK round-trips, and Worker crash-respawn recovery against the real Disk I/O Worker at `STATE_MANAGED_CHAT_LIMIT` managed chats.
- `--cooldown` / `--text`: On-demand benchmarks for command cooldown tables and text sanitization at production capacities and windows.
- `bun run perf:disk-transport`: Measures main-thread business-channel queue overhead, ACK throughput, and latency against a mock Worker to isolate IPC transport from disk latency.

---

## Full Performance Benchmark

`bun run perf:full` runs only for releases or explicit benchmark requests and enforces no pass/fail threshold. It executes six sections across `FULL_SUITE_ROUNDS` isolated child-process rounds and reports mean, min, max, and coefficient of variation:
1. **Cold start**: Service startup and state hydration latency on fully populated fixtures.
2. **Production hot paths**: Per-message ingress-to-dispatch latency on core pipelines.
3. **End-to-end persistence**: Main-thread mutation to Worker disk flush and ACK latency, plus full command chains.
4. **SQLite and main-thread caches**: Coordination throughput between SQLite and main-thread hot LRU caches.
5. **Containers and algorithms**: Core bounded-container operations and high-frequency algorithms.
6. **Join-log capacity line**: Join-log read/write throughput and memory behavior at capacity ceilings.

All benchmark files live under `performance/` at the repository root and are deleted after each run. Passing `--write-doc` updates all three `11-performance.md` files and `performance-result.json` together. `--rounds <n>` is for local diagnostics only and must never be committed.

---

## Commit Workflow

1. **Branch policy**: Only `master` and `dev` exist; feature branches are prohibited. All development happens on `dev`, and direct commits to `master` are forbidden.
2. **Pre-commit checks**:
   - Run `git diff --stat` to confirm no stray untracked files or deployment artifacts are included.
   - Run `git branch --show-current` to confirm the active branch is `dev`.
   - Run `bun run lint && bun run typecheck` or the full `bun run check`.
3. **Pre-merge gate**: `bun run check` must pass completely before merging to `master`. Changes touching persistence schemas, shutdown sequences, or Worker lifecycles must also pass `bun run test:fault-injection`.
4. **Merge procedure**: Merge `dev` into `master` exclusively with `git merge --squash` to produce a single atomic commit.
5. **Commit message convention**: Describe what changed and why using conventional prefixes (`feat:`, `fix:`, `perf:`, `docs:`, etc.); release commits use `release: <version>`.

### Updating README Metrics

Update README and doc coverage figures only when explicitly requested by the user, reading directly from a local full run:
```bash
bun run test:coverage 2>&1 | tail -5          # Test count, file count, expect() count
bun run test:coverage 2>&1 | grep 'All files'  # Function and line coverage
```
- **Trilingual README badges** (Tests and Coverage values).
- **Coverage vector badges**: `public/coverage_light.svg` and `public/coverage_dark.svg`.
- **`<img alt>` text in trilingual READMEs**.
- **The "Measurements for This Documentation Version" line across all three `05-dev-workflow.md` files**.

---

## Release

Every release publishes a GitHub Release carrying native standalone binaries across all supported target platforms:

1. **Version selection and gate verification**:
   - Sync remote tags and inspect the current Latest Release via `gh release list`.
   - Pick the next semantic version without a `v` prefix (`MAJOR.MINOR.PATCH`).
   - Finish all changes on `dev` and pass `bun run check` (plus `bun run test:fault-injection` when applicable).
2. **Update performance benchmark readings**:
   - Stop local bot services and other heavy workloads so the machine is idle.
   - Run `bun run perf:full -- --write-doc` with default rounds and commit the updated `11-performance.md` files and `performance-result.json` to `dev`.
3. **Native cross-platform builds**:
   - Target platforms are listed in `RELEASE_PLATFORMS` (`linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`).
   - On a native host for each target platform, check out the clean `dev` commit and run `bun run release:build -- --version <tag>`.
   - Gather every archive and `.sha256` file into a single staging directory.
4. **Release asset verification**:
   - From a clean working tree at the same commit, verify all staged archives:
     ```bash
     bun run release:verify -- --version <tag> --platforms <comma-separated-platforms> --directory <staging-directory>
     ```
   - Checks SHA-256 sums, embedded version and Git tree metadata, target architecture, required runtime files and cold-migration CLIs, exact archive entry allowlists against Git-tracked bundled sources (rejecting any unexpected/ignored files, extra directories, or symlinks), dependency integrity, and absence of `.map` files or `node_modules`.
5. **Merge and tag creation**:
   - Merge `dev` into `master` via `git merge --squash` and confirm the resulting Git tree hash matches the built binaries.
   - Push `master`, then create and push an annotated version tag on that commit.
6. **Publish to GitHub**:
   - Write English release notes covering Highlights, Compatibility / Migration Notes, and measured coverage figures.
   - Create the draft, upload and re-verify assets, and publish as Latest:
     ```bash
     bun run release:publish -- --version <tag> --platforms <comma-separated-platforms> --notes-file <notes-file> --directory <staging-directory>
     ```
7. **Align `dev` branch**:
   - After confirming the published release, verify `git diff dev master --quiet`.
   - Align `dev` to `master` via `git reset --hard master` and `git push --force-with-lease origin dev`.

---

<div align="center">

[← Prev: 04 Invariants](04-invariants.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#05-development-workflow-and-quality-gates) · [Next: 06 Recipes →](06-modification-guide.md)

</div>
