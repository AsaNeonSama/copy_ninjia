import type { WhitelistPermissionKey } from "../types/identityPolicy";
import type { MiniAppIdentityMutationResult } from "../types/miniApp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `POST ./api/identities/permission` 修改白名单条目的单项权限开关或一键开启全部权限。
 * @param id 目标白名单 ID
 * @param permission 权限键或 `"all"`
 * @param enabled 目标布尔状态
 * @returns 权限变更结果
 */
export async function updateMiniAppWhitelistPermission(
  id: number, permission: WhitelistPermissionKey | "all", enabled: boolean
): Promise<MiniAppIdentityMutationResult> {
  const body: Record<string, unknown> =
    permission === "all" ? { id, enableAll: true } : { id, key: permission, value: enabled };
  return miniAppFetchJson("./api/identities/permission", {
    method: "POST", body: JSON.stringify(body),
  });
}
