/** owner: main。Mini App HTTP 服务实例、运行时配置镜像、密码认证会话、预备选择器会话与结果回执缓存（packages/miniApp/）。 */

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
  MiniAppPickerResultEvent,
  MiniAppPreparedPickerSession,
} from "../../types/miniApp";
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
 * 清理：`stopMiniAppServer` 停止服务时置回 `null`。
 * 容量恒为单个只读配置对象；与 Worker 崩溃无关，进程重启后从 `null` 重新按 `bot.json` 填充。
 */
export const miniAppActiveConfigHolder: {
  current: Readonly<BotMiniAppConfig> | null;
} = { current: null };

/**
 * 已通过访问密码认证的超级管理员 45 分钟会话令牌表（键为 64 位十六进制 `token`）。
 * 填充：`POST /api/auth/login` 校验 `initData` 与访问密码均通过后签发写入。
 * 清理：每次鉴权或新签发时按 `MINI_APP_SESSION_TTL_MS`（45 分钟）清理过期项，`stopMiniAppServer` 清空。
 * 容量上界为 `MINI_APP_SESSION_MAX`（8 条），超出时由 `FifoMap` 按插入顺序淘汰最早会话；与 Worker 崩溃无关，进程重启后从空表开始。
 */
export const miniAppAuthSessions: FifoMap<string, Readonly<MiniAppAuthSession>> =
  new FifoMap<string, Readonly<MiniAppAuthSession>>(MINI_APP_SESSION_MAX);

/**
 * 超级管理员 ID 连续输错 Mini App 访问密码的计数与 30 分钟锁定状态句柄。
 * 填充：`POST /api/auth/login` 密码校验失败时累加 `failedAttempts`，达到 `MINI_APP_PASSWORD_MAX_ATTEMPTS`（3 次）时写入 `lockedUntil`。
 * 清理：密码校验通过、锁定期满 30 分钟后自动归零，或 `stopMiniAppServer` 停止服务时置回 `null`。
 * 容量恒为单个只读状态对象（仅绑定 `SUPER_ADMIN_USER_ID`）；与 Worker 崩溃无关，进程重启后从 `null` 开始。
 */
export const miniAppPasswordGuardHolder: {
  current: Readonly<MiniAppPasswordGuardState> | null;
} = { current: null };

/**
 * `savePreparedKeyboardButton` 预备选择器请求的自增序号（循环限制在 32 位正有符号整数区间 `1..0x7fffffff`）。
 * 填充：每次通过 `prepareMiniAppPicker` 创建预备按钮时递增。
 * 清理：`stopMiniAppServer` 重置为 `0`。
 * 容量恒为单个数值；与 Worker 崩溃无关，进程重启后从 `0` 开始。
 */
export const miniAppPickerSequence: {
  current: number;
} = { current: 0 };

/**
 * 待超级管理员在 Telegram WebApp 选择器中确认的预备会话表（键为 `request_id`）。
 * 填充：`prepareMiniAppPicker` 调用 `savePreparedKeyboardButton` 成功后写入。
 * 清理：收到对应的 `users_shared` / `chat_shared` 服务消息消费后删除，每次写入或读取前按 `MINI_APP_PICKER_TTL_MS` 清理过期项，`stopMiniAppServer` 清空。
 * 容量上界为 `MINI_APP_PICKER_MAX_PENDING`（32 条），超出时由 `FifoMap` 按插入顺序淘汰最早条目；与 Worker 崩溃无关，进程重启后从空表开始。
 */
export const miniAppPendingPickers: FifoMap<number, Readonly<MiniAppPreparedPickerSession>> =
  new FifoMap<number, Readonly<MiniAppPreparedPickerSession>>(MINI_APP_PICKER_MAX_PENDING);

/**
 * 已处理完成的 `users_shared` / `chat_shared` 选择导入结果回执表（键为 `request_id`）。
 * 填充：私聊收到 `users_shared` / `chat_shared` 完成名单写入后记录。
 * 清理：每次写入或读取前按 `MINI_APP_PICKER_TTL_MS` 清理过期项，`stopMiniAppServer` 清空。
 * 容量上界为 `MINI_APP_PICKER_MAX_RESULTS`（32 条），超出时由 `FifoMap` 按插入顺序淘汰最早条目；与 Worker 崩溃无关，进程重启后从空表开始。
 */
export const miniAppCompletedPickerResults: FifoMap<number, Readonly<MiniAppPickerResultEvent>> =
  new FifoMap<number, Readonly<MiniAppPickerResultEvent>>(MINI_APP_PICKER_MAX_RESULTS);

/**
 * 主线程内存中缓存的当前已启用谷歌验证器（TOTP）单实例记录镜像（`undefined` 表示尚未完成首次读盘加载，`null` 表示已确认未绑定验证器）。
 * 填充：启动阶段 `loadState`（或首次调用 `loadMiniAppTotpRecord`）读取 `memory/mini-app-totp/totp.json` 后写入，或在前端控制台调用 `POST /api/totp/enable` 绑定成功后立即更新。
 * 清理：在前端控制台调用 `DELETE /api/totp` 删除验证器时置为 `null`；`stopMiniAppServer` 或测试重置时置回 `undefined`。
 * 容量恒为单个只读记录对象（最多 1 个验证器）；与 Worker 崩溃无关，进程重启后从磁盘文件重新加载。
 */
export const miniAppTotpRecordHolder: {
  current: Readonly<MiniAppTotpRecord> | null | undefined;
} = { current: undefined };

/**
 * 主线程在前端控制台发起“生成/修改验证器”后暂存的待扫码确认 TOTP 密钥句柄。
 * 填充：`POST /api/totp/setup` 生成随机 Base32 密钥与二维码时写入。
 * 清理：`POST /api/totp/enable` 验证通过落盘后、超过 10 分钟 `MINI_APP_TOTP_PENDING_TTL_MS` 过期淘汰时，或 `stopMiniAppServer` 停止服务时置回 `null`。
 * 容量恒为单个待确认会话对象（新生成自动覆盖旧待确认项）；与 Worker 崩溃无关，进程重启后从 `null` 开始。
 */
export const miniAppPendingTotpSetupHolder: {
  current: Readonly<MiniAppPendingTotpSetup> | null;
} = { current: null };
