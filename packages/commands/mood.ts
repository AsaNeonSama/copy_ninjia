import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import { requestAiMood } from "../aiChat";
import { aiChatConfigReadiness } from "../config/readiness";
import { getChatState } from "../infra/storage/stateStore";
import { logger } from "../infra/logger";
import { replyCommandNotice } from "../infra/telegram";
import { refuseIfConfigBroken } from "./configGate";
import { rejectUnlessPermitted } from "./commandActor";
import type { CachedUser } from "../types/chatState";

/**
 * /mood 只分派 query 与 switch；非法参数不触发 Worker 请求。
 * @param ctx grammY 命令上下文。
 */
export async function handleMoodCommand(ctx: CommandContext<Context>): Promise<void> {
  // 子命令词不区分大小写，口径同 `/copy`、`/qa`、`/icon`、`/translate`。
  const argument: string = ctx.match.trim().toLowerCase();
  if (argument === "query") {
    await queryMood(ctx);
  } else if (argument === "switch") {
    await switchMood(ctx);
  } else {
    await replyCommandNotice(ctx, chatAtmosphere().MOOD_USAGE_TEXT);
  }
}

/** 检查 AI 心情功能配置就绪度与群开关状态的参数。 */
interface MoodAvailabilityOptions {
  /** grammY 命令上下文。 */
  ctx: CommandContext<Context>;
  /** 写进错误日志的功能名。 */
  feature: "AI mood query" | "AI mood switch";
  /** 配置文件不可用时的拒绝提示生成函数。 */
  brokenConfigText: (file: string) => string;
  /** 本群未启用 AI 闲聊时的提示文案。 */
  disabledText: string;
}

/**
 * 心情查询与重抽共用的运行前提；只负责说明 Worker 为何不可用，不做权限判断。
 * @param options 命令上下文、功能标识及配置异常与未开启状态下的拒绝提示文案。
 * @returns 配置就绪且本群已开启 AI 闲聊时返回 true；已发送拒绝回执时返回 false。
 */
async function isMoodAvailable({
  ctx,
  feature,
  brokenConfigText,
  disabledText,
}: MoodAvailabilityOptions): Promise<boolean> {
  // 先核对 aiChatConfigReadiness；不可用时点名配置文件并回执，不向 Worker 投递。
  const refused: boolean = await refuseIfConfigBroken({
    readiness: aiChatConfigReadiness(),
    chatId: ctx.chat.id,
    messageId: ctx.msgId,
    feature,
    text: brokenConfigText,
  });
  if (refused) return false;

  if (getChatState(ctx.chat.id).isAIChatEnabled !== true) {
    await replyCommandNotice(ctx, disabledText);
    return false;
  }
  return true;
}

/**
 * 处理 /mood query 指令：任意群成员均可查询 AI 当前有效心情（全局一份，所有群共用）。主线程
 * 只向 AI Worker 投递 queryMood 并等待 moodQueried 回执；不经过权限系统，
 * 也不重抽尚未到期的心情。
 * @param ctx grammY 命令上下文。
 */
async function queryMood(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const available: boolean = await isMoodAvailable({
    ctx,
    feature: "AI mood query",
    brokenConfigText: (file: string): string => chatAtmosphere().NOTICE_TEXTS.moodQueryConfigInvalid(file),
    disabledText: chatAtmosphere().NOTICE_TEXTS.moodQueryDisabled,
  });
  if (!available) return;

  let moodName: string;
  try {
    moodName = await requestAiMood("queryMood");
  } catch (error: unknown) {
    logger.error(`Failed to confirm AI mood query for chat ${chatId}:`, error);
    await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.moodQueryFailed);
    return;
  }

  await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.moodCurrent(moodName));
}

/**
 * 处理 /mood switch 指令：立即重抽 AI 的当前心情并回复结果，新心情对所有群同时生效。心情缓存
 * 在 AI Worker 线程内（cache/workers/aiChat/mood.ts），主线程只 post 一条 switchMood
 * 请求、等 moodSwitched 回执单独带回新心情名（见 aiChat/workerBridge.ts 的 requestAiMood），
 * 回复固定从这里发出，不走 AI 回复流水线。仅持有 isCanSwitchMood 的身份可用；
 * 超级管理员恒持有该权限（见 infra/identityPolicy/whitelist.ts），白名单身份可由 /permission 单独获权；其他身份收到拒绝回执。
 * @param ctx grammY 命令上下文。
 */
async function switchMood(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;

  const actor: CachedUser | undefined = await rejectUnlessPermitted(
    ctx,
    "isCanSwitchMood",
    (actorLabel: string, atmosphere: AtmosphereTexts): string => atmosphere.NOTICE_TEXTS.moodSwitchRejected(actorLabel)
  );
  if (actor === undefined) return;

  const available: boolean = await isMoodAvailable({
    ctx,
    feature: "AI mood switch",
    brokenConfigText: (file: string): string => chatAtmosphere().NOTICE_TEXTS.moodSwitchConfigInvalid(file),
    disabledText: chatAtmosphere().NOTICE_TEXTS.moodSwitchDisabled,
  });
  if (!available) return;

  let moodName: string;
  try {
    moodName = await requestAiMood("switchMood");
  } catch (error: unknown) {
    logger.error(`Failed to confirm AI mood switch for chat ${chatId}:`, error);
    await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.moodSwitchFailed);
    return;
  }

  await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.moodSwitched(moodName));
}
