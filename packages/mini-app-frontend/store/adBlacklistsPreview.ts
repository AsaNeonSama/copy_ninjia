import { fetchMiniAppAdBlacklistPreview } from "../api/adBlacklists";
import {
  extractServerNoticeParams,
  getMiniAppTranslations,
} from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { errorMessage } from "../libs/errorMessage";
import { waitMinimumLoadingDuration } from "../libs/loading";
import type {
  MiniAppAdBlacklistKind,
  MiniAppAdBlacklistPreviewItem,
  MiniAppAdBlacklistPreviewResponse,
} from "../types/miniApp/adBlacklists";
import { notifyMiniAppIfAuthError, useMiniAppStore } from "./app";
import type { MiniAppToastTone } from "./app";

/** 当前页内预览弹窗指向的贴纸包或自定义表情包目标。 */
export interface MiniAppAdBlacklistPreviewTarget {
  /** 目标所属黑名单种类（`"sticker"` 或 `"emoji"`）。 */
  readonly kind: MiniAppAdBlacklistKind;
  /** 目标包的 short name。 */
  readonly pack: string;
}

/** `AdBlacklistsPage` 页内贴纸/表情包预览弹窗独占的状态与动作切片。 */
export interface MiniAppAdBlacklistsPreviewSlice {
  /** 当前打开的页内预览目标（关闭时为 `null`）。 */
  readonly previewTarget: Readonly<MiniAppAdBlacklistPreviewTarget> | null;
  /** 已加载的包元数据与累计预览缩略图分页响应（尚未确认元数据或关闭时为 `null`）。 */
  readonly previewData: Readonly<MiniAppAdBlacklistPreviewResponse> | null;
  /** 是否正在拉取包元数据以确认总枚数与本页精确格数。 */
  readonly previewLoadingMeta: boolean;
  /** 首屏元数据已确认后，是否正在拉取本页精确格数的静态缩略图。 */
  readonly previewLoadingImages: boolean;
  /** 是否正在加载当前包的下一页缩略图。 */
  readonly previewLoadingMore: boolean;
  /** 首屏元数据拉取失败时的本地化错误说明（无错时为 `null`）。 */
  readonly previewError: string | null;
  /** 打开指定包的页内预览弹窗：先拉取 `metaOnly=1` 确认总枚数与精确格数，再按需加载本页缩略图，自动中止前一次未完成请求。 */
  readonly openPreview: (pack: string) => Promise<void>;
  /** 在当前预览目标上重新拉取元数据与首屏缩略图。 */
  readonly retryPreview: () => Promise<void>;
  /** 为当前已打开的预览追加拉取下一页缩略图（失败时保留已加载内容并通过 Toast 报错）。 */
  readonly loadMorePreview: () => Promise<void>;
  /** 关闭页内预览弹窗并中止任何在途预览请求。 */
  readonly closePreview: () => void;
}

/** 构造预览切片时所需的父仓库读取与写入桥接。 */
export interface CreateAdBlacklistsPreviewSliceOptions {
  /** 更新内容黑名单仓库状态的回调。 */
  readonly set: (partial: Partial<MiniAppAdBlacklistsPreviewSlice>) => void;
  /** 读取当前预览切片与激活子页签种类的回调。 */
  readonly get: () => MiniAppAdBlacklistsPreviewSlice & {
    readonly kind: MiniAppAdBlacklistKind;
  };
  /** 派发顶部 Toast 提示的回调。 */
  readonly notify: (
    message: string,
    tone?: MiniAppToastTone,
    metaSource?: unknown
  ) => void;
}

/**
 * 创建 `AdBlacklistsPage` 页内包预览弹窗的状态切片与两阶段加载动作：
 * - 第一阶段请求 `metaOnly=1` 迅速确认包标题、总枚数与本页精确条目数；
 * - 第二阶段按需加载本页缩略图并保证精确格数图片骨架的最短平滑展示时长；
 * - 维护单调请求序号与 `AbortController`，切换目标包或关闭弹窗时立即中止旧请求并丢弃过期响应。
 *
 * @param options 状态更新器、状态读取器与 Toast 通知回调
 * @returns 页内包预览切片
 */
