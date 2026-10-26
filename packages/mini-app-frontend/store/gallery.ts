import { createStore } from "zustand";
import type { StoreApi } from "zustand";
import { fetchMiniAppGallery } from "../api/gallery";
import { deleteMiniAppGalleryImageByName } from "../api/galleryDelete";
import { downloadMiniAppGalleryImageByName } from "../api/galleryDownload";
import { uploadMiniAppGalleryImageBytes } from "../api/galleryUpload";
import { MINI_APP_GALLERY_DEFAULT_PAGE_SIZE } from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { errorMessage } from "../libs/errorMessage";
import {
  buildMiniAppGalleryDownloadFileName,
  shortenGalleryFileName,
  truncateDisplayText,
} from "../libs/formatters";
import { waitMinimumLoadingDuration } from "../libs/loading";
import type {
  MiniAppGalleryDeleteResult,
  MiniAppGalleryItem,
  MiniAppGalleryPage,
  MiniAppGalleryUploadResult,
} from "../types/miniApp";
import { useMiniAppStore } from "./app";
import type { MiniAppUiStoreState } from "./app";

/** `GalleryTab` 图库管理的状态与动作接口。 */
export interface MiniAppGalleryStoreState {
  /** 最近一次成功拉取的图库分页。 */
  readonly galleryPage: MiniAppGalleryPage | null;
  /** 当前页码。 */
  readonly page: number;
  /** 每页张数。 */
  readonly pageSize: number;
  /** 是否正在加载图库分页。 */
  readonly loading: boolean;
  /** 是否正在上传。 */
  readonly uploading: boolean;
  /** 正在删除的文件名（无删除时为 `null`）。 */
  readonly deletingFileName: string | null;
  /** 正在下载的文件名（无下载时为 `null`）。 */
  readonly downloadingFileName: string | null;
  /** 批量上传进度文案（未上传时为 `null`）。 */
  readonly uploadStatusText: string | null;
  /** 当前展开大图预览的图片（未预览时为 `null`）。 */
  readonly previewItem: Readonly<MiniAppGalleryItem> | null;
  /** 当前批次已完成加载动画的缩略图文件名表。 */
  readonly loadedImages: Readonly<Record<string, boolean>>;
  /** 缩略图批次号：每次成功加载分页递增，作为缩略图节点 key 前缀并丢弃旧批次的加载回调。 */
  readonly batchEpoch: number;
  /** 大图预览是否已完成加载动画。 */
  readonly previewLoaded: boolean;

  /** 拉取指定页（缺省沿用当前页码与每页张数）；只采纳最后一次发起的请求结果，成功时开启新的缩略图批次。 */
  readonly loadGallery: (targetPage?: number, targetPageSize?: number) => Promise<void>;
  /** 缩略图加载完成或失败时调用：属于当前批次时在骨架屏最短展示时长后标记为已加载。 */
  readonly markThumbLoaded: (fileName: string, epoch: number) => void;
  /** 预览图切换后调用：开启新的预览加载周期并回到加载态。 */
  readonly beginPreviewLoad: () => void;
  /** 预览图加载完成或失败时调用：属于当前预览周期时在骨架屏最短展示时长后标记为已加载。 */
  readonly markPreviewLoaded: () => void;
  /** 设置或关闭大图预览，并同步开启新的预览加载周期、重置加载完成态。 */
  readonly setPreviewItem: (item: Readonly<MiniAppGalleryItem> | null) => void;
  /** 切换页码并加载该页（关闭大图预览）。 */
  readonly changePage: (page: number) => void;
  /** 切换每页张数并回到第 1 页（关闭大图预览，由组件按新张数重新加载）。 */
  readonly changePageSize: (pageSize: number) => void;
  /** 下载指定图片到系统默认下载目录，确认后以 Toast 回报。 */
  readonly downloadImage: (fileName: string) => Promise<void>;
  /** 确认后删除指定图片并重载当前页。 */
  readonly deleteImage: (fileName: string) => Promise<void>;
  /** 逐个上传选中的图片并汇总结果，完成后回到第 1 页重载。 */
  readonly uploadFiles: (files: readonly File[]) => Promise<void>;
}

