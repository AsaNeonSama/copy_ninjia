import { chatAtmosphere } from "../../infra/atmosphere";
import type { AtmosphereTexts } from "../../types/atmosphere";
import type { InlineQueryResultArticle } from "grammy/types";
import { InlineKeyboard, InlineQueryResultBuilder } from "grammy";
import {
  RATE_LIMIT_MAX_CALLS_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
  SAME_QUESTION_LABEL_MAX_LEN,
} from "../../consts/luckChallenge";
import { getAssetConfig } from "../../config/assets";
import type { LuckDraw, SignedLuckResult } from "../../types/luckChallenge";
import { splitGraphemes } from "../../libs/text";
import { luckCacheKey } from "./key";
import { signLuckResultText } from "./receipt";

/**
 * 根据抽签的好运百分比选出占优的运势方向（行大运或倒大霉）及其对应百分比。
 * @param draw 运势抽签结果。
 * @returns 占优方向的标签与对应百分比。
 */
function pickDominantProbability(draw: LuckDraw): { label: string; percent: number } {
  const misfortunePercent: number = Math.round((100 - draw.fortunePercent) * 100) / 100;
  return draw.fortunePercent >= misfortunePercent
    ? { label: "行大运", percent: draw.fortunePercent }
    : { label: "倒大霉", percent: misfortunePercent };
}

/**
 * 原地重试、复用同款问题或转发到其他聊天。
 * @param text 所求事项文本；纯运势查询时为 undefined。
 * @returns 附带内联切换按钮的键盘。
 */
function buildRetryKeyboard(text: string | undefined): InlineKeyboard {
  const keyboard: InlineKeyboard = new InlineKeyboard().switchInlineCurrent("我也试试", "");
  if (text) {
    const characters: string[] = splitGraphemes(text);
    const sameQuestionLabel: string = characters.length > SAME_QUESTION_LABEL_MAX_LEN
      ? `${characters.slice(0, SAME_QUESTION_LABEL_MAX_LEN).join("")}...`
      : text;
    keyboard.switchInlineCurrent(sameQuestionLabel, text);
  }
  keyboard.row().switchInline("转发", text ?? "");
  return keyboard;
}

/** 构造「未卜先知」运势内联结果卡片所需的入参。 */
export interface BuildFortuneResultParams {
  /** 本次运势抽签结果。 */
  draw: LuckDraw;
  /** 查询用户的 ID。 */
  userId: number;
  /** 查询用户的展示标签。 */
  userLabel: string;
  /** 用户输入的所求事项；未填写时为 undefined。 */
  text: string | undefined;
}

/**
 * 构造「未卜先知」运势内联查询结果卡片。
 * @param params 抽签结果（`draw`）、查询用户 ID（`userId`）、展示标签（`userLabel`）与所求事项文本（`text`）。
 * @returns 带剧透签名回执与重试按钮的 Article 内联结果。
 */
export function buildFortuneResult({
  draw,
  userId,
  userLabel,
  text,
}: BuildFortuneResultParams): InlineQueryResultArticle {
  const comment: string = chatAtmosphere().LUCK_TIER_COMMENTS[draw.tier.label];
  const bodyText: string = text
    ? `你好，${userLabel}\n所求事项: ${text}\n结果: ${draw.tier.label}\n${comment}`
    : `你好，${userLabel}\n汝的今日运势: ${draw.tier.label}\n${comment}`;
  const signed: SignedLuckResult = signLuckResultText(bodyText, luckCacheKey(userId, text));
  return InlineQueryResultBuilder.article(text ? "luck-fortune-text" : "luck-fortune", "未卜先知", {
    description: text ? `所求事项：${text}` : "测测你今天的运势",
    reply_markup: buildRetryKeyboard(text),
    thumbnail_url: getAssetConfig().fortuneThumbnailUrl,
  }).text(signed.text, {
    entities: [
      { type: "spoiler", offset: signed.receiptOffset, length: signed.receiptLength },
      { type: "text_link", offset: signed.receiptOffset, length: signed.receiptLength, url: signed.receiptUrl },
    ],
    link_preview_options: { is_disabled: true },
  });
}

/**
 * 构造「概率论！」内联查询结果卡片。
 * @param draw 运势抽签结果。
 * @param userId 查询用户的 ID。
 * @param userLabel 查询用户的展示标签。
 * @returns 带剧透签名回执与重试按钮的 Article 内联结果。
 */
export function buildProbabilityResult(
  draw: LuckDraw,
  userId: number,
  userLabel: string
): InlineQueryResultArticle {
  const { label, percent }: { label: string; percent: number; } = pickDominantProbability(draw);
  const bodyText: string = `你好，${userLabel}\n汝今天${label}概率是 ${percent.toFixed(2)}%`;
  const signed: SignedLuckResult = signLuckResultText(bodyText, luckCacheKey(userId, undefined));
  return InlineQueryResultBuilder.article("luck-probability", "概率论！", {
    description: "看看你今天行大运/倒大霉的概率",
    reply_markup: buildRetryKeyboard(undefined),
    thumbnail_url: getAssetConfig().probabilityThumbnailUrl,
  }).text(signed.text, {
    entities: [
      { type: "spoiler", offset: signed.receiptOffset, length: signed.receiptLength },
      { type: "text_link", offset: signed.receiptOffset, length: signed.receiptLength, url: signed.receiptUrl },
    ],
    link_preview_options: { is_disabled: true },
  });
}

/**
 * 构造内联查询超额时的限流占位结果卡片。
 * @returns 限流提示的 Article 内联结果。
 */
export function buildRateLimitedResult(): InlineQueryResultArticle {
  // inline 查询没有目标群上下文，使用本进程生效的 Bot 配置。
  const atmosphere: AtmosphereTexts = chatAtmosphere();
  const windowSeconds: number = RATE_LIMIT_WINDOW_MS / 1000;
  return InlineQueryResultBuilder.article("luck-rate-limited", atmosphere.NOTICE_TEXTS.inlineRateLimitTitle, {
    description: atmosphere.NOTICE_TEXTS.inlineRateLimitDescription(windowSeconds, RATE_LIMIT_MAX_CALLS_PER_WINDOW),
  }).text(atmosphere.NOTICE_TEXTS.inlineRateLimitBody(windowSeconds, RATE_LIMIT_MAX_CALLS_PER_WINDOW));
}
