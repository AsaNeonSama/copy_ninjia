import {
  AGENT_AI_CHAT_REQUIRED_CAPABILITIES,
  AGENT_CAPABILITY_NAMES,
} from "../consts/agent";
import {
  adDetectAgentConfigCache,
  agentDeploymentConfigCache,
} from "../cache/perThread/config";
import { AGENT_CONFIG_PATH } from "../consts/paths";
import { invalidInput, readJsonInput } from "../libs/inputValidation";
import { hasExactKeys, hasOnlyKeys, isPlainRecord } from "../libs/record";
import { parseCapability, parseImageCapability, parseTtsCapability, parseWebSearchCapability } from "./agentCapability";
import type {
  AdDetectAgentConfig,
  AgentCapability,
  AgentCapabilityConfig,
  AgentConfigSnapshots,
  AgentDeploymentCapabilityConfig,
  AgentDeploymentConfig,
  AgentGeneralCapability,
  AgentImageCapabilityConfig,
  AgentTtsCapabilityConfig,
  AgentWebSearchCapabilityConfig,
} from "../types/config";

/**
 * config/dynamic/agent.json：AI 能力的统一部署配置解析与快照管理（字段形态见 config/agentCapability.ts，跨线程约束见 docs/cn/04-invariants.md）。
 *
 * 顶层只含 agent，其下按能力分组：text、summary、media 为对话核心能力，ad_detect、image、tts、web_search 可选。
 * 读盘只发生在主线程（parse* / load* / validateAgentDeploymentConfig）；*Snapshot / get* / adopt* 只读写当前线程 holder，不读盘。
 */

/** 解码广告检测能力；base_url 缺省时跟随所选 SDK 的官方端点。 */
export function parseAdDetectAgentConfig(
  value: unknown,
  sourcePath: string = AGENT_CONFIG_PATH
): AdDetectAgentConfig {
  return parseCapability(value, "$.agent.ad_detect", sourcePath);
}

/** 严格解码 agent 段；对话必备能力不能缺，其余能力可显式缺省。 */
export function parseAgentDeploymentConfig(
  value: unknown,
  sourcePath: string = AGENT_CONFIG_PATH
): AgentDeploymentConfig {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, AGENT_CAPABILITY_NAMES) ||
    !AGENT_AI_CHAT_REQUIRED_CAPABILITIES.every(
      (key: string): boolean => Object.hasOwn(value, key)
    )
  ) {
    return invalidInput(
      sourcePath,
      "$.agent",
      "exactly { ad_detect?, text, summary, media, image?, tts?, web_search? }"
    );
  }
  let tts: AgentTtsCapabilityConfig | undefined;
  if (value.tts !== undefined) {
    tts = parseTtsCapability(value.tts, sourcePath);
  }
  const image: AgentImageCapabilityConfig | undefined = value.image === undefined
    ? undefined
    : parseImageCapability(value.image, sourcePath);
  const webSearch: AgentWebSearchCapabilityConfig | undefined = value.web_search === undefined
    ? undefined
    : parseWebSearchCapability(value.web_search, sourcePath);
  return {
    text: parseCapability(value.text, "$.agent.text", sourcePath),
    summary: parseCapability(value.summary, "$.agent.summary", sourcePath),
    media: parseCapability(value.media, "$.agent.media", sourcePath),
    image,
    tts,
    webSearch,
  };
}

/** 顶层只允许 agent；能力 getter 在它下面各自消费。 */
function requireAgentRecord(
  value: unknown,
  sourcePath: string
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["agent"])) {
    return invalidInput(sourcePath, "$", "exactly { agent }");
  }
  if (!isPlainRecord(value.agent)) {
    return invalidInput(sourcePath, "$.agent", "an object");
  }
  return value.agent;
}

/** 读入统一配置并只校验顶层，具体能力由消费方严格解析。 */
async function readAgentConfigRecord(
  path: string
): Promise<Readonly<Record<string, unknown>>> {
  return requireAgentRecord(await readJsonInput(path), path);
}

/** 严格解析整份已存在的 agent.json：已出现的每项能力都必须合法，缺省的段返回 null。 */
export async function loadAgentConfigSnapshots(
  path: string = AGENT_CONFIG_PATH
): Promise<AgentConfigSnapshots> {
  const record: Readonly<Record<string, unknown>> = await readAgentConfigRecord(path);
  if (!hasOnlyKeys(record, AGENT_CAPABILITY_NAMES)) {
    return invalidInput(
      path,
      "$.agent",
      "only { ad_detect?, text?, summary?, media?, image?, tts?, web_search? }"
    );
  }
  const adDetectConfig: AdDetectAgentConfig | undefined = record.ad_detect === undefined
    ? undefined
    : parseAdDetectAgentConfig(record.ad_detect, path);
  if (record.text !== undefined) parseCapability(record.text, "$.agent.text", path);
  if (record.summary !== undefined) parseCapability(record.summary, "$.agent.summary", path);
  if (record.media !== undefined) parseCapability(record.media, "$.agent.media", path);
  if (record.image !== undefined) parseImageCapability(record.image, path);
  if (record.tts !== undefined) {
    parseTtsCapability(record.tts, path);
  }
  if (record.web_search !== undefined) parseWebSearchCapability(record.web_search, path);
  const hasAiChatCore: boolean = AGENT_AI_CHAT_REQUIRED_CAPABILITIES.every(
    (key: string): boolean => Object.hasOwn(record, key)
  );
  const agentConfig: AgentDeploymentConfig | null = hasAiChatCore
    ? parseAgentDeploymentConfig(record, path)
    : null;
  return { adDetect: adDetectConfig ?? null, agent: agentConfig };
}

