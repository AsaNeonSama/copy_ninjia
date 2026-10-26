import type { KeyboardButton } from "grammy/types";
import { miniAppPendingPickers, miniAppPickerSequence } from "../../cache/main/miniApp";
import { SUPER_ADMIN_USER_ID } from "../../config/bot";
import { MINI_APP_PICKER_MAX_USERS_QUANTITY } from "../../consts/miniApp";
import { saveMiniAppPreparedKeyboardButton } from "../../infra/telegram/actions/miniApp";
import type { MiniAppTelegramApi } from "../../infra/telegram/actions/miniApp";
import type {
  MiniAppPickerSubjectKind,
  MiniAppPickerTargetList,
  MiniAppPreparedPickerSession,
  PrepareMiniAppPickerResult,
} from "../../types/miniApp";
import { pruneExpiredMiniAppPickers } from "./sessions";

/** `prepareMiniAppPicker` 的入参。 */
export interface PrepareMiniAppPickerParams {
  /** 选定后写入的目标名单（`"whitelist"` 或 `"blocklist"`）。 */
  readonly targetList: MiniAppPickerTargetList;
  /** 选择器目标类型（`"users"` 好友/联系人，或 `"channel"` 频道）。 */
  readonly subjectKind: MiniAppPickerSubjectKind;
  /** 可选的 Telegram API 替身（供测试注入）。 */
  readonly api?: Pick<MiniAppTelegramApi, "savePreparedKeyboardButton">;
}

/**
 * 分配下一个 32 位正有符号整数 `request_id`（`1..0x7fffffff`）。
 * @returns 分配出的正整数请求 ID。
 */
function nextPickerRequestId(): number {
  const next: number = (miniAppPickerSequence.current % 0x7fffffff) + 1;
  miniAppPickerSequence.current = next;
  return next;
}

/**
 * 构造原生选择器按钮：好友/联系人使用 `request_users`（不含 Bot、带姓名与用户名），频道使用 `request_chat`（带标题与用户名）。
 * @param requestId 本次选择器会话的请求 ID。
 * @param targetList 选定后写入的目标名单。
 * @param subjectKind 选择器目标类型。
 * @returns 供 `savePreparedKeyboardButton` 预存的按钮。
 */
function buildPickerButton(
  requestId: number,
  targetList: MiniAppPickerTargetList,
  subjectKind: MiniAppPickerSubjectKind
): KeyboardButton.RequestUsersButton | KeyboardButton.RequestChatButton {
  const listLabel: string = targetList === "whitelist" ? "白名单" : "黑名单";
  return subjectKind === "users"
    ? {
      text: `选择好友/联系人加入${listLabel}`,
      request_users: {
        request_id: requestId,
        user_is_bot: false,
        max_quantity: MINI_APP_PICKER_MAX_USERS_QUANTITY,
        request_name: true,
        request_username: true,
      },
    }
    : {
      text: `选择频道加入${listLabel}`,
      request_chat: {
        request_id: requestId,
        chat_is_channel: true,
        request_title: true,
        request_username: true,
      },
    };
}

/**
 * 调用 Telegram Bot API `savePreparedKeyboardButton` 生成供 `Telegram.WebApp.requestChat` 使用的预存按钮 ID，并登记待消费会话。
 * @param params 目标名单、选择器身份种类及可选 API 替身。
 * @returns 成功时返回 `requestId` 与 `preparedButtonId`，失败时返回错误提示。
 */
export async function prepareMiniAppPicker({
  targetList,
  subjectKind,
  api,
}: PrepareMiniAppPickerParams): Promise<Readonly<PrepareMiniAppPickerResult>> {
  const now: number = Date.now();
  pruneExpiredMiniAppPickers(now);

  const requestId: number = nextPickerRequestId();
  const preparedButtonId: string | undefined =
    await saveMiniAppPreparedKeyboardButton({
      userId: SUPER_ADMIN_USER_ID,
      button: buildPickerButton(requestId, targetList, subjectKind),
      api,
    });
  if (preparedButtonId === undefined || preparedButtonId.trim().length === 0) {
    return {
      ok: false,
      message: "PICKER_PREPARE_FAILED",
    };
  }

  const session: Readonly<MiniAppPreparedPickerSession> = {
    requestId,
    preparedButtonId: preparedButtonId.trim(),
    targetList,
    subjectKind,
    createdAt: now,
  };
  miniAppPendingPickers.set(requestId, session);

  return {
    ok: true,
    requestId,
    preparedButtonId: session.preparedButtonId,
  };
}
