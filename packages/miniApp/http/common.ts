import {
  miniAppActiveConfigHolder,
  miniAppAuthSessions,
  miniAppPasswordGuardHolder,
} from "../../cache/main/miniApp";
import { BOT_TOKEN, SUPER_ADMIN_USER_ID, getBotMiniAppConfig } from "../../config/bot";
import {
  MINI_APP_FALLBACK_TEST_PASSWORD,
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_IPV4_HOST_PATTERN,
  MINI_APP_MAX_JSON_BODY_BYTES,
  MINI_APP_NO_STORE_CACHE_CONTROL,
  MINI_APP_PASSWORD_LOCKOUT_MS,
  MINI_APP_PASSWORD_MAX_ATTEMPTS,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_TTL_MS,
  MINI_APP_SHA256_HEX_PATTERN,
  MINI_APP_SIGNED_INTEGER_PATTERN,
  MINI_APP_TMA_AUTH_PREFIX,
} from "../../consts/miniApp";
import { verifyMiniAppInitData, verifyMiniAppPassword } from "../../libs/miniAppAuth";
import { isPlainRecord } from "../../libs/record";
import type { BotMiniAppConfig } from "../../types/config";
import type {
  MiniAppAccessDiagnostics,
  MiniAppAuthResult,
  MiniAppAuthSession,
  MiniAppLoginSuccessResponse,
  MiniAppPasswordGuardState,
} from "../../types/miniApp";

/** 模块级复用的无状态 UTF-8 编码器，用于计算请求体字节数。 */
const BODY_TEXT_ENCODER: TextEncoder = new TextEncoder();

/**
 * 校验并归一化单个候选客户端 IP 字符串（过滤空串与回环地址）。
 * @param raw 原始候选 IP 字符串。
 * @returns 合法的非回环客户端 IP，或无效时返回 `null`。
 */
