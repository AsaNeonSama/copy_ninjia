import type React from "react";
import {
  MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS,
  MINI_APP_FLIP_PAIRED_SLIDE_MAX_PX,
  MINI_APP_FLIP_TRIGGER_SLIDE_MAX_PX,
} from "../../consts/miniApp/animation";
import { startViewportAnchorScroll } from "./expandFollowScroll";
import type {
  ViewportAnchorScroll,
  ViewportAnchorScrollTarget,
} from "./expandFollowScroll";
import {
  computeFlipCollapseDurationMs,
  findPairedTriggerElement,
  formatFlipOpacity,
  formatTranslate3dYWithDpr,
  hasCollapsedFlipGridAncestor,
  resolveFlipDevicePixelRatio,
  resolveInlineNoticeFlexGap,
  shouldFadeInnerPanel,
  snapFlipPxWithDpr,
} from "./flipCollapseGeometry";
import type {
  FlipAnimatableElement,
  FlipDataset,
  FlipFollowScrollResolver,
  FlipStyleDeclaration,
  InlineNoticeFlexGapCompensation,
} from "./flipCollapseGeometry";
import { runFrameMotion } from "./frameMotion";

/** `runFlipCollapseTransition` 执行单次折叠过渡的参数接口。 */
export interface RunFlipCollapseTransitionOptions {
  /** 外层折叠裁剪容器节点。 */
  readonly gridEl: FlipAnimatableElement;
  /** 内层刚性高度内容节点。 */
  readonly innerEl: FlipAnimatableElement;
  /** 当前目标是否为展开态。 */
  readonly expanded: boolean;
  /** 本次提交前该面板是否已处于展开或飞行布局态（无打断进度时从完全展开起步）。 */
  readonly wasOneFrInDom: boolean;
  /** 是否同步对内层节点执行透明度过渡（缺省按容器类名自动判定）。 */
  readonly fadeInner?: boolean;
  /** 收起过渡结束时的清理通知回调（同步复位 `closingActiveRef`）。 */
  readonly onClosingCleared?: () => void;
  /** 展开起始时解析同帧视口跟滚目标的回调（入参为展开完成后的高度）。 */
  readonly resolveFollowScroll?: FlipFollowScrollResolver;
  /** 收起起始时解析同帧视口滚动目标的回调（入参为将收掉的高度）。 */
  readonly resolveCollapseScroll?: FlipFollowScrollResolver;
  /** 多个面板可同时过渡时共享的跟滚槽位：新的视口滚动启动时停止槽内旧滚动，仅保留最后启动的一次驱动视口。 */
  readonly followScrollSlotRef?: React.RefObject<ViewportAnchorScroll | null>;
}

/**
 * 执行折叠面板的展开/收起逐帧过渡：
 * 1. 在浏览器绘制前按设备物理像素网格测量内层面板与可选配对触发器的自然高度，写入首帧样式。
 * 2. 由 `runFrameMotion` 单一时钟（采样 `MINI_APP_FLIP_COLLAPSE_EASING_POINTS` 三次贝塞尔曲线）逐帧同步提交外层 `height`、内层 `translate3d`/`opacity`、配对触发器位移/透明度、Flex 间距补偿与可选视口滚动。
 * 3. 无配对触发器时面板下沿与裁剪框下沿逐帧 1:1 对齐；有配对触发器时面板在 `MINI_APP_FLIP_PAIRED_SLIDE_MAX_PX` 行程内滑动并与触发按钮交叉渐变。过渡时长取 `computeFlipCollapseDurationMs` 乘以剩余进度。
 *
 * @param options 外层节点、内层节点、目标展开态、视口滚动与结束回调
 * @returns 取消本次动画的清理函数（记录打断进度并清除行内样式；无需动画时返回 `undefined`）
 */
