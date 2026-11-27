/**
 * Mini App 前端会话与传输：图库附件下载的两条保存路径、选择器回执轮询的失败处理，
 * 以及服务端会话到期时刻按响应 `Date` 头换算为本机时刻。`fetch` 按「方法 + 路径 + 查询串」路由到测试夹具。
 */

import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import {
  classifyMiniAppAuthError,
  isSuppressedStaleMiniAppAuthError,
} from "../../packages/mini-app-frontend/api/authError";
import { precheckMiniAppAccess } from "../../packages/mini-app-frontend/api/authPrecheck";
import { downloadMiniAppGalleryImageByName } from "../../packages/mini-app-frontend/api/galleryDownload";
import { fetchMiniAppGalleryImageObjectUrl } from "../../packages/mini-app-frontend/api/galleryFile";
import { uploadMiniAppGalleryImageBytes } from "../../packages/mini-app-frontend/api/galleryUpload";
import {
  pollMiniAppPickerResult,
  waitForMiniAppPickerResult,
} from "../../packages/mini-app-frontend/api/pickerResult";
import {
  miniAppFetchJson,
  resolveMiniAppSessionCryptoSnapshot,
  toLocalEpochMs,
} from "../../packages/mini-app-frontend/api/request";
import {
  MINI_APP_DOWNLOAD_OBJECT_URL_REVOKE_DELAY_MS,
  MINI_APP_EXPIRED_AUTH_DATE_CODE,
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_PICKER_POLL_INTERVAL_MS,
  MINI_APP_SESSION_EXPIRES_AT_HEADER,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_TTL_MS,
} from "../../packages/mini-app-frontend/consts/miniApp";
import {
  MINI_APP_DOWNLOAD_TICKET_PARAM,
  MINI_APP_ENCRYPTED_QUERY_PARAM,
  MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
} from "../../packages/mini-app-frontend/consts/miniAppCrypto";
import {
  clearMiniAppSessionToken,
  getMiniAppSessionCryptoKey,
  hasMiniAppSessionCryptoKey,
  readMiniAppSessionExpiresAt,
  readMiniAppSessionToken,
  setMiniAppSessionToken,
} from "../../packages/mini-app-frontend/libs/credentials";
import {
  importMiniAppAesGcmKey,
  sealMiniAppQuery,
} from "../../packages/mini-app-frontend/libs/crypto";
import { buildMiniAppGalleryDownloadFileName } from "../../packages/mini-app-frontend/libs/formatters";
import {
  createInMemoryIdbFactory,
  seedTestMiniAppSession,
  TEST_ROTATED_SESSION_KEY,
  TEST_SESSION_KEY,
  wrapEncryptedTestFetch,
} from "./helpers/encryptedFetchMock";

/** 一次被记录的请求。 */
interface RecordedRequest {
  readonly key: string;
  readonly body: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal | null;
}

const requests: RecordedRequest[] = [];
const responses: Map<string, () => Response | Promise<Response>> = new Map<
  string,
  () => Response | Promise<Response>
>();
const originalFetch: typeof fetch = globalThis.fetch;
const originalIndexedDb: unknown = (globalThis as { indexedDB?: unknown }).indexedDB;
const session: string = "e".repeat(64);

