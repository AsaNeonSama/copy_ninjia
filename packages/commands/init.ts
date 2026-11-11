import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";

import { STATE_MANAGED_CHAT_LIMIT } from "../consts/storage";
import {
  getChatState,
  getChatStateCache,
  getOrCreateChatState,
  persistChatState,
} from "../infra/storage/stateStore";
import { replyCommandNotice } from "../infra/telegram";
import { resolveSuperAdminToggleArg, toggleReplyText } from "./superAdminToggle";
import {
  disableManagedChat,
  invalidateBotAdminStatus,
  resolveBotAdminStatus,
} from "../infra/botAdmin";
import { observeChatKind } from "../antiRaid/chatKind";

/**
 * 处理 /init enable|disable 指令：按群开关机器人是否处理这个群的更新（见
 * ChatState.isInitEnabled）。禁用/未初始化的群，其更新在 infra/updateGate.ts 的
 * shouldPassInitGate 处丢弃（接线见 app/updatePreamble.ts），不进入监听、复读、AI 等链路。
 * 只有超级管理员可以控制这个总开关。
 *
 * enable 落盘后调用 observeChatKind 补齐群类型镜像；未纳管的新群在已管群数达到
 * STATE_MANAGED_CHAT_LIMIT 时拒绝启用。disable 经 infra/botAdmin.ts 的 disableManagedChat
 * 先落盘总开关，再拆除运行时并删除该群的 chat_states 条目（lockdown 除外）。
 * @param ctx grammY 命令上下文。
 */
export async function handleInitCommand(ctx: CommandContext<Context>): Promise<void> {
  const arg: "enable" | "disable" | undefined = await resolveSuperAdminToggleArg(ctx, {
    texts: chatAtmosphere().INIT_TOGGLE_TEXTS,
  });
  if (!arg) return;

  const chatId: number = ctx.chat.id;
  const knownChats: ReadonlyMap<number, ChatState> = getChatStateCache();
  if (
    arg === "enable" &&
    !knownChats.has(chatId) &&
    knownChats.size >= STATE_MANAGED_CHAT_LIMIT
  ) {
    await replyCommandNotice(ctx, chatAtmosphere().INIT_CHAT_LIMIT_TEXT);
    return;
  }
  const wasEnabled: boolean = getChatState(chatId).isInitEnabled === true;
  const isEnabled: boolean = arg === "enable";
  let teardownFailed: boolean = false;
  if (isEnabled) {
    getOrCreateChatState(chatId).isInitEnabled = true;
    // 对已经启用的群重复 /init enable 不作废管理员状态记录；首次启用时作废。
    if (!wasEnabled) invalidateBotAdminStatus(chatId);
    await persistChatState(chatId, "init toggled");
    observeChatKind(ctx.chat);
  } else {
    teardownFailed = await disableManagedChat(chatId);
  }

  // enable 之后若 botPermissions 为空，重新查询一次管理员身份：查询结果经
  // recordBotChatPermissions 回填，使本群首次同时满足「机器人为管理员」与「群已初始化」时
  // 触发一次黑名单清扫（见 infra/botAdmin.ts）。
  //
  // 条件取「botPermissions 此刻为空」而不是 !wasEnabled；这次调用可能上抛
  // （getChatMember 之后的状态落盘失败，见 infra/botAdmin.ts 与
  // docs/cn/04-invariants.md），重投时 wasEnabled 已为 true，权限记录仍为空。
  // 若 botPermissions 已有记录且属于重复 enable，则跳过本次查询。
  if (isEnabled && getChatState(chatId).botPermissions === undefined) await resolveBotAdminStatus(chatId);

  const replyText: string = teardownFailed
    ? chatAtmosphere().INIT_DISABLE_TEARDOWN_FAILED_TEXT
    : toggleReplyText({
      isEnabled,
      wasEnabled,
      texts: chatAtmosphere().INIT_TOGGLE_TEXTS,
    });
  await replyCommandNotice(ctx, replyText);
}
