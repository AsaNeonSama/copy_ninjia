/** HTTPS 出站请求的轻量 URL allowlist；不负责 DNS 解析或响应体读取。 */

export interface AllowedHttpsUrlPolicy {
  allowedOrigins?: readonly string[];
  allowedHostnameSuffixes?: readonly string[];
}

export interface ParseAllowedHttpsUrlParams {
  /** 待解析与校验的原始 URL 字符串或 URL 实例。 */
  input: string | URL;
  /** 允许的 HTTPS 源与主机名后缀白名单策略。 */
  policy: AllowedHttpsUrlPolicy;
}

/**
 * 判断主机名是否精确匹配或以点分边界命中允许的后缀列表。
 * @param hostname 待校验的主机名。
 * @param allowedSuffixes 允许的主机名后缀只读列表。
 * @returns 命中任一允许后缀时返回 true，否则返回 false。
 */
function isAllowedHostname(hostname: string, allowedSuffixes: readonly string[]): boolean {
  const normalizedHostname: string = hostname.toLowerCase();
  return allowedSuffixes.some((suffix: string): boolean => {
    const normalizedSuffix: string = suffix.toLowerCase();
    return normalizedHostname === normalizedSuffix || normalizedHostname.endsWith(`.${normalizedSuffix}`);
  });
}

/**
 * 只接受 allowlist 内的 HTTPS URL。origin 规则精确匹配；hostname suffix
 * 规则按 DNS label 边界匹配且拒绝自定义端口。
 * @param params 待校验的 URL 输入与白名单策略。
 * @returns 通过策略校验的 URL 实例；不合法或不在白名单内时返回 null。
 */
export function parseAllowedHttpsUrl({
  input,
  policy,
}: ParseAllowedHttpsUrlParams): URL | null {
  const url: URL | null = URL.parse(typeof input === "string" ? input : input.href);
  if (url?.protocol !== "https:" || url.username !== "" || url.password !== "") return null;

  if (policy.allowedOrigins?.includes(url.origin) === true) return url;
  if (
    url.port === "" &&
    policy.allowedHostnameSuffixes !== undefined &&
    isAllowedHostname(url.hostname, policy.allowedHostnameSuffixes)
  ) {
    return url;
  }
  return null;
}
