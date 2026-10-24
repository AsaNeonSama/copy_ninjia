import { useCallback, useEffect, useState } from "react";
import type React from "react";
import {
  MINI_APP_GALLERY_DEFAULT_PAGE_SIZE,
  MINI_APP_GALLERY_PAGE_SIZE_OPTIONS,
} from "../../../consts/miniApp";
import type {
  MiniAppGalleryItem,
  MiniAppGalleryPage,
  MiniAppGalleryUploadResult,
} from "../../../types/miniApp";
import {
  buildMiniAppGalleryImageUrl,
  fetchMiniAppGallery,
  uploadMiniAppGalleryImageBytes,
} from "../api";
import { formatGalleryFileSize, shortenGalleryFileName } from "../formatters";
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

/**
 * 图库分页预览与 SHA-256 协议上传管理组件。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function GalleryTab({ onToast }: GalleryTabProps): React.JSX.Element {
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
  const [uploadStatusText, setUploadStatusText]: [
    string | null,
    React.Dispatch<React.SetStateAction<string | null>>
  ] = useState<string | null>(null);
  const [previewItem, setPreviewItem]: [
    Readonly<MiniAppGalleryItem> | null,
    React.Dispatch<React.SetStateAction<Readonly<MiniAppGalleryItem> | null>>
  ] = useState<Readonly<MiniAppGalleryItem> | null>(null);

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
          onToast(`读取图库失败：${message}`);
        } finally {
          setLoading(false);
        }
      },
      [onToast, page, pageSize]
    );

  useEffect((): void => {
    void loadGallery(1, pageSize);
  }, [pageSize]);

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
        setUploadStatusText(`正在校验并入库 (${i + 1}/${files.length})：${file.name}`);
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
          `上传完成：新增 ${added} 张 · 已存在 ${existing} 张 · 尺寸不符 ${invalidDimensions} 张 · 失败 ${failed} 张`
        );
      }
      await loadGallery(1, pageSize);
    } finally {
      setUploading(false);
      setUploadStatusText(null);
    }
  };

  const uploadDisabled: boolean =
    uploading || loading || galleryPage?.exists === false;

  return (
    <div>
      <div className="card">
        <div className="card-title">
          <span>随机图库 (/h_image)</span>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span
              className={`badge ${
                galleryPage === null
                  ? ""
                  : galleryPage.exists
                    ? "ok"
                    : "warn"
              }`}
            >
              {galleryPage === null
                ? "加载中"
                : galleryPage.exists
                  ? `共 ${galleryPage.total} 张`
                  : "目录不存在"}
            </span>
          </div>
        </div>

        <div className="cap-items" style={{ marginBottom: "10px" }}>
          <div className="cap-item">
            <div className="cap-item-top">
              <span className="cap-tag">配置图库目录</span>
              <span className="cap-sub">assets.json · onlyPath.random_h_image_dir</span>
            </div>
            <div className="cap-val">
              {galleryPage !== null ? galleryPage.directory : "正在读取配置路径…"}
            </div>
          </div>
        </div>

        <div className="toolbar" style={{ marginBottom: "6px" }}>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            <label
              className="btn primary"
              style={
                uploadDisabled
                  ? { opacity: 0.45, cursor: "not-allowed", pointerEvents: "none" }
                  : undefined
              }
            >
              {uploading ? "正在上传…" : "＋ 上传图片"}
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
              className="btn"
              disabled={loading || uploading}
              onClick={(): void => {
                void loadGallery(page, pageSize);
              }}
            >
              {loading ? "读取中…" : "刷新"}
            </button>
          </div>
        </div>

        <div className="row-sub">
          协议：支持 JPEG / PNG / WebP（单张 ≤ 10 MiB，宽高之和 ≤ 10000，长宽比 ≤ 20），按内容 SHA-256 命名并自动去重。
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
          <div className="card gallery-preview-card">
            <div className="card-title">
              <span>图片大图预览</span>
              <button
                type="button"
                className="btn"
                onClick={(): void => {
                  setPreviewItem(null);
                }}
              >
                关闭预览
              </button>
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
                  <span className="cap-tag">SHA-256 文件名</span>
                  <span className="cap-sub">
                    {previewItem.mimeType} · {formatGalleryFileSize(previewItem.sizeBytes)}
                  </span>
                </div>
                <div className="cap-val">{previewItem.fileName}</div>
                <div className="cap-sub">修改时间：{previewItem.updatedAt}</div>
              </div>
            </div>
          </div>
        )
        : null}

      <div className="card">
        <div className="card-title">
          <span>图库分页预览</span>
          {galleryPage?.exists === true
            ? (
              <span className="badge">
                第 {galleryPage.page} / {galleryPage.totalPages} 页
              </span>
            )
            : null}
        </div>

        {galleryPage === null
          ? <div className="empty">正在读取图库目录…</div>
          : !galleryPage.exists
            ? <div className="empty">当前配置的图库目录不存在（没有就是没有）</div>
            : galleryPage.items.length === 0
              ? <div className="empty">当前图库目录暂无图片，可点击上方「＋ 上传图片」添加</div>
              : (
                <div className="gallery-grid">
                  {galleryPage.items.map((item: Readonly<MiniAppGalleryItem>): React.JSX.Element => {
                    const isSelected: boolean =
                      previewItem?.fileName === item.fileName;
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
                        </div>
                        <div className="gallery-meta">
                          <div className="gallery-name" title={item.fileName}>
                            {shortenGalleryFileName(item.fileName)}
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
              unitLabel="张"
              disabled={loading || uploading}
              onPageChange={(nextPage: number): void => {
                setPreviewItem(null);
                setPage(nextPage);
                void loadGallery(nextPage, pageSize);
              }}
              onPageSizeChange={(nextPageSize: number): void => {
                setPreviewItem(null);
                setPageSize(nextPageSize);
                setPage(1);
              }}
            />
          )
          : null}
      </div>
    </div>
  );
}
