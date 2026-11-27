/**
 * Mini App 业务数据全量基准链路：受管群详情加密 API 请求与受保护图库资源读取。
 *
 * 本文件不加载生产模块图（见 scripts/conventions/moduleBoundaries.ts 的全量基准 import
 * 边界）：生产入口由 chain.ts 在子进程里装配后注入，这里只 import 纯常量与类型。
 */

import {
  AI_MEMORY_HYDRATE_BUFFER_MAX,
  MAX_SUMMARY_ROUNDS,
} from "../../../packages/consts/aiChat/memory";
import {
  MINI_APP_BATCH_KICK_MAX_HOURS,
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_SESSION_HEADER,
} from "../../../packages/consts/miniApp";
import { MINI_APP_ENCRYPTED_QUERY_PARAM } from "../../../packages/consts/miniAppCrypto";
import { CHAT_QA_MAX_PER_CHAT } from "../../../packages/consts/qa";
import { STATE_MANAGED_CHAT_LIMIT } from "../../../packages/consts/storage";
import { MINI_APP_API_SEED_JOIN_EVENTS_PER_CHAT } from "./constants";
import { buildBenchmarkSignedInitData } from "../miniAppInitData";
import type { ChatState } from "../../../packages/types/chatState";
import type { DomainFlushOutcome } from "../../../packages/types/diskIO/replies";
import type { StoreRandomImageResult } from "../../../packages/types/imageGallery";
import type { MiniAppAuthSession } from "../../../packages/types/miniApp/auth";
import type { MiniAppChatDetail } from "../../../packages/types/miniApp/chats";
import type {
  MiniAppBunRouteHandler,
  MiniAppBunRouteTable,
} from "../../../packages/types/miniApp/server";
import type { ChainDefinition } from "./chainDefinition";
import type { MiniAppChainDependencies } from "./miniAppChainTypes";

/** 1×1 透明 PNG 最小合法图片夹具字节，供受保护图库资源链路写入隔离运行根。 */
const BENCHMARK_GALLERY_PNG_BYTES: Readonly<Uint8Array> = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
);

/** `GET /api/chats/detail` 响应信封的固定 AEAD 附加认证数据，预编码以避免在计时循环中重复分配。 */
const CHAT_DETAIL_RESPONSE_AAD: Uint8Array<ArrayBuffer> = new TextEncoder().encode(
  "GET /api/chats/detail:res"
);

/**
 * 构造单群满规格 QA 问答表。
 * @param chatIndex 受管群在基准集合中的下标。
 * @returns 含 `CHAT_QA_MAX_PER_CHAT` 条问答对的 Map。
 */
function buildFullChatQaMap(chatIndex: number): Map<string, string> {
  const entries: Map<string, string> = new Map<string, string>();
  for (let qaIndex: number = 0; qaIndex < CHAT_QA_MAX_PER_CHAT; qaIndex += 1) {
    entries.set(
      `群${chatIndex}-问题-${qaIndex}`,
      `群${chatIndex}-答案-${qaIndex}`
    );
  }
  return entries;
}

/**
 * 构造 Mini App 端到端 HTTP API 请求链路（`GET /api/chats/detail?e=...`）。
 * @param dependencies Mini App 链路依赖集合。
 * @returns `mini-app-api-request` 链路定义。
 */
