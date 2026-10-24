/** 引用类广告的警告升级状态（窗口 AD_REFERENCE_WARNING_WINDOW_MS）；状态 owner 为 Anti-Raid Worker。 */

import {
  referencedAdWarningGeneration,
  referencedAdWarningStates,
} from "../../../cache/workers/antiRaid/adDetect";
import { AD_REFERENCE_WARNING_WINDOW_MS } from "../../../consts/antiRaid/adDetect";
import { logger } from "../../../infra/logger";
import {
  verificationKeyPrefix,
  verificationKeySuffix,
} from "../../../libs/verificationKey";
import type { ReferencedAdWarningState } from "../../../types/antiRaid/adDetect";

/**
 * 为一个首次警告建立唯一发送 attempt；undefined 表示序号已经不可安全递增。
 *
 * @param key `chatId:userId` 格式的队列键。
 * @returns 新分配的警告 attempt 序号；序号耗尽时返回 `undefined`。
 */
export function beginReferencedAdWarning(key: string): number | undefined {
  const nextGeneration: number = referencedAdWarningGeneration.current + 1;
  if (!Number.isSafeInteger(nextGeneration)) {
    logger.error("Referenced ad warning generation space is exhausted.");
    return undefined;
  }
  referencedAdWarningGeneration.current = nextGeneration;
  // 先删再写：本键挪到最新端；满载时 FifoMap 淘汰最早的警告状态。
  referencedAdWarningStates.delete(key);
  referencedAdWarningStates.set(key, {
    phase: "sending",
    generation: nextGeneration,
  });
  return nextGeneration;
}

/**
 * 把仍匹配当前 attempt 的发送态提交为警告态。清群、关闭或新 attempt
 * 已经替换它时返回 false，调用方只能清理迟到提示，不得建立升级窗口。
 *
 * @param key `chatId:userId` 格式的队列键。
 * @param generation 本次发送对应的 attempt 序号。
 * @param warnedAt 警告消息发送成功的墙钟毫秒时间戳。
 * @returns 成功提交为警告态时返回 `true`。
 */
export function completeReferencedAdWarning(
  key: string,
  generation: number,
  warnedAt: number
): boolean {
  const current: ReferencedAdWarningState | undefined =
    referencedAdWarningStates.get(key);
  if (
    current?.phase !== "sending" ||
    current.generation !== generation
  ) return false;
  referencedAdWarningStates.set(key, {
    phase: "warned",
    generation,
    warnedAt,
    expiresAt: warnedAt + AD_REFERENCE_WARNING_WINDOW_MS,
  });
  return true;
}

/**
 * 发送失败时只撤销匹配的 attempt，不能误删同 key 后来建立的新状态。
 *
 * @param key `chatId:userId` 格式的队列键。
 * @param generation 本次发送对应的 attempt 序号。
 */
export function cancelReferencedAdWarning(
  key: string,
  generation: number
): void {
  const current: ReferencedAdWarningState | undefined =
    referencedAdWarningStates.get(key);
  if (
    current?.phase === "sending" &&
    current.generation === generation
  ) referencedAdWarningStates.delete(key);
}

/**
 * 消息到达时冻结它是否处于已公开警告窗口；之后的判定只读冻结事实，不再用处理
 * 时钟重新判断。
 *
 * @param key `chatId:userId` 格式的队列键。
 * @param receivedAt 消息到达时的墙钟毫秒时间戳。
 * @returns 处于有效警告窗口内时返回 `true`。
 */
export function hasActiveReferencedAdWarning(key: string, receivedAt: number): boolean {
  const state: ReferencedAdWarningState | undefined =
    referencedAdWarningStates.get(key);
  if (state?.phase !== "warned") return false;
  if (receivedAt >= state.warnedAt && receivedAt < state.expiresAt) return true;
  // 超出警告窗口或墙钟回拨（receivedAt < warnedAt）时就地回收。
  referencedAdWarningStates.delete(key);
  return false;
}

/**
 * 停管或关闭广告检测时清掉该群的全部发送中/已警告状态。
 *
 * @param chatId 目标群 ID。
 */
export function clearChatReferencedAdWarnings(chatId: number): void {
  const prefix: string = verificationKeyPrefix(chatId);
  for (const key of referencedAdWarningStates.keys()) {
    if (key.startsWith(prefix)) referencedAdWarningStates.delete(key);
  }
}

/**
 * 某身份获得永久白名单权限或临时广告免检资格时，清掉它在各群的引用广告警告状态。
 *
 * @param identityId 目标身份 ID。
 */
export function clearIdentityReferencedAdWarnings(identityId: number): void {
  const suffix: string = verificationKeySuffix(identityId);
  for (const key of referencedAdWarningStates.keys()) {
    if (key.endsWith(suffix)) {
      referencedAdWarningStates.delete(key);
    }
  }
}

/**
 * 周期回收已过期警告；发送中的 attempt 由发送结算、清群或 Worker 停止清理。
 *
 * @param now 当前墙钟毫秒时间戳。
 */
export function sweepReferencedAdWarnings(now: number): void {
  for (const [key, state] of referencedAdWarningStates) {
    if (state.phase !== "warned") continue;
    const elapsedMs: number = now - state.warnedAt;
    if (elapsedMs < 0 || now >= state.expiresAt) {
      referencedAdWarningStates.delete(key);
    }
  }
}

/** Worker 停止时清空全部引用类广告警告状态；attempt 序号不得回退。 */
export function resetReferencedAdWarnings(): void {
  referencedAdWarningStates.clear();
}
