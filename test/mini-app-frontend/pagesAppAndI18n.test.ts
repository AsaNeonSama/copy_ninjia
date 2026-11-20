/**
 * Mini App 前端页面（`TotpPage`、`ChatsPage`）、根组件 `App` 与多语言翻译模块（`i18n/languages/{en,ja,zh}`、`i18n/configs/{en,ja,zh}`、`i18n/index`）挂载与分支覆盖测试。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { App } from "../../packages/mini-app-frontend/App";
import {
  MINI_APP_BATCH_KICK_MAX_HOURS,
  MINI_APP_BATCH_KICK_POLL_INTERVAL_MS,
} from "../../packages/mini-app-frontend/consts/miniApp";
import {
  MINI_APP_INVALID_HANDSHAKE_CODE,
  MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE,
} from "../../packages/mini-app-frontend/consts/miniAppCrypto";
import { VERBATIM_CONTEXT_MAX } from "../../packages/mini-app-frontend/consts/memory";
import { WHITELIST_PERMISSION_KEYS } from "../../packages/mini-app-frontend/consts/whitelist";
import {
  detectBrowserDefaultLanguage,
  detectInitialMiniAppLanguage,
  extractServerNoticeParams,
  getMiniAppTranslations,
} from "../../packages/mini-app-frontend/i18n";
import { formatEnConfigServerNotice } from "../../packages/mini-app-frontend/i18n/configs/en";
import { formatJaConfigServerNotice } from "../../packages/mini-app-frontend/i18n/configs/ja";
import { formatZhConfigServerNotice } from "../../packages/mini-app-frontend/i18n/configs/zh";
import { clearMiniAppSessionToken } from "../../packages/mini-app-frontend/libs/credentials";
import { ChatsPage } from "../../packages/mini-app-frontend/pages/ChatsPage";
import { IdentitiesPage } from "../../packages/mini-app-frontend/pages/IdentitiesPage";
import { TotpPage } from "../../packages/mini-app-frontend/pages/TotpPage";
import { resetMiniAppStoreForTest, useMiniAppStore } from "../../packages/mini-app-frontend/store/app";
import { createChatsStore } from "../../packages/mini-app-frontend/store/chats";
import { createTotpStore } from "../../packages/mini-app-frontend/store/totp";
import type { WhitelistPermissionKey } from "../../packages/mini-app-frontend/types/identityPolicy";
import type {
  MiniAppCapabilityDetailItem,
  MiniAppChatDetail,
  MiniAppChatSummary,
} from "../../packages/mini-app-frontend/types/miniApp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";
import {
  collectNodeText,
  findButtonByText,
  findElements,
  hasClass,
  installMiniDom,
} from "../helpers/miniAppDom";
import type { MiniDomEnvironment, MiniDomNode } from "../helpers/miniAppDom";
import { seedTestMiniAppSession, wrapEncryptedTestFetch } from "./helpers/encryptedFetchMock";
import { flushFakeTimersUntil, flushUntil } from "./helpers/fakeTimerFlush";

type RouteHandler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

const routes: Map<string, RouteHandler> = new Map<string, RouteHandler>();
const originalFetch: typeof fetch = globalThis.fetch;
const zh: Readonly<MiniAppTranslations> = getMiniAppTranslations("zh");

function route(key: string, handler: RouteHandler): void {
  routes.set(key, handler);
}

function getReactPropHandler(
  node: MiniDomNode,
  propName: string
): ((event: Record<string, unknown>) => void) | undefined {
  const record: Record<string, unknown> = node as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key.startsWith("__reactProps$")) {
      const propsObj: Record<string, unknown> | undefined = record[key] as
        | Record<string, unknown>
        | undefined;
      const handler: unknown = propsObj?.[propName];
      if (typeof handler === "function") {
        return handler as (event: Record<string, unknown>) => void;
      }
    }
  }
  return undefined;
}

function sampleChatSummary(chatId: number = -1001, title: string = "受管群A"): Readonly<MiniAppChatSummary> {
  return {
    chatId,
    title,
    isLockdownActive: true,
    hotMessageCount: 4,
    qaPairCount: 1,
    features: {
      init: true,
      aiChat: true,
      translation: true,
      adDetect: false,
      floodControl: false,
      antiRaid: false,
      proxySend: true,
    },
  };
}

function sampleChatDetail(overrides: Partial<MiniAppChatDetail> = {}): Readonly<MiniAppChatDetail> {
  return {
    chatId: -1001,
    title: "受管群A",
    isLockdownActive: false,
    quietRemainingMs: 0,
    lockdownRemainingMs: 0,
    activeSessions: { gag: 0, wed: false, verify: 0, qaSet: false },
    hotMessageCount: 4,
    hotMessageMax: VERBATIM_CONTEXT_MAX,
    qaPairCount: 1,
    deleteMessageTargetCount: 0,
    translateTargetCount: 0,
    joinedCountsByHour: Array.from(
      { length: MINI_APP_BATCH_KICK_MAX_HOURS },
      (_: unknown, idx: number): number => idx + 1
    ),
    batchKickRunning: false,
    lastBatchKickCompletion: null,
    features: {
      init: true,
      aiChat: true,
      translation: true,
      adDetect: false,
      floodControl: false,
      antiRaid: false,
      proxySend: false,
    },
    botPermissions: {
      canDeleteMessages: true,
      canRestrictMembers: true,
      canChangeInfo: false,
      grantedLabels: ["canDeleteMessages", "canRestrictMembers"],
    },
    ...overrides,
  };
}

async function withMountedDom(
  run: (ctx: { readonly env: MiniDomEnvironment; readonly container: MiniDomNode; readonly root: Root }) => Promise<void> | void
): Promise<void> {
  const env: MiniDomEnvironment = installMiniDom();
  const container: MiniDomNode = env.document.createElement("div");
  const root: Root = createRoot(container as unknown as Element);
  try {
    await run({ env, container, root });
  } finally {
    await act(async (): Promise<void> => {
      root.unmount();
    });
    env.restore();
  }
}

beforeEach((): void => {
  routes.clear();
  resetMiniAppStoreForTest();
  seedTestMiniAppSession("d".repeat(64), Date.now() + 600_000);
  globalThis.fetch = wrapEncryptedTestFetch(
    (url: URL, init?: RequestInit): Response | Promise<Response> => {
      const key: string = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
      const handler: RouteHandler | undefined = routes.get(key);
      if (handler === undefined) return Response.json({ error: `unhandled ${key}` }, { status: 404 });
      return handler(url, init);
    }
  );
});

afterEach((): void => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  clearMiniAppSessionToken();
  resetMiniAppStoreForTest();
});

describe("Mini App 页面组件（TotpPage、ChatsPage、App）真实挂载交互测试", () => {
  test("TotpPage 覆盖未启用态、刷新、生成二维码、动态码输入清洗/提交、忙碌态、取消与已启用态删除", async () => {
    jest.useFakeTimers();
    const store = createTotpStore();
    let statusCalls: number = 0;
    const setupGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const enableGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    let enableSubmitCount: number = 0;
    let deleteCount: number = 0;

    route("GET /api/totp", (): Response => {
      statusCalls += 1;
      return Response.json({ enabled: false, createdAt: null, maskedSecret: null });
    });
    route("POST /api/totp/setup", async (): Promise<Response> => {
      await setupGate.promise;
      return Response.json({
        ok: true,
        secret: "JBSWY3DPEHPK3PXP",
        otpauthUri: "otpauth://totp/test",
        qrSvg: "<svg><rect /></svg>",
        expiresAt: Date.now() + 300_000,
      });
    });
    route("POST /api/totp/enable", async (): Promise<Response> => {
      enableSubmitCount += 1;
      await enableGate.promise;
      return Response.json({
        ok: true,
        message: "TOTP_ENABLED",
        status: { enabled: true, createdAt: 1_700_000_000_000, maskedSecret: "JBSW••••" },
      });
    });
    route("DELETE /api/totp", (): Response => {
      deleteCount += 1;
      return Response.json({
        ok: true,
        message: "TOTP_DELETED",
        status: { enabled: false, createdAt: null, maskedSecret: null },
      });
    });

    await withMountedDom(async ({ container, root }): Promise<void> => {
      await act(async (): Promise<void> => {
        root.render(createElement(TotpPage, { storeFactory: () => store }));
      });
      await act(async (): Promise<void> => {
        await flushFakeTimersUntil((): boolean => !store.getState().loadingStatus && store.getState().totpStatus !== null);
      });
      expect(statusCalls).toBe(1);
      expect(collectNodeText(container)).toContain(zh.totp.statusDescDisabled);

      // 点击刷新按钮重新拉取状态。
      await act(async (): Promise<void> => {
        findButtonByText(container, zh.chats.refreshButton)!.triggerClick();
        await flushFakeTimersUntil((): boolean => statusCalls === 2 && !store.getState().loadingStatus);
      });

      // 点击添加按钮进入 startSetupBusy，释放后展示二维码与表单。
      await act(async (): Promise<void> => {
        findButtonByText(container, zh.totp.addButton)!.triggerClick();
      });
      expect(store.getState().busy).toBeTrue();
      await act(async (): Promise<void> => {
        setupGate.resolve();
        await flushFakeTimersUntil((): boolean => store.getState().setupData !== null && !store.getState().busy);
      });
      expect(collectNodeText(container)).toContain("JBSWY3DPEHPK3PXP");

      // 在动态码输入框输入混杂字符，验证 onChange 自动过滤非数字并截断 6 位。
      const codeInput: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "totp-verify-input")
      )[0]!;
      await act(async (): Promise<void> => {
        getReactPropHandler(codeInput, "onChange")?.({ currentTarget: { value: "12a-34b-5678" } });
      });
      expect(store.getState().codeInput).toBe("123456");

      // 提交表单进入 verifyBusy（渲染 LoadingDotsWave），释放后切换为已启用态。
      const formEl: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "totp-setup-panel")
      )[0]!;
      let prevented: number = 0;
      await act(async (): Promise<void> => {
        getReactPropHandler(formEl, "onSubmit")?.({
          preventDefault: (): void => {
            prevented += 1;
          },
        });
      });
      expect(prevented).toBe(1);
      expect(store.getState().busy).toBeTrue();
      const verifySubmitBtn: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "totp-verify-submit")
      )[0]!;
      expect(hasClass(verifySubmitBtn, "is-loading")).toBeTrue();
      expect(findElements(verifySubmitBtn, (el): boolean => hasClass(el, "loading-dots-wave"))).toHaveLength(1);

      await act(async (): Promise<void> => {
        enableGate.resolve();
        await flushFakeTimersUntil((): boolean => store.getState().totpStatus?.enabled === true && !store.getState().busy);
      });
      expect(enableSubmitCount).toBe(1);
      expect(collectNodeText(container)).toContain(zh.totp.modifyButton);

      // 点击取消与删除按钮。
      await act(async (): Promise<void> => {
        findButtonByText(container, zh.totp.deleteButton)!.triggerClick();
      });
      expect(useMiniAppStore.getState().confirmModal?.message).toBe(zh.totp.confirmDeleteTotp);
      await act(async (): Promise<void> => {
        useMiniAppStore.getState().resolveConfirm(true);
        await flushFakeTimersUntil((): boolean => deleteCount === 1 && !store.getState().busy);
      });
      expect(store.getState().totpStatus?.enabled).toBeFalse();
    });
  });

  test("ChatsPage 覆盖空列表/有群列表/刷新、群详情三种 Bot 权限态、批踢轮询与消息视图切换", async () => {
    jest.useFakeTimers();
    const store = createChatsStore();
    let listCalls: number = 0;
    let detailCalls: number = 0;
    let currentChats: readonly Readonly<MiniAppChatSummary>[] = [];
    let currentDetail: Readonly<MiniAppChatDetail> = sampleChatDetail({
      botPermissions: null,
      batchKickRunning: true,
    });

    route("GET /api/chats", (): Response => {
      listCalls += 1;
      return Response.json({ items: currentChats });
    });
    route("GET /api/chats/detail", (): Response => {
      detailCalls += 1;
      return Response.json({ detail: currentDetail });
    });
    route("GET /api/chats/messages", (): Response =>
      Response.json({
        chatId: -1001,
        chatTitle: "受管群A",
        items: [],
        page: 1,
        pageSize: 10,
        total: 0,
        totalPages: 1,
        maxCapacity: VERBATIM_CONTEXT_MAX,
      }));

    await withMountedDom(async ({ container, root }): Promise<void> => {
      await act(async (): Promise<void> => {
        root.render(createElement(ChatsPage, { storeFactory: () => store }));
      });
      // 1. 空列表提示。
      await act(async (): Promise<void> => {
        await flushFakeTimersUntil((): boolean => !store.getState().loadingList && listCalls === 1);
      });
      expect(collectNodeText(container)).toContain(zh.chats.emptyChatsHint);

      // 2. 填入群并点击刷新按钮，验证 ManagedChatList 渲染并点击进入群详情。
      currentChats = [sampleChatSummary(-1001, "测试主群")];
      await act(async (): Promise<void> => {
        findButtonByText(container, zh.chats.refreshButton)!.triggerClick();
        await flushFakeTimersUntil((): boolean => !store.getState().loadingList && store.getState().chats.length === 1);
      });
      expect(collectNodeText(container)).toContain("测试主群");

      // 点击群行管理按钮进入详情：先看到探测中权限提示（botPermissions === null）且启动 batchKick 轮询定时器。
      const chatRowBtn: MiniDomNode = findButtonByText(container, zh.chats.detailSectionTitle)!;
      await act(async (): Promise<void> => {
        chatRowBtn.triggerClick();
        await flushFakeTimersUntil((): boolean => !store.getState().loadingDetail && store.getState().chatDetail !== null);
      });
      expect(collectNodeText(container)).toContain(zh.chats.botPermProbing);

      // 推进批踢轮询间隔，确认 ChatsPage 的 setInterval 发起 pollRunningBatchKick。
      const detailCallsBeforePoll: number = detailCalls;
      currentDetail = sampleChatDetail({
        botPermissions: {
          canDeleteMessages: false,
          canRestrictMembers: false,
          canChangeInfo: false,
          grantedLabels: [],
        },
        batchKickRunning: false,
      });
      await act(async (): Promise<void> => {
        jest.advanceTimersByTime(MINI_APP_BATCH_KICK_POLL_INTERVAL_MS);
        await flushUntil((): boolean => detailCalls > detailCallsBeforePoll && store.getState().chatDetail?.batchKickRunning === false);
      });
      expect(collectNodeText(container)).toContain(zh.chats.botPermNone);

      // 3. 切换为带已授予权限标签的详情并点击展开按钮，验证 BotPermTagGrid 渲染。
      await act(async (): Promise<void> => {
        store.setState({
          chatDetail: sampleChatDetail({
            botPermissions: {
              canDeleteMessages: true,
              canRestrictMembers: true,
              canChangeInfo: false,
              grantedLabels: ["canDeleteMessages", "canRestrictMembers"],
            },
          }),
        });
      });
      const permToggle: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "bot-perm-granted-toggle")
      )[0]!;
      await act(async (): Promise<void> => {
        permToggle.triggerClick();
      });
      expect(store.getState().botPermsExpanded).toBeTrue();
      expect(findElements(container, (el): boolean => hasClass(el, "bot-perm-tag"))).toHaveLength(2);

      // 4. 切换至热发言记录视图再返回群详情。
      await act(async (): Promise<void> => {
        findButtonByText(container, zh.chats.viewMessagesButton)!.triggerClick();
      });
      expect(store.getState().viewingMessages).toBeTrue();
      await act(async (): Promise<void> => {
        findButtonByText(container, zh.messages.backButton)!.triggerClick();
        await flushFakeTimersUntil((): boolean => !store.getState().loadingDetail);
      });
      expect(store.getState().viewingMessages).toBeFalse();
    });
  });

  test("App 根组件同步主题/标题/多语言 <html lang>、驱动首屏预检并按 gateState 切换视图与卸载清定时器", async () => {
    let precheckCalls: number = 0;
    route("GET /api/auth/precheck", (): Response => {
      precheckCalls += 1;
      return Response.json({ ok: false, code: "FORBIDDEN_USER", error: "forbidden" }, { status: 403 });
    });

    await withMountedDom(async ({ env, container, root }): Promise<void> => {
      useMiniAppStore.setState({ gateState: "checking", language: "zh", theme: "light" });
      await act(async (): Promise<void> => {
        root.render(createElement(App));
      });
      await act(async (): Promise<void> => {
        await flushUntil((): boolean => useMiniAppStore.getState().gateState === "denied");
      });
      expect(precheckCalls).toBe(1);
      expect((env.document as unknown as { title?: string }).title).toBe(zh.appTitle);
      expect(env.document.documentElement.getAttribute("lang")).toBe("zh-CN");
      expect(collectNodeText(container)).toContain("FORBIDDEN_USER");

      // 切换 en 与 ja 语言以及暗色主题，同步 document.title 与 <html lang>。
      await act(async (): Promise<void> => {
        useMiniAppStore.getState().setLanguage("en");
        useMiniAppStore.setState({ theme: "dark", gateState: "password" });
      });
      expect(env.document.documentElement.getAttribute("lang")).toBe("en-US");
      expect((env.document as unknown as { title?: string }).title).toBe(
        getMiniAppTranslations("en").appTitle
      );

      await act(async (): Promise<void> => {
        useMiniAppStore.getState().setLanguage("ja");
        useMiniAppStore.setState({ gateState: "unlocked" });
      });
      expect(env.document.documentElement.getAttribute("lang")).toBe("ja");
      expect((env.document as unknown as { title?: string }).title).toBe(
        getMiniAppTranslations("ja").appTitle
      );
    });
  });

  test("IdentitiesPage 覆盖白/黑名单子页切换、重复提示横幅关闭、空搜索提示、刷新与黑名单列表渲染", async () => {
    jest.useFakeTimers();
    let wlCalls: number = 0;
    let blCalls: number = 0;
    const allFalsePerms: Record<WhitelistPermissionKey, boolean> = Object.fromEntries(
      WHITELIST_PERMISSION_KEYS.map((k: WhitelistPermissionKey): readonly [WhitelistPermissionKey, boolean] => [k, false])
    ) as Record<WhitelistPermissionKey, boolean>;
    let returnEmptyWl: boolean = false;
    let returnEmptyBl: boolean = false;

    route("GET /api/identities/whitelist", (): Response => {
      wlCalls += 1;
      return Response.json({
        items: returnEmptyWl
          ? []
          : [{ id: 101, isChannel: false, displayName: "Alice", username: "alice", permissions: allFalsePerms }],
        total: returnEmptyWl ? 0 : 1,
        whitelistTotal: returnEmptyWl ? 0 : 1,
        blocklistTotal: returnEmptyBl ? 0 : 1,
        page: 1,
        pageSize: 10,
        totalPages: 1,
      });
    });
    route("POST /api/identities/whitelist", (): Response =>
      Response.json({
        ok: true,
        duplicate: true,
        changed: false,
        id: 101,
        message: "WHITELIST_DUPLICATE",
      })
    );
    route("GET /api/identities/blocklist", (): Response => {
      blCalls += 1;
      return Response.json({
        items: returnEmptyBl
          ? []
          : [{ id: 202, isChannel: false, displayName: "BlockedBob", username: "bob", blockedAt: "2026/05/01 00:00:00" }],
        total: returnEmptyBl ? 0 : 1,
        whitelistTotal: returnEmptyWl ? 0 : 1,
        blocklistTotal: returnEmptyBl ? 0 : 1,
        page: 1,
        pageSize: 10,
        totalPages: 1,
      });
    });

    await withMountedDom(async ({ container, root }): Promise<void> => {
      await act(async (): Promise<void> => {
        root.render(createElement(IdentitiesPage));
      });
      await act(async (): Promise<void> => {
        await flushFakeTimersUntil(
          (): boolean => wlCalls === 1 && collectNodeText(container).includes("Alice")
        );
      });

      // 通过真实按 ID 重复添加触发重复导入警告横幅，并点击横幅关闭按钮收起。
      await act(async (): Promise<void> => {
        findElements(container, (el): boolean => hasClass(el, "add-fold-trigger"))[0]!.triggerClick();
      });
      await act(async (): Promise<void> => {
        findButtonByText(container, zh.identities.addModes.id)!.triggerClick();
      });
      const idInput: MiniDomNode = findElements(
        container,
        (el): boolean => el.tagName === "INPUT" && !hasClass(el, "search-input")
      )[0]!;
      await act(async (): Promise<void> => {
        getReactPropHandler(idInput, "onChange")?.({ currentTarget: { value: "101" } });
      });
      await act(async (): Promise<void> => {
        findButtonByText(container, zh.identities.idConfirmButton)!.triggerClick();
      });
      await act(async (): Promise<void> => {
        await flushFakeTimersUntil(
          (): boolean => findElements(container, (el): boolean => hasClass(el, "duplicate-alert-banner")).length === 1
        );
      });
      const bannerNode: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "duplicate-alert-banner")
      )[0]!;
      expect(collectNodeText(bannerNode)).toContain("101");
      await act(async (): Promise<void> => {
        findElements(bannerNode, (el): boolean => el.tagName === "BUTTON")[0]!.triggerClick();
      });

      // 搜索无结果时展示空搜索提示，点击刷新重新拉取。
      returnEmptyWl = true;
      const searchInput: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "search-input")
      )[0]!;
      await act(async (): Promise<void> => {
        getReactPropHandler(searchInput, "onChange")?.({ currentTarget: { value: "missing-user" } });
      });
      await act(async (): Promise<void> => {
        getReactPropHandler(searchInput, "onKeyDown")?.({
          key: "Enter",
          preventDefault: (): void => {},
        });
      });
      await act(async (): Promise<void> => {
        await flushFakeTimersUntil(
          (): boolean =>
            wlCalls >= 2 &&
            collectNodeText(container).includes(zh.identities.emptySearchHint("missing-user"))
        );
      });
      const beforeRefreshWl: number = wlCalls;
      await act(async (): Promise<void> => {
        findButtonByText(container, zh.chats.refreshButton)!.triggerClick();
      });
      await act(async (): Promise<void> => {
        await flushFakeTimersUntil((): boolean => wlCalls === beforeRefreshWl + 1);
      });

      // 切换到黑名单子页：渲染非空列表，再切空搜索渲染黑名单空搜索提示。
      await act(async (): Promise<void> => {
        findButtonByText(container, zh.identities.blocklistTab)!.triggerClick();
      });
      await act(async (): Promise<void> => {
        await flushFakeTimersUntil(
          (): boolean => blCalls === 1 && collectNodeText(container).includes("BlockedBob")
        );
      });

      returnEmptyBl = true;
      await act(async (): Promise<void> => {
        getReactPropHandler(searchInput, "onChange")?.({ currentTarget: { value: "no-match-bl" } });
      });
      await act(async (): Promise<void> => {
        getReactPropHandler(searchInput, "onKeyDown")?.({
          key: "Enter",
          preventDefault: (): void => {},
        });
      });
      await act(async (): Promise<void> => {
        await flushFakeTimersUntil(
          (): boolean =>
            blCalls >= 2 &&
            collectNodeText(container).includes(zh.identities.emptySearchHint("no-match-bl"))
        );
      });
    });
  });
});

describe("Mini App 多语言字典（zh/en/ja）、配置提示与参数提取全分支覆盖", () => {
  test("i18n/languages/{en,ja,zh} 与 i18n/configs/{en,ja,zh} 覆盖全部格式化函数与能力明细翻译分支", () => {
    const capabilityItems: readonly Readonly<MiniAppCapabilityDetailItem>[] = [
      { label: "广告检测 ad_detect", value: "gpt", sub: "on" },
      { label: "图库服务", value: "ready" },
      { label: "运行状态", value: "未就绪" },
      { label: "翻译服务", value: "google" },
      { label: "检测模型", value: "gemini", sub: "fast" },
      { label: "对话 text", value: "claude" },
      { label: "摘要 summary", value: "gpt-mini" },
      { label: "多模态 media", value: "vision" },
      { label: "生图 image", value: "imagen" },
      { label: "语音 tts", value: "speech", sub: "音色 Kore" },
      { label: "搜索 search", value: "google", sub: "限 3 次/轮" },
      { label: "贴纸包 #1", value: "doro_pack" },
      { label: "贴纸包", value: "未加载" },
      { label: "情绪池", value: "未加载" },
      { label: "happy", value: "权重 5" },
      { label: "定时任务", value: "未加载" },
      { label: "定时任务", value: "暂无配置" },
      { label: "早安播报", value: "08:00", sub: "全部受管群 · 排除 2 群" },
      { label: "定向提醒", value: "21:00", sub: "3 个指定会话" },
      { label: "其他项", value: "原样保留" },
    ];

    for (const lang of ["zh", "en", "ja"] as const) {
      const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(lang);
      for (const item of capabilityItems) {
        const translated = t.status.capabilityItem(item);
        expect(translated.label.length).toBeGreaterThan(0);
        expect(translated.value.length).toBeGreaterThan(0);
      }
      expect(t.gate.deniedNodeGatewayState(403)).toContain("403");
      expect(t.gate.deniedPolicyDetailLabel("FORBIDDEN")).toContain("FORBIDDEN");
      expect(t.gate.deniedPolicyReason("FORBIDDEN", "fallback").length).toBeGreaterThan(0);
      expect(t.gate.deniedPolicyReason("UNKNOWN_ERR", "fallback")).toContain("fallback");
      expect(t.status.updatedAtSub("12:00")).toContain("12:00");
      expect(t.status.managedChatsSub(2, 3)).toHaveLength(2);
      expect(t.status.activeSessionsSub({ gag: 1, wed: 2, verify: 3, qaSet: 4, total: 10 })).toHaveLength(4);
      expect(t.status.outboundGateSub(1, 8)).toContain("1");
      expect(t.status.capabilityItemCount(3)).toContain("3");
      expect(t.status.capabilityLabel({ key: "unknown", label: "Fallback", ready: false, detail: "", items: [] }))
        .toBe("Fallback");
      expect(t.totp.statusDescEnabled("AB••", "2026-01-01")).toContain("AB••");
      expect(t.pagination.summary(10, 1, 2)).toContain("10");
      expect(t.pagination.pageSizeOption(20)).toContain("20");
      expect(t.chats.sectionTitle(2)).toContain("2");
      expect(t.chats.chatCardMeta(-1001, 12, 3)).toContain("-1001");
      expect(t.chats.targetsModalSubtitle("群", 1, 10)).toContain("1");
      expect(t.chats.qaQuestionPlaceholder(100)).toContain("100");
      expect(t.chats.qaRenameKeepsOriginalHint("旧问题")).toContain("旧问题");
      expect(t.chats.qaAnswerPlaceholder(200)).toContain("200");
      expect(t.chats.confirmDeleteQa("q")).toContain("q");
      expect(t.chats.confirmRemoveDeleteTarget("u", 1)).toContain("u");
      expect(t.chats.confirmRemoveTranslateTarget("u", 1)).toContain("u");
      expect(t.chats.botPermGrantedTitle(3)).toContain("3");
      expect(t.chats.botPermLabel("canDeleteMessages").length).toBeGreaterThan(0);
      expect(t.chats.botPermLabel("customPerm")).toBe("customPerm");
      expect(t.chats.detailStatsLine(sampleChatDetail()).length).toBeGreaterThan(0);
      expect(t.chats.windowJoinedSub(6)).toContain("6");
      expect(t.chats.windowJoinedValue(5)).toContain("5");
      expect(t.chats.batchKickHourPill(6)).toContain("6");
      expect(t.chats.batchKickTriggerButton(6)).toContain("6");
      expect(
        t.chats.batchKickCompletedSummary({
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
          completedAt: Date.now(),
        })
      ).toContain("3");
      expect(t.chats.confirmBatchKick(6)).toContain("6");
      expect(t.messages.headerTitle("群", 5, 256)).toContain("5");
      expect(t.messages.headerMeta(-1001)).toContain("-1001");
      expect(t.messages.replyBadge("Alice", "hello")).toContain("hello");
      expect(t.messages.replyBadge("Alice", "")).toContain("Alice");
      expect(t.messages.forwardBadge("Alice")).toContain("Alice");
      expect(t.identities.duplicateToast("ID 1", "whitelist")).toContain("ID 1");
      expect(t.identities.duplicateToast("ID 2", "blocklist")).toContain("ID 2");
      expect(t.identities.emptySearchHint("abc")).toContain("abc");
      expect(t.identities.emptyListHint("whitelist").length).toBeGreaterThan(0);
      expect(t.identities.emptyListHint("blocklist").length).toBeGreaterThan(0);
      expect(t.identities.blockedAtText("2026-01-01")).toContain("2026-01-01");
      expect(t.identities.enabledPermCountText(3, 18)).toContain("3");
      expect(t.identities.confirmRemoveWhitelist("A", 1)).toContain("A");
      expect(t.identities.confirmRemoveBlocklist("B", 2)).toContain("B");
      expect(t.permissionDrawer.title("Alice")).toContain("Alice");
      expect(t.permissionDrawer.subtitle(1, false)).toContain("1");
      expect(t.permissionDrawer.subtitle(-1001, true)).toContain("-1001");
      expect(t.gallery.directoryMissingText("/tmp").length).toBeGreaterThan(0);
      expect(t.gallery.previewTitle("a.png")).toContain("a.png");
      expect(t.gallery.downloadedToast("a.png")).toContain("a.png");
      expect(t.gallery.confirmDeleteImage("x.png")).toContain("x.png");
      expect(t.gallery.deletedToast("x.png")).toContain("x.png");

      // serverNotice 的各 targetList 与 totalChats=0 分支。
      for (const targetList of ["whitelist", "blocklist", "deleteMessage", "translate"] as const) {
        expect(t.serverNotice("PICKER_IMPORT_DONE", { targetList, addedCount: 1, skippedCount: 0, duplicateCount: 0 }).length)
          .toBeGreaterThan(0);
      }
      expect(t.serverNotice("BLOCKLIST_DUPLICATE", { id: 1, totalChats: 0, persisted: true }).length).toBeGreaterThan(0);
      expect(t.serverNotice("BLOCKLIST_REMOVED", { id: 1, totalChats: 0, persisted: true }).length).toBeGreaterThan(0);
      expect(t.serverNotice("BLOCKLIST_NOT_FOUND", { id: 1, totalChats: 0, persisted: false }).length).toBeGreaterThan(0);

      // configs 翻译函数。
      expect(t.configs.missingFileHint("cron.json")).toContain("cron.json");
      expect(t.configs.syntaxErrorBadge(3, 7)).toContain("3");
      expect(t.configs.syntaxErrorDetail(3, 7, "bad token")).toContain("bad token");
      expect(t.configs.contentTooLargeError(1024)).toContain("1024");
      expect(t.configs.confirmDiscardChanges("bot.json")).toContain("bot.json");
    }

    // configs serverNotice 带与不带 errorDetail 的全部分支。
    for (const formatter of [
      formatZhConfigServerNotice,
      formatEnConfigServerNotice,
      formatJaConfigServerNotice,
    ]) {
      expect(formatter("INVALID_JSON_SYNTAX")).not.toBeNull();
      expect(formatter("INVALID_JSON_SYNTAX", { errorDetail: "line 1" })).toContain("line 1");
      expect(formatter("CONFIG_VALIDATION_FAILED")).not.toBeNull();
      expect(formatter("CONFIG_VALIDATION_FAILED", { errorDetail: "bad field" })).toContain("bad field");
      expect(formatter("SERVICE_RESTART_FAILED")).not.toBeNull();
      expect(formatter("SERVICE_RESTART_FAILED", { errorDetail: "EPERM" })).toContain("EPERM");
      expect(formatter(MINI_APP_INVALID_HANDSHAKE_CODE)).not.toBeNull();
      expect(formatter(MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE)).not.toBeNull();
      expect(formatter("UNKNOWN_CODE")).toBeNull();
    }
  });

  test("i18n/index 覆盖浏览器/Telegram 语言推断及 extractServerNoticeParams 全字段提取", () => {
    const prevNavigatorDesc: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
      globalThis,
      "navigator"
    );
    const prevTelegramDesc: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
      globalThis,
      "Telegram"
    );
    try {
      const setNav = (nav: unknown): void => {
        Object.defineProperty(globalThis, "navigator", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: nav,
        });
      };
      const setTg = (tg: unknown): void => {
        Object.defineProperty(globalThis, "Telegram", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: tg,
        });
      };

      setNav({ languages: ["fr-FR", "zh-TW"], language: "en-US" });
      expect(detectBrowserDefaultLanguage()).toBe("zh");
      setNav({ languages: ["de-DE", "ja-JP"], language: "zh-CN" });
      expect(detectBrowserDefaultLanguage()).toBe("ja");
      setNav({ languages: ["es-ES", "en-GB"], language: "zh-CN" });
      expect(detectBrowserDefaultLanguage()).toBe("en");
      setNav({ languages: ["fr-FR"], language: "ja-JP" });
      expect(detectBrowserDefaultLanguage()).toBe("ja");

      setTg({ WebApp: { initDataUnsafe: { user: { language_code: "ja" } } } });
      expect(detectInitialMiniAppLanguage()).toBe("ja");
      setTg({ WebApp: { initDataUnsafe: { user: { language_code: "en-US" } } } });
      expect(detectInitialMiniAppLanguage()).toBe("en");
      setTg({ WebApp: { initDataUnsafe: { user: { language_code: "fr" } } } });
      expect(detectInitialMiniAppLanguage()).toBe("zh");
      setTg({ WebApp: { initDataUnsafe: { user: { language_code: "   " } } } });
      expect(detectInitialMiniAppLanguage()).toBe("ja");

      // extractServerNoticeParams：全字段与 skippedIds / duplicateIds 回退提取。
      expect(extractServerNoticeParams({})).toBeUndefined();
      expect(
        extractServerNoticeParams(
          new Error("boom", {
            cause: {
              currentMood: "calm",
              feature: "aiChat",
              configFile: "bot.json",
              key: "isCanMute",
              value: true,
              skippedIds: ["bad", 10, 20],
              duplicateIds: [10],
              addedIds: [30, 31],
              error: "fallback detail",
            },
          })
        )
      ).toMatchObject({
        mood: "calm",
        feature: "aiChat",
        configFile: "bot.json",
        id: 20,
        key: "isCanMute",
        value: true,
        addedCount: 2,
        skippedCount: 3,
        duplicateCount: 1,
        errorDetail: "fallback detail",
      });
      // skippedIds 全在 duplicateIds 中时回退到首个数字 ID；缺 duplicateIds 时直接返回首个数字 ID。
      expect(extractServerNoticeParams({ skippedIds: [42], duplicateIds: [42] })?.id).toBe(42);
      expect(extractServerNoticeParams({ skippedIds: [99] })?.id).toBe(99);
    } finally {
      if (prevNavigatorDesc !== undefined) {
        Object.defineProperty(globalThis, "navigator", prevNavigatorDesc);
      } else {
        Reflect.deleteProperty(globalThis, "navigator");
      }
      if (prevTelegramDesc !== undefined) {
        Object.defineProperty(globalThis, "Telegram", prevTelegramDesc);
      } else {
        Reflect.deleteProperty(globalThis, "Telegram");
      }
    }
  });
});
