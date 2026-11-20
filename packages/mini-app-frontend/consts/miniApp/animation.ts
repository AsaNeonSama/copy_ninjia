/**
 * Mini App 前端折叠面板逐帧动画、视口跟滚、滑块弹性插值与浮层退场时长常量。
 */

/**
 * 折叠面板展开逐帧动画的时长毫秒数（0.18 秒），也是收起时长的下限；同帧视口跟滚与图库预览定位滚动共用同一时长。
 * 不变量：正整数毫秒数，小于等于 `MINI_APP_FLIP_COLLAPSE_CLOSE_MAX_DURATION_MS`。所属模块：`packages/mini-app-frontend/components/animations/flipCollapseGeometry.ts` 与 `packages/mini-app-frontend/components/animations/expandFollowScroll.ts`。
 */
export const MINI_APP_FLIP_COLLAPSE_DURATION_MS: number = 180;

/**
 * 折叠面板收起的平均速度上限（像素/毫秒）：收起时长取 `收起高度 ÷ 该速度` 与 `MINI_APP_FLIP_COLLAPSE_DURATION_MS` 的较大值。
 * 中小高度面板按展开同款时长收起，大图预览等高面板按高度延长时长以限制单帧最大位移。
 * 不变量：正有限数。所属模块：`packages/mini-app-frontend/components/animations/flipCollapseGeometry.ts`。
 */
export const MINI_APP_FLIP_COLLAPSE_CLOSE_SPEED_PX_PER_MS: number = 2;

/**
 * 折叠面板收起时长的上限毫秒数（0.28 秒）。
 * 不变量：正整数毫秒数，大于等于 `MINI_APP_FLIP_COLLAPSE_DURATION_MS`。所属模块：`packages/mini-app-frontend/components/animations/flipCollapseGeometry.ts`。
 */
export const MINI_APP_FLIP_COLLAPSE_CLOSE_MAX_DURATION_MS: number = 280;

/**
 * 逐帧动画时钟单帧推进步长的基准上限毫秒数：实际单帧步长上限取该值与本次动画已观测最短帧间隔的较大值。
 * 首帧布局栅格化或中途掉帧产生长间隔时，动画时钟单帧至多推进该步长；50 Hz 及以上刷新率的正常帧间隔原样推进，低帧率设备按自身最短帧间隔推进。
 * 不变量：正整数毫秒数，大于 60 Hz 的帧间隔（约 16.7 毫秒）。所属模块：`packages/mini-app-frontend/components/animations/frameMotion.ts`。
 */
export const MINI_APP_FRAME_MOTION_MAX_STEP_MS: number = 20;

/**
 * 逐帧动画时钟落后实际经过时间的上限毫秒数：落后超过该值时时钟追平到「经过时间减该值」，动画最迟在时长加该值后结束。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/components/animations/frameMotion.ts`。
 */
export const MINI_APP_FRAME_MOTION_MAX_LAG_MS: number = 80;

/**
 * 折叠面板逐帧动画、同帧视口滚动、滑块前段推进与子页签高度过渡共用的三次贝塞尔缓动控制点 `[x1, y1, x2, y2]`（对应 CSS `cubic-bezier(0.2, 0.9, 0.25, 1)`）。
 * 不变量：`x1`、`x2` 落在 `[0, 1]` 区间内；与 `styles/base.css` 中 `--ease-brutal` 的缓动曲线一致。所属模块：`packages/mini-app-frontend/components/animations/frameMotion.ts`、`packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts` 与 `packages/mini-app-frontend/consts/animation.ts`。
 */
export const MINI_APP_FLIP_COLLAPSE_EASING_POINTS: readonly [number, number, number, number] =
  [0.2, 0.9, 0.25, 1];

/**
 * 折叠面板收起后保留内容快照与 `.flip-closing` 布局的毫秒数：覆盖最长收起时长、逐帧时钟的最大落后量及首帧排期与末帧落点的帧间余量。
 * 不变量：正整数毫秒数，大于等于 `MINI_APP_FLIP_COLLAPSE_CLOSE_MAX_DURATION_MS` 加 `MINI_APP_FRAME_MOTION_MAX_LAG_MS` 再加两帧（60 Hz 约 34 毫秒）。所属模块：`packages/mini-app-frontend/components/animations/CollapseGrid.tsx`、`packages/mini-app-frontend/components/animations/flipCollapseTransition.ts`、`packages/mini-app-frontend/components/IdentityListRows.tsx` 与 `packages/mini-app-frontend/pages/GalleryPage.tsx`。
 */
