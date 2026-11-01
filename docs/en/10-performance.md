# 10 Performance Benchmark

<p align="center">
  <a href="../cn/10-performance.md">简体中文</a> · <b>English</b> · <a href="../ja/10-performance.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Documentation home</a> · <a href="09-commands.md">← Prev: 09 Command Reference</a> · <a href="11-mini-app.md">Next: 11 Mini App Setup →</a>
</p>

---

The benchmark metrics on this page are generated automatically by `bun run perf:full -- --write-doc`. They are recalculated and updated as a whole block during each official release.
**Do not manually edit the content between the benchmark markers below**; release scripts synchronize all three language documents concurrently.

Running the command also writes the **full structured report** (hardware environment, test partitions, per-item execution times, and coefficients of variation) into `fullSuite.lastRun` in `performance-result.json` at the repository root. The markdown table and JSON records are committed atomically via the `--write-doc` flag.

The full benchmark suite runs exclusively before releases or upon explicit request; it is not included in the standard `bun run check` CI gate. Memory, GC pause, and JIT compilation limits for production hot paths are enforced separately by `bun run perf:hot-path-gate` (see [05 Development Workflow and Quality Gates](05-dev-workflow.md)).

For targeted benchmarks and reproduction instructions for `bun run perf:disk-transport`, see [05 Development Workflow](05-dev-workflow.md#targeted-scenarios-and-transport-stress-validation). Targeted scenario results are recorded separately and do not overwrite the full suite benchmark block below.

<!-- performance-benchmark:start -->

**Latest full benchmark** · Bun 1.4.4 · 3-run mean · 2026-11-01T13:44:51Z · Process start to local recovery ready 365.6 ms · Route one group message through base dispatch 111.8 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 187.9 µs / 4,506 ops/s · Ad detection: fully classify and dispose of one group message (no network) 1.73 ms / 535 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.4 (`38afee6c84fcf48c0edb2466aa4b27d287a59c30`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-11-01T13:44:51Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 394,541,853 |
| Process reads | 183.13 MiB |
| Process writes | 186.10 MiB |
| Block-device reads | 0 B |
| Block-device writes | 235.29 MiB |
| Read syscalls | 48,983 |
| Write syscalls | 244,977 |
| Mock root on disk | 14.59 MiB |
| Mock root files | 130 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 121.9 ms | ±14.0% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 10.99 ms | ±10.2% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 902.2 µs | ±14.8% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.47 ms | ±20.9% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 5.08 ms | ±19.7% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 702.4 µs | ±7.0% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 210.7 ms | ±1.6% |
| Populate main-thread hot caches<br><code>hydrate</code> | 336.7 µs | ±4.6% |
| Process start to local recovery ready<br><code>ready-total</code> | 365.6 ms | ±5.9% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 115.92 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 111.8 ns | 8,958,114 ops/s | 92.86 MiB | 18.15 KiB | ±4.4% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 72.3 ns | 13,833,626 ops/s | 93.92 MiB | 21.44 KiB | ±0.9% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 1.1 ns | 876,811,083 ops/s | 81.58 MiB | 27.05 KiB | ±0.9% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 13.3 ns | 75,058,160 ops/s | 81.87 MiB | 28.13 KiB | ±0.9% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 31.3 ns | 31,903,747 ops/s | 82.28 MiB | 28.49 KiB | ±1.1% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,167,120,118 ops/s | 79.23 MiB | 27.12 KiB | ±1.2% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 45.0 ns | 22,272,984 ops/s | 80.70 MiB | 28.03 KiB | ±5.0% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.2 ns | 239,514,880 ops/s | 80.18 MiB | 27.75 KiB | ±1.2% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 9.2 ns | 108,407,080 ops/s | 80.78 MiB | 27.92 KiB | ±2.2% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 32.6 ns | 30,700,797 ops/s | 84.80 MiB | 28.10 KiB | ±0.8% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 1.155 µs | 869,676 ops/s | 104.73 MiB | 22.33 KiB | ±6.5% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 56.6 ns | 17,666,205 ops/s | 87.25 MiB | 28.12 KiB | ±2.7% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 38.5 ns | 25,988,646 ops/s | 90.90 MiB | 27.93 KiB | ±3.8% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 46.4 ns | 21,566,307 ops/s | 83.00 MiB | 28.36 KiB | ±1.6% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 167.1 ns | 5,995,823 ops/s | 95.46 MiB | 19.34 KiB | ±4.4% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 293.3 ns | 3,411,134 ops/s | 143.73 MiB | 22.00 KiB | ±2.1% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.7 ns | 213,984,146 ops/s | 80.97 MiB | 26.93 KiB | ±6.9% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 2.073 µs | 482,299 ops/s | 91.39 MiB | 23.28 KiB | ±0.5% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 29.0 ns | 34,471,596 ops/s | 89.98 MiB | 19.33 KiB | ±3.6% |
| Build one AI context message<br><code>buffered-message-build</code> | 223.6 ns | 4,473,575 ops/s | 91.35 MiB | 22.72 KiB | ±2.1% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 37.21 µs | 26,877 ops/s | 102.67 MiB | 23.28 KiB | ±0.4% |
| Extract a reply reference<br><code>reply-reference</code> | 28.4 ns | 35,732,341 ops/s | 91.08 MiB | 23.32 KiB | ±12.1% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 39.7 ns | 25,219,735 ops/s | 101.43 MiB | 29.85 KiB | ±3.3% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.0 ns | 252,726,979 ops/s | 80.64 MiB | 26.58 KiB | ±2.5% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 36.2 ns | 27,683,994 ops/s | 88.78 MiB | 28.59 KiB | ±3.1% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 19.6 ns | 50,992,118 ops/s | 80.38 MiB | 28.00 KiB | ±0.3% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 15.0 ns | 66,556,811 ops/s | 80.05 MiB | 27.65 KiB | ±1.4% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 83.7 ns | 11,947,070 ops/s | 81.19 MiB | 28.26 KiB | ±1.3% |
| Mini App backend: verify dual-layer auth and query managed chat status summaries<br><code>mini-app-status-route</code> | 8.371 µs | 119,467 ops/s | 93.25 MiB | 23.26 KiB | ±0.9% |
| Mini App frontend: diff status cards, format metrics and compute FLIP/spring animation frames<br><code>mini-app-frontend-render</code> | 1.302 µs | 768,282 ops/s | 100.02 MiB | 44.51 KiB | ±0.8% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop. The cron.json row measures only the cost of a mid-run change and runs no task: the task table is at the production limit (128 tasks with 16 actions each, local sources relative to the data root); after one task is changed, the six hot-reloadable files are read and strictly parsed in production order (including a check of every local source), the snapshots are replaced and the scheduler is reconciled by task name. Rewriting and saving the file belong to the deployer and are not timed, nor are the file watcher's debounce wait, the following ad-detection and AI chat availability checks, or the reload log lines. The Mini App API request row runs from the `Bun.serve` route handler entry through the full auth middleware chain (header guard, Telegram WebApp `initData` HMAC-SHA256 signature and super-admin check, and 45-minute password session renewal), managed chat state and QA/hot-message aggregation, a 24-hour join-log query via the real Disk I/O Worker aggregated across 1–24h rolling windows, and HTTP JSON response serialization and parsing, measuring typical end-to-end single-process API RPS.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 721 ops/s | 1.39 ms | 1.31 ms | 1.98 ms | 6.83 ms | 721 records/s | 3.91 MiB | ±3.2% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 316 ops/s | 3.18 ms | 2.88 ms | 6.02 ms | 13.47 ms | 40,418 records/s | 21.42 MiB | ±7.6% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 660 ops/s | 1.52 ms | 1.30 ms | 3.05 ms | 12.92 ms | 660 records/s | 3.15 MiB | ±7.5% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 696 ops/s | 1.44 ms | 1.33 ms | 2.09 ms | 6.36 ms | 696 records/s | 3.13 MiB | ±5.2% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 642 ops/s | 1.56 ms | 1.45 ms | 2.22 ms | 5.70 ms | 642 records/s | 3.13 MiB | ±1.0% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 382 ops/s | 2.61 ms | 2.40 ms | 3.70 ms | 11.81 ms | 382 records/s | 5.55 MiB | ±1.0% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 770 ops/s | 1.30 ms | 1.22 ms | 1.84 ms | 7.19 ms | 770 records/s | 4.16 MiB | ±3.5% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 535 ops/s | 1.87 ms | 1.73 ms | 2.59 ms | 7.18 ms | 535 records/s | 1.82 MiB | ±2.6% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 4,506 ops/s | 219.6 µs | 187.9 µs | 400.5 µs | 529.4 µs | 4,506 records/s | 0 B | ±2.6% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 5 ops/s | 210.5 ms | 210.2 ms | 215.1 ms | 217.8 ms | 5 records/s | 0 B | ±1.1% |
| cron.json change to one task: hot reload and reschedule (full-size task table)<br><code>cron-config-reload</code> | 8 ops/s | 127.3 ms | 125.0 ms | 141.7 ms | 167.6 ms | 8 records/s | 7.31 MiB | ±2.1% |
| Mini App API request: full auth middleware, chat detail aggregation and 24h join-log query (GET /api/chats/:chatId)<br><code>mini-app-api-request</code> | 6,802 ops/s | 146.4 µs | 123.3 µs | 208.0 µs | 3.11 ms | 6,802 records/s | 0 B | ±0.6% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 40,604,194 ops/s | 197.0 ns | 0 B | 12.22 KiB | ±0.8% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 45,143 ops/s | 2.84 ms | 56.55 MiB | 22.67 KiB | ±3.0% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 387,174 ops/s | 20.67 µs | 5.30 MiB | 48.77 KiB | ±1.8% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 13,733 ops/s | 582.9 µs | 34.02 MiB | 184.60 KiB | ±2.6% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 59,532 ops/s | 2.15 ms | 73.15 MiB | 128.78 KiB | ±3.1% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 18,497 ops/s | 6.95 ms | 12.60 MiB | 420.28 KiB | ±6.9% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 16.5 ns | 61,688,949 ops/s | 90.69 MiB | 22.44 KiB | ±12.5% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 28.1 ns | 35,710,716 ops/s | 83.22 MiB | 27.91 KiB | ±6.6% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 18.3 ns | 55,082,806 ops/s | 91.39 MiB | 29.16 KiB | ±8.8% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 191.7 ms | 3.20 MiB | 6.04 KiB | ±0.6% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 3.56 ms | 0 B | -5.30 KiB | ±1.6% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 09 Command Reference](09-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#10-performance-benchmark) · [Next: 11 Mini App Setup →](11-mini-app.md)

</div>