export function runFlipCollapseTransition({
  gridEl,
  innerEl,
  expanded,
  wasOneFrInDom,
  fadeInner,
  onClosingCleared,
  resolveFollowScroll,
  resolveCollapseScroll,
  followScrollSlotRef,
}: RunFlipCollapseTransitionOptions): (() => void) | undefined {
  const gridStyle: FlipStyleDeclaration | undefined = gridEl.style;
  const innerStyle: FlipStyleDeclaration | undefined = innerEl.style;
  if (gridStyle === undefined || innerStyle === undefined || typeof gridEl.getBoundingClientRect !== "function") {
    if (!expanded) {
      gridEl.classList?.remove("flip-closing");
      onClosingCleared?.();
    }
    return undefined;
  }

  // 若外层折叠网格也在同一次提交中收起，内层维持展开布局随外层整体收起。
  if (hasCollapsedFlipGridAncestor(gridEl)) {
    if (!expanded) {
      gridEl.classList?.add("flip-closing");
      const ancestorTimer: ReturnType<typeof setTimeout> = setTimeout((): void => {
        gridEl.classList?.remove("flip-closing");
        onClosingCleared?.();
      }, MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS);
      return (): void => {
        clearTimeout(ancestorTimer);
        gridEl.classList?.remove("flip-closing");
      };
    }
    return undefined;
  }

  const triggerEl: FlipAnimatableElement | null = findPairedTriggerElement(gridEl);
  const triggerInnerStyle: FlipStyleDeclaration | undefined = triggerEl?.firstElementChild?.style;

  if (!expanded) {
    gridEl.classList?.add("flip-closing");
    if (triggerEl !== null) {
      triggerEl.classList?.remove("flip-closing");
      if (triggerEl.dataset !== undefined) delete triggerEl.dataset.flipTriggerClosing;
    }
  } else {
    gridEl.classList?.remove("flip-closing");
    if (triggerEl !== null) {
      triggerEl.classList?.add("flip-closing");
      if (triggerEl.dataset !== undefined) triggerEl.dataset.flipTriggerClosing = "1";
    }
  }

  const innerDataset: FlipDataset | undefined = innerEl.dataset;
  const interruptedProgress: number = Number(innerDataset?.flipInterruptedProgress ?? Number.NaN);
  if (innerDataset !== undefined) delete innerDataset.flipInterruptedProgress;

  gridStyle.height = "";
  gridStyle.marginTop = "";
  if (gridStyle.marginBottom !== undefined && gridStyle.marginBottom !== "") {
    gridStyle.marginBottom = "";
  }

  const dpr: number = resolveFlipDevicePixelRatio();
  const triggerH: number =
    triggerEl !== null && typeof triggerEl.getBoundingClientRect === "function"
      ? Math.max(0, snapFlipPxWithDpr(triggerEl.getBoundingClientRect().height, dpr))
      : 0;
  const measuredGridH: number = Math.max(
    0,
    snapFlipPxWithDpr(gridEl.getBoundingClientRect().height, dpr)
  );
  const measuredInnerH: number =
    typeof innerEl.getBoundingClientRect === "function"
      ? Math.max(0, snapFlipPxWithDpr(innerEl.getBoundingClientRect().height, dpr))
      : 0;
  const deltaH: number = Math.max(measuredGridH, measuredInnerH);
  if (deltaH <= 0) {
    if (!expanded) {
      gridEl.classList?.remove("flip-closing");
      onClosingCleared?.();
    } else if (triggerEl !== null) {
      triggerEl.classList?.remove("flip-closing");
      if (triggerEl.dataset !== undefined) delete triggerEl.dataset.flipTriggerClosing;
    }
    return undefined;
  }

  const collapsedH: number = triggerH;
  const spanH: number = snapFlipPxWithDpr(Math.max(deltaH, triggerH) - collapsedH, dpr);
  const inlineNoticeGap: InlineNoticeFlexGapCompensation | null =
    triggerH === 0 ? resolveInlineNoticeFlexGap(gridEl, dpr) : null;
  const slideRangePx: number =
    triggerH > 0 ? Math.min(deltaH, MINI_APP_FLIP_PAIRED_SLIDE_MAX_PX) : deltaH;
  const triggerSlidePx: number = Math.min(triggerH, MINI_APP_FLIP_TRIGGER_SLIDE_MAX_PX);
  const shouldFadeInner: boolean = fadeInner ?? (triggerH > 0 || shouldFadeInnerPanel(gridEl));
  const progressStart: number = Number.isFinite(interruptedProgress)
    ? Math.min(1, Math.max(0, interruptedProgress))
    : wasOneFrInDom
      ? 1
      : 0;
  const progressEnd: number = expanded ? 1 : 0;
  let currentProgress: number = progressStart;

  const writeFrame = (progress: number): void => {
    currentProgress = progress;
    const currentHeightPx: number = snapFlipPxWithDpr(
      collapsedH + spanH * progress,
      dpr
    );
    gridStyle.height = `${currentHeightPx}px`;
    const rawInnerOffsetYPx: number =
      triggerH > 0
        ? -slideRangePx * (1 - progress)
        : currentHeightPx - deltaH;
    innerStyle.transform = formatTranslate3dYWithDpr(rawInnerOffsetYPx, dpr);
    if (inlineNoticeGap !== null) {
      const compensatedGapPx: number = snapFlipPxWithDpr(
        -inlineNoticeGap.gapPx * (1 - progress),
        dpr
      );
      if (inlineNoticeGap.side === "top") {
        gridStyle.marginTop = `${compensatedGapPx}px`;
      } else {
        gridStyle.marginBottom = `${compensatedGapPx}px`;
      }
    }
    if (shouldFadeInner) innerStyle.opacity = formatFlipOpacity(progress);
    if (triggerH > 0 && triggerInnerStyle !== undefined) {
      triggerInnerStyle.transform = formatTranslate3dYWithDpr(
        -triggerSlidePx * progress,
        dpr
      );
      triggerInnerStyle.opacity = formatFlipOpacity(1 - progress);
    }
  };

  if (triggerH > 0) gridStyle.marginTop = `${-triggerH}px`;
  innerStyle.willChange = shouldFadeInner ? "transform, opacity" : "transform";
  innerStyle.pointerEvents = expanded ? "" : "none";
  if (triggerH > 0 && triggerInnerStyle !== undefined) {
    triggerInnerStyle.willChange = "transform, opacity";
  }
  writeFrame(progressStart);
  if (innerDataset !== undefined) innerDataset.flipInFlight = "1";

  let followScroll: ViewportAnchorScroll | null = null;
  const followScrollTarget: ViewportAnchorScrollTarget | null = expanded
    ? resolveFollowScroll?.(gridEl, snapFlipPxWithDpr(collapsedH + spanH, dpr)) ?? null
    : resolveCollapseScroll?.(gridEl, snapFlipPxWithDpr(spanH * progressStart, dpr)) ?? null;
  if (followScrollTarget !== null) {
    followScroll = startViewportAnchorScroll(followScrollTarget);
    if (followScrollSlotRef !== undefined) {
      followScrollSlotRef.current?.dispose();
      followScrollSlotRef.current = followScroll;
    }
  }

  const disposeFollowScroll = (): void => {
    if (followScroll === null) return;
    followScroll.dispose();
    if (followScrollSlotRef?.current === followScroll) followScrollSlotRef.current = null;
    followScroll = null;
  };

  const clearInlineStyles = (): void => {
    if (triggerEl !== null) {
      triggerEl.classList?.remove("flip-closing");
      if (triggerEl.dataset !== undefined) delete triggerEl.dataset.flipTriggerClosing;
    }
    if (triggerInnerStyle !== undefined) {
      triggerInnerStyle.transform = "";
      triggerInnerStyle.willChange = "";
      triggerInnerStyle.opacity = "";
    }
    gridEl.classList?.remove("flip-closing");
    gridStyle.height = "";
    gridStyle.marginTop = "";
    if (gridStyle.marginBottom !== undefined && gridStyle.marginBottom !== "") {
      gridStyle.marginBottom = "";
    }
    innerStyle.transform = "";
    innerStyle.willChange = "";
    innerStyle.opacity = "";
    innerStyle.pointerEvents = "";
    if (innerDataset !== undefined) delete innerDataset.flipInFlight;
  };

  let finished: boolean = false;
  const cancelMotion: () => void = runFrameMotion({
    durationMs: Math.round(
      computeFlipCollapseDurationMs(spanH, expanded) * Math.abs(progressEnd - progressStart)
    ),
    onFrame: (easedProgress: number): void => {
      writeFrame(progressStart + (progressEnd - progressStart) * easedProgress);
      followScroll?.step(easedProgress);
    },
    onFinish: (): void => {
      finished = true;
      disposeFollowScroll();
      clearInlineStyles();
      if (!expanded) {
        gridEl.classList?.remove("flip-closing");
        onClosingCleared?.();
      }
    },
  });

  return (): void => {
    if (finished) return;
    cancelMotion();
    disposeFollowScroll();
    if (innerDataset !== undefined) innerDataset.flipInterruptedProgress = String(currentProgress);
    clearInlineStyles();
  };
}
