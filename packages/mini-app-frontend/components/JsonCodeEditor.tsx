import { Fragment, useCallback, useEffect, useMemo, useRef } from "react";
import type React from "react";
import {
  MINI_APP_JSON_EDITOR_CORNER_CLEARANCE_PX,
  MINI_APP_JSON_EDITOR_MIN_THUMB_PERCENT,
  MINI_APP_JSON_EDITOR_SCROLLBAR_LANE_PX,
  MINI_APP_JSON_INDENT_TEXT,
} from "../consts/miniAppConfig";
import { encodeUtf8Bytes } from "../libs/crypto";
import { readEventTargetValue } from "../libs/formatters";
import {
  tokenizeJsonForHighlight,
  validateJsonSyntax,
} from "../libs/jsonHighlight";
import type { JsonHighlightToken, JsonSyntaxValidationResult } from "../types/miniApp/ui";
import type { MiniAppConfigFileName } from "../types/miniAppConfigs";
import type { MiniAppTranslations } from "../types/miniAppI18n";
import { getFrameMotionHost } from "./animations/frameMotion";
import type { FrameMotionHost } from "./animations/frameMotion";

/** 支持纵横滚动偏移与滚动条内缩样式同步的编辑层容器最小接口。 */
interface ScrollSyncNode {
  /** 纵向滚动像素偏移。 */
  scrollTop: number;
  /** 横向滚动像素偏移。 */
  scrollLeft: number;
  /** 可选行内样式表（用于同步滚动条占用的右/底内缩宽度）。 */
  readonly style?: Record<string, string>;
}

/** 支持光标选区读写、滚动视口度量与滚动同步的 `<textarea>` 节点最小接口。 */
interface EditableTextareaNode extends ScrollSyncNode {
  /** 当前编辑区文本值。 */
  readonly value: string;
  /** 外盒像素宽度（含纵向原生滚动条）。 */
  readonly offsetWidth?: number;
  /** 内容可视区像素宽度（不含纵向原生滚动条）。 */
  readonly clientWidth?: number;
  /** 内容总横向像素宽度。 */
  readonly scrollWidth?: number;
  /** 外盒像素高度（含横向原生滚动条）。 */
  readonly offsetHeight?: number;
  /** 内容可视区像素高度（不含横向原生滚动条）。 */
  readonly clientHeight?: number;
  /** 内容总纵向像素高度。 */
  readonly scrollHeight?: number;
  /** 光标选区起始字符下标。 */
  readonly selectionStart?: number;
  /** 光标选区结束字符下标。 */
  readonly selectionEnd?: number;
  /** 更新光标选区起止位置。 */
  readonly setSelectionRange?: (start: number, end: number) => void;
}

/** 编辑画布外框节点最小接口。 */
interface EditorCanvasNode {
  /** 行内样式表（用于在显示自定义平行四边形滑条时预留右/底通道）。 */
  readonly style?: Record<string, string>;
}

/** 视口二维矩形最小接口。 */
interface EditorBoundingRect {
  /** 元素左侧视口横坐标。 */
  readonly left: number;
  /** 元素顶部视口纵坐标。 */
  readonly top: number;
  /** 元素外盒像素宽度。 */
  readonly width: number;
  /** 元素外盒像素高度。 */
  readonly height: number;
}

/** 自定义平行四边形滑条轨道节点最小接口。 */
interface EditorScrollbarTrackNode {
  /** 行内样式表（直接控制显隐与右下角互让间距，避免滚动重渲染）。 */
  readonly style?: Record<string, string>;
  /** 读取轨道当前视口矩形。 */
  readonly getBoundingClientRect?: () => EditorBoundingRect;
  /** 捕获指定指针 ID。 */
  readonly setPointerCapture?: (pointerId: number) => void;
  /** 释放已捕获指针 ID。 */
  readonly releasePointerCapture?: (pointerId: number) => void;
}