export const MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS: number = 400;

/** 折叠面板逐帧动画中与面板配对的底部触发条（如新增按钮栏）随展开/收起联动的初始最大位移像素数。不变量：正整数像素值。所属模块：`packages/mini-app-frontend/components/animations/flipCollapseTransition.ts`。 */
export const MINI_APP_FLIP_PAIRED_SLIDE_MAX_PX: number = 16;

/** 折叠面板逐帧动画中显式绑定的触发容器随展开/收起联动的初始最大位移像素数。不变量：正整数像素值。所属模块：`packages/mini-app-frontend/components/animations/flipCollapseTransition.ts`。 */
export const MINI_APP_FLIP_TRIGGER_SLIDE_MAX_PX: number = 10;

/** 折叠面板向上搜索祖先收起态时作为遍历停止边界的 HTML 标签名大写集合。不变量：大写 HTML 标签名只读数组。所属模块：`packages/mini-app-frontend/components/animations/flipCollapseGeometry.ts`。 */
export const MINI_APP_FLIP_BOUNDARY_TAG_NAMES: readonly string[] = ["SECTION", "MAIN"];

/** 折叠面板向上搜索祖先收起态时作为页面或弹窗内容区边界的 CSS 类名集合。不变量：非空 CSS 类名只读数组。所属模块：`packages/mini-app-frontend/components/animations/flipCollapseGeometry.ts`。 */
export const MINI_APP_FLIP_BOUNDARY_CLASS_NAMES: readonly string[] = [
  "chat-targets-tab-pane",
  "chat-targets-modal-body",
  "app-main",
  "animate-fade-in",
];

/** 折叠面板在前一个同级节点中识别配对 `TriggerCollapseGrid` 时匹配的回退 CSS 类名集合。不变量：非空 CSS 类名只读数组。所属模块：`packages/mini-app-frontend/components/animations/flipCollapseGeometry.ts`。 */
export const MINI_APP_FLIP_TRIGGER_CLASS_NAMES: readonly string[] = [
  "totp-trigger-collapse-grid",
  "chat-targets-qa-trigger-collapse",
];

/** 折叠面板在未显式传入 `fadeInner` 时默认启用内层透明度同步渐变的外层网格 CSS 类名集合。不变量：非空 CSS 类名只读数组。所属模块：`packages/mini-app-frontend/components/animations/flipCollapseGeometry.ts`。 */
export const MINI_APP_FLIP_FADE_INNER_GRID_CLASS_NAMES: readonly string[] = [
  "chat-targets-qa-trigger-collapse",
  "chat-targets-qa-collapse-grid",
  "totp-trigger-collapse-grid",
  "totp-setup-collapse-grid",
  "gallery-preview-collapse-grid",
];

/** 子页签切换容器（`TabHeightSizer`）平滑过渡外层高度的 CSS `transition` 持续毫秒数。不变量：正整数毫秒数，小于 `MINI_APP_TAB_HEIGHT_CLEANUP_MS`。所属模块：`packages/mini-app-frontend/consts/animation.ts`。 */
export const MINI_APP_TAB_HEIGHT_TRANSITION_MS: number = 220;

/** 子页签切换容器（`TabHeightSizer`）在高度过渡结束后清除内联 `height` / `transition` / `overflow` 的定时器毫秒数。不变量：正整数毫秒数，大于 `MINI_APP_TAB_HEIGHT_TRANSITION_MS`。所属模块：`packages/mini-app-frontend/components/animations/TabHeightSizer.tsx`。 */
export const MINI_APP_TAB_HEIGHT_CLEANUP_MS: number = 230;

/**
 * 程序跟滚进行中收到即停止跟滚、把视口交还用户的全局输入事件名（触摸开始与滚轮）。
 * 不变量：非空的 DOM 事件名列表。所属模块：`packages/mini-app-frontend/components/animations/expandFollowScroll.ts`。
 */
