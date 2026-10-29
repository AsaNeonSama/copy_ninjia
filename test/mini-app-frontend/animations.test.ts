/**
 * Mini App 前端折叠动画辅助、名单弹窗 Tab 切换过渡、QA 问答对卡片结构，
 * 以及直接针对 CSS 滑动动画曲线、下拉看板浅色背景变量和 Windows TG / Pixel 6.3" 断点规则的核验。
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CollapseGrid,
  createCollapseGridTransitionEndHandler,
} from "../../packages/mini-app-frontend/components/animations/CollapseGrid";
import {
  computeExpandFollowScrollDelta,
  computePreviewCardScrollDelta,
  scrollViewportToExpandedBody,
  scrollViewportToPreviewCard,
} from "../../packages/mini-app-frontend/components/animations/expandFollowScroll";
import type {
  ViewportRectElement,
  ViewportScrollByParams,
} from "../../packages/mini-app-frontend/components/animations/expandFollowScroll";
import {
  findPairedTriggerElement,
  formatTranslate3dY,
  hasCollapsedFlipGridAncestor,
  parseCurrentTranslateYPx,
  readElementCurrentTranslateYPx,
  runFlipCollapseTransition,
  syncFlipCollapseLayoutEffect,
} from "../../packages/mini-app-frontend/components/animations/flipCollapse";
import type {
  FlipAnimatableElement,
  FlipClassList,
  FlipTransitionEndEvent,
} from "../../packages/mini-app-frontend/components/animations/flipCollapse";
import {
  resolveTabSlideDirectionClass,
  TabHeightSizer,
} from "../../packages/mini-app-frontend/components/animations/TabHeightSizer";
import { ChatFeatureListCard } from "../../packages/mini-app-frontend/components/ChatFeatureListCard";
import { ChatTargetsModal } from "../../packages/mini-app-frontend/components/ChatTargetsModal";
import { PermissionDrawer } from "../../packages/mini-app-frontend/components/PermissionDrawer";
import {
  MINI_APP_EXPAND_SCROLL_BOTTOM_MARGIN_PX,
  MINI_APP_EXPAND_SCROLL_COMFORT_BODY_FACTOR,
  MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX,
  MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX,
  MINI_APP_FEATURE_KEYS,
  MINI_APP_FLIP_COLLAPSE_EASING,
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

/** 测试直接调用的 `onTransitionEnd` 处理函数形状。 */
type TransitionEndHandler = (event: {
  readonly target: unknown;
  readonly currentTarget: unknown;
  readonly propertyName: string;
}) => void;

/** 取出 `CollapseGrid` 外层网格的 `onTransitionEnd` 处理函数。 */
function readTransitionEndHandler(
  expanded: boolean,
  onExpandEnd: ((gridElement: ViewportRectElement) => void) | undefined
): TransitionEndHandler | undefined {
  return createCollapseGridTransitionEndHandler(
    expanded,
    onExpandEnd
  ) as unknown as TransitionEndHandler | undefined;
}

/** 构造模拟的 `FlipClassList`。 */
function createMockClassList(initial: readonly string[] = []): FlipClassList & {
  readonly tokens: Set<string>;
} {
  const tokens: Set<string> = new Set<string>(initial);
  return {
    tokens,
    add: (...items: string[]): void => {
      for (const item of items) tokens.add(item);
    },
    remove: (...items: string[]): void => {
      for (const item of items) tokens.delete(item);
    },
    contains: (token: string): boolean => tokens.has(token),
  };
}

