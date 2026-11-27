# 项目规则

- [协作与操作边界](#协作与操作边界)
- [数据、配置与迁移安全](#数据配置与迁移安全)
- [运行时、依赖与平台 API](#运行时依赖与平台-api)
- [Telegram 提示留存](#telegram-提示留存)
- [编码规范](#编码规范)
- [分支、验证、提交与发布](#分支验证提交与发布)

## 协作与操作边界

- **环境模型**：按单租户云原生人机协作环境处理。
- **改动范围**：只修改完成当前任务所需的仓库文件。
- **开发工作范围**：普通源码、测试、类型、脚本、依赖清单修改和只读检查均按开发工作处理。
- **开发工作禁令**：不得停、启或重启服务，不得调用 systemd/supervisor，不得创建或删除系统账号，不得修改属主或权限，不得迁移数据根，不得备份或搬运部署数据。
- **部署保护触发条件**：仅在以下情况执行部署保护流程——请求明确包含部署、发布、迁移或线上运维；操作会直接写入、覆盖、移动或删除真实部署数据/配置；或运行可能触发这些写路径的生产入口。已确认使用独立临时数据根的测试不属于部署写路径。
- **子 agent 核对**：主 agent 必须核对子 agent 的内容结论，不得直接使用。

## 数据、配置与迁移安全

### 部署数据与备份

- **部署方数据范围**：`config/`、`.env`、`g-auth.json` 和运行时状态均视为部署方数据；不得用 Git 历史、目标分支或 `config_example/` 代替部署备份。
- **修改前备份**：改动运行时状态或数据（`state.json`、`memory/`、`bot.lock` 等）、触发真实部署写路径，或改动可能被运行进程写入且无版本控制兜底的文件前，先 `cp` 备份或读入 scratchpad；核验完成后才能清理备份。
- **敏感信息红线**：敏感内容不得进入仓库、提交或输出正文。

### Git 变更与原地迁移

- **隔离发布优先**：用户明确要求原地部署或发布，且仓库是 systemd/supervisor 的 `WorkingDirectory` 时，优先在独立 clone/worktree 中合并、测试、打 tag 和发布。
- **原地更新停服**：原地更新前必须先停止服务并确认 `inactive`，禁止在服务可被 supervisor 拉起的状态下更新工作树；无权限时停止操作并说明。
- **Git 变更前检查**：执行 `pull`、`checkout`/`switch`、`merge`、`reset`、`rebase`、`clean` 前，必须检查 `git status --short`、`git diff --name-status <current>..<target>`、`git ls-files config .env g-auth.json`。
- **触发迁移条件**：部署路径发生新增、删除或重命名，`.gitignore` 发生变化，或文件从“受跟踪”变为“忽略”时，必须执行迁移流程。
- **外部备份**：迁移前用 `mktemp -d` 在工作树外备份部署文件，并记录文件清单、权限、属主和 SHA-256；备份复制因无法保留属主而返回非零时，必须逐文件核对哈希。
- **受跟踪转忽略**：完成外部备份后再执行变更，并在 Release 的 `Compatibility / Migration Notes` 中写明备份、恢复和权限步骤。
- **迁移恢复**：Git 操作后先恢复部署文件，再按新结构手工迁移。
- **配置补缺**：禁止用 `cp -r config_example config` 覆盖现有配置；补缺必须使用不覆盖语义或逐项确认，并核对哈希、预期差异、严格解析结果和权限。

### 目录权限与冷迁移

- **身份策略写入路径**：`/white`、`/permission`、`/block` 等改写持久化身份策略的命令经 Disk I/O Worker 事务写入 `database/storage.sqlite`。
- **运行时可写目录**：`database/storage.sqlite` 所在目录（含 WAL/SHM 旁路文件）以及原子改写的 `state.json`、`bot.lock`、`memory/` 各领域目录必须允许服务账号写入，`config/` 可保持只读。
- **格式变更无热兼容**：文件结构变化只做手工迁移，不在代码中保留旧格式兼容逻辑。生产运行时、应用启动入口和普通业务代码只接受当前格式，不执行热迁移，不得保留旧格式读取、自动升级或静默回写分支。
- **冷迁移脚本边界**：`scripts/` 中的冷迁移脚本按**迁移**计数，不按 Release 数量计数：
  - 每条边只覆盖「上一次迁移产出的格式 → 本次迁移产出的格式」的直接迁移及该迁移自身的中断续跑。
  - 同一份持久化数据被多次迁移时，只保留最近一次的边，连同旧边测试一并删除；不得累积更早格式或跨多次迁移的兼容链。
  - 落后于上一次迁移的部署必须先分阶段升级到那一次迁移的产出格式；未知谱系一律拒绝。

### 服务启动与发布验收

- **启动前置**：配置和状态全部就位后才能启动服务。
- **运行态确认**：启动后必须确认 `ActiveState=active`、`SubState=running`，观察至少两个 supervisor 重启间隔，确认 `NRestarts` 不增长且 journal 无新增非零退出。
- **备份清理时机**：只有哈希、迁移、配置校验和服务稳定性全部确认后才能删除外部备份；任一步失败时必须保留备份和现场并停止发布。

### 不为用户行为兜底 *重要*

- **适用范围**：同等适用于 `config/` 下的部署配置和 `state.json` 等运行时状态。
- **致命错误**：解析失败、必填项缺失、类型不符、取值越界、枚举非法、互斥项冲突一律在启动阶段拒绝启动并以非零码退出，不得猜测意图后继续运行。
- **可选字段**：声明为可选的字段缺省按「从没设过」处理，由默认值或启动补齐填上；缺省不得放宽对存在但非法的值的判定。
- **字符串空白**：字符串字段首尾空白按规范化 trim 处理；trim 后为空或形态不符仍按非法处理。
- **禁止兜底**：禁止用默认值回填、静默修复、丢弃非法条目、截断到边界值或降级运行掩盖致命错误。
- **校验时机**：在建立外部连接和对外提供服务之前完成全部校验。
- **错误输出**：仅输出文件路径、字段路径和期望形态；不得回显 token、密钥等敏感值。
- **同步维护**：新增或变更配置与状态字段时，同步更新校验逻辑。

## 运行时、依赖与平台 API

### Bun 运行时与原生 API

- **统一工具链**：只使用 Bun 运行 TypeScript、执行脚本、管理依赖和运行测试；仓库命令统一使用 `bun`、`bun run`、`bun test`、`bun install`，不得新增 `node`、`npm`、`npx`、`pnpm`、`yarn` 入口。
- **核对后再实现**：实现 Node.js 兼容操作前，必须检查当前 Bun 版本、已安装的 `@types/bun` 声明和 Bun 官方文档，逐项核对语义、错误、生命周期、原子性、背压、取消与平台限制。
- **优先 Bun 原生 API**：Bun 官方文档将原生 API 标为推荐、优化或更适合该操作且语义完整时，直接调用 Bun 原生 API，不得继续调用 Node.js 兼容接口，不得保留双实现、运行时探测、降级分支或等价包装。
- **文件 I/O 分工**：语义匹配的文件读取、写入、复制和删除使用 `Bun.file`、`Bun.write` 或 `BunFile`；同步文件 I/O、文件描述符级 `fsync`/`O_EXCL`/权限接管、hard link、`rename`、目录创建、目录遍历及其他 Bun 原生文件 API 未覆盖的操作，按当前 Bun 官方文档使用 `node:fs`。
- **性能取舍**：Bun 原生与 Node.js 兼容接口存在性能取舍时，按「性能、内存与 Bun/JSC JIT」在当前 Bun 和固定输入下实测；热路径只采用结果稳定高于噪声且语义一致的实现。
- **`node:` 兼容回退**：仅在 Bun 原生 API 未覆盖所需语义或 Bun 官方文档明确要求使用 Node.js 兼容模块时，使用 `node:` 接口并在 Bun 下验证；不得为兼容 Node.js 运行时牺牲 Bun 实现。
- **第三方依赖内部**：第三方依赖内部的 Node.js 兼容调用由依赖自身维护；项目代码不得复制或改写依赖内部实现。

### 依赖与 SDK 使用

- **版本核对**：实现功能前检查 `package.json`、锁文件、已安装版本的本地类型声明或源码以及官方文档，确认技术栈和精确版本。
- **SDK 查证**：OpenAI、Telegram/grammY 等 SDK 必须先查官方文档，不得凭记忆猜接口，不得引入无关或版本不匹配的实现。
- **直接调用**：库或平台 API 已完整覆盖所需职责、行为和生命周期时直接调用，不得复制、重写或包装等价功能，并清理失去用途的实现、常量、缓存、类型、测试和说明。
- **最薄适配层**：仅在 API 缺少项目特有的组合语义、错误归一化、权限边界或生命周期约束时增加最薄适配层，并用实现和测试覆盖差异。
- **依赖安装禁令**：实现功能一律只用已安装依赖；确需新包时停止操作并向用户说明用途和替代方案，由用户决定，不得自行安装。

### 依赖冷却期与紧急豁免 *重要*

- **冷却期配置**：`bunfig.toml` 的 `install.minimumReleaseAge` 必须保持 3 天（`259_200` 秒）；不得用 `bun install --minimum-release-age=<更小值>` 绕过。
- **单包临时豁免**：需要紧急安装未满冷却期的修复时，仅把**那一个包名**加入 `install.minimumReleaseAgeExcludes`，安装完成后立即移除，不得长期留在 `bunfig.toml`。
- **安全核验与记录**：被豁免版本须交叉至少两个独立来源的受害清单核对，并与 npm registry 的 `integrity` 校验一致，同时确认无投毒载荷与持久化残留；每次豁免记录包名、原因（CVE 编号或事件）与移除时间。
- **分类界定**：冷却期阈值与豁免清单的改动不属于依赖安装。

## Telegram 提示留存

### 自动删除与排除范围

- **30 秒自动删除**：Bot 发到群里的非功能性提示（命令校验失败、权限拒绝、用法提示、操作回执、动作命令目标校验失败、`/x` 用法提示）在发送成功后统一 30 秒后删除。
- **统一边界**：所有延迟删除必须复用统一的发送和清理边界，不得遗漏旁路或重复实现定时删除。
- **任务与错误处理**：删除任务不得阻止进程退出；发送失败时不得创建删除任务；删除失败必须走统一 Telegram 错误日志。
- **排除范围**：私聊和功能性内容不适用固定延迟删除；inline 运势必须由 inline API 生成，不得挂固定延迟删除。

### 状态机消息

- **适用范围**：入群验证等带按钮消息、`/qa set` 表单、`/wed` 结果图片及其按钮、gag 公告与发言入口提示。
- **清理与登记**：不挂固定延迟删除，只由按钮、状态机或 teardown 路径删除；新增此类消息必须在 `bun run check:conventions` 登记对应豁免，并将发送收敛在唯一边界函数内。

### 长期保留白名单

仅以下内容允许长期保留：

- `/permission help`、`/permission query` 的权限看板
- `/qa query` 的问答看板、问答直答的答案
- 成功的中文动作命令结果（如 `/咬`、`/揪住`）
- `/h_image` 的结果图片（固定以 Telegram 剧透遮罩发送）
- `cron.json` 定时任务发出的消息（`send_image` 按 `is_blurred` 决定是否遮罩）
- 会话性输出（复读、翻译、AI 回复、洗澡回复）

新增长期保留例外必须由用户明确授权，并在调用点和测试中显式标记。

### 论坛话题路由

- **用户触发消息**：由用户命令或交互触发的群内消息（含长期保留消息、状态机消息、30 秒自删命令提示）均落在触发消息所在的论坛话题（`message_thread_id`）。主线程命令提示由统一发送边界按当前 update 的触发话题补齐；脱离 update 作用域的发送必须显式带上触发话题。
- **Bot 主动消息**：刷屏禁言公告、广告警告与封禁播报、入群验证提醒、私密模式公告以及 `cron.json` 定时任务不带话题（开启话题的群落在 General）。

## 编码规范

- **文件行数上限**：后端文件超过 512 行考虑拆分、超过 1024 行必须拆分；前端 `.tsx`、`.css` 与 `.html` 文件上限为 1536 行。
- **风格与不变量**：代码风格以 ESLint 为准；跨模块和生命周期约束以 `docs/cn/04-invariants.md` 为准。

### 常量与不可变性

- **目录归属**：
  - 字面量常量：`packages/consts/<domain>.ts`（Mini App 前端放 `packages/mini-app-frontend/consts/<domain>.ts`，见「Mini App 前后端边界」）。领域变大时拆分为 `packages/consts/<domain>/`，原文件仅保留 `export * from` 兼容入口，新代码直接导入子模块。
  - 环境变量边界：env 派生配置放 `packages/consts/paths.ts`，环境变量名放 `packages/consts/environment.ts`（`packages/` 与 `index.ts` 中仅这两处允许读取 `process.env`）。
  - 部署 JSON 严格解析：`packages/config/<domain>.ts`。
- **命名与注释**：使用 `SCREAMING_SNAKE_CASE` 和显式类型，长数值用 `_` 分隔；每个常量必须带中文 JSDoc，写明用途、不变量和所属模块。
- **编译期不可变**：
  - `packages/` 下禁止使用 `Object.freeze`。
  - 字面量常量、`packages/config/` 的部署配置解析结果、构造后只读的句柄对象均须在编译期表达不可变性。
  - 容器声明为 `readonly T[]`、`Readonly<T>`、`ReadonlyArray<T>`、`ReadonlyMap` 或 `ReadonlySet`；对象元素使用 `readonly Readonly<T>[]` 或将元素接口字段声明为 `readonly`；导出正则常量及其容器/属性内的正则统一标注为 `Readonly<RegExp>`（由 `bun run check:conventions` 强制核验）。
- **不可变性测试**：
  - 带对象元素的常量表必须在 `test/consts/immutability.test.ts` 中添加 `@ts-expect-error` 断言。
  - 调用方不可变性必须用 `@ts-expect-error` 验证，不得用运行期 `Object.isFrozen`。
  - 断言放在不调用的闭包内或只操作用完即弃的对象，不得修改共享单例。

### Mini App 前后端边界

- **服务端归属**：`packages/mini-app-api-server/` 与 bot 服务共享 `packages/` 下的常量、类型和能力模块，按普通 `packages/` 规则开发。
- **前端目录隔离**：`packages/mini-app-frontend/` 不得依赖该目录之外的任何文件（含 `import type`、`import()`、HTML 的 `src`/`href`、CSS 的 `url()`/`@import`）；npm 依赖共用根 `package.json`，不另建 `package.json`。
- **前后端重合副本**：重合的常量、类型、函数和静态资源在前端单独复制——常量放 `packages/mini-app-frontend/consts/<domain>.ts`（适用与 `packages/consts/` 相同的规则），类型放 `packages/mini-app-frontend/types/<domain>.ts`。每份副本必须登记到 `test/mini-app-frontend/frontendParity.test.ts`（类型编译期恒等，常量、函数与静态资源运行期一致），改动任一侧须在同一改动中同步另一侧。
- **纯前端定义**：只被前端使用的常量与类型放在前端目录，不得留在 `packages/consts/` 或 `packages/types/`。
- **反向引用禁令**：`packages/` 其余模块与 `index.ts` 不得引用 `packages/mini-app-frontend/`；唯一例外是 `packages/mini-app-api-server/server/register.ts` 以 HTML import 引入 `packages/mini-app-frontend/index.html` 作为 `Bun.serve` 打包托管入口。例外登记在 `scripts/conventions/miniAppFrontend.ts` 的 `MINI_APP_FRONTEND_ENTRY_IMPORTS`，新增例外必须经用户明确授权。
- **门禁执行**：上述边界由 `bun run check:conventions` 强制校验。

### Mini App 加密交互

详细架构与路由契约以 `docs/cn/04-invariants.md` 为准。

#### 配置与启动期 Ed25519 密钥

- `config/static/bot.json` 顶层 `mini_app` 可选；启用时下属 `url`、`port`、`password` 必填，`host` 可选并缺省归一化为 `MINI_APP_DEFAULT_HOST`（`"127.0.0.1"`），存在时须为非空字符串（见 `packages/config/botInput.ts`、`packages/types/config.ts`）。
- 配置文件与 CLI 均不得持久化或生成 Ed25519 签名密钥对；出现 `signing_private_key` 或 `signing_public_key` 字段时严格校验直接拒绝。
- 每次 `startMiniAppServer` 在主线程内存中生成一对全新、私钥不可导出的 Web Crypto `Ed25519` 签名密钥对，存于 `miniAppRuntimeSigningKeyHolder`，由 `ensureMiniAppRuntimeSigningKeyPair()` 管理并在 `stopMiniAppServer()` 时清空。
- 物化前端打包产物时（`packages/mini-app-api-server/handlers/page.ts`）：将 Bun 原生 HTML import 产出 JS 块中的占位符 `MINI_APP_SERVER_SIGNING_PUBLIC_KEY_PLACEHOLDER`（对应 `packages/mini-app-frontend/consts/miniAppCrypto.ts` 的 `MINI_APP_SERVER_SIGNING_PUBLIC_KEY_BASE64`）替换为本次启动内存生成的 32 字节 Ed25519 原始公钥 Base64，重算 SHA-256 `ETag`，保留 `PRIVATE_REVALIDATE_CACHE_HEADERS` 协商语义。
- 前端检测到未替换占位符或非法公钥时 fail-closed 拒绝握手（`MINI_APP_INVALID_HANDSHAKE_CODE`）。

#### 请求鉴权流水线

全量业务路由必须通过 `authorizeMiniAppRequest`（`packages/mini-app-api-server/middleware/pipeline.ts`）执行：

- **请求头快路径**：`isAllowedRequestOriginUrl` 仅接受与配置 `mini_app.url` 完全同源（`https:` 协议、主机与端口一致）的 `Origin` / `Referer`，或请求 URL 为本机回环（`127.0.0.1`、`localhost`、`[::1]`）时与请求 URL 自身同源的来源，忽略 `Host`、`X-Forwarded-Host` 与 `X-Forwarded-Proto`。
- **initData 校验**：校验 Telegram WebApp `initData` HMAC-SHA256 签名与超管 ID；活跃会话期间 `initData.auth_date` 放行上限为 `2 小时 + 45 分钟`。
- **锁定与会话校验**：执行防爆破锁定校验与二次认证会话校验（45 分钟滑动续期、2 小时 `MINI_APP_SESSION_MAX_LIFETIME_MS` 绝对到期）。

#### 预检与 X25519 ECDH 登录握手

- **`GET /api/auth/precheck`**：
  - 未解锁的超管请求：生成一次性临时 X25519 密钥对，用本次启动内存 Ed25519 私钥对规范抄本（`MINI_APP_HANDSHAKE_SIGNATURE_DOMAIN`、`handshakeId`、`serverPublicKey`、`expiresAt`）签名后下发 `handshake`，存入主线程 `miniAppAuthHandshakes`（容量上限 `MINI_APP_HANDSHAKE_MAX`，TTL `MINI_APP_HANDSHAKE_TTL_MS`）。
  - 已解锁会话：仅只读核验有效性，不下发握手、不轮换令牌、不签发会话密钥。
- **前端预检处置**（`packages/mini-app-frontend/api/authPrecheck.ts`、`packages/mini-app-frontend/libs/handshakeCrypto.ts`、`packages/mini-app-frontend/api/authLogin.ts`）：
  - 使用注入的源站 Ed25519 公钥验签并校准本地过期时间后暂存握手凭据。
  - 遇 `signatureMismatch` 且存在 `sessionStorage` 时，在 10 秒防环窗（`MINI_APP_SIGNING_KEY_RELOAD_STORAGE_KEY` / `MINI_APP_SIGNING_KEY_RELOAD_WINDOW_MS`）内执行单次 `location.reload()`。
  - 遇 `crypto.subtle` 缺失或 `NotSupportedError` 时归一化为 `MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE`（`WEBCRYPTO_UNSUPPORTED`），不重载。
- **登录请求加密**（`POST /api/auth/login`）：
  - 客户端生成临时 X25519 密钥对，经 ECDH + HKDF-SHA256（`salt` 为 `handshakeId` 原始字节，`info` 前缀区分 `MINI_APP_HANDSHAKE_HKDF_C2S_INFO_PREFIX` / `MINI_APP_HANDSHAKE_HKDF_S2C_INFO_PREFIX` 并绑定双方临时公钥）派生 `c2sKey` 与 `s2cKey`。
  - 使用 `c2sKey`（AEAD `additionalData` 绑定 `MINI_APP_LOGIN_REQUEST_AAD`）加密内层载荷：密码模式仅含 `{ handshakeId, password }`，TOTP 模式仅含 `{ handshakeId, totpCode }`，互斥校验 `hasPassword !== hasTotpCode`。
  - 单步 TOTP 验证通过且会话签发成功后写入 `miniAppLastConsumedTotpStepHolder`，拒绝当前 30 秒时间步内的重复使用。
- **服务端登录校验与加密响应**：
  - 锁定前置检查后执行同套 X25519 + HKDF-SHA256 派生，拒绝全零等低阶 X25519 公钥。
  - 经 `miniAppInFlightHandshakeIds` 拦截并发重放；遇到非法 `clientPublicKey`、AEAD 解密失败或内层载荷畸形时立即销毁对应 `handshakeId`（用完即焚）。
  - 握手通过后的 `200`（直接下发 `{ sessionToken, sessionKey, expiresAt, ttlMs }`，不得签发确定性 `assetToken`）与 `403` 响应均以 `s2cKey`（AEAD `additionalData` 绑定 `MINI_APP_LOGIN_RESPONSE_AAD`）封装为 `MiniAppEncryptedEnvelope` 返回，序列化发送完成后立即清除服务端临时 `pendingSessionKey`。
  - 前端 `decodeMiniAppJsonResponse` 在要求加密的响应上严格拒绝明文 `2xx` 与明文凭据裁决 `403`（`INVALID_PASSWORD` / `INVALID_TOTP_CODE`）。
- **会话上限与淘汰**：主线程最多保留 `MINI_APP_SESSION_MAX`（5）个未过期会话与临时密钥；满额时凭据合法的新登录照常签发，淘汰 `miniAppAuthSessions` 最早端（签发或最近一次轮换距今最久）的会话并同步吊销其下载票据，被淘汰客户端下一次请求需重新登录。

#### 密钥隔离、前端存储与滑动轮换

- **传输红线**：`sessionKey` 仅在 `POST /api/auth/login` 加密响应与启用 `encryptResponse: true` 的业务路由滑动续期时下发；客户端不得在任何 HTTP 请求头、查询参数或请求体中明文传输 `sessionKey` 或明文登录凭据。
- **滑动轮换**：
  - 触发条件（且未超过 2 小时总寿命）：达到本代 `[MINI_APP_SESSION_REFRESH_MIN_MS, MINI_APP_SESSION_REFRESH_MAX_MS]`（5 秒～5 分钟）均匀随机轮换阈值，或本代 `seenRequestIvs.size` 达到 `MINI_APP_SESSION_ROTATE_AT_SEEN_IVS`（`3_072`）。
  - 轮换动作：重新采样随机轮换间隔、重置新纪元 `seenRequestIvs`，通过 `X-Mini-App-Session-Key` 响应头下发新密钥——使用当次请求匹配的旧会话密钥按 AES-256-GCM 封装 `<ivBase64>.<cipherBase64>`，AEAD `additionalData` 绑定新 `sessionToken` 的 UTF-8 字节。
  - 并发宽限期：旧凭据宽限期 `MINI_APP_SESSION_PREVIOUS_GRACE_MS`（5 分钟）独立于随机轮换阈值，客户端首次携带新令牌成功提交即立即作废。
  - 服务端驻留限制：仅保留 `CryptoKey`、仅用于登录响应的瞬态 `pendingSessionKey`、经旧密钥封装的 `sealedSessionKey` 与在途共享封装句柄 `sealedSessionKeyPromise`（仅解析为已封装密文），不得长驻明文十六进制密钥字符串。
    - `pendingSessionKey`：仅在登录签发时短暂持有，登录响应序列化后立即清除（轮换路径不写入 `pendingSessionKey`）。
    - `sealedSessionKeyPromise` / `sealedSessionKey`：轮换提交时同步启动共享 `sealedSessionKeyPromise` 并在封装落定时写入 `sealedSessionKey`、清空该 Promise；新令牌确认或宽限期到期时一并清除。期间携带 `previousToken` 的加密响应路由请求等待同一 `sealedSessionKeyPromise` 或直接取回已落定的 `sealedSessionKey`，原样重新附带同一新令牌与密文，不再轮换。
- **前端存储与水合**（`packages/mini-app-frontend/libs/credentials.ts`、`packages/mini-app-frontend/libs/sessionKeyStorage.ts`）：
  - 令牌与不可导出 `CryptoKey` 作为同代 `{ token, cryptoKey }` 配对存于 IndexedDB，`{ token, expiresAt }` 元数据存于 `sessionStorage`；禁止使用 `localStorage`、禁止明文密钥落盘、禁止在 `globalThis` 上挂任何 `__copyNinjaSession*` / `__copyNinjaAssetToken`。
  - 启动时经 `hydrateMiniAppSessionFromStorage()` 以 IndexedDB 配对为准水合恢复（`sessionStorage` 令牌已更新而新密钥未落盘时恢复上一代配对并回写元数据）；任一缺失或形态不符即自毁清理。
- **并发快照与两阶段提交**：
  - 前端并发请求按同代 `(sentSessionToken, cryptoKeyAtSend)` 快照加解密，仅当本地活跃令牌仍等于 `sentSessionToken` 时写入轮换后的新令牌与新密钥。
  - 服务端按「`lookupMiniAppSessionState` 只读预检 → 请求体解密与 IV 查重 → 成功后 `commitMiniAppSessionAccess`」两阶段提交；解密窗口内令牌被并发轮换并确认时，按会话谱系 `lineageId` 定位存活会话，在查找时的密钥纪元 IV 集合上提交且不轮换。
  - `400 INVALID_ENCRYPTED_PAYLOAD` 不得清除 `previousToken`，不得触发滑动轮换，不得附带 `X-Mini-App-Session*` 响应头。

#### AES-256-GCM 信封、查询串与下载鉴权

- **对称加密参数**：统一使用 Web Crypto `AES-GCM`（256-bit 密钥、12 字节随机 IV `MINI_APP_AES_GCM_IV_BYTES`、128-bit 认证标签 `MINI_APP_AES_GCM_TAG_BITS`）。
- **请求/响应载荷格式**：
  - 业务 JSON 请求体与非 `HEAD` 加密响应体封装为严格三键 `{ encrypted: true, iv, payload }` 信封（默认外层请求体上限 `MINI_APP_MAX_ENCRYPTED_JSON_BODY_BYTES`，`POST /api/configs/save` 为 `MINI_APP_MAX_CONFIG_BODY_BYTES`）。
  - 图库上传（`POST /api/gallery/upload`）采用 `[12B IV || AES-256-GCM 密文+16B 标签]` 原始二进制帧（上限 `MINI_APP_MAX_UPLOAD_BODY_BYTES`，最少 `28` 字节）。
  - AEAD `additionalData` 统一经 `buildMiniAppEnvelopeAad` 绑定 `"${METHOD} ${routePath}:req"`（入站）与 `"${METHOD} ${routePath}:res"`（出站）。
  - 非 `GET`/`HEAD` 加密路由拒绝 `0` 字节空请求体（无载荷 POST/DELETE 发送加密 `"{}"`）。
- **IV 防重放水位**：
  - 同一密钥代际维护有界 `seenRequestIvs` 集合，硬上限为 `MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS = 4_096`。
  - 达到 `MINI_APP_SESSION_ROTATE_AT_SEEN_IVS = 3_072` 水位起，由加密响应路由主动触发滑动轮换并重置 IV 集合与随机轮换冷却时间。
  - 重复 IV 直接返回 `400`；超出硬上限吊销会话并返回 `401`。
- **URL 查询串加密（`?e=`）**：
  - 启用 `encryptRequest: true` 的路由禁止在 URL 传递明文业务参数；非空业务查询串封装为 `?e=<ivBase64>.<cipherBase64>`（`MINI_APP_ENCRYPTED_QUERY_PARAM`，密文上限 `MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH`）。
  - AEAD `additionalData` 绑定 `"${METHOD} ${canonicalApiRoutePath}"`，严格仅允许单一 `e` 参数。
  - 禁止使用 `allowQueryAuth`、`allowVerifiedAssetTokenBypass`、`MINI_APP_QUERY_AUTH_ALLOWED_PARAMS`。
- **图库下载双轨鉴权**（`GET|HEAD /api/gallery/download`）：
  - 浏览器/非原生降级：请求头鉴权 + `?e=` 加密查询参数 + `blob:` 保存。
  - Telegram 原生 `WebApp.downloadFile`：先以加密 `POST /api/gallery/download-ticket` 换取 60 秒单次一次性 64-hex `?ticket=` 票据（上限 `MINI_APP_DOWNLOAD_TICKET_MAX`，按登录内不变的会话谱系 `sessionLineageId` 绑定，会话轮换期间自然保持有效），`HEAD` 探针放行不消耗、`GET` 消费即焚、登出/锁定/过期/淘汰/IV 超限/验证器变更/删图按谱系即时吊销；URL 绝不携带 `?token=`、`?initData=`、`?session=`。
- **拒绝畸形载荷与客户端校验**：
  - 裸 `?`、明文/越权/重复查询参数、空串或 `?` 开头的解密结果、畸形/重放/未加密或验签失败的信封/二进制帧/`?e=`，统一返回 `400`（`MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE`）。
  - 客户端在要求加密的路由上先校验并解密响应体，再采纳轮换响应头，严格拒绝明文 `2xx` 响应；本地缺少会话令牌或密钥时立即清除会话，并在发出前拦截加密 JSON、查询与二进制上传请求。

#### 前端鉴权错误归类

所有业务接口、配置编辑、多图上传、选择器轮询、图库预览与后台轮询统一经 `packages/mini-app-frontend/api/authError.ts` 归类处置：

- **会话重认证错误**：传输层按发包令牌一致性清理本地会话，并通过私有 `Symbol` 标记向异常绑定发包时刻 `sentSessionToken`；`classifyMiniAppAuthError` 仅当发包令牌仍为当前活跃会话或无发包令牌上下文时返回 `"reauth"`，由根 store 重定向至 `AuthGatePage`，已被更新一代会话取代的滞后旧请求不触发锁定或清理。
  - 触发范围：`MINI_APP_SESSION_REAUTH_ERROR_CODES`（`PASSWORD_REQUIRED`、`SESSION_EXPIRED`、`INVALID_ENCRYPTED_PAYLOAD`、`INVALID_HANDSHAKE`）、响应解密或轮换密钥解封失败、裸 HTTP `401`。
- **一层拒绝错误**：非会话依赖的一层门禁拒绝无条件清除本地会话，经 `checking` 重新预检进入 `AccessDeniedPage`；依赖活跃会话延展窗口的 `MINI_APP_EXPIRED_AUTH_DATE_CODE`（`EXPIRED_AUTH_DATE`）按发包令牌一致性防误清，仅在未轮换为新会话或无发包令牌上下文时清除并重定向。
  - 触发范围：`MINI_APP_ACCESS_DENIED_ERROR_CODES`（`PASSWORD_LOCKED`、`EXPIRED_AUTH_DATE`、`MISSING_INIT_DATA`、`MALFORMED_INIT_DATA`、`MISSING_HASH`、`MISSING_USER`、`INVALID_SIGNATURE`、`FORBIDDEN_USER`、`CROSS_SITE_FORBIDDEN`、`DIRECT_NAVIGATION_FORBIDDEN`、`WEBCRYPTO_UNSUPPORTED`）。
- **竞态保护**：过时请求序号竞态不得吞掉当前会话的鉴权重定向；待重预检或已处于 `denied` 状态时不得被滞后重认证错误退回 `password`；已轮换或重新登录至新会话令牌后，滞后旧令牌的重认证与延展期 `EXPIRED_AUTH_DATE` 响应不得清除或锁定新会话。

#### 默认加密策略与免加密边界

- **默认策略**：新增受会话保护的业务 `/api/*` 路由必须使用 `MINI_APP_API_AUTH_POLICY`（`requireSession: true`、`encryptRequest: true`、`encryptResponse: true`），不得新增明文业务接口或在查询串中明文传递业务参数。
- **免加密边界**（新增免加密路由须经用户明确授权）：
  - 外层传输信封免加密：仅限 `GET /api/auth/precheck`、`POST /api/auth/logout`（`MINI_APP_INIT_DATA_AUTH_POLICY`）、单页/打包资源、`/favicon.ico`、`/healthz`。
  - `POST /api/auth/login`：由临时 X25519 + HKDF 派生的 `c2sKey` / `s2cKey` 对内层凭据请求与 `200`/`403` 响应独立完成端到端加密。
  - `GET|HEAD /api/gallery/file`（`MINI_APP_GALLERY_FILE_AUTH_POLICY`）与 `GET|HEAD /api/gallery/download`（`MINI_APP_GALLERY_DOWNLOAD_AUTH_POLICY`）：仅二进制流响应体免加密且不轮换会话密钥，`?e=` 或 `?ticket=` 按策略校验。
  - `POST /api/gallery/upload`（`MINI_APP_GALLERY_UPLOAD_AUTH_POLICY`）：请求与响应双向必须经会话密钥 AES-256-GCM 加解密并执行 IV 防重放校验。
  - 未知非 `/api/` 路径：一律落入页面门禁或 `401`。

#### 前后端同构与互操作门禁

改动服务端（`packages/mini-app-api-server/libs/crypto.ts`、`packages/mini-app-api-server/libs/handshakeCrypto.ts`）或前端（`packages/mini-app-frontend/libs/crypto.ts`、`packages/mini-app-frontend/libs/handshakeCrypto.ts`、`packages/mini-app-frontend/libs/signingKey.ts`）的加密常量、信封格式、握手抄本/HKDF 派生或封包/解包逻辑时，同步更新两端副本以及：

- `test/mini-app-frontend/frontendParity.test.ts`
- `test/mini-app-api-server/cryptoInterop.test.ts`
- `test/mini-app-api-server/loginEcdhHandshake.test.ts`

### 缓存与线程归属

- **位置与 owner**：长期 Map、Set、队列、timer 和单例放在 `packages/cache/<owner>/`；第一层 owner 仅允许 `main/`、`workers/aiChat/`、`workers/antiRaid/`、`workers/diskIO/`、`perThread/`；缓存文件头必须注明 owner。
- **线程隔离与豁免**：缓存只能被 owner 线程 import；跨线程只能传消息，不得共享内存。归属由 `bun run check:conventions` 按真实模块图核对，当前无豁免（`CACHE_OWNER_EXEMPTIONS` 为空）；新增豁免必须同时修改 `CACHE_OWNER_EXEMPTIONS` 与被豁免模块头注。
- **写法与 JSDoc**：可变单例必须使用 `{ current: T | null }` holder，不得使用 `export let`，泛型写在类型标注上。每个缓存导出必须用 JSDoc 写明填充和清理时机、Worker 崩溃重建方式、容量及清理策略。
- **新增决策顺序**（前一项可行时不得进入后一项）：
  1. 写入方作为 owner；无唯一写入方时拆成两份缓存。
  2. 缓存放在使用线程，不新增跨线程消息。
  3. 仅当观测点与使用点天然跨线程时允许镜像；镜像仅允许 owner 变更时推送且使用侧只读，或用于防丢失的持久化回执。
- **通信与高频禁忌**：禁止每次读取都使用 request/reply；每条群消息的高频路径禁止镜像同步，接收方所需最终字段必须放入现有消息。
- **镜像 JSDoc**：写明权威线程、推送时机、全量或增量模式、Worker 或进程重启后的重放方，以及“无条目”的 fail-safe 含义；不得把缺失解释为沿用旧值。
- **纯函数拆分**：纯函数不得与另一线程独占缓存放在同一文件，必须拆为不接触缓存的叶子模块。

### 性能、内存与 Bun/JSC JIT

- **优先级与热点定位**：正确性、状态机、生命周期和可维护性优先。优化前必须定位每消息、队列循环、Worker 消息等真实热点；无测量证据不得优化冷启动、低频命令或 I/O 等待路径。
- **对象与分配**：热调用点保持类型和对象 shape 稳定，按固定顺序一次初始化所需字段，不得事后增删字段，也不得为统一 shape 增加大量无用字段。高频路径可直接读取现值时，不得创建投影对象、临时数组、复合键、一次性闭包或 `map`/`filter`/`flatMap` 中间结果。
- **参数与跨线程载荷**：超过 3 个参数时仍使用 options 并优先传递现有上下文，不得复制同构对象。跨线程只传最终所需载荷，不得反复展开、深拷贝或重建，不得使用共享可变内存，不得在每条群消息路径增加同步往返。
- **重复计算缓存**：仅在输入稳定且失效边界明确时缓存重复解析、序列化、规范化或复合键，并具备 owner、容量、清理和 Worker 重建策略。
- **紧凑数据结构**：高频有界队列、窗口或数值缓冲仅在基准支持时使用连续存储、环形缓冲或 TypedArray，且不得改变容量、顺序、淘汰或停机语义。
- **对象池限制**：无测量证据不得使用对象池；不得复用会逃逸或跨异步边界的可变载荷、事件或权限结果。
- **函数结构**：热函数保持单一职责和清晰控制流；不得为猜测内联堆叠薄包装，不得合并成巨型函数。
- **性能对照**：必须固定 Bun 和输入，完成预热并以独立进程重复，记录吞吐、延迟、堆和 GC，差异必须高于噪声。
- **分析与诊断工具**：性能分析优先使用 Bun profiler、`performance.now()`、`Bun.nanoseconds()` 和 `bun:jsc`；`Bun.gc()`、强制 GC、`--smol` 和人为延长对象生命周期仅限诊断或基准，不得进入生产代码。
- **回归门禁**：性能改动必须保留语义测试并为热点增加基准或压力验证；涉及持久化格式、状态机顺序、权限或 Worker 生命周期时必须执行对应门禁，不得以 JIT 为由绕过。

#### 全量性能基准

- **入口与门禁边界**：全量基准入口为 `bun run perf:full`（`scripts/perf/fullSuite.ts`），只在发布和明确指令时运行，不进 `bun run check`；全量基准不设失败阈值、不改退出码，热路径 GC/RSS/JIT 硬门禁使用 `bun run perf:hot-path-gate`。
- **分区与轮数**：分区固定为冷启动、生产热路径、端到端落盘链路、SQLite 与主线程缓存、容器与算法、入群日志容量线；每项在独立子进程跑三轮，报告平均值、最小值、最大值与变异系数。
- **临时目录清理**：数据写入仓库根 `performance/`，配置读取 `config_example/`，每轮跑完删除整棵目录；运行结束后 `performance/` 下不得有残留目录。
- **文档与结果写出**：`--write-doc` 必须以单一开关同时写出两处（不得拆分为两个 flag）——三份 `11-performance.md` 的基准区块与仓库根 `performance-result.json` 的 `fullSuite.lastRun`（结构化报告全文）。`performance-result.json` 的 `hotPathProfileGate` 节由热路径门禁写入，两侧只替换各自对应字段（见 `scripts/perf/performanceResult.ts`）。
- **模块导入隔离**：父进程与 `scripts/perf/fullSuite/` 下除 `fixture.ts`、`seed.ts`、`coldStart.ts`、`chain.ts`、`storage.ts` 以外的模块，只能 import 纯常量与 `import type`，不得 import `packages/` 下的实现模块。
- **复用生产逻辑**：新增被测项复用 `scripts/perf/` 已有实现与生产入口，不得为基准另写生产逻辑、落盘格式或夹具规模（夹具规模引用生产常量）。
- **命令链路出站替换**：完整命令链路（`ad-detect-command`、`ai-reply-command`、`cron-send-voice`）只在**基准侧**替换出站——模型客户端使用 `packages/cache/` 已有 holder，Telegram 使用 `scripts/perf/outboundGuard.ts` 的罐头应答并在 `installOutboundGuards` 之后安装到最外层；`packages/` 不得包含基准专用分支，基准不得发起真实请求。
- **链路断言与重新出数**：命令链路必须断言处置排空结果和 `cannedTelegramCalls` 计数，静默提前返回必须使基准失败。改动规模常量、迭代次数或分区构成后，在同一次发布中重新出数并在提交信息中说明。

### 类型与接口

- **显式标注**：变量、参数、返回值、对象属性、数组元素和普通 `for` 变量必须显式标注类型；仅豁免 `for...of`/`for...in` 变量、初始化器为全标注箭头函数的 `const`、自引用 `typeof` 常量。导出函数必须标注返回类型（包括 `Promise<T>`）。
- **共享类型与导入**：共享类型按领域放在 `packages/types/<domain>.ts`（Mini App 前端放 `packages/mini-app-frontend/types/<domain>.ts` 或领域子目录 `types/miniApp/`），生产代码与 `scripts/` 直接导入领域文件；`packages/types/antiRaid.ts`、`packages/types/diskIO.ts`、`packages/types/miniApp.ts`、`packages/mini-app-frontend/types/miniApp.ts` 等聚合入口仅供测试。类型导入必须单独使用 `import type`。
- **严格约束**：保持 `strict` 和 `noUncheckedIndexedAccess` 并处理索引返回的 `undefined`；生产代码禁止 `any`（测试代码豁免）；异常捕获必须使用 `catch (error: unknown)`。
- **函数与参数**：位置参数最多 3 个，超出必须改为函数旁导出的 options interface 并在签名处解构；可选项使用 `?`，默认值写在解构处。导出函数使用 `function`，箭头函数仅用于回调和 IIFE。
- **JSX 与并发**：JSX/TSX 片段必须显式使用 `react` 的 `<Fragment>`，禁止 `<>...</>` 简写。非必要绝不使用 `Promise.all`，必须使用 `Promise.allSettled` 并做有界重试和批处理。

### 测试

- 断言涉及部署配置、示例配置（`config_example/`）或代码常量取值时，必须从对应的配置解析结果、holder 或常量模块读取，不得在测试中写死具体值；仅测试自建夹具和 mock 允许使用字面量。

### 注释、日志与文档

#### 注释与 JSDoc

- 使用中文，只描述现行代码的职责、调用方式、输入输出、状态变化、执行顺序、边界和不变量。
- 注释和文档只写当前实现如何工作、如何配置、如何操作和如何验证；不得记录选择原因、备选方案、废弃实现、修复前行为、历史性能对比或提交过程。
- 每次修改代码必须在同一改动中检查并同步更新所有受影响的注释和 JSDoc（改动位置、调用方、类型定义、常量、缓存、测试）；符号、路径、数据格式、生命周期、执行顺序、边界或行为变化时同步更新对应注释，直接删除失去用途的说明。注释未同步完成前不得视为改动完成，不得留待后续整理。
- 类型、命名和控制流已完整表达的内容不写注释，不得逐行复述代码。
- 跨模块约束直接引用 `docs/cn/04-invariants.md`，不得在代码中重复全文。

#### 文档更新

- 当前架构、接口、约束、配置、操作、迁移和验证步骤写入 `docs/`，代码仅保留必要 JSDoc。
- 未经用户明确要求，不得更新文档、README 或指标；代码使文档失真时，在交付中列出待同步项。
- 获得文档更新授权后，只依据真实代码和门禁输出修改文档。

#### 日志分级与落盘

- **日志入口**：`packages/` 与 `index.ts` 必须使用 `logger`，禁止直接使用 `console.log`；`packages/` 下仅 `packages/workers/diskIOWorker.ts` 和 `packages/workers/diskIO/` 内的错误允许使用 `console.error`（由 `bun run check:conventions` 强制）。
- **CLI 与文案语言**：`scripts/` 的一次性 CLI（约定自检、冷迁移、性能基准）不接入 `logger`，直接输出到 stdout/stderr。`logger.info`、`logger.operation`、`logger.warn`、`logger.error` 的框架日志文案使用英文。
- **级别定义与配置分发**：`logger`（`packages/infra/logger.ts`）按严重度递增支持 `info` < `operation` < `warn` < `error`（见 `packages/consts/logger.ts` 的 `LOG_LEVELS`、`LOG_LEVEL_PRIORITY`）。`config/static/bot.json` 支持可选字段 `log_level`（允许 `"info"`、`"operation"`、`"warn"`、`"error"`，缺省与 `config_example/static/bot.json` 模板均默认 `"operation"`，见 `DEFAULT_LOG_LEVEL`）；`packages/config/botInput.ts` 启动时严格拒绝非法值，`adoptLogLevel`（`packages/config/logLevel.ts`）写入当前线程并在各 Worker 初始化及快照重放时同步下发。

各级别记录边界：

| 级别 | 包含与记录范围 | 排除范围 |
| --- | --- | --- |
| `info` | 包含 `operation`、`warn`、`error`；记录生命周期、热重载、队列/恢复、入群拦截、AI/反广告处理、定时器触发等代码行为 | 每条普通群消息 |
| `operation` | 默认生产级别，包含 `warn`、`error`；记录 Telegram 人类用户/匿名管理员/频道马甲发起的 `/` 命令、`/wed` 回调、`/qa set` 表单交互，以及 Mini App 登录、登出与所有状态修改操作 | 纯前端交互、只读查询、普通聊天消息、非匿名/非频道 bot 发出的消息、群内自动转发（`is_automatic_forward`）、机器人自发消息回投 |
| `warn` | 包含 `error`；记录可自动恢复或被降级处理的告警、限流、配额/容量告警、安全拒绝与异常外部载荷 | — |
| `error` | 记录未捕获异常、不可恢复失败、外部 API/持久化失败与完整性/权限门禁错误 | — |

- **结构化调用**：
  - 无动态参数：传单个静态英文字符串 `logger.<level>("Static English message.")`，禁止将动态元数据拼入模板字符串、拼接串或 `key=value` 文本。
  - 含动态上下文：传 `(静态英文摘要, { camelCase上下文字段 })`。
  - 含异常对象：有动态上下文传 `(静态英文摘要, { camelCase上下文字段 }, error)`，无动态上下文传 `(静态英文摘要, error)`。
  - `operation` 审计日志：首参静态摘要统一为 `"[TelegramCommand] ..."` 或 `"[MiniApp] <domain>.<action>"`，并附结构化上下文对象。
- **控制台与落盘格式**：
  - 控制台按级别前置 `CONSOLE_PREFIX_BY_LOG_LEVEL`（`[INFO]` / `[OPERATION]` / `[WARN]` / `[ERROR]`），以原生多行格式打印结构化对象；跨线程信封 `LogMessage.args` 不含级别前缀。
  - `logs/<YYYY-MM-DD>.json`（`packages/workers/diskIO/logFiles.ts`）单条记录为 `{ level, message, args? }`：`message` 仅拼接字符串参数，`args` 仅保存非字符串结构化参数（上下文对象、展开后的 `Error` 对象等，不重复 `message`；全为字符串参数时省略 `args`）。
- **脱敏边界**：日志正文与参数禁止主动记录口令、OTP、token、API key、`initData` 签名或完整聊天/问答正文，统一经 `packages/infra/logger/serialization.ts` 脱敏后再输出与落盘。
- **过滤与缓冲落盘**：
  - 低于 `log_level` 阈值的日志在序列化与控制台输出前直接忽略。
  - 达到或高于阈值的日志先输出到对应 `console` 方法，再进入主线程 `diagnosticQueue`（主线程经 `logRelaySink` 即 `packages/infra/diskIO.ts` 的 `relayLogMessage` 送入；业务 Worker 经单批有界 Two-hop ACK 通道送入）。
  - `info` / `operation` / `warn` 在主线程按批缓冲，攒满 `DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES`（`32`）条或到达 `FLUSH_INTERVAL_MS`（30 秒）后单批交由 Disk I/O Worker（`packages/workers/diskIO/logFiles.ts`）按配置时区日期追加写入 `logs/<YYYY-MM-DD>.json`。
  - `error` 日志、队列溢出汇总日志、非日志诊断（`adSample` / `aiCacheUsage`）以及 `flushDiskIO()` / `flushDiskIODomain("log")` 立即触发主线程诊断排空并落盘。

## 分支、验证、提交与发布

### 分支与验证

- 只使用 `master` 和 `dev`，不得创建功能分支；开发必须在 `dev` 进行，不得直接提交到 `master`。
- 每次 commit 前必须运行 `git branch --show-current`。
- 提交前必须运行 `bun run lint && bun run typecheck` 或完整的 `bun run check`。
- 合入 `master` 前必须确保 `bun run check` 全绿；涉及持久化、停机或 Worker 生命周期时，合入前还必须运行 `bun run test:fault-injection`。
- 门禁失败时不得合入。

### 提交与合并

- `master` 只允许通过 `git merge --squash` 合入并创建单次提交。
- 提交信息必须覆盖完整改动集并说明改动依据。
- 误在 `master` 提交且尚未推送时，先 cherry-pick 到 `dev`，再执行 `git branch -f master origin/master`，再按正常 squash 流程处理。

### 发布

#### 发布顺序

每次发布必须按以下顺序完整执行：

1. 在 `dev` 完成开发和门禁。
2. 在 `dev` 运行 `bun run perf:full -- --write-doc`，更新三份 `11-performance.md` 的基准区块与 `performance-result.json` 的 `fullSuite.lastRun`，并与代码改动一起提交。
3. 在干净且已提交的 `dev` 上，为本次声明的每个平台原生执行 `bun run release:build -- --version <tag>`，收集发行包和 SHA-256 文件，并执行 `bun run release:verify -- --version <tag> --platforms <平台列表>`。
4. 以 `git merge --squash` 合入 `master` 并创建单次提交，确认 Git tree 与构建时一致。
5. 推送 `master`。
6. 为该提交创建并单独推送 annotated version tag。
7. 执行 `bun run release:publish -- --version <tag> --platforms <平台列表> --notes-file <说明文件>`，先补齐草稿资产并下载校验，再公开为 Latest，最后确认 Release、远端引用和下载内容。
8. Release 确认成功后，将 `dev` reset 对齐到 `master`，并以 `--force-with-lease` 推送。

#### 版本号与选版

- 发布前同步远端 tags，并通过 `gh release list` 读取 GitHub Latest Release；不得依据本地旧 tag 推断版本。
- 版本号仅使用无 `v` 前缀的 `MAJOR.MINOR.PATCH`：破坏兼容升 MAJOR，兼容新增升 MINOR，仅修复/性能/重构/文档变更升 PATCH；混合改动取最高级。
- 新发布选版时目标 tag 已存在，必须重新读取 Release 状态并重算版本，不得覆盖、移动或复用已有 tag（同一次发布失败后的续跑按「Release 发布与失败续跑」使用原 tag）。

#### 发布基准

- 使用默认三轮，与上一次发布同机器、同 Bun 构建；`--rounds` 仅用于本地排查，非默认轮数的读数不得写进文档。
- 跑基准前停掉机器上的其它重负载（包括本仓库的服务进程和其它门禁）。
- 全量基准与 `bun run check` 不得连着跑，等机器空载后再跑后一个；热路径软上报按空载读数判定。
- 基准区块由脚本按 `<!-- performance-benchmark:start -->` 与 `<!-- performance-benchmark:end -->` 标记整块替换，写入 `docs/{cn,en,ja}/11-performance.md`；区块内容不得手工编辑，三种语言必须同批更新。
- 三份 README 只保留指向 `11-performance.md` 的链接，不得放入基准读数。
- 基准跑失败或读数异常时停止发布，查清原因后重跑。

#### 构建、平台与产物校验

- `bun run build -- --version <tag>` 和 `bun run release:check -- --version <tag>` 必须显式传入无前缀的 `MAJOR.MINOR.PATCH`，不提供默认版本，也不从源码 manifest 推断；传入值写入包内 `package.json` 与 `binary.json`，缺失或非法版本在构建或安装依赖前拒绝。
- `release:check` 包含二进制构建及隔离启动、版本、无 `.map` 文件与 `node_modules`、Worker、内置图片编解码和安装器验证；正式发行包必须在代码与基准提交后重新通过 `release:build` 生成。
- 二进制平台为 `linux-x64`、`linux-arm64`、`linux-x64-musl`、`linux-arm64-musl`；`--platforms` 必须明确列出本次发布平台，不得缺包后静默缩减。每个平台在对应环境原生构建和验证，使用同一 Git tree、Bun version/revision。
- 每个平台上传 `copy-ninjia-<平台>.tar.gz` 与对应 `.tar.gz.sha256`（多机汇总目录用 `--directory` 指定）。构建在 Git 工作树内严格按 `git ls-files` 受跟踪清单暂存发行包源码资产（排除 `.gitignore` 忽略文件与未跟踪杂项）；发布脚本核对 SHA-256、精确归档条目白名单（拒绝任何多余文件、目录或符号链接）及包内版本、平台、Git tree、Bun 构建；`development` 或未提交工作树的产物不得发布。
- 构建产物与发行包不得包含任何敏感信息。
- 二进制安装从 Release 下载发行包，不在目标机器检出源码或执行构建。

#### Release 发布与失败续跑

- `release:publish` 执行前必须完成仓库与部署保护检查；只操作已推送 annotated tag 的 Release，不推送分支、不创建或移动 tag、不自动同步 `dev`。
- 发布脚本使用 `gh release create --verify-tag --target master --draft`，仅在所有声明资产下载校验成功后公开为 Latest。
- Release 标题和说明使用英文，只描述上一个 Latest tag 到本次 `master` 的增量，必须包含 `Highlights`、`Compatibility / Migration Notes`（列明本次提供的平台）、`Validation`（测试数量和覆盖率必须来自本次门禁）。
- tag 已推送但 Release 创建、上传或确认失败时，必须保留并重试同一 tag，不得递增版本：已有草稿只能补传缺失资产，同名资产须下载核验、不得覆盖；已公开 Release 缺少资产或已有资产不符时停止发布并保留现场。
- `master`、tag、Release、Latest 状态或二进制资产任一未确认成功前，不得宣称发布完成，不得改写或同步 `dev`，不得在只推送 `master` 后结束发布。

#### 发布后对齐与指标同步

- Release 确认成功后，先执行 `git diff dev master --quiet` 确认树一致，再在 `dev` 执行 `git reset --hard master` 和 `git push --force-with-lease origin dev`。
- 发布结束前必须确认本地和远端的 `dev`、`master` 全部指向同一提交。
- 仅在用户明确要求同步文档或指标时，依据合并前真实 `bun run check` 输出更新徽章、`public/coverage_{light,dark}.svg`、README `<img alt>` 和三份开发文档；完整清单以 `docs/cn/05-dev-workflow.md` 的「同步 README 指标」为准。
