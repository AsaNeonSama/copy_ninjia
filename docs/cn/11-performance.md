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

**最近一次全量基准** · Bun 1.4.5 · 3 轮取平均 · 2026-11-20T21:28:00Z · 进程启动到本地恢复就绪 406.8 ms · 单条群消息进入主干并完成基础分发 104.6 ns · ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿） 196.9 µs / 4,374 次/s · 广告检测：完整判定并处置 1 条群消息（不含网络） 1.79 ms / 457 次/s

## 运行环境

| 指标 | 读数 |
| --- | --- |
| 运行时 | Bun 1.4.5 (`a7733435cf40429e3b35c36072769df2052b80f1`) |
| 内核 | linux 6.8.0-149-generic · x64 |
| CPU 核心数 | 4 |
| 内存 | 7.76 GiB |
| 轮数 | 3 |
| mock 数据根 | `performance/` |
| 出数时间 | 2026-11-20T21:28:00Z |

## 总吞吐与总读写（每轮）

> 读写取自 `/proc/self/io`，覆盖冷启动、链路与存储三类子进程的整个生命周期（含各自建 fixture 的那一段）；热路径与容量线子进程是纯进程内计算，不产生文件读写。「块设备读」常年为 0 是正常的：fixture 刚写完就读，全部命中操作系统页缓存，本基准不清页缓存。

| 指标 | 读数 |
| --- | --- |
| 被测操作数 | 394,548,253 |
| 进程读入 | 183.76 MiB |
| 进程写出 | 186.55 MiB |
| 块设备读 | 0 B |
| 块设备写 | 235.61 MiB |
| 读系统调用 | 50,154 |
| 写系统调用 | 275,483 |
| mock 根落盘 | 15.02 MiB |
| mock 根文件数 | 144 |

## 冷路径 · 启动恢复

> 满库 fixture 上跑真实启动恢复，按 `packages/app/lifecycle.ts` 的 init 顺序逐段计时；不含 `bot.init()`、命令菜单注册与黑名单补扫等联网握手，也不含两个业务 Worker 的创建。

| 启动阶段 | 耗时 | 波动 |
| --- | --- | --- |
| 加载生产模块<br><code>module-graph</code> | 128.2 ms | ±7.0% |
| 取得数据根单实例锁<br><code>instance-lock</code> | 12.76 ms | ±6.6% |
| 清理中断残留的原子写临时文件并校验配置目录布局<br><code>orphan-cleanup</code> | 1.61 ms | ±7.0% |
| 读取并严格解析运行状态<br><code>state-load</code> | 1.56 ms | ±15.7% |
| 校验部署配置与 AI 人设<br><code>deployment-inputs</code> | 6.29 ms | ±7.7% |
| 创建 Disk I/O Worker<br><code>disk-io-init</code> | 707.6 µs | ±4.9% |
| 从 SQLite 与快照恢复数据<br><code>persisted-load</code> | 236.5 ms | ±7.4% |
| 填充主线程热缓存<br><code>hydrate</code> | 4.72 ms | ±1.1% |
| 进程启动到本地恢复就绪<br><code>ready-total</code> | 406.8 ms | ±6.6% |

> 本轮恢复：8,192 条白名单 · 8,192 条黑名单 · 25 群状态 · 375 条群问答 · 25 份 AI 记忆快照；进程峰值 RSS 125.33 MiB。

## 热路径 · 生产函数

> 每个场景一个独立进程，预热后取 7 个样本的中位数；吞吐由中位延迟折算。

