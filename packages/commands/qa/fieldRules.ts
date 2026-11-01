import { CHAT_QA_ANSWER_MAX_CHARS, CHAT_QA_QUESTION_MAX_CHARS } from "../../consts/qa";
import { renderFencedText } from "../../libs/codeFence";
import { containsRenderableCommand } from "../../libs/renderableCommand";
import type { QaFieldRejection } from "../../types/qa";
import type { RichTextMessage } from "../../types/telegram";

/**
 * 校验问答问题字段：超长或整条含可点击 `/command` 时返回拒绝原因。
 * @param question 问题文本。
 * @returns 拒绝原因；合规时返回 `null`。
 */
export function questionRejectionOf(question: string): QaFieldRejection | null {
  if (question.length > CHAT_QA_QUESTION_MAX_CHARS) return "questionTooLong";
  return containsRenderableCommand(question) ? "questionHasCommand" : null;
}

/**
 * 校验问答答案字段：超长，或按直答出口同一套围栏拆分（`auto/message/qaDirectAnswer.ts` 的 `sendQaDirectAnswer`）后代码块之外的文字含可点击 `/command` 时返回拒绝原因；代码块内的命令示例照常放行。
 * @param answer 回答文本。
 * @returns 拒绝原因；合规时返回 `null`。
 */
export function answerRejectionOf(answer: string): QaFieldRejection | null {
  if (answer.length > CHAT_QA_ANSWER_MAX_CHARS) return "answerTooLong";
  const rendered: RichTextMessage = renderFencedText(answer);
  let cursor: number = 0;
  for (const entity of rendered.entities) {
    if (containsRenderableCommand(rendered.text.slice(cursor, entity.offset))) {
      return "answerHasCommand";
    }
    cursor = entity.offset + entity.length;
  }
  return containsRenderableCommand(rendered.text.slice(cursor)) ? "answerHasCommand" : null;
}
