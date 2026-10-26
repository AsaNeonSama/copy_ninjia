import { SUPER_ADMIN_USER_ID } from "../../config/bot";
import type { MiniAppTotpMutationResponse } from "../../types/miniAppTotp";
import {
  createPendingMiniAppTotpSetup,
  deleteMiniAppTotpRecord,
  enableMiniAppTotpFromPending,
  getMiniAppTotpStatus,
} from "../totpStorage";
import { jsonResponse, readJsonObjectBody } from "./common";

/**
 * 处理 `GET /api/totp`：返回当前 Google Authenticator 验证器的启用状态与脱敏摘要。
 * @returns JSON 响应。
 */
export async function handleGetTotpRoute(): Promise<Response> {
  return jsonResponse(await getMiniAppTotpStatus());
}

/**
 * 处理 `POST /api/totp/setup`：在前端控制台生成新的待确认 Base32 密钥、`otpauth://` URI 与内联二维码 SVG。
 * @returns JSON 响应。
 */
export function handlePostTotpSetupRoute(): Response {
  return jsonResponse(createPendingMiniAppTotpSetup(SUPER_ADMIN_USER_ID));
}

/**
 * 处理 `POST /api/totp/enable`：校验前端提交的 6 位动态码，通过后激活或替换 `memory/mini-app-totp/totp.json` 中的唯一验证器记录。
 * @param request HTTP 请求对象。
 * @returns JSON 响应。
 */
export async function handlePostTotpEnableRoute(
  request: Request
): Promise<Response> {
  const body: Record<string, unknown> | null = await readJsonObjectBody(
    request
  );
  const code: string = typeof body?.code === "string" ? body.code.trim() : "";
  const result: Readonly<MiniAppTotpMutationResponse> =
    await enableMiniAppTotpFromPending(code);
  return jsonResponse(result, result.ok ? 200 : 400);
}

/**
 * 处理 `DELETE /api/totp` 或 `POST /api/totp/delete`：删除当前唯一的 Google Authenticator 验证器并恢复密码登录。
 * @returns JSON 响应。
 */
export async function handleDeleteTotpRoute(): Promise<Response> {
  return jsonResponse(await deleteMiniAppTotpRecord());
}

/**
 * 兜底匹配并处理 `/api/totp` 及其子路径路由。
 * @param method 大写 HTTP 方法。
 * @param routePath 归一化后的内部路由路径。
 * @param request HTTP 请求对象。
 * @returns 命中时返回 `Response`，未命中时返回 `null`。
 */
export async function handleTotpApiRoute(
  method: string,
  routePath: string,
  request: Request
): Promise<Response | null> {
  if (method === "GET" && routePath === "/api/totp") {
    return handleGetTotpRoute();
  }
  if (method === "POST" && routePath === "/api/totp/setup") {
    return handlePostTotpSetupRoute();
  }
  if (method === "POST" && routePath === "/api/totp/enable") {
    return handlePostTotpEnableRoute(request);
  }
  if (
    (method === "DELETE" && routePath === "/api/totp") ||
    (method === "POST" && routePath === "/api/totp/delete")
  ) {
    return handleDeleteTotpRoute();
  }
  return null;
}
