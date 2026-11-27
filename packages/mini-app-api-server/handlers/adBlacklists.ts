import { STICKER_PACK_NAME_PATTERN } from "../../consts/aiChat/stickers";
import {
  MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE,
  MINI_APP_AD_BLACKLIST_KINDS,
  MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE,
  MINI_APP_AD_BLACKLIST_QUERY_MAX_LENGTH,
} from "../../consts/miniApp/features";
import { MINI_APP_POSITIVE_INTEGER_PATTERN } from "../../consts/miniApp/http";
import { logger } from "../../infra/logger";
import { hasExactKeys } from "../../libs/record";
import type {
  MiniAppAdBlacklistKind,
  MiniAppAdBlacklistMutationRequest,
  MiniAppAdBlacklistMutationResponse,
} from "../../types/miniApp/adBlacklists";
import { readJsonObjectBody } from "../libs/request";
import { jsonResponse } from "../libs/response";
import {
  listMiniAppAdBlacklists,
  mutateMiniAppAdBlacklist,
} from "../view/adBlacklists";
import type {
  AdBlacklistMutationOutcome,
  ListAdBlacklistsPageParams,
} from "../view/adBlacklists";
import { fetchMiniAppAdBlacklistPackPreview } from "../view/adBlacklistsPreview";
import type {
  AdBlacklistPreviewOutcome,
  FetchMiniAppAdBlacklistPreviewParams,
} from "../view/adBlacklistsPreview";

/** `parseStrictPositiveIntQueryParam` 解析可选正整数查询参数的入参。 */
interface ParseStrictPositiveIntQueryParamOptions {
  /** 已解封查询参数后的请求 URL。 */
  readonly url: URL;
  /** 查询参数键名。 */
  readonly name: string;
  /** 参数缺省时的默认值。 */
  readonly defaultValue: number;
  /** 可选闭区间上界。 */
  readonly maxValue?: number;
}

/**
 * 严格解析可选的正整数查询参数；键缺失时返回缺省值，出现重复键、空串、非正整数或超界值时返回 `null`。
 *
 * @param options 请求 URL、查询键名、默认值与可选上界。
 * @returns 解析成功的正整数，或校验失败时的 `null`。
 */
function parseStrictPositiveIntQueryParam({
  url,
  name,
  defaultValue,
  maxValue,
}: Readonly<ParseStrictPositiveIntQueryParamOptions>): number | null {
  const values: readonly string[] = url.searchParams.getAll(name);
  if (values.length === 0) return defaultValue;
  if (values.length > 1) return null;
  const trimmed: string = values[0]!.trim();
  if (!MINI_APP_POSITIVE_INTEGER_PATTERN.test(trimmed)) return null;
  const parsed: number = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return null;
  if (maxValue !== undefined && parsed > maxValue) return null;
  return parsed;
}

/**
 * 严格解析 `GET /api/ad-blacklists` 查询参数（`kind`、`page`、`pageSize`、`query`），拒绝未知键、重复键与越界值。
 *
 * @param url 已解封加密查询串后的请求 URL。
 * @returns 校验通过的查询参数；任一参数非法时返回 `null`。
 */
function parseAdBlacklistsQuery(
  url: URL
): Readonly<ListAdBlacklistsPageParams> | null {
  for (const key of url.searchParams.keys()) {
    if (
      key !== "kind" &&
      key !== "page" &&
      key !== "pageSize" &&
      key !== "query"
    ) {
      return null;
    }
  }

  const kindValues: readonly string[] = url.searchParams.getAll("kind");
  if (kindValues.length > 1) return null;
  let kind: MiniAppAdBlacklistKind = "sticker";
  if (kindValues.length === 1) {
    const trimmedKind: string = kindValues[0]!.trim();
    if (
      !MINI_APP_AD_BLACKLIST_KINDS.includes(
        trimmedKind as MiniAppAdBlacklistKind
      )
    ) {
      return null;
    }
    kind = trimmedKind as MiniAppAdBlacklistKind;
  }

  const page: number | null = parseStrictPositiveIntQueryParam({
    url,
    name: "page",
    defaultValue: 1,
  });
  if (page === null) return null;

  const pageSize: number | null = parseStrictPositiveIntQueryParam({
    url,
    name: "pageSize",
    defaultValue: MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE,
    maxValue: MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE,
  });
  if (pageSize === null) return null;

  const queryValues: readonly string[] = url.searchParams.getAll("query");
  if (queryValues.length > 1) return null;
  const query: string = queryValues.length === 1 ? queryValues[0]!.trim() : "";
  if (query.length > MINI_APP_AD_BLACKLIST_QUERY_MAX_LENGTH) return null;

  return { kind, page, pageSize, query };
}

/** `POST /api/ad-blacklists` 请求体解析结果。 */
type ParsedAdBlacklistMutationBody =
  | {
    readonly ok: true;
    readonly value: Readonly<MiniAppAdBlacklistMutationRequest>;
  }
  | {
    readonly ok: false;
    readonly response: Readonly<MiniAppAdBlacklistMutationResponse>;
  };

