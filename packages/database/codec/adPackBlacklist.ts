import { STICKER_PACK_NAME_PATTERN } from "../../consts/aiChat/stickers";
import { invalidInput } from "../../libs/inputValidation";
import type { AdPackBlacklistKind } from "../../types/adPackBlacklist";

/**
 * 校验广告包黑名单种类为 `"sticker"` 或 `"emoji"`。
 *
 * @param kind 待校验的黑名单种类。
 * @param source 来源标识，用于构造致命错误诊断。
 * @returns 无返回值；类型断言为 `AdPackBlacklistKind`，不合法时抛出 `InputValidationError`。
 */
export function assertAdPackBlacklistKind(
  kind: unknown,
  source: string
): asserts kind is AdPackBlacklistKind {
  if (kind !== "sticker" && kind !== "emoji") {
    invalidInput(source, "$.kind", '"sticker" or "emoji"');
  }
}

/**
 * 校验广告包黑名单包名非空、首尾无空白且符合 `STICKER_PACK_NAME_PATTERN`。
 *
 * @param pack 待校验的贴纸包或自定义表情包 short name。
 * @param source 来源标识，用于构造致命错误诊断。
 * @returns 无返回值；类型断言为合法 short name 字符串，不合法时抛出 `InputValidationError`。
 */
export function assertAdPackBlacklistPack(pack: unknown, source: string): asserts pack is string {
  if (
    typeof pack !== "string" ||
    pack.trim().length !== pack.length ||
    !STICKER_PACK_NAME_PATTERN.test(pack)
  ) {
    invalidInput(source, "$.pack", "a valid Telegram sticker pack short name");
  }
}
