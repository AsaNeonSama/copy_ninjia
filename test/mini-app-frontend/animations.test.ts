/**
 * Mini App 前端名单弹窗 Tab 切换亚像素高度与方向过渡、平行四边形与异形多边形骨架屏、电流感刷新电弧扫描、
 * 按钮内水平三点加载块、QA 问答对卡片结构、权限抽屉、平行四边形拦截诊断页、认证门控（含错误折叠与锁定态顶层同级 Toast）、
 * 根组件常驻确认弹窗与连续序号重播、受管群页跨视图保活名单弹窗与验证器页面渲染，以及侧栏/弹窗纯合成层无缩放过渡、
 * 退场专用缓动曲线、一体式卡片恒定底边框、平行四边形/异形切角按钮与门控卡片几何规则、暗色多层对比令牌与响应式断点核验。
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../../packages/mini-app-frontend/App";
import { LoadingDotsWave } from "../../packages/mini-app-frontend/components/animations/LoadingDotsWave";
import {
  formatTabHeightTransition,
  readElementBodyHeight,
  resolveTabSlideDirectionClass,
  syncTabHeightTransitionEffect,
  TabHeightSizer,
} from "../../packages/mini-app-frontend/components/animations/TabHeightSizer";
import type { MeasurableBodyElement } from "../../packages/mini-app-frontend/components/animations/TabHeightSizer";
import { CapabilityBlock } from "../../packages/mini-app-frontend/components/CapabilityBlock";
import { ChatFeatureListCard } from "../../packages/mini-app-frontend/components/ChatFeatureListCard";
import { ChatTargetsModal } from "../../packages/mini-app-frontend/components/ChatTargetsModal";
import { ConfirmModal } from "../../packages/mini-app-frontend/components/ConfirmModal";
import { PermissionDrawer } from "../../packages/mini-app-frontend/components/PermissionDrawer";
import { Toast } from "../../packages/mini-app-frontend/components/Toast";
import { ChatDetailSkeleton } from "../../packages/mini-app-frontend/components/skeletons/ChatDetailSkeleton";
import { ChatTargetsListSkeleton } from "../../packages/mini-app-frontend/components/skeletons/ChatTargetsListSkeleton";
import { GalleryImageSkeleton } from "../../packages/mini-app-frontend/components/skeletons/GalleryImageSkeleton";
import { ListSkeletonRows } from "../../packages/mini-app-frontend/components/skeletons/ListSkeletonRows";
import { LoadingBox } from "../../packages/mini-app-frontend/components/skeletons/LoadingBox";
import { MessageSkeletonRows } from "../../packages/mini-app-frontend/components/skeletons/MessageSkeletonRows";
import { StatusSkeleton } from "../../packages/mini-app-frontend/components/skeletons/StatusSkeleton";
import { TotpSkeleton } from "../../packages/mini-app-frontend/components/skeletons/TotpSkeleton";
import {
  MINI_APP_INLINE_NOTICE_GRID_CLASS_NAME,
  MINI_APP_TAB_HEIGHT_TRANSITION,
} from "../../packages/mini-app-frontend/consts/animation";
import { VERBATIM_CONTEXT_MAX } from "../../packages/mini-app-frontend/consts/memory";
import {
  CHAT_QA_ANSWER_MAX_CHARS,
  CHAT_QA_MAX_PER_CHAT,
  CHAT_QA_QUESTION_MAX_CHARS,
  DELETE_MESSAGE_CHAT_TARGET_MAX,
  MINI_APP_DARK_BG_COLOR,
  MINI_APP_DARK_HEADER_COLOR,
  MINI_APP_FEATURE_KEYS,
  MINI_APP_FLIP_COLLAPSE_EASING_POINTS,
  MINI_APP_STATUS_SKELETON_CAPABILITY_INDICES,
  MINI_APP_STATUS_SKELETON_MEMORY_INDICES,
  MINI_APP_TAB_HEIGHT_CLEANUP_MS,
  MINI_APP_TAB_HEIGHT_TRANSITION_MS,
  MINI_APP_TARGETS_SKELETON_ROW_INDICES,
  TRANSLATE_CHAT_USER_LIMIT,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { WHITELIST_PERMISSION_KEYS } from "../../packages/mini-app-frontend/consts/whitelist";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import { AccessDeniedPage } from "../../packages/mini-app-frontend/pages/AccessDeniedPage";
import { AuthGatePage } from "../../packages/mini-app-frontend/pages/AuthGatePage";
import { ChatsPage } from "../../packages/mini-app-frontend/pages/ChatsPage";
import { GalleryPage } from "../../packages/mini-app-frontend/pages/GalleryPage";
import { TotpPage } from "../../packages/mini-app-frontend/pages/TotpPage";
import { resetMiniAppStoreForTest, useMiniAppStore } from "../../packages/mini-app-frontend/store/app";
import { createChatsStore } from "../../packages/mini-app-frontend/store/chats";
import type { MiniAppChatsStoreState } from "../../packages/mini-app-frontend/store/chats";
import { createGalleryStore } from "../../packages/mini-app-frontend/store/gallery";
import { createPermissionDrawerStore } from "../../packages/mini-app-frontend/store/permissionDrawer";
import { createTotpStore } from "../../packages/mini-app-frontend/store/totp";
import type { MiniAppChatTargetKind } from "../../packages/mini-app-frontend/types/miniApp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";

describe("名单弹窗、抽屉与验证器渲染及样式核验", () => {
  test("名单弹窗 Tab 切换方向、顶层同级挂载与 QA 问答对 / 删发言对象 / 翻译对象面板渲染", () => {
    expect(resolveTabSlideDirectionClass(null, "qa")).toBe("");
    expect(resolveTabSlideDirectionClass("qa", "qa")).toBe("");
    expect(resolveTabSlideDirectionClass("qa", "deleteMessage")).toBe("tab-slide-forward");
    expect(resolveTabSlideDirectionClass("qa", "translate")).toBe("tab-slide-forward");
    expect(resolveTabSlideDirectionClass("deleteMessage", "translate")).toBe("tab-slide-forward");
    expect(resolveTabSlideDirectionClass("translate", "deleteMessage")).toBe("tab-slide-backward");
    expect(resolveTabSlideDirectionClass("translate", "qa")).toBe("tab-slide-backward");
    expect(resolveTabSlideDirectionClass("deleteMessage", "qa")).toBe("tab-slide-backward");

    const mockTargets = {
      chatId: -1001,
      qaItems: [{ q: "早上好", a: "杂鱼早上好♡" }],
      qaMax: CHAT_QA_MAX_PER_CHAT,
      qaQuestionMaxChars: CHAT_QA_QUESTION_MAX_CHARS,
      qaAnswerMaxChars: CHAT_QA_ANSWER_MAX_CHARS,
      deleteMessageTargets: [{ id: 7001, isChannel: false, displayName: "Alice" }],
      deleteMessageMax: DELETE_MESSAGE_CHAT_TARGET_MAX,
      translateTargets: [{ id: -10099, isChannel: true, displayName: "NewsChannel", language: "ja" }],
      translateMax: TRANSLATE_CHAT_USER_LIMIT,
      isTranslationEnabled: true,
    } as const;
    const mockDetail = {
      chatId: -1001, title: "Doro群", isLockdownActive: false, quietRemainingMs: 0, lockdownRemainingMs: 0,
      activeSessions: { gag: 0, wed: false, verify: 0, qaSet: false },
      hotMessageCount: 0, hotMessageMax: VERBATIM_CONTEXT_MAX,
      qaPairCount: 1, deleteMessageTargetCount: 1, translateTargetCount: 1,
      joinedCountsByHour: [], batchKickRunning: false, lastBatchKickCompletion: null,
      features: { init: true, aiChat: true, translation: true, adDetect: false, floodControl: false, antiRaid: false, proxySend: false },
      botPermissions: null,
    } as const;
    const chatsStore = createChatsStore();
    (chatsStore as { getInitialState: typeof chatsStore.getState }).getInitialState = chatsStore.getState;
    const baseChatState: MiniAppChatsStoreState = {
      ...chatsStore.getState(), selectedChatId: -1001, chatDetail: mockDetail, chatTargets: mockTargets,
      loadingTargets: false, mutatingTargets: false, qaEditorOpen: false, qaQuestionInput: "", qaAnswerInput: "",
      targetAddMenuOpen: false, targetIdFormOpen: false, deleteTargetInput: "", translateTargetInput: "",
      translateLanguageInput: "cn", translateLangMenuOpen: true,
    };
    const renderModal = (patch: Partial<MiniAppChatsStoreState>): string => {
      chatsStore.setState({ ...baseChatState, ...patch });
      return renderToStaticMarkup(createElement(ChatTargetsModal, { store: chatsStore }));
    };

    const qaModalHtml: string = renderModal({ activeTargetsModal: "qa" });
    for (const token of [
      'role="tablist"',
      "chat-targets-qa-head",
      "chat-targets-qa-q-badge",
      "chat-targets-qa-a-badge",
      "早上好",
      "杂鱼早上好♡",
    ]) {
      expect(qaModalHtml).toContain(token);
    }

    // 验证 ChatsPage 群详情页将固定定位的 ChatTargetsModal 挂载在 <section class="animate-fade-in"> 外部同级
    chatsStore.setState({ ...baseChatState, activeTargetsModal: "qa" });
    const chatDetailMarkup: string = renderToStaticMarkup(
      createElement(ChatsPage, { storeFactory: () => chatsStore })
    );
    const modalBackdropStart: number = chatDetailMarkup.indexOf('<div class="confirm-backdrop chat-targets-backdrop ');
    expect(modalBackdropStart).toBeGreaterThan(0);
    const beforeModalMarkup: string = chatDetailMarkup.slice(0, modalBackdropStart);
    expect(beforeModalMarkup.startsWith('<section class="animate-fade-in">')).toBeTrue();
    expect(beforeModalMarkup.endsWith("</section>")).toBeTrue();

    // 验证 ChatsPage 切换至热发言记录或退回群列表时顶层持续同级挂载 ChatTargetsModal
    chatsStore.setState({ ...baseChatState, viewingMessages: true, activeTargetsModal: "qa" });
    const messagesWithModalMarkup: string = renderToStaticMarkup(
      createElement(ChatsPage, { storeFactory: () => chatsStore })
    );
    expect(messagesWithModalMarkup).toContain('<div class="confirm-backdrop chat-targets-backdrop ');
    expect(messagesWithModalMarkup).toContain("chat-targets-modal");

    chatsStore.setState({ ...baseChatState, selectedChatId: null, activeTargetsModal: "qa" });
    const listWithModalMarkup: string = renderToStaticMarkup(
      createElement(ChatsPage, { storeFactory: () => chatsStore })
    );
    expect(listWithModalMarkup).toContain('<div class="confirm-backdrop chat-targets-backdrop ');
    expect(listWithModalMarkup).toContain("chat-targets-modal");
    chatsStore.setState({ ...baseChatState, activeTargetsModal: null });

    // 验证 QA 问答对编辑提交期间（mutatingTargets: true, loadingTargets: false）保留现有列表与编辑表单，不渲染列表骨架屏
    const qaMutatingModalHtml: string = renderModal({
      activeTargetsModal: "qa",
      qaEditorOpen: true,
      qaQuestionInput: "晚安",
      qaAnswerInput: "好梦♡",
      loadingTargets: false,
      mutatingTargets: true,
    });
    expect(qaMutatingModalHtml).toContain("chat-targets-qa-collapse-grid expanded");
    expect(qaMutatingModalHtml).toContain("chat-targets-qa-trigger-collapse collapsed");
    expect(qaMutatingModalHtml).toContain("早上好");
    expect(qaMutatingModalHtml).not.toContain("skeleton-list-card");

    const deleteModalHtml: string = renderModal({ activeTargetsModal: "deleteMessage" });
    expect(deleteModalHtml).toContain("Alice");
    expect(deleteModalHtml).toContain("identity-user-badge");

    const translateModalHtml: string = renderModal({
      activeTargetsModal: "translate",
      targetIdFormOpen: true,
    });
    expect(translateModalHtml).toContain("NewsChannel");
    expect(translateModalHtml).toContain("identity-channel-badge");
    expect(translateModalHtml).toContain("chat-targets-lang-popover");

    const sizerHtml: string = renderToStaticMarkup(
      createElement(TabHeightSizer, {
        activeTab: "translate",
        hasTargets: true,
        sizerRef: { current: null },
        paneRef: { current: null },
        lastHeightRef: { current: 180 },
        prevTabRef: { current: "qa" },
        prevHadTargetsRef: { current: true },
        children: createElement("div", null, "body"),
      })
    );
    expect(sizerHtml).toContain("chat-targets-body-sizer");
    expect(sizerHtml).toContain("chat-targets-tab-pane tab-slide-forward");

    const zh: Readonly<MiniAppTranslations> = getMiniAppTranslations("zh");
    const featureBusyHtml: string = renderToStaticMarkup(
      createElement(ChatFeatureListCard, {
        chatDetail: mockDetail,
        togglingFeature: "aiChat",
        language: "zh",
        t: zh,
        onToggleFeature: async (): Promise<void> => undefined,
      })
    );
    expect(featureBusyHtml.match(/skeleton-switch-row is-loading/g)?.length).toBe(1);
    expect(featureBusyHtml.match(/skeleton-switch-pill/g)?.length).toBe(1);
    expect(featureBusyHtml.match(/type="checkbox"/g)?.length).toBe(MINI_APP_FEATURE_KEYS.length - 1);

    const renderMoodCap = (switchingMood: boolean): string =>
      renderToStaticMarkup(
        createElement(CapabilityBlock, {
          capability: {
            key: "mood",
            label: "AI 情绪池",
            ready: true,
            detail: "2 项",
            items: [{ label: "傲娇", value: "哼" }],
          },
          t: zh,
          isExpanded: true,
          onToggleCapability: (): void => undefined,
          currentMood: "傲娇",
          switchingMood,
          onSwitchMood: (): void => undefined,
          followScrollSlotRef: { current: null },
        })
      );

    const moodCapHtml: string = renderMoodCap(false);
    expect(moodCapHtml).toContain('class="btn mood-switch-btn "');
    expect(moodCapHtml).not.toContain("btn primary mood-switch-btn");

    const moodSwitchingHtml: string = renderMoodCap(true);
    expect(moodSwitchingHtml).toContain('class="btn mood-switch-btn is-loading"');
    expect(moodSwitchingHtml).toContain("join-clean-loading-dots loading-dots-wave");
  });

  test("权限抽屉卡片：切换单项仅单个选项播放骨架，切换全部时全部 18 项播放骨架，已全开时点击全开提示已全开", () => {
    resetMiniAppStoreForTest();
    const zh: Readonly<MiniAppTranslations> = getMiniAppTranslations("zh");
    const store = createPermissionDrawerStore((): void => undefined);
    (store as { getInitialState: typeof store.getState }).getInitialState = store.getState;
    const partialPermissions = Object.fromEntries(
      WHITELIST_PERMISSION_KEYS.map((key, index) => [key, index === 0])
    ) as never;
    const fullPermissions = Object.fromEntries(
      WHITELIST_PERMISSION_KEYS.map((key) => [key, true])
    ) as never;
    const partialEntry = {
      id: 5,
      isChannel: false,
      displayName: "Doro",
      permissions: partialPermissions,
    };
    const renderDrawer = (): string =>
      renderToStaticMarkup(
        createElement(PermissionDrawer, {
          entry: partialEntry,
          onUpdated: (): void => undefined,
          onClose: (): void => undefined,
          storeFactory: () => store,
        })
      );

    store.setState({ busyKey: WHITELIST_PERMISSION_KEYS[0]! });
    const singleBusyMarkup: string = renderDrawer();
    expect(singleBusyMarkup.match(/perm-chip is-loading/g)?.length).toBe(1);
    expect(singleBusyMarkup.match(/perm-chip-skeleton-switch/g)?.length).toBe(1);
    expect(singleBusyMarkup.match(/type="checkbox"/g)?.length).toBe(WHITELIST_PERMISSION_KEYS.length - 1);

    store.setState({ busyKey: "all" });
    const allBusyMarkup: string = renderDrawer();
    expect(allBusyMarkup.match(/perm-chip is-loading/g)?.length).toBe(WHITELIST_PERMISSION_KEYS.length);
    expect(allBusyMarkup.match(/perm-chip-skeleton-switch/g)?.length).toBe(WHITELIST_PERMISSION_KEYS.length);
    expect(allBusyMarkup.match(/type="checkbox"/g) ?? []).toHaveLength(0);
    store.setState({ busyKey: null });

    let capturedEnableAllClick: (() => void) | undefined;
    const ClickCaptureProbe = (): ReturnType<typeof createElement> => {
      const tree = PermissionDrawer({
        entry: { ...partialEntry, permissions: fullPermissions },
        onUpdated: (): void => undefined,
        onClose: (): void => undefined,
        storeFactory: () => store,
      });
      const headChildren = (
        (
          tree.props as {
            readonly children: readonly {
              readonly props: {
                readonly children: readonly {
                  readonly props: {
                    readonly children: readonly {
                      readonly props: { readonly onClick?: () => void };
                    }[];
                  };
                }[];
              };
            }[];
          }
        ).children[0]?.props.children[1]?.props.children ?? []
      );
      capturedEnableAllClick = headChildren[0]?.props.onClick;
      return tree;
    };
    renderToStaticMarkup(createElement(ClickCaptureProbe));
    capturedEnableAllClick?.();
    expect(useMiniAppStore.getState().toastText).toBe(
      zh.serverNotice("ALL_PERMISSIONS_UNCHANGED", { id: 5 })
    );
    expect(useMiniAppStore.getState().toastTone).toBe("warning");
    resetMiniAppStoreForTest();
  });

  test("验证器页面：点击刷新重新播放骨架屏，点击修改验证器期间按钮播放三点波浪动画，就绪后平滑展开绑定表单", () => {
    const totpStore = createTotpStore();
    (totpStore as { getInitialState: typeof totpStore.getState }).getInitialState = totpStore.getState;
    totpStore.setState({
      loadingStatus: true,
      totpStatus: { enabled: true, createdAt: 1_700_000_000_000, maskedSecret: "ABCD••••" },
      setupData: null,
      busy: false,
    });
    const refreshingMarkup: string = renderToStaticMarkup(
      createElement(TotpPage, { storeFactory: () => totpStore })
    );
    expect(refreshingMarkup).toContain("skeleton-totp-btn");
    expect(refreshingMarkup).not.toContain("totp-start-submit");

    totpStore.setState({ loadingStatus: false, busy: true });
    const loadingMarkup: string = renderToStaticMarkup(
      createElement(TotpPage, { storeFactory: () => totpStore })
    );
    expect(loadingMarkup).toContain("totp-start-submit is-loading");
    expect(loadingMarkup).toContain("join-clean-loading-dots");
    expect(loadingMarkup).toContain("totp-trigger-collapse-grid");

    totpStore.setState({
      busy: false,
      setupData: {
        ok: true,
        secret: "JBSWY3DPEHPK3PXP",
        otpauthUri: "otpauth://totp/bot",
        qrSvg: "<svg><rect/></svg>",
        expiresAt: 1_700_000_600_000,
      },
    });
    const expandedMarkup: string = renderToStaticMarkup(
      createElement(TotpPage, { storeFactory: () => totpStore })
    );
    expect(expandedMarkup).toContain("totp-trigger-collapse-grid collapsed");
    expect(expandedMarkup).toContain("totp-setup-collapse-grid expanded");
    expect(expandedMarkup).toContain("JBSWY3DPEHPK3PXP");

    const galleryStore = createGalleryStore();
    (galleryStore as { getInitialState: typeof galleryStore.getState }).getInitialState =
      galleryStore.getState;
    const disabledUploadMarkup: string = renderToStaticMarkup(
      createElement(GalleryPage, { storeFactory: () => galleryStore })
    );
    expect(disabledUploadMarkup).toContain('class="btn primary icon-btn gallery-upload-btn is-disabled"');
    expect(disabledUploadMarkup).toContain('class="gallery-upload-input"');
    expect(disabledUploadMarkup).toContain("disabled");
    expect(disabledUploadMarkup).not.toContain("display:none");

    galleryStore.setState({
      loading: false,
      galleryPage: {
        directory: "/data/gallery",
        exists: true,
        total: 0,
        page: 1,
        pageSize: 10,
        totalPages: 1,
        items: [],
      },
    });
    const enabledUploadMarkup: string = renderToStaticMarkup(
      createElement(GalleryPage, { storeFactory: () => galleryStore })
    );
    expect(enabledUploadMarkup).toContain('class="btn primary icon-btn gallery-upload-btn"');
    expect(enabledUploadMarkup).toContain('aria-disabled="false"');
    expect(enabledUploadMarkup).toContain('class="gallery-upload-input"');
    expect(enabledUploadMarkup).not.toContain("display:none");
  });

  test("TabHeightSizer 高度过渡曲线绑定、亚像素高度测量、门禁错误折叠、全局弹窗连续序号与硬边骨架屏核验", async () => {
    const expectedTransition: string = `height ${MINI_APP_TAB_HEIGHT_TRANSITION_MS / 1_000}s cubic-bezier(${MINI_APP_FLIP_COLLAPSE_EASING_POINTS.join(", ")})`;
    expect(MINI_APP_TAB_HEIGHT_TRANSITION).toBe(expectedTransition);
    expect(formatTabHeightTransition()).toBe(expectedTransition);
    expect(
      readElementBodyHeight({
        offsetHeight: 180,
        getBoundingClientRect: (): { readonly height: number } => ({ height: 180.5 }),
      })
    ).toBe(180.5);
    expect(
      readElementBodyHeight({
        offsetHeight: 180,
        getBoundingClientRect: (): { readonly height: number } => ({ height: 0 }),
      })
    ).toBe(180);

    const prevSetTimeout: typeof globalThis.setTimeout = globalThis.setTimeout;
    const prevClearTimeout: typeof globalThis.clearTimeout = globalThis.clearTimeout;
    const scheduledTimers: { readonly id: number; readonly delayMs: number; readonly run: () => void }[] = [];
    const clearedTimerIds: number[] = [];
    let nextTimerId: number = 1;
    (globalThis as { setTimeout: unknown }).setTimeout = (callback: () => void, delayMs?: number): number => {
      const id: number = nextTimerId++;
      scheduledTimers.push({ id, delayMs: delayMs ?? 0, run: callback });
      return id;
    };
    (globalThis as { clearTimeout: unknown }).clearTimeout = (id?: number): void => {
      if (typeof id === "number") clearedTimerIds.push(id);
    };

    try {
      const sizerStyle: { height: string; overflow: string; transition: string } = {
        height: "",
        overflow: "",
        transition: "",
      };
      const sizerRef: { current: MeasurableBodyElement | null } = {
        current: { offsetHeight: 180, style: sizerStyle },
      };
      const paneRef: { current: MeasurableBodyElement | null } = { current: { offsetHeight: 264 } };
      const lastHeightRef: { current: number } = { current: 180 };
      const prevTabRef: { current: MiniAppChatTargetKind | null } = { current: "qa" };
      const prevHadTargetsRef: { current: boolean } = { current: true };
      const runSizer = (activeTab: MiniAppChatTargetKind | null, hasTargets: boolean): (() => void) | undefined =>
        syncTabHeightTransitionEffect({
          activeTab,
          hasTargets,
          sizerRef,
          paneRef,
          lastHeightRef,
          prevTabRef,
          prevHadTargetsRef,
        });

      const cleanupSwitch: (() => void) | undefined = runSizer("translate", true);
      expect(typeof cleanupSwitch).toBe("function");
      expect(sizerStyle).toEqual({ overflow: "hidden", transition: expectedTransition, height: "264px" });
      expect(lastHeightRef.current).toBe(264);
      expect(prevTabRef.current).toBe("translate");
      expect(scheduledTimers).toHaveLength(1);
      expect(scheduledTimers[0]?.delayMs).toBe(MINI_APP_TAB_HEIGHT_CLEANUP_MS);

      scheduledTimers[0]?.run();
      expect(sizerStyle).toEqual({ height: "", overflow: "", transition: "" });

      // 首次注水高度变化同样写入快出急停曲线过渡，优先采纳 getBoundingClientRect 小数高度，卸载清理回调立即清除定时器与行内样式
      prevTabRef.current = "qa";
      prevHadTargetsRef.current = false;
      lastHeightRef.current = 156.25;
      paneRef.current = {
        offsetHeight: 228,
        getBoundingClientRect: (): { readonly height: number } => ({ height: 228.5 }),
      };
      const cleanupHydrate: (() => void) | undefined = runSizer("qa", true);
      expect(sizerStyle.transition).toBe(expectedTransition);
      expect(sizerStyle.height).toBe("228.5px");
      expect(lastHeightRef.current).toBe(228.5);
      cleanupHydrate?.();
      expect(clearedTimerIds).toContain(scheduledTimers[1]?.id ?? -1);
      expect(sizerStyle).toEqual({ height: "", overflow: "", transition: "" });

      // 弹窗关闭后重置内部记录状态
      expect(runSizer(null, false)).toBeUndefined();
      expect(prevTabRef.current).toBeNull();
      expect(prevHadTargetsRef.current).toBe(false);
      expect(lastHeightRef.current).toBe(0);
    } finally {
      globalThis.setTimeout = prevSetTimeout;
      globalThis.clearTimeout = prevClearTimeout;
    }

    const dotsMarkup: string = renderToStaticMarkup(createElement(LoadingDotsWave));
    expect(dotsMarkup).toContain("join-clean-loading-dots loading-dots-wave");
    expect(dotsMarkup.match(/loading-dot-block/g)?.length).toBe(3);

    const statusSkeletonMarkup: string = renderToStaticMarkup(createElement(StatusSkeleton));
    expect(statusSkeletonMarkup).toContain('aria-hidden="true"');
    expect(statusSkeletonMarkup.match(/memory-metric-card/g)?.length).toBe(
      MINI_APP_STATUS_SKELETON_MEMORY_INDICES.length
    );
    expect(statusSkeletonMarkup.match(/memory-legend-item/g)?.length).toBe(
      MINI_APP_STATUS_SKELETON_MEMORY_INDICES.length
    );
    expect(statusSkeletonMarkup.match(/skeleton-cap-row/g)?.length).toBe(
      MINI_APP_STATUS_SKELETON_CAPABILITY_INDICES.length
    );
    for (const cls of ["skeleton-stat-value", "skeleton-chevron-box", "skeleton-cpu-ring"]) {
      expect(statusSkeletonMarkup).toContain(cls);
    }
    expect(statusSkeletonMarkup).not.toContain("width:100%");
    expect(statusSkeletonMarkup).not.toContain("border-radius");

    const chatDetailSkeletonMarkup: string = renderToStaticMarkup(createElement(ChatDetailSkeleton));
    expect(chatDetailSkeletonMarkup.match(/skeleton-switch-row/g)?.length).toBe(MINI_APP_FEATURE_KEYS.length);
    expect(chatDetailSkeletonMarkup).toContain("skeleton-perm-banner-spaced");
    expect(chatDetailSkeletonMarkup).not.toContain("border-radius");

    const targetsSkeletonMarkup: string = renderToStaticMarkup(createElement(ChatTargetsListSkeleton));
    expect(targetsSkeletonMarkup.match(/chat-targets-skeleton-row"/g)?.length).toBe(
      MINI_APP_TARGETS_SKELETON_ROW_INDICES.length
    );
    expect(targetsSkeletonMarkup).not.toContain("border-radius");

    const listSkeletonMarkup: string = renderToStaticMarkup(
      createElement(LoadingBox, { children: createElement(ListSkeletonRows, { count: 2 }) })
    );
    expect(listSkeletonMarkup).toContain('class="loading-box" aria-hidden="true"');
    expect(listSkeletonMarkup).toContain("skeleton-stack");
    expect(listSkeletonMarkup.match(/skeleton-card/g)?.length).toBe(2);
    expect(listSkeletonMarkup).not.toContain("border-radius");

    const msgSkeletonMarkup: string = renderToStaticMarkup(createElement(MessageSkeletonRows, { count: 2 }));
    expect(msgSkeletonMarkup.match(/msg-skeleton-card/g)?.length).toBe(2);
    expect(msgSkeletonMarkup).toContain("msg-skeleton-avatar");
    expect(msgSkeletonMarkup).toContain("msg-skeleton-bubble");
    expect(msgSkeletonMarkup).not.toContain("border-radius");

    const gallerySkeletonMarkup: string = renderToStaticMarkup(
      createElement(GalleryImageSkeleton, { iconSize: 28, preview: true })
    );
    expect(gallerySkeletonMarkup).toContain("gallery-img-skeleton preview-skeleton");
    expect(gallerySkeletonMarkup).toContain("gallery-skeleton-icon-pulse");

    const totpSkeletonMarkup: string = renderToStaticMarkup(createElement(TotpSkeleton));
    expect(totpSkeletonMarkup).toContain('aria-hidden="true"');
    expect(totpSkeletonMarkup).toContain("skeleton-totp-btn");
    expect(totpSkeletonMarkup).not.toContain("border-radius");

    try {
      const zhTranslations: MiniAppTranslations = getMiniAppTranslations("zh");
      useMiniAppStore.setState({
        language: "zh",
        authMode: "password",
        passwordInput: "",
        passwordBusy: false,
        passwordError: "",
      });
      const passwordGateMarkup: string = renderToStaticMarkup(createElement(AuthGatePage));
      expect(passwordGateMarkup).toContain('class="card auth-gate-card"');
      expect(passwordGateMarkup).toContain('type="password"');
      expect(passwordGateMarkup).toContain(
        `class="${MINI_APP_INLINE_NOTICE_GRID_CLASS_NAME} " aria-hidden="true"`
      );
      expect(passwordGateMarkup).not.toContain("auth-gate-error");
      expect(passwordGateMarkup).toContain(
        `aria-busy="false"><span>${zhTranslations.gate.passwordSubmitButton}</span></button>`
      );
      expect(passwordGateMarkup).not.toContain("join-clean-loading-dots");

      useMiniAppStore.setState({
        authMode: "totp",
        passwordInput: "123456",
        passwordBusy: false,
        passwordError: "验证码无效",
      });
      const totpGateMarkup: string = renderToStaticMarkup(createElement(AuthGatePage));
      expect(totpGateMarkup).toContain('class="card auth-gate-card"');
      expect(totpGateMarkup).toContain('inputMode="numeric"');
      expect(totpGateMarkup).toContain('maxLength="6"');
      expect(totpGateMarkup).toContain(`${MINI_APP_INLINE_NOTICE_GRID_CLASS_NAME} expanded`);
      expect(totpGateMarkup).toContain('<div class="auth-gate-error">验证码无效</div>');
      expect(totpGateMarkup).toContain(
        `aria-busy="false"><span>${zhTranslations.gate.totpSubmitButton}</span></button>`
      );
      expect(totpGateMarkup).not.toContain("join-clean-loading-dots");

      useMiniAppStore.setState({ authMode: "totp", passwordBusy: true, passwordError: "" });
      const busyGateMarkup: string = renderToStaticMarkup(createElement(AuthGatePage));
      expect(busyGateMarkup).toContain('class="card auth-gate-card"');
      expect(busyGateMarkup).toContain('class="btn primary auth-gate-submit is-loading"');
      expect(busyGateMarkup).toContain('aria-busy="true"');
      expect(busyGateMarkup).toContain('><span class="join-clean-loading-dots loading-dots-wave"');
      expect(busyGateMarkup).not.toContain(`<span>${zhTranslations.gate.totpSubmitButton}</span>`);

      // 验证连续触发 ConfirmModal / Toast 递增序号，且 App 在非 checking 阶段顶层常驻挂载 ConfirmModal 并在 logout 时以取消结算
      useMiniAppStore.setState({ gateState: "checking" });
      expect(renderToStaticMarkup(createElement(App))).toBe("");
      useMiniAppStore.setState({ gateState: "unlocked" });
      const firstConfirm: Promise<boolean> = useMiniAppStore
        .getState()
        .requestConfirm("首次确认", "danger");
      const firstConfirmSeq: number | undefined = useMiniAppStore.getState().confirmModal?.requestSeq;
      const secondConfirm: Promise<boolean> = useMiniAppStore
        .getState()
        .requestConfirm("再次确认", "primary");
      expect(await firstConfirm).toBeFalse();
      const secondConfirmSeq: number | undefined = useMiniAppStore.getState().confirmModal?.requestSeq;
      expect(typeof firstConfirmSeq).toBe("number");
      expect(secondConfirmSeq).toBe((firstConfirmSeq ?? 0) + 1);
      const unlockedWithConfirmMarkup: string = renderToStaticMarkup(createElement(App));
      expect(unlockedWithConfirmMarkup).toContain("app-shell");
      expect(unlockedWithConfirmMarkup).toContain("再次确认");
      expect(renderToStaticMarkup(createElement(ConfirmModal))).toContain("再次确认");

      const baseToastSeq: number = useMiniAppStore.getState().toastSeq;
      useMiniAppStore.getState().showToast("第一条提示", "info");
      const firstToastSeq: number = useMiniAppStore.getState().toastSeq;
      useMiniAppStore.getState().showToast("第二条提示", "warning");
      const secondToastSeq: number = useMiniAppStore.getState().toastSeq;
      expect(firstToastSeq).toBe(baseToastSeq + 1);
      expect(secondToastSeq).toBe(firstToastSeq + 1);
      expect(renderToStaticMarkup(createElement(Toast))).toContain('class="toast show toast-warning"');

      useMiniAppStore.getState().logout(zhTranslations.lockSessionToast);
      expect(await secondConfirm).toBeFalse();
      expect(useMiniAppStore.getState().confirmModal).toBeNull();
      expect(useMiniAppStore.getState().toastSeq).toBe(secondToastSeq + 1);

      useMiniAppStore.getState().logout(zhTranslations.lockSessionToast);
      const lockedGateMarkup: string = renderToStaticMarkup(createElement(AuthGatePage));
      const toastStart: number = lockedGateMarkup.indexOf('<div class="toast show toast-warning"');
      expect(toastStart).toBeGreaterThan(0);
      const markupBeforeToast: string = lockedGateMarkup.slice(0, toastStart);
      expect(markupBeforeToast.startsWith('<div class="auth-gate-wrap animate-fade-in">')).toBeTrue();
      expect(markupBeforeToast.endsWith("</form></div></div>")).toBeTrue();
      expect(markupBeforeToast.match(/<div\b/gu)?.length).toBe(
        markupBeforeToast.match(/<\/div>/gu)?.length
      );
      expect(lockedGateMarkup.slice(toastStart)).toContain(
        `<span class="toast-text">${zhTranslations.lockSessionToast}</span>`
      );

      useMiniAppStore.setState({ deniedDiag: null });
      const fallbackDeniedMarkup: string = renderToStaticMarkup(createElement(AccessDeniedPage));
      expect(fallbackDeniedMarkup).toContain('class="cf-error-page"');
      expect(fallbackDeniedMarkup).toContain('class="cf-error-container"');
      expect(fallbackDeniedMarkup).toContain('<span class="cf-code-pill"><span>HTTP 403');
      expect(fallbackDeniedMarkup.match(/class="cf-node-content"/g)?.length).toBe(3);

      useMiniAppStore.setState({
        deniedDiag: {
          error: "Forbidden",
          code: "NOT_SUPER_ADMIN",
          status: 403,
          requestId: "req-denied-01",
          timestamp: "2026-11-12T12:00:00.000Z",
          clientIp: "203.0.113.9",
          host: "mini.example.test",
          path: "/api/session",
        },
      });
      const customDeniedMarkup: string = renderToStaticMarkup(createElement(AccessDeniedPage));
      expect(customDeniedMarkup).toContain("HTTP 403 · NOT_SUPER_ADMIN</span></span>");
      expect(customDeniedMarkup).toContain('<div class="cf-node-icon err"><span>✕</span></div>');
      expect(customDeniedMarkup).toContain('class="cf-reason-content"');
      expect(customDeniedMarkup).toContain("<strong><span>req-denied-01</span></strong>");
      expect(customDeniedMarkup).toContain("<strong><span>/api/session</span></strong>");
    } finally {
      resetMiniAppStoreForTest();
    }
  });

  test("CSS 缓动曲线、平行四边形与异形切角按钮、认证门控卡片几何规则、暗色高对比按钮令牌及响应式断点核验", async () => {
    const stylesDir: string = `${import.meta.dir}/../../packages/mini-app-frontend/styles`;
    const baseCss: string = await Bun.file(`${stylesDir}/base.css`).text();
    const shellCss: string = await Bun.file(`${stylesDir}/shell.css`).text();
    const primitivesCss: string = await Bun.file(`${stylesDir}/primitives.css`).text();
    const overlaysCss: string = await Bun.file(`${stylesDir}/overlays.css`).text();
    const paginationCss: string = await Bun.file(`${stylesDir}/pagination.css`).text();
    const skeletonsCss: string = await Bun.file(`${stylesDir}/skeletons.css`).text();
    const statusCss: string = await Bun.file(`${stylesDir}/status.css`).text();
    const chatsCss: string = await Bun.file(`${stylesDir}/chats.css`).text();
    const chatsDetailCss: string = await Bun.file(`${stylesDir}/chats-detail.css`).text();
    const chatsTargetsCss: string = await Bun.file(`${stylesDir}/chats-targets.css`).text();
    const identitiesCss: string = await Bun.file(`${stylesDir}/identities.css`).text();
    const authCss: string = await Bun.file(`${stylesDir}/auth.css`).text();
    const galleryCss: string = await Bun.file(`${stylesDir}/gallery.css`).text();

    // 1. 下拉看板与内部卡片变量定义与引用一致，暗色多层高对比令牌与共享几何令牌完备
    for (const token of [
      "--cap-expanded-bg:",
      "--dropdown-board-bg:",
      "--dropdown-board-border:",
      "--dropdown-item-bg:",
      "--dropdown-item-border:",
      `--bg: ${MINI_APP_DARK_BG_COLOR};`,
      `--header-bg: ${MINI_APP_DARK_HEADER_COLOR};`,
      "--btn-bg:",
      "--btn-border:",
      "--btn-shadow-hover:",
      "--btn-primary-bg:",
      "--btn-primary-shadow:",
      "--btn-danger-bg:",
      "--switch-off-bg:",
      "--switch-on-bg:",
      "--skew-btn:",
      "--skew-chip:",
      "--clip-chamfer:",
      "--clip-dogear:",
      `--ease-brutal: cubic-bezier(${MINI_APP_FLIP_COLLAPSE_EASING_POINTS.join(", ")});`,
      "overflow-anchor: none;",
      "@keyframes miniapp-spin",
    ]) {
      expect(baseCss).toContain(token);
    }
    expect(statusCss).toContain("var(--dropdown-item-bg)");
    expect(statusCss).toContain("var(--dropdown-item-border)");
    expect(chatsCss).toContain("var(--dropdown-board-bg)");
    expect(chatsCss).toContain("var(--dropdown-item-bg)");
    expect(identitiesCss).toContain("var(--dropdown-board-bg)");
    expect(identitiesCss).toContain("var(--dropdown-item-bg)");

    // 2. 快出急停曲线令牌与逐帧折叠样式规则统一对齐
    for (const css of [
      baseCss,
      shellCss,
      primitivesCss,
      overlaysCss,
      paginationCss,
      skeletonsCss,
      statusCss,
      chatsCss,
      chatsDetailCss,
      chatsTargetsCss,
      identitiesCss,
      authCss,
      galleryCss,
    ]) {
      expect(css).toContain("var(--ease-brutal");
      // 逐帧跟滚以 `scrollBy({ behavior: "auto" })` 即时写入，样式表不得设置 `scroll-behavior`。
      expect(css).not.toMatch(/(?<![\w-])scroll-behavior\s*:/u);
    }

    // 3. 平行四边形骨架条、异形多边形骨架规则、电流感刷新扫描与按钮内水平方形加载块样式规则
    for (const token of [
      "border: 1.5px solid var(--border-subtle);",
      "border-radius: 2px;",
      "box-shadow: 2px 2px 0 var(--border-subtle);",
      "transform: skewX(var(--skew-chip, -8deg));",
      "max-width: calc(100% - 6px);",
      "clip-path: polygon(4px 0, 100% 0, calc(100% - 12px) 100%, 0 100%);",
      "clip-path: var(--clip-chamfer);",
      "clip-path: var(--clip-dogear);",
      "clip-path: polygon(28% 0, 72% 0, 100% 28%, 100% 72%, 72% 100%, 28% 100%, 0 72%, 0 28%);",
      "border-radius: 2px 10px 2px 10px;",
      "border-radius: 10px 2px 10px 2px;",
      "background: var(--surface-elevated);",
      "--refresh-arc-band:",
      "opacity: 0.86;",
      "@keyframes miniapp-electric-flicker",
      "@keyframes miniapp-electric-arc-sweep",
      "animation: miniapp-electric-flicker 0.56s var(--ease-brutal) infinite;",
      ".content-refreshing::after",
      "animation: miniapp-electric-arc-sweep 0.56s var(--ease-brutal) infinite;",
      "@keyframes miniapp-brutal-scan",
      "@keyframes miniapp-brutal-dot-step",
      ".join-clean-loading-dots.loading-dots-wave > .loading-dot-block",
    ]) {
      expect(skeletonsCss).toContain(token);
    }
    const skeletonScanAfterRule: RegExpExecArray | null =
      /\.skeleton-line::after,\s*\.gallery-img-skeleton::after\s*\{([^}]*)\}/u.exec(skeletonsCss);
    expect(skeletonScanAfterRule).not.toBeNull();
    const skeletonScanAfterBody: string = skeletonScanAfterRule?.[1] ?? "";
    expect(skeletonScanAfterBody).toContain("background: var(--skeleton-scan-band);");
    expect(skeletonScanAfterBody).toContain("animation: miniapp-brutal-scan 0.68s var(--ease-brutal) infinite;");
    expect(skeletonScanAfterBody).not.toContain("will-change");
    expect(skeletonsCss).not.toContain("999px");
    expect(baseCss).toMatch(/\.spin-icon\s*\{[^}]*animation:\s*miniapp-spin\s+0\.[4-7]\d*s\b[^}]*infinite/u);
    expect(primitivesCss).toContain("@keyframes miniapp-btn-spin");
    expect(primitivesCss).toMatch(
      /svg\.spin-icon\s*\{[^}]*animation:\s*miniapp-btn-spin\s+0\.[4-7]\d*s\b[^}]*infinite/u
    );

    // 验证按钮文本 `> span { display: inline-block }` 规则排除 `.loading-dots-wave`，且所有三点加载容器强制水平 `inline-flex` + `flex-direction: row`
    for (const sel of [
      ".subtab-btn > span:not(.loading-dots-wave)",
      ".btn > span:not(.loading-dots-wave)",
      ".icon-btn > span:not(.loading-dots-wave)",
      ".page-size-pill > span:not(.loading-dots-wave)",
    ]) {
      expect(primitivesCss).toContain(sel);
    }
    expect(primitivesCss).not.toMatch(
      /\.(?:subtab-btn|btn|icon-btn|page-size-pill)\s*>\s*span(?!:not\(\.loading-dots-wave\))/u
    );
    expect(statusCss).toContain(".btn.mood-switch-btn > span:not(.loading-dots-wave)");
    expect(statusCss).not.toMatch(/\.btn\.mood-switch-btn\s*>\s*span(?!:not\(\.loading-dots-wave\))/u);

    const horizontalDotsBlocks: readonly (readonly [string, RegExp])[] = [
      [primitivesCss, /\.btn\s*>\s*\.join-clean-loading-dots,\s*\.icon-btn\s*>\s*\.join-clean-loading-dots\s*\{([^}]*)\}/u],
      [skeletonsCss, /\.loading-dots-wave,\s*\.join-clean-loading-dots\.loading-dots-wave\s*\{([^}]*)\}/u],
      [statusCss, /\.btn\.mood-switch-btn\s*>\s*\.join-clean-loading-dots\s*\{([^}]*)\}/u],
      [chatsCss, /\.join-clean-stat-value\s*>\s*\.join-clean-loading-dots\s*\{([^}]*)\}/u],
      [authCss, /\.auth-gate-submit\s*>\s*\.join-clean-loading-dots\s*\{([^}]*)\}/u],
      [authCss, /\.totp-start-submit\s*>\s*\.join-clean-loading-dots,\s*\.totp-verify-submit\s*>\s*\.join-clean-loading-dots\s*\{([^}]*)\}/u],
    ];
    for (const [cssSource, rulePattern] of horizontalDotsBlocks) {
      const declarations: string = rulePattern.exec(cssSource)?.[1] ?? "";
      expect(declarations).toContain("display: inline-flex;");
      expect(declarations).toContain("flex-direction: row;");
      expect(declarations).toContain("align-items: center;");
      expect(declarations).toContain("justify-content: center;");
    }

    // 4. 平行四边形按钮复合倾角、反向拉正子元素与异形切角多边形按钮规则
    for (const token of [
      "--btn-skew: 0deg;",
      "--btn-skew: var(--skew-btn);",
      "transform: skewX(var(--btn-skew, 0deg));",
      "transform: translate(-1px, -1px) skewX(var(--btn-skew, 0deg));",
      "transform: translate(2px, 2px) skewX(var(--btn-skew, 0deg));",
      ".btn.primary:active:not(:disabled):not(.is-disabled)",
      ".btn.danger:active:not(:disabled):not(.is-disabled)",
      ".btn.is-disabled",
      "transform: skewX(calc(var(--btn-skew, 0deg) * -1));",
      "box-shadow: 0 0 0 var(--btn-shadow-color);",
      "clip-path: var(--clip-dogear);",
      ".slider:before",
      ".subtab-btn:hover:not(.active)",
      "box-shadow var(--press-duration) var(--ease-brutal)",
    ]) {
      expect(primitivesCss).toContain(token);
    }
    expect(galleryCss).toContain(".gallery-upload-input::file-selector-button");
    expect(overlaysCss).toContain(".confirm-actions .btn.primary:active:not(:disabled)");
    expect(identitiesCss).toContain(".id-add-inline-row .btn.primary:active:not(:disabled)");
    expect(shellCss).toContain("clip-path: var(--clip-chamfer);");
    expect(shellCss).toContain("clip-path: var(--clip-chamfer-inner);");
    expect(shellCss).toContain("filter: drop-shadow(0 0 0 transparent);");

    const appMainBody: string = /(?:^|\n)\.app-main\s*\{([^}]*)\}/u.exec(shellCss)?.[1] ?? "";
    expect(appMainBody).toContain("contain: style;");
    expect(appMainBody).not.toMatch(/contain\s*:\s*[^;]*\b(?:layout|paint|content|strict)\b/u);
    expect(appMainBody).not.toMatch(/(?<![\w-])transform\s*:/u);

    const topbarChamferBtnBody: string =
      /\.sidebar-toggle-btn,\s*\.lang-menu-btn,\s*\.btn\.lang-menu-btn,\s*\.theme-toggle-btn,\s*\.btn\.theme-toggle-btn\s*\{([^}]*)\}/u.exec(
        shellCss
      )?.[1] ?? "";
    expect(topbarChamferBtnBody).toContain("filter: drop-shadow(2px 2px 0 var(--btn-shadow-color));");
    expect(topbarChamferBtnBody).toContain("color var(--press-duration) var(--ease-brutal)");
    const topbarTransition: string = /transition\s*:\s*([^;]+);/u.exec(topbarChamferBtnBody)?.[1] ?? "";
    expect(topbarTransition).not.toBe("");
    expect(topbarTransition).not.toContain("filter");
    expect(topbarTransition).not.toContain("transform");

    const sidebarDrawerBody: string = /(?:^|\n)\.sidebar-drawer\s*\{([^}]*)\}/u.exec(shellCss)?.[1] ?? "";
    expect(sidebarDrawerBody).toContain("box-shadow: var(--shadow-lg);");
    expect(sidebarDrawerBody).toContain("will-change: transform;");
    expect(sidebarDrawerBody).toContain("transform: translate3d(calc(-100% - 8px), 0, 0);");
    expect(sidebarDrawerBody).toContain("transition: transform 0.19s var(--ease-brutal);");
    expect(sidebarDrawerBody).not.toMatch(/transition\s*:[^;]*box-shadow/u);

    const sidebarDrawerOpenBody: string = /(?:^|\n)\.sidebar-drawer\.open\s*\{([^}]*)\}/u.exec(shellCss)?.[1] ?? "";
    expect(sidebarDrawerOpenBody).toContain("transform: translate3d(0, 0, 0);");
    expect(sidebarDrawerOpenBody).toContain("pointer-events: auto;");
    expect(sidebarDrawerOpenBody).not.toContain("box-shadow");

    expect(overlaysCss).toContain("var(--btn-primary-bg)");
    expect(overlaysCss).toContain("var(--btn-danger-bg)");
    expect(paginationCss).toContain("clip-path: var(--clip-dogear);");
    expect(paginationCss).toContain("clip-path: var(--clip-dogear-inner);");
    expect(authCss).toContain(".auth-gate-submit.is-loading::after");
    expect(authCss).toContain("skewX(calc(var(--btn-skew, 0deg) * -1)) translateY(1px)");

    const authCardBody: string = /(?:^|\n)\.auth-gate-card\s*\{([^}]*)\}/u.exec(authCss)?.[1] ?? "";
    expect(authCardBody).toContain("--auth-card-skew:");
    expect(authCardBody).toContain("margin: clamp(31px, calc(14vh - 25px), 103px) 10px 0;");
    expect(authCardBody).toContain("transform: skewX(var(--auth-card-skew));");
    for (const innerPattern of [
      /\.auth-gate-card\s*>\s*\.card-title\s*>\s*\.toolbar-hint\s*\{([^}]*)\}/u,
      /\.auth-gate-card\s+\.badge\.ok\s*\{([^}]*)\}/u,
      /(?:^|\n)\.auth-gate-desc\s*\{([^}]*)\}/u,
      /(?:^|\n)\.auth-gate-form\s*\{([^}]*)\}/u,
    ]) {
      expect(innerPattern.exec(authCss)?.[1] ?? "").toContain("skewX(calc(var(--auth-card-skew) * -1))");
    }
    expect(
      /@media\s*\(max-width:\s*380px\)\s*\{(?:[^{}]*\{[^{}]*\})*?\s*\.auth-gate-card\s*\{([^}]*)\}/u.exec(authCss)?.[1] ?? ""
    ).toContain("margin: clamp(19px, calc(11vh - 25px), 71px) 8px 0;");
    expect(
      /@media\s*\(max-height:\s*560px\)\s*\{(?:[^{}]*\{[^{}]*\})*?\s*\.auth-gate-card\s*\{([^}]*)\}/u.exec(authCss)?.[1] ?? ""
    ).toContain("margin-top: clamp(4px, calc(5vh - 25px), 19px);");

    expect(/(?:^|\n)\.cf-error-page\s*\{([^}]*)\}/u.exec(authCss)?.[1] ?? "").toContain("overflow-x: hidden;");
    const cfCardBody: string = /(?:^|\n)\.cf-error-container\s*\{([^}]*)\}/u.exec(authCss)?.[1] ?? "";
    expect(cfCardBody).toContain("--cf-card-skew:");
    expect(cfCardBody).toContain("border-radius: 3px 12px 3px 12px;");
    expect(cfCardBody).toContain("transform: skewX(var(--cf-card-skew));");
    for (const cfCounterPattern of [
      /(?:^|\n)\.cf-title-row\s*\{([^}]*)\}/u,
      /(?:^|\n)\.cf-subtitle\s*\{([^}]*)\}/u,
      /(?:^|\n)\.cf-timestamp\s*\{([^}]*)\}/u,
      /(?:^|\n)\.cf-node-content\s*\{([^}]*)\}/u,
      /\.cf-detail-col\s*>\s*h2\s*\{([^}]*)\}/u,
      /\.cf-detail-col\s*>\s*p\s*\{([^}]*)\}/u,
      /(?:^|\n)\.cf-reason-content\s*\{([^}]*)\}/u,
      /\.cf-footer\s*>\s*span\s*\{([^}]*)\}/u,
    ]) {
      expect(cfCounterPattern.exec(authCss)?.[1] ?? "").toContain("skewX(calc(var(--cf-card-skew) * -1))");
    }
    for (const [chipPattern, counterPattern] of [
      [/(?:^|\n)\.cf-code-pill\s*\{([^}]*)\}/u, /\.cf-code-pill\s*>\s*span\s*\{([^}]*)\}/u],
      [/(?:^|\n)\.cf-node-icon\s*\{([^}]*)\}/u, /\.cf-node-icon\s*>\s*span\s*\{([^}]*)\}/u],
      [/\.cf-footer\s+strong\s*\{([^}]*)\}/u, /\.cf-footer\s+strong\s*>\s*span\s*\{([^}]*)\}/u],
    ] as const) {
      expect(chipPattern.exec(authCss)?.[1] ?? "").toContain("skewX(var(--skew-chip))");
      expect(counterPattern.exec(authCss)?.[1] ?? "").toContain("skewX(var(--skew-chip-counter))");
    }
    expect(authCss).toContain("--cf-card-skew: -1.25deg;");

    // 5. 逐帧折叠容器、机械下压交互、触屏合成层提示与响应式断点
    expect(primitivesCss).not.toContain(".card.flip-card-clip");
    for (const css of [chatsCss, chatsDetailCss, chatsTargetsCss]) {
      expect(css).not.toContain(".chat-targets-form.flip-card-clip");
      expect(css).not.toContain("miniapp-qa-collapse-overflow-reveal");
    }
    expect(authCss).not.toContain("miniapp-totp-collapse-overflow-reveal");
    expect(statusCss).toContain(".cap-collapse-inner");
    expect(statusCss).toContain(".cap-collapse-wrap.flip-closing");
    expect(chatsDetailCss).toContain("@keyframes miniapp-tab-slide-forward");
    expect(chatsDetailCss).toContain("@keyframes miniapp-tab-slide-backward");
    expect(chatsTargetsCss).toContain("animation: miniapp-tab-slide-forward");
    expect(chatsTargetsCss).toContain("animation: miniapp-tab-slide-backward");
    expect(chatsDetailCss).toContain("animation: miniapp-popover-drop-out");
    expect(chatsTargetsCss).toContain("animation: miniapp-popover-drop-out");
    expect(identitiesCss).toContain(".perm-drawer-collapse-grid.expanded");
    expect(identitiesCss).toContain(".perm-drawer-collapse-grid.flip-closing");
    expect(authCss).toContain(".totp-start-submit.is-loading");
    expect(galleryCss).toContain(".gallery-preview-collapse-grid.flip-closing");
    expect(galleryCss).toContain(".gallery-preview-collapse-grid.expanded ~ .card");
    expect(galleryCss).toContain(".gallery-preview-collapse-grid.flip-closing ~ .card");
    expect(statusCss).toContain(".cap-collapse-wrap.expanded > .cap-collapse-inner");
    expect(identitiesCss).toContain(".perm-drawer-collapse-grid.flip-closing > .perm-drawer-collapse-inner");
    expect(galleryCss).toContain(".gallery-preview-collapse-grid.expanded > .gallery-preview-collapse-inner");
    for (const css of [statusCss, identitiesCss, chatsTargetsCss, galleryCss]) {
      expect(css).toContain("@media (hover: none) and (pointer: coarse)");
    }
    expect(galleryCss).toContain(".gallery-preview-collapse-grid ~ .card { will-change: transform; }");
    expect(galleryCss).toContain("height: clamp(220px, 42vh, 320px);");
    expect(identitiesCss).toContain("@media (max-width: 440px)");
    expect(chatsTargetsCss).toContain("@media (max-width: 440px)");
    expect(identitiesCss).toContain("@media (max-width: 350px)");
    expect(chatsTargetsCss).toContain("@media (max-width: 350px)");
    expect(primitivesCss).toContain("@media (min-width: 720px)");

    // 6. 弹窗/浮层/Toast 退场缓动曲线、纯整数 translate3d 无缩放、常驻合成层、顶边锚定与一体式卡片恒定底边框核验
    const htmlBodyRootRule: string = /html,\s*body,\s*#root\s*\{([^}]*)\}/u.exec(baseCss)?.[1] ?? "";
    expect(htmlBodyRootRule).toContain("--ease-exit: cubic-bezier(0.32, 0, 0.67, 0);");
    expect(baseCss.slice(0, baseCss.indexOf("* {"))).not.toContain("--ease-exit");
    expect(authCss.slice(authCss.indexOf(".auth-gate-wrap {"))).toContain("#root > .cf-error-page");
    expect(authCss).toContain("miniapp-backdrop-fade-in");
    expect(authCss).not.toMatch(/\.inline-notice-collapse-grid[^{]*\{[^}]*margin-top\s*:/u);
    expect(authCss).not.toContain(".auth-gate-form > .inline-notice-collapse-grid");
    for (const [cssSource, keyframeName] of [
      [overlaysCss, "miniapp-toast-in"], [overlaysCss, "miniapp-toast-out"],
      [overlaysCss, "miniapp-modal-pop"], [overlaysCss, "miniapp-modal-pop-out"],
      [shellCss, "miniapp-popover-drop"], [shellCss, "miniapp-popover-drop-out"],
      [chatsDetailCss, "miniapp-targets-stamp-in"], [chatsDetailCss, "miniapp-targets-snap-out"],
    ] as const) {
      const kfBody: string = new RegExp(`@keyframes\\s+${keyframeName}\\s*\\{([\\s\\S]*?\\}\\s*)\\}`, "u").exec(cssSource)?.[1] ?? "";
      expect(kfBody).toContain("translate3d(");
      expect(kfBody).not.toContain("scale(");
      expect(kfBody).not.toContain("translateX(-50%)");
    }
    const toastBaseBody: string = /(?:^|\n)\.toast\s*\{([^}]*)\}/u.exec(overlaysCss)?.[1] ?? "";
    for (const token of ["left: 0;", "right: 0;", "margin-inline: auto;"]) expect(toastBaseBody).toContain(token);
    expect(toastBaseBody).not.toContain("translateX(-50%)");
    expect(toastBaseBody).not.toMatch(/(?<![\w-])transition\s*:/u);
    for (const [cssSource, selectorPattern] of [
      [overlaysCss, /(?:^|\n)\.toast\.show\s*\{([^}]*)\}/u], [overlaysCss, /(?:^|\n)\.confirm-dialog\s*\{([^}]*)\}/u],
      [shellCss, /(?:^|\n)\.lang-menu-popover\s*\{([^}]*)\}/u], [chatsTargetsCss, /(?:^|\n)\.chat-targets-modal\s*\{([^}]*)\}/u],
      [chatsDetailCss, /(?:^|\n)\.chat-targets-menu-popover\s*\{([^}]*)\}/u], [chatsTargetsCss, /(?:^|\n)\.chat-targets-lang-popover\s*\{([^}]*)\}/u],
    ] as const) {
      const layerBody: string = selectorPattern.exec(cssSource)?.[1] ?? "";
      expect(layerBody).toContain("will-change: transform, opacity;");
      expect(layerBody).toContain("transform: translate3d(0, 0, 0);");
      expect(layerBody).toContain("backface-visibility: hidden;");
    }
    for (const [cssSource, closingPattern] of [
      [overlaysCss, /(?:^|\n)\.toast\.closing\s*\{([^}]*)\}/u], [overlaysCss, /(?:^|\n)\.confirm-backdrop\.closing::before\s*\{([^}]*)\}/u],
      [overlaysCss, /(?:^|\n)\.confirm-dialog\.closing\s*\{([^}]*)\}/u], [shellCss, /(?:^|\n)\.lang-menu-popover\.closing\s*\{([^}]*)\}/u],
      [chatsTargetsCss, /(?:^|\n)\.confirm-backdrop\.chat-targets-backdrop\.closing::before\s*\{([^}]*)\}/u],
      [chatsTargetsCss, /(?:^|\n)\.chat-targets-modal\.closing\s*\{([^}]*)\}/u],
      [chatsDetailCss, /(?:^|\n)\.chat-targets-menu-popover\.closing\s*\{([^}]*)\}/u],
      [chatsTargetsCss, /(?:^|\n)\.chat-targets-lang-popover\.closing\s*\{([^}]*)\}/u],
    ] as const) {
      expect(closingPattern.exec(cssSource)?.[1] ?? "").toContain("var(--ease-exit");
    }
    expect(/(?:^|\n)\.confirm-backdrop\.chat-targets-backdrop\s*\{([^}]*)\}/u.exec(chatsTargetsCss)?.[1] ?? "").toContain("align-items: flex-start;");
    expect(chatsTargetsCss).toContain(".chat-targets-qa-collapse-grid.flip-closing:has(.chat-targets-lang-popover)");
    expect(chatsTargetsCss).toContain(".chat-targets-qa-collapse-grid.flip-closing > .chat-targets-qa-collapse-inner:has(.chat-targets-lang-popover)");
    expect(identitiesCss).not.toContain("miniapp-perm-drawer-stamp");
    for (const match of statusCss.matchAll(/[^{}]*>\s*\.cap-header-btn\s*\{([^}]*)\}/gu)) {
      expect(match[1] ?? "").not.toMatch(/border-bottom\s*:\s*(?:none|var\(--border-w-sm\))/u);
    }
    expect(statusCss).not.toMatch(/\[data-theme="dark"\]\s*\.cap-collapse-inner\s*\{[^}]*border-top\s*:/u);
    for (const match of chatsCss.matchAll(/[^{}]*>\s*\.bot-perm-granted-toggle\s*\{([^}]*)\}/gu)) {
      expect(match[1] ?? "").not.toMatch(/border-bottom\s*:\s*(?:none|var\(--border-w-sm\))/u);
    }
    expect(/\[data-theme="dark"\]\s*\.bot-perm-collapse-inner\s*\{([^}]*)\}/u.exec(chatsCss)?.[1] ?? "").not.toMatch(/border-top\s*:\s*2px/u);
  });
});
