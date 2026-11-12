import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { CollapseGrid } from "../components/animations/CollapseGrid";
import {
  animateViewportToAnchor,
  resolveCollapseClampScrollTarget,
  resolvePreviewCardScrollTarget,
} from "../components/animations/expandFollowScroll";
import type { ViewportAnchorScrollTarget } from "../components/animations/expandFollowScroll";
import type { FlipAnimatableElement, FlipFollowScrollResolver } from "../components/animations/flipCollapse";
import { useDelayedUnmount } from "../components/animations/useDelayedUnmount";
import type { DelayedUnmountState } from "../components/animations/useDelayedUnmount";
import { GalleryGridList } from "../components/GalleryGridList";
import { GalleryPreviewCard } from "../components/GalleryPreviewCard";
import { PaginationBar } from "../components/PaginationBar";
import {
  MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS,
  MINI_APP_GALLERY_PAGE_SIZE_OPTIONS,
  MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX,
  MINI_APP_PAGINATION_HOVER_DURATION_MS,
} from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useComponentStore } from "../libs/componentStore";
import { blurElement, extractSelectedFilesAndReset } from "../libs/formatters";
import type { BlurCapableElement, DomCurrentTargetEventParams } from "../libs/formatters";
import { GallerySvgIcon, RefreshSvgIcon, UploadSvgIcon } from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import { createGalleryStore } from "../store/gallery";
import type { MiniAppGalleryStore, MiniAppGalleryStoreState } from "../store/gallery";
import type { MiniAppGalleryItem, MiniAppLanguage } from "../types/miniApp";

/** 携带视口客户端像素坐标的鼠标或指针事件最小参数接口。 */
export interface GalleryUploadPointerEvent {
  /** 事件发生时的视口水平客户端像素坐标。 */
  readonly clientX: number;
  /** 事件发生时的视口垂直客户端像素坐标。 */
  readonly clientY: number;
}

/** 图库上传按钮 85ms 按压复位与悬停抑制的单实例可变控制器。 */
export interface GalleryUploadController {
  /** 上传按钮当前是否处于禁用态。 */
  disabled: boolean;
  /** 上传按钮当前是否处于 85ms 按压反馈窗口。 */
  pressing: boolean;
  /** 上传按钮当前是否处于点击后悬停抑制态。 */
  hoverSuppressed: boolean;
  /** 最近一次点击时的视口水平像素坐标 `clientX`。 */
  clickX: number;
  /** 最近一次点击时的视口垂直像素坐标 `clientY`。 */
  clickY: number;
  /** 当前在途的 85ms 按压复位 `setTimeout` 句柄（无在途定时器时为 `null`）。 */
  timer: ReturnType<typeof setTimeout> | null;
  /** 当前挂载的原生 `<input type="file">` 节点（未挂载时为 `null`）。 */
  inputEl: BlurCapableElement | null;
  /** 绑定或卸载原生文件输入节点的回调引用。 */
  readonly setInputNode: (inputEl: BlurCapableElement | null) => void;
  /** 清理在途 85ms 按压复位定时器并归零句柄字段。 */
  readonly clearTimer: () => void;
  /** 同步上传按钮禁用态；进入禁用态时清理在途定时器、复位按压态并移除文件输入框焦点。 */
  readonly syncDisabled: (disabled: boolean) => void;
  /** 外层 `.gallery-upload-btn` 的 `mouseleave` 处理器（85ms 结束后解除悬停抑制）。 */
  readonly onMouseLeave: () => void;
  /** 外层 `.gallery-upload-btn` 的 `mousemove` 处理器（85ms 结束后超出位移阈值解除悬停抑制）。 */
  readonly onMouseMove: (event: GalleryUploadPointerEvent) => void;
  /** 内层 `.gallery-upload-input` 的 `pointerdown` 处理器（原地连续点击时先行解除悬停抑制）。 */
  readonly onPointerDown: () => void;
  /** 内层 `.gallery-upload-input` 的 `click` 处理器（不拦截默认行为、置位 85ms 按压与悬停抑制并排期失焦）。 */
  readonly onClick: (event: GalleryUploadPointerEvent) => void;
  /** 处理文件输入变更：移除焦点、提取文件并清空控件值，非空时触发批量上传。 */
  readonly selectFiles: (
    event: DomCurrentTargetEventParams,
    uploadFiles: (files: readonly File[]) => Promise<void>
  ) => void;
}

/**
 * 根据禁用态、85ms 按压反馈态与悬停抑制态构造 `.gallery-upload-btn` 的完整 CSS 类名。
 *
 * @param disabled 上传按钮是否处于禁用态
 * @param pressing 上传按钮是否处于 85ms 按压反馈窗口
 * @param hoverSuppressed 上传按钮是否处于点击后悬停抑制态
 * @returns 组合后的按钮 CSS 类名字符串
 */
