import {
  aiMemoryUsages,
} from "../../../packages/cache/main/aiChat";
import { resetChatStateCache } from "../../../packages/cache/main/chatState";
import {
  miniAppAuthSessions,
  miniAppPasswordGuardHolder,
} from "../../../packages/cache/main/miniApp";
import { chatQaEntries } from "../../../packages/cache/main/qa";
import { BOT_TOKEN, SUPER_ADMIN_USER_ID } from "../../../packages/config/bot";
import {
  AI_MEMORY_HYDRATE_BUFFER_MAX,
  MAX_SUMMARY_ROUNDS,
} from "../../../packages/consts/aiChat/memory";
import { STATE_MANAGED_CHAT_LIMIT } from "../../../packages/consts/storage";
import { getOrCreateChatState } from "../../../packages/infra/chatStateStorage";
import {
  deriveMiniAppInitDataSecretKey,
  verifyMiniAppInitData,
} from "../../../packages/libs/miniAppAuth";
import {
  issueMiniAppAuthSession,
  resolveAndRefreshMiniAppAuthSession,
} from "../../../packages/mini-app-api-server/auth/session";
import { listManagedChats } from "../../../packages/mini-app-api-server/view/chats/query";
import {
  computeExpandFollowScrollDelta,
} from "../../../packages/mini-app-frontend/components/animations/expandFollowScroll";
import type { ExpandedBodyGeometry } from "../../../packages/mini-app-frontend/components/animations/expandFollowScroll";
import {
  computeFlipCollapseDurationMs,
  formatTranslate3dY,
} from "../../../packages/mini-app-frontend/components/animations/flipCollapse";
import { evaluateCubicBezierEase } from "../../../packages/mini-app-frontend/components/animations/frameMotion";
import {
  computeRangeProgressPercent,
  interpolateSpringRangeValue,
} from "../../../packages/mini-app-frontend/components/animations/useAnimatedRangeProgress";
import { MINI_APP_FLIP_COLLAPSE_EASING_POINTS } from "../../../packages/mini-app-frontend/consts/miniApp";
import {
  areCapabilityStatusEqual,
  formatMemoryMb,
  formatUptime,
  truncateDisplayText,
} from "../../../packages/mini-app-frontend/libs/formatters";
import type { MiniAppCapabilityStatus as FrontendCapabilityStatus } from "../../../packages/mini-app-frontend/types/miniApp";
import type { ChatState } from "../../../packages/types/chatState";
import type {
  MiniAppAuthResult,
  MiniAppAuthSession,
  MiniAppChatSummary,
} from "../../../packages/types/miniApp";
import { BENCHMARK_CHAT_ID, BENCHMARK_EPOCH_MS } from "./fixtures";
import type { Scenario } from "./types";

/** 基准测试共享的 `initData` 验签 HMAC-SHA256 密钥。 */
const BENCHMARK_INIT_DATA_SECRET_KEY: Uint8Array =
  deriveMiniAppInitDataSecretKey(BOT_TOKEN);

/**
 * 构造已按 Telegram WebApp 规范 HMAC-SHA256 签名的基准测试 `initData` 查询字符串。
 * @param authDate 秒级签发时间戳。
 * @returns URLSearchParams 编码后的 `initData`。
 */
function buildBenchmarkSignedInitData(authDate: number): string {
  const userJson: string = JSON.stringify({
    id: SUPER_ADMIN_USER_ID,
    first_name: "SuperAdmin",
    username: "super_admin",
  });
  const dataCheckString: string = `auth_date=${authDate}\nuser=${userJson}`;
  const hashHex: string = new Bun.CryptoHasher("sha256", BENCHMARK_INIT_DATA_SECRET_KEY)
    .update(dataCheckString, "utf8")
    .digest("hex");
  const searchParams: URLSearchParams = new URLSearchParams();
  searchParams.set("auth_date", String(authDate));
  searchParams.set("user", userJson);
  searchParams.set("hash", hashHex);
  return searchParams.toString();
}

