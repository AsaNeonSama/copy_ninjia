import { MINI_APP_DOWNLOAD_OBJECT_URL_REVOKE_DELAY_MS } from "../consts/miniApp";
import {
  readMiniAppAssetToken,
  readMiniAppSessionToken,
} from "../libs/credentials";
import { asPayloadRecord } from "../libs/record";
import { getTelegramWebApp, readMiniAppInitData } from "../libs/telegram";
import type {
  MiniAppDownloadAnchorElement,
  TelegramWebApp,
  TelegramWindow,
} from "../types/miniApp";
import {
  buildMiniAppAuthHeaders,
  consumeMiniAppAuthErrorPrefix,
  syncRefreshedMiniAppSession,
} from "./request";

/**
 * 构造交给 Telegram 原生下载器直连的 `GET ./api/gallery/download/:fileName` 图库单张图片附件下载 URL（原生下载器无法附加请求头，凭据经查询参数携带：受保护资源令牌或 `initData`，以及 45 分钟 `session` 会话令牌）。
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
 * 读取附件下载接口的失败响应并抛出错误：会话缺失或锁定时先清除本地会话令牌并在消息前加 `[代号] ` 前缀。
 * @param response 非 2xx 的下载接口响应（`HEAD` 响应无响应体时传入补发的 `GET` 响应）
 * @param fallbackStatus 响应体无说明时写入错误消息的 HTTP 状态码
 */
async function throwGalleryDownloadError(
  response: Response,
  fallbackStatus: number
): Promise<never> {
  const payload: unknown = await response.json().catch((): null => null);
  const record: Record<string, unknown> = asPayloadRecord(payload);
  const prefix: string = consumeMiniAppAuthErrorPrefix(record);
  const errText: string =
    typeof record.message === "string"
      ? record.message
      : typeof record.error === "string"
        ? record.error
        : `HTTP ${String(fallbackStatus)}`;
  throw new Error(`${prefix}${errText}`, { cause: record });
}

/**
 * 以给定的目标文件名把图库图片保存至系统默认下载目录；全程以请求头携带 `initData` 与 45 分钟会话令牌鉴权：
 * - 支持 Telegram 原生 `WebApp.downloadFile`（Bot API 8.0+）时，先以 `HEAD /api/gallery/download/:fileName` 校验会话与文件存在性，
 *   在其响应同步可能刷新的会话令牌之后再构造带查询参数凭据的下载 URL 交给原生下载器；
 * - 否则以 `GET` 取回图片字节，生成 `blob:` 对象 URL 经隐藏链接触发保存，并在 `MINI_APP_DOWNLOAD_OBJECT_URL_REVOKE_DELAY_MS` 后释放。
 * @param fileName 待下载的图库图片文件名
 * @param downloadFileName 保存至本地的目标文件名
 * @returns 用户确认或已触发保存时返回 `true`，在 Telegram 原生弹窗中取消时返回 `false`
 */
export async function downloadMiniAppGalleryImageByName(
  fileName: string,
  downloadFileName: string
): Promise<boolean> {
  const basePath: string = `./api/gallery/download/${encodeURIComponent(fileName)}`;
  const tgWindow: TelegramWindow = globalThis;
  const webApp: Readonly<TelegramWebApp> | undefined = getTelegramWebApp();
  const nativeDownloadFile: TelegramWebApp["downloadFile"] =
    typeof webApp?.downloadFile === "function" &&
    (typeof webApp.isVersionAtLeast !== "function" || webApp.isVersionAtLeast("8.0"))
      ? webApp.downloadFile
      : undefined;

  if (nativeDownloadFile !== undefined) {
    const probe: Response = await fetch(basePath, {
      method: "HEAD",
      headers: buildMiniAppAuthHeaders(true),
    });
    syncRefreshedMiniAppSession(probe);
    if (!probe.ok) {
      const detail: Response = await fetch(basePath, {
        method: "GET",
        headers: buildMiniAppAuthHeaders(true),
      });
      return throwGalleryDownloadError(detail, probe.status);
    }
    const relativeUrl: string = buildMiniAppGalleryDownloadUrl(fileName);
    const baseHref: string | undefined = tgWindow.location?.href;
    const absoluteUrl: string =
      typeof baseHref === "string" && baseHref.length > 0
        ? new URL(relativeUrl, baseHref).href
        : relativeUrl;
    return await new Promise<boolean>((resolve: (accepted: boolean) => void): void => {
      nativeDownloadFile.call(
        webApp,
        { url: absoluteUrl, file_name: downloadFileName },
        (accepted: boolean): void => {
          resolve(accepted);
        }
      );
    });
  }

  const response: Response = await fetch(basePath, {
    method: "GET",
    headers: buildMiniAppAuthHeaders(true),
  });
  syncRefreshedMiniAppSession(response);
  if (!response.ok) {
    return throwGalleryDownloadError(response, response.status);
  }
  const objectUrl: string = URL.createObjectURL(await response.blob());
  if (typeof tgWindow.document?.createElement === "function") {
    const anchor: MiniAppDownloadAnchorElement = tgWindow.document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = downloadFileName;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    tgWindow.document.body?.appendChild?.(anchor);
    anchor.click();
    anchor.remove();
  }
  setTimeout((): void => {
    URL.revokeObjectURL(objectUrl);
  }, MINI_APP_DOWNLOAD_OBJECT_URL_REVOKE_DELAY_MS);
  return true;
}
