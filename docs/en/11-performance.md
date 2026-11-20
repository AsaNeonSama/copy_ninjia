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

**Latest full benchmark** · Bun 1.4.5 · 3-run mean · 2026-11-20T21:28:00Z · Process start to local recovery ready 406.8 ms · Route one group message through base dispatch 104.6 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 196.9 µs / 4,374 ops/s · Ad detection: fully classify and dispose of one group message (no network) 1.79 ms / 457 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.5 (`a7733435cf40429e3b35c36072769df2052b80f1`) |
| Kernel | linux 6.8.0-149-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-11-20T21:28:00Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 394,548,253 |
| Process reads | 183.76 MiB |
| Process writes | 186.55 MiB |
| Block-device reads | 0 B |
| Block-device writes | 235.61 MiB |
| Read syscalls | 50,154 |
| Write syscalls | 275,483 |
| Mock root on disk | 15.02 MiB |
| Mock root files | 144 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 128.2 ms | ±7.0% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 12.76 ms | ±6.6% |
| Remove interrupted atomic-write temporary files and check the config layout<br><code>orphan-cleanup</code> | 1.61 ms | ±7.0% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.56 ms | ±15.7% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 6.29 ms | ±7.7% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 707.6 µs | ±4.9% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 236.5 ms | ±7.4% |
| Populate main-thread hot caches<br><code>hydrate</code> | 4.72 ms | ±1.1% |
| Process start to local recovery ready<br><code>ready-total</code> | 406.8 ms | ±6.6% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 125.33 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 104.6 ns | 9,564,044 ops/s | 98.69 MiB | 16.82 KiB | ±2.2% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 70.9 ns | 14,096,612 ops/s | 103.77 MiB | 22.01 KiB | ±0.7% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 1.2 ns | 861,560,470 ops/s | 91.61 MiB | 27.09 KiB | ±0.7% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 13.2 ns | 75,622,415 ops/s | 91.74 MiB | 28.09 KiB | ±3.2% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 31.4 ns | 31,883,621 ops/s | 92.49 MiB | 28.47 KiB | ±1.0% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.8 ns | 1,185,316,424 ops/s | 89.26 MiB | 27.25 KiB | ±0.9% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 48.9 ns | 20,440,277 ops/s | 91.25 MiB | 28.20 KiB | ±1.6% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.2 ns | 238,578,437 ops/s | 89.29 MiB | 27.28 KiB | ±1.7% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 9.6 ns | 103,904,739 ops/s | 89.44 MiB | 27.66 KiB | ±0.6% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 33.5 ns | 29,969,514 ops/s | 93.94 MiB | 27.93 KiB | ±7.2% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 1.114 µs | 898,217 ops/s | 115.89 MiB | 23.87 KiB | ±2.6% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 48.7 ns | 20,555,396 ops/s | 95.18 MiB | 27.20 KiB | ±0.5% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 41.5 ns | 24,100,249 ops/s | 99.99 MiB | 27.24 KiB | ±2.0% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 49.1 ns | 20,389,204 ops/s | 92.93 MiB | 27.79 KiB | ±1.5% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 191.0 ns | 5,246,194 ops/s | 102.34 MiB | 20.78 KiB | ±4.6% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 211.2 ns | 4,741,021 ops/s | 142.67 MiB | 22.65 KiB | ±3.4% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.6 ns | 221,218,033 ops/s | 90.73 MiB | 26.93 KiB | ±8.4% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 2.452 µs | 407,804 ops/s | 100.86 MiB | 23.09 KiB | ±1.0% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 21.0 ns | 47,753,207 ops/s | 101.35 MiB | 24.00 KiB | ±3.9% |
| Build one AI context message<br><code>buffered-message-build</code> | 228.0 ns | 4,386,675 ops/s | 100.52 MiB | 22.45 KiB | ±1.0% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 34.63 µs | 28,873 ops/s | 112.42 MiB | 23.55 KiB | ±0.1% |
| Extract a reply reference<br><code>reply-reference</code> | 34.5 ns | 30,981,201 ops/s | 100.96 MiB | 22.96 KiB | ±24.7% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 41.7 ns | 23,973,710 ops/s | 110.22 MiB | 27.52 KiB | ±1.4% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.2 ns | 235,886,878 ops/s | 91.00 MiB | 26.84 KiB | ±0.4% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 37.4 ns | 26,779,556 ops/s | 97.99 MiB | 27.96 KiB | ±3.5% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 16.3 ns | 61,177,351 ops/s | 90.76 MiB | 28.01 KiB | ±1.5% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 14.9 ns | 66,910,582 ops/s | 90.28 MiB | 27.41 KiB | ±0.9% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 78.6 ns | 12,732,892 ops/s | 89.93 MiB | 27.41 KiB | ±2.4% |
| Mini App backend: verify dual-layer auth and query managed chat status summaries<br><code>mini-app-status-route</code> | 7.578 µs | 132,377 ops/s | 103.38 MiB | 26.13 KiB | ±5.8% |
| Mini App frontend: diff status cards, format metrics and compute FLIP/spring animation frames<br><code>mini-app-frontend-render</code> | 572.7 ns | 1,748,604 ops/s | 110.15 MiB | 34.90 KiB | ±3.9% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop. The cron.json row measures only the cost of a mid-run change and runs no task: the task table is at the production limit (128 tasks with 16 actions each, local sources relative to the data root); after one task is changed, the six hot-reloadable files are read and strictly parsed in production order (including a check of every local source), the snapshots are replaced and the scheduler is reconciled by task name. Rewriting and saving the file belong to the deployer and are not timed, nor are the file watcher's debounce wait, the following ad-detection and AI chat availability checks, or the reload log lines. The five Mini App rows isolate key request paths from `Bun.serve` route entry onward: the API request row runs the synchronous auth pipeline (header guard, Telegram WebApp `initData` HMAC-SHA256 signature and super-admin check, and 45-minute session verification), managed chat state and QA/hot-message aggregation, a 24-hour join-log query via the real Disk I/O Worker aggregated across 1–24h rolling windows, and AES-256-GCM response envelope encryption, decryption, and JSON parsing; the other four rows measure pre-split attribute injection on unauthorized reject pages, page-gate cookie allowance, TLS-mode precheck Ed25519-signed ephemeral X25519 ECDH + HKDF encrypted `POST /api/auth/login` 45-minute AES-256 PSK issuance, and encrypted `?e=` protected gallery asset delivery.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 897 ops/s | 1.12 ms | 1.04 ms | 1.38 ms | 7.77 ms | 897 records/s | 3.91 MiB | ±2.6% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 352 ops/s | 2.84 ms | 2.81 ms | 4.46 ms | 12.41 ms | 45,074 records/s | 21.42 MiB | ±0.3% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 781 ops/s | 1.29 ms | 1.17 ms | 2.04 ms | 8.21 ms | 781 records/s | 3.15 MiB | ±8.7% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 665 ops/s | 1.53 ms | 1.28 ms | 3.30 ms | 9.09 ms | 665 records/s | 3.13 MiB | ±12.4% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 674 ops/s | 1.49 ms | 1.37 ms | 1.87 ms | 8.97 ms | 674 records/s | 3.13 MiB | ±5.5% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 380 ops/s | 2.63 ms | 2.41 ms | 3.94 ms | 11.24 ms | 380 records/s | 5.55 MiB | ±1.0% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 840 ops/s | 1.19 ms | 1.12 ms | 1.44 ms | 8.98 ms | 840 records/s | 4.11 MiB | ±4.3% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 457 ops/s | 2.27 ms | 1.79 ms | 4.74 ms | 9.87 ms | 457 records/s | 1.82 MiB | ±20.0% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 4,374 ops/s | 225.9 µs | 196.9 µs | 431.4 µs | 583.5 µs | 4,374 records/s | 0 B | ±1.2% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 4 ops/s | 223.4 ms | 222.7 ms | 233.4 ms | 236.6 ms | 4 records/s | 0 B | ±0.8% |
| cron.json change to one task: hot reload and reschedule (full-size task table)<br><code>cron-config-reload</code> | 8 ops/s | 120.3 ms | 117.5 ms | 137.9 ms | 165.3 ms | 8 records/s | 7.31 MiB | ±1.1% |
| Mini App API request: full sync auth pipeline, chat detail aggregation and 24h join-log query (GET /api/chats/detail?e=...)<br><code>mini-app-api-request</code> | 2,713 ops/s | 367.5 µs | 327.6 µs | 483.4 µs | 4.90 ms | 2,713 records/s | 0 B | ±0.9% |
| Mini App unauthorized reject page: access diagnostics and reject.html attribute injection (serveMiniAppRejectHtml)<br><code>mini-app-reject-page</code> | 21,387 ops/s | 46.80 µs | 29.68 µs | 90.22 µs | 924.9 µs | 21,387 records/s | 0 B | ±8.2% |
| Mini App SPA page gate allow: Cookie HMAC-SHA256 verification and lockout check (evaluateMiniAppPageGateRequest)<br><code>mini-app-page-gate-allow</code> | 235,217 ops/s | 4.075 µs | 3.236 µs | 7.960 µs | 64.80 µs | 235,217 records/s | 18.67 KiB | ±1.6% |
| Mini App ECDH login handshake: precheck Ed25519-signed ephemeral X25519 key exchange, HKDF derivation and encrypted login issuing 45m AES PSK (GET /api/auth/precheck → POST /api/auth/login)<br><code>mini-app-auth-login</code> | 1,323 ops/s | 754.8 µs | 698.5 µs | 956.1 µs | 5.71 ms | 1,323 records/s | 364.00 KiB | ±1.0% |
| Mini App protected gallery asset: dual-layer session & ?e= query verification and cached file response (GET /api/gallery/file?e=...)<br><code>mini-app-gallery-asset</code> | 4,577 ops/s | 218.7 µs | 192.6 µs | 296.7 µs | 3.19 ms | 4,577 records/s | 0 B | ±7.1% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 39,755,559 ops/s | 201.3 ns | 0 B | 13.01 KiB | ±2.0% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 42,175 ops/s | 3.04 ms | 56.55 MiB | 23.15 KiB | ±3.8% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 395,304 ops/s | 20.24 µs | 5.30 MiB | 19.09 KiB | ±1.2% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 10,655 ops/s | 750.9 µs | 34.02 MiB | 203.99 KiB | ±0.4% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 65,812 ops/s | 1.95 ms | 73.15 MiB | 129.33 KiB | ±2.8% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 19,530 ops/s | 6.56 ms | 12.60 MiB | 420.92 KiB | ±1.8% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 16.0 ns | 62,609,474 ops/s | 99.98 MiB | 23.00 KiB | ±6.9% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 32.6 ns | 31,251,582 ops/s | 92.31 MiB | 27.55 KiB | ±12.8% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 19.6 ns | 51,123,908 ops/s | 100.89 MiB | 28.20 KiB | ±6.0% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 96.22 ms | 4.20 MiB | 5.36 KiB | ±0.8% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 3.64 ms | 0 B | -4.76 KiB | ±1.2% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 10 Mini App Setup](10-mini-app.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#11-performance-benchmark) · [Next: 12 FAQ →](12-faq.md)

</div>