export const MINI_APP_FOLLOW_SCROLL_ABORT_EVENTS: readonly string[] = [
  "touchstart",
  "wheel",
];

/**
 * 折叠项展开同帧跟滚的目标位置里，标题栏距离视口顶部的最小保留像素边距；图库预览定位滚动以此作为预览容器的顶部对齐位置（实时状态页子系统面板、白名单权限抽屉、验证器绑定面板与图库预览共用）。
 * 不变量：非负整数像素值。所属模块：`packages/mini-app-frontend/components/animations/expandFollowScroll.ts`。
 */
export const MINI_APP_EXPAND_SCROLL_TOP_MARGIN_PX: number = 16;

/**
 * 折叠项展开同帧跟滚的目标位置里，展开内容底部距离视口下沿的目标保留像素边距（实时状态页子系统面板、白名单权限抽屉与验证器绑定面板共用）。
 * 不变量：非负整数像素值。所属模块：`packages/mini-app-frontend/components/animations/expandFollowScroll.ts`。
 */
export const MINI_APP_EXPAND_SCROLL_BOTTOM_MARGIN_PX: number = 24;

/**
 * 折叠项展开同帧跟滚时触发舒适阅读区上移的视口高度比例阈值（标题栏顶部低于该比例处才上移；实时状态页子系统面板、白名单权限抽屉与验证器绑定面板共用）。
 * 不变量：`(0, 1)` 区间内的浮点数。所属模块：`packages/mini-app-frontend/components/animations/expandFollowScroll.ts`。
 */
export const MINI_APP_EXPAND_SCROLL_COMFORT_TOP_RATIO: number = 0.28;

/**
 * 折叠项位于视口中下半区展开时，按展开完成后的内容高度折算跟滚距离的比例系数（实时状态页子系统面板、白名单权限抽屉与验证器绑定面板共用）。
 * 不变量：`(0, 1)` 区间内的浮点数。所属模块：`packages/mini-app-frontend/components/animations/expandFollowScroll.ts`。
 */
export const MINI_APP_EXPAND_SCROLL_COMFORT_BODY_FACTOR: number = 0.55;

/**
 * 折叠项展开同帧跟滚与图库预览定位滚动的最小像素位移阈值（小于等于该值时不滚动；实时状态页子系统面板、白名单权限抽屉、验证器绑定面板与图库预览共用）。
 * 不变量：非负整数像素值。所属模块：`packages/mini-app-frontend/components/animations/expandFollowScroll.ts`。
 */
export const MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX: number = 4;

/**
 * 群内目标管理弹窗关闭收起退场动画的毫秒数（与 `styles/chats-targets.css` 的 `0.18s` 齐平）。
 * 不变量：正整数毫秒数，与对应 CSS 退场时长一致。所属模块：`packages/mini-app-frontend/components/ChatTargetsModal.tsx`。
 */
export const MINI_APP_TARGETS_MODAL_CLOSE_MS: number = 180;

/**
 * 顶部 Toast 提示淡出退场动画的毫秒数（与 `styles/overlays.css` 的 `0.2s` 齐平）。
 * 不变量：正整数毫秒数，与对应 CSS 退场时长一致。所属模块：`packages/mini-app-frontend/components/Toast.tsx`。
 */
export const MINI_APP_TOAST_CLOSE_ANIMATION_MS: number = 200;

/**
 * 自定义确认弹窗关闭收起退场动画的毫秒数（与 `styles/overlays.css` 的 `0.18s` 齐平）。
 * 不变量：正整数毫秒数，与对应 CSS 退场时长一致。所属模块：`packages/mini-app-frontend/components/ConfirmModal.tsx`。
 */
export const MINI_APP_CONFIRM_CLOSE_ANIMATION_MS: number = 180;

/**
 * 顶栏语言选择下拉菜单与添加模式下拉菜单关闭收起退场动画的毫秒数（与 `styles/shell.css` 的 `0.18s` 齐平）。
 * 不变量：正整数毫秒数，与对应 CSS 退场时长一致。所属模块：`packages/mini-app-frontend/components/PrefsBar.tsx`、`packages/mini-app-frontend/components/ChatTargetsMenuButtonList.tsx`、`packages/mini-app-frontend/components/ChatTargetsMemberPanels.tsx` 与 `packages/mini-app-frontend/components/ChatTargetsModal.tsx`。
 */
