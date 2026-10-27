import type {
  MiniAppChatTargetsMutationRequest,
  MiniAppChatTargetsMutationResult,
  MiniAppChatTargetsView,
} from "../types/miniApp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `GET ./api/chats/:chatId/targets` 拉取指定群的问答对、追着删目标与追着翻目标清单。
 * @param chatId 目标群 ID
 * @returns 群目标管理清单视图
 */
export async function fetchMiniAppChatTargets(
  chatId: number
): Promise<MiniAppChatTargetsView> {
  const response: { readonly targets: MiniAppChatTargetsView } =
    await miniAppFetchJson(
      `./api/chats/${encodeURIComponent(String(chatId))}/targets`
    );
  return response.targets;
}

/**
 * 调用 `POST ./api/chats/:chatId/targets` 新增、更新或删除指定群的问答对、追着删目标或追着翻目标。
 * @param chatId 目标群 ID
 * @param payload 变更动作与字段载荷
 * @returns 变更执行结果
 */
export async function mutateMiniAppChatTargets(
  chatId: number,
  payload: Readonly<MiniAppChatTargetsMutationRequest>
): Promise<MiniAppChatTargetsMutationResult> {
  return miniAppFetchJson(
    `./api/chats/${encodeURIComponent(String(chatId))}/targets`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );
}
