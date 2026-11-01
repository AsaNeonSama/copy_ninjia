/**
 * Mini App 前端会话与传输：图库附件下载的两条保存路径、选择器回执轮询的失败处理，
 * 以及服务端会话到期时刻按响应 `Date` 头换算为本机时刻。`fetch` 按「方法 + 路径 + 查询串」路由到测试夹具。
 */

import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { precheckMiniAppAccess } from "../../packages/mini-app-frontend/api/authPrecheck";
import { downloadMiniAppGalleryImageByName } from "../../packages/mini-app-frontend/api/galleryDownload";
import { waitForMiniAppPickerResult } from "../../packages/mini-app-frontend/api/pickerResult";
import { miniAppFetchJson, toLocalEpochMs } from "../../packages/mini-app-frontend/api/request";
import {
  MINI_APP_DOWNLOAD_OBJECT_URL_REVOKE_DELAY_MS,
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_SESSION_EXPIRES_AT_HEADER,
  MINI_APP_SESSION_HEADER,
} from "../../packages/mini-app-frontend/consts/miniApp";
import {
  clearMiniAppAssetToken,
  clearMiniAppSessionToken,
  readMiniAppSessionExpiresAt,
  readMiniAppSessionToken,
  setMiniAppSessionToken,
} from "../../packages/mini-app-frontend/libs/credentials";
import { buildMiniAppGalleryDownloadFileName } from "../../packages/mini-app-frontend/libs/formatters";

/** 一次被记录的请求。 */
interface RecordedRequest {
  readonly key: string;
  readonly body: string | null;
  readonly headers: Readonly<Record<string, string>>;
}

const requests: RecordedRequest[] = [];
const responses: Map<string, () => Response> = new Map<string, () => Response>();
const originalFetch: typeof fetch = globalThis.fetch;
const session: string = "e".repeat(64);

