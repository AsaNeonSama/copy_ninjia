/**
 * 按 Bun 系统错误码收窄未知异常；只比较稳定的 code 字段，不依赖平台文案。
 * @param error 捕获到的未知异常值。
 * @param code 期望匹配的 POSIX 系统错误码（如 `"ENOENT"`、`"EEXIST"`）。
 * @returns 异常为携带指定错误码的 Error 时返回 true，否则返回 false。
 */
export function isErrno(error: unknown, code: string): error is Bun.SystemError {
  return error instanceof Error && "code" in error && error.code === code;
}