export function buildGalleryUploadBtnClassName(
  disabled: boolean,
  pressing: boolean,
  hoverSuppressed: boolean
): string {
  if (disabled) {
    return "btn primary icon-btn gallery-upload-btn is-disabled";
  }
  return `btn primary icon-btn gallery-upload-btn${pressing ? " is-pressing" : ""}${hoverSuppressed ? " hover-suppressed" : ""}`;
}

/**
 * 创建单实例图库上传按钮交互控制器（通过惰性 `useState` 在挂载时按固定字段顺序初始化一次，提交阶段经副作用同步禁用态，渲染期无引用读写与额外分配）。
 *
 * @param setPressing 更新组件 `uploadPressing` 状态的函数
 * @param setHoverSuppressed 更新组件 `uploadHoverSuppressed` 状态的函数
 * @param initialDisabled 挂载时的初始禁用态（默认 `false`）
 * @returns 单实例上传交互控制器
 */
export function createGalleryUploadController(
  setPressing: (next: boolean) => void,
  setHoverSuppressed: (next: boolean) => void,
  initialDisabled: boolean = false
): GalleryUploadController {
  const ctrl: GalleryUploadController = {
    disabled: initialDisabled,
    pressing: false,
    hoverSuppressed: false,
    clickX: -1,
    clickY: -1,
    timer: null,
    inputEl: null,
    setInputNode: (inputEl: BlurCapableElement | null): void => {
      ctrl.inputEl = inputEl;
    },
    clearTimer: (): void => {
      if (ctrl.timer !== null) {
        clearTimeout(ctrl.timer);
        ctrl.timer = null;
      }
    },
    syncDisabled: (disabled: boolean): void => {
      ctrl.disabled = disabled;
      if (!disabled) {
        return;
      }
      ctrl.clearTimer();
      if (ctrl.pressing) {
        ctrl.pressing = false;
        setPressing(false);
      }
      blurElement(ctrl.inputEl);
    },
    onMouseLeave: (): void => {
      if (!ctrl.disabled && !ctrl.pressing && ctrl.hoverSuppressed) {
        ctrl.hoverSuppressed = false;
        setHoverSuppressed(false);
      }
    },
    onMouseMove: (event: GalleryUploadPointerEvent): void => {
      if (
        !ctrl.disabled &&
        !ctrl.pressing &&
        ctrl.hoverSuppressed &&
        (Math.abs(event.clientX - ctrl.clickX) >
          MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX ||
          Math.abs(event.clientY - ctrl.clickY) >
            MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX)
      ) {
        ctrl.hoverSuppressed = false;
        setHoverSuppressed(false);
      }
    },
    onPointerDown: (): void => {
      if (!ctrl.disabled && ctrl.hoverSuppressed) {
        ctrl.hoverSuppressed = false;
        setHoverSuppressed(false);
      }
    },
    onClick: (event: GalleryUploadPointerEvent): void => {
      if (ctrl.disabled) {
        return;
      }
      ctrl.clickX = event.clientX;
      ctrl.clickY = event.clientY;
      ctrl.clearTimer();
      ctrl.pressing = true;
      ctrl.hoverSuppressed = true;
      setPressing(true);
      setHoverSuppressed(true);
      ctrl.timer = setTimeout((): void => {
        ctrl.timer = null;
        ctrl.pressing = false;
        setPressing(false);
        blurElement(ctrl.inputEl);
      }, MINI_APP_PAGINATION_HOVER_DURATION_MS);
    },
    selectFiles: (
      event: DomCurrentTargetEventParams,
      uploadFiles: (files: readonly File[]) => Promise<void>
    ): void => {
      blurElement(ctrl.inputEl ?? (event.currentTarget as BlurCapableElement));
      const files: File[] = extractSelectedFilesAndReset(event);
      if (files.length > 0) {
        void uploadFiles(files);
      }
    },
  };
  return ctrl;
}

/** `GalleryPage` 组件属性。 */
export interface GalleryPageProps {
  /** 可选的状态仓库工厂（默认 `createGalleryStore`）。 */
  readonly storeFactory?: () => MiniAppGalleryStore;
}

