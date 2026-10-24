/** 可选的运行时数据根目录环境变量名；根下放 bot.lock、logs/、memory/ 与 database/，未设置时使用项目根目录。 */
export const RUNTIME_DATA_ROOT_ENV: string = "COPY_NINJIA_DATA_ROOT";

/** 可选的部署配置目录环境变量名；未设置时使用项目根目录下的 config/（其下分 static/ 与 dynamic/）。 */
export const CONFIG_ROOT_ENV: string = "COPY_NINJIA_CONFIG_ROOT";

/**
 * AI SDK 会并入每个请求头、且构造参数关不掉的环境变量名（可追加或覆盖同名头，包括 Authorization）。
 * 进程环境里出现任一（含空串）即在 consts/paths.ts 加载时拒绝启动。
 */
export const SDK_REQUEST_HEADER_ENVS: readonly string[] = [
  "ANTHROPIC_CUSTOM_HEADERS",
  "OPENAI_CUSTOM_HEADERS",
];

/** 性能子进程启用 JSC GC 暂停日志的环境变量名。 */
export const JSC_GC_LOG_ENV: string = "BUN_JSC_logGC";

/**
 * Bun 调试器接入使用的环境变量名；接入调试器的 bun 进程多出调试线程及其独立的 JSC 堆。
 * 性能脚本子进程的环境不含这些变量，由 `scripts/perf/childEnvironment.ts` 的 `perfChildEnvironment` 去掉。
 */
export const BUN_INSPECTOR_ENVS: readonly string[] = [
  "BUN_INSPECT",
  "BUN_INSPECT_CONNECT_TO",
  "BUN_INSPECT_NOTIFY",
  "BUN_INSPECT_PRELOAD",
];
