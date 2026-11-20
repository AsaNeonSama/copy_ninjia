import type { MiniAppAccessDiagnostics } from "../types/miniApp/auth";
import type { TelegramWindow } from "../types/miniApp/host";
import { formatUtcTimestamp } from "./formatters";

/**
 * 构造网络异常或缺少服务端诊断时的兜底访问诊断对象（`403 ACCESS_DENIED`，Host 取当前页面地址）。
 *
 * @param errorText 错误说明文本
 * @returns 兜底访问诊断对象
 */
export function buildFallbackDiagnostics(
  errorText: string
): Readonly<MiniAppAccessDiagnostics> {
  const tgWindow: TelegramWindow = globalThis;
  const rawHost: string | undefined = tgWindow.location?.host;
  const host: string =
    rawHost !== undefined && rawHost.length > 0 ? rawHost : "localhost";
  return {
    requestId: "0000000000000000",
    timestamp: formatUtcTimestamp(),
    clientIp: "127.0.0.1",
    host,
    path: "/api/auth/precheck",
    status: 403,
    code: "ACCESS_DENIED",
    error: errorText,
  };
}
