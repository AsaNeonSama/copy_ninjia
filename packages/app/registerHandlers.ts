import { Composer, GrammyError } from "grammy";
import type {
  Bot,
  BotError,
  Context,
  Filter,
  MiddlewareFn,
  NextFunction,
} from "grammy";
import { handleReaction } from "../auto";
import {
  handleAdDetectCommand,
  handleAiChatCommand,
  handleBatchKickCommand,
  handleBlockCommand,
  handleHImageCommand,
  handleInfoCommand,
  handleBotStatusCommand,
  handleCjkActionCommand,
  handleCjkActionUsageCommand,
  handleClearContextCommand,
  handleCopyCommand,
  handleDeleteMessageCommand,
  handleAntiRaidCommand,
  handleFloodControlCommand,
  handleGagCommand,
  handleQaBoardCallback,
  handleQaCommand,
  handleInitCommand,
  handleTranslateCommand,
  handleInlineQuery,
  handleLuckChosenInlineResult,
  handleMuteCommand,
  handlePermissionCommand,
  handleMoodCommand,
  handleQuietCommand,
  handleSendCommand,
  handleIconCommand,
  dispatchWedCommand,
  dispatchWedCallback,
  handleUngagCommand,
  handleUnmuteCommand,
  handleUnquietCommand,
  handleWhiteCommand,
} from "../commands";
import {
  handleChatMemberUpdate,
  handleVerificationCallback,
} from "../antiRaid";
import { handleMyChatMemberUpdate } from "../infra/botAdmin";
import { CJK_ACTION_COMMAND_PATTERN } from "../consts/commands";
import { logger } from "../infra/logger";
import { shouldPassBotMessage } from "../infra/botMessageGate";
import { createUpdatePreamble } from "./updatePreamble";
import type { HandlerRegistration } from "../types/lifecycle";

/**
 * 按钮回调的统一续接边界：已认领时终止当前回调链，未认领时调用 `next()` 放行。
 * 保持非 `async` 声明，使同步返回 `false` 的常态路径不分配 Promise（见 `docs/cn/04-invariants.md`）。
 * @param claimed 前置认领结论（布尔值或解析为布尔值的 Promise）。
 * @param next 下游 grammY 中间件续接函数。
 * @returns 已认领时返回 `undefined`（或解析为 `undefined` 的 Promise），未认领时返回 `next()` 的结果。
 */
function claimOrContinue(
  claimed: boolean | Promise<boolean>,
  next: NextFunction
): Promise<void> | undefined {
  if (typeof claimed !== "boolean") {
    return claimed.then(
      (handled: boolean): Promise<void> | undefined => handled ? undefined : next()
    );
  }
  return claimed ? undefined : next();
}

/**
 * `callback_query:data` 的认领顺序：依次尝试 `/wed` 与 `/qa query` 翻页，均未命中前缀时调用 `next()` 交给入群验证。
 * 保持非 `async` 声明，两条前缀均同步返回 `false` 时直接调用 `next()`（见 `docs/cn/04-invariants.md`）。
 * @param ctx 带 `callback_query:data` 过滤的 grammY 上下文。
 * @param next 下游 grammY 中间件续接函数。
 * @returns 已认领时返回 `undefined`（或解析为 `undefined` 的 Promise），未认领时返回 `next()` 的结果。
 */
function dispatchCallbackQuery(
  ctx: Filter<Context, "callback_query:data">,
  next: NextFunction
): Promise<void> | undefined {
  const wed: boolean | Promise<boolean> = dispatchWedCallback(ctx);
  if (typeof wed !== "boolean") {
    return wed.then((claimed: boolean): Promise<void> | undefined =>
      claimed ? undefined : claimOrContinue(handleQaBoardCallback(ctx), next));
  }
  return wed ? undefined : claimOrContinue(handleQaBoardCallback(ctx), next);
}

/**
 * 在 grammY `Bot` 实例上挂载唯一更新入口中间件与全局错误边界。
 * 斜杠命令、中文动作命令与非消息更新在此组装为三个子 `Composer`，交由 `app/updatePreamble.ts`
 * 按固定顺序调用，不在 `bot` 根实例上额外挂载其他 `use` / `on` / `command` / `hears`（见 `docs/cn/04-invariants.md`）。
 * @param bot 待安装更新链的 grammY Bot 实例。
 * @returns 已处理最大 `update_id` 的读取句柄。
 */
