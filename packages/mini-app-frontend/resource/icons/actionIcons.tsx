import type React from "react";
import type { MiniAppIconProps } from "../../types/miniApp";

/**
 * 渲染搜索放大镜 SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function SearchSvgIcon({
  size = 16,
  className = "",
}: MiniAppIconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

/**
 * 渲染加号（添加）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function PlusSvgIcon({
  size = 16,
  className = "",
}: MiniAppIconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

/**
 * 渲染删除（垃圾桶）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function TrashSvgIcon({
  size = 16,
  className = "",
}: MiniAppIconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <polyline points="3 5.5 5 5.5 21 5.5" />
      <path d="M19 5.5v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-14m3 0V3.5a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 1 16 3.5v2" />
      <line x1="10" y1="10" x2="10" y2="16.5" />
      <line x1="14" y1="10" x2="14" y2="16.5" />
    </svg>
  );
}

/**
 * 渲染折叠下拉箭头（Chevron）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function ChevronDownSvgIcon({
  size = 14,
  className = "",
}: MiniAppIconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/**
 * 渲染关闭（叉号）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function CloseSvgIcon({
  size = 16,
  className = "",
}: MiniAppIconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/**
 * 渲染刷新同步（双向旋转箭头）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function RefreshSvgIcon({
  size = 14,
  className = "",
}: MiniAppIconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
      <polyline points="21 3 21 8 16 8" />
    </svg>
  );
}

/**
 * 渲染上传（云端向上箭头）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function UploadSvgIcon({
  size = 14,
  className = "",
}: MiniAppIconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

/**
 * 渲染下载（云端向下箭头）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function DownloadSvgIcon({
  size = 14,
  className = "",
}: MiniAppIconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

/**
 * 渲染返回（向左箭头）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function ArrowLeftSvgIcon({
  size = 14,
  className = "",
}: MiniAppIconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

/**
 * 渲染警告提示（感叹号圆环）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function AlertSvgIcon({
  size = 16,
  className = "",
}: MiniAppIconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
