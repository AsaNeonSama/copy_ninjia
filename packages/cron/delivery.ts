/**
 * cron 动作的唯一 Telegram 发送边界（`check:conventions` 禁止 packages/cron/ 其它文件发送）。
 *
 * cron 消息是用户授权的长期保留例外（见 AGENTS.md「Telegram 提示留存」），不挂固定
 * 延迟删除；不带话题（落在 General）。只有 `send_web_digest` 设 `parse_mode: "MarkdownV2"`，
 * 其余动作不设。全部请求都经主线程
 * grammY 客户端，因此照常经过出站闸（发送类进所属聊天的发送调度器车道）；成功后登记自发消息。
 * 单图调用 sendPhoto，多图调用一次 sendMediaGroup，只有首图携带 caption；
 * 相册逐项应用遮罩并登记所有返回消息 ID；发出的每张图都写一条 AI 记忆占位态自录。
 * `send_voice` 先经 AI Worker 的语音合成公共实现（aiChat/voiceSynthesis.ts）把台词与语气
 * 合成成 Telegram 语音（OGG/Opus 或 MP3），再按其文件名调用 sendVoice；合成结果登记进本轮的 CronRoundVoices，重试与后续
 * 会话复用同一段语音。本轮首次发送成功后记下 Telegram 交回的 file_id，之后改为引用它，
 * 不重复上传。`send_web_digest` 经 AI Worker 生成摘要（未搜索时为加警示的模型正文），拿回
 * MarkdownV2 原文登记进本轮的 CronRoundDigests，重试与后续会话复用；不传 link_preview_options，
 * 由 Telegram 为正文第一个链接生成预览。每次调用只投递一次，失败按 CronDeliveryOutcome 分类
 * 交给 cron/run.ts 决定是否重试，本边界不记日志；Telegram 拒收（4xx，含 MarkdownV2 解析失败）
 * 不重试，也不降级成纯文本。
 */

import { HttpError, InputFile } from "grammy";
import { telegramSignal } from "../libs/telegramSignal";
import type { InputMediaPhoto, Message } from "grammy/types";
import type { Stats } from "node:fs";
import { basename } from "node:path";
import { TELEGRAM_DOCUMENT_UPLOAD_MAX_BYTES, TELEGRAM_PHOTO_UPLOAD_MAX_BYTES } from "../consts/telegram";
import { composeWebDigest, recordBotImage, synthesizeVoice } from "../aiChat";
import { MARKDOWN_V2_PARSE_MODE } from "../consts/telegramMarkdown";
import { pickRandomImage } from "../infra/randomImage";
import { getAssetConfig } from "../config/assets";
import { runTelegramAction } from "../infra/telegram/actions/core";
import { toTelegramSendResult } from "../infra/telegram/actions/sendResult";
import { telegramErrorDetails } from "../infra/telegram/errors";
import { bot } from "../infra/telegram/mainClient";
import { TelegramSendQueueFullError } from "../infra/telegram/sendScheduler";
import type {
  CronAction,
  CronDeliveryOutcome,
  CronFileSource,
  CronImageSource,
  CronRoundDigests,
  CronRoundVoice,
  CronRoundVoices,
} from "../types/cron";
import type { WebDigestCompositionResult, WebDigestFailure } from "../types/webDigest";
import type { EncodedVoiceMessage, VoiceSynthesisFailure, VoiceSynthesisResult } from "../types/aiChat/voiceMessage";
import type { RandomImagePick } from "../types/randomImage";
import { errorMessage } from "../libs/errorMessage";

/**
 * 一次发送失败的分类：TelegramSendQueueFullError（所属聊天或全局发送排队满）、服务端 5xx、仍被 429 挡住与 HttpError 网络错误可重试，其余 4xx 与本地错误不重试。
 *
 * @param error 捕获到的发送异常
 * @returns 投递结果分类（可重试或永久失败）
 */
function classifyFailure(error: unknown): CronDeliveryOutcome {
  if (error instanceof TelegramSendQueueFullError) return { kind: "retryable", detail: error.message };
  const details: Readonly<{ errorCode: number; description: string }> | undefined = telegramErrorDetails(error);
  if (details !== undefined) {
    const detail: string = `${details.errorCode} ${details.description}`;
    return details.errorCode >= 500 || details.errorCode === 429
      ? { kind: "retryable", detail }
      : { kind: "permanent", detail };
  }
  const message: string = errorMessage(error);
  return error instanceof HttpError ? { kind: "retryable", detail: message } : { kind: "permanent", detail: message };
}