export const MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS: number = 180;

/**
 * 侧边栏导航抽屉收起滑动过渡的 `transitionend` 兜底定时器毫秒数（覆盖 `styles/shell.css` 中 `.sidebar-drawer` 的 `0.19s` 位移过渡时长加首帧合成排期余量）。
 * 不变量：正整数毫秒数，大于 `.sidebar-drawer` 的 `190ms` CSS 位移过渡时长。所属模块：`packages/mini-app-frontend/components/AppShell.tsx`。
 */
export const MINI_APP_SIDEBAR_CLOSE_ANIMATION_MS: number = 220;

/**
 * Mini App 群详情页点击回溯清理窗口小时按钮（步进 `−`/`+` 或快捷档位 `1h`–`24h`）时进度条与滑块平滑生长并带定点弹性回弹的动画时长毫秒数。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。
 */
export const MINI_APP_BATCH_KICK_RANGE_ANIMATION_MS: number = 320;

/** 滑块进度条弹性生长插值中前段平滑推进与后段阻尼回弹的分界进度比例（`0.62`）。不变量：`(0, 1)` 区间内的浮点数。所属模块：`packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。 */
export const MINI_APP_RANGE_SPRING_SPLIT_PROGRESS: number = 0.62;

/** 滑块进度条弹性回弹振幅按总跨度折算的比例系数。不变量：正浮点数。所属模块：`packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。 */
export const MINI_APP_RANGE_SPRING_AMPLITUDE_RATIO: number = 0.075;

/** 滑块进度条弹性回弹振幅的下限小时数。不变量：正浮点数，小于等于 `MINI_APP_RANGE_SPRING_AMPLITUDE_MAX`。所属模块：`packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。 */
export const MINI_APP_RANGE_SPRING_AMPLITUDE_MIN: number = 0.26;

/** 滑块进度条弹性回弹振幅的上限小时数。不变量：正浮点数，大于等于 `MINI_APP_RANGE_SPRING_AMPLITUDE_MIN`。所属模块：`packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。 */
export const MINI_APP_RANGE_SPRING_AMPLITUDE_MAX: number = 0.62;

/** 滑块进度条过冲超出最小/最大小时边界时向内侧折返的阻尼衰减系数。不变量：`(0, 1)` 区间内的浮点数。所属模块：`packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。 */
export const MINI_APP_RANGE_SPRING_BOUNDARY_DAMPING: number = 0.65;

/** 连续同向点击滑块按钮时触发向前垫进起点的上一轮剩余行程最小阈值。不变量：正浮点数。所属模块：`packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。 */
export const MINI_APP_RANGE_ADVANCE_REMAINING_THRESHOLD: number = 0.55;

/** 连续点击或回撤滑块按钮时垫进起点与计算回拉跨度的比例系数兼最大回拉上限。不变量：正浮点数。所属模块：`packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。 */
export const MINI_APP_RANGE_PULLBACK_MAX_SPAN: number = 0.45;

/** 快速回撤滑块按钮时触发预留回拉行程的当前值与新目标最小差值阈值兼回拉跨度下限。不变量：正浮点数。所属模块：`packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。 */
export const MINI_APP_RANGE_PULLBACK_MIN_SPAN: number = 0.35;

/** 滑块视觉值与目标值比较时判定已收敛相等的浮点容差阈值。不变量：正浮点数。所属模块：`packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。 */
export const MINI_APP_RANGE_VALUE_EPSILON: number = 0.001;

/** 滑块弹性动画启动首帧同步推进的最大归一化进度上限。不变量：`(0, 1)` 区间内的浮点数。所属模块：`packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。 */
export const MINI_APP_RANGE_KICKOFF_MAX_PROGRESS: number = 0.25;

/** 滑块弹性动画启动首帧同步推进的基准单帧毫秒步长（60 Hz 下约 16 毫秒）。不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。 */
export const MINI_APP_ANIMATION_FRAME_STEP_MS: number = 16;
