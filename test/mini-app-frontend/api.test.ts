/**
 * Mini App 前端 `api/` 各接口文件与前端纯函数辅助库：请求方法、路径、请求体与鉴权头，错误归一化、
 * 附件下载、组件独占 store 钩子，以及多语言字典、格式化函数、资源 URL 与凭据读写。
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
import {
  buildMiniAppGalleryDownloadUrl,
  downloadMiniAppGalleryImageByName,
} from "../../packages/mini-app-frontend/api/galleryDownload";
import { buildMiniAppGalleryImageUrl } from "../../packages/mini-app-frontend/api/galleryFile";
import { uploadMiniAppGalleryImageBytes } from "../../packages/mini-app-frontend/api/galleryUpload";
import { updateMiniAppWhitelistPermission } from "../../packages/mini-app-frontend/api/permission";
import { requestMiniAppPreparedPicker } from "../../packages/mini-app-frontend/api/pickerPrepare";
import { pollMiniAppPickerResult } from "../../packages/mini-app-frontend/api/pickerResult";
import { miniAppFetchJson } from "../../packages/mini-app-frontend/api/request";
import { buildMiniAppSvgResourceUrl } from "../../packages/mini-app-frontend/api/svgResource";
import { deleteMiniAppTotp } from "../../packages/mini-app-frontend/api/totpDelete";
import { enableMiniAppTotp } from "../../packages/mini-app-frontend/api/totpEnable";
import { setupMiniAppTotp } from "../../packages/mini-app-frontend/api/totpSetup";
import { fetchMiniAppTotpStatus } from "../../packages/mini-app-frontend/api/totpStatus";
import { fetchMiniAppWhitelist } from "../../packages/mini-app-frontend/api/whitelist";
import { setMiniAppWhitelistMembership } from "../../packages/mini-app-frontend/api/whitelistMembership";
import {
  MINI_APP_FEATURE_KEYS,
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_LANGUAGES,
  MINI_APP_MIN_LOADING_MS,
  MINI_APP_SESSION_HEADER,
  MINI_APP_TAB_KEYS,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { WHITELIST_PERMISSION_KEYS } from "../../packages/mini-app-frontend/consts/whitelist";
import {
  detectBrowserDefaultLanguage,
  detectInitialMiniAppLanguage,
  getMiniAppTranslations,
} from "../../packages/mini-app-frontend/i18n";
import { useComponentStore } from "../../packages/mini-app-frontend/libs/componentStore";
import {
  clearMiniAppAssetToken,
  clearMiniAppSessionToken,
  readMiniAppAssetToken,
  readMiniAppSessionExpiresAt,
  readMiniAppSessionToken,
  setMiniAppAssetToken,
  setMiniAppSessionToken,
} from "../../packages/mini-app-frontend/libs/credentials";
import {
  buildMiniAppGalleryDownloadFileName,
  formatBytes,
  formatClockTime,
  formatGalleryFileSize,
  formatMemoryMb,
  formatTime,
  formatUptime,
  getFeatureDisplayMeta,
  getPermissionDisplayLabel,
  sanitizeBidiText,
  shortenGalleryFileName,
  truncateDisplayText,
} from "../../packages/mini-app-frontend/libs/formatters";
import { waitMinimumLoadingDuration } from "../../packages/mini-app-frontend/libs/loading";
import {
  confirmMiniAppAction,
  getTelegramWebApp,
  readMiniAppInitData,
} from "../../packages/mini-app-frontend/libs/telegram";
import {
  ChatsSvgIcon,
  DownloadSvgIcon,
  GallerySvgIcon,
  IdentitiesSvgIcon,
  MenuSvgIcon,
  SearchSvgIcon,
  StatusSvgIcon,
  TabSvgIcon,
  TrashSvgIcon,
} from "../../packages/mini-app-frontend/resource";
import {
  applyMiniAppThemeToDocument,
  detectInitialMiniAppTheme,
  resetMiniAppStoreForTest,
  useMiniAppStore,
} from "../../packages/mini-app-frontend/store/app";
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

describe("前端接口文件与纯函数辅助库", () => {
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

    resetMiniAppStoreForTest();
    const zhDict = getMiniAppTranslations("zh");
    const SidebarToggleProbe = (): ReturnType<typeof createElement> => {
      const { sidebarOpen, language } = useMiniAppStore.getState();
      const t = getMiniAppTranslations(language);
      return createElement(
        "button",
        {
          type: "button",
          className: `sidebar-toggle-btn ${sidebarOpen ? "active" : ""}`,
          "aria-label": sidebarOpen ? t.sidebarCloseAria : t.sidebarOpenAria,
          "aria-expanded": sidebarOpen,
        },
        createElement(MenuSvgIcon, {})
      );
    };
    const closedMarkup: string = renderToStaticMarkup(createElement(SidebarToggleProbe));
    expect(closedMarkup).toContain('class="sidebar-toggle-btn "');
    expect(closedMarkup).toContain(`aria-label="${zhDict.sidebarOpenAria}"`);
    expect(closedMarkup).toContain('aria-expanded="false"');
    expect(closedMarkup).toContain('width="22" height="22"');

    useMiniAppStore.getState().toggleSidebar();
    const openedMarkup: string = renderToStaticMarkup(createElement(SidebarToggleProbe));
    expect(openedMarkup).toContain('class="sidebar-toggle-btn active"');
    expect(openedMarkup).toContain(`aria-label="${zhDict.sidebarCloseAria}"`);
    expect(openedMarkup).toContain('aria-expanded="true"');
    expect(openedMarkup).toContain('width="22" height="22"');
    resetMiniAppStoreForTest();
  });

  test("UI 格式化与辅助纯函数覆盖全枚举分支", async () => {
    (globalThis as { Telegram?: unknown }).Telegram = undefined;
    clearMiniAppSessionToken();
    clearMiniAppAssetToken();

    expect(formatUptime(90_061_000)).toBe("1d 1h 1m");
    expect(formatUptime(3_661_000)).toBe("1h 1m 1s");
    expect(formatUptime(65_000)).toBe("1m 5s");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10.0 MiB");
    expect(formatMemoryMb(128.456 * 1024 * 1024)).toBe("128.46 MB");
    expect(
      buildMiniAppGalleryDownloadFileName(`${"a".repeat(64)}.PNG`, 1_792_934_567_890)
    ).toBe("1792934567.png");
    expect(formatTime(0)).toBe("-");
    expect(formatTime(1_700_000_000_000).length).toBeGreaterThan(0);
    expect(formatClockTime(0)).toBe("-");
    expect(formatClockTime(1_700_000_000_000)).toMatch(/^\d{2}:\d{2}:\d{2}$/u);

    for (const lang of MINI_APP_LANGUAGES) {
      const dict = getMiniAppTranslations(lang);
      expect(dict.appTitle).toContain("♡");
      expect(dict.status.loadingText.length).toBeGreaterThan(0);
      expect(dict.status.cpuLoadSub.length).toBeGreaterThan(0);
      const activeSessionsItems: readonly [string, string, string, string] =
        dict.status.activeSessionsSub({
          total: 10,
          gag: 1,
          wed: 2,
          verify: 3,
          qaSet: 4,
        });
      expect(activeSessionsItems).toHaveLength(4);
      expect(activeSessionsItems[0]).toContain("1");
      expect(activeSessionsItems[1]).toContain("2");
      expect(activeSessionsItems[2]).toContain("3");
      expect(activeSessionsItems[3]).toContain("4");
      expect(dict.status.memoryCurrentLabel.length).toBeGreaterThan(0);
      expect(dict.status.memoryPeakLabel.length).toBeGreaterThan(0);
      expect(dict.status.memoryHeapLabel.length).toBeGreaterThan(0);
      expect(dict.status.memoryProcessUsedLabel.length).toBeGreaterThan(0);
      expect(dict.status.memoryOtherUsedLabel.length).toBeGreaterThan(0);
      expect(dict.status.memoryTotalUsedLabel.length).toBeGreaterThan(0);
      expect(dict.status.memoryHeapSub("64.00 MB")).toContain("64.00 MB");
      expect(dict.identities.duplicateBannerTitle.length).toBeGreaterThan(0);
      for (const tabKey of MINI_APP_TAB_KEYS) {
        expect(dict.tabs[tabKey].length).toBeGreaterThan(0);
        expect(TabSvgIcon({ tabKey })).toBeDefined();
      }
      for (const featureKey of MINI_APP_FEATURE_KEYS) {
        const meta = getFeatureDisplayMeta(featureKey, lang);
        expect(meta.label.length).toBeGreaterThan(0);
        expect(meta.command.startsWith("/")).toBeTrue();
      }
      for (const permKey of WHITELIST_PERMISSION_KEYS) {
        expect(getPermissionDisplayLabel(permKey, lang).length).toBeGreaterThan(0);
      }
      expect(
        dict.gate.deniedPolicyReason("MISSING_INIT_DATA", "fallback").length
      ).toBeGreaterThan(0);
      expect(
        dict.gate.deniedPolicyReason("UNKNOWN_POLICY_CODE", "PASSWORD_LOCKED", {
          remainingMinutes: 25,
        })
      ).toContain("25");
      expect(dict.gate.deniedNodeGatewayState(403).length).toBeGreaterThan(0);
      expect(dict.identities.whitelistTab.length).toBeGreaterThan(0);
      expect(dict.identities.blocklistTab.length).toBeGreaterThan(0);
      expect(dict.identities.searchPlaceholder).toBe("id/name");
      expect(dict.gallery.sectionTitle.length).toBeGreaterThan(0);
      expect(dict.gallery.downloadButton.length).toBeGreaterThan(0);
      expect(dict.gallery.downloadingButton.length).toBeGreaterThan(0);
      expect(dict.gallery.downloadedToast("abc.png").length).toBeGreaterThan(0);
      const serverCodes: readonly string[] = [
        "MISSING_INIT_DATA",
        "INVALID_SIGNATURE",
        "EXPIRED_AUTH_DATE",
        "FORBIDDEN_USER",
        "DIRECT_NAVIGATION_FORBIDDEN",
        "CROSS_SITE_FORBIDDEN",
        "PASSWORD_REQUIRED",
        "SESSION_EXPIRED",
        "PASSWORD_LOCKED",
        "INVALID_PASSWORD",
        "INVALID_TOTP_CODE",
        "TOTP_SETUP_EXPIRED",
        "TOTP_ENABLED",
        "TOTP_UPDATED",
        "TOTP_DELETED",
        "MOOD_SWITCHED",
        "MOOD_SWITCH_FAILED",
        "INVALID_CHAT_ID",
        "CHAT_NOT_FOUND",
        "INVALID_CHAT_FEATURE_PARAMS",
        "CHAT_NOT_INITIALIZED",
        "CHAT_INIT_ALREADY_ENABLED",
        "CHAT_INIT_DISABLED",
        "CHAT_INIT_DISABLED_TEARDOWN_FAILED",
        "FEATURE_CONFIG_NOT_READY",
        "FEATURE_ENABLED",
        "FEATURE_DISABLED",
        "PROXY_SEND_ENABLED",
        "PROXY_SEND_DISABLED",
        "INVALID_IDENTITY_PARAMS",
        "INVALID_IDENTITY_ID",
        "INVALID_PERMISSION_PARAMS",
        "INVALID_PICKER_PARAMS",
        "INVALID_PICKER_REQUEST_ID",
        "SUPER_ADMIN_EXEMPT",
        "BLOCKLIST_SUPER_ADMIN_FORBIDDEN",
        "IDENTITY_STORAGE_UNAVAILABLE",
        "IDENTITY_IN_BLOCKLIST",
        "IDENTITY_IN_WHITELIST",
        "WHITELIST_DUPLICATE",
        "WHITELIST_ADDED",
        "WHITELIST_REMOVED",
        "WHITELIST_NOT_FOUND",
        "WHITELIST_PERSIST_FAILED",
        "BLOCKLIST_DUPLICATE",
        "BLOCKLIST_ADDED",
        "BLOCKLIST_REMOVED",
        "BLOCKLIST_NOT_FOUND",
        "PERMISSION_UPDATED",
        "PERMISSION_UNCHANGED",
        "ALL_PERMISSIONS_ENABLED",
        "ALL_PERMISSIONS_UNCHANGED",
        "PERMISSION_PERSIST_FAILED",
        "PICKER_PREPARE_FAILED",
        "PICKER_IMPORT_ADDED",
        "PICKER_IMPORT_DUPLICATE",
        "PICKER_IMPORT_EMPTY",
        "GALLERY_IMAGE_ADDED",
        "GALLERY_IMAGE_EXISTING",
        "GALLERY_DIRECTORY_MISSING",
        "GALLERY_IMAGE_EMPTY",
        "GALLERY_IMAGE_TOO_LARGE",
        "GALLERY_UNSUPPORTED_FORMAT",
        "GALLERY_INVALID_DIMENSIONS",
        "GALLERY_UPLOAD_FAILED",
        "GALLERY_UPLOAD_READ_FAILED",
        "GALLERY_IMAGE_DELETED",
        "GALLERY_IMAGE_NOT_FOUND",
        "GALLERY_INVALID_FILE_NAME",
        "GALLERY_DELETE_FAILED",
        "UNKNOWN_CUSTOM_CODE",
      ];
      for (const code of serverCodes) {
        const noticeText: string = dict.serverNotice(code, {
          id: 77001,
          mood: "傲娇",
          feature: "aiChat",
          configFile: "ai_chat.json",
          key: WHITELIST_PERMISSION_KEYS[0],
          value: true,
          targetList: "whitelist",
          addedCount: 2,
          skippedCount: 1,
          duplicateCount: 1,
          affectedChats: 1,
          totalChats: 2,
          persisted: false,
          fileName: "abc.png",
          width: 12000,
          height: 100,
          remainingAttempts: 2,
          remainingMinutes: 29,
        });
        expect(noticeText.length).toBeGreaterThan(0);
      }
      expect(dict.serverNotice("INVALID_TOTP_CODE").length).toBeGreaterThan(0);
      expect(dict.serverNotice("MOOD_SWITCHED").length).toBeGreaterThan(0);
      expect(
        dict.serverNotice("BLOCKLIST_ADDED", {
          id: 77001,
          targetList: "blocklist",
        }).length
      ).toBeGreaterThan(0);
    }

    expect(["zh", "ja", "en"]).toContain(detectBrowserDefaultLanguage());
    expect(["zh", "ja", "en"]).toContain(detectInitialMiniAppLanguage());
    expect(detectInitialMiniAppTheme()).toBe("light");
    applyMiniAppThemeToDocument("light");

    resetMiniAppStoreForTest();
    expect(useMiniAppStore.getState().theme).toBe("light");
    expect(useMiniAppStore.getState().sidebarOpen).toBeFalse();
    useMiniAppStore.getState().toggleSidebar();
    expect(useMiniAppStore.getState().sidebarOpen).toBeTrue();
    useMiniAppStore.getState().setActiveTab("identities");
    expect(useMiniAppStore.getState().activeTab).toBe("identities");
    expect(useMiniAppStore.getState().sidebarOpen).toBeFalse();
    useMiniAppStore.getState().toggleTheme();
    expect(useMiniAppStore.getState().theme).toBe("dark");
    useMiniAppStore.getState().setLanguage("ja");
    expect(useMiniAppStore.getState().language).toBe("ja");
    useMiniAppStore.getState().showToast("笨蛋杂鱼♡", "danger");
    expect(useMiniAppStore.getState().toastText).toBe("笨蛋杂鱼♡");
    expect(useMiniAppStore.getState().toastTone).toBe("danger");
    useMiniAppStore.getState().clearToast();
    expect(useMiniAppStore.getState().toastText).toBe("");
    const confirmPromise: Promise<boolean> = useMiniAppStore
      .getState()
      .requestConfirm("确认删除？", "danger");
    expect(useMiniAppStore.getState().confirmModal?.message).toBe("确认删除？");
    useMiniAppStore.getState().resolveConfirm(true);
    expect(await confirmPromise).toBeTrue();
    expect(useMiniAppStore.getState().confirmModal).toBeNull();
    resetMiniAppStoreForTest();

    expect(MenuSvgIcon({})).toBeDefined();
    expect(StatusSvgIcon({})).toBeDefined();
    expect(ChatsSvgIcon({})).toBeDefined();
    expect(IdentitiesSvgIcon({})).toBeDefined();
    expect(GallerySvgIcon({})).toBeDefined();
    expect(DownloadSvgIcon({})).toBeDefined();
    expect(SearchSvgIcon({})).toBeDefined();
    expect(TrashSvgIcon({})).toBeDefined();

    expect(getTelegramWebApp()).toBeUndefined();
    expect(readMiniAppInitData()).toBe("");
    expect(confirmMiniAppAction("确认测试？")).toBeTrue();
    expect(sanitizeBidiText("\u202EDoro\u202C")).toBe("Doro");
    expect(truncateDisplayText("短名称", 20)).toBe("短名称");
    expect(MINI_APP_MIN_LOADING_MS).toBeGreaterThanOrEqual(150);
    await waitMinimumLoadingDuration(Date.now() - MINI_APP_MIN_LOADING_MS - 10);
    const minWaitStart: number = Date.now();
    await waitMinimumLoadingDuration(minWaitStart, 20);
    expect(Date.now() - minWaitStart).toBeGreaterThanOrEqual(15);
    expect(
      truncateDisplayText(
        "念云｜工单是不回的｜片是必须看的｜有问题找群you｜群主天天摆烂｜群里充斥大量萝莉控｜空调开放｜群主个臭乐乐",
        20
      )
    ).toBe("念云｜工单是不回的｜片是必须看的｜有问题…");
    expect(formatGalleryFileSize(2_048)).toBe("2.0 KiB");
    expect(formatGalleryFileSize(2 * 1024 * 1024)).toBe("2.00 MiB");
    expect(
      shortenGalleryFileName(
        "004930939ef37baed630e1bbfbc07fadf546783159d874e83f22a592b1a112c2.jpg"
      )
    ).toBe("00493093…a112c2.jpg");
    expect(shortenGalleryFileName("short.png")).toBe("short.png");
    expect(buildMiniAppGalleryImageUrl("abc.jpg")).toBe("./api/gallery/file/abc.jpg");
    expect(buildMiniAppSvgResourceUrl("status.svg")).toBe(
      "./api/resources/svg/status.svg"
    );
    expect(readMiniAppAssetToken()).toBe("");
    setMiniAppAssetToken("b".repeat(64));
    expect(readMiniAppAssetToken()).toBe("b".repeat(64));
    expect(buildMiniAppGalleryImageUrl("abc.jpg")).toBe(
      `./api/gallery/file/abc.jpg?token=${"b".repeat(64)}`
    );
    expect(buildMiniAppSvgResourceUrl("status.svg")).toBe(
      `./api/resources/svg/status.svg?token=${"b".repeat(64)}`
    );
    const storageMap: Map<string, string> = new Map<string, string>();
    const prevLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string): string | null => storageMap.get(key) ?? null,
      setItem: (key: string, val: string): void => {
        storageMap.set(key, val);
      },
      removeItem: (key: string): void => {
        storageMap.delete(key);
      },
    };
    const futureExp: number = Date.now() + 60_000;
    setMiniAppSessionToken("a".repeat(64), futureExp);
    expect(buildMiniAppGalleryDownloadUrl("abc.jpg")).toBe(
      `./api/gallery/download/abc.jpg?token=${"b".repeat(64)}&session=${"a".repeat(64)}`
    );
    clearMiniAppAssetToken();
    expect(readMiniAppAssetToken()).toBe("");
    (globalThis as { __copyNinjaSessionToken?: string }).__copyNinjaSessionToken = undefined;
    (globalThis as { __copyNinjaSessionExpiresAt?: number }).__copyNinjaSessionExpiresAt = undefined;
    expect(readMiniAppSessionToken()).toBe("a".repeat(64));
    expect(readMiniAppSessionExpiresAt()).toBe(futureExp);
    expect(readMiniAppAssetToken()).toBe("b".repeat(64));
    setMiniAppSessionToken("c".repeat(64), Date.now() - 1_000);
    expect(readMiniAppSessionToken()).toBe("");
    expect(readMiniAppSessionExpiresAt()).toBe(0);
    clearMiniAppAssetToken();
    clearMiniAppSessionToken();
    expect(readMiniAppSessionToken()).toBe("");
    (globalThis as { localStorage?: unknown }).localStorage = prevLocalStorage;
  });
});
