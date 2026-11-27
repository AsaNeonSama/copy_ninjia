/** owner: workers/antiRaid。广告检测流水线状态（packages/workers/antiRaid/adDetect/）。 */

import {
  AD_DETECT_CUSTOM_EMOJI_SET_CACHE_MAX,
  AD_DETECT_MAX_PENDING_SENDERS,
} from "../../../consts/antiRaid/adDetect/limits";
import { FifoMap } from "../../../libs/fifoMap";
import { LinkedQueue } from "../../../libs/linkedQueue";
import { LruCache } from "../../../libs/lruCache";
import type {
  AdDetectedEvent,
  AdDetectPrompts,
  AdDetectVisionSupportState,
  AdMessageBundle,
  AdVerdictTrueEvent,
  CachedCustomEmojiMeta,
} from "../../../types/antiRaid/adDetect";
import type { ReferencedAdWarningState } from "../../../types/states/adReferenceWarning";

/**
 * 待检发言者键（`chatId:senderId`）FIFO 队列，每个节拍取走队首至多 AD_DETECT_BATCH_SIZE 个。
 * 填充：新待检发言者入队时追加；清理：批次派发出队、停管或关开关按群摘键、Worker 停止时清空；重建：Worker 崩溃重启后从空队列开始；容量：由 queuedAdDetectKeys 去重，受 AD_DETECT_MAX_PENDING_SENDERS 约束。
 */
export const adDetectQueue: LinkedQueue<string> = new LinkedQueue<string>();

/**
 * 当前排在 adDetectQueue 中的发言者键集合，随队列入队登记、随出队同步删除。
 * 清理：派发出队、按群摘键或 Worker 停止时删除；重建：Worker 重启后从空集合开始；容量：上限为 AD_DETECT_MAX_PENDING_SENDERS，满载时拒收新键而不淘汰已有项。
 */
export const queuedAdDetectKeys: Set<string> = new Set<string>();

/**
 * 已判定为广告并触发处置的发言者键 -> Worker 单调时钟处置时刻（见 docs/cn/04-invariants.md）。
 * 填充：workers/antiRaid/adDetect/verdict.ts 的 detectOne 触发处置前写入。
 * 清理：满 AD_DETECT_JUDGED_RETENTION_WINDOW_MS 到期淘汰；主线程拒绝处置、完成本群处罚或未移交触发群全局封禁时经 releaseAdDetectDedup 提前删除；全局封禁取得确定结果时由 blocklistEffects 提前删除；身份进入白名单/临时免检或群停用时一并移除。
 * 重建：Worker 崩溃重启后从空表开始。
 * 容量：FifoMap 限制为 AD_DETECT_MAX_PENDING_SENDERS，满载时淘汰最早处置键。
 */
export const recentlyDisposedAdKeys: FifoMap<string, number> = new FifoMap(AD_DETECT_MAX_PENDING_SENDERS);

/**
 * 自定义表情 ID -> 所属表情包 short name 与可下载视觉素材标识（不属于任何表情包时 `setName` 为 null，无可用静态图或缩略图时 `visionFileId` 为 null），
 * 供自定义表情黑名单核对与多模态广告视觉检测共用。
 * 填充：workers/antiRaid/adDetect/blacklistFastPath.ts 的 resolveCustomEmojiMetadata 与 matchCustomEmojiBlacklistFastPath 经 fetchUncachedCustomEmojiMetadata 调用 `getCustomEmojiStickers` 成功后按返回的贴纸 `custom_emoji_id` 写入，对本批成功响应中缺省的 ID 写入全 null 负缓存；查询失败的批次不写入缓存。
 * 清理：Worker 停止时清空；ID 与所属包及视觉素材的对应不随 `ad_detect.json` 热重载变化，不另行失效。
 * 重建：Worker 崩溃重启后从空表开始。
 * 容量：LruCache 限制为 AD_DETECT_CUSTOM_EMOJI_SET_CACHE_MAX，满载时淘汰最久未使用的 ID。
 */
export const customEmojiMetaCache: LruCache<string, CachedCustomEmojiMeta> =
  new LruCache(AD_DETECT_CUSTOM_EMOJI_SET_CACHE_MAX);

/**
 * 当前 `agent.ad_detect` 模型是否支持多模态图片输入的探测缓存（`"unknown"` 未探测、`"supported"` 已确认支持、`"unsupported"` 已确认纯文本模型）。
 * 填充：workers/antiRaid/adDetect/classifier.ts 在带图请求成功时写入 `"supported"`，在收到明确模态不支持错误时写入 `"unsupported"` 供后续回退纯文本。
 * 清理：收到新的 `agent.ad_detect` 配置快照时（workers/antiRaid/adDetect/config.ts）或 Worker 停止时重置为 `"unknown"`。
 * 重建：Worker 崩溃重启后从 `"unknown"` 重新探测。
 * 容量：固定为单个状态槽位。
 */
export const adDetectVisionSupport: { current: AdDetectVisionSupportState } = { current: "unknown" };

/**
 * 引用类广告已公开警告的发送者键 -> 警告状态与失效时刻。
 * 填充：首次引用类广告警告发送成功后写入。
 * 清理：AD_REFERENCE_WARNING_WINDOW_MS 到期、群停管、关开关或 Worker 停止时清除。
 * 重建：Worker 崩溃重启后从空表开始。
 * 容量：FifoMap 限制为 AD_DETECT_MAX_PENDING_SENDERS，满载时淘汰最早警告记录。
 */
export const referencedAdWarningStates: FifoMap<string, ReferencedAdWarningState> =
  new FifoMap(AD_DETECT_MAX_PENDING_SENDERS);

