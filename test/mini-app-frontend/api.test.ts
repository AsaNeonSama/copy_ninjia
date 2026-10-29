/**
 * Mini App 前端 `api/` 各接口文件与前端纯函数辅助库：请求方法、路径、请求体与鉴权头，错误归一化、
 * 附件下载、组件独占 store 钩子，以及多语言字典、格式化函数、资源 URL 与凭据读写。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fetchMiniAppBlocklist } from "../../packages/mini-app-frontend/api/blocklist";
import { setMiniAppBlocklistMembership } from "../../packages/mini-app-frontend/api/blocklistMembership";
import { triggerMiniAppChatBatchKick } from "../../packages/mini-app-frontend/api/chatBatchKick";
import { fetchMiniAppChatDetail } from "../../packages/mini-app-frontend/api/chatDetail";
import { toggleMiniAppChatFeature } from "../../packages/mini-app-frontend/api/chatFeature";
import {
  fetchMiniAppChatTargets,
  mutateMiniAppChatTargets,
} from "../../packages/mini-app-frontend/api/chatTargets";
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
import { deleteMiniAppTotp } from "../../packages/mini-app-frontend/api/totpDelete";
import { enableMiniAppTotp } from "../../packages/mini-app-frontend/api/totpEnable";
import { setupMiniAppTotp } from "../../packages/mini-app-frontend/api/totpSetup";
import { fetchMiniAppTotpStatus } from "../../packages/mini-app-frontend/api/totpStatus";
import { fetchMiniAppWhitelist } from "../../packages/mini-app-frontend/api/whitelist";
import { setMiniAppWhitelistMembership } from "../../packages/mini-app-frontend/api/whitelistMembership";
import {
  CollapseGrid,
  TriggerCollapseGrid,
} from "../../packages/mini-app-frontend/components/animations/CollapseGrid";
import { LoadingDotsWave } from "../../packages/mini-app-frontend/components/animations/LoadingDotsWave";
import {
  readElementBodyHeight,
  scrollModalBodyToTop,
} from "../../packages/mini-app-frontend/components/animations/TabHeightSizer";
import {
  computeRangeProgressPercent,
  interpolateSpringRangeValue,
  resolveAnimatedRangeStartValue,
} from "../../packages/mini-app-frontend/components/animations/useAnimatedRangeProgress";
import { AddModeButtonList } from "../../packages/mini-app-frontend/components/AddModeButtonList";
import { ChatTargetsMenuButtonList } from "../../packages/mini-app-frontend/components/ChatTargetsMenuButtonList";
import { ConfirmModal } from "../../packages/mini-app-frontend/components/ConfirmModal";
import { IdentitySubtabsBar } from "../../packages/mini-app-frontend/components/IdentitySubtabsBar";
import { PermissionDrawer } from "../../packages/mini-app-frontend/components/PermissionDrawer";
import { StatusOverviewCard } from "../../packages/mini-app-frontend/components/StatusOverviewCard";
import { Toast } from "../../packages/mini-app-frontend/components/Toast";
import { AuthGatePage } from "../../packages/mini-app-frontend/pages/AuthGatePage";
import {
  MINI_APP_CAP_CLOSE_DURATION_FACTOR,
  MINI_APP_CAP_COLLAPSE_DEFAULT_DURATION_MS,
  MINI_APP_CAP_COLLAPSE_MAX_DURATION_MS,
  MINI_APP_CAP_COLLAPSE_MIN_DURATION_MS,
  MINI_APP_FEATURE_KEYS,
  MINI_APP_HTML_TITLE,
  MINI_APP_INITIAL_THEME,
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_LANGUAGES,
  MINI_APP_MIN_LOADING_MS,
  MINI_APP_SESSION_EXPIRES_AT_HEADER,
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
  areCapabilityStatusEqual,
  buildMiniAppGalleryDownloadFileName,
  computeCapabilityCollapseDurationMs,
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
    await fetchMiniAppChatTargets(-100);
    await mutateMiniAppChatTargets(-100, { action: "setQa", q: "hi", a: "yo" });
    await toggleMiniAppChatFeature(-100, "aiChat", true);
    await triggerMiniAppChatBatchKick(-100, 6);
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
      "GET /api/chats/-100/targets",
      'POST /api/chats/-100/targets {"action":"setQa","q":"hi","a":"yo"}',
      'POST /api/chats/-100/feature {"feature":"aiChat","enabled":true}',
      'POST /api/chats/-100/batch-kick {"hours":6}',
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
    const aDownloadName: string = buildMiniAppGalleryDownloadFileName("a.png");
    expect(await downloadMiniAppGalleryImageByName("a.png", aDownloadName)).toBeFalse();
    expect(requests[0]?.key).toStartWith("HEAD /api/gallery/download/a.png?");
    expect(downloads[0]?.file_name).toBe(aDownloadName);

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
    const bDownloadName: string = buildMiniAppGalleryDownloadFileName("b.webp");
    expect(await downloadMiniAppGalleryImageByName("b.webp", bDownloadName)).toBeTrue();
    expect(clicked).toEqual([bDownloadName]);

    responses.set("HEAD /api/gallery/download/c.png?initData=signed-init-data&session=" + session, (): Response =>
      new Response(null, { status: 401 }));
    responses.set("GET /api/gallery/download/c.png", (): Response =>
      Response.json({ code: "PASSWORD_REQUIRED", error: "login again" }, { status: 401 }));
    await expect(
      downloadMiniAppGalleryImageByName("c.png", buildMiniAppGalleryDownloadFileName("c.png"))
    ).rejects.toThrow("login again");
    expect(readMiniAppSessionToken()).toBe("");
  });

  test("useComponentStore 为组件实例创建独占仓库并按当前状态渲染", async () => {
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

    expect(renderToStaticMarkup(createElement(Toast))).toBe("");
    useMiniAppStore.getState().showToast("删除成功", "warning");
    const toastMarkup: string = renderToStaticMarkup(createElement(Toast));
    expect(toastMarkup).toContain('class="toast show toast-warning"');
    expect(toastMarkup).toContain("删除成功");
    useMiniAppStore.getState().clearToast();

    expect(renderToStaticMarkup(createElement(ConfirmModal))).toBe("");
    const pendingConfirm: Promise<boolean> = useMiniAppStore
      .getState()
      .requestConfirm("确定移除该目标？", "danger");
    const confirmMarkup: string = renderToStaticMarkup(createElement(ConfirmModal));
    expect(confirmMarkup).toContain('class="confirm-backdrop "');
    expect(confirmMarkup).toContain('class="confirm-dialog confirm-danger "');
    expect(confirmMarkup).toContain("确定移除该目标？");
    useMiniAppStore.getState().resolveConfirm(false);
    expect(await pendingConfirm).toBeFalse();

    const permDrawerMarkup: string = renderToStaticMarkup(
      createElement(PermissionDrawer, {
        entry: {
          id: 1001,
          isChannel: false,
          displayName: "Alice",
          permissions: Object.fromEntries(
            WHITELIST_PERMISSION_KEYS.map((key) => [
              key,
              key === WHITELIST_PERMISSION_KEYS[0],
            ])
          ) as Record<(typeof WHITELIST_PERMISSION_KEYS)[number], boolean>,
        },
        descriptors: [],
        onUpdated: (): void => {},
        onClose: (): void => {},
      })
    );
    expect(permDrawerMarkup).toContain('class="perm-drawer-inline"');
    expect(permDrawerMarkup).toContain("Alice");
    resetMiniAppStoreForTest();
  });

  test("UI 格式化与辅助纯函数覆盖全枚举分支", async () => {
    (globalThis as { Telegram?: unknown }).Telegram = undefined;
    clearMiniAppSessionToken();
    clearMiniAppAssetToken();

    expect(formatUptime(90_061_000)).toBe("1d 1h 1m");
    expect(formatUptime(3_661_000)).toBe("1h 1m 1s");
    expect(formatUptime(65_000)).toBe("1m 5s");
    expect(formatMemoryMb(128.456 * 1024 * 1024)).toBe("128.46 MB");
    expect(
      buildMiniAppGalleryDownloadFileName(`${"a".repeat(64)}.PNG`, 1_792_934_567_890)
    ).toBe("1792934567.png");
    expect(formatTime(0)).toBe("-");
    expect(formatTime(1_700_000_000_000).length).toBeGreaterThan(0);
    expect(formatClockTime(0)).toBe("-");
    expect(formatClockTime(1_700_000_000_000)).toMatch(/^\d{2}:\d{2}:\d{2}$/u);

    const baseCap = {
      key: "agent",
      label: "Agent 能力",
      ready: true,
      detail: "text:gemini",
      items: [{ label: "对话 text", value: "gemini", sub: "google" }],
    } as const;
    expect(areCapabilityStatusEqual(baseCap, baseCap)).toBeTrue();
    expect(
      areCapabilityStatusEqual(baseCap, {
        ...baseCap,
        items: [{ label: "对话 text", value: "gemini", sub: "google" }],
      })
    ).toBeTrue();
    expect(areCapabilityStatusEqual(baseCap, { ...baseCap, ready: false })).toBeFalse();
    expect(areCapabilityStatusEqual(baseCap, { ...baseCap, items: [] })).toBeFalse();
    expect(
      areCapabilityStatusEqual(baseCap, {
        ...baseCap,
        items: [{ label: "对话 text", value: "claude", sub: "google" }],
      })
    ).toBeFalse();
    expect(computeCapabilityCollapseDurationMs(0, true)).toBe(
      MINI_APP_CAP_COLLAPSE_DEFAULT_DURATION_MS
    );
    expect(computeCapabilityCollapseDurationMs(40, true)).toBe(
      MINI_APP_CAP_COLLAPSE_MIN_DURATION_MS
    );
    expect(computeCapabilityCollapseDurationMs(600, true)).toBe(
      MINI_APP_CAP_COLLAPSE_MAX_DURATION_MS
    );
    expect(computeCapabilityCollapseDurationMs(600, false)).toBe(
      Math.round(MINI_APP_CAP_COLLAPSE_MAX_DURATION_MS * MINI_APP_CAP_CLOSE_DURATION_FACTOR)
    );
    expect(computeCapabilityCollapseDurationMs(0, false)).toBe(
      Math.round(MINI_APP_CAP_COLLAPSE_DEFAULT_DURATION_MS * MINI_APP_CAP_CLOSE_DURATION_FACTOR)
    );

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
      expect(dict.chats.botPermProbing.length).toBeGreaterThan(0);
      expect(dict.chats.botPermNone.length).toBeGreaterThan(0);
      expect(dict.chats.botPermGrantedTitle(7)).toContain("7");
      expect(dict.chats.botPermLabel("删除消息").length).toBeGreaterThan(0);
      expect(dict.chats.viewMessagesButton.length).toBeGreaterThan(0);
      expect(dict.chats.targetsMenuButton.length).toBeGreaterThan(0);
      expect(dict.chats.targetsKindLabel.qa.length).toBeGreaterThan(0);
      expect(dict.chats.targetsKindLabel.deleteMessage.length).toBeGreaterThan(0);
      expect(dict.chats.targetsKindLabel.translate.length).toBeGreaterThan(0);
      expect(dict.chats.targetsModalSubtitle("群A", 2, 15)).toContain("2/15");
      expect(dict.chats.qaOpenEditorButton.length).toBeGreaterThan(0);
      expect(dict.chats.qaCancelEditButton.length).toBeGreaterThan(0);
      expect(dict.chats.qaQuestionPlaceholder(256)).toContain("256");
      expect(dict.chats.qaAnswerPlaceholder(3840)).toContain("3840");
      expect(
        dict.chats.detailStatsLine({
          chatId: -1001,
          title: "G",
          isLockdownActive: false,
          quietRemainingMs: 0,
          lockdownRemainingMs: 0,
          activeSessions: {
            gag: 0,
            wed: false,
            verify: 0,
            qaSet: false,
          },
          hotMessageCount: 0,
          hotMessageMax: 256,
          qaPairCount: 1,
          deleteMessageTargetCount: 2,
          translateTargetCount: 3,
          joinedCountsByHour: [],
          batchKickRunning: false,
          lastBatchKickCompletion: null,
          features: {
            init: true,
            aiChat: false,
            translation: false,
            adDetect: false,
            floodControl: false,
            antiRaid: false,
            proxySend: false,
          },
          botPermissions: null,
        })
      ).toContain("-1001");
      expect(dict.chats.joinCleanSectionTitle.length).toBeGreaterThan(0);
      expect(dict.chats.batchKickRunningBadge.length).toBeGreaterThan(0);
      expect(dict.chats.windowJoinedLabel.length).toBeGreaterThan(0);
      expect(dict.chats.windowJoinedSub(6)).toContain("6");
      expect(dict.chats.windowJoinedValue(12_345)).toContain("12345");
      expect(dict.chats.batchKickWindowLabel.length).toBeGreaterThan(0);
      expect(dict.chats.batchKickHourPill(6)).toContain("6");
      expect(dict.chats.batchKickDecreaseAria.length).toBeGreaterThan(0);
      expect(dict.chats.batchKickIncreaseAria.length).toBeGreaterThan(0);
      expect(dict.chats.batchKickTriggerButton(6)).toContain("6");
      expect(dict.chats.batchKickTriggerButton(6)).not.toContain("/batch_kick");
      expect(dict.chats.batchKickRunningButton.length).toBeGreaterThan(0);
      expect(
        dict.chats.batchKickCompletedSummary({
          hours: 6,
          recordCount: 5,
          scanned: 5,
          kicked: 3,
          absent: 1,
          protected: 1,
          blocked: 0,
          forbidden: 0,
          failed: 0,
          aborted: false,
          unmanaged: false,
          completedAt: 1_700_000_000_000,
        })
      ).toContain("3");
      expect(dict.chats.confirmBatchKick(6)).toContain("6");
      expect(dict.chats.confirmDeleteQa("q1")).toContain("q1");
      expect(dict.chats.confirmRemoveDeleteTarget("Alice", 7001)).toContain("7001");
      expect(dict.chats.confirmRemoveTranslateTarget("Bob", 7002)).toContain("7002");
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
        "INVALID_BATCH_KICK_PARAMS",
        "BATCH_KICK_RUNNING",
        "JOIN_LOG_UNAVAILABLE",
        "BATCH_KICK_EMPTY",
        "BATCH_KICK_BUSY",
        "BATCH_KICK_ACCEPTED",
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
        "QA_ADDED",
        "QA_UPDATED",
        "QA_REMOVED",
        "QA_NOT_FOUND",
        "QA_EMPTY_FIELDS",
        "QA_QUESTION_TOO_LONG",
        "QA_ANSWER_TOO_LONG",
        "QA_COMMAND_IN_QUESTION",
        "QA_COMMAND_IN_ANSWER",
        "QA_LIMIT_REACHED",
        "QA_STORAGE_FAILED",
        "TARGET_REQUIRED",
        "TARGET_INVALID",
        "TARGET_USERNAME_NOT_FOUND",
        "TARGET_SELF_FORBIDDEN",
        "TARGET_CURRENT_CHAT_FORBIDDEN",
        "DELETE_TARGET_SUPER_ADMIN_FORBIDDEN",
        "DELETE_TARGET_MISSING_BOT_PERMISSION",
        "DELETE_TARGET_ALREADY_EXISTS",
        "DELETE_TARGET_LIMIT_REACHED",
        "DELETE_TARGET_ADDED",
        "DELETE_TARGET_REMOVED",
        "DELETE_TARGET_NOT_FOUND",
        "TRANSLATE_CAPABILITY_UNAVAILABLE",
        "TRANSLATE_FEATURE_DISABLED",
        "TRANSLATE_LANGUAGE_INVALID",
        "TRANSLATE_TARGET_LIMIT_REACHED",
        "TRANSLATE_TARGET_ALREADY_EXISTS",
        "TRANSLATE_TARGET_ADDED",
        "TRANSLATE_TARGET_UPDATED",
        "TRANSLATE_TARGET_REMOVED",
        "TRANSLATE_TARGET_NOT_FOUND",
        "INVALID_CHAT_TARGETS_PARAMS",
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
          hours: 6,
          recordCount: 15,
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
    applyMiniAppThemeToDocument("light");

    resetMiniAppStoreForTest();
    expect(useMiniAppStore.getState().theme).toBe(MINI_APP_INITIAL_THEME);
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
    const openToastHtml: string = renderToStaticMarkup(createElement(Toast));
    expect(openToastHtml).toContain("toast show toast-danger");
    expect(openToastHtml).toContain("笨蛋杂鱼♡");
    useMiniAppStore.getState().clearToast();
    expect(useMiniAppStore.getState().toastText).toBe("");
    expect(renderToStaticMarkup(createElement(Toast))).toBe("");
    const confirmPromise: Promise<boolean> = useMiniAppStore
      .getState()
      .requestConfirm("确认删除？", "danger");
    expect(useMiniAppStore.getState().confirmModal?.message).toBe("确认删除？");
    const openConfirmHtml: string = renderToStaticMarkup(createElement(ConfirmModal));
    expect(openConfirmHtml).toContain("confirm-backdrop");
    expect(openConfirmHtml).toContain("confirm-dialog");
    expect(openConfirmHtml).toContain("确认删除？");
    useMiniAppStore.getState().resolveConfirm(true);
    expect(await confirmPromise).toBeTrue();
    expect(useMiniAppStore.getState().confirmModal).toBeNull();
    expect(renderToStaticMarkup(createElement(ConfirmModal))).toBe("");
    const collapsedGridHtml: string = renderToStaticMarkup(
      createElement(CollapseGrid, {
        expanded: false,
        gridClassName: "perm-drawer-collapse-grid",
        innerClassName: "perm-drawer-collapse-inner",
        children: createElement(PermissionDrawer, {
          entry: {
            id: 1001,
            displayName: "测试成员",
            isChannel: false,
            permissions: Object.fromEntries(
              WHITELIST_PERMISSION_KEYS.map((key) => [key, false])
            ) as never,
          },
          descriptors: [],
          onUpdated: (): void => undefined,
          onClose: (): void => undefined,
        }),
      })
    );
    expect(collapsedGridHtml).toContain('class="perm-drawer-collapse-grid "');
    expect(collapsedGridHtml).toContain('aria-hidden="true"');
    const expandedGridHtml: string = renderToStaticMarkup(
      createElement(CollapseGrid, {
        expanded: true,
        gridClassName: "perm-drawer-collapse-grid",
        innerClassName: "perm-drawer-collapse-inner",
        children: createElement("div", null, "panel"),
      })
    );
    expect(expandedGridHtml).toContain('class="perm-drawer-collapse-grid expanded"');
    expect(expandedGridHtml).toContain('aria-hidden="false"');
    const triggerGridHtml: string = renderToStaticMarkup(
      createElement(TriggerCollapseGrid, {
        collapsed: true,
        gridClassName: "targets-add-trigger-collapse-grid",
        innerClassName: "targets-add-trigger-collapse-inner",
        children: createElement("button", { type: "button" }, "add"),
      })
    );
    expect(triggerGridHtml).toContain("targets-add-trigger-collapse-grid collapsed");
    expect(renderToStaticMarkup(createElement(LoadingDotsWave))).toContain(
      "join-clean-loading-dots"
    );
    useMiniAppStore.setState({ language: "zh", authMode: "password", passwordBusy: false });
    const idleGateHtml: string = renderToStaticMarkup(createElement(AuthGatePage));
    expect(idleGateHtml).toContain(getMiniAppTranslations("zh").gate.passwordSubmitButton);
    expect(idleGateHtml).not.toContain("join-clean-loading-dots");
    useMiniAppStore.setState({ authMode: "totp", passwordBusy: true });
    const busyGateHtml: string = renderToStaticMarkup(createElement(AuthGatePage));
    expect(busyGateHtml).toContain('class="btn primary auth-gate-submit is-loading"');
    expect(busyGateHtml).toContain('aria-busy="true"');
    expect(busyGateHtml).toContain("join-clean-loading-dots");
    expect(busyGateHtml).not.toContain(getMiniAppTranslations("zh").gate.totpSubmitButton);
    expect(readElementBodyHeight(null)).toBe(0);
    expect(readElementBodyHeight({ offsetHeight: 180 })).toBe(180);
    expect(readElementBodyHeight({ scrollHeight: 210 })).toBe(210);
    scrollModalBodyToTop(null);
    const scrolledCalls: { readonly top: number; readonly behavior: "smooth" | "auto" }[] = [];
    scrollModalBodyToTop({
      scrollTo: (opts): void => {
        scrolledCalls.push(opts);
      },
    });
    expect(scrolledCalls).toEqual([{ top: 0, behavior: "smooth" }]);
    const fallbackScrollEl: { scrollTop: number } = { scrollTop: 140 };
    scrollModalBodyToTop(fallbackScrollEl);
    expect(fallbackScrollEl.scrollTop).toBe(0);
    expect(computeRangeProgressPercent(1, 1, 24)).toBe("0.00%");
    expect(computeRangeProgressPercent(24, 1, 24)).toBe("100.00%");
    expect(computeRangeProgressPercent(12.5, 1, 24)).toBe("50.00%");
    const statusOverviewHtml: string = renderToStaticMarkup(
      createElement(StatusOverviewCard, {
        t: getMiniAppTranslations("zh"),
        status: {
          generatedAt: 1_700_000_000_000,
          uptimeMs: 120_000,
          cpuAveragePercent: 0.22,
          memoryCurrentRssBytes: 64 * 1024 * 1024,
          memoryPeakRssBytes: 80 * 1024 * 1024,
          memoryHeapUsedBytes: 32 * 1024 * 1024,
          memoryHeapTotalBytes: 48 * 1024 * 1024,
          memoryOtherBytes: 128 * 1024 * 1024,
          memoryTotalBytes: 1024 * 1024 * 1024,
          managedChatCount: 3,
          whitelistCount: 5,
          blocklistCount: 1,
          activeSessions: { total: 2, gag: 1, wed: 0, verify: 1, qaSet: 0 },
          telegramOutbound: {
            inFlight: 1,
            maxConcurrency: 20,
            waiting: 0,
            retryQueueSize: 0,
            retryQueueMax: 100,
          },
          capabilities: [],
        },
      })
    );
    expect(statusOverviewHtml).toContain('class="stat-value stat-value-active">0.22%</div>');
    expect(statusOverviewHtml).toContain('class="stat-value-active">1</span>');
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
    expect(sanitizeBidiText("\u202EDoro\u202C")).toBe("Doro");
    expect(truncateDisplayText("短名称", 20)).toBe("短名称");
    expect(MINI_APP_MIN_LOADING_MS).toBeGreaterThanOrEqual(150);
    expect(computeRangeProgressPercent(1, 1, 24)).toBe("0.00%");
    expect(computeRangeProgressPercent(24, 1, 24)).toBe("100.00%");
    expect(interpolateSpringRangeValue(1, 6, 0.72)).toBeGreaterThan(6);
    expect(interpolateSpringRangeValue(1, 6, 1)).toBe(6);
    expect(interpolateSpringRangeValue(12, 24, 0.72)).toBeLessThan(24);
    expect(interpolateSpringRangeValue(12, 24, 1)).toBe(24);
    expect(interpolateSpringRangeValue(6, 1, 0.72)).toBeGreaterThan(1);
    expect(interpolateSpringRangeValue(6, 1, 1)).toBe(1);
    // 连续点击与回撤时保证至少有足够位移区间驱动弹跳动画
    expect(resolveAnimatedRangeStartValue(5.9, 5, 6)).toBeLessThanOrEqual(5.65);
    expect(resolveAnimatedRangeStartValue(5.1, 6, 5)).toBeGreaterThanOrEqual(5.45);
    expect(MINI_APP_HTML_TITLE).toBe("杂鱼控制台♡");
    expect(getMiniAppTranslations("zh").appTitle).toBe("杂鱼控制台♡");
    expect(getMiniAppTranslations("en").appTitle).toBe("Zaako Console♡");
    expect(getMiniAppTranslations("ja").appTitle).toBe("雑魚コンソール♡");
    const addModeHtml: string = renderToStaticMarkup(
      createElement(AddModeButtonList, {
        idFormOpen: true,
        disabled: false,
        interactive: true,
        t: getMiniAppTranslations("zh"),
        onSelectMode: (): void => undefined,
      })
    );
    expect(addModeHtml).toContain("add-mode-grid");
    const targetsMenuHtml: string = renderToStaticMarkup(
      createElement(ChatTargetsMenuButtonList, {
        targetsMenuOpen: true,
        chatDetail: null,
        chatTargets: null,
        t: getMiniAppTranslations("zh"),
        onToggleMenu: (): void => undefined,
        onCloseMenu: (): void => undefined,
        onSelectTargetKind: (): void => undefined,
      })
    );
    expect(targetsMenuHtml).toContain("chat-targets-dropdown");
    const subtabsHtml: string = renderToStaticMarkup(
      createElement(IdentitySubtabsBar, {
        subTab: "whitelist",
        loadingList: false,
        t: getMiniAppTranslations("zh"),
        onSelectSubTab: (): void => undefined,
        onRefresh: (): void => undefined,
      })
    );
    expect(subtabsHtml).toContain("subtabs-bar");
    const refreshedSession: string = "f".repeat(64);
    const refreshedExp: number = Date.now() + 180_000;
    responses.set("GET /api/status", (): Response =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          [MINI_APP_SESSION_HEADER]: refreshedSession,
          [MINI_APP_SESSION_EXPIRES_AT_HEADER]: String(refreshedExp),
        },
      })
    );
    await miniAppFetchJson("/api/status");
    expect(readMiniAppSessionToken()).toBe(refreshedSession);
    expect(readMiniAppSessionExpiresAt()).toBe(refreshedExp);
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
    expect(readMiniAppAssetToken()).toBe("");
    setMiniAppAssetToken("b".repeat(64));
    expect(readMiniAppAssetToken()).toBe("b".repeat(64));
    expect(buildMiniAppGalleryImageUrl("abc.jpg")).toBe(
      `./api/gallery/file/abc.jpg?token=${"b".repeat(64)}`
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