describe("折叠动画辅助", () => {
  test("展开跟滚距离：内容溢出视口底部时下滑到底边距，以标题栏保留上边距为上限，标题栏偏下时按内容比例上移", () => {
    const viewportHeight: number = 800;
    expect(
      computeExpandFollowScrollDelta({ blockTop: 100, bodyTop: 150, bodyHeight: 800 }, viewportHeight)
    ).toBe(100 - MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX);
    expect(
      computeExpandFollowScrollDelta({ blockTop: 200, bodyTop: 250, bodyHeight: 700 }, viewportHeight)
    ).toBe(250 + 700 + MINI_APP_EXPAND_SCROLL_BOTTOM_MARGIN_PX - viewportHeight);
    expect(
      computeExpandFollowScrollDelta({ blockTop: 500, bodyTop: 550, bodyHeight: 100 }, viewportHeight)
    ).toBe(Math.round(100 * MINI_APP_EXPAND_SCROLL_COMFORT_BODY_FACTOR));
    expect(
      computeExpandFollowScrollDelta({ blockTop: 50, bodyTop: 100, bodyHeight: 100 }, viewportHeight)
    ).toBe(0);
    expect(
      computeExpandFollowScrollDelta({ blockTop: -40, bodyTop: 10, bodyHeight: 200 }, viewportHeight)
    ).toBe(-40 - MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX);
    expect(computePreviewCardScrollDelta(-120)).toBe(-120 - MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX);
    expect(computePreviewCardScrollDelta(20)).toBe(20 - MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX);
    expect(computePreviewCardScrollDelta(178)).toBe(178 - MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX);
  });

  test("展开跟滚与图库预览固定位置滚动：支持正向与负向平滑滚动，位移不足或缺少接口时不滚动", () => {
    const host: { innerHeight?: number; scrollBy?: unknown } = globalThis as {
      innerHeight?: number;
      scrollBy?: unknown;
    };
    const prevInnerHeight: number | undefined = host.innerHeight;
    const prevScrollBy: unknown = host.scrollBy;
    const scrollCalls: ViewportScrollByParams[] = [];
    host.innerHeight = 800;
    host.scrollBy = (options: ViewportScrollByParams): void => {
      scrollCalls.push(options);
    };
    try {
      const expectedTop: number = Math.round(100 * MINI_APP_EXPAND_SCROLL_COMFORT_BODY_FACTOR);
      expect(expectedTop).toBeGreaterThan(MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX);
      scrollViewportToExpandedBody({ blockTop: 500, bodyTop: 550, bodyHeight: 100 });
      scrollViewportToExpandedBody({ blockTop: 50, bodyTop: 100, bodyHeight: 100 });
      scrollViewportToExpandedBody({ blockTop: 500, bodyTop: 550, bodyHeight: 0 });
      scrollViewportToExpandedBody({ blockTop: -30, bodyTop: 20, bodyHeight: 200 });
      expect(scrollCalls).toEqual([
        { top: expectedTop, behavior: "smooth" },
        { top: -30 - MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX, behavior: "smooth" },
      ]);

      scrollCalls.length = 0;
      scrollViewportToPreviewCard(null);
      scrollViewportToPreviewCard({});
      scrollViewportToPreviewCard({
        getBoundingClientRect: (): { readonly top: number; readonly height: number } => ({
          top: MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX + 2,
          height: 450,
        }),
      });
      scrollViewportToPreviewCard({
        getBoundingClientRect: (): { readonly top: number; readonly height: number } => ({
          top: -80,
          height: 450,
        }),
      });
      scrollViewportToPreviewCard({
        getBoundingClientRect: (): { readonly top: number; readonly height: number } => ({
          top: 178,
          height: 450,
        }),
      });
      expect(scrollCalls).toEqual([
        { top: -80 - MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX, behavior: "smooth" },
        { top: 178 - MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX, behavior: "smooth" },
      ]);
    } finally {
      host.innerHeight = prevInnerHeight;
      host.scrollBy = prevScrollBy;
    }
  });

  test("CollapseGrid 只在展开态下自身 height 或 grid-template-rows 过渡结束时回调 onExpandEnd", () => {
    const gridNode: ViewportRectElement = {
      getBoundingClientRect: (): { readonly top: number; readonly height: number } => ({ top: 0, height: 0 }),
    };
    const expandEnds: ViewportRectElement[] = [];
    const onExpandEnd = (gridElement: ViewportRectElement): void => {
      expandEnds.push(gridElement);
    };
    const expandedHandler: TransitionEndHandler | undefined = readTransitionEndHandler(true, onExpandEnd);
    expandedHandler?.({ target: gridNode, currentTarget: gridNode, propertyName: "opacity" });
    expandedHandler?.({ target: {}, currentTarget: gridNode, propertyName: "grid-template-rows" });
    expandedHandler?.({ target: gridNode, currentTarget: gridNode, propertyName: "grid-template-rows" });
    expandedHandler?.({ target: gridNode, currentTarget: gridNode, propertyName: "height" });
    expect(expandEnds).toEqual([gridNode, gridNode]);
    readTransitionEndHandler(false, onExpandEnd)?.({
      target: gridNode,
      currentTarget: gridNode,
      propertyName: "grid-template-rows",
    });
    expect(expandEnds).toEqual([gridNode, gridNode]);
    expect(readTransitionEndHandler(true, undefined)).toBeUndefined();
    expect(
      renderToStaticMarkup(
        createElement(CollapseGrid, {
          expanded: true,
          gridClassName: "g",
          innerClassName: "i",
          children: null,
        })
      )
    ).toContain('class="g expanded"');
  });

  test("GPU FLIP 折叠引擎：外层容器 height 与刚性内层 translate3d 同步伸缩、半途打断平滑续接及收起零延迟复位", async () => {
    expect(parseCurrentTranslateYPx("")).toBe(0);
    expect(parseCurrentTranslateYPx("none")).toBe(0);
    expect(parseCurrentTranslateYPx("matrix(1, 0, 0, 1, 0, -145.2)")).toBe(-145);
    expect(
      parseCurrentTranslateYPx(
        "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -88.4, 0, 1)"
      )
    ).toBe(-88);
    expect(parseCurrentTranslateYPx("translate3d(0px, -120px, 0px)")).toBe(-120);
    expect(parseCurrentTranslateYPx("translateY(42px)")).toBe(42);
    expect(readElementCurrentTranslateYPx(null)).toBe(0);
    expect(formatTranslate3dY(0)).toBe("translate3d(0, 0, 0)");
    expect(formatTranslate3dY(-180)).toBe("translate3d(0, -180px, 0)");

    const sectionEl: FlipAnimatableElement = {
      tagName: "SECTION",
      dataset: {},
      style: { transform: "", transition: "", willChange: "" },
      getBoundingClientRect: () => ({ top: 0, height: 900 }),
    };
    const cardEl: FlipAnimatableElement = {
      parentElement: sectionEl,
      classList: createMockClassList(["card"]),
      dataset: {},
      style: { transform: "", transition: "", willChange: "" },
      getBoundingClientRect: () => ({ top: 60, height: 240 }),
    };

    const transitionEndHandler: {
      current: ((event: FlipTransitionEndEvent) => void) | null;
    } = { current: null };
    const innerEl: FlipAnimatableElement = {
      style: { transform: "", transition: "", willChange: "", opacity: "", pointerEvents: "" },
      dataset: {},
      getBoundingClientRect: () => ({ top: 100, height: 180 }),
      addEventListener: (
        type: string,
        listener: (event: FlipTransitionEndEvent) => void
      ): void => {
        if (type === "transitionend") {
          transitionEndHandler.current = listener;
        }
      },
      removeEventListener: (
        type: string,
        listener: (event: FlipTransitionEndEvent) => void
      ): void => {
        if (type === "transitionend" && transitionEndHandler.current === listener) {
          transitionEndHandler.current = null;
        }
      },
    };
    let gridHeightPx: number = 180;
    const gridClassList = createMockClassList(["chat-targets-qa-collapse-grid"]);
    const gridEl: FlipAnimatableElement = {
      parentElement: cardEl,
      classList: gridClassList,
      dataset: {},
      style: { height: "", transform: "", transition: "", willChange: "" },
      offsetWidth: 360,
      getBoundingClientRect: () => ({ top: 100, height: gridHeightPx }),
    };

    expect(hasCollapsedFlipGridAncestor(gridEl)).toBeFalse();

    // 1. 展开过渡：t=0 帧 height="0px" 且 transform="translate3d(0, -180px, 0)"，微任务同步过渡到 180px 与 0px
    const expandEndNodes: ViewportRectElement[] = [];
    const cleanupExpand = runFlipCollapseTransition({
      gridEl,
      innerEl,
      expanded: true,
      wasOneFrInDom: false,
      onExpandEnd: (el): void => {
        expandEndNodes.push(el);
      },
    });
    expect(gridEl.style?.height).toBe("0px");
    expect(innerEl.style?.transform).toBe("translate3d(0, -180px, 0)");
    expect(innerEl.style?.opacity).toBe("0");

    await Promise.resolve();
    expect(gridEl.style?.height).toBe("180px");
    expect(gridEl.style?.transition).toContain(MINI_APP_FLIP_COLLAPSE_EASING);
    expect(innerEl.style?.transform).toBe("translate3d(0, 0, 0)");
    expect(innerEl.style?.opacity).toBe("1");
    expect(innerEl.style?.transition).toContain(MINI_APP_FLIP_COLLAPSE_EASING);

    transitionEndHandler.current?.({ target: innerEl, propertyName: "transform" });
    expect(gridEl.style?.height).toBe("");
    expect(innerEl.style?.transform).toBe("");
    expect(expandEndNodes).toEqual([gridEl]);
    cleanupExpand?.();

    // 2. 收起过渡：外层容器 height 从 180px 同步缩至 0px，内层面板从 0px 上滑至 -180px，动画结束时容器已是 0px 零弹跳
    let closingClearedCount: number = 0;
    const cleanupCollapse = runFlipCollapseTransition({
      gridEl,
      innerEl,
      expanded: false,
      wasOneFrInDom: true,
      onClosingCleared: (): void => {
        closingClearedCount += 1;
      },
    });
    expect(gridClassList.contains("flip-closing")).toBeTrue();
    expect(gridEl.style?.height).toBe("180px");
    expect(innerEl.style?.transform).toBe("translate3d(0, 0, 0)");
    expect(innerEl.style?.opacity).toBe("1");

    await Promise.resolve();
    expect(gridEl.style?.height).toBe("0px");
    expect(innerEl.style?.transform).toBe("translate3d(0, -180px, 0)");
    expect(innerEl.style?.opacity).toBe("0");

    expect(transitionEndHandler.current).not.toBeNull();
    transitionEndHandler.current?.({ target: innerEl, propertyName: "transform" });
    expect(closingClearedCount).toBe(1);
    expect(gridClassList.contains("flip-closing")).toBeFalse();
    expect(gridEl.style?.height).toBe("");
    expect(innerEl.style?.transform).toBe("");
    expect(innerEl.style?.opacity).toBe("");
    cleanupCollapse?.();

    // 3. 半途打断反向续接：在收起半途（height=72px, translateY=-108px）打断并重新展开，从采样位置平滑恢复
    const cleanupMidFlight = runFlipCollapseTransition({
      gridEl,
      innerEl,
      expanded: false,
      wasOneFrInDom: true,
    });
    await Promise.resolve();
    gridHeightPx = 72;
    if (innerEl.style !== undefined) {
      innerEl.style.transform = "translate3d(0, -108px, 0)";
    }
    cleanupMidFlight?.();
    expect(innerEl.dataset?.flipInterruptedH).toBe("72");
    expect(innerEl.dataset?.flipInterruptedY).toBe("-108");

    gridHeightPx = 180;
    const cleanupReExpand = runFlipCollapseTransition({
      gridEl,
      innerEl,
      expanded: true,
      wasOneFrInDom: true,
    });
    expect(gridEl.style?.height).toBe("72px");
    expect(innerEl.style?.transform).toBe("translate3d(0, -108px, 0)");
    await Promise.resolve();
    expect(gridEl.style?.height).toBe("180px");
    expect(innerEl.style?.transform).toBe("translate3d(0, 0, 0)");
    transitionEndHandler.current?.({ target: innerEl, propertyName: "transform" });
    cleanupReExpand?.();

    // 4. 配对 TriggerCollapseGrid + CollapseGrid（验证器与 QA 编辑）：同起点 marginTop 重叠、46px <-> 180px 平滑过渡与原子清理
    const triggerInnerEl: FlipAnimatableElement = {
      style: { transform: "", transition: "", willChange: "", opacity: "" },
      getBoundingClientRect: () => ({ top: 100, height: 46 }),
    };
    const triggerClassList = createMockClassList(["totp-trigger-collapse-grid"]);
    const triggerEl: FlipAnimatableElement = {
      classList: triggerClassList,
      dataset: { flipTrigger: "1" },
      firstElementChild: triggerInnerEl,
      getBoundingClientRect: () => ({ top: 100, height: 46 }),
    };
    const pairedGridEl: FlipAnimatableElement = {
      parentElement: cardEl,
      previousElementSibling: triggerEl,
      classList: createMockClassList(["totp-setup-collapse-grid"]),
      dataset: {},
      style: { height: "", marginTop: "", transform: "", transition: "", willChange: "" },
      offsetWidth: 360,
      getBoundingClientRect: () => ({ top: 100, height: 180 }),
    };
    expect(findPairedTriggerElement(pairedGridEl)).toBe(triggerEl);

    const cleanupPairedExpand = runFlipCollapseTransition({
      gridEl: pairedGridEl,
      innerEl,
      expanded: true,
      wasOneFrInDom: false,
    });
    expect(triggerClassList.contains("flip-closing")).toBeTrue();
    expect(pairedGridEl.style?.marginTop).toBe("-46px");
    expect(pairedGridEl.style?.height).toBe("46px");
    expect(triggerInnerEl.style?.opacity).toBe("1");
    expect(innerEl.style?.opacity).toBe("0");
    expect(innerEl.style?.transform).toBe("translate3d(0, -16px, 0)");

    await Promise.resolve();
    expect(pairedGridEl.style?.height).toBe("180px");
    expect(triggerInnerEl.style?.opacity).toBe("0");
    expect(triggerInnerEl.style?.transform).toBe("translate3d(0, -10px, 0)");
    expect(innerEl.style?.opacity).toBe("1");
    expect(innerEl.style?.transform).toBe("translate3d(0, 0, 0)");

    transitionEndHandler.current?.({ target: innerEl, propertyName: "transform" });
    expect(triggerClassList.contains("flip-closing")).toBeFalse();
    expect(pairedGridEl.style?.marginTop).toBe("");
    expect(pairedGridEl.style?.height).toBe("");
    expect(triggerInnerEl.style?.opacity).toBe("");
    cleanupPairedExpand?.();

    const prevExpandedRef = { current: true };
    const prevResetKeyRef = { current: "qa" as string | null };
    const closingActiveRef = { current: true };
    const syncCleanup = syncFlipCollapseLayoutEffect({
      expanded: false,
      resetKey: "qa",
      gridRef: { current: pairedGridEl },
      innerRef: { current: innerEl },
      prevExpandedRef,
      prevResetKeyRef,
      closingActiveRef,
    });
    expect(closingActiveRef.current).toBeTrue();
    expect(pairedGridEl.style?.marginTop).toBe("-46px");
    expect(pairedGridEl.style?.height).toBe("180px");
    await Promise.resolve();
    expect(pairedGridEl.style?.height).toBe("46px");
    transitionEndHandler.current?.({ target: innerEl, propertyName: "transform" });
    expect(closingActiveRef.current).toBeFalse();
    syncCleanup?.();

    const syncExpandNodes: FlipAnimatableElement[] = [];
    const syncExpandCleanup = syncFlipCollapseLayoutEffect({
      expanded: true,
      resetKey: "qa",
      gridRef: { current: pairedGridEl },
      innerRef: { current: innerEl },
      prevExpandedRef,
      prevResetKeyRef,
      closingActiveRef,
      onExpandEnd: (el: FlipAnimatableElement): void => {
        syncExpandNodes.push(el);
      },
    });
    await Promise.resolve();
    transitionEndHandler.current?.({ target: innerEl, propertyName: "transform" });
    expect(syncExpandNodes).toEqual([pairedGridEl]);
    syncExpandCleanup?.();

    expect(
      syncFlipCollapseLayoutEffect({
        expanded: false,
        resetKey: "deleteMessage",
        gridRef: { current: pairedGridEl },
        innerRef: { current: innerEl },
        prevExpandedRef,
        prevResetKeyRef,
        closingActiveRef,
      })
    ).toBeUndefined();
    expect(
      syncFlipCollapseLayoutEffect({
        expanded: false,
        resetKey: "deleteMessage",
        gridRef: { current: pairedGridEl },
        innerRef: { current: innerEl },
        prevExpandedRef,
        prevResetKeyRef,
        closingActiveRef,
      })
    ).toBeUndefined();
  });

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

    // 2. 下拉展开与关闭滑动动画统一采用平滑 S 缓动曲线与 GPU FLIP 折叠样式规则
    for (const css of [primitivesCss, statusCss, chatsCss, identitiesCss, authCss, galleryCss]) {
      expect(css).not.toContain("cubic-bezier(0.37, 0, 0.63, 1)");
      expect(css).toContain(MINI_APP_FLIP_COLLAPSE_EASING);
    }
    expect(baseCss).toContain("overflow-anchor: none;");
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
    expect(galleryCss).toContain("height: clamp(220px, 42vh, 320px);");

    // 3. 覆盖 Windows Telegram Mini App 默认宽度（~380px–420px）与 Pixel 6.3 英寸初始宽度（~393px–412px）的 440px 断点及紧凑/桌面断点
    expect(identitiesCss).toContain("@media (max-width: 440px)");
    expect(chatsCss).toContain("@media (max-width: 440px)");
    expect(identitiesCss).toContain("@media (max-width: 350px)");
    expect(chatsCss).toContain("@media (max-width: 350px)");
    expect(primitivesCss).toContain("@media (min-width: 720px)");
  });
});
