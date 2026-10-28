import { useCallback, useEffect } from "react";
import type React from "react";
import type { MiniAppChatTargetKind } from "../../types/miniApp";

/** 支持读取像素高度并写入行内高度过渡样式的弹窗内容容器最小 DOM 接口。 */
export interface MeasurableModalBodyElement {
  /** 元素包含内边距的像素高度。 */
  readonly offsetHeight?: number;
  /** 元素内容总像素高度。 */
  readonly scrollHeight?: number;
  /** 行内样式对象。 */
  readonly style?: {
    height: string;
    overflow: string;
    transition: string;
  };
}

/** 支持读取或设置 `overflow` 行内样式的文档节点最小接口。 */
interface ScrollLockableDocumentHost {
  /** `<html>` 根节点。 */
  readonly documentElement?: {
    readonly style?: {
      overflow: string;
    };
  };
  /** `<body>` 节点。 */
  readonly body?: {
    readonly style?: {
      overflow: string;
    };
  };
}

/** 支持平滑滚动至顶部的弹窗内容滚动容器最小 DOM 接口。 */
export interface ScrollableModalBodyElement {
  /** 当前纵向滚动偏移量。 */
  scrollTop?: number;
  /** 平滑滚动至指定坐标。 */
  readonly scrollTo?: (options: {
    readonly top: number;
    readonly behavior: "smooth" | "auto";
  }) => void;
}

/**
 * 读取弹窗内容容器的当前像素高度（在非真实 DOM 测试环境下安全返回 `0`）。
 *
 * @param element 弹窗内容容器节点
 * @returns 像素高度
 */
export function readModalBodyHeight(
  element: MeasurableModalBodyElement | null
): number {
  if (element === null) return 0;
  const offset: number = element.offsetHeight ?? 0;
  if (offset > 0) return offset;
  return element.scrollHeight ?? 0;
}

/**
 * 将弹窗内部滚动容器平滑上滑至顶部（优先调用 `scrollTo({ top: 0, behavior: "smooth" })`，降级时置 `scrollTop = 0`）。
 *
 * @param element 弹窗内部滚动容器节点
 */