| 场景 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 单条群消息进入主干并完成基础分发<br><code>incoming-message-spine</code> | 104.6 ns | 9,564,044 次/s | 98.69 MiB | 16.82 KiB | ±2.2% |
| AI 开启后一条直接唤起的媒体消息构造触发上下文与记录载荷<br><code>ai-media-direct-trigger</code> | 70.9 ns | 14,096,612 次/s | 103.77 MiB | 22.01 KiB | ±0.7% |
| 解析无 username 的发送者身份<br><code>sender-no-username</code> | 1.2 ns | 861,560,470 次/s | 91.61 MiB | 27.09 KiB | ±0.7% |
| 解析 username 未变化的发送者身份<br><code>sender-stable-username</code> | 13.2 ns | 75,622,415 次/s | 91.74 MiB | 28.09 KiB | ±3.2% |
| 同群内用户与频道马甲混合发言时解析发送者身份<br><code>sender-mixed-identity</code> | 31.4 ns | 31,883,621 次/s | 92.49 MiB | 28.47 KiB | ±1.0% |
| 拒绝机器人自身的空消息<br><code>self-sent-empty</code> | 0.8 ns | 1,185,316,424 次/s | 89.26 MiB | 27.25 KiB | ±0.9% |
| 机器人刚发过消息时判定一条群消息是否为自发回环<br><code>self-sent-active</code> | 48.9 ns | 20,440,277 次/s | 91.25 MiB | 28.20 KiB | ±1.6% |
| 直接读取当前群状态<br><code>chat-state-read</code> | 4.2 ns | 238,578,437 次/s | 89.29 MiB | 27.28 KiB | ±1.7% |
| 从群状态 Map 查询一群<br><code>chat-state-map-read</code> | 9.6 ns | 103,904,739 次/s | 89.44 MiB | 27.66 KiB | ±0.6% |
| 更新 AI 活跃度滑动窗口<br><code>ai-activity-window</code> | 33.5 ns | 29,969,514 次/s | 93.94 MiB | 27.93 KiB | ±7.2% |
| AI 活跃度 LRU 未命中并新建记录<br><code>ai-activity-lru-miss</code> | 1.114 µs | 898,217 次/s | 115.89 MiB | 23.87 KiB | ±2.6% |
| 查询本地身份权限<br><code>identity-permission-read</code> | 48.7 ns | 20,555,396 次/s | 95.18 MiB | 27.20 KiB | ±0.5% |
| 推进临时广告免检日内已达标稳态与授权边沿<br><code>temporary-whitelist-activity</code> | 41.5 ns | 24,100,249 次/s | 99.99 MiB | 27.24 KiB | ±2.0% |
| 查询已有刷屏控制窗口<br><code>flood-window-hit</code> | 49.1 ns | 20,389,204 次/s | 92.93 MiB | 27.79 KiB | ±1.5% |
| 刷屏控制窗口增长与淘汰<br><code>flood-window-growth</code> | 191.0 ns | 5,246,194 次/s | 102.34 MiB | 20.78 KiB | ±4.6% |
| 刷屏控制窗口稳态更新<br><code>flood-window-steady</code> | 211.2 ns | 4,741,021 次/s | 142.67 MiB | 22.65 KiB | ±3.4% |
| 广告检测空元数据快速路径<br><code>ad-empty-metadata</code> | 4.6 ns | 221,218,033 次/s | 90.73 MiB | 26.93 KiB | ±8.4% |
| 复制广告候选的 Worker 消息载荷<br><code>ad-wire-clone</code> | 2.452 µs | 407,804 次/s | 100.86 MiB | 23.09 KiB | ±1.0% |
| 广告检测队列满载拒绝<br><code>ad-capacity-reject</code> | 21.0 ns | 47,753,207 次/s | 101.35 MiB | 24.00 KiB | ±3.9% |
| 构造一条 AI 上下文消息<br><code>buffered-message-build</code> | 228.0 ns | 4,386,675 次/s | 100.52 MiB | 22.45 KiB | ±1.0% |
| 把 AI 群聊上下文渲染成提示词<br><code>transcript-render</code> | 34.63 µs | 28,873 次/s | 112.42 MiB | 23.55 KiB | ±0.1% |
| 提取回复引用<br><code>reply-reference</code> | 34.5 ns | 30,981,201 次/s | 100.96 MiB | 22.96 KiB | ±24.7% |
| 从 Telegram entity 提取 @ 提及<br><code>mention-facts</code> | 41.7 ns | 23,973,710 次/s | 110.22 MiB | 27.52 KiB | ±1.4% |
| 无 entity 文本的提及快速路径<br><code>mention-facts-plain</code> | 4.2 ns | 235,886,878 次/s | 91.00 MiB | 26.84 KiB | ±0.4% |
| 更新 gag 发言计数<br><code>gag-speak-counter</code> | 37.4 ns | 26,779,556 次/s | 97.99 MiB | 27.96 KiB | ±3.5% |
| 认领运势发送回执<br><code>luck-receipt-fast-path</code> | 16.3 ns | 61,177,351 次/s | 90.76 MiB | 28.01 KiB | ±1.5% |
| 按百分比查询运势档位<br><code>luck-tier-table</code> | 14.9 ns | 66,910,582 次/s | 90.28 MiB | 27.41 KiB | ±0.9% |
| 检查无需脱敏的日志文本<br><code>redact-clean-log</code> | 78.6 ns | 12,732,892 次/s | 89.93 MiB | 27.41 KiB | ±2.4% |
| Mini App 后端：双层鉴权与受管群列表状态汇总查询<br><code>mini-app-status-route</code> | 7.578 µs | 132,377 次/s | 103.38 MiB | 26.13 KiB | ±5.8% |
| Mini App 前端：状态看板比对、格式化与折叠/滑块逐帧动画计算<br><code>mini-app-frontend-render</code> | 572.7 ns | 1,748,604 次/s | 110.15 MiB | 34.90 KiB | ±3.9% |

