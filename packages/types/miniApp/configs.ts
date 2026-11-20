/** AES-256-GCM 加密载荷片段（Base64 编码的 12 字节 IV 与含 16 字节认证标签的密文）。 */
export interface MiniAppEncryptedPayload {
  readonly iv: string;
  readonly payload: string;
}

/** Mini App 已认证业务请求与响应体统一使用的 AES-256-GCM 传输信封。 */
export interface MiniAppEncryptedEnvelope {
  readonly encrypted: true;
  readonly iv: string;
  readonly payload: string;
}

/** Mini App 配置编辑器支持的部署配置目录作用域（动态热重载配置 vs 静态重启配置）。 */
export type MiniAppConfigScope = "dynamic" | "static";

/** `config/dynamic/` 下允许在 Mini App 配置编辑器中查看与保存的部署配置文件名闭集。 */
export type MiniAppDynamicConfigFileName =
  | "ad_detect.json"
  | "agent.json"
  | "assets.json"
  | "cron.json"
  | "mood.json"
  | "stickers.json";

/** `config/static/` 下允许在 Mini App 配置编辑器中查看与保存的部署配置文件名闭集。 */
export type MiniAppStaticConfigFileName = "bot.json" | "g-auth.json";

/** Mini App 配置编辑器允许访问的全部部署配置文件名联合类型。 */
export type MiniAppConfigFileName =
  | MiniAppDynamicConfigFileName
  | MiniAppStaticConfigFileName;

/** 单个可编辑部署配置文件的列表摘要项。 */
export interface MiniAppConfigFileItem {
  readonly scope: MiniAppConfigScope;
  readonly fileName: MiniAppConfigFileName;
  readonly exists: boolean;
}

/** `GET /api/configs` 返回的动态与静态配置文件清单。 */
export interface MiniAppConfigListResponse {
  readonly ok: true;
  readonly dynamicFiles: readonly Readonly<MiniAppConfigFileItem>[];
  readonly staticFiles: readonly Readonly<MiniAppConfigFileItem>[];
}

/** `GET /api/configs/file` 返回的单份配置文件内容或校验错误响应。 */
export interface MiniAppConfigFileResponse {
  readonly ok: boolean;
  readonly scope?: MiniAppConfigScope;
  readonly fileName?: MiniAppConfigFileName;
  readonly exists?: boolean;
  readonly content?: string;
  readonly code?: string;
  readonly error?: string;
}

/** `POST /api/configs/save` 提交保存单份配置文件的请求体（经会话 256-bit 临时密钥加密传输）。 */
export interface MiniAppConfigSaveRequest {
  readonly scope: MiniAppConfigScope;
  readonly fileName: string;
  readonly content: string;
}

/** `POST /api/configs/save` 保存单份配置文件的结果响应。 */
export interface MiniAppConfigSaveResponse {
  readonly ok: boolean;
  readonly scope?: MiniAppConfigScope;
  readonly fileName?: MiniAppConfigFileName;
  readonly requiresRestart?: boolean;
  readonly code?: string;
  readonly error?: string;
}

/** `POST /api/configs/restart` 触发重启宿主 systemd 服务的结果响应。 */
export interface MiniAppConfigRestartResponse {
  readonly ok: boolean;
  readonly code?: string;
  readonly error?: string;
}

/** 宿主 systemd 服务重启执行器的返回结果。 */
export type MiniAppServiceRestartResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/** 可注入的宿主 systemd 服务重启执行器签名（生产默认执行 `systemctl restart --no-block copy-ninjia`，测试注入替身）。 */
export type MiniAppServiceRestartRunner =
  () => Promise<Readonly<MiniAppServiceRestartResult>>;
