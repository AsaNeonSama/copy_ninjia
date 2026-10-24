import { join } from "node:path";

/** 多个领域的测试文件共用、与被测领域无关的小工具（非测试文件，bun test 不会执行它）。 */

/**
 * 排空「已经发起、但调用方按设计不 await」的后台链——典型是 infra/botAdmin.ts 的
 * 按需权限现查：它不挡住串行的 update 处理，快照要晚若干个微任务才落下。
 *
 * 用一个宏任务收口，不数 `await Promise.resolve()` 的圈数。
 */
export function settleBackgroundWork(): Promise<void> {
  return Bun.sleep(0);
}

/** 按给定分块流式返回 body 的 Response，流式读取/字节上限类测试用。 */
export function chunkedResponse(chunks: readonly Uint8Array[], init?: ResponseInit): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>): void {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    init
  );
}

/**
 * 测试里的固定小批并发统一等待全部结算；失败项按输入下标聚合。
 * 调用方只传已经启动的 Promise，本函数不扩大生产并发面。
 */
export async function settleTestBatch<T>(tasks: readonly Promise<T>[]): Promise<T[]> {
  const settlements: PromiseSettledResult<T>[] = await Promise.allSettled(tasks);
  const failures: Error[] = [];
  const values: T[] = [];
  for (let index: number = 0; index < settlements.length; index++) {
    const settlement: PromiseSettledResult<T> = settlements[index]!;
    if (settlement.status === "fulfilled") {
      values.push(settlement.value);
    } else {
      failures.push(new Error(`Test batch task ${index} rejected.`, {
        cause: settlement.reason,
      }));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Test batch tasks rejected.");
  }
  return values;
}

/**
 * 整模块替换 infra/telegram 时，按真实实现把 replyCommandNotice 委托给替身 sendCommandMessage，
 * 断言仍落在 sendCommandMessage 的入参上。
 */
export function replyCommandNoticeVia(
  sendCommandMessage: (params: any) => unknown
): (ctx: { readonly chat: { readonly id: number }; readonly msgId: number | undefined }, text: string) => unknown {
  return (ctx: { readonly chat: { readonly id: number }; readonly msgId: number | undefined }, text: string): unknown =>
    sendCommandMessage({ chatId: ctx.chat.id, text, replyToMessageId: ctx.msgId });
}

/**
 * 在临时改写的进程环境变量下执行 run，结束后（含抛错）逐项还原原值；取值为 undefined 表示执行期间删除该变量。
 * @param overrides 变量名到临时取值的映射。
 * @param run 在改写后的环境下执行的闭包。
 * @returns run 的返回值。
 */
export async function withProcessEnv<T>(
  overrides: Readonly<Record<string, string | undefined>>,
  run: () => T | Promise<T>
): Promise<T> {
  const saved: Map<string, string | undefined> = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(overrides)) {
    saved.set(name, process.env[name]);
    assignProcessEnv(name, value);
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of saved) assignProcessEnv(name, value);
  }
}

/**
 * 写入或删除单个进程环境变量。
 * @param name 变量名。
 * @param value 新取值；undefined 时删除该变量。
 */
function assignProcessEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** 返回将任意 JSON 记录写入 scratchRoot 下独立临时文件并返回路径的写入函数。 */
export function jsonDocumentWriter(
  scratchRoot: string
): (document: unknown) => Promise<string> {
  let documentIndex: number = 0;
  return async (document: unknown): Promise<string> => {
    documentIndex += 1;
    const path: string = join(scratchRoot, `result-${documentIndex}.json`);
    await Bun.write(path, `${JSON.stringify(document, null, 2)}\n`);
    return path;
  };
}
