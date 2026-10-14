/** owner: main。Telegram 客户端初始化状态与按类别限流退避队列（packages/infra/telegram/outboundGate.ts）。 */

import type { FlushWaiter } from "../../types/lifecycle";
import type {
  TelegramOutboundJob,
  TelegramRetryCategory,
  TelegramRetryLane,
} from "../../types/telegramOutbound";

/** 构造初始状态的 Telegram 限流退避车道。 */
export function createRetryLane(): TelegramRetryLane {
  return {
    head: null,
    tail: null,
    activeCount: 0,
    pendingCount: 0,
    retryAt: 0,
    retryTimer: null,
    recoveryLimit: 1,
    recoveryActive: 0,
    recovering: false,
  };
}

/** Telegram 客户端 transformer 是否已安装的标记：首次初始化客户端时置为 true，单例布尔值，进程重启后从 false 开始。 */
export const telegramClientInitialization: { current: boolean } = { current: false };

/** Telegram 出站请求准入开关：initTelegramOutboundGate 置为 true，quiesceTelegramOutboundGate 置为 false；单例布尔值，进程重启后从 true 开始。 */
export const telegramOutboundAccepting: { current: boolean } = { current: true };

/** Telegram 出站统一取消控制器：initTelegramOutboundGate 替换为新实例，停机排空超时时中止在途请求与退避重试；单例对象，进程重启后重新创建。 */
export const telegramOutboundAbortController: { current: AbortController } = {
  current: new AbortController(),
};

/**
 * Telegram 出站限流退避门控状态：
 * - activeJobs 在请求启动时登记，结算或取消时移除；
 * - 收到 Telegram 限流响应时，该请求与同类别后续请求进入对应类别的 lanes 侵入式 FIFO 排队，到期重试结算或调用方取消（含 Worker 代际失效）时摘除；
 * - 全类别排队总数上限为 TELEGRAM_429_RETRY_QUEUE_MAX，满额拒绝新入队且不淘汰在途项；drainWaiters 在停机排空时登记并在归零或超时时结算清空；进程重启后从空状态开始。
 */
export const telegramOutboundGateState: {
  activeCount: number;
  retryPendingCount: number;
  nextAdmissionSeq: number;
  aborting: boolean;
  readonly activeJobs: Set<TelegramOutboundJob>;
  readonly lanes: Readonly<Record<TelegramRetryCategory, TelegramRetryLane>>;
  readonly drainWaiters: Set<FlushWaiter>;
} = {
  activeCount: 0,
  retryPendingCount: 0,
  nextAdmissionSeq: 0,
  aborting: false,
  activeJobs: new Set(),
  lanes: {
    message: createRetryLane(),
    inline: createRetryLane(),
    download: createRetryLane(),
    externalFetch: createRetryLane(),
    kick: createRetryLane(),
    query: createRetryLane(),
    restrict: createRetryLane(),
    delete: createRetryLane(),
    chatAction: createRetryLane(),
    reaction: createRetryLane(),
    callback: createRetryLane(),
    edit: createRetryLane(),
    profile: createRetryLane(),
    management: createRetryLane(),
    other: createRetryLane(),
  },
  drainWaiters: new Set(),
};
