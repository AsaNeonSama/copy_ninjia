import {
  TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD,
  TEMPORARY_AD_BYPASS_REQUIRED_DAYS,
} from "../../consts/temporaryAdBypass";
import { invalidInput } from "../../libs/inputValidation";
import { MAX_EPOCH_MILLISECONDS } from "../../consts/time";
import { getDayIndex } from "../../libs/time";
import type { TemporaryAdBypassActivity } from "../../types/states/temporaryAdBypass";

/**
 * 校验时间戳为日历 API 支持范围内的非负安全整数毫秒值。
 * @param value 待校验的毫秒时间戳。
 * @param source 来源标识，用于构造致命错误诊断。
 * @param path 字段 JSONPath，用于构造致命错误诊断。
 */
function assertTimestamp(value: number, source: string, path: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_EPOCH_MILLISECONDS) {
    return invalidInput(source, path, "a non-negative safe integer epoch-millisecond timestamp within the calendar API range");
  }
}

/**
 * 严格校验临时广告免检关系列；存在但不一致的计数或时间一律拒绝。
 * @param value 待校验的临时广告免检活跃度记录。
 * @param source 来源标识，用于构造致命错误诊断。
 */
export function assertTemporaryAdBypassActivity(
  value: Readonly<TemporaryAdBypassActivity>,
  source: string
): void {
  if (typeof value.adBypass !== "boolean") {
    return invalidInput(source, "$.ad_bypass", "a boolean");
  }
  if (
    !Number.isSafeInteger(value.qualifiedDays) ||
    value.qualifiedDays < 0 ||
    value.qualifiedDays > TEMPORARY_AD_BYPASS_REQUIRED_DAYS
  ) {
    return invalidInput(source, "$.qualified_days", "an integer from 0 through 7");
  }
  if (!Number.isSafeInteger(value.sendCount) || value.sendCount < 1) {
    return invalidInput(source, "$.send_count", "a positive safe integer");
  }
  assertTimestamp(value.countedAt, source, "$.counted_at");
  if (value.adBypassGrantedAt !== null) {
    assertTimestamp(value.adBypassGrantedAt, source, "$.ad_bypass_granted_at");
  }
  if (value.qualifiedAt !== null) {
    assertTimestamp(value.qualifiedAt, source, "$.qualified_at");
  }
  if (
    value.adBypass !== (value.adBypassGrantedAt !== null) ||
    (!value.adBypass && value.qualifiedDays !== 0)
  ) {
    return invalidInput(
      source,
      "$.ad_bypass",
      "true after the first qualified day and consistent with ad_bypass_granted_at"
    );
  }
  if (value.adBypassGrantedAt !== null && value.adBypassGrantedAt > value.countedAt) {
    return invalidInput(source, "$.ad_bypass_granted_at", "no later than counted_at");
  }
  if (
    value.qualifiedAt === null &&
    value.sendCount > TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD
  ) {
    return invalidInput(source, "$.qualified_at", "present after the daily threshold is exceeded");
  }
  if (
    value.qualifiedAt !== null &&
    (
      value.sendCount <= TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD ||
      value.qualifiedDays < 1 ||
      value.qualifiedAt > value.countedAt ||
      getDayIndex(value.qualifiedAt) !==
        getDayIndex(value.countedAt)
    )
  ) {
    return invalidInput(
      source,
      "$.qualified_at",
      "in the counted_at configured local day after the daily threshold is exceeded"
    );
  }
  if (
    value.adBypassGrantedAt !== null &&
    value.qualifiedAt !== null &&
    value.adBypassGrantedAt > value.qualifiedAt
  ) {
    return invalidInput(source, "$.ad_bypass_granted_at", "no later than qualified_at");
  }
}
