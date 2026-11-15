/**
 * 将未知 JSON 载荷收窄为键值字典。
 * @param payload 原始 JSON 值
 * @returns 非空对象字典（原始值或 `null` 时返回空字典）
 */
export function asPayloadRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}
