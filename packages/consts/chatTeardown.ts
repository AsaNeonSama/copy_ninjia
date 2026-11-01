import type { ChatRuntimeOwner } from "../types/chatTeardown";
import { exhaustiveList } from "./exhaustiveList";

/**
 * 群 teardown 的派发顺序，列全全部 owner。
 *
 * 全部回调在第一个 `await` 之前同步发出，使跨群 copy 槽、gag 会话、删除目标、问答表单与
 * Worker 闸门一起关闭，随后才等待需要 durable 回执的异步 owner。`deleteMessage` 与 `qa` 在
 * `gag` 之后，三者都只做进程内状态收尾；`joinLog` 在最后，只有一次投递加一次领域 flush。
 *
 * 新增 owner 时把它加进 `ChatRuntimeOwner` 就必须同时加到这里，否则编译不过。
 * 所属模块：infra/chatTeardown.ts 的 teardownChatRuntime。
 */
export const CHAT_TEARDOWN_ORDER: readonly ChatRuntimeOwner[] = exhaustiveList<ChatRuntimeOwner>()([
  "copy",
  "translate",
  "gag",
  "deleteMessage",
  "qa",
  "wed",
  "aiChat",
  "antiRaid",
  "joinLog",
]);

/**
 * 启动标题刷新同时运行的 getChat 任务数。所属模块：infra/chatTitle.ts。
 */
export const CHAT_TITLE_REFRESH_CONCURRENCY: number = 5;

/**
 * 启动标题刷新确证群不可达时，相邻两次 getChat 的间隔（ms）。所属模块：infra/chatTitle.ts。
 */
export const CHAT_ABSENCE_CONFIRM_INTERVAL_MS: number = 60_000;

/**
 * 启动标题刷新确证群不可达的 getChat 总次数（含首次）：每次都得到同一类结论才按离群或群已不存在
 * 收尾，中途任何一次查到群或得到别的错误都放弃。所属模块：infra/chatTitle.ts。
 */
export const CHAT_ABSENCE_CONFIRM_ATTEMPTS: number = 3;
