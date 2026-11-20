import { describe, expect, test } from "bun:test";
import { dedupeWebSearchSources } from "../../../../packages/workers/aiChat/ai/utils/webSearchSources";
import type { AiWebSearchSource } from "../../../../packages/types/aiChat/provider";

describe("dedupeWebSearchSources", () => {
  test("按 URL 保留首次出现的条目并按 max 截断", () => {
    const sources: readonly AiWebSearchSource[] = [
      { title: "第一篇", url: "https://a.example/1" },
      { title: "重复链接", url: "https://a.example/1" },
      { title: "第二篇", url: "https://b.example/2" },
      { title: "第三篇", url: "https://c.example/3" },
    ];

    expect(dedupeWebSearchSources(sources, 2)).toEqual([
      { title: "第一篇", url: "https://a.example/1" },
      { title: "第二篇", url: "https://b.example/2" },
    ]);
    expect(dedupeWebSearchSources(sources, 10)).toEqual([
      { title: "第一篇", url: "https://a.example/1" },
      { title: "第二篇", url: "https://b.example/2" },
      { title: "第三篇", url: "https://c.example/3" },
    ]);
    expect(dedupeWebSearchSources(sources, 0)).toEqual([]);
  });
});
