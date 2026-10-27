import { createStore } from "zustand";
import type { StoreApi } from "zustand";
import { fetchMiniAppMood } from "../api/mood";
import { switchMiniAppMood } from "../api/moodSwitch";
import { fetchMiniAppStatus } from "../api/status";
import { MINI_APP_STATUS_POLL_INTERVAL_MS } from "../consts/miniApp";
import { extractServerNoticeParams, getMiniAppTranslations } from "../i18n";
import { errorMessage } from "../libs/errorMessage";
import { waitMinimumLoadingDuration } from "../libs/loading";
import { isMiniAppForeground, subscribeMiniAppForeground } from "../libs/telegram";
import type {
  MiniAppMoodMutationResult,
  MiniAppMoodView,
  MiniAppStatusView,
} from "../types/miniApp";
import { useMiniAppStore } from "./app";

/** `StatusPage` 实时状态看板的状态与动作接口。 */
export interface MiniAppStatusStoreState {
  /** 最近一次成功拉取的运行状态快照。 */
  readonly status: MiniAppStatusView | null;
  /** 是否处于挂载后的首次加载中。 */
  readonly loading: boolean;
  /** 是否处于手动刷新中。 */
  readonly refreshing: boolean;
  /** 最近一次拉取失败的错误说明（成功后清空）。 */
  readonly errorText: string | null;
  /** 各子系统折叠面板的展开状态表（默认全部收起）。 */
  readonly expandedCapKeys: Readonly<Record<string, boolean>>;
  /** 当前全局生效的 AI 情绪名（未激活或不可用时为 `null`）。 */
  readonly currentMood: string | null;
  /** 是否正在请求切换全局 AI 情绪。 */
  readonly switchingMood: boolean;

  /** 查询当前全局情绪；异常不影响主状态看板。 */
  readonly loadMood: () => Promise<void>;
  /**
   * 拉取状态快照；只采纳最后一次发起的请求结果，成功时通知根 store 状态已就绪。
   * 手动刷新（`showErrorToast`）或首次加载时保证骨架屏最短展示时长，手动刷新同时重查情绪并以 Toast 报错。
   */
  readonly loadStatus: (showErrorToast: boolean) => Promise<void>;
  /**
   * 开始前台轮询：前台时立即拉取一次，每次响应结算后间隔 `MINI_APP_STATUS_POLL_INTERVAL_MS` 再拉；
   * 页面隐藏或 Mini App 被最小化时不再排期，回到前台且无排期与在途请求时立即补拉。重复调用先停止旧轮询。
   */
  readonly startPolling: () => void;
  /** 停止轮询并注销前台状态订阅；在途请求结算后不再排期。 */
  readonly stopPolling: () => void;
  /** 切换指定子系统折叠面板的展开状态。 */
  readonly toggleCapability: (capKey: string) => void;
  /** 重抽全局 AI 情绪并以 Toast 回报结果。 */
  readonly switchMood: () => Promise<void>;
}

/** 一个 `StatusPage` 实例独占的状态仓库。 */
export type MiniAppStatusStore = StoreApi<MiniAppStatusStoreState>;

/**
 * 创建 `StatusPage` 的状态仓库；组件挂载时创建、卸载即丢弃，生命周期与组件实例一致。
 *
 * @returns 新的实时状态看板仓库
 */
