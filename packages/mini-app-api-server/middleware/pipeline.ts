import type { MiniAppAuthSession } from "../../types/miniApp/auth";
import type {
  MiniAppAuthPolicy,
  MiniAppBunRouteHandler,
  MiniAppRouteContext,
  MiniAppRouteHandler,
} from "../../types/miniApp/server";
import { attachRefreshedSessionHeaders } from "../auth/session";
import { extractSessionToken } from "../libs/request";
import { normalizeRoutePathname } from "../libs/routePath";
import type { NormalizedRoutePath } from "../libs/routePath";
import { verifyMiniAppRequestHeadersFast } from "./headerGuard";
import type { MiniAppHeaderGuardResult } from "./headerGuard";
import { verifyMiniAppInitDataAccess } from "./initData";
import type { MiniAppInitDataAccessResult } from "./initData";
import { verifyMiniAppSessionAccess } from "./sessionToken";
import type { MiniAppSessionAccessResult } from "./sessionToken";

/** Mini App 同步鉴权管道返回的统一准入结果。 */
export type MiniAppAuthorizationResult =
  | { readonly ok: true; readonly session: Readonly<MiniAppAuthSession> | null; readonly inputSessionToken: string }
  | { readonly ok: false; readonly response: Response };

/**
 * 按策略配置的固定同步顺序执行 Mini App 请求鉴权：
 * 1. 请求头与凭据形态快路径校验（一次提取请求头 `initData`）；
 * 2. 一次性提取会话令牌，依次执行 Telegram WebApp `initData`（或受保护资源令牌 `?token=`）校验与 30 分钟密码锁定校验；
 * 3. 当 `policy.requireSession` 为真时执行 45 分钟密码会话校验与静默续期准备（显式处理 `?token=` 免检）。
 * @param ctx 路由请求上下文。
 * @param policy 路由静态声明的鉴权策略。
 * @returns 鉴权通过时返回生效会话与输入会话令牌；失败时返回拦截 `Response`。
 */
export function authorizeMiniAppRequest(
  ctx: Readonly<MiniAppRouteContext>,
  policy: Readonly<MiniAppAuthPolicy>
): MiniAppAuthorizationResult {
  const headerResult: MiniAppHeaderGuardResult = verifyMiniAppRequestHeadersFast(
    ctx,
    policy.allowQueryAuth
  );
  if (!headerResult.ok) {
    return headerResult;
  }

  const nowMs: number = Date.now();
  const sessionToken: string = extractSessionToken(
    ctx.request,
    policy.allowQueryAuth ? ctx.url : null
  );
  const initDataResult: MiniAppInitDataAccessResult = verifyMiniAppInitDataAccess({
    ctx,
    allowQueryAuth: policy.allowQueryAuth,
    headerInitData: headerResult.headerInitData,
    sessionToken,
    nowMs,
  });
  if (!initDataResult.ok) {
    return initDataResult;
  }

  if (!policy.requireSession) {
    return { ok: true, session: null, inputSessionToken: sessionToken };
  }

  const sessionResult: MiniAppSessionAccessResult = verifyMiniAppSessionAccess({
    request: ctx.request,
    sessionToken,
    hasVerifiedAssetToken: initDataResult.hasVerifiedAssetToken,
    allowVerifiedAssetTokenBypass: policy.allowVerifiedAssetTokenBypass,
    nowMs,
  });
  if (!sessionResult.ok) {
    return sessionResult;
  }
  return {
    ok: true,
    session: sessionResult.session,
    inputSessionToken: sessionToken,
  };
}

/**
 * 在已有路由上下文上同步执行鉴权策略并在放行后执行终端处理器；若会话已滑动刷新则在响应后附加最新会话响应头。
 * @param ctx 路由请求上下文。
 * @param policy 路由静态声明的鉴权策略。
 * @param handler 终端路由处理器。
 * @returns 最终 HTTP `Response`。
 */
export async function runMiniAppAuthorized(
  ctx: Readonly<MiniAppRouteContext>,
  policy: Readonly<MiniAppAuthPolicy>,
  handler: MiniAppRouteHandler
): Promise<Response> {
  const auth: MiniAppAuthorizationResult = authorizeMiniAppRequest(ctx, policy);
  if (!auth.ok) {
    return auth.response;
  }
  const response: Response = await handler(ctx);
  if (
    auth.session !== null &&
    auth.session.token !== auth.inputSessionToken
  ) {
    return attachRefreshedSessionHeaders(response, auth.session);
  }
  return response;
}

/**
 * 将鉴权策略与路由处理器包装为可直接挂入 `Bun.serve({ routes })` 的单参请求处理函数；
 * 路径参数取自 `Bun.serve` 注入的 `request.params`（已解码，无参数路由为空对象）。
 * @param policy 路由静态声明的鉴权策略。
 * @param handler 终端路由处理器。
 * @returns 接受 `Request` 并返回 `Promise<Response>` 的函数。
 */
export function withMiniAppAuth(
  policy: Readonly<MiniAppAuthPolicy>,
  handler: MiniAppRouteHandler
): MiniAppBunRouteHandler {
  return (request: Request): Promise<Response> => {
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
    return runMiniAppAuthorized(ctx, policy, handler);
  };
}
