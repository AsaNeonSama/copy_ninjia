/**
 * `/send` 代发会话中的 TTS 语音代发：
 * - **识别规则**：超管私聊发送覆盖全文的单一 `pre` 代码块，且内容按 JSONC 解析为
 *   `{ "type": "tts", "tone"?: string, "text": string }` 时，经 `aiChat/voiceSynthesis.ts` 合成语音并发往目标群
 *   （`tone` 拼接在基础朗读风格之后）。非整条代码块、非合法 JSONC 或 `type !== "tts"` 的消息返回 `none`，照常原样代发。
 * - **校验与异步执行**：`type === "tts"` 但字段或长度不合法时按格式错误拒绝；接纳后提交给 `commands/deferredCommands.ts`
 *   后台合成与发送，不阻塞当前 update（队列满时提示稍后再试）。
 * - **错误反馈**：`agent.tts` 未配置、每日预留额度（`agent.tts.daily_reserve_quota`，与 cron 共用）耗尽、
 *   合成期间代发会话或目标群 `/init` 已关闭，或合成/发送失败时，经 `sendProxyTtsNotice` 在私聊回复提示（不挂延迟删除）。
 */

import type { Message, MessageEntity } from "grammy/types";
import { synthesizeVoice } from "../../aiChat";
import { submitDeferredCommand } from "../../commands/deferredCommands";
import { agentTtsConfig } from "../../config/agent";
import {
  VOICE_OPERATOR_TEXT_MAX_CHARS,
  VOICE_TONE_MAX_CHARS,
} from "../../consts/aiChat/voiceMessage";
import { PROXY_TTS_REQUEST_KEYS, PROXY_TTS_REQUEST_TYPE } from "../../consts/proxySend";
import { chatAtmosphere } from "../../infra/atmosphere";
import { getActiveProxySendTarget, getChatState } from "../../infra/chatStateStorage";
import { logger } from "../../infra/logger";
import { sendMessage, sendVoiceWithResult } from "../../infra/telegram";
import { currentUpdateAbortSignal } from "../../infra/updateContext";
import { hasOnlyKeys, isPlainRecord } from "../../libs/record";
import { sanitizeInline } from "../../libs/text";
import type { VoiceSynthesisFailure, VoiceSynthesisResult } from "../../types/aiChat/voiceMessage";
import type { AgentTtsCapabilityConfig } from "../../types/config";
import type { AtmosphereNotices } from "../../types/atmosphereNotices";
import type { ProxyTtsRequest } from "../../types/proxySend";
import type { TelegramSendResult } from "../../types/telegram";

/** 一次已接纳的 TTS 代发。 */
interface ProxyTtsDelivery {
  /** 超级管理员私聊会话 ID */
  readonly privateChatId: number;
  /** 代发目标群聊 ID */
  readonly targetChatId: number;
  /** 待合成的台词文本 */
  readonly text: string;
  /** 合成语气说明；未指定时为 `undefined` */
  readonly tone: string | undefined;
}

/**
 * 清洗成单行并去掉首尾空白；非空且不超过上限时返回，否则返回 undefined。
 *
 * @param value 原始字段值
 * @param maxChars 最大允许字符数
 * @returns 规范化后的单行文本；非法或超长时返回 `undefined`
 */
function boundedLine(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const line: string = sanitizeInline(value).trim();
  return line.length > 0 && line.length <= maxChars ? line : undefined;
}

/**
 * 判断消息正文是否由单一 `pre` 实体完整覆盖。
 *
 * @param text 消息正文
 * @param entities 消息实体数组
 * @returns 是否为覆盖全文的单一 `pre` 代码块
 */
function isWholeCodeBlock(text: string, entities: readonly MessageEntity[] | undefined): boolean {
  if (entities?.length !== 1) return false;
  const entity: MessageEntity = entities[0]!;
  return entity.type === "pre" && entity.offset === 0 && entity.length === text.length;
}

/**
 * 解析私聊消息是否为 `/send` TTS 请求：`text` 必填、`tone` 可选；两者清洗为单行后均须非空，
 * 且分别不超过 `VOICE_OPERATOR_TEXT_MAX_CHARS` 与 `VOICE_TONE_MAX_CHARS`。
 *
 * @param message 入站私聊消息
 * @returns 解析出的 TTS 代发请求结果（`none`、`invalid` 或 `tts`）
 */
export function parseProxyTtsRequest(message: Message): ProxyTtsRequest {
  const content: string | undefined = message.text;
  if (content === undefined || !isWholeCodeBlock(content, message.entities)) return { kind: "none" };
  let value: unknown;
  try {
    value = Bun.JSONC.parse(content);
  } catch {
    return { kind: "none" };
  }
  if (!isPlainRecord(value) || value.type !== PROXY_TTS_REQUEST_TYPE) return { kind: "none" };
  if (!hasOnlyKeys(value, PROXY_TTS_REQUEST_KEYS)) return { kind: "invalid" };
  const text: string | undefined = boundedLine(value.text, VOICE_OPERATOR_TEXT_MAX_CHARS);
  if (text === undefined) return { kind: "invalid" };
  if (value.tone === undefined) return { kind: "tts", text, tone: undefined };
  const tone: string | undefined = boundedLine(value.tone, VOICE_TONE_MAX_CHARS);
  return tone === undefined ? { kind: "invalid" } : { kind: "tts", text, tone };
}

