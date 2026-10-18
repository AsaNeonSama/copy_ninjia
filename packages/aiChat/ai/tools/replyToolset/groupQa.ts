/**
 * 群问答查询工具（`group_qa_query` 与 `group_qa_answer`）：就地解析 trigger 消息随附的
 * 本群问答 JSON，不计入可见动作预算。
 */

import { GROUP_QA_ANSWER_TOOL, GROUP_QA_QUERY_TOOL } from "../../../../consts/tools";
import { TOOL_STATUS_POINTER } from "../../../../consts/aiChat/prompts/tools";
import { toolError } from "../../utils/toolResult";
import type { AiToolDefinition } from "../../../../types/aiChat/provider";

/** 模型给 group_qa_answer 的入参形态。 */
interface GroupQaAnswerArguments {
  readonly question?: unknown;
}

/** 构造群问答两个查询工具的声明。 */
export function buildGroupQaToolDefinitions(): readonly AiToolDefinition[] {
  return [
    {
      name: GROUP_QA_QUERY_TOOL,
      description:
        "列出本群已登记的问答问题清单。当前这句话像是在问其中某一条时，先用这个工具" +
        "看清单，再判断语义是否足够接近；接近才调 group_qa_answer 取答案。" +
        `本群有没有登记问答，见 ${TOOL_STATUS_POINTER}；显示没有登记时不要调用。`,
      parametersJsonSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: GROUP_QA_ANSWER_TOOL,
      description:
        "按问题原文取回本群登记的答案。question 必须是 group_qa_query 列出的原文之一，" +
        "不能改写。拿到答案后照着它的意思回答，不要编造清单之外的内容。",
      parametersJsonSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "group_qa_query 列出的问题原文，逐字照抄。",
          },
        },
        required: ["question"],
      },
    },
  ];
}

/** 解析 trigger 随附的问答对数组 JSON；缺省时返回空数组，形态不符时抛错。 */
export function parseChatQaJson(chatQaJson: string | undefined): readonly (readonly [string, string])[] {
  if (chatQaJson === undefined) return [];
  const parsed: unknown = JSON.parse(chatQaJson);
  if (!Array.isArray(parsed)) throw new TypeError("chatQaJson must be an array of [question, answer] pairs.");
  const pairs: (readonly [string, string])[] = [];
  for (const pair of parsed as readonly unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
      throw new TypeError("chatQaJson must be an array of [question, answer] pairs.");
    }
    pairs.push([pair[0], pair[1]]);
  }
  return pairs;
}

/** 列出已登记的问题清单（不含答案）。 */
export function executeGroupQaQuery(chatQaJson: string | undefined): string {
  const questions: string[] = [];
  for (const [question] of parseChatQaJson(chatQaJson)) questions.push(question);
  return JSON.stringify({ questions });
}

/** 按问题原文精确匹配并返回登记的答案。 */
export function executeGroupQaAnswer(
  chatQaJson: string | undefined,
  argumentsJson: string
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return toolError("group_qa_answer arguments must be valid JSON");
  }
  const question: unknown = (parsed as GroupQaAnswerArguments | null)?.question;
  if (typeof question !== "string" || question.length === 0) {
    return toolError("group_qa_answer requires a non-empty question string");
  }
  let answer: string | undefined;
  for (const [registered, registeredAnswer] of parseChatQaJson(chatQaJson)) {
    if (registered === question) {
      answer = registeredAnswer;
      break;
    }
  }
  if (answer === undefined) {
    return JSON.stringify({ found: false, question });
  }
  return JSON.stringify({ found: true, question, answer });
}
