import { describe, expect, spyOn, test } from "bun:test";
import {
  classifyProviderApiFailure,
  handleProviderRequestError,
  logAndClassifyProviderApiError,
  numericErrorStatus,
  providerApiFailureResult,
} from "../../../../packages/workers/aiChat/ai/utils/mediaSupportError";
import type { ProviderApiFailureKind } from
  "../../../../packages/workers/aiChat/ai/utils/mediaSupportError";
import { logger } from "../../../../packages/infra/logger";

/**
 * 归因级联的顺序（见 mediaSupportError.ts 的头注），不经由任何 SDK 替身，
 * 直接对级联函数与三档结果映射做断言。
 */

/** 同时命中「不支持」与「媒体输入」两类语义的典型上游文案。 */
const UNSUPPORTED_MEDIA_MESSAGE: string =
  "This model does not support image input for the requested modality.";

describe("供应商 API 失败的状态读取", () => {
  test("只认数值 status，其余形态一律读成未知", () => {
    expect(numericErrorStatus({ status: 404 })).toBe(404);
    expect(numericErrorStatus({ status: "404" })).toBeUndefined();
    expect(numericErrorStatus({})).toBeUndefined();
    expect(numericErrorStatus(new Error("network"))).toBeUndefined();
  });
});

describe("供应商 API 失败的归因级联", () => {
  test("单份媒体的格式、编码与损坏错误不关闭模态", () => {
    for (const message of [
      "Unsupported image format", "Cannot process corrupted image",
      "Model does not support this audio codec", "Unsupported media type",
      "Image MIME type is not supported", "Cannot process invalid image URL",
    ]) {
      for (const status of [400, 415, 422]) {
        expect(classifyProviderApiFailure(status, message, true)).toBe("rejected");
      }
    }
  });
  test("路径级 404/405 最先判，压过同一条消息里的模态语义", () => {
    // 正文本身命中 unsupported 语义，但 404/405 优先于模态判断。
    for (const status of [404, 405]) {
      expect(classifyProviderApiFailure(status, UNSUPPORTED_MEDIA_MESSAGE, true))
        .toBe("misconfigured");
      expect(classifyProviderApiFailure(status, "not found", false))
        .toBe("misconfigured");
    }
  });

  test("只有媒体能力才可能得出 unsupported，且要求正文同时命中两类语义", () => {
    for (const status of [400, 415, 422]) {
      expect(classifyProviderApiFailure(status, UNSUPPORTED_MEDIA_MESSAGE, true))
        .toBe("unsupported");
      // 同一条正文换成非媒体能力：模态结论根本不该出现。
      expect(classifyProviderApiFailure(status, UNSUPPORTED_MEDIA_MESSAGE, false))
        .toBe("rejected");
      // 只有「不支持」没有「媒体输入」，或反过来，都不足以下模态结论。
      expect(classifyProviderApiFailure(status, "unsupported parameter: temperature", true))
        .toBe("rejected");
      expect(classifyProviderApiFailure(status, "image is too large", true))
        .toBe("rejected");
    }
  });

  test("其余非故障状态一律 rejected：这一份输入不合适，不推动模态退避", () => {
    expect(classifyProviderApiFailure(400, "invalid request", true)).toBe("rejected");
    expect(classifyProviderApiFailure(401, UNSUPPORTED_MEDIA_MESSAGE, true)).toBe("rejected");
    expect(classifyProviderApiFailure(403, UNSUPPORTED_MEDIA_MESSAGE, true)).toBe("rejected");
    // 403 不在 unsupported 的白名单状态里，正文命中也不改结论。
    expect(classifyProviderApiFailure(413, "payload too large", true)).toBe("rejected");
  });

  test("拿不到状态码、408/429 与 5xx 都归端点故障", () => {
    expect(classifyProviderApiFailure(undefined, "socket hang up", true)).toBe("endpointFailure");
    expect(classifyProviderApiFailure(408, "timeout", false)).toBe("endpointFailure");
    expect(classifyProviderApiFailure(429, "rate limited", false)).toBe("endpointFailure");
    expect(classifyProviderApiFailure(500, "internal", false)).toBe("endpointFailure");
    expect(classifyProviderApiFailure(503, UNSUPPORTED_MEDIA_MESSAGE, true)).toBe("endpointFailure");
  });
});

