/** owner: main。Mini App HTTP 服务实例、按需物化前端产物快照、独立拒绝页模板、运行时配置镜像、二次认证会话、预备选择器会话与结果回执缓存（packages/mini-app-api-server/）。 */

import {
  MINI_APP_PICKER_MAX_PENDING,
  MINI_APP_PICKER_MAX_RESULTS,
  MINI_APP_SESSION_MAX,
} from "../../consts/miniApp";
import { FifoMap } from "../../libs/fifoMap";
import type { BotMiniAppConfig } from "../../types/config";
import type {
  MiniAppAuthSession,
  MiniAppPasswordGuardState,
} from "../../types/miniApp/auth";
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
 * 主线程当前激活的 Mini App 公网 URL 派生片段（`basePath` 与小写 `host`）。
 * 填充：`startMiniAppServer` 启动时与 `miniAppActiveConfigHolder` 同步由 `deriveMiniAppPublicUrlParts` 派生写入。
 * 清理：`stopMiniAppServer` 停止服务时与 `miniAppActiveConfigHolder` 同步重置为 `null`。
 * 容量恒为单个只读对象，不淘汰；与 Worker 崩溃无关，进程重启后从 `null` 重新按 `bot.json` 派生。
 */
export const miniAppActiveUrlPartsHolder: {
  current: Readonly<MiniAppPublicUrlParts> | null;
} = { current: null };

/**
 * 已通过二次认证（访问密码或 6 位 TOTP 动态码）的超级管理员会话令牌表（键为当前 64 位十六进制 `token`，每个会话占 1 个槽位）。
 * - 填充：`POST /api/auth/login` 校验 `initData` 与二次认证凭据（已启用谷歌验证器时为 6 位 TOTP 动态码，否则为访问密码）均通过后签发写入；
 *   携带有效令牌访问且距签发超过 `MINI_APP_SESSION_REFRESH_THRESHOLD_MS` 时删除旧键、签发新键插到最新端并顺延有效期，
 *   上一轮令牌保存在 `previousToken` 中供该宽限期内匹配。
 * - 清理：每次鉴权或新签发时按 `MINI_APP_SESSION_TTL_MS` 清理过期项；`POST /api/auth/logout` 删除当前会话；
 *   `POST /api/totp/enable`、`DELETE /api/totp` 与 `POST /api/totp/delete` 经 `revokeOtherMiniAppAuthSessions`
 *   吊销其余会话；登录失败锁定与 `stopMiniAppServer` 清空全表。
 * - 容量与重建：上限为 `MINI_APP_SESSION_MAX`，满额由 `FifoMap` 按插入（或最近刷新）顺序淘汰最早会话；
 *   与 Worker 崩溃无关，进程重启后从空表开始。
 */
export const miniAppAuthSessions: FifoMap<string, Readonly<MiniAppAuthSession>> =
  new FifoMap<string, Readonly<MiniAppAuthSession>>(MINI_APP_SESSION_MAX);

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
