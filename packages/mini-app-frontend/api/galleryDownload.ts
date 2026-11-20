import { MINI_APP_DOWNLOAD_OBJECT_URL_REVOKE_DELAY_MS } from "../consts/miniApp";
import { MINI_APP_DOWNLOAD_TICKET_PARAM } from "../consts/miniAppCrypto";
import { getTelegramWebApp } from "../libs/telegram";
import type { MiniAppGalleryDownloadTicketResponse } from "../types/miniApp/gallery";
import type {
  MiniAppDownloadAnchorElement,
  TelegramWebApp,
  TelegramWindow,
} from "../types/miniApp/host";
import { throwMiniAppRecordError } from "./authError";
import {
  buildMiniAppAuthHeaders,
  miniAppFetchJson,
  prepareEncryptedMiniAppQueryRequest,
  syncRefreshedMiniAppSession,
} from "./request";
import type { PreparedEncryptedMiniAppQueryRequest } from "./request";

/**
 * 在支持 Telegram 原生 `WebApp.downloadFile`（Bot API 8.0+）的环境中，
 * 先通过端到端加密的 `POST ./api/gallery/download-ticket` 向服务端申请一枚 60 秒单次消费下载票据，
 * 再组装仅含 `?ticket=<64-hex>` 的安全下载相对路径（不传递 `initData`、会话令牌或会话密钥）。
 *
 * @param fileName 待下载的图库图片文件名
 * @returns 带 `?ticket=` 的相对下载路径与服务端签发的安全下载文件名
 */
async function requestMiniAppGalleryTicketDownload(
  fileName: string
): Promise<Readonly<{ relativeUrl: string; downloadFileName: string }>> {
  const issued: MiniAppGalleryDownloadTicketResponse =
    await miniAppFetchJson<MiniAppGalleryDownloadTicketResponse>(
      "./api/gallery/download-ticket",
      {
        method: "POST",
        body: JSON.stringify({ fileName }),
      }
    );
  return {
    relativeUrl:
      `./api/gallery/download?${MINI_APP_DOWNLOAD_TICKET_PARAM}=` +
      `${encodeURIComponent(issued.ticket)}`,
    downloadFileName: issued.downloadFileName,
  };
}

/**
 * 以给定的目标文件名把图库图片保存至系统默认下载目录：
 * - 支持 Telegram 原生 `WebApp.downloadFile`（Bot API 8.0+）时，先通过 `POST ./api/gallery/download-ticket`
 *   获取 60 秒一次性下载票据（同步完成会话校验与滑动密钥轮换），再将不含会话凭据的 `?ticket=` URL 交给原生下载器；
 * - 否则以带请求头双层会话鉴权与 `?e=` 加密查询参数的 `GET ./api/gallery/download` 拉取原图字节，
 *   生成 `blob:` 对象 URL 经隐藏链接触发保存，并在 `MINI_APP_DOWNLOAD_OBJECT_URL_REVOKE_DELAY_MS` 后释放。
 *
 * @param fileName 待下载的图库图片文件名
 * @param downloadFileName 保存至本地的目标文件名
 * @returns 用户确认或已触发保存时返回 `true`，在 Telegram 原生弹窗中取消时返回 `false`
 */
export async function downloadMiniAppGalleryImageByName(
  fileName: string,
  downloadFileName: string
): Promise<boolean> {
  const tgWindow: TelegramWindow = globalThis;
  const webApp: Readonly<TelegramWebApp> | undefined = getTelegramWebApp();
  const nativeDownloadFile: TelegramWebApp["downloadFile"] =
    typeof webApp?.downloadFile === "function" &&
    (typeof webApp.isVersionAtLeast !== "function" || webApp.isVersionAtLeast("8.0"))
      ? webApp.downloadFile
      : undefined;

  if (nativeDownloadFile !== undefined) {
    const ticketDownload: Readonly<{ relativeUrl: string; downloadFileName: string }> =
      await requestMiniAppGalleryTicketDownload(fileName);
    const baseHref: string | undefined = tgWindow.location?.href;
    const absoluteUrl: string =
      typeof baseHref === "string" && baseHref.length > 0
        ? new URL(ticketDownload.relativeUrl, baseHref).href
        : ticketDownload.relativeUrl;
    const effectiveFileName: string =
      ticketDownload.downloadFileName || downloadFileName;
    return await new Promise<boolean>((resolve: (accepted: boolean) => void): void => {
      nativeDownloadFile.call(
        webApp,
        { url: absoluteUrl, file_name: effectiveFileName },
        (accepted: boolean): void => {
          resolve(accepted);
        }
      );
    });
  }

  const rawQuery: string = `fileName=${encodeURIComponent(fileName)}`;
  const {
    outboundPath,
    sentSessionToken,
  }: PreparedEncryptedMiniAppQueryRequest =
    await prepareEncryptedMiniAppQueryRequest(
      "./api/gallery/download",
      rawQuery,
      "GET"
    );
  const response: Response = await fetch(outboundPath, {
    method: "GET",
    headers: buildMiniAppAuthHeaders(true, undefined, sentSessionToken),
  });
  syncRefreshedMiniAppSession(response);
  if (!response.ok) {
    const payload: unknown = await response.json().catch((): null => null);
    return throwMiniAppRecordError(payload, response.status, sentSessionToken);
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
