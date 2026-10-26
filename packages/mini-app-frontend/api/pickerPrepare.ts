import type {
  MiniAppPickerSubjectKind,
  MiniAppPickerTargetList,
  PrepareMiniAppPickerResult,
} from "../types/miniApp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `POST ./api/picker/prepare` 请求后端生成 `savePreparedKeyboardButton` 原生好友/联系人/频道选择器会话。
 * @param targetList 目标名单（`"whitelist"` 或 `"blocklist"`）
 * @param subjectKind 目标身份类型（`"users"` 或 `"channel"`）
 * @returns 预备选择器会话信息
 */
export async function requestMiniAppPreparedPicker(
  targetList: MiniAppPickerTargetList, subjectKind: MiniAppPickerSubjectKind
): Promise<Extract<PrepareMiniAppPickerResult, { readonly ok: true }>> {
  return miniAppFetchJson("./api/picker/prepare", {
    method: "POST", body: JSON.stringify({ targetList, subjectKind }),
  });
}