export function registerHandlers(bot: Bot): HandlerRegistration {
  let lastSeenUpdateId: number = 0;

  // 授权维护命令与其余命令一样排在 Anti-Raid ingress 之后：/permission 与 /white
  // 的 handler 不调 next()，需经过 handleAntiRaidMessageIngress 后才执行。
  // 中文动作命令没有 bot_command 实体，由下面的「/」外闸承接。
  const commands: Composer<Filter<Context, ":entities:bot_command">> = new Composer();
  commands.command("permission", handlePermissionCommand);
  commands.command("white", handleWhiteCommand);
  commands.command("copy", handleCopyCommand);
  commands.command("translate", handleTranslateCommand);
  commands.command("icon", handleIconCommand);
  commands.command("wed", dispatchWedCommand);
  commands.command("h_image", handleHImageCommand);
  commands.command("info", handleInfoCommand);
  commands.command("block", handleBlockCommand);
  commands.command("batch_kick", handleBatchKickCommand);
  commands.command("ai_chat", handleAiChatCommand);
  commands.command("clear_context", handleClearContextCommand);
  commands.command("ad_detect", handleAdDetectCommand);
  commands.command("flood_control", handleFloodControlCommand);
  commands.command("antiraid", handleAntiRaidCommand);
  commands.command("bot_status", handleBotStatusCommand);
  commands.command("mood", handleMoodCommand);
  commands.command("init", handleInitCommand);
  commands.command("quiet", handleQuietCommand);
  commands.command("unquiet", handleUnquietCommand);
  commands.command("mute", handleMuteCommand);
  commands.command("unmute", handleUnmuteCommand);
  commands.command("gag", handleGagCommand);
  commands.command("ungag", handleUngagCommand);
  commands.command("delete_message", handleDeleteMessageCommand);
  commands.command("send", handleSendCommand);
  commands.command("qa", handleQaCommand);
  // 菜单占位项：在命令菜单里展示「/<中文动作名>」用法（那类命令名注册不进菜单，
  // 见 consts/commands.ts）；handleCjkActionUsageCommand 回复用法并终止链路，
  // 不落到消息兜底。
  commands.command("x", handleCjkActionUsageCommand);

  const cjkActions: Composer<Context> = new Composer();
  cjkActions.hears(CJK_ACTION_COMMAND_PATTERN, handleCjkActionCommand);

  // 非消息 update 的路由；前置链只在 message / channel_post 之外的 update 走到链尾时调用。
  const nonMessage: Composer<Context> = new Composer();
  nonMessage.on("message_reaction", handleReaction);
  nonMessage.on("chat_member", handleChatMemberUpdate);
  nonMessage.on("my_chat_member", handleMyChatMemberUpdate);
  // /wed 结果和 /qa query 翻页按钮排在入群验证之前：前缀各自独立，认领了就
  // 不再往下走，没认领的原样交给验证按钮。
  nonMessage.on("callback_query:data", dispatchCallbackQuery);
  nonMessage.on("callback_query:data", handleVerificationCallback);
  nonMessage.on("inline_query", handleInlineQuery);
  nonMessage.on("chosen_inline_result", handleLuckChosenInlineResult);

  const preamble: MiddlewareFn<Context> = createUpdatePreamble({
    commands: commands.middleware(),
    cjkActions: cjkActions.middleware(),
    nonMessage: nonMessage.middleware(),
  });
  bot.use((ctx: Context, next: NextFunction): unknown => {
    // 追踪已进入处理的最大 update_id，停机时用于确认 Telegram offset。
    if (ctx.update.update_id > lastSeenUpdateId) lastSeenUpdateId = ctx.update.update_id;
    // 收到其他机器人的 message 时在接收链前段计数；超额更新不进入回执、初始化、
    // 身份预热或业务分发。频道身份、本机器人自己与本群 /delete_message 目标的发言不计数。
    return shouldPassBotMessage(ctx.message, ctx.me.id) ? preamble(ctx, next) : undefined;
  });

  bot.catch((err: BotError<Context>): never => {
    // GrammyError 携带完整请求 payload，这里只记录状态码和描述。
    if (err.error instanceof GrammyError) {
      logger.error(
        `Unhandled error while handling update ${err.ctx.update.update_id}: ` +
        `${err.error.error_code} ${err.error.description}`
      );
    } else {
      logger.error(`Unhandled error while handling update ${err.ctx.update.update_id}:`, err.error);
    }
    // 记录后继续向 acknowledged runner 传播，不吞掉异常；失败的 update
    // （包括 durability barrier 失败）因此不会被 getUpdates 确认。
    throw err.error;
  });

  return { getLastSeenUpdateId: (): number => lastSeenUpdateId };
}
