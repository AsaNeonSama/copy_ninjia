import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import type React from "react";
import {
  MINI_APP_FLIP_MAX_DPR,
  MINI_APP_FLIP_MIN_DPR,
  MINI_APP_FLIP_PX_PRECISION_SCALE,
  MINI_APP_INLINE_NOTICE_GRID_CLASS_NAME,
} from "../../consts/animation";
import {
  MINI_APP_FLIP_BOUNDARY_CLASS_NAMES,
  MINI_APP_FLIP_BOUNDARY_TAG_NAMES,
  MINI_APP_FLIP_COLLAPSE_CLOSE_MAX_DURATION_MS,
  MINI_APP_FLIP_COLLAPSE_CLOSE_SPEED_PX_PER_MS,
  MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS,
  MINI_APP_FLIP_COLLAPSE_DURATION_MS,
  MINI_APP_FLIP_FADE_INNER_GRID_CLASS_NAMES,
  MINI_APP_FLIP_PAIRED_SLIDE_MAX_PX,
  MINI_APP_FLIP_TRIGGER_CLASS_NAMES,
  MINI_APP_FLIP_TRIGGER_SLIDE_MAX_PX,
} from "../../consts/miniApp";
import { startViewportAnchorScroll } from "./expandFollowScroll";
import type {
  ViewportAnchorScroll,
  ViewportAnchorScrollTarget,
  ViewportRectElement,
} from "./expandFollowScroll";
import { runFrameMotion } from "./frameMotion";

/** 逐帧写入折叠容器高度与内层面板位移/透明度的行内样式最小接口。 */
export interface FlipStyleDeclaration {
  /** CSS `height` 属性（外层折叠容器逐帧高度）。 */
  height?: string;
  /** CSS `margin-top` 属性（与顶部配对触发器重叠或抵消纵向 Flex 容器上方 `row-gap` 时使用）。 */
  marginTop?: string;
  /** CSS `margin-bottom` 属性（抵消纵向 Flex 容器下方 `row-gap` 时使用）。 */
  marginBottom?: string;
  /** CSS `transform` 属性（内层面板在裁剪框内的纵向位移）。 */
  transform: string;
  /** CSS `will-change` 属性。 */
  willChange: string;
  /** CSS `opacity` 属性。 */
  opacity?: string;
  /** CSS `pointer-events` 属性。 */
  pointerEvents?: string;
}

/** 支持增删与检测 CSS 类名的 `classList` 最小接口。 */
export interface FlipClassList {
  /** 添加一个或多个类名。 */
  readonly add: (...tokens: string[]) => void;
  /** 移除一个或多个类名。 */
  readonly remove: (...tokens: string[]) => void;
  /** 判断是否包含指定类名。 */
  readonly contains: (token: string) => boolean;
}

/** 挂载在折叠面板或配对触发器节点上的飞行状态与半途打断进度 `dataset` 属性。 */
export interface FlipDataset {
  /** 标记当前节点为与下方折叠面板配对的顶部触发器容器（`"1"`）。 */
  flipTrigger?: string;
  /** 标记配对触发器正处于收起飞行态（`"1"` 表示飞行中）。 */
  flipTriggerClosing?: string;
  /** 标记内层面板正处于逐帧动画飞行态（`"1"` 表示飞行中）。 */
  flipInFlight?: string;
  /** 半途打断时记录的展开进度文本（`0..1`，`0` 为收起、`1` 为完全展开），供下一次过渡从该进度续接。 */
  flipInterruptedProgress?: string;
}

