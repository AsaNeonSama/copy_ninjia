/**
 * 引用类广告警告升级的单记录纯状态归约（代次推进、容器读写与日志留在
 * packages/workers/antiRaid/adDetect/referencePolicy.ts）。
 */

import { AD_REFERENCE_WARNING_WINDOW_MS } from "../consts/antiRaid/adDetect";
import type {
  ReferencedAdWarningState,
  ReferencedAdWarningWindow,
} from "../types/states/adReferenceWarning";

/**
 * 在当前记录仍为同代 `sending` 时将其提交为 `warned` 状态；不匹配时原样返回 `current`。
 *
 * @param current 当前键持有的警告状态记录。
 * @param generation 本次警告发送对应的 attempt 序号。
 * @param warnedAt 警告消息发送成功的墙钟毫秒时间戳。
 * @returns 提交后的新 `warned` 状态，或未变化时原样返回 `current`。
 */
export function commitReferencedAdWarning(
  current: ReferencedAdWarningState | undefined,
  generation: number,
  warnedAt: number
): ReferencedAdWarningState | undefined {
  if (current?.phase !== "sending" || current.generation !== generation) {
    return current;
  }
  return {
    phase: "warned",
    generation,
    warnedAt,
    expiresAt: warnedAt + AD_REFERENCE_WARNING_WINDOW_MS,
  };
}

/**
 * 判定发送失败时当前记录是否为待撤销的同代 `sending` 状态。
 *
 * @param current 当前键持有的警告状态记录。
 * @param generation 本次警告发送对应的 attempt 序号。
 * @returns 当前记录为同代 `sending` 时返回 `true`。
 */
export function cancelsReferencedAdWarning(
  current: ReferencedAdWarningState | undefined,
  generation: number
): boolean {
  return current?.phase === "sending" && current.generation === generation;
}

/**
 * 判定警告记录在给定墙钟时刻 `at` 的窗口状态：非 `warned` 为 `none`；
 * `warnedAt <= at < expiresAt` 为 `active`；已到期或墙钟回拨（`at < warnedAt`）为 `stale`。
 *
 * @param state 当前键持有的警告状态记录。
 * @param at 判定用的墙钟毫秒时间戳。
 * @returns 窗口状态（`none` / `active` / `stale`）。
 */
export function referencedAdWarningWindow(
  state: ReferencedAdWarningState | undefined,
  at: number
): ReferencedAdWarningWindow {
  if (state?.phase !== "warned") return "none";
  if (state.warnedAt <= at && at < state.expiresAt) return "active";
  return "stale";
}
