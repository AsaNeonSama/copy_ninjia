import { useEffect, useRef, useState } from "react";
import type React from "react";
import { fetchMiniAppGalleryImageObjectUrl } from "../api/galleryFile";
import { MINI_APP_GALLERY_BLOB_CACHE_MAX } from "../consts/miniApp";
import { notifyMiniAppIfAuthError } from "../store/app";
import type { MiniAppGalleryItem } from "../types/miniApp/gallery";

/** 更新图片对象 URL 只读字典状态的 React 状态派发器类型。 */
type SetImageObjectUrls = React.Dispatch<
  React.SetStateAction<Readonly<Record<string, string>>>
>;

/** 单张缩略图拉取结算回调签名。 */
type MarkThumbLoadedCallback = (fileName: string, epoch: number) => void;

/** `useGalleryImageUrls` 钩子的入参。 */
export interface UseGalleryImageUrlsParams {
  /** 当前页缩略图条目列表（目录未就绪或尚未加载完成时为 `null`）。 */
  readonly items: readonly Readonly<MiniAppGalleryItem>[] | null;
  /** 当前展示中的大图预览条目（含收起退场保留期快照，无预览时为 `null`）。 */
  readonly displayPreviewItem: Readonly<MiniAppGalleryItem> | null;
  /** 当前缩略图列表批次版本号（与 `GalleryGridList` 加载回调保持代际一致）。 */
  readonly batchEpoch: number;
  /** 当前正在删除的文件名（无在途删除时为 `null`，删除完成且离开可见集后用于立即释放对应 `blob:` URL）。 */
  readonly deletingFileName: string | null;
  /** 单张缩略图拉取失败结算时触发的加载完成回调，避免骨架屏永久停留在加载态。 */
  readonly onMarkThumbLoaded: MarkThumbLoadedCallback;
  /** 预览大图拉取失败结算时触发的加载完成回调，避免预览骨架屏永久停留在加载态。 */
  readonly onMarkPreviewLoaded: () => void;
}

/** `useGalleryImageUrls` 单一 `useRef` 持有的内聚控制器状态（集中管理缓存、在途请求、失败去重、复用的可见集与微任务合批状态）。 */
interface GalleryImageUrlsController {
  /** 文件名到已就绪 `blob:` 对象 URL 的内存缓存表（按插入/访问顺序维护淘汰顺序）。 */
  readonly cache: Map<string, string>;
  /** 当前仍在请求中的文件名到 `AbortController` 映射表。 */
  readonly inFlight: Map<string, AbortController>;
  /** 当前缩略图批次内拉取失败的文件名集合（用于同批次内避免重复请求）。 */
  readonly failedThumbSet: Set<string>;
  /** 复用中的当前页缩略图文件名集合（在副作用同步阶段就地刷新，避免每轮重新构造临时集合）。 */
  readonly itemSet: Set<string>;
  /** 复用中的当前页缩略图与预览大图文件名并集（在副作用同步阶段就地刷新）。 */
  readonly visibleSet: Set<string>;
  /** `failedThumbSet` 当前对应的缩略图批次版本号。 */
  failedThumbEpoch: number;
  /** 最近一次预览大图拉取失败的复合键（`${batchEpoch}:${fileName}`），无失败时为 `null`。 */
  failedPreviewKey: string | null;
  /** 最新提交对应的预览大图文件名（无预览时为 `null`）。 */
  previewFileName: string | null;
  /** 最新提交对应的缩略图批次版本号。 */
  batchEpoch: number;
  /** 上一次提交时的 `deletingFileName`，用于识别删除完成且图片离开可见集后的即时释放时机。 */
  prevDeletingFileName: string | null;
  /** 钩子所属组件实例当前是否处于已挂载状态。 */
  mounted: boolean;
  /** 单调递增的生命周期代际号（在挂载重建与卸载清理时递增，使滞后微任务与已失效异步回调立即退出）。 */
  generation: number;
  /** 是否已排期微任务用于合批提交 `setImageObjectUrls` 快照。 */
  snapshotFlushScheduled: boolean;
  /** 标记单张缩略图加载完成或失败的最新回调引用。 */
  onMarkThumbLoaded: MarkThumbLoadedCallback;
  /** 标记预览大图加载完成或失败的最新回调引用。 */
  onMarkPreviewLoaded: () => void;
}

/**
 * 将缓存 `Map` 复制为供 React 渲染属性浅比较使用的只读平面字典。
 *
 * @param cacheMap 文件名到 `blob:` 对象 URL 的内存缓存表
 * @returns 新的文件名到 `blob:` URL 只读字典快照
 */
