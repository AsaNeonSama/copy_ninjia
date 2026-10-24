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

**最近一次全量基准** · Bun 1.4.4 · 3 轮取平均 · 2026-10-24T09:13:19Z · 进程启动到本地恢复就绪 366.5 ms · 单条群消息进入主干并完成基础分发 107.0 ns · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 190.9 µs / 3,789 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 1.69 ms / 547 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.4 (`38afee6c84fcf48c0edb2466aa4b27d287a59c30`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-10-24T09:13:19Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 392,931,453 |
| 进程读入 | 182.55 MiB |
| 进程写出 | 186.10 MiB |
| 块设备读 | 1.33 KiB |
| 块设备写 | 235.29 MiB |
| 读系统调用 | 48,772 |
| 写系统调用 | 244,144 |
| mock 根落盘 | 14.52 MiB |
| mock 根文件数 | 102 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 102.7 ms | ±1.7% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 11.77 ms | ±7.6% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 631.2 µs | ±8.6% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.04 ms | ±1.7% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 4.58 ms | ±3.6% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 688.1 µs | ±0.8% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 231.9 ms | ±15.3% |
| 填充主线程热缓存<br><code>hydrate</code> | 345.9 µs | ±8.0% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 366.5 ms | ±9.4% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 116.37 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 107.0 ns | 9,344,601 次/s | 89.10 MiB | 22.07 KiB | ±1.7% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 72.9 ns | 13,719,750 次/s | 91.13 MiB | 21.67 KiB | ±1.3% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 1.2 ns | 868,536,839 次/s | 80.05 MiB | 27.63 KiB | ±4.0% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 13.0 ns | 77,271,448 次/s | 79.64 MiB | 27.97 KiB | ±3.4% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 30.8 ns | 32,507,306 次/s | 82.14 MiB | 28.69 KiB | ±0.7% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.9 ns | 1,175,891,135 次/s | 78.88 MiB | 27.05 KiB | ±0.8% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 43.7 ns | 22,967,674 次/s | 80.07 MiB | 28.07 KiB | ±5.4% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.1 ns | 244,119,560 次/s | 79.19 MiB | 27.38 KiB | ±2.4% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 9.7 ns | 103,379,685 次/s | 79.82 MiB | 27.98 KiB | ±5.5% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 37.1 ns | 27,214,394 次/s | 83.47 MiB | 27.84 KiB | ±9.7% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 1.193 µs | 838,212 次/s | 103.21 MiB | 23.26 KiB | ±1.6% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 57.9 ns | 17,286,572 次/s | 85.80 MiB | 26.50 KiB | ±1.1% |
| 推进临时广告免检日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 38.1 ns | 26,306,921 次/s | 88.49 MiB | 28.55 KiB | ±3.3% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 47.0 ns | 21,293,036 次/s | 82.18 MiB | 28.12 KiB | ±1.7% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 160.3 ns | 6,243,885 次/s | 94.36 MiB | 19.88 KiB | ±2.7% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 303.4 ns | 3,299,425 次/s | 137.67 MiB | 21.95 KiB | ±3.3% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 5.0 ns | 199,266,144 次/s | 80.08 MiB | 26.97 KiB | ±1.2% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 2.125 µs | 470,573 次/s | 89.02 MiB | 23.15 KiB | ±1.1% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 31.1 ns | 32,173,408 次/s | 87.90 MiB | 23.93 KiB | ±2.1% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 227.2 ns | 4,404,603 次/s | 89.61 MiB | 22.71 KiB | ±2.5% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 37.95 µs | 26,359 次/s | 100.89 MiB | 22.75 KiB | ±1.4% |
| 提取回复引用<br><code>reply-reference</code> | 29.2 ns | 35,001,604 次/s | 89.26 MiB | 22.08 KiB | ±14.9% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 40.1 ns | 24,938,163 次/s | 99.49 MiB | 29.14 KiB | ±1.8% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 4.1 ns | 243,425,834 次/s | 80.24 MiB | 27.23 KiB | ±3.9% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 38.3 ns | 26,123,139 次/s | 86.24 MiB | 28.61 KiB | ±1.2% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 19.6 ns | 51,092,220 次/s | 79.94 MiB | 27.82 KiB | ±1.0% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 14.8 ns | 67,629,150 次/s | 78.76 MiB | 27.44 KiB | ±1.7% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 83.9 ns | 11,917,693 次/s | 78.67 MiB | 28.03 KiB | ±0.8% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。cron 语音一行同样把语音合成模型与 Telegram 换成固定应答（约 11 秒的 WAV），包含 Base64 解码、WAV 解析、Opus 编码与发送边界；合成在生产中位于 AI Worker，这一行在同一进程内串起两侧，不含线程间传递。cron.json 一行只量中途变更的开销，不执行任务：任务表取生产上限（128 个任务、每个 16 个动作，本地来源相对数据根），每次改动其中 1 个任务后按生产顺序读取并严格解析六份可热重载文件（含逐项核对本地来源）、替换快照并按任务名对账调度器；改写与写盘属于部署方，不计时；文件监听的防抖等待、随后的广告检测与 AI 闲聊可用性重算和热重载日志也不计入。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 836 次/s | 1.20 ms | 1.06 ms | 1.81 ms | 9.72 ms | 836 条记录/s | 3.91 MiB | ±5.2% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 344 次/s | 2.91 ms | 2.78 ms | 4.57 ms | 12.29 ms | 44,009 条记录/s | 21.42 MiB | ±0.3% |
| 累计 1 条临时广告免检活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 745 次/s | 1.35 ms | 1.23 ms | 1.87 ms | 7.33 ms | 745 条记录/s | 3.15 MiB | ±6.7% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 708 次/s | 1.41 ms | 1.26 ms | 2.45 ms | 6.06 ms | 708 条记录/s | 3.13 MiB | ±5.3% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 752 次/s | 1.33 ms | 1.27 ms | 1.80 ms | 3.20 ms | 752 条记录/s | 3.13 MiB | ±4.5% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 373 次/s | 2.68 ms | 2.49 ms | 3.79 ms | 11.14 ms | 373 条记录/s | 5.55 MiB | ±1.7% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 829 次/s | 1.21 ms | 1.10 ms | 1.71 ms | 7.64 ms | 829 条记录/s | 4.16 MiB | ±6.2% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 547 次/s | 1.83 ms | 1.69 ms | 2.44 ms | 7.19 ms | 547 条记录/s | 1.82 MiB | ±3.0% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 3,789 次/s | 294.2 µs | 190.9 µs | 850.3 µs | 1.83 ms | 3,789 条记录/s | 0 B | ±29.6% |
| cron send_voice：合成、编码并发送 1 条语音（不含网络）<br><code>cron-send-voice</code> | 5 次/s | 211.5 ms | 210.8 ms | 218.3 ms | 223.6 ms | 5 条记录/s | 0 B | ±0.5% |
| cron.json 中途改动 1 个任务：热重载并重排调度（满规格任务表）<br><code>cron-config-reload</code> | 8 次/s | 129.8 ms | 127.6 ms | 145.0 ms | 159.5 ms | 8 条记录/s | 7.31 MiB | ±0.2% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 40,019,871 次/s | 200.0 ns | 0 B | 11.83 KiB | ±1.7% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 45,952 次/s | 2.79 ms | 56.55 MiB | 24.52 KiB | ±2.0% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 375,519 次/s | 21.31 µs | 5.30 MiB | -2.44 KiB | ±2.2% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 13,176 次/s | 607.3 µs | 34.02 MiB | 178.09 KiB | ±1.4% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 62,511 次/s | 2.05 ms | 73.15 MiB | 128.69 KiB | ±3.2% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 20,597 次/s | 6.22 ms | 12.60 MiB | 420.96 KiB | ±1.3% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 17.0 ns | 59,679,554 次/s | 89.98 MiB | 22.37 KiB | ±11.1% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 27.8 ns | 35,982,616 次/s | 82.33 MiB | 28.09 KiB | ±4.3% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 18.2 ns | 55,066,834 次/s | 90.92 MiB | 27.99 KiB | ±5.5% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 192.6 ms | 2.52 MiB | 6.59 KiB | ±0.6% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 3.58 ms | 0 B | -4.76 KiB | ±0.7% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：09 命令与行为参考](09-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#10-性能基准) · [下一页：11 常见问题 →](11-faq.md)

</div>
