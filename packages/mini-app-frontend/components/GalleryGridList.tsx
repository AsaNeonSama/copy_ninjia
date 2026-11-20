import { Fragment, memo, useRef, useState } from "react";
import type React from "react";
import { MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX } from "../consts/miniApp";
import {
  blurEventCurrentTarget,
  formatGalleryFileSize,
  shortenGalleryFileName,
} from "../libs/formatters";
import { DownloadSvgIcon, TrashSvgIcon } from "../resource";
import type { MiniAppGalleryItem } from "../types/miniApp/gallery";
import type { MiniAppTranslations } from "../types/miniAppI18n";
import type { ProbeableImageElement } from "./GalleryPreviewCard";
import { GalleryImageSkeleton } from "./skeletons/GalleryImageSkeleton";

/** `GalleryGridList` 图库卡片与操作按钮网格列表的属性参数。 */
export interface GalleryGridListProps {
  /** 当前页的图片条目数组（元数据尚未返回时为 `null`）。 */
  readonly items: readonly Readonly<MiniAppGalleryItem>[] | null;
  /** 是否正在拉取分页元数据（为 `true` 时底部元数据区渲染独立骨架，缩略图区骨架连续播放）。 */
  readonly loading?: boolean;
  /** 元数据加载期间渲染的卡片槽位数量（缺省为 0）。 */
  readonly skeletonCount?: number;
  /** 按文件名索引的 `blob:` 图片对象 URL 映射表（未就绪或缺省时对应图片保持待加载态）。 */
  readonly imageObjectUrls?: Readonly<Record<string, string>>;
  /** 当前处于放大预览中的图片项（未选中时为 `null`）。 */
  readonly previewItem: Readonly<MiniAppGalleryItem> | null;
  /** 正在执行删除的文件名（无在途删除时为 `null`）。 */
  readonly deletingFileName: string | null;
  /** 正在执行下载的文件名（无在途下载时为 `null`）。 */
  readonly downloadingFileName: string | null;
  /** 当前页已加载完成的缩略图文件名映射。 */
  readonly loadedImages: Readonly<Record<string, boolean>>;
  /** 当前页列表批次版本号（用于区分缩略图回调代际）。 */
  readonly batchEpoch: number;
  /** 当前语言的翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 标记某张缩略图已加载完成的回调。 */
  readonly onMarkThumbLoaded: (fileName: string, epoch: number) => void;
  /** 点击缩略图卡片时选中该图片预览的回调（含再次点击当前预览中的图片）。 */
  readonly onSelectPreviewItem: (item: Readonly<MiniAppGalleryItem>) => void;
  /** 触发下载指定文件名图片的回调。 */
  readonly onDownloadImage: (fileName: string) => void;
  /** 触发删除指定文件名图片的回调。 */
  readonly onDeleteImage: (fileName: string) => void;
}

/**
 * 渲染图库页面的缩略图卡片网格及每张卡片上的下载、删除悬浮操作按钮；
 * 元数据拉取期间按 `skeletonCount` 渲染固定槽位卡片（底部元数据区显示独立骨架，缩略图区以稳定槽位键持续复用 `<GalleryImageSkeleton>`）。
 *
 * @param props 组件属性
 * @returns React 节点
 */
