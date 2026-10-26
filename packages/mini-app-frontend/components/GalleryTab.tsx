import { useEffect, useRef, useState } from "react";
import type React from "react";
import { MINI_APP_GALLERY_PAGE_SIZE_OPTIONS } from "../consts/miniApp";
import { buildMiniAppGalleryImageUrl } from "../api/galleryFile";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useComponentStore } from "../libs/componentStore";
import {
  formatGalleryFileSize,
  shortenGalleryFileName,
} from "../libs/formatters";
import {
  CloseSvgIcon,
  DownloadSvgIcon,
  GallerySvgIcon,
  RefreshSvgIcon,
  TrashSvgIcon,
  UploadSvgIcon,
} from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import { createGalleryStore } from "../store/gallery";
import type { MiniAppGalleryStoreState } from "../store/gallery";
import type {
  MiniAppGalleryItem,
  MiniAppLanguage,
} from "../types/miniApp";
import { PaginationBar } from "./PaginationBar";
import { GalleryImageSkeleton } from "./skeletons/GalleryImageSkeleton";

/** 浏览器文件选择 `<input type="file">` 事件目标的最小类型接口。 */
interface FileInputEventTarget {
  /** 当前选中的文件伪数组。 */
  readonly files?: ArrayLike<File> | null;
  /** 输入框当前值（置空可允许重复选择同一文件）。 */
  value: string;
}

/** 具备平滑滚动能力的预览容器 DOM 节点接口。 */
interface ScrollablePreviewElement extends HTMLDivElement {
  /** 将当前元素平滑滚动至可视区域。 */
  readonly scrollIntoView?: (options: {
    readonly behavior: string;
    readonly block: string;
  }) => void;
}

/** 支持主动失焦（`blur`）的按钮事件目标接口。 */
interface BlurTargetElement {
  /** 移除当前按钮焦点，防止原生弹窗关闭后残留悬停或焦点态。 */
  readonly blur?: () => void;
}

/** 支持缓存完成态探测的 `<img>` DOM 节点最小类型接口。 */
interface ProbeableImageElement {
  /** 浏览器是否已完成该图片加载或解码（含内存缓存命中）。 */
  readonly complete?: boolean;
  /** 当前绑定的图片资源地址。 */
  readonly src?: string;
}

/**
 * 图库分页预览、SHA-256 协议上传、单张图片下载与删除管理组件。
 *
 * @returns React 节点
 */