/** 自定义平行四边形滑条滑块节点最小接口。 */
interface EditorScrollbarThumbNode {
  /** 行内样式表（直接同步滑块百分比跨度与偏移）。 */
  readonly style?: Record<string, string>;
  /** 读取滑块当前视口矩形。 */
  readonly getBoundingClientRect?: () => EditorBoundingRect;
  /** 类名列表（拖拽期间切换 `.dragging` 强调色）。 */
  readonly classList?: Readonly<{
    readonly add?: (token: string) => void;
    readonly remove?: (token: string) => void;
  }>;
}

/** 滑条拖拽轴向（纵向 `"v"` 或横向 `"h"`）。 */
type EditorScrollbarAxis = "v" | "h";

/** 正在进行中的滑条指针拖拽会话。 */
interface ActiveScrollbarDragState {
  /** 拖拽所属轴向。 */
  readonly axis: EditorScrollbarAxis;
  /** 捕获的指针 ID。 */
  readonly pointerId: number;
  /** 按下点相对滑块起点的像素抓取偏移。 */
  readonly grabOffsetPx: number;
}

/** `ResizeObserver` 实例最小接口。 */
interface EditorResizeObserverInstance {
  /** 订阅目标元素的盒尺寸变化。 */
  readonly observe: (target: unknown) => void;
  /** 取消全部尺寸监听。 */
  readonly disconnect: () => void;
}

/** `ResizeObserver` 构造器最小签名。 */
type EditorResizeObserverConstructor = new (
  callback: () => void
) => EditorResizeObserverInstance;

/** 浏览器窗口与尺寸观察器全局宿主最小接口。 */
interface EditorResizeHost {
  readonly window?: Readonly<{
    readonly addEventListener?: (type: string, listener: () => void) => void;
    readonly removeEventListener?: (type: string, listener: () => void) => void;
  }>;
  readonly ResizeObserver?: EditorResizeObserverConstructor;
}

/** `computeJsonEditorScrollbarThumbMetrics` 计算单轴滑块几何比例的入参。 */
export interface JsonEditorAxisScrollMetricsInput {
  /** 当前轴向滚动偏移像素（`scrollTop` 或 `scrollLeft`）。 */
  readonly scrollOffset: number;
  /** 当前轴向内容总像素长度（`scrollHeight` 或 `scrollWidth`）。 */
  readonly scrollSize: number;
  /** 当前轴向可视窗口像素长度（`clientHeight` 或 `clientWidth`）。 */
  readonly clientSize: number;
}

/** JSON 代码编辑器单轴平行四边形滑条的溢出状态与滑块百分比尺寸。 */
export interface JsonEditorAxisScrollMetrics {
  /** 内容是否超出可视窗口（为 `true` 时显示该轴滑条）。 */
  readonly overflow: boolean;
  /** 滑块占轨道总长度的百分比（`MINI_APP_JSON_EDITOR_MIN_THUMB_PERCENT`–`100`）。 */
  readonly sizePercent: number;
  /** 滑块起点占轨道总长度的百分比偏移（`0`–`100 - sizePercent`）。 */
  readonly offsetPercent: number;
}

/**
 * 计算 JSON 编辑器单轴平行四边形滑条的显隐状态、滑块百分比跨度与百分比偏移。
 *
 * @param input 单轴滚动偏移、内容总跨度与可视跨度
 * @returns 溢出标记与滑块百分比几何
 */
export function computeJsonEditorScrollbarThumbMetrics({
  scrollOffset,
  scrollSize,
  clientSize,
}: JsonEditorAxisScrollMetricsInput): Readonly<JsonEditorAxisScrollMetrics> {
  if (clientSize <= 0 || scrollSize <= clientSize + 1) {
    return {
      overflow: false,
      sizePercent: 100,
      offsetPercent: 0,
    };
  }
  const sizePercent: number = Math.min(
    100,
    Math.max(
      MINI_APP_JSON_EDITOR_MIN_THUMB_PERCENT,
      (clientSize / scrollSize) * 100
    )
  );
  const maxScroll: number = scrollSize - clientSize;
  const clampedRatio: number = Math.min(1, Math.max(0, scrollOffset / maxScroll));
  return {
    overflow: true,
    sizePercent,
    offsetPercent: clampedRatio * (100 - sizePercent),
  };
}

