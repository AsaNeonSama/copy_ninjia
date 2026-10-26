/**
 * Mini App 前端 `api/` 各接口文件：请求方法、路径、请求体与鉴权头，以及错误归一化、附件下载与
 * 组件独占 store 钩子。`fetch` 记录每次请求并按「方法 + 路径」返回测试夹具。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fetchMiniAppBlocklist } from "../../packages/mini-app-frontend/api/blocklist";
import { setMiniAppBlocklistMembership } from "../../packages/mini-app-frontend/api/blocklistMembership";
import { fetchMiniAppChatDetail } from "../../packages/mini-app-frontend/api/chatDetail";
import { toggleMiniAppChatFeature } from "../../packages/mini-app-frontend/api/chatFeature";
import { fetchMiniAppChats } from "../../packages/mini-app-frontend/api/chats";
import { deleteMiniAppGalleryImageByName } from "../../packages/mini-app-frontend/api/galleryDelete";
import { downloadMiniAppGalleryImageByName } from "../../packages/mini-app-frontend/api/galleryDownload";
import { uploadMiniAppGalleryImageBytes } from "../../packages/mini-app-frontend/api/galleryUpload";
import { updateMiniAppWhitelistPermission } from "../../packages/mini-app-frontend/api/permission";
import { requestMiniAppPreparedPicker } from "../../packages/mini-app-frontend/api/pickerPrepare";
import { pollMiniAppPickerResult } from "../../packages/mini-app-frontend/api/pickerResult";
import { miniAppFetchJson } from "../../packages/mini-app-frontend/api/request";
import { deleteMiniAppTotp } from "../../packages/mini-app-frontend/api/totpDelete";
import { enableMiniAppTotp } from "../../packages/mini-app-frontend/api/totpEnable";
import { setupMiniAppTotp } from "../../packages/mini-app-frontend/api/totpSetup";
import { fetchMiniAppTotpStatus } from "../../packages/mini-app-frontend/api/totpStatus";
import { fetchMiniAppWhitelist } from "../../packages/mini-app-frontend/api/whitelist";
import { setMiniAppWhitelistMembership } from "../../packages/mini-app-frontend/api/whitelistMembership";
import {
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_SESSION_HEADER,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { WHITELIST_PERMISSION_KEYS } from "../../packages/mini-app-frontend/consts/whitelist";
import { useComponentStore } from "../../packages/mini-app-frontend/libs/componentStore";
import {
  clearMiniAppAssetToken,
  clearMiniAppSessionToken,
  readMiniAppSessionToken,
  setMiniAppSessionToken,
} from "../../packages/mini-app-frontend/libs/credentials";
import { buildMiniAppGalleryDownloadFileName } from "../../packages/mini-app-frontend/libs/formatters";
import { createMessagesStore } from "../../packages/mini-app-frontend/store/messages";
import type { MiniAppMessagesStoreState } from "../../packages/mini-app-frontend/store/messages";

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

describe("前端接口文件", () => {
  test("每个接口按约定的方法、路径与 JSON 请求体发出，并附带 initData 与会话令牌", async () => {
    await fetchMiniAppChats();
    await fetchMiniAppChatDetail(-100);
    await toggleMiniAppChatFeature(-100, "aiChat", true);
    await fetchMiniAppWhitelist(2, 15, " doro ");
    await setMiniAppWhitelistMembership(7, true);
    await fetchMiniAppBlocklist(1, 10);
    await setMiniAppBlocklistMembership(7, false);
    await updateMiniAppWhitelistPermission(7, "all", true);
    const permissionKey: (typeof WHITELIST_PERMISSION_KEYS)[number] = WHITELIST_PERMISSION_KEYS[0]!;
    await updateMiniAppWhitelistPermission(7, permissionKey, false);
    await requestMiniAppPreparedPicker("blocklist", "channel");
    await pollMiniAppPickerResult(3);
    await deleteMiniAppGalleryImageByName("a b.png");
    await fetchMiniAppTotpStatus();
    await setupMiniAppTotp();
    await enableMiniAppTotp("123456");
    await deleteMiniAppTotp();
    expect(requests.map((request: RecordedRequest): string => `${request.key} ${request.body ?? ""}`.trim())).toEqual([
      "GET /api/chats",
      "GET /api/chats/-100",
      'POST /api/chats/-100/feature {"feature":"aiChat","enabled":true}',
      "GET /api/identities/whitelist?page=2&pageSize=15&query=doro",
      'POST /api/identities/whitelist {"id":7,"enabled":true}',
      "GET /api/identities/blocklist?page=1&pageSize=10",
      'POST /api/identities/blocklist {"id":7,"enabled":false}',
      'POST /api/identities/permission {"id":7,"enableAll":true}',
      `POST /api/identities/permission ${JSON.stringify({ id: 7, key: permissionKey, value: false })}`,
      'POST /api/picker/prepare {"targetList":"blocklist","subjectKind":"channel"}',
      "GET /api/picker/result?requestId=3",
      "DELETE /api/gallery/file/a%20b.png",
      "GET /api/totp",
      "POST /api/totp/setup",
      'POST /api/totp/enable {"code":"123456"}',
      "DELETE /api/totp",
    ]);
    for (const request of requests) {
      expect(request.headers[MINI_APP_INIT_DATA_HEADER]).toBe("signed-init-data");
      expect(request.headers[MINI_APP_SESSION_HEADER]).toBe(session);
    }
  });

  test("会话失效或锁定时清除本地令牌并给错误加代号前缀，其余错误原样抛出", async () => {
    responses.set("GET /api/a", (): Response => Response.json({ code: "PASSWORD_REQUIRED", error: "expired" }, { status: 401 }));
    responses.set("GET /api/b", (): Response => Response.json({ message: "bad" }, { status: 400 }));
    responses.set("GET /api/c", (): Response => new Response("oops", { status: 502 }));
    await expect(miniAppFetchJson("./api/b")).rejects.toThrow("bad");
    await expect(miniAppFetchJson("./api/c")).rejects.toThrow("HTTP 502");
    expect(readMiniAppSessionToken()).toBe(session);
    await expect(miniAppFetchJson("./api/a")).rejects.toThrow("[PASSWORD_REQUIRED] expired");
    expect(readMiniAppSessionToken()).toBe("");
  });

  test("图片上传以原始字节提交，回执缺失时按 HTTP 状态报错或返回失败结果", async () => {
    responses.set("POST /api/gallery/upload", (): Response => Response.json({ ok: true, outcome: "added", message: "ok" }));
    expect((await uploadMiniAppGalleryImageBytes(new Uint8Array([1, 2]))).outcome).toBe("added");
    expect(requests[0]?.headers["Content-Type"]).toBe("application/octet-stream");
    responses.set("POST /api/gallery/upload", (): Response => new Response("x", { status: 413 }));
    await expect(uploadMiniAppGalleryImageBytes(new Uint8Array([1]))).rejects.toThrow("HTTP 413");
    responses.set("POST /api/gallery/upload", (): Response => Response.json({}));
    expect((await uploadMiniAppGalleryImageBytes(new Uint8Array([1]))).outcome).toBe("failed");
  });

  test("附件下载先经 HEAD 核验，优先走 Telegram 原生下载，否则退回隐藏链接；核验失败时以服务端说明报错", async () => {
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
    expect(await downloadMiniAppGalleryImageByName("a.png")).toBeFalse();
    expect(requests[0]?.key).toStartWith("HEAD /api/gallery/download/a.png?");
    expect(downloads[0]?.file_name).toBe(buildMiniAppGalleryDownloadFileName("a.png"));

    const clicked: string[] = [];
    (globalThis as { Telegram?: unknown }).Telegram = { WebApp: { initData: "signed-init-data" } };
    (globalThis as { document?: unknown }).document = {
      getElementById: (): null => null,
      createElement: (): Record<string, unknown> => {
        const anchor: Record<string, unknown> = { style: {} };
        anchor.click = (): void => {
          clicked.push(String(anchor.download));
        };
        anchor.remove = (): void => {};
        return anchor;
      },
      body: { appendChild: (): void => {} },
    };
    expect(await downloadMiniAppGalleryImageByName("b.webp")).toBeTrue();
    expect(clicked).toEqual([buildMiniAppGalleryDownloadFileName("b.webp")]);

    responses.set("HEAD /api/gallery/download/c.png?initData=signed-init-data&session=" + session, (): Response =>
      new Response(null, { status: 401 }));
    responses.set("GET /api/gallery/download/c.png", (): Response =>
      Response.json({ code: "PASSWORD_REQUIRED", error: "login again" }, { status: 401 }));
    await expect(downloadMiniAppGalleryImageByName("c.png")).rejects.toThrow("login again");
    expect(readMiniAppSessionToken()).toBe("");
  });

  test("useComponentStore 为组件实例创建独占仓库并按当前状态渲染", () => {
    const Probe = (): ReturnType<typeof createElement> => {
      const state: MiniAppMessagesStoreState = useComponentStore(createMessagesStore);
      return createElement("span", null, `${state.pageNumber}/${state.pageSize}/${String(state.loading)}`);
    };
    expect(renderToStaticMarkup(createElement(Probe))).toBe(
      `<span>1/${createMessagesStore().getState().pageSize}/true</span>`
    );
  });
});
