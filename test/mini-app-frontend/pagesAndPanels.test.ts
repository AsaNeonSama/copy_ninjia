import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, createElement } from "react";
import type React from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatJoinCleanCard } from "../../packages/mini-app-frontend/components/ChatJoinCleanCard";
import {
  ChatTargetsMemberAddForm,
  ChatTargetsMemberPanels,
} from "../../packages/mini-app-frontend/components/ChatTargetsMemberPanels";
import { MessagesView } from "../../packages/mini-app-frontend/components/MessagesView";
import { VERBATIM_CONTEXT_MAX } from "../../packages/mini-app-frontend/consts/memory";
import {
  CHAT_QA_ANSWER_MAX_CHARS,
  CHAT_QA_MAX_PER_CHAT,
  CHAT_QA_QUESTION_MAX_CHARS,
  DELETE_MESSAGE_CHAT_TARGET_MAX,
  MINI_APP_BATCH_KICK_MAX_HOURS,
  MINI_APP_BATCH_KICK_MIN_HOURS,
  MINI_APP_BATCH_KICK_PRESET_HOURS,
  MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
  MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE,
  MINI_APP_MIN_LOADING_MS,
  MINI_APP_TRANSLATE_LANGUAGES,
  TRANSLATE_CHAT_USER_LIMIT,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { WHITELIST_PERMISSION_KEYS } from "../../packages/mini-app-frontend/consts/whitelist";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import { IdentitiesPage } from "../../packages/mini-app-frontend/pages/IdentitiesPage";
import { StatusPage } from "../../packages/mini-app-frontend/pages/StatusPage";
import { resetMiniAppStoreForTest } from "../../packages/mini-app-frontend/store/app";
import { createChatsStore } from "../../packages/mini-app-frontend/store/chats";
import type {
  MiniAppChatsStore,
  MiniAppChatsStoreState,
} from "../../packages/mini-app-frontend/store/chats";
import type { WhitelistPermissionKey } from "../../packages/mini-app-frontend/types/identityPolicy";
import type {
  MiniAppChatDetail,
  MiniAppChatTargetsView,
  MiniAppStatusView,
} from "../../packages/mini-app-frontend/types/miniApp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";

type RouteHandler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

const routes: Map<string, RouteHandler> = new Map<string, RouteHandler>();
const originalFetch: typeof fetch = globalThis.fetch;
const zh: Readonly<MiniAppTranslations> = getMiniAppTranslations("zh");

function route(key: string, handler: RouteHandler): void {
  routes.set(key, handler);
}

function jsonResponse(payload: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

class MiniDomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly tagName: string;
  parentNode: MiniDomNode | null = null;
  childNodes: MiniDomNode[] = [];
  readonly ownerDocument: MiniDomDocument;
  readonly style: Record<string, string> = {};
  readonly attributes: Map<string, string> = new Map<string, string>();
  value: string = "";
  textContentValue: string = "";
  scrollTop: number = 0;
  private readonly listeners: Map<string, Set<unknown>> = new Map<string, Set<unknown>>();

  constructor(nodeType: number, nodeName: string, ownerDocument: MiniDomDocument) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.tagName = nodeName;
    this.ownerDocument = ownerDocument;
  }

  get firstChild(): MiniDomNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): MiniDomNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): MiniDomNode | null {
    if (this.parentNode === null) return null;
    const index: number = this.parentNode.childNodes.indexOf(this);
    return index >= 0 && index + 1 < this.parentNode.childNodes.length
      ? this.parentNode.childNodes[index + 1]!
      : null;
  }
  get previousSibling(): MiniDomNode | null {
    if (this.parentNode === null) return null;
    const index: number = this.parentNode.childNodes.indexOf(this);
    return index > 0 ? this.parentNode.childNodes[index - 1]! : null;
  }
  get previousElementSibling(): MiniDomNode | null { return this.previousSibling; }
  get nextElementSibling(): MiniDomNode | null { return this.nextSibling; }
  get parentElement(): MiniDomNode | null { return this.parentNode; }
  get textContent(): string { return this.textContentValue; }
  set textContent(value: string) { this.textContentValue = value; this.childNodes = []; }
  get nodeValue(): string { return this.textContentValue; }
  set nodeValue(value: string) { this.textContentValue = value; }
  appendChild(child: MiniDomNode): MiniDomNode {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child: MiniDomNode, ref: MiniDomNode | null): MiniDomNode {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    child.parentNode = this;
    if (ref === null) {
      this.childNodes.push(child);
      return child;
    }
    const index: number = this.childNodes.indexOf(ref);
    if (index === -1) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    return child;
  }
  removeChild(child: MiniDomNode): MiniDomNode {
    const index: number = this.childNodes.indexOf(child);
    if (index !== -1) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  setAttributeNS(_ns: string, name: string, value: string): void { this.attributes.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, listener: unknown): void {
    let set: Set<unknown> | undefined = this.listeners.get(type);
    if (set === undefined) {
      set = new Set<unknown>();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }
  removeEventListener(type: string, listener: unknown): void { this.listeners.get(type)?.delete(listener); }
  scrollTo(): void {}
  contains(other: MiniDomNode | null): boolean {
    let current: MiniDomNode | null = other;
    while (current !== null) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }
  getClickListeners(): Set<unknown> | undefined {
    return this.listeners.get("click");
  }
  triggerClick(): void {
    dispatchClickBubble(this);
  }
}

function dispatchClickBubble(target: MiniDomNode): void {
  let stopped: boolean = false;
  const event: {
    type: string;
    bubbles: boolean;
    target: MiniDomNode;
    currentTarget: MiniDomNode | MiniDomDocument;
    preventDefault: () => void;
    stopPropagation: () => void;
    stopImmediatePropagation: () => void;
  } = {
    type: "click",
    bubbles: true,
    target,
    currentTarget: target,
    preventDefault(): void {},
    stopPropagation(): void {
      stopped = true;
    },
    stopImmediatePropagation(): void {
      stopped = true;
    },
  };
  let cursor: MiniDomNode | null = target;
  while (cursor !== null && !stopped) {
    event.currentTarget = cursor;
    const listeners: Set<unknown> | undefined = cursor.getClickListeners();
    if (listeners !== undefined) {
      for (const listener of listeners) {
        if (typeof listener === "function") listener(event);
      }
    }
    cursor = cursor.parentNode;
  }
  if (!stopped) {
    event.currentTarget = target.ownerDocument;
    target.ownerDocument.dispatchListeners("click", event);
  }
}

class MiniDomDocument {
  readonly nodeType: number = 9;
  readonly documentElement: MiniDomNode;
  readonly body: MiniDomNode;
  activeElement: MiniDomNode | null = null;
  readonly defaultView: unknown;
  private readonly listeners: Map<string, Set<unknown>> = new Map<string, Set<unknown>>();

  constructor(defaultView: unknown) {
    this.defaultView = defaultView;
    this.documentElement = new MiniDomNode(1, "HTML", this);
    this.body = new MiniDomNode(1, "BODY", this);
  }
  addEventListener(type: string, listener: unknown): void {
    let set: Set<unknown> | undefined = this.listeners.get(type);
    if (set === undefined) {
      set = new Set<unknown>();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }
  removeEventListener(type: string, listener: unknown): void { this.listeners.get(type)?.delete(listener); }
  dispatchListeners(type: string, event: unknown): void {
    const set: Set<unknown> | undefined = this.listeners.get(type);
    if (set === undefined) return;
    for (const listener of set) {
      if (typeof listener === "function") listener(event);
    }
  }
  createElement(tag: string): MiniDomNode { return new MiniDomNode(1, tag.toUpperCase(), this); }
  createElementNS(_ns: string, tag: string): MiniDomNode { return new MiniDomNode(1, tag, this); }
  createTextNode(text: string): MiniDomNode {
    const node: MiniDomNode = new MiniDomNode(3, "#text", this);
    node.textContentValue = text;
    return node;
  }
  createComment(text: string): MiniDomNode {
    const node: MiniDomNode = new MiniDomNode(8, "#comment", this);
    node.textContentValue = text;
    return node;
  }
}

function collectNodeText(node: MiniDomNode): string {
  if (node.nodeType === 3 || node.childNodes.length === 0) return node.textContentValue;
  return node.childNodes.map(collectNodeText).join("");
}

function findButtonByText(node: MiniDomNode, text: string): MiniDomNode | null {
  if (node.tagName === "BUTTON" && collectNodeText(node).includes(text)) return node;
  for (const child of node.childNodes) {
    const match: MiniDomNode | null = findButtonByText(child, text);
    if (match !== null) return match;
  }
  return null;
}

async function withMountedElement(
  element: React.JSX.Element,
  run: (container: MiniDomNode, flushMinLoading: () => Promise<void>) => Promise<void>
): Promise<void> {
  const prevAct: boolean | undefined = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  const prevDoc: unknown = (globalThis as { document?: unknown }).document;
  const prevWin: unknown = (globalThis as { window?: unknown }).window;
  jest.useFakeTimers();
  try {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const mockWin = {
      addEventListener: (): void => {},
      removeEventListener: (): void => {},
      getComputedStyle: (): { display: string; marginBottom: string } => ({ display: "block", marginBottom: "0px" }),
      HTMLIFrameElement: class MockHTMLIFrameElement {},
    };
    const mockDoc: MiniDomDocument = new MiniDomDocument(mockWin);
    (globalThis as { document?: unknown }).document = mockDoc;
    (globalThis as { window?: unknown }).window = mockWin;
    const container: MiniDomNode = mockDoc.createElement("div");
    const root: Root = createRoot(container as unknown as Element);

    const flushMinLoading = async (): Promise<void> => {
      await act(async (): Promise<void> => {
        for (let tick: number = 0; tick < 8; tick++) await Promise.resolve();
        jest.advanceTimersByTime(MINI_APP_MIN_LOADING_MS);
        for (let tick: number = 0; tick < 8; tick++) await Promise.resolve();
      });
    };

    try {
      await act(async (): Promise<void> => {
        root.render(element);
      });
      await run(container, flushMinLoading);
    } finally {
      await act(async (): Promise<void> => {
        root.unmount();
      });
    }
  } finally {
    jest.useRealTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = prevAct;
    (globalThis as { document?: unknown }).document = prevDoc;
    (globalThis as { window?: unknown }).window = prevWin;
  }
}

function sampleChatDetail(overrides: Partial<MiniAppChatDetail> = {}): Readonly<MiniAppChatDetail> {
  return {
    chatId: -1001,
    title: "Doro群",
    isLockdownActive: false,
    quietRemainingMs: 0,
    lockdownRemainingMs: 0,
    activeSessions: { gag: 0, wed: false, verify: 0, qaSet: false },
    hotMessageCount: 3,
    hotMessageMax: VERBATIM_CONTEXT_MAX,
    qaPairCount: 1,
    deleteMessageTargetCount: 1,
    translateTargetCount: 1,
    joinedCountsByHour: [5, 10, 12, 15, 20, 30],
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
      grantedLabels: [],
    },
    ...overrides,
  };
}

function sampleStatusView(): Readonly<MiniAppStatusView> {
  return {
    generatedAt: 1_700_000_000_000,
    uptimeMs: 60_000,
    cpuAveragePercent: 12.5,
    memoryPeakRssBytes: 64 * 1024 * 1024,
    memoryCurrentRssBytes: 48 * 1024 * 1024,
    memoryOtherBytes: 16 * 1024 * 1024,
    memoryTotalBytes: 32 * 1024 * 1024,
    memoryHeapUsedBytes: 24 * 1024 * 1024,
    managedChatCount: 2,
    whitelistCount: 3,
    blocklistCount: 1,
    activeSessions: { total: 0, gag: 0, wed: 0, verify: 0, qaSet: 0 },
    telegramOutbound: { inFlight: 0, maxConcurrency: 4, waiting: 0, retryQueueSize: 0, retryQueueMax: 10 },
    capabilities: [
      { key: "mood", label: "Mood", ready: true, detail: "ok", items: [{ label: "Current", value: "calm" }] },
    ],
  };
}

beforeEach((): void => {
  resetMiniAppStoreForTest();
  routes.clear();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawUrl: string = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url: URL = new URL(rawUrl, "http://localhost");
    const method: string = (init?.method ?? "GET").toUpperCase();
    const handler: RouteHandler | undefined = routes.get(`${method} ${url.pathname}`);
    if (handler === undefined) return jsonResponse({ error: `Unexpected ${method} ${url.pathname}` }, 500);
    return await handler(url, init);
  }) as typeof fetch;
});

