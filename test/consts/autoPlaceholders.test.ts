/** consts/auto.ts 里带参数的类型标签：参数原样嵌进标签，缺省分支退回不带参数的标签。 */

import { describe, expect, test } from "bun:test";
import {
  contactPlaceholder,
  dicePlaceholder,
  documentPlaceholder,
  pollPlaceholder,
  stickerPlaceholder,
  venuePlaceholder,
  voiceDurationPlaceholder,
} from "../../packages/consts/auto";

/** 一个合法的类型标签：方括号包裹、首尾无空白、不含未填参数留下的 `undefined`。 */
function expectWellFormedLabel(label: string): void {
  expect(label.startsWith("[")).toBe(true);
  expect(label.endsWith("]")).toBe(true);
  expect(label).toBe(label.trim());
  expect(label).not.toContain("undefined");
}

describe("可选参数的类型标签", () => {
  /** 一组对照：带参数的标签、缺省该参数的标签，以及应当嵌进前者的参数文本。 */
  interface OptionalCase {
    readonly withArgument: string;
    readonly without: string;
    readonly argument: string;
  }

  test.each([
    ["贴纸", { withArgument: stickerPlaceholder("😺"), without: stickerPlaceholder(undefined), argument: "😺" }],
    ["贴纸（空 emoji）", { withArgument: stickerPlaceholder("😺"), without: stickerPlaceholder(""), argument: "😺" }],
    ["文件", { withArgument: documentPlaceholder("a.pdf"), without: documentPlaceholder(undefined), argument: "a.pdf" }],
    ["联系人", { withArgument: contactPlaceholder("Ann", "Lee"), without: contactPlaceholder("Ann", undefined), argument: "Ann Lee" }],
  ] as const)("%s：带参数时嵌进参数，缺省时是另一条不含参数的标签", (_label: string, { withArgument, without, argument }: OptionalCase) => {
    expectWellFormedLabel(withArgument);
    expectWellFormedLabel(without);
    expect(withArgument).toContain(argument);
    expect(without).not.toContain(argument);
  });

  test("联系人只有名字时只带名字", () => {
    const label: string = contactPlaceholder("Ann", undefined);
    expect(label).toContain("Ann");
    expect(label).not.toContain("Ann ");
  });
});

describe("必填参数的类型标签", () => {
  test.each([
    ["投票", pollPlaceholder("吃什么"), ["吃什么"]],
    ["骰子", dicePlaceholder("🎲", 6), ["🎲", "6"]],
    ["地点", venuePlaceholder("车站"), ["车站"]],
    ["语音时长", voiceDurationPlaceholder(12), ["12"]],
  ] as const)("%s：参数原样嵌进标签", (_label: string, rendered: string, parts: readonly string[]) => {
    expectWellFormedLabel(rendered);
    for (const part of parts) expect(rendered).toContain(part);
  });

  test("不同参数得到不同标签", () => {
    expect(pollPlaceholder("甲")).not.toBe(pollPlaceholder("乙"));
    expect(dicePlaceholder("🎲", 1)).not.toBe(dicePlaceholder("🎲", 6));
  });
});
