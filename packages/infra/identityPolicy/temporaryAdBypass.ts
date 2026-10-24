import { assertStorageAdmission } from "../diskIO/storageAdmission";
import { canQueueDiskIOBusiness } from "../diskIO/transport";
import { storageWriteCost } from "../../libs/storageWriteBudget";
import { identityPolicyCache } from "../../cache/main/identityStorage";
import {
  temporaryAdBypassWriteRevision,
  unacknowledgedTemporaryAdBypassWrites,
} from "../../cache/main/temporaryAdBypass";
import { DISK_IO_RESPAWN_PRIORITIES } from "../../consts/diskIO/common";
import { assertTemporaryAdBypassActivity } from "../../database/codec/temporaryAdBypass";
import { assertTelegramIdentityId } from "../../database/codec/identity";
import { logger } from "../logger";
import * as diskIO from "../diskIO";
import {
  advanceTemporaryAdBypassActivity,
  isTemporaryAdBypassActive,
  isTemporaryAdBypassActivityRetained,
} from "../../states/temporaryAdBypass";
import type {
  DiskIORecoveryTransport,
  TemporaryAdBypassWriteDiskMessage,
} from "../../types/diskIO/messages";
import type { IdentityStoragePersistedReply } from "../../types/diskIO/replies";
import type { IdentityPolicyCacheEntry } from "../../types/identityStorage";
import type {
  StoredTemporaryAdBypassActivity,
  UnacknowledgedTemporaryAdBypassWrite,
} from "../../types/temporaryAdBypass";
import type { TemporaryAdBypassActivity } from "../../types/states/temporaryAdBypass";

/**
 * 查询墙钟当前时刻仍有效的临时广告免检成员关系。只在缓存确有免检记录时才读墙钟，负缓存与
 * 未获免检的常态查询不取时钟；调用方已捕获时刻时改用 hasActiveTemporaryAdBypassAt。
 *
 * @param id 待查询的用户或频道身份 ID。
 * @returns 当前时刻拥有有效临时广告免检资格时返回 `true`，否则返回 `false`。
 */
export function hasActiveTemporaryAdBypass(id: number): boolean {
  const activity: Readonly<TemporaryAdBypassActivity> | null | undefined =
    identityPolicyCache.get(id)?.temporaryAdBypass;
  if (!activity?.adBypass) return false;
  return isTemporaryAdBypassActive(activity, Date.now());
}

/**
 * 使用同一消息已经捕获的墙钟值查询临时广告免检成员关系。
 *
 * @param id 待查询的用户或频道身份 ID。
 * @param now 已捕获的当前墙钟毫秒时间戳。
 * @returns 在指定时刻拥有有效临时广告免检资格时返回 `true`，否则返回 `false`。
 */
export function hasActiveTemporaryAdBypassAt(
  id: number,
  now: number
): boolean {
  const activity: Readonly<TemporaryAdBypassActivity> | null | undefined =
    identityPolicyCache.get(id)?.temporaryAdBypass;
  if (!activity?.adBypass) return false;
  return isTemporaryAdBypassActive(activity, now);
}

/**
 * 校验批量读取回执里的临时累计行，按 id 收成表；行 id 必须在本次请求内且不重复。
 * 叠加未 ACK 最终值见 currentTemporaryAdBypassActivity；写缓存由预热循环整条完成
 * （infra/identityStorage/read.ts）。
 *
 * @param rows Disk I/O Worker 返回的临时广告免检累计行列表。
 * @param requested 本次请求查询的身份 ID 只读集合。
 * @returns 校验通过的按身份 ID 索引的临时累计只读映射。
 */
export function storedTemporaryAdBypassActivities(
  rows: readonly StoredTemporaryAdBypassActivity[],
  requested: ReadonlySet<number>
): ReadonlyMap<number, Readonly<TemporaryAdBypassActivity>> {
  const stored: Map<number, Readonly<TemporaryAdBypassActivity>> = new Map();
  for (const row of rows) {
    assertTelegramIdentityId(row.id, "temporary ad bypass read reply");
    if (!requested.has(row.id) || stored.has(row.id)) {
      throw new Error(
        `Disk I/O returned an unexpected or duplicate temporary ad bypass identity ${row.id}.`
      );
    }
    assertTemporaryAdBypassActivity(
      row,
      `temporary_ad_bypass_entries[${row.id}]`
    );
    stored.set(row.id, {
      adBypass: row.adBypass,
      adBypassGrantedAt: row.adBypassGrantedAt,
      qualifiedDays: row.qualifiedDays,
      sendCount: row.sendCount,
      countedAt: row.countedAt,
      qualifiedAt: row.qualifiedAt,
    });
  }
  return stored;
}

