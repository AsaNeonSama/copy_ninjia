/** owner: workers/antiRaid。广告检测流水线状态（packages/workers/antiRaid/adDetect/）。 */

import { AD_DETECT_MAX_PENDING_SENDERS } from "../../../consts/antiRaid/adDetect";
import { FifoMap } from "../../../libs/fifoMap";
import { LinkedQueue } from "../../../libs/linkedQueue";
import type {
  AdDetectedEvent,
  AdDetectPrompts,
  AdMessageBundle,
  ReferencedAdWarningState,
  AdVerdictTrueEvent,
} from "../../../types/antiRaid/adDetect";

/**
 * 待检发言者键（`chatId:senderId`）FIFO 队列，每个节拍取走队首至多 AD_DETECT_BATCH_SIZE 个。
 * 填充：新待检发言者入队时追加；清理：批次派发出队、停管或关开关按群摘键、Worker 停止时清空；重建：Worker 崩溃重启后从空队列开始；容量：由 queuedAdDetectKeys 去重，受 AD_DETECT_MAX_PENDING_SENDERS 约束。
 */
export const adDetectQueue: LinkedQueue<string> = new LinkedQueue<string>();

/**
 * 当前排在 adDetectQueue 中的发言者键集合，随队列入队与出队同步增删。
 * 清理：派发出队、按群摘键或 Worker 停止时删除；重建：Worker 重启后从空集合开始；容量：上限为 AD_DETECT_MAX_PENDING_SENDERS。
 */
export const queuedAdDetectKeys: Set<string> = new Set<string>();

/**
 * 已判定为广告并触发处置的发言者键 -> Worker 单调时钟处置时刻（见 docs/cn/04-invariants.md）。
 * 填充：workers/antiRaid/adDetect/verdict.ts 的 detectOne 触发处置前写入。
 * 清理：满 AD_DETECT_JUDGED_RETENTION_WINDOW_MS 到期淘汰，或封禁取得确定结果时由 blocklistEffects 提前删除。
 * 重建：Worker 崩溃重启后从空表开始。
 * 容量：FifoMap 限制为 AD_DETECT_MAX_PENDING_SENDERS，满载时淘汰最早处置键。
 */
export const recentlyDisposedAdKeys: FifoMap<string, number> = new FifoMap(AD_DETECT_MAX_PENDING_SENDERS);

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
 * pendingAdMessages 两层合计的消息串总数，随 queueState.ts 增删同步更新，清空时归零。
 */
export const pendingAdBundleCount: { current: number } = { current: 0 };

/**
 * 按当前广告样本快照拼接的判定提示词缓存。
 * 填充：classifier.ts 首次判定时构造写入；清理：收到新广告样本快照时由 workers/antiRaid/adDetect/config.ts 置空；重建：Worker 重启后从 null 按需重建；容量：固定为单个槽位。
 */
export const adDetectPrompts: { current: AdDetectPrompts | null } = { current: null };

/**
 * 正在等待模型判定或首次警告发送结算的发言者键集合。
 * 填充：批次派发时登记；清理：判定及首次警告网络往返结算后移除；重建：Worker 重启后从空集合开始；容量：上限为 AD_DETECT_MAX_IN_FLIGHT。
 */
export const inFlightAdDetectKeys: Set<string> = new Set<string>();

/**
 * 首次警告发送结算后的广告消息异步删除任务集合。
 * 填充：警告发送结算后登记；清理：删除请求结算或 Worker 停止时移除；重建：Worker 重启后从空集合开始；容量：上限为 AD_DETECT_MAX_IN_FLIGHT。
 */
export const inFlightReferencedAdCleanupTasks: Set<Promise<void>> =
  new Set<Promise<void>>();

/** 上一轮派发是否触及全局在途上限，用于边沿告警去重；容量固定为单个布尔值，Worker 重启后恢复为 false。 */
export const adDetectSaturated: { current: boolean } = { current: false };

/** 待检队列上一轮是否触及容量上限，用于边沿告警去重；容量恢复或 Worker 重启后恢复为 false。 */
export const adDetectCapacitySaturated: { current: boolean } = { current: false };

/**
 * 广告检测流水线是否已进入停机排空阶段（quiesceAdDetectQueue 置 true，启动或停止时置 false）。
 */
export const adDetectStopping: { current: boolean } = { current: false };

/** 广告检测批处理节拍 interval 句柄；Worker 启动时创建，停止时清除，容量固定为单个 timer。 */
export const adDetectTickTimer: { current: ReturnType<typeof setInterval> | null } = { current: null };

/** 广告判定命中后回投主线程的发送回调 holder；启动时注入，停止时置空，容量固定为单个回调。 */
export const adDetectPublishHolder: {
  current: ((event: AdDetectedEvent) => void) | null;
} = { current: null };

/** 广告判定为真时通知主线程清零无广告连续日计数的回调 holder；启动时注入，停止时置空，容量固定为单个回调。 */
export const adVerdictTruePublishHolder: {
  current: ((event: AdVerdictTrueEvent) => void) | null;
} = { current: null };
