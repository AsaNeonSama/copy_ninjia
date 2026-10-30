import type {
  MiniAppChatTargetKind,
  MiniAppFeatureKey,
  MiniAppIdentityAddMode,
  MiniAppLanguage,
  MiniAppTabKey,
  MiniAppThemeMode,
  MiniAppTranslateLanguage,
} from "../types/miniApp";
import { exhaustiveList } from "./exhaustiveList";
import { MINUTE_MS } from "./time";

/** 十六进制 SHA-256 摘要字符串（固定 64 位十六进制字符）的匹配规则。不变量：不带全局标志 `g`，供持久化会话令牌格式校验无状态复用；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/libs/credentials.ts`。 */
export const MINI_APP_SHA256_HEX_PATTERN: RegExp = /^[0-9a-f]{64}$/i;

/** Unicode 双向文本控制字符（LRM/RLM/ALM、LRE/RLE/PDF/LRO/RLO、LRI/RLI/FSI/PDI）的全局匹配规则。不变量：用于清洗 Telegram 昵称中的 RLO 等控制字符，防止反转整行 UI 布局；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/libs/formatters.ts`。 */
export const MINI_APP_BIDI_CONTROL_CHARS_PATTERN: RegExp =
  /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** Mini App API 请求携带 Telegram WebApp `initData` 原始查询串的 HTTP 请求头名（小写）。不变量：所有 `/api/*` 鉴权统一读取该请求头；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/api/request.ts`。 */
export const MINI_APP_INIT_DATA_HEADER: string = "x-telegram-init-data";

/** Mini App 密码认证通过后签发的会话令牌 HTTP 请求头名（小写）。不变量：除 `/api/auth/precheck` 与 `/api/auth/login` 外，所有业务 `/api/*` 接口均要求携带有效会话令牌；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/api/request.ts`。 */
export const MINI_APP_SESSION_HEADER: string = "x-mini-app-session";

/** Mini App 会话令牌自动刷新时下发新到期毫秒时间戳的 HTTP 响应头名（小写）。不变量：取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/api/request.ts`。 */
export const MINI_APP_SESSION_EXPIRES_AT_HEADER: string =
  "x-mini-app-session-expires-at";

/** Mini App 访问密码认证会话的有效期毫秒数（45 分钟）。不变量：到期后必须重新输入密码完成认证；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/libs/credentials.ts` 与 `packages/mini-app-frontend/api/authPrecheck.ts`。 */
export const MINI_APP_SESSION_TTL_MS: number = 45 * MINUTE_MS;

/** Mini App 在浏览器 `localStorage` / `sessionStorage` 中持久化 45 分钟认证会话凭据的存储键名。不变量：仅在 Mini App 客户端 WebView 环境内持久化 `{ token, expiresAt, assetToken }`，过期或主动锁定时立即清除。所属模块：`packages/mini-app-frontend/libs/credentials.ts`。 */
export const MINI_APP_SESSION_STORAGE_KEY: string =
  "copy_ninja_mini_app_session_v1";

/** `Authorization: tma <initData>` 请求头的认证方案前缀（小写含尾空格）。不变量：与 `X-Telegram-Init-Data` 互为备选传递方式；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/api/request.ts`。 */
export const MINI_APP_TMA_AUTH_PREFIX: string = "tma ";

/** 名单搜索输入框触发按名称过滤请求的防抖等待毫秒数（0.5 秒）。不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/pages/IdentitiesPage.tsx`。 */
export const MINI_APP_SEARCH_DEBOUNCE_MS: number = 500;

/** 图库分页接口缺省每页返回的图片张数（10 张）。不变量：属于 `MINI_APP_GALLERY_PAGE_SIZE_OPTIONS` 档位；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/store/gallery.ts`。 */
export const MINI_APP_GALLERY_DEFAULT_PAGE_SIZE: number = 10;

