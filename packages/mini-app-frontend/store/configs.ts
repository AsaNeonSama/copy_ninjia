import { createStore } from "zustand";
import type { StoreApi } from "zustand";
import { classifyMiniAppAuthError } from "../api/authError";
import { fetchMiniAppConfigFile } from "../api/configsFile";
import { fetchMiniAppConfigList } from "../api/configsList";
import {
  MINI_APP_DYNAMIC_CONFIG_FILES,
  MINI_APP_STATIC_CONFIG_FILES,
} from "../consts/miniAppConfig";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { waitMinimumLoadingDuration } from "../libs/loading";
import type {
  MiniAppConfigFileItem,
  MiniAppConfigFileName,
  MiniAppConfigFileResponse,
  MiniAppConfigListResponse,
  MiniAppConfigScope,
  MiniAppDynamicConfigFileName,
  MiniAppStaticConfigFileName,
} from "../types/miniAppConfigs";
import { notifyMiniAppIfAuthError, useMiniAppStore } from "./app";
import {
  buildInitialConfigItems,
  isConfigActionInFlight,
  isDynamicConfigFileName,
  isStaticConfigFileName,
  localizeCaughtConfigError,
  notifySettledConfigAuthError,
  updateConfigItemExists,
} from "./configsHelpers";
import { createConfigsPersistenceActions } from "./configsPersistence";

/** `ConfigsPage` 配置编辑页面的状态与动作接口。 */
export interface MiniAppConfigsStoreState {
  /** 当前激活的配置分组页签（`"dynamic"` 或 `"static"`）。 */
  readonly scope: MiniAppConfigScope;
  /** 动态配置文件目录与存在性快照。 */
  readonly dynamicFiles: readonly Readonly<MiniAppConfigFileItem>[];
  /** 静态配置文件目录与存在性快照。 */
  readonly staticFiles: readonly Readonly<MiniAppConfigFileItem>[];
  /** 动态配置页签当前选中的文件名。 */
  readonly selectedDynamicFile: MiniAppDynamicConfigFileName;
  /** 静态配置页签当前选中的文件名。 */
  readonly selectedStaticFile: MiniAppStaticConfigFileName;
  /** 当前激活配置文件在服务端磁盘上是否已存在。 */
  readonly fileExists: boolean;
  /** 当前激活配置文件最近一次从服务端加载或成功保存的基准文本。 */
  readonly loadedContent: string;
  /** 代码编辑器当前的实时草稿文本。 */
  readonly draftContent: string;
  /** 配置文件选择下拉面板是否处于展开状态。 */
  readonly fileMenuOpen: boolean;
  /** 是否正在拉取配置目录或文件内容。 */
  readonly loading: boolean;
  /** 是否正在提交会话加密保存。 */
  readonly saving: boolean;
  /** 是否正在执行 JSON 格式化美化的最短加载动效窗口。 */
  readonly formatting: boolean;
  /** 是否正在执行还原修改的最短加载动效窗口。 */
  readonly resetting: boolean;
  /** 是否正在请求服务端执行 `systemctl restart copy-ninjia`。 */
  readonly restarting: boolean;
  /** 页内折叠诊断横幅展示的语法、结构校验或服务重启错误说明。 */
  readonly errorBanner: string | null;

  /** 首次挂载时并发拉取配置目录与当前选中文件内容。 */
  readonly loadInitialCatalogAndFile: () => Promise<void>;
  /** 刷新配置目录与当前文件内容（存在未保存修改时先弹确认框）。 */
  readonly refreshCurrentConfig: () => Promise<void>;
  /** 切换「动态配置 / 静态配置」子标签并加载对应选中文件（存在未保存修改时先弹确认框）。 */
  readonly selectScope: (nextScope: MiniAppConfigScope) => Promise<void>;
  /** 切换当前分组下的目标配置文件（存在未保存修改时先弹确认框）。 */
  readonly selectFile: (fileName: MiniAppConfigFileName) => Promise<void>;
  /** 切换文件选择下拉菜单展开/收起状态。 */
  readonly toggleFileMenu: () => void;
  /** 关闭文件选择下拉菜单。 */
  readonly closeFileMenu: () => void;
  /** 更新编辑器 JSON 草稿内容。 */
  readonly setDraftContent: (value: string) => void;
  /** 关闭页内错误诊断横幅。 */
  readonly dismissErrorBanner: () => void;
  /** 按 2 空格缩进美化当前 JSON 草稿（播放最短加载动效后落定，语法非法时提示错误）。 */
  readonly formatDraft: () => Promise<void>;
  /** 将草稿还原为最近一次加载或保存的基准文本（播放最短加载动效后恢复基准文本并清除错误横幅）。 */
  readonly resetDraft: () => Promise<void>;
  /** 对实际发生改动的已有文件或新建缺失文件预检语法后，在会话加密下直接保存配置；静态配置保存成功后以专属重启确认按钮文案询问是否立即重启服务。 */
  readonly saveCurrentConfig: () => Promise<void>;
}

