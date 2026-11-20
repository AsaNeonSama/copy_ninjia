import type {
  MiniAppConfigFileName,
  MiniAppConfigFileResponse,
  MiniAppConfigScope,
} from "../types/miniAppConfigs";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `GET ./api/configs/file` 读取指定目录分类（`dynamic` / `static`）下目标 JSON 配置文件的原始文本内容（查询串与响应体均由会话密钥端到端加密）。
 *
 * @param scope 配置目录分类（`"dynamic"` 或 `"static"`）
 * @param fileName 受管 JSON 配置文件名
 * @returns 配置文件读取响应
 */
export async function fetchMiniAppConfigFile(
  scope: MiniAppConfigScope,
  fileName: MiniAppConfigFileName
): Promise<MiniAppConfigFileResponse> {
  const params: URLSearchParams = new URLSearchParams({ scope, fileName });
  return miniAppFetchJson<MiniAppConfigFileResponse>(
    `./api/configs/file?${params.toString()}`
  );
}