/** 图库页面可选的每页张数档位（默认 10 张，可切换 15、20 张）。不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/mini-app-frontend/pages/GalleryPage.tsx`。 */
export const MINI_APP_GALLERY_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/** 群热发言记录接口缺省每页返回的条数（10 条）。不变量：属于 `MINI_APP_MESSAGES_PAGE_SIZE_OPTIONS` 档位；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/store/messages.ts` 与 `packages/mini-app-frontend/components/MessagesView.tsx`。 */
export const MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE: number = 10;

/** 群热发言记录页面可选的每页条数档位（默认 10 条，可切换 15、20 条）。不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/mini-app-frontend/components/MessagesView.tsx`。 */
export const MINI_APP_MESSAGES_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/** 已 `/init` 受管群列表缺省每页显示的群数量（10 条）。不变量：正整数。所属模块：`packages/mini-app-frontend/store/chats.ts` 与 `packages/mini-app-frontend/pages/ChatsPage.tsx`。 */
export const MINI_APP_CHATS_DEFAULT_PAGE_SIZE: number = 10;

/** 已 `/init` 受管群列表可选的每页条数档位（默认 10 条，可切换 15、20 条）。不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/mini-app-frontend/pages/ChatsPage.tsx`。 */
export const MINI_APP_CHATS_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/** 白名单与黑名单列表接口缺省每页返回的条数（10 条）。不变量：属于 `MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS` 档位；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/store/identities.ts` 与 `packages/mini-app-frontend/pages/IdentitiesPage.tsx`。 */
export const MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE: number = 10;

/** 白名单与黑名单列表可选的每页条数档位（默认 10 条，可切换 15、20 条）。不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/mini-app-frontend/pages/IdentitiesPage.tsx`。 */
export const MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/**
 * Mini App 首页实时状态轮询的间隔毫秒数（3 秒），自上一次响应结算起计时。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/store/status.ts`。
 */
export const MINI_APP_STATUS_POLL_INTERVAL_MS: number = 3_000;

/**
 * 实时状态页切换子系统折叠面板后暂缓提交状态快照的毫秒数；该时段内取得的快照在时段结束后才写入仓库，使快照重渲染落在展开/收起过渡之后。
 * 不变量：正整数毫秒数，大于等于 `MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS`。所属模块：`packages/mini-app-frontend/store/status.ts`。
 */
export const MINI_APP_STATUS_SNAPSHOT_HOLD_AFTER_TOGGLE_MS: number = 400;

/**
 * 折叠面板展开逐帧动画的时长毫秒数（0.18 秒），也是收起时长的下限；同帧视口跟滚与图库预览定位滚动共用同一时长。
 * 不变量：正整数毫秒数，小于等于 `MINI_APP_FLIP_COLLAPSE_CLOSE_MAX_DURATION_MS`。所属模块：`packages/mini-app-frontend/components/animations/flipCollapse.ts` 与 `packages/mini-app-frontend/components/animations/expandFollowScroll.ts`。
 */
export const MINI_APP_FLIP_COLLAPSE_DURATION_MS: number = 180;

/**
 * 折叠面板收起的平均速度上限（像素/毫秒）：收起时长取「收起高度 ÷ 该速度」与 `MINI_APP_FLIP_COLLAPSE_DURATION_MS` 的较大值，
 * 高度不超过「`MINI_APP_FLIP_COLLAPSE_DURATION_MS` × 该速度」的面板按展开同一时长收起，更高的面板（如图库大图预览）按高度延长，使逐帧位移峰值不随高度继续增大。
 * 不变量：正有限数。所属模块：`packages/mini-app-frontend/components/animations/flipCollapse.ts`。
 */
export const MINI_APP_FLIP_COLLAPSE_CLOSE_SPEED_PX_PER_MS: number = 2;

/**
 * 折叠面板收起时长的上限毫秒数（0.28 秒）。
 * 不变量：正整数毫秒数，大于等于 `MINI_APP_FLIP_COLLAPSE_DURATION_MS`。所属模块：`packages/mini-app-frontend/components/animations/flipCollapse.ts`。
 */
