import { useEffect } from "react";
import type React from "react";
import { useDelayedUnmount } from "../components/animations/useDelayedUnmount";
import type { DelayedUnmountState } from "../components/animations/useDelayedUnmount";
import { GalleryGridList } from "../components/GalleryGridList";
import { GalleryPreviewCard } from "../components/GalleryPreviewCard";
import { PaginationBar } from "../components/PaginationBar";
import {
  MINI_APP_GALLERY_PAGE_SIZE_OPTIONS,
  MINI_APP_GALLERY_PREVIEW_COLLAPSE_MS,
} from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useComponentStore } from "../libs/componentStore";
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

/** 浏览器文件选择 `<input type="file">` 事件目标的最小类型接口。 */
interface FileInputEventTarget {
  /** 当前选中的文件伪数组。 */
  readonly files?: ArrayLike<File> | null;
  /** 输入框当前值（置空可允许重复选择同一文件）。 */
  value: string;
}

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

  const handleDownloadImage = (fileName: string): void => {
    void downloadImage(fileName);
  };

  const handleDeleteImage = (fileName: string): void => {
    void deleteImage(fileName);
  };

  const handleFilesSelected = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const target: FileInputEventTarget =
      event.currentTarget as unknown as FileInputEventTarget;
    const rawFiles: ArrayLike<File> | null | undefined = target.files;
    if (rawFiles === undefined || rawFiles === null || rawFiles.length === 0) {
      return;
    }
    const files: File[] = Array.from(rawFiles);
    target.value = "";
    void uploadFiles(files);
  };

  const {
    displayValue: displayPreviewItem,
    isClosing: previewClosing,
  }: Readonly<DelayedUnmountState<Readonly<MiniAppGalleryItem>>> =
    useDelayedUnmount(previewItem, MINI_APP_GALLERY_PREVIEW_COLLAPSE_MS);

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

        <div className="row-sub">
          {galleryPage === null
            ? t.gallery.loadingText
            : galleryPage.exists
              ? t.gallery.directoryReadyText(galleryPage.directory)
              : t.gallery.directoryMissingText(galleryPage.directory)}
        </div>

        {uploadStatusText !== null
          ? (
            <div className="cap-item" style={{ marginTop: "8px" }}>
              <div className="cap-val">{uploadStatusText}</div>
            </div>
          )
          : null}
      </div>

      {displayPreviewItem !== null
        ? (
          <div
            className={`gallery-preview-collapse-grid ${previewClosing ? "closing" : ""}`}
            aria-hidden={previewClosing}
          >
            <div className="gallery-preview-collapse-inner">
              <GalleryPreviewCard
                previewItem={displayPreviewItem}
                previewLoaded={previewLoaded}
                isClosing={previewClosing}
                downloadingFileName={downloadingFileName}
                deletingFileName={deletingFileName}
                onMarkPreviewLoaded={markPreviewLoaded}
                onDownloadImage={handleDownloadImage}
                onDeleteImage={handleDeleteImage}
                onClosePreview={(): void => {
                  setPreviewItem(null);
                }}
              />
            </div>
          </div>
        )
        : null}

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
                    onSelectPreviewItem={setPreviewItem}
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
