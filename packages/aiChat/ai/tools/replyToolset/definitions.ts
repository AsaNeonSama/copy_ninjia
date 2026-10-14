import type { AiToolDefinition } from "../../../../types/aiChat/provider";
import {
  ABUSE_MARK_TOOL_INSTRUCTION,
  ABUSE_MARK_USER_ID_DESCRIPTION,
  ADD_REACTION_TOOL_INSTRUCTION,
} from "../../../../consts/aiChat/prompts/tools";
import {
  ABUSE_MARK_TOOL,
  ADD_REACTION_TOOL,
  SEND_MESSAGE_TOOL,
} from "../../../../consts/tools";

/** 构造 send_message 工具声明；instruction 为当前台词语言对应的工具说明。 */
export function buildSendMessageToolDefinition(instruction: string): AiToolDefinition {
  return {
    name: SEND_MESSAGE_TOOL,
    description: instruction,
    parametersJsonSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要发到群里的消息文本。" },
        reply_to_trigger: {
          type: "boolean",
          description: "是否以「回复」形式挂在触发你这次回复的那条消息上；省略视为 false。",
        },
        typo_original_char: {
          type: "string",
          description: "只在回复任务区块明确要求时填写：从 text 里原样抄的一个字。其余情况省略本字段。",
        },
        typo_replacement_char: {
          type: "string",
          description: "只在回复任务区块明确要求时填写：替换 typo_original_char 的那一个字。其余情况省略本字段。",
        },
      },
      required: ["text"],
    },
  };
}

export function buildAddReactionToolDefinition(): AiToolDefinition {
  return {
    name: ADD_REACTION_TOOL,
    description: ADD_REACTION_TOOL_INSTRUCTION,
    parametersJsonSchema: {
      type: "object",
      properties: {
        emoji: { type: "string", description: "要扣的反应 emoji，必须是清单里列出的其中一个。" },
      },
      required: ["emoji"],
    },
  };
}

/** 构造 abuse_mark 工具声明。 */
export function buildAbuseMarkToolDefinition(): AiToolDefinition {
  return {
    name: ABUSE_MARK_TOOL,
    description: ABUSE_MARK_TOOL_INSTRUCTION,
    parametersJsonSchema: {
      type: "object",
      properties: {
        user_id: { type: "integer", description: ABUSE_MARK_USER_ID_DESCRIPTION },
      },
      required: ["user_id"],
    },
  };
}
