/** owner: workers/diskIO。SQLite 连接、预编译语句与业务表未提交写缓冲（packages/workers/diskIO/storageDatabase/）。 */

import { closeStorageDatabase } from "../../../database/interact/connection";
import { StorageWriteBudget } from "../../../libs/storageWriteBudget";
import type {
  BudgetedStorageDomain,
  IdentityPersistenceReply,
  StorageDatabaseDomain,
} from "../../../types/diskIO/replies";
import type {
  StorageDatabase,
  StorageDatabaseReader,
  StorageDatabaseWriter,
  StoredIdentityIdLookups,
} from "../../../types/storageDatabase";
import type {
  PendingAiContextWrite,
  PendingChatQaWrite,
  PendingChatStateWrite,
  PendingIdentityPolicyWrite,
  PendingRemovalWrite,
  RemovalRowTargets,
} from "../../../types/identityStorage";
import type { PendingTemporaryAdBypassWrite } from
  "../../../types/temporaryAdBypass";

/** 各领域（BudgetedStorageDomain）未提交写入的条数与字节预算表：写入前预约，事务提交成功或 resetStoragePendingBudgets 时清空；固定每领域一项，Worker 重建后随主线程重放重新预约。 */
export const storagePendingBudgets: Readonly<Record<BudgetedStorageDomain, StorageWriteBudget>> = {
  whitelist: new StorageWriteBudget(),
  blocklist: new StorageWriteBudget(),
  temporaryAdBypass: new StorageWriteBudget(),
  blocklistRemovalOutbox: new StorageWriteBudget(),
  chatState: new StorageWriteBudget(),
  chatQa: new StorageWriteBudget(),
};

/** 清空全部受预算控制领域的未提交写入预算。 */
export function resetStoragePendingBudgets(): void {
  for (const budget of Object.values(storagePendingBudgets)) budget.reset();
}

/** SQLite 事务连续失败次数、下次重试时间戳与致命错误已通知标记：事务成功或 resetStorageDatabaseCache 时归零，达到失败上限时调用 storageWriteFatalReply。 */
export const storageWriteRetry: { failures: number; retryAt: number; signaled: boolean } = {
  failures: 0, retryAt: 0, signaled: false,
};

/** SQLite 写入持续失败或容量致命错误的通知回调单例：Disk I/O Worker 启动时安装，isolate 销毁时释放。 */
export const storageWriteFatalReply: { current: (() => void) | null } = { current: null };

/** SQLite 连接对象到名单主键存在性预编译查询语句的 WeakMap：首次校验互斥名单时创建，连接关闭或替换后随 GC 回收；每条活跃连接一项，Worker 重建后按新连接重新创建。 */
export const storedIdentityIdLookups: WeakMap<
  StorageDatabase,
  StoredIdentityIdLookups
> = new WeakMap<StorageDatabase, StoredIdentityIdLookups>();

/** SQLite 连接对象到统一事务提交预编译写语句的 WeakMap：首次提交事务时创建，连接关闭或替换后随 GC 回收；每条活跃连接一项，Worker 重建后按新连接重新创建。 */
export const storageDatabaseWriters: WeakMap<
  StorageDatabase,
  StorageDatabaseWriter
> = new WeakMap<StorageDatabase, StorageDatabaseWriter>();

/** SQLite 连接对象到预热与分页读取预编译读语句的 WeakMap：首次读取时创建，连接关闭或替换后随 GC 回收；每条活跃连接一项，Worker 重建后按新连接重新创建。 */
export const storageDatabaseReaders: WeakMap<
  StorageDatabase,
  StorageDatabaseReader
> = new WeakMap<StorageDatabase, StorageDatabaseReader>();

/** SQLite 事务提交后的持久化回执发送回调单例：Disk I/O Worker 启动时填充，isolate 销毁时释放。 */
export const storagePersistenceReplyHolder: {
  current: IdentityPersistenceReply | null;
} = { current: null };

/** 当前 Disk I/O Worker 持有的 SQLite 连接句柄单例：启动恢复 adopt 时填充，关库或 resetStorageDatabaseCache 时关闭并置为 null，Worker 重建后重新打开。 */
export const storageDatabaseHandle: { current: StorageDatabase | null } = {
  current: null,
};

/** SQLite 连接是否已执行停机关库的标记：closeStorage 时置为 true（此后忽略身份写入并停止事务提交），resetStorageDatabaseCache 或 Worker 重建后恢复为 false；单例布尔值。 */
export const storageDatabaseClosed: { current: boolean } = { current: false };

/** 白名单未提交写入表（主键 ID -> 最新写入）：消息到达时覆盖（满 IDENTITY_WRITE_BATCH_MAX_ENTRIES 触发事务），事务提交成功或 resetStorageDatabaseCache 时清空；容量受 whitelist 领域写预算约束，Worker 重建后由主线程重放未确认写入。 */
export const pendingWhitelistWrites: Map<number, PendingIdentityPolicyWrite> = new Map();

