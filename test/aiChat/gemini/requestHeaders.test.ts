import { TTS_DEFAULT_BOT_LANGUAGE, TTS_DEFAULT_STYLE } from "../../../packages/consts/aiChat/voiceMessage";
/**
 * google provider 的 base_url 与凭据头落到真实请求上：用真实 @google/genai SDK，
 * 只替换 globalThis.fetch，核对 generateContent 与 Interactions（语音合成）两条路径
 * 都发往配置的端点，并由 api_key 写出 x-goog-api-key；base_url 缺省时
 * aiChat 与 ad_detect 都发往 GEMINI_API_BASE_URL，请求与 SDK 缺省逐项一致，且不受 Google 环境变量影响。
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GoogleGenAI } from "@google/genai";
import { withProcessEnv } from "../../helpers/common";
import {
  adoptAdDetectAgentConfig,
  adoptAgentDeploymentConfig,
  getAdDetectAgentConfig,
  getAgentDeploymentConfig,
} from "../../../packages/config/agent";
import { geminiClientCache } from "../../../packages/cache/workers/aiChat/gemini";
import { adDetectGoogleClientHolder } from "../../../packages/cache/workers/antiRaid/google";
import { GEMINI_API_BASE_URL } from "../../../packages/consts/aiChat/gemini";
import { requestGeminiResult } from "../../../packages/aiChat/gemini/client";
import { synthesizeGeminiSpeech } from "../../../packages/aiChat/gemini/speech";
import { requestGoogleAdDetectJson } from "../../../packages/workers/antiRaid/adDetect/ai/google";
import type { GenerateContentParameters } from "@google/genai";
import type { SynthesizedSpeech } from "../../../packages/types/aiChat/voiceMessage";
import type {
  AdDetectAgentConfig,
  AgentDeploymentConfig,
  GoogleAgentCapabilityConfig,
} from "../../../packages/types/config";

const PROXY: string = "https://proxy.example/google";
const WAV_BYTES: Uint8Array = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
const PRELOADED_AGENT: AgentDeploymentConfig = getAgentDeploymentConfig();
const PRELOADED_AD_DETECT: AdDetectAgentConfig = getAdDetectAgentConfig();

interface CapturedRequest {
  readonly url: string;
  readonly headers: Headers;
}

const captured: CapturedRequest[] = [];
const originalFetch: typeof fetch = globalThis.fetch;

function googleCapability(apiKey: string, baseUrl: string | undefined): GoogleAgentCapabilityConfig {
  return {
    provider: "google",
    apiKey,
    baseUrl,
    model: "gemini-test",
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
  const request: Request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
  captured.push({ url: request.url, headers: request.headers });
  if (request.url.includes("/interactions")) {
    return jsonResponse({
      id: "interaction-1",
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "audio", data: WAV_BYTES.toBase64(), mime_type: "audio/wav" }] }],
    });
  }
  if (request.url.includes("/cachedContents")) {
    return jsonResponse(request.method === "POST" ? { name: "cachedContents/c1" } : { cachedContents: [] });
  }
  if (request.url.includes("/models/gemini-test") && !request.url.includes(":")) {
    return jsonResponse({ name: "models/gemini-test" });
  }
  return jsonResponse({
    candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "{\"ad\":false,\"reason\":\"ok\"}" }] } }],
  });
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
  adoptAgentDeploymentConfig(PRELOADED_AGENT);
  adoptAdDetectAgentConfig(PRELOADED_AD_DETECT);
  geminiClientCache.current = null;
  adDetectGoogleClientHolder.current = null;
});

beforeEach(() => {
  captured.length = 0;
  geminiClientCache.current = null;
  adDetectGoogleClientHolder.current = null;
  adoptAgentDeploymentConfig({
    text: googleCapability("text-key", PROXY),
    summary: googleCapability("summary-key", PROXY),
    media: googleCapability("media-key", PROXY),
    tts: { ...googleCapability("tts-key", PROXY), voice: "Leda", speechProtocol: undefined, style: TTS_DEFAULT_STYLE, language: undefined, botLanguage: TTS_DEFAULT_BOT_LANGUAGE, dailyLimit: 100, dailyReserveQuota: 25 },
  });
});

describe("google provider 自定义端点与凭据头", () => {
  test("generateContent 发往 base_url 并带上 x-goog-api-key", async () => {
    await requestGeminiResult({ capability: "text", buildBody: (): GenerateContentParameters => ({
      model: "gemini-test",
      contents: "hello",
    }), errorLabel: "Gemini header test" });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url.startsWith(`${PROXY}/`)).toBe(true);
    expect(captured[0]!.url).toContain(":generateContent");
    expect(captured[0]!.headers.get("x-goog-api-key")).toBe("text-key");
  });

  test("语音合成走 Interactions，同样发往 base_url 并带上 x-goog-api-key", async () => {
    const speech: SynthesizedSpeech | null = await synthesizeGeminiSpeech({ text: "テスト" });

    expect(speech?.bytes).toEqual(WAV_BYTES);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url.startsWith(`${PROXY}/`)).toBe(true);
    expect(captured[0]!.url).toContain("/interactions");
    expect(captured[0]!.headers.get("x-goog-api-key")).toBe("tts-key");
  });

  test("GEMINI_API_BASE_URL 与 SDK 缺省在五类端点上产出的请求 URL 及请求头逐项一致", async () => {
    const exercise = async (client: GoogleGenAI): Promise<{ url: string; headers: [string, string][] }[]> => {
      captured.length = 0;
      await client.models.generateContent({ model: "gemini-test", contents: "hi" });
      await client.models.get({ model: "gemini-test" });
      for await (const _entry of await client.caches.list()) break;
      await client.caches.create({ model: "gemini-test", config: { systemInstruction: "sys" } });
      await client.interactions.create({ model: "gemini-test", input: "hi" });
      return captured.map(({ url, headers }: CapturedRequest) => ({
        url,
        headers: [...headers.entries()].sort(([a], [b]): number => a.localeCompare(b)),
      }));
    };

    await withProcessEnv({
      GOOGLE_GEMINI_BASE_URL: undefined,
      GOOGLE_GENAI_USE_ENTERPRISE: undefined,
      GOOGLE_GENAI_USE_VERTEXAI: undefined,
      GOOGLE_CLOUD_PROJECT: undefined,
      GOOGLE_CLOUD_LOCATION: undefined,
    }, async (): Promise<void> => {
      const implicit = await exercise(new GoogleGenAI({ apiKey: "parity-key" }));
      const explicit = await exercise(new GoogleGenAI({
        apiKey: "parity-key",
        enterprise: false,
        httpOptions: { baseUrl: GEMINI_API_BASE_URL },
      }));
      expect(explicit).toEqual(implicit);
      expect(explicit).toHaveLength(5);
      for (const req of explicit) expect(req.url.startsWith(GEMINI_API_BASE_URL)).toBe(true);
    });
  });

  test("base_url 缺省时 aiChat 与 ad_detect 均不受 GOOGLE_GEMINI_BASE_URL 与 Vertex 开关环境变量污染", async () => {
    await withProcessEnv({
      GOOGLE_GEMINI_BASE_URL: "http://evil.google.example",
      GOOGLE_GENAI_USE_ENTERPRISE: "true",
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "evil-project",
      GOOGLE_CLOUD_LOCATION: "us-central1",
    }, async (): Promise<void> => {
      geminiClientCache.current = null;
      adDetectGoogleClientHolder.current = null;
      adoptAgentDeploymentConfig({
        text: googleCapability("text-default-key", undefined),
        summary: googleCapability("summary-key", undefined),
        media: googleCapability("media-key", undefined),
      });
      adoptAdDetectAgentConfig(googleCapability("ad-default-key", undefined));

      await requestGeminiResult({
        capability: "text",
        buildBody: (): GenerateContentParameters => ({ model: "gemini-test", contents: "hello" }),
        errorLabel: "Gemini default baseUrl test",
      });
      await requestGoogleAdDetectJson({
        model: "gemini-test",
        instructions: "inst",
        fact: "fact",
        systemPrompt: "sys",
        userContent: "1. hi",
        temperature: 0,
        maxOutputTokens: 64,
        errorLabel: "Google ad_detect default baseUrl test",
      });

      // 两次 generateContent 各一条；显式缓存探测的 models.get 是否已发出取决于后台时序，只核对其端点。
      const urls: string[] = captured.map((req: CapturedRequest): string => req.url);
      expect(urls.filter((url: string): boolean => url.endsWith(":generateContent"))).toHaveLength(2);
      for (const url of urls) {
        expect(url.startsWith(GEMINI_API_BASE_URL)).toBe(true);
        expect(url).not.toContain("aiplatform.googleapis.com");
      }
    });
  });
});
