/** 安装隔离检查共用的断言；失败时抛出带说明的 Error。 */

export function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  assertCondition(Object.is(actual, expected), message);
}

export function assertContains(value: string, expected: string, message: string): void {
  assertCondition(value.includes(expected), message);
}
