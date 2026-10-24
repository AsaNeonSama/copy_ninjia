import {
  AD_DETECT_MAX_IN_FLIGHT,
  AD_DETECT_MAX_PENDING_SENDERS,
} from "../consts/antiRaid/adDetect";
import type {
  AdCandidateAdmissionInput,
  AdCandidateDecision,
  AdRequeueDecision,
  AdRequeueInput,
} from "../types/states/adDetectAdmission";

/**
 * 管理员闸：非频道发送者且已命中 Worker 管理员缓存时跳过广告送检。
 * @param isChannel 发送者是否为频道身份。
 * @param knownAdmin Worker 侧管理员缓存是否认得该发送者；缓存冷时为 false。
 * @returns 非频道且已确认为管理员时返回 true，否则返回 false。
 */
export function isKnownAdminCandidate(isChannel: boolean, knownAdmin: boolean): boolean {
  return !isChannel && knownAdmin;
}

/**
 * 投递闸：决定已过管理员闸的候选消息是否并入该发送者的消息串。
 * 空正文返回 `ignore`；命中黑名单或处置抑制窗口时，频道身份返回 `deleteStraggler` 单独删除消息，普通用户返回 `ignore`。
 * @param input 候选消息的投递准入判定输入。
 * @returns 投递准入决策（accept / ignore / deleteStraggler）。
 */
export function admitAdCandidate(input: AdCandidateAdmissionInput): AdCandidateDecision {
  if (input.textLength === 0) return "ignore";
  if (input.blocked || input.recentlyDisposed) {
    return input.isChannel ? "deleteStraggler" : "ignore";
  }
  return "accept";
}

/**
 * 排队闸：有未检内容且当前既未排队也不在途时返回 `enqueue`，否则返回 `skip`。
 * @param input 发送者消息串的排队准入输入（含未检内容标记 `hasUncheckedContent`、已入队标记 `queued` 与在途标记 `inFlight`）。
 * @returns 排队决策（`enqueue` 或 `skip`）。
 */
export function admitAdRequeue(input: AdRequeueInput): AdRequeueDecision {
  if (!input.hasUncheckedContent) return "skip";
  if (input.queued || input.inFlight) return "skip";
  return "enqueue";
}

/**
 * 容量闸：待检发送者数是否已达 AD_DETECT_MAX_PENDING_SENDERS。
 * @param pendingSize 当前待检发送者包的数量。
 * @returns 已达到或超过容量上限时返回 true，否则返回 false。
 */
export function isNewAdBundleAtCapacity(pendingSize: number): boolean {
  return pendingSize >= AD_DETECT_MAX_PENDING_SENDERS;
}

/**
 * 在途闸：当前在途判定数是否已达 AD_DETECT_MAX_IN_FLIGHT。
 * @param inFlight 正在等待广告检测 provider 响应的键数。
 * @returns 已达到或超过在途上限时返回 true，否则返回 false。
 */
export function isAdDispatchSaturated(inFlight: number): boolean {
  return inFlight >= AD_DETECT_MAX_IN_FLIGHT;
}
