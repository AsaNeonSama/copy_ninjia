import { evictCachedMiniAppGalleryImage } from "../libs/galleryImageCache";
import type { MiniAppGalleryDeleteResult } from "../types/miniApp/gallery";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `POST ./api/gallery/delete` 从图库目录删除指定文件名的单张图片，
 * 删除成功时同步驱逐前端本地 7 天协商缓存中的对应图片条目。
 *
 * @param fileName 待删除的图库图片文件名
 * @returns 结构化的删除结果
 */
export async function deleteMiniAppGalleryImageByName(
  fileName: string
): Promise<MiniAppGalleryDeleteResult> {
  const result: MiniAppGalleryDeleteResult =
    await miniAppFetchJson<MiniAppGalleryDeleteResult>(
      "./api/gallery/delete",
      {
        method: "POST",
        body: JSON.stringify({ fileName }),
      }
    );
  if (result.ok) {
    await evictCachedMiniAppGalleryImage(fileName);
  }
  return result;
}
