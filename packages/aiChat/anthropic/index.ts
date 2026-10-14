/**
 * Anthropic 供应商实现入口：装配回复会话、纯文本、结构化 JSON、视觉描述与联网检索能力。
 */

import { createAnthropicReplySession } from "./replySession";
import { searchAnthropicWeb } from "./search";
import { describeAnthropicVision, generateAnthropicJson, generateAnthropicText } from "./text";
import type { AiChatProvider } from "../../types/aiChat/provider";

/** Anthropic 供应商实现。 */
export const anthropicProvider: AiChatProvider = {
  name: "anthropic",
  createReplySession: createAnthropicReplySession,
  generateText: generateAnthropicText,
  describeVision: describeAnthropicVision,
  searchWeb: searchAnthropicWeb,
  generateJson: generateAnthropicJson,
};
