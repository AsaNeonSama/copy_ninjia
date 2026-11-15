/**
 * 广告送检姓名格式化纯函数（Anti-Raid Worker 侧）：将发送者名与姓清洗截断后拼为单行送检前缀。
 */
import { AD_DETECT_SENDER_NAME_MAX_CHARS } from "../../../consts/antiRaid/adDetect";
import { sanitizeInline, truncateInline } from "../../../libs/text";
import type { TelegramIdentityMetadata } from "../../../types/identityPolicy";

/**
 * 从候选消息自带的 `firstName`、`lastName` 生成单行送检姓名（纯函数，不读缓存，不查询 Telegram）。
 *
 * @param meta 包含 `firstName` 与 `lastName` 的只读身份元数据。
 * @returns 规范化并截断后的单行送检姓名字符串。
 */
export function formatAdSenderName(
  meta: Readonly<Pick<TelegramIdentityMetadata, "firstName" | "lastName">>
): string {
  const firstName: string = truncateInline(sanitizeInline(meta.firstName), AD_DETECT_SENDER_NAME_MAX_CHARS);
  const lastName: string = truncateInline(sanitizeInline(meta.lastName), AD_DETECT_SENDER_NAME_MAX_CHARS);
  if (firstName.length === 0) return lastName;
  return lastName.length === 0 ? firstName : `${firstName} ${lastName}`;
}
