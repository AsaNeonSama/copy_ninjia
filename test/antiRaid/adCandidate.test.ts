/**
 * `packages/antiRaid/adCandidate.ts` 媒体候选提取与发送者所有权边界测试：
 * 覆盖普通图片、无图注纯图、图片文件与超限缩略图回退、静态/动态/视频/散装贴纸、
 * 禁止从 `reply_to_message` / `quote` 提取媒体、自身 inline 结果忽略媒体以及固定字段顺序。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Chat, Message } from "grammy/types";
import { MEDIA_MAX_DOWNLOAD_BYTES } from "../../packages/consts/aiChat/media";
import {
  DEFAULT_WHITELIST_PERMISSIONS,
  SUPER_ADMIN_WHITELIST_PERMISSIONS,
  TEMPORARY_AD_BYPASS_PERMISSIONS,
} from "../../packages/consts/whitelist";
import type { AdCandidateMessage } from "../../packages/types/antiRaid/adDetect";
import type { WhitelistPermissions } from "../../packages/types/identityPolicy";
import { identityFieldView } from "../helpers/identityCacheView";
import type { IdentityFieldView } from "../helpers/identityCacheView";

const whitelistField: IdentityFieldView<"whitelist"> = identityFieldView("whitelist");
const blocklistField: IdentityFieldView<"blocklist"> = identityFieldView("blocklist");
const temporaryAdBypassField: IdentityFieldView<"temporaryAdBypass"> = identityFieldView("temporaryAdBypass");
const activeVerificationSnapshots = new Map<string, unknown>();
const blockedIds = new Set<number>();
const temporaryAdBypassIds = new Set<number>();

mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  getEffectiveWhitelistPermissions: (id: number): Readonly<WhitelistPermissions> | undefined => {
    if (id === 1) return SUPER_ADMIN_WHITELIST_PERMISSIONS;
    if (id === 100) return DEFAULT_WHITELIST_PERMISSIONS;
    if (id === 101) return { ...DEFAULT_WHITELIST_PERMISSIONS, isCanBypassAdDetection: false };
    if (temporaryAdBypassIds.has(id)) return TEMPORARY_AD_BYPASS_PERMISSIONS;
    return undefined;
  },
  hasPermanentWhitelistPermission: (id: number): boolean => id === 1 || id === 100,
  hasWhitelistPermission: (id: number, key: string): boolean =>
    id === 1 || ((id === 100 || temporaryAdBypassIds.has(id)) && key === "isCanBypassAdDetection"),
  isWhitelisted: (id: number): boolean => id === 1 || id === 100 || id === 101,
  readEffectiveWhitelistOrBlocked: (id: number): "allowed" | "blocked" | "none" => {
    if (id === 1 || id === 100 || id === 101 || temporaryAdBypassIds.has(id)) {
      return "allowed";
    }
    return blockedIds.has(id) ? "blocked" : "none";
  },
}));
mock.module("../../packages/infra/identityPolicy/temporaryAdBypass", () => ({
  clearTemporaryAdBypassActivity: (): boolean => true,
  clearTemporaryAdBypassActivityOrThrow: (): void => {},
  hasActiveTemporaryAdBypassAt: (id: number): boolean => temporaryAdBypassIds.has(id),
  storedTemporaryAdBypassActivities: (): ReadonlyMap<number, never> => new Map<number, never>(),
  currentTemporaryAdBypassActivity: (): null => null,
}));
mock.module("../../packages/cache/main/antiRaid/verificationMirror", () => ({
  activeVerificationSnapshots,
  isActiveVerificationUser: (chatId: number, userId: number): boolean =>
    activeVerificationSnapshots.has(`${chatId}:${userId}`),
}));

const { adDetectionSenderId, buildAdCandidate } = await import("../../packages/antiRaid/adCandidate");
const { inlineResultSources } = await import("../../packages/cache/main/inlineResultSources");
const { recordInlineResultSources } = await import("../../packages/infra/inlineResultSources");
const { visibleSenderChat } = await import("../../packages/users/visibleSender");

const BOT_ID: number = 999;
const OBSERVED_AT_MS: number = Date.parse("2026-04-01T00:00:00Z");

const EXPECTED_CANDIDATE_KEYS: readonly string[] = [
  "type",
  "chatId",
  "senderId",
  "messageId",
  "observedAt",
  "text",
  "firstName",
  "lastName",
  "username",
  "isChannel",
  "isForwarded",
  "blocked",
  "justJoined",
  "linkUrls",
  "stickerSetName",
  "stickerFileId",
  "stickerFileUniqueId",
  "imageFileId",
  "imageFileUniqueId",
  "customEmojiIds",
  "sampleQuote",
  "sampleReplyTo",
];

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 42,
    date: 0,
    chat: { id: -1001, type: "supergroup", title: "测试群" },
    from: { id: 7, is_bot: false, first_name: "Sender", last_name: "", username: "sender" },
    ...overrides,
  } as Message;
}

function buildFromMessage(message: Message): AdCandidateMessage | undefined {
  const senderChat: Chat | undefined = visibleSenderChat(message);
  const senderId: number | undefined = adDetectionSenderId(message, BOT_ID, senderChat);
  if (senderId === undefined) return undefined;
  return buildAdCandidate({
    message,
    botId: BOT_ID,
    now: OBSERVED_AT_MS,
    senderId,
    senderChat,
  });
}

beforeEach((): void => {
  activeVerificationSnapshots.clear();
  blockedIds.clear();
  temporaryAdBypassIds.clear();
  inlineResultSources.clear();
  whitelistField.clear();
  blocklistField.clear();
  temporaryAdBypassField.clear();
  for (const id of [7, 8, -300]) {
    whitelistField.set(id, null);
    blocklistField.set(id, null);
    temporaryAdBypassField.set(id, null);
  }
});

describe("buildAdCandidate 媒体提取与固定 shape", () => {
  test("纯图片消息（无图注、无正文）保留候选并按上限选档填入 imageFileId 与固定键顺序", () => {
    const candidate: AdCandidateMessage | undefined = buildFromMessage(createMessage({
      photo: [
        { file_id: "photo-small", file_unique_id: "pu-small", width: 90, height: 90, file_size: 2_000 },
        { file_id: "photo-fit", file_unique_id: "pu-fit", width: 800, height: 600, file_size: 120_000 },
        {
          file_id: "photo-huge",
          file_unique_id: "pu-huge",
          width: 4000,
          height: 3000,
          file_size: MEDIA_MAX_DOWNLOAD_BYTES + 1,
        },
      ],
    }));

    expect(candidate).toBeDefined();
    expect(Object.keys(candidate!)).toEqual([...EXPECTED_CANDIDATE_KEYS]);
    expect(candidate?.text).toBe("");
    expect(candidate?.imageFileId).toBe("photo-fit");
    expect(candidate?.imageFileUniqueId).toBe("pu-fit");
    expect(candidate?.stickerSetName).toBeUndefined();
    expect(candidate?.stickerFileId).toBeUndefined();
    expect(candidate?.stickerFileUniqueId).toBeUndefined();
  });

  test("图片文件消息（含图注与无图注）按白名单提取并在原文件超限时回退缩略图", () => {
    const pngDoc: AdCandidateMessage | undefined = buildFromMessage(createMessage({
      document: {
        file_id: "doc-png",
        file_unique_id: "du-png",
        mime_type: "image/png",
        file_size: 50_000,
      },
    }));
    expect(pngDoc?.text).toBe("");
    expect(pngDoc?.imageFileId).toBe("doc-png");
    expect(pngDoc?.imageFileUniqueId).toBe("du-png");

    const oversizedDoc: AdCandidateMessage | undefined = buildFromMessage(createMessage({
      caption: "海报图",
      document: {
        file_id: "doc-big",
        file_unique_id: "du-big",
        mime_type: "image/webp",
        file_size: MEDIA_MAX_DOWNLOAD_BYTES + 10,
        thumbnail: {
          file_id: "doc-thumb",
          file_unique_id: "du-thumb",
          width: 320,
          height: 320,
          file_size: 10_000,
        },
      },
    }));
    expect(oversizedDoc?.text).toBe("海报图");
    expect(oversizedDoc?.imageFileId).toBe("doc-thumb");
    expect(oversizedDoc?.imageFileUniqueId).toBe("du-big");

    // 非图片 MIME 且无正文/图注不构成候选。
    const pdfDoc: AdCandidateMessage | undefined = buildFromMessage(createMessage({
      document: {
        file_id: "doc-pdf",
        file_unique_id: "du-pdf",
        mime_type: "application/pdf",
        file_size: 10_000,
      },
    }));
    expect(pdfDoc).toBeUndefined();
  });

  test("静态、散装及带缩略图的动态/视频贴纸均填入 stickerFileId 并保留候选", () => {
    // 静态贴纸（含 set_name）。
    const staticPackSticker: AdCandidateMessage | undefined = buildFromMessage(createMessage({
      sticker: {
        file_id: "st-static",
        file_unique_id: "su-static",
        type: "regular",
        width: 512,
        height: 512,
        is_animated: false,
        is_video: false,
        set_name: "AdStickerPack",
      },
    }));
    expect(staticPackSticker?.stickerSetName).toBe("AdStickerPack");
    expect(staticPackSticker?.stickerFileId).toBe("st-static");
    expect(staticPackSticker?.stickerFileUniqueId).toBe("su-static");

    // 散装静态贴纸（无 set_name、无正文）：仍保留候选以供视觉检测。
    const looseSticker: AdCandidateMessage | undefined = buildFromMessage(createMessage({
      sticker: {
        file_id: "st-loose",
        file_unique_id: "su-loose",
        type: "regular",
        width: 512,
        height: 512,
        is_animated: false,
        is_video: false,
      },
    }));
    expect(looseSticker?.text).toBe("");
    expect(looseSticker?.stickerSetName).toBeUndefined();
    expect(looseSticker?.stickerFileId).toBe("st-loose");
    expect(looseSticker?.stickerFileUniqueId).toBe("su-loose");

    // 动态与视频贴纸取缩略图 file_id，并保留贴纸自身 file_unique_id。
    const animatedSticker: AdCandidateMessage | undefined = buildFromMessage(createMessage({
      sticker: {
        file_id: "st-anim",
        file_unique_id: "su-anim",
        type: "regular",
        width: 512,
        height: 512,
        is_animated: true,
        is_video: false,
        thumbnail: {
          file_id: "st-anim-thumb",
          file_unique_id: "su-anim-thumb",
          width: 128,
          height: 128,
        },
      },
    }));
    expect(animatedSticker?.stickerFileId).toBe("st-anim-thumb");
    expect(animatedSticker?.stickerFileUniqueId).toBe("su-anim");

    const videoSticker: AdCandidateMessage | undefined = buildFromMessage(createMessage({
      sticker: {
        file_id: "st-vid",
        file_unique_id: "su-vid",
        type: "regular",
        width: 512,
        height: 512,
        is_animated: false,
        is_video: true,
        set_name: "VideoAdPack",
        thumbnail: {
          file_id: "st-vid-thumb",
          file_unique_id: "su-vid-thumb",
          width: 128,
          height: 128,
        },
      },
    }));
    expect(videoSticker?.stickerSetName).toBe("VideoAdPack");
    expect(videoSticker?.stickerFileId).toBe("st-vid-thumb");
    expect(videoSticker?.stickerFileUniqueId).toBe("su-vid");

    // 无缩略图的动态贴纸：有 set_name 时仍保留候选走黑名单快路径；无 set_name 时丢弃。
    const noThumbWithPack: AdCandidateMessage | undefined = buildFromMessage(createMessage({
      sticker: {
        file_id: "st-nothumb-pack",
        file_unique_id: "su-nothumb-pack",
        type: "regular",
        width: 512,
        height: 512,
        is_animated: true,
        is_video: false,
        set_name: "OnlyPackName",
      },
    }));
    expect(noThumbWithPack?.stickerSetName).toBe("OnlyPackName");
    expect(noThumbWithPack?.stickerFileId).toBeUndefined();
    expect(noThumbWithPack?.stickerFileUniqueId).toBeUndefined();

    const noThumbLoose: AdCandidateMessage | undefined = buildFromMessage(createMessage({
      sticker: {
        file_id: "st-nothumb-loose",
        file_unique_id: "su-nothumb-loose",
        type: "regular",
        width: 512,
        height: 512,
        is_animated: true,
        is_video: false,
      },
    }));
    expect(noThumbLoose).toBeUndefined();
  });

  test("绝不从 reply_to_message 或 quote 提取图片、贴纸或贴纸包名", () => {
    const repliedPhotoMsg: NonNullable<Message["reply_to_message"]> = {
      message_id: 9,
      date: 0,
      chat: { id: -1001, type: "supergroup", title: "测试群" },
      from: { id: 8, is_bot: false, first_name: "Other" },
      reply_to_message: undefined,
      photo: [{ file_id: "replied-photo", file_unique_id: "rpu-1", width: 800, height: 600 }],
      sticker: {
        file_id: "replied-sticker",
        file_unique_id: "rsu-1",
        type: "regular",
        width: 512,
        height: 512,
        is_animated: false,
        is_video: false,
        set_name: "RepliedStickerPack",
      },
      document: {
        file_id: "replied-doc",
        file_unique_id: "rdu-1",
        mime_type: "image/jpeg",
      },
    };

    // 被回复消息仅有媒体、无正文，且当前消息无自身内容时直接忽略。
    expect(buildFromMessage(createMessage({
      reply_to_message: repliedPhotoMsg,
    }))).toBeUndefined();

    // 当前消息带正文与引用片段，只保留文本/引用，不携带被回复消息的任何媒体字段。
    const withReplyText: AdCandidateMessage | undefined = buildFromMessage(createMessage({
      text: "这是什么图",
      quote: { text: "引用的一段话", position: 0, is_manual: true },
      reply_to_message: {
        ...repliedPhotoMsg,
        caption: "被回复图的说明",
      },
    }));
    expect(withReplyText).toBeDefined();
    expect(withReplyText?.text).toBe("这是什么图");
    expect(withReplyText?.sampleQuote).toBe("引用的一段话");
    expect(withReplyText?.sampleReplyTo).toBe("被回复图的说明");
    expect(withReplyText?.imageFileId).toBeUndefined();
    expect(withReplyText?.imageFileUniqueId).toBeUndefined();
    expect(withReplyText?.stickerSetName).toBeUndefined();
    expect(withReplyText?.stickerFileId).toBeUndefined();
    expect(withReplyText?.stickerFileUniqueId).toBeUndefined();
  });

  test("本机器人自己的 inline 结果仅送检登记源文本，不提取媒体字段", () => {
    recordInlineResultSources(7, "用户输入源文本", [{
      type: "article",
      id: "inline-1",
      title: "标题",
      input_message_content: { message_text: "渲染后的输出" },
    }]);
    const candidate: AdCandidateMessage | undefined = buildFromMessage(createMessage({
      via_bot: { id: BOT_ID, is_bot: true, first_name: "Bot" },
      text: "渲染后的输出",
      photo: [{ file_id: "self-inline-photo", file_unique_id: "sip-1", width: 512, height: 512 }],
      sticker: {
        file_id: "self-inline-sticker",
        file_unique_id: "sis-1",
        type: "regular",
        width: 512,
        height: 512,
        is_animated: false,
        is_video: false,
        set_name: "InlinePack",
      },
    }));
    expect(candidate?.text).toBe("用户输入源文本");
    expect(candidate?.imageFileId).toBeUndefined();
    expect(candidate?.imageFileUniqueId).toBeUndefined();
    expect(candidate?.stickerSetName).toBeUndefined();
    expect(candidate?.stickerFileId).toBeUndefined();
    expect(candidate?.stickerFileUniqueId).toBeUndefined();
  });

  test("永久白名单成员即使关闭 isCanBypassAdDetection 也不构建任何广告候选", () => {
    expect(buildFromMessage(createMessage({
      from: { id: 101, is_bot: false, first_name: "WhitelistMember" },
      text: "加我微信",
    }))).toBeUndefined();
    expect(buildFromMessage(createMessage({
      from: { id: 101, is_bot: false, first_name: "WhitelistMember" },
      photo: [{ file_id: "photo-1", file_unique_id: "pu-1", width: 800, height: 600 }],
    }))).toBeUndefined();
  });
});