/**
 * 读取并严格校验 `POST /api/ad-blacklists` 的 JSON 请求体（精确键集 `{ kind, pack, enabled }`、字段类型及 `STICKER_PACK_NAME_PATTERN`）。
 *
 * @param request 已解封外层加密信封的 HTTP 请求。
 * @returns 校验通过的规范化请求对象，或附带错误码的 `400` 响应体。
 */
async function parseAdBlacklistMutationBody(
  request: Request
): Promise<Readonly<ParsedAdBlacklistMutationBody>> {
  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  const fallbackKind: MiniAppAdBlacklistKind =
    body !== null &&
    typeof body.kind === "string" &&
    MINI_APP_AD_BLACKLIST_KINDS.includes(body.kind as MiniAppAdBlacklistKind)
      ? (body.kind as MiniAppAdBlacklistKind)
      : "sticker";
  const fallbackPack: string =
    body !== null && typeof body.pack === "string" ? body.pack.trim() : "";
  const fallbackEnabled: boolean =
    body !== null && typeof body.enabled === "boolean" ? body.enabled : false;

  if (
    body === null ||
    !hasExactKeys(body, ["kind", "pack", "enabled"]) ||
    typeof body.kind !== "string" ||
    !MINI_APP_AD_BLACKLIST_KINDS.includes(body.kind as MiniAppAdBlacklistKind) ||
    typeof body.pack !== "string" ||
    typeof body.enabled !== "boolean"
  ) {
    return {
      ok: false,
      response: {
        ok: false,
        kind: fallbackKind,
        pack: fallbackPack,
        enabled: fallbackEnabled,
        changed: false,
        code: "INVALID_AD_BLACKLIST_PARAMS",
        message: "INVALID_AD_BLACKLIST_PARAMS",
      },
    };
  }

  const kind: MiniAppAdBlacklistKind = body.kind as MiniAppAdBlacklistKind;
  const pack: string = body.pack.trim();
  const enabled: boolean = body.enabled;
  if (!STICKER_PACK_NAME_PATTERN.test(pack)) {
    return {
      ok: false,
      response: {
        ok: false,
        kind,
        pack,
        enabled,
        changed: false,
        code: "INVALID_AD_BLACKLIST_PACK",
        message: "INVALID_AD_BLACKLIST_PACK",
      },
    };
  }

  return {
    ok: true,
    value: { kind, pack, enabled },
  };
}

/**
 * 处理 `GET /api/ad-blacklists`：按种类分页与子串搜索冷读查询广告贴纸包/自定义表情包黑名单。
 *
 * @param url 已解封加密查询串后的请求 URL。
 * @returns JSON 响应（非法参数返回 `400 INVALID_AD_BLACKLIST_PARAMS`，持久化读失败返回 `503 AD_BLACKLIST_STORAGE_UNAVAILABLE`）。
 */
export async function handleGetAdBlacklistsRoute(url: URL): Promise<Response> {
  const params: Readonly<ListAdBlacklistsPageParams> | null =
    parseAdBlacklistsQuery(url);
  if (params === null) {
    return jsonResponse({ error: "INVALID_AD_BLACKLIST_PARAMS" }, 400);
  }
  try {
    return jsonResponse(await listMiniAppAdBlacklists(params));
  } catch (error: unknown) {
    logger.error("[MiniApp] Failed to list ad pack blacklists:", params, error);
    return jsonResponse({ error: "AD_BLACKLIST_STORAGE_UNAVAILABLE" }, 503);
  }
}

/**
 * 处理 `POST /api/ad-blacklists`：新增或移除单条广告贴纸包/自定义表情包黑名单并记录审计日志。
 *
 * @param request 已解封外层加密信封的 HTTP 请求。
 * @returns JSON 响应（`200` 成功/幂等、`400` 参数或包名非法、`409` 自用包、`503` 持久化不可用）。
 */
export async function handlePostAdBlacklistsRoute(
  request: Request
): Promise<Response> {
  const parsed: Readonly<ParsedAdBlacklistMutationBody> =
    await parseAdBlacklistMutationBody(request);
  if (!parsed.ok) {
    return jsonResponse(parsed.response, 400);
  }

  const outcome: Readonly<AdBlacklistMutationOutcome> =
    await mutateMiniAppAdBlacklist(parsed.value);
  logger.operation("[MiniApp] adBlacklists.mutate", {
    kind: outcome.body.kind,
    pack: outcome.body.pack,
    enabled: outcome.body.enabled,
    ok: outcome.body.ok,
    changed: outcome.body.changed,
    persisted: outcome.body.persisted ?? false,
  });
  return jsonResponse(outcome.body, outcome.status);
}

/** `GET /api/ad-blacklists/preview` 查询参数解析结果。 */
type ParsedAdBlacklistPreviewQuery =
  | {
    readonly ok: true;
    readonly value: Readonly<Omit<FetchMiniAppAdBlacklistPreviewParams, "signal">>;
  }
  | {
    readonly ok: false;
    readonly error: "INVALID_AD_BLACKLIST_PARAMS" | "INVALID_AD_BLACKLIST_PACK";
  };

