import {
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_SESSION_EXPIRES_AT_HEADER,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_TTL_MS,
  MINI_APP_SHA256_HEX_PATTERN,
  MINI_APP_TMA_AUTH_PREFIX,
} from "../consts/miniApp/auth";
import {
  MINI_APP_ENCRYPTED_QUERY_PARAM,
  MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
  MINI_APP_SESSION_KEY_HEADER,
} from "../consts/miniAppCrypto";
import {
  clearMiniAppSessionToken,
  getMiniAppSessionCryptoKey,
  hasMiniAppSessionCryptoKey,
  readMiniAppSessionExpiresAt,
  readMiniAppSessionToken,
  setMiniAppSessionToken,
} from "../libs/credentials";
import {
  buildMiniAppEnvelopeAad,
  decryptMiniAppPayload,
  encryptMiniAppEnvelope,
  isMiniAppEncryptedEnvelope,
  sealMiniAppQuery,
  unsealRotatedSessionKey,
} from "../libs/crypto";
import { errorMessage } from "../libs/errorMessage";
import { asPayloadRecord } from "../libs/record";
import { readMiniAppInitData } from "../libs/telegram";
import {
  clearLocalMiniAppSessionIfMatching,
  createMiniAppAuthError,
  throwMiniAppRecordError,
} from "./authError";

/**
 * 将服务端毫秒时间戳换算为本机时钟下的同一时刻：以响应 `Date` 头（秒级精度）与本机当前时刻之差作为两端时钟差；
 * 缺少或无法解析 `Date` 头时视为无时钟差。会话到期判定与自动锁定都以换算后的本机时刻为准。
 *
 * @param serverEpochMs 服务端给出的毫秒时间戳
 * @param response 携带该时间戳的 HTTP 响应
 * @returns 本机时钟下的毫秒时间戳
 */
export function toLocalEpochMs(serverEpochMs: number, response: Response): number {
  const serverDateMs: number = Date.parse(response.headers.get("date") ?? "");
  if (!Number.isFinite(serverDateMs)) return serverEpochMs;
  return serverEpochMs - (serverDateMs - Date.now());
}

/**
 * 解析响应头 `X-Mini-App-Session-Expires-At` 并换算为本机未来到期时间戳；缺失或已非未来时刻时延长一个完整 `MINI_APP_SESSION_TTL_MS`。
 *
 * @param response HTTP 响应对象
 * @returns 本机到期毫秒时间戳
 */
function resolveRefreshedLocalExpiresAt(response: Response): number {
  const rawExpiresAt: string =
    response.headers.get(MINI_APP_SESSION_EXPIRES_AT_HEADER)?.trim() ?? "";
  const localExpiresAt: number = toLocalEpochMs(Number(rawExpiresAt), response);
  const nowMs: number = Date.now();
  return localExpiresAt > nowMs ? localExpiresAt : nowMs + MINI_APP_SESSION_TTL_MS;
}

/**
 * 在不轮换密钥的非加密响应（预检与附件下载探测）上同步同一会话令牌的新到期时刻；
 * 未携带 `X-Mini-App-Session-Key` 时仅接受与当前内存令牌一致的续期头，忽略不匹配的令牌值。
 *
 * @param response HTTP 响应对象
 */
export function syncRefreshedMiniAppSession(response: Response): void {
  const refreshedToken: string =
    response.headers.get(MINI_APP_SESSION_HEADER)?.trim() ?? "";
  if (!MINI_APP_SHA256_HEX_PATTERN.test(refreshedToken)) return;
  if (refreshedToken !== readMiniAppSessionToken()) return;
  setMiniAppSessionToken(refreshedToken, resolveRefreshedLocalExpiresAt(response));
}

/**
 * 在已认证加密 API 响应上同步滑动续期下发的新会话令牌与 `X-Mini-App-Session-Key` 封装的新 256-bit 会话密钥：
 * - 新密钥以本次请求发出时持有的会话密钥解封，并以新会话令牌作为 AEAD 附加认证数据校验绑定；
 * - 仅当本地活跃令牌仍等于本次请求发出的 `sentSessionToken` 时写入新令牌与新密钥；若同批并发请求已率先切至同一 `refreshedToken` 则仅单调顺延到期时刻；若本地已登出清空或已轮换至更新一代令牌则不回退覆盖；
 * - 未携带密钥头时仅接受与当前令牌一致的续期头，忽略不匹配的令牌值。
 *
 * @param response HTTP 响应对象
 * @param cryptoKeyAtSend 本次请求发出时使用的会话 `CryptoKey`
 * @param sentSessionToken 本次请求发出时携带的会话令牌
 */