function snapshotBlobUrlRecord(
  cacheMap: ReadonlyMap<string, string>
): Readonly<Record<string, string>> {
  const next: Record<string, string> = {};
  for (const [fileName, objectUrl] of cacheMap) {
    next[fileName] = objectUrl;
  }
  return next;
}

/**
 * 当内存缓存条数超过 `MINI_APP_GALLERY_BLOB_CACHE_MAX` 时，按插入顺序淘汰最旧的非当前可见条目并调用 `URL.revokeObjectURL` 释放内存。
 *
 * @param cacheMap 文件名到 `blob:` 对象 URL 的可变缓存表
 * @param visibleSet 当前页面与预览区域正在展示的文件名集合
 */
function evictOldestNonVisibleBlobUrls(
  cacheMap: Map<string, string>,
  visibleSet: ReadonlySet<string>
): void {
  if (cacheMap.size <= MINI_APP_GALLERY_BLOB_CACHE_MAX) {
    return;
  }
  for (const [cachedName, cachedUrl] of cacheMap) {
    if (cacheMap.size <= MINI_APP_GALLERY_BLOB_CACHE_MAX) {
      break;
    }
    if (visibleSet.has(cachedName)) {
      continue;
    }
    cacheMap.delete(cachedName);
    URL.revokeObjectURL(cachedUrl);
  }
}

/**
 * 构造并一次性按固定字段顺序初始化图库图片 URL 控制器实例。
 *
 * @param batchEpoch 初始缩略图批次版本号
 * @param onMarkThumbLoaded 单张缩略图拉取结算回调
 * @param onMarkPreviewLoaded 预览大图拉取结算回调
 * @returns 初始化后的单实例控制器
 */
function createGalleryImageUrlsController(
  batchEpoch: number,
  onMarkThumbLoaded: MarkThumbLoadedCallback,
  onMarkPreviewLoaded: () => void
): GalleryImageUrlsController {
  return {
    cache: new Map<string, string>(),
    inFlight: new Map<string, AbortController>(),
    failedThumbSet: new Set<string>(),
    itemSet: new Set<string>(),
    visibleSet: new Set<string>(),
    failedThumbEpoch: batchEpoch,
    failedPreviewKey: null,
    previewFileName: null,
    batchEpoch,
    prevDeletingFileName: null,
    mounted: true,
    generation: 0,
    snapshotFlushScheduled: false,
    onMarkThumbLoaded,
    onMarkPreviewLoaded,
  };
}

/**
 * 释放控制器持有的全部在途请求、`blob:` 对象 URL 与状态集合，并递增代际号使滞后微任务与回调失效。
 *
 * @param ctrl 图库图片 URL 控制器实例
 */
function disposeGalleryImageUrlsController(
  ctrl: GalleryImageUrlsController
): void {
  ctrl.mounted = false;
  ctrl.generation += 1;
  ctrl.snapshotFlushScheduled = false;
  for (const [, abortCtrl] of ctrl.inFlight) {
    abortCtrl.abort();
  }
  ctrl.inFlight.clear();
  for (const [, objectUrl] of ctrl.cache) {
    URL.revokeObjectURL(objectUrl);
  }
  ctrl.cache.clear();
  ctrl.failedThumbSet.clear();
  ctrl.itemSet.clear();
  ctrl.visibleSet.clear();
  ctrl.failedPreviewKey = null;
  ctrl.prevDeletingFileName = null;
}

/**
 * 在同一微任务轮次内合批排期一次 `setImageObjectUrls` 快照提交：
 * 同轮次并发完成的多张图片仅触发一次 React 状态更新；组件卸载或代际失效时丢弃陈旧提交。
 *
 * @param ctrl 图库图片 URL 控制器实例
 * @param setImageObjectUrls 更新 React 状态快照的派发器
 */
function scheduleSnapshotFlush(
  ctrl: GalleryImageUrlsController,
  setImageObjectUrls: SetImageObjectUrls
): void {
  if (ctrl.snapshotFlushScheduled) {
    return;
  }
  ctrl.snapshotFlushScheduled = true;
  const scheduledGeneration: number = ctrl.generation;
  queueMicrotask((): void => {
    if (
      !ctrl.mounted ||
      ctrl.generation !== scheduledGeneration ||
      !ctrl.snapshotFlushScheduled
    ) {
      return;
    }
    ctrl.snapshotFlushScheduled = false;
    setImageObjectUrls(snapshotBlobUrlRecord(ctrl.cache));
  });
}

