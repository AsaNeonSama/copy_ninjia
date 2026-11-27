import { Fragment, memo, useCallback, useEffect } from "react";
import type React from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { MINI_APP_TARGETS_MODAL_CLOSE_MS } from "../consts/miniApp/animation";
import {
  MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE,
  MINI_APP_AD_BLACKLIST_PREVIEW_SKELETON_INDICES,
} from "../consts/miniApp/ui";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { buildAdBlacklistPackUrl } from "../libs/adBlacklistPackInput";
import { copyMiniAppText, openMiniAppTelegramLink } from "../libs/telegram";
import {
  AlertSvgIcon,
  CloseSvgIcon,
  CopySvgIcon,
  ExternalLinkSvgIcon,
  RefreshSvgIcon,
} from "../resource";
import type {
  MiniAppAdBlacklistsStore,
  MiniAppAdBlacklistsStoreState,
  MiniAppAdBlacklistPreviewTarget,
} from "../store/adBlacklists";
import type { MiniAppAdBlacklistsPreviewSlice } from "../store/adBlacklistsPreview";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import type {
  MiniAppAdBlacklistPreviewItem,
  MiniAppAdBlacklistPreviewResponse,
} from "../types/miniApp/adBlacklists";
import type { MiniAppLanguage } from "../types/miniApp/ui";
import { LoadingDotsWave } from "./animations/LoadingDotsWave";
import { useModalBodyScrollLock } from "./animations/TabHeightSizer";
import {
  useClosingSnapshot,
  useDelayedUnmount,
} from "./animations/useDelayedUnmount";
import type { DelayedUnmountState } from "./animations/useDelayedUnmount";
import { GalleryImageSkeleton } from "./skeletons/GalleryImageSkeleton";

/** 支持监听全局 `keydown` 以响应 `Escape` 键关闭弹窗的文档最小接口。 */
interface KeydownEventLike {
  readonly key?: string;
}

/** 支持注册与移除 `keydown` 事件监听的文档宿主最小接口。 */
interface KeydownDocumentHost {
  readonly addEventListener?: (
    type: "keydown",
    listener: (event: KeydownEventLike) => void
  ) => void;
  readonly removeEventListener?: (
    type: "keydown",
    listener: (event: KeydownEventLike) => void
  ) => void;
}

/** `AdBlacklistPreviewModal` 组件属性参数。 */
export interface AdBlacklistPreviewModalProps {
  /** `AdBlacklistsPage` 持有的内容黑名单状态仓库实例。 */
  readonly store: MiniAppAdBlacklistsStore;
}

/**
 * 从内容黑名单仓库提取页内包预览弹窗独占的状态与动作切片。
 *
 * @param state 内容黑名单仓库完整状态快照
 * @returns 预览弹窗切片
 */
function selectAdBlacklistPreviewSlice(
  state: MiniAppAdBlacklistsStoreState
): MiniAppAdBlacklistsPreviewSlice {
  return {
    previewTarget: state.previewTarget,
    previewData: state.previewData,
    previewLoadingMeta: state.previewLoadingMeta,
    previewLoadingImages: state.previewLoadingImages,
    previewLoadingMore: state.previewLoadingMore,
    previewError: state.previewError,
    openPreview: state.openPreview,
    retryPreview: state.retryPreview,
    loadMorePreview: state.loadMorePreview,
    closePreview: state.closePreview,
  };
}

/**
 * 渲染内容黑名单贴纸包 / 自定义表情包页内预览弹窗：
 * - 第一阶段经 `metaOnly=1` 快速确认包标题、总枚数与本页精确格数（确认前仅展示紧凑加载点）；
 * - 第二阶段按已确认的精确条目数渲染网格（含可加载缩略图格位显示 `<GalleryImageSkeleton>`，无图格位直接显示 Emoji 占位），随后原地注水静态缩略图；
 * - 支持大包按已知剩余枚数追加精确格数骨架的「加载更多」、失败重试、复制 Telegram 包链接，以及通过 `Telegram.WebApp.openTelegramLink` 可选在 Telegram 打开。
 *
 * @param props 状态仓库属性
 * @returns 弹窗节点或关闭卸载时的 `null`
 */
