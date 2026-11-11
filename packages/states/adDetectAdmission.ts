import {
  AD_DETECT_MAX_IN_FLIGHT,
  AD_DETECT_MAX_PENDING_SENDERS,
} from "../consts/antiRaid/adDetect";
import type {
  AdCandidateAdmissionInput,
  AdCandidateDecision,
  AdRequeueDecision,
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
 * 无正文且无贴纸/自定义表情候选时返回 `ignore`。已在永久黑名单时，普通用户返回 `ignore`（封禁带
 * `revoke_messages` 撤回其消息），频道身份返回 `deleteStraggler`（`banChatSenderChat` 不撤回消息）。
 * 处置抑制窗口内一律返回 `deleteStraggler`：禁言、只踢不封与频道封禁都不撤回处置落地前发出的消息。
 * @param input 候选消息的投递准入判定输入。
 * @returns 投递准入决策（accept / ignore / deleteStraggler）。
 */
export function admitAdCandidate(input: AdCandidateAdmissionInput): AdCandidateDecision {
  if (input.textLength === 0 && !input.hasPackCandidate) return "ignore";
  if (input.blocked) return input.isChannel ? "deleteStraggler" : "ignore";
  if (input.recentlyDisposed) return "deleteStraggler";
  return "accept";
}

/**
 * 排队闸：有未检内容且当前既未排队也不在途时返回 `enqueue`，否则返回 `skip`。
 * @param hasUncheckedContent 消息串中是否存在序号大于 `checkedSeq` 的未检测消息。
 * @param queued 该发送者键当前是否已在待检队列中排队。
 * @param inFlight 该发送者键当前是否有在途的广告检测请求。
 * @returns 排队决策（`enqueue` 或 `skip`）。
 */
export function admitAdRequeue(
  hasUncheckedContent: boolean,
  queued: boolean,
  inFlight: boolean
): AdRequeueDecision {
  if (!hasUncheckedContent) return "skip";
  if (queued || inFlight) return "skip";
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
