import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Context } from "grammy";
import { runWithUpdateAbortSignal } from "../../packages/infra/updateContext";

const logApiError = mock((..._args: unknown[]): void => {});
mock.module("../../packages/infra/telegram", () => ({ logApiError }));

const { answerInlineQuery } = await import("../../packages/commands/inlineAnswer");

beforeEach((): void => {
  logApiError.mockClear();
});

describe("commands/inlineAnswer", () => {
  test("成功应答传出 cache_time 与 is_personal 并返回 false", async () => {
    const answerMock = mock(async (): Promise<void> => {});
    const ctx: Context = { answerInlineQuery: answerMock } as unknown as Context;

    const rejected: boolean = await answerInlineQuery({
      ctx,
      results: [],
      cacheTime: 30,
      action: "answer test inline query",
    });

    expect(rejected).toBeFalse();
    expect(answerMock).toHaveBeenCalledWith([], { cache_time: 30, is_personal: true }, undefined);
    expect(logApiError).not.toHaveBeenCalled();
  });

  test("Bot API 明确拒收时记错误并返回 true；网络错误记错误并返回 false", async () => {
    const rejectedError: Error = Object.assign(new Error("Bad Request"), {
      error_code: 400,
      description: "Bad Request: query is too old",
    });
    const rejectedCtx: Context = {
      answerInlineQuery: async (): Promise<void> => { throw rejectedError; },
    } as unknown as Context;

    await expect(answerInlineQuery({
      ctx: rejectedCtx,
      results: [],
      cacheTime: 0,
      action: "answer rejected inline query",
    })).resolves.toBeTrue();
    expect(logApiError).toHaveBeenCalledWith("answer rejected inline query", rejectedError);

    logApiError.mockClear();
    const networkError: Error = new Error("socket hang up");
    const networkCtx: Context = {
      answerInlineQuery: async (): Promise<void> => { throw networkError; },
    } as unknown as Context;

    await expect(answerInlineQuery({
      ctx: networkCtx,
      results: [],
      cacheTime: 0,
      action: "answer network inline query",
    })).resolves.toBeFalse();
    expect(logApiError).toHaveBeenCalledWith("answer network inline query", networkError);
  });

  test("update 已被中止时直接上抛取消异常而不记 API 错误", async () => {
    const controller: AbortController = new AbortController();
    const abortReason: DOMException = new DOMException("shutdown", "AbortError");
    const ctx: Context = {
      answerInlineQuery: async (): Promise<void> => {
        controller.abort(abortReason);
        throw new Error("aborted");
      },
    } as unknown as Context;

    await expect(runWithUpdateAbortSignal(controller.signal, (): Promise<boolean> =>
      answerInlineQuery({
        ctx,
        results: [],
        cacheTime: 0,
        action: "answer aborted inline query",
      })
    )).rejects.toBe(abortReason);
    expect(logApiError).not.toHaveBeenCalled();
  });
});
