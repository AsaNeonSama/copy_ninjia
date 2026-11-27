/** owner: main。Mini App HTTP 服务实例、按需物化前端产物快照、独立拒绝页模板、运行时配置镜像、每次启动内存生成的 Ed25519 签名密钥对、临时 X25519 登录握手、二次认证会话与 256-bit 临时密钥、服务重启执行器替身及预备选择器缓存（packages/mini-app-api-server/）。 */

import {
  MINI_APP_PICKER_MAX_PENDING,
  MINI_APP_PICKER_MAX_RESULTS,
  MINI_APP_SESSION_MAX,
} from "../../consts/miniApp";
import {
  MINI_APP_DOWNLOAD_TICKET_MAX,
  MINI_APP_HANDSHAKE_MAX,
} from "../../consts/miniAppCrypto";
import { FifoMap } from "../../libs/fifoMap";
import type { BotMiniAppConfig } from "../../types/config";
import type {
  MiniAppAuthHandshakeRecord,
  MiniAppAuthSession,
  MiniAppConsumedTotpStep,
  MiniAppPasswordGuardState,
  MiniAppRuntimeSigningKeyPair,
} from "../../types/miniApp/auth";
import type { MiniAppServiceRestartRunner } from "../../types/miniApp/configs";
import type { MiniAppGalleryDownloadTicketRecord } from "../../types/miniApp/gallery";
import type {
  MiniAppPickerResultEvent,
  MiniAppPreparedPickerSession,
} from "../../types/miniApp/identities";
import type {
  BundledMiniAppAssets,
  MiniAppPublicUrlParts,
  MiniAppRejectHtmlTemplate,
} from "../../types/miniApp/server";
import type {
  MiniAppPendingTotpSetup,
  MiniAppTotpRecord,
} from "../../types/miniAppTotp";

/**
 * 主线程当前运行的 `Bun.serve` 实例句柄。
 * 填充：`startMiniAppServer` 启动 HTTP 监听成功后写入。
 * 清理：`stopMiniAppServer` 停机关闭监听时停止并置回 `null`。
 * 容量恒为单个实例；与 Worker 生命周期无关，进程重启后从 `null` 重新按 `bot.json` 启动。
 */
export const miniAppServerHolder: {
  current: ReturnType<typeof Bun.serve> | null;
} = { current: null };

/**
 * 主线程当前激活的 Mini App 配置快照。
 * 填充：`startMiniAppServer` 启动时写入传入的配置对象。
 * 清理：`stopMiniAppServer` 停止服务时重置为 `null`。
 * 容量恒为单个只读配置对象，不淘汰；与 Worker 崩溃无关，进程重启后从 `null` 重新按 `bot.json` 填充。
 */
export const miniAppActiveConfigHolder: {
  current: Readonly<BotMiniAppConfig> | null;
} = { current: null };

/**
 * 主线程当前激活的 Mini App 公网 URL 派生片段（`basePath`、小写 `host` 与完整 `https:` 源站 `origin`）。
 * 填充：`startMiniAppServer` 启动时与 `miniAppActiveConfigHolder` 同步由 `deriveMiniAppPublicUrlParts` 派生写入。
 * 清理：`stopMiniAppServer` 停止服务时与 `miniAppActiveConfigHolder` 同步重置为 `null`。
 * 容量恒为单个只读对象，不淘汰；与 Worker 崩溃无关，进程重启后从 `null` 重新按 `bot.json` 派生。
 */
export const miniAppActiveUrlPartsHolder: {
  current: Readonly<MiniAppPublicUrlParts> | null;
} = { current: null };

