import { afterEach, describe, expect, jest, test } from "bun:test";
import { createElement } from "react";
import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CapabilityCollapseBody,
  resolveCapabilityFollowScroll,
} from "../../packages/mini-app-frontend/components/animations/CapabilityCollapseBody";
import {
  scheduleDelayedUnmountEffect,
  useClosingSnapshot,
  useDelayedUnmount,
} from "../../packages/mini-app-frontend/components/animations/useDelayedUnmount";
import type { FlipAnimatableElement } from "../../packages/mini-app-frontend/components/animations/flipCollapse";
import { GalleryGridList } from "../../packages/mini-app-frontend/components/GalleryGridList";
import { GalleryPreviewCard } from "../../packages/mini-app-frontend/components/GalleryPreviewCard";
import { PaginationBar } from "../../packages/mini-app-frontend/components/PaginationBar";
import {
  MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX,
  MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import type { MiniAppGalleryItem } from "../../packages/mini-app-frontend/types/miniApp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";

const zh: Readonly<MiniAppTranslations> = getMiniAppTranslations("zh");

afterEach((): void => {
  jest.useRealTimers();
});

describe("Mini App 图库、分页与折叠动画组件", () => {
  test("PaginationBar 覆盖页码边界禁用、尺寸选项开关与摘要文本", () => {
    const firstPageHtml: string = renderToStaticMarkup(createElement(PaginationBar, {
      page: 0,
      totalPages: 3,
      total: 42,
      pageSize: MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS[0]!,
      pageSizeOptions: MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS,
      onPageChange: (): void => {},
      onPageSizeChange: (): void => {},
    }));
    expect(firstPageHtml).toContain(zh.pagination.summary(42, 1, 3));
    expect(firstPageHtml).toContain(`class="page-size-pill active "`);

    const lastPageHtml: string = renderToStaticMarkup(createElement(PaginationBar, {
      page: 99,
      totalPages: 3,
      total: 42,
      pageSize: MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS[0]!,
      disabled: true,
      onPageChange: (): void => {},
    }));
    expect(lastPageHtml).toContain(zh.pagination.summary(42, 3, 3));
    expect(lastPageHtml).not.toContain("pagination-sizes");
  });

  test("GalleryGridList 覆盖选中态、骨架与已加载缩略图、删除/下载中状态", () => {
    const items: readonly Readonly<MiniAppGalleryItem>[] = [
      { fileName: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png", mimeType: "image/png", sizeBytes: 2048, updatedAt: "2026-01-01 10:00:00" },
      { fileName: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png", mimeType: "image/png", sizeBytes: 4096, updatedAt: "2026-01-01 11:00:00" },
    ];
    const html: string = renderToStaticMarkup(createElement(GalleryGridList, {
      items,
      previewItem: items[0]!,
      deletingFileName: items[0]!.fileName,
      downloadingFileName: null,
      loadedImages: { [items[1]!.fileName]: true },
      batchEpoch: 2,
      t: zh,
      onMarkThumbLoaded: (): void => {},
      onSelectPreviewItem: (): void => {},
      onDownloadImage: (): void => {},
      onDeleteImage: (): void => {},
    }));
    expect(html).toContain("gallery-card selected");
    expect(html).toContain("gallery-thumb loading");
    expect(html).toContain("gallery-thumb loaded");
    expect(html).toContain(zh.gallery.deletingButton);

    const downloadingHtml: string = renderToStaticMarkup(createElement(GalleryGridList, {
      items: [items[1]!],
      previewItem: null,
      deletingFileName: null,
      downloadingFileName: items[1]!.fileName,
      loadedImages: {},
      batchEpoch: 3,
      t: zh,
      onMarkThumbLoaded: (): void => {},
      onSelectPreviewItem: (): void => {},
      onDownloadImage: (): void => {},
      onDeleteImage: (): void => {},
    }));
    expect(downloadingHtml).toContain(zh.gallery.downloadingButton);
  });

  test("GalleryPreviewCard 覆盖骨架未就绪、已加载与收起禁用态", () => {
    const item: Readonly<MiniAppGalleryItem> = {
      fileName: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      updatedAt: "2026-01-01 12:00:00",
    };
    const loadingHtml: string = renderToStaticMarkup(createElement(GalleryPreviewCard, {
      previewItem: item,
      previewLoaded: false,
      downloadingFileName: item.fileName,
      deletingFileName: null,
      onMarkPreviewLoaded: (): void => {},
      onDownloadImage: (): void => {},
      onDeleteImage: (): void => {},
      onClosePreview: (): void => {},
    }));
    expect(loadingHtml).toContain("gallery-preview-img loading");
    expect(loadingHtml).toContain(zh.gallery.downloadingButton);

    const closingHtml: string = renderToStaticMarkup(createElement(GalleryPreviewCard, {
      previewItem: item,
      previewLoaded: true,
      isClosing: true,
      downloadingFileName: null,
      deletingFileName: item.fileName,
      onMarkPreviewLoaded: (): void => {},
      onDownloadImage: (): void => {},
      onDeleteImage: (): void => {},
      onClosePreview: (): void => {},
    }));
    expect(closingHtml).toContain("gallery-preview-img loaded");
    expect(closingHtml).toContain(zh.gallery.deletingButton);
    expect(closingHtml).toContain("disabled=\"\"");
  });

  test("CapabilityCollapseBody 与 resolveCapabilityFollowScroll 覆盖展开类名及父节点锚点解析", () => {
    const slotRef: React.RefObject<null> = { current: null };
    const collapsedHtml: string = renderToStaticMarkup(createElement(
      CapabilityCollapseBody,
      { expanded: false, followScrollSlotRef: slotRef, children: createElement("span", null, "body") }
    ));
    expect(collapsedHtml).toContain('aria-hidden="true"');
    expect(collapsedHtml).not.toContain("expanded");

    const expandedHtml: string = renderToStaticMarkup(createElement(
      CapabilityCollapseBody,
      { expanded: true, followScrollSlotRef: slotRef, children: createElement("span", null, "body") }
    ));
    expect(expandedHtml).toContain("cap-collapse-wrap expanded");
    expect(expandedHtml).toContain('aria-hidden="false"');

    const stubClassList = {
      add: (): void => {},
      remove: (): void => {},
      contains: (): boolean => false,
    };
    const elementWithoutParent: FlipAnimatableElement = {
      style: { transform: "", willChange: "" },
      classList: stubClassList,
      parentElement: null,
      getBoundingClientRect: (): { top: number; height: number } => ({ top: 100, height: 0 }),
    };
    expect(resolveCapabilityFollowScroll(elementWithoutParent, 200)).toBeNull();

    const host = globalThis as { innerHeight?: unknown; scrollBy?: unknown };
    const prevInnerHeight: unknown = host.innerHeight;
    const prevScrollBy: unknown = host.scrollBy;
    try {
      host.innerHeight = 400;
      host.scrollBy = (): void => {};
      const elementWithParent: FlipAnimatableElement = {
        style: { transform: "", willChange: "" },
        classList: stubClassList,
        parentElement: {
          getBoundingClientRect: (): { top: number; height: number } => ({ top: 200, height: 300 }),
        },
        getBoundingClientRect: (): { top: number; height: number } => ({ top: 240, height: 0 }),
      };
      const target = resolveCapabilityFollowScroll(
        elementWithParent,
        240 + MINI_APP_EXPAND_SCROLL_MIN_DELTA_PX
      );
      expect(target).not.toBeNull();
      expect(target!.fromTop).toBe(200);
      expect(target!.toTop).toBeLessThan(target!.fromTop);
    } finally {
      host.innerHeight = prevInnerHeight;
      host.scrollBy = prevScrollBy;
    }
  });

  test("useDelayedUnmount、useClosingSnapshot 与 scheduleDelayedUnmountEffect 覆盖延迟清理与提前取消", () => {
    const HookProbe = (props: { readonly activeValue: string | null }): React.JSX.Element => {
      const delayed = useDelayedUnmount(props.activeValue, 120);
      const snapshot: string = useClosingSnapshot(props.activeValue ?? "fallback", props.activeValue !== null);
      return createElement("div", null, `${String(delayed.displayValue)}|${String(delayed.isClosing)}|${snapshot}`);
    };
    expect(renderToStaticMarkup(createElement(HookProbe, { activeValue: "open" }))).toContain("open|false|open");
    expect(renderToStaticMarkup(createElement(HookProbe, { activeValue: null }))).toContain("null|false|fallback");

    jest.useFakeTimers();
    const lastNonNullRef: { current: string | null } = { current: "retained" };
    let unmounted: boolean = false;
    const setUnmounted = (value: boolean): void => {
      unmounted = value;
    };

    expect(scheduleDelayedUnmountEffect({
      activeValue: "retained",
      durationMs: 120,
      lastNonNullRef,
      setUnmounted,
    })).toBeUndefined();

    expect(scheduleDelayedUnmountEffect({
      activeValue: null,
      durationMs: 120,
      lastNonNullRef: { current: null },
      setUnmounted,
    })).toBeUndefined();

    const cancelEarly: (() => void) | undefined = scheduleDelayedUnmountEffect({
      activeValue: null,
      durationMs: 120,
      lastNonNullRef,
      setUnmounted,
    });
    expect(cancelEarly).toBeDefined();
    jest.advanceTimersByTime(60);
    cancelEarly!();
    jest.advanceTimersByTime(200);
    expect(lastNonNullRef.current).toBe("retained");
    expect(unmounted).toBeFalse();

    const cancelCompleted: (() => void) | undefined = scheduleDelayedUnmountEffect({
      activeValue: null,
      durationMs: 120,
      lastNonNullRef,
      setUnmounted,
    });
    expect(cancelCompleted).toBeDefined();
    jest.advanceTimersByTime(120);
    expect(lastNonNullRef.current).toBeNull();
    expect(unmounted).toBeTrue();
  });
});
