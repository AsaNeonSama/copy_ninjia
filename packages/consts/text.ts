/** 单行文本归一化的空白匹配规则，覆盖 NEL。 */
export const INLINE_WHITESPACE_PATTERN: RegExp = /[\s\u0085]+/g;

/**
 * libs/text.ts 的 sanitizeInline 前置判定：非普通空格的空白（换行、制表等）、NEL、
 * 首空格、尾空格或连续空格任一出现，即说明折叠会改动输入。空白集合与
 * INLINE_WHITESPACE_PATTERN 一致；不带 g/y 标志，test() 不受 lastIndex 影响也不改写它，可重复共享。
 */
export const INLINE_SANITIZE_REQUIRED_PATTERN: RegExp = /[^\S ]|\u0085|^ | $| {2}/;

/** libs/text.ts 的 truncateWithEllipsis 缺省补在截断处的省略号。 */
export const TRUNCATION_ELLIPSIS: string = "…";

/**
 * Unicode 双向文本控制字符（ALM、LRM/RLM、LRE/RLE/PDF/LRO/RLO、LRI/RLI/FSI/PDI）的全局匹配规则，
 * 展示前从昵称、用户名、频道名与群标题中剥掉 RLO 等控制字符，防止反转整行布局。
 * 不变量：带 g 标志，只交给 `String.prototype.replace` 整段替换，不用于 test()/exec()；取值与
 * `packages/mini-app-frontend/consts/miniApp.ts` 的 `MINI_APP_BIDI_CONTROL_CHARS_PATTERN` 一致，由
 * `test/mini-app-frontend/frontendParity.test.ts` 核对。
 * 所属模块：`packages/libs/text.ts` 的 `sanitizeDisplayName`、`packages/mini-app-api-server/view/identities/metadata.ts`
 * 与 `packages/mini-app-api-server/view/chats/targets.ts`。
 */
export const BIDI_CONTROL_PATTERN: RegExp = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** 用户名规范化时去除的连续前导 @。 */
export const LEADING_AT_SIGNS_PATTERN: RegExp = /^@+/;

/** 代码围栏语言标签不允许包含的空白与反引号。 */
export const FENCE_LANGUAGE_REJECT: RegExp = /[\s`]/;
