/**
 * config/dynamic/cron.json 的字段与动作条目解析辅助。
 */

import { resolve } from "node:path";
import {
  CRON_MAX_IMAGES,
  CRON_RANDOM_INTERVAL_MAX_MS,
  CRON_RANDOM_INTERVAL_MIN_MS,
} from "../consts/cron";
import { RUNTIME_DATA_ROOT } from "../consts/paths";
import { VOICE_OPERATOR_TEXT_MAX_CHARS, VOICE_TONE_MAX_CHARS } from "../consts/aiChat/voiceMessage";
import {
  WEB_DIGEST_DEFAULT_LANGUAGE,
  WEB_DIGEST_DEFAULT_MAX_ITEMS,
  WEB_DIGEST_INSTRUCTIONS_MAX_CHARS,
  WEB_DIGEST_LANGUAGES,
  WEB_DIGEST_MAX_ITEMS,
  WEB_DIGEST_MIN_ITEMS,
  WEB_DIGEST_TOPIC_MAX_CHARS,
} from "../consts/webDigest";
import { sanitizeInline } from "../libs/text";
import { TELEGRAM_CAPTION_MAX_CHARS, TELEGRAM_MESSAGE_MAX_CHARS } from "../consts/telegram";
import { parseDurationTokenMs } from "../libs/durationToken";
import { invalidInput, optionalBooleanField } from "../libs/inputValidation";
import type { InputFieldContext } from "../libs/inputValidation";
import { hasOnlyKeys, isPlainRecord } from "../libs/record";
import type { WebDigestLanguage } from "../types/webDigest";
import type {
  CronAction,
  CronFileSource,
  CronImageSource,
  CronRandomInterval,
} from "../types/cron";

/**
 * 以 context 的来源与字段路径抛出统一的输入错误。
 * @param context 字段的来源文件与 JSONPath 上下文。
 * @param expected 期望字段形态的描述。
 */
export function fail(context: InputFieldContext, expected: string): never {
  return invalidInput(context.source, context.path, expected);
}

/**
 * 派生子字段的输入校验上下文。
 * @param context 父级字段的来源与路径上下文。
 * @param key 子属性名。
 * @returns 拼接了 `.key` 的子字段上下文。
 */
export function child(context: InputFieldContext, key: string): InputFieldContext {
  return { source: context.source, path: `${context.path}.${key}` };
}

/**
 * 去掉首尾空白后非空且不超过上限的字符串；返回去空白后的值。
 * @param value 待校验的字段值。
 * @param context 字段的来源文件与 JSONPath 上下文。
 * @param maxChars 允许的最大字符数。
 * @returns 去空白后的非空字符串。
 */
export function boundedText(value: unknown, context: InputFieldContext, maxChars: number): string {
  const text: string = typeof value === "string" ? value.trim() : "";
  if (text.length === 0 || text.length > maxChars) {
    return fail(context, `a non-empty string of at most ${maxChars} characters`);
  }
  return text;
}

/**
 * `"<min>-<max>"` 或单值（等价于以 CRON_RANDOM_INTERVAL_MIN_MS 为下界、该值为上界），单位 m/h/d，
 * 落在 [CRON_RANDOM_INTERVAL_MIN_MS, CRON_RANDOM_INTERVAL_MAX_MS] 且 min ≤ max；整串先去掉首尾空白。
 * @param value 待校验的随机延迟区间字符串。
 * @param context 字段的来源文件与 JSONPath 上下文。
 * @returns 解析出的最小与最大延迟毫秒数。
 */
export function parseRandomInterval(value: unknown, context: InputFieldContext): CronRandomInterval {
  const expected: string = "\"<min>-<max>\" or \"<max>\" with m/h/d units, within 1m-24d and min <= max";
  if (typeof value !== "string") return fail(context, expected);
  const parts: string[] = value.trim().split("-");
  if (parts.length > 2) return fail(context, expected);
  const first: number | undefined = parseDurationTokenMs(parts[0]!);
  const second: number | undefined = parts.length === 2 ? parseDurationTokenMs(parts[1]!) : undefined;
  const minMs: number | undefined = parts.length === 2 ? first : CRON_RANDOM_INTERVAL_MIN_MS;
  const maxMs: number | undefined = parts.length === 2 ? second : first;
  if (
    minMs === undefined || maxMs === undefined ||
    minMs < CRON_RANDOM_INTERVAL_MIN_MS || maxMs > CRON_RANDOM_INTERVAL_MAX_MS || minMs > maxMs
  ) {
    return fail(context, expected);
  }
  return { minMs, maxMs };
}

