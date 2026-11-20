import type {
  MiniAppConfigFileName,
  MiniAppConfigSaveRequest,
  MiniAppConfigSaveResponse,
  MiniAppConfigScope,
} from "../types/miniAppConfigs";
import { miniAppFetchJson } from "./request";

/**
 * 将待保存的 JSON 配置文本通过当前会话 256 位临时密钥加密提交至 `POST ./api/configs/save` 校验并原子落盘。
 *
 * @param scope 配置目录分类（`"dynamic"` 或 `"static"`）
 * @param fileName 受管 JSON 配置文件名
 * @param content 待保存的 JSON 配置明文文本
 * @returns 配置保存结果
 */
export async function saveMiniAppConfigFile(
  scope: MiniAppConfigScope,
  fileName: MiniAppConfigFileName,
  content: string
): Promise<MiniAppConfigSaveResponse> {
  const requestPayload: MiniAppConfigSaveRequest = {
    scope,
    fileName,
    content,
  };
  return miniAppFetchJson<MiniAppConfigSaveResponse>("./api/configs/save", {
    method: "POST",
    body: JSON.stringify(requestPayload),
  });
}
