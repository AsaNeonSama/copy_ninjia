import {
  AVATAR_FETCH_TIMEOUT_MS,
  AVATAR_MAX_DOWNLOAD_BYTES,
  PUBLIC_PROFILE_PAGE_MAX_DOWNLOAD_BYTES,
  TELEGRAM_PUBLIC_ASSET_HOST_SUFFIXES,
} from "../../../consts/telegram";
import { runTelegramCategorizedRequest } from "../outboundGate";
import { discardResponseBody, readBoundedResponseBytes, readBoundedResponseText } from "../../../libs/boundedResponse";
import type { BoundedResponseResult } from "../../../libs/boundedResponse";
import { parseAllowedHttpsUrl } from "../../../libs/httpUrlPolicy";
import { stripLeadingAtSigns } from "../../../libs/text";
import { logger } from "../../logger";
import { signalWithTimeout } from "../../../libs/abortSignal";
import { sniffImageFormat } from "../../image";
import type { SniffedImageFormat } from "../../image";

interface ParsedHtmlTag {
  name: string;
  attributes: ReadonlyMap<string, string>;
}

/**
 * 去掉首尾空白和多余的 @（剥离规则与转录、逐字缓存共用 libs/text.ts 的那一份），
 * 空结果视为没有公开用户名。
 * @param username 原始用户名字符串。
 * @returns 剥离首尾空白与前导 @ 后的非空用户名；为空或未提供时返回 undefined。
 */
export function normalizePublicUsername(username: string | undefined): string | undefined {
  const normalized: string | undefined = username === undefined
    ? undefined
    : stripLeadingAtSigns(username.trim());
  return normalized || undefined;
}

/**
 * 从 getChat 响应中优先提取 username，再尝试 active_usernames。
 * @param chat getChat 返回的聊天对象。
 * @returns 提取并规范化后的公开用户名；未找到时返回 undefined。
 */
export function extractPublicUsername(chat: unknown): string | undefined {
  if (!chat || typeof chat !== "object") return undefined;
  const maybeChat: { username?: unknown; active_usernames?: unknown } = chat;
  if (typeof maybeChat.username === "string") {
    const username: string | undefined = normalizePublicUsername(maybeChat.username);
    if (username) return username;
  }
  if (Array.isArray(maybeChat.active_usernames)) {
    for (const activeUsername of maybeChat.active_usernames) {
      if (typeof activeUsername !== "string") continue;
      const username: string | undefined = normalizePublicUsername(activeUsername);
      if (username) return username;
    }
  }
  return undefined;
}

/**
 * 只解码 URL 和 HTML 属性中会用到的实体，未知或无效实体保持原样。
 * @param value 原始 HTML 属性字符串。
 * @returns 解码常见 HTML 实体与数值字符引用后的字符串。
 */
function decodeHtmlAttribute(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (entity: string): string => {
    switch (entity.toLowerCase()) {
      case "&amp;": return "&";
      case "&quot;": return '"';
      case "&apos;": return "'";
      case "&lt;": return "<";
      case "&gt;": return ">";
    }

    const hexadecimal: boolean = entity[2]?.toLowerCase() === "x";
    const digits: string = entity.slice(hexadecimal ? 3 : 2, -1);
    const codePoint: number = Number.parseInt(digits, hexadecimal ? 16 : 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return entity;
    }
    return String.fromCodePoint(codePoint);
  });
}

/**
 * 解析 img/meta/link 起始标签；页面正文已在进入这里前受 PUBLIC_PROFILE_PAGE_MAX_DOWNLOAD_BYTES 限制。
 * HTMLRewriter 交出的标签名与属性名已是小写、属性值未解码实体；同名属性只取首个。
 * @param html 页面 HTML 文本。
 * @returns 按出现顺序解析出的 img、meta、link 标签列表。
 */
function parseRelevantHtmlTags(html: string): ParsedHtmlTag[] {
  const tags: ParsedHtmlTag[] = [];
  new HTMLRewriter()
    .on("img, meta, link", {
      element(element: HTMLRewriterTypes.Element): void {
        const attributes: Map<string, string> = new Map();
        for (const [name, rawValue] of element.attributes) {
          if (attributes.has(name)) continue;
          attributes.set(name, decodeHtmlAttribute(rawValue));
        }
        tags.push({ name: element.tagName, attributes });
      },
    })
    .transform(html);
  return tags;
}

/**
 * 解析不含用户名与密码的 HTTPS URL。
 * @param value 待解析的 URL 字符串。
 * @returns 合法无凭据 HTTPS URL 对象；不合法或未提供时返回 undefined。
 */
function parseHttpsUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  const url: URL | null = URL.parse(value.trim());
  if (url?.protocol !== "https:" || url.username || url.password) return undefined;
  return url;
}