/** 支持几何测量、类名切换与行内样式写入的折叠动画 DOM 元素最小接口。 */
export interface FlipAnimatableElement extends ViewportRectElement {
  /** 标签名（大写，如 `"SECTION"`）。 */
  readonly tagName?: string;
  /** 元素 ID。 */
  readonly id?: string;
  /** 元素行内样式对象。 */
  readonly style?: FlipStyleDeclaration;
  /** 元素类名集合。 */
  readonly classList?: FlipClassList;
  /** 元素 `data-*` 属性集。 */
  readonly dataset?: FlipDataset;
  /** 父元素节点。 */
  readonly parentElement?: FlipAnimatableElement | null;
  /** 前一个同级元素节点（定位与折叠面板紧邻配对的 `TriggerCollapseGrid` 或检测纵向 Flex 前序可见兄弟）。 */
  readonly previousElementSibling?: FlipAnimatableElement | null;
  /** 后一个同级元素节点（检测纵向 Flex 后序可见兄弟）。 */
  readonly nextElementSibling?: FlipAnimatableElement | null;
  /** 第一个子元素节点（配对触发器的内层节点）。 */
  readonly firstElementChild?: FlipAnimatableElement | null;
  /** 读取 HTML 属性（检测外层折叠容器是否处于 `aria-hidden="true"` 收起态）。 */
  readonly getAttribute?: (qualifiedName: string) => string | null;
}

/** 浏览器 `globalThis` 上读取设备像素比与节点计算样式的最小宿主接口。 */
interface FlipLayoutHost {
  /** 设备物理像素与 CSS 像素之比。 */
  readonly devicePixelRatio?: number;
  /** 读取节点的计算样式。 */
  readonly getComputedStyle?: (element: FlipAnimatableElement) => {
    readonly display?: string;
    readonly flexDirection?: string;
    readonly rowGap?: string;
  };
}

/** 页内提示折叠容器位于纵向 Flex 父容器内时，需要在展开/收起期间同步插值抵消的 `row-gap` 描述。 */
interface InlineNoticeFlexGapCompensation {
  /** 负边距作用的边缘（存在前序可见兄弟时作用于顶部，否则作用于底部）。 */
  readonly side: "top" | "bottom";
  /** 父容器纵向 `row-gap` 的物理像素对齐值。 */
  readonly gapPx: number;
}

/** 过渡起始时解析同帧视口滚动目标的回调：入参为外层折叠容器与本次过渡的高度（展开为展开完成后的高度，收起为将收掉的高度），返回 `null` 时不滚动。 */
export type FlipFollowScrollResolver = (
  gridElement: FlipAnimatableElement,
  heightPx: number
) => ViewportAnchorScrollTarget | null;

/**
 * 判断折叠容器的 `classList` 是否包含给定候选类名集合中的任意一项。
 *
 * @param classList 待检测的类名集合
 * @param candidates 候选 CSS 类名只读数组
 * @returns 命中任意候选类名时返回 `true`
 */
function hasAnyFlipClass(
  classList: FlipClassList | undefined,
  candidates: readonly string[]
): boolean {
  if (classList === undefined) return false;
  for (const name of candidates) {
    if (classList.contains(name)) return true;
  }
  return false;
}

/**
 * 判断祖先节点是否为页面或弹窗内容区的折叠遍历停止边界。
 *
 * @param element 待判断的祖先节点
 * @returns 到达页面/弹窗边界时返回 `true`
 */
function isFlipBoundaryElement(element: FlipAnimatableElement): boolean {
  if (
    (element.tagName !== undefined &&
      MINI_APP_FLIP_BOUNDARY_TAG_NAMES.includes(element.tagName)) ||
    element.id === "root"
  ) {
    return true;
  }
  return hasAnyFlipClass(element.classList, MINI_APP_FLIP_BOUNDARY_CLASS_NAMES);
}

/**
 * 检测当前折叠网格是否嵌套在另一个正在收起或已收起的外层折叠网格内部
 * （当父子折叠网格在同一提交批次同时收起时，内层维持展开高度随外层整体平滑收起）。
 *
 * @param gridEl 当前折叠网格节点
 * @returns 存在已收起外层折叠网格祖先时返回 `true`
 */
export function hasCollapsedFlipGridAncestor(gridEl: FlipAnimatableElement): boolean {
  let curr: FlipAnimatableElement | null = gridEl.parentElement ?? null;
  while (curr !== null && !isFlipBoundaryElement(curr)) {
    if (
      curr.getAttribute?.("aria-hidden") === "true" ||
      curr.classList?.contains("flip-closing") === true
    ) {
      return true;
    }
    curr = curr.parentElement ?? null;
  }
  return false;
}