/**
 * 本机的文件或目录路径：去掉首尾空白后，绝对路径原样使用，相对路径按运行时数据根解析；拒绝空串与 NUL，
 * 返回规范化后的绝对路径。
 * @param value 待校验的路径字符串。
 * @param context 字段的来源文件与 JSONPath 上下文。
 * @returns 按运行时数据根解析后的绝对路径。
 */
function parseLocalPath(value: unknown, context: InputFieldContext): string {
  const path: string = typeof value === "string" ? value.trim() : "";
  if (path.length === 0 || path.includes("\0")) {
    return fail(context, "an absolute local path or a path relative to the runtime data root");
  }
  return resolve(RUNTIME_DATA_ROOT, path);
}

/**
 * 交给 Telegram 拉取的绝对 http(s) 地址；去掉首尾空白后只校验形态。
 * @param value 待校验的 URL 字符串。
 * @param context 字段的来源文件与 JSONPath 上下文。
 * @returns 归一化后的 http(s) URL 字符串。
 */
function parseUrl(value: unknown, context: InputFieldContext): string {
  const parsed: URL | null = typeof value === "string" ? URL.parse(value.trim()) : null;
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return fail(context, "an absolute http(s) URL");
  }
  return parsed.href;
}

/**
 * 去掉首尾空白后不超过上限，清洗成单行后仍须非空；返回清洗后的单行。
 * @param value 待校验的字符串字段值。
 * @param context 字段的来源文件与 JSONPath 上下文。
 * @param maxChars 去空白后的最大字符数。
 * @returns 压缩空白并去掉首尾空白后的非空单行字符串。
 */
function boundedLine(value: unknown, context: InputFieldContext, maxChars: number): string {
  const text: string = sanitizeInline(boundedText(value, context, maxChars)).trim();
  if (text.length === 0) return fail(context, `a non-empty string of at most ${maxChars} characters`);
  return text;
}

/**
 * 解码可选的媒体配文：缺省返回 undefined，存在时须为不超过 Telegram 配文上限的非空字符串。
 * @param value 待校验的 `content` 字段值。
 * @param context 字段的来源文件与 JSONPath 上下文。
 * @returns 去空白后的配文字符串；字段缺省时返回 undefined。
 */
function optionalCaption(value: unknown, context: InputFieldContext): string | undefined {
  return value === undefined ? undefined : boundedText(value, context, TELEGRAM_CAPTION_MAX_CHARS);
}

/**
 * 恰好一个 `url` 或 `path`（普通文件）。
 * @param payload `send_file` 动作的载荷对象。
 * @param context 载荷对象的来源与 JSONPath 上下文。
 * @returns 解析出的远程 URL 或本地文件路径来源。
 */
function parseFileSource(payload: Record<string, unknown>, context: InputFieldContext): CronFileSource {
  if ((payload.url === undefined) === (payload.path === undefined)) {
    return fail(context, "exactly one of url or path");
  }
  if (payload.url !== undefined) return { kind: "url", url: parseUrl(payload.url, child(context, "url")) };
  return { kind: "path", path: parseLocalPath(payload.path, child(context, "path")) };
}

/**
 * 固定图片必须是一个非空来源数组；单张也使用数组，不接受随机目录。
 * @param payload `send_image` 动作的载荷对象。
 * @param context 载荷对象的来源与 JSONPath 上下文。
 * @returns 解析出的远程 URL 列表或本地文件路径列表来源。
 */
function parseImageSources(payload: Record<string, unknown>, context: InputFieldContext): CronImageSource {
  if ((payload.url === undefined) === (payload.path === undefined)) {
    return fail(context, "exactly one of url or path arrays");
  }
  const isUrl: boolean = payload.url !== undefined;
  const value: unknown = isUrl ? payload.url : payload.path;
  const fieldContext: InputFieldContext = child(context, isUrl ? "url" : "path");
  if (!Array.isArray(value) || value.length === 0 || value.length > CRON_MAX_IMAGES) {
    return fail(fieldContext, `an array of 1–${CRON_MAX_IMAGES} image sources`);
  }
  const sources: string[] = [];
  for (let index: number = 0; index < value.length; index++) {
    const item: InputFieldContext = { source: context.source, path: `${fieldContext.path}[${index}]` };
    sources.push(isUrl ? parseUrl(value[index], item) : parseLocalPath(value[index], item));
  }
  return isUrl ? { kind: "urls", urls: sources } : { kind: "paths", paths: sources };
}

/**
 * 摘要语言：缺省 WEB_DIGEST_DEFAULT_LANGUAGE，出现时必须是 WEB_DIGEST_LANGUAGES 之一。
 * @param value 待校验的 `language` 字段值。
 * @param context 字段的来源文件与 JSONPath 上下文。
 * @returns 已校验的网络摘要语言标识。
 */
