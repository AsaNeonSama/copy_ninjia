/** owner: workers/antiRaid。频道评论区留言短期关联缓冲（packages/workers/antiRaid/recentComments.ts）。 */

import { RECENT_COMMENT_CACHE_MAX } from "../../../consts/antiRaid/cache";
import { FifoMap } from "../../../libs/fifoMap";
import type { RecentChannelComment } from "../../../types/antiRaid/internal";

/**
 * `chatId:userId` -> 评论先于入群事件到达时的短期关联记录。
 * 填充：rememberRecentComment 在留言到达且发言者尚无验证记录时写入。
 * 清理：takeRecentComment 命中即删，超过 COMMENT_JOIN_CORRELATE_MS 的过期项由 sweepRecentComments 或满表内联 sweep 清理，resetRecentComments 清空。
 * 重建：Worker 崩溃重启后从空表开始。
 * 容量：FifoMap 限制为 RECENT_COMMENT_CACHE_MAX，内联 sweep 后仍满则淘汰最早插入项。
 */
export const recentChannelComments: FifoMap<string, RecentChannelComment> = new FifoMap(RECENT_COMMENT_CACHE_MAX);

/**
 * recentChannelComments 内最小 observedAt 时间戳下界（表空时为正无穷），供满表写入判断是否存在可内联淘汰的过期项。
 * 填充与清理：rememberRecentComment 写入时下移，sweepRecentComments 扫描后重算，resetRecentComments 复位；重建：Worker 重启后为初始值；容量：固定为单个数值 holder。
 */
export const recentCommentsMinObservedAt: { current: number } = { current: Number.POSITIVE_INFINITY };
