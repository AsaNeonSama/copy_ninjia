# 11 性能基准

<p align="center">
  <b>简体中文</b> · <a href="../en/11-performance.md">English</a> · <a href="../ja/11-performance.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="10-mini-app.md">← 上一页：10 Mini App 设置与推荐配置</a> · <a href="12-faq.md">下一页：12 常见问题 →</a>
</p>

---

本页记录的性能基准数据由 `bun run perf:full -- --write-doc` 自动测算并生成，每次发版时会重新执行并整体替换数据区块。
**请勿手动编辑下方标记之间的内容**，发布时中、英、日三份文档由脚本统一同步覆盖。

执行该命令时，**结构化报告全文**会被同步写入项目根目录下的 `performance-result.json` 的 `fullSuite.lastRun` 节点（包含硬件环境、测试分区、逐项平均耗时与变异系数）。文档内的基准数据区块与该 JSON 数据由 `--write-doc` 参数原子写入。

全量基准测试仅在发版前或接到明确指令时按需执行，不包含在常规的 `bun run check` 持续集成门禁中；针对生产热路径的 GC 垃圾回收、物理驻留内存（RSS）与 JIT 编译硬门禁，由 `bun run perf:hot-path-gate` 命令独立保障，详见 [05 开发流程与质量门禁](05-dev-workflow.md)。

