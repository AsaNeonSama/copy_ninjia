/**
 * Mini App 「内容黑名单」页面（贴纸包 / 自定义表情包子页签、统一分页档位、防抖搜索、默认收起的折叠添加输入框、
 * 前端正则预校验添加、非 2xx 结构化业务错误处理、Telegram 外链展示、ConfirmModal 二次确认移除与三语文案）测试。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  fetchMiniAppAdBlacklists,
  mutateMiniAppAdBlacklist,
} from "../../packages/mini-app-frontend/api/adBlacklists";
import { AppShell } from "../../packages/mini-app-frontend/components/AppShell";
import { ConfirmModal } from "../../packages/mini-app-frontend/components/ConfirmModal";
import {
  MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE,
  MINI_APP_AD_BLACKLIST_KINDS,
  MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE,
  MINI_APP_AD_BLACKLIST_MUTATION_CODES,
  MINI_APP_AD_BLACKLIST_PAGE_SIZE_OPTIONS,
  MINI_APP_AD_BLACKLIST_QUERY_MAX_LENGTH,
  MINI_APP_CONFIRM_CLOSE_ANIMATION_MS,
  MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
  MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS,
  MINI_APP_LANGUAGES,
  MINI_APP_MIN_LOADING_MS,
  MINI_APP_SEARCH_DEBOUNCE_MS,
  MINI_APP_TAB_KEYS,
} from "../../packages/mini-app-frontend/consts/miniApp";
import {
  extractServerNoticeParams,
  getMiniAppTranslations,
} from "../../packages/mini-app-frontend/i18n";
import { formatEnAdBlacklistServerNotice } from "../../packages/mini-app-frontend/i18n/adBlacklists/en";
import { formatJaAdBlacklistServerNotice } from "../../packages/mini-app-frontend/i18n/adBlacklists/ja";
import { formatZhAdBlacklistServerNotice } from "../../packages/mini-app-frontend/i18n/adBlacklists/zh";
import { clearMiniAppSessionToken } from "../../packages/mini-app-frontend/libs/credentials";
import {
  AdBlacklistsPage,
  buildAdBlacklistPackUrl,
} from "../../packages/mini-app-frontend/pages/AdBlacklistsPage";
import { AdBlacklistsSvgIcon, TabSvgIcon } from "../../packages/mini-app-frontend/resource";
import {
  createAdBlacklistsStore,
} from "../../packages/mini-app-frontend/store/adBlacklists";
import type { MiniAppAdBlacklistsStore } from "../../packages/mini-app-frontend/store/adBlacklists";
import {
  resetMiniAppStoreForTest,
  useMiniAppStore,
} from "../../packages/mini-app-frontend/store/app";
import type {
  MiniAppAdBlacklistKind,
  MiniAppAdBlacklistMutationRequest,
  MiniAppAdBlacklistMutationResponse,
  MiniAppAdBlacklistsResponse,
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
import {
  seedTestMiniAppSession,
  TEST_SESSION_KEY,
  wrapEncryptedTestFetch,
} from "./helpers/encryptedFetchMock";

type RouteHandler = (
  url: URL,
  decryptedInit: RequestInit | undefined,
  rawInit: RequestInit | undefined
) => Response | Promise<Response>;

const routes: Map<string, RouteHandler> = new Map<string, RouteHandler>();
const fetchLog: string[] = [];
const originalFetch: typeof fetch = globalThis.fetch;
const zh: Readonly<MiniAppTranslations> = getMiniAppTranslations("zh");

function route(key: string, handler: RouteHandler): void {
  routes.set(key, handler);
}

function jsonRes(payload: unknown, status: number = 200): Response {
  return Response.json(payload, { status });
}

function mockListRes(
  packs: readonly string[],
  overrides: Partial<MiniAppAdBlacklistsResponse> = {}
): Response {
  return jsonRes({
    kind: "sticker",
    items: packs.map((pack: string): { readonly pack: string } => ({ pack })),
    page: 1,
    pageSize: MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE,
    total: packs.length,
    totalPages: 1,
    stickerTotal: packs.length,
    emojiTotal: 0,
    query: "",
    ...overrides,
  } satisfies MiniAppAdBlacklistsResponse);
}

function findByClass(root: MiniDomNode, className: string): MiniDomNode {
  return findElements(root, (node): boolean => hasClass(node, className))[0]!;
}

function submitAdd(input: MiniDomNode, form: MiniDomNode, value: string): void {
  act((): void => {
    getReactPropHandler(input, "onChange")?.({ currentTarget: { value } });
  });
  act((): void => {
    getReactPropHandler(form, "onSubmit")?.({ preventDefault: (): void => {} });
  });
}

function mockMutationRes(
  body: Readonly<MiniAppAdBlacklistMutationRequest>,
  code: MiniAppAdBlacklistMutationResponse["code"],
  options: Partial<MiniAppAdBlacklistMutationResponse> & { readonly status?: number } = {}
): Response {
  const { status = 200, ...overrides } = options;
  return jsonRes(
    {
      ok: status >= 200 && status < 300,
      kind: body.kind,
      pack: body.pack,
      enabled: body.enabled,
      changed: false,
      code,
      message: code,
      ...overrides,
    } satisfies MiniAppAdBlacklistMutationResponse,
    status
  );
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

async function flushIo(): Promise<void> {
  for (let i: number = 0; i < 8; i += 1) {
    Bun.sleepSync(2);
    await new Promise<void>((resolve: () => void): void => {
      setImmediate(resolve);
    });
  }
}

async function withMountedAdBlacklistsPage(
  store: MiniAppAdBlacklistsStore,
  run: (
    container: MiniDomNode,
    settle: (extraMs?: number) => Promise<void>
  ) => Promise<void>
): Promise<void> {
  jest.useFakeTimers();
  const environment: MiniDomEnvironment = installMiniDom();
  try {
    const container: MiniDomNode = environment.document.createElement("div");
    const root: Root = createRoot(container as unknown as Element);

    const settle = async (extraMs: number = 0): Promise<void> => {
      await act(async (): Promise<void> => {
        await flushIo();
        jest.advanceTimersByTime(
          Math.max(
            MINI_APP_MIN_LOADING_MS,
            MINI_APP_CONFIRM_CLOSE_ANIMATION_MS,
            extraMs
          ) + 20
        );
        await flushIo();
      });
    };

    try {
      await act(async (): Promise<void> => {
        root.render(
          createElement(
            Fragment,
            null,
            createElement(AdBlacklistsPage, {
              storeFactory: (): MiniAppAdBlacklistsStore => store,
            }),
            createElement(ConfirmModal)
          )
        );
      });
      await run(container, settle);
    } finally {
      await act(async (): Promise<void> => {
        root.unmount();
      });
    }
  } finally {
    jest.useRealTimers();
    environment.restore();
  }
}

beforeEach((): void => {
  routes.clear();
  fetchLog.length = 0;
  (globalThis as { Telegram?: unknown }).Telegram = {
    WebApp: { initData: "signed-superadmin-initdata" },
  };
  seedTestMiniAppSession("e".repeat(64), Date.now() + 600_000, TEST_SESSION_KEY);
  globalThis.fetch = wrapEncryptedTestFetch(
    (
      url: URL,
      decryptedInit: RequestInit | undefined,
      rawInit: RequestInit | undefined
    ): Response | Promise<Response> => {
      const method: string = (rawInit?.method ?? "GET").toUpperCase();
      const key: string = `${method} ${url.pathname}`;
      fetchLog.push(`${key}${url.search}`);
      const handler: RouteHandler | undefined = routes.get(key);
      if (handler === undefined) {
        return jsonRes({ error: `Unhandled ${key}` }, 404);
      }
      return handler(url, decryptedInit, rawInit);
    }
  );
  resetMiniAppStoreForTest();
  useMiniAppStore.getState().setLanguage("zh");
});

afterEach((): void => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis, "Telegram");
  resetMiniAppStoreForTest();
  clearMiniAppSessionToken();
});

describe("内容黑名单导航顺序、外链生成与 API 客户端", () => {
  test("侧边栏将 adBlacklists 置于 identities 与 configs 之间，分页常量与全站同步，AppShell 仅在菜单显示禁止图标", () => {
    const identitiesIdx: number = MINI_APP_TAB_KEYS.indexOf("identities");
    const adBlacklistsIdx: number = MINI_APP_TAB_KEYS.indexOf("adBlacklists");
    const configsIdx: number = MINI_APP_TAB_KEYS.indexOf("configs");
    expect(adBlacklistsIdx).toBe(identitiesIdx + 1);
    expect(configsIdx).toBe(adBlacklistsIdx + 1);
    expect(MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE).toBe(MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE);
    expect(MINI_APP_AD_BLACKLIST_PAGE_SIZE_OPTIONS).toEqual(MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS);
    expect(MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE).toBe(Math.max(...MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS));
    expect(zh.tabs.adBlacklists).toBe("内容黑名单");
    expect(zh.adBlacklists.searchPlaceholder).toBe("快说，杂鱼");
    expect(zh.adBlacklists.addInputPlaceholder).toBe("写清楚，杂鱼");

    useMiniAppStore.setState({
      sidebarOpen: true,
      activeTab: "adBlacklists",
      sessionExpiresAt: Date.now() + 60_000,
    });
    const html: string = renderToStaticMarkup(createElement(AppShell));
    expect(html).toContain(`<h1 class="topbar-title">${zh.tabs.adBlacklists}</h1>`);
    expect(html).toContain(zh.tabDescriptions.adBlacklists);
    expect(html).toContain(zh.adBlacklists.stickerTab);
    expect(html).toContain(zh.adBlacklists.emojiTab);
    expect(html).toContain(zh.adBlacklists.addFoldButton);
    expect(html).not.toContain("app-shell-configs");
    expect(html).not.toContain("ad-blacklist-controls-head");
    expect(html).not.toContain("ad-blacklist-count-badge");
    expect(html).not.toContain("ad-blacklist-tab-count");
    const pageHtml: string = renderToStaticMarkup(createElement(AdBlacklistsPage));
    expect(pageHtml).not.toContain('x1="5.64" y1="5.64" x2="18.36" y2="18.36"');
    expect(renderToStaticMarkup(createElement(AdBlacklistsSvgIcon))).toContain("<svg");
    expect(renderToStaticMarkup(createElement(TabSvgIcon, { tabKey: "adBlacklists" }))).toContain("<svg");

    expect(buildAdBlacklistPackUrl("sticker", "spam_pack_01")).toBe(
      "https://t.me/addstickers/spam_pack_01"
    );
    expect(buildAdBlacklistPackUrl("emoji", "ad_emoji_99")).toBe(
      "https://t.me/addemoji/ad_emoji_99"
    );
  });

  test("fetchMiniAppAdBlacklists 裁剪并编码查询参数，mutateMiniAppAdBlacklist 归一化非 2xx 业务错误且放行鉴权错误", async () => {
    let seenUrl: URL | null = null;
    route("GET /api/ad-blacklists", (url: URL): Response => {
      seenUrl = url;
      const response: MiniAppAdBlacklistsResponse = {
        kind: (url.searchParams.get("kind") as MiniAppAdBlacklistKind | null) ?? "sticker",
        items: [{ pack: "spam_a" }],
        page: Number(url.searchParams.get("page") ?? "1"),
        pageSize: Number(
          url.searchParams.get("pageSize") ??
            String(MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE)
        ),
        total: 1,
        totalPages: 1,
        stickerTotal: 1,
        emojiTotal: 0,
        query: url.searchParams.get("query") ?? "",
      };
      return jsonRes(response);
    });

    const overlongQuery: string = `  ${"a".repeat(MINI_APP_AD_BLACKLIST_QUERY_MAX_LENGTH + 20)}  `;
    const listResult: MiniAppAdBlacklistsResponse = await fetchMiniAppAdBlacklists({
      kind: "emoji",
      page: 2,
      pageSize: MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE,
      query: overlongQuery,
    });
    expect(listResult.kind).toBe("emoji");
    expect(seenUrl!.searchParams.get("kind")).toBe("emoji");
    expect(seenUrl!.searchParams.get("page")).toBe("2");
    expect(seenUrl!.searchParams.get("pageSize")).toBe(
      String(MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE)
    );
    expect(seenUrl!.searchParams.get("query")).toBe("a".repeat(MINI_APP_AD_BLACKLIST_QUERY_MAX_LENGTH));

    await fetchMiniAppAdBlacklists({
      kind: "sticker",
      page: 1,
      pageSize: MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE,
      query: "   ",
    });
    expect(seenUrl!.searchParams.has("query")).toBeFalse();

    // 非 2xx 结构化业务错误响应（含省略部分字段的 400 与 409/503）应被归一化返回。
    route("POST /api/ad-blacklists", (): Response =>
      jsonRes(
        {
          ok: false,
          code: "AD_BLACKLIST_BOT_OWN_PACK",
          message: "AD_BLACKLIST_BOT_OWN_PACK",
        },
        409
      )
    );
    const botOwnResult: MiniAppAdBlacklistMutationResponse =
      await mutateMiniAppAdBlacklist({
        kind: "sticker",
        pack: "my_bot_pack",
        enabled: true,
      });
    expect(botOwnResult).toEqual({
      ok: false,
      kind: "sticker",
      pack: "my_bot_pack",
      enabled: true,
      changed: false,
      code: "AD_BLACKLIST_BOT_OWN_PACK",
      message: "AD_BLACKLIST_BOT_OWN_PACK",
    });

    route("POST /api/ad-blacklists", (): Response =>
      jsonRes(
        {
          ok: false,
          kind: "emoji",
          pack: "cap_pack",
          enabled: true,
          changed: false,
          persisted: false,
          code: "AD_BLACKLIST_STORAGE_UNAVAILABLE",
          error: "AD_BLACKLIST_STORAGE_UNAVAILABLE",
        },
        503
      )
    );
    const unavailableResult: MiniAppAdBlacklistMutationResponse =
      await mutateMiniAppAdBlacklist({
        kind: "emoji",
        pack: "cap_pack",
        enabled: true,
      });
    expect(unavailableResult.ok).toBeFalse();
    expect(unavailableResult.code).toBe("AD_BLACKLIST_STORAGE_UNAVAILABLE");
    expect(unavailableResult.persisted).toBeFalse();

    // 鉴权/锁定错误与非结构化 500 必须继续向上抛出。
    route("POST /api/ad-blacklists", (): Response =>
      jsonRes({ ok: false, code: "PASSWORD_REQUIRED", error: "expired" }, 401)
    );
    await expect(
      mutateMiniAppAdBlacklist({ kind: "sticker", pack: "x_pack", enabled: true })
    ).rejects.toThrow("PASSWORD_REQUIRED");

    seedTestMiniAppSession("f".repeat(64), Date.now() + 600_000, TEST_SESSION_KEY);
    route("POST /api/ad-blacklists", (): Response =>
      jsonRes({ ok: false, error: "internal boom" }, 500)
    );
    await expect(
      mutateMiniAppAdBlacklist({ kind: "sticker", pack: "x_pack", enabled: true })
    ).rejects.toThrow("internal boom");
  });
});

describe("AdBlacklistsPage 挂载交互、防抖搜索、校验添加、确认移除与分页", () => {
  test("覆盖双子页切换、外链地址、折叠添加表单、防抖搜索、正则预校验、判重/业务错误、ConfirmModal 移除与页码夹紧", async () => {
    const stickerPacks: string[] = ["ad_pack_alpha", "ad_pack_beta"];
    const emojiPacks: string[] = ["ad_emoji_one"];
    const mutationRequests: MiniAppAdBlacklistMutationRequest[] = [];
    let getCallCount: number = 0;

    route("GET /api/ad-blacklists", (url: URL): Response => {
      getCallCount += 1;
      const kind: MiniAppAdBlacklistKind =
        url.searchParams.get("kind") === "emoji" ? "emoji" : "sticker";
      const query: string = (url.searchParams.get("query") ?? "").trim();
      const rawPage: number = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
      const pageSize: number = Math.max(
        1,
        Number(url.searchParams.get("pageSize") ?? String(MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE))
      );
      const source: readonly string[] = kind === "sticker" ? stickerPacks : emojiPacks;
      const filtered: readonly string[] =
        query.length > 0
          ? source.filter((p: string): boolean => p.toLowerCase().includes(query.toLowerCase()))
          : source;
      const totalPages: number = Math.max(1, Math.ceil(filtered.length / pageSize));
      const clampedPage: number = Math.min(rawPage, totalPages);
      const start: number = (clampedPage - 1) * pageSize;
      const items: readonly { readonly pack: string }[] = filtered
        .slice(start, start + pageSize)
        .map((pack: string): { readonly pack: string } => ({ pack }));
      return jsonRes({
        kind,
        items,
        page: clampedPage,
        pageSize,
        total: filtered.length,
        totalPages,
        stickerTotal: stickerPacks.length,
        emojiTotal: emojiPacks.length,
        query,
      } satisfies MiniAppAdBlacklistsResponse);
    });

    route(
      "POST /api/ad-blacklists",
      (_url: URL, decryptedInit: RequestInit | undefined): Response => {
        const body: MiniAppAdBlacklistMutationRequest = JSON.parse(
          String(decryptedInit?.body ?? "{}")
        ) as MiniAppAdBlacklistMutationRequest;
        mutationRequests.push(body);
        const list: string[] = body.kind === "sticker" ? stickerPacks : emojiPacks;
        if (body.enabled) {
          if (body.pack === "bot_own_pack") {
            return mockMutationRes(body, "AD_BLACKLIST_BOT_OWN_PACK", { status: 409 });
          }
          if (list.includes(body.pack)) {
            return mockMutationRes(body, "AD_BLACKLIST_DUPLICATE", { duplicate: true });
          }
          list.push(body.pack);
          return mockMutationRes(body, "AD_BLACKLIST_ADDED", { changed: true, persisted: true });
        }
        const idx: number = list.indexOf(body.pack);
        if (idx >= 0) {
          list.splice(idx, 1);
          return mockMutationRes(body, "AD_BLACKLIST_REMOVED", { changed: true, persisted: true });
        }
        return mockMutationRes(body, "AD_BLACKLIST_NOT_FOUND");
      }
    );

    const store: MiniAppAdBlacklistsStore = createAdBlacklistsStore();
    await withMountedAdBlacklistsPage(store, async (container, settle): Promise<void> => {
      // 首屏先渲染默认每页 10 行骨架，稳定后展示贴纸包列表、底部分页统计与页内预览按钮。
      expect(findElements(container, (node): boolean => hasClass(node, "skeleton-card"))).toHaveLength(
        MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE
      );
      await settle();

      expect(collectNodeText(container)).toContain("ad_pack_alpha");
      expect(collectNodeText(container)).toContain("ad_pack_beta");
      expect(collectNodeText(container)).toContain(zh.pagination.summary(2, 1, 1));
      expect(findElements(container, (node): boolean => hasClass(node, "ad-blacklist-controls-head"))).toHaveLength(0);
      expect(findElements(container, (node): boolean => hasClass(node, "ad-blacklist-tab-count"))).toHaveLength(0);

      const stickerButtons: MiniDomNode[] = findElements(
        container,
        (node): boolean => node.tagName === "BUTTON" && hasClass(node, "ad-blacklist-pack-link")
      );
      expect(stickerButtons).toHaveLength(2);
      expect(findElements(container, (node): boolean => node.tagName === "A")).toHaveLength(0);
      expect(collectNodeText(container)).toContain("https://t.me/addstickers/ad_pack_alpha");

      // 0. 核验搜索与添加输入框 placeholder 及添加面板默认收起、点击上拉/下拉展开收起与快照保留行为。
      const searchInputNode: MiniDomNode = findByClass(container, "search-input");
      const addFoldTrigger: MiniDomNode = findByClass(container, "add-fold-trigger");
      const addFoldGrid: MiniDomNode = findByClass(container, "add-fold-collapse-grid");
      const addFoldChevron: MiniDomNode = findByClass(addFoldTrigger, "chevron-icon");
      const addInput: MiniDomNode = findByClass(container, "ad-blacklist-add-input");
      const addSubmitBtn: MiniDomNode = findByClass(container, "ad-blacklist-add-btn");
      const addForm: MiniDomNode = findByClass(container, "ad-blacklist-add-row");

      expect(searchInputNode.getAttribute("placeholder")).toBe(zh.adBlacklists.searchPlaceholder);
      expect(addInput.getAttribute("placeholder")).toBe(zh.adBlacklists.addInputPlaceholder);
      expect(store.getState().addFormOpen).toBeFalse();
      expect(hasClass(addFoldTrigger, "open")).toBeFalse();
      expect(addFoldTrigger.getAttribute("aria-expanded")).toBe("false");
      expect(hasClass(addFoldChevron, "rotated")).toBeFalse();
      expect(hasClass(addFoldGrid, "expanded")).toBeFalse();
      expect(addFoldGrid.getAttribute("aria-hidden")).toBe("true");
      expect(addInput.getAttribute("tabindex")).toBe("-1");
      expect(addSubmitBtn.getAttribute("tabindex")).toBe("-1");

      act((): void => { addFoldTrigger.triggerClick(); });
      expect(store.getState().addFormOpen).toBeTrue();
      expect(hasClass(addFoldTrigger, "open")).toBeTrue();
      expect(addFoldTrigger.getAttribute("aria-expanded")).toBe("true");
      expect(hasClass(addFoldChevron, "rotated")).toBeTrue();
      expect(hasClass(addFoldGrid, "expanded")).toBeTrue();
      expect(addFoldGrid.getAttribute("aria-hidden")).toBe("false");
      expect(addInput.getAttribute("tabindex")).toBe("0");
      expect(addSubmitBtn.getAttribute("tabindex")).toBe("0");

      // 收起时 useClosingSnapshot 保留展开态草稿值，避免收起飞行期输入瞬间清空闪烁。
      act((): void => {
        getReactPropHandler(addInput, "onChange")?.({ currentTarget: { value: "draft_pack" } });
      });
      expect(addInput.value).toBe("draft_pack");
      act((): void => { addFoldTrigger.triggerClick(); });
      expect(store.getState().addFormOpen).toBeFalse();
      expect(hasClass(addFoldGrid, "expanded")).toBeFalse();
      expect(addFoldGrid.getAttribute("aria-hidden")).toBe("true");
      expect(addInput.value).toBe("draft_pack");
      act((): void => { store.getState().setAddPackInput(""); });
      expect(addInput.value).toBe("draft_pack");

      // 重新展开后同步为最新草稿值，进行后续校验与添加流程。
      act((): void => { addFoldTrigger.triggerClick(); });
      expect(store.getState().addFormOpen).toBeTrue();
      expect(addInput.value).toBe("");

      // 1. 前端预校验拦截非法包名或非贴纸/表情包链接（不发网络请求），保持面板展开，并展开错误横幅可手动关闭。
      submitAdd(addInput, addForm, "https://t.me/not_a_pack/bad_link");
      expect(mutationRequests).toHaveLength(0);
      expect(store.getState().addFormOpen).toBeTrue();
      expect(store.getState().noticeBanner?.kind).toBe("error");
      expect(collectNodeText(container)).toContain(zh.adBlacklists.invalidPackNotice);

      const dismissBtn: MiniDomNode | undefined = findElements(
        container,
        (node): boolean =>
          node.tagName === "BUTTON" &&
          node.getAttribute("aria-label") === zh.adBlacklists.dismissNoticeAria
      )[0];
      expect(dismissBtn).toBeDefined();
      act((): void => {
        dismissBtn?.triggerClick();
      });
      expect(store.getState().noticeBanner).toBeNull();

      // 2. 添加重复包名：触发 duplicate 横幅与 warning Toast，保持面板展开。
      submitAdd(addInput, addForm, "ad_pack_alpha");
      await settle();
      expect(store.getState().addFormOpen).toBeTrue();
      expect(store.getState().noticeBanner?.kind).toBe("duplicate");
      expect(collectNodeText(container)).toContain(zh.adBlacklists.duplicateBannerTitle);

      // 3. 添加 Bot 自身贴纸包：409 非 2xx 业务错误展示错误横幅、保留输入并保持面板展开。
      submitAdd(addInput, addForm, "bot_own_pack");
      await settle();
      expect(store.getState().addFormOpen).toBeTrue();
      expect(store.getState().noticeBanner?.kind).toBe("error");
      expect(store.getState().addPackInput).toBe("bot_own_pack");
      expect(collectNodeText(container)).toContain("bot_own_pack");

      // 4. 添加合法新包后清空输入、收起折叠添加面板并刷新底部分页总数。
      submitAdd(addInput, addForm, "  ad_pack_gamma  ");
      await settle();
      expect(store.getState().addPackInput).toBe("");
      expect(store.getState().addFormOpen).toBeFalse();
      expect(hasClass(addFoldGrid, "expanded")).toBeFalse();
      expect(store.getState().noticeBanner).toBeNull();
      expect(store.getState().stickerTotal).toBe(3);
      expect(collectNodeText(container)).toContain("ad_pack_gamma");
      expect(collectNodeText(container)).toContain(zh.pagination.summary(3, 1, 1));

      // 5. 防抖搜索与清空搜索（验证 MINI_APP_SEARCH_DEBOUNCE_MS 与空搜索文案）。
      const callsBeforeSearch: number = getCallCount;
      act((): void => {
        getReactPropHandler(searchInputNode, "onChange")?.({
          currentTarget: { value: "no_such_pack" },
        });
      });
      act((): void => { jest.advanceTimersByTime(MINI_APP_SEARCH_DEBOUNCE_MS - 50); });
      expect(getCallCount).toBe(callsBeforeSearch);
      act((): void => { jest.advanceTimersByTime(60); });
      await settle();
      expect(store.getState().debouncedQuery).toBe("no_such_pack");
      expect(collectNodeText(container)).toContain(zh.adBlacklists.emptySearchHint("no_such_pack"));

      act((): void => { findByClass(container, "search-clear-btn").triggerClick(); });
      await settle();
      expect(store.getState().debouncedQuery).toBe("");
      expect(collectNodeText(container)).toContain("ad_pack_alpha");

      // 6. 移除条目触发 ConfirmModal：先取消确认不发请求，再确认移除成功刷新。
      const removeBtns: MiniDomNode[] = findElements(
        container,
        (node): boolean => hasClass(node, "ad-blacklist-remove-btn")
      );
      expect(removeBtns.length).toBeGreaterThan(0);
      const mutCountBeforeCancel: number = mutationRequests.length;
      act((): void => { removeBtns[0]!.triggerClick(); });
      expect(useMiniAppStore.getState().confirmModal?.message).toBe(
        zh.adBlacklists.confirmRemovePack("sticker", "ad_pack_alpha")
      );
      act((): void => {
        findButtonByText(container, zh.confirmDialog.cancelButton)?.triggerClick();
      });
      await settle();
      expect(mutationRequests).toHaveLength(mutCountBeforeCancel);

      act((): void => { findByClass(container, "ad-blacklist-remove-btn").triggerClick(); });
      act((): void => {
        findButtonByText(container, zh.confirmDialog.confirmButton)?.triggerClick();
      });
      await settle();
      expect(store.getState().stickerTotal).toBe(2);
      expect(collectNodeText(container)).not.toContain("ad_pack_alpha");

      // 7. 切换到 emoji 子页签：清除横幅、拉取 emoji 列表、渲染页内预览按钮与 addemoji 地址文本、移除唯一条目展示空列表提示。
      act((): void => {
        findButtonByText(container, zh.adBlacklists.emojiTab)?.triggerClick();
      });
      await settle();
      expect(store.getState().kind).toBe("emoji");
      expect(store.getState().noticeBanner).toBeNull();
      const emojiButtons: MiniDomNode[] = findElements(
        container,
        (node): boolean => node.tagName === "BUTTON" && hasClass(node, "ad-blacklist-pack-link")
      );
      expect(emojiButtons).toHaveLength(1);
      expect(findElements(container, (node): boolean => node.tagName === "A")).toHaveLength(0);
      expect(collectNodeText(container)).toContain("https://t.me/addemoji/ad_emoji_one");

      act((): void => { findByClass(container, "ad-blacklist-remove-btn").triggerClick(); });
      act((): void => {
        findButtonByText(container, zh.confirmDialog.confirmButton)?.triggerClick();
      });
      await settle();
      expect(store.getState().emojiTotal).toBe(0);
      expect(collectNodeText(container)).toContain(zh.adBlacklists.emptyListHint("emoji"));

      // 8. 切换每页条数与刷新按钮。
      const callsBeforeSizeChange: number = getCallCount;
      act((): void => {
        findButtonByText(
          container,
          zh.pagination.pageSizeOption(MINI_APP_AD_BLACKLIST_PAGE_SIZE_OPTIONS[2]!)
        )?.triggerClick();
      });
      await settle();
      expect(store.getState().emojiPageSize).toBe(
        MINI_APP_AD_BLACKLIST_PAGE_SIZE_OPTIONS[2]!
      );
      expect(getCallCount).toBe(callsBeforeSizeChange + 1);

      const callsBeforeRefresh: number = getCallCount;
      act((): void => {
        findButtonByText(container, zh.adBlacklists.refreshButton)?.triggerClick();
      });
      await settle();
      expect(getCallCount).toBe(callsBeforeRefresh + 1);
    });
  });

  test("store 覆盖服务端页码夹紧去重、乱序响应丢弃与鉴权失效重定向", async () => {
    let listCalls: number = 0;
    route("GET /api/ad-blacklists", (): Response => {
      listCalls += 1;
      return mockListRes(["only_pack"]);
    });

    const store: MiniAppAdBlacklistsStore = createAdBlacklistsStore();
    store.getState().setPageNumber(3);
    await store.getState().loadCurrentList(true);
    expect(store.getState().stickerPageNumber).toBe(1);
    expect(listCalls).toBe(1);

    // 服务端夹紧页码后的紧随一次重复拉取被跳过，避免双请求。
    await store.getState().loadCurrentList(true);
    expect(listCalls).toBe(1);

    // 乱序请求：先发起的慢请求携带 401，被新请求覆盖时仍触发门禁锁定。
    useMiniAppStore.setState({ gateState: "unlocked" });
    const staleGate: PromiseWithResolvers<Response> = Promise.withResolvers<Response>();
    let seq: number = 0;
    route("GET /api/ad-blacklists", (): Response | Promise<Response> => {
      seq += 1;
      return seq === 1 ? staleGate.promise : mockListRes(["fresh_pack"]);
    });

    const stalePromise: Promise<void> = store.getState().loadCurrentList(true);
    const freshPromise: Promise<void> = store.getState().loadCurrentList(true);
    await freshPromise;
    expect(store.getState().stickerPage?.items[0]?.pack).toBe("fresh_pack");
    staleGate.resolve(jsonRes({ code: "PASSWORD_REQUIRED", error: "expired" }, 401));
    await stalePromise;
    expect(useMiniAppStore.getState().gateState).toBe("password");
  });

  test("503 部分提交（changed: true, persisted: false）在新增与移除时均刷新列表、清空新增输入并展示部分提交告警", async () => {
    const stickerPacks: string[] = ["existing_pack"];
    let getCalls: number = 0;
    route("GET /api/ad-blacklists", (): Response => {
      getCalls += 1;
      return mockListRes(stickerPacks);
    });
    route(
      "POST /api/ad-blacklists",
      (_url: URL, decryptedInit: RequestInit | undefined): Response => {
        const body: MiniAppAdBlacklistMutationRequest = JSON.parse(
          String(decryptedInit?.body ?? "{}")
        ) as MiniAppAdBlacklistMutationRequest;
        if (body.enabled) {
          stickerPacks.push(body.pack);
        } else {
          const idx: number = stickerPacks.indexOf(body.pack);
          if (idx >= 0) stickerPacks.splice(idx, 1);
        }
        return mockMutationRes(body, "AD_BLACKLIST_STORAGE_UNAVAILABLE", {
          changed: true,
          persisted: false,
          status: 503,
        });
      }
    );

    const store: MiniAppAdBlacklistsStore = createAdBlacklistsStore();
    await store.getState().loadCurrentList(true);
    expect(getCalls).toBe(1);

    // 1. 新增命中 503 部分提交：列表已刷新、输入框清空、横幅与 danger Toast 均为部分提交告警。
    store.getState().setAddPackInput("partial_add_pack");
    await store.getState().addPack();
    const expectedAddWarning: string = zh.serverNotice(
      "AD_BLACKLIST_STORAGE_UNAVAILABLE",
      { kind: "sticker", pack: "partial_add_pack", changed: true, persisted: false }
    );
    expect(getCalls).toBe(2);
    expect(store.getState().addPackInput).toBe("");
    expect(store.getState().stickerTotal).toBe(2);
    expect(store.getState().stickerPage?.items.map((item): string => item.pack)).toContain(
      "partial_add_pack"
    );
    expect(store.getState().noticeBanner).toEqual({ kind: "error", message: expectedAddWarning });
    expect(useMiniAppStore.getState().toastTone).toBe("danger");
    expect(useMiniAppStore.getState().toastText).toBe(expectedAddWarning);

    // 2. 移除命中 503 部分提交：确认后列表同样刷新，横幅与 danger Toast 展示部分提交告警。
    const removePromise: Promise<void> = store.getState().removePack("partial_add_pack");
    useMiniAppStore.getState().resolveConfirm(true);
    await removePromise;
    expect(getCalls).toBe(3);
    expect(store.getState().stickerTotal).toBe(1);
    expect(store.getState().stickerPage?.items.map((item): string => item.pack)).not.toContain(
      "partial_add_pack"
    );
    expect(store.getState().noticeBanner).toEqual({ kind: "error", message: expectedAddWarning });
    expect(useMiniAppStore.getState().toastTone).toBe("danger");
    expect(useMiniAppStore.getState().toastText).toBe(expectedAddWarning);
  });

  test("并发竞态保护：确认弹窗期间启动的写操作阻止 removePack 重叠提交，busyAction 禁用双子页签且切签不串扰横幅/输入", async () => {
    const postBodies: MiniAppAdBlacklistMutationRequest[] = [];
    let pendingPostGate: PromiseWithResolvers<Response> | null = null;
    route("GET /api/ad-blacklists", (url: URL): Response => {
      const kind: MiniAppAdBlacklistKind =
        url.searchParams.get("kind") === "emoji" ? "emoji" : "sticker";
      return mockListRes(kind === "sticker" ? ["race_pack_a"] : [], {
        kind,
        stickerTotal: 1,
        emojiTotal: 0,
      });
    });
    route(
      "POST /api/ad-blacklists",
      (_url: URL, decryptedInit: RequestInit | undefined): Response | Promise<Response> => {
        const body: MiniAppAdBlacklistMutationRequest = JSON.parse(
          String(decryptedInit?.body ?? "{}")
        ) as MiniAppAdBlacklistMutationRequest;
        postBodies.push(body);
        if (pendingPostGate !== null) {
          return pendingPostGate.promise;
        }
        return mockMutationRes(
          body,
          body.enabled ? "AD_BLACKLIST_ADDED" : "AD_BLACKLIST_REMOVED",
          { changed: true, persisted: true }
        );
      }
    );

    // 1. 确认弹窗窗口内启动另一个 addPack：resolveConfirm(true) 后 removePack 复检 busyAction 并直接放弃。
    const store: MiniAppAdBlacklistsStore = createAdBlacklistsStore();
    await store.getState().loadCurrentList(true);
    const removePromise: Promise<void> = store.getState().removePack("race_pack_a");
    expect(useMiniAppStore.getState().confirmModal).not.toBeNull();

    pendingPostGate = Promise.withResolvers<Response>();
    store.getState().setAddPackInput("concurrent_pack");
    const addPromise: Promise<void> = store.getState().addPack();
    expect(store.getState().busyAction).toBeTrue();

    useMiniAppStore.getState().resolveConfirm(true);
    await removePromise;
    await flushIo();
    expect(postBodies).toEqual([
      { kind: "sticker", pack: "concurrent_pack", enabled: true },
    ]);

    // 2. 写操作在途期间被程序化切到 emoji 子页签，旧 sticker 响应结算不得污染 emoji 页签横幅、清空其输入或误关其添加面板。
    store.getState().selectKind("emoji");
    store.getState().toggleAddForm();
    store.getState().setAddPackInput("emoji_draft_keep");
    pendingPostGate.resolve(
      jsonRes(
        {
          ok: false,
          kind: "sticker",
          pack: "concurrent_pack",
          enabled: true,
          changed: true,
          persisted: false,
          code: "AD_BLACKLIST_STORAGE_UNAVAILABLE",
          message: "AD_BLACKLIST_STORAGE_UNAVAILABLE",
        },
        503
      )
    );
    pendingPostGate = null;
    await addPromise;
    expect(store.getState().kind).toBe("emoji");
    expect(store.getState().addFormOpen).toBeTrue();
    expect(store.getState().noticeBanner).toBeNull();
    expect(store.getState().addPackInput).toBe("emoji_draft_keep");

    // 3. 挂载页面：busyAction === true 时两个子页签与折叠触发按钮均处于 disabled，同时验证面板开合与搜索/添加按键不触发列表行重渲染。
    const uiStore: MiniAppAdBlacklistsStore = createAdBlacklistsStore();
    await withMountedAdBlacklistsPage(uiStore, async (container, settle): Promise<void> => {
      await settle();

      const removeBtn: MiniDomNode = findByClass(container, "ad-blacklist-remove-btn");
      const removeClickBeforeTyping = getReactPropHandler(removeBtn, "onClick");
      expect(removeClickBeforeTyping).toBeDefined();

      const foldTrigger: MiniDomNode = findByClass(container, "add-fold-trigger");
      const searchInput: MiniDomNode = findByClass(container, "search-input");
      const addInput: MiniDomNode = findByClass(container, "ad-blacklist-add-input");
      act((): void => {
        foldTrigger.triggerClick();
        getReactPropHandler(searchInput, "onChange")?.({ currentTarget: { value: "typing_search" } });
        getReactPropHandler(addInput, "onChange")?.({ currentTarget: { value: "typing_pack" } });
      });
      expect(uiStore.getState().addFormOpen).toBeTrue();
      expect(uiStore.getState().searchInput).toBe("typing_search");
      expect(uiStore.getState().addPackInput).toBe("typing_pack");
      expect(getReactPropHandler(removeBtn, "onClick")).toBe(removeClickBeforeTyping);

      const subtabs: MiniDomNode[] = findElements(
        container,
        (node): boolean => node.tagName === "BUTTON" && hasClass(node, "subtab-btn")
      );
      expect(subtabs).toHaveLength(2);
      expect(subtabs[0]!.getAttribute("disabled")).toBeNull();
      expect(subtabs[1]!.getAttribute("disabled")).toBeNull();
      expect(foldTrigger.getAttribute("disabled")).toBeNull();

      pendingPostGate = Promise.withResolvers<Response>();
      const addForm: MiniDomNode = findByClass(container, "ad-blacklist-add-row");
      act((): void => {
        getReactPropHandler(addForm, "onSubmit")?.({ preventDefault: (): void => {} });
      });
      expect(uiStore.getState().busyAction).toBeTrue();
      expect(foldTrigger.getAttribute("disabled")).not.toBeNull();
      for (const tabBtn of subtabs) {
        expect(tabBtn.getAttribute("disabled")).not.toBeNull();
      }

      pendingPostGate.resolve(
        jsonRes({
          ok: true,
          kind: "sticker",
          pack: "typing_pack",
          enabled: true,
          changed: true,
          persisted: true,
          code: "AD_BLACKLIST_ADDED",
          message: "AD_BLACKLIST_ADDED",
        })
      );
      pendingPostGate = null;
      await settle();
      expect(uiStore.getState().busyAction).toBeFalse();
      expect(uiStore.getState().addFormOpen).toBeFalse();
      expect(foldTrigger.getAttribute("disabled")).toBeNull();
      for (const tabBtn of subtabs) {
        expect(tabBtn.getAttribute("disabled")).toBeNull();
      }
    });
  });
});

describe("内容黑名单三语言（zh/en/ja）文案与状态码参数提取覆盖", () => {
  test("全部状态码、界面文案函数与 extractServerNoticeParams(kind/pack) 在三语言下完备非空", () => {
    for (const lang of MINI_APP_LANGUAGES) {
      const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(lang);
      expect(t.tabs.adBlacklists.length).toBeGreaterThan(0);
      expect(t.tabDescriptions.adBlacklists.length).toBeGreaterThan(0);
      expect(t.tabs.adBlacklists).not.toContain("广告");
      expect(t.tabs.adBlacklists).not.toContain("広告");
      expect(t.tabs.adBlacklists.toLowerCase()).not.toContain("ad blacklist");
      expect(t.adBlacklists.searchPlaceholder.length).toBeGreaterThan(0);
      expect(t.adBlacklists.addFoldButton.length).toBeGreaterThan(0);
      expect(t.adBlacklists.addInputPlaceholder.length).toBeGreaterThan(0);
      expect(t.adBlacklists.emptySearchHint("spam_x")).toContain("spam_x");
      for (const kind of MINI_APP_AD_BLACKLIST_KINDS) {
        expect(t.adBlacklists.previewPackButtonTitle(kind).length).toBeGreaterThan(0);
        expect(t.adBlacklists.confirmRemovePack(kind, "bad_pack")).toContain("bad_pack");
        expect(t.adBlacklists.emptyListHint(kind).length).toBeGreaterThan(0);
      }
      for (const code of MINI_APP_AD_BLACKLIST_MUTATION_CODES) {
        const withParams: string = t.serverNotice(code, {
          kind: "emoji",
          pack: "promo_pack",
          persisted: false,
        });
        const withoutParams: string = t.serverNotice(code);
        expect(withParams).not.toBe(code);
        expect(withParams.length).toBeGreaterThan(0);
        expect(withoutParams).not.toBe(code);
        expect(withoutParams.length).toBeGreaterThan(0);
      }
      const pureUnavailable: string = t.serverNotice("AD_BLACKLIST_STORAGE_UNAVAILABLE", {
        kind: "sticker",
        pack: "promo_pack",
        changed: false,
        persisted: false,
      });
      const partialCommitUnavailable: string = t.serverNotice(
        "AD_BLACKLIST_STORAGE_UNAVAILABLE",
        {
          kind: "sticker",
          pack: "promo_pack",
          changed: true,
          persisted: false,
        }
      );
      expect(partialCommitUnavailable).not.toBe(pureUnavailable);
      expect(partialCommitUnavailable).toContain("promo_pack");
    }

    for (const formatter of [
      formatZhAdBlacklistServerNotice,
      formatEnAdBlacklistServerNotice,
      formatJaAdBlacklistServerNotice,
    ]) {
      expect(formatter("UNKNOWN_CODE")).toBeNull();
    }

    expect(
      extractServerNoticeParams({
        kind: "emoji",
        pack: "spam_emoji",
        persisted: true,
      })
    ).toMatchObject({
      kind: "emoji",
      pack: "spam_emoji",
      persisted: true,
    });
    expect(
      extractServerNoticeParams({ kind: "invalid_kind", pack: 123 })
    ).toMatchObject({
      kind: undefined,
      pack: undefined,
    });
  });
});