export const MINI_APP_FLIP_COLLAPSE_CLOSE_MAX_DURATION_MS: number = 280;

/**
 * 逐帧动画时钟单帧推进上限的下限毫秒数：实际上限取该值与本次动画已观测的最短帧间隔中的较大值，
 * 帧间隔超过上限（起始帧承担新内容的样式、布局、绘制与图层栅格化，或中途卡顿）时只推进上限，长帧不折成一次大跳；
 * 50 Hz 及以上刷新率的正常帧间隔不受影响，低帧率设备按自身最短帧间隔推进。
 * 不变量：正整数毫秒数，大于 60 Hz 的帧间隔（约 16.7 毫秒）。所属模块：`packages/mini-app-frontend/components/animations/frameMotion.ts`。
 */
export const MINI_APP_FRAME_MOTION_MAX_STEP_MS: number = 20;

/**
 * 逐帧动画时钟落后实际经过时间的上限毫秒数：落后超过该值时时钟追平到「经过时间减该值」，动画最迟在时长加该值后结束。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/components/animations/frameMotion.ts`。
 */
export const MINI_APP_FRAME_MOTION_MAX_LAG_MS: number = 80;

/**
 * 折叠面板逐帧动画与同帧视口滚动共用的缓动曲线控制点 `[x1, y1, x2, y2]`（即 CSS `cubic-bezier(0.32, 0.08, 0.24, 1)`）。
 * 不变量：`x1`、`x2` 落在 `[0, 1]` 区间内；与 `styles/` 下各样式表的 S 型缓动曲线一致。所属模块：`packages/mini-app-frontend/components/animations/frameMotion.ts`。
 */
export const MINI_APP_FLIP_COLLAPSE_EASING_POINTS: readonly [number, number, number, number] =
  [0.32, 0.08, 0.24, 1];

/**
 * 折叠面板收起后保留内容快照与 `.flip-closing` 布局的毫秒数：覆盖最长收起时长、逐帧时钟的最大落后量及首帧排期与末帧落点的帧间余量。
 * 不变量：正整数毫秒数，大于等于 `MINI_APP_FLIP_COLLAPSE_CLOSE_MAX_DURATION_MS` 加 `MINI_APP_FRAME_MOTION_MAX_LAG_MS` 再加两帧（60 Hz 约 34 毫秒）。所属模块：`packages/mini-app-frontend/components/animations/flipCollapse.ts`、`packages/mini-app-frontend/components/IdentityListRows.tsx` 与 `packages/mini-app-frontend/pages/GalleryPage.tsx`。
 */
export const MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS: number = 400;

/** 折叠面板逐帧动画中与面板配对的底部触发条（如新增按钮栏）随展开/收起联动的初始最大位移像素数。不变量：正整数像素值。所属模块：`packages/mini-app-frontend/components/animations/flipCollapse.ts`。 */
export const MINI_APP_FLIP_PAIRED_SLIDE_MAX_PX: number = 16;

/** 折叠面板逐帧动画中显式绑定的触发容器随展开/收起联动的初始最大位移像素数。不变量：正整数像素值。所属模块：`packages/mini-app-frontend/components/animations/flipCollapse.ts`。 */
export const MINI_APP_FLIP_TRIGGER_SLIDE_MAX_PX: number = 10;

/** 折叠面板向上搜索祖先收起态时作为遍历停止边界的 HTML 标签名大写集合。不变量：大写 HTML 标签名只读数组。所属模块：`packages/mini-app-frontend/components/animations/flipCollapse.ts`。 */
export const MINI_APP_FLIP_BOUNDARY_TAG_NAMES: readonly string[] = ["SECTION", "MAIN"];

