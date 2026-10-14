/** owner: workers/aiChat。回复机器人图片时等待识图回填的 Promise 登记表（packages/workers/aiChat/botImages.ts）。 */

/**
 * 群 ID 到回复消息 ID 再到识图回填完成 Promise 的映射：resolveRepliedBotImage 记录回复机器人图片时登记，供 replyRound.ts 拼装提示词前等待，Promise 结算时按身份删除（内层表空时移除外层键），按群失效或 resetAiChatBotImageCache 时清除。
 * 容量受 mediaTasks.ts 有界执行器并发与排队上限约束，不设 TTL 淘汰；Worker 重建后从空表开始。
 */
export const repliedBotImageBackfills: Map<number, Map<number, Promise<void>>> = new Map();

/** 清空全部群的机器人图片识图回填等待表。 */
export function resetAiChatBotImageCache(): void {
  repliedBotImageBackfills.clear();
}
