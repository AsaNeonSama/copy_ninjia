import { createStore } from "zustand";
import type { StoreApi } from "zustand";
import { fetchMiniAppBlocklist } from "../api/blocklist";
import { requestMiniAppPreparedPicker } from "../api/pickerPrepare";
import { fetchMiniAppWhitelist } from "../api/whitelist";
import { MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE } from "../consts/miniApp/ui";
import { getMiniAppTranslations } from "../i18n";
import { errorMessage } from "../libs/errorMessage";
import { waitMinimumLoadingDuration } from "../libs/loading";
import type {
  MiniAppBlocklistEntryView,
  MiniAppBlocklistPage,
  MiniAppIdentityAddMode,
  MiniAppIdentityMutationResult,
  MiniAppIdentitySubTabKey,
  MiniAppPickerResultEvent,
  MiniAppPickerSubjectKind,
  MiniAppWhitelistEntryView,
  MiniAppWhitelistPage,
  PrepareMiniAppPickerResult,
} from "../types/miniApp/identities";
import { notifyMiniAppIfAuthError, useMiniAppStore } from "./app";
import { createIdentitiesMutations } from "./identitiesMutations";
import {
  createMiniAppNativePickerController,
  resolveNativePickerWebApp,
} from "./nativePicker";
import type {
  MiniAppNativePickerController,
  NativePickerCapableWebApp,
} from "./nativePicker";

/** `IdentitiesPage` 黑白名单管理的状态与动作接口。 */
export interface MiniAppIdentitiesStoreState {
  /** 当前子标签（白名单或黑名单）。 */
  readonly subTab: MiniAppIdentitySubTabKey;
  /** 搜索输入框当前值。 */
  readonly searchInput: string;
  /** 防抖生效后的搜索关键字（参与列表请求）。 */
  readonly debouncedQuery: string;
  /** 折叠式添加菜单是否展开。 */
  readonly addMenuOpen: boolean;
  /** 按 ID 添加的内联表单是否展开。 */
  readonly idFormOpen: boolean;
  /** 按 ID 添加输入框当前值。 */
  readonly idInput: string;
  /** 重复添加拦截横幅文案（未拦截时为 `null`）。 */
  readonly duplicateAlertText: string | null;
  /** 是否有名单写操作或选择器准备在进行。 */
  readonly busyAction: boolean;
  /** 正在预备 Telegram 原生选择器的模式键（`"users"` 或 `"channel"`；未预备时为 `null`）。 */
  readonly preparingPickerMode: MiniAppPickerSubjectKind | null;
  /** 是否正在加载当前子标签的列表。 */
  readonly loadingList: boolean;
  /** 白名单当前请求页码。 */
  readonly whitelistPageNumber: number;
  /** 白名单每页条数。 */
  readonly whitelistPageSize: number;
  /** 最近一次成功拉取的白名单分页。 */
  readonly whitelistPage: MiniAppWhitelistPage | null;
  /** 展开权限抽屉的白名单条目 ID（未展开时为 `null`）。 */
  readonly selectedEntryId: number | null;
  /** 黑名单当前请求页码。 */
  readonly blocklistPageNumber: number;
  /** 黑名单每页条数。 */
  readonly blocklistPageSize: number;
  /** 最近一次成功拉取的黑名单分页。 */
  readonly blocklistPage: MiniAppBlocklistPage | null;
  /** 最近一次列表响应携带的白名单总条数。 */
  readonly whitelistTotal: number;
  /** 最近一次列表响应携带的黑名单总条数。 */
  readonly blocklistTotal: number;