## 完整流程 · 命令与落盘动作

> 每行都从生产入口跑到动作名称所写的完成点；「完整处理能力」表示单进程每秒能完整跑完多少次。前七行驱动真实 Disk I/O Worker，并计时到 durable 回执。广告检测与 `ai_chat` 两行把模型和 Telegram 替换为进程内固定应答，因此包含提示词、状态机、处置、序列化和磁盘等全部本地工作，但不含网络。`ai_chat` 到消息发送完成为止，不把 30 秒定时批量执行的记忆快照强摊到每轮回复；该成本由 AI 记忆快照行单列。它还扣除了发送前 1.5–7.5 秒的拟人停顿：这段停顿逐次实测、按群限速且不占 CPU，保留它只会显示产品节奏而不是处理能力。cron 语音一行同样把语音合成模型与 Telegram 换成固定应答（约 11 秒的 WAV），包含 Base64 解码、WAV 解析、Opus 编码与发送边界；合成在生产中位于 AI Worker，这一行在同一进程内串起两侧，不含线程间传递。cron.json 一行只量中途变更的开销，不执行任务：任务表取生产上限（128 个任务、每个 16 个动作，本地来源相对数据根），每次改动其中 1 个任务后按生产顺序读取并严格解析六份可热重载文件（含逐项核对本地来源）、替换快照并按任务名对账调度器；改写与写盘属于部署方，不计时；文件监听的防抖等待、随后的广告检测与 AI 闲聊可用性重算和热重载日志也不计入。Mini App 五行分别覆盖同步鉴权与资源输出的关键路径：API 请求一行从 `Bun.serve` 路由处理器入口跑完同步鉴权流水线（请求头护栏、Telegram WebApp `initData` HMAC-SHA256 签名与超管身份核验、45 分钟二次认证会话核验）、受管群状态与 QA/热消息计数汇总、经真实 Disk I/O Worker 读取过去 24 小时入群日志并按 1–24 小时滑窗聚合、以及 AES-256-GCM 加密信封响应封装、解密与 JSON 解析；其余四行分别隔离测量未授权拒绝页预切分属性注入、单页门禁 Cookie 放行、TLS 模式预检 Ed25519 验签与临时 X25519 ECDH 协商加密登录签发 256-bit 会话临时密钥，以及带 `?e=` 加密查询的受保护图库资源读取本地开销。

