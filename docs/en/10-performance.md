# 10 Performance Benchmark

<p align="center">
  <a href="../cn/10-performance.md">简体中文</a> · <b>English</b> · <a href="../ja/10-performance.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Documentation home</a> · <a href="09-commands.md">← Prev: 09 Command Reference</a> · <a href="11-faq.md">Next: 11 FAQ →</a>
</p>

---

The benchmark metrics on this page are generated automatically by `bun run perf:full -- --write-doc`. They are recalculated and updated as a whole block during each official release.
**Do not manually edit the content between the benchmark markers below**; release scripts synchronize all three language documents concurrently.

Running the command also writes the **full structured report** (hardware environment, test partitions, per-item execution times, and coefficients of variation) into `fullSuite.lastRun` in `performance-result.json` at the repository root. The markdown table and JSON records are committed atomically via the `--write-doc` flag.

The full benchmark suite runs exclusively before releases or upon explicit request; it is not included in the standard `bun run check` CI gate. Memory, GC pause, and JIT compilation limits for production hot paths are enforced separately by `bun run perf:hot-path-gate` (see [05 Development Workflow and Quality Gates](05-dev-workflow.md)).

For targeted benchmarks and reproduction instructions for `bun run perf:disk-transport`, see [05 Development Workflow](05-dev-workflow.md#targeted-scenarios-and-transport-stress-validation). Targeted scenario results are recorded separately and do not overwrite the full suite benchmark block below.

<!-- performance-benchmark:start -->

**Latest full benchmark** · Bun 1.4.3 · 3-run mean · 2026-10-11T14:15:36Z · Process start to local recovery ready 359.9 ms · Route one group message through base dispatch 153.1 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 199.8 µs / 4,292 ops/s · Ad detection: fully classify and dispose of one group message (no network) 1.82 ms / 502 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.3 (`c6da4a4d3010e5553438c60f6bd76d981976867c`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-10-11T14:15:36Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,453 |
| Process reads | 182.35 MiB |
| Process writes | 185.47 MiB |
| Block-device reads | 0 B |
| Block-device writes | 234.66 MiB |
| Read syscalls | 53,002 |
| Write syscalls | 243,768 |
| Mock root on disk | 14.49 MiB |
| Mock root files | 103 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 100.8 ms | ±1.9% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 11.16 ms | ±7.4% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 623.3 µs | ±5.0% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.12 ms | ±3.4% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.49 ms | ±1.0% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 707.6 µs | ±1.1% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 228.0 ms | ±2.0% |
| Populate main-thread hot caches<br><code>hydrate</code> | 285.6 µs | ±6.3% |
| Process start to local recovery ready<br><code>ready-total</code> | 359.9 ms | ±1.3% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 115.26 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 153.1 ns | 6,533,621 ops/s | 91.60 MiB | 17.84 KiB | ±1.9% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 95.7 ns | 10,472,785 ops/s | 89.89 MiB | 20.28 KiB | ±5.0% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 10.4 ns | 334,327,222 ops/s | 77.87 MiB | 24.57 KiB | ±62.9% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 27.6 ns | 36,223,891 ops/s | 78.11 MiB | 23.33 KiB | ±3.0% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 31.7 ns | 31,556,947 ops/s | 79.33 MiB | 24.96 KiB | ±0.6% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.8 ns | 1,180,465,175 ops/s | 76.56 MiB | 24.62 KiB | ±0.7% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 47.6 ns | 21,045,345 ops/s | 78.86 MiB | 23.58 KiB | ±4.4% |
| Read the current chat state directly<br><code>chat-state-read</code> | 3.7 ns | 267,324,596 ops/s | 76.64 MiB | 24.55 KiB | ±0.1% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 10.2 ns | 98,545,039 ops/s | 77.20 MiB | 23.93 KiB | ±3.8% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 39.7 ns | 25,354,553 ops/s | 81.01 MiB | 23.56 KiB | ±8.6% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 1.202 µs | 833,912 ops/s | 100.27 MiB | 23.75 KiB | ±5.3% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 88.1 ns | 11,353,487 ops/s | 85.91 MiB | 25.74 KiB | ±0.2% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 40.8 ns | 24,533,970 ops/s | 85.97 MiB | 23.92 KiB | ±2.8% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 48.9 ns | 20,465,854 ops/s | 79.85 MiB | 23.83 KiB | ±2.9% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 275.8 ns | 3,635,196 ops/s | 124.25 MiB | 5.64 MiB | ±5.3% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 299.7 ns | 3,337,477 ops/s | 129.54 MiB | 20.31 KiB | ±1.4% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.2 ns | 237,710,144 ops/s | 77.39 MiB | 23.57 KiB | ±1.0% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 2.136 µs | 468,301 ops/s | 85.58 MiB | 22.23 KiB | ±1.3% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 32.6 ns | 30,677,449 ops/s | 85.93 MiB | 20.67 KiB | ±2.3% |
| Build one AI context message<br><code>buffered-message-build</code> | 286.6 ns | 3,488,783 ops/s | 86.38 MiB | 21.77 KiB | ±0.3% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 43.16 µs | 23,378 ops/s | 96.47 MiB | 20.99 KiB | ±9.8% |
| Extract a reply reference<br><code>reply-reference</code> | 30.5 ns | 32,869,681 ops/s | 88.84 MiB | 22.00 KiB | ±4.2% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 46.9 ns | 21,982,076 ops/s | 95.63 MiB | 24.08 KiB | ±16.6% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.0 ns | 253,172,008 ops/s | 77.28 MiB | 24.25 KiB | ±1.2% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 38.7 ns | 25,913,987 ops/s | 84.09 MiB | 23.24 KiB | ±6.0% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 20.9 ns | 47,914,946 ops/s | 76.82 MiB | 24.18 KiB | ±3.8% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 15.3 ns | 65,543,615 ops/s | 77.00 MiB | 24.27 KiB | ±2.3% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 86.1 ns | 11,631,398 ops/s | 76.90 MiB | 23.18 KiB | ±3.4% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop. The cron.json row measures only the cost of a mid-run change and runs no task: the task table is at the production limit (128 tasks with 16 actions each, local sources relative to the data root); after one task is changed, the six hot-reloadable files are read and strictly parsed in production order (including a check of every local source), the snapshots are replaced and the scheduler is reconciled by task name. Rewriting and saving the file belong to the deployer and are not timed, nor are the file watcher's debounce wait, the following ad-detection and AI chat availability checks, or the reload log lines.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 1,009 ops/s | 991.0 µs | 908.6 µs | 1.33 ms | 6.58 ms | 1,009 records/s | 3.91 MiB | ±2.0% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 334 ops/s | 3.00 ms | 2.92 ms | 5.27 ms | 12.34 ms | 42,711 records/s | 21.42 MiB | ±2.8% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 838 ops/s | 1.19 ms | 1.13 ms | 1.55 ms | 4.86 ms | 838 records/s | 3.15 MiB | ±3.6% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 744 ops/s | 1.35 ms | 1.26 ms | 1.79 ms | 5.32 ms | 744 records/s | 3.13 MiB | ±2.8% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 723 ops/s | 1.38 ms | 1.31 ms | 1.78 ms | 4.47 ms | 723 records/s | 3.13 MiB | ±3.7% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 379 ops/s | 2.64 ms | 2.44 ms | 3.78 ms | 10.09 ms | 379 records/s | 5.55 MiB | ±1.7% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 871 ops/s | 1.15 ms | 1.05 ms | 1.56 ms | 13.74 ms | 871 records/s | 4.16 MiB | ±2.2% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 502 ops/s | 2.00 ms | 1.82 ms | 2.93 ms | 7.29 ms | 502 records/s | 1.20 MiB | ±5.7% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 4,292 ops/s | 230.6 µs | 199.8 µs | 396.1 µs | 551.3 µs | 4,292 records/s | 0 B | ±2.7% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 5 ops/s | 219.2 ms | 218.1 ms | 224.6 ms | 228.5 ms | 5 records/s | 0 B | ±2.6% |
| cron.json change to one task: hot reload and reschedule (full-size task table)<br><code>cron-config-reload</code> | 8 ops/s | 132.1 ms | 129.3 ms | 146.1 ms | 169.5 ms | 8 records/s | 7.31 MiB | ±1.3% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 30,584,092 ops/s | 261.7 ns | 0 B | 12.33 KiB | ±1.7% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 44,670 ops/s | 2.87 ms | 56.55 MiB | 21.44 KiB | ±1.3% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 71,494 ops/s | 111.9 µs | 5.30 MiB | 73.86 KiB | ±1.0% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 13,283 ops/s | 602.5 µs | 34.02 MiB | 245.23 KiB | ±2.1% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 59,896 ops/s | 2.14 ms | 73.15 MiB | 127.14 KiB | ±3.1% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 18,229 ops/s | 7.04 ms | 12.60 MiB | 424.44 KiB | ±5.0% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 17.1 ns | 58,920,768 ops/s | 80.47 MiB | 21.53 KiB | ±8.8% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 36.0 ns | 27,825,019 ops/s | 80.20 MiB | 25.32 KiB | ±2.1% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 19.6 ns | 51,337,369 ops/s | 86.14 MiB | 27.65 KiB | ±9.5% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 119.9 ms | 1.72 MiB | 5.93 KiB | ±1.7% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 16.30 ms | 0 B | -4.74 KiB | ±2.3% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 09 Command Reference](09-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#10-performance-benchmark) · [Next: 11 FAQ →](11-faq.md)

</div>
