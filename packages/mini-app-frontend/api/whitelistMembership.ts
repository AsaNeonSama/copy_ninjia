import type { MiniAppIdentityMutationResult } from "../types/miniApp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `POST ./api/identities/whitelist` 按数字 ID 添加或移出白名单。
 * @param id 用户正整数 ID 或 `-100...` 频道 ID
 * @param enabled `true` 为加入白名单，`false` 为从白名单移除
 * @returns 名单变更结果
 */
export async function setMiniAppWhitelistMembership(
  id: number, enabled: boolean
): Promise<MiniAppIdentityMutationResult> {
  return miniAppFetchJson("./api/identities/whitelist", {
    method: "POST", body: JSON.stringify({ id, enabled }),
  });
}
