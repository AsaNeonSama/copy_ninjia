/** 刷屏禁言（packages/workers/antiRaid/floodControl.ts）的调参常量。 */

import { MINUTE_MS } from "../time";

/**
 * 统计单人发言频率的滑动窗口时长。窗口边界语义由
 * libs/slidingWindowRateLimit.ts 统一定义，这里只给长度。
 */
export const FLOOD_WINDOW_MS: number = MINUTE_MS;

/**
 * 一个窗口内达到这个条数即判定为刷屏（达到即触发，不要求超过）。
 *
 * 与反刷群入群阈值（consts/antiRaid/lockdown.ts 的 ANTI_RAID_PER_MINUTE_LIMIT）不同：
 * 本值计的是单人发言条数。
 */
export const FLOOD_MESSAGE_LIMIT: number = 15;

/**
 * 一次刷屏禁言的时长，到点由 Telegram 自动恢复发言权限，机器人不排恢复计时器。
 *
 * 须高于 Bot API 把 until_date 当成永久限制的官方下限。
 */
export const FLOOD_MUTE_DURATION_MS: number = 3 * MINUTE_MS;

/**
 * 禁言请求从计算 `until_date` 到实际派发的最大等待时长（毫秒）；超时即放弃本次禁言并回滚抑制位。
 *
 * 不变量：`until_date` 在入队前按绝对时刻计算；请求经 `restrict` 类 429 车道排队后发出时，
 * 剩余时长仍高于 Bot API 将 `until_date` 视为永久限制的下限（取值小于 `FLOOD_MUTE_DURATION_MS`）。
 * 所属模块：`packages/workers/antiRaid/floodControl.ts`。
 */
export const FLOOD_MUTE_DISPATCH_TIMEOUT_MS: number = FLOOD_MUTE_DURATION_MS - MINUTE_MS;

/**
 * 刷屏禁言落地后，禁言公告在群发送调度车道等待派发的最大时长（毫秒）；超时仅丢弃公告，不影响已落地的禁言。
 *
 * 不变量：正整数毫秒；公告与群普通消息共用本群发送车道，`kick`/`restrict` 走独立 429 域。
 * 所属模块：`packages/workers/antiRaid/floodControl.ts`。
 */
export const FLOOD_NOTICE_DISPATCH_TIMEOUT_MS: number = 30_000;

/**
 * 发言窗口表（cache/workers/antiRaid/flood.ts）的条目硬顶，键是「群 + 成员」。
 *
 * 越界按 LRU 淘汰最早写入的那条，被淘汰的人下次发言从空窗口重新开始计数。
 * 单条队列长度受 FLOOD_MESSAGE_LIMIT 封顶（达到即清空），因此整表占用是
 * 「条目数 × 阈值」这个常数上界，不需要额外的全局到期清扫计时器。
 */
export const FLOOD_WINDOW_MAX_MEMBERS: number = 25_000;