  /**
   * 按当前子标签、页码、每页条数与防抖关键字拉取列表，只采纳最后一次请求结果并在服务端夹紧页码时同步页码。
   * 传 `silent = true` 时不置 `loadingList: true`，保留现有列表与展开抽屉原位更新。
   */
  readonly loadCurrentList: (silent?: boolean) => Promise<void>;
  /** 切换子标签并收起权限抽屉与重复拦截横幅。 */
  readonly selectSubTab: (tab: MiniAppIdentitySubTabKey) => void;
  /** 更新搜索输入框。 */
  readonly setSearchInput: (value: string) => void;
  /** 防抖到期时提交搜索关键字；关键字变化时两张名单都回到第 1 页。 */
  readonly commitSearchQuery: (query: string) => void;
  /** 清空搜索输入与已生效关键字（不重置页码）。 */
  readonly clearSearch: () => void;
  /** 展开或收起折叠式添加菜单。 */
  readonly toggleAddMenu: () => void;
  /** 选择添加方式：按 ID 时展开或收起内联表单，按联系人或频道时打开 Telegram 原生选择器。 */
  readonly selectAddMode: (mode: MiniAppIdentityAddMode) => void;
  /** 收起按 ID 添加的内联表单。 */
  readonly closeIdForm: () => void;
  /** 更新按 ID 添加输入框。 */
  readonly setIdInput: (value: string) => void;
  /** 关闭重复添加拦截横幅。 */
  readonly dismissDuplicateAlert: () => void;
  /**
   * 按输入的 ID 加入当前子标签名单：当前页已存在或服务端判重时展示拦截横幅与提示；
   * 新增成功时关闭添加面板并静默刷新列表（白名单新增后同步展开该条目的权限抽屉）。
   */
  readonly addById: () => Promise<void>;
  /** 确认后将条目移出白名单（已有分页数据时静默刷新列表并收起对应权限抽屉）。 */
  readonly removeWhitelist: (entry: Readonly<MiniAppWhitelistEntryView>) => Promise<void>;
  /** 确认后将条目移出黑名单（已有分页数据时静默刷新列表）。 */
  readonly removeBlocklist: (entry: Readonly<MiniAppBlocklistEntryView>) => Promise<void>;
  /** 展开或收起指定白名单条目的权限抽屉。 */
  readonly togglePermissionDrawer: (entryId: number) => void;
  /** 收起权限抽屉。 */
  readonly closePermissionDrawer: () => void;
  /** 切换白名单页码。 */
  readonly setWhitelistPageNumber: (page: number) => void;
  /** 切换白名单每页条数并回到第 1 页。 */
  readonly setWhitelistPageSize: (pageSize: number) => void;
  /** 切换黑名单页码。 */
  readonly setBlocklistPageNumber: (page: number) => void;
  /** 切换黑名单每页条数并回到第 1 页。 */
  readonly setBlocklistPageSize: (pageSize: number) => void;
  /** 中止未完成的 Telegram 原生选择器结果轮询并作废未触发的选择器回调（供页面卸载清理使用）。 */
  readonly cancelPendingPicker: () => void;
}

/** 一个 `IdentitiesPage` 实例独占的状态仓库。 */
export type MiniAppIdentitiesStore = StoreApi<MiniAppIdentitiesStoreState>;

/**
 * 创建 `IdentitiesPage` 的状态仓库；组件挂载时创建、卸载即丢弃，生命周期与组件实例一致。
 *
 * @returns 新的黑白名单管理仓库
 */