function GalleryGridListView({
  items,
  loading = false,
  skeletonCount = 0,
  imageObjectUrls,
  previewItem,
  deletingFileName,
  downloadingFileName,
  loadedImages,
  batchEpoch,
  t,
  onMarkThumbLoaded,
  onSelectPreviewItem,
  onDownloadImage,
  onDeleteImage,
}: GalleryGridListProps): React.JSX.Element {
  const [suppressedHoverFileName, setSuppressedHoverFileName]: [
    string | null,
    React.Dispatch<React.SetStateAction<string | null>>
  ] = useState<string | null>(null);
  const clickCoordsRef: React.RefObject<{ x: number; y: number }> = useRef<{
    x: number;
    y: number;
  }>({ x: -1, y: -1 });

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
      (Math.abs(event.clientX - clickCoordsRef.current.x) >
        MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX ||
        Math.abs(event.clientY - clickCoordsRef.current.y) >
          MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX)
    ) {
      setSuppressedHoverFileName(null);
    }
  };

  const handleCardDownload = (fileName: string): void => {
    setSuppressedHoverFileName(fileName);
    onDownloadImage(fileName);
  };

  const handleCardDelete = (fileName: string): void => {
    setSuppressedHoverFileName(fileName);
    onDeleteImage(fileName);
  };

  const slotCount: number = loading ? skeletonCount : (items?.length ?? 0);

  return (
    <div className="gallery-grid">
      {Array.from(
        { length: slotCount },
        (_: unknown, slotIndex: number): React.JSX.Element => {
          const item: Readonly<MiniAppGalleryItem> | undefined =
            loading ? undefined : items?.[slotIndex];
          const isMetaLoading: boolean = item === undefined;
          const isSelected: boolean =
            item !== undefined && previewItem?.fileName === item.fileName;
          const isDeleting: boolean = deletingFileName === item?.fileName;
          const isDownloading: boolean = downloadingFileName === item?.fileName;
          const isImgLoaded: boolean =
            item !== undefined && loadedImages[item.fileName] === true;
          const resolvedUrl: string | undefined =
            item !== undefined ? imageObjectUrls?.[item.fileName] : undefined;

          return (
            <div
              key={slotIndex}
              className={`gallery-card${isSelected ? " selected" : ""}${isMetaLoading ? " gallery-skeleton-item" : ""}`}
              onClick={
                item !== undefined
                  ? (): void => {
                    onSelectPreviewItem(item);
                  }
                  : undefined
              }
            >
              <div
                className={`gallery-thumb-wrap ${isImgLoaded ? "loaded" : "loading"}`}
              >
                {!isImgLoaded ? <GalleryImageSkeleton key="img-skeleton" iconSize={22} /> : null}
                {item !== undefined
                  ? (
                    <Fragment>
                      <img
                        key={`${batchEpoch}:${item.fileName}`}
                        ref={(imgEl: ProbeableImageElement | null): void => {
                          if (
                            imgEl !== null &&
                            typeof imgEl.src === "string" &&
                            imgEl.src.length > 0 &&
                            imgEl.complete === true
                          ) {
                            onMarkThumbLoaded(item.fileName, batchEpoch);
                          }
                        }}
                        className={`gallery-thumb ${isImgLoaded ? "loaded" : "loading"}`}
                        alt={item.fileName}
                        decoding="async"
                        onLoad={(): void => {
                          onMarkThumbLoaded(item.fileName, batchEpoch);
                        }}
                        onError={(): void => {
                          onMarkThumbLoaded(item.fileName, batchEpoch);
                        }}
                        src={resolvedUrl !== undefined && resolvedUrl.length > 0 ? resolvedUrl : undefined}
                      />
                      <button
                        type="button"
                        className={`gallery-card-download-btn ${suppressedHoverFileName === item.fileName ? "hover-suppressed" : ""}`}
                        title={t.gallery.downloadButton}
                        aria-label={t.gallery.downloadButton}
                        disabled={
                          downloadingFileName !== null || deletingFileName !== null
                        }
                        onMouseMove={(
                          event: React.MouseEvent<HTMLButtonElement>
                        ): void => {
                          clearHoverSuppressionOnMove(item.fileName, event);
                        }}
                        onMouseLeave={(): void => {
                          clearHoverSuppressionOnLeave(item.fileName);
                        }}
                        onClick={(
                          event: React.MouseEvent<HTMLButtonElement>
                        ): void => {
                          event.stopPropagation();
                          clickCoordsRef.current.x = event.clientX;
                          clickCoordsRef.current.y = event.clientY;
                          blurEventCurrentTarget(event);
                          handleCardDownload(item.fileName);
                        }}
                      >
                        <DownloadSvgIcon size={14} />
                      </button>
                      <button
                        type="button"
                        className={`gallery-card-delete-btn ${suppressedHoverFileName === item.fileName ? "hover-suppressed" : ""}`}
                        title={t.gallery.deleteButton}
                        aria-label={t.gallery.deleteButton}
                        disabled={
                          deletingFileName !== null || downloadingFileName !== null
                        }
                        onMouseMove={(
                          event: React.MouseEvent<HTMLButtonElement>
                        ): void => {
                          clearHoverSuppressionOnMove(item.fileName, event);
                        }}
                        onMouseLeave={(): void => {
                          clearHoverSuppressionOnLeave(item.fileName);
                        }}
                        onClick={(
                          event: React.MouseEvent<HTMLButtonElement>
                        ): void => {
                          event.stopPropagation();
                          clickCoordsRef.current.x = event.clientX;
                          clickCoordsRef.current.y = event.clientY;
                          blurEventCurrentTarget(event);
                          handleCardDelete(item.fileName);
                        }}
                      >
                        <TrashSvgIcon size={14} />
                      </button>
                    </Fragment>
                  )
                  : null}
              </div>
              {item === undefined
                ? (
                  <div className="gallery-meta gallery-skeleton-meta" aria-busy="true" aria-hidden="true">
                    <div className="skeleton-line gallery-skeleton-name" />
                    <div className="skeleton-line gallery-skeleton-sub" />
                  </div>
                )
                : (
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
                )}
            </div>
          );
        }
      )}
    </div>
  );
}

/** 按属性浅比较跳过重渲染的图库卡片网格组件（槽位以索引键复用，列表元数据就绪时仅过渡文字区而不重建缩略图骨架节点；预览收起退场帧期间跳过整页缩略图重调和）。 */
export const GalleryGridList: React.MemoExoticComponent<
  typeof GalleryGridListView
> = memo(GalleryGridListView);