/**
 * 本地未 ACK 最终值覆盖数据库迟到值后的当前临时累计；都没有时为 null（确证不存在）。
 *
 * @param id 目标用户或频道身份 ID。
 * @param stored 从数据库读取并校验后的临时累计映射。
 * @returns 叠加本地未确认写入后的当前临时累计记录；确证无记录时返回 `null`。
 */
export function currentTemporaryAdBypassActivity(
  id: number,
  stored: ReadonlyMap<number, Readonly<TemporaryAdBypassActivity>>
): Readonly<TemporaryAdBypassActivity> | null {
  const pending: UnacknowledgedTemporaryAdBypassWrite | undefined =
    unacknowledgedTemporaryAdBypassWrites.get(id);
  return pending === undefined ? stored.get(id) ?? null : pending.activity;
}

/**
 * 把临时累计最终值写进合并身份缓存的该字段并刷新热度；条目不存在时建三字段条目，其余两项为未加载。
 *
 * @param id 目标用户或频道身份 ID。
 * @param activity 待写入缓存的临时广告免检累计记录（`null` 表示墓碑/确证不存在）。
 */
function cacheTemporaryAdBypassActivity(
  id: number,
  activity: Readonly<TemporaryAdBypassActivity> | null
): void {
  const entry: IdentityPolicyCacheEntry | undefined = identityPolicyCache.get(id);
  if (entry === undefined) {
    identityPolicyCache.set(id, { whitelist: undefined, blocklist: undefined, temporaryAdBypass: activity });
  } else {
    entry.temporaryAdBypass = activity;
  }
}

/**
 * 发布一次临时累计最终值（activity 为 null 表示墓碑）。非墓碑只来自
 * recordTemporaryAdBypassActivity，它在主键已预热时才推进累计。
 *
 * @param id 目标用户或频道身份 ID。
 * @param activity 待持久化的临时累计记录，`null` 表示删除该记录。
 * @returns 已立即投递给 Disk I/O Worker 时返回 `true`，暂存等待重放时返回 `false`。
 */
function queueTemporaryAdBypassWrite(
  id: number,
  activity: Readonly<TemporaryAdBypassActivity> | null
): boolean {
  assertTelegramIdentityId(id, "temporary ad bypass write");
  if (activity !== null) {
    assertTemporaryAdBypassActivity(activity, `temporary_ad_bypass_entries[${id}]`);
  }
  if (!Number.isSafeInteger(temporaryAdBypassWriteRevision.current + 1)) {
    throw new Error("Temporary ad bypass revision space is exhausted.");
  }
  const revision: number = temporaryAdBypassWriteRevision.current + 1;
  const message: TemporaryAdBypassWriteDiskMessage = { type: "temporaryAdBypassWrite", id, activity, revision };
  const entries: number = unacknowledgedTemporaryAdBypassWrites.size +
    (unacknowledgedTemporaryAdBypassWrites.has(id) ? 0 : 1);
  assertStorageAdmission(entries, entries * storageWriteCost(null));
  if (!canQueueDiskIOBusiness(message)) throw new Error("Disk I/O refused temporary ad bypass state publication.");
  temporaryAdBypassWriteRevision.current = revision;
  cacheTemporaryAdBypassActivity(id, activity);
  unacknowledgedTemporaryAdBypassWrites.set(id, { activity, revision });
  if (diskIO.postDiskIO(message)) return true;
  logger.error(
    `Failed to queue temporary ad bypass identity ${id}; retaining revision ${revision} for replay.`
  );
  return false;
}

/**
 * 计入一条已通过入口门禁的群发言；该主键未预热时返回 undefined，不创建记录。
 *
 * 临时累计与黑名单互斥（见 docs/cn/04-invariants.md）：黑名单项为已加载的记录或未加载
 * 时同样返回 undefined，只有确认不在黑名单的身份才推进累计。
 *
 * 状态机原样返回入参时没有新事实要落盘：跳过 revision 递增、缓存写、未 ACK
 * 记账与投递。本函数只 `peek`，不刷新条目热度，调用方须在同一条消息上先经
 * `hasActiveTemporaryAdBypassAt` 读过该主键，由那次 `get` 维持热度。投递失败由
 * queueTemporaryAdBypassWrite 记日志并保留未 ACK 最终值等待重放。
 *
 * @param id 发言者的用户或频道身份 ID。
 * @param now 当前墙钟毫秒时间戳，默认取 `Date.now()`。
 * @returns 计入后的最终累计；未计入时为 undefined。
 */
