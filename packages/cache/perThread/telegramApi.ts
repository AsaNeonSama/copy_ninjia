/** owner: perThread。当前线程安装的 Telegram API 适配器单例（packages/infra/telegram/client.ts）。 */

import type { InstalledTelegramApi } from "../../types/telegramWorker";

/** 当前线程的 Telegram API 句柄（主线程安装真实客户端适配器，AI 与 Anti-Raid Worker 安装双工代理）：线程启动初始化时填充，停止或退出时随 isolate 释放；单例对象，不淘汰，线程重建后从 null 重新安装。 */
export const telegramApiState: { current: InstalledTelegramApi | null } = {
  current: null,
};