export function createAdBlacklistsPreviewSlice({
  set,
  get,
  notify,
}: Readonly<CreateAdBlacklistsPreviewSliceOptions>): MiniAppAdBlacklistsPreviewSlice {
  let previewSeq: number = 0;
  let previewAbortController: AbortController | null = null;

  const cancelInFlightPreview = (): number => {
    previewSeq += 1;
    previewAbortController?.abort();
    previewAbortController = null;
    return previewSeq;
  };

  const loadPreviewInitial = async (
    target: Readonly<MiniAppAdBlacklistPreviewTarget>
  ): Promise<void> => {
    const reqId: number = cancelInFlightPreview();
    const controller: AbortController = new AbortController();
    previewAbortController = controller;
    set({
      previewTarget: target,
      previewData: null,
      previewLoadingMeta: true,
      previewLoadingImages: false,
      previewLoadingMore: false,
      previewError: null,
    });

    let metaPage: MiniAppAdBlacklistPreviewResponse;
    try {
      metaPage = await fetchMiniAppAdBlacklistPreview({
        kind: target.kind,
        pack: target.pack,
        offset: 0,
        metaOnly: true,
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (controller.signal.aborted || reqId !== previewSeq) {
        if (!controller.signal.aborted) {
          notifyMiniAppIfAuthError(error);
        }
        return;
      }
      if (previewAbortController === controller) {
        previewAbortController = null;
      }
      if (notifyMiniAppIfAuthError(error)) {
        set({ previewLoadingMeta: false });
        return;
      }
      const latestT: Readonly<MiniAppTranslations> = getMiniAppTranslations(
        useMiniAppStore.getState().language
      );
      const raw: string = errorMessage(error);
      const localized: string = latestT.serverNotice(
        raw,
        extractServerNoticeParams(error)
      );
      set({
        previewLoadingMeta: false,
        previewError: localized,
      });
      return;
    }

    if (reqId !== previewSeq) {
      return;
    }

    const needsImages: boolean = metaPage.items.some(
      (item: Readonly<MiniAppAdBlacklistPreviewItem>): boolean => item.hasImage
    );
    const imagesStartedAt: number = Date.now();
    set({
      previewData: metaPage,
      previewLoadingMeta: false,
      previewLoadingImages: needsImages,
      previewError: null,
    });

    if (!needsImages) {
      if (previewAbortController === controller) {
        previewAbortController = null;
      }
      return;
    }

    try {
      const hydratedPage: MiniAppAdBlacklistPreviewResponse =
        await fetchMiniAppAdBlacklistPreview({
          kind: target.kind,
          pack: target.pack,
          offset: 0,
          metaOnly: false,
          signal: controller.signal,
        });
      await waitMinimumLoadingDuration(imagesStartedAt);
      if (reqId !== previewSeq) {
        return;
      }
      set({
        previewData: hydratedPage,
        previewLoadingImages: false,
      });
    } catch (error: unknown) {
      if (controller.signal.aborted || reqId !== previewSeq) {
        if (!controller.signal.aborted) {
          notifyMiniAppIfAuthError(error);
        }
        return;
      }
      set({ previewLoadingImages: false });
      if (notifyMiniAppIfAuthError(error)) {
        return;
      }
      notify(errorMessage(error), "danger", error);
    } finally {
      if (previewAbortController === controller) {
        previewAbortController = null;
      }
    }
  };

  return {
    previewTarget: null,
    previewData: null,
    previewLoadingMeta: false,
    previewLoadingImages: false,
    previewLoadingMore: false,
    previewError: null,

    openPreview: async (pack: string): Promise<void> => {
      const target: Readonly<MiniAppAdBlacklistPreviewTarget> = {
        kind: get().kind,
        pack,
      };
      await loadPreviewInitial(target);
    },

    retryPreview: async (): Promise<void> => {
      const target: Readonly<MiniAppAdBlacklistPreviewTarget> | null =
        get().previewTarget;
      if (
        target === null ||
        get().previewLoadingMeta ||
        get().previewLoadingImages
      ) {
        return;
      }
      await loadPreviewInitial(target);
    },

    loadMorePreview: async (): Promise<void> => {
      const {
        previewTarget,
        previewData,
        previewLoadingMeta,
        previewLoadingImages,
        previewLoadingMore,
      }: MiniAppAdBlacklistsPreviewSlice = get();
      if (
        previewTarget === null ||
        previewData === null ||
        !previewData.hasMore ||
        previewLoadingMeta ||
        previewLoadingImages ||
        previewLoadingMore
      ) {
        return;
      }
      const reqId: number = cancelInFlightPreview();
      const controller: AbortController = new AbortController();
      previewAbortController = controller;
      const startedAt: number = Date.now();
      set({ previewLoadingMore: true });

      try {
        const nextPage: MiniAppAdBlacklistPreviewResponse =
          await fetchMiniAppAdBlacklistPreview({
            kind: previewTarget.kind,
            pack: previewTarget.pack,
            offset: previewData.nextOffset,
            metaOnly: false,
            signal: controller.signal,
          });
        await waitMinimumLoadingDuration(startedAt);
        if (reqId !== previewSeq) {
          return;
        }
        const currentData: Readonly<MiniAppAdBlacklistPreviewResponse> | null =
          get().previewData;
        if (currentData === null) {
          set({ previewLoadingMore: false });
          return;
        }
        set({
          previewData: {
            ...nextPage,
            items: [...currentData.items, ...nextPage.items],
          },
          previewLoadingMore: false,
        });
      } catch (error: unknown) {
        if (controller.signal.aborted || reqId !== previewSeq) {
          if (!controller.signal.aborted) {
            notifyMiniAppIfAuthError(error);
          }
          return;
        }
        set({ previewLoadingMore: false });
        if (notifyMiniAppIfAuthError(error)) {
          return;
        }
        notify(errorMessage(error), "danger", error);
      } finally {
        if (previewAbortController === controller) {
          previewAbortController = null;
        }
      }
    },

    closePreview: (): void => {
      cancelInFlightPreview();
      set({
        previewTarget: null,
        previewData: null,
        previewLoadingMeta: false,
        previewLoadingImages: false,
        previewLoadingMore: false,
        previewError: null,
      });
    },
  };
}
