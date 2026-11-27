import { SUPER_ADMIN_USER_ID } from "../../config/bot";
import { logger } from "../../infra/logger";
import type {
  MiniAppTotpMutationResponse,
  MiniAppTotpSetupResponse,
} from "../../types/miniAppTotp";
import { revokeOtherMiniAppAuthSessions } from "../auth/session";
import {
  createPendingMiniAppTotpSetup,
  deleteMiniAppTotpRecord,
  enableMiniAppTotpFromPending,
  getMiniAppTotpStatus,
} from "../auth/totpStorage";
import { readJsonObjectBody } from "../libs/request";
import { jsonResponse } from "../libs/response";

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
  const setup: Readonly<MiniAppTotpSetupResponse> =
    createPendingMiniAppTotpSetup(SUPER_ADMIN_USER_ID);
  logger.operation("[MiniApp] totp.setup", { pendingSecretGenerated: true });
  return jsonResponse(setup);
}

/**
 * 处理 `POST /api/totp/enable`：校验前端提交的 6 位动态码，通过后激活或替换 `memory/mini-app-totp/totp.json` 中的唯一验证器记录，并按已提交会话的内部谱系标识保留调用者会话、吊销其余已登录会话。
 * @param request HTTP 请求对象。
 * @param sessionLineageId 鉴权提交阶段确认的调用者会话内部谱系标识。
 * @returns JSON 响应。
 */
export async function handlePostTotpEnableRoute(
  request: Request,
  sessionLineageId?: string
): Promise<Response> {
  const body: Record<string, unknown> | null = await readJsonObjectBody(
    request
  );
  const code: string = typeof body?.code === "string" ? body.code.trim() : "";
  const result: Readonly<MiniAppTotpMutationResponse> =
    await enableMiniAppTotpFromPending(code);
  if (result.ok) {
    revokeOtherMiniAppAuthSessions(sessionLineageId ?? "");
  }
  logger.operation("[MiniApp] totp.enable", { ok: result.ok });
  return jsonResponse(result, result.ok ? 200 : 400);
}

/**
 * 处理 `DELETE /api/totp` 或 `POST /api/totp/delete`：删除当前唯一的 Google Authenticator 验证器以恢复密码登录，并按已提交会话的内部谱系标识保留调用者会话、吊销其余已登录会话。
 * @param sessionLineageId 鉴权提交阶段确认的调用者会话内部谱系标识。
 * @returns JSON 响应。
 */
export async function handleDeleteTotpRoute(
  sessionLineageId?: string
): Promise<Response> {
  const result: Readonly<MiniAppTotpMutationResponse> =
    await deleteMiniAppTotpRecord();
  if (result.ok) {
    revokeOtherMiniAppAuthSessions(sessionLineageId ?? "");
  }
  logger.operation("[MiniApp] totp.delete", {
    ok: result.ok,
    deleted: result.ok && !result.status.enabled,
  });
  return jsonResponse(result);
}
