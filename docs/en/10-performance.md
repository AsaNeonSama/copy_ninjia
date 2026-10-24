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

**Latest full benchmark** · Bun 1.4.4 · 3-run mean · 2026-10-24T09:13:19Z · Process start to local recovery ready 366.5 ms · Route one group message through base dispatch 107.0 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 190.9 µs / 3,789 ops/s · Ad detection: fully classify and dispose of one group message (no network) 1.69 ms / 547 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.4 (`38afee6c84fcf48c0edb2466aa4b27d287a59c30`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-10-24T09:13:19Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,453 |
| Process reads | 182.55 MiB |
| Process writes | 186.10 MiB |
| Block-device reads | 1.33 KiB |
| Block-device writes | 235.29 MiB |
| Read syscalls | 48,772 |
| Write syscalls | 244,144 |
| Mock root on disk | 14.52 MiB |
| Mock root files | 102 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 102.7 ms | ±1.7% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 11.77 ms | ±7.6% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 631.2 µs | ±8.6% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.04 ms | ±1.7% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.58 ms | ±3.6% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 688.1 µs | ±0.8% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 231.9 ms | ±15.3% |
| Populate main-thread hot caches<br><code>hydrate</code> | 345.9 µs | ±8.0% |
| Process start to local recovery ready<br><code>ready-total</code> | 366.5 ms | ±9.4% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 116.37 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 107.0 ns | 9,344,601 ops/s | 89.10 MiB | 22.07 KiB | ±1.7% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 72.9 ns | 13,719,750 ops/s | 91.13 MiB | 21.67 KiB | ±1.3% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 1.2 ns | 868,536,839 ops/s | 80.05 MiB | 27.63 KiB | ±4.0% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 13.0 ns | 77,271,448 ops/s | 79.64 MiB | 27.97 KiB | ±3.4% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 30.8 ns | 32,507,306 ops/s | 82.14 MiB | 28.69 KiB | ±0.7% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,175,891,135 ops/s | 78.88 MiB | 27.05 KiB | ±0.8% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 43.7 ns | 22,967,674 ops/s | 80.07 MiB | 28.07 KiB | ±5.4% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.1 ns | 244,119,560 ops/s | 79.19 MiB | 27.38 KiB | ±2.4% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 9.7 ns | 103,379,685 ops/s | 79.82 MiB | 27.98 KiB | ±5.5% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 37.1 ns | 27,214,394 ops/s | 83.47 MiB | 27.84 KiB | ±9.7% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 1.193 µs | 838,212 ops/s | 103.21 MiB | 23.26 KiB | ±1.6% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 57.9 ns | 17,286,572 ops/s | 85.80 MiB | 26.50 KiB | ±1.1% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 38.1 ns | 26,306,921 ops/s | 88.49 MiB | 28.55 KiB | ±3.3% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 47.0 ns | 21,293,036 ops/s | 82.18 MiB | 28.12 KiB | ±1.7% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 160.3 ns | 6,243,885 ops/s | 94.36 MiB | 19.88 KiB | ±2.7% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 303.4 ns | 3,299,425 ops/s | 137.67 MiB | 21.95 KiB | ±3.3% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 5.0 ns | 199,266,144 ops/s | 80.08 MiB | 26.97 KiB | ±1.2% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 2.125 µs | 470,573 ops/s | 89.02 MiB | 23.15 KiB | ±1.1% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 31.1 ns | 32,173,408 ops/s | 87.90 MiB | 23.93 KiB | ±2.1% |
| Build one AI context message<br><code>buffered-message-build</code> | 227.2 ns | 4,404,603 ops/s | 89.61 MiB | 22.71 KiB | ±2.5% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 37.95 µs | 26,359 ops/s | 100.89 MiB | 22.75 KiB | ±1.4% |
| Extract a reply reference<br><code>reply-reference</code> | 29.2 ns | 35,001,604 ops/s | 89.26 MiB | 22.08 KiB | ±14.9% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 40.1 ns | 24,938,163 ops/s | 99.49 MiB | 29.14 KiB | ±1.8% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.1 ns | 243,425,834 ops/s | 80.24 MiB | 27.23 KiB | ±3.9% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 38.3 ns | 26,123,139 ops/s | 86.24 MiB | 28.61 KiB | ±1.2% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 19.6 ns | 51,092,220 ops/s | 79.94 MiB | 27.82 KiB | ±1.0% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 14.8 ns | 67,629,150 ops/s | 78.76 MiB | 27.44 KiB | ±1.7% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 83.9 ns | 11,917,693 ops/s | 78.67 MiB | 28.03 KiB | ±0.8% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop. The cron.json row measures only the cost of a mid-run change and runs no task: the task table is at the production limit (128 tasks with 16 actions each, local sources relative to the data root); after one task is changed, the six hot-reloadable files are read and strictly parsed in production order (including a check of every local source), the snapshots are replaced and the scheduler is reconciled by task name. Rewriting and saving the file belong to the deployer and are not timed, nor are the file watcher's debounce wait, the following ad-detection and AI chat availability checks, or the reload log lines.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 836 ops/s | 1.20 ms | 1.06 ms | 1.81 ms | 9.72 ms | 836 records/s | 3.91 MiB | ±5.2% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 344 ops/s | 2.91 ms | 2.78 ms | 4.57 ms | 12.29 ms | 44,009 records/s | 21.42 MiB | ±0.3% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 745 ops/s | 1.35 ms | 1.23 ms | 1.87 ms | 7.33 ms | 745 records/s | 3.15 MiB | ±6.7% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 708 ops/s | 1.41 ms | 1.26 ms | 2.45 ms | 6.06 ms | 708 records/s | 3.13 MiB | ±5.3% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 752 ops/s | 1.33 ms | 1.27 ms | 1.80 ms | 3.20 ms | 752 records/s | 3.13 MiB | ±4.5% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 373 ops/s | 2.68 ms | 2.49 ms | 3.79 ms | 11.14 ms | 373 records/s | 5.55 MiB | ±1.7% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 829 ops/s | 1.21 ms | 1.10 ms | 1.71 ms | 7.64 ms | 829 records/s | 4.16 MiB | ±6.2% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 547 ops/s | 1.83 ms | 1.69 ms | 2.44 ms | 7.19 ms | 547 records/s | 1.82 MiB | ±3.0% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 3,789 ops/s | 294.2 µs | 190.9 µs | 850.3 µs | 1.83 ms | 3,789 records/s | 0 B | ±29.6% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 5 ops/s | 211.5 ms | 210.8 ms | 218.3 ms | 223.6 ms | 5 records/s | 0 B | ±0.5% |
| cron.json change to one task: hot reload and reschedule (full-size task table)<br><code>cron-config-reload</code> | 8 ops/s | 129.8 ms | 127.6 ms | 145.0 ms | 159.5 ms | 8 records/s | 7.31 MiB | ±0.2% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 40,019,871 ops/s | 200.0 ns | 0 B | 11.83 KiB | ±1.7% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 45,952 ops/s | 2.79 ms | 56.55 MiB | 24.52 KiB | ±2.0% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 375,519 ops/s | 21.31 µs | 5.30 MiB | -2.44 KiB | ±2.2% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 13,176 ops/s | 607.3 µs | 34.02 MiB | 178.09 KiB | ±1.4% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 62,511 ops/s | 2.05 ms | 73.15 MiB | 128.69 KiB | ±3.2% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 20,597 ops/s | 6.22 ms | 12.60 MiB | 420.96 KiB | ±1.3% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 17.0 ns | 59,679,554 ops/s | 89.98 MiB | 22.37 KiB | ±11.1% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 27.8 ns | 35,982,616 ops/s | 82.33 MiB | 28.09 KiB | ±4.3% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 18.2 ns | 55,066,834 ops/s | 90.92 MiB | 27.99 KiB | ±5.5% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 192.6 ms | 2.52 MiB | 6.59 KiB | ±0.6% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 3.58 ms | 0 B | -4.76 KiB | ±0.7% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 09 Command Reference](09-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#10-performance-benchmark) · [Next: 11 FAQ →](11-faq.md)

</div>
