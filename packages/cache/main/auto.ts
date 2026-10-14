/** owner: main。消息自动流水线（packages/auto/）的内存状态。 */

import type { AiReplyActivityEntry } from "../../types/auto";

/**
 * 各群各用户上次触发随机 AI 回复（随机插话或媒体评价）的时刻（chatId -> userId -> 时间戳）。
 *
 * 填充：claimUserReplyTrigger 认领成功时写入。清理：清扫 timer 在冷却到期后删除条目，空群桶一并移除。
 * 容量上限为 USER_REPLY_TRIGGER_CACHE_MAX；满载新增前补扫一次，仍满则拒绝本次触发、不淘汰未到期冷却。
 * 主线程独占，进程重启后从空表重建。
 */
export const userReplyTriggerTimes: Map<number, Map<number, number>> = new Map();

/**
 * 随机回复个人冷却表的清扫 timer、全局条目计数与满表有效区间。
 * 填充：首次认领时建立 timer，认领与清扫同步维护 size 及 validFrom / validUntil。
 * 清理：表排空或 reset 时释放 timer 并归零；进程重启后从初值重建，容量恒为一个状态对象。
 */
export const userReplyTriggerSweepState: {
  timer: ReturnType<typeof setTimeout> | null;
  size: number;
  validFrom: number;
  validUntil: number;
} = { timer: null, size: 0, validFrom: 0, validUntil: Number.NEGATIVE_INFINITY };

/**
 * 各群滑动窗口（AI_REPLY_ACTIVITY_WINDOW_MS）发言活跃度。
 * 填充：observeAiReplyActivity 记录群消息时写入或更新。清理：清扫 timer 在窗口到期后删除条目。
 * 容量上限为 AI_REPLY_ACTIVITY_MAX_CHATS，满载新增群时按条目访问序号淘汰最久未活跃的群；
 * 进程重启后从空表重建。
 */
export const aiReplyActivityByChat: Map<number, AiReplyActivityEntry> = new Map();

/** 群活跃度表的单调访问序号；每次记录递增，整表清空时归零，进程重启后从初值开始。 */
export const aiReplyActivitySequenceState: { current: number } = { current: 0 };

/** 群活跃度表按最早到期时刻调度的唯一清扫 timer；表空时释放，进程重启后从 null 开始。 */
export const aiReplyActivitySweepState: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };
