import { beforeEach, describe, expect, test } from "bun:test";
import {
  acceptForwardedLogBatch,
  enqueueForwardedLogDropSummary,
  forwardWorkerLog,
  pumpForwardedLogs,
} from "../../packages/infra/logger/forwarding";
import type { ForwardedLogSink } from "../../packages/infra/logger/forwarding";
import {
  forwardedLogDropState,
  forwardedLogQueue,
} from "../../packages/cache/perThread/logger";
import {
  LOGGER_FORWARD_BATCH_MAX_MESSAGES,
  LOGGER_FORWARD_MAX_PENDING_MESSAGES,
  LOG_LEVELS,
} from "../../packages/consts/logger";
import type { ForwardedLogBatch, LogLevel, LogMessage } from "../../packages/types/diskIO";

/**
 * 业务 Worker -> 主线程的日志转发协议。
 *
 * 本文件直接覆盖日志转发通道的函数与「日志系统被压垮时不拖住 Worker」的边界：
 * 单批在途、双硬顶、溢出只累计标量、排空后补一条汇总，并验证 Worker 线程阈值过滤后全级别转发。
 */

/** 收集出口收到的批次；可切换成同步拒绝，模拟 postMessage 抛出。 */
function createSink(): {
  sink: ForwardedLogSink;
  batches: ForwardedLogBatch[];
  reject: { current: boolean };
} {
  const batches: ForwardedLogBatch[] = [];
  const reject: { current: boolean } = { current: false };
  return {
    batches,
    reject,
    sink: (batch: ForwardedLogBatch): void => {
      if (reject.current) throw new Error("postMessage rejected");
      batches.push(batch);
    },
  };
}

function logMessage(text: string, timestamp: number = 1_000, level: LogLevel = "error"): LogMessage {
  return { timestamp, level, args: [text] };
}

/** 取出批次里的第一条参数文本，供断言汇总内容。 */
function firstArg(batch: ForwardedLogBatch, index: number = 0): string {
  return String(batch.__logBatch.messages[index]?.args[0]);
}

beforeEach((): void => {
  forwardedLogQueue.reset();
  forwardedLogDropState.current.droppedMessages = 0;
  forwardedLogDropState.current.droppedSerializedBytes = 0;
});

