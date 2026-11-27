/**
 * `/ad_detect` 总入口命令测试：验证开关回归（`enable|disable`、配置就绪闸门、
 * 停用清理、权限边界、用法回执）以及向黑名单子命令的大小写不敏感分派。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import type { AdPackBlacklistPageSlice, ListAdPackBlacklistPageOptions } from "../../packages/infra/adPackBlacklistStorage";
import type { AdPackBlacklistKind, AdPackBlacklistPersistResult } from "../../packages/types/adPackBlacklist";
import type { ConfigReadiness } from "../../packages/types/config";
import { chatStateOf } from "../helpers/chatState";
import { replyCommandNoticeVia } from "../helpers/common";
import { groupCommandContext } from "../helpers/groupCommandContext";
import { loggerStub } from "../helpers/loggerMock";
import { lastReplyText } from "../helpers/replies";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const persistChatState = mock(async (..._args: unknown[]): Promise<void> => {});
const clearAdDetection = mock((..._args: unknown[]): void => {});
const loggerOperation = mock((..._args: unknown[]): void => {});
const loggerError = mock((..._args: unknown[]): void => {});
const getCustomEmojiStickers = mock(async (..._args: unknown[]): Promise<unknown[]> => []);
const logApiError = mock((..._args: unknown[]): void => {});

const delegatedPermissions = new Map<number, Set<string>>();
const blacklistStore: Record<AdPackBlacklistKind, Set<string>> = {
  sticker: new Set<string>(),
  emoji: new Set<string>(),
};
let adDetectReadiness: ConfigReadiness = { ok: true };

const { chatStateCache: states } = await import("../../packages/cache/main/chatState");

mock.module("../../packages/config/bot", () => ({
  BOT_ATMOSPHERE: "teasing",
  SUPER_ADMIN_USER_ID: 100,
}));
mock.module("../../packages/config/readiness", () => ({
  adDetectConfigReadiness: (): ConfigReadiness => adDetectReadiness,
}));
mock.module("../../packages/config/stickers", () => ({
  stickerPacksForRecovery: (): readonly string[] | null => null,
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
mock.module("../../packages/antiRaid", () => ({
  clearAdDetection,
}));
const realChatStateStorage = await import("../../packages/infra/chatStateStorage");
mock.module("../../packages/infra/chatStateStorage", () => ({
  ...realChatStateStorage,
  persistChatState,
  saveChatStateInBackground: (): void => {},
}));

mock.module("../../packages/infra/adPackBlacklistStorage", () => ({
  listAdPackBlacklistPage: async ({
    kind,
    page,
    pageSize,
    clampPage = true,
  }: Readonly<ListAdPackBlacklistPageOptions>): Promise<Readonly<AdPackBlacklistPageSlice>> => {
    const sorted: string[] = [...blacklistStore[kind]].sort(
      (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)
    );
    const total: number = sorted.length;
    const totalPages: number = Math.max(1, Math.ceil(total / pageSize));
    if (!clampPage && total > 0 && page > totalPages) {
      return { packs: [], page, pageSize, total, totalPages, kindTotal: total, outOfRange: true };
    }
    const effectivePage: number = clampPage ? Math.min(page, totalPages) : page;
    const offset: number = (effectivePage - 1) * pageSize;
    return {
      packs: sorted.slice(offset, offset + pageSize),
      page: effectivePage,
      pageSize,
      total,
      totalPages,
      kindTotal: total,
      outOfRange: false,
    };
  },
  getAdPackBlacklistCount: (kind: AdPackBlacklistKind): number => blacklistStore[kind].size,
  persistAdPackBlacklistAdd: async (kind: AdPackBlacklistKind, pack: string): Promise<AdPackBlacklistPersistResult> => {
    const existed = blacklistStore[kind].has(pack);
    blacklistStore[kind].add(pack);
    return { changed: !existed, persisted: true };
  },
  persistAdPackBlacklistRemove: async (kind: AdPackBlacklistKind, pack: string): Promise<AdPackBlacklistPersistResult> => {
    const deleted = blacklistStore[kind].delete(pack);
    return { changed: deleted, persisted: true };
  },
}));

const { handleAdDetectCommand } = await import("../../packages/commands/adDetect");
const { getChatState } = await import("../../packages/infra/chatStateStorage");

function commandCtx(match: string, userId: number | null = 100, chatId: number = -1001): never {
  return groupCommandContext({ match, userId, chatId, messageId: 42 });
}

beforeEach(() => {
  states.clear();
  delegatedPermissions.clear();
  blacklistStore.sticker.clear();
  blacklistStore.emoji.clear();
  adDetectReadiness = { ok: true };
  sendMessage.mockClear();
  persistChatState.mockClear();
  clearAdDetection.mockReset();
  loggerOperation.mockClear();
  loggerError.mockClear();
  getCustomEmojiStickers.mockClear();
  logApiError.mockClear();
});

describe("/ad_detect 入口分发与开关回归", () => {
  test("enable/disable 大小写不敏感地切换本群状态并在 disable 时清理 Worker 队列", async () => {
    await handleAdDetectCommand(commandCtx(" ENABLE "));
    expect(states.get(-1001)?.isAdDetectEnabled).toBe(true);
    expect(persistChatState).toHaveBeenCalledWith(-1001, "ad_detect toggled");
    expect(clearAdDetection).not.toHaveBeenCalled();
    expect(lastReplyText(sendMessage)).toBe(ATMOSPHERE_TEXTS.teasing.AD_DETECT_TOGGLE_TEXTS.enabled);

    await handleAdDetectCommand(commandCtx("Disable"));
    expect(getChatState(-1001).isAdDetectEnabled).toBe(false);
    expect(clearAdDetection).toHaveBeenCalledWith(-1001);
    expect(lastReplyText(sendMessage)).toBe(ATMOSPHERE_TEXTS.teasing.AD_DETECT_TOGGLE_TEXTS.disabled);
  });

  test("配置不可用时仅拒绝 enable，不影响 disable 与黑名单子命令", async () => {
    adDetectReadiness = {
      ok: false,
      failure: { file: "config/dynamic/ad_detect.json", reason: "missing" },
    };

    await handleAdDetectCommand(commandCtx("enable"));
    expect(states.size).toBe(0);
    expect(persistChatState).not.toHaveBeenCalled();
    expect(lastReplyText(sendMessage)).toContain("config/dynamic/ad_detect.json");

    states.set(-1001, chatStateOf({ isAdDetectEnabled: true }));
    await handleAdDetectCommand(commandCtx("disable"));
    expect(getChatState(-1001).isAdDetectEnabled).toBe(false);
    expect(clearAdDetection).toHaveBeenCalledWith(-1001);

    await handleAdDetectCommand(commandCtx("STICKER ADD SpamPack_1"));
    expect(blacklistStore.sticker.has("SpamPack_1")).toBe(true);
    expect(lastReplyText(sendMessage)).toContain("SpamPack_1");

    await handleAdDetectCommand(commandCtx("EMOJI list"));
    expect(lastReplyText(sendMessage)).toBe(
      ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS.listEmpty(
        ATMOSPHERE_TEXTS.teasing.AD_DETECT_BLACKLIST_TEXTS.kindEmoji
      )
    );
  });

  test("空参数、未知参数与多余参数回用法提示且包含黑名单子命令说明，且不设置 preserveInGroup", async () => {
    for (const match of ["", "unknown", "enable extra"]) {
      sendMessage.mockClear();
      await handleAdDetectCommand(commandCtx(match));
      expect(lastReplyText(sendMessage)).toBe(ATMOSPHERE_TEXTS.teasing.AD_DETECT_TOGGLE_TEXTS.usage);
      expect(lastReplyText(sendMessage)).toContain("sticker|emoji");
      const sentPayload = sendMessage.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(sentPayload.preserveInGroup).toBeUndefined();
    }
  });

  test("未授权身份执行 enable 与黑名单子命令均被拒绝且不改动任何状态", async () => {
    await handleAdDetectCommand(commandCtx("enable", 201));
    await handleAdDetectCommand(commandCtx("sticker add SpamPack", 201));
    await handleAdDetectCommand(commandCtx("emoji list", null));

    expect(states.size).toBe(0);
    expect(blacklistStore.sticker.size).toBe(0);
    expect(loggerOperation).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(lastReplyText(sendMessage)).toContain(ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.unknownActor);
  });

  test("获授 isCanControllAdDetectPermission 的白名单用户与频道均可切换开关并操作黑名单", async () => {
    delegatedPermissions.set(300, new Set(["isCanControllAdDetectPermission"]));
    delegatedPermissions.set(-500, new Set(["isCanControllAdDetectPermission"]));

    await handleAdDetectCommand(commandCtx("enable", 300));
    expect(states.get(-1001)?.isAdDetectEnabled).toBe(true);

    const channelCtx = commandCtx("emoji add ChannelSpamPack", 201) as unknown as {
      msg: Record<string, unknown>;
    };
    channelCtx.msg = {
      ...channelCtx.msg,
      sender_chat: { id: -500, type: "channel", title: "Ops Channel" },
    };
    await handleAdDetectCommand(channelCtx as never);

    expect(blacklistStore.emoji.has("ChannelSpamPack")).toBe(true);
    expect(loggerOperation).toHaveBeenCalledWith("[TelegramCommand] /ad_detect blacklist", {
      chatId: -1001,
      actorId: -500,
      kind: "emoji",
      action: "add",
      packs: ["ChannelSpamPack"],
      changed: ["ChannelSpamPack"],
      persisted: true,
    });
  });

  test("clearAdDetection 抛错时 /ad_detect disable 仍完成关闭且不上抛", async () => {
    clearAdDetection.mockImplementationOnce((): never => {
      throw new Error("worker unavailable");
    });
    states.set(-1001, chatStateOf({ isAdDetectEnabled: true }));

    await handleAdDetectCommand(commandCtx("disable"));
    expect(getChatState(-1001).isAdDetectEnabled).toBe(false);
    expect(lastReplyText(sendMessage)).toBe(ATMOSPHERE_TEXTS.teasing.AD_DETECT_TOGGLE_TEXTS.disabled);
  });
});