/**
 * 校验并解析主机名后缀属于 Telegram 公共资源域名的 HTTPS URL。
 * @param value 待校验的 URL 字符串。
 * @returns 符合公共资源白名单策略的 URL 对象；不合策略时返回 undefined。
 */
function parseTelegramAssetUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  return parseAllowedHttpsUrl({
    input: value.trim(),
    policy: { allowedHostnameSuffixes: TELEGRAM_PUBLIC_ASSET_HOST_SUFFIXES },
  }) ?? undefined;
}

/**
 * 判断标签的空白分隔属性中是否包含指定 token（忽略大小写）。
 * @param attributes 标签属性表。
 * @param name 属性名。
 * @param expected 期望包含的小写 token。
 * @returns 包含该 token 时返回 true，否则返回 false。
 */
function hasAttributeToken(attributes: ReadonlyMap<string, string>, name: string, expected: string): boolean {
  return attributes.get(name)?.split(/\s+/).some((token: string): boolean => token.toLowerCase() === expected) ?? false;
}

/**
 * 判断 meta 标签的 property 或 name 属性是否等于指定类型名（忽略大小写）。
 * @param attributes 标签属性表。
 * @param expected 期望匹配的 meta 名称（小写）。
 * @returns 匹配时返回 true，否则返回 false。
 */
function isMetaKind(attributes: ReadonlyMap<string, string>, expected: string): boolean {
  return [attributes.get("property"), attributes.get("name")]
    .some((value: string | undefined): boolean => value?.trim().toLowerCase() === expected);
}

/**
 * 判断 URL 是否为指向期望用户名的 t.me / telegram.me 主页 HTTPS 链接。
 * @param value 待检查的链接字符串。
 * @param expectedUsername 期望匹配的用户名。
 * @returns 精确指向该用户名主页时返回 true，否则返回 false。
 */
function isMatchingHttpsProfileUrl(value: string | undefined, expectedUsername: string): boolean {
  const url: URL | undefined = parseHttpsUrl(value);
  if (!url || url.port || url.search || url.hash) return false;
  const hostname: string = url.hostname.toLowerCase().replace(/^www\./, "");
  if (hostname !== "t.me" && hostname !== "telegram.me") return false;

  try {
    const pathname: string = decodeURIComponent(url.pathname).replace(/\/$/, "");
    return pathname.toLowerCase() === `/${expectedUsername.toLowerCase()}`;
  } catch {
    return false;
  }
}

/**
 * 判断链接是否为指向期望用户名的 `tg://resolve?domain=...` 深链接。
 * @param value 待检查的链接字符串。
 * @param expectedUsername 期望匹配的用户名。
 * @returns 精确匹配该用户名的深链接时返回 true，否则返回 false。
 */
function isMatchingTelegramDeepLink(value: string | undefined, expectedUsername: string): boolean {
  if (!value) return false;
  const url: URL | null = URL.parse(value.trim());
  if (
    url?.protocol !== "tg:" || url.hostname.toLowerCase() !== "resolve" ||
    url.pathname || url.port || url.username || url.password || url.hash
  ) {
    return false;
  }
  const queryEntries: [string, string][] = [...url.searchParams.entries()];
  return queryEntries.length === 1 &&
    queryEntries[0]![0] === "domain" &&
    queryEntries[0]![1].toLowerCase() === expectedUsername.toLowerCase();
}

/**
 * 判断 meta 标签是否属于承载主页身份标识的字段。
 * @param attributes 标签属性表。
 * @returns 属于主页身份 meta 时返回 true，否则返回 false。
 */
function isProfileIdentityMeta(attributes: ReadonlyMap<string, string>): boolean {
  return [
    "og:url",
    "al:ios:url",
    "al:android:url",
    "twitter:app:url:iphone",
    "twitter:app:url:ipad",
    "twitter:app:url:googleplay",
  ].some((kind: string): boolean => isMetaKind(attributes, kind));
}

/**
 * 检查已解析标签列表中是否存在证明页面属于期望用户名的身份 meta 或 canonical link。
 * @param tags 已解析的相关标签列表。
 * @param expectedUsername 期望匹配的用户名。
 * @returns 存在匹配的主页身份标签时返回 true，否则返回 false。
 */
function hasMatchingProfileIdentity(tags: readonly ParsedHtmlTag[], expectedUsername: string): boolean {
  return tags.some(({ name, attributes }: ParsedHtmlTag): boolean => {
    if (name === "meta" && isProfileIdentityMeta(attributes)) {
      const content: string | undefined = attributes.get("content");
      return isMatchingHttpsProfileUrl(content, expectedUsername) || isMatchingTelegramDeepLink(content, expectedUsername);
    }
    if (name === "link" && hasAttributeToken(attributes, "rel", "canonical")) {
      return isMatchingHttpsProfileUrl(attributes.get("href"), expectedUsername);
    }
    return false;
  });
}

