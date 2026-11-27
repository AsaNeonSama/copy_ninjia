import { createStore } from "zustand";
import type { StoreApi } from "zustand";
import { fetchMiniAppAdBlacklists } from "../api/adBlacklists";
import {
  MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE,
  MINI_APP_AD_BLACKLIST_QUERY_MAX_LENGTH,
} from "../consts/miniApp/ui";
import { errorMessage } from "../libs/errorMessage";
import { waitMinimumLoadingDuration } from "../libs/loading";
import type {
  MiniAppAdBlacklistKind,
  MiniAppAdBlacklistsResponse,
} from "../types/miniApp/adBlacklists";
import { notifyMiniAppIfAuthError, useMiniAppStore } from "./app";
import type { MiniAppToastTone } from "./app";
import { createAdBlacklistsMutations } from "./adBlacklistsMutations";
import type { MiniAppAdBlacklistsMutationActions } from "./adBlacklistsMutations";
import { createAdBlacklistsPreviewSlice } from "./adBlacklistsPreview";
import type {
  MiniAppAdBlacklistsPreviewSlice,
  MiniAppAdBlacklistPreviewTarget,
} from "./adBlacklistsPreview";

export type { MiniAppAdBlacklistPreviewTarget };

/** `AdBlacklistsPage` 页内重复拦截或错误诊断横幅状态。 */
export interface MiniAppAdBlacklistNoticeBanner {
  /** 横幅视觉类型（`"duplicate"` 判重拦截或 `"error"` 业务错误诊断）。 */
  readonly kind: "duplicate" | "error";
  /** 本地化后的横幅正文说明。 */
  readonly message: string;
}

/** `AdBlacklistsPage` 内容黑名单管理的状态与动作接口。 */
export interface MiniAppAdBlacklistsStoreState
  extends MiniAppAdBlacklistsPreviewSlice {
  /** 当前选中的黑名单种类子标签（`"sticker"` 或 `"emoji"`）。 */
  readonly kind: MiniAppAdBlacklistKind;
  /** 搜索输入框当前值。 */
  readonly searchInput: string;
  /** 防抖生效后的规范化搜索关键字（参与列表请求）。 */
  readonly debouncedQuery: string;
  /** 折叠式添加输入框面板是否展开（默认收起）。 */
  readonly addFormOpen: boolean;
  /** 添加包名输入框当前值。 */
  readonly addPackInput: string;
  /** 页内重复添加或错误诊断横幅（未展示时为 `null`）。 */
  readonly noticeBanner: Readonly<MiniAppAdBlacklistNoticeBanner> | null;
  /** 是否正在加载当前子标签分页列表。 */
  readonly loadingList: boolean;
  /** 是否有新增或移除黑名单写操作在途。 */
  readonly busyAction: boolean;
  /** 贴纸包黑名单当前页码。 */
  readonly stickerPageNumber: number;
  /** 贴纸包黑名单每页条数。 */
  readonly stickerPageSize: number;
  /** 最近一次成功拉取的贴纸包黑名单分页响应。 */
  readonly stickerPage: Readonly<MiniAppAdBlacklistsResponse> | null;
  /** 自定义表情包黑名单当前页码。 */
  readonly emojiPageNumber: number;
  /** 自定义表情包黑名单每页条数。 */
  readonly emojiPageSize: number;
  /** 最近一次成功拉取的自定义表情包黑名单分页响应。 */
  readonly emojiPage: Readonly<MiniAppAdBlacklistsResponse> | null;
  /** 最近一次列表响应携带的贴纸包黑名单全量条数。 */
  readonly stickerTotal: number;
  /** 最近一次列表响应携带的自定义表情包黑名单全量条数。 */
  readonly emojiTotal: number;

  /**
   * 按当前子标签、页码、每页条数与防抖关键字拉取黑名单分页，只采纳最后一次请求结果并在服务端夹紧页码时同步页码；
   * 传 `silent = true` 时不置 `loadingList: true`，保留现有列表原位刷新。
   */
  readonly loadCurrentList: (silent?: boolean) => Promise<void>;
  /** 切换贴纸包 / 自定义表情包子标签并清除页内提示横幅。 */
  readonly selectKind: (kind: MiniAppAdBlacklistKind) => void;
  /** 更新搜索输入框草稿。 */
  readonly setSearchInput: (value: string) => void;
  /** 防抖到期或回车时提交搜索关键字；关键字变化时两类黑名单均回到第 1 页。 */
  readonly commitSearchQuery: (query: string) => void;
  /** 清空搜索输入与已生效搜索关键字并重置页码到第 1 页。 */
  readonly clearSearch: () => void;
  /** 展开或收起折叠式添加包名输入面板。 */
  readonly toggleAddForm: () => void;
  /** 更新待添加包名输入框。 */
  readonly setAddPackInput: (value: string) => void;
  /** 关闭页内重复或错误提示横幅。 */
  readonly dismissNoticeBanner: () => void;
  /**
   * 校验并添加输入的包 short name 或 Telegram 贴纸/表情包分享链接到内容黑名单：
   * 前端经 `parseAdBlacklistPackInput` 解析（纯包名沿用当前子页签，Telegram 链接按 `addstickers`/`addemoji` 自动归类）；
   * 服务端判重或返回业务错误时按发起时子页签展示横幅与 Toast；
   * 发生实际内存变更（含落盘未确认的部分提交 `503`）时若未中途切签则自动切换至目标种类页签、清空输入并单次刷新列表，正常成功时同步收起添加面板。
   */
  readonly addPack: () => Promise<void>;
  /** 弹出二次确认并复检并发态后将指定包名从当前种类内容黑名单移除，发生实际变更（含部分提交 `503`）时刷新列表。 */
  readonly removePack: (pack: string) => Promise<void>;
  /** 切换当前种类子标签的页码。 */
  readonly setPageNumber: (page: number) => void;
  /** 切换当前种类子标签的每页条数并回到第 1 页。 */
  readonly setPageSize: (pageSize: number) => void;
}

