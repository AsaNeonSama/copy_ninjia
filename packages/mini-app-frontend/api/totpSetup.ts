import type { MiniAppTotpSetupResponse } from "../types/miniAppTotp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `POST ./api/totp/setup` 在前端控制台生成新的待确认 TOTP 密钥、标准 `otpauth://` URI 与内联二维码 SVG。
 * @returns 待绑定密钥与二维码响应
 */
export async function setupMiniAppTotp(): Promise<MiniAppTotpSetupResponse> {
  return miniAppFetchJson<MiniAppTotpSetupResponse>("./api/totp/setup", { method: "POST" });
}