/**
 * Mini App 后端双层鉴权与受管群列表路由处理热路径基准：
 * 覆盖 Telegram WebApp HMAC-SHA256 签名与超管身份校验、45 分钟密码会话核验与滑窗续期、
 * 以及受管群列表状态汇总（功能开关、热消息条数、QA 条数、封锁倒计时与排序）。
 *
 * @returns Mini App 后端路由热路径场景定义
 */
export function miniAppStatusRouteScenario(): Scenario {
  let initData: string = "";
  let sessionToken: string = "";
  let baseNowMs: number = 0;

  return {
    iterations: 30_000,
    warmupIterations: 60_000,
    prepare: (): void => {
      baseNowMs = BENCHMARK_EPOCH_MS;
      initData = buildBenchmarkSignedInitData(Math.floor(baseNowMs / 1000) - 60);
      sessionToken = issueMiniAppAuthSession(baseNowMs - 10_000).token;
      for (let i: number = 0; i < STATE_MANAGED_CHAT_LIMIT; i += 1) {
        const chatId: number = BENCHMARK_CHAT_ID - i;
        const chatState: ChatState = getOrCreateChatState(chatId);
        chatState.isInitEnabled = true;
        chatState.isAIChatEnabled = (i & 1) === 0;
        chatState.isAdDetectEnabled = true;
        chatState.isFloodControlEnabled = (i & 2) === 0;
        chatState.isAntiRaidEnabled = true;
        chatState.title = `Benchmark Chat ${i}`;
        aiMemoryUsages.set(chatId, {
          bufferedCount: AI_MEMORY_HYDRATE_BUFFER_MAX - i,
          summaryCount: MAX_SUMMARY_ROUNDS,
        });
        chatQaEntries.set(
          chatId,
          new Map<string, string>([
            ["早安", "早上好"],
            ["晚安", "晚安好梦"],
          ])
        );
      }
    },
    run: (iterations: number): number => {
      let checksum: number = 0;
      for (let index: number = 0; index < iterations; index += 1) {
        const nowMs: number = baseNowMs + (index & 1_023);
        const authResult: MiniAppAuthResult = verifyMiniAppInitData({
          initData,
          secretKey: BENCHMARK_INIT_DATA_SECRET_KEY,
          superAdminUserId: SUPER_ADMIN_USER_ID,
          nowMs,
          maxAgeSeconds: Number.POSITIVE_INFINITY,
        });
        if (!authResult.ok) {
          throw new Error("Expected valid Mini App benchmark initData.");
        }
        const session: Readonly<MiniAppAuthSession> | null =
          resolveAndRefreshMiniAppAuthSession(sessionToken, nowMs);
        if (session === null) {
          throw new Error("Expected active Mini App benchmark auth session.");
        }
        const chats: readonly Readonly<MiniAppChatSummary>[] = listManagedChats();
        checksum += authResult.user.id + (session.expiresAt & 0xffff) + chats.length;
      }
      return checksum;
    },
    reset: (): void => {
      miniAppAuthSessions.clear();
      miniAppPasswordGuardHolder.current = null;
      resetChatStateCache();
      aiMemoryUsages.clear();
      chatQaEntries.clear();
    },
    probes: {
      verifyMiniAppInitData,
      resolveAndRefreshMiniAppAuthSession,
      listManagedChats,
    },
  };
}

/** Mini App 前端热路径基准使用的能力快照夹具 A。 */
const FRONTEND_CAPABILITY_SNAPSHOT_A: Readonly<FrontendCapabilityStatus> = {
  key: "agent",
  label: "Agent 能力",
  ready: true,
  detail: "text:gemini-3-flash-preview · summary:gemini-3.1-flash-lite-preview · media:gemini-3-flash-preview",
  items: [
    { label: "对话 text", value: "gemini-3-flash-preview", sub: "google" },
    { label: "摘要 summary", value: "gemini-3.1-flash-lite-preview", sub: "google" },
    { label: "多模态 media", value: "gemini-3-flash-preview", sub: "google" },
    { label: "广告检测 ad_detect", value: "gpt-5.4-mini", sub: "openai" },
  ],
};

/** Mini App 前端热路径基准使用的能力快照夹具 A 的同值独立引用副本。 */
const FRONTEND_CAPABILITY_SNAPSHOT_A_CLONE: Readonly<FrontendCapabilityStatus> = {
  ...FRONTEND_CAPABILITY_SNAPSHOT_A,
  items: [...FRONTEND_CAPABILITY_SNAPSHOT_A.items],
};

