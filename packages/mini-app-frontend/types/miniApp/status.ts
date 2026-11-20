/**
 * Mini App 前端实时运行状态与 AI 情绪接口契约类型。
 * 与服务端 `packages/types/miniApp/server.ts` 同名的声明保持编译期恒等（由 `test/mini-app-frontend/frontendParity.test.ts` 核对）。
 */

/** 单项模型子能力或已加载任务的结构化明细项（供前端竖向样式化展示）。 */
export interface MiniAppCapabilityDetailItem {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
}

/** Mini App 首页展示的单个功能配置槽位状态。 */
export interface MiniAppCapabilityStatus {
  readonly key: string;
  readonly label: string;
  readonly ready: boolean;
  readonly detail: string;
  readonly items: readonly Readonly<MiniAppCapabilityDetailItem>[];
}

/** `GET /api/mood` 返回的 AI 全局情绪实时状态视图。 */
export interface MiniAppMoodView {
  readonly ok: boolean;
  readonly available: boolean;
  readonly currentMood: string | null;
}

/** `POST /api/mood/switch` 触发重抽 AI 全局情绪后的响应结果。 */
export interface MiniAppMoodMutationResult {
  readonly ok: boolean;
  readonly available: boolean;
  readonly currentMood: string | null;
  readonly message: string;
}

/** Mini App 首页展示的活跃交互会话计数。 */
export interface MiniAppActiveSessionCounts {
  readonly total: number;
  readonly gag: number;
  readonly wed: number;
  readonly verify: number;
  readonly qaSet: number;
}

/** Mini App 首页展示的实时运行状态快照。 */
export interface MiniAppStatusView {
  readonly generatedAt: number;
  readonly uptimeMs: number;
  readonly cpuAveragePercent: number;
  readonly memoryPeakRssBytes: number;
  readonly memoryCurrentRssBytes: number;
  readonly memoryOtherBytes: number;
  readonly memoryTotalBytes: number;
  readonly memoryHeapUsedBytes: number;
  readonly managedChatCount: number;
  readonly whitelistCount: number;
  readonly blocklistCount: number;
  readonly activeSessions: Readonly<MiniAppActiveSessionCounts>;
  readonly telegramOutbound: Readonly<{
    readonly inFlight: number;
    readonly retryWaiting: number;
    readonly retryQueueMax: number;
  }>;
  readonly capabilities: readonly Readonly<MiniAppCapabilityStatus>[];
}
