/**
 * 将未知 JSON 值安全收窄为键值字典。
 * @param payload 原始 JSON 值
 * @returns 对象字典（非对象时返回空字典）
 */
export function asPayloadRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}
