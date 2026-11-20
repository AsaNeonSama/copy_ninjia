/**
 * Mini App 全量基准链路的依赖注入接口定义。
 *
 * 本文件只包含 `import type` 与接口声明，不加载任何生产模块图
 * （见 scripts/conventions/moduleBoundaries.ts 的全量基准 import 边界）。
 */

import type { aiMemoryUsages } from "../../../packages/cache/main/aiChat";
import type {
  miniAppAuthHandshakes,
  miniAppAuthSessions,
  miniAppPasswordGuardHolder,
  miniAppRejectHtmlHolder,
} from "../../../packages/cache/main/miniApp";
import type { chatQaEntries } from "../../../packages/cache/main/qa";
import type { getAssetConfig } from "../../../packages/config/assets";
import type { flushDiskIODomain } from "../../../packages/infra/diskIO";
import type {
  adoptRandomImageDirectory,
  deleteRandomImageFile,
  inspectRandomImageDirectory,
  storeRandomImage,
} from "../../../packages/infra/imageGallery";
import type { recordJoinLog } from "../../../packages/infra/joinLog";
import type { getOrCreateChatState } from "../../../packages/infra/chatStateStorage";
import type {
  deriveMiniAppInitDataSecretKey,
  deriveMiniAppPageGateSecretKey,
  issueMiniAppPageGateToken,
} from "../../../packages/libs/miniAppAuth";
import type { ensureMiniAppRuntimeSigningKeyPair } from "../../../packages/mini-app-api-server/auth/handshake";
import type { evaluateMiniAppPageGateRequest } from "../../../packages/mini-app-api-server/auth/pageGate";
import type { issueMiniAppAuthSession } from "../../../packages/mini-app-api-server/auth/session";
import type { resetMiniAppTotpMemoryCache } from "../../../packages/mini-app-api-server/auth/totpStorage";
import type { serveMiniAppRejectHtml } from "../../../packages/mini-app-api-server/handlers/page";
import type {
  decryptMiniAppPayload,
  encryptMiniAppPayload,
  isMiniAppEncryptedEnvelope,
  sealMiniAppQuery,
} from "../../../packages/mini-app-frontend/libs/crypto";
import type {
  deriveClientMiniAppHandshakeKeys,
  generateClientMiniAppX25519KeyPair,
  verifyMiniAppHandshakeOfferDetailed,
} from "../../../packages/mini-app-frontend/libs/handshakeCrypto";
import type { setMiniAppServerSigningPublicKeyForTest } from "../../../packages/mini-app-frontend/libs/signingKey";
import type { MiniAppBunRouteTable } from "../../../packages/types/miniApp/server";

/** Mini App API 链路由 chain.ts 注入的生产入口与夹具参数。 */
export interface MiniAppChainDependencies {
  readonly chainMiniAppApiRequests: number;
  readonly chainMiniAppRejectPages: number;
  readonly chainMiniAppPageGates: number;
  readonly chainMiniAppAuthLogins: number;
  readonly chainMiniAppGalleryAssets: number;
  readonly botToken: string;
  readonly superAdminUserId: number;
  readonly miniAppPassword: string;
  readonly ensureMiniAppRuntimeSigningKeyPair: typeof ensureMiniAppRuntimeSigningKeyPair;
  readonly benchmarkChatId: (index: number) => number;
  readonly benchmarkUserId: (index: number) => number;
  readonly getOrCreateChatState: typeof getOrCreateChatState;
  readonly aiMemoryUsages: typeof aiMemoryUsages;
  readonly chatQaEntries: typeof chatQaEntries;
  readonly recordJoinLog: typeof recordJoinLog;
  readonly flushDiskIODomain: typeof flushDiskIODomain;
  readonly issueMiniAppAuthSession: typeof issueMiniAppAuthSession;
  readonly miniAppAuthSessions: typeof miniAppAuthSessions;
  readonly miniAppAuthHandshakes: typeof miniAppAuthHandshakes;
  readonly miniAppPasswordGuardHolder: typeof miniAppPasswordGuardHolder;
  readonly miniAppRejectHtmlHolder: typeof miniAppRejectHtmlHolder;
  readonly resetMiniAppTotpMemoryCache: typeof resetMiniAppTotpMemoryCache;
  readonly serveMiniAppRejectHtml: typeof serveMiniAppRejectHtml;
  readonly decryptMiniAppPayload: typeof decryptMiniAppPayload;
  readonly encryptMiniAppPayload: typeof encryptMiniAppPayload;
  readonly isMiniAppEncryptedEnvelope: typeof isMiniAppEncryptedEnvelope;
  readonly setMiniAppServerSigningPublicKeyForTest: typeof setMiniAppServerSigningPublicKeyForTest;
  readonly verifyMiniAppHandshakeOfferDetailed: typeof verifyMiniAppHandshakeOfferDetailed;
  readonly generateClientMiniAppX25519KeyPair: typeof generateClientMiniAppX25519KeyPair;
  readonly deriveClientMiniAppHandshakeKeys: typeof deriveClientMiniAppHandshakeKeys;
  readonly sealMiniAppQuery: typeof sealMiniAppQuery;
  readonly evaluateMiniAppPageGateRequest: typeof evaluateMiniAppPageGateRequest;
  readonly deriveMiniAppInitDataSecretKey: typeof deriveMiniAppInitDataSecretKey;
  readonly deriveMiniAppPageGateSecretKey: typeof deriveMiniAppPageGateSecretKey;
  readonly issueMiniAppPageGateToken: typeof issueMiniAppPageGateToken;
  readonly getAssetConfig: typeof getAssetConfig;
  readonly inspectRandomImageDirectory: typeof inspectRandomImageDirectory;
  readonly adoptRandomImageDirectory: typeof adoptRandomImageDirectory;
  readonly storeRandomImage: typeof storeRandomImage;
  readonly deleteRandomImageFile: typeof deleteRandomImageFile;
  readonly loadChatsBunRoutes: () => Promise<MiniAppBunRouteTable>;
  readonly loadAuthBunRoutes: () => Promise<MiniAppBunRouteTable>;
  readonly loadGalleryBunRoutes: () => Promise<MiniAppBunRouteTable>;
}
