import type React from "react";
import type { MiniAppGlobeIconProps, MiniAppIconProps } from "../../types/miniApp";

/**
 * 渲染亮色主题（太阳）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function SunSvgIcon({
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
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

/**
 * 渲染暗色主题（新月）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function MoonSvgIcon({
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
      <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" />
    </svg>
  );
}

/**
 * 渲染右下角带 `CN` 角标的多语言切换（地球经纬）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function GlobeCnSvgIcon({
  size = 20,
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
      <path d="M9.2 18.16A8 8 0 1 1 17.73 12.27" />
      <line x1="2" y1="10.2" x2="18" y2="10.2" />
      <path d="M9.5 18.1A12.2 12.2 0 0 1 6.8 10.2 12.2 12.2 0 0 1 10 2.2a12.2 12.2 0 0 1 3 10.3" />
      <path
        d="M16 15.6a3.1 3.1 0 1 0 0 5.4M18.2 21.4v-6.2l4.4 6.2v-6.2"
        strokeWidth="1.85"
      />
    </svg>
  );
}

/**
 * 渲染右下角带 `JA` 角标的多语言切换（地球经纬）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function GlobeJaSvgIcon({
  size = 20,
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
      <path d="M9.2 18.16A8 8 0 1 1 17.73 12.27" />
      <line x1="2" y1="10.2" x2="18" y2="10.2" />
      <path d="M9.5 18.1A12.2 12.2 0 0 1 6.8 10.2 12.2 12.2 0 0 1 10 2.2a12.2 12.2 0 0 1 3 10.3" />
      <path
        d="M15.8 15.2v4.2a2 2 0 0 1-4 0v-.6M17.8 21.4 20.3 15.2 22.8 21.4M18.6 19.5h3.4"
        strokeWidth="1.85"
      />
    </svg>
  );
}

/**
 * 渲染右下角带 `EN` 角标的多语言切换（地球经纬）SVG 图标。
 *
 * @param props 图标尺寸与类名
 * @returns SVG 节点
 */
export function GlobeEnSvgIcon({
  size = 20,
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
      <path d="M9.2 18.16A8 8 0 1 1 17.73 12.27" />
      <line x1="2" y1="10.2" x2="18" y2="10.2" />
      <path d="M9.5 18.1A12.2 12.2 0 0 1 6.8 10.2 12.2 12.2 0 0 1 10 2.2a12.2 12.2 0 0 1 3 10.3" />
      <path
        d="M15.8 15.2H12v6.2h3.8M12 18.3h3M18.2 21.4v-6.2l4.4 6.2v-6.2"
        strokeWidth="1.85"
      />
    </svg>
  );
}

/**
 * 根据当前语言键渲染右下角带对应角标（`CN` / `JA` / `EN`）的多语言切换（地球经纬）SVG 图标。
 *
 * @param props 语言键、图标尺寸与类名
 * @returns 对应角标的地球 SVG 节点
 */
export function GlobeSvgIcon({
  language = "zh",
  size = 20,
  className = "",
}: MiniAppGlobeIconProps): React.JSX.Element {
  if (language === "ja") {
    return <GlobeJaSvgIcon size={size} className={className} />;
  }
  if (language === "en") {
    return <GlobeEnSvgIcon size={size} className={className} />;
  }
  return <GlobeCnSvgIcon size={size} className={className} />;
}