describe("归因档位到失败结果的映射", () => {
  test("三档可直接返回的结论各自映射成同名 failureKind", () => {
    expect(providerApiFailureResult("misconfigured")).toEqual({ ok: false, failureKind: "misconfigured" });
    expect(providerApiFailureResult("unsupported")).toEqual({ ok: false, failureKind: "unsupported" });
    expect(providerApiFailureResult("rejected")).toEqual({ ok: false, failureKind: "rejected" });
  });

  test("endpointFailure 不映射成结果，交由调用点走自己的兜底路径", () => {
    const kind: ProviderApiFailureKind = "endpointFailure";
    expect(providerApiFailureResult(kind)).toBeUndefined();
  });

  test("logAndClassifyProviderApiError 记录结构化错误日志并返回分类档位", () => {
    const errorLog = spyOn(logger, "error").mockImplementation((): void => {});
    try {
      expect(
        logAndClassifyProviderApiError({
          error: { status: 404, message: "not found" },
          errorLabel: "OpenAI text",
          isMediaCapability: false,
        })
      ).toBe("misconfigured");
      expect(
        logAndClassifyProviderApiError({
          error: { status: 415, message: UNSUPPORTED_MEDIA_MESSAGE },
          errorLabel: "Gemini media",
          isMediaCapability: true,
        })
      ).toBe("unsupported");
      expect(errorLog.mock.calls).toEqual([
        ["Provider API error.", { errorLabel: "OpenAI text", status: 404, message: "not found" }],
        ["Provider API error.", { errorLabel: "Gemini media", status: 415, message: UNSUPPORTED_MEDIA_MESSAGE }],
      ]);
    } finally {
      errorLog.mockRestore();
    }
  });

  test("handleProviderRequestError 按 APIError 归因或按供应商静态文案记日志并归一为 request", () => {
    const errorLog = spyOn(logger, "error").mockImplementation((): void => {});
    try {
      const apiErr: { status: number; message: string } = { status: 404, message: "missing" };
      expect(handleProviderRequestError({
        error: apiErr,
        provider: "google",
        apiError: apiErr,
        errorLabel: "Gemini text",
        isMediaCapability: false,
      })).toEqual({ ok: false, failureKind: "misconfigured" });

      const retryableApiErr: { status: number; message: string } = { status: 503, message: "busy" };
      expect(handleProviderRequestError({
        error: retryableApiErr,
        provider: "openai",
        apiError: retryableApiErr,
        errorLabel: "OpenAI text",
        isMediaCapability: false,
      })).toEqual({ ok: false, failureKind: "request" });

      const netErr: Error = new Error("socket closed");
      expect(handleProviderRequestError({
        error: netErr,
        provider: "google",
        apiError: null,
        errorLabel: "Gemini text",
        isMediaCapability: false,
      })).toEqual({ ok: false, failureKind: "request" });
      expect(handleProviderRequestError({
        error: netErr,
        provider: "openai",
        apiError: null,
        errorLabel: "OpenAI text",
        isMediaCapability: false,
      })).toEqual({ ok: false, failureKind: "request" });
      expect(handleProviderRequestError({
        error: netErr,
        provider: "anthropic",
        apiError: null,
        errorLabel: "Anthropic text",
        isMediaCapability: false,
      })).toEqual({ ok: false, failureKind: "request" });

      expect(errorLog.mock.calls).toEqual([
        ["Provider API error.", { errorLabel: "Gemini text", status: 404, message: "missing" }],
        ["Provider API error.", { errorLabel: "OpenAI text", status: 503, message: "busy" }],
        ["Error calling Gemini API:", { errorLabel: "Gemini text" }, netErr],
        ["Error calling OpenAI API:", { errorLabel: "OpenAI text" }, netErr],
        ["Error calling Anthropic API:", { errorLabel: "Anthropic text" }, netErr],
      ]);
    } finally {
      errorLog.mockRestore();
    }
  });
});
