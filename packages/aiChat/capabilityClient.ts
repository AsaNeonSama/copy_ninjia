/**
 * 按能力与供应商从本线程 holder 获取或延迟构造 SDK 客户端。
 */

import { AGENT_PROVIDER_LABELS } from "../consts/agent";
import { agentCapabilityConfig } from "../config/agent";
import type {
  AgentCapability,
  AgentDeploymentCapabilityConfig,
  AgentProvider,
  ProviderCapabilityConfig,
} from "../types/config";

export interface CapabilityClientOptions<TProvider extends AgentProvider, TClient> {
  /** 期望的能力供应商标识。 */
  readonly provider: TProvider;
  /** 目标 AI 能力槽位。 */
  readonly capability: AgentCapability;
  /** 本线程该供应商按能力索引的客户端缓存。 */
  readonly holder: { current: Map<AgentCapability, TClient> | null };
  /** 根据已校验的能力配置构造客户端实例的工厂函数。 */
  readonly create: (config: ProviderCapabilityConfig<TProvider>) => TClient;
}

/**
 * 判断能力配置是否已定义且归属于指定供应商。
 * @param config 待检查的能力部署配置。
 * @param provider 期望的供应商标识。
 * @returns 配置归属于 `provider` 时返回 `true`，否则返回 `false`。
 */
function isProviderConfig<TProvider extends AgentProvider>(
  config: AgentDeploymentCapabilityConfig | undefined,
  provider: TProvider
): config is ProviderCapabilityConfig<TProvider> {
  return config?.provider === provider;
}

/**
 * 获取指定能力的 SDK 客户端；能力未配置或不属于该 provider 时抛错。
 * @param options 客户端缓存与构造参数。
 * @returns 对应能力的缓存或新创建的 SDK 客户端实例。
 */
export function capabilityClient<TProvider extends AgentProvider, TClient>({
  provider,
  capability,
  holder,
  create,
}: CapabilityClientOptions<TProvider, TClient>): TClient {
  const config: AgentDeploymentCapabilityConfig | undefined = agentCapabilityConfig(capability);
  if (!isProviderConfig(config, provider)) {
    throw new Error(
      `Agent capability "${capability}" is not configured for the ${AGENT_PROVIDER_LABELS[provider]} provider.`
    );
  }
  const clients: Map<AgentCapability, TClient> = holder.current ??= new Map<AgentCapability, TClient>();
  const cached: TClient | undefined = clients.get(capability);
  if (cached !== undefined) return cached;
  const client: TClient = create(config);
  clients.set(capability, client);
  return client;
}
