import {
  SELF_ACTION_TAG_MARKERS,
  SELF_ACTION_TAG_PATTERNS,
} from "../../../../consts/aiChat/prompts/transcript";
import { DUPLICATE_REPLY_RESULT } from "../../../../consts/aiChat/tools";
import { containsRenderableCommand } from "../../../../libs/renderableCommand";
import type { RoundMessageState } from "../../../../types/aiChat/replies";
import { toolError } from "../../utils/toolResult";
import { isDuplicateOfAcceptedText } from "./messageState";

type ModelAuthoredTextSurface = "message" | "picture";

function forgedActionError(surface: ModelAuthoredTextSurface, marker: string): string {
  if (surface === "message") {
    return toolError(
      `Text must not narrate an action: "${marker}" is a transcript marker the execution side writes after the action really happened. ` +
      "Perform the action with its own tool (send_sticker / generate_image), or, if it is unavailable, say so plainly in your own words",
      { retryable: false }
    );
  }
  return toolError(
    `caption must not narrate an action: "${marker}" is a transcript marker the execution side writes after the action really happened. ` +
    `Just say what you want to say about the ${surface} in your own words`,
    { retryable: false }
  );
}

function renderableCommandError(surface: ModelAuthoredTextSurface): string {
  const fieldName: string = surface === "message" ? "Text" : "caption";
  return toolError(
    `${fieldName} must not contain a slash command such as "/example": Telegram renders it as a tappable command in the bot's own message. ` +
    "Write the command name without the leading slash"
  );
}

/**
 * 校验模型即将发送的正文或图注：同轮重复文本返回 DUPLICATE_REPLY_RESULT，含执行侧转录记号或可渲染斜杠命令时返回工具错误，
 * 通过时返回 null。
 */
export function modelAuthoredTextPolicyResult(
  text: string,
  state: RoundMessageState,
  surface: "message" | "picture"
): string | null {
  if (isDuplicateOfAcceptedText(state, text)) {
    return DUPLICATE_REPLY_RESULT;
  }

  const forgedIndex: number = SELF_ACTION_TAG_PATTERNS.findIndex(
    (pattern: RegExp): boolean => pattern.test(text)
  );
  if (forgedIndex >= 0) {
    const forgedMarker: string = SELF_ACTION_TAG_MARKERS[forgedIndex] ?? "";
    return forgedActionError(surface, forgedMarker);
  }

  if (containsRenderableCommand(text)) {
    return renderableCommandError(surface);
  }
  return null;
}