| 生产动作 | 完整处理能力 | 平均单次耗时 | 典型单次耗时 (p50) | 慢请求耗时 (p95) | 最慢单次 | 业务记录吞吐 | 块设备写 | 波动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 追加 1 条入群日志并收到落盘回执<br><code>join-log-append</code> | 897 次/s | 1.12 ms | 1.04 ms | 1.38 ms | 7.77 ms | 897 条记录/s | 3.91 MiB | ±2.6% |
| 批量写入 128 条身份策略并收到落盘回执<br><code>identity-policy-write</code> | 352 次/s | 2.84 ms | 2.81 ms | 4.46 ms | 12.41 ms | 45,074 条记录/s | 21.42 MiB | ±0.3% |
| 累计 1 条临时广告免检活动并收到 SQLite 精确回执<br><code>temporary-whitelist-write</code> | 781 次/s | 1.29 ms | 1.17 ms | 2.04 ms | 8.21 ms | 781 条记录/s | 3.15 MiB | ±8.7% |
| 写入 1 群状态并收到 SQLite 落盘回执<br><code>chat-state-write</code> | 665 次/s | 1.53 ms | 1.28 ms | 3.30 ms | 9.09 ms | 665 条记录/s | 3.13 MiB | ±12.4% |
| 写入 1 条群问答并收到 SQLite 落盘回执<br><code>chat-qa-write</code> | 674 次/s | 1.49 ms | 1.37 ms | 1.87 ms | 8.97 ms | 674 条记录/s | 3.13 MiB | ±5.5% |
| 重写 1 份 AI 记忆快照并收到落盘回执<br><code>ai-memory-snapshot</code> | 380 次/s | 2.63 ms | 2.41 ms | 3.94 ms | 11.24 ms | 380 条记录/s | 5.55 MiB | ±1.0% |
| 追加 1 条诊断日志并收到落盘回执<br><code>diagnostic-log</code> | 840 次/s | 1.19 ms | 1.12 ms | 1.44 ms | 8.98 ms | 840 条记录/s | 4.11 MiB | ±4.3% |
| 广告检测：完整判定并处置 1 条群消息（不含网络）<br><code>ad-detect-command</code> | 457 次/s | 2.27 ms | 1.79 ms | 4.74 ms | 9.87 ms | 457 条记录/s | 1.82 MiB | ±20.0% |
| ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）<br><code>ai-reply-command</code> | 4,374 次/s | 225.9 µs | 196.9 µs | 431.4 µs | 583.5 µs | 4,374 条记录/s | 0 B | ±1.2% |
| cron send_voice：合成、编码并发送 1 条语音（不含网络）<br><code>cron-send-voice</code> | 4 次/s | 223.4 ms | 222.7 ms | 233.4 ms | 236.6 ms | 4 条记录/s | 0 B | ±0.8% |
| cron.json 中途改动 1 个任务：热重载并重排调度（满规格任务表）<br><code>cron-config-reload</code> | 8 次/s | 120.3 ms | 117.5 ms | 137.9 ms | 165.3 ms | 8 条记录/s | 7.31 MiB | ±1.1% |
| Mini App API 请求：完整鉴权链、群详情状态聚合与入群日志 24h 查询（GET /api/chats/detail?e=...）<br><code>mini-app-api-request</code> | 2,713 次/s | 367.5 µs | 327.6 µs | 483.4 µs | 4.90 ms | 2,713 条记录/s | 0 B | ±0.9% |
| Mini App 未授权拒绝页：诊断参数计算与 reject.html 属性注入（serveMiniAppRejectHtml）<br><code>mini-app-reject-page</code> | 21,387 次/s | 46.80 µs | 29.68 µs | 90.22 µs | 924.9 µs | 21,387 条记录/s | 0 B | ±8.2% |
| Mini App 单页门禁放行：Cookie HMAC-SHA256 验签与锁定检查（evaluateMiniAppPageGateRequest）<br><code>mini-app-page-gate-allow</code> | 235,217 次/s | 4.075 µs | 3.236 µs | 7.960 µs | 64.80 µs | 235,217 条记录/s | 18.67 KiB | ±1.6% |
| Mini App ECDH 登录协商：预检 Ed25519 验签临时 X25519 公钥、HKDF 派生方向密钥与加密登录签发 45 分钟 AES PSK（GET /api/auth/precheck → POST /api/auth/login）<br><code>mini-app-auth-login</code> | 1,323 次/s | 754.8 µs | 698.5 µs | 956.1 µs | 5.71 ms | 1,323 条记录/s | 364.00 KiB | ±1.0% |
| Mini App 受保护图库资源：双层会话与加密查询 ?e= 鉴权及图片响应读取（GET /api/gallery/file?e=...）<br><code>mini-app-gallery-asset</code> | 4,577 次/s | 218.7 µs | 192.6 µs | 296.7 µs | 3.19 ms | 4,577 条记录/s | 0 B | ±7.1% |