/**
 * 已完成二次认证并换取签发的超级管理员会话令牌与 256-bit 会话临时密钥表（键为当前 64 位十六进制 `token`，每个会话占 1 个槽位）。
 * - 填充：`POST /api/auth/login` 经临时 X25519 ECDH 协商解密核验二次认证凭据通过后签发写入最新端（仅在首次登录响应序列化前短暂持有明文 `pendingSessionKey`，序列化后即清除）；
 *   在启用加密响应的业务接口上携带有效令牌访问且达到本代 `[MINI_APP_SESSION_REFRESH_MIN_MS, MINI_APP_SESSION_REFRESH_MAX_MS]`（5 秒～5 分钟）随机轮换阈值或 `MINI_APP_SESSION_ROTATE_AT_SEEN_IVS`（3,072）IV 水位时删除旧键、轮换签发新令牌与新 256-bit 密钥插到最新端（重置新纪元 `seenRequestIvs` 与随机轮换冷却时间）并顺延 45 分钟有效期（总寿命受 `MINI_APP_SESSION_MAX_LIFETIME_MS` 2 小时封顶），
 *   旧令牌、旧 `CryptoKey` 与旧 IV 去重集合暂存在 `previousToken` / `previousCryptoKey` / `previousSeenRequestIvs` 供并发在途请求过渡，
 *   轮换不写入 `pendingSessionKey`，而是同步启动共享密文封装 `sealedSessionKeyPromise`（仅解析为经旧密钥封装的密文），封装落定后写入 `sealedSessionKey` 并清除 `sealedSessionKeyPromise` 供旧令牌请求重新取回，
 *   上述过渡字段在客户端首次携带新令牌到达时或 `MINI_APP_SESSION_PREVIOUS_GRACE_MS` 宽限期满时清除；`lineageId` 在历次轮换间不变。
 * - 清理：每次鉴权或签发前按 `MINI_APP_SESSION_TTL_MS`（45 分钟）清理过期项；`POST /api/auth/logout` 删除当前会话与密钥；
 *   `POST /api/totp/enable`、`DELETE /api/totp` 与 `POST /api/totp/delete` 经 `revokeOtherMiniAppAuthSessions`
 *   按 `lineageId` 保留调用者会话并吊销其余会话；IV 超限（`cap_exceeded`）按 `lineageId` 吊销会话；登录失败锁定与 `stopMiniAppServer` 清空全表。
 * - 容量与重建：硬上限为 `MINI_APP_SESSION_MAX`（5），满 5 个未过期会话时签发前先淘汰最早端（签发或最近一次轮换距今最久）的会话并按 `lineageId` 吊销其下载票据；
 *   与 Worker 崩溃无关，进程重启后从空表开始。
 */
export const miniAppAuthSessions: FifoMap<string, Readonly<MiniAppAuthSession>> =
  new FifoMap<string, Readonly<MiniAppAuthSession>>(MINI_APP_SESSION_MAX);

/**
 * `miniAppAuthSessions` 中所有存活会话的最早过期或宽限清理水位时间戳（毫秒，`Infinity` 表示空表无需扫描）。
 * - 填充：签发、轮换、清理宽限字段或扫描过期会话后由 `sessionLookup.ts` / `sessionCommit.ts` / `sessionLifecycle.ts` 同步更新为全表最早到期或宽限截止时刻。
 * - 清理：`miniAppAuthSessions` 清空或 `size === 0` 时重置为 `Number.POSITIVE_INFINITY`。
 * - 容量与重建：恒为单个数值槽位，不淘汰；与 Worker 崩溃无关，进程重启后从 `Number.POSITIVE_INFINITY` 开始。
 */
export const miniAppAuthSessionWatermark: {
  nextPurgeAt: number;
} = { nextPurgeAt: Number.POSITIVE_INFINITY };

/**
 * Mini App 源站每次启动在内存中生成的不可导出 Ed25519 签名密钥对 `Promise` 句柄（仅用于对动态 X25519 握手公钥签名及向前端打包 JS 注入对应公钥）。
 * - 填充：`startMiniAppServer` 启动时重置后立即生成（或首次 `ensureMiniAppRuntimeSigningKeyPair` 按需生成并共享同一个在途 `Promise`）。
 * - 清理：`stopMiniAppServer` / `clearMiniAppRuntimeSigningKeyPair` 停止服务时置回 `null`；若生成异步失败则自清回 `null`。
 * - 容量与重建：恒为单个只读 `Promise` 句柄，不淘汰；与 Worker 崩溃无关，每次重启应用重新生成一对全新 Ed25519 密钥。
 */
export const miniAppRuntimeSigningKeyHolder: {
  current: Promise<Readonly<MiniAppRuntimeSigningKeyPair>> | null;
} = { current: null };