describe("Worker 侧日志转发通道", () => {
  test("一条 error 立即成批发出，并在 ACK 前不再发第二批", () => {
    const { sink, batches } = createSink();

    forwardWorkerLog(logMessage("first"), sink);
    expect(batches).toHaveLength(1);
    expect(firstArg(batches[0]!)).toBe("first");

    // 第一批还没 ACK：后续日志只进队列，mailbox 里始终只有一个批次。
    forwardWorkerLog(logMessage("second"), sink);
    forwardWorkerLog(logMessage("third"), sink);
    expect(batches).toHaveLength(1);

    // ACK 之后剩下的两条一起作为第二批发出。
    expect(acceptForwardedLogBatch({ __logBatchAccepted: batches[0]!.__logBatch.batchId }, sink)).toBeTrue();
    expect(batches).toHaveLength(2);
    expect(batches[1]!.__logBatch.messages).toHaveLength(2);
    expect(firstArg(batches[1]!, 0)).toBe("second");
    expect(firstArg(batches[1]!, 1)).toBe("third");
  });

  test("单批条数受 LOGGER_FORWARD_BATCH_MAX_MESSAGES 硬顶，余量留到下一批", () => {
    const { sink, batches } = createSink();
    const total: number = LOGGER_FORWARD_BATCH_MAX_MESSAGES + 5;
    for (let index: number = 0; index < total; index++) {
      forwardWorkerLog(logMessage(`m${index}`), sink);
    }

    expect(batches).toHaveLength(1);
    // 第一条自己成批（它发出时队列里只有它）。
    expect(batches[0]!.__logBatch.messages).toHaveLength(1);

    acceptForwardedLogBatch({ __logBatchAccepted: batches[0]!.__logBatch.batchId }, sink);
    expect(batches[1]!.__logBatch.messages).toHaveLength(LOGGER_FORWARD_BATCH_MAX_MESSAGES);

    acceptForwardedLogBatch({ __logBatchAccepted: batches[1]!.__logBatch.batchId }, sink);
    expect(batches[2]!.__logBatch.messages).toHaveLength(total - 1 - LOGGER_FORWARD_BATCH_MAX_MESSAGES);
  });

  test("出口同步拒绝时保留原批，下一条日志原批重发且不丢内容", () => {
    const { sink, batches, reject } = createSink();

    reject.current = true;
    forwardWorkerLog(logMessage("rejected"), sink);
    expect(batches).toHaveLength(0);

    reject.current = false;
    // 重发的是同一批（含原来那条）。
    expect(pumpForwardedLogs(sink)).toBeTrue();
    expect(batches).toHaveLength(1);
    expect(firstArg(batches[0]!)).toBe("rejected");
  });

  test("撑满条数硬顶后只累计标量，排空后补一条汇总说明丢了多少", () => {
    const { sink, batches } = createSink();

    // 第一条会被立即发出并占住在途窗口，其余全部进队列直到撞上条数硬顶。
    for (let index: number = 0; index <= LOGGER_FORWARD_MAX_PENDING_MESSAGES; index++) {
      forwardWorkerLog(logMessage(`m${index}`), sink);
    }
    expect(forwardedLogDropState.current.droppedMessages).toBeGreaterThan(0);
    expect(forwardedLogDropState.current.droppedSerializedBytes).toBeGreaterThan(0);
    const dropped: number = forwardedLogDropState.current.droppedMessages;
    const droppedBytes: number = forwardedLogDropState.current.droppedSerializedBytes;

    // 逐批 ACK 排空；队列一有余量，汇总补进去且计数清零。
    let guard: number = 0;
    while (forwardedLogQueue.size > 0 && guard < 200) {
      const pending: ForwardedLogBatch | undefined = batches.at(-1);
      if (pending === undefined) break;
      acceptForwardedLogBatch({ __logBatchAccepted: pending.__logBatch.batchId }, sink);
      guard++;
    }
    expect(forwardedLogDropState.current.droppedMessages).toBe(0);
    expect(forwardedLogDropState.current.droppedSerializedBytes).toBe(0);

    const summaries: LogMessage[] = batches.flatMap((batch: ForwardedLogBatch): LogMessage[] =>
      batch.__logBatch.messages.filter(
        (message: LogMessage): boolean =>
          message.args[0] === "[logger] Dropped Worker logs after the forwarding queue reached its hard limits."
      )
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.level).toBe("error");
    expect(summaries[0]!.args).toEqual([
      "[logger] Dropped Worker logs after the forwarding queue reached its hard limits.",
      { droppedMessages: dropped, droppedSerializedBytes: droppedBytes },
    ]);
  });

  test("汇总入不了队时不清零：计数必须留到真的补发成功那一次", () => {
    forwardedLogDropState.current.droppedMessages = 7;
    forwardedLogDropState.current.droppedSerializedBytes = 700;
    // 把队列塞满，汇总此刻无处可去。
    for (let index: number = 0; index < LOGGER_FORWARD_MAX_PENDING_MESSAGES; index++) {
      forwardedLogQueue.enqueue(logMessage(`m${index}`), 8);
    }

    enqueueForwardedLogDropSummary(2_000);
    expect(forwardedLogDropState.current.droppedMessages).toBe(7);
    expect(forwardedLogDropState.current.droppedSerializedBytes).toBe(700);
  });

  test("没有丢弃时不产生汇总，也不占用队列名额", () => {
    enqueueForwardedLogDropSummary(2_000);
    expect(forwardedLogQueue.size).toBe(0);
  });

  test("汇总用调用方给的时刻，不自己读墙钟", () => {
    const { sink, batches } = createSink();
    forwardedLogDropState.current.droppedMessages = 3;
    forwardedLogDropState.current.droppedSerializedBytes = 300;

    enqueueForwardedLogDropSummary(4_242);
    pumpForwardedLogs(sink);
    expect(batches[0]!.__logBatch.messages[0]?.timestamp).toBe(4_242);
  });

  test("非 logger 协议的消息一律不认领，交回业务路由", () => {
    const { sink, batches } = createSink();
    for (const foreign of [null, undefined, 42, "text", {}, { type: "barrier" }, []]) {
      expect(acceptForwardedLogBatch(foreign, sink)).toBeFalse();
    }
    expect(batches).toHaveLength(0);
  });

  test("迟到/重复/伪造 batchId 的 ACK 仍算已认领，但不推进在途批次", () => {
    const { sink, batches } = createSink();
    forwardWorkerLog(logMessage("first"), sink);
    forwardWorkerLog(logMessage("queued"), sink);
    const batchId: number = batches[0]!.__logBatch.batchId;

    // 伪造 id：认领消息，但窗口不动，队列里那条也发不出去。
    expect(acceptForwardedLogBatch({ __logBatchAccepted: batchId + 999 }, sink)).toBeTrue();
    expect(batches).toHaveLength(1);

    // 非数字 batchId 同理。
    expect(acceptForwardedLogBatch({ __logBatchAccepted: "1" }, sink)).toBeTrue();
    expect(batches).toHaveLength(1);

    expect(acceptForwardedLogBatch({ __logBatchAccepted: batchId }, sink)).toBeTrue();
    expect(batches).toHaveLength(2);

    // 重复 ACK 同一个 id：认领，但不得再放一批出去。
    expect(acceptForwardedLogBatch({ __logBatchAccepted: batchId }, sink)).toBeTrue();
    expect(batches).toHaveLength(2);
  });

  test("队列空时 pump 报成功且不发空批", () => {
    const { sink, batches } = createSink();
    expect(pumpForwardedLogs(sink)).toBeTrue();
    expect(batches).toHaveLength(0);
  });

  test("LOG_LEVELS 四种级别均可进入转发队列并在 ACK 后逐批保留原始 level", () => {
    const { sink, batches } = createSink();
    for (const [index, level] of LOG_LEVELS.entries()) {
      forwardWorkerLog(logMessage(`msg-${level}`, 1_000 + index, level), sink);
    }
    expect(batches).toHaveLength(1);
    expect(batches[0]!.__logBatch.messages.map((m: LogMessage): LogLevel => m.level)).toEqual(LOG_LEVELS.slice(0, 1));

    const firstAcked: boolean = acceptForwardedLogBatch({ __logBatchAccepted: batches[0]!.__logBatch.batchId }, sink);
    expect(firstAcked).toBeTrue();
    expect(batches).toHaveLength(2);
    expect(batches[1]!.__logBatch.messages.map((m: LogMessage): LogLevel => m.level)).toEqual(LOG_LEVELS.slice(1));
  });

  test("真实 Worker 线程按 logLevelState 阈值过滤并携带 level 转发到主线程", async () => {
    const loggerModuleUrl: string = import.meta.resolve("../../packages/infra/logger.ts");
    const logLevelModuleUrl: string = import.meta.resolve("../../packages/config/logLevel.ts");
    const forwardingModuleUrl: string = import.meta.resolve("../../packages/infra/logger/forwarding.ts");
    const workerScript: string = `
      import { logger } from ${JSON.stringify(loggerModuleUrl)};
      import { adoptLogLevel } from ${JSON.stringify(logLevelModuleUrl)};
      import { acceptForwardedLogBatch } from ${JSON.stringify(forwardingModuleUrl)};
      const noop = () => {};
      console.info = noop;
      console.warn = noop;
      console.error = noop;
      const sink = (batch) => self.postMessage(batch);
      self.onmessage = (event) => {
        if (acceptForwardedLogBatch(event.data, sink)) return;
        const payload = event.data;
        if (payload && payload.type === "emit") {
          adoptLogLevel(payload.threshold);
          logger.info("w-info");
          logger.operation("w-operation");
          logger.warn("w-warn");
          logger.error("w-error");
        }
      };
    `;
    const workerUrl: string = URL.createObjectURL(new Blob([workerScript], { type: "application/typescript" }));
    const worker = new Worker(workerUrl);

    function collectRun(threshold: LogLevel, expectedCount: number): Promise<LogMessage[]> {
      return new Promise((resolve, reject): void => {
        const collected: LogMessage[] = [];
        const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
          reject(new Error(`Timed out waiting for ${expectedCount} forwarded worker logs at threshold=${threshold}`));
        }, 5_000);
        worker.onmessage = (event: MessageEvent<unknown>): void => {
          const data: unknown = event.data;
          if (typeof data !== "object" || data === null || !("__logBatch" in data)) return;
          const batch = data as ForwardedLogBatch;
          collected.push(...batch.__logBatch.messages);
          worker.postMessage({ __logBatchAccepted: batch.__logBatch.batchId });
          if (collected.length >= expectedCount) {
            clearTimeout(timer);
            resolve(collected);
          }
        };
        worker.onerror = (event: ErrorEvent): void => {
          clearTimeout(timer);
          reject(event.error ?? new Error(event.message));
        };
        worker.postMessage({ type: "emit", threshold });
      });
    }

    try {
      const underOperation: LogMessage[] = await collectRun("operation", 3);
      expect(underOperation.map((m: LogMessage): [LogLevel, string] => [m.level, String(m.args[0])])).toEqual([
        ["operation", "w-operation"],
        ["warn", "w-warn"],
        ["error", "w-error"],
      ]);

      const underInfo: LogMessage[] = await collectRun("info", 4);
      expect(underInfo.map((m: LogMessage): [LogLevel, string] => [m.level, String(m.args[0])])).toEqual([
        ["info", "w-info"],
        ["operation", "w-operation"],
        ["warn", "w-warn"],
        ["error", "w-error"],
      ]);
    } finally {
      await worker.terminate();
      URL.revokeObjectURL(workerUrl);
    }
  });
});
