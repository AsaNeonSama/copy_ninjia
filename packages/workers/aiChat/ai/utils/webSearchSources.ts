/**
 * 联网检索来源列表的去重与截断纯函数，供 `web_search` 工具与 `send_web_digest` 组稿共用。
 */

import type { AiWebSearchSource } from "../../../../types/aiChat/provider";

/**
 * 按来源 URL 保留首次出现的条目，并截断至最多 `max` 条。
 * @param sources 检索返回的原始来源列表。
 * @param max 最多保留的去重来源条数。
 * @returns 去重并截断后的来源只读数组。
 */
export function dedupeWebSearchSources(
  sources: readonly AiWebSearchSource[],
  max: number
): readonly AiWebSearchSource[] {
  const result: AiWebSearchSource[] = [];
  const seen: Set<string> = new Set<string>();
  for (const source of sources) {
    if (result.length >= max) break;
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    result.push(source);
  }
  return result;
}
