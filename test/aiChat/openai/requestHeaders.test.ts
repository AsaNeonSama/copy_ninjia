/**
 * openai provider 的默认与自定义端点及凭据头落到真实请求上：用真实 openai SDK，
 * 只替换 globalThis.fetch，核对 OPENAI_API_BASE_URL 与 SDK 内置缺省一致，且在
 * OPENAI_BASE_URL / OPENAI_LOG / OPENAI_ORG_ID / OPENAI_PROJECT_ID / OPENAI_WEBHOOK_SECRET
 * 被污染时 aiChat 与 ad_detect 两个构造点仍发往预期端点、不附加 organization/project 头、日志级别不变。
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import OpenAI from "openai";
import { withProcessEnv } from "../../helpers/common";
import {
  adoptAdDetectAgentConfig,
  adoptAgentDeploymentConfig,
  getAdDetectAgentConfig,
  getAgentDeploymentConfig,
} from "../../../packages/config/agent";
import { openAiClientCache } from "../../../packages/cache/workers/aiChat/openai";
import { adDetectOpenAiClientHolder } from "../../../packages/cache/workers/antiRaid/openai";
import { OPENAI_API_BASE_URL, OPENAI_SDK_LOG_LEVEL } from "../../../packages/consts/aiChat/openai";
import { getOpenAiClient, requestOpenAiResult } from "../../../packages/aiChat/openai/client";
import { requestOpenAiAdDetectJson } from "../../../packages/workers/antiRaid/adDetect/ai/openai";
import type {
  AdDetectAgentConfig,
  AgentDeploymentConfig,
  OpenAiAgentCapabilityConfig,
} from "../../../packages/types/config";

const GATEWAY: string = "https://gateway.ai.cloudflare.com/v1/acc/gw/openai";
const PRELOADED_AGENT: AgentDeploymentConfig = getAgentDeploymentConfig();
const PRELOADED_AD_DETECT: AdDetectAgentConfig = getAdDetectAgentConfig();

interface CapturedRequest {
  readonly url: string;
  readonly headers: Headers;
}

const captured: CapturedRequest[] = [];
const originalFetch: typeof fetch = globalThis.fetch;

function openAiCapability(apiKey: string, baseUrl: string | undefined): OpenAiAgentCapabilityConfig {
  return {
    provider: "openai",
    apiKey,
    baseUrl,
    model: "gpt-test",
  };
}

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
  const request: Request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
  captured.push({ url: request.url, headers: request.headers });
  if (request.url.endsWith("/chat/completions")) {
    return new Response(
      JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "{\"ad\":false,\"reason\":\"ok\"}" } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  return new Response(
    JSON.stringify({
      id: "resp-1",
      object: "response",
      status: "completed",
      error: null,
      incomplete_details: null,
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      output_text: "ok",
      usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
  adoptAgentDeploymentConfig(PRELOADED_AGENT);
  adoptAdDetectAgentConfig(PRELOADED_AD_DETECT);
  openAiClientCache.current = null;
  adDetectOpenAiClientHolder.current = null;
});

beforeEach(() => {
  captured.length = 0;
  openAiClientCache.current = null;
  adDetectOpenAiClientHolder.current = null;
});

describe("openai provider 官方默认端点、自定义端点与环境变量隔离", () => {
  test("OPENAI_API_BASE_URL 与 OPENAI_SDK_LOG_LEVEL 与 SDK 内置缺省逐字相同", async () => {
    await withProcessEnv({ OPENAI_BASE_URL: undefined, OPENAI_LOG: undefined }, (): void => {
      const client: OpenAI = new OpenAI({ apiKey: "k" });
      expect(client.baseURL).toBe(OPENAI_API_BASE_URL);
      expect(client.logLevel).toBe(OPENAI_SDK_LOG_LEVEL);
    });
  });

  test("base_url 缺省时 aiChat 与 ad_detect 均发往 OPENAI_API_BASE_URL，不泄漏 organization/project 头，也不读 OPENAI_LOG", async () => {
    await withProcessEnv({
      OPENAI_BASE_URL: "http://evil.openai.example/v1",
      OPENAI_LOG: "debug",
      OPENAI_ORG_ID: "org-evil",
      OPENAI_PROJECT_ID: "proj-evil",
      OPENAI_WEBHOOK_SECRET: "whsec-evil",
    }, async (): Promise<void> => {
      adoptAgentDeploymentConfig({
        ...PRELOADED_AGENT,
        text: openAiCapability("openai-text-key", undefined),
        summary: openAiCapability("openai-summary-key", undefined),
        media: openAiCapability("openai-media-key", undefined),
      });
      adoptAdDetectAgentConfig(openAiCapability("openai-ad-key", undefined));

      const replyResult = await requestOpenAiResult({
        capability: "text",
        buildBody: (): OpenAI.Responses.ResponseCreateParamsNonStreaming => ({
          model: "gpt-test",
          input: "hello",
        }),
        errorLabel: "OpenAI default baseURL test",
      });
      const adResult: string | null = await requestOpenAiAdDetectJson({
        model: "gpt-test",
        instructions: "inst",
        fact: "fact",
        systemPrompt: "sys",
        userContent: "1. hi",
        temperature: 0,
        maxOutputTokens: 64,
        errorLabel: "OpenAI ad_detect default baseURL test",
      });

      expect(replyResult.ok).toBe(true);
      expect(adResult).toBe("{\"ad\":false,\"reason\":\"ok\"}");
      expect(captured).toHaveLength(2);
      expect(captured[0]!.url).toBe(`${OPENAI_API_BASE_URL}/responses`);
      expect(captured[0]!.headers.get("authorization")).toBe("Bearer openai-text-key");
      expect(captured[0]!.headers.get("openai-organization")).toBeNull();
      expect(captured[0]!.headers.get("openai-project")).toBeNull();
      expect(captured[1]!.url).toBe(`${OPENAI_API_BASE_URL}/chat/completions`);
      expect(captured[1]!.headers.get("authorization")).toBe("Bearer openai-ad-key");
      expect(captured[1]!.headers.get("openai-organization")).toBeNull();
      expect(captured[1]!.headers.get("openai-project")).toBeNull();
      expect(getOpenAiClient("text").logLevel).toBe(OPENAI_SDK_LOG_LEVEL);
      expect(adDetectOpenAiClientHolder.current?.logLevel).toBe(OPENAI_SDK_LOG_LEVEL);
    });
  });

  test("配置了 base_url 时仍发往配置的自定义端点，且同样不附加环境变量中的组织与项目头", async () => {
    await withProcessEnv({
      OPENAI_BASE_URL: "http://evil.openai.example/v1",
      OPENAI_ORG_ID: "org-evil",
      OPENAI_PROJECT_ID: "proj-evil",
    }, async (): Promise<void> => {
      adoptAgentDeploymentConfig({
        ...PRELOADED_AGENT,
        text: openAiCapability("openai-gw-key", GATEWAY),
        summary: openAiCapability("openai-summary-key", GATEWAY),
        media: openAiCapability("openai-media-key", GATEWAY),
      });
      adoptAdDetectAgentConfig(openAiCapability("openai-ad-gw-key", GATEWAY));

      await requestOpenAiResult({
        capability: "text",
        buildBody: (): OpenAI.Responses.ResponseCreateParamsNonStreaming => ({
          model: "gpt-test",
          input: "hello",
        }),
        errorLabel: "OpenAI custom baseURL test",
      });
      await requestOpenAiAdDetectJson({
        model: "gpt-test",
        instructions: "inst",
        fact: "fact",
        systemPrompt: "sys",
        userContent: "1. hi",
        temperature: 0,
        maxOutputTokens: 64,
        errorLabel: "OpenAI ad_detect custom baseURL test",
      });

      expect(captured).toHaveLength(2);
      expect(captured[0]!.url).toBe(`${GATEWAY}/responses`);
      expect(captured[0]!.headers.get("openai-organization")).toBeNull();
      expect(captured[0]!.headers.get("openai-project")).toBeNull();
      expect(captured[1]!.url).toBe(`${GATEWAY}/chat/completions`);
      expect(captured[1]!.headers.get("openai-organization")).toBeNull();
      expect(captured[1]!.headers.get("openai-project")).toBeNull();
    });
  });
});
