import type { Message } from "grammy/types";
import { translateConfigReadiness } from "../config/readiness";
import { TELEGRAM_MESSAGE_MAX_CHARS } from "../consts/telegram";
import { TRANSLATE_CHAT_BACKLOG_MAX } from "../consts/translate";
import { getChatState } from "../infra/chatStateStorage";
import { sendMessage } from "../infra/telegram";
import { runOutsideUpdateScope, runWithUpdateAbortSignal } from "../infra/updateContext";
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
 * 在按群串行链内翻译 `source` 并仅发送译文：
 * - 以纯文本 `sendMessage` 发出（不带实体、不设 `parse_mode`，沿用原消息的 `link_preview_options`，绑定 `translateRuntime.controller.signal`），不附带原文或媒体。
 * - 信号已中止、API 失败、译文与原文完全一致、译文含可渲染命令（见 `libs/renderableCommand.ts`）或超出长度上限时静默跳过发送（API 异常由 `client.ts` 记录）。
 * - 发起翻译前与异步返回后各复核一次翻译会话引用，拦截停止或重开后的迟到结果。
 * @param params 翻译消息所属群聊、原消息、会话与话题参数。
 * @param source 入队前提取出的原文正文或图注字符串。
 * @param signal 绑定的翻译生命周期取消信号。
 */
async function translateMessage(
  params: TranslateMessageParams,
  source: string,
  signal: AbortSignal
): Promise<void> {
  const { chatId, message, state, messageThreadId }: TranslateMessageParams = params;
  if (signal.aborted || activeTranslateStateIn(getChatState(chatId), state.translatedUser.id) !== state) return;
  const translated: string | null = await translateText(source, state.language);
  if (signal.aborted || activeTranslateStateIn(getChatState(chatId), state.translatedUser.id) !== state) return;
  if (translated === null || translated === source || translated.length > TELEGRAM_MESSAGE_MAX_CHARS) return;
  if (containsRenderableCommand(translated)) return;
  await sendMessage({ chatId, text: translated, messageThreadId, linkPreviewOptions: message.link_preview_options });
}

/**
 * 将翻译目标的消息经 `runOutsideUpdateScope` 脱离触发 update 上下文并投入按群串行的后台翻译链后立即返回，
 * 执行期间改绑定 `translateRuntime.controller.signal`，既不阻塞串行 update 循环且保证同群译文按序发出，也不被触发 update 中止误伤。
 *
 * - **入队过滤**：正文与图注统一按纯文本处理（带图注的媒体仅翻译图注）；无文字载荷、含可渲染命令或 `needsNoTranslation` 命中的消息在入队前直接跳过。
 * - **积压上限**：本群在途与排队总数达到 `TRANSLATE_CHAT_BACKLOG_MAX` 时丢弃新消息，同一段满载周期只记录一次错误日志。
 * - **停机追踪**：任务登记在 `translateRuntime.tasks` 供停机阶段 `drainTranslate` 等待；非取消异常记错误日志。
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
        "Translation backlog reached capacity; new messages are not translated while it stays full.",
        { chatId, limit: TRANSLATE_CHAT_BACKLOG_MAX }
      );
    }
    return;
  }
  backlog.count++;
  const entry: TranslateMessageBacklog = backlog;
  const signal: AbortSignal = translateRuntime.controller.signal;
  void trackInflight(
    translateRuntime.tasks,
    runOutsideUpdateScope((): Promise<void> =>
      translateMessageRunner.run(chatId, (): Promise<void> =>
        runWithUpdateAbortSignal(signal, async (): Promise<void> => {
          try {
            await translateMessage(params, source, signal);
          } catch (error: unknown) {
            if (!isAbortError(error)) logger.error("Failed to translate a message:", { chatId }, error);
          } finally {
            entry.count--;
            if (entry.count === 0 && translateMessageBacklogs.get(chatId) === entry) translateMessageBacklogs.delete(chatId);
          }
        })
      )
    )
  );
}
