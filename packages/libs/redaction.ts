import { REDACTED_SECRET, REDACTED_URL } from "../consts/redaction";

/**
 * 从一段文本中移除所有已知敏感值。按字面量替换，不使用动态正则；空值不参与替换。
 *
 * 先 `includes` 再替换，未命中的常见路径不创建临时数组；命中时用字符串形态的
 * `replaceAll` 做字面量匹配。占位符 REDACTED_SECRET 不含 `$`，不触发替换模式转义。
 * @param text 待脱敏的原始文本。
 * @param secrets 需要按字面量抹除的敏感字符串列表。
 * @returns 将全部非空敏感子串替换为固定脱敏占位符后的文本。
 */
export function redactSecretsInText(text: string, secrets: readonly string[]): string {
  let redacted: string = text;
  for (const secret of secrets) {
    if (secret.length === 0 || !redacted.includes(secret)) continue;
    redacted = redacted.replaceAll(secret, REDACTED_SECRET);
  }
  return redacted;
}

/**
 * 日志地址只保留 origin 与 pathname，移除查询串、fragment 与 userinfo；
 * 非法 URL 返回统一占位符。素材日志标签与统一日志序列化边界均复用本函数。
 * @param raw 原始 URL 字符串。
 * @returns 仅保留 `origin + pathname` 的脱敏地址，或非法 URL 时的统一占位符。
 */
export function redactUrlForLog(raw: string): string {
  const url: URL | null = URL.parse(raw);
  return url === null ? REDACTED_URL : `${url.origin}${url.pathname}`;
}
