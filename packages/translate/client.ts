import { TRANSLATE_LANGUAGE_CODES, TRANSLATE_REGIONAL_MODEL } from "../consts/translate";
import type { TranslateLanguage } from "../types/translate";
import { logger } from "../infra/logger";
import type { v3 as GoogleTranslate, protos } from "@google-cloud/translate";
import { googleServiceAccountKey, translateParentCache, translateRuntime } from "../cache/main/translate";
import type { GoogleServiceAccountKey } from "../types/config";
import { TRANSLATE_REQUEST_TIMEOUT_MS } from "../consts/lifecycle";
import { withTimeout } from "../libs/withTimeout";
import { assertTimeoutMs, settleWithinBudget, trackInflight } from "../libs/inflight";
import type { FlushResult } from "../types/lifecycle";

// Google Cloud Translation - Advanced (v3) 客户端使用启动时发布的凭据快照。

/** TranslationServiceClient 构造器的选项形状。 */
interface TranslateClientParams {
  /** 启动总闸严格解析的完整服务账号快照。 */
  credentials: GoogleServiceAccountKey;
  /**
   * SDK 真实的 `ClientOptions`（来自传递依赖 google-gax）带索引签名，本接口以索引签名
   * 满足构造器形参的逆变要求；类型不直接引自 google-gax（传递依赖，不在本仓 package.json 里）。
   */
  [option: string]: string | number | object | undefined;
}

/**
 * 动态 import 回来的 SDK 里，本模块唯一用到的那部分：只声明 TranslationServiceClient
 * 构造器，SDK 真实签名一旦漂移就在编译期暴露。
 */
interface TranslateSdkV3 {
  TranslationServiceClient: new (options: TranslateClientParams) => GoogleTranslate.TranslationServiceClient;
}

/** 由应用生命周期显式开启；仍不会在没有真实请求时构造 gRPC 客户端。 */
export function initTranslate(): void {
  translateRuntime.accepting = true;
}

/** 同步关闭新工作入口，已开始的请求交给 drainTranslate 等待。 */
export function quiesceTranslate(): void {
  translateRuntime.accepting = false;
}

/**
 * 世代闸：owner 已被 close/重开时，在途请求必须就地失败而不是继续用旧世代。
 * @param expectedGeneration 发起请求时捕获的翻译运行时世代号。
 */
function ensureTranslateGeneration(expectedGeneration: number): void {
  if (expectedGeneration !== translateRuntime.generation) {
    throw new Error("Google Translation owner was closed while the request was in flight");
  }
}

/**
 * 惰性获取当前世代的 Google Cloud Translation v3 客户端：
 * 首次真实翻译请求到达时才动态加载 `@google-cloud/translate` 并构造 gRPC 客户端；模块导入与生命周期钩子均不触发 SDK 加载或注册退避定时器。
 * 动态导入完成后先复核 `expectedGeneration`，若期间 `closeTranslate` 已推进世代则直接抛错，不在旧世代上构造客户端。
 * @param expectedGeneration 发起请求时捕获的翻译运行时世代号。
 * @returns 当前世代复用的 Google Cloud Translation v3 客户端实例。
 */
async function getTranslateClient(expectedGeneration: number): Promise<GoogleTranslate.TranslationServiceClient> {
  if (translateRuntime.client !== null) return translateRuntime.client;
  const credentials: GoogleServiceAccountKey | null = googleServiceAccountKey.current;
  if (credentials === null) throw new Error("Google Translation credentials were not configured at startup");
  const { v3 }: { v3: TranslateSdkV3 } = await import("@google-cloud/translate");
  ensureTranslateGeneration(expectedGeneration);
  // 并发首次请求同时到达时只保留最先构造出的实例。
  translateRuntime.client ??= new v3.TranslationServiceClient({
    credentials,
  });
  return translateRuntime.client;
}

/**
 * 解析并缓存 Google Cloud Translation v3 请求所需的父资源路径（`projects/{project}/locations/global`）。
 * @param expectedGeneration 发起请求时捕获的翻译运行时世代号。
 * @returns 供 v3 API 使用的 parent 资源路径字符串。
 */
