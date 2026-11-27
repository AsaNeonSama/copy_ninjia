import { stickerPacksForRecovery } from "../../config/stickers";
import { STICKER_PACK_NAME_PATTERN } from "../../consts/aiChat/stickers";
import {
  MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE,
  MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE,
} from "../../consts/miniApp/features";
import {
  getAdPackBlacklistCount,
  listAdPackBlacklistPage,
  persistAdPackBlacklistAdd,
  persistAdPackBlacklistRemove,
} from "../../infra/adPackBlacklistStorage";
import type { AdPackBlacklistPageSlice } from "../../infra/adPackBlacklistStorage";
import { logger } from "../../infra/logger";
import { clampPageSize, clampRequestedPage } from "../../libs/pagination";
import type { AdPackBlacklistPersistResult } from "../../types/adPackBlacklist";
import type {
  MiniAppAdBlacklistItem,
  MiniAppAdBlacklistKind,
  MiniAppAdBlacklistMutationCode,
  MiniAppAdBlacklistMutationRequest,
  MiniAppAdBlacklistMutationResponse,
  MiniAppAdBlacklistsResponse,
} from "../../types/miniApp/adBlacklists";

/** 分页与搜索查询广告包黑名单的入参。 */
export interface ListAdBlacklistsPageParams {
  /** 目标黑名单种类（`"sticker"` 或 `"emoji"`，缺省为 `"sticker"`）。 */
  readonly kind?: MiniAppAdBlacklistKind;
  /** 请求页码（正整数，缺省为 `1`）。 */
  readonly page?: number;
  /** 每页条数（`1..MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE`，缺省为 `MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE`）。 */
  readonly pageSize?: number;
  /** 经裁剪后的可选搜索关键字（按包名大小写不敏感子串过滤）。 */
  readonly query?: string;
}

/** 广告包黑名单单条变更视图结果（附带对应 HTTP 状态码）。 */
export interface AdBlacklistMutationOutcome {
  /** 建议返回给客户端的 HTTP 状态码（`200`、`400`、`409` 或 `503`）。 */
  readonly status: number;
  /** 标准化的广告包黑名单变更响应体。 */
  readonly body: Readonly<MiniAppAdBlacklistMutationResponse>;
}

/** `buildMutationOutcome` 构造标准化变更结果的入参。 */
interface BuildMutationOutcomeParams {
  /** HTTP 状态码。 */
  readonly status: number;
  /** 操作是否成功并完成落盘确认。 */
  readonly ok: boolean;
  /** 目标黑名单种类。 */
  readonly kind: MiniAppAdBlacklistKind;
  /** 经首尾裁剪后的目标包名。 */
  readonly pack: string;
  /** 本次请求的启用方向。 */
  readonly enabled: boolean;
  /** 是否修改了广告包黑名单状态。 */
  readonly changed: boolean;
  /** 稳定英文状态码。 */
  readonly code: MiniAppAdBlacklistMutationCode;
  /** 可选重复标记（仅重复新增时为 `true`）。 */
  readonly duplicate?: boolean;
  /** 可选持久化确认标记。 */
  readonly persisted?: boolean;
}

/**
 * 组装广告包黑名单变更结果及其 HTTP 状态码，`message` 固定与 `code` 保持一致以便前端映射多语言文案。
 *
 * @param params 状态码、结果字段与稳定英文状态码。
 * @returns 包含 HTTP 状态码与标准化响应体的只读结果。
 */
function buildMutationOutcome({
  status,
  ok,
  kind,
  pack,
  enabled,
  changed,
  code,
  duplicate,
  persisted,
}: Readonly<BuildMutationOutcomeParams>): Readonly<AdBlacklistMutationOutcome> {
  return {
    status,
    body: {
      ok,
      kind,
      pack,
      enabled,
      changed,
      ...(duplicate !== undefined ? { duplicate } : {}),
      ...(persisted !== undefined ? { persisted } : {}),
      code,
      message: code,
    },
  };
}

/**
 * 经 SQLite 游标冷读（不污染主线程 768 LRU 热缓存）分页查询广告贴纸包或自定义表情包黑名单，
 * 支持大小写不敏感子串搜索并同步返回两类总量。
 *
 * @param params 查询种类、页码、每页条数与可选搜索关键字。
 * @returns 夹紧页码后的广告包黑名单分页与统计视图。
 */