/**
 * `GET /api/auth/precheck` 核验超管 `initData` 通过且未解锁活跃会话时签发的临时 X25519 握手私钥表（键为 32 位十六进制 `handshakeId`）。
 * - 填充：`GET /api/auth/precheck` 生成临时 X25519 密钥对并使用源站 Ed25519 私钥签名后写入。
 * - 清理：`POST /api/auth/login` 完成该次登录协商核验并消耗对应握手 ID 时立即删除（用完即焚）；
 *   每次签发或读取前按 `MINI_APP_HANDSHAKE_TTL_MS` 清理超时未消费项；TOTP 验证器变更（`revokeOtherMiniAppAuthSessions`）、登录连续失败锁定与 `stopMiniAppServer` 时清空全表。
 * - 容量与重建：上限为 `MINI_APP_HANDSHAKE_MAX`（16），满额时由 `FifoMap` 淘汰最早未消费项；
 *   与 Worker 崩溃无关，进程重启后从空表开始。
 */
export const miniAppAuthHandshakes: FifoMap<string, Readonly<MiniAppAuthHandshakeRecord>> =
  new FifoMap<string, Readonly<MiniAppAuthHandshakeRecord>>(MINI_APP_HANDSHAKE_MAX);

/**
 * 正在执行 `POST /api/auth/login` ECDH 协商、解密与会话签发裁决的在途握手 `handshakeId` 集合（拦截同一 `handshakeId` 的并发重放）。
 * - 填充：`handlePostAuthLoginRoute` 开始核验指定 `handshakeId` 时同步加入。
 * - 清理：该次请求结算的 `finally` 分支（及消费成功时随 `consumeMiniAppAuthHandshake` 同步移除）与登录失败锁定、`stopMiniAppServer` 时移除或清空。
 * - 容量与重建：上界与并发登录握手请求及 `MINI_APP_HANDSHAKE_MAX` 同阶，操作结束即释放；与 Worker 崩溃无关，进程重启后从空集合开始。
 */
export const miniAppInFlightHandshakeIds: Set<string> = new Set<string>();

/**
 * 静态配置页触发宿主服务重启的可选执行器替身句柄（`null` 表示使用默认 `Bun.spawn` 执行 `systemctl restart --no-block copy-ninjia`）。
 * - 填充：仅在隔离测试中注入模拟执行器函数时写入。
 * - 清理：测试重置或 `stopMiniAppServer` 停止服务时置回 `null`。
 * - 容量与重建：恒为单个可选函数引用，不淘汰；与 Worker 崩溃无关，进程重启后从 `null` 开始。
 */
export const miniAppServiceRestartRunnerHolder: {
  current: MiniAppServiceRestartRunner | null;
} = { current: null };

/**
 * 超级管理员 ID 的 Mini App 二次认证（访问密码或 6 位 TOTP 动态码）连续失败计数与锁定状态句柄。
 * 填充：`POST /api/auth/login` 二次认证凭据校验失败（或并发请求撞上已生效锁定）时累加 `failedAttempts`，
 * 达到 `MINI_APP_PASSWORD_MAX_ATTEMPTS` 时按 `MINI_APP_PASSWORD_LOCKOUT_MS` 写入或顺延 `lockedUntil`。
 * 清理：二次认证通过、锁定期满后自动归零，或 `stopMiniAppServer` 停止服务时置回 `null`。
 * 容量恒为单个只读状态对象（仅绑定 `SUPER_ADMIN_USER_ID`）；与 Worker 崩溃无关，进程重启后从 `null` 开始。
 */
export const miniAppPasswordGuardHolder: {
  current: Readonly<MiniAppPasswordGuardState> | null;
} = { current: null };

/**
 * `savePreparedKeyboardButton` 预备选择器请求的自增序号（循环限制在 32 位正有符号整数区间 `1..0x7fffffff`）。
 * 填充：每次通过 `prepareMiniAppPicker` 创建预备按钮时递增。
 * 清理：`stopMiniAppServer` 清零。
 * 容量恒为单个数值，不淘汰；与 Worker 崩溃无关，进程重启后从 `0` 开始。
 */
export const miniAppPickerSequence: {
  current: number;
} = { current: 0 };

/**
 * 待超级管理员在 Telegram WebApp 选择器中确认的预备会话表（键为 `request_id`）。
 * 填充：`prepareMiniAppPicker` 调用 `savePreparedKeyboardButton` 成功后写入。
 * 清理：收到对应的 `users_shared` / `chat_shared` 服务消息消费后删除，每次写入或读取前按 `MINI_APP_PICKER_TTL_MS` 清理过期项，`stopMiniAppServer` 清空。
 * 容量上界为 `MINI_APP_PICKER_MAX_PENDING`，超出时由 `FifoMap` 按插入顺序淘汰最早条目；与 Worker 崩溃无关，进程重启后从空表开始。
 */
