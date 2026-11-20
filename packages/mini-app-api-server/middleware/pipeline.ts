import {
  MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
  MINI_APP_MAX_ENCRYPTED_JSON_BODY_BYTES,
} from "../../consts/miniAppCrypto";
import type { MiniAppEncryptedEnvelope } from "../../types/miniApp/configs";
import type { MiniAppAuthSession } from "../../types/miniApp/auth";
import type {
  MiniAppAuthPolicy,
  MiniAppBunRouteHandler,
  MiniAppRouteContext,
  MiniAppRouteHandler,
} from "../../types/miniApp/server";
import {
  attachRefreshedSessionHeaders,
  commitMiniAppSessionAccess,
  revokeMiniAppAuthSessionByLineage,
} from "../auth/session";
import type {
  CommitMiniAppSessionAccessResult,
  CommittedMiniAppSessionState,
  LookedUpMiniAppSessionState,
} from "../auth/session";
import {
  buildMiniAppEnvelopeAad,
  encryptMiniAppEnvelope,
} from "../libs/crypto";
import { extractSessionToken } from "../libs/request";
import { accessErrorResponse, jsonResponse } from "../libs/response";
import { normalizeRoutePathname } from "../libs/routePath";
import { unwrapEncryptedMiniAppRequest } from "./encryptedRequest";
import type { UnwrapEncryptedMiniAppRequestResult } from "./encryptedRequest";
import { verifyMiniAppRequestHeadersFast } from "./headerGuard";
import type { MiniAppHeaderGuardResult } from "./headerGuard";
import { verifyMiniAppInitDataAccess } from "./initData";
import type { MiniAppInitDataAccessResult } from "./initData";
import { verifyMiniAppSessionAccess } from "./sessionToken";
import type { MiniAppSessionAccessResult } from "./sessionToken";

/** Mini App 同步鉴权管道返回的统一只读准入结果。 */
type MiniAppAuthorizationResult =
  | {
    readonly ok: true;
    readonly sessionState: Readonly<LookedUpMiniAppSessionState> | null;
  }
  | { readonly ok: false; readonly response: Response };

/** 需随响应附带的轮换会话凭据：新会话记录与经上一代密钥封装的新密钥密文。 */
interface RotationResponseHeaders {
  /** 轮换后的当前会话记录（写入 `X-Mini-App-Session` 与到期时刻）。 */
  readonly session: Readonly<MiniAppAuthSession>;
  /** 写入 `X-Mini-App-Session-Key` 的 `<ivBase64>.<cipherBase64>` 密文。 */
  readonly sealedSessionKey: string;
}

/** `finalizeAuthorizedResponse` 封装加密响应体与续期响应头的入参。 */
export interface FinalizeAuthorizedResponseOptions {
  /** 路由处理器产出的原始业务响应。 */
  readonly rawResponse: Response;
  /** 大写 HTTP 请求方法。 */
  readonly method: string;
  /** 规范化的路由路径（用于绑定 `${METHOD} ${routePath}:res` AAD）。 */
  readonly routePath: string;
  /** 路由鉴权与加密策略。 */
  readonly policy: Readonly<MiniAppAuthPolicy>;
  /** 与请求携带的令牌相匹配的会话对称密钥（免会话路由为 `null`）。 */
  readonly cryptoKey: CryptoKey | null;
  /** 本次响应需附带的轮换会话凭据（未轮换且无待重新附带的轮换密文时为 `null`）。 */
  readonly rotationHeaders: Readonly<RotationResponseHeaders> | null;
}

/**
 * 按路由鉴权策略同步执行只读准入校验：
 * 1. 请求头与 `initData` 形态前置校验；
 * 2. 校验 Telegram WebApp `initData` 签名、时效与 30 分钟锁定期；
 * 3. `policy.requireSession` 为 `true` 时，只读查找 45 分钟二次认证会话与匹配密钥，不触发轮换或清除旧令牌。
 * @param ctx 路由请求上下文。
 * @param policy 路由静态声明的鉴权策略。
 * @returns 鉴权通过时返回只读会话查找结果；失败时返回拦截 `Response`。
 */
