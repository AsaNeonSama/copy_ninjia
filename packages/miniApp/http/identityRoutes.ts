import { parseWhitelistPermissionKey } from "../../commands/permission";
import {
  MINI_APP_PICKER_SUBJECT_KINDS,
  MINI_APP_PICKER_TARGET_LISTS,
} from "../../consts/miniApp";
import type { WhitelistPermissionKey } from "../../types/identityPolicy";
import type {
  MiniAppIdentityMutationResult,
  MiniAppPickerSubjectKind,
  MiniAppPickerTargetList,
} from "../../types/miniApp";
import {
  enableAllWhitelistEntryPermissions,
  listBlocklistEntries,
  listWhitelistEntries,
  setBlocklistEntryMembership,
  setWhitelistEntryMembership,
  setWhitelistEntryPermission,
} from "../identitiesView";
import {
  getMiniAppPickerResult,
  prepareMiniAppPicker,
} from "../picker";
import type { PrepareMiniAppPickerResult } from "../picker";
import {
  authenticateMiniAppRequest,
  jsonResponse,
  parseOptionalSafeInt,
  readJsonObjectBody,
} from "./common";

/**
 * 处理 `GET /api/identities/whitelist`：分页读取白名单及权限说明。
 * @param request HTTP 请求。
 * @param parsedUrl 已解析的 URL（缺省由 `request.url` 解析）。
 * @returns JSON 响应。
 */
export async function handleGetWhitelistRoute(
  request: Request,
  parsedUrl?: URL
): Promise<Response> {
  const rejected: Response | null = authenticateMiniAppRequest(request);
  if (rejected !== null) return rejected;
  const url: URL = parsedUrl ?? new URL(request.url);
  const page: number | undefined = parseOptionalSafeInt(url.searchParams.get("page"));
  const pageSize: number | undefined = parseOptionalSafeInt(
    url.searchParams.get("pageSize")
  );
  const afterId: number | undefined = parseOptionalSafeInt(url.searchParams.get("afterId"));
  const limit: number | undefined = parseOptionalSafeInt(url.searchParams.get("limit"));
  return jsonResponse(
    await listWhitelistEntries({
      page,
      pageSize,
      afterId: afterId ?? null,
      limit,
    })
  );
}

/**
 * 处理 `POST /api/identities/whitelist`：按 ID 添加或移出白名单。
 * @param request HTTP 请求。
 * @returns JSON 响应。
 */
export async function handlePostWhitelistRoute(request: Request): Promise<Response> {
  const rejected: Response | null = authenticateMiniAppRequest(request);
  if (rejected !== null) return rejected;
  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  if (
    body === null ||
    typeof body.id !== "number" ||
    !Number.isSafeInteger(body.id) ||
    body.id === 0 ||
    typeof body.enabled !== "boolean"
  ) {
    return jsonResponse(
      { error: "请求参数非法：需要非零安全整数 id 与布尔值 enabled。" },
      400
    );
  }
  const result: Readonly<MiniAppIdentityMutationResult> =
    await setWhitelistEntryMembership({
      id: body.id,
      enabled: body.enabled,
    });
  return jsonResponse(result, result.ok ? 200 : 400);
}

/**
 * 处理 `GET /api/identities/blocklist`：分页读取黑名单。
 * @param request HTTP 请求。
 * @param parsedUrl 已解析的 URL（缺省由 `request.url` 解析）。
 * @returns JSON 响应。
 */
export async function handleGetBlocklistRoute(
  request: Request,
  parsedUrl?: URL
): Promise<Response> {
  const rejected: Response | null = authenticateMiniAppRequest(request);
  if (rejected !== null) return rejected;
  const url: URL = parsedUrl ?? new URL(request.url);
  const page: number | undefined = parseOptionalSafeInt(url.searchParams.get("page"));
  const pageSize: number | undefined = parseOptionalSafeInt(
    url.searchParams.get("pageSize")
  );
  const afterId: number | undefined = parseOptionalSafeInt(url.searchParams.get("afterId"));
  const limit: number | undefined = parseOptionalSafeInt(url.searchParams.get("limit"));
  return jsonResponse(
    await listBlocklistEntries({
      page,
      pageSize,
      afterId: afterId ?? null,
      limit,
    })
  );
}

/**
 * 处理 `POST /api/identities/blocklist`：按 ID 拉黑或解除拉黑。
 * @param request HTTP 请求。
 * @returns JSON 响应。
 */
export async function handlePostBlocklistRoute(request: Request): Promise<Response> {
  const rejected: Response | null = authenticateMiniAppRequest(request);
  if (rejected !== null) return rejected;
  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  if (
    body === null ||
    typeof body.id !== "number" ||
    !Number.isSafeInteger(body.id) ||
    body.id === 0 ||
    typeof body.enabled !== "boolean"
  ) {
    return jsonResponse(
      { error: "请求参数非法：需要非零安全整数 id 与布尔值 enabled。" },
      400
    );
  }
  const result: Readonly<MiniAppIdentityMutationResult> =
    await setBlocklistEntryMembership({
      id: body.id,
      enabled: body.enabled,
    });
  return jsonResponse(result, result.ok ? 200 : 400);
}

