/** 待删队列里的一条：删除目标在受管群里发出的一条消息。 */
export interface QueuedTargetMessageDeletion {
  readonly chatId: number;
  readonly messageId: number;
}

/** `/delete_message` 的动作：开始删除目标的新消息，或停止。 */
export type DeleteMessageAction = "start" | "stop";

/** `/delete_message` 参数的解析结果。 */
export interface ParsedDeleteMessageCommand {
  readonly action: DeleteMessageAction;
  /** 动作之后的目标参数原文；没有参数时为空串。 */
  readonly rawTarget: string;
}