async function syncRotatedMiniAppSession(
  response: Response,
  cryptoKeyAtSend: CryptoKey,
  sentSessionToken: string
): Promise<void> {
  const refreshedToken: string =
    response.headers.get(MINI_APP_SESSION_HEADER)?.trim() ?? "";
  if (!MINI_APP_SHA256_HEX_PATTERN.test(refreshedToken)) return;
  const sealedKeyHeader: string =
    response.headers.get(MINI_APP_SESSION_KEY_HEADER)?.trim() ?? "";
  const nextExpiresAt: number = resolveRefreshedLocalExpiresAt(response);
  if (sealedKeyHeader.length === 0) {
    if (refreshedToken === readMiniAppSessionToken()) {
      setMiniAppSessionToken(refreshedToken, nextExpiresAt);
    }
    return;
  }
  const currentBeforeUnseal: string = readMiniAppSessionToken();
  if (currentBeforeUnseal !== sentSessionToken && currentBeforeUnseal !== refreshedToken) {
    return;
  }
  const nextSessionKey: string = await unsealRotatedSessionKey(
    cryptoKeyAtSend,
    sealedKeyHeader,
    refreshedToken
  );
  const currentAfterUnseal: string = readMiniAppSessionToken();
  if (currentAfterUnseal === sentSessionToken) {
    setMiniAppSessionToken(refreshedToken, nextExpiresAt, nextSessionKey);
    await getMiniAppSessionCryptoKey();
  } else if (
    currentAfterUnseal === refreshedToken &&
    nextExpiresAt > readMiniAppSessionExpiresAt()
  ) {
    setMiniAppSessionToken(refreshedToken, nextExpiresAt);
  }
}

/**
 * 将任意相对、根路径或带反向代理子路径前缀的请求路径（不含查询串）归一化为以 `"/api/"` 开头的标准内部 API 路由路径，
 * 供客户端与服务端一致构造查询串加密的 AEAD 附加认证数据 `"${method} ${canonicalApiRoutePath}"`。
 *
 * @param pathWithoutQuery 不含查询串的请求路径（如 `"./api/configs/file"` 或 `"/subpath/api/chats/messages"`）
 * @returns 归一化后的内部 API 路径（如 `"/api/configs/file"`）
 */
