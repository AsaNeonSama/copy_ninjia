import { MINI_APP_JSON_INDENT_SPACES } from "../consts/miniAppConfig";
import type {
  JsonHighlightToken,
  JsonSyntaxValidationResult,
} from "../types/miniApp/ui";
import { errorMessage } from "./errorMessage";
import {
  isDecimalDigitCode,
  isFollowedByColon,
  isJsonWhitespaceCode,
  isTokenBoundaryCode,
  scanJsonNumberEnd,
  scanJsonStringEnd,
  skipJsonWhitespace,
} from "./jsonLexer";
import type { JsonSpanScanResult } from "./jsonLexer";

/** JSON 非递归语法扫描器的容器栈节点类型。 */
type JsonContainerKind = "object" | "array";

/** JSON 非递归语法扫描器的单步期望状态。 */
type JsonScanExpectation =
  | "value"
  | "after_value"
  | "object_key_or_end"
  | "object_key";

/** 1 起始的文本行列坐标。 */
interface JsonLineColumn {
  /** 1 起始行号。 */
  readonly line: number;
  /** 1 起始列号。 */
  readonly column: number;
}

/**
 * 将任意 JSON 编辑区文本切分为无损词法高亮 Token 序列（区分对象键名、字符串值、数值、布尔、`null`、括号、标点与非法片段）。
 * 拼接全部返回项的 `text` 与输入 `source` 完全恒等，保证透明 `<textarea>` 与底层高亮 `<pre>` 逐字符严丝合缝对齐。
 *
 * @param source 原始编辑区文本
 * @returns 只读词法高亮 Token 数组
 */
export function tokenizeJsonForHighlight(
  source: string
): readonly Readonly<JsonHighlightToken>[] {
  const tokens: JsonHighlightToken[] = [];
  let index: number = 0;
  while (index < source.length) {
    const code: number = source.charCodeAt(index);
    if (isJsonWhitespaceCode(code)) {
      let end: number = index + 1;
      while (end < source.length && isJsonWhitespaceCode(source.charCodeAt(end))) {
        end += 1;
      }
      tokens.push({ kind: "whitespace", text: source.slice(index, end) });
      index = end;
      continue;
    }
    if (
      code === 0x7b ||
      code === 0x7d ||
      code === 0x5b ||
      code === 0x5d
    ) {
      tokens.push({ kind: "brace", text: source.slice(index, index + 1) });
      index += 1;
      continue;
    }
    if (code === 0x3a || code === 0x2c) {
      tokens.push({ kind: "punct", text: source.slice(index, index + 1) });
      index += 1;
      continue;
    }
    if (code === 0xfeff) {
      tokens.push({ kind: "invalid", text: source.slice(index, index + 1) });
      index += 1;
      continue;
    }
    if (code === 0x22) {
      const scanned: Readonly<JsonSpanScanResult> = scanJsonStringEnd(source, index);
      const text: string = source.slice(index, scanned.endIndex);
      if (!scanned.valid) {
        tokens.push({ kind: "invalid", text });
      } else if (isFollowedByColon(source, scanned.endIndex)) {
        tokens.push({ kind: "key", text });
      } else {
        tokens.push({ kind: "string", text });
      }
      index = scanned.endIndex;
      continue;
    }
    if (code === 0x2d || isDecimalDigitCode(code)) {
      const scanned: Readonly<JsonSpanScanResult> = scanJsonNumberEnd(source, index);
      tokens.push({
        kind: scanned.valid ? "number" : "invalid",
        text: source.slice(index, scanned.endIndex),
      });
      index = scanned.endIndex;
      continue;
    }
    let end: number = index + 1;
    while (end < source.length && !isTokenBoundaryCode(source.charCodeAt(end))) {
      end += 1;
    }
    const word: string = source.slice(index, end);
    if (word === "true" || word === "false") {
      tokens.push({ kind: "boolean", text: word });
    } else if (word === "null") {
      tokens.push({ kind: "null", text: word });
    } else {
      tokens.push({ kind: "invalid", text: word });
    }
    index = end;
  }
  return tokens;
}

/**
 * 按严格 JSON 文法以显式容器栈单遍扫描非法 JSON 文本，定位首个语法错误的 0 起始字符下标（夹逼在 `[0, source.length]` 之间）。
 *
 * @param source 非法 JSON 原始文本
 * @returns 0 起始的错误字符下标
 */