async function getTranslateParent(expectedGeneration: number): Promise<string> {
  ensureTranslateGeneration(expectedGeneration);
  if (!translateParentCache.parent) {
    const projectId: string = await withTimeout(
      (await getTranslateClient(expectedGeneration)).getProjectId(),
      TRANSLATE_REQUEST_TIMEOUT_MS,
      "Google Translation project lookup"
    );
    // 复核世代号，拦截 closeTranslate 之后的迟到回执。
    ensureTranslateGeneration(expectedGeneration);
    translateParentCache.parent = `projects/${projectId}/locations/global`;
  }
  return translateParentCache.parent;
}

/**
 * 通过 Google Cloud Translation API 将文本翻译成指定语言。
 * 失败时返回 null，调用方整条不发送。
 * @param text 待翻译的文本。
 * @param language 目标翻译语言方向。
 * @param expectedGeneration 发起请求时捕获的翻译运行时世代号。
 * @returns 译文字符串；请求失败或译文为空时返回 null。
 */
async function runTranslation(text: string, language: TranslateLanguage, expectedGeneration: number): Promise<string | null> {
  try {
    const parent: string = await getTranslateParent(expectedGeneration);
    ensureTranslateGeneration(expectedGeneration);
    const [response]: [
      protos.google.cloud.translation.v3.ITranslateTextResponse,
      protos.google.cloud.translation.v3.ITranslateTextRequest | undefined,
      Record<string, never> | undefined
    ] = await (await getTranslateClient(expectedGeneration)).translateText({
      parent,
      contents: [text],
      mimeType: "text/plain",
      targetLanguageCode: TRANSLATE_LANGUAGE_CODES[language],
      model: language === "en" ? `${parent}/models/${TRANSLATE_REGIONAL_MODEL}` : undefined,
    }, { timeout: TRANSLATE_REQUEST_TIMEOUT_MS });
    const translated: string | null | undefined = response.translations?.[0]?.translatedText;
    return translated ? translated : null;
  } catch (error: unknown) {
    logger.error("Error translating text:", error);
    return null;
  }
}

/**
 * 在翻译运行期开启状态下将文本翻译为指定语言，并纳入在途任务追踪。
 * @param text 待翻译的文本。
 * @param language 目标翻译语言方向。
 * @returns 译文字符串；未开启接收、请求失败或译文为空时返回 null。
 */
export function translateText(text: string, language: TranslateLanguage): Promise<string | null> {
  if (!translateRuntime.accepting) return Promise.resolve(null);
  return trackInflight(
    translateRuntime.tasks,
    runTranslation(text, language, translateRuntime.generation)
  );
}

/**
 * 等待所有已接收翻译结束；超时只报告，closeTranslate 仍会尝试关闭通道。
 * @param timeoutMs 最大等待毫秒数。
 * @returns 全部在途任务在预算内完成时返回 flushed，否则返回 timedOut。
 */
export async function drainTranslate(timeoutMs: number): Promise<FlushResult> {
  assertTimeoutMs(timeoutMs, "translate drain timeout");
  if (translateRuntime.tasks.size === 0) return "flushed";
  if (timeoutMs === 0) return "timedOut";

  const drained: boolean = await settleWithinBudget(translateRuntime.tasks, timeoutMs);
  return drained ? "flushed" : "timedOut";
}

/**
 * 释放 gRPC 客户端与 project parent；重新 init 后会构造全新客户端。
 * @param timeoutMs 关闭客户端的最大等待毫秒数，默认 TRANSLATE_REQUEST_TIMEOUT_MS。
 * @returns 关闭成功或无客户端时返回 flushed，关闭异常或超时时返回 failed。
 */
export async function closeTranslate(timeoutMs: number = TRANSLATE_REQUEST_TIMEOUT_MS): Promise<FlushResult> {
  assertTimeoutMs(timeoutMs, "translate close timeout");
  translateRuntime.accepting = false;
  translateRuntime.generation += 1;
  const client: GoogleTranslate.TranslationServiceClient | null = translateRuntime.client;
  translateRuntime.client = null;
  translateParentCache.parent = null;
  if (client === null) return "flushed";
  try {
    await withTimeout(
      Promise.resolve(client.close()),
      timeoutMs,
      "Google Translation client close"
    );
    return "flushed";
  } catch (error: unknown) {
    logger.error("Error closing Google Translation client:", error);
    return "failed";
  }
}
