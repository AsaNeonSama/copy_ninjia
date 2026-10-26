import { MINI_APP_SVG_SAFE_FILE_NAME_PATTERN } from "../../consts/miniApp";
import type { ResolvedMiniAppSvgResource } from "../../types/miniApp";

/**
 * 打开 `packages/mini-app-server/resource/` 目录下的静态资源文件句柄（`favicon.ico` 与受保护 SVG 图标）。
 * 调用方负责先校验文件名不含路径分隔符或 `..`。
 * @param fileName 资源目录内的文件名。
 * @returns 指向该资源的 `Bun.BunFile`（文件不存在时 `exists()` 为 `false`）。
 */
export function openMiniAppResourceFile(fileName: string): Bun.BunFile {
  return Bun.file(new URL(`../resource/${fileName}`, import.meta.url));
}

/**
 * 校验并解析 `packages/mini-app-server/resource/` 目录内的受保护 SVG 图标资源文件，防止路径穿越或非 `.svg` 读取。
 * @param rawFileName URL 路径参数中的原始 SVG 文件名。
 * @returns 通过安全校验的 `BunFile`、MIME、字节大小与 `ETag`；文件不存在或文件名不合法时返回 `null`。
 */
export async function readMiniAppSvgResource(
  rawFileName: string
): Promise<Readonly<ResolvedMiniAppSvgResource> | null> {
  let decodedName: string;
  try {
    decodedName = decodeURIComponent(rawFileName).trim();
  } catch (_error: unknown) {
    return null;
  }
  if (
    decodedName.length === 0 ||
    decodedName.includes("..") ||
    !MINI_APP_SVG_SAFE_FILE_NAME_PATTERN.test(decodedName)
  ) {
    return null;
  }
  const file: Bun.BunFile = openMiniAppResourceFile(decodedName);
  if (!(await file.exists())) {
    return null;
  }
  return {
    file,
    mimeType: "image/svg+xml; charset=utf-8",
    sizeBytes: file.size,
    etag: `"svg-${decodedName}-${file.size}"`,
  };
}