export function recordTemporaryAdBypassActivity(
  id: number,
  now: number = Date.now()
): Readonly<TemporaryAdBypassActivity> | undefined {
  const entry: IdentityPolicyCacheEntry | undefined = identityPolicyCache.peek(id);
  if (entry?.temporaryAdBypass === undefined || entry.blocklist !== null) return undefined;
  const current: Readonly<TemporaryAdBypassActivity> | null = entry.temporaryAdBypass;
  const activity: Readonly<TemporaryAdBypassActivity> =
    advanceTemporaryAdBypassActivity(current, now);
  if (activity !== current) queueTemporaryAdBypassWrite(id, activity);
  return activity;
}

/**
 * 删除整条临时累计：广告判定为 true、晋升永久白名单后与 /block 拉黑时调用；不存在时幂等成功。
 *
 * @param id 待清除临时广告免检累计的身份 ID。
 * @returns 本来确证不存在或删除墓碑已成功投递时返回 `true`，投递失败暂存待重放时返回 `false`。
 */
export function clearTemporaryAdBypassActivity(id: number): boolean {
  if (identityPolicyCache.peek(id)?.temporaryAdBypass === null) return true;
  // 删除不依赖旧值：缓存冷缺失时同样发布墓碑，并保留到 ACK。
  return queueTemporaryAdBypassWrite(id, null);
}

/**
 * 同 clearTemporaryAdBypassActivity，但持久化 Worker 拒收时抛出：广告判定 true 与拉黑必须先撤掉
 * 临时累计才能继续处置，拒收即中止本次处置。
 *
 * @param id 待强制清除临时广告免检累计的身份 ID。
 */
export function clearTemporaryAdBypassActivityOrThrow(id: number): void {
  if (clearTemporaryAdBypassActivity(id)) return;
  throw new Error(
    `Temporary ad bypass reset for identity ${id} was rejected by the persistence Worker.`
  );
}

/**
 * 根据 Disk I/O 落盘回执按 revision 销账已确认持久化的临时广告免检写入。
 *
 * @param reply Disk I/O Worker 返回的身份存储落盘确认回执。
 */
function settleTemporaryAdBypassWrites(reply: IdentityStoragePersistedReply): void {
  for (const persisted of reply.temporaryAdBypassWrites) {
    if (
      unacknowledgedTemporaryAdBypassWrites.get(persisted.id)?.revision ===
      persisted.revision
    ) {
      unacknowledgedTemporaryAdBypassWrites.delete(persisted.id);
    }
  }
}

/**
 * 在 Disk I/O Worker 重建恢复期间按 revision 升序重放未确认的临时广告免检写入。
 *
 * @param transport 当前恢复代际的受限传输通道。
 * @returns 全部未确认写入均被接受时返回 `true`，任一投递失败时返回 `false`。
 */
function replayTemporaryAdBypassWrites(transport: DiskIORecoveryTransport): boolean {
  const now: number = Date.now();
  const writes: readonly (readonly [number, UnacknowledgedTemporaryAdBypassWrite])[] =
    [...unacknowledgedTemporaryAdBypassWrites.entries()].sort(
      (
        left: readonly [number, UnacknowledgedTemporaryAdBypassWrite],
        right: readonly [number, UnacknowledgedTemporaryAdBypassWrite]
      ): number => left[1].revision - right[1].revision
    );
  for (const [id, change] of writes) {
    const activity: Readonly<TemporaryAdBypassActivity> | null =
      change.activity !== null &&
        isTemporaryAdBypassActivityRetained(change.activity, now)
        ? change.activity
        : null;
    if (activity !== change.activity) {
      const normalized: UnacknowledgedTemporaryAdBypassWrite = {
        activity,
        revision: change.revision,
      };
      unacknowledgedTemporaryAdBypassWrites.set(id, normalized);
      cacheTemporaryAdBypassActivity(id, activity);
    }
    if (!transport.post({
      type: "temporaryAdBypassWrite",
      id,
      activity,
      revision: change.revision,
    } satisfies TemporaryAdBypassWriteDiskMessage)) return false;
  }
  return true;
}

diskIO.onDiskIOReply("identityStoragePersisted", settleTemporaryAdBypassWrites);
diskIO.onDiskIORespawn(
  "temporary ad bypass",
  DISK_IO_RESPAWN_PRIORITIES.TEMPORARY_AD_BYPASS,
  replayTemporaryAdBypassWrites
);
