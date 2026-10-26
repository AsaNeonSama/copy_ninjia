/**
 * 群热上下文逐字消息容量上限（256 条），群发言记录页在分页数据尚未返回时展示的容量。
 * 不变量：与 `packages/consts/aiChat/memory.ts` 同名常量相等，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/components/MessagesView.tsx`。
 */
export const VERBATIM_CONTEXT_MAX: number = 256;