/**
 * 按标签顺序返回第一个指定 meta 中合法 Telegram 资源地址的 href。
 * @param tags 已解析的相关标签列表。
 * @param metaKind 目标 meta 的名称（如 "og:image"）。
 * @returns 第一个合法 Telegram 资源 URL 字符串；未找到时返回 undefined。
 */
function findMetaAssetUrl(tags: readonly ParsedHtmlTag[], metaKind: string): string | undefined {
  for (const { name, attributes } of tags) {
    if (name !== "meta" || !isMetaKind(attributes, metaKind)) continue;
    const photoUrl: URL | undefined = parseTelegramAssetUrl(attributes.get("content"));
    if (photoUrl) return photoUrl.href;
  }
  return undefined;
}

/**
 * 从 t.me 公开主页提取头像 HTTPS URL。优先使用头像 class；语义 meta 回退
 * 只有在页面身份与目标 username 完全匹配时才启用。
 * @param html t.me 公开主页的 HTML 文本。
 * @param expectedUsername 期望核对的公开用户名。
 * @returns 提取到的头像 HTTPS URL；未提取到时返回 undefined。
 */
export function extractAvatarUrlFromProfileHtml(html: string, expectedUsername?: string): string | undefined {
  const tags: ParsedHtmlTag[] = parseRelevantHtmlTags(html);
  for (const { name, attributes } of tags) {
    if (name !== "img" || !hasAttributeToken(attributes, "class", "tgme_page_photo_image")) continue;
    const photoUrl: URL | undefined = parseTelegramAssetUrl(attributes.get("src"));
    if (photoUrl) return photoUrl.href;
  }

  const normalizedUsername: string | undefined = normalizePublicUsername(expectedUsername);
  if (!normalizedUsername || !hasMatchingProfileIdentity(tags, normalizedUsername)) return undefined;
  return findMetaAssetUrl(tags, "og:image") ?? findMetaAssetUrl(tags, "twitter:image");
}

/**
 * 从 t.me 公开主页下载头像，页面或图片异常时返回 null。
 * @param username 目标公开用户名。
 * @param signal 调用方的取消信号。
 * @returns 下载并校验为 JPEG/PNG 的头像字节；失败或无头像时返回 null。
 */
export async function fetchAvatarFromWebProfile(username: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  try {
    const pageSignal: AbortSignal = signalWithTimeout(signal, AVATAR_FETCH_TIMEOUT_MS);
    const pageRes: Response = await runTelegramCategorizedRequest({
      category: "externalFetch",
      signal: pageSignal,
      execute: (requestSignal: AbortSignal): Promise<Response> => fetch(`https://telegram.me/${encodeURIComponent(username)}`, {
        redirect: "error",
        signal: requestSignal,
      }),
    });
    if (!pageRes.ok) {
      void discardResponseBody(pageRes);
      logger.error(`Failed to fetch telegram.me profile page for @${username}: ${pageRes.status}`);
      return null;
    }
    const html: string | null = await readBoundedResponseText(pageRes, PUBLIC_PROFILE_PAGE_MAX_DOWNLOAD_BYTES);
    if (html === null) {
      logger.error(`telegram.me profile page for @${username} exceeded the download limit`);
      return null;
    }

    const photoUrl: string | undefined = extractAvatarUrlFromProfileHtml(html, username);
    if (!photoUrl) {
      logger.warn(`No profile photo found on t.me page for @${username}`);
      return null;
    }

    const imageSignal: AbortSignal = signalWithTimeout(signal, AVATAR_FETCH_TIMEOUT_MS);
    const imgRes: Response = await runTelegramCategorizedRequest({
      category: "externalFetch",
      signal: imageSignal,
      execute: (requestSignal: AbortSignal): Promise<Response> => fetch(photoUrl, {
        redirect: "error",
        signal: requestSignal,
      }),
    });
    if (!imgRes.ok) {
      void discardResponseBody(imgRes);
      logger.error(`Failed to download avatar from ${photoUrl}: ${imgRes.status}`);
      return null;
    }
    const download: BoundedResponseResult = await readBoundedResponseBytes(imgRes, AVATAR_MAX_DOWNLOAD_BYTES);
    if (!download.ok) {
      logger.error(`Avatar for @${username} exceeded the download limit (${download.observedBytes} bytes)`);
      return null;
    }
    // 只把可识别的 JPEG/PNG 交给 setMyProfilePhoto；空响应体（零长 buffer）同样在这里被挡下。
    const format: SniffedImageFormat = sniffImageFormat(download.bytes);
    if (format !== "jpeg" && format !== "png") {
      logger.error(`Avatar for @${username} is not a JPEG or PNG image (${download.bytes.byteLength} bytes)`);
      return null;
    }
    return download.bytes;
  } catch (error: unknown) {
    if (signal?.aborted) return null;
    logger.error(`Error scraping t.me profile photo for @${username}:`, error);
    return null;
  }
}
