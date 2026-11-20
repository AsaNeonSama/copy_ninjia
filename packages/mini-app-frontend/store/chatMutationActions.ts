import { triggerMiniAppChatBatchKick } from "../api/chatBatchKick";
import { fetchMiniAppChatDetail } from "../api/chatDetail";
import { toggleMiniAppChatFeature } from "../api/chatFeature";
import {
  MINI_APP_BATCH_KICK_MAX_HOURS,
  MINI_APP_BATCH_KICK_MIN_HOURS,
  MINI_APP_BATCH_KICK_WINDOW_DEBOUNCE_MS,
} from "../consts/miniApp/chats";
import { getMiniAppTranslations } from "../i18n";
import { errorMessage } from "../libs/errorMessage";
import { waitMinimumLoadingDuration } from "../libs/loading";
import type {
  MiniAppBatchKickResult,
  MiniAppChatDetail,
  MiniAppFeatureKey,
  MiniAppFeatureToggleResult,
} from "../types/miniApp/chats";
import { notifyMiniAppIfAuthError, useMiniAppStore } from "./app";
import type { MiniAppUiStoreState } from "./app";
import type { MiniAppChatsStoreState } from "./chats";

/** 构造受管群功能开关与批量清理子动作所需的仓库读写句柄。 */
export interface CreateChatMutationActionsOptions {
  /** 更新 `MiniAppChatsStoreState` 的局部字段。 */
  readonly set: (partial: Partial<MiniAppChatsStoreState>) => void;
  /** 读取当前 `MiniAppChatsStoreState` 快照。 */
  readonly get: () => MiniAppChatsStoreState;
  /** 写入变更接口回传的最新群详情并推进详情请求序号，作废更早发出的在途详情读取。 */
  readonly applyMutationDetail: (detail: MiniAppChatDetail) => void;
  /** 读取当前最新的群详情请求序号（用于丢弃被变更结果覆盖的后台轮询与窗口刷新）。 */
  readonly currentDetailReqSeq: () => number;
  /** 当目标群退出已 `/init` 受管列表时重置详情/目标面板并推进请求序号。 */
  readonly resetRemovedChat: (extra?: Partial<MiniAppChatsStoreState>) => void;
}

/** 受管群功能开关与 `/batch_kick` 批量清理相关的状态动作集合。 */
export type MiniAppChatMutationActions = Pick<
  MiniAppChatsStoreState,
  | "toggleFeature"
  | "setBatchKickHours"
  | "runBatchKick"
  | "pollRunningBatchKick"
>;

/** `createChatMutationActions` 返回的动作集合与防抖窗口刷新取消句柄。 */
export interface MiniAppChatMutationBundle {
  /** 绑定到当前受管群仓库的功能开关与批量清理动作集合。 */
  readonly actions: MiniAppChatMutationActions;
  /** 取消防抖中的回溯时间窗口进群人数刷新定时器并作废在途窗口详情请求。 */
  readonly cancelWindowJoinedRefresh: () => void;
}

/**
 * 创建受管群详情中的功能开关切换、`/batch_kick` 回溯窗口防抖查询、批量清理提交与完成态轮询动作集合。
 *
 * @param options 仓库读写句柄与详情请求序号控制函数
 * @returns 动作集合及窗口刷新取消函数
 */
