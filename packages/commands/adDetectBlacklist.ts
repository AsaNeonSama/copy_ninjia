/**
 * `/ad_detect <sticker|emoji> <list [页码]|add [包名...]|remove [包名...]>` 子命令实现。
 *
 * - **存储与生效**：直接读写主线程权威广告包黑名单边界（`infra/adPackBlacklistStorage.ts`），
 *   不检查 `ad_detect.json` 配置就绪度；所有写操作经观察者立即同步至 Anti-Raid Worker 并等待
 *   Disk I/O Worker 事务落盘确认。
 * - **权限边界**：统一校验 `isCanControllAdDetectPermission`（超级管理员恒持有）。
 * - **提示留存与话题**：所有回复均经 `replyCommandNotice` 发送且不设置 `preserveInGroup: true`，
 *   群聊内 30 秒后自动删除，并自动继承触发消息所在的论坛话题。
 */

import type { CommandContext, Context } from "grammy";
import type { Message, Sticker } from "grammy/types";
import { stickerPacksForRecovery } from "../config/stickers";
import { STICKER_PACK_NAME_PATTERN } from "../consts/aiChat/stickers";
import {
  AD_DETECT_BLACKLIST_INVALID_ECHO_MAX_CHARS,
  AD_DETECT_BLACKLIST_INVALID_MAX_PACKS,
  AD_DETECT_BLACKLIST_LIST_PAGE_SIZE,
  AD_DETECT_BLACKLIST_NOTICE_MAX_PACKS,
} from "../consts/commands";
import { TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS } from "../consts/telegram";
import {
  getAdPackBlacklistCount,
  listAdPackBlacklistPage,
  persistAdPackBlacklistAdd,
  persistAdPackBlacklistRemove,
} from "../infra/adPackBlacklistStorage";
import type { AdPackBlacklistPageSlice } from "../infra/adPackBlacklistStorage";
import { chatAtmosphere } from "../infra/atmosphere";
import { logger } from "../infra/logger";
import { replyCommandNotice } from "../infra/telegram";
import { logApiError, telegramApi } from "../infra/telegram/client";
import { currentUpdateAbortSignal, throwIfUpdateAborted } from "../infra/updateContext";
import { explicitReplyTo } from "../libs/forumTopic";
import { deduplicatePreservingOrder } from "../libs/stickerPackNames";
import { telegramSignal } from "../libs/telegramSignal";
import { sanitizeDisplayName, truncateInline } from "../libs/text";
import type {
  AdPackBlacklistKind,
  AdPackBlacklistPersistResult,
} from "../types/adPackBlacklist";
import type { AdDetectBlacklistTexts, AtmosphereTexts } from "../types/atmosphere";
import type { CachedUser } from "../types/chatState";
import { rejectUnlessPermitted } from "./commandActor";

/** 广告包黑名单变更子动作。 */
type BlacklistMutationAction = "add" | "remove";

/** 执行黑名单变更所需的上下文与参数。 */
interface BlacklistMutationParams {
  /** grammY 命令上下文。 */
  readonly ctx: CommandContext<Context>;
  /** 通过权限校验的发起身份 ID。 */
  readonly actorId: number;
  /** 目标黑名单种类（`"sticker"` 或 `"emoji"`）。 */
  readonly kind: AdPackBlacklistKind;
  /** 变更动作（`"add"` 或 `"remove"`）。 */
  readonly action: BlacklistMutationAction;
  /** 命令行显式提供的包名参数（已分词、保留原始大小写）。 */
  readonly rawPacks: readonly string[];
}

/** 解析待变更目标包名列表的结果：合法去重列表或已向用户回执后应中止的 `null`。 */
interface ResolveTargetPacksParams {
  /** grammY 命令上下文。 */
  readonly ctx: CommandContext<Context>;
  /** 通过权限校验的发起身份 ID。 */
  readonly actorId: number;
  /** 目标黑名单种类（`"sticker"` 或 `"emoji"`）。 */
  readonly kind: AdPackBlacklistKind;
  /** 变更动作（`"add"` 或 `"remove"`）。 */
  readonly action: BlacklistMutationAction;
  /** 命令行显式提供的包名参数。 */
  readonly rawPacks: readonly string[];
  /** 当前氛围下的黑名单子命令文案表。 */
  readonly texts: Readonly<AdDetectBlacklistTexts>;
}

/**
 * 读取指定黑名单种类在当前氛围下的中文展示名。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param texts 当前氛围下的黑名单文案表。
 * @returns 对应的中文展示名。
 */
function kindLabelOf(
  kind: AdPackBlacklistKind,
  texts: Readonly<AdDetectBlacklistTexts>
): string {
  return kind === "sticker" ? texts.kindSticker : texts.kindEmoji;
}

