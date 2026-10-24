/**
 * 广告检测准入判定的输入与决策类型（判定本身见 packages/states/adDetectAdmission.ts，
 * 容器与执行留在 packages/workers/antiRaid/adDetect/queue.ts）。
 */

/** 广告检测候选消息的投递准入判定输入。 */
export interface AdCandidateAdmissionInput {
  /** 清洗、截断并接上隐藏 URL 之后的正文长度；0 表示这条消息没有可判定内容。 */
  readonly textLength: number;
  /** 发送者是否为频道或匿名管理员身份（无群成员身份，处置走 banChatSenderChat）。 */
  readonly isChannel: boolean;
  /** 去重 TTL 窗口内该发送者键是否已被判为广告并发出处置。 */
  readonly recentlyDisposed: boolean;
  /** 主线程投递时该发送者是否已在永久黑名单中。 */
  readonly blocked: boolean;
}

/** 广告检测候选消息的投递准入决策。 */
export type AdCandidateDecision =
  /** 并入该发送者的待检消息串。 */
  | "accept"
  /** 忽略该消息，不参与检测且不单独删除。 */
  | "ignore"
  /** 不参与检测，但单独删除该频道残余消息（见 states/adDetectAdmission.ts）。 */
  | "deleteStraggler";

/** 发送者待检消息串的入队准入判定输入。 */
export interface AdRequeueInput {
  /** 消息串中是否存在序号大于 checkedSeq 的未检测消息。 */
  readonly hasUncheckedContent: boolean;
  /** 该发送者键当前是否已在待检队列中排队。 */
  readonly queued: boolean;
  /** 该发送者键当前是否有在途的广告检测模型请求。 */
  readonly inFlight: boolean;
}

/** 发送者待检消息串的入队准入决策。 */
export type AdRequeueDecision =
  /** 将该发送者键加入待检队列。 */
  | "enqueue"
  /** 跳过入队：无新内容，或该发送者键已在队列中或在途。 */
  | "skip";
