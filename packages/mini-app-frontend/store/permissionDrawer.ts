import { createStore } from "zustand";
import type { StoreApi } from "zustand";
import { updateMiniAppWhitelistPermission } from "../api/permission";
import { errorMessage } from "../libs/errorMessage";
import type { WhitelistPermissionKey } from "../types/identityPolicy";
import type { MiniAppIdentityMutationResult } from "../types/miniApp";
import { useMiniAppStore } from "./app";

/** `PermissionDrawer` 白名单权限抽屉的状态与动作接口。 */
export interface MiniAppPermissionDrawerStoreState {
  /** 正在提交的权限键或 `"all"`（无提交时为 `null`）。 */
  readonly busyKey: WhitelistPermissionKey | "all" | null;

  /** 修改条目的单项权限或一键开启全部权限，成功后以 Toast 回报并通知父组件重载白名单。 */
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
 * @param onUpdated 权限变更成功后的回调（父组件重载白名单）
 * @returns 新的权限抽屉仓库
 */
export function createPermissionDrawerStore(
  onUpdated: () => void
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
        set({ busyKey: permission });
        try {
          const result: MiniAppIdentityMutationResult = await updateMiniAppWhitelistPermission(
            entryId,
            permission,
            enabled
          );
          useMiniAppStore.getState().notify(result.message);
          onUpdated();
        } catch (error: unknown) {
          const message: string = errorMessage(error);
          useMiniAppStore.getState().notify(message);
        } finally {
          set({ busyKey: null });
        }
      },
    })
  );
}
