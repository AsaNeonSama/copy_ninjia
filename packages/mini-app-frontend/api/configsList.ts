import type { MiniAppConfigListResponse } from "../types/miniAppConfigs";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `GET ./api/configs` 拉取受管的动态与静态 JSON 配置文件白名单及磁盘存在状态（响应由会话密钥端到端加密）。
 *
 * @returns 动态与静态配置文件清单响应
 */
export function fetchMiniAppConfigList(): Promise<MiniAppConfigListResponse> {
  return miniAppFetchJson<MiniAppConfigListResponse>("./api/configs");
}