/** 一个 `AdBlacklistsPage` 实例独占的状态仓库。 */
export type MiniAppAdBlacklistsStore = StoreApi<MiniAppAdBlacklistsStoreState>;

/**
 * 判断指定黑名单种类子页签是否已有缓存分页，用于决定变更后是否静默原位刷新。
 *
 * @param state 内容黑名单仓库当前状态快照
 * @param tabKind 目标黑名单种类
 * @returns 指定子页签已有缓存分页时返回 `true`
 */
function hasLoadedTabPage(
  state: MiniAppAdBlacklistsStoreState,
  tabKind: MiniAppAdBlacklistKind
): boolean {
  return tabKind === "sticker"
    ? state.stickerPage !== null
    : state.emojiPage !== null;
}

/**
 * 构造当前激活子页签对应的分页请求去重键。
 *
 * @param state 内容黑名单仓库当前状态快照
 * @returns 由种类、页码、每页条数与防抖关键字拼成的去重键
 */
function buildCurrentListKey(state: MiniAppAdBlacklistsStoreState): string {
  const currentPageNumber: number =
    state.kind === "sticker" ? state.stickerPageNumber : state.emojiPageNumber;
  const currentPageSize: number =
    state.kind === "sticker" ? state.stickerPageSize : state.emojiPageSize;
  return `${state.kind}:${currentPageNumber}:${currentPageSize}:${state.debouncedQuery}`;
}

/**
 * 创建 `AdBlacklistsPage` 的状态仓库；组件挂载时创建、卸载即丢弃，生命周期与组件实例一致。
 *
 * @returns 新的内容黑名单管理仓库
 */
