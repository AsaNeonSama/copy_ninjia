import { latestAiMemories } from "../../cache/main/aiChat";
import { VERBATIM_CONTEXT_MAX } from "../../consts/aiChat/memory";
import {
  MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE,
  MINI_APP_MESSAGES_MAX_PAGE_SIZE,
} from "../../consts/miniApp";
import { getChatState } from "../../infra/storage/stateStore";
import { parseAiMemorySnapshot } from "../../libs/persistedSnapshotCodec";
import type {
  AiMemorySnapshot,
  BufferedMessage,
} from "../../types/aiChat/memory";
import type { ChatState } from "../../types/chatState";
import type {
  MiniAppMessageItem,
  MiniAppMessagePage,
} from "../../types/miniApp";
import { formatManagedChatTitle } from "./chats/query";

/** `readManagedChatMessages` 的入参。 */
export interface ReadManagedChatMessagesParams {
  /** 目标群聊 ID。 */
  readonly chatId: number;
  /** 请求页码（从 1 开始，缺省为 1）。 */
  readonly page?: number;
  /** 每页条数（`1..MINI_APP_MESSAGES_MAX_PAGE_SIZE`，缺省为 `MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE`）。 */
  readonly pageSize?: number;
}

/**
 * 格式化发言人全名。
 * @param firstName 名。
 * @param lastName 姓。
 * @param id 发言人 ID。
 * @returns 非空的发言人展示名。
 */
function formatSpeakerName(
  firstName: string,
  lastName: string,
  id: number
): string {
  const combined: string = `${firstName} ${lastName}`.trim();
  return combined.length > 0 ? combined : `ID ${id}`;
}

/**
 * 将单条热缓冲区消息映射为 Mini App 前端展示项。
 * @param entry 热缓冲区消息。
 * @param index 在热缓冲区中的原始顺序索引。
 * @returns 前端展示消息项。
 */
function toMiniAppMessageItem(
  entry: Readonly<BufferedMessage>,
  index: number
): Readonly<MiniAppMessageItem> {
  return {
    index,
    userId: entry.id,
    name: formatSpeakerName(entry.firstName, entry.lastName, entry.id),
    username: entry.username,
    text: entry.text,
    at: entry.at,
    messageId: entry.messageId,
    forwardedFrom: entry.forwardedFrom,
    replyToMessageId: entry.replyTo?.messageId,
    replyToName:
      entry.replyTo === undefined
        ? undefined
        : formatSpeakerName(
          entry.replyTo.firstName,
          entry.replyTo.lastName,
          entry.replyTo.id
        ),
    replyToPreview: entry.replyTo?.quote ?? entry.replyTo?.text,
  };
}

/**
 * 读取指定已开启 `/init` 群聊的热 256 条发言记录并执行分页（严格忽略 `summaries` 与 `pendingSummary` 压缩记忆）。
 * @param params 群聊 ID、页码与每页条数。
 * @returns 分页后的热发言记录视图；该群未开启 `/init` 时返回 `null`。
 */
export function readManagedChatMessages({
  chatId,
  page = 1,
  pageSize = MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE,
}: ReadManagedChatMessagesParams): Readonly<MiniAppMessagePage> | null {
  const state: Readonly<ChatState> = getChatState(chatId);
  if (state.isInitEnabled !== true) return null;

  const normalizedPageSize: number = Math.min(
    MINI_APP_MESSAGES_MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(pageSize))
  );

  const rawSnapshot: string | undefined = latestAiMemories.get(chatId);
  let hotBuffer: readonly Readonly<BufferedMessage>[] = [];
  if (rawSnapshot !== undefined) {
    try {
      const parsed: AiMemorySnapshot = parseAiMemorySnapshot(
        rawSnapshot,
        `AI memory snapshot for chat ${chatId}`
      );
      hotBuffer = parsed.buffer.slice(-VERBATIM_CONTEXT_MAX);
    } catch (_error: unknown) {
      hotBuffer = [];
    }
  }

  const total: number = hotBuffer.length;
  const totalPages: number = Math.max(1, Math.ceil(total / normalizedPageSize));
  const normalizedPage: number = Math.min(
    totalPages,
    Math.max(1, Math.trunc(page))
  );

  const startOffset: number = (normalizedPage - 1) * normalizedPageSize;
  const endOffset: number = Math.min(total, startOffset + normalizedPageSize);
  const pageItems: Readonly<MiniAppMessageItem>[] = [];
  for (let offset: number = startOffset; offset < endOffset; offset++) {
    const idx: number = total - 1 - offset;
    const entry: Readonly<BufferedMessage> | undefined = hotBuffer[idx];
    if (entry !== undefined) {
      pageItems.push(toMiniAppMessageItem(entry, idx));
    }
  }

  return {
    chatId,
    title: formatManagedChatTitle(chatId, state),
    total,
    maxCapacity: VERBATIM_CONTEXT_MAX,
    page: normalizedPage,
    pageSize: normalizedPageSize,
    totalPages,
    items: pageItems,
  };
}
