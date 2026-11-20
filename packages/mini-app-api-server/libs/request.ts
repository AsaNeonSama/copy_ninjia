import {
  MINI_APP_MAX_JSON_BODY_BYTES, MINI_APP_PORT_MAX,
  MINI_APP_PORT_MIN, MINI_APP_POSITIVE_INTEGER_PATTERN, MINI_APP_SESSION_HEADER,
  MINI_APP_SIGNED_INTEGER_PATTERN,
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
 * 校验客户端地址尾部可选端口后缀是否为合法的十进制 TCP 端口（`1..65535`）。
 * @param portText 冒号之后的端口子串。
 * @returns 合法端口返回 `true`，否则返回 `false`。
 */
function isValidPortSuffix(portText: string): boolean {
  if (!MINI_APP_POSITIVE_INTEGER_PATTERN.test(portText)) return false;
  const port: number = Number(portText);
  return port >= MINI_APP_PORT_MIN && port <= MINI_APP_PORT_MAX;
}

/**
 * 校验并归一化单个候选客户端 IP：剥离合法方括号、可选端口与 `::ffff:` 前缀，拒绝畸形括号或非法端口，并过滤空串、未指定地址与回环地址。
 * @param raw 原始候选 IP 字符串。
 * @returns 归一化后的非回环客户端 IP；无效或属于回环/未指定地址时返回 `null`。
 */
function extractValidClientIp(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let ip: string = raw.trim().toLowerCase();
  if (ip.startsWith("[")) {
    const closeBracket: number = ip.indexOf("]");
    if (closeBracket < 1) return null;
    if (closeBracket < ip.length - 1) {
      if (ip[closeBracket + 1] !== ":" || !isValidPortSuffix(ip.slice(closeBracket + 2))) {
        return null;
      }
    }
    ip = ip.slice(1, closeBracket).trim();
  } else {
    const firstColon: number = ip.indexOf(":");
    if (firstColon >= 0 && !ip.includes(":", firstColon + 1)) {
      if (!ip.includes(".") || !isValidPortSuffix(ip.slice(firstColon + 1))) {
        return null;
      }
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
    ip === "0:0:0:0:0:0:0:0" ||
    ip === "localhost"
  ) {
    return null;
  }
  return ip;
}

/**
 * 按 `cf-connecting-ip` -> `true-client-ip` -> `x-forwarded-for` -> `x-real-ip` 的顺序提取客户端出口 IP；
 * 过滤回环与未指定地址，全部缺失或无效时回退为 `"127.0.0.1"`，不读取源站网卡 IP。
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
 * 从请求头中提取 64 位十六进制二次认证会话令牌。
 * @param request HTTP 请求对象。
 * @returns 提取出的 64 位十六进制会话令牌或空字符串。
 */
export function extractSessionToken(request: Request): string {
  const headerToken: string | null = request.headers.get(MINI_APP_SESSION_HEADER);
  if (headerToken !== null && headerToken.trim().length > 0) return headerToken.trim();
  return "";
}

/**
 * 流式有界读取并严格解析 JSON 请求体对象。
 * @param request HTTP 请求。
 * @param maxBytes 允许读取的最大 UTF-8 字节数（缺省为 `MINI_APP_MAX_JSON_BODY_BYTES`）。
 * @returns 解析成功时返回普通对象，超出体积上限或非对象 JSON 时返回 `null`。
 */
export async function readJsonObjectBody(
  request: Request,
  maxBytes: number = MINI_APP_MAX_JSON_BODY_BYTES
): Promise<Record<string, unknown> | null> {
  try {
    const text: string | null = await readBoundedResponseText(
      request,
      maxBytes
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

/**
 * 严格提取 URL 中唯一且不重复的指定查询参数值；若查询串包含 `&`、参数总数不为 1、目标键缺失或重复，返回 `null`。
 * @param url 已解析的请求 `URL`。
 * @param paramName 期望唯一存在的查询参数键名。
 * @returns 唯一匹配的参数值字符串（可能为空串，由调用方按业务约束核验）；违例时返回 `null`。
 */
export function parseStrictSingleQueryParam(
  url: URL,
  paramName: string
): string | null {
  if (
    url.search.includes("&") ||
    url.searchParams.size !== 1 ||
    url.searchParams.getAll(paramName).length !== 1
  ) {
    return null;
  }
  return url.searchParams.get(paramName);
}
