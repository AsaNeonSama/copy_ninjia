/**
 * OpenAI 供应商实现入口：装配回复会话、纯文本、结构化 JSON、视觉描述、生图、语音转写、语音合成与联网检索能力。
 */

import { generateOpenAiImage } from "./image";
import { createOpenAiReplySession } from "./replySession";
import { searchOpenAiWeb } from "./search";
import { synthesizeOpenAiSpeech } from "./speech";
import { describeOpenAiVision, generateOpenAiJson, generateOpenAiText, transcribeOpenAiVoice } from "./text";
import type { AiChatProvider } from "../../types/aiChat/provider";

/** OpenAI 供应商实现。 */
export const openAiProvider: AiChatProvider = {
  name: "openai",
  createReplySession: createOpenAiReplySession,
  generateText: generateOpenAiText,
  describeVision: describeOpenAiVision,
  generateImage: generateOpenAiImage,
  transcribeVoice: transcribeOpenAiVoice,
  synthesizeSpeech: synthesizeOpenAiSpeech,
  searchWeb: searchOpenAiWeb,
  generateJson: generateOpenAiJson,
};