/** 折叠面板向上搜索祖先收起态时作为页面或弹窗内容区边界的 CSS 类名集合。不变量：非空 CSS 类名只读数组。所属模块：`packages/mini-app-frontend/components/animations/flipCollapse.ts`。 */
export const MINI_APP_FLIP_BOUNDARY_CLASS_NAMES: readonly string[] = [
  "chat-targets-tab-pane",
  "chat-targets-modal-body",
  "app-main",
  "animate-fade-in",
];

/** 折叠面板在前一个同级节点中识别配对 `TriggerCollapseGrid` 时匹配的回退 CSS 类名集合。不变量：非空 CSS 类名只读数组。所属模块：`packages/mini-app-frontend/components/animations/flipCollapse.ts`。 */
export const MINI_APP_FLIP_TRIGGER_CLASS_NAMES: readonly string[] = [
  "totp-trigger-collapse-grid",
  "chat-targets-qa-trigger-collapse",
];

/** 折叠面板在未显式传入 `fadeInner` 时默认启用内层透明度同步渐变的外层网格 CSS 类名集合。不变量：非空 CSS 类名只读数组。所属模块：`packages/mini-app-frontend/components/animations/flipCollapse.ts`。 */
export const MINI_APP_FLIP_FADE_INNER_GRID_CLASS_NAMES: readonly string[] = [
  "chat-targets-qa-trigger-collapse",
  "chat-targets-qa-collapse-grid",
  "totp-trigger-collapse-grid",
  "totp-setup-collapse-grid",
  "gallery-preview-collapse-grid",
];

/** 子页签切换容器（`TabHeightSizer`）平滑过渡外层高度的 CSS `transition` 持续毫秒数。不变量：正整数毫秒数，小于 `MINI_APP_TAB_HEIGHT_CLEANUP_MS`。所属模块：`packages/mini-app-frontend/components/animations/TabHeightSizer.tsx`。 */
export const MINI_APP_TAB_HEIGHT_TRANSITION_MS: number = 220;

/** 子页签切换容器（`TabHeightSizer`）在高度过渡结束后清除内联 `height` / `transition` / `overflow` 的定时器毫秒数。不变量：正整数毫秒数，大于 `MINI_APP_TAB_HEIGHT_TRANSITION_MS`。所属模块：`packages/mini-app-frontend/components/animations/TabHeightSizer.tsx`。 */
export const MINI_APP_TAB_HEIGHT_CLEANUP_MS: number = 230;

/** 实时状态页 CPU 环形进度条 SVG 圆周长（半径 `r = 17.5` 时的 `2 * π * r` 近似值 `109.96`）。不变量：正浮点数，与 `StatusOverviewCard.tsx` 中环形进度圆的 `r="17.5"` 匹配。所属模块：`packages/mini-app-frontend/components/StatusOverviewCard.tsx`。 */
export const MINI_APP_CPU_RING_CIRCUMFERENCE: number = 109.96;

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
 * 群内目标管理弹窗关闭收起退场动画的毫秒数（与 `styles/chats.css` 的 `0.18s` 齐平）。
 * 不变量：正整数毫秒数，与对应 CSS 退场时长一致。所属模块：`packages/mini-app-frontend/components/ChatTargetsModal.tsx`。
 */
export const MINI_APP_TARGETS_MODAL_CLOSE_MS: number = 180;

/**
 * 底部 Toast 提示淡出退场动画的毫秒数（与 `styles/overlays.css` 的 `0.2s` 齐平）。
 * 不变量：正整数毫秒数，与对应 CSS 退场时长一致。所属模块：`packages/mini-app-frontend/components/Toast.tsx`。
 */
export const MINI_APP_TOAST_CLOSE_ANIMATION_MS: number = 200;

/**
 * 自定义确认弹窗关闭收起退场动画的毫秒数（与 `styles/overlays.css` 的 `0.18s` 齐平）。
 * 不变量：正整数毫秒数，与对应 CSS 退场时长一致。所属模块：`packages/mini-app-frontend/components/ConfirmModal.tsx`。
 */
