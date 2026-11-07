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

**Latest full benchmark** · Bun 1.4.4 · 3-run mean · 2026-11-07T11:06:15Z · Process start to local recovery ready 362.4 ms · Route one group message through base dispatch 114.8 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 186.7 µs / 4,578 ops/s · Ad detection: fully classify and dispose of one group message (no network) 1.70 ms / 552 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.4 (`38afee6c84fcf48c0edb2466aa4b27d287a59c30`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-11-07T11:06:15Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 394,541,853 |
| Process reads | 183.12 MiB |
| Process writes | 186.10 MiB |
| Block-device reads | 0 B |
| Block-device writes | 235.29 MiB |
| Read syscalls | 49,001 |
| Write syscalls | 244,982 |
| Mock root on disk | 14.59 MiB |
| Mock root files | 130 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 110.5 ms | ±2.2% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 11.12 ms | ±0.2% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 734.8 µs | ±6.4% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.35 ms | ±7.3% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.50 ms | ±5.8% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 714.0 µs | ±6.9% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 220.1 ms | ±4.8% |
| Populate main-thread hot caches<br><code>hydrate</code> | 329.6 µs | ±3.4% |
| Process start to local recovery ready<br><code>ready-total</code> | 362.4 ms | ±2.4% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 116.07 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 114.8 ns | 8,751,182 ops/s | 95.04 MiB | 17.50 KiB | ±6.6% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 71.3 ns | 14,029,232 ops/s | 93.89 MiB | 21.86 KiB | ±1.9% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 1.1 ns | 889,458,216 ops/s | 81.80 MiB | 26.87 KiB | ±2.1% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 13.5 ns | 73,848,674 ops/s | 82.23 MiB | 28.41 KiB | ±2.0% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 31.7 ns | 31,606,244 ops/s | 83.44 MiB | 28.52 KiB | ±2.9% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,164,077,476 ops/s | 80.67 MiB | 27.86 KiB | ±1.6% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 44.9 ns | 22,460,406 ops/s | 82.21 MiB | 27.90 KiB | ±8.6% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.0 ns | 248,821,999 ops/s | 80.44 MiB | 27.66 KiB | ±0.5% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 9.6 ns | 104,115,533 ops/s | 81.29 MiB | 27.21 KiB | ±1.8% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 36.0 ns | 27,900,788 ops/s | 85.21 MiB | 28.24 KiB | ±7.1% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 1.185 µs | 843,649 ops/s | 107.35 MiB | 23.88 KiB | ±0.6% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 56.9 ns | 17,583,508 ops/s | 87.09 MiB | 27.75 KiB | ±2.4% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 39.6 ns | 25,228,230 ops/s | 90.82 MiB | 27.73 KiB | ±1.2% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 47.8 ns | 20,941,102 ops/s | 84.08 MiB | 27.25 KiB | ±1.0% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 161.5 ns | 6,199,732 ops/s | 95.85 MiB | 21.13 KiB | ±4.0% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 284.7 ns | 3,519,305 ops/s | 138.02 MiB | 22.70 KiB | ±4.4% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 5.7 ns | 178,767,528 ops/s | 82.15 MiB | 26.83 KiB | ±15.7% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 2.080 µs | 480,758 ops/s | 92.84 MiB | 23.67 KiB | ±1.1% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 31.4 ns | 31,909,396 ops/s | 90.21 MiB | 18.56 KiB | ±2.4% |
| Build one AI context message<br><code>buffered-message-build</code> | 217.1 ns | 4,608,847 ops/s | 92.47 MiB | 22.80 KiB | ±2.5% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 37.06 µs | 26,984 ops/s | 102.43 MiB | 21.37 KiB | ±0.6% |
| Extract a reply reference<br><code>reply-reference</code> | 31.7 ns | 33,264,514 ops/s | 91.74 MiB | 23.78 KiB | ±25.0% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 39.9 ns | 25,082,207 ops/s | 101.94 MiB | 29.76 KiB | ±3.1% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.2 ns | 240,651,988 ops/s | 81.74 MiB | 26.17 KiB | ±2.1% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 36.1 ns | 27,736,712 ops/s | 89.22 MiB | 28.94 KiB | ±2.3% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 19.3 ns | 51,768,141 ops/s | 81.64 MiB | 27.37 KiB | ±0.6% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 14.8 ns | 67,418,227 ops/s | 80.93 MiB | 27.20 KiB | ±1.2% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 82.6 ns | 12,116,102 ops/s | 81.10 MiB | 27.74 KiB | ±1.7% |
| Mini App backend: verify dual-layer auth and query managed chat status summaries<br><code>mini-app-status-route</code> | 7.186 µs | 139,171 ops/s | 93.10 MiB | 22.94 KiB | ±0.6% |
| Mini App frontend: diff status cards, format metrics and compute FLIP/spring animation frames<br><code>mini-app-frontend-render</code> | 475.7 ns | 2,102,363 ops/s | 102.38 MiB | 34.38 KiB | ±0.5% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop. The cron.json row measures only the cost of a mid-run change and runs no task: the task table is at the production limit (128 tasks with 16 actions each, local sources relative to the data root); after one task is changed, the six hot-reloadable files are read and strictly parsed in production order (including a check of every local source), the snapshots are replaced and the scheduler is reconciled by task name. Rewriting and saving the file belong to the deployer and are not timed, nor are the file watcher's debounce wait, the following ad-detection and AI chat availability checks, or the reload log lines. The Mini App API request row runs from the `Bun.serve` route handler entry through the full auth middleware chain (header guard, Telegram WebApp `initData` HMAC-SHA256 signature and super-admin check, and 45-minute password session renewal), managed chat state and QA/hot-message aggregation, a 24-hour join-log query via the real Disk I/O Worker aggregated across 1–24h rolling windows, and HTTP JSON response serialization and parsing, measuring typical end-to-end single-process API RPS.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 835 ops/s | 1.20 ms | 1.10 ms | 1.72 ms | 10.17 ms | 835 records/s | 3.91 MiB | ±4.4% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 333 ops/s | 3.00 ms | 2.78 ms | 5.45 ms | 19.18 ms | 42,680 records/s | 21.42 MiB | ±4.5% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 658 ops/s | 1.53 ms | 1.28 ms | 2.69 ms | 8.62 ms | 658 records/s | 3.15 MiB | ±6.7% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 663 ops/s | 1.51 ms | 1.40 ms | 2.18 ms | 6.27 ms | 663 records/s | 3.13 MiB | ±5.7% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 681 ops/s | 1.47 ms | 1.36 ms | 2.00 ms | 7.88 ms | 681 records/s | 3.13 MiB | ±5.8% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 345 ops/s | 2.92 ms | 2.57 ms | 4.63 ms | 14.16 ms | 345 records/s | 5.55 MiB | ±8.4% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 783 ops/s | 1.29 ms | 1.14 ms | 1.91 ms | 8.66 ms | 783 records/s | 4.16 MiB | ±9.4% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 552 ops/s | 1.81 ms | 1.70 ms | 2.30 ms | 6.49 ms | 552 records/s | 1.82 MiB | ±2.4% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 4,578 ops/s | 215.9 µs | 186.7 µs | 402.1 µs | 550.8 µs | 4,578 records/s | 0 B | ±1.0% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 5 ops/s | 212.2 ms | 211.7 ms | 219.8 ms | 222.2 ms | 5 records/s | 0 B | ±1.7% |
| cron.json change to one task: hot reload and reschedule (full-size task table)<br><code>cron-config-reload</code> | 8 ops/s | 127.7 ms | 127.1 ms | 140.2 ms | 146.4 ms | 8 records/s | 7.31 MiB | ±1.3% |
| Mini App API request: full auth middleware, chat detail aggregation and 24h join-log query (GET /api/chats/:chatId)<br><code>mini-app-api-request</code> | 6,491 ops/s | 155.1 µs | 130.5 µs | 225.3 µs | 2.29 ms | 6,491 records/s | 0 B | ±10.4% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 40,890,946 ops/s | 195.7 ns | 0 B | 11.39 KiB | ±1.6% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 45,662 ops/s | 2.80 ms | 56.55 MiB | 23.64 KiB | ±1.0% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 380,347 ops/s | 21.03 µs | 5.30 MiB | 5.35 KiB | ±0.8% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 13,328 ops/s | 600.3 µs | 34.02 MiB | 186.13 KiB | ±1.1% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 62,699 ops/s | 2.05 ms | 73.15 MiB | 128.85 KiB | ±4.9% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 18,519 ops/s | 6.91 ms | 12.60 MiB | 421.74 KiB | ±1.8% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 17.3 ns | 57,711,784 ops/s | 91.58 MiB | 22.52 KiB | ±3.3% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 33.3 ns | 30,801,619 ops/s | 83.76 MiB | 27.59 KiB | ±15.1% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 19.5 ns | 51,325,122 ops/s | 92.14 MiB | 28.22 KiB | ±5.5% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 195.1 ms | 2.80 MiB | 6.52 KiB | ±1.4% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 3.63 ms | 0 B | -4.76 KiB | ±2.6% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 09 Command Reference](09-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#10-performance-benchmark) · [Next: 11 Mini App Setup →](11-mini-app.md)

</div>
