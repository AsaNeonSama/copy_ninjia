/**
 * Mini App 前端 `api/` 各接口文件与前端纯函数辅助库：请求方法、路径、请求体与鉴权头，错误归一化、
 * 组件独占 store 钩子，以及多语言字典、格式化函数、资源 URL 与凭据读写（附件下载与会话换算见 sessionTransport.test.ts）。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fetchMiniAppBlocklist } from "../../packages/mini-app-frontend/api/blocklist";
import { setMiniAppBlocklistMembership } from "../../packages/mini-app-frontend/api/blocklistMembership";
import { triggerMiniAppChatBatchKick } from "../../packages/mini-app-frontend/api/chatBatchKick";
import { fetchMiniAppChatDetail } from "../../packages/mini-app-frontend/api/chatDetail";
import { toggleMiniAppChatFeature } from "../../packages/mini-app-frontend/api/chatFeature";
import { fetchMiniAppChatMessages } from "../../packages/mini-app-frontend/api/chatMessages";
import {
  fetchMiniAppChatTargets,
  mutateMiniAppChatTargets,
} from "../../packages/mini-app-frontend/api/chatTargets";
import { fetchMiniAppChats } from "../../packages/mini-app-frontend/api/chats";
import { deleteMiniAppGalleryImageByName } from "../../packages/mini-app-frontend/api/galleryDelete";
import { fetchMiniAppGalleryImageObjectUrl } from "../../packages/mini-app-frontend/api/galleryFile";
import { uploadMiniAppGalleryImageBytes } from "../../packages/mini-app-frontend/api/galleryUpload";
import { updateMiniAppWhitelistPermission } from "../../packages/mini-app-frontend/api/permission";
import { requestMiniAppPreparedPicker } from "../../packages/mini-app-frontend/api/pickerPrepare";
import { pollMiniAppPickerResult } from "../../packages/mini-app-frontend/api/pickerResult";
import {
  miniAppFetchJson,
  prepareEncryptedMiniAppQueryRequest,
} from "../../packages/mini-app-frontend/api/request";
import type { PreparedEncryptedMiniAppQueryRequest } from "../../packages/mini-app-frontend/api/request";
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
import { ConfirmModal } from "../../packages/mini-app-frontend/components/ConfirmModal";
import { PermissionDrawer } from "../../packages/mini-app-frontend/components/PermissionDrawer";
import { PrefsBar } from "../../packages/mini-app-frontend/components/PrefsBar";
import { Toast } from "../../packages/mini-app-frontend/components/Toast";
import { AuthGatePage } from "../../packages/mini-app-frontend/pages/AuthGatePage";
import { VERBATIM_CONTEXT_MAX } from "../../packages/mini-app-frontend/consts/memory";
import {
  MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
  MINI_APP_INVALID_HANDSHAKE_CODE,
} from "../../packages/mini-app-frontend/consts/miniAppCrypto";
import {
  CHAT_QA_ANSWER_MAX_CHARS,
  CHAT_QA_MAX_PER_CHAT,
  CHAT_QA_QUESTION_MAX_CHARS,
  MINI_APP_CONFIRM_CLOSE_ANIMATION_MS,
  MINI_APP_DARK_BG_COLOR,
  MINI_APP_DARK_HEADER_COLOR,
  MINI_APP_FEATURE_KEYS,
  MINI_APP_INITIAL_THEME,
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS,
  MINI_APP_LANGUAGES,
  MINI_APP_LIGHT_BG_COLOR,
  MINI_APP_LIGHT_HEADER_COLOR,
  MINI_APP_MIN_LOADING_MS,
  MINI_APP_SESSION_EXPIRES_AT_HEADER,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_STORAGE_KEY,
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
  clearMiniAppSessionToken,
  hasMiniAppSessionCryptoKey,
  readMiniAppSessionExpiresAt,
  readMiniAppSessionToken,
} from "../../packages/mini-app-frontend/libs/credentials";
import { unsealMiniAppQuery } from "../../packages/mini-app-api-server/libs/crypto";
import { importMiniAppAesGcmKey } from "../../packages/mini-app-frontend/libs/crypto";
import { areCapabilityStatusEqual } from "../../packages/mini-app-frontend/libs/formatters";
import { waitMinimumLoadingDuration } from "../../packages/mini-app-frontend/libs/loading";
import { getTelegramWebApp, readMiniAppInitData } from "../../packages/mini-app-frontend/libs/telegram";
import {
  GlobeSvgIcon,
  MenuSvgIcon,
  TabSvgIcon,
} from "../../packages/mini-app-frontend/resource";
import { applyMiniAppThemeToDocument, resetMiniAppStoreForTest, useMiniAppStore } from "../../packages/mini-app-frontend/store/app";
import { createMessagesStore } from "../../packages/mini-app-frontend/store/messages";
import type { MiniAppMessagesStoreState } from "../../packages/mini-app-frontend/store/messages";
import type { MiniAppLanguage } from "../../packages/mini-app-frontend/types/miniApp";
import {
  createInMemoryIdbFactory,
  seedTestMiniAppSession,
  TEST_SESSION_KEY,
  wrapEncryptedTestFetch,
} from "./helpers/encryptedFetchMock";

/** 一次被记录的请求。 */
interface RecordedRequest {
  readonly key: string;
  readonly body: string | null;
  readonly bytes: Uint8Array | null;
  readonly headers: Readonly<Record<string, string>>;
}

