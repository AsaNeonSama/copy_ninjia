/**
 * 每条 update 的前置链：运势回执 → 初始化网关 → 群升级迁移 → 身份预热 → 私聊中转 →
 * Anti-Raid / `/delete_message` 目标 / gag / `/qa set` 四条认领型 ingress → 命令外闸 → 中文动作外闸 →
 * 消息兜底 → 非消息 update 路由。
 *
 * 约束（跨模块部分见 docs/cn/04-invariants.md 的「线程与状态归属」）：
 * - 整条链只经 app/registerHandlers.ts 的一个 `bot.use` 登记，update_id 记账与 bot 发言外闸
 *   在那一层完成后进入本链；新增前置段必须按顺序插进下面的续接函数，不得另开 `bot.use` / `bot.on`。
 * - 各段按固定顺序同步调用下一段，只有真碰到 I/O（预热冷身份、认领型 ingress 返回 Promise、
 *   命令与消息处理器）才返回 Promise；同步路径不分配 Promise 或闭包。
 * - 斜杠命令、中文动作与非消息 update 仍由 grammY Composer 路由（registerHandlers 建好后经
 *   UpdatePreambleRoutes 传入），未被认领时调用外层 next 恰好一次。
 */

import { matchFilter } from "grammy";
import type { Context, Filter, MiddlewareFn, NextFunction } from "grammy";
import type { Chat, Message } from "grammy/types";
import { handleIncomingMessageMiddleware } from "../auto";
import {
  confirmLuckDraw,
  handleDeleteMessageIngress,
  handleGagMessageIngress,
  handleQaMessageIngress,
} from "../commands";
import { handleAntiRaidMessageIngress } from "../antiRaid";
import { completeChatDeparture } from "../infra/botAdmin";
import { observeWedMemberDeparture, observeWedMembers } from "../commands/wed/members";
import { SLASH_CHAR_CODE } from "../consts/commands";
import { logger } from "../infra/logger";
import { isIdentityPolicyCached, prefetchIdentityPolicies } from "../infra/identityStorage";
import {
  shouldPassInitGate,
  shouldPassPrivateCommandGate,
  shouldRoutePrivateProxyMessage,
} from "../infra/updateGate";
import { messageOriginIdentityId } from "../users/messageOrigin";

/** 前置链之后交给 grammY Composer 的三组路由；registerHandlers 建好后传给 createUpdatePreamble。 */
export interface UpdatePreambleRoutes {
  /** `:entities:bot_command` 外闸之后的全部斜杠命令。 */
  readonly commands: MiddlewareFn<Filter<Context, ":entities:bot_command">>;
  /** 原文首字符为 `/` 的中文动作命令（hears）。 */
  readonly cjkActions: MiddlewareFn<Context>;
  /** message 与 channel_post 以外的 update：表情反应、成员变更、按钮回调与 inline。 */
  readonly nonMessage: MiddlewareFn<Context>;
}

/** 仅把冷身份加入预热批次；全热 update 不分配临时数组。 */
function appendColdIdentityId(
  current: number[] | null,
  id: number
): number[] | null {
  if (isIdentityPolicyCached(id)) return current;
  if (current === null) return [id];
  current.push(id);
  return current;
}

/**
 * 本条 update 可见的全部身份里尚未缓存的那些：发送者或频道马甲（纯频道帖取频道本身）、被回复者及其
 * 频道马甲、转发来源、被回复消息的转发来源、外部回复来源、新成员、离群成员与 chat_member 的目标。
 * 全热时返回 null，不分配数组。
 */
export function collectColdIdentityIds(ctx: Context): number[] | null {
  // `ctx.msg` 与它的 `reply_to_message` 在本段里多次读取，先各取一次。
  const message: Message | undefined = ctx.msg;
  const repliedTo: Message | undefined = message?.reply_to_message;
  let ids: number[] | null = null;
  if (ctx.from !== undefined) ids = appendColdIdentityId(ids, ctx.from.id);
  if (message?.sender_chat !== undefined) {
    ids = appendColdIdentityId(ids, message.sender_chat.id);
  } else {
    // 纯频道帖没有 from 也没有 sender_chat：频道自己就是 ctx.chat，
    // users/visibleSender.ts、commands/commandActor.ts 与 infra/updateGate.ts
    // 按这个 id 解析行为主体。`ctx.chat` 只在这条分支读取。
    const chat: Chat | undefined = ctx.chat;
    if (chat?.type === "channel") ids = appendColdIdentityId(ids, chat.id);
  }
  if (repliedTo?.from !== undefined) {
    ids = appendColdIdentityId(ids, repliedTo.from.id);
  }
  if (repliedTo?.sender_chat !== undefined) {
    ids = appendColdIdentityId(ids, repliedTo.sender_chat.id);
  }
  const forwardOriginId: number | undefined =
    messageOriginIdentityId(message?.forward_origin);
  if (forwardOriginId !== undefined) {
    ids = appendColdIdentityId(ids, forwardOriginId);
  }
  const repliedForwardOriginId: number | undefined =
    messageOriginIdentityId(repliedTo?.forward_origin);
  if (repliedForwardOriginId !== undefined) {
    ids = appendColdIdentityId(ids, repliedForwardOriginId);
  }
  const externalReplyOriginId: number | undefined =
    messageOriginIdentityId(message?.external_reply?.origin);
  if (externalReplyOriginId !== undefined) {
    ids = appendColdIdentityId(ids, externalReplyOriginId);
  }
  if (message?.new_chat_members !== undefined) {
    for (const member of message.new_chat_members) {
      ids = appendColdIdentityId(ids, member.id);
    }
  }
  if (message?.left_chat_member !== undefined) {
    ids = appendColdIdentityId(ids, message.left_chat_member.id);
  }
  if (ctx.chatMember !== undefined) {
    ids = appendColdIdentityId(ids, ctx.chatMember.new_chat_member.user.id);
  }
  return ids;
}

