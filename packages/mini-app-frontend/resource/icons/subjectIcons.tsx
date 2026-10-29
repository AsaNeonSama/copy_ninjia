import type React from "react";
import type { MiniAppIconProps } from "../../types/miniApp";

/**
 * 渲染联系人/好友（单人轮廓）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function UserSvgIcon({
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
      <path d="M19 20.5v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7.5" r="4" />
    </svg>
  );
}

/**
 * 渲染广播频道（扩音器）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function ChannelSvgIcon({
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
      <path d="m3 10 18-5v12L3 13v-3z" />
      <path d="M11.6 15.8a3 3 0 1 1-5.8-1.6" />
    </svg>
  );
}

/**
 * 渲染数字 ID（井号）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function HashtagSvgIcon({
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
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
  );
}
