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

**Latest full benchmark** · Bun 1.4.3 · 3-run mean · 2026-10-18T05:26:56Z · Process start to local recovery ready 384.9 ms · Route one group message through base dispatch 154.7 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 199.3 µs / 4,193 ops/s · Ad detection: fully classify and dispose of one group message (no network) 1.63 ms / 564 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.3 (`c6da4a4d3010e5553438c60f6bd76d981976867c`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-10-18T05:26:56Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,453 |
| Process reads | 182.21 MiB |
| Process writes | 186.10 MiB |
| Block-device reads | 208.00 KiB |
| Block-device writes | 235.29 MiB |
| Read syscalls | 51,931 |
| Write syscalls | 244,115 |
| Mock root on disk | 14.52 MiB |
| Mock root files | 102 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 111.6 ms | ±2.6% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 11.52 ms | ±4.8% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 781.2 µs | ±15.6% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.34 ms | ±16.6% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 5.24 ms | ±7.7% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 695.9 µs | ±4.2% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 237.9 ms | ±1.3% |
| Populate main-thread hot caches<br><code>hydrate</code> | 408.2 µs | ±9.9% |
| Process start to local recovery ready<br><code>ready-total</code> | 384.9 ms | ±1.8% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 114.66 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 154.7 ns | 6,482,416 ops/s | 89.53 MiB | 22.04 KiB | ±5.3% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 96.6 ns | 10,360,450 ops/s | 89.90 MiB | 21.29 KiB | ±3.1% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 14.9 ns | 67,772,487 ops/s | 78.80 MiB | 23.51 KiB | ±9.2% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 29.8 ns | 33,569,648 ops/s | 78.38 MiB | 24.73 KiB | ±3.9% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 33.2 ns | 30,234,645 ops/s | 80.23 MiB | 24.33 KiB | ±5.7% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,159,844,269 ops/s | 76.80 MiB | 24.52 KiB | ±0.2% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 49.3 ns | 20,364,433 ops/s | 79.30 MiB | 22.81 KiB | ±5.9% |
| Read the current chat state directly<br><code>chat-state-read</code> | 3.7 ns | 267,329,837 ops/s | 77.89 MiB | 24.04 KiB | ±0.7% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 10.2 ns | 97,942,099 ops/s | 78.83 MiB | 23.00 KiB | ±1.8% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 40.8 ns | 24,660,458 ops/s | 82.19 MiB | 25.04 KiB | ±8.0% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 1.343 µs | 746,146 ops/s | 99.83 MiB | 23.90 KiB | ±4.2% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 61.6 ns | 16,244,229 ops/s | 84.96 MiB | 26.01 KiB | ±3.0% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 39.5 ns | 25,291,003 ops/s | 86.47 MiB | 24.22 KiB | ±0.7% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 50.3 ns | 19,982,486 ops/s | 81.05 MiB | 24.04 KiB | ±7.7% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 289.8 ns | 3,506,573 ops/s | 124.42 MiB | 5.64 MiB | ±13.1% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 326.2 ns | 3,075,310 ops/s | 132.01 MiB | 20.84 KiB | ±5.6% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.4 ns | 227,212,510 ops/s | 79.02 MiB | 23.48 KiB | ±2.7% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 2.251 µs | 444,795 ops/s | 86.22 MiB | 22.09 KiB | ±3.3% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 32.3 ns | 30,992,247 ops/s | 87.44 MiB | 22.06 KiB | ±2.3% |
| Build one AI context message<br><code>buffered-message-build</code> | 256.1 ns | 3,906,660 ops/s | 88.00 MiB | 22.50 KiB | ±2.2% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 41.48 µs | 24,108 ops/s | 97.43 MiB | 21.91 KiB | ±0.2% |
| Extract a reply reference<br><code>reply-reference</code> | 30.6 ns | 32,690,553 ops/s | 90.35 MiB | 22.43 KiB | ±1.5% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 51.7 ns | 19,370,749 ops/s | 97.56 MiB | 24.38 KiB | ±2.8% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 6.1 ns | 194,749,580 ops/s | 78.52 MiB | 24.71 KiB | ±45.2% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 37.3 ns | 26,823,455 ops/s | 84.69 MiB | 23.84 KiB | ±3.5% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 20.6 ns | 48,468,748 ops/s | 78.32 MiB | 24.61 KiB | ±1.8% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 14.9 ns | 67,188,959 ops/s | 77.81 MiB | 24.87 KiB | ±0.3% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 83.6 ns | 11,988,854 ops/s | 77.48 MiB | 23.15 KiB | ±5.4% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop. The cron.json row measures only the cost of a mid-run change and runs no task: the task table is at the production limit (128 tasks with 16 actions each, local sources relative to the data root); after one task is changed, the six hot-reloadable files are read and strictly parsed in production order (including a check of every local source), the snapshots are replaced and the scheduler is reconciled by task name. Rewriting and saving the file belong to the deployer and are not timed, nor are the file watcher's debounce wait, the following ad-detection and AI chat availability checks, or the reload log lines.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 864 ops/s | 1.16 ms | 1.04 ms | 1.54 ms | 9.06 ms | 864 records/s | 3.91 MiB | ±2.0% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 324 ops/s | 3.08 ms | 2.99 ms | 5.26 ms | 12.54 ms | 41,499 records/s | 21.42 MiB | ±1.1% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 797 ops/s | 1.26 ms | 1.15 ms | 1.66 ms | 7.83 ms | 797 records/s | 3.15 MiB | ±4.5% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 725 ops/s | 1.38 ms | 1.23 ms | 1.97 ms | 9.80 ms | 725 records/s | 3.13 MiB | ±5.3% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 674 ops/s | 1.48 ms | 1.33 ms | 2.22 ms | 7.90 ms | 674 records/s | 3.13 MiB | ±3.7% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 358 ops/s | 2.80 ms | 2.52 ms | 4.30 ms | 14.39 ms | 358 records/s | 5.55 MiB | ±2.0% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 852 ops/s | 1.17 ms | 1.09 ms | 1.56 ms | 7.41 ms | 852 records/s | 4.16 MiB | ±2.7% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 564 ops/s | 1.78 ms | 1.63 ms | 2.32 ms | 8.74 ms | 564 records/s | 1.82 MiB | ±5.6% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 4,193 ops/s | 236.0 µs | 199.3 µs | 399.8 µs | 798.9 µs | 4,193 records/s | 0 B | ±2.0% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 4 ops/s | 222.8 ms | 222.4 ms | 230.0 ms | 234.2 ms | 4 records/s | 0 B | ±3.1% |
| cron.json change to one task: hot reload and reschedule (full-size task table)<br><code>cron-config-reload</code> | 7 ops/s | 135.8 ms | 133.6 ms | 147.2 ms | 156.1 ms | 7 records/s | 7.31 MiB | ±0.8% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 38,340,838 ops/s | 208.7 ns | 0 B | 10.89 KiB | ±1.9% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 42,537 ops/s | 3.02 ms | 56.55 MiB | 24.72 KiB | ±5.4% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 288,691 ops/s | 27.73 µs | 5.30 MiB | 10.22 KiB | ±2.4% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 9,369 ops/s | 857.5 µs | 34.02 MiB | 176.43 KiB | ±6.4% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 65,641 ops/s | 1.95 ms | 73.15 MiB | 126.62 KiB | ±1.0% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 17,402 ops/s | 7.41 ms | 12.60 MiB | 423.37 KiB | ±8.8% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 18.1 ns | 55,324,759 ops/s | 83.43 MiB | 21.67 KiB | ±5.1% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 36.5 ns | 27,380,029 ops/s | 80.75 MiB | 25.25 KiB | ±1.4% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 16.8 ns | 59,402,928 ops/s | 86.36 MiB | 27.50 KiB | ±2.0% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 125.9 ms | 2.04 MiB | 6.58 KiB | ±1.4% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 18.09 ms | 0 B | -4.74 KiB | ±11.7% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 09 Command Reference](09-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#10-performance-benchmark) · [Next: 11 FAQ →](11-faq.md)

</div>
