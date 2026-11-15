import { miniAppActiveUrlPartsHolder } from "../../cache/main/miniApp";
import { getBotMiniAppConfig } from "../../config/bot";
import type { BotMiniAppConfig } from "../../types/config";
import type { MiniAppPublicUrlParts } from "../../types/miniApp/server";

/** `normalizeRoutePathname` 的返回结果。 */
export interface NormalizedRoutePath {
  /** 需 `308` 重定向补齐末尾斜杠时的目标路径（不含查询串）。 */
  readonly redirectTo?: string;
  /** 剥离 `mini_app.url` 子路径前缀后的内部路由路径。 */
  readonly routePath: string;
}

/**
 * 从 `mini_app` 配置派生归一化后的基础路径前缀与小写公网主机名。
 * @param config `mini_app` 部署配置或覆盖配置。
 * @returns 归一化后的 `{ basePath, host }`；配置缺失或 URL 解析失败时返回 `{ basePath: "/", host: "" }`。
 */
export function deriveMiniAppPublicUrlParts(
  config: Readonly<BotMiniAppConfig> | undefined
): Readonly<MiniAppPublicUrlParts> {
  const parsed: URL | null = config === undefined ? null : URL.parse(config.url);
  if (parsed === null) return { basePath: "/", host: "" };
  const pathname: string = parsed.pathname.replace(/\/+$/u, "");
  return {
    basePath: pathname.length > 0 ? pathname : "/",
    host: parsed.host.toLowerCase(),
  };
}

/**
 * 归一化配置中的基础路径前缀（去除末尾斜杠，根路径保持 `"/"`）。
 * @returns 归一化后的基础路径。
 */
export function configuredBasePathname(): string {
  return (
    miniAppActiveUrlPartsHolder.current ??
    deriveMiniAppPublicUrlParts(getBotMiniAppConfig())
  ).basePath;
}

/**
 * 按 `mini_app.url` 配置的子路径前缀将请求路径归一化为内部路由路径：
 * 请求路径恰为无末尾斜杠的 `${basePath}` 时给出 `308` 补斜杠目标，带 `${basePath}/` 前缀时剥离前缀，无前缀时保持原路径（兼容保留前缀与剥离前缀两种反代转发模式）。
 * @param rawPathname 原始 `url.pathname`。
 * @returns 归一化后的内部路由路径，以及可选的补斜杠重定向目标。
 */
export function normalizeRoutePathname(rawPathname: string): NormalizedRoutePath {
  const basePath: string = configuredBasePathname();
  if (basePath !== "/") {
    if (rawPathname === basePath) return { redirectTo: `${basePath}/`, routePath: "/" };
    if (rawPathname.startsWith(`${basePath}/`)) {
      const stripped: string = rawPathname.slice(basePath.length);
      return { routePath: stripped.length > 0 ? stripped : "/" };
    }
  }
  return { routePath: rawPathname.length > 0 ? rawPathname : "/" };
}
