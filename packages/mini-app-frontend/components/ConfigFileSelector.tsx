import { Fragment, memo, useCallback, useEffect, useRef } from "react";
import type React from "react";
import { MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS } from "../consts/miniApp";
import {
  MINI_APP_CONFIG_SELECTOR_MIN_THUMB_PERCENT,
  MINI_APP_CONFIG_SELECTOR_VISIBLE_OPTIONS,
} from "../consts/miniAppConfig";
import { ChevronDownSvgIcon } from "../resource";
import type {
  MiniAppConfigFileItem,
  MiniAppConfigFileName,
  MiniAppConfigScope,
} from "../types/miniAppConfigs";
import type { MiniAppTranslations } from "../types/miniAppI18n";
import { useDelayedUnmount } from "./animations/useDelayedUnmount";
import type { DelayedUnmountState } from "./animations/useDelayedUnmount";

/** 列表内单个选项节点的纵向几何最小接口。 */
interface SelectorOptionNode {
  /** 选项顶部相对滚动容器内容顶部的像素偏移。 */
  readonly offsetTop?: number;
  /** 选项外盒像素高度。 */
  readonly offsetHeight?: number;
}

/** 可滚动文件列表容器节点的最小接口。 */
interface SelectorScrollableListNode {
  /** 当前纵向滚动像素偏移。 */
  scrollTop: number;
  /** 列表总内容像素高度。 */
  readonly scrollHeight?: number;
  /** 列表可视区像素高度。 */
  readonly clientHeight?: number;
  /** 子元素集合。 */
  readonly children?: ArrayLike<SelectorOptionNode>;
  /** 子节点集合（无 `children` 实现时回退读取）。 */
  readonly childNodes?: ArrayLike<SelectorOptionNode>;
}

/** 视口矩形纵向度量最小接口。 */
interface SelectorBoundingRect {
  /** 元素顶部视口纵坐标。 */
  readonly top: number;
  /** 元素外盒像素高度。 */
  readonly height: number;
}

/** 纵向高度滑条轨道节点的最小接口。 */
interface SelectorScrollTrackNode {
  /** 读取轨道当前视口矩形。 */
  readonly getBoundingClientRect?: () => SelectorBoundingRect;
  /** 捕获指定指针 ID 的后续移动事件。 */
  readonly setPointerCapture?: (pointerId: number) => void;
  /** 释放已捕获的指针 ID。 */
  readonly releasePointerCapture?: (pointerId: number) => void;
}

/** 纵向高度滑条滑块节点的最小接口。 */
interface SelectorScrollThumbNode {
  /** 行内样式映射（直接同步 `height` 与 `top` 百分比，避免滚动触发 React 重渲染）。 */
  readonly style?: Record<string, string>;
  /** 读取滑块当前视口矩形。 */
  readonly getBoundingClientRect?: () => SelectorBoundingRect;
  /** 类名列表（拖拽期间切换 `.dragging` 强调态）。 */
  readonly classList?: Readonly<{
    readonly add?: (token: string) => void;
    readonly remove?: (token: string) => void;
  }>;
}

/** `computeConfigSelectorThumbMetrics` 计算纵向高度滑条比例的入参。 */
export interface ConfigSelectorThumbMetricsInput {
  /** 列表当前纵向滚动偏移像素（`scrollTop`）。 */
  readonly scrollTop: number;
  /** 列表内容总像素高度（`scrollHeight`）。 */
  readonly scrollHeight: number;
  /** 列表可视窗口像素高度（`clientHeight`）。 */
  readonly clientHeight: number;
  /** 当前分组的配置文件总数。 */
  readonly itemCount: number;
}

/** 下拉文件列表纵向高度滑条的滑块百分比尺寸与偏移。 */
export interface ConfigSelectorThumbMetrics {
  /** 滑块高度占轨道高度的百分比（`MINI_APP_CONFIG_SELECTOR_MIN_THUMB_PERCENT`–`100`）。 */
  readonly heightPercent: number;
  /** 滑块顶部相对轨道顶部的百分比偏移（`0`–`100 - heightPercent`）。 */
  readonly topPercent: number;
}