## 存储 · SQLite 与主线程缓存

> 复用 `bun run perf:identity-database` 的实现；「冷」指连接页缓存与语句缓存为空，不声称绕过操作系统页缓存。

| 操作 | 每秒调用 | 平均批次耗时 | 块设备写 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 查询主线程身份 LRU 缓存<br><code>main-lru-read</code> | 39,755,559 次/s | 201.3 ns | 0 B | 13.01 KiB | ±2.0% |
| 主线程身份写透 SQLite 并等待回执<br><code>main-write-through-acked</code> | 42,175 次/s | 3.04 ms | 56.55 MiB | 23.15 KiB | ±3.8% |
| SQLite 查询（复用热连接）<br><code>storage-read-hot-connection</code> | 395,304 次/s | 20.24 µs | 5.30 MiB | 19.09 KiB | ±1.2% |
| SQLite 查询（每批新建连接）<br><code>storage-read-cold-connection</code> | 10,655 次/s | 750.9 µs | 34.02 MiB | 203.99 KiB | ±0.4% |
| SQLite 事务写入（复用热连接）<br><code>storage-write-hot-connection</code> | 65,812 次/s | 1.95 ms | 73.15 MiB | 129.33 KiB | ±2.8% |
| SQLite 事务写入（每批新建连接）<br><code>storage-write-cold-connection</code> | 19,530 次/s | 6.56 ms | 12.60 MiB | 420.92 KiB | ±1.8% |

## 容器与算法

> 生产选用的容器与算法：普通配额窗口与有界反刷群入群窗口均使用 `TimestampDeque`，AI 滚动记忆缓冲用 `BoundedDeque`；这里单独量容器本身的成本。

| 容器 | 典型单次耗时 | 每秒调用 | 峰值 RSS | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- | --- |
| 有配额上限的滑动时间窗口记账与过期淘汰<br><code>quota-timestamp-window</code> | 16.0 ns | 62,609,474 次/s | 99.98 MiB | 23.00 KiB | ±6.9% |
| 有界入群滑窗的饱和记账与过期淘汰<br><code>join-timestamp-window</code> | 32.6 ns | 31,251,582 次/s | 92.31 MiB | 27.55 KiB | ±12.8% |
| AI 有界滚动记忆追加与淘汰<br><code>bounded-rolling-buffer</code> | 19.6 ns | 51,123,908 次/s | 100.89 MiB | 28.20 KiB | ±6.0% |

## 入群日志 · 25 万容量线

> 25 万条满库入群日志上跑当前实现的快照与容量裁剪。

| 操作 | 耗时 | GC 前分配 | GC 后留存 | 波动 |
| --- | --- | --- | --- | --- |
| 复制 25 万条入群日志快照<br><code>snapshot</code> | 96.22 ms | 4.20 MiB | 5.36 KiB | ±0.8% |
| 把 25 万条入群日志裁剪到容量上限<br><code>capacity</code> | 3.64 ms | 0 B | -4.76 KiB | ±1.2% |

> 复现：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 上一页：10 Mini App 设置与推荐配置](10-mini-app.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#11-性能基准) · [下一页：12 常见问题 →](12-faq.md)

</div>