/** 一个 `GalleryTab` 实例独占的状态仓库。 */
export type MiniAppGalleryStore = StoreApi<MiniAppGalleryStoreState>;

/**
 * 创建 `GalleryTab` 的状态仓库；组件挂载时创建、卸载即丢弃，生命周期与组件实例一致。
 *
 * @returns 新的图库管理仓库
 */
export function createGalleryStore(): MiniAppGalleryStore {
  return createStore<MiniAppGalleryStoreState>()(
    (
      set: (
        partial:
          | Partial<MiniAppGalleryStoreState>
          | ((state: MiniAppGalleryStoreState) => Partial<MiniAppGalleryStoreState>)
      ) => void,
      get: () => MiniAppGalleryStoreState
    ): MiniAppGalleryStoreState => {
      let requestSeq: number = 0;
      let currentBatchEpoch: number = 0;
      const pendingThumbKeys: Set<string> = new Set<string>();
      let previewEpoch: number = 0;
      let settledPreviewEpoch: number = -1;
      let pageRenderAt: number = Date.now();
      let previewRenderAt: number = Date.now();

      return {
        galleryPage: null,
        page: 1,
        pageSize: MINI_APP_GALLERY_DEFAULT_PAGE_SIZE,
        loading: true,
        uploading: false,
        deletingFileName: null,
        downloadingFileName: null,
        uploadStatusText: null,
        previewItem: null,
        loadedImages: {},
        batchEpoch: 0,
        previewLoaded: false,

        loadGallery: async (targetPage?: number, targetPageSize?: number): Promise<void> => {
          const reqPage: number = targetPage ?? get().page;
          const reqSize: number = targetPageSize ?? get().pageSize;
          const reqId: number = ++requestSeq;
          set({ loading: true });
          try {
            const result: MiniAppGalleryPage = await fetchMiniAppGallery(
              reqPage,
              reqSize
            );
            if (reqId !== requestSeq) {
              return;
            }
            const nextEpoch: number = currentBatchEpoch + 1;
            currentBatchEpoch = nextEpoch;
            pendingThumbKeys.clear();
            pageRenderAt = Date.now();
            set({
              batchEpoch: nextEpoch,
              loadedImages: {},
              galleryPage: result,
              page: result.page,
            });
          } catch (error: unknown) {
            if (reqId !== requestSeq) {
              return;
            }
            const message: string = errorMessage(error);
            useMiniAppStore.getState().notify(message, "info", error);
          } finally {
            if (reqId === requestSeq) {
              set({ loading: false });
            }
          }
        },

        markThumbLoaded: (fileName: string, epoch: number): void => {
          if (currentBatchEpoch !== epoch) {
            return;
          }
          const pendingKey: string = `${epoch}:${fileName}`;
          if (pendingThumbKeys.has(pendingKey)) {
            return;
          }
          pendingThumbKeys.add(pendingKey);
          void (async (): Promise<void> => {
            await waitMinimumLoadingDuration(pageRenderAt);
            if (currentBatchEpoch !== epoch) {
              return;
            }
            set((state: MiniAppGalleryStoreState): Partial<MiniAppGalleryStoreState> => ({
              loadedImages:
                state.loadedImages[fileName] === true
                  ? state.loadedImages
                  : { ...state.loadedImages, [fileName]: true },
            }));
          })();
        },

        beginPreviewLoad: (): void => {
          previewEpoch += 1;
          settledPreviewEpoch = -1;
          previewRenderAt = Date.now();
          set({ previewLoaded: false });
        },

        markPreviewLoaded: (): void => {
          const epoch: number = previewEpoch;
          if (settledPreviewEpoch === epoch) {
            return;
          }
          settledPreviewEpoch = epoch;
          void (async (): Promise<void> => {
            await waitMinimumLoadingDuration(previewRenderAt);
            if (previewEpoch !== epoch) {
              return;
            }
            set({ previewLoaded: true });
          })();
        },

        setPreviewItem: (item: Readonly<MiniAppGalleryItem> | null): void => {
          previewEpoch += 1;
          settledPreviewEpoch = -1;
          previewRenderAt = Date.now();
          set({ previewItem: item, previewLoaded: false });
        },

        changePage: (page: number): void => {
          previewEpoch += 1;
          settledPreviewEpoch = -1;
          set({ previewItem: null, previewLoaded: false, page });
          void get().loadGallery(page, get().pageSize);
        },

        changePageSize: (pageSize: number): void => {
          previewEpoch += 1;
          settledPreviewEpoch = -1;
          set({ previewItem: null, previewLoaded: false, page: 1, pageSize });
        },

        downloadImage: async (fileName: string): Promise<void> => {
          const t: Readonly<MiniAppTranslations> =
            getMiniAppTranslations(useMiniAppStore.getState().language);
          set({ downloadingFileName: fileName });
          try {
            const downloadFileName: string = buildMiniAppGalleryDownloadFileName(fileName);
            const accepted: boolean = await downloadMiniAppGalleryImageByName(fileName);
            if (accepted) {
              useMiniAppStore.getState().notify(t.gallery.downloadedToast(downloadFileName));
            }
          } catch (error: unknown) {
            const message: string = errorMessage(error);
            useMiniAppStore.getState().notify(message, "info", error);
          } finally {
            set({ downloadingFileName: null });
          }
        },

        deleteImage: async (fileName: string): Promise<void> => {
          const app: MiniAppUiStoreState = useMiniAppStore.getState();
          const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(app.language);
          const shortName: string = shortenGalleryFileName(fileName);
          if (!(await app.requestConfirm(t.gallery.confirmDeleteImage(shortName), "danger"))) {
            return;
          }
          set({ deletingFileName: fileName });
          try {
            const result: MiniAppGalleryDeleteResult =
              await deleteMiniAppGalleryImageByName(fileName);
            if (result.ok) {
              useMiniAppStore.getState().notify(t.gallery.deletedToast(shortName));
              if (get().previewItem?.fileName === fileName) {
                previewEpoch += 1;
                settledPreviewEpoch = -1;
                set({ previewItem: null, previewLoaded: false });
              }
              await get().loadGallery(get().page, get().pageSize);
            } else {
              useMiniAppStore.getState().notify(result.message, "danger", result);
            }
          } catch (error: unknown) {
            const message: string = errorMessage(error);
            useMiniAppStore.getState().notify(message, "danger", error);
          } finally {
            set({ deletingFileName: null });
          }
        },

        uploadFiles: async (files: readonly File[]): Promise<void> => {
          set({ uploading: true });
          let added: number = 0;
          let existing: number = 0;
          let invalidDimensions: number = 0;
          let failed: number = 0;
          let lastSingleResult: MiniAppGalleryUploadResult | null = null;

          try {
            for (let i: number = 0; i < files.length; i++) {
              const file: File | undefined = files[i];
              if (file === undefined) continue;
              set({
                uploadStatusText:
                  `(${i + 1}/${files.length}) ${truncateDisplayText(shortenGalleryFileName(file.name), 20)}…`,
              });
              try {
                const buffer: ArrayBuffer = await file.arrayBuffer();
                const bytes: Uint8Array = new Uint8Array(buffer);
                const result: MiniAppGalleryUploadResult =
                  await uploadMiniAppGalleryImageBytes(bytes);
                lastSingleResult = result;
                if (result.outcome === "added") {
                  added++;
                } else if (result.outcome === "existing") {
                  existing++;
                } else if (result.outcome === "invalidDimensions") {
                  invalidDimensions++;
                } else {
                  failed++;
                }
              } catch (_error: unknown) {
                failed++;
              }
            }

            if (files.length === 1 && lastSingleResult !== null) {
              useMiniAppStore
                .getState()
                .notify(
                  lastSingleResult.message,
                  lastSingleResult.ok ? "info" : "warning",
                  lastSingleResult
                );
            } else {
              useMiniAppStore.getState().notify(
                `+${added} · =${existing} · !${invalidDimensions + failed}`
              );
            }
            await get().loadGallery(1, get().pageSize);
          } finally {
            set({ uploading: false, uploadStatusText: null });
          }
        },
      };
    }
  );
}