export const MINI_APP_CONFIRM_CLOSE_ANIMATION_MS: number = 180;

/**
 * 顶栏语言选择下拉菜单关闭收起退场动画的毫秒数（与 `styles/shell.css` 的 `0.18s` 齐平）。
 * 不变量：正整数毫秒数，与对应 CSS 退场时长一致。所属模块：`packages/mini-app-frontend/components/PrefsBar.tsx`。
 */
export const MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS: number = 180;

/**
 * 实时状态页骨架屏中能力折叠行占位的序号表（6 行，对应服务端状态快照的 6 项能力槽位）。
 * 不变量：从 0 起连续递增的只读整数数组，仅用作骨架行 key 与奇偶宽度切换。所属模块：`packages/mini-app-frontend/components/skeletons/StatusSkeleton.tsx`。
 */
export const MINI_APP_STATUS_SKELETON_CAPABILITY_INDICES: readonly number[] = [0, 1, 2, 3, 4, 5];

/**
 * 实时状态页骨架屏中内存指标卡与图例占位的序号表（3 项，对应当前、峰值与堆内存）。
 * 不变量：从 0 起连续递增的只读整数数组，仅用作骨架节点 key。所属模块：`packages/mini-app-frontend/components/skeletons/StatusSkeleton.tsx`。
 */
export const MINI_APP_STATUS_SKELETON_MEMORY_INDICES: readonly number[] = [0, 1, 2];

/**
 * 热发言记录按发言人 ID 取模分配的头像与气泡色调档数。
 * 不变量：正整数，必须与 `styles/chats.css` 中 `.tone-0` 至 `.tone-5` 的色调类数量一致。所属模块：`packages/mini-app-frontend/components/MessagesView.tsx`。
 */
export const MINI_APP_MESSAGE_AVATAR_TONE_COUNT: number = 6;

/**
 * Mini App 原生选择器在等待 `users_shared` / `chat_shared` 回执时的轮询间隔毫秒数。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/api/pickerResult.ts`。
 */
export const MINI_APP_PICKER_POLL_INTERVAL_MS: number = 600;

/**
 * Mini App 原生选择器在等待 `users_shared` / `chat_shared` 回执时的最大轮询次数。
 * 不变量：正整数。所属模块：`packages/mini-app-frontend/api/pickerResult.ts`。
 */
export const MINI_APP_PICKER_POLL_MAX_ATTEMPTS: number = 25;

/**
 * Mini App 顶部 Toast 提示自动消失毫秒数。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/store/app.ts`。
 */
export const MINI_APP_TOAST_DURATION_MS: number = 2_600;

/**
 * Mini App 页面加载、列表刷新与图库骨架屏的最短动画展示毫秒数（0.26 秒，保证闪光骨架与过渡动画完整平滑呈现）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/libs/loading.ts`。
 */
export const MINI_APP_MIN_LOADING_MS: number = 260;

/**
 * 分页控制栏按钮点击后 hover 视觉状态固定保留的毫秒数（85 毫秒，消除移动设备点击翻页后残留的粘滞 hover 状态）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/components/PaginationBar.tsx`。
 */
export const MINI_APP_PAGINATION_HOVER_DURATION_MS: number = 85;

/**
 * Mini App 简体中文网页标题与顶栏主标题默认文案。
 * 不变量：非空短文本，与 `index.html` 的中文标题及 `i18n/languages/zh.ts` 的 `appTitle` 一致。所属模块：`packages/mini-app-frontend/i18n/languages/zh.ts`。
 */
export const MINI_APP_HTML_TITLE: string = "杂鱼控制台♡";

/**
 * Mini App 群详情页可操作的功能开关全集（含 `/init` 总开关）。
 * 不变量：与 `MiniAppFeatureKey` 联合类型一一对应；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/pages/ChatsPage.tsx` 与 `packages/mini-app-frontend/components/skeletons/ChatDetailSkeleton.tsx`。
 */
