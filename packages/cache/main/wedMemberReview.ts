/** owner: main。`/wed` 每日成员复核状态（packages/commands/wed/memberReview.ts）。 */
import type { WedMemberReview } from "../../types/wed";

/**
 * 每日成员复核运行时单例：initWedRuntime 创建，Bot 就绪后接纳午夜维护通知并逐群逐成员探测（探测期间填充当前 chatId/userId，单次查询结算后清空），停机时取消等待与在途请求并由 wedRuntime 排空。
 * 单例对象（每群复核快照上限 WED_MEMBER_LIMIT），不淘汰；进程重启后从 null 重新创建。
 */
export const wedMemberReview: { current: WedMemberReview | null } = { current: null };

/**
 * 群消息或成员状态更新命中当前正在探测的群成员时标记为仍在群。
 *
 * @param chatId 群聊 ID
 * @param userId 成员用户 ID
 */
export function noteWedMemberPresence(chatId: number, userId: number): void {
  const review: WedMemberReview | null = wedMemberReview.current;
  if (review?.chatId === chatId && review.userId === userId) review.observed = true;
}
