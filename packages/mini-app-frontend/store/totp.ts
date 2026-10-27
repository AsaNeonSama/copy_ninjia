import { createStore } from "zustand";
import type { StoreApi } from "zustand";
import { deleteMiniAppTotp } from "../api/totpDelete";
import { enableMiniAppTotp } from "../api/totpEnable";
import { setupMiniAppTotp } from "../api/totpSetup";
import { fetchMiniAppTotpStatus } from "../api/totpStatus";
import { getMiniAppTranslations } from "../i18n";
import { errorMessage } from "../libs/errorMessage";
import { waitMinimumLoadingDuration } from "../libs/loading";
import type {
  MiniAppTotpMutationResponse,
  MiniAppTotpSetupResponse,
  MiniAppTotpStatusView,
} from "../types/miniAppTotp";
import { useMiniAppStore } from "./app";

/** `TotpPage` 验证器管理的状态与动作接口。 */
export interface MiniAppTotpStoreState {
  /** 最近一次拉取的验证器状态摘要。 */
  readonly totpStatus: Readonly<MiniAppTotpStatusView> | null;
  /** 待确认绑定的新密钥与二维码（未在绑定流程中时为 `null`）。 */
  readonly setupData: Readonly<MiniAppTotpSetupResponse> | null;
  /** 6 位动态码输入框当前值。 */
  readonly codeInput: string;
  /** 是否有生成、绑定或删除操作在进行。 */
  readonly busy: boolean;
  /** 是否正在拉取验证器状态。 */
  readonly loadingStatus: boolean;

  /** 拉取验证器状态并同步根 store 的登录模式；只采纳最后一次发起的请求结果，失败时保持静默。 */
  readonly loadTotpStatus: () => Promise<void>;
  /** 生成新的待确认密钥与二维码，进入绑定流程。 */
  readonly startSetup: () => Promise<void>;
  /** 更新动态码输入框（调用方先过滤为最多 6 位数字）。 */
  readonly setCodeInput: (value: string) => void;
  /** 退出绑定流程并清空输入。 */
  readonly cancelSetup: () => void;
  /** 校验 6 位动态码并激活或替换验证器，成功后同步根 store 的登录模式。 */
  readonly verifyEnable: () => Promise<void>;
  /** 确认后删除验证器并恢复密码登录。 */
  readonly deleteTotp: () => Promise<void>;
}

/** 一个 `TotpPage` 实例独占的状态仓库。 */
export type MiniAppTotpStore = StoreApi<MiniAppTotpStoreState>;

/**
 * 创建 `TotpPage` 的状态仓库；组件挂载时创建、卸载即丢弃，生命周期与组件实例一致。
 *
 * @returns 新的验证器管理仓库
 */
export function createTotpStore(): MiniAppTotpStore {
  return createStore<MiniAppTotpStoreState>()(
    (
      set: (partial: Partial<MiniAppTotpStoreState>) => void,
      get: () => MiniAppTotpStoreState
    ): MiniAppTotpStoreState => {
      let requestSeq: number = 0;

      return {
        totpStatus: null,
        setupData: null,
        codeInput: "",
        busy: false,
        loadingStatus: true,

        loadTotpStatus: async (): Promise<void> => {
          const reqId: number = ++requestSeq;
          const startedAt: number = Date.now();
          set({ loadingStatus: true });
          try {
            const next: Readonly<MiniAppTotpStatusView> =
              await fetchMiniAppTotpStatus();
            await waitMinimumLoadingDuration(startedAt);
            if (reqId !== requestSeq) {
              return;
            }
            set({ totpStatus: next });
            useMiniAppStore
              .getState()
              .setAuthMode(next.enabled ? "totp" : "password");
          } catch (_error: unknown) {
            await waitMinimumLoadingDuration(startedAt);
            // 保持静默，由主状态轮询统一处理网络或会话错误
          } finally {
            if (reqId === requestSeq) {
              set({ loadingStatus: false });
            }
          }
        },

        startSetup: async (): Promise<void> => {
          set({ busy: true });
          try {
            const res: Readonly<MiniAppTotpSetupResponse> = await setupMiniAppTotp();
            set({ setupData: res, codeInput: "" });
          } catch (error: unknown) {
            useMiniAppStore.getState().notify(errorMessage(error), "info", error);
          } finally {
            set({ busy: false });
          }
        },

        setCodeInput: (value: string): void => {
          set({ codeInput: value });
        },

        cancelSetup: (): void => {
          set({ setupData: null, codeInput: "" });
        },

        verifyEnable: async (): Promise<void> => {
          const trimmed: string = get().codeInput.trim();
          if (!/^\d{6}$/u.test(trimmed)) {
            useMiniAppStore.getState().notify(
              getMiniAppTranslations(useMiniAppStore.getState().language).gate.totpEmptyHint
            );
            return;
          }
          set({ busy: true });
          try {
            const res: Readonly<MiniAppTotpMutationResponse> =
              await enableMiniAppTotp(trimmed);
            const skeletonStartedAt: number = Date.now();
            set({
              setupData: null,
              codeInput: "",
              totpStatus: null,
              loadingStatus: true,
            });
            await waitMinimumLoadingDuration(skeletonStartedAt);
            set({ totpStatus: res.status, loadingStatus: false, busy: false });
            useMiniAppStore
              .getState()
              .setAuthMode(res.status.enabled ? "totp" : "password");
            useMiniAppStore.getState().notify(res.message, "info", res);
          } catch (error: unknown) {
            set({ busy: false, loadingStatus: false });
            useMiniAppStore.getState().notify(errorMessage(error), "info", error);
          } finally {
            if (get().busy || get().loadingStatus) {
              set({ busy: false, loadingStatus: false });
            }
          }
        },

        deleteTotp: async (): Promise<void> => {
          const confirmed: boolean = await useMiniAppStore
            .getState()
            .requestConfirm(
              getMiniAppTranslations(useMiniAppStore.getState().language).totp.confirmDeleteTotp,
              "danger"
            );
          if (!confirmed) return;
          const prevStatus: Readonly<MiniAppTotpStatusView> | null = get().totpStatus;
          const startedAt: number = Date.now();
          set({ busy: true, loadingStatus: true, totpStatus: null });
          try {
            const res: Readonly<MiniAppTotpMutationResponse> =
              await deleteMiniAppTotp();
            await waitMinimumLoadingDuration(startedAt);
            set({
              totpStatus: res.status,
              setupData: null,
              codeInput: "",
              busy: false,
              loadingStatus: false,
            });
            useMiniAppStore.getState().setAuthMode("password");
            useMiniAppStore.getState().notify(res.message, "info", res);
          } catch (error: unknown) {
            await waitMinimumLoadingDuration(startedAt);
            set({ totpStatus: prevStatus, busy: false, loadingStatus: false });
            useMiniAppStore.getState().notify(errorMessage(error), "info", error);
          } finally {
            if (get().busy || get().loadingStatus) {
              set({ busy: false, loadingStatus: false });
            }
          }
        },
      };
    }
  );
}