const requests: RecordedRequest[] = [];
const responses: Map<string, () => Response> = new Map<string, () => Response>();
const originalFetch: typeof fetch = globalThis.fetch;
const originalIndexedDb: unknown = (globalThis as { indexedDB?: unknown }).indexedDB;
const initialWindowDescriptor: PropertyDescriptor | undefined =
  Object.getOwnPropertyDescriptor(globalThis, "window");
const session: string = "e".repeat(64);

beforeEach((): void => {
  requests.length = 0;
  responses.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = createInMemoryIdbFactory();
  (globalThis as { Telegram?: unknown }).Telegram = { WebApp: { initData: "signed-init-data" } };
  seedTestMiniAppSession(session, Date.now() + 60_000);
  globalThis.fetch = wrapEncryptedTestFetch((url: URL, init?: RequestInit): Response => {
    const key: string = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}${url.search}`;
    requests.push({
      key,
      body: typeof init?.body === "string" ? init.body : null,
      bytes: init?.body instanceof Uint8Array ? new Uint8Array(init.body) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return responses.get(key)?.() ?? Response.json({ ok: true, result: null, items: [], detail: null });
  });
});

afterEach((): void => {
  globalThis.fetch = originalFetch;
  if (originalIndexedDb === undefined) {
    Reflect.deleteProperty(globalThis, "indexedDB");
  } else {
    (globalThis as { indexedDB?: unknown }).indexedDB = originalIndexedDb;
  }
  if (initialWindowDescriptor !== undefined) {
    Object.defineProperty(globalThis, "window", initialWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
  Reflect.deleteProperty(globalThis, "Telegram");
  Reflect.deleteProperty(globalThis, "document");
  clearMiniAppSessionToken();
});

describe("前端接口文件与纯函数辅助库", () => {
  test("每个接口按约定的方法、路径与 JSON 请求体发出，并附带 initData 与会话令牌", async () => {
    await fetchMiniAppChats();
    await fetchMiniAppChatDetail(-100);
    await fetchMiniAppChatMessages(-100, 2, 15);
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
      "GET /api/chats/detail?chatId=-100",
      "GET /api/chats/messages?chatId=-100&page=2&pageSize=15",
      "GET /api/chats/targets?chatId=-100",
      'POST /api/chats/targets {"chatId":-100,"action":"setQa","q":"hi","a":"yo"}',
      'POST /api/chats/feature {"chatId":-100,"feature":"aiChat","enabled":true}',
      'POST /api/chats/batch-kick {"chatId":-100,"hours":6}',
      "GET /api/identities/whitelist?page=2&pageSize=15&query=doro",
      'POST /api/identities/whitelist {"id":7,"enabled":true}',
      "GET /api/identities/blocklist?page=1&pageSize=10",
      'POST /api/identities/blocklist {"id":7,"enabled":false}',
      'POST /api/identities/permission {"id":7,"enableAll":true}',
      `POST /api/identities/permission ${JSON.stringify({ id: 7, key: permissionKey, value: false })}`,
      'POST /api/picker/prepare {"targetList":"blocklist","subjectKind":"channel"}',
      "GET /api/picker/result?requestId=3",
      'POST /api/gallery/delete {"fileName":"a b.png"}',
      "GET /api/totp",
      "POST /api/totp/setup {}",
      'POST /api/totp/enable {"code":"123456"}',
      "DELETE /api/totp {}",
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

  test("图片上传经会话密钥加密二进制帧提交，回执缺失时按 HTTP 状态报错或返回失败结果", async () => {
    responses.set("POST /api/gallery/upload", (): Response => Response.json({ ok: true, outcome: "added", message: "ok" }));
    expect((await uploadMiniAppGalleryImageBytes(new Uint8Array([1, 2]))).outcome).toBe("added");
    expect(requests[0]?.headers["Content-Type"]).toBe("application/octet-stream");
    expect(requests[0]?.bytes).toEqual(new Uint8Array([1, 2]));
    responses.set("POST /api/gallery/upload", (): Response => new Response("x", { status: 413 }));
    await expect(uploadMiniAppGalleryImageBytes(new Uint8Array([1]))).rejects.toThrow("HTTP 413");
    responses.set("POST /api/gallery/upload", (): Response => Response.json({}));
    expect((await uploadMiniAppGalleryImageBytes(new Uint8Array([1]))).outcome).toBe("failed");
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
    resetMiniAppStoreForTest();
  });

  test("UI 格式化与辅助纯函数覆盖全枚举分支", async () => {
    (globalThis as { Telegram?: unknown }).Telegram = undefined;
    clearMiniAppSessionToken();

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

    const expectedSearchPlaceholders: Readonly<Record<MiniAppLanguage, string>> = {
      zh: "写清楚，杂鱼",
      en: "Write clearly, Zaako",
      ja: "はっきり書きなさい",
    };
    const expectedNumericIdPlaceholders: Readonly<Record<MiniAppLanguage, string>> = {
      zh: "快写，杂鱼",
      en: "Write fast, Zaako",
      ja: "早く書きなさい、雑魚",
    };
    const expectedConfigSaveButtons: Readonly<Record<MiniAppLanguage, string>> = {
      zh: "保存",
      en: "Save",
      ja: "保存",
    };
    for (const lang of MINI_APP_LANGUAGES) {
      const dict = getMiniAppTranslations(lang);
      expect(dict.languageLabel.length).toBeGreaterThan(0);
      expect(dict.languageMenuAria.length).toBeGreaterThan(0);
      expect(GlobeSvgIcon({ language: lang })).toBeDefined();
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
        const meta = dict.chats.featureMeta[featureKey];
        expect(meta.label.length).toBeGreaterThan(0);
        expect(meta.command.startsWith("/")).toBeTrue();
      }
      for (const permKey of WHITELIST_PERMISSION_KEYS) {
        expect(dict.permissionDrawer.labels[permKey].length).toBeGreaterThan(0);
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
      expect(dict.chats.targetsModalSubtitle("群A", 2, CHAT_QA_MAX_PER_CHAT)).toContain(
        `2/${CHAT_QA_MAX_PER_CHAT}`
      );
      expect(dict.chats.qaOpenEditorButton.length).toBeGreaterThan(0);
      expect(dict.chats.qaCancelEditButton.length).toBeGreaterThan(0);
      expect(dict.chats.qaQuestionPlaceholder(CHAT_QA_QUESTION_MAX_CHARS)).toContain(
        String(CHAT_QA_QUESTION_MAX_CHARS)
      );
      expect(dict.chats.qaAnswerPlaceholder(CHAT_QA_ANSWER_MAX_CHARS)).toContain(
        String(CHAT_QA_ANSWER_MAX_CHARS)
      );
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
          hotMessageMax: VERBATIM_CONTEXT_MAX,
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
      const expectedSearchPlaceholder: string = expectedSearchPlaceholders[lang];
      const expectedNumericIdPlaceholder: string = expectedNumericIdPlaceholders[lang];
      expect(dict.identities.searchPlaceholder.length).toBeGreaterThan(0);
      expect(dict.identities.searchPlaceholder).toBe(expectedSearchPlaceholder);
      if (lang === "ja") {
        expect(dict.identities.searchPlaceholder).not.toContain("雑魚");
      } else if (lang === "zh") {
        expect(dict.identities.searchPlaceholder).toContain("杂鱼");
      } else {
        expect(dict.identities.searchPlaceholder).toContain("Zaako");
      }
      expect(dict.identities.idInputPlaceholder.length).toBeGreaterThan(0);
      expect(dict.identities.idInputPlaceholder).toBe(expectedNumericIdPlaceholder);
      expect(dict.chats.deleteTargetInputPlaceholder.length).toBeGreaterThan(0);
      expect(dict.chats.deleteTargetInputPlaceholder).toBe(expectedNumericIdPlaceholder);
      expect(dict.chats.translateTargetInputPlaceholder.length).toBeGreaterThan(0);
      expect(dict.chats.translateTargetInputPlaceholder).toBe(expectedNumericIdPlaceholder);
      expect(dict.configs.saveButton).toBe(expectedConfigSaveButtons[lang]);
      expect(dict.chats.deleteTargetEmptyHint.length).toBeGreaterThan(0);
      expect(dict.chats.deleteTargetEmptyHint).not.toContain("@username");
      expect(dict.serverNotice("TARGET_REQUIRED")).not.toContain("@username");
      expect(dict.serverNotice("TARGET_INVALID")).not.toContain("@username");
      expect(dict.serverNotice("TARGET_USERNAME_NOT_FOUND")).toBe("TARGET_USERNAME_NOT_FOUND");
      expect(dict.gallery.sectionTitle.length).toBeGreaterThan(0);
      expect(dict.gallery.directoryMissingText("/d").length).toBeGreaterThan(0);
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
        "ANTI_RAID_DISABLED_TEARDOWN_FAILED",
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
        "MALFORMED_INIT_DATA",
        "MISSING_HASH",
        "MISSING_USER",
        "CHAT_NOT_SUPERGROUP",
        "CHAT_KIND_UNAVAILABLE",
        "TARGET_NOT_IN_CHAT",
        MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
        MINI_APP_INVALID_HANDSHAKE_CODE,
        "INVALID_CONFIG_TARGET",
        "INVALID_JSON_SYNTAX",
        "CONFIG_VALIDATION_FAILED",
        "CONFIG_SAVED",
        "SERVICE_RESTARTED",
        "SERVICE_RESTART_FAILED",
      ];
      const noticeParams = {
        id: 77001,
        mood: "傲娇",
        feature: "aiChat" as const,
        configFile: "ai_chat.json",
        errorDetail: "detail",
        key: WHITELIST_PERMISSION_KEYS[0],
        value: true,
        targetList: "whitelist" as const,
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
      };
      for (const code of serverCodes) {
        const noticeText: string = dict.serverNotice(code, noticeParams);
        expect(noticeText.length).toBeGreaterThan(0);
        expect(noticeText).not.toBe(code);
      }
      expect(dict.serverNotice("UNKNOWN_CUSTOM_CODE", noticeParams)).toBe(
        "UNKNOWN_CUSTOM_CODE"
      );
      expect(dict.serverNotice("INVALID_TOTP_CODE").length).toBeGreaterThan(0);
      expect(dict.serverNotice("MOOD_SWITCHED").length).toBeGreaterThan(0);
      expect(
        dict.serverNotice("BLOCKLIST_ADDED", {
          id: 77001,
          targetList: "blocklist",
        }).length
      ).toBeGreaterThan(0);
    }
    expect(
      new Set(
        MINI_APP_LANGUAGES.map(
          (lang: MiniAppLanguage): string =>
            getMiniAppTranslations(lang).identities.searchPlaceholder
        )
      ).size
    ).toBe(MINI_APP_LANGUAGES.length);

    expect(MINI_APP_LANGUAGES).toContain(detectBrowserDefaultLanguage());
    expect(MINI_APP_LANGUAGES).toContain(detectInitialMiniAppLanguage());
    const attrs: [string, string][] = [];
    const styleProps: [string, string][] = [];
    const headerColors: string[] = [];
    const bgColors: string[] = [];
    let themeParamsAccessed: boolean = false;
    (globalThis as { document?: unknown }).document = {
      getElementById: (): null => null,
      documentElement: {
        setAttribute: (name: string, val: string): void => { attrs.push([name, val]); },
        style: { setProperty: (prop: string, val: string): void => { styleProps.push([prop, val]); } },
      },
    };
    const mockWebApp: Record<string, unknown> = {
      setHeaderColor: (color: string): void => { headerColors.push(color); },
      setBackgroundColor: (color: string): void => { bgColors.push(color); },
    };
    Object.defineProperty(mockWebApp, "themeParams", {
      get: (): Record<string, string> => {
        themeParamsAccessed = true;
        return { button_color: "#2563eb", link_color: "#3b82f6", button_text_color: "#000000" };
      },
    });
    (globalThis as { Telegram?: unknown }).Telegram = { WebApp: mockWebApp };
    applyMiniAppThemeToDocument("light");
    applyMiniAppThemeToDocument("dark");
    applyMiniAppThemeToDocument("invalid" as never);
    expect(attrs).toEqual([["data-theme", "light"], ["data-theme", "dark"], ["data-theme", MINI_APP_INITIAL_THEME]]);
    expect(headerColors).toEqual([MINI_APP_LIGHT_HEADER_COLOR, MINI_APP_DARK_HEADER_COLOR, MINI_APP_LIGHT_HEADER_COLOR]);
    expect(bgColors).toEqual([MINI_APP_LIGHT_BG_COLOR, MINI_APP_DARK_BG_COLOR, MINI_APP_LIGHT_BG_COLOR]);
    expect(styleProps).toEqual([]);
    expect(themeParamsAccessed).toBeFalse();
    const isolatedBgColors: string[] = [];
    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: {
        setHeaderColor: (): void => { throw new Error("unsupported"); },
        setBackgroundColor: (color: string): void => { isolatedBgColors.push(color); },
      },
    };
    expect((): void => applyMiniAppThemeToDocument("dark")).not.toThrow();
    expect(isolatedBgColors).toEqual([MINI_APP_DARK_BG_COLOR]);
    (globalThis as { document?: unknown }).document = undefined;
    (globalThis as { Telegram?: unknown }).Telegram = undefined;

    resetMiniAppStoreForTest();
    expect(MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS).toBe(
      MINI_APP_CONFIRM_CLOSE_ANIMATION_MS
    );
    expect(useMiniAppStore.getState().theme).toBe(MINI_APP_INITIAL_THEME);
    expect(useMiniAppStore.getState().langMenuOpen).toBeFalse();
    expect(useMiniAppStore.getState().sidebarOpen).toBeFalse();
    const collapsedPrefsHtml: string = renderToStaticMarkup(createElement(PrefsBar));
    expect(collapsedPrefsHtml).toContain('class="lang-dropdown"');
    expect(collapsedPrefsHtml).toContain('aria-expanded="false"');
    expect(collapsedPrefsHtml).not.toContain("lang-menu-popover");
    useMiniAppStore.getState().toggleLangMenu();
    expect(useMiniAppStore.getState().langMenuOpen).toBeTrue();
    const expandedPrefsHtml: string = renderToStaticMarkup(createElement(PrefsBar));
    expect(expandedPrefsHtml).toContain('class="btn icon-btn lang-menu-btn active"');
    expect(expandedPrefsHtml).toContain('aria-expanded="true"');
    expect(expandedPrefsHtml).toContain("lang-menu-popover");
    expect(expandedPrefsHtml).toContain(getMiniAppTranslations("zh").languageLabel);
    expect(expandedPrefsHtml).toContain(getMiniAppTranslations("ja").languageLabel);
    expect(expandedPrefsHtml).toContain(getMiniAppTranslations("en").languageLabel);
    useMiniAppStore.getState().closeLangMenu();
    expect(useMiniAppStore.getState().langMenuOpen).toBeFalse();
    useMiniAppStore.getState().toggleLangMenu();
    expect(useMiniAppStore.getState().langMenuOpen).toBeTrue();
    useMiniAppStore.getState().toggleSidebar();
    expect(useMiniAppStore.getState().sidebarOpen).toBeTrue();
    expect(useMiniAppStore.getState().langMenuOpen).toBeFalse();
    useMiniAppStore.getState().setActiveTab("identities");
    expect(useMiniAppStore.getState().activeTab).toBe("identities");
    expect(useMiniAppStore.getState().sidebarOpen).toBeFalse();
    useMiniAppStore.getState().toggleTheme();
    expect(useMiniAppStore.getState().theme).toBe("dark");
    useMiniAppStore.getState().toggleLangMenu();
    expect(useMiniAppStore.getState().langMenuOpen).toBeTrue();
    useMiniAppStore.getState().setLanguage("ja");
    expect(useMiniAppStore.getState().language).toBe("ja");
    expect(useMiniAppStore.getState().langMenuOpen).toBeFalse();
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
    expect(idleGateHtml).toContain(`<span>${getMiniAppTranslations("zh").gate.passwordSubmitButton}</span>`);
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
    resetMiniAppStoreForTest();

    expect(getTelegramWebApp()).toBeUndefined();
    expect(readMiniAppInitData()).toBe("");
    seedTestMiniAppSession(session, Date.now() + 60_000);
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
    expect(hasMiniAppSessionCryptoKey()).toBeTrue();
    expect(readMiniAppSessionExpiresAt()).toBe(refreshedExp);
    await waitMinimumLoadingDuration(Date.now() - MINI_APP_MIN_LOADING_MS - 10);
    const minWaitStart: number = Date.now();
    await waitMinimumLoadingDuration(minWaitStart, 20);
    expect(Date.now() - minWaitStart).toBeGreaterThanOrEqual(15);
    requests.length = 0;
    responses.set("GET /api/gallery/file?fileName=abc.jpg", (): Response =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          [MINI_APP_SESSION_HEADER]: refreshedSession,
          [MINI_APP_SESSION_EXPIRES_AT_HEADER]: String(refreshedExp + 30_000),
        },
      })
    );
    const previewBlobUrl: string = await fetchMiniAppGalleryImageObjectUrl("abc.jpg");
    expect(previewBlobUrl).toStartWith("blob:");
    expect(requests.at(-1)?.key).toBe("GET /api/gallery/file?fileName=abc.jpg");
    expect(requests.at(-1)?.headers[MINI_APP_SESSION_HEADER]).toBe(refreshedSession);
    expect(readMiniAppSessionExpiresAt()).toBe(refreshedExp + 30_000);
    URL.revokeObjectURL(previewBlobUrl);

    responses.set("GET /api/gallery/file?fileName=missing.jpg", (): Response =>
      Response.json({ error: "IMAGE_NOT_FOUND" }, { status: 404 })
    );
    await expect(fetchMiniAppGalleryImageObjectUrl("missing.jpg")).rejects.toThrow("IMAGE_NOT_FOUND");

    responses.set("GET /api/gallery/file?fileName=expired.jpg", (): Response =>
      Response.json({ code: "PASSWORD_REQUIRED", error: "expired" }, { status: 401 })
    );
    await expect(fetchMiniAppGalleryImageObjectUrl("expired.jpg")).rejects.toThrow(
      "[PASSWORD_REQUIRED] expired"
    );
    expect(readMiniAppSessionToken()).toBe("");
    seedTestMiniAppSession(session, Date.now() + 60_000);
    const sessionKeyObj: CryptoKey = await importMiniAppAesGcmKey(TEST_SESSION_KEY);
    const prepared: PreparedEncryptedMiniAppQueryRequest =
      await prepareEncryptedMiniAppQueryRequest(
        "./api/gallery/download",
        `fileName=${encodeURIComponent("a b&c.png")}`,
        "GET"
      );
    const preparedUrl: URL = new URL(prepared.outboundPath, "https://mini.test/");
    expect(preparedUrl.pathname).toBe("/api/gallery/download");
    expect([...preparedUrl.searchParams.keys()]).toEqual(["e"]);
    const unsealedSpecialQuery: string | null = await unsealMiniAppQuery(
      sessionKeyObj,
      preparedUrl.searchParams.get("e")!,
      "GET /api/gallery/download"
    );
    expect(unsealedSpecialQuery).not.toBeNull();
    expect(new URLSearchParams(unsealedSpecialQuery!).get("fileName")).toBe("a b&c.png");

    const sessionStoreMap: Map<string, string> = new Map<string, string>();
    const prevSessionStorage = (globalThis as { sessionStorage?: unknown }).sessionStorage;
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (key: string): string | null => sessionStoreMap.get(key) ?? null,
      setItem: (key: string, val: string): void => {
        sessionStoreMap.set(key, val);
      },
      removeItem: (key: string): void => {
        sessionStoreMap.delete(key);
      },
    };
    try {
      const futureExp: number = Date.now() + 60_000;
      seedTestMiniAppSession("a".repeat(64), futureExp);
      expect(readMiniAppSessionToken()).toBe("a".repeat(64));
      expect(readMiniAppSessionExpiresAt()).toBe(futureExp);
      expect(sessionStoreMap.get(MINI_APP_SESSION_STORAGE_KEY)).toBe(
        JSON.stringify({ token: "a".repeat(64), expiresAt: futureExp })
      );

      seedTestMiniAppSession("c".repeat(64), Date.now() - 1_000);
      expect(readMiniAppSessionToken()).toBe("");
      expect(readMiniAppSessionExpiresAt()).toBe(0);
      clearMiniAppSessionToken();
      expect(readMiniAppSessionToken()).toBe("");
    } finally {
      (globalThis as { sessionStorage?: unknown }).sessionStorage = prevSessionStorage;
    }
  });

  test("fetchMiniAppGalleryImageObjectUrl 在查询加密前或加密期间收到中止信号时拒绝为 AbortError 且不派发 fetch", async () => {
    let fetchCallCount: number = 0;
    const encryptedFetch: typeof fetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit
    ): Promise<Response> => {
      fetchCallCount += 1;
      return await encryptedFetch(input, init);
    }) as typeof fetch;

    const expectAbortedWithoutFetch = async (
      run: () => Promise<string>
    ): Promise<void> => {
      let capturedError: unknown = null;
      try {
        await run();
      } catch (error: unknown) {
        capturedError = error;
      }
      expect(
        capturedError instanceof DOMException && capturedError.name === "AbortError"
      ).toBeTrue();
      expect(fetchCallCount).toBe(0);
      expect(requests).toHaveLength(0);
    };

    try {
      const preAborted: AbortController = new AbortController();
      preAborted.abort();
      await expectAbortedWithoutFetch((): Promise<string> =>
        fetchMiniAppGalleryImageObjectUrl("pre-aborted.png", preAborted.signal)
      );

      const inFlightController: AbortController = new AbortController();
      const pending: Promise<string> = fetchMiniAppGalleryImageObjectUrl(
        "during-prepare.png",
        inFlightController.signal
      );
      inFlightController.abort();
      await expectAbortedWithoutFetch((): Promise<string> => pending);
    } finally {
      globalThis.fetch = encryptedFetch;
    }
  });
});