/**
 * 根据滚动容器度量（无真实布局引擎时按可见项数与总项数比值回退）计算高度滑条滑块的百分比高度与纵向偏移。
 *
 * @param input 滚动位置、容器高度与选项总数
 * @returns 滑块高度百分比与顶部偏移百分比
 */
export function computeConfigSelectorThumbMetrics({
  scrollTop,
  scrollHeight,
  clientHeight,
  itemCount,
}: ConfigSelectorThumbMetricsInput): Readonly<ConfigSelectorThumbMetrics> {
  if (clientHeight > 0 && scrollHeight > clientHeight) {
    const rawHeightPercent: number = (clientHeight / scrollHeight) * 100;
    const heightPercent: number = Math.min(
      100,
      Math.max(MINI_APP_CONFIG_SELECTOR_MIN_THUMB_PERCENT, rawHeightPercent)
    );
    const maxScrollTop: number = scrollHeight - clientHeight;
    const clampedRatio: number = Math.min(
      1,
      Math.max(0, scrollTop / maxScrollTop)
    );
    return {
      heightPercent,
      topPercent: clampedRatio * (100 - heightPercent),
    };
  }

  if (itemCount > MINI_APP_CONFIG_SELECTOR_VISIBLE_OPTIONS) {
    const fallbackHeightPercent: number = Math.min(
      100,
      Math.max(
        MINI_APP_CONFIG_SELECTOR_MIN_THUMB_PERCENT,
        (MINI_APP_CONFIG_SELECTOR_VISIBLE_OPTIONS / itemCount) * 100
      )
    );
    return {
      heightPercent: fallbackHeightPercent,
      topPercent: 0,
    };
  }

  return {
    heightPercent: 100,
    topPercent: 0,
  };
}

/** `ConfigFileSelector` 配置文件下拉选择器的属性参数。 */
export interface ConfigFileSelectorProps {
  /** 当前激活的配置分组（切换分组时立即重置下拉快照）。 */
  readonly scope: MiniAppConfigScope;
  /** 当前分组可选的配置文件条目列表。 */
  readonly items: readonly Readonly<MiniAppConfigFileItem>[];
  /** 当前选中的配置文件名。 */
  readonly selectedFile: MiniAppConfigFileName;
  /** 当前选中的文件在服务端磁盘上是否已存在。 */
  readonly fileExists: boolean;
  /** 当前编辑器草稿是否存在未保存改动。 */
  readonly isDirty: boolean;
  /** 下拉弹出层是否处于展开状态。 */
  readonly menuOpen: boolean;
  /** 是否因加载、格式化、还原、保存或服务重启而禁用切换。 */
  readonly disabled: boolean;
  /** 当前语言的界面文案字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 切换下拉面板展开/收起状态的回调。 */
  readonly onToggleMenu: () => void;
  /** 关闭下拉面板的回调。 */
  readonly onCloseMenu: () => void;
  /** 选择目标配置文件的回调。 */
  readonly onSelectFile: (fileName: MiniAppConfigFileName) => void;
}

/**
 * 渲染配置文件选择器触发栏与三项限高的新粗野主义下拉列表：
 * - 触发栏与实时状态子系统能力折叠头（`CapabilityBlock`）保持同一视觉语言：左侧就绪状态方点、等宽文件名、序号/未保存胶囊与单行说明，右侧状态徽章与折角翻转箭头胶囊；
 * - 展开面板底部高亮锚定，列表可视高度收敛为 3 个选项，超出 3 项时右侧渲染可点击跳转与指针拖拽的新粗野主义平行四边形纵向高度滑条；
 * - 展开项采用左边框色带与标签胶囊排版，当前选中项复用实时状态面板的柔和底色、强调左色带与亮柠序号戳记；静止态驻留主绘制层，仅 `.closing` 阶段提升合成层。
 *
 * @param props 组件属性
 * @returns React 节点
 */
