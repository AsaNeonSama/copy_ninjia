import {
  miniAppCompletedPickerResults,
  miniAppPendingPickers,
  miniAppPickerSequence,
} from "../../cache/main/miniApp";
import { MINI_APP_PICKER_TTL_MS } from "../../consts/miniApp";
import type {
  MiniAppPickerResultEvent,
  MiniAppPreparedPickerSession,
} from "../../types/miniApp/identities";

/**
 * 清理已超过 `MINI_APP_PICKER_TTL_MS` 的待处理选择器会话与已完成回执。
 * @param now 当前毫秒时间戳。
 */
export function pruneExpiredMiniAppPickers(now: number = Date.now()): void {
  miniAppPendingPickers.forEach(
    (session: Readonly<MiniAppPreparedPickerSession>, requestId: number): void => {
      if (now - session.createdAt > MINI_APP_PICKER_TTL_MS) {
        miniAppPendingPickers.delete(requestId);
      }
    }
  );
  miniAppCompletedPickerResults.forEach(
    (result: Readonly<MiniAppPickerResultEvent>, requestId: number): void => {
      if (now - result.completedAt > MINI_APP_PICKER_TTL_MS) {
        miniAppCompletedPickerResults.delete(requestId);
      }
    }
  );
}

/**
 * 查询指定 `requestId` 的原生选择器导入结果回执（先清理过期会话与回执）。
 * @param requestId 预备会话请求 ID。
 * @returns 已完成时返回结果回执，尚未完成或不存在时返回 `null`。
 */
export function getMiniAppPickerResult(
  requestId: number
): Readonly<MiniAppPickerResultEvent> | null {
  pruneExpiredMiniAppPickers();
  return miniAppCompletedPickerResults.get(requestId) ?? null;
}

/**
 * 清空 Mini App 选择器的全部内存会话、回执与请求 ID 序号（停机或测试重置时调用）。
 */
export function resetMiniAppPickerState(): void {
  miniAppPendingPickers.clear();
  miniAppCompletedPickerResults.clear();
  miniAppPickerSequence.current = 0;
}
