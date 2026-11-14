import { afterEach, describe, expect, jest, test } from "bun:test";
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
  ChatTargetsModalDialog,
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
  MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS,
  TRANSLATE_CHAT_USER_LIMIT,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { WHITELIST_PERMISSION_KEYS } from "../../packages/mini-app-frontend/consts/whitelist";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import { createChatsStore } from "../../packages/mini-app-frontend/store/chats";
import type { MiniAppChatsStoreState } from "../../packages/mini-app-frontend/store/chats";
import type { WhitelistPermissionKey } from "../../packages/mini-app-frontend/types/identityPolicy";
import type {
  MiniAppChatTargetKind,
  MiniAppGalleryItem,
  MiniAppWhitelistEntryView,
} from "../../packages/mini-app-frontend/types/miniApp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";

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

    const closingHtml: string = renderToStaticMarkup(createElement(GalleryPreviewCard, {
      previewItem: item,
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
    await withMinimalMountedDom(async (doc: MinimalDomDoc, root: ReturnType<typeof createRoot>, readText: (node: MinimalDomNode) => string): Promise<void> => {
      const ResetProbe = (props: {
        readonly activeValue: string | null;
        readonly resetKey: string;
      }): React.JSX.Element => {
        const delayed = useDelayedUnmount(props.activeValue, 5_000, props.resetKey);
        return createElement("div", null, `${String(delayed.displayValue)}|${String(delayed.isClosing)}`);
      };
      const container = doc.createElement("div");
      expect(container).toBeDefined();
      await act(async (): Promise<void> => {
        root.render(createElement(ResetProbe, { activeValue: "ctx-1-open", resetKey: "ctx-1" }));
      });
      expect(readText(doc.mountRoot)).toBe("ctx-1-open|false");

      await act(async (): Promise<void> => {
        root.render(createElement(ResetProbe, { activeValue: null, resetKey: "ctx-1" }));
      });
      expect(readText(doc.mountRoot)).toBe("ctx-1-open|true");

      // 切换到新上下文且 activeValue 为 null 时，必须立即清空上一上下文快照。
      await act(async (): Promise<void> => {
        root.render(createElement(ResetProbe, { activeValue: null, resetKey: "ctx-2" }));
      });
      expect(readText(doc.mountRoot)).toBe("null|false");
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
    const snapshotState: MiniAppChatsStoreState = store.getState();
    store.getState().closeTargetsModal();

    let scrollTopCalled: boolean = false;
    const prevTabRef: { current: MiniAppChatTargetKind | null } = { current: "qa" };
    const prevHadTargetsRef: { current: boolean } = { current: true };
    const lastHeightRef: { current: number } = { current: 240 };
    syncChatTargetsModalCloseReset({ isModalOpen: true, prevTabRef, prevHadTargetsRef, lastHeightRef });
    expect(prevTabRef.current).toBe("qa");

    const dialogProps = {
      state: store.getState(), snapshotState, displayModalKind: "qa" as const,
      displayChatDetail: detail, displayChatTargets: targets, displayLoadingTargets: false,
      isClosing: true, displayLangBackdropOpen: true as const, langBackdropClosing: true, t: zh,
      modalBodyRef: { current: null }, sizerRef: { current: null }, paneRef: { current: null },
      lastHeightRef, prevTabRef, prevHadTargetsRef,
      onScrollToTop: (): void => { scrollTopCalled = true; },
    };
    const closingModalHtml: string = renderToStaticMarkup(createElement(ChatTargetsModalDialog, dialogProps));
    expect(closingModalHtml).toContain('class="confirm-backdrop chat-targets-backdrop closing" role="dialog" aria-modal="true" aria-hidden="true"');
    expect(closingModalHtml).toContain('class="chat-targets-lang-backdrop closing" aria-hidden="true"');
    expect(closingModalHtml.match(/role="tab"[^>]*tabindex="-1"/gu)?.length).toBe(3);
    expect(closingModalHtml).toContain('class="btn primary icon-btn chat-targets-qa-open-btn" tabindex="-1"');
    expect(closingModalHtml).toContain('class="chat-targets-input"');
    expect(closingModalHtml).toContain('class="chat-targets-textarea"');
    expect(closingModalHtml.match(/class="btn[^"]*chat-targets-(?:submit|cancel|qa-action)-btn"[^>]*tabindex="-1"/gu)?.length).toBe(4);
    expect(closingModalHtml.match(/class="btn[^"]*chat-targets-header-disabled"/)).toBeNull();
    expect(closingModalHtml).not.toContain('disabled=""');

    // 遍历退场期 JSX 节点树，触发标签、顶部表单按钮及 QA 卡片操作按钮的 onClick，验证均被静默忽略。
    const collectElements = (node: unknown, out: React.ReactElement<Record<string, unknown>>[]): void => {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) collectElements(item, out);
        return;
      }
      const el = node as React.ReactElement<Record<string, unknown>>;
      if (typeof el.props === "object" && el.props !== null) {
        out.push(el);
        collectElements(el.props.children, out);
      }
    };
    const renderedTree: React.JSX.Element = ChatTargetsModalDialog(dialogProps);
    const elements: React.ReactElement<Record<string, unknown>>[] = [];
    collectElements(renderedTree, elements);
    for (const el of elements) {
      const cls: string = String(el.props.className ?? "");
      if (
        el.props.role === "tab" ||
        cls.includes("chat-targets-qa-open-btn") ||
        cls.includes("chat-targets-submit-btn") ||
        cls.includes("chat-targets-cancel-btn") ||
        cls.includes("chat-targets-qa-action-btn")
      ) {
        (el.props.onClick as (() => void) | undefined)?.();
      }
    }
    expect(store.getState().activeTargetsModal).toBeNull();
    expect(store.getState().qaEditorOpen).toBeFalse();
    expect(store.getState().targetAddMenuOpen).toBeFalse();
    expect(store.getState().qaEditSourceQuestion).toBeNull();
    expect(scrollTopCalled).toBeFalse();

    // 验证快速关闭后再重开时 TabHeightSizer 立即重置残留行内高度、方向类与上次记录高度。
    await withMinimalMountedDom(async (_doc: MinimalDomDoc, root: ReturnType<typeof createRoot>): Promise<void> => {
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
      const paneNode = reopenPaneRef.current as unknown as MinimalDomNode | null;
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
});

class MinimalDomNode {
  nodeType: number;
  tagName: string;
  parentNode: MinimalDomNode | null = null;
  childNodes: MinimalDomNode[] = [];
  ownerDocument: MinimalDomDoc;
  textContentValue: string = "";
  style: { height: string; overflow: string; transition: string } = { height: "", overflow: "", transition: "" };
  attributes: Map<string, string> = new Map<string, string>();
  offsetHeight: number = 0;
  constructor(nodeType: number, tagName: string, ownerDocument: MinimalDomDoc) {
    this.nodeType = nodeType;
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
  }
  get firstChild(): MinimalDomNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): MinimalDomNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): MinimalDomNode | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 && idx + 1 < this.parentNode.childNodes.length ? this.parentNode.childNodes[idx + 1]! : null;
  }
  get previousSibling(): MinimalDomNode | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx > 0 ? this.parentNode.childNodes[idx - 1]! : null;
  }
  get previousElementSibling(): MinimalDomNode | null { return this.previousSibling; }
  get nextElementSibling(): MinimalDomNode | null { return this.nextSibling; }
  setAttribute(name: string, val: string): void { this.attributes.set(name, String(val)); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  get textContent(): string { return this.textContentValue; }
  set textContent(v: string) { this.textContentValue = v ?? ""; this.childNodes = []; }
  set nodeValue(v: string) { this.textContentValue = v ?? ""; }
  get nodeValue(): string { return this.textContentValue; }
  appendChild(child: MinimalDomNode): MinimalDomNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child: MinimalDomNode, ref: MinimalDomNode | null): MinimalDomNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    if (!ref) { this.childNodes.push(child); return child; }
    const idx = this.childNodes.indexOf(ref);
    if (idx === -1) this.childNodes.push(child);
    else this.childNodes.splice(idx, 0, child);
    return child;
  }
  removeChild(child: MinimalDomNode): MinimalDomNode {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) this.childNodes.splice(idx, 1);
    child.parentNode = null;
    return child;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

class MinimalDomDoc {
  nodeType: number = 9;
  defaultView: unknown;
  documentElement: MinimalDomNode;
  body: MinimalDomNode;
  mountRoot: MinimalDomNode;
  constructor(defaultView: unknown) {
    this.defaultView = defaultView;
    this.documentElement = new MinimalDomNode(1, "HTML", this);
    this.body = new MinimalDomNode(1, "BODY", this);
    this.documentElement.appendChild(this.body);
    this.mountRoot = new MinimalDomNode(1, "DIV", this);
  }
  createElement(tag: string): MinimalDomNode { return new MinimalDomNode(1, tag.toUpperCase(), this); }
  createTextNode(text: string): MinimalDomNode {
    const node = new MinimalDomNode(3, "#text", this);
    node.textContentValue = text;
    return node;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

async function withMinimalMountedDom(
  run: (doc: MinimalDomDoc, root: ReturnType<typeof createRoot>, readText: (node: MinimalDomNode) => string) => Promise<void>
): Promise<void> {
  const readText = (node: MinimalDomNode): string =>
    node.nodeType === 3 || node.childNodes.length === 0 ? node.textContentValue : node.childNodes.map(readText).join("");
  const prevAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  const prevDoc = (globalThis as { document?: unknown }).document;
  const prevWin = (globalThis as { window?: unknown }).window;
  const mockWin = {
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    HTMLIFrameElement: class MockHTMLIFrameElement {},
  };
  const doc = new MinimalDomDoc(mockWin);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { document?: unknown }).document = doc;
  (globalThis as { window?: unknown }).window = mockWin;
  try {
    const root = createRoot(doc.mountRoot as unknown as Element);
    try {
      await run(doc, root, readText);
    } finally {
      await act(async (): Promise<void> => {
        root.unmount();
      });
    }
  } finally {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = prevAct;
    if (prevDoc === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = prevDoc;
    if (prevWin === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = prevWin;
  }
}
