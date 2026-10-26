import type {
  MiniAppMiddleware,
  MiniAppRouteContext,
  MiniAppRouteHandler,
} from "../../types/miniApp";
import { normalizeRoutePathname } from "../libs/routePath";
import type { NormalizedRoutePath } from "../libs/routePath";

/**
 * 按洋葱管道模型顺序执行中间件链并最终调用路由处理器。
 * @param ctx 路由请求上下文。
 * @param middlewares 按顺序执行的中间件列表。
 * @param handler 终端路由处理器。
 * @returns 最终生成的 HTTP `Response`。
 */
export async function executeMiniAppMiddlewareChain(
  ctx: Readonly<MiniAppRouteContext>,
  middlewares: readonly MiniAppMiddleware[],
  handler: MiniAppRouteHandler
): Promise<Response> {
  let index: number = -1;
  const dispatch = async (currentIndex: number): Promise<Response> => {
    if (currentIndex <= index) {
      throw new Error("Mini App middleware next() called multiple times.");
    }
    index = currentIndex;
    const currentMiddleware: MiniAppMiddleware | undefined =
      middlewares[currentIndex];
    if (currentMiddleware === undefined) {
      return handler(ctx);
    }
    return currentMiddleware(ctx, (): Response | Promise<Response> =>
      dispatch(currentIndex + 1)
    );
  };
  return dispatch(0);
}

/**
 * 将中间件链与路由处理器包装为可直接挂入 `Bun.serve({ routes })` 的单参请求处理函数；
 * 路径参数取自 `Bun.serve` 注入的 `request.params`（已解码，无参数路由为空对象）。
 * @param middlewares 按顺序执行的中间件列表。
 * @param handler 终端路由处理器。
 * @returns 接受 `Request` 并返回 `Promise<Response>` 的函数。
 */
export function withMiniAppMiddlewareChain(
  middlewares: readonly MiniAppMiddleware[],
  handler: MiniAppRouteHandler
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url: URL = new URL(request.url);
    const method: string = request.method.toUpperCase();
    const normalized: NormalizedRoutePath = normalizeRoutePathname(url.pathname);
    const ctx: Readonly<MiniAppRouteContext> = {
      request,
      url,
      method,
      routePath: normalized.routePath,
      params: (request as Bun.BunRequest<string>).params,
    };
    return executeMiniAppMiddlewareChain(ctx, middlewares, handler);
  };
}
