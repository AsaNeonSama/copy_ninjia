import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { InlineNoticeCollapse } from "../components/animations/CollapseGrid";
import { LoadingDotsWave } from "../components/animations/LoadingDotsWave";
import { ConfigFileSelector } from "../components/ConfigFileSelector";
import { JsonCodeEditor } from "../components/JsonCodeEditor";
import { ConfigEditorSkeleton } from "../components/skeletons/ConfigEditorSkeleton";
import { MINI_APP_MIN_LOADING_MS } from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useComponentStore } from "../libs/componentStore";
import {
  AlertSvgIcon,
  CloseSvgIcon,
  CodeFormatSvgIcon,
  ConfigsSvgIcon,
  RefreshSvgIcon,
  SaveSvgIcon,
} from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import {
  createConfigsStore,
  resolveActiveConfigFileName,
} from "../store/configs";
import type {
  MiniAppConfigsStore,
  MiniAppConfigsStoreState,
} from "../store/configs";
import type { MiniAppLanguage } from "../types/miniApp/ui";
import type { MiniAppConfigFileItem, MiniAppConfigFileName } from "../types/miniAppConfigs";

/** `ConfigsPage` 配置编辑页面组件属性。 */
export interface ConfigsPageProps {
  /** 可选的状态仓库工厂（默认 `createConfigsStore`）。 */
  readonly storeFactory?: () => MiniAppConfigsStore;
}

/** 底部动作按钮显隐过渡骨架钩子入参。 */
interface ActionSkeletonTransitionOptions {
  /** 目标动作按钮当前是否满足可见条件（不含过渡骨架窗口）。 */
  readonly visible: boolean;
  /** 编辑器整卡是否处于加载态；为 `true` 时重置状态并取消在途过渡，避免加载切换期间误播骨架。 */
  readonly resetOnLoading: boolean;
  /** 是否抑制显隐切换骨架（用于还原、保存或重启在途与完成后直接退场，避免三点波浪动效期间或结束后再闪骨架）。 */
  readonly suppressTransitions?: boolean;
}

/**
 * 在底部动作按钮显现（`false -> true`）或被动隐藏（`true -> false`）时同步开启一次最短骨架占位窗口：
 * 状态切换首帧即返回 `true` 以渲染对应尺寸骨架占位并在 `MINI_APP_MIN_LOADING_MS` 后结束过渡；
 * 持续保持同一可见态（如继续编辑、不改变脏状态的格式化或退回空白态前已隐藏）时不重复触发，窗内发生反向切换时立即重置并按新方向重新计时；
 * 当 `suppressTransitions` 为 `true` 或刚由 `true` 结束（还原、保存或重启在途及完成退场）时不触发且立即终止骨架。
 *
 * @param options 按钮显隐状态与抑制控制项
 * @param options.visible 目标动作按钮当前是否满足可见条件
 * @param options.resetOnLoading 是否因整卡加载重置过渡状态
 * @param options.suppressTransitions 是否抑制显隐切换骨架（默认 `false`）
 * @returns 当前是否处于显现或隐藏骨架过渡窗口
 */
function useActionSkeletonTransition({
  visible,
  resetOnLoading,
  suppressTransitions = false,
}: Readonly<ActionSkeletonTransitionOptions>): boolean {
  const prevVisibleRef: React.RefObject<boolean> = useRef<boolean>(
    resetOnLoading ? false : visible
  );
  const prevSuppressRef: React.RefObject<boolean> = useRef<boolean>(
    suppressTransitions
  );
  const epochRef: React.RefObject<number> = useRef<number>(0);
  const activeRef: React.RefObject<boolean> = useRef<boolean>(false);
  const [settledEpoch, setSettledEpoch]: [
    number,
    React.Dispatch<React.SetStateAction<number>>
  ] = useState<number>(0);

  if (resetOnLoading) {
    prevVisibleRef.current = false;
    prevSuppressRef.current = suppressTransitions;
    activeRef.current = false;
  } else {
    const transitionedWithSuppression: boolean =
      suppressTransitions || prevSuppressRef.current;
    if (visible !== prevVisibleRef.current) {
      prevVisibleRef.current = visible;
      if (transitionedWithSuppression) {
        activeRef.current = false;
      } else {
        epochRef.current += 1;
        activeRef.current = true;
      }
    } else if (suppressTransitions) {
      activeRef.current = false;
    }
    prevSuppressRef.current = suppressTransitions;
  }

  const currentEpoch: number = epochRef.current;
  const isTransitioning: boolean =
    !resetOnLoading &&
    activeRef.current &&
    settledEpoch < currentEpoch;

  useEffect((): (() => void) | undefined => {
    if (!isTransitioning) {
      return undefined;
    }
    const targetEpoch: number = currentEpoch;
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      if (epochRef.current === targetEpoch) {
        activeRef.current = false;
      }
      setSettledEpoch(targetEpoch);
    }, MINI_APP_MIN_LOADING_MS);
    return (): void => {
      clearTimeout(timer);
    };
  }, [currentEpoch, isTransitioning]);

  return isTransitioning;
}