function authorizeMiniAppRequest(
  ctx: Readonly<MiniAppRouteContext>,
  policy: Readonly<MiniAppAuthPolicy>
): MiniAppAuthorizationResult {
  const headerResult: MiniAppHeaderGuardResult = verifyMiniAppRequestHeadersFast(ctx);
  if (!headerResult.ok) {
    return headerResult;
  }

  const nowMs: number = Date.now();
  const sessionToken: string = extractSessionToken(ctx.request);
  const initDataResult: MiniAppInitDataAccessResult = verifyMiniAppInitDataAccess({
    request: ctx.request,
    headerInitData: headerResult.headerInitData,
    sessionToken,
    nowMs,
  });
  if (!initDataResult.ok) {
    return initDataResult;
  }

  if (!policy.requireSession) {
    return {
      ok: true,
      sessionState: null,
    };
  }

  const sessionResult: MiniAppSessionAccessResult = verifyMiniAppSessionAccess({
    request: ctx.request,
    sessionToken,
    nowMs,
  });
  if (!sessionResult.ok) {
    return sessionResult;
  }
  return {
    ok: true,
    sessionState: sessionResult.sessionState,
  };
}

/**
 * 按策略加密非 `HEAD` 响应体为绑定 `${METHOD} ${routePath}:res` AAD 的 `MiniAppEncryptedEnvelope`，
 * 并在本次请求触发滑动轮换或经 `previousToken` 命中尚未确认的轮换时写入最新令牌与经旧密钥封装的新会话密钥响应头。
 * @param options 原始响应、请求方法、路由路径、策略、对称密钥与待附带的轮换会话凭据。
 * @returns 最终返回给客户端的 HTTP `Response`。
 */
