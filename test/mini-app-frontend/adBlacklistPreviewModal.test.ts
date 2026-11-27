/**
 * Mini App 内容黑名单页内贴纸包 / 自定义表情包预览弹窗（`AdBlacklistPreviewModal`）测试：
 * - 点击列表包名按钮直接在页内打开预览弹窗（列表无 `<a target="_blank">` 外跳链接，不关闭 Mini App）；
 * - 骨架占位 -> 包标题、总枚数、类型标签、缩略图渲染、TGS/WEBM 格式角标与 Emoji 占位降级；
 * - 大包「加载更多」追加分页、失败诊断与重试、「复制链接」剪贴板反馈与「在 Telegram 打开」官方 `openTelegramLink` 桥接及浏览器回退；
 * - 关闭弹窗中止在途请求并完成退场过渡、快速切换目标包丢弃过期响应、鉴权 401 重定向与三语文案覆盖。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { ConfirmModal } from "../../packages/mini-app-frontend/components/ConfirmModal";
import {
  MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE,
  MINI_APP_LANGUAGES,
  MINI_APP_MIN_LOADING_MS,
  MINI_APP_TARGETS_MODAL_CLOSE_MS,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
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
  MiniAppAdBlacklistPreviewResponse,
  MiniAppAdBlacklistsResponse,
} from "../../packages/mini-app-frontend/types/miniApp/adBlacklists";
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
  kind: MiniAppAdBlacklistKind = "sticker"
): Response {
  return jsonRes({
    kind,
    items: packs.map((pack: string): { readonly pack: string } => ({ pack })),
    page: 1,
    pageSize: MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE,
    total: packs.length,
    totalPages: 1,
    stickerTotal: kind === "sticker" ? packs.length : 0,
    emojiTotal: kind === "emoji" ? packs.length : 0,
    query: "",
  } satisfies MiniAppAdBlacklistsResponse);
}

function findByClass(root: MiniDomNode, className: string): MiniDomNode {
  return findElements(root, (node): boolean => hasClass(node, className))[0]!;
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
    settle: (extraMs?: number) => Promise<void>
  ) => Promise<void>
): Promise<void> {
  jest.useFakeTimers();
  const environment: MiniDomEnvironment = installMiniDom();
  try {
    const container: MiniDomNode = environment.document.createElement("div");
    const root: Root = createRoot(container as unknown as Element);

    const settle = async (extraMs: number = 0): Promise<void> => {
      for (let round: number = 0; round < 2; round += 1) {
        await act(async (): Promise<void> => {
          await flushIo();
          jest.advanceTimersByTime(
            Math.max(MINI_APP_MIN_LOADING_MS, MINI_APP_TARGETS_MODAL_CLOSE_MS, extraMs) + 40
          );
          await flushIo();
        });
      }
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
      return handler(url, decryptedInit, rawInit);
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

describe("内容黑名单页内包预览弹窗（AdBlacklistPreviewModal）", () => {
  test("点击包名先经 metaOnly=1 确认精确格数再按需加载缩略图，支持精确加载更多、复制链接与 openTelegramLink 桥接", async () => {
    const previewRequests: string[] = [];
    const openedTelegramLinks: string[] = [];
    const copiedTexts: string[] = [];
    let pendingMetaGate: PromiseWithResolvers<Response> | null =
      Promise.withResolvers<Response>();
    let pendingImagesGate: PromiseWithResolvers<Response> | null =
      Promise.withResolvers<Response>();
    let pendingMoreGate: PromiseWithResolvers<Response> | null =
      Promise.withResolvers<Response>();

    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: {
        initData: "signed-superadmin-initdata",
        openTelegramLink: (url: string): void => {
          openedTelegramLinks.push(url);
        },
      },
    };
    const prevNavigator: unknown = (globalThis as { navigator?: unknown }).navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          writeText: async (text: string): Promise<void> => {
            copiedTexts.push(text);
          },
        },
      },
    });

    route("GET /api/ad-blacklists", (): Response => mockListRes(["gfedfsedaff"], "emoji"));
    route("GET /api/ad-blacklists/preview", (url: URL): Response | Promise<Response> => {
      previewRequests.push(url.search);
      const offset: number = Number(url.searchParams.get("offset") ?? "0");
      const metaOnly: boolean = url.searchParams.get("metaOnly") === "1";
      if (offset === 0 && metaOnly && pendingMetaGate !== null) {
        return pendingMetaGate.promise;
      }
      if (offset === 0 && !metaOnly && pendingImagesGate !== null) {
        return pendingImagesGate.promise;
      }
      if (offset === 2 && pendingMoreGate !== null) {
        return pendingMoreGate.promise;
      }
      return jsonRes({ error: "unexpected preview query" }, 500);
    });

    const store: MiniAppAdBlacklistsStore = createAdBlacklistsStore();
    store.getState().selectKind("emoji");

    try {
      await withMountedPage(store, async (container, settle): Promise<void> => {
        await settle();
        expect(findElements(container, (node): boolean => node.tagName === "A")).toHaveLength(0);

        // 1. 点击包名按钮 -> 阶段 1（metaOnly=1 在途）：仅显示紧凑加载点，不猜测 16 格骨架
        const packButton: MiniDomNode = findByClass(container, "ad-blacklist-pack-link");
        act((): void => {
          packButton.triggerClick();
        });
        await act(async (): Promise<void> => {
          await flushIo();
        });
        expect(findElements(container, (node): boolean => hasClass(node, "ad-blacklist-preview-modal"))).toHaveLength(1);
        expect(findElements(container, (node): boolean => hasClass(node, "ad-blacklist-preview-meta-loading"))).toHaveLength(1);
        expect(findElements(container, (node): boolean => hasClass(node, "loading-dots-wave"))).toHaveLength(1);
        expect(findElements(container, (node): boolean => hasClass(node, "ad-blacklist-preview-tile"))).toHaveLength(0);
        expect(findElements(container, (node): boolean => hasClass(node, "gallery-img-skeleton"))).toHaveLength(0);

        // 2. 阶段 1 返回精确 2 枚元数据（1 枚 hasImage=true，1 枚 hasImage=false）：
        // 立即展示包标题/总枚数与精确 2 格（仅 hasImage 格播放 <GalleryImageSkeleton>，无图格立即显示 Emoji 与 TGS 角标）
        pendingMetaGate!.resolve(
          jsonRes({
            kind: "emoji",
            pack: "gfedfsedaff",
            title: "Zaako Custom Emojis",
            stickerType: "custom_emoji",
            totalCount: 4,
            offset: 0,
            hasMore: true,
            nextOffset: 2,
            items: [
              {
                fileUniqueId: "u1",
                emoji: "🔥",
                format: "static",
                hasImage: true,
                imageDataUrl: null,
              },
              {
                fileUniqueId: "u2",
                emoji: "🌀",
                format: "animated",
                hasImage: false,
                imageDataUrl: null,
              },
            ],
          } satisfies MiniAppAdBlacklistPreviewResponse)
        );
        pendingMetaGate = null;
        await act(async (): Promise<void> => {
          await flushIo();
        });

        expect(store.getState().previewLoadingMeta).toBeFalse();
        expect(store.getState().previewLoadingImages).toBeTrue();
        expect(findElements(container, (node): boolean => hasClass(node, "ad-blacklist-preview-meta-loading"))).toHaveLength(0);
        expect(findElements(container, (node): boolean => hasClass(node, "ad-blacklist-preview-tile"))).toHaveLength(2);
        expect(findElements(container, (node): boolean => hasClass(node, "ad-blacklist-preview-skeleton-tile"))).toHaveLength(1);
        expect(findElements(container, (node): boolean => hasClass(node, "gallery-img-skeleton"))).toHaveLength(1);
        expect(findElements(container, (node): boolean => hasClass(node, "gallery-skeleton-icon-pulse"))).toHaveLength(1);
        expect(findElements(container, (node): boolean => hasClass(node, "ad-blacklist-preview-fallback"))).toHaveLength(1);
        expect(collectNodeText(findByClass(container, "ad-blacklist-preview-modal"))).toContain("Zaako Custom Emojis");
        expect(collectNodeText(findByClass(container, "ad-blacklist-preview-modal"))).toContain(zh.adBlacklists.previewCountBadge(4));
        expect(collectNodeText(findByClass(container, "ad-blacklist-preview-modal"))).toContain("🌀");

        // 3. 阶段 2 返回缩略图：u1 原地切换为 <img>，骨架全部卸载
        pendingImagesGate!.resolve(
          jsonRes({
            kind: "emoji",
            pack: "gfedfsedaff",
            title: "Zaako Custom Emojis",
            stickerType: "custom_emoji",
            totalCount: 4,
            offset: 0,
            hasMore: true,
            nextOffset: 2,
            items: [
              {
                fileUniqueId: "u1",
                emoji: "🔥",
                format: "static",
                hasImage: true,
                imageDataUrl: "data:image/webp;base64,UklGRg==",
              },
              {
                fileUniqueId: "u2",
                emoji: "🌀",
                format: "animated",
                hasImage: false,
                imageDataUrl: null,
              },
            ],
          } satisfies MiniAppAdBlacklistPreviewResponse)
        );
        pendingImagesGate = null;
        await settle();

        expect(store.getState().previewLoadingImages).toBeFalse();
        expect(findElements(container, (node): boolean => hasClass(node, "gallery-img-skeleton"))).toHaveLength(0);
        const modalText: string = collectNodeText(findByClass(container, "ad-blacklist-preview-modal"));
        expect(modalText).toContain(zh.adBlacklists.previewStickerTypeLabel("custom_emoji"));
        expect(modalText).toContain(zh.adBlacklists.previewAnimatedTag);
        const previewImgs: MiniDomNode[] = findElements(
          container,
          (node): boolean => node.tagName === "IMG" && hasClass(node, "ad-blacklist-preview-img")
        );
        expect(previewImgs).toHaveLength(1);
        expect(previewImgs[0]?.getAttribute("src")).toBe("data:image/webp;base64,UklGRg==");

        // 4. 点击「加载更多」：按已知剩余枚数（4 - 2 = 2）精确追加 2 格骨架，随后落定 4 枚完整条目
        act((): void => {
          findByClass(container, "ad-blacklist-preview-more-btn").triggerClick();
        });
        await act(async (): Promise<void> => {
          await flushIo();
        });
        expect(findElements(container, (node): boolean => hasClass(node, "gallery-img-skeleton"))).toHaveLength(2);
        expect(findElements(container, (node): boolean => hasClass(node, "ad-blacklist-preview-tile"))).toHaveLength(4);

        pendingMoreGate!.resolve(
          jsonRes({
            kind: "emoji",
            pack: "gfedfsedaff",
            title: "Zaako Custom Emojis",
            stickerType: "custom_emoji",
            totalCount: 4,
            offset: 2,
            hasMore: false,
            nextOffset: 4,
            items: [
              {
                fileUniqueId: "u3",
                emoji: "🎬",
                format: "video",
                hasImage: true,
                imageDataUrl: "data:image/webp;base64,UklGRg==",
              },
              {
                fileUniqueId: "u4",
                emoji: "😎",
                format: "static",
                hasImage: true,
                imageDataUrl: "data:image/png;base64,iVBORw==",
              },
            ],
          } satisfies MiniAppAdBlacklistPreviewResponse)
        );
        pendingMoreGate = null;
        await settle();

        expect(previewRequests).toHaveLength(3);
        expect(previewRequests[0]).toContain("metaOnly=1");
        expect(previewRequests[1]).not.toContain("metaOnly=1");
        expect(previewRequests[2]).toContain("offset=2");
        expect(store.getState().previewData?.items).toHaveLength(4);
        expect(collectNodeText(findByClass(container, "ad-blacklist-preview-modal"))).toContain(
          zh.adBlacklists.previewVideoTag
        );
        expect(
          findElements(container, (node): boolean => hasClass(node, "ad-blacklist-preview-more-btn"))
        ).toHaveLength(0);

        // 5. 点击「复制链接」与「在 Telegram 打开」
        act((): void => {
          findButtonByText(container, zh.adBlacklists.previewCopyLinkButton)?.triggerClick();
        });
        await act(async (): Promise<void> => {
          await flushIo();
        });
        expect(copiedTexts).toEqual(["https://t.me/addemoji/gfedfsedaff"]);
        expect(useMiniAppStore.getState().toastText).toBe(zh.adBlacklists.previewLinkCopiedToast);

        act((): void => {
          findButtonByText(container, zh.adBlacklists.previewOpenTelegramButton)?.triggerClick();
        });
        expect(openedTelegramLinks).toEqual(["https://t.me/addemoji/gfedfsedaff"]);

        // 6. 关闭弹窗：先进入 closing 退场态并标记 aria-hidden，退场时长结束后卸载
        act((): void => {
          findByClass(container, "ad-blacklist-preview-close-btn").triggerClick();
        });
        expect(store.getState().previewTarget).toBeNull();
        expect(hasClass(findByClass(container, "ad-blacklist-preview-modal"), "closing")).toBeTrue();
        expect(findByClass(container, "ad-blacklist-preview-backdrop").getAttribute("aria-hidden")).toBe("true");
        await settle();
        expect(findElements(container, (node): boolean => hasClass(node, "ad-blacklist-preview-modal"))).toHaveLength(0);
      });
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: prevNavigator,
      });
    }
  });

  test("404 失效包展示本地化诊断与重试；关闭或切包立即中止旧请求，401 触发重认证且三语文案齐全", async () => {
    let previewCalls: number = 0;
    const observedSignals: AbortSignal[] = [];
    const staleGates: PromiseWithResolvers<Response>[] = [];
    let unmountPromise: Promise<void> | undefined;
    let unmountSignal: AbortSignal | undefined;

    route("GET /api/ad-blacklists", (): Response => mockListRes(["pack_a", "pack_b"], "sticker"));
    route(
      "GET /api/ad-blacklists/preview",
      (url: URL, _decryptedInit: RequestInit | undefined, rawInit: RequestInit | undefined): Response | Promise<Response> => {
        previewCalls += 1;
        if (rawInit?.signal !== undefined && rawInit.signal !== null) {
          observedSignals.push(rawInit.signal);
        }
        const pack: string = url.searchParams.get("pack") ?? "";
        if (pack === "pack_a" && previewCalls === 1) {
          return jsonRes({ error: "AD_BLACKLIST_PREVIEW_NOT_FOUND" }, 404);
        }
        if (pack === "pack_a" && previewCalls === 2) {
          return jsonRes({
            kind: "sticker",
            pack: "pack_a",
            title: "Recovered Sticker Pack",
            stickerType: "regular",
            totalCount: 0,
            offset: 0,
            hasMore: false,
            nextOffset: 0,
            items: [],
          } satisfies MiniAppAdBlacklistPreviewResponse);
        }
        if (pack === "pack_slow") {
          const gate: PromiseWithResolvers<Response> =
            Promise.withResolvers<Response>();
          staleGates.push(gate);
          return gate.promise;
        }
        if (pack === "pack_unauth") {
          return jsonRes({ code: "PASSWORD_REQUIRED", error: "expired" }, 401);
        }
        return jsonRes({
          kind: "sticker",
          pack,
          title: `Pack ${pack}`,
          stickerType: "regular",
          totalCount: 1,
          offset: 0,
          hasMore: false,
          nextOffset: 1,
          items: [
            {
              fileUniqueId: "fb1",
              emoji: "🐱",
              format: "static",
              hasImage: false,
              imageDataUrl: null,
            },
          ],
        } satisfies MiniAppAdBlacklistPreviewResponse);
      }
    );

    const store: MiniAppAdBlacklistsStore = createAdBlacklistsStore();
    await withMountedPage(store, async (container, settle): Promise<void> => {
      await settle();

      // 1. 首次 404 展示失效提示与重试按钮，点击重试成功并渲染空包提示
      act((): void => {
        findByClass(container, "ad-blacklist-pack-link").triggerClick();
      });
      await settle();
      expect(collectNodeText(findByClass(container, "ad-blacklist-preview-modal"))).toContain(
        zh.serverNotice("AD_BLACKLIST_PREVIEW_NOT_FOUND")
      );

      act((): void => {
        findButtonByText(container, zh.adBlacklists.previewRetryButton)?.triggerClick();
      });
      await settle();
      expect(collectNodeText(findByClass(container, "ad-blacklist-preview-modal"))).toContain(
        "Recovered Sticker Pack"
      );
      expect(collectNodeText(findByClass(container, "ad-blacklist-preview-modal"))).toContain(
        zh.adBlacklists.previewEmptyHint
      );

      // 2. 在途慢请求期间切换到 pack_b：旧请求信号立即 aborted，最终展示 pack_b
      let slowPromise!: Promise<void>;
      act((): void => {
        slowPromise = store.getState().openPreview("pack_slow");
      });
      await act(async (): Promise<void> => {
        await flushIo();
      });
      const slowSignal: AbortSignal | undefined = observedSignals.at(-1);
      expect(slowSignal?.aborted).toBeFalse();

      let fastPromise!: Promise<void>;
      act((): void => {
        fastPromise = store.getState().openPreview("pack_b");
      });
      expect(slowSignal?.aborted).toBeTrue();
      staleGates.shift()?.reject(new DOMException("Aborted", "AbortError"));
      await slowPromise;
      await settle();
      await fastPromise;
      expect(store.getState().previewData?.pack).toBe("pack_b");
      expect(store.getState().previewError).toBeNull();

      // 3. 预览接口返回 401 触发全局会话锁定
      let unauthPromise!: Promise<void>;
      act((): void => {
        unauthPromise = store.getState().openPreview("pack_unauth");
      });
      await settle();
      await unauthPromise;
      expect(useMiniAppStore.getState().gateState).toBe("password");

      // 4. 页面卸载时自动中止仍在途的预览请求，避免服务端继续下载 Telegram 缩略图
      seedTestMiniAppSession("f".repeat(64), Date.now() + 600_000, TEST_SESSION_KEY);
      useMiniAppStore.setState({ gateState: "unlocked" });
      const prevSignalCount: number = observedSignals.length;
      act((): void => {
        unmountPromise = store.getState().openPreview("pack_slow");
      });
      await act(async (): Promise<void> => {
        await flushIo();
      });
      expect(observedSignals.length).toBe(prevSignalCount + 1);
      unmountSignal = observedSignals.at(-1);
      expect(unmountSignal?.aborted).toBeFalse();
    });
    expect(unmountSignal?.aborted).toBeTrue();
    staleGates.shift()?.reject(new DOMException("Aborted", "AbortError"));
    await unmountPromise;

    // 4. 三语文案完备性
    for (const lang of MINI_APP_LANGUAGES) {
      const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(lang);
      expect(t.serverNotice("AD_BLACKLIST_PREVIEW_NOT_FOUND")).not.toBe(
        "AD_BLACKLIST_PREVIEW_NOT_FOUND"
      );
      expect(t.serverNotice("AD_BLACKLIST_PREVIEW_UNAVAILABLE")).not.toBe(
        "AD_BLACKLIST_PREVIEW_UNAVAILABLE"
      );
      expect(t.adBlacklists.previewCountBadge(12)).toContain("12");
      expect(t.adBlacklists.previewLoadMoreButton(16, 40)).toContain("16");
      expect(t.adBlacklists.previewLoadMoreButton(16, 40)).toContain("40");
      expect(t.adBlacklists.previewStickerTypeLabel("regular").length).toBeGreaterThan(0);
      expect(t.adBlacklists.previewStickerTypeLabel("mask").length).toBeGreaterThan(0);
      expect(t.adBlacklists.previewStickerTypeLabel("custom_emoji").length).toBeGreaterThan(0);
      expect(t.adBlacklists.previewCopyLinkButton.length).toBeGreaterThan(0);
      expect(t.adBlacklists.previewOpenTelegramButton.length).toBeGreaterThan(0);
    }
  });
});
