import { gagSessionsByChat } from "../../cache/main/gag";
import type { GagSession } from "../../types/gag";

/** 在当前群的小列表中按目标 id 定位会话。 */
export function findGagSession(
  chatId: number,
  targetId: number
): GagSession | undefined {
  const sessions: GagSession[] | undefined = gagSessionsByChat.get(chatId);
  return sessions?.find((session: GagSession): boolean =>
    session.targetId === targetId
  );
}