function locateJsonSyntaxErrorOffset(source: string): number {
  const containers: JsonContainerKind[] = [];
  let mode: JsonScanExpectation = "value";
  let cursor: number = 0;

  while (true) {
    if (mode === "object_key_or_end" || mode === "object_key") {
      cursor = skipJsonWhitespace(source, cursor);
      if (cursor >= source.length) {
        return source.length;
      }
      if (mode === "object_key_or_end" && source.charCodeAt(cursor) === 0x7d) {
        containers.pop();
        cursor += 1;
        mode = "after_value";
        continue;
      }
      if (source.charCodeAt(cursor) !== 0x22) {
        return cursor;
      }
      const keySpan: Readonly<JsonSpanScanResult> = scanJsonStringEnd(source, cursor);
      if (!keySpan.valid) {
        return cursor;
      }
      cursor = skipJsonWhitespace(source, keySpan.endIndex);
      if (cursor >= source.length || source.charCodeAt(cursor) !== 0x3a) {
        return Math.min(cursor, source.length);
      }
      cursor += 1;
      mode = "value";
      continue;
    }

    if (mode === "value") {
      cursor = skipJsonWhitespace(source, cursor);
      if (cursor >= source.length) {
        return source.length;
      }
      const code: number = source.charCodeAt(cursor);
      if (code === 0x7b) {
        containers.push("object");
        cursor += 1;
        mode = "object_key_or_end";
        continue;
      }
      if (code === 0x5b) {
        const nextPos: number = skipJsonWhitespace(source, cursor + 1);
        if (nextPos < source.length && source.charCodeAt(nextPos) === 0x5d) {
          cursor = nextPos + 1;
          mode = "after_value";
          continue;
        }
        containers.push("array");
        cursor = nextPos;
        mode = "value";
        continue;
      }
      if (code === 0x22) {
        const strSpan: Readonly<JsonSpanScanResult> = scanJsonStringEnd(source, cursor);
        if (!strSpan.valid) {
          return cursor;
        }
        cursor = strSpan.endIndex;
        mode = "after_value";
        continue;
      }
      if (code === 0x2d || isDecimalDigitCode(code)) {
        const numSpan: Readonly<JsonSpanScanResult> = scanJsonNumberEnd(source, cursor);
        if (!numSpan.valid) {
          return cursor;
        }
        cursor = numSpan.endIndex;
        mode = "after_value";
        continue;
      }
      if (
        source.startsWith("true", cursor) &&
        isTokenBoundaryCode(source.charCodeAt(cursor + 4))
      ) {
        cursor += 4;
        mode = "after_value";
        continue;
      }
      if (
        source.startsWith("false", cursor) &&
        isTokenBoundaryCode(source.charCodeAt(cursor + 5))
      ) {
        cursor += 5;
        mode = "after_value";
        continue;
      }
      if (
        source.startsWith("null", cursor) &&
        isTokenBoundaryCode(source.charCodeAt(cursor + 4))
      ) {
        cursor += 4;
        mode = "after_value";
        continue;
      }
      return cursor;
    }

    cursor = skipJsonWhitespace(source, cursor);
    const activeContainer: JsonContainerKind | undefined = containers.at(-1);
    if (activeContainer === undefined) {
      return Math.max(0, Math.min(cursor, source.length));
    }
    if (cursor >= source.length) {
      return source.length;
    }
    const code: number = source.charCodeAt(cursor);
    if (activeContainer === "object") {
      if (code === 0x2c) {
        cursor += 1;
        mode = "object_key";
        continue;
      }
      if (code === 0x7d) {
        containers.pop();
        cursor += 1;
        continue;
      }
      return cursor;
    }
    if (code === 0x2c) {
      cursor = skipJsonWhitespace(source, cursor + 1);
      if (cursor < source.length && source.charCodeAt(cursor) === 0x5d) {
        return cursor;
      }
      mode = "value";
      continue;
    }
    if (code === 0x5d) {
      containers.pop();
      cursor += 1;
      continue;
    }
    return cursor;
  }
}

/**
 * 将 0 起始的字符偏移量转换为 1 起始的（行号，列号）坐标。
 *
 * @param source 原始文本
 * @param offset 0 起始的字符偏移量
 * @returns 1 起始的行列号对象
 */
function offsetToLineAndColumn(
  source: string,
  offset: number
): Readonly<JsonLineColumn> {
  const clamped: number = Math.max(0, Math.min(offset, source.length));
  let line: number = 1;
  let column: number = 1;
  for (let i: number = 0; i < clamped; i += 1) {
    if (source.charCodeAt(i) === 0x0a) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

/**
 * 校验编辑区 JSON 文本语法是否合法；失败时返回精确的 1 起始行列号与原因说明。
 *
 * @param source 待校验的 JSON 文本
 * @returns 语法校验结果
 */
export function validateJsonSyntax(
  source: string
): Readonly<JsonSyntaxValidationResult> {
  if (source.trim().length === 0) {
    return {
      ok: false,
      empty: true,
      line: 1,
      column: 1,
      reason: "Empty JSON input",
    };
  }
  try {
    JSON.parse(source);
    return { ok: true };
  } catch (error: unknown) {
    const errorOffset: number = locateJsonSyntaxErrorOffset(source);
    const coords: Readonly<JsonLineColumn> = offsetToLineAndColumn(
      source,
      errorOffset
    );
    return {
      ok: false,
      empty: false,
      line: coords.line,
      column: coords.column,
      reason: errorMessage(error),
    };
  }
}

/**
 * 将合法 JSON 文本按 2 空格标准缩进重新格式化并确保末尾带换行符。
 *
 * @param source 合法 JSON 原始文本
 * @returns 格式化后的 JSON 文本
 */
export function formatJsonPretty(source: string): string {
  const parsed: unknown = JSON.parse(source);
  return `${JSON.stringify(parsed, null, MINI_APP_JSON_INDENT_SPACES)}\n`;
}
