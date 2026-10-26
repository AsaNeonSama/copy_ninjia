import { BOT_TOKEN, SUPER_ADMIN_USER_ID } from "../../config/bot";
import {
  verifyMiniAppAssetToken,
  verifyMiniAppInitData,
} from "../../libs/miniAppAuth";
import type {
  MiniAppAuthResult,
  MiniAppMiddleware,
  MiniAppRouteContext,
} from "../../types/miniApp";
import { checkSuperAdminPasswordLockout } from "../auth/session";
import { extractAssetTokenFromQuery, extractInitDataFromHeaders } from "../libs/request";
import { accessErrorResponse } from "../libs/response";

/**
 * 校验请求携带的 Telegram WebApp `initData` 签名（或受保护静态/图库资源稳定令牌 `token`）、时效、超级管理员身份与 30 分钟密码锁定状态。
 * @param request HTTP 请求对象。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中从查询参数提取 `token` 或 `initData`。
 * @returns 验证通过时返回 `null`，失败时返回带真实请求诊断的 `401` 或 `403` `Response`。
 */
function verifyInitDataRequest(request: Request, allowQueryAuth: boolean): Response | null {
  if (allowQueryAuth) {
    const assetToken: string = extractAssetTokenFromQuery(request);
    if (
      assetToken.length > 0 &&
      verifyMiniAppAssetToken(assetToken, BOT_TOKEN, SUPER_ADMIN_USER_ID)
    ) {
      return checkSuperAdminPasswordLockout(request);
    }
  }
  const initData: string = extractInitDataFromHeaders(request, allowQueryAuth);
  const authResult: MiniAppAuthResult = verifyMiniAppInitData({
    initData,
    botToken: BOT_TOKEN,
    superAdminUserId: SUPER_ADMIN_USER_ID,
  });
  if (authResult.ok) {
    return checkSuperAdminPasswordLockout(request);
  }
  const status: number = authResult.reason === "forbidden_user" ? 403 : 401;
  return accessErrorResponse(request, {
    status,
    code: authResult.reason.toUpperCase(),
    reason: authResult.reason,
    error:
      authResult.reason === "forbidden_user"
        ? "Only the configured SuperAdmin user ID is permitted to access this Mini App."
        : `Telegram WebApp initData verification failed (${authResult.reason}). Direct external browser access is denied.`,
  });
}

/**
 * 创建校验 Telegram WebApp `initData` HMAC-SHA256 签名、时效、`SUPER_ADMIN_USER_ID` 超管身份及 30 分钟密码锁定状态的中间件（第一层网关校验）。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中从 `token` 或 `initData` 查询参数提取凭据（供受保护图片、SVG 资源与附件下载）。
 * @returns 构造好的 `MiniAppMiddleware`。
 */
export function createMiniAppInitDataMiddleware(allowQueryAuth: boolean): MiniAppMiddleware {
  return (
    ctx: Readonly<MiniAppRouteContext>,
    next: () => Response | Promise<Response>
  ): Response | Promise<Response> =>
    verifyInitDataRequest(ctx.request, allowQueryAuth) ?? next();
}
