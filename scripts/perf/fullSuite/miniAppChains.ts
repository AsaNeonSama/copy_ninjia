/**
 * Mini App 端到端 HTTP API 全量基准链路分发入口。
 *
 * 具体链路定义拆分为 `./miniAppAuthChains.ts`（拒绝页、门禁与 ECDH 登录握手）与
 * `./miniAppDataChains.ts`（受管群详情 API 与受保护图库资源），依赖契约位于 `./miniAppChainTypes.ts`。
 * 本目录非夹具模块均不加载生产模块图（见 scripts/conventions/moduleBoundaries.ts）。
 */

import {
  miniAppAuthLoginChain,
  miniAppPageGateAllowChain,
  miniAppRejectPageChain,
} from "./miniAppAuthChains";
import {
  miniAppApiRequestChain,
  miniAppGalleryAssetChain,
} from "./miniAppDataChains";
import type { ChainDefinition } from "./chainDefinition";
import type { MiniAppChainDependencies } from "./miniAppChainTypes";
import type { ChainName } from "./types";

export type { MiniAppChainDependencies } from "./miniAppChainTypes";

/**
 * 返回 Mini App 端到端 API 链路定义；其余链路交给 storageChains、commandChains 与 configChains。
 * @param chain 目标链路标识名。
 * @param dependencies Mini App 链路依赖集合。
 * @returns 若属于 Mini App API 链路则返回对应定义，否则返回 `undefined`。
 */
export function createMiniAppChain(
  chain: ChainName,
  dependencies: MiniAppChainDependencies
): ChainDefinition | undefined {
  switch (chain) {
    case "mini-app-api-request":
      return miniAppApiRequestChain(dependencies);
    case "mini-app-reject-page":
      return miniAppRejectPageChain(dependencies);
    case "mini-app-page-gate-allow":
      return miniAppPageGateAllowChain(dependencies);
    case "mini-app-auth-login":
      return miniAppAuthLoginChain(dependencies);
    case "mini-app-gallery-asset":
      return miniAppGalleryAssetChain(dependencies);
    case "join-log-append":
    case "identity-policy-write":
    case "temporary-whitelist-write":
    case "chat-state-write":
    case "chat-qa-write":
    case "ai-memory-snapshot":
    case "diagnostic-log":
    case "ad-detect-command":
    case "ai-reply-command":
    case "cron-send-voice":
    case "cron-config-reload":
      return undefined;
  }
}
