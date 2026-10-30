# 07 运维与排障

<p align="center">
  <b>简体中文</b> · <a href="../en/07-operations.md">English</a> · <a href="../ja/07-operations.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="06-modification-guide.md">← 上一页：06 修改配方</a> · <a href="08-images-and-cron.md">下一页：08 图库与定时任务 →</a>
</p>

---

## 部署形态

Copy Ninjia 采用**单实例长轮询（Long Polling）**常驻架构：
- 无需公网反向代理或 Webhook 端口；
- 不依赖外部 MySQL/PostgreSQL 等数据库服务；
- 身份权限策略与群运行状态全部存储在本地 SQLite 数据库中；
- 其它持久化数据统一以 JSON/文本形式落在本地数据根目录。

### 硬件参考

<table width="100%">
<thead>
  <tr>
    <th width="24%" align="left">部署规模</th>
    <th width="32%" align="left">建议配置</th>
    <th width="44%" align="left">说明与资源规划建议</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>🌱 <b>入门规格</b></nobr><br><sub>（低活跃 / 纯文本）</sub></td>
    <td>2 vCPU / 2 GB RAM / 本地 SSD</td>
    <td>能够正常运行。但在多媒体并发分析高峰期，各 Worker 线程可能会争用 CPU；强烈建议配置 2 GB Swap 分区。</td>
  </tr>
  <tr>
    <td><nobr>⚡ <b>轻量生产</b></nobr><br><sub>（少量群开启 AI）</sub></td>
    <td>4 vCPU / 2 GB RAM / 本地 SSD</td>
    <td>纯文本处理非常稳定。但 2 GB 内存较紧张，不建议承受高并发富媒体请求，建议配备 2 GB Swap。</td>
  </tr>
  <tr>
    <td><nobr>🌟 <b>推荐生产</b></nobr><br><sub>（中等规模活跃群）</sub></td>
    <td>4 vCPU / 4 GB RAM / 本地 SSD</td>
    <td>单群日均消息量中等的标准生产规模，兼顾系统稳定性与硬件成本（建议配备 2 GB Swap）。</td>
  </tr>
  <tr>
    <td><nobr>🔥 <b>高负载生产</b></nobr><br><sub>（全群 AI / 图片多）</sub></td>
    <td>4 vCPU / 8 GB RAM / 本地 SSD</td>
    <td>为高并发媒体下载、Base64 编解码与图片转码预留充足的堆内存峰值缓冲空间。</td>
  </tr>
</tbody>
</table>

> [!NOTE]
> 单实例可同时托管的群组上限为 `STATE_MANAGED_CHAT_LIMIT`。主要资源瓶颈来自 Telegram Bot API 请求频率限制、模型供应商的调用配额以及实际的消息/媒体吞吐速率，而不是群成员人数。

---

### systemd 示例

推荐通过 systemd 管理常驻服务：

