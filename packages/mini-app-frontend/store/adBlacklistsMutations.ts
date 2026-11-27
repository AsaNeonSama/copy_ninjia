import { mutateMiniAppAdBlacklist } from "../api/adBlacklists";
import {
  extractServerNoticeParams,
  getMiniAppTranslations,
} from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { parseAdBlacklistPackInput } from "../libs/adBlacklistPackInput";
import type { ParsedAdBlacklistPackInput } from "../libs/adBlacklistPackInput";
import { errorMessage } from "../libs/errorMessage";
import type {
  MiniAppAdBlacklistKind,
  MiniAppAdBlacklistMutationResponse,
} from "../types/miniApp/adBlacklists";
import type { MiniAppServerNoticeParams } from "../types/miniAppI18n";
import { notifyMiniAppIfAuthError, useMiniAppStore } from "./app";
import type { MiniAppToastTone, MiniAppUiStoreState } from "./app";
import type { MiniAppAdBlacklistsStoreState } from "./adBlacklists";

/** 构造内容黑名单新增与移除子动作所需的仓库读写与刷新回调。 */
export interface CreateAdBlacklistsMutationsOptions {
  /** 更新 `MiniAppAdBlacklistsStoreState` 的局部字段。 */
  readonly set: (partial: Partial<MiniAppAdBlacklistsStoreState>) => void;
  /** 读取当前 `MiniAppAdBlacklistsStoreState` 快照。 */
  readonly get: () => MiniAppAdBlacklistsStoreState;
  /** 派发全局 Toast 通知（透传元数据用于鉴权归类与多语言插值）。 */
  readonly notify: (
    message: string,
    tone?: MiniAppToastTone,
    metaSource?: unknown
  ) => void;
  /** 发生实际内存变更后按发起/目标页签刷新列表并避免重复 GET。 */
  readonly refreshAfterMutation: (
    originKind: MiniAppAdBlacklistKind,
    targetKind: MiniAppAdBlacklistKind,
    sameOriginPatch: Partial<MiniAppAdBlacklistsStoreState>
  ) => Promise<void>;
}

/** 内容黑名单的新增与移除子动作集合。 */
export type MiniAppAdBlacklistsMutationActions = Pick<
  MiniAppAdBlacklistsStoreState,
  "addPack" | "removePack"
>;

/**
 * 将服务端返回的内容黑名单变更响应本地化为当前语言的提示正文。
 *
 * @param t 当前语言的翻译字典
 * @param result 服务端返回的变更结果
 * @returns 本地化提示文案
 */
function formatMutationResultText(
  t: Readonly<MiniAppTranslations>,
  result: Readonly<MiniAppAdBlacklistMutationResponse>
): string {
  const params: Readonly<MiniAppServerNoticeParams> = {
    kind: result.kind,
    pack: result.pack,
    changed: result.changed,
    persisted: result.persisted,
  };
  const byCode: string = t.serverNotice(result.code, params);
  if (byCode !== result.code) {
    return byCode;
  }
  return t.serverNotice(result.message, params);
}

/**
 * 创建 `AdBlacklistsPage` 内容黑名单仓库的新增与移除子动作集合。
 *
 * @param options 仓库读写句柄、Toast 通知与变更后刷新回调
 * @returns 绑定到当前内容黑名单仓库的新增与移除动作集合
 */
