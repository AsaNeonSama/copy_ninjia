import type React from "react";
import {
  MINI_APP_CONFIG_SKELETON_LINE_INDENTS,
  MINI_APP_CONFIG_SKELETON_LINE_INDICES,
  MINI_APP_CONFIG_SKELETON_LINE_WIDTHS,
  MINI_APP_CONFIG_SKELETON_TWO_DIGIT_LINE_START_INDEX,
} from "../../consts/miniAppConfig";

/**
 * 根据骨架屏行序号读取仿 JSON 层级缩进像素值。
 *
 * @param lineIndex 0 起始骨架行序号
 * @returns 左内边距像素字符串
 */
function resolveSkeletonLineIndent(lineIndex: number): string {
  return MINI_APP_CONFIG_SKELETON_LINE_INDENTS[lineIndex] ?? "0px";
}

/**
 * 根据骨架屏行序号读取仿 JSON 键值长度百分比宽度。
 *
 * @param lineIndex 0 起始骨架行序号
 * @returns CSS 宽度百分比字符串
 */
function resolveSkeletonLineWidth(lineIndex: number): string {
  return MINI_APP_CONFIG_SKELETON_LINE_WIDTHS[lineIndex] ?? "16%";
}

/**
 * 渲染配置编辑面板加载配置目录与磁盘文件内容期间的全窗口自适应代码骨架占位卡片：
 * 顶栏状态条、双栏等高 JSON 多层级代码行舞台（`flex: 1 1 0%` 超出高度自动裁切）与仅含「格式化」单个按钮占位的底部动作栏同真实编辑器卡片未修改初始态等高对齐，切换零跳变。
 *
 * @returns React 节点
 */
export function ConfigEditorSkeleton(): React.JSX.Element {
  return (
    <div
      className="card config-editor-skeleton"
      aria-busy="true"
      aria-hidden="true"
    >
      <div className="config-skeleton-shell">
        <div className="config-skeleton-header">
          <div className="skeleton-line skeleton-title-bar config-skeleton-title" />
          <div className="skeleton-line skeleton-badge-pill" />
        </div>
        <div className="config-skeleton-code-frame">
          <div className="config-skeleton-gutter">
            {MINI_APP_CONFIG_SKELETON_LINE_INDICES.map(
              (idx: number): React.JSX.Element => (
                <div key={idx} className="config-skeleton-gutter-row">
                  <div
                    className={`skeleton-line config-skeleton-gutter-num ${idx >= MINI_APP_CONFIG_SKELETON_TWO_DIGIT_LINE_START_INDEX ? "is-two-digit" : ""}`}
                  />
                </div>
              )
            )}
          </div>
          <div className="config-skeleton-lines">
            {MINI_APP_CONFIG_SKELETON_LINE_INDICES.map(
              (idx: number): React.JSX.Element => (
                <div
                  key={idx}
                  className="config-skeleton-line-row"
                  style={{ paddingLeft: resolveSkeletonLineIndent(idx) }}
                >
                  <div
                    className="skeleton-line config-skeleton-code-bar"
                    style={{ width: resolveSkeletonLineWidth(idx) }}
                  />
                </div>
              )
            )}
          </div>
        </div>
      </div>
      <div className="config-skeleton-actions">
        <div className="config-skeleton-actions-secondary">
          <div className="skeleton-line config-skeleton-btn-sm" />
        </div>
      </div>
    </div>
  );
}