export function createChatMutationActions({
  set,
  get,
  applyMutationDetail,
  currentDetailReqSeq,
  resetRemovedChat,
}: CreateChatMutationActionsOptions): MiniAppChatMutationBundle {
  let windowJoinedReqSeq: number = 0;
  let windowJoinedTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelWindowJoinedRefresh = (): void => {
    if (windowJoinedTimer !== null) {
      clearTimeout(windowJoinedTimer);
      windowJoinedTimer = null;
    }
    windowJoinedReqSeq += 1;
  };

  const refreshWindowJoinedCount = async (reqId: number): Promise<void> => {
    const chatId: number | null = get().selectedChatId;
    if (chatId === null) {
      if (reqId === windowJoinedReqSeq) {
        set({ loadingWindowJoined: false });
      }
      return;
    }
    const detailEpoch: number = currentDetailReqSeq();
    try {
      const detail: MiniAppChatDetail = await fetchMiniAppChatDetail(chatId);
      if (reqId !== windowJoinedReqSeq || get().selectedChatId !== chatId) {
        return;
      }
      if (detailEpoch !== currentDetailReqSeq()) {
        set({ loadingWindowJoined: false });
        return;
      }
      set({ chatDetail: detail, loadingWindowJoined: false });
    } catch (error: unknown) {
      if (reqId !== windowJoinedReqSeq || get().selectedChatId !== chatId) {
        notifyMiniAppIfAuthError(error);
        return;
      }
      if (detailEpoch !== currentDetailReqSeq()) {
        set({ loadingWindowJoined: false });
        notifyMiniAppIfAuthError(error);
        return;
      }
      set({ loadingWindowJoined: false });
      const message: string = errorMessage(error);
      useMiniAppStore.getState().notify(message, "info", error);
    }
  };

  const actions: MiniAppChatMutationActions = {
    toggleFeature: async (
      feature: MiniAppFeatureKey,
      enabled: boolean
    ): Promise<void> => {
      const chatId: number | null = get().selectedChatId;
      if (chatId === null) return;
      const app: MiniAppUiStoreState = useMiniAppStore.getState();
      if (
        feature === "init" &&
        !enabled &&
        !(await app.requestConfirm(
          getMiniAppTranslations(app.language).chats.confirmDisableInit,
          "danger"
        ))
      ) {
        return;
      }
      cancelWindowJoinedRefresh();
      const startedAt: number = Date.now();
      set({ togglingFeature: feature, loadingWindowJoined: false });
      try {
        const result: MiniAppFeatureToggleResult = await toggleMiniAppChatFeature(
          chatId,
          feature,
          enabled
        );
        await waitMinimumLoadingDuration(startedAt);
        if (get().selectedChatId !== chatId) {
          set({ togglingFeature: null });
          if (
            (result.removedFromList || result.detail === null) &&
            get().selectedChatId === null
          ) {
            void get().loadChatList();
          }
        } else if (result.removedFromList || result.detail === null) {
          resetRemovedChat({ togglingFeature: null });
          await get().loadChatList();
        } else {
          applyMutationDetail(result.detail);
          set({ togglingFeature: null });
        }
        useMiniAppStore.getState().notify(
          result.message,
          result.ok ? "info" : "warning",
          result
        );
      } catch (error: unknown) {
        await waitMinimumLoadingDuration(startedAt);
        set({ togglingFeature: null });
        const message: string = errorMessage(error);
        useMiniAppStore.getState().notify(message, "info", error);
      } finally {
        if (get().togglingFeature !== null) {
          set({ togglingFeature: null });
        }
      }
    },

    setBatchKickHours: (hours: number): void => {
      const normalized: number = Number.isFinite(hours)
        ? Math.trunc(hours)
        : MINI_APP_BATCH_KICK_MIN_HOURS;
      const safeHours: number = Math.min(
        MINI_APP_BATCH_KICK_MAX_HOURS,
        Math.max(MINI_APP_BATCH_KICK_MIN_HOURS, normalized)
      );
      const current: MiniAppChatsStoreState = get();
      if (safeHours === current.batchKickHours && !current.loadingWindowJoined) {
        return;
      }
      cancelWindowJoinedRefresh();
      if (current.selectedChatId === null) {
        set({ batchKickHours: safeHours, loadingWindowJoined: false });
        return;
      }
      const reqId: number = windowJoinedReqSeq;
      set({ batchKickHours: safeHours, loadingWindowJoined: true });
      windowJoinedTimer = setTimeout((): void => {
        windowJoinedTimer = null;
        void refreshWindowJoinedCount(reqId);
      }, MINI_APP_BATCH_KICK_WINDOW_DEBOUNCE_MS);
    },

    runBatchKick: async (): Promise<void> => {
      const {
        selectedChatId,
        batchKickHours,
        batchKickSubmitting,
      }: MiniAppChatsStoreState = get();
      if (selectedChatId === null || batchKickSubmitting) return;
      const app: MiniAppUiStoreState = useMiniAppStore.getState();
      if (
        !(await app.requestConfirm(
          getMiniAppTranslations(app.language).chats.confirmBatchKick(batchKickHours),
          "danger"
        ))
      ) {
        return;
      }
      cancelWindowJoinedRefresh();
      set({ batchKickSubmitting: true, loadingWindowJoined: false });
      try {
        const result: MiniAppBatchKickResult = await triggerMiniAppChatBatchKick(
          selectedChatId,
          batchKickHours
        );
        useMiniAppStore.getState().notify(
          result.message,
          result.outcome === "accepted" ? "info" : "warning",
          result
        );
        if (get().selectedChatId !== selectedChatId) {
          if (
            (result.outcome === "notInitialized" || result.detail === null) &&
            get().selectedChatId === null
          ) {
            void get().loadChatList();
          }
        } else if (result.outcome === "notInitialized" || result.detail === null) {
          resetRemovedChat();
          void get().loadChatList();
        } else {
          applyMutationDetail(result.detail);
        }
      } catch (error: unknown) {
        const message: string = errorMessage(error);
        useMiniAppStore.getState().notify(message, "warning", error);
      } finally {
        set({ batchKickSubmitting: false });
      }
    },

    pollRunningBatchKick: async (): Promise<void> => {
      const {
        selectedChatId,
        chatDetail,
        batchKickSubmitting,
      }: MiniAppChatsStoreState = get();
      if (
        selectedChatId === null ||
        batchKickSubmitting ||
        chatDetail?.batchKickRunning !== true
      ) {
        return;
      }
      const detailEpoch: number = currentDetailReqSeq();
      try {
        const nextDetail: Readonly<MiniAppChatDetail> =
          await fetchMiniAppChatDetail(selectedChatId);
        const current: MiniAppChatsStoreState = get();
        if (current.selectedChatId !== selectedChatId || detailEpoch !== currentDetailReqSeq()) return;
        const wasRunning: boolean = current.chatDetail?.batchKickRunning === true;
        set({ chatDetail: nextDetail });
        if (
          wasRunning &&
          !nextDetail.batchKickRunning &&
          nextDetail.lastBatchKickCompletion !== null
        ) {
          const app: MiniAppUiStoreState = useMiniAppStore.getState();
          app.notify(
            getMiniAppTranslations(app.language).chats.batchKickCompletedSummary(
              nextDetail.lastBatchKickCompletion
            ),
            "info"
          );
        }
      } catch (error: unknown) {
        // 会话失效或锁定时立即通知根仓库锁定控制台，其余后台轮询瞬时异常静默等待下一轮。
        notifyMiniAppIfAuthError(error);
      }
    },
  };

  return { actions, cancelWindowJoinedRefresh };
}
