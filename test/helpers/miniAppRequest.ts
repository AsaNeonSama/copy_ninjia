import {
  createMiniAppBunRoutes,
  handleMiniAppHttpRequest,
} from "../../packages/mini-app-api-server";

/**
 * 匹配路径模式（支持 `:param` 动态段）并提取已解码的路径参数。
 * @param pattern 路由模式（如 `"/api/chats/:chatId/targets"`）。
 * @param pathname 请求 `url.pathname`。
 * @returns 命中时返回解码后的参数表，未命中时返回 `null`。
 */
function matchRoutePattern(
  pattern: string,
  pathname: string
): Readonly<Record<string, string>> | null {
  if (pattern === pathname) return {};
  if (!pattern.includes(":")) return null;
  const patternParts: readonly string[] = pattern.split("/");
  const pathParts: readonly string[] = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i: number = 0; i < patternParts.length; i += 1) {
    const patternPart: string = patternParts[i]!;
    const pathPart: string = pathParts[i]!;
    if (patternPart.startsWith(":")) {
      if (pathPart.length === 0) return null;
      try {
        params[patternPart.slice(1)] = decodeURIComponent(pathPart);
      } catch (_error: unknown) {
        return null;
      }
      continue;
    }
    if (patternPart !== pathPart) return null;
  }
  return params;
}

/**
 * 在进程内按 `Bun.serve` 的 `routes` → `fetch` 顺序分发测试 HTTP 请求：
 * 先匹配 `createMiniAppBunRoutes()` 中已注册的原生路由与 HTTP 方法并注入 `request.params`，
 * 未命中路径或方法时落入 `handleMiniAppHttpRequest` 兜底处理器。
 * @param request 传入的测试 `Request`。
 * @returns 完整的 HTTP `Response`。
 */
export async function dispatchMiniAppTestRequest(request: Request): Promise<Response> {
  const url: URL = new URL(request.url);
  const method: string = request.method.toUpperCase();
  const routes: Bun.Serve.Routes<undefined, string> = createMiniAppBunRoutes();
  for (const [pattern, entry] of Object.entries(routes)) {
    if (
      pattern === "/_bundle" ||
      entry === undefined ||
      typeof entry !== "object" ||
      entry === null ||
      entry instanceof Response
    ) {
      continue;
    }
    const params: Readonly<Record<string, string>> | null = matchRoutePattern(
      pattern,
      url.pathname
    );
    if (params === null) continue;
    const methodHandler: unknown = (entry as Readonly<Record<string, unknown>>)[method];
    if (typeof methodHandler !== "function") continue;
    (request as Request & { params?: Readonly<Record<string, string>> }).params = params;
    return await (methodHandler as (req: Request) => Response | Promise<Response>)(request);
  }
  return handleMiniAppHttpRequest(request);
}
