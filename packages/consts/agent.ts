import type { AgentProvider } from "../types/config";
import { exhaustiveList } from "./exhaustiveList";

/**
 * `config/dynamic/agent.json` 的 `agent` 段允许出现的全部能力名，顺序与
 * `config_example/dynamic/agent.json` 一致。
 *
 * 这份名单是唯一权威源：`packages/config/agent.ts` 的 `hasOnlyKeys` 校验用它
 * 决定「未知字段一律拒绝」，install.sh 的安装问卷按同一份名单逐项询问，
 * 由 `test/scripts/installScript.test.ts` 与本常量对拍。新增能力必须改这里，
 * 并同步能力档解析、示例文件与三语文档。
 *
 * 所属模块：AI 能力部署配置。
 */
export const AGENT_CAPABILITY_NAMES: readonly string[] = [
  "ad_detect",
  "text",
  "summary",
  "media",
  "image",
  "tts",
  "web_search",
];

/**
 * AI 闲聊可用的必备能力：三项齐备才算对话核心成立，缺任意一项
 * `/ai_chat enable` 会被拒绝（见 packages/aiChat/availability.ts）。
 *
 * 必须是 AGENT_CAPABILITY_NAMES 的子集；install.sh 用同一份名单判断问卷
 * 是否问全了必填项。所属模块：AI 能力部署配置。
 */
export const AGENT_AI_CHAT_REQUIRED_CAPABILITIES: readonly string[] = [
  "text",
  "summary",
  "media",
];

/**
 * agent 段 provider 的完整闭集；部署配置解析（config/agentCapability.ts）与 AI 用量文件解码
 * （workers/diskIO/aiCacheDocument.ts）共用。新增 provider 时同步 AgentProvider、
 * AGENT_PROVIDER_LABELS 与 aiChat/provider.ts 的实现包映射。所属模块：AI 能力部署配置。
 */
export const AGENT_PROVIDERS: readonly AgentProvider[] = exhaustiveList<AgentProvider>()(["google", "openai", "anthropic"]);

/**
 * 判断字符串是否属于 AGENT_PROVIDERS；调用方先完成首尾空白规范化。所属模块：AI 能力部署配置。
 * @param value 待判断的规范化字符串。
 * @returns 属于合法 AI 供应商标识时返回 true，否则返回 false。
 */
export function isAgentProvider(value: string): value is AgentProvider {
  return (AGENT_PROVIDERS as readonly string[]).includes(value);
}

/** 各 provider 在错误文案里的名称（SDK 客户端未按能力配置时）。所属模块：aiChat/capabilityClient.ts。 */
export const AGENT_PROVIDER_LABELS: Readonly<Record<AgentProvider, string>> = {
  google: "Google",
  openai: "OpenAI",
  anthropic: "Anthropic",
};

/** Agent 部署示例实际使用的占位凭据；严格解析只拒绝这些已知无效值。 */
export const AGENT_API_KEY_PLACEHOLDERS: readonly string[] = [
  "replace-with-anthropic-api-key",
  "replace-with-deepseek-api-key",
  "replace-with-google-api-key",
  "replace-with-openai-api-key",
  "replace-with-xai-api-key",
];

/** Agent 配置允许使用明文 HTTP 的回环主机闭集。 */
export const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/** Agent base_url 严格校验的期望形态，不含用户配置值。 */
export const EXPECTED_BASE_URL: string =
  "an absolute https URL without credentials or a fragment " +
  "(plain http is allowed only for localhost, 127.0.0.1, and ::1)";

/** web_search 缺省的每轮函数调用上限；由配置解析补齐，与 text 内建搜索预算独立。所属模块：AI 能力部署配置。 */
export const WEB_SEARCH_DEFAULT_MAX_CALLS_PER_USE: number = 5;

/** anthropic provider 能力的 fallback_model 严格校验的期望形态，不含用户配置值。所属模块：AI 能力部署配置。 */
export const EXPECTED_AGENT_FALLBACK_MODEL: string = "a non-empty string different from model";
