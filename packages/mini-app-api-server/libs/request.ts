import {
  MINI_APP_INIT_DATA_HEADER, MINI_APP_MAX_JSON_BODY_BYTES, MINI_APP_SESSION_HEADER,
  MINI_APP_SIGNED_INTEGER_PATTERN, MINI_APP_TMA_AUTH_PREFIX,
} from "../../consts/miniApp";
import { readBoundedResponseText } from "../../libs/boundedResponse";
import { isPlainRecord } from "../../libs/record";

/**
 * 提取请求头 `X-Forwarded-Host` 的第一跳非空主机名（按逗号切分取首段并去掉首尾空白）。
 * @param headers HTTP 请求头对象。
 * @returns 首跳非空主机名；缺省或首跳为空时返回 `null`。
 */
export function firstForwardedHost(headers: Headers): string | null {
  const raw: string | null = headers.get("x-forwarded-host");
  if (raw === null) return null;
  const commaIndex: number = raw.indexOf(",");
  const firstHop: string = (commaIndex >= 0 ? raw.slice(0, commaIndex) : raw).trim();
  return firstHop.length > 0 ? firstHop : null;
}

/**
 * 校验并归一化单个候选客户端 IP 字符串（剥离方括号、可选端口与 `::ffff:` 前缀，过滤空串与回环地址）。
 * @param raw 原始候选 IP 字符串。
 * @returns 归一化后的非回环客户端 IP，或无效时返回 `null`。
 */
function extractValidClientIp(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let ip: string = raw.trim().toLowerCase();
  if (ip.startsWith("[")) {
    const closeBracket: number = ip.indexOf("]");
    if (
      closeBracket >= 1 &&
      (closeBracket === ip.length - 1 || ip[closeBracket + 1] === ":")
    ) {
      ip = ip.slice(1, closeBracket).trim();
    }
  } else {
    const firstColon: number = ip.indexOf(":");
    if (firstColon >= 0 && !ip.includes(":", firstColon + 1) && ip.includes(".")) {
      ip = ip.slice(0, firstColon).trim();
    }
  }
  if (ip.startsWith("::ffff:")) ip = ip.slice(7).trim();
  if (
    ip.length === 0 ||
    ip.startsWith("127.") ||
    ip === "::1" ||
    ip === "0:0:0:0:0:0:0:1" ||
    ip === "0.0.0.0" ||
    ip === "::" ||
    ip === "localhost"
  ) {
    return null;
  }
  return ip;
}

/**
 * 提取访问者客户端出口 IP（按 `cf-connecting-ip` -> `true-client-ip` -> `x-forwarded-for` -> `x-real-ip` 顺序读取并过滤回环地址，绝不读取源站网卡 IP）。
 * @param request HTTP 请求对象。
 * @returns 客户端出口 IP。
 */
export function resolveSafeClientIp(request: Request): string {
  const cfIp: string | null = extractValidClientIp(request.headers.get("cf-connecting-ip"));
  if (cfIp !== null) return cfIp;
  const trueClientIp: string | null = extractValidClientIp(request.headers.get("true-client-ip"));
  if (trueClientIp !== null) return trueClientIp;
  const xff: string | null = request.headers.get("x-forwarded-for");
  if (xff !== null) {
    for (const part of xff.split(",")) {
      const forwardedIp: string | null = extractValidClientIp(part);
      if (forwardedIp !== null) return forwardedIp;
    }
  }
  return extractValidClientIp(request.headers.get("x-real-ip")) ?? "127.0.0.1";
}

/**
 * 从请求中提取 Telegram WebApp `initData`（默认仅接受请求头；仅当传入 `queryUrl` 且方法为 `GET`/`HEAD` 时允许从 `initData` 查询参数提取以供 `<img>` 标签加载受保护图库与 SVG 资源）。
 * @param request HTTP 请求对象。
 * @param queryUrl 允许在 `GET`/`HEAD` 请求中回退读取查询参数时传入的已解析 `URL`；不允许时为 `null`。
 * @returns 提取出的 `initData` 原始查询串。
 */
export function extractInitDataFromHeaders(
  request: Request,
  queryUrl: URL | null = null
): string {
  const customHeader: string | null = request.headers.get(MINI_APP_INIT_DATA_HEADER);
  if (customHeader !== null && customHeader.trim().length > 0) return customHeader.trim();
  const authHeader: string | null = request.headers.get("authorization");
  if (authHeader?.toLowerCase().startsWith(MINI_APP_TMA_AUTH_PREFIX) === true) {
    return authHeader.slice(MINI_APP_TMA_AUTH_PREFIX.length).trim();
  }
  if (queryUrl !== null) {
    const method: string = request.method.toUpperCase();
    if (method === "GET" || method === "HEAD") {
      const queryInitData: string | null = queryUrl.searchParams.get("initData");
      if (queryInitData !== null && queryInitData.trim().length > 0) return queryInitData.trim();
    }
  }
  return "";
}

/**
 * 从 `GET`/`HEAD` 请求查询参数中提取受保护静态/图库资源的稳定访问令牌（`?token=`）。
 * @param request HTTP 请求对象。
 * @param url 已解析的请求 `URL`。
 * @returns 提取出的 64 位十六进制资源令牌或空字符串。
 */
export function extractAssetTokenFromQuery(request: Request, url: URL): string {
  const method: string = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return "";
  const queryToken: string | null = url.searchParams.get("token");
  return queryToken !== null ? queryToken.trim() : "";
}

/**
 * 从请求头（或 `GET`/`HEAD` 查询参数）中提取 64 位十六进制密码认证会话令牌。
 * @param request HTTP 请求对象。
 * @param queryUrl 允许在 `GET`/`HEAD` 请求中回退读取 `session` 查询参数时传入的已解析 `URL`；不允许时为 `null`。
 * @returns 提取出的 64 位十六进制会话令牌或空字符串。
 */
export function extractSessionToken(
  request: Request,
  queryUrl: URL | null = null
): string {
  const headerToken: string | null = request.headers.get(MINI_APP_SESSION_HEADER);
  if (headerToken !== null && headerToken.trim().length > 0) return headerToken.trim();
  if (queryUrl !== null) {
    const method: string = request.method.toUpperCase();
    if (method === "GET" || method === "HEAD") {
      const queryToken: string | null = queryUrl.searchParams.get("session");
      if (queryToken !== null && queryToken.trim().length > 0) return queryToken.trim();
    }
  }
  return "";
}

/**
 * 流式有界读取并严格解析 JSON 请求体对象。
 * @param request HTTP 请求。
 * @returns 解析成功时返回普通对象，超出体积上限或非对象 JSON 时返回 `null`。
 */
export async function readJsonObjectBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text: string | null = await readBoundedResponseText(
      request,
      MINI_APP_MAX_JSON_BODY_BYTES
    );
    if (text === null) return null;
    const parsed: unknown = JSON.parse(text);
    return isPlainRecord(parsed) ? parsed : null;
  } catch (_error: unknown) {
    return null;
  }
}

/**
 * 解析查询字符串中的可选整数参数。
 * @param raw 原始参数字符串。
 * @returns 安全整数或 `undefined`。
 */
export function parseOptionalSafeInt(raw: string | null): number | undefined {
  if (raw === null || raw.trim().length === 0) return undefined;
  const trimmed: string = raw.trim();
  if (!MINI_APP_SIGNED_INTEGER_PATTERN.test(trimmed)) return undefined;
  const parsed: number = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
