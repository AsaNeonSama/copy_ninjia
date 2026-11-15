/**
 * Mini App 前端纯格式化函数、展示图标与静态组件渲染契约测试。
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import type React from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AddModeButtonList } from "../../packages/mini-app-frontend/components/AddModeButtonList";
import { ChatTargetsMenuButtonList } from "../../packages/mini-app-frontend/components/ChatTargetsMenuButtonList";
import { ChatTargetsModal } from "../../packages/mini-app-frontend/components/ChatTargetsModal";
import * as tabHeightSizerModule from "../../packages/mini-app-frontend/components/animations/TabHeightSizer";
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
import type { MiniAppIdentitiesStore } from "../../packages/mini-app-frontend/store/identities";
import type { MiniAppChatDetail, MiniAppChatTargetsView } from "../../packages/mini-app-frontend/types/miniApp";
import {
  collectNodeText,
  findElements,
  hasClass,
  inputValues,
  installMiniDom,
} from "../helpers/miniAppDom";
import type { MiniDomEnvironment, MiniDomNode } from "../helpers/miniAppDom";

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
    expect(formatUptime(0)).toBe("0m 0s");
    expect(formatUptime(-5)).toBe("0m 0s");
    expect(formatUptime(Number.NaN)).toBe("0m 0s");
    expect(formatUptime(Number.POSITIVE_INFINITY)).toBe("0m 0s");
    expect(formatUptime(90_061_000)).toBe("1d 1h 1m");
    expect(formatUptime(3_661_000)).toBe("1h 1m 1s");
    expect(formatUptime(65_000)).toBe("1m 5s");
    expect(formatMemoryMb(128.456 * 1024 * 1024)).toBe("128.46 MB");
    expect(
      buildMiniAppGalleryDownloadFileName(`${"a".repeat(64)}.PNG`, 1_792_934_567_890)
    ).toBe("1792934567.png");

    const sampleTimestampMs: number = 1_700_000_000_000;
    const midnightTimestampMs: number = new Date(2024, 0, 2, 0, 5, 9).getTime();
    expect(formatTime(0)).toBe("-");
    expect(formatTime(-1)).toBe("-");
    expect(formatTime(Number.NaN)).toBe("-");
    expect(formatTime(sampleTimestampMs)).toBe(
      new Date(sampleTimestampMs).toLocaleString("zh-CN", { hourCycle: "h23" })
    );
    expect(formatTime(sampleTimestampMs, "en")).toBe(
      new Date(sampleTimestampMs).toLocaleString("en-US", { hourCycle: "h23" })
    );
    expect(formatTime(sampleTimestampMs, "ja")).toBe(
      new Date(sampleTimestampMs).toLocaleString("ja-JP", { hourCycle: "h23" })
    );
    expect(formatClockTime(0)).toBe("-");
    expect(formatClockTime(-1)).toBe("-");
    expect(formatClockTime(Number.NaN)).toBe("-");
    expect(formatClockTime(midnightTimestampMs)).toBe("00:05:09");
    expect(formatClockTime(midnightTimestampMs, "en")).toBe("00:05:09");
    expect(formatClockTime(midnightTimestampMs, "ja")).toBe("00:05:09");
    expect(formatClockTime(sampleTimestampMs)).toBe(
      new Date(sampleTimestampMs).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
    );
    expect(formatClockTime(sampleTimestampMs, "en")).toBe(
      new Date(sampleTimestampMs).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
    );
    expect(formatClockTime(sampleTimestampMs, "ja")).toBe(
      new Date(sampleTimestampMs).toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
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
    expect(formatGalleryFileSize(0)).toBe("0.0 KiB");
    expect(formatGalleryFileSize(-10)).toBe("0.0 KiB");
    expect(formatGalleryFileSize(Number.NaN)).toBe("0.0 KiB");
    expect(formatGalleryFileSize(Number.POSITIVE_INFINITY)).toBe("0.0 KiB");
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

  test("黑白名单搜索卡片按仓库切片渲染：普通文本输入框显示仓库中的搜索草稿，不带 search 类型与防抖提示", async () => {
    const identitiesStore: MiniAppIdentitiesStore = createIdentitiesStore();
    identitiesStore.getState().setSearchInput("doro");
    const environment: MiniDomEnvironment = installMiniDom();
    try {
      const container: MiniDomNode = environment.document.createElement("div");
      const root: ReturnType<typeof createRoot> = createRoot(container as unknown as Element);
      await act(async (): Promise<void> => {
        root.render(createElement(IdentitySearchAndAddCard, { store: identitiesStore }));
      });
      const searchInputs: MiniDomNode[] = findElements(
        container,
        (element: MiniDomNode): boolean => element.tagName === "INPUT" && hasClass(element, "search-input")
      );
      expect(searchInputs).toHaveLength(1);
      expect(searchInputs[0]!.value).toBe("doro");
      // react-dom 以 DOM 属性（而非 HTML 特性）写入 input 的 type。
      expect((searchInputs[0] as MiniDomNode & { readonly type?: string }).type).toBe("text");
      expect(searchInputs[0]!.getAttribute("inputMode")).toBe("text");
      expect(searchInputs[0]!.getAttribute("lang")).toBe("");
      expect(searchInputs[0]!.getAttribute("placeholder")).toBe(getMiniAppTranslations("zh").identities.searchPlaceholder);
      expect(findElements(container, (element: MiniDomNode): boolean => hasClass(element, "debounce-status-hint"))).toHaveLength(0);
      await act(async (): Promise<void> => {
        identitiesStore.getState().setSearchInput("doro2");
      });
      expect(searchInputs[0]!.value).toBe("doro2");
      await act(async (): Promise<void> => {
        root.unmount();
      });
    } finally {
      environment.restore();
    }
  });

  test("useComponentStoreApi 与 ChatTargetsModal 细粒度订阅保持句柄稳定、草稿输入不重渲染弹窗外框且退场快照保留最新草稿", async () => {
    let sizerSpy: { mockRestore: () => void } | undefined;
    const environment: MiniDomEnvironment = installMiniDom();
    try {
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

      // 弹窗外框每次重渲染都会重渲染其直接子节点 TabHeightSizer；以它的渲染次数观测外框是否被草稿输入牵动。
      const originalTabHeightSizer: typeof tabHeightSizerModule.TabHeightSizer = tabHeightSizerModule.TabHeightSizer;
      let frameRenders: number = 0;
      sizerSpy = spyOn(tabHeightSizerModule, "TabHeightSizer").mockImplementation(
        (props: Parameters<typeof tabHeightSizerModule.TabHeightSizer>[0]): React.JSX.Element => {
          frameRenders += 1;
          return originalTabHeightSizer(props);
        }
      );

      const container: MiniDomNode = environment.document.createElement("div");
      const root: ReturnType<typeof createRoot> = createRoot(container as unknown as Element);
      await act(async (): Promise<void> => {
        root.render(createElement(HookProbe));
      });
      const frameRendersBeforeDraft: number = frameRenders;
      expect(frameRendersBeforeDraft).toBeGreaterThan(0);
      await act(async (): Promise<void> => {
        store.getState().setQaQuestionInput("latest-draft-q");
      });
      expect(inputValues(container)).toContain("latest-draft-q");
      expect(frameRenders).toBe(frameRendersBeforeDraft);
      expect(factoryCalls).toBe(1);
      expect(observedApis.every((api: MiniAppChatsStore): boolean => api === store)).toBeTrue();

      // 切群式重置在退场期间清空草稿与目标数据：退场快照仍须显示关闭前的最新草稿与问答对。
      await act(async (): Promise<void> => {
        store.setState({
          activeTargetsModal: null,
          chatTargets: null,
          qaEditorOpen: false,
          qaQuestionInput: "",
          qaAnswerInput: "",
        });
      });
      expect(inputValues(container)).toContain("latest-draft-q");
      expect(collectNodeText(container)).toContain("杂鱼早上好♡");
      await act(async (): Promise<void> => {
        root.unmount();
      });
    } finally {
      sizerSpy?.mockRestore();
      environment.restore();
    }
  });
});