/**
 * 严格解析 `list` 子命令的可选页码参数：仅接受无前导零的十进制安全正整数。
 *
 * @param raw 原始页码参数文本。
 * @returns 合法页码正整数；非法时返回 `undefined`。
 */
function parseBlacklistPage(raw: string): number | undefined {
  if (!/^[1-9]\d*$/.test(raw)) return undefined;
  const page: number = Number(raw);
  return Number.isSafeInteger(page) ? page : undefined;
}

/**
 * 有界格式化包名列表，避免超大批次回执超过 Telegram 单条文本上限。
 *
 * @param packs 已校验或待展示的包名列表。
 * @param maxItems 最多完整展示的包名条数。
 * @returns 供纯文本提示展示的拼接串。
 */
function formatPackList(
  packs: readonly string[],
  maxItems: number = AD_DETECT_BLACKLIST_NOTICE_MAX_PACKS
): string {
  if (packs.length <= maxItems) return packs.join("、");
  return `${packs.slice(0, maxItems).join("、")} 等 ${packs.length} 个`;
}

/**
 * 有界清洗并格式化非法包名参数用于错误回执，剥除双向控制符、中和可点击命令并限制单条长度。
 *
 * @param invalidPacks 未通过 `STICKER_PACK_NAME_PATTERN` 校验的原始参数列表。
 * @returns 清洗与截断后的展示串。
 */
function formatInvalidPackList(invalidPacks: readonly string[]): string {
  const sanitized: string[] = invalidPacks
    .slice(0, AD_DETECT_BLACKLIST_INVALID_MAX_PACKS)
    .map((pack: string): string =>
      truncateInline(sanitizeDisplayName(pack), AD_DETECT_BLACKLIST_INVALID_ECHO_MAX_CHARS)
    );
  if (invalidPacks.length <= AD_DETECT_BLACKLIST_INVALID_MAX_PACKS) return sanitized.join("、");
  return `${sanitized.join("、")} 等 ${invalidPacks.length} 个`;
}

/**
 * 收集被回复消息正文与图注中的全部去重 `custom_emoji_id`，保留首次出现顺序。
 *
 * @param message 用户显式回复的目标 Telegram 消息。
 * @returns 去重后的 `custom_emoji_id` 列表。
 */
function collectReplyCustomEmojiIds(message: Message): readonly string[] {
  const ids: Set<string> = new Set<string>();
  for (const entities of [message.entities, message.caption_entities]) {
    if (entities === undefined) continue;
    for (const entity of entities) {
      if (entity.type !== "custom_emoji") continue;
      if (entity.custom_emoji_id.length === 0) continue;
      ids.add(entity.custom_emoji_id);
    }
  }
  return [...ids];
}

/**
 * 从被回复消息的自定义表情解析所属包名，按 `TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS` 分批查询 Telegram。
 *
 * @param ctx grammY 命令上下文。
 * @param actorId 发起命令的身份 ID。
 * @param replied 用户显式回复的消息对象。
 * @returns 成功时返回去重非空 `set_name` 列表；缺少表情、接口失败或无所属包名时已回执并返回 `null`。
 */
async function resolveEmojiPacksFromReply(
  ctx: CommandContext<Context>,
  actorId: number,
  replied: Message
): Promise<readonly string[] | null> {
  const texts: Readonly<AdDetectBlacklistTexts> = chatAtmosphere().AD_DETECT_BLACKLIST_TEXTS;
  const emojiIds: readonly string[] = collectReplyCustomEmojiIds(replied);
  if (emojiIds.length === 0) {
    await replyCommandNotice(ctx, texts.replyMissingEmoji);
    return null;
  }

  const resolvedPacks: Set<string> = new Set<string>();
  const updateSignal: AbortSignal | undefined = currentUpdateAbortSignal();
  for (
    let start: number = 0;
    start < emojiIds.length;
    start += TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS
  ) {
    const batch: string[] = emojiIds.slice(start, start + TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS);
    throwIfUpdateAborted(updateSignal);
    let stickers: readonly Sticker[];
    try {
      stickers = updateSignal === undefined
        ? await telegramApi.getCustomEmojiStickers(batch)
        : await telegramApi.getCustomEmojiStickers(batch, telegramSignal(updateSignal));
      throwIfUpdateAborted(updateSignal);
    } catch (error: unknown) {
      if (updateSignal?.aborted === true) throwIfUpdateAborted(updateSignal);
      logApiError("resolve custom emoji blacklist packs", error, {
        chatId: ctx.chat.id,
        actorId,
        batchSize: batch.length,
      });
      await replyCommandNotice(ctx, texts.replyEmojiQueryFailed);
      return null;
    }
    for (const sticker of stickers) {
      const setName: string | undefined = sticker.set_name?.trim();
      if (setName !== undefined && setName.length > 0) {
        resolvedPacks.add(setName);
      }
    }
  }

  if (resolvedPacks.size === 0) {
    await replyCommandNotice(ctx, texts.replyEmojiNoPack);
    return null;
  }
  return [...resolvedPacks];
}

