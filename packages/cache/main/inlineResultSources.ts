/** owner: main。inline 应答源文本缓存（packages/infra/inlineResultSources.ts）。 */

import { INLINE_RESULT_SOURCE_MAX_AUTHORS } from "../../consts/telegram";
import { LruCache } from "../../libs/lruCache";
import type { InlineResultSource } from "../../types/telegram";

/**
 * 发言身份 ID 到最近一次 inline 应答源文本与结果正文的 LRU 缓存：inline 应答入口写入并覆盖同一身份旧值，antiRaid/adCandidate.ts 使用 peek 读取。
 * 容量上限为 INLINE_RESULT_SOURCE_MAX_AUTHORS，满额按 LRU 淘汰最久未登记的身份；进程重启后从空表开始（未命中时跳过该消息广告检测）。
 */
export const inlineResultSources: LruCache<number, InlineResultSource> =
  new LruCache<number, InlineResultSource>(INLINE_RESULT_SOURCE_MAX_AUTHORS);
