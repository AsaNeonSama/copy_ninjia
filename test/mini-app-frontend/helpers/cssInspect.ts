/** Mini App 前端样式测试共用的 CSS 注释剥离、规则块提取与自定义属性解析辅助工具。 */

/** 读取并剥离注释后的 CSS 文件全文。 */
export async function readStrippedCss(relativePath: string): Promise<string> {
  return (await Bun.file(relativePath).text()).replace(/\/\*[\s\S]*?\*\//gu, "");
}

/** 从剥离注释后的 CSS 文本中按大括号配对提取指定规则或媒体查询块体。 */
export function extractCssBlockBody(css: string, headerPattern: RegExp): string {
  const match: RegExpExecArray | null = headerPattern.exec(css);
  if (match === null) return "";
  const openBraceIdx: number = match.index + match[0].lastIndexOf("{");
  let depth: number = 1;
  let cursor: number = openBraceIdx + 1;
  while (cursor < css.length && depth > 0) {
    const ch: string | undefined = css[cursor];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    cursor += 1;
  }
  return depth === 0 ? css.slice(openBraceIdx + 1, cursor - 1) : "";
}

/** 解析 CSS 规则块内的 `--*` 自定义属性键值映射。 */
export function parseCssVariables(blockBody: string): ReadonlyMap<string, string> {
  const vars: Map<string, string> = new Map<string, string>();
  const pattern: RegExp = /(--[a-z0-9-]+)\s*:\s*([^;]+);/giu;
  let match: RegExpExecArray | null = pattern.exec(blockBody);
  while (match !== null) {
    if (match[1] !== undefined && match[2] !== undefined) vars.set(match[1], match[2].trim());
    match = pattern.exec(blockBody);
  }
  return vars;
}