```ini
[Unit]
Description=Copy Ninjia Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=copy-ninjia
Group=copy-ninjia
WorkingDirectory=/opt/copy_ninjia
Environment=COPY_NINJIA_DATA_ROOT=/var/lib/copy-ninjia
ExecStart=/usr/local/bin/bun run start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

#### 目录权限与安全控制

- **预先创建数据根目录**：部署时建议先建立运行用户与专属数据根目录：
  ```bash
  sudo install -d -o copy-ninjia -g copy-ninjia -m 0750 /var/lib/copy-ninjia
  ```
  在 Docker 等容器中部署时，需将数据根作为持久化 Volume 挂载，由宿主机或 init container 设置属主；注意 `memory/` 与 `database/` 切勿放在容器可写但易失的临时分层中。
- **自动初始化与严格写保护**：服务启动时会自动补齐数据根、`logs/`、`memory/`、`memory/global/` 与初始的 `database/` 目录（前四者权限上限为 `RUNTIME_DATA_ROOT_MAX_MODE`，`database/` 为 `IDENTITY_DATABASE_DIRECTORY_MODE`，实际生效值受 umask 限制），且所有路径**严禁使用符号链接**。
  - 数据根、`logs/`、`memory/` 与 `memory/global/` 必须归属于当前运行用户的 UID，且权限不能比 `RUNTIME_DATA_ROOT_MAX_MODE` 更宽松。一旦检测到所属组（group）或其它人（other）拥有写入权限（`w` 位），程序将**立即拒绝启动**。

> [!WARNING]
> **多租户环境的数据权限隔离**：
> `memory/` 目录下新建文件的默认权限是 `0644`。如果上层目录开放了其他本地用户的读取权限，同一台机器上的其他本地用户将能够直接读取群聊数据。在多用户共享的服务器上，建议将数据根与 `memory/` 权限收紧为 `0750`，已有文件收紧为 `0600` 或 `0640`（程序运行时会保留已有文件的权限，不会静默修改）。
> `database/` 目录权限上限为 `IDENTITY_DATABASE_DIRECTORY_MODE`（含 setgid 位时为 `02770`），主数据库及 WAL/SHM 临时文件创建权限为 `IDENTITY_DATABASE_FILE_MODE`。**切勿对整个数据根执行递归 `chmod 0750`**，因为 `database/` 必须保留属组写入权限。`config/` 属于只读输入，保持普通只读即可。

- **崩溃自愈机制**：如果进程意外崩溃或以非零码退出，systemd 的 `Restart=on-failure` 会自动拉起实例。尚未完成的入群验证状态、锁定计时器、身份写入、AI 上下文记忆以及未确认的 Telegram update 将按照 [04 运行时权威约束](04-invariants.md#持久化) 的规则无缝恢复。

---

### 二进制部署

官方预编译的二进制发行包解压后包含 `copy-ninjia` 可执行文件、`binary.json`、`package.json`、一键安装器、离线冷迁移脚本、配置与 Prompt 模板以及数据库迁移 SQL，无需 `node_modules/`（所有代码与运行时均已静态编译为单文件）。
- **初始化配置**：在发行包目录执行 `bash install.sh`，根据交互引导即可完成配置生成与新数据库初始化；前台调试测试可直接执行 `./copy-ninjia`。
- **配置 systemd**：将 `WorkingDirectory` 设为发行包解压目录，`ExecStart` 直接填写可执行文件的绝对路径（无需 `start` 参数）；目标服务器甚至不需要安装系统级的 Bun。
- **版本更新方式**：一键安装器只负责在新目录中下载 Latest 版本的完整包与哈希，不会直接覆盖现有在线生产目录。更新必须遵循停机、外部备份、校验、冷迁移的流程：先在独立临时目录校验新包无误后，保留既有配置文件与数据根，再替换程序文件；原有目录内残留的 `node_modules/` 不会被加载，可以在停机后安全移除。
- **运行冷迁移脚本**：发行包内置的离线迁移脚本位于 `scripts/migrations/`，可通过 `BUN_BE_BUN=1 ./copy-ninjia scripts/migrations/<脚本名>.js --help` 查看具体用法。启动入口只接受最新数据格式，不会在运行时自动升级旧格式。
- 更多构建与打包细节请参阅 [05 开发流程](05-dev-workflow.md#发布)。

---

## 数据根

所有运行时生成的数据路径均由环境变量 `COPY_NINJIA_DATA_ROOT` 派生（若未显式指定，默认采用当前项目根目录；如果显式传入空字符串或全空格，程序将直接拒绝启动）：

### 日历时区

时区在 `config/static/bot.json` 的 `time_zone` 字段中配置（启动时生效，缺省为 `DEFAULT_BOT_TIME_ZONE`），运行期间不会动态更新。定时任务可在 `cron.json` 中配置独立的 `time_zone` 覆盖全局设定。

**时区与数据根强绑定**：首次建库时，数据库 `database/storage.sqlite` 的 `storage_metadata` 表中会持久化记录 `time-zone` 标记。此后，日报文件按自然日划分的切分点、运势回执签名密钥、临时广告免检计数以及入群日志周期，均严格按此绑定时区计算。
若启动时发现 `bot.json` 中的 `time_zone` 与数据库中的记录不一致，程序将直接终止启动，并在日志中明确打印 `storage_metadata.time-zone` 与期望值。安装器注册服务前也会做同样的检查。已有数据根不支持动态更改时区；若需启动，必须把 `time_zone` 改回库中记录的值。`database/` 与 `memory/` 必须来自同一个时间点的备份，备份与恢复必须整体处理。

### 1. 全局状态：`memory/global/state.json`
- **功能职责**：持久化全局复读配置 `copy`（复读目标用户、模式、发起群与冷却时间）以及全局语音配额窗口 `ttsUsage`（当前窗口起始时间 `windowStartedAt`、AI 生成计数 `agentCount` 与中转预留计数 `reserveCount`）。
- **格式约束**：顶层仅允许必填的 `copy` 字段与可选的 `ttsUsage` 字段。`copy.copiedUser` 必填（无复读目标时为 `null`），`copy.copyMode` 仅支持缺省、`reverse`、`nya`；若存在 `ttsUsage`，其三个子字段均为必填且非负，且至少有一项大于 0。若文件不存在，程序视作“全新初始状态”；若文件存在但格式非法，或出现了未知键，将**立即拒绝启动**。安装器在读取配置时也会以相同严格度校验该文件。
- **写入机制**：由主线程独占写入（采用“写入临时文件 + fsync 刷盘 + 原子 rename 覆盖”机制），Disk I/O Worker 不介入此目录。`copy` 变更会立即同步刷盘；`ttsUsage` 则通过 `STATE_BACKGROUND_SAVE_DELAY_MS` 聚合合并后在后台定时刷盘。正常停机时会触发优雅 Flush 提交所有变更；若遭遇断电或被 `kill -9` 强杀，可能丢失未及合并窗口落盘的少量计数。
- **手工编辑**：若需手动调整，必须先停止服务并确认进程完全退出，在项目目录外通过 `mktemp -d` 完整备份文件及元数据后再进行修改。严禁删除未知字段，核验 JSON 格式符合 Schema 后方可启动。
- **根目录遗留检查**：如果数据根顶层存在遗留的旧版 `state.json` 或 `state.json.bak`，服务启动与安装器都会拒绝运行。请先参考[旧版本分阶段升级](#staged-upgrade)升级至 17.2.1 并完成其迁移，再把这些旧文件移出数据根。
- **Mini App 验证器：`memory/mini-app-totp/totp.json`**（可选）：当超级管理员在 Mini App「验证器」页面绑定唯一 Google Authenticator (TOTP) 时，由主线程以原子写（临时文件 + `fsync` + `rename`，权限 `0o600`）持久化 `{ version: 1, secret, createdAt }`；启动组合点一次性读入并严格校验后常驻主线程内存缓存，安装预检按同一口径只读校验（文件缺失视作未绑定，非普通文件或格式非法时拒绝启动与安装），运行期间鉴权与查询零磁盘 I/O，仅在新增、修改或删除验证器时立即同步落盘。

### 2. 色图专用图库：`random_h_image_dir`
- **功能职责**：路径由 `config/dynamic/assets.json` 中的 `onlyPath.random_h_image_dir` 指定（缺省为相对数据根目录的 `RANDOM_H_IMAGE_DIR`）。`/h_image` 命令与未指定目录的定时随机发图均从此目录中均匀随机抽选，管理员可通过 `/h_image add` 命令上传收录。
- **命名规范**：文件名必须严格等于**图片二进制内容的 SHA-256 哈希**（匹配 `RANDOM_IMAGE_CONTENT_NAME_PATTERN`），扩展名仅支持 `RANDOM_IMAGE_EXTENSIONS`。严禁在此目录存放任何非色图文件或说明文档。
- **启动检查**：若目录不存在，启动时会自动创建；启动阶段会逐项扫描该目录，一旦发现非法文件名、子目录、软链接或异常残留的 `RANDOM_IMAGE_TEMP_PREFIX` 前缀临时文件，程序将**直接拒绝启动**。往该目录手动增删合规图片无需重启服务，即时生效；若在运行期间动态修改配置路径，程序会以同等规则严格校验新目录，若存在非法文件则拒绝切换。

### 3. 群友老婆候选库：`memory/wed/<chatId>.json`
- **功能职责**：每群一份已发言成员滑窗，文件是按进入顺序排列的对象数组（如 `[{"id":5974478892,"enteredAt":1791770134683}]`），`enteredAt` 为成员进入滑窗时的 Unix 毫秒时间戳；主线程为每个活跃群维护一个复用的 `Map<number, number>`（成员 ID → 进入时间）。系统管理的群数量上限为 `STATE_MANAGED_CHAT_LIMIT`，单群滑窗容量为 `WED_MEMBER_LIMIT`。
- **滑窗规则**：不在窗口内的成员以个人身份发言时，以当前时间追加到末尾（不早于窗口已记录的最大进入时间）；窗口内成员再次发言不刷新进入时间；满额时先挤出进入时间最早的成员。
- **校验规则**：文件名必须是以负安全整数格式命名的群组 ID；每项必须恰好包含 `id` 与 `enteredAt`，`id` 为不重复的正安全整数，`enteredAt` 为非负安全整数且按数组顺序不减，项数不超过 `WED_MEMBER_LIMIT`。任何不合规都会在启动时报错拒绝，安装器以同一口径校验；仍是成员 ID 数组的旧文件须先执行 [/wed 成员滑窗冷迁移](#upgrade-wed-member-window)。
- **落盘机制**：单群累计产生 `FLUSH_MAX_ENTRIES` 条增删或挤出变动，或自首条变动起已满 `FLUSH_INTERVAL_MS` 时，将变动提交给 Disk I/O Worker 进行全量原子替换落盘。在执行 `/init disable` 或机器人被移出群聊时，会自动彻底删除对应群的文件。
- **离群清理**：退群服务消息、`chat_member` 状态更新以及每日零点的成员巡检会自动清理已退群的用户（后两项需要机器人具备群管理员权限）。如果机器人没有管理员权限，在开启了“隐藏成员列表”的大群中可能无法感知成员离群，此时该成员仍可能保留在候选池中并被抽中，此属 Telegram API 权限限制下的正常现象。

### 4. 贴纸与运势：`memory/stickers/` 与 `memory/luck/`
- **`memory/stickers/<pack>.json`**：白名单贴纸包的索引描述缓存（包含格式版本 `version` 字段），记录贴纸的 `file_unique_id`、对应 emoji、提示描述以及整包摘要信息。若缺失可随时从 Telegram 重新同步对账；启动时会自动删除不在当前配置白名单中的贴纸包文件。
- **`memory/luck/<YYYY-MM-DD>.json`**：在绑定时区下当天已抽取的运势结果，以用户 ID 为键，包含运势等级及用户所求事项的摘要。每天只保留当天的记录。
- **`memory/luck/receipt-secret.json`**：用于校验当天运势回执真实性的 HMAC 密钥（包含格式版本 `version` 字段、所属日期与匹配 `LUCK_RECEIPT_SECRET_PATTERN` 的十六进制随机密钥）。**此文件必须与当天的运势文件作为整体一同备份与恢复**，严禁单方面删除或重新生成，否则会导致之前发放的运势回执全部失效。

### 5. 待验证与入群日志：`memory/anti-raid/` 与 `memory/joinlog/`
- **`memory/anti-raid/<YYYY-MM-DD>.json`**：当天入群验证挑战（Challenge）的状态日志，记录活跃状态、修订版本（revision）、已解决的墓碑记录（tombstone），以及写入但尚未确认执行完毕的剔除任务 `kickPending`（服务重启后会自动继续执行未完成的剔除操作）。稳定状态下只保留当天数据，追加日志条数或体积达到 `VERIFICATION_FILE_COMPACT_ENTRIES` 或 `VERIFICATION_FILE_COMPACT_BYTES` 门限时会自动触发整理压缩。整理时目录里若还留着更早的日文件，会为其中最新一份里仍为活跃、当前已终结的记录写入墓碑，旧日文件删除前进程退出也不会让已终结的记录在恢复时复活。同一份最新旧日文件连续 `VERIFICATION_PRIOR_DAY_DECODE_MAX_ATTEMPTS` 次解码失败（不是合法 UTF-8 或不是当前格式）时，运行中的整理把它改名为 `<YYYY-MM-DD>.json.corrupt` 原样保留供人工排查，新的一天直接按内存镜像写入；改名后的文件不再以 `.json` 结尾，启动恢复与旧日清理都不读也不删它。启动时最新旧日文件损坏仍拒绝启动。
- **`memory/joinlog/<chatId>.<YYYY-MM-DD>.json`**：每个群精确记录的 `chat_member` 入群事件流水，供管理员执行 `/batch_kick` 时根据滑动时间窗口准确追踪新成员。
  - **写入机制**：事件先进入 Disk I/O Worker 内存批次，当累计满 `FLUSH_MAX_ENTRIES` 条或满 `FLUSH_INTERVAL_MS` 时，批量追加落盘并调用 fsync。在执行 `/batch_kick` 查询前以及服务正常停机时，会强制刷出所有未落盘的批次。
  - **生命周期**：根据配置时区保留最近 `JOIN_LOG_FILE_RETENTION_DAYS` 天的数据，确保覆盖跨天查询窗口；夏令时短日会自动延长保留天数。单群单日最多保留最新入群的 `JOIN_LOG_MAX_USERS_PER_CHAT_DAY` 人。在执行 `/init disable` 或机器人离群后，对应群的入群日志将被彻底清除。

### 6. 核心身份与群状态：`database/storage.sqlite`
运行时目录下通常还会伴随有 SQLite 的 WAL 临时文件（`-wal`）与共享内存文件（`-shm`）：
- **存储内容**：遵循当前 Schema 版本（`IDENTITY_DATABASE_SCHEMA_VERSION`）的集中式 SQLite 数据库。
  - `storage_metadata`：元数据表，固定包含 `schema-version` 与 `time-zone`（数据根绑定的配置时区）两行。
  - `permission_list.policy`：持久化的用户权限规则，以严格 JSONB 格式存储。
  - `blocklist_entries`：权威的全局封禁黑名单。
  - `temporary_ad_bypass_entries`：临时广告免检累计额度记录。
  - `pending_blocked_removals`：未执行完成的跨群剔除封禁任务排队列表。
  - `chat_qa`：群自定义问答库，主键为 `(chat_id, q)` 联合主键。
  - `chat_states`：托管群的运行状态表（最多 `STATE_MANAGED_CHAT_LIMIT` 行）。包含必填的状态字段 JSONB（`status`，其中包含翻译会话列表 `translate`，单群上限 `TRANSLATE_CHAT_USER_LIMIT`）以及可选的 `ai_context`（可空 JSONB 快照，包含会话记忆明细与中期摘要）。
- **独占与事务**：Disk I/O Worker 独占该数据库的读写连接。服务启动时会对其进行全方位的严格校验（包括 SQLite integrity 完整性检查、JSONB 格式解析、Schema 版本校验、迁移谱系检查、编解码器验证及互斥冲突检查）。群组状态与 AI 快照均从此连接恢复。
- **停机关库**：服务干净停机时，Disk I/O Worker 提交残余写、把 WAL 合回主库并截断后关闭连接，正常情况下停机后 `database/` 只剩 `storage.sqlite`。进程被强杀，或 checkpoint 被其它读连接（如外部打开的 SQLite 编辑器）挡住时，`-wal`、`-shm` 会留在目录里。关库时无法确认残余写已提交，停机按 `unsettled` 以非零状态退出，journal 里会有对应的 `[diskIO]` 错误。
- **备份规范**：包含敏感数据与核心权限。备份时**必须把主数据库文件与同一时刻的 `-wal`、`-shm` 文件（存在时）作为一个不可分割的整体一同备份与恢复**，绝不能只拷贝单独的 `.sqlite` 文件。

### 7. 广告样本与 AI 用量：`memory/ad-detected/` 与 `memory/ai-daily-usage/`
- **`memory/ad-detected/sample.json`**：被广告拦截引擎命中的原始消息样本（包括触发时间、消息原文、命中原因及上下文）。此数据纯属旁路分析审计用途；当文件大小达到 `AD_SAMPLE_FILE_MAX_BYTES` 时会自动归档切分为 `sample.<日期>[.<序号>].json`，历史归档按 `AD_SAMPLE_ARCHIVE_RETENTION_DAYS` 保留指定天数后自动清理。
- **`memory/ai-daily-usage/usage.json`**：AI 模型调用的 Token 与请求量统计（不含任何用户对话正文）。
  - **数据结构**：最顶部的 `summary` 对象保存最近一个已结束自然日的用量汇总（按能力、供应商、模型名称分组归纳），其余键值为当天尚未汇总的实时逐条调用统计。
  - **覆盖能力范围**：全面覆盖 `AGENT_CAPABILITY_NAMES` 中定义的所有能力维度。

### 8. 日志与实例锁：`logs/` 与 `bot.lock`
- **`logs/`**：英文结构化错误日志目录，由 Disk I/O Worker 负责批量异步写入。
- **`bot.lock`**（及附属的 `.guard` / `.recovery`）：基于 Linux `/proc` 文件系统的单实例互斥锁，确保同一个数据根在同一时间绝对只有一个活跃进程在运行。

---

### 数据根管理与维护调度

- **目录职责物理隔离**：`memory/` 根目录下不直接存放任何孤立文件，每个业务领域各自独占一个子目录；身份策略与群状态统一交由 `database/` 维护。
- **启动严格预检流水线**：服务启动时先以完全只读的方式扫描并严格校验所有持久化文件（包括 `joinlog/` 窗口内的每一个文件）。只有当所有子领域的数据全部解码校验通过后，主线程才会将内存所有权移交给各个功能模块。随后按需补全缺失目录、清理遗留的临时孤儿文件，并根据 `bot.json` 的 `time_zone` 注册每日零点定时清理任务。
- **配置时区零点维护 Cron**：每天在配置时区的 00:00，按序执行以下清理任务：`/wed` 成员有效性复核、运势归档切分、日志轮转、AI Token 用量汇总、入群日志过期轮转、广告样本归档清理、入群验证 Challenge 日志合并压缩、临时广告免检额度衰减。单个维护任务发生异常不会中断其他任务的执行。
- **临时文件与纯内存状态**：
  - 原子写入过程中生成的 `.<目标文件名>.<pid>.<uuid>.tmp` 临时文件在正常情况下会自动重命名或清理；如果进程被强杀，可能会遗留在磁盘上。启动检查流程对这些临时文件仅记录不删除，待各功能模块正常接管后，由后台维护任务安全回收。
  - `storage.sqlite-wal` 与 `storage.sqlite-shm` 是 SQLite 处于 WAL 模式时的必需核心文件，**绝对不能当成临时垃圾文件手动删除**。
  - 用户的入群挑战倒计时器、广告检测待定判定队列、Telegram 短期缓存均属于纯内存临时状态，重启后不落盘。

---

## 持久化数据迁移

系统在运行时**绝不保留历史旧格式的兼容逻辑，启动时也不会自动变更或升级表结构**。所有数据结构的升级都必须在服务完全停止、进程完全退出后进行。如果迁移失败，必须保留外部备份现场，严禁强行启动新版，也严禁用示例模板 `config_example/` 覆盖现有真实配置。

每次执行停机冷迁移前，必须在项目代码树外部使用 `mktemp -d` 创建安全备份目录，备份所有受影响的文件，并记录核对清单、属主账号、权限模式及 SHA-256 哈希值；迁移脚本生成产物后，必须核验 `ready.json` 中的源文件哈希与产物哈希一致。迁移后的新数据必须能通过当前版本启动时的严格格式校验。确认无误后替换旧文件，并恢复正确的文件属主与权限。新服务启动后，至少观察两个 supervisor 重启周期，确认状态为 `active (running)`、`NRestarts` 计数不增加、systemd journal 中没有异常报错，全部验证通过后方可清理外部备份。

### 全新部署建空库

服务启动时如果发现数据库文件缺失，不会私自猜测建库，而是直接报错。全新部署必须按照 [01 环境搭建的初始化身份数据库步骤](01-getting-started.md#初始化身份数据库) 创建符合当前 Schema 的空数据库；运行 `install.sh` 脚本在未发现数据库时也会自动执行该步骤。如果数据库已存在，该建库脚本会自动拒绝覆盖。

<a id="upgrade-wed-member-window"></a>

### /wed 成员滑窗冷迁移（成员 ID 数组 → `{ id, enteredAt }`）

迁移入口脚本为 [`scripts/migrateWedMemberWindow.ts`](../../scripts/migrateWedMemberWindow.ts)。该脚本把 `memory/wed/<chatId>.json` 从 17.2.1 的成员 ID 数组改写为按进入顺序排列的 `{ id, enteredAt }` 滑窗数组：每群只保留数组末尾（最近进入）的 `WED_MEMBER_LIMIT` 个 ID，顺序不变，`enteredAt` 统一记为迁移开始时刻；超出部分从最早一端丢弃，丢弃数记入 `ready.json` 的 `truncatedMembers`。本脚本仅接收 17.2.1 格式的成员文件（每份至多 `WED_MEMBER_WINDOW_SOURCE_LIMIT` 个不重复的正安全整数 ID，群文件数不超过 `STATE_MANAGED_CHAT_LIMIT`）；已经迁移过的文件、非规范文件名与符号链接一律拒绝，`*.tmp` 等非 `.json` 残留不参与迁移。17.2.1 版本的其他持久化文件和 JSON 配置格式保持不变，可直接沿用。

1. **停机与备份**：停止服务并确认状态为 inactive；按照规范将整个 `memory/wed/` 目录连同属主、权限与 SHA-256 清单备份到外部安全目录，备份根下保持 `memory/wed/` 相对路径。
2. **执行迁移脚本**：
   ```bash
   bun run migrate:wed-member-window \
     --source-root /absolute/cold-backup \
     --output-root /absolute/new-staging-directory
   ```
   二进制发行包使用 `BUN_BE_BUN=1 ./copy-ninjia scripts/migrations/migrateWedMemberWindow.js`，参数相同。
3. **核对迁移产物**：检查产物目录下的 `ready.json`，核对 `sourceFiles` 与 `outputFiles` 的 SHA-256 哈希值，并确认 `chatCount`、`keptMembers`、`truncatedMembers` 与 `enteredAt` 符合预期。产物文件仅当前账号可读写。
4. **替换成员文件**：停机状态下用产物中的 `memory/wed/<chatId>.json` 逐个替换部署文件，按 `sourceFiles` 恢复原属主与权限，确保服务账号可写 `memory/wed/` 及其中文件。
5. **启动验证**：启动服务并观察，确认无异常退出后清理临时备份。

---

<a id="staged-upgrade"></a>

### 从旧版本分阶段升级流程

- **针对落后于 17.2.1 的老旧版本**：当前版本仅提供从 17.2.1 升级的直达迁移脚本。若旧版本低于 17.2.1，必须先升级并安装 17.2.1，按照该版本的文档完成其迁移（16.3.2 需执行共享数据库冷迁移 `migrate:chat-persona-removal`，更早版本先按该版本指引升级至 16.3.2），确认 17.2.1 能正常稳定启动后，再执行本版的[/wed 成员滑窗冷迁移](#upgrade-wed-member-window)。
- **11.0.9（Schema v8）跨大版本升级路径**：
  需要在独立目录中切出对应的历史 Git 标签，分步运行历史冷迁移链路：
  1. 切换至 `500e848fae` 提交：执行 `migrate:ai-context`（v8 → v9）
  2. 切换至 `12.1.0` 标签：执行 `migrate:clear-context-permission`（v9 → v10）
  3. 切换至 `13.0.2` 标签：执行 `migrate:h-image-add-permission`（v10 → v11）与 `migrate:bot-config`
  4. 切换至 `14.0.0` 标签：执行 `migrate:translate-sessions`
  5. 切换至 `16.3.2` 标签：根据该版本指引执行 `migrate:global-state` 与 `migrate:random-image-names`
  6. 切换至 `17.2.1` 标签：执行 `migrate:chat-persona-removal`（v11 → v13）
  7. 切回当前最新版本：执行 `migrate:wed-member-window`

  *提示*：也可直接使用 12.0.0 Release 附带的中间源码归档包 `copy-ninjia-schema-v9-source-500e848f.tar.gz`（SHA-256: `df6502625512d8fde136dc66d8470e1d4c977856e8a0bd3909b9b6c763c820f8`）。

---

## 启动失败排查

程序在启动时若检测到任何配置或数据异常，均会**主动快速失败（Fail-Fast）**终止进程，日志中会清晰输出失败的具体原因与出错的字段路径。请根据错误提示精确定位，切勿强行绕过检查：

### 1. 数据根预检失败
- **原因**：数据根、`memory/`、`memory/global/`、`logs/` 或 `database/` 中包含软链接；相关目录的属主不是当前运行进程的 UID，或者目录权限过于宽松（包含了 group 或 other 的写权限，超过 `RUNTIME_DATA_ROOT_MAX_MODE`）；`database/` 权限比 `IDENTITY_DATABASE_DIRECTORY_MODE` 更宽，或者运行用户对该目录缺乏所属组写入权限；底层挂载的文件系统不支持 fsync、硬链接（hard link）或原子 rename。
- **解决方法**：停止服务，修正各目录的属主账号与权限模式。将数据根、`memory/`、`memory/global/`、`logs/` 收紧为 `0750`（不超过 `RUNTIME_DATA_ROOT_MAX_MODE`），`database/` 设置为 `0750` 或 `02770`（不超过 `IDENTITY_DATABASE_DIRECTORY_MODE`）。确保数据根位于标准本地 POSIX 文件系统上，避免使用不支持标准文件锁的特定网络文件系统。

### 2. `bot.lock` 拒绝启动
- **原因**：检测到已有另一个活跃的进程实例正在使用当前数据根（即使使用不同 Token 也不允许并发占用），或者锁文件损坏、为旧版本遗留格式。
- **解决方法**：详细排查步骤请参考下一小节 [`bot.lock` 拒绝启动](#botlock-拒绝启动)。

### 3. 配置目录布局不符
- **原因**：配置文件被直接散落在 `config/` 根目录而未按规范放入子目录；`config/` 根目录下残留了旧版的 `telegram.json`；或者 `config/dynamic/` 目录缺失。
- **解决方法**：停机后，将 `bot.json` 和 `g-auth.json` 移入 `config/static/`，将其余动态配置文件移入 `config/dynamic/`；若存在旧的 `telegram.json`，请先参考[旧版本分阶段升级](#staged-upgrade)运行 `migrate:bot-config` 完成升级。

### 4. Config Schema 校验失败
- **原因**：`config/{static,dynamic}/*.json` 中的某些配置内容不符合规范（例如必填项缺失、字段类型错误、枚举值非法或配置了未定义的未知键）。
- **解决方法**：直接查看控制台打印的 JSON 错误路径定位具体字段并修改；字段详细约束请参阅[部署配置说明](../../config_example/README/zh.md)。

### 5. 身份数据库校验失败
- **原因**：`storage.sqlite` 数据库不可写；数据库物理损坏；数据库 Schema 版本未完成迁移（非当前版本）；`time_zone` 配置与数据根中绑定的时区不匹配（错误会直接指出 `storage_metadata.time-zone` 与期望值）；或者黑名单与免检名单中存在相同的 ID 导致冲突。
- **解决方法**：若为时区不符，将 `bot.json` 中的 `time_zone` 改回库中记录的值；若数据库不是当前 schema（例如 16.3.2 的 v11 库），先按[旧版本分阶段升级](#staged-upgrade)升级至 17.2.1 并完成其迁移；若文件物理损坏，从备份中同时恢复主库与附带的 `-wal`、`-shm` 文件。严禁私自建空库覆盖或手动在数据库中删改数据。

### 6. 运势结果与回执密钥不一致
- **原因**：当天的运势文件与 `receipt-secret.json` 签名密钥并非来自同一时间点的备份，导致签名校验失效。
- **解决方法**：停止服务，从同一个备份时间点完整恢复整个 `memory/luck/` 目录，绝对不能单独删除或重新生成签名密钥。

### 7. 全局状态文件非法或残留旧 state.json
- **原因**：`memory/global/state.json` 的格式不符合当前版本的 Schema 定义，或者数据根顶层残留了旧版本的 `state.json` 文件。
- **解决方法**：备份后检查并修正非法字段；若是老旧格式，先按[旧版本分阶段升级](#staged-upgrade)升级至 17.2.1 并完成其迁移，再清理移出数据根顶层的旧文件。

### 8. /wed 候选库格式非法
- **原因**：`memory/wed/<chatId>.json` 不符合当前滑窗格式（例如仍是 17.2.1 的成员 ID 数组、缺少 `enteredAt`、进入时间倒序或项数超过 `WED_MEMBER_LIMIT`），或文件名不是规范群 ID。
- **解决方法**：停机备份后，成员 ID 数组形式的旧文件执行 [/wed 成员滑窗冷迁移](#upgrade-wed-member-window)；其余情况按报错给出的文件与字段路径修正，或从备份恢复。

---

### `bot.lock` 拒绝启动

系统采用基于 Linux `/proc` 文件系统的实例锁，锁内容格式为严格的 `v2:pid:starttime:boot_id:sha256(token)`（其中 `starttime` 从 `/proc/<pid>/stat` 的第 22 个字段读取）。该锁采用严格的 Fail-Closed 闭锁机制，确保单数据根绝不被并发写穿：

- **活跃冲突判定**：只有当系统检测到当前存在的进程 PID、启动时间戳（starttime）与系统的 boot ID 三者完全一致时，才会判定为“当前存在活跃进程”。此时说明已有另一个实例在运行，严禁并发启动，必须先停止旧实例。
- **异常退出的陈旧锁（Stale Lock）**：如果旧进程此前被 `kill -9` 强杀，或机器刚刚重启，残留的旧锁在下一次新实例启动或退出时会被自动识别并安全清理，不需要人工干预。
- **锁文件损坏或格式过旧**：锁文件内容必须恰好是一行当前格式的属主记录加换行；多行、格式不符或带多余内容时，取锁与停机释放都会拒绝并原样保留文件。程序不会猜测未知数据，也不会自动静默兼容旧版锁。在**百分之百确认当前机器上绝对没有相关运行进程**的前提下，可手动删除损坏的锁文件再启动。
- **退出时释放锁失败**：若正常停机时未能成功释放锁，进程会打印错误并以非零码退出。此时应检查 `/proc` 的挂载状态、目录写入权限以及是否存在残留的 `.guard` 文件。
- **临时候选文件回收**：原子硬链接加锁过程中产生的 `.candidate.*` 临时文件与 `.tmp` 文件，在启动流程确认其属主不活跃后，会自动清理回收。

> [!CAUTION]
> 锁文件中记录的 Token SHA-256 哈希仅用于校验锁持有者的凭据一致性，不能替代多租户的数据隔离。如果需要同时运行多个不同的机器人，**必须为每个机器人配置完全独立的 `COPY_NINJIA_DATA_ROOT` 数据根目录**。

---

## 升级发布

1. **全套门禁自检**：在源码工作树上运行完整的发行前检验流水线（包含依赖冻结安装、代码风格、类型检查、测试覆盖率、故障注入与二进制编译）：
   ```bash
   bun run release:check -- --version <tag>
   # 在具备联网环境的主机上补充执行安全审计
   bun run audit:release
   ```
2. **Git 干净状态核验**：执行任何 Git 操作前，检查 `git status --short`、版本 diff 以及受保护文件 `git ls-files config .env g-auth.json`。严禁直接用仓库示例模板覆盖现场配置。
3. **独立工作目录中作业**：如果 systemd 配置的 `WorkingDirectory` 正好就是当前代码仓库，强烈建议在独立的 git worktree 或全新 clone 的临时目录中进行构建测试，并且必须遵循仅使用 `dev` 和 `master` 分支的开发规范。若确实只能原地升级，**必须先停止 systemd 服务并确认状态为 inactive**，在外部备份好部署配置和数据库后，方可拉取代码并执行迁移。
4. **处理持久化变更**：若本次更新包含持久化数据格式变更，严格执行停机冷迁移步骤。
5. **发布上线观察**：配置文件与持久化数据全部校验通过后方可启动新服务。启动后至少保持观察 2 个完整的 supervisor 重启周期，确认 `ActiveState=active`、`SubState=running`，`NRestarts` 相对启动基线不再增加，且 systemd 日志中没有异常退出记录。全部验证通过后方可清理外部备份。

### 安装器的服务与备份边界

安装脚本 `install.sh` 内置了严格的安全防护屏障：
- **运行状态检查**：安装器在尝试对现有目录进行任何写操作前，会强制要求既有 systemd 服务处于 `inactive`（或 `dead`）状态。若服务仍在运行，或服务单元中配置了多条冲突的 `ExecStart`，脚本会立即拒绝执行。
- **外部安全备份**：在覆盖或更新配置文件与 systemd unit 之前，安装器会在代码树外创建临时备份目录，记录文件清单并逐个校验 SHA-256 哈希、文件属主与权限。备份仅在启动后服务稳定性观察全部通过后才会自动清理；若任何一步校验未通过或选择在前台运行，备份与现场都会被完整保留。
- **环境变量一致性**：若未设置 `COPY_NINJIA_DATA_ROOT`，默认解析为当前项目根目录；若显式设置，则要求现有 systemd unit 中的 `Environment` 与当前安装环境变量解析到同一个绝对路径。配置了非空的 `EnvironmentFiles`，或在 unit 中包含影响该变量的 `PassEnvironment` / `UnsetEnvironment`，均会被直接拦截拒绝。
- **健康观察倒计时**：服务启动后，安装器会按 `service_observation_seconds`（综合 `RestartUSec`、`RestartMaxDelayUSec` 与 `RestartRandomizedDelayUSec` 计算两倍有效重启等待时长再加 2 秒）自动观察。在此期间，如果 `NRestarts` 相对启动基线发生增长、进程意外终止、日志不可读或出现非零退出，安装器均会直接判定安装失败并提示回滚。

---

## 日常观察点

### 关键日志特征与排查

- **统一结构化日志**：位于 `logs/` 目录下，由 Disk I/O Worker 异步批量落盘，全英文输出，方便使用 `grep` 或日志采集器统一检索。
- **Worker 线程崩溃自愈**：当某个 Worker 线程意外崩溃退出时，主线程会进行节流防抖并自动拉起新线程，随后从主线程内部的缓存快照中重新初始化 Worker 状态。
- **存储失败主动快速退出**：当底层磁盘写入遭遇持久化失败且有限次重试全部耗尽时，进程会主动以非零码退出，触发 systemd 重启恢复，防止内存数据与磁盘发生不可逆的分裂。

#### 常见日志提示

- `Cron task "<name>" action #<n> (<type>) failed after <k> attempt(s)`：
  定时任务执行到了最终失败状态。常见排查方向：
  - `403`：机器人已被移出目标频道或群组。
  - `400`：引用的外部媒体 URL 无效，或者图片/音频格式不被 Telegram 支持。
  - `local file ... is missing`：定时任务指定的本地素材文件不存在。
  - `speech synthesis failed: ...`：语音合成生成失败（若提示 `tts unconfigured` 或 `tts unsupported` 说明配置不匹配；`worker unavailable` 表示 AI Worker 尚未完成初始化；`synthesis failed` 或 `timed out` 通常为模型服务商端网络或接口抖动；`daily limit reached` 表示当前配额窗口的额度已耗尽）。
- `/send TTS for chat <id> produced no voice: <原因>`：
  超级管理员在私聊中使用 `/send` 中转消息时的语音合成失败，原因同上。管理员私聊窗口中会同步收到错误提示，中转会话会保持打开状态。
- `AI reply voice was not sent (chat <id>): <原因>`：
  AI 在群聊回复时尝试调用 `send_voice` 工具生成语音失败（可能由于模型接口超时或每日配额超标）。该错误不会中断文本消息的正常发出。
- `Failed to probe chat membership ... PARTICIPANT_ID_INVALID`：
  黑名单成员巡检在探测群成员时遇到了已被 Telegram 官方注销的“已销号账号”（Deleted Account）。当同一个用户连续 `BLOCKLIST_PARTICIPANT_INVALID_LIMIT` 次巡检均返回该错误时，系统会自动将该注销 ID 从黑名单中永久移除。
- `Chat <id> was upgraded to supergroup <newId>; tearing down the old chat.`：
  受管普通群升级成了超级群，旧群 id 已按「群已不存在」收尾（数据清除、受管名额释放）。新超级群需要重新执行 `/init enable`，旧群设置不会自动搬迁。
- `Chat <id> was gone|departed in <n> lookups <ms>ms apart; tearing it down.`：
  启动时标题刷新连续多次确证某群已不存在（`gone`）或机器人已不是成员（`departed`），已自动收尾。`departed` 的群若还有未恢复的私密模式记录会继续保留，机器人回到群里并拿回限制成员权限后自动还原。
- `Chat <id> looked gone|departed at startup but lookup <n> disagreed; keeping it.`：
  首次查询像是不可达，但后续重查结论不一致（多为 Telegram 偶发错误），本次不收尾，下次启动重新确证。
- `Gemini context cache API ... create rejected (n/<max>): 400`：
  向 Gemini 创建上下文缓存请求时被接口返回 HTTP 400 拒绝。通常是因为当前上下文总 Token 数尚未达到官方要求的创建下限，或者请求参数不合法。系统在等待 `GEMINI_CONTEXT_CACHE_REJECTION_RETRY_AFTER_MS` 冷却时间后会尝试重试，累计达到 `GEMINI_CONTEXT_CACHE_MAX_REJECTIONS` 次失败后将不再为当前内容尝试建立缓存；在此期间，常规的对话回复不受影响，将以不带缓存的方式正常调用。

---

<div align="center">

[← 上一页：06 修改配方](06-modification-guide.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#07-运维与排障) · [下一页：08 图库与定时任务 →](08-images-and-cron.md)

</div>
