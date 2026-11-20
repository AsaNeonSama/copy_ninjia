/**
 * Mini App 前端「配置编辑」模块的受管配置文件白名单、字节上限与编辑器排版常量。
 * 与服务端重合的常量取值保持一致（由 `test/mini-app-frontend/frontendParity.test.ts` 核对）。
 */

import type {
  MiniAppDynamicConfigFileName,
  MiniAppStaticConfigFileName,
} from "../types/miniAppConfigs";
import { exhaustiveList } from "./exhaustiveList";

/** Mini App 动态配置标签页允许查看和编辑的 `config/dynamic/` JSON 文件名闭集。不变量：与 `MiniAppDynamicConfigFileName` 联合类型一一对应，取值与 `packages/consts/miniAppConfig.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/store/configs.ts`。 */
export const MINI_APP_DYNAMIC_CONFIG_FILES: readonly MiniAppDynamicConfigFileName[] =
  exhaustiveList<MiniAppDynamicConfigFileName>()([
    "ad_detect.json",
    "agent.json",
    "assets.json",
    "cron.json",
    "mood.json",
    "stickers.json",
  ]);

/** Mini App 静态配置标签页允许查看和编辑的 `config/static/` JSON 文件名闭集。不变量：与 `MiniAppStaticConfigFileName` 联合类型一一对应，取值与 `packages/consts/miniAppConfig.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/store/configs.ts`。 */
export const MINI_APP_STATIC_CONFIG_FILES: readonly MiniAppStaticConfigFileName[] =
  exhaustiveList<MiniAppStaticConfigFileName>()([
    "bot.json",
    "g-auth.json",
  ]);

/** Mini App 单个 JSON 配置文件允许编辑与提交的最大 UTF-8 字节数（2 MiB）。不变量：正整数，取值与 `packages/consts/miniAppConfig.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/store/configs.ts`。 */
export const MINI_APP_MAX_CONFIG_CONTENT_BYTES: number = 2 * 1024 * 1024;

/** JSON 编辑器格式化美化与 Tab 键缩进使用的空格数量（2 空格）。不变量：正整数。所属模块：`packages/mini-app-frontend/components/JsonCodeEditor.tsx` 与 `packages/mini-app-frontend/store/configs.ts`。 */
export const MINI_APP_JSON_INDENT_SPACES: number = 2;

/** JSON 编辑器按下 Tab 键时在光标处插入的双空格缩进文本。不变量：长度等于 `MINI_APP_JSON_INDENT_SPACES` 的纯空格字符串。所属模块：`packages/mini-app-frontend/components/JsonCodeEditor.tsx`。 */
export const MINI_APP_JSON_INDENT_TEXT: string = "  ";

/** 配置编辑器骨架屏中模拟 JSON 结构代码行占位的序号表（24 行，覆盖高屏全屏视口下的完整代码舞台）。不变量：从 0 起连续递增的只读整数数组，长度与 `MINI_APP_CONFIG_SKELETON_LINE_INDENTS`、`MINI_APP_CONFIG_SKELETON_LINE_WIDTHS` 一致。所属模块：`packages/mini-app-frontend/components/skeletons/ConfigEditorSkeleton.tsx`。 */
export const MINI_APP_CONFIG_SKELETON_LINE_INDICES: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
  12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
];

/** 配置编辑器骨架屏各行模拟 JSON 嵌套层级的左缩进像素表（0–3 层，24 行）。不变量：长度等于 `MINI_APP_CONFIG_SKELETON_LINE_INDICES.length` 的只读 CSS 像素字符串数组。所属模块：`packages/mini-app-frontend/components/skeletons/ConfigEditorSkeleton.tsx`。 */
export const MINI_APP_CONFIG_SKELETON_LINE_INDENTS: readonly string[] = [
  "0px",
  "16px",
  "16px",
  "16px",
  "32px",
  "32px",
  "32px",
  "32px",
  "48px",
  "48px",
  "32px",
  "32px",
  "16px",
  "16px",
  "32px",
  "32px",
  "32px",
  "16px",
  "16px",
  "32px",
  "32px",
  "16px",
  "16px",
  "0px",
];

/** 配置编辑器骨架屏各行模拟 JSON 花括号、键值对与数组元素的百分比宽度表（24 行）。不变量：长度等于 `MINI_APP_CONFIG_SKELETON_LINE_INDICES.length` 的只读 CSS 百分比宽度字符串数组。所属模块：`packages/mini-app-frontend/components/skeletons/ConfigEditorSkeleton.tsx`。 */
export const MINI_APP_CONFIG_SKELETON_LINE_WIDTHS: readonly string[] = [
  "12%",
  "46%",
  "68%",
  "38%",
  "62%",
  "52%",
  "78%",
  "34%",
  "56%",
  "48%",
  "16%",
  "44%",
  "14%",
  "36%",
  "54%",
  "42%",
  "72%",
  "14%",
  "32%",
  "66%",
  "60%",
  "16%",
  "50%",
  "10%",
];

/** 配置编辑器骨架屏行号栏从一位数切换为两位数宽度的 0 起始行下标（第 10 行对应下标 9）。不变量：非负整数。所属模块：`packages/mini-app-frontend/components/skeletons/ConfigEditorSkeleton.tsx`。 */
export const MINI_APP_CONFIG_SKELETON_TWO_DIGIT_LINE_START_INDEX: number = 9;

/** 配置文件下拉选择器单屏可视窗口展示的选项条数（超出该数量时展示纵向高度滑条并启用滚动）。不变量：正整数。所属模块：`packages/mini-app-frontend/components/ConfigFileSelector.tsx`。 */
export const MINI_APP_CONFIG_SELECTOR_VISIBLE_OPTIONS: number = 3;

/** 配置文件下拉选择器纵向高度滑条滑块占轨道高度的最小百分比下限。不变量：1 到 100 之间的正整数。所属模块：`packages/mini-app-frontend/components/ConfigFileSelector.tsx`。 */
export const MINI_APP_CONFIG_SELECTOR_MIN_THUMB_PERCENT: number = 22;

/** JSON 代码编辑器纵横平行四边形滑条滑块占轨道长度的最小百分比下限。不变量：1 到 100 之间的正整数。所属模块：`packages/mini-app-frontend/components/JsonCodeEditor.tsx`。 */
export const MINI_APP_JSON_EDITOR_MIN_THUMB_PERCENT: number = 14;

/** JSON 代码编辑器存在纵向或横向溢出时为平行四边形滑条预留的侧边通道像素宽度。不变量：正整数。所属模块：`packages/mini-app-frontend/components/JsonCodeEditor.tsx`。 */
export const MINI_APP_JSON_EDITOR_SCROLLBAR_LANE_PX: number = 20;

/** JSON 代码编辑器纵横双向滑条同时可见时纵向滑轨底部为交汇角预留的像素间距。不变量：大于 `MINI_APP_JSON_EDITOR_SCROLLBAR_LANE_PX` 的正整数。所属模块：`packages/mini-app-frontend/components/JsonCodeEditor.tsx`。 */
export const MINI_APP_JSON_EDITOR_CORNER_CLEARANCE_PX: number = 24;