/**
 * 严格解析 `GET /api/ad-blacklists/preview` 的查询参数（必填 `kind`、`pack`，可选非负整数 `offset` 与 `metaOnly` `"0"|"1"`），
 * 拒绝未知键、重复键、非法偏移量、非法 `metaOnly` 与不满足 `STICKER_PACK_NAME_PATTERN` 的包名。
 *
 * @param url 已解封加密查询串后的请求 URL。
 * @returns 校验通过的预览查询参数，或具体 `400` 错误码。
 */
function parseAdBlacklistPreviewQuery(
  url: URL
): Readonly<ParsedAdBlacklistPreviewQuery> {
  for (const key of url.searchParams.keys()) {
    if (
      key !== "kind" &&
      key !== "pack" &&
      key !== "offset" &&
      key !== "metaOnly"
    ) {
      return { ok: false, error: "INVALID_AD_BLACKLIST_PARAMS" };
    }
  }

  const kindValues: readonly string[] = url.searchParams.getAll("kind");
  if (kindValues.length !== 1) {
    return { ok: false, error: "INVALID_AD_BLACKLIST_PARAMS" };
  }
  const trimmedKind: string = kindValues[0]!.trim();
  if (
    !MINI_APP_AD_BLACKLIST_KINDS.includes(trimmedKind as MiniAppAdBlacklistKind)
  ) {
    return { ok: false, error: "INVALID_AD_BLACKLIST_PARAMS" };
  }
  const kind: MiniAppAdBlacklistKind = trimmedKind as MiniAppAdBlacklistKind;

  const packValues: readonly string[] = url.searchParams.getAll("pack");
  if (packValues.length !== 1) {
    return { ok: false, error: "INVALID_AD_BLACKLIST_PARAMS" };
  }
  const pack: string = packValues[0]!.trim();
  if (!STICKER_PACK_NAME_PATTERN.test(pack)) {
    return { ok: false, error: "INVALID_AD_BLACKLIST_PACK" };
  }

  const offsetValues: readonly string[] = url.searchParams.getAll("offset");
  if (offsetValues.length > 1) {
    return { ok: false, error: "INVALID_AD_BLACKLIST_PARAMS" };
  }
  let offset: number = 0;
  if (offsetValues.length === 1) {
    const trimmedOffset: string = offsetValues[0]!.trim();
    if (
      trimmedOffset !== "0" &&
      !MINI_APP_POSITIVE_INTEGER_PATTERN.test(trimmedOffset)
    ) {
      return { ok: false, error: "INVALID_AD_BLACKLIST_PARAMS" };
    }
    const parsedOffset: number = Number(trimmedOffset);
    if (!Number.isSafeInteger(parsedOffset)) {
      return { ok: false, error: "INVALID_AD_BLACKLIST_PARAMS" };
    }
    offset = parsedOffset;
  }

  const metaOnlyValues: readonly string[] = url.searchParams.getAll("metaOnly");
  if (metaOnlyValues.length > 1) {
    return { ok: false, error: "INVALID_AD_BLACKLIST_PARAMS" };
  }
  let metaOnly: boolean = false;
  if (metaOnlyValues.length === 1) {
    const trimmedMetaOnly: string = metaOnlyValues[0]!.trim();
    if (trimmedMetaOnly !== "0" && trimmedMetaOnly !== "1") {
      return { ok: false, error: "INVALID_AD_BLACKLIST_PARAMS" };
    }
    metaOnly = trimmedMetaOnly === "1";
  }

  return { ok: true, value: { kind, pack, offset, metaOnly } };
}

/**
 * 处理 `GET /api/ad-blacklists/preview`：拉取目标贴纸包或自定义表情包元数据与本页缩略图，供 Mini App 页内弹窗预览。
 *
 * @param request 已通过鉴权的 HTTP 请求（透传 `request.signal` 以便取消在途 Telegram 下载）。
 * @param url 已解封加密查询串后的请求 URL。
 * @returns JSON 响应（`200` 预览分页、`400` 参数或包名非法、`404` 包在 Telegram 不存在、`503` Telegram 暂不可用）。
 */
export async function handleGetAdBlacklistPreviewRoute(
  request: Request,
  url: URL
): Promise<Response> {
  const parsed: Readonly<ParsedAdBlacklistPreviewQuery> =
    parseAdBlacklistPreviewQuery(url);
  if (!parsed.ok) {
    return jsonResponse({ error: parsed.error }, 400);
  }
  const outcome: Readonly<AdBlacklistPreviewOutcome> =
    await fetchMiniAppAdBlacklistPackPreview({
      ...parsed.value,
      signal: request.signal,
    });
  if (outcome.status !== 200) {
    return jsonResponse({ error: outcome.error }, outcome.status);
  }
  return jsonResponse(outcome.body, 200);
}
