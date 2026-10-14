/**
 * Gemini 供应商实现入口：装配回复会话、纯文本、结构化 JSON、视觉描述、生图、语音转写、语音合成与联网检索能力。
 */

import { generateGeminiImage } from "./image";
import { createGeminiReplySession } from "./replySession";
import { searchGeminiWeb } from "./search";
import { synthesizeGeminiSpeech } from "./speech";
import { describeGeminiVision, generateGeminiJson, generateGeminiText, transcribeGeminiVoice } from "./text";
import type { AiChatProvider } from "../../types/aiChat/provider";

/** Google GenAI 供应商实现。 */
export const geminiProvider: AiChatProvider = {
  name: "google",
  createReplySession: createGeminiReplySession,
  generateText: generateGeminiText,
  describeVision: describeGeminiVision,
  generateImage: generateGeminiImage,
  transcribeVoice: transcribeGeminiVoice,
  synthesizeSpeech: synthesizeGeminiSpeech,
  searchWeb: searchGeminiWeb,
  generateJson: generateGeminiJson,
};