export function createStatusStore(): MiniAppStatusStore {
  return createStore<MiniAppStatusStoreState>()(
    (
      set: (partial: Partial<MiniAppStatusStoreState>) => void,
      get: () => MiniAppStatusStoreState
    ): MiniAppStatusStoreState => {
      let hasSnapshot: boolean = false;
      let requestSeq: number = 0;
      let pollGeneration: number = 0;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;
      let pollInFlight: boolean = false;
      let unsubscribeForeground: (() => void) | null = null;

      const clearPollTimer = (): void => {
        if (pollTimer !== null) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
      };

      const pollOnce = async (generation: number): Promise<void> => {
        pollInFlight = true;
        await get().loadStatus(false);
        if (generation !== pollGeneration) return;
        pollInFlight = false;
        if (!isMiniAppForeground()) return;
        pollTimer = setTimeout((): void => {
          pollTimer = null;
          void pollOnce(generation);
        }, MINI_APP_STATUS_POLL_INTERVAL_MS);
      };

      const onForegroundChange = (): void => {
        if (!isMiniAppForeground()) {
          clearPollTimer();
          return;
        }
        if (pollTimer === null && !pollInFlight) {
          void pollOnce(pollGeneration);
        }
      };

      return {
        status: null,
        loading: true,
        refreshing: false,
        errorText: null,
        expandedCapKeys: {},
        currentMood: null,
        switchingMood: false,

        loadMood: async (): Promise<void> => {
          try {
            const moodView: MiniAppMoodView = await fetchMiniAppMood();
            if (moodView.available && moodView.currentMood !== null) {
              set({ currentMood: moodView.currentMood });
            } else {
              set({ currentMood: null });
            }
          } catch (_error: unknown) {
            // 情绪查询异常不阻塞主状态看板
          }
        },

        loadStatus: async (showErrorToast: boolean): Promise<void> => {
          const reqId: number = ++requestSeq;
          const startedAt: number = Date.now();
          const shouldWaitMin: boolean = showErrorToast || !hasSnapshot;
          if (showErrorToast) {
            set({ refreshing: true });
            void get().loadMood();
          }
          try {
            const next: MiniAppStatusView = await fetchMiniAppStatus();
            if (shouldWaitMin) {
              await waitMinimumLoadingDuration(startedAt);
            }
            if (reqId !== requestSeq) {
              return;
            }
            hasSnapshot = true;
            set({ status: next, errorText: null });
            useMiniAppStore.getState().setStatusReady(true);
          } catch (error: unknown) {
            if (shouldWaitMin) {
              await waitMinimumLoadingDuration(startedAt);
            }
            if (reqId !== requestSeq) {
              return;
            }
            const rawMessage: string = errorMessage(error);
            const localized: string = getMiniAppTranslations(
              useMiniAppStore.getState().language
            ).serverNotice(rawMessage, extractServerNoticeParams(error));
            set({ errorText: localized });
            if (showErrorToast) {
              useMiniAppStore.getState().notify(rawMessage, "info", error);
            }
          } finally {
            if (reqId === requestSeq) {
              set({ loading: false, refreshing: false });
            }
          }
        },

        startPolling: (): void => {
          get().stopPolling();
          unsubscribeForeground = subscribeMiniAppForeground(onForegroundChange);
          if (isMiniAppForeground()) {
            void pollOnce(pollGeneration);
          }
        },

        stopPolling: (): void => {
          pollGeneration += 1;
          pollInFlight = false;
          clearPollTimer();
          unsubscribeForeground?.();
          unsubscribeForeground = null;
        },

        toggleCapability: (capKey: string): void => {
          const prev: Readonly<Record<string, boolean>> = get().expandedCapKeys;
          set({ expandedCapKeys: { ...prev, [capKey]: prev[capKey] !== true } });
        },

        switchMood: async (): Promise<void> => {
          const startedAt: number = Date.now();
          set({ switchingMood: true });
          try {
            const result: MiniAppMoodMutationResult = await switchMiniAppMood();
            await waitMinimumLoadingDuration(startedAt);
            if (result.ok && result.currentMood !== null) {
              set({ currentMood: result.currentMood, switchingMood: false });
            } else {
              set({ switchingMood: false });
            }
            useMiniAppStore.getState().notify(result.message, "info", result);
          } catch (error: unknown) {
            await waitMinimumLoadingDuration(startedAt);
            set({ switchingMood: false });
            const message: string = errorMessage(error);
            useMiniAppStore.getState().notify(message, "info", error);
          } finally {
            if (get().switchingMood) {
              set({ switchingMood: false });
            }
          }
        },
      };
    }
  );
}