/**
 * 发起单张图库图片的加密二进制拉取并维护内存缓存、失败结算、超限淘汰与微任务合批提交；
 * 若请求所属运行已被取消或组件已卸载，则立即调用 `URL.revokeObjectURL` 释放生成的对象 URL。
 *
 * @param ctrl 图库图片 URL 控制器实例
 * @param fileName 待拉取的图库文件名
 * @param setImageObjectUrls 更新 React 状态快照的派发器
 */
function startGalleryImageFetch(
  ctrl: GalleryImageUrlsController,
  fileName: string,
  setImageObjectUrls: SetImageObjectUrls
): void {
  const abortCtrl: AbortController = new AbortController();
  const fetchGeneration: number = ctrl.generation;
  ctrl.inFlight.set(fileName, abortCtrl);
  void (async (): Promise<void> => {
    try {
      const objectUrl: string = await fetchMiniAppGalleryImageObjectUrl(
        fileName,
        abortCtrl.signal
      );
      if (
        !ctrl.mounted ||
        ctrl.generation !== fetchGeneration ||
        abortCtrl.signal.aborted ||
        ctrl.inFlight.get(fileName) !== abortCtrl
      ) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      ctrl.inFlight.delete(fileName);
      ctrl.failedThumbSet.delete(fileName);
      if (ctrl.failedPreviewKey === `${ctrl.batchEpoch}:${fileName}`) {
        ctrl.failedPreviewKey = null;
      }
      const previousUrl: string | undefined = ctrl.cache.get(fileName);
      if (previousUrl !== undefined && previousUrl !== objectUrl) {
        URL.revokeObjectURL(previousUrl);
      }
      ctrl.cache.delete(fileName);
      ctrl.cache.set(fileName, objectUrl);
      evictOldestNonVisibleBlobUrls(ctrl.cache, ctrl.visibleSet);
      scheduleSnapshotFlush(ctrl, setImageObjectUrls);
    } catch (error: unknown) {
      const isCurrentInFlight: boolean = ctrl.inFlight.get(fileName) === abortCtrl;
      if (isCurrentInFlight) {
        ctrl.inFlight.delete(fileName);
      }
      if (
        !ctrl.mounted ||
        ctrl.generation !== fetchGeneration ||
        abortCtrl.signal.aborted ||
        !isCurrentInFlight
      ) {
        if (ctrl.mounted && !abortCtrl.signal.aborted) {
          notifyMiniAppIfAuthError(error);
        }
        return;
      }
      notifyMiniAppIfAuthError(error);
      if (ctrl.itemSet.has(fileName)) {
        if (ctrl.failedThumbEpoch === ctrl.batchEpoch) {
          ctrl.failedThumbSet.add(fileName);
        }
        ctrl.onMarkThumbLoaded(fileName, ctrl.batchEpoch);
      }
      if (ctrl.previewFileName === fileName) {
        ctrl.failedPreviewKey = `${ctrl.batchEpoch}:${fileName}`;
        ctrl.onMarkPreviewLoaded();
      }
    }
  })();
}

/**
 * 图库图片 `blob:` 对象 URL 拉取与组件生命周期缓存钩子：
 * - 在组件实例内以单一控制器 `useRef` 维护已就绪缓存 `Map<string, string>`（上限 `MINI_APP_GALLERY_BLOB_CACHE_MAX`）、在途请求 `Map<string, AbortController>` 与复用的可见文件名集合；
 * - 通过 `fetchMiniAppGalleryImageObjectUrl`（底层复用 7 天本地 `ETag` 协商缓存）并发拉取当前页缩略图与预览大图，并以 `queueMicrotask` 将同轮并发完成合并为单次 React 快照提交；
 * - 当 `deletingFileName` 由非空回落为 `null` 且原删除文件名已不在可见集合内时，立即调用 `URL.revokeObjectURL` 释放并移除其缓存条目及刷新快照；
 * - 切离页面的在途请求立即中止，超出上限时按插入顺序淘汰最旧非可见条目，组件卸载时中止全部在途请求、失效滞后微任务并 `URL.revokeObjectURL` 释放全部对象 URL；
 * - 单张拉取失败时调用 `onMarkThumbLoaded` / `onMarkPreviewLoaded` 结算骨架屏，命中会话失效/锁定时通过全局 `notify` 触发门禁锁定。
 *
 * @param params 当前可见图片列表、预览条目、删除状态与骨架屏结算回调
 * @returns 文件名到已就绪 `blob:` 对象 URL 的只读映射表
 */
