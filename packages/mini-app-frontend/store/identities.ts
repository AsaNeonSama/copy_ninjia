import { createStore } from "zustand";
import type { StoreApi } from "zustand";
import { fetchMiniAppBlocklist } from "../api/blocklist";
import { setMiniAppBlocklistMembership } from "../api/blocklistMembership";
import { requestMiniAppPreparedPicker } from "../api/pickerPrepare";
import { waitForMiniAppPickerResult } from "../api/pickerResult";
import { fetchMiniAppWhitelist } from "../api/whitelist";
import { setMiniAppWhitelistMembership } from "../api/whitelistMembership";
import { MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE } from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { errorMessage } from "../libs/errorMessage";
import { truncateDisplayText } from "../libs/formatters";
import { waitMinimumLoadingDuration } from "../libs/loading";
import { getTelegramWebApp } from "../libs/telegram";
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
  TelegramWebApp,
} from "../types/miniApp";
import { useMiniAppStore } from "./app";
import type { MiniAppUiStoreState } from "./app";

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

  /** 按当前子标签、页码、每页条数与防抖关键字拉取列表（`silent` 为 `true` 时不置 `loadingList: true` 以保持已展开权限抽屉原位更新）；只采纳最后一次发起的请求结果，服务端夹紧页码时同步当前页码。 */
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
  /** 按输入的 ID 加入当前子标签名单（当前页已有或服务端判重时展示拦截提示）。 */
  readonly addById: () => Promise<void>;
  /** 确认后将条目移出白名单。 */
  readonly removeWhitelist: (entry: Readonly<MiniAppWhitelistEntryView>) => Promise<void>;
  /** 确认后将条目移出黑名单。 */
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

      const notify = (
        message: string,
        tone?: "warning" | "danger",
        metaSource?: unknown
      ): void => {
        useMiniAppStore.getState().notify(message, tone, metaSource);
      };

      const triggerDuplicateNotice = (
        t: Readonly<MiniAppTranslations>,
        idText: string,
        list: MiniAppIdentitySubTabKey
      ): void => {
        const text: string = t.identities.duplicateToast(idText, list);
        set({ duplicateAlertText: text });
        notify(text, "warning");
      };

      const pollPickerSession = async (
        requestId: number,
        list: MiniAppIdentitySubTabKey
      ): Promise<void> => {
        const outcome: Readonly<MiniAppPickerResultEvent> | "failed" | "timeout" =
          await waitForMiniAppPickerResult(requestId);
        if (outcome === "failed") {
          return;
        }
        if (outcome === "timeout") {
          notify(
            getMiniAppTranslations(useMiniAppStore.getState().language).identities
              .pickerTimeoutToast
          );
          return;
        }
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
            getMiniAppTranslations(useMiniAppStore.getState().language),
            outcome.duplicateIds.map((dupId: number): string => `ID ${dupId}`).join(", "),
            list
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
        const t: Readonly<MiniAppTranslations> =
          getMiniAppTranslations(useMiniAppStore.getState().language);
        const webApp: Readonly<TelegramWebApp> | undefined = getTelegramWebApp();
        if (typeof webApp?.requestChat !== "function") {
          notify(t.identities.pickerUnsupportedHint, "warning");
          return;
        }
        const list: MiniAppIdentitySubTabKey = get().subTab;
        set({ busyAction: true });
        try {
          const prepared: Extract<PrepareMiniAppPickerResult, { readonly ok: true }> =
            await requestMiniAppPreparedPicker(list, subjectKind);
          set({ addMenuOpen: false, idFormOpen: false });
          webApp.requestChat(prepared.preparedButtonId, (accepted: boolean): void => {
            const nextT: Readonly<MiniAppTranslations> =
              getMiniAppTranslations(useMiniAppStore.getState().language);
            if (!accepted) {
              notify(nextT.identities.pickerCancelledToast);
              return;
            }
            notify(nextT.identities.pickerWaitingToast);
            void pollPickerSession(prepared.requestId, list);
          });
        } catch (error: unknown) {
          notify(errorMessage(error), undefined, error);
        } finally {
          set({ busyAction: false });
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

        addById: async (): Promise<void> => {
          const { idInput, subTab, whitelistPage, blocklistPage }: MiniAppIdentitiesStoreState = get();
          const t: Readonly<MiniAppTranslations> =
            getMiniAppTranslations(useMiniAppStore.getState().language);
          const trimmed: string = idInput.trim();
          const id: number = Number(trimmed);
          if (trimmed.length === 0 || !Number.isSafeInteger(id) || id === 0) {
            notify(t.identities.invalidIdToast, "warning");
            return;
          }

          const alreadyInCurrentPage: boolean =
            subTab === "whitelist"
              ? (whitelistPage?.items.some(
                (item: Readonly<MiniAppWhitelistEntryView>): boolean => item.id === id
              ) ?? false)
              : (blocklistPage?.items.some(
                (item: Readonly<MiniAppBlocklistEntryView>): boolean => item.id === id
              ) ?? false);
          if (alreadyInCurrentPage) {
            triggerDuplicateNotice(t, `ID ${id}`, subTab);
            return;
          }

          set({ busyAction: true });
          try {
            const result: MiniAppIdentityMutationResult =
              subTab === "whitelist"
                ? await setMiniAppWhitelistMembership(id, true)
                : await setMiniAppBlocklistMembership(id, true);

            if (result.duplicate === true || (result.ok && !result.changed)) {
              triggerDuplicateNotice(t, `ID ${id}`, subTab);
              return;
            }

            if (!result.ok) {
              notify(result.message, "danger", result);
              return;
            }

            set({ duplicateAlertText: null });
            if (subTab === "whitelist") {
              set({ selectedEntryId: id, whitelistPage: null, loadingList: true });
            } else {
              set({ blocklistPage: null, loadingList: true });
            }
            set({ idInput: "", idFormOpen: false, addMenuOpen: false });
            await get().loadCurrentList();
            notify(result.message, undefined, result);
          } catch (error: unknown) {
            notify(errorMessage(error), "danger", error);
          } finally {
            set({ busyAction: false });
          }
        },

        removeWhitelist: async (entry: Readonly<MiniAppWhitelistEntryView>): Promise<void> => {
          const app: MiniAppUiStoreState = useMiniAppStore.getState();
          const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(app.language);
          if (
            !(await app.requestConfirm(
              t.identities.confirmRemoveWhitelist(
                truncateDisplayText(entry.displayName, 20),
                entry.id
              ),
              "danger"
            ))
          ) {
            return;
          }
          set({ busyAction: true });
          try {
            const result: MiniAppIdentityMutationResult =
              await setMiniAppWhitelistMembership(entry.id, false);
            if (get().selectedEntryId === entry.id) set({ selectedEntryId: null });
            set({ whitelistPage: null, loadingList: true });
            await get().loadCurrentList();
            notify(result.message, result.changed ? undefined : "warning", result);
          } catch (error: unknown) {
            notify(errorMessage(error), "danger", error);
          } finally {
            set({ busyAction: false });
          }
        },

        removeBlocklist: async (entry: Readonly<MiniAppBlocklistEntryView>): Promise<void> => {
          const app: MiniAppUiStoreState = useMiniAppStore.getState();
          const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(app.language);
          if (
            !(await app.requestConfirm(
              t.identities.confirmRemoveBlocklist(
                truncateDisplayText(entry.displayName, 20),
                entry.id
              ),
              "danger"
            ))
          ) {
            return;
          }
          set({ busyAction: true });
          try {
            const result: MiniAppIdentityMutationResult =
              await setMiniAppBlocklistMembership(entry.id, false);
            set({ blocklistPage: null, loadingList: true });
            await get().loadCurrentList();
            notify(result.message, result.changed ? undefined : "warning", result);
          } catch (error: unknown) {
            notify(errorMessage(error), "danger", error);
          } finally {
            set({ busyAction: false });
          }
        },

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
      };
    }
  );
}