/** `JsonCodeEditor` 双层同步 JSON 语法高亮编辑器的属性参数。 */
export interface JsonCodeEditorProps {
  /** 当前编辑的目标配置文件名。 */
  readonly fileName: MiniAppConfigFileName;
  /** 编辑器当前 JSON 文本内容。 */
  readonly value: string;
  /** 当前配置文件在磁盘上是否已存在。 */
  readonly fileExists: boolean;
  /** 是否处于格式化、还原、保存或重启忙碌禁用态。 */
  readonly disabled: boolean;
  /** 当前语言的界面文案字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 文本内容变更回调。 */
  readonly onChange: (nextValue: string) => void;
}

/**
 * 渲染零外部依赖的主题自适应 JSON 语法高亮代码编辑器：
 * 1. 隐藏浏览器原生滚动条，在内容溢出时按轴向挂载带独立实心通道底色与右下角交汇互让间距的亮/暗双主题新粗野主义平行四边形纵横滑条，支持点击轨道跳转与按住滑块拖拽；
 * 2. 行号栏、底层 `<pre>` 词法着色层与顶层透明文字 `<textarea wrap="off">` 共享完全一致的等宽字体度量与内边距，按视口度量在滚动、内容变更及尺寸变化时 1:1 同步偏移与通道内缩；
 * 3. 对 JSON 键名、字符串值、数值、布尔值、`null`、花括号/方括号 `{}`/`[]`、冒号/逗号 `: ,` 及非法词法片段独立着色，并支持 `Tab` 键插入 2 空格缩进。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function JsonCodeEditor({
  fileName,
  value,
  fileExists,
  disabled,
  t,
  onChange,
}: JsonCodeEditorProps): React.JSX.Element {
  const gutterRef: React.RefObject<ScrollSyncNode | null> =
    useRef<ScrollSyncNode | null>(null);
  const canvasRef: React.RefObject<EditorCanvasNode | null> =
    useRef<EditorCanvasNode | null>(null);
  const preRef: React.RefObject<ScrollSyncNode | null> =
    useRef<ScrollSyncNode | null>(null);
  const textareaRef: React.RefObject<EditableTextareaNode | null> =
    useRef<EditableTextareaNode | null>(null);
  const vLaneRef: React.RefObject<EditorCanvasNode | null> =
    useRef<EditorCanvasNode | null>(null);
  const hLaneRef: React.RefObject<EditorCanvasNode | null> =
    useRef<EditorCanvasNode | null>(null);
  const vTrackRef: React.RefObject<EditorScrollbarTrackNode | null> =
    useRef<EditorScrollbarTrackNode | null>(null);
  const vThumbRef: React.RefObject<EditorScrollbarThumbNode | null> =
    useRef<EditorScrollbarThumbNode | null>(null);
  const hTrackRef: React.RefObject<EditorScrollbarTrackNode | null> =
    useRef<EditorScrollbarTrackNode | null>(null);
  const hThumbRef: React.RefObject<EditorScrollbarThumbNode | null> =
    useRef<EditorScrollbarThumbNode | null>(null);
  const activeDragRef: React.RefObject<ActiveScrollbarDragState | null> =
    useRef<ActiveScrollbarDragState | null>(null);
  const prevFileNameRef: React.RefObject<MiniAppConfigFileName> =
    useRef<MiniAppConfigFileName>(fileName);
  const caretFrameRef: React.RefObject<number | null> =
    useRef<number | null>(null);

  const setGutterNode: (el: unknown) => void = useCallback((el: unknown): void => {
    gutterRef.current = el as ScrollSyncNode | null;
  }, []);
  const setCanvasNode: (el: unknown) => void = useCallback((el: unknown): void => {
    canvasRef.current = el as EditorCanvasNode | null;
  }, []);
  const setPreNode: (el: unknown) => void = useCallback((el: unknown): void => {
    preRef.current = el as ScrollSyncNode | null;
  }, []);
  const setTextareaNode: (el: unknown) => void = useCallback(
    (el: unknown): void => {
      textareaRef.current = el as EditableTextareaNode | null;
    },
    []
  );
  const setVLaneNode: (el: unknown) => void = useCallback((el: unknown): void => {
    vLaneRef.current = el as EditorCanvasNode | null;
  }, []);
  const setHLaneNode: (el: unknown) => void = useCallback((el: unknown): void => {
    hLaneRef.current = el as EditorCanvasNode | null;
  }, []);
  const setVTrackNode: (el: unknown) => void = useCallback((el: unknown): void => {
    vTrackRef.current = el as EditorScrollbarTrackNode | null;
  }, []);
  const setVThumbNode: (el: unknown) => void = useCallback((el: unknown): void => {
    vThumbRef.current = el as EditorScrollbarThumbNode | null;
  }, []);
  const setHTrackNode: (el: unknown) => void = useCallback((el: unknown): void => {
    hTrackRef.current = el as EditorScrollbarTrackNode | null;
  }, []);
  const setHThumbNode: (el: unknown) => void = useCallback((el: unknown): void => {
    hThumbRef.current = el as EditorScrollbarThumbNode | null;
  }, []);

  const syncScrollOffsets: () => void = useCallback((): void => {
    const textarea: EditableTextareaNode | null = textareaRef.current;
    if (textarea === null) return;
    const rawSbW: number =
      (textarea.offsetWidth ?? 0) - (textarea.clientWidth ?? 0);
    const rawSbH: number =
      (textarea.offsetHeight ?? 0) - (textarea.clientHeight ?? 0);
    const sbW: number = rawSbW > 0 ? rawSbW : 0;
    const sbH: number = rawSbH > 0 ? rawSbH : 0;

    const vMetrics: Readonly<JsonEditorAxisScrollMetrics> =
      computeJsonEditorScrollbarThumbMetrics({
        scrollOffset: textarea.scrollTop,
        scrollSize: textarea.scrollHeight ?? 0,
        clientSize: textarea.clientHeight ?? 0,
      });
    const hMetrics: Readonly<JsonEditorAxisScrollMetrics> =
      computeJsonEditorScrollbarThumbMetrics({
        scrollOffset: textarea.scrollLeft,
        scrollSize: textarea.scrollWidth ?? 0,
        clientSize: textarea.clientWidth ?? 0,
      });

    const useCustomRightLane: boolean = sbW === 0 && vMetrics.overflow;
    const useCustomBottomLane: boolean = sbH === 0 && hMetrics.overflow;

    const canvas: EditorCanvasNode | null = canvasRef.current;
    if (canvas?.style !== undefined) {
      canvas.style.right = useCustomRightLane
        ? `${MINI_APP_JSON_EDITOR_SCROLLBAR_LANE_PX}px`
        : "0px";
      canvas.style.bottom = useCustomBottomLane
        ? `${MINI_APP_JSON_EDITOR_SCROLLBAR_LANE_PX}px`
        : "0px";
    }

    const pre: ScrollSyncNode | null = preRef.current;
    if (pre !== null) {
      if (pre.style !== undefined) {
        pre.style.right = `${sbW}px`;
        pre.style.bottom = `${sbH}px`;
      }
      pre.scrollTop = textarea.scrollTop;
      pre.scrollLeft = textarea.scrollLeft;
    }

    const gutter: ScrollSyncNode | null = gutterRef.current;
    if (gutter !== null) {
      if (gutter.style !== undefined) {
        const gutterBottomPx: number =
          sbH > 0
            ? sbH
            : useCustomBottomLane
              ? MINI_APP_JSON_EDITOR_SCROLLBAR_LANE_PX
              : 0;
        gutter.style.bottom = `${gutterBottomPx}px`;
      }
      gutter.scrollTop = textarea.scrollTop;
    }

    const vLane: EditorCanvasNode | null = vLaneRef.current;
    if (vLane?.style !== undefined) {
      vLane.style.display = useCustomRightLane ? "block" : "none";
    }
    const vTrack: EditorScrollbarTrackNode | null = vTrackRef.current;
    if (vTrack?.style !== undefined) {
      vTrack.style.bottom = useCustomBottomLane
        ? `${MINI_APP_JSON_EDITOR_CORNER_CLEARANCE_PX}px`
        : "6px";
    }
    const vThumb: EditorScrollbarThumbNode | null = vThumbRef.current;
    if (vThumb?.style !== undefined) {
      vThumb.style.height = `${vMetrics.sizePercent.toFixed(2)}%`;
      vThumb.style.top = `${vMetrics.offsetPercent.toFixed(2)}%`;
    }

    const hLane: EditorCanvasNode | null = hLaneRef.current;
    if (hLane?.style !== undefined) {
      hLane.style.display = useCustomBottomLane ? "block" : "none";
      hLane.style.right = useCustomRightLane
        ? `${MINI_APP_JSON_EDITOR_SCROLLBAR_LANE_PX}px`
        : "0px";
    }
    const hThumb: EditorScrollbarThumbNode | null = hThumbRef.current;
    if (hThumb?.style !== undefined) {
      hThumb.style.width = `${hMetrics.sizePercent.toFixed(2)}%`;
      hThumb.style.left = `${hMetrics.offsetPercent.toFixed(2)}%`;
    }
  }, []);

  useEffect((): void => {
    if (prevFileNameRef.current !== fileName) {
      prevFileNameRef.current = fileName;
      if (textareaRef.current !== null) {
        textareaRef.current.scrollTop = 0;
        textareaRef.current.scrollLeft = 0;
      }
    }
    syncScrollOffsets();
  }, [fileName, syncScrollOffsets, value]);

  useEffect((): (() => void) => {
    const resizeHost: EditorResizeHost =
      globalThis as unknown as EditorResizeHost;
    resizeHost.window?.addEventListener?.("resize", syncScrollOffsets);
    let observer: EditorResizeObserverInstance | null = null;
    if (
      typeof resizeHost.ResizeObserver === "function" &&
      textareaRef.current !== null
    ) {
      observer = new resizeHost.ResizeObserver(syncScrollOffsets);
      observer.observe(textareaRef.current);
    }
    return (): void => {
      resizeHost.window?.removeEventListener?.("resize", syncScrollOffsets);
      observer?.disconnect();
      if (caretFrameRef.current !== null) {
        getFrameMotionHost().cancelAnimationFrame?.(caretFrameRef.current);
        caretFrameRef.current = null;
      }
    };
  }, [syncScrollOffsets]);

  const applyScrollbarPointer: (
    axis: EditorScrollbarAxis,
    clientCoord: number,
    grabOffsetPx: number
  ) => void = useCallback(
    (
      axis: EditorScrollbarAxis,
      clientCoord: number,
      grabOffsetPx: number
    ): void => {
      const textarea: EditableTextareaNode | null = textareaRef.current;
      const track: EditorScrollbarTrackNode | null =
        axis === "v" ? vTrackRef.current : hTrackRef.current;
      const thumb: EditorScrollbarThumbNode | null =
        axis === "v" ? vThumbRef.current : hThumbRef.current;
      if (textarea === null || track?.getBoundingClientRect === undefined) {
        return;
      }
      const scrollSize: number =
        axis === "v"
          ? (textarea.scrollHeight ?? 0)
          : (textarea.scrollWidth ?? 0);
      const clientSize: number =
        axis === "v"
          ? (textarea.clientHeight ?? 0)
          : (textarea.clientWidth ?? 0);
      if (scrollSize <= clientSize || clientSize <= 0) {
        return;
      }
      const trackRect: EditorBoundingRect = track.getBoundingClientRect();
      const trackSpanPx: number =
        axis === "v" ? trackRect.height : trackRect.width;
      const trackOriginPx: number =
        axis === "v" ? trackRect.top : trackRect.left;
      if (trackSpanPx <= 0) {
        return;
      }
      const metrics: Readonly<JsonEditorAxisScrollMetrics> =
        computeJsonEditorScrollbarThumbMetrics({
          scrollOffset: axis === "v" ? textarea.scrollTop : textarea.scrollLeft,
          scrollSize,
          clientSize,
        });
      const thumbRect: EditorBoundingRect | undefined =
        thumb?.getBoundingClientRect?.();
      const measuredThumbSpan: number =
        axis === "v" ? (thumbRect?.height ?? 0) : (thumbRect?.width ?? 0);
      const thumbSpanPx: number =
        measuredThumbSpan > 0
          ? measuredThumbSpan
          : (trackSpanPx * metrics.sizePercent) / 100;
      const movableSpanPx: number = Math.max(1, trackSpanPx - thumbSpanPx);
      const desiredOffsetPx: number = Math.min(
        movableSpanPx,
        Math.max(0, clientCoord - trackOriginPx - grabOffsetPx)
      );
      const nextScrollOffset: number =
        (desiredOffsetPx / movableSpanPx) * (scrollSize - clientSize);
      if (axis === "v") {
        textarea.scrollTop = nextScrollOffset;
      } else {
        textarea.scrollLeft = nextScrollOffset;
      }
      syncScrollOffsets();
    },
    [syncScrollOffsets]
  );

  const startScrollbarDrag: (
    axis: EditorScrollbarAxis,
    event: React.PointerEvent<HTMLDivElement>
  ) => void = useCallback(
    (
      axis: EditorScrollbarAxis,
      event: React.PointerEvent<HTMLDivElement>
    ): void => {
      if (disabled) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const track: EditorScrollbarTrackNode | null =
        axis === "v" ? vTrackRef.current : hTrackRef.current;
      const thumb: EditorScrollbarThumbNode | null =
        axis === "v" ? vThumbRef.current : hThumbRef.current;
      const thumbRect: EditorBoundingRect | undefined =
        thumb?.getBoundingClientRect?.();
      const clientCoord: number = axis === "v" ? event.clientY : event.clientX;
      const thumbStart: number =
        axis === "v" ? (thumbRect?.top ?? 0) : (thumbRect?.left ?? 0);
      const thumbSpan: number =
        axis === "v" ? (thumbRect?.height ?? 0) : (thumbRect?.width ?? 0);
      let grabOffsetPx: number = thumbSpan / 2;
      let clickedThumbDirectly: boolean = false;
      if (
        thumbRect !== undefined &&
        thumbSpan > 0 &&
        clientCoord >= thumbStart &&
        clientCoord <= thumbStart + thumbSpan
      ) {
        grabOffsetPx = clientCoord - thumbStart;
        clickedThumbDirectly = true;
      }
      activeDragRef.current = {
        axis,
        pointerId: event.pointerId,
        grabOffsetPx,
      };
      track?.setPointerCapture?.(event.pointerId);
      thumb?.classList?.add?.("dragging");
      if (!clickedThumbDirectly) {
        applyScrollbarPointer(axis, clientCoord, grabOffsetPx);
      }
    },
    [applyScrollbarPointer, disabled]
  );

  useEffect((): void => {
    if (!disabled || activeDragRef.current === null) {
      return;
    }
    const drag: ActiveScrollbarDragState = activeDragRef.current;
    activeDragRef.current = null;
    const track: EditorScrollbarTrackNode | null =
      drag.axis === "v" ? vTrackRef.current : hTrackRef.current;
    const thumb: EditorScrollbarThumbNode | null =
      drag.axis === "v" ? vThumbRef.current : hThumbRef.current;
    track?.releasePointerCapture?.(drag.pointerId);
    thumb?.classList?.remove?.("dragging");
  }, [disabled]);

  const moveScrollbarDrag: (
    axis: EditorScrollbarAxis,
    event: React.PointerEvent<HTMLDivElement>
  ) => void = useCallback(
    (
      axis: EditorScrollbarAxis,
      event: React.PointerEvent<HTMLDivElement>
    ): void => {
      if (disabled) {
        return;
      }
      const drag: ActiveScrollbarDragState | null = activeDragRef.current;
      if (drag?.axis !== axis || drag.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      const clientCoord: number = axis === "v" ? event.clientY : event.clientX;
      applyScrollbarPointer(axis, clientCoord, drag.grabOffsetPx);
    },
    [applyScrollbarPointer, disabled]
  );

  const endScrollbarDrag: (
    axis: EditorScrollbarAxis,
    event: React.PointerEvent<HTMLDivElement>
  ) => void = useCallback(
    (
      axis: EditorScrollbarAxis,
      event: React.PointerEvent<HTMLDivElement>
    ): void => {
      const drag: ActiveScrollbarDragState | null = activeDragRef.current;
      if (drag?.axis !== axis || drag.pointerId !== event.pointerId) {
        return;
      }
      activeDragRef.current = null;
      const track: EditorScrollbarTrackNode | null =
        axis === "v" ? vTrackRef.current : hTrackRef.current;
      const thumb: EditorScrollbarThumbNode | null =
        axis === "v" ? vThumbRef.current : hThumbRef.current;
      track?.releasePointerCapture?.(event.pointerId);
      thumb?.classList?.remove?.("dragging");
    },
    []
  );

  const handleVPointerDown: (
    event: React.PointerEvent<HTMLDivElement>
  ) => void = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      startScrollbarDrag("v", event);
    },
    [startScrollbarDrag]
  );
  const handleVPointerMove: (
    event: React.PointerEvent<HTMLDivElement>
  ) => void = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      moveScrollbarDrag("v", event);
    },
    [moveScrollbarDrag]
  );
  const handleVPointerEnd: (
    event: React.PointerEvent<HTMLDivElement>
  ) => void = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      endScrollbarDrag("v", event);
    },
    [endScrollbarDrag]
  );
  const handleHPointerDown: (
    event: React.PointerEvent<HTMLDivElement>
  ) => void = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      startScrollbarDrag("h", event);
    },
    [startScrollbarDrag]
  );
  const handleHPointerMove: (
    event: React.PointerEvent<HTMLDivElement>
  ) => void = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      moveScrollbarDrag("h", event);
    },
    [moveScrollbarDrag]
  );
  const handleHPointerEnd: (
    event: React.PointerEvent<HTMLDivElement>
  ) => void = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      endScrollbarDrag("h", event);
    },
    [endScrollbarDrag]
  );
  const handleTextareaChange: (
    event: React.ChangeEvent<HTMLTextAreaElement>
  ) => void = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
      onChange(readEventTargetValue(event));
    },
    [onChange]
  );

  const tokens: readonly Readonly<JsonHighlightToken>[] = useMemo(
    (): readonly Readonly<JsonHighlightToken>[] => tokenizeJsonForHighlight(value),
    [value]
  );

  const validation: Readonly<JsonSyntaxValidationResult> = useMemo(
    (): Readonly<JsonSyntaxValidationResult> => validateJsonSyntax(value),
    [value]
  );

  const lineCount: number = useMemo((): number => {
    let count: number = 1;
    for (let i: number = 0; i < value.length; i += 1) {
      if (value.charCodeAt(i) === 0x0a) {
        count += 1;
      }
    }
    return count;
  }, [value]);

  const byteLength: number = useMemo(
    (): number => encodeUtf8Bytes(value).byteLength,
    [value]
  );

  const lineNumbers: readonly number[] = useMemo((): readonly number[] => {
    const nums: number[] = [];
    for (let line: number = 1; line <= lineCount; line += 1) {
      nums.push(line);
    }
    return nums;
  }, [lineCount]);

  const errorLine: number | null =
    !validation.ok && !validation.empty ? validation.line : null;

  const handleKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void =
    useCallback(
      (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
        if (event.key !== "Tab" || disabled) {
          return;
        }
        event.preventDefault();
        const target: EditableTextareaNode =
          event.currentTarget as unknown as EditableTextareaNode;
        const start: number =
        typeof target.selectionStart === "number"
          ? target.selectionStart
          : value.length;
        const end: number =
        typeof target.selectionEnd === "number" ? target.selectionEnd : start;
        const nextValue: string = `${value.slice(0, start)}${MINI_APP_JSON_INDENT_TEXT}${value.slice(end)}`;
        const nextCaret: number = start + MINI_APP_JSON_INDENT_TEXT.length;
        onChange(nextValue);
        const host: FrameMotionHost = getFrameMotionHost();
        const scheduleFrame: ((cb: (now: number) => void) => number) | undefined =
          host.requestAnimationFrame;
        if (typeof scheduleFrame === "function") {
          if (caretFrameRef.current !== null) {
            host.cancelAnimationFrame?.(caretFrameRef.current);
          }
          caretFrameRef.current = scheduleFrame((): void => {
            caretFrameRef.current = null;
            textareaRef.current?.setSelectionRange?.(nextCaret, nextCaret);
            syncScrollOffsets();
          });
        } else {
          target.setSelectionRange?.(nextCaret, nextCaret);
        }
      },
      [disabled, onChange, syncScrollOffsets, value]
    );

  const isBlankNewFile: boolean = !fileExists && value.trim().length === 0;

  return (
    <div
      className={`json-editor-shell json-editor-frame ${errorLine !== null ? "has-syntax-error" : ""}`}
    >
      <div className="json-editor-header">
        <div className="json-editor-meta">
          <span className="json-editor-filename">{fileName}</span>
          <span className="json-editor-stats">
            {t.configs.lineStatsText(lineCount, byteLength)}
          </span>
        </div>
        <div className="json-editor-status">
          {isBlankNewFile ? (
            <span className="badge warn">{t.configs.fileMissingBadge}</span>
          ) : validation.ok ? (
            <span className="badge ok">{t.configs.syntaxValidBadge}</span>
          ) : validation.empty ? (
            <span className="badge warn">{t.configs.dirtyBadge}</span>
          ) : (
            <span className="badge warn">
              {t.configs.syntaxErrorBadge(validation.line, validation.column)}
            </span>
          )}
        </div>
      </div>

      <div className="json-editor-stage">
        <div
          ref={setGutterNode}
          className="json-editor-gutter"
          aria-hidden="true"
        >
          {lineNumbers.map((lineNum: number): React.JSX.Element => {
            const isErr: boolean = errorLine === lineNum;
            return (
              <div
                key={lineNum}
                className={`json-gutter-line ${isErr ? "is-error" : ""}`}
              >
                {lineNum}
              </div>
            );
          })}
        </div>

        <div ref={setCanvasNode} className="json-editor-canvas">
          <pre
            ref={setPreNode}
            className="json-editor-highlight"
            aria-hidden="true"
          >
            <code className="json-editor-code">
              {tokens.map(
                (
                  token: Readonly<JsonHighlightToken>,
                  idx: number
                ): React.JSX.Element =>
                  token.kind === "whitespace" ? (
                    <Fragment key={idx}>{token.text}</Fragment>
                  ) : (
                    <span
                      key={idx}
                      className={`json-tok json-tok-${token.kind}`}
                    >
                      {token.text}
                    </span>
                  )
              )}
              {value.endsWith("\n") ? " " : null}
            </code>
          </pre>

          <textarea
            ref={setTextareaNode}
            className="json-editor-textarea"
            value={value}
            disabled={disabled}
            wrap="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            aria-label={t.configs.editorAriaLabel(fileName)}
            placeholder={t.configs.editorPlaceholder}
            onChange={handleTextareaChange}
            onScroll={syncScrollOffsets}
            onKeyDown={handleKeyDown}
          />
        </div>

        <div
          ref={setVLaneNode}
          className="json-editor-scroll-lane json-editor-scroll-lane-v"
          aria-hidden="true"
        >
          <div
            ref={setVTrackNode}
            className="json-editor-scrollbar json-editor-scrollbar-v"
            onPointerDown={handleVPointerDown}
            onPointerMove={handleVPointerMove}
            onPointerUp={handleVPointerEnd}
            onPointerCancel={handleVPointerEnd}
          >
            <div
              ref={setVThumbNode}
              className="json-editor-scrollbar-thumb json-editor-scrollbar-thumb-v"
            />
          </div>
        </div>

        <div
          ref={setHLaneNode}
          className="json-editor-scroll-lane json-editor-scroll-lane-h"
          aria-hidden="true"
        >
          <div
            ref={setHTrackNode}
            className="json-editor-scrollbar json-editor-scrollbar-h"
            onPointerDown={handleHPointerDown}
            onPointerMove={handleHPointerMove}
            onPointerUp={handleHPointerEnd}
            onPointerCancel={handleHPointerEnd}
          >
            <div
              ref={setHThumbNode}
              className="json-editor-scrollbar-thumb json-editor-scrollbar-thumb-h"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
