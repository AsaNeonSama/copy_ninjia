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
 * @param knownAdmin Worker 侧管理员缓存是否认得该发送者；缓存冷时为 false。
 */
export function isKnownAdminCandidate(isChannel: boolean, knownAdmin: boolean): boolean {
  return !isChannel && knownAdmin;
}

/**
 * 投递闸：决定已过管理员闸的候选消息是否并入该发送者的消息串。
 * 空正文返回 `ignore`；命中黑名单或处置抑制窗口时，频道身份返回 `deleteStraggler` 单独删除消息，普通用户返回 `ignore`。
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
 * @param input.hasUncheckedContent 调用方比较 latestSeq 与 checkedSeq 得出的未检标记。
 */
export function admitAdRequeue(input: AdRequeueInput): AdRequeueDecision {
  if (!input.hasUncheckedContent) return "skip";
  if (input.queued || input.inFlight) return "skip";
  return "enqueue";
}

/** 容量闸：待检发送者数是否已达 AD_DETECT_MAX_PENDING_SENDERS。 */
export function isNewAdBundleAtCapacity(pendingSize: number): boolean {
  return pendingSize >= AD_DETECT_MAX_PENDING_SENDERS;
}

/**
 * 在途闸：当前在途判定数是否已达 AD_DETECT_MAX_IN_FLIGHT。
 * @param inFlight 正在等待广告检测 provider 响应的键数。
 */
export function isAdDispatchSaturated(inFlight: number): boolean {
  return inFlight >= AD_DETECT_MAX_IN_FLIGHT;
}
