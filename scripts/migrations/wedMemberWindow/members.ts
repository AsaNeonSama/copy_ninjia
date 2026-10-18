/** migrate:wed-member-window 的源格式解码与滑窗换算；只处理单份 `memory/wed/<chatId>.json` 的内容。 */
import { WED_MEMBER_LIMIT } from "../../../packages/consts/wed";
import { invalidInput } from "../../../packages/libs/inputValidation";

/** 源格式每份文件的成员 ID 数上限。 */
export const WED_MEMBER_WINDOW_SOURCE_LIMIT: number = 150_000;

/** 源格式的一份文件：按进入顺序排列、互不重复的正安全整数成员 ID 数组。 */
export function parseWedMemberSourceFile(parsed: unknown, path: string): readonly number[] {
  if (!Array.isArray(parsed) || parsed.length > WED_MEMBER_WINDOW_SOURCE_LIMIT) {
    return invalidInput(path, "$", `the 17.2.1 array of at most ${WED_MEMBER_WINDOW_SOURCE_LIMIT} unique positive safe integer user IDs`);
  }
  const ids: Set<number> = new Set();
  for (let index: number = 0; index < parsed.length; index++) {
    const id: unknown = parsed[index];
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || ids.has(id)) {
      return invalidInput(path, `$[${index}]`, "a unique positive safe integer user ID from the 17.2.1 format");
    }
    ids.add(id);
  }
  return parsed as readonly number[];
}

/**
 * 只保留末尾 WED_MEMBER_LIMIT 个 ID（最近进入的成员），顺序不变，全部记为同一进入时间；
 * 返回交替排列的 `[id0, enteredAt, id1, enteredAt, ...]`。
 */
export function windowWedMemberEntries(ids: readonly number[], enteredAt: number): number[] {
  const entries: number[] = [];
  for (let index: number = Math.max(0, ids.length - WED_MEMBER_LIMIT); index < ids.length; index++) {
    entries.push(ids[index]!, enteredAt);
  }
  return entries;
}