/**
 * 图库分页预览、SHA-256 协议上传（含上传按钮 85ms 按压反馈定时复位与悬停抑制清理）、单张图片下载与删除管理页面
 * （关闭大图预览时执行延迟卸载收起过渡动画）。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function GalleryPage({
  storeFactory = createGalleryStore,
}: GalleryPageProps): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const {
    galleryPage,
    pageSize,
    loading,
    uploading,
    deletingFileName,
    downloadingFileName,
    uploadStatusText,
    previewItem,
    loadedImages,
    batchEpoch,
    previewLoaded,
    loadGallery,
    markThumbLoaded,
    markPreviewLoaded,
    setPreviewItem,
    changePage,
    changePageSize,
    downloadImage,
    deleteImage,
    uploadFiles,
  }: MiniAppGalleryStoreState = useComponentStore(storeFactory);
  useEffect((): void => {
    void loadGallery(1, pageSize);
  }, [loadGallery, pageSize]);

  const handleDownloadImage: (fileName: string) => void = useCallback(
    (fileName: string): void => {
      void downloadImage(fileName);
    },
    [downloadImage]
  );

  const handleDeleteImage: (fileName: string) => void = useCallback(
    (fileName: string): void => {
      void deleteImage(fileName);
    },
    [deleteImage]
  );

  const previewGridRef: React.RefObject<FlipAnimatableElement | null> =
    useRef<FlipAnimatableElement | null>(null);

  /** 关闭按钮触发的收起在同一次提交内解析视口回落；翻页、删除等其余收起路径不回落（翻页由分页栏滚回顶部）。 */
  const closeScrollArmedRef: React.RefObject<boolean> = useRef<boolean>(false);

  const handleClosePreview: () => void = useCallback((): void => {
    closeScrollArmedRef.current = true;
    setPreviewItem(null);
  }, [setPreviewItem]);

  const resolvePreviewCollapseScroll: FlipFollowScrollResolver = useCallback(
    (
      gridElement: FlipAnimatableElement,
      removedHeightPx: number
    ): ViewportAnchorScrollTarget | null => {
      if (!closeScrollArmedRef.current) {
        return null;
      }
      closeScrollArmedRef.current = false;
      return resolveCollapseClampScrollTarget(gridElement, removedHeightPx);
    },
    []
  );

  useEffect((): void => {
    closeScrollArmedRef.current = false;
  }, [previewItem]);

  const cancelPreviewScrollRef: React.RefObject<(() => void) | null> =
    useRef<(() => void) | null>(null);

  /** 预览面板不在展开过渡中时以同一时长与曲线把视口滚到预览位置；展开过渡中由折叠动画的同帧跟滚负责。 */
  const scrollToSettledPreview: () => void = useCallback((): void => {
    const gridEl: FlipAnimatableElement | null = previewGridRef.current;
    if (
      gridEl === null ||
      gridEl.firstElementChild?.dataset?.flipInFlight === "1"
    ) {
      return;
    }
    const target: ViewportAnchorScrollTarget | null =
      resolvePreviewCardScrollTarget(gridEl);
    if (target === null) {
      return;
    }
    cancelPreviewScrollRef.current?.();
    cancelPreviewScrollRef.current = animateViewportToAnchor(target);
  }, []);

  const [uploadPressing, setUploadPressing]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(false);
  const [uploadHoverSuppressed, setUploadHoverSuppressed]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(false);

  const uploadDisabled: boolean =
    uploading || loading || deletingFileName !== null || galleryPage?.exists === false;

  const [uploadCtrl]: [
    GalleryUploadController,
    React.Dispatch<React.SetStateAction<GalleryUploadController>>
  ] = useState<GalleryUploadController>((): GalleryUploadController =>
    createGalleryUploadController(
      setUploadPressing,
      setUploadHoverSuppressed,
      uploadDisabled
    )
  );

  const handleFilesSelected: (event: React.ChangeEvent<HTMLInputElement>) => void =
    useCallback(
      (event: React.ChangeEvent<HTMLInputElement>): void => {
        uploadCtrl.selectFiles(event, uploadFiles);
      },
      [uploadCtrl, uploadFiles]
    );

  const handleRefreshClick: () => void = useCallback((): void => {
    void loadGallery();
  }, [loadGallery]);

  useEffect((): void => {
    uploadCtrl.syncDisabled(uploadDisabled);
  }, [uploadCtrl, uploadDisabled]);

  useEffect((): (() => void) => {
    return (): void => {
      cancelPreviewScrollRef.current?.();
      cancelPreviewScrollRef.current = null;
      uploadCtrl.clearTimer();
      uploadCtrl.pressing = false;
      blurElement(uploadCtrl.inputEl);
    };
  }, [uploadCtrl]);

  const handleSelectPreviewItem: (item: Readonly<MiniAppGalleryItem>) => void =
    useCallback(
      (item: Readonly<MiniAppGalleryItem>): void => {
        if (previewItem?.fileName === item.fileName) {
          scrollToSettledPreview();
          return;
        }
        setPreviewItem(item);
      },
      [previewItem, scrollToSettledPreview, setPreviewItem]
    );

  useEffect((): void => {
    if (previewItem !== null) {
      scrollToSettledPreview();
    }
  }, [previewItem, scrollToSettledPreview]);

  const {
    displayValue: displayPreviewItem,
    isClosing: previewClosing,
  }: Readonly<DelayedUnmountState<Readonly<MiniAppGalleryItem>>> =
    useDelayedUnmount(previewItem, MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS);

  return (
    <div className="animate-fade-in">
      <div className="card">
        <div className="card-title">
          <span className="toolbar-hint">
            <span className="toolbar-icon-badge">
              <GallerySvgIcon size={16} />
            </span>
            <span>{t.gallery.sectionTitle}</span>
          </span>
          <div className="toolbar-actions">
            <div
              className={buildGalleryUploadBtnClassName(
                uploadDisabled,
                uploadPressing,
                uploadHoverSuppressed
              )}
              aria-disabled={uploadDisabled}
              onMouseLeave={uploadCtrl.onMouseLeave}
              onMouseMove={uploadCtrl.onMouseMove}
            >
              <UploadSvgIcon size={14} />
              <span>{uploading ? t.gallery.uploadingButton : t.gallery.uploadButton}</span>
              <input
                ref={uploadCtrl.setInputNode}
                type="file"
                className="gallery-upload-input"
                accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                multiple
                disabled={uploadDisabled}
                aria-label={uploading ? t.gallery.uploadingButton : t.gallery.uploadButton}
                onPointerDown={uploadCtrl.onPointerDown}
                onClick={uploadCtrl.onClick}
                onChange={handleFilesSelected}
              />
            </div>
            <button
              type="button"
              className="btn icon-btn"
              disabled={loading || uploading || deletingFileName !== null}
              onClick={handleRefreshClick}
            >
              <RefreshSvgIcon size={14} className={loading ? "spin-icon" : ""} />
              <span>{t.gallery.refreshButton}</span>
            </button>
          </div>
        </div>

        {galleryPage !== null
          ? (
            <div className="row-sub">
              {galleryPage.exists
                ? t.gallery.directoryReadyText(galleryPage.directory)
                : t.gallery.directoryMissingText(galleryPage.directory)}
            </div>
          )
          : null}

        {uploadStatusText !== null
          ? (
            <div className="cap-item" style={{ marginTop: "8px" }}>
              <div className="cap-val">{uploadStatusText}</div>
            </div>
          )
          : null}
      </div>

      <CollapseGrid
        expanded={previewItem !== null}
        gridClassName="gallery-preview-collapse-grid"
        innerClassName="gallery-preview-collapse-inner"
        fadeInner
        containerRef={previewGridRef}
        resolveFollowScroll={resolvePreviewCardScrollTarget}
        resolveCollapseScroll={resolvePreviewCollapseScroll}
      >
        {displayPreviewItem !== null ? (
          <GalleryPreviewCard
            previewItem={displayPreviewItem}
            previewLoaded={previewLoaded}
            isClosing={previewClosing}
            downloadingFileName={downloadingFileName}
            deletingFileName={deletingFileName}
            onMarkPreviewLoaded={markPreviewLoaded}
            onDownloadImage={handleDownloadImage}
            onDeleteImage={handleDeleteImage}
            onClosePreview={handleClosePreview}
          />
        ) : null}
      </CollapseGrid>

      {galleryPage !== null
        ? (
          <div className="card animate-fade-in">
            {!galleryPage.exists
              ? <div className="empty">{t.gallery.emptyMissingDirHint}</div>
              : galleryPage.items.length === 0
                ? <div className="empty">{t.gallery.emptyGalleryHint}</div>
                : (
                  <GalleryGridList
                    items={galleryPage.items}
                    previewItem={previewItem}
                    deletingFileName={deletingFileName}
                    downloadingFileName={downloadingFileName}
                    loadedImages={loadedImages}
                    batchEpoch={batchEpoch}
                    t={t}
                    onMarkThumbLoaded={markThumbLoaded}
                    onSelectPreviewItem={handleSelectPreviewItem}
                    onDownloadImage={handleDownloadImage}
                    onDeleteImage={handleDeleteImage}
                  />
                )}

            <PaginationBar
              page={galleryPage.page}
              totalPages={galleryPage.totalPages}
              total={galleryPage.total}
              pageSize={pageSize}
              pageSizeOptions={MINI_APP_GALLERY_PAGE_SIZE_OPTIONS}
              disabled={loading || uploading || deletingFileName !== null}
              onPageChange={changePage}
              onPageSizeChange={changePageSize}
            />
          </div>
        )
        : null}
    </div>
  );
}
