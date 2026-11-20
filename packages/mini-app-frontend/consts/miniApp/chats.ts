/**
 * Mini App 前端受管群列表、热发言分页、功能开关、批量清理窗口与群目标管理容量常量。
 */

import type {
  MiniAppChatTargetKind,
  MiniAppFeatureKey,
  MiniAppTranslateLanguage,
} from "../../types/miniApp/chats";
import { exhaustiveList } from "../exhaustiveList";

/** 群热发言记录接口缺省每页返回的条数（10 条）。不变量：属于 `MINI_APP_MESSAGES_PAGE_SIZE_OPTIONS` 档位；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/store/messages.ts` 与 `packages/mini-app-frontend/components/MessagesView.tsx`。 */
export const MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE: number = 10;

/** 群热发言记录页面可选的每页条数档位（默认 10 条，可切换 15、20 条）。不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/mini-app-frontend/components/MessagesView.tsx`。 */
export const MINI_APP_MESSAGES_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/** 已 `/init` 受管群列表缺省每页显示的群数量（10 条）。不变量：正整数。所属模块：`packages/mini-app-frontend/store/chats.ts` 与 `packages/mini-app-frontend/pages/ChatsPage.tsx`。 */
export const MINI_APP_CHATS_DEFAULT_PAGE_SIZE: number = 10;

/** 已 `/init` 受管群列表可选的每页条数档位（默认 10 条，可切换 15、20 条）。不变量：升序正整数只读数组，仅包含 10、15、20 三档。所属模块：`packages/mini-app-frontend/pages/ChatsPage.tsx`。 */
export const MINI_APP_CHATS_PAGE_SIZE_OPTIONS: readonly number[] = [10, 15, 20];

/**
 * Mini App 群详情页可操作的功能开关全集（含 `/init` 总开关）。
 * 不变量：与 `MiniAppFeatureKey` 联合类型一一对应；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/components/ChatFeatureListCard.tsx` 与 `packages/mini-app-frontend/components/skeletons/ChatDetailSkeleton.tsx`。
 */
export const MINI_APP_FEATURE_KEYS: readonly MiniAppFeatureKey[] =
  exhaustiveList<MiniAppFeatureKey>()([
    "init",
    "aiChat",
    "translation",
    "adDetect",
    "floodControl",
    "antiRaid",
    "proxySend",
  ]);

/**
 * Mini App 群详情页批量清理新进群成员（`/batch_kick`）允许的最短回溯小时数。
 * 不变量：正整数下界 1，与 `packages/consts/miniApp.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/store/chatMutationActions.ts`、`packages/mini-app-frontend/components/ChatJoinCleanCard.tsx` 与 `packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。
 */
export const MINI_APP_BATCH_KICK_MIN_HOURS: number = 1;

/**
 * Mini App 群详情页批量清理新进群成员（`/batch_kick`）允许的最长回溯小时数。
 * 不变量：正整数上界 24，与 `packages/consts/miniApp.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/store/chatMutationActions.ts`、`packages/mini-app-frontend/components/ChatJoinCleanCard.tsx` 与 `packages/mini-app-frontend/components/animations/useAnimatedRangeProgress.ts`。
 */
export const MINI_APP_BATCH_KICK_MAX_HOURS: number = 24;

/**
 * Mini App 群详情页批量清理新进群成员（`/batch_kick`）的初始默认回溯小时数。
 * 不变量：`MINI_APP_BATCH_KICK_MIN_HOURS..MINI_APP_BATCH_KICK_MAX_HOURS` 之间的正整数。所属模块：`packages/mini-app-frontend/store/chats.ts`。
 */
export const MINI_APP_BATCH_KICK_DEFAULT_HOURS: number = 1;

/**
 * Mini App 群详情页批量清理新进群成员（`/batch_kick`）的快捷小时档位列表。
 * 不变量：严格递增的 `1..24` 正整数只读数组。所属模块：`packages/mini-app-frontend/components/ChatJoinCleanCard.tsx`。
 */
export const MINI_APP_BATCH_KICK_PRESET_HOURS: readonly number[] = [1, 3, 6, 12, 24];

