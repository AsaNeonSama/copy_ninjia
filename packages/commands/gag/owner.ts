import { gagSessionsByChat } from "../../cache/main/gag";
import type { GagSession } from "../../types/gag";

/**
 * 在当前群的小列表中按目标 id 定位会话。
 * @param chatId 目标群 ID。
 * @param targetId 目标用户或频道 ID。
 * @returns 命中的 gag 会话；未找到时返回 undefined。
 */
export function findGagSession(
  chatId: number,
  targetId: number
): GagSession | undefined {
  const sessions: GagSession[] | undefined = gagSessionsByChat.get(chatId);
  return sessions?.find((session: GagSession): boolean =>
    session.targetId === targetId
  );
}
