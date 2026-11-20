import { parseWhitelistPermissionKey } from "../../commands/permission";
import {
  MINI_APP_PICKER_SUBJECT_KINDS,
  MINI_APP_PICKER_TARGET_LISTS,
  MINI_APP_TRANSLATE_LANGUAGES,
} from "../../consts/miniApp/features";
import { logger } from "../../infra/logger";
import { isTelegramGroupChatId } from "../../libs/telegramId";
import type { WhitelistPermissionKey } from "../../types/identityPolicy";
import type { MiniAppTranslateLanguage } from "../../types/miniApp/chats";
import type {
  MiniAppIdentityMutationResult,
  MiniAppPickerSubjectKind,
  MiniAppPickerTargetList,
  PrepareMiniAppPickerResult,
} from "../../types/miniApp/identities";
import { parseOptionalSafeInt, readJsonObjectBody } from "../libs/request";
import { jsonResponse } from "../libs/response";
import { prepareMiniAppPicker } from "../picker/prepare";
import { getMiniAppPickerResult } from "../picker/sessions";
import {
  listBlocklistEntries,
  setBlocklistEntryMembership,
} from "../view/identities/blocklist";
import type { ListIdentityPageParams } from "../view/identities/page";
import {
  enableAllWhitelistEntryPermissions,
  listWhitelistEntries,
  setWhitelistEntryMembership,
  setWhitelistEntryPermission,
} from "../view/identities/whitelist";

/** 白名单或黑名单成员增删请求体解析结果。 */
interface IdentityMembershipBody {
  /** 目标 Telegram 用户或频道 ID（非零安全整数）。 */
  readonly id: number;
  /** 是否启用（加入名单为 `true`，移出为 `false`）。 */
  readonly enabled: boolean;
}

/**
 * 解析白名单与黑名单列表接口共用的分页、游标与搜索查询参数。
 * @param url 已解封查询参数后的请求 URL。
 * @returns 标准化后的分页查询参数。
 */
function parseIdentityPageQuery(url: URL): Readonly<ListIdentityPageParams> {
  const page: number | undefined = parseOptionalSafeInt(url.searchParams.get("page"));
  const pageSize: number | undefined = parseOptionalSafeInt(
    url.searchParams.get("pageSize")
  );
  const afterId: number | undefined = parseOptionalSafeInt(url.searchParams.get("afterId"));
  const limit: number | undefined = parseOptionalSafeInt(url.searchParams.get("limit"));
  const query: string | undefined =
    url.searchParams.get("query")?.trim() ?? url.searchParams.get("q")?.trim();
  return {
    page,
    pageSize,
    afterId: afterId ?? null,
    limit,
    query,
  };
}

/**
 * 读取并校验白名单或黑名单成员变更的 JSON 请求体（要求非零安全整数 `id` 与布尔 `enabled`）。
 * @param request HTTP 请求。
 * @returns 校验通过的 `{ id, enabled }`；非对象或字段非法时返回 `null`。
 */
async function parseIdentityMembershipBody(
  request: Request
): Promise<Readonly<IdentityMembershipBody> | null> {
  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  if (
    body === null ||
    typeof body.id !== "number" ||
    !Number.isSafeInteger(body.id) ||
    body.id === 0 ||
    typeof body.enabled !== "boolean"
  ) {
    return null;
  }
  return {
    id: body.id,
    enabled: body.enabled,
  };
}

/**
 * 处理 `GET /api/identities/whitelist`：分页读取白名单成员及其十八项细粒度权限。
 * @param url 已解析的请求 URL（读取分页、游标与搜索查询参数）。
 * @returns JSON 响应。
 */
export async function handleGetWhitelistRoute(url: URL): Promise<Response> {
  return jsonResponse(await listWhitelistEntries(parseIdentityPageQuery(url)));
}

/**
 * 处理 `POST /api/identities/whitelist`：按 ID 添加或移出白名单。
 * @param request HTTP 请求。
 * @returns JSON 响应。
 */
export async function handlePostWhitelistRoute(request: Request): Promise<Response> {
  const params: Readonly<IdentityMembershipBody> | null =
    await parseIdentityMembershipBody(request);
  if (params === null) {
    return jsonResponse(
      { error: "INVALID_IDENTITY_PARAMS" },
      400
    );
  }
  const result: Readonly<MiniAppIdentityMutationResult> =
    await setWhitelistEntryMembership(params);
  logger.operation("[MiniApp] identities.whitelist", {
    id: params.id,
    enabled: params.enabled,
    ok: result.ok,
    changed: result.changed,
  });
  return jsonResponse(result, result.ok ? 200 : 400);
}

/**
 * 处理 `GET /api/identities/blocklist`：分页读取黑名单。
 * @param url 已解析的请求 URL（读取分页、游标与搜索查询参数）。
 * @returns JSON 响应。
 */
export async function handleGetBlocklistRoute(url: URL): Promise<Response> {
  return jsonResponse(await listBlocklistEntries(parseIdentityPageQuery(url)));
}

/**
 * 处理 `POST /api/identities/blocklist`：按 ID 拉黑或解除拉黑。
 * @param request HTTP 请求。
 * @returns JSON 响应。
 */