beforeEach((): void => {
  requests.length = 0;
  responses.clear();
  (globalThis as { Telegram?: unknown }).Telegram = { WebApp: { initData: "signed-init-data" } };
  setMiniAppSessionToken(session, Date.now() + 60_000);
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url: URL = new URL(String(input), "http://mini.test/");
    const key: string = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}${url.search}`;
    requests.push({
      key,
      body: typeof init?.body === "string" ? init.body : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return responses.get(key)?.() ?? Response.json({ ok: true, result: null, items: [], detail: null });
  }) as typeof fetch;
});

afterEach((): void => {
  globalThis.fetch = originalFetch;
  (globalThis as { Telegram?: unknown }).Telegram = undefined;
  (globalThis as { document?: unknown }).document = undefined;
  clearMiniAppSessionToken();
  clearMiniAppAssetToken();
});

describe("会话与传输", () => {
  test("附件下载：原生下载器先以请求头 HEAD 核验并在同步刷新令牌后构造 URL；不支持原生下载时以请求头 GET 取回字节经 blob 链接保存；核验失败时以服务端说明报错", async () => {
    const downloads: { readonly url: string; readonly file_name: string }[] = [];
    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: {
        initData: "signed-init-data",
        isVersionAtLeast: (): boolean => true,
        downloadFile: (params: { readonly url: string; readonly file_name: string }, callback: (accepted: boolean) => void): void => {
          downloads.push(params);
          callback(false);
        },
      },
    };
    const refreshedSession: string = "f".repeat(64);
    responses.set("HEAD /api/gallery/download/a.png", (): Response =>
      new Response(null, {
        status: 200,
        headers: {
          [MINI_APP_SESSION_HEADER]: refreshedSession,
          [MINI_APP_SESSION_EXPIRES_AT_HEADER]: String(Date.now() + 60_000),
        },
      }));
    const aDownloadName: string = buildMiniAppGalleryDownloadFileName("a.png");
    expect(await downloadMiniAppGalleryImageByName("a.png", aDownloadName)).toBeFalse();
    expect(requests[0]?.key).toBe("HEAD /api/gallery/download/a.png");
    expect(requests[0]?.headers[MINI_APP_SESSION_HEADER]).toBe(session);
    expect(requests[0]?.headers[MINI_APP_INIT_DATA_HEADER]).toBe("signed-init-data");
    expect(downloads[0]?.file_name).toBe(aDownloadName);
    const nativeUrl: URL = new URL(downloads[0]!.url, "http://mini.test/");
    expect(nativeUrl.pathname).toBe("/api/gallery/download/a.png");
    expect(nativeUrl.searchParams.get("session")).toBe(refreshedSession);

    jest.useFakeTimers();
    const revokeSpy = spyOn(URL, "revokeObjectURL");
    try {
      const anchors: Record<string, unknown>[] = [];
      (globalThis as { Telegram?: unknown }).Telegram = { WebApp: { initData: "signed-init-data" } };
      (globalThis as { document?: unknown }).document = {
        getElementById: (): null => null,
        createElement: (): Record<string, unknown> => {
          const anchor: Record<string, unknown> = { style: {}, clicks: 0 };
          anchor.click = (): void => {
            anchor.clicks = Number(anchor.clicks) + 1;
          };
          anchor.remove = (): void => {};
          anchors.push(anchor);
          return anchor;
        },
        body: { appendChild: (): void => {} },
      };
      responses.set("GET /api/gallery/download/b.webp", (): Response =>
        new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/webp" } }));
      const bDownloadName: string = buildMiniAppGalleryDownloadFileName("b.webp");
      expect(await downloadMiniAppGalleryImageByName("b.webp", bDownloadName)).toBeTrue();
      expect(requests.at(-1)?.key).toBe("GET /api/gallery/download/b.webp");
      expect(requests.at(-1)?.headers[MINI_APP_SESSION_HEADER]).toBe(refreshedSession);
      expect(anchors).toHaveLength(1);
      expect(String(anchors[0]?.href)).toStartWith("blob:");
      expect(anchors[0]?.download).toBe(bDownloadName);
      expect(anchors[0]?.clicks).toBe(1);
      expect(revokeSpy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(MINI_APP_DOWNLOAD_OBJECT_URL_REVOKE_DELAY_MS);
      expect(revokeSpy).toHaveBeenCalledWith(anchors[0]?.href);

      responses.set("GET /api/gallery/download/gone.png", (): Response =>
        Response.json({ error: "Image not found" }, { status: 404 }));
      await expect(
        downloadMiniAppGalleryImageByName("gone.png", buildMiniAppGalleryDownloadFileName("gone.png"))
      ).rejects.toThrow("Image not found");
      expect(anchors).toHaveLength(1);
    } finally {
      revokeSpy.mockRestore();
      jest.useRealTimers();
    }

    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: { initData: "signed-init-data", downloadFile: (): void => {} },
    };
    responses.set("HEAD /api/gallery/download/c.png", (): Response =>
      new Response(null, { status: 401 }));
    responses.set("GET /api/gallery/download/c.png", (): Response =>
      Response.json({ code: "PASSWORD_REQUIRED", error: "login again" }, { status: 401 }));
    await expect(
      downloadMiniAppGalleryImageByName("c.png", buildMiniAppGalleryDownloadFileName("c.png"))
    ).rejects.toThrow("login again");
    expect(readMiniAppSessionToken()).toBe("");
  });

  test("选择器回执轮询：单次查询失败继续轮询直至收到回执，会话失效立即抛出", async () => {
    let calls: number = 0;
    responses.set("GET /api/picker/result?requestId=5", (): Response => {
      calls += 1;
      return calls === 1
        ? Response.json({ error: "bad gateway" }, { status: 502 })
        : Response.json({ result: { requestId: 5, summary: "PICKER_IMPORT_ADDED", addedIds: [1] } });
    });
    const outcome = await waitForMiniAppPickerResult(5);
    expect(outcome).not.toBe("timeout");
    expect(outcome !== "timeout" ? outcome.requestId : null).toBe(5);
    expect(calls).toBe(2);

    responses.set("GET /api/picker/result?requestId=6", (): Response =>
      Response.json({ code: "PASSWORD_REQUIRED", error: "PASSWORD_REQUIRED" }, { status: 401 }));
    await expect(waitForMiniAppPickerResult(6)).rejects.toThrow("[PASSWORD_REQUIRED]");
    expect(requests.filter((request: RecordedRequest): boolean =>
      request.key === "GET /api/picker/result?requestId=6")).toHaveLength(1);
  });

  test("服务端会话到期时刻按响应 Date 头换算为本机时刻：本机时钟大幅偏离时预检与令牌刷新仍按服务端剩余时长判定", async () => {
    const skewMs: number = 2 * 3_600_000;
    const serverNow: number = Date.now() + skewMs;
    const plainResponse: Response = new Response(null);
    expect(toLocalEpochMs(12_345, plainResponse)).toBe(12_345);

    responses.set("GET /api/auth/precheck", (): Response =>
      Response.json(
        { ok: true, ttlMs: 2_700_000, sessionValid: true, sessionExpiresAt: serverNow + 30 * 60_000 },
        { headers: { Date: new Date(serverNow).toUTCString() } }
      ));
    const result = await precheckMiniAppAccess();
    expect(result.ok && result.sessionValid === true).toBeTrue();
    const localExpiresAt: number = result.ok ? result.sessionExpiresAt ?? 0 : 0;
    expect(Math.abs(localExpiresAt - (Date.now() + 30 * 60_000))).toBeLessThan(2_000);
    expect(readMiniAppSessionExpiresAt()).toBe(localExpiresAt);

    const lateServerNow: number = Date.now() - skewMs;
    const refreshedSession: string = "a".repeat(64);
    responses.set("GET /api/status", (): Response =>
      Response.json({ ok: true }, {
        headers: {
          Date: new Date(lateServerNow).toUTCString(),
          [MINI_APP_SESSION_HEADER]: refreshedSession,
          [MINI_APP_SESSION_EXPIRES_AT_HEADER]: String(lateServerNow + 45 * 60_000),
        },
      }));
    await miniAppFetchJson("/api/status");
    expect(readMiniAppSessionToken()).toBe(refreshedSession);
    expect(Math.abs(readMiniAppSessionExpiresAt() - (Date.now() + 45 * 60_000))).toBeLessThan(2_000);
  });

});
