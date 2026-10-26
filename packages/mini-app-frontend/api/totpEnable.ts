import type { MiniAppTotpMutationResponse } from "../types/miniAppTotp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `POST ./api/totp/enable` 提交 6 位 Google Authenticator 动态码以激活或修改唯一验证器。
 * @param code 6 位十进制验证码
 * @returns 绑定或修改结果
 */
export async function enableMiniAppTotp(code: string): Promise<MiniAppTotpMutationResponse> {
  return miniAppFetchJson<MiniAppTotpMutationResponse>("./api/totp/enable", {
    method: "POST", body: JSON.stringify({ code }),
  });
}