/**
 * Mini App 群详情页在后台 `/batch_kick` 批次执行期间轮询服务端完成回调状态的间隔毫秒数（90 秒）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/pages/ChatsPage.tsx`。
 */
export const MINI_APP_BATCH_KICK_POLL_INTERVAL_MS: number = 90_000;

/**
 * Mini App 群详情页切换回溯清理时间窗口（滑块、步进或预设档位）时触发实时入群人数查询的防抖等待毫秒数（0.5 秒）。
 * 不变量：正整数毫秒数。所属模块：`packages/mini-app-frontend/store/chatMutationActions.ts`。
 */
export const MINI_APP_BATCH_KICK_WINDOW_DEBOUNCE_MS: number = 500;

/**
 * Mini App 群详情页目标管理下拉菜单与弹窗支持的类别键闭集（问答对、追着删目标、追着翻目标）。
 * 不变量：与 `MiniAppChatTargetKind` 联合类型一一对应。所属模块：`packages/mini-app-frontend/components/ChatTargetsMenuButtonList.tsx`、`packages/mini-app-frontend/components/animations/TabHeightSizer.tsx` 与 `packages/mini-app-frontend/components/ChatTargetsModal.tsx`。
 */
export const MINI_APP_CHAT_TARGET_KINDS: readonly MiniAppChatTargetKind[] =
  exhaustiveList<MiniAppChatTargetKind>()([
    "qa",
    "deleteMessage",
    "translate",
  ]);

/**
 * Mini App 群内追着翻目标支持的目标语言闭集。
 * 不变量：与 `MiniAppTranslateLanguage` 联合类型一一对应；取值与 `packages/consts/miniApp.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/components/ChatTargetsMemberPanels.tsx`。
 */
export const MINI_APP_TRANSLATE_LANGUAGES: readonly MiniAppTranslateLanguage[] =
  exhaustiveList<MiniAppTranslateLanguage>()([
    "ja",
    "cn",
    "en",
    "uk",
    "ru",
  ]);

/**
 * 群内目标管理弹窗数据条目骨架屏中列表行占位的序号表（3 行）。
 * 不变量：从 0 起连续递增的只读整数数组，仅用作骨架行 key。所属模块：`packages/mini-app-frontend/components/skeletons/ChatTargetsListSkeleton.tsx`。
 */
export const MINI_APP_TARGETS_SKELETON_ROW_INDICES: readonly number[] = [0, 1, 2];

/**
 * 每群可登记的问答对条数上限（目标清单尚未加载完成时的前端回退值）。
 * 不变量：正整数，取值与 `packages/consts/qa.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/components/ChatTargetsModal.tsx`。
 */
export const CHAT_QA_MAX_PER_CHAT: number = 15;

/**
 * 单条问答问题文本的最大长度（UTF-16 code unit，目标清单尚未加载完成时的前端回退值）。
 * 不变量：正整数，取值与 `packages/consts/qa.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/components/ChatTargetsQaPanel.tsx`。
 */
export const CHAT_QA_QUESTION_MAX_CHARS: number = 256;

/**
 * 单条问答答案文本的最大长度（UTF-16 code unit，目标清单尚未加载完成时的前端回退值）。
 * 不变量：正整数，取值与 `packages/consts/qa.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/components/ChatTargetsQaPanel.tsx`。
 */
export const CHAT_QA_ANSWER_MAX_CHARS: number = 3_840;

/**
 * 每群同时处于自动删除发言状态的目标身份数上限（目标清单尚未加载完成时的前端回退值）。
 * 不变量：正整数，取值与 `packages/consts/deleteMessage.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/components/ChatTargetsModal.tsx`。
 */
export const DELETE_MESSAGE_CHAT_TARGET_MAX: number = 15;

/**
 * 每群同时开启追着翻译的目标人数上限（目标清单尚未加载完成时的前端回退值）。
 * 不变量：正整数，取值与 `packages/consts/translate.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/components/ChatTargetsModal.tsx`。
 */
export const TRANSLATE_CHAT_USER_LIMIT: number = 5;
