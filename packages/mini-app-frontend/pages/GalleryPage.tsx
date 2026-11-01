import { useCallback, useEffect, useRef } from "react";
import type React from "react";
import { CollapseGrid } from "../components/animations/CollapseGrid";
import {
  animateViewportToAnchor,
  resolveCollapseClampScrollTarget,
  resolvePreviewCardScrollTarget,
} from "../components/animations/expandFollowScroll";
import type { ViewportAnchorScrollTarget } from "../components/animations/expandFollowScroll";
import type {
  FlipAnimatableElement,
  FlipFollowScrollResolver,
} from "../components/animations/flipCollapse";
import { useDelayedUnmount } from "../components/animations/useDelayedUnmount";
import type { DelayedUnmountState } from "../components/animations/useDelayedUnmount";
import { GalleryGridList } from "../components/GalleryGridList";
import { GalleryPreviewCard } from "../components/GalleryPreviewCard";
import { PaginationBar } from "../components/PaginationBar";
import {
  MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS,
  MINI_APP_GALLERY_PAGE_SIZE_OPTIONS,
} from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useComponentStore } from "../libs/componentStore";
import { extractSelectedFilesAndReset } from "../libs/formatters";
import {
  GallerySvgIcon,
  RefreshSvgIcon,
  UploadSvgIcon,
} from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import { createGalleryStore } from "../store/gallery";
import type { MiniAppGalleryStoreState } from "../store/gallery";
import type { MiniAppGalleryItem, MiniAppLanguage } from "../types/miniApp";

/**
 * 图库分页预览、SHA-256 协议上传、单张图片下载与删除管理页面（关闭大图预览时执行延迟卸载收起过渡动画）。
 *
 * @returns React 节点
 */