async function finalizeAuthorizedResponse({
  rawResponse,
  method,
  routePath,
  policy,
  cryptoKey,
  rotationHeaders,
}: Readonly<FinalizeAuthorizedResponseOptions>): Promise<Response> {
  let finalResponse: Response = rawResponse;
  if (policy.encryptResponse && cryptoKey !== null && method !== "HEAD") {
    const plainBody: string = await rawResponse.text();
    const envelope: Readonly<MiniAppEncryptedEnvelope> =
      await encryptMiniAppEnvelope(
        cryptoKey,
        plainBody,
        buildMiniAppEnvelopeAad(method, routePath, "res")
      );
    const headers: Headers = new Headers(rawResponse.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json; charset=utf-8");
    finalResponse = Response.json(envelope, {
      status: rawResponse.status,
      headers,
    });
  }
  if (rotationHeaders !== null) {
    return attachRefreshedSessionHeaders(
      finalResponse,
      rotationHeaders.session,
      rotationHeaders.sealedSessionKey
    );
  }
  return finalResponse;
}

/**
 * 解析本次响应需附带的轮换会话凭据：经 `previousToken` 命中且密文封装已落定时直接取回已记录的密文，
 * 提交阶段刚触发轮换或命中尚未落定的在途封装时等待同一共享 `sealedSessionKeyPromise`（仅解析为密文）。
 * @param committed 提交阶段结果。
 * @returns 待附带的轮换会话凭据；无需附带时返回 `null`。
 */
async function resolveRotationResponseHeaders(
  committed: Readonly<CommittedMiniAppSessionState>
): Promise<Readonly<RotationResponseHeaders> | null> {
  if (committed.redeliveredSealedSessionKey !== undefined) {
    return {
      session: committed.session,
      sealedSessionKey: committed.redeliveredSealedSessionKey,
    };
  }
  if (committed.sealedSessionKeyPromise === undefined) {
    return null;
  }
  const sealedSessionKey: string = await committed.sealedSessionKeyPromise;
  return { session: committed.session, sealedSessionKey };
}

/**
 * 在已有路由上下文上执行只读鉴权、解密 URL 查询参数与请求体、原子提交会话状态（IV 登记、确认旧令牌失效与滑动轮换并同步启动密文封装）、
 * 等待轮换密文就绪后再运行终端处理器，最后绑定方向 AAD 加密响应体并附加轮换响应头。
 * @param ctx 路由请求上下文。
 * @param policy 路由静态声明的鉴权与加密策略。
 * @param handler 终端路由处理器。
 * @returns 最终 HTTP `Response`。
 */
export async function runMiniAppAuthorized(
  ctx: Readonly<MiniAppRouteContext>,
  policy: Readonly<MiniAppAuthPolicy>,
  handler: MiniAppRouteHandler
): Promise<Response> {
  const auth: MiniAppAuthorizationResult = authorizeMiniAppRequest(ctx, policy);
  if (!auth.ok) {
    return auth.response;
  }

  const routePath: string = normalizeRoutePathname(ctx.url.pathname).routePath;
  const sessionState: Readonly<LookedUpMiniAppSessionState> | null =
    auth.sessionState;
  const cryptoKey: CryptoKey | null =
    sessionState !== null ? await sessionState.matchedCryptoKey : null;

  let effectiveUrl: URL = ctx.url;
  let effectiveRequest: Request = ctx.request;
  let consumedIvs: readonly string[] = [];

  if (policy.encryptRequest) {
    if (sessionState === null || cryptoKey === null) {
      return jsonResponse({ error: MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE }, 400);
    }
    const unwrapped: UnwrapEncryptedMiniAppRequestResult =
      await unwrapEncryptedMiniAppRequest({
        ctx,
        routePath,
        cryptoKey,
        seenRequestIvs: sessionState.matchedSeenRequestIvs,
        encryptBinaryRequest: policy.encryptBinaryRequest === true,
        maxBodyBytes: policy.maxBodyBytes ?? MINI_APP_MAX_ENCRYPTED_JSON_BODY_BYTES,
      });
    if (!unwrapped.ok) {
      if (unwrapped.reason === "cap_exceeded") {
        revokeMiniAppAuthSessionByLineage(sessionState.session.lineageId);
        return accessErrorResponse(ctx.request, {
          status: 401,
          code: "PASSWORD_REQUIRED",
          reason: "password_required",
          error: "SESSION_EXPIRED",
        });
      }
      // 请求解密或格式校验失败：绝不清除 previousToken、绝不推进轮换、绝不附带续期响应头。
      return finalizeAuthorizedResponse({
        rawResponse: jsonResponse(
          { error: MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE },
          400
        ),
        method: ctx.method,
        routePath,
        policy,
        cryptoKey,
        rotationHeaders: null,
      });
    }
    effectiveUrl = unwrapped.url;
    effectiveRequest = unwrapped.request;
    consumedIvs = unwrapped.consumedIvs;
  }

  // 异步解密完成后再次核验活跃会话、提交同密钥纪元 IV 防重放集合并推进滑动轮换（消除 TOCTOU）。
  const commitResult: CommitMiniAppSessionAccessResult | null =
    sessionState !== null
      ? commitMiniAppSessionAccess({
        session: sessionState.session,
        requestToken: sessionState.requestToken,
        matchedViaPrevious: sessionState.matchedViaPrevious,
        allowRotation: policy.encryptResponse,
        acceptedRequestIvs: consumedIvs,
      })
      : null;

  if (commitResult !== null && !commitResult.ok) {
    if (commitResult.reason === "replay") {
      return finalizeAuthorizedResponse({
        rawResponse: jsonResponse(
          { error: MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE },
          400
        ),
        method: ctx.method,
        routePath,
        policy,
        cryptoKey,
        rotationHeaders: null,
      });
    }
    return accessErrorResponse(ctx.request, {
      status: 401,
      code: "PASSWORD_REQUIRED",
      reason: "password_required",
      error: "SESSION_EXPIRED",
    });
  }

  const committed: Readonly<CommittedMiniAppSessionState> | null = commitResult;
  const rotationHeaders: Readonly<RotationResponseHeaders> | null =
    committed !== null
      ? await resolveRotationResponseHeaders(committed)
      : null;
  const rawResponse: Response = await handler({
    request: effectiveRequest,
    url: effectiveUrl,
    method: ctx.method,
    sessionLineageId: committed?.session.lineageId,
  });
  return finalizeAuthorizedResponse({
    rawResponse,
    method: ctx.method,
    routePath,
    policy,
    cryptoKey,
    rotationHeaders,
  });
}

/**
 * 将鉴权策略与路由处理器包装为可直接挂入 `Bun.serve({ routes })` 的单参请求处理函数。
 * @param policy 路由静态声明的鉴权策略。
 * @param handler 终端路由处理器。
 * @returns 接受 `Request` 并返回 `Promise<Response>` 的函数。
 */
export function withMiniAppAuth(
  policy: Readonly<MiniAppAuthPolicy>,
  handler: MiniAppRouteHandler
): MiniAppBunRouteHandler {
  return (request: Request): Promise<Response> => {
    const url: URL = new URL(request.url);
    const method: string = request.method.toUpperCase();
    const ctx: Readonly<MiniAppRouteContext> = {
      request,
      url,
      method,
    };
    return runMiniAppAuthorized(ctx, policy, handler);
  };
}
