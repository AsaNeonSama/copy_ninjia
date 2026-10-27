import type {
  MiniAppPickerSubjectKind,
  MiniAppPickerTargetList,
  MiniAppTranslateLanguage,
  PrepareMiniAppPickerResult,
} from "../types/miniApp";
import { miniAppFetchJson } from "./request";

/** `requestMiniAppPreparedPicker` 的群内目标可选参数。 */
export interface RequestMiniAppPreparedPickerOptions {
  /** 当 `targetList` 为 `"deleteMessage"` 或 `"translate"` 时所属的目标群 ID。 */
  readonly chatId?: number;
  /** 当 `targetList` 为 `"translate"` 时为所选身份设置的目标语言。 */
  readonly language?: MiniAppTranslateLanguage;
}

/**
 * 调用 `POST ./api/picker/prepare` 请求后端生成 `savePreparedKeyboardButton` 原生好友/联系人/频道选择器会话。
 * @param targetList 目标名单（`"whitelist"`、`"blocklist"`、`"deleteMessage"` 或 `"translate"`）
 * @param subjectKind 目标身份类型（`"users"` 或 `"channel"`）
 * @param options 群内目标管理可选参数（`chatId` 与 `language`）
 * @returns 预备选择器会话信息
 */
export async function requestMiniAppPreparedPicker(
  targetList: MiniAppPickerTargetList,
  subjectKind: MiniAppPickerSubjectKind,
  options?: Readonly<RequestMiniAppPreparedPickerOptions>
): Promise<Extract<PrepareMiniAppPickerResult, { readonly ok: true }>> {
  return miniAppFetchJson("./api/picker/prepare", {
    method: "POST",
    body: JSON.stringify({
      targetList,
      subjectKind,
      ...(options?.chatId !== undefined ? { chatId: options.chatId } : {}),
      ...(options?.language !== undefined ? { language: options.language } : {}),
    }),
  });
}
