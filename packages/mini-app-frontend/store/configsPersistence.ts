import {
  classifyMiniAppAuthError,
  isSuppressedStaleMiniAppAuthError,
} from "../api/authError";
import { restartMiniAppService } from "../api/configsRestart";
import { saveMiniAppConfigFile } from "../api/configsSave";
import { MINI_APP_MAX_CONFIG_CONTENT_BYTES } from "../consts/miniAppConfig";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { encodeUtf8Bytes } from "../libs/crypto";
import { errorMessage } from "../libs/errorMessage";
import { formatJsonPretty, validateJsonSyntax } from "../libs/jsonHighlight";
import { waitMinimumLoadingDuration } from "../libs/loading";
import type { JsonSyntaxValidationResult } from "../types/miniApp/ui";
import type {
  MiniAppConfigFileName,
  MiniAppConfigRestartResponse,
  MiniAppConfigSaveResponse,
  MiniAppConfigScope,
} from "../types/miniAppConfigs";
import { notifyMiniAppIfAuthError, useMiniAppStore } from "./app";
import { resolveActiveConfigFileName } from "./configs";
import type { MiniAppConfigsStoreState } from "./configs";
import {
  isConfigActionInFlight,
  localizeCaughtConfigError,
  updateConfigItemExists,
} from "./configsHelpers";

/** 构造配置草稿格式化、还原、加密保存与服务重启子动作所需的仓库读写句柄。 */
export interface CreateConfigsPersistenceActionsOptions {
  /** 更新 `MiniAppConfigsStoreState` 的局部字段。 */
  readonly set: (partial: Partial<MiniAppConfigsStoreState>) => void;
  /** 读取当前 `MiniAppConfigsStoreState` 快照。 */
  readonly get: () => MiniAppConfigsStoreState;
  /** 递增并返回最新加载/编辑动作序号（用于作废在途加载或过时动效窗口）。 */
  readonly nextLoadSeq: () => number;
  /** 读取当前最新的加载/编辑动作序号。 */
  readonly currentLoadSeq: () => number;
}

/** 配置编辑页的草稿格式化、还原与保存持久化动作集合。 */
export type MiniAppConfigsPersistenceActions = Pick<
  MiniAppConfigsStoreState,
  "formatDraft" | "resetDraft" | "saveCurrentConfig"
>;

/**
 * 创建配置编辑页的草稿美化、草稿还原、加密保存与静态配置保存后的服务重启子动作集合。
 *
 * @param options 配置仓库读写句柄与动作序号控制函数
 * @returns 绑定到当前配置仓库的持久化动作集合
 */
