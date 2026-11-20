/**
 * Mini App 前端图库网格/预览卡片、分页栏、延时卸载钩子、白名单退场保留行与弹窗重置测试。
 */

import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import type React from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CapabilityCollapseBody,
  resolveCapabilityFollowScroll,
} from "../../packages/mini-app-frontend/components/animations/CapabilityCollapseBody";
import {
  TabHeightSizer,
} from "../../packages/mini-app-frontend/components/animations/TabHeightSizer";
import {
  scheduleDelayedUnmountEffect,
  useClosingSnapshot,
  useDelayedUnmount,
} from "../../packages/mini-app-frontend/components/animations/useDelayedUnmount";
import type { FlipAnimatableElement } from "../../packages/mini-app-frontend/components/animations/flipCollapse";
import {
  ChatTargetsModal,
  syncChatTargetsModalCloseReset,
} from "../../packages/mini-app-frontend/components/ChatTargetsModal";
import { GalleryGridList } from "../../packages/mini-app-frontend/components/GalleryGridList";
import { GalleryPreviewCard } from "../../packages/mini-app-frontend/components/GalleryPreviewCard";
import {
  resolveRetainedClosingWhitelistState,
  WhitelistEntryRowList,
} from "../../packages/mini-app-frontend/components/IdentityListRows";
import { PaginationBar } from "../../packages/mini-app-frontend/components/PaginationBar";
import { VERBATIM_CONTEXT_MAX } from "../../packages/mini-app-frontend/consts/memory";
import {
  CHAT_QA_ANSWER_MAX_CHARS,
  CHAT_QA_MAX_PER_CHAT,
  CHAT_QA_QUESTION_MAX_CHARS,
  DELETE_MESSAGE_CHAT_TARGET_MAX,
  MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX,
  MINI_APP_GALLERY_BLOB_CACHE_MAX,
  MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS,
  MINI_APP_MIN_LOADING_MS,
  TRANSLATE_CHAT_USER_LIMIT,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { WHITELIST_PERMISSION_KEYS } from "../../packages/mini-app-frontend/consts/whitelist";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import {
  clearMiniAppSessionToken,
  readMiniAppSessionToken,
} from "../../packages/mini-app-frontend/libs/credentials";
import { useGalleryImageUrls } from "../../packages/mini-app-frontend/libs/useGalleryImageUrls";
import { GalleryPage } from "../../packages/mini-app-frontend/pages/GalleryPage";
import { resetMiniAppStoreForTest, useMiniAppStore } from "../../packages/mini-app-frontend/store/app";
import { createChatsStore } from "../../packages/mini-app-frontend/store/chats";
import { createGalleryStore } from "../../packages/mini-app-frontend/store/gallery";
import type { WhitelistPermissionKey } from "../../packages/mini-app-frontend/types/identityPolicy";
import type {
  MiniAppChatTargetKind,
  MiniAppGalleryItem,
  MiniAppWhitelistEntryView,
} from "../../packages/mini-app-frontend/types/miniApp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";
import {
  collectNodeText,
  findElements,
  hasClass,
  inputValues,
  installMiniDom,
} from "../helpers/miniAppDom";
import type { MiniDomEnvironment, MiniDomNode } from "../helpers/miniAppDom";
import {
  seedTestMiniAppSession,
  wrapEncryptedTestFetch,
} from "./helpers/encryptedFetchMock";

const zh: Readonly<MiniAppTranslations> = getMiniAppTranslations("zh");

afterEach((): void => {
  jest.useRealTimers();
});

describe("Mini App 图库、分页与折叠动画组件", () => {
  test("PaginationBar 覆盖页码边界禁用、尺寸选项开关与摘要文本", () => {
    const firstPageHtml: string = renderToStaticMarkup(createElement(PaginationBar, {
      page: 0,
      totalPages: 3,
      total: 42,
      pageSize: MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS[0]!,
      pageSizeOptions: MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS,
      onPageChange: (): void => {},
      onPageSizeChange: (): void => {},
    }));
    expect(firstPageHtml).toContain(zh.pagination.summary(42, 1, 3));
    expect(firstPageHtml).toContain(`class="page-size-pill active "`);

    const lastPageHtml: string = renderToStaticMarkup(createElement(PaginationBar, {
      page: 99,
      totalPages: 3,
      total: 42,
      pageSize: MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS[0]!,
      disabled: true,
      onPageChange: (): void => {},
    }));
    expect(lastPageHtml).toContain(zh.pagination.summary(42, 3, 3));
    expect(lastPageHtml).not.toContain("pagination-sizes");
  });

  test("GalleryGridList 覆盖选中态、骨架与已加载缩略图、删除/下载中状态", () => {
    const items: readonly Readonly<MiniAppGalleryItem>[] = [
      { fileName: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png", mimeType: "image/png", sizeBytes: 2048, updatedAt: "2026-01-01 10:00:00" },
      { fileName: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png", mimeType: "image/png", sizeBytes: 4096, updatedAt: "2026-01-01 11:00:00" },
    ];
    const html: string = renderToStaticMarkup(createElement(GalleryGridList, {
      items,
      previewItem: items[0]!,
      deletingFileName: items[0]!.fileName,
      downloadingFileName: null,
      loadedImages: { [items[1]!.fileName]: true },
      batchEpoch: 2,
      t: zh,
      onMarkThumbLoaded: (): void => {},
      onSelectPreviewItem: (): void => {},
      onDownloadImage: (): void => {},
      onDeleteImage: (): void => {},
    }));
    expect(html).toContain("gallery-card selected");
    expect(html).toContain("gallery-thumb loading");
    expect(html).toContain("gallery-thumb loaded");
    expect(html).toContain(zh.gallery.deletingButton);
    expect(html).not.toContain("src=");

    const withUrlsHtml: string = renderToStaticMarkup(createElement(GalleryGridList, {
      items: [items[0]!],
      imageObjectUrls: { [items[0]!.fileName]: "blob:https://mini.test/thumb-0" },
      previewItem: null,
      deletingFileName: null,
      downloadingFileName: null,
      loadedImages: { [items[0]!.fileName]: true },
      batchEpoch: 2,
      t: zh,
      onMarkThumbLoaded: (): void => {},
      onSelectPreviewItem: (): void => {},
      onDownloadImage: (): void => {},
      onDeleteImage: (): void => {},
    }));
    expect(withUrlsHtml).toContain('src="blob:https://mini.test/thumb-0"');

    const downloadingHtml: string = renderToStaticMarkup(createElement(GalleryGridList, {
      items: [items[1]!],
      previewItem: null,
      deletingFileName: null,
      downloadingFileName: items[1]!.fileName,
      loadedImages: {},
      batchEpoch: 3,
      t: zh,
      onMarkThumbLoaded: (): void => {},
      onSelectPreviewItem: (): void => {},
      onDownloadImage: (): void => {},
      onDeleteImage: (): void => {},
    }));
    expect(downloadingHtml).toContain(zh.gallery.downloadingButton);
  });

  test("GalleryPreviewCard 覆盖骨架未就绪、已加载与收起禁用态", () => {
    const item: Readonly<MiniAppGalleryItem> = {
      fileName: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      updatedAt: "2026-01-01 12:00:00",
    };
    const loadingHtml: string = renderToStaticMarkup(createElement(GalleryPreviewCard, {
      previewItem: item,
      previewLoaded: false,
      downloadingFileName: item.fileName,
      deletingFileName: null,
      onMarkPreviewLoaded: (): void => {},
      onDownloadImage: (): void => {},
      onDeleteImage: (): void => {},
      onClosePreview: (): void => {},
    }));
    expect(loadingHtml).toContain("gallery-preview-img loading");
    expect(loadingHtml).toContain(zh.gallery.downloadingButton);
    expect(loadingHtml).not.toContain("src=");

    const closingHtml: string = renderToStaticMarkup(createElement(GalleryPreviewCard, {
      previewItem: item,
      imageObjectUrl: "blob:https://mini.test/preview-0",
      previewLoaded: true,
      isClosing: true,
      downloadingFileName: null,
      deletingFileName: item.fileName,
      onMarkPreviewLoaded: (): void => {},
      onDownloadImage: (): void => {},
      onDeleteImage: (): void => {},
      onClosePreview: (): void => {},
    }));
    expect(closingHtml).toContain("gallery-preview-img loaded");
    expect(closingHtml).toContain('src="blob:https://mini.test/preview-0"');
    expect(closingHtml).toContain(zh.gallery.deletingButton);
    expect(closingHtml).toContain("disabled=\"\"");
  });

  test("CapabilityCollapseBody 与 resolveCapabilityFollowScroll 覆盖展开类名及父节点锚点解析", () => {
    const slotRef: React.RefObject<null> = { current: null };
    const collapsedHtml: string = renderToStaticMarkup(createElement(
      CapabilityCollapseBody,
      { expanded: false, followScrollSlotRef: slotRef, children: createElement("span", null, "body") }
    ));
    expect(collapsedHtml).toContain('aria-hidden="true"');
    expect(collapsedHtml).not.toContain("expanded");

    const expandedHtml: string = renderToStaticMarkup(createElement(
      CapabilityCollapseBody,
      { expanded: true, followScrollSlotRef: slotRef, children: createElement("span", null, "body") }
    ));
    expect(expandedHtml).toContain("cap-collapse-wrap expanded");
    expect(expandedHtml).toContain('aria-hidden="false"');

    const stubClassList = {
      add: (): void => {},
      remove: (): void => {},
      contains: (): boolean => false,
    };
    const elementWithoutParent: FlipAnimatableElement = {
      style: { transform: "", willChange: "" },
      classList: stubClassList,
      parentElement: null,
      getBoundingClientRect: (): { top: number; height: number } => ({ top: 100, height: 0 }),
    };
    expect(resolveCapabilityFollowScroll(elementWithoutParent, 200)).toBeNull();

    const host = globalThis as { innerHeight?: unknown; scrollBy?: unknown };
    const prevInnerHeight: unknown = host.innerHeight;
    const prevScrollBy: unknown = host.scrollBy;
    try {
      host.innerHeight = 400;
      host.scrollBy = (): void => {};
      const elementWithParent: FlipAnimatableElement = {
        style: { transform: "", willChange: "" },
        classList: stubClassList,
        parentElement: {
          getBoundingClientRect: (): { top: number; height: number } => ({ top: 200, height: 300 }),
        },
        getBoundingClientRect: (): { top: number; height: number } => ({ top: 240, height: 0 }),
      };
      const target = resolveCapabilityFollowScroll(
        elementWithParent,
        240 + MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX
      );
      expect(target).not.toBeNull();
      expect(target!.fromTop).toBe(200);
      expect(target!.toTop).toBeLessThan(target!.fromTop);
    } finally {
      host.innerHeight = prevInnerHeight;
      host.scrollBy = prevScrollBy;
    }
  });

  test("useDelayedUnmount、useClosingSnapshot 与 scheduleDelayedUnmountEffect 覆盖延迟清理与提前取消", () => {
    const HookProbe = (props: { readonly activeValue: string | null }): React.JSX.Element => {
      const delayed = useDelayedUnmount(props.activeValue, 120);
      const snapshot: string = useClosingSnapshot(props.activeValue ?? "fallback", props.activeValue !== null);
      return createElement("div", null, `${String(delayed.displayValue)}|${String(delayed.isClosing)}|${snapshot}`);
    };
    expect(renderToStaticMarkup(createElement(HookProbe, { activeValue: "open" }))).toContain("open|false|open");
    expect(renderToStaticMarkup(createElement(HookProbe, { activeValue: null }))).toContain("null|false|fallback");

    jest.useFakeTimers();
    const lastNonNullRef: { current: string | null } = { current: "retained" };
    let unmounted: boolean = false;
    const setUnmounted = (value: boolean): void => {
      unmounted = value;
    };

    expect(scheduleDelayedUnmountEffect({
      activeValue: "retained",
      durationMs: 120,
      lastNonNullRef,
      setUnmounted,
    })).toBeUndefined();

    expect(scheduleDelayedUnmountEffect({
      activeValue: null,
      durationMs: 120,
      lastNonNullRef: { current: null },
      setUnmounted,
    })).toBeUndefined();

    const cancelEarly: (() => void) | undefined = scheduleDelayedUnmountEffect({
      activeValue: null,
      durationMs: 120,
      lastNonNullRef,
      setUnmounted,
    });
    expect(cancelEarly).toBeDefined();
    jest.advanceTimersByTime(60);
    cancelEarly!();
    jest.advanceTimersByTime(200);
    expect(lastNonNullRef.current).toBe("retained");
    expect(unmounted).toBeFalse();

    const cancelCompleted: (() => void) | undefined = scheduleDelayedUnmountEffect({
      activeValue: null,
      durationMs: 120,
      lastNonNullRef,
      setUnmounted,
    });
    expect(cancelCompleted).toBeDefined();
    jest.advanceTimersByTime(120);
    expect(lastNonNullRef.current).toBeNull();
    expect(unmounted).toBeTrue();
  });

  test("useDelayedUnmount 在 resetKey 变化时立即清空保留快照而不等待退场时长", async () => {
    await withMountedMiniDom(async (container: MiniDomNode, root: ReturnType<typeof createRoot>): Promise<void> => {
      const ResetProbe = (props: {
        readonly activeValue: string | null;
        readonly resetKey: string;
      }): React.JSX.Element => {
        const delayed = useDelayedUnmount(props.activeValue, 5_000, props.resetKey);
        return createElement("div", null, `${String(delayed.displayValue)}|${String(delayed.isClosing)}`);
      };
      await act(async (): Promise<void> => {
        root.render(createElement(ResetProbe, { activeValue: "ctx-1-open", resetKey: "ctx-1" }));
      });
      expect(collectNodeText(container)).toBe("ctx-1-open|false");

      await act(async (): Promise<void> => {
        root.render(createElement(ResetProbe, { activeValue: null, resetKey: "ctx-1" }));
      });
      expect(collectNodeText(container)).toBe("ctx-1-open|true");

      // 切换到新上下文且 activeValue 为 null 时，必须立即清空上一上下文快照。
      await act(async (): Promise<void> => {
        root.render(createElement(ResetProbe, { activeValue: null, resetKey: "ctx-2" }));
      });
      expect(collectNodeText(container)).toBe("null|false");
    });
  });

  test("目标弹窗退场与白名单移出保留行：退场期间 aria-hidden、tabIndex=-1、点击静默忽略，卸载后重置高度引用", async () => {
    const store = createChatsStore();
    const detail = {
      chatId: -100, title: "Doro群", isLockdownActive: false, quietRemainingMs: 0, lockdownRemainingMs: 0,
      activeSessions: { gag: 0, wed: false, verify: 0, qaSet: false },
      hotMessageCount: 0, hotMessageMax: VERBATIM_CONTEXT_MAX,
      qaPairCount: 1, deleteMessageTargetCount: 0, translateTargetCount: 0,
      joinedCountsByHour: [], batchKickRunning: false, lastBatchKickCompletion: null,
      features: { init: true, aiChat: true, translation: true, adDetect: false, floodControl: false, antiRaid: false, proxySend: false },
      botPermissions: null,
    } as const;
    const targets = {
      chatId: -100, qaItems: [{ q: "q1", a: "a1" }], qaMax: CHAT_QA_MAX_PER_CHAT,
      qaQuestionMaxChars: CHAT_QA_QUESTION_MAX_CHARS, qaAnswerMaxChars: CHAT_QA_ANSWER_MAX_CHARS,
      deleteMessageTargets: [], deleteMessageMax: DELETE_MESSAGE_CHAT_TARGET_MAX,
      translateTargets: [], translateMax: TRANSLATE_CHAT_USER_LIMIT, isTranslationEnabled: true,
    } as const;
    store.setState({
      selectedChatId: -100,
      chatDetail: detail,
      chatTargets: targets,
      activeTargetsModal: "qa",
      qaEditorOpen: true,
      qaQuestionInput: "q-draft",
      qaAnswerInput: "a-draft",
    });
    const prevTabRef: { current: MiniAppChatTargetKind | null } = { current: "qa" };
    const prevHadTargetsRef: { current: boolean } = { current: true };
    const lastHeightRef: { current: number } = { current: 240 };
    syncChatTargetsModalCloseReset({ isModalOpen: true, prevTabRef, prevHadTargetsRef, lastHeightRef });
    expect(prevTabRef.current).toBe("qa");

    // 挂载真实弹窗（子面板经 store 按切片自订阅），关闭后在退场窗口内核对无障碍标记并派发真实点击。
    const fetchCalls: string[] = [];
    const originalFetch: typeof fetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      fetchCalls.push(String(input));
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      await withMountedMiniDom(async (qaContainer: MiniDomNode, qaRoot: ReturnType<typeof createRoot>): Promise<void> => {
        await act(async (): Promise<void> => {
          qaRoot.render(createElement(ChatTargetsModal, { store }));
        });
        const openBackdrops: MiniDomNode[] = findElements(qaContainer, (element: MiniDomNode): boolean => hasClass(element, "chat-targets-backdrop"));
        expect(openBackdrops).toHaveLength(1);
        expect(hasClass(openBackdrops[0]!, "closing")).toBeFalse();

        await act(async (): Promise<void> => {
          store.getState().closeTargetsModal();
        });
        const backdrop: MiniDomNode = findElements(qaContainer, (element: MiniDomNode): boolean => hasClass(element, "chat-targets-backdrop"))[0]!;
        expect(hasClass(backdrop, "closing")).toBeTrue();
        expect(backdrop.getAttribute("role")).toBe("dialog");
        expect(backdrop.getAttribute("aria-hidden")).toBe("true");
        const tabs: MiniDomNode[] = findElements(qaContainer, (element: MiniDomNode): boolean => element.getAttribute("role") === "tab");
        expect(tabs).toHaveLength(3);
        expect(tabs.every((tab: MiniDomNode): boolean => tab.getAttribute("tabindex") === "-1")).toBeTrue();
        const openButtons: MiniDomNode[] = findElements(qaContainer, (element: MiniDomNode): boolean => hasClass(element, "chat-targets-qa-open-btn"));
        expect(openButtons).toHaveLength(1);
        expect(openButtons[0]!.getAttribute("tabindex")).toBe("-1");
        const formButtons: MiniDomNode[] = findElements(
          qaContainer,
          (element: MiniDomNode): boolean => element.tagName === "BUTTON" &&
            ["chat-targets-submit-btn", "chat-targets-cancel-btn", "chat-targets-qa-action-btn"]
              .some((className: string): boolean => hasClass(element, className))
        );
        expect(formButtons).toHaveLength(4);
        expect(formButtons.every((button: MiniDomNode): boolean => button.getAttribute("tabindex") === "-1")).toBeTrue();
        expect(inputValues(qaContainer)).toEqual(["q-draft", "a-draft"]);
        expect(findElements(qaContainer, (element: MiniDomNode): boolean => hasClass(element, "chat-targets-header-disabled"))).toHaveLength(0);
        expect(findElements(qaContainer, (element: MiniDomNode): boolean => element.attributes.has("disabled"))).toHaveLength(0);

        await act(async (): Promise<void> => {
          for (const element of [...tabs, ...openButtons, ...formButtons]) element.triggerClick();
        });
        expect(store.getState().activeTargetsModal).toBeNull();
        expect(store.getState().qaEditorOpen).toBeFalse();
        expect(store.getState().targetAddMenuOpen).toBeFalse();
        expect(store.getState().qaEditSourceQuestion).toBeNull();
        expect(store.getState().mutatingTargets).toBeFalse();
        expect(store.getState().qaQuestionInput).toBe("q-draft");
        expect(fetchCalls).toEqual([]);
      });

      // 翻译标签展开语言下拉时关闭弹窗：语言下拉的外部点击遮罩与弹窗同步进入退场。
      store.setState({
        activeTargetsModal: "translate",
        targetAddMenuOpen: true,
        targetIdFormOpen: true,
        translateLangMenuOpen: true,
      });
      await withMountedMiniDom(async (translateContainer: MiniDomNode, translateRoot: ReturnType<typeof createRoot>): Promise<void> => {
        await act(async (): Promise<void> => {
          translateRoot.render(createElement(ChatTargetsModal, { store }));
        });
        const openLangBackdrops: MiniDomNode[] = findElements(translateContainer, (element: MiniDomNode): boolean => hasClass(element, "chat-targets-lang-backdrop"));
        expect(openLangBackdrops).toHaveLength(1);
        expect(hasClass(openLangBackdrops[0]!, "closing")).toBeFalse();
        await act(async (): Promise<void> => {
          store.getState().closeTargetsModal();
        });
        const langBackdrop: MiniDomNode = findElements(translateContainer, (element: MiniDomNode): boolean => hasClass(element, "chat-targets-lang-backdrop"))[0]!;
        expect(hasClass(langBackdrop, "closing")).toBeTrue();
        expect(langBackdrop.getAttribute("aria-hidden")).toBe("true");
        await act(async (): Promise<void> => {
          langBackdrop.triggerClick();
        });
        expect(store.getState().translateLangMenuOpen).toBeFalse();
        expect(store.getState().activeTargetsModal).toBeNull();
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    // 验证快速关闭后再重开时 TabHeightSizer 立即重置残留行内高度、方向类与上次记录高度。
    await withMountedMiniDom(async (_container: MiniDomNode, root: ReturnType<typeof createRoot>): Promise<void> => {
      const reopenSizerRef = { current: null as { offsetHeight?: number; style?: { height: string; overflow: string; transition: string } } | null };
      const reopenPaneRef = { current: null as { offsetHeight?: number } | null };
      const reopenLastHeightRef = { current: 240 };
      const reopenPrevTabRef: { current: MiniAppChatTargetKind | null } = { current: "translate" };
      const reopenPrevHadTargetsRef = { current: true };
      await act(async (): Promise<void> => {
        root.render(createElement(TabHeightSizer, {
          activeTab: "translate",
          hasTargets: true,
          sizerRef: reopenSizerRef,
          paneRef: reopenPaneRef,
          lastHeightRef: reopenLastHeightRef,
          prevTabRef: reopenPrevTabRef,
          prevHadTargetsRef: reopenPrevHadTargetsRef,
          isClosing: true,
          children: createElement("div", null, "closing"),
        }));
      });
      if (reopenSizerRef.current?.style !== undefined) {
        reopenSizerRef.current.style.height = "240px";
        reopenSizerRef.current.style.overflow = "hidden";
        reopenSizerRef.current.style.transition = "height 0.18s ease";
      }
      reopenLastHeightRef.current = 240;

      await act(async (): Promise<void> => {
        root.render(createElement(TabHeightSizer, {
          activeTab: "qa",
          hasTargets: true,
          sizerRef: reopenSizerRef,
          paneRef: reopenPaneRef,
          lastHeightRef: reopenLastHeightRef,
          prevTabRef: reopenPrevTabRef,
          prevHadTargetsRef: reopenPrevHadTargetsRef,
          isClosing: false,
          children: createElement("div", null, "reopened"),
        }));
      });
      expect(reopenPrevTabRef.current).toBe("qa");
      expect(reopenLastHeightRef.current).toBe(0);
      expect(reopenSizerRef.current?.style).toEqual({ height: "", overflow: "", transition: "" });
      const paneNode: MiniDomNode | null = reopenPaneRef.current as unknown as MiniDomNode | null;
      expect(paneNode?.attributes.get("class") ?? "").toBe("chat-targets-tab-pane");
    });

    syncChatTargetsModalCloseReset({ isModalOpen: false, prevTabRef, prevHadTargetsRef, lastHeightRef });
    expect(prevTabRef.current).toBeNull();
    expect(prevHadTargetsRef.current).toBeFalse();
    expect(lastHeightRef.current).toBe(0);

    // 白名单移出保留行：回插期间标记 closingEntryId，行根节点 aria-hidden 且 pointer-events:none，按钮 tabindex=-1 且不带 disabled。
    const permissions = Object.fromEntries(
      WHITELIST_PERMISSION_KEYS.map((key: WhitelistPermissionKey): readonly [WhitelistPermissionKey, boolean] => [key, false])
    ) as Readonly<Record<WhitelistPermissionKey, boolean>>;
    const row9: MiniAppWhitelistEntryView = { id: 9, isChannel: false, displayName: "Doro", permissions };
    const retained = resolveRetainedClosingWhitelistState([], { contextKey: "whitelist:1:10:", index: 0, entry: row9 }, "whitelist:1:10:");
    expect(retained).toEqual({ items: [row9], closingEntryId: 9 });
    expect(resolveRetainedClosingWhitelistState([row9], { contextKey: "whitelist:1:10:", index: 0, entry: row9 }, "whitelist:1:10:").closingEntryId).toBeNull();
    expect(resolveRetainedClosingWhitelistState([], { contextKey: "whitelist:1:10:", index: 0, entry: row9 }, "whitelist:2:10:").closingEntryId).toBeNull();

    const closingRowHtml: string = renderToStaticMarkup(
      createElement(WhitelistEntryRowList, {
        items: retained.items, selectedEntryId: null, closingEntryId: retained.closingEntryId,
        busyAction: false, t: zh, onTogglePermissionDrawer: (): void => {}, onClosePermissionDrawer: (): void => {},
        onPermissionsUpdated: (): void => {}, onRemoveWhitelist: async (): Promise<void> => {},
      })
    );
    expect(closingRowHtml).toContain('class="identity-row-group" aria-hidden="true" style="pointer-events:none"');
    expect(closingRowHtml.match(/<button[^>]*tabindex="-1"/gu)?.length).toBe(2);
    expect(closingRowHtml).not.toContain("disabled");
  });

  test("GalleryPage 与 useGalleryImageUrls 覆盖加密拉取 blob URL 渲染、预览复用、失败骨架结算、认证失效锁定、上限淘汰与卸载释放", async () => {
    jest.useFakeTimers();
    const originalFetch: typeof fetch = globalThis.fetch;
    const revokeSpy = spyOn(URL, "revokeObjectURL");
    const flushGalleryAsync = async (advanceMs: number = 0): Promise<void> => {
      await act(async (): Promise<void> => {
        for (let tick: number = 0; tick < 8; tick += 1) {
          Bun.sleepSync(2);
          await new Promise<void>((resolve: () => void): void => {
            setImmediate(resolve);
          });
        }
        if (advanceMs > 0) {
          jest.advanceTimersByTime(advanceMs);
          for (let tick: number = 0; tick < 8; tick += 1) {
            Bun.sleepSync(2);
            await new Promise<void>((resolve: () => void): void => {
              setImmediate(resolve);
            });
          }
        }
      });
    };

    try {
      (globalThis as { Telegram?: unknown }).Telegram = { WebApp: { initData: "signed-init-data" } };
      seedTestMiniAppSession("f".repeat(64), Date.now() + 600_000);
      resetMiniAppStoreForTest();
      useMiniAppStore.setState({ gateState: "unlocked", sessionExpiresAt: Date.now() + 600_000 });

      const fileRequests: string[] = [];
      let pendingGate: PromiseWithResolvers<void> | null = null;
      let pendingSignal: AbortSignal | undefined;
      let currentMode: "main" | "authFail" = "main";
      let pageBatchTag: string = "init";

      const makeItem = (name: string): MiniAppGalleryItem => ({
        fileName: name,
        mimeType: "image/png",
        sizeBytes: 1024,
        updatedAt: "2026-01-01 10:00:00",
      });

      globalThis.fetch = wrapEncryptedTestFetch(
        async (url: URL, _decryptedInit: RequestInit | undefined, rawInit: RequestInit | undefined): Promise<Response> => {
          if (url.pathname === "/api/gallery") {
            const page: number = Number(url.searchParams.get("page") ?? "1");
            if (currentMode === "authFail") {
              return Response.json({
                directory: "/data/gallery",
                exists: true,
                total: 1,
                page: 1,
                pageSize: 10,
                totalPages: 1,
                items: [makeItem("auth-expired.png")],
              });
            }
            if (pageBatchTag === "evict") {
              const items: MiniAppGalleryItem[] = Array.from(
                { length: 20 },
                (_: unknown, idx: number): MiniAppGalleryItem =>
                  makeItem(`evict-p${page}-${idx}.png`)
              );
              return Response.json({
                directory: "/data/gallery",
                exists: true,
                total: 80,
                page,
                pageSize: 20,
                totalPages: 4,
                items,
              });
            }
            if (pageBatchTag === "pending") {
              return Response.json({
                directory: "/data/gallery",
                exists: true,
                total: 2,
                page,
                pageSize: 10,
                totalPages: 2,
                items: [makeItem("pending-cancel.png")],
              });
            }
            return Response.json({
              directory: "/data/gallery",
              exists: true,
              total: 2,
              page,
              pageSize: 10,
              totalPages: 2,
              items: [makeItem("thumb-ok.png"), makeItem("thumb-fail.png")],
            });
          }
          if (url.pathname === "/api/gallery/file") {
            const fileName: string = url.searchParams.get("fileName") ?? "";
            fileRequests.push(fileName);
            if (fileName === "thumb-fail.png") {
              return Response.json({ error: "IMAGE_NOT_FOUND" }, { status: 404 });
            }
            if (fileName === "auth-expired.png") {
              return Response.json({ code: "PASSWORD_REQUIRED", error: "expired" }, { status: 401 });
            }
            if (fileName === "pending-cancel.png" && pendingGate !== null) {
              pendingSignal = rawInit?.signal ?? undefined;
              await pendingGate.promise;
            }
            return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
              status: 200,
              headers: { "Content-Type": "image/png" },
            });
          }
          return Response.json({ error: "not found" }, { status: 404 });
        }
      );

      // 1. 挂载 GalleryPage：成功条目渲染 blob URL，失败条目结算骨架不卡死，预览复用缓存不重发请求，预览失败也结算骨架，
      //    超限淘汰最旧非可见 URL，切页中止在途请求，卸载全量调用 URL.revokeObjectURL。
      const environment: MiniDomEnvironment = installMiniDom();
      try {
        const container: MiniDomNode = environment.document.createElement("div");
        const root: ReturnType<typeof createRoot> = createRoot(container as unknown as Element);
        const galleryStore = createGalleryStore();
        (galleryStore as { getInitialState: typeof galleryStore.getState }).getInitialState =
          galleryStore.getState;

        await act(async (): Promise<void> => {
          root.render(createElement(GalleryPage, { storeFactory: () => galleryStore }));
        });
        await flushGalleryAsync(MINI_APP_MIN_LOADING_MS);
        await flushGalleryAsync(MINI_APP_MIN_LOADING_MS);

        const thumbImages = (): MiniDomNode[] =>
          findElements(
            container,
            (el: MiniDomNode): boolean => el.tagName === "IMG" && hasClass(el, "gallery-thumb")
          );
        const okThumb: MiniDomNode | undefined = thumbImages().find(
          (el: MiniDomNode): boolean => el.getAttribute("alt") === "thumb-ok.png"
        );
        const failThumb: MiniDomNode | undefined = thumbImages().find(
          (el: MiniDomNode): boolean => el.getAttribute("alt") === "thumb-fail.png"
        );
        expect(okThumb?.getAttribute("src")).toStartWith("blob:");
        expect(failThumb?.getAttribute("src")).toBeNull();
        expect(galleryStore.getState().loadedImages["thumb-fail.png"]).toBeTrue();

        // 打开已缓存图片的预览：复用内存 blob URL，不再向 /api/gallery/file 发重复请求。
        const fileCallsBeforeCachedPreview: number = fileRequests.length;
        await act(async (): Promise<void> => {
          galleryStore.getState().setPreviewItem(makeItem("thumb-ok.png"));
        });
        await flushGalleryAsync();
        const previewImg: MiniDomNode | undefined = findElements(
          container,
          (el: MiniDomNode): boolean => el.tagName === "IMG" && hasClass(el, "gallery-preview-img")
        )[0];
        expect(previewImg?.getAttribute("src")).toBe(okThumb?.getAttribute("src") ?? null);
        expect(fileRequests.length).toBe(fileCallsBeforeCachedPreview);

        // 打开失败图片的预览：重新请求但仍失败后，预览骨架在最短时长后结算为 previewLoaded: true。
        await act(async (): Promise<void> => {
          galleryStore.getState().setPreviewItem(makeItem("thumb-fail.png"));
        });
        await flushGalleryAsync(MINI_APP_MIN_LOADING_MS);
        expect(galleryStore.getState().previewLoaded).toBeTrue();
        await act(async (): Promise<void> => {
          galleryStore.getState().setPreviewItem(null);
        });
        await flushGalleryAsync(500);

        // 连续加载 4 页共 80 张不同图片（加上此前 1 张共 81 张 > MINI_APP_GALLERY_BLOB_CACHE_MAX = 64）：触发最旧非可见条目淘汰。
        pageBatchTag = "evict";
        for (let page: number = 1; page <= 4; page += 1) {
          await act(async (): Promise<void> => {
            void galleryStore.getState().loadGallery(page, 20);
          });
          await flushGalleryAsync(MINI_APP_MIN_LOADING_MS);
        }
        expect(revokeSpy.mock.calls.length).toBeGreaterThanOrEqual(81 - MINI_APP_GALLERY_BLOB_CACHE_MAX);
        expect(thumbImages()).toHaveLength(20);
        expect(
          thumbImages().every((img: MiniDomNode): boolean => (img.getAttribute("src") ?? "").startsWith("blob:"))
        ).toBeTrue();

        // 切页时立即中止上一页尚未返回的在途请求。
        pageBatchTag = "pending";
        pendingGate = Promise.withResolvers<void>();
        await act(async (): Promise<void> => {
          void galleryStore.getState().loadGallery(1, 10);
        });
        await flushGalleryAsync(MINI_APP_MIN_LOADING_MS);
        expect(pendingSignal).toBeDefined();
        expect(pendingSignal?.aborted).toBeFalse();

        pageBatchTag = "init";
        await act(async (): Promise<void> => {
          void galleryStore.getState().loadGallery(2, 10);
        });
        await flushGalleryAsync(MINI_APP_MIN_LOADING_MS);
        expect(pendingSignal?.aborted).toBeTrue();
        pendingGate.resolve();
        await flushGalleryAsync();

        // 卸载 GalleryPage：释放缓存中全部剩余的 blob URL。
        const revokesBeforeUnmount: number = revokeSpy.mock.calls.length;
        await act(async (): Promise<void> => {
          root.unmount();
        });
        expect(revokeSpy.mock.calls.length - revokesBeforeUnmount).toBe(MINI_APP_GALLERY_BLOB_CACHE_MAX);
      } finally {
        environment.restore();
      }

      // 2. 独立挂载验证：图库文件请求收到 401 PASSWORD_REQUIRED 时立即清除凭据并锁定全局门禁，同时结算骨架。
      currentMode = "authFail";
      seedTestMiniAppSession("e".repeat(64), Date.now() + 600_000);
      useMiniAppStore.setState({ gateState: "unlocked", sessionExpiresAt: Date.now() + 600_000 });
      await withMountedMiniDom(async (_authContainer: MiniDomNode, authRoot: ReturnType<typeof createRoot>): Promise<void> => {
        const authGalleryStore = createGalleryStore();
        (authGalleryStore as { getInitialState: typeof authGalleryStore.getState }).getInitialState =
          authGalleryStore.getState;
        await act(async (): Promise<void> => {
          authRoot.render(createElement(GalleryPage, { storeFactory: () => authGalleryStore }));
        });
        await flushGalleryAsync(MINI_APP_MIN_LOADING_MS);
        await flushGalleryAsync(MINI_APP_MIN_LOADING_MS);
        expect(useMiniAppStore.getState().gateState).toBe("password");
        expect(readMiniAppSessionToken()).toBe("");
        expect(authGalleryStore.getState().loadedImages["auth-expired.png"]).toBeTrue();
      });
    } finally {
      revokeSpy.mockRestore();
      globalThis.fetch = originalFetch;
      Reflect.deleteProperty(globalThis, "Telegram");
      clearMiniAppSessionToken();
      resetMiniAppStoreForTest();
    }
  });

  test("useGalleryImageUrls 覆盖删除完成后立即释放并移除对象 URL、并发加载微任务合批提交及取消/卸载失效保护", async () => {
    const originalFetch: typeof fetch = globalThis.fetch;
    const revokeSpy = spyOn(URL, "revokeObjectURL");
    const createSpy = spyOn(URL, "createObjectURL");
    const flushTicks = async (): Promise<void> => {
      for (let tick: number = 0; tick < 8; tick += 1) {
        await new Promise<void>((resolve: () => void): void => { setImmediate(resolve); });
      }
    };
    const flushMicrotasksAndReact = async (): Promise<void> => {
      await act(flushTicks);
    };
    const waitUntil = async (predicate: () => boolean): Promise<void> => {
      const deadline: number = Date.now() + 3_000;
      while (!predicate() && Date.now() < deadline) {
        await flushMicrotasksAndReact();
        if (predicate()) break;
        await Bun.sleep(2);
      }
      expect(predicate()).toBeTrue();
    };
    const makePngResponse = (): Response =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    const pendingByFile: Map<string, PromiseWithResolvers<Response>> = new Map<
      string,
      PromiseWithResolvers<Response>
    >();

    try {
      (globalThis as { Telegram?: unknown }).Telegram = { WebApp: { initData: "signed-init-data" } };
      seedTestMiniAppSession("f".repeat(64), Date.now() + 600_000);
      resetMiniAppStoreForTest();
      useMiniAppStore.setState({ gateState: "unlocked", sessionExpiresAt: Date.now() + 600_000 });

      const abortedByFile: Map<string, boolean> = new Map<string, boolean>();
      const fetchCalls: string[] = [];

      globalThis.fetch = wrapEncryptedTestFetch(
        async (url: URL, _decryptedInit: RequestInit | undefined, rawInit: RequestInit | undefined): Promise<Response> => {
          if (url.pathname === "/api/gallery/file") {
            const fileName: string = url.searchParams.get("fileName") ?? "";
            fetchCalls.push(fileName);
            const deferred = pendingByFile.get(fileName);
            if (deferred !== undefined) {
              rawInit?.signal?.addEventListener("abort", (): void => { abortedByFile.set(fileName, true); });
              return await deferred.promise;
            }
            return makePngResponse();
          }
          return Response.json({ error: "not found" }, { status: 404 });
        }
      );

      const makeItem = (name: string): MiniAppGalleryItem => ({
        fileName: name, mimeType: "image/png", sizeBytes: 1024, updatedAt: "2026-01-01 10:00:00",
      });
      const [itemA, itemB, itemC, itemD, itemE] = [
        makeItem("batch-a.png"), makeItem("batch-b.png"), makeItem("batch-c.png"),
        makeItem("cancel-d.png"), makeItem("unmount-e.png"),
      ] as const;

      const snapshots: Readonly<Record<string, string>>[] = [];
      let latestUrls: Readonly<Record<string, string>> = {};
      const noopThumb = (): void => {};
      const noopPreview = (): void => {};

      const HookProbe = (props: {
        readonly items: readonly Readonly<MiniAppGalleryItem>[] | null;
        readonly deletingFileName: string | null;
      }): React.JSX.Element => {
        const urls: Readonly<Record<string, string>> = useGalleryImageUrls({
          items: props.items,
          displayPreviewItem: null,
          batchEpoch: 1,
          deletingFileName: props.deletingFileName,
          onMarkThumbLoaded: noopThumb,
          onMarkPreviewLoaded: noopPreview,
        });
        latestUrls = urls;
        snapshots.push(urls);
        return createElement("div", null, String(Object.keys(urls).length));
      };

      await withMountedMiniDom(async (_container: MiniDomNode, root: ReturnType<typeof createRoot>): Promise<void> => {
        // 1. items 为 null 时不发起请求。
        await act(async (): Promise<void> => {
          root.render(createElement(HookProbe, { items: null, deletingFileName: null }));
        });
        await flushMicrotasksAndReact();
        expect(fetchCalls).toEqual([]);
        expect(latestUrls).toEqual({});

        // 2. 并发拉取多张图片并在同一微任务轮次完成，验证仅触发一次快照合并提交。
        const deferredA = Promise.withResolvers<Response>();
        const deferredB = Promise.withResolvers<Response>();
        const deferredC = Promise.withResolvers<Response>();
        pendingByFile.set("batch-a.png", deferredA);
        pendingByFile.set("batch-b.png", deferredB);
        pendingByFile.set("batch-c.png", deferredC);

        await act(async (): Promise<void> => {
          root.render(createElement(HookProbe, { items: [itemA, itemB, itemC], deletingFileName: null }));
        });
        await waitUntil((): boolean => fetchCalls.length === 3);
        expect([...fetchCalls].sort()).toEqual(["batch-a.png", "batch-b.png", "batch-c.png"]);

        const snapshotsBeforeBatchResolve: number = snapshots.length;
        await act(async (): Promise<void> => {
          deferredA.resolve(makePngResponse());
          deferredB.resolve(makePngResponse());
          deferredC.resolve(makePngResponse());
          pendingByFile.delete("batch-a.png");
          pendingByFile.delete("batch-b.png");
          pendingByFile.delete("batch-c.png");
          await new Promise<void>((resolve: () => void): void => { setImmediate(resolve); });
        });
        await flushMicrotasksAndReact();

        const batchAddedSnapshots: Readonly<Record<string, string>>[] = snapshots
          .slice(snapshotsBeforeBatchResolve)
          .filter((snap: Readonly<Record<string, string>>): boolean => Object.keys(snap).length > 0);
        expect(batchAddedSnapshots).toHaveLength(1);
        const urlA: string = latestUrls["batch-a.png"] ?? "";
        const urlB: string = latestUrls["batch-b.png"] ?? "";
        const urlC: string = latestUrls["batch-c.png"] ?? "";
        expect(urlA).toStartWith("blob:");
        expect(urlB).toStartWith("blob:");
        expect(urlC).toStartWith("blob:");
        expect(revokeSpy).not.toHaveBeenCalled();

        // 3. 删除失败回退（deletingFileName 回到 null 但 items 仍含目标文件）不得提前释放 URL。
        await act(async (): Promise<void> => {
          root.render(createElement(HookProbe, { items: [itemA, itemB, itemC], deletingFileName: "batch-a.png" }));
        });
        await act(async (): Promise<void> => {
          root.render(createElement(HookProbe, { items: [itemA, itemB, itemC], deletingFileName: null }));
        });
        expect(revokeSpy).not.toHaveBeenCalled();
        expect(latestUrls["batch-a.png"]).toBe(urlA);

        // 4. 删除完成（deletingFileName 从 batch-a.png 变为 null 且 items 不再包含 batch-a.png）立即释放并移除快照，无需等待 LRU 淘汰。
        await act(async (): Promise<void> => {
          root.render(createElement(HookProbe, { items: [itemA, itemB, itemC], deletingFileName: "batch-a.png" }));
        });
        expect(revokeSpy).not.toHaveBeenCalled();
        await act(async (): Promise<void> => {
          root.render(createElement(HookProbe, { items: [itemB, itemC], deletingFileName: null }));
        });
        expect(revokeSpy).toHaveBeenCalledTimes(1);
        expect(revokeSpy).toHaveBeenCalledWith(urlA);
        expect(latestUrls["batch-a.png"]).toBeUndefined();
        expect(latestUrls["batch-b.png"]).toBe(urlB);
        expect(latestUrls["batch-c.png"]).toBe(urlC);

        // 5. 切离页面取消在途请求：即便底层 mock 在中止后才返回响应，也不写入状态且立即 revoke 新建 URL。
        const deferredD = Promise.withResolvers<Response>();
        pendingByFile.set("cancel-d.png", deferredD);
        await act(async (): Promise<void> => {
          root.render(createElement(HookProbe, { items: [itemB, itemC, itemD], deletingFileName: null }));
        });
        await waitUntil((): boolean => fetchCalls.includes("cancel-d.png"));
        await act(async (): Promise<void> => {
          root.render(createElement(HookProbe, { items: [itemB, itemC], deletingFileName: null }));
        });
        expect(abortedByFile.get("cancel-d.png")).toBeTrue();

        const createdBeforeCancelledResolve: number = createSpy.mock.calls.length;
        const revokesBeforeCancelledResolve: number = revokeSpy.mock.calls.length;
        await act(async (): Promise<void> => {
          deferredD.resolve(makePngResponse());
          pendingByFile.delete("cancel-d.png");
        });
        await flushMicrotasksAndReact();
        expect(latestUrls["cancel-d.png"]).toBeUndefined();
        expect(revokeSpy.mock.calls.length - revokesBeforeCancelledResolve).toBe(
          createSpy.mock.calls.length - createdBeforeCancelledResolve
        );

        // 6. 卸载清理：立即中止在途请求并释放剩余缓存 URL；卸载后滞后返回的响应同样立即释放且不再提交状态。
        const deferredE = Promise.withResolvers<Response>();
        pendingByFile.set("unmount-e.png", deferredE);
        await act(async (): Promise<void> => {
          root.render(createElement(HookProbe, { items: [itemB, itemC, itemE], deletingFileName: null }));
        });
        await waitUntil((): boolean => fetchCalls.includes("unmount-e.png"));

        const revokesBeforeUnmount: number = revokeSpy.mock.calls.length;
        await act(async (): Promise<void> => { root.unmount(); });
        expect(abortedByFile.get("unmount-e.png")).toBeTrue();
        expect(revokeSpy.mock.calls.length - revokesBeforeUnmount).toBe(2);
        expect(revokeSpy).toHaveBeenCalledWith(urlB);
        expect(revokeSpy).toHaveBeenCalledWith(urlC);

        const createdBeforeUnmountedResolve: number = createSpy.mock.calls.length;
        const revokesBeforeUnmountedResolve: number = revokeSpy.mock.calls.length;
        const snapshotsAtUnmount: number = snapshots.length;
        await act(async (): Promise<void> => {
          deferredE.resolve(makePngResponse());
          pendingByFile.delete("unmount-e.png");
        });
        await flushMicrotasksAndReact();
        expect(snapshots.length).toBe(snapshotsAtUnmount);
        expect(revokeSpy.mock.calls.length - revokesBeforeUnmountedResolve).toBe(
          createSpy.mock.calls.length - createdBeforeUnmountedResolve
        );
      });
    } finally {
      for (const [, deferred] of pendingByFile) {
        deferred.resolve(makePngResponse());
      }
      pendingByFile.clear();
      await flushTicks();
      createSpy.mockRestore();
      revokeSpy.mockRestore();
      globalThis.fetch = originalFetch;
      Reflect.deleteProperty(globalThis, "Telegram");
      clearMiniAppSessionToken();
      resetMiniAppStoreForTest();
    }
  });
});

/**
 * 在最小 DOM 中挂载一个 React 根节点运行用例，结束时卸载并还原全局 DOM 环境。
 * @param run 接收挂载容器与根节点的用例体。
 */
async function withMountedMiniDom(
  run: (container: MiniDomNode, root: ReturnType<typeof createRoot>) => Promise<void>
): Promise<void> {
  const environment: MiniDomEnvironment = installMiniDom();
  try {
    const container: MiniDomNode = environment.document.createElement("div");
    const root: ReturnType<typeof createRoot> = createRoot(container as unknown as Element);
    try {
      await run(container, root);
    } finally {
      await act(async (): Promise<void> => {
        root.unmount();
      });
    }
  } finally {
    environment.restore();
  }
}
