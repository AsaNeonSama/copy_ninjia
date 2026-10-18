/** 触发的种类，决定并发闸打满时是丢弃还是排队，见 admitTrigger。 */
export type TriggerKind =
  /** 文字或媒体直接回复 / @ 机器人：真人在等，打满时排队补跑。 */
  | "direct"
  /** 无人叫机器人的文字或媒体随机插话：打满时直接丢弃。 */
  | "random";

export interface AdmitTriggerInput {
  activeRounds: number;
  queueSize: number;
  kind: TriggerKind;
  telegramBackpressured: boolean;
  /** 该群的直接轮仍在模型阶段（见 workers/aiChat/replyDelivery.ts 的 isDirectReplyModelActive）。 */
  directRoundActive: boolean;
  /** 当前群与 Worker 的存活回复轮次均未耗尽容量。 */
  deliveryAvailable: boolean;
}

export type AdmitDecision =
  /** 模型与存活容量均允许且等待队列为空：立即开新轮。 */
  | "startRound"
  /** 直接触发暂不能启动且队列有空位：入队等补跑。 */
  | "enqueue"
  /** 随机触发因并发、容量、排队或出站压力受阻：静默丢弃。 */
  | "dropSilently"
  /** 直接触发的等待队列已满：丢弃并登记溢出提示。 */
  | "enqueueOverflow";