export const MINI_APP_FEATURE_KEYS: readonly MiniAppFeatureKey[] =
  exhaustiveList<MiniAppFeatureKey>()([
    "init",
    "aiChat",
    "translation",
    "adDetect",
    "floodControl",
    "antiRaid",
    "proxySend",
  ]);

/**
 * Mini App 界面支持的语言键闭集（按英文、日文、中文顺序排列）。
 * 不变量：与 `MiniAppLanguage` 联合类型一一对应。所属模块：`packages/mini-app-frontend/components/PrefsBar.tsx`。
 */
export const MINI_APP_LANGUAGES: readonly MiniAppLanguage[] =
  exhaustiveList<MiniAppLanguage>()([
    "en",
    "ja",
    "zh",
  ]);

/** Mini App 初始主题模式（默认固定为亮色 `"light"`）。不变量：与 `index.html` 根节点 `<html>` 的初始 `data-theme="light"` 属性一致。所属模块：`packages/mini-app-frontend/store/app.ts`。 */
export const MINI_APP_INITIAL_THEME: MiniAppThemeMode = "light";

/** Mini App 界面支持的主题模式闭集（暗色、亮色）。不变量：与 `MiniAppThemeMode` 联合类型一一对应。所属模块：`packages/mini-app-frontend/store/app.ts`。 */
export const MINI_APP_THEME_MODES: readonly MiniAppThemeMode[] =
  exhaustiveList<MiniAppThemeMode>()([
    "dark",
    "light",
  ]);

/** Telegram 宿主未注入主题色（`button_color` / `link_color`）时回退使用的自带默认粉色主色调。不变量：合法的 `#rrggbb` 十六进制颜色字面量，与 `styles/base.css` 中 `--default-accent-color` 一致。所属模块：`packages/mini-app-frontend/store/app.ts`。 */
export const MINI_APP_DEFAULT_ACCENT_COLOR: string = "#ca7896";

/** Telegram 宿主未注入按钮文字色（`button_text_color`）时回退使用的默认亮白文字色。不变量：合法的 `#rrggbb` 十六进制颜色字面量，与 `styles/base.css` 中 `--default-accent-text-color` 一致。所属模块：`packages/mini-app-frontend/store/app.ts`。 */
export const MINI_APP_DEFAULT_ACCENT_TEXT_COLOR: string = "#ffffff";

/** Mini App 亮色主题默认页面背景色。不变量：合法的 `#rrggbb` 十六进制颜色字面量，与 `styles/base.css` 亮色 `--bg` 一致。所属模块：`packages/mini-app-frontend/store/app.ts`。 */
export const MINI_APP_LIGHT_BG_COLOR: string = "#eef2f6";

/** Mini App 暗色主题默认页面背景色。不变量：合法的 `#rrggbb` 十六进制颜色字面量，与 `styles/base.css` 暗色 `--bg` 一致。所属模块：`packages/mini-app-frontend/store/app.ts`。 */
export const MINI_APP_DARK_BG_COLOR: string = "#0f1722";

/** Mini App 亮色主题默认顶栏与卡片背景色。不变量：合法的 `#rrggbb` 十六进制颜色字面量，与 `styles/base.css` 亮色 `--card` 一致。所属模块：`packages/mini-app-frontend/store/app.ts`。 */
export const MINI_APP_LIGHT_HEADER_COLOR: string = "#ffffff";

/** Mini App 暗色主题默认顶栏与卡片背景色。不变量：合法的 `#rrggbb` 十六进制颜色字面量，与 `styles/base.css` 暗色 `--card` 一致。所属模块：`packages/mini-app-frontend/store/app.ts`。 */
export const MINI_APP_DARK_HEADER_COLOR: string = "#182433";

/**
 * Mini App 名单与群内目标添加折叠菜单支持的添加模式闭集（按 ID、按联系人、按频道）。
 * 不变量：与 `MiniAppIdentityAddMode` 联合类型一一对应。所属模块：`packages/mini-app-frontend/components/IdentitySearchAndAddCard.tsx` 与 `packages/mini-app-frontend/components/ChatTargetsMemberPanels.tsx`。
 */
