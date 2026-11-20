import type {
  MiniAppDynamicConfigFileName,
  MiniAppStaticConfigFileName,
} from "../types/miniApp/configs";
import { exhaustiveList } from "./exhaustiveList";

/**
 * `config/dynamic/` 下允许通过 Mini App 查看与编辑的热重载配置文件名闭集。
 * 不变量：与 `MiniAppDynamicConfigFileName` 及 `packages/config/layout.ts` 动态目录白名单严格一致。
 * 所属模块：`packages/mini-app-api-server/view/configs/validate.ts` 与 `packages/mini-app-api-server/view/configs/storage.ts`。
 */
export const MINI_APP_DYNAMIC_CONFIG_FILES: readonly MiniAppDynamicConfigFileName[] =
  exhaustiveList<MiniAppDynamicConfigFileName>()([
    "ad_detect.json",
    "agent.json",
    "assets.json",
    "cron.json",
    "mood.json",
    "stickers.json",
  ]);

/**
 * `config/static/` 下允许通过 Mini App 查看与编辑的静态配置文件名闭集（保存后需重启生效）。
 * 不变量：与 `MiniAppStaticConfigFileName` 及 `packages/config/layout.ts` 静态目录白名单严格一致。
 * 所属模块：`packages/mini-app-api-server/view/configs/validate.ts` 与 `packages/mini-app-api-server/view/configs/storage.ts`。
 */
export const MINI_APP_STATIC_CONFIG_FILES: readonly MiniAppStaticConfigFileName[] =
  exhaustiveList<MiniAppStaticConfigFileName>()([
    "bot.json",
    "g-auth.json",
  ]);

/**
 * Mini App 配置编辑器单份配置文件允许保存的最大 UTF-8 明文字节数（2 MiB）。
 * 不变量：正整数上界，超出该字节数的配置文本直接拒绝。
 * 所属模块：`packages/mini-app-api-server/view/configs/validate.ts`。
 */
export const MINI_APP_MAX_CONFIG_CONTENT_BYTES: number = 2 * 1_024 * 1_024;

/**
 * Mini App 首次创建尚不存在的可选部署配置文件时使用的默认权限位（仅属主可读写 `0o600`；文件已存在时沿用原权限）。
 * 不变量：不开放 group/other 读写位。所属模块：`packages/mini-app-api-server/view/configs/storage.ts`。
 */
export const MINI_APP_CONFIG_DEFAULT_FILE_MODE: number = 0o600;

/**
 * Mini App 静态配置页触发宿主 systemd 重启 `copy-ninjia` 服务的固定命令参数表（`--no-block` 向 PID 1 入队重启任务后立即返回）。
 * 不变量：固定只读参数表，绝不拼接外部输入。所属模块：`packages/mini-app-api-server/view/configs/storage.ts`。
 */
export const MINI_APP_SERVICE_RESTART_COMMAND: readonly string[] = [
  "systemctl",
  "restart",
  "--no-block",
  "copy-ninjia",
];

/**
 * Mini App 执行 `systemctl restart --no-block copy-ninjia` 子进程的最大等待超时毫秒数（5 秒）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-api-server/view/configs/storage.ts`。
 */
export const MINI_APP_SERVICE_RESTART_TIMEOUT_MS: number = 5_000;

/**
 * Mini App 执行宿主服务重启子进程时读取标准错误摘要的最大字节数（1 KiB）。
 * 不变量：正整数字节上界，超出部分按有界读取规则丢弃。所属模块：`packages/mini-app-api-server/view/configs/storage.ts`。
 */
export const MINI_APP_SERVICE_RESTART_STDERR_MAX_BYTES: number = 1_024;
