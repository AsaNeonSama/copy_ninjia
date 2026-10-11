import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AiTextResult } from "../../../../packages/types/aiChat/provider";
import { loggerStub } from "../../../helpers/loggerMock";

const loggerWarn = mock((..._args: unknown[]): void => {});
const sleep = mock(async (_ms: number, _signal?: AbortSignal): Promise<void> => {});
mock.module("../../../../packages/infra/logger", () => ({
  logger: loggerStub({ warn: loggerWarn }),
}));
mock.module("../../../../packages/libs/sleep", () => ({ sleep }));

const { resampleAiText } = await import("../../../../packages/aiChat/ai/utils/resample");

const DELAYS_MS: readonly number[] = [10, 20];
const UNUSABLE: AiTextResult = { ok: false, retryable: true };

/** 按顺序依次返回给定结果的采样替身。 */
function callReturning(...results: AiTextResult[]): () => Promise<AiTextResult> {
  return mock(async (): Promise<AiTextResult> => results.shift()!);
}

beforeEach(() => {
  loggerWarn.mockClear();
  sleep.mockReset();
  sleep.mockResolvedValue(undefined);
});

describe("resampleAiText", () => {
  test("首次成功直接返回正文，不等待也不记日志", async () => {
    const call: () => Promise<AiTextResult> = callReturning({ ok: true, text: "done" });
    await expect(resampleAiText({ label: "Test", call, delaysMs: DELAYS_MS, signal: new AbortController().signal }))
      .resolves.toBe("done");
    expect(sleep).not.toHaveBeenCalled();
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  test("可重试时按档位逐次等待并记 warn，成功即返回", async () => {
    const signal: AbortSignal = new AbortController().signal;
    const call: () => Promise<AiTextResult> = callReturning(UNUSABLE, UNUSABLE, { ok: true, text: "late" });
    await expect(resampleAiText({ label: "Test", call, delaysMs: DELAYS_MS, signal })).resolves.toBe("late");
    expect(sleep.mock.calls).toEqual([[DELAYS_MS[0]!, signal], [DELAYS_MS[1]!, signal]]);
    expect(loggerWarn.mock.calls).toEqual([
      [`Test attempt 1 returned no usable text; resampling in ${DELAYS_MS[0]} ms.`],
      [`Test attempt 2 returned no usable text; resampling in ${DELAYS_MS[1]} ms.`],
    ]);
  });

  test("档位用尽后返回 null：采样次数等于档位数加一", async () => {
    const call = mock(async (): Promise<AiTextResult> => UNUSABLE);
    await expect(resampleAiText({ label: "Test", call, delaysMs: DELAYS_MS, signal: new AbortController().signal }))
      .resolves.toBeNull();
    expect(call).toHaveBeenCalledTimes(DELAYS_MS.length + 1);
  });

  test("不可重试的失败立即返回 null", async () => {
    const call = mock(async (): Promise<AiTextResult> => ({ ok: false, retryable: false }));
    await expect(resampleAiText({ label: "Test", call, delaysMs: DELAYS_MS, signal: new AbortController().signal }))
      .resolves.toBeNull();
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test("退避等待期间中止时以中止原因 reject，不再发起采样", async () => {
    const controller: AbortController = new AbortController();
    const reason: Error = new Error("stopped");
    sleep.mockImplementationOnce(async (): Promise<void> => {
      controller.abort(reason);
      throw reason;
    });
    const call = mock(async (): Promise<AiTextResult> => UNUSABLE);
    await expect(resampleAiText({ label: "Test", call, delaysMs: DELAYS_MS, signal: controller.signal }))
      .rejects.toBe(reason);
    expect(call).toHaveBeenCalledTimes(1);
  });

  test("采样期间中止时丢弃结果返回 null；已中止时不发起采样", async () => {
    const controller: AbortController = new AbortController();
    const aborting = mock(async (): Promise<AiTextResult> => {
      controller.abort();
      return { ok: true, text: "stale" };
    });
    await expect(resampleAiText({ label: "Test", call: aborting, delaysMs: DELAYS_MS, signal: controller.signal }))
      .resolves.toBeNull();
    const idle = mock(async (): Promise<AiTextResult> => ({ ok: true, text: "never" }));
    await expect(resampleAiText({ label: "Test", call: idle, delaysMs: DELAYS_MS, signal: controller.signal }))
      .resolves.toBeNull();
    expect(idle).not.toHaveBeenCalled();
  });
});
