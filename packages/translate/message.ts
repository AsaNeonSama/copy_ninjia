import type { Message } from "grammy/types";
import { translateConfigReadiness } from "../config/readiness";
import { TELEGRAM_MESSAGE_MAX_CHARS } from "../consts/telegram";
import { TRANSLATE_CHAT_BACKLOG_MAX } from "../consts/translate";
import { getChatState } from "../infra/storage/stateStore";
import { sendMessage } from "../infra/telegram";
import { translateMessageBacklogs, translateMessageRunner, translateRuntime } from "../cache/main/translate";
import { logger } from "../infra/logger";
import { isAbortError } from "../libs/abortSignal";
import { trackInflight } from "../libs/inflight";
import { containsRenderableCommand } from "../libs/renderableCommand";
import type { ChatState } from "../types/chatState";
import type { TranslateMessageBacklog, TranslateState } from "../types/translate";
import { translateText } from "./client";
import { needsNoTranslation } from "./language";
import { translateStateIn } from "./state";

/**
 * 本群开关和配置前提齐备时返回指定目标的现有会话；无会话时不查询其它状态。
 * @param chatState 当前群聊的状态快照。
 * @param userId 待查询的发送者用户 ID。
 * @returns 翻译功能已启用且配置就绪时返回该用户的翻译会话，否则返回 undefined。
 */
export function activeTranslateStateIn(chatState: Readonly<ChatState>, userId: number): TranslateState | undefined {
  const state: TranslateState | undefined = translateStateIn(chatState, userId);
  if (state === undefined || chatState.isTranslationEnabled !== true) return undefined;
  return translateConfigReadiness().ok ? state : undefined;
}

/** queueTranslateMessage 的入参；当前会话对象同时是取消凭据，不依赖全局 copy 目标。 */
export interface TranslateMessageParams {
  /** 消息所属的群聊 ID。 */
  readonly chatId: number;
  /** 翻译目标发出的原消息；只读取正文或图注，以及正文消息的链接预览设置。 */
  readonly message: Message;
  /** 入队时命中的翻译会话对象（同时作为会话有效性的引用凭据）。 */
  readonly state: TranslateState;
  /** 论坛话题；翻译不挂回复，必须显式带上。 */
  readonly messageThreadId?: number;
}

/**
 * 在按群串行链里翻译 source（入队时取出的正文或图注）并只发送译文：按纯文字 sendMessage 发出
 * （不带实体、不设 parse_mode，正文消息的 link_preview_options 原样沿用），不发送原文，也不复制
 * 图片、文件等媒体。翻译 API 失败、译文与原文逐字相同、译文含可渲染命令（见
 * libs/renderableCommand.ts）或超过正文长度上限时整条不发送，对发送者静默；只有 API 异常由
 * client.ts 记错误日志。开始前与异步完成后各复核一次会话，停止或重开后的迟到结果不发送。
 * @param params 翻译消息所属群聊、原消息、会话与话题参数。
 * @param source 入队前提取出的原文正文或图注字符串。
 */
async function translateMessage(params: TranslateMessageParams, source: string): Promise<void> {
  const { chatId, message, state, messageThreadId }: TranslateMessageParams = params;
  if (activeTranslateStateIn(getChatState(chatId), state.translatedUser.id) !== state) return;
  const translated: string | null = await translateText(source, state.language);
  if (activeTranslateStateIn(getChatState(chatId), state.translatedUser.id) !== state) return;
  if (translated === null || translated === source || translated.length > TELEGRAM_MESSAGE_MAX_CHARS) return;
  if (containsRenderableCommand(translated)) return;
  await sendMessage({ chatId, text: translated, messageThreadId, linkPreviewOptions: message.link_preview_options });
}

/**
 * 把翻译目标的一条消息交给按群串行的后台链后立即返回：串行的 update 循环不等 Google RPC 与译文
 * 发送，同群译文仍按收到顺序发出。
 *
 * 正文与图注一律按字符串处理，带链接、@ 或格式实体的文字照常翻译，带图注的媒体只翻译图注。既无
 * 正文也无图注（贴纸、不带图注的图片与文件等）、原文含可渲染命令或同语种与中性文字
 * （needsNoTranslation 命中）的消息在入队前直接跳过：不调用翻译、不计入积压、不回提示。本群积压
 * （含正在执行的那条）已达 TRANSLATE_CHAT_BACKLOG_MAX 时本条不翻译，同一段积压只记一次日志。
 * 任务登记在 translateRuntime.tasks，由停机 drainTranslate 等待；失败只记日志，update 取消导致的
 * 中止不记。
 * @param params 翻译消息所属群聊、原消息、会话与话题参数。
 */
export function queueTranslateMessage(params: TranslateMessageParams): void {
  const source: string | undefined = params.message.text ?? params.message.caption;
  if (source === undefined || containsRenderableCommand(source) || needsNoTranslation(source, params.state.language)) {
    return;
  }
  const chatId: number = params.chatId;
  let backlog: TranslateMessageBacklog | undefined = translateMessageBacklogs.get(chatId);
  if (backlog === undefined) {
    backlog = { count: 0, overflowLogged: false };
    translateMessageBacklogs.set(chatId, backlog);
  } else if (backlog.count >= TRANSLATE_CHAT_BACKLOG_MAX) {
    if (!backlog.overflowLogged) {
      backlog.overflowLogged = true;
      logger.error(
        `Translation backlog in chat ${chatId} reached ${TRANSLATE_CHAT_BACKLOG_MAX} messages; ` +
        "new messages are not translated while it stays full."
      );
    }
    return;
  }
  backlog.count++;
  const entry: TranslateMessageBacklog = backlog;
  void trackInflight(
    translateRuntime.tasks,
    translateMessageRunner.run(chatId, async (): Promise<void> => {
      try {
        await translateMessage(params, source);
      } catch (error: unknown) {
        if (!isAbortError(error)) logger.error(`Failed to translate a message in chat ${chatId}:`, error);
      } finally {
        entry.count--;
        if (entry.count === 0 && translateMessageBacklogs.get(chatId) === entry) translateMessageBacklogs.delete(chatId);
      }
    })
  );
}
