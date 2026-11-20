import {
  MINI_APP_AES_GCM_IV_BYTES,
  MINI_APP_AES_GCM_TAG_BITS,
  MINI_APP_ENCRYPTED_QUERY_PARAM,
  MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH,
} from "../../consts/miniAppCrypto";
import {
  readBoundedResponseBytes,
  readBoundedResponseText,
} from "../../libs/boundedResponse";
import type { BoundedResponseResult } from "../../libs/boundedResponse";
import type { MiniAppEncryptedEnvelope } from "../../types/miniApp/configs";
import type { MiniAppRouteContext } from "../../types/miniApp/server";
import { evaluateMiniAppSessionRequestIvs } from "../auth/session";
import type { MiniAppSessionRequestIvCheckResult } from "../auth/session";
import {
  buildMiniAppEnvelopeAad,
  decryptMiniAppBinary,
  decryptMiniAppText,
  parseMiniAppEncryptedEnvelope,
  unsealMiniAppQuery,
} from "../libs/crypto";
import { parseStrictSingleQueryParam } from "../libs/request";

/** `unwrapEncryptedMiniAppRequest` 解封加密 URL 查询参数与加密请求体的内部辨别结果。 */
export type UnwrapEncryptedMiniAppRequestResult =
  | {
    readonly ok: true;
    readonly url: URL;
    readonly request: Request;
    readonly consumedIvs: readonly string[];
  }
  | {
    readonly ok: false;
    readonly reason: "invalid" | "cap_exceeded";
  };

/** `unwrapEncryptedMiniAppRequest` 解封加密 URL 查询参数与加密请求体的入参。 */
export interface UnwrapEncryptedMiniAppRequestOptions {
  /** 路由请求上下文。 */
  readonly ctx: Readonly<MiniAppRouteContext>;
  /** 规范化的路由路径（用于绑定 `${METHOD} ${routePath}:req` AAD）。 */
  readonly routePath: string;
  /** 与请求令牌匹配的 `AES-GCM` 对称密钥。 */
  readonly cryptoKey: CryptoKey;
  /** 当前匹配密钥纪元已受理请求的 IV 去重集合。 */
  readonly seenRequestIvs: ReadonlySet<string>;
  /** 请求体是否采用 `[12B IV || 密文+16B 标签]` 原始二进制帧而非 JSON 信封。 */
  readonly encryptBinaryRequest: boolean;
  /** 允许读取的最大外层加密请求体字节数。 */
  readonly maxBodyBytes: number;
}

/** `parseIncomingEncryptedBody` 读取并解包密文请求体的内部辨别结果。 */
type ParsedIncomingEncryptedBody =
  | {
    readonly ok: true;
    readonly iv: string;
    readonly bodyEnvelope: Readonly<MiniAppEncryptedEnvelope> | null;
    readonly binaryBodyBytes: Uint8Array | null;
  }
  | { readonly ok: false };

/** 解析出的待解封加密 `?e=` 查询参数组件（已提前分离 IV 供重放校验）。 */
interface ParsedEncryptedQueryComponent {
  readonly sealedQuery: string;
  readonly queryIv: string;
}

/**
 * 判断已解析的 `URL` 在不含非空 `search` 时是否携带裸 `?` 空查询分隔符（如 `/api/configs/file?`）。
 * @param url 已解析的请求 `URL`。
 * @returns 存在裸 `?` 分隔符时返回 `true`。
 */
function hasBareEmptyQueryDelimiter(url: URL): boolean {
  const href: string = url.href;
  const hashIndex: number = href.indexOf("#");
  const beforeHash: string = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  return beforeHash.endsWith("?");
}

/**
 * 从 `?e=<ivBase64>.<cipherBase64>` 提取单个严格格式的加密查询串及前置 IV，禁止裸 `?`、明文参数、多参数或超长密文。
 * @param url 请求 `URL`。
 * @returns 提取出的 `{ sealedQuery, queryIv }`，违例时返回 `null`。
 */
