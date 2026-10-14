/** owner: workers/antiRaid。群类型的 Worker 侧镜像与按需反查状态（packages/workers/antiRaid/chatKind.ts）。 */

/**
 * chatId -> 是否为超级群的只读镜像。
 * 权威线程为主线程（packages/cache/main/antiRaid/chatKind.ts）；主线程在获知群类型时发送 `chatKind` 消息按群增量覆盖。
 * 清理：deactivateChat 或 Worker 停止时删除。
 * 重建与重放：Worker 崩溃重建时由主线程整表重放填充；进程冷启动镜像缺失时由执行侧调用 getChat 反查补齐。
 * 无条目含义：表示群类型未知而非普通群；仅在确证为 false 时按普通群踢人方法调用。
 * 容量：每个受管群至多一项，上限为 STATE_MANAGED_CHAT_LIMIT，不按容量淘汰。
 */
export const workerChatIsSupergroup: Map<number, boolean> = new Map();

/**
 * chatId -> 镜像缺失时按群复用的在途 getChat 请求 Promise。
 * 填充：发起反查时登记；清理：请求结算、镜像到达、群停管或 Worker 停止时删除；重建：Worker 重启后为空；容量：上限为 VERIFICATION_CHAT_KIND_FETCH_MAX。
 */
export const workerChatKindFetches: Map<
  number,
  Promise<boolean | undefined>
> = new Map();

/**
 * 已发出且尚未结算的 getChat 请求集合（含已从 workerChatKindFetches 摘除但仍在途的请求）。
 * 填充：发起请求时登记；清理：请求结算或 Worker 停止时移除；重建：Worker 重启后从空集合开始；容量：上限为 VERIFICATION_CHAT_KIND_FETCH_MAX。
 */
export const workerChatKindActiveFetches: Set<Promise<boolean | undefined>> = new Set();
