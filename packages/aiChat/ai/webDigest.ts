/**
 * 联网摘要生成：先执行联网检索收集结论与来源链接，再经结构化文本模型按模式生成、校验并渲染摘要（不合格时带诊断重试）。
 */

import { textWebSearchAiProvider, structuredTextAiProvider, webSearchAiProvider } from "../provider";
import {
  WEB_DIGEST_COMPOSE_ATTEMPTS,
  WEB_DIGEST_COMPOSE_ERROR_LABEL,
  WEB_DIGEST_JSON_SCHEMA,
  WEB_DIGEST_MAX_SOURCES,
  WEB_DIGEST_NO_SEARCH_LOG_MAX_CHARS,
  WEB_DIGEST_UNSEARCHED_WARNING,
} from "../../consts/webDigest";
import {
  WEB_DIGEST_COMPOSE_INSTRUCTION,
  WEB_DIGEST_LANGUAGE_NAMES,
  WEB_DIGEST_RESEARCH_INSTRUCTION,
} from "../../consts/aiChat/prompts/webDigest";
import { TELEGRAM_MESSAGE_MAX_CHARS } from "../../consts/telegram";
import { logger } from "../../infra/logger";
import { decodeWebDigest } from "../../libs/webDigest";
import { renderWebDigestMarkdown } from "../../libs/webDigestMarkdown";
import { researchSourceUrls } from "../../libs/webDigestUrls";
import { escapeMarkdownV2 } from "../../libs/telegramMarkdown";
import { truncateWithEllipsis } from "../../libs/text";
import { currentTimeSentence } from "./timeSentence";
import { WEB_SEARCH_TIME_LABEL } from "../../consts/aiChat/prompts/researchTime";
import type {
  AiTextResult,
  AiWebSearchFacade,
  AiWebSearchResult,
  AiWebSearchSource,
} from "../../types/aiChat/provider";
import type {
  RenderedWebDigest,
  WebDigest,
  WebDigestCompositionResult,
  WebDigestDecodeResult,
  WebDigestFailure,
  WebDigestItem,
  WebDigestRequest,
} from "../../types/webDigest";

/** 检索系统提示词只含固定查证规则与条目上限；任务规则放在检索问题里。 */
function researchInstruction(request: WebDigestRequest): string {
  return `${WEB_DIGEST_RESEARCH_INSTRUCTION}最多整理 ${request.maxItems} 件事。`;
}

/** 来源按地址去重，最多 WEB_DIGEST_MAX_SOURCES 条。 */
function distinctSources(sources: readonly AiWebSearchSource[]): readonly AiWebSearchSource[] {
  const result: AiWebSearchSource[] = [];
  const seen: Set<string> = new Set<string>();
  for (const source of sources) {
    if (result.length === WEB_DIGEST_MAX_SOURCES) break;
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    result.push(source);
  }
  return result;
}

/** composeContent 的入参。 */
interface ComposeContentParams {
  readonly request: WebDigestRequest;
  /** 与检索段一致的配置时区基准时间。 */
  readonly referenceTime: string;
  /** 检索段交回的结论正文。 */
  readonly research: string;
  /** 去重后的供应商来源列表；正文中的完整链接也可用于条目地址。 */
  readonly sources: readonly AiWebSearchSource[];
  /** 上一次产出不合格的诊断；首次组稿为 null。 */
  readonly problem: string | null;
}

/** 组稿段的用户内容：任务参数、检索结果、来源列表，以及上一次不合格时的诊断。 */
function composeContent({ request, referenceTime, research, sources, problem }: ComposeContentParams): string {
  const lines: string[] = [
    `主题：${request.topic}`,
    referenceTime,
    `语言：${WEB_DIGEST_LANGUAGE_NAMES[request.language]}`,
    `条目上限：${request.maxItems}`,
  ];
  if (request.instructions !== undefined) lines.push(`任务规则：${request.instructions}`);
  lines.push("", "【检索结果】", research, "", "【来源列表】");
  for (let index: number = 0; index < sources.length; index++) {
    lines.push(`${index + 1}. ${sources[index]!.title} ${sources[index]!.url}`);
  }
  if (problem !== null) lines.push("", "【上一次的问题】", problem, "请修正后重新输出完整的 JSON。");
  return lines.join("\n");
}

/** 第一个未在来源元数据或检索正文中出现的条目地址字段路径；全部命中时为 null。 */
function unlistedUrlPath(digest: Readonly<WebDigest>, urls: ReadonlySet<string>): string | null {
  for (let sectionIndex: number = 0; sectionIndex < digest.sections.length; sectionIndex++) {
    const items: readonly Readonly<WebDigestItem>[] = digest.sections[sectionIndex]!.items;
    for (let itemIndex: number = 0; itemIndex < items.length; itemIndex++) {
      if (!urls.has(items[itemIndex]!.url)) return `$.sections[${sectionIndex}].items[${itemIndex}].url`;
    }
  }
  return null;
}

/** 一次组稿尝试的结果：成功的 MarkdownV2 原文，或交给下一次尝试的诊断。 */
type ComposeAttempt =
  | { readonly kind: "done"; readonly text: string }
  | { readonly kind: "retry"; readonly reason: WebDigestFailure; readonly problem: string };

