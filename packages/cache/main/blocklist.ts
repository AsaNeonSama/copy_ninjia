/** owner: main。黑名单群级处置与补扫状态（packages/infra/blocklist/）；身份策略缓存与未 ACK 写入见
 * cache/main/identityStorage.ts。 */

import { createKeyedSerialTaskRunner } from "../../libs/keyedSerialTaskRunner";
import type { KeyedSerialTaskRunner } from "../../libs/keyedSerialTaskRunner";
import type {
  BlockedMemberRemover,
  BlocklistSweepPageState,
  BlocklistSweepRecord,
  BlocklistSweepSchedulerState,
  PendingBlockedRemoval,
} from "../../types/blocklist";
/**
 * 白名单变更与黑名单新增共用的主线程串行尾链（packages/infra/identityPolicy/coordination.ts）。
 * 每次调用追加一步，异常由尾链吸收；holder 仅保留当前尾节点，容量恒为一个 Promise，进程重启后从已决议 Promise 重建。
 */
export const protectedIdentityMutationQueue: { current: Promise<void> } = {
  current: Promise.resolve(),
};

/**
 * 黑名单处置的逐身份串行尾链（广告命中拉黑与 `/block enable`、`/block disable`）。
 * 仅经 blocklistIdentityMutationRunner 读写：任务入队时写入，结算后立即删除。
 * 容量等于当前在途处置的身份数，不设淘汰；进程重启后从空表重建。
 */
export const blocklistIdentityMutationQueues: Map<number, Promise<void>> = new Map();

/** blocklistIdentityMutationQueues 上的逐身份串行执行器。 */
export const blocklistIdentityMutationRunner: KeyedSerialTaskRunner<number> =
  createKeyedSerialTaskRunner(blocklistIdentityMutationQueues);

/**
 * 黑名单销号计数更新的主线程串行尾链（infra/blocklist/participantInvalid.ts）。
 * 每次带观测的 Anti-Raid 处置回执到达时追加一步，更新 `participantInvalidCount`；
 * holder 仅保留当前尾节点（单步持有回执 ID 页，上限 BLOCKLIST_SWEEP_PAGE_SIZE），结算后释放。
 * Worker 崩溃不影响，进程重启后从已决议 Promise 开始。
 */
export const blocklistParticipantInvalidQueue: { current: Promise<void> } = {
  current: Promise.resolve(),
};

/**
 * 已登记、尚未收到完成回执的黑名单待踢批次（removalId -> PendingBlockedRemoval）。
 *
 * 填充：启动恢复从 SQLite outbox 播种，运行期由 sweepBlockedMembers 与 claimBlockedJoiner 写入。
 * 清理：收到 `complete: true` 回执、`/block disable` 摘除最后一名目标用户、forgetChatBlocklistWork
 * 停管群，或同群旧补扫被新补扫取代时删除。Anti-Raid Worker 重建时全表重投。
 * 容量上限为 BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES，不按尝试次数淘汰。
 */
export const pendingBlockedRemovals: Map<number, PendingBlockedRemoval> = new Map();

/**
 * 仅在内存更新了诊断字段（attempts、lastFailure）、尚未随行写入发出的 removalId 集合。
 *
 * 填充：infra/blocklist/sweepRetryState.ts 的 updatePendingRemovalFailure 加入。
 * 清理：infra/blocklist/outbox.ts 的 queueBlocklistRemovalWrite 发出行写入或 hydrateBlocklist
 * 启动恢复时移除；投递前由 persistPendingBlockedRemovals 先刷出剩余项。
 * 容量不超过 pendingBlockedRemovals 条数；Worker 重建不影响，进程重启后从空集开始。
 */
export const unwrittenRemovalDiagnostics: Set<number> = new Set();

/** 待踢批次 removalId 单调发号器；启动恢复按已存最大主键初始化，主线程同步递增，容量为一个标量。 */
export const blocklistRemovalCounter: { current: number } = { current: 0 };

/**
 * 各群黑名单补扫进度（chatId -> BlocklistSweepRecord）。
 *
 * 填充：发起补扫时写入，收到回执时更新 sweptAt 或 nextRetryAt。
 * 清理：群 `/init disable`、机器人被撤管理员或离群时由 forgetChatBlocklistWork 删除；
 * requestBlocklistResweep 重置已完成的闩锁以触发重扫。
 * 容量上限为 STATE_MANAGED_CHAT_LIMIT，不设淘汰；进程重启后从空表重建。
 */
export const blocklistSweepState: Map<number, BlocklistSweepRecord> = new Map();

/**
 * 各补扫批次当前在途的游标页（removalId -> BlocklistSweepPageState）。
 *
 * 填充：首/续页投递前写入。清理：页失败、整轮完成、群停管、被新补扫取代或 Anti-Raid Worker
 * 重建重放时删除。容量不超过 STATE_MANAGED_CHAT_LIMIT，每群同时至多一页在途。
 */
export const blocklistSweepPages: Map<number, BlocklistSweepPageState> =
  new Map();

/**
 * 黑名单补扫重试的唯一调度 timer 状态（infra/blocklist/sweep.ts）。
 * 启动后按各群最近的 nextRetryAt 设定 timer，每次状态推进重算截止时间，停机 quiesce 时清除。
 * 容量恒为一个调度状态对象，进程重启后从初值重建。
 */
export const blocklistSweepSchedulerState: BlocklistSweepSchedulerState = {
  timer: null,
  scheduledAt: null,
  accepting: false,
  runSweep: null,
};

/** 未注册处置入口时的默认空实现。 */
const noBlockedMemberRemover: BlockedMemberRemover = (): Promise<number> => Promise.resolve(0);

/**
 * 黑名单处置投递入口单槽位；启动时由 packages/antiRaid/blocklistGuard.ts 注入，
 * 进程重启后从默认空实现开始，容量恒为一个函数。
 */
export const blockedMemberRemoverHolder: { current: BlockedMemberRemover } = {
  current: noBlockedMemberRemover,
};
