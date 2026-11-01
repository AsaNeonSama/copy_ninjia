import type { MiniAppGalleryPage } from "../types/miniApp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `GET ./api/gallery` 按页码拉取当前配置的图库图片列表。
 * @param page 页码（从 1 开始）
 * @param pageSize 每页张数
 * @returns 图库分页结果
 */
export async function fetchMiniAppGallery(
  page: number, pageSize: number
): Promise<MiniAppGalleryPage> {
  return miniAppFetchJson(`./api/gallery?page=${page}&pageSize=${pageSize}`);
}
