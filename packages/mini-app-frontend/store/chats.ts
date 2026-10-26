import { createStore } from "zustand";
import type { StoreApi } from "zustand";
import { fetchMiniAppChatDetail } from "../api/chatDetail";
import { toggleMiniAppChatFeature } from "../api/chatFeature";
import { fetchMiniAppChats } from "../api/chats";
import { MINI_APP_CHATS_DEFAULT_PAGE_SIZE } from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import { errorMessage } from "../libs/errorMessage";
import { waitMinimumLoadingDuration } from "../libs/loading";
import type {
  MiniAppChatDetail,
  MiniAppChatSummary,
  MiniAppFeatureKey,
  MiniAppFeatureToggleResult,
} from "../types/miniApp";
import { useMiniAppStore } from "./app";
import type { MiniAppUiStoreState } from "./app";

/** `ChatsTab` 受管群列表与群详情的状态与动作接口。 */
export interface MiniAppChatsStoreState {
  /** 已启用 `/init` 的受管群摘要列表。 */
  readonly chats: readonly Readonly<MiniAppChatSummary>[];
  /** 是否正在加载群列表。 */
  readonly loadingList: boolean;
  /** 当前打开详情的群 ID（列表视图时为 `null`）。 */
  readonly selectedChatId: number | null;
  /** 当前打开的群详情快照。 */
  readonly chatDetail: MiniAppChatDetail | null;
  /** 是否正在加载群详情。 */
  readonly loadingDetail: boolean;
  /** 正在切换的功能开关键（无切换时为 `null`）。 */
  readonly togglingFeature: MiniAppFeatureKey | null;
  /** 是否正在查看当前群的热发言记录。 */
  readonly viewingMessages: boolean;
  /** 群列表当前页码（从 1 开始，渲染时夹到有效范围）。 */
  readonly chatPage: number;
  /** 群列表每页条数。 */
  readonly chatPageSize: number;

  /** 拉取群列表；只采纳最后一次发起的请求结果。 */
  readonly loadChatList: () => Promise<void>;
  /** 拉取指定群详情；只采纳最后一次发起的请求结果。 */
  readonly loadDetail: (chatId: number) => Promise<void>;
  /** 打开指定群的详情视图并加载详情。 */
  readonly selectChat: (chatId: number) => void;
  /** 关闭详情回到列表并重新加载群列表。 */
  readonly closeDetail: () => void;
  /** 进入当前群的热发言记录视图。 */
  readonly openMessages: () => void;
  /** 从热发言记录返回详情视图并重新加载详情。 */
  readonly closeMessages: () => void;
  /** 切换当前群的单项功能开关（关闭 `/init` 前先弹出确认）。 */
  readonly toggleFeature: (feature: MiniAppFeatureKey, enabled: boolean) => Promise<void>;
  /** 切换群列表页码。 */
  readonly setChatPage: (page: number) => void;
  /** 切换群列表每页条数并回到第 1 页。 */
  readonly setChatPageSize: (pageSize: number) => void;
}

/** 一个 `ChatsTab` 实例独占的状态仓库。 */
export type MiniAppChatsStore = StoreApi<MiniAppChatsStoreState>;

/**
 * 创建 `ChatsTab` 的状态仓库；组件挂载时创建、卸载即丢弃，生命周期与组件实例一致。
 *
 * @returns 新的受管群列表仓库
 */
export function createChatsStore(): MiniAppChatsStore {
  return createStore<MiniAppChatsStoreState>()(
    (
      set: (partial: Partial<MiniAppChatsStoreState>) => void,
      get: () => MiniAppChatsStoreState
    ): MiniAppChatsStoreState => {
      let listReqSeq: number = 0;
      let detailReqSeq: number = 0;

      return {
        chats: [],
        loadingList: true,
        selectedChatId: null,
        chatDetail: null,
        loadingDetail: false,
        togglingFeature: null,
        viewingMessages: false,
        chatPage: 1,
        chatPageSize: MINI_APP_CHATS_DEFAULT_PAGE_SIZE,

        loadChatList: async (): Promise<void> => {
          const reqId: number = ++listReqSeq;
          const startedAt: number = Date.now();
          set({ loadingList: true });
          try {
            const items: readonly Readonly<MiniAppChatSummary>[] = await fetchMiniAppChats();
            await waitMinimumLoadingDuration(startedAt);
            if (reqId !== listReqSeq) {
              return;
            }
            set({ chats: items });
          } catch (error: unknown) {
            await waitMinimumLoadingDuration(startedAt);
            if (reqId !== listReqSeq) {
              return;
            }
            const message: string = errorMessage(error);
            useMiniAppStore.getState().notify(message);
          } finally {
            if (reqId === listReqSeq) {
              set({ loadingList: false });
            }
          }
        },

        loadDetail: async (chatId: number): Promise<void> => {
          const reqId: number = ++detailReqSeq;
          const startedAt: number = Date.now();
          set({ loadingDetail: true });
          try {
            const detail: MiniAppChatDetail = await fetchMiniAppChatDetail(chatId);
            await waitMinimumLoadingDuration(startedAt);
            if (reqId !== detailReqSeq) {
              return;
            }
            set({ chatDetail: detail });
          } catch (error: unknown) {
            await waitMinimumLoadingDuration(startedAt);
            if (reqId !== detailReqSeq) {
              return;
            }
            const message: string = errorMessage(error);
            useMiniAppStore.getState().notify(message);
          } finally {
            if (reqId === detailReqSeq) {
              set({ loadingDetail: false });
            }
          }
        },

        selectChat: (chatId: number): void => {
          set({ selectedChatId: chatId, viewingMessages: false, chatDetail: null });
          void get().loadDetail(chatId);
        },

        closeDetail: (): void => {
          set({ selectedChatId: null, chatDetail: null });
          void get().loadChatList();
        },

        openMessages: (): void => {
          set({ viewingMessages: true });
        },

        closeMessages: (): void => {
          set({ viewingMessages: false });
          const chatId: number | null = get().selectedChatId;
          if (chatId !== null) {
            void get().loadDetail(chatId);
          }
        },

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
          set({ togglingFeature: feature });
          try {
            const result: MiniAppFeatureToggleResult = await toggleMiniAppChatFeature(
              chatId,
              feature,
              enabled
            );
            useMiniAppStore.getState().notify(result.message);
            if (result.removedFromList || result.detail === null) {
              set({ selectedChatId: null, chatDetail: null });
              void get().loadChatList();
            } else {
              set({ chatDetail: result.detail });
            }
          } catch (error: unknown) {
            const message: string = errorMessage(error);
            useMiniAppStore.getState().notify(message);
          } finally {
            set({ togglingFeature: null });
          }
        },

        setChatPage: (page: number): void => {
          set({ chatPage: page });
        },

        setChatPageSize: (pageSize: number): void => {
          set({ chatPage: 1, chatPageSize: pageSize });
        },
      };
    }
  );
}