/**
 * 登记一条已发出的 cron 消息；图片另写一条占位态自录（见 aiChat/botImages.ts）。
 *
 * @param chatId 目标会话 ID
 * @param message Telegram 已发出的消息
 */
function recordSentMessage(chatId: number, message: Message): void {
  toTelegramSendResult(chatId, message);
  if (message.photo !== undefined) {
    recordBotImage({ chatId, messageId: message.message_id, caption: message.caption ?? "", edited: false });
  }
}

/**
 * 执行一次发送；成功登记自发消息，失败取回错误分类而不记日志。
 *
 * @param chatId 目标会话 ID
 * @param execute 实际发起 Telegram API 调用的回调
 * @param signal 取消信号
 * @returns 本次发送结果分类
 */
async function send(
  chatId: number,
  execute: (signal?: AbortSignal) => Promise<Message | Message[]>,
  signal: AbortSignal
): Promise<CronDeliveryOutcome> {
  let failure: unknown;
  const sent: true | undefined = await runTelegramAction({
    action: "send a cron message",
    execute,
    map: (messages: Message | Message[]): true => {
      if (Array.isArray(messages)) {
        for (const message of messages) recordSentMessage(chatId, message);
      } else recordSentMessage(chatId, messages);
      return true;
    },
    fallback: undefined,
    signal,
    shouldLogError: (error: unknown): boolean => {
      failure = error;
      return false;
    },
    selfSentChatId: chatId,
  });
  if (sent !== undefined) return { kind: "sent" };
  if (signal.aborted) return { kind: "aborted" };
  return classifyFailure(failure);
}

/**
 * 本地文件的上传源：先确认仍是不超过上限的普通文件；每次序列化都重新打开一条流，
 * 429 重放或重试不会拿到已读完的流。
 *
 * @param path 本地文件绝对路径
 * @param maxBytes 允许上传的最大字节数
 * @returns 可重开的文件上传源，或永久失败结果
 */
async function localUpload(path: string, maxBytes: number): Promise<InputFile | CronDeliveryOutcome> {
  let size: number;
  try {
    const stats: Stats = await Bun.file(path).stat();
    if (!stats.isFile()) return { kind: "permanent", detail: `local file ${basename(path)} is no longer a regular file` };
    size = stats.size;
  } catch {
    return { kind: "permanent", detail: `local file ${basename(path)} is missing` };
  }
  if (size > maxBytes) {
    return { kind: "permanent", detail: `local file ${basename(path)} exceeds the Telegram upload limit of ${maxBytes} bytes` };
  }
  return new InputFile((): ReadableStream<Uint8Array> => Bun.file(path).stream(), basename(path));
}

/**
 * 异步抽取单张图片并归一化图库错误，缺省目录使用专用图库。
 *
 * @param directory 随机图库目录路径；`null` 表示使用默认随机色图目录
 * @returns 抽取出的图片上传源，或永久失败结果
 */
async function randomImageInput(directory: string | null): Promise<InputFile | CronDeliveryOutcome> {
  const pick: RandomImagePick = await pickRandomImage(directory ?? getAssetConfig().randomHImageDirectory);
  switch (pick.status) {
    case "ok":
      return new InputFile(pick.bytes, pick.fileName);
    case "missingDirectory":
      return { kind: "permanent", detail: "the random image directory is missing" };
    case "empty":
      return { kind: "permanent", detail: "the random image directory has no pictures" };
    case "tooLarge":
      return {
        kind: "permanent",
        detail: `the random image directory has no picture under the Telegram upload limit (last oversized: ${pick.fileName})`,
      };
  }
}

/**
 * 整组预检后才提交请求；本地来源逐个异步 stat，只保留可重开的流 supplier。
 *
 * @param source 定时图片动作的数据源
 * @param signal 取消信号
 * @returns 预检通过的图片输入数组，或投递失败/取消结果
 */
async function imageInputs(
  source: CronImageSource,
  signal: AbortSignal
): Promise<(string | InputFile)[] | CronDeliveryOutcome> {
  if (signal.aborted) return { kind: "aborted" };
  if (source.kind === "urls") return [...source.urls];
  if (source.kind === "random") {
    const photo: InputFile | CronDeliveryOutcome = await randomImageInput(source.directory);
    return isOutcome(photo) ? photo : [photo];
  }
  const photos: (string | InputFile)[] = [];
  for (const path of source.paths) {
    if (signal.aborted) return { kind: "aborted" };
    const photo: InputFile | CronDeliveryOutcome = await localUpload(path, TELEGRAM_PHOTO_UPLOAD_MAX_BYTES);
    if (isOutcome(photo)) return photo;
    photos.push(photo);
  }
  return photos;
}

