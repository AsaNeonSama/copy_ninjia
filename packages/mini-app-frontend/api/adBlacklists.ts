import {
  MINI_APP_AD_BLACKLIST_MUTATION_CODES,
  MINI_APP_AD_BLACKLIST_QUERY_MAX_LENGTH,
} from "../consts/miniApp/ui";
import { errorMessage } from "../libs/errorMessage";
import { asPayloadRecord } from "../libs/record";
import type {
  MiniAppAdBlacklistKind,
  MiniAppAdBlacklistMutationCode,
  MiniAppAdBlacklistMutationRequest,
  MiniAppAdBlacklistMutationResponse,
  MiniAppAdBlacklistPreviewResponse,
  MiniAppAdBlacklistsResponse,
} from "../types/miniApp/adBlacklists";
import { classifyMiniAppAuthError } from "./authError";
import { miniAppFetchJson } from "./request";

/**
 * 判定未知值是否为受支持的广告包黑名单变更状态码。
 *
 * @param value 未知候选值
 * @returns 命中 `MINI_APP_AD_BLACKLIST_MUTATION_CODES` 时返回 `true`
 */
function isMiniAppAdBlacklistMutationCode(
  value: unknown
): value is MiniAppAdBlacklistMutationCode {
  return (
    typeof value === "string" &&
    (MINI_APP_AD_BLACKLIST_MUTATION_CODES as readonly string[]).includes(value)
  );
}

/**
 * 从非 2xx JSON 响应抛出的 `Error` 中还原结构化的 `MiniAppAdBlacklistMutationResponse`；
 * 非业务错误或缺少受支持状态码时返回 `null`。
 *
 * @param error `miniAppFetchJson` 抛出的异常
 * @param request 原始变更请求体（用于补齐响应中可能缺省的回显字段）
 * @returns 结构化的业务失败响应；不匹配时返回 `null`
 */
function extractAdBlacklistMutationError(
  error: unknown,
  request: Readonly<MiniAppAdBlacklistMutationRequest>
): MiniAppAdBlacklistMutationResponse | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const record: Record<string, unknown> = asPayloadRecord(error.cause);
  if (record.ok !== false || !isMiniAppAdBlacklistMutationCode(record.code)) {
    return null;
  }
  const kind: MiniAppAdBlacklistKind =
    record.kind === "sticker" || record.kind === "emoji"
      ? record.kind
      : request.kind;
  const pack: string =
    typeof record.pack === "string" ? record.pack : request.pack;
  const enabled: boolean =
    typeof record.enabled === "boolean" ? record.enabled : request.enabled;
  const changed: boolean =
    typeof record.changed === "boolean" ? record.changed : false;
  const message: string =
    typeof record.message === "string" && record.message.trim().length > 0
      ? record.message
      : typeof record.error === "string" && record.error.trim().length > 0
        ? record.error
        : record.code;
  return {
    ok: false,
    kind,
    pack,
    enabled,
    changed,
    ...(typeof record.duplicate === "boolean"
      ? { duplicate: record.duplicate }
      : {}),
    ...(typeof record.persisted === "boolean"
      ? { persisted: record.persisted }
      : {}),
    code: record.code,
    message,
  };
}

/** `fetchMiniAppAdBlacklists` 拉取广告包黑名单分页列表的请求参数。 */
export interface FetchMiniAppAdBlacklistsParams {
  /** 黑名单种类（`"sticker"` 或 `"emoji"`）。 */
  readonly kind: MiniAppAdBlacklistKind;
  /** 页码（从 1 开始）。 */
  readonly page: number;
  /** 每页条数。 */
  readonly pageSize: number;
  /** 可选搜索关键字。 */
  readonly query?: string;
}

/**
 * 调用 `GET ./api/ad-blacklists` 按种类、页码、每页条数与可选搜索关键字拉取广告包黑名单分页列表。
 *
 * @param params 查询参数（种类、页码、每页条数与可选搜索关键字）
 * @returns 广告包黑名单分页响应
 */
