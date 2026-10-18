/** owner: main。机器人自身权限现查的协调状态（packages/infra/botAdmin.ts）；权限快照保存在
 * cache/main/chatState.ts 的 ChatState.botPermissions。 */

import type { BotChatPermissions } from "../../types/telegram";

/**
 * 各群在途的 getChatMember 权限现查 Promise，同群并发判定复用同一请求。
 * 填充：发起现查时写入。清理：请求结算或身份令牌失效（`/init` 切换、停管、主动失效）时删除。
 * 容量上界为 STATE_MANAGED_CHAT_LIMIT，不设淘汰；进程重启后从空表开始。
 */
export const botPermissionFetches: Map<number, Promise<BotChatPermissions | undefined>> = new Map();

/**
 * 各群在途权限现查的身份令牌；请求回填快照前核对令牌一致，失效时连同 botPermissionFetches 一并删除。
 * 填充、清理与容量同 botPermissionFetches。
 */
export const botPermissionRequestTokens: Map<number, symbol> = new Map();

/**
 * 各群权限现查的退避截止时刻（窗口长度 BOT_PERMISSION_PROBE_RETRY_MS）。
 *
 * 填充：admitBotPermissionProbe 每次放行现查前写入。
 * 清理：recordBotChatPermissions 记下确证快照或 forgetBotChatPermissions 失效时删除，
 * 过期条目在下次探测时覆盖。容量上界为 STATE_MANAGED_CHAT_LIMIT；进程重启后从空表开始。
 */
export const botPermissionProbeBackoff: Map<number, number> = new Map();

/**
 * 权限变更的下游广播回调单槽位，启动时由 packages/antiRaid/workerBridge/observers.ts 注入。
 * 确证权限或撤管理员时传入具体快照，离群、`/init` 切换或主动失效时传入 undefined（镜像语义见
 * cache/workers/antiRaid/botPermissions.ts）。容量恒为一个回调，进程重启后从 null 开始。
 */
export const botPermissionObserver: {
  current: ((chatId: number, permissions: BotChatPermissions | undefined) => void) | null;
} = { current: null };
