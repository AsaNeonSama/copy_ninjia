/**
 * Mini App 端到端 HTTP API 请求链路：单请求从 `Bun.serve` 路由表入口进入，
 * 依次完成请求头护栏、Telegram WebApp `initData` HMAC-SHA256 签名与超管身份核验、
 * 45 分钟密码会话核验与滑窗续期、受管群详情内存聚合及 Disk I/O Worker 入群日志 1–24 小时滑窗读取、
 * 以及 HTTP JSON 响应序列化与解析。
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
  MINI_APP_WEB_APP_DATA_SECRET_SEED,
} from "../../../packages/consts/miniApp";
import { CHAT_QA_MAX_PER_CHAT } from "../../../packages/consts/qa";
import { STATE_MANAGED_CHAT_LIMIT } from "../../../packages/consts/storage";
import { MINI_APP_API_SEED_JOIN_EVENTS_PER_CHAT } from "./constants";
import type { aiMemoryUsages } from "../../../packages/cache/main/aiChat";
import type { miniAppAuthSessions } from "../../../packages/cache/main/miniApp";
import type { chatQaEntries } from "../../../packages/cache/main/qa";
import type { flushDiskIODomain } from "../../../packages/infra/diskIO";
import type { recordJoinLog } from "../../../packages/infra/joinLog";
import type { getOrCreateChatState } from "../../../packages/infra/storage/stateStore";
import type { issueMiniAppAuthSession } from "../../../packages/mini-app-api-server/auth/session";
import type { ChatState } from "../../../packages/types/chatState";
import type { DomainFlushOutcome } from "../../../packages/types/diskIO";
import type { MiniAppChatDetail } from "../../../packages/types/miniApp";
import type { ChainDefinition } from "./chainDefinition";
import type { ChainName } from "./types";

/** 携带 `:chatId` 动态路径参数的 `Bun.serve` 路由请求。 */
type ChatDetailRouteRequest = Request & {
  readonly params: Readonly<{ readonly chatId: string }>;
};

/** Mini App API 链路由 chain.ts 注入的生产入口与夹具参数。 */
export interface MiniAppChainDependencies {
  readonly chainMiniAppApiRequests: number;
  readonly botToken: string;
  readonly superAdminUserId: number;
  readonly benchmarkChatId: (index: number) => number;
  readonly benchmarkUserId: (index: number) => number;
  readonly getOrCreateChatState: typeof getOrCreateChatState;
  readonly aiMemoryUsages: typeof aiMemoryUsages;
  readonly chatQaEntries: typeof chatQaEntries;
  readonly recordJoinLog: typeof recordJoinLog;
  readonly flushDiskIODomain: typeof flushDiskIODomain;
  readonly issueMiniAppAuthSession: typeof issueMiniAppAuthSession;
  readonly miniAppAuthSessions: typeof miniAppAuthSessions;
  readonly loadChatsBunRoutes: () => Promise<Bun.Serve.Routes<undefined, string>>;
}

/**
 * 构造已按 Telegram WebApp 规范 HMAC-SHA256 签名的超管 `initData` 查询字符串。
 * @param botToken 基准机器人 Token。
 * @param superAdminUserId 超管 Telegram 用户 ID。
 * @param authDate 秒级签发时间戳。
 * @returns URLSearchParams 编码后的 `initData`。
 */
function buildSignedInitData(
  botToken: string,
  superAdminUserId: number,
  authDate: number
): string {
  const userJson: string = JSON.stringify({
    id: superAdminUserId,
    first_name: "SuperAdmin",
    username: "super_admin",
  });
  const dataCheckString: string = `auth_date=${authDate}\nuser=${userJson}`;
  const secretKey: Uint8Array = new Bun.CryptoHasher(
    "sha256",
    MINI_APP_WEB_APP_DATA_SECRET_SEED
  )
    .update(botToken, "utf8")
    .digest();
  const hashHex: string = new Bun.CryptoHasher("sha256", secretKey)
    .update(dataCheckString, "utf8")
    .digest("hex");
  const searchParams: URLSearchParams = new URLSearchParams();
  searchParams.set("auth_date", String(authDate));
  searchParams.set("user", userJson);
  searchParams.set("hash", hashHex);
  return searchParams.toString();
}

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
 * 构造 Mini App 端到端 HTTP API 请求链路（`GET /api/chats/:chatId`）。
 * @param dependencies Mini App 链路依赖集合。
 * @returns `mini-app-api-request` 链路定义。
 */
function miniAppApiRequestChain(
  dependencies: MiniAppChainDependencies
): ChainDefinition {
  const routeHandlerHolder: {
    current: ((req: ChatDetailRouteRequest) => Promise<Response>) | null;
  } = { current: null };
  const headersHolder: {
    current: Readonly<Record<string, string>> | null;
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
      const initData: string = buildSignedInitData(
        dependencies.botToken,
        dependencies.superAdminUserId,
        Math.floor(nowMs / 1_000)
      );
      const sessionToken: string =
        dependencies.issueMiniAppAuthSession(nowMs).token;
      headersHolder.current = {
        [MINI_APP_INIT_DATA_HEADER]: initData,
        [MINI_APP_SESSION_HEADER]: sessionToken,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      };
      const routes: Bun.Serve.Routes<undefined, string> =
        await dependencies.loadChatsBunRoutes();
      const chatDetailEntry: unknown = (
        routes as Readonly<Record<string, unknown>>
      )["/api/chats/:chatId"];
      const getHandler: unknown =
        typeof chatDetailEntry === "object" && chatDetailEntry !== null
          ? (chatDetailEntry as Readonly<Record<string, unknown>>).GET
          : undefined;
      if (typeof getHandler !== "function") {
        throw new Error(
          "Mini App API benchmark GET /api/chats/:chatId route is missing."
        );
      }
      routeHandlerHolder.current = getHandler as (
        req: ChatDetailRouteRequest
      ) => Promise<Response>;
    },
    run: async (sequence: number): Promise<void> => {
      const routeHandler:
        | ((req: ChatDetailRouteRequest) => Promise<Response>)
        | null = routeHandlerHolder.current;
      const headers: Readonly<Record<string, string>> | null =
        headersHolder.current;
      if (routeHandler === null || headers === null) {
        throw new Error("Mini App API benchmark route was not prepared.");
      }
      const chatIndex: number = sequence % STATE_MANAGED_CHAT_LIMIT;
      const chatId: number = dependencies.benchmarkChatId(chatIndex);
      const chatIdParam: string = String(chatId);
      const rawRequest: Request = new Request(
        `http://127.0.0.1/api/chats/${chatIdParam}`,
        {
          method: "GET",
          headers,
        }
      );
      const routeRequest: ChatDetailRouteRequest = Object.assign(
        rawRequest,
        {
          params: { chatId: chatIdParam },
        }
      );
      const response: Response = await routeHandler(routeRequest);
      if (response.status !== 200) {
        throw new Error(
          `Mini App API request ${sequence} returned HTTP ${response.status}.`
        );
      }
      const payload: { readonly detail?: MiniAppChatDetail } =
        (await response.json()) as { readonly detail?: MiniAppChatDetail };
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
    },
  };
}

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
