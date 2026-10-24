/** 安装隔离检查共用的断言；失败时抛出带说明的 Error。 */

/**
 * 断言布尔条件为真，否则抛出带指定消息的 Error。
 *
 * @param condition 待断言的布尔条件
 * @param message 断言失败时的错误消息
 * @returns 条件成立时收窄 `condition` 为真；否则抛出 Error
 */
export function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * 断言两个值按 `Object.is` 严格相等，否则抛出带指定消息的 Error。
 *
 * @param actual 实际值
 * @param expected 期望值
 * @param message 断言失败时的错误消息
 */
export function assertEqual<T>(actual: T, expected: T, message: string): void {
  assertCondition(Object.is(actual, expected), message);
}

/**
 * 断言字符串包含指定子串，否则抛出带指定消息的 Error。
 *
 * @param value 待检查的字符串
 * @param expected 期望包含的子串
 * @param message 断言失败时的错误消息
 */
export function assertContains(value: string, expected: string, message: string): void {
  assertCondition(value.includes(expected), message);
}