export const miniAppPendingPickers: FifoMap<number, Readonly<MiniAppPreparedPickerSession>> =
  new FifoMap<number, Readonly<MiniAppPreparedPickerSession>>(MINI_APP_PICKER_MAX_PENDING);

/**
 * 已处理完成的 `users_shared` / `chat_shared` 选择导入结果回执表（键为 `request_id`）。
 * 填充：私聊收到 `users_shared` / `chat_shared` 完成名单写入后记录。
 * 清理：每次写入或读取前按 `MINI_APP_PICKER_TTL_MS` 清理过期项，`stopMiniAppServer` 清空。
 * 容量上界为 `MINI_APP_PICKER_MAX_RESULTS`，超出时由 `FifoMap` 按插入顺序淘汰最早条目；与 Worker 崩溃无关，进程重启后从空表开始。
 */
export const miniAppCompletedPickerResults: FifoMap<number, Readonly<MiniAppPickerResultEvent>> =
  new FifoMap<number, Readonly<MiniAppPickerResultEvent>>(MINI_APP_PICKER_MAX_RESULTS);

/**
 * 主线程缓存的已启用谷歌验证器（TOTP）单实例记录镜像（`undefined` 表示尚未首次读盘加载，`null` 表示已确认未绑定）。
 * - 填充：启动组合点（或首次调用 `loadMiniAppTotpRecord`）读取 `memory/mini-app-totp/totp.json` 后写入，
 *   或调用 `POST /api/totp/enable` 绑定成功后立即更新。
 * - 清理：调用 `DELETE /api/totp` 或 `POST /api/totp/delete` 删除验证器时置为 `null`；
 *   `stopMiniAppServer` 或测试重置时置回 `undefined`。
 * - 容量与重建：恒为单个只读记录对象（最多 1 个验证器）；与 Worker 崩溃无关，进程重启后从磁盘重新加载。
 */
export const miniAppTotpRecordHolder: {
  current: Readonly<MiniAppTotpRecord> | null | undefined;
} = { current: undefined };

/**
 * 前端控制台发起“生成/修改验证器”后暂存的待扫码确认 TOTP 密钥句柄。
 * - 填充：`POST /api/totp/setup` 生成随机 Base32 密钥与二维码时写入。
 * - 清理：`POST /api/totp/enable` 验证通过落盘后、超过 `MINI_APP_TOTP_PENDING_TTL_MS` 过期淘汰时，
 *   或 `stopMiniAppServer` 停止服务时置回 `null`。
 * - 容量与重建：恒为单个待确认会话对象（新生成覆盖旧项）；与 Worker 崩溃无关，进程重启后从 `null` 开始。
 */
export const miniAppPendingTotpSetupHolder: {
  current: Readonly<MiniAppPendingTotpSetup> | null;
} = { current: null };

/**
 * 按需一次性物化的 Mini App 前端入口 HTML 与本地打包静态资源只读快照句柄。
 * - 填充：首次收到通过超级管理员门禁核验的单页或打包资源请求时，由 `materializeBundledMiniAppAssets`
 *   启动短暂本地回环实例提取 `Bun.HTMLBundle` 后写入。
 * - 清理：`stopMiniAppServer` 停止服务时置回 `null`。
 * - 容量与重建：恒为单个只读快照对象，单次服务运行期内不可变、不淘汰；与 Worker 崩溃无关，进程重启后从 `null` 按需物化。
 */
export const miniAppBundledAssetsHolder: {
  current: Readonly<BundledMiniAppAssets> | null;
} = { current: null };

/**
 * 正在物化 Mini App 前端打包资源的在途异步任务句柄（并发首次访问共享同一物化过程）。
 * - 填充：`materializeBundledMiniAppAssets` 在 `miniAppBundledAssetsHolder.current` 为 `null` 且无在途任务时写入。
 * - 清理：该次物化任务结算的 `finally` 分支及 `stopMiniAppServer` 停止服务时置回 `null`。
 * - 容量与重建：恒为单个在途 `Promise`，不设队列淘汰；与 Worker 崩溃无关，进程重启后从 `null` 开始。
 */