function parseStrictEncryptedQueryComponent(
  url: URL
): Readonly<ParsedEncryptedQueryComponent> | null {
  if (
    url.search === "?" ||
    url.search.length > MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH * 3 + 16
  ) {
    return null;
  }
  const sealedQuery: string | null = parseStrictSingleQueryParam(
    url,
    MINI_APP_ENCRYPTED_QUERY_PARAM
  );
  if (
    sealedQuery === null ||
    sealedQuery.length === 0 ||
    sealedQuery.length > MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH
  ) {
    return null;
  }
  const dotIndex: number = sealedQuery.indexOf(".");
  if (
    dotIndex <= 0 ||
    dotIndex >= sealedQuery.length - 1 ||
    sealedQuery.includes(".", dotIndex + 1)
  ) {
    return null;
  }
  return {
    sealedQuery,
    queryIv: sealedQuery.slice(0, dotIndex),
  };
}

/**
 * 读取并初筛加密请求体（支持 JSON 信封或原始二进制 AES-256-GCM 帧），提取 12 字节随机 IV 供重放防线校验。
 * @param request HTTP 请求对象。
 * @param encryptBinaryRequest 是否采用原始二进制帧格式。
 * @param maxBodyBytes 允许读取的最大外层加密请求体字节数。
 * @returns 初筛成功时返回 `{ ok: true, iv, bodyEnvelope, binaryBodyBytes }`，否则返回 `{ ok: false }`。
 */
async function parseIncomingEncryptedBody(
  request: Request,
  encryptBinaryRequest: boolean,
  maxBodyBytes: number
): Promise<ParsedIncomingEncryptedBody> {
  if (encryptBinaryRequest) {
    let readResult: BoundedResponseResult;
    try {
      readResult = await readBoundedResponseBytes(request, maxBodyBytes);
    } catch (_error: unknown) {
      return { ok: false };
    }
    const minFrameBytes: number =
      MINI_APP_AES_GCM_IV_BYTES + MINI_APP_AES_GCM_TAG_BITS / 8;
    if (!readResult.ok || readResult.bytes.byteLength < minFrameBytes) {
      return { ok: false };
    }
    return {
      ok: true,
      iv: readResult.bytes.subarray(0, MINI_APP_AES_GCM_IV_BYTES).toBase64(),
      bodyEnvelope: null,
      binaryBodyBytes: readResult.bytes,
    };
  }
  let rawBodyText: string | null;
  try {
    rawBodyText = await readBoundedResponseText(request, maxBodyBytes);
  } catch (_error: unknown) {
    return { ok: false };
  }
  if (rawBodyText === null || rawBodyText.length === 0) {
    return { ok: false };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBodyText);
  } catch (_error: unknown) {
    return { ok: false };
  }
  const envelope: Readonly<MiniAppEncryptedEnvelope> | null =
    parseMiniAppEncryptedEnvelope(parsedJson);
  if (envelope === null) {
    return { ok: false };
  }
  return {
    ok: true,
    iv: envelope.iv,
    bodyEnvelope: envelope,
    binaryBodyBytes: null,
  };
}

/**
 * 解密携带 `encryptRequest: true` 策略路由的加密 URL 查询串（`?e=`）与加密请求体（JSON 信封或原始二进制 AES-256-GCM 帧），同时执行同密钥纪元 IV 重放与容量保护：
 * - 所有 HTTP 方法均禁止裸 `?`、明文业务参数与重放 IV；
 * - 非 `GET`/`HEAD` 方法一律拒绝 0 字节或不足标签长的空请求体（JSON 路由强制携带 `{ encrypted: true, iv, payload }`；二进制上传路由强制携带 `[12B IV || 密文+16B 标签]`），并绑定 `${METHOD} ${routePath}:req` AAD；
 * - 若匹配密钥纪元的 `seenRequestIvs` 已达上限 `MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS`，返回 `"cap_exceeded"`。
 * @param options 路由上下文、路由路径、对称密钥、IV 集合、二进制模式标记与请求体上限。
 * @returns 解密成功时返回下游 `{ url, request, consumedIvs }`，失败时返回具体拒绝原因。
 */