function ConfigFileSelectorView({
  scope,
  items,
  selectedFile,
  fileExists,
  isDirty,
  menuOpen,
  disabled,
  t,
  onToggleMenu,
  onCloseMenu,
  onSelectFile,
}: ConfigFileSelectorProps): React.JSX.Element {
  const {
    displayValue: displayOpen,
    isClosing,
  }: Readonly<DelayedUnmountState<true>> = useDelayedUnmount(
    menuOpen ? true : null,
    MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS,
    scope
  );

  const listRef: React.RefObject<SelectorScrollableListNode | null> =
    useRef<SelectorScrollableListNode | null>(null);
  const trackRef: React.RefObject<SelectorScrollTrackNode | null> =
    useRef<SelectorScrollTrackNode | null>(null);
  const thumbRef: React.RefObject<SelectorScrollThumbNode | null> =
    useRef<SelectorScrollThumbNode | null>(null);
  const dragPointerIdRef: React.RefObject<number | null> =
    useRef<number | null>(null);
  const dragGrabOffsetPxRef: React.RefObject<number> = useRef<number>(0);
  const prevMenuOpenRef: React.RefObject<boolean> = useRef<boolean>(false);

  const selectedIndex: number = items.findIndex(
    (item: Readonly<MiniAppConfigFileItem>): boolean =>
      item.fileName === selectedFile
  );
  const resolvedOrder: number = selectedIndex >= 0 ? selectedIndex + 1 : 1;
  const totalCount: number = items.length > 0 ? items.length : 1;
  const summaryCountLabel: string = `${resolvedOrder
    .toString()
    .padStart(2, "0")}/${totalCount.toString().padStart(2, "0")}`;
  const hasScrollOverflow: boolean =
    items.length > MINI_APP_CONFIG_SELECTOR_VISIBLE_OPTIONS;

  const syncScrollbarThumb: () => void = useCallback((): void => {
    const thumb: SelectorScrollThumbNode | null = thumbRef.current;
    if (thumb?.style === undefined) {
      return;
    }
    const list: SelectorScrollableListNode | null = listRef.current;
    const metrics: Readonly<ConfigSelectorThumbMetrics> =
      computeConfigSelectorThumbMetrics({
        scrollTop: list?.scrollTop ?? 0,
        scrollHeight: list?.scrollHeight ?? 0,
        clientHeight: list?.clientHeight ?? 0,
        itemCount: items.length,
      });
    thumb.style.height = `${metrics.heightPercent.toFixed(2)}%`;
    thumb.style.top = `${metrics.topPercent.toFixed(2)}%`;
  }, [items.length]);

  const setListNode: (el: unknown) => void = useCallback(
    (el: unknown): void => {
      listRef.current = el as SelectorScrollableListNode | null;
    },
    []
  );
  const setTrackNode: (el: unknown) => void = useCallback(
    (el: unknown): void => {
      trackRef.current = el as SelectorScrollTrackNode | null;
    },
    []
  );
  const setThumbNode: (el: unknown) => void = useCallback(
    (el: unknown): void => {
      thumbRef.current = el as SelectorScrollThumbNode | null;
      if (el !== null) {
        syncScrollbarThumb();
      }
    },
    [syncScrollbarThumb]
  );

  useEffect((): void => {
    const justOpened: boolean = menuOpen && !prevMenuOpenRef.current;
    prevMenuOpenRef.current = menuOpen;

    if (displayOpen === null || isClosing || disabled) {
      if (dragPointerIdRef.current !== null) {
        const pointerId: number = dragPointerIdRef.current;
        dragPointerIdRef.current = null;
        trackRef.current?.releasePointerCapture?.(pointerId);
        thumbRef.current?.classList?.remove?.("dragging");
      }
      if (displayOpen === null || isClosing) {
        return;
      }
    }

    const list: SelectorScrollableListNode | null = listRef.current;
    if (justOpened && list !== null && selectedIndex >= 0) {
      const clientH: number = list.clientHeight ?? 0;
      const scrollH: number = list.scrollHeight ?? 0;
      const optionCollection: ArrayLike<SelectorOptionNode> | undefined =
        list.children ?? list.childNodes;
      const activeNode: SelectorOptionNode | undefined =
        optionCollection?.[selectedIndex];
      const optionTop: number | undefined = activeNode?.offsetTop;
      const optionHeight: number | undefined = activeNode?.offsetHeight;
      if (
        clientH > 0 &&
        scrollH > clientH &&
        optionTop !== undefined &&
        optionHeight !== undefined
      ) {
        if (optionTop + optionHeight > list.scrollTop + clientH) {
          list.scrollTop = optionTop + optionHeight - clientH;
        } else if (optionTop < list.scrollTop) {
          list.scrollTop = optionTop;
        }
      }
    }
    syncScrollbarThumb();
  }, [
    disabled,
    displayOpen,
    isClosing,
    menuOpen,
    selectedIndex,
    syncScrollbarThumb,
  ]);

  const applyPointerPositionToScroll: (
    clientY: number,
    grabOffsetPx: number
  ) => void = useCallback(
    (clientY: number, grabOffsetPx: number): void => {
      const list: SelectorScrollableListNode | null = listRef.current;
      const track: SelectorScrollTrackNode | null = trackRef.current;
      const thumb: SelectorScrollThumbNode | null = thumbRef.current;
      if (list === null || track?.getBoundingClientRect === undefined) {
        return;
      }
      const scrollHeight: number = list.scrollHeight ?? 0;
      const clientHeight: number = list.clientHeight ?? 0;
      if (scrollHeight <= clientHeight || clientHeight <= 0) {
        return;
      }
      const trackRect: SelectorBoundingRect = track.getBoundingClientRect();
      if (trackRect.height <= 0) {
        return;
      }
      const metrics: Readonly<ConfigSelectorThumbMetrics> =
        computeConfigSelectorThumbMetrics({
          scrollTop: list.scrollTop,
          scrollHeight,
          clientHeight,
          itemCount: items.length,
        });
      const measuredThumbH: number =
        thumb?.getBoundingClientRect?.().height ?? 0;
      const thumbHeightPx: number =
        measuredThumbH > 0
          ? measuredThumbH
          : (trackRect.height * metrics.heightPercent) / 100;
      const movableTrackPx: number = Math.max(
        1,
        trackRect.height - thumbHeightPx
      );
      const desiredTopPx: number = Math.min(
        movableTrackPx,
        Math.max(0, clientY - trackRect.top - grabOffsetPx)
      );
      list.scrollTop =
        (desiredTopPx / movableTrackPx) * (scrollHeight - clientHeight);
      syncScrollbarThumb();
    },
    [items.length, syncScrollbarThumb]
  );

  const handleScrollbarPointerDown: (
    event: React.PointerEvent<HTMLDivElement>
  ) => void = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (isClosing || disabled) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const thumbRect: SelectorBoundingRect | undefined =
        thumbRef.current?.getBoundingClientRect?.();
      let grabOffsetPx: number = (thumbRect?.height ?? 0) / 2;
      let clickedThumbDirectly: boolean = false;
      if (
        thumbRect !== undefined &&
        thumbRect.height > 0 &&
        event.clientY >= thumbRect.top &&
        event.clientY <= thumbRect.top + thumbRect.height
      ) {
        grabOffsetPx = event.clientY - thumbRect.top;
        clickedThumbDirectly = true;
      }
      dragPointerIdRef.current = event.pointerId;
      dragGrabOffsetPxRef.current = grabOffsetPx;
      trackRef.current?.setPointerCapture?.(event.pointerId);
      thumbRef.current?.classList?.add?.("dragging");
      if (!clickedThumbDirectly) {
        applyPointerPositionToScroll(event.clientY, grabOffsetPx);
      }
    },
    [applyPointerPositionToScroll, disabled, isClosing]
  );

  const handleScrollbarPointerMove: (
    event: React.PointerEvent<HTMLDivElement>
  ) => void = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (
        disabled ||
        isClosing ||
        dragPointerIdRef.current !== event.pointerId
      ) {
        return;
      }
      event.preventDefault();
      applyPointerPositionToScroll(event.clientY, dragGrabOffsetPxRef.current);
    },
    [applyPointerPositionToScroll, disabled, isClosing]
  );

  const handleScrollbarPointerEnd: (
    event: React.PointerEvent<HTMLDivElement>
  ) => void = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (dragPointerIdRef.current !== event.pointerId) {
        return;
      }
      dragPointerIdRef.current = null;
      trackRef.current?.releasePointerCapture?.(event.pointerId);
      thumbRef.current?.classList?.remove?.("dragging");
    },
    []
  );

  const handleBackdropClick: () => void = useCallback((): void => {
    if (!isClosing) {
      onCloseMenu();
    }
  }, [isClosing, onCloseMenu]);

  return (
    <div className="config-selector-wrap">
      <button
        type="button"
        className={`config-selector-trigger ${menuOpen ? "open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={menuOpen}
        aria-label={t.configs.fileSelectorAria}
        disabled={disabled}
        onClick={onToggleMenu}
      >
        <span className="config-selector-main">
          <span className="config-selector-title-row">
            <span
              className={`config-selector-status-dot ${fileExists ? "ok" : "warn"}`}
              aria-hidden="true"
            />
            <span className="config-selector-name">{selectedFile}</span>
            <span
              className={`config-selector-summary-pill ${isDirty ? "is-dirty" : ""}`}
            >
              {isDirty ? t.configs.dirtyBadge : summaryCountLabel}
            </span>
          </span>
          <span className="config-selector-desc">
            {t.configs.fileDescriptions[selectedFile]}
          </span>
        </span>
        <span className="config-selector-right">
          <span
            className={`badge config-selector-status-badge ${fileExists ? "ok" : "warn"}`}
          >
            {fileExists
              ? t.configs.fileExistsBadge
              : t.configs.fileMissingBadge}
          </span>
          <span
            className={`config-selector-chevron-pill ${menuOpen ? "open" : ""}`}
            aria-hidden="true"
          >
            <ChevronDownSvgIcon
              size={14}
              className={`chevron-icon ${menuOpen ? "rotated" : ""}`}
            />
          </span>
        </span>
      </button>

      {displayOpen !== null ? (
        <Fragment>
          <div
            className={`config-selector-backdrop ${isClosing ? "closing" : ""}`}
            aria-hidden="true"
            onClick={handleBackdropClick}
          />
          <div
            className={`config-selector-popover ${isClosing ? "closing" : ""}`}
            aria-hidden={isClosing}
          >
            <div
              ref={setListNode}
              className="config-selector-list"
              role="listbox"
              aria-label={t.configs.fileSelectorAria}
              onScroll={syncScrollbarThumb}
            >
              {items.map(
                (
                  item: Readonly<MiniAppConfigFileItem>,
                  index: number
                ): React.JSX.Element => {
                  const isSelected: boolean = item.fileName === selectedFile;
                  const optionIndexLabel: string = (index + 1)
                    .toString()
                    .padStart(2, "0");
                  return (
                    <button
                      key={item.fileName}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      disabled={isClosing || disabled}
                      className={`config-selector-option ${isSelected ? "active" : ""}`}
                      onClick={(): void => {
                        onSelectFile(item.fileName);
                      }}
                    >
                      <span className="config-selector-option-top">
                        <span className="config-selector-option-head">
                          <span
                            className="config-selector-option-index"
                            aria-hidden="true"
                          >
                            {optionIndexLabel}
                          </span>
                          <span className="config-selector-option-name">
                            {item.fileName}
                          </span>
                        </span>
                        <span
                          className={`badge config-selector-option-status ${item.exists ? "ok" : "warn"}`}
                        >
                          {item.exists
                            ? t.configs.fileExistsBadge
                            : t.configs.fileMissingBadge}
                        </span>
                      </span>
                      <span className="config-selector-option-desc">
                        {t.configs.fileDescriptions[item.fileName]}
                      </span>
                    </button>
                  );
                }
              )}
            </div>

            {hasScrollOverflow ? (
              <div
                ref={setTrackNode}
                className="config-selector-scrollbar"
                aria-hidden="true"
                onPointerDown={handleScrollbarPointerDown}
                onPointerMove={handleScrollbarPointerMove}
                onPointerUp={handleScrollbarPointerEnd}
                onPointerCancel={handleScrollbarPointerEnd}
              >
                <div
                  ref={setThumbNode}
                  className="config-selector-scrollbar-thumb"
                />
              </div>
            ) : null}
          </div>
        </Fragment>
      ) : null}
    </div>
  );
}

/** 按属性浅比较跳过重渲染的配置文件下拉选择器组件。 */
export const ConfigFileSelector: React.MemoExoticComponent<
  typeof ConfigFileSelectorView
> = memo(ConfigFileSelectorView);