专项测试场景以及 `bun run perf:disk-transport` 的测量边界与复现步骤，请参阅 [05 开发流程与质量门禁](05-dev-workflow.md#专项场景与传输压力验证)。专项测试输出与热路径门禁数据独立记录，不会覆盖下方的全量基准区块。

<!-- performance-benchmark:start -->

**最近一次全量基准** · Bun 1.4.4 · 3 轮取平均 · 2026-11-07T11:06:15Z · 进程启动到本地恢复就绪 362.4 ms · 单条群消息进入主干并完成基础分发 114.8 ns · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 186.7 µs / 4,578 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 1.70 ms / 552 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.4 (`38afee6c84fcf48c0edb2466aa4b27d287a59c30`) |
| 内核 | linux 6.8.0-31-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-11-07T11:06:15Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 394,541,853 |
| 进程读入 | 183.12 MiB |
| 进程写出 | 186.10 MiB |
| 块设备读 | 0 B |
| 块设备写 | 235.29 MiB |
| 读系统调用 | 49,001 |
| 写系统调用 | 244,982 |
| mock 根落盘 | 14.59 MiB |
| mock 根文件数 | 130 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 110.5 ms | ±2.2% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 11.12 ms | ±0.2% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 734.8 µs | ±6.4% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.35 ms | ±7.3% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 4.50 ms | ±5.8% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 714.0 µs | ±6.9% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 220.1 ms | ±4.8% |
| 填充主线程热缓存<br><code>hydrate</code> | 329.6 µs | ±3.4% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 362.4 ms | ±2.4% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 116.07 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 114.8 ns | 8,751,182 次/s | 95.04 MiB | 17.50 KiB | ±6.6% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 71.3 ns | 14,029,232 次/s | 93.89 MiB | 21.86 KiB | ±1.9% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 1.1 ns | 889,458,216 次/s | 81.80 MiB | 26.87 KiB | ±2.1% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 13.5 ns | 73,848,674 次/s | 82.23 MiB | 28.41 KiB | ±2.0% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 31.7 ns | 31,606,244 次/s | 83.44 MiB | 28.52 KiB | ±2.9% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.9 ns | 1,164,077,476 次/s | 80.67 MiB | 27.86 KiB | ±1.6% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 44.9 ns | 22,460,406 次/s | 82.21 MiB | 27.90 KiB | ±8.6% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.0 ns | 248,821,999 次/s | 80.44 MiB | 27.66 KiB | ±0.5% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 9.6 ns | 104,115,533 次/s | 81.29 MiB | 27.21 KiB | ±1.8% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 36.0 ns | 27,900,788 次/s | 85.21 MiB | 28.24 KiB | ±7.1% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 1.185 µs | 843,649 次/s | 107.35 MiB | 23.88 KiB | ±0.6% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 56.9 ns | 17,583,508 次/s | 87.09 MiB | 27.75 KiB | ±2.4% |
| 推进临时广告免检日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 39.6 ns | 25,228,230 次/s | 90.82 MiB | 27.73 KiB | ±1.2% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 47.8 ns | 20,941,102 次/s | 84.08 MiB | 27.25 KiB | ±1.0% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 161.5 ns | 6,199,732 次/s | 95.85 MiB | 21.13 KiB | ±4.0% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 284.7 ns | 3,519,305 次/s | 138.02 MiB | 22.70 KiB | ±4.4% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 5.7 ns | 178,767,528 次/s | 82.15 MiB | 26.83 KiB | ±15.7% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 2.080 µs | 480,758 次/s | 92.84 MiB | 23.67 KiB | ±1.1% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 31.4 ns | 31,909,396 次/s | 90.21 MiB | 18.56 KiB | ±2.4% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 217.1 ns | 4,608,847 次/s | 92.47 MiB | 22.80 KiB | ±2.5% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 37.06 µs | 26,984 次/s | 102.43 MiB | 21.37 KiB | ±0.6% |
| 提取回复引用<br><code>reply-reference</code> | 31.7 ns | 33,264,514 次/s | 91.74 MiB | 23.78 KiB | ±25.0% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 39.9 ns | 25,082,207 次/s | 101.94 MiB | 29.76 KiB | ±3.1% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 4.2 ns | 240,651,988 次/s | 81.74 MiB | 26.17 KiB | ±2.1% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 36.1 ns | 27,736,712 次/s | 89.22 MiB | 28.94 KiB | ±2.3% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 19.3 ns | 51,768,141 次/s | 81.64 MiB | 27.37 KiB | ±0.6% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 14.8 ns | 67,418,227 次/s | 80.93 MiB | 27.20 KiB | ±1.2% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 82.6 ns | 12,116,102 次/s | 81.10 MiB | 27.74 KiB | ±1.7% |
| Mini App 后端：双层鉴权与受管群列表状态汇总查询<br><code>mini-app-status-route</code> | 7.186 µs | 139,171 次/s | 93.10 MiB | 22.94 KiB | ±0.6% |
| Mini App 前端：状态看板比对、格式化与折叠/滑块逐帧动画计算<br><code>mini-app-frontend-render</code> | 475.7 ns | 2,102,363 次/s | 102.38 MiB | 34.38 KiB | ±0.5% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。cron 语音一行同样把语音合成模型与 Telegram 换成固定应答（约 11 秒的 WAV），包含 Base64 解码、WAV 解析、Opus 编码与发送边界；合成在生产中位于 AI Worker，这一行在同一进程内串起两侧，不含线程间传递。cron.json 一行只量中途变更的开销，不执行任务：任务表取生产上限（128 个任务、每个 16 个动作，本地来源相对数据根），每次改动其中 1 个任务后按生产顺序读取并严格解析六份可热重载文件（含逐项核对本地来源）、替换快照并按任务名对账调度器；改写与写盘属于部署方，不计时；文件监听的防抖等待、随后的广告检测与 AI 闲聊可用性重算和热重载日志也不计入。Mini App API 请求一行从 `Bun.serve` 路由处理器入口跑完完整鉴权中间件链（请求头护栏、Telegram WebApp `initData` HMAC-SHA256 签名与超管身份核验、45 分钟密码会话续期）、受管群状态与 QA/热消息计数汇总、经真实 Disk I/O Worker 读取过去 24 小时入群日志并按 1–24 小时滑窗聚合、以及 HTTP JSON 响应序列化与解析，衡量典型管理端 API 的单进程端到端 RPS。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 835 次/s | 1.20 ms | 1.10 ms | 1.72 ms | 10.17 ms | 835 条记录/s | 3.91 MiB | ±4.4% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 333 次/s | 3.00 ms | 2.78 ms | 5.45 ms | 19.18 ms | 42,680 条记录/s | 21.42 MiB | ±4.5% |
| 累计 1 条临时广告免检活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 658 次/s | 1.53 ms | 1.28 ms | 2.69 ms | 8.62 ms | 658 条记录/s | 3.15 MiB | ±6.7% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 663 次/s | 1.51 ms | 1.40 ms | 2.18 ms | 6.27 ms | 663 条记录/s | 3.13 MiB | ±5.7% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 681 次/s | 1.47 ms | 1.36 ms | 2.00 ms | 7.88 ms | 681 条记录/s | 3.13 MiB | ±5.8% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 345 次/s | 2.92 ms | 2.57 ms | 4.63 ms | 14.16 ms | 345 条记录/s | 5.55 MiB | ±8.4% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 783 次/s | 1.29 ms | 1.14 ms | 1.91 ms | 8.66 ms | 783 条记录/s | 4.16 MiB | ±9.4% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 552 次/s | 1.81 ms | 1.70 ms | 2.30 ms | 6.49 ms | 552 条记录/s | 1.82 MiB | ±2.4% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 4,578 次/s | 215.9 µs | 186.7 µs | 402.1 µs | 550.8 µs | 4,578 条记录/s | 0 B | ±1.0% |
| cron send_voice：合成、编码并发送 1 条语音（不含网络）<br><code>cron-send-voice</code> | 5 次/s | 212.2 ms | 211.7 ms | 219.8 ms | 222.2 ms | 5 条记录/s | 0 B | ±1.7% |
| cron.json 中途改动 1 个任务：热重载并重排调度（满规格任务表）<br><code>cron-config-reload</code> | 8 次/s | 127.7 ms | 127.1 ms | 140.2 ms | 146.4 ms | 8 条记录/s | 7.31 MiB | ±1.3% |
| Mini App API 请求：完整鉴权链、群详情状态聚合与入群日志 24h 查询（GET /api/chats/:chatId）<br><code>mini-app-api-request</code> | 6,491 次/s | 155.1 µs | 130.5 µs | 225.3 µs | 2.29 ms | 6,491 条记录/s | 0 B | ±10.4% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 40,890,946 次/s | 195.7 ns | 0 B | 11.39 KiB | ±1.6% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 45,662 次/s | 2.80 ms | 56.55 MiB | 23.64 KiB | ±1.0% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 380,347 次/s | 21.03 µs | 5.30 MiB | 5.35 KiB | ±0.8% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 13,328 次/s | 600.3 µs | 34.02 MiB | 186.13 KiB | ±1.1% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 62,699 次/s | 2.05 ms | 73.15 MiB | 128.85 KiB | ±4.9% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 18,519 次/s | 6.91 ms | 12.60 MiB | 421.74 KiB | ±1.8% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 17.3 ns | 57,711,784 次/s | 91.58 MiB | 22.52 KiB | ±3.3% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 33.3 ns | 30,801,619 次/s | 83.76 MiB | 27.59 KiB | ±15.1% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 19.5 ns | 51,325,122 次/s | 92.14 MiB | 28.22 KiB | ±5.5% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 195.1 ms | 2.80 MiB | 6.52 KiB | ±1.4% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 3.63 ms | 0 B | -4.76 KiB | ±2.6% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：10 Mini App 设置与推荐配置](10-mini-app.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#11-性能基准) · [下一页：12 常见问题 →](12-faq.md)

</div>
