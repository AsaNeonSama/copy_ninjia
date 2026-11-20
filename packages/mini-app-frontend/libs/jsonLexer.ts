/**
 * JSON 词法底层的码元判定与字符串/数值切片扫描原语，供 `jsonHighlight.ts` 的无损高亮与语法错误定位共用。
 */

/** JSON 字符串或数值片段的扫描终点与合法性标记。 */
export interface JsonSpanScanResult {
  /** 扫描结束的字符下标（半开区间右界）。 */
  readonly endIndex: number;
  /** 该片段是否符合严格 JSON 词法规则。 */
  readonly valid: boolean;
}

/**
 * 判断 UTF-16 码元是否为 JSON 允许的空白字符（空格、Tab、LF、CR）。
 *
 * @param code UTF-16 字符码元
 * @returns 属于 JSON 空白字符时返回 `true`
 */
export function isJsonWhitespaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * 判断 UTF-16 码元是否为十进制数字（`0`-`9`）。
 *
 * @param code UTF-16 字符码元
 * @returns 属于十进制数字时返回 `true`
 */
export function isDecimalDigitCode(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/**
 * 判断 UTF-16 码元是否为十六进制数字（`0`-`9`、`A`-`F`、`a`-`f`）。
 *
 * @param code UTF-16 字符码元
 * @returns 属于十六进制数字时返回 `true`
 */
function isHexDigitCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

/**
 * 判断 UTF-16 码元是否为 JSON 词法分隔边界（输入结束、空白、BOM、结构括号、冒号、逗号或双引号）。
 *
 * @param code UTF-16 字符码元
 * @returns 命中词法边界时返回 `true`
 */
export function isTokenBoundaryCode(code: number): boolean {
  return (
    Number.isNaN(code) ||
    isJsonWhitespaceCode(code) ||
    code === 0xfeff ||
    code === 0x2c ||
    code === 0x3a ||
    code === 0x5b ||
    code === 0x5d ||
    code === 0x7b ||
    code === 0x7d ||
    code === 0x22
  );
}

/**
 * 跳过指定起点之后的连续 JSON 空白字符。
 *
 * @param source JSON 原始文本
 * @param startPos 扫描起始下标
 * @returns 首个非空白字符下标（或 `source.length`）
 */
export function skipJsonWhitespace(source: string, startPos: number): number {
  let cursor: number = startPos;
  while (cursor < source.length && isJsonWhitespaceCode(source.charCodeAt(cursor))) {
    cursor += 1;
  }
  return cursor;
}

/**
 * 从开引号下标开始扫描 JSON 双引号字符串终点，并校验转义序列与控制字符合法性。
 * 若在闭合引号前遇到换行符，则在换行符前截断为非法切片，以保持逐行对齐稳定。
 *
 * @param source JSON 原始文本
 * @param startIndex 开引号 `"` 所在下标
 * @returns 字符串结束下标与合法性结果
 */
export function scanJsonStringEnd(
  source: string,
  startIndex: number
): Readonly<JsonSpanScanResult> {
  let index: number = startIndex + 1;
  let valid: boolean = true;
  while (index < source.length) {
    const code: number = source.charCodeAt(index);
    if (code === 0x22) {
      return { endIndex: index + 1, valid };
    }
    if (code === 0x0a || code === 0x0d) {
      return { endIndex: index, valid: false };
    }
    if (code < 0x20) {
      valid = false;
      index += 1;
      continue;
    }
    if (code === 0x5c) {
      if (index + 1 >= source.length) {
        return { endIndex: source.length, valid: false };
      }
      const escaped: number = source.charCodeAt(index + 1);
      if (escaped === 0x0a || escaped === 0x0d) {
        return { endIndex: index + 1, valid: false };
      }
      if (escaped === 0x75) {
        if (
          index + 5 < source.length &&
          isHexDigitCode(source.charCodeAt(index + 2)) &&
          isHexDigitCode(source.charCodeAt(index + 3)) &&
          isHexDigitCode(source.charCodeAt(index + 4)) &&
          isHexDigitCode(source.charCodeAt(index + 5))
        ) {
          index += 6;
          continue;
        }
        valid = false;
        index += 2;
        continue;
      }
      if (
        escaped === 0x22 ||
        escaped === 0x5c ||
        escaped === 0x2f ||
        escaped === 0x62 ||
        escaped === 0x66 ||
        escaped === 0x6e ||
        escaped === 0x72 ||
        escaped === 0x74
      ) {
        index += 2;
        continue;
      }
      valid = false;
      index += 2;
      continue;
    }
    index += 1;
  }
  return { endIndex: source.length, valid: false };
}

/**
 * 判断字符串字面量在跳过后续可选 JSON 空白字符后是否紧跟属性冒号 `:`。
 *
 * @param source JSON 原始文本
 * @param afterStringIndex 字符串闭合引号之后的下标
 * @returns 紧跟 `:` 时返回 `true`
 */
export function isFollowedByColon(source: string, afterStringIndex: number): boolean {
  const cursor: number = skipJsonWhitespace(source, afterStringIndex);
  return cursor < source.length && source.charCodeAt(cursor) === 0x3a;
}

/**
 * 从负号或数字起点扫描连续非边界字符并按严格 JSON 数值文法校验。
 *
 * @param source JSON 原始文本
 * @param startIndex 数值起始下标
 * @returns 数值切片结束下标与合法性结果
 */
export function scanJsonNumberEnd(
  source: string,
  startIndex: number
): Readonly<JsonSpanScanResult> {
  let endIndex: number = startIndex;
  while (
    endIndex < source.length &&
    !isTokenBoundaryCode(source.charCodeAt(endIndex))
  ) {
    endIndex += 1;
  }
  const rawNumber: string = source.slice(startIndex, endIndex);
  const valid: boolean =
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(rawNumber);
  return { endIndex, valid };
}