export function createIdentitiesStore(): MiniAppIdentitiesStore {
  return createStore<MiniAppIdentitiesStoreState>()(
    (
      set: (partial: Partial<MiniAppIdentitiesStoreState>) => void,
      get: () => MiniAppIdentitiesStoreState
    ): MiniAppIdentitiesStoreState => {
      let requestSeq: number = 0;
      let clampedFollowUpKey: string | null = null;
      const pickerController: MiniAppNativePickerController =
        createMiniAppNativePickerController();

      const notify = (
        message: string,
        tone?: "warning" | "danger",
        metaSource?: unknown
      ): void => {
        useMiniAppStore.getState().notify(message, tone, metaSource);
      };

      /**
       * 展示重复添加的常驻提示；提供服务端结果时 Toast 改为翻译该结果（黑名单重复添加会附带重新跨群封禁计数与落盘确认状态）。
       */
      const triggerDuplicateNotice = (
        alertText: string,
        serverResult?: Readonly<MiniAppIdentityMutationResult>
      ): void => {
        set({ duplicateAlertText: alertText });
        if (serverResult !== undefined) {
          notify(serverResult.message, "warning", serverResult);
          return;
        }
        notify(alertText, "warning");
      };

      const handlePickerResult = async (
        outcome: Readonly<MiniAppPickerResultEvent>,
        list: MiniAppIdentitySubTabKey
      ): Promise<void> => {
        set(
          list === "whitelist"
            ? { whitelistPage: null, loadingList: true }
            : { blocklistPage: null, loadingList: true }
        );
        await get().loadCurrentList();
        const addedCount: number = outcome.addedIds?.length ?? 0;
        if (
          addedCount === 0 &&
          outcome.duplicateIds !== undefined &&
          outcome.duplicateIds.length > 0 &&
          (outcome.summary === "PICKER_IMPORT_DUPLICATE" ||
            outcome.summary === "dup")
        ) {
          triggerDuplicateNotice(
            getMiniAppTranslations(useMiniAppStore.getState().language).identities.duplicateToast(
              outcome.duplicateIds.map((dupId: number): string => `ID ${dupId}`).join(", "),
              list
            )
          );
        } else {
          notify(
            outcome.summary,
            addedCount > 0 ? undefined : "warning",
            outcome
          );
        }
      };

      const openPicker = async (subjectKind: MiniAppPickerSubjectKind): Promise<void> => {
        const webApp: NativePickerCapableWebApp | null = resolveNativePickerWebApp();
        if (webApp === null) {
          return;
        }
        const list: MiniAppIdentitySubTabKey = get().subTab;
        const prepareEpoch: number = pickerController.captureEpoch();
        set({ busyAction: true, preparingPickerMode: subjectKind });
        try {
          const prepared: Extract<PrepareMiniAppPickerResult, { readonly ok: true }> =
            await requestMiniAppPreparedPicker(list, subjectKind);
          set({ addMenuOpen: false, idFormOpen: false });
          pickerController.launch({
            webApp,
            preparedButtonId: prepared.preparedButtonId,
            requestId: prepared.requestId,
            expectedEpoch: prepareEpoch,
            onResult: (outcome: Readonly<MiniAppPickerResultEvent>): Promise<void> =>
              handlePickerResult(outcome, list),
          });
        } catch (error: unknown) {
          notify(errorMessage(error), undefined, error);
        } finally {
          set({ busyAction: false, preparingPickerMode: null });
        }
      };

      return {
        subTab: "whitelist",
        searchInput: "",
        debouncedQuery: "",
        addMenuOpen: false,
        idFormOpen: false,
        idInput: "",
        duplicateAlertText: null,
        busyAction: false,
        preparingPickerMode: null,
        loadingList: true,
        whitelistPageNumber: 1,
        whitelistPageSize: MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
        whitelistPage: null,
        selectedEntryId: null,
        blocklistPageNumber: 1,
        blocklistPageSize: MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
        blocklistPage: null,
        whitelistTotal: 0,
        blocklistTotal: 0,

        loadCurrentList: async (silent: boolean = false): Promise<void> => {
          const {
            subTab,
            debouncedQuery,
            whitelistPageNumber,
            whitelistPageSize,
            blocklistPageNumber,
            blocklistPageSize,
          }: MiniAppIdentitiesStoreState = get();
          const currentPageNumber: number =
            subTab === "whitelist" ? whitelistPageNumber : blocklistPageNumber;
          const currentPageSize: number =
            subTab === "whitelist" ? whitelistPageSize : blocklistPageSize;
          const currentKey: string = `${subTab}:${currentPageNumber}:${currentPageSize}:${debouncedQuery}`;
          if (clampedFollowUpKey !== null) {
            const skipKey: string = clampedFollowUpKey;
            clampedFollowUpKey = null;
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
            if (subTab === "whitelist") {
              const page: MiniAppWhitelistPage = await fetchMiniAppWhitelist(
                whitelistPageNumber,
                whitelistPageSize,
                debouncedQuery
              );
              if (!silent) {
                await waitMinimumLoadingDuration(startedAt);
              }
              if (reqId !== requestSeq) {
                return;
              }
              if (page.page !== whitelistPageNumber) {
                clampedFollowUpKey = `whitelist:${page.page}:${whitelistPageSize}:${debouncedQuery}`;
                set({
                  whitelistPage: page,
                  whitelistTotal: page.whitelistTotal,
                  blocklistTotal: page.blocklistTotal,
                  whitelistPageNumber: page.page,
                });
              } else {
                set({
                  whitelistPage: page,
                  whitelistTotal: page.whitelistTotal,
                  blocklistTotal: page.blocklistTotal,
                });
              }
            } else {
              const page: MiniAppBlocklistPage = await fetchMiniAppBlocklist(
                blocklistPageNumber,
                blocklistPageSize,
                debouncedQuery
              );
              if (!silent) {
                await waitMinimumLoadingDuration(startedAt);
              }
              if (reqId !== requestSeq) {
                return;
              }
              if (page.page !== blocklistPageNumber) {
                clampedFollowUpKey = `blocklist:${page.page}:${blocklistPageSize}:${debouncedQuery}`;
                set({
                  blocklistPage: page,
                  whitelistTotal: page.whitelistTotal,
                  blocklistTotal: page.blocklistTotal,
                  blocklistPageNumber: page.page,
                });
              } else {
                set({
                  blocklistPage: page,
                  whitelistTotal: page.whitelistTotal,
                  blocklistTotal: page.blocklistTotal,
                });
              }
            }
          } catch (error: unknown) {
            if (!silent) {
              await waitMinimumLoadingDuration(startedAt);
            }
            if (reqId !== requestSeq) {
              notifyMiniAppIfAuthError(error);
              return;
            }
            notify(errorMessage(error), undefined, error);
          } finally {
            if (reqId === requestSeq && get().loadingList) {
              set({ loadingList: false });
            }
          }
        },

        selectSubTab: (tab: MiniAppIdentitySubTabKey): void => {
          set({ subTab: tab, selectedEntryId: null, duplicateAlertText: null });
        },

        setSearchInput: (value: string): void => {
          set({ searchInput: value });
        },

        commitSearchQuery: (query: string): void => {
          if (get().debouncedQuery === query) {
            return;
          }
          set({
            whitelistPageNumber: 1,
            blocklistPageNumber: 1,
            debouncedQuery: query,
          });
        },

        clearSearch: (): void => {
          set({ searchInput: "", debouncedQuery: "" });
        },

        toggleAddMenu: (): void => {
          set({ addMenuOpen: !get().addMenuOpen });
        },

        selectAddMode: (mode: MiniAppIdentityAddMode): void => {
          if (mode === "id") {
            set({ idFormOpen: !get().idFormOpen });
            return;
          }
          void openPicker(mode);
        },

        closeIdForm: (): void => {
          set({ idFormOpen: false });
        },

        setIdInput: (value: string): void => {
          set({ idInput: value });
        },

        dismissDuplicateAlert: (): void => {
          set({ duplicateAlertText: null });
        },

        ...createIdentitiesMutations({
          set,
          get,
          notify,
          triggerDuplicateNotice,
        }),

        togglePermissionDrawer: (entryId: number): void => {
          set({ selectedEntryId: get().selectedEntryId === entryId ? null : entryId });
        },

        closePermissionDrawer: (): void => {
          set({ selectedEntryId: null });
        },

        setWhitelistPageNumber: (page: number): void => {
          set({ whitelistPageNumber: page });
        },

        setWhitelistPageSize: (pageSize: number): void => {
          set({ whitelistPageNumber: 1, whitelistPageSize: pageSize });
        },

        setBlocklistPageNumber: (page: number): void => {
          set({ blocklistPageNumber: page });
        },

        setBlocklistPageSize: (pageSize: number): void => {
          set({ blocklistPageNumber: 1, blocklistPageSize: pageSize });
        },

        cancelPendingPicker: (): void => {
          pickerController.cancel();
        },
      };
    }
  );
}
