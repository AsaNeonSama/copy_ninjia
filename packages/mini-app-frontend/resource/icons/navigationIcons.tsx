import type React from "react";
import type { MiniAppIconProps, MiniAppTabIconProps } from "../../types/miniApp";

/**
 * 渲染侧边栏展开/收起汉堡菜单 SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function MenuSvgIcon({
  size = 22,
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
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  );
}

/**
 * 渲染实时状态（雷达脉冲）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function StatusSvgIcon({
  size = 18,
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
      <polyline points="3 12 7 12 10 5 14 19 17 12 21 12" />
    </svg>
  );
}

/**
 * 渲染受管群聊（气泡会话）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function ChatsSvgIcon({
  size = 18,
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
      <path d="M21 15a2 2 0 0 1-2 2H8l-5 3V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <line x1="8" y1="10" x2="16" y2="10" />
      <line x1="8" y1="13.5" x2="13" y2="13.5" />
    </svg>
  );
}

/**
 * 渲染黑白名单与权限矩阵（护盾徽章）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function IdentitiesSvgIcon({
  size = 18,
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
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/**
 * 渲染色图库（画框相册）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function GallerySvgIcon({
  size = 18,
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
      <rect x="3" y="3" width="18" height="18" rx="3" ry="3" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  );
}

/**
 * 渲染密码锁 / 锁定会话 SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function LockSvgIcon({
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
      <rect x="5" y="10.5" width="14" height="10" rx="2" ry="2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </svg>
  );
}

/**
 * 根据主导航标签键渲染对应的菜单 SVG 图标。
 *
 * @param props 标签键、尺寸与类名
 * @returns 对应的 SVG 图标节点
 */
export function TabSvgIcon({
  tabKey,
  size = 18,
  className = "",
}: MiniAppTabIconProps): React.JSX.Element {
  if (tabKey === "status") {
    return <StatusSvgIcon size={size} className={className} />;
  }
  if (tabKey === "chats") {
    return <ChatsSvgIcon size={size} className={className} />;
  }
  if (tabKey === "identities") {
    return <IdentitiesSvgIcon size={size} className={className} />;
  }
  if (tabKey === "totp") {
    return <LockSvgIcon size={size} className={className} />;
  }
  return <GallerySvgIcon size={size} className={className} />;
}