/**
 * 解析文件来源：地址原样交给 Telegram，本地文件转成上传源。
 *
 * @param source 定时文件动作的数据源
 * @returns URL 字符串、本地文件上传源，或永久失败结果
 */
async function fileInput(source: CronFileSource): Promise<string | InputFile | CronDeliveryOutcome> {
  return source.kind === "url" ? source.url : localUpload(source.path, TELEGRAM_DOCUMENT_UPLOAD_MAX_BYTES);
}

/**
 * 解析出的上传源是否其实是一个失败结果。
 *
 * @param value 待判定的上传源或投递结果
 * @returns 是否为投递失败/取消结果
 */
function isOutcome(value: string | InputFile | CronDeliveryOutcome): value is CronDeliveryOutcome {
  return typeof value === "object" && !(value instanceof InputFile);
}

/**
 * 合成失败的分类：能力缺席、每日额度用尽与编码失败不重试；Worker 暂不可用（重建中）、
 * 供应商没交回音频与等待超时可重试。
 *
 * @param reason 语音合成失败原因
 * @returns 投递结果分类
 */
function classifySynthesisFailure(reason: VoiceSynthesisFailure): CronDeliveryOutcome {
  switch (reason) {
    case "aborted":
      return { kind: "aborted" };
    case "worker unavailable":
    case "synthesis failed":
    case "timed out":
      return { kind: "retryable", detail: `speech synthesis failed: ${reason}` };
    default:
      return { kind: "permanent", detail: `speech synthesis failed: ${reason}` };
  }
}

/**
 * 取本轮已合成的语音，没有时合成一次并登记；失败返回分类结果。
 *
 * @param action 定时语音动作配置
 * @param voices 本轮已合成语音的缓存表
 * @param signal 取消信号
 * @returns 本轮语音缓存条目，或投递失败/取消结果
 */
async function roundVoice(
  action: Readonly<Extract<CronAction, { readonly type: "send_voice" }>>,
  voices: CronRoundVoices,
  signal: AbortSignal
): Promise<CronRoundVoice | CronDeliveryOutcome> {
  const cached: CronRoundVoice | undefined = voices.get(action);
  if (cached !== undefined) return cached;
  const result: VoiceSynthesisResult = await synthesizeVoice({ text: action.content, tone: action.tone, signal });
  if (!result.ok) return classifySynthesisFailure(result.reason);
  const entry: CronRoundVoice = { voice: result.voice, fileId: undefined };
  voices.set(action, entry);
  return entry;
}

/**
 * 组稿失败的分类：Worker 暂不可用、等待超时、检索或组稿请求失败可重试；
 * 没有对话能力、Anthropic 模型拒答、没有来源与重试后仍不合格不重试。分类只依据失败原因，不读取搜索次数。
 *
 * @param reason 网页摘要组稿失败原因
 * @returns 投递结果分类
 */
function classifyDigestFailure(reason: WebDigestFailure): CronDeliveryOutcome {
  switch (reason) {
    case "aborted":
      return { kind: "aborted" };
    case "worker unavailable":
    case "timed out":
    case "search failed":
    case "compose failed":
      return { kind: "retryable", detail: `web digest composition failed: ${reason}` };
    default:
      return { kind: "permanent", detail: `web digest composition failed: ${reason}` };
  }
}

/**
 * 取本轮已生成的摘要，没有时生成一次并登记；失败返回分类结果。
 *
 * @param action 定时网页摘要动作配置
 * @param digests 本轮已生成摘要的缓存表
 * @param signal 取消信号
 * @returns MarkdownV2 摘要正文，或投递失败/取消结果
 */
async function roundDigest(
  action: Readonly<Extract<CronAction, { readonly type: "send_web_digest" }>>,
  digests: CronRoundDigests,
  signal: AbortSignal
): Promise<string | CronDeliveryOutcome> {
  const cached: string | undefined = digests.get(action);
  if (cached !== undefined) return cached;
  const result: WebDigestCompositionResult = await composeWebDigest({
    topic: action.topic,
    language: action.language,
    maxItems: action.maxItems,
    instructions: action.instructions,
  }, signal);
  if (!result.ok) return classifyDigestFailure(result.reason);
  digests.set(action, result.text);
  return result.text;
}

/**
 * 发一条语音：已有本轮 file_id 时引用它，否则上传字节并在成功后记下交回的 file_id。
 *
 * @param chatId 目标会话 ID
 * @param entry 本轮语音缓存条目
 * @param requestSignal 单次请求取消信号
 * @returns Telegram 返回的已发送语音消息
 */
