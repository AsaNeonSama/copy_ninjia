import type { MiniAppIdentityMutationResult } from "../types/miniApp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `POST ./api/identities/blocklist` 按数字 ID 加入或移出黑名单。
 * @param id 用户正整数 ID 或 `-100...` 频道 ID
 * @param enabled `true` 为拉黑，`false` 为解封
 * @returns 名单变更结果
 */
export async function setMiniAppBlocklistMembership(
  id: number, enabled: boolean
): Promise<MiniAppIdentityMutationResult> {
  return miniAppFetchJson("./api/identities/blocklist", {
    method: "POST", body: JSON.stringify({ id, enabled }),
  });
}
