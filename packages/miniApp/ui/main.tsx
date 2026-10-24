import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { App } from "./App";
import { getTelegramWebApp } from "./api";
import type { TelegramWebApp, TelegramWindow } from "../../types/miniApp";

/**
 * 初始化 Telegram WebApp 宿主并将 React 应用挂载到 `#root`。
 */
function mountMiniApp(): void {
  const webApp: Readonly<TelegramWebApp> | undefined = getTelegramWebApp();
  webApp?.ready?.();
  webApp?.expand?.();
  const tgWindow: TelegramWindow = globalThis;
  const container: Element | null = tgWindow.document?.getElementById("root") ?? null;
  if (container === null) {
    throw new Error("Mini App root element #root not found.");
  }
  const root: Root = createRoot(container);
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

mountMiniApp();