export async function listMiniAppAdBlacklists(
  params: Readonly<ListAdBlacklistsPageParams> = {}
): Promise<Readonly<MiniAppAdBlacklistsResponse>> {
  const kind: MiniAppAdBlacklistKind = params.kind ?? "sticker";
  const otherKind: MiniAppAdBlacklistKind =
    kind === "sticker" ? "emoji" : "sticker";
  const pageSize: number = clampPageSize(
    params.pageSize,
    MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE,
    MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE
  );
  const requestedPage: number = clampRequestedPage(params.page);
  const query: string = params.query?.trim() ?? "";

  const slice: Readonly<AdPackBlacklistPageSlice> = await listAdPackBlacklistPage({
    kind,
    page: requestedPage,
    pageSize,
    query,
    clampPage: true,
  });
  const activeKindTotal: number = Math.max(
    getAdPackBlacklistCount(kind),
    slice.kindTotal
  );
  const otherKindTotal: number = getAdPackBlacklistCount(otherKind);
  const items: readonly MiniAppAdBlacklistItem[] = slice.packs.map(
    (pack: string): MiniAppAdBlacklistItem => ({ pack })
  );

  return {
    kind,
    items,
    page: slice.page,
    pageSize: slice.pageSize,
    total: slice.total,
    totalPages: slice.totalPages,
    stickerTotal: kind === "sticker" ? activeKindTotal : otherKindTotal,
    emojiTotal: kind === "emoji" ? activeKindTotal : otherKindTotal,
    query,
  };
}

/**
 * 执行单条广告包黑名单的新增或移除，校验包名规则、机器人自用贴纸包防误伤与 SQLite 落盘确认。
 *
 * @param request 目标种类、原始包名与启用方向。
 * @returns 携带 HTTP 状态码与标准化结果载荷的变更结论。
 */
export async function mutateMiniAppAdBlacklist({
  kind,
  pack,
  enabled,
}: Readonly<MiniAppAdBlacklistMutationRequest>): Promise<
  Readonly<AdBlacklistMutationOutcome>
> {
  const trimmedPack: string = pack.trim();
  if (!STICKER_PACK_NAME_PATTERN.test(trimmedPack)) {
    return buildMutationOutcome({
      status: 400,
      ok: false,
      kind,
      pack: trimmedPack,
      enabled,
      changed: false,
      code: "INVALID_AD_BLACKLIST_PACK",
    });
  }

  if (enabled && kind === "sticker") {
    const ownStickerPacks: readonly string[] | null = stickerPacksForRecovery();
    if (ownStickerPacks?.includes(trimmedPack) === true) {
      return buildMutationOutcome({
        status: 409,
        ok: false,
        kind,
        pack: trimmedPack,
        enabled,
        changed: false,
        code: "AD_BLACKLIST_BOT_OWN_PACK",
      });
    }
  }

  let persistResult: AdPackBlacklistPersistResult;
  try {
    persistResult = enabled
      ? await persistAdPackBlacklistAdd(kind, trimmedPack)
      : await persistAdPackBlacklistRemove(kind, trimmedPack);
  } catch (error: unknown) {
    logger.error(
      "[MiniApp] Failed to persist ad pack blacklist mutation:",
      { kind, pack: trimmedPack, enabled },
      error
    );
    return buildMutationOutcome({
      status: 503,
      ok: false,
      kind,
      pack: trimmedPack,
      enabled,
      changed: false,
      persisted: false,
      code: "AD_BLACKLIST_STORAGE_UNAVAILABLE",
    });
  }

  if (!persistResult.persisted) {
    return buildMutationOutcome({
      status: 503,
      ok: false,
      kind,
      pack: trimmedPack,
      enabled,
      changed: persistResult.changed,
      persisted: false,
      code: "AD_BLACKLIST_STORAGE_UNAVAILABLE",
    });
  }

  if (enabled) {
    if (persistResult.changed) {
      return buildMutationOutcome({
        status: 200,
        ok: true,
        kind,
        pack: trimmedPack,
        enabled,
        changed: true,
        persisted: true,
        code: "AD_BLACKLIST_ADDED",
      });
    }
    return buildMutationOutcome({
      status: 200,
      ok: true,
      kind,
      pack: trimmedPack,
      enabled,
      changed: false,
      duplicate: true,
      persisted: true,
      code: "AD_BLACKLIST_DUPLICATE",
    });
  }

  if (persistResult.changed) {
    return buildMutationOutcome({
      status: 200,
      ok: true,
      kind,
      pack: trimmedPack,
      enabled,
      changed: true,
      persisted: true,
      code: "AD_BLACKLIST_REMOVED",
    });
  }
  return buildMutationOutcome({
    status: 200,
    ok: true,
    kind,
    pack: trimmedPack,
    enabled,
    changed: false,
    persisted: true,
    code: "AD_BLACKLIST_NOT_FOUND",
  });
}
