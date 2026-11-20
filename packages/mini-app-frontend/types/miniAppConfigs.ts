/**
 * Mini App 会话端到端加密信封与动态/静态 JSON 配置文件管理契约类型。
 * 与服务端 `packages/types/miniApp/configs.ts` 同名的声明保持编译期恒等（由 `test/mini-app-frontend/frontendParity.test.ts` 核对）。
 */

/** AES-256-GCM 加密后的二进制密文对（12 字节随机 IV 与含 128 位认证标签的密文均为标准 Base64 编码）。 */
export interface MiniAppEncryptedPayload {
  readonly iv: string;
  readonly payload: string;
}

/** Mini App 已认证 JSON 请求体与响应体的统一 AES-256-GCM 传输信封。 */
export interface MiniAppEncryptedEnvelope {
  readonly encrypted: true;
  readonly iv: string;
  readonly payload: string;
}

/** Mini App 配置文件管理所属目录分类（`"dynamic"` 热重载配置，`"static"` 需重启生效的静态配置）。 */
export type MiniAppConfigScope = "dynamic" | "static";

/** `config/dynamic/` 下允许在 Mini App 控制台查看与编辑的动态 JSON 配置文件名闭集。 */
export type MiniAppDynamicConfigFileName =
  | "ad_detect.json"
  | "agent.json"
  | "assets.json"
  | "cron.json"
  | "mood.json"
  | "stickers.json";

/** `config/static/` 下允许在 Mini App 控制台查看与编辑的静态 JSON 配置文件名闭集。 */
export type MiniAppStaticConfigFileName = "bot.json" | "g-auth.json";

/** Mini App 控制台允许查看与编辑的全部 JSON 配置文件名联合类型。 */
export type MiniAppConfigFileName =
  | MiniAppDynamicConfigFileName
  | MiniAppStaticConfigFileName;

/** 单个受管 JSON 配置文件的存在性摘要条目。 */
export interface MiniAppConfigFileItem {
  readonly scope: MiniAppConfigScope;
  readonly fileName: MiniAppConfigFileName;
  readonly exists: boolean;
}

/** `GET /api/configs` 返回的动态与静态配置文件清单响应。 */
export interface MiniAppConfigListResponse {
  readonly ok: true;
  readonly dynamicFiles: readonly Readonly<MiniAppConfigFileItem>[];
  readonly staticFiles: readonly Readonly<MiniAppConfigFileItem>[];
}

/** `GET /api/configs/file` 返回的单个 JSON 配置文件原始内容或校验错误响应。 */
export interface MiniAppConfigFileResponse {
  readonly ok: boolean;
  readonly scope?: MiniAppConfigScope;
  readonly fileName?: MiniAppConfigFileName;
  readonly exists?: boolean;
  readonly content?: string;
  readonly code?: string;
  readonly error?: string;
}

/** `POST /api/configs/save` 提交保存单份 JSON 配置文件的请求载荷（经会话 256 位临时密钥加密传输）。 */
export interface MiniAppConfigSaveRequest {
  readonly scope: MiniAppConfigScope;
  readonly fileName: string;
  readonly content: string;
}

/** `POST /api/configs/save` 校验并原子落盘 JSON 配置文件后的响应结果。 */
export interface MiniAppConfigSaveResponse {
  readonly ok: boolean;
  readonly scope?: MiniAppConfigScope;
  readonly fileName?: MiniAppConfigFileName;
  readonly requiresRestart?: boolean;
  readonly code?: string;
  readonly error?: string;
}

/** `POST /api/configs/restart` 触发服务重启指令（`systemctl restart copy-ninjia`）的响应结果。 */
export interface MiniAppConfigRestartResponse {
  readonly ok: boolean;
  readonly code?: string;
  readonly error?: string;
}