/**
 * 判断当前折叠网格在展开/收起时是否同步执行内层透明度渐变（触发按钮与表单互换、图库预览卡片、页内提示横幅等独立面板开启透明度过渡）。
 *
 * @param gridEl 外层折叠网格节点
 * @returns 需要同步渐变 `opacity` 时返回 `true`
 */
export function shouldFadeInnerPanel(gridEl: FlipAnimatableElement): boolean {
  if (gridEl.classList?.contains(MINI_APP_INLINE_NOTICE_GRID_CLASS_NAME) === true) {
    return true;
  }
  return hasAnyFlipClass(
    gridEl.classList,
    MINI_APP_FLIP_FADE_INNER_GRID_CLASS_NAMES
  );
}

/**
 * 读取当前宿主环境的设备物理像素比，夹紧在 `[MINI_APP_FLIP_MIN_DPR, MINI_APP_FLIP_MAX_DPR]` 区间内；
 * 宿主未暴露或非有限正数时回退为 `MINI_APP_FLIP_MIN_DPR`。
 *
 * @returns 夹紧后的设备像素比
 */
function resolveFlipDevicePixelRatio(): number {
  const rawDpr: number | undefined = (globalThis as FlipLayoutHost).devicePixelRatio;
  if (typeof rawDpr !== "number" || !Number.isFinite(rawDpr) || rawDpr <= 0) {
    return MINI_APP_FLIP_MIN_DPR;
  }
  return Math.min(MINI_APP_FLIP_MAX_DPR, Math.max(MINI_APP_FLIP_MIN_DPR, rawDpr));
}

/**
 * 按给定设备像素比将 CSS 像素值对齐到最近的物理像素网格，并消除二进制浮点尾数误差（`-0` 归一为 `0`）。
 *
 * @param valuePx 待对齐的 CSS 像素值
 * @param dpr 已夹紧的设备像素比
 * @returns 对齐到物理像素网格后的 CSS 像素数值
 */
function snapFlipPxWithDpr(valuePx: number, dpr: number): number {
  const snapped: number =
    Math.round((Math.round(valuePx * dpr) / dpr) * MINI_APP_FLIP_PX_PRECISION_SCALE) /
    MINI_APP_FLIP_PX_PRECISION_SCALE;
  return snapped === 0 ? 0 : snapped;
}

/**
 * 按给定设备像素比将纵向偏移对齐到物理像素网格后格式化为 `translate3d(0, Ypx, 0)` 字符串。
 *
 * @param offsetYPx 纵向像素偏移
 * @param dpr 已夹紧的设备像素比
 * @returns CSS `transform` 字符串
 */
function formatTranslate3dYWithDpr(offsetYPx: number, dpr: number): string {
  const snapped: number = snapFlipPxWithDpr(offsetYPx, dpr);
  return snapped === 0 ? "translate3d(0, 0, 0)" : `translate3d(0, ${snapped}px, 0)`;
}

/**
 * 将 CSS 像素值按当前宿主 `devicePixelRatio` 对齐到最近的物理设备像素网格，
 * 并消除二进制浮点尾数误差（`-0` 归一为 `0`）。
 *
 * @param valuePx 待对齐的 CSS 像素值
 * @returns 对齐到物理像素网格后的 CSS 像素数值
 */
export function snapFlipPx(valuePx: number): number {
  return snapFlipPxWithDpr(valuePx, resolveFlipDevicePixelRatio());
}

/**
 * 将 CSS 像素值对齐到物理设备像素网格后格式化为 `<n>px` 字符串。
 *
 * @param valuePx 待格式化的 CSS 像素值
 * @returns CSS 像素长度字符串
 */
export function formatFlipPx(valuePx: number): string {
  return `${snapFlipPx(valuePx)}px`;
}

/**
 * 将纵向像素偏移按物理像素网格对齐后格式化为 `translate3d(0, Ypx, 0)` 字符串。
 *
 * @param offsetYPx 纵向像素偏移
 * @returns CSS `transform` 字符串
 */
