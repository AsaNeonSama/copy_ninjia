/**
 * Mini App 前端纯格式化函数、展示图标与静态组件渲染契约测试。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import type React from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AddModeButtonList } from "../../packages/mini-app-frontend/components/AddModeButtonList";
import { ChatTargetsMenuButtonList } from "../../packages/mini-app-frontend/components/ChatTargetsMenuButtonList";
import { ChatTargetsModal } from "../../packages/mini-app-frontend/components/ChatTargetsModal";
import { IdentitySearchAndAddCard } from "../../packages/mini-app-frontend/components/IdentitySearchAndAddCard";
import { IdentitySubtabsBar } from "../../packages/mini-app-frontend/components/IdentitySubtabsBar";
import { ManagedChatList } from "../../packages/mini-app-frontend/components/ManagedChatList";
import { PermissionDrawer } from "../../packages/mini-app-frontend/components/PermissionDrawer";
import { LoadingBox } from "../../packages/mini-app-frontend/components/skeletons/LoadingBox";
import { StatusOverviewCard } from "../../packages/mini-app-frontend/components/StatusOverviewCard";
import {
  computeRangeProgressPercent,
  interpolateSpringRangeValue,
  resolveAnimatedRangeStartValue,
} from "../../packages/mini-app-frontend/components/animations/useAnimatedRangeProgress";
import { VERBATIM_CONTEXT_MAX } from "../../packages/mini-app-frontend/consts/memory";
import {
  CHAT_QA_ANSWER_MAX_CHARS,
  CHAT_QA_MAX_PER_CHAT,
  CHAT_QA_QUESTION_MAX_CHARS,
  DELETE_MESSAGE_CHAT_TARGET_MAX,
  MINI_APP_BATCH_KICK_MAX_HOURS,
  MINI_APP_BATCH_KICK_MIN_HOURS,
  MINI_APP_HTML_TITLE,
  TRANSLATE_CHAT_USER_LIMIT,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { WHITELIST_PERMISSION_KEYS } from "../../packages/mini-app-frontend/consts/whitelist";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import { useComponentStoreApi } from "../../packages/mini-app-frontend/libs/componentStore";
import {
  blurEventCurrentTarget,
  buildMiniAppGalleryDownloadFileName,
  extractSelectedFilesAndReset,
  formatClockTime,
  formatGalleryFileSize,
  formatMemoryMb,
  formatTime,
  formatUptime,
  readEventTargetChecked,
  readEventTargetValue,
  sanitizeBidiText,
  shortenGalleryFileName,
  truncateDisplayText,
} from "../../packages/mini-app-frontend/libs/formatters";
import {
  ChatsSvgIcon,
  DownloadSvgIcon,
  GallerySvgIcon,
  GlobeCnSvgIcon,
  GlobeEnSvgIcon,
  GlobeJaSvgIcon,
  GlobeSvgIcon,
  IdentitiesSvgIcon,
  MenuSvgIcon,
  SearchSvgIcon,
  StatusSvgIcon,
  TrashSvgIcon,
} from "../../packages/mini-app-frontend/resource";
import { resetMiniAppStoreForTest, useMiniAppStore } from "../../packages/mini-app-frontend/store/app";
import { createChatsStore } from "../../packages/mini-app-frontend/store/chats";
import type { MiniAppChatsStore } from "../../packages/mini-app-frontend/store/chats";
import { createIdentitiesStore } from "../../packages/mini-app-frontend/store/identities";
import type { MiniAppChatDetail, MiniAppChatTargetsView } from "../../packages/mini-app-frontend/types/miniApp";

afterEach((): void => {
  resetMiniAppStoreForTest();
});

describe("Mini App 前端格式化与展示组件", () => {
  test("PermissionDrawer 与 StatusOverviewCard 按当前语言渲染权限说明、日期与资源指标", () => {
    const permissions: Record<(typeof WHITELIST_PERMISSION_KEYS)[number], boolean> = Object.fromEntries(
      WHITELIST_PERMISSION_KEYS.map((key) => [
        key,
        key === WHITELIST_PERMISSION_KEYS[0],
      ])
    ) as Record<(typeof WHITELIST_PERMISSION_KEYS)[number], boolean>;

    const permDrawerMarkup: string = renderToStaticMarkup(
      createElement(PermissionDrawer, {
        entry: { id: 1001, isChannel: false, displayName: "Alice", permissions },
        onUpdated: (): void => {},
        onClose: (): void => {},
      })
    );
    expect(permDrawerMarkup).toContain('class="perm-drawer-inline"');
    expect(permDrawerMarkup).toContain("Alice");
    expect(permDrawerMarkup).toContain(getMiniAppTranslations("zh").permissionDrawer.descriptions.isCanMute);

    useMiniAppStore.setState({ language: "en" });
    const enPermDrawerMarkup: string = renderToStaticMarkup(
      createElement(PermissionDrawer, {
        entry: { id: 42, isChannel: false, displayName: "Alice", permissions },
        onUpdated: (): void => {},
        onClose: (): void => {},
      })
    );
    expect(enPermDrawerMarkup.replaceAll("&#x27;", "'")).toContain(
      getMiniAppTranslations("en").permissionDrawer.descriptions.isCanMute
    );
    resetMiniAppStoreForTest();

    const sampleStatus = {
      generatedAt: 1_700_000_000_000,
      uptimeMs: 120_000,
      cpuAveragePercent: 0.22,
      memoryCurrentRssBytes: 64 * 1024 * 1024,
      memoryPeakRssBytes: 80 * 1024 * 1024,
      memoryHeapUsedBytes: 32 * 1024 * 1024,
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
    } as const;
    const statusOverviewHtml: string = renderToStaticMarkup(
      createElement(StatusOverviewCard, {
        t: getMiniAppTranslations("zh"),
        status: sampleStatus,
      })
    );
    expect(statusOverviewHtml).toContain('class="stat-value stat-value-active">0.22%</div>');
    expect(statusOverviewHtml).toContain('class="stat-value-active">1</span>');

    const jaStatusOverviewHtml: string = renderToStaticMarkup(
      createElement(StatusOverviewCard, {
        t: getMiniAppTranslations("ja"),
        language: "ja",
        status: sampleStatus,
      })
    );
    expect(jaStatusOverviewHtml).toContain(formatClockTime(sampleStatus.generatedAt, "ja"));
  });

  test("格式化、时间多语言、字符串清洗与展示组件渲染覆盖全枚举分支", () => {
    expect(formatUptime(90_061_000)).toBe("1d 1h 1m");
    expect(formatUptime(3_661_000)).toBe("1h 1m 1s");
    expect(formatUptime(65_000)).toBe("1m 5s");
    expect(formatMemoryMb(128.456 * 1024 * 1024)).toBe("128.46 MB");
    expect(
      buildMiniAppGalleryDownloadFileName(`${"a".repeat(64)}.PNG`, 1_792_934_567_890)
    ).toBe("1792934567.png");

    const sampleTimestampMs: number = 1_700_000_000_000;
    expect(formatTime(0)).toBe("-");
    expect(formatTime(-1)).toBe("-");
    expect(formatTime(Number.NaN)).toBe("-");
    expect(formatTime(sampleTimestampMs)).toBe(
      new Date(sampleTimestampMs).toLocaleString("zh-CN", { hour12: false })
    );
    expect(formatTime(sampleTimestampMs, "en")).toBe(
      new Date(sampleTimestampMs).toLocaleString("en-US", { hour12: false })
    );
    expect(formatTime(sampleTimestampMs, "ja")).toBe(
      new Date(sampleTimestampMs).toLocaleString("ja-JP", { hour12: false })
    );
    expect(formatClockTime(0)).toBe("-");
    expect(formatClockTime(-1)).toBe("-");
    expect(formatClockTime(Number.NaN)).toBe("-");
    expect(formatClockTime(sampleTimestampMs)).toBe(
      new Date(sampleTimestampMs).toLocaleTimeString("zh-CN", { hour12: false })
    );
    expect(formatClockTime(sampleTimestampMs, "en")).toBe(
      new Date(sampleTimestampMs).toLocaleTimeString("en-US", { hour12: false })
    );
    expect(formatClockTime(sampleTimestampMs, "ja")).toBe(
      new Date(sampleTimestampMs).toLocaleTimeString("ja-JP", { hour12: false })
    );
    expect(formatClockTime(sampleTimestampMs)).toMatch(/^\d{2}:\d{2}:\d{2}$/u);

    expect(computeRangeProgressPercent(MINI_APP_BATCH_KICK_MIN_HOURS, MINI_APP_BATCH_KICK_MIN_HOURS, MINI_APP_BATCH_KICK_MAX_HOURS)).toBe("0.00%");
    expect(computeRangeProgressPercent(MINI_APP_BATCH_KICK_MAX_HOURS, MINI_APP_BATCH_KICK_MIN_HOURS, MINI_APP_BATCH_KICK_MAX_HOURS)).toBe("100.00%");
    expect(computeRangeProgressPercent((MINI_APP_BATCH_KICK_MIN_HOURS + MINI_APP_BATCH_KICK_MAX_HOURS) / 2, MINI_APP_BATCH_KICK_MIN_HOURS, MINI_APP_BATCH_KICK_MAX_HOURS)).toBe("50.00%");

    for (const icon of [
      MenuSvgIcon({}), StatusSvgIcon({}), ChatsSvgIcon({}), IdentitiesSvgIcon({}),
      GallerySvgIcon({}), GlobeCnSvgIcon({}), GlobeJaSvgIcon({}), GlobeEnSvgIcon({}),
      GlobeSvgIcon({}), DownloadSvgIcon({}), SearchSvgIcon({}), TrashSvgIcon({}),
    ]) {
      expect(icon).toBeDefined();
    }

    expect(sanitizeBidiText("\u202EDoro\u202C")).toBe("Doro");
    expect(truncateDisplayText("短名称", 20)).toBe("短名称");
    expect(truncateDisplayText("😀😀", 2)).toBe("😀😀");
    expect(truncateDisplayText("😀😀😀", 2)).toBe("😀😀…");
    expect(truncateDisplayText("A\uD800B", 2)).toBe("A\uD800…");
    expect(truncateDisplayText("\uD800BC", 2)).toBe("\uD800B…");
    expect(truncateDisplayText("😀BC", 0)).toBe("😀…");
    expect(truncateDisplayText("😀BC", 1)).toBe("😀…");
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

    expect(readEventTargetValue({ currentTarget: { value: "杂鱼" } })).toBe("杂鱼");
    expect(readEventTargetChecked({ currentTarget: { checked: true } })).toBeTrue();
    let blurred: boolean = false;
    blurEventCurrentTarget({ currentTarget: { blur: (): void => { blurred = true; } } });
    expect(blurred).toBeTrue();
    expect(extractSelectedFilesAndReset({ currentTarget: { value: "", files: null } })).toEqual([]);
    const fileInputTarget: { value: string; files: File[] } = {
      value: "C:\\fakepath\\a.png",
      files: [new File(["x"], "a.png", { type: "image/png" })],
    };
    expect(extractSelectedFilesAndReset({ currentTarget: fileInputTarget })).toHaveLength(1);
    expect(fileInputTarget.value).toBe("");

    expect(interpolateSpringRangeValue(MINI_APP_BATCH_KICK_MIN_HOURS, 6, 0.72)).toBeGreaterThan(6);
    expect(interpolateSpringRangeValue(MINI_APP_BATCH_KICK_MIN_HOURS, 6, 1)).toBe(6);
    expect(interpolateSpringRangeValue(12, MINI_APP_BATCH_KICK_MAX_HOURS, 0.72)).toBeLessThan(MINI_APP_BATCH_KICK_MAX_HOURS);
    expect(interpolateSpringRangeValue(12, MINI_APP_BATCH_KICK_MAX_HOURS, 1)).toBe(MINI_APP_BATCH_KICK_MAX_HOURS);
    expect(interpolateSpringRangeValue(6, MINI_APP_BATCH_KICK_MIN_HOURS, 0.72)).toBeGreaterThan(MINI_APP_BATCH_KICK_MIN_HOURS);
    expect(interpolateSpringRangeValue(6, MINI_APP_BATCH_KICK_MIN_HOURS, 1)).toBe(MINI_APP_BATCH_KICK_MIN_HOURS);
    expect(resolveAnimatedRangeStartValue(5.9, 5, 6)).toBeLessThanOrEqual(5.65);
    expect(resolveAnimatedRangeStartValue(5.1, 6, 5)).toBeGreaterThanOrEqual(5.45);

    expect(MINI_APP_HTML_TITLE).toBe(getMiniAppTranslations("zh").appTitle);
    expect(getMiniAppTranslations("zh").appTitle).toBe("杂鱼控制台♡");
    expect(getMiniAppTranslations("en").appTitle).toBe("Zaako Console♡");
    expect(getMiniAppTranslations("ja").appTitle).toBe("雑魚コンソール♡");

    const addModeHtml: string = renderToStaticMarkup(createElement(AddModeButtonList, {
      idFormOpen: true, disabled: false, interactive: true, t: getMiniAppTranslations("zh"), onSelectMode: (): void => undefined,
    }));
    expect(addModeHtml).toContain("add-mode-grid");
    const targetsMenuHtml: string = renderToStaticMarkup(createElement(ChatTargetsMenuButtonList, {
      targetsMenuOpen: true, chatDetail: null, chatTargets: null, t: getMiniAppTranslations("zh"),
      onToggleMenu: (): void => undefined, onCloseMenu: (): void => undefined, onSelectTargetKind: (): void => undefined,
    }));
    expect(targetsMenuHtml).toContain("chat-targets-dropdown");
    const subtabsHtml: string = renderToStaticMarkup(createElement(IdentitySubtabsBar, {
      subTab: "whitelist", loadingList: false, t: getMiniAppTranslations("zh"), onSelectSubTab: (): void => undefined, onRefresh: (): void => undefined,
    }));
    expect(subtabsHtml).toContain("subtabs-bar");
    const identitiesStore = createIdentitiesStore();
    identitiesStore.getState().setSearchInput("doro");
    const searchCardHtml: string = renderToStaticMarkup(createElement(IdentitySearchAndAddCard, { state: identitiesStore.getState() }));
    expect(searchCardHtml).toContain('type="text" inputMode="text" lang="" class="search-input" placeholder="id/name" value="doro"');
    expect(searchCardHtml).not.toContain('type="search"');
    expect(searchCardHtml).not.toContain("debounce-status-hint");
    const loadingBoxHtml: string = renderToStaticMarkup(createElement(LoadingBox, { children: createElement("div", { className: "skeleton-line" }) }));
    expect(loadingBoxHtml).toContain('class="loading-box" aria-hidden="true"');
    expect(loadingBoxHtml).toContain('class="skeleton-stack"');
    expect(loadingBoxHtml).not.toContain("loading-text");
    const chatListHtml: string = renderToStaticMarkup(createElement(ManagedChatList, {
      chats: [{
        chatId: -1001, title: "群A", isLockdownActive: true, hotMessageCount: 3, qaPairCount: 2,
        features: { init: true, aiChat: false, translation: false, adDetect: false, floodControl: false, antiRaid: false, proxySend: true },
      }],
      t: getMiniAppTranslations("zh"), onSelectChat: (): void => undefined,
    }));
    expect(chatListHtml).toContain('class="row identity-row"');
    expect(chatListHtml).toContain('class="identity-title-row"');
    expect(chatListHtml).toContain('class="toolbar-actions identity-row-actions"');
    expect(chatListHtml).not.toContain("interactive-card");
  });

  test("useComponentStoreApi 与 ChatTargetsModal 细粒度订阅保持句柄稳定、草稿输入不重渲染弹窗外框且退场快照保留最新草稿", async () => {
    class MockDomNode {
      nodeType: number;
      nodeName: string;
      tagName: string;
      parentNode: MockDomNode | null = null;
      childNodes: MockDomNode[] = [];
      ownerDocument: MockDomDoc;
      style: Record<string, string> = {};
      attributes = new Map<string, string>();
      value: string = "";
      textContentValue: string = "";
      scrollTop: number = 0;
      private listeners = new Map<string, Set<unknown>>();

      constructor(nodeType: number, nodeName: string, ownerDocument: MockDomDoc) {
        this.nodeType = nodeType;
        this.nodeName = nodeName;
        this.tagName = nodeName;
        this.ownerDocument = ownerDocument;
      }

      get firstChild(): MockDomNode | null { return this.childNodes[0] ?? null; }
      get lastChild(): MockDomNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
      get nextSibling(): MockDomNode | null {
        if (!this.parentNode) return null;
        const idx: number = this.parentNode.childNodes.indexOf(this);
        return idx >= 0 && idx + 1 < this.parentNode.childNodes.length ? this.parentNode.childNodes[idx + 1]! : null;
      }
      get previousSibling(): MockDomNode | null {
        if (!this.parentNode) return null;
        const idx: number = this.parentNode.childNodes.indexOf(this);
        return idx > 0 ? this.parentNode.childNodes[idx - 1]! : null;
      }
      get previousElementSibling(): MockDomNode | null { return this.previousSibling; }
      get nextElementSibling(): MockDomNode | null { return this.nextSibling; }
      get parentElement(): MockDomNode | null { return this.parentNode; }
      get textContent(): string { return this.textContentValue; }
      set textContent(v: string) { this.textContentValue = v ?? ""; this.childNodes = []; }
      set nodeValue(v: string) { this.textContentValue = v ?? ""; }
      get nodeValue(): string { return this.textContentValue; }
      appendChild(child: MockDomNode): MockDomNode {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.childNodes.push(child);
        return child;
      }
      insertBefore(child: MockDomNode, ref: MockDomNode | null): MockDomNode {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        if (!ref) { this.childNodes.push(child); return child; }
        const idx: number = this.childNodes.indexOf(ref);
        if (idx === -1) this.childNodes.push(child);
        else this.childNodes.splice(idx, 0, child);
        return child;
      }
      removeChild(child: MockDomNode): MockDomNode {
        const idx: number = this.childNodes.indexOf(child);
        if (idx !== -1) this.childNodes.splice(idx, 1);
        child.parentNode = null;
        return child;
      }
      setAttribute(name: string, val: string): void { this.attributes.set(name, String(val)); }
      removeAttribute(name: string): void { this.attributes.delete(name); }
      setAttributeNS(_ns: string, name: string, val: string): void { this.attributes.set(name, String(val)); }
      getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
      addEventListener(type: string, fn: unknown): void {
        let set = this.listeners.get(type);
        if (!set) { set = new Set(); this.listeners.set(type, set); }
        set.add(fn);
      }
      removeEventListener(type: string, fn: unknown): void { this.listeners.get(type)?.delete(fn); }
      scrollTo(): void {}
      contains(other: MockDomNode | null): boolean {
        let cur: MockDomNode | null = other;
        while (cur) { if (cur === this) return true; cur = cur.parentNode; }
        return false;
      }
    }

    class MockDomDoc {
      nodeType: number = 9;
      documentElement: MockDomNode;
      body: MockDomNode;
      activeElement: MockDomNode | null = null;
      defaultView: unknown;
      private listeners = new Map<string, Set<unknown>>();

      constructor(defaultView: unknown) {
        this.defaultView = defaultView;
        this.documentElement = new MockDomNode(1, "HTML", this);
        this.body = new MockDomNode(1, "BODY", this);
      }
      addEventListener(type: string, fn: unknown): void {
        let set = this.listeners.get(type);
        if (!set) { set = new Set(); this.listeners.set(type, set); }
        set.add(fn);
      }
      removeEventListener(type: string, fn: unknown): void { this.listeners.get(type)?.delete(fn); }
      createElement(tag: string): MockDomNode { return new MockDomNode(1, tag.toUpperCase(), this); }
      createElementNS(_ns: string, tag: string): MockDomNode { return new MockDomNode(1, tag, this); }
      createTextNode(text: string): MockDomNode {
        const node = new MockDomNode(3, "#text", this);
        node.textContentValue = text;
        return node;
      }
      createComment(text: string): MockDomNode {
        const node = new MockDomNode(8, "#comment", this);
        node.textContentValue = text;
        return node;
      }
    }

    const findInputValues = (node: MockDomNode, out: string[] = []): string[] => {
      if (node.tagName === "INPUT" && node.value.length > 0) out.push(node.value);
      for (const child of node.childNodes) findInputValues(child, out);
      return out;
    };

    const prevAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    const prevDoc = (globalThis as { document?: unknown }).document;
    const prevWin = (globalThis as { window?: unknown }).window;

    try {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const mockWin = {
        addEventListener: (): void => {},
        removeEventListener: (): void => {},
        getComputedStyle: (): { display: string; marginBottom: string } => ({ display: "block", marginBottom: "0px" }),
        HTMLIFrameElement: class MockHTMLIFrameElement {},
      };
      const mockDoc = new MockDomDoc(mockWin);
      (globalThis as { document?: unknown }).document = mockDoc;
      (globalThis as { window?: unknown }).window = mockWin;

      const store: MiniAppChatsStore = createChatsStore();
      const detail: Readonly<MiniAppChatDetail> = {
        chatId: -1001, title: "Doro群", isLockdownActive: false, quietRemainingMs: 0, lockdownRemainingMs: 0,
        activeSessions: { gag: 0, wed: false, verify: 0, qaSet: false },
        hotMessageCount: 0, hotMessageMax: VERBATIM_CONTEXT_MAX,
        qaPairCount: 1, deleteMessageTargetCount: 0, translateTargetCount: 0,
        joinedCountsByHour: [], batchKickRunning: false, lastBatchKickCompletion: null,
        features: { init: true, aiChat: true, translation: true, adDetect: false, floodControl: false, antiRaid: false, proxySend: false },
        botPermissions: null,
      };
      const targets: Readonly<MiniAppChatTargetsView> = {
        chatId: -1001,
        qaItems: [{ q: "早上好", a: "杂鱼早上好♡" }],
        qaMax: CHAT_QA_MAX_PER_CHAT,
        qaQuestionMaxChars: CHAT_QA_QUESTION_MAX_CHARS,
        qaAnswerMaxChars: CHAT_QA_ANSWER_MAX_CHARS,
        deleteMessageTargets: [],
        deleteMessageMax: DELETE_MESSAGE_CHAT_TARGET_MAX,
        translateTargets: [],
        translateMax: TRANSLATE_CHAT_USER_LIMIT,
        isTranslationEnabled: true,
      };
      store.setState({
        selectedChatId: -1001,
        chatDetail: detail,
        chatTargets: targets,
        loadingTargets: false,
        activeTargetsModal: "qa",
        qaEditorOpen: true,
      });

      const observedApis: MiniAppChatsStore[] = [];
      let factoryCalls: number = 0;
      const HookProbe = (): React.JSX.Element => {
        const api: MiniAppChatsStore = useComponentStoreApi((): MiniAppChatsStore => {
          factoryCalls += 1;
          return store;
        });
        observedApis.push(api);
        return createElement(ChatTargetsModal, { store: api });
      };

      const container = mockDoc.createElement("div");
      const root = createRoot(container as unknown as Element);
      await act(async (): Promise<void> => {
        root.render(createElement(HookProbe));
      });
      await act(async (): Promise<void> => {
        store.getState().setQaQuestionInput("latest-draft-q");
      });
      expect(findInputValues(container)).toContain("latest-draft-q");
      expect(factoryCalls).toBe(1);
      expect(observedApis.every((api: MiniAppChatsStore): boolean => api === store)).toBeTrue();

      // 关闭弹窗时，退场快照应保留弹窗外框未重渲染期间刚输入的最新草稿。
      await act(async (): Promise<void> => {
        store.getState().closeTargetsModal();
      });
      expect(findInputValues(container)).toContain("latest-draft-q");
      await act(async (): Promise<void> => {
        root.unmount();
      });
    } finally {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = prevAct;
      if (prevDoc === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document?: unknown }).document = prevDoc;
      if (prevWin === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = prevWin;
    }
  });
});