export function scrollModalBodyToTop(
  element: ScrollableModalBodyElement | null
): void {
  if (element === null) return;
  if (typeof element.scrollTo === "function") {
    element.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  if (typeof element.scrollTop === "number") {
    element.scrollTop = 0;
  }
}

/**
 * 在弹窗打开期间锁定外层文档（`<html>` 与 `<body>`）滚动，卸载或关闭后自动恢复原 `overflow` 值。
 *
 * @param isModalOpen 弹窗当前是否处于打开或关闭动画阶段
 */
export function useModalBodyScrollLock(isModalOpen: boolean): void {
  useEffect((): (() => void) | undefined => {
    if (!isModalOpen) {
      return undefined;
    }
    const doc: ScrollLockableDocumentHost | undefined = (
      globalThis as { readonly document?: ScrollLockableDocumentHost }
    ).document;
    const htmlStyle: { overflow: string } | undefined =
      doc?.documentElement?.style;
    const bodyStyle: { overflow: string } | undefined = doc?.body?.style;
    const prevHtmlOverflow: string = htmlStyle?.overflow ?? "";
    const prevBodyOverflow: string = bodyStyle?.overflow ?? "";
    if (htmlStyle !== undefined) {
      htmlStyle.overflow = "hidden";
    }
    if (bodyStyle !== undefined) {
      bodyStyle.overflow = "hidden";
    }
    return (): void => {
      if (htmlStyle !== undefined) {
        htmlStyle.overflow = prevHtmlOverflow;
      }
      if (bodyStyle !== undefined) {
        bodyStyle.overflow = prevBodyOverflow;
      }
    };
  }, [isModalOpen]);
}

/** `TabHeightSizer` 弹窗标签页切换高度过渡容器的属性参数。 */
export interface TabHeightSizerProps {
  /** 当前激活的目标类别（关闭时为 `null`）。 */
  readonly activeTab: MiniAppChatTargetKind | null;
  /** 目标数据是否已加载完成。 */
  readonly hasTargets: boolean;
  /** 外层高度过渡容器节点引用。 */
  readonly sizerRef: React.RefObject<MeasurableModalBodyElement | null>;
  /** 内层面板节点引用。 */
  readonly paneRef: React.RefObject<MeasurableModalBodyElement | null>;
  /** 上一次记录的内容像素高度引用。 */
  readonly lastHeightRef: React.RefObject<number>;
  /** 上一次渲染的目标类别引用。 */
  readonly prevTabRef: React.RefObject<MiniAppChatTargetKind | null>;
  /** 上一次是否已加载目标数据的标记引用。 */
  readonly prevHadTargetsRef: React.RefObject<boolean>;
  /** 当前标签页内部渲染内容。 */
  readonly children: React.ReactNode;
}

/**
 * 在弹窗内切换不同标签页或首次注水完成时测量前后像素高度，通过 CSS `height` 过渡平滑改变弹窗内容高度，
 * 过渡结束后恢复自适应高度以保证内部列表正常滚动。
 *
 * @param props 高度过渡容器属性
 * @returns React 节点
 */
export function TabHeightSizer({
  activeTab,
  hasTargets,
  sizerRef,
  paneRef,
  lastHeightRef,
  prevTabRef,
  prevHadTargetsRef,
  children,
}: TabHeightSizerProps): React.JSX.Element {
  const setSizerNode: (el: MeasurableModalBodyElement | null) => void =
    useCallback(
      (el: MeasurableModalBodyElement | null): void => {
        sizerRef.current = el;
      },
      [sizerRef]
    );
  const setPaneNode: (el: MeasurableModalBodyElement | null) => void =
    useCallback(
      (el: MeasurableModalBodyElement | null): void => {
        paneRef.current = el;
        const measured: number = readModalBodyHeight(el);
        if (measured > 0 && lastHeightRef.current === 0) {
          lastHeightRef.current = measured;
        }
      },
      [lastHeightRef, paneRef]
    );

  useEffect((): (() => void) | undefined => {
    if (activeTab === null) {
      prevTabRef.current = null;
      prevHadTargetsRef.current = false;
      lastHeightRef.current = 0;
      return undefined;
    }
    const prevTab: MiniAppChatTargetKind | null = prevTabRef.current;
    const prevHadTargets: boolean = prevHadTargetsRef.current;
    prevTabRef.current = activeTab;
    prevHadTargetsRef.current = hasTargets;

    const nextHeight: number = readModalBodyHeight(paneRef.current);
    const prevHeight: number = lastHeightRef.current;
    if (nextHeight > 0) {
      lastHeightRef.current = nextHeight;
    }
    const tabChanged: boolean = prevTab !== null && prevTab !== activeTab;
    const targetsHydrated: boolean = !prevHadTargets && hasTargets;
    const sizerEl: MeasurableModalBodyElement | null = sizerRef.current;
    if (
      (tabChanged || targetsHydrated) &&
      sizerEl?.style !== undefined &&
      prevHeight > 0 &&
      nextHeight > 0 &&
      prevHeight !== nextHeight
    ) {
      sizerEl.style.overflow = "hidden";
      sizerEl.style.transition = "none";
      sizerEl.style.height = `${prevHeight}px`;
      void sizerEl.offsetHeight;
      sizerEl.style.transition = "height 0.22s cubic-bezier(0.22, 1, 0.36, 1)";
      sizerEl.style.height = `${nextHeight}px`;
      const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
        if (sizerEl.style !== undefined) {
          sizerEl.style.height = "";
          sizerEl.style.overflow = "";
          sizerEl.style.transition = "";
        }
      }, 230);
      return (): void => {
        clearTimeout(timer);
        if (sizerEl.style !== undefined) {
          sizerEl.style.overflow = "";
        }
      };
    }
    if ((tabChanged || targetsHydrated) && sizerEl?.style !== undefined) {
      sizerEl.style.height = "";
      sizerEl.style.overflow = "";
      sizerEl.style.transition = "";
    }
    return undefined;
  }, [
    activeTab,
    hasTargets,
    lastHeightRef,
    paneRef,
    prevHadTargetsRef,
    prevTabRef,
    sizerRef,
  ]);

  return (
    <div ref={setSizerNode} className="chat-targets-body-sizer">
      <div
        ref={setPaneNode}
        className="chat-targets-tab-pane"
      >
        {children}
      </div>
    </div>
  );
}
