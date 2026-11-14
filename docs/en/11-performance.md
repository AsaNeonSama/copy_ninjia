# 11 Performance Benchmark

<p align="center">
  <a href="../cn/11-performance.md">简体中文</a> · <b>English</b> · <a href="../ja/11-performance.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Documentation home</a> · <a href="10-mini-app.md">← Prev: 10 Mini App Setup</a> · <a href="12-faq.md">Next: 12 FAQ →</a>
</p>

---

The benchmark metrics on this page are generated automatically by `bun run perf:full -- --write-doc`. They are recalculated and updated as a whole block during each official release.
**Do not manually edit the content between the benchmark markers below**; release scripts synchronize all three language documents concurrently.

Running the command also writes the **full structured report** (hardware environment, test partitions, per-item execution times, and coefficients of variation) into `fullSuite.lastRun` in `performance-result.json` at the repository root. The markdown table and JSON records are committed atomically via the `--write-doc` flag.

The full benchmark suite runs exclusively before releases or upon explicit request; it is not included in the standard `bun run check` CI gate. Memory, GC pause, and JIT compilation limits for production hot paths are enforced separately by `bun run perf:hot-path-gate` (see [05 Development Workflow and Quality Gates](05-dev-workflow.md)).

For targeted benchmarks and reproduction instructions for `bun run perf:disk-transport`, see [05 Development Workflow](05-dev-workflow.md#targeted-scenarios-and-transport-stress-validation). Targeted scenario results are recorded separately and do not overwrite the full suite benchmark block below.

<!-- performance-benchmark:start -->

**Latest full benchmark** · Bun 1.4.4 · 3-run mean · 2026-11-14T16:49:00Z · Process start to local recovery ready 358.6 ms · Route one group message through base dispatch 113.9 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 191.7 µs / 4,414 ops/s · Ad detection: fully classify and dispose of one group message (no network) 1.72 ms / 453 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.4 (`38afee6c84fcf48c0edb2466aa4b27d287a59c30`) |
| Kernel | linux 6.8.0-149-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-11-14T16:49:00Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 394,548,253 |
| Process reads | 183.35 MiB |
| Process writes | 186.14 MiB |
| Block-device reads | 650.67 KiB |
| Block-device writes | 235.36 MiB |
| Read syscalls | 49,976 |
| Write syscalls | 245,813 |
| Mock root on disk | 14.84 MiB |
| Mock root files | 142 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 114.0 ms | ±2.5% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 10.84 ms | ±5.7% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 700.9 µs | ±2.5% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.33 ms | ±3.4% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.89 ms | ±3.9% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 655.2 µs | ±2.1% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 212.7 ms | ±0.8% |
| Populate main-thread hot caches<br><code>hydrate</code> | 349.8 µs | ±4.8% |
| Process start to local recovery ready<br><code>ready-total</code> | 358.6 ms | ±1.5% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 116.13 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 113.9 ns | 8,812,114 ops/s | 92.49 MiB | 18.00 KiB | ±6.2% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 72.8 ns | 13,737,935 ops/s | 93.66 MiB | 20.92 KiB | ±1.7% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 1.2 ns | 864,575,427 ops/s | 81.26 MiB | 28.06 KiB | ±2.0% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 13.5 ns | 74,152,680 ops/s | 81.41 MiB | 28.82 KiB | ±1.4% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 32.2 ns | 31,024,718 ops/s | 82.50 MiB | 28.96 KiB | ±1.0% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,165,334,218 ops/s | 80.09 MiB | 28.66 KiB | ±0.6% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 41.5 ns | 24,240,429 ops/s | 81.57 MiB | 29.03 KiB | ±8.1% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.2 ns | 238,489,720 ops/s | 80.19 MiB | 27.76 KiB | ±1.7% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 9.7 ns | 103,314,761 ops/s | 80.36 MiB | 26.88 KiB | ±1.0% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 34.3 ns | 29,250,816 ops/s | 85.29 MiB | 28.62 KiB | ±5.9% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 1.171 µs | 853,990 ops/s | 105.63 MiB | 24.60 KiB | ±0.7% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 57.5 ns | 17,388,327 ops/s | 87.28 MiB | 28.69 KiB | ±1.6% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 42.2 ns | 23,731,120 ops/s | 90.55 MiB | 28.50 KiB | ±3.3% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 47.8 ns | 20,926,595 ops/s | 83.80 MiB | 28.30 KiB | ±1.7% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 166.0 ns | 6,038,208 ops/s | 96.67 MiB | 20.96 KiB | ±5.0% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 303.5 ns | 3,321,698 ops/s | 140.35 MiB | 20.93 KiB | ±9.2% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.8 ns | 209,670,018 ops/s | 81.00 MiB | 26.71 KiB | ±5.6% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 2.456 µs | 407,175 ops/s | 91.29 MiB | 23.61 KiB | ±0.4% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 30.6 ns | 32,688,801 ops/s | 90.88 MiB | 19.55 KiB | ±2.7% |
| Build one AI context message<br><code>buffered-message-build</code> | 228.7 ns | 4,372,087 ops/s | 91.32 MiB | 22.60 KiB | ±0.7% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 37.70 µs | 26,530 ops/s | 102.26 MiB | 22.78 KiB | ±1.3% |
| Extract a reply reference<br><code>reply-reference</code> | 25.2 ns | 39,756,921 ops/s | 91.70 MiB | 23.89 KiB | ±1.5% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 40.6 ns | 24,638,181 ops/s | 101.56 MiB | 30.19 KiB | ±2.0% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.0 ns | 248,749,990 ops/s | 81.70 MiB | 26.70 KiB | ±0.4% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 37.6 ns | 26,654,956 ops/s | 88.61 MiB | 28.92 KiB | ±4.2% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 19.9 ns | 50,217,820 ops/s | 80.48 MiB | 27.45 KiB | ±0.8% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 14.9 ns | 66,964,824 ops/s | 80.18 MiB | 28.11 KiB | ±0.7% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 84.0 ns | 11,898,852 ops/s | 80.53 MiB | 28.45 KiB | ±0.8% |
| Mini App backend: verify dual-layer auth and query managed chat status summaries<br><code>mini-app-status-route</code> | 7.611 µs | 131,485 ops/s | 92.81 MiB | 25.59 KiB | ±2.6% |
| Mini App frontend: diff status cards, format metrics and compute FLIP/spring animation frames<br><code>mini-app-frontend-render</code> | 544.0 ns | 1,838,987 ops/s | 100.84 MiB | 34.10 KiB | ±1.9% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop. The cron.json row measures only the cost of a mid-run change and runs no task: the task table is at the production limit (128 tasks with 16 actions each, local sources relative to the data root); after one task is changed, the six hot-reloadable files are read and strictly parsed in production order (including a check of every local source), the snapshots are replaced and the scheduler is reconciled by task name. Rewriting and saving the file belong to the deployer and are not timed, nor are the file watcher's debounce wait, the following ad-detection and AI chat availability checks, or the reload log lines. The five Mini App rows isolate key request paths from `Bun.serve` route entry onward: the API request row runs the synchronous auth pipeline (header guard, Telegram WebApp `initData` HMAC-SHA256 signature and super-admin check, and 45-minute password session verification), managed chat state and QA/hot-message aggregation, a 24-hour join-log query via the real Disk I/O Worker aggregated across 1–24h rolling windows, and HTTP JSON response serialization and parsing; the other four rows measure pre-split attribute injection on unauthorized reject pages, page-gate cookie allowance, `POST /api/auth/login` verification/issuance, and protected `?token=` gallery asset delivery.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 923 ops/s | 1.08 ms | 1.02 ms | 1.34 ms | 7.20 ms | 923 records/s | 3.91 MiB | ±2.2% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 350 ops/s | 2.86 ms | 2.79 ms | 4.92 ms | 14.86 ms | 44,747 records/s | 21.42 MiB | ±3.9% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 715 ops/s | 1.42 ms | 1.20 ms | 2.55 ms | 10.72 ms | 715 records/s | 3.15 MiB | ±13.3% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 787 ops/s | 1.28 ms | 1.16 ms | 1.96 ms | 5.43 ms | 787 records/s | 3.13 MiB | ±8.0% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 750 ops/s | 1.33 ms | 1.28 ms | 1.64 ms | 7.56 ms | 750 records/s | 3.13 MiB | ±2.1% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 404 ops/s | 2.48 ms | 2.24 ms | 3.40 ms | 14.37 ms | 404 records/s | 5.55 MiB | ±3.6% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 877 ops/s | 1.14 ms | 1.06 ms | 1.48 ms | 11.33 ms | 877 records/s | 4.16 MiB | ±2.7% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 453 ops/s | 2.31 ms | 1.72 ms | 4.60 ms | 16.54 ms | 453 records/s | 1.82 MiB | ±23.4% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 4,414 ops/s | 224.1 µs | 191.7 µs | 457.3 µs | 562.7 µs | 4,414 records/s | 0 B | ±2.9% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 5 ops/s | 214.8 ms | 214.5 ms | 218.8 ms | 222.0 ms | 5 records/s | 0 B | ±2.3% |
| cron.json change to one task: hot reload and reschedule (full-size task table)<br><code>cron-config-reload</code> | 9 ops/s | 117.0 ms | 115.9 ms | 128.7 ms | 145.8 ms | 9 records/s | 7.31 MiB | ±0.7% |
| Mini App API request: full sync auth pipeline, chat detail aggregation and 24h join-log query (GET /api/chats/:chatId)<br><code>mini-app-api-request</code> | 6,361 ops/s | 175.1 µs | 132.3 µs | 384.0 µs | 1.99 ms | 6,361 records/s | 0 B | ±29.0% |
| Mini App unauthorized reject page: access diagnostics and reject.html attribute injection (serveMiniAppRejectHtml)<br><code>mini-app-reject-page</code> | 21,996 ops/s | 45.25 µs | 28.49 µs | 76.88 µs | 1.86 ms | 21,996 records/s | 0 B | ±3.0% |
| Mini App SPA page gate allow: Cookie HMAC-SHA256 verification and lockout check (evaluateMiniAppPageGateRequest)<br><code>mini-app-page-gate-allow</code> | 201,855 ops/s | 4.941 µs | 3.238 µs | 7.563 µs | 1.92 ms | 201,855 records/s | 28.00 KiB | ±24.3% |
| Mini App login endpoint: initData HMAC, password verification, session and gate cookie issuance (POST /api/auth/login)<br><code>mini-app-auth-login</code> | 26,907 ops/s | 36.77 µs | 28.87 µs | 57.17 µs | 2.65 ms | 26,907 records/s | 0 B | ±1.8% |
| Mini App protected gallery asset: ?token= asset verification and cached file response (GET /api/gallery/file/:fileName)<br><code>mini-app-gallery-asset</code> | 15,203 ops/s | 65.35 µs | 57.89 µs | 92.78 µs | 920.2 µs | 15,203 records/s | 0 B | ±1.4% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 37,640,795 ops/s | 214.1 ns | 0 B | 12.75 KiB | ±8.3% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 45,744 ops/s | 2.80 ms | 56.55 MiB | 23.59 KiB | ±3.0% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 347,885 ops/s | 23.07 µs | 5.30 MiB | -11.04 KiB | ±5.6% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 10,953 ops/s | 730.4 µs | 34.02 MiB | 206.13 KiB | ±0.7% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 63,966 ops/s | 2.01 ms | 73.15 MiB | 129.93 KiB | ±5.4% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 20,586 ops/s | 6.22 ms | 12.60 MiB | 424.02 KiB | ±2.1% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 17.6 ns | 57,026,584 ops/s | 91.33 MiB | 23.08 KiB | ±6.5% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 28.6 ns | 35,083,495 ops/s | 83.07 MiB | 28.72 KiB | ±5.1% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 15.7 ns | 64,269,681 ops/s | 91.25 MiB | 28.32 KiB | ±10.6% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 197.6 ms | 2.56 MiB | 6.45 KiB | ±4.1% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 3.64 ms | 0 B | -4.76 KiB | ±2.3% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 10 Mini App Setup](10-mini-app.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#11-performance-benchmark) · [Next: 12 FAQ →](12-faq.md)

</div>