export function useGalleryImageUrls({
  items,
  displayPreviewItem,
  batchEpoch,
  deletingFileName,
  onMarkThumbLoaded,
  onMarkPreviewLoaded,
}: UseGalleryImageUrlsParams): Readonly<Record<string, string>> {
  const [imageObjectUrls, setImageObjectUrls]: [
    Readonly<Record<string, string>>,
    SetImageObjectUrls
  ] = useState<Readonly<Record<string, string>>>({});
  const ctrlRef: React.RefObject<GalleryImageUrlsController | null> =
    useRef<GalleryImageUrlsController | null>(null);

  useEffect((): (() => void) => {
    const ctrl: GalleryImageUrlsController =
      ctrlRef.current ??
      createGalleryImageUrlsController(
        batchEpoch,
        onMarkThumbLoaded,
        onMarkPreviewLoaded
      );
    ctrlRef.current = ctrl;
    ctrl.mounted = true;
    ctrl.generation += 1;
    return (): void => {
      disposeGalleryImageUrlsController(ctrl);
    };
  }, []);

  useEffect((): void => {
    const ctrl: GalleryImageUrlsController =
      ctrlRef.current ??
      createGalleryImageUrlsController(
        batchEpoch,
        onMarkThumbLoaded,
        onMarkPreviewLoaded
      );
    ctrlRef.current = ctrl;

    if (ctrl.failedThumbEpoch !== batchEpoch) {
      ctrl.failedThumbEpoch = batchEpoch;
      ctrl.failedThumbSet.clear();
    }

    ctrl.itemSet.clear();
    ctrl.visibleSet.clear();
    if (items !== null) {
      for (const item of items) {
        ctrl.itemSet.add(item.fileName);
        ctrl.visibleSet.add(item.fileName);
      }
    }
    const previewFileName: string | null = displayPreviewItem?.fileName ?? null;
    const previewFailureKey: string | null =
      previewFileName !== null ? `${batchEpoch}:${previewFileName}` : null;
    if (previewFileName !== null) {
      ctrl.visibleSet.add(previewFileName);
    } else {
      ctrl.failedPreviewKey = null;
    }

    ctrl.previewFileName = previewFileName;
    ctrl.batchEpoch = batchEpoch;
    ctrl.onMarkThumbLoaded = onMarkThumbLoaded;
    ctrl.onMarkPreviewLoaded = onMarkPreviewLoaded;

    const prevDeletingFileName: string | null = ctrl.prevDeletingFileName;
    ctrl.prevDeletingFileName = deletingFileName;
    if (
      prevDeletingFileName !== null &&
      deletingFileName === null &&
      !ctrl.visibleSet.has(prevDeletingFileName)
    ) {
      ctrl.failedThumbSet.delete(prevDeletingFileName);
      const deletedUrl: string | undefined = ctrl.cache.get(prevDeletingFileName);
      if (deletedUrl !== undefined) {
        URL.revokeObjectURL(deletedUrl);
        ctrl.cache.delete(prevDeletingFileName);
        ctrl.snapshotFlushScheduled = false;
        setImageObjectUrls(snapshotBlobUrlRecord(ctrl.cache));
      }
    }

    for (const [inFlightName, abortCtrl] of ctrl.inFlight) {
      if (!ctrl.visibleSet.has(inFlightName)) {
        abortCtrl.abort();
        ctrl.inFlight.delete(inFlightName);
      }
    }

    for (const fileName of ctrl.visibleSet) {
      const cachedUrl: string | undefined = ctrl.cache.get(fileName);
      if (cachedUrl !== undefined) {
        // 刷新当前可见条目的插入顺序，确保后续超出上限时优先淘汰最久未见的隐藏条目。
        ctrl.cache.delete(fileName);
        ctrl.cache.set(fileName, cachedUrl);
        continue;
      }
      if (ctrl.inFlight.has(fileName)) {
        continue;
      }
      const isCurrentPreview: boolean = fileName === previewFileName;
      if (!isCurrentPreview && ctrl.failedThumbSet.has(fileName)) {
        continue;
      }
      if (isCurrentPreview && ctrl.failedPreviewKey === previewFailureKey) {
        continue;
      }
      startGalleryImageFetch(ctrl, fileName, setImageObjectUrls);
    }
  }, [
    batchEpoch,
    deletingFileName,
    displayPreviewItem,
    items,
    onMarkPreviewLoaded,
    onMarkThumbLoaded,
  ]);

  return imageObjectUrls;
}