export function createAdBlacklistsStore(): MiniAppAdBlacklistsStore {
  return createStore<MiniAppAdBlacklistsStoreState>()(
    (
      set: (partial: Partial<MiniAppAdBlacklistsStoreState>) => void,
      get: () => MiniAppAdBlacklistsStoreState
    ): MiniAppAdBlacklistsStoreState => {
      let requestSeq: number = 0;
      let followUpSkipKey: string | null = null;

      const notify = (
        message: string,
        tone?: MiniAppToastTone,
        metaSource?: unknown
      ): void => {
        useMiniAppStore.getState().notify(message, tone, metaSource);
      };

      const refreshAfterMutation = async (
        originKind: MiniAppAdBlacklistKind,
        targetKind: MiniAppAdBlacklistKind,
        sameOriginPatch: Partial<MiniAppAdBlacklistsStoreState>
      ): Promise<void> => {
        const latestState: MiniAppAdBlacklistsStoreState = get();
        const stayedOnOrigin: boolean = latestState.kind === originKind;
        const willSwitchKind: boolean =
          stayedOnOrigin && targetKind !== originKind;
        const effectiveKind: MiniAppAdBlacklistKind = willSwitchKind
          ? targetKind
          : latestState.kind;
        const silentRefresh: boolean = hasLoadedTabPage(
          latestState,
          effectiveKind
        );
        if (stayedOnOrigin) {
          set({
            ...(willSwitchKind ? { kind: targetKind } : {}),
            ...sameOriginPatch,
            ...(silentRefresh ? {} : { loadingList: true }),
          });
        } else if (!silentRefresh) {
          set({ loadingList: true });
        }
        // 变更后的主动刷新绝不与先前的页码夹紧跳过键抵消。
        followUpSkipKey = null;
        const loadPromise: Promise<void> = get().loadCurrentList(silentRefresh);
        if (willSwitchKind) {
          // 同步登记一次去重键，避免 React 订阅 kind 切换后的 useEffect 紧随再发一次重复 GET。
          followUpSkipKey = buildCurrentListKey(get());
        }
        await loadPromise;
      };

      const previewSlice: MiniAppAdBlacklistsPreviewSlice =
        createAdBlacklistsPreviewSlice({
          set,
          get,
          notify,
        });

      const mutationActions: MiniAppAdBlacklistsMutationActions =
        createAdBlacklistsMutations({
          set,
          get,
          notify,
          refreshAfterMutation,
        });

      return {
        ...previewSlice,
        ...mutationActions,
        kind: "sticker",
        searchInput: "",
        debouncedQuery: "",
        addFormOpen: false,
        addPackInput: "",
        noticeBanner: null,
        loadingList: true,
        busyAction: false,
        stickerPageNumber: 1,
        stickerPageSize: MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE,
        stickerPage: null,
        emojiPageNumber: 1,
        emojiPageSize: MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE,
        emojiPage: null,
        stickerTotal: 0,
        emojiTotal: 0,

        loadCurrentList: async (silent: boolean = false): Promise<void> => {
          const snapshot: MiniAppAdBlacklistsStoreState = get();
          const {
            kind,
            debouncedQuery,
            stickerPageNumber,
            stickerPageSize,
            emojiPageNumber,
            emojiPageSize,
          }: MiniAppAdBlacklistsStoreState = snapshot;
          const currentPageNumber: number =
            kind === "sticker" ? stickerPageNumber : emojiPageNumber;
          const currentPageSize: number =
            kind === "sticker" ? stickerPageSize : emojiPageSize;
          const currentKey: string = buildCurrentListKey(snapshot);
          if (followUpSkipKey !== null) {
            const skipKey: string = followUpSkipKey;
            followUpSkipKey = null;
            if (skipKey === currentKey) {
              return;
            }
          }
          const reqId: number = ++requestSeq;
          const startedAt: number = Date.now();
          if (!silent) {
            set({ loadingList: true });
          }
          try {
            const page: MiniAppAdBlacklistsResponse =
              await fetchMiniAppAdBlacklists({
                kind,
                page: currentPageNumber,
                pageSize: currentPageSize,
                query: debouncedQuery,
              });
            if (!silent) {
              await waitMinimumLoadingDuration(startedAt);
            }
            if (reqId !== requestSeq) {
              return;
            }
            const pagePatch: Partial<MiniAppAdBlacklistsStoreState> =
              kind === "sticker"
                ? {
                  stickerPage: page,
                  ...(page.page !== currentPageNumber
                    ? { stickerPageNumber: page.page }
                    : {}),
                }
                : {
                  emojiPage: page,
                  ...(page.page !== currentPageNumber
                    ? { emojiPageNumber: page.page }
                    : {}),
                };
            if (page.page !== currentPageNumber) {
              followUpSkipKey =
                `${kind}:${page.page}:${currentPageSize}:${debouncedQuery}`;
            }
            set({
              ...pagePatch,
              stickerTotal: page.stickerTotal,
              emojiTotal: page.emojiTotal,
            });
          } catch (error: unknown) {
            if (!silent) {
              await waitMinimumLoadingDuration(startedAt);
            }
            if (reqId !== requestSeq) {
              notifyMiniAppIfAuthError(error);
              return;
            }
            notify(errorMessage(error), "danger", error);
          } finally {
            if (reqId === requestSeq && get().loadingList) {
              set({ loadingList: false });
            }
          }
        },

        selectKind: (nextKind: MiniAppAdBlacklistKind): void => {
          if (get().kind === nextKind) {
            return;
          }
          if (get().previewTarget !== null) {
            get().closePreview();
          }
          set({ kind: nextKind, noticeBanner: null });
        },

        setSearchInput: (value: string): void => {
          set({ searchInput: value });
        },

        commitSearchQuery: (query: string): void => {
          const normalized: string = query
            .trim()
            .slice(0, MINI_APP_AD_BLACKLIST_QUERY_MAX_LENGTH);
          if (get().debouncedQuery === normalized) {
            return;
          }
          set({
            stickerPageNumber: 1,
            emojiPageNumber: 1,
            debouncedQuery: normalized,
          });
        },

        clearSearch: (): void => {
          const current: MiniAppAdBlacklistsStoreState = get();
          if (current.debouncedQuery.length > 0) {
            set({
              searchInput: "",
              debouncedQuery: "",
              stickerPageNumber: 1,
              emojiPageNumber: 1,
            });
            return;
          }
          set({ searchInput: "" });
        },

        toggleAddForm: (): void => {
          set({ addFormOpen: !get().addFormOpen });
        },

        setAddPackInput: (value: string): void => {
          set({ addPackInput: value });
        },

        dismissNoticeBanner: (): void => {
          set({ noticeBanner: null });
        },

        setPageNumber: (page: number): void => {
          if (get().kind === "sticker") {
            set({ stickerPageNumber: page });
            return;
          }
          set({ emojiPageNumber: page });
        },

        setPageSize: (pageSize: number): void => {
          if (get().kind === "sticker") {
            set({ stickerPageNumber: 1, stickerPageSize: pageSize });
            return;
          }
          set({ emojiPageNumber: 1, emojiPageSize: pageSize });
        },
      };
    }
  );
}