export async function unwrapEncryptedMiniAppRequest({
  ctx,
  routePath,
  cryptoKey,
  seenRequestIvs,
  encryptBinaryRequest,
  maxBodyBytes,
}: Readonly<UnwrapEncryptedMiniAppRequestOptions>): Promise<UnwrapEncryptedMiniAppRequestResult> {
  let queryComponent: Readonly<ParsedEncryptedQueryComponent> | null = null;
  if (ctx.url.search.length === 0) {
    if (hasBareEmptyQueryDelimiter(ctx.url)) {
      return { ok: false, reason: "invalid" };
    }
  } else {
    queryComponent = parseStrictEncryptedQueryComponent(ctx.url);
    if (queryComponent === null) {
      return { ok: false, reason: "invalid" };
    }
  }

  let parsedBody: ParsedIncomingEncryptedBody | null = null;
  if (ctx.method !== "GET" && ctx.method !== "HEAD") {
    parsedBody = await parseIncomingEncryptedBody(
      ctx.request,
      encryptBinaryRequest,
      maxBodyBytes
    );
    if (!parsedBody.ok) {
      return { ok: false, reason: "invalid" };
    }
  }

  const incomingIvs: string[] = [];
  if (queryComponent !== null) {
    incomingIvs.push(queryComponent.queryIv);
  }
  if (parsedBody !== null) {
    incomingIvs.push(parsedBody.iv);
  }
  const ivCheck: MiniAppSessionRequestIvCheckResult =
    evaluateMiniAppSessionRequestIvs(seenRequestIvs, incomingIvs);
  if (ivCheck === "cap_exceeded") {
    return { ok: false, reason: "cap_exceeded" };
  }
  if (ivCheck === "replay") {
    return { ok: false, reason: "invalid" };
  }

  let decryptedUrl: URL = ctx.url;
  if (queryComponent !== null) {
    const decryptedQuery: string | null = await unsealMiniAppQuery(
      cryptoKey,
      queryComponent.sealedQuery,
      `${ctx.method} ${routePath}`
    );
    if (
      decryptedQuery === null ||
      decryptedQuery.length === 0 ||
      decryptedQuery.startsWith("?")
    ) {
      return { ok: false, reason: "invalid" };
    }
    decryptedUrl = new URL(ctx.url.href);
    decryptedUrl.search = `?${decryptedQuery}`;
    if (decryptedUrl.search.length <= 1) {
      return { ok: false, reason: "invalid" };
    }
  }

  if (parsedBody === null) {
    const effectiveRequest: Request =
      decryptedUrl === ctx.url
        ? ctx.request
        : new Request(decryptedUrl.toString(), {
          method: ctx.request.method,
          headers: ctx.request.headers,
        });
    return {
      ok: true,
      url: decryptedUrl,
      request: effectiveRequest,
      consumedIvs: incomingIvs,
    };
  }

  const requestAad: Uint8Array<ArrayBuffer> = buildMiniAppEnvelopeAad(
    ctx.method,
    routePath,
    "req"
  );
  if (parsedBody.binaryBodyBytes !== null) {
    const decryptedBytes: Uint8Array<ArrayBuffer> | null =
      await decryptMiniAppBinary({
        cryptoKey,
        encryptedBytes: parsedBody.binaryBodyBytes,
        additionalData: requestAad,
      });
    if (decryptedBytes === null) {
      return { ok: false, reason: "invalid" };
    }
    const headers: Headers = new Headers(ctx.request.headers);
    headers.delete("content-length");
    return {
      ok: true,
      url: decryptedUrl,
      request: new Request(decryptedUrl.toString(), {
        method: ctx.request.method,
        headers,
        body: decryptedBytes,
      }),
      consumedIvs: incomingIvs,
    };
  }

  if (parsedBody.bodyEnvelope === null) {
    return { ok: false, reason: "invalid" };
  }
  const decryptedText: string | null = await decryptMiniAppText({
    cryptoKey,
    encrypted: parsedBody.bodyEnvelope,
    additionalData: requestAad,
  });
  if (decryptedText === null) {
    return { ok: false, reason: "invalid" };
  }

  const headers: Headers = new Headers(ctx.request.headers);
  headers.delete("content-length");
  return {
    ok: true,
    url: decryptedUrl,
    request: new Request(decryptedUrl.toString(), {
      method: ctx.request.method,
      headers,
      body: decryptedText,
    }),
    consumedIvs: incomingIvs,
  };
}
