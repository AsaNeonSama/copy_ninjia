/**
 * Mini App 前端界面偏好、主导航、SVG 图标与 JSON 编辑器高亮/语法校验类型。
 */

/** Mini App 界面支持的语言键（英文、日文、中文）。 */
export type MiniAppLanguage = "en" | "ja" | "zh";

/** Mini App 界面支持的主题模式（暗色、亮色）。 */
export type MiniAppThemeMode = "dark" | "light";

/** Mini App 主导航标签键。 */
export type MiniAppTabKey =
  | "status"
  | "chats"
  | "identities"
  | "adBlacklists"
  | "configs"
  | "gallery"
  | "totp";

/** Mini App 通用 SVG 图标组件入参。 */
export interface MiniAppIconProps {
  /** 图标边长像素值（缺省按各图标默认尺寸渲染）。 */
  readonly size?: number;
  /** 附加的 CSS 类名。 */
  readonly className?: string;
}

/** Mini App 侧边栏主导航标签 SVG 图标入参。 */
export interface MiniAppTabIconProps extends MiniAppIconProps {
  /** 导航标签键。 */
  readonly tabKey: MiniAppTabKey;
}

/** Mini App 顶栏多语言切换球标 SVG 图标入参。 */
export interface MiniAppGlobeIconProps extends MiniAppIconProps {
  /** 当前界面语言键（缺省为中文 `"zh"`，对应右下角 `CN` 角标）。 */
  readonly language?: MiniAppLanguage;
}

/** JSON 代码编辑器词法高亮 Token 类别。 */
export type JsonHighlightTokenKind =
  | "key"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "brace"
  | "punct"
  | "whitespace"
  | "invalid";

/** JSON 代码编辑器单个词法高亮切片（拼接全部 `text` 与原始输入逐字符一致）。 */
export interface JsonHighlightToken {
  /** 词法类别。 */
  readonly kind: JsonHighlightTokenKind;
  /** 原始文本片段。 */
  readonly text: string;
}

/** JSON 文本语法预校验结果（精确到 1 起始的行列号）。 */
export type JsonSyntaxValidationResult =
  | {
    readonly ok: true;
  }
  | {
    readonly ok: false;
    readonly empty: boolean;
    readonly line: number;
    readonly column: number;
    readonly reason: string;
  };