/**
 * 处理 `POST /api/identities/permission`：修改白名单单项权限或一键全开。
 * @param request HTTP 请求。
 * @returns JSON 响应。
 */
export async function handlePostPermissionRoute(request: Request): Promise<Response> {
  const rejected: Response | null = authenticateMiniAppRequest(request);
  if (rejected !== null) return rejected;
  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  if (
    body === null ||
    typeof body.id !== "number" ||
    !Number.isSafeInteger(body.id) ||
    body.id === 0
  ) {
    return jsonResponse({ error: "请求参数非法：需要非零安全整数 id。" }, 400);
  }
  if (body.enableAll === true) {
    const result: Readonly<MiniAppIdentityMutationResult> =
      await enableAllWhitelistEntryPermissions(body.id);
    return jsonResponse(result, result.ok ? 200 : 400);
  }
  const key: WhitelistPermissionKey | undefined =
    typeof body.key === "string" ? parseWhitelistPermissionKey(body.key) : undefined;
  if (key === undefined || typeof body.value !== "boolean") {
    return jsonResponse(
      { error: "请求参数非法：需要合法的权限键 key 与布尔值 value。" },
      400
    );
  }
  const result: Readonly<MiniAppIdentityMutationResult> =
    await setWhitelistEntryPermission({
      id: body.id,
      key,
      value: body.value,
    });
  return jsonResponse(result, result.ok ? 200 : 400);
}

/**
 * 处理 `POST /api/picker/prepare`：生成 Telegram 原生好友/联系人或频道选择器预备按钮。
 * @param request HTTP 请求。
 * @returns JSON 响应。
 */
export async function handlePostPickerPrepareRoute(request: Request): Promise<Response> {
  const rejected: Response | null = authenticateMiniAppRequest(request);
  if (rejected !== null) return rejected;
  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  if (
    body === null ||
    typeof body.targetList !== "string" ||
    !MINI_APP_PICKER_TARGET_LISTS.includes(body.targetList as MiniAppPickerTargetList) ||
    typeof body.subjectKind !== "string" ||
    !MINI_APP_PICKER_SUBJECT_KINDS.includes(body.subjectKind as MiniAppPickerSubjectKind)
  ) {
    return jsonResponse(
      { error: "请求参数非法：需要合法的 targetList 与 subjectKind。" },
      400
    );
  }
  const prepResult: Readonly<PrepareMiniAppPickerResult> =
    await prepareMiniAppPicker({
      targetList: body.targetList as MiniAppPickerTargetList,
      subjectKind: body.subjectKind as MiniAppPickerSubjectKind,
    });
  return jsonResponse(prepResult, prepResult.ok ? 200 : 502);
}

/**
 * 处理 `GET /api/picker/result`：轮询原生选择器导入结果回执。
 * @param request HTTP 请求。
 * @param parsedUrl 已解析的 URL（缺省由 `request.url` 解析）。
 * @returns JSON 响应。
 */
export function handleGetPickerResultRoute(
  request: Request,
  parsedUrl?: URL
): Response {
  const rejected: Response | null = authenticateMiniAppRequest(request);
  if (rejected !== null) return rejected;
  const url: URL = parsedUrl ?? new URL(request.url);
  const requestId: number | undefined = parseOptionalSafeInt(url.searchParams.get("requestId"));
  if (requestId === undefined || requestId <= 0) {
    return jsonResponse({ error: "请求参数非法：需要正整数 requestId。" }, 400);
  }
  return jsonResponse({ result: getMiniAppPickerResult(requestId) });
}

/**
 * 在通用请求分发中匹配并处理 `/api/identities/*` 与 `/api/picker/*` 路由。
 * @param method 大写 HTTP 方法。
 * @param routePath 归一化后的内部路由路径。
 * @param request 原始请求对象。
 * @returns 匹配时返回 `Response`，未匹配时返回 `null`。
 */
export async function handleIdentitiesAndPickerApiRoute(
  method: string,
  routePath: string,
  request: Request
): Promise<Response | null> {
  if (routePath === "/api/identities/whitelist") {
    if (method === "GET") return handleGetWhitelistRoute(request);
    if (method === "POST") return handlePostWhitelistRoute(request);
  }
  if (routePath === "/api/identities/blocklist") {
    if (method === "GET") return handleGetBlocklistRoute(request);
    if (method === "POST") return handlePostBlocklistRoute(request);
  }
  if (routePath === "/api/identities/permission" && method === "POST") {
    return handlePostPermissionRoute(request);
  }
  if (routePath === "/api/picker/prepare" && method === "POST") {
    return handlePostPickerPrepareRoute(request);
  }
  if (routePath === "/api/picker/result" && method === "GET") {
    return handleGetPickerResultRoute(request);
  }
  return null;
}