function parseDigestLanguage(value: unknown, context: InputFieldContext): WebDigestLanguage {
  if (value === undefined) return WEB_DIGEST_DEFAULT_LANGUAGE;
  const language: string = typeof value === "string" ? value.trim() : "";
  for (const candidate of WEB_DIGEST_LANGUAGES) {
    if (candidate === language) return candidate;
  }
  return fail(context, WEB_DIGEST_LANGUAGES.map((name: string): string => `"${name}"`).join(", "));
}

/**
 * 条目总数上限：缺省 WEB_DIGEST_DEFAULT_MAX_ITEMS，出现时必须是区间内的整数。
 * @param value 待校验的 `max_items` 字段值。
 * @param context 字段的来源文件与 JSONPath 上下文。
 * @returns 已校验的网络摘要最大条目数。
 */
function parseDigestMaxItems(value: unknown, context: InputFieldContext): number {
  if (value === undefined) return WEB_DIGEST_DEFAULT_MAX_ITEMS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < WEB_DIGEST_MIN_ITEMS || value > WEB_DIGEST_MAX_ITEMS) {
    return fail(context, `an integer from ${WEB_DIGEST_MIN_ITEMS} to ${WEB_DIGEST_MAX_ITEMS}`);
  }
  return value;
}

/**
 * 解码单个定时任务动作条目。
 * @param value 待校验的动作对象。
 * @param context 动作条目的来源与 JSONPath 上下文。
 * @returns 已通过校验的定时任务动作定义。
 */
export function parseAction(value: unknown, context: InputFieldContext): CronAction {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["type", "payload"]) || !isPlainRecord(value.payload)) {
    return fail(context, "{ type, payload: object }");
  }
  const payload: Record<string, unknown> = value.payload;
  const payloadContext: InputFieldContext = child(context, "payload");
  const type: string = typeof value.type === "string" ? value.type.trim() : "";
  switch (type) {
    case "send_message":
      if (!hasOnlyKeys(payload, ["content"])) return fail(payloadContext, "{ content }");
      return {
        type: "send_message",
        content: boundedText(payload.content, child(payloadContext, "content"), TELEGRAM_MESSAGE_MAX_CHARS),
      };
    case "send_image": {
      if (!hasOnlyKeys(payload, ["content", "rand_image", "url", "path", "is_blurred"])) {
        return fail(payloadContext, "{ content?, rand_image?, url?, path?, is_blurred? }");
      }
      const content: string | undefined = optionalCaption(payload.content, child(payloadContext, "content"));
      const isBlurred: boolean = optionalBooleanField(payload, "is_blurred", payloadContext) === true;
      if (optionalBooleanField(payload, "rand_image", payloadContext) !== true) {
        return { type: "send_image", content, source: parseImageSources(payload, payloadContext), isBlurred };
      }
      if (payload.url !== undefined) return fail(child(payloadContext, "url"), "absent when rand_image is true");
      const source: CronImageSource = {
        kind: "random",
        directory: payload.path === undefined ? null : parseLocalPath(payload.path, child(payloadContext, "path")),
      };
      return { type: "send_image", content, source, isBlurred };
    }
    case "send_file":
      if (!hasOnlyKeys(payload, ["content", "url", "path"])) return fail(payloadContext, "{ content?, url?, path? }");
      return {
        type: "send_file",
        content: optionalCaption(payload.content, child(payloadContext, "content")),
        source: parseFileSource(payload, payloadContext),
      };
    case "send_voice":
      if (!hasOnlyKeys(payload, ["content", "tone"])) return fail(payloadContext, "{ content, tone? }");
      return {
        type: "send_voice",
        content: boundedLine(payload.content, child(payloadContext, "content"), VOICE_OPERATOR_TEXT_MAX_CHARS),
        tone: payload.tone === undefined
          ? undefined
          : boundedLine(payload.tone, child(payloadContext, "tone"), VOICE_TONE_MAX_CHARS),
      };
    case "send_web_digest":
      if (!hasOnlyKeys(payload, ["topic", "language", "max_items", "instructions"])) {
        return fail(payloadContext, "{ topic, language?, max_items?, instructions? }");
      }
      return {
        type: "send_web_digest",
        topic: boundedLine(payload.topic, child(payloadContext, "topic"), WEB_DIGEST_TOPIC_MAX_CHARS),
        language: parseDigestLanguage(payload.language, child(payloadContext, "language")),
        maxItems: parseDigestMaxItems(payload.max_items, child(payloadContext, "max_items")),
        instructions: payload.instructions === undefined
          ? undefined
          : boundedText(payload.instructions, child(payloadContext, "instructions"), WEB_DIGEST_INSTRUCTIONS_MAX_CHARS),
      };
    default:
      return fail(child(context, "type"), "send_message, send_image, send_file, send_voice or send_web_digest");
  }
}