/** Mini App 前端热路径基准使用的能力快照夹具 B（末项模型不同）。 */
const FRONTEND_CAPABILITY_SNAPSHOT_B: Readonly<FrontendCapabilityStatus> = {
  key: "agent",
  label: "Agent 能力",
  ready: true,
  detail: "text:gemini-3-flash-preview · summary:gemini-3.1-flash-lite-preview · media:gemini-3-flash-preview",
  items: [
    { label: "对话 text", value: "gemini-3-flash-preview", sub: "google" },
    { label: "摘要 summary", value: "gemini-3.1-flash-lite-preview", sub: "google" },
    { label: "多模态 media", value: "gemini-3-flash-preview", sub: "google" },
    { label: "广告检测 ad_detect", value: "gemini-3-flash-preview", sub: "google" },
  ],
};

/** Mini App 前端热路径基准使用的展开跟滚几何夹具列表。 */
const FRONTEND_EXPAND_GEOMETRIES: readonly Readonly<ExpandedBodyGeometry>[] = [
  { blockTop: 420, bodyTop: 472, bodyHeight: 310 },
  { blockTop: -18, bodyTop: 34, bodyHeight: 240 },
  { blockTop: 180, bodyTop: 232, bodyHeight: 160 },
  { blockTop: 560, bodyTop: 612, bodyHeight: 420 },
];

/**
 * Mini App 前端状态看板比对、格式化与折叠/滑块逐帧动画计算热路径基准：
 * 覆盖子系统就绪度快照记忆化深比对、运行时长与内存指标格式化、双向控制字符清洗与昵称截断、
 * FLIP 折叠收起时长与三阶贝塞尔缓动计算、展开视口跟滚位移计算及回溯清理滑块弹性插值。
 *
 * @returns Mini App 前端渲染与动画计算热路径场景定义
 */
export function miniAppFrontendRenderScenario(): Scenario {
  return {
    iterations: 200_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      const geometryCount: number = FRONTEND_EXPAND_GEOMETRIES.length;
      for (let index: number = 0; index < iterations; index += 1) {
        const candidate: Readonly<FrontendCapabilityStatus> =
          (index & 1) === 0
            ? FRONTEND_CAPABILITY_SNAPSHOT_A_CLONE
            : FRONTEND_CAPABILITY_SNAPSHOT_B;
        const equal: boolean = areCapabilityStatusEqual(
          FRONTEND_CAPABILITY_SNAPSHOT_A,
          candidate
        );
        const uptimeText: string = formatUptime(90_061_000 + (index & 63) * 1_000);
        const memoryText: string = formatMemoryMb(134_217_728 + (index & 127) * 65_536);
        const displayTitle: string = truncateDisplayText(
          "Doro\u202E超管控制台测试群组名称超长截断样例",
          16
        );
        const progress: number = ((index & 31) + 1) / 32;
        const eased: number = evaluateCubicBezierEase(
          MINI_APP_FLIP_COLLAPSE_EASING_POINTS,
          progress
        );
        const durationMs: number = computeFlipCollapseDurationMs(
          180 + (index & 255),
          (index & 1) === 0
        );
        const transformCss: string = formatTranslate3dY((1 - eased) * -24);
        const geometry: Readonly<ExpandedBodyGeometry> =
          FRONTEND_EXPAND_GEOMETRIES[index % geometryCount]!;
        const scrollDelta: number = computeExpandFollowScrollDelta(geometry, 780);
        const springHours: number = interpolateSpringRangeValue(1, 18, progress);
        const rangePercent: string = computeRangeProgressPercent(springHours);
        checksum +=
          (equal ? 1 : 0) +
          uptimeText.length +
          memoryText.length +
          displayTitle.length +
          durationMs +
          transformCss.length +
          scrollDelta +
          rangePercent.length;
      }
      return checksum;
    },
    probes: {
      areCapabilityStatusEqual,
      evaluateCubicBezierEase,
      computeFlipCollapseDurationMs,
      computeExpandFollowScrollDelta,
      interpolateSpringRangeValue,
    },
  };
}
