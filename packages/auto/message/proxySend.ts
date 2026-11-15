import { chatAtmosphere } from "../../infra/atmosphere";
import type { Message } from "grammy/types";
import { SUPER_ADMIN_USER_ID } from "../../config/bot";
import {
  disableChatStateSwitch,
  getActiveProxySendTarget,
  persistChatState,
} from "../../infra/chatStateStorage";
import { copyMessage, sendMessage } from "../../infra/telegram";
import { handleProxyTtsRequest, parseProxyTtsRequest } from "./proxyTts";
import type { ProxyTtsRequest } from "../../types/proxySend";

/**
 * 处理私聊中的超级管理员 `/send` 代发会话：整条代码块形式的 TTS 请求交由 `./proxyTts.ts`
 * 合成语音代发，其余消息原样复制到目标群。
 *
 * 本函数开头是「私聊是否进入 `/send` 代发」（超管身份与活动目标群）的唯一判定边界，
 * 调用方（`auto/message/index.ts` 私聊分支）直接转发至此，不在外层重复判定。
 *
 * @param message 入站私聊消息
 */
export async function handlePrivateProxySend(message: Message): Promise<void> {
  if (message.chat.type !== "private" || message.from?.id !== SUPER_ADMIN_USER_ID) return;
  const targetChatId: number | undefined = getActiveProxySendTarget();
  if (targetChatId === undefined) return;

  const ttsRequest: ProxyTtsRequest = parseProxyTtsRequest(message);
  if (ttsRequest.kind !== "none") {
    await handleProxyTtsRequest(message, targetChatId, ttsRequest);
    return;
  }

  // 中转的目标是整个群，`/send <群id>` 没有话题入参，落在 General。
  const copiedMessageId: number | undefined = await copyMessage({
    chatId: targetChatId,
    fromChatId: message.chat.id,
    messageId: message.message_id,
  });
  if (copiedMessageId !== undefined) return;

  // 转发失败立即结束会话。
  disableChatStateSwitch(targetChatId, "isProxySendEnabled");
  await persistChatState(targetChatId, "proxy send failed");
  await sendMessage({
    chatId: message.chat.id,
    text: chatAtmosphere().NOTICE_TEXTS.proxyFailed(targetChatId),
  });
}
