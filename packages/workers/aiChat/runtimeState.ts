import { currentMoodInstruction } from "../../aiChat/ai/mood";
import {
  CURRENT_TIME_LABEL,
  REPLY_CONTEXT_SECTION_NAMES,
  REPLY_CONTEXT_SECTION_TEXT,
  TIME_AWARENESS_INSTRUCTION,
} from "../../consts/aiChat/prompts/memory";
import { MOOD_STATE_PRECEDENCE_INSTRUCTION } from "../../consts/aiChat/prompts/mood";
import { currentTimeSentence } from "../../aiChat/ai/timeSentence";

/**
 * 组装本轮运行时状态区块（当前心情、当前时间与本轮工具状态）。
 * 前缀缓存与动态内容顺序约束见 docs/cn/04-invariants.md。
 */
export function buildRuntimeStateBlock(toolStatus: string): string {
  return `[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.runtimeState}]\n` +
    REPLY_CONTEXT_SECTION_TEXT.runtimeState.header +
    "\n" +
    MOOD_STATE_PRECEDENCE_INSTRUCTION +
    "\n" +
    currentMoodInstruction() +
    "\n" +
    currentTimeSentence(CURRENT_TIME_LABEL) +
    TIME_AWARENESS_INSTRUCTION +
    "\n" +
    toolStatus +
    "\n" +
    `[END ${REPLY_CONTEXT_SECTION_NAMES.runtimeState}]`;
}