function AdBlacklistPreviewModalView({
  store,
}: AdBlacklistPreviewModalProps): React.JSX.Element | null {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const {
    previewTarget,
    previewData,
    previewLoadingMeta,
    previewLoadingImages,
    previewLoadingMore,
    previewError,
    retryPreview,
    loadMorePreview,
    closePreview,
  }: MiniAppAdBlacklistsPreviewSlice = useStore(
    store,
    useShallow(selectAdBlacklistPreviewSlice)
  );

  const isOpen: boolean = previewTarget !== null;
  const {
    isClosing,
    displayValue: displayTarget,
  }: Readonly<DelayedUnmountState<Readonly<MiniAppAdBlacklistPreviewTarget>>> =
    useDelayedUnmount(previewTarget, MINI_APP_TARGETS_MODAL_CLOSE_MS);

  const displayData: Readonly<MiniAppAdBlacklistPreviewResponse> | null =
    useClosingSnapshot(previewData, isOpen);
  const displayLoadingMeta: boolean = useClosingSnapshot(
    previewLoadingMeta,
    isOpen
  );
  const displayLoadingImages: boolean = useClosingSnapshot(
    previewLoadingImages,
    isOpen
  );
  const displayLoadingMore: boolean = useClosingSnapshot(
    previewLoadingMore,
    isOpen
  );
  const displayError: string | null = useClosingSnapshot(previewError, isOpen);

  useModalBodyScrollLock(displayTarget !== null);

  useEffect((): (() => void) | undefined => {
    if (!isOpen) {
      return undefined;
    }
    const doc: KeydownDocumentHost | undefined = (
      globalThis as { readonly document?: KeydownDocumentHost }
    ).document;
    if (typeof doc?.addEventListener !== "function") {
      return undefined;
    }
    const handleKeyDown = (event: KeydownEventLike): void => {
      if (event.key === "Escape") {
        closePreview();
      }
    };
    doc.addEventListener("keydown", handleKeyDown);
    return (): void => {
      doc.removeEventListener?.("keydown", handleKeyDown);
    };
  }, [closePreview, isOpen]);

  const handleBackdropClick: (event: React.MouseEvent<HTMLDivElement>) => void =
    useCallback(
      (event: React.MouseEvent<HTMLDivElement>): void => {
        if (event.target === event.currentTarget) {
          closePreview();
        }
      },
      [closePreview]
    );

  const packUrl: string =
    displayTarget !== null
      ? buildAdBlacklistPackUrl(displayTarget.kind, displayTarget.pack)
      : "";

  const handleCopyLink: () => void = useCallback((): void => {
    if (packUrl.length === 0) return;
    void copyMiniAppText(packUrl).then((copied: boolean): void => {
      const latestT: Readonly<MiniAppTranslations> = getMiniAppTranslations(
        useMiniAppStore.getState().language
      );
      useMiniAppStore
        .getState()
        .notify(
          copied
            ? latestT.adBlacklists.previewLinkCopiedToast
            : latestT.adBlacklists.previewCopyFailedToast,
          copied ? "info" : "warning"
        );
    });
  }, [packUrl]);

  const handleOpenInTelegram: () => void = useCallback((): void => {
    if (packUrl.length === 0) return;
    openMiniAppTelegramLink(packUrl);
  }, [packUrl]);

  if (displayTarget === null) {
    return null;
  }

  const headerTitle: string =
    displayData !== null && displayData.title.length > 0
      ? displayData.title
      : displayTarget.pack;
  const headerSub: string =
    displayData !== null
      ? `${displayData.pack} · ${t.adBlacklists.previewStickerTypeLabel(displayData.stickerType)}`
      : displayTarget.pack;

  const loadingMoreSkeletonCount: number =
    displayLoadingMore && displayData !== null
      ? Math.min(
        MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE,
        Math.max(0, displayData.totalCount - displayData.items.length)
      )
      : 0;

  return (
    <div
      className={`confirm-backdrop ad-blacklist-preview-backdrop ${isClosing ? "closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-hidden={isClosing}
      aria-label={headerTitle}
      onClick={handleBackdropClick}
    >
      <div
        className={`ad-blacklist-preview-modal ${isClosing ? "closing" : ""}`}
      >
        <div className="ad-blacklist-preview-header">
          <div className="ad-blacklist-preview-header-main">
            <div className="ad-blacklist-preview-title-row">
              <span className="ad-blacklist-preview-title" title={headerTitle}>
                {headerTitle}
              </span>
              {displayData !== null
                ? (
                  <span className="badge ad-blacklist-preview-count">
                    {t.adBlacklists.previewCountBadge(displayData.totalCount)}
                  </span>
                )
                : null}
            </div>
            <div
              className="ad-blacklist-preview-sub"
              dir="ltr"
              title={headerSub}
            >
              {headerSub}
            </div>
          </div>
          <button
            type="button"
            className="btn icon-btn ad-blacklist-preview-close-btn"
            aria-label={t.adBlacklists.previewCloseButton}
            disabled={isClosing}
            tabIndex={isClosing ? -1 : undefined}
            onClick={closePreview}
          >
            <CloseSvgIcon size={14} />
          </button>
        </div>

        <div className="ad-blacklist-preview-body">
          {displayLoadingMeta
            ? (
              <div
                className="ad-blacklist-preview-meta-loading"
                aria-busy="true"
              >
                <LoadingDotsWave />
              </div>
            )
            : null}

          {!displayLoadingMeta && displayError !== null
            ? (
              <div className="ad-blacklist-preview-error" role="alert">
                <div className="ad-blacklist-preview-error-head">
                  <AlertSvgIcon size={18} />
                  <span>{displayError}</span>
                </div>
                <button
                  type="button"
                  className="btn primary icon-btn"
                  disabled={isClosing}
                  tabIndex={isClosing ? -1 : undefined}
                  onClick={(): void => {
                    void retryPreview();
                  }}
                >
                  <RefreshSvgIcon size={14} />
                  <span>{t.adBlacklists.previewRetryButton}</span>
                </button>
              </div>
            )
            : null}

          {!displayLoadingMeta &&
          displayError === null &&
          displayData !== null &&
          displayData.items.length === 0
            ? (
              <div className="empty ad-blacklist-preview-empty">
                {t.adBlacklists.previewEmptyHint}
              </div>
            )
            : null}

          {!displayLoadingMeta &&
          displayError === null &&
          displayData !== null &&
          displayData.items.length > 0
            ? (
              <Fragment>
                <div
                  className="ad-blacklist-preview-grid"
                  aria-busy={displayLoadingImages || displayLoadingMore}
                >
                  {displayData.items.map(
                    (
                      item: Readonly<MiniAppAdBlacklistPreviewItem>,
                      index: number
                    ): React.JSX.Element => {
                      const isTileImageLoading: boolean =
                        item.imageDataUrl === null &&
                        item.hasImage &&
                        displayLoadingImages;
                      const formatTag: string | null =
                        item.format === "animated"
                          ? t.adBlacklists.previewAnimatedTag
                          : item.format === "video"
                            ? t.adBlacklists.previewVideoTag
                            : null;
                      return (
                        <div
                          key={`${item.fileUniqueId}:${index}`}
                          className={
                            isTileImageLoading
                              ? "ad-blacklist-preview-tile ad-blacklist-preview-skeleton-tile"
                              : "ad-blacklist-preview-tile"
                          }
                          title={item.emoji ?? displayData.pack}
                        >
                          {item.imageDataUrl !== null
                            ? (
                              <img
                                className="ad-blacklist-preview-img"
                                src={item.imageDataUrl}
                                alt={item.emoji ?? displayData.pack}
                                loading="lazy"
                                decoding="async"
                              />
                            )
                            : isTileImageLoading
                              ? <GalleryImageSkeleton iconSize={20} />
                              : (
                                <span
                                  className="ad-blacklist-preview-fallback"
                                  aria-label={item.emoji ?? displayData.pack}
                                >
                                  {item.emoji ?? "?"}
                                </span>
                              )}
                          {formatTag !== null
                            ? (
                              <span className="ad-blacklist-preview-format-tag">
                                {formatTag}
                              </span>
                            )
                            : null}
                        </div>
                      );
                    }
                  )}
                  {loadingMoreSkeletonCount > 0
                    ? MINI_APP_AD_BLACKLIST_PREVIEW_SKELETON_INDICES.slice(
                      0,
                      loadingMoreSkeletonCount
                    ).map((index: number): React.JSX.Element => (
                      <div
                        key={`loading-more:${index}`}
                        className="ad-blacklist-preview-tile ad-blacklist-preview-skeleton-tile"
                      >
                        <GalleryImageSkeleton iconSize={20} />
                      </div>
                    ))
                    : null}
                </div>

                {displayData.hasMore
                  ? (
                    <div className="ad-blacklist-preview-more-wrap">
                      <button
                        type="button"
                        className="btn icon-btn ad-blacklist-preview-more-btn"
                        disabled={
                          isClosing ||
                          displayLoadingImages ||
                          displayLoadingMore
                        }
                        tabIndex={isClosing ? -1 : undefined}
                        onClick={(): void => {
                          void loadMorePreview();
                        }}
                      >
                        <RefreshSvgIcon
                          size={14}
                          className={displayLoadingMore ? "spin-icon" : ""}
                        />
                        <span>
                          {displayLoadingMore
                            ? t.adBlacklists.previewLoadingMoreButton
                            : t.adBlacklists.previewLoadMoreButton(
                              displayData.items.length,
                              displayData.totalCount
                            )}
                        </span>
                      </button>
                    </div>
                  )
                  : null}
              </Fragment>
            )
            : null}
        </div>

        <div className="ad-blacklist-preview-footer">
          <button
            type="button"
            className="btn icon-btn"
            disabled={isClosing}
            tabIndex={isClosing ? -1 : undefined}
            onClick={handleCopyLink}
          >
            <CopySvgIcon size={14} />
            <span>{t.adBlacklists.previewCopyLinkButton}</span>
          </button>
          <button
            type="button"
            className="btn primary icon-btn"
            disabled={isClosing}
            tabIndex={isClosing ? -1 : undefined}
            onClick={handleOpenInTelegram}
          >
            <ExternalLinkSvgIcon size={14} />
            <span>{t.adBlacklists.previewOpenTelegramButton}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** 仓库引用不变时跳过父级重渲染的内容黑名单页内包预览弹窗（内部按预览切片自订阅）。 */
export const AdBlacklistPreviewModal: React.MemoExoticComponent<
  typeof AdBlacklistPreviewModalView
> = memo(AdBlacklistPreviewModalView);
