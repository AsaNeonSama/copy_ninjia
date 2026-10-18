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

**最近一次全量基准** · Bun 1.4.3 · 3 轮取平均 · 2026-10-18T05:26:56Z · 进程启动到本地恢复就绪 384.9 ms · 单条群消息进入主干并完成基础分发 154.7 ns · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 199.3 µs / 4,193 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 1.63 ms / 564 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.3 (`c6da4a4d3010e5553438c60f6bd76d981976867c`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-10-18T05:26:56Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 392,931,453 |
| 进程读入 | 182.21 MiB |
| 进程写出 | 186.10 MiB |
| 块设备读 | 208.00 KiB |
| 块设备写 | 235.29 MiB |
| 读系统调用 | 51,931 |
| 写系统调用 | 244,115 |
| mock 根落盘 | 14.52 MiB |
| mock 根文件数 | 102 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 111.6 ms | ±2.6% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 11.52 ms | ±4.8% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 781.2 µs | ±15.6% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.34 ms | ±16.6% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 5.24 ms | ±7.7% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 695.9 µs | ±4.2% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 237.9 ms | ±1.3% |
| 填充主线程热缓存<br><code>hydrate</code> | 408.2 µs | ±9.9% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 384.9 ms | ±1.8% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 114.66 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 154.7 ns | 6,482,416 次/s | 89.53 MiB | 22.04 KiB | ±5.3% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 96.6 ns | 10,360,450 次/s | 89.90 MiB | 21.29 KiB | ±3.1% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 14.9 ns | 67,772,487 次/s | 78.80 MiB | 23.51 KiB | ±9.2% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 29.8 ns | 33,569,648 次/s | 78.38 MiB | 24.73 KiB | ±3.9% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 33.2 ns | 30,234,645 次/s | 80.23 MiB | 24.33 KiB | ±5.7% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.9 ns | 1,159,844,269 次/s | 76.80 MiB | 24.52 KiB | ±0.2% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 49.3 ns | 20,364,433 次/s | 79.30 MiB | 22.81 KiB | ±5.9% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 3.7 ns | 267,329,837 次/s | 77.89 MiB | 24.04 KiB | ±0.7% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 10.2 ns | 97,942,099 次/s | 78.83 MiB | 23.00 KiB | ±1.8% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 40.8 ns | 24,660,458 次/s | 82.19 MiB | 25.04 KiB | ±8.0% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 1.343 µs | 746,146 次/s | 99.83 MiB | 23.90 KiB | ±4.2% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 61.6 ns | 16,244,229 次/s | 84.96 MiB | 26.01 KiB | ±3.0% |
| 推进临时广告免检日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 39.5 ns | 25,291,003 次/s | 86.47 MiB | 24.22 KiB | ±0.7% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 50.3 ns | 19,982,486 次/s | 81.05 MiB | 24.04 KiB | ±7.7% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 289.8 ns | 3,506,573 次/s | 124.42 MiB | 5.64 MiB | ±13.1% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 326.2 ns | 3,075,310 次/s | 132.01 MiB | 20.84 KiB | ±5.6% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.4 ns | 227,212,510 次/s | 79.02 MiB | 23.48 KiB | ±2.7% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 2.251 µs | 444,795 次/s | 86.22 MiB | 22.09 KiB | ±3.3% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 32.3 ns | 30,992,247 次/s | 87.44 MiB | 22.06 KiB | ±2.3% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 256.1 ns | 3,906,660 次/s | 88.00 MiB | 22.50 KiB | ±2.2% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 41.48 µs | 24,108 次/s | 97.43 MiB | 21.91 KiB | ±0.2% |
| 提取回复引用<br><code>reply-reference</code> | 30.6 ns | 32,690,553 次/s | 90.35 MiB | 22.43 KiB | ±1.5% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 51.7 ns | 19,370,749 次/s | 97.56 MiB | 24.38 KiB | ±2.8% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 6.1 ns | 194,749,580 次/s | 78.52 MiB | 24.71 KiB | ±45.2% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 37.3 ns | 26,823,455 次/s | 84.69 MiB | 23.84 KiB | ±3.5% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 20.6 ns | 48,468,748 次/s | 78.32 MiB | 24.61 KiB | ±1.8% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 14.9 ns | 67,188,959 次/s | 77.81 MiB | 24.87 KiB | ±0.3% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 83.6 ns | 11,988,854 次/s | 77.48 MiB | 23.15 KiB | ±5.4% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。cron 语音一行同样把语音合成模型与 Telegram 换成固定应答（约 11 秒的 WAV），包含 Base64 解码、WAV 解析、Opus 编码与发送边界；合成在生产中位于 AI Worker，这一行在同一进程内串起两侧，不含线程间传递。cron.json 一行只量中途变更的开销，不执行任务：任务表取生产上限（128 个任务、每个 16 个动作，本地来源相对数据根），每次改动其中 1 个任务后按生产顺序读取并严格解析六份可热重载文件（含逐项核对本地来源）、替换快照并按任务名对账调度器；改写与写盘属于部署方，不计时；文件监听的防抖等待、随后的广告检测与 AI 闲聊可用性重算和热重载日志也不计入。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 864 次/s | 1.16 ms | 1.04 ms | 1.54 ms | 9.06 ms | 864 条记录/s | 3.91 MiB | ±2.0% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 324 次/s | 3.08 ms | 2.99 ms | 5.26 ms | 12.54 ms | 41,499 条记录/s | 21.42 MiB | ±1.1% |
| 累计 1 条临时广告免检活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 797 次/s | 1.26 ms | 1.15 ms | 1.66 ms | 7.83 ms | 797 条记录/s | 3.15 MiB | ±4.5% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 725 次/s | 1.38 ms | 1.23 ms | 1.97 ms | 9.80 ms | 725 条记录/s | 3.13 MiB | ±5.3% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 674 次/s | 1.48 ms | 1.33 ms | 2.22 ms | 7.90 ms | 674 条记录/s | 3.13 MiB | ±3.7% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 358 次/s | 2.80 ms | 2.52 ms | 4.30 ms | 14.39 ms | 358 条记录/s | 5.55 MiB | ±2.0% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 852 次/s | 1.17 ms | 1.09 ms | 1.56 ms | 7.41 ms | 852 条记录/s | 4.16 MiB | ±2.7% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 564 次/s | 1.78 ms | 1.63 ms | 2.32 ms | 8.74 ms | 564 条记录/s | 1.82 MiB | ±5.6% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 4,193 次/s | 236.0 µs | 199.3 µs | 399.8 µs | 798.9 µs | 4,193 条记录/s | 0 B | ±2.0% |
| cron send_voice：合成、编码并发送 1 条语音（不含网络）<br><code>cron-send-voice</code> | 4 次/s | 222.8 ms | 222.4 ms | 230.0 ms | 234.2 ms | 4 条记录/s | 0 B | ±3.1% |
| cron.json 中途改动 1 个任务：热重载并重排调度（满规格任务表）<br><code>cron-config-reload</code> | 7 次/s | 135.8 ms | 133.6 ms | 147.2 ms | 156.1 ms | 7 条记录/s | 7.31 MiB | ±0.8% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 38,340,838 次/s | 208.7 ns | 0 B | 10.89 KiB | ±1.9% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 42,537 次/s | 3.02 ms | 56.55 MiB | 24.72 KiB | ±5.4% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 288,691 次/s | 27.73 µs | 5.30 MiB | 10.22 KiB | ±2.4% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 9,369 次/s | 857.5 µs | 34.02 MiB | 176.43 KiB | ±6.4% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 65,641 次/s | 1.95 ms | 73.15 MiB | 126.62 KiB | ±1.0% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 17,402 次/s | 7.41 ms | 12.60 MiB | 423.37 KiB | ±8.8% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 18.1 ns | 55,324,759 次/s | 83.43 MiB | 21.67 KiB | ±5.1% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 36.5 ns | 27,380,029 次/s | 80.75 MiB | 25.25 KiB | ±1.4% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 16.8 ns | 59,402,928 次/s | 86.36 MiB | 27.50 KiB | ±2.0% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 125.9 ms | 2.04 MiB | 6.58 KiB | ±1.4% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 18.09 ms | 0 B | -4.74 KiB | ±11.7% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：09 命令与行为参考](09-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#10-性能基准) · [下一页：11 常见问题 →](11-faq.md)

</div>
