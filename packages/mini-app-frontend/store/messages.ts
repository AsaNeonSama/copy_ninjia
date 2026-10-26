import { createStore } from "zustand";
import type { StoreApi } from "zustand";
import { fetchMiniAppChatMessages } from "../api/chatMessages";
import { MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE } from "../consts/miniApp";
import { errorMessage } from "../libs/errorMessage";
import { waitMinimumLoadingDuration } from "../libs/loading";
import type { MiniAppMessagePage } from "../types/miniApp";
import { useMiniAppStore } from "./app";

/** `MessagesView` 热发言记录分页的状态与动作接口。 */
export interface MiniAppMessagesStoreState {
  /** 每页条数。 */
  readonly pageSize: number;
  /** 当前请求的页码（服务端夹紧后以返回页码为准）。 */
  readonly pageNumber: number;
  /** 最近一次成功拉取的分页数据。 */
  readonly pageData: MiniAppMessagePage | null;
  /** 是否正在加载。 */
  readonly loading: boolean;

  /** 拉取指定群的一页热发言记录；只采纳最后一次发起的请求结果，服务端夹紧页码时同步当前页码。 */
  readonly loadMessages: (chatId: number, page: number, pageSize: number) => Promise<void>;
  /** 切换页码。 */
  readonly setPageNumber: (page: number) => void;
  /** 切换每页条数并回到第 1 页。 */
  readonly setPageSize: (pageSize: number) => void;
}

/** 一个 `MessagesView` 实例独占的状态仓库。 */
export type MiniAppMessagesStore = StoreApi<MiniAppMessagesStoreState>;

/**
 * 创建 `MessagesView` 的状态仓库；组件挂载时创建、卸载即丢弃，生命周期与组件实例一致。
 *
 * @returns 新的热发言记录仓库
 */
export function createMessagesStore(): MiniAppMessagesStore {
  return createStore<MiniAppMessagesStoreState>()(
    (
      set: (partial: Partial<MiniAppMessagesStoreState>) => void
    ): MiniAppMessagesStoreState => {
      let requestSeq: number = 0;

      return {
        pageSize: MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE,
        pageNumber: 1,
        pageData: null,
        loading: true,

        loadMessages: async (
          chatId: number,
          nextPage: number,
          nextPageSize: number
        ): Promise<void> => {
          const reqId: number = ++requestSeq;
          const startedAt: number = Date.now();
          set({ loading: true });
          try {
            const data: MiniAppMessagePage = await fetchMiniAppChatMessages(
              chatId,
              nextPage,
              nextPageSize
            );
            await waitMinimumLoadingDuration(startedAt);
            if (reqId !== requestSeq) {
              return;
            }
            set({ pageData: data });
            if (data.page !== nextPage) {
              set({ pageNumber: data.page });
            }
          } catch (error: unknown) {
            await waitMinimumLoadingDuration(startedAt);
            if (reqId !== requestSeq) {
              return;
            }
            const message: string = errorMessage(error);
            useMiniAppStore.getState().notify(message, "info", error);
          } finally {
            if (reqId === requestSeq) {
              set({ loading: false });
            }
          }
        },

        setPageNumber: (page: number): void => {
          set({ pageNumber: page });
        },

        setPageSize: (pageSize: number): void => {
          set({ pageNumber: 1, pageSize });
        },
      };
    }
  );
}
