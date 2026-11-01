/**
 * 把 catch 到的值压成 Toast 与表单错误能直接展示的一段文案。
 * 与 `packages/libs/errorMessage.ts` 的同名函数输出一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。
 *
 * @param error catch 到的原值
 * @returns Error 的 message，或原值的字符串形式
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
