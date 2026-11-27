import { setMiniAppBlocklistMembership } from "../api/blocklistMembership";
import { setMiniAppWhitelistMembership } from "../api/whitelistMembership";
import { MINI_APP_SIGNED_INTEGER_PATTERN } from "../consts/miniApp/auth";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { errorMessage } from "../libs/errorMessage";
import { truncateDisplayText } from "../libs/formatters";
import type {
  MiniAppBlocklistEntryView,
  MiniAppIdentityMutationResult,
  MiniAppWhitelistEntryView,
} from "../types/miniApp/identities";
import { useMiniAppStore } from "./app";
import type { MiniAppUiStoreState } from "./app";
import type { MiniAppIdentitiesStoreState } from "./identities";

/** 构造黑白名单按 ID 新增与条目移除子动作所需的仓库读写句柄。 */
export interface CreateIdentitiesMutationsOptions {
  /** 更新 `MiniAppIdentitiesStoreState` 的局部字段。 */
  readonly set: (partial: Partial<MiniAppIdentitiesStoreState>) => void;
  /** 读取当前 `MiniAppIdentitiesStoreState` 快照。 */
  readonly get: () => MiniAppIdentitiesStoreState;
  /** 派发全局 Toast 通知（透传元数据用于鉴权归类与多语言插值）。 */
  readonly notify: (
    message: string,
    tone?: "warning" | "danger",
    metaSource?: unknown
  ) => void;
  /** 展示重复添加的常驻拦截横幅与 Toast 提示。 */
  readonly triggerDuplicateNotice: (
    alertText: string,
    serverResult?: Readonly<MiniAppIdentityMutationResult>
  ) => void;
}

/** 黑白名单的按 ID 添加与移出名单动作集合。 */
export type MiniAppIdentitiesMutationActions = Pick<
  MiniAppIdentitiesStoreState,
  "addById" | "removeWhitelist" | "removeBlocklist"
>;

/**
 * 创建 `IdentitiesPage` 黑白名单仓库的按 ID 新增、移出白名单与移出黑名单子动作集合。
 *
 * @param options 仓库读写句柄与通知回调
 * @returns 绑定到当前名单仓库的增删动作集合
 */
export function createIdentitiesMutations({
  set,
  get,
  notify,
  triggerDuplicateNotice,
}: CreateIdentitiesMutationsOptions): MiniAppIdentitiesMutationActions {
  return {
    addById: async (): Promise<void> => {
      const { idInput, subTab, busyAction }: MiniAppIdentitiesStoreState = get();
      if (busyAction) return;
      const t: Readonly<MiniAppTranslations> =
        getMiniAppTranslations(useMiniAppStore.getState().language);
      const trimmed: string = idInput.trim();
      const id: number = Number(trimmed);
      if (
        !MINI_APP_SIGNED_INTEGER_PATTERN.test(trimmed) ||
        !Number.isSafeInteger(id) ||
        id === 0
      ) {
        notify(t.identities.invalidIdToast, "warning");
        return;
      }

      set({ busyAction: true });
      try {
        const result: MiniAppIdentityMutationResult =
          subTab === "whitelist"
            ? await setMiniAppWhitelistMembership(id, true)
            : await setMiniAppBlocklistMembership(id, true);

        if (result.duplicate === true || (result.ok && !result.changed)) {
          triggerDuplicateNotice(
            t.identities.duplicateToast(`ID ${id}`, subTab),
            subTab === "blocklist" ? result : undefined
          );
          return;
        }

        if (!result.ok) {
          notify(result.message, "danger", result);
          return;
        }

        const latestState: MiniAppIdentitiesStoreState = get();
        const silentRefresh: boolean =
          latestState.subTab === "whitelist"
            ? latestState.whitelistPage !== null
            : latestState.blocklistPage !== null;
        if (subTab === "whitelist" && latestState.subTab === "whitelist") {
          set({
            duplicateAlertText: null,
            selectedEntryId: id,
            idInput: "",
            idFormOpen: false,
            addMenuOpen: false,
            ...(silentRefresh ? {} : { loadingList: true }),
          });
        } else {
          set({
            duplicateAlertText: null,
            idInput: "",
            idFormOpen: false,
            addMenuOpen: false,
            ...(silentRefresh ? {} : { loadingList: true }),
          });
        }
        await get().loadCurrentList(silentRefresh);
        notify(result.message, undefined, result);
      } catch (error: unknown) {
        notify(errorMessage(error), "danger", error);
      } finally {
        set({ busyAction: false });
      }
    },

    removeWhitelist: async (entry: Readonly<MiniAppWhitelistEntryView>): Promise<void> => {
      if (get().busyAction) return;
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
      if (get().busyAction) return;
      set({ busyAction: true });
      try {
        const result: MiniAppIdentityMutationResult =
          await setMiniAppWhitelistMembership(entry.id, false);
        const silentRefresh: boolean = get().whitelistPage !== null;
        if (get().selectedEntryId === entry.id) {
          set({ selectedEntryId: null });
        }
        if (!silentRefresh) {
          set({ loadingList: true });
        }
        await get().loadCurrentList(silentRefresh);
        notify(result.message, result.changed ? undefined : "warning", result);
      } catch (error: unknown) {
        notify(errorMessage(error), "danger", error);
      } finally {
        set({ busyAction: false });
      }
    },

    removeBlocklist: async (entry: Readonly<MiniAppBlocklistEntryView>): Promise<void> => {
      if (get().busyAction) return;
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
      if (get().busyAction) return;
      set({ busyAction: true });
      try {
        const result: MiniAppIdentityMutationResult =
          await setMiniAppBlocklistMembership(entry.id, false);
        const silentRefresh: boolean = get().blocklistPage !== null;
        if (!silentRefresh) {
          set({ loadingList: true });
        }
        await get().loadCurrentList(silentRefresh);
        notify(result.message, result.changed ? undefined : "warning", result);
      } catch (error: unknown) {
        notify(errorMessage(error), "danger", error);
      } finally {
        set({ busyAction: false });
      }
    },
  };
}
