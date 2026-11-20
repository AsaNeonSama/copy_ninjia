import { MINI_APP_MAX_CONFIG_BODY_BYTES } from "../../consts/miniAppCrypto";
import { logger } from "../../infra/logger";
import type {
  MiniAppConfigFileResponse,
  MiniAppConfigRestartResponse,
  MiniAppConfigSaveResponse,
} from "../../types/miniApp/configs";
import { readJsonObjectBody } from "../libs/request";
import { jsonResponse } from "../libs/response";
import {
  listMiniAppConfigFiles,
  readMiniAppConfigFile,
  restartMiniAppService,
  saveMiniAppConfigFile,
} from "../view/configs/storage";

/**
 * 处理 `GET /api/configs`：返回动态与静态部署配置文件白名单清单及各自的存在状态。
 * @returns JSON 响应（经会话临时密钥加密）。
 */
export async function handleGetConfigsRoute(): Promise<Response> {
  return jsonResponse(await listMiniAppConfigFiles());
}

/**
 * 处理 `GET /api/configs/file`：按白名单读取指定动态或静态部署配置文件的原始文本。
 * @param url 已解析的请求 URL（读取 `scope` 与 `fileName` 查询参数）。
 * @returns JSON 响应（经会话临时密钥加密）。
 */
export async function handleGetConfigFileRoute(url: URL): Promise<Response> {
  const result: Readonly<MiniAppConfigFileResponse> =
    await readMiniAppConfigFile(
      url.searchParams.get("scope"),
      url.searchParams.get("fileName")
    );
  return jsonResponse(result, result.ok ? 200 : 400);
}

/**
 * 处理 `POST /api/configs/save`：直接接收经会话 256-bit 临时密钥解密后的配置文本，通过严格 Schema 校验后原子落盘。
 * 审计日志仅记录白名单目标与状态码，绝不记录任何密钥或配置文件内容。
 * @param request HTTP 请求对象（请求体已由鉴权中间件解封会话加密信封）。
 * @returns JSON 响应（经会话临时密钥加密）。
 */
export async function handlePostConfigSaveRoute(
  request: Request
): Promise<Response> {
  const body: Record<string, unknown> | null = await readJsonObjectBody(
    request,
    MINI_APP_MAX_CONFIG_BODY_BYTES
  );
  const result: Readonly<MiniAppConfigSaveResponse> =
    await saveMiniAppConfigFile(body);
  logger.operation("[MiniApp] configs.save", {
    ...(result.scope !== undefined ? { scope: result.scope } : {}),
    ...(result.fileName !== undefined ? { fileName: result.fileName } : {}),
    ok: result.ok,
    ...(result.requiresRestart !== undefined
      ? { requiresRestart: result.requiresRestart }
      : {}),
    ...(result.code !== undefined ? { code: result.code } : {}),
  });
  return jsonResponse(result, result.ok ? 200 : 400);
}

/**
 * 处理 `POST /api/configs/restart`：触发宿主 systemd 重启 `copy-ninjia` 服务。
 * @returns JSON 响应（经会话临时密钥加密）。
 */
export async function handlePostConfigRestartRoute(): Promise<Response> {
  const result: Readonly<MiniAppConfigRestartResponse> =
    await restartMiniAppService();
  logger.operation("[MiniApp] configs.restart", {
    ok: result.ok,
    ...(result.code !== undefined ? { code: result.code } : {}),
  });
  return jsonResponse(result, result.ok ? 200 : 500);
}
