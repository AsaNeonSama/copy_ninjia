import { createStore } from "zustand";
import type { StoreApi } from "zustand";
import { updateMiniAppWhitelistPermission } from "../api/permission";
import { errorMessage } from "../libs/errorMessage";
import { waitMinimumLoadingDuration } from "../libs/loading";
import type { WhitelistPermissionKey } from "../types/identityPolicy";
import type { MiniAppIdentityMutationResult } from "../types/miniApp";
import { useMiniAppStore } from "./app";

/** `PermissionDrawer` 白名单权限抽屉的状态与动作接口。 */
export interface MiniAppPermissionDrawerStoreState {
  /** 正在提交的权限键或 `"all"`（无提交时为 `null`）。 */
  readonly busyKey: WhitelistPermissionKey | "all" | null;

  /** 修改条目的单项权限或一键开启全部权限，保持最短骨架动画展示时长，成功后以 Toast 回报并等待父组件静默重载白名单。 */
  readonly togglePermission: (
    entryId: number,
    permission: WhitelistPermissionKey | "all",
    enabled: boolean
  ) => Promise<void>;
}

/** 一个 `PermissionDrawer` 实例独占的状态仓库。 */
export type MiniAppPermissionDrawerStore = StoreApi<MiniAppPermissionDrawerStoreState>;

/**
 * 创建 `PermissionDrawer` 的状态仓库；抽屉展开时创建、收起即丢弃，生命周期与组件实例一致。
 *
 * @param onUpdated 权限变更成功后的回调（父组件静默重载白名单）
 * @returns 新的权限抽屉仓库
 */
export function createPermissionDrawerStore(
  onUpdated: () => Promise<void> | void
): MiniAppPermissionDrawerStore {
  return createStore<MiniAppPermissionDrawerStoreState>()(
    (
      set: (partial: Partial<MiniAppPermissionDrawerStoreState>) => void
    ): MiniAppPermissionDrawerStoreState => ({
      busyKey: null,

      togglePermission: async (
        entryId: number,
        permission: WhitelistPermissionKey | "all",
        enabled: boolean
      ): Promise<void> => {
        const startedAt: number = Date.now();
        set({ busyKey: permission });
        try {
          const result: MiniAppIdentityMutationResult = await updateMiniAppWhitelistPermission(
            entryId,
            permission,
            enabled
          );
          await waitMinimumLoadingDuration(startedAt);
          const isUnchanged: boolean =
            result.changed === false ||
            result.message === "ALL_PERMISSIONS_UNCHANGED" ||
            result.message === "PERMISSION_UNCHANGED";
          useMiniAppStore.getState().notify(
            result.message,
            isUnchanged ? "warning" : "info",
            result
          );
          if (!isUnchanged) {
            await onUpdated();
          }
        } catch (error: unknown) {
          await waitMinimumLoadingDuration(startedAt);
          const message: string = errorMessage(error);
          useMiniAppStore.getState().notify(message, "danger", error);
        } finally {
          set({ busyKey: null });
        }
      },
    })
  );
}
