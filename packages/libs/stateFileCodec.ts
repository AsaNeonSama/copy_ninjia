import { hasOnlyKeys, isPlainRecord } from "./record";
import { isTelegramGroupChatId } from "./telegramId";
import { decodeCachedUser } from "./cachedUserCodec";
import { invalidInput, optionalTimestampField } from "./inputValidation";
import type { InputFieldContext } from "./inputValidation";
import type { TtsDailyUsage } from "../types/aiChat/voiceMessage";
import type {
  CopyMode,
  DecodedGlobalCopyState,
  DecodedGlobalState,
} from "../types/chatState";

/**
 * memory/global/state.json 当前 schema 的纯解码器。本模块不执行 I/O；所有持久化字段都从
 * unknown 逐项收窄，未知字段、类型错误和跨字段不变量冲突经 invalidInput 拒绝整个
 * 文件，报错只含文件路径、字段路径与期望形态。
 */

/**
 * 子字段的解码上下文。
 * @param context 父级对象的输入上下文。
 * @param key 子字段属性名。
 * @returns 指向 `<path>.<key>` 的子字段输入上下文。
 */
function at(context: InputFieldContext, key: string): InputFieldContext {
  return { source: context.source, path: `${context.path}.${key}` };
}

/**
 * 校验未知值为非数组普通对象。
 * @param value 待校验的未知值。
 * @param context 当前字段路径上下文。
 * @returns 收窄后的普通对象记录。
 */
function record(value: unknown, context: InputFieldContext): Record<string, unknown> {
  if (!isPlainRecord(value)) return invalidInput(context.source, context.path, "an object");
  return value;
}

/**
 * 校验对象不包含允许列表之外的未知键。
 * @param value 待校验的对象记录。
 * @param allowed 允许出现的属性名列表。
 * @param context 当前字段路径上下文。
 */
function knownKeys(value: Record<string, unknown>, allowed: readonly string[], context: InputFieldContext): void {
  if (!hasOnlyKeys(value, allowed)) {
    invalidInput(context.source, `${context.path}.<key>`, "absent (not part of the current state schema)");
  }
}

/**
 * 校验对象必须包含指定的属性键。
 * @param value 待校验的对象记录。
 * @param key 必须存在的属性名。
 * @param context 当前字段路径上下文。
 */
function requiredKey(value: Record<string, unknown>, key: string, context: InputFieldContext): void {
  if (!(key in value)) invalidInput(context.source, `${context.path}.${key}`, "present");
}

/**
 * 解码可选的复读模式枚举。
 * @param value 待校验的原始字段值。
 * @param context 当前字段路径上下文。
 * @returns 合法的复读模式枚举值；未设置时返回 undefined。
 */
function copyMode(value: unknown, context: InputFieldContext): CopyMode | undefined {
  if (value === undefined) return undefined;
  if (value === "reverse" || value === "nya") return value;
  return invalidInput(context.source, context.path, "one of reverse or nya");
}

/**
 * 解码全局状态中的 `copy` 复读状态块。
 * @param value 待校验的 `copy` 字段值。
 * @param context `$.copy` 字段路径上下文。
 * @returns 严格校验后的全局复读状态对象。
 */
function globalCopy(value: unknown, context: InputFieldContext): DecodedGlobalCopyState {
  const raw: Record<string, unknown> = record(value, context);
  knownKeys(raw, ["lastCopyTime", "copiedUser", "copyMode", "copyChatId"], context);
  requiredKey(raw, "copiedUser", context);
  const lastCopyTime: number | undefined = optionalTimestampField(raw, "lastCopyTime", context);
  if (raw.copiedUser === null) {
    if (raw.copyMode !== undefined || raw.copyChatId !== undefined) {
      return invalidInput(context.source, context.path, "free of copyMode and copyChatId when copiedUser is null");
    }
    return { copiedUser: null, lastCopyTime };
  }
  if (!isTelegramGroupChatId(raw.copyChatId)) {
    return invalidInput(
      context.source,
      `${context.path}.copyChatId`,
      "a negative safe integer Telegram group or channel ID when copiedUser is set"
    );
  }
  return {
    lastCopyTime,
    copiedUser: decodeCachedUser(raw.copiedUser, at(context, "copiedUser")),
    copyMode: copyMode(raw.copyMode, at(context, "copyMode")),
    copyChatId: raw.copyChatId,
  };
}

/**
 * 语音合成每日计数。整块缺省表示从没用过；存在时三项都必填且均为非负安全整数，
 * 两项计数至少一项大于 0。计数不与配置上限对拍：上限调低后按对应额度用尽处理。
 * @param value 待校验的 `ttsUsage` 字段值。
 * @param context `$.ttsUsage` 字段路径上下文。
 * @returns 严格校验后的每日 TTS 用量记录；字段缺省时返回 undefined。
 */
function globalTtsUsage(value: unknown, context: InputFieldContext): TtsDailyUsage | undefined {
  if (value === undefined) return undefined;
  const raw: Record<string, unknown> = record(value, context);
  knownKeys(raw, ["windowStartedAt", "agentCount", "reserveCount"], context);
  const windowStartedAt: unknown = raw.windowStartedAt;
  if (typeof windowStartedAt !== "number" || !Number.isSafeInteger(windowStartedAt) || windowStartedAt < 0) {
    return invalidInput(context.source, `${context.path}.windowStartedAt`, "a non-negative safe integer timestamp");
  }
  const agentCount: unknown = raw.agentCount;
  if (typeof agentCount !== "number" || !Number.isSafeInteger(agentCount) || agentCount < 0) {
    return invalidInput(context.source, `${context.path}.agentCount`, "a non-negative safe integer");
  }
  const reserveCount: unknown = raw.reserveCount;
  if (typeof reserveCount !== "number" || !Number.isSafeInteger(reserveCount) || reserveCount < 0) {
    return invalidInput(context.source, `${context.path}.reserveCount`, "a non-negative safe integer");
  }
  if (agentCount === 0 && reserveCount === 0) {
    return invalidInput(context.source, context.path, "at least one positive usage count");
  }
  return { windowStartedAt, agentCount, reserveCount };
}

/**
 * 解码完整的全局状态文件；顶层只接受 copy（必填）与 ttsUsage（可缺省），任何存在但
 * 非法的字段都会拒绝整个文件（见 types/chatState.ts 的 GlobalState）。
 * @param value JSON.parse 产出的未知根值。
 * @param source 出现在报错里的文件路径。
 * @returns 严格校验后的全局状态对象。
 */
export function decodeGlobalStateFile(value: unknown, source: string): DecodedGlobalState {
  const context: InputFieldContext = { source, path: "$" };
  const raw: Record<string, unknown> = record(value, context);
  knownKeys(raw, ["copy", "ttsUsage"], context);
  requiredKey(raw, "copy", context);
  return {
    copy: globalCopy(raw.copy, at(context, "copy")),
    ttsUsage: globalTtsUsage(raw.ttsUsage, at(context, "ttsUsage")),
  };
}
