import type { Sticker } from "grammy/types";

/** 贴纸包中已完成识图入库、可供 AI 回复工具浏览与发送的单枚候选贴纸。 */
export interface StickerCandidate {
  sticker: Sticker;
  emoji: string;
  description: string;
}

/** 已预热就绪、注入 AI 回复工具集的单个候选贴纸包。 */
export interface StickerPackCandidate {
  pack: string;
  title: string;
  summary: string;
  stickers: StickerCandidate[];
}

/** 单轮 AI 回复内贴纸工具的查看与发送状态（强制先 view_sticker_pack 再 send_sticker，且同轮去重）。 */
export interface StickerRoundState {
  viewedPackIntents: Map<number, string>;
  acceptedStickerUids: Set<string>;
}