/** 一个 `ConfigsPage` 实例独占的状态仓库。 */
export type MiniAppConfigsStore = StoreApi<MiniAppConfigsStoreState>;

/**
 * 读取指定配置分组在当前状态快照中选中的文件名。
 *
 * @param state 配置仓库当前状态
 * @param targetScope 目标配置分组（缺省取 `state.scope`）
 * @returns 选中的配置文件名
 */
export function resolveActiveConfigFileName(
  state: Pick<
    MiniAppConfigsStoreState,
    "scope" | "selectedDynamicFile" | "selectedStaticFile"
  >,
  targetScope?: MiniAppConfigScope
): MiniAppConfigFileName {
  const effectiveScope: MiniAppConfigScope = targetScope ?? state.scope;
  return effectiveScope === "dynamic"
    ? state.selectedDynamicFile
    : state.selectedStaticFile;
}

/**
 * 创建 `ConfigsPage` 的状态仓库；组件挂载时创建、卸载即丢弃，生命周期与组件实例一致。
 *
 * @returns 新的配置编辑状态仓库
 */
export function createConfigsStore(): MiniAppConfigsStore {
  return createStore<MiniAppConfigsStoreState>()(
    (
      set: (partial: Partial<MiniAppConfigsStoreState>) => void,
      get: () => MiniAppConfigsStoreState
    ): MiniAppConfigsStoreState => {
      let loadSeq: number = 0;

      const defaultDynamicFile: MiniAppDynamicConfigFileName =
        MINI_APP_DYNAMIC_CONFIG_FILES[0] ?? "ad_detect.json";
      const defaultStaticFile: MiniAppStaticConfigFileName =
        MINI_APP_STATIC_CONFIG_FILES[0] ?? "bot.json";

      const confirmDiscardIfDirty = async (): Promise<boolean> => {
        const current: MiniAppConfigsStoreState = get();
        if (current.draftContent === current.loadedContent) {
          return true;
        }
        const activeFile: MiniAppConfigFileName =
          resolveActiveConfigFileName(current);
        const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(
          useMiniAppStore.getState().language
        );
        return useMiniAppStore
          .getState()
          .requestConfirm(t.configs.confirmDiscardChanges(activeFile), "danger");
      };

      const beginConfigLoad = (
        targetScope: MiniAppConfigScope,
        targetFile: MiniAppConfigFileName
      ): { readonly reqId: number; readonly startedAt: number } => {
        const reqId: number = ++loadSeq;
        const startedAt: number = Date.now();
        set({
          scope: targetScope,
          loading: true,
          errorBanner: null,
          fileMenuOpen: false,
          ...(targetScope === "dynamic" && isDynamicConfigFileName(targetFile)
            ? { selectedDynamicFile: targetFile }
            : {}),
          ...(targetScope === "static" && isStaticConfigFileName(targetFile)
            ? { selectedStaticFile: targetFile }
            : {}),
        });
        return { reqId, startedAt };
      };

      const handleConfigLoadError = (
        error: unknown,
        targetFile: MiniAppConfigFileName,
        extraPatch: Partial<MiniAppConfigsStoreState> = {}
      ): void => {
        set({ ...extraPatch, loading: false });
        if (notifyMiniAppIfAuthError(error)) {
          return;
        }
        const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(
          useMiniAppStore.getState().language
        );
        const localized: string = localizeCaughtConfigError(
          error,
          t,
          targetFile
        );
        set({ errorBanner: localized });
        useMiniAppStore.getState().notify(localized, "danger");
      };

      const applyLoadedConfigFile = (
        fileData: MiniAppConfigFileResponse,
        targetFile: MiniAppConfigFileName,
        extraPatch: Partial<MiniAppConfigsStoreState> = {}
      ): void => {
        if (!fileData.ok) {
          const rawCode: string =
            fileData.code ?? fileData.error ?? "INVALID_CONFIG_TARGET";
          if (classifyMiniAppAuthError(rawCode, fileData) !== null) {
            set({ ...extraPatch, loading: false });
            useMiniAppStore.getState().notify(rawCode, "info", fileData);
            return;
          }
          const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(
            useMiniAppStore.getState().language
          );
          const failMsg: string = t.serverNotice(rawCode, {
            fileName: targetFile,
            errorDetail: fileData.error,
          });
          set({ ...extraPatch, loading: false, errorBanner: failMsg });
          useMiniAppStore.getState().notify(failMsg, "danger");
          return;
        }
        const normalizedContent: string =
          fileData.exists === true ? (fileData.content ?? "") : "";
        set({
          ...extraPatch,
          fileExists: fileData.exists === true,
          loadedContent: normalizedContent,
          draftContent: normalizedContent,
          loading: false,
          errorBanner: null,
        });
      };

      const fetchAndApplyCatalogAndFile = async (
        targetScope: MiniAppConfigScope,
        targetFile: MiniAppConfigFileName
      ): Promise<void> => {
        const { reqId, startedAt }: {
          readonly reqId: number;
          readonly startedAt: number;
        } = beginConfigLoad(targetScope, targetFile);
        const [listSettled, fileSettled]: readonly [
          PromiseSettledResult<MiniAppConfigListResponse>,
          PromiseSettledResult<MiniAppConfigFileResponse>
        ] = await Promise.allSettled([
          fetchMiniAppConfigList(),
          fetchMiniAppConfigFile(targetScope, targetFile),
        ]);
        await waitMinimumLoadingDuration(startedAt);
        if (reqId !== loadSeq) {
          notifySettledConfigAuthError(listSettled, fileSettled);
          return;
        }
        const catalogPatch: Partial<MiniAppConfigsStoreState> =
          listSettled.status === "fulfilled"
            ? {
              dynamicFiles: listSettled.value.dynamicFiles,
              staticFiles: listSettled.value.staticFiles,
            }
            : {};
        if (notifySettledConfigAuthError(listSettled, fileSettled)) {
          set({ ...catalogPatch, loading: false });
          return;
        }
        if (fileSettled.status === "rejected") {
          handleConfigLoadError(fileSettled.reason, targetFile, catalogPatch);
          return;
        }
        applyLoadedConfigFile(fileSettled.value, targetFile, catalogPatch);
      };

      const fetchSingleFile = async (
        targetScope: MiniAppConfigScope,
        targetFile: MiniAppConfigFileName
      ): Promise<void> => {
        const { reqId, startedAt }: {
          readonly reqId: number;
          readonly startedAt: number;
        } = beginConfigLoad(targetScope, targetFile);
        try {
          const fileData: MiniAppConfigFileResponse =
            await fetchMiniAppConfigFile(targetScope, targetFile);
          await waitMinimumLoadingDuration(startedAt);
          if (reqId !== loadSeq) {
            return;
          }
          const filesPatch: Partial<MiniAppConfigsStoreState> = fileData.ok
            ? (targetScope === "dynamic"
              ? {
                dynamicFiles: updateConfigItemExists(
                  get().dynamicFiles,
                  targetFile,
                  fileData.exists === true
                ),
              }
              : {
                staticFiles: updateConfigItemExists(
                  get().staticFiles,
                  targetFile,
                  fileData.exists === true
                ),
              })
            : {};
          applyLoadedConfigFile(fileData, targetFile, filesPatch);
        } catch (error: unknown) {
          await waitMinimumLoadingDuration(startedAt);
          if (reqId !== loadSeq) {
            notifyMiniAppIfAuthError(error);
            return;
          }
          handleConfigLoadError(error, targetFile);
        }
      };

      return {
        scope: "dynamic",
        dynamicFiles: buildInitialConfigItems(
          "dynamic",
          MINI_APP_DYNAMIC_CONFIG_FILES
        ),
        staticFiles: buildInitialConfigItems(
          "static",
          MINI_APP_STATIC_CONFIG_FILES
        ),
        selectedDynamicFile: defaultDynamicFile,
        selectedStaticFile: defaultStaticFile,
        fileExists: true,
        loadedContent: "",
        draftContent: "",
        fileMenuOpen: false,
        loading: true,
        saving: false,
        formatting: false,
        resetting: false,
        restarting: false,
        errorBanner: null,

        loadInitialCatalogAndFile: async (): Promise<void> => {
          const current: MiniAppConfigsStoreState = get();
          const activeFile: MiniAppConfigFileName =
            resolveActiveConfigFileName(current);
          await fetchAndApplyCatalogAndFile(current.scope, activeFile);
        },

        refreshCurrentConfig: async (): Promise<void> => {
          const current: MiniAppConfigsStoreState = get();
          if (isConfigActionInFlight(current)) return;
          set({ fileMenuOpen: false });
          const canProceed: boolean = await confirmDiscardIfDirty();
          if (!canProceed) return;
          const latest: MiniAppConfigsStoreState = get();
          if (isConfigActionInFlight(latest)) return;
          const activeFile: MiniAppConfigFileName =
            resolveActiveConfigFileName(latest);
          await fetchAndApplyCatalogAndFile(latest.scope, activeFile);
        },

        selectScope: async (nextScope: MiniAppConfigScope): Promise<void> => {
          const current: MiniAppConfigsStoreState = get();
          set({ fileMenuOpen: false });
          if (nextScope === current.scope || isConfigActionInFlight(current)) {
            return;
          }
          const canProceed: boolean = await confirmDiscardIfDirty();
          if (!canProceed) return;
          const latest: MiniAppConfigsStoreState = get();
          if (nextScope === latest.scope || isConfigActionInFlight(latest)) {
            return;
          }
          const targetFile: MiniAppConfigFileName = resolveActiveConfigFileName(
            latest,
            nextScope
          );
          await fetchSingleFile(nextScope, targetFile);
        },

        selectFile: async (fileName: MiniAppConfigFileName): Promise<void> => {
          const current: MiniAppConfigsStoreState = get();
          set({ fileMenuOpen: false });
          if (isConfigActionInFlight(current)) return;
          const targetScope: MiniAppConfigScope = current.scope;
          if (
            (targetScope === "dynamic" && !isDynamicConfigFileName(fileName)) ||
            (targetScope === "static" && !isStaticConfigFileName(fileName))
          ) {
            return;
          }
          const activeFile: MiniAppConfigFileName =
            resolveActiveConfigFileName(current);
          if (fileName === activeFile) return;
          const canProceed: boolean = await confirmDiscardIfDirty();
          if (!canProceed) return;
          const latest: MiniAppConfigsStoreState = get();
          if (
            isConfigActionInFlight(latest) ||
            latest.scope !== targetScope ||
            resolveActiveConfigFileName(latest) === fileName
          ) {
            return;
          }
          await fetchSingleFile(targetScope, fileName);
        },

        toggleFileMenu: (): void => {
          const current: MiniAppConfigsStoreState = get();
          if (current.loading || isConfigActionInFlight(current)) return;
          set({ fileMenuOpen: !current.fileMenuOpen });
        },

        closeFileMenu: (): void => {
          if (get().fileMenuOpen) {
            set({ fileMenuOpen: false });
          }
        },

        setDraftContent: (value: string): void => {
          if (isConfigActionInFlight(get())) return;
          set({ draftContent: value });
        },

        dismissErrorBanner: (): void => {
          set({ errorBanner: null });
        },

        ...createConfigsPersistenceActions({
          set,
          get,
          nextLoadSeq: (): number => {
            loadSeq += 1;
            return loadSeq;
          },
          currentLoadSeq: (): number => loadSeq,
        }),
      };
    }
  );
}