async function sendRoundVoice(
  chatId: number,
  entry: CronRoundVoice,
  requestSignal: AbortSignal | undefined
): Promise<Message> {
  const voice: EncodedVoiceMessage = entry.voice;
  const message: Message = await bot.api.sendVoice(
    chatId,
    entry.fileId ?? new InputFile(voice.bytes, voice.fileName),
    { duration: voice.durationSeconds },
    telegramSignal(requestSignal)
  );
  entry.fileId ??= message.voice?.file_id;
  return message;
}

/** 单次定时动作投递的目标会话、动作定义与轮内复用缓存。 */
export interface DeliverCronActionOptions {
  /** 目标会话 ID */
  readonly chatId: number;
  /** 待投递的定时动作 */
  readonly action: Readonly<CronAction>;
  /** 取消在途请求与合成（停机超时）。 */
  readonly signal: AbortSignal;
  /** 本轮已合成的语音；send_voice 从这里复用或登记。 */
  readonly voices: CronRoundVoices;
  /** 本轮已组稿的摘要；send_web_digest 从这里复用或登记。 */
  readonly digests: CronRoundDigests;
}

/**
 * 向一个会话投递一个动作一次。`rand_image` 每次调用都重新抽取；抽不出或本地文件不可用
 * 按不可重试失败返回。`send_voice` 本轮首次投递时合成，之后复用；首次发送成功后改用 file_id。
 * `send_web_digest` 本轮首次投递时生成摘要，之后复用同一段 MarkdownV2 原文。
 *
 * @param options 定时动作投递上下文（含目标会话 `chatId`、动作 `action`、取消信号 `signal` 及本轮语音/摘要缓存）。
 * @returns 本次投递结果分类（`sent`、`aborted`、`transient` 或 `permanent`）。
 */
export async function deliverCronAction({
  chatId,
  action,
  signal,
  voices,
  digests,
}: DeliverCronActionOptions): Promise<CronDeliveryOutcome> {
  if (signal.aborted) return { kind: "aborted" };
  switch (action.type) {
    case "send_message":
      return send(chatId, (requestSignal?: AbortSignal): Promise<Message> => bot.api.sendMessage(
        chatId,
        action.content,
        undefined,
        telegramSignal(requestSignal)
      ), signal);
    case "send_image": {
      const photos: (string | InputFile)[] | CronDeliveryOutcome = await imageInputs(action.source, signal);
      if (signal.aborted) return { kind: "aborted" };
      if (!Array.isArray(photos)) return photos;
      if (photos.length > 1) {
        const media: InputMediaPhoto[] = [];
        for (let index: number = 0; index < photos.length; index++) {
          media.push({
            type: "photo",
            media: photos[index]!,
            caption: index === 0 ? action.content : undefined,
            has_spoiler: action.isBlurred ? true : undefined,
          });
        }
        return send(chatId, (requestSignal?: AbortSignal): Promise<Message[]> => bot.api.sendMediaGroup(
          chatId, media, undefined, telegramSignal(requestSignal)
        ), signal);
      }
      return send(chatId, (requestSignal?: AbortSignal): Promise<Message> => bot.api.sendPhoto(
        chatId,
        photos[0]!,
        { caption: action.content, has_spoiler: action.isBlurred ? true : undefined },
        telegramSignal(requestSignal)
      ), signal);
    }
    case "send_file": {
      const document: string | InputFile | CronDeliveryOutcome = await fileInput(action.source);
      if (signal.aborted) return { kind: "aborted" };
      if (isOutcome(document)) return document;
      return send(chatId, (requestSignal?: AbortSignal): Promise<Message> => bot.api.sendDocument(
        chatId,
        document,
        { caption: action.content },
        telegramSignal(requestSignal)
      ), signal);
    }
    case "send_voice": {
      const entry: CronRoundVoice | CronDeliveryOutcome = await roundVoice(action, voices, signal);
      if (signal.aborted) return { kind: "aborted" };
      if ("kind" in entry) return entry;
      return send(chatId, (requestSignal?: AbortSignal): Promise<Message> =>
        sendRoundVoice(chatId, entry, requestSignal), signal);
    }
    case "send_web_digest": {
      const text: string | CronDeliveryOutcome = await roundDigest(action, digests, signal);
      if (signal.aborted) return { kind: "aborted" };
      if (typeof text !== "string") return text;
      return send(chatId, (requestSignal?: AbortSignal): Promise<Message> => bot.api.sendMessage(
        chatId,
        text,
        { parse_mode: MARKDOWN_V2_PARSE_MODE },
        telegramSignal(requestSignal)
      ), signal);
    }
  }
}
