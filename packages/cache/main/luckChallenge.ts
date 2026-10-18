/** owner: main。抽签命令运行态与当日缓存（packages/commands/luckChallenge/）。 */

import { PENDING_LUCK_CACHE_MAX, RATE_LIMIT_MAX_CALLS_PER_WINDOW } from "../../consts/luckChallenge";
import { FifoMap } from "../../libs/fifoMap";
import { TimestampDeque } from "../../libs/timestampDeque";
import type { LuckReceiptSecret } from "../../types/diskIO/storage";
import type { LuckDraw } from "../../types/luckChallenge";

/** 当前运势缓存对应的配置时区自然日：启动时由 restoreLuckState 填充，跨日由 adoptLuckSecret 切换并清空当日缓存；进程重启后从空串开始。 */
export const luckCacheState: { dayKey: string } = { dayKey: "" };
/** 当日已确认运势结果表（cacheKey -> LuckDraw）：启动时由 restoreLuckState 灌入，用户发出 inline 结果经 confirmLuckDraw 确认时写入，跨日整体清空；容量上限为 DAILY_LUCK_CACHE_MAX，满额拒绝新键且不淘汰已确认项。 */
export const dailyLuckCache: Map<string, LuckDraw> = new Map();
/** 当日已确认运势表满额告警标记：满额记日志时置为 true，跨日随缓存一起复位为 false。 */
export const dailyLuckCacheSaturated: { current: boolean } = { current: false };

/** 待确认运势草稿 FIFO 表（cacheKey -> LuckDraw）：inline_query 预览时由 getOrDrawLuck 写入，confirmLuckDraw 认领时移入 dailyLuckCache 并删除，跨日整体清空；容量上限为 PENDING_LUCK_CACHE_MAX，满额按 FIFO 淘汰最早写入项，进程重启后从空表开始。 */
export const pendingLuckDraws: FifoMap<string, LuckDraw> = new FifoMap(PENDING_LUCK_CACHE_MAX);

/** 当日运势回执签名密钥单例：启动恢复或跨日轮换时填充，进程重启后从 null 开始。 */
export const luckReceiptSecretState: { current: LuckReceiptSecret | null } = { current: null };

/** 运势跨日轮换单飞 Promise、Worker 重建监听注册标记与跨日切换标记；单例固定字段，进程重启后从初始值开始。 */
export const luckRuntimeState: {
  dayRefreshPromise: Promise<void> | null;
  respawnRecoveryInitialized: boolean;
  daySwitchedInProcess: boolean;
} = {
  dayRefreshPromise: null,
  respawnRecoveryInitialized: false,
  daySwitchedInProcess: false,
};

/** 运势 inline 查询全局滑动窗口调用时间戳队列（窗口长度 RATE_LIMIT_WINDOW_MS）：每次判定时先淘汰滑出窗口的队首时间戳，未满额时写入当前时间戳；容量固定为 RATE_LIMIT_MAX_CALLS_PER_WINDOW，进程重启后从空队列开始。 */
export const recentCallTimestamps: TimestampDeque =
  new TimestampDeque(RATE_LIMIT_MAX_CALLS_PER_WINDOW);