export async function handlePostBlocklistRoute(request: Request): Promise<Response> {
  const params: Readonly<IdentityMembershipBody> | null =
    await parseIdentityMembershipBody(request);
  if (params === null) {
    return jsonResponse(
      { error: "INVALID_IDENTITY_PARAMS" },
      400
    );
  }
  const result: Readonly<MiniAppIdentityMutationResult> =
    await setBlocklistEntryMembership(params);
  logger.operation("[MiniApp] identities.blocklist", {
    id: params.id,
    enabled: params.enabled,
    ok: result.ok,
    changed: result.changed,
  });
  return jsonResponse(result, result.ok ? 200 : 400);
}

/**
 * 处理 `POST /api/identities/permission`：修改白名单单项权限或一键全开。
 * @param request HTTP 请求。
 * @returns JSON 响应。
 */
export async function handlePostPermissionRoute(request: Request): Promise<Response> {
  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  if (
    body === null ||
    typeof body.id !== "number" ||
    !Number.isSafeInteger(body.id) ||
    body.id === 0
  ) {
    return jsonResponse({ error: "INVALID_IDENTITY_ID" }, 400);
  }
  if (body.enableAll === true) {
    const result: Readonly<MiniAppIdentityMutationResult> =
      await enableAllWhitelistEntryPermissions(body.id);
    logger.operation("[MiniApp] identities.permission", {
      id: body.id,
      enableAll: true,
      ok: result.ok,
      changed: result.changed,
    });
    return jsonResponse(result, result.ok ? 200 : 400);
  }
  const key: WhitelistPermissionKey | undefined =
    typeof body.key === "string" ? parseWhitelistPermissionKey(body.key) : undefined;
  if (key === undefined || typeof body.value !== "boolean") {
    return jsonResponse(
      { error: "INVALID_PERMISSION_PARAMS" },
      400
    );
  }
  const result: Readonly<MiniAppIdentityMutationResult> =
    await setWhitelistEntryPermission({
      id: body.id,
      key,
      value: body.value,
    });
  logger.operation("[MiniApp] identities.permission", {
    id: body.id,
    key,
    value: body.value,
    ok: result.ok,
    changed: result.changed,
  });
  return jsonResponse(result, result.ok ? 200 : 400);
}

/**
 * 处理 `POST /api/picker/prepare`：生成 Telegram 原生好友/联系人或频道选择器预备按钮。
 * @param request HTTP 请求。
 * @returns JSON 响应。
 */
export async function handlePostPickerPrepareRoute(request: Request): Promise<Response> {
  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  if (
    body === null ||
    typeof body.targetList !== "string" ||
    !MINI_APP_PICKER_TARGET_LISTS.includes(body.targetList as MiniAppPickerTargetList) ||
    typeof body.subjectKind !== "string" ||
    !MINI_APP_PICKER_SUBJECT_KINDS.includes(body.subjectKind as MiniAppPickerSubjectKind)
  ) {
    return jsonResponse(
      { error: "INVALID_PICKER_PARAMS" },
      400
    );
  }
  const targetList: MiniAppPickerTargetList = body.targetList as MiniAppPickerTargetList;
  const isChatTarget: boolean =
    targetList === "deleteMessage" || targetList === "translate";
  const chatId: number | undefined =
    isChatTarget && isTelegramGroupChatId(body.chatId) ? body.chatId : undefined;
  if (isChatTarget && chatId === undefined) {
    return jsonResponse(
      { error: "INVALID_PICKER_PARAMS" },
      400
    );
  }
  const language: MiniAppTranslateLanguage | undefined =
    targetList === "translate" && typeof body.language === "string"
      ? (body.language as MiniAppTranslateLanguage)
      : undefined;
  if (
    targetList === "translate" &&
    body.language !== undefined &&
    (language === undefined || !MINI_APP_TRANSLATE_LANGUAGES.includes(language))
  ) {
    return jsonResponse(
      { error: "INVALID_PICKER_PARAMS" },
      400
    );
  }
  const subjectKind: MiniAppPickerSubjectKind =
    body.subjectKind as MiniAppPickerSubjectKind;
  const prepResult: Readonly<PrepareMiniAppPickerResult> =
    await prepareMiniAppPicker({
      targetList,
      subjectKind,
      ...(chatId !== undefined ? { chatId } : {}),
      ...(language !== undefined ? { language } : {}),
    });
  logger.operation("[MiniApp] picker.prepare", {
    targetList,
    subjectKind,
    chatId: chatId ?? null,
    ok: prepResult.ok,
  });
  return jsonResponse(prepResult, prepResult.ok ? 200 : 502);
}

/**
 * 处理 `GET /api/picker/result`：轮询原生选择器导入结果回执。
 * @param url 已解析的请求 URL（读取 `requestId` 查询参数）。
 * @returns JSON 响应。
 */
export function handleGetPickerResultRoute(url: URL): Response {
  const requestId: number | undefined = parseOptionalSafeInt(url.searchParams.get("requestId"));
  if (requestId === undefined || requestId <= 0) {
    return jsonResponse({ error: "INVALID_PICKER_REQUEST_ID" }, 400);
  }
  return jsonResponse({ result: getMiniAppPickerResult(requestId) });
}