export function resolveCanonicalMiniAppApiPath(pathWithoutQuery: string): string {
  const clean: string = (
    pathWithoutQuery.split(/[?#]/u, 1)[0] ?? pathWithoutQuery
  ).trim();
  const apiMarkerIndex: number = clean.indexOf("/api/");
  if (apiMarkerIndex >= 0) {
    return clean.slice(apiMarkerIndex);
  }
  const stripped: string = clean.replace(/^(?:\.\/|\/)+/u, "");
  return `/${stripped}`;
}

/**
 * 组装携带当前会话 `initData` 与 45 分钟令牌的认证请求头（绝不携带 `sessionKey`）。
 *
 * @param includeSession 是否附加 45 分钟会话令牌头
 * @param contentType 可选的 `Content-Type`
 * @param sessionTokenOverride 可选显式指定的会话令牌快照（缺省读取当前内存令牌）
 * @returns 组装好的请求头字典
 */
export function buildMiniAppAuthHeaders(
  includeSession: boolean,
  contentType?: string,
  sessionTokenOverride?: string
): Record<string, string> {
  const initData: string = readMiniAppInitData();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (initData.length > 0) {
    headers[MINI_APP_INIT_DATA_HEADER] = initData;
    headers.Authorization = `${MINI_APP_TMA_AUTH_PREFIX}${initData}`;
  }
  if (includeSession) {
    const sessionToken: string =
      sessionTokenOverride ?? readMiniAppSessionToken();
    if (sessionToken.length > 0) headers[MINI_APP_SESSION_HEADER] = sessionToken;
  }
  if (contentType !== undefined) headers["Content-Type"] = contentType;
  return headers;
}

/** `decodeMiniAppJsonResponse` 解密与校验 JSON 响应信封的可选参数。 */
export interface DecodeMiniAppJsonResponseOptions {
  /** 2xx 响应是否要求必须为 `MiniAppEncryptedEnvelope` 加密信封。 */
  readonly requireEncryptedSuccess?: boolean;
  /** 可选的 AEAD 附加认证数据字节（如登录握手响应绑定的 `MINI_APP_LOGIN_RESPONSE_AAD`）。 */
  readonly additionalData?: Uint8Array<ArrayBuffer>;
}

/**
 * 解析并按需解密 Mini App 后端 JSON 响应体：
 * - 响应为 `MiniAppEncryptedEnvelope` 时以请求发出时的会话或握手密钥（按需携带 `additionalData`）解密并解析内部 JSON；
 * - 非 2xx 且未加密时（如前置鉴权守卫直接返回的 401/403 诊断）原样返回供错误分支处理；
 * - 要求加密时，2xx 响应与凭据裁决 `403`（`INVALID_PASSWORD` / `INVALID_TOTP_CODE`，服务端只以密文下发）缺少合法密文信封即抛 `INVALID_ENCRYPTED_PAYLOAD` 拒绝明文降级。
 * 响应体读取失败（请求被 `AbortSignal` 中止、连接中断）时原样抛出读取错误，不按载荷失效处理；
 * 只有已读完的响应体不是合法 JSON 时才按 `null` 进入上述判定。
 *
 * @param response HTTP 响应对象
 * @param cryptoKeyAtSend 请求发出时持有的对称 `CryptoKey`（无加密上下文时为 `null`）
 * @param options 是否要求 2xx 必须加密与可选 AEAD 附加认证数据
 * @returns 解密并解析后的 JSON 值（响应体不是合法 JSON 时为 `null`）
 */
export async function decodeMiniAppJsonResponse(
  response: Response,
  cryptoKeyAtSend: CryptoKey | null,
  options: Readonly<DecodeMiniAppJsonResponseOptions> = {}
): Promise<unknown> {
  const bodyText: string = await response.text();
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(bodyText);
  } catch (_parseError: unknown) {
    rawPayload = null;
  }
  if (cryptoKeyAtSend !== null && isMiniAppEncryptedEnvelope(rawPayload)) {
    const decryptedText: string = await decryptMiniAppPayload(
      cryptoKeyAtSend,
      rawPayload,
      options.additionalData
    );
    try {
      return JSON.parse(decryptedText);
    } catch (error: unknown) {
      throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE, { cause: error });
    }
  }
  if (options.requireEncryptedSuccess === true && cryptoKeyAtSend !== null) {
    const code: unknown = asPayloadRecord(rawPayload).code;
    if (
      response.ok ||
      (response.status === 403 &&
        (code === "INVALID_PASSWORD" || code === "INVALID_TOTP_CODE"))
    ) {
      throw new Error(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
    }
  }
  return rawPayload;
}

/** 同一代次读取的会话令牌与 256-bit `AES-GCM` `CryptoKey` 快照。 */
export interface MiniAppSessionCryptoSnapshot {
  /** 与 `cryptoKeyAtSend` 同一代次读取的 64 位十六进制会话令牌。 */
  readonly sentSessionToken: string;
  /** 请求发出时刻持有并用于 AEAD 封包与响应解封的 256-bit `AES-GCM` `CryptoKey`。 */
  readonly cryptoKeyAtSend: CryptoKey;
}

/** `prepareEncryptedMiniAppQueryRequest` 生成的加密查询出站路径与发送时刻会话凭据。 */
export interface PreparedEncryptedMiniAppQueryRequest extends MiniAppSessionCryptoSnapshot {
  /** 携带 `?e=<ivBase64>.<cipherBase64>` 的出站路径（不含哈希片段）。 */
  readonly outboundPath: string;
}

/**
 * 读取当前活跃的会话令牌与 256-bit `AES-GCM` `CryptoKey` 快照；若并发滑动续期在异步导入密钥期间轮换了令牌与密钥，
 * 则追赶读取同一代次的最新凭据。本地缺少会话令牌或密钥时按发包令牌一致性清除本地会话凭据，并抛出附带
 * `sentSessionToken` 上下文的 `[PASSWORD_REQUIRED] PASSWORD_REQUIRED` 异常（连续轮换耗尽追赶次数时不会误清或锁定已生效的新会话），
 * 加密 JSON、查询与二进制上传请求一律在发出前拦截。
 *
 * @returns `(sentSessionToken, cryptoKeyAtSend)` 快照
 */
export async function resolveMiniAppSessionCryptoSnapshot(): Promise<MiniAppSessionCryptoSnapshot> {
  let sentSessionToken: string = readMiniAppSessionToken();
  let cryptoKeyAtSend: CryptoKey | null = await getMiniAppSessionCryptoKey();
  for (let attempt: number = 0; attempt < 3; attempt++) {
    const latestTokenBeforeEncrypt: string = readMiniAppSessionToken();
    if (latestTokenBeforeEncrypt.length === 0) {
      break;
    }
    if (latestTokenBeforeEncrypt === sentSessionToken && cryptoKeyAtSend !== null) {
      return { sentSessionToken, cryptoKeyAtSend };
    }
    if (!hasMiniAppSessionCryptoKey()) {
      break;
    }
    sentSessionToken = latestTokenBeforeEncrypt;
    cryptoKeyAtSend = await getMiniAppSessionCryptoKey();
  }
  const activeToken: string = readMiniAppSessionToken();
  if (activeToken.length > 0 && activeToken === sentSessionToken && cryptoKeyAtSend !== null) {
    return { sentSessionToken, cryptoKeyAtSend };
  }
  if (activeToken.length === 0 || activeToken === sentSessionToken) {
    clearMiniAppSessionToken();
  }
  throw createMiniAppAuthError(
    "[PASSWORD_REQUIRED] PASSWORD_REQUIRED",
    undefined,
    sentSessionToken
  );
}

/**
 * 以 `"${METHOD} ${canonicalApiRoutePath}"` 作为 AEAD 附加认证数据把非空原始查询串封装为 `?e=`；
 * 会话凭据经 `resolveMiniAppSessionCryptoSnapshot` 读取，缺失时同样在发出前拦截。
 *
 * @param basePathPart 不含查询串与哈希片段的接口路径（如 `"./api/gallery/file"`）
 * @param rawQuery 不含前导 `?` 的非空原始查询串
 * @param method HTTP 请求方法（如 `"GET"` 或 `"HEAD"`）
 * @returns 带 `?e=` 的出站路径及同期读取的会话令牌与 `CryptoKey`
 */
export async function prepareEncryptedMiniAppQueryRequest(
  basePathPart: string,
  rawQuery: string,
  method: string
): Promise<PreparedEncryptedMiniAppQueryRequest> {
  const { sentSessionToken, cryptoKeyAtSend }: MiniAppSessionCryptoSnapshot =
    await resolveMiniAppSessionCryptoSnapshot();
  const normalizedMethod: string = method.toUpperCase();
  const aadText: string =
    `${normalizedMethod} ${resolveCanonicalMiniAppApiPath(basePathPart)}`;
  const sealedQuery: string = await sealMiniAppQuery(
    cryptoKeyAtSend,
    rawQuery,
    aadText
  );
  return {
    outboundPath:
      `${basePathPart}?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(sealedQuery)}`,
    sentSessionToken,
    cryptoKeyAtSend,
  };
}

/** `decodeAndSyncEncryptedMiniAppResponse` 解密加密业务响应体并同步滑动轮换会话的入参。 */
export interface DecodeAndSyncEncryptedMiniAppResponseOptions {
  /** 服务端返回的 HTTP 响应对象。 */
  readonly response: Response;
  /** 本次请求发出时刻持有的会话 `CryptoKey`。 */
  readonly cryptoKeyAtSend: CryptoKey;
  /** 本次请求发出时刻携带的会话令牌。 */
  readonly sentSessionToken: string;
  /** 本次响应体解密绑定的 AEAD 附加认证数据字节。 */
  readonly additionalData: Uint8Array<ArrayBuffer>;
}

/**
 * 先校验并解密受会话保护的业务 JSON 响应信封，再同步响应头中的滑动续期令牌与封装密钥：
 * - 响应体解密校验失败或遇到明文 2xx 降级时，绝不采纳同响应上的轮换头；
 * - 解密响应信封或解封 `X-Mini-App-Session-Key` 命中 `INVALID_ENCRYPTED_PAYLOAD`（会话密钥已吊销、失步或载荷损坏）时，
 *   按令牌一致性清除本地会话凭据并抛出 `[PASSWORD_REQUIRED] INVALID_ENCRYPTED_PAYLOAD`，触发根仓库退回验证页。
 *
 * @param options 响应对象、发包时刻会话凭据与响应 AAD
 * @returns 解密并解析后的 JSON 值
 */
export async function decodeAndSyncEncryptedMiniAppResponse({
  response,
  cryptoKeyAtSend,
  sentSessionToken,
  additionalData,
}: Readonly<DecodeAndSyncEncryptedMiniAppResponseOptions>): Promise<unknown> {
  try {
    const payload: unknown = await decodeMiniAppJsonResponse(
      response,
      cryptoKeyAtSend,
      {
        requireEncryptedSuccess: true,
        additionalData,
      }
    );
    await syncRotatedMiniAppSession(response, cryptoKeyAtSend, sentSessionToken);
    return payload;
  } catch (error: unknown) {
    if (errorMessage(error) === MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE) {
      clearLocalMiniAppSessionIfMatching(sentSessionToken);
      throw createMiniAppAuthError(
        `[PASSWORD_REQUIRED] ${MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE}`,
        error,
        sentSessionToken
      );
    }
    throw error;
  }
}

/**
 * 调用 Mini App 受会话保护的加密业务 JSON 接口：自动附带 SuperAdmin `initData` 与 45 分钟二次认证会话令牌请求头，
 * 对非空 URL 查询串（`?e=`，AEAD 绑定 `"${method} ${canonicalApiRoutePath}"`）、请求体与响应体执行 AES-256-GCM 会话密钥端到端加解密，
 * 本地缺少会话令牌或密钥时在发出前拦截（认证握手/注销接口由各自模块直接请求，不经过本函数）。
 * 响应体解密或轮换密钥解封失败、HTTP `401`、或命中会话失效/密钥吊销/访问拒绝状态码时先按令牌一致性清除本地会话凭据，并在错误消息前附加 `[状态码] ` 前缀。
 *
 * @param path 相对路径（如 `./api/status` 或 `./api/configs/file?scope=dynamic&fileName=ad_detect.json`）
 * @param init 可选 `RequestInit` 配置
 * @returns 解密并解析后的 JSON 响应对象
 */
export async function miniAppFetchJson<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const hashIndex: number = path.indexOf("#");
  const withoutHash: string = hashIndex >= 0 ? path.slice(0, hashIndex) : path;
  const hashPart: string = hashIndex >= 0 ? path.slice(hashIndex) : "";
  const questionIndex: number = withoutHash.indexOf("?");
  const basePathPart: string =
    questionIndex >= 0 ? withoutHash.slice(0, questionIndex) : withoutHash;
  const rawQuery: string =
    questionIndex >= 0 ? withoutHash.slice(questionIndex + 1) : "";
  const method: string = (init?.method ?? "GET").toUpperCase();

  const prepared: Readonly<PreparedEncryptedMiniAppQueryRequest> =
    rawQuery.length > 0
      ? await prepareEncryptedMiniAppQueryRequest(basePathPart, rawQuery, method)
      : { ...(await resolveMiniAppSessionCryptoSnapshot()), outboundPath: basePathPart };
  const { sentSessionToken, cryptoKeyAtSend }: MiniAppSessionCryptoSnapshot = prepared;

  const canonicalPath: string = resolveCanonicalMiniAppApiPath(basePathPart);
  const outboundBody: string | undefined =
    typeof init?.body === "string" || (method !== "GET" && method !== "HEAD")
      ? JSON.stringify(
        await encryptMiniAppEnvelope(
          cryptoKeyAtSend,
          typeof init?.body === "string" && init.body.length > 0 ? init.body : "{}",
          buildMiniAppEnvelopeAad(method, canonicalPath, "req")
        )
      )
      : undefined;

  const response: Response = await fetch(`${prepared.outboundPath}${hashPart}`, {
    ...init,
    ...(outboundBody !== undefined ? { body: outboundBody } : {}),
    headers: {
      ...buildMiniAppAuthHeaders(
        true,
        outboundBody !== undefined ? "application/json" : undefined,
        sentSessionToken
      ),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const payload: unknown = await decodeAndSyncEncryptedMiniAppResponse({
    response,
    cryptoKeyAtSend,
    sentSessionToken,
    additionalData: buildMiniAppEnvelopeAad(method, canonicalPath, "res"),
  });
  if (!response.ok) {
    throwMiniAppRecordError(payload, response.status, sentSessionToken);
  }
  return payload as T;
}
