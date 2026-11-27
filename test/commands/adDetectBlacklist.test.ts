/**
 * `/ad_detect <sticker|emoji> <list|add|remove>` 黑名单子命令全链路单测：
 * 覆盖权限边界、大小写不敏感子命令、SQLite 游标冷读分页与边界、显式增删与全量前置校验、
 * 回复贴纸/自定义表情（含分批查询与失败处理）推断、己方 `stickers.json` 护栏、
 * 落盘未确认警告、存储读写异常、审计日志与 30 秒自动清理边界。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import { NEUTRALIZED_SOLIDUS } from "../../packages/consts/renderableCommand";
import { TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS } from "../../packages/consts/telegram";
import type {
  AdPackBlacklistPageSlice,
  ListAdPackBlacklistPageOptions,
} from "../../packages/infra/adPackBlacklistStorage";
import { containsRenderableCommand } from "../../packages/libs/renderableCommand";
import type { AdPackBlacklistKind, AdPackBlacklistPersistResult } from "../../packages/types/adPackBlacklist";
import type { Atmosphere } from "../../packages/types/atmosphere";
import { replyCommandNoticeVia } from "../helpers/common";
import { groupCommandContext } from "../helpers/groupCommandContext";
import { loggerStub } from "../helpers/loggerMock";
import { lastReplyText } from "../helpers/replies";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const loggerOperation = mock((..._args: unknown[]): void => {});
const loggerError = mock((..._args: unknown[]): void => {});
const logApiError = mock((..._args: unknown[]): void => {});
const getCustomEmojiStickers = mock(async (..._args: unknown[]): Promise<unknown[]> => []);
const listPageOverride = mock(
  async (options: Readonly<ListAdPackBlacklistPageOptions>): Promise<Readonly<AdPackBlacklistPageSlice>> =>
    defaultListPage(options)
);
const persistAddOverride = mock(
  async (kind: AdPackBlacklistKind, pack: string): Promise<AdPackBlacklistPersistResult> => {
    if (blacklistStore[kind].has(pack)) return { changed: false, persisted: true };
    blacklistStore[kind].add(pack);
    return { changed: true, persisted: true };
  }
);
const persistRemoveOverride = mock(
  async (kind: AdPackBlacklistKind, pack: string): Promise<AdPackBlacklistPersistResult> => {
    const deleted = blacklistStore[kind].delete(pack);
    return { changed: deleted, persisted: true };
  }
);

const delegatedPermissions = new Map<number, Set<string>>();
const blacklistStore: Record<AdPackBlacklistKind, Set<string>> = {
  sticker: new Set<string>(),
  emoji: new Set<string>(),
};
let ownStickerPacks: readonly string[] | null = null;
let currentAtmosphere: Atmosphere = "teasing";

function defaultListPage({
  kind,
  page,
  pageSize,
  clampPage = true,
}: Readonly<ListAdPackBlacklistPageOptions>): Promise<Readonly<AdPackBlacklistPageSlice>> {
  const sorted: string[] = [...blacklistStore[kind]].sort(
    (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)
  );
  const total: number = sorted.length;
  const totalPages: number = Math.max(1, Math.ceil(total / pageSize));
  if (!clampPage && total > 0 && page > totalPages) {
    return Promise.resolve({
      packs: [],
      page,
      pageSize,
      total,
      totalPages,
      kindTotal: total,
      outOfRange: true,
    });
  }
  const effectivePage: number = clampPage ? Math.min(page, totalPages) : page;
  const offset: number = (effectivePage - 1) * pageSize;
  return Promise.resolve({
    packs: sorted.slice(offset, offset + pageSize),
    page: effectivePage,
    pageSize,
    total,
    totalPages,
    kindTotal: total,
    outOfRange: false,
  });
}

function defaultPersistAdd(
  kind: AdPackBlacklistKind,
  pack: string
): Promise<AdPackBlacklistPersistResult> {
  if (blacklistStore[kind].has(pack)) return Promise.resolve({ changed: false, persisted: true });
  blacklistStore[kind].add(pack);
  return Promise.resolve({ changed: true, persisted: true });
}

function defaultPersistRemove(
  kind: AdPackBlacklistKind,
  pack: string
): Promise<AdPackBlacklistPersistResult> {
  const deleted = blacklistStore[kind].delete(pack);
  return Promise.resolve({ changed: deleted, persisted: true });
}

mock.module("../../packages/config/bot", () => ({
  BOT_ATMOSPHERE: "teasing",
  SUPER_ADMIN_USER_ID: 100,
}));
mock.module("../../packages/infra/atmosphere", () => ({
  chatAtmosphere: () => ATMOSPHERE_TEXTS[currentAtmosphere],
}));
mock.module("../../packages/config/stickers", () => ({
  stickerPacksForRecovery: (): readonly string[] | null => ownStickerPacks,
}));
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  hasWhitelistPermission: (id: number, key: string): boolean =>
    id === 100 || delegatedPermissions.get(id)?.has(key) === true,
}));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
  replyCommandNotice: replyCommandNoticeVia(sendMessage),
}));
mock.module("../../packages/infra/telegram/client", () => ({
  telegramApi: { getCustomEmojiStickers },
  logApiError,
}));
mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({ operation: loggerOperation, error: loggerError }),
}));
mock.module("../../packages/infra/adPackBlacklistStorage", () => ({
  listAdPackBlacklistPage: (
    options: Readonly<ListAdPackBlacklistPageOptions>
  ): Promise<Readonly<AdPackBlacklistPageSlice>> => listPageOverride(options),
  getAdPackBlacklistCount: (kind: AdPackBlacklistKind): number => blacklistStore[kind].size,
  persistAdPackBlacklistAdd: (kind: AdPackBlacklistKind, pack: string): Promise<AdPackBlacklistPersistResult> =>
    persistAddOverride(kind, pack),
  persistAdPackBlacklistRemove: (kind: AdPackBlacklistKind, pack: string): Promise<AdPackBlacklistPersistResult> =>
    persistRemoveOverride(kind, pack),
}));

const { handleAdDetectBlacklistCommand } = await import("../../packages/commands/adDetectBlacklist");
const { runWithUpdateAbortSignal } = await import("../../packages/infra/updateContext");

function blacklistCtx(options: {
  userId?: number | null;
  chatId?: number;
  replyToMessage?: object;
  isTopicMessage?: boolean;
  messageThreadId?: number;
} = {}): never {
  const ctx = groupCommandContext({
    userId: options.userId ?? 100,
    chatId: options.chatId ?? -1001,
    messageId: 88,
    replyToMessage: options.replyToMessage,
  }) as unknown as { msg: Record<string, unknown> };
  if (options.isTopicMessage === true) ctx.msg.is_topic_message = true;
  if (options.messageThreadId !== undefined) ctx.msg.message_thread_id = options.messageThreadId;
  return ctx as never;
}

function assertAllRepliesAutoDelete(): void {
  for (const call of sendMessage.mock.calls) {
    const payload = call[0] as Record<string, unknown>;
    expect(payload.preserveInGroup).toBeUndefined();
    expect(payload.parseMode).toBeUndefined();
  }
}

beforeEach(() => {
  delegatedPermissions.clear();
  blacklistStore.sticker.clear();
  blacklistStore.emoji.clear();
  ownStickerPacks = null;
  currentAtmosphere = "teasing";
  sendMessage.mockClear();
  loggerOperation.mockClear();
  loggerError.mockClear();
  logApiError.mockClear();
  getCustomEmojiStickers.mockReset();
  getCustomEmojiStickers.mockImplementation(async (): Promise<unknown[]> => []);
  listPageOverride.mockReset();
  listPageOverride.mockImplementation(defaultListPage);
  persistAddOverride.mockReset();
  persistAddOverride.mockImplementation(defaultPersistAdd);
  persistRemoveOverride.mockReset();
  persistRemoveOverride.mockImplementation(defaultPersistRemove);
});

describe("权限校验与基础子命令分派", () => {
  test("无 isCanControllAdDetectPermission 权限者执行 list/add/remove 均被拒绝", async () => {
    delegatedPermissions.set(202, new Set(["isCanBlock"]));

    await handleAdDetectBlacklistCommand(blacklistCtx({ userId: 202 }), "sticker", ["list"]);
    await handleAdDetectBlacklistCommand(blacklistCtx({ userId: 202 }), "sticker", ["add", "SpamPack"]);
    await handleAdDetectBlacklistCommand(blacklistCtx({ userId: 202 }), "emoji", ["remove", "EmojiSpam"]);

    expect(blacklistStore.sticker.size).toBe(0);
    expect(persistAddOverride).not.toHaveBeenCalled();
    expect(persistRemoveOverride).not.toHaveBeenCalled();
    expect(loggerOperation).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(lastReplyText(sendMessage)).toBe(
      ATMOSPHERE_TEXTS.teasing.AD_DETECT_TOGGLE_TEXTS.rejection("@admin")
    );
    assertAllRepliesAutoDelete();
  });

  test("缺失或未知动作回复黑名单子命令用法", async () => {
    await handleAdDetectBlacklistCommand(blacklistCtx(), "sticker", []);
    expect(lastReplyText(sendMessage)).toBe(ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS.usage);

    await handleAdDetectBlacklistCommand(blacklistCtx(), "emoji", ["clear"]);
    expect(lastReplyText(sendMessage)).toBe(ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS.usage);
    assertAllRepliesAutoDelete();
  });

  test("plain 氛围同样完整渲染全部黑名单文案且不带默认人设口吻", async () => {
    currentAtmosphere = "plain";
    const plainTexts = ATMOSPHERE_TEXTS.plain.AD_DETECT_BLACKLIST_TEXTS;
    await handleAdDetectBlacklistCommand(blacklistCtx(), "sticker", ["list"]);
    expect(lastReplyText(sendMessage)).toBe(
      plainTexts.listEmpty(plainTexts.kindSticker)
    );
    await handleAdDetectBlacklistCommand(blacklistCtx(), "sticker", ["add", "PlainPack_1"]);
    expect(lastReplyText(sendMessage)).toBe(
      [
        plainTexts.mutationHeader(plainTexts.kindSticker, 1),
        plainTexts.addedLine("PlainPack_1"),
      ].join("\n")
    );
    expect(lastReplyText(sendMessage)).not.toMatch(/本天才|杂鱼|笨蛋|♡|哼/);
    assertAllRepliesAutoDelete();
  });
});

describe("list 分页与边界校验", () => {
  test("空列表清晰提示当前条数为 0", async () => {
    const teasingTexts = ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS;
    await handleAdDetectBlacklistCommand(blacklistCtx(), "sticker", ["LIST"]);
    expect(lastReplyText(sendMessage)).toBe(
      teasingTexts.listEmpty(teasingTexts.kindSticker)
    );

    await handleAdDetectBlacklistCommand(blacklistCtx(), "emoji", ["list", "1"]);
    expect(lastReplyText(sendMessage)).toBe(
      teasingTexts.listEmpty(teasingTexts.kindEmoji)
    );
    assertAllRepliesAutoDelete();
  });

  test("按升序以每页 20 条分页输出，越界页清晰回报总页数与总条数", async () => {
    const teasingTexts = ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS;
    for (let index = 1; index <= 25; index += 1) {
      blacklistStore.sticker.add(`Pack_${String(index).padStart(2, "0")}`);
    }

    await handleAdDetectBlacklistCommand(blacklistCtx(), "sticker", ["list"]);
    const page1 = lastReplyText(sendMessage);
    expect(page1).toContain(
      teasingTexts.listHeader({
        kindLabel: teasingTexts.kindSticker,
        page: 1,
        totalPages: 2,
        total: 25,
      })
    );
    expect(page1).toContain("1. Pack_01");
    expect(page1).toContain("20. Pack_20");
    expect(page1).not.toContain("21. Pack_21");

    await handleAdDetectBlacklistCommand(blacklistCtx(), "sticker", ["LIST", "2"]);
    const page2 = lastReplyText(sendMessage);
    expect(page2).toContain(
      teasingTexts.listHeader({
        kindLabel: teasingTexts.kindSticker,
        page: 2,
        totalPages: 2,
        total: 25,
      })
    );
    expect(page2).toContain("21. Pack_21");
    expect(page2).toContain("25. Pack_25");
    expect(page2).not.toContain("20. Pack_20");

    await handleAdDetectBlacklistCommand(blacklistCtx(), "sticker", ["list", "3"]);
    expect(lastReplyText(sendMessage)).toBe(
      teasingTexts.listOutOfRange({
        kindLabel: teasingTexts.kindSticker,
        page: 3,
        totalPages: 2,
        total: 25,
      })
    );
    assertAllRepliesAutoDelete();
  });

  test("非法页码（0、负数、前导零、小数、非数字、多余参数）一律拒绝", async () => {
    blacklistStore.emoji.add("Emoji_1");
    for (const args of [
      ["list", "0"],
      ["list", "-1"],
      ["list", "01"],
      ["list", "1.5"],
      ["list", "abc"],
      ["list", "1", "2"],
    ]) {
      sendMessage.mockClear();
      await handleAdDetectBlacklistCommand(blacklistCtx(), "emoji", args);
      expect(lastReplyText(sendMessage)).toBe(
        ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS.listInvalidPage
      );
    }
    assertAllRepliesAutoDelete();
  });
});

describe("显式 add / remove、去重、大小写保留与全量前置校验", () => {
  test("大小写不敏感子命令保留包名原大小写、保序去重并分类汇报新增/已存在与移除/不存在", async () => {
    blacklistStore.sticker.add("Existing_Pack");

    await handleAdDetectBlacklistCommand(
      blacklistCtx(),
      "sticker",
      ["AdD", "New_PackA", "Existing_Pack", "New_PackA", "MixedCase_B"]
    );

    expect(persistAddOverride.mock.calls).toEqual([
      ["sticker", "New_PackA"],
      ["sticker", "Existing_Pack"],
      ["sticker", "MixedCase_B"],
    ]);
    const teasingTexts = ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS;
    expect(lastReplyText(sendMessage)).toBe(
      [
        teasingTexts.mutationHeader(teasingTexts.kindSticker, 3),
        teasingTexts.addedLine("New_PackA、MixedCase_B"),
        teasingTexts.alreadyExistsLine("Existing_Pack"),
      ].join("\n")
    );
    expect(loggerOperation).toHaveBeenLastCalledWith("[TelegramCommand] /ad_detect blacklist", {
      chatId: -1001,
      actorId: 100,
      kind: "sticker",
      action: "add",
      packs: ["New_PackA", "Existing_Pack", "MixedCase_B"],
      changed: ["New_PackA", "MixedCase_B"],
      persisted: true,
    });

    await handleAdDetectBlacklistCommand(
      blacklistCtx(),
      "sticker",
      ["ReMoVe", "New_PackA", "Missing_Pack", "New_PackA"]
    );

    expect(persistRemoveOverride.mock.calls).toEqual([
      ["sticker", "New_PackA"],
      ["sticker", "Missing_Pack"],
    ]);
    expect(lastReplyText(sendMessage)).toBe(
      [
        teasingTexts.mutationHeader(teasingTexts.kindSticker, 2),
        teasingTexts.removedLine("New_PackA"),
        teasingTexts.notFoundLine("Missing_Pack"),
      ].join("\n")
    );
    expect(loggerOperation).toHaveBeenLastCalledWith("[TelegramCommand] /ad_detect blacklist", {
      chatId: -1001,
      actorId: 100,
      kind: "sticker",
      action: "remove",
      packs: ["New_PackA", "Missing_Pack"],
      changed: ["New_PackA"],
      persisted: true,
    });
    assertAllRepliesAutoDelete();
  });

  test("任一包名不符合 STICKER_PACK_NAME_PATTERN 时整批拒绝且不执行任何写入或审计", async () => {
    const teasingTexts = ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS;
    const tooLong = "a".repeat(65);
    await handleAdDetectBlacklistCommand(
      blacklistCtx(),
      "sticker",
      ["add", "ValidPack_1", "bad-pack!", tooLong]
    );

    expect(persistAddOverride).not.toHaveBeenCalled();
    expect(blacklistStore.sticker.size).toBe(0);
    expect(loggerOperation).not.toHaveBeenCalled();
    expect(lastReplyText(sendMessage)).toBe(
      teasingTexts.invalidPacks(`bad-pack!、${"a".repeat(64)}`)
    );
    assertAllRepliesAutoDelete();
  });

  test("非法包名回执剥除双向控制符并中和可渲染 Telegram /command", async () => {
    const teasingTexts = ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS;
    await handleAdDetectBlacklistCommand(
      blacklistCtx(),
      "sticker",
      ["add", "evil\u202epack", "/start", "bad /mute@bot"]
    );

    expect(persistAddOverride).not.toHaveBeenCalled();
    expect(blacklistStore.sticker.size).toBe(0);
    expect(loggerOperation).not.toHaveBeenCalled();
    const reply = lastReplyText(sendMessage);
    expect(reply).not.toContain("\u202e");
    expect(reply).not.toContain("/start");
    expect(reply).not.toContain("/mute");
    expect(containsRenderableCommand(reply)).toBe(false);
    expect(reply).toBe(
      teasingTexts.invalidPacks(
        `evilpack、${NEUTRALIZED_SOLIDUS}start、bad ${NEUTRALIZED_SOLIDUS}mute@bot`
      )
    );
    assertAllRepliesAutoDelete();
  });
});

describe("回复消息推断（贴纸与自定义表情）", () => {
  test("省略包名且未显式回复（含论坛话题隐式 reply_to_message）时给出缺失提示", async () => {
    const teasingTexts = ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS;
    await handleAdDetectBlacklistCommand(blacklistCtx(), "sticker", ["add"]);
    expect(lastReplyText(sendMessage)).toBe(
      teasingTexts.missingPacks(teasingTexts.kindSticker, "/ad_detect sticker add")
    );

    // 论坛话题里指向话题根消息的 reply_to_message 不算显式回复。
    await handleAdDetectBlacklistCommand(
      blacklistCtx({
        isTopicMessage: true,
        messageThreadId: 500,
        replyToMessage: { message_id: 500, sticker: { set_name: "TopicSticker" } },
      }),
      "sticker",
      ["add"]
    );
    expect(persistAddOverride).not.toHaveBeenCalled();
    expect(lastReplyText(sendMessage)).toBe(
      teasingTexts.missingPacks(teasingTexts.kindSticker, "/ad_detect sticker add")
    );
    assertAllRepliesAutoDelete();
  });

  test("sticker add/remove 回复贴纸消息提取 set_name；非贴纸或无 set_name 时拒绝", async () => {
    await handleAdDetectBlacklistCommand(
      blacklistCtx({ replyToMessage: { message_id: 11, text: "plain text" } }),
      "sticker",
      ["add"]
    );
    expect(lastReplyText(sendMessage)).toBe(
      ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS.replyMissingStickerPack
    );

    await handleAdDetectBlacklistCommand(
      blacklistCtx({ replyToMessage: { message_id: 12, sticker: { file_id: "f1" } } }),
      "sticker",
      ["add"]
    );
    expect(lastReplyText(sendMessage)).toBe(
      ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS.replyMissingStickerPack
    );

    await handleAdDetectBlacklistCommand(
      blacklistCtx({ replyToMessage: { message_id: 13, sticker: { set_name: "RepliedStickerPack" } } }),
      "sticker",
      ["add"]
    );
    expect(blacklistStore.sticker.has("RepliedStickerPack")).toBe(true);

    await handleAdDetectBlacklistCommand(
      blacklistCtx({ replyToMessage: { message_id: 13, sticker: { set_name: "RepliedStickerPack" } } }),
      "sticker",
      ["remove"]
    );
    expect(blacklistStore.sticker.has("RepliedStickerPack")).toBe(false);
    assertAllRepliesAutoDelete();
  });

  test("emoji add/remove 合并提取 entities 与 caption_entities 中的自定义表情并去重查询", async () => {
    getCustomEmojiStickers.mockImplementationOnce(async (): Promise<unknown[]> => [
      { custom_emoji_id: "e1", set_name: "EmojiPack_A" },
      { custom_emoji_id: "e2", set_name: "EmojiPack_A" },
      { custom_emoji_id: "e3", set_name: "EmojiPack_B" },
      { custom_emoji_id: "e4" },
    ]);

    await handleAdDetectBlacklistCommand(
      blacklistCtx({
        replyToMessage: {
          message_id: 21,
          entities: [
            { type: "bold", offset: 0, length: 1 },
            { type: "custom_emoji", offset: 1, length: 2, custom_emoji_id: "e1" },
            { type: "custom_emoji", offset: 3, length: 2, custom_emoji_id: "e2" },
          ],
          caption_entities: [
            { type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "e2" },
            { type: "custom_emoji", offset: 2, length: 2, custom_emoji_id: "e3" },
            { type: "custom_emoji", offset: 4, length: 2, custom_emoji_id: "e4" },
          ],
        },
      }),
      "emoji",
      ["add"]
    );

    expect(getCustomEmojiStickers).toHaveBeenCalledWith(["e1", "e2", "e3", "e4"]);
    expect([...blacklistStore.emoji]).toEqual(["EmojiPack_A", "EmojiPack_B"]);
    expect(loggerOperation).toHaveBeenLastCalledWith("[TelegramCommand] /ad_detect blacklist", {
      chatId: -1001,
      actorId: 100,
      kind: "emoji",
      action: "add",
      packs: ["EmojiPack_A", "EmojiPack_B"],
      changed: ["EmojiPack_A", "EmojiPack_B"],
      persisted: true,
    });
    assertAllRepliesAutoDelete();
  });

  test("emoji 数量超过 TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS 时按 200 分批查询", async () => {
    const totalIds = TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS + 5;
    const entities = Array.from({ length: totalIds }, (_value: unknown, index: number) => ({
      type: "custom_emoji",
      offset: index,
      length: 1,
      custom_emoji_id: `ce_${index}`,
    }));
    getCustomEmojiStickers
      .mockImplementationOnce(async (): Promise<unknown[]> => [{ set_name: "BatchPack_1" }])
      .mockImplementationOnce(async (): Promise<unknown[]> => [{ set_name: "BatchPack_2" }]);

    await handleAdDetectBlacklistCommand(
      blacklistCtx({ replyToMessage: { message_id: 22, entities } }),
      "emoji",
      ["add"]
    );

    expect(getCustomEmojiStickers).toHaveBeenCalledTimes(2);
    expect((getCustomEmojiStickers.mock.calls[0]?.[0] as string[]).length).toBe(
      TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS
    );
    expect((getCustomEmojiStickers.mock.calls[1]?.[0] as string[]).length).toBe(5);
    expect([...blacklistStore.emoji]).toEqual(["BatchPack_1", "BatchPack_2"]);
    assertAllRepliesAutoDelete();
  });

  test("emoji 回复缺失自定义表情、Telegram 查询失败或无 set_name 时清晰提示且不写入", async () => {
    await handleAdDetectBlacklistCommand(
      blacklistCtx({ replyToMessage: { message_id: 31, text: "no emoji" } }),
      "emoji",
      ["add"]
    );
    expect(lastReplyText(sendMessage)).toBe(
      ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS.replyMissingEmoji
    );

    const apiError = new Error("telegram 502");
    getCustomEmojiStickers.mockRejectedValueOnce(apiError);
    await handleAdDetectBlacklistCommand(
      blacklistCtx({
        replyToMessage: {
          message_id: 32,
          entities: [{ type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "e_fail" }],
        },
      }),
      "emoji",
      ["add"]
    );
    expect(logApiError).toHaveBeenCalledWith(
      "resolve custom emoji blacklist packs",
      apiError,
      expect.objectContaining({ chatId: -1001, actorId: 100, batchSize: 1 })
    );
    expect(lastReplyText(sendMessage)).toBe(
      ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS.replyEmojiQueryFailed
    );

    getCustomEmojiStickers.mockResolvedValueOnce([{ custom_emoji_id: "e_none" }]);
    await handleAdDetectBlacklistCommand(
      blacklistCtx({
        replyToMessage: {
          message_id: 33,
          entities: [{ type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "e_none" }],
        },
      }),
      "emoji",
      ["add"]
    );
    expect(lastReplyText(sendMessage)).toBe(
      ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS.replyEmojiNoPack
    );
    expect(blacklistStore.emoji.size).toBe(0);
    expect(loggerOperation).not.toHaveBeenCalled();
    assertAllRepliesAutoDelete();
  });

  test("停机中止 update 时 getCustomEmojiStickers 抛出的中止异常原样上抛而不误报查询失败", async () => {
    const controller = new AbortController();
    getCustomEmojiStickers.mockImplementationOnce(async (): Promise<unknown[]> => {
      controller.abort(new DOMException("shutdown", "AbortError"));
      throw controller.signal.reason;
    });

    await expect(
      runWithUpdateAbortSignal(controller.signal, () =>
        handleAdDetectBlacklistCommand(
          blacklistCtx({
            replyToMessage: {
              message_id: 34,
              entities: [{ type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "e_abort" }],
            },
          }),
          "emoji",
          ["add"]
        )
      )
    ).rejects.toThrow("shutdown");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logApiError).not.toHaveBeenCalled();
  });
});

describe("己方 stickers.json 护栏、落盘警告与存储读写失败", () => {
  test("sticker add（显式参数与回复推断）拒绝己方 stickers.json 贴纸包，emoji add 不受限", async () => {
    const teasingTexts = ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS;
    ownStickerPacks = ["BotOwnPack", "BotOwnPack2"];

    await handleAdDetectBlacklistCommand(
      blacklistCtx(),
      "sticker",
      ["add", "OtherValidPack", "BotOwnPack"]
    );
    expect(persistAddOverride).not.toHaveBeenCalled();
    expect(blacklistStore.sticker.size).toBe(0);
    expect(loggerOperation).not.toHaveBeenCalled();
    expect(lastReplyText(sendMessage)).toBe(teasingTexts.ownStickerPacksBlocked("BotOwnPack"));

    await handleAdDetectBlacklistCommand(
      blacklistCtx({ replyToMessage: { message_id: 41, sticker: { set_name: "BotOwnPack2" } } }),
      "sticker",
      ["add"]
    );
    expect(persistAddOverride).not.toHaveBeenCalled();
    expect(lastReplyText(sendMessage)).toBe(teasingTexts.ownStickerPacksBlocked("BotOwnPack2"));

    // emoji add 允许同名包（stickers.json 仅保护贴纸包）。
    await handleAdDetectBlacklistCommand(blacklistCtx(), "emoji", ["add", "BotOwnPack"]);
    expect(blacklistStore.emoji.has("BotOwnPack")).toBe(true);
    expect(loggerOperation).toHaveBeenCalledTimes(1);
    assertAllRepliesAutoDelete();
  });

  test("list 冷读分页失败时记录错误日志并回报存储异常提示", async () => {
    const readError = new Error("sqlite cursor read failed");
    listPageOverride.mockRejectedValueOnce(readError);

    await handleAdDetectBlacklistCommand(blacklistCtx(), "sticker", ["list", "1"]);

    expect(loggerError).toHaveBeenCalledWith(
      "Failed to list ad pack blacklist page:",
      { chatId: -1001, kind: "sticker", page: 1 },
      readError
    );
    expect(lastReplyText(sendMessage)).toBe(
      ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS.storageFailed
    );
    assertAllRepliesAutoDelete();
  });

  test("persisted === false 时明确警告落盘未确认并在审计日志标记 persisted: false", async () => {
    const teasingTexts = ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS;
    persistAddOverride.mockResolvedValueOnce({ changed: true, persisted: false });
    blacklistStore.sticker.add("UnconfirmedPack");

    await handleAdDetectBlacklistCommand(blacklistCtx(), "sticker", ["add", "UnconfirmedPack"]);

    expect(lastReplyText(sendMessage)).toBe(
      [
        teasingTexts.mutationHeader(teasingTexts.kindSticker, 1),
        teasingTexts.addedLine("UnconfirmedPack"),
        teasingTexts.persistUnconfirmedLine,
      ].join("\n")
    );
    expect(loggerOperation).toHaveBeenLastCalledWith("[TelegramCommand] /ad_detect blacklist", {
      chatId: -1001,
      actorId: 100,
      kind: "sticker",
      action: "add",
      packs: ["UnconfirmedPack"],
      changed: ["UnconfirmedPack"],
      persisted: false,
    });
    assertAllRepliesAutoDelete();
  });

  test("非容量存储异常记录错误日志、回报失败且发出 persisted: false 审计", async () => {
    const storageError = new Error("disk queue refused");
    persistRemoveOverride.mockRejectedValueOnce(storageError);

    await handleAdDetectBlacklistCommand(blacklistCtx(), "emoji", ["remove", "BrokenPack"]);

    expect(loggerError).toHaveBeenCalledWith(
      "Failed to mutate ad pack blacklist:",
      expect.objectContaining({
        chatId: -1001,
        actorId: 100,
        kind: "emoji",
        action: "remove",
        pack: "BrokenPack",
      }),
      storageError
    );
    expect(lastReplyText(sendMessage)).toBe(
      ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS.storageFailed
    );
    expect(loggerOperation).toHaveBeenLastCalledWith("[TelegramCommand] /ad_detect blacklist", {
      chatId: -1001,
      actorId: 100,
      kind: "emoji",
      action: "remove",
      packs: ["BrokenPack"],
      changed: [],
      persisted: false,
    });
    assertAllRepliesAutoDelete();
  });
});
