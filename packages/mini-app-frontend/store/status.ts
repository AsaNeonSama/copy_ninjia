import { createStore } from "zustand";
import type { StoreApi } from "zustand";
import { fetchMiniAppMood } from "../api/mood";
import { switchMiniAppMood } from "../api/moodSwitch";
import { fetchMiniAppStatus } from "../api/status";
import { extractServerNoticeParams, getMiniAppTranslations } from "../i18n";
import { errorMessage } from "../libs/errorMessage";
import { waitMinimumLoadingDuration } from "../libs/loading";
import type {
  MiniAppMoodMutationResult,
  MiniAppMoodView,
  MiniAppStatusView,
} from "../types/miniApp";
import { useMiniAppStore } from "./app";

/** `StatusTab` 实时状态看板的状态与动作接口。 */
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
  /** 切换指定子系统折叠面板的展开状态。 */
  readonly toggleCapability: (capKey: string) => void;
  /** 重抽全局 AI 情绪并以 Toast 回报结果。 */
  readonly switchMood: () => Promise<void>;
}

/** 一个 `StatusTab` 实例独占的状态仓库。 */
export type MiniAppStatusStore = StoreApi<MiniAppStatusStoreState>;

/**
 * 创建 `StatusTab` 的状态仓库；组件挂载时创建、卸载即丢弃，生命周期与组件实例一致。
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

        toggleCapability: (capKey: string): void => {
          const prev: Readonly<Record<string, boolean>> = get().expandedCapKeys;
          set({ expandedCapKeys: { ...prev, [capKey]: prev[capKey] !== true } });
        },

        switchMood: async (): Promise<void> => {
          set({ switchingMood: true });
          try {
            const result: MiniAppMoodMutationResult = await switchMiniAppMood();
            if (result.ok && result.currentMood !== null) {
              set({ currentMood: result.currentMood });
            }
            useMiniAppStore.getState().notify(result.message, "info", result);
          } catch (error: unknown) {
            const message: string = errorMessage(error);
            useMiniAppStore.getState().notify(message, "info", error);
          } finally {
            set({ switchingMood: false });
          }
        },
      };
    }
  );
}