/**
 * 给超管私聊回一句 TTS 代发提示；私聊提示不挂延迟删除。
 *
 * @param privateChatId 超级管理员私聊会话 ID
 * @param text 提示文本
 */
async function sendProxyTtsNotice(privateChatId: number, text: string): Promise<void> {
  await sendMessage({ chatId: privateChatId, text });
}

/**
 * 合成失败时给超管的提示。额度用尽时写明主线程当前生效的 `agent.tts.daily_reserve_quota`；这时
 * `agent.tts` 已被热重载移除则按未配置提示。
 *
 * @param targetChatId 代发目标群聊 ID
 * @param reason 语音合成失败原因
 * @returns 发送给超级管理员的失败提示文本
 */
function synthesisFailureNotice(targetChatId: number, reason: VoiceSynthesisFailure): string {
  const notices: AtmosphereNotices = chatAtmosphere().NOTICE_TEXTS;
  if (reason === "tts unconfigured") return notices.proxyTtsUnconfigured;
  if (reason !== "daily limit reached") return notices.proxyTtsFailed(targetChatId);
  const tts: AgentTtsCapabilityConfig | undefined = agentTtsConfig();
  return tts === undefined ? notices.proxyTtsUnconfigured : notices.proxyTtsDailyLimit(tts.dailyReserveQuota);
}

/**
 * 读取可选 `AbortSignal` 的取消态，避免控制流收窄掩盖异步等待期间的取消。
 *
 * @param signal 可选的取消信号
 * @returns 信号已取消时返回 `true`
 */
function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * 延迟执行器里的一次合成与发送；取消时静默收尾，合成期间若 `/send` 会话或目标群 `/init`
 * 已关闭则放弃发送并私聊告知超管，其余失败回一句提示。
 *
 * @param params 已接纳的私聊 `/send` TTS 代发任务（含发起私聊 `privateChatId`、目标群 `targetChatId`、待合成正文 `text` 与语气 `tone`）。
 */
async function deliverProxyTts({ privateChatId, targetChatId, text, tone }: ProxyTtsDelivery): Promise<void> {
  const signal: AbortSignal | undefined = currentUpdateAbortSignal();
  const result: VoiceSynthesisResult = await synthesizeVoice({ text, tone, signal });
  if (!result.ok) {
    if (result.reason === "aborted") return;
    logger.error("/send TTS produced no voice.", {
      chatId: targetChatId,
      reason: result.reason,
    });
    await sendProxyTtsNotice(privateChatId, synthesisFailureNotice(targetChatId, result.reason));
    return;
  }
  if (isSignalAborted(signal)) return;
  if (
    getActiveProxySendTarget() !== targetChatId ||
    getChatState(targetChatId).isInitEnabled !== true
  ) {
    await sendProxyTtsNotice(
      privateChatId,
      chatAtmosphere().NOTICE_TEXTS.proxyTtsTargetInactive(targetChatId)
    );
    return;
  }
  // 代发的目标是整个群，与 copyMessage 一样不带话题，落在 General。
  const sent: TelegramSendResult | undefined = await sendVoiceWithResult({
    chatId: targetChatId,
    bytes: result.voice.bytes,
    fileName: result.voice.fileName,
    signal,
    duration: result.voice.durationSeconds,
  });
  if (sent !== undefined || isSignalAborted(signal)) return;
  await sendProxyTtsNotice(privateChatId, chatAtmosphere().NOTICE_TEXTS.proxyTtsFailed(targetChatId));
}

/**
 * 处理一条已判定为 TTS 的代发消息：格式错误或 `agent.tts` 未配置时回提示，否则交给
 * 延迟执行器；执行器满时回「稍后再试」。
 *
 * @param message 入站私聊消息
 * @param targetChatId 代发目标群聊 ID
 * @param request 已识别的 TTS 请求（有效或格式错误）
 */
export async function handleProxyTtsRequest(
  message: Message,
  targetChatId: number,
  request: Exclude<ProxyTtsRequest, { readonly kind: "none" }>
): Promise<void> {
  const privateChatId: number = message.chat.id;
  if (request.kind === "invalid") {
    await sendProxyTtsNotice(
      privateChatId,
      chatAtmosphere().NOTICE_TEXTS.proxyTtsUsage(VOICE_OPERATOR_TEXT_MAX_CHARS, VOICE_TONE_MAX_CHARS)
    );
    return;
  }
  if (agentTtsConfig() === undefined) {
    await sendProxyTtsNotice(privateChatId, chatAtmosphere().NOTICE_TEXTS.proxyTtsUnconfigured);
    return;
  }
  const delivery: ProxyTtsDelivery = { privateChatId, targetChatId, text: request.text, tone: request.tone };
  const accepted: boolean = submitDeferredCommand({
    priority: "interactive",
    task: (): Promise<void> => deliverProxyTts(delivery),
    errorLabel: "Unexpected error while processing a /send TTS request:",
  });
  if (!accepted) await sendProxyTtsNotice(privateChatId, chatAtmosphere().NOTICE_TEXTS.proxyTtsBusy);
}
