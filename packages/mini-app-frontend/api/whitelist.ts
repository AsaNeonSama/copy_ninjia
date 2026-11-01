import type { MiniAppWhitelistPage } from "../types/miniApp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `GET ./api/identities/whitelist` 按页码拉取白名单与权限矩阵列表（含当前页、总页数及黑白名单总条数，支持按名称/用户名/ID 搜索）。
 * @param page 页码（从 1 开始）
 * @param pageSize 每页条数
 * @param query 可选搜索关键字
 * @returns 白名单分页结果
 */
export async function fetchMiniAppWhitelist(
  page: number, pageSize: number, query: string = ""
): Promise<MiniAppWhitelistPage> {
  const trimmed: string = query.trim();
  const suffix: string = trimmed.length > 0 ? `&query=${encodeURIComponent(trimmed)}` : "";
  return miniAppFetchJson(`./api/identities/whitelist?page=${page}&pageSize=${pageSize}${suffix}`);
}
