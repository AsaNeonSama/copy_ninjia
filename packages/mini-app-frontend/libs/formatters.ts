import { MINI_APP_BIDI_CONTROL_CHARS_PATTERN } from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { WhitelistPermissionKey } from "../types/identityPolicy";
import type {
  MiniAppFeatureDisplayMeta,
  MiniAppFeatureKey,
  MiniAppLanguage,
} from "../types/miniApp";

/**
 * 清除昵称或用户名中的 Unicode 双向文本控制字符（RLO/LRO/PDF 等），防止单条昵称反转整行 UI 布局。
 *
 * @param raw 原始文本
 * @returns 剥离双向控制字符后的安全展示文本
 */
export function sanitizeBidiText(raw: string): string {
  return raw.replace(MINI_APP_BIDI_CONTROL_CHARS_PATTERN, "");
}

/**
 * 对过长的群聊名称、用户昵称或文件名进行安全字符级截断（先剥离双向控制字符再按码点截断，避免拆碎代理对）。
 *
 * @param raw 原始文本
 * @param maxChars 最大保留字符数（默认 `20`）
 * @returns 截断后的安全展示文本
 */
export function truncateDisplayText(raw: string, maxChars: number = 20): string {
  const clean: string = sanitizeBidiText(raw).trim();
  if (clean.length <= maxChars) return clean;
  const chars: string[] = Array.from(clean);
  if (chars.length <= maxChars) return clean;
  return `${chars.slice(0, Math.max(1, maxChars)).join("")}…`;
}

/**
 * 构造以秒级 Unix 时间戳命名的图库图片下载文件名（保留原文件扩展名，如 `1792934000.png`）。
 * 与 `packages/mini-app-server/libs/downloadFileName.ts` 的同名函数输出一致，由 `test/miniApp/frontendParity.test.ts` 核对。
 *
 * @param fileName 图库图片原始 SHA-256 文件名
 * @param nowMs 可选当前毫秒时间戳（默认 `Date.now()`）
 * @returns 秒级时间戳加扩展名的下载文件名
 */
export function buildMiniAppGalleryDownloadFileName(
  fileName: string,
  nowMs: number = Date.now()
): string {
  const dotIndex: number = fileName.lastIndexOf(".");
  const ext: string =
    dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : ".jpg";
  const timestampSec: number = Math.max(0, Math.floor(nowMs / 1000));
  return `${timestampSec}${ext}`;
}

/**
 * 将运行时长毫秒数格式化为易读的中文天/时/分/秒文本。
 *
 * @param uptimeMs 运行时长毫秒数
 * @returns 格式化后的时长字符串
 */
export function formatUptime(uptimeMs: number): string {
  const totalSeconds: number = Math.max(0, Math.floor(uptimeMs / 1000));
  const days: number = Math.floor(totalSeconds / 86_400);
  const hours: number = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes: number = Math.floor((totalSeconds % 3600) / 60);
  const seconds: number = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/**
 * 将字节数格式化为 MiB 文本。
 *
 * @param bytes 字节数
 * @returns 以 MiB 为单位的文本
 */
export function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * 将内存字节数格式化为保留 2 位小数的 MB 文本（如 `128.45 MB`）。
 *
 * @param bytes 内存字节数
 * @returns 以 MB 为单位且保留 2 位小数的格式化文本
 */
export function formatMemoryMb(bytes: number): string {
  const safeBytes: number = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return `${(safeBytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 将图库单张图片字节数格式化为 KiB 或 MiB 文本。
 *
 * @param bytes 文件字节数
 * @returns 格式化后的文件体积文本
 */
export function formatGalleryFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * 将 64 位 SHA-256 图库文件名缩略为首尾摘要加扩展名（如 `00493093…12c2.jpg`），便于网格卡片单行展示。
 *
 * @param fileName 原始图库文件名
 * @returns 缩略后的文件名展示文本
 */
export function shortenGalleryFileName(fileName: string): string {
  const dotIndex: number = fileName.lastIndexOf(".");
  if (dotIndex <= 16) return fileName;
  const stem: string = fileName.slice(0, dotIndex);
  const ext: string = fileName.slice(dotIndex);
  return `${stem.slice(0, 8)}…${stem.slice(-6)}${ext}`;
}

/**
 * 将 Unix 毫秒时间戳格式化为本地日期时间字符串。
 *
 * @param timestampMs Unix 毫秒时间戳
 * @returns 本地时间字符串
 */
export function formatTime(timestampMs: number): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "-";
  return new Date(timestampMs).toLocaleString("zh-CN", { hour12: false });
}

/**
 * 根据群功能键返回指定语言的前端展示标题、命令名与功能描述。
 *
 * @param key 群功能开关枚举键
 * @param language 界面语言（默认 `"zh"`）
 * @returns 展示元数据
 */
export function getFeatureDisplayMeta(
  key: MiniAppFeatureKey,
  language: MiniAppLanguage = "zh"
): MiniAppFeatureDisplayMeta {
  return getMiniAppTranslations(language).chats.featureMeta[key];
}

/**
 * 根据白名单权限键返回指定语言的展示名称。
 *
 * @param key 白名单权限键
 * @param language 界面语言（默认 `"zh"`）
 * @returns 权限展示名称
 */
export function getPermissionDisplayLabel(
  key: WhitelistPermissionKey,
  language: MiniAppLanguage = "zh"
): string {
  return getMiniAppTranslations(language).permissionDrawer.labels[key];
}
