# 10 性能基准

<p align="center">
  <b>简体中文</b> · <a href="../en/10-performance.md">English</a> · <a href="../ja/10-performance.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="09-commands.md">← 上一页：09 命令与行为参考</a> · <a href="11-faq.md">下一页：11 常见问题 →</a>
</p>

---

本页记录的性能基准数据由 `bun run perf:full -- --write-doc` 自动测算并生成，每次发版时会重新执行并整体替换数据区块。
**请勿手动编辑下方标记之间的内容**，发布时中、英、日三份文档由脚本统一同步覆盖。

执行该命令时，**结构化报告全文**会被同步写入项目根目录下的 `performance-result.json` 的 `fullSuite.lastRun` 节点（包含硬件环境、测试分区、逐项平均耗时与变异系数）。文档内的基准数据区块与该 JSON 数据由 `--write-doc` 参数原子写入。

全量基准测试仅在发版前或接到明确指令时按需执行，不包含在常规的 `bun run check` 持续集成门禁中；针对生产热路径的 GC 垃圾回收、物理驻留内存（RSS）与 JIT 编译硬门禁，由 `bun run perf:hot-path-gate` 命令独立保障，详见 [05 开发流程与质量门禁](05-dev-workflow.md)。

专项测试场景以及 `bun run perf:disk-transport` 的测量边界与复现步骤，请参阅 [05 开发流程与质量门禁](05-dev-workflow.md#专项场景与传输压力验证)。专项测试输出与热路径门禁数据独立记录，不会覆盖下方的全量基准区块。

<!-- performance-benchmark:start -->

**最近一次全量基准** · Bun 1.4.3 · 3 轮取平均 · 2026-10-11T14:15:36Z · 进程启动到本地恢复就绪 359.9 ms · 单条群消息进入主干并完成基础分发 153.1 ns · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 199.8 µs / 4,292 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 1.82 ms / 502 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.3 (`c6da4a4d3010e5553438c60f6bd76d981976867c`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-10-11T14:15:36Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 392,931,453 |
| 进程读入 | 182.35 MiB |
| 进程写出 | 185.47 MiB |
| 块设备读 | 0 B |
| 块设备写 | 234.66 MiB |
| 读系统调用 | 53,002 |
| 写系统调用 | 243,768 |
| mock 根落盘 | 14.49 MiB |
| mock 根文件数 | 103 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 100.8 ms | ±1.9% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 11.16 ms | ±7.4% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 623.3 µs | ±5.0% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.12 ms | ±3.4% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 4.49 ms | ±1.0% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 707.6 µs | ±1.1% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 228.0 ms | ±2.0% |
| 填充主线程热缓存<br><code>hydrate</code> | 285.6 µs | ±6.3% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 359.9 ms | ±1.3% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 115.26 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 153.1 ns | 6,533,621 次/s | 91.60 MiB | 17.84 KiB | ±1.9% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 95.7 ns | 10,472,785 次/s | 89.89 MiB | 20.28 KiB | ±5.0% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 10.4 ns | 334,327,222 次/s | 77.87 MiB | 24.57 KiB | ±62.9% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 27.6 ns | 36,223,891 次/s | 78.11 MiB | 23.33 KiB | ±3.0% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 31.7 ns | 31,556,947 次/s | 79.33 MiB | 24.96 KiB | ±0.6% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.8 ns | 1,180,465,175 次/s | 76.56 MiB | 24.62 KiB | ±0.7% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 47.6 ns | 21,045,345 次/s | 78.86 MiB | 23.58 KiB | ±4.4% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 3.7 ns | 267,324,596 次/s | 76.64 MiB | 24.55 KiB | ±0.1% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 10.2 ns | 98,545,039 次/s | 77.20 MiB | 23.93 KiB | ±3.8% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 39.7 ns | 25,354,553 次/s | 81.01 MiB | 23.56 KiB | ±8.6% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 1.202 µs | 833,912 次/s | 100.27 MiB | 23.75 KiB | ±5.3% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 88.1 ns | 11,353,487 次/s | 85.91 MiB | 25.74 KiB | ±0.2% |
| 推进临时广告免检日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 40.8 ns | 24,533,970 次/s | 85.97 MiB | 23.92 KiB | ±2.8% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 48.9 ns | 20,465,854 次/s | 79.85 MiB | 23.83 KiB | ±2.9% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 275.8 ns | 3,635,196 次/s | 124.25 MiB | 5.64 MiB | ±5.3% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 299.7 ns | 3,337,477 次/s | 129.54 MiB | 20.31 KiB | ±1.4% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.2 ns | 237,710,144 次/s | 77.39 MiB | 23.57 KiB | ±1.0% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 2.136 µs | 468,301 次/s | 85.58 MiB | 22.23 KiB | ±1.3% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 32.6 ns | 30,677,449 次/s | 85.93 MiB | 20.67 KiB | ±2.3% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 286.6 ns | 3,488,783 次/s | 86.38 MiB | 21.77 KiB | ±0.3% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 43.16 µs | 23,378 次/s | 96.47 MiB | 20.99 KiB | ±9.8% |
| 提取回复引用<br><code>reply-reference</code> | 30.5 ns | 32,869,681 次/s | 88.84 MiB | 22.00 KiB | ±4.2% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 46.9 ns | 21,982,076 次/s | 95.63 MiB | 24.08 KiB | ±16.6% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 4.0 ns | 253,172,008 次/s | 77.28 MiB | 24.25 KiB | ±1.2% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 38.7 ns | 25,913,987 次/s | 84.09 MiB | 23.24 KiB | ±6.0% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 20.9 ns | 47,914,946 次/s | 76.82 MiB | 24.18 KiB | ±3.8% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 15.3 ns | 65,543,615 次/s | 77.00 MiB | 24.27 KiB | ±2.3% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 86.1 ns | 11,631,398 次/s | 76.90 MiB | 23.18 KiB | ±3.4% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。cron 语音一行同样把语音合成模型与 Telegram 换成固定应答（约 11 秒的 WAV），包含 Base64 解码、WAV 解析、Opus 编码与发送边界；合成在生产中位于 AI Worker，这一行在同一进程内串起两侧，不含线程间传递。cron.json 一行只量中途变更的开销，不执行任务：任务表取生产上限（128 个任务、每个 16 个动作，本地来源相对数据根），每次改动其中 1 个任务后按生产顺序读取并严格解析六份可热重载文件（含逐项核对本地来源）、替换快照并按任务名对账调度器；改写与写盘属于部署方，不计时；文件监听的防抖等待、随后的广告检测与 AI 闲聊可用性重算和热重载日志也不计入。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 1,009 次/s | 991.0 µs | 908.6 µs | 1.33 ms | 6.58 ms | 1,009 条记录/s | 3.91 MiB | ±2.0% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 334 次/s | 3.00 ms | 2.92 ms | 5.27 ms | 12.34 ms | 42,711 条记录/s | 21.42 MiB | ±2.8% |
| 累计 1 条临时广告免检活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 838 次/s | 1.19 ms | 1.13 ms | 1.55 ms | 4.86 ms | 838 条记录/s | 3.15 MiB | ±3.6% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 744 次/s | 1.35 ms | 1.26 ms | 1.79 ms | 5.32 ms | 744 条记录/s | 3.13 MiB | ±2.8% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 723 次/s | 1.38 ms | 1.31 ms | 1.78 ms | 4.47 ms | 723 条记录/s | 3.13 MiB | ±3.7% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 379 次/s | 2.64 ms | 2.44 ms | 3.78 ms | 10.09 ms | 379 条记录/s | 5.55 MiB | ±1.7% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 871 次/s | 1.15 ms | 1.05 ms | 1.56 ms | 13.74 ms | 871 条记录/s | 4.16 MiB | ±2.2% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 502 次/s | 2.00 ms | 1.82 ms | 2.93 ms | 7.29 ms | 502 条记录/s | 1.20 MiB | ±5.7% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 4,292 次/s | 230.6 µs | 199.8 µs | 396.1 µs | 551.3 µs | 4,292 条记录/s | 0 B | ±2.7% |
| cron send_voice：合成、编码并发送 1 条语音（不含网络）<br><code>cron-send-voice</code> | 5 次/s | 219.2 ms | 218.1 ms | 224.6 ms | 228.5 ms | 5 条记录/s | 0 B | ±2.6% |
| cron.json 中途改动 1 个任务：热重载并重排调度（满规格任务表）<br><code>cron-config-reload</code> | 8 次/s | 132.1 ms | 129.3 ms | 146.1 ms | 169.5 ms | 8 条记录/s | 7.31 MiB | ±1.3% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 30,584,092 次/s | 261.7 ns | 0 B | 12.33 KiB | ±1.7% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 44,670 次/s | 2.87 ms | 56.55 MiB | 21.44 KiB | ±1.3% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 71,494 次/s | 111.9 µs | 5.30 MiB | 73.86 KiB | ±1.0% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 13,283 次/s | 602.5 µs | 34.02 MiB | 245.23 KiB | ±2.1% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 59,896 次/s | 2.14 ms | 73.15 MiB | 127.14 KiB | ±3.1% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 18,229 次/s | 7.04 ms | 12.60 MiB | 424.44 KiB | ±5.0% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 17.1 ns | 58,920,768 次/s | 80.47 MiB | 21.53 KiB | ±8.8% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 36.0 ns | 27,825,019 次/s | 80.20 MiB | 25.32 KiB | ±2.1% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 19.6 ns | 51,337,369 次/s | 86.14 MiB | 27.65 KiB | ±9.5% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 119.9 ms | 1.72 MiB | 5.93 KiB | ±1.7% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 16.30 ms | 0 B | -4.74 KiB | ±2.3% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：09 命令与行为参考](09-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#10-性能基准) · [下一页：11 常见问题 →](11-faq.md)

</div>