function extractValidClientIp(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let ip: string = raw.trim().toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (
    ip.length === 0 ||
    ip.startsWith("127.") ||
    ip === "::1" ||
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
function resolveSafeClientIp(request: Request): string {
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
 * 生成统一的防缓存响应头（防止 Cloudflare Tunnel 边缘节点或浏览器缓存动态状态）。
 * @param contentType 可选的 `Content-Type` 响应头值。
 * @param requestId 可选的请求追踪 ID（写入 `X-Request-Id` 响应头）。
 * @returns 响应头键值对。
 */
export function buildNoStoreHeaders(
  contentType?: string,
  requestId?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": MINI_APP_NO_STORE_CACHE_CONTROL,
    "CDN-Cache-Control": "no-store",
    "Cloudflare-CDN-Cache-Control": "no-store",
    "Pragma": "no-cache",
    "Expires": "0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  };
  if (contentType !== undefined) headers["Content-Type"] = contentType;
  if (requestId !== undefined) headers["X-Request-Id"] = requestId;
  return headers;
}

/**
 * 使用 Bun 原生 `Response.json` 构造带防缓存头的 JSON 响应。
 * @param payload 待序列化的 JSON 载荷。
 * @param status HTTP 状态码（默认 200）。
 * @param requestId 可选的请求追踪 ID。
 * @returns `Response` 实例。
 */
export function jsonResponse(
  payload: unknown,
  status: number = 200,
  requestId?: string
): Response {
  return Response.json(payload, {
    status,
    headers: buildNoStoreHeaders("application/json; charset=utf-8", requestId),
  });
}

/**
 * 构造带防缓存头的 HTML 响应。
 * @param html HTML 文本。
 * @param headOnly 是否为 `HEAD` 请求（仅返回响应头，无响应体）。
 * @returns `Response` 实例。
 */
export function htmlResponse(html: string, headOnly: boolean): Response {
  return new Response(headOnly ? null : html, {
    status: 200,
    headers: buildNoStoreHeaders("text/html; charset=utf-8"),
  });
}

/**
 * 构造携带真实请求 ID、时间戳、客户端出口 IP 与 Host 的 401/403 JSON 响应（严禁暴露源站服务器 IP）。
 * @param request HTTP 请求对象。
 * @param params 状态码、错误代号、原因标识与错误说明。
 * @returns 带 `X-Request-Id` 响应头的 JSON `Response`。
 */
function accessErrorResponse(
  request: Request,
  params: Readonly<{
    readonly status: number;
    readonly code: string;
    readonly reason: string;
    readonly error: string;
  }>
): Response {
  const randomBytes: Uint8Array = new Uint8Array(8);
  crypto.getRandomValues(randomBytes);
  const requestId: string = randomBytes.toHex();
  const timestamp: string = `${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`;
  const clientIp: string = resolveSafeClientIp(request);
  let parsedUrl: URL | null;
  try {
    parsedUrl = new URL(request.url);
  } catch (_error: unknown) {
    parsedUrl = null;
  }
  const rawHost: string =
    request.headers.get("x-forwarded-host")?.trim() ??
    request.headers.get("host")?.trim() ??
    parsedUrl?.host ??
    "localhost";
  const hostNoPort: string = rawHost.split(":")[0]?.trim().toLowerCase() ?? "";
  const isIpHost: boolean =
    hostNoPort.startsWith("[") || MINI_APP_IPV4_HOST_PATTERN.test(hostNoPort);
  const host: string = rawHost.length > 0 && !isIpHost ? rawHost : "localhost";
  const path: string = parsedUrl?.pathname ?? "/";
  const diag: Readonly<MiniAppAccessDiagnostics> = {
    requestId,
    timestamp,
    clientIp,
    host,
    path,
    status: params.status,
    code: params.code,
    error: params.error,
  };
  return jsonResponse({ ok: false, reason: params.reason, ...diag }, params.status, diag.requestId);
}

/**
 * 从请求中提取 Telegram WebApp `initData`（默认仅接受请求头；仅当 `allowQueryAuth` 显式为 `true` 且方法为 `GET`/`HEAD` 时允许从 `initData` 查询参数提取以供 `<img>` 标签加载受保护图库资源）。
 * @param request HTTP 请求对象。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中回退读取查询参数。
 * @returns 提取出的 `initData` 原始查询串。
 */
export function extractInitDataFromHeaders(
  request: Request,
  allowQueryAuth: boolean = false
): string {
  const customHeader: string | null = request.headers.get(MINI_APP_INIT_DATA_HEADER);
  if (customHeader !== null && customHeader.trim().length > 0) return customHeader.trim();
  const authHeader: string | null = request.headers.get("authorization");
  if (authHeader?.toLowerCase().startsWith(MINI_APP_TMA_AUTH_PREFIX) === true) {
    return authHeader.slice(MINI_APP_TMA_AUTH_PREFIX.length).trim();
  }
  if (allowQueryAuth) {
    const method: string = request.method.toUpperCase();
    if (method === "GET" || method === "HEAD") {
      try {
        const queryInitData: string | null = new URL(request.url).searchParams.get("initData");
        if (queryInitData !== null && queryInitData.trim().length > 0) return queryInitData.trim();
      } catch (_error: unknown) {
        return "";
      }
    }
  }
  return "";
}

/**
 * 从请求头（或 `GET`/`HEAD` 查询参数）中提取 64 位十六进制密码认证会话令牌。
 * @param request HTTP 请求对象。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中回退读取 `session` 查询参数。
 * @returns 提取出的 64 位十六进制会话令牌或空字符串。
 */
function extractSessionToken(request: Request, allowQueryAuth: boolean = false): string {
  const headerToken: string | null = request.headers.get(MINI_APP_SESSION_HEADER);
  if (headerToken !== null && headerToken.trim().length > 0) return headerToken.trim();
  if (allowQueryAuth) {
    const method: string = request.method.toUpperCase();
    if (method === "GET" || method === "HEAD") {
      try {
        const queryToken: string | null = new URL(request.url).searchParams.get("session");
        if (queryToken !== null && queryToken.trim().length > 0) return queryToken.trim();
      } catch (_error: unknown) {
        return "";
      }
    }
  }
  return "";
}

/**
 * 清理已超过 90 分钟有效期的密码认证会话。
 * @param nowMs 当前毫秒时间戳。
 */
function purgeExpiredAuthSessions(nowMs: number): void {
  for (const [token, session] of miniAppAuthSessions) {
    if (session.expiresAt <= nowMs) miniAppAuthSessions.delete(token);
  }
}

/**
 * 检查超级管理员 ID 当前是否因密码连续输错达到 5 次而处于 30 分钟禁止访问锁定期。
 * @param request HTTP 请求对象。
 * @param nowMs 当前毫秒时间戳。
 * @returns 处于锁定期时返回 403 `Response`，未锁定或已过锁定期时返回 `null`。
 */
function checkSuperAdminPasswordLockout(
  request: Request,
  nowMs: number = Date.now()
): Response | null {
  const guard: Readonly<MiniAppPasswordGuardState> | null = miniAppPasswordGuardHolder.current;
  if (guard?.userId !== SUPER_ADMIN_USER_ID || guard.lockedUntil <= 0) return null;
  if (guard.lockedUntil <= nowMs) {
    miniAppPasswordGuardHolder.current = null;
    return null;
  }
  const remainingMinutes: number = Math.max(1, Math.ceil((guard.lockedUntil - nowMs) / 60_000));
  return accessErrorResponse(request, {
    status: 403,
    code: "PASSWORD_LOCKED",
    reason: "password_locked",
    error: `密码连续输错已达 ${MINI_APP_PASSWORD_MAX_ATTEMPTS} 次，当前超级管理员 ID (#${SUPER_ADMIN_USER_ID}) 已被锁定，30 分钟内无法访问（剩余约 ${remainingMinutes} 分钟）。`,
  });
}

/**
 * 校验请求携带的 Telegram WebApp `initData` 签名、时效、超级管理员身份与 30 分钟密码锁定状态（第一层网关校验）。
 * @param request HTTP 请求对象。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中从查询参数提取 `initData`。
 * @returns 验证通过时返回 `null`，失败时返回带真实请求诊断的 `401` 或 `403` `Response`。
 */
export function authenticateMiniAppInitData(
  request: Request,
  allowQueryAuth: boolean = false
): Response | null {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return accessErrorResponse(request, {
      status: 403,
      code: "CROSS_SITE_FORBIDDEN",
      reason: "forbidden_user",
      error: "Cross-site request to Telegram Mini App endpoint is forbidden.",
    });
  }
  const initData: string = extractInitDataFromHeaders(request, allowQueryAuth);
  const authResult: MiniAppAuthResult = verifyMiniAppInitData({
    initData,
    botToken: BOT_TOKEN,
    superAdminUserId: SUPER_ADMIN_USER_ID,
  });
  if (authResult.ok) {
    return checkSuperAdminPasswordLockout(request);
  }
  const status: number = authResult.reason === "forbidden_user" ? 403 : 401;
  return accessErrorResponse(request, {
    status,
    code: authResult.reason.toUpperCase(),
    reason: authResult.reason,
    error:
      authResult.reason === "forbidden_user"
        ? "Only the configured SuperAdmin user ID is permitted to access this Mini App."
        : `Telegram WebApp initData verification failed (${authResult.reason}). Direct external browser access is denied.`,
  });
}

/**
 * 校验请求的 `initData` 签名与 90 分钟有效期的访问密码认证会话（双层完整鉴权）。
 * @param request HTTP 请求对象。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中从查询参数提取凭据（仅用于图库图片流）。
 * @returns 验证通过时返回 `null`，失败时返回对应的 `401` 或 `403` JSON `Response`。
 */
export function authenticateMiniAppRequest(
  request: Request,
  allowQueryAuth: boolean = false
): Response | null {
  const initRejected: Response | null = authenticateMiniAppInitData(
    request,
    allowQueryAuth
  );
  if (initRejected !== null) return initRejected;

  const nowMs: number = Date.now();
  purgeExpiredAuthSessions(nowMs);
  const sessionToken: string = extractSessionToken(request, allowQueryAuth);
  if (!MINI_APP_SHA256_HEX_PATTERN.test(sessionToken)) {
    return accessErrorResponse(request, {
      status: 401,
      code: "PASSWORD_REQUIRED",
      reason: "password_required",
      error: "Mini App 访问密码尚未验证，请先输入访问密码解锁控制台。",
    });
  }
  const session: Readonly<MiniAppAuthSession> | undefined =
    miniAppAuthSessions.get(sessionToken);
  if (session === undefined || session.expiresAt <= nowMs) {
    return accessErrorResponse(request, {
      status: 401,
      code: "PASSWORD_REQUIRED",
      reason: "password_required",
      error: "Mini App 访问认证已满 90 分钟过期或无效，请重新输入访问密码。",
    });
  }
  return null;
}

/**
 * 签发一条新的 90 分钟密码认证会话令牌并存入主线程缓存。
 * @param nowMs 当前毫秒时间戳。
 * @returns 新签发的会话对象。
 */
export function issueMiniAppAuthSession(
  nowMs: number = Date.now()
): Readonly<MiniAppAuthSession> {
  purgeExpiredAuthSessions(nowMs);
  const tokenBytes: Uint8Array = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token: string = tokenBytes.toHex();
  const session: Readonly<MiniAppAuthSession> = {
    token,
    createdAt: nowMs,
    expiresAt: nowMs + MINI_APP_SESSION_TTL_MS,
  };
  miniAppAuthSessions.set(token, session);
  return session;
}

/**
 * 处理 `GET /api/auth/precheck`：核验调用方是否具备合法的 SuperAdmin `initData` 签名且未处于 30 分钟密码锁定期。
 * @param request HTTP 请求对象。
 * @returns JSON 响应。
 */
export function handleGetAuthPrecheckRoute(request: Request): Response {
  const initRejected: Response | null = authenticateMiniAppInitData(request, false);
  if (initRejected !== null) return initRejected;
  return jsonResponse({
    ok: true,
    ttlMs: MINI_APP_SESSION_TTL_MS,
  });
}

/**
 * 处理 `POST /api/auth/login`：校验 `mini_app.password`（连续输错 5 次锁定该超级管理员 ID 30 分钟），通过后签发 90 分钟会话令牌。
 * @param request HTTP 请求对象。
 * @returns JSON 响应。
 */
export async function handlePostAuthLoginRoute(request: Request): Promise<Response> {
  const initRejected: Response | null = authenticateMiniAppInitData(request, false);
  if (initRejected !== null) return initRejected;

  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  const inputPassword: string =
    typeof body?.password === "string" ? body.password.trim() : "";
  const activeConfig: Readonly<BotMiniAppConfig> | undefined =
    miniAppActiveConfigHolder.current ?? getBotMiniAppConfig();
  const expectedPassword: string =
    activeConfig?.password ?? MINI_APP_FALLBACK_TEST_PASSWORD;
  const nowMs: number = Date.now();

  if (!verifyMiniAppPassword(inputPassword, expectedPassword)) {
    const currentGuard: Readonly<MiniAppPasswordGuardState> | null =
      miniAppPasswordGuardHolder.current;
    const prevAttempts: number =
      currentGuard !== null &&
      currentGuard.userId === SUPER_ADMIN_USER_ID &&
      (currentGuard.lockedUntil === 0 || currentGuard.lockedUntil > nowMs)
        ? currentGuard.failedAttempts
        : 0;
    const nextAttempts: number = prevAttempts + 1;
    if (nextAttempts >= MINI_APP_PASSWORD_MAX_ATTEMPTS) {
      miniAppPasswordGuardHolder.current = {
        userId: SUPER_ADMIN_USER_ID,
        failedAttempts: nextAttempts,
        lockedUntil: nowMs + MINI_APP_PASSWORD_LOCKOUT_MS,
      };
      miniAppAuthSessions.clear();
      return checkSuperAdminPasswordLockout(request, nowMs)!;
    }
    miniAppPasswordGuardHolder.current = {
      userId: SUPER_ADMIN_USER_ID,
      failedAttempts: nextAttempts,
      lockedUntil: 0,
    };
    const remaining: number = MINI_APP_PASSWORD_MAX_ATTEMPTS - nextAttempts;
    return accessErrorResponse(request, {
      status: 403,
      code: "INVALID_PASSWORD",
      reason: "invalid_password",
      error: `访问密码错误，还剩 ${remaining} 次尝试机会（连续输错 ${MINI_APP_PASSWORD_MAX_ATTEMPTS} 次将锁定 30 分钟）。`,
    });
  }

  miniAppPasswordGuardHolder.current = null;
  const session: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession(nowMs);
  const response: MiniAppLoginSuccessResponse = {
    ok: true,
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    ttlMs: MINI_APP_SESSION_TTL_MS,
  };
  return jsonResponse(response);
}

/**
 * 归一化配置中的基础路径前缀（去除末尾斜杠，根路径保持 `"/"`）。
 * @returns 归一化后的基础路径。
 */
function configuredBasePathname(): string {
  const config: Readonly<BotMiniAppConfig> | undefined =
    miniAppActiveConfigHolder.current ?? getBotMiniAppConfig();
  if (config === undefined) return "/";
  try {
    const pathname: string = new URL(config.url).pathname.replace(/\/+$/u, "");
    return pathname.length > 0 ? pathname : "/";
  } catch (_error: unknown) {
    return "/";
  }
}

/**
 * 将请求路径按 `mini_app.url` 配置的子路径前缀剥离为内部标准路径（同时兼容 Cloudflare Tunnel 保留前缀或剥离前缀两种转发模式）。
 * @param rawPathname 原始 `url.pathname`。
 * @returns 归一化后的内部路由路径，或需重定向补齐末尾斜杠的指示。
 */
export function normalizeRoutePathname(
  rawPathname: string
): { readonly redirectTo?: string; readonly routePath: string } {
  const basePath: string = configuredBasePathname();
  if (basePath !== "/") {
    if (rawPathname === basePath) return { redirectTo: `${basePath}/`, routePath: "/" };
    if (rawPathname.startsWith(`${basePath}/`)) {
      const stripped: string = rawPathname.slice(basePath.length);
      return { routePath: stripped.length > 0 ? stripped : "/" };
    }
  }
  return { routePath: rawPathname.length > 0 ? rawPathname : "/" };
}

/**
 * 读取并严格解析有界大小的 JSON 请求体对象。
 * @param request HTTP 请求。
 * @returns 解析成功时返回普通对象，超出体积上限或非对象 JSON 时返回 `null`。
 */
export async function readJsonObjectBody(
  request: Request
): Promise<Record<string, unknown> | null> {
  try {
    const text: string = await request.text();
    if (BODY_TEXT_ENCODER.encode(text).byteLength > MINI_APP_MAX_JSON_BODY_BYTES) return null;
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
