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

**最近一次全量基准** · Bun 1.4.4 · 3 轮取平均 · 2026-11-15T09:55:28Z · 进程启动到本地恢复就绪 405.6 ms · 单条群消息进入主干并完成基础分发 106.2 ns · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 200.5 µs / 4,411 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 1.77 ms / 497 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.4 (`38afee6c84fcf48c0edb2466aa4b27d287a59c30`) |
| 内核 | linux 6.8.0-149-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-11-15T09:55:28Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 394,548,253 |
| 进程读入 | 183.35 MiB |
| 进程写出 | 186.14 MiB |
| 块设备读 | 85.33 KiB |
| 块设备写 | 235.36 MiB |
| 读系统调用 | 49,986 |
| 写系统调用 | 245,843 |
| mock 根落盘 | 14.84 MiB |
| mock 根文件数 | 142 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 118.3 ms | ±2.3% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 13.04 ms | ±11.8% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 676.7 µs | ±2.9% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.31 ms | ±2.9% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 4.76 ms | ±2.8% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 666.1 µs | ±3.4% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 253.3 ms | ±12.0% |
| 填充主线程热缓存<br><code>hydrate</code> | 340.1 µs | ±3.5% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 405.6 ms | ±8.1% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 115.79 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 106.2 ns | 9,427,994 次/s | 91.80 MiB | 18.25 KiB | ±4.1% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 71.7 ns | 13,949,425 次/s | 93.88 MiB | 22.01 KiB | ±2.2% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 1.1 ns | 873,899,875 次/s | 81.57 MiB | 27.56 KiB | ±1.7% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 13.1 ns | 76,513,877 次/s | 81.38 MiB | 28.86 KiB | ±1.7% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 31.8 ns | 31,462,166 次/s | 82.79 MiB | 28.92 KiB | ±1.5% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.9 ns | 1,163,854,203 次/s | 79.50 MiB | 28.26 KiB | ±2.4% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 42.8 ns | 23,488,122 次/s | 81.82 MiB | 28.63 KiB | ±7.4% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.1 ns | 241,319,549 次/s | 80.15 MiB | 28.00 KiB | ±1.0% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 9.5 ns | 105,303,832 次/s | 81.40 MiB | 28.63 KiB | ±1.0% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 36.3 ns | 27,747,215 次/s | 83.82 MiB | 28.19 KiB | ±8.9% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 1.138 µs | 879,656 次/s | 105.72 MiB | 23.83 KiB | ±3.0% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 58.3 ns | 17,159,299 次/s | 87.05 MiB | 27.78 KiB | ±2.1% |
| 推进临时广告免检日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 42.0 ns | 23,809,645 次/s | 90.62 MiB | 27.66 KiB | ±0.5% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 47.5 ns | 21,039,740 次/s | 83.12 MiB | 28.67 KiB | ±1.2% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 157.7 ns | 6,348,692 次/s | 96.24 MiB | 19.63 KiB | ±3.7% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 285.3 ns | 3,506,817 次/s | 136.46 MiB | 22.15 KiB | ±1.9% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.7 ns | 212,654,995 次/s | 81.70 MiB | 26.80 KiB | ±5.5% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 2.472 µs | 404,582 次/s | 91.68 MiB | 23.41 KiB | ±1.4% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 31.4 ns | 31,897,789 次/s | 90.41 MiB | 19.12 KiB | ±1.1% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 221.1 ns | 4,526,511 次/s | 92.00 MiB | 21.86 KiB | ±2.6% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 37.57 µs | 26,622 次/s | 102.34 MiB | 23.10 KiB | ±1.0% |
| 提取回复引用<br><code>reply-reference</code> | 32.0 ns | 33,702,636 次/s | 90.81 MiB | 23.66 KiB | ±29.6% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 44.0 ns | 22,780,000 次/s | 100.90 MiB | 29.67 KiB | ±5.2% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 4.3 ns | 234,225,582 次/s | 80.61 MiB | 26.89 KiB | ±6.1% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 37.2 ns | 26,907,635 次/s | 87.95 MiB | 29.38 KiB | ±2.9% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 19.9 ns | 50,387,087 次/s | 80.63 MiB | 26.71 KiB | ±2.6% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 15.0 ns | 66,465,873 次/s | 79.85 MiB | 27.09 KiB | ±1.2% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 84.6 ns | 11,822,016 次/s | 79.97 MiB | 28.52 KiB | ±2.0% |
| Mini App 后端：双层鉴权与受管群列表状态汇总查询<br><code>mini-app-status-route</code> | 7.933 µs | 126,103 次/s | 92.28 MiB | 25.79 KiB | ±1.9% |
| Mini App 前端：状态看板比对、格式化与折叠/滑块逐帧动画计算<br><code>mini-app-frontend-render</code> | 533.8 ns | 1,873,471 次/s | 100.55 MiB | 34.63 KiB | ±0.9% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。cron 语音一行同样把语音合成模型与 Telegram 换成固定应答（约 11 秒的 WAV），包含 Base64 解码、WAV 解析、Opus 编码与发送边界；合成在生产中位于 AI Worker，这一行在同一进程内串起两侧，不含线程间传递。cron.json 一行只量中途变更的开销，不执行任务：任务表取生产上限（128 个任务、每个 16 个动作，本地来源相对数据根），每次改动其中 1 个任务后按生产顺序读取并严格解析六份可热重载文件（含逐项核对本地来源）、替换快照并按任务名对账调度器；改写与写盘属于部署方，不计时；文件监听的防抖等待、随后的广告检测与 AI 闲聊可用性重算和热重载日志也不计入。Mini App 五行分别覆盖同步鉴权与资源输出的关键路径：API 请求一行从 `Bun.serve` 路由处理器入口跑完同步鉴权流水线（请求头护栏、Telegram WebApp `initData` HMAC-SHA256 签名与超管身份核验、45 分钟密码会话核验）、受管群状态与 QA/热消息计数汇总、经真实 Disk I/O Worker 读取过去 24 小时入群日志并按 1–24 小时滑窗聚合、以及 HTTP JSON 响应序列化与解析；其余四行分别隔离测量未授权拒绝页预切分属性注入、单页门禁 Cookie 放行、密码登录鉴权签发与带 `?token=` 受保护图库资源的本地处理开销。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 849 次/s | 1.18 ms | 1.10 ms | 1.45 ms | 8.54 ms | 849 条记录/s | 3.91 MiB | ±1.2% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 332 次/s | 3.01 ms | 2.91 ms | 5.07 ms | 15.72 ms | 42,479 条记录/s | 21.42 MiB | ±1.8% |
| 累计 1 条临时广告免检活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 718 次/s | 1.43 ms | 1.22 ms | 2.54 ms | 7.32 ms | 718 条记录/s | 3.15 MiB | ±15.2% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 663 次/s | 1.52 ms | 1.26 ms | 2.83 ms | 13.46 ms | 663 条记录/s | 3.13 MiB | ±10.6% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 690 次/s | 1.45 ms | 1.36 ms | 1.78 ms | 8.83 ms | 690 条记录/s | 3.13 MiB | ±3.8% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 381 次/s | 2.62 ms | 2.37 ms | 3.91 ms | 10.76 ms | 381 条记录/s | 5.55 MiB | ±1.3% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 739 次/s | 1.35 ms | 1.13 ms | 2.26 ms | 16.37 ms | 739 条记录/s | 4.16 MiB | ±3.0% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 497 次/s | 2.05 ms | 1.77 ms | 3.40 ms | 9.09 ms | 497 条记录/s | 1.82 MiB | ±12.3% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 4,411 次/s | 224.2 µs | 200.5 µs | 434.3 µs | 646.8 µs | 4,411 条记录/s | 0 B | ±0.5% |
| cron send_voice：合成、编码并发送 1 条语音（不含网络）<br><code>cron-send-voice</code> | 5 次/s | 210.2 ms | 209.9 ms | 214.7 ms | 217.5 ms | 5 条记录/s | 0 B | ±1.1% |
| cron.json 中途改动 1 个任务：热重载并重排调度（满规格任务表）<br><code>cron-config-reload</code> | 9 次/s | 116.7 ms | 116.3 ms | 133.6 ms | 136.7 ms | 9 条记录/s | 7.31 MiB | ±1.5% |
| Mini App API 请求：完整鉴权链、群详情状态聚合与入群日志 24h 查询（GET /api/chats/:chatId）<br><code>mini-app-api-request</code> | 7,391 次/s | 135.7 µs | 116.8 µs | 218.3 µs | 1.06 ms | 7,391 条记录/s | 0 B | ±8.3% |
| Mini App 未授权拒绝页：诊断参数计算与 reject.html 属性注入（serveMiniAppRejectHtml）<br><code>mini-app-reject-page</code> | 22,197 次/s | 44.84 µs | 28.52 µs | 79.08 µs | 1.23 ms | 22,197 条记录/s | 0 B | ±2.9% |
| Mini App 单页门禁放行：Cookie HMAC-SHA256 验签与锁定检查（evaluateMiniAppPageGateRequest）<br><code>mini-app-page-gate-allow</code> | 239,538 次/s | 4.004 µs | 3.210 µs | 7.776 µs | 51.77 µs | 239,538 条记录/s | 28.00 KiB | ±2.7% |
| Mini App 登录接口：initData 验签、密码核验、会话与门禁 Cookie 签发（POST /api/auth/login）<br><code>mini-app-auth-login</code> | 26,498 次/s | 37.48 µs | 29.14 µs | 56.81 µs | 3.62 ms | 26,498 条记录/s | 0 B | ±3.9% |
| Mini App 受保护图库资源：资源令牌 ?token= 鉴权与图片响应读取（GET /api/gallery/file/:fileName）<br><code>mini-app-gallery-asset</code> | 13,047 次/s | 78.89 µs | 70.45 µs | 115.6 µs | 920.3 µs | 13,047 条记录/s | 0 B | ±17.7% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 40,424,637 次/s | 197.9 ns | 0 B | 12.51 KiB | ±0.9% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 44,251 次/s | 2.89 ms | 56.55 MiB | 23.15 KiB | ±1.6% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 357,277 次/s | 22.40 µs | 5.30 MiB | 17.31 KiB | ±2.2% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 10,730 次/s | 747.0 µs | 34.02 MiB | 202.35 KiB | ±4.4% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 62,366 次/s | 2.05 ms | 73.15 MiB | 129.90 KiB | ±1.4% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 18,115 次/s | 7.08 ms | 12.60 MiB | 423.72 KiB | ±3.8% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 17.0 ns | 59,027,553 次/s | 91.26 MiB | 23.09 KiB | ±3.6% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 28.6 ns | 35,157,015 次/s | 84.14 MiB | 28.74 KiB | ±7.3% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 19.1 ns | 52,390,672 次/s | 90.87 MiB | 28.98 KiB | ±1.0% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 198.2 ms | 3.21 MiB | 6.45 KiB | ±1.9% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 3.64 ms | 0 B | -4.76 KiB | ±3.0% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：10 Mini App 设置与推荐配置](10-mini-app.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#11-性能基准) · [下一页：12 常见问题 →](12-faq.md)

</div>
