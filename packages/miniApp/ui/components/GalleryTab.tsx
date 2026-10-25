import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import {
  MINI_APP_GALLERY_DEFAULT_PAGE_SIZE,
  MINI_APP_GALLERY_PAGE_SIZE_OPTIONS,
} from "../../../consts/miniApp";
import type {
  MiniAppGalleryDeleteResult,
  MiniAppGalleryItem,
  MiniAppGalleryPage,
  MiniAppGalleryUploadResult,
  MiniAppLanguage,
} from "../../../types/miniApp";
import {
  CloseSvgIcon,
  DownloadSvgIcon,
  GallerySvgIcon,
  RefreshSvgIcon,
  TrashSvgIcon,
  UploadSvgIcon,
} from "../../miniAppResoures";
import {
  buildMiniAppGalleryImageUrl,
  deleteMiniAppGalleryImageByName,
  downloadMiniAppGalleryImageByName,
  fetchMiniAppGallery,
  uploadMiniAppGalleryImageBytes,
} from "../api";
import { formatGalleryFileSize, shortenGalleryFileName } from "../formatters";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useMiniAppStore } from "../store";
import type { MiniAppUiStoreState } from "../store";
import { PaginationBar } from "./PaginationBar";

/** `GalleryTab` 组件的属性参数。 */
export interface GalleryTabProps {
  /** 触发全局 Toast 提示的回调。 */
  readonly onToast: (message: string) => void;
}

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

