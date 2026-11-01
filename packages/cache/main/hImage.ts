/** owner: main。`/h_image` 命令限流状态与图库目录缓存（packages/commands/hImage.ts、packages/infra/imageGallery.ts）。 */

import { H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW } from "../../consts/hImage";
import { TimestampDeque } from "../../libs/timestampDeque";
import type {
  RandomImageDirectoryCache,
  RandomImageGalleryCache,
} from "../../types/imageGallery";

/**
 * `/h_image` 全局滑动窗口调用时间戳队列（窗口长度 H_IMAGE_RATE_LIMIT_WINDOW_MS）：每次判定时先淘汰滑出窗口的队首时间戳，未满额时写入当前时间戳。
 * 容量固定为 H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW；进程重启后从空队列开始。
 */
export const recentHImageCallTimestamps: TimestampDeque =
  new TimestampDeque(H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW);

/**
 * 随机图库目录的字典序文件名缓存 holder（供启动校验、`/h_image` 与定时任务抽图、`readRandomImageLibrary` 计数使用）：
 * - 填充时机：启动或热重载执行 `ensureRandomImageDirectory` 时读取目录并按字典序升序排列后填充；若访问尚未缓存的目录，在首次读取时按 `readdir` + 字典序升序排序填充。
 * - 清理与更新时机：`storeRandomImage` 入库或核对已存在图片时按二分查找插入 `names`；`deleteRandomImageFile` 删除图片，或 `storeRandomImage`、`pickRandomImage`、`statRandomImageFile` 探测到文件消失或非普通文件时按二分查找从 `names` 移除；`isRandomImageDirectory`、`pickRandomImage`、`listRandomImageGalleryEntries` 探测到目录缺失或切换目录时置 `null` 或替换。
 * - Worker 崩溃重建方式：主线程独占内存状态，不涉及 Worker；进程重启后由启动阶段 `ensureRandomImageDirectory` 重建。
 * - 容量及清理策略：容量等于当前图库目录内有效图片文件数，随图库增删同步维护。
 */
export const randomImageDirectoryCache: {
  current: RandomImageDirectoryCache | null;
} = {
  current: null,
};

/**
 * Mini App 图库分页专用的按修改时间降序缓存 holder（供 `listRandomImageGalleryEntries` / `listMiniAppGalleryPage` 分页读取）：
 * - 填充时机：启动或热重载执行 `ensureRandomImageDirectory` 时读取目录文件修改时间并按从新到老（降序）排列后填充；若访问尚未缓存的目录，在首次调用 `listRandomImageGalleryEntries` 时按 `readdir` + `lstat` 修改时间降序填充。
 * - 清理与更新时机：`storeRandomImage` 新增或补齐图片时按修改时间降序二分插入 `entries`（新写入图片排在同修改时间已有项之前）；`deleteRandomImageFile` 删除图片，或 `storeRandomImage`、`pickRandomImage`、`statRandomImageFile` 探测到文件消失或非普通文件时从 `entries` 移除；`isRandomImageDirectory`、`pickRandomImage`、`listRandomImageGalleryEntries` 探测到目录缺失或切换目录时置 `null` 或替换。
 * - Worker 崩溃重建方式：主线程独占内存状态，不涉及 Worker；进程重启后由启动阶段 `ensureRandomImageDirectory` 或首次图库分页请求重建。
 * - 容量及清理策略：容量等于当前图库目录内有效图片文件数，随图库增删同步维护。
 */
export const randomImageGalleryCache: {
  current: RandomImageGalleryCache | null;
} = {
  current: null,
};