export const miniAppBundledAssetsPromiseHolder: {
  current: Promise<Readonly<BundledMiniAppAssets> | null> | null;
} = { current: null };

/**
 * 按需一次性加载并按唯一 `<body>` 标签预切分的独立未授权拒绝页（`MINI_APP_REJECT_HTML_PATH`）静态模板句柄。
 * - 填充：首次收到非 `HEAD` 的未授权单页请求时，由 `serveMiniAppRejectHtml` 从磁盘读取并预切分为 `{ head, tail }` 后写入。
 * - 清理：`stopMiniAppServer` 停止服务时置回 `null`。
 * - 容量与重建：恒为单个只读模板切片对象，单次服务运行期内不变、不淘汰；与 Worker 崩溃无关，进程重启后从 `null` 按需读取。
 */
export const miniAppRejectHtmlHolder: {
  current: Readonly<MiniAppRejectHtmlTemplate> | null;
} = { current: null };

/**
 * 谷歌验证器（TOTP）启用与删除写入操作的进程内单链串行尾节点句柄（经 `libs/serialChain.ts` 的 `runSerialChain` 读写），保证磁盘 `totp.json` 与内存 `miniAppTotpRecordHolder` 变更严格同序。
 * - 填充：调用 `enableMiniAppTotpFromPending` 或 `deleteMiniAppTotpRecord` 时把 `current` 推进到本次变更吸收结果与异常后的链尾。
 * - 清理：链尾随本次任务结算自然兑现，句柄只保留当前尾节点（`stopMiniAppServer` 后不再入队，已在途项自行结束）。
 * - 容量与重建：恒为单个尾节点 Promise（无队列蓄积溢出风险）；与 Worker 崩溃无关，进程重启后从已兑现的空 Promise 开始，不设额外淘汰策略。
 */
export const miniAppTotpMutationChainHolder: {
  current: Promise<void>;
} = { current: Promise.resolve() };

/**
 * 主线程内存中的 Mini App 60 秒一次性图库文件下载票据缓存（键为 64 位十六进制 `ticket`）。
 * - 填充：`POST /api/gallery/download-ticket` 在当前活跃会话鉴权通过后写入并绑定已提交会话的 `sessionLineageId`（跨滑动轮换保持有效）。
 * - 清理：`GET /api/gallery/download?ticket=` 首次成功读取时即刻消费删除；超过 `MINI_APP_DOWNLOAD_TICKET_TTL_MS` 过期、
 *   关联会话谱系登出/超时过期/满额淘汰/TOTP 验证器变更/IV 超限/防爆破锁定、目标文件被删除，或 `stopMiniAppServer` / `clearAllMiniAppAuthSessions` 时清理。
 * - 容量与重建：受限于 `MINI_APP_DOWNLOAD_TICKET_MAX` 的有界 `FifoMap`（写前先清过期，满容按 FIFO 淘汰最早条目）；
 *   与 Worker 崩溃无关，进程重启后从空缓存开始。
 */
export const miniAppGalleryDownloadTickets: FifoMap<
  string,
  Readonly<MiniAppGalleryDownloadTicketRecord>
> = new FifoMap<string, Readonly<MiniAppGalleryDownloadTicketRecord>>(
  MINI_APP_DOWNLOAD_TICKET_MAX
);

/**
 * 最近一次已成功签发会话所消费的 TOTP 步进窗记录句柄（防止同一步进窗内的 6 位动态码被二次重放）。
 * - 填充：`POST /api/auth/login` 在 TOTP 校验通过且 `issueMiniAppAuthSession` 签发会话后写入 `{ secret, counter }`
 *   （`409` 会话槽位满额拒绝时不写入，避免误伤有效动态码）。
 * - 清理：删除验证器、重设新验证器密钥（`enableMiniAppTotpFromPending`）、`resetMiniAppTotpMemoryCache` 或 `stopMiniAppServer` 时置回 `null`。
 * - 容量与重建：恒为单个只读 `{ secret, counter }` 对象；与 Worker 崩溃无关，进程重启后从 `null` 开始。
 */
export const miniAppLastConsumedTotpStepHolder: {
  current: Readonly<MiniAppConsumedTotpStep> | null;
} = { current: null };