export const MINI_APP_IDENTITY_ADD_MODES: readonly MiniAppIdentityAddMode[] =
  exhaustiveList<MiniAppIdentityAddMode>()([
    "id",
    "users",
    "channel",
  ]);

/**
 * Mini App 侧边栏主导航标签键闭集。
 * 不变量：与 `MiniAppTabKey` 联合类型一一对应。所属模块：`packages/mini-app-frontend/components/AppShell.tsx`。
 */
export const MINI_APP_TAB_KEYS: readonly MiniAppTabKey[] =
  exhaustiveList<MiniAppTabKey>()([
    "status",
    "chats",
    "identities",
    "gallery",
    "totp",
  ]);

/**
 * Mini App 群详情页批量清理新进群成员（`/batch_kick`）允许的最短回溯小时数。
 * 不变量：正整数下界 1，与 `packages/consts/miniApp.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/store/chats.ts` 与 `packages/mini-app-frontend/components/ChatJoinCleanCard.tsx`。
 */
export const MINI_APP_BATCH_KICK_MIN_HOURS: number = 1;

/**
 * Mini App 群详情页批量清理新进群成员（`/batch_kick`）允许的最长回溯小时数。
 * 不变量：正整数上界 24，与 `packages/consts/miniApp.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/store/chats.ts` 与 `packages/mini-app-frontend/components/ChatJoinCleanCard.tsx`。
 */
export const MINI_APP_BATCH_KICK_MAX_HOURS: number = 24;

/**
 * Mini App 群详情页批量清理新进群成员（`/batch_kick`）的初始默认回溯小时数。
 * 不变量：`MINI_APP_BATCH_KICK_MIN_HOURS..MINI_APP_BATCH_KICK_MAX_HOURS` 之间的正整数。所属模块：`packages/mini-app-frontend/store/chats.ts`。
 */
export const MINI_APP_BATCH_KICK_DEFAULT_HOURS: number = 1;

/**
 * Mini App 群详情页批量清理新进群成员（`/batch_kick`）的快捷小时档位列表。
 * 不变量：严格递增的 `1..24` 正整数只读数组。所属模块：`packages/mini-app-frontend/components/ChatJoinCleanCard.tsx`。
 */
export const MINI_APP_BATCH_KICK_PRESET_HOURS: readonly number[] = [1, 3, 6, 12, 24];

/**
 * Mini App 群详情页在后台 `/batch_kick` 批次执行期间轮询服务端完成回调状态的间隔毫秒数（90 秒）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/pages/ChatsPage.tsx`。
 */
export const MINI_APP_BATCH_KICK_POLL_INTERVAL_MS: number = 90_000;

/**
 * Mini App 群详情页切换回溯清理时间窗口（滑块、步进或预设档位）时触发实时入群人数查询的防抖等待毫秒数（0.5 秒）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/store/chats.ts`。
 */
export const MINI_APP_BATCH_KICK_WINDOW_DEBOUNCE_MS: number = 500;

/**
 * Mini App 群详情页点击回溯清理窗口小时按钮（步进 `−`/`+` 或快捷档位 `1h`–`24h`）时进度条与滑块平滑生长并带定点弹性回弹的动画时长毫秒数。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。
 */
export const MINI_APP_BATCH_KICK_RANGE_ANIMATION_MS: number = 320;

/** 滑块进度条弹性生长插值中前段平滑推进与后段阻尼回弹的分界进度比例（`0.62`）。不变量：`(0, 1)` 区间内的浮点数。所属模块：`packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。 */
export const MINI_APP_RANGE_SPRING_SPLIT_PROGRESS: number = 0.62;

/** 滑块进度条弹性回弹振幅按总跨度折算的比例系数。不变量：正浮点数。所属模块：`packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。 */
export const MINI_APP_RANGE_SPRING_AMPLITUDE_RATIO: number = 0.075;