export function miniAppApiRequestChain(
  dependencies: MiniAppChainDependencies
): ChainDefinition {
  const routeHandlerHolder: {
    current: MiniAppBunRouteHandler | null;
  } = { current: null };
  const headersHolder: {
    current: Readonly<Record<string, string>> | null;
  } = { current: null };
  const sessionCryptoKeyHolder: {
    current: CryptoKey | null;
  } = { current: null };

  return {
    chain: "mini-app-api-request",
    operations: dependencies.chainMiniAppApiRequests,
    recordsPerOperation: 1,
    prepare: async (): Promise<void> => {
      const nowMs: number = Date.now();
      for (
        let chatIndex: number = 0;
        chatIndex < STATE_MANAGED_CHAT_LIMIT;
        chatIndex += 1
      ) {
        const chatId: number = dependencies.benchmarkChatId(chatIndex);
        const state: ChatState = dependencies.getOrCreateChatState(chatId);
        state.isInitEnabled = true;
        state.isAIChatEnabled = (chatIndex & 1) === 0;
        state.isAdDetectEnabled = true;
        state.isFloodControlEnabled = (chatIndex & 2) === 0;
        state.isAntiRaidEnabled = true;
        state.title = `Benchmark Managed Chat ${chatIndex}`;
        dependencies.aiMemoryUsages.set(chatId, {
          bufferedCount: AI_MEMORY_HYDRATE_BUFFER_MAX,
          summaryCount: MAX_SUMMARY_ROUNDS,
        });
        dependencies.chatQaEntries.set(chatId, buildFullChatQaMap(chatIndex));
        for (
          let eventOffset: number = 0;
          eventOffset < MINI_APP_API_SEED_JOIN_EVENTS_PER_CHAT;
          eventOffset += 1
        ) {
          const accepted: boolean = dependencies.recordJoinLog({
            chatId,
            userId: dependencies.benchmarkUserId(
              chatIndex * MINI_APP_API_SEED_JOIN_EVENTS_PER_CHAT + eventOffset
            ),
            joinedAt: nowMs - (eventOffset + 1) * 1_000,
          });
          if (!accepted) {
            throw new Error(
              `Mini App API benchmark join-log seed for chat ${chatId} was rejected.`
            );
          }
        }
      }
      const flushOutcome: DomainFlushOutcome =
        await dependencies.flushDiskIODomain("joinLog");
      if (flushOutcome.result !== "flushed") {
        throw new Error(
          `Mini App API benchmark failed to flush seeded join logs: ${flushOutcome.result}.`
        );
      }
      const initData: string = buildBenchmarkSignedInitData(
        dependencies.deriveMiniAppInitDataSecretKey(dependencies.botToken),
        dependencies.superAdminUserId,
        Math.floor(nowMs / 1_000)
      );
      const issuedSession: Readonly<MiniAppAuthSession> =
        dependencies.issueMiniAppAuthSession(nowMs);
      sessionCryptoKeyHolder.current = await issuedSession.cryptoKey;
      headersHolder.current = {
        [MINI_APP_INIT_DATA_HEADER]: initData,
        [MINI_APP_SESSION_HEADER]: issuedSession.token,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      };
      const routes: MiniAppBunRouteTable =
        await dependencies.loadChatsBunRoutes();
      const getHandler: MiniAppBunRouteHandler | undefined =
        routes["/api/chats/detail"]?.GET;
      if (getHandler === undefined) {
        throw new Error(
          "Mini App API benchmark GET /api/chats/detail route is missing."
        );
      }
      routeHandlerHolder.current = getHandler;
    },
    run: async (sequence: number): Promise<void> => {
      const routeHandler: MiniAppBunRouteHandler | null =
        routeHandlerHolder.current;
      const headers: Readonly<Record<string, string>> | null =
        headersHolder.current;
      const sessionCryptoKey: CryptoKey | null =
        sessionCryptoKeyHolder.current;
      if (
        routeHandler === null ||
        headers === null ||
        sessionCryptoKey === null
      ) {
        throw new Error("Mini App API benchmark route was not prepared.");
      }
      const chatIndex: number = sequence % STATE_MANAGED_CHAT_LIMIT;
      const chatId: number = dependencies.benchmarkChatId(chatIndex);
      const sealedQuery: string = await dependencies.sealMiniAppQuery(
        sessionCryptoKey,
        `chatId=${chatId}`,
        "GET /api/chats/detail"
      );
      const response: Response = await routeHandler(
        new Request(
          `http://127.0.0.1/api/chats/detail?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(sealedQuery)}`,
          {
            method: "GET",
            headers,
          }
        )
      );
      if (response.status !== 200) {
        throw new Error(
          `Mini App API request ${sequence} returned HTTP ${response.status}.`
        );
      }
      const envelope: unknown = await response.json();
      if (!dependencies.isMiniAppEncryptedEnvelope(envelope)) {
        throw new Error(
          `Mini App API request ${sequence} lacked an encrypted response envelope.`
        );
      }
      let decryptedBody: string;
      try {
        decryptedBody = await dependencies.decryptMiniAppPayload(
          sessionCryptoKey,
          envelope,
          CHAT_DETAIL_RESPONSE_AAD
        );
      } catch (error: unknown) {
        throw new Error(
          `Mini App API request ${sequence} failed AES-256-GCM envelope decryption.`,
          { cause: error }
        );
      }
      const payload: { readonly detail?: MiniAppChatDetail } = JSON.parse(
        decryptedBody
      ) as { readonly detail?: MiniAppChatDetail };
      const detail: MiniAppChatDetail | undefined = payload.detail;
      if (
        detail?.chatId !== chatId ||
        detail.qaPairCount !== CHAT_QA_MAX_PER_CHAT ||
        detail.hotMessageCount !== AI_MEMORY_HYDRATE_BUFFER_MAX ||
        detail.joinedCountsByHour.length !== MINI_APP_BATCH_KICK_MAX_HOURS ||
        (detail.joinedCountsByHour[0] ?? 0) < MINI_APP_API_SEED_JOIN_EVENTS_PER_CHAT
      ) {
        throw new Error(
          `Mini App API request ${sequence} returned an incomplete chat detail payload.`
        );
      }
    },
    cleanup: (): void => {
      dependencies.miniAppAuthSessions.clear();
      dependencies.aiMemoryUsages.clear();
      dependencies.chatQaEntries.clear();
      routeHandlerHolder.current = null;
      headersHolder.current = null;
      sessionCryptoKeyHolder.current = null;
    },
  };
}

