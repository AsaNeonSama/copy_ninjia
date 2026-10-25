import type React from "react";
import type { MiniAppLanguage } from "../../../types/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useMiniAppStore } from "../store";
import type { MiniAppUiStoreState } from "../store";

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
  /** 记录数量单位（可选）。 */
  readonly unitLabel?: string;
  /** 是否禁用交互（如异步加载中）。 */
  readonly disabled?: boolean;
  /** 页码切换回调。 */
  readonly onPageChange: (nextPage: number) => void;
  /** 每页条数切换回调。 */
  readonly onPageSizeChange?: (nextPageSize: number) => void;
}

/**
 * 统一分页控制栏组件：展示总条数、分段式每页条数切换，以及「首页/上页 · 当前页/总页数 · 下页/末页」导航栏。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function PaginationBar({
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
              {pageSizeOptions.map((option: number): React.JSX.Element => (
                <button
                  key={option}
                  type="button"
                  className={`page-size-pill ${pageSize === option ? "active" : ""}`}
                  disabled={disabled}
                  onClick={(): void => {
                    if (option !== pageSize) {
                      onPageSizeChange(option);
                    }
                  }}
                >
                  {t.pagination.pageSizeOption(option)}
                </button>
              ))}
            </div>
          )
          : null}
      </div>

      <div className="pagination-controls">
        <button
          type="button"
          className="page-btn"
          disabled={disabled || safePage <= 1}
          onClick={(): void => {
            onPageChange(1);
          }}
          aria-label={t.pagination.firstPageAria}
          title={t.pagination.firstPageAria}
        >
          <span className="page-btn-arrow">«</span>
          <span className="page-btn-text">{t.pagination.firstPageAria}</span>
        </button>
        <button
          type="button"
          className="page-btn"
          disabled={disabled || safePage <= 1}
          onClick={(): void => {
            onPageChange(Math.max(1, safePage - 1));
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
          className="page-btn"
          disabled={disabled || safePage >= safeTotalPages}
          onClick={(): void => {
            onPageChange(Math.min(safeTotalPages, safePage + 1));
          }}
          aria-label={t.pagination.nextPageAria}
          title={t.pagination.nextPageAria}
        >
          <span className="page-btn-text">{t.pagination.nextPageAria}</span>
          <span className="page-btn-arrow">›</span>
        </button>
        <button
          type="button"
          className="page-btn"
          disabled={disabled || safePage >= safeTotalPages}
          onClick={(): void => {
            onPageChange(safeTotalPages);
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
