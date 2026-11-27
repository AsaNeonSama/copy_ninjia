/**
 * Mini App 内容黑名单添加输入解析（纯 short name、Telegram 网页分享链接与 `tg://` 深链）及跨页签自动归类切换测试。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { ConfirmModal } from "../../packages/mini-app-frontend/components/ConfirmModal";
import {
  MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE,
  MINI_APP_MIN_LOADING_MS,
  MINI_APP_TELEGRAM_PACK_TG_LINK_PATTERN,
  MINI_APP_TELEGRAM_PACK_WEB_LINK_PATTERN,
  STICKER_PACK_NAME_PATTERN,
} from "../../packages/mini-app-frontend/consts/miniApp/ui";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import { parseAdBlacklistPackInput } from "../../packages/mini-app-frontend/libs/adBlacklistPackInput";
import { clearMiniAppSessionToken } from "../../packages/mini-app-frontend/libs/credentials";
import { AdBlacklistsPage } from "../../packages/mini-app-frontend/pages/AdBlacklistsPage";
import { createAdBlacklistsStore } from "../../packages/mini-app-frontend/store/adBlacklists";
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
} from "../../packages/mini-app-frontend/types/miniApp/adBlacklists";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";
import {
  collectNodeText,
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
  decryptedInit: RequestInit | undefined
) => Response | Promise<Response>;

const routes: Map<string, RouteHandler> = new Map<string, RouteHandler>();
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

function findByClass(root: MiniDomNode, className: string): MiniDomNode {
  return findElements(root, (node): boolean => hasClass(node, className))[0]!;
}

function getReactPropHandler(
  node: MiniDomNode,
  propName: string
): ((event: Record<string, unknown>) => void) | undefined {
  const record: Record<string, unknown> = node as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!key.startsWith("__reactProps$")) continue;
    const propsObj: Record<string, unknown> | undefined = record[key] as
      | Record<string, unknown>
      | undefined;
    const handler: unknown = propsObj?.[propName];
    if (typeof handler === "function") {
      return handler as (event: Record<string, unknown>) => void;
    }
  }
  return undefined;
}

function submitAdd(input: MiniDomNode, form: MiniDomNode, value: string): void {
  act((): void => {
    getReactPropHandler(input, "onChange")?.({ currentTarget: { value } });
  });
  act((): void => {
    getReactPropHandler(form, "onSubmit")?.({ preventDefault: (): void => {} });
  });
}

async function flushIo(): Promise<void> {
  for (let i: number = 0; i < 8; i += 1) {
    Bun.sleepSync(2);
    await new Promise<void>((resolve: () => void): void => {
      setImmediate(resolve);
    });
  }
}

async function withMountedPage(
  store: MiniAppAdBlacklistsStore,
  run: (
    container: MiniDomNode,
    settle: () => Promise<void>
  ) => Promise<void>
): Promise<void> {
  jest.useFakeTimers();
  const environment: MiniDomEnvironment = installMiniDom();
  try {
    const container: MiniDomNode = environment.document.createElement("div");
    const root: Root = createRoot(container as unknown as Element);

    const settle = async (): Promise<void> => {
      await act(async (): Promise<void> => {
        await flushIo();
        jest.advanceTimersByTime(MINI_APP_MIN_LOADING_MS + 40);
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
  (globalThis as { Telegram?: unknown }).Telegram = {
    WebApp: { initData: "signed-superadmin-initdata" },
  };
  seedTestMiniAppSession("e".repeat(64), Date.now() + 600_000, TEST_SESSION_KEY);
  globalThis.fetch = wrapEncryptedTestFetch(
    async (
      url: URL,
      decryptedInit: RequestInit | undefined,
      rawInit: RequestInit | undefined
    ): Promise<Response> => {
      const method: string = (rawInit?.method ?? "GET").toUpperCase();
      const handler: RouteHandler | undefined = routes.get(`${method} ${url.pathname}`);
      if (handler === undefined) {
        return jsonRes({ error: `unexpected ${method} ${url.pathname}` }, 500);
      }
      return handler(url, decryptedInit);
    }
  );
  resetMiniAppStoreForTest();
  useMiniAppStore.setState({
    gateState: "unlocked",
    language: "zh",
    activeTab: "adBlacklists",
  });
});

afterEach((): void => {
  globalThis.fetch = originalFetch;
  delete (globalThis as { Telegram?: unknown }).Telegram;
  clearMiniAppSessionToken();
  resetMiniAppStoreForTest();
  routes.clear();
});

describe("parseAdBlacklistPackInput 解析纯包名与 Telegram 链接", () => {
  test("纯 short name 裁剪空白、保留大小写并沿用当前子页签种类", () => {
    expect(parseAdBlacklistPackInput("gfedfsedaff", "sticker")).toEqual({
      kind: "sticker",
      pack: "gfedfsedaff",
    });
    expect(parseAdBlacklistPackInput("  Mixed_Pack_01  ", "emoji")).toEqual({
      kind: "emoji",
      pack: "Mixed_Pack_01",
    });
    const maxLenPack: string = "A".repeat(64);
    expect(parseAdBlacklistPackInput(maxLenPack, "sticker")).toEqual({
      kind: "sticker",
      pack: maxLenPack,
    });
  });

  test("支持 t.me / telegram.me / telegram.dog 网页链接与 tg:// 原生深链并按链接类型自动归类", () => {
    const cases: readonly (readonly [string, MiniAppAdBlacklistKind, MiniAppAdBlacklistKind, string])[] = [
      ["https://t.me/addemoji/gfedfsedaff", "sticker", "emoji", "gfedfsedaff"],
      ["  https://t.me/addemoji/gfedfsedaff/  ", "sticker", "emoji", "gfedfsedaff"],
      ["http://t.me/addemoji/Emoji_Pack_1", "sticker", "emoji", "Emoji_Pack_1"],
      ["t.me/addemoji/BareEmoji_2", "sticker", "emoji", "BareEmoji_2"],
      ["HTTPS://T.ME/AddEmoji/MixedCase_Emoji/", "sticker", "emoji", "MixedCase_Emoji"],
      ["https://telegram.me/addemoji/MirrorEmoji_3", "sticker", "emoji", "MirrorEmoji_3"],
      ["telegram.dog/addemoji/DogEmoji_4", "sticker", "emoji", "DogEmoji_4"],
      ["https://t.me/addstickers/Sticker_Pack_1", "emoji", "sticker", "Sticker_Pack_1"],
      ["http://t.me/addstickers/Sticker_Pack_2/", "emoji", "sticker", "Sticker_Pack_2"],
      ["t.me/addstickers/BareSticker_3", "emoji", "sticker", "BareSticker_3"],
      ["https://telegram.me/addstickers/MirrorSticker_4", "emoji", "sticker", "MirrorSticker_4"],
      ["https://telegram.dog/addstickers/DogSticker_5", "emoji", "sticker", "DogSticker_5"],
      ["tg://addemoji?set=gfedfsedaff", "sticker", "emoji", "gfedfsedaff"],
      ["TG://AddEmoji/?set=MixedTg_Emoji", "sticker", "emoji", "MixedTg_Emoji"],
      ["tg://addstickers?set=NativeSticker_1", "emoji", "sticker", "NativeSticker_1"],
      ["tg://addstickers/?set=NativeSticker_2", "emoji", "sticker", "NativeSticker_2"],
    ];

    for (const [input, fallbackKind, expectedKind, expectedPack] of cases) {
      expect(parseAdBlacklistPackInput(input, fallbackKind)).toEqual({
        kind: expectedKind,
        pack: expectedPack,
      });
    }
    expect(STICKER_PACK_NAME_PATTERN.flags).toBe("");
    expect(MINI_APP_TELEGRAM_PACK_WEB_LINK_PATTERN.flags).toBe("i");
    expect(MINI_APP_TELEGRAM_PACK_TG_LINK_PATTERN.flags).toBe("i");
    expect(MINI_APP_TELEGRAM_PACK_WEB_LINK_PATTERN.lastIndex).toBe(0);
    expect(MINI_APP_TELEGRAM_PACK_TG_LINK_PATTERN.lastIndex).toBe(0);
  });

  test("严格拒绝非法包名、非 Telegram 域名、非贴纸/表情路径、多余路径段、查询参数及非法协议", () => {
    const invalidInputs: readonly string[] = [
      "",
      "   ",
      "bad-pack",
      "bad pack",
      "中文包名",
      "a".repeat(65),
      "https://t.me/addemoji/",
      "https://t.me/addemoji",
      "https://t.me/addemoji/gfedfsedaff/extra",
      "https://t.me/addemoji/gfedfsedaff//",
      "https://t.me/addemoji/bad-pack",
      `https://t.me/addemoji/${"a".repeat(65)}`,
      "https://t.me/some_username",
      "https://t.me/addlist/abc123",
      "https://example.com/addemoji/gfedfsedaff",
      "https://t.me.evil.com/addemoji/gfedfsedaff",
      "https://evil.com/https://t.me/addemoji/gfedfsedaff",
      "ftp://t.me/addemoji/gfedfsedaff",
      "//t.me/addemoji/gfedfsedaff",
      "https://user@t.me/addemoji/gfedfsedaff",
      "https://t.me:8080/addemoji/gfedfsedaff",
      "https://t.me/addemoji/gfedfsedaff?foo=bar",
      "https://t.me/addemoji/gfedfsedaff#top",
      "https://t.me/addemoji/foo bar",
      "tg://addemoji?set=",
      "tg://addemoji?other=gfedfsedaff",
      "tg://addemoji?set=gfedfsedaff&extra=1",
      "tg://addemoji?set=bad-pack",
      "tg://resolve?domain=gfedfsedaff",
      "javascript:alert(1)",
    ];

    for (const raw of invalidInputs) {
      expect(parseAdBlacklistPackInput(raw, "sticker")).toBeNull();
      expect(parseAdBlacklistPackInput(raw, "emoji")).toBeNull();
    }
  });
});

describe("内容黑名单粘贴 Telegram 链接自动归类与切换页签", () => {
  test("在贴纸页签粘贴 addemoji 链接自动加入表情包黑名单并切换页签（且不触发重复 GET），反向及跨页签判重均正确", async () => {
    const stickerPacks: string[] = ["existing_sticker"];
    const emojiPacks: string[] = [];
    const getLog: MiniAppAdBlacklistKind[] = [];
    const postLog: MiniAppAdBlacklistMutationRequest[] = [];

    route("GET /api/ad-blacklists", (url: URL): Response => {
      const kind: MiniAppAdBlacklistKind =
        url.searchParams.get("kind") === "emoji" ? "emoji" : "sticker";
      getLog.push(kind);
      const list: readonly string[] = kind === "sticker" ? stickerPacks : emojiPacks;
      return mockListRes(list, {
        kind,
        stickerTotal: stickerPacks.length,
        emojiTotal: emojiPacks.length,
      });
    });

    route(
      "POST /api/ad-blacklists",
      (_url: URL, decryptedInit: RequestInit | undefined): Response => {
        const body: MiniAppAdBlacklistMutationRequest = JSON.parse(
          String(decryptedInit?.body ?? "{}")
        ) as MiniAppAdBlacklistMutationRequest;
        postLog.push(body);
        const target: string[] = body.kind === "sticker" ? stickerPacks : emojiPacks;
        if (target.includes(body.pack)) {
          return mockMutationRes(body, "AD_BLACKLIST_DUPLICATE", {
            changed: false,
            duplicate: true,
            persisted: true,
          });
        }
        target.push(body.pack);
        return mockMutationRes(body, "AD_BLACKLIST_ADDED", {
          changed: true,
          persisted: true,
        });
      }
    );

    const store: MiniAppAdBlacklistsStore = createAdBlacklistsStore();
    await withMountedPage(store, async (container, settle): Promise<void> => {
      await settle();
      expect(store.getState().kind).toBe("sticker");
      expect(getLog).toEqual(["sticker"]);

      const foldTrigger: MiniDomNode = findByClass(container, "add-fold-trigger");
      const addInput: MiniDomNode = findByClass(container, "ad-blacklist-add-input");
      const addForm: MiniDomNode = findByClass(container, "ad-blacklist-add-row");

      // 1. 在 sticker 页签粘贴 addemoji 链接：发送 canonical pack 名，自动切到 emoji 页签，收起面板且仅发 1 次 GET。
      act((): void => { foldTrigger.triggerClick(); });
      submitAdd(addInput, addForm, "https://t.me/addemoji/gfedfsedaff");
      await settle();

      expect(postLog).toEqual([
        { kind: "emoji", pack: "gfedfsedaff", enabled: true },
      ]);
      expect(store.getState().kind).toBe("emoji");
      expect(store.getState().addFormOpen).toBeFalse();
      expect(store.getState().addPackInput).toBe("");
      expect(store.getState().noticeBanner).toBeNull();
      expect(store.getState().emojiTotal).toBe(1);
      expect(getLog).toEqual(["sticker", "emoji"]);
      expect(collectNodeText(container)).toContain("gfedfsedaff");
      expect(collectNodeText(container)).toContain("https://t.me/addemoji/gfedfsedaff");
      const emojiButtons: MiniDomNode[] = findElements(
        container,
        (node): boolean => node.tagName === "BUTTON" && hasClass(node, "ad-blacklist-pack-link")
      );
      expect(emojiButtons).toHaveLength(1);
      expect(findElements(container, (node): boolean => node.tagName === "A")).toHaveLength(0);
      expect(useMiniAppStore.getState().toastText).toBe(
        zh.serverNotice("AD_BLACKLIST_ADDED", {
          kind: "emoji",
          pack: "gfedfsedaff",
          changed: true,
          persisted: true,
        })
      );

      // 2. 在 emoji 页签粘贴无协议头带尾部斜杠的 addstickers 链接：自动切回 sticker 页签，同样仅发 1 次 GET。
      act((): void => { foldTrigger.triggerClick(); });
      submitAdd(addInput, addForm, "  t.me/addstickers/StickerFromLink_01/  ");
      await settle();

      expect(postLog[1]).toEqual({
        kind: "sticker",
        pack: "StickerFromLink_01",
        enabled: true,
      });
      expect(store.getState().kind).toBe("sticker");
      expect(store.getState().addFormOpen).toBeFalse();
      expect(store.getState().stickerTotal).toBe(2);
      expect(getLog).toEqual(["sticker", "emoji", "sticker"]);
      expect(collectNodeText(container)).toContain("StickerFromLink_01");

      // 3. 在 sticker 页签再次粘贴已存在的 tg://addemoji 深链：判重不跳页签、保持面板展开、不额外发 GET。
      act((): void => { foldTrigger.triggerClick(); });
      submitAdd(addInput, addForm, "tg://addemoji?set=gfedfsedaff");
      await settle();

      expect(postLog[2]).toEqual({
        kind: "emoji",
        pack: "gfedfsedaff",
        enabled: true,
      });
      expect(store.getState().kind).toBe("sticker");
      expect(store.getState().addFormOpen).toBeTrue();
      expect(store.getState().noticeBanner).toEqual({
        kind: "duplicate",
        message: zh.serverNotice("AD_BLACKLIST_DUPLICATE", {
          kind: "emoji",
          pack: "gfedfsedaff",
          changed: false,
          persisted: true,
        }),
      });
      expect(getLog).toEqual(["sticker", "emoji", "sticker"]);
    });
  });

  test("503 部分提交跨页签自动切换并展示告警；页码夹紧后的紧随新增刷新不被跳过，中途程序化切签保持竞态隔离", async () => {
    const emojiPacks: string[] = [];
    const stickerPacks: string[] = ["only_sticker"];
    let getCount: number = 0;
    let pendingGate: PromiseWithResolvers<Response> | null = null;

    route("GET /api/ad-blacklists", (url: URL): Response => {
      getCount += 1;
      const kind: MiniAppAdBlacklistKind =
        url.searchParams.get("kind") === "emoji" ? "emoji" : "sticker";
      const list: readonly string[] = kind === "sticker" ? stickerPacks : emojiPacks;
      return mockListRes(list, {
        kind,
        page: 1,
        stickerTotal: stickerPacks.length,
        emojiTotal: emojiPacks.length,
      });
    });

    route(
      "POST /api/ad-blacklists",
      (_url: URL, decryptedInit: RequestInit | undefined): Response | Promise<Response> => {
        const body: MiniAppAdBlacklistMutationRequest = JSON.parse(
          String(decryptedInit?.body ?? "{}")
        ) as MiniAppAdBlacklistMutationRequest;
        if (pendingGate !== null) {
          return pendingGate.promise;
        }
        if (body.pack === "partial_emoji") {
          emojiPacks.push(body.pack);
          return mockMutationRes(body, "AD_BLACKLIST_STORAGE_UNAVAILABLE", {
            changed: true,
            persisted: false,
            status: 503,
          });
        }
        stickerPacks.push(body.pack);
        return mockMutationRes(body, "AD_BLACKLIST_ADDED", {
          changed: true,
          persisted: true,
        });
      }
    );

    const store: MiniAppAdBlacklistsStore = createAdBlacklistsStore();
    // 1. 无挂载态下发生服务端页码夹紧后，立即新增同页签包名仍必须正常触发变更后刷新。
    store.getState().setPageNumber(4);
    await store.getState().loadCurrentList(true);
    expect(store.getState().stickerPageNumber).toBe(1);
    expect(getCount).toBe(1);

    store.getState().setAddPackInput("after_clamp_pack");
    await store.getState().addPack();
    expect(getCount).toBe(2);
    expect(store.getState().stickerTotal).toBe(2);

    // 2. 在 sticker 页签粘贴 addemoji 链接遇到 503 部分提交（changed: true）：切换到 emoji 页签并保留告警横幅。
    store.getState().setAddPackInput("https://t.me/addemoji/partial_emoji");
    await store.getState().addPack();
    expect(store.getState().kind).toBe("emoji");
    expect(store.getState().addPackInput).toBe("");
    expect(store.getState().emojiTotal).toBe(1);
    expect(store.getState().noticeBanner).toEqual({
      kind: "error",
      message: zh.serverNotice("AD_BLACKLIST_STORAGE_UNAVAILABLE", {
        kind: "emoji",
        pack: "partial_emoji",
        changed: true,
        persisted: false,
      }),
    });

    // 3. 跨页签链接请求在途期间被程序化切签并写入新草稿，旧响应结算不得覆写新页签草稿与展开态。
    store.getState().selectKind("sticker");
    pendingGate = Promise.withResolvers<Response>();
    store.getState().setAddPackInput("https://t.me/addemoji/race_emoji");
    const addPromise: Promise<void> = store.getState().addPack();
    store.getState().selectKind("emoji");
    store.getState().toggleAddForm();
    store.getState().setAddPackInput("keep_my_draft");
    pendingGate.resolve(
      jsonRes({
        ok: true,
        kind: "emoji",
        pack: "race_emoji",
        enabled: true,
        changed: true,
        persisted: true,
        code: "AD_BLACKLIST_ADDED",
        message: "AD_BLACKLIST_ADDED",
      })
    );
    pendingGate = null;
    await addPromise;
    expect(store.getState().kind).toBe("emoji");
    expect(store.getState().addFormOpen).toBeTrue();
    expect(store.getState().addPackInput).toBe("keep_my_draft");
  });
});
