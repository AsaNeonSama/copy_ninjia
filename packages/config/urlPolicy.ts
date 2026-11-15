/** 部署配置 URL 字段的策略化形态校验叶子模块（纯函数，不读盘、不接触缓存）。 */

import { LOOPBACK_HOSTS } from "../consts/agent";
import type { ConfigUrlPolicy } from "../types/config";

/**
 * 按指定策略解析并校验配置 URL 字符串。
 * @param text 已去掉首尾空白的 URL 字符串。
 * @param policy 目标字段对应的 URL 校验策略。
 * @returns 解析且满足策略时返回 `URL` 实例，否则返回 `null`。
 */
export function parseConfigUrl(
  text: string,
  policy: Readonly<ConfigUrlPolicy>
): URL | null {
  const parsed: URL | null = URL.parse(text);
  if (parsed === null) return null;
  if (policy.rejectUserInfo && (parsed.username.length > 0 || parsed.password.length > 0)) {
    return null;
  }
  if (policy.rejectFragment && parsed.hash.length > 0) return null;
  for (const protocol of policy.allowedProtocols) {
    if (parsed.protocol === protocol) return parsed;
  }
  if (
    policy.allowLoopbackHttp &&
    parsed.protocol === "http:" &&
    LOOPBACK_HOSTS.includes(parsed.hostname)
  ) {
    return parsed;
  }
  return null;
}
