import { memo, useEffect, useRef, useState } from "react";
import type React from "react";
import { MINI_APP_PAGINATION_HOVER_DURATION_MS } from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import type { MiniAppLanguage, TelegramWindow } from "../types/miniApp";
import type { BlurTargetElement } from "./GalleryPreviewCard";

/** `PaginationBar` 通用分页导航组件的属性参数。 */
export interface PaginationBarProps {
  /** 当前页码（从 1 开始）。 */
  readonly page: number;
  /** 总页数（至少为 1）。 */
  readonly totalPages: number;
  /** 总记录数。 */
  readonly total: number;
  /** 当前每页条数。 */
  readonly pageSize: number;
  /** 可选的每页条数切换档位列表（如 `[10, 15, 20]`）。 */
  readonly pageSizeOptions?: readonly number[];
  /** 是否禁用交互（如异步加载中）。 */
  readonly disabled?: boolean;
  /** 页码切换回调。 */
  readonly onPageChange: (nextPage: number) => void;
  /** 每页条数切换回调。 */
  readonly onPageSizeChange?: (nextPageSize: number) => void;
}

/**
 * 触发分页切换后将窗口平滑滚动回页面顶部。
 */
function scrollWindowToTop(): void {
  const tgWindow: TelegramWindow = globalThis;
  tgWindow.scrollTo?.({ top: 0, behavior: "smooth" });
}

/**
 * 统一分页控制栏组件：展示总条数、分段式每页条数切换，以及「首页/上页 · 当前页/总页数 · 下页/末页」导航栏；
 * 点击翻页按钮时固定保持 `MINI_APP_PAGINATION_HOVER_DURATION_MS` 的 hover 视觉反馈并在切换后平滑滚动回顶部。
 *
 * @param props 组件属性
 * @returns React 节点
 */
function PaginationBarView({
  page,
  totalPages,
  total,
  pageSize,
  pageSizeOptions,
  disabled = false,
  onPageChange,
  onPageSizeChange,
}: PaginationBarProps): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const safeTotalPages: number = Math.max(1, Math.trunc(totalPages));
  const safePage: number = Math.min(safeTotalPages, Math.max(1, Math.trunc(page)));

  const [hoveredKey, setHoveredKey]: [
    string | null,
    React.Dispatch<React.SetStateAction<string | null>>
  ] = useState<string | null>(null);
  const hoverTimerRef: React.RefObject<ReturnType<typeof setTimeout> | null> =
    useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect((): (() => void) => {
    return (): void => {
      if (hoverTimerRef.current !== null) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
    };
  }, []);

  const triggerTransientHover = (key: string): void => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
    }
    setHoveredKey(key);
    hoverTimerRef.current = setTimeout((): void => {
      hoverTimerRef.current = null;
      setHoveredKey(null);
    }, MINI_APP_PAGINATION_HOVER_DURATION_MS);
  };

  const handlePageSelect = (
    key: string,
    nextPage: number,
    event: React.MouseEvent<HTMLButtonElement>
  ): void => {
    (event.currentTarget as unknown as BlurTargetElement).blur?.();
    triggerTransientHover(key);
    onPageChange(nextPage);
    scrollWindowToTop();
  };

  return (
    <div className="pagination-bar">
      <div className="pagination-summary">
        <span className="pagination-summary-text">
          {t.pagination.summary(total, safePage, safeTotalPages)}
        </span>
        {pageSizeOptions !== undefined &&
        pageSizeOptions.length > 0 &&
        onPageSizeChange !== undefined
          ? (
            <div className="pagination-sizes" role="group">
              {pageSizeOptions.map((option: number): React.JSX.Element => {
                const sizeKey: string = `size:${option}`;
                return (
                  <button
                    key={option}
                    type="button"
                    className={`page-size-pill ${pageSize === option ? "active" : ""} ${hoveredKey === sizeKey ? "is-hovering" : ""}`}
                    disabled={disabled}
                    onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
                      (event.currentTarget as unknown as BlurTargetElement).blur?.();
                      if (option !== pageSize) {
                        triggerTransientHover(sizeKey);
                        onPageSizeChange(option);
                        scrollWindowToTop();
                      }
                    }}
                  >
                    {t.pagination.pageSizeOption(option)}
                  </button>
                );
              })}
            </div>
          )
          : null}
      </div>

      <div className="pagination-controls">
        <button
          type="button"
          className={`page-btn ${hoveredKey === "first" ? "is-hovering" : ""}`}
          disabled={disabled || safePage <= 1}
          onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
            handlePageSelect("first", 1, event);
          }}
          aria-label={t.pagination.firstPageAria}
          title={t.pagination.firstPageAria}
        >
          <span className="page-btn-arrow">«</span>
          <span className="page-btn-text">{t.pagination.firstPageAria}</span>
        </button>
        <button
          type="button"
          className={`page-btn ${hoveredKey === "prev" ? "is-hovering" : ""}`}
          disabled={disabled || safePage <= 1}
          onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
            handlePageSelect("prev", Math.max(1, safePage - 1), event);
          }}
          aria-label={t.pagination.prevPageAria}
          title={t.pagination.prevPageAria}
        >
          <span className="page-btn-arrow">‹</span>
          <span className="page-btn-text">{t.pagination.prevPageAria}</span>
        </button>

        <span className="pagination-indicator">
          <strong>{safePage}</strong>
          <span>/</span>
          <span>{safeTotalPages}</span>
        </span>

        <button
          type="button"
          className={`page-btn ${hoveredKey === "next" ? "is-hovering" : ""}`}
          disabled={disabled || safePage >= safeTotalPages}
          onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
            handlePageSelect("next", Math.min(safeTotalPages, safePage + 1), event);
          }}
          aria-label={t.pagination.nextPageAria}
          title={t.pagination.nextPageAria}
        >
          <span className="page-btn-text">{t.pagination.nextPageAria}</span>
          <span className="page-btn-arrow">›</span>
        </button>
        <button
          type="button"
          className={`page-btn ${hoveredKey === "last" ? "is-hovering" : ""}`}
          disabled={disabled || safePage >= safeTotalPages}
          onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
            handlePageSelect("last", safeTotalPages, event);
          }}
          aria-label={t.pagination.lastPageAria}
          title={t.pagination.lastPageAria}
        >
          <span className="page-btn-text">{t.pagination.lastPageAria}</span>
          <span className="page-btn-arrow">»</span>
        </button>
      </div>
    </div>
  );
}

/** 按属性浅比较跳过重渲染的分页导航栏：搜索输入、添加抽屉或权限抽屉展开时不重复渲染分页栏。 */
export const PaginationBar: React.MemoExoticComponent<
  typeof PaginationBarView
> = memo(PaginationBarView);