export function GalleryTab(): React.JSX.Element {
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
  const [suppressedHoverFileName, setSuppressedHoverFileName]: [
    string | null,
    React.Dispatch<React.SetStateAction<string | null>>
  ] = useState<string | null>(null);
  const clickCoordsRef: React.RefObject<{ readonly x: number; readonly y: number }> =
    useRef<{ readonly x: number; readonly y: number }>({ x: -1, y: -1 });
  const previewCardRef: React.RefObject<ScrollablePreviewElement | null> =
    useRef<ScrollablePreviewElement | null>(null);
  const previewImgRef: React.RefObject<ProbeableImageElement | null> =
    useRef<ProbeableImageElement | null>(null);

  useEffect((): void => {
    if (previewItem !== null) {
      const imgEl: ProbeableImageElement | null = previewImgRef.current;
      if (
        imgEl !== null &&
        typeof imgEl.src === "string" &&
        imgEl.src.length > 0 &&
        imgEl.complete === true
      ) {
        markPreviewLoaded();
      }
      previewCardRef.current?.scrollIntoView?.({
        behavior: "smooth",
        block: "start",
      });
    }
  }, [markPreviewLoaded, previewItem]);

  useEffect((): void => {
    void loadGallery(1, pageSize);
  }, [loadGallery, pageSize]);

  const clearHoverSuppressionOnLeave = (fileName: string): void => {
    if (
      downloadingFileName === null &&
      deletingFileName === null &&
      suppressedHoverFileName === fileName
    ) {
      setSuppressedHoverFileName(null);
    }
  };

  const clearHoverSuppressionOnMove = (
    fileName: string,
    event: React.MouseEvent<HTMLButtonElement>
  ): void => {
    if (
      downloadingFileName === null &&
      deletingFileName === null &&
      suppressedHoverFileName === fileName &&
      (Math.abs(event.clientX - clickCoordsRef.current.x) > 4 ||
        Math.abs(event.clientY - clickCoordsRef.current.y) > 4)
    ) {
      setSuppressedHoverFileName(null);
    }
  };

  const handleDownloadImage = (fileName: string): void => {
    setSuppressedHoverFileName(fileName);
    void downloadImage(fileName);
  };

  const handleDeleteImage = (fileName: string): void => {
    setSuppressedHoverFileName(fileName);
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

  const uploadDisabled: boolean =
    uploading || loading || deletingFileName !== null || galleryPage?.exists === false;

  return (
    <div className="animate-fade-in">
      <div className="card">
        <div className="card-title">
          <span className="toolbar-hint">
            <span className="toolbar-icon-badge">
              <GallerySvgIcon size={15} />
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

      {previewItem !== null
        ? (
          <div
            ref={previewCardRef}
            className="card gallery-preview-card animate-fade-in"
          >
            <div className="card-title">
              <span className="toolbar-hint" style={{ minWidth: 0, flex: 1 }}>
                <span className="toolbar-icon-badge">
                  <GallerySvgIcon size={15} />
                </span>
                <span className="gallery-preview-title" title={previewItem.fileName}>
                  {t.gallery.previewTitle(shortenGalleryFileName(previewItem.fileName))}
                </span>
              </span>
              <span className="badge">{formatGalleryFileSize(previewItem.sizeBytes)}</span>
            </div>
            <div
              className={`gallery-preview-img-wrap ${previewLoaded ? "loaded" : "loading"}`}
            >
              {!previewLoaded
                ? <GalleryImageSkeleton iconSize={28} preview />
                : null}
              <img
                key={previewItem.fileName}
                ref={(imgEl: ProbeableImageElement | null): void => {
                  previewImgRef.current = imgEl;
                  if (
                    imgEl !== null &&
                    typeof imgEl.src === "string" &&
                    imgEl.src.length > 0 &&
                    imgEl.complete === true
                  ) {
                    markPreviewLoaded();
                  }
                }}
                className={`gallery-preview-img ${previewLoaded ? "loaded" : "loading"}`}
                alt={previewItem.fileName}
                decoding="async"
                onLoad={(): void => {
                  markPreviewLoaded();
                }}
                onError={(): void => {
                  markPreviewLoaded();
                }}
                src={buildMiniAppGalleryImageUrl(previewItem.fileName)}
              />
            </div>
            <div className="cap-items" style={{ marginTop: "8px" }}>
              <div className="cap-item">
                <div className="cap-item-top">
                  <span className="cap-tag">SHA-256</span>
                  <span className="cap-sub">
                    {previewItem.mimeType} · {formatGalleryFileSize(previewItem.sizeBytes)}
                  </span>
                </div>
                <div
                  className="cap-val gallery-hash-val"
                  title={previewItem.fileName}
                >
                  {previewItem.fileName}
                </div>
                <div className="cap-sub">{previewItem.updatedAt}</div>
              </div>
            </div>
            <div className="gallery-preview-actions">
              <button
                type="button"
                className="btn primary icon-btn"
                disabled={downloadingFileName !== null || deletingFileName !== null}
                onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
                  (event.currentTarget as unknown as BlurTargetElement).blur?.();
                  handleDownloadImage(previewItem.fileName);
                }}
              >
                <DownloadSvgIcon size={14} />
                <span>
                  {downloadingFileName === previewItem.fileName
                    ? t.gallery.downloadingButton
                    : t.gallery.downloadButton}
                </span>
              </button>
              <button
                type="button"
                className="btn danger icon-btn"
                disabled={deletingFileName !== null || downloadingFileName !== null}
                onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
                  (event.currentTarget as unknown as BlurTargetElement).blur?.();
                  handleDeleteImage(previewItem.fileName);
                }}
              >
                <TrashSvgIcon size={14} />
                <span>
                  {deletingFileName === previewItem.fileName
                    ? t.gallery.deletingButton
                    : t.gallery.deleteButton}
                </span>
              </button>
              <button
                type="button"
                className="btn icon-btn"
                onClick={(): void => {
                  setPreviewItem(null);
                }}
              >
                <CloseSvgIcon size={14} />
                <span>{t.gallery.closePreviewButton}</span>
              </button>
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
                  <div className="gallery-grid">
                    {galleryPage.items.map((item: Readonly<MiniAppGalleryItem>): React.JSX.Element => {
                      const isSelected: boolean =
                        previewItem?.fileName === item.fileName;
                      const isDeleting: boolean =
                        deletingFileName === item.fileName;
                      const isDownloading: boolean =
                        downloadingFileName === item.fileName;
                      const isImgLoaded: boolean =
                        loadedImages[item.fileName] === true;
                      return (
                        <div
                          key={`${batchEpoch}:${item.fileName}`}
                          className={`gallery-card ${isSelected ? "selected" : ""}`}
                          onClick={(): void => {
                            setPreviewItem(isSelected ? null : item);
                          }}
                        >
                          <div
                            className={`gallery-thumb-wrap ${isImgLoaded ? "loaded" : "loading"}`}
                          >
                            {!isImgLoaded
                              ? <GalleryImageSkeleton iconSize={22} />
                              : null}
                            <img
                              ref={(imgEl: ProbeableImageElement | null): void => {
                                if (
                                  imgEl !== null &&
                                  typeof imgEl.src === "string" &&
                                  imgEl.src.length > 0 &&
                                  imgEl.complete === true
                                ) {
                                  markThumbLoaded(item.fileName, batchEpoch);
                                }
                              }}
                              className={`gallery-thumb ${isImgLoaded ? "loaded" : "loading"}`}
                              alt={item.fileName}
                              decoding="async"
                              onLoad={(): void => {
                                markThumbLoaded(item.fileName, batchEpoch);
                              }}
                              onError={(): void => {
                                markThumbLoaded(item.fileName, batchEpoch);
                              }}
                              src={buildMiniAppGalleryImageUrl(item.fileName)}
                            />
                            <button
                              type="button"
                              className={`gallery-card-download-btn ${suppressedHoverFileName === item.fileName ? "hover-suppressed" : ""}`}
                              title={t.gallery.downloadButton}
                              aria-label={t.gallery.downloadButton}
                              disabled={downloadingFileName !== null || deletingFileName !== null}
                              onMouseMove={(event: React.MouseEvent<HTMLButtonElement>): void => {
                                clearHoverSuppressionOnMove(item.fileName, event);
                              }}
                              onMouseLeave={(): void => {
                                clearHoverSuppressionOnLeave(item.fileName);
                              }}
                              onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
                                event.stopPropagation();
                                clickCoordsRef.current = { x: event.clientX, y: event.clientY };
                                (event.currentTarget as unknown as BlurTargetElement).blur?.();
                                handleDownloadImage(item.fileName);
                              }}
                            >
                              <DownloadSvgIcon size={13} />
                            </button>
                            <button
                              type="button"
                              className={`gallery-card-delete-btn ${suppressedHoverFileName === item.fileName ? "hover-suppressed" : ""}`}
                              title={t.gallery.deleteButton}
                              aria-label={t.gallery.deleteButton}
                              disabled={deletingFileName !== null || downloadingFileName !== null}
                              onMouseMove={(event: React.MouseEvent<HTMLButtonElement>): void => {
                                clearHoverSuppressionOnMove(item.fileName, event);
                              }}
                              onMouseLeave={(): void => {
                                clearHoverSuppressionOnLeave(item.fileName);
                              }}
                              onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
                                event.stopPropagation();
                                clickCoordsRef.current = { x: event.clientX, y: event.clientY };
                                (event.currentTarget as unknown as BlurTargetElement).blur?.();
                                handleDeleteImage(item.fileName);
                              }}
                            >
                              <TrashSvgIcon size={13} />
                            </button>
                          </div>
                          <div className="gallery-meta">
                            <div className="gallery-name" title={item.fileName}>
                              {isDeleting
                                ? t.gallery.deletingButton
                                : isDownloading
                                  ? t.gallery.downloadingButton
                                  : shortenGalleryFileName(item.fileName)}
                            </div>
                            <div className="gallery-sub">
                              <span>{formatGalleryFileSize(item.sizeBytes)}</span>
                              <span>{item.updatedAt.slice(5, 16)}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
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
