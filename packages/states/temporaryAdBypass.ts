import {
  TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD,
  TEMPORARY_AD_BYPASS_REQUIRED_DAYS,
} from "../consts/temporaryAdBypass";
import { getDayIndex } from "../libs/time";
import type { TemporaryAdBypassActivity } from "../types/states/temporaryAdBypass";

/**
 * 记录是否尚未越过保留边界；未来时间轴留给下一条发言显式收敛。
 *
 * `now` 由调用方一次取好传入（见 infra/identityPolicy/temporaryAdBypass.ts），
 * 本模块不读时钟，同一条消息的多次判定使用同一个时刻。
 * @param activity 当前成员的临时广告检测豁免活动记录。
 * @param now 当前判定时刻的时间戳（毫秒，非负安全整数）。
 * @returns 记录仍在保留窗口内时返回 true，否则返回 false。
 */
export function isTemporaryAdBypassActivityRetained(
  activity: Readonly<TemporaryAdBypassActivity>,
  now: number
): boolean {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("Temporary ad bypass activity time must be a non-negative safe integer.");
  }
  const currentDay: number = getDayIndex(now);
  const countedDay: number = getDayIndex(activity.countedAt);
  if (currentDay <= countedDay) return true;
  return currentDay === countedDay + 1 &&
    activity.qualifiedAt !== null &&
    getDayIndex(activity.qualifiedAt) === countedDay;
}

/**
 * 判断当前记录在 now 时刻是否仍持有临时广告检测豁免。
 * @param activity 当前成员的临时广告检测豁免活动记录。
 * @param now 当前判定时刻的时间戳（毫秒）。
 * @returns 已授予临时免检且记录未越过保留边界时返回 true，否则返回 false。
 */
export function isTemporaryAdBypassActive(
  activity: Readonly<TemporaryAdBypassActivity>,
  now: number
): boolean {
  return activity.adBypass &&
    isTemporaryAdBypassActivityRetained(activity, now);
}

/**
 * 记录是否已到自动永久免检门槛：连续合格日数等于
 * TEMPORARY_AD_BYPASS_REQUIRED_DAYS（`advanceTemporaryAdBypassActivity` 把连续
 * 日数封顶在该门槛）。调用方据此晋升永久白名单并清除临时累计。
 * @param activity 当前成员的临时广告检测豁免活动记录。
 * @returns 连续合格日数达到晋升永久免检门槛时返回 true，否则返回 false。
 */
export function shouldPromoteToPermanentBypass(
  activity: Readonly<TemporaryAdBypassActivity>
): boolean {
  return activity.qualifiedDays === TEMPORARY_AD_BYPASS_REQUIRED_DAYS;
}

/**
 * 构造首条发言时的初始临时免检活动记录。
 * @param now 首条发言的时间戳（毫秒）。
 * @returns 初始发言计数为 1、尚未获得临时免检的活动记录。
 */
function firstActivity(now: number): Readonly<TemporaryAdBypassActivity> {
  return {
    adBypass: false,
    adBypassGrantedAt: null,
    qualifiedDays: 0,
    sendCount: 1,
    countedAt: now,
    qualifiedAt: null,
  };
}

/**
 * 墙钟回拨时从当前消息重建计数时间轴，同时保留已经授予的临时资格。
 * @param current 回拨前的活动记录。
 * @param now 回拨后的当前发言时间戳（毫秒）。
 * @returns 重建计数时间轴后的活动记录。
 */
function restartActivityAfterClockRollback(
  current: Readonly<TemporaryAdBypassActivity>,
  now: number
): Readonly<TemporaryAdBypassActivity> {
  if (!current.adBypass) return firstActivity(now);
  if (current.adBypassGrantedAt === null) {
    throw new Error("Temporary ad bypass membership requires a grant timestamp.");
  }
  return {
    adBypass: true,
    adBypassGrantedAt: Math.min(current.adBypassGrantedAt, now),
    qualifiedDays: 0,
    sendCount: 1,
    countedAt: now,
    qualifiedAt: null,
  };
}

/**
 * 计入一条跨群发言并推进临时广告免检状态：
 * - 首个达标自然日立即授予临时广告免检，每个自然日仅累计一次合格天数；
 * - 连续合格日数达到 `TEMPORARY_AD_BYPASS_REQUIRED_DAYS` 时到达自动晋升永久免检门槛；
 * - 上一配置时区自然日未达标或跨日断档时，从当前发言重新起算，不沿用旧临时资格或发言计数；
 * - 当日已达标后原样返回 `current`（`sendCount` 与 `countedAt` 保持在达标发言时刻），供调用方按引用相等跳过写盘；
 * - 墙钟回拨至 `countedAt` 之前时重建计数时间轴并保留已授予的临时免检资格。
 * @see ../../docs/cn/04-invariants.md
 * @param current 当前已有的活动记录，无记录时为 null。
 * @param now 本次发言的时间戳（毫秒，非负安全整数）。
 * @returns 推进后的活动记录；当天已达标且无需变更时原样返回 current。
 */
export function advanceTemporaryAdBypassActivity(
  current: Readonly<TemporaryAdBypassActivity> | null,
  now: number
): Readonly<TemporaryAdBypassActivity> {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("Temporary ad bypass activity time must be a non-negative safe integer.");
  }
  if (current === null) {
    return firstActivity(now);
  }
  if (now < current.countedAt) {
    return restartActivityAfterClockRollback(current, now);
  }
  const currentDay: number = getDayIndex(now);
  const countedDay: number = getDayIndex(current.countedAt);
  if (currentDay === countedDay + 1) {
    const previousDayQualified: boolean = current.qualifiedAt !== null &&
      getDayIndex(current.qualifiedAt) === countedDay;
    if (!previousDayQualified) return firstActivity(now);
    return {
      adBypass: current.adBypass,
      adBypassGrantedAt: current.adBypassGrantedAt,
      qualifiedDays: current.qualifiedDays,
      sendCount: 1,
      countedAt: now,
      qualifiedAt: null,
    };
  }
  if (currentDay !== countedDay) return firstActivity(now);
  if (current.qualifiedAt !== null) return current;

  const sendCount: number = current.sendCount + 1;
  if (sendCount <= TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD) {
    return {
      adBypass: current.adBypass,
      adBypassGrantedAt: current.adBypassGrantedAt,
      qualifiedDays: current.qualifiedDays,
      sendCount,
      countedAt: now,
      qualifiedAt: current.qualifiedAt,
    };
  }

  const qualifiedDays: number = Math.min(
    current.qualifiedDays + 1,
    TEMPORARY_AD_BYPASS_REQUIRED_DAYS
  );
  return {
    adBypass: true,
    adBypassGrantedAt: current.adBypassGrantedAt ?? now,
    qualifiedDays,
    sendCount,
    countedAt: now,
    qualifiedAt: now,
  };
}
