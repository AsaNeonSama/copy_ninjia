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
  MINI_APP_FLIP_COLLAPSE_DURATION_MS,
  MINI_APP_FLIP_FADE_INNER_GRID_CLASS_NAMES,
  MINI_APP_FLIP_TRIGGER_CLASS_NAMES,
} from "../../consts/miniApp/animation";
import type {
  ViewportAnchorScrollTarget,
  ViewportRectElement,
} from "./expandFollowScroll";

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
export interface InlineNoticeFlexGapCompensation {
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
export function resolveFlipDevicePixelRatio(): number {
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
export function snapFlipPxWithDpr(valuePx: number, dpr: number): number {
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
export function formatTranslate3dYWithDpr(offsetYPx: number, dpr: number): string {
  const snapped: number = snapFlipPxWithDpr(offsetYPx, dpr);
  return snapped === 0 ? "translate3d(0, 0, 0)" : `translate3d(0, ${snapped}px, 0)`;
}

/**
 * 当页内提示折叠容器位于纵向 Flex 父容器内时，解析展开/收起期间需由负边距同步插值抵消的 `row-gap`
 * （收起终态容器为 `display: none` 不产生间距，飞行期 `display: block` 下在进度 `0` 处抵消额外的一份间距）。
 *
 * @param gridEl 外层折叠网格节点
 * @param dpr 已夹紧的设备像素比
 * @returns 需要补偿的边缘与像素值；非页内提示容器或无额外 Flex 间距时返回 `null`
 */
export function resolveInlineNoticeFlexGap(
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
export function formatFlipOpacity(value: number): string {
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
