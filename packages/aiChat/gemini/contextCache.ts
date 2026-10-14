/**
 * Gemini 回复会话（`text` 能力）的共用显式上下文缓存 scope。
 */

import {
  GEMINI_TEXT_CACHE_DISPLAY_NAME_PREFIX,
  GEMINI_TEXT_CACHE_ERROR_LABEL,
  GEMINI_TEXT_CACHE_MAX_SLOTS,
} from "../../consts/aiChat/gemini";
import { textGeminiContextCache } from "../../cache/workers/aiChat/geminiContextCache";
import { aiChatWorkerAbortController } from "../../cache/workers/aiChat/worker";
import { createGeminiContextCacheRegistry } from "../../infra/geminiContextCache";
import { getGeminiClient } from "./client";
import type { GeminiContextCacheRegistry, GeminiContextCacheScope } from "../../types/geminiContextCache";

/** 回复共用显式缓存的 scope；登记表按当前 `text` 客户端惰性初始化。 */
export const TEXT_GEMINI_CONTEXT_CACHE_SCOPE: Readonly<GeminiContextCacheScope> = {
  registry(): GeminiContextCacheRegistry {
    textGeminiContextCache.current ??= createGeminiContextCacheRegistry(getGeminiClient("text"));
    return textGeminiContextCache.current;
  },
  signal(): AbortSignal {
    return aiChatWorkerAbortController.current.signal;
  },
  displayNamePrefix: GEMINI_TEXT_CACHE_DISPLAY_NAME_PREFIX,
  maxSlots: GEMINI_TEXT_CACHE_MAX_SLOTS,
  capability: "text",
  errorLabel: GEMINI_TEXT_CACHE_ERROR_LABEL,
};