export function formatTranslate3dY(offsetYPx: number): string {
  return formatTranslate3dYWithDpr(offsetYPx, resolveFlipDevicePixelRatio());
}

/**
 * 当页内提示折叠容器位于纵向 Flex 父容器内时，解析展开/收起期间需由负边距同步插值抵消的 `row-gap`
 * （收起终态容器为 `display: none` 不产生间距，飞行期 `display: block` 下在进度 `0` 处抵消额外的一份间距）。
 *
 * @param gridEl 外层折叠网格节点
 * @param dpr 已夹紧的设备像素比
 * @returns 需要补偿的边缘与像素值；非页内提示容器或无额外 Flex 间距时返回 `null`
 */
function resolveInlineNoticeFlexGap(
  gridEl: FlipAnimatableElement,
  dpr: number
): InlineNoticeFlexGapCompensation | null {
  if (gridEl.classList?.contains(MINI_APP_INLINE_NOTICE_GRID_CLASS_NAME) !== true) {
    return null;
  }
  const parentEl: FlipAnimatableElement | null = gridEl.parentElement ?? null;
  const host: FlipLayoutHost = globalThis as FlipLayoutHost;
  if (parentEl === null || typeof host.getComputedStyle !== "function") {
    return null;
  }
  try {
    const parentComputed: {
      readonly display?: string;
      readonly flexDirection?: string;
      readonly rowGap?: string;
    } = host.getComputedStyle(parentEl);
    if (
      (parentComputed.display !== "flex" && parentComputed.display !== "inline-flex") ||
      parentComputed.flexDirection !== "column"
    ) {
      return null;
    }
    const rawGap: number = Number.parseFloat(parentComputed.rowGap ?? "");
    if (!Number.isFinite(rawGap) || rawGap <= 0) return null;
    const gapPx: number = snapFlipPxWithDpr(rawGap, dpr);
    if (gapPx <= 0) return null;
    let prev: FlipAnimatableElement | null = gridEl.previousElementSibling ?? null;
    while (prev !== null) {
      if (host.getComputedStyle(prev).display !== "none") {
        return { side: "top", gapPx };
      }
      prev = prev.previousElementSibling ?? null;
    }
    let next: FlipAnimatableElement | null = gridEl.nextElementSibling ?? null;
    while (next !== null) {
      if (host.getComputedStyle(next).display !== "none") {
        return { side: "bottom", gapPx };
      }
      next = next.nextElementSibling ?? null;
    }
    return null;
  } catch (_error: unknown) {
    return null;
  }
}

/**
 * 将 `0..1` 的透明度保留三位小数格式化为 CSS `opacity` 字符串。
 *
 * @param value 透明度
 * @returns CSS `opacity` 字符串
 */
function formatOpacity(value: number): string {
  return String(
    Math.round(value * MINI_APP_FLIP_PX_PRECISION_SCALE) /
      MINI_APP_FLIP_PX_PRECISION_SCALE
  );
}

/**
 * 按过渡方向与高度跨度计算完整过渡的时长：展开固定为 `MINI_APP_FLIP_COLLAPSE_DURATION_MS`；
 * 收起取「跨度 ÷ `MINI_APP_FLIP_COLLAPSE_CLOSE_SPEED_PX_PER_MS`」与展开时长的较大值，并以 `MINI_APP_FLIP_COLLAPSE_CLOSE_MAX_DURATION_MS` 为上限。
 *
 * @param spanPx 收起态与展开态之间的高度跨度
 * @param expanded 目标是否为展开态
 * @returns 从一端到另一端的完整过渡毫秒数
 */
export function computeFlipCollapseDurationMs(spanPx: number, expanded: boolean): number {
  if (expanded) return MINI_APP_FLIP_COLLAPSE_DURATION_MS;
  return Math.min(
    MINI_APP_FLIP_COLLAPSE_CLOSE_MAX_DURATION_MS,
    Math.max(
      MINI_APP_FLIP_COLLAPSE_DURATION_MS,
      Math.round(spanPx / MINI_APP_FLIP_COLLAPSE_CLOSE_SPEED_PX_PER_MS)
    )
  );
}

