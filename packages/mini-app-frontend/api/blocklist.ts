import type { MiniAppBlocklistPage } from "../types/miniApp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `GET ./api/identities/blocklist` 按页码拉取黑名单列表（含当前页、总页数及黑白名单总条数，支持按名称/用户名/ID 搜索）。
 * @param page 页码（从 1 开始）
 * @param pageSize 每页条数
 * @param query 可选搜索关键字
 * @returns 黑名单分页结果
 */
export async function fetchMiniAppBlocklist(
  page: number, pageSize: number, query: string = ""
): Promise<MiniAppBlocklistPage> {
  const trimmed: string = query.trim();
  const suffix: string = trimmed.length > 0 ? `&query=${encodeURIComponent(trimmed)}` : "";
  return miniAppFetchJson(`./api/identities/blocklist?page=${page}&pageSize=${pageSize}${suffix}`);
}
