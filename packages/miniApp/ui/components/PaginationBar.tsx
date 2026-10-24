import type React from "react";

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
  /** 记录数量单位（默认 `"条"`）。 */
  readonly unitLabel?: string;
  /** 是否禁用交互（如异步加载中）。 */
  readonly disabled?: boolean;
  /** 页码切换回调。 */
  readonly onPageChange: (nextPage: number) => void;
  /** 每页条数切换回调。 */
  readonly onPageSizeChange?: (nextPageSize: number) => void;
}

/**
 * 统一分页控制栏组件：展示总条数、当前条目区间、每页条数切换，以及「首页/上一页 · 当前页/总页数 · 下一页/末页」导航栏。
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
  unitLabel = "条",
  disabled = false,
  onPageChange,
  onPageSizeChange,
}: PaginationBarProps): React.JSX.Element {
  const safeTotalPages: number = Math.max(1, Math.trunc(totalPages));
  const safePage: number = Math.min(safeTotalPages, Math.max(1, Math.trunc(page)));
  const startIndex: number = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endIndex: number = total === 0 ? 0 : Math.min(total, safePage * pageSize);

  return (
    <div className="pagination-bar">
      <div className="pagination-summary">
        <span>
          共 <strong>{total}</strong> {unitLabel}
          {total > 0 ? ` (第 ${startIndex}–${endIndex} ${unitLabel})` : ""}
        </span>
        {pageSizeOptions !== undefined &&
        pageSizeOptions.length > 0 &&
        onPageSizeChange !== undefined
          ? (
            <div className="pagination-sizes">
              {pageSizeOptions.map((option: number): React.JSX.Element => (
                <button
                  key={option}
                  type="button"
                  className={`page-btn ${pageSize === option ? "active" : ""}`}
                  disabled={disabled}
                  onClick={(): void => {
                    if (option !== pageSize) {
                      onPageSizeChange(option);
                    }
                  }}
                >
                  {option}/页
                </button>
              ))}
            </div>
          )
          : null}
      </div>

      <div className="pagination-controls">
        <div className="pagination-btn-group">
          <button
            type="button"
            className="page-btn"
            disabled={disabled || safePage <= 1}
            onClick={(): void => {
              onPageChange(1);
            }}
            title="首页"
          >
            « 首页
          </button>
          <button
            type="button"
            className="page-btn"
            disabled={disabled || safePage <= 1}
            onClick={(): void => {
              onPageChange(Math.max(1, safePage - 1));
            }}
          >
            ‹ 上一页
          </button>
        </div>

        <span className="pagination-indicator">
          第 <strong>{safePage}</strong> / <strong>{safeTotalPages}</strong> 页
        </span>

        <div className="pagination-btn-group">
          <button
            type="button"
            className="page-btn"
            disabled={disabled || safePage >= safeTotalPages}
            onClick={(): void => {
              onPageChange(Math.min(safeTotalPages, safePage + 1));
            }}
          >
            下一页 ›
          </button>
          <button
            type="button"
            className="page-btn"
            disabled={disabled || safePage >= safeTotalPages}
            onClick={(): void => {
              onPageChange(safeTotalPages);
            }}
            title="末页"
          >
            末页 »
          </button>
        </div>
      </div>
    </div>
  );
}