export async function fetchMiniAppAdBlacklists({
  kind,
  page,
  pageSize,
  query = "",
}: Readonly<FetchMiniAppAdBlacklistsParams>): Promise<MiniAppAdBlacklistsResponse> {
  const normalizedQuery: string = query
    .trim()
    .slice(0, MINI_APP_AD_BLACKLIST_QUERY_MAX_LENGTH);
  const suffix: string =
    normalizedQuery.length > 0
      ? `&query=${encodeURIComponent(normalizedQuery)}`
      : "";
  return miniAppFetchJson<MiniAppAdBlacklistsResponse>(
    `./api/ad-blacklists?kind=${encodeURIComponent(kind)}&page=${page}&pageSize=${pageSize}${suffix}`
  );
}

/**
 * 调用 `POST ./api/ad-blacklists` 新增或移除指定广告贴纸包 / 自定义表情包黑名单条目；
 * 鉴权与会话失效错误继续向上抛出交由门禁重定向处理，非 2xx 结构化业务错误响应体直接归一化返回。
 *
 * @param request 包含种类、包名与目标启用状态的请求体
 * @returns 广告包黑名单变更结果
 */
export async function mutateMiniAppAdBlacklist(
  request: Readonly<MiniAppAdBlacklistMutationRequest>
): Promise<MiniAppAdBlacklistMutationResponse> {
  try {
    return await miniAppFetchJson<MiniAppAdBlacklistMutationResponse>(
      "./api/ad-blacklists",
      {
        method: "POST",
        body: JSON.stringify(request),
      }
    );
  } catch (error: unknown) {
    if (classifyMiniAppAuthError(errorMessage(error), error) !== null) {
      throw error;
    }
    const structuredError: MiniAppAdBlacklistMutationResponse | null =
      extractAdBlacklistMutationError(error, request);
    if (structuredError !== null) {
      return structuredError;
    }
    throw error;
  }
}

/** `fetchMiniAppAdBlacklistPreview` 拉取贴纸/自定义表情包页内预览的请求参数。 */
export interface FetchMiniAppAdBlacklistPreviewParams {
  /** 内容黑名单种类（`"sticker"` 或 `"emoji"`）。 */
  readonly kind: MiniAppAdBlacklistKind;
  /** 目标贴纸包或自定义表情包 short name。 */
  readonly pack: string;
  /** 起始偏移下标（从 0 起，缺省为 0）。 */
  readonly offset?: number;
  /** 为 `true` 时仅拉取包标题、总枚数与条目元数据（不下载缩略图）。 */
  readonly metaOnly?: boolean;
  /** 可选请求取消信号，用于在关闭弹窗或切换目标包时中止在途请求。 */
  readonly signal?: AbortSignal;
}

/**
 * 调用 `GET ./api/ad-blacklists/preview` 拉取指定贴纸包或自定义表情包的页内预览分页与缩略图数据。
 *
 * @param params 种类、包名、可选偏移下标、是否仅元数据与取消信号
 * @returns 包预览元数据与本页缩略图响应
 */
export async function fetchMiniAppAdBlacklistPreview({
  kind,
  pack,
  offset = 0,
  metaOnly = false,
  signal,
}: Readonly<FetchMiniAppAdBlacklistPreviewParams>): Promise<MiniAppAdBlacklistPreviewResponse> {
  const offsetParam: string = offset > 0 ? `&offset=${offset}` : "";
  const metaOnlyParam: string = metaOnly ? "&metaOnly=1" : "";
  return miniAppFetchJson<MiniAppAdBlacklistPreviewResponse>(
    `./api/ad-blacklists/preview?kind=${encodeURIComponent(kind)}&pack=${encodeURIComponent(pack)}${offsetParam}${metaOnlyParam}`,
    signal !== undefined ? { signal } : undefined
  );
}