/**
 * 引用类广告首次警告发送尝试的单调序号。
 * 填充：首次警告路径递增；清理与重建：群清理不回退，Worker 重启后归零；容量：固定为单个数值 holder。
 */
export const referencedAdWarningGeneration: { current: number } = { current: 0 };

/**
 * chatId -> (senderId -> 累积待检消息串)，由 workers/antiRaid/adDetect/queueState.ts 维护。
 * 填充：收到待检消息时写入或追加。
 * 清理：已消费消息串在去重窗口外由周期 sweep 回收，停管或关开关时按群删除，Worker 停止时清空。
 * 重建：Worker 崩溃重启后从空表开始。
 * 容量：总串数（pendingAdBundleCount）上限为 AD_DETECT_MAX_PENDING_SENDERS，满载时拒收新发送者而不淘汰已有条目。
 */
export const pendingAdMessages: Map<number, Map<number, AdMessageBundle>> = new Map();

/**
 * pendingAdMessages 两层合计的消息串总数。
 * 填充：新增待检消息串时递增；清理：消息串删除或清空时递减或归零；重建：Worker 重启后从 0 开始；容量：固定为单个数值 holder（上限 AD_DETECT_MAX_PENDING_SENDERS）。
 */
export const pendingAdBundleCount: { current: number } = { current: 0 };

/**
 * 主线程同步过来的贴纸包与自定义表情包黑名单条数只读镜像（权威存储位于主线程 768 LRU 与 SQLite `ad_pack_blacklists` 表）。
 * 填充：Worker 启动、崩溃重建及主线程黑名单条数变化时由 workers/antiRaid/adDetect/config.ts 的 `adoptAdPackBlacklistSyncMessage` 更新。
 * 清理：Worker 停止时由 workers/antiRaid/adDetect/queue.ts 的 `stopAdDetectQueue` 重置为 0。
 * 重建：Worker 崩溃重启后由主线程 `replayAdPackBlacklists` 在新业务消息之前重放。
 * 无条目含义：条数为 0 表示对应分类无黑名单条目，快路径直接 O(1) 短路跳过跨线程与 Telegram 表情查询，不得把 0 解释为沿用旧值。
 * 容量与淘汰：固定两个数值字段，不设淘汰。
 */
export const adPackBlacklistCounts: {
  sticker: number;
  emoji: number;
} = {
  sticker: 0,
  emoji: 0,
};

/**
 * 按当前广告检测配置（`ad_detect.json`）中的示例拼接的判定提示词缓存。
 * 填充：classifier.ts 首次判定时构造并写入；清理：收到新广告检测配置（`ad_detect.json`）快照时由 workers/antiRaid/adDetect/config.ts 重置为 null；重建：Worker 重启后从 null 按需重建；容量：固定为单个槽位。
 */
export const adDetectPrompts: { current: AdDetectPrompts | null } = { current: null };

/**
 * 正在执行广告分类/管理员核查或首次引用警告发送的发言者键集合。
 * 填充：批次派发时登记，首次引用警告在 workers/antiRaid/adDetect/referencedWarning.ts 的 `warnReferencedOnlySender` 发送前再次登记；清理：分类与管理员核查结算后移除、首次警告发送结算后移除，或 Worker 停止时清空；重建：Worker 重启后从空集合开始；容量：派发阶段上限为 AD_DETECT_MAX_IN_FLIGHT。
 */
export const inFlightAdDetectKeys: Set<string> = new Set<string>();

/**
 * 首次警告发送结算后的广告消息异步删除任务集合。
 * 填充：警告发送结算后登记；清理：删除请求结算或 Worker 停止时移除；重建：Worker 重启后从空集合开始；容量：上限为 AD_DETECT_MAX_IN_FLIGHT。
 */
export const inFlightReferencedAdCleanupTasks: Set<Promise<void>> =
  new Set<Promise<void>>();

/** 上一轮派发是否触及全局在途上限，用于边沿告警去重：触及上限时写入 true，有空位或 Worker 停止时重置为 false；容量固定为单个布尔值，Worker 重启后恢复为 false。 */
export const adDetectSaturated: { current: boolean } = { current: false };

/** 待检队列上一轮是否触及容量上限，用于边沿告警去重：触及容量上限时写入 true，容量恢复或 Worker 停止时重置为 false；容量固定为单个布尔值，Worker 重启后恢复为 false。 */
export const adDetectCapacitySaturated: { current: boolean } = { current: false };

/**
 * 广告检测流水线是否已进入停机排空阶段：quiesceAdDetectQueue 调用时写入 true，启动或停止时重置为 false；重建：Worker 重启后从 false 开始；容量：固定为单个布尔值。
 */
export const adDetectStopping: { current: boolean } = { current: false };

/** 广告检测批处理节拍 interval 句柄；Worker 启动时创建，停止时清除，重建后从 null 开始，容量固定为单个 timer。 */
export const adDetectTickTimer: { current: ReturnType<typeof setInterval> | null } = { current: null };

/** 广告判定命中后回投主线程的发送回调 holder；启动时注入，停止时重置为 null，Worker 重启后从 null 重新注入，容量固定为单个回调。 */
export const adDetectPublishHolder: {
  current: ((event: AdDetectedEvent) => void) | null;
} = { current: null };

/** 广告判定为真时通知主线程清零无广告连续日计数的回调 holder；启动时注入，停止时重置为 null，Worker 重启后从 null 重新注入，容量固定为单个回调。 */
export const adVerdictTruePublishHolder: {
  current: ((event: AdVerdictTrueEvent) => void) | null;
} = { current: null };
