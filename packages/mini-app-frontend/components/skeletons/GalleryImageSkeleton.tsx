import type React from "react";
import { GallerySvgIcon } from "../../resource";

/** `GalleryImageSkeleton` 的属性参数。 */
export interface GalleryImageSkeletonProps {
  /** 中央图库图标边长像素值。 */
  readonly iconSize: number;
  /** 是否为大图预览骨架（附加 `preview-skeleton` 类名）。 */
  readonly preview?: boolean;
}

/**
 * 渲染图库缩略图或大图预览加载完成前的闪光骨架占位。
 *
 * @param props 图标尺寸与是否为大图预览
 * @returns React 节点
 */
export function GalleryImageSkeleton({
  iconSize,
  preview = false,
}: GalleryImageSkeletonProps): React.JSX.Element {
  return (
    <div
      className={preview ? "gallery-img-skeleton preview-skeleton" : "gallery-img-skeleton"}
      aria-hidden="true"
    >
      <span className="gallery-skeleton-icon-pulse">
        <GallerySvgIcon size={iconSize} className="gallery-skeleton-icon" />
      </span>
    </div>
  );
}