/** 解析、解码、核对来源并渲染一次组稿产出。 */
function checkComposition(
  text: string,
  request: WebDigestRequest,
  urls: ReadonlySet<string>
): ComposeAttempt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "retry", reason: "invalid digest", problem: "the output was not a valid JSON object" };
  }
  const decoded: WebDigestDecodeResult = decodeWebDigest(parsed, request.maxItems);
  if (!decoded.ok) return { kind: "retry", reason: "invalid digest", problem: decoded.problem };
  const unlisted: string | null = unlistedUrlPath(decoded.digest, urls);
  if (unlisted !== null) {
    return { kind: "retry", reason: "invalid digest", problem: `${unlisted} must be copied verbatim from a research link or the source list` };
  }
  const rendered: RenderedWebDigest = renderWebDigestMarkdown(decoded.digest, request.language);
  if (rendered.visibleLength > TELEGRAM_MESSAGE_MAX_CHARS) {
    return {
      kind: "retry",
      reason: "too long",
      problem: `the rendered message has ${rendered.visibleLength} characters, over the ${TELEGRAM_MESSAGE_MAX_CHARS} limit; shorten the bodies or drop items`,
    };
  }
  return { kind: "done", text: rendered.text };
}

/** 记一行失败日志并交回失败结果；已取消时不记。 */
function failed(reason: WebDigestFailure, detail: string, signal: AbortSignal): WebDigestCompositionResult {
  if (signal.aborted) return { ok: false, reason: "aborted" };
  logger.error(`Web digest composition failed (${reason}): ${detail}.`);
  return { ok: false, reason };
}

/** 未执行搜索的正文诊断；最多记录固定长度，保留原文长度与来源数量。 */
function noSearchDetail(research: Extract<AiWebSearchResult, { readonly ok: true }>): string {
  const responsePreview: string = research.text.slice(0, WEB_DIGEST_NO_SEARCH_LOG_MAX_CHARS);
  return `response=${JSON.stringify(responsePreview)}; responseLength=${research.text.length}; ` +
    `truncated=${research.text.length > WEB_DIGEST_NO_SEARCH_LOG_MAX_CHARS}; sourceCount=${research.sources.length}`;
}

/** 生成一份摘要：有搜索时组稿，无搜索时给模型正文加警示；不抛出。 */
export async function composeWebDigest(
  request: WebDigestRequest,
  signal: AbortSignal
): Promise<WebDigestCompositionResult> {
  const referenceTime: string = currentTimeSentence(WEB_SEARCH_TIME_LABEL);
  const searcher: AiWebSearchFacade = webSearchAiProvider() ?? textWebSearchAiProvider();
  const instruction: string = researchInstruction(request);
  const query: string = request.instructions === undefined
    ? `主题：${request.topic}\n${referenceTime}`
    : `主题：${request.topic}\n任务规则：${request.instructions}\n${referenceTime}`;
  const research: AiWebSearchResult = await searcher.searchWeb({
    instruction,
    query,
    signal,
  });
  if (signal.aborted) return { ok: false, reason: "aborted" };
  if (!research.ok) {
    return research.refused === true
      ? failed("refused", "the search model refused the request", signal)
      : failed("search failed", "the search request failed", signal);
  }
  if (research.searchCalls === 0) {
    const response: string = research.text.trim();
    if (response.length === 0) return failed("search failed", "the endpoint returned no text", signal);
    const bodyLimit: number = TELEGRAM_MESSAGE_MAX_CHARS - WEB_DIGEST_UNSEARCHED_WARNING.length - 2;
    const body: string = truncateWithEllipsis(response, bodyLimit);
    logger.warn(`Web digest research answered without searching; sending with warning: ${noSearchDetail(research)}; ` +
      `messageTruncated=${response.length > bodyLimit}.`);
    return { ok: true, text: escapeMarkdownV2(`${WEB_DIGEST_UNSEARCHED_WARNING}\n\n${body}`) };
  }
  const sources: readonly AiWebSearchSource[] = distinctSources(research.sources);
  const urls: ReadonlySet<string> = researchSourceUrls(research);
  if (urls.size === 0) return failed("no sources", "the search response contained no source URLs in metadata or text", signal);

  let lastReason: WebDigestFailure = "invalid digest";
  let problem: string | null = null;
  for (let attempt: number = 0; attempt < WEB_DIGEST_COMPOSE_ATTEMPTS; attempt++) {
    const result: AiTextResult = await structuredTextAiProvider().generateJson({
      systemPrompt: WEB_DIGEST_COMPOSE_INSTRUCTION,
      userContent: composeContent({ request, referenceTime, research: research.text, sources, problem }),
      jsonSchema: WEB_DIGEST_JSON_SCHEMA,
      signal,
      errorLabel: WEB_DIGEST_COMPOSE_ERROR_LABEL,
    });
    if (signal.aborted) return { ok: false, reason: "aborted" };
    if (!result.ok) {
      if (result.refused === true) return failed("refused", "the composition model refused the request", signal);
      if (!result.retryable) return failed("compose failed", "the composition request failed", signal);
      lastReason = "compose failed";
      problem = "the previous request returned no usable output";
      continue;
    }
    const outcome: ComposeAttempt = checkComposition(result.text, request, urls);
    if (outcome.kind === "done") return { ok: true, text: outcome.text };
    lastReason = outcome.reason;
    problem = outcome.problem;
  }
  return failed(lastReason, problem ?? "the composition was rejected", signal);
}
