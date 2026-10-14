/** owner: main。config/dynamic/ 热重载运行时状态（packages/app/configReload.ts）。 */

import type { FSWatcher } from "node:fs";
import type { LatestValueRunner } from "../../libs/latestValueRunner";

/**
 * 热重载监听器与单飞执行器状态：startConfigReload 填充 watcher 与 runner 并开启 accepting；文件变更事件重设 debounceTimer（到期清空），目录改名或暂缺时按 CONFIG_RELOAD_REWATCH_RETRY_DELAYS_MS 调度 rewatchTimer 并递增 rewatchAttempts（重建成功或关闸时归零）；quiesceConfigReload 关闭 accepting、关闭 watcher 并清除定时器。
 * 单例固定字段，不淘汰；进程重启后从初始值开始。
 */
export const configReloadRuntime: {
  watcher: FSWatcher | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  rewatchTimer: ReturnType<typeof setTimeout> | null;
  rewatchAttempts: number;
  accepting: boolean;
  runner: LatestValueRunner<null> | null;
} = {
  watcher: null,
  debounceTimer: null,
  rewatchTimer: null,
  rewatchAttempts: 0,
  accepting: false,
  runner: null,
};
