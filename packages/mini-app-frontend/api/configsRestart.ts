import type { MiniAppConfigRestartResponse } from "../types/miniAppConfigs";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `POST ./api/configs/restart` 通知服务端执行项目服务重启（`systemctl restart copy-ninjia`）。
 *
 * @returns 服务重启触发结果
 */
export function restartMiniAppService(): Promise<MiniAppConfigRestartResponse> {
  return miniAppFetchJson<MiniAppConfigRestartResponse>(
    "./api/configs/restart",
    { method: "POST" }
  );
}