export function createConfigsPersistenceActions({
  set,
  get,
  nextLoadSeq,
  currentLoadSeq,
}: CreateConfigsPersistenceActionsOptions): MiniAppConfigsPersistenceActions {
  const runConfirmedServiceRestart = async (): Promise<void> => {
    const current: MiniAppConfigsStoreState = get();
    if (isConfigActionInFlight(current)) return;
    const startedAt: number = Date.now();
    set({ restarting: true, errorBanner: null, fileMenuOpen: false });
    try {
      const res: MiniAppConfigRestartResponse =
        await restartMiniAppService();
      await waitMinimumLoadingDuration(startedAt);
      const latestT: Readonly<MiniAppTranslations> = getMiniAppTranslations(
        useMiniAppStore.getState().language
      );
      if (!res.ok) {
        const rawCode: string =
          res.code ?? res.error ?? "SERVICE_RESTART_FAILED";
        if (classifyMiniAppAuthError(rawCode, res) !== null) {
          set({ restarting: false });
          useMiniAppStore.getState().notify(rawCode, "info", res);
          return;
        }
        const failMsg: string = latestT.serverNotice(
          res.code ?? "SERVICE_RESTART_FAILED",
          { errorDetail: res.error }
        );
        set({ restarting: false, errorBanner: failMsg });
        useMiniAppStore.getState().notify(failMsg, "danger");
        return;
      }
      set({ restarting: false, errorBanner: null });
      useMiniAppStore.getState().notify("SERVICE_RESTARTED", "info");
    } catch (error: unknown) {
      await waitMinimumLoadingDuration(startedAt);
      set({ restarting: false });
      if (notifyMiniAppIfAuthError(error)) {
        return;
      }
      if (isSuppressedStaleMiniAppAuthError(errorMessage(error), error)) {
        return;
      }
      const latestT: Readonly<MiniAppTranslations> = getMiniAppTranslations(
        useMiniAppStore.getState().language
      );
      const localized: string = localizeCaughtConfigError(error, latestT);
      set({ errorBanner: localized });
      useMiniAppStore.getState().notify(localized, "danger", error);
    } finally {
      if (get().restarting) {
        set({ restarting: false });
      }
    }
  };

  return {
    formatDraft: async (): Promise<void> => {
      const current: MiniAppConfigsStoreState = get();
      if (current.loading || isConfigActionInFlight(current)) return;
      const draftToFormat: string = current.draftContent;
      const reqId: number = nextLoadSeq();
      const startedAt: number = Date.now();
      set({ formatting: true, errorBanner: null, fileMenuOpen: false });
      try {
        await waitMinimumLoadingDuration(startedAt);
        if (reqId !== currentLoadSeq()) {
          return;
        }
        const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(
          useMiniAppStore.getState().language
        );
        const check: Readonly<JsonSyntaxValidationResult> =
          validateJsonSyntax(draftToFormat);
        if (!check.ok) {
          const msg: string = check.empty
            ? t.configs.emptyJsonError
            : t.configs.syntaxErrorDetail(
              check.line,
              check.column,
              check.reason
            );
          set({ formatting: false, errorBanner: msg });
          useMiniAppStore.getState().notify(msg, "warning");
          return;
        }
        set({
          formatting: false,
          draftContent: formatJsonPretty(draftToFormat),
          errorBanner: null,
        });
      } finally {
        if (get().formatting) {
          set({ formatting: false });
        }
      }
    },

    resetDraft: async (): Promise<void> => {
      const current: MiniAppConfigsStoreState = get();
      if (current.loading || isConfigActionInFlight(current)) return;
      if (current.draftContent === current.loadedContent) {
        if (current.errorBanner !== null) {
          set({ errorBanner: null });
        }
        return;
      }
      const reqId: number = nextLoadSeq();
      const startedAt: number = Date.now();
      set({ resetting: true, errorBanner: null, fileMenuOpen: false });
      try {
        await waitMinimumLoadingDuration(startedAt);
        if (reqId !== currentLoadSeq()) {
          return;
        }
        set({
          resetting: false,
          draftContent: get().loadedContent,
          errorBanner: null,
        });
      } finally {
        if (get().resetting) {
          set({ resetting: false });
        }
      }
    },

    saveCurrentConfig: async (): Promise<void> => {
      const current: MiniAppConfigsStoreState = get();
      if (current.loading || isConfigActionInFlight(current)) return;
      if (
        current.fileExists &&
        current.draftContent === current.loadedContent
      ) {
        return;
      }
      const activeScope: MiniAppConfigScope = current.scope;
      const activeFile: MiniAppConfigFileName =
        resolveActiveConfigFileName(current);
      const contentToSave: string = current.draftContent;
      const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(
        useMiniAppStore.getState().language
      );
      const byteLen: number = encodeUtf8Bytes(contentToSave).byteLength;
      if (byteLen > MINI_APP_MAX_CONFIG_CONTENT_BYTES) {
        const msg: string = t.configs.contentTooLargeError(
          MINI_APP_MAX_CONFIG_CONTENT_BYTES
        );
        set({ errorBanner: msg });
        useMiniAppStore.getState().notify(msg, "danger");
        return;
      }
      const syntaxCheck: Readonly<JsonSyntaxValidationResult> =
        validateJsonSyntax(contentToSave);
      if (!syntaxCheck.ok) {
        const msg: string = syntaxCheck.empty
          ? t.configs.emptyJsonError
          : t.configs.syntaxErrorDetail(
            syntaxCheck.line,
            syntaxCheck.column,
            syntaxCheck.reason
          );
        set({ errorBanner: msg });
        useMiniAppStore.getState().notify(msg, "danger");
        return;
      }

      nextLoadSeq();
      const startedAt: number = Date.now();
      set({ saving: true, errorBanner: null, fileMenuOpen: false });
      try {
        const res: MiniAppConfigSaveResponse = await saveMiniAppConfigFile(
          activeScope,
          activeFile,
          contentToSave
        );
        await waitMinimumLoadingDuration(startedAt);
        const latestT: Readonly<MiniAppTranslations> = getMiniAppTranslations(
          useMiniAppStore.getState().language
        );
        if (!res.ok) {
          const rawCode: string =
            res.code !== undefined && res.code.length > 0
              ? res.code
              : (res.error ?? "CONFIG_VALIDATION_FAILED");
          if (classifyMiniAppAuthError(rawCode, res) !== null) {
            set({ saving: false });
            useMiniAppStore.getState().notify(rawCode, "info", res);
            return;
          }
          const failMsg: string =
            res.code !== undefined && res.code.length > 0
              ? latestT.serverNotice(res.code, {
                fileName: activeFile,
                errorDetail: res.error,
              })
              : latestT.serverNotice(
                res.error ?? "CONFIG_VALIDATION_FAILED",
                { fileName: activeFile }
              );
          set({ saving: false, errorBanner: failMsg });
          useMiniAppStore.getState().notify(failMsg, "danger");
          return;
        }
        set({
          saving: false,
          fileExists: true,
          loadedContent: contentToSave,
          errorBanner: null,
          ...(activeScope === "dynamic"
            ? {
              dynamicFiles: updateConfigItemExists(
                get().dynamicFiles,
                activeFile,
                true
              ),
            }
            : {
              staticFiles: updateConfigItemExists(
                get().staticFiles,
                activeFile,
                true
              ),
            }),
        });
        useMiniAppStore
          .getState()
          .notify("CONFIG_SAVED", "info", { fileName: activeFile });
        if (activeScope === "static" || res.requiresRestart) {
          const confirmRestart: boolean = await useMiniAppStore
            .getState()
            .requestConfirm(
              latestT.configs.confirmRestartAfterSave(activeFile),
              "primary",
              {
                cancelLabel: latestT.configs.restartConfirmCancelButton,
                confirmLabel: latestT.configs.restartConfirmAcceptButton,
              }
            );
          if (confirmRestart) {
            await runConfirmedServiceRestart();
          }
        }
      } catch (error: unknown) {
        await waitMinimumLoadingDuration(startedAt);
        set({ saving: false });
        if (notifyMiniAppIfAuthError(error)) {
          return;
        }
        if (isSuppressedStaleMiniAppAuthError(errorMessage(error), error)) {
          return;
        }
        const latestT: Readonly<MiniAppTranslations> = getMiniAppTranslations(
          useMiniAppStore.getState().language
        );
        const localized: string = localizeCaughtConfigError(
          error,
          latestT,
          activeFile
        );
        set({ errorBanner: localized });
        useMiniAppStore.getState().notify(localized, "danger", error);
      } finally {
        if (get().saving) {
          set({ saving: false });
        }
      }
    },
  };
}
