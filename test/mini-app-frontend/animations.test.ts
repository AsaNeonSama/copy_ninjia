/**
 * Mini App 前端名单弹窗 Tab 切换过渡、QA 问答对卡片结构、权限抽屉与验证器页面渲染，
 * 以及直接针对 CSS 滑动动画曲线、合成层提示、下拉看板浅色背景变量和 Windows TG / Pixel 6.3" 断点规则的核验。
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  resolveTabSlideDirectionClass,
  TabHeightSizer,
} from "../../packages/mini-app-frontend/components/animations/TabHeightSizer";
import { ChatFeatureListCard } from "../../packages/mini-app-frontend/components/ChatFeatureListCard";
import { ChatTargetsModal } from "../../packages/mini-app-frontend/components/ChatTargetsModal";
import { PermissionDrawer } from "../../packages/mini-app-frontend/components/PermissionDrawer";
import {
  MINI_APP_FEATURE_KEYS,
  MINI_APP_FLIP_COLLAPSE_EASING_POINTS,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { WHITELIST_PERMISSION_KEYS } from "../../packages/mini-app-frontend/consts/whitelist";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import { TotpPage } from "../../packages/mini-app-frontend/pages/TotpPage";
import { resetMiniAppStoreForTest, useMiniAppStore } from "../../packages/mini-app-frontend/store/app";
import { createChatsStore } from "../../packages/mini-app-frontend/store/chats";
import type { MiniAppChatsStoreState } from "../../packages/mini-app-frontend/store/chats";
import { createPermissionDrawerStore } from "../../packages/mini-app-frontend/store/permissionDrawer";
import { createTotpStore } from "../../packages/mini-app-frontend/store/totp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";

describe("名单弹窗、抽屉与验证器渲染及样式核验", () => {
  test("名单弹窗 Tab 切换方向与 QA 问答对 / 删发言对象 / 翻译对象面板渲染", () => {
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
      qaMax: 15,
      qaQuestionMaxChars: 256,
      qaAnswerMaxChars: 3840,
      deleteMessageTargets: [
        { id: 7001, isChannel: false, displayName: "Alice" },
      ],
      deleteMessageMax: 15,
      translateTargets: [
        { id: -10099, isChannel: true, displayName: "NewsChannel", language: "ja" },
      ],
      translateMax: 5,
      isTranslationEnabled: true,
    } as const;
    const mockDetail = {
      chatId: -1001,
      title: "Doro群",
      isLockdownActive: false,
      quietRemainingMs: 0,
      lockdownRemainingMs: 0,
      activeSessions: { gag: 0, wed: false, verify: 0, qaSet: false },
      hotMessageCount: 0,
      hotMessageMax: 256,
      qaPairCount: 1,
      deleteMessageTargetCount: 1,
      translateTargetCount: 1,
      joinedCountsByHour: [],
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
      botPermissions: null,
    } as const;
    const baseChatState: MiniAppChatsStoreState = {
      ...createChatsStore().getState(),
      selectedChatId: -1001,
      chatDetail: mockDetail,
      chatTargets: mockTargets,
      loadingTargets: false,
      mutatingTargets: false,
      qaEditorOpen: false,
      qaQuestionInput: "",
      qaAnswerInput: "",
      targetAddMenuOpen: false,
      targetIdFormOpen: false,
      deleteTargetInput: "",
      translateTargetInput: "",
      translateLanguageInput: "cn",
      translateLangMenuOpen: true,
    };

    const qaModalHtml: string = renderToStaticMarkup(
      createElement(ChatTargetsModal, {
        state: {
          ...baseChatState,
          activeTargetsModal: "qa",
        },
      })
    );
    expect(qaModalHtml).toContain('role="tablist"');
    expect(qaModalHtml).toContain("chat-targets-qa-head");
    expect(qaModalHtml).toContain("chat-targets-qa-q-badge");
    expect(qaModalHtml).toContain("chat-targets-qa-a-badge");
    expect(qaModalHtml).toContain("早上好");
    expect(qaModalHtml).toContain("杂鱼早上好♡");

    // 验证 QA 问答对编辑提交期间（mutatingTargets: true, loadingTargets: false）保留现有列表与编辑表单，不闪现骨架屏
    const qaMutatingModalHtml: string = renderToStaticMarkup(
      createElement(ChatTargetsModal, {
        state: {
          ...baseChatState,
          activeTargetsModal: "qa",
          qaEditorOpen: true,
          qaQuestionInput: "晚安",
          qaAnswerInput: "好梦♡",
          loadingTargets: false,
          mutatingTargets: true,
        },
      })
    );
    expect(qaMutatingModalHtml).toContain("chat-targets-qa-collapse-grid expanded");
    expect(qaMutatingModalHtml).toContain("chat-targets-qa-trigger-collapse collapsed");
    expect(qaMutatingModalHtml).toContain("早上好");
    expect(qaMutatingModalHtml).not.toContain("skeleton-list-card");

    const deleteModalHtml: string = renderToStaticMarkup(
      createElement(ChatTargetsModal, {
        state: {
          ...baseChatState,
          activeTargetsModal: "deleteMessage",
        },
      })
    );
    expect(deleteModalHtml).toContain("Alice");
    expect(deleteModalHtml).toContain("identity-user-badge");

    const translateModalHtml: string = renderToStaticMarkup(
      createElement(ChatTargetsModal, {
        state: {
          ...baseChatState,
          activeTargetsModal: "translate",
          targetIdFormOpen: true,
        },
      })
    );
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
    expect(featureBusyHtml.match(/type="checkbox"/g)?.length).toBe(
      MINI_APP_FEATURE_KEYS.length - 1
    );
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

    const targetKey = WHITELIST_PERMISSION_KEYS[0]!;
    store.setState({ busyKey: targetKey });
    const singleBusyMarkup: string = renderToStaticMarkup(
      createElement(PermissionDrawer, {
        entry: partialEntry,
        descriptors: [],
        onUpdated: (): void => undefined,
        onClose: (): void => undefined,
        storeFactory: () => store,
      })
    );
    expect(singleBusyMarkup.match(/perm-chip is-loading/g)?.length).toBe(1);
    expect(singleBusyMarkup.match(/perm-chip-skeleton-switch/g)?.length).toBe(1);
    expect(singleBusyMarkup.match(/type="checkbox"/g)?.length).toBe(
      WHITELIST_PERMISSION_KEYS.length - 1
    );

    store.setState({ busyKey: "all" });
    const allBusyMarkup: string = renderToStaticMarkup(
      createElement(PermissionDrawer, {
        entry: partialEntry,
        descriptors: [],
        onUpdated: (): void => undefined,
        onClose: (): void => undefined,
        storeFactory: () => store,
      })
    );
    expect(allBusyMarkup.match(/perm-chip is-loading/g)?.length).toBe(
      WHITELIST_PERMISSION_KEYS.length
    );
    expect(allBusyMarkup.match(/perm-chip-skeleton-switch/g)?.length).toBe(
      WHITELIST_PERMISSION_KEYS.length
    );
    expect(allBusyMarkup.match(/type="checkbox"/g) ?? []).toHaveLength(0);
    store.setState({ busyKey: null });

    let capturedEnableAllClick: (() => void) | undefined;
    const ClickCaptureProbe = (): ReturnType<typeof createElement> => {
      const tree = PermissionDrawer({
        entry: {
          ...partialEntry,
          permissions: fullPermissions,
        },
        descriptors: [],
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
    (totpStore as { getInitialState: typeof totpStore.getState }).getInitialState =
      totpStore.getState;
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

    totpStore.setState({
      loadingStatus: false,
      totpStatus: { enabled: true, createdAt: 1_700_000_000_000, maskedSecret: "ABCD••••" },
      setupData: null,
      busy: true,
    });
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
  });

  test("CSS 滑动动画曲线、浅色下拉看板变量与 Windows TG / Pixel 6.3 英寸响应式断点核验", async () => {
    const stylesDir: string = `${import.meta.dir}/../../packages/mini-app-frontend/styles`;
    const baseCss: string = await Bun.file(`${stylesDir}/base.css`).text();
    const primitivesCss: string = await Bun.file(`${stylesDir}/primitives.css`).text();
    const statusCss: string = await Bun.file(`${stylesDir}/status.css`).text();
    const chatsCss: string = await Bun.file(`${stylesDir}/chats.css`).text();
    const identitiesCss: string = await Bun.file(`${stylesDir}/identities.css`).text();
    const authCss: string = await Bun.file(`${stylesDir}/auth.css`).text();
    const galleryCss: string = await Bun.file(`${stylesDir}/gallery.css`).text();

    // 1. 下拉看板与内部卡片使用更淡的背景色变量（功能配置、Bot 权限、权限配置）
    expect(baseCss).toContain("--cap-expanded-bg:");
    expect(baseCss).toContain("--dropdown-board-bg:");
    expect(baseCss).toContain("--dropdown-board-border:");
    expect(baseCss).toContain("--dropdown-item-bg:");
    expect(baseCss).toContain("--dropdown-item-border:");
    expect(statusCss).toContain("var(--dropdown-item-bg)");
    expect(statusCss).toContain("var(--dropdown-item-border)");
    expect(chatsCss).toContain("var(--dropdown-board-bg)");
    expect(chatsCss).toContain("var(--dropdown-item-bg)");
    expect(identitiesCss).toContain("var(--dropdown-board-bg)");
    expect(identitiesCss).toContain("var(--dropdown-item-bg)");

    // 2. 下拉展开与关闭滑动动画统一采用平滑 S 缓动曲线与逐帧折叠样式规则
    for (const css of [primitivesCss, statusCss, chatsCss, identitiesCss, authCss, galleryCss]) {
      expect(css).not.toContain("cubic-bezier(0.37, 0, 0.63, 1)");
      expect(css).toContain(`cubic-bezier(${MINI_APP_FLIP_COLLAPSE_EASING_POINTS.join(", ")})`);
    }
    expect(baseCss).toContain("overflow-anchor: none;");
    // 逐帧跟滚以 `scrollBy({ behavior: "auto" })` 即时写入，样式表不得设置 `scroll-behavior`。
    for (const css of [baseCss, primitivesCss, statusCss, chatsCss, identitiesCss, authCss, galleryCss]) {
      expect(css).not.toMatch(/(?<![\w-])scroll-behavior\s*:/u);
    }
    expect(primitivesCss).not.toContain(".card.flip-card-clip");
    expect(chatsCss).not.toContain(".chat-targets-form.flip-card-clip");
    expect(chatsCss).not.toContain("miniapp-qa-collapse-overflow-reveal");
    expect(authCss).not.toContain("miniapp-totp-collapse-overflow-reveal");
    expect(statusCss).toContain(".cap-collapse-inner");
    expect(statusCss).toContain(".cap-collapse-wrap.flip-closing");
    expect(chatsCss).toContain("@keyframes miniapp-tab-slide-forward");
    expect(chatsCss).toContain("@keyframes miniapp-tab-slide-backward");
    expect(chatsCss).toContain("animation: miniapp-tab-slide-forward");
    expect(chatsCss).toContain("animation: miniapp-tab-slide-backward");
    expect(chatsCss).toContain("animation: miniapp-popover-drop-out");
    expect(identitiesCss).toContain(".perm-drawer-collapse-grid.expanded");
    expect(identitiesCss).toContain(".perm-drawer-collapse-grid.flip-closing");
    expect(authCss).toContain(".totp-start-submit.is-loading");
    expect(galleryCss).toContain(".gallery-preview-collapse-grid.flip-closing");
    expect(galleryCss).toContain(".gallery-preview-collapse-grid.expanded ~ .card");
    // 预览展开与收起飞行中，其后的一览卡片都不作为滚动锚点，视口只由逐帧跟滚与收起回落驱动。
    expect(galleryCss).toContain(".gallery-preview-collapse-grid.flip-closing ~ .card");
    // 展开态与飞行中的内层面板常驻合成层；触屏下被折叠动画推移的行与卡片常驻合成层，推移时不重绘
    expect(statusCss).toContain(".cap-collapse-wrap.expanded > .cap-collapse-inner");
    expect(identitiesCss).toContain(".perm-drawer-collapse-grid.flip-closing > .perm-drawer-collapse-inner");
    expect(galleryCss).toContain(".gallery-preview-collapse-grid.expanded > .gallery-preview-collapse-inner");
    for (const css of [statusCss, identitiesCss, chatsCss, galleryCss]) {
      expect(css).toContain("@media (hover: none) and (pointer: coarse)");
    }
    expect(galleryCss).toContain(".gallery-preview-collapse-grid ~ .card { will-change: transform; }");
    expect(galleryCss).toContain("height: clamp(220px, 42vh, 320px);");

    // 3. 覆盖 Windows Telegram Mini App 默认宽度（~380px–420px）与 Pixel 6.3 英寸初始宽度（~393px–412px）的 440px 断点及紧凑/桌面断点
    expect(identitiesCss).toContain("@media (max-width: 440px)");
    expect(chatsCss).toContain("@media (max-width: 440px)");
    expect(identitiesCss).toContain("@media (max-width: 350px)");
    expect(chatsCss).toContain("@media (max-width: 350px)");
    expect(primitivesCss).toContain("@media (min-width: 720px)");
  });
});