/** 启动总闸严格校验整份已存在的 agent.json，并填充默认路径缓存。 */
export async function validateAgentDeploymentConfig(
  path: string = AGENT_CONFIG_PATH
): Promise<void> {
  const snapshots: AgentConfigSnapshots = await loadAgentConfigSnapshots(path);
  if (path === AGENT_CONFIG_PATH) {
    adDetectAgentConfigCache.current = snapshots.adDetect;
    agentDeploymentConfigCache.current = snapshots.agent;
  }
}

/** 本 isolate 当前的 ad_detect 快照；null 表示文件或 ad_detect 段明确缺省。 */
export function adDetectAgentConfigSnapshot(): AdDetectAgentConfig | null {
  return adDetectAgentConfigCache.current;
}

/** 本 isolate 当前的对话能力快照；null 表示文件或对话核心能力段明确缺省。 */
export function agentDeploymentConfigSnapshot(): AgentDeploymentConfig | null {
  return agentDeploymentConfigCache.current;
}

/** 接管已严格校验的 ad_detect 快照（含显式 null），整体替换 holder。 */
export function adoptAdDetectAgentConfig(config: AdDetectAgentConfig | null): void {
  adDetectAgentConfigCache.current = config;
}

/** 接管已严格校验的 AI 对话能力快照（含显式 null），整体替换 holder。 */
export function adoptAgentDeploymentConfig(config: AgentDeploymentConfig | null): void {
  agentDeploymentConfigCache.current = config;
}

/** 读取本 isolate 的 ad_detect 配置；只读 holder，未填充时抛错。 */
export function getAdDetectAgentConfig(): AdDetectAgentConfig {
  const config: AdDetectAgentConfig | null = adDetectAgentConfigCache.current;
  if (config === null) {
    throw new Error(
      `Ad detection agent configuration is unavailable in this thread; ${AGENT_CONFIG_PATH} $.agent.ad_detect was never delivered.`
    );
  }
  return config;
}

/** 读取本 isolate 的 AI 对话能力配置；语义同 getAdDetectAgentConfig。 */
export function getAgentDeploymentConfig(): AgentDeploymentConfig {
  const config: AgentDeploymentConfig | null = agentDeploymentConfigCache.current;
  if (config === null) {
    throw new Error(
      `AI chat agent configuration is unavailable in this thread; ${AGENT_CONFIG_PATH} $.agent was never delivered.`
    );
  }
  return config;
}

/**
 * 按能力名读取本 isolate 的能力配置；`web_search` 对应 AgentDeploymentConfig.webSearch，其余
 * 能力名与字段名相同。可缺省的能力没配时为 undefined。只读 holder，不读盘；各家 SDK 客户端
 * 缓存据此按能力取凭据与端点。
 */
export function agentCapabilityConfig(capability: AgentCapability): AgentDeploymentCapabilityConfig | undefined {
  const config: AgentDeploymentConfig = getAgentDeploymentConfig();
  return capability === "web_search" ? config.webSearch : config[capability];
}

/**
 * 按能力名读取三项对话核心能力或独立检索 `web_search` 的配置；未配置时抛错，不做凭据或故障
 * 回退。只读 holder，不读盘；回复、摘要、视觉与检索的请求体据此取模型。
 */
export function requireAgentCapabilityConfig(capability: AgentGeneralCapability): AgentCapabilityConfig {
  const deployment: AgentDeploymentConfig = getAgentDeploymentConfig();
  const config: AgentCapabilityConfig | undefined = capability === "web_search"
    ? deployment.webSearch
    : deployment[capability];
  if (config === undefined) throw new Error(`Agent capability "${capability}" is not configured.`);
  return config;
}

/**
 * 本 isolate 当前的 `agent.tts` 配置；文件、对话核心能力段或 tts 段缺省时为 undefined。
 * 只读 holder，不读盘。主线程的 `/send` 代发 TTS、cron `send_voice` 与 cron.json 的
 * 交叉校验据此判定语音合成是否已配置，`/send` 的额度提示读它的 dailyReserveQuota；AI Worker 的
 * 语音余量与余量行读它的 dailyLimit 与 dailyReserveQuota。
 */
export function agentTtsConfig(): AgentTtsCapabilityConfig | undefined {
  return agentDeploymentConfigCache.current?.tts;
}
