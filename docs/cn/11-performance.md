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

**最近一次全量基准** · Bun 1.4.4 · 3 轮取平均 · 2026-11-14T16:49:00Z · 进程启动到本地恢复就绪 358.6 ms · 单条群消息进入主干并完成基础分发 113.9 ns · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 191.7 µs / 4,414 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 1.72 ms / 453 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.4 (`38afee6c84fcf48c0edb2466aa4b27d287a59c30`) |
| 内核 | linux 6.8.0-149-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-11-14T16:49:00Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 394,548,253 |
| 进程读入 | 183.35 MiB |
| 进程写出 | 186.14 MiB |
| 块设备读 | 650.67 KiB |
| 块设备写 | 235.36 MiB |
| 读系统调用 | 49,976 |
| 写系统调用 | 245,813 |
| mock 根落盘 | 14.84 MiB |
| mock 根文件数 | 142 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 114.0 ms | ±2.5% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 10.84 ms | ±5.7% |
| 清理中断残留的原子写临时文件<br><code>orphan-cleanup</code> | 700.9 µs | ±2.5% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.33 ms | ±3.4% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 4.89 ms | ±3.9% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 655.2 µs | ±2.1% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 212.7 ms | ±0.8% |
| 填充主线程热缓存<br><code>hydrate</code> | 349.8 µs | ±4.8% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 358.6 ms | ±1.5% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 116.13 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 113.9 ns | 8,812,114 次/s | 92.49 MiB | 18.00 KiB | ±6.2% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 72.8 ns | 13,737,935 次/s | 93.66 MiB | 20.92 KiB | ±1.7% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 1.2 ns | 864,575,427 次/s | 81.26 MiB | 28.06 KiB | ±2.0% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 13.5 ns | 74,152,680 次/s | 81.41 MiB | 28.82 KiB | ±1.4% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 32.2 ns | 31,024,718 次/s | 82.50 MiB | 28.96 KiB | ±1.0% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.9 ns | 1,165,334,218 次/s | 80.09 MiB | 28.66 KiB | ±0.6% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 41.5 ns | 24,240,429 次/s | 81.57 MiB | 29.03 KiB | ±8.1% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.2 ns | 238,489,720 次/s | 80.19 MiB | 27.76 KiB | ±1.7% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 9.7 ns | 103,314,761 次/s | 80.36 MiB | 26.88 KiB | ±1.0% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 34.3 ns | 29,250,816 次/s | 85.29 MiB | 28.62 KiB | ±5.9% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 1.171 µs | 853,990 次/s | 105.63 MiB | 24.60 KiB | ±0.7% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 57.5 ns | 17,388,327 次/s | 87.28 MiB | 28.69 KiB | ±1.6% |
| 推进临时广告免检日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 42.2 ns | 23,731,120 次/s | 90.55 MiB | 28.50 KiB | ±3.3% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 47.8 ns | 20,926,595 次/s | 83.80 MiB | 28.30 KiB | ±1.7% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 166.0 ns | 6,038,208 次/s | 96.67 MiB | 20.96 KiB | ±5.0% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 303.5 ns | 3,321,698 次/s | 140.35 MiB | 20.93 KiB | ±9.2% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.8 ns | 209,670,018 次/s | 81.00 MiB | 26.71 KiB | ±5.6% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 2.456 µs | 407,175 次/s | 91.29 MiB | 23.61 KiB | ±0.4% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 30.6 ns | 32,688,801 次/s | 90.88 MiB | 19.55 KiB | ±2.7% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 228.7 ns | 4,372,087 次/s | 91.32 MiB | 22.60 KiB | ±0.7% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 37.70 µs | 26,530 次/s | 102.26 MiB | 22.78 KiB | ±1.3% |
| 提取回复引用<br><code>reply-reference</code> | 25.2 ns | 39,756,921 次/s | 91.70 MiB | 23.89 KiB | ±1.5% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 40.6 ns | 24,638,181 次/s | 101.56 MiB | 30.19 KiB | ±2.0% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 4.0 ns | 248,749,990 次/s | 81.70 MiB | 26.70 KiB | ±0.4% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 37.6 ns | 26,654,956 次/s | 88.61 MiB | 28.92 KiB | ±4.2% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 19.9 ns | 50,217,820 次/s | 80.48 MiB | 27.45 KiB | ±0.8% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 14.9 ns | 66,964,824 次/s | 80.18 MiB | 28.11 KiB | ±0.7% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 84.0 ns | 11,898,852 次/s | 80.53 MiB | 28.45 KiB | ±0.8% |
| Mini App 后端：双层鉴权与受管群列表状态汇总查询<br><code>mini-app-status-route</code> | 7.611 µs | 131,485 次/s | 92.81 MiB | 25.59 KiB | ±2.6% |
| Mini App 前端：状态看板比对、格式化与折叠/滑块逐帧动画计算<br><code>mini-app-frontend-render</code> | 544.0 ns | 1,838,987 次/s | 100.84 MiB | 34.10 KiB | ±1.9% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。cron 语音一行同样把语音合成模型与 Telegram 换成固定应答（约 11 秒的 WAV），包含 Base64 解码、WAV 解析、Opus 编码与发送边界；合成在生产中位于 AI Worker，这一行在同一进程内串起两侧，不含线程间传递。cron.json 一行只量中途变更的开销，不执行任务：任务表取生产上限（128 个任务、每个 16 个动作，本地来源相对数据根），每次改动其中 1 个任务后按生产顺序读取并严格解析六份可热重载文件（含逐项核对本地来源）、替换快照并按任务名对账调度器；改写与写盘属于部署方，不计时；文件监听的防抖等待、随后的广告检测与 AI 闲聊可用性重算和热重载日志也不计入。Mini App 五行分别覆盖同步鉴权与资源输出的关键路径：API 请求一行从 `Bun.serve` 路由处理器入口跑完同步鉴权流水线（请求头护栏、Telegram WebApp `initData` HMAC-SHA256 签名与超管身份核验、45 分钟密码会话核验）、受管群状态与 QA/热消息计数汇总、经真实 Disk I/O Worker 读取过去 24 小时入群日志并按 1–24 小时滑窗聚合、以及 HTTP JSON 响应序列化与解析；其余四行分别隔离测量未授权拒绝页预切分属性注入、单页门禁 Cookie 放行、密码登录鉴权签发与带 `?token=` 受保护图库资源的本地处理开销。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 923 次/s | 1.08 ms | 1.02 ms | 1.34 ms | 7.20 ms | 923 条记录/s | 3.91 MiB | ±2.2% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 350 次/s | 2.86 ms | 2.79 ms | 4.92 ms | 14.86 ms | 44,747 条记录/s | 21.42 MiB | ±3.9% |
| 累计 1 条临时广告免检活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 715 次/s | 1.42 ms | 1.20 ms | 2.55 ms | 10.72 ms | 715 条记录/s | 3.15 MiB | ±13.3% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 787 次/s | 1.28 ms | 1.16 ms | 1.96 ms | 5.43 ms | 787 条记录/s | 3.13 MiB | ±8.0% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 750 次/s | 1.33 ms | 1.28 ms | 1.64 ms | 7.56 ms | 750 条记录/s | 3.13 MiB | ±2.1% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 404 次/s | 2.48 ms | 2.24 ms | 3.40 ms | 14.37 ms | 404 条记录/s | 5.55 MiB | ±3.6% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 877 次/s | 1.14 ms | 1.06 ms | 1.48 ms | 11.33 ms | 877 条记录/s | 4.16 MiB | ±2.7% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 453 次/s | 2.31 ms | 1.72 ms | 4.60 ms | 16.54 ms | 453 条记录/s | 1.82 MiB | ±23.4% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 4,414 次/s | 224.1 µs | 191.7 µs | 457.3 µs | 562.7 µs | 4,414 条记录/s | 0 B | ±2.9% |
| cron send_voice：合成、编码并发送 1 条语音（不含网络）<br><code>cron-send-voice</code> | 5 次/s | 214.8 ms | 214.5 ms | 218.8 ms | 222.0 ms | 5 条记录/s | 0 B | ±2.3% |
| cron.json 中途改动 1 个任务：热重载并重排调度（满规格任务表）<br><code>cron-config-reload</code> | 9 次/s | 117.0 ms | 115.9 ms | 128.7 ms | 145.8 ms | 9 条记录/s | 7.31 MiB | ±0.7% |
| Mini App API 请求：完整鉴权链、群详情状态聚合与入群日志 24h 查询（GET /api/chats/:chatId）<br><code>mini-app-api-request</code> | 6,361 次/s | 175.1 µs | 132.3 µs | 384.0 µs | 1.99 ms | 6,361 条记录/s | 0 B | ±29.0% |
| Mini App 未授权拒绝页：诊断参数计算与 reject.html 属性注入（serveMiniAppRejectHtml）<br><code>mini-app-reject-page</code> | 21,996 次/s | 45.25 µs | 28.49 µs | 76.88 µs | 1.86 ms | 21,996 条记录/s | 0 B | ±3.0% |
| Mini App 单页门禁放行：Cookie HMAC-SHA256 验签与锁定检查（evaluateMiniAppPageGateRequest）<br><code>mini-app-page-gate-allow</code> | 201,855 次/s | 4.941 µs | 3.238 µs | 7.563 µs | 1.92 ms | 201,855 条记录/s | 28.00 KiB | ±24.3% |
| Mini App 登录接口：initData 验签、密码核验、会话与门禁 Cookie 签发（POST /api/auth/login）<br><code>mini-app-auth-login</code> | 26,907 次/s | 36.77 µs | 28.87 µs | 57.17 µs | 2.65 ms | 26,907 条记录/s | 0 B | ±1.8% |
| Mini App 受保护图库资源：资源令牌 ?token= 鉴权与图片响应读取（GET /api/gallery/file/:fileName）<br><code>mini-app-gallery-asset</code> | 15,203 次/s | 65.35 µs | 57.89 µs | 92.78 µs | 920.2 µs | 15,203 条记录/s | 0 B | ±1.4% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 37,640,795 次/s | 214.1 ns | 0 B | 12.75 KiB | ±8.3% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 45,744 次/s | 2.80 ms | 56.55 MiB | 23.59 KiB | ±3.0% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 347,885 次/s | 23.07 µs | 5.30 MiB | -11.04 KiB | ±5.6% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 10,953 次/s | 730.4 µs | 34.02 MiB | 206.13 KiB | ±0.7% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 63,966 次/s | 2.01 ms | 73.15 MiB | 129.93 KiB | ±5.4% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 20,586 次/s | 6.22 ms | 12.60 MiB | 424.02 KiB | ±2.1% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 17.6 ns | 57,026,584 次/s | 91.33 MiB | 23.08 KiB | ±6.5% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 28.6 ns | 35,083,495 次/s | 83.07 MiB | 28.72 KiB | ±5.1% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 15.7 ns | 64,269,681 次/s | 91.25 MiB | 28.32 KiB | ±10.6% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 197.6 ms | 2.56 MiB | 6.45 KiB | ±4.1% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 3.64 ms | 0 B | -4.76 KiB | ±2.3% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：10 Mini App 设置与推荐配置](10-mini-app.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#11-性能基准) · [下一页：12 常见问题 →](12-faq.md)

</div>