export function GalleryPage(): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const {
    galleryPage,
    pageSize,
    loading,
    uploading,
    deletingFileName,
    downloadingFileName,
    uploadStatusText,
    previewItem,
    loadedImages,
    batchEpoch,
    previewLoaded,
    loadGallery,
    markThumbLoaded,
    markPreviewLoaded,
    setPreviewItem,
    changePage,
    changePageSize,
    downloadImage,
    deleteImage,
    uploadFiles,
  }: MiniAppGalleryStoreState = useComponentStore(createGalleryStore);
  useEffect((): void => {
    void loadGallery(1, pageSize);
  }, [loadGallery, pageSize]);

  const handleDownloadImage: (fileName: string) => void = useCallback(
    (fileName: string): void => {
      void downloadImage(fileName);
    },
    [downloadImage]
  );

  const handleDeleteImage: (fileName: string) => void = useCallback(
    (fileName: string): void => {
      void deleteImage(fileName);
    },
    [deleteImage]
  );

  const previewGridRef: React.RefObject<FlipAnimatableElement | null> =
    useRef<FlipAnimatableElement | null>(null);

  /** 关闭按钮触发的收起在同一次提交内解析视口回落；翻页、删除等其余收起路径不回落（翻页由分页栏滚回顶部）。 */
  const closeScrollArmedRef: React.RefObject<boolean> = useRef<boolean>(false);

  const handleClosePreview: () => void = useCallback((): void => {
    closeScrollArmedRef.current = true;
    setPreviewItem(null);
  }, [setPreviewItem]);

  const resolvePreviewCollapseScroll: FlipFollowScrollResolver = useCallback(
    (
      gridElement: FlipAnimatableElement,
      removedHeightPx: number
    ): ViewportAnchorScrollTarget | null => {
      if (!closeScrollArmedRef.current) {
        return null;
      }
      closeScrollArmedRef.current = false;
      return resolveCollapseClampScrollTarget(gridElement, removedHeightPx);
    },
    []
  );

  useEffect((): void => {
    closeScrollArmedRef.current = false;
  }, [previewItem]);

  const cancelPreviewScrollRef: React.RefObject<(() => void) | null> =
    useRef<(() => void) | null>(null);

  /** 预览面板不在展开过渡中时以同一时长与曲线把视口滚到预览位置；展开过渡中由折叠动画的同帧跟滚负责。 */
  const scrollToSettledPreview: () => void = useCallback((): void => {
    const gridEl: FlipAnimatableElement | null = previewGridRef.current;
    if (
      gridEl === null ||
      gridEl.firstElementChild?.dataset?.flipInFlight === "1"
    ) {
      return;
    }
    const target: ViewportAnchorScrollTarget | null =
      resolvePreviewCardScrollTarget(gridEl);
    if (target === null) {
      return;
    }
    cancelPreviewScrollRef.current?.();
    cancelPreviewScrollRef.current = animateViewportToAnchor(target);
  }, []);

  useEffect((): (() => void) => {
    return (): void => {
      cancelPreviewScrollRef.current?.();
      cancelPreviewScrollRef.current = null;
    };
  }, []);

  const handleSelectPreviewItem: (item: Readonly<MiniAppGalleryItem>) => void =
    useCallback(
      (item: Readonly<MiniAppGalleryItem>): void => {
        if (previewItem?.fileName === item.fileName) {
          scrollToSettledPreview();
          return;
        }
        setPreviewItem(item);
      },
      [previewItem, scrollToSettledPreview, setPreviewItem]
    );

  useEffect((): void => {
    if (previewItem !== null) {
      scrollToSettledPreview();
    }
  }, [previewItem, scrollToSettledPreview]);

  const handleFilesSelected = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const files: File[] = extractSelectedFilesAndReset(event);
    if (files.length === 0) {
      return;
    }
    void uploadFiles(files);
  };

  const {
    displayValue: displayPreviewItem,
    isClosing: previewClosing,
  }: Readonly<DelayedUnmountState<Readonly<MiniAppGalleryItem>>> =
    useDelayedUnmount(previewItem, MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS);

  const uploadDisabled: boolean =
    uploading || loading || deletingFileName !== null || galleryPage?.exists === false;

  return (
    <div className="animate-fade-in">
      <div className="card">
        <div className="card-title">
          <span className="toolbar-hint">
            <span className="toolbar-icon-badge">
              <GallerySvgIcon size={16} />
            </span>
            <span>{t.gallery.sectionTitle}</span>
          </span>
          <div className="toolbar-actions">
            <label
              className="btn primary icon-btn"
              style={
                uploadDisabled
                  ? { opacity: 0.45, cursor: "not-allowed", pointerEvents: "none" }
                  : undefined
              }
            >
              <UploadSvgIcon size={14} />
              <span>{uploading ? t.gallery.uploadingButton : t.gallery.uploadButton}</span>
              <input
                type="file"
                accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                multiple
                disabled={uploadDisabled}
                style={{ display: "none" }}
                onChange={handleFilesSelected}
              />
            </label>
            <button
              type="button"
              className="btn icon-btn"
              disabled={loading || uploading || deletingFileName !== null}
              onClick={(): void => {
                void loadGallery();
              }}
            >
              <RefreshSvgIcon size={14} className={loading ? "spin-icon" : ""} />
              <span>{t.gallery.refreshButton}</span>
            </button>
          </div>
        </div>

        {galleryPage !== null
          ? (
            <div className="row-sub">
              {galleryPage.exists
                ? t.gallery.directoryReadyText(galleryPage.directory)
                : t.gallery.directoryMissingText(galleryPage.directory)}
            </div>
          )
          : null}

        {uploadStatusText !== null
          ? (
            <div className="cap-item" style={{ marginTop: "8px" }}>
              <div className="cap-val">{uploadStatusText}</div>
            </div>
          )
          : null}
      </div>

      <CollapseGrid
        expanded={previewItem !== null}
        gridClassName="gallery-preview-collapse-grid"
        innerClassName="gallery-preview-collapse-inner"
        fadeInner
        containerRef={previewGridRef}
        resolveFollowScroll={resolvePreviewCardScrollTarget}
        resolveCollapseScroll={resolvePreviewCollapseScroll}
      >
        {displayPreviewItem !== null ? (
          <GalleryPreviewCard
            previewItem={displayPreviewItem}
            previewLoaded={previewLoaded}
            isClosing={previewClosing}
            downloadingFileName={downloadingFileName}
            deletingFileName={deletingFileName}
            onMarkPreviewLoaded={markPreviewLoaded}
            onDownloadImage={handleDownloadImage}
            onDeleteImage={handleDeleteImage}
            onClosePreview={handleClosePreview}
          />
        ) : null}
      </CollapseGrid>

      {galleryPage !== null
        ? (
          <div className="card animate-fade-in">
            {!galleryPage.exists
              ? <div className="empty">{t.gallery.emptyMissingDirHint}</div>
              : galleryPage.items.length === 0
                ? <div className="empty">{t.gallery.emptyGalleryHint}</div>
                : (
                  <GalleryGridList
                    items={galleryPage.items}
                    previewItem={previewItem}
                    deletingFileName={deletingFileName}
                    downloadingFileName={downloadingFileName}
                    loadedImages={loadedImages}
                    batchEpoch={batchEpoch}
                    t={t}
                    onMarkThumbLoaded={markThumbLoaded}
                    onSelectPreviewItem={handleSelectPreviewItem}
                    onDownloadImage={handleDownloadImage}
                    onDeleteImage={handleDeleteImage}
                  />
                )}

            <PaginationBar
              page={galleryPage.page}
              totalPages={galleryPage.totalPages}
              total={galleryPage.total}
              pageSize={pageSize}
              pageSizeOptions={MINI_APP_GALLERY_PAGE_SIZE_OPTIONS}
              disabled={loading || uploading || deletingFileName !== null}
              onPageChange={changePage}
              onPageSizeChange={changePageSize}
            />
          </div>
        )
        : null}
    </div>
  );
}
