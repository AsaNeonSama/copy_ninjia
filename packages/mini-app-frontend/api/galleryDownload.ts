import {
  clearMiniAppSessionToken,
  readMiniAppAssetToken,
  readMiniAppSessionToken,
} from "../libs/credentials";
import { buildMiniAppGalleryDownloadFileName } from "../libs/formatters";
import { asPayloadRecord } from "../libs/record";
import { getTelegramWebApp, readMiniAppInitData } from "../libs/telegram";
import type {
  MiniAppDownloadAnchorElement,
  TelegramWebApp,
  TelegramWindow,
} from "../types/miniApp";
import { buildMiniAppAuthHeaders, syncRefreshedMiniAppSession } from "./request";

/**
 * 构造 `GET|HEAD ./api/gallery/download/:fileName` 图库单张图片附件下载 URL（携带受保护资源令牌或 `initData`，以及 45 分钟 `session` 会话令牌）。
 * @param fileName 图库图片文件名
 * @returns 带完整双层鉴权查询参数的下载 URL
 */
export function buildMiniAppGalleryDownloadUrl(fileName: string): string {
  const encodedName: string = encodeURIComponent(fileName);
  const basePath: string = `./api/gallery/download/${encodedName}`;
  const assetToken: string = readMiniAppAssetToken();
  const initData: string = readMiniAppInitData();
  const sessionToken: string = readMiniAppSessionToken();
  const params: URLSearchParams = new URLSearchParams();
  if (assetToken.length > 0) {
    params.set("token", assetToken);
  } else if (initData.length > 0) {
    params.set("initData", initData);
  }
  if (sessionToken.length > 0) {
    params.set("session", sessionToken);
  }
  const query: string = params.toString();
  return query.length > 0 ? `${basePath}?${query}` : basePath;
}

/**
 * 先通过完整双层鉴权 `HEAD /api/gallery/download/:fileName` 校验 45 分钟会话与文件存在性，随后优先调用 Telegram 原生 `WebApp.downloadFile({ url, file_name })`（或浏览器原生 `Content-Disposition: attachment` 直连下载）并以秒级时间戳文件名将图片保存至系统默认下载目录。
 * @param fileName 待下载的图库图片文件名
 * @returns 用户确认或触发原生下载时返回 `true`，在 Telegram 原生弹窗中取消时返回 `false`
 */
export async function downloadMiniAppGalleryImageByName(fileName: string): Promise<boolean> {
  const relativeUrl: string = buildMiniAppGalleryDownloadUrl(fileName);
  const response: Response = await fetch(relativeUrl, {
    method: "HEAD",
    headers: buildMiniAppAuthHeaders(true),
  });
  syncRefreshedMiniAppSession(response);
  if (!response.ok) {
    const getRes: Response = await fetch(
      `./api/gallery/download/${encodeURIComponent(fileName)}`,
      { method: "GET", headers: buildMiniAppAuthHeaders(true) }
    );
    const payload: unknown = await getRes.json().catch((): null => null);
    const record: Record<string, unknown> = asPayloadRecord(payload);
    const errText: string =
      typeof record.message === "string"
        ? record.message
        : typeof record.error === "string"
          ? record.error
          : `HTTP ${String(response.status)}`;
    if (record.code === "PASSWORD_REQUIRED" || record.code === "PASSWORD_LOCKED") {
      clearMiniAppSessionToken();
      throw new Error(`[${record.code}] ${errText}`, { cause: record });
    }
    throw new Error(errText, { cause: record });
  }
  const downloadFileName: string = buildMiniAppGalleryDownloadFileName(fileName);
  const tgWindow: TelegramWindow = globalThis;
  const baseHref: string | undefined = tgWindow.location?.href;
  const absoluteUrl: string =
    typeof baseHref === "string" && baseHref.length > 0
      ? new URL(relativeUrl, baseHref).href
      : relativeUrl;
  const webApp: Readonly<TelegramWebApp> | undefined = getTelegramWebApp();
  const canUseTelegramNativeDownload: boolean =
    typeof webApp?.downloadFile === "function" &&
    (typeof webApp.isVersionAtLeast !== "function" || webApp.isVersionAtLeast("8.0"));
  if (canUseTelegramNativeDownload && webApp?.downloadFile !== undefined) {
    return await new Promise<boolean>((resolve: (accepted: boolean) => void): void => {
      webApp.downloadFile!(
        { url: absoluteUrl, file_name: downloadFileName },
        (accepted: boolean): void => {
          resolve(accepted);
        }
      );
    });
  }
  if (typeof tgWindow.document?.createElement === "function") {
    const anchor: MiniAppDownloadAnchorElement = tgWindow.document.createElement("a");
    anchor.href = absoluteUrl;
    anchor.download = downloadFileName;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    tgWindow.document.body?.appendChild?.(anchor);
    anchor.click();
    anchor.remove();
  }
  return true;
}
