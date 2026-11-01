import {
  miniAppActiveConfigHolder,
  miniAppAuthSessions,
  miniAppPasswordGuardHolder,
  miniAppServerHolder,
} from "../../cache/main/miniApp";
import { getBotMiniAppConfig } from "../../config/bot";
import { MINI_APP_MAX_UPLOAD_BODY_BYTES } from "../../consts/miniApp";
import { logger } from "../../infra/logger";
import type { BotMiniAppConfig } from "../../types/config";
import { resetMiniAppTotpMemoryCache } from "../auth/totpStorage";
import { jsonResponse } from "../libs/response";
import { resetMiniAppPickerState } from "../picker/sessions";
import { createMiniAppBunRoutes, handleMiniAppHttpRequest } from "./register";

/**
 * 使用 `Bun.serve` 原生路由与 HTTP 服务启动本地 Mini App 源站（供 Cloudflare Tunnel 反向代理接入）；未配置 `mini_app` 时跳过并返回 `null`。
 * @param overrideConfig 可选的覆盖配置（供集成测试或本地调试传入指定端口）。
 * @returns 已启动的 `Bun.serve` 实例，或未启用时返回 `null`。
 */
export function startMiniAppServer(
  overrideConfig?: Readonly<BotMiniAppConfig>
): ReturnType<typeof Bun.serve> | null {
  if (miniAppServerHolder.current !== null) {
    return miniAppServerHolder.current;
  }
  const config: Readonly<BotMiniAppConfig> | undefined =
    overrideConfig ?? getBotMiniAppConfig();
  if (config === undefined) return null;

  miniAppActiveConfigHolder.current = config;
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: config.host,
    port: config.port,
    development: false,
    maxRequestBodySize: MINI_APP_MAX_UPLOAD_BODY_BYTES,
    routes: createMiniAppBunRoutes(),
    fetch: handleMiniAppHttpRequest,
    error(error: Bun.ErrorLike): Response {
      logger.error("Mini App HTTP server failed to handle request:", error);
      return jsonResponse({ error: "Internal server error" }, 500);
    },
  });
  miniAppServerHolder.current = server;
  logger.log(
    `Mini App HTTP server listening on http://${config.host}:${server.port} (public URL: ${config.url}).`
  );
  return server;
}

/**
 * 停止 Mini App `Bun.serve` 源站服务并清理会话与预备选择器缓存。
 */
export async function stopMiniAppServer(): Promise<void> {
  const server: ReturnType<typeof Bun.serve> | null = miniAppServerHolder.current;
  miniAppServerHolder.current = null;
  miniAppActiveConfigHolder.current = null;
  miniAppAuthSessions.clear();
  miniAppPasswordGuardHolder.current = null;
  resetMiniAppPickerState();
  resetMiniAppTotpMemoryCache();
  if (server !== null) {
    await server.stop(true);
  }
}
