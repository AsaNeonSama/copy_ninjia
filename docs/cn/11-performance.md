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

**最近一次全量基准** · Bun 1.4.5 · 3 轮取平均 · 2026-11-27T15:00:34Z · 进程启动到本地恢复就绪 381.3 ms · 单条群消息进入主干并完成基础分发 106.0 ns · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 178.7 µs / 4,647 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 1.84 ms / 511 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.5 (`a7733435cf40429e3b35c36072769df2052b80f1`) |
| 内核 | linux 6.8.0-151-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-11-27T15:00:34Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 394,548,253 |
| 进程读入 | 184.22 MiB |
| 进程写出 | 186.61 MiB |
| 块设备读 | 0 B |
| 块设备写 | 235.68 MiB |
| 读系统调用 | 50,170 |
| 写系统调用 | 275,485 |
| mock 根落盘 | 15.11 MiB |
| mock 根文件数 | 144 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 126.4 ms | ±11.8% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 12.54 ms | ±10.6% |
| 清理中断残留的原子写临时文件并校验配置目录布局<br><code>orphan-cleanup</code> | 1.47 ms | ±5.9% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.38 ms | ±2.2% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 5.74 ms | ±9.7% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 650.9 µs | ±6.5% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 215.1 ms | ±0.4% |
| 填充主线程热缓存<br><code>hydrate</code> | 4.74 ms | ±1.0% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 381.3 ms | ±4.3% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 126.17 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 106.0 ns | 9,496,678 次/s | 103.66 MiB | 15.36 KiB | ±8.2% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 69.5 ns | 14,396,262 次/s | 104.70 MiB | 22.94 KiB | ±0.9% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 1.1 ns | 904,915,277 次/s | 92.74 MiB | 27.71 KiB | ±0.2% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 13.3 ns | 75,447,292 次/s | 92.20 MiB | 28.53 KiB | ±4.0% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 31.4 ns | 31,878,858 次/s | 93.81 MiB | 29.14 KiB | ±0.4% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.8 ns | 1,202,653,366 次/s | 90.89 MiB | 28.54 KiB | ±1.3% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 45.1 ns | 22,241,642 次/s | 92.74 MiB | 28.76 KiB | ±5.5% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.0 ns | 250,142,327 次/s | 90.84 MiB | 28.39 KiB | ±1.5% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 9.4 ns | 106,887,081 次/s | 92.01 MiB | 27.90 KiB | ±1.0% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 32.6 ns | 30,824,345 次/s | 95.59 MiB | 28.73 KiB | ±7.4% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 1.076 µs | 930,188 次/s | 116.34 MiB | 24.14 KiB | ±3.2% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 39.7 ns | 25,226,973 次/s | 97.54 MiB | 28.72 KiB | ±2.0% |
| 推进临时广告免检日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 39.3 ns | 25,441,287 次/s | 100.85 MiB | 28.01 KiB | ±1.2% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 43.8 ns | 22,928,771 次/s | 94.72 MiB | 28.51 KiB | ±5.6% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 183.9 ns | 5,445,052 次/s | 103.02 MiB | 20.65 KiB | ±3.4% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 201.8 ns | 4,957,290 次/s | 144.46 MiB | 23.01 KiB | ±1.9% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.8 ns | 209,275,521 次/s | 92.74 MiB | 27.07 KiB | ±5.6% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 2.847 µs | 351,348 次/s | 101.15 MiB | 23.81 KiB | ±1.7% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 20.2 ns | 49,451,896 次/s | 102.35 MiB | 26.27 KiB | ±0.5% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 222.7 ns | 4,492,435 次/s | 101.08 MiB | 22.63 KiB | ±1.7% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 33.44 µs | 29,913 次/s | 112.95 MiB | 23.98 KiB | ±1.2% |
| 提取回复引用<br><code>reply-reference</code> | 27.2 ns | 37,562,889 次/s | 102.47 MiB | 23.59 KiB | ±15.6% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 39.8 ns | 25,105,779 次/s | 113.17 MiB | 29.79 KiB | ±0.7% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 4.0 ns | 247,328,657 次/s | 91.90 MiB | 27.24 KiB | ±2.3% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 35.6 ns | 28,106,710 次/s | 99.05 MiB | 25.36 KiB | ±2.7% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 15.5 ns | 64,417,191 次/s | 91.86 MiB | 27.95 KiB | ±1.2% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 14.6 ns | 68,298,469 次/s | 91.53 MiB | 26.71 KiB | ±0.8% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 75.7 ns | 13,240,523 次/s | 91.19 MiB | 28.00 KiB | ±5.0% |
| Mini App 后端：双层鉴权与受管群列表状态汇总查询<br><code>mini-app-status-route</code> | 7.222 µs | 138,567 次/s | 104.46 MiB | 25.81 KiB | ±2.6% |
| Mini App 前端：状态看板比对、格式化与折叠/滑块逐帧动画计算<br><code>mini-app-frontend-render</code> | 544.1 ns | 1,838,359 次/s | 112.10 MiB | 34.85 KiB | ±1.3% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。cron 语音一行同样把语音合成模型与 Telegram 换成固定应答（约 11 秒的 WAV），包含 Base64 解码、WAV 解析、Opus 编码与发送边界；合成在生产中位于 AI Worker，这一行在同一进程内串起两侧，不含线程间传递。cron.json 一行只量中途变更的开销，不执行任务：任务表取生产上限（128 个任务、每个 16 个动作，本地来源相对数据根），每次改动其中 1 个任务后按生产顺序读取并严格解析六份可热重载文件（含逐项核对本地来源）、替换快照并按任务名对账调度器；改写与写盘属于部署方，不计时；文件监听的防抖等待、随后的广告检测与 AI 闲聊可用性重算和热重载日志也不计入。Mini App 五行分别覆盖同步鉴权与资源输出的关键路径：API 请求一行从 `Bun.serve` 路由处理器入口跑完同步鉴权流水线（请求头护栏、Telegram WebApp `initData` HMAC-SHA256 签名与超管身份核验、45 分钟二次认证会话核验）、受管群状态与 QA/热消息计数汇总、经真实 Disk I/O Worker 读取过去 24 小时入群日志并按 1–24 小时滑窗聚合、以及 AES-256-GCM 加密信封响应封装、解密与 JSON 解析；其余四行分别隔离测量未授权拒绝页预切分属性注入、单页门禁 Cookie 放行、TLS 模式预检 Ed25519 验签与临时 X25519 ECDH 协商加密登录签发 256-bit 会话临时密钥，以及带 `?e=` 加密查询的受保护图库资源读取本地开销。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 783 次/s | 1.28 ms | 1.19 ms | 1.79 ms | 9.07 ms | 783 条记录/s | 3.91 MiB | ±2.3% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 327 次/s | 3.06 ms | 2.85 ms | 4.93 ms | 12.78 ms | 41,805 条记录/s | 21.42 MiB | ±1.5% |
| 累计 1 条临时广告免检活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 635 次/s | 1.58 ms | 1.47 ms | 2.13 ms | 7.66 ms | 635 条记录/s | 3.15 MiB | ±3.0% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 635 次/s | 1.57 ms | 1.37 ms | 2.45 ms | 9.24 ms | 635 条记录/s | 3.13 MiB | ±0.8% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 641 次/s | 1.56 ms | 1.42 ms | 2.14 ms | 7.11 ms | 641 条记录/s | 3.13 MiB | ±3.7% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 365 次/s | 2.74 ms | 2.56 ms | 3.88 ms | 11.03 ms | 365 条记录/s | 5.55 MiB | ±3.8% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 773 次/s | 1.30 ms | 1.21 ms | 1.71 ms | 16.92 ms | 773 条记录/s | 4.11 MiB | ±6.7% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 511 次/s | 1.96 ms | 1.84 ms | 2.48 ms | 7.02 ms | 511 条记录/s | 1.82 MiB | ±4.4% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 4,647 次/s | 212.6 µs | 178.7 µs | 386.3 µs | 575.1 µs | 4,647 条记录/s | 0 B | ±1.8% |
| cron send_voice：合成、编码并发送 1 条语音（不含网络）<br><code>cron-send-voice</code> | 8 次/s | 119.2 ms | 119.0 ms | 123.6 ms | 124.9 ms | 8 条记录/s | 0 B | ±0.7% |
| cron.json 中途改动 1 个任务：热重载并重排调度（满规格任务表）<br><code>cron-config-reload</code> | 9 次/s | 112.2 ms | 111.8 ms | 117.2 ms | 119.6 ms | 9 条记录/s | 7.31 MiB | ±0.1% |
| Mini App API 请求：完整鉴权链、群详情状态聚合与入群日志 24h 查询（GET /api/chats/detail?e=...）<br><code>mini-app-api-request</code> | 2,954 次/s | 337.9 µs | 292.4 µs | 443.6 µs | 4.31 ms | 2,954 条记录/s | 1.33 KiB | ±3.2% |
| Mini App 未授权拒绝页：诊断参数计算与 reject.html 属性注入（serveMiniAppRejectHtml）<br><code>mini-app-reject-page</code> | 23,095 次/s | 43.08 µs | 27.81 µs | 76.77 µs | 869.0 µs | 23,095 条记录/s | 0 B | ±3.3% |
| Mini App 单页门禁放行：Cookie HMAC-SHA256 验签与锁定检查（evaluateMiniAppPageGateRequest）<br><code>mini-app-page-gate-allow</code> | 245,152 次/s | 3.915 µs | 3.186 µs | 7.515 µs | 51.67 µs | 245,152 条记录/s | 28.00 KiB | ±0.7% |
| Mini App ECDH 登录协商：预检 Ed25519 验签临时 X25519 公钥、HKDF 派生方向密钥与加密登录签发 45 分钟 AES PSK（GET /api/auth/precheck → POST /api/auth/login）<br><code>mini-app-auth-login</code> | 1,407 次/s | 709.4 µs | 665.8 µs | 868.6 µs | 6.46 ms | 1,407 条记录/s | 364.00 KiB | ±0.2% |
| Mini App 受保护图库资源：双层会话与加密查询 ?e= 鉴权及图片响应读取（GET /api/gallery/file?e=...）<br><code>mini-app-gallery-asset</code> | 5,048 次/s | 197.3 µs | 169.5 µs | 270.9 µs | 3.51 ms | 5,048 条记录/s | 0 B | ±1.3% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 41,174,407 次/s | 194.5 ns | 0 B | 9.14 KiB | ±2.9% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 41,564 次/s | 3.08 ms | 56.55 MiB | 23.27 KiB | ±1.4% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 394,301 次/s | 20.30 µs | 5.31 MiB | 33.55 KiB | ±2.2% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 10,041 次/s | 796.8 µs | 34.02 MiB | 218.02 KiB | ±0.6% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 57,394 次/s | 2.23 ms | 73.18 MiB | 166.67 KiB | ±4.7% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 16,916 次/s | 7.62 ms | 12.62 MiB | 417.94 KiB | ±7.9% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 15.3 ns | 65,984,186 次/s | 101.90 MiB | 23.22 KiB | ±9.0% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 30.9 ns | 32,915,532 次/s | 95.07 MiB | 28.34 KiB | ±13.2% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 19.3 ns | 51,887,844 次/s | 102.68 MiB | 29.04 KiB | ±1.9% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 91.94 ms | 2.96 MiB | 6.48 KiB | ±0.2% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 3.59 ms | 0 B | -5.27 KiB | ±2.9% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：10 Mini App 设置与推荐配置](10-mini-app.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#11-性能基准) · [下一页：12 常见问题 →](12-faq.md)

</div>
