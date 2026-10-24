/**
 * anthropic provider 的 base_url 与 Bearer 凭据头落到真实请求上：用真实 @anthropic-ai/sdk，
 * 只替换 globalThis.fetch，核对请求发往配置的端点并带上 authorization（Bearer api_key），且不发送
 * x-api-key；base_url 缺省时发往 ANTHROPIC_API_BASE_URL，不受 ANTHROPIC_BASE_URL / ANTHROPIC_LOG 影响。
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { withProcessEnv } from "../../helpers/common";
import { adoptAgentDeploymentConfig, getAgentDeploymentConfig } from "../../../packages/config/agent";
import { anthropicClientCache } from "../../../packages/cache/workers/aiChat/anthropic";
import { ANTHROPIC_API_BASE_URL, ANTHROPIC_SDK_LOG_LEVEL } from "../../../packages/consts/aiChat/anthropic";
import { requestAnthropicMessage } from "../../../packages/aiChat/anthropic/client";
import { createAnthropicClient } from "../../../packages/aiChat/anthropic/sdkClient";
import type { AgentDeploymentConfig, AnthropicAgentCapabilityConfig } from "../../../packages/types/config";

const PROXY: string = "https://proxy.example/anthropic";
const PRELOADED: AgentDeploymentConfig = getAgentDeploymentConfig();

interface CapturedRequest {
  readonly url: string;
  readonly headers: Headers;
}

const captured: CapturedRequest[] = [];
const originalFetch: typeof fetch = globalThis.fetch;

function anthropicCapability(apiKey: string, baseUrl: string | undefined): AnthropicAgentCapabilityConfig {
  return {
    provider: "anthropic",
    apiKey,
    baseUrl,
    model: "claude-test",
    fallbackModel: undefined,
  };
}

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
  const request: Request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
  captured.push({ url: request.url, headers: request.headers });
  return new Response(
    JSON.stringify({
      id: "msg-1",
      type: "message",
      role: "assistant",
      model: "claude-test",
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
  adoptAgentDeploymentConfig(PRELOADED);
  anthropicClientCache.current = null;
});

beforeEach(() => {
  captured.length = 0;
  anthropicClientCache.current = null;
  adoptAgentDeploymentConfig({
    ...PRELOADED,
    text: anthropicCapability("anthropic-text-key", PROXY),
    summary: anthropicCapability("anthropic-summary-key", PROXY),
    media: anthropicCapability("anthropic-media-key", PROXY),
  });
});

describe("anthropic provider 自定义端点与 Bearer 凭据头", () => {
  test("Messages 请求发往 base_url，带 authorization Bearer，不发 x-api-key", async () => {
    const result = await requestAnthropicMessage({
      capability: "text",
      buildBody: (): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming => ({
        model: "claude-test",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      }),
      errorLabel: "Anthropic header test",
    });

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url.startsWith(`${PROXY}/v1/messages`)).toBe(true);
    expect(captured[0]!.headers.get("authorization")).toBe("Bearer anthropic-text-key");
    expect(captured[0]!.headers.get("x-api-key")).toBeNull();
  });

  test("ANTHROPIC_API_BASE_URL 与 ANTHROPIC_SDK_LOG_LEVEL 与 SDK 内置缺省逐字相同，且不受 ANTHROPIC_BASE_URL / ANTHROPIC_LOG 污染", async () => {
    await withProcessEnv({ ANTHROPIC_BASE_URL: undefined, ANTHROPIC_LOG: undefined }, (): void => {
      const client: Anthropic = new Anthropic({ apiKey: "k" });
      expect(client.baseURL).toBe(ANTHROPIC_API_BASE_URL);
      expect(client.logLevel).toBe(ANTHROPIC_SDK_LOG_LEVEL);
    });

    await withProcessEnv({
      ANTHROPIC_BASE_URL: "http://evil.anthropic.example",
      ANTHROPIC_LOG: "debug",
    }, async (): Promise<void> => {
      anthropicClientCache.current = null;
      adoptAgentDeploymentConfig({
        ...PRELOADED,
        text: anthropicCapability("anthropic-default-key", undefined),
      });

      const result = await requestAnthropicMessage({
        capability: "text",
        buildBody: (): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming => ({
          model: "claude-test",
          max_tokens: 64,
          messages: [{ role: "user", content: "hello" }],
        }),
        errorLabel: "Anthropic default baseURL test",
      });

      expect(result.ok).toBe(true);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.url.startsWith(`${ANTHROPIC_API_BASE_URL}/v1/messages`)).toBe(true);
      expect(createAnthropicClient(anthropicCapability("anthropic-log-key", undefined), { timeoutMs: 1_000, maxRetries: 0 }).sdk.logLevel)
        .toBe(ANTHROPIC_SDK_LOG_LEVEL);
    });
  });
});
