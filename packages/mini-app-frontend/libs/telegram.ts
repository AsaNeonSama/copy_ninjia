import type { TelegramWebApp, TelegramWindow } from "../types/miniApp";

/**
 * 读取浏览器全局注入的 `Telegram.WebApp` 实例。
 * @returns `TelegramWebApp` 对象；非 Telegram WebView 环境返回 `undefined`
 */
export function getTelegramWebApp(): Readonly<TelegramWebApp> | undefined {
  const tgWindow: TelegramWindow = globalThis;
  return tgWindow.Telegram?.WebApp;
}

/**
 * 提取当前会话的 Telegram WebApp `initData` 原始签名串。
 * @returns `initData` 字符串；未注入时返回空字符串
 */
export function readMiniAppInitData(): string {
  const webApp: Readonly<TelegramWebApp> | undefined = getTelegramWebApp();
  if (webApp?.initData !== undefined && webApp.initData.length > 0) return webApp.initData;
  const tgWindow: TelegramWindow = globalThis;
  if (tgWindow.location === undefined) return "";
  const queryParams: URLSearchParams = new URLSearchParams(tgWindow.location.search);
  const fromQuery: string | null = queryParams.get("tgWebAppData");
  if (fromQuery !== null && fromQuery.length > 0) return fromQuery;
  const hashRaw: string = tgWindow.location.hash.startsWith("#")
    ? tgWindow.location.hash.slice(1)
    : tgWindow.location.hash;
  return new URLSearchParams(hashRaw).get("tgWebAppData") ?? "";
}

/**
 * 判断 Mini App 当前是否处于前台：页面未隐藏，且 Telegram 宿主未将其最小化（Bot API 8.0+ 的 `isActive`）。
 * 宿主或浏览器不提供对应字段时按前台处理。
 * @returns 处于前台时返回 `true`
 */
export function isMiniAppForeground(): boolean {
  const tgWindow: TelegramWindow = globalThis;
  if (tgWindow.document?.visibilityState === "hidden") return false;
  return getTelegramWebApp()?.isActive !== false;
}

/**
 * 订阅可能改变前台状态的页面 `visibilitychange` 与 Telegram `activated` / `deactivated` 事件。
 * @param listener 事件回调；回调内用 `isMiniAppForeground` 读取当前状态
 * @returns 注销全部订阅的函数
 */
export function subscribeMiniAppForeground(listener: () => void): () => void {
  const tgWindow: TelegramWindow = globalThis;
  const webApp: Readonly<TelegramWebApp> | undefined = getTelegramWebApp();
  tgWindow.document?.addEventListener?.("visibilitychange", listener);
  webApp?.onEvent?.("activated", listener);
  webApp?.onEvent?.("deactivated", listener);
  return (): void => {
    tgWindow.document?.removeEventListener?.("visibilitychange", listener);
    webApp?.offEvent?.("activated", listener);
    webApp?.offEvent?.("deactivated", listener);
  };
}
