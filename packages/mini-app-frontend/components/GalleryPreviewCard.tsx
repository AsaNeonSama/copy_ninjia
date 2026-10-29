import { useEffect, useRef } from "react";
import type React from "react";
import { buildMiniAppGalleryImageUrl } from "../api/galleryFile";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import {
  formatGalleryFileSize,
  shortenGalleryFileName,
} from "../libs/formatters";
import {
  CloseSvgIcon,
  DownloadSvgIcon,
  GallerySvgIcon,
  TrashSvgIcon,
} from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import type {
  MiniAppGalleryItem,
  MiniAppLanguage,
} from "../types/miniApp";
import { GalleryImageSkeleton } from "./skeletons/GalleryImageSkeleton";

/** 支持主动失焦（`blur`）的按钮事件目标接口。 */
export interface BlurTargetElement {
  /** 移除当前按钮焦点，防止原生弹窗关闭后残留悬停或焦点态。 */
  readonly blur?: () => void;
}

/** 支持缓存完成态探测的 `<img>` DOM 节点最小类型接口。 */
export interface ProbeableImageElement {
  /** 浏览器是否已完成该图片加载或解码（含内存缓存命中）。 */
  readonly complete?: boolean;
  /** 当前绑定的图片资源地址。 */
  readonly src?: string;
}

/** `GalleryPreviewCard` 组件属性参数。 */
export interface GalleryPreviewCardProps {
  /** 当前正在预览的图片条目。 */
  readonly previewItem: Readonly<MiniAppGalleryItem>;
  /** 预览大图是否已加载完成。 */
  readonly previewLoaded: boolean;
  /** 是否正处于收起退场动画阶段。 */
  readonly isClosing?: boolean;
  /** 当前正在下载的文件名（无则为 `null`）。 */
  readonly downloadingFileName: string | null;
  /** 当前正在删除的文件名（无则为 `null`）。 */
  readonly deletingFileName: string | null;
  /** 标记预览大图加载完成。 */
  readonly onMarkPreviewLoaded: () => void;
  /** 触发下载指定文件。 */
  readonly onDownloadImage: (fileName: string) => void;
  /** 触发删除指定文件。 */
  readonly onDeleteImage: (fileName: string) => void;
  /** 关闭预览面板。 */
  readonly onClosePreview: () => void;
}

/**
 * 渲染图库单张大图预览卡片（含内存缓存探测、SHA-256 摘要信息及下载/删除/关闭动作栏）。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function GalleryPreviewCard({
  previewItem,
  previewLoaded,
  isClosing = false,
  downloadingFileName,
  deletingFileName,
  onMarkPreviewLoaded,
  onDownloadImage,
  onDeleteImage,
  onClosePreview,
}: GalleryPreviewCardProps): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const previewImgRef: React.RefObject<ProbeableImageElement | null> =
    useRef<ProbeableImageElement | null>(null);

  useEffect((): void => {
    if (isClosing) {
      return;
    }
    const imgEl: ProbeableImageElement | null = previewImgRef.current;
    if (
      imgEl !== null &&
      typeof imgEl.src === "string" &&
      imgEl.src.length > 0 &&
      imgEl.complete === true
    ) {
      onMarkPreviewLoaded();
    }
  }, [isClosing, onMarkPreviewLoaded, previewItem]);

  return (
    <div className="card gallery-preview-card">
      <div className="card-title">
        <span className="toolbar-hint" style={{ minWidth: 0, flex: 1 }}>
          <span className="toolbar-icon-badge">
            <GallerySvgIcon size={16} />
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
              onMarkPreviewLoaded();
            }
          }}
          className={`gallery-preview-img ${previewLoaded ? "loaded" : "loading"}`}
          alt={previewItem.fileName}
          decoding="async"
          onLoad={(): void => {
            onMarkPreviewLoaded();
          }}
          onError={(): void => {
            onMarkPreviewLoaded();
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
          disabled={isClosing || downloadingFileName !== null || deletingFileName !== null}
          onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
            (event.currentTarget as unknown as BlurTargetElement).blur?.();
            onDownloadImage(previewItem.fileName);
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
          disabled={isClosing || deletingFileName !== null || downloadingFileName !== null}
          onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
            (event.currentTarget as unknown as BlurTargetElement).blur?.();
            onDeleteImage(previewItem.fileName);
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
          disabled={isClosing}
          onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
            (event.currentTarget as unknown as BlurTargetElement).blur?.();
            onClosePreview();
          }}
        >
          <CloseSvgIcon size={14} />
          <span>{t.gallery.closePreviewButton}</span>
        </button>
      </div>
    </div>
  );
}