/**
 * 解析并全量校验本次 `add`/`remove` 的目标包名列表：
 * - 若显式提供参数，则先全量校验每个参数，任一非法即整批拒绝；
 * - 若省略参数，则从显式回复的消息中提取贴纸包或自定义表情所属包名并校验。
 *
 * @param params 命令上下文、发起身份、黑名单种类、动作、原始包名参数与文案表。
 * @returns 通过全部校验并保序去重后的目标包名列表；已发送拒绝提示时返回 `null`。
 */
async function resolveTargetPacks({
  ctx,
  actorId,
  kind,
  action,
  rawPacks,
  texts,
}: ResolveTargetPacksParams): Promise<readonly string[] | null> {
  let candidatePacks: readonly string[];
  if (rawPacks.length > 0) {
    candidatePacks = rawPacks;
  } else {
    const replied: Message | undefined = explicitReplyTo(ctx.msg);
    if (replied === undefined) {
      await replyCommandNotice(
        ctx,
        texts.missingPacks(kindLabelOf(kind, texts), `/ad_detect ${kind} ${action}`)
      );
      return null;
    }
    if (kind === "sticker") {
      const setName: string | undefined = replied.sticker?.set_name?.trim();
      if (setName === undefined || setName.length === 0) {
        await replyCommandNotice(ctx, texts.replyMissingStickerPack);
        return null;
      }
      candidatePacks = [setName];
    } else {
      const resolved: readonly string[] | null = await resolveEmojiPacksFromReply(ctx, actorId, replied);
      if (resolved === null) return null;
      candidatePacks = resolved;
    }
  }

  const invalidPacks: readonly string[] = candidatePacks.filter(
    (pack: string): boolean => !STICKER_PACK_NAME_PATTERN.test(pack)
  );
  if (invalidPacks.length > 0) {
    await replyCommandNotice(ctx, texts.invalidPacks(formatInvalidPackList(invalidPacks)));
    return null;
  }

  return deduplicatePreservingOrder(candidatePacks);
}

/**
 * 处理 `/ad_detect <sticker|emoji> list [page]`：以固定每页 20 条游标冷读纯文本分页输出全局黑名单（不污染 768 LRU 热缓存）。
 *
 * @param ctx grammY 命令上下文。
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param restArgs `list` 之后的可选页码参数。
 */
async function handleBlacklistList(
  ctx: CommandContext<Context>,
  kind: AdPackBlacklistKind,
  restArgs: readonly string[]
): Promise<void> {
  const texts: Readonly<AdDetectBlacklistTexts> = chatAtmosphere().AD_DETECT_BLACKLIST_TEXTS;
  if (restArgs.length > 1) {
    await replyCommandNotice(ctx, texts.listInvalidPage);
    return;
  }
  const rawPage: string | undefined = restArgs[0];
  const page: number | undefined = rawPage === undefined
    ? 1
    : parseBlacklistPage(rawPage);
  if (page === undefined) {
    await replyCommandNotice(ctx, texts.listInvalidPage);
    return;
  }

  const pageSize: number = AD_DETECT_BLACKLIST_LIST_PAGE_SIZE;
  let slice: Readonly<AdPackBlacklistPageSlice>;
  try {
    slice = await listAdPackBlacklistPage({
      kind,
      page,
      pageSize,
      clampPage: false,
    });
  } catch (error: unknown) {
    logger.error("Failed to list ad pack blacklist page:", {
      chatId: ctx.chat.id,
      kind,
      page,
    }, error);
    await replyCommandNotice(ctx, texts.storageFailed);
    return;
  }

  const kindLabel: string = kindLabelOf(kind, texts);
  if (slice.total === 0) {
    await replyCommandNotice(ctx, texts.listEmpty(kindLabel));
    return;
  }
  if (slice.outOfRange) {
    await replyCommandNotice(
      ctx,
      texts.listOutOfRange({
        kindLabel,
        page,
        totalPages: slice.totalPages,
        total: slice.total,
      })
    );
    return;
  }

  const start: number = (slice.page - 1) * pageSize;
  const lines: string[] = [
    texts.listHeader({
      kindLabel,
      page: slice.page,
      totalPages: slice.totalPages,
      total: slice.total,
    }),
    ...slice.packs.map((pack: string, index: number): string => `${start + index + 1}. ${pack}`),
  ];
  await replyCommandNotice(ctx, lines.join("\n"));
}

/**
 * 处理 `/ad_detect <sticker|emoji> <add|remove> [pack...]`：校验包名与己方贴纸包护栏后逐条落库并审计。
 *
 * @param params 命令上下文、发起身份、黑名单种类、变更动作与原始包名参数。
 */