export function createAdBlacklistsMutations({
  set,
  get,
  notify,
  refreshAfterMutation,
}: CreateAdBlacklistsMutationsOptions): MiniAppAdBlacklistsMutationActions {
  return {
    addPack: async (): Promise<void> => {
      if (get().busyAction) {
        return;
      }
      const { addPackInput, kind: originKind }: MiniAppAdBlacklistsStoreState =
        get();
      const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(
        useMiniAppStore.getState().language
      );
      const parsed: Readonly<ParsedAdBlacklistPackInput> | null =
        parseAdBlacklistPackInput(addPackInput, originKind);
      if (parsed === null) {
        const invalidText: string = t.adBlacklists.invalidPackNotice;
        set({ noticeBanner: { kind: "error", message: invalidText } });
        notify(invalidText, "warning");
        return;
      }
      const targetKind: MiniAppAdBlacklistKind = parsed.kind;
      const pack: string = parsed.pack;

      set({ busyAction: true });
      try {
        const result: MiniAppAdBlacklistMutationResponse =
          await mutateMiniAppAdBlacklist({
            kind: targetKind,
            pack,
            enabled: true,
          });
        const latestT: Readonly<MiniAppTranslations> = getMiniAppTranslations(
          useMiniAppStore.getState().language
        );
        const localizedText: string = formatMutationResultText(
          latestT,
          result
        );

        if (
          result.duplicate === true ||
          result.code === "AD_BLACKLIST_DUPLICATE" ||
          (result.ok && !result.changed)
        ) {
          if (get().kind === originKind) {
            set({
              noticeBanner: { kind: "duplicate", message: localizedText },
            });
          }
          notify(localizedText, "warning", result);
          return;
        }

        if (!result.ok) {
          if (result.changed) {
            await refreshAfterMutation(originKind, targetKind, {
              addPackInput: "",
              noticeBanner: { kind: "error", message: localizedText },
            });
          } else if (get().kind === originKind) {
            set({
              noticeBanner: { kind: "error", message: localizedText },
            });
          }
          notify(localizedText, "danger", result);
          return;
        }

        await refreshAfterMutation(originKind, targetKind, {
          addFormOpen: false,
          addPackInput: "",
          noticeBanner: null,
        });
        notify(
          localizedText,
          result.persisted === false ? "warning" : "info",
          result
        );
      } catch (error: unknown) {
        if (notifyMiniAppIfAuthError(error)) {
          return;
        }
        const latestT: Readonly<MiniAppTranslations> = getMiniAppTranslations(
          useMiniAppStore.getState().language
        );
        const raw: string = errorMessage(error);
        const localized: string = latestT.serverNotice(
          raw,
          extractServerNoticeParams(error)
        );
        if (get().kind === originKind) {
          set({ noticeBanner: { kind: "error", message: localized } });
        }
        notify(raw, "danger", error);
      } finally {
        set({ busyAction: false });
      }
    },

    removePack: async (pack: string): Promise<void> => {
      if (get().busyAction) {
        return;
      }
      const activeKind: MiniAppAdBlacklistKind = get().kind;
      const app: MiniAppUiStoreState = useMiniAppStore.getState();
      const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(
        app.language
      );
      if (
        !(await app.requestConfirm(
          t.adBlacklists.confirmRemovePack(activeKind, pack),
          "danger"
        ))
      ) {
        return;
      }
      if (get().busyAction) {
        return;
      }
      set({ busyAction: true });
      try {
        const result: MiniAppAdBlacklistMutationResponse =
          await mutateMiniAppAdBlacklist({
            kind: activeKind,
            pack,
            enabled: false,
          });
        const latestT: Readonly<MiniAppTranslations> = getMiniAppTranslations(
          useMiniAppStore.getState().language
        );
        const localizedText: string = formatMutationResultText(
          latestT,
          result
        );
        if (!result.ok) {
          if (result.changed) {
            await refreshAfterMutation(activeKind, activeKind, {
              noticeBanner: { kind: "error", message: localizedText },
            });
          } else if (get().kind === activeKind) {
            set({
              noticeBanner: { kind: "error", message: localizedText },
            });
          }
          notify(localizedText, "danger", result);
          return;
        }
        await refreshAfterMutation(activeKind, activeKind, {
          noticeBanner: null,
        });
        notify(
          localizedText,
          result.changed && result.persisted !== false ? "info" : "warning",
          result
        );
      } catch (error: unknown) {
        if (notifyMiniAppIfAuthError(error)) {
          return;
        }
        const latestT: Readonly<MiniAppTranslations> = getMiniAppTranslations(
          useMiniAppStore.getState().language
        );
        const raw: string = errorMessage(error);
        const localized: string = latestT.serverNotice(
          raw,
          extractServerNoticeParams(error)
        );
        if (get().kind === activeKind) {
          set({ noticeBanner: { kind: "error", message: localized } });
        }
        notify(raw, "danger", error);
      } finally {
        set({ busyAction: false });
      }
    },
  };
}