/**
 * 建好整条前置链，返回它的入口（运势回执那一段）。registerHandlers 每次安装调用一次；
 * 各续接函数在这里一次建好并捕获 routes，处理 update 时不再分配。
 */
export function createUpdatePreamble({
  commands,
  cjkActions,
  nonMessage,
}: UpdatePreambleRoutes): MiddlewareFn<Context> {
  const isBotCommand: (ctx: Context) => ctx is Filter<Context, ":entities:bot_command"> =
    matchFilter(":entities:bot_command");

  /**
   * 链尾：message 与 channel_post 进入自动消息流水线；其余 update 交给非消息路由，
   * 路由也未认领时由它调用外层 next。
   */
  function afterCjkActions(ctx: Context, next: NextFunction): unknown {
    return (ctx.message ?? ctx.channelPost) === undefined
      ? nonMessage(ctx, next)
      : handleIncomingMessageMiddleware(ctx);
  }

  /**
   * `/咬`、`/贴贴` 这类中文动作命令没有 Telegram 的 bot_command 实体，bot.command 匹配不到，
   * 按消息原文 hears。排在消息兜底之前；不认领的形态由 handler 自己 next() 放行。
   * CJK_ACTION_COMMAND_PATTERN 以 `^\/` 开头，「原文首字符是 /」是它的超集，其余消息不进
   * hears 子链。原文取法与 Context.has.text() 相同。
   */
  function afterCommands(ctx: Context, next: NextFunction): unknown {
    const message: Message | undefined = ctx.message ?? ctx.channelPost;
    const text: string | undefined = message?.text ?? message?.caption;
    if (text?.charCodeAt(0) !== SLASH_CHAR_CODE) return afterCjkActions(ctx, next);
    return cjkActions(ctx, (): Promise<void> => Promise.resolve(afterCjkActions(ctx, next)) as Promise<void>);
  }

  /**
   * 全部命令收在一层 `:entities:bot_command` 外闸后面：外闸判据与 Context.has.command() 的
   * 第一步相同，是每条命令判据的超集，不带 bot_command 实体的消息一次跳过整组。
   * 授权维护命令（/permission、/white）的 handler 不调 next()，排在 Anti-Raid ingress 之后。
   */
  function afterQaIngress(ctx: Context, next: NextFunction): unknown {
    if (!isBotCommand(ctx)) return afterCommands(ctx, next);
    return commands(ctx, (): Promise<void> => Promise.resolve(afterCommands(ctx, next)) as Promise<void>);
  }

  /**
   * /qa set 表单投递覆盖命令消息与 channel_post（频道里的「问题:」「回答:」是频道帖）；被认领的
   * 消息已删除，终止本条 update。
   */
  function afterGagIngress(ctx: Context, next: NextFunction): unknown {
    const message: Message | undefined = ctx.message ?? ctx.channelPost;
    if (message === undefined) return afterQaIngress(ctx, next);
    const claimed: boolean | Promise<boolean> = handleQaMessageIngress(message);
    if (typeof claimed === "boolean") return claimed ? undefined : afterQaIngress(ctx, next);
    return claimed.then((handled: boolean): unknown => handled ? undefined : afterQaIngress(ctx, next));
  }

  /**
   * gag 覆盖命令消息，位于全部命令之前。被 gag 的消息即使 Telegram 删除失败也在这里终止，不进入
   * AI、copy 或命令处理器。
   */
  function afterDeleteMessageIngress(ctx: Context, next: NextFunction): unknown {
    const message: Message | undefined = ctx.message;
    if (message === undefined) return afterGagIngress(ctx, next);
    const claimed: boolean | Promise<boolean> = handleGagMessageIngress(message, ctx.me.id);
    if (typeof claimed === "boolean") return claimed ? undefined : afterGagIngress(ctx, next);
    return claimed.then((handled: boolean): unknown => handled ? undefined : afterGagIngress(ctx, next));
  }

  /**
   * `/delete_message` 目标的消息同样覆盖命令消息，位于 gag 之前；Anti-Raid 先看原始消息，广告/刷屏/
   * 待验证追踪按原始消息计数。目标的消息排进待删队列后在这里终止，不进入 gag、AI、copy 或命令处理器。
   * 判定同步完成，不返回 Promise。
   */
  function afterAntiRaidIngress(ctx: Context, next: NextFunction): unknown {
    const message: Message | undefined = ctx.message;
    if (message !== undefined && handleDeleteMessageIngress(message)) return undefined;
    return afterDeleteMessageIngress(ctx, next);
  }

  /**
   * 私聊命令已在初始化网关统一收口；活动中的 /send 中转会话只把非命令消息直接短路到消息流水线。
   * 之后是入群验证 ingress，位于命令处理器之前。
   */
  function afterIdentityPrefetch(ctx: Context, next: NextFunction): unknown {
    if (shouldRoutePrivateProxyMessage(ctx)) return handleIncomingMessageMiddleware(ctx);
    const message: Message | undefined = ctx.message;
    if (message === undefined) return afterAntiRaidIngress(ctx, next);
    const claimed: boolean | Promise<boolean> = handleAntiRaidMessageIngress(message, ctx.me.id);
    if (typeof claimed === "boolean") return claimed ? undefined : afterAntiRaidIngress(ctx, next);
    return claimed.then((handled: boolean): unknown => handled ? undefined : afterAntiRaidIngress(ctx, next));
  }

  /**
   * 初始化网关：未初始化群和不允许的私聊命令在这里终止，不进入授权维护、身份预热、验证、命令与
   * AI 链路。群内只有首次 /init 与 my_chat_member 等网关自身明确放行的更新能越过初始化状态；私聊
   * 只接受超级管理员的 /send。网关拒绝时仍摘除已保存的退群成员，不新增候选。
   *
   * 群升级迁移：受管普通群升级为超级群后，旧群 id 收到一条带 `migrate_to_chat_id` 的服务消息，
   * 此后再也不会有 update。按「群已不存在」（`gone`）收尾旧群并终止本条 update；新超级群照旧
   * 需要 /init，旧群设置不搬迁。
   *
   * 身份预热：黑白名单判断保持同步 LRU 读取；每个 update 在进入 Anti-Raid 和命令前，一次性补齐
   * 可见身份的冷缺失。热命中不跨线程，冷读一并查询各身份关系并写入正/负缓存。预热是
   * best-effort：Disk I/O 自愈窗口里冷读失败时 prefetchIdentityPolicies 就地降级并返回 false
   * （见该函数头注），这里不消费这个结论，留冷身份按 fail-closed 判定。全热 update 直接进入下一段，
   * 只有冷读分支返回 Promise。成员集合只消费通过初始化网关的主线程更新，实际增删由 wed owner
   * 合并落盘。
   */
  function afterLuckReceipt(ctx: Context, next: NextFunction): unknown {
    if (!shouldPassInitGate(ctx)) {
      observeWedMemberDeparture(ctx, ctx.chat);
      return undefined;
    }
    if (!shouldPassPrivateCommandGate(ctx)) return undefined;
    const message: Message | undefined = ctx.message;
    if (message?.migrate_to_chat_id !== undefined) {
      logger.info(`Chat ${message.chat.id} was upgraded to supergroup ${message.migrate_to_chat_id}; tearing down the old chat.`);
      return completeChatDeparture(message.chat.id, "gone");
    }
    observeWedMembers(ctx);
    const ids: number[] | null = collectColdIdentityIds(ctx);
    if (ids === null) return afterIdentityPrefetch(ctx, next);
    return prefetchIdentityPolicies(ids).then((): unknown => afterIdentityPrefetch(ctx, next));
  }

  /**
   * 链首（bot 发言外闸之后）：运势签名回执是 chosen_inline_result 之外的确认路径，转发副本同样
   * 有效，在初始化网关前检查。`ctx.msg` 是每次求值的 getter 链（grammy/out/context.js 的
   * `get msg()`），只读一次。
   */
  function afterBotMessageGate(ctx: Context, next: NextFunction): unknown {
    const message: Message | undefined = ctx.msg;
    const confirmation: Promise<void> | undefined = confirmLuckDraw(message?.text, message?.entities);
    if (confirmation === undefined) return afterLuckReceipt(ctx, next);
    return confirmation.then((): unknown => afterLuckReceipt(ctx, next));
  }

  return afterBotMessageGate;
}