/**
 * 图库分页预览、SHA-256 协议上传、单张图片下载与删除管理组件。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function GalleryTab({ onToast }: GalleryTabProps): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const requestConfirm: (
    message: string,
    tone?: "danger" | "primary"
  ) => Promise<boolean> = useMiniAppStore(
    (state: MiniAppUiStoreState): ((message: string, tone?: "danger" | "primary") => Promise<boolean>) =>
      state.requestConfirm
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);

  const [galleryPage, setGalleryPage]: [
    MiniAppGalleryPage | null,
    React.Dispatch<React.SetStateAction<MiniAppGalleryPage | null>>
  ] = useState<MiniAppGalleryPage | null>(null);
  const [page, setPage]: [
    number,
    React.Dispatch<React.SetStateAction<number>>
  ] = useState<number>(1);
  const [pageSize, setPageSize]: [
    number,
    React.Dispatch<React.SetStateAction<number>>
  ] = useState<number>(MINI_APP_GALLERY_DEFAULT_PAGE_SIZE);
  const [loading, setLoading]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(false);
  const [uploading, setUploading]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(false);
  const [deletingFileName, setDeletingFileName]: [
    string | null,
    React.Dispatch<React.SetStateAction<string | null>>
  ] = useState<string | null>(null);
  const [downloadingFileName, setDownloadingFileName]: [
    string | null,
    React.Dispatch<React.SetStateAction<string | null>>
  ] = useState<string | null>(null);
  const [uploadStatusText, setUploadStatusText]: [
    string | null,
    React.Dispatch<React.SetStateAction<string | null>>
  ] = useState<string | null>(null);
  const [previewItem, setPreviewItem]: [
    Readonly<MiniAppGalleryItem> | null,
    React.Dispatch<React.SetStateAction<Readonly<MiniAppGalleryItem> | null>>
  ] = useState<Readonly<MiniAppGalleryItem> | null>(null);
  const previewCardRef: React.RefObject<ScrollablePreviewElement | null> =
    useRef<ScrollablePreviewElement | null>(null);

  useEffect((): void => {
    if (previewItem !== null) {
      previewCardRef.current?.scrollIntoView?.({
        behavior: "smooth",
        block: "start",
      });
    }
  }, [previewItem]);

  const loadGallery: (targetPage?: number, targetPageSize?: number) => Promise<void> =
    useCallback(
      async (targetPage?: number, targetPageSize?: number): Promise<void> => {
        const reqPage: number = targetPage ?? page;
        const reqSize: number = targetPageSize ?? pageSize;
        setLoading(true);
        try {
          const result: MiniAppGalleryPage = await fetchMiniAppGallery(
            reqPage,
            reqSize
          );
          setGalleryPage(result);
          setPage(result.page);
        } catch (error: unknown) {
          const message: string =
            error instanceof Error ? error.message : String(error);
          onToast(message);
        } finally {
          setLoading(false);
        }
      },
      [onToast, page, pageSize]
    );

  useEffect((): void => {
    void loadGallery(1, pageSize);
  }, [pageSize]);

  const handleDownloadImage = async (fileName: string): Promise<void> => {
    setDownloadingFileName(fileName);
    try {
      const accepted: boolean = await downloadMiniAppGalleryImageByName(fileName);
      if (accepted) {
        onToast(t.gallery.downloadedToast(shortenGalleryFileName(fileName)));
      }
    } catch (error: unknown) {
      const message: string =
        error instanceof Error ? error.message : String(error);
      onToast(message);
    } finally {
      setDownloadingFileName(null);
    }
  };

  const handleDeleteImage = async (fileName: string): Promise<void> => {
    if (!(await requestConfirm(t.gallery.confirmDeleteImage(fileName), "danger"))) {
      return;
    }
    setDeletingFileName(fileName);
    try {
      const result: MiniAppGalleryDeleteResult =
        await deleteMiniAppGalleryImageByName(fileName);
      if (result.ok) {
        onToast(t.gallery.deletedToast(fileName));
        if (previewItem?.fileName === fileName) {
          setPreviewItem(null);
        }
        await loadGallery(page, pageSize);
      } else {
        onToast(result.message);
      }
    } catch (error: unknown) {
      const message: string =
        error instanceof Error ? error.message : String(error);
      onToast(message);
    } finally {
      setDeletingFileName(null);
    }
  };

  const handleFilesSelected = async (
    event: React.ChangeEvent<HTMLInputElement>
  ): Promise<void> => {
    const target: FileInputEventTarget =
      event.currentTarget as unknown as FileInputEventTarget;
    const rawFiles: ArrayLike<File> | null | undefined = target.files;
    if (rawFiles === undefined || rawFiles === null || rawFiles.length === 0) {
      return;
    }
    const files: File[] = Array.from(rawFiles);
    target.value = "";

    setUploading(true);
    let added: number = 0;
    let existing: number = 0;
    let invalidDimensions: number = 0;
    let failed: number = 0;
    let lastSingleMessage: string = "";

    try {
      for (let i: number = 0; i < files.length; i++) {
        const file: File | undefined = files[i];
        if (file === undefined) continue;
        setUploadStatusText(`(${i + 1}/${files.length}) ${file.name}…`);
        try {
          const buffer: ArrayBuffer = await file.arrayBuffer();
          const bytes: Uint8Array = new Uint8Array(buffer);
          const result: MiniAppGalleryUploadResult =
            await uploadMiniAppGalleryImageBytes(bytes);
          lastSingleMessage = result.message;
          if (result.outcome === "added") {
            added++;
          } else if (result.outcome === "existing") {
            existing++;
          } else if (result.outcome === "invalidDimensions") {
            invalidDimensions++;
          } else {
            failed++;
          }
        } catch (_error: unknown) {
          failed++;
        }
      }

      if (files.length === 1 && lastSingleMessage.length > 0) {
        onToast(lastSingleMessage);
      } else {
        onToast(
          `+${added} · =${existing} · !${invalidDimensions + failed}♡`
        );
      }
      await loadGallery(1, pageSize);
    } finally {
      setUploading(false);
      setUploadStatusText(null);
    }
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
            <span>{t.gallery.sectionTitle(galleryPage?.total ?? 0)}</span>
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
                onChange={(e: React.ChangeEvent<HTMLInputElement>): void => {
                  void handleFilesSelected(e);
                }}
              />
            </label>
            <button
              type="button"
              className="btn icon-btn"
              disabled={loading || uploading || deletingFileName !== null}
              onClick={(): void => {
                void loadGallery(page, pageSize);
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
              <span>
                {t.gallery.previewTitle(shortenGalleryFileName(previewItem.fileName))}
              </span>
              <div className="toolbar-actions">
                <button
                  type="button"
                  className="btn primary icon-btn"
                  disabled={downloadingFileName !== null || deletingFileName !== null}
                  onClick={(): void => {
                    void handleDownloadImage(previewItem.fileName);
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
                  onClick={(): void => {
                    void handleDeleteImage(previewItem.fileName);
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
            <div className="gallery-preview-img-wrap">
              <img
                className="gallery-preview-img"
                src={buildMiniAppGalleryImageUrl(previewItem.fileName)}
                alt={previewItem.fileName}
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
                <div className="cap-val">{previewItem.fileName}</div>
                <div className="cap-sub">{previewItem.updatedAt}</div>
              </div>
            </div>
          </div>
        )
        : null}

      <div className="card">
        {galleryPage === null
          ? (
            <div className="loading-box">
              <div className="spinner-ring" />
              <div className="loading-text">{t.gallery.loadingText}</div>
            </div>
          )
          : !galleryPage.exists
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
                    return (
                      <div
                        key={item.fileName}
                        className={`gallery-card ${isSelected ? "selected" : ""}`}
                        onClick={(): void => {
                          setPreviewItem(isSelected ? null : item);
                        }}
                      >
                        <div className="gallery-thumb-wrap">
                          <img
                            className="gallery-thumb"
                            src={buildMiniAppGalleryImageUrl(item.fileName)}
                            alt={item.fileName}
                            loading="lazy"
                          />
                          <button
                            type="button"
                            className="gallery-card-download-btn"
                            title={t.gallery.downloadButton}
                            aria-label={t.gallery.downloadButton}
                            disabled={downloadingFileName !== null || deletingFileName !== null}
                            onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
                              event.stopPropagation();
                              void handleDownloadImage(item.fileName);
                            }}
                          >
                            <DownloadSvgIcon size={13} />
                          </button>
                          <button
                            type="button"
                            className="gallery-card-delete-btn"
                            title={t.gallery.deleteButton}
                            aria-label={t.gallery.deleteButton}
                            disabled={deletingFileName !== null || downloadingFileName !== null}
                            onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
                              event.stopPropagation();
                              void handleDeleteImage(item.fileName);
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

        {galleryPage !== null
          ? (
            <PaginationBar
              page={galleryPage.page}
              totalPages={galleryPage.totalPages}
              total={galleryPage.total}
              pageSize={pageSize}
              pageSizeOptions={MINI_APP_GALLERY_PAGE_SIZE_OPTIONS}
              disabled={loading || uploading || deletingFileName !== null}
              onPageChange={(nextPage: number): void => {
                setPreviewItem(null);
                setPage(nextPage);
                void loadGallery(nextPage, pageSize);
              }}
              onPageSizeChange={(nextPageSize: number): void => {
                setPreviewItem(null);
                setPage(1);
                setPageSize(nextPageSize);
              }}
            />
          )
          : null}
      </div>
    </div>
  );
}
