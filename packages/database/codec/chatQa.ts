import { CHAT_QA_DATA_KEYS } from "../../consts/storageSchema";
import { CHAT_QA_ANSWER_MAX_CHARS, CHAT_QA_QUESTION_MAX_CHARS } from "../../consts/qa";
import { invalidInput, parseJsonInput } from "../../libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../../libs/record";
import type { ChatQaEntryData } from "../../types/qa";

/**
 * 校验问题文本非空、首尾无空白且长度不超过 CHAT_QA_QUESTION_MAX_CHARS。
 * @param q 待校验的问题文本。
 * @param source 来源标识，用于构造致命错误诊断。
 */
export function assertChatQaQuestion(q: string, source: string): void {
  if (q.length === 0 || q.trim().length !== q.length) {
    invalidInput(source, "$.q", "a non-empty question without leading or trailing whitespace");
  }
  if (q.length > CHAT_QA_QUESTION_MAX_CHARS) {
    invalidInput(source, "$.q", `a question of at most ${CHAT_QA_QUESTION_MAX_CHARS} characters`);
  }
}

/**
 * 严格解码 `chat_qa.data` JSON 文本。
 * @param text 数据库列读出的 JSON 文本。
 * @param source 来源标识，用于构造致命错误诊断。
 * @returns 已通过校验的问答答案数据对象。
 */
export function decodeChatQaData(text: string, source: string): ChatQaEntryData {
  const value: unknown = parseJsonInput(text, source);
  if (!isPlainRecord(value) || !hasExactKeys(value, CHAT_QA_DATA_KEYS)) {
    return invalidInput(source, "$", "an object with exactly the answer field");
  }
  const answer: unknown = value.a;
  if (typeof answer !== "string" || answer.length === 0) {
    return invalidInput(source, "$.a", "a non-empty string");
  }
  if (answer.length > CHAT_QA_ANSWER_MAX_CHARS) {
    return invalidInput(source, "$.a", `an answer of at most ${CHAT_QA_ANSWER_MAX_CHARS} characters`);
  }
  return { a: answer };
}

/**
 * 校验答案非空且不超过 CHAT_QA_ANSWER_MAX_CHARS，编码为 `chat_qa.data` 的 JSON 文本。
 * @param answer 待编码的答案文本。
 * @param source 来源标识，用于构造致命错误诊断。
 * @returns 序列化后的 `chat_qa.data` JSON 字符串。
 */
export function encodeChatQaData(answer: string, source: string): string {
  if (answer.length === 0) {
    return invalidInput(source, "$.a", "a non-empty string");
  }
  if (answer.length > CHAT_QA_ANSWER_MAX_CHARS) {
    return invalidInput(source, "$.a", `an answer of at most ${CHAT_QA_ANSWER_MAX_CHARS} characters`);
  }
  return JSON.stringify({ a: answer });
}