/** 黑名单未提交写入表（主键 ID -> 最新写入）：填充、满批触发、提交清空与 Worker 重建重放同 pendingWhitelistWrites。 */
export const pendingBlocklistWrites: Map<number, PendingIdentityPolicyWrite> = new Map();

/** 临时广告免检未提交写入表（身份 ID -> 合并后最新写入）：消息到达时按身份合并（满 IDENTITY_WRITE_BATCH_MAX_ENTRIES 触发事务），事务提交成功或 resetStorageDatabaseCache 时清空；Worker 重建后由主线程重放未确认写入。 */
export const pendingTemporaryAdBypassWrites: Map<
  number,
  PendingTemporaryAdBypassWrite
> = new Map();

/** 黑名单待踢 outbox 未提交写入表（removalId -> 最新行写入）：填充、满批触发、提交清空与 Worker 重建重放同 pendingWhitelistWrites。 */
export const pendingRemovalWrites: Map<number, PendingRemovalWrite> = new Map();

/** 群状态未提交写入表（chatId -> 最新群状态写入）：消息到达时覆盖（达 STATE_MANAGED_CHAT_LIMIT 群时触发事务），事务提交成功或 resetStorageDatabaseCache 时清空；Worker 重建后由主线程重放未确认写入。 */
export const pendingChatStateWrites: Map<number, PendingChatStateWrite> = new Map();

/** 群问答未提交写入表（chatId -> question -> 最新写入或删除墓碑）：消息到达时覆盖，事务提交成功或 resetStorageDatabaseCache 时清空；容量受 chatQa 领域写预算约束，Worker 重建后由主线程重放未确认写入。 */
export const pendingChatQaWrites: Map<number, Map<string, PendingChatQaWrite>> = new Map();

/** pendingChatQaWrites 的内层条目总数：新增（chatId, question）键时递增，事务提交清空或 resetStorageDatabaseCache 时归零；单例标量，Worker 重建后从零重新累计。 */
export const pendingChatQaEntryCount: { current: number } = { current: 0 };

/** AI 上下文未提交写入表（chatId -> 最新快照或删除）：aiMemoryStorage.ts 按 revision 校验通过后覆盖，事务提交成功或 resetStorageDatabaseCache 时清空；容量上限为 AI_MEMORY_MAX_CHATS，Worker 重建后由主线程重放最新快照与未确认删除。 */
export const pendingAiContextWrites: Map<number, PendingAiContextWrite> = new Map();

/** 已受理（含已提交与未提交）待踢任务行的目标快照表（removalId -> RemovalRowTargets）：启动 adoptStorageDatabase 从 SQLite 灌入，运行期随 blocklistRemovalWrite 增删，resetStorageDatabaseCache 时清空；容量上限为 BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES，Worker 重建后从 SQLite 与主线程重放恢复。 */
export const removalRowTargets: Map<number, RemovalRowTargets> = new Map();

/** Worker 重建后主线程镜像重放期间的事务提交暂缓开关：收到 storageFlushHold 消息时切换，为 true 时暂缓满批、定时与即时提交；Worker 重建或 resetStorageDatabaseCache 时恢复为 false。 */
export const storageFlushHold: { current: boolean } = { current: false };

/** 未提交写入的定时事务刷盘 timer 单例（间隔 IDENTITY_WRITE_FLUSH_INTERVAL_MS）：首条未提交写入到达时启动，事务提交或 resetStorageDatabaseCache 时清除；Worker 重建后从 null 开始。 */
export const storageWriteFlushTimer: {
  current: ReturnType<typeof setTimeout> | null;
} = { current: null };

/** 本轮发生过写入拒收的 SQLite 领域集合：写入被拒时加入，对应领域或全量 flush 读取后清除，resetStorageDatabaseCache 时清空；容量上限为 StorageDatabaseDomain 枚举数，Worker 重建后从空集开始。 */
export const rejectedStorageDomains: Set<StorageDatabaseDomain> = new Set();

/** 关闭当前 SQLite 连接、取消定时刷盘 timer 并清空全部未提交写缓冲与预算状态。 */
export function resetStorageDatabaseCache(): void {
  resetStoragePendingBudgets();
  storageWriteRetry.failures = 0;
  storageWriteRetry.retryAt = 0;
  storageWriteRetry.signaled = false;
  if (storageDatabaseHandle.current !== null) {
    closeStorageDatabase(storageDatabaseHandle.current);
  }
  storageDatabaseHandle.current = null;
  storageDatabaseClosed.current = false;
  pendingWhitelistWrites.clear();
  pendingBlocklistWrites.clear();
  pendingTemporaryAdBypassWrites.clear();
  pendingRemovalWrites.clear();
  pendingChatStateWrites.clear();
  pendingChatQaWrites.clear();
  pendingChatQaEntryCount.current = 0;
  pendingAiContextWrites.clear();
  removalRowTargets.clear();
  rejectedStorageDomains.clear();
  storageFlushHold.current = false;
  if (storageWriteFlushTimer.current !== null) {
    clearTimeout(storageWriteFlushTimer.current);
    storageWriteFlushTimer.current = null;
  }
}
