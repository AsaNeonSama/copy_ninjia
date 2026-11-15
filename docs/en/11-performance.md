# 11 Performance Benchmark

<p align="center">
  <a href="../cn/11-performance.md">简体中文</a> · <b>English</b> · <a href="../ja/11-performance.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Documentation home</a> · <a href="10-mini-app.md">← Prev: 10 Mini App Setup</a> · <a href="12-faq.md">Next: 12 FAQ →</a>
</p>

---

The benchmark results on this page are generated automatically by `bun run perf:full -- --write-doc` and replaced as a complete block on every release.
**Do not edit anything between the benchmark markers below**—the release script updates the Chinese, English, and Japanese pages together.

- **Structured JSON report**: Running `--write-doc` atomically writes both the Markdown block below and the full structured report (host hardware, benchmark sections, per-case means, and coefficients of variation) under `fullSuite.lastRun` in `performance-result.json` at the repository root.
- **Release vs. routine CI gates**: The full benchmark suite runs only for releases or on explicit request and is not part of `bun run check`. Production hot-path GC, RSS, and JIT hard limits are enforced independently by `bun run perf:hot-path-gate` (see [05 Development Workflow and Quality Gates](05-dev-workflow.md)).
- **Targeted scenario benchmarks**: Measurement boundaries and reproduction steps for targeted stress scripts such as `bun run perf:disk-transport` are documented in [05 Development Workflow](05-dev-workflow.md#targeted-scenarios-and-transport-stress-validation); their outputs are recorded separately and never overwrite the full-suite block below.

<!-- performance-benchmark:start -->

**Latest full benchmark** · Bun 1.4.4 · 3-run mean · 2026-11-15T09:55:28Z · Process start to local recovery ready 405.6 ms · Route one group message through base dispatch 106.2 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 200.5 µs / 4,411 ops/s · Ad detection: fully classify and dispose of one group message (no network) 1.77 ms / 497 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.4 (`38afee6c84fcf48c0edb2466aa4b27d287a59c30`) |
| Kernel | linux 6.8.0-149-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-11-15T09:55:28Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 394,548,253 |
| Process reads | 183.35 MiB |
| Process writes | 186.14 MiB |
| Block-device reads | 85.33 KiB |
| Block-device writes | 235.36 MiB |
| Read syscalls | 49,986 |
| Write syscalls | 245,843 |
| Mock root on disk | 14.84 MiB |
| Mock root files | 142 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 118.3 ms | ±2.3% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 13.04 ms | ±11.8% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 676.7 µs | ±2.9% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.31 ms | ±2.9% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.76 ms | ±2.8% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 666.1 µs | ±3.4% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 253.3 ms | ±12.0% |
| Populate main-thread hot caches<br><code>hydrate</code> | 340.1 µs | ±3.5% |
| Process start to local recovery ready<br><code>ready-total</code> | 405.6 ms | ±8.1% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 115.79 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 106.2 ns | 9,427,994 ops/s | 91.80 MiB | 18.25 KiB | ±4.1% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 71.7 ns | 13,949,425 ops/s | 93.88 MiB | 22.01 KiB | ±2.2% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 1.1 ns | 873,899,875 ops/s | 81.57 MiB | 27.56 KiB | ±1.7% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 13.1 ns | 76,513,877 ops/s | 81.38 MiB | 28.86 KiB | ±1.7% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 31.8 ns | 31,462,166 ops/s | 82.79 MiB | 28.92 KiB | ±1.5% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,163,854,203 ops/s | 79.50 MiB | 28.26 KiB | ±2.4% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 42.8 ns | 23,488,122 ops/s | 81.82 MiB | 28.63 KiB | ±7.4% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.1 ns | 241,319,549 ops/s | 80.15 MiB | 28.00 KiB | ±1.0% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 9.5 ns | 105,303,832 ops/s | 81.40 MiB | 28.63 KiB | ±1.0% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 36.3 ns | 27,747,215 ops/s | 83.82 MiB | 28.19 KiB | ±8.9% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 1.138 µs | 879,656 ops/s | 105.72 MiB | 23.83 KiB | ±3.0% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 58.3 ns | 17,159,299 ops/s | 87.05 MiB | 27.78 KiB | ±2.1% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 42.0 ns | 23,809,645 ops/s | 90.62 MiB | 27.66 KiB | ±0.5% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 47.5 ns | 21,039,740 ops/s | 83.12 MiB | 28.67 KiB | ±1.2% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 157.7 ns | 6,348,692 ops/s | 96.24 MiB | 19.63 KiB | ±3.7% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 285.3 ns | 3,506,817 ops/s | 136.46 MiB | 22.15 KiB | ±1.9% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.7 ns | 212,654,995 ops/s | 81.70 MiB | 26.80 KiB | ±5.5% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 2.472 µs | 404,582 ops/s | 91.68 MiB | 23.41 KiB | ±1.4% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 31.4 ns | 31,897,789 ops/s | 90.41 MiB | 19.12 KiB | ±1.1% |
| Build one AI context message<br><code>buffered-message-build</code> | 221.1 ns | 4,526,511 ops/s | 92.00 MiB | 21.86 KiB | ±2.6% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 37.57 µs | 26,622 ops/s | 102.34 MiB | 23.10 KiB | ±1.0% |
| Extract a reply reference<br><code>reply-reference</code> | 32.0 ns | 33,702,636 ops/s | 90.81 MiB | 23.66 KiB | ±29.6% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 44.0 ns | 22,780,000 ops/s | 100.90 MiB | 29.67 KiB | ±5.2% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.3 ns | 234,225,582 ops/s | 80.61 MiB | 26.89 KiB | ±6.1% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 37.2 ns | 26,907,635 ops/s | 87.95 MiB | 29.38 KiB | ±2.9% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 19.9 ns | 50,387,087 ops/s | 80.63 MiB | 26.71 KiB | ±2.6% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 15.0 ns | 66,465,873 ops/s | 79.85 MiB | 27.09 KiB | ±1.2% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 84.6 ns | 11,822,016 ops/s | 79.97 MiB | 28.52 KiB | ±2.0% |
| Mini App backend: verify dual-layer auth and query managed chat status summaries<br><code>mini-app-status-route</code> | 7.933 µs | 126,103 ops/s | 92.28 MiB | 25.79 KiB | ±1.9% |
| Mini App frontend: diff status cards, format metrics and compute FLIP/spring animation frames<br><code>mini-app-frontend-render</code> | 533.8 ns | 1,873,471 ops/s | 100.55 MiB | 34.63 KiB | ±0.9% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop. The cron.json row measures only the cost of a mid-run change and runs no task: the task table is at the production limit (128 tasks with 16 actions each, local sources relative to the data root); after one task is changed, the six hot-reloadable files are read and strictly parsed in production order (including a check of every local source), the snapshots are replaced and the scheduler is reconciled by task name. Rewriting and saving the file belong to the deployer and are not timed, nor are the file watcher's debounce wait, the following ad-detection and AI chat availability checks, or the reload log lines. The five Mini App rows isolate key request paths from `Bun.serve` route entry onward: the API request row runs the synchronous auth pipeline (header guard, Telegram WebApp `initData` HMAC-SHA256 signature and super-admin check, and 45-minute password session verification), managed chat state and QA/hot-message aggregation, a 24-hour join-log query via the real Disk I/O Worker aggregated across 1–24h rolling windows, and HTTP JSON response serialization and parsing; the other four rows measure pre-split attribute injection on unauthorized reject pages, page-gate cookie allowance, `POST /api/auth/login` verification/issuance, and protected `?token=` gallery asset delivery.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 849 ops/s | 1.18 ms | 1.10 ms | 1.45 ms | 8.54 ms | 849 records/s | 3.91 MiB | ±1.2% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 332 ops/s | 3.01 ms | 2.91 ms | 5.07 ms | 15.72 ms | 42,479 records/s | 21.42 MiB | ±1.8% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 718 ops/s | 1.43 ms | 1.22 ms | 2.54 ms | 7.32 ms | 718 records/s | 3.15 MiB | ±15.2% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 663 ops/s | 1.52 ms | 1.26 ms | 2.83 ms | 13.46 ms | 663 records/s | 3.13 MiB | ±10.6% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 690 ops/s | 1.45 ms | 1.36 ms | 1.78 ms | 8.83 ms | 690 records/s | 3.13 MiB | ±3.8% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 381 ops/s | 2.62 ms | 2.37 ms | 3.91 ms | 10.76 ms | 381 records/s | 5.55 MiB | ±1.3% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 739 ops/s | 1.35 ms | 1.13 ms | 2.26 ms | 16.37 ms | 739 records/s | 4.16 MiB | ±3.0% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 497 ops/s | 2.05 ms | 1.77 ms | 3.40 ms | 9.09 ms | 497 records/s | 1.82 MiB | ±12.3% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 4,411 ops/s | 224.2 µs | 200.5 µs | 434.3 µs | 646.8 µs | 4,411 records/s | 0 B | ±0.5% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 5 ops/s | 210.2 ms | 209.9 ms | 214.7 ms | 217.5 ms | 5 records/s | 0 B | ±1.1% |
| cron.json change to one task: hot reload and reschedule (full-size task table)<br><code>cron-config-reload</code> | 9 ops/s | 116.7 ms | 116.3 ms | 133.6 ms | 136.7 ms | 9 records/s | 7.31 MiB | ±1.5% |
| Mini App API request: full sync auth pipeline, chat detail aggregation and 24h join-log query (GET /api/chats/:chatId)<br><code>mini-app-api-request</code> | 7,391 ops/s | 135.7 µs | 116.8 µs | 218.3 µs | 1.06 ms | 7,391 records/s | 0 B | ±8.3% |
| Mini App unauthorized reject page: access diagnostics and reject.html attribute injection (serveMiniAppRejectHtml)<br><code>mini-app-reject-page</code> | 22,197 ops/s | 44.84 µs | 28.52 µs | 79.08 µs | 1.23 ms | 22,197 records/s | 0 B | ±2.9% |
| Mini App SPA page gate allow: Cookie HMAC-SHA256 verification and lockout check (evaluateMiniAppPageGateRequest)<br><code>mini-app-page-gate-allow</code> | 239,538 ops/s | 4.004 µs | 3.210 µs | 7.776 µs | 51.77 µs | 239,538 records/s | 28.00 KiB | ±2.7% |
| Mini App login endpoint: initData HMAC, password verification, session and gate cookie issuance (POST /api/auth/login)<br><code>mini-app-auth-login</code> | 26,498 ops/s | 37.48 µs | 29.14 µs | 56.81 µs | 3.62 ms | 26,498 records/s | 0 B | ±3.9% |
| Mini App protected gallery asset: ?token= asset verification and cached file response (GET /api/gallery/file/:fileName)<br><code>mini-app-gallery-asset</code> | 13,047 ops/s | 78.89 µs | 70.45 µs | 115.6 µs | 920.3 µs | 13,047 records/s | 0 B | ±17.7% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 40,424,637 ops/s | 197.9 ns | 0 B | 12.51 KiB | ±0.9% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 44,251 ops/s | 2.89 ms | 56.55 MiB | 23.15 KiB | ±1.6% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 357,277 ops/s | 22.40 µs | 5.30 MiB | 17.31 KiB | ±2.2% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 10,730 ops/s | 747.0 µs | 34.02 MiB | 202.35 KiB | ±4.4% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 62,366 ops/s | 2.05 ms | 73.15 MiB | 129.90 KiB | ±1.4% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 18,115 ops/s | 7.08 ms | 12.60 MiB | 423.72 KiB | ±3.8% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 17.0 ns | 59,027,553 ops/s | 91.26 MiB | 23.09 KiB | ±3.6% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 28.6 ns | 35,157,015 ops/s | 84.14 MiB | 28.74 KiB | ±7.3% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 19.1 ns | 52,390,672 ops/s | 90.87 MiB | 28.98 KiB | ±1.0% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 198.2 ms | 3.21 MiB | 6.45 KiB | ±1.9% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 3.64 ms | 0 B | -4.76 KiB | ±3.0% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 10 Mini App Setup](10-mini-app.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#11-performance-benchmark) · [Next: 12 FAQ →](12-faq.md)

</div>
