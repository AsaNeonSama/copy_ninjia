import type { ConfigUrlPolicy } from "../types/config";

/** AI 能力可选 base_url 的 URL 校验策略：允许 https 与回环地址明文 http，拒绝 userinfo 与 fragment。所属模块：config/agentCapability.ts。 */
export const AGENT_BASE_URL_POLICY: Readonly<ConfigUrlPolicy> = {
  allowedProtocols: ["https:"],
  allowLoopbackHttp: true,
  rejectUserInfo: true,
  rejectFragment: true,
};

/** 仅允许绝对 https URL 的配置字段校验策略（允许 userinfo 与 fragment）。所属模块：config/botInput.ts、config/assets.ts。 */
export const HTTPS_CONFIG_URL_POLICY: Readonly<ConfigUrlPolicy> = {
  allowedProtocols: ["https:"],
  allowLoopbackHttp: false,
  rejectUserInfo: false,
  rejectFragment: false,
};

/** 允许绝对 http 或 https URL 的配置字段校验策略（允许 userinfo 与 fragment）。所属模块：config/assets.ts、config/cronAction.ts。 */
export const HTTP_OR_HTTPS_CONFIG_URL_POLICY: Readonly<ConfigUrlPolicy> = {
  allowedProtocols: ["http:", "https:"],
  allowLoopbackHttp: false,
  rejectUserInfo: false,
  rejectFragment: false,
};