beforeEach((): void => {
  requests.length = 0;
  responses.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = createInMemoryIdbFactory();
  (globalThis as { Telegram?: unknown }).Telegram = { WebApp: { initData: "signed-init-data" } };
  seedTestMiniAppSession(session, Date.now() + 60_000);
  globalThis.fetch = wrapEncryptedTestFetch(async (url: URL, init?: RequestInit): Promise<Response> => {
    const key: string = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}${url.search}`;
    requests.push({
      key,
      body: typeof init?.body === "string" ? init.body : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
      signal: init?.signal,
    });
    return await (responses.get(key)?.() ?? Response.json({ ok: true, result: null, items: [], detail: null }));
  });
});

afterEach((): void => {
  globalThis.fetch = originalFetch;
  if (originalIndexedDb === undefined) {
    Reflect.deleteProperty(globalThis, "indexedDB");
  } else {
    (globalThis as { indexedDB?: unknown }).indexedDB = originalIndexedDb;
  }
  (globalThis as { Telegram?: unknown }).Telegram = undefined;
  (globalThis as { document?: unknown }).document = undefined;
  (globalThis as { caches?: unknown }).caches = undefined;
  (globalThis as { __copyNinjaGalleryBinaryCache?: unknown }).__copyNinjaGalleryBinaryCache = undefined;
  (globalThis as { __copyNinjaGalleryCachePrunePromise?: unknown }).__copyNinjaGalleryCachePrunePromise = undefined;
  clearMiniAppSessionToken();
});

describe("会话与传输", () => {
  test("附件下载：原生下载器先以加密 POST /api/gallery/download-ticket 申请一次性 ticket 并拼装仅含 ?ticket 的 URL；不支持原生下载时以请求头 GET 取回字节经 blob 链接保存；失败时按服务端说明报错", async () => {
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
    const refreshedExp: number = Date.now() + 120_000;
    const downloadTicket: string = "1".repeat(64);
    const aDownloadName: string = buildMiniAppGalleryDownloadFileName("a.png");
    responses.set("POST /api/gallery/download-ticket", (): Response =>
      Response.json(
        {
          ok: true,
          ticket: downloadTicket,
          expiresAt: Date.now() + 60_000,
          downloadFileName: aDownloadName,
        },
        {
          headers: {
            [MINI_APP_SESSION_HEADER]: session,
            [MINI_APP_SESSION_EXPIRES_AT_HEADER]: String(refreshedExp),
          },
        }
      ));
    expect(await downloadMiniAppGalleryImageByName("a.png", aDownloadName)).toBeFalse();
    expect(requests[0]?.key).toBe("POST /api/gallery/download-ticket");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ fileName: "a.png" });
    expect(requests[0]?.headers[MINI_APP_SESSION_HEADER]).toBe(session);
    expect(requests[0]?.headers[MINI_APP_INIT_DATA_HEADER]).toBe("signed-init-data");
    expect(readMiniAppSessionExpiresAt()).toBe(refreshedExp);
    expect(downloads[0]?.file_name).toBe(aDownloadName);
    const nativeUrl: URL = new URL(downloads[0]!.url, "http://mini.test/");
    expect(nativeUrl.pathname).toBe("/api/gallery/download");
    expect(Array.from(nativeUrl.searchParams.keys())).toEqual([MINI_APP_DOWNLOAD_TICKET_PARAM]);
    expect(nativeUrl.searchParams.get(MINI_APP_DOWNLOAD_TICKET_PARAM)).toBe(downloadTicket);
    expect(nativeUrl.searchParams.get("fileName")).toBeNull();
    expect(nativeUrl.searchParams.get("session")).toBeNull();
    expect(nativeUrl.searchParams.get("token")).toBeNull();
    expect(nativeUrl.searchParams.get("initData")).toBeNull();
    responses.set(`HEAD /api/gallery/download?ticket=${downloadTicket}`, (): Response =>
      new Response(null, { status: 200 }));
    const headProbeOnNativeUrl: Response = await globalThis.fetch(downloads[0]!.url, {
      method: "HEAD",
    });
    expect(headProbeOnNativeUrl.status).toBe(200);

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
      responses.set("GET /api/gallery/download?fileName=b.webp", (): Response =>
        new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/webp" } }));
      const bDownloadName: string = buildMiniAppGalleryDownloadFileName("b.webp");
      expect(await downloadMiniAppGalleryImageByName("b.webp", bDownloadName)).toBeTrue();
      expect(requests.at(-1)?.key).toBe("GET /api/gallery/download?fileName=b.webp");
      expect(requests.at(-1)?.headers[MINI_APP_SESSION_HEADER]).toBe(session);
      expect(anchors).toHaveLength(1);
      expect(String(anchors[0]?.href)).toStartWith("blob:");
      expect(anchors[0]?.download).toBe(bDownloadName);
      expect(anchors[0]?.clicks).toBe(1);
      expect(revokeSpy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(MINI_APP_DOWNLOAD_OBJECT_URL_REVOKE_DELAY_MS);
      expect(revokeSpy).toHaveBeenCalledWith(anchors[0]?.href);

      responses.set("GET /api/gallery/download?fileName=gone.png", (): Response =>
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
      WebApp: {
        initData: "signed-init-data",
        isVersionAtLeast: (): boolean => true,
        downloadFile: (): void => {},
      },
    };
    responses.set("POST /api/gallery/download-ticket", (): Response =>
      Response.json({ code: "PASSWORD_REQUIRED", error: "login again" }, { status: 401 }));
    await expect(
      downloadMiniAppGalleryImageByName("c.png", buildMiniAppGalleryDownloadFileName("c.png"))
    ).rejects.toThrow("[PASSWORD_REQUIRED] login again");
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
    expect(outcome).not.toBe("aborted");
    expect(
      outcome !== "timeout" && outcome !== "aborted" ? outcome.requestId : null
    ).toBe(5);
    expect(calls).toBe(2);

    responses.set("GET /api/picker/result?requestId=6", (): Response =>
      Response.json({ code: "PASSWORD_REQUIRED", error: "PASSWORD_REQUIRED" }, { status: 401 }));
    await expect(waitForMiniAppPickerResult(6)).rejects.toThrow("[PASSWORD_REQUIRED]");
    expect(requests.filter((request: RecordedRequest): boolean =>
      request.key === "GET /api/picker/result?requestId=6")).toHaveLength(1);

    seedTestMiniAppSession(session, Date.now() + 60_000, TEST_SESSION_KEY);
    responses.set("GET /api/picker/result?requestId=7", (): Response =>
      Response.json({ error: MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE }, { status: 400 }));
    await expect(waitForMiniAppPickerResult(7)).rejects.toThrow(
      `[PASSWORD_REQUIRED] ${MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE}`
    );
    expect(requests.filter((request: RecordedRequest): boolean =>
      request.key === "GET /api/picker/result?requestId=7")).toHaveLength(1);

    seedTestMiniAppSession(session, Date.now() + 60_000, TEST_SESSION_KEY);
    responses.set("GET /api/picker/result?requestId=8", (): Response =>
      Response.json({ code: "EXPIRED_AUTH_DATE", error: "EXPIRED_AUTH_DATE" }, { status: 401 }));
    await expect(waitForMiniAppPickerResult(8)).rejects.toThrow("[EXPIRED_AUTH_DATE] EXPIRED_AUTH_DATE");
    expect(requests.filter((request: RecordedRequest): boolean =>
      request.key === "GET /api/picker/result?requestId=8")).toHaveLength(1);
  });

  test("选择器回执轮询支持 AbortSignal：预中止、等待间隔中止与在途请求中止均立即返回 aborted 且不触发鉴权报错", async () => {
    const preAborted: AbortController = new AbortController();
    preAborted.abort();
    await expect(pollMiniAppPickerResult(90, preAborted.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await waitForMiniAppPickerResult(90, preAborted.signal)).toBe("aborted");
    expect(
      requests.filter((request: RecordedRequest): boolean =>
        request.key === "GET /api/picker/result?requestId=90")
    ).toHaveLength(0);

    jest.useFakeTimers();
    try {
      const sleepController: AbortController = new AbortController();
      const sleepOutcomePromise: ReturnType<typeof waitForMiniAppPickerResult> =
        waitForMiniAppPickerResult(91, sleepController.signal);
      sleepController.abort();
      expect(await sleepOutcomePromise).toBe("aborted");
      jest.advanceTimersByTime(MINI_APP_PICKER_POLL_INTERVAL_MS * 2);
      expect(
        requests.filter((request: RecordedRequest): boolean =>
          request.key === "GET /api/picker/result?requestId=91")
      ).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }

    const fetchController: AbortController = new AbortController();
    const requestStarted: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const responseGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    responses.set("GET /api/picker/result?requestId=92", async (): Promise<Response> => {
      requestStarted.resolve();
      await responseGate.promise;
      return Response.json({ code: "PASSWORD_REQUIRED", error: "PASSWORD_REQUIRED" }, { status: 401 });
    });

    const inFlightPromise: ReturnType<typeof waitForMiniAppPickerResult> =
      waitForMiniAppPickerResult(92, fetchController.signal);
    await requestStarted.promise;
    expect(requests.at(-1)?.key).toBe("GET /api/picker/result?requestId=92");
    expect(requests.at(-1)?.signal).toBe(fetchController.signal);

    clearMiniAppSessionToken();
    fetchController.abort();
    responseGate.resolve();
    expect(await inFlightPromise).toBe("aborted");
    expect(
      requests.filter((request: RecordedRequest): boolean =>
        request.key === "GET /api/picker/result?requestId=92")
    ).toHaveLength(1);
  });

  test("加密接口响应体读取中途失败（中止或断流）时原样抛出读取错误，不按载荷失效清除本地会话", async () => {
    /** 返回响应头已到达的 2xx 响应，并在响应体开始读取后经 `interrupt` 触发读取失败。 */
    const respondWithFailingBody = (
      failure: () => Error,
      interrupt: (fail: () => void) => void
    ): typeof fetch =>
      (async (): Promise<Response> => {
        const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
          start(streamController: ReadableStreamDefaultController<Uint8Array>): void {
            interrupt((): void => {
              streamController.error(failure());
            });
          },
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
      }) as unknown as typeof fetch;

    const abortController: AbortController = new AbortController();
    globalThis.fetch = respondWithFailingBody(
      (): Error => new DOMException("The operation was aborted.", "AbortError"),
      (fail: () => void): void => {
        abortController.signal.addEventListener("abort", fail, { once: true });
        queueMicrotask((): void => {
          abortController.abort();
        });
      }
    );
    await expect(pollMiniAppPickerResult(93, abortController.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(readMiniAppSessionToken()).toBe(session);
    expect(hasMiniAppSessionCryptoKey()).toBeTrue();

    globalThis.fetch = respondWithFailingBody(
      (): Error => new TypeError("network connection lost"),
      (fail: () => void): void => {
        queueMicrotask(fail);
      }
    );
    await expect(miniAppFetchJson("/api/status")).rejects.toThrow("network connection lost");
    expect(readMiniAppSessionToken()).toBe(session);
    expect(hasMiniAppSessionCryptoKey()).toBeTrue();
  });

  test("服务端会话到期时刻按响应 Date 头换算为本机时刻：本机时钟大幅偏离时预检与令牌刷新仍按服务端剩余时长判定", async () => {
    const skewMs: number = 2 * 3_600_000;
    const serverNow: number = Date.now() + skewMs;
    const plainResponse: Response = new Response(null);
    expect(toLocalEpochMs(12_345, plainResponse)).toBe(12_345);

    responses.set("GET /api/auth/precheck", (): Response =>
      Response.json(
        { ok: true, ttlMs: MINI_APP_SESSION_TTL_MS, sessionValid: true, sessionExpiresAt: serverNow + 30 * 60_000 },
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
          [MINI_APP_SESSION_EXPIRES_AT_HEADER]: String(lateServerNow + MINI_APP_SESSION_TTL_MS),
        },
      }));
    await miniAppFetchJson("/api/status");
    expect(readMiniAppSessionToken()).toBe(refreshedSession);
    expect(hasMiniAppSessionCryptoKey()).toBeTrue();
    expect(await getMiniAppSessionCryptoKey()).not.toBeNull();
    expect(Math.abs(readMiniAppSessionExpiresAt() - (Date.now() + MINI_APP_SESSION_TTL_MS))).toBeLessThan(2_000);
  });

  test("precheck 在本机已触发过期自清但服务端仍判有效时回退保留 sentSessionToken；服务端判无效时清理过期会话", async () => {
    seedTestMiniAppSession(session, Date.now() + 60_000);
    responses.set("GET /api/auth/precheck", (): Response => {
      // 模拟请求发出后本机因时钟跳变提前清理了本地缓存，但服务端仍返回有效会话。
      clearMiniAppSessionToken();
      return Response.json(
        {
          ok: true,
          ttlMs: MINI_APP_SESSION_TTL_MS,
          sessionValid: true,
          sessionExpiresAt: Date.now() + 20 * 60_000,
        },
        { headers: { Date: new Date().toUTCString() } }
      );
    });
    const preserved = await precheckMiniAppAccess();
    expect(preserved.ok && preserved.sessionValid === true).toBeTrue();
    expect(readMiniAppSessionToken()).toBe(session);

    clearMiniAppSessionToken();
    responses.set("GET /api/auth/precheck", (): Response =>
      Response.json({ ok: true, ttlMs: MINI_APP_SESSION_TTL_MS, sessionValid: false })
    );
    const invalidated = await precheckMiniAppAccess();
    expect(invalidated.ok && invalidated.sessionValid !== true).toBeTrue();
    expect(readMiniAppSessionToken()).toBe("");
  });

  test("precheck 返回 2xx 非 JSON 响应体时走失败诊断并清理本地凭据", async () => {
    seedTestMiniAppSession("b".repeat(64), Date.now() + 30 * 60_000);
    responses.set("GET /api/auth/precheck", (): Response =>
      new Response("<html>bad gateway</html>", {
        status: 200,
        headers: { "content-type": "text/html", "x-request-id": "0123456789abcdef" },
      }));

    const result = await precheckMiniAppAccess();
    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.diagnostics.status).toBe(200);
      expect(result.diagnostics.code).toBe("HTTP_200");
      expect(result.diagnostics.error).toBe("INVALID_RESPONSE");
    }
    expect(readMiniAppSessionToken()).toBe("");
  });

  test("wrapEncryptedTestFetch 在已认证路由收到任何明文或混合查询参数时立即抛错拒绝，加密查询参数经解封还原后透明路由至夹具", async () => {
    responses.set(
      "GET /api/configs/file?scope=dynamic&fileName=ad_detect.json",
      (): Response => Response.json({ ok: true, content: "{}" })
    );
    responses.set(
      "GET /api/identities/whitelist?page=2&pageSize=15&q=alice",
      (): Response => Response.json({ items: [], page: 2, total: 0 })
    );

    const cfgRes = await miniAppFetchJson<{ readonly ok: boolean }>(
      "./api/configs/file?scope=dynamic&fileName=ad_detect.json"
    );
    expect(cfgRes.ok).toBeTrue();
    const wlRes = await miniAppFetchJson<{ readonly page: number }>(
      "./api/identities/whitelist?page=2&pageSize=15&q=alice"
    );
    expect(wlRes.page).toBe(2);
    expect(requests.map((r: RecordedRequest): string => r.key)).toEqual([
      "GET /api/configs/file?scope=dynamic&fileName=ad_detect.json",
      "GET /api/identities/whitelist?page=2&pageSize=15&q=alice",
    ]);

    // 直接向 wrapEncryptedTestFetch 发送明文查询串时立即抛错断言失败。
    await expect(
      globalThis.fetch("./api/configs/file?scope=dynamic&fileName=ad_detect.json")
    ).rejects.toThrow("Expected encrypted query");
    await expect(
      globalThis.fetch("./api/gallery/file?fileName=a.png")
    ).rejects.toThrow("Expected encrypted query");
    await expect(
      globalThis.fetch("./api/gallery/download?fileName=a.png")
    ).rejects.toThrow("Expected encrypted query");
    await expect(
      globalThis.fetch(`./api/gallery/download?ticket=${"1".repeat(64)}&session=${session}`)
    ).rejects.toThrow("Expected strict ?ticket=");

    // `/api/gallery/file` 严格拒绝附带 `token`/`session` 参数且不轮换密钥仅同步过期时刻；`/api/gallery/download` 严格校验方法与路径 AAD（`HEAD` 与 `GET` 互不回退）。
    const keyForFile: CryptoKey = await importMiniAppAesGcmKey(TEST_SESSION_KEY);
    const sealedFileQuery: string = await sealMiniAppQuery(
      keyForFile,
      "fileName=pic.png",
      "GET /api/gallery/file"
    );
    await expect(
      globalThis.fetch(
        `./api/gallery/file?e=${encodeURIComponent(sealedFileQuery)}&token=${"d".repeat(64)}`
      )
    ).rejects.toThrow("Expected encrypted query");

    responses.set("GET /api/gallery/file?fileName=pic.png", (): Response =>
      new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          [MINI_APP_SESSION_HEADER]: session,
          [MINI_APP_SESSION_EXPIRES_AT_HEADER]: String(Date.now() + 240_000),
        },
      }));
    const fetchedObjectUrl: string = await fetchMiniAppGalleryImageObjectUrl("pic.png");
    expect(fetchedObjectUrl).toStartWith("blob:");
    expect(hasMiniAppSessionCryptoKey()).toBeTrue();
    URL.revokeObjectURL(fetchedObjectUrl);

    const sealedGetDownloadQuery: string = await sealMiniAppQuery(
      keyForFile,
      "fileName=pic.png",
      "GET /api/gallery/download"
    );
    const sealedHeadDownloadQuery: string = await sealMiniAppQuery(
      keyForFile,
      "fileName=pic.png",
      "HEAD /api/gallery/download"
    );
    responses.set("HEAD /api/gallery/download?fileName=pic.png", (): Response =>
      new Response(null, { status: 200 }));
    expect(
      (await globalThis.fetch(`./api/gallery/download?e=${encodeURIComponent(sealedHeadDownloadQuery)}`, { method: "HEAD" })).status
    ).toBe(200);
    await expect(
      globalThis.fetch(
        `./api/gallery/download?e=${encodeURIComponent(sealedGetDownloadQuery)}`,
        { method: "HEAD" }
      )
    ).rejects.toThrow(
      `Expected valid encrypted query (?${MINI_APP_ENCRYPTED_QUERY_PARAM}=...) on HEAD /api/gallery/download`
    );
    await expect(
      globalThis.fetch(
        `./api/gallery/download?e=${encodeURIComponent(sealedHeadDownloadQuery)}`,
        { method: "GET" }
      )
    ).rejects.toThrow(
      `Expected valid encrypted query (?${MINI_APP_ENCRYPTED_QUERY_PARAM}=...) on GET /api/gallery/download`
    );
  });

  test("令牌轮换后旧令牌在途请求收到 401 PASSWORD_REQUIRED 时不清除新会话，未轮换或 PASSWORD_LOCKED 仍清除；图库先读缓存再取令牌快照", async () => {
    const rotatedSession: string = "b".repeat(64);
    const runStale401WithRotation = async (
      routeKey: string,
      invoke: () => Promise<unknown>
    ): Promise<void> => {
      seedTestMiniAppSession(session, Date.now() + 60_000, TEST_SESSION_KEY);
      const gate: PromiseWithResolvers<Response> = Promise.withResolvers<Response>();
      const entered: PromiseWithResolvers<void> = Promise.withResolvers<void>();
      responses.set(routeKey, (): Promise<Response> => {
        entered.resolve();
        return gate.promise;
      });
      const pending: Promise<unknown> = invoke();
      await entered.promise;
      seedTestMiniAppSession(rotatedSession, Date.now() + 120_000, TEST_ROTATED_SESSION_KEY);
      gate.resolve(
        Response.json({ code: "PASSWORD_REQUIRED", error: "SESSION_EXPIRED" }, { status: 401 })
      );
      await expect(pending).rejects.toThrow("[PASSWORD_REQUIRED] SESSION_EXPIRED");
      expect(readMiniAppSessionToken()).toBe(rotatedSession);
    };

    // 1. miniAppFetchJson、galleryFile、galleryUpload、galleryDownload（fallback GET 与 native HEAD->GET）四条路径均不误清新令牌。
    await runStale401WithRotation("GET /api/status", () => miniAppFetchJson("./api/status"));
    await runStale401WithRotation("GET /api/gallery/file?fileName=stale.png", () =>
      fetchMiniAppGalleryImageObjectUrl("stale.png")
    );
    await runStale401WithRotation("POST /api/gallery/upload", () =>
      uploadMiniAppGalleryImageBytes(new Uint8Array([1, 2, 3]))
    );

    (globalThis as { Telegram?: unknown }).Telegram = { WebApp: { initData: "signed-init-data" } };
    await runStale401WithRotation("GET /api/gallery/download?fileName=stale.png", () =>
      downloadMiniAppGalleryImageByName("stale.png", "stale.png")
    );

    // native download-ticket 分支：请求发送后在途期间轮换为新令牌，收到 401 时不误清新令牌。
    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: {
        initData: "signed-init-data",
        isVersionAtLeast: (): boolean => true,
        downloadFile: (): void => {},
      },
    };
    await runStale401WithRotation("POST /api/gallery/download-ticket", () =>
      downloadMiniAppGalleryImageByName("native.png", "native.png")
    );

    // 2. 对照：令牌未发生轮换时，401 PASSWORD_REQUIRED 照常清除当前令牌。
    seedTestMiniAppSession(session, Date.now() + 60_000, TEST_SESSION_KEY);
    responses.set("GET /api/status", (): Response =>
      Response.json({ code: "PASSWORD_REQUIRED", error: "SESSION_EXPIRED" }, { status: 401 })
    );
    await expect(miniAppFetchJson("./api/status")).rejects.toThrow("[PASSWORD_REQUIRED] SESSION_EXPIRED");
    expect(readMiniAppSessionToken()).toBe("");

    // 3. 对照：旧令牌在途请求遇 400 INVALID_ENCRYPTED_PAYLOAD 或延展期 401 EXPIRED_AUTH_DATE 时均不误清已轮换的新会话；
    // 未轮换时的 EXPIRED_AUTH_DATE 与无条件一层拒绝（PASSWORD_LOCKED / FORBIDDEN_USER）仍清除会话凭据。
    for (const [staleLabel, stalePayload, staleStatus, expectedError] of [
      [
        "400 INVALID_ENCRYPTED_PAYLOAD",
        { error: MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE },
        400,
        `[PASSWORD_REQUIRED] ${MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE}`,
      ],
      [
        `401 ${MINI_APP_EXPIRED_AUTH_DATE_CODE}`,
        { code: MINI_APP_EXPIRED_AUTH_DATE_CODE, error: MINI_APP_EXPIRED_AUTH_DATE_CODE },
        401,
        `[${MINI_APP_EXPIRED_AUTH_DATE_CODE}] ${MINI_APP_EXPIRED_AUTH_DATE_CODE}`,
      ],
    ] as const) {
      seedTestMiniAppSession(session, Date.now() + 60_000, TEST_SESSION_KEY);
      const gate: PromiseWithResolvers<Response> = Promise.withResolvers<Response>();
      const entered: PromiseWithResolvers<void> = Promise.withResolvers<void>();
      responses.set("GET /api/status", (): Promise<Response> => {
        entered.resolve();
        return gate.promise;
      });
      const pending: Promise<unknown> = miniAppFetchJson("./api/status");
      await entered.promise;
      seedTestMiniAppSession(rotatedSession, Date.now() + 120_000, TEST_ROTATED_SESSION_KEY);
      gate.resolve(Response.json(stalePayload, { status: staleStatus }));
      await expect(pending).rejects.toThrow(expectedError);
      expect(`${staleLabel} -> ${readMiniAppSessionToken()}`).toBe(
        `${staleLabel} -> ${rotatedSession}`
      );
    }

    seedTestMiniAppSession(session, Date.now() + 60_000, TEST_SESSION_KEY);
    responses.set("GET /api/status", (): Response =>
      Response.json(
        { code: MINI_APP_EXPIRED_AUTH_DATE_CODE, error: MINI_APP_EXPIRED_AUTH_DATE_CODE },
        { status: 401 }
      )
    );
    await expect(miniAppFetchJson("./api/status")).rejects.toThrow(
      `[${MINI_APP_EXPIRED_AUTH_DATE_CODE}] ${MINI_APP_EXPIRED_AUTH_DATE_CODE}`
    );
    expect(readMiniAppSessionToken()).toBe("");

    for (const [denyCode, denyStatus] of [
      ["PASSWORD_LOCKED", 403],
      ["FORBIDDEN_USER", 403],
    ] as const) {
      seedTestMiniAppSession(session, Date.now() + 60_000, TEST_SESSION_KEY);
      const gate: PromiseWithResolvers<Response> = Promise.withResolvers<Response>();
      const entered: PromiseWithResolvers<void> = Promise.withResolvers<void>();
      responses.set("GET /api/status", (): Promise<Response> => {
        entered.resolve();
        return gate.promise;
      });
      const pending: Promise<unknown> = miniAppFetchJson("./api/status");
      await entered.promise;
      seedTestMiniAppSession(rotatedSession, Date.now() + 120_000, TEST_ROTATED_SESSION_KEY);
      gate.resolve(
        Response.json({ code: denyCode, error: denyCode }, { status: denyStatus })
      );
      await expect(pending).rejects.toThrow(`[${denyCode}] ${denyCode}`);
      expect(readMiniAppSessionToken()).toBe("");
    }

    // 4. galleryFile 在读取 CacheStorage 期间发生令牌轮换：先读缓存再取令牌快照，发出的是最新令牌。
    seedTestMiniAppSession(session, Date.now() + 60_000, TEST_SESSION_KEY);
    const cacheMatchEntered: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const cacheMatchGate: PromiseWithResolvers<Response | undefined> =
      Promise.withResolvers<Response | undefined>();
    (globalThis as { caches?: unknown }).caches = {
      open: async () => ({
        keys: async (): Promise<Request[]> => [],
        match: (url: string): Promise<Response | undefined> => {
          if (url.includes("ordered.png")) {
            cacheMatchEntered.resolve();
            return cacheMatchGate.promise;
          }
          return Promise.resolve(undefined);
        },
        put: async (): Promise<void> => {},
        delete: async (): Promise<boolean> => true,
      }),
    };
    responses.set("GET /api/gallery/file?fileName=ordered.png", (): Response =>
      new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      })
    );
    const orderedFetch: Promise<string> = fetchMiniAppGalleryImageObjectUrl("ordered.png");
    await cacheMatchEntered.promise;
    seedTestMiniAppSession(rotatedSession, Date.now() + 120_000, TEST_ROTATED_SESSION_KEY);
    cacheMatchGate.resolve(undefined);
    const orderedUrl: string = await orderedFetch;
    URL.revokeObjectURL(orderedUrl);
    expect(requests.at(-1)?.headers[MINI_APP_SESSION_HEADER]).toBe(rotatedSession);
  });

  test("resolveMiniAppSessionCryptoSnapshot 连续 3 次轮换耗尽追赶次数时附带 sentSessionToken 且保留新会话；本地真正缺密钥时仍触发 reauth", async () => {
    const realImportKey: typeof crypto.subtle.importKey = crypto.subtle.importKey.bind(crypto.subtle);
    const tokens: readonly string[] = [
      "a".repeat(64),
      "b".repeat(64),
      "c".repeat(64),
      "d".repeat(64),
      "e".repeat(64),
    ];
    const expiresAt: number = Date.now() + MINI_APP_SESSION_TTL_MS;
    const importGates: PromiseWithResolvers<void>[] = [];
    let importIndex: number = 0;
    (crypto.subtle as { importKey: typeof crypto.subtle.importKey }).importKey = (async (
      ...args: Parameters<typeof crypto.subtle.importKey>
    ): Promise<CryptoKey> => {
      const idx: number = importIndex++;
      if (idx < 4) {
        const gate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
        importGates.push(gate);
        await gate.promise;
      }
      return realImportKey(...args);
    }) as typeof crypto.subtle.importKey;

    try {
      setMiniAppSessionToken(tokens[0]!, expiresAt, TEST_SESSION_KEY);
      const pendingSnapshot: ReturnType<typeof resolveMiniAppSessionCryptoSnapshot> =
        resolveMiniAppSessionCryptoSnapshot();
      for (let step: number = 0; step < 4; step++) {
        await Bun.sleep(0);
        setMiniAppSessionToken(
          tokens[step + 1]!,
          expiresAt,
          step % 2 === 0 ? TEST_ROTATED_SESSION_KEY : TEST_SESSION_KEY
        );
        importGates[step]!.resolve();
      }

      let rotationError: unknown;
      try {
        await pendingSnapshot;
      } catch (error: unknown) {
        rotationError = error;
      }
      expect(rotationError).toBeInstanceOf(Error);
      const tagged: Error = rotationError as Error;
      expect(tagged.message).toBe("[PASSWORD_REQUIRED] PASSWORD_REQUIRED");
      expect(readMiniAppSessionToken()).toBe(tokens[4]!);
      expect(hasMiniAppSessionCryptoKey()).toBeTrue();
      expect(await getMiniAppSessionCryptoKey()).not.toBeNull();
      expect(classifyMiniAppAuthError(tagged.message, tagged)).toBeNull();
      expect(isSuppressedStaleMiniAppAuthError(tagged.message, tagged)).toBeTrue();
    } finally {
      (crypto.subtle as { importKey: typeof crypto.subtle.importKey }).importKey = realImportKey;
    }

    // 对照：本地真正无会话/缺密钥时，抛出的错误不被抑制且仍分类为 "reauth"。
    clearMiniAppSessionToken();
    let missingError: unknown;
    try {
      await resolveMiniAppSessionCryptoSnapshot();
    } catch (error: unknown) {
      missingError = error;
    }
    expect(missingError).toBeInstanceOf(Error);
    const missing: Error = missingError as Error;
    expect(missing.message).toBe("[PASSWORD_REQUIRED] PASSWORD_REQUIRED");
    expect(classifyMiniAppAuthError(missing.message, missing)).toBe("reauth");
    expect(isSuppressedStaleMiniAppAuthError(missing.message, missing)).toBeFalse();
  });

});
