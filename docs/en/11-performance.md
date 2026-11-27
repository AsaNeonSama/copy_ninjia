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

**Latest full benchmark** · Bun 1.4.5 · 3-run mean · 2026-11-27T15:00:34Z · Process start to local recovery ready 381.3 ms · Route one group message through base dispatch 106.0 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 178.7 µs / 4,647 ops/s · Ad detection: fully classify and dispose of one group message (no network) 1.84 ms / 511 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.5 (`a7733435cf40429e3b35c36072769df2052b80f1`) |
| Kernel | linux 6.8.0-151-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-11-27T15:00:34Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 394,548,253 |
| Process reads | 184.22 MiB |
| Process writes | 186.61 MiB |
| Block-device reads | 0 B |
| Block-device writes | 235.68 MiB |
| Read syscalls | 50,170 |
| Write syscalls | 275,485 |
| Mock root on disk | 15.11 MiB |
| Mock root files | 144 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 126.4 ms | ±11.8% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 12.54 ms | ±10.6% |
| Remove interrupted atomic-write temporary files and check the config layout<br><code>orphan-cleanup</code> | 1.47 ms | ±5.9% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.38 ms | ±2.2% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 5.74 ms | ±9.7% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 650.9 µs | ±6.5% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 215.1 ms | ±0.4% |
| Populate main-thread hot caches<br><code>hydrate</code> | 4.74 ms | ±1.0% |
| Process start to local recovery ready<br><code>ready-total</code> | 381.3 ms | ±4.3% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 126.17 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 106.0 ns | 9,496,678 ops/s | 103.66 MiB | 15.36 KiB | ±8.2% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 69.5 ns | 14,396,262 ops/s | 104.70 MiB | 22.94 KiB | ±0.9% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 1.1 ns | 904,915,277 ops/s | 92.74 MiB | 27.71 KiB | ±0.2% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 13.3 ns | 75,447,292 ops/s | 92.20 MiB | 28.53 KiB | ±4.0% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 31.4 ns | 31,878,858 ops/s | 93.81 MiB | 29.14 KiB | ±0.4% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.8 ns | 1,202,653,366 ops/s | 90.89 MiB | 28.54 KiB | ±1.3% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 45.1 ns | 22,241,642 ops/s | 92.74 MiB | 28.76 KiB | ±5.5% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.0 ns | 250,142,327 ops/s | 90.84 MiB | 28.39 KiB | ±1.5% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 9.4 ns | 106,887,081 ops/s | 92.01 MiB | 27.90 KiB | ±1.0% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 32.6 ns | 30,824,345 ops/s | 95.59 MiB | 28.73 KiB | ±7.4% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 1.076 µs | 930,188 ops/s | 116.34 MiB | 24.14 KiB | ±3.2% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 39.7 ns | 25,226,973 ops/s | 97.54 MiB | 28.72 KiB | ±2.0% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 39.3 ns | 25,441,287 ops/s | 100.85 MiB | 28.01 KiB | ±1.2% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 43.8 ns | 22,928,771 ops/s | 94.72 MiB | 28.51 KiB | ±5.6% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 183.9 ns | 5,445,052 ops/s | 103.02 MiB | 20.65 KiB | ±3.4% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 201.8 ns | 4,957,290 ops/s | 144.46 MiB | 23.01 KiB | ±1.9% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.8 ns | 209,275,521 ops/s | 92.74 MiB | 27.07 KiB | ±5.6% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 2.847 µs | 351,348 ops/s | 101.15 MiB | 23.81 KiB | ±1.7% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 20.2 ns | 49,451,896 ops/s | 102.35 MiB | 26.27 KiB | ±0.5% |
| Build one AI context message<br><code>buffered-message-build</code> | 222.7 ns | 4,492,435 ops/s | 101.08 MiB | 22.63 KiB | ±1.7% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 33.44 µs | 29,913 ops/s | 112.95 MiB | 23.98 KiB | ±1.2% |
| Extract a reply reference<br><code>reply-reference</code> | 27.2 ns | 37,562,889 ops/s | 102.47 MiB | 23.59 KiB | ±15.6% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 39.8 ns | 25,105,779 ops/s | 113.17 MiB | 29.79 KiB | ±0.7% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.0 ns | 247,328,657 ops/s | 91.90 MiB | 27.24 KiB | ±2.3% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 35.6 ns | 28,106,710 ops/s | 99.05 MiB | 25.36 KiB | ±2.7% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 15.5 ns | 64,417,191 ops/s | 91.86 MiB | 27.95 KiB | ±1.2% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 14.6 ns | 68,298,469 ops/s | 91.53 MiB | 26.71 KiB | ±0.8% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 75.7 ns | 13,240,523 ops/s | 91.19 MiB | 28.00 KiB | ±5.0% |
| Mini App backend: verify dual-layer auth and query managed chat status summaries<br><code>mini-app-status-route</code> | 7.222 µs | 138,567 ops/s | 104.46 MiB | 25.81 KiB | ±2.6% |
| Mini App frontend: diff status cards, format metrics and compute FLIP/spring animation frames<br><code>mini-app-frontend-render</code> | 544.1 ns | 1,838,359 ops/s | 112.10 MiB | 34.85 KiB | ±1.3% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop. The cron.json row measures only the cost of a mid-run change and runs no task: the task table is at the production limit (128 tasks with 16 actions each, local sources relative to the data root); after one task is changed, the six hot-reloadable files are read and strictly parsed in production order (including a check of every local source), the snapshots are replaced and the scheduler is reconciled by task name. Rewriting and saving the file belong to the deployer and are not timed, nor are the file watcher's debounce wait, the following ad-detection and AI chat availability checks, or the reload log lines. The five Mini App rows isolate key request paths from `Bun.serve` route entry onward: the API request row runs the synchronous auth pipeline (header guard, Telegram WebApp `initData` HMAC-SHA256 signature and super-admin check, and 45-minute session verification), managed chat state and QA/hot-message aggregation, a 24-hour join-log query via the real Disk I/O Worker aggregated across 1–24h rolling windows, and AES-256-GCM response envelope encryption, decryption, and JSON parsing; the other four rows measure pre-split attribute injection on unauthorized reject pages, page-gate cookie allowance, TLS-mode precheck Ed25519-signed ephemeral X25519 ECDH + HKDF encrypted `POST /api/auth/login` 45-minute AES-256 PSK issuance, and encrypted `?e=` protected gallery asset delivery.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 783 ops/s | 1.28 ms | 1.19 ms | 1.79 ms | 9.07 ms | 783 records/s | 3.91 MiB | ±2.3% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 327 ops/s | 3.06 ms | 2.85 ms | 4.93 ms | 12.78 ms | 41,805 records/s | 21.42 MiB | ±1.5% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 635 ops/s | 1.58 ms | 1.47 ms | 2.13 ms | 7.66 ms | 635 records/s | 3.15 MiB | ±3.0% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 635 ops/s | 1.57 ms | 1.37 ms | 2.45 ms | 9.24 ms | 635 records/s | 3.13 MiB | ±0.8% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 641 ops/s | 1.56 ms | 1.42 ms | 2.14 ms | 7.11 ms | 641 records/s | 3.13 MiB | ±3.7% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 365 ops/s | 2.74 ms | 2.56 ms | 3.88 ms | 11.03 ms | 365 records/s | 5.55 MiB | ±3.8% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 773 ops/s | 1.30 ms | 1.21 ms | 1.71 ms | 16.92 ms | 773 records/s | 4.11 MiB | ±6.7% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 511 ops/s | 1.96 ms | 1.84 ms | 2.48 ms | 7.02 ms | 511 records/s | 1.82 MiB | ±4.4% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 4,647 ops/s | 212.6 µs | 178.7 µs | 386.3 µs | 575.1 µs | 4,647 records/s | 0 B | ±1.8% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 8 ops/s | 119.2 ms | 119.0 ms | 123.6 ms | 124.9 ms | 8 records/s | 0 B | ±0.7% |
| cron.json change to one task: hot reload and reschedule (full-size task table)<br><code>cron-config-reload</code> | 9 ops/s | 112.2 ms | 111.8 ms | 117.2 ms | 119.6 ms | 9 records/s | 7.31 MiB | ±0.1% |
| Mini App API request: full sync auth pipeline, chat detail aggregation and 24h join-log query (GET /api/chats/detail?e=...)<br><code>mini-app-api-request</code> | 2,954 ops/s | 337.9 µs | 292.4 µs | 443.6 µs | 4.31 ms | 2,954 records/s | 1.33 KiB | ±3.2% |
| Mini App unauthorized reject page: access diagnostics and reject.html attribute injection (serveMiniAppRejectHtml)<br><code>mini-app-reject-page</code> | 23,095 ops/s | 43.08 µs | 27.81 µs | 76.77 µs | 869.0 µs | 23,095 records/s | 0 B | ±3.3% |
| Mini App SPA page gate allow: Cookie HMAC-SHA256 verification and lockout check (evaluateMiniAppPageGateRequest)<br><code>mini-app-page-gate-allow</code> | 245,152 ops/s | 3.915 µs | 3.186 µs | 7.515 µs | 51.67 µs | 245,152 records/s | 28.00 KiB | ±0.7% |
| Mini App ECDH login handshake: precheck Ed25519-signed ephemeral X25519 key exchange, HKDF derivation and encrypted login issuing 45m AES PSK (GET /api/auth/precheck → POST /api/auth/login)<br><code>mini-app-auth-login</code> | 1,407 ops/s | 709.4 µs | 665.8 µs | 868.6 µs | 6.46 ms | 1,407 records/s | 364.00 KiB | ±0.2% |
| Mini App protected gallery asset: dual-layer session & ?e= query verification and cached file response (GET /api/gallery/file?e=...)<br><code>mini-app-gallery-asset</code> | 5,048 ops/s | 197.3 µs | 169.5 µs | 270.9 µs | 3.51 ms | 5,048 records/s | 0 B | ±1.3% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 41,174,407 ops/s | 194.5 ns | 0 B | 9.14 KiB | ±2.9% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 41,564 ops/s | 3.08 ms | 56.55 MiB | 23.27 KiB | ±1.4% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 394,301 ops/s | 20.30 µs | 5.31 MiB | 33.55 KiB | ±2.2% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 10,041 ops/s | 796.8 µs | 34.02 MiB | 218.02 KiB | ±0.6% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 57,394 ops/s | 2.23 ms | 73.18 MiB | 166.67 KiB | ±4.7% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 16,916 ops/s | 7.62 ms | 12.62 MiB | 417.94 KiB | ±7.9% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 15.3 ns | 65,984,186 ops/s | 101.90 MiB | 23.22 KiB | ±9.0% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 30.9 ns | 32,915,532 ops/s | 95.07 MiB | 28.34 KiB | ±13.2% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 19.3 ns | 51,887,844 ops/s | 102.68 MiB | 29.04 KiB | ±1.9% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 91.94 ms | 2.96 MiB | 6.48 KiB | ±0.2% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 3.59 ms | 0 B | -5.27 KiB | ±2.9% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 10 Mini App Setup](10-mini-app.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#11-performance-benchmark) · [Next: 12 FAQ →](12-faq.md)

</div>