/**
 * 构造 Mini App 受保护图库资源请求链路（`GET /api/gallery/file?e=...`）。
 * @param dependencies Mini App 链路依赖集合。
 * @returns `mini-app-gallery-asset` 链路定义。
 */
export function miniAppGalleryAssetChain(
  dependencies: MiniAppChainDependencies
): ChainDefinition {
  const handlerHolder: {
    current: MiniAppBunRouteHandler | null;
  } = { current: null };
  const headersHolder: {
    current: Readonly<Record<string, string>> | null;
  } = { current: null };
  const sessionCryptoKeyHolder: {
    current: CryptoKey | null;
  } = { current: null };
  const fileNameHolder: { current: string | null } = { current: null };
  const galleryDirHolder: { current: string | null } = { current: null };

  return {
    chain: "mini-app-gallery-asset",
    operations: dependencies.chainMiniAppGalleryAssets,
    recordsPerOperation: 1,
    prepare: async (): Promise<void> => {
      dependencies.miniAppAuthSessions.clear();
      const directory: string = dependencies.getAssetConfig().randomHImageDirectory;
      dependencies.adoptRandomImageDirectory(
        directory,
        await dependencies.inspectRandomImageDirectory(directory)
      );
      const stored: StoreRandomImageResult =
        await dependencies.storeRandomImage(
          directory,
          new Uint8Array(BENCHMARK_GALLERY_PNG_BYTES)
        );
      if (stored.status !== "stored" && stored.status !== "existing") {
        throw new Error(
          `Mini App gallery-asset benchmark failed to seed gallery image: ${stored.status}.`
        );
      }
      const nowMs: number = Date.now();
      const initData: string = buildBenchmarkSignedInitData(
        dependencies.deriveMiniAppInitDataSecretKey(dependencies.botToken),
        dependencies.superAdminUserId,
        Math.floor(nowMs / 1_000)
      );
      const issuedSession: Readonly<MiniAppAuthSession> =
        dependencies.issueMiniAppAuthSession(nowMs);
      sessionCryptoKeyHolder.current = await issuedSession.cryptoKey;
      headersHolder.current = {
        [MINI_APP_INIT_DATA_HEADER]: initData,
        [MINI_APP_SESSION_HEADER]: issuedSession.token,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      };
      galleryDirHolder.current = directory;
      fileNameHolder.current = stored.fileName;
      const routes: MiniAppBunRouteTable =
        await dependencies.loadGalleryBunRoutes();
      const getHandler: MiniAppBunRouteHandler | undefined =
        routes["/api/gallery/file"]?.GET;
      if (getHandler === undefined) {
        throw new Error(
          "Mini App gallery-asset benchmark GET /api/gallery/file route is missing."
        );
      }
      handlerHolder.current = getHandler;
    },
    run: async (sequence: number): Promise<void> => {
      const routeHandler: MiniAppBunRouteHandler | null = handlerHolder.current;
      const headers: Readonly<Record<string, string>> | null =
        headersHolder.current;
      const sessionCryptoKey: CryptoKey | null =
        sessionCryptoKeyHolder.current;
      const fileName: string | null = fileNameHolder.current;
      if (
        routeHandler === null ||
        headers === null ||
        sessionCryptoKey === null ||
        fileName === null
      ) {
        throw new Error("Mini App gallery-asset benchmark route was not prepared.");
      }
      const sealedQuery: string = await dependencies.sealMiniAppQuery(
        sessionCryptoKey,
        new URLSearchParams({ fileName }).toString(),
        "GET /api/gallery/file"
      );
      const response: Response = await routeHandler(
        new Request(
          `http://127.0.0.1/api/gallery/file?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(sealedQuery)}`,
          { method: "GET", headers }
        )
      );
      if (response.status !== 200 || response.headers.get("etag") === null) {
        throw new Error(
          `Mini App gallery-asset request ${sequence} returned HTTP ${response.status}.`
        );
      }
      const bytes: Uint8Array = await response.bytes();
      if (bytes.byteLength !== BENCHMARK_GALLERY_PNG_BYTES.byteLength) {
        throw new Error(
          `Mini App gallery-asset response ${sequence} returned ${bytes.byteLength} bytes.`
        );
      }
    },
    cleanup: async (): Promise<void> => {
      const directory: string | null = galleryDirHolder.current;
      const fileName: string | null = fileNameHolder.current;
      dependencies.miniAppAuthSessions.clear();
      handlerHolder.current = null;
      headersHolder.current = null;
      sessionCryptoKeyHolder.current = null;
      fileNameHolder.current = null;
      galleryDirHolder.current = null;
      if (directory !== null && fileName !== null) {
        await dependencies.deleteRandomImageFile(directory, fileName);
      }
    },
  };
}