afterEach((): void => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  routes.clear();
  resetMiniAppStoreForTest();
});

describe("Mini App 页面与面板组件", () => {
  test("IdentitiesPage 覆盖首屏骨架、白名单列表与切换黑名单空提示", async () => {
    const initialMarkup: string = renderToStaticMarkup(createElement(IdentitiesPage));
    expect(initialMarkup).toContain("identity-list-card");
    expect(initialMarkup).toContain("loading-box");

    route("GET /api/identities/whitelist", (): Response =>
      jsonResponse({
        items: [{
          id: 101,
          isChannel: false,
          displayName: "Alice",
          username: "alice",
          permissions: Object.fromEntries(
            WHITELIST_PERMISSION_KEYS.map((key: WhitelistPermissionKey): readonly [WhitelistPermissionKey, boolean] => [
              key,
              key === WHITELIST_PERMISSION_KEYS[0] || key === WHITELIST_PERMISSION_KEYS[2],
            ])
          ) as Record<WhitelistPermissionKey, boolean>,
        }],
        page: 1,
        pageSize: MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
        total: 1,
        totalPages: 1,
        whitelistTotal: 1,
        blocklistTotal: 0,
        nextAfterId: null,
      })
    );
    route("GET /api/identities/blocklist", (): Response =>
      jsonResponse({
        items: [],
        page: 1,
        pageSize: MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
        total: 0,
        totalPages: 1,
        whitelistTotal: 1,
        blocklistTotal: 0,
        nextAfterId: null,
      })
    );

    await withMountedElement(createElement(IdentitiesPage), async (container, flushMinLoading): Promise<void> => {
      await flushMinLoading();
      expect(collectNodeText(container)).toContain("Alice");

      const blocklistButton: MiniDomNode | null = findButtonByText(container, zh.identities.blocklistTab);
      expect(blocklistButton).not.toBeNull();
      await act(async (): Promise<void> => {
        blocklistButton!.triggerClick();
      });
      await flushMinLoading();
      expect(collectNodeText(container)).toContain(zh.identities.emptyListHint("blocklist"));
    });
  });

  test("StatusPage 覆盖骨架屏、快照子系统卡片及失败错误态", async () => {
    expect(renderToStaticMarkup(createElement(StatusPage))).toContain(zh.status.loadingText);

    route("GET /api/mood", (): Response => jsonResponse({ ok: true, available: true, currentMood: "happy" }));
    route("GET /api/status", (): Response => jsonResponse(sampleStatusView()));

    await withMountedElement(createElement(StatusPage), async (container, flushMinLoading): Promise<void> => {
      await flushMinLoading();
      const text: string = collectNodeText(container);
      expect(text).toContain(zh.status.capabilitiesSectionTitle);
      expect(text).toContain("happy");
    });

    route("GET /api/status", (): Response => jsonResponse({ error: "status unavailable" }, 500));
    await withMountedElement(createElement(StatusPage), async (container, flushMinLoading): Promise<void> => {
      await flushMinLoading();
      expect(collectNodeText(container)).toContain("status unavailable");
    });
  });

  test("MessagesView 覆盖引用转发、空媒体占位及空消息提示", async () => {
    const skeletonMarkup: string = renderToStaticMarkup(createElement(MessagesView, { chatId: -1001, onBack: (): void => {} }));
    expect(skeletonMarkup).toContain(zh.messages.headerMeta(-1001));
    expect(skeletonMarkup).toContain(String(MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE));

    route("GET /api/chats/-1001/messages", (): Response =>
      jsonResponse({
        chatId: -1001,
        title: "Doro群",
        total: 2,
        maxCapacity: VERBATIM_CONTEXT_MAX,
        page: 1,
        pageSize: MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE,
        totalPages: 1,
        items: [
          {
            index: 0,
            userId: 7,
            name: "  doro ",
            username: "doro_bot",
            text: "hello",
            at: "2026/01/01 12:00:00",
            messageId: 11,
            forwardedFrom: "NewsChannel",
            replyToMessageId: 10,
            replyToName: "Alice",
            replyToPreview: "prev text",
          },
          {
            index: 1,
            userId: 8,
            name: "   ",
            text: "",
            at: "2026/01/01 12:01:00",
            messageId: 12,
          },
        ],
      })
    );

    await withMountedElement(
      createElement(MessagesView, { chatId: -1001, onBack: (): void => {} }),
      async (container, flushMinLoading): Promise<void> => {
        await flushMinLoading();
        const text: string = collectNodeText(container);
        expect(text).toContain("Ddoro@doro_bot");
        expect(text).toContain("NewsChannel");
        expect(text).toContain("prev text");
        expect(text).toContain(zh.messages.emptyMediaPlaceholder);
      }
    );

    route("GET /api/chats/-1001/messages", (): Response =>
      jsonResponse({
        chatId: -1001,
        title: "Empty群",
        total: 0,
        maxCapacity: VERBATIM_CONTEXT_MAX,
        page: 1,
        pageSize: MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE,
        totalPages: 1,
        items: [],
      })
    );

    await withMountedElement(
      createElement(MessagesView, { chatId: -1001, onBack: (): void => {} }),
      async (container, flushMinLoading): Promise<void> => {
        await flushMinLoading();
        expect(collectNodeText(container)).toContain(zh.messages.emptyHint);
      }
    );
  });

  test("ChatJoinCleanCard 覆盖边界小时禁用、运行徽章与最近完成汇总", () => {
    const store: MiniAppChatsStore = createChatsStore();
    const snapshotStore: MiniAppChatsStore = {
      ...store,
      getInitialState: (): MiniAppChatsStoreState => store.getState(),
    };
    store.setState({ batchKickHours: MINI_APP_BATCH_KICK_MIN_HOURS, loadingWindowJoined: false });
    const idleHtml: string = renderToStaticMarkup(createElement(ChatJoinCleanCard, {
      chatDetail: sampleChatDetail({
        lastBatchKickCompletion: {
          hours: MINI_APP_BATCH_KICK_MIN_HOURS,
          recordCount: 10,
          scanned: 8,
          kicked: 6,
          absent: 1,
          protected: 1,
          blocked: 0,
          forbidden: 0,
          failed: 0,
          aborted: false,
          unmanaged: false,
          completedAt: 1_700_000_000_000,
        },
      }),
      store: snapshotStore,
    }));
    expect(idleHtml).toContain(zh.chats.batchKickTriggerButton(MINI_APP_BATCH_KICK_MIN_HOURS));
    expect(idleHtml).toContain(zh.chats.windowJoinedValue(5));
    expect(idleHtml).toContain("join-clean-result-box");
    expect(idleHtml).toContain(`${MINI_APP_BATCH_KICK_PRESET_HOURS[0]}h`);

    store.setState({ batchKickHours: MINI_APP_BATCH_KICK_MAX_HOURS, loadingWindowJoined: true });
    const runningHtml: string = renderToStaticMarkup(createElement(ChatJoinCleanCard, {
      chatDetail: sampleChatDetail({ batchKickRunning: true }),
      store: snapshotStore,
    }));
    expect(runningHtml).toContain(zh.chats.batchKickRunningBadge);
    expect(runningHtml).toContain(zh.chats.batchKickRunningButton);
    expect(runningHtml).toContain('aria-busy="true"');
  });

  test("ChatTargetsMemberPanels 与 ChatTargetsMemberAddForm 覆盖加载、空态、列表与前置权限警告", () => {
    const store: MiniAppChatsStore = createChatsStore();
    const loadingHtml: string = renderToStaticMarkup(createElement(ChatTargetsMemberPanels, {
      kind: "deleteMessage",
      chatDetail: sampleChatDetail(),
      state: store.getState(),
      t: zh,
    }));
    expect(loadingHtml).toContain("chat-targets-member-panel");

    const targets: MiniAppChatTargetsView = {
      chatId: -1001,
      qaItems: [],
      qaMax: CHAT_QA_MAX_PER_CHAT,
      qaQuestionMaxChars: CHAT_QA_QUESTION_MAX_CHARS,
      qaAnswerMaxChars: CHAT_QA_ANSWER_MAX_CHARS,
      deleteMessageTargets: [{ id: -10099, isChannel: true, displayName: "SpamCh", username: "spam_ch" }],
      deleteMessageMax: DELETE_MESSAGE_CHAT_TARGET_MAX,
      translateTargets: [{ id: 505, isChannel: false, displayName: "Bob", language: MINI_APP_TRANSLATE_LANGUAGES[0]! }],
      translateMax: TRANSLATE_CHAT_USER_LIMIT,
      isTranslationEnabled: false,
    };
    store.setState({
      loadingTargets: false,
      chatTargets: targets,
      targetAddMenuOpen: true,
      targetIdFormOpen: true,
      translateLangMenuOpen: true,
      translateTargetInput: "505",
    });

    const deleteWarnHtml: string = renderToStaticMarkup(createElement(ChatTargetsMemberPanels, {
      kind: "deleteMessage",
      chatDetail: sampleChatDetail({
        botPermissions: { canDeleteMessages: false, canRestrictMembers: true, canChangeInfo: false, grantedLabels: [] },
      }),
      state: store.getState(),
      t: zh,
    }));
    expect(deleteWarnHtml).toContain(zh.serverNotice("DELETE_TARGET_MISSING_BOT_PERMISSION"));
    expect(deleteWarnHtml).toContain("SpamCh");
    expect(deleteWarnHtml).toContain(zh.identities.channelBadge);

    const translateWarnHtml: string = renderToStaticMarkup(createElement(ChatTargetsMemberPanels, {
      kind: "translate",
      chatDetail: sampleChatDetail({ features: { ...sampleChatDetail().features, translation: false } }),
      state: store.getState(),
      t: zh,
    }));
    expect(translateWarnHtml).toContain(zh.serverNotice("TRANSLATE_FEATURE_DISABLED"));
    expect(translateWarnHtml).toContain("Bob");

    store.setState({ chatTargets: { ...targets, deleteMessageTargets: [], translateTargets: [] } });
    expect(renderToStaticMarkup(createElement(ChatTargetsMemberPanels, {
      kind: "deleteMessage",
      chatDetail: sampleChatDetail(),
      state: store.getState(),
      t: zh,
    }))).toContain(zh.chats.deleteTargetEmptyHint);
    expect(renderToStaticMarkup(createElement(ChatTargetsMemberPanels, {
      kind: "translate",
      chatDetail: sampleChatDetail(),
      state: store.getState(),
      t: zh,
    }))).toContain(zh.chats.translateTargetEmptyHint);

    const translateFormHtml: string = renderToStaticMarkup(createElement(ChatTargetsMemberAddForm, {
      kind: "translate",
      state: store.getState(),
      t: zh,
    }));
    expect(translateFormHtml).toContain('role="listbox"');
    expect(translateFormHtml).toContain(MINI_APP_TRANSLATE_LANGUAGES[0]!.toUpperCase());

    const deleteFormHtml: string = renderToStaticMarkup(createElement(ChatTargetsMemberAddForm, {
      kind: "deleteMessage",
      state: store.getState(),
      t: zh,
    }));
    expect(deleteFormHtml).toContain(zh.chats.deleteTargetAddButton);
  });
});
