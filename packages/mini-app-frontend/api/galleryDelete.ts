import type { MiniAppGalleryDeleteResult } from "../types/miniApp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `DELETE ./api/gallery/file/:fileName` 从图库目录删除指定文件名的单张图片。
 * @param fileName 待删除的图库图片文件名
 * @returns 结构化的删除结果
 */
export async function deleteMiniAppGalleryImageByName(
  fileName: string
): Promise<MiniAppGalleryDeleteResult> {
  return miniAppFetchJson<MiniAppGalleryDeleteResult>(
    `./api/gallery/file/${encodeURIComponent(fileName)}`,
    { method: "DELETE" }
  );
}