/**
 * 渲染配置编辑顶层页面：
 * - 顶部固定单行展示「动态配置 / 静态配置」双子页签与刷新按钮，双页签保持一致高度；
 * - 下拉选择器切换受管白名单 JSON 配置文件，未保存切换时先经确认弹窗拦截；
 * - 主体自适应填满剩余窗口高度，加载态直接等高渲染骨架屏，就绪后渐入搭载主题自适应 JSON 词法高亮代码编辑器、折叠式校验诊断横幅、一键 2 空格格式化、还原修改与会话加密保存的主编辑卡片；
 * - 未产生修改时隐藏「还原修改」与「保存」按钮；草稿发生修改使隐藏按钮显现，或因删改草稿及格式化对齐基准内容使按钮被动消失时，先各自以对应尺寸骨架占位播放 `MINI_APP_MIN_LOADING_MS` 扫光动画再落定（继续编辑或重复同态不触发）；点击「格式化」、「还原修改」或「保存」（及静态配置保存后的服务重启）在途期间对应按钮切换为电流扫光与三点波浪加载态，还原、保存或重启完成后直接退场移除不闪骨架，静态配置变更保存成功后主动弹窗询问是否立即执行 `systemctl restart copy-ninjia`。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function ConfigsPage({
  storeFactory = createConfigsStore,
}: ConfigsPageProps): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const {
    scope,
    dynamicFiles,
    staticFiles,
    selectedDynamicFile,
    selectedStaticFile,
    fileExists,
    loadedContent,
    draftContent,
    fileMenuOpen,
    loading,
    saving,
    formatting,
    resetting,
    restarting,
    errorBanner,
    loadInitialCatalogAndFile,
    refreshCurrentConfig,
    selectScope,
    selectFile,
    toggleFileMenu,
    closeFileMenu,
    setDraftContent,
    dismissErrorBanner,
    formatDraft,
    resetDraft,
    saveCurrentConfig,
  }: MiniAppConfigsStoreState = useComponentStore(storeFactory);

  useEffect((): void => {
    void loadInitialCatalogAndFile();
  }, [loadInitialCatalogAndFile]);

  const handleSelectDynamicScope: () => void = useCallback((): void => {
    void selectScope("dynamic");
  }, [selectScope]);
  const handleSelectStaticScope: () => void = useCallback((): void => {
    void selectScope("static");
  }, [selectScope]);
  const handleRefreshClick: () => void = useCallback((): void => {
    void refreshCurrentConfig();
  }, [refreshCurrentConfig]);
  const handleSelectFile: (fileName: MiniAppConfigFileName) => void =
    useCallback(
      (fileName: MiniAppConfigFileName): void => {
        void selectFile(fileName);
      },
      [selectFile]
    );
  const handleFormatClick: () => void = useCallback((): void => {
    void formatDraft();
  }, [formatDraft]);
  const handleResetClick: () => void = useCallback((): void => {
    void resetDraft();
  }, [resetDraft]);
  const handleSaveClick: () => void = useCallback((): void => {
    void saveCurrentConfig();
  }, [saveCurrentConfig]);

  const activeFile: MiniAppConfigFileName = resolveActiveConfigFileName({
    scope,
    selectedDynamicFile,
    selectedStaticFile,
  });
  const currentItems: readonly Readonly<MiniAppConfigFileItem>[] =
    scope === "dynamic" ? dynamicFiles : staticFiles;
  const isDirty: boolean = draftContent !== loadedContent;
  const isSaveSubmitting: boolean = saving || restarting;
  const isDismissSubmitting: boolean = isSaveSubmitting || resetting;
  const isActionSubmitting: boolean = isDismissSubmitting || formatting;
  const isBusy: boolean = loading || isActionSubmitting;
  const showResetButton: boolean = isDirty || resetting;
  const showSaveButton: boolean =
    (isDirty && draftContent.trim().length > 0) || isSaveSubmitting;
  const isResetTransitioning: boolean = useActionSkeletonTransition({
    visible: showResetButton,
    resetOnLoading: loading,
    suppressTransitions: isDismissSubmitting,
  });
  const isSaveTransitioning: boolean = useActionSkeletonTransition({
    visible: showSaveButton,
    resetOnLoading: loading,
    suppressTransitions: isDismissSubmitting,
  });

  return (
    <section className="configs-page">
      <div className="subtabs-bar configs-subtabs-bar">
        <div className="subtabs-group">
          <button
            type="button"
            className={`subtab-btn ${scope === "dynamic" ? "active" : ""}`}
            disabled={isActionSubmitting}
            onClick={handleSelectDynamicScope}
          >
            <ConfigsSvgIcon size={14} />
            <span>{t.configs.dynamicTab}</span>
          </button>
          <button
            type="button"
            className={`subtab-btn ${scope === "static" ? "active" : ""}`}
            disabled={isActionSubmitting}
            onClick={handleSelectStaticScope}
          >
            <span>{t.configs.staticTab}</span>
          </button>
        </div>

        <button
          type="button"
          className="btn icon-btn"
          disabled={isBusy}
          onClick={handleRefreshClick}
        >
          <RefreshSvgIcon size={14} className={loading ? "spin-icon" : ""} />
          <span>{t.configs.refreshButton}</span>
        </button>
      </div>

      <ConfigFileSelector
        scope={scope}
        items={currentItems}
        selectedFile={activeFile}
        fileExists={fileExists}
        isDirty={isDirty}
        menuOpen={fileMenuOpen}
        disabled={isBusy}
        t={t}
        onToggleMenu={toggleFileMenu}
        onCloseMenu={closeFileMenu}
        onSelectFile={handleSelectFile}
      />

      <InlineNoticeCollapse
        activeValue={errorBanner}
        resetKey={`${scope}:${activeFile}`}
      >
        {(bannerText: string): React.JSX.Element => (
          <div className="configs-error-banner" role="alert">
            <div className="configs-error-banner-head">
              <span className="configs-error-banner-title">
                <AlertSvgIcon size={15} />
                <span>{t.configs.errorBannerTitle}</span>
              </span>
              <button
                type="button"
                className="btn icon-btn configs-error-dismiss-btn"
                aria-label={t.sidebarCloseAria}
                onClick={dismissErrorBanner}
              >
                <CloseSvgIcon size={13} />
              </button>
            </div>
            <pre className="configs-error-banner-detail">{bannerText}</pre>
          </div>
        )}
      </InlineNoticeCollapse>

      {loading ? (
        <ConfigEditorSkeleton />
      ) : (
        <div className="card configs-editor-card animate-fade-in">
          {!fileExists ? (
            <div className="configs-missing-file-hint">
              {t.configs.missingFileHint(activeFile)}
            </div>
          ) : null}

          <JsonCodeEditor
            fileName={activeFile}
            value={draftContent}
            fileExists={fileExists}
            disabled={isActionSubmitting}
            t={t}
            onChange={setDraftContent}
          />

          <div className="configs-actions-row">
            <div className="configs-actions-secondary">
              <button
                type="button"
                className={`btn icon-btn configs-format-btn${formatting ? " is-loading" : ""}`}
                disabled={
                  isActionSubmitting ||
                  (!formatting && draftContent.trim().length === 0)
                }
                aria-busy={formatting}
                onClick={handleFormatClick}
              >
                {formatting ? (
                  <LoadingDotsWave />
                ) : (
                  <Fragment>
                    <CodeFormatSvgIcon size={14} />
                    <span>{t.configs.formatButton}</span>
                  </Fragment>
                )}
              </button>
              {showResetButton || isResetTransitioning ? (
                isResetTransitioning && !resetting ? (
                  <div
                    className="skeleton-line config-skeleton-btn-sm"
                    aria-busy="true"
                    aria-hidden="true"
                  />
                ) : (
                  <button
                    type="button"
                    className={`btn icon-btn configs-reset-btn${resetting ? " is-loading" : ""}`}
                    disabled={isActionSubmitting}
                    aria-busy={resetting}
                    onClick={handleResetClick}
                  >
                    {resetting ? (
                      <LoadingDotsWave />
                    ) : (
                      <span>{t.configs.resetButton}</span>
                    )}
                  </button>
                )
              ) : null}
            </div>

            {showSaveButton || isSaveTransitioning ? (
              isSaveTransitioning && !isSaveSubmitting ? (
                <div
                  className="skeleton-line config-skeleton-btn-primary"
                  aria-busy="true"
                  aria-hidden="true"
                />
              ) : (
                <button
                  type="button"
                  className={`btn primary icon-btn configs-save-btn${isSaveSubmitting ? " is-loading" : ""}`}
                  disabled={isActionSubmitting}
                  aria-busy={isSaveSubmitting}
                  onClick={handleSaveClick}
                >
                  {isSaveSubmitting ? (
                    <LoadingDotsWave />
                  ) : (
                    <Fragment>
                      <SaveSvgIcon size={14} />
                      <span>{t.configs.saveButton}</span>
                    </Fragment>
                  )}
                </button>
              )
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