/**
 * 查找紧邻当前折叠网格上方的配对 `TriggerCollapseGrid` 节点（如验证器页面顶部操作栏或 QA 弹窗顶部新增按钮）。
 *
 * @param gridEl 外层折叠网格节点
 * @returns 配对的触发器容器节点（不存在时返回 `null`）
 */
export function findPairedTriggerElement(gridEl: FlipAnimatableElement): FlipAnimatableElement | null {
  const prev: FlipAnimatableElement | null = gridEl.previousElementSibling ?? null;
  if (prev === null) return null;
  if (
    prev.dataset?.flipTrigger === "1" ||
    prev.getAttribute?.("data-flip-trigger") === "1" ||
    hasAnyFlipClass(prev.classList, MINI_APP_FLIP_TRIGGER_CLASS_NAMES)
  ) {
    return prev;
  }
  return null;
}

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
 * 在 DOM 提交后、浏览器绘制前按物理设备像素网格测量内层面板与可选配对触发器的自然高度，写入起始帧样式，
 * 再以 `runFrameMotion`（按 `MINI_APP_FLIP_COLLAPSE_EASING_POINTS` 三次贝塞尔曲线采样）的单一时钟逐帧写入外层容器 `height`、
 * 内层面板 `translate3d`/`opacity`、配对触发器的位移/透明度、纵向 Flex 间距补偿与可选的视口滚动：所有值都由同一展开进度派生，同帧提交。
 * 无配对触发器时内层面板位移直接由当前帧对齐后的裁剪框高度减展开高度求得，面板下沿与裁剪框下沿逐帧 1:1 锁死；
 * 有配对触发器时面板在 `MINI_APP_FLIP_PAIRED_SLIDE_MAX_PX` 行程内滑动并与触发按钮交叉渐变。时长按 `computeFlipCollapseDurationMs` 取完整过渡时长再乘以剩余进度。
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
    if (shouldFadeInner) innerStyle.opacity = formatOpacity(progress);
    if (triggerH > 0 && triggerInnerStyle !== undefined) {
      triggerInnerStyle.transform = formatTranslate3dYWithDpr(
        -triggerSlidePx * progress,
        dpr
      );
      triggerInnerStyle.opacity = formatOpacity(1 - progress);
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

/** `useFlipCollapseLayoutEffect` Hook 的入参接口。 */
export interface UseFlipCollapseLayoutEffectOptions {
  /** 当前面板是否处于展开状态。 */
  readonly expanded: boolean;
  /** 可选的上下文切换键（如弹窗当前激活的标签页 key；该键变化时直接同步状态而不播放跨标签折叠动画）。 */
  readonly resetKey?: string | null;
  /** 是否同步对内层节点执行透明度过渡（缺省按容器类名自动判定）。 */
  readonly fadeInner?: boolean;
  /** 首次挂载即处于展开态时是否从零高播放展开过渡（缺省 `false`）。 */
  readonly animateOnInitialExpand?: boolean;
  /** 可选的外部网格容器节点引用（提供时复用该引用，供父组件读取实时几何位置）。 */
  readonly gridRef?: React.RefObject<FlipAnimatableElement | null>;
  /** 展开起始时解析同帧视口跟滚目标的回调（按最新一次渲染传入的回调执行）。 */
  readonly resolveFollowScroll?: FlipFollowScrollResolver;
  /** 收起起始时解析同帧视口滚动目标的回调（按最新一次渲染传入的回调执行）。 */
  readonly resolveCollapseScroll?: FlipFollowScrollResolver;
  /** 多个面板可同时过渡时共享的跟滚槽位。 */
  readonly followScrollSlotRef?: React.RefObject<ViewportAnchorScroll | null>;
}

/** `useFlipCollapseLayoutEffect` Hook 的返回值接口。 */
export interface UseFlipCollapseLayoutEffectResult {
  /** 绑定到外层网格容器节点的 `RefObject`。 */
  readonly gridRef: React.RefObject<FlipAnimatableElement | null>;
  /** 绑定到内层裁剪容器节点的 `RefObject`。 */
  readonly innerRef: React.RefObject<FlipAnimatableElement | null>;
  /** 当前是否处于收起过渡飞行期（供组件在渲染期拼入 `.flip-closing` 类名）。 */
  readonly isClosing: boolean;
}

/** `syncFlipCollapseLayoutEffect` 同步布局过渡副作用的参数接口。 */
export interface SyncFlipCollapseLayoutEffectOptions {
  /** 当前目标展开态。 */
  readonly expanded: boolean;
  /** 当前上下文重置键。 */
  readonly resetKey: string | null;
  /** 是否同步对内层节点执行透明度过渡。 */
  readonly fadeInner?: boolean;
  /** 首次挂载即处于展开态时是否从零高播放展开过渡（缺省 `false`）。 */
  readonly animateOnInitialExpand?: boolean;
  /** 标记当前是否处于组件首次挂载布局提交的引用（消费一次后置为 `false`）。 */
  readonly initialMountRef?: React.RefObject<boolean>;
  /** 外层网格节点引用。 */
  readonly gridRef: React.RefObject<FlipAnimatableElement | null>;
  /** 内层面板节点引用。 */
  readonly innerRef: React.RefObject<FlipAnimatableElement | null>;
  /** 上一次展开态引用。 */
  readonly prevExpandedRef: React.RefObject<boolean>;
  /** 上一次上下文重置键引用。 */
  readonly prevResetKeyRef: React.RefObject<string | null>;
  /** 收起飞行态激活标志引用。 */
  readonly closingActiveRef: React.RefObject<boolean>;
  /** 展开起始时解析同帧视口跟滚目标的回调。 */
  readonly resolveFollowScroll?: FlipFollowScrollResolver;
  /** 收起起始时解析同帧视口滚动目标的回调。 */
  readonly resolveCollapseScroll?: FlipFollowScrollResolver;
  /** 多个面板可同时过渡时共享的跟滚槽位。 */
  readonly followScrollSlotRef?: React.RefObject<ViewportAnchorScroll | null>;
}

/**
 * 同步单次布局提交中的展开/收起状态变化与上下文重置键切换，按需启动 `runFlipCollapseTransition`。
 *
 * @param options 状态引用与目标展开参数
 * @returns 过渡清理函数或 `undefined`
 */
export function syncFlipCollapseLayoutEffect({
  expanded,
  resetKey,
  fadeInner,
  animateOnInitialExpand = false,
  initialMountRef,
  gridRef,
  innerRef,
  prevExpandedRef,
  prevResetKeyRef,
  closingActiveRef,
  resolveFollowScroll,
  resolveCollapseScroll,
  followScrollSlotRef,
}: SyncFlipCollapseLayoutEffectOptions): (() => void) | undefined {
  const isInitialMount: boolean =
    initialMountRef !== undefined ? initialMountRef.current : true;
  if (initialMountRef !== undefined) {
    initialMountRef.current = false;
  }
  const rawWasExpanded: boolean = prevExpandedRef.current;
  const prevResetKey: string | null = prevResetKeyRef.current;
  prevExpandedRef.current = expanded;
  prevResetKeyRef.current = resetKey;
  const wasExpanded: boolean =
    isInitialMount && animateOnInitialExpand && expanded ? false : rawWasExpanded;

  const gridEl: FlipAnimatableElement | null = gridRef.current;
  const innerEl: FlipAnimatableElement | null = innerRef.current;
  if (prevResetKey !== resetKey) {
    closingActiveRef.current = false;
    gridEl?.classList?.remove("flip-closing");
    if (innerEl?.dataset !== undefined) delete innerEl.dataset.flipInterruptedProgress;
    return undefined;
  }
  if (wasExpanded === expanded) {
    // 展开态未变的重跑（其余依赖变化）已由上一轮清理清除行内样式，面板落在 CSS 终态，打断进度随之作废。
    closingActiveRef.current = false;
    if (!expanded) {
      gridEl?.classList?.remove("flip-closing");
    }
    if (innerEl?.dataset !== undefined) delete innerEl.dataset.flipInterruptedProgress;
    return undefined;
  }
  if (gridEl === null || innerEl === null) {
    closingActiveRef.current = false;
    return undefined;
  }
  const wasOneFrInDom: boolean =
    wasExpanded ||
    innerEl.dataset?.flipInFlight === "1" ||
    innerEl.dataset?.flipInterruptedProgress !== undefined;
  closingActiveRef.current = !expanded;
  return runFlipCollapseTransition({
    gridEl,
    innerEl,
    expanded,
    wasOneFrInDom,
    fadeInner,
    onClosingCleared: (): void => {
      closingActiveRef.current = false;
    },
    resolveFollowScroll,
    resolveCollapseScroll,
    followScrollSlotRef,
  });
}

/**
 * 为折叠容器组件接入绘制前测量与单时钟快出急停展开/收起过渡的 React Hook（SSR 环境自动降级为无副作用）。
 *
 * @param options 展开状态、可选上下文重置键与视口滚动参数
 * @returns 外层/内层节点引用与收起飞行态标志
 */
export function useFlipCollapseLayoutEffect({
  expanded,
  resetKey = null,
  fadeInner,
  animateOnInitialExpand = false,
  gridRef: externalGridRef,
  resolveFollowScroll,
  resolveCollapseScroll,
  followScrollSlotRef,
}: UseFlipCollapseLayoutEffectOptions): UseFlipCollapseLayoutEffectResult {
  const internalGridRef: React.RefObject<FlipAnimatableElement | null> = useRef<FlipAnimatableElement | null>(null);
  const gridRef: React.RefObject<FlipAnimatableElement | null> = externalGridRef ?? internalGridRef;
  const innerRef: React.RefObject<FlipAnimatableElement | null> = useRef<FlipAnimatableElement | null>(null);
  const initialMountRef: React.RefObject<boolean> = useRef<boolean>(true);
  const prevExpandedRef: React.RefObject<boolean> = useRef<boolean>(expanded);
  const prevResetKeyRef: React.RefObject<string | null> = useRef<string | null>(resetKey);
  const closingActiveRef: React.RefObject<boolean> = useRef<boolean>(false);
  const resolveExpandScrollEvent: FlipFollowScrollResolver = useEffectEvent(
    (gridElement: FlipAnimatableElement, heightPx: number): ViewportAnchorScrollTarget | null =>
      resolveFollowScroll?.(gridElement, heightPx) ?? null
  );
  const resolveCollapseScrollEvent: FlipFollowScrollResolver = useEffectEvent(
    (gridElement: FlipAnimatableElement, heightPx: number): ViewportAnchorScrollTarget | null =>
      resolveCollapseScroll?.(gridElement, heightPx) ?? null
  );

  if (prevResetKeyRef.current !== resetKey) {
    closingActiveRef.current = false;
  } else if (prevExpandedRef.current && !expanded) {
    closingActiveRef.current = true;
  } else if (expanded) {
    closingActiveRef.current = false;
  }
  const isClosing: boolean = closingActiveRef.current && !expanded;

  const hasDomDocument: boolean = (globalThis as { readonly document?: unknown }).document !== undefined;
  const useIsoLayoutEffect: typeof useEffect = hasDomDocument ? useLayoutEffect : useEffect;

  useIsoLayoutEffect(
    (): (() => void) | undefined =>
      syncFlipCollapseLayoutEffect({
        expanded,
        resetKey,
        fadeInner,
        animateOnInitialExpand,
        initialMountRef,
        gridRef,
        innerRef,
        prevExpandedRef,
        prevResetKeyRef,
        closingActiveRef,
        resolveFollowScroll: resolveExpandScrollEvent,
        resolveCollapseScroll: resolveCollapseScrollEvent,
        followScrollSlotRef,
      }),
    [animateOnInitialExpand, expanded, fadeInner, followScrollSlotRef, gridRef, resetKey]
  );

  return { gridRef, innerRef, isClosing };
}