async function handleBlacklistMutate({
  ctx,
  actorId,
  kind,
  action,
  rawPacks,
}: BlacklistMutationParams): Promise<void> {
  const texts: Readonly<AdDetectBlacklistTexts> = chatAtmosphere().AD_DETECT_BLACKLIST_TEXTS;
  const packs: readonly string[] | null = await resolveTargetPacks({
    ctx,
    actorId,
    kind,
    action,
    rawPacks,
    texts,
  });
  if (packs === null) return;

  if (kind === "sticker" && action === "add") {
    const ownPacks: readonly string[] | null = stickerPacksForRecovery();
    if (ownPacks !== null && ownPacks.length > 0) {
      const ownPackSet: ReadonlySet<string> = new Set<string>(ownPacks);
      const blockedOwnPacks: readonly string[] = packs.filter(
        (pack: string): boolean => ownPackSet.has(pack)
      );
      if (blockedOwnPacks.length > 0) {
        await replyCommandNotice(
          ctx,
          texts.ownStickerPacksBlocked(formatPackList(blockedOwnPacks))
        );
        return;
      }
    }
  }

  const changedPacks: string[] = [];
  const unchangedPacks: string[] = [];
  let allPersisted: boolean = true;
  let hasUnconfirmedPersist: boolean = false;
  let storageFailed: boolean = false;

  for (const pack of packs) {
    try {
      const result: AdPackBlacklistPersistResult = action === "add"
        ? await persistAdPackBlacklistAdd(kind, pack)
        : await persistAdPackBlacklistRemove(kind, pack);
      if (result.changed) changedPacks.push(pack);
      else unchangedPacks.push(pack);
      if (!result.persisted) {
        allPersisted = false;
        hasUnconfirmedPersist = true;
      }
    } catch (error: unknown) {
      storageFailed = true;
      allPersisted = false;
      logger.error("Failed to mutate ad pack blacklist:", {
        chatId: ctx.chat.id,
        actorId,
        kind,
        action,
        pack,
      }, error);
      break;
    }
  }

  logger.operation("[TelegramCommand] /ad_detect blacklist", {
    chatId: ctx.chat.id,
    actorId,
    kind,
    action,
    packs,
    changed: changedPacks,
    persisted: allPersisted,
  });

  const kindLabel: string = kindLabelOf(kind, texts);
  const lines: string[] = [];
  if (changedPacks.length > 0 || unchangedPacks.length > 0) {
    lines.push(texts.mutationHeader(kindLabel, getAdPackBlacklistCount(kind)));
  }
  if (changedPacks.length > 0) {
    lines.push(
      action === "add"
        ? texts.addedLine(formatPackList(changedPacks))
        : texts.removedLine(formatPackList(changedPacks))
    );
  }
  if (unchangedPacks.length > 0) {
    lines.push(
      action === "add"
        ? texts.alreadyExistsLine(formatPackList(unchangedPacks))
        : texts.notFoundLine(formatPackList(unchangedPacks))
    );
  }
  if (storageFailed) {
    lines.push(texts.storageFailed);
  }
  if (hasUnconfirmedPersist) {
    lines.push(texts.persistUnconfirmedLine);
  }
  await replyCommandNotice(ctx, lines.join("\n"));
}

/**
 * `/ad_detect <sticker|emoji>` 黑名单管理子命令入口：先核验 `isCanControllAdDetectPermission`，
 * 再按大小写不敏感动作词分派至 `list`、`add` 或 `remove`。
 *
 * @param ctx grammY 命令上下文。
 * @param kind 已规范化的黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param args 紧随种类词之后的命令参数分词列表。
 */
export async function handleAdDetectBlacklistCommand(
  ctx: CommandContext<Context>,
  kind: AdPackBlacklistKind,
  args: readonly string[]
): Promise<void> {
  const actor: CachedUser | undefined = await rejectUnlessPermitted(
    ctx,
    "isCanControllAdDetectPermission",
    (actorLabel: string, atmosphere: AtmosphereTexts): string =>
      atmosphere.AD_DETECT_TOGGLE_TEXTS.rejection(actorLabel)
  );
  if (actor === undefined) return;

  const action: string | undefined = args[0]?.toLowerCase();
  const restArgs: readonly string[] = args.slice(1);
  if (action === "list") {
    await handleBlacklistList(ctx, kind, restArgs);
    return;
  }
  if (action === "add" || action === "remove") {
    await handleBlacklistMutate({
      ctx,
      actorId: actor.id,
      kind,
      action,
      rawPacks: restArgs,
    });
    return;
  }
  await replyCommandNotice(ctx, chatAtmosphere().AD_DETECT_BLACKLIST_TEXTS.usage);
}
