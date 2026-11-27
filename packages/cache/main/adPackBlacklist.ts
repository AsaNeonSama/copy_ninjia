/** owner: main。广告包黑名单 768 条 LRU 热查询缓存、条数统计、写串行链、未确认落盘写入表与下游广播观察者（packages/infra/adPackBlacklistStorage/）。 */

import { AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES } from "../../consts/identityStorage";
import { LruCache } from "../../libs/lruCache";
import type { SerialChainHolder } from "../../libs/serialChain";
import type {
  AdPackBlacklistKind,
  AdPackBlacklistMutationObserver,
  UnacknowledgedAdPackBlacklistWrite,
} from "../../types/adPackBlacklist";

/**
 * 广告贴纸包与自定义表情包黑名单的共享热查询 LRU 缓存（键为 `${kind}:${pack}`，值为正/负命中布尔值）：
 * - 填充：infra/adPackBlacklistStorage/read.ts 冷读 SQLite 回填，或 write.ts 新增/移除同步覆写；
 * - 清理：满额按 LRU 淘汰最久未用项（超出后重新打到 SQLite）；hydrate 或 `resetAdPackBlacklistCache` 时清空；
 * - 重建：进程重启后从空缓存起步，随检测与管理查询按需从 SQLite `ad_pack_blacklists` 回填；
 * - 容量与淘汰：固定容量 `AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES`（768），超出按 LRU 淘汰，不限制数据库总条数。
 */
export const adPackBlacklistCache: LruCache<string, boolean> =
  new LruCache<string, boolean>(AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES);

/**
 * 贴纸包与自定义表情包黑名单当前总条目数：
 * - 填充：启动时由 Disk I/O Worker 统计灌入，运行期随本地最终值增删同步增减；
 * - 清理：`resetAdPackBlacklistCache` 时归零；
 * - 重建：进程重启后从 SQLite `ad_pack_blacklists` 重新统计；
 * - 容量与淘汰：固定两个计数字段，不淘汰。
 */
export const adPackBlacklistCounts: { sticker: number; emoji: number } = {
  sticker: 0,
  emoji: 0,
};

/**
 * 广告包黑名单写前冷读与状态切换的单链串行句柄，防止并发写入同一冷键导致条数统计漂移：
 * - 填充：infra/adPackBlacklistStorage/write.ts 经 `runSerialChain` 串行推进；
 * - 清理：`resetAdPackBlacklistCache` 重置为已兑现空 Promise；
 * - 重建：进程重启后从初始空 Promise 起步；
 * - 容量与淘汰：单槽句柄，随任务结算自动释放。
 */
export const adPackBlacklistMutationChain: SerialChainHolder = {
  current: Promise.resolve(),
};

/**
 * 广告包黑名单未确认落盘写入表（`kind -> (pack -> 最新最终值与写入元数据)`）：
 * - 填充：写入或删除时登记，同一 `(kind, pack)` 连续修改时覆盖为最新 revision 与最终意图 `blacklisted`；
 * - 清理：收到匹配 revision 的 durable ACK 时移除，hydrate 或 `resetAdPackBlacklistCache` 时清空；
 * - 重建：Disk I/O Worker 崩溃重建时全表按 revision 升序重放（不依赖 LRU 驻留）；进程重启后从空表开始；
 * - 容量与淘汰：受 `STORAGE_PENDING_MAX_ENTRIES` 与 `STORAGE_PENDING_MAX_BYTES` 约束，超限拒绝新写入且不淘汰未确认条目。
 */
export const unacknowledgedAdPackBlacklistWrites: Readonly<
  Record<AdPackBlacklistKind, Map<string, UnacknowledgedAdPackBlacklistWrite>>
> = {
  sticker: new Map<string, UnacknowledgedAdPackBlacklistWrite>(),
  emoji: new Map<string, UnacknowledgedAdPackBlacklistWrite>(),
};

/**
 * 广告包黑名单未确认写入的总条数与估算字节总数：
 * - 填充：登记或覆盖未确认写入时按差额更新；
 * - 清理：收到精确 ACK 时扣减，hydrate 或 `resetAdPackBlacklistCache` 时清零；
 * - 重建：Disk I/O Worker 重建重放期间保留，进程重启后归零；
 * - 容量与淘汰：单例固定字段，无淘汰策略。
 */
export const unacknowledgedAdPackBlacklistTotals: { entries: number; bytes: number } = {
  entries: 0,
  bytes: 0,
};

/**
 * 广告包黑名单写入的单调递增 revision 发号器：
 * - 填充：每次提交写入或删除时递增；
 * - 清理：`resetAdPackBlacklistCache` 时重置为初始值 `1`；
 * - 重建：Disk I/O Worker 重建期间保留，进程重启后从 `1` 重新起算；
 * - 容量与淘汰：单例数值 holder，无淘汰策略。
 */
export const nextAdPackBlacklistRevision: { current: number } = { current: 1 };

/**
 * 广告包黑名单条数变更的下游广播回调单槽位，启动时由 `packages/antiRaid/workerBridge/observers.ts` 注入：
 * - 填充：通过 `registerAdPackBlacklistObserver` 写入回调；
 * - 清理：运行期不主动清理，测试或卸载时可置为 `null`；
 * - 重建：进程重启后从 `null` 开始；
 * - 容量与淘汰：恒为单个回调槽位，不设淘汰。
 */
export const adPackBlacklistObserver: { current: AdPackBlacklistMutationObserver | null } = {
  current: null,
};

/** 清空广告包黑名单 768 LRU 缓存、条数统计、未确认写入表、写串行链与 revision 发号器（测试隔离用）。 */
export function resetAdPackBlacklistCache(): void {
  adPackBlacklistCache.clear();
  adPackBlacklistCounts.sticker = 0;
  adPackBlacklistCounts.emoji = 0;
  adPackBlacklistMutationChain.current = Promise.resolve();
  unacknowledgedAdPackBlacklistWrites.sticker.clear();
  unacknowledgedAdPackBlacklistWrites.emoji.clear();
  unacknowledgedAdPackBlacklistTotals.entries = 0;
  unacknowledgedAdPackBlacklistTotals.bytes = 0;
  nextAdPackBlacklistRevision.current = 1;
}
