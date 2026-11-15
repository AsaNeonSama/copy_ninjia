/**
 * Mini App 前端折叠过渡、子页签高度过渡与页内提示容器的物理像素对齐及通用类名常量。
 */

import {
  MINI_APP_FLIP_COLLAPSE_EASING_POINTS,
  MINI_APP_TAB_HEIGHT_TRANSITION_MS,
} from "./miniApp";

/**
 * 折叠动画引擎对齐物理像素时读取 `devicePixelRatio` 的最小夹紧值（宿主缺失或非正时回退为 `1`）。
 * 不变量：正数，且小于等于 `MINI_APP_FLIP_MAX_DPR`。所属模块：`packages/mini-app-frontend/components/animations/flipCollapse.ts`。
 */
export const MINI_APP_FLIP_MIN_DPR: number = 1;

/**
 * 折叠动画引擎对齐物理像素时读取 `devicePixelRatio` 的最大夹紧值。
 * 不变量：正数，且大于等于 `MINI_APP_FLIP_MIN_DPR`。所属模块：`packages/mini-app-frontend/components/animations/flipCollapse.ts`。
 */
export const MINI_APP_FLIP_MAX_DPR: number = 4;

/**
 * 折叠动画引擎将物理像素对齐后的 CSS 像素值与透明度保留三位小数时使用的千分位缩放倍率。
 * 不变量：正整数（`1_000`，保留最多三位小数）。所属模块：`packages/mini-app-frontend/components/animations/flipCollapse.ts`。
 */
export const MINI_APP_FLIP_PX_PRECISION_SCALE: number = 1_000;

/**
 * 页内横幅、操作结果与进度提示共用的外层折叠网格容器 CSS 类名。
 * 不变量：非空 CSS 类名字符串，与 `styles/primitives.css` 中 `.inline-notice-collapse-grid` 选择器一致。所属模块：`packages/mini-app-frontend/components/animations/CollapseGrid.tsx` 与 `packages/mini-app-frontend/components/animations/flipCollapse.ts`。
 */
export const MINI_APP_INLINE_NOTICE_GRID_CLASS_NAME: string = "inline-notice-collapse-grid";

/**
 * 页内横幅、操作结果与进度提示共用的内层折叠裁剪容器 CSS 类名。
 * 不变量：非空 CSS 类名字符串，与 `styles/primitives.css` 中 `.inline-notice-collapse-inner` 选择器一致。所属模块：`packages/mini-app-frontend/components/animations/CollapseGrid.tsx`。
 */
export const MINI_APP_INLINE_NOTICE_INNER_CLASS_NAME: string = "inline-notice-collapse-inner";

/**
 * 弹窗标签页高度过渡容器（`TabHeightSizer`）外层 `height` 的 CSS `transition` 声明。
 * 不变量：由 `MINI_APP_TAB_HEIGHT_TRANSITION_MS`（毫秒折算秒）与 `MINI_APP_FLIP_COLLAPSE_EASING_POINTS` 三次贝塞尔控制点拼装的非空 CSS 过渡字符串。所属模块：`packages/mini-app-frontend/components/animations/TabHeightSizer.tsx`。
 */
export const MINI_APP_TAB_HEIGHT_TRANSITION: string = `height ${MINI_APP_TAB_HEIGHT_TRANSITION_MS / 1_000}s cubic-bezier(${MINI_APP_FLIP_COLLAPSE_EASING_POINTS.join(", ")})`;