/** 滑块进度条弹性回弹振幅的下限小时数（保证 1 小时单步点击也有清晰回弹）。不变量：正浮点数，小于等于 `MINI_APP_RANGE_SPRING_AMPLITUDE_MAX`。所属模块：`packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。 */
export const MINI_APP_RANGE_SPRING_AMPLITUDE_MIN: number = 0.26;

/** 滑块进度条弹性回弹振幅的上限小时数（限制大跨度跳转时的最大过冲幅度）。不变量：正浮点数，大于等于 `MINI_APP_RANGE_SPRING_AMPLITUDE_MIN`。所属模块：`packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。 */
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

/**
 * Mini App 群详情页目标管理下拉菜单与弹窗支持的类别键闭集（问答对、追着删目标、追着翻目标）。
 * 不变量：与 `MiniAppChatTargetKind` 联合类型一一对应。所属模块：`packages/mini-app-frontend/pages/ChatsPage.tsx` 与 `packages/mini-app-frontend/components/ChatTargetsModal.tsx`。
 */
export const MINI_APP_CHAT_TARGET_KINDS: readonly MiniAppChatTargetKind[] =
  exhaustiveList<MiniAppChatTargetKind>()([
    "qa",
    "deleteMessage",
    "translate",
  ]);

/**
 * Mini App 群内追着翻目标支持的目标语言闭集。
 * 不变量：与 `MiniAppTranslateLanguage` 联合类型一一对应；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/components/ChatTargetsMemberPanels.tsx`。
 */
export const MINI_APP_TRANSLATE_LANGUAGES: readonly MiniAppTranslateLanguage[] =
  exhaustiveList<MiniAppTranslateLanguage>()([
    "ja",
    "cn",
    "en",
    "uk",
    "ru",
  ]);

/**
 * 群内目标管理弹窗数据条目骨架屏中列表行占位的序号表（3 行）。
 * 不变量：从 0 起连续递增的只读整数数组，仅用作骨架行 key。所属模块：`packages/mini-app-frontend/components/skeletons/ChatTargetsListSkeleton.tsx`。
 */
export const MINI_APP_TARGETS_SKELETON_ROW_INDICES: readonly number[] = [0, 1, 2];

/**
 * 每群可登记的问答对条数上限（目标清单尚未加载完成时的前端回退值）。
 * 不变量：正整数，取值与 `packages/consts/qa.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/components/ChatTargetsModal.tsx`。
 */
export const CHAT_QA_MAX_PER_CHAT: number = 15;

/**
 * 单条问答问题文本的最大长度（UTF-16 code unit，目标清单尚未加载完成时的前端回退值）。
 * 不变量：正整数，取值与 `packages/consts/qa.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/components/ChatTargetsQaPanel.tsx`。
 */
export const CHAT_QA_QUESTION_MAX_CHARS: number = 256;

/**
 * 单条问答答案文本的最大长度（UTF-16 code unit，目标清单尚未加载完成时的前端回退值）。
 * 不变量：正整数，取值与 `packages/consts/qa.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/components/ChatTargetsQaPanel.tsx`。
 */
export const CHAT_QA_ANSWER_MAX_CHARS: number = 3_840;

/**
 * 每群同时处于自动删除发言状态的目标身份数上限（目标清单尚未加载完成时的前端回退值）。
 * 不变量：正整数，取值与 `packages/consts/deleteMessage.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/components/ChatTargetsModal.tsx`。
 */
export const DELETE_MESSAGE_CHAT_TARGET_MAX: number = 15;

/**
 * 每群同时开启追着翻译的目标人数上限（目标清单尚未加载完成时的前端回退值）。
 * 不变量：正整数，取值与 `packages/consts/translate.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/components/ChatTargetsModal.tsx`。
 */
export const TRANSLATE_CHAT_USER_LIMIT: number = 5;
